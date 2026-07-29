//! SketchUp (.skp) preview backend.
//!
//! Parses a SketchUp 2021+ file into GLB binary data via the `openskp`
//! Python package. The Python interpreter runs as a long-lived sidecar
//! process and we communicate over newline-delimited JSON (NDJSON) on
//! stdin/stdout, so subsequent SKP previews skip the Python startup cost.
//!
//! Files saved before SketchUp 2021 use the MFC `CArchive` container which
//! `openskp` cannot read; we return a typed error so the frontend can show
//! a friendly fallback message.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Parsed GLB payload returned to the frontend.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkpPreview {
    /// MIME type -- always `model/gltf-binary`.
    pub mime: String,
    /// Raw GLB bytes ready to feed a `GLTFLoader`.
    pub glb: Vec<u8>,
    /// SketchUp version string from the file header, e.g. `{23.1.341}`.
    pub version: String,
    /// Number of layers / tags parsed by openskp.
    pub layers: usize,
    /// Number of component definitions parsed by openskp.
    pub definitions: usize,
}

/// Lightweight JSON envelope returned by the Python sidecar.
#[derive(Debug, Deserialize)]
struct SidecarResponse {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    mime: Option<String>,
    #[serde(default)]
    bytes: Option<u64>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    layers: Option<usize>,
    #[serde(default)]
    definitions: Option<usize>,
    #[serde(default)]
    glb: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    minimum_version: Option<u32>,
}

/// Persistent Python sidecar (one per app session).
struct Sidecar {
    stdin: std::process::ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

/// Locks access to the long-lived Python sidecar so two concurrent
/// preview requests do not interleave on the same pipe.
static SIDECAR: Mutex<Option<Sidecar>> = Mutex::new(None);

/// Locate the Python interpreter on PATH. Mirrors the heuristic used by
/// `ewa_decoder.rs` so both modules agree on which interpreter to spawn.
fn resolve_python_exe() -> Result<String, String> {
    const CANDIDATES: [&str; 3] = ["python", "python3", "py"];
    for name in CANDIDATES {
        if let Ok(out) = Command::new("where").arg(name).output() {
            if out.status.success() {
                if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() && Path::new(trimmed).exists() {
                        return Ok(trimmed.to_string());
                    }
                }
            }
        }
    }
    Err("Python not found. Install Python 3.9+ and ensure it is on PATH.".to_string())
}

/// Resolve the path of `skp_parser.py`. In dev we read the file from the
/// repository so edits take effect without rebuilding; in a packaged build
/// the script is bundled under `Tools/` inside the app's resource directory.
fn resolve_parser_script(app: &AppHandle) -> Result<PathBuf, String> {
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("python")
        .join("skp_parser.py");

    if dev.exists() {
        return Ok(dev);
    }

    match app.path().resource_dir() {
        Ok(resource_dir) => {
            let packed = resource_dir.join("Tools").join("skp_parser.py");
            if packed.exists() {
                return Ok(packed);
            }
            Err(format!(
                "skp_parser.py not found. Expected at {} or {}",
                dev.display(),
                packed.display()
            ))
        }
        Err(_) => Err(format!(
            "skp_parser.py not found at {}",
            dev.display()
        )),
    }
}

/// Make sure the Python sidecar is alive. If this is the first call we
/// spawn the process; otherwise we just verify the pipes are still usable.
fn ensure_sidecar(app: &AppHandle) -> Result<(), String> {
    let mut guard = SIDECAR.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }

    let pypath = resolve_python_exe()?;
    let script = resolve_parser_script(app)?;

    let mut cmd = Command::new(&pypath);
    cmd.arg("-X")
        .arg("utf8")
        .arg(script.as_os_str())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn skp-parser ({pypath}): {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "skp-parser stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "skp-parser stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "skp-parser stderr unavailable".to_string())?;

    // Drain stderr on a background thread so the pipe never fills up and
    // any error messages still surface in the host process log.
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            eprintln!("[skp-parser] {line}");
        }
    });

    *guard = Some(Sidecar {
        stdin,
        stdout: BufReader::new(stdout),
    });

    // Retain the Child handle implicitly via the piped stdio -- when the
    // parent process exits, the OS will reap the Python interpreter.
    let _ = child;

    Ok(())
}

/// Send one NDJSON request and read one NDJSON response.
fn round_trip(sidecar: &mut Sidecar, path: &str) -> Result<SidecarResponse, String> {
    let request = serde_json::json!({ "cmd": "parse", "path": path }).to_string();
    sidecar
        .stdin
        .write_all(request.as_bytes())
        .map_err(|e| format!("Failed to write to skp-parser: {e}"))?;
    sidecar
        .stdin
        .write_all(b"\n")
        .map_err(|e| format!("Failed to flush skp-parser: {e}"))?;
    let _ = sidecar.stdin.flush();

    let mut line = String::new();
    let read = sidecar
        .stdout
        .read_line(&mut line)
        .map_err(|e| format!("Failed to read skp-parser response: {e}"))?;
    if read == 0 {
        return Err("skp-parser closed stdout unexpectedly".to_string());
    }

    serde_json::from_str(line.trim())
        .map_err(|e| format!("Invalid skp-parser response: {e} | raw={line}"))
}

/// Synchronous SKP parsing -- runs the long-lived Python sidecar and
/// returns either a decoded GLB payload or a typed error.
fn parse_skp_sync(app: &AppHandle, path: String) -> Result<SkpPreview, String> {
    let input = Path::new(&path);
    if path.as_bytes().contains(&0) {
        return Err("The SKP path contains an invalid null character".to_string());
    }
    if !input.exists() {
        return Err(format!("SKP file not found: {path}"));
    }
    if !input.is_file() {
        return Err(format!("The selected path is not a file: {path}"));
    }

    ensure_sidecar(app)?;

    let mut guard = SIDECAR.lock().unwrap();
    let sidecar = guard
        .as_mut()
        .ok_or_else(|| "skp-parser failed to start".to_string())?;

    let response = round_trip(sidecar, &path)?;

    if !response.ok {
        let error = response.error.unwrap_or_else(|| "unknown".to_string());
        let detail = response.detail.unwrap_or_default();
        return match error.as_str() {
            "skp_too_old" => Err(format!(
                "skp_too_old:{}:{}",
                response.version.unwrap_or_default(),
                response.minimum_version.unwrap_or(21)
            )),
            "file_not_found" => Err("skp_file_not_found".to_string()),
            "parse_failed" => Err(format!("skp_parse_failed:{detail}")),
            "missing_path" | "bad_request" | "unknown_command" => {
                Err(format!("skp_protocol_error:{error}"))
            }
            _ => Err(format!("skp_error:{error}:{detail}")),
        };
    }

    let b64 = response
        .glb
        .ok_or_else(|| "skp-parser returned ok without a GLB payload".to_string())?;
    let glb = BASE64
        .decode(b64.as_bytes())
        .map_err(|e| format!("Failed to decode GLB payload: {e}"))?;

    Ok(SkpPreview {
        mime: response.mime.unwrap_or_else(|| "model/gltf-binary".to_string()),
        glb,
        version: response.version.unwrap_or_default(),
        layers: response.layers.unwrap_or(0),
        definitions: response.definitions.unwrap_or(0),
    })
}

/// Public Tauri command. Runs the synchronous parser on a blocking task so
/// the async runtime stays responsive while Python crunches a large model.
#[tauri::command]
pub async fn parse_skp_file(
    app: AppHandle,
    path: String,
) -> Result<SkpPreview, String> {
    tokio::task::spawn_blocking(move || parse_skp_sync(&app, path))
        .await
        .map_err(|error| format!("SKP parser worker failed: {error}"))?
}