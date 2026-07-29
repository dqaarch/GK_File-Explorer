//! OCIO 3D LUT lookup for the GPU-side EXR renderer.
//!
//! LUTs are baked at build time into `bundle_dist/luts/` by `build.rs`
//! (which calls `Tools/gen_luts.py`) and loaded from disk at runtime.
//! This keeps the binary lean (~1.6 GB smaller) while still shipping
//! the correct OCIO LUTs with the app.
//!
//! LUT layout matches `gen_luts.py`: row-major with B outermost and R
//! innermost, 3 float32 channels per voxel, no alpha.
//!
//! ```text
//! offset = ((b * size + g) * size + r) * 3
//! ```

use lru::LruCache;
use std::fs;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::Mutex;

mod lut_manifest {
    include!(concat!(env!("OUT_DIR"), "/lut_manifest.rs"));
}

pub use lut_manifest::{LutEntry, OCIO_MODES};

/// Default LUT grid resolution. Matches Python v1.0.1 implementation.
pub const DEFAULT_LUT_SIZE: u32 = 129;

/// ACES LUT input range. Must cover the full ACES RRT peak white (16.29)
/// so that EXR HDR values > 1.0 are properly tone-mapped through the LUT.
pub const ACES_LUT_INPUT_MAX: f32 = 16.29;

/// Legacy identity-passthrough range. Linear sRGB / Raw LUTs are
/// identity curves baked across `[0, IDENTITY_LUT_INPUT_MAX]`.
pub const IDENTITY_LUT_INPUT_MAX: f32 = 1.0;

/// Resolve the bundled LUTs directory at runtime.
///
/// Search order (first match wins):
///   1. `{exe_dir}/luts/`                      — NSIS install layout (bundled/)
///   2. `{exe_dir}/../luts/`                   — NSIS `_internal/` flatten
///   3. walk-up parents looking for `bundle_dist/luts/` (dev mode: target/debug/)
///   4. fallback: `bundle_dist/luts/` relative to CARGO_MANIFEST_DIR
pub fn find_luts_dir() -> Option<PathBuf> {
    find_luts_dir_inner()
}

/// Public wrapper for callers that need the luts dir for the asset
/// URL flow (e.g. `get_ocio_lut_asset_url`). Same logic as
/// `find_luts_dir`; kept as a separate function name so we can
/// tighten visibility later without breaking the internal cache.
pub fn find_luts_dir_for_assets() -> Option<PathBuf> {
    find_luts_dir_inner()
}

fn find_luts_dir_inner() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?.to_path_buf();

    // 1. Direct: next to the exe
    let direct = exe_dir.join("luts");
    if direct.is_dir() {
        return Some(direct);
    }

    // 2. NSIS _internal flatten: one level up
    let up1 = exe_dir.join("..").join("luts");
    if up1.is_dir() {
        return Some(up1);
    }

    // 3. Walk up looking for bundle_dist/luts/ (dev mode)
    let mut walker = exe_dir.clone();
    for _ in 0..10 {
        let candidate = walker.join("bundle_dist").join("luts");
        if candidate.is_dir() {
            return Some(candidate);
        }
        if !walker.pop() {
            break;
        }
    }

    // 4. Fallback: relative to manifest dir (works in dev)
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let fallback = PathBuf::from(manifest)
            .parent() // src-tauri/
            .unwrap()
            .join("bundle_dist")
            .join("luts");
        if fallback.is_dir() {
            return Some(fallback);
        }
    }

    None
}

/// Path to the .bin file for a given slug.
fn lut_path(slug: &str) -> Option<PathBuf> {
    find_luts_dir().map(|dir| dir.join(format!("{}.bin", slug)))
}

/// Look up a baked LUT entry by its slug.
pub fn find_entry(slug: &str) -> Option<&'static LutEntry> {
    OCIO_MODES.iter().find(|e| e.slug == slug)
}

/// Look up the scene-linear input domain the active LUT was baked over.
pub fn lut_input_max_for_mode(slug: &str) -> f32 {
    find_entry(slug)
        .map(|e| e.lut_input_max)
        .unwrap_or(ACES_LUT_INPUT_MAX)
}

/// Process-global LRU cache for the float32 payload.
static LUT_CACHE: once_cell::sync::Lazy<Mutex<LruCache<String, Vec<f32>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(LruCache::new(NonZeroUsize::new(16).unwrap())));

/// Load a baked LUT for the given mode slug from disk.
/// Returns the flat f32 payload (size^3 * 3 floats), the grid size,
/// and the input domain the LUT was baked over.
pub fn get_lut(mode: &str) -> Result<(Vec<f32>, u32, f32), String> {
    let entry = find_entry(mode).ok_or_else(|| format!("Unknown OCIO mode: '{}'", mode))?;
    let input_max = entry.lut_input_max;

    // Check in-memory cache first.
    {
        let cache = LUT_CACHE.lock().map_err(|e| format!("LUT cache poisoned: {}", e))?;
        if let Some(cached) = cache.peek(mode) {
            return Ok((cached.clone(), DEFAULT_LUT_SIZE, input_max));
        }
    }

    // Load from disk.
    let path = lut_path(mode)
        .ok_or_else(|| format!("LUT directory not found for slug '{}'", mode))?;

    let bytes = fs::read(&path).map_err(|e| {
        format!(
            "Failed to read LUT '{}' from {}: {}",
            mode,
            path.display(),
            e
        )
    })?;

    validate_size(&bytes, DEFAULT_LUT_SIZE)?;

    let mut floats = Vec::with_capacity((DEFAULT_LUT_SIZE as usize).pow(3) * 3);
    for chunk in bytes.chunks_exact(4) {
        floats.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }

    let mut cache = LUT_CACHE.lock().map_err(|e| format!("LUT cache poisoned: {}", e))?;
    cache.put(mode.to_string(), floats.clone());

    Ok((floats, DEFAULT_LUT_SIZE, input_max))
}

/// Validate that the binary file matches the expected layout.
fn validate_size(bytes: &[u8], size: u32) -> Result<(), String> {
    let expected = (size as usize).pow(3) * 3 * 4;
    if bytes.len() != expected {
        return Err(format!(
            "LUT size mismatch: got {} bytes, expected {} for {} grid",
            bytes.len(),
            expected,
            size
        ));
    }
    Ok(())
}

/// Clear the LUT cache (for future use).
#[allow(dead_code)]
pub fn clear_cache() {
    if let Ok(mut cache) = LUT_CACHE.lock() {
        cache.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn luts_dir_can_be_found() {
        // In tests we just check it doesn't panic; actual path depends on build env.
        let dir = find_luts_dir();
        // In normal build this would be Some; in pure unit tests it may be None.
        if let Some(d) = dir {
            assert!(d.is_dir(), "found luts dir should be a directory: {}", d.display());
        }
    }
}
