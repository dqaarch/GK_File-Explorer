//! EWA file HTTP server registration for the JS-based decoder.
//! The actual EWA binary parsing, VP9 decoding, and dequantization
//! now lives entirely in `src/components/EwaViewer/EwaCacheManager.ts`.
//! This module only provides the HTTP URL endpoint for the browser to fetch the EWA file.

use tauri::Emitter;
use tauri::Manager;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Register EWA file with HTTP server and return URL.
/// The JS EwaCacheManager fetches this URL to load the EWA binary directly.
#[tauri::command]
pub fn register_ewa_file(path: String, port: Option<u16>) -> Result<String, String> {
    let http_port = port.unwrap_or(18765);

    // Validate file exists
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }

    // Return URL that the browser can fetch
    let encoded_path = urlencoding_encode_simple(&path);
    let url = format!("http://localhost:{}/ewa?path={}", http_port, encoded_path);

    Ok(url)
}

/// Simple URL encoding for file paths (Windows-compatible).
fn urlencoding_encode_simple(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char);
            }
            b':' | b'\\' | b'/' => {
                // Windows drive letters and path separators pass through
                result.push(byte as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    result
}

/// Resolve a Python interpreter on Windows, falling back through common names.
/// Returns the absolute path to the executable that should be spawned.
fn resolve_python_exe() -> Result<String, String> {
    let candidates: [&str; 3] = ["python", "python3", "py"];
    for name in candidates {
        let which = std::process::Command::new("where").arg(name).output();
        if let Ok(out) = which {
            if out.status.success() {
                if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() && std::path::Path::new(trimmed).exists() {
                        return Ok(trimmed.to_string());
                    }
                }
            }
        }
    }
    Err("Python not found. Install Python and ensure it's on PATH (or use 'py').".to_string())
}

/// Spawn Python to run `ewa_export_sequence.py` on `<input.ewa>` and stream
/// stdout/stderr through the `ewa-export-progress` event. Returns the resolved
/// path of the script being executed for the frontend to surface to the user.
#[tauri::command]
pub async fn export_ewa_to_ply(
    app: tauri::AppHandle,
    ewa_path: String,
    output_dir: String,
    base_name: String,
) -> Result<String, String> {
    let pypath = resolve_python_exe()?;

    // Resolve the Python script path. Dev: prefer the source file under
    // `scripts/` next to Cargo.toml so edits are picked up without rebuilding
    // the resource bundle. Packaged: fall back to `Tools/` extracted into the
    // app's resource directory.
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("ewa_export_sequence.py");
    let script_path = if dev.exists() {
        dev
    } else {
        match app.path().resource_dir() {
            Ok(resource_dir) => {
                let packed = resource_dir.join("Tools").join("ewa_export_sequence.py");
                if packed.exists() {
                    packed
                } else {
                    dev
                }
            }
            Err(_) => dev,
        }
    };

    if !script_path.exists() {
        return Err(format!(
            "Script not found: {}. Run `tauri build` or copy scripts/ewa_export_sequence.py next to the binary.",
            script_path.display()
        ));
    }
    let script_str = script_path.to_string_lossy().to_string();
    let _ = app.emit("ewa-export-progress", format!("[script] {}", script_str));

    if !std::path::Path::new(&ewa_path).exists() {
        return Err(format!("EWA file not found: {}", ewa_path));
    }
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Failed to create output dir: {}", e))?;

    let mut cmd = Command::new(&pypath);
    cmd.arg(&script_str)
        .arg(&ewa_path)
        .arg(&output_dir)
        .arg(&base_name)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn python: {}", e))?;

    let stdout = child.stdout.take().ok_or_else(|| "No stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "No stderr".to_string())?;
    let app_out = app.clone();
    let app_err = app.clone();

    let stdout_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let _ = app_out.emit("ewa-export-progress", line);
        }
    });
    let stderr_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            let _ = app_err.emit("ewa-export-progress", format!("[stderr] {}", line));
        }
    });

    // Wait on the calling task (we're inside an async command).
    let app_wait = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let status = child.wait();
        let _ = stdout_thread.join();
        let _ = stderr_thread.join();
        status
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?;

    match result {
        Ok(s) if s.success() => {
            let _ = app_wait.emit(
                "ewa-export-progress",
                format!(
                    "[done] Exported {} frames to {}",
                    base_name, output_dir
                ),
            );
            Ok(script_str)
        }
        Ok(s) => Err(format!(
            "Python exited with code {:?}",
            s.code()
        )),
        Err(e) => Err(format!("Wait failed: {}", e)),
    }
}
