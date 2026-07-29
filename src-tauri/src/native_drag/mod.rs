// native_drag/mod.rs
// Native Win32 Drag & Drop — direct Win32 OLE implementation.
//
// We deliberately do NOT use the `drag` crate here. That crate wraps
// `DoDragDrop` with no exposed cancellation hook, so if a drop target
// misbehaves or the user clicks away, the OLE drag session can hang
// forever — leaving the Windows drag preview stuck on screen.
//
// Our implementation:
//  - Builds a minimal `IDataObject` exposing `CF_HDROP` +
//    `CFSTR_PREFERREDDROPEFFECT`.
//  - Builds a minimal `IDropSource` whose `QueryContinueDrag` polls a
//    shared `Arc<AtomicBool>` flag — when React/Rust sets the flag (via
//    `cancel_native_drag`), DoDragDrop returns immediately with
//    `DRAGDROP_S_CANCEL` and the preview tooltip is cleared.
//  - Runs `DoDragDrop` on the calling thread (Tauri commands run on a
//    worker thread, so this does NOT block the UI).

pub mod launcher;

#[cfg(windows)]
pub use launcher::{cancel_native_drag, start_native_drag};
