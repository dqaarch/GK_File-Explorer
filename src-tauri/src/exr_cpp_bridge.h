// exr_cpp_bridge.h
//
// OpenEXR C++ API FFI bridge, Phase 2.
//
// This header declares the C-linkage entry points exported from
// exr_cpp_bridge.dll. The implementation in exr_cpp_bridge.cpp uses the
// OpenEXR C++ API (Imf::RgbaInputFile, Imf::setGlobalThreadCount, etc.)
// so that OpenEXR's internal IlmThread pool is activated for all decode work.
//
// Replace the dummy stub from Phase 1. The Phase 1 entry points
// (exr_cpp_dummy_*) are intentionally removed — they would conflict with
// downstream consumers expecting real names.

#pragma once

#include <stdint.h>

#ifdef _WIN32
#define EXR_BRIDGE_API __declspec(dllexport)
#else
#define EXR_BRIDGE_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

// ----------------------------------------------------------------------------
//  Bridge info
// ----------------------------------------------------------------------------

// Returns the bridge version (bump when ABI changes).
EXR_BRIDGE_API int exr_cpp_bridge_version(void);

// Returns the detected physical core count (0 if detection fails).
EXR_BRIDGE_API int exr_cpp_physical_core_count(void);

// ----------------------------------------------------------------------------
//  Thread pool
// ----------------------------------------------------------------------------

// Set the global OpenEXR worker thread count. Pass <=0 to use defaults.
// Must be called once at startup before any decode happens.
EXR_BRIDGE_API void exr_cpp_set_global_thread_count(int n);

// Returns the current OpenEXR worker thread count.
EXR_BRIDGE_API int exr_cpp_get_global_thread_count(void);

// ----------------------------------------------------------------------------
//  Decode
// ----------------------------------------------------------------------------

// Decode an EXR file to packed RGBA float32 buffer. Channel order is RGBA,
// matching the existing Rust layout. Output buffer must be at least
// width * height * 4 * sizeof(float) bytes.
//
// Returns:
//   0 on success (positive number of pixels decoded into out_rgba)
//   <0 on error (and fills out_error_msg with a static C string)
//
// On success, *out_pixel_count = width * height.
// On failure, *out_pixel_count = 0 and *out_error_msg is a static string
// owned by the DLL (do not free).
EXR_BRIDGE_API int exr_cpp_decode_rgba_f32(
    const char* path,
    int requested_channels,   // ignored — always RGBA; reserved for future
    float* out_rgba,
    int* out_width,
    int* out_height,
    int* out_pixel_count,
    const char** out_error_msg
);

// Decode an EXR file to packed RGBA float32 buffer using the lower-level
// `Imf::InputFile` C++ API. Lets the caller specify the channel subset
// to read (e.g. "Beauty.R","Beauty.G","Beauty.B","Beauty.A"); the bridge
// erases every other channel from the header so OpenEXR's DWAB inflate
// only spends work on what we actually need. Honors the global thread
// pool size set by `exr_cpp_set_global_thread_count`.
//
// `channel_names` may be null/empty to mean "auto-pick RGBA of the first
// detected layer" (legacy R/G/B/A fallback for layerless files).
//
// Channel matching is case-insensitive on the file side, so a caller
// passing "Beauty.r" matches "Beauty.R" in the file.
//
// Output is always packed RGBA in scanline order (top-down). Channels
// not present in the file (or not requested) emit 0 — except missing
// alpha emits 1.0. Width / height follow the file's data window.
//
// Returns: positive pixel count on success, negative on error. On error
// `*out_error_msg` points at a static C string owned by the DLL.
EXR_BRIDGE_API int exr_cpp_decode_subset_f32(
    const char* path,
    const char* const* channel_names,
    int n_channel_names,
    float* out_rgba,
    int* out_width,
    int* out_height,
    int* out_pixel_count,
    const char** out_error_msg
);

#ifdef __cplusplus
}
#endif