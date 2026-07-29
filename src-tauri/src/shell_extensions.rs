// Phase 2: enumerate Windows shell context-menu entries via `win-context-menu`
// crate (a thin wrapper around `IContextMenu` / `IExplorerCommand`).
//
// Why a crate instead of raw COM?
//   * Plugin author has already battle-tested `QueryContextMenu` against the
//     dozens of handler edge cases Windows Shell throws at us.
//   * Correct item ordering: the plugin walks `HMENU` top-down the way
//     Explorer itself does, so "Top" / "Bottom" Position values fall into
//     place without us re-implementing the IShellItem + IShellFolder dance.
//   * Win11 modern + Win10 legacy handled in one shot: plugin calls
//     `IContextMenu::QueryContextMenu(CMF_NORMAL | CMF_EXTENDEDVERBS)` which
//     triggers both `IExplorerCommand` and legacy `IContextMenu` handlers.
//
// Scope resolution:
//   * `Files`       → ShellItems::from_path(target).extended(true)
//   * `Directory`   → ShellItems::from_path(target).extended(true) for a folder
//   * `Background`  → ShellItems::folder_background(parent).extended(true)
//   * `Drive`       → ShellItems::from_path(target).extended(true) for "C:\"
//   * `Desktop`     → ShellItems::folder_background(profile\Desktop).extended(true)
//   * `AllFileSystem` → ShellItems::from_path(target).extended(true) (Explorer
//                       does the same — treats the item as both file and folder)

use serde::{Deserialize, Serialize};
use win_context_menu::{
    init_com as wcm_init_com, ContextMenu, MenuItem as WcmMenuItem, ShellItems as WcmShellItems,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ShellScope {
    Files,
    Directory,
    Background,
    Drive,
    Desktop,
    AllFileSystem,
}

/// Re-export of `win_context_menu::MenuItem` so the JS layer can render the
/// raw structure without us stripping submenus.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMenuEntry {
    /// Raw command ID assigned by `IContextMenu::QueryContextMenu`. Not
    /// stable across processes — used only as a tie-breaker when two items
    /// share the same verb string.
    pub id: u32,
    /// Display text with accelerator characters (`&`) stripped.
    pub label: String,
    /// Shell verb string (e.g. `"open"`, `"delete"`, `"properties"`,
    /// `"Found"`, `"7-Zip"`). May be `None` for static entries that don't
    /// expose a verb.
    pub command_string: Option<String>,
    pub is_separator: bool,
    pub is_disabled: bool,
    pub is_checked: bool,
    pub is_default: bool,
    /// Nested submenu (Win11 "Show more options" → "Open with" is a common
    /// case). Empty array means no submenu.
    pub submenu: Vec<ContextMenuEntry>,
}

impl From<WcmMenuItem> for ContextMenuEntry {
    fn from(m: WcmMenuItem) -> Self {
        Self {
            id: m.id,
            label: m.label,
            command_string: m.command_string,
            is_separator: m.is_separator,
            is_disabled: m.is_disabled,
            is_checked: m.is_checked,
            is_default: m.is_default,
            submenu: m.submenu.map(convert_items).unwrap_or_default(),
        }
    }
}

fn convert_items(items: Vec<WcmMenuItem>) -> Vec<ContextMenuEntry> {
    eprintln!("[shell_extensions] convert_items: received {} items", items.len());
    let entries: Vec<ContextMenuEntry> = items.into_iter().map(ContextMenuEntry::from).collect();
    for entry in &entries {
        eprintln!("[shell_extensions]   - verb: {:?}, label: {}", entry.command_string, entry.label);
    }
    entries
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ShellEntriesResponse {
    pub files: Vec<ContextMenuEntry>,
    pub directory: Vec<ContextMenuEntry>,
    pub background: Vec<ContextMenuEntry>,
    pub drive: Vec<ContextMenuEntry>,
    pub desktop: Vec<ContextMenuEntry>,
    pub all_file_system: Vec<ContextMenuEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellExecuteResult {
    pub ok: bool,
    pub error_code: i32,
    pub message: String,
    pub verb: String,
}

const MAX_PATH_LEN: usize = 1024;

fn validate_target(target: &str) -> Result<(), String> {
    if target.is_empty() {
        return Err("empty target path".into());
    }
    if target.len() > MAX_PATH_LEN {
        return Err("target path too long".into());
    }
    let p = std::path::Path::new(target);
    if !p.exists() {
        return Err(format!("target does not exist: {}", target));
    }
    Ok(())
}

/// Initialise COM in STA mode once per process. `init_com` returns a `ComGuard`
/// that keeps the apartment alive until dropped. We deliberately leak the
/// guard via `Box::leak` so subsequent calls don't tear down COM between
/// invocations — Tauri's command threads are short-lived.
fn ensure_com() {
    use std::sync::Once;
    static START: Once = Once::new();
    START.call_once(|| {
        match wcm_init_com() {
            Ok(_guard) => {
                // Intentionally leak: keep COM STA alive for the process lifetime.
                Box::leak(Box::new(_guard));
            }
            Err(e) => {
                eprintln!("[shell_extensions] init_com failed: {}", e);
            }
        }
    });
}

/// Try to convert a UNC path to an extended-length path format that some Windows APIs accept.
/// UNC paths like `\\server\share\file` become `\\?\UNC\server\share\file`
fn unc_to_extended_path(path: &str) -> String {
    if path.starts_with("\\\\") && !path.starts_with("\\\\?\\") {
        format!("\\\\?\\UNC\\{}", &path[2..])
    } else {
        path.to_string()
    }
}

/// Check if path is a UNC network path
fn is_unc_path(path: &str) -> bool {
    path.starts_with("\\\\") && !path.starts_with("\\\\?\\")
}

/// Convert UNC path to extended-length format that COM APIs may handle better
/// UNC: \\server\share\path -> \\?\UNC\server\share\path
fn to_extended_unc_path(path: &str) -> String {
    if path.starts_with("\\\\") && !path.starts_with("\\\\?\\") {
        format!("\\\\?\\{}", path)
    } else {
        path.to_string()
    }
}

/// Try SHParseDisplayName for UNC paths to get PIDL, then convert to ShellItems
/// Note: win_context_menu crate doesn't have from_pidl, so this is a workaround
fn try_get_shell_items_for_unc(unc_path: &str) -> Option<WcmShellItems> {
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;

    // Try both formats
    let paths_to_try = vec![
        unc_path.to_string(),
        to_extended_unc_path(unc_path),
    ];

    for path in paths_to_try {
        if let Some(_pidl) = try_shparse_unc_path(&path) {
            // We got the PIDL, but win_context_menu doesn't support creating ShellItems from PIDL directly
            // So we have to fall back to trying WcmShellItems::from_path
            eprintln!("[shell] SHParseDisplayName succeeded for: {}", path);
        }
    }

    // Fall back to WcmShellItems::from_path - it may work for some UNC paths
    match WcmShellItems::from_path(unc_path) {
        Ok(items) => Some(items),
        Err(e) => {
            eprintln!("[shell] WcmShellItems::from_path failed for UNC: {}", e);
            None
        }
    }
}

/// Try to convert a path (including UNC) to IShellItem using SHParseDisplayName
/// Returns the raw ITEMIDLIST pointer
fn try_shparse_unc_path(path: &str) -> Option<*mut windows::Win32::UI::Shell::Common::ITEMIDLIST> {
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;

    // Convert path to wide string
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

    // Try SHParseDisplayName
    let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
    let result = unsafe {
        windows::Win32::UI::Shell::SHParseDisplayName(
            windows::core::PCWSTR::from_raw(wide.as_ptr()),
            None,
            &mut pidl,
            0,
            None,
        )
    };

    if result.is_ok() && !pidl.is_null() {
        Some(pidl)
    } else {
        None
    }
}

#[tauri::command]
/// `Err(msg)` when the path doesn't resolve or COM fails. Empty list is a
/// legitimate result (no registered verbs for this scope).
fn enumerate_for_path(path: &str, extended: bool) -> Result<Vec<ContextMenuEntry>, String> {
    eprintln!("[shell] enumerate_for_path: {}", path);

    // For UNC paths, try SHParseDisplayName to verify the path is valid
    let items = if is_unc_path(path) {
        eprintln!("[shell] UNC path detected, trying to get shell items...");

        // Try extended format first
        let extended_path = to_extended_unc_path(path);
        eprintln!("[shell] Trying extended format: {}", extended_path);

        // Try to get shell items for UNC path
        if let Some(shell_items) = try_get_shell_items_for_unc(path) {
            shell_items
        } else if let Some(shell_items) = try_get_shell_items_for_unc(&extended_path) {
            shell_items
        } else {
            // Final fallback - try directly (will likely fail but gives us the error message)
            match WcmShellItems::from_path(path) {
                Ok(items) => items,
                Err(e) => {
                    eprintln!("[shell] UNC path not supported by win_context_menu: {}", e);
                    return Err(format!("UNC paths are not supported by the context menu library: {}", e));
                }
            }
        }
    } else {
        // Normal path - use directly
        match WcmShellItems::from_path(path) {
            Ok(items) => items,
            Err(e) => return Err(e.to_string()),
        }
    };

    let mut builder = ContextMenu::new(items).map_err(|e| {
        eprintln!("[shell] ContextMenu::new error: {}", e);
        format!("ContextMenu::new: {}", e)
    })?;
    if extended {
        builder = builder.extended(true);
    }
    let raw = builder.enumerate().map_err(|e| {
        eprintln!("[shell] enumerate error: {}", e);
        format!("enumerate: {}", e)
    })?;
    eprintln!("[shell] enumerate_for_path {} -> {} items", path, raw.len());
    Ok(convert_items(raw))
}

/// Enumerate the background context menu of a folder (right-click on empty
/// space inside the folder).
fn enumerate_for_background(folder: &str) -> Result<Vec<ContextMenuEntry>, String> {
    eprintln!("[shell] enumerate_for_background: {}", folder);

    // For UNC paths, try extended-length format as fallback
    let use_extended = is_unc_path(folder);
    let effective_folder = if use_extended {
        let extended = to_extended_unc_path(folder);
        eprintln!("[shell] UNC background path detected, trying extended format: {}", extended);
        extended
    } else {
        folder.to_string()
    };

    // Try the extended path first, then fall back to original if needed
    let items = match WcmShellItems::folder_background(&effective_folder) {
        Ok(items) => items,
        Err(e) if use_extended && folder != effective_folder => {
            eprintln!("[shell] Extended format failed for background, trying original: {}", e);
            match WcmShellItems::folder_background(folder) {
                Ok(items) => items,
                Err(e2) => {
                    eprintln!("[shell] Original UNC background path also failed: {}", e2);
                    return Err(format!("ShellItems::folder_background({}): {}", folder, e2));
                }
            }
        }
        Err(e) => {
            eprintln!("[shell] folder_background error: {}", e);
            return Err(format!("ShellItems::folder_background({}): {}", folder, e));
        }
    };

    let builder = ContextMenu::new(items)
        .map_err(|e| format!("ContextMenu::new: {}", e))?
        .extended(true);
    let raw = builder.enumerate().map_err(|e| format!("enumerate: {}", e))?;
    Ok(convert_items(raw))
}

#[tauri::command]
pub fn list_shell_extensions(target_extension: Option<String>) -> ShellEntriesResponse {
    ensure_com();
    let _ = target_extension;

    let mut out = ShellEntriesResponse::default();

    // Use a known file as probe for generic enumeration.
    // This provides baseline context menu items.
    let probe = r"C:\Windows\System32\notepad.exe";
    match enumerate_for_path(probe, true) {
        Ok(items) => out.files = items,
        Err(e) => eprintln!("[shell_extensions] files probe failed: {}", e),
    }

    // Directory scope
    let dir_probe = r"C:\Windows\System32";
    if std::path::Path::new(dir_probe).is_dir() {
        match enumerate_for_path(dir_probe, true) {
            Ok(items) => out.directory = items,
            Err(e) => eprintln!("[shell_extensions] directory probe failed: {}", e),
        }
        match enumerate_for_background(dir_probe) {
            Ok(items) => out.background = items,
            Err(e) => eprintln!("[shell_extensions] background probe failed: {}", e),
        }
    }

    out
}

/// Per-path enumeration: builds the response for a single right-click on
/// `target_path`. This is the accurate path — Explorer builds the menu on
/// demand for the exact item under the cursor.
#[tauri::command]
pub fn list_shell_extensions_for_target(target_path: String) -> Result<ShellEntriesResponse, String> {
    ensure_com();
    validate_target(&target_path)?;

    let mut out = ShellEntriesResponse::default();

    let is_dir = std::path::Path::new(&target_path).is_dir();

    if is_dir {
        // Right-click on a folder → item menu (acts on folder itself).
        if let Ok(items) = enumerate_for_path(&target_path, true) {
            out.directory = items;
        }
        // Same path doubles as background scope (right-click empty space).
        if let Ok(items) = enumerate_for_background(&target_path) {
            out.background = items;
        }
    } else {
        // Right-click on a file → file item menu.
        if let Ok(items) = enumerate_for_path(&target_path, true) {
            out.files = items;
        }
        // Use parent dir as a representative "background" preview.
        if let Some(parent) = std::path::Path::new(&target_path).parent() {
            let parent_str = parent.to_string_lossy().to_string();
            if std::path::Path::new(&parent_str).is_dir() {
                if let Ok(items) = enumerate_for_background(&parent_str) {
                    out.background = items;
                }
            }
        }
    }

    Ok(out)
}

#[tauri::command]
pub fn execute_shell_extension(target_path: String, verb: String) -> ShellExecuteResult {
    ensure_com();
    if let Err(msg) = validate_target(&target_path) {
        return ShellExecuteResult {
            ok: false,
            error_code: -1,
            message: msg,
            verb,
        };
    }
    if verb.is_empty() {
        return ShellExecuteResult {
            ok: false,
            error_code: -2,
            message: "empty verb".into(),
            verb,
        };
    }

    let path_to_try = if target_path.starts_with("\\\\") && !target_path.starts_with("\\\\?\\") {
        unc_to_extended_path(&target_path)
    } else {
        target_path.clone()
    };

    let items = match WcmShellItems::from_path(&path_to_try) {
        Ok(i) => i,
        Err(e) => {
            return ShellExecuteResult {
                ok: false,
                error_code: -3,
                message: format!("ShellItems::from_path: {}", e),
                verb,
            };
        }
    };
    let menu = match ContextMenu::new(items) {
        Ok(m) => m,
        Err(e) => {
            return ShellExecuteResult {
                ok: false,
                error_code: -4,
                message: format!("ContextMenu::new: {}", e),
                verb,
            };
        }
    };

    match menu.invoke_verb(&verb) {
        Ok(()) => ShellExecuteResult {
            ok: true,
            error_code: 33, // success sentinel
            message: "launched".into(),
            verb,
        },
        Err(e) => ShellExecuteResult {
            ok: false,
            error_code: -5,
            message: format!("invoke_verb({}) failed: {}", verb, e),
            verb,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_scope_variants() {
        // Smoke test to keep the enum shape stable.
        let _ = ShellScope::Files;
        let _ = ShellScope::Directory;
        let _ = ShellScope::Background;
        let _ = ShellScope::Drive;
        let _ = ShellScope::Desktop;
        let _ = ShellScope::AllFileSystem;
    }
}

// ── Icon extraction ────────────────────────────────────────────────────────
//
// `win-context-menu` returns text metadata only (no icons). For the
// Explorer-style look we want icons next to each menu item.
//
// Strategy (ORDER MATTERS):
//   1. Try registry lookup — searches HKCR for the verb's Icon value.
//      This returns the ACTUAL icon registered by plugins (7-Zip, etc.)
//      rather than our generic shell32/imageres fallbacks.
//   2. Fall back to our static verb → shell32/imageres index table.
//      This covers standard Windows verbs (open, cut, copy, etc.)
//      where registry entries may not have explicit Icon values.

use std::sync::OnceLock;
use std::path::Path;
use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    BITMAPINFO, BITMAPINFOHEADER, DeleteObject, GetDIBits, GetObjectW, BITMAP,
    DIB_RGB_COLORS, BI_RGB, GetDC, ReleaseDC,
};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, LoadLibraryW};
use windows::Win32::UI::Shell::{ExtractIconW, SHDefExtractIconW, SHParseDisplayName, IShellItem};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};
use windows::Win32::Foundation::MAX_PATH as MAX_PATH_WIN32;
use winreg::enums::*;
use winreg::RegKey;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

/// Map of well-known shell verbs to an icon resource. The library is one of:
///   * `"shell32"` — the standard shell system icon set
///   * `"imageres"` — the imaging / hardware resource set
///   * `"shell32.dll"` — same as above, full path allowed
///
/// Indices are stable across Windows 7 / 10 / 11 for these slots.
fn verb_icon_library(verb: &str) -> Option<(&'static str, i32)> {
    match verb {
        "open" => Some(("shell32", 1)),       // folder/document open
        "edit" => Some(("shell32", 16)),
        "cut" => Some(("shell32", 16760)),    // Cut
        "copy" => Some(("shell32", 16761)),   // Copy
        "paste" => Some(("shell32", 16762)),  // Paste
        "delete" => Some(("shell32", 16763)), // Delete
        "rename" => Some(("shell32", 16764)), // Rename
        "properties" => Some(("shell32", 16771)), // Properties
        "print" => Some(("shell32", 130)),
        "runas" => Some(("shell32", 16777)),  // Run as admin
        "explore" => Some(("shell32", 235)),
        "find" => Some(("shell32", 268)),
        "opennew" => Some(("shell32", 3)),
        "link" => Some(("imageres", 24)),     // Create shortcut
        "pintohome" | "pintostartscreen" => Some(("imageres", 5106)),
        "rotate" | "rotate270" => Some(("shell32", 150)),
        "compress" => Some(("imageres", 122)),
        "encrypt" => Some(("shell32", 156)),
        _ => None,
    }
}

/// Convert a single `HICON` to a base64-encoded PNG (32-bit BGRA → RGBA).
///
/// We extract the colour bitmap out of the icon via `GetIconInfo`, copy
/// the pixels via `GetDIBits`, and ship them as a 32-bit RGBA PNG.
fn hicon_to_base64_png(hicon: HICON) -> Option<String> {
    unsafe {
        let mut info = std::mem::zeroed::<ICONINFO>();
        if GetIconInfo(hicon, &mut info).is_err() {
            eprintln!("[verb_icon] hicon_to_base64_png: GetIconInfo failed");
            return None;
        }
        let color_bmp = info.hbmColor;
        if color_bmp.0.is_null() {
            eprintln!("[verb_icon] hicon_to_base64_png: hbmColor is null");
            if !info.hbmMask.0.is_null() { let _ = DeleteObject(info.hbmMask); }
            return None;
        }

        let mut bm = std::mem::zeroed::<BITMAP>();
        let g = GetObjectW(
            color_bmp,
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut _),
        );
        if g == 0 {
            eprintln!("[verb_icon] hicon_to_base64_png: GetObjectW failed");
            if !info.hbmMask.0.is_null() { let _ = DeleteObject(info.hbmMask); }
            let _ = DeleteObject(color_bmp);
            return None;
        }
        let w = bm.bmWidth as i32;
        let h = bm.bmHeight as i32;
        eprintln!("[verb_icon] hicon_to_base64_png: bitmap {}x{}", w, h);
        if w <= 0 || h <= 0 {
            eprintln!("[verb_icon] hicon_to_base64_png: invalid dimensions");
            if !info.hbmMask.0.is_null() { let _ = DeleteObject(info.hbmMask); }
            let _ = DeleteObject(color_bmp);
            return None;
        }

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [std::mem::zeroed(); 1],
        };
        let mut pixels: Vec<u8> = vec![0; (w as usize) * (h as usize) * 4];
        let screen_dc = GetDC(None);
        let copied = GetDIBits(
            screen_dc,
            color_bmp,
            0,
            h as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        let _ = ReleaseDC(None, screen_dc);
        if !info.hbmMask.0.is_null() { let _ = DeleteObject(info.hbmMask); }
        let _ = DeleteObject(color_bmp);
        let _ = DestroyIcon(hicon);

        if copied == 0 {
            eprintln!("[verb_icon] hicon_to_base64_png: GetDIBits returned 0");
            return None;
        }
        // Compute simple hash to check if icons differ
        let mut hash: u32 = 0;
        for (i, &b) in pixels.iter().take(100).enumerate() {
            hash = hash.wrapping_add((b as u32).wrapping_mul(i as u32 + 1));
        }
        eprintln!("[verb_icon] hicon_to_base64_png: success, {} bytes, pixel_hash={:08x}", pixels.len(), hash);
        encode_bgra_to_png(&pixels, w as u32, h as u32)
    }
}

/// Tiny self-contained PNG encoder. We avoid pulling the `image` crate
/// just to ship menu icons. Format: 8-bit RGBA, non-interlaced.
fn encode_bgra_to_png(bgra: &[u8], width: u32, height: u32) -> Option<String> {
    if bgra.is_empty() || width == 0 || height == 0 {
        eprintln!("[verb_icon] encode_bgra_to_png: empty input");
        return None;
    }
    use std::io::Write;

    // Convert BGRA → RGBA and prepend a single-byte filter type per row.
    let row_bytes = width as usize * 4;
    let mut raw = Vec::with_capacity(bgra.len() + height as usize);
    for y in 0..height as usize {
        raw.push(0u8); // None filter
        for x in 0..width as usize {
            let off = y * row_bytes + x * 4;
            raw.push(bgra[off + 2]); // R
            raw.push(bgra[off + 1]); // G
            raw.push(bgra[off + 0]); // B
            raw.push(bgra[off + 3]); // A
        }
    }

    // Compress using flate2
    let mut compressed = Vec::new();
    {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        let mut encoder = ZlibEncoder::new(&mut compressed, Compression::default());
        encoder.write_all(&raw).ok()?;
        encoder.finish().ok()?;
    }
    eprintln!("[verb_icon] encode_bgra_to_png: compressed {} bytes from {} bytes", compressed.len(), raw.len());

    let mut png: Vec<u8> = Vec::new();
    png.extend_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    fn chunk(tag: &[u8; 4], data: &[u8], out: &mut Vec<u8>) {
        let len = data.len() as u32;
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(tag);
        out.extend_from_slice(data);
        let mut crc_input = Vec::with_capacity(4 + data.len());
        crc_input.extend_from_slice(tag);
        crc_input.extend_from_slice(data);
        out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
    }

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.push(8); // bit depth
    ihdr.push(6); // color type: RGBA
    ihdr.push(0); // compression
    ihdr.push(0); // filter
    ihdr.push(0); // interlace
    chunk(b"IHDR", &ihdr, &mut png);
    chunk(b"IDAT", &compressed, &mut png);
    chunk(b"IEND", &[], &mut png);

    eprintln!("[verb_icon] encode_bgra_to_png: output PNG {} bytes", png.len());

    // Use standard base64 crate
    Some(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png))
}

fn crc32(buf: &[u8]) -> u32 {
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for n in 0..256u32 {
            let mut c = n;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB88320 ^ (c >> 1) } else { c >> 1 };
            }
            t[n as usize] = c;
        }
        t
    });
    let mut c: u32 = 0xFFFFFFFF;
    for &b in buf {
        c = table[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFFFFFF
}

// Local base64 encoder (renamed to avoid conflict with external `base64` crate)
mod base64_encoder {
    pub mod write {
        pub struct Base64Encoder<'a, W: std::io::Write> {
            inner: &'a mut W,
        }
        impl<'a, W: std::io::Write> Base64Encoder<'a, W> {
            pub fn new(inner: &'a mut W) -> Self {
                Self { inner }
            }
            pub fn write_all(&mut self, data: &[u8]) -> std::io::Result<()> {
                const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
                let mut i = 0;
                while i + 3 <= data.len() {
                    let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | (data[i + 2] as u32);
                    self.inner.write_all(&[
                        ALPHABET[((n >> 18) & 0x3F) as usize],
                        ALPHABET[((n >> 12) & 0x3F) as usize],
                        ALPHABET[((n >> 6) & 0x3F) as usize],
                        ALPHABET[(n & 0x3F) as usize],
                    ])?;
                    i += 3;
                }
                let rem = data.len() - i;
                if rem == 1 {
                    let n = (data[i] as u32) << 16;
                    self.inner.write_all(&[
                        ALPHABET[((n >> 18) & 0x3F) as usize],
                        ALPHABET[((n >> 12) & 0x3F) as usize],
                        b'=', b'=',
                    ])?;
                } else if rem == 2 {
                    let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
                    self.inner.write_all(&[
                        ALPHABET[((n >> 18) & 0x3F) as usize],
                        ALPHABET[((n >> 12) & 0x3F) as usize],
                        ALPHABET[((n >> 6) & 0x3F) as usize],
                        b'=',
                    ])?;
                }
                Ok(())
            }
            pub fn finish(self) -> std::io::Result<()> {
                Ok(())
            }
        }
    }
}

/// Resolve a verb → base64 PNG data URL, suitable for `<img src=...>`.
///
/// Strategy:
///   1. Try registry lookup — searches HKCR for the verb's Icon value in:
///      - `*\shell\<verb>`  (files)
///      - `Directory\shell\<verb>`  (folders)
///      - `Directory\Background\shell\<verb>`  (background)
///   2. Search SystemFileAssociations for file-type-specific verbs (like "Convert to Adobe PDF")
///   3. Fall back to known plugin executable paths (for COM handlers like 7-Zip)
///   4. Fall back to static verb → shell32/imageres index table.
fn verb_to_icon_b64(verb: &str) -> Option<String> {
    eprintln!("[verb_icon] verb_to_icon_b64({})", verb);
    
    // Strategy 1: Try registry lookup first — this gets real plugin icons
    if let Some(icon_path) = lookup_verb_icon_from_registry(verb) {
        eprintln!("[verb_icon]   registry found: {}", icon_path);
        if let Some(icon) = extract_icon_from_path(&icon_path) {
            eprintln!("[verb_icon] ✓ registry hit: {} → {}", verb, icon_path);
            return Some(icon);
        }
        eprintln!("[verb_icon]   registry hit but extraction failed: {} → {}", verb, icon_path);
    }

    // Strategy 1.5: Search SystemFileAssociations for file-type-specific verbs
    // These are stored in paths like: HKCR\SystemFileAssociations\.pdf\shell\ConvertToAdobePDF
    if let Some(icon_path) = lookup_systemfileassociations_icon(verb) {
        eprintln!("[verb_icon]   SystemFileAssociations found: {}", icon_path);
        if let Some(icon) = extract_icon_from_path(&icon_path) {
            eprintln!("[verb_icon] ✓ SystemFileAssociations hit: {} → {}", verb, icon_path);
            return Some(icon);
        }
    }

    // Strategy 2: Try to find plugin executable paths for known COM-based handlers
    if let Some(plugin_path) = find_plugin_executable(verb) {
        eprintln!("[verb_icon]   plugin path: {}", plugin_path);
        if let Some(icon) = extract_icon_from_path(&plugin_path) {
            eprintln!("[verb_icon] ✓ plugin executable hit: {} → {}", verb, plugin_path);
            return Some(icon);
        }
    }

    // Strategy 3: Look up in Windows CommandStore (built-in shell commands)
    if let Some(icon_path) = lookup_command_store_icon(verb) {
        eprintln!("[verb_icon]   CommandStore path: {}", icon_path);
        if let Some(icon) = extract_icon_from_path(&icon_path) {
            eprintln!("[verb_icon] ✓ CommandStore hit: {} → {}", verb, icon_path);
            return Some(icon);
        }
        eprintln!("[verb_icon]   CommandStore hit but extraction failed: {} → {}", verb, icon_path);
    }

    // Strategy 4: Fall back to static lookup table
    if let Some((lib, idx)) = verb_icon_library(verb) {
        let icon_spec = format!("{},{}", lib, idx);
        eprintln!("[verb_icon]   static table: {}", icon_spec);
        if let Some(icon) = extract_icon_from_path(&icon_spec) {
            eprintln!("[verb_icon] ✓ static table hit: {} → {}", verb, icon_spec);
            return Some(icon);
        }
    }

    eprintln!("[verb_icon] ✗ no icon found for: {}", verb);
    None
}

/// Lookup the Icon value for a shell verb in the Windows registry.
///
/// For COM-based handlers (like 7-Zip), icons are not stored directly in the
/// verb's Icon value. Instead, we need to:
///   1. Look up the verb's command to find the executable path
///   2. Query the executable's icon using IShellItemImageFactory
///
/// Registry paths searched:
///   - `HKEY_CLASSES_ROOT\*\shell\<verb>` (files)
///   - `HKEY_CLASSES_ROOT\Directory\shell\<verb>` (folders)
///   - `HKEY_CLASSES_ROOT\Directory\Background\shell\<verb>` (background)
///
/// Returns an icon path (may include comma-separated index) or the executable path
/// of a COM handler.
fn lookup_verb_icon_from_registry(verb: &str) -> Option<String> {
    let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);

    // Registry paths to search for verb definitions
    let base_paths = [
        r"*\*\shell",
        r"Directory\shell",
        r"Directory\Background\shell",
    ];

    // Try to find the verb in each base path
    for base in &base_paths {
        if let Ok(base_key) = hkcr.open_subkey(base) {
            // Look for the specific verb subkey
            if let Ok(verb_key) = base_key.open_subkey(verb) {
                // Check for Icon value directly
                if let Ok(icon) = verb_key.get_value::<String, _>("Icon") {
                    if !icon.is_empty() {
                        eprintln!("[verb_icon]   found Icon in {}: {}", verb, icon);
                        return Some(icon);
                    }
                }

                // Check for command executable path (for COM handlers)
                if let Ok(command) = verb_key.get_value::<String, _>("") {
                    // Command is typically like: "C:\Program Files\7-Zip\7zFM.exe" "%1"
                    if let Some(exe_path) = extract_exe_from_command(&command) {
                        eprintln!("[verb_icon]   found exe from command: {}", exe_path);
                        return Some(exe_path);
                    }
                }

                // Check MUIVerb which might have different casing
                if let Ok(mui_verb) = verb_key.get_value::<String, _>("MUIVerb") {
                    // If the display name matches the verb, use this handler
                    if mui_verb.to_lowercase() == verb.to_lowercase() {
                        if let Ok(command) = verb_key.get_value::<String, _>("") {
                            if let Some(exe_path) = extract_exe_from_command(&command) {
                                return Some(exe_path);
                            }
                        }
                    }
                }
            }

            // Also search subkeys for case-insensitive match
            for subkey_name in base_key.enum_keys().filter_map(|k| k.ok()) {
                if subkey_name.to_lowercase() == verb.to_lowercase() {
                    if let Ok(verb_key) = base_key.open_subkey(&subkey_name) {
                        if let Ok(icon) = verb_key.get_value::<String, _>("Icon") {
                            if !icon.is_empty() {
                                eprintln!("[verb_icon]   found Icon via subkey match: {}", icon);
                                return Some(icon);
                            }
                        }
                        if let Ok(command) = verb_key.get_value::<String, _>("") {
                            if let Some(exe_path) = extract_exe_from_command(&command) {
                                eprintln!("[verb_icon]   found exe via subkey match: {}", exe_path);
                                return Some(exe_path);
                            }
                        }
                    }
                }
            }
        }
    }

    // Try HKLM as fallback for system-wide installations
    for base in &base_paths {
        if let Ok(base_key) = hklm.open_subkey(base) {
            if let Ok(verb_key) = base_key.open_subkey(verb) {
                if let Ok(icon) = verb_key.get_value::<String, _>("Icon") {
                    if !icon.is_empty() {
                        return Some(icon);
                    }
                }
                if let Ok(command) = verb_key.get_value::<String, _>("") {
                    if let Some(exe_path) = extract_exe_from_command(&command) {
                        return Some(exe_path);
                    }
                }
            }
        }
    }

    None
}

/// Search SystemFileAssociations registry for file-type-specific verb icons.
///
/// Windows stores some verbs (like "Convert to Adobe PDF") not in the generic
/// `*\shell` path but in file-type-specific locations like:
///   - HKCR\SystemFileAssociations\.pdf\shell\<verb>
///   - HKCR\SystemFileAssociations\.docx\shell\<verb>
///   - HKCR\SystemFileAssociations\*\shell\<verb> (for all files)
///
/// We search common file extensions to find verbs that might be registered there.
fn lookup_systemfileassociations_icon(verb: &str) -> Option<String> {
    let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
    
    // Common file extensions that might have context menu verbs
    let extensions = [
        "*",                           // All files
        ".pdf",
        ".doc", ".docx",
        ".xls", ".xlsx",
        ".ppt", ".pptx",
        ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff",
        ".zip", ".rar", ".7z",
        ".txt",
        ".mp3", ".wav", ".mp4", ".avi",
        ".html", ".htm", ".css", ".js",
    ];

    let verb_lower = verb.to_lowercase();

    for ext in &extensions {
        let path = format!(r"SystemFileAssociations\{}\shell", ext);
        if let Ok(shell_key) = hkcr.open_subkey(&path) {
            // Try exact match first
            if let Ok(verb_key) = shell_key.open_subkey(verb) {
                if let Ok(icon) = verb_key.get_value::<String, _>("Icon") {
                    if !icon.is_empty() {
                        eprintln!("[verb_icon]   SystemFileAssociations exact hit: {}\\{}: {}", ext, verb, icon);
                        return Some(icon);
                    }
                }
                if let Ok(command) = verb_key.get_value::<String, _>("") {
                    if let Some(exe) = extract_exe_from_command(&command) {
                        eprintln!("[verb_icon]   SystemFileAssociations exe from command: {}\\{}: {}", ext, verb, exe);
                        return Some(exe);
                    }
                }
            }

            // Try case-insensitive search in subkeys
            for subkey_name in shell_key.enum_keys().filter_map(|k| k.ok()) {
                if subkey_name.to_lowercase() == verb_lower {
                    if let Ok(verb_key) = shell_key.open_subkey(&subkey_name) {
                        if let Ok(icon) = verb_key.get_value::<String, _>("Icon") {
                            if !icon.is_empty() {
                                eprintln!("[verb_icon]   SystemFileAssociations ci match: {}\\{}: {}", ext, subkey_name, icon);
                                return Some(icon);
                            }
                        }
                        if let Ok(command) = verb_key.get_value::<String, _>("") {
                            if let Some(exe) = extract_exe_from_command(&command) {
                                return Some(exe);
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

/// Extract executable path from a command string.
///
/// Handles formats like:
///   - `"C:\Program Files\7-Zip\7zFM.exe" "%1"`
///   - `C:\Windows\System32\notepad.exe "%1"`
///   - `"C:\path\to\app.exe" param1 param2`
fn extract_exe_from_command(command: &str) -> Option<String> {
    let cmd = command.trim().trim_matches('"');

    // The executable path is before any space or before the first parameter
    // Common patterns: "path\to\exe.exe" %1, or path\to\exe.exe %*
    let exe = if let Some(space_idx) = cmd.find(' ') {
        &cmd[..space_idx]
    } else {
        cmd
    };

    // Remove any remaining quotes and validate it looks like an exe
    let exe = exe.trim_matches('"');
    if exe.to_lowercase().ends_with(".exe") || exe.to_lowercase().ends_with(".dll") {
        Some(exe.to_string())
    } else {
        None
    }
}

/// Find executable paths for known COM-based shell extension handlers.
///
/// Some plugins (like 7-Zip) use COM-based context menu handlers that don't
/// store executable paths directly in registry. For these, we try known paths.
fn find_plugin_executable(verb: &str) -> Option<String> {
    let verb_lower: &str = &verb.to_lowercase();

    // 7-Zip verbs
    if verb_lower.starts_with("sevenzip") || verb_lower == "7-zip" || verb_lower.contains("7-zip") {
        let paths: [&str; 2] = [
            r"C:\Program Files\7-Zip\7zFM.exe",
            r"C:\Program Files (x86)\7-Zip\7zFM.exe",
        ];
        for path in paths.iter() {
            if Path::new(path).exists() {
                return Some((*path).to_string());
            }
        }
    }

    // WinRAR verbs (check if .rar extension points to WinRAR)
    if verb_lower.starts_with("winrar") || verb_lower.contains("rar") {
        let paths: [&str; 2] = [
            r"C:\Program Files\WinRAR\WinRAR.exe",
            r"C:\Program Files (x86)\WinRAR\WinRAR.exe",
        ];
        for path in paths.iter() {
            if Path::new(path).exists() {
                return Some((*path).to_string());
            }
        }
    }

    None
}

/// Find icon from Windows CommandStore (built-in shell commands).
///
/// Built-in verbs like "Rotate right", "Copy as path", etc. are stored in:
///   HKLM\Software\Microsoft\Windows\CurrentVersion\Explorer\CommandStore\shell
///
/// These often have Icon values pointing to shell32.dll or imageres.dll.
/// Note: CommandStore verbs often have "Windows." prefix (e.g., "Windows.rotate90")
fn lookup_command_store_icon(verb: &str) -> Option<String> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    let base_path = r"Software\Microsoft\Windows\CurrentVersion\Explorer\CommandStore\shell";

    // Try direct verb first
    if let Some(icon) = try_lookup_command_store(&hklm, base_path, verb) {
        return Some(icon);
    }
    if let Some(icon) = try_lookup_command_store(&hkcu, base_path, verb) {
        return Some(icon);
    }

    // Try with "Windows." prefix (many CommandStore verbs use this prefix)
    let windows_verb = format!("Windows.{}", verb);
    if let Some(icon) = try_lookup_command_store(&hklm, base_path, &windows_verb) {
        return Some(icon);
    }
    if let Some(icon) = try_lookup_command_store(&hkcu, base_path, &windows_verb) {
        return Some(icon);
    }

    None
}

/// Helper to look up a verb in a specific CommandStore path
fn try_lookup_command_store(hkey: &RegKey, base_path: &str, verb: &str) -> Option<String> {
    if let Ok(base_key) = hkey.open_subkey(base_path) {
        // Direct lookup
        if let Ok(verb_key) = base_key.open_subkey(verb) {
            if let Ok(icon) = verb_key.get_value::<String, _>("Icon") {
                if !icon.is_empty() {
                    eprintln!("[verb_icon]   CommandStore direct hit: {} → {}", verb, icon);
                    return Some(icon);
                }
            }
        }

        // Case-insensitive search
        for subkey in base_key.enum_keys().filter_map(|k| k.ok()) {
            if subkey.to_lowercase() == verb.to_lowercase() {
                if let Ok(verb_key) = base_key.open_subkey(&subkey) {
                    if let Ok(icon) = verb_key.get_value::<String, _>("Icon") {
                        if !icon.is_empty() {
                            eprintln!("[verb_icon]   CommandStore case match: {} → {}", verb, icon);
                            return Some(icon);
                        }
                    }
                }
            }
        }
    }
    None
}

/// Extract icon from a path string (may include comma-separated index).
///
/// Path format examples:
///   - `"C:\Program Files\7-Zip\7zFM.exe"`
///   - `"C:\Program Files\7-Zip\7zFM.exe,0"`
///   - `"shell32.dll,16761"`
///
/// Parse icon specification from registry.
///
/// Handles formats:
///   - "path,index" (e.g., "shell32.dll,127")
///   - "@path,-resource_id" (e.g., "@%SystemRoot%\\System32\\shell32.dll,-128")
///   - "path" (defaults to index 0)
///   - Negative indices are resource IDs (converted to MAKEINTRESOURCE format)
fn parse_icon_spec(icon_spec: &str) -> Option<(String, i32)> {
    let icon_spec = icon_spec.trim().trim_matches('"');
    
    // Handle @path,-id format (negative resource ID)
    if icon_spec.starts_with('@') {
        // Format: @path,-resource_id
        if let Some(comma_idx) = icon_spec.find(",-") {
            let path = icon_spec[1..comma_idx].to_string();
            let id_part = &icon_spec[comma_idx + 2..]; // Skip ","
            if let Ok(id) = id_part.parse::<i32>() {
                // Negative ID - keep it negative for resource lookup
                return Some((path, -id.abs()));
            }
        }
    }
    
    // Handle path,index format
    if let Some(comma_idx) = icon_spec.rfind(',') {
        let path_part = &icon_spec[..comma_idx];
        let index_part = &icon_spec[comma_idx + 1..];
        
        // Try to parse as integer
        if let Ok(index) = index_part.parse::<i32>() {
            return Some((path_part.to_string(), index));
        }
    }
    
    // No index specified, default to 0
    Some((icon_spec.to_string(), 0))
}

/// Find the actual DLL file path, checking for .mun files on Windows 10/11.
///
/// On Windows 10+, system icons moved to .mun files:
///   C:\Windows\System32\shell32.dll -> C:\Windows\SystemResources\shell32.dll.mun
fn find_actual_dll_path(path: &str) -> String {
    let path_lower = path.to_lowercase();
    
    // If it's already a full path that exists, use it
    if Path::new(path).exists() {
        return path.to_string();
    }
    
    // If it's a system DLL name (not a full path), try to find it
    let dll_name = if path.contains('\\') || path.contains('/') {
        // It's a partial path
        path.split(|c| c == '\\' || c == '/').last().unwrap_or(path)
    } else {
        path
    };
    
    // Try System32 first
    let system32 = std::env::var("SystemRoot")
        .map(|w| format!("{}\\System32\\{}", w, dll_name))
        .unwrap_or_else(|_| format!("C:\\Windows\\System32\\{}", dll_name));
    
    if Path::new(&system32).exists() {
        // Check if there's a .mun file (Windows 10+)
        let mun_path = std::env::var("SystemRoot")
            .map(|w| format!("{}\\SystemResources\\{}.mun", w, dll_name.trim_end_matches(".dll")))
            .unwrap_or_else(|_| format!("C:\\Windows\\SystemResources\\{}.mun", dll_name.trim_end_matches(".dll")));
        
        if Path::new(&mun_path).exists() {
            eprintln!("[verb_icon]   Using .mun file: {}", mun_path);
            return mun_path;
        }
        
        return system32;
    }
    
    // Try SystemResources directly
    let mun_path = format!("C:\\Windows\\SystemResources\\{}", dll_name.trim_end_matches(".dll"));
    if Path::new(&mun_path).with_extension("mun").exists() {
        return format!("{}.mun", mun_path);
    }
    
    path.to_string()
}

/// Extract icon from path using multiple strategies.
fn extract_icon_from_path(icon_spec: &str) -> Option<String> {
    eprintln!("[verb_icon] extract_icon_from_path({})", icon_spec);
    
    let (path, index) = parse_icon_spec(icon_spec)?;
    eprintln!("[verb_icon]   parsed: path={}, index={}", path, index);
    
    // Expand environment variables in path
    let expanded_path = expand_env_vars(&path);
    eprintln!("[verb_icon]   expanded: {}", expanded_path);
    
    // Find the actual DLL/exe path (handles .mun files)
    let actual_path = find_actual_dll_path(&expanded_path);
    eprintln!("[verb_icon]   actual path: {}", actual_path);
    
    if !Path::new(&actual_path).exists() {
        eprintln!("[verb_icon]   file not found: {}", actual_path);
        return None;
    }
    
    // Try different extraction strategies
    // Strategy 1: SHDefExtractIconW with specific size (48x48 for context menu)
    if let Some(icon) = extract_icon_shdef(&actual_path, index) {
        return Some(icon);
    }
    
    // Strategy 2: LoadLibraryEx + ExtractIconExW for .exe files
    let is_exe = actual_path.to_lowercase().ends_with(".exe");
    if is_exe {
        if let Some(icon) = extract_icon_from_exe(&actual_path) {
            return Some(icon);
        }
    }
    
    // Strategy 3: IShellItemImageFactory (works for files that Shell knows about)
    if let Some(icon) = extract_shell_item_icon(&actual_path) {
        return Some(icon);
    }
    
    eprintln!("[verb_icon]   All extraction strategies failed for: {}", actual_path);
    None
}

/// Expand environment variables in a path string.
fn expand_env_vars(path: &str) -> String {
    let mut result = path.to_string();
    
    // Expand %SystemRoot%
    if let Ok(system_root) = std::env::var("SystemRoot") {
        result = result.replace("%SystemRoot%", &system_root);
    }
    
    // Expand %Windir%
    if let Ok(windir) = std::env::var("WinDir") {
        result = result.replace("%Windir%", &windir);
    }
    
    result
}

/// Extract icon using SHDefExtractIconW - the proper Windows API for icons.
/// Returns icon at 48x48 size for context menu use.
fn extract_icon_shdef(path: &str, index: i32) -> Option<String> {
    use windows::Win32::UI::Shell::SHDefExtractIconW;
    
    let wide_path: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    
    let mut hicon: HICON = HICON::default();
    
    // SHDefExtractIconW can extract at specific sizes
    // LOWORD = large icon size, HIWORD = small icon size
    // For context menu, 48x48 is a good size
    let size = MAKELONG(48, 48) as u32;
    
    let result = unsafe {
        SHDefExtractIconW(
            PCWSTR(wide_path.as_ptr()),
            index,
            0, // flags
            Some(&mut hicon as *mut _),
            None,
            size,
        )
    };
    
    if result.is_ok() && !hicon.0.is_null() {
        let png_result = hicon_to_base64_png(hicon);
        unsafe { let _ = DestroyIcon(hicon); };
        return png_result;
    }
    
    eprintln!("[verb_icon]   SHDefExtractIconW failed: {:?}", result);
    None
}

/// Helper to make a LONG from two WORD values.
fn MAKELONG(low: u16, high: u16) -> u32 {
    (low as u32) | ((high as u32) << 16)
}

/// Extract icon from executable using LoadLibraryEx + ExtractIconW.
fn extract_icon_from_exe(path: &str) -> Option<String> {
    use windows::Win32::System::LibraryLoader::LOAD_LIBRARY_AS_DATAFILE;
    
    let wide_path: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    
    // Try loading as datafile first (for .dll/.mun files)
    let module = unsafe { 
        LoadLibraryW(PCWSTR(wide_path.as_ptr())) 
    };
    
    let module = match module {
        Ok(m) => m,
        Err(_) => return None,
    };
    
    // Try extracting icon at index 0 (usually the primary/largest icon)
    let hicon = unsafe {
        ExtractIconW(module, PCWSTR(wide_path.as_ptr()), 0)
    };
    
    if hicon.0.is_null() {
        return None;
    }
    
    let result = hicon_to_base64_png(hicon);
    unsafe { let _ = DestroyIcon(hicon); };
    result
}

/// Use IShellItemImageFactory to extract icon — returns the best quality icon
/// for executables and DLLs, respecting AppUserModelID overrides.
fn extract_shell_item_icon(path: &str) -> Option<String> {
    use std::thread;
    use std::sync::mpsc;
    use std::time::Duration;

    let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let (tx, rx) = mpsc::channel();

    let _handle = thread::spawn(move || {
        unsafe {
            use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
            use windows::Win32::UI::Shell::{
                SHCreateItemFromParsingName, IShellItemImageFactory,
                SIIGBF_INCACHEONLY, SIIGBF_BIGGERSIZEOK, SIIGBF_RESIZETOFIT,
            };
            use windows::Win32::Foundation::SIZE;
            use windows::Win32::Graphics::Gdi::{
                DeleteObject, GetDC, ReleaseDC, GetObjectW, BITMAP, 
                CreateCompatibleDC, SelectObject, CreateCompatibleBitmap
            };
            use windows::Win32::UI::WindowsAndMessaging::{CreateIconIndirect, ICONINFO};

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

            // Try multiple sizes to find one that works
            let sizes = [256, 48, 32];
            let mut result: Option<String> = None;

            for size_val in sizes {
                let sz = SIZE { cx: size_val, cy: size_val };
                
                // Try INCACHEONLY first
                let hbitmap = factory.GetImage(sz, SIIGBF_INCACHEONLY)
                    .or_else(|_| factory.GetImage(sz, SIIGBF_BIGGERSIZEOK | SIIGBF_RESIZETOFIT));

                if let Ok(hb) = hbitmap {
                    // Try to convert HBITMAP to HICON
                    let mut icon_info = ICONINFO::default();
                    icon_info.fIcon = true.into();
                    icon_info.hbmColor = hb;
                    
                    // Get the bitmap dimensions
                    let mut bm = BITMAP::default();
                    if GetObjectW(hb, std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _)) != 0 {
                        // Create a proper mask bitmap
                        let screen_dc = GetDC(None);
                        icon_info.hbmMask = CreateCompatibleBitmap(screen_dc, bm.bmWidth, bm.bmHeight);
                        ReleaseDC(None, screen_dc);
                        
                        if !icon_info.hbmMask.is_invalid() {
                            let hicon = CreateIconIndirect(&icon_info);
                            
                            if let Ok(hicon_val) = hicon {
                                if !hicon_val.0.is_null() {
                                    let icon_result = hicon_to_base64_png(hicon_val);
                                    let _ = DestroyIcon(hicon_val);
                                    
                                    if icon_result.is_some() {
                                        result = icon_result;
                                        let _ = DeleteObject(hb);
                                        if !icon_info.hbmMask.is_invalid() {
                                            let _ = DeleteObject(icon_info.hbmMask);
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    
                    // Clean up
                    let _ = DeleteObject(hb);
                    if !icon_info.hbmMask.is_invalid() {
                        let _ = DeleteObject(icon_info.hbmMask);
                    }
                }
            }

            CoUninitialize();
            tx.send(result).ok();
        }
    });

    // Wait for result with timeout
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => result,
        _ => None,
    }
}

/// Public tauri command: get the system icon for a verb as base64 PNG.
#[tauri::command]
pub fn get_verb_icon(verb: String) -> String {
    eprintln!("[verb_icon] get_verb_icon({})", verb);
    let result = verb_to_icon_b64(&verb);
    match &result {
        Some(b64) => eprintln!("[verb_icon] get_verb_icon: returning {} chars", b64.len()),
        None => eprintln!("[verb_icon] get_verb_icon: returning empty string"),
    }
    result.unwrap_or_default()
}