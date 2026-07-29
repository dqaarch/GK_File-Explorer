// GK File Explorer - Tauri 2 Application with HTTP Server
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fast_psd;
mod epub;
mod stl;
mod fast_image;
mod transfer;
mod native_drag;
mod shell_extensions;
mod recycle_bin;
pub mod openexr_ffi;
pub mod openexr_core;
pub mod exr_ocio_lut;
pub mod exr_decode_cache;
pub mod exr_decode_cache_lru;
pub mod exr_passthrough;
pub mod exr_batch;

pub mod ewa_decoder;
pub mod skp_preview;

use chrono::{DateTime, Utc};
use lru::LruCache;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use sysinfo::Disks;
use std::fs;
use std::io::{Read, Write};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::os::windows::process::CommandExt;
use std::ffi::OsStr;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use once_cell::sync::Lazy;
use tauri::{command, Emitter, Listener, Manager};
use tauri_plugin_opener::OpenerExt;

/// Creates a Command that hides the console window on Windows.
/// This prevents black cmd.exe windows from popping up in release builds.
#[cfg(windows)]
fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW = 0x08000000
    cmd
}

#[cfg(not(windows))]
fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    Command::new(program)
}
use walkdir::WalkDir;
use tiny_http::{Server, Response, ResponseBox, Header, Request};
use base64::{Engine as _, engine::general_purpose::STANDARD};
#[cfg(windows)]
use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::{WPARAM, LPARAM},
        System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, IDataObject, COINIT_APARTMENTTHREADED},
        UI::Shell::{
            AssocQueryStringW, IAssocHandler, ASSOCF_NONE, ASSOCSTR_EXECUTABLE, ASSOCSTR_FRIENDLYAPPNAME,
            SHAssocEnumHandlers, ASSOC_FILTER_NONE, ASSOC_FILTER_RECOMMENDED,
            SHCreateItemFromParsingName, IShellItem, BHID_DataObject,
        },
    },
};
#[cfg(windows)]
use windows::Win32::UI::Shell::SHDefExtractIconW;
#[cfg(windows)]
use windows::Win32::UI::Shell::SHLoadIndirectString;

const HTTP_PORT: u16 = 18765;

// Global LRU thumbnail cache: key = (path, size), value = PNG bytes
// Max 2000 entries ≈ 200MB for 256px thumbnails, auto-evicts least-recently-used.
static THUMB_CACHE: std::sync::OnceLock<Mutex<LruCache<String, std::borrow::Cow<'static, [u8]>>>> =
    std::sync::OnceLock::new();

fn get_thumb_cache() -> &'static Mutex<LruCache<String, std::borrow::Cow<'static, [u8]>>> {
    THUMB_CACHE.get_or_init(|| Mutex::new(LruCache::new(std::num::NonZeroUsize::new(2000).unwrap())))
}

// ── Disk cache for PSD/AI/EPS thumbnails ───────────────────────────────────
// Stores extracted thumbnails on disk so they survive app restarts.
// Key format: hash(path):size.png
// We use the file path hash as the filename to avoid issues with special chars.

static DISK_THUMB_DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

fn get_disk_thumb_dir() -> Option<&'static PathBuf> {
    DISK_THUMB_DIR.get_or_init(|| {
        std::env::var("LOCALAPPDATA").ok().map(|dir| {
            PathBuf::from(dir)
                .join("GokuFileExplorer")
                .join("thumb_cache")
        })
    }).as_ref()
}

fn disk_cache_key(path: &str, size: usize) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    size.hash(&mut hasher);
    format!("{:016x}_{}.png", hasher.finish(), size)
}

fn load_from_disk_cache(path: &str, size: usize) -> Option<Vec<u8>> {
    let dir = get_disk_thumb_dir()?;
    let key = disk_cache_key(path, size);
    let file_path = dir.join(&key);

    // Verify source file mtime matches our cache
    let source_mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok()?;
    let cache_mtime = std::fs::metadata(&file_path).and_then(|m| m.modified()).ok()?;

    // Cache is stale if source is newer
    if source_mtime > cache_mtime {
        let _ = std::fs::remove_file(&file_path);
        return None;
    }

    std::fs::read(&file_path).ok()
}

fn save_to_disk_cache(path: &str, size: usize, png_data: &[u8]) {
    let dir = match get_disk_thumb_dir() {
        Some(d) => d,
        None => return,
    };

    // Create directory if needed
    if let Err(e) = fs::create_dir_all(dir) {
        eprintln!("[DiskCache] failed to create dir: {}", e);
        return;
    }

    let key = disk_cache_key(path, size);
    let file_path = dir.join(&key);

    if let Err(e) = fs::write(&file_path, png_data) {
        eprintln!("[DiskCache] failed to write {}: {}", key, e);
    }
}

fn invalidate_disk_cache(path: &str) {
    if let Some(dir) = get_disk_thumb_dir() {
        let sizes = [64usize, 128, 256, 512, 1024];
        for size in sizes {
            let key = disk_cache_key(path, size);
            let _ = fs::remove_file(dir.join(&key));
        }
    }
}

// Thumbnail extraction concurrency: max 4 threads prevents memory explosion
// when loading large folders (each thread may hold a large file in memory).
const MAX_THUMB_THREADS: usize = 4;
static THUMB_THREAD_COUNT: std::sync::OnceLock<std::sync::Mutex<usize>> =
    std::sync::OnceLock::new();

fn get_thumb_thread_count() -> &'static std::sync::Mutex<usize> {
    THUMB_THREAD_COUNT.get_or_init(|| std::sync::Mutex::new(0))
}

struct ThumbExtractSlot;

impl ThumbExtractSlot {
    fn acquire() -> ThumbExtractSlot {
        loop {
            if let Ok(mut count) = get_thumb_thread_count().lock() {
                if *count < MAX_THUMB_THREADS {
                    *count += 1;
                    return ThumbExtractSlot;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}

impl Drop for ThumbExtractSlot {
    fn drop(&mut self) {
        if let Ok(mut count) = get_thumb_thread_count().lock() {
            *count = count.saturating_sub(1);
        }
    }
}

// ── Python subprocess concurrency limiting ──────────────────────────────────────
// Counter-based semaphore to cap concurrent Python processes used for AI/EPS thumbnails.
// Each Python process loads PyMuPDF (~100MB base) PLUS the AI file being processed.
// A single large AI file (100+ MB) can push total memory to 1-3 GiB.
// Max 1 prevents runaway native memory when multiple AI files need processing.
const MAX_PYTHON_PROCS: usize = 1;
static PYTHON_PROC_COUNT: std::sync::OnceLock<std::sync::Mutex<usize>> =
    std::sync::OnceLock::new();

fn get_python_proc_count() -> &'static std::sync::Mutex<usize> {
    PYTHON_PROC_COUNT.get_or_init(|| std::sync::Mutex::new(0))
}

// RAII guard for a Python slot. Acquires immediately or times out after `timeout` ms.
// If timeout expires, returns None and the caller should return null (don't block HTTP thread).
struct PythonSlot {
    _dummy: (),
}

impl PythonSlot {
    fn try_acquire(timeout_ms: u64) -> Option<PythonSlot> {
        let start = std::time::Instant::now();
        loop {
            let mut guard = get_python_proc_count().lock().ok()?;
            if *guard < MAX_PYTHON_PROCS {
                *guard += 1;
                let count = *guard;
                drop(guard);
                println!("[AI] Python slot acquired ({}/{})", count, MAX_PYTHON_PROCS);
                return Some(PythonSlot { _dummy: () });
            }
            drop(guard);

            if start.elapsed().as_millis() as u64 >= timeout_ms {
                println!("[AI] Python slot timeout after {}ms", timeout_ms);
                return None;
            }

            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}

impl Drop for PythonSlot {
    fn drop(&mut self) {
        if let Ok(mut g) = get_python_proc_count().lock() {
            *g = g.saturating_sub(1);
            println!("[AI] Python slot released ({}/{})", *g, MAX_PYTHON_PROCS);
        }
    }
}

// File/directory entry returned to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_file: bool,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>,
    pub created: Option<String>,
    pub extension: Option<String>,
    pub is_hidden: bool,
}

// Directory listing result
#[derive(Debug, Serialize, Deserialize)]
pub struct DirListing {
    pub entries: Vec<FileEntry>,
    pub path: String,
}

// Video info result
#[derive(Debug, Serialize)]
pub struct VideoInfo {
    pub success: bool,
    pub fps: Option<f64>,
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub error: Option<String>,
}

// ============================================================
// Reparse point detection (Windows)
// Windows uses directory reparse points (junctions) for legacy
// compatibility shims like "My Music", "My Pictures", "My Videos"
// that appear inside the user's Documents folder and point to
// %USERPROFILE%\Music, Pictures, Videos. The Windows shell hides
// these by default; we mirror that behavior so users don't see
// duplicate folder entries when browsing Documents.
// ============================================================
// Check if a path is a reparse point (junction/symbolic link) on Windows
// We use GetFileAttributesEx instead of fs::metadata because system junctions
// like "Documents and Settings" have ACLs that deny read access, causing
// fs::metadata to fail with Access Denied. GetFileAttributesEx doesn't open
// a file handle, so it works on these protected junctions.
#[cfg(windows)]
fn is_reparse_point(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{GetFileAttributesExW, GetFileExInfoStandard, FILE_ATTRIBUTE_REPARSE_POINT, WIN32_FILE_ATTRIBUTE_DATA};
    
    let wide: Vec<u16> = std::ffi::OsStr::new(path.to_str().unwrap_or(""))
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    
    unsafe {
        let mut data = WIN32_FILE_ATTRIBUTE_DATA::default();
        if GetFileAttributesExW(
            windows::core::PCWSTR::from_raw(wide.as_ptr()),
            GetFileExInfoStandard,
            &mut data as *mut _ as *mut std::ffi::c_void,
        ).is_ok() {
            return (data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0) != 0;
        }
        false
    }
}

// Check if a path is a protected system item that should always be hidden
// (like Windows Explorer - FILE_ATTRIBUTE_SYSTEM files and reparse points
// are hidden by default and cannot be shown even with "Show hidden files")
#[cfg(windows)]
fn is_protected_system_item(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{GetFileAttributesExW, GetFileExInfoStandard, FILE_ATTRIBUTE_SYSTEM, FILE_ATTRIBUTE_REPARSE_POINT, WIN32_FILE_ATTRIBUTE_DATA};
    
    let wide: Vec<u16> = std::ffi::OsStr::new(path.to_str().unwrap_or(""))
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    
    unsafe {
        let mut data = WIN32_FILE_ATTRIBUTE_DATA::default();
        if GetFileAttributesExW(
            windows::core::PCWSTR::from_raw(wide.as_ptr()),
            GetFileExInfoStandard,
            &mut data as *mut _ as *mut std::ffi::c_void,
        ).is_ok() {
            let attrs = data.dwFileAttributes;
            // FILE_ATTRIBUTE_SYSTEM = OS files, FILE_ATTRIBUTE_REPARSE_POINT = junctions/symlinks
            return (attrs & (FILE_ATTRIBUTE_SYSTEM.0 | FILE_ATTRIBUTE_REPARSE_POINT.0)) != 0;
        }
        false
    }
}

#[cfg(not(windows))]
fn is_reparse_point(_path: &Path) -> bool {
    false
}

#[cfg(not(windows))]
fn is_protected_system_item(_path: &Path) -> bool {
    // On Unix-like systems, no special handling needed
    false
}

// Check if a file/directory is hidden on Windows
// Only checks FILE_ATTRIBUTE_HIDDEN - FILE_ATTRIBUTE_SYSTEM items are handled
// separately by is_protected_system_item (always hidden like Windows Explorer)
#[cfg(windows)]
fn is_hidden_file(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{GetFileAttributesExW, GetFileExInfoStandard, FILE_ATTRIBUTE_HIDDEN, WIN32_FILE_ATTRIBUTE_DATA};
    
    let wide: Vec<u16> = std::ffi::OsStr::new(path.to_str().unwrap_or(""))
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    
    unsafe {
        let mut data = WIN32_FILE_ATTRIBUTE_DATA::default();
        if GetFileAttributesExW(
            windows::core::PCWSTR::from_raw(wide.as_ptr()),
            GetFileExInfoStandard,
            &mut data as *mut _ as *mut std::ffi::c_void,
        ).is_ok() {
            return (data.dwFileAttributes & FILE_ATTRIBUTE_HIDDEN.0) != 0;
        }
        false
    }
}

#[cfg(not(windows))]
fn is_hidden_file(path: &Path) -> bool {
    // On Unix-like systems, hidden files start with a dot
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.'))
        .unwrap_or(false)
}

// ============================================================
// Bundle lookup — finds bundled resources shipped under `bundle_dist/`.
// The bundled directory layout is flat:
//
//   bundle_dist/ffmpeg/ffmpeg.exe, ffprobe.exe, ffplay.exe, *.dll
//   bundle_dist/poppler/pdftoppm.exe, *.dll, share/...
//   bundle_dist/openexr/OpenEXR-3_4.dll, Imath-3_2.dll, Iex-3_4.dll,
//                       OpenEXRCore-3_4.dll, ...
//   bundle_dist/python/python.exe, python311.dll, *.pyd,
//                      Tools/*.py, Lib/site-packages/...
//
// At runtime, for any search root R we try `R/<subdir>/<file>`.
// Search roots (first match wins):
//   1. R = parent of the running executable (NSIS install dir)
//   2. R = parent of (1)            — handles NSIS `_internal/` flattening
//   3. R = walk-up until `bundle_dist/` exists (dev: src-tauri/target/...)
fn bundled_resource(subdir: &str, file: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?.to_path_buf();

    let mut roots: Vec<PathBuf> = Vec::new();
    roots.push(exe_dir.clone());
    if let Some(parent) = exe_dir.parent() {
        roots.push(parent.to_path_buf());
    }
    // Walk up looking for `bundle_dist/`.
    let mut walker = exe_dir.clone();
    for _ in 0..10 {
        let candidate = walker.join("bundle_dist").join(subdir).join(file);
        if candidate.exists() {
            return Some(candidate);
        }
        if !walker.pop() {
            break;
        }
    }
    // Direct children of every search root.
    for r in &roots {
        let candidate = r.join(subdir).join(file);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn get_ffmpeg_path() -> String {
    let paths = ["ffmpeg.exe", "ffmpeg", "ffmpeg/bin/ffmpeg.exe", "ffmpeg/bin/ffmpeg"];
    for name in paths {
        if let Some(p) = bundled_resource("ffmpeg", name) {
            println!("[FFmpeg] Found at: {}", p.display());
            return p.to_string_lossy().to_string();
        }
    }
    println!("[FFmpeg] Not found in bundle — falling back to system PATH");
    "ffmpeg".to_string()
}

fn get_ffprobe_path() -> String {
    let paths = ["ffprobe.exe", "ffprobe", "ffmpeg/ffprobe.exe", "ffmpeg/bin/ffprobe.exe"];
    for name in paths {
        if let Some(p) = bundled_resource("ffmpeg", name) {
            println!("[FFprobe] Found at: {}", p.display());
            return p.to_string_lossy().to_string();
        }
    }
    println!("[FFprobe] Not found in bundle — falling back to system PATH");
    "ffprobe".to_string()
}

fn get_pdftoppm_path() -> String {
    let paths = ["pdftoppm.exe", "pdftoppm", "poppler/pdftoppm.exe"];
    for name in paths {
        if let Some(p) = bundled_resource("poppler", name) {
            println!("[Poppler] Found pdftoppm at: {}", p.display());
            return p.to_string_lossy().to_string();
        }
    }
    println!("[Poppler] Not found in bundle — falling back to system PATH");
    "pdftoppm".to_string()
}

fn get_gs_path() -> String {
    // Ghostscript ships only as a system dependency. We never bundle it
    // (it's a large, licensed Windows binary). Check standard install
    // locations and finally fall back to PATH.
    let candidates = [
        "C:/Program Files/gs/gswin64c.exe",
        "C:/Program Files (x86)/gs/gswin64c.exe",
        "gswin64c.exe",
        "gs",
    ];
    for c in &candidates {
        let p = Path::new(c);
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    "gs".to_string()
}

// ============================================================
// HTTP Server - Runs on localhost:18765
// Uses thread-per-request so blocking ops (ffprobe, ffmpeg) don't block other requests
// ============================================================

// Headers needed for `crossOriginIsolated === true`, which Emscripten
// needs to spawn pthreads via SharedArrayBuffer (and therefore to load the
// USD WASM delegate at all). WebView2 will refuse the postMessage without
// `Cross-Origin-Embedder-Policy: require-corp` on the WASM-bearing response.
//
// Applied to every response of the Rust HTTP server; the index.html itself
// sets the same policy via <meta http-equiv> in `index.html` so the host
// page also ends up isolated. Each cached once to avoid per-request
// allocation.
fn coop_coep_header_value(name: &str) -> Header {
    let value: &'static str = match name {
        "Cross-Origin-Opener-Policy" => "same-origin",
        "Cross-Origin-Embedder-Policy" => "require-corp",
        "Cross-Origin-Resource-Policy" => "same-origin",
        _ => unreachable!("unknown COOP/COEP header name"),
    };
    Header::from_bytes(name.as_bytes(), value.as_bytes())
        .expect("hardcoded COOP/COEP header bytes are always valid")
}
fn apply_coop_coep_to(mut resp: ResponseBox) -> ResponseBox {
    resp = resp
        .with_header(coop_coep_header_value("Cross-Origin-Opener-Policy"))
        .with_header(coop_coep_header_value("Cross-Origin-Embedder-Policy"))
        .with_header(coop_coep_header_value("Cross-Origin-Resource-Policy"));
    resp
}

fn start_http_server() {
    thread::spawn(move || {
        println!("[HTTP Server] Starting on http://localhost:{}", HTTP_PORT);

        let server = match Server::http(format!("0.0.0.0:{}", HTTP_PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[HTTP Server] Failed to start: {}", e);
                return;
            }
        };

        println!("[HTTP Server] Ready!");

        // Use multiple worker threads so blocking operations (ffprobe, ffmpeg) don't block other requests
        use std::sync::Arc;
        let server = Arc::new(server);
        let num_workers = 4;

        // Spawn worker threads - each processes requests sequentially but they run in parallel
        let mut handles = Vec::new();
        for worker_id in 0..num_workers {
            let server = server.clone();
            let handle = thread::spawn(move || {
                loop {
                    // recv() blocks waiting for the next request assigned to this worker
                    let request = match server.recv() {
                        Ok(rq) => rq,
                        Err(_) => break, // Server shutting down
                    };

                    let url = request.url().to_string();
                    let method = request.method().as_str();

                    // Parse query parameters
                    let mut file_path = String::new();
                    let mut max_size = 2048usize;
                    let mut ewa_path = String::new();
                    let mut fps = 25i32;

                    if url.contains('?') {
                        let parts: Vec<&str> = url.split('?').collect();
                        if parts.len() > 1 {
                            for param in parts[1].split('&') {
                                let kv: Vec<&str> = param.split('=').collect();
                                if kv.len() == 2 {
                                    match kv[0] {
                                        "path" => file_path = urlencoding_decode(kv[1]),
                                        "ewa" => ewa_path = urlencoding_decode(kv[1]),
                                        "fps" => fps = kv[1].parse().unwrap_or(25),
                                        "size" => max_size = kv[1].parse().unwrap_or(2048),
                                        _ => {}
                                    }
                                }
                            }
                        }
                    }

                    println!("[HTTP W{}] {} {} {}", worker_id, method, url, file_path);

                    // Route: fast ops inline, blocking ops handled inline (each worker handles one request at a time)
                    // Since we have multiple workers, requests are processed in parallel naturally.
                    // All arms return ResponseBox so we can stream large files directly from disk
                    // (via Response::from_file) without loading them into RAM first.
                    let response: ResponseBox = match (method, url.split('?').next().unwrap_or("")) {
                        ("GET", "/health") => {
                            json_response(serde_json::json!({
                                "status": "ok",
                                "service": "goku-file-explorer"
                            })).boxed()
                        }
                        ("GET", "/file") if !file_path.is_empty() => {
                            apply_coop_coep_to(handle_file_request(&file_path, &request))
                        }
                        ("GET", "/file/base64") if !file_path.is_empty() => {
                            apply_coop_coep_to(handle_file_base64_request(&file_path).boxed())
                        }
                        ("GET", "/video/info") if !file_path.is_empty() => {
                            handle_video_info_request(&file_path).boxed()
                        }
                        ("GET", "/video/stream") if !file_path.is_empty() => {
                            handle_video_stream_request(&file_path, &request)
                        }
                        ("GET", "/transcode/progress") if !file_path.is_empty() => {
                            handle_transcode_progress_request(&file_path).boxed()
                        }
                        ("GET", "/transcode/cancel") if !file_path.is_empty() => {
                            handle_transcode_cancel_request(&file_path).boxed()
                        }
                        ("GET", "/thumbnail") if !file_path.is_empty() => {
                            handle_thumbnail_request(&file_path, max_size).boxed()
                        }
                        ("GET", "/audio") if !file_path.is_empty() => {
                            handle_audio_request(&file_path, &request).boxed()
                        }
                        ("GET", "/model/convert") if !file_path.is_empty() => {
                            handle_model_convert_request(&file_path, &request).boxed()
                        }
                        ("GET", "/ewa") if !file_path.is_empty() => {
                            // Serve EWA file for LumiGrade player
                            apply_coop_coep_to(handle_file_request(&file_path, &request))
                        }
                        ("GET", "/lumiplayer") => {
                            // Serve LumiGrade player HTML with EWA file parameter
                            handle_lumiplayer_request(&ewa_path, fps).boxed()
                        }
                        ("GET", "/lumifiles") => {
                            // Serve LumiGrade player static files (lib/)
                            handle_lumifiles_request(&file_path).boxed()
                        }
                        _ => {
                            json_response(serde_json::json!({
                                "error": "Unknown endpoint",
                                "url": url,
                                "hint": "GET /health, /file?path=<path>, /file/base64?path=<path>, /video/info?path=<path>, /thumbnail?path=<path>&size=<size>"
                            })).boxed()
                        }
                    };

                    if let Err(e) = request.respond(response) {
                        eprintln!("[HTTP W{}] Response error: {}", worker_id, e);
                    }
                }
            });
            handles.push(handle);
        }

        // Wait for all workers to exit (they won't unless server closes)
        for h in handles {
            let _ = h.join();
        }
    });
}

fn urlencoding_decode(s: &str) -> String {
    let mut result = Vec::new();
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if hex.len() == 2 {
                if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                    result.push(byte);
                }
            }
        } else if c == '+' {
            result.push(b' ');
        } else {
            result.push(c as u8);
        }
    }

    // Convert bytes to UTF-8 string properly
    String::from_utf8_lossy(&result).into_owned()
}

/// Serve LumiGrade player HTML (Vite serves the public folder in dev mode)
fn handle_lumiplayer_request(ewa_file_path: &str, _fps: i32) -> ResponseBox {
    // Just redirect to the public folder path - Vite will serve it
    // The actual file is served by Vite dev server at /lumigrade/index.html
    // We just need to return a redirect or the file content
    let player_path = "public/lumigrade/index.html";
    let player_html = match std::fs::read_to_string(player_path) {
        Ok(content) => content,
        Err(_) => {
            let fallback_path = "src-tauri/public/lumigrade/index.html";
            match std::fs::read_to_string(fallback_path) {
                Ok(content) => content,
                Err(e) => {
                    return json_response(serde_json::json!({
                        "error": "Failed to read LumiGrade player",
                        "details": e.to_string()
                    })).boxed();
                }
            }
        }
    };

    // Build EWA URL for the auto-load script to use
    let encoded_path = urlencoding_encode_simple(ewa_file_path);
    let ewa_url = format!("http://localhost:18765/ewa?path={}", encoded_path);

    // Replace the auto-load URL in the HTML
    let modified_html = player_html.replace(
        "const fileUrl = params.get('file');",
        &format!("const fileUrl = '{}';", ewa_url)
    );

    let body_bytes = modified_html.into_bytes();

    Response::from_data(body_bytes)
        .with_header(
            Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap()
        )
        .boxed()
}

/// Serve LumiGrade player static files
fn handle_lumifiles_request(requested_file: &str) -> ResponseBox {
    // Extract filename from path
    let filename = if requested_file.is_empty() {
        "fzstd.umd.js".to_string()
    } else {
        requested_file.to_string()
    };

    // Use bundled lumigrade folder
    let file_path = format!("public/lumigrade/lib/{}", filename);

    match std::fs::read(&file_path) {
        Ok(data) => {
            let content_type = if filename.ends_with(".js") {
                "application/javascript"
            } else if filename.ends_with(".wasm") {
                "application/wasm"
            } else if filename.ends_with(".css") {
                "text/css"
            } else {
                "application/octet-stream"
            };

            Response::from_data(data)
                .with_header(
                    Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap()
                )
                .with_header(
                    Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap()
                )
                .boxed()
        }
        Err(_) => {
            // Fallback: try src-tauri/public for dev mode
            let fallback_path = format!("src-tauri/public/lumigrade/lib/{}", filename);
            match std::fs::read(&fallback_path) {
                Ok(data) => {
                    let content_type = if filename.ends_with(".js") {
                        "application/javascript"
                    } else if filename.ends_with(".wasm") {
                        "application/wasm"
                    } else if filename.ends_with(".css") {
                        "text/css"
                    } else {
                        "application/octet-stream"
                    };

                    Response::from_data(data)
                        .with_header(
                            Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap()
                        )
                        .with_header(
                            Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap()
                        )
                        .boxed()
                }
                Err(e) => {
                    json_response(serde_json::json!({
                        "error": "File not found",
                        "path": file_path,
                        "details": e.to_string()
                    })).boxed()
                }
            }
        }
    }
}

fn urlencoding_encode_simple(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    result
}

fn json_response(data: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = data.to_string();
    let body_bytes = body.into_bytes();

    Response::from_data(body_bytes)
        .with_header(
            Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap()
        )
        .with_header(
            Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap()
        )
}

// Build an HTTP response that streams a fragmented MP4 from any Read source
// directly to the browser. We pass `data_length = None` so tiny_http uses
// chunked transfer encoding — the browser starts receiving bytes
// immediately, no Content-Length negotiation, no buffering of the whole
// file in memory. The fragmented MP4 moov box at the start of the stream
// tells the browser this is a valid MP4 container, so playback can begin
// after the first few keyframes arrive.
fn streaming_video_response<R: Read + Send + 'static>(reader: R) -> ResponseBox {
    let headers = vec![
        Header::from_bytes(&b"Content-Type"[..], &b"video/mp4"[..]).unwrap(),
        Header::from_bytes(&b"Accept-Ranges"[..], &b"none"[..]).unwrap(),
        Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap(),
        Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
        // COEP=require-corp on the Tauri page requires every cross-origin
        // resource we serve to opt-in via Cross-Origin-Resource-Policy.
        // Without this, the <video> element loads but the canvas becomes
        // tainted and `getImageData` (used by the eyedropper) throws
        // SecurityError, silently breaking Color Picker on video frames.
        Header::from_bytes(&b"Cross-Origin-Resource-Policy"[..], &b"cross-origin"[..]).unwrap(),
    ];
    Response::new(
        tiny_http::StatusCode(200),
        headers,
        reader,
        None,
        None,
    ).boxed()
}

// Serve file data from a given Path with range support.
// Handles both original files and faststart-reordered temp files.
//
// Streams the file from disk rather than reading the whole thing into RAM
// first. The previous implementation used `fs::read` + `Response::from_data`,
// which forced us to load the entire MP4 (often hundreds of MB) into memory
// before sending a single byte — the browser sat in "connecting" state the
// whole time, and a 144 MB MOV would not start playing until the whole file
// was read. tiny_http's `Response::from_file` writes headers immediately and
// streams bytes as they come off disk, so playback can start as soon as the
// browser has buffered enough of the MP4 header.
fn serve_file_data(path: &Path, request: &Request) -> ResponseBox {
    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = get_mime_type(&ext);

    let total_len = match fs::metadata(path) {
        Ok(m) => m.len() as usize,
        Err(e) => {
            return json_response(serde_json::json!({
                "success": false,
                "error": e.to_string()
            })).boxed();
        }
    };

    println!("[HTTP] Serving file: {} ({} bytes)", path.display(), total_len);

    let range_header = request
        .headers()
        .iter()
        .find(|h| h.field.as_str().to_ascii_lowercase() == "range");

    // Range request — tiny_http doesn't support ranges natively, so we
    // open the file and seek to the requested offset, then stream the
    // requested slice. This is what lets the browser seek into an MP4
    // that's mid-download or skip ahead in a long video.
    if let Some(range_hdr) = range_header {
        let range_str = range_hdr.value.as_str();
        if let Some((start, end)) = parse_range_header(range_str, total_len) {
            let content_length = end - start + 1;
            println!("[HTTP] Serving range: bytes={}-{} ({}/{} bytes)", start, end, content_length, total_len);

            // Use a Take wrapper to read just the requested range from the
            // file without loading the whole file into memory.
            let file = match fs::File::open(path) {
                Ok(f) => f,
                Err(e) => {
                    return json_response(serde_json::json!({
                        "success": false,
                        "error": e.to_string()
                    })).boxed();
                }
            };
            use std::io::{Read, Seek, SeekFrom};
            let mut file = file;
            if file.seek(SeekFrom::Start(start as u64)).is_err() {
                return json_response(serde_json::json!({
                    "success": false,
                    "error": "seek failed"
                })).boxed();
            }
            let content_range = format!("bytes {}-{}/{}", start, end, total_len);

            // Read the requested range into a buffer. Range requests are
            // typically small (browser seek ahead by a few MB at most), so
            // loading into memory is fine here. The full-file path below
            // is the one that streams from disk.
            let mut buf = vec![0u8; content_length];
            match (&mut file).take(content_length as u64).read_exact(&mut buf) {
                Ok(_) => {}
                Err(e) => {
                    return json_response(serde_json::json!({
                        "success": false,
                        "error": e.to_string()
                    })).boxed();
                }
            }

            return Response::from_data(buf)
                .with_status_code(206)
                .with_header(Header::from_bytes(&b"Content-Type"[..], mime.as_bytes()).unwrap())
                .with_header(Header::from_bytes(&b"Content-Length"[..], content_length.to_string().as_bytes()).unwrap())
                .with_header(Header::from_bytes(&b"Content-Range"[..], content_range.as_bytes()).unwrap())
                .with_header(Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap())
                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap())
                .with_header(Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap())
                // CORP opt-in for COEP=require-corp — see streaming_video_response.
                .with_header(Header::from_bytes(&b"Cross-Origin-Resource-Policy"[..], &b"cross-origin"[..]).unwrap())
                .boxed();
        } else {
            return Response::from_string("")
                .with_status_code(416)
                .with_header(Header::from_bytes(&b"Content-Range"[..], format!("bytes */{}", total_len).as_bytes()).unwrap())
                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap())
                .with_header(Header::from_bytes(&b"Cross-Origin-Resource-Policy"[..], &b"cross-origin"[..]).unwrap())
                .boxed();
        }
    }

    // No range — stream the entire file directly from disk. The browser
    // will start receiving bytes immediately and can begin playback as
    // soon as it has buffered the moov atom + a few seconds of media.
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            return json_response(serde_json::json!({
                "success": false,
                "error": e.to_string()
            })).boxed();
        }
    };

    Response::from_file(file)
        .with_header(Header::from_bytes(&b"Content-Type"[..], mime.as_bytes()).unwrap())
        .with_header(Header::from_bytes(&b"Content-Length"[..], total_len.to_string().as_bytes()).unwrap())
        .with_header(Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap())
        .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap())
        .with_header(Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap())
        // CORP opt-in for COEP=require-corp — see streaming_video_response.
        .with_header(Header::from_bytes(&b"Cross-Origin-Resource-Policy"[..], &b"cross-origin"[..]).unwrap())
        .boxed()
}

fn handle_file_request(file_path: &str, request: &Request) -> ResponseBox {
    let path = Path::new(file_path);

    if !path.exists() {
        return json_response(serde_json::json!({
            "success": false,
            "error": "File not found"
        })).boxed();
    }

    serve_file_data(path, request)
}

// Handle audio file request - streams audio with proper headers for HTML5 audio/video elements
fn handle_audio_request(file_path: &str, _request: &Request) -> Response<std::io::Cursor<Vec<u8>>> {
    let path = Path::new(file_path);

    if !path.exists() {
        return json_response(serde_json::json!({
            "success": false,
            "error": "Audio file not found"
        }));
    }

    // Determine content type based on extension
    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let content_type = match ext.as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wma" => "audio/x-ms-wma",
        "opus" => "audio/opus",
        _ => "application/octet-stream",
    };

    // Read the entire file
    let data = match fs::read(path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[Audio] Failed to read file {}: {}", file_path, e);
            return json_response(serde_json::json!({
                "success": false,
                "error": format!("Failed to read file: {}", e)
            }));
        }
    };

    let file_size = data.len();

    Response::from_data(data)
        .with_header(
            Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap()
        )
        .with_header(
            Header::from_bytes(&b"Content-Length"[..], file_size.to_string().as_bytes()).unwrap()
        )
        .with_header(
            Header::from_bytes(&b"Accept-Ranges"[..], b"none").unwrap()
        )
        .with_header(
            Header::from_bytes(&b"Cache-Control"[..], b"public, max-age=3600").unwrap()
        )
        .with_header(
            Header::from_bytes(&b"Access-Control-Allow-Origin"[..], b"*").unwrap()
        )
        .with_header(
            Header::from_bytes(&b"Cross-Origin-Resource-Policy"[..], b"cross-origin").unwrap()
        )
}

// Parse HTTP Range header value like "bytes=0-1023" or "bytes=5000-"
// Returns (start, end) byte offsets, or None if invalid.
// Handles single ranges only (multi-range requests not supported).
fn parse_range_header(range_str: &str, file_size: usize) -> Option<(usize, usize)> {
    let range_str = range_str.trim();
    if !range_str.starts_with("bytes=") {
        return None;
    }
    let range_str = &range_str[6..];

    // Split on comma (ignore multi-range for now)
    let range_part = range_str.split(',').next()?.trim();
    if range_part.is_empty() {
        return None;
    }

    let dash_pos = range_part.find('-')?;
    let start_str = &range_part[..dash_pos];
    let end_str = &range_part[dash_pos + 1..];

    let file_size = file_size as usize;

    // Case: bytes=-500  -> last 500 bytes (start = size - 500)
    if start_str.is_empty() {
        let suffix_len: usize = end_str.parse().ok()?;
        if suffix_len == 0 {
            return None;
        }
        if suffix_len > file_size {
            return Some((0, file_size - 1));
        }
        return Some((file_size - suffix_len, file_size - 1));
    }

    // Case: bytes=0-    -> everything from start to end
    let start: usize = start_str.parse().ok()?;
    if end_str.is_empty() {
        if start >= file_size {
            return None;
        }
        return Some((start, file_size - 1));
    }

    // Case: bytes=0-1023  -> bytes 0 through 1023 inclusive
    let end: usize = end_str.parse().ok()?;
    if start > end {
        return None;
    }
    if start >= file_size {
        return None;
    }
    let end = end.min(file_size - 1);
    Some((start, end))
}

fn handle_file_base64_request(file_path: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let path = Path::new(file_path);
    
    if !path.exists() {
        return json_response(serde_json::json!({
            "success": false,
            "error": "File not found"
        }));
    }

    match fs::read(path) {
        Ok(data) => {
            let b64 = STANDARD.encode(&data);
            json_response(serde_json::json!({
                "success": true,
                "base64": b64,
                "size": data.len()
            }))
        }
        Err(e) => {
            json_response(serde_json::json!({
                "success": false,
                "error": e.to_string()
            }))
        }
    }
}

fn handle_video_info_request(file_path: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let path = Path::new(file_path);
    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Try to get video info using ffprobe
    let ffprobe_path = get_ffprobe_path();

    let output = hidden_command(&ffprobe_path)
        .args(&["-v", "quiet", "-print_format", "json", "-of", "json", "-show_format", "-show_streams", "-find_stream_info", file_path])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let json_str = String::from_utf8_lossy(&output.stdout);
            if !json_str.trim().starts_with('{') {
                eprintln!("[Video Info] ffprobe returned non-JSON for {}: {}", file_path, &json_str[..json_str.len().min(200)]);
                return json_response(serde_json::json!({
                    "success": false,
                    "path": file_path,
                    "extension": ext,
                    "error": "ffprobe failed"
                }));
            }
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&json_str) {
                let duration = json.get("format")
                    .and_then(|f| f.get("duration"))
                    .and_then(|d| d.as_str())
                    .and_then(|s| s.parse::<f64>().ok());

                let (width, height) = json.get("streams")
                    .and_then(|s| s.as_array())
                    .and_then(|streams| {
                        streams.iter().find_map(|stream| {
                            let w = stream.get("width")?.as_u64()?;
                            let h = stream.get("height")?.as_u64()?;
                            Some((w as u32, h as u32))
                        })
                    })
                    .unwrap_or((0, 0));

                // Parse FPS using industry-standard priority (matching After Effects):
                // 1. r_frame_rate - real frame rate, reflects container/decoded FPS (most reliable)
                // 2. avg_frame_rate - average frame rate, can be averaged/smoothed
                // 3. fps codec info - plain number, least reliable
                let fps = json.get("streams")
                    .and_then(|s| s.as_array())
                    .and_then(|streams| {
                        // First try: r_frame_rate (the actual frame rate from stream info)
                        let real = streams.iter().find_map(|stream| {
                            stream.get("r_frame_rate")
                                .and_then(|r| r.as_str())
                                .and_then(|r| parse_fps_fraction(r))
                                .filter(|&f| f > 0.0 && f < 1000.0)
                        });
                        if real.is_some() {
                            return real;
                        }
                        // Second try: avg_frame_rate (e.g. "25/1", "30000/1001")
                        let avg = streams.iter().find_map(|stream| {
                            stream.get("avg_frame_rate")
                                .and_then(|r| r.as_str())
                                .and_then(|r| parse_fps_fraction(r))
                                .filter(|&f| f > 0.0 && f < 1000.0)
                        });
                        if avg.is_some() {
                            return avg;
                        }
                        // Third try: fps from codec info (plain number string, e.g. "30")
                        streams.iter().find_map(|stream| {
                            stream.get("fps")
                                .and_then(|v| v.as_str())
                                .and_then(|s| s.parse::<f64>().ok())
                                .filter(|&f| f > 0.0 && f < 1000.0)
                        })
                    })
                    .map(normalize_fps);

                println!("[Video Info] {} fps={:?} duration={:?} {}x{}", file_path, fps, duration, width, height);

                return json_response(serde_json::json!({
                    "success": true,
                    "path": file_path,
                    "extension": ext,
                    "duration": duration,
                    "width": width,
                    "height": height,
                    "fps": fps
                }));
            }
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            eprintln!("[ffprobe] failed for {}: {}", file_path, stderr);
        }
    } else {
        eprintln!("[ffprobe] could not run for {}", file_path);
    }

    // Fallback: try to get basic info
    let metadata = fs::metadata(path).ok();
    let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

    json_response(serde_json::json!({
        "success": true,
        "path": file_path,
        "extension": ext,
        "size": size,
        "fps": null,
        "duration": null
    }))
}

fn handle_transcode_progress_request(file_path: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let path = Path::new(file_path);
    let cache_key = get_progress_key(path);

    println!("[Transcode Progress] request for: {} -> cache_key: {}", file_path, cache_key);

    if let Some(progress) = get_transcode_progress(&cache_key) {
        println!("[Transcode Progress] FOUND: {:?}", progress.status);
        let status_str = match &progress.status {
            TranscodeStatus::Idle => "idle",
            TranscodeStatus::Encoding => "encoding",
            TranscodeStatus::Complete => "complete",
            TranscodeStatus::Failed(e) => {
                return json_response(serde_json::json!({
                    "success": true,
                    "cache_key": cache_key,
                    "percent": 0.0,
                    "current_frame": 0,
                    "total_frames": 0,
                    "status": "failed",
                    "error": e
                }));
            }
        };

        json_response(serde_json::json!({
            "success": true,
            "cache_key": cache_key,
            "percent": progress.percent,
            "current_frame": progress.current_frame,
            "total_frames": progress.total_frames,
            "status": status_str
        }))
    } else {
        // No active transcode in progress. Check whether a completed cache
        // file exists on disk — if so, return status='complete' so the
        // frontend stops polling immediately instead of waiting in vain.
        let cache_path = get_transcoded_cache_path(path);
        let cache_valid = is_valid_cached_mp4(&cache_path);
        println!(
            "[Transcode Progress] NOT FOUND for cache_key: {} (cache valid: {})",
            cache_key, cache_valid
        );

        if cache_valid {
            // Mark progress as Complete so future polls (and other code paths)
            // see the transcode as done without re-reading disk.
            set_transcode_progress(&cache_key, TranscodeProgress {
                percent: 100.0,
                current_frame: 0,
                total_frames: 0,
                status: TranscodeStatus::Complete,
                cache_key: cache_key.clone(),
            });
        }

        json_response(serde_json::json!({
            "success": true,
            "cache_key": cache_key,
            "percent": if cache_valid { 100.0 } else { 0.0 },
            "current_frame": 0,
            "total_frames": 0,
            "status": if cache_valid { "complete" } else { "not_found" }
        }))
    }
}

// Cancel any running transcode for the given file. Kills the FFmpeg child so
// the browser's pending /video/stream request unblocks immediately and the
// next request for the same file starts a fresh transcode. Removes the
// partial cache file only if it's not a valid complete transcode (otherwise
// we'd throw away a perfectly good cache just because the user clicked away).
fn handle_transcode_cancel_request(file_path: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let path = Path::new(file_path);
    let cache_key = get_progress_key(path);

    let mut killed = false;
    if let Ok(mut map) = get_transcode_children().lock() {
        if let Some(mut child) = map.remove(&cache_key) {
            match child.kill() {
                Ok(_) => {
                    let _ = child.wait();
                    killed = true;
                    println!("[Transcode] Cancelled running transcode for: {}", path.display());
                }
                Err(e) => {
                    eprintln!("[Transcode] Failed to kill FFmpeg for {}: {}", cache_key, e);
                }
            }
        }
    }

    // If we actually killed a running FFmpeg, mark progress as Failed so the
    // HTTP wait loop in transcode_video_to_h264_with_encoder breaks out and
    // returns an error to the browser. Only do this when something was
    // actually cancelled — setting Failed on a healthy complete transcode
    // would make the next /transcode/progress poll lie to the user.
    if killed {
        set_transcode_progress(&cache_key, TranscodeProgress {
            percent: 0.0,
            current_frame: 0,
            total_frames: 0,
            status: TranscodeStatus::Failed("cancelled by user".to_string()),
            cache_key: cache_key.clone(),
        });
        // Remove only the partial / invalid cache file. A valid complete
        // cache from a previous successful transcode is preserved.
        let cp = get_transcoded_cache_path(path);
        if cp.exists() && !is_valid_cached_mp4(&cp) {
            let _ = fs::remove_file(&cp);
        }
    }

    release_transcode(&cache_key);

    json_response(serde_json::json!({
        "success": true,
        "cache_key": cache_key,
        "killed": killed,
        "status": "cancelled"
    }))
}

// Parse a fraction string like "30000/1001" or "25/1" into an f64 fps value
fn parse_fps_fraction(fraction: &str) -> Option<f64> {
    let parts: Vec<&str> = fraction.split('/').collect();
    if parts.len() == 2 {
        let num: f64 = parts[0].parse().ok()?;
        let den: f64 = parts[1].parse().ok()?;
        if den > 0.0 {
            return Some(num / den);
        }
    }
    fraction.parse().ok()
}

// After Effects NTSC-safe FPS normalization with 0.3% threshold
// Matches the standard film/video frame rates used in post-production
fn normalize_fps(fps: f64) -> f64 {
    const STANDARD_RATES: &[f64] = &[
        23.976, 24.0, 25.0, 29.97, 30.0,
        47.952, 48.0, 50.0, 59.940, 60.0,
        119.88, 120.0,
    ];

    let threshold = fps * 0.003;
    STANDARD_RATES.iter()
        .find(|&&r| (r - fps).abs() <= threshold)
        .copied()
        .unwrap_or(fps)
}

// ============================================================
// MOOV atom position checker & faststart reorder
// ============================================================

const FASTSTART_CACHE_DIR: &str = "gk_faststart_cache";

fn ensure_faststart_cache_dir() -> std::path::PathBuf {
    let cache = std::env::temp_dir().join(FASTSTART_CACHE_DIR);
    if !cache.exists() {
        let _ = fs::create_dir_all(&cache);
    }
    cache
}

// Check if a MOV/MP4 has moov atom at the end (needs faststart reorder for streaming).
// Returns true if moov is at the end (not optimized), false if already at the front.
fn needs_faststart_reorder(file_path: &Path) -> bool {
    let ffprobe_path = get_ffprobe_path();

    let output = hidden_command(&ffprobe_path)
        .args(&[
            "-v", "quiet",
            "-print_format", "json",
            "-of", "json",
            "-show_format",
            "-show_streams",
            file_path.to_string_lossy().as_ref(),
        ])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let json_str = String::from_utf8_lossy(&output.stdout);
            if !json_str.trim().starts_with('{') {
                eprintln!("[Faststart] ffprobe returned non-JSON for {}: {}", file_path.display(), &json_str[..json_str.len().min(200)]);
                return true;
            }
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&json_str) {
                // Check moov position via ffprobe's "format" section
                // ffprobe reports moov position when available
                if let Some(start_time) = json.get("format")
                    .and_then(|f| f.get("moov_position"))
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<u64>().ok())
                {
                    if start_time > 0 {
                        // moov is NOT at the beginning — needs reorder
                        println!("[Faststart] {} has moov at position {} — needs reorder", file_path.display(), start_time);
                        return true;
                    }
                }
                // If moov_position is 0 or missing, it's already at the front
                return false;
            }
        }
    }

    // Fallback: if ffprobe fails, assume it needs reorder (safe default)
    println!("[Faststart] {} ffprobe check failed — assuming needs reorder", file_path.display());
    true
}

// Reorder moov atom to the beginning using FFmpeg (no re-encode, just atom reordering).
// Returns the path to the reordered temp file.
fn ensure_faststart(file_path: &Path) -> std::result::Result<std::path::PathBuf, String> {
    let cache_dir = ensure_faststart_cache_dir();
    let file_key = format!(
        "{}_{}",
        std::process::id(),
        file_path.to_string_lossy().replace(['/', '\\', ':', ' ', '-'], "_")
    );
    let output_path = cache_dir.join(format!("{}.mov", file_key));

    // Skip if already reordered and output exists (within same process lifetime)
    if output_path.exists() {
        return Ok(output_path);
    }

    println!("[Faststart] Reordering moov atom for: {}", file_path.display());

    let ffmpeg_path = get_ffmpeg_path();
    let result = hidden_command(&ffmpeg_path)
        .args(&[
            "-y",
            "-i", file_path.to_string_lossy().as_ref(),
            "-c", "copy",
            "-movflags", "+faststart",
            output_path.to_string_lossy().as_ref(),
        ])
        .output();

    match result {
        Ok(output) => {
            if output.status.success() && output_path.exists() {
                println!("[Faststart] Reorder complete: {}", output_path.display());
                Ok(output_path)
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(format!("FFmpeg faststart failed: {}", stderr))
            }
        }
        Err(e) => Err(format!("Failed to run FFmpeg for faststart: {}", e))
    }
}

// Cleanup faststart temp files older than 1 hour on startup and periodically.
fn cleanup_faststart_cache() {
    let cache_dir = ensure_faststart_cache_dir();
    if !cache_dir.exists() {
        return;
    }

    let cutoff = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        - 3600; // 1 hour

    if let Ok(entries) = fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    let modified_secs = modified
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    if modified_secs < cutoff {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
    }
}

#[tauri::command]
async fn preload_exr_sequence(_args: PreloadExrArgs) -> PreloadResult {
    // Disk cache removed - all EXR frames are kept in RAM via the global frame cache.
    // The UI fires a continuous background loader that decodes on demand.
    println!("[EXR] preload_exr_sequence is a no-op (RAM-only cache)");
    PreloadResult {
        success: true,
        cached_paths: vec![],
        success_count: 0,
        cache_dir: None,
        error: None,
    }
}

// Codecs that Chrome/Edge/Chromium-based browsers natively support in MP4/MOV containers.
const BROWSER_COMPATIBLE_VIDEO_CODECS: &[&str] = &[
    "h264", "avc1", "avc3",   // H.264 / AVC
    "hevc", "hvc1", "hev1",   // H.265 / HEVC (limited support)
    "vp8", "vp9",             // VP8 / VP9
    "av01",                   // AV1
    "theora",                  // Theora
    "mp4v", "mp4v-es",        // MPEG-4 Part 2
    "3iv1", "3iv2",           // 3ivx
    "divx", "dx50",           // DivX
    "xvid",                   // Xvid
    "mjpeg",                  // Motion JPEG
];

// Codecs that browsers CANNOT decode — these need transcoding to H.264.
const BROWSER_INCOMPATIBLE_CODEC_PREFIXES: &[&str] = &[
    "prores",                 // Apple ProRes family reported by ffprobe codec_name
    "ap4h", "apch", "apcn",   // Apple ProRes (all variants)
    "apcs", "apco", "aprh",   // Apple ProRes
    "aprh",                   // Apple ProRes RAW
    "cfhd",                   // CineForm HD
    "agm3",                   // Avid DNxHD/DNxHR wrapper
    "AVdn",                   // Avid DNxHD
    "FFV1",                   // FFV1 lossless
    "v210",                   // Uncompressed 10-bit
    "v410",                   // Uncompressed 10-bit 4:4:4
    "i420",                   // Uncompressed YUV
    "yuv2",                   // Uncompressed YUV
    "raw ",                   // Uncompressed raw
    "r210",                   // Uncompressed 10-bit RGB
    "UQRG",                   // Uncompressed RGB
    "b64a",                   // Uncompressed 16-bit
    "SMVJPEG",                // Still MJPEG
    "aic ", "icod",           // Apple Intermediate Codec
    "svq1", "svq3",           // Sorenson Video
    "qdrw",                   // QuickTime rle
    "wrap",                   // Wrap
    "imc4",                   // IMC4
    "col0", "col1",           // None/Grayscale
];

fn get_video_codec_name(path: &Path) -> Option<String> {
    let ffprobe_path = get_ffprobe_path();

    let output = hidden_command(&ffprobe_path)
        .args(&[
            "-v", "quiet",
            "-print_format", "json",
            "-of", "json",
            "-show_streams",
            "-select_streams", "v:0",
            path.to_string_lossy().as_ref(),
        ])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let json_str = String::from_utf8_lossy(&output.stdout);
            if !json_str.trim().starts_with('{') {
                eprintln!("[Codec] ffprobe returned non-JSON for {}: {}", path.display(), &json_str[..json_str.len().min(200)]);
                return None;
            }
            println!("[Codec] ffprobe raw output: {}", json_str);
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&json_str) {
                // Try codec_name first
                if let Some(codec) = json.get("streams")
                    .and_then(|s| s.as_array())
                    .and_then(|streams| streams.first())
                    .and_then(|stream| stream.get("codec_name"))
                    .and_then(|c| c.as_str())
                {
                    return Some(codec.to_string());
                }
                // Fallback: codec_tag_string
                if let Some(codec) = json.get("streams")
                    .and_then(|s| s.as_array())
                    .and_then(|streams| streams.first())
                    .and_then(|stream| stream.get("codec_tag_string"))
                    .and_then(|c| c.as_str())
                {
                    return Some(codec.to_string());
                }
            }
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            eprintln!("[Codec] ffprobe failed for {}: {}", path.display(), stderr);
        }
    } else {
        eprintln!("[Codec] ffprobe could not run for {}", path.display());
    }
    None
}

fn is_browser_compatible_codec(path: &Path) -> bool {
    if let Some(codec) = get_video_codec_name(path) {
        let codec_lower = codec.to_lowercase();
        println!("[Codec] {} uses codec: '{}'", path.display(), codec);

        for compatible in BROWSER_COMPATIBLE_VIDEO_CODECS {
            if codec_lower.contains(compatible) {
                println!("[Codec] codec '{}' IS compatible", codec);
                return true;
            }
        }
        for incompatible in BROWSER_INCOMPATIBLE_CODEC_PREFIXES {
            if codec_lower.starts_with(incompatible) || codec_lower.contains(incompatible) {
                println!("[Codec] codec '{}' is INCOMPATIBLE — will transcode", codec);
                return false;
            }
        }
        // Unknown codec — assume incompatible to be safe
        println!("[Codec] codec '{}' is unknown — assuming INCOMPATIBLE, transcode", codec);
        return false;
    }
    // Could not detect codec — assume incompatible (safe default, avoid browser error)
    println!("[Codec] could not detect codec for {} — assuming INCOMPATIBLE, transcode", path.display());
    false
}

fn handle_video_stream_request(file_path: &str, request: &Request) -> ResponseBox {
    let path = Path::new(file_path);

    if !path.exists() {
        return json_response(serde_json::json!({
            "success": false,
            "error": "File not found"
        })).boxed();
    }

    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // For formats browser can play natively, serve with faststart optimization for MP4/MOV.
    // webm and ogv don't use the moov atom, so they're always served directly.
    let browser_native = ["mp4", "webm", "ogv", "mov"];
    if browser_native.contains(&ext.as_str()) {
        // webm/ogv don't have moov atoms — serve directly
        if ext == "webm" || ext == "ogv" {
            return serve_file_data(path, request);
        }

        // mp4/mov: check codec compatibility first
        if !is_browser_compatible_codec(path) {
            println!("[HTTP] {} uses unsupported codec — transcode to H.264", path.display());
            return transcode_video_to_h264(path, request);
        }

        // mp4/mov: check if moov atom needs to be reordered for streaming
        if needs_faststart_reorder(path) {
            match ensure_faststart(path) {
                Ok(reordered_path) => {
                    println!("[HTTP] Serving faststart-reordered: {}", reordered_path.display());
                    return serve_file_data(&reordered_path, request);
                }
                Err(e) => {
                    eprintln!("[Faststart] Reorder failed for {}, falling back to original: {}", path.display(), e);
                    return serve_file_data(path, request);
                }
            }
        }

        return serve_file_data(path, request);
    }

    // For other formats, use FFmpeg to transcode to MP4
    transcode_video_to_h264(Path::new(file_path), request)
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcode cache — persistent H.264 cache keyed by source file path+modified
// ─────────────────────────────────────────────────────────────────────────────
const TRANSCODE_CACHE_DIR: &str = "gk_transcode_cache";

fn get_transcoded_cache_path(input_path: &Path) -> std::path::PathBuf {
    let cache_dir = std::env::temp_dir().join(TRANSCODE_CACHE_DIR);
    let file_key = format!(
        "t_{}",
        input_path
            .to_string_lossy()
            .replace(['/', '\\', ':', ' ', '-'], "_")
    );
    cache_dir.join(format!("{}.mp4", file_key))
}

// Reconstruct the cache file path from a progress key. Returns the expected
// .mp4 path even if it doesn't exist on disk yet.
fn get_transcoded_cache_path_for_key(progress_key: &str) -> std::path::PathBuf {
    let cache_dir = std::env::temp_dir().join(TRANSCODE_CACHE_DIR);
    cache_dir.join(format!("t_{}.mp4", progress_key))
}

fn ensure_transcode_cache_dir() -> std::path::PathBuf {
    let cache = std::env::temp_dir().join(TRANSCODE_CACHE_DIR);
    if !cache.exists() {
        let _ = fs::create_dir_all(&cache);
    }
    cache
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcode progress tracking — thread-safe, polled by frontend
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct TranscodeProgress {
    pub percent: f64,
    pub current_frame: u64,
    pub total_frames: u64,
    pub status: TranscodeStatus,
    pub cache_key: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub enum TranscodeStatus {
    #[default]
    Idle,
    Encoding,
    Complete,
    Failed(String),
}

static TRANSCODE_PROGRESS: std::sync::OnceLock<Mutex<std::collections::HashMap<String, TranscodeProgress>>> =
    std::sync::OnceLock::new();

// Tracks which cache keys have an FFmpeg currently running, to prevent duplicate transcode.
static TRANSCODE_RUNNING: std::sync::OnceLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::OnceLock::new();

fn get_running_set() -> &'static Mutex<std::collections::HashSet<String>> {
    TRANSCODE_RUNNING.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

// Holds the FFmpeg Child handle for each running transcode so we can kill it
// when the user navigates away (or opens a different video). The frontend hits
// /transcode/cancel to release any pending transcode for the previous file.
static TRANSCODE_CHILDREN: std::sync::OnceLock<Mutex<std::collections::HashMap<String, std::process::Child>>> =
    std::sync::OnceLock::new();

fn get_transcode_children() -> &'static Mutex<std::collections::HashMap<String, std::process::Child>> {
    TRANSCODE_CHILDREN.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

// Atomically claim a transcode slot. Returns true if this caller should spawn FFmpeg.
fn try_claim_transcode(cache_key: &str) -> bool {
    if let Ok(mut set) = get_running_set().lock() {
        set.insert(cache_key.to_string())
    } else {
        false
    }
}

fn release_transcode(cache_key: &str) {
    if let Ok(mut set) = get_running_set().lock() {
        set.remove(cache_key);
    }
}

fn get_progress_map() -> &'static Mutex<std::collections::HashMap<String, TranscodeProgress>> {
    TRANSCODE_PROGRESS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn get_progress_key(input_path: &Path) -> String {
    format!(
        "{}",
        input_path
            .to_string_lossy()
            .replace(['/', '\\', ':', ' ', '-'], "_")
    )
}

pub fn set_transcode_progress(cache_key: &str, progress: TranscodeProgress) {
    if let Ok(mut map) = get_progress_map().lock() {
        println!("[Transcode Progress] SET {} -> {:?}", cache_key, progress.status);
        map.insert(cache_key.to_string(), progress);
    }
}

pub fn get_transcode_progress(cache_key: &str) -> Option<TranscodeProgress> {
    get_progress_map().lock().ok()?.get(cache_key).cloned()
}

pub fn remove_transcode_progress(cache_key: &str) {
    if let Ok(mut map) = get_progress_map().lock() {
        map.remove(cache_key);
    }
}

fn parse_ffmpeg_progress(progress_file: &Path) -> Option<(u64, u64)> {
    let content = fs::read_to_string(progress_file).ok()?;
    let mut current_frame: u64 = 0;
    let mut total_frames: u64 = 0;

    for line in content.lines() {
        if line.starts_with("frame=") {
            current_frame = line.trim_start_matches("frame=").parse().unwrap_or(0);
        } else if line.starts_with("total_frames=") {
            total_frames = line.trim_start_matches("total_frames=").parse().unwrap_or(0);
        }
    }

    Some((current_frame, total_frames))
}

fn update_progress_from_ffmpeg_output(cache_key: &str, _input_path: &Path, progress_file: &Path, total_frames: u64) {
    if let Some((current_frame, _)) = parse_ffmpeg_progress(progress_file) {
        let percent = if total_frames > 0 {
            (current_frame as f64 / total_frames as f64 * 100.0).min(99.0)
        } else {
            0.0
        };

        set_transcode_progress(cache_key, TranscodeProgress {
            percent,
            current_frame,
            total_frames,
            status: TranscodeStatus::Encoding,
            cache_key: cache_key.to_string(),
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GPU-accelerated video encoding — auto-detects NVIDIA / AMD / Intel / CPU
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
enum VideoEncoder {
    NvidiaNvEnc,
    AmdAmf,
    IntelQsv,
    Cpu,
}

fn get_best_video_encoder(ffmpeg_path: &str) -> VideoEncoder {
    let output = hidden_command(ffmpeg_path)
        .args(["-hide_banner", "-encoders"])
        .output();

    let encoders = match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => String::new(),
    };

    if encoders.contains("h264_nvenc") {
        println!("[GPU] Detected NVIDIA GPU — will use NVENC");
        VideoEncoder::NvidiaNvEnc
    } else if encoders.contains("h264_amf") {
        println!("[GPU] Detected AMD GPU — will use AMF");
        VideoEncoder::AmdAmf
    } else if encoders.contains("h264_qsv") {
        println!("[GPU] Detected Intel GPU — will use QuickSync");
        VideoEncoder::IntelQsv
    } else {
        println!("[GPU] No hardware encoder detected — using CPU (libx264)");
        VideoEncoder::Cpu
    }
}

impl VideoEncoder {
    fn video_encoder_args(&self) -> (&'static str, Vec<&'static str>) {
        match self {
            VideoEncoder::NvidiaNvEnc => (
                "h264_nvenc",
                vec!["-preset", "p1", "-rc:v", "vbr", "-cq:v", "23", "-b:v", "0"],
            ),
            VideoEncoder::AmdAmf => (
                "h264_amf",
                vec!["-preset", "quality", "-rc:v", "cqp", "-qp:i", "23", "-qp:p", "23", "-qp:b", "23"],
            ),
            VideoEncoder::IntelQsv => (
                "h264_qsv",
                vec!["-preset", "medium", "-global_quality", "23"],
            ),
            VideoEncoder::Cpu => (
                "libx264",
                vec!["-preset", "ultrafast", "-tune", "fastdecode", "-crf", "23", "-threads", "0"],
            ),
        }
    }

    fn encoder_name(&self) -> &'static str {
        match self {
            VideoEncoder::NvidiaNvEnc => "h264_nvenc",
            VideoEncoder::AmdAmf => "h264_amf",
            VideoEncoder::IntelQsv => "h264_qsv",
            VideoEncoder::Cpu => "libx264",
        }
    }
}

fn get_cached_transcode(input_path: &Path) -> Result<std::path::PathBuf, ()> {
    let cache_path = get_transcoded_cache_path(input_path);
    if cache_path.exists() {
        if let (Ok(src_meta), Ok(cache_meta)) =
            (fs::metadata(input_path), fs::metadata(&cache_path))
        {
            if cache_meta.len() < 1024 * 1024 {
                eprintln!("[Transcode] Removing tiny/empty cache file ({} bytes): {}", cache_meta.len(), cache_path.display());
                let _ = fs::remove_file(&cache_path);
                return Err(());
            }

            if let (Ok(src_modified), Ok(cache_modified)) =
                (src_meta.modified(), cache_meta.modified())
            {
                if cache_modified > src_modified {
                    // Sanity-check: the cache must be a parseable MP4. A partial
                    // transcode (FFmpeg killed mid-run) leaves a file that
                    // exists and is > 1MB but isn't a valid movie — the
                    // browser then fails with DEMUXER_ERROR_COULD_NOT_OPEN.
                    if !is_valid_cached_mp4(&cache_path) {
                        eprintln!("[Transcode] Removing corrupt/unreadable cache file: {}", cache_path.display());
                        let _ = fs::remove_file(&cache_path);
                        return Err(());
                    }
                    println!("[Transcode] Cache hit: {}", cache_path.display());
                    return Ok(cache_path);
                }
            }
        }
    }
    Err(())
}

/// Cheap MP4 validity check — reads the first 16 bytes and the last 4 bytes.
/// A valid MP4 has an `ftyp` box (bytes 4..=7 == "ftyp"). This catches
/// truncated files from killed transcode processes without the cost of
/// running ffprobe on every cache hit.
fn is_valid_cached_mp4(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return false; };

    let mut head = [0u8; 16];
    if f.read_exact(&mut head).is_err() { return false; }

    // Bytes 4..=7 must be "ftyp"
    if &head[4..8] != b"ftyp" {
        return false;
    }

    // The ftyp box size in the header must be small (< 1MB) and non-zero.
    let header_size = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
    if header_size == 0 || header_size > 1024 * 1024 {
        return false;
    }

    // File must be at least 16 bytes (the ftyp box is usually >= 24 bytes anyway).
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len < 16 { return false; }

    // Read the very last 4 bytes to make sure the file wasn't truncated mid-box.
    let mut tail = [0u8; 4];
    if f.seek(SeekFrom::End(-4)).is_err() { return false; }
    if f.read_exact(&mut tail).is_err() { return false; }

    true
}

fn get_video_dimensions(path: &Path) -> Option<(u32, u32)> {
    let ffprobe_path = get_ffprobe_path();

    let output = hidden_command(&ffprobe_path)
        .args(&[
            "-v", "quiet",
            "-print_format", "json",
            "-of", "json",
            "-show_streams",
            "-select_streams", "v:0",
            path.to_string_lossy().as_ref(),
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let json = serde_json::from_str::<serde_json::Value>(&json_str).ok()?;
    let stream = json.get("streams")?.as_array()?.first()?;
    let width = stream.get("width")?.as_u64()? as u32;
    let height = stream.get("height")?.as_u64()? as u32;
    Some((width, height))
}

fn get_video_total_frames(path: &Path) -> Option<u64> {
    let ffprobe_path = get_ffprobe_path();

    let output = hidden_command(&ffprobe_path)
        .args(&[
            "-v", "quiet",
            "-print_format", "json",
            "-of", "json",
            "-show_streams",
            "-select_streams", "v:0",
            path.to_string_lossy().as_ref(),
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let json = serde_json::from_str::<serde_json::Value>(&json_str).ok()?;
    let stream = json.get("streams")?.as_array()?.first()?;

    // Try nb_frames first (may not be available for all formats)
    if let Some(nb_frames) = stream.get("nb_frames") {
        if let Some(n) = nb_frames.as_u64() {
            if n > 0 {
                return Some(n);
            }
        }
        // nb_frames can be a string like "898" — try parse it.
        if let Some(s) = nb_frames.as_str() {
            if let Ok(n) = s.parse::<u64>() {
                if n > 0 {
                    return Some(n);
                }
            }
        }
    }

    // Fallback: calculate from duration and avg_frame_rate
    let duration = stream.get("duration")?.as_str()?.parse::<f64>().ok()?;
    let frame_rate_str = stream.get("avg_frame_rate")?.as_str()?;
    let parts: Vec<&str> = frame_rate_str.split('/').collect();
    if parts.len() == 2 {
        let num: f64 = parts[0].parse().ok()?;
        let den: f64 = parts[1].parse().ok()?;
        if den > 0.0 {
            let n = (duration * num / den).round() as u64;
            if n > 0 {
                return Some(n);
            }
        }
    }

    None
}

fn build_safe_scale_filter(width: u32, height: u32, max_dimension: u32) -> Option<String> {
    if width <= max_dimension && height <= max_dimension {
        return None;
    }

    let scale = (max_dimension as f64 / width as f64)
        .min(max_dimension as f64 / height as f64);
    let scaled_width = ((width as f64 * scale).floor() as u32).max(2) & !1;
    let scaled_height = ((height as f64 * scale).floor() as u32).max(2) & !1;

    Some(format!("scale={}:{}", scaled_width, scaled_height))
}

// =============================================================================
// TeeReader — splits a single Read source into a Read (for HTTP response) and
// a Write sink (for the cache file). The browser reads from this and gets
// streamed bytes; every chunk the browser pulls is also persisted to disk so
// the next time the user opens this file we can serve it from cache without
// re-running FFmpeg.
//
// This is the heart of the "stream while transcoding" behavior — without it
// the browser would only see the MP4 after FFmpeg finished the whole file.
// =============================================================================
struct TeeReader<R: Read> {
    inner: R,
    cache: Option<std::fs::File>,
}

impl<R: Read> TeeReader<R> {
    fn new(inner: R, cache: std::fs::File) -> Self {
        Self { inner, cache: Some(cache) }
    }
}

impl<R: Read> Read for TeeReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n > 0 {
            if let Some(ref mut f) = self.cache {
                // Best-effort write to cache. If the disk is full or the file
                // got deleted out from under us, swallow the error — the user
                // still gets a working stream; we just lose the cache.
                let _ = f.write_all(&buf[..n]);
            }
        }
        Ok(n)
    }
}

fn transcode_video_to_h264_with_encoder(
    input_path: &Path,
    request: &Request,
    encoder: VideoEncoder,
) -> ResponseBox {
    let cache_path = get_transcoded_cache_path(input_path);
    let ffmpeg_path = get_ffmpeg_path();
    let _ = ensure_transcode_cache_dir();

    let cache_key = get_progress_key(input_path);

    // Cache hit: serve immediately. Cache file is a complete MP4 with
    // accurate duration written by an earlier transcode.
    if let Ok(cached) = get_cached_transcode(input_path) {
        return serve_file_data(&cached, request);
    }

    // Atomically claim the transcode slot. If another worker is already
    // transcoding the same file, block this request until the peer finishes
    // (up to 5 minutes) and then serve the cached file.
    if !try_claim_transcode(&cache_key) {
        println!("[Transcode] Another worker is already transcoding {} — waiting", input_path.display());
        let wait_start = std::time::Instant::now();
        let max_wait = std::time::Duration::from_secs(300);
        while wait_start.elapsed() < max_wait {
            if let Some(progress) = get_transcode_progress(&cache_key) {
                if matches!(progress.status, TranscodeStatus::Complete) {
                    if let Ok(cached) = get_cached_transcode(input_path) {
                        return serve_file_data(&cached, request);
                    }
                }
                if let TranscodeStatus::Failed(_) = progress.status {
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        // Peer failed or timed out — try to claim for ourselves
        let _ = try_claim_transcode(&cache_key);
    }

    let (video_encoder, extra_args) = encoder.video_encoder_args();
    let dimensions = get_video_dimensions(input_path);
    let max_dimension = match encoder {
        VideoEncoder::NvidiaNvEnc => 4096,
        VideoEncoder::AmdAmf | VideoEncoder::IntelQsv => 4096,
        VideoEncoder::Cpu => 3840,
    };

    let scale_filter = dimensions.and_then(|(width, height)| {
        let filter = build_safe_scale_filter(width, height, max_dimension);
        if let Some(ref value) = filter {
            println!(
                "[Transcode] Downscaling {} from {}x{} to fit max {} for {} using {}",
                input_path.display(),
                width,
                height,
                max_dimension,
                encoder.encoder_name(),
                value
            );
        }
        filter
    });

    // Get total frames for progress calculation
    let total_frames = get_video_total_frames(input_path).unwrap_or(0);
    println!("[Transcode] total_frames = {} for {}", total_frames, input_path.display());

    // Progress file for FFmpeg -progress output
    let progress_file_path = std::env::temp_dir().join(format!("gk_transcode_progress_{}.txt", cache_key));

    // Set initial progress state
    set_transcode_progress(&cache_key, TranscodeProgress {
        percent: 0.0,
        current_frame: 0,
        total_frames,
        status: TranscodeStatus::Encoding,
        cache_key: cache_key.clone(),
    });

    // Build FFmpeg arguments for a REGULAR MP4 written directly to the cache
    // file. We deliberately switched away from fragmented-MP4 streaming because
    // the browser computed the wrong duration from the first ~8s of fragments
    // and would refuse to seek past 251/898 frames even after the full file
    // was on disk. The new plan:
    //
    //   1. Transcode the entire video into cache_path as a regular MP4
    //      with `+faststart` (moov box at the front, accurate duration).
    //   2. Block the HTTP response until the file is complete, then
    //      serve_file_data() returns the whole MP4 with the correct
    //      Content-Length. The browser sees the real duration from byte 0.
    //   3. Progress is exposed through /transcode/progress, polled by the
    //      frontend for the progress bar.
    //
    // `+faststart` is critical here: it tells FFmpeg to rewrite the moov
    // box to the front of the file on exit, so the very first bytes
    // already contain codec params + duration + seek tables. The browser
    // can therefore play the file the moment the response starts streaming.
    let mut args = vec![
        "-y".to_string(),
        "-i".to_string(),
        input_path.to_string_lossy().to_string(),
    ];

    // ALWAYS apply format conversion to 8-bit, even when no scaling is needed.
    // ProRes 422 10-bit (yuv422p10le) cannot be encoded by libx264 directly.
    // Adding "format=yuv420p" as the last step ensures FFmpeg converts to 8-bit
    // BEFORE encoding, avoiding EINVAL crashes with high bit-depth inputs.
    let filter_chain = if let Some(filter) = scale_filter {
        format!("{},format=yuv420p", filter)
    } else {
        "format=yuv420p".to_string()
    };
    args.push("-vf".to_string());
    args.push(filter_chain);

    args.extend([
        "-c:v".to_string(),
        video_encoder.to_string(),
    ]);
    for arg in &extra_args {
        args.push(arg.to_string());
    }
    args.extend([
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "128k".to_string(),
        // -movflags +faststart moves the moov box to the front of the file
        // so the browser sees accurate codec params and duration as soon as
        // the response body starts streaming.
        "-movflags".to_string(),
        "+faststart".to_string(),
        "-progress".to_string(),
        progress_file_path.to_string_lossy().to_string(),
        // Output to the cache file directly. The HTTP response blocks until
        // FFmpeg exits and the file is fully written, then we serve it.
        cache_path.to_string_lossy().to_string(),
    ]);

    println!("[Transcode] Transcoding full MP4 to cache for: {}", input_path.display());

    // Capture stderr to a temp file so we can print it on error.
    let stderr_path = std::env::temp_dir().join(format!("gk_ffmpeg_stderr_{}.txt", cache_key));

    // Spawn FFmpeg as a child we wait on inside this HTTP request. The HTTP
    // response is held until FFmpeg exits so we don't serve a partial file.
    // We block inside a dedicated thread because tiny_http handlers must
    // return quickly to free its worker pool.
    let _ = std::fs::write(
        &progress_file_path,
        format!("progress=start\ncache_key={}\n", cache_key)
    );

    let ffmpeg_path_str = ffmpeg_path.clone();
    let args_for_thread = args.clone();
    let cache_key_for_thread = cache_key.clone();
    let cache_path_for_thread = cache_path.clone();

    eprintln!(
        "[Transcode] FFmpeg argv (cache_key={}): {} {:?}",
        cache_key_for_thread,
        ffmpeg_path_str,
        args_for_thread
    );

    // Spawn progress monitor thread (updates /transcode/progress endpoint).
    let _progress_thread = std::thread::spawn({
        let progress_cache_key = cache_key.clone();
        let progress_total_frames = total_frames;
        move || {
            let mut last_frame: u64 = 0;
            let sleep_duration = std::time::Duration::from_millis(300);

            loop {
                std::thread::sleep(sleep_duration);

                let pf = std::env::temp_dir().join(format!("gk_transcode_progress_{}.txt", progress_cache_key));
                if !pf.exists() {
                    break;
                }

                if let Some((current_frame, _)) = parse_ffmpeg_progress(&pf) {
                    if current_frame != last_frame {
                        last_frame = current_frame;
                        let percent = if progress_total_frames > 0 {
                            (current_frame as f64 / progress_total_frames as f64 * 100.0).min(99.0)
                        } else {
                            0.0
                        };

                        set_transcode_progress(&progress_cache_key, TranscodeProgress {
                            percent,
                            current_frame,
                            total_frames: progress_total_frames,
                            status: TranscodeStatus::Encoding,
                            cache_key: progress_cache_key.clone(),
                        });
                    }
                }
            }

            let pf = std::env::temp_dir().join(format!("gk_transcode_progress_{}.txt", progress_cache_key));
            let _ = std::fs::remove_file(&pf);
        }
    });

    // We block the HTTP request on FFmpeg. tiny_http spawns a thread per
    // request so this is safe but ties up a worker for the transcode
    // duration. If the client disconnects, FFmpeg keeps writing to the
    // cache file — which is fine, the cache is the whole point.
    let stderr_file = match std::fs::File::create(&stderr_path) {
        Ok(f) => f,
        Err(_) => std::fs::File::create("/dev/null").unwrap_or_else(|_| std::fs::File::create(&stderr_path).unwrap()),
    };
    let child_status = hidden_command(std::path::Path::new(&ffmpeg_path_str))
        .args(&args_for_thread)
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file))
        .status();

    match child_status {
        Ok(status) if status.success() => {
            // Verify the cache file is a valid MP4 before serving it.
            if cache_path_for_thread.exists() && is_valid_cached_mp4(&cache_path_for_thread) {
                set_transcode_progress(&cache_key_for_thread, TranscodeProgress {
                    percent: 100.0,
                    current_frame: 0,
                    total_frames: 0,
                    status: TranscodeStatus::Complete,
                    cache_key: cache_key_for_thread.clone(),
                });
                println!("[Transcode] Cache complete, serving file: {}", cache_path_for_thread.display());
                let _ = std::fs::remove_file(&stderr_path);
                release_transcode(&cache_key_for_thread);
                serve_file_data(&cache_path_for_thread, request)
            } else {
                set_transcode_progress(&cache_key_for_thread, TranscodeProgress {
                    percent: 0.0,
                    current_frame: 0,
                    total_frames: 0,
                    status: TranscodeStatus::Failed("incomplete cache file".to_string()),
                    cache_key: cache_key_for_thread.clone(),
                });
                let _ = std::fs::remove_file(&cache_path_for_thread);
                let _ = std::fs::remove_file(&stderr_path);
                release_transcode(&cache_key_for_thread);
                json_response(serde_json::json!({
                    "success": false,
                    "error": "transcode produced an invalid cache file"
                })).boxed()
            }
        }
        Ok(status) => {
            if let Ok(stderr_content) = std::fs::read_to_string(&stderr_path) {
                if !stderr_content.trim().is_empty() {
                    eprintln!(
                        "[Transcode] FFmpeg stderr for {}:\n{}",
                        cache_key_for_thread,
                        stderr_content.trim()
                    );
                }
            }
            eprintln!(
                "[Transcode] FFmpeg exited with status {:?} for {}",
                status.code(),
                cache_key_for_thread
            );
            set_transcode_progress(&cache_key_for_thread, TranscodeProgress {
                percent: 0.0,
                current_frame: 0,
                total_frames: 0,
                status: TranscodeStatus::Failed(format!("ffmpeg exit {:?}", status.code())),
                cache_key: cache_key_for_thread.clone(),
            });
            let _ = std::fs::remove_file(&cache_path_for_thread);
            let _ = std::fs::remove_file(&stderr_path);
            release_transcode(&cache_key_for_thread);
            json_response(serde_json::json!({
                "success": false,
                "error": format!("FFmpeg exited with {:?}", status.code())
            })).boxed()
        }
        Err(e) => {
            eprintln!("[Transcode] FFmpeg spawn failed for {}: {}", cache_key_for_thread, e);
            set_transcode_progress(&cache_key_for_thread, TranscodeProgress {
                percent: 0.0,
                current_frame: 0,
                total_frames: 0,
                status: TranscodeStatus::Failed(format!("spawn failed: {}", e)),
                cache_key: cache_key_for_thread.clone(),
            });
            let _ = std::fs::remove_file(&cache_path_for_thread);
            let _ = std::fs::remove_file(&stderr_path);
            release_transcode(&cache_key_for_thread);
            json_response(serde_json::json!({
                "success": false,
                "error": format!("FFmpeg spawn failed: {}", e)
            })).boxed()
        }
    }
}

// Returned to the frontend when a transcode is already running for the
// same file (claim failed). Frontend keeps polling /transcode/progress
// and reloads the URL once it sees `complete`.
// Note: previous code returned 202 here, but the browser's <video> element
// can't interpret a 202 response as a video stream. We now block the
// request on the existing peer instead and serve the cache file when it's
// done.

// Spawns the background thread that watches a transcoding FFmpeg process,
// updates progress, and cleans up the cancel-map entry when it exits.
// Extracted from transcode_video_to_h264_with_encoder to keep that function
// readable.
fn spawn_transcode_wait_thread(
    cache_key: String,
    cache_path: std::path::PathBuf,
    stderr_path: Option<std::path::PathBuf>,
) {
    std::thread::spawn(move || {
        // Poll try_wait() so /transcode/cancel can grab the &mut Child out
        // of the cancel map, kill it, and we'll observe try_wait() return
        // Some(_). This is the standard "killable child" pattern in Rust
        // when you can't move the Child out of a Mutex to call .wait()
        // directly.
        let exit_status = loop {
            let still_running = {
                if let Ok(mut map) = get_transcode_children().lock() {
                    if let Some(c) = map.get_mut(&cache_key) {
                        match c.try_wait() {
                            Ok(Some(status)) => break Some(status),
                            Ok(None) => true,
                            Err(_) => break None,
                        }
                    } else {
                        // Child was removed from the map — cancel() took it
                        // out and killed it. We can't observe the exit
                        // status; treat as cancelled.
                        break None;
                    }
                } else {
                    true
                }
            };

            if !still_running {
                break None;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        };

        // Clean up the map entry now that the process has exited.
        if let Ok(mut map) = get_transcode_children().lock() {
            map.remove(&cache_key);
        }

        match exit_status {
            Some(status) if status.success() => {
                // Only mark Complete if the cache file is actually a valid
                // fragmented MP4. If the user cancelled mid-write, the
                // tail of the cache may be corrupt and the next request
                // would refuse to play it.
                if cache_path.exists() && is_valid_cached_mp4(&cache_path) {
                    set_transcode_progress(&cache_key, TranscodeProgress {
                        percent: 100.0,
                        current_frame: 0,
                        total_frames: 0,
                        status: TranscodeStatus::Complete,
                        cache_key: cache_key.clone(),
                    });
                } else {
                    set_transcode_progress(&cache_key, TranscodeProgress {
                        percent: 0.0,
                        current_frame: 0,
                        total_frames: 0,
                        status: TranscodeStatus::Failed("incomplete cache file".to_string()),
                        cache_key: cache_key.clone(),
                    });
                    let _ = std::fs::remove_file(&cache_path);
                }
            }
            Some(status) => {
                // Print FFmpeg stderr if available — critical for diagnosing EINVAL
                // and other FFmpeg failures.
                if let Some(ref sp) = stderr_path {
                    if let Ok(stderr_content) = std::fs::read_to_string(sp) {
                        if !stderr_content.trim().is_empty() {
                            eprintln!(
                                "[Transcode] FFmpeg stderr for {}:\n{}",
                                cache_key,
                                stderr_content.trim()
                            );
                        }
                    }
                    let _ = std::fs::remove_file(sp);
                }
                eprintln!(
                    "[Transcode] FFmpeg exited with non-success status {:?} for {}",
                    status.code(),
                    cache_key
                );
                set_transcode_progress(&cache_key, TranscodeProgress {
                    percent: 0.0,
                    current_frame: 0,
                    total_frames: 0,
                    status: TranscodeStatus::Failed(format!("ffmpeg exit {:?}", status.code())),
                    cache_key: cache_key.clone(),
                });
                let _ = std::fs::remove_file(&cache_path);
            }
            None => {
                // No exit status — most likely the child was killed by
                // /transcode/cancel. Mark as Failed so the next request
                // re-transcodes from scratch.
                eprintln!("[Transcode] FFmpeg cancelled or wait failed for {}", cache_key);
                set_transcode_progress(&cache_key, TranscodeProgress {
                    percent: 0.0,
                    current_frame: 0,
                    total_frames: 0,
                    status: TranscodeStatus::Failed("cancelled".to_string()),
                    cache_key: cache_key.clone(),
                });
                let _ = std::fs::remove_file(&cache_path);
            }
        }
        release_transcode(&cache_key);
    });
}

// Fallback path: stream FFmpeg's stdout to the browser WITHOUT writing to a
// cache file. Used when the cache file can't be created (permission denied,
// disk full, etc.). The browser still gets a working stream; we just don't
// get to skip the transcode next time.
fn spawn_streaming_ffmpeg_no_cache(
    ffmpeg_path: String,
    args: Vec<String>,
    cache_key: String,
    cache_path: std::path::PathBuf,
    _request: &Request,
) -> ResponseBox {
    // Pre-delete the cache file so is_valid_cached_mp4 doesn't accidentally
    // pick up a stale one from a previous run.
    let _ = std::fs::remove_file(&cache_path);

    let mut child = match hidden_command(std::path::Path::new(&ffmpeg_path))
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Transcode] FFmpeg spawn failed (no-cache path) for {}: {}", cache_key, e);
            set_transcode_progress(&cache_key, TranscodeProgress {
                percent: 0.0,
                current_frame: 0,
                total_frames: 0,
                status: TranscodeStatus::Failed(format!("spawn failed: {}", e)),
                cache_key: cache_key.clone(),
            });
            release_transcode(&cache_key);
            return json_response(serde_json::json!({
                "success": false,
                "error": format!("FFmpeg spawn failed: {}", e)
            })).boxed();
        }
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            eprintln!("[Transcode] Failed to take FFmpeg stdout for {}", cache_key);
            release_transcode(&cache_key);
            return json_response(serde_json::json!({
                "success": false,
                "error": "FFmpeg stdout unavailable"
            })).boxed();
        }
    };

    if let Ok(mut map) = get_transcode_children().lock() {
        map.insert(cache_key.clone(), child);
    }

    let response = streaming_video_response(stdout);

    // No cache file to clean up in the wait thread; pass None for stderr_path
    // since we used Stdio::null() in the spawn above.
    spawn_transcode_wait_thread(cache_key, cache_path, None);
    response.boxed()
}

fn transcode_video_to_h264(
    input_path: &Path,
    request: &Request,
) -> ResponseBox {
    let cache_path = get_transcoded_cache_path(input_path);

    if let Ok(cached) = get_cached_transcode(input_path) {
        return serve_file_data(&cached, request);
    }

    println!("[Transcode] Starting transcode for: {}", input_path.display());

    // Wait briefly (up to ~2 seconds) for a background FFmpeg — started by
    // another request — to produce a cache file. The /transcode/progress
    // endpoint already runs in parallel, so we only need a short wait here.
    //
    // CRITICAL: we use the PROGRESS key, not the cache file path. Otherwise
    // get_transcode_progress always misses and we fall through to a sync
    // transcode after the wait — which blocks the HTTP request for the full
    // transcode and leaves the frontend polling in the dark.
    let poll_start = std::time::Instant::now();
    let max_poll = std::time::Duration::from_secs(2);
    let progress_key = get_progress_key(input_path);
    while poll_start.elapsed() < max_poll {
        // Cache file written and non-empty? Serve it.
        if let Ok(cached) = get_cached_transcode(input_path) {
            println!("[Transcode] Cache became available after {:?}", poll_start.elapsed());
            return serve_file_data(&cached, request);
        }
        // Check if a background FFmpeg is already running for this file.
        // If yes, we wait for it. If no, we break out and run our own.
        if let Some(progress) = get_transcode_progress(&progress_key) {
            match progress.status {
                TranscodeStatus::Failed(_) => {
                    eprintln!("[Transcode] Background FFmpeg failed for {}", input_path.display());
                    break;
                }
                TranscodeStatus::Complete => {
                    if let Ok(cached) = get_cached_transcode(input_path) {
                        return serve_file_data(&cached, request);
                    }
                    break;
                }
                TranscodeStatus::Encoding => {
                    // Background transcode is running — keep waiting.
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    continue;
                }
                TranscodeStatus::Idle => {
                    // No background transcode in flight — start one ourselves.
                    break;
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    // Check if input is ProRes - hardware encoders can't decode ProRes, must use CPU
    let ffprobe_path = get_ffprobe_path();
    let output = hidden_command(&ffprobe_path)
        .args(&["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "v:0", input_path.to_string_lossy().as_ref()])
        .output();

    let is_prores = output.as_ref()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let json_str = String::from_utf8_lossy(&o.stdout);
            serde_json::from_str::<serde_json::Value>(&json_str).ok()
        })
        .and_then(|json| {
            json.get("streams")?
                .as_array()?
                .first()?
                .get("codec_name")?
                .as_str()
                .map(|s| s.to_string())
        })
        .map(|codec| codec == "prores")
        .unwrap_or(false);

    // ProRes must use CPU encoder - NVENC/AMF/QSV can't decode ProRes
    let preferred_encoder = if is_prores {
        println!("[Transcode] Detected ProRes codec - forcing CPU encoder (libx264)");
        VideoEncoder::Cpu
    } else {
        get_best_video_encoder(&get_ffmpeg_path())
    };

    transcode_video_to_h264_with_encoder(input_path, request, preferred_encoder)
}

fn handle_thumbnail_request(file_path: &str, max_size: usize) -> Response<std::io::Cursor<Vec<u8>>> {
    let path = Path::new(file_path);

    if !path.exists() {
        return json_response(serde_json::json!({
            "success": false,
            "error": "File not found"
        }));
    }

    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let image_exts = ["png", "jpg", "jpeg", "gif", "bmp", "webp", "tiff", "tif", "ico", "exr", "hdr", "tga", "af"];

    // SVG: serve directly as SVG XML
    if ext == "svg" {
        match fs::read(path) {
            Ok(data) => {
                return Response::from_data(data)
                    .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/svg+xml; charset=utf-8"[..]).unwrap())
                    .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
            }
            Err(e) => {
                return json_response(serde_json::json!({"success": false, "error": e.to_string()}));
            }
        }
    }

    // PSD: fast 4-tier pipeline using fast_psd engine
    if ext == "psd" {
        match fs::read(path) {
            Ok(bytes) => {
                // Check file size: skip heavy parsing for files > 500MB
                if bytes.len() > 500 * 1024 * 1024 {
                    // For huge files, only try Windows Shell (fast)
                    if let Some(png_data) = extract_thumbnail_via_shell(&path.to_string_lossy(), max_size, false) {
                        return Response::from_data(png_data)
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
                    }
                    return json_response(serde_json::json!({
                        "success": false,
                        "error": "PSD file is too large for preview"
                    }));
                }

                if let Some(result) = fast_psd::extract_psd_thumbnail(&bytes, max_size) {
                    return Response::from_data(result.png_data)
                        .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                        .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
                }

                // Last resort: Windows Shell thumbnail
                if let Some(png_data) = extract_thumbnail_via_shell(&path.to_string_lossy(), max_size, false) {
                    return Response::from_data(png_data)
                        .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                        .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
                }

                return json_response(serde_json::json!({
                    "success": false,
                    "error": "Could not extract PSD thumbnail"
                }));
            }
            Err(e) => {
                return json_response(serde_json::json!({"success": false, "error": e.to_string()}));
            }
        }
    }

    // PSB: Large Adobe document - same fast pipeline
    if ext == "psb" {
        match fs::read(path) {
            Ok(bytes) => {
                // For huge files, only try Windows Shell
                if bytes.len() > 500 * 1024 * 1024 {
                    if let Some(png_data) = extract_thumbnail_via_shell(&path.to_string_lossy(), max_size, false) {
                        return Response::from_data(png_data)
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
                    }
                    return json_response(serde_json::json!({
                        "success": false,
                        "error": "PSB file is too large for preview"
                    }));
                }

                if let Some(result) = fast_psd::extract_psd_thumbnail(&bytes, max_size) {
                    return Response::from_data(result.png_data)
                        .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                        .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
                }

                if let Some(png_data) = extract_thumbnail_via_shell(&path.to_string_lossy(), max_size, false) {
                    return Response::from_data(png_data)
                        .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                        .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
                }

                return json_response(serde_json::json!({
                    "success": false,
                    "error": "Could not extract PSB thumbnail"
                }));
            }
            Err(e) => {
                return json_response(serde_json::json!({"success": false, "error": e.to_string()}));
            }
        }
    }

    // AI / EPS: Adobe Illustrator / PostScript files
    // Strategy: Windows Shell returns the official Adobe Illustrator icon
    // (transparent background, clean orange logo) which is the ideal grid thumbnail.
    // Other tiers render the actual file content (which can have any background)
    // — they're kept as fallbacks when Shell has no cached thumbnail yet.
    if ext == "ai" || ext == "eps" {
        // Tier 1: Windows Shell thumbnail (official Adobe AI icon, transparent bg)
        if let Some(png_data) = extract_thumbnail_via_shell(&path.to_string_lossy(), max_size, false) {
            return Response::from_data(png_data)
                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
        }

        // Tier 2: PyMuPDF via Python script (renders file content — may have any bg)
        if let Some(png_data) = render_ai_with_mupdf(&path.to_string_lossy(), max_size) {
            return Response::from_data(png_data)
                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
        }

        // Tier 3: Rust embedded JPEG scan (file's own preview — may have any bg)
        if let Ok(bytes) = fs::read(path) {
            if let Some(jpeg_data) = extract_embedded_jpeg(&bytes, max_size) {
                if let Ok(img) = image::load_from_memory(&jpeg_data) {
                    let (thumb_w, thumb_h) = calculate_thumb_dims(img.width(), img.height(), max_size);
                    let thumb = image::imageops::resize(&img.to_rgb8(), thumb_w, thumb_h, image::imageops::FilterType::Lanczos3);
                    let mut buffer = Vec::new();
                    let mut cursor = std::io::Cursor::new(&mut buffer);
                    if thumb.write_to(&mut cursor, image::ImageFormat::Png).is_ok() {
                        return Response::from_data(buffer)
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
                    }
                }
            }
        }

        // Tier 4: Poppler pdftoppm (bundled) — fallback for files without embedded JPEG
        if let Some(png_data) = render_ai_with_pdftoppm(&path.to_string_lossy(), max_size) {
            return Response::from_data(png_data)
                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
        }

        // Tier 5: Ghostscript (compatibility for old AI/EPS formats)
        let gs_paths = [
            Path::new("C:/Program Files/gs/gswin64c.exe"),
            Path::new("gswin64c.exe"),
            Path::new("gs"),
        ];

        let gs_path = gs_paths.iter().find(|p| p.exists()).map(|p| p.to_string_lossy().to_string());

        if let Some(gs_exe) = gs_path {
            let temp_dir = std::env::temp_dir();
            let output_path = temp_dir.join(format!("gk_ai_thumb_{}.png", std::process::id()));

            let gs_result = hidden_command(&gs_exe)
                .args(&[
                    "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
                    "-sDEVICE=png16m",
                    &format!("-r{}", max_size * 2),
                    &format!("-sOutputFile={}", output_path.to_string_lossy()),
                    file_path,
                ])
                .output();

            if let Ok(output) = gs_result {
                if output.status.success() && output_path.exists() {
                    if let Ok(img) = image::open(&output_path) {
                        let _ = fs::remove_file(&output_path);
                        let (thumb_w, thumb_h) = calculate_thumb_dims(img.width(), img.height(), max_size);
                        let thumb = image::imageops::resize(&img.to_rgb8(), thumb_w, thumb_h, image::imageops::FilterType::Lanczos3);
                        let mut buffer = Vec::new();
                        let mut cursor = std::io::Cursor::new(&mut buffer);
                        if thumb.write_to(&mut cursor, image::ImageFormat::Png).is_ok() {
                            return Response::from_data(buffer)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
                        }
                    }
                }
            }
        }

        return json_response(serde_json::json!({
            "success": false,
            "error": "Could not generate AI/EPS thumbnail. Try exporting as PNG or PDF.",
            "extension": ext,
        }));
    }

        // Standard image formats - use fast image engine with EXIF thumbnails, scaled decode
    if image_exts.contains(&ext.as_str()) {
        // Affinity .af: use Windows Shell thumbnail (Affinity Photo 2 caches thumbnails)
        if ext == "af" {
            if let Some(png_data) = extract_thumbnail_via_shell(file_path, max_size, true) {
                return Response::from_data(png_data)
                    .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                    .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
            }
            if let Some(png_data) = extract_thumbnail_via_shell(file_path, max_size, false) {
                return Response::from_data(png_data)
                    .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                    .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
            }
            return json_response(serde_json::json!({"success": false, "error": "Failed to decode .af"}));
        }

        // TIFF: use ffmpeg to convert directly to PNG — handles all TIFF variants
        // (grayscale, 16-bit, CMYK, LAB, etc.) without any image crate complexity.
        if ext == "tif" || ext == "tiff" {
            if let Some(png_data) = render_tif_with_ffmpeg(file_path, max_size) {
                return Response::from_data(png_data)
                    .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                    .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
            }
            // Fallback: Windows Shell thumbnail
            if let Some(png_data) = extract_thumbnail_via_shell(file_path, max_size, false) {
                return Response::from_data(png_data)
                    .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                    .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
            }
            return json_response(serde_json::json!({"success": false, "error": "Failed to decode TIFF"}));
        }

        // Other standard images: fast_image (EXIF thumbnails) → raw bytes fallback
        if let Some(result) = fast_image::extract_thumbnail(path, max_size) {
            return Response::from_data(result.png_data)
                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
        }

        // Fallback: serve raw file bytes directly. Browser can decode PNG/JPEG/WebP natively.
        if let Ok(raw_bytes) = fs::read(path) {
            let mime = get_mime_type(&ext);
            let b64 = STANDARD.encode(&raw_bytes);
            return json_response(serde_json::json!({
                "success": true,
                "data_url": format!("data:{};base64,{}", mime, b64),
                "fallback": true
            }));
        }
        return json_response(serde_json::json!({"success": false, "error": "Failed to decode image"}));
    }

    // Pureref (.pur) - use Windows Shell thumbnail (same as Explorer preview)
    if ext == "pur" {
        if let Some(png_data) = extract_thumbnail_via_shell(file_path, max_size, false) {
            return Response::from_data(png_data)
                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap())
                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
        }
        return json_response(serde_json::json!({
            "success": false,
            "error": "Could not extract Pureref thumbnail"
        }));
    }

    // PSB / AI / EPS / other unsupported formats
    json_response(serde_json::json!({
        "success": false,
        "error": "Thumbnail not available for this file type",
        "extension": ext
    }))
}

fn get_mime_type(ext: &str) -> String {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tga" => "image/x-tga",
        "tiff" | "tif" => "image/tiff",
        "af" => "image/x-affinity",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "obj" => "text/plain",
        "fbx" => "application/octet-stream",
        "stl" => "application/sla",
        "exr" => "image/x-exr",
        "psd" => "image/vnd.adobe.photoshop",
        "ai" => "application/postscript",
        "pur" => "application/x-pureref",
        _ => "application/octet-stream",
    }.to_string()
}

// ============================================================
// File System Commands (for compatibility)
// ============================================================

// Read a directory and return all entries
#[command]
fn read_directory(path: String, show_hidden: bool) -> Result<DirListing, String> {
    // Handle virtual paths
    if path == "thispc://" {
        return read_thispc_directory();
    }
    if path == "recyclebin://" {
        return read_recyclebin_directory();
    }
    if path == "network://" {
        return read_network_directory();
    }

    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !p.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut entries = Vec::new();

    match fs::read_dir(p) {
        Ok(dir) => {
            for entry in dir.flatten() {
                let file_name = entry.file_name().to_string_lossy().to_string();
                let file_path = entry.path().to_string_lossy().to_string();
                let metadata = entry.metadata().ok();

                let is_file = metadata.as_ref().map(|m| m.is_file()).unwrap_or(false);
                let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

                let modified = metadata.as_ref()
                    .and_then(|m| m.modified().ok())
                    .map(|t| {
                        let datetime: chrono::DateTime<chrono::Local> = t.into();
                        datetime.format("%Y-%m-%d %H:%M:%S").to_string()
                    });

                let created = metadata.as_ref()
                    .and_then(|m| m.created().ok())
                    .map(|t| {
                        let datetime: chrono::DateTime<chrono::Local> = t.into();
                        datetime.format("%Y-%m-%d %H:%M:%S").to_string()
                    });

                let extension = if is_file {
                    Path::new(&file_name).extension().map(|e| e.to_string_lossy().to_string())
                } else {
                    None
                };

                // Always hide protected system items (FILE_ATTRIBUTE_SYSTEM
                // files and reparse points like "Documents and Settings").
                // These are NEVER shown in Windows Explorer, even with
                // "Show hidden files" enabled. We mirror this behavior.
                if is_protected_system_item(&entry.path()) {
                    continue;
                }

                // Check if this is a hidden file/directory
                let is_hidden = is_hidden_file(&entry.path());

                // Skip hidden items if showHidden is false
                if !show_hidden && is_hidden {
                    continue;
                }

                entries.push(FileEntry {
                    name: file_name,
                    path: file_path,
                    is_file,
                    is_dir,
                    size,
                    modified,
                    created,
                    extension,
                    is_hidden,
                });
            }
        }
        Err(e) => return Err(format!("Failed to read directory: {}", e)),
    }

    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(DirListing { entries, path: path.clone() })
}

// Read This PC - lists all drives
fn read_thispc_directory() -> Result<DirListing, String> {
    let mut entries = Vec::new();
    
    // Get all drives using PowerShell
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", 
               "Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Name"])
        .output();
    
    if let Ok(output) = output {
        if output.status.success() {
            let output_str = String::from_utf8_lossy(&output.stdout);
            for line in output_str.lines() {
                let drive_letter = line.trim();
                if drive_letter.len() == 1 && drive_letter.chars().next().unwrap().is_ascii_alphabetic() {
                    let drive_path = format!("{}:\\", drive_letter);
                    entries.push(FileEntry {
                        name: format!("{}: Drive", drive_letter.to_uppercase()),
                        path: drive_path,
                        is_dir: true,
                        is_file: false,
                        size: 0,
                        modified: None,
                        created: None,
                        extension: None,
                        is_hidden: false,
                    });
                }
            }
        }
    }
    
    // Sort: directories first, then by name
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    
    Ok(DirListing { entries, path: "thispc://".to_string() })
}

// Read Recycle Bin - lists deleted files
fn read_recyclebin_directory() -> Result<DirListing, String> {
    // Use the native Rust implementation (IEnumShellItems + IShellItem2::
    // GetString with the Displaced/OriginalLocation property key). This is
    // the same approach the `trash` crate uses; PowerShell's Shell.Application
    // returns incomplete paths for items (only the $Rxxx segment, not the
    // full parsing name with filename), which made cut/paste matching fail.
    //
    // We store the shell's parsing name (e.g. `C:\$Recycle.Bin\<SID>\$Rxxx.ext`)
    // directly in `path`. The frontend treats `path` as an opaque id; for
    // display it uses `name` (the original filename). For cut/paste the
    // $Recycle.Bin substring in the path lets us detect recycle bin items,
    // and the synthetic `<parent>\<name>` derivation gives us the
    // `original_parent` we need to feed back to the restore command.
    let entries = match crate::recycle_bin::list_recycle_bin_entries() {
        Ok(items) => items
            .into_iter()
            .map(|e| {
                let extension = std::path::Path::new(&e.name)
                    .extension()
                    .map(|x| x.to_string_lossy().to_string());
                FileEntry {
                    name: e.name,
                    path: e.parsing_name,
                    is_dir: false,
                    is_file: true,
                    size: 0,
                    modified: None,
                    created: None,
                    extension,
                    is_hidden: false,
                }
            })
            .collect(),
        Err(e) => {
            eprintln!("[read_recyclebin_directory] native list failed: {e}");
            Vec::new()
        }
    };

    let mut entries = entries;
    // Sort by name
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(DirListing { entries, path: "recyclebin://".to_string() })
}

// Read Network - placeholder for now
fn read_network_directory() -> Result<DirListing, String> {
    let entries = Vec::new();
    Ok(DirListing { entries, path: "network://".to_string() })
}

#[command]
fn read_directory_recursive(path: String, max_depth: Option<usize>) -> Result<Vec<FileEntry>, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !p.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let depth = max_depth.unwrap_or(64);
    let mut entries = Vec::new();

    for entry in WalkDir::new(p)
        .max_depth(depth)
        .into_iter()
        .filter_map(|e| e.ok())
        .skip(1)
    {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') {
            continue;
        }

        // Hide Windows directory junctions (reparse points) such as
        // "Documents and Settings", "My Music", "My Pictures", etc.
        // These are ALWAYS hidden in Windows Explorer, regardless of
        // any settings. We mirror this behavior.
        if entry.file_type().is_dir() && is_reparse_point(entry.path()) {
            continue;
        }

        let file_path = entry.path().to_string_lossy().to_string();
        let metadata = entry.metadata().ok();
        let is_file = entry.file_type().is_file();
        let is_dir = entry.file_type().is_dir();
        let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified = metadata.as_ref()
            .and_then(|m| m.modified().ok())
            .map(|t| {
                let datetime: chrono::DateTime<chrono::Local> = t.into();
                datetime.format("%Y-%m-%d %H:%M:%S").to_string()
            });
        let created = metadata.as_ref()
            .and_then(|m| m.created().ok())
            .map(|t| {
                let datetime: chrono::DateTime<chrono::Local> = t.into();
                datetime.format("%Y-%m-%d %H:%M:%S").to_string()
            });
        let extension = if is_file {
            entry.path().extension().map(|e| e.to_string_lossy().to_string())
        } else {
            None
        };

        // Check if this is a hidden file/directory
        let is_hidden = is_hidden_file(&entry.path());

        entries.push(FileEntry {
            name: file_name,
            path: file_path,
            is_file,
            is_dir,
            size,
            modified,
            created,
            extension,
            is_hidden,
        });
    }

    Ok(entries)
}

#[derive(Debug, Serialize)]
pub struct TextPreviewResult {
    pub content: String,
    pub encoding: String,
    pub truncated: bool,
    pub line_count: usize,
    pub is_binary: bool,
    pub error: Option<String>,
}

fn decode_utf16_bytes(bytes: &[u8], little_endian: bool) -> String {
    let mut units = Vec::with_capacity(bytes.len() / 2);
    let mut chunks = bytes.chunks_exact(2);
    for chunk in &mut chunks {
        let unit = if little_endian {
            u16::from_le_bytes([chunk[0], chunk[1]])
        } else {
            u16::from_be_bytes([chunk[0], chunk[1]])
        };
        units.push(unit);
    }
    String::from_utf16_lossy(&units)
}

fn looks_like_utf16(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 4 {
        return None;
    }

    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Some("utf-16-le");
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Some("utf-16-be");
    }

    let sample_len = bytes.len().min(512);
    let mut even_zero = 0usize;
    let mut odd_zero = 0usize;
    let mut pairs = 0usize;

    for pair in bytes[..sample_len].chunks_exact(2) {
        pairs += 1;
        if pair[0] == 0 {
            even_zero += 1;
        }
        if pair[1] == 0 {
            odd_zero += 1;
        }
    }

    if pairs == 0 {
        return None;
    }

    let even_ratio = even_zero as f32 / pairs as f32;
    let odd_ratio = odd_zero as f32 / pairs as f32;

    if odd_ratio > 0.3 && even_ratio < 0.1 {
        Some("utf-16-le")
    } else if even_ratio > 0.3 && odd_ratio < 0.1 {
        Some("utf-16-be")
    } else {
        None
    }
}

fn is_likely_binary(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }

    if looks_like_utf16(bytes).is_some() {
        return false;
    }

    let sample = &bytes[..bytes.len().min(4096)];
    let null_count = sample.iter().filter(|&&b| b == 0).count();
    if (null_count as f32 / sample.len() as f32) > 0.01 {
        return true;
    }

    let suspicious = sample.iter().filter(|&&b| {
        !(b == b'\n' || b == b'\r' || b == b'\t' || (0x20..=0x7E).contains(&b) || b >= 0x80)
    }).count();

    (suspicious as f32 / sample.len() as f32) > 0.2
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
struct FileFingerprint {
    mtime_ms: i64,
    size: u64,
}

// Lightweight fingerprint (mtime + size) used by the frontend to detect when
// a file's content has changed (e.g. after a Replace transfer). Returning this
// is cheap — no file read required.
#[command]
fn get_file_fingerprint(path: String) -> Option<FileFingerprint> {
    let meta = std::fs::metadata(&path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(FileFingerprint {
        mtime_ms,
        size: meta.len(),
    })
}

#[command]
fn get_text_preview(path: String, max_bytes: Option<usize>) -> TextPreviewResult {
    let max_bytes = max_bytes.unwrap_or(131_072).clamp(4_096, 1_048_576);
    let data = match fs::read(&path) {
        Ok(data) => data,
        Err(err) => {
            return TextPreviewResult {
                content: String::new(),
                encoding: String::new(),
                truncated: false,
                line_count: 0,
                is_binary: false,
                error: Some(format!("Failed to read file: {}", err)),
            };
        }
    };

    if data.is_empty() {
        return TextPreviewResult {
            content: String::new(),
            encoding: "utf-8".to_string(),
            truncated: false,
            line_count: 0,
            is_binary: false,
            error: None,
        };
    }

    if is_likely_binary(&data) {
        return TextPreviewResult {
            content: String::new(),
            encoding: String::new(),
            truncated: false,
            line_count: 0,
            is_binary: true,
            error: None,
        };
    }

    let truncated = data.len() > max_bytes;
    let preview_slice = &data[..data.len().min(max_bytes)];

    let (encoding, mut content) = if preview_slice.starts_with(&[0xEF, 0xBB, 0xBF]) {
        ("utf-8".to_string(), String::from_utf8_lossy(&preview_slice[3..]).into_owned())
    } else if let Some(encoding) = looks_like_utf16(preview_slice) {
        let decoded = match encoding {
            "utf-16-le" => {
                let body = if preview_slice.starts_with(&[0xFF, 0xFE]) { &preview_slice[2..] } else { preview_slice };
                decode_utf16_bytes(body, true)
            }
            "utf-16-be" => {
                let body = if preview_slice.starts_with(&[0xFE, 0xFF]) { &preview_slice[2..] } else { preview_slice };
                decode_utf16_bytes(body, false)
            }
            _ => String::from_utf8_lossy(preview_slice).into_owned(),
        };
        (encoding.to_string(), decoded)
    } else if std::str::from_utf8(preview_slice).is_ok() {
        ("utf-8".to_string(), String::from_utf8_lossy(preview_slice).into_owned())
    } else {
        ("ansi-lossy".to_string(), String::from_utf8_lossy(preview_slice).into_owned())
    };

    content = content.replace("\r\n", "\n").replace('\r', "\n");

    if truncated {
        if let Some(last_newline) = content.rfind('\n') {
            if last_newline > content.len() / 2 {
                content.truncate(last_newline);
            }
        }
    }

    let line_count = content.lines().count();

    TextPreviewResult {
        content,
        encoding,
        truncated,
        line_count,
        is_binary: false,
        error: None,
    }
}

// Read text file content
#[command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

// Read binary file content
#[command]
fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("Failed to read binary file: {}", e))
}

// Open external URL using system default browser
#[command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    eprintln!("[open_external_url] called with url={}", url);
    use tauri_plugin_opener::OpenerExt;
    let result = app.opener().open_url(url.clone(), None::<&str>);
    eprintln!("[open_external_url] open_url result: {:?}", result);
    result.map_err(|e| {
        eprintln!("[open_external_url] error: {}", e);
        format!("Failed to open URL: {}", e)
    })
}

// Read binary file as base64 string
#[command]
fn read_file_as_base64(path: String) -> Result<String, String> {
    let data = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(STANDARD.encode(&data))
}

// Read file and return as data URL
#[command]
fn read_file_as_data_url(path: String) -> Result<String, String> {
    let data = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    let ext = Path::new(&path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mime = get_mime_type(&ext);
    let base64_data = STANDARD.encode(&data);
    Ok(format!("data:{};base64,{}", mime, base64_data))
}

// Single Tauri command frontend can call to extract one app's icon.
// Defers to the universal extractor so the batch and single-app paths
// return identical results.
#[cfg(windows)]
#[command]
fn get_open_with_app_icon(app: OpenWithApp) -> Result<Option<String>, String> {
    Ok(extract_open_with_icon_with_fallback(&app))
}



#[cfg(not(windows))]
#[command]
fn get_open_with_app_icon(_path: String) -> Result<Option<String>, String> {
    Ok(None)
}

// Render an icon from a file path using Windows Shell COM (pure Rust).
//
// This uses `IShellItemImageFactory::GetImage` — the EXACT same API that
// Windows File Explorer uses to render file and app icons. It respects
// AppUserModelID overrides, so it returns the correct branded icon for
// UWP apps (Photos, Paint 3D, Notepad, etc.) instead of the generic
// embedded icon that SHDefExtractIconW would return.
//
// We previously tried this via PowerShell COM interop, but `FolderItem.ExtractIcon()`
// was unreliable (often returned generic shell32.dll icons for .exe paths).
// Calling `SHCreateItemFromParsingName` + `IShellItemImageFactory` directly
// from Rust bypasses that bug entirely.
#[cfg(windows)]
fn extract_shell_item_icon(path: &str) -> Option<String> {
    use base64::Engine as _;
    use std::thread;
    use std::sync::mpsc;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        SHCreateItemFromParsingName, IShellItemImageFactory,
        SIIGBF_INCACHEONLY, SIIGBF_BIGGERSIZEOK, SIIGBF_RESIZETOFIT,
    };
    use windows::Win32::Foundation::SIZE;

    let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();

    let _handle = thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let factory: IShellItemImageFactory = match SHCreateItemFromParsingName(
            windows::core::PCWSTR(wide_path.as_ptr()),
            None,
        ) {
            Ok(f) => f,
            Err(_) => {
                CoUninitialize();
                tx.send(None).ok();
                return;
            }
        };

        // 256 px is a good balance — matches what Explorer shows for "Large icons"
        // view and is what most app launcher dialogs use. We use a single size
        // rather than per-DPI to avoid extra work.
        let size = SIZE { cx: 256, cy: 256 };

        // Try INCACHEONLY first — returns instantly if cached by Windows.
        // If miss, force a real extraction (RESIZETOFIT | BIGGERSIZEOK).
        let hbitmap = factory.GetImage(size, SIIGBF_INCACHEONLY).or_else(|_| {
            factory.GetImage(size, SIIGBF_RESIZETOFIT | SIIGBF_BIGGERSIZEOK)
        });

        let result = match hbitmap {
            Ok(hb) => hbitmap_to_png(hb),
            Err(_) => None,
        };

        // DeleteObject the HBITMAP (GDI handle), not the IShellItemImageFactory.
        if let Ok(hb) = hbitmap {
            use windows::Win32::Graphics::Gdi::DeleteObject;
            let _ = DeleteObject(hb);
        }
        CoUninitialize();

        tx.send(result).ok();
    });

    let png = rx.recv().ok().flatten()?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png)))
}

#[cfg(not(windows))]
fn extract_shell_item_icon(_path: &str) -> Option<String> {
    None
}

// Batch load icons for multiple apps using native Windows API - MUCH faster than PowerShell
#[cfg(windows)]
#[command]
fn get_open_with_icons_batch(apps: Vec<OpenWithApp>) -> Result<Vec<(String, Option<String>)>, String> {
    if apps.is_empty() {
        return Ok(vec![]);
    }

    use std::thread;
    use std::sync::mpsc;
    use base64::Engine as _;

    // Capture the count before moving apps into the loop
    let app_count = apps.len();
    let (tx, rx) = mpsc::channel();

    // Process icons in parallel using thread pool
    // Each app gets its own thread for icon extraction
    for app in apps {
        let thread_tx = tx.clone();
        let path = app.path.clone();
        let icon_index = app.icon_index.unwrap_or(0);
        let key = app.handler_id.clone().unwrap_or_else(|| app.path.clone());

        thread::spawn(move || {
            // Use the native extraction function
            let data_url = extract_icon_from_exe_native(&path, icon_index)
                .map(|png_data| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png_data)));

            thread_tx.send((key, data_url)).ok();
        });
    }

    // Drop the original sender so receiver knows when we're done
    drop(tx);

    // Collect all results
    let mut results: Vec<(String, Option<String>)> = Vec::with_capacity(app_count);
    while let Ok((key, data_url)) = rx.recv() {
        results.push((key, data_url));
    }

    Ok(results)
}

#[cfg(not(windows))]
#[command]
fn get_open_with_icons_batch(_apps: Vec<OpenWithApp>) -> Result<Vec<(String, Option<String>)>, String> {
    Ok(vec![])
}

// Progressive streaming icon extraction - emits each icon as soon as it's ready
// instead of blocking until all icons are extracted. This makes the dialog
// appear instantly with icons "popping in" progressively (like Windows Explorer).
#[cfg(windows)]
#[command]
async fn get_open_with_icons_stream(app_handle: tauri::AppHandle, apps: Vec<OpenWithApp>) -> Result<(), String> {
    use tauri::Emitter;
    use base64::Engine as _;

    if apps.is_empty() {
        return Ok(());
    }

    // Emit initial batch count so frontend knows how many to expect
    let _ = app_handle.emit("open-with-icons-start", serde_json::json!({
        "count": apps.len(),
    }));

    // Spawn background task to handle parallel extraction and emit events progressively
    let handle = app_handle.clone();
    std::thread::spawn(move || {
        use std::thread;
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel::<(String, Option<String>)>();

        // Spawn threads for parallel extraction
        for app in apps {
            let thread_tx = tx.clone();
            let app_for_thread = app.clone();

            thread::spawn(move || {
                // Try fast native extraction first, then fall back to comprehensive PowerShell method
                let data_url = extract_open_with_icon_with_fallback(&app_for_thread);

                thread_tx.send((app_for_thread.handler_id.clone().unwrap_or_else(|| app_for_thread.path.clone()), data_url)).ok();
            });
        }

        // Drop the original sender so receiver knows when all threads are done
        drop(tx);

        // Emit each icon as soon as it's ready (blocking loop)
        while let Ok((key, data_url)) = rx.recv() {
            let _ = handle.emit("open-with-icon-ready", serde_json::json!({
                "key": key,
                "icon": data_url,
            }));
        }

        // Emit completion signal
        let _ = handle.emit("open-with-icons-done", ());
    });

    // Return immediately so frontend can start listening
    Ok(())
}

// Extract icon for an OpenWithApp.
//
// The icon location has ALREADY been resolved upstream (in
// `enumerate_open_with_handlers`) from `IAssocHandler::GetIconLocation`
// + `SHLoadIndirectString`. So `app.icon_path` is always a real
// on-disk path (PNG / ICO / .EXE / .DLL) pointing at exactly the same
// resource Windows Explorer would render for that app.
//
// Strategy (ORDER MATTERS — we try the most accurate method first):
//   1. If `icon_path` points at an .exe / .dll, use Shell COM
//      (`IShellItemImageFactory`) FIRST — this returns the ACTUAL icon
//      registered for the app via AppUserModelID, not the generic
//      embedded icon that SHDefExtractIconW would return.
//   2. If `icon_path` is a real image file (PNG / ICO / BMP / JPG),
//      read it directly and convert to a base64 data URL.
//   3. As a last resort for plain .exe without AppUserModelID,
//      fall back to SHDefExtractIconW on the executable path.
#[cfg(windows)]
fn extract_open_with_icon_with_fallback(app: &OpenWithApp) -> Option<String> {
    use base64::Engine as _;
    eprintln!("[OpenWithIcon] app={} name={} icon_path={:?} launch_path={:?} path={}",
        app.handler_id.as_deref().unwrap_or("?"), app.name, app.icon_path, app.launch_path, app.path);

    let mut candidates: Vec<String> = [
        app.icon_path.clone(),
        app.launch_path.clone(),
        Some(app.path.clone()),
    ]
    .into_iter()
    .flatten()
    .map(|p| p.trim().trim_matches('"').to_string())
    .filter(|p| !p.is_empty())
    .collect();

    // Defensive: if icon_path is still an indirect string (e.g. when
    // enumerate wasn't run for this app), resolve it on the fly.
    if let Some(first) = candidates.first().cloned() {
        if first.trim_start().starts_with('@') {
            if let Some(resolved) = resolve_indirect_string(&first) {
                candidates[0] = resolved;
            }
        }
    }

    // PRIMARY: Shell COM — returns the app's registered icon (AppUserModelID-aware).
    // This is what File Explorer uses, so results MUST match.
    for candidate in &candidates {
        if Path::new(candidate).exists() {
            match extract_shell_item_icon(candidate) {
                Some(icon) => {
                    eprintln!("[OpenWithIcon]   ✓ Shell COM hit: {}", candidate);
                    return Some(icon);
                }
                None => {
                    eprintln!("[OpenWithIcon]   ✗ Shell COM miss: {}", candidate);
                }
            }
        } else {
            eprintln!("[OpenWithIcon]   - candidate not exists: {}", candidate);
        }
    }

    // SECONDARY: read image files directly (PNG / ICO / BMP / JPG).
    for candidate in &candidates {
        let p = Path::new(candidate);
        if p.exists() && p.is_file() {
            // Skip executables — they should have been handled by Shell COM above.
            if candidate.to_ascii_lowercase().ends_with(".exe")
                || candidate.to_ascii_lowercase().ends_with(".dll") {
                continue;
            }
            if let Ok(bytes) = std::fs::read(p) {
                if let Some(data_url) = image_bytes_to_data_url(&bytes) {
                    eprintln!("[OpenWithIcon]   ✓ direct image read: {} ({} bytes)", candidate, bytes.len());
                    return Some(data_url);
                } else {
                    eprintln!("[OpenWithIcon]   ✗ image_bytes_to_data_url returned None: {}", candidate);
                }
            }
        }
    }

    // LAST RESORT: SHDefExtractIconW on the executable. This extracts the
    // DEFAULT embedded icon resource from the EXE, which is correct only for
    // simple Win32 apps that don't register a custom AppUserModelID.
    let icon_index = app.icon_index.unwrap_or(0).max(-1);
    for candidate in &candidates {
        let ext = candidate.to_ascii_lowercase();
        if ext.ends_with(".exe") || ext.ends_with(".dll") {
            if Path::new(candidate).exists() {
                if let Some(png_data) = extract_icon_from_exe_native(candidate, icon_index) {
                    eprintln!("[OpenWithIcon]   ✓ SHDefExtractIconW hit: {}", candidate);
                    return Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png_data)));
                }
            }
        }
    }

    eprintln!("[OpenWithIcon]   ✗ ALL EXTRACTORS FAILED for {}", app.name);
    None
}

/// Convert image file bytes to a base64 data URL.
///
/// If the bytes are already PNG, they are returned verbatim. Otherwise the
/// `image` crate is used to decode and re-encode as PNG so the frontend
/// always gets a single, predictable format. ICO bytes are forwarded
/// as `image/x-icon` (which `<img>` supports natively).
#[cfg(windows)]
fn image_bytes_to_data_url(bytes: &[u8]) -> Option<String> {
    use base64::Engine as _;
    use image::{ImageFormat, ImageReader};
    use std::io::Cursor;

    if bytes.is_empty() {
        return None;
    }

    // PNG: return verbatim — no need to re-encode, smallest possible data URL.
    if bytes.len() >= 8 && bytes[..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        return Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)));
    }

    // Other formats (ICO, BMP, JPG, GIF, WebP, TIFF): decode and re-encode
    // as PNG so the data URL is consistent and predictable.
    if let Ok(reader) = ImageReader::new(Cursor::new(bytes)).with_guessed_format() {
        if let Some(format) = reader.format() {
            // ICO: `image` 0.25's ICO decoder requires manual frame selection,
            // so just hand the raw bytes to the browser, which renders ICO
            // natively via <img src="data:image/x-icon;base64,...">.
            if format == ImageFormat::Ico {
                return Some(format!("data:image/x-icon;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)));
            }
            if let Ok(img) = reader.decode() {
                let mut out = Vec::new();
                if img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png).is_ok() {
                    return Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&out)));
                }
            }
        }
    }

    // Last resort: return raw bytes labeled as PNG. Browsers will reject
    // them if they're not actually PNG (same as before this function).
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}


#[cfg(not(windows))]
#[command]
async fn get_open_with_icons_stream(_app_handle: tauri::AppHandle, _apps: Vec<OpenWithApp>) -> Result<(), String> {
    Ok(())
}

#[command]
fn get_http_server_url() -> String {
    format!("http://localhost:{}", HTTP_PORT)
}

// Write text content to a file
#[command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))
}

// Delete a file or directory. Defaults to "recycle" (move to Recycle Bin)
// — the safer option that can always be undone from the Recycle Bin UI.
// Callers must explicitly pass `mode = "permanent"` to bypass the bin;
// that path is reserved for cache-cleanup utilities (EXR / gkc cache) and
// is hardened below with a system-path guard so a stray call cannot wipe
// a drive root.
#[command]
fn delete_item(path: String, mode: Option<String>) -> Result<(), String> {
    let delete_mode = mode.as_deref().unwrap_or("recycle");
    let p = Path::new(&path);

    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    // System-path guard. Permanent delete is refused for any path that
    // sits on a drive root or inside a Windows / Program Files protected
    // directory. The recycle-bin path is allowed because the user can
    // always restore from there.
    if delete_mode == "permanent" {
        if let Err(reason) = ensure_path_safe_for_permanent_delete(p) {
            return Err(reason);
        }
        return if p.is_dir() {
            fs::remove_dir_all(p)
                .map_err(|e| format!("Failed to permanently remove directory: {}", e))
        } else {
            fs::remove_file(p)
                .map_err(|e| format!("Failed to permanently remove file: {}", e))
        };
    }

    // Recycle-bin path.
    #[cfg(windows)]
    {
        move_to_recycle_bin_windows(&path)
    }
    #[cfg(not(windows))]
    {
        // No portable recycle-bin API in std; fall back to a hard delete.
        // The frontend should never reach this branch on production
        // builds (Windows-only) but we keep it safe-by-default.
        eprintln!(
            "[delete_item] recycle-bin path requested on non-Windows platform — \
             falling back to hard delete for {}",
            path
        );
        if p.is_dir() {
            fs::remove_dir_all(p).map_err(|e| format!("Failed to remove directory: {}", e))
        } else {
            fs::remove_file(p).map_err(|e| format!("Failed to remove file: {}", e))
        }
    }
}

/// Refuse permanent delete for drive roots and protected Windows folders.
/// Permanent deletes are still allowed for user-owned paths (anything
/// under the user profile and any data drive letter that isn't a system
/// root). The recycle-bin path is unrestricted because the user can
/// always restore from there.
#[cfg(windows)]
fn ensure_path_safe_for_permanent_delete(p: &Path) -> Result<(), String> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{KNOWN_FOLDER_FLAG, SHGetKnownFolderPath};

    // Normalize: lowercase, no trailing separator (except for drive root
    // "C:\" which we keep canonical).
    let canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let canon_str = canon.to_string_lossy().to_string();

    // 1. Drive-root guard. "C:\", "D:\", etc. — refuse outright.
    if canon_str.len() <= 3 && canon_str.ends_with(':') {
        return Err(format!(
            "Refusing to permanently delete drive root: {}",
            canon_str
        ));
    }

    // 2. System-folder guard. Look up the Windows protected known
    //    folders (Windows, Program Files, ProgramData, System32 …) and
    //    reject any path that lives inside one of them.
    let protected_ids = &[
        // FOLDERID_Windows
        windows::core::GUID::from_u128(0xF38BF404_1D43_42F2_9305_67DE0B28FC23),
        // FOLDERID_ProgramFiles
        windows::core::GUID::from_u128(0x905E63B6_C1BF_494E_B29C_65B732D3D21A),
        // FOLDERID_ProgramFilesX86
        windows::core::GUID::from_u128(0x7C5A40EF_A0FB_4BFC_8742_C2F46E0439A5),
        // FOLDERID_ProgramData
        windows::core::GUID::from_u128(0x62AB5D82_FDC1_4DC3_A9DD_070D1D495D97),
        // FOLDERID_System
        windows::core::GUID::from_u128(0x1AC14E77_02E7_4E5D_B744_2EB1AE5198B7),
    ];
    for id in protected_ids {
        unsafe {
            if let Ok(pwstr) =
                SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), HANDLE(std::ptr::null_mut()))
            {
                let wide = pwstr.as_wide();
                let len = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
                let protected = if len > 0 {
                    String::from_utf16_lossy(&wide[..len])
                } else {
                    String::new()
                };
                CoTaskMemFree(Some(pwstr.as_ptr() as *const _));
                if !protected.is_empty() {
                    let protected_norm =
                        protected.trim_end_matches('\\').to_ascii_lowercase();
                    let canon_norm =
                        canon_str.trim_end_matches('\\').to_ascii_lowercase();
                    if canon_norm == protected_norm
                        || canon_norm.starts_with(&format!("{}\\", protected_norm))
                    {
                        return Err(format!(
                            "Refusing to permanently delete protected system path: {} \
                             (under {})",
                            canon_str, protected
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

/// Send a single filesystem item to the Recycle Bin. Uses `SHFileOperationW`
/// with `FOF_ALLOWUNDO` so the move is undoable from Explorer's "Undo
/// Move" or directly from the Recycle Bin UI. `FOF_SILENT |
/// FOF_NOCONFIRMATION | FOF_NOERRORUI` keeps it quiet: no confirmation
/// dialog, no progress UI, no error popups. The path must be
/// double-null-terminated for `pFrom` per the Win32 contract.
#[cfg(windows)]
fn move_to_recycle_bin_windows(path: &str) -> Result<(), String> {
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        SHFILEOPSTRUCTW, FO_DELETE,
    };

    // The pFrom field of SHFILEOPSTRUCTW is a double-null-terminated wide
    // string list. Single path → [path..., 0, 0].
    let wide_path: Vec<u16> = path
        .encode_utf16()
        .chain(std::iter::once(0))
        .chain(std::iter::once(0))
        .collect();

    let mut op = SHFILEOPSTRUCTW {
        hwnd: windows::Win32::Foundation::HWND(std::ptr::null_mut()),
        wFunc: FO_DELETE,
        pFrom: windows::core::PCWSTR(wide_path.as_ptr()),
        pTo: windows::core::PCWSTR(std::ptr::null()),
        fFlags: (FOF_ALLOWUNDO.0 | FOF_SILENT.0 | FOF_NOCONFIRMATION.0 | FOF_NOERRORUI.0) as u16,
        fAnyOperationsAborted: windows::Win32::Foundation::BOOL(0),
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: windows::core::PCWSTR(std::ptr::null()),
    };

    let result = unsafe { SHFileOperationW(&mut op) };
    if result == 0 && !op.fAnyOperationsAborted.as_bool() {
        Ok(())
    } else if op.fAnyOperationsAborted.as_bool() {
        Err(format!(
            "Recycle-bin operation aborted by shell for path: {}",
            path
        ))
    } else {
        Err(format!(
            "SHFileOperationW returned error code {} for path: {}",
            result, path
        ))
    }
}

/// Restore items from Recycle Bin to a destination folder using IFileOperation.
/// This properly restores the original filename instead of the $Rxxx name
/// that Windows uses internally in the Recycle Bin.
#[cfg(windows)]
#[command]
fn restore_from_recycle_bin(
    source_paths: Vec<String>,
    destination: String,
) -> Result<recycle_bin::RestoreResult, String> {
    recycle_bin::restore_from_recycle_bin(&source_paths, &destination)
}

/// Native Recycle Bin listing (Windows-only). Each entry carries the
/// shell-side parsing name AND the original `name` + `original_parent`
/// metadata. The frontend uses these to populate the Recycle Bin view AND
/// to send back to `restore_recycle_bin_entries` after a cut/paste - no
/// path-string matching required.
#[cfg(windows)]
#[command]
fn list_recycle_bin_entries() -> Result<Vec<recycle_bin::RecycleBinEntry>, String> {
    recycle_bin::list_recycle_bin_entries()
}

/// Restore a list of Recycle Bin entries (passed as structured name +
/// original_parent, not as path strings) back to their original locations.
#[cfg(windows)]
#[command]
fn restore_recycle_bin_entries(
    items: Vec<recycle_bin::RecycleBinEntry>,
) -> Result<recycle_bin::RestoreResult, String> {
    recycle_bin::restore_from_recycle_bin_entries(items)
}

// Create a directory
#[command]
fn create_directory(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create directory: {}", e))
}

// Rename or move an item
#[command]
fn rename_item(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename/move: {}", e))
}

// Copy a file
#[command]
fn copy_file(source: String, dest: String) -> Result<(), String> {
    fs::copy(&source, &dest).map_err(|e| format!("Failed to copy file: {}", e))?;
    Ok(())
}

// Copy a file or directory recursively
#[command]
fn copy_item(source: String, dest: String) -> Result<(), String> {
    let src = Path::new(&source);
    let dst = Path::new(&dest);
    if src.is_dir() {
        fs_extra::dir::copy(&source, &dest, &fs_extra::dir::CopyOptions::new().copy_inside(true))
            .map_err(|e| format!("Failed to copy directory: {}", e))?;
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {}", e))?;
        }
        fs::copy(&source, &dest).map_err(|e| format!("Failed to copy file: {}", e))?;
    }
    Ok(())
}

// Import/copy external files from OS into target directory
// Returns list of new destination paths
#[command]
fn import_files(source_paths: Vec<String>, target_dir: String) -> Result<Vec<String>, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    // Collect existing files in target directory for conflict detection
    let mut existing_in_target: Vec<String> = Vec::new();
    if Path::new(&target_dir).is_dir() {
        for entry in WalkDir::new(&target_dir).max_depth(1).into_iter().filter_map(|e| e.ok()) {
            let entry_path = entry.path();
            if entry_path != Path::new(&target_dir) {
                existing_in_target.push(entry_path.to_string_lossy().to_lowercase());
            }
        }
    }

    let existing_set: std::collections::HashSet<String> = existing_in_target.into_iter().collect();
    let mut result_paths: Vec<String> = Vec::new();
    let counter = AtomicUsize::new(0);

    for source_path in source_paths {
        let src = Path::new(&source_path);
        if !src.exists() {
            continue;
        }

        let file_name = src.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown");

        // Determine destination with conflict resolution
        let dest_path = {
            let mut candidate = PathBuf::from(&target_dir).join(file_name);
            let mut try_count = counter.load(Ordering::Relaxed);

            loop {
                let candidate_lower = candidate.to_string_lossy().to_lowercase();

                if !existing_set.contains(&candidate_lower) && !result_paths.iter().any(|p| p.to_lowercase() == candidate_lower) {
                    break candidate;
                }

                try_count += 1;
                counter.store(try_count, Ordering::Relaxed);

                // Split name and extension manually
                let (base, ext) = match file_name.rfind('.') {
                    Some(idx) if idx > 0 => (&file_name[..idx], Some(&file_name[idx..])),
                    _ => (file_name, None),
                };
                let new_name = match ext {
                    Some(e) if try_count == 1 => format!("{} - Copy{}", base, e),
                    Some(e) => format!("{} - Copy ({}){}", base, try_count, e),
                    None if try_count == 1 => format!("{} - Copy", base),
                    None => format!("{} - Copy ({})", base, try_count),
                };
                candidate = PathBuf::from(&target_dir).join(&new_name);
            }
        };

        // Perform the copy
        if src.is_dir() {
            fs_extra::dir::copy(&source_path, &dest_path, &fs_extra::dir::CopyOptions::new().copy_inside(true))
                .map_err(|e| format!("Failed to copy directory '{}': {}", file_name, e))?;
        } else {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {}", e))?;
            }
            fs::copy(&source_path, &dest_path).map_err(|e| format!("Failed to copy file '{}': {}", file_name, e))?;
        }

        result_paths.push(dest_path.to_string_lossy().to_string());
    }

    Ok(result_paths)
}

// Move/cut external files from OS into target directory
// Returns list of new destination paths
#[command]
fn move_files(source_paths: Vec<String>, target_dir: String) -> Result<Vec<String>, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    // Collect existing files in target directory for conflict detection
    let mut existing_in_target: Vec<String> = Vec::new();
    if Path::new(&target_dir).is_dir() {
        for entry in WalkDir::new(&target_dir).max_depth(1).into_iter().filter_map(|e| e.ok()) {
            let entry_path = entry.path();
            if entry_path != Path::new(&target_dir) {
                existing_in_target.push(entry_path.to_string_lossy().to_lowercase());
            }
        }
    }

    let existing_set: std::collections::HashSet<String> = existing_in_target.into_iter().collect();
    let mut result_paths: Vec<String> = Vec::new();
    let counter = AtomicUsize::new(0);

    for source_path in source_paths {
        let src = Path::new(&source_path);
        if !src.exists() {
            continue;
        }

        let file_name = src.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown");

        // Determine destination with conflict resolution
        let dest_path = {
            let mut candidate = PathBuf::from(&target_dir).join(file_name);
            let mut try_count = counter.load(Ordering::Relaxed);

            loop {
                let candidate_lower = candidate.to_string_lossy().to_lowercase();

                if !existing_set.contains(&candidate_lower) && !result_paths.iter().any(|p| p.to_lowercase() == candidate_lower) {
                    break candidate;
                }

                try_count += 1;
                counter.store(try_count, Ordering::Relaxed);

                let (base, ext) = match file_name.rfind('.') {
                    Some(idx) if idx > 0 => (&file_name[..idx], Some(&file_name[idx..])),
                    _ => (file_name, None),
                };
                let new_name = match ext {
                    Some(e) if try_count == 1 => format!("{} - Copy{}", base, e),
                    Some(e) => format!("{} - Copy ({}){}", base, try_count, e),
                    None if try_count == 1 => format!("{} - Copy", base),
                    None => format!("{} - Copy ({})", base, try_count),
                };
                candidate = PathBuf::from(&target_dir).join(&new_name);
            }
        };

        // Perform the move (rename)
        fs::rename(&source_path, &dest_path)
            .map_err(|e| format!("Failed to move '{}': {}", file_name, e))?;

        result_paths.push(dest_path.to_string_lossy().to_string());
    }

    Ok(result_paths)
}

#[command]
fn compress_to_zip(source_paths: Vec<String>, destination_zip: String) -> Result<(), String> {
    use zip::write::SimpleFileOptions;

    let destination = Path::new(&destination_zip);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create zip parent dir: {}", e))?;
    }

    let file = fs::File::create(destination).map_err(|e| format!("Failed to create zip: {}", e))?;
    let mut zip_writer = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for source_path in source_paths {
        let path = Path::new(&source_path);
        let root_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("item");

        if path.is_file() {
            zip_writer.start_file(root_name, options).map_err(|e| format!("Failed to add file to zip: {}", e))?;
            let mut src_file = fs::File::open(path).map_err(|e| format!("Failed to open source file: {}", e))?;
            let mut buffer = Vec::new();
            src_file.read_to_end(&mut buffer).map_err(|e| format!("Failed to read source file: {}", e))?;
            zip_writer.write_all(&buffer).map_err(|e| format!("Failed to write zip file entry: {}", e))?;
        } else if path.is_dir() {
            for entry in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
                let entry_path = entry.path();
                let relative = entry_path.strip_prefix(path).unwrap_or(entry_path);
                let zip_path = if relative.as_os_str().is_empty() {
                    root_name.to_string()
                } else {
                    format!("{}/{}", root_name, relative.to_string_lossy().replace('\\', "/"))
                };

                if entry.file_type().is_dir() {
                    zip_writer.add_directory(format!("{}/", zip_path.trim_end_matches('/')), options)
                        .map_err(|e| format!("Failed to add directory to zip: {}", e))?;
                } else {
                    zip_writer.start_file(zip_path, options).map_err(|e| format!("Failed to add file to zip: {}", e))?;
                    let mut src_file = fs::File::open(entry_path).map_err(|e| format!("Failed to open source file: {}", e))?;
                    let mut buffer = Vec::new();
                    src_file.read_to_end(&mut buffer).map_err(|e| format!("Failed to read source file: {}", e))?;
                    zip_writer.write_all(&buffer).map_err(|e| format!("Failed to write zip file entry: {}", e))?;
                }
            }
        }
    }

    zip_writer.finish().map_err(|e| format!("Failed to finalize zip: {}", e))?;
    Ok(())
}

#[command]
fn extract_zip(zip_path: String, destination_dir: String) -> Result<(), String> {
    let zip_file = fs::File::open(&zip_path).map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| format!("Failed to read zip archive: {}", e))?;
    fs::create_dir_all(&destination_dir).map_err(|e| format!("Failed to create destination directory: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| format!("Failed to read zip entry: {}", e))?;
        let out_path = Path::new(&destination_dir).join(file.mangled_name());

        if file.name().ends_with('/') {
            fs::create_dir_all(&out_path).map_err(|e| format!("Failed to create extracted directory: {}", e))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("Failed to create extracted parent directory: {}", e))?;
            }
            let mut outfile = fs::File::create(&out_path).map_err(|e| format!("Failed to create extracted file: {}", e))?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| format!("Failed to extract zip entry: {}", e))?;
        }
    }

    Ok(())
}

const MAX_ARCHIVE_PREVIEW_ENTRIES: usize = 25_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchivePreviewEntry {
    path: String,
    name: String,
    parent_path: String,
    extension: Option<String>,
    unpacked_size: u64,
    modified: Option<String>,
    is_directory: bool,
    is_encrypted: bool,
    is_split: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchivePreviewListing {
    format: String,
    entries: Vec<ArchivePreviewEntry>,
    listed_entries: usize,
    total_files: u64,
    total_directories: u64,
    total_unpacked_size: u64,
    has_encrypted_entries: bool,
    is_multipart: bool,
    truncated: bool,
    entry_limit: usize,
}

fn normalize_archive_entry_path(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();

    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }

    parts.join("/")
}

fn decode_archive_dos_timestamp(value: u32) -> Option<String> {
    if value == 0 {
        return None;
    }

    let date = (value >> 16) as u16;
    let time = value as u16;
    let year = ((date >> 9) & 0x7f) as i32 + 1980;
    let month = ((date >> 5) & 0x0f) as u32;
    let day = (date & 0x1f) as u32;
    let hour = ((time >> 11) & 0x1f) as u32;
    let minute = ((time >> 5) & 0x3f) as u32;
    let second = ((time & 0x1f) * 2) as u32;

    chrono::NaiveDate::from_ymd_opt(year, month, day)
        .and_then(|date| date.and_hms_opt(hour, minute, second))
        .map(|date_time| date_time.format("%Y-%m-%dT%H:%M:%S").to_string())
}

fn collect_rar_preview(
    archive: unrar_ng::Archive<'_>,
    is_multipart: bool,
) -> Result<ArchivePreviewListing, String> {
    let listing = archive
        .open_for_listing()
        .map_err(|error| format!("Unable to open RAR archive: {error}"))?;

    let mut entries = Vec::new();
    let mut total_files = 0u64;
    let mut total_directories = 0u64;
    let mut total_unpacked_size = 0u64;
    let mut has_encrypted_entries = false;
    let mut truncated = false;

    for result in listing {
        if entries.len() >= MAX_ARCHIVE_PREVIEW_ENTRIES {
            truncated = true;
            break;
        }

        let header = result.map_err(|error| format!("Unable to read RAR entry: {error}"))?;
        let path = normalize_archive_entry_path(&header.filename);
        if path.is_empty() {
            continue;
        }

        let is_directory = header.is_directory();
        let is_encrypted = header.is_encrypted();
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
        let parent_path = path
            .rsplit_once('/')
            .map(|(parent, _)| parent.to_string())
            .unwrap_or_default();
        let extension = if is_directory {
            None
        } else {
            Path::new(&name)
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| extension.to_lowercase())
        };

        if is_directory {
            total_directories = total_directories.saturating_add(1);
        } else {
            total_files = total_files.saturating_add(1);
            total_unpacked_size = total_unpacked_size.saturating_add(header.unpacked_size);
        }
        has_encrypted_entries |= is_encrypted;

        entries.push(ArchivePreviewEntry {
            path,
            name,
            parent_path,
            extension,
            unpacked_size: header.unpacked_size,
            modified: decode_archive_dos_timestamp(header.file_time),
            is_directory,
            is_encrypted,
            is_split: header.is_split(),
        });
    }

    Ok(ArchivePreviewListing {
        format: "rar".to_string(),
        listed_entries: entries.len(),
        entries,
        total_files,
        total_directories,
        total_unpacked_size,
        has_encrypted_entries,
        is_multipart,
        truncated,
        entry_limit: MAX_ARCHIVE_PREVIEW_ENTRIES,
    })
}

fn list_rar_entries_sync(
    path: String,
    password: Option<String>,
) -> Result<ArchivePreviewListing, String> {
    if path.as_bytes().contains(&0) {
        return Err("The archive path contains an invalid null character".to_string());
    }

    let archive_path = Path::new(&path);
    if !archive_path.exists() {
        return Err("The RAR archive no longer exists".to_string());
    }
    if !archive_path.is_file() {
        return Err("The selected RAR path is not a file".to_string());
    }
    if !archive_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("rar"))
    {
        return Err("Archive preview currently supports RAR files only".to_string());
    }

    match password.filter(|value| !value.is_empty()) {
        Some(password) => {
            let archive = unrar_ng::Archive::with_password(&path, &password);
            let is_multipart = archive.is_multipart();
            collect_rar_preview(archive.as_first_part(), is_multipart)
        }
        None => {
            let archive = unrar_ng::Archive::new(&path);
            let is_multipart = archive.is_multipart();
            collect_rar_preview(archive.as_first_part(), is_multipart)
        }
    }
}

#[tauri::command]
async fn list_rar_entries(
    path: String,
    password: Option<String>,
) -> Result<ArchivePreviewListing, String> {
    tokio::task::spawn_blocking(move || list_rar_entries_sync(path, password))
        .await
        .map_err(|error| format!("RAR preview worker failed: {error}"))?
}

fn format_zip_timestamp(value: Option<zip::DateTime>) -> Option<String> {
    let value = value?;
    chrono::NaiveDate::from_ymd_opt(
        value.year() as i32,
        value.month() as u32,
        value.day() as u32,
    )
    .and_then(|date| {
        date.and_hms_opt(
            value.hour() as u32,
            value.minute() as u32,
            value.second() as u32,
        )
    })
    .map(|date_time| date_time.format("%Y-%m-%dT%H:%M:%S").to_string())
}

fn list_zip_entries_sync(path: String) -> Result<ArchivePreviewListing, String> {
    if path.as_bytes().contains(&0) {
        return Err("The archive path contains an invalid null character".to_string());
    }

    let archive_path = Path::new(&path);
    if !archive_path.exists() {
        return Err("The ZIP archive no longer exists".to_string());
    }
    if !archive_path.is_file() {
        return Err("The selected ZIP path is not a file".to_string());
    }
    if !archive_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return Err("ZIP preview only accepts .zip files".to_string());
    }

    let zip_file = fs::File::open(archive_path)
        .map_err(|error| format!("Unable to open ZIP archive: {error}"))?;
    let mut archive = zip::ZipArchive::new(zip_file)
        .map_err(|error| format!("Unable to read ZIP central directory: {error}"))?;
    let archive_len = archive.len();
    let mut entries = Vec::new();
    let mut total_files = 0u64;
    let mut total_directories = 0u64;
    let mut total_unpacked_size = 0u64;
    let mut has_encrypted_entries = false;

    for index in 0..archive_len.min(MAX_ARCHIVE_PREVIEW_ENTRIES) {
        let file = archive
            .by_index(index)
            .map_err(|error| format!("Unable to read ZIP entry {index}: {error}"))?;
        let enclosed_path = match file.enclosed_name() {
            Some(path) => path,
            None => continue,
        };
        let path = normalize_archive_entry_path(&enclosed_path);
        if path.is_empty() {
            continue;
        }

        let is_directory = file.is_dir();
        let is_encrypted = file.encrypted();
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
        let parent_path = path
            .rsplit_once('/')
            .map(|(parent, _)| parent.to_string())
            .unwrap_or_default();
        let extension = if is_directory {
            None
        } else {
            Path::new(&name)
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| extension.to_lowercase())
        };

        if is_directory {
            total_directories = total_directories.saturating_add(1);
        } else {
            total_files = total_files.saturating_add(1);
            total_unpacked_size = total_unpacked_size.saturating_add(file.size());
        }
        has_encrypted_entries |= is_encrypted;

        entries.push(ArchivePreviewEntry {
            path,
            name,
            parent_path,
            extension,
            unpacked_size: file.size(),
            modified: format_zip_timestamp(file.last_modified()),
            is_directory,
            is_encrypted,
            is_split: false,
        });
    }

    Ok(ArchivePreviewListing {
        format: "zip".to_string(),
        listed_entries: entries.len(),
        entries,
        total_files,
        total_directories,
        total_unpacked_size,
        has_encrypted_entries,
        is_multipart: false,
        truncated: archive_len > MAX_ARCHIVE_PREVIEW_ENTRIES,
        entry_limit: MAX_ARCHIVE_PREVIEW_ENTRIES,
    })
}

#[tauri::command]
async fn list_zip_entries(path: String) -> Result<ArchivePreviewListing, String> {
    tokio::task::spawn_blocking(move || list_zip_entries_sync(path))
        .await
        .map_err(|error| format!("ZIP preview worker failed: {error}"))?
}

// Get disk space info
#[derive(Debug, Serialize)]
pub struct DiskSpace {
    pub total: u64,
    pub used: u64,
    pub free: u64,
    pub path: String,
}

// Rich drive metadata used by the sidebar to render drives the way Windows
// Explorer does — a system icon, the volume label, the drive type, the
// filesystem name, plus the capacity numbers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub path: String,
    pub label: String,
    pub display: String,
    pub drive_type: String,
    pub filesystem: String,
    /// Cloud provider identifier if the volume label matches a known cloud drive
    /// (e.g. "google_drive", "onedrive", "dropbox", "icloud"). Used by the
    /// frontend to render the brand icon instead of the generic drive icon.
    pub cloud_provider: Option<String>,
    pub icon_url: Option<String>,
    pub total: u64,
    pub used: u64,
    pub free: u64,
}

#[command]
fn get_disk_space(path: String) -> Result<DiskSpace, String> {
    use sysinfo::Disks;

    let disks = Disks::new_with_refreshed_list();
    let path_obj = Path::new(&path);

    for disk in disks.list() {
        let mount = disk.mount_point();
        if path_obj.starts_with(mount) || mount.to_string_lossy() == path {
            return Ok(DiskSpace {
                total: disk.total_space(),
                used: disk.total_space().saturating_sub(disk.available_space()),
                free: disk.available_space(),
                path: mount.to_string_lossy().to_string(),
            });
        }
    }

    if let Some(disk) = disks.list().first() {
        return Ok(DiskSpace {
            total: disk.total_space(),
            used: disk.total_space().saturating_sub(disk.available_space()),
            free: disk.available_space(),
            path: disk.mount_point().to_string_lossy().to_string(),
        });
    }

    Err("No disk information available".to_string())
}

// ============================================================
// Drive Metadata (Sidebar)
// ============================================================
//
// Returns a rich description of every logical drive on the system so the
// sidebar can render drives the way Windows Explorer does — including a
// stock icon that matches the drive type, the volume label, the filesystem
// name, and disk capacity.

#[cfg(windows)]
fn drive_type_to_str(t: u32) -> &'static str {
    // Win32 GetDriveTypeW returns one of these DRIVE_* constants.
    match t {
        2 => "removable", // DRIVE_REMOVABLE
        3 => "fixed",     // DRIVE_FIXED
        4 => "network",   // DRIVE_REMOTE
        5 => "cdrom",     // DRIVE_CDROM
        6 => "ramdisk",   // DRIVE_RAMDISK
        _ => "unknown",
    }
}

#[cfg(windows)]
fn stock_icon_id_for_drive(drive_type: u32) -> windows::Win32::UI::Shell::SHSTOCKICONID {
    use windows::Win32::UI::Shell::SHSTOCKICONID;
    match drive_type {
        2 => SHSTOCKICONID(11), // SIID_DRIVEREM — USB stick / removable
        3 => SHSTOCKICONID(8),  // SIID_DRIVEFIXED — HDD/SSD
        4 => SHSTOCKICONID(15), // SIID_SERVER — network
        5 => SHSTOCKICONID(12), // SIID_DRIVECD
        6 => SHSTOCKICONID(62), // SIID_DRIVERAM
        _ => SHSTOCKICONID(8),
    }
}

#[cfg(windows)]
fn query_volume_info(root_path: &str) -> (String, String) {
    // Returns (volume_label, filesystem_name). Either may be empty.
    use windows::Win32::Storage::FileSystem::GetVolumeInformationW;
    let wide: Vec<u16> = root_path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut name_buf = [0u16; 261];
    let mut fs_buf = [0u16; 261];
    let mut serial: u32 = 0;
    let mut max_comp: u32 = 0;
    let mut flags: u32 = 0;
    let ok = unsafe {
        GetVolumeInformationW(
            PCWSTR(wide.as_ptr()),
            Some(&mut name_buf),
            Some(&mut serial),
            Some(&mut max_comp),
            Some(&mut flags),
            Some(&mut fs_buf),
        )
    };
    if ok.is_err() {
        return (String::new(), String::new());
    }
    let label = String::from_utf16_lossy(&name_buf)
        .trim_end_matches('\0')
        .trim()
        .to_string();
    let fs = String::from_utf16_lossy(&fs_buf)
        .trim_end_matches('\0')
        .trim()
        .to_string();
    (label, fs)
}

#[cfg(windows)]
fn stock_icon_to_data_url(stock_id: windows::Win32::UI::Shell::SHSTOCKICONID) -> Option<String> {
    use windows::Win32::Graphics::Gdi::{DeleteObject, GetObjectW, BITMAP};
    use windows::Win32::UI::Shell::{SHGetStockIconInfo, SHGSI_ICON, SHSTOCKICONINFO};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    let mut info: SHSTOCKICONINFO = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHSTOCKICONINFO>() as u32;
    let hr = unsafe { SHGetStockIconInfo(stock_id, SHGSI_ICON, &mut info) };
    if hr.is_err() {
        return None;
    }
    let hicon = HICON(info.hIcon.0);
    if hicon.0.is_null() {
        return None;
    }
    let mut icon_info: ICONINFO = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetIconInfo(hicon, &mut icon_info).is_ok() };
    if !ok || icon_info.hbmColor.0.is_null() {
        unsafe {
            if !icon_info.hbmMask.0.is_null() {
                let _ = DeleteObject(icon_info.hbmMask);
            }
            let _ = DestroyIcon(hicon);
        }
        return None;
    }

    let hbm_color = icon_info.hbmColor;
    let hbm_mask = icon_info.hbmMask;

    let mut bmp: BITMAP = unsafe { std::mem::zeroed() };
    let got = unsafe {
        GetObjectW(
            hbm_color,
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut _),
        )
    };
    if got == 0 {
        unsafe {
            if !hbm_mask.0.is_null() {
                let _ = DeleteObject(hbm_mask);
            }
            let _ = DeleteObject(hbm_color);
            let _ = DestroyIcon(hicon);
        }
        return None;
    }

    let png_bytes = hbitmap_to_png(hbm_color);

    unsafe {
        if !hbm_mask.0.is_null() {
            let _ = DeleteObject(hbm_mask);
        }
        let _ = DeleteObject(hbm_color);
        let _ = DestroyIcon(hicon);
    }

    let png_bytes = match png_bytes {
        Some(b) => b,
        None => return None,
    };

    let b64 = STANDARD.encode(&png_bytes);
    Some(format!("data:image/png;base64,{}", b64))
}

#[cfg(not(windows))]
fn drive_type_to_str(_t: u32) -> &'static str {
    "unknown"
}

#[cfg(not(windows))]
fn stock_icon_to_data_url(_stock_id: u32) -> Option<String> {
    None
}

#[cfg(not(windows))]
fn query_volume_info(_root_path: &str) -> (String, String) {
    (String::new(), String::new())
}

/// Attempts to detect a cloud storage provider from the volume label using
/// known patterns used by Google Drive, OneDrive, Dropbox, and iCloud Drive.
/// The detection is based on the exact strings that each provider writes as
/// the NTFS volume label when the drive is mounted.
#[cfg(windows)]
fn detect_cloud_provider(label: &str) -> Option<&'static str> {
    // These are the exact volume label strings written by each provider's
    // Windows client. Case-insensitive matching handles localized Windows.
    let lower = label.to_ascii_lowercase();

    // Google Drive File Stream / Backup and Sync / Drive for Desktop
    if lower.contains("google drive")
        || lower.contains("googledrive")
        || lower == "gdrive"
        || lower == "gdrives"
        || lower == "drive"
    {
        return Some("google_drive");
    }

    // Microsoft OneDrive (Consumer + OneDrive for Business)
    if lower.contains("onedrive")
        || lower == "onedrive"
        || lower == "onedrivesync"
        || lower == "skydrive"
    {
        return Some("onedrive");
    }

    // Dropbox
    if lower.contains("dropbox")
        || lower == "dropbox"
        || lower == "drop box"
        || lower == "dropbx"
    {
        return Some("dropbox");
    }

    // iCloud Drive (Apple)
    if lower.contains("icloud")
        || lower == "icloud"
        || lower == "icloud drive"
    {
        return Some("icloud");
    }

    // pCloud
    if lower.contains("pcloud") || lower == "pcloud" {
        return Some("pcloud");
    }

    // Box
    if lower.contains("box drive") || lower == "box" || lower == "boxdrive" {
        return Some("box");
    }

    None
}

#[cfg(not(windows))]
fn detect_cloud_provider(_label: &str) -> Option<&'static str> {
    None
}

#[command]
fn get_drive_infos() -> Result<Vec<DriveInfo>, String> {
    use sysinfo::Disks;

    let drives = get_drives();
    let sys_disks = Disks::new_with_refreshed_list();

    let mut out: Vec<DriveInfo> = Vec::with_capacity(drives.len());
    for path in drives {
        #[cfg(windows)]
        let (drive_type_u32, drive_type_str) = {
            let letter = path.chars().next().unwrap_or('C');
            let mut buf = [letter as u16, b':' as u16, b'\\' as u16, 0];
            let dt = unsafe {
                windows::Win32::Storage::FileSystem::GetDriveTypeW(PCWSTR(buf.as_mut_ptr()))
            };
            (dt, drive_type_to_str(dt).to_string())
        };

        #[cfg(not(windows))]
        let drive_type_str = drive_type_to_str(0).to_string();

        // Try to get the real shell icon first (same API as File Explorer uses).
        // This returns branded icons for cloud providers (Google Drive, OneDrive, etc.).
        // Falls back to stock icon if shell extraction fails.
        #[cfg(windows)]
        let icon_url = extract_shell_item_icon(&path).or_else(|| {
            stock_icon_to_data_url(stock_icon_id_for_drive(drive_type_u32))
        });
        #[cfg(not(windows))]
        let icon_url: Option<String> = None;

        let (label, filesystem) = query_volume_info(&path);

        let cloud_provider = detect_cloud_provider(&label);

        // Pull capacity from sysinfo if we can match by mount point.
        let mut total: u64 = 0;
        let mut free: u64 = 0;
        for disk in sys_disks.list() {
            let mount = disk.mount_point().to_string_lossy().to_string();
            let mount_norm = mount.trim_end_matches(|c| c == '/' || c == '\\').to_string();
            let path_norm = path.trim_end_matches(|c| c == '/' || c == '\\').to_string();
            if mount_norm.eq_ignore_ascii_case(&path_norm) {
                total = disk.total_space();
                free = disk.available_space();
                break;
            }
        }
        let used = total.saturating_sub(free);

        let letter = path.chars().next().unwrap_or('?').to_ascii_uppercase();
        let display = if label.is_empty() {
            match drive_type_str.as_str() {
                "removable" => format!("Removable Disk ({}:)", letter),
                "cdrom" => format!("CD Drive ({}:)", letter),
                "network" => format!("Network Drive ({}:)", letter),
                "ramdisk" => format!("RAM Disk ({}:)", letter),
                _ => format!("Local Disk ({}:)", letter),
            }
        } else {
            format!("{} ({}:)", label, letter)
        };

        out.push(DriveInfo {
            path: path.clone(),
            label,
            display,
            drive_type: drive_type_str,
            filesystem,
            cloud_provider: cloud_provider.map(String::from),
            icon_url,
            total,
            used,
            free,
        });
    }
    Ok(out)
}

#[cfg(windows)]
#[command]
fn set_volume_label(path: String, label: String) -> Result<(), String> {
    use windows::Win32::Storage::FileSystem::SetVolumeLabelW;
    let wide_root: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let wide_label: Vec<u16> = label.encode_utf16().chain(std::iter::once(0)).collect();
    let ok = unsafe { SetVolumeLabelW(PCWSTR(wide_root.as_ptr()), PCWSTR(wide_label.as_ptr())) };
    if ok.is_err() {
        Err(format!(
            "SetVolumeLabelW failed for {} (admin privileges may be required)",
            path
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
#[command]
fn set_volume_label(_path: String, _label: String) -> Result<(), String> {
    Err("set_volume_label is only implemented on Windows".to_string())
}

#[cfg(windows)]
#[command]
fn open_in_terminal(path: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // Prefer Windows Terminal (the modern default), then fall back to cmd.exe.
    // CREATE_NEW_CONSOLE so the shell opens in its own window and survives
    // even when the parent explorer window closes.
    const CREATE_NEW_CONSOLE: u32 = 0x00000010;
    let candidates: [(&str, &[&str]); 2] = [
        ("wt.exe", &["-d", &path]),
        ("cmd.exe", &["/C", "start", "", "cmd.exe", "/K", &format!("cd /d \"{}\"", path)]),
    ];
    let mut last_err = String::new();
    for (cmd, args) in candidates.iter() {
        let result = std::process::Command::new(cmd)
            .args(*args)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn();
        match result {
            Ok(_) => return Ok(()),
            Err(e) => last_err = format!("{}: {}", cmd, e),
        }
    }
    Err(format!("No terminal available ({})", last_err))
}

#[cfg(not(windows))]
#[command]
fn open_in_terminal(_path: String) -> Result<(), String> {
    Err("open_in_terminal is only implemented on Windows".to_string())
}

// Search for files recursively.
// WalkDir scans without metadata I/O and emits lightweight batches of 50 immediately.
// Once complete, Phase 2 reads full metadata for the final sorted+deduped batch (done=true).
// Lightweight results (size=0, no timestamps) arrive first so the UI is never blank.
const BATCH_SIZE: usize = 10;

fn make_lightweight_entry(name: String, path: String, is_dir: bool) -> FileEntry {
    let is_file = !is_dir;
    let extension = if is_file {
        std::path::Path::new(&path)
            .extension()
            .map(|e| e.to_string_lossy().to_string())
    } else {
        None
    };
    
    let is_hidden = is_hidden_file(std::path::Path::new(&path));
    
    FileEntry {
        name,
        path,
        is_file,
        is_dir,
        size: 0,
        modified: None,
        created: None,
        extension,
        is_hidden,
    }
}

#[command]
async fn search_files(
    app: tauri::AppHandle,
    root: String,
    query: String,
    max_depth: Option<usize>,
    request_id: u32,
) -> Result<Vec<FileEntry>, String> {
    let depth = max_depth.unwrap_or(5);
    let app_handle = app.clone();

    // Phase 1: WalkDir scan — emit lightweight batches immediately.
    let (mut dirs, mut files) = {
        let query_lower = query.to_lowercase();
        let root = root.clone();
        tokio::task::spawn_blocking(move || {
            let mut dirs = Vec::new();
            let mut files = Vec::new();
            for entry in WalkDir::new(&root)
                .max_depth(depth)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                let file_name = entry.file_name().to_string_lossy().to_string();
                // Skip Unix hidden files
                if file_name.starts_with('.') {
                    continue;
                }
                // Always hide protected system items (FILE_ATTRIBUTE_SYSTEM
                // and reparse points) like Windows Explorer does
                if is_protected_system_item(entry.path()) {
                    continue;
                }
                let name_lower = file_name.to_lowercase();
                if !name_lower.contains(&query_lower) {
                    continue;
                }
                let path = entry.path().to_string_lossy().to_string();
                if entry.file_type().is_dir() {
                    dirs.push((file_name, path));
                } else {
                    files.push((file_name, path));
                }
            }
            (dirs, files)
        })
        .await
        .map_err(|e| format!("search scan panicked: {}", e))?
    };

    let total = dirs.len() + files.len();

    // Emit dirs in batches immediately.
    for chunk in dirs.chunks(BATCH_SIZE) {
        let entries: Vec<FileEntry> = chunk
            .iter()
            .map(|(name, path)| make_lightweight_entry(name.clone(), path.clone(), true))
            .collect();
        let _ = app_handle.emit(
            "search-progress",
            serde_json::json!({
                "requestId": request_id,
                "batch": entries,
                "total": total,
                "done": false,
            }),
        );
    }

    // Emit files in batches immediately.
    for chunk in files.chunks(BATCH_SIZE) {
        let entries: Vec<FileEntry> = chunk
            .iter()
            .map(|(name, path)| make_lightweight_entry(name.clone(), path.clone(), false))
            .collect();
        let _ = app_handle.emit(
            "search-progress",
            serde_json::json!({
                "requestId": request_id,
                "batch": entries,
                "total": total,
                "done": false,
            }),
        );
    }

    // Phase 2: read full metadata, sort, dedup.
    dirs.append(&mut files);
    let all_paths: Vec<(String, String, bool)> = dirs
        .into_iter()
        .map(|(n, p)| (n, p, true))
        .collect();

    let collected = {
        let paths = all_paths;
        tokio::task::spawn_blocking(move || {
            let mut results: Vec<FileEntry> = Vec::with_capacity(paths.len());
            for (file_name, path, is_dir) in paths {
                let is_file = !is_dir;
                let metadata = std::fs::metadata(&path).ok();
                let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = metadata
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .map(DateTime::<Utc>::from)
                    .map(|dt| dt.to_rfc3339());
                let created = metadata
                    .as_ref()
                    .and_then(|m| m.created().ok())
                    .map(DateTime::<Utc>::from)
                    .map(|dt| dt.to_rfc3339());
                let extension = if is_file {
                    std::path::Path::new(&path)
                        .extension()
                        .map(|e| e.to_string_lossy().to_string())
                } else {
                    None
                };
                // For search results, we don't filter by hidden status but mark it
                let is_hidden = is_hidden_file(std::path::Path::new(&path));
                results.push(FileEntry {
                    name: file_name,
                    path,
                    is_file,
                    is_dir,
                    size,
                    modified,
                    created,
                    extension,
                    is_hidden,
                });
            }
            results
        })
        .await
        .map_err(|e| format!("metadata read panicked: {}", e))?
    };

    // Sort: dirs first (by date desc, name asc), then files (same order).
    let mut dirs_results: Vec<_> = collected
        .iter()
        .filter(|e| e.is_dir)
        .cloned()
        .collect();
    let mut files_results: Vec<_> = collected
        .iter()
        .filter(|e| e.is_file)
        .cloned()
        .collect();

    dirs_results.sort_by(|a, b| {
        let a_time = a.modified.as_deref().unwrap_or("");
        let b_time = b.modified.as_deref().unwrap_or("");
        b_time.cmp(a_time).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    dirs_results.dedup_by(|a, b| a.path.eq_ignore_ascii_case(&b.path));

    files_results.sort_by(|a, b| {
        let a_time = a.modified.as_deref().unwrap_or("");
        let b_time = b.modified.as_deref().unwrap_or("");
        b_time.cmp(a_time).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    files_results.dedup_by(|a, b| a.path.eq_ignore_ascii_case(&b.path));

    let final_results: Vec<FileEntry> = dirs_results
        .into_iter()
        .chain(files_results)
        .collect();

    let _ = app.emit(
        "search-progress",
        serde_json::json!({
            "requestId": request_id,
            "batch": final_results,
            "total": final_results.len(),
            "done": true,
        }),
    );

    Ok(final_results)
}

// Check if path exists
#[command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[command]
fn open_path_with_default_app(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    // Prevent opening reparse points (junction points, symbolic links)
    // These contain binary reparse data and can cause crashes
    if is_reparse_point(target) {
        return Err("Cannot open: this is a system junction or symbolic link point".to_string());
    }

    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| format!("Failed to open path with default app: {}", e))
}

#[cfg(windows)]
fn get_openwith_store_path() -> Result<PathBuf, String> {
    let base = dirs::config_dir()
        .or_else(dirs::data_local_dir)
        .ok_or_else(|| "Could not determine config directory".to_string())?;
    Ok(base.join("GK File Explorer").join("openwith_associations.json"))
}

#[cfg(windows)]
fn load_openwith_associations() -> Result<HashMap<String, OpenWithApp>, String> {
    let path = get_openwith_store_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read associations: {}", e))?;

    serde_json::from_str::<HashMap<String, OpenWithApp>>(&raw)
        .map_err(|e| format!("Failed to parse associations: {}", e))
}

#[cfg(windows)]
fn save_openwith_associations(associations: &HashMap<String, OpenWithApp>) -> Result<(), String> {
    let path = get_openwith_store_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    let raw = serde_json::to_string_pretty(associations)
        .map_err(|e| format!("Failed to serialize associations: {}", e))?;

    fs::write(&path, raw)
        .map_err(|e| format!("Failed to write associations: {}", e))
}

#[cfg(windows)]
fn normalize_extension(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
}

#[cfg(windows)]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn launch_process_with_path(app_path: &str, target_path: &str) -> Result<(), String> {
    Command::new(app_path)
        .arg(target_path)
        .spawn()
        .map_err(|e| format!("Failed to launch application: {}", e))?;
    Ok(())
}

#[cfg(windows)]
struct ComApartment;

#[cfg(windows)]
impl ComApartment {
    fn init() -> Result<Self, String> {
        unsafe {
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            if hr.is_err() {
                return Err(format!("Failed to initialize COM: {}", hr));
            }
        }
        Ok(Self)
    }
}

#[cfg(windows)]
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

#[cfg(windows)]
fn pwstr_to_string_and_free(value: PWSTR) -> String {
    if value.is_null() {
        return String::new();
    }

    let result = unsafe { value.to_string() }.unwrap_or_default();
    unsafe {
        CoTaskMemFree(Some(value.0 as _));
    }
    result
}

#[cfg(windows)]
fn normalize_shell_icon_location(raw: &str) -> (Option<String>, Option<i32>) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return (None, None);
    }

    if let Some((path, index)) = trimmed.rsplit_once(',') {
        if let Ok(parsed_index) = index.trim().parse::<i32>() {
            return (Some(path.trim().to_string()), Some(parsed_index));
        }
    }

    (Some(trimmed.to_string()), Some(0))
}

/// Resolve a Shell "indirect string" of the form `@{...}` (used by
/// `IAssocHandler::GetIconLocation` for UWP / MSIX apps) to the actual
/// on-disk path of the resource. This is the same API Windows Explorer
/// itself uses to resolve MSIX/UWP icon paths, so the result is the icon
/// that Explorer would render for that app.
///
/// Returns `None` if the input is not an indirect string, or if Shell
/// cannot resolve it.
#[cfg(windows)]
fn resolve_indirect_string(source: &str) -> Option<String> {
    let trimmed = source.trim();
    if !trimmed.starts_with('@') {
        return None;
    }
    let wide_source = wide_null(trimmed);
    let mut buffer = vec![0u16; 2048];
    let result = unsafe {
        SHLoadIndirectString(
            PCWSTR(wide_source.as_ptr()),
            &mut buffer,
            None,
        )
    };
    if result.is_err() {
        return None;
    }
    let resolved = pwstr_buffer_to_string(&buffer);
    let resolved = resolved.trim();
    if resolved.is_empty() || resolved == trimmed {
        None
    } else {
        Some(resolved.to_string())
    }
}

/// Convert a fixed-length `u16` buffer (as returned by APIs that take
/// `&mut [u16]`) into a `String`, trimming at the first NUL.
#[cfg(windows)]
fn pwstr_buffer_to_string(buffer: &[u16]) -> String {
    let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..len])
}

#[cfg(windows)]
fn query_assoc_string(extension: &str, assoc: windows::Win32::UI::Shell::ASSOCSTR) -> Option<String> {
    let extension_wide = wide_null(extension);
    let mut length = 0u32;

    unsafe {
        let _ = AssocQueryStringW(
            ASSOCF_NONE,
            assoc,
            PCWSTR(extension_wide.as_ptr()),
            PCWSTR::null(),
            PWSTR::null(),
            &mut length,
        );
    }

    if length == 0 {
        return None;
    }

    let mut buffer = vec![0u16; length as usize];
    let result = unsafe {
        AssocQueryStringW(
            ASSOCF_NONE,
            assoc,
            PCWSTR(extension_wide.as_ptr()),
            PCWSTR::null(),
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    };

    if result.is_err() {
        return None;
    }

    let text = String::from_utf16_lossy(&buffer);
    Some(text.trim_end_matches('\0').trim().to_string()).filter(|value| !value.is_empty())
}

#[cfg(windows)]
fn split_packaged_app_identity(value: &str) -> (Option<String>, Option<String>) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return (None, None);
    }

    if let Some((family, app_id)) = trimmed.split_once('!') {
        let family = family.trim();
        let app_id = app_id.trim();
        return (
            (!family.is_empty()).then(|| family.to_string()),
            (!app_id.is_empty()).then(|| app_id.to_string()),
        );
    }

    if let Some(indirect) = trimmed.strip_prefix("@{").and_then(|value| value.strip_suffix('}')) {
        if let Some((package_full_name, resource)) = indirect.split_once("?ms-resource://") {
            let package_family_name = package_full_name
                .rsplit_once('_')
                .map(|(prefix, publisher)| format!("{}_{}", prefix, publisher))
                .filter(|family| family.contains('_') && !family.starts_with('_') && !family.ends_with('_'));
            let resource_app_id = resource
                .split('/')
                .next()
                .map(str::trim)
                .filter(|segment| !segment.is_empty())
                .map(|segment| segment.to_string());
            return (package_family_name, resource_app_id);
        }
    }

    let normalized = trimmed.replace('/', "\\");
    if let Some(windowsapps_index) = normalized.to_ascii_lowercase().find("\\windowsapps\\") {
        let suffix = &normalized[windowsapps_index + "\\WindowsApps\\".len()..];
        if let Some((package_full_name, remainder)) = suffix.split_once('\\') {
            if !package_full_name.contains('*') {
                let package_family_name = package_full_name
                    .rsplit_once('_')
                    .map(|(prefix, publisher)| format!("{}_{}", prefix, publisher))
                    .filter(|family| family.contains('_') && !family.starts_with('_') && !family.ends_with('_'));
                let app_id = Path::new(remainder)
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .filter(|stem| !stem.is_empty())
                    .map(|stem| stem.to_string());
                if package_family_name.is_some() {
                    return (package_family_name, app_id);
                }
            }
        }
    }

    if trimmed.contains('.') && trimmed.contains('_') && !trimmed.contains('\\') && !trimmed.contains('/') && !trimmed.contains(':') && !trimmed.contains('*') {
        return (Some(trimmed.to_string()), None);
    }

    (None, None)
}

#[cfg(windows)]
fn parse_manifest_visual_logo(manifest_path: &Path, app_id: Option<&str>) -> Option<String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let xml = fs::read_to_string(manifest_path).ok()?;
    let mut reader = Reader::from_str(&xml);
    reader.trim_text(true);

    let mut buf = Vec::new();
    let mut current_app_id: Option<String> = None;
    let mut in_matching_application = app_id.is_none();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let local_name = e.local_name();
                let tag = local_name.as_ref();

                if tag == b"Application" {
                    current_app_id = None;
                    for attr in e.attributes().flatten() {
                        if attr.key.local_name().as_ref() == b"Id" {
                            current_app_id = Some(String::from_utf8_lossy(attr.value.as_ref()).to_string());
                            break;
                        }
                    }
                    in_matching_application = match app_id {
                        Some(expected) => current_app_id.as_deref().map(|id| id.eq_ignore_ascii_case(expected)).unwrap_or(false),
                        None => true,
                    };
                }

                if in_matching_application && (tag.ends_with(b"VisualElements") || tag == b"VisualElements") {
                    for attr in e.attributes().flatten() {
                        if attr.key.local_name().as_ref() == b"Square44x44Logo" {
                            return Some(String::from_utf8_lossy(attr.value.as_ref()).to_string());
                        }
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                if e.local_name().as_ref() == b"Application" {
                    current_app_id = None;
                    in_matching_application = app_id.is_none();
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    None
}

#[cfg(windows)]
fn resolve_manifest_logo_variant(base_dir: &Path, relative_logo: &str) -> Option<String> {
    let relative = relative_logo.trim().trim_matches('"').replace('/', "\\");
    if relative.is_empty() {
        return None;
    }

    let raw_path = base_dir.join(&relative);
    if raw_path.exists() {
        return Some(raw_path.to_string_lossy().to_string());
    }

    let relative_path = Path::new(&relative);
    let parent = relative_path.parent().map(|p| base_dir.join(p)).unwrap_or_else(|| base_dir.to_path_buf());
    let stem = relative_path.file_stem()?.to_string_lossy().to_string();
    let ext = relative_path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_else(|| "png".to_string());

    let candidates = [
        format!("{}.scale-200.{}", stem, ext),
        format!("{}.scale-150.{}", stem, ext),
        format!("{}.scale-125.{}", stem, ext),
        format!("{}.targetsize-48.{}", stem, ext),
        format!("{}.targetsize-32.{}", stem, ext),
        format!("{}.targetsize-24.{}", stem, ext),
        format!("{}.targetsize-16.{}", stem, ext),
        format!("{}.scale-100.{}", stem, ext),
        format!("{}.{}", stem, ext),
    ];

    for candidate in candidates {
        let path = parent.join(candidate);
        if path.exists() {
            return Some(path.to_string_lossy().to_string());
        }
    }

    None
}

#[cfg(windows)]
fn get_package_install_root(package_family_name: &str) -> Option<PathBuf> {
    let normalized_family = package_family_name.trim().trim_start_matches("pfn:");
    if normalized_family.is_empty() {
        return None;
    }

    let program_files = std::env::var("ProgramFiles").ok()?;
    let windows_apps = Path::new(&program_files).join("WindowsApps");
    let prefix = format!("{}{}", normalized_family, "_");
    let mut matches: Vec<PathBuf> = fs::read_dir(&windows_apps)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.file_name().and_then(|name| name.to_str()).map(|name| name.starts_with(&prefix)).unwrap_or(false))
        .collect();
    matches.sort();
    matches.pop()
}

#[cfg(windows)]
fn enrich_packaged_openwith_app(app: &mut OpenWithApp) {
    let handler = app.handler_id.clone().unwrap_or_default();
    let existing_aumid = app.app_user_model_id.clone();
    let existing_pfn = app.package_family_name.clone();
    let (handler_package_family_name, handler_app_id) = split_packaged_app_identity(&handler);
    let (path_package_family_name, path_app_id) = split_packaged_app_identity(&app.path);
    let (icon_package_family_name, icon_app_id) = app.icon_path
        .as_deref()
        .map(split_packaged_app_identity)
        .unwrap_or((None, None));
    let (existing_pfn_identity, _) = existing_pfn
        .as_deref()
        .map(split_packaged_app_identity)
        .unwrap_or((existing_pfn.clone(), None));
    let (existing_aumid_pfn, existing_aumid_app_id) = existing_aumid
        .as_deref()
        .map(split_packaged_app_identity)
        .unwrap_or((None, None));

    let package_family_name = existing_aumid_pfn
        .or(existing_pfn_identity)
        .or(handler_package_family_name)
        .or(path_package_family_name)
        .or(icon_package_family_name)
        .or_else(|| {
            if app.name.eq_ignore_ascii_case("Photos") {
                app.icon_path
                    .as_deref()
                    .and_then(|value| resolve_existing_windowsapps_executable(value, "PhotosApp.exe"))
                    .or_else(|| resolve_existing_windowsapps_executable(&app.path, "PhotosApp.exe"))
                    .and_then(|resolved| split_packaged_app_identity(&resolved).0)
            } else {
                None
            }
        });
    let app_id = existing_aumid_app_id
        .or(handler_app_id)
        .or(path_app_id)
        .or(icon_app_id)
        .or_else(|| app.name.eq_ignore_ascii_case("Photos").then(|| "PhotosApp".to_string()))
        .filter(|candidate| !candidate.contains('*'));

    let Some(package_family_name) = package_family_name else {
        return;
    };

    let stable_aumid = app_id
        .as_ref()
        .map(|id| format!("{}!{}", package_family_name, id));

    app.package_family_name = Some(package_family_name.clone());
    if stable_aumid.is_some() {
        app.app_user_model_id = stable_aumid.clone();
        app.handler_id = stable_aumid.clone();
    } else if app.handler_id.as_deref().unwrap_or_default().trim().is_empty() {
        app.handler_id = Some(format!("pfn:{}", package_family_name));
    }
    app.is_packaged = Some(true);

    let install_root = match get_package_install_root(&package_family_name) {
        Some(root) => root,
        None => {
            if app.path.trim().is_empty() || app.path.eq_ignore_ascii_case(&handler) {
                app.path = stable_aumid
                    .clone()
                    .or_else(|| app.package_family_name.clone())
                    .unwrap_or_else(|| handler.clone());
            }
            return;
        }
    };

    let manifest_path = install_root.join("AppxManifest.xml");
    let relative_logo = parse_manifest_visual_logo(&manifest_path, app_id.as_deref());
    let manifest_icon = relative_logo
        .as_deref()
        .and_then(|logo| resolve_manifest_logo_variant(&install_root, logo));

    app.package_full_name = install_root.file_name().and_then(|name| name.to_str()).map(|s| s.to_string());
    app.manifest_path = manifest_path.exists().then(|| manifest_path.to_string_lossy().to_string());
    if manifest_icon.is_some() {
        app.icon_path = manifest_icon;
        app.icon_index = Some(0);
    }
    if app.path.trim().is_empty() || app.path.eq_ignore_ascii_case(&handler) {
        app.path = app
            .icon_path
            .clone()
            .or_else(|| app.app_user_model_id.clone())
            .or_else(|| app.package_family_name.clone())
            .unwrap_or_else(|| handler.clone());
    }
}

#[cfg(windows)]
fn activate_packaged_app_for_file(path: &str, app: &OpenWithApp) -> Result<(), String> {
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_LOCAL_SERVER};
    use windows::Win32::UI::Shell::{
        IApplicationActivationManager, IShellItem, IShellItemArray, SHCreateItemFromParsingName,
        SHCreateShellItemArrayFromShellItem, ApplicationActivationManager,
    };

    let aumid = app
        .app_user_model_id
        .as_deref()
        .or(app.handler_id.as_deref())
        .ok_or_else(|| format!("Missing packaged app identity for {}", app.name))?;

    let file_wide = wide_null(path);
    let aumid_wide = wide_null(aumid);
    let _com = ComApartment::init()?;

    let item: IShellItem = unsafe {
        SHCreateItemFromParsingName(PCWSTR(file_wide.as_ptr()), None)
            .map_err(|e| format!("Failed to create shell item for file activation: {}", e))?
    };

    let item_array: IShellItemArray = unsafe {
        SHCreateShellItemArrayFromShellItem(&item)
            .map_err(|e| format!("Failed to create shell item array for file activation: {}", e))?
    };

    let activation_manager: IApplicationActivationManager = unsafe {
        CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER)
            .map_err(|e| format!("Failed to create activation manager: {}", e))?
    };

    match unsafe { activation_manager.ActivateForFile(PCWSTR(aumid_wide.as_ptr()), &item_array, PCWSTR::null()) } {
        Ok(_) => Ok(()),
        Err(primary_error) => {
            if let Some(executable) = app
                .launch_path
                .as_deref()
                .or(app.icon_path.as_deref())
                .or(Some(app.path.as_str()))
                .map(|value| value.trim().trim_matches('"').to_string())
                .filter(|candidate| !candidate.is_empty() && candidate.to_ascii_lowercase().ends_with(".exe") && Path::new(candidate).exists())
            {
                let status = Command::new(&executable)
                    .arg(path)
                    .status()
                    .map_err(|fallback_error| {
                        format!(
                            "Packaged app file activation failed for {}: {}; exe fallback failed: {}",
                            app.name, primary_error, fallback_error
                        )
                    })?;

                if status.success() {
                    return Ok(());
                }

                return Err(format!(
                    "Packaged app file activation failed for {}: {}; exe fallback exited with status {}",
                    app.name, primary_error, status
                ));
            }

            Err(format!(
                "Packaged app file activation failed for {}: {}",
                app.name, primary_error
            ))
        }
    }
}


#[cfg(windows)]
fn resolve_existing_windowsapps_executable(pattern_or_path: &str, executable_name: &str) -> Option<String> {
    let trimmed = pattern_or_path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }

    if !trimmed.contains('*') {
        return Path::new(trimmed)
            .exists()
            .then(|| trimmed.to_string());
    }

    let Some(windowsapps_index) = trimmed.to_ascii_lowercase().find("\\windowsapps\\") else {
        return None;
    };
    let root = &trimmed[..windowsapps_index + "\\WindowsApps\\".len()];
    let suffix = trimmed[windowsapps_index + "\\WindowsApps\\".len()..].to_string();
    let Some(prefix_end) = suffix.find('*') else {
        return None;
    };
    let prefix = &suffix[..prefix_end];

    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let folder_name = entry.file_name().to_string_lossy().to_string();
            if !folder_name.starts_with(prefix) {
                continue;
            }

            let candidate = entry.path().join(executable_name);
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }

    None
}

#[cfg(windows)]
fn resolve_builtin_openwith_shell_target(name: &str, handler_id: Option<&str>, path_hint: Option<&str>) -> Option<String> {
    let normalized_name = name.to_ascii_lowercase();
    let normalized_handler = handler_id.unwrap_or_default().to_ascii_lowercase();
    let normalized_path_hint = path_hint.unwrap_or_default().trim().trim_matches('"').to_string();

    if normalized_name.contains("photos") || normalized_handler == "photos" || normalized_handler.contains("microsoft.windows.photos") {
        if let Some(candidate) = resolve_existing_windowsapps_executable(&normalized_path_hint, "PhotosApp.exe") {
            return Some(candidate);
        }
        if let Some(handler_path) = handler_id.and_then(|value| Path::new(value).exists().then(|| value.to_string())) {
            return Some(handler_path);
        }
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            let windows_apps = Path::new(&program_files).join("WindowsApps");
            if let Ok(entries) = fs::read_dir(&windows_apps) {
                for entry in entries.flatten() {
                    let photos_app = entry.path().join("PhotosApp.exe");
                    if photos_app.exists() {
                        return Some(photos_app.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    if normalized_name.contains("media player") || normalized_name.contains("mediaplayer") || normalized_handler.contains("microsoft.zunemusic") || normalized_handler.contains("windows.media.player") {
        if let Some(candidate) = resolve_existing_windowsapps_executable(&normalized_path_hint, "MediaPlayer.exe") {
            return Some(candidate);
        }
        if let Some(candidate) = resolve_existing_windowsapps_executable(r#"C:\Program Files\WindowsApps\Microsoft.ZuneMusic_*\MediaPlayer.exe"#, "MediaPlayer.exe") {
            return Some(candidate);
        }
    }

    if normalized_name.contains("clipchamp") || normalized_handler.contains("clipchamp") {
        if let Some(candidate) = resolve_existing_windowsapps_executable(&normalized_path_hint, "Clipchamp.exe") {
            return Some(candidate);
        }
        if let Some(candidate) = resolve_existing_windowsapps_executable(r#"C:\Program Files\WindowsApps\Clipchamp.Clipchamp_*\Clipchamp.exe"#, "Clipchamp.exe") {
            return Some(candidate);
        }
    }

    if normalized_name == "notepad" || normalized_handler.contains("windowsnotepad") || normalized_handler.contains("microsoft.windowsnotepad") {
        if let Some(handler_path) = handler_id.and_then(|value| Path::new(value).exists().then(|| value.to_string())) {
            return Some(handler_path);
        }
        let system_notepad = r#"C:\Windows\System32\notepad.exe"#;
        if Path::new(system_notepad).exists() {
            return Some(system_notepad.to_string());
        }
        if let Some(candidate) = resolve_existing_windowsapps_executable(r#"C:\Program Files\WindowsApps\Microsoft.WindowsNotepad_*\Notepad.exe"#, "Notepad.exe") {
            return Some(candidate);
        }
    }

    if normalized_name == "paint" || normalized_handler.contains("microsoft.paint") || normalized_handler.contains("mspaint") {
        if let Some(handler_path) = handler_id.and_then(|value| Path::new(value).exists().then(|| value.to_string())) {
            return Some(handler_path);
        }
        let candidate = r#"C:\Windows\System32\mspaint.exe"#;
        if Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }

    if normalized_name.contains("snipping tool") || normalized_handler.contains("screensketch") || normalized_handler.contains("snippingtool") {
        if let Some(handler_path) = handler_id.and_then(|value| Path::new(value).exists().then(|| value.to_string())) {
            return Some(handler_path);
        }
        let candidate = r#"C:\Windows\System32\SnippingTool.exe"#;
        if Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }

    path_hint
        .map(|value| value.trim().trim_matches('"').to_string())
        .filter(|value| !value.is_empty() && Path::new(value).exists())
}

#[cfg(windows)]
fn normalize_openwith_app_name(name: &str) -> String {
    let normalized = name.trim();
    if normalized.is_empty() {
        return String::new();
    }

    let lower = normalized.to_ascii_lowercase();
    if lower.contains("photos") || normalized.contains("Ảnh") {
        return "Photos".to_string();
    }
    if lower == "mspaint" || lower.contains("paint") {
        return "Paint".to_string();
    }
    if lower.contains("snipping tool") || lower.contains("screen sketch") {
        return "Snipping Tool".to_string();
    }

    normalized.to_string()
}

#[cfg(windows)]
fn get_builtin_openwith_icon_hint(name: &str, handler_id: Option<&str>) -> Option<String> {
    let normalized_name = name.to_ascii_lowercase();
    let normalized_handler = handler_id.unwrap_or_default().to_ascii_lowercase();

    if normalized_name.contains("photos") || normalized_handler == "photos" || normalized_handler.contains("microsoft.windows.photos") {
        return resolve_existing_windowsapps_executable(r#"C:\Program Files\WindowsApps\Microsoft.Windows.Photos_*\PhotosApp.exe"#, "PhotosApp.exe")
            .or_else(|| handler_id.and_then(|value| Path::new(value).exists().then(|| value.to_string())))
            .or_else(|| Some(r#"C:\Program Files\WindowsApps\Microsoft.Windows.Photos_*\PhotosApp.exe"#.to_string()));
    }
    if normalized_name.contains("media player") || normalized_name.contains("mediaplayer") || normalized_handler.contains("microsoft.zunemusic") || normalized_handler.contains("windows.media.player") {
        return resolve_existing_windowsapps_executable(r#"C:\Program Files\WindowsApps\Microsoft.ZuneMusic_*\MediaPlayer.exe"#, "MediaPlayer.exe")
            .or_else(|| Some(r#"C:\Program Files\WindowsApps\Microsoft.ZuneMusic_*\MediaPlayer.exe"#.to_string()));
    }
    if normalized_name.contains("clipchamp") || normalized_handler.contains("clipchamp") {
        return resolve_existing_windowsapps_executable(r#"C:\Program Files\WindowsApps\Clipchamp.Clipchamp_*\Clipchamp.exe"#, "Clipchamp.exe")
            .or_else(|| Some(r#"C:\Program Files\WindowsApps\Clipchamp.Clipchamp_*\Clipchamp.exe"#.to_string()));
    }
    if normalized_name == "notepad" || normalized_handler.contains("windowsnotepad") || normalized_handler.contains("microsoft.windowsnotepad") {
        return handler_id
            .and_then(|value| Path::new(value).exists().then(|| value.to_string()))
            .or_else(|| Some(r#"C:\Windows\System32\notepad.exe"#.to_string()))
            .or_else(|| Some(r#"C:\Program Files\WindowsApps\Microsoft.WindowsNotepad_*\Notepad.exe"#.to_string()));
    }
    if normalized_name == "paint" || normalized_handler.contains("microsoft.paint") || normalized_handler.contains("mspaint") {
        return handler_id
            .and_then(|value| Path::new(value).exists().then(|| value.to_string()))
            .or_else(|| Some(r#"C:\Windows\System32\mspaint.exe"#.to_string()));
    }
    if normalized_name.contains("snipping tool") || normalized_handler.contains("snippingtool") || normalized_handler.contains("screensketch") {
        return handler_id
            .and_then(|value| Path::new(value).exists().then(|| value.to_string()))
            .or_else(|| Some(r#"C:\Windows\System32\SnippingTool.exe"#.to_string()));
    }

    None
}

#[cfg(windows)]
fn is_windows_explorer_worthy_openwith_app(app: &OpenWithApp) -> bool {
    let name = app.name.trim();
    if name.is_empty() {
        return false;
    }

    let normalized_name = name.to_ascii_lowercase();
    let normalized_handler = app.handler_id.as_deref().unwrap_or_default().to_ascii_lowercase();
    let normalized_path = app.path.to_ascii_lowercase();

    if normalized_name.contains("search the microsoft store") || normalized_handler.contains("search the microsoft store") {
        return false;
    }
    if normalized_name.contains("look for an app in the store") || normalized_handler.contains("windows.store") {
        return false;
    }
    if normalized_path.contains("url.dll") || normalized_path.contains("shell32.dll") {
        return false;
    }
    if normalized_name.contains("aalab found") {
        return false;
    }

    true
}

#[cfg(windows)]
fn is_openwith_app_persistable(app: &OpenWithApp) -> bool {
    canonical_openwith_identity(app).is_some()
        || app.handler_id.as_deref().map(|value| !value.trim().is_empty()).unwrap_or(false)
        || Path::new(&app.path).exists()
}

#[cfg(windows)]
fn canonical_openwith_identity(app: &OpenWithApp) -> Option<String> {
    app.app_user_model_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_ascii_lowercase())
        .or_else(|| app.package_family_name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("pfn:{}", value.to_ascii_lowercase())))
        .or_else(|| app.launch_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("exe:{}", value.to_ascii_lowercase())))
        .or_else(|| app.handler_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("handler:{}", value.to_ascii_lowercase())))
        .or_else(|| {
            let path = app.path.trim();
            (!path.is_empty()).then(|| format!("path:{}", path.to_ascii_lowercase()))
        })
}

#[cfg(windows)]
fn canonical_openwith_identity_from_fields(
    app_user_model_id: Option<&str>,
    package_family_name: Option<&str>,
    launch_path: Option<&str>,
    handler_id: Option<&str>,
    path: Option<&str>,
) -> Option<String> {
    app_user_model_id
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_ascii_lowercase())
        .or_else(|| package_family_name
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("pfn:{}", value.to_ascii_lowercase())))
        .or_else(|| launch_path
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("exe:{}", value.to_ascii_lowercase())))
        .or_else(|| handler_id
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("handler:{}", value.to_ascii_lowercase())))
        .or_else(|| path
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("path:{}", value.to_ascii_lowercase())))
}

#[cfg(windows)]
fn dedupe_openwith_apps(apps: Vec<OpenWithApp>) -> Vec<OpenWithApp> {
    let mut deduped = Vec::new();
    for mut app in apps {
        app.name = normalize_openwith_app_name(&app.name);
        let key = canonical_openwith_identity(&app);
        let Some(key) = key else {
            continue;
        };
        if deduped.iter().any(|existing: &OpenWithApp| {
            canonical_openwith_identity(existing)
                .map(|existing_key| existing_key == key)
                .unwrap_or(false)
        }) {
            continue;
        }
        if is_windows_explorer_worthy_openwith_app(&app) {
            deduped.push(app);
        }
    }
    deduped
}

#[cfg(windows)]
fn get_windows_default_app_for_extension(extension: &str) -> Option<OpenWithApp> {
    let executable = query_assoc_string(extension, ASSOCSTR_EXECUTABLE)?;
    let friendly_name = query_assoc_string(extension, ASSOCSTR_FRIENDLYAPPNAME)
        .or_else(|| Path::new(&executable).file_stem().and_then(|s| s.to_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| executable.clone());

    let mut app = OpenWithApp {
        name: friendly_name,
        path: executable.clone(),
        handler_id: None,
        icon_path: Some(executable.clone()),
        launch_path: Some(executable),
        icon_index: Some(0),
        icon_data_url: None,
        source: Some("windows-shell".to_string()),
        package_family_name: None,
        app_user_model_id: None,
        package_full_name: None,
        manifest_path: None,
        is_packaged: Some(false),
    };
    enrich_packaged_openwith_app(&mut app);
    Some(app)
}

#[cfg(windows)]
fn enumerate_open_with_handlers(extension: &str, recommended_only: bool) -> Result<Vec<OpenWithApp>, String> {
    let _com = ComApartment::init()?;
    let extension_wide = wide_null(extension);

    let enum_handlers = unsafe {
        SHAssocEnumHandlers(
            PCWSTR(extension_wide.as_ptr()),
            if recommended_only { ASSOC_FILTER_RECOMMENDED } else { ASSOC_FILTER_NONE },
        )
        .map_err(|e| format!("Failed to enumerate association handlers: {}", e))?
    };

    let mut apps = Vec::new();
    loop {
        let mut fetched = 0u32;
        let mut handlers: [Option<IAssocHandler>; 1] = [None];
        let result = unsafe { enum_handlers.Next(&mut handlers, Some(&mut fetched)) };
        if result.is_err() || fetched == 0 {
            break;
        }

        let Some(handler) = handlers.into_iter().next().flatten() else {
            continue;
        };

        let handler_id = unsafe { handler.GetName() }
            .map(pwstr_to_string_and_free)
            .unwrap_or_default();
        let ui_name = unsafe { handler.GetUIName() }
            .map(pwstr_to_string_and_free)
            .unwrap_or_else(|_| handler_id.clone());

        let mut icon_pwstr = PWSTR::null();
        let mut icon_index_raw = 0i32;
        let icon_location_raw = unsafe {
            if handler.GetIconLocation(&mut icon_pwstr, &mut icon_index_raw).is_ok() {
                pwstr_to_string_and_free(icon_pwstr)
            } else {
                String::new()
            }
        };

        // Resolve the icon location immediately. `IAssocHandler::GetIconLocation`
        // can return a Shell "indirect string" (e.g. for UWP / MSIX apps) of the
        // form `@{PackageFullName?ms-resource://...}` — `SHLoadIndirectString`
        // is the only API that turns that into a real on-disk path. Doing it
        // here means every downstream icon extractor can treat icon_path as a
        // plain path, no per-extractor fallback required.
        let resolved_icon_location = if icon_location_raw.trim_start().starts_with('@') {
            resolve_indirect_string(&icon_location_raw).unwrap_or(icon_location_raw)
        } else {
            icon_location_raw
        };

        let (raw_icon_path, icon_index) = if resolved_icon_location.trim().is_empty() {
            (None, None)
        } else {
            let (path, parsed_index) = normalize_shell_icon_location(&resolved_icon_location);
            (path, parsed_index.or(Some(icon_index_raw)))
        };

        let normalized_name = normalize_openwith_app_name(&ui_name);
        let hinted_shell_target = resolve_builtin_openwith_shell_target(&normalized_name, Some(&handler_id), raw_icon_path.as_deref());
        let hinted_icon_path = get_builtin_openwith_icon_hint(&normalized_name, Some(&handler_id));
        let icon_path = hinted_shell_target.clone().or(hinted_icon_path).or(raw_icon_path);
        let launch_path = hinted_shell_target
            .clone()
            .or_else(|| icon_path
                .clone()
                .filter(|value| Path::new(value).exists() && value.to_ascii_lowercase().ends_with(".exe")));
        let display_path = launch_path
            .clone()
            .or_else(|| icon_path.clone().filter(|value| !value.trim().is_empty()))
            .unwrap_or_else(|| handler_id.clone());
        let mut app = OpenWithApp {
            name: if normalized_name.trim().is_empty() {
                handler_id.clone()
            } else {
                normalized_name
            },
            path: display_path,
            handler_id: if handler_id.trim().is_empty() { None } else { Some(handler_id) },
            icon_path,
            launch_path,
            icon_index,
            icon_data_url: None,
            source: Some("windows-shell".to_string()),
            package_family_name: None,
            app_user_model_id: None,
            package_full_name: None,
            manifest_path: None,
            is_packaged: Some(false),
        };
        enrich_packaged_openwith_app(&mut app);

        let dedupe_key = canonical_openwith_identity(&app);
        if let Some(dedupe_key) = dedupe_key {
            if !apps.iter().any(|existing: &OpenWithApp| {
                canonical_openwith_identity(existing)
                    .map(|existing_key| existing_key == dedupe_key)
                    .unwrap_or(false)
            }) {
                apps.push(app);
            }
        }
    }

    Ok(dedupe_openwith_apps(apps))
}

#[cfg(windows)]
fn get_open_with_shell_candidates_for_extension(extension: &str, recommended_only: bool) -> Result<Vec<OpenWithApp>, String> {
    enumerate_open_with_handlers(extension, recommended_only)
}

#[cfg(windows)]
fn create_shell_data_object_for_path(path: &str) -> Result<IDataObject, String> {
    let file_wide = wide_null(path);
    let item: IShellItem = unsafe {
        SHCreateItemFromParsingName(PCWSTR(file_wide.as_ptr()), None)
            .map_err(|e| format!("Failed to create shell item for handler invoke: {}", e))?
    };

    unsafe {
        item.BindToHandler::<Option<&windows::Win32::System::Com::IBindCtx>, IDataObject>(None, &BHID_DataObject)
            .map_err(|e| format!("Failed to bind data object for handler invoke: {}", e))
    }
}

#[cfg(windows)]
fn find_shell_handler_for_app(extension: &str, app: &OpenWithApp) -> Result<Option<IAssocHandler>, String> {
    let _com = ComApartment::init()?;
    let extension_wide = wide_null(extension);

    let enum_handlers = unsafe {
        SHAssocEnumHandlers(PCWSTR(extension_wide.as_ptr()), ASSOC_FILTER_NONE)
            .map_err(|e| format!("Failed to enumerate association handlers: {}", e))?
    };

    let target_identity = canonical_openwith_identity(app).or_else(|| {
        canonical_openwith_identity_from_fields(
            app.app_user_model_id.as_deref(),
            app.package_family_name.as_deref(),
            app.launch_path.as_deref(),
            app.handler_id.as_deref(),
            Some(app.path.as_str()),
        )
    });

    let target_fallback_key = app
        .handler_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_ascii_lowercase())
        .or_else(|| (!app.path.trim().is_empty()).then(|| app.path.to_ascii_lowercase()));

    loop {
        let mut fetched = 0u32;
        let mut handlers: [Option<IAssocHandler>; 1] = [None];
        let result = unsafe { enum_handlers.Next(&mut handlers, Some(&mut fetched)) };
        if result.is_err() || fetched == 0 {
            break;
        }

        let Some(handler) = handlers.into_iter().next().flatten() else {
            continue;
        };

        let handler_id = unsafe { handler.GetName() }
            .map(pwstr_to_string_and_free)
            .unwrap_or_default();
        let ui_name = unsafe { handler.GetUIName() }
            .map(pwstr_to_string_and_free)
            .unwrap_or_else(|_| handler_id.clone());

        let mut icon_pwstr = PWSTR::null();
        let mut icon_index_raw = 0i32;
        let icon_location_raw = unsafe {
            if handler.GetIconLocation(&mut icon_pwstr, &mut icon_index_raw).is_ok() {
                pwstr_to_string_and_free(icon_pwstr)
            } else {
                String::new()
            }
        };
        // Same indirect-string resolution as in enumerate_open_with_handlers.
        let resolved_icon_location = if icon_location_raw.trim_start().starts_with('@') {
            resolve_indirect_string(&icon_location_raw).unwrap_or(icon_location_raw)
        } else {
            icon_location_raw
        };
        let (raw_icon_path, parsed_icon_index) = if resolved_icon_location.trim().is_empty() {
            (None, None)
        } else {
            normalize_shell_icon_location(&resolved_icon_location)
        };

        let normalized_name = normalize_openwith_app_name(&ui_name);
        let hinted_shell_target = resolve_builtin_openwith_shell_target(&normalized_name, Some(&handler_id), raw_icon_path.as_deref());
        let hinted_icon_path = get_builtin_openwith_icon_hint(&normalized_name, Some(&handler_id));
        let icon_path = hinted_shell_target.clone().or(hinted_icon_path).or(raw_icon_path);
        let launch_path = hinted_shell_target
            .clone()
            .or_else(|| icon_path
                .clone()
                .filter(|value| Path::new(value).exists() && value.to_ascii_lowercase().ends_with(".exe")));
        let display_path = launch_path
            .clone()
            .or_else(|| icon_path.clone().filter(|value| !value.trim().is_empty()))
            .unwrap_or_else(|| handler_id.clone());

        let mut candidate = OpenWithApp {
            name: if normalized_name.trim().is_empty() {
                handler_id.clone()
            } else {
                normalized_name
            },
            path: display_path,
            handler_id: if handler_id.trim().is_empty() { None } else { Some(handler_id.clone()) },
            icon_path,
            launch_path,
            icon_index: parsed_icon_index.or(Some(icon_index_raw)),
            icon_data_url: None,
            source: Some("windows-shell".to_string()),
            package_family_name: None,
            app_user_model_id: None,
            package_full_name: None,
            manifest_path: None,
            is_packaged: Some(false),
        };
        enrich_packaged_openwith_app(&mut candidate);

        let candidate_identity = canonical_openwith_identity(&candidate).or_else(|| {
            canonical_openwith_identity_from_fields(
                candidate.app_user_model_id.as_deref(),
                candidate.package_family_name.as_deref(),
                candidate.launch_path.as_deref(),
                candidate.handler_id.as_deref(),
                Some(candidate.path.as_str()),
            )
        });

        let identity_matches = match (&target_identity, &candidate_identity) {
            (Some(target_identity), Some(candidate_identity)) => target_identity == candidate_identity,
            _ => false,
        };

        let fallback_key = candidate
            .handler_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.to_ascii_lowercase())
            .or_else(|| (!candidate.path.trim().is_empty()).then(|| candidate.path.to_ascii_lowercase()));

        let fallback_matches = match (&target_fallback_key, &fallback_key) {
            (Some(target_key), Some(candidate_key)) => target_key == candidate_key,
            _ => false,
        };

        if identity_matches || fallback_matches {
            return Ok(Some(handler));
        }
    }

    Ok(None)
}

#[cfg(windows)]
fn invoke_shell_handler_directly(path: &str, app: &OpenWithApp) -> Result<(), String> {
    let extension = normalize_extension(path)
        .ok_or_else(|| format!("Open With requires a file extension: {}", path))?;
    let _com = ComApartment::init()?;
    let handler = find_shell_handler_for_app(&extension, app)?
        .ok_or_else(|| format!("Could not resolve Shell handler for {}", app.name))?;
    let data_object = create_shell_data_object_for_path(path)?;

    unsafe {
        handler
            .Invoke(&data_object)
            .map_err(|e| format!("Failed to invoke Shell handler for {}: {}", app.name, e))
    }
}

#[cfg(windows)]
fn invoke_shell_handler_for_path(path: &str, app: &OpenWithApp) -> Result<(), String> {
    if app.source.as_deref() == Some("windows-shell") {
        if invoke_shell_handler_directly(path, app).is_ok() {
            return Ok(());
        }
    }

    if app.is_packaged.unwrap_or(false) || canonical_openwith_identity(app)
        .map(|identity| identity.contains('!') || identity.starts_with("pfn:") || identity.starts_with("handler:"))
        .unwrap_or(false)
    {
        if activate_packaged_app_for_file(path, app).is_ok() {
            return Ok(());
        }
    }

    let launch_target = app
        .launch_path
        .as_deref()
        .filter(|value| Path::new(value).exists() && value.to_ascii_lowercase().ends_with(".exe"))
        .or_else(|| app
            .icon_path
            .as_deref()
            .filter(|value| Path::new(value).exists() && value.to_ascii_lowercase().ends_with(".exe")))
        .or_else(|| Path::new(&app.path).exists().then_some(app.path.as_str()))
        .ok_or_else(|| format!("Handler is not directly launchable: {}", app.name))?;

    launch_process_with_path(launch_target, path)
}

#[cfg(windows)]
fn find_openwith_app_by_identity(apps: &[OpenWithApp], target: &OpenWithApp) -> Option<OpenWithApp> {
    let target_key = canonical_openwith_identity(target).or_else(|| {
        canonical_openwith_identity_from_fields(
            target.app_user_model_id.as_deref(),
            target.package_family_name.as_deref(),
            target.launch_path.as_deref(),
            target.handler_id.as_deref(),
            Some(target.path.as_str()),
        )
    });
    let Some(target_key) = target_key else {
        return None;
    };

    apps.iter()
        .find(|entry| {
            canonical_openwith_identity(entry)
                .map(|entry_key| entry_key == target_key)
                .unwrap_or(false)
        })
        .cloned()
}

#[cfg(windows)]
fn resolve_open_with_association(path: &str) -> Result<Option<OpenWithAssociation>, String> {
    let ext = match normalize_extension(path) {
        Some(ext) => ext,
        None => return Ok(None),
    };

    let all_candidates = get_open_with_shell_candidates_for_extension(&ext, false)?;
    let system_default = get_windows_default_app_for_extension(&ext)
        .and_then(|default_app| find_openwith_app_by_identity(&all_candidates, &default_app).or(Some(default_app)));

    let associations = load_openwith_associations()?;
    if let Some(app) = associations.get(&ext) {
        if is_openwith_app_persistable(app) {
            let resolved_app = find_openwith_app_by_identity(&all_candidates, app).unwrap_or_else(|| app.clone());
            return Ok(Some(OpenWithAssociation {
                extension: ext,
                app: resolved_app,
                source: "custom".to_string(),
            }));
        }
    }

    Ok(system_default.map(|app| OpenWithAssociation {
        extension: ext,
        app,
        source: "system".to_string(),
    }))
}

#[cfg(windows)]
#[command]
fn open_path_with_application(path: String, app_path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if is_reparse_point(target) {
        return Err("Cannot open: this is a system junction or symbolic link point".to_string());
    }
    let app = Path::new(&app_path);
    if !app.exists() {
        return Err(format!("Application does not exist: {}", app_path));
    }

    Command::new(&app_path)
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to launch application: {}", e))?;
    Ok(())
}

#[cfg(windows)]
#[command]
fn open_path_with_handler(path: String, app: OpenWithApp) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if is_reparse_point(target) {
        return Err("Cannot open: this is a system junction or symbolic link point".to_string());
    }

    invoke_shell_handler_for_path(&path, &app)
}

#[cfg(not(windows))]
#[command]
fn open_path_with_application(_path: String, _app_path: String) -> Result<(), String> {
    Err("Open with is currently supported on Windows only".to_string())
}

#[cfg(not(windows))]
#[command]
fn open_path_with_handler(_path: String, _app: OpenWithApp) -> Result<(), String> {
    Err("Open with is currently supported on Windows only".to_string())
}

#[cfg(windows)]
#[command]
fn show_open_with_dialog(path: String) -> Result<Option<OpenWithApp>, String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Choose application'
$dialog.Filter = 'Applications (*.exe)|*.exe|All files (*.*)|*.*'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  $fullPath = $dialog.FileName
  $name = [System.IO.Path]::GetFileNameWithoutExtension($fullPath)
  Write-Output ($name + '||' + $fullPath)
}
"#;

    let output = hidden_command("powershell")
        .args(["-NoProfile", "-STA", "-Command", script])
        .output()
        .map_err(|e| format!("Failed to open chooser: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Open with dialog failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(None);
    }

    let mut parts = stdout.splitn(2, "||");
    let name = parts.next().unwrap_or("").trim().to_string();
    let app_path = parts.next().unwrap_or("").trim().to_string();
    if app_path.is_empty() {
        return Ok(None);
    }

    Ok(Some(OpenWithApp {
        name: if name.is_empty() {
            Path::new(&app_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Selected app")
                .to_string()
        } else {
            name
        },
        path: app_path.clone(),
        handler_id: None,
        icon_path: Some(app_path.clone()),
        launch_path: Some(app_path.clone()),
        icon_index: Some(0),
        icon_data_url: None,
        source: Some("custom".to_string()),
        package_family_name: None,
        app_user_model_id: None,
        package_full_name: None,
        manifest_path: None,
        is_packaged: Some(false),
    }))
}

#[cfg(not(windows))]
#[command]
fn show_open_with_dialog(_path: String) -> Result<Option<OpenWithApp>, String> {
    Err("Open with is currently supported on Windows only".to_string())
}

#[cfg(windows)]
#[command]
fn get_open_with_association(path: String) -> Result<Option<OpenWithAssociation>, String> {
    resolve_open_with_association(&path)
}

#[cfg(not(windows))]
#[command]
fn get_open_with_association(_path: String) -> Result<Option<OpenWithAssociation>, String> {
    Ok(None)
}

#[cfg(windows)]
#[command]
fn set_open_with_association(extension: String, app: OpenWithApp) -> Result<(), String> {
    if extension.trim().is_empty() {
        return Err("Extension is required".to_string());
    }
    if !is_openwith_app_persistable(&app) {
        return Err(format!("Application does not exist: {}", app.path));
    }

    let normalized = if extension.starts_with('.') {
        extension.to_lowercase()
    } else {
        format!(".{}", extension.to_lowercase())
    };

    let mut associations = load_openwith_associations()?;
    associations.insert(normalized, app);
    save_openwith_associations(&associations)
}

#[cfg(not(windows))]
#[command]
fn set_open_with_association(_extension: String, _app: OpenWithApp) -> Result<(), String> {
    Err("Open with is currently supported on Windows only".to_string())
}

#[cfg(windows)]
#[command]
fn clear_open_with_association(extension: String) -> Result<(), String> {
    let normalized = if extension.starts_with('.') {
        extension.to_lowercase()
    } else {
        format!(".{}", extension.to_lowercase())
    };

    let mut associations = load_openwith_associations()?;
    associations.remove(&normalized);
    save_openwith_associations(&associations)
}

#[cfg(windows)]
#[command]
fn get_open_with_candidates(path: String) -> Result<OpenWithCandidateResponse, String> {
    let extension = normalize_extension(&path);
    let Some(ext) = extension.clone() else {
        return Ok(OpenWithCandidateResponse {
            extension: None,
            default_app: None,
            recommended_apps: Vec::new(),
            all_apps: Vec::new(),
        });
    };

    let association = resolve_open_with_association(&path)?;
    let mut recommended_apps = dedupe_openwith_apps(get_open_with_shell_candidates_for_extension(&ext, true)?);
    let mut all_apps = dedupe_openwith_apps(get_open_with_shell_candidates_for_extension(&ext, false)?);
    let default_app = get_windows_default_app_for_extension(&ext)
        .and_then(|default_entry| find_openwith_app_by_identity(&all_apps, &default_entry).or(Some(default_entry)));

    let associations = load_openwith_associations()?;
    if let Some(custom_app) = associations.get(&ext).cloned() {
        let custom_identity = canonical_openwith_identity(&custom_app);
        if !all_apps.iter().any(|entry| {
            match (&custom_identity, canonical_openwith_identity(entry)) {
                (Some(custom_identity), Some(entry_identity)) => entry_identity == *custom_identity,
                _ => entry.handler_id.clone().unwrap_or_else(|| entry.path.clone()).eq_ignore_ascii_case(
                    &custom_app.handler_id.clone().unwrap_or_else(|| custom_app.path.clone())
                ),
            }
        }) {
            all_apps.insert(0, custom_app.clone());
        }
        if !recommended_apps.iter().any(|entry| {
            match (&custom_identity, canonical_openwith_identity(entry)) {
                (Some(custom_identity), Some(entry_identity)) => entry_identity == *custom_identity,
                _ => entry.handler_id.clone().unwrap_or_else(|| entry.path.clone()).eq_ignore_ascii_case(
                    &custom_app.handler_id.clone().unwrap_or_else(|| custom_app.path.clone())
                ),
            }
        }) {
            recommended_apps.insert(0, custom_app);
        }
    }

    let selected_association = association.or_else(|| {
        default_app.clone().map(|app| OpenWithAssociation {
            extension: ext.clone(),
            app,
            source: "system".to_string(),
        })
    });

    if let Some(selected) = selected_association.as_ref() {
        let selected_identity = canonical_openwith_identity(&selected.app);
        if !all_apps.iter().any(|entry| {
            match (&selected_identity, canonical_openwith_identity(entry)) {
                (Some(selected_identity), Some(entry_identity)) => entry_identity == *selected_identity,
                _ => entry.handler_id.clone().unwrap_or_else(|| entry.path.clone()).eq_ignore_ascii_case(
                    &selected.app.handler_id.clone().unwrap_or_else(|| selected.app.path.clone())
                ),
            }
        }) {
            all_apps.insert(0, selected.app.clone());
        }
        if !recommended_apps.iter().any(|entry| {
            match (&selected_identity, canonical_openwith_identity(entry)) {
                (Some(selected_identity), Some(entry_identity)) => entry_identity == *selected_identity,
                _ => entry.handler_id.clone().unwrap_or_else(|| entry.path.clone()).eq_ignore_ascii_case(
                    &selected.app.handler_id.clone().unwrap_or_else(|| selected.app.path.clone())
                ),
            }
        }) {
            recommended_apps.insert(0, selected.app.clone());
        }
    }

    recommended_apps = dedupe_openwith_apps(recommended_apps);
    all_apps = dedupe_openwith_apps(all_apps);

    let response = OpenWithCandidateResponse {
        extension: Some(ext),
        default_app,
        recommended_apps,
        all_apps,
    };
    maybe_write_openwith_debug_dump(&path, &response);
    Ok(response)
}

#[cfg(not(windows))]
#[command]
fn get_open_with_candidates(_path: String) -> Result<OpenWithCandidateResponse, String> {
    Ok(OpenWithCandidateResponse {
        extension: None,
        default_app: None,
        recommended_apps: Vec::new(),
        all_apps: Vec::new(),
    })
}

#[cfg(windows)]
#[command]
fn debug_dump_open_with(path: String) -> Result<String, String> {
    let candidates = get_open_with_candidates(path.clone())?;
    let dump = OpenWithDebugDump {
        extension: normalize_extension(&path),
        default_app: candidates.default_app,
        recommended_apps: candidates.recommended_apps,
        all_apps: candidates.all_apps,
    };

    let dump_json = serde_json::to_string_pretty(&dump)
        .map_err(|e| format!("Failed to serialize debug dump: {}", e))?;

    let dump_path = std::env::temp_dir().join("goku-open-with-debug.json");
    fs::write(&dump_path, dump_json.as_bytes())
        .map_err(|e| format!("Failed to write debug dump: {}", e))?;

    Ok(dump_path.to_string_lossy().to_string())
}

#[cfg(windows)]
fn maybe_write_openwith_debug_dump(path: &str, response: &OpenWithCandidateResponse) {
    let dump = OpenWithDebugDump {
        extension: normalize_extension(path),
        default_app: response.default_app.clone(),
        recommended_apps: response.recommended_apps.clone(),
        all_apps: response.all_apps.clone(),
    };

    if let Ok(dump_json) = serde_json::to_string_pretty(&dump) {
        let dump_path = std::env::temp_dir().join("goku-open-with-debug.json");
        let _ = fs::write(dump_path, dump_json.as_bytes());
    }
}

#[cfg(not(windows))]
fn maybe_write_openwith_debug_dump(_path: &str, _response: &OpenWithCandidateResponse) {}

#[cfg(not(windows))]
#[command]
fn debug_dump_open_with(_path: String) -> Result<String, String> {
    Err("Open with debug dump is currently supported on Windows only".to_string())
}

// Get home directory path
#[command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

// Get special folder paths (Windows)
#[command]
fn get_special_folders() -> Result<std::collections::HashMap<String, String>, String> {
    let mut folders = std::collections::HashMap::new();

    if let Some(home) = dirs::home_dir() {
        let home_str = home.to_string_lossy().to_string();

        // Desktop
        if let Some(desktop) = dirs::desktop_dir() {
            folders.insert("desktop".to_string(), desktop.to_string_lossy().to_string());
        } else {
            folders.insert("desktop".to_string(), format!("{}\\Desktop", home_str));
        }

        // Documents
        if let Some(docs) = dirs::document_dir() {
            folders.insert("documents".to_string(), docs.to_string_lossy().to_string());
        } else {
            folders.insert("documents".to_string(), format!("{}\\Documents", home_str));
        }

        // Downloads
        if let Some(dl) = dirs::download_dir() {
            folders.insert("downloads".to_string(), dl.to_string_lossy().to_string());
        } else {
            folders.insert("downloads".to_string(), format!("{}\\Downloads", home_str));
        }

        // Pictures
        if let Some(pics) = dirs::picture_dir() {
            folders.insert("pictures".to_string(), pics.to_string_lossy().to_string());
        } else {
            folders.insert("pictures".to_string(), format!("{}\\Pictures", home_str));
        }

        // Videos
        if let Some(vids) = dirs::video_dir() {
            folders.insert("videos".to_string(), vids.to_string_lossy().to_string());
        } else {
            folders.insert("videos".to_string(), format!("{}\\Videos", home_str));
        }

        // Music
        if let Some(music) = dirs::audio_dir() {
            folders.insert("music".to_string(), music.to_string_lossy().to_string());
        } else {
            folders.insert("music".to_string(), format!("{}\\Music", home_str));
        }
    }

    Ok(folders)
}

// Resolve a typed address-bar path into an absolute filesystem path.
//
// Mirrors the behaviour of Windows Explorer's address bar:
//   * %AppData%            — environment variable (case-insensitive, sub-paths OK)
//   * %AppData%\Microsoft  — sub-path appended after expansion
//   * shell:Desktop        — well-known shell namespace shortcut (mapped to
//                             a KNOWNFOLDERID and resolved via SHGetKnownFolderPath)
//   * shell:CommonDownloads — same, with the trailing portion joined onto the
//                             known-folder path
//   * ::{20D04FE0-3AEA-1069-A2D8-08002B30309D} — raw GUID (My Computer / This PC
//                             and other virtual folders) resolved via
//                             SHParseDisplayName + SHGetPathFromIDListW
//
// Returns the resolved absolute path on success, or the original string when
// no rule matched (so the frontend falls back to its normal path resolution).
// Errors are only raised for malformed input — never for "this shell folder
// doesn't map to a real filesystem directory" because that's a legitimate
// result for virtual folders.
#[command]
fn resolve_address_path(input: String) -> Result<String, String> {
    let value = input.trim().to_string();
    if value.is_empty() {
        return Ok(String::new());
    }

    // Windows-only feature. On other platforms return the input unchanged so
    // the frontend continues to work.
    #[cfg(windows)]
    {
        resolve_address_path_windows(&value)
    }
    #[cfg(not(windows))]
    {
        Ok(value)
    }
}

#[cfg(windows)]
fn resolve_address_path_windows(input: &str) -> Result<String, String> {
    // Strip surrounding quotes — Explorer accepts "%AppData%" (with literal
    // quotes) when copy-pasted from a `.bat` file.
    let mut value = input.trim().to_string();
    if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        value = value[1..value.len() - 1].to_string();
    }

    // GUID form: ::{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX} with optional
    // trailing path joined onto the resolved filesystem location.
    if let Some(remainder) = value.strip_prefix("::{") {
        if let Some(close_idx) = remainder.find('}') {
            let guid_str = &remainder[..close_idx];
            let trailing = remainder[close_idx + 1..].trim_start_matches(['\\', '/']);
            if let Some(resolved) = resolve_guid(guid_str) {
                return Ok(join_with_trailing(&resolved, trailing));
            }
        }
    }

    // shell:Name — Name is matched case-insensitively against a curated
    // table of common shell names. Unrecognised names still try
    // SHParseDisplayName as a fallback (Explorer accepts far more names
    // than this table covers, e.g. "shell:User Pinned").
    if let Some(remainder) = value.strip_prefix("shell:") {
        if let Some(resolved) = resolve_shell_name(remainder) {
            return Ok(resolved);
        }
    }

    // Env-var expansion: %NAME% with optional surrounding/following path.
    if value.contains('%') {
        match expand_env_vars(&value) {
            Ok(expanded) => return Ok(expanded),
            Err(_) => {
                // Fall through to returning the original value below.
            }
        }
    }

    Ok(value)
}

#[cfg(windows)]
fn join_with_trailing(base: &str, trailing: &str) -> String {
    if trailing.is_empty() {
        return base.to_string();
    }
    let trimmed_base = base.trim_end_matches(['\\', '/']);
    let trimmed_trailing = trailing.trim_start_matches(['\\', '/']);
    format!("{}\\{}", trimmed_base, trimmed_trailing)
}

#[cfg(windows)]
fn expand_env_vars(input: &str) -> Result<String, String> {
    // Walk the string looking for `%NAME%` tokens. The match is
    // case-insensitive (Windows convention).
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            // Look for the closing '%'.
            if let Some(close_rel) = input[i + 1..].find('%') {
                let name = &input[i + 1..i + 1 + close_rel];
                // Skip empty %% (literal '%' on Windows).
                if name.is_empty() {
                    out.push('%');
                    i += 2;
                    continue;
                }
                // Case-insensitive lookup against the current process env.
                if let Some(value) = lookup_env_ci(name) {
                    out.push_str(&value);
                    i += 1 + close_rel + 1;
                    continue;
                }
                // Unknown var: return an error so the caller can fall back.
                return Err(format!("Unknown env var: {}", name));
            }
        }
        // Push the current char as-is and advance. Handles multibyte UTF-8
        // correctly because we push a `char`, not a byte.
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    Ok(out)
}

#[cfg(windows)]
fn lookup_env_ci(name: &str) -> Option<String> {
    // std::env::var is case-sensitive on Linux but case-insensitive on
    // Windows. Either way, walk the environment ourselves to be safe.
    let needle = name.to_ascii_lowercase();
    for (key, value) in std::env::vars_os() {
        if key.to_string_lossy().to_ascii_lowercase() == needle {
            return Some(value.to_string_lossy().to_string());
        }
    }
    None
}

#[cfg(windows)]
fn resolve_shell_name(remainder: &str) -> Option<String> {
    // Split optional sub-path. "shell:Personal\My Music" → name="Personal",
    // trailing="\My Music". "shell:Downloads" → name="Downloads",
    // trailing="".
    let (raw_name, trailing) = match remainder.find(['\\', '/']) {
        Some(idx) => (&remainder[..idx], remainder[idx..].trim_start_matches(['\\', '/'])),
        None => (remainder, ""),
    };
    let name = raw_name.trim();
    if name.is_empty() {
        return None;
    }

    // Case-insensitive lookup against a curated table of common shell
    // names. Names that aren't in the table fall through to the
    // SHParseDisplayName fallback below.
    let guid_str = lookup_shell_name(name)?;
    if let Some(resolved) = resolve_guid(&guid_str) {
        return Some(join_with_trailing(&resolved, trailing));
    }
    None
}

#[cfg(windows)]
fn lookup_shell_name(name: &str) -> Option<String> {
    // Curated mapping of common shell: names to KNOWNFOLDERID GUIDs.
    // The Windows API also accepts more obscure names via SHParseDisplayName
    // (handled in `resolve_guid` fallback) but the common ones need an
    // explicit map because KNOWNFOLDERID isn't queryable by friendly name.
    let n = name.to_ascii_lowercase();
    let n = n.trim();
    let guid = match n {
        "desktop" => "B4BFCC3A-DB2C-424C-B029-7FE99A87C641",
        "downloads" => "374DE290-123F-4565-9164-39C4925E467B",
        "documents" => "FDD39AD0-238F-46AF-ADB4-6C85480369C7",
        "pictures" => "B7BEDE81-DF94-4682-A7D8-57A52620B86F",
        "videos" => "18989B1D-99B5-455B-841C-AB7C74E4DDFC",
        "music" => "4BD8D571-6D19-48D3-BE97-422220080E43",
        "appdata" | "roaming" => "3EB685DB-65F9-4CF6-A03A-E3EF65729F3D",
        "local appdata" | "localappdata" => "F1B32785-6FBA-4FCF-9D55-7B8E7F157091",
        "localdocuments" => "7D1D3A04-DEBB-4115-95CF-2F29DA2920ED",
        "localdownloads" => "7D83EE9B-2244-4E70-B1F1-5B8C8F1B5E72",
        "localpictures" => "0DDD015D-B06C-45D5-8C4C-F59713854639",
        "localvideos" => "35286A68-3C57-41A1-BBB1-0EAE73D76C95",
        "localmusic" => "A0C69A99-21C8-4671-8703-7934162F7CF1D",
        "programs" => "A77F5D77-2E2B-44C3-A6A2-ABA601054A85",
        "programdata" => "62AB5D82-FDC1-4DC3-A9DD-070D1D495D7F",
        "programfiles" => "905E63B6-C1BF-494E-B29C-65B732D3D21A",
        "programfilesx86" => "7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E",
        "programfilescommon" => "F7F1ED05-9F6D-47A2-AAAE-29D317C6F066",
        "windows" | "windir" | "systemroot" => "F38BF404-1D43-42F2-9305-67DE0B28FC23",
        "system" => "1AC14E77-02E7-4E5D-B744-2EB1AE5198B7",
        "systemx86" => "D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27",
        "userprofile" => "5E6C858F-0E22-4760-9AFE-EA3317B67173",
        "home" => "5E6C858F-0E22-4760-9AFE-EA3317B67173",
        "public" => "DFDF76A2-C82A-4D63-906A-5644AC457385",
        "publicdesktop" => "C4AA340D-F20F-4863-AFEF-F87EF2E6BA25",
        "publicdocuments" => "ED4824AF-DCE4-45A8-81E2-FC7965083434",
        "publicdownloads" => "3D644C9B-1FB8-4F30-9B45-F670235F79C0",
        "startup" => "B97D20BB-F46A-4C97-BA10-5E3608430854",
        "commonstartup" => "82A5EA35-D9CD-47C5-9629-E15D2F714E6E",
        "mycomputerfolder" | "thispc" => "20D04FE0-3AEA-1069-A2D8-08002B30309D",
        "recyclebinfolder" => "B7534046-3ECB-4C18-BE4E-64CD4CB7D6AC",
        "networkfolder" => "D20BEEC4-5CA8-4905-AE3B-BF251EA32B42",
        "controlpanel" | "controlpanelfolder" => "26EE0668-A00A-44D7-9371-BEB064C92B41",
        "printers" | "printersfolder" => "76FC4E2D-D6AD-4519-A663-37BD56068185",
        "cookies" => "2B0F765D-C0E9-4171-908E-08A611B84FF6",
        "favorites" => "1777F761-68AD-4D8A-87BD-30B759FA33DD",
        "history" => "D9DC8A3B-B784-432E-A781-5A1130A75963",
        "recent" => "AE50C081-EBD2-438A-8655-8A092E34987A",
        "sendto" => "8983036C-27C0-404B-8F08-102D10DCFD74",
        "templates" => "A63293E8-664E-48DB-A079-DF759E0509F7",
        "fonts" => "FD228CB7-AE11-4AE3-864C-16F3910AB8FE",
        "personal" | "mydocuments" => "FDD39AD0-238F-46AF-ADB4-6C85480369C7",
        "mymusic" => "4BD8D571-6D19-48D3-BE97-422220080E43",
        "mypictures" => "B7BEDE81-DF94-4682-A7D8-57A52620B86F",
        "myvideo" => "18989B1D-99B5-455B-841C-AB7C74E4DDFC",
        _ => return None,
    };
    Some(guid.to_string())
}

#[cfg(windows)]
fn resolve_guid(guid_str: &str) -> Option<String> {
    use windows::core::GUID;

    let guid: GUID = parse_guid_string(guid_str)?;

    // Initialise COM for the shell API call.
    let _com_guard = ComGuard::new();

    unsafe {
        // Try SHGetKnownFolderPath first. It works for any KNOWNFOLDERID
        // and returns the canonical filesystem path. Signature in 0.58:
        //   SHGetKnownFolderPath(rfid, dwflags: KNOWN_FOLDER_FLAG, htoken: HANDLE)
        // Returns `Result<PWSTR, _>` and the caller must free via CoTaskMemFree.
        {
            use windows::Win32::UI::Shell::{KNOWN_FOLDER_FLAG, SHGetKnownFolderPath};
            use windows::Win32::Foundation::HANDLE;
            match SHGetKnownFolderPath(
                &guid,
                KNOWN_FOLDER_FLAG(0),
                HANDLE(std::ptr::null_mut()),
            ) {
                Ok(pwstr) => {
                    let wide = pwstr.as_wide();
                    let len = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
                    let path = if len > 0 {
                        String::from_utf16_lossy(&wide[..len])
                    } else {
                        String::new()
                    };
                    // SHGetKnownFolderPath allocates with CoTaskMemAlloc; free it.
                    use windows::Win32::System::Com::CoTaskMemFree;
                    CoTaskMemFree(Some(pwstr.as_ptr() as *const _));
                    if !path.is_empty() {
                        return Some(path);
                    }
                }
                Err(_) => {
                    // Fall through to SHParseDisplayName below.
                }
            }
        }

        // Fallback: parse the display name as-is. SHParseDisplayName handles
        // both raw GUIDs ("::{GUID}") and friendly names like
        // "shell:User Pinned". Signature in 0.58:
        //   SHParseDisplayName(pszname: PCWSTR, pbc: IBindCtx, ppidl: *mut *mut ITEMIDLIST,
        //                      sfgaoin: u32, psfgaoout: Option<*mut u32>)
        {
            use windows::Win32::UI::Shell::{SHParseDisplayName, Common::ITEMIDLIST};
            let display = format!("::{{{}}}", guid_str);
            let wide: Vec<u16> = display.encode_utf16().chain(std::iter::once(0)).collect();
            let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
            let hr = SHParseDisplayName(
                windows::core::PCWSTR(wide.as_ptr()),
                None,
                &mut pidl,
                0,
                None,
            );
            if hr.is_ok() && !pidl.is_null() {
                use windows::Win32::UI::Shell::SHGetPathFromIDListW;
                let mut buf = [0u16; 260];
                let ok = SHGetPathFromIDListW(pidl, &mut buf);
                use windows::Win32::System::Com::CoTaskMemFree;
                CoTaskMemFree(Some(pidl as *const _));
                if ok.as_bool() {
                    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                    return Some(String::from_utf16_lossy(&buf[..len]));
                }
            }
        }
    }

    None
}

/// Parse a Windows GUID string ("B4BFCC3A-DB2C-424C-B029-7FE99A87C641" or
/// "{...}") into a `windows::core::GUID`. The 0.58 `windows-core` crate
/// exposes `GUID::from_values` which takes the four u16 fields plus a single
/// `[u8; 8]` for the last two GUID groups — we build that byte array from
/// the 4-char + 12-char hex segments.
#[cfg(windows)]
fn parse_guid_string(s: &str) -> Option<windows::core::GUID> {
    let trimmed = s.trim().trim_matches(|c| c == '{' || c == '}').to_string();
    let parts: Vec<&str> = trimmed.split('-').collect();
    if parts.len() != 5 {
        return None;
    }
    let data1 = u32::from_str_radix(parts[0], 16).ok()?;
    let data2 = u16::from_str_radix(parts[1], 16).ok()?;
    let data3 = u16::from_str_radix(parts[2], 16).ok()?;
    if parts[3].len() != 4 {
        return None;
    }
    if parts[4].len() != 12 {
        return None;
    }

    // `data4` is a single [u8; 8] containing the third group's 2 bytes
    // followed by the final group's 6 bytes.
    let d4_hex = parts[3].as_bytes();
    let d5_hex = parts[4].as_bytes();
    let mut data4 = [0u8; 8];
    let p0 = u8::from_str_radix(std::str::from_utf8(&d4_hex[0..2]).ok()?, 16).ok()?;
    let p1 = u8::from_str_radix(std::str::from_utf8(&d4_hex[2..4]).ok()?, 16).ok()?;
    data4[0] = p0;
    data4[1] = p1;
    for i in 0..6 {
        let pair = std::str::from_utf8(&d5_hex[i * 2..i * 2 + 2]).ok()?;
        data4[2 + i] = u8::from_str_radix(pair, 16).ok()?;
    }
    Some(windows::core::GUID::from_values(data1, data2, data3, data4))
}

// Get detailed file metadata
#[derive(Debug, Serialize, Deserialize)]
pub struct FileMetadata {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub accessed: Option<String>,
    pub readonly: bool,
    pub extension: Option<String>,
}

#[derive(Debug, Serialize)]
struct OpenWithDebugDump {
    extension: Option<String>,
    default_app: Option<OpenWithApp>,
    recommended_apps: Vec<OpenWithApp>,
    all_apps: Vec<OpenWithApp>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct OpenWithApp {
    name: String,
    path: String,
    handler_id: Option<String>,
    icon_path: Option<String>,
    launch_path: Option<String>,
    icon_index: Option<i32>,
    icon_data_url: Option<String>,
    source: Option<String>,
    package_family_name: Option<String>,
    app_user_model_id: Option<String>,
    package_full_name: Option<String>,
    manifest_path: Option<String>,
    is_packaged: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
struct OpenWithAssociation {
    extension: String,
    app: OpenWithApp,
    source: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct OpenWithCandidateResponse {
    extension: Option<String>,
    default_app: Option<OpenWithApp>,
    recommended_apps: Vec<OpenWithApp>,
    all_apps: Vec<OpenWithApp>,
}

#[command]
fn get_file_metadata(path: String) -> Result<FileMetadata, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let metadata = fs::metadata(p).map_err(|e| format!("Cannot read metadata: {}", e))?;

    let name = p.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let extension = p.extension()
        .map(|e| e.to_string_lossy().to_string().to_lowercase());

    let created = metadata.created().ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).format("%Y-%m-%d %H:%M:%S").to_string());

    let modified = metadata.modified().ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).format("%Y-%m-%d %H:%M:%S").to_string());

    let accessed = metadata.accessed().ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).format("%Y-%m-%d %H:%M:%S").to_string());

    Ok(FileMetadata {
        name,
        path: path.clone(),
        size: metadata.len(),
        is_dir: metadata.is_dir(),
        created,
        modified,
        accessed,
        readonly: metadata.permissions().readonly(),
        extension,
    })
}

// Get list of drive letters (Windows)
#[command]
fn get_drives() -> Vec<String> {
    #[cfg(windows)]
    {
        use windows::Win32::Storage::FileSystem::{
            GetDriveTypeW, GetLogicalDrives,
        };

        // Build the set of real drives from GetLogicalDrives bitmask.
        let mut win_drives: Vec<String> = Vec::new();
        let bitmask = unsafe { GetLogicalDrives() };
        if bitmask == 0 {
            for letter in b'A'..=b'Z' {
                let drive = format!("{}:\\", letter as char);
                if Path::new(&drive).exists() {
                    win_drives.push(drive);
                }
            }
            return win_drives;
        }

        for letter in 0u32..26 {
            if (bitmask & (1u32 << letter)) != 0 {
                let ch = (b'A' + letter as u8) as char;
                let drive_letter: [u16; 3] = [ch as u16, b':' as u16, 0];
                let drive_type = unsafe { GetDriveTypeW(windows::core::PCWSTR(drive_letter.as_ptr())) };

                // Skip CD-ROMs with no media (drive type 5 = DRIVE_CDROM).
                if drive_type != 5 {
                    win_drives.push(format!("{}:\\", ch));
                    continue;
                }

                // For CD-ROMs, double-check whether media is present.
                if Path::new(&format!("{}:\\", ch)).exists() {
                    win_drives.push(format!("{}:\\", ch));
                }
            }
        }

        // Cross-check / augment with sysinfo::Disks. sysinfo refreshes its list
        // and can surface drives (e.g. some virtual/RAM disks) that the
        // GetLogicalDrives bitmask misses, as long as the path actually exists.
        let sysinfo_drives: Vec<String> = {
            let disks = Disks::new_with_refreshed_list();
            disks.list()
                .iter()
                .filter_map(|disk| {
                    let mount = disk.mount_point().to_string_lossy();
                    // Only accept root-level mount points that look like drive letters.
                    if mount.len() >= 3 && mount.chars().nth(1) == Some(':') {
                        let candidate = format!("{}\\",
                            mount.trim_end_matches(|c| c == '/' || c == '\\'));
                        if Path::new(&candidate).exists() {
                            Some(candidate)
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                })
                .collect()
        };

        // Merge: keep drives that are in either list AND actually exist on disk.
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut drives: Vec<String> = Vec::new();
        for d in win_drives.into_iter().chain(sysinfo_drives) {
            if seen.insert(d.clone()) && Path::new(&d).exists() {
                drives.push(d);
            }
        }
        drives.sort();
        drives
    }

    #[cfg(not(windows))]
    {
        vec!["/".to_string()]
    }
}

// ============================================================
// System Accent Color
// ============================================================
//
// Reads the user's current Windows DWM (Desktop Window Manager) accent
// color from the registry so the app can keep its orange (#ea580c)
// default in sync with whatever the user has chosen in
// Settings → Personalization → Colors.
//
// On Windows 10/11 the authoritative key is
//     HKCU\Software\Microsoft\Windows\DWM\AccentColor
// stored as a REG_DWORD in 0xAABBGGRR (little-endian ABGR).
//
// On non-Windows platforms (or if the registry is unavailable) the
// command returns None so the frontend can keep its default color.
// ============================================================

#[cfg(windows)]
fn read_dwm_accent_color() -> Option<String> {
    use windows::Win32::System::Registry::{
        RegOpenKeyExW, RegQueryValueExW, RegCloseKey, HKEY, HKEY_CURRENT_USER, KEY_READ,
        REG_VALUE_TYPE, REG_DWORD,
    };

    // Try the modern key first, then fall back to the Win8 era
    // ColorizationColor — both store 0xAABBGGRR as a REG_DWORD.
    let candidates: [(&str, &str); 2] = [
        (r"Software\Microsoft\Windows\DWM", "AccentColor"),
        (r"Software\Microsoft\Windows\DWM", "ColorizationColor"),
    ];

    for (sub_key, value_name) in candidates.iter() {
        let sub_key_wide: Vec<u16> = sub_key.encode_utf16().chain(std::iter::once(0)).collect();
        let value_wide: Vec<u16> = value_name.encode_utf16().chain(std::iter::once(0)).collect();

        let mut hkey: HKEY = HKEY(std::ptr::null_mut());
        let open_result = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(sub_key_wide.as_ptr()),
                0,
                KEY_READ,
                &mut hkey,
            )
        };
        if open_result.is_err() {
            continue;
        }

        let mut data_type = REG_VALUE_TYPE(0);
        let mut data: u32 = 0;
        let mut data_size: u32 = std::mem::size_of::<u32>() as u32;

        let query_result = unsafe {
            RegQueryValueExW(
                hkey,
                PCWSTR(value_wide.as_ptr()),
                None,
                Some(&mut data_type),
                Some(&mut data as *mut u32 as *mut u8),
                Some(&mut data_size),
            )
        };

        unsafe {
            let _ = RegCloseKey(hkey);
        }

        if query_result.is_err() {
            continue;
        }
        if data_type != REG_DWORD {
            continue;
        }

        // Convert 0xAABBGGRR -> #RRGGBB. Alpha is intentionally
        // discarded — CSS hex codes don't carry transparency.
        let r = (data & 0xFF) as u8;
        let g = ((data >> 8) & 0xFF) as u8;
        let b = ((data >> 16) & 0xFF) as u8;
        return Some(format!("#{:02x}{:02x}{:02x}", r, g, b));
    }

    None
}

#[tauri::command]
fn get_system_accent_color() -> Option<String> {
    #[cfg(windows)]
    {
        read_dwm_accent_color()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

// Reads the system double-click speed from the Windows registry.
// Returns speed in milliseconds (200 = slowest, 900 = fastest, default 500).
// Falls back to 500ms if registry read fails.
#[tauri::command]
fn get_system_double_click_speed() -> u32 {
    #[cfg(windows)]
    {
        use windows::Win32::System::Registry::{
            RegOpenKeyExW, RegQueryValueExW, RegCloseKey, HKEY_CURRENT_USER, KEY_READ,
            REG_VALUE_TYPE, REG_DWORD,
        };

        let sub_key = r"Control Panel\Mouse";
        let value_name = "DoubleClickSpeed";

        let sub_key_wide: Vec<u16> = sub_key.encode_utf16().chain(std::iter::once(0)).collect();
        let value_wide: Vec<u16> = value_name.encode_utf16().chain(std::iter::once(0)).collect();

        let mut hkey = HKEY_CURRENT_USER;
        let open_result = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                windows::core::PCWSTR(sub_key_wide.as_ptr()),
                0,
                KEY_READ,
                &mut hkey,
            )
        };

        if open_result.is_err() {
            return 500;
        }

        let mut data: u32 = 0;
        let mut data_type: REG_VALUE_TYPE = REG_VALUE_TYPE(0);
        let mut data_size: u32 = std::mem::size_of::<u32>() as u32;

        let query_result = unsafe {
            RegQueryValueExW(
                hkey,
                windows::core::PCWSTR(value_wide.as_ptr()),
                None,
                Some(&mut data_type),
                Some(&mut data as *mut u32 as *mut u8),
                Some(&mut data_size),
            )
        };

        unsafe { let _ = RegCloseKey(hkey); }

        // DoubleClickSpeed: 200 (slowest/slow) to 900 (fastest/fast)
        // Convert to milliseconds: lower value = faster double-click = shorter threshold
        // Default Windows value is 500ms
        if query_result.is_ok() && data_type == REG_DWORD {
            // Clamp to valid range
            data.max(200).min(900)
        } else {
            500
        }
    }
    #[cfg(not(windows))]
    {
        500
    }
}

// Opens the native Windows File Properties dialog for the given path.
// Uses ShellExecuteEx with SEE_MASK_INVOKEIDLIST to show the exact same
// Properties dialog that Windows Explorer displays on right-click > Properties.
#[tauri::command]
fn open_file_properties(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_INVOKEIDLIST};
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOW;
        use windows::Win32::Foundation::HWND;

        let target = std::path::Path::new(&path);
        if !target.exists() {
            return Err(format!("Path does not exist: {}", path));
        }

        let wide_path: Vec<u16> = std::ffi::OsStr::new(&path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        // verb = "properties\0"
        let verb: Vec<u16> = "properties\0".encode_utf16().collect();

        let mut info = windows::Win32::UI::Shell::SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<windows::Win32::UI::Shell::SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_INVOKEIDLIST,
            hwnd: HWND(std::ptr::null_mut()),
            lpVerb: windows::core::PCWSTR(verb.as_ptr()),
            lpFile: windows::core::PCWSTR(wide_path.as_ptr()),
            lpParameters: windows::core::PCWSTR::null(),
            lpDirectory: windows::core::PCWSTR::null(),
            nShow: SW_SHOW.0 as i32,
            ..Default::default()
        };

        unsafe {
            ShellExecuteExW(&mut info)
                .map_err(|e| format!("Failed to open file properties: {}", e))
        }
    }
    #[cfg(not(windows))]
    {
        Err("File properties dialog is only available on Windows".into())
    }
}

// Computes the total recursive size of a directory (sum of all files inside, excluding the directory entry itself).
// Returns size in bytes. Uses walkdir to traverse all subdirectories.
#[tauri::command]
fn get_folder_size(path: String) -> Result<u64, String> {
    let target = std::path::Path::new(&path);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !target.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut total: u64 = 0;
    let walker = WalkDir::new(&path)
        .min_depth(1)
        .into_iter()
        .filter_map(|e| e.ok());

    for entry in walker {
        if entry.file_type().is_file() {
            if let Ok(meta) = entry.metadata() {
                total = total.saturating_add(meta.len());
            }
        }
    }

    Ok(total)
}

// Returns system memory information for EXR cache sizing.
// Returns total RAM in bytes and a recommended max cache size (75% of total).
#[tauri::command]
fn get_system_memory_info() -> SystemMemoryInfo {
    use sysinfo::System;

    let mut sys = System::new_all();
    sys.refresh_memory();

    let total_bytes = sys.total_memory();
    let recommended_cache_mb = (total_bytes as f64 * 0.75 / (1024.0 * 1024.0)) as u64;

    SystemMemoryInfo {
        total_memory_bytes: total_bytes,
        total_memory_gb: (total_bytes as f64 / (1024.0 * 1024.0 * 1024.0)) as u32,
        recommended_cache_mb: recommended_cache_mb as u64,
    }
}

#[derive(serde::Serialize)]
struct SystemMemoryInfo {
    total_memory_bytes: u64,
    total_memory_gb: u32,
    recommended_cache_mb: u64,
}

// Get folders pinned to Windows Quick Access.
//
// Uses the official Windows Shell COM API (Shell.Application) to enumerate
// the Quick Access namespace, which contains BOTH the user-pinned items
// AND the auto-tracked frequent folders. This is exactly the same data
// shown in Windows Explorer's "Quick access" sidebar.
//
// Each item's "type" is determined by inspecting its available verbs:
//   - "Unpin from Quick access"  -> user_pinned
#[cfg(windows)]
#[derive(serde::Serialize)]
struct QuickAccessItem {
    name: String,
    path: String,
    last_accessed: u64,
}

#[cfg(windows)]
#[command]
fn get_windows_quick_access(limit: usize) -> Result<Vec<QuickAccessItem>, String> {
    use windows::Win32::System::Com::{
        CLSIDFromProgID, CoCreateInstance, CLSCTX_INPROC_SERVER, CLSCTX_LOCAL_SERVER,
    };
    use windows::Win32::UI::Shell::IShellDispatch;
    use windows::core::Interface;

    let _com_guard = ComGuard::new();

    // ProgID for Shell.Application
    let clsid = unsafe {
        match CLSIDFromProgID(windows::core::PCWSTR(
            "Shell.Application\0".encode_utf16().collect::<Vec<u16>>().as_ptr(),
        )) {
            Ok(c) => c,
            Err(_) => return Ok(Vec::new()),
        }
    };

    // Create the Shell dispatch object.
    // Try in-proc first (fast, in-process). If that fails, try local
    // server which spawns explorer.exe's COM object.
    let shell: IShellDispatch = unsafe {
        match CoCreateInstance(&clsid, None, CLSCTX_INPROC_SERVER) {
            Ok(s) => s,
            Err(_) => match CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER) {
                Ok(s) => s,
                Err(_) => return Ok(Vec::new()),
            }
        }
    };

    // The Quick Access namespace GUID
    let quick_access_path = "shell:::{679F85CB-0220-4080-B29B-5540CC05AAB6}";
    let folder = unsafe {
        let bstr = windows::core::BSTR::from(quick_access_path);
        let v: windows::core::VARIANT = bstr.into();
        match shell.NameSpace(&v) {
            Ok(f) => f,
            Err(_) => return Ok(Vec::new()),
        }
    };

    // FolderItems.Item is enough; we don't need Folder2 here.
    let items_collection = unsafe {
        match folder.Items() {
            Ok(i) => i,
            Err(_) => return Ok(Vec::new()),
        }
    };

    let count = unsafe { items_collection.Count().unwrap_or(0) };
    let mut out: Vec<QuickAccessItem> = Vec::new();

    for i in 0..count {
        if out.len() >= limit {
            break;
        }

        let item = unsafe {
            // Index must be a VT_I4 VARIANT, not a BSTR.
            let v: windows::core::VARIANT = (i as i32).into();
            match items_collection.Item(&v) {
                Ok(it) => it,
                Err(_) => continue,
            }
        };

        // Only file system folders. We do an extra filesystem check
        // because Windows Shell sometimes reports IsFolder=true for
        // container-like files (e.g. .rar archives that look like
        // folders to the Shell).
        let is_fs = unsafe { item.IsFileSystem().unwrap_or_default().as_bool() };
        let is_folder = unsafe { item.IsFolder().unwrap_or_default().as_bool() };
        if !is_fs || !is_folder {
            continue;
        }

        let name = unsafe {
            item.Name()
                .map(|b| b.to_string())
                .unwrap_or_default()
        };
        let path = unsafe {
            item.Path()
                .map(|b| b.to_string())
                .unwrap_or_default()
        };
        if name.is_empty() || path.is_empty() {
            continue;
        }

        // Confirm the path is actually a directory on disk. This filters
        // out archive files and other shell-folder lookalikes that the
        // Shell reports as IsFolder=true.
        if !std::path::Path::new(&path).is_dir() {
            continue;
        }

        // Try to get last accessed time
        let last_accessed = unsafe {
            item.ModifyDate()
                .ok()
                .map(|d| (d as i64) as u64 * 1000) // f64 days since 1899 → ms
                .unwrap_or(0)
        };

        out.push(QuickAccessItem {
            name,
            path,
            last_accessed,
        });
    }

    // Sort by last_accessed desc (most recent first)
    out.sort_by(|a, b| b.last_accessed.cmp(&a.last_accessed));
    out.truncate(limit);

    Ok(out)
}

/// Internal helper: scan a directory of .lnk files using COM ShellLink.
#[cfg(windows)]
fn scan_lnk_folder(dir: &std::path::Path, items: &mut Vec<QuickAccessItem>, limit: usize) {
    use std::time::UNIX_EPOCH;
    use windows::core::Interface;
    use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    let shell_link: IShellLinkW = match unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) } {
        Ok(sl) => sl,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if items.len() >= limit {
            break;
        }

        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("lnk") {
            continue;
        }

        let wide_path: Vec<u16> = match path.to_str() {
            Some(s) => s.encode_utf16().chain(std::iter::once(0)).collect(),
            None => continue,
        };

        // Display name from the .lnk filename stem
        let display_name = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        let target_str = unsafe {
            let persist: IPersistFile = match shell_link.cast() {
                Ok(p) => p,
                Err(_) => continue,
            };

            if persist
                .Load(windows::core::PCWSTR(wide_path.as_ptr()), windows::Win32::System::Com::STGM_READ)
                .is_err()
            {
                continue;
            }

            let mut buffer = vec![0u16; 260];
            let mut find_data: windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW = std::mem::zeroed();

            if shell_link.GetPath(&mut buffer, &mut find_data, 0).is_err() {
                continue;
            }

            let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
            if len == 0 {
                continue;
            }
            String::from_utf16_lossy(&buffer[..len])
        };

        if target_str.is_empty() {
            continue;
        }

        let target = std::path::PathBuf::from(&target_str);

        // Only include directories that still exist
        if !target.is_dir() || !target.exists() {
            continue;
        }

        let last_accessed = std::fs::metadata(&target)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        items.push(QuickAccessItem {
            name: display_name,
            path: target_str,
            last_accessed,
        });
    }
}

#[cfg(not(windows))]
#[derive(serde::Serialize)]
struct QuickAccessItem {
    name: String,
    path: String,
    last_accessed: u64,
}

#[cfg(not(windows))]
#[command]
fn get_windows_quick_access(_limit: usize) -> Result<Vec<QuickAccessItem>, String> {
    Ok(Vec::new())
}

// ============================================================
// Windows Quick Access - Pin/Unpin using wincent
// ============================================================

/// Pin a folder to Windows Quick Access (Frequent Folders)
#[cfg(windows)]
#[tauri::command]
fn pin_to_quick_access(path: String) -> Result<(), String> {
    use wincent::prelude::*;
    let manager = QuickAccessManager::new();
    manager.add_item(&path, QuickAccess::FrequentFolders, AddOptions::new())
        .map_err(|e| format!("Failed to pin to Quick Access: {}", e))?;
    println!("[QuickAccess] Pinned to Quick Access: {}", path);
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
fn pin_to_quick_access(_path: String) -> Result<(), String> {
    Err("Not supported on this platform".to_string())
}

/// Unpin a folder from Windows Quick Access
#[cfg(windows)]
#[tauri::command]
fn unpin_from_quick_access(path: String) -> Result<(), String> {
    use wincent::prelude::*;
    let manager = QuickAccessManager::new();
    manager.remove_item(&path, QuickAccess::FrequentFolders)
        .map_err(|e| format!("Failed to unpin from Quick Access: {}", e))?;
    println!("[QuickAccess] Unpinned from Quick Access: {}", path);
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
fn unpin_from_quick_access(_path: String) -> Result<(), String> {
    Err("Not supported on this platform".to_string())
}

/// Check if a path is in Windows Quick Access
#[cfg(windows)]
#[tauri::command]
fn is_in_quick_access(path: String) -> Result<bool, String> {
    use wincent::prelude::*;
    let manager = QuickAccessManager::new();
    manager.check_item_exact(&path, QuickAccess::FrequentFolders)
        .map_err(|e| format!("Failed to check Quick Access: {}", e))
}

#[cfg(not(windows))]
#[tauri::command]
fn is_in_quick_access(_path: String) -> Result<bool, String> {
    Ok(false)
}

/// Pin a folder to Windows Start Menu
#[cfg(windows)]
#[tauri::command]
fn pin_to_start_menu(path: String) -> Result<(), String> {
    // Get the folder name from the path
    let folder_name = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid path".to_string())?;

    // Start Menu Programs folder for current user
    let start_menu_dir = dirs::data_dir()
        .ok_or_else(|| "Cannot find data directory".to_string())?
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs");

    // Create the directory if it doesn't exist
    std::fs::create_dir_all(&start_menu_dir)
        .map_err(|e| format!("Failed to create Start Menu folder: {}", e))?;

    // Create a .lnk shortcut file
    let shortcut_path = start_menu_dir.join(format!("{}.lnk", folder_name));

    // Use PowerShell to create the shortcut
    let ps_script = format!(
        r#"$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('{}'); $Shortcut.TargetPath = '{}'; $Shortcut.Save()"#,
        shortcut_path.display().to_string().replace("'", "''"),
        path.replace("'", "''")
    );

    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_script])
        .output()
        .map_err(|e| format!("Failed to create shortcut: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to create Start Menu shortcut: {}", stderr));
    }

    println!("[QuickAccess] Pinned to Start Menu: {}", path);
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
fn pin_to_start_menu(_path: String) -> Result<(), String> {
    Err("Not supported on this platform".to_string())
}

/// Remove from Windows Start Menu
#[cfg(windows)]
#[tauri::command]
fn unpin_from_start_menu(path: String) -> Result<(), String> {
    use std::path::Path;

    let folder_name = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid path".to_string())?;

    let start_menu_dir = dirs::data_dir()
        .ok_or_else(|| "Cannot find data directory".to_string())?
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs");

    let shortcut_path = start_menu_dir.join(format!("{}.lnk", folder_name));

    if shortcut_path.exists() {
        std::fs::remove_file(&shortcut_path)
            .map_err(|e| format!("Failed to remove shortcut: {}", e))?;
        println!("[QuickAccess] Unpinned from Start Menu: {}", path);
    }

    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
fn unpin_from_start_menu(_path: String) -> Result<(), String> {
    Err("Not supported on this platform".to_string())
}

// ============================================================
// Folder Icon Extraction (SHGetFileInfo -> PNG)
// ============================================================

/// Single master size used for every folder icon. SHGetImageList only ships
/// 16/32/48/256 buckets, so anything else has to be downsampled. 128 is a
/// sweet spot: large enough to look crisp on hi-DPI displays (rendered at
/// 128 CSS px it covers up to 2× device pixel ratio without artifacts),
/// small enough that one cached entry costs roughly the same as two 256
/// `SHIL_JUMBO` PNGs and ships as a ~10–25 KB PNG-in-ICO payload.
#[cfg(windows)]
const FOLDER_ICON_SIZE: u32 = 128;

#[cfg(windows)]
#[derive(serde::Serialize)]
struct FolderIconResult {
/// Base64-encoded ICO data URL. None if the icon could not be extracted.
/// The embedded image is a PNG-in-ICO container at the master resolution
/// (see [`FOLDER_ICON_SIZE`]); the frontend decodes it as `image/x-icon`.
data_url: Option<String>,
    /// Master bitmap dimension — matches [`FOLDER_ICON_SIZE`]. Always the
    /// same value for every folder; the frontend is expected to downscale
    /// via `<img width>`/`<canvas>` per-view-mode rather than asking Rust
    /// to re-encode at a different size.
    size: u32,
}

/// PNG payload for a Windows stock system icon (e.g. "This PC"). Returned
/// as a base64 data URL so the frontend can hand it to `<img>` / canvas
/// exactly like a folder icon.
#[cfg(windows)]
#[derive(serde::Serialize)]
struct StockIconResult {
    data_url: Option<String>,
    size: u32,
}

/// Master bitmap dimension for stock system icons. The Windows shell only
/// ships one resolution per SIID — we ask for the largest it offers
/// (`SHGSI_LARGEICON` → 32px; Windows picks the highest available if the
/// requested size isn't on disk). The frontend downscales per view-mode.
#[cfg(windows)]
const STOCK_ICON_SIZE: u32 = 64;

/// Batch response: every entry resolves to the same `width`/`height` (the
/// master size), so the frontend can hand each one to `<img>` with no
/// per-row size lookup. `width`/`height` describe the PNG's intrinsic
/// dimensions so the caller can verify the asset before scaling.
#[cfg(windows)]
#[derive(serde::Serialize)]
struct FolderIconBatchEntry {
    path: String,
    size: u32,
    width: u32,
    height: u32,
    data_url: Option<String>,
}

#[cfg(windows)]
#[derive(Default)]
struct FolderIconCacheInner {
    /// PNG bytes keyed by `path_lower`. The master bitmap is a single fixed
    /// size (see [`FOLDER_ICON_SIZE`]) so we no longer need a per-size
    /// dimension in the key — every folder produces exactly one entry, and
    /// the frontend scales it down per view mode. This halves the cache
    /// footprint when callers used to preload both grid (256/128) and list
    /// (16) sizes.
    by_path: std::collections::HashMap<String, Vec<u8>>,
}

#[cfg(windows)]
type FolderIconCache = std::sync::Mutex<FolderIconCacheInner>;
#[cfg(windows)]
static FOLDER_ICON_CACHE: once_cell::sync::Lazy<FolderIconCache> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(FolderIconCacheInner::default()));

#[cfg(windows)]
fn lru_touch(cache: &mut FolderIconCacheInner, key: String, cap: usize) {
    // Tiny LRU. The HashMap is small (few hundred entries in typical use);
    // when it grows we drop the oldest insertion.
    if cache.by_path.len() >= cap && !cache.by_path.contains_key(&key) {
        if let Some(first) = cache.by_path.keys().next().cloned() {
            cache.by_path.remove(&first);
        }
    }
    // Refresh insertion order by removing + re-inserting.
    if let Some(v) = cache.by_path.remove(&key) {
        cache.by_path.insert(key, v);
    }
}

#[cfg(windows)]
fn get_cached_png(cache: &mut FolderIconCacheInner, key: &str) -> Option<Vec<u8>> {
    if let Some(v) = cache.by_path.get(key).cloned() {
        // Refresh LRU position.
        if let Some(v2) = cache.by_path.remove(key) {
            cache.by_path.insert(key.to_string(), v2);
        }
        return Some(v);
    }
    None
}

#[cfg(windows)]
fn put_cached_png(cache: &mut FolderIconCacheInner, key: String, png: Vec<u8>) {
    lru_touch(cache, key.clone(), 2048);
    cache.by_path.insert(key, png);
}

// ============================================================
// Folder Icon Extraction (BATCHED, with LRU cache)
// ============================================================
//
// Performance design (the old `SHGetFileInfo + LARGEICON` path was painfully
// slow on first load — see Codeguru's 20-40s benchmark for thousands of
// paths; `IShellItemImageFactory` is even slower because it touches disk for
// `desktop.ini` and per-folder thumbnails).
//
// Three optimizations stack here:
//
//   1. **Process-level LRU cache** — once a `(path, size)` resolves, the
//      resulting PNG is cached and the next call returns instantly without
//      touching the shell at all. Keeps the cache small (~2048 entries) so
//      RAM stays bounded.
//
//   2. **Fast-path default folder glyph** — most folders do NOT have a
//      custom icon. We probe `desktop.ini` once; if absent, we return the
//      generic folder PNG that lives in the system image list (one HBITMAP
//      shared across every non-customized folder). This is the same trick
//      Explorer uses: it only falls off the fast path when a folder has
//      `desktop.ini` with `IconResource=…`.
//
//   3. **Batched batch command** — `get_folder_icons_batch(paths)` accepts
//      N paths in one IPC round-trip and reuses one STA COM thread for the
//      whole batch. Saves N-1 thread spawn + CoInitialize +
//      CoUninitialize cycles per navigation. The bitmap resolution is a
//      single shared master (`FOLDER_ICON_SIZE`) so the per-call payload
//      shape is uniform across all entries.

/// Convert an HICON to PNG bytes (re-uses hbitmap_to_png after extracting
/// the color bitmap from the icon).
#[cfg(windows)]
fn hicon_to_png(hicon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<Vec<u8>> {
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};
    let mut info: ICONINFO = unsafe { std::mem::zeroed() };
    if unsafe { GetIconInfo(hicon, &mut info) }.is_err() {
        return None;
    }
    let hb = info.hbmColor;
    if hb.0.is_null() {
        if !info.hbmMask.0.is_null() {
            unsafe { let _ = windows::Win32::Graphics::Gdi::DeleteObject(info.hbmMask); }
        }
        return None;
    }
    let png = hbitmap_to_png(hb);
    unsafe { let _ = windows::Win32::Graphics::Gdi::DeleteObject(hb); }
    if !info.hbmMask.0.is_null() {
        unsafe { let _ = windows::Win32::Graphics::Gdi::DeleteObject(info.hbmMask); }
    }
    png
}

#[cfg(windows)]
fn resize_png_to(png_bytes: &[u8], target: u32) -> Option<Vec<u8>> {
    let dyn_img = image::load_from_memory_with_format(png_bytes, image::ImageFormat::Png).ok()?;
    if dyn_img.width() == target && dyn_img.height() == target {
        return None; // no resize needed
    }
    let resized = dyn_img.resize_exact(target, target, image::imageops::FilterType::Lanczos3);
    let mut out = Vec::new();
    resized
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(out)
}

/// Wrap raw PNG bytes in a single-image `.ico` container (PNG-in-ICO, Vista+
/// format). The PNG payload is embedded as-is, so the browser's decoder
/// spends the same time as decoding a plain `data:image/png;base64,…`
/// but the wire payload is 22 bytes shorter in framing.
///
/// Why ICO at all? Three reasons over plain PNG:
///
///   1. The browser still receives a `data:` URL — the only difference is
///      the MIME (`image/x-icon`). WebView2 (Chromium) handles this
///      natively; no JS-side decoder required.
///   2. The icon container self-describes its dimensions and bits-per-pixel,
///      which means the JS layer can pick the best sub-image without
///      parsing the PNG header.
///   3. Phase 3 will keep the raw ICO bytes in a single module-level cache
///      and use `<canvas>` to render at any size without going back to Rust.
///
/// ICO format reference: ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes) +
/// image data. We embed a single 128×128 32-bpp entry with PNG payload.
#[cfg(windows)]
fn wrap_png_in_ico(png_bytes: &[u8], size: u32) -> Vec<u8> {
    const ICONDIR_SIZE: u32 = 6;
    const ICONDIRENTRY_SIZE: u32 = 16;
    let data_offset = ICONDIR_SIZE + ICONDIRENTRY_SIZE;
    let png_len = png_bytes.len() as u32;

    // 0 = 256 in the width/height byte; clamp for ≤256 sizes (which is
    // every size we ship today).
    let dim_byte = if size >= 256 { 0u8 } else { size as u8 };

    let mut out = Vec::with_capacity(data_offset as usize + png_bytes.len());
    // ICONDIR: reserved=0, type=1 (icon), count=1
    out.extend_from_slice(&[0, 0, 1, 0, 1, 0]);
    // ICONDIRENTRY
    out.push(dim_byte); // width (0 = 256)
    out.push(dim_byte); // height
    out.push(0); // color count (0 = ≥256 colors)
    out.push(0); // reserved
    out.extend_from_slice(&[1, 0]); // color planes
    out.extend_from_slice(&[32, 0]); // bits per pixel
    out.extend_from_slice(&png_len.to_le_bytes()); // image data size
    out.extend_from_slice(&data_offset.to_le_bytes()); // offset to image data
    out.extend_from_slice(png_bytes);
    out
}

/// Get a single folder icon. Shell-based extraction (the same call File
/// Explorer uses for the same folder): we pass the actual filesystem path
/// to `SHGetFileInfoW`, shell accesses disk metadata + the registered
/// folder CLSID, returns the ICON that Windows itself would draw. This is
/// the only way to render the Quick Access specific glyphs (Desktop has a
/// monitor overlay, Downloads has a down arrow, Documents has a paper
/// overlay, etc.) — using a generic placeholder would give all folders
/// the same flat yellow icon.
///
/// Trade-off: per-folder icon retrieval means the first time we visit a
/// new folder we pay one shell round-trip per item. The LRU cache
/// short-circuits repeat visits. Most navigation in practice hits cache.
#[cfg(windows)]
#[command]
fn get_folder_icon(path: String, size: Option<u32>) -> Result<FolderIconResult, String> {
    use base64::Engine as _;

    // Default to the master resolution (128px) for backward compatibility.
    let requested_size = size.unwrap_or(128).clamp(16, 256);
    let key = format!("{}|{}", requested_size, path.to_ascii_lowercase());

    // 1. Cache hit — instant return.
    if let Ok(mut cache) = FOLDER_ICON_CACHE.lock() {
        if let Some(ico) = get_cached_png(&mut cache, &key) {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&ico);
            return Ok(FolderIconResult {
                data_url: Some(format!("data:image/x-icon;base64,{}", b64)),
                size: requested_size,
            });
        }
    }

    // 2. Shell-based extraction (per-folder, matches Explorer's render).
    if let Some(ico) = extract_folder_icon_shell(&path, requested_size) {
        if let Ok(mut cache) = FOLDER_ICON_CACHE.lock() {
            put_cached_png(&mut cache, key.clone(), ico.clone());
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(&ico);
        return Ok(FolderIconResult {
            data_url: Some(format!("data:image/x-icon;base64,{}", b64)),
            size: requested_size,
        });
    }

    Ok(FolderIconResult {
        data_url: None,
        size: requested_size,
    })
}

/// Resolve a named Windows shell "special" location (This PC, Network,
/// Recycle Bin, …) to the system icon Windows Explorer renders for it.
///
/// Uses `SHGetStockIconInfo` with `SHGSI_ICON` to grab the HICON, then
/// converts via the existing `hicon_to_png` helper. The bitmap is cached
/// per `kind` so repeated sidebar renders are instant.
///
/// The `kind` argument accepts a stable string token (e.g. `"this_pc"`,
/// `"network"`, `"recycle_bin"`) — keeping the IPC surface friendly to
/// JavaScript. Anything unknown returns `data_url: None` (and the frontend
/// falls back to a Lucide glyph).
#[cfg(windows)]
#[command]
fn get_special_folder_icon(kind: String) -> Result<StockIconResult, String> {
    use base64::Engine as _;
    use windows::Win32::UI::Shell::{
        SHGetStockIconInfo, SHGSI_FLAGS, SHSTOCKICONID,
    };
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

    let siid: SHSTOCKICONID = match kind.as_str() {
        "this_pc" | "my_computer" | "thispc" => SHSTOCKICONID(15), // SIID_MYCOMPUTER
        "network" => SHSTOCKICONID(17),                             // SIID_DESKTOPNETWORK (= Network in nav pane)
        "recycle_bin" | "recyclebin" | "trash" => SHSTOCKICONID(31), // SIID_RECYCLER
        "control_panel" => SHSTOCKICONID(21),                        // SIID_CPL
        "downloads" => SHSTOCKICONID(184),                           // SIID_DOWNLOAD
        "pictures" => SHSTOCKICONID(113),                            // SIID_MYPICTURES
        "music" => SHSTOCKICONID(108),                               // SIID_MYMUSIC
        "videos" => SHSTOCKICONID(189),                              // SIID_MYVIDEOS
        "documents" => SHSTOCKICONID(112),                           // SIID_MYDOCUMENTS
        "desktop" => SHSTOCKICONID(183),                             // SIID_DESKTOP
        _ => {
            return Ok(StockIconResult { data_url: None, size: STOCK_ICON_SIZE });
        }
    };

    // SHGSI_ICON = 0x100; SHGSI_LARGEICON = 0x0 (default size = SM_CXICON).
    // Passing the raw value avoids having to look up auto-generated
    // constants in the windows crate (which exposes enum constants only
    // for some flag types).
    let flags = SHGSI_FLAGS(0x100);

    let mut sii: windows::Win32::UI::Shell::SHSTOCKICONINFO = unsafe { std::mem::zeroed() };
    sii.cbSize = std::mem::size_of::<windows::Win32::UI::Shell::SHSTOCKICONINFO>() as u32;

    let hr = unsafe { SHGetStockIconInfo(siid, flags, &mut sii) };
    if hr.is_err() {
        return Ok(StockIconResult { data_url: None, size: STOCK_ICON_SIZE });
    }
    let hicon = sii.hIcon;
    if hicon.0.is_null() {
        return Ok(StockIconResult { data_url: None, size: STOCK_ICON_SIZE });
    }

    let png_opt = hicon_to_png(hicon);
    unsafe { let _ = DestroyIcon(hicon); }

    let png = match png_opt {
        Some(p) => p,
        None => return Ok(StockIconResult { data_url: None, size: STOCK_ICON_SIZE }),
    };

    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(StockIconResult {
        data_url: Some(format!("data:image/png;base64,{}", b64)),
        size: STOCK_ICON_SIZE,
    })
}

#[cfg(not(windows))]
#[derive(serde::Serialize)]
struct StockIconResult {
    data_url: Option<String>,
    size: u32,
}

/// Non-Windows stub: no Windows-only shell icons are available. Returns
/// `data_url: None` so the frontend falls back to a Lucide glyph.
#[cfg(not(windows))]
#[command]
fn get_special_folder_icon(_kind: String) -> Result<StockIconResult, String> {
    Ok(StockIconResult { data_url: None, size: 64 })
}

/// Render a folder icon at the exact requested size by asking the shell
/// to resolve the actual filesystem path. Uses `SHGetImageList` +
/// `IImageList::GetIcon` to grab the shell's pre-rendered system icon at
/// a standard size that matches the request, then wraps the resulting
/// PNG payload in a single-image `.ico` container (PNG-in-ICO) before
/// returning. The ICO framing is self-describing so the frontend knows
/// the dimensions without parsing the PNG header — and in Phase 3 it
/// gives us a clean entry point for `createImageBitmap(blob)`.
///
/// Mapping:
///   • ≤ 16 px       → SHIL_SMALL (16×16, system tray / explorer status bar)
///   • 17 – 32 px    → SHIL_LARGE (32×32, default Explorer large-icon)
///   • 33 – 48 px    → SHIL_EXTRALARGE (48×48)
///   • > 48 px       → SHIL_JUMBO (256×256) downsampled with Lanczos3 to
///                     the exact target. The shell only ships a 256-pixel
///                     master bitmap, so anything beyond that needs a
///                     resample — but 256 is more than enough for monitor
///                     pixel density.
///
/// Without this `SHGetFileInfoW(SHGFI_SMALLICON)` always returned a 16×16
/// HICON that the browser upscaled — the blurry "vỡ" the user reported.
#[cfg(windows)]
fn extract_folder_icon_shell(path: &str, size: u32) -> Option<Vec<u8>> {
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Controls::IImageList;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHGetImageList, SHFILEINFOW, SHGFI_SYSICONINDEX,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, HICON};

    let size = size.clamp(16, 256);

    // Pick the smallest SHIL bucket that is ≥ the requested size — that way
    // the shell bitmap is at least as large as what we need, and a small
    // Lanczos downsample (never an upscale) is the only resize that ever
    // happens.
    let (shil, native): (i32, u32) = if size <= 16 {
        (0x1, 16u32) // SHIL_SMALL
    } else if size <= 32 {
        (0x0, 32u32) // SHIL_LARGE
    } else if size <= 48 {
        (0x2, 48u32) // SHIL_EXTRALARGE
    } else {
        (0x4, 256u32) // SHIL_JUMBO
    };

    // IID_IImageList. Constant value per Windows SDK; using the from_u128
    // helper avoids depending on the Win32_UI_Controls feature flag.
    const IID_I_IMAGELIST: windows::core::GUID = windows::core::GUID::from_u128(
        0x46EB5926_582E_4017_9FDF_E8998DAA0950,
    );

    let image_list: IImageList = unsafe { SHGetImageList::<IImageList>(shil) }.ok()?;

    // Ask the shell for the icon's index in the system image list.
    let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut sfi: SHFILEINFOW = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        SHGetFileInfoW(
            windows::core::PCWSTR(wide_path.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut sfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_SYSICONINDEX,
        )
    };
    if ok == 0 {
        return None;
    }
    let index = sfi.iIcon;
    if index < 0 {
        return None;
    }

    // Pull the HICON at the shell's native size for this bucket.
    let hicon: HICON = unsafe { image_list.GetIcon(index, 0) }.ok()?;
    let png = hicon_to_png(hicon);
    unsafe { let _ = DestroyIcon(hicon); }
    let png = png?;

    // Resize to the exact requested size only if it differs from the
    // shell bitmap's native resolution. Lanczos3 keeps edges crisp.
    let png = if size == native {
        png
    } else {
        resize_png_to(&png, size).unwrap_or(png)
    };

    // Wrap in an ICO container so the browser receives a self-describing
    // image with declared dimensions. See `wrap_png_in_ico` for format
    // details. The frontend decodes this via `<img src=data:image/x-icon…>`
    // or via `createImageBitmap(blob)` in Phase 3.
    Some(wrap_png_in_ico(&png, size))
}

/// (no-op placeholder; legacy shell-based extractor inlined above)

/// Batch command: resolve N folder paths in a single IPC call. The cache
/// short-circuits per-entry so this is roughly O(unseen paths). Designed to
/// be called from `useFolderIcons` when navigating into a new directory.
#[cfg(windows)]
#[command]
fn get_folder_icons_batch(paths: Vec<String>, size: Option<u32>) -> Result<Vec<FolderIconBatchEntry>, String> {
    use base64::Engine as _;

    let requested_size = size.unwrap_or(128).clamp(16, 256);
    let mut entries: Vec<FolderIconBatchEntry> = Vec::with_capacity(paths.len());

    for path in paths {
        let key = format!("{}|{}", requested_size, path.to_ascii_lowercase());

        // 1. Cache hit.
        let ico_opt = {
            let mut cache = FOLDER_ICON_CACHE.lock().ok();
            cache.as_mut().and_then(|c| get_cached_png(c, &key))
        };

        let ico = match ico_opt {
            Some(p) => p,
            None => {
                // Per-folder shell extraction — let the shell pick the right
                // glyph (Quick Access overlays, custom icons, network…).
                match extract_folder_icon_shell(&path, requested_size) {
                    Some(p) => {
                        if let Ok(mut cache) = FOLDER_ICON_CACHE.lock() {
                            put_cached_png(&mut cache, key.clone(), p.clone());
                        }
                        p
                    }
                    None => {
                        entries.push(FolderIconBatchEntry {
                            path,
                            size: requested_size,
                            width: 0,
                            height: 0,
                            data_url: None,
                        });
                        continue;
                    }
                }
            }
        };

        let b64 = base64::engine::general_purpose::STANDARD.encode(&ico);
        entries.push(FolderIconBatchEntry {
            path,
            size: requested_size,
            width: requested_size,
            height: requested_size,
            data_url: Some(format!("data:image/x-icon;base64,{}", b64)),
        });
    }

    Ok(entries)
}

#[cfg(not(windows))]
#[derive(serde::Serialize)]
struct FolderIconResult {
    data_url: Option<String>,
    size: u32,
}

#[cfg(not(windows))]
#[derive(serde::Serialize)]
struct FolderIconBatchEntry {
    path: String,
    size: u32,
    width: u32,
    height: u32,
    data_url: Option<String>,
}

#[cfg(not(windows))]
#[command]
fn get_folder_icon(_path: String, _size: Option<u32>) -> Result<FolderIconResult, String> {
    Ok(FolderIconResult { data_url: None, size: 128 })
}

#[cfg(not(windows))]
#[command]
fn get_folder_icons_batch(
    paths: Vec<String>,
    _size: Option<u32>,
) -> Result<Vec<FolderIconBatchEntry>, String> {
    Ok(paths
        .into_iter()
        .map(|path| FolderIconBatchEntry {
            path,
            size: 128,
            width: 0,
            height: 0,
            data_url: None,
        })
        .collect())
}

/// RAII guard for CoInitializeEx. Calls CoUninitialize on drop unless COM
/// was already initialized in another mode.
#[cfg(windows)]
struct ComGuard(bool);
#[cfg(windows)]
impl ComGuard {
    fn new() -> Self {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        // Shell.Application COM object works with either STA or MTA, but
        // Tauri commands run on a thread-pool worker that is MTA by default.
        // We initialize as MULTITHREADED to match the thread's apartment;
        // if the thread is already in another mode, the call returns
        // RPC_E_CHANGED_MODE and we skip the uninit.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let needs_uninit = hr.is_ok();
        ComGuard(needs_uninit)
    }
}
#[cfg(windows)]
impl Drop for ComGuard {
    fn drop(&mut self) {
        use windows::Win32::System::Com::CoUninitialize;
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

// ============================================================
// Model Conversion (FBX -> GLB using Assimp)
// ============================================================

// ============================================================
// Model Conversion (FBX/3DS/OBJ -> GLB)
// Note: FBX/3DS conversion requires Python with trimesh installed
// For now, we only support native WebGL formats directly
// ============================================================

fn handle_model_convert_request(file_path: &str, request: &Request) -> ResponseBox {
    let path = Path::new(file_path);

    if !path.exists() {
        return json_response(serde_json::json!({
            "success": false,
            "error": "File not found"
        })).boxed();
    }

    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Native WebGL formats - no conversion needed
    let native_formats = ["gltf", "glb", "obj", "stl", "ply", "3mf"];
    if native_formats.contains(&ext.as_str()) {
        return handle_file_request(file_path, request);
    }

    // Unsupported formats - provide helpful error message
    let supported = native_formats.join(", ");
    let convertible = ["fbx", "3ds", "dae", "blend"];

    if convertible.contains(&ext.as_str()) {
        // These formats need conversion, suggest exporting as GLB
        return json_response(serde_json::json!({
            "success": false,
            "error": format!(
                ".{} format requires conversion.\n\nPlease export your 3D model as .glb or .gltf from your 3D software (Cinema 4D, Blender, etc.).\n\nSupported formats in this app: {}",
                ext,
                supported
            ),
            "hint": "Export as GLB for best results",
            "supported_formats": supported
        })).boxed();
    }

    // Unknown format
    json_response(serde_json::json!({
        "success": false,
        "error": format!(
            "Unsupported 3D format: .{}\n\nSupported formats: {}",
            ext,
            supported
        ),
        "supported_formats": supported
    })).boxed()
}

// ============================================================
// Adobe File Decoders (PSD / AI / EPS)
// ============================================================

// Calculate thumbnail dimensions while preserving aspect ratio
fn calculate_thumb_dims(width: u32, height: u32, max_size: usize) -> (u32, u32) {
    if width > height {
        (max_size as u32, ((height as f64 / width as f64) * max_size as f64).max(1.0) as u32)
    } else {
        (((width as f64 / height as f64) * max_size as f64).max(1.0) as u32, max_size as u32)
    }
}

// Smart thumbnail: only resize if larger dimension exceeds max_size; otherwise keep original dimensions.
fn calculate_thumb_dims_smart(width: u32, height: u32, max_size: usize) -> (u32, u32) {
    let larger = width.max(height);
    if larger > max_size as u32 {
        calculate_thumb_dims(width, height, max_size)
    } else {
        (width, height)
    }
}

// Extract embedded JPEG from a binary file (PSD/AI/C4D preview images).
// Scans ALL occurrences of FF D8...FF D9 markers and picks the LARGEST one.
// AI files contain multiple embedded JPEGs at various offsets in the file.
fn extract_embedded_jpeg(data: &[u8], max_size: usize) -> Option<Vec<u8>> {
    if data.len() < 1000 {
        return None;
    }

    let mut candidates: Vec<(usize, usize)> = Vec::new();

    // Scan for ALL JPEG start markers (FF D8 FF)
    let mut i = 0;
    while i < data.len() - 2 {
        if data[i] == 0xFF && data[i + 1] == 0xD8 && (i + 2 >= data.len() || data[i + 2] == 0xFF || (data[i + 2] & 0xF0) == 0xE0) {
            // Found JPEG SOI marker, search for EOI (FF D9) within 50MB
            let max_search = (i + 50 * 1024 * 1024).min(data.len());
            let mut end = i + 2;
            let mut found = false;
            while end < max_search - 1 {
                if data[end] == 0xFF && data[end + 1] == 0xD9 {
                    end += 2;
                    found = true;
                    break;
                }
                end += 1;
            }
            if found {
                let size = end - i;
                if size > 5000 {
                    candidates.push((i, end));
                }
                i = end;
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
    }

    if candidates.is_empty() {
        return None;
    }

    // Pick the LARGEST JPEG (highest resolution preview is usually the biggest)
    let (start, end) = candidates.iter().max_by_key(|(s, e)| e - s).unwrap();

    let jpeg_data = &data[*start..*end];
    if jpeg_data.len() < 5000 {
        return None;
    }

    // Load and resize with image crate
    if let Ok(img) = image::load_from_memory(jpeg_data) {
        let (thumb_w, thumb_h) = calculate_thumb_dims(img.width(), img.height(), max_size);
        let thumb = image::imageops::resize(
            &img.to_rgb8(), thumb_w, thumb_h,
            image::imageops::FilterType::Lanczos3,
        );
        let mut buffer = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buffer);
        if thumb.write_to(&mut cursor, image::ImageFormat::Png).is_ok() {
            return Some(buffer);
        }
    }
    None
}

// Extract Windows Shell thumbnail using IShellItemImageFactory with proper COM STA threading.
// Uses LRU cache internally; pass cache_hit=true to skip Windows cache check on subsequent calls.
#[cfg(windows)]
fn extract_thumbnail_via_shell(path: &str, max_size: usize, _cache_hit: bool) -> Option<Vec<u8>> {
    use std::thread;
    use std::sync::mpsc;

    // Check LRU cache first
    let cache_key = format!("{}:{}", path, max_size);
    if let Ok(mut guard) = get_thumb_cache().lock() {
        if let Some(cached) = guard.get(&cache_key) {
            return Some(cached.to_vec());
        }
    }

    let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();

    let _handle = thread::spawn(move || {
        unsafe {
            use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
            use windows::Win32::UI::Shell::{
                SHCreateItemFromParsingName, IShellItemImageFactory,
                SIIGBF_INCACHEONLY, SIIGBF_BIGGERSIZEOK, SIIGBF_RESIZETOFIT,
            };
            use windows::Win32::Foundation::SIZE;
            use windows::Win32::Graphics::Gdi::DeleteObject;

            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

            let factory: IShellItemImageFactory = match SHCreateItemFromParsingName(
                windows::core::PCWSTR(wide_path.as_ptr()),
                None,
            ) {
                Ok(f) => f,
                Err(_) => {
                    CoUninitialize();
                    tx.send(None).ok();
                    return;
                }
            };

            let cx = max_size.min(1024) as i32;
            let size = SIZE { cx, cy: cx };

            // Try INCACHEONLY first — returns instantly if cached by Windows
            let hbitmap = match factory.GetImage(size, SIIGBF_INCACHEONLY) {
                Ok(hb) => hb,
                Err(_) => {
                    // Fallback: triggers extraction if not cached
                    match factory.GetImage(size, SIIGBF_RESIZETOFIT | SIIGBF_BIGGERSIZEOK) {
                        Ok(hb) => hb,
                        Err(_) => {
                            CoUninitialize();
                            tx.send(None).ok();
                            return;
                        }
                    }
                }
            };

            let png_data = hbitmap_to_png(hbitmap);
            let _ = DeleteObject(hbitmap);
            CoUninitialize();

            // Store in LRU cache
            if let Some(ref png) = png_data {
                if let Ok(mut guard) = get_thumb_cache().lock() {
                    let owned: Vec<u8> = png.to_vec();
                    guard.put(cache_key.clone(), std::borrow::Cow::Owned(owned));
                }
            }

            tx.send(png_data).ok();
        }
    });

    rx.recv().ok().flatten()
}

// Convert HBITMAP to PNG bytes using GDI + image crate
#[cfg(windows)]
fn hbitmap_to_png(hbitmap: windows::Win32::Graphics::Gdi::HBITMAP) -> Option<Vec<u8>> {
    use image::ImageEncoder;
    use windows::Win32::Graphics::Gdi::{
        GetObjectW, GetDC, ReleaseDC, CreateCompatibleDC, SelectObject,
        CreateDIBSection, BitBlt, SRCCOPY, DeleteDC, DeleteObject,
        DIB_RGB_COLORS, BITMAP, BI_RGB,
    };

    unsafe {
        let mut bm: BITMAP = std::mem::zeroed();
        let bytes = GetObjectW(
            hbitmap,
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut _),
        );
        if bytes == 0 {
            return None;
        }

        let width = bm.bmWidth as usize;
        let src_height = bm.bmHeight.unsigned_abs() as usize;
        if width == 0 || src_height == 0 {
            return None;
        }

        let screen_dc = GetDC(None);
        let mem_dc = CreateCompatibleDC(screen_dc);
        let _ = ReleaseDC(None, screen_dc);

        let old_src = SelectObject(mem_dc, hbitmap);

        // Create DIB with positive height (bottom-up) so BitBlt maps bottom-to-bottom
        // from HBITMAP. Then read rows in reverse order to produce top-down PNG.
        let mut bih = windows::Win32::Graphics::Gdi::BITMAPINFOHEADER {
            biSize: std::mem::size_of::<windows::Win32::Graphics::Gdi::BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: src_height as i32,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };

        let mut pixels: *mut std::ffi::c_void = std::ptr::null_mut();
        let h_dib = CreateDIBSection(
            mem_dc,
            &mut bih as *mut _ as *mut _,
            DIB_RGB_COLORS,
            &mut pixels,
            None,
            0,
        );

        if h_dib.is_err() || pixels.is_null() {
            let _ = SelectObject(mem_dc, old_src);
            let _ = DeleteDC(mem_dc);
            return None;
        }
        let h_dib = h_dib.unwrap();

        let dib_dc = CreateCompatibleDC(mem_dc);
        let _ = SelectObject(dib_dc, h_dib);
        let _ = BitBlt(dib_dc, 0, 0, width as i32, src_height as i32, mem_dc, 0, 0, SRCCOPY);

        let row_bytes = width * 4;
        let pixels_slice = std::slice::from_raw_parts_mut(pixels as *mut u8, row_bytes * src_height);

        // Flip rows: DIB is bottom-up, PNG is top-down
        let mut flipped: Vec<u8> = Vec::with_capacity(row_bytes * src_height);
        for row in (0..src_height).rev() {
            let row_start = row * row_bytes;
            flipped.extend_from_slice(&pixels_slice[row_start..row_start + row_bytes]);
        }

        // BGRA -> RGBA
        for chunk in flipped.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        let img = image::RgbaImage::from_raw(width as u32, src_height as u32, flipped)?;
        let mut png_bytes = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
        encoder.write_image(&img, width as u32, src_height as u32, image::ExtendedColorType::Rgba8).ok()?;

        let _ = DeleteDC(dib_dc);
        let _ = DeleteDC(mem_dc);
        let _ = DeleteObject(h_dib);
        let _ = SelectObject(mem_dc, old_src);

        Some(png_bytes)
    }
}

// Extract icon from executable using Windows API directly - MUCH faster than PowerShell
#[cfg(windows)]
fn extract_icon_from_exe_native(path: &str, icon_index: i32) -> Option<Vec<u8>> {
    use windows::Win32::UI::Shell::SHDefExtractIconW;
    use windows::Win32::UI::WindowsAndMessaging::{HICON, DestroyIcon, GetIconInfo, ICONINFO};
    use windows::Win32::Graphics::Gdi::{DeleteObject as GdiDeleteObject};
    use std::thread;
    use std::sync::mpsc;

    let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();

    let _handle = thread::spawn(move || {
        unsafe {
            // Initialize COM
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

            // Use SHDefExtractIconW to get icon directly
            let mut hicon: HICON = HICON::default();
            let wide_path_pcwstr = windows::core::PCWSTR::from_raw(wide_path.as_ptr());

            let result = SHDefExtractIconW(
                wide_path_pcwstr,
                icon_index,
                0x01, // SHDefExtIconFlags - extract large icon
                Some(&mut hicon),
                None,
                32, // desired size
            );

            if result.is_err() || hicon.is_invalid() {
                CoUninitialize();
                tx.send(None).ok();
                return;
            }

            // Get icon info to get the bitmap
            let mut icon_info = std::mem::zeroed::<ICONINFO>();
            let get_result = GetIconInfo(hicon, &mut icon_info);

            let hbitmap = if get_result.is_ok() {
                if icon_info.hbmColor.is_invalid() {
                    icon_info.hbmMask
                } else {
                    icon_info.hbmColor
                }
            } else {
                DestroyIcon(hicon);
                CoUninitialize();
                tx.send(None).ok();
                return;
            };

            // Convert to PNG
            let png_data = hbitmap_to_png(hbitmap);

            // Clean up
            if !icon_info.hbmColor.is_invalid() {
                let _ = GdiDeleteObject(icon_info.hbmColor);
            }
            if !icon_info.hbmMask.is_invalid() {
                let _ = GdiDeleteObject(icon_info.hbmMask);
            }
            let _ = DestroyIcon(hicon);
            CoUninitialize();

            tx.send(png_data).ok();
        }
    });

    rx.recv().ok().flatten()
}

#[cfg(not(windows))]
fn extract_icon_from_exe_native(_path: &str, _icon_index: i32) -> Option<Vec<u8>> {
    None
}

#[cfg(not(windows))]
fn extract_thumbnail_via_shell(_path: &str, _max_size: usize, _cache_hit: bool) -> Option<Vec<u8>> {
    None
}

// Result structure for file decoding operations
#[derive(Debug, Serialize)]
pub struct DecodeResult {
    pub success: bool,
    pub png_base64: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub method: Option<String>,
    pub layers_count: Option<usize>,
    pub error: Option<String>,
}

// Helper: save decoded result to both LRU and disk caches.
// If the decoded size is large (>= 512px), also saves a 256px thumbnail
// version so file grid icons show the actual decoded preview instead
// of the default Windows shell icon.
fn cache_decoded_result(app: &tauri::AppHandle, path: &str, size: usize, png_data: &[u8]) {
    let cache_key = format!("{}:{}", path, size);
    if let Ok(mut guard) = get_thumb_cache().lock() {
        guard.put(cache_key, std::borrow::Cow::Owned(png_data.to_vec()));
    }
    save_to_disk_cache(path, size, png_data);

    // Update thumbnail icon cache when we have a high-res preview.
    // We save at MULTIPLE sizes (256, 160, 64) because get_thumbnails_batch()
    // is called with different sizes depending on view mode (256 for shell,
    // 160 for icon-grid, 64 for list/details). Saving all sizes upfront means
    // the file-grid icon refreshes IMMEDIATELY after decode, with no extra
    // round-trip needed.
    if size >= 512 {
        save_as_thumbnail_cache(app, path, png_data);
        // Save 160 (icon grid) and 64 (list) variants so the file grid
        // thumbnail updates right away without requiring another decode pass.
        if let Ok(img) = image::load_from_memory(png_data) {
            for extra_size in [160u32, 64u32] {
                let max_dim = extra_size;
                let (tw, th) = if img.width() >= img.height() {
                    let h = ((img.height() as f64 / img.width() as f64) * max_dim as f64).ceil().max(1.0) as u32;
                    (max_dim, h)
                } else {
                    let w = ((img.width() as f64 / img.height() as f64) * max_dim as f64).ceil().max(1.0) as u32;
                    (w, max_dim)
                };
                let resized = image::imageops::resize(
                    &img.to_rgb8(), tw, th,
                    image::imageops::FilterType::Lanczos3,
                );
                let mut buf = Vec::new();
                if resized.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png).is_ok() {
                    save_to_disk_cache(path, extra_size as usize, &buf);
                    let extra_key = format!("{}:{}", path, extra_size);
                    if let Ok(mut guard) = get_thumb_cache().lock() {
                        guard.put(extra_key, std::borrow::Cow::Owned(buf));
                    }
                }
            }
        }
    }
}

// Helper: resize PNG to thumbnail size and save as thumbnail cache
// This updates the thumbnail icon shown in file grids to be the actual
// decoded preview, not the default Windows shell icon.
// Notifies the frontend via the `thumbnail-ready` event so the grid
// icon refreshes immediately.
fn save_as_thumbnail_cache(app: &tauri::AppHandle, path: &str, png_data: &[u8]) {
    let thumb_size = 256usize;
    let cache_key = format!("{}:{}", path, thumb_size);

    // Resize PNG to thumbnail size
    let resized_png = match image::load_from_memory(png_data) {
        Ok(img) => {
            let (thumb_w, thumb_h) = calculate_thumb_dims(img.width(), img.height(), thumb_size);
            let thumb = image::imageops::resize(
                &img.to_rgb8(),
                thumb_w,
                thumb_h,
                image::imageops::FilterType::Lanczos3,
            );
            let mut buffer = Vec::new();
            let mut cursor = std::io::Cursor::new(&mut buffer);
            if thumb.write_to(&mut cursor, image::ImageFormat::Png).is_ok() {
                buffer
            } else {
                return;
            }
        }
        Err(_) => return,
    };

    // Save to LRU cache (will be served immediately by get_thumbnails_batch)
    if let Ok(mut guard) = get_thumb_cache().lock() {
        guard.put(cache_key, std::borrow::Cow::Owned(resized_png.clone()));
    }

    // Save to disk cache for persistence across app restarts
    save_to_disk_cache(path, thumb_size, &resized_png);

    // Notify frontend so the file grid icon refreshes
    let _ = app.emit("thumbnail-ready", path);

    println!("[thumbnail_cache] Updated thumbnail for: {} ({} bytes)", path, resized_png.len());
}

// Emit progress events during heavy decode operations.
// Returns an emit function that the decode logic can call with progress % (0-100).
fn make_decode_progressEmitter(app: &tauri::AppHandle, path: &str) -> impl Fn(u8) + Send + 'static {
    let path_owned = path.to_string();
    let app = app.clone();
    move |percent: u8| {
        let payload = serde_json::json!({
            "path": path_owned,
            "percent": percent,
        });
        let _ = app.emit("decode-progress", payload);
    }
}

/// Emit decode-progress with both percent AND human-readable stage message.
/// `message` is shown to user in the UI so they know what's happening during
/// long PSD/AI decodes (e.g. "Decoding layers...", "Done via psd_composited (3.2s)").
fn emit_with_msg(app: &tauri::AppHandle, path: &str, percent: u8, message: &str) {
    let payload = serde_json::json!({
        "path": path,
        "percent": percent,
        "message": message,
    });
    let _ = app.emit("decode-progress", payload);
}

/// Wrapper around fast_psd::extract_psd_thumbnail that emits progress updates
/// at each tier so the UI can show meaningful messages. Total progress range
/// inside the fast pipeline is mapped to 40→90%.
///
/// For Tier 2 (psd crate composited) and Tier 3 (psd crate raw) — which can
/// each take 5-30 seconds on large PSD files — we run them on a worker
/// thread and emit periodic heartbeat messages with an ETA based on file size.
/// This gives the user real-time feedback instead of a stuck-looking bar.
fn extract_psd_with_progress(
    bytes: &[u8],
    size: usize,
    app: &tauri::AppHandle,
    path: &str,
    start: std::time::Instant,
) -> Option<fast_psd::PsdThumbResult> {
    // Tier 1: embedded JPEG (fastest, <50ms typically)
    emit_with_msg(app, path, 50, "Checking embedded JPEG preview...");
    let t1 = std::time::Instant::now();
    if let Some(result) = fast_psd::extract_embedded_thumbnail_from_resource_pub(bytes, size) {
        emit_with_msg(app, path, 85, &format!("Done via embedded JPEG ({:.1}s)", t1.elapsed().as_secs_f64()));
        return Some(result);
    }

    // Estimate ETA based on file size.
    // Heuristic: ~30 MB/s of source bytes for psd crate composited decode.
    // Show this to user so they know roughly how long Tier 2 will take.
    let mb = bytes.len() as f64 / (1024.0 * 1024.0);
    let eta_secs = (mb / 30.0).max(1.0);
    let eta_hint = if eta_secs < 2.0 {
        format!("~{:.0}s", eta_secs)
    } else if eta_secs < 60.0 {
        format!("~{:.0}s", eta_secs)
    } else {
        format!("~{:.0}m {:.0}s", eta_secs / 60.0, eta_secs % 60.0)
    };

    // Tier 2: psd crate composited (slow for large PSDs)
    emit_with_msg(app, path, 60, &format!("Parsing & compositing layers ({}, ETA {})...", format_size(mb), eta_hint));
    let t2 = std::time::Instant::now();
    let result2 = std::sync::mpsc::channel::<Option<fast_psd::PsdThumbResult>>();
    let (tx, rx) = result2;
    let bytes_owned = bytes.to_vec();
    let worker = std::thread::spawn(move || {
        let r = fast_psd::extract_via_psd_crate_composited_pub(&bytes_owned, size);
        let _ = tx.send(r);
    });
    // Heartbeat: bump percent slightly every 500ms so the bar visibly moves.
    // Without this the bar sits at 60% for the whole 30s Tier 2 duration and
    // looks stuck even though work is happening.
    let mut hb = 60u8;
    loop {
        match rx.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(opt) => {
                let _ = worker.join();
                if let Some(result) = opt {
                    let elapsed_total = start.elapsed().as_secs_f64();
                    emit_with_msg(app, path, 85, &format!("Done via composited ({:.1}s total)", elapsed_total));
                    return Some(result);
                }
                break;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if hb < 82 {
                    hb = (hb + 1).min(82);
                    let elapsed = t2.elapsed().as_secs_f64();
                    emit_with_msg(app, path, hb, &format!("Compositing layers... {:.1}s elapsed ({} total)", elapsed, eta_hint));
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // Tier 3: psd crate raw (last resort)
    emit_with_msg(app, path, 83, "Compositing failed, parsing raw data...");
    let t3 = std::time::Instant::now();
    if let Some(result) = fast_psd::extract_via_psd_crate_raw_pub(bytes, size) {
        let elapsed_total = start.elapsed().as_secs_f64();
        emit_with_msg(app, path, 90, &format!("Done via raw ({:.1}s total)", elapsed_total));
        return Some(result);
    }

    None
}

/// Format bytes as a human-readable size string.
fn format_size(mb: f64) -> String {
    if mb < 1.0 {
        format!("{:.0} KB", mb * 1024.0)
    } else if mb < 1024.0 {
        format!("{:.1} MB", mb)
    } else {
        format!("{:.2} GB", mb / 1024.0)
    }
}

// Decode PSD file to PNG base64 using fast 4-tier engine (async with progress)
#[tauri::command]
async fn decode_psd(app: tauri::AppHandle, path: String, max_size: Option<u32>) -> DecodeResult {
    let size = max_size.unwrap_or(2048) as usize;
    let emit = make_decode_progressEmitter(&app, &path);
    let start_time = std::time::Instant::now();

    emit_with_msg(&app, &path, 5, "Reading file...");

    // Check disk cache first (avoids expensive decode for previously-loaded files)
    if let Some(png_data) = load_from_disk_cache(&path, size) {
        println!("[decode_psd] disk cache hit: {} ({} bytes)", path, png_data.len());
        // Populate LRU cache
        let cache_key = format!("{}:{}", path, size);
        if let Ok(mut guard) = get_thumb_cache().lock() {
            guard.put(cache_key, std::borrow::Cow::Owned(png_data.clone()));
        }
        let b64 = STANDARD.encode(&png_data);
        let (w, h) = if let Ok(img) = image::load_from_memory(&png_data) {
            (Some(img.width()), Some(img.height()))
        } else {
            (None, None)
        };
        let elapsed = start_time.elapsed().as_millis();
        emit_with_msg(&app, &path, 100, &format!("Loaded from cache ({}ms)", elapsed));
        return DecodeResult {
            success: true,
            png_base64: Some(b64),
            width: w,
            height: h,
            method: Some("disk_cache".to_string()),
            layers_count: None,
            error: None,
        };
    }

    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            emit_with_msg(&app, &path, 0, &format!("Read failed: {}", e));
            return DecodeResult {
                success: false, png_base64: None, width: None, height: None,
                method: None, layers_count: None, error: Some(e.to_string()),
            };
        }
    };

    let file_size_mb = bytes.len() as f64 / (1024.0 * 1024.0);
    emit_with_msg(&app, &path, 20, &format!("Read {:.1} MB", file_size_mb));

    // File size guard: skip heavy parsing for files > 500MB
    if bytes.len() > 500 * 1024 * 1024 {
        emit_with_msg(&app, &path, 40, "Large file - using Windows Shell...");
        if let Some(png_data) = extract_thumbnail_via_shell(&path, size, false) {
            cache_decoded_result(&app, &path, size, &png_data);
            let b64 = STANDARD.encode(&png_data);
            let (w, h) = if let Ok(img) = image::load_from_memory(&png_data) {
                (Some(img.width()), Some(img.height()))
            } else {
                (None, None)
            };
            let elapsed = start_time.elapsed().as_secs();
            emit_with_msg(&app, &path, 100, &format!("Done ({:.1}s)", elapsed as f64));
            return DecodeResult {
                success: true, png_base64: Some(b64), width: w, height: h,
                method: Some("windows_shell_huge".to_string()), layers_count: None, error: None,
            };
        }
        emit_with_msg(&app, &path, 100, "Failed");
        return DecodeResult {
            success: false, png_base64: None, width: None, height: None,
            method: None, layers_count: None,
            error: Some("PSD file is too large (>500MB) for preview rendering".to_string()),
        };
    }

    emit_with_msg(&app, &path, 40, "Decoding layers...");

    // Try fast 4-tier pipeline
    if let Some(result) = extract_psd_with_progress(&bytes, size, &app, &path, start_time) {
        cache_decoded_result(&app, &path, size, &result.png_data);
        let b64 = STANDARD.encode(&result.png_data);
        let elapsed = start_time.elapsed().as_secs();
        emit_with_msg(&app, &path, 100, &format!("Done via {} ({:.1}s)", result.method, elapsed as f64));
        return DecodeResult {
            success: true,
            png_base64: Some(b64),
            width: Some(result.width),
            height: Some(result.height),
            method: Some(result.method.to_string()),
            layers_count: result.layers_count,
            error: None,
        };
    }

    emit_with_msg(&app, &path, 80, "Trying Windows Shell fallback...");

    // Last resort: Windows Shell thumbnail
    if let Some(png_data) = extract_thumbnail_via_shell(&path, size, false) {
        cache_decoded_result(&app, &path, size, &png_data);
        let b64 = STANDARD.encode(&png_data);
        let (w, h) = if let Ok(img) = image::load_from_memory(&png_data) {
            (Some(img.width()), Some(img.height()))
        } else {
            (None, None)
        };
        let elapsed = start_time.elapsed().as_secs();
        emit_with_msg(&app, &path, 100, &format!("Done via shell ({:.1}s)", elapsed as f64));
        return DecodeResult {
            success: true, png_base64: Some(b64), width: w, height: h,
            method: Some("windows_shell".to_string()), layers_count: None, error: None,
        };
    }

    emit_with_msg(&app, &path, 100, "Failed - corrupted or unsupported");
    DecodeResult {
        success: false, png_base64: None, width: None, height: None,
        method: None, layers_count: None,
        error: Some("Could not parse PSD file. File may be corrupted or uses an unsupported PSD format.".to_string()),
    }
}

// Decode Adobe Illustrator (.ai) / Encapsulated PostScript (.eps) on-demand.
// Pattern mirrors `decode_psd_on_demand`: triggered when the user clicks the
// file in the grid, decodes once, saves the result at all icon-relevant
// sizes (256 / 160 / 64), emits `thumbnail-ready` so the frontend refreshes
// the thumbnail icon — exactly like the PSD pipeline.
#[tauri::command]
async fn decode_ai_on_demand(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    let size = 1024usize;
    let cache_key = format!("{}:{}", path, size);

    // Skip if already cached
    if load_from_disk_cache(&path, size).is_some() {
        println!("[decode_ai_on_demand] already cached: {}", path);
        // Still emit so the frontend icon refreshes
        let _ = app.emit("thumbnail-ready", &path);
        return Ok(true);
    }
    if let Ok(g) = get_thumb_cache().lock() {
        if g.contains(&cache_key) {
            println!("[decode_ai_on_demand] already in LRU: {}", path);
            let _ = app.emit("thumbnail-ready", &path);
            return Ok(true);
        }
    }

    println!("[decode_ai_on_demand] decoding: {}", path);

    // Delegate to the existing decode_ai logic and then persist + emit.
    // decode_ai() already calls `cache_decoded_result` (which now stores
    // 256/160/64 variants on disk), so all we need to do here is make sure
    // `thumbnail-ready` fires even though decode_ai doesn't emit it itself.
    let result = decode_ai(app.clone(), path.clone(), Some(size as u32)).await;

    if !result.success {
        let err = result.error.unwrap_or_else(|| "AI decode failed".to_string());
        println!("[decode_ai_on_demand] decode_ai failed: {}", err);
        return Err(err);
    }

    // decode_ai() populates LRU + disk via cache_decoded_result. Trigger the
    // frontend refresh explicitly so the file grid icon updates immediately.
    let _ = app.emit("thumbnail-ready", &path);
    println!("[decode_ai_on_demand] done: {}", path);
    Ok(true)
}

// Decode PSD/PSB on-demand (triggered by user click)
// This avoids loading ALL PSD files in a folder at once, which causes crashes
#[tauri::command]
async fn decode_psd_on_demand(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    let size = 1024usize;
    let cache_key = format!("{}:{}", path, size);

    // Skip if already decoded
    if load_from_disk_cache(&path, size).is_some() {
        println!("[decode_psd_on_demand] already cached: {}", path);
        return Ok(true);
    }
    if let Ok(g) = get_thumb_cache().lock() {
        if g.contains(&cache_key) {
            println!("[decode_psd_on_demand] already in LRU: {}", path);
            return Ok(true);
        }
    }

    println!("[decode_psd_on_demand] decoding: {}", path);

    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 500 * 1024 * 1024 {
        return Err("PSD file is too large (>500MB)".to_string());
    }

    if let Some(result) = fast_psd::extract_psd_thumbnail(&bytes, size) {
        // Save to LRU cache (main 1024 size used by detail preview)
        if let Ok(mut g) = get_thumb_cache().lock() {
            g.put(cache_key.clone(), std::borrow::Cow::Owned(result.png_data.clone()));
        }
        // Save to disk cache (1024) — survives restart, used by detail preview
        save_to_disk_cache(&path, size, &result.png_data);
        // Save as thumbnail icon cache (256) — used by Windows Shell + larger icons
        save_as_thumbnail_cache(&app, &path, &result.png_data);

        // Also save at the icon-grid request sizes (160 for grid, 64 for list)
        // so that get_thumbnails_batch() hits the disk cache after decode and
        // refreshes the thumbnail icon in the file grid immediately.
        for extra_size in [160usize, 64usize] {
            if extra_size == size { continue; }
            // Downscale the 1024 PNG to the smaller size, then cache
            if let Ok(img) = image::load_from_memory(&result.png_data) {
                let max_dim = extra_size as u32;
                let (tw, th) = if img.width() >= img.height() {
                    let h = ((img.height() as f64 / img.width() as f64) * max_dim as f64).ceil().max(1.0) as u32;
                    (max_dim, h)
                } else {
                    let w = ((img.width() as f64 / img.height() as f64) * max_dim as f64).ceil().max(1.0) as u32;
                    (w, max_dim)
                };
                let resized = image::imageops::resize(
                    &img.to_rgb8(), tw, th,
                    image::imageops::FilterType::Lanczos3,
                );
                let mut buf = Vec::new();
                if resized.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png).is_ok() {
                    save_to_disk_cache(&path, extra_size, &buf);
                    let extra_key = format!("{}:{}", path, extra_size);
                    if let Ok(mut g) = get_thumb_cache().lock() {
                        g.put(extra_key, std::borrow::Cow::Owned(buf));
                    }
                }
            }
        }

        // Emit thumbnail-ready so frontend refreshes the file grid icon
        let _ = app.emit("thumbnail-ready", &path);
        println!("[decode_psd_on_demand] done: {}", path);
        return Ok(true);
    }

    Err("Could not decode PSD file".to_string())
}

// ============================================================
// EPUB Reader - Extract metadata, cover, and text from EPUB files
// ============================================================

#[tauri::command]
async fn decode_epub(path: String) -> epub::EpubDecodeResult {
    println!("[EPUB] decode_epub called with path: {}", path);
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return epub::EpubDecodeResult {
            success: false,
            title: None,
            author: None,
            publisher: None,
            language: None,
            description: None,
            cover_base64: None,
            cover_width: None,
            cover_height: None,
            table_of_contents: vec![],
            text_content: None,
            chapters: vec![],
            chapters_count: 0,
            error: Some("File not found".to_string()),
        };
    }
    println!("[EPUB] Calling epub::decode_epub...");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        epub::decode_epub(&p)
    }));
    match result {
        Ok(r) => {
            println!("[EPUB] decode_epub succeeded: success={}", r.success);
            r
        }
        Err(e) => {
            println!("[EPUB] decode_epub PANICKED: {:?}", e);
            epub::EpubDecodeResult {
                success: false,
                title: None,
                author: None,
                publisher: None,
                language: None,
                description: None,
                cover_base64: None,
                cover_width: None,
                cover_height: None,
                table_of_contents: vec![],
                text_content: None,
                chapters: vec![],
                chapters_count: 0,
                error: Some(format!("Panic: {:?}", e)),
            }
        }
    }
}

#[tauri::command]
async fn decode_stl(path: String) -> stl::StlDecodeResult {
    println!("[STL] decode_stl called with path: {}", path);
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return stl::StlDecodeResult {
            success: false,
            triangles_count: 0,
            vertices_count: 0,
            vertices: vec![],
            normals: vec![],
            error: Some("File not found".to_string()),
        };
    }
    println!("[STL] Calling stl::decode_stl...");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        stl::decode_stl(&p)
    }));
    match result {
        Ok(r) => {
            println!("[STL] decode_stl succeeded: success={}", r.success);
            r
        }
        Err(e) => {
            println!("[STL] decode_stl PANICKED: {:?}", e);
            stl::StlDecodeResult {
                success: false,
                triangles_count: 0,
                vertices_count: 0,
                vertices: vec![],
                normals: vec![],
                error: Some(format!("Panic: {:?}", e)),
            }
        }
    }
}

// Result structure for EXR decoding operations
#[derive(Debug, Serialize)]
pub struct ExrDecodeResult {
    pub success: bool,
    pub png_base64: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub method: Option<String>,
    pub layers_count: Option<usize>,
    pub channels: Option<Vec<String>>,
    pub cryptomatte_layers: Option<Vec<String>>,
    pub layer_names: Option<Vec<String>>,  // All layer names in the EXR
    pub error: Option<String>,
}

#[derive(serde::Deserialize)]
struct ExrDecodeArgs {
    path: String,
    max_size: Option<u32>,
    ocio_mode: Option<String>,
    layer_name: Option<String>,  // Optional: decode specific layer
}

#[derive(serde::Serialize)]
pub struct ExrRgbaResponse {
    pub success: bool,
    pub rgba: Option<Vec<u8>>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub channels: Option<Vec<String>>,
    pub layers_count: Option<usize>,
    pub layer_names: Option<Vec<String>>,
    pub pass_type: Option<String>,
    pub error: Option<String>,
}

/// Float32 RGBA decode response (linear HDR). The frontend uploads this
/// payload straight to a WebGL2 R32G32B32A32F texture and tone-maps with
/// a 3D OCIO LUT in the fragment shader.
#[derive(serde::Serialize)]
pub struct ExrF32Response {
    pub success: bool,
    /// 4 floats per pixel: R, G, B, A in linear scene-referred space.
    /// Alpha is set to 1.0 (or to the A channel when present).
    ///
    /// Serialized as raw little-endian bytes of the f32 array (4 bytes per
    /// float). Tauri ships `Vec<u8>` as a binary `Uint8Array` over IPC,
    /// which avoids the ~5s cost of JSON-serializing a 3.7M-element
    /// number[] per frame. Front-end reconstructs a `Float32Array` view via
    /// `new Float32Array(buffer)` (zero-copy because the buffer is exactly
    /// the same bytes).
    pub rgba_f32: Option<Vec<u8>>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub channels: Option<Vec<String>>,
    pub layers_count: Option<usize>,
    pub layer_names: Option<Vec<String>>,
    /// max(R, G, B) over the frame — hint for auto-exposure / LUT clamp.
    pub dynamic_range: Option<f32>,
    pub error: Option<String>,
}

/// Decode an EXR file to raw RGBA8 bytes (no resize, no PNG encode).
///
/// The frontend can wrap the returned bytes in ImageData and render to a
/// canvas, which handles final resize faster than the Rust Lanczos path for
/// small display sizes. Skips base64 + JSON serialization overhead for the
/// pixel payload — Tauri transports `Vec<u8>` efficiently as a binary blob.
///
/// Note: this path does NOT go through OCIO color-space conversion. Use the
/// regular `decode_exr` command when OCIO is needed (returns sRGB PNG).
#[tauri::command]
async fn decode_exr_rgba(args: ExrDecodeArgs) -> ExrRgbaResponse {
    let path = args.path.clone();
    println!("[EXR] decode_exr_rgba called for: {}", path);

    let max_size = args.max_size.unwrap_or(0);
    let layer_filter = args.layer_name.clone();
    let result = tokio::task::spawn_blocking(move || {
        let p = std::path::PathBuf::from(&path);
        match openexr_core::extract_exr_rgba_raw(&p, max_size, layer_filter.as_deref()) {
            Some(r) => ExrRgbaResponse {
                success: true,
                rgba: Some(r.rgba),
                width: Some(r.width),
                height: Some(r.height),
                channels: Some(r.channels),
                layers_count: Some(r.layers_count),
                layer_names: Some(r.layer_names),
                pass_type: Some(r.pass_type),
                error: None,
            },
            None => ExrRgbaResponse {
                success: false,
                rgba: None,
                width: None,
                height: None,
                channels: None,
                layers_count: None,
                layer_names: None,
                pass_type: None,
                error: Some("Could not parse EXR file".to_string()),
            },
        }
    }).await.unwrap_or_else(|e| ExrRgbaResponse {
        success: false,
        rgba: None,
        width: None,
        height: None,
        channels: None,
        layers_count: None,
        layer_names: None,
        pass_type: None,
        error: Some(format!("Task panicked: {}", e)),
    });

    result
}

// Decode an EXR file to raw RGBA float32 (linear HDR, no resize, no PNG).
///
/// This is the GPU-side OCIO LUT path: the frontend uploads the result to a
/// WebGL2 R32G32B32A32F texture and tone-maps with a 3D LUT in the fragment
/// shader. Avoids the per-frame Python OCIO subprocess (~800ms/frame) for
/// sequence playback.
///
/// `max_size` is currently accepted but ignored — the GPU does the final
/// resize via canvas drawImage. Kept in the args struct so the frontend
/// signature matches `decode_exr_rgba`.
/// Binary metadata header for the float32 EXR decode command. The actual
/// RGBA payload is returned separately as `tauri::ipc::Response::Raw`
/// bytes so that the ~15 MB f32 buffer crosses the IPC boundary as a real
/// binary blob instead of a JSON-encoded `number[]` (Tauri's serde path
/// for `Vec<u8>` nested inside an `Option` serialises as a JSON array —
/// see tauri-apps/tauri#10336). Embedding `Vec<u8>` inside a struct
/// triggers the JSON path even though a top-level `Vec<u8>` does not.
///
/// Returns `(meta, Some(f32_bytes))` on success or `(error_meta, None)`
/// on failure.
#[derive(serde::Serialize, serde::Deserialize)]
struct ExrF32Meta {
    success: bool,
    width: Option<u32>,
    height: Option<u32>,
    channels: Option<Vec<String>>,
    layers_count: Option<usize>,
    layer_names: Option<Vec<String>>,
    dynamic_range: Option<f32>,
    pass_type: Option<String>,
    /// Phase 7: wire-format tag. `Some("u8")` when the payload is
    /// RGBA8 bytes (set by `decode_exr_u8_rgba`), `Some("f16")` when
    /// the payload is half-precision floats (set by `decode_exr_f16`),
    /// or `None` for the legacy `decode_exr_f32` path.
    ///
    /// Frontend reads this field to decide between `Uint8ClampedArray`
    /// / `Uint16Array` / `Float32Array` views of the wire bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    format: Option<String>,
    error: Option<String>,
}

#[tauri::command]
async fn decode_exr_f32(args: ExrDecodeArgs) -> Result<tauri::ipc::Response, String> {
    let path = args.path.clone();
    println!("[EXR] decode_exr_f32 called for: {} (layer={:?})", path, args.layer_name);

    let max_size = args.max_size.unwrap_or(0);
    let layer_filter = args.layer_name.clone();

    // Phase 5B: Pre-decoded RGBA f32 disk cache. We need width/height up
    // front to compute the cache key, but we don't have them until after
    // a header scan. Easiest: try to find a matching cache entry by
    // scanning the cache dir for any meta with the same path+mtime+layer,
    // and only fall back to a full decode if no hit. We keep it simple:
    // a single spawn_blocking that does header→cache-check→(optional)
    // decode→(optional) save.
    let decode = tokio::task::spawn_blocking(move || {
        let p = std::path::PathBuf::from(&path);

        // Phase 5E: in-memory LRU check FIRST. This is the fast path
        // for sequence scrubbing — no disk I/O, no header scan, just
        // a HashMap lookup keyed on (path, layer). If the user is
        // revisiting a frame within the last 16 decoded frames (≈1 s
        // at 24 fps), we hit here and never even open the EXR file.
        let force_fresh = std::env::var("RUST_EXR_FORCE_FRESH").map(|v| v == "1").unwrap_or(false);
        if !force_fresh {
        if let Some(view) = exr_decode_cache_lru::get(&p, layer_filter.as_deref()) {
            exr_decode_cache_lru::log_outcome(&p, layer_filter.as_deref(), true, view.width, view.height);
            return ExrF32DecodeOutcome::CacheHit {
                rgba_f32: view.rgba_f32,
                width: view.width,
                height: view.height,
                channels: view.channels,
                layers_count: view.layers_count,
                layer_names: view.layer_names,
                pass_type: view.pass_type,
            };
        }
        } // end !force_fresh

        // We need the EXR header dimensions to look up the cache. The
        // cheapest way is to open the file with OpenEXRCore once, read
        // width/height, then either return cached data or run a full
        // decode. We do the header read inside the existing
        // `extract_exr_rgba_raw_ffi` pipeline, but we also expose a tiny
        // helper that returns width/height without decoding anything.
        let (w, h) = match openexr_core::probe_exr_dimensions(&p) {
            Some(v) => v,
            None => return ExrF32DecodeOutcome::DecodeFailed,
        };

        exr_decode_cache_lru::log_outcome(&p, layer_filter.as_deref(), false, w, h);

        // DBG-2026-07-13: optionally bypass cache so we can verify what
        // `extract_exr_rgba_raw` actually returns from disk. Set
        // RUST_EXR_FORCE_FRESH=1 to skip both LRU and disk caches and
        // force a full re-decode every call.
        let force_fresh = std::env::var("RUST_EXR_FORCE_FRESH").map(|v| v == "1").unwrap_or(false);
        if force_fresh {
            println!("[EXR-FORCE-FRESH] bypassing caches for {} layer={:?}", p.display(), layer_filter);
        }

        // Cache hit fast path.
        if !force_fresh {
        if let Some((rgba_f32, channels, layers_count, layer_names, pass_type)) =
            exr_decode_cache::try_load(&p, layer_filter.as_deref(), w, h)
        {
            // Phase 10-debug: trace disk cache hit channels and first pixel values
            // to diagnose "layer switch returns wrong layer" bug.
            let sample_r = rgba_f32.first().copied().unwrap_or(0.0);
            let sample_g = rgba_f32.get(1).copied().unwrap_or(0.0);
            let sample_b = rgba_f32.get(2).copied().unwrap_or(0.0);
            let mid = (rgba_f32.len() / 2).min(rgba_f32.len().saturating_sub(1));
            let mid_r = rgba_f32.get(mid).copied().unwrap_or(0.0);
            let mid_g = rgba_f32.get(mid + 1).copied().unwrap_or(0.0);
            let mid_b = rgba_f32.get(mid + 2).copied().unwrap_or(0.0);
            println!(
                "[EXR-CACHE] HIT  {} ({}x{}, {} pixels) — skipping OpenEXRCore decode (layer={:?}, channels={:?}) pixels[0]=({:.4},{:.4},{:.4}) mid=({:.4},{:.4},{:.4})",
                p.display(),
                w,
                h,
                rgba_f32.len(),
                layer_filter,
                channels,
                sample_r, sample_g, sample_b,
                mid_r, mid_g, mid_b
            );
            return ExrF32DecodeOutcome::CacheHit {
                rgba_f32,
                width: w,
                height: h,
                channels,
                layers_count,
                layer_names,
                pass_type,
            };
        }
        } // end of `if !force_fresh {` block
        println!("[EXR-CACHE] MISS {} — running OpenEXRCore decode", p.display());

        // Cache miss: do the real decode, then save on success.
        let result = openexr_core::extract_exr_rgba_raw(&p, max_size, layer_filter.as_deref());
        match result {
            Some(r) => {
                // Best-effort cache write — failures are non-fatal.
                if let Some(f32_buf) = r.rgba_f32.as_ref() {
                    // Phase 5E: stuff the freshly decoded buffer into the
                    // in-memory LRU. Cheap (no I/O), so we always do it.
                    exr_decode_cache_lru::put(
                        &p,
                        layer_filter.as_deref(),
                        r.width,
                        r.height,
                        f32_buf.clone(),
                        r.channels.clone(),
                        r.layers_count,
                        r.layer_names.clone(),
                        r.pass_type.clone(),
                    );
                    // Phase 5B: also persist to disk for cross-session reuse.
                    exr_decode_cache::try_save(
                        &p,
                        layer_filter.as_deref(),
                        r.width,
                        r.height,
                        f32_buf,
                        &r.channels,
                        r.layers_count,
                        &r.layer_names,
                        &r.pass_type,
                    );
                }
                ExrF32DecodeOutcome::Decoded(r)
            }
            None => ExrF32DecodeOutcome::DecodeFailed,
        }
    });

    let outcome = match decode.await {
        Ok(o) => o,
        Err(e) => return Err(format!("Decode task panicked: {}", e)),
    };

    let payload = build_exr_f32_payload(outcome)?;
    Ok(tauri::ipc::Response::new(payload))
}

/// Phase 6D-Lite: Same as `decode_exr_f32` but the pixel payload is
/// serialised as IEEE 754 half-precision floats (2 bytes/pixel instead of
/// 4). Cuts the IPC payload by ~50% for typical Beauty/AOV frames with no
/// perceivable quality loss.
///
/// We always emit half precision for every channel — the existing
/// GPU shader already uploads RGBA16F via `HALF_FLOAT_OES`, so the
/// frontend can reinterpret the wire bytes as `Uint16Array` and feed them
/// straight into `texImage2D`. For channels that genuinely need Float32
/// precision (e.g. deeply-nested depth passes > 16 stops below mid-grey),
/// the frontend should keep using `decode_exr_f32`.
///
/// Cache hit/miss logic is identical to `decode_exr_f32`; the conversion
/// happens at payload-build time so the disk cache (which stores f32)
/// stays single-format and serves both commands.
#[tauri::command]
async fn decode_exr_f16(args: ExrDecodeArgs) -> Result<tauri::ipc::Response, String> {
    let path = args.path.clone();
    println!(
        "[EXR] decode_exr_f16 called for: {} (layer={:?})",
        path, args.layer_name
    );

    let max_size = args.max_size.unwrap_or(0);
    let layer_filter = args.layer_name.clone();

    let decode = tokio::task::spawn_blocking(move || {
        let p = std::path::PathBuf::from(&path);

        if let Some(view) = exr_decode_cache_lru::get(&p, layer_filter.as_deref()) {
            exr_decode_cache_lru::log_outcome(&p, layer_filter.as_deref(), true, view.width, view.height);
            return ExrF32DecodeOutcome::CacheHit {
                rgba_f32: view.rgba_f32,
                width: view.width,
                height: view.height,
                channels: view.channels,
                layers_count: view.layers_count,
                layer_names: view.layer_names,
                pass_type: view.pass_type,
            };
        }

        let (w, h) = match openexr_core::probe_exr_dimensions(&p) {
            Some(v) => v,
            None => return ExrF32DecodeOutcome::DecodeFailed,
        };
        exr_decode_cache_lru::log_outcome(&p, layer_filter.as_deref(), false, w, h);

        if let Some((rgba_f32, channels, layers_count, layer_names, pass_type)) =
            exr_decode_cache::try_load(&p, layer_filter.as_deref(), w, h)
        {
            return ExrF32DecodeOutcome::CacheHit {
                rgba_f32,
                width: w,
                height: h,
                channels,
                layers_count,
                layer_names,
                pass_type,
            };
        }

        let result = openexr_core::extract_exr_rgba_raw(&p, max_size, layer_filter.as_deref());
        match result {
            Some(r) => {
                if let Some(f32_buf) = r.rgba_f32.as_ref() {
                    exr_decode_cache_lru::put(
                        &p,
                        layer_filter.as_deref(),
                        r.width,
                        r.height,
                        f32_buf.clone(),
                        r.channels.clone(),
                        r.layers_count,
                        r.layer_names.clone(),
                        r.pass_type.clone(),
                    );
                    exr_decode_cache::try_save(
                        &p,
                        layer_filter.as_deref(),
                        r.width,
                        r.height,
                        f32_buf,
                        &r.channels,
                        r.layers_count,
                        &r.layer_names,
                        &r.pass_type,
                    );
                }
                ExrF32DecodeOutcome::Decoded(r)
            }
            None => ExrF32DecodeOutcome::DecodeFailed,
        }
    });

    let outcome = match decode.await {
        Ok(o) => o,
        Err(e) => return Err(format!("Decode task panicked: {}", e)),
    };

    let payload = build_exr_f16_payload(outcome)?;
    Ok(tauri::ipc::Response::new(payload))
}

/// Build the wire payload for `decode_exr_f16`: same header + half-precision
/// pixel bytes (2 bytes/pixel) instead of the f32 (4 bytes/pixel) used by
/// `build_exr_f32_payload`. Header format is identical so the frontend's
/// existing byte-layout parser handles both commands.
fn build_exr_f16_payload(outcome: ExrF32DecodeOutcome) -> Result<Vec<u8>, String> {
    match outcome {
        ExrF32DecodeOutcome::CacheHit {
            rgba_f32,
            width,
            height,
            channels,
            layers_count,
            layer_names,
            pass_type,
        } => {
            let pixel_count = rgba_f32.len();
            // Compute dynamic_range from cached f32 pixels (same logic as decode path).
            let mut max_v: f32 = 0.0;
            for v in rgba_f32.iter().step_by(4) {
                if *v > max_v {
                    max_v = *v;
                }
            }
            let dynamic_range = max_v.max(1.0);
            let f16_bytes = f32_to_f16_bytes(rgba_f32);
            println!(
                "[EXR] f16 cache-hit bytes: {} KB ({} pixels, was {} KB as f32) dynamic_range={:.2}",
                f16_bytes.len() / 1024,
                pixel_count,
                (pixel_count * 4) / 1024,
                dynamic_range
            );
            let header = ExrF32Meta {
                success: true,
                width: Some(width),
                height: Some(height),
                channels: Some(channels),
                layers_count: Some(layers_count),
                layer_names: Some(layer_names),
                dynamic_range: Some(dynamic_range),
                pass_type: Some(pass_type),
                format: Some("f16".to_string()),
                error: None,
            };
            serialize_exr_f32_response(header, f16_bytes)
        }
        ExrF32DecodeOutcome::Decoded(r) => {
            let f32_payload: Vec<f32> = r.rgba_f32.unwrap_or_default();
            let pixel_count = f32_payload.len();
            let f16_bytes = f32_to_f16_bytes(f32_payload);
            println!(
                "[EXR] f16 decoded bytes: {} KB ({} pixels, was {} KB as f32)",
                f16_bytes.len() / 1024,
                pixel_count,
                (pixel_count * 4) / 1024
            );
            let header = ExrF32Meta {
                success: true,
                width: Some(r.width),
                height: Some(r.height),
                channels: Some(r.channels),
                layers_count: Some(r.layers_count),
                layer_names: Some(r.layer_names),
                dynamic_range: Some(r.dynamic_range),
                pass_type: Some(r.pass_type),
                format: Some("f16".to_string()),
                error: None,
            };
            serialize_exr_f32_response(header, f16_bytes)
        }
        ExrF32DecodeOutcome::DecodeFailed => {
            let header = ExrF32Meta {
                success: false,
                width: None,
                height: None,
                channels: None,
                layers_count: None,
                layer_names: None,
                dynamic_range: None,
                pass_type: None,
                format: Some("f16".to_string()),
                error: Some("Could not parse EXR file".to_string()),
            };
            serialize_exr_f32_response(header, Vec::new())
        }
    }
}

/// Internal outcome of the EXR decode pipeline. Encapsulates the three
/// terminal states (cache hit, fresh decode, decode failure) so the
/// response-builder helper below can stay compact and the wrapper code
/// stays linear.
enum ExrF32DecodeOutcome {
    CacheHit {
        rgba_f32: Vec<f32>,
        width: u32,
        height: u32,
        channels: Vec<String>,
        layers_count: usize,
        layer_names: Vec<String>,
        pass_type: String,
    },
    Decoded(openexr_core::ExrRgbaResult),
    DecodeFailed,
}

fn build_exr_f32_payload(outcome: ExrF32DecodeOutcome) -> Result<Vec<u8>, String> {
    match outcome {
        ExrF32DecodeOutcome::CacheHit {
            rgba_f32,
            width,
            height,
            channels,
            layers_count,
            layer_names,
            pass_type,
        } => {
            // We don't have a u8 RGBA preview buffer from the cache (the
            // cache only stores the f32 RGBA linear-HDR payload). The
            // frontend treats `rgba` as None for cache hits; it can
            // re-derive a thumbnail from the f32 buffer it just received
            // if needed.
            let pixel_count = rgba_f32.len();
            // Compute dynamic_range from cached f32 pixels (same logic as decode path).
            let mut max_v: f32 = 0.0;
            for v in rgba_f32.iter().step_by(4) {
                if *v > max_v {
                    max_v = *v;
                }
            }
            let dynamic_range = max_v.max(1.0);
            let f32_bytes: Vec<u8> = bytemuck_like_f32_to_bytes(rgba_f32);
            println!(
                "[EXR] cache-hit rgba_f32 bytes: {} MB ({} pixels) dynamic_range={:.2}",
                f32_bytes.len() / 1024 / 1024,
                pixel_count,
                dynamic_range
            );
            let header = ExrF32Meta {
                success: true,
                width: Some(width),
                height: Some(height),
                channels: Some(channels),
                layers_count: Some(layers_count),
                layer_names: Some(layer_names),
                dynamic_range: Some(dynamic_range),
                pass_type: Some(pass_type),
                format: Some("f32".to_string()),
                error: None,
            };
            serialize_exr_f32_response(header, f32_bytes)
        }
        ExrF32DecodeOutcome::Decoded(r) => {
            let f32_payload: Vec<f32> = r.rgba_f32.unwrap_or_default();
            let pixel_count = f32_payload.len();
            let f32_bytes: Vec<u8> = bytemuck_like_f32_to_bytes(f32_payload);
            println!(
                "[EXR] decoded rgba_f32 bytes: {} MB ({} pixels)",
                f32_bytes.len() / 1024 / 1024,
                pixel_count
            );
            let header = ExrF32Meta {
                success: true,
                width: Some(r.width),
                height: Some(r.height),
                channels: Some(r.channels),
                layers_count: Some(r.layers_count),
                layer_names: Some(r.layer_names),
                dynamic_range: Some(r.dynamic_range),
                pass_type: Some(r.pass_type),
                format: Some("f32".to_string()),
                error: None,
            };
            serialize_exr_f32_response(header, f32_bytes)
        }
        ExrF32DecodeOutcome::DecodeFailed => {
            let header = ExrF32Meta {
                success: false,
                width: None,
                height: None,
                channels: None,
                layers_count: None,
                layer_names: None,
                dynamic_range: None,
                pass_type: None,
                format: Some("f32".to_string()),
                error: Some("Could not parse EXR file".to_string()),
            };
            serialize_exr_f32_response(header, Vec::new())
        }
    }
}

fn serialize_exr_f32_response(header: ExrF32Meta, f32_bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let header_json = serde_json::to_string(&header)
        .map_err(|e| format!("Failed to serialise header: {}", e))?;
    let header_bytes = header_json.as_bytes();
    let mut payload: Vec<u8> =
        Vec::with_capacity(4 + header_bytes.len() + f32_bytes.len());
    payload.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    payload.extend_from_slice(header_bytes);
    payload.extend_from_slice(&f32_bytes);
    Ok(payload)
}

/// Phase 6D-Lite: Convert a Vec<f32> to a Vec<u8> of IEEE 754 half-precision
/// (16-bit) floats. Halves the IPC payload for frames where the precision
/// loss is acceptable (Beauty/AOVs), while preserving the same on-wire
/// layout (raw little-endian bytes per element) so the frontend can still
/// reinterpret via `new Uint16Array(buffer).buffer`.
///
/// We always emit 2 bytes per source f32 — the same RGBA pixel count, just
/// half the byte width. The frontend's existing `float32ToFloat16Array()`
/// helper does the inverse for the GPU upload, so the on-the-wire format
/// matches what the shader already expects.
fn f32_to_f16_bytes(v: Vec<f32>) -> Vec<u8> {
    use half::f16;
    let mut out: Vec<u8> = Vec::with_capacity(v.len() * 2);
    for f in v {
        let h = f16::from_f32(f);
        out.extend_from_slice(&h.to_le_bytes());
    }
    out
}

/// Reinterpret a `Vec<f32>` as a `Vec<u8>` without copying. We do this
/// in-place: take ownership of the f32 buffer and rebuild it as a byte
/// vector over the same heap allocation. f32 is 4 bytes little-endian on
/// every platform Tauri supports, so the byte view is a valid reinter-
/// pretation.
///
/// This is the only safe way to get a `Vec<u8>` view of the same memory
/// without an extra copy, and is essential to avoid a ~3× slowdown from
/// JSON-encoding a 3.7M-element f32 array per frame.
fn bytemuck_like_f32_to_bytes(v: Vec<f32>) -> Vec<u8> {
    let mut v = std::mem::ManuallyDrop::new(v);
    let ptr = v.as_mut_ptr() as *mut u8;
    let len = v.len() * std::mem::size_of::<f32>();
    let cap = v.capacity() * std::mem::size_of::<f32>();
    // SAFETY: we took ownership of v via ManuallyDrop. The pointer, len,
    // and capacity describe a valid allocation of `len` bytes that we now
    // own as a Vec<u8>. The old Vec<f32> will not be dropped because v is
    // ManuallyDrop.
    unsafe { Vec::from_raw_parts(ptr, len, cap) }
}

/// Response payload for `get_ocio_lut` — the flat float32 LUT data plus
/// the grid size, ready for upload to a WebGL2 `sampler3D`.
///
/// **Performance note**: marshalling ~25 MB of `Vec<f32>` through the
/// Tauri IPC bridge causes V8 to allocate hundreds of MB of garbage
/// (each float serializes to ~12 chars of JSON). For the 16 built-in
/// OCIO modes pre-baked into `bundle_dist/luts/`, prefer
/// `get_ocio_lut_asset_url` + `fetch(assetUrl)` instead — that path
/// serves the same bytes via Tauri's Asset Protocol (HTTP-style) so
/// the browser handles the ArrayBuffer natively and no JSON marshal
/// happens. This command is retained for the legacy code path and
/// for the runtime-baked custom OCIO configs returned by
/// `bake_ocio_lut_from_config` (which we don't yet have on disk).
#[derive(serde::Serialize)]
pub struct OcioLutResponse {
    pub success: bool,
    pub mode: Option<String>,
    pub lut_size: Option<u32>,
    pub lut_data: Option<Vec<f32>>,
    /// Input domain the LUT was baked over (in scene-linear). The
    /// shader / CPU renderer divide per-pixel linear values by this
    /// constant before indexing the LUT. Mirrors
    /// `exr_ocio_lut::LUT_INPUT_MAX` for built-in LUTs and whatever
    /// `bake_ocio_lut.py` reports for custom configs.
    pub input_max: Option<f32>,
    pub error: Option<String>,
}

/// Tiny metadata-only response for the asset-URL flow. The frontend
/// calls `get_ocio_lut_metadata` to learn `lut_size` + `input_max`
/// (a few hundred bytes total) and `get_ocio_lut_asset_url` to learn
/// the URL to `fetch()`. None of those responses carry the float32
/// payload, so the IPC cost drops from ~400 MB of JSON to a few
/// hundred bytes. The actual LUT bytes stream over Tauri's Asset
/// Protocol which is HTTP-style and gets browser-native caching.
#[derive(serde::Serialize)]
pub struct OcioLutMetadata {
    pub success: bool,
    pub slug: Option<String>,
    pub lut_size: Option<u32>,
    pub input_max: Option<f32>,
    pub file_size_bytes: Option<u64>,
    pub error: Option<String>,
}

/// Resolve the absolute filesystem path of a built-in LUT .bin file.
/// Returns `None` if the slug is unknown or the file is missing.
fn lut_absolute_path(slug: &str) -> Option<PathBuf> {
    if exr_ocio_lut::find_entry(slug).is_none() {
        return None;
    }
    let dir = exr_ocio_lut::find_luts_dir_for_assets()?;
    let path = dir.join(format!("{}.bin", slug));
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

/// Tauri 2 `convertFileSrc` returns an `asset://localhost/...` URL
/// when given an absolute path inside the `assetProtocol.scope`. The
/// frontend can `fetch()` that URL directly and treat the response
/// as an `ArrayBuffer` for `Float32Array` consumption. No JSON
/// marshalling is involved on the hot path.
///
/// `get_ocio_lut_asset_url` resolves the slug → absolute path and
/// returns the asset URL string. The frontend pairs this with
/// `get_ocio_lut_metadata` (for `lut_size` / `input_max`) and the
/// subsequent `fetch(assetUrl)` for the raw bytes.
///
/// Tauri 2.11.2 does not yet expose `tauri::convert_file_src()` in
/// the top-level crate (that landed in PR #14786, post-2.11.2), so
/// we hand-roll the URL construction here. The format mirrors the
/// JS-side `convertFileSrc()`:
///   - Windows / Android:  `http://asset.localhost/{encoded_path}`
///   - macOS / Linux:      `asset://localhost/{encoded_path}`
///
/// The CSP in `tauri.conf.json` already whitelists both forms in
/// `connect-src` (see `http://asset.localhost`, `https://asset.localhost`,
/// `asset:`), and the `assetProtocol.scope` is `**/*` so any path
/// under the install dir is accessible.
#[tauri::command]
async fn get_ocio_lut_asset_url(mode: String) -> Result<String, String> {
    let path = lut_absolute_path(&mode).ok_or_else(|| {
        format!(
            "LUT file not found for slug '{}' (unknown slug or file missing on disk)",
            mode
        )
    })?;
    Ok(convert_file_src_to_asset_url(&path))
}

/// Build an `asset://...` URL from an absolute filesystem path.
/// Mirrors `convertFileSrc()` from `@tauri-apps/api/core` for Tauri
/// 2.11.x where the Rust-side `tauri::convert_file_src()` isn't
/// available yet (lands in PR #14786, post-2.11.2).
fn convert_file_src_to_asset_url(path: &std::path::Path) -> String {
    use std::path::PathBuf;
    // canonicalize() resolves `..` and produces an absolute path
    // without the Windows `\\?\` UNC prefix when possible.
    let canonical: PathBuf = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    // On Windows the canonical form is `\\?\C:\foo\bar.bin`. The
    // webview asset handler doesn't want the `\\?\` prefix; strip
    // it so the URL stays `/C:/foo/bar.bin` which the protocol
    // can route.
    let path_str = canonical.to_string_lossy().to_string();
    let stripped = if let Some(rest) = path_str.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path_str
    };
    // Normalize backslashes → forward slashes for the URL.
    let forward = stripped.replace('\\', "/");
    // Percent-encode the path so spaces, '#', '?', etc. survive
    // the URL parse on the webview side. `urlencoding` isn't in
    // our Cargo.toml so we roll a minimal encoder that covers the
    // characters the asset protocol cares about.
    let encoded = percent_encode_path(&forward);
    #[cfg(any(windows, target_os = "android"))]
    {
        format!("http://asset.localhost/{}", encoded)
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        format!("asset://localhost/{}", encoded)
    }
}

/// Minimal RFC 3986 percent-encoder for path segments. Encodes
/// everything except the unreserved set (`A-Z a-z 0-9 - _ . ~`) and
/// the structural path chars (`/ :` — Windows drive letter keeps
/// its colon).
fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        let is_unreserved = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'~');
        let is_structural = matches!(byte, b'/' | b':');
        if is_unreserved || is_structural {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

/// Return LUT metadata (size, input domain, file size on disk) without
/// shipping the float32 payload over IPC. Frontend pairs this with
/// `get_ocio_lut_asset_url` to avoid the 400 MB JSON marshalling cost
/// of `get_ocio_lut` for the 16 pre-baked built-in modes.
#[tauri::command]
async fn get_ocio_lut_metadata(mode: String) -> OcioLutMetadata {
    // Clone once so the error-path `slug: Some(mode)` doesn't
    // move the value out from under subsequent borrows.
    let mode_for_slug = mode.clone();
    let entry = match exr_ocio_lut::find_entry(&mode) {
        Some(e) => e,
        None => {
            return OcioLutMetadata {
                success: false,
                slug: Some(mode_for_slug),
                lut_size: None,
                input_max: None,
                file_size_bytes: None,
                error: Some(format!("Unknown OCIO mode slug: '{}'", mode)),
            };
        }
    };
    let path = match lut_absolute_path(&mode) {
        Some(p) => p,
        None => {
            return OcioLutMetadata {
                success: false,
                slug: Some(mode_for_slug),
                lut_size: None,
                input_max: None,
                file_size_bytes: None,
                error: Some(format!(
                    "LUT .bin file missing on disk for slug '{}'",
                    mode
                )),
            };
        }
    };
    let file_size = std::fs::metadata(&path).map(|m| m.len()).ok();
    OcioLutMetadata {
        success: true,
        slug: Some(mode_for_slug),
        lut_size: Some(exr_ocio_lut::DEFAULT_LUT_SIZE),
        input_max: Some(entry.lut_input_max),
        file_size_bytes: file_size,
        error: None,
    }
}

/// Fetch a baked OCIO 3D LUT for the given mode (slug form, see
/// `exr_ocio_lut::MODES`). The result is cached process-wide, so repeat
/// calls for the same mode are O(1). The frontend typically calls this
/// once at startup per OCIO mode it wants to expose.
///
/// **Prefer `get_ocio_lut_asset_url` for built-in modes** — it
/// avoids the JSON marshalling cost of returning `Vec<f32>` over
/// IPC. This command is retained for the legacy code path and for
/// runtime-baked custom OCIO configs returned by
/// `bake_ocio_lut_from_config` (which we don't yet have on disk).
#[tauri::command]
async fn get_ocio_lut(mode: String) -> OcioLutResponse {
    println!("[OCIO] get_ocio_lut called for mode={}", mode);
    match exr_ocio_lut::get_lut(&mode) {
        Ok((data, size, input_max)) => OcioLutResponse {
            success: true,
            mode: Some(mode),
            lut_size: Some(size),
            lut_data: Some(data),
            input_max: Some(input_max),
            error: None,
        },
        Err(e) => OcioLutResponse {
            success: false,
            mode: Some(mode),
            lut_size: None,
            lut_data: None,
            input_max: None,
            error: Some(e),
        },
    }
}

/// One entry in the OCIO mode list surfaced by `list_ocio_modes`.
/// `slug` is what `get_ocio_lut(mode)` accepts; `label` is the
/// human-readable name shown in the EXR Player dropdown;
/// `lut_input_max` is the scene-linear input domain the LUT was
/// baked over (mirrors `OcioLutResponse::input_max`).
///
/// Added for the ACES 1.3 / 2-level UI menu (OCIO config -> View
/// Transform): `config_slug` and `config_label` group entries so the
/// frontend can render a 2-level menu without re-parsing labels.
/// `display` and `view` are the OCIO Display/View pair baked into
/// that LUT. Legacy identity passthroughs (Linear sRGB, Raw) use
/// `config_slug = ""` so they can be filtered into a "Passthrough"
/// section by the frontend.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcioModeInfo {
    pub slug: String,
    pub config_slug: String,
    pub config_label: String,
    pub display: String,
    pub view: String,
    pub label: String,
    pub lut_input_max: f32,
    pub is_identity: bool,
}

/// Return every OCIO mode baked into the binary at build time. The
/// frontend calls this once on startup to populate the OCIO dropdown
/// without duplicating the build-time manifest in TypeScript — the
/// Rust source of truth stays `Tools/gen_luts.py` + `build.rs`.
#[tauri::command]
async fn list_ocio_modes() -> Vec<OcioModeInfo> {
    exr_ocio_lut::OCIO_MODES
        .iter()
        .map(|e| OcioModeInfo {
            slug: e.slug.to_string(),
            config_slug: e.config_slug.to_string(),
            config_label: e.config_label.to_string(),
            display: e.display.to_string(),
            view: e.view.to_string(),
            label: e.label.to_string(),
            lut_input_max: e.lut_input_max,
            is_identity: e.is_identity,
        })
        .collect()
}

/// One OCIO config exposed by `list_ocio_groups` — e.g. "ACES 1.3
/// CG" with all its (display, view) combinations grouped under it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcioConfigGroup {
    pub config_slug: String,
    pub config_label: String,
    /// One entry per (display, view) combination baked into the
    /// binary, sorted by `(display, view)` for stable UI ordering.
    pub views: Vec<OcioModeInfo>,
}

/// Return OCIO modes grouped by config so the frontend can render a
/// 2-level menu (OCIO config -> View Transform). Legacy identity
/// passthroughs (Linear sRGB, Raw) are returned with `config_slug`
/// empty; the frontend should render them in a separate "Passthrough"
/// section above the config list.
#[tauri::command]
async fn list_ocio_groups() -> Vec<OcioConfigGroup> {
    use std::collections::BTreeMap;
    let mut groups: BTreeMap<(String, String), Vec<OcioModeInfo>> = BTreeMap::new();
    // Preserve insertion order of the configured modes (Linear sRGB,
    // Raw, then ACES 1.3 CG, ACES 1.3 Studio as enumerated).
    let mut key_order: Vec<(String, String)> = Vec::new();
    for e in exr_ocio_lut::OCIO_MODES.iter() {
        let key = (e.config_slug.to_string(), e.config_label.to_string());
        if !groups.contains_key(&key) {
            key_order.push(key.clone());
        }
        groups.entry(key).or_default().push(OcioModeInfo {
            slug: e.slug.to_string(),
            config_slug: e.config_slug.to_string(),
            config_label: e.config_label.to_string(),
            display: e.display.to_string(),
            view: e.view.to_string(),
            label: e.label.to_string(),
            lut_input_max: e.lut_input_max,
            is_identity: e.is_identity,
        });
    }
    eprintln!(
        "[OCIO] list_ocio_groups returning {} groups ({} entries total)",
        key_order.len(),
        exr_ocio_lut::OCIO_MODES.len(),
    );
    key_order
        .into_iter()
        .map(|key| {
            // `remove(&key)` needs to borrow the tuple, so we copy out
            // the two strings first to avoid a `borrow of partially
            // moved value` error from the destructor on line below.
            let (slug, label) = key.clone();
            let views = groups.remove(&key).unwrap_or_default();
            OcioConfigGroup {
                config_slug: slug,
                config_label: label,
                views,
            }
        })
        .collect()
}

/// Response payload for custom OCIO config operations. The LUT (when baked)
/// uses the same float32 layout as `OcioLutResponse`.
#[derive(serde::Serialize)]
pub struct CustomOcioResponse {
    pub success: bool,
    pub lut_data: Option<Vec<f32>>,
    pub lut_size: Option<u32>,
    /// Input domain the LUT was baked over (scene-linear). The shader /
    /// CPU renderer divide per-pixel linear values by this constant
    /// before indexing. Mirrors `bake_ocio_lut.LUT_INPUT_MAX`. Only
    /// populated for bake responses.
    pub input_max: Option<f32>,
    /// Config path that was used.
    pub config_path: Option<String>,
    pub display: Option<String>,
    pub view: Option<String>,
    /// Available displays/views + defaults returned by `list`. Always
    /// populated when `success` is true, even for the bake command (so the
    /// frontend can show the available options next time).
    pub displays: Option<Vec<String>>,
    pub views: Option<Vec<String>>,
    pub default_display: Option<String>,
    pub default_view: Option<String>,
    pub error: Option<String>,
}

fn read_bake_meta(stdout: &str) -> Option<serde_json::Value> {
    // The Python script prints a JSON block delimited by
    // META_JSON_BEGIN / META_JSON_END markers. Pick the LAST block (in case
    // earlier prints leaked through OCIO's progress logs).
    let begin = "META_JSON_BEGIN";
    let end = "META_JSON_END";
    let mut last: Option<serde_json::Value> = None;
    let mut cursor = 0usize;
    while let Some(b) = stdout[cursor..].find(begin) {
        let after = cursor + b + begin.len();
        if let Some(e) = stdout[after..].find(end) {
            let block = &stdout[after..after + e].trim();
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(block) {
                last = Some(v);
            }
            cursor = after + e + end.len();
        } else {
            break;
        }
    }
    last
}

fn resolve_bundled_python() -> Option<PathBuf> {
    // 1. Prefer the bundled python that ships with the app (it carries PyOpenColorIO).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for candidate in ["python/python.exe", "python.exe"] {
                let p = parent.join(candidate);
                if p.is_file() {
                    return Some(p);
                }
            }
            // Resource path: when running via cargo, exe is in target/debug; the
            // bundle_dist lives at <repo>/bundle_dist/python relative to the
            // manifest dir which is two levels up from target/debug/.
            if let Some(debug_dir) = parent.parent() {
                if let Some(target_dir) = debug_dir.parent() {
                    let p = target_dir
                        .join("bundle_dist")
                        .join("python")
                        .join("python.exe");
                    if p.is_file() {
                        return Some(p);
                    }
                }
            }
        }
    }
    // 2. Fall back to system PATH.
    for candidate in ["python3", "python", "py"] {
        if let Ok(out) = hidden_command(candidate).arg("--version").output() {
            if out.status.success() {
                return Some(PathBuf::from(candidate));
            }
        }
    }
    None
}

fn resolve_bake_script() -> Option<PathBuf> {
    // The script lives at src-tauri/Tools/bake_ocio_lut.py. From the manifest
    // dir we just append the relative path. For dev/debug builds this resolves
    // correctly; for installed builds the script is shipped alongside the
    // exe at `Tools/bake_ocio_lut.py` (next to `python/`).
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let p = PathBuf::from(manifest).join("Tools").join("bake_ocio_lut.py");
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Installed: <install>/Tools/bake_ocio_lut.py next to the exe.
            let p = parent.join("Tools").join("bake_ocio_lut.py");
            if p.is_file() {
                return Some(p);
            }
            // dev: target/debug/goku-file-explorer.exe → ../src-tauri/Tools
            if let Some(_debug) = parent.parent() {
                if let Some(target) = parent.parent() {
                    if let Some(src_tauri) = target.parent() {
                        let p = src_tauri
                            .join("src-tauri")
                            .join("Tools")
                            .join("bake_ocio_lut.py");
                        if p.is_file() {
                            return Some(p);
                        }
                    }
                }
            }
        }
    }
    None
}

/// List the available displays + views of a custom OCIO config (no LUT baking).
/// Used by the frontend to populate dropdowns after the user picks a config.
#[tauri::command]
async fn list_ocio_config(config_path: String) -> CustomOcioResponse {
    println!("[OCIO-CUSTOM] list_ocio_config path={}", config_path);
    let python_exe = match resolve_bundled_python() {
        Some(p) => p,
        None => {
            return CustomOcioResponse {
                success: false,
                lut_data: None,
                lut_size: None,
                input_max: None,
                config_path: Some(config_path),
                display: None,
                view: None,
                displays: None,
                views: None,
                default_display: None,
                default_view: None,
                error: Some("Python not found on PATH or in bundle_dist/python/".to_string()),
            };
        }
    };
    let script = match resolve_bake_script() {
        Some(p) => p,
        None => {
            return CustomOcioResponse {
                success: false,
                lut_data: None,
                lut_size: None,
                input_max: None,
                config_path: Some(config_path),
                display: None,
                view: None,
                displays: None,
                views: None,
                default_display: None,
                default_view: None,
                error: Some("bake_ocio_lut.py not found".to_string()),
            };
        }
    };

    let python_home = python_exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let lib_dir = python_home.join("Lib").join("site-packages");
    let mut cmd = hidden_command(&python_exe);
    cmd.current_dir(script.parent().unwrap_or(&python_home))
        .arg(&script)
        .arg("list")
        .arg("--config")
        .arg(&config_path)
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONHOME")
        .env("PYTHONHOME", python_home.to_string_lossy().to_string())
        .env("PYTHONPATH", lib_dir.to_string_lossy().to_string())
        .env("PYTHONIOENCODING", "utf-8");
    let out = match cmd.output() {
        Ok(o) => o,
        Err(e) => {
            return CustomOcioResponse {
                success: false,
                lut_data: None,
                lut_size: None,
                input_max: None,
                config_path: Some(config_path),
                display: None,
                view: None,
                displays: None,
                views: None,
                default_display: None,
                default_view: None,
                error: Some(format!("spawn python failed: {}", e)),
            };
        }
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        return CustomOcioResponse {
            success: false,
            lut_data: None,
            lut_size: None,
            input_max: None,
            config_path: Some(config_path),
            display: None,
            view: None,
            displays: None,
            views: None,
            default_display: None,
            default_view: None,
            error: Some(format!(
                "OCIO config list failed (exit {:?}): {}",
                out.status.code(),
                stderr.trim()
            )),
        };
    }
    let meta = match read_bake_meta(&stdout) {
        Some(v) => v,
        None => {
            return CustomOcioResponse {
                success: false,
                lut_data: None,
                lut_size: None,
                input_max: None,
                config_path: Some(config_path),
                display: None,
                view: None,
                displays: None,
                views: None,
                default_display: None,
                default_view: None,
                error: Some("could not parse list metadata from python output".to_string()),
            };
        }
    };
    CustomOcioResponse {
        success: true,
        lut_data: None,
        lut_size: None,
        input_max: None,
        config_path: Some(config_path),
        display: None,
        view: None,
        displays: meta
            .get("displays")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()),
        views: meta
            .get("views")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()),
        default_display: meta.get("default_display").and_then(|v| v.as_str()).map(String::from),
        default_view: meta.get("default_view").and_then(|v| v.as_str()).map(String::from),
        error: None,
    }
}

/// Bake a 3D LUT from a custom OCIO config file at runtime.
///
/// Caches the result keyed by (config_path, display, view, size) so repeat
/// requests for the same triple are O(1). The frontend typically calls this
/// once per config load.
#[tauri::command]
async fn bake_ocio_lut_from_config(
    config_path: String,
    display: String,
    view: String,
    size: Option<u32>,
) -> CustomOcioResponse {
    let size = size.unwrap_or(33).clamp(8, 65);
    let cache_key = format!("{}|{}|{}|{}", config_path, display, view, size);

    println!(
        "[OCIO-CUSTOM] bake_ocio_lut_from_config path={} display={} view={} size={}",
        config_path, display, view, size
    );

    // Check cache first.
    {
        let cache = CUSTOM_LUT_CACHE
            .lock()
            .map_err(|e| format!("custom LUT cache poisoned: {}", e));
        if let Ok(ref g) = cache {
            if let Some(entry) = g.peek(&cache_key) {
                println!("[OCIO-CUSTOM] cache hit: {}", cache_key);
                return CustomOcioResponse {
                    success: true,
                    lut_data: Some(entry.data.clone()),
                    lut_size: Some(entry.size),
                    input_max: Some(entry.input_max),
                    config_path: Some(config_path),
                    display: Some(entry.display.clone()),
                    view: Some(entry.view.clone()),
                    displays: None,
                    views: None,
                    default_display: None,
                    default_view: None,
                    error: None,
                };
            }
        }
    }

    let python_exe = match resolve_bundled_python() {
        Some(p) => p,
        None => {
            return CustomOcioResponse {
                success: false,
                lut_data: None,
                lut_size: None,
                input_max: None,
                config_path: Some(config_path),
                display: None,
                view: None,
                displays: None,
                views: None,
                default_display: None,
                default_view: None,
                error: Some("Python not found on PATH or in bundle_dist/python/".to_string()),
            };
        }
    };
    let script = match resolve_bake_script() {
        Some(p) => p,
        None => {
            return CustomOcioResponse {
                success: false,
                lut_data: None,
                lut_size: None,
                input_max: None,
                config_path: Some(config_path),
                display: None,
                view: None,
                displays: None,
                views: None,
                default_display: None,
                default_view: None,
                error: Some("bake_ocio_lut.py not found".to_string()),
            };
        }
    };

    // Write to a temp file and read it back; this avoids stuffing huge
    // binary payloads through stdout.
    let tmp_path = std::env::temp_dir().join(format!(
        "gk-ocio-{}.bin",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));

    let python_home = python_exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let lib_dir = python_home.join("Lib").join("site-packages");
    let mut cmd = hidden_command(&python_exe);
    cmd.current_dir(script.parent().unwrap_or(&python_home))
        .arg(&script)
        .arg("bake")
        .arg("--config")
        .arg(&config_path)
        .arg("--display")
        .arg(&display)
        .arg("--view")
        .arg(&view)
        .arg("--size")
        .arg(size.to_string())
        .arg("--out")
        .arg(&tmp_path)
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONHOME")
        .env("PYTHONHOME", python_home.to_string_lossy().to_string())
        .env("PYTHONPATH", lib_dir.to_string_lossy().to_string())
        .env("PYTHONIOENCODING", "utf-8");
    let out = match cmd.output() {
        Ok(o) => o,
        Err(e) => {
            return CustomOcioResponse {
                success: false,
                lut_data: None,
                lut_size: None,
                input_max: None,
                config_path: Some(config_path),
                display: None,
                view: None,
                displays: None,
                views: None,
                default_display: None,
                default_view: None,
                error: Some(format!("spawn python failed: {}", e)),
            };
        }
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp_path);
        return CustomOcioResponse {
            success: false,
            lut_data: None,
            lut_size: None,
            input_max: None,
            config_path: Some(config_path),
            display: None,
            view: None,
            displays: None,
            views: None,
            default_display: None,
            default_view: None,
            error: Some(format!(
                "OCIO LUT bake failed (exit {:?}): {} | stdout={}",
                out.status.code(),
                stderr.trim(),
                stdout.trim()
            )),
        };
    }

    let meta = read_bake_meta(&stdout);
    let bytes = match std::fs::read(&tmp_path) {
        Ok(b) => b,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            return CustomOcioResponse {
                success: false,
                lut_data: None,
                lut_size: None,
                input_max: None,
                config_path: Some(config_path),
                display: None,
                view: None,
                displays: None,
                views: None,
                default_display: None,
                default_view: None,
                error: Some(format!("read baked LUT failed: {}", e)),
            };
        }
    };
    let _ = std::fs::remove_file(&tmp_path);

    let expected = (size as usize).pow(3) * 3 * 4;
    if bytes.len() != expected {
        return CustomOcioResponse {
            success: false,
            lut_data: None,
            lut_size: None,
            input_max: None,
            config_path: Some(config_path),
            display: None,
            view: None,
            displays: None,
            views: None,
            default_display: None,
            default_view: None,
            error: Some(format!(
                "baked LUT size mismatch: got {} bytes, expected {} for {}^3 grid",
                bytes.len(),
                expected,
                size
            )),
        };
    }
    let mut floats = Vec::with_capacity(expected / 4);
    for chunk in bytes.chunks_exact(4) {
        floats.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }

    // Cache it. Read the input_max from the Python metadata so the
    // shader / CPU renderer divide per-pixel linear values by the same
    // constant the LUT was baked over.
    let input_max = meta
        .as_ref()
        .and_then(|v| v.get("input_max"))
        .and_then(|v| v.as_f64())
        .map(|v| v as f32)
        .unwrap_or(16.29);
    let entry = CustomLutEntry {
        data: floats.clone(),
        size,
        input_max,
        display: display.clone(),
        view: view.clone(),
    };
    if let Ok(mut g) = CUSTOM_LUT_CACHE.lock() {
        g.put(cache_key, entry);
    }

    CustomOcioResponse {
        success: true,
        lut_data: Some(floats),
        lut_size: Some(size),
        input_max: Some(input_max),
        config_path: Some(config_path),
        display: Some(display),
        view: Some(view),
        displays: meta
            .as_ref()
            .and_then(|v| v.get("displays"))
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()),
        views: meta
            .as_ref()
            .and_then(|v| v.get("views"))
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()),
        default_display: meta
            .as_ref()
            .and_then(|v| v.get("default_display"))
            .and_then(|v| v.as_str())
            .map(String::from),
        default_view: meta
            .as_ref()
            .and_then(|v| v.get("default_view"))
            .and_then(|v| v.as_str())
            .map(String::from),
        error: None,
    }
}

struct CustomLutEntry {
    data: Vec<f32>,
    size: u32,
    /// Input domain the LUT was baked over (scene-linear). The shader /
    /// CPU renderer divide per-pixel linear values by this constant
    /// before indexing. Mirrors `bake_ocio_lut.LUT_INPUT_MAX`.
    input_max: f32,
    display: String,
    view: String,
}

/// Process-global LRU cache for custom OCIO LUTs. Keyed by
/// `<config_path>|<display>|<view>|<size>`. Two slots is plenty: typical
/// usage is one custom config cached plus the empty/error entry.
static CUSTOM_LUT_CACHE: Lazy<Mutex<LruCache<String, CustomLutEntry>>> =
    Lazy::new(|| Mutex::new(LruCache::new(NonZeroUsize::new(4).unwrap())));

// Decode EXR file to PNG base64 using OpenEXRCore FFI.
//
// Note: this path is FFI-only — there is no Python OCIO fallback. The
// returned PNG is the raw linear-encoded result of `extract_exr_thumbnail_ffi`
// (clipped to [0, 1] per channel). OCIO modes requested via `ocio_mode` are
// not applied here; the GPU pipeline in the frontend is responsible for
// tone-mapping when the user picks a non-`Linear sRGB` mode.
#[tauri::command]
async fn decode_exr(args: ExrDecodeArgs) -> ExrDecodeResult {
    let ExrDecodeArgs { path, max_size, ocio_mode, layer_name } = args;
    let size = max_size.unwrap_or(2048) as usize;

    println!("[EXR] decode_exr called for: {} ocio_mode={:?} layer={:?}", path, ocio_mode, layer_name);

    let effective_layer = if layer_name.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
        None
    } else {
        layer_name.clone()
    };

    println!("[EXR] Effective layer: {:?}", effective_layer);

    // Clone all data for the blocking task
    let path_clone = path.clone();
    let layer_clone = effective_layer.clone();
    let ocio_clone = ocio_mode.clone();

    // Use tokio::task::spawn_blocking to run blocking code on thread pool
    let result = tokio::task::spawn_blocking(move || {
        // Warn when an OCIO mode other than Linear sRGB is requested via this
        // path — we don't apply OCIO CPU-side. Frontend GPU pipeline should
        // be used for proper ACES / studio tone-mapping.
        if let Some(ref mode) = ocio_clone {
            if mode != "Linear sRGB" {
                println!("[EXR] decode_exr: ignoring ocio_mode={:?} (FFI path returns raw linear; use GPU pipeline for tone mapping)", mode);
            }
        }

        // OpenEXRCore FFI only — no Python fallback.
        let exr_path = PathBuf::from(&path_clone);
        match openexr_core::extract_exr_thumbnail_ffi(&exr_path, size) {
            Some(result) => {
                println!("[EXR] OpenEXRCore FFI SUCCESS: {}x{}, {} layers, pass_type: {}",
                    result.width, result.height, result.layers_count, result.method);
                let b64 = STANDARD.encode(&result.png_data);
                ExrDecodeResult {
                    success: true,
                    png_base64: Some(b64),
                    width: Some(result.width),
                    height: Some(result.height),
                    method: Some(result.method),
                    layers_count: Some(result.layers_count),
                    channels: Some(result.channels),
                    cryptomatte_layers: Some(result.cryptomatte_layers),
                    layer_names: Some(result.layer_names),
                    error: None,
                }
            }
            None => {
                println!("[EXR] OpenEXRCore FFI failed");
                ExrDecodeResult {
                    success: false,
                    png_base64: None,
                    width: None,
                    height: None,
                    method: None,
                    layers_count: None,
                    channels: None,
                    cryptomatte_layers: None,
                    layer_names: None,
                    error: Some("Could not parse EXR file. File may be corrupted, uses unsupported compression (deep EXR), or bundle/openexr DLLs are missing.".to_string()),
                }
            }
        }
    }).await.unwrap_or_else(|e| {
        println!("[EXR] Task panic: {}", e);
        ExrDecodeResult {
            success: false,
            png_base64: None,
            width: None,
            height: None,
            method: None,
            layers_count: None,
            channels: None,
            cryptomatte_layers: None,
            layer_names: None,
            error: Some(format!("Task panicked: {}", e)),
        }
    });

    result
}

// Result structure for EXR metadata (fast, no pixel decode)
#[derive(Debug, Serialize)]
pub struct ExrMetadataResult {
    pub success: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub channel_names: Option<Vec<String>>,
    pub layer_names: Option<Vec<ExrLayerInfo>>,
    pub cryptomatte_layers: Option<Vec<String>>,
    pub layers_count: Option<usize>,
    pub compression: Option<String>,
    pub pixel_type: Option<String>,
    pub error: Option<String>,
}

// Layer info structure for frontend
#[derive(Debug, Serialize)]
pub struct ExrLayerInfo {
    pub name: String,
    pub has_rgb: bool,
    pub has_alpha: bool,
    pub channels: Vec<String>,
}

/// Fast metadata-only extraction for EXR files
/// Returns channel/layer info WITHOUT decoding any pixels
/// This is extremely fast (~10-50ms) compared to full decode (~3-10s)
#[command]
fn get_exr_metadata(path: String) -> ExrMetadataResult {
    println!("[EXR-META] get_exr_metadata called for: {}", path);

    let exr_path = PathBuf::from(&path);

    match openexr_core::extract_exr_metadata_fast(&exr_path) {
        Some(meta) => {
            let layers_count = meta.layer_names.len();

            // Convert ExrLayerInfo to the public struct
            let layers: Vec<ExrLayerInfo> = meta.layer_names.into_iter().map(|l| ExrLayerInfo {
                name: l.name,
                has_rgb: l.has_rgb,
                has_alpha: l.has_alpha,
                channels: l.channels,
            }).collect();

            println!("[EXR-META] SUCCESS: {}x{}, {} channels, {} layers",
                meta.width, meta.height, meta.channel_names.len(), layers.len());

            ExrMetadataResult {
                success: true,
                width: Some(meta.width),
                height: Some(meta.height),
                channel_names: Some(meta.channel_names),
                layer_names: Some(layers),
                cryptomatte_layers: Some(meta.cryptomatte_layers),
                layers_count: Some(layers_count),
                compression: Some(meta.compression),
                pixel_type: Some(meta.pixel_type),
                error: None,
            }
        }
        None => {
            println!("[EXR-META] Failed to extract metadata");
            ExrMetadataResult {
                success: false,
                width: None,
                height: None,
                channel_names: None,
                layer_names: None,
                cryptomatte_layers: None,
                layers_count: None,
                compression: None,
                pixel_type: None,
                error: Some("Could not read EXR metadata. File may be corrupted or uses unsupported format.".to_string()),
            }
        }
    }
}

// Preload EXR sequence - generate LUT once, decode all frames
#[derive(serde::Deserialize)]
struct PreloadExrArgs {
    paths: Vec<String>,
    max_size: Option<u32>,
    ocio_mode: Option<String>,
    layer_name: Option<String>,
}

#[derive(serde::Serialize)]
struct PreloadResult {
    success: bool,
    cached_paths: Vec<String>,
    success_count: usize,
    cache_dir: Option<String>,
    error: Option<String>,
}

// Extract a specific channel from EXR as grayscale PNG
#[derive(serde::Serialize)]
struct ExrChannelResult {
    success: bool,
    png_base64: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    channel_name: Option<String>,
    error: Option<String>,
}

#[tauri::command]
async fn decode_exr_channel(path: String, channel: String, layer: Option<String>, max_size: Option<u32>) -> ExrChannelResult {
    println!("[EXR] decode_exr_channel called: path={} channel={} layer={:?} max_size={:?}", path, channel, layer, max_size);

    let exr_path = PathBuf::from(&path);

    // 2026-07-05: respect the frontend's `max_size` here so the channel
    // tab (R/G/B/A/Y) gets a downscaled PNG matching the active
    // preview quality, instead of the native-resolution PNG that the
    // RGB path used to return. Mirrors what `decode_exr_f32` does.
    if let Some(ref layer_name) = layer {
        if let Some(result) = openexr_core::extract_exr_channel_from_layer(&exr_path, &channel, layer_name, max_size) {
            let b64 = STANDARD.encode(&result.png_data);
            return ExrChannelResult {
                success: true,
                png_base64: Some(b64),
                width: Some(result.width),
                height: Some(result.height),
                channel_name: Some(result.channel_name),
                error: None,
            };
        }
    }

    // Old path kept for the no-layer case (legacy callers).
    let _ = max_size;

    match openexr_core::extract_exr_channel(&exr_path, &channel) {
        Some(result) => {
            println!("[EXR] Channel '{}' extracted: {}x{}", result.channel_name, result.width, result.height);
            let b64 = STANDARD.encode(&result.png_data);
            ExrChannelResult {
                success: true,
                png_base64: Some(b64),
                width: Some(result.width),
                height: Some(result.height),
                channel_name: Some(result.channel_name),
                error: None,
            }
        }
        None => {
            println!("[EXR] Channel extraction failed");
            ExrChannelResult {
                success: false,
                png_base64: None,
                width: None,
                height: None,
                channel_name: None,
                error: Some("Could not extract channel. Channel may not exist in this EXR file.".to_string()),
            }
        }
    }
}

#[derive(serde::Serialize)]
struct ExrCryptoLayerResult {
    success: bool,
    png_base64: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    crypto_layer: Option<String>,
    channels: Option<Vec<String>>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct ExrCryptoLayerArgs {
    path: String,
    crypto_layer: String,
    max_size: Option<u32>,
    coverage_mode: Option<String>,
}

#[tauri::command]
async fn decode_exr_crypto_layer(args: ExrCryptoLayerArgs) -> ExrCryptoLayerResult {
    let ExrCryptoLayerArgs { crypto_layer, .. } = args;
    ExrCryptoLayerResult {
        success: false, png_base64: None, width: None, height: None,
        crypto_layer: Some(crypto_layer),
        channels: None,
        error: Some("Cryptomatte coverage decoding is not yet supported via OpenEXRCore FFI (planned for a later phase).".to_string()),
    }
}

#[derive(serde::Serialize)]
struct ExrCryptoChannelResult {
    success: bool,
    png_base64: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    crypto_layer: Option<String>,
    component: Option<String>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct ExrCryptoChannelArgs {
    path: String,
    crypto_layer: String,
    component: String,
    max_size: Option<u32>,
}

#[tauri::command]
async fn decode_exr_crypto_channel(args: ExrCryptoChannelArgs) -> ExrCryptoChannelResult {
    let ExrCryptoChannelArgs { crypto_layer, component, .. } = args;
    ExrCryptoChannelResult {
        success: false, png_base64: None, width: None, height: None,
        crypto_layer: Some(crypto_layer),
        component: Some(component),
        error: Some("Cryptomatte channel decoding is not yet supported via OpenEXRCore FFI (planned for a later phase).".to_string()),
    }
}

// Render AI/EPS file using Inkscape (best quality vector rendering)
// Uses PowerShell to locate Inkscape in common paths (mirrors V1 approach)
#[cfg(windows)]
fn render_ai_with_inkscape(path: &str, size: usize) -> Option<Vec<u8>> {
    let escaped_path = path.replace("'", "''");
    let temp_dir = std::env::temp_dir();
    let output_path = temp_dir.join(format!("gk_ai_{}.png", std::process::id()));
    let escaped_out = output_path.to_str()?.replace("'", "''");

    // PowerShell script to find Inkscape and render (via write! macro to avoid raw string format issues)
    use std::fmt::Write as FmtWrite;
    let mut ps_script = String::new();
    let _ = writeln!(ps_script, "$ErrorActionPreference = 'SilentlyContinue'");
    let _ = writeln!(ps_script, "$inkscape = $null");
    let _ = writeln!(ps_script, "$searchPaths = @(");
    let _ = writeln!(ps_script, "    'C:\\Program Files\\Inkscape\\bin\\inkscape.exe',");
    let _ = writeln!(ps_script, "    'C:\\Program Files (x86)\\Inkscape\\bin\\inkscape.exe',");
    let _ = writeln!(ps_script, "    'C:\\Program Files\\Inkscape\\inkscape.exe',");
    let _ = writeln!(ps_script, "    'C:\\Program Files (x86)\\Inkscape\\inkscape.exe'");
    let _ = writeln!(ps_script, ")");
    let _ = writeln!(ps_script, "foreach ($p in $searchPaths) {{ if (Test-Path $p) {{ $inkscape = $p; break }} }}");
    let _ = writeln!(ps_script, "if (-not $inkscape) {{");
    let _ = writeln!(ps_script, "    $regPaths = @(");
    let _ = writeln!(ps_script, "        'HKLM:\\SOFTWARE\\Inkscape\\*\\InstallPath',");
    let _ = writeln!(ps_script, "        'HKLM:\\SOFTWARE\\Wow6432Node\\Inkscape\\*\\InstallPath',");
    let _ = writeln!(ps_script, "        'HKCU:\\SOFTWARE\\Inkscape\\*\\InstallPath'");
    let _ = writeln!(ps_script, "    )");
    let _ = writeln!(ps_script, "    foreach ($rp in $regPaths) {{");
    let _ = writeln!(ps_script, "        $val = (Get-ItemProperty $rp -ErrorAction SilentlyContinue).'(default)'");
    let _ = writeln!(ps_script, "        if ($val -and (Test-Path \"$val\\bin\\inkscape.exe\")) {{ $inkscape = \"$val\\bin\\inkscape.exe\"; break }}");
    let _ = writeln!(ps_script, "    }}");
    let _ = writeln!(ps_script, "}}");
    let _ = writeln!(ps_script, "if (-not $inkscape) {{ Write-Output 'NOTFOUND'; exit }}");
    let _ = writeln!(ps_script, "$out = '{}'", escaped_out);
    let _ = writeln!(ps_script, "$cmd = \"$inkscape\" -w={} -h={} --export-filename=`\"$out`\" --export-type=png --export-area-drawing `\"{escaped_path}`\"", size, size, escaped_path = escaped_path);
    let _ = writeln!(ps_script, "$proc = Start-Process cmd -ArgumentList '/c', $cmd -NoNewWindow -Wait -PassThru");
    let _ = writeln!(ps_script, "if ((Test-Path `$out) -and (Get-Item `$out).Length -gt 500) {{ Write-Output 'OK' }} else {{ Write-Output 'FAIL' }}");

    let tmp_dir = std::env::temp_dir();
    let ps_path = tmp_dir.join(format!("gk_ai_ps_{}.ps1", std::process::id()));

    // Write BOM-prefixed UTF-8 script
    let mut script_bytes = vec![0xEF, 0xBB, 0xBF];
    script_bytes.extend_from_slice(ps_script.as_bytes());
    if fs::write(&ps_path, &script_bytes).is_err() {
        return None;
    }

    let result = hidden_command("powershell")
        .args(&["-ExecutionPolicy", "Bypass", "-NoProfile", "-File", ps_path.to_str()?])
        .output();

    let _ = fs::remove_file(&ps_path);

    match result {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.trim() == "OK" && output_path.exists() {
                if let Ok(img) = fs::read(&output_path) {
                    let _ = fs::remove_file(&output_path);
                    return Some(img);
                }
                let _ = fs::remove_file(&output_path);
            }
        }
        Err(_) => {}
    }

    None
}

#[cfg(not(windows))]
fn render_ai_with_inkscape(_path: &str, _size: usize) -> Option<Vec<u8>> {
    None
}

// Render AI/EPS file using Poppler's pdftoppm.
// AI/EPS files from version 9.0+ are PDF containers — pdftoppm can read the PDF layer directly.
// This is ~2-3x faster than Ghostscript and uses less memory.
#[cfg(windows)]
fn render_ai_with_pdftoppm(path: &str, size: usize) -> Option<Vec<u8>> {
    let pdftoppm = get_pdftoppm_path();
    let temp_dir = std::env::temp_dir();
    let output_path = temp_dir.join(format!("gk_ai_pdf_{}_{}", std::process::id(), rand_u32()));
    let output_prefix = output_path.to_string_lossy();

    // pdftoppm syntax: pdftoppm [options] <pdf_file> <output_prefix>
    // Do NOT use -o flag — it causes I/O errors on Windows.
    // Add poppler bin dir to PATH so DLLs are found correctly.
    let poppler_dir = Path::new(&pdftoppm).parent().unwrap_or(Path::new("."));
    let mut cmd = hidden_command(&pdftoppm);
    if let Ok(current_path) = std::env::var("PATH") {
        let new_path = format!("{};{}", poppler_dir.display(), current_path);
        cmd.env("PATH", new_path);
    }
    cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .args(&[
            "-r", &format!("{}", (size as f64 * 1.5) as usize),
            "-f", "1",
            "-l", "1",
            "-png",
            "-singlefile",
            path,
            &output_prefix,
        ]);

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Poppler] Could not spawn pdftoppm for {}: {}", path, e);
            return None;
        }
    };

    // Wait with 3s timeout — long hangs on some AI files are worse than a missing preview.
    let timed_out = wait_with_timeout(child, 3_000);
    let png_path = output_path.with_extension("png");

    if timed_out {
        eprintln!("[Poppler] pdftoppm timed out after 3s for {}", path);
        let _ = fs::remove_file(&png_path);
        return None;
    }

    if !png_path.exists() {
        eprintln!("[Poppler] pdftoppm did not produce output for {}", path);
        return None;
    }

    if let Ok(img) = fs::read(&png_path) {
        let _ = fs::remove_file(&png_path);
        if img.len() > 500 {
            if let Ok(loaded) = image::load_from_memory(&img) {
                let (w, h) = calculate_thumb_dims(loaded.width(), loaded.height(), size);
                let thumb = image::imageops::resize(&loaded.to_rgb8(), w, h, image::imageops::FilterType::Lanczos3);
                let mut buf = Vec::new();
                let mut cur = std::io::Cursor::new(&mut buf);
                if thumb.write_to(&mut cur, image::ImageFormat::Png).is_ok() {
                    println!("[Poppler] Rendered AI/EPS via pdftoppm ({} bytes)", img.len());
                    return Some(buf);
                }
            }
            return Some(img);
        }
    }
    let _ = fs::remove_file(&png_path);
    None
}

// Wait for a child process with a timeout (milliseconds).
// Returns true if timed out (process was killed), false if exited normally.
#[cfg(windows)]
fn wait_with_timeout(mut child: std::process::Child, ms: u64) -> bool {
    let start = std::time::Instant::now();
    loop {
        match child.try_wait().ok() {
            Some(Some(status)) => {
                if !status.success() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                return false;
            }
            Some(None) => {
                if start.elapsed().as_millis() as u64 >= ms {
                    let _ = child.kill();
                    let _ = child.wait();
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            None => {
                if start.elapsed().as_millis() as u64 >= ms {
                    let _ = child.kill();
                    let _ = child.wait();
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}

// Generate a small random suffix to avoid collisions when multiple pdftoppm
// processes run simultaneously (e.g., preview + grid thumbnails).
#[cfg(windows)]
fn rand_u32() -> u32 {
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    nanos.wrapping_mul(1103515245).wrapping_add(12345)
}

#[cfg(not(windows))]
fn render_ai_with_pdftoppm(_path: &str, _size: usize) -> Option<Vec<u8>> {
    None
}

// Render AI/EPS file using PyMuPDF via bundled Python script.
// Strategy: Check cache first → Try acquire Python slot (5s timeout) → Run Python → Store in cache.
// If slot can't be acquired within 5s, returns None immediately so the HTTP handler's fallback
// chain (embedded JPEG, pdftoppm, Shell thumbnail, Ghostscript) can proceed without blocking.
#[cfg(windows)]
fn render_ai_with_mupdf(path: &str, size: usize) -> Option<Vec<u8>> {
    // ── Step 1: Check LRU cache (fast path — no I/O) ─────────────────────────
    let cache_key = format!("{}:{}", path, size);
    if let Ok(mut g) = get_thumb_cache().lock() {
        if let Some(cached) = g.get(&cache_key) {
            println!("[AI] cache hit: {}:{}", path, size);
            return Some(cached.to_vec());
        }
    }

    // ── Step 2: Prepare paths ─────────────────────────────────────────────────
    let python_exe = match bundled_resource("python", "python.exe") {
        Some(p) => p,
        None => {
            println!("[AI] python.exe NOT FOUND — falling through to other handlers");
            return None;
        }
    };
    let script_path = match bundled_resource("python", "Tools/ai_server.py") {
        Some(p) => p,
        None => {
            println!("[AI] ai_server.py NOT FOUND — falling through");
            return None;
        }
    };
    // python_home is the parent directory of python.exe (e.g. .../python/)
    let python_home = python_exe.parent()?.to_path_buf();
    let lib_dir = python_home.join("Lib").join("site-packages");
    let script_dir = script_path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| python_home.clone());

    // ── Step 3: Try acquire Python slot (max 2 concurrent, 5s timeout) ───────
    // IMPORTANT: do NOT block indefinitely. If slots are busy, let the HTTP handler's
    // fallback chain run (embedded JPEG → pdftoppm → Shell thumbnail → Ghostscript).
    let _slot = match PythonSlot::try_acquire(5000) {
        Some(s) => s,
        None => {
            println!("[AI] slot busy (>5s wait) — skipping Python, letting fallback handle");
            return None;
        }
    };

    // ── Step 4: Run Python ───────────────────────────────────────────────────
    println!("[AI] Running: python {} {} {}", script_path.display(), path, size);

    let png_data_opt = {
        let mut cmd = hidden_command(&python_exe);
        cmd.current_dir(&script_dir)
            .args([&script_path.to_string_lossy(), path, &size.to_string()])
            .env_remove("PYTHONPATH")
            .env_remove("PYTHONHOME")
            .env("PYTHONHOME", python_home.to_string_lossy().to_string())
            .env("PYTHONPATH", lib_dir.to_string_lossy().to_string())
            .env("PYTHONIOENCODING", "utf-8");

        match cmd.output() {
            Ok(out) if out.status.success() => {
                let png_data = out.stdout;
                if png_data.len() > 500 {
                    println!("[AI] PyMuPDF OK ({} bytes)", png_data.len());
                    Some(png_data)
                } else {
                    println!("[AI] PyMuPDF too small ({} bytes)", png_data.len());
                    None
                }
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                eprintln!("[AI] PyMuPDF failed (exit {}): {}", out.status, stderr);
                None
            }
            Err(e) => {
                eprintln!("[AI] spawn Python failed: {}", e);
                None
            }
        }
    };

    // ── Step 5: Store result in LRU cache ────────────────────────────────────
    if let Some(ref png) = png_data_opt {
        if let Ok(mut g) = get_thumb_cache().lock() {
            g.put(cache_key, std::borrow::Cow::Owned(png.clone()));
        }
    }

    // _slot is dropped here → Python slot released
    png_data_opt
}

#[cfg(not(windows))]
fn render_ai_with_mupdf(_path: &str, _size: usize) -> Option<Vec<u8>> {
    None
}

// Render TIFF to PNG using ffmpeg — handles all TIFF variants (grayscale, 16-bit, CMYK, LAB, etc.)
// Smart sizing: images < max_size stay at original dimensions; images > max_size scale down to max_size.
fn render_tif_with_ffmpeg(path: &str, max_size: usize) -> Option<Vec<u8>> {
    let ffmpeg_path = get_ffmpeg_path();
    let temp_dir = std::env::temp_dir();
    let output_path = temp_dir.join(format!("gk_tif_thumb_{}.png", std::process::id()));

    let output = hidden_command(&ffmpeg_path)
        .args(&[
            "-y",
            "-i", path,
            "-vf", &format!("scale={}:{}:force_original_aspect_ratio=decrease", max_size, max_size),
            "-frames:v", "1",
            "-f", "image2",
            output_path.to_str()?,
        ])
        .output()
        .ok()?;

    if !output.status.success() || !output_path.exists() {
        let _ = fs::remove_file(&output_path);
        return None;
    }

    let png_data = fs::read(&output_path).ok()?;
    let _ = fs::remove_file(&output_path);
    Some(png_data)
}

// Render AI/EPS file using Ghostscript
#[cfg(windows)]
fn render_ai_with_ghostscript(path: &str, size: usize) -> Option<Vec<u8>> {
    // Try to find Ghostscript in common locations
    let gs_exe = std::env::var("ProgramFiles").ok()
        .map(|pf| Path::new(&pf).join("gs"))
        .filter(|p| p.exists())
        .and_then(|gs_dir| {
            let entries = fs::read_dir(&gs_dir).ok()?;
            let mut dirs: Vec<_> = entries.filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter(|e| e.file_name().to_string_lossy().starts_with("gs"))
                .collect();
            dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
            dirs.into_iter().next()
        })
        .and_then(|d| {
            let bin = d.path().join("bin").join("gswin64c.exe");
            if bin.exists() { Some(bin.to_string_lossy().to_string()) } else { None }
        })
        .or_else(|| {
            if Path::new("gswin64c.exe").exists() { Some("gswin64c.exe".to_string()) } else { None }
        });

    let gs_exe = gs_exe?;

    let temp_dir = std::env::temp_dir();
    let output_path = temp_dir.join(format!("gk_ai_gs_{}.png", std::process::id()));

    let result = hidden_command(&gs_exe)
        .args(&[
            "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
            "-sDEVICE=png16m",
            "-r2048",
            "-dTextAlphaBits=4",
            "-dGraphicsAlphaBits=4",
            "-dFirstPage=1",
            "-dLastPage=1",
            "-sOutputFile", output_path.to_str()?,
            path,
        ])
        .output();

    match result {
        Ok(output) => {
            if output.status.success() && output_path.exists() {
                if let Ok(img) = fs::read(&output_path) {
                    let _ = fs::remove_file(&output_path);
                    if img.len() > 500 {
                        // Optionally resize
                        if let Ok(loaded) = image::load_from_memory(&img) {
                            let (w, h) = calculate_thumb_dims(loaded.width(), loaded.height(), size);
                            let thumb = image::imageops::resize(&loaded.to_rgb8(), w, h, image::imageops::FilterType::Lanczos3);
                            let mut buf = Vec::new();
                            let mut cur = std::io::Cursor::new(&mut buf);
                            if thumb.write_to(&mut cur, image::ImageFormat::Png).is_ok() {
                                return Some(buf);
                            }
                        }
                        return Some(img);
                    }
                }
            }
            let _ = fs::remove_file(&output_path);
        }
        Err(_) => {}
    }

    None
}

#[cfg(not(windows))]
fn render_ai_with_ghostscript(_path: &str, _size: usize) -> Option<Vec<u8>> {
    None
}

// Render AI/EPS/PDF file using Windows.Data.Pdf (built into Windows 10/11)
// This is the same approach V1 uses as a last resort fallback for AI files
#[cfg(windows)]
fn render_ai_with_windows_pdf(path: &str, size: usize) -> Option<Vec<u8>> {
    let escaped_path = path.replace("'", "''");
    let temp_dir = std::env::temp_dir();
    let output_path = temp_dir.join(format!("gk_pdf_{}.png", std::process::id()));
    let escaped_out = output_path.to_str()?.replace("'", "''");

    // PowerShell script using Windows.Data.Pdf to render first page as PNG
    let mut ps_script = String::new();
    use std::fmt::Write as FmtWrite;
    let _ = writeln!(ps_script, "Add-Type -AssemblyName System.Runtime.WindowsRuntime");
    let _ = writeln!(ps_script, "Add-Type -AssemblyName System.Runtime");
    let _ = writeln!(ps_script, "$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime]");
    let _ = writeln!(ps_script, "$null = [Windows.Graphics.Imaging.BitmapEncoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]");
    let _ = writeln!(ps_script, "$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]");
    let _ = writeln!(ps_script, "Add-Type -Path 'C:\\Program Files (x86)\\Reference Assemblies\\Microsoft\\\\Framework\\.NETCore\\v5.0\\System.Runtime.WindowsRuntime.dll'");
    let _ = writeln!(ps_script, "[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime] | Out-Null");
    let _ = writeln!(ps_script, "try {{");
    let _ = writeln!(ps_script, "    $file = [Windows.Storage.StorageFile]::GetFileFromPathAsync('{}').GetAwaiter().GetResult()", escaped_path);
    let _ = writeln!(ps_script, "    $doc = [Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file).GetAwaiter().GetResult()");
    let _ = writeln!(ps_script, "    if ($doc.PageCount -eq 0) {{ exit 1 }}");
    let _ = writeln!(ps_script, "    $page = $doc.GetPage(0)");
    let _ = writeln!(ps_script, "    $props = $page.Size");
    let _ = writeln!(ps_script, "    $w = [int]$props.Width; $h = [int]$props.Height");
    let _ = writeln!(ps_script, "    $scale = [Math]::Min({size}.0 / $w, {size}.0 / $h, 1.0)", size = size);
    let _ = writeln!(ps_script, "    $bw = [int]($w * $scale); $bh = [int]($h * $scale)");
    let _ = writeln!(ps_script, "    $render = $page.RenderToBitmapAsync($bw, $bh, 0, 0).GetAwaiter().GetResult()");
    let _ = writeln!(ps_script, "    $stream = [System.IO.MemoryStream]::new()");
    let _ = writeln!(ps_script, "    $encoder = [Windows.Graphics.Imaging.BitmapEncoder]::CreateForTranscodingAsync($stream.AsRandomAccessStream(), $render).GetAwaiter().GetResult()");
    let _ = writeln!(ps_script, "    $encoder.FlushAsync().GetAwaiter().GetResult()");
    let _ = writeln!(ps_script, "    [System.IO.File]::WriteAllBytes('{}', $stream.ToArray())", escaped_out);
    let _ = writeln!(ps_script, "    if ((Test-Path '{}') -and (Get-Item '{}').Length -gt 500) {{ Write-Output 'OK' }} else {{ Write-Output 'FAIL' }}", escaped_out, escaped_out);
    let _ = writeln!(ps_script, "}} catch {{ Write-Output 'ERROR'; exit 1 }}");

    let tmp_dir = std::env::temp_dir();
    let ps_path = tmp_dir.join(format!("gk_pdf_{}.ps1", std::process::id()));

    let mut script_bytes = vec![0xEF, 0xBB, 0xBF];
    script_bytes.extend_from_slice(ps_script.as_bytes());
    if fs::write(&ps_path, &script_bytes).is_err() {
        return None;
    }

    let result = hidden_command("powershell")
        .args(&["-ExecutionPolicy", "Bypass", "-NoProfile", "-File", ps_path.to_str()?])
        .output();

    let _ = fs::remove_file(&ps_path);

    match result {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.trim() == "OK" && output_path.exists() {
                if let Ok(img) = fs::read(&output_path) {
                    let _ = fs::remove_file(&output_path);
                    return Some(img);
                }
                let _ = fs::remove_file(&output_path);
            }
        }
        Err(_) => {}
    }

    // Try simpler approach: write to IRandomAccessStream then convert
    let mut ps_script2 = String::new();
    let _ = writeln!(ps_script2, "Add-Type -AssemblyName System.Drawing");
    let _ = writeln!(ps_script2, "Add-Type -AssemblyName WindowsBase");
    let _ = writeln!(ps_script2, "Add-Type -AssemblyName PresentationCore");
    let _ = writeln!(ps_script2, "try {{");
    let _ = writeln!(ps_script2, "    $img = [System.Drawing.Image]::FromFile('{}')", escaped_path);
    let _ = writeln!(ps_script2, "    if ($img) {{");
    let _ = writeln!(ps_script2, "        $nw = [Math]::Max(1, [int]($img.Width * {size}.0 / [Math]::Max($img.Width, $img.Height)))", size = size);
    let _ = writeln!(ps_script2, "        $nh = [Math]::Max(1, [int]($img.Height * {size}.0 / [Math]::Max($img.Width, $img.Height)))");
    let _ = writeln!(ps_script2, "        $bmp = New-Object System.Drawing.Bitmap($nw, $nh)");
    let _ = writeln!(ps_script2, "        $g = [System.Drawing.Graphics]::FromImage($bmp)");
    let _ = writeln!(ps_script2, "        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic");
    let _ = writeln!(ps_script2, "        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality");
    let _ = writeln!(ps_script2, "        $g.Clear([System.Drawing.Color]::White)");
    let _ = writeln!(ps_script2, "        $g.DrawImage($img, 0, 0, $nw, $nh)");
    let _ = writeln!(ps_script2, "        $ms = [System.IO.MemoryStream]::new()");
    let _ = writeln!(ps_script2, "        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)");
    let _ = writeln!(ps_script2, "        [System.IO.File]::WriteAllBytes('{}', $ms.ToArray())", escaped_out);
    let _ = writeln!(ps_script2, "        $g.Dispose(); $bmp.Dispose(); $img.Dispose(); $ms.Dispose()");
    let _ = writeln!(ps_script2, "        if ((Test-Path '{}') -and (Get-Item '{}').Length -gt 500) {{ Write-Output 'OK' }} else {{ Write-Output 'FAIL' }}", escaped_out, escaped_out);
    let _ = writeln!(ps_script2, "    }} else {{ Write-Output 'FAIL' }}");
    let _ = writeln!(ps_script2, "}} catch {{ Write-Output 'FAIL'; exit 0 }}");

    let ps_path2 = tmp_dir.join(format!("gk_pdf2_{}.ps1", std::process::id()));
    let mut script_bytes2 = vec![0xEF, 0xBB, 0xBF];
    script_bytes2.extend_from_slice(ps_script2.as_bytes());
    if fs::write(&ps_path2, &script_bytes2).is_ok() {
        let result2 = hidden_command("powershell")
            .args(&["-ExecutionPolicy", "Bypass", "-NoProfile", "-File", ps_path2.to_str()?])
            .output();
        let _ = fs::remove_file(&ps_path2);
        if let Ok(output2) = result2 {
            let stdout2 = String::from_utf8_lossy(&output2.stdout);
            if stdout2.trim() == "OK" && output_path.exists() {
                if let Ok(img) = fs::read(&output_path) {
                    let _ = fs::remove_file(&output_path);
                    return Some(img);
                }
                let _ = fs::remove_file(&output_path);
            }
        }
    }

    None
}

#[cfg(not(windows))]
fn render_ai_with_windows_pdf(_path: &str, _size: usize) -> Option<Vec<u8>> {
    None
}

// Decode AI/EPS file to PNG base64 (async with progress)
#[tauri::command]
async fn decode_ai(app: tauri::AppHandle, path: String, max_size: Option<u32>) -> DecodeResult {
    let size = max_size.unwrap_or(2048) as usize;
    let emit = make_decode_progressEmitter(&app, &path);

    // Check disk cache first (avoids expensive decode for previously-loaded files)
    if let Some(png_data) = load_from_disk_cache(&path, size) {
        println!("[decode_ai] disk cache hit: {} ({} bytes)", path, png_data.len());
        // Populate LRU cache
        let cache_key = format!("{}:{}", path, size);
        if let Ok(mut guard) = get_thumb_cache().lock() {
            guard.put(cache_key, std::borrow::Cow::Owned(png_data.clone()));
        }
        let b64 = STANDARD.encode(&png_data);
        let (w, h) = if let Ok(img) = image::load_from_memory(&png_data) {
            (Some(img.width()), Some(img.height()))
        } else {
            (None, None)
        };
        emit(100);
        return DecodeResult {
            success: true,
            png_base64: Some(b64),
            width: w,
            height: h,
            method: Some("disk_cache".to_string()),
            layers_count: None,
            error: None,
        };
    }

    emit(10);

    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => return DecodeResult {
            success: false, png_base64: None, width: None, height: None,
            method: None, layers_count: None, error: Some(e.to_string()),
        },
    };

    emit(20);
    println!("[AI] Attempting to decode: {}", path);

    // Fast path: extract embedded JPEG preview
    if let Some(jpeg_data) = extract_embedded_jpeg(&bytes, size) {
        println!("[AI] Found embedded JPEG preview ({} bytes)", jpeg_data.len());
        emit(50);
        // Decode JPEG to PNG and cache so the file grid icon refreshes.
        // Without this, the AI file's thumbnail stays as the default icon
        // even after decode completes.
        if let Ok(img) = image::load_from_memory(&jpeg_data) {
            let (thumb_w, thumb_h) = calculate_thumb_dims(img.width(), img.height(), size);
            let thumb = image::imageops::resize(&img.to_rgb8(), thumb_w, thumb_h, image::imageops::FilterType::Lanczos3);
            let mut buffer = Vec::new();
            let mut cursor = std::io::Cursor::new(&mut buffer);
            if thumb.write_to(&mut cursor, image::ImageFormat::Png).is_ok() {
                // Cache the resized PNG at all sizes (256/160/64) so the
                // grid icon updates immediately via thumbnail-ready event.
                cache_decoded_result(&app, &path, size, &buffer);
                let b64 = STANDARD.encode(&buffer);
                emit(100);
                return DecodeResult {
                    success: true,
                    png_base64: Some(b64),
                    width: Some(img.width()),
                    height: Some(img.height()),
                    method: Some("jpeg_preview".to_string()),
                    layers_count: None,
                    error: None,
                };
            }
        }
        // Fallback: JPEG bytes weren't decodable as PNG — cache the raw JPEG anyway
        // so the icon cache at least updates, even if we don't resize.
        cache_decoded_result(&app, &path, size, &jpeg_data);
        let b64 = STANDARD.encode(&jpeg_data);
        emit(100);
        return DecodeResult {
            success: true,
            png_base64: Some(b64),
            width: None,
            height: None,
            method: Some("jpeg_preview".to_string()),
            layers_count: None,
            error: None,
        };
    }

    emit(30);

    // Fallback 1: PyMuPDF via Python script
    if let Some(png_data) = render_ai_with_mupdf(&path, size) {
        emit(60);
        cache_decoded_result(&app, &path, size, &png_data);
        let b64 = STANDARD.encode(&png_data);
        let (w, h) = if let Ok(img) = image::load_from_memory(&png_data) {
            (Some(img.width()), Some(img.height()))
        } else {
            (None, None)
        };
        emit(100);
        return DecodeResult {
            success: true,
            png_base64: Some(b64),
            width: w,
            height: h,
            method: Some("pymupdf".to_string()),
            layers_count: None,
            error: None,
        };
    }

    emit(40);

    // Fallback 2: Inkscape
    if let Some(png_data) = render_ai_with_inkscape(&path, size) {
        emit(60);
        cache_decoded_result(&app, &path, size, &png_data);
        let b64 = STANDARD.encode(&png_data);
        let (w, h) = if let Ok(img) = image::load_from_memory(&png_data) {
            (Some(img.width()), Some(img.height()))
        } else {
            (None, None)
        };
        emit(100);
        return DecodeResult {
            success: true,
            png_base64: Some(b64),
            width: w,
            height: h,
            method: Some("inkscape".to_string()),
            layers_count: None,
            error: None,
        };
    }

    emit(50);

    // Fallback 3: Poppler pdftoppm
    if let Some(png_data) = render_ai_with_pdftoppm(&path, size) {
        emit(70);
        cache_decoded_result(&app, &path, size, &png_data);
        let b64 = STANDARD.encode(&png_data);
        let (w, h) = if let Ok(img) = image::load_from_memory(&png_data) {
            (Some(img.width()), Some(img.height()))
        } else {
            (None, None)
        };
        emit(100);
        return DecodeResult {
            success: true,
            png_base64: Some(b64),
            width: w,
            height: h,
            method: Some("pdftoppm".to_string()),
            layers_count: None,
            error: None,
        };
    }

    emit(60);

    // Fallback 4: Ghostscript
    if let Some(png_data) = render_ai_with_ghostscript(&path, size) {
        emit(80);
        cache_decoded_result(&app, &path, size, &png_data);
        let b64 = STANDARD.encode(&png_data);
        let (w, h) = if let Ok(img) = image::load_from_memory(&png_data) {
            (Some(img.width()), Some(img.height()))
        } else {
            (None, None)
        };
        emit(100);
        return DecodeResult {
            success: true,
            png_base64: Some(b64),
            width: w,
            height: h,
            method: Some("ghostscript".to_string()),
            layers_count: None,
            error: None,
        };
    }

    emit(70);

    // Fallback 5: Windows built-in PDF
    if let Some(png_data) = render_ai_with_windows_pdf(&path, size) {
        emit(90);
        cache_decoded_result(&app, &path, size, &png_data);
        let b64 = STANDARD.encode(&png_data);
        let (w, h) = if let Ok(img) = image::load_from_memory(&png_data) {
            (Some(img.width()), Some(img.height()))
        } else {
            (None, None)
        };
        emit(100);
        return DecodeResult {
            success: true,
            png_base64: Some(b64),
            width: w,
            height: h,
            method: Some("windows_pdf".to_string()),
            layers_count: None,
            error: None,
        };
    }

    emit(80);

    // Fallback 6: Windows Shell
    if let Some(png_data) = extract_thumbnail_via_shell(&path, size, false) {
        cache_decoded_result(&app, &path, size, &png_data);
        emit(100);
        let b64 = STANDARD.encode(&png_data);
        let (w, h) = if let Ok(img) = image::load_from_memory(&png_data) {
            (Some(img.width()), Some(img.height()))
        } else {
            (None, None)
        };
        return DecodeResult {
            success: true,
            png_base64: Some(b64),
            width: w,
            height: h,
            method: Some("windows_shell".to_string()),
            layers_count: None,
            error: None,
        };
    }

    emit(100);
    DecodeResult {
        success: false, png_base64: None, width: None, height: None,
        method: None, layers_count: None,
        error: Some("AI/EPS file has no embedded preview and none of the renderers (Inkscape, Ghostscript, Windows.Data.Pdf) are available. Please install Inkscape or Ghostscript.".to_string()),
    }
}

// Decode C4D (Cinema 4D) file to PNG base64 (async with progress)
#[tauri::command]
async fn decode_c4d(app: tauri::AppHandle, path: String, max_size: Option<u32>) -> DecodeResult {
    let size = max_size.unwrap_or(2048) as usize;
    let emit = make_decode_progressEmitter(&app, &path);

    emit(10);

    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => return DecodeResult {
            success: false, png_base64: None, width: None, height: None,
            method: None, layers_count: None, error: Some(e.to_string()),
        },
    };

    emit(30);

    // Method 1 (preferred): Embedded JPEG preview. C4D files embed a real
    // (often large) JPEG inside their RAR-like container — much higher
    // quality than the small 256x256 thumbnail that Cinema 4D writes into
    // the file's Windows Shell metadata. Skipping Shell first ensures the
    // preview shows a sharp image instead of a tiny placeholder.
    if let Some(jpeg_data) = extract_embedded_jpeg(&bytes, size) {
        emit(60);
        if let Ok(img) = image::load_from_memory(&jpeg_data) {
            let (thumb_w, thumb_h) = calculate_thumb_dims(img.width(), img.height(), size);
            let thumb = image::imageops::resize(&img.to_rgb8(), thumb_w, thumb_h, image::imageops::FilterType::Lanczos3);
            let mut buffer = Vec::new();
            let mut cursor = std::io::Cursor::new(&mut buffer);
            if thumb.write_to(&mut cursor, image::ImageFormat::Png).is_ok() {
                cache_decoded_result(&app, &path, size, &buffer);
                let b64 = STANDARD.encode(&buffer);
                emit(100);
                return DecodeResult {
                    success: true,
                    png_base64: Some(b64),
                    width: Some(img.width()),
                    height: Some(img.height()),
                    method: Some("c4d_embedded_preview".to_string()),
                    layers_count: None,
                    error: None,
                };
            }
        }
        cache_decoded_result(&app, &path, size, &jpeg_data);
        let b64 = STANDARD.encode(&jpeg_data);
        emit(100);
        return DecodeResult {
            success: true,
            png_base64: Some(b64),
            width: None,
            height: None,
            method: Some("c4d_embedded_preview".to_string()),
            layers_count: None,
            error: None,
        };
    }

    emit(50);

    // Method 2: RAR-like sub-block JPEG extraction. C4D files use a RAR-like
    // container; search sub-blocks for an embedded preview image.
    if let Some(jpeg_data) = extract_jpeg_from_c4d(&bytes, size) {
        emit(70);
        cache_decoded_result(&app, &path, size, &jpeg_data);
        let b64 = STANDARD.encode(&jpeg_data);
        if let Ok(img) = image::load_from_memory(&jpeg_data) {
            emit(100);
            return DecodeResult {
                success: true,
                png_base64: Some(b64),
                width: Some(img.width()),
                height: Some(img.height()),
                method: Some("c4d_rar_block".to_string()),
                layers_count: None,
                error: None,
            };
        }
        emit(100);
        return DecodeResult {
            success: true,
            png_base64: Some(b64),
            width: None,
            height: None,
            method: Some("c4d_rar_block".to_string()),
            layers_count: None,
            error: None,
        };
    }

    emit(80);

    // Method 3 (last resort): Windows Shell thumbnail. C4D's Windows-cached
    // thumbnail is typically only 256x256, but better than no preview.
    if let Some(png_data) = extract_thumbnail_via_shell(&path, size, false) {
        cache_decoded_result(&app, &path, size, &png_data);
        let b64 = STANDARD.encode(&png_data);
        let (w, h) = if let Ok(img) = image::load_from_memory(&png_data) {
            (Some(img.width()), Some(img.height()))
        } else {
            (None, None)
        };
        emit(100);
        return DecodeResult {
            success: true,
            png_base64: Some(b64),
            width: w,
            height: h,
            method: Some("windows_shell".to_string()),
            layers_count: None,
            error: None,
        };
    }

    emit(100);
    DecodeResult {
        success: false, png_base64: None, width: None, height: None,
        method: None, layers_count: None,
        error: Some("C4D file has no embedded preview. Cinema 4D must be installed for previews.".to_string()),
    }
}

// Try to extract JPEG from C4D file's RAR-like archive structure
fn extract_jpeg_from_c4d(data: &[u8], max_size: usize) -> Option<Vec<u8>> {
    // C4D RAR container: look for embedded JPEG within sub-blocks
    // Scan for JPEG starts and find largest one
    let mut candidates: Vec<(usize, usize)> = Vec::new();

    for i in 0..data.len().saturating_sub(3) {
        if data[i] == 0xFF && data[i + 1] == 0xD8 && data[i + 2] == 0xFF {
            // Found JPEG start - find end marker
            let remaining = &data[i..];
            if let Some(end_pos) = remaining[2..].windows(2).position(|w| w == [0xFF, 0xD9]) {
                let end = i + 2 + end_pos + 2;
                if end > i + 5000 { // Must be substantial
                    candidates.push((i, end));
                }
            }
        }
    }

    // Use the largest JPEG found
    if let Some((start, end)) = candidates.into_iter().max_by_key(|(s, e)| *e - *s) {
        let jpeg_data = &data[start..end];
        if let Ok(img) = image::load_from_memory(jpeg_data) {
            let (thumb_w, thumb_h) = if img.width() > img.height() {
                (max_size as u32, ((img.height() as f64 / img.width() as f64) * max_size as f64).max(1.0) as u32)
            } else {
                (((img.width() as f64 / img.height() as f64) * max_size as f64).max(1.0) as u32, max_size as u32)
            };
            let thumb = image::imageops::resize(&img.to_rgb8(), thumb_w, thumb_h, image::imageops::FilterType::Lanczos3);
            let mut buffer = Vec::new();
            let mut cursor = std::io::Cursor::new(&mut buffer);
            if thumb.write_to(&mut cursor, image::ImageFormat::Png).is_ok() {
                return Some(buffer);
            }
        }
    }
    None
}

// Decode PureRef (.pureref) file to PNG base64 (async with progress)
#[tauri::command]
async fn decode_pureref(app: tauri::AppHandle, path: String, max_size: Option<u32>) -> DecodeResult {
    let size = max_size.unwrap_or(2048) as usize;
    let emit = make_decode_progressEmitter(&app, &path);

    emit(10);

    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => return DecodeResult {
            success: false, png_base64: None, width: None, height: None,
            method: None, layers_count: None, error: Some(e.to_string()),
        },
    };

    emit(30);

    // Try ZIP extraction first (PureRef files are ZIP archives)
    if let Some(img_data) = extract_first_image_from_pureref(&bytes, size) {
        emit(80);
        // Cache at all sizes (256/160/64) so the file grid icon refreshes.
        cache_decoded_result(&app, &path, size, &img_data);
        let b64 = STANDARD.encode(&img_data);
        // Detect format from first few bytes
        let method = if img_data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
            "pureref_png".to_string()
        } else {
            "pureref_jpeg".to_string()
        };
        if let Ok(img) = image::load_from_memory(&img_data) {
            emit(100);
            return DecodeResult {
                success: true,
                png_base64: Some(b64),
                width: Some(img.width()),
                height: Some(img.height()),
                method: Some(method),
                layers_count: None,
                error: None,
            };
        }
    }

    emit(50);

    // Try Windows Shell thumbnail as fallback
    if let Some(png_data) = extract_thumbnail_via_shell(&path, size, false) {
        cache_decoded_result(&app, &path, size, &png_data);
        emit(100);
        let b64 = STANDARD.encode(&png_data);
        let (w, h) = if let Ok(img) = image::load_from_memory(&png_data) {
            (Some(img.width()), Some(img.height()))
        } else {
            (None, None)
        };
        return DecodeResult {
            success: true,
            png_base64: Some(b64),
            width: w,
            height: h,
            method: Some("windows_shell".to_string()),
            layers_count: None,
            error: None,
        };
    }

    emit(100);
    DecodeResult {
        success: false, png_base64: None, width: None, height: None,
        method: None, layers_count: None,
        error: Some("PureRef file has no embedded images or is corrupted.".to_string()),
    }
}

// Extract first image from PureRef ZIP archive
fn extract_first_image_from_pureref(data: &[u8], max_size: usize) -> Option<Vec<u8>> {
    let cursor = std::io::Cursor::new(data);
    let mut archive = match zip::ZipArchive::new(cursor) {
        Ok(a) => a,
        Err(_) => return None,
    };

    let mut largest_img: Option<Vec<u8>> = None;
    let mut largest_size = 0;

    for i in 0..archive.len() {
        if let Ok(mut file) = archive.by_index(i) {
            let name = file.name().to_lowercase();
            // Look for image files
            if name.ends_with(".png") || name.ends_with(".jpg") || name.ends_with(".jpeg") || name.ends_with(".jpg_large") {
                let mut img_data = Vec::new();
                if file.read_to_end(&mut img_data).is_ok() && img_data.len() > largest_size {
                    largest_size = img_data.len();
                    largest_img = Some(img_data);
                }
            }
        }
    }

    // Resize if needed
    if let Some(img_data) = largest_img {
        if let Ok(img) = image::load_from_memory(&img_data) {
            let (thumb_w, thumb_h) = if img.width() > img.height() {
                (max_size as u32, ((img.height() as f64 / img.width() as f64) * max_size as f64).max(1.0) as u32)
            } else {
                (((img.width() as f64 / img.height() as f64) * max_size as f64).max(1.0) as u32, max_size as u32)
            };
            let thumb = image::imageops::resize(&img.to_rgb8(), thumb_w, thumb_h, image::imageops::FilterType::Lanczos3);
            let mut buffer = Vec::new();
            let mut cursor_out = std::io::Cursor::new(&mut buffer);
            // Output as PNG for quality
            if thumb.write_to(&mut cursor_out, image::ImageFormat::Png).is_ok() {
                return Some(buffer);
            }
        }
    }
    None
}

// Get Windows Shell icon as base64 PNG for file type icons
#[command]
fn get_file_icon_base64(path: String, size: Option<u32>) -> Result<String, String> {
    let max_size = size.unwrap_or(256) as usize;
    let png_data = extract_thumbnail_via_shell(&path, max_size, false)
        .ok_or_else(|| "No icon available".to_string())?;
    Ok(STANDARD.encode(&png_data))
}

// Save thumbnail to temp file and return path - for native drag icon
#[command]
fn get_drag_icon_path(app: tauri::AppHandle, path: String, size: Option<u32>) -> String {
    let _ = app; // suppress unused warning
    let max_size = size.unwrap_or(48) as usize;

    // Try to get PNG data from thumbnail extraction first
    let png_data_opt = extract_thumbnail_via_shell(&path, max_size, false);

    // Use thumbnail if available and not empty
    let png_data = match png_data_opt {
        Some(data) if !data.is_empty() => data,
        _ => {
            // No thumbnail available - try to get file type icon from Windows Shell
            let icon_data_opt = get_file_type_icon(&path, max_size);
            match icon_data_opt {
                Some(data) if !data.is_empty() => data,
                _ => {
                    // Last resort: create a minimal 1x1 transparent PNG as fallback
                    // This prevents the "missing required key image" error
                    vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
                         0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
                         0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
                         0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
                         0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
                         0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
                         0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
                         0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
                         0x42, 0x60, 0x82]
                }
            }
        }
    };

    // Get temp directory
    let temp_dir = std::env::temp_dir();
    let icon_filename = format!("goku_drag_icon_{}.png", std::process::id());
    let icon_path = temp_dir.join(icon_filename);

    // Write PNG data to temp file
    if let Ok(mut file) = std::fs::File::create(&icon_path) {
        use std::io::Write;
        let _ = file.write_all(&png_data);
    }

    // Return as string path
    icon_path.to_string_lossy().to_string()
}

// Native drag-and-drop command: starts an OLE DoDragDrop() loop with a
// properly-formatted IDataObject (CF_HDROP + CFSTR_PREFERREDDROPEFFECT).
// This behaves identically to Windows Explorer when dragging files out
// of the app — drops are accepted by Explorer, Cinema 4D, Photoshop, etc.
//
// Args:
//   paths: array of absolute file/folder paths to drag
//   mode:  "copy" | "move" | "link" (preferred drop effect)
//   icon:  optional absolute path to a PNG/JPEG used as drag preview
// Returns:
//   Ok(true)  if the user dropped on a valid target
//   Ok(false) if the drag was cancelled (Esc / drop on invalid target)
//   Err       on failure (no paths, init error, etc.)
#[command]
fn start_native_drag(
    window: tauri::WebviewWindow,
    paths: Vec<String>,
    mode: Option<String>,
    icon: Option<String>,
) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let m = mode.unwrap_or_else(|| "copy".to_string());
        native_drag::start_native_drag(&window, paths, m, icon)
    }

    #[cfg(not(windows))]
    {
        let _ = (window, paths, mode, icon);
        Err("Native drag is only implemented on Windows".to_string())
    }
}

/// Synthesise an Escape keypress so Windows cancels any active OLE drag
/// started by this process. Used by the React layer as a watchdog when it
/// detects the drag session has become stuck (no drop callback fired within
/// a reasonable window).
#[command]
fn cancel_native_drag() -> Result<(), String> {
    #[cfg(windows)]
    {
        native_drag::cancel_native_drag();
        Ok(())
    }

    #[cfg(not(windows))]
    {
        Ok(())
    }
}

// Get file type icon from Windows Shell (extracts from exe/dll shell icons)
fn get_file_type_icon(path: &str, max_size: usize) -> Option<Vec<u8>> {
    use std::thread;
    use std::sync::mpsc;

    let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();

    let _handle = thread::spawn(move || {
        unsafe {
            use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
            use windows::Win32::UI::Shell::{
                SHCreateItemFromParsingName, IShellItemImageFactory,
                SIIGBF_INCACHEONLY, SIIGBF_BIGGERSIZEOK, SIIGBF_RESIZETOFIT,
            };
            use windows::Win32::Foundation::SIZE;
            use windows::Win32::Graphics::Gdi::DeleteObject;

            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

            let factory: IShellItemImageFactory = match SHCreateItemFromParsingName(
                windows::core::PCWSTR(wide_path.as_ptr()),
                None,
            ) {
                Ok(f) => f,
                Err(_) => {
                    CoUninitialize();
                    tx.send(None).ok();
                    return;
                }
            };

            let cx = max_size.min(1024) as i32;
            let size = SIZE { cx, cy: cx };

            // Try INCACHEONLY first — returns instantly if cached by Windows
            let hbitmap = match factory.GetImage(size, SIIGBF_INCACHEONLY) {
                Ok(hb) => hb,
                Err(_) => {
                    // Fallback: triggers extraction if not cached
                    match factory.GetImage(size, SIIGBF_RESIZETOFIT | SIIGBF_BIGGERSIZEOK) {
                        Ok(hb) => hb,
                        Err(_) => {
                            CoUninitialize();
                            tx.send(None).ok();
                            return;
                        }
                    }
                }
            };

            let png_data = hbitmap_to_png(hbitmap);
            let _ = DeleteObject(hbitmap);
            CoUninitialize();

            tx.send(png_data).ok();
        }
    });

    rx.recv().ok().flatten()
}

// Get multiple thumbnails in one call.
// Returns a map of path -> base64 PNG (or null if unavailable).
// Missing thumbnails are queued for background extraction.
#[command]
fn get_thumbnails_batch(app: tauri::AppHandle, paths: Vec<String>, size: Option<u32>) -> std::collections::HashMap<String, Option<String> > {
    let max_size = size.unwrap_or(256) as usize;

    // Log AI/EPS and PUR files specifically for debugging
    for path in &paths {
        let lower = path.to_lowercase();
        if lower.ends_with(".ai") || lower.ends_with(".eps") || lower.ends_with(".pur") {
            println!("[Thumb] AI/EPS/PUR thumbnail request: {} (size={})", path, max_size);
        }
    }

    let mut result: std::collections::HashMap<String, Option<String>> = std::collections::HashMap::new();

    for path in paths {
        let cache_key = format!("{}:{}", path, max_size);
        let path_lower = path.to_lowercase();
        let mut is_special = path_lower.ends_with(".psd") || path_lower.ends_with(".psb")
            || path_lower.ends_with(".ai") || path_lower.ends_with(".eps")
            || path_lower.ends_with(".pur") || path_lower.ends_with(".pureref");
        let is_tif = path_lower.ends_with(".tif") || path_lower.ends_with(".tiff");
        let is_af = path_lower.ends_with(".af");
        if is_tif { is_special = true; }
        if is_af { is_special = true; }

        // Try LRU cache first (fast path — no I/O)
        if let Ok(mut guard) = get_thumb_cache().lock() {
            if let Some(cached) = guard.get(&cache_key) {
                result.insert(path, Some(STANDARD.encode(cached.as_ref())));
                continue;
            }
        }

        // For special formats (PSD/AI/EPS), also try disk cache (persists across restarts)
        if is_special {
            if let Some(disk_data) = load_from_disk_cache(&path, max_size) {
                // Populate LRU cache from disk
                if let Ok(mut guard) = get_thumb_cache().lock() {
                    guard.put(cache_key.clone(), std::borrow::Cow::Owned(disk_data.clone()));
                }
                result.insert(path, Some(STANDARD.encode(&disk_data)));
                continue;
            }
        }

        // Cache miss — return null and queue background extraction
        result.insert(path.clone(), None);

        // Spawn background thread to extract and cache.
        let size_for_thread = max_size;
        let app_clone = app.clone();

        thread::spawn(move || {
            // Acquire ThumbExtractSlot: limits concurrent extraction threads to 4.
            // This prevents memory explosion when loading large folders with many
            // cache-miss files (e.g. 184 files spawning 184 threads = 184x memory).
            let _slot = ThumbExtractSlot::acquire();

            let path_lower = path.to_lowercase();
            let is_psd = path_lower.ends_with(".psd") || path_lower.ends_with(".psb");
            let is_ai = path_lower.ends_with(".ai") || path_lower.ends_with(".eps");
            let is_pur = path_lower.ends_with(".pur") || path_lower.ends_with(".pureref");

            let is_af = path_lower.ends_with(".af");

            // NOTE: AI/EPS files (is_ai=true) call render_ai_with_mupdf() which
            // internally tries to acquire a PythonSlot (max 1 concurrent, 5s timeout).
            // If slots are busy, it returns None quickly so the fallback chain runs.
            // All other files (PSD, PUR, generic) use extract_thumbnail_via_shell()

            // Hybrid thumbnail strategy: Windows Shell cache FIRST (INSTANT if available),
            // then specialized decoder, then Shell as final fallback.
            // Shell thumbnail extraction (SIIGBF_INCACHEONLY) returns cached thumbnails
            // that Explorer already generated — zero decoding cost when available.
            let png_data_opt: Option<Vec<u8>> = if is_psd {
                // PSD: Shell cache → embedded thumbnail (fast, small read) → full decode → Shell fallback
                extract_thumbnail_via_shell(&path, size_for_thread, true)
                    .or_else(|| {
                        std::fs::read(&path)
                            .ok()
                            .and_then(|bytes| fast_psd::extract_psd_thumbnail(&bytes, size_for_thread))
                            .map(|r| r.png_data)
                    })
                    .or_else(|| extract_thumbnail_via_shell(&path, size_for_thread, false))
            } else if is_ai {
                // AI/EPS: Shell cache → PyMuPDF → embedded JPEG → pdftoppm → Shell fallback
                extract_thumbnail_via_shell(&path, size_for_thread, true)
                    .or_else(|| render_ai_with_mupdf(&path, size_for_thread))
                    .or_else(|| {
                        std::fs::read(&path)
                            .ok()
                            .and_then(|bytes| extract_embedded_jpeg(&bytes, size_for_thread))
                    })
                    .or_else(|| {
                        if size_for_thread <= 256 {
                            render_ai_with_pdftoppm(&path, size_for_thread)
                        } else {
                            None
                        }
                    })
                    .or_else(|| extract_thumbnail_via_shell(&path, size_for_thread, false))
            } else if is_af {
                // Affinity .af: Shell cache (Affinity Photo 2 caches thumbnails) → Shell fallback
                extract_thumbnail_via_shell(&path, size_for_thread, true)
                    .or_else(|| extract_thumbnail_via_shell(&path, size_for_thread, false))
            } else if is_tif {
                // TIFF: ffmpeg (handles all variants: grayscale, 16-bit, CMYK, LAB) → Shell cache → Shell fallback
                render_tif_with_ffmpeg(&path, size_for_thread)
                    .or_else(|| extract_thumbnail_via_shell(&path, size_for_thread, true))
                    .or_else(|| extract_thumbnail_via_shell(&path, size_for_thread, false))
            } else {
                // Everything else (JPEG, PNG, WebP, etc.): Shell cache FIRST
                extract_thumbnail_via_shell(&path, size_for_thread, true)
            };

            if let Some(png_data) = png_data_opt {
                let cache_key = format!("{}:{}", path, size_for_thread);
                if let Ok(mut guard) = get_thumb_cache().lock() {
                    guard.put(cache_key, std::borrow::Cow::Owned(png_data.clone()));
                }
                // Persist to disk cache for special formats (survives app restart)
                if is_special {
                    save_to_disk_cache(&path, size_for_thread, &png_data);
                }
                let _ = app_clone.emit("thumbnail-ready", &path);
            }

            // For special formats (PSD/AI/EPS), deep decode is NO LONGER auto-triggered on folder load.
            // Instead, decoding is deferred to on-click so large PSD/PSB folders don't crash the app.
            // User must click on a PSD/PSB file to trigger its thumbnail decode + cache.
            // if is_special && size_for_thread <= 256 {
            //     let path_for_deep = path.clone();
            //     let app_for_deep = app_clone.clone();
            //     thread::spawn(move || {
            //         let _slot = ThumbExtractSlot::acquire();
            //         let deep_size = 1024usize;
            //         let deep_key = format!("{}:{}", path_for_deep, deep_size);
            //         // Skip if already in LRU cache
            //         if let Ok(g) = get_thumb_cache().lock() {
            //             if g.contains(&deep_key) {
            //                 return;
            //             }
            //         }
            //         // Skip if already on disk
            //         if load_from_disk_cache(&path_for_deep, deep_size).is_some() {
            //             return;
            //         }
            //         let deep_png: Option<Vec<u8>> = if is_psd {
            //             std::fs::read(&path_for_deep)
            //                 .ok()
            //                 .and_then(|bytes| fast_psd::extract_psd_thumbnail(&bytes, deep_size))
            //                 .map(|r| r.png_data)
            //         } else if is_ai {
            //             render_ai_with_mupdf(&path_for_deep, deep_size)
            //                 .or_else(|| {
            //                     std::fs::read(&path_for_deep)
            //                         .ok()
            //                         .and_then(|bytes| extract_embedded_jpeg(&bytes, deep_size))
            //                 })
            //         } else {
            //             None
            //         };
            //         if let Some(png) = deep_png {
            //             // Save deep preview cache
            //             if let Ok(mut g) = get_thumb_cache().lock() {
            //                 g.put(deep_key, std::borrow::Cow::Owned(png.clone()));
            //             }
            //             save_to_disk_cache(&path_for_deep, deep_size, &png);
            //             // Resize to 256 and save as thumbnail icon cache
            //             save_as_thumbnail_cache(&app_for_deep, &path_for_deep, &png);
            //             println!("[deep-decode] updated thumbnail for: {}", path_for_deep);
            //         }
            //     });
            // }
        });
    }

    result
}

// ── Thumbnail cache invalidation ──────────────────────────────────────────
//
// Called by the transfer engine after a Replace operation overwrites an
// existing file. Clears the matching entries from the in-process LRU
// thumbnail cache so the next thumbnail request re-extracts from the new
// file instead of serving stale cached PNG bytes.
//
// We also emit a "thumbnail-cleared" event so the frontend can drop
// its own per-path thumbnail state for the affected paths.
// ────────────────────────────────────────────────────────────────────────

// Clear the transcode cache directory on demand (e.g. when the frontend
// detects it should free up disk space, or before re-opening a video to
// force a fresh transcode).
#[command]
fn clear_transcode_cache() -> Result<usize, String> {
    let cache_dir = std::env::temp_dir().join(TRANSCODE_CACHE_DIR);
    if !cache_dir.exists() {
        return Ok(0);
    }

    let mut cleared = 0usize;
    let entries = match std::fs::read_dir(&cache_dir) {
        Ok(e) => e,
        Err(err) => return Err(err.to_string()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if std::fs::remove_file(&path).is_ok() {
                cleared += 1;
            }
        } else if path.is_dir() {
            if std::fs::remove_dir_all(&path).is_ok() {
                cleared += 1;
            }
        }
    }
    println!("[GK] clear_transcode_cache: removed {} entries", cleared);
    Ok(cleared)
}

#[tauri::command]
fn clear_thumb_cache() -> Result<serde_json::Value, String> {
    let dir = match get_disk_thumb_dir() {
        Some(d) => d,
        None => return Err("Thumb cache directory not initialized".to_string()),
    };

    if !dir.exists() {
        return Ok(serde_json::json!({
            "success": true,
            "deleted_count": 0
        }));
    }

    let mut deleted_count = 0usize;
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(err) => return Err(err.to_string()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if std::fs::remove_file(&path).is_ok() {
                deleted_count += 1;
            }
        }
    }
    println!("[GK] clear_thumb_cache: removed {} files", deleted_count);
    Ok(serde_json::json!({
        "success": true,
        "deleted_count": deleted_count
    }))
}

#[command]
fn clear_thumbnails(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    let mut guard = get_thumb_cache().lock().map_err(|e| e.to_string())?;
    let sizes = [64u32, 128, 256, 512, 1024];
    let mut cleared_count = 0usize;

    for path in &paths {
        for size in &sizes {
            let key = format!("{}:{}", path, size);
            if guard.pop(&key).is_some() {
                cleared_count += 1;
            }
        }
    }

    drop(guard);

    // Notify frontend to drop its thumbnail state for these paths.
    #[derive(Debug, serde::Serialize, Clone)]
    struct FileReplacedEvent {
        path: String,
        mtime_ms: i64,
        size: u64,
    }
    for path in &paths {
        let (mtime_ms, size) = std::fs::metadata(path)
            .map(|m| {
                let mt = m.modified().ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                (mt, m.len())
            })
            .unwrap_or((0, 0));
        let fp = FileReplacedEvent { path: path.clone(), mtime_ms, size };
        let _ = app.emit("thumbnail-cleared", &fp);
    }

    if cleared_count > 0 {
        println!(
            "[Thumb] Cleared {} cache entries for {} file(s)",
            cleared_count,
            paths.len()
        );
    }

    Ok(())
}

// ============================================================
// Multi-Select Stats Command
// ============================================================

#[derive(Debug, Serialize)]
pub struct MultiSelectStats {
    pub folder_count: usize,
    pub file_count: usize,
    pub total_size: u64,
}

#[command]
fn get_multi_select_stats(paths: Vec<String>) -> Result<MultiSelectStats, String> {
    let mut folder_count = 0usize;
    let mut file_count = 0usize;
    let mut total_size = 0u64;

    for path in &paths {
        let p = Path::new(path);
        if !p.exists() {
            continue;
        }

        if p.is_dir() {
            folder_count += 1;
            // Only count immediate children for performance (no deep walk)
            if let Ok(entries) = fs::read_dir(p) {
                for entry in entries.flatten() {
                    if let Ok(meta) = entry.metadata() {
                        if meta.is_file() {
                            file_count += 1;
                            total_size += meta.len();
                        }
                    }
                }
            }
        } else if p.is_file() {
            file_count += 1;
            if let Ok(meta) = p.metadata() {
                total_size += meta.len();
            }
        }
    }

    Ok(MultiSelectStats {
        folder_count,
        file_count,
        total_size,
    })
}

// ============================================================
// WinRAR Detection and Integration
// ============================================================

#[derive(Debug, serde::Serialize)]
pub struct WinRarInfo {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[tauri::command]
fn detect_winrar() -> Result<WinRarInfo, String> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        // Check registry for WinRAR shell extension
        let hkcr = RegKey::predef(HKEY_CURRENT_USER);

        // Method 1: Check if WinRAR shell extension is registered
        // Look for the shell extension handler CLSID
        let clsid_paths = [
            r"Software\Classes\WinRAR",
            r"Software\Classes\WinRAR.ZIP",
            r"Software\Microsoft\Windows\CurrentVersion\Shell Extensions\Approved",
        ];

        let mut winrar_path: Option<String> = None;

        // Try to find WinRAR path from registry
        // Check both HKCU and HKLM
        for hkey_path in &[HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            let base = RegKey::predef(*hkey_path);
            
            // Look for WinRAR in registry
            if let Ok(winrar_key) = base.open_subkey(r"Software\WinRAR") {
                if let Ok(path) = winrar_key.get_value::<String, _>("") {
                    if std::path::Path::new(&path).exists() {
                        winrar_path = Some(path);
                        break;
                    }
                }
                if let Ok(path) = winrar_key.get_value::<String, _>("exe") {
                    if std::path::Path::new(&path).exists() {
                        winrar_path = Some(path);
                        break;
                    }
                }
            }
        }

        // Fallback: Check common installation paths
        if winrar_path.is_none() {
            let common_paths = [
                r"C:\Program Files\WinRAR\WinRAR.exe",
                r"C:\Program Files (x86)\WinRAR\WinRAR.exe",
            ];
            for path in &common_paths {
                if std::path::Path::new(path).exists() {
                    winrar_path = Some(path.to_string());
                    break;
                }
            }
        }

        // Check shell extension registry key to confirm WinRAR is integrated
        let shell_ext_key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Shell Extensions\Approved");
        
        let is_integrated = shell_ext_key
            .map(|key| {
                // WinRAR shell extension CLSID
                key.get_value::<String, _>("{B41DB860-64E4-11D2-9906-E49FADC173CA}").is_ok()
                    || key.get_value::<String, _>("{B41DB860-8EE4-11D2-9906-E49FADC173CA}").is_ok()
            })
            .unwrap_or(false);

        // Also check WinRAR directory exists in Program Files
        let installed = winrar_path.is_some() || is_integrated;

        // Get version if we have the path
        let version = winrar_path.as_ref().and_then(|p| {
            std::process::Command::new(p)
                .arg("-ver")
                .output()
                .ok()
                .and_then(|o| {
                    let s = String::from_utf8_lossy(&o.stdout);
                    if s.is_empty() {
                        None
                    } else {
                        Some(s.trim().to_string())
                    }
                })
        });

        Ok(WinRarInfo {
            installed,
            path: winrar_path,
            version,
        })
    }

    #[cfg(not(windows))]
    {
        Ok(WinRarInfo {
            installed: false,
            path: None,
            version: None,
        })
    }
}

// ============================================================
// Main
// ============================================================

fn main() {
    // Initialize logger
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    println!("[GK File Explorer] Starting...");

    // =================================================================
    // Ensure vcpkg-runtime OpenEXR/Imath/etc DLLs are discoverable so
    // exr_cpp_bridge.dll's own imports (OpenEXR-3_4.dll, Imath-3_2.dll,
    // Iex-3_4.dll, IlmThread-3_4.dll, deflate.dll) resolve at
    // LoadLibrary time on Windows. PATH is per-process and we do this
    // before the bridge attempts to load.
    //
    // (Phase 5 — Rust won't add this side-effect on its own for sibling
    // DLLs under `<vcpkg>/bin`, but the bridge DLL will.)
    //
    // No-op if vcpkg bin is already on PATH (common in dev shells).
    #[cfg(windows)]
    {
        let vcpkg_bin = std::env::var("VCPKG_INSTALLED_DIR")
            .map(|v| format!("{}/bin", v.trim_end_matches('/').trim_end_matches('\\')))
            .unwrap_or_else(|_| "C:/vcpkg/installed/x64-windows/bin".to_string());
        if std::path::Path::new(&vcpkg_bin).is_dir() {
            let sep = if cfg!(windows) { ";" } else { ":" };
            let cur = std::env::var("PATH").unwrap_or_default();
            if !cur.split(sep).any(|p| p.eq_ignore_ascii_case(&vcpkg_bin)) {
                std::env::set_var("PATH", format!("{}{}{}", vcpkg_bin, sep, cur));
            }
        }
    }

    // =================================================================
    // Initialize OpenEXR C++ bridge (Phase 5 / V2 plan).
    // =================================================================
    //
    // Tries to load exr_cpp_bridge.dll (built by the build.rs script in
    // Phase 2) and enable its internal thread pool. If the DLL is not
    // available (clean checkout, build issue), we fall back to the
    // existing OpenEXRCore low-level decode path — no error, no UI
    // disruption.
    //
    // The DLL only needs to be loaded once; subsequent calls are a
    // cheap pointer-load from a OnceLock.
    {
        use std::sync::atomic::{AtomicI32, Ordering};
        static PHYS_CORES: AtomicI32 = AtomicI32::new(0);
        let cores = openexr_ffi::exr_cpp_physical_core_count_via_sysinfo();
        PHYS_CORES.store(cores.max(1), Ordering::Relaxed);

        match openexr_ffi::init_openexr_thread_pool(PHYS_CORES.load(Ordering::Relaxed)) {
            Some(actual) => println!(
                "[GK File Explorer] OpenEXR C++ bridge active: {} worker thread(s)",
                actual
            ),
            None => println!(
                "[GK File Explorer] OpenEXR C++ bridge not loaded (fallback to OpenEXRCore low-level)."
            ),
        }

        // 2026-07-13: Share thread count with OpenEXRCore FFI parallel decode.
        // Without this, the low-level path uses available_parallelism() which
        // may differ from the physical core count used for the C++ thread pool.
        openexr_ffi::set_openexr_thread_count(PHYS_CORES.load(Ordering::Relaxed));
    }

    // CLI debug hook: run a one-shot FFI decode and exit, used for
    // diagnosing FFI struct layout issues without spinning up the GUI.
    // Trigger via:
    //   `goku-file-explorer.exe --test-exr-ffi <path>`
    //   `goku-file-explorer.exe --test-exr-ffi <path> --layer Beauty`
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--test-exr-ffi") {
        if let Some(idx) = args.iter().position(|a| a == "--test-exr-ffi") {
            if let Some(path) = args.get(idx + 1) {
                let p = std::path::PathBuf::from(path);
                // Optional `--layer <name>` arg drives the layer_filter
                // passed into extract_exr_rgba_raw — used to exercise the
                // C++ subset path that Phase 4B added.
                let layer_filter: Option<String> = if let Some(lidx) =
                    args.iter().position(|a| a == "--layer")
                {
                    args.get(lidx + 1).cloned()
                } else {
                    None
                };
                let lf_str = layer_filter.as_deref();
                println!("[TEST-FFI] Running FFI decode test on: {} (layer={:?})",
                    path, lf_str);
                match openexr_core::extract_exr_rgba_raw(&p, 0, lf_str) {
                    Some(r) => {
                        println!("[TEST-FFI] OK: {}x{}, dr={:.2}, {} channels",
                            r.width, r.height, r.dynamic_range, r.channels.len());
                        let w = r.width as usize;
                        let h = r.height as usize;
                        let total = r.rgba.len();
                        println!("[TEST-FFI] first 16 RGBA8 bytes: {:?}",
                            &r.rgba[..16.min(total)]);
                        if let Some(ref f32) = r.rgba_f32 {
                            println!("[TEST-FFI] first 4 f32 RGBA: {:?}",
                                &f32[..4.min(f32.len())]);
                        }
                        // Sample at multiple positions to detect flip / stride bugs
                        let sample_positions: Vec<(&str, usize)> = vec![
                            ("top-left     ", 0usize),
                            ("top-mid      ", (w / 2) * 4),
                            ("top-right    ", (w - 1) * 4),
                            ("mid-left     ", (h / 2) * w * 4),
                            ("center       ", ((h / 2) * w + (w / 2)) * 4),
                            ("mid-right    ", ((h / 2) * w + (w - 1)) * 4),
                            ("bot-left     ", (h - 1) * w * 4),
                            ("bot-mid      ", ((h - 1) * w + (w / 2)) * 4),
                            ("bot-right    ", ((h - 1) * w + (w - 1)) * 4),
                            ("mid row+1    ", ((h / 2 + 1) * w + (w / 2)) * 4),
                            ("mid row-1    ", ((h / 2 - 1) * w + (w / 2)) * 4),
                        ];
                        for (name, off) in sample_positions.iter() {
                            if *off + 4 <= total {
                                println!("[TEST-FFI] sample {} off={:>8}: RGBA8=[{}, {}, {}, {}]",
                                    name, off,
                                    r.rgba[*off], r.rgba[*off + 1], r.rgba[*off + 2], r.rgba[*off + 3]);
                            }
                        }
                    }
                    None => println!("[TEST-FFI] FAIL: returned None"),
                }
                return;
            }
        }
        eprintln!("Usage: goku-file-explorer.exe --test-exr-ffi <path-to-exr> [--layer <name>]");
        std::process::exit(1);
    }

    // Cleanup stale faststart temp files from previous sessions
    cleanup_faststart_cache();

    // Start HTTP server in background thread
    start_http_server();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        // Prevent default plugin temporarily disabled to test drag crash
        // .plugin(
        //     tauri_plugin_prevent_default::Builder::new()
        //         // `.with_flags(...)` is critical: an empty `Builder::new()`
        //         // defaults to `Flags::all()` which disables every browser
        //         // shortcut including Ctrl+R / F5 / Ctrl+F / F3 / DevTools,
        //         // so we whitelist only what we actually want to suppress.
        //         // Here we keep the context menu blocked (via the Windows
        //         // platform option below) but unblock keyboard reload.
        //         .with_flags(tauri_plugin_prevent_default::Flags::empty())
        //         .platform(
        //             tauri_plugin_prevent_default::PlatformOptions::new()
        //                 // Disable the WebView2 default context menu
        //                 // (Back / Forward / Refresh / Save as / Print /
        //                 // More tools / Send tab to your devices / Inspect).
        //                 // This is a native webview setting — JS `preventDefault`
        //                 // cannot stop it.
        //                 .default_context_menus(false),
        //         )
        //         .build(),
        // )
        .invoke_handler(tauri::generate_handler![
            read_directory,
            read_directory_recursive,
            get_file_fingerprint,
            read_text_file,
            get_text_preview,
            read_binary_file,
            read_file_as_base64,
            open_external_url,
            read_file_as_data_url,
            write_text_file,
            delete_item,
            restore_from_recycle_bin,
            list_recycle_bin_entries,
            restore_recycle_bin_entries,
            create_directory,
            rename_item,
            copy_file,
            copy_item,
            import_files,
            move_files,
            compress_to_zip,
            extract_zip,
            list_rar_entries,
            list_zip_entries,
            get_disk_space,
            search_files,
            path_exists,
            open_path_with_default_app,
            open_path_with_application,
            open_path_with_handler,
            show_open_with_dialog,
            get_open_with_association,
            get_open_with_candidates,
            debug_dump_open_with,
            set_open_with_association,
            clear_open_with_association,
            get_home_dir,
            get_drives,
            get_drive_infos,
            set_volume_label,
            open_in_terminal,
            get_system_accent_color,
            get_system_double_click_speed,
            get_system_memory_info,
            get_special_folders,
            resolve_address_path,
            get_file_metadata,
            get_open_with_app_icon,
            get_open_with_icons_batch,
            get_open_with_icons_stream,
            get_http_server_url,
            decode_psd,
            decode_psd_on_demand,
            decode_ai_on_demand,
            decode_ai,
            decode_c4d,
            decode_pureref,
            decode_epub,
            decode_stl,
            decode_exr,
            decode_exr_rgba,
            decode_exr_f32,
            decode_exr_f16,
            exr_passthrough::decode_exr_u8_rgba,
            exr_batch::decode_exr_batch_u8,
            get_ocio_lut,
            get_ocio_lut_asset_url,
            get_ocio_lut_metadata,
            list_ocio_modes,
            list_ocio_groups,
            bake_ocio_lut_from_config,
            list_ocio_config,
            preload_exr_sequence,
            get_exr_metadata,
            decode_exr_channel,
            decode_exr_crypto_layer,
            decode_exr_crypto_channel,
            // Phase 5B: expose EXR cache LRU diagnostics to the frontend.
            get_exr_cache_stats,
            reset_exr_cache_stats,
            get_file_icon_base64,
            get_drag_icon_path,
            start_native_drag,
            cancel_native_drag,
            get_thumbnails_batch,
            get_multi_select_stats,
            get_windows_quick_access,
            pin_to_quick_access,
            unpin_from_quick_access,
            is_in_quick_access,
            pin_to_start_menu,
            unpin_from_start_menu,
            shell_extensions::list_shell_extensions,
            shell_extensions::list_shell_extensions_for_target,
            shell_extensions::execute_shell_extension,
            shell_extensions::get_verb_icon,
            get_folder_icon,
            get_folder_icons_batch,
            get_special_folder_icon,
            open_file_properties,
            get_folder_size,
            clear_thumbnails,
            clear_transcode_cache,
            clear_thumb_cache,
            // Transfer engine (Phase 0 foundation)
            transfer::start_transfer,
            transfer::pause_transfer,
            transfer::resume_transfer,
            transfer::cancel_transfer,
            transfer::resolve_conflict,
            transfer::list_transfers,
            transfer::dismiss_transfer,
            // EWA: only register_ewa_file is used (binary parsing is now in JS)
            ewa_decoder::register_ewa_file,
            ewa_decoder::export_ewa_to_ply,
            skp_preview::parse_skp_file,
            // WinRAR integration
            detect_winrar,
        ])
        .setup(|app| {
            // Attach the global transfer state to the app handle so commands
            // can access it via `tauri::State<TransferState>`.
            transfer::install(&app.handle());

            // Initialize mouse hook for X1/X2 side buttons
            init_mouse_hook(app.handle().clone());

            // ── Transfer event listeners ──────────────────────────────────────
            // When the transfer engine overwrites an existing file (Replace),
            // it emits "transfer://file-replaced". We catch that here and
            // invalidate the Rust thumbnail cache for the affected path so
            // the next thumbnail request re-extracts from the new file.
            use tauri::Emitter;
            #[derive(Debug, serde::Deserialize)]
            struct FileReplacedPayload {
                #[serde(rename = "path")]
                path: String,
            }
            #[derive(Debug, serde::Serialize, Clone)]
            struct FileReplacedEvent {
                path: String,
                mtime_ms: i64,
                size: u64,
            }
            let app_handle = app.handle().clone();
            app.listen("transfer://file-replaced", move |event| {
                if let Ok(payload) = serde_json::from_str::<FileReplacedPayload>(event.payload()) {
                    let path = payload.path.clone();
                    // Clear Rust thumbnail cache entry.
                    if let Ok(mut guard) = get_thumb_cache().lock() {
                        let sizes = [64u32, 128, 256, 512, 1024];
                        for size in &sizes {
                            let key = format!("{}:{}", path, *size);
                            guard.pop(&key);
                        }
                    }
                    // Also clear disk cache so it's rebuilt from the new file
                    invalidate_disk_cache(&path);
                    // Compute new file fingerprint (mtime + size) so the frontend
                    // can re-mount preview components when the file content changes.
                    let (mtime_ms, size) = std::fs::metadata(&path)
                        .map(|m| {
                            let mt = m.modified().ok()
                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|d| d.as_millis() as i64)
                                .unwrap_or(0);
                            (mt, m.len())
                        })
                        .unwrap_or((0, 0));
                    let fp = FileReplacedEvent { path: path.clone(), mtime_ms, size };
                    let _ = app_handle.emit("thumbnail-cleared", &fp);
                    println!("[Thumb] Cleared thumbnail cache for replaced file: {} (mtime={} size={})", path, mtime_ms, size);
                }
            });

            // ── Register cleanup handlers ──────────────────────────────────────────
            // We need to run cleanup code when the app exits. Tauri 1.x doesn't
            // have on_exit hooks, so we use a combination of:
            // 1. std::panic::set_hook to catch forced exits (panic / kill)
            // 2. The Drop impl on a guard type for normal exits via RAII

            // Spawn a background thread that waits for process exit and cleans up caches.
            // This handles both normal exit and forced termination.
            std::thread::spawn(|| {
                // On Windows, we can use a CTRL_CLOSE_EVENT handler to run cleanup.
                // For simplicity, we just spawn the cleanup in a separate thread
                // and use a Once lock to ensure it only runs once.
                use std::sync::atomic::{AtomicBool, Ordering};
                static CLEANUP_DONE: AtomicBool = AtomicBool::new(false);

                // Wait for app to finish (this thread blocks until process exit)
                // We detect exit via the parent thread joining or via a shutdown signal.
                // For now, register a panic hook that cleans up on any exit.
            });

            // Clean up caches on any exit (panic, normal, forced)
            std::panic::set_hook(Box::new(|_panic_info| {
                // Cleanup happens via static Drop even on panic
                drop(ProcessCleanupGuard);
            }));

            // Install Windows console handler so cleanup runs when the user
            // closes the window (no Drop runs in that path).
            install_windows_exit_handler();

            // For normal exit: return a guard that drops on scope end
            // The actual cleanup runs via the static CLEANUP_GUARD below
            println!("[GK] Registered cache cleanup handlers");

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            match event {
                tauri::RunEvent::Exit => {
                    println!("[GK] RunEvent::Exit received — cleaning up caches...");
                    cleanup_all_caches();
                }
                tauri::RunEvent::ExitRequested { .. } => {
                    // Last chance to run cleanup before the windows are
                    // destroyed. This fires when the user closes the last
                    // window — the same code path RunEvent::Exit uses on
                    // most platforms. Belt-and-suspenders for the cases
                    // where Exit doesn't fire (e.g. certain tray setups).
                    println!("[GK] RunEvent::ExitRequested — cleaning up caches...");
                    cleanup_all_caches();
                }
                _ => {}
            }
        });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mouse Hook for X1/X2 Side Buttons
// ─────────────────────────────────────────────────────────────────────────────
static MOUSE_HOOK_APP: once_cell::sync::Lazy<std::sync::Mutex<Option<tauri::AppHandle<tauri::Wry>>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

fn init_mouse_hook(app: tauri::AppHandle<tauri::Wry>) {
    *MOUSE_HOOK_APP.lock().unwrap() = Some(app);

    #[cfg(target_os = "windows")]
    {
        std::thread::spawn(|| {
            run_mouse_hook();
        });
    }
}

#[cfg(target_os = "windows")]
fn run_mouse_hook() {
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::Win32::Foundation::LRESULT;

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let data = *(lparam.0 as *const MSLLHOOKSTRUCT);
            let mouse_data = data.mouseData;

            match wparam.0 {
                0x020B => { // WM_XBUTTONDOWN
                    let btn = if (mouse_data >> 16) == 1 { 3 } else { 4 };
                    if let Some(app) = MOUSE_HOOK_APP.lock().unwrap().as_ref() {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.emit("mouse-xbutton", serde_json::json!({ "button": btn }));
                        }
                    }
                }
                0x020C => { // WM_XBUTTONUP
                    let btn = if (mouse_data >> 16) == 1 { 3 } else { 4 };
                    if let Some(app) = MOUSE_HOOK_APP.lock().unwrap().as_ref() {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.emit("mouse-xbutton-up", serde_json::json!({ "button": btn }));
                        }
                    }
                }
                _ => {}
            }
        }
        unsafe { CallNextHookEx(HHOOK::default(), code, wparam, lparam) }
    }

    unsafe {
        let _ = SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), None, 0);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Process Cleanup Guard — RAII cleanup on any process exit
// ─────────────────────────────────────────────────────────────────────────────
struct ProcessCleanupGuard;

impl Drop for ProcessCleanupGuard {
    fn drop(&mut self) {
        println!("[GK] Process exiting — cleaning up caches...");
        cleanup_all_caches();
    }
}

// Static guard — lives for entire process lifetime, drops on exit
static _CLEANUP_GUARD: ProcessCleanupGuard = ProcessCleanupGuard;

fn cleanup_all_caches() {
    let cache_dirs = [
        std::env::temp_dir().join("gk_faststart_cache"),
        std::env::temp_dir().join("gk_transcode_cache"),
    ];

    for cache_dir in &cache_dirs {
        if cache_dir.exists() {
            match fs::remove_dir_all(cache_dir) {
                Ok(_) => println!("[GK] Cleaned cache: {}", cache_dir.display()),
                Err(e) => eprintln!("[GK] Failed to clean cache {}: {}", cache_dir.display(), e),
            }
        }
    }

    // Phase 5B: clean the EXR decode cache as well. It lives under
    // %LOCALAPPDATA%\GokuFileExplorer\exr_decode_cache (see
    // exr_decode_cache::cache_dir) and can grow to ~2 GB for large
    // sequence projects, so dropping it on exit is a meaningful disk
    // reclaim.
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let exr_cache = std::path::PathBuf::from(local_app_data)
            .join("GokuFileExplorer")
            .join("exr_decode_cache");
        if exr_cache.exists() {
            match fs::remove_dir_all(&exr_cache) {
                Ok(_) => println!("[GK] Cleaned EXR decode cache: {}", exr_cache.display()),
                Err(e) => eprintln!("[GK] Failed to clean EXR decode cache {}: {}", exr_cache.display(), e),
            }
        }
    }

    // Phase 5E: drop the in-memory EXR decode LRU so the ~480 MB
    // worst-case working set is released before the process exits.
    exr_decode_cache_lru::clear_all();
    println!("[GK] Cleared in-memory EXR decode LRU cache");
}

/// Phase 5B diagnostics — exposes the EXR decode LRU counters
/// (hits, misses, puts, current entries / bytes, hit-rate) to the
/// frontend so the EXR player UI can show live cache performance.
#[tauri::command]
fn get_exr_cache_stats() -> exr_decode_cache_lru::CacheStats {
    exr_decode_cache_lru::get_stats()
}

/// Phase 5B diagnostics — reset the in-memory EXR decode LRU
/// counters. Useful when the user switches layers so each session's
/// hit rate reflects the current workload.
#[tauri::command]
fn reset_exr_cache_stats() {
    exr_decode_cache_lru::reset_counters();
}

// Install Windows console CTRL handler so we run cleanup on user close.
#[cfg(windows)]
fn install_windows_exit_handler() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static HANDLER_INSTALLED: AtomicBool = AtomicBool::new(false);

    if HANDLER_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }

    // We use the Win32 Console API directly via a raw FFI call so we don't
    // have to fight the `windows` crate's wrapper type differences.
    std::thread::spawn(|| {
        // The handler must have C ABI. Returning non-zero tells Windows we
        // handled the event so it doesn't terminate us immediately.
        unsafe extern "system" fn handler(ctrl_type: u32) -> i32 {
            match ctrl_type {
                0 | 1 | 2 | 5 | 6 => {
                    cleanup_all_caches();
                    1
                }
                _ => 0,
            }
        }

        #[link(name = "kernel32")]
        extern "system" {
            fn SetConsoleCtrlHandler(
                handler_routine: Option<unsafe extern "system" fn(u32) -> i32>,
                add: i32,
            ) -> i32;
        }

        unsafe {
            let _ = SetConsoleCtrlHandler(Some(handler), 1);
        }
    });
}

#[cfg(not(windows))]
fn install_windows_exit_handler() {}
