//! OpenEXRCore FFI Bindings for Rust
//!
//! Provides Rust FFI bindings to OpenEXRCore-3_4.dll for reading EXR files
//! with full support for DWAA/DWAB compression methods.

use std::ffi::{c_char, c_void, CStr};
use std::ptr;

// ============================================================================
// Error Codes (from openexr_errors.h)
// ============================================================================

#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExrResult {
    Success = 0,
    OutOfMemory = 1,
    InvalidArgument = 3,
    FileAccess = 7,
    FileBadHeader = 8,
    CorruptChunk = 55,
    IncompleteChunkTable = 56,
    FeatureNotImplemented = 64,
    Unknown = 65,
}

impl ExrResult {
    pub fn from_c(code: i32) -> Self {
        match code {
            0 => ExrResult::Success,
            1 => ExrResult::OutOfMemory,
            3 => ExrResult::InvalidArgument,
            7 => ExrResult::FileAccess,
            8 => ExrResult::FileBadHeader,
            55 => ExrResult::CorruptChunk,
            56 => ExrResult::IncompleteChunkTable,
            64 => ExrResult::FeatureNotImplemented,
            _ => ExrResult::Unknown,
        }
    }

    pub fn is_ok(&self) -> bool {
        matches!(self, ExrResult::Success)
    }
}

// ============================================================================
// Compression (from openexr_attr.h)
// ============================================================================

#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExrCompression {
    NoCompression = 0,
    Rle = 1,
    Zips = 2,
    Zip = 3,
    Piz = 4,
    Pxr24 = 5,
    B44 = 6,
    B44A = 7,
    Dwaa = 8,
    Dwab = 9,
    Unknown = 99,
}

impl ExrCompression {
    pub fn from_c(code: i32) -> Self {
        match code {
            0 => ExrCompression::NoCompression,
            1 => ExrCompression::Rle,
            2 => ExrCompression::Zips,
            3 => ExrCompression::Zip,
            4 => ExrCompression::Piz,
            5 => ExrCompression::Pxr24,
            6 => ExrCompression::B44,
            7 => ExrCompression::B44A,
            8 => ExrCompression::Dwaa,
            9 => ExrCompression::Dwab,
            _ => ExrCompression::Unknown,
        }
    }
}

// ============================================================================
// Pixel Type (from openexr_attr.h)
// ============================================================================

#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExrPixelType {
    Uint = 0,
    Half = 1,
    Float = 2,
    Unknown = 99,
}

impl ExrPixelType {
    pub fn from_c(code: i32) -> Self {
        match code {
            0 => ExrPixelType::Uint,
            1 => ExrPixelType::Half,
            2 => ExrPixelType::Float,
            _ => ExrPixelType::Unknown,
        }
    }

    pub fn bytes(&self) -> usize {
        match self {
            ExrPixelType::Uint => 4,
            ExrPixelType::Half => 2,
            ExrPixelType::Float => 4,
            ExrPixelType::Unknown => 0,
        }
    }
}

// ============================================================================
// Storage (from openexr_attr.h)
// ============================================================================

#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExrStorage {
    Scanline = 0,
    Tiled = 1,
    Trapixmap = 2,
    TiledTrapixmap = 3,
}

impl ExrStorage {
    pub fn from_c(code: i32) -> Self {
        match code {
            0 => ExrStorage::Scanline,
            1 => ExrStorage::Tiled,
            2 => ExrStorage::Trapixmap,
            3 => ExrStorage::TiledTrapixmap,
            _ => ExrStorage::Scanline,
        }
    }

    pub fn is_deep(&self) -> bool {
        matches!(self, ExrStorage::Trapixmap | ExrStorage::TiledTrapixmap)
    }
}

// ============================================================================
// Line Order (from openexr_attr.h)
// ============================================================================

#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExrLineOrder {
    IncreasingY = 0,
    DecreasingY = 1,
    RandomY = 2,
}

impl ExrLineOrder {
    pub fn from_c(code: i32) -> Self {
        match code {
            0 => ExrLineOrder::IncreasingY,
            1 => ExrLineOrder::DecreasingY,
            2 => ExrLineOrder::RandomY,
            _ => ExrLineOrder::IncreasingY,
        }
    }
}

// ============================================================================
// Basic Types
// ============================================================================

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ExrBox2i {
    pub min_x: i32,
    pub min_y: i32,
    pub max_x: i32,
    pub max_y: i32,
}

impl ExrBox2i {
    pub fn width(&self) -> i32 { self.max_x - self.min_x + 1 }
    pub fn height(&self) -> i32 { self.max_y - self.min_y + 1 }
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ExrV2f {
    pub x: f32,
    pub y: f32,
}

// ============================================================================
// Chunk Info (from openexr_chunkio.h)
// ============================================================================

/// Chunk info — matches C struct `exr_chunk_info_t`.
///
/// **CRITICAL:** The previous version was missing the last two fields
/// (`sample_count_data_offset` and `sample_count_table_size`), making the
/// struct 48 bytes instead of 64. This shifted every subsequent field in
/// `ExrDecodePipeline` (which embeds this struct) by 16 bytes, causing
/// function pointers and buffer pointers to be read from the wrong offsets
/// → access violation when the library called back into Rust.
///
/// Source: openexr_chunkio.h (https://www.sidefx.com/docs/hdk/structexr__chunk__info__t.html)
#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct ExrChunkInfo {
    pub idx: i32,                       // offset 0
    pub start_x: i32,                   // offset 4
    pub start_y: i32,                   // offset 8
    pub height: i32,                    // offset 12
    pub width: i32,                     // offset 16
    pub level_x: u8,                    // offset 20
    pub level_y: u8,                    // offset 21
    pub typ: u8,                        // offset 22
    pub compression: u8,                // offset 23
    pub data_offset: u64,               // offset 24 (8-byte aligned)
    pub pack_size: u64,                 // offset 32
    pub unpack_size: u64,               // offset 40
    pub sample_count_data_offset: u64,  // offset 48 (deep-scanline data offset)
    pub sample_count_table_size: u64,   // offset 56 (deep-scanline table size)
}

// ============================================================================
// Channel Entry (from openexr_attr.h - exr_attr_chlist_entry_t)
// ============================================================================

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ExrChannelEntry {
    pub name_len: i32,
    pub name: *const c_char,
    pub pixel_type: i32,   // exr_pixel_type_t
    pub p_linear: u8,
    pub reserved: [u8; 3],
    pub x_sampling: i32,
    pub y_sampling: i32,
}

impl ExrChannelEntry {
    pub fn name_str(&self) -> Option<&str> {
        if self.name.is_null() {
            None
        } else {
            unsafe { CStr::from_ptr(self.name).to_str().ok() }
        }
    }
}

// Channel list struct - matches C exr_attr_chlist_t
// This is what exr_get_channels returns a pointer to
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ExrAttrChlist {
    pub num_channels: i32,
    pub num_alloced: i32,
    pub entries: *const ExrAttrChlistEntry,
}

// Individual channel entry - matches C exr_attr_chlist_entry_t
// The name is an exr_attr_string_t (length, alloc_size, str)
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ExrAttrChlistEntry {
    pub name_length: i32,
    pub name_alloc_size: i32,
    pub name_str: *const c_char,
    pub pixel_type: i32,   // exr_pixel_type_t
    pub p_linear: u8,
    pub reserved: [u8; 3],
    pub x_sampling: i32,
    pub y_sampling: i32,
}

impl ExrAttrChlistEntry {
    pub fn name(&self) -> Option<&str> {
        if self.name_str.is_null() {
            None
        } else {
            unsafe { CStr::from_ptr(self.name_str).to_str().ok() }
        }
    }
}

// Opaque handle types
#[repr(C)]
pub struct ExrContext(usize);

#[repr(C)]
pub struct ExrChannelList(usize);

// ============================================================================
// Context Initializer (from openexr_context.h - _exr_context_initializer_v3)
// ============================================================================

#[repr(C)]
pub struct ExrContextInitializer {
    pub size: usize,
    pub error_handler_fn: Option<extern "C" fn(*const ExrContext, i32, *const c_char)>,
    pub alloc_fn: Option<extern "C" fn(*mut c_void, usize) -> *mut c_void>,
    pub free_fn: Option<extern "C" fn(*mut c_void, *mut c_void)>,
    pub user_data: *mut c_void,
    pub read_fn: Option<extern "C" fn(*mut c_void, *mut c_void, u64, u64) -> i64>,
    pub size_fn: Option<extern "C" fn(*mut c_void) -> i64>,
    pub write_fn: Option<extern "C" fn(*mut c_void, *const c_void, u64, u64) -> i64>,
    pub destroy_fn: Option<extern "C" fn(*mut c_void)>,
    pub max_image_width: i32,
    pub max_image_height: i32,
    pub max_tile_width: i32,
    pub max_tile_height: i32,
    pub zip_level: i32,
    pub dwa_quality: f32,
    pub flags: i32,
    pub pad: [u8; 4],
}

impl Default for ExrContextInitializer {
    fn default() -> Self {
        Self {
            size: std::mem::size_of::<Self>(),
            error_handler_fn: None,
            alloc_fn: None,
            free_fn: None,
            user_data: ptr::null_mut(),
            read_fn: None,
            size_fn: None,
            write_fn: None,
            destroy_fn: None,
            max_image_width: -2,
            max_image_height: -2,
            max_tile_width: -1,
            max_tile_height: -1,
            zip_level: -1,
            dwa_quality: -1.0,
            flags: 0,
            pad: [0; 4],
        }
    }
}

// ============================================================================
// Part Info (Rust struct)
// ============================================================================

#[derive(Debug, Clone)]
pub struct ExrPartInfo {
    pub name: Option<String>,
    pub storage: ExrStorage,
    pub data_window: ExrBox2i,
    pub display_window: ExrBox2i,
    pub compression: ExrCompression,
    pub line_order: ExrLineOrder,
    pub pixel_aspect_ratio: f32,
    pub screen_window_center: ExrV2f,
    pub screen_window_width: f32,
    pub chunk_count: i32,
    pub scanlines_per_chunk: i32,
    pub channel_count: i32,
}

impl ExrPartInfo {
    pub fn width(&self) -> i32 { self.data_window.width() }
    pub fn height(&self) -> i32 { self.data_window.height() }
    pub fn is_deep(&self) -> bool { self.storage.is_deep() }
}

// ============================================================================
// Decode Pipeline Types (from openexr_decode.h and openexr_coding.h)
// ============================================================================

/// Per-channel decode info. First half is library-populated, second half is caller-populated.
///
/// **Layout MUST match C struct `exr_coding_channel_info_t` exactly.** Source:
///   https://github.com/AcademySoftwareFoundation/openexr/blob/main/src/lib/OpenEXRCore/openexr_coding.h
///
/// CRITICAL: This struct has NO implicit padding between the byte-sized fields.
/// `p_linear` (u8), `bytes_per_element` (i8) and `data_type` (u16) pack tightly
/// into 4 bytes (offset 24-27), followed by `user_bytes_per_element` (i16) +
/// `user_data_type` (u16) packed into 4 bytes (offset 28-31). Adding any explicit
/// padding here shifts `decode_to_ptr` 8 bytes off, which causes an access
/// violation when the C library tries to write pixel data through the wrong
/// pointer (the previous layout had this exact bug — DWAB files crashed
/// because data was written to a junk location).
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ExrCodingChannelInfo {
    // --- Library-populated fields (offsets verified against C header) ---
    pub channel_name: *const c_char,           // offset 0  (8 bytes, 8-byte aligned)
    pub height: i32,                            // offset 8
    pub width: i32,                             // offset 12
    pub x_samples: i32,                         // offset 16
    pub y_samples: i32,                         // offset 20
    pub p_linear: u8,                           // offset 24
    pub bytes_per_element: i8,                  // offset 25
    pub data_type: u16,                         // offset 26 (packed, no padding)
    // --- Caller-populated fields ---
    pub user_bytes_per_element: i16,            // offset 28
    pub user_data_type: u16,                    // offset 30 (packed, no padding)
    pub user_pixel_stride: i32,                 // offset 32
    pub user_line_stride: i32,                  // offset 36
    pub decode_to_ptr: *mut u8,                 // offset 40 (8-byte aligned)
}

impl Default for ExrCodingChannelInfo {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

/// Decode pipeline state — matches C struct `exr_decode_pipeline_t`.
///
/// **CRITICAL — must match C struct exactly.** Source:
///   https://github.com/AcademySoftwareFoundation/openexr/blob/main/src/lib/OpenEXRCore/openexr_decode.h
///
/// The struct ends with `_quick_chan_store[5]` — a small inline array that
/// the library uses as a fast-path buffer for files with ≤ 5 channels
/// (RGBAZ) without going through malloc. Larger channel counts trigger a
/// separate heap allocation. Missing this array would shift the struct
/// layout and break every function pointer the library populates.
///
/// The previous version omitted this field, causing crashes when the
/// library tried to read/write through the wrong offsets.
///
/// Use `#[repr(C)]` so the layout is guaranteed to match the C struct.
/// Field order matters and follows the C declaration exactly.
#[repr(C)]
pub struct ExrDecodePipeline {
    pub pipe_size: usize,                                                    // offset 0
    pub channels: *mut ExrCodingChannelInfo,                                  // offset 8
    pub channel_count: i16,                                                  // offset 16
    pub decode_flags: u16,                                                   // offset 18
    pub part_index: i32,                                                     // offset 20
    pub context: *const ExrContext,                                          // offset 24 (8-byte aligned)
    pub chunk: ExrChunkInfo,                                                 // offset 32 (size = 64)
    pub user_line_begin_skip: i32,                                           // offset 96
    pub user_line_end_ignore: i32,                                           // offset 100
    pub bytes_decompressed: u64,                                             // offset 104 (8-byte aligned)
    pub decoding_user_data: *mut c_void,                                      // offset 112
    pub packed_buffer: *mut c_void,                                          // offset 120
    pub packed_alloc_size: usize,                                            // offset 128
    pub unpacked_buffer: *mut c_void,                                        // offset 136
    pub unpacked_alloc_size: usize,                                          // offset 144
    pub packed_sample_count_table: *mut c_void,                              // offset 152
    pub packed_sample_count_alloc_size: usize,                               // offset 160
    pub sample_count_table: *mut i32,                                        // offset 168 (8-byte aligned)
    pub sample_count_alloc_size: usize,                                      // offset 176
    pub scratch_buffer_1: *mut c_void,                                       // offset 184
    pub scratch_alloc_size_1: usize,                                         // offset 192
    pub scratch_buffer_2: *mut c_void,                                       // offset 200
    pub scratch_alloc_size_2: usize,                                         // offset 208
    pub alloc_fn: *mut c_void,                                               // offset 216 (8-byte aligned)
    pub free_fn: *mut c_void,                                                // offset 224
    pub read_fn: *mut c_void,                                                // offset 232
    pub decompress_fn: *mut c_void,                                          // offset 240
    pub realloc_nonimage_data_fn: *mut c_void,                               // offset 248
    pub unpack_and_convert_fn: *mut c_void,                                  // offset 256
    /// Inline storage for up to 5 channels (RGBAZ) — used by the library
    /// when channel count ≤ 5 to avoid a malloc. MUST be the last field
    /// so the size matches the C struct exactly. Each element is 48 bytes
    /// (the corrected `ExrCodingChannelInfo` layout).
    pub _quick_chan_store: [ExrCodingChannelInfo; 5],                         // offset 264
}

impl Default for ExrDecodePipeline {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

// ============================================================================
// Function Type Aliases (from openexr_context.h)
// ============================================================================

pub type ExrStartReadFn = unsafe extern "C" fn(
    *mut *mut ExrContext,
    *const c_char,
    *const ExrContextInitializer
) -> i32;

pub type ExrFinishFn = unsafe extern "C" fn(*mut *mut ExrContext) -> i32;

// ============================================================================
// Function Type Aliases (from openexr_part.h)
// ============================================================================

pub type ExrGetCountFn = unsafe extern "C" fn(*const ExrContext, *mut i32) -> i32;
pub type ExrGetNameFn = unsafe extern "C" fn(*const ExrContext, i32, *mut *const c_char) -> i32;
pub type ExrGetStorageFn = unsafe extern "C" fn(*const ExrContext, i32, *mut i32) -> i32;
pub type ExrGetDataWindowFn = unsafe extern "C" fn(*const ExrContext, i32, *mut ExrBox2i) -> i32;
pub type ExrGetDisplayWindowFn = unsafe extern "C" fn(*const ExrContext, i32, *mut ExrBox2i) -> i32;
pub type ExrGetCompressionFn = unsafe extern "C" fn(*const ExrContext, i32, *mut i32) -> i32;
pub type ExrGetLineOrderFn = unsafe extern "C" fn(*const ExrContext, i32, *mut i32) -> i32;
pub type ExrGetPixelAspectFn = unsafe extern "C" fn(*const ExrContext, i32, *mut f32) -> i32;
pub type ExrGetScreenWindowCenterFn = unsafe extern "C" fn(*const ExrContext, i32, *mut ExrV2f) -> i32;
pub type ExrGetScreenWindowWidthFn = unsafe extern "C" fn(*const ExrContext, i32, *mut f32) -> i32;
pub type ExrGetChunkCountFn = unsafe extern "C" fn(*const ExrContext, i32, *mut i32) -> i32;
pub type ExrGetScanlinesPerChunkFn = unsafe extern "C" fn(*const ExrContext, i32, *mut i32) -> i32;

/// Get channel list (zero-copy pointer to internal data)
pub type ExrGetChannelsFn = unsafe extern "C" fn(
    *const ExrContext, i32, *mut *const ExrChannelList
) -> i32;

/// Get chunk table (array of file offsets)
pub type ExrGetChunkTableFn = unsafe extern "C" fn(
    *const ExrContext, i32, *mut *mut u64, *mut i32
) -> i32;

// ============================================================================
// Function Type Aliases (from openexr_chunkio.h)
// ============================================================================

/// Get chunk info by scanline y (convenient for scanline files)
pub type ExrReadScanlineChunkInfoFn = unsafe extern "C" fn(
    *const ExrContext, i32, i32, *mut ExrChunkInfo
) -> i32;

/// Read raw packed chunk data (compressed)
pub type ExrReadChunkFn = unsafe extern "C" fn(
    *const ExrContext, i32, *const ExrChunkInfo, *mut u8
) -> i32;

/// Get chunk info for tiled files
pub type ExrReadTiledChunkInfoFn = unsafe extern "C" fn(
    *const ExrContext, i32, i32, i32, u8, u8, *mut ExrChunkInfo
) -> i32;

// ============================================================================
// Function Type Aliases (from openexr_decode.h)
// ============================================================================

pub type ExrDecodingInitializeFn = unsafe extern "C" fn(
    *const ExrContext, i32, *const ExrChunkInfo, *mut ExrDecodePipeline
) -> i32;

pub type ExrDecodingChooseDefaultRoutinesFn = unsafe extern "C" fn(
    *const ExrContext, i32, *mut ExrDecodePipeline
) -> i32;

pub type ExrDecodingUpdateFn = unsafe extern "C" fn(
    *const ExrContext, i32, *const ExrChunkInfo, *mut ExrDecodePipeline
) -> i32;

pub type ExrDecodingRunFn = unsafe extern "C" fn(
    *const ExrContext, i32, *mut ExrDecodePipeline
) -> i32;

pub type ExrDecodingDestroyFn = unsafe extern "C" fn(
    *const ExrContext, *mut ExrDecodePipeline
) -> i32;

// ============================================================================
// C++ Bridge (exr_cpp_bridge.dll) — OpenEXR C++ API with internal thread pool
// ============================================================================
//
// The OpenEXRCore low-level C API (above) does NOT have a thread pool.
// The OpenEXR C++ API does. We use a small DLL wrapper that exposes
// the C++ API through a C-compatible FFI surface. This DLL is loaded
// at runtime via libloading — we keep the entire low-level fallback
// intact for safety.
//
// See: docs/PLAN_EXR_CPP_BRIDGE_V2.md

use libloading::Library;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::OnceLock;

/// Shared thread count used by both the C++ bridge thread pool AND the
/// OpenEXRCore low-level parallel decode paths. Without this, the two
/// code paths could report/use different thread counts (one via
/// `physical_core_count_via_sysinfo`, the other via
/// `std::thread::available_parallelism()`), leading to suboptimal parallelism.
static SHARED_THREAD_COUNT: AtomicI32 = AtomicI32::new(0);

/// Set the shared thread count. Called once at startup from main.rs after
/// the C++ bridge thread pool is initialized.
pub fn set_openexr_thread_count(n: i32) {
    SHARED_THREAD_COUNT.store(n.max(1), Ordering::SeqCst);
}

/// Get the shared thread count. Used by openexr_core.rs parallel decode
/// to ensure both code paths use the same worker count.
pub fn get_openexr_thread_count() -> i32 {
    SHARED_THREAD_COUNT.load(Ordering::SeqCst)
}

/// Loaded handle to exr_cpp_bridge.dll. Kept for the lifetime of the
/// process so the symbols stay valid. Wrapped in Option because the
/// DLL may not be present in all environments.
static EXR_CPP_BRIDGE: OnceLock<Option<Library>> = OnceLock::new();

/// Path to the DLL on disk. Used to print diagnostic info on load
/// failure. Resolved at first call to `cpp_bridge_dll()`.
fn resolve_bridge_dll_path() -> std::path::PathBuf {
    // Phase 2 build script embeds the build path at compile time.
    if let Some(p) = option_env!("EXR_CPP_BRIDGE_DLL_BUILD_PATH") {
        return std::path::PathBuf::from(p);
    }

    // Fallback: search next to the running executable (release/debug
    // layout). Walk a few parent levels to handle cargo target/debug.
    if let Ok(exe) = std::env::current_exe() {
        let candidates = [
            exe.with_file_name("exr_cpp_bridge.dll"),
            exe.parent()
                .map(|p| p.join("exr_cpp_bridge.dll"))
                .unwrap_or_default(),
            exe.parent()
                .and_then(|p| p.parent())
                .map(|p| p.join("exr_cpp_bridge.dll"))
                .unwrap_or_default(),
        ];
        for c in candidates {
            if c.is_file() {
                return c;
            }
        }
        return exe.with_file_name("exr_cpp_bridge.dll");
    }
    std::path::PathBuf::from("exr_cpp_bridge.dll")
}

/// Lazily load exr_cpp_bridge.dll. Returns None if the DLL is missing
/// or can't be loaded (e.g. on a build where the C++ bridge wasn't
/// produced). Caches the result so subsequent calls are cheap.
pub fn cpp_bridge_dll() -> Option<&'static Library> {
    EXR_CPP_BRIDGE
        .get_or_init(|| -> Option<Library> {
            let path = resolve_bridge_dll_path();
            // SAFETY: libloading::Library::new is unsafe only because it
            // may execute DllMain. We only call it once per process.
            match unsafe { Library::new(&path) } {
                Ok(lib) => {
                    eprintln!(
                        "[openexr_ffi] exr_cpp_bridge.dll loaded from: {}",
                        path.display()
                    );
                    Some(lib)
                }
                Err(e) => {
                    eprintln!(
                        "[openexr_ffi] FAILED to load exr_cpp_bridge.dll from {}: {}",
                        path.display(),
                        e
                    );
                    None
                }
            }
        })
        .as_ref()
}

// ----------------------------------------------------------------------------
//  C++ bridge function types
// ----------------------------------------------------------------------------

pub type CppBridgeVersionFn = unsafe extern "C" fn() -> i32;
pub type CppPhysicalCoreCountFn = unsafe extern "C" fn() -> i32;
pub type CppSetGlobalThreadCountFn = unsafe extern "C" fn(i32);
pub type CppGetGlobalThreadCountFn = unsafe extern "C" fn() -> i32;

/// Decode EXR to packed RGBA float32 buffer.
///
/// Returns: positive pixel count on success, negative on error.
/// On error, *out_error_msg points at a static C string owned by the DLL.
pub type CppDecodeRgbaF32Fn = unsafe extern "C" fn(
    path: *const c_char,
    requested_channels: i32,
    out_rgba: *mut f32,
    out_width: *mut i32,
    out_height: *mut i32,
    out_pixel_count: *mut i32,
    out_error_msg: *mut *const c_char,
) -> i32;

/// Decode EXR to packed RGBA float32, requesting only the named channels
/// from the bridge's lower-level C++ path. Honors
/// `exr_cpp_set_global_thread_count`'s thread pool for parallel inflate.
///
/// `channel_names` is an array of `*const c_char` (C strings) pointing
/// at the names to request; `n_channel_names` is the array length.
/// Pass null/0 for "auto-detect first layer's RGBA". Match is
/// case-insensitive on the C++ side.
///
/// Return semantics identical to CppDecodeRgbaF32Fn.
pub type CppDecodeSubsetF32Fn = unsafe extern "C" fn(
    path: *const c_char,
    channel_names: *const *const c_char,
    n_channel_names: i32,
    out_rgba: *mut f32,
    out_width: *mut i32,
    out_height: *mut i32,
    out_pixel_count: *mut i32,
    out_error_msg: *mut *const c_char,
) -> i32;

// ----------------------------------------------------------------------------
//  Cached function pointers (lazily resolved from the loaded DLL)
// ----------------------------------------------------------------------------

fn cpp_fn<F>(name: &[u8]) -> Option<F>
where
    F: Copy,
{
    let lib = cpp_bridge_dll()?;
    // SAFETY: caller passes a name of a C-compatible exported symbol.
    // We rely on Symbol::into_raw() returning a FARPROC (= Option<fn()->isize>)
    // that we cast to F. The Library is kept alive for the process lifetime
    // via cpp_bridge_dll(), so the symbol address stays valid.
    unsafe {
        let sym = lib.get::<F>(name).ok()?;
        // Symbol derefs to F. We can copy the function pointer out.
        // The Library is held alive via cpp_bridge_dll() so the address
        // stays valid for the process lifetime.
        Some(std::ptr::read::<F>(&*sym))
    }
}

/// Initialize the OpenEXR thread pool. Should be called once at
/// application startup.
///
/// `n` = number of worker threads. Pass <=0 to use defaults.
/// Returns the thread count that was actually set, or None if the
/// bridge DLL is not available.
pub fn init_openexr_thread_pool(n: i32) -> Option<i32> {
    let set_fn: CppSetGlobalThreadCountFn = cpp_fn(b"exr_cpp_set_global_thread_count")?;
    let get_fn: CppGetGlobalThreadCountFn = cpp_fn(b"exr_cpp_get_global_thread_count")?;

    // SAFETY: both functions are extern "C" fn with no side effects
    // beyond mutating OpenEXR global state.
    unsafe {
        set_fn(n);
        Some(get_fn())
    }
}

/// Returns the OpenEXR worker thread count if the bridge is loaded.
pub fn openexr_thread_count() -> Option<i32> {
    let f: CppGetGlobalThreadCountFn = cpp_fn(b"exr_cpp_get_global_thread_count")?;
    Some(unsafe { f() })
}

/// Returns the bridge version (Phase 2 = 2) if loaded.
pub fn cpp_bridge_version() -> Option<i32> {
    let f: CppBridgeVersionFn = cpp_fn(b"exr_cpp_bridge_version")?;
    Some(unsafe { f() })
}

/// Detect physical/logical core count via Windows API (no DLL needed).
/// Used at startup to decide how many OpenEXR worker threads to spawn.
/// Returns `num_cpus::get()` (logical cores) if Windows API or extern
/// crate unavailable. Imported lazily to avoid a hard dependency on a
/// specific Windows sysinfo crate.
pub fn exr_cpp_physical_core_count_via_sysinfo() -> i32 {
    // std::thread::available_parallelism() returns the number of logical
    // cores the scheduler can use (similar to Windows API's
    // `dwNumberOfProcessors`). It's stable since Rust 1.59.
    std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(0)
}

/// Decode an EXR file via the C++ bridge. Returns None on any failure
/// (DLL not loaded, OpenEXR error, file not found, etc.). On success,
/// returns (width, height, rgba_f32).
pub fn cpp_decode_rgba_f32(path: &std::path::Path) -> Option<(u32, u32, Vec<f32>)> {
    let f: CppDecodeRgbaF32Fn = cpp_fn(b"exr_cpp_decode_rgba_f32")?;
    let path_str = path.to_str()?;

    // Convert path to UTF-16 -> bytes (we use a temporary buffer for the C string).
    let path_bytes = path_str.as_bytes();
    if path_bytes.len() > 4096 {
        return None; // safety: EXR paths shouldn't be this long
    }
    let mut path_buf = [0u8; 4096];
    path_buf[..path_bytes.len()].copy_from_slice(path_bytes);
    path_buf[path_bytes.len()] = 0;

    // First pass: get dimensions so we can allocate the output buffer.
    let mut width: i32 = 0;
    let mut height: i32 = 0;
    let mut pixel_count: i32 = 0;
    let mut err_msg: *const c_char = std::ptr::null();

    let rc = unsafe {
        f(
            path_buf.as_ptr() as *const c_char,
            0, /* requested channels: ignored */
            std::ptr::null_mut(),
            &mut width,
            &mut height,
            &mut pixel_count,
            &mut err_msg,
        )
    };

    if rc <= 0 || pixel_count <= 0 {
        return None;
    }

    let w = width as u32;
    let h = height as u32;
    let n = pixel_count as usize;
    let mut rgba: Vec<f32> = vec![0.0f32; n * 4];

    let rc2 = unsafe {
        f(
            path_buf.as_ptr() as *const c_char,
            0,
            rgba.as_mut_ptr(),
            &mut width,
            &mut height,
            &mut pixel_count,
            &mut err_msg,
        )
    };

    if rc2 <= 0 || pixel_count as usize != n {
        return None;
    }

    Some((w, h, rgba))
}

/// Decode an EXR via the C++ bridge subset path.
///
/// `wanted` is the list of channel names (e.g. `&["Beauty.R","Beauty.G",
/// "Beauty.B","Beauty.A"]`) to request. Pass an empty slice to mean
/// "auto-pick the first layer's RGBA". Match is case-insensitive on
/// the C++ side. Returns None on any failure (DLL not loaded, file
/// not found, no requested channel matched, etc.). On success returns
/// `(width, height, rgba_f32)`.
pub fn cpp_decode_subset_f32(
    path: &std::path::Path,
    wanted: &[String],
) -> Option<(u32, u32, Vec<f32>)> {
    let f: CppDecodeSubsetF32Fn = match cpp_fn(b"exr_cpp_decode_subset_f32") {
        Some(p) => p,
        None => {
            // Symbol not exported — fall through silently, the routing
            // layer will fall back to OpenEXRCore.
            eprintln!("[openexr_ffi] exr_cpp_decode_subset_f32 symbol not exported");
            return None;
        }
    };
    let path_str = path.to_str()?;
    let path_bytes = path_str.as_bytes();
    if path_bytes.len() > 4096 {
        return None;
    }
    let mut path_buf = [0u8; 4096];
    path_buf[..path_bytes.len()].copy_from_slice(path_bytes);
    path_buf[path_bytes.len()] = 0;

    // Build a stable Vec<CString> holding each wanted channel name,
    // then a parallel Vec<*const c_char> for the C call. Both must
    // live until both bridge calls return.
    let cstrings: Vec<std::ffi::CString> = wanted
        .iter()
        .map(|s| std::ffi::CString::new(s.as_str()).ok())
        .collect::<Option<Vec<_>>>()?;
    let cstr_ptrs: Vec<*const c_char> = cstrings
        .iter()
        .map(|cs| cs.as_ptr() as *const c_char)
        .collect();

    let mut width: i32 = 0;
    let mut height: i32 = 0;
    let mut pixel_count: i32 = 0;
    let mut err_msg: *const c_char = std::ptr::null();

    // First pass: get dimensions.
    let rc = unsafe {
        f(
            path_buf.as_ptr() as *const c_char,
            if cstr_ptrs.is_empty() {
                std::ptr::null()
            } else {
                cstr_ptrs.as_ptr()
            },
            cstr_ptrs.len() as i32,
            std::ptr::null_mut(),
            &mut width,
            &mut height,
            &mut pixel_count,
            &mut err_msg,
        )
    };
    if rc <= 0 || pixel_count <= 0 {
        return None;
    }

    let w = width as u32;
    let h = height as u32;
    let n = pixel_count as usize;
    let mut rgba: Vec<f32> = vec![0.0f32; n * 4];

    // Second pass: fill the buffer.
    let rc2 = unsafe {
        f(
            path_buf.as_ptr() as *const c_char,
            if cstr_ptrs.is_empty() {
                std::ptr::null()
            } else {
                cstr_ptrs.as_ptr()
            },
            cstr_ptrs.len() as i32,
            rgba.as_mut_ptr(),
            &mut width,
            &mut height,
            &mut pixel_count,
            &mut err_msg,
        )
    };

    if rc2 <= 0 || pixel_count as usize != n {
        return None;
    }

    Some((w, h, rgba))
}
