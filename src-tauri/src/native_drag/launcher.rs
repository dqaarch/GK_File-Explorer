// native_drag/launcher.rs
// High-level entry point: start_native_drag() / cancel_native_drag()
//
// Uses the `drag` crate which wraps the Win32 OLE drag-and-drop protocol.

use drag::{start_drag, DragItem, DragMode, Image, Options};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    PostThreadMessageW, WM_QUIT,
};
#[cfg(windows)]
use windows::Win32::Foundation::{WPARAM, LPARAM};

/// Single global cancel flag + drag-thread id.
struct SharedDragState {
    cancel_flag: AtomicBool,
    thread_id: AtomicU32,
}

static DRAG_STATE: std::sync::Mutex<SharedDragState> =
    std::sync::Mutex::new(SharedDragState {
        cancel_flag: AtomicBool::new(false),
        thread_id: AtomicU32::new(0),
    });

/// Data needed to start a drag, sent to the drag thread
struct DragParams {
    hwnd: isize,
    paths: Vec<PathBuf>,
    icon_path: Option<PathBuf>,
}

/// Start a native drag operation using the given Tauri window and file paths.
pub fn start_native_drag(
    window: &tauri::WebviewWindow,
    paths: Vec<String>,
    _mode: String,
    icon_path: Option<String>,
) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use raw_window_handle::HasWindowHandle;

        if paths.is_empty() {
            return Err("No paths provided".to_string());
        }

        // Validate window handle is available
        let hwnd = match window.window_handle() {
            Ok(handle) => {
                match handle.as_raw() {
                    raw_window_handle::RawWindowHandle::Win32(h) => h.hwnd.get() as isize,
                    _ => return Err("Only Win32 window handles are supported".to_string()),
                }
            }
            Err(e) => return Err(format!("Failed to get window handle: {:?}", e)),
        };

        if hwnd == 0 {
            return Err("HWND is null".to_string());
        }

        eprintln!("[native_drag] Got HWND: {}", hwnd);

        // Validate and canonicalize paths
        let input_len = paths.len();
        let validated_paths: Vec<String> = paths
            .into_iter()
            .filter(|p| std::path::Path::new(p).exists())
            .map(|p| {
                std::fs::canonicalize(&p)
                    .map(|pb| pb.to_string_lossy().to_string())
                    .unwrap_or_else(|_| p.clone())
            })
            .collect();

        eprintln!(
            "[native_drag] received {} paths, {} valid",
            input_len,
            validated_paths.len()
        );

        if validated_paths.is_empty() {
            return Err("No valid paths found".to_string());
        }

        let path_bufs: Vec<PathBuf> = validated_paths.iter().map(PathBuf::from).collect();
        
        // Build icon - MUST be valid file
        let icon = icon_path
            .as_ref()
            .filter(|s| !s.is_empty() && std::path::Path::new(s).exists())
            .map(|s| Image::File(PathBuf::from(s)))
            .unwrap_or_else(|| {
                Image::File(path_bufs.first().cloned().unwrap_or_default())
            });

        let params = DragParams {
            hwnd,
            paths: path_bufs,
            icon_path: None,
        };

        // Reset shared state
        {
            let state = DRAG_STATE.lock().unwrap();
            state.cancel_flag.store(false, Ordering::SeqCst);
            state.thread_id.store(0, Ordering::SeqCst);
        }

        // Channel for result
        let (tx, rx) = mpsc::channel::<Result<(), String>>();

        // Spawn thread for drag - clone window handle info only
        let _handle = thread::spawn(move || {
            let thread_id = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
            eprintln!("[native_drag] thread started, thread_id={}", thread_id);

            {
                let state = DRAG_STATE.lock().unwrap();
                state.thread_id.store(thread_id, Ordering::SeqCst);
            }

            // Create window wrapper INSIDE the thread
            let wrapper = WinWrapper { hwnd: params.hwnd };
            let item = DragItem::Files(params.paths);

            eprintln!("[native_drag] calling start_drag...");
            
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                start_drag(
                    &wrapper,
                    item,
                    icon,
                    |result, _pos| {
                        eprintln!("[native_drag] drag callback: {:?}", result);
                        sysdragimage_cleanup::close_orphan_drag_images();
                    },
                    Options {
                        mode: DragMode::Copy,
                        skip_animatation_on_cancel_or_failure: true,
                    },
                )
            }));

            match result {
                Ok(Ok(())) => {
                    eprintln!("[native_drag] success");
                    let _ = tx.send(Ok(()));
                }
                Ok(Err(e)) => {
                    eprintln!("[native_drag] drag error: {}", e);
                    let _ = tx.send(Err(format!("Drag failed: {}", e)));
                }
                Err(info) => {
                    let msg = if let Some(s) = info.downcast_ref::<&str>() {
                        s.to_string()
                    } else if let Some(s) = info.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "Unknown panic".to_string()
                    };
                    eprintln!("[native_drag] panic: {}", msg);
                    let _ = tx.send(Err(format!("Panic: {}", msg)));
                }
            }

            sysdragimage_cleanup::close_orphan_drag_images();
            
            {
                let state = DRAG_STATE.lock().unwrap();
                state.thread_id.store(0, Ordering::SeqCst);
            }
        });

        match rx.recv_timeout(Duration::from_secs(300)) {
            Ok(Ok(())) => Ok(true),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("Drag timed out".to_string()),
        }
    }

    #[cfg(not(windows))]
    {
        let _ = (window, paths, _mode, icon_path);
        Err("Not supported")
    }
}

/// Window wrapper that implements HasWindowHandle
#[cfg(windows)]
struct WinWrapper {
    hwnd: isize,
}

#[cfg(windows)]
impl raw_window_handle::HasWindowHandle for WinWrapper {
    fn window_handle(&self) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
        use std::num::NonZero;
        use raw_window_handle::{RawWindowHandle, Win32WindowHandle};
        
        let hwnd_val = NonZero::new(self.hwnd)
            .ok_or(raw_window_handle::HandleError::NotSupported)?;
        
        let mut handle = Win32WindowHandle::new(hwnd_val);
        // The hwnd field is set automatically by Win32WindowHandle::new
        // No need to set display_handle manually
        
        Ok(unsafe { raw_window_handle::WindowHandle::borrow_raw(RawWindowHandle::Win32(handle)) })
    }
}

#[cfg(windows)]
pub fn cancel_native_drag() {
    let state = DRAG_STATE.lock().unwrap();
    state.cancel_flag.store(true, Ordering::SeqCst);
    let tid = state.thread_id.load(Ordering::SeqCst);
    drop(state);

    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        std::thread::sleep(Duration::from_millis(50));
        sysdragimage_cleanup::close_orphan_drag_images();
    }
}

#[cfg(not(windows))]
pub fn cancel_native_drag() {}

#[cfg(windows)]
mod sysdragimage_cleanup {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE,
    };

    unsafe extern "system" fn enum_proc(hwnd: HWND, _lparam: LPARAM) -> BOOL {
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut name = [0u16; 128];
        let len = GetClassNameW(hwnd, &mut name);
        if len > 0 && String::from_utf16_lossy(&name[..len as usize]) == "SysDragImage" {
            let _ = PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0));
        }
        BOOL(1)
    }

    pub fn close_orphan_drag_images() {
        unsafe { let _ = EnumWindows(Some(enum_proc), LPARAM(0)); }
    }
}

#[cfg(not(windows))]
mod sysdragimage_cleanup {
    pub fn close_orphan_drag_images() {}
}
