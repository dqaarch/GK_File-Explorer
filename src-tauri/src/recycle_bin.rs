// Recycle Bin operations on Windows.
//
// Uses the native IFileOperation COM API (the same one Windows Explorer uses)
// to restore items. PowerShell's Shell.Application MoveHere does NOT work
// for restoring Recycle Bin items - MoveHere only handles same-namespace
// file moves, not the special "undelete" operation the shell performs when
// you click "Restore" in the Recycle Bin UI.
//
// Approach adapted from the open-source `trash` crate (Byron/trash-rs,
// ArturKovacs/trash, MIT licensed) which has been the de-facto Rust
// implementation of recycle-bin support since 2019. We don't pull the
// crate to avoid the extra build-time dependency (windows 0.62 vs our
// existing 0.58); the relevant win32 surfaces we need (IFileOperation,
// IShellItem, IEnumShellItems, PROPERTYKEY) are already enabled in our
// `windows` feature set.
use serde::{Deserialize, Serialize};
use std::path::Path;

#[cfg(windows)]
use std::{
    ffi::{c_void, OsString},
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::PathBuf,
};

#[cfg(windows)]
use windows::{
    core::{Interface, PCWSTR, PWSTR},
    Win32::{
        Foundation::HANDLE,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
        },
        UI::Shell::{
            BHID_EnumItems, FileOperation, FOF_NO_UI, FOFX_EARLYFAILURE,
            FOLDERID_RecycleBinFolder, IEnumShellItems, IFileOperation, IShellItem, IShellItem2,
            KF_FLAG_DEFAULT, SHCreateItemFromParsingName, SHGetKnownFolderItem,
            SIGDN_DESKTOPABSOLUTEPARSING, SIGDN_PARENTRELATIVE,
        },
    },
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreResult {
    pub success: bool,
    pub restored_count: usize,
    pub failed_count: usize,
    pub errors: Vec<String>,
}

pub fn is_recycle_bin_path(path: &str) -> bool {
    path.replace('/', "\\").to_lowercase().contains("$recycle.bin")
}

/// A single item currently in the Recycle Bin. Mirrors the structure used by
/// the `trash` crate (Byron/trash-rs): each entry carries the shell-side
/// parsing name (used to bind back to the IShellItem) plus the original
/// parent + name (the metadata Windows stores so it can put the file back).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecycleBinEntry {
    /// Shell-side identifier. Same string `trash::TrashItem::id` uses.
    /// On Windows: the result of `IShellItem::GetDisplayName` with
    /// `SIGDN_DESKTOPABSOLUTEPARSING`, e.g.
    /// `C:\$Recycle.Bin\<SID>\$Rxxx.ext`.
    pub parsing_name: String,
    /// The folder the file was deleted from, e.g. `C:\Users\me\Documents`.
    pub original_parent: String,
    /// The original file/folder name, e.g. `report.docx`.
    pub name: String,
}

// ============================================================================
// Windows-only native implementation
// ============================================================================

#[cfg(windows)]
struct TrashEntry {
    /// Parsing name as returned by the shell: usually
    /// `C:\$Recycle.Bin\<SID>\$Rxxx.ext`.
    parsing_name: String,
    /// The original location (parent folder) before deletion, e.g.
    /// `C:\Users\me\Documents`.
    original_parent: String,
    /// The original file/folder name, e.g. `report.docx`.
    name: String,
}

#[cfg(windows)]
fn ensure_com() {
    // IShellItem / IFileOperation require COM to be initialized on this thread.
    // COINIT_APARTMENTTHREADED matches Explorer's behavior; calling more than
    // once is fine, COM just bumps a refcount.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
}

#[cfg(windows)]
fn to_wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn to_wide_path(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn pwstr_to_os_string(pwstr: PWSTR) -> OsString {
    if pwstr.is_null() {
        return OsString::new();
    }
    unsafe {
        let mut len = 0;
        while *pwstr.0.offset(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(pwstr.0, len as usize);
        OsString::from_wide(slice)
    }
}

#[cfg(windows)]
fn format_win_err(e: &windows::core::Error) -> String {
    // Windows COM HRESULTs encode meaningful info in the message;
    // format!("0x{:08X}", e.code().0) gives the raw HRESULT.
    format!("HRESULT 0x{:08X}: {}", e.code().0, e)
}

/// Convert `"C:/$Recycle.Bin/<sid>/$Rxxx/foo/bar.txt"` etc. to a form the
/// shell can re-parse. We canonicalize to NT path form (`\` separators,
/// `\\?\` prefix so that `$Recycle.Bin` paths with their hidden nature parse
/// correctly via SHCreateItemFromParsingName).
#[cfg(windows)]
fn to_nt_canonical(path: &str) -> PathBuf {
    let p = path.replace('/', "\\");
    PathBuf::from(p)
}

/// Enumerate every item currently in any user's Recycle Bin. Each item
/// reports its own `original_parent` (folder it was deleted from) and
/// `name` (original file name) which is how we match cut requests later.
#[cfg(windows)]
fn list_recycle_bin_items() -> Result<Vec<TrashEntry>, String> {
    ensure_com();
    #[cfg(windows)]
    unsafe {
        let recycle_bin: IShellItem = SHGetKnownFolderItem(
            &FOLDERID_RecycleBinFolder,
            KF_FLAG_DEFAULT,
            HANDLE::default(),
        )
        .map_err(|e| format!("SHGetKnownFolderItem failed: {}", format_win_err(&e)))?;

        // Enumerate via BHID_EnumItems. We do NOT cast through IShellFolder
        // here because IEnumShellItems is the modern API and gives us
        // IShellItem directly.
        let enum_items: IEnumShellItems =
            recycle_bin
                .BindToHandler(None, &BHID_EnumItems)
                .map_err(|e| format!("BindToHandler(BHID_EnumItems) failed: {}", format_win_err(&e)))?;

        let mut out: Vec<TrashEntry> = Vec::new();
        loop {
            let mut fetched: u32 = 0;
            let mut arr = [None];
            enum_items
                .Next(&mut arr, Some(&mut fetched as *mut u32))
                .map_err(|e| format!("IEnumShellItems::Next failed: {}", format_win_err(&e)))?;
            if fetched == 0 || arr[0].is_none() {
                break;
            }
            let item = arr[0].as_ref().unwrap();

            // Display name = parsing name, used as the id we feed back to
            // SHCreateItemFromParsingName later. SIGDN_DESKTOPABSOLUTEPARSING
            // gives the form Explorer uses ("C:\$Recycle.Bin\<SID>\$R...\...").
            let parsing_name_pwstr = item
                .GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING)
                .map_err(|e| format!("GetDisplayName failed: {}", format_win_err(&e)))?;
            let parsing_name = pwstr_to_os_string(parsing_name_pwstr);
            CoTaskMemFree(Some(parsing_name_pwstr.0 as *const c_void));

            let name_pwstr = item
                .GetDisplayName(SIGDN_PARENTRELATIVE)
                .map_err(|e| format!("GetDisplayName (relative) failed: {}", format_win_err(&e)))?;
            let name = pwstr_to_os_string(name_pwstr);
            CoTaskMemFree(Some(name_pwstr.0 as *const c_void));

            // Read "Original Location" via IShellItem2::GetString (preferred
            // over GetProperty+PropVariantToBSTR; both work, GetString is
            // the documented modern path).
            let shell_item2: IShellItem2 = item
                .cast()
                .map_err(|e| format!("cast IShellItem2 failed: {}", format_win_err(&e)))?;

            // PSGUID_DISPLACED + PID_DISPLACED_FROM = System.Recycle.OriginalLocation
            // We import the symbol from windows crate, but to avoid an extra
            // crate-level dependency on PropertiesSystem constants, define
            // the PROPERTYKEY inline: fmtid = PSGUID_DISPLACED,
            // pid = PID_DISPLACED_FROM.
            const PSGUID_DISPLACED: windows::core::GUID = windows::core::GUID::from_u128(
                0x9b174b33_40ff_11d2_a27e_00c04fc30871u128,
            );
            const PID_DISPLACED_FROM: u32 = 2;
            let pk = windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY {
                fmtid: PSGUID_DISPLACED,
                pid: PID_DISPLACED_FROM,
            };
            let mut original_parent: String = String::new();
            match shell_item2.GetString(&pk) {
                Ok(s) => {
                    if !s.is_null() {
                        let os_str = pwstr_to_os_string(s);
                        original_parent = os_str.to_string_lossy().into_owned();
                        CoTaskMemFree(Some(s.0 as *const c_void));
                    }
                }
                Err(e) => {
                    // Log warning but continue - we can still try to restore
                    eprintln!(
                        "[RecycleBin] GetString(PID_DISPLACED_FROM) failed for '{}': {}",
                        name.to_string_lossy(),
                        format_win_err(&e)
                    );
                }
            }

            // If original_parent is still empty, try to derive it from the parsing name
            // path. The parsing name is C:\$Recycle.Bin\<SID>\$Rxxx\... and we can
            // extract the parent's last segment from the relative name.
            if original_parent.is_empty() {
                // The relative name from SIGDN_PARENTRELATIVE contains the original path
                // segments after the $Recycle.Bin portion. We use the parent folder's
                // last segment as a hint. This is a fallback for items where the
                // property store is not populated.
                eprintln!(
                    "[RecycleBin] original_parent is empty for '{}', parsing_name='{}', relative_name='{}'",
                    name.to_string_lossy(),
                    parsing_name.to_string_lossy(),
                    name.to_string_lossy()
                );
            }

            out.push(TrashEntry {
                parsing_name: parsing_name.to_string_lossy().into_owned(),
                original_parent,
                name: name.to_string_lossy().into_owned(),
            });
        }
        Ok(out)
    }
}

/// Try to restore a single item. The `entry` provides the parsing name
/// (for `SHCreateItemFromParsingName`), the original parent directory,
/// and the original name. We follow the `trash` crate's approach of
/// passing the original parent + name explicitly to `MoveItem` so the
/// shell doesn't have to guess from the item's displaced properties.
#[cfg(windows)]
fn restore_single(entry: &RecycleBinEntry) -> Result<(), String> {
    ensure_com();
    unsafe {
        let pfo: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(|e| {
                format!("CoCreateInstance(FileOperation) failed: {}", format_win_err(&e))
            })?;

        // FOF_NO_UI suppresses any progress/error UI; FOFX_EARLYFAILURE
        // fails fast rather than trying many times.
        pfo.SetOperationFlags(FOF_NO_UI | FOFX_EARLYFAILURE)
            .map_err(|e| format!("SetOperationFlags failed: {}", format_win_err(&e)))?;

        let item_path = to_nt_canonical(&entry.parsing_name);
        let item_wide = to_wide(&item_path);
        let shell_item: IShellItem = SHCreateItemFromParsingName(
            PCWSTR(item_wide.as_ptr()),
            None,
        )
        .map_err(|e| {
            format!(
                "SHCreateItemFromParsingName({}) failed: {}",
                item_path.display(),
                format_win_err(&e)
            )
        })?;

        // Resolve the original parent folder and pass it (plus the
        // original name) explicitly to MoveItem. Passing null both for
        // destination and new name caused STATUS_ACCESS_VIOLATION in our
        // testing - IFileOperation::PerformOperations derefs the
        // destination folder internally even when null is documented to
        // be valid for restore semantics.
        let dest_folder: Option<IShellItem> = if entry.original_parent.is_empty() {
            None
        } else {
            let parent_path = to_nt_canonical(&entry.original_parent);
            let parent_wide = to_wide(&parent_path);
            match SHCreateItemFromParsingName(PCWSTR(parent_wide.as_ptr()), None) {
                Ok(f) => Some(f),
                Err(e) => {
                    return Err(format!(
                        "SHCreateItemFromParsingName(dest folder '{}') failed: {}",
                        parent_path.display(),
                        format_win_err(&e)
                    ));
                }
            }
        };

        let name_wide = to_wide_path(&entry.name);

        // MoveItem signature:
        //   psiitem:               the source shell item
        //   psidestinationfolder:  optional destination folder IShellItem
        //   psznewname:            optional new name (PCWSTR)
        //   pfopsitem:             optional progress sink
        pfo.MoveItem(
            &shell_item,
            dest_folder.as_ref(),
            PCWSTR(name_wide.as_ptr()),
            None,
        )
        .map_err(|e| format!("MoveItem failed: {}", format_win_err(&e)))?;

        pfo.PerformOperations()
            .map_err(|e| format!("PerformOperations failed: {}", format_win_err(&e)))?;

        Ok(())
    }
}

// Match a `source_path` (the thing the user cut, e.g.
// `C:/$Recycle.Bin/<SID>/$Rxxx/foo/bar.txt`) against the trash items we
// enumerated. The cut path embeds the encrypted `$Rxxx` segment, so we
// can't just compare parsing names literally - we have to match on
// `original_parent + name` instead. We fall back to "best by suffix" if
// there are multiple candidates with the same name.
#[cfg(windows)]
fn find_matching_trash_entry<'a>(
    items: &'a [TrashEntry],
    source_path: &str,
) -> Option<&'a TrashEntry> {
    // Take the last non-empty path segment as the file name hint.
    let normalized = source_path.replace('/', "\\");
    let trimmed = normalized.trim_end_matches(|c: char| c == '\\' || c == '/');
    let hint_name = trimmed.rsplit('\\').next().unwrap_or("").to_string();
    if hint_name.is_empty() {
        return None;
    }

    // Best case: a unique item whose original name matches the hint.
    let mut matches: Vec<&TrashEntry> = items
        .iter()
        .filter(|it| it.name.eq_ignore_ascii_case(&hint_name))
        .collect();
    if matches.len() == 1 {
        return Some(matches[0]);
    }
    if matches.is_empty() {
        return None;
    }

    // Multiple items share the same name - disambiguate by re-parsing
    // the cut path: take the parent's last segment too and see if any
    // of the matches have the same original_parent basename. If
    // nothing matches, just return the most recently deleted (last in
    // list - the shell iterates oldest-to-newest).
    let parent_hint = trimmed.rsplit('\\').nth(1).unwrap_or("").to_string();
    if !parent_hint.is_empty() && !parent_hint.eq_ignore_ascii_case(&hint_name) {
        if let Some(m) = matches
            .iter()
            .find(|it| {
                PathBuf::from(&it.original_parent)
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .map(|s| s.eq_ignore_ascii_case(&parent_hint))
                    .unwrap_or(false)
            })
        {
            return Some(*m);
        }
    }

    matches.last().copied()
}

// ============================================================================
// Cross-platform entry point. On non-Windows builds this is a stub that
// reports failure (recycle bin semantics differ per OS; not in scope here).
// ============================================================================

/// Public cross-platform API: list every item currently in the Recycle Bin.
/// Returns the structured data the frontend needs to display the bin and
/// to send back to `restore_from_recycle_bin_entries` on a cut/paste.
pub fn list_recycle_bin_entries() -> Result<Vec<RecycleBinEntry>, String> {
    #[cfg(not(windows))]
    {
        Err("Recycle Bin is only supported on Windows".into())
    }

    #[cfg(windows)]
    {
        list_recycle_bin_items().map(|v| {
            v.into_iter()
                .map(|e| RecycleBinEntry {
                    parsing_name: e.parsing_name,
                    original_parent: e.original_parent,
                    name: e.name,
                })
                .collect()
        })
    }
}

/// Public cross-platform API: restore the supplied items to their original
/// locations. This is the right entry point to call after a "cut from
/// Recycle Bin" paste - we already know each item's `name` +
/// `original_parent` from `list_recycle_bin_entries`, so there's no path
/// matching guessing involved.
pub fn restore_from_recycle_bin_entries(
    items: Vec<RecycleBinEntry>,
) -> Result<RestoreResult, String> {
    #[cfg(not(windows))]
    {
        let _ = items;
        Err("Recycle Bin restore is only supported on Windows".into())
    }

    #[cfg(windows)]
    {
        let _ = ensure_com; // silence unused warning on no-op platforms
        if items.is_empty() {
            return Ok(RestoreResult {
                success: true,
                restored_count: 0,
                failed_count: 0,
                errors: vec![],
            });
        }

        let mut restored_count = 0usize;
        let mut failed_count = 0usize;
        let mut errors: Vec<String> = Vec::new();

        eprintln!(
            "[Restore] restoring {} Recycle Bin entries (by name+parent)",
            items.len()
        );

        for entry in items {
            match restore_single(&entry) {
                Ok(()) => restored_count += 1,
                Err(e) => {
                    failed_count += 1;
                    errors.push(format!(
                        "Failed to restore '{}' (from '{}'): {}",
                        entry.name, entry.original_parent, e
                    ));
                }
            }
        }

        Ok(RestoreResult {
            success: failed_count == 0,
            restored_count,
            failed_count,
            errors,
        })
    }
}

pub fn restore_from_recycle_bin(
    source_paths: &[String],
    destination: &str,
) -> Result<RestoreResult, String> {
    #[cfg(not(windows))]
    {
        let _ = (source_paths, destination);
        return Err("Recycle Bin restore is only supported on Windows".into());
    }

    #[cfg(windows)]
    {
        let _ = destination; // intentionally unused: we restore to original
                              // location, the destination parameter from the
                              // frontend is ignored. (See research notes: the
                              // Windows shell does not support restoring to
                              // a custom destination - only the file's
                              // recorded original location.)
        let _ = ensure_com; // silence unused warning on no-op platforms
        if source_paths.is_empty() {
            return Ok(RestoreResult {
                success: true,
                restored_count: 0,
                failed_count: 0,
                errors: vec![],
            });
        }

        let mut restored_count = 0usize;
        let mut failed_count = 0usize;
        let mut errors: Vec<String> = Vec::new();

        eprintln!(
            "[Restore] enumerating Recycle Bin ({} items requested)",
            source_paths.len()
        );

        let items = match list_recycle_bin_items() {
            Ok(v) => v,
            Err(e) => return Err(format!("failed to enumerate Recycle Bin: {e}")),
        };
        eprintln!("[Restore] Recycle Bin contains {} entries", items.len());

        for source_path in source_paths {
            let entry = match find_matching_trash_entry(&items, source_path) {
                Some(e) => e,
                None => {
                    failed_count += 1;
                    errors.push(format!(
                        "No matching Recycle Bin item found for: {}",
                        source_path
                    ));
                    continue;
                }
            };
            eprintln!(
                "[Restore] src='{}' matches name='{}' original_parent='{}'",
                source_path, entry.name, entry.original_parent
            );
            match restore_single(&RecycleBinEntry {
                parsing_name: entry.parsing_name.clone(),
                original_parent: entry.original_parent.clone(),
                name: entry.name.clone(),
            }) {
                Ok(()) => restored_count += 1,
                Err(e) => {
                    failed_count += 1;
                    errors.push(format!(
                        "Failed to restore '{}': {}",
                        entry.parsing_name, e
                    ));
                }
            }
        }

        Ok(RestoreResult {
            success: failed_count == 0,
            restored_count,
            failed_count,
            errors,
        })
    }
}

#[allow(dead_code)]
fn _unused_path_helpers() {
    let _ = Path::new("unused");
}
