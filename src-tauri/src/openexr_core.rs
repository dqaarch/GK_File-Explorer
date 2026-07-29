//! OpenEXR Engine using OpenEXRCore FFI for DWAA/DWAB support
//!
//! Uses OpenEXRCore-3_4.dll decode pipeline for full EXR support including DWAA/DWAB.
//! FFI-only — no Python fallback.

use crate::openexr_ffi::*;
use image::{ImageBuffer, ImageFormat, Rgba};
use std::ffi::{CString, c_char};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use once_cell::sync::OnceCell;
use libloading::{Library, Symbol};
use thiserror::Error;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rayon::prelude::*;
use serde_json;

/// Log file path for EXR decode diagnostics. This is written alongside the
/// other debug logs the user can inspect after running the app. On Windows
/// GUI apps `eprintln!` writes to a hidden stderr pipe that the user cannot
/// see, so we mirror important log lines to a file in TEMP.
static EXR_LOG_FILE: OnceCell<Mutex<Option<File>>> = OnceCell::new();

fn get_log_file() -> Option<std::sync::MutexGuard<'static, Option<File>>> {
    EXR_LOG_FILE
        .get_or_init(|| {
            // Try TEMP first, fall back to current dir.
            let log_path = std::env::var("TEMP")
                .ok()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                .join("goku_exr_debug.log");
            // Append mode so logs accumulate across runs.
            match OpenOptions::new().create(true).append(true).open(&log_path) {
                Ok(f) => {
                    // Write a session-start banner so the user can find their latest run.
                    let mut file = f;
                    let _ = writeln!(file, "\n\n========== NEW SESSION @ {:?} ==========",
                        std::time::SystemTime::now());
                    let _ = file.flush();
                    Mutex::new(Some(file))
                }
                Err(_) => Mutex::new(None),
            }
        })
        .lock()
        .ok()
}

/// Mirror an `eprintln!` line to the debug log file in TEMP.
/// On Windows GUI apps stderr is invisible, so this is the only way for the
/// user to see the FFI logs after running the app.
fn exr_log(msg: &str) {
    if let Some(mut guard) = get_log_file() {
        if let Some(f) = guard.as_mut() {
            let _ = writeln!(f, "{}", msg);
            let _ = f.flush();
        }
    }
}

/// Convenience: log a phase marker. Use like `exr_log_phase("START", "extract")`.
fn exr_log_phase(phase: &str, ctx: &str) {
    exr_log(&format!("[PHASE-{}] {}", phase, ctx));
}

/// Public accessor so other modules can mirror logs to the same file.
pub fn log_to_exr_debug(msg: &str) {
    exr_log(msg);
}

/// Convert 8 half-floats to 8 u8 values (linear -> [0,255] tone-mapped).
/// Uses F16C SIMD when available (Intel Ivy Bridge+ / AMD Zen+) and falls
/// back to scalar `half_to_float` on CPUs without F16C. Output is
/// byte-identical to the scalar path so thumbnail visuals are unchanged.
///
/// IMPORTANT: `_mm_cvtph_ps` converts **4** half values to **4** floats
/// per call (one `__m128` register), NOT 8. To process all 8 halves of a
/// packed 128-bit input we must convert the low and high 64-bit lanes
/// separately and store into `floats[0..4]` and `floats[4..8]`. The
/// previous single-call version only wrote the low 4 outputs and left
/// `floats[4..8]` zero, producing a 4-pixel-wide vertical black stripe on
/// every chunk boundary (the bug user reported).
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "f16c")]
unsafe fn half_row_to_u8_x8(bits: &[u16; 8]) -> [u8; 8] {
    use std::arch::x86_64::*;
    let v = _mm_loadu_si128(bits.as_ptr() as *const __m128i);
    let zero = _mm_setzero_si128();
    let lo = _mm_cvtph_ps(_mm_unpacklo_epi64(v, zero));
    let hi = _mm_cvtph_ps(_mm_unpackhi_epi64(v, zero));
    let mut floats = [0f32; 8];
    _mm_storeu_ps(floats.as_mut_ptr(), lo);
    _mm_storeu_ps(floats.as_mut_ptr().add(4), hi);
    let mut out = [0u8; 8];
    for j in 0..8 {
        let v = floats[j].max(0.0).min(1.0);
        out[j] = (v * 255.0 + 0.5) as u8;
    }
    out
}

/// Convert 8 half-floats to 8 f32 values without clamping. Used by the
/// GPU-side OCIO LUT path so the linear HDR payload survives intact.
///
/// Same F16C correctness fix as `half_row_to_u8_x8` — see comment there.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "f16c")]
unsafe fn half_row_to_f32_x8(bits: &[u16; 8]) -> [f32; 8] {
    use std::arch::x86_64::*;
    let v = _mm_loadu_si128(bits.as_ptr() as *const __m128i);
    let zero = _mm_setzero_si128();
    let lo = _mm_cvtph_ps(_mm_unpacklo_epi64(v, zero));
    let hi = _mm_cvtph_ps(_mm_unpackhi_epi64(v, zero));
    let mut floats = [0f32; 8];
    _mm_storeu_ps(floats.as_mut_ptr(), lo);
    _mm_storeu_ps(floats.as_mut_ptr().add(4), hi);
    floats
}

/// Atomic max update for f32 stored as AtomicU32 bit pattern.
/// NaN is treated as no-op (we use is_finite guards at call sites).
#[inline]
fn update_max_f32(slot: &Arc<AtomicU32>, candidate: f32) {
    let cand_bits = candidate.to_bits();
    let mut prev = slot.load(Ordering::Relaxed);
    loop {
        let prev_f = f32::from_bits(prev);
        if candidate <= prev_f {
            return;
        }
        match slot.compare_exchange_weak(prev, cand_bits, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return,
            Err(actual) => prev = actual,
        }
    }
}

/// Creates a Command that hides the console window on Windows.
#[cfg(windows)]
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

#[cfg(not(windows))]
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    Command::new(program)
}

/// Resolve a path inside the bundled `bundle_dist/` directory.
///
/// Search order (first match wins):
///   1. `{exe_dir}/<subdir>/<file>`             — NSIS install layout
///   2. `{exe_dir}/../<subdir>/<file>`          — NSIS `_internal/` flatten
///   3. walk-up parents looking for `bundle_dist/<subdir>/<file>` (dev)
fn find_bundled_path(subdir: &str, file: &str) -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?.to_path_buf();

    let direct = exe_dir.join(subdir).join(file);
    if direct.exists() {
        return Some(direct);
    }
    if let Some(parent) = exe_dir.parent() {
        let sibling = parent.join(subdir).join(file);
        if sibling.exists() {
            return Some(sibling);
        }
    }

    let mut walker = exe_dir;
    for _ in 0..10 {
        let candidate = walker.join("bundle_dist").join(subdir).join(file);
        if candidate.exists() {
            return Some(candidate);
        }
        if !walker.pop() {
            break;
        }
    }
    None
}

pub struct ExrThumbResult {
    pub png_data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub method: String,
    pub layers_count: usize,
    pub channels: Vec<String>,
    pub cryptomatte_layers: Vec<String>,
    pub layer_names: Vec<String>,  // All layer names in the EXR
}

pub struct ExrLayerInfo {
    pub name: String,
    pub has_rgb: bool,
    pub has_alpha: bool,
    pub channels: Vec<String>,
}

impl Clone for ExrLayerInfo {
    fn clone(&self) -> Self {
        ExrLayerInfo {
            name: self.name.clone(),
            has_rgb: self.has_rgb,
            has_alpha: self.has_alpha,
            channels: self.channels.clone(),
        }
    }
}

// Metadata-only struct for fast header reading (no pixel decode)
pub struct ExrMetadata {
    pub width: u32,
    pub height: u32,
    pub channel_names: Vec<String>,
    pub layer_names: Vec<ExrLayerInfo>,
    pub cryptomatte_layers: Vec<String>,
    pub compression: String,
    pub pixel_type: String,  // float16, float32, etc.
}

impl ExrMetadata {
    /// Parse layer info from a flat channel-name list.
    ///
    /// Behaviour is unified across EXR Single-Frame, Multi-Layer Single-Frame,
    /// and Sequence variants — the parser only sees a list of channel names
    /// and a single function decides what counts as a "layer".  The rules:
    ///
    /// 1. Cryptomatte channels (`*.R/G/B/A` under a `crypto*` base name) are
    ///    NOT added to the per-layer map — they go into `cryptomatte_layers`.
    /// 2. Channels with a dot (e.g. `Beauty.R`, `Ambient light.G`,
    ///    `Ambient occlusion.y`) define their layer name from the prefix.
    /// 3. Channels WITHOUT a dot (`R`, `G`, `B`, `A`, `Y`, …) belong to the
    ///    implicit "rgba" root layer. This is how single-layer EXRs are
    ///    represented (`Rnd__AO_0015.exr` → 1 layer "rgba" with `[y]`).
    /// 4. If a multi-layer EXR also has bare root channels (`R, G, B, A`)
    ///    alongside the named layers, those bare channels are kept under the
    ///    "rgba" pseudo-layer — useful for tools that process the main
    ///    composite output, harmless for the picker.
    pub fn parse_layers_from_channels(channels: &[String]) -> (Vec<ExrLayerInfo>, Vec<String>) {
        let mut layer_map: std::collections::HashMap<String, ExrLayerInfo> = std::collections::HashMap::new();
        let mut cryptomatte_layers: Vec<String> = Vec::new();

        for ch in channels {
            let ch_upper = ch.to_uppercase();

            // Skip cryptomatte channels for layer grouping
            if ch_upper.contains("CRYPTO") {
                // Extract cryptomatte layer name
                // Patterns: "cryptoMaterial.R", "CryptoGeometryNodeName.something", "cryptomatte00.R"
                if let Some(last_part) = ch.rsplit('.').next() {
                    let last_lower = last_part.to_lowercase();
                    // Check if it's a component suffix (r, g, b, a, 0, 1, 2, 3)
                    let is_component = last_lower.chars().all(|c| c == 'r' || c == 'g' || c == 'b' || c == 'a' || c.is_ascii_digit());

                    if is_component {
                        // Extract base name (everything before .R, .G, .B, etc.)
                        let base = ch[..ch.len() - last_part.len() - 1].to_string();
                        if !base.is_empty() {
                            // Normalize common cryptomatte layer names
                            let normalized = if base.to_lowercase() == "cryptoobject" {
                                "cryptoObject".to_string()
                            } else if base.to_lowercase() == "cryptomaterial" {
                                "cryptoMaterial".to_string()
                            } else if base.to_lowercase() == "cryptoasset" {
                                "cryptoAsset".to_string()
                            } else {
                                base
                            };
                            if !cryptomatte_layers.contains(&normalized) {
                                cryptomatte_layers.push(normalized);
                            }
                        }
                    }
                }
                continue;
            }

            // Parse layer name from channel (e.g., "Beauty.R" -> layer="Beauty", component="R")
            let (raw_layer_name, component) = if ch.contains('.') {
                let parts: Vec<&str> = ch.split('.').collect();
                let layer = parts[0..parts.len()-1].join(".");
                let comp = parts.last().unwrap_or(&"");
                (layer, comp.to_string())
            } else {
                (String::new(), ch.clone())
            };

            // Single-layer EXRs have channels like "R", "G", "B", "A" with no layer prefix.
            // Normalize the empty layer name to "rgba" so the frontend can use it as a real key.
            let layer_name = if raw_layer_name.is_empty() {
                "rgba".to_string()
            } else {
                raw_layer_name
            };

            let entry = layer_map.entry(layer_name.clone()).or_insert(ExrLayerInfo {
                name: layer_name,
                has_rgb: false,
                has_alpha: false,
                channels: Vec::new(),
            });

            entry.channels.push(ch.clone());

            // Mark RGB/Alpha
            match component.as_str() {
                "R" | "G" | "B" | "RED" | "GREEN" | "BLUE" => entry.has_rgb = true,
                "A" | "ALPHA" => entry.has_alpha = true,
                _ => {}
            }
        }

        let mut layers: Vec<ExrLayerInfo> = layer_map.into_values().collect();
        layers.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        // If there is MORE THAN ONE meaningful named layer alongside a root
        // "rgba" pseudo-layer that has only `R, G, B, A` (i.e. a composite of
        // the RGB primary channels with no Y/Z etc), the bare channels are
        // just a leftover root composite — drop the redundant "rgba" entry
        // so the picker doesn't list 22 layers when the file really has 21.
        // For single-layer EXRs this branch is skipped (only one layer total).
        let has_named_layers = layers.iter().any(|l| l.name != "rgba" && !l.name.is_empty());
        let rgba_index = layers.iter().position(|l| l.name == "rgba");
        if has_named_layers {
            if let Some(idx) = rgba_index {
                let rgba = &layers[idx];
                let only_bare_rgb = rgba.channels.iter().all(|c| {
                    let up = c.to_uppercase();
                    up == "R" || up == "G" || up == "B" || up == "A" ||
                    up == "RED" || up == "GREEN" || up == "BLUE" || up == "ALPHA"
                });
                if only_bare_rgb && layers.len() > 1 {
                    layers.remove(idx);
                }
            }
        }

        // Sort cryptomatte layers
        cryptomatte_layers.sort();

        (layers, cryptomatte_layers)
    }
}

#[derive(Error, Debug, Clone)]
pub enum ExrError {
    #[error("Failed to load OpenEXRCore library: {0}")]
    LibraryLoad(String),
    #[error("OpenEXR error: {0:?}")]
    ExrResult(ExrResult),
    #[error("Invalid file format")]
    InvalidFile,
    #[error("Path error")]
    PathError,
    #[error("No channels found")]
    NoChannels,
    #[error("Decode pipeline error")]
    PipelineError,
    #[error("Decode error: {0}")]
    DecodeError(String),
}

pub type Result<T> = std::result::Result<T, ExrError>;

fn check_result(code: i32) -> Result<()> {
    let result = ExrResult::from_c(code);
    if result.is_ok() { Ok(()) } else { Err(ExrError::ExrResult(result)) }
}

// ============================================================================
// Pass-Type Detection
// ============================================================================

/// Pass-type detection result with computed pixel statistics.
///
/// Mirrors Python `detect_pass_type_from_names` but the Rust version has
/// full access to `channel_names` AND the decoded pixel buffer. We use the
/// buffer to compute the same `mean/std/min/max/has_negative/is_hdr` stats
/// the Python decoder uses to distinguish e.g. Normal (unit-length vectors,
/// both polarities) from Position (large magnitude, mixed polarity) and
/// from a regular HDR RGB lighting pass (non-negative, HDR values).
#[derive(Debug, Clone)]
struct PassStats {
    min: f32,
    max: f32,
    mean: f32,
    /// True if any sample is strictly negative.
    has_negative: bool,
    /// True if any sample > 1.0 by a meaningful margin (likely HDR).
    is_hdr: bool,
    /// Number of meaningful samples (skips degenerate buffers).
    sample_count: usize,
}

/// Compute summary statistics from a (subset of) the final RGBA-F32 buffer.
/// `channels` describes the layout of that buffer (e.g. `["y"]` for a
/// single-channel file broadcast to RGB, `["R","G","B"]` for RGB, `["X","Y","Z"]`
/// for position/normal-like files).
///
/// We look at the channels the user is *rendering* (not the decoded raw
/// channels) so single-channel broadcasts correctly report on the one
/// channel that mattered, and XYZ buffers correctly report three channels.
fn compute_pass_stats(rgba_f32: &[f32], channels: &[String]) -> PassStats {
    if rgba_f32.is_empty() || channels.is_empty() {
        return PassStats { min: 0.0, max: 0.0, mean: 0.0,
            has_negative: false, is_hdr: false, sample_count: 0 };
    }
    let width = (rgba_f32.len() / 4).max(1);
    let want_components: Vec<String> = channels.iter()
        .filter_map(|c| {
            // Strip "LayerName." prefix if present, take the last component.
            let comp = c.rsplit('.').next().unwrap_or(c).to_lowercase();
            match comp.as_str() {
                "r" | "red"   => Some("r".to_string()),
                "g" | "green" => Some("g".to_string()),
                "b" | "blue"  => Some("b".to_string()),
                "x"           => Some("x".to_string()),
                "y"           => Some("y".to_string()),
                "z"           => Some("z".to_string()),
                _ => None,
            }
        })
        .collect();

    let mut min_v = f32::INFINITY;
    let mut max_v = f32::NEG_INFINITY;
    let mut sum = 0f64;
    let mut count = 0usize;
    let mut has_negative = false;
    let mut is_hdr = false;

    for px in 0..width {
        let base = px * 4;
        for want in &want_components {
            let idx = match want.as_str() {
                "r" | "x" => base + 0,
                "g" | "y" => base + 1,
                "b" | "z" => base + 2,
                _ => continue,
            };
            if idx >= rgba_f32.len() { continue; }
            let v = rgba_f32[idx];
            if !v.is_finite() { continue; }
            if v < min_v { min_v = v; }
            if v > max_v { max_v = v; }
            sum += v as f64;
            count += 1;
            if v < -0.001 { has_negative = true; }
            if v > 1.5 { is_hdr = true; }
        }
    }

    let mean = if count > 0 { (sum / count as f64) as f32 } else { 0.0 };
    PassStats { min: min_v, max: max_v, mean,
        has_negative, is_hdr, sample_count: count }
}

/// Decide whether a vector buffer looks like a Normal/Tangent (unit-length
/// vectors with both polarities present in each component).
fn has_unit_vectors(stats: &[&PassStats]) -> bool {
    if stats.len() < 3 { return false; }
    // Mean magnitude ~ 1.0, small variance, every component takes both signs.
    let mut sum_sq = 0f64;
    for s in &stats[..3] {
        let m = s.mean as f64;
        sum_sq += m * m;
    }
    let mag = sum_sq.sqrt();
    let in_range = mag > 0.85 && mag < 1.15;
    let both = stats[..3].iter().all(|s| s.has_negative && s.max > 0.1);
    in_range && both
}

/// Decide whether a 4-component RGBA f32 buffer is grayscale-encoded.
/// Used by the Shadow pass-type detector when the channel names look
/// RGB (`Shadow.R` / `Shadow.G` / `Shadow.B`) but the data is actually
/// a single-channel mask replicated across R, G, B — Arnold, RenderMan,
/// Cycles all do this when the shadow pass uses the standard 3-channel
/// R/G/B layer slots to carry one float per pixel.
///
/// Strategy: sample N evenly-spaced pixels. A buffer is grayscale if at
/// least GRAY_MATCH_RATIO of the opaque samples satisfy
/// `|R - G| <= tol && |R - B| <= tol && |G - B| <= tol`. We skip pixels
/// where R/G/B are all zero (transparent background) since those
/// trivially satisfy equality and would skew the test. Skip out-of-
/// range pixels (NaN / Inf) the same way.
///
/// Tolerance reasoning: Arnold / RenderMan / Cycles shadow masks are
/// float values; the half-precision EXR round-trip introduces ±1 ULP
/// noise per channel, and DWAB compression can add another ±2 ULP on
/// top. Across 3 channels that's typically ≤ 5 × 2^-10 ≈ 0.005. We
/// use `tol = 0.02` (≈5/255) so DWAB-decompressed shadow masks still
/// classify as grayscale even when a few pixels drift slightly outside
/// strict bitwise equality. The `GRAY_MATCH_RATIO` ratio lets a handful
/// of edge pixels (e.g. compressed seams with higher error) fail the
/// test without forcing the buffer back to "rgb".
fn is_gray_rgb_buffer(rgba: &[f32], tol: f32) -> bool {
    let pixel_count = rgba.len() / 4;
    if pixel_count == 0 { return false; }
    const SAMPLES: usize = 64;
    const GRAY_MATCH_RATIO: f32 = 0.95; // ≥95% of opaque samples must match
    let step = (pixel_count / SAMPLES).max(1);
    let mut compared: usize = 0;
    let mut matches: usize = 0;
    let mut px = 0usize;
    while px < pixel_count && compared < SAMPLES {
        let base = px * 4;
        let r = rgba[base];
        let g = rgba[base + 1];
        let b = rgba[base + 2];
        let a = rgba[base + 3];
        // Skip transparent / non-finite / all-zero pixels (they trivially
        // satisfy equality and would misclassify a real RGB buffer as gray).
        if a > 0.0 && r.is_finite() && g.is_finite() && b.is_finite()
            && (r.abs() + g.abs() + b.abs()) > 1e-6
        {
            compared += 1;
            if (r - g).abs() <= tol && (r - b).abs() <= tol && (g - b).abs() <= tol {
                matches += 1;
            }
        }
        px += step;
    }
    // Require at least GRAY_MATCH_RATIO of the opaque samples to match.
    // This is intentionally lenient — true RGB buffers almost always
    // contain hue-diverse pixels that fail equality, while grayscale
    // masks with mild compression noise stay well above the ratio.
    if compared == 0 { return false; }
    (matches as f32) / (compared as f32) >= GRAY_MATCH_RATIO
}

/// Detect pass type from channel names + (optional) pixel statistics + the
/// full file path (used as a fallback keyword source, mirroring the Python
/// decoder's `file_name` parameter).
///
/// Returns one of:
///   "cryptomatte" | "depth" | "ao" | "grayscale" | "normal" |
///   "position" | "motion" | "uv" | "tangent" | "rgb" | "hdr"
fn detect_pass_type(
    channel_names: &[String],
    file_path: Option<&str>,
    rgba_f32: Option<&[f32]>,
) -> String {
    let total = channel_names.len();

    // Per-pixel R/G/B equality tolerance for the shadow-mask detector.
    // 5/255 ≈ ~2% absolute. Half-precision EXR round-trip plus DWAB
    // compression noise is typically 0.005 absolute; we use 0.02 to
    // leave room for sub-block quantization spikes at shadow edges.
    const SHADOW_GRAY_TOL: f32 = 5.0 / 255.0;

    // ---- 0. Build keyword context (file name + layer names) ---------------
    // Mirrors Python's keyword_context = [file_name parts..., layer names...]
    let file_stem: String = file_path
        .and_then(|p| {
            // Take just the file name part of the path.
            let sep = p.rfind(|c| c == '/' || c == '\\').unwrap_or(0);
            Some(p[sep.saturating_add(1)..].to_string())
        })
        .unwrap_or_default();

    // Split file name into parts (snake/dash/space/dot), drop extension digits.
    let mut kw_tokens: Vec<String> = Vec::new();
    if !file_stem.is_empty() {
        // Drop extension
        let stem_no_ext = file_stem.rsplit_once('.').map(|(s, _)| s).unwrap_or(&file_stem);
        for part in stem_no_ext.split(|c: char| c == '_' || c == '-' || c == ' ' || c == '.') {
            let p = part.to_lowercase();
            if !p.is_empty() && !p.chars().all(|c| c.is_ascii_digit()) {
                kw_tokens.push(p);
            }
        }
    }
    // Also feed layer-name-like prefixes that exist in *bare* single-channel
    // channel names (e.g. `Rnd__y` doesn't exist, but `BeautyAORender.y` would).
    for ch in channel_names {
        let lower = ch.to_lowercase();
        // Take everything before the last dot as a layer-name hint.
        if let Some(dot_idx) = lower.rfind('.') {
            let layer = &lower[..dot_idx];
            for part in layer.split(|c: char| c == '_' || c == '-' || c == ' ' || c == '.') {
                if !part.is_empty() && !part.chars().all(|c| c.is_ascii_digit()) {
                    kw_tokens.push(part.to_string());
                }
            }
        }
    }
    let kw_ctx = kw_tokens.join(" ");

    // ---- 1. Cryptomatte (must be FIRST) ------------------------------------
    let crypto_kw = ["crypto", "cryptogeometry", "cryptomaterial",
                     "cryptonode", "cryptoshading", "cryptogeometrynodename"];
    let has_crypto = channel_names.iter().any(|c| {
        let cl = c.to_lowercase();
        crypto_kw.iter().any(|k| cl.starts_with(k))
    });
    if has_crypto {
        return "cryptomatte".to_string();
    }

    // ---- 2. Count components ----------------------------------------------
    let mut rgb_count = 0usize;
    let mut xyz_count = 0usize;
    let mut uv_count = 0usize;
    for ch in channel_names {
        let comp = ch.rsplit('.').next().unwrap_or(ch).to_uppercase();
        match comp.as_str() {
            "R" | "G" | "B" | "RED" | "GREEN" | "BLUE" => rgb_count += 1,
            "X" | "Y" | "Z" => xyz_count += 1,
            "U" | "V" | "S" | "T" => uv_count += 1,
            _ => {}
        }
    }

    // ---- 3. Keyword-driven detection (priority order matches Python) ------
    // Python uses whole-word matching with boundary regex. We use plain
    // substring matching here which is good enough for the short tokens we
    // generate from the file name (Rnd__ALi_0015 -> ["rnd","ali"]).

    let contains = |s: &str, kw: &str| s.contains(kw);

    // Normal keywords
    if contains(&kw_ctx, "normal") || contains(&kw_ctx, "nrm") || contains(&kw_ctx, "normals")
        || contains(&kw_ctx, "nrml") {
        if xyz_count >= 3 || rgb_count >= 3 {
            return "normal".to_string();
        }
    }
    // Position
    if contains(&kw_ctx, "position") || contains(&kw_ctx, "worldpos")
        || contains(&kw_ctx, "pos") || contains(&kw_ctx, "p.") {
        if xyz_count >= 3 || rgb_count >= 3 {
            return "position".to_string();
        }
    }
    // Tangent
    if contains(&kw_ctx, "tangent") || contains(&kw_ctx, "tan") {
        if xyz_count >= 3 || rgb_count >= 3 {
            return "tangent".to_string();
        }
    }
    // UV
    if contains(&kw_ctx, "uv") || contains(&kw_ctx, "texcoord")
        || contains(&kw_ctx, "st") {
        return "uv".to_string();
    }
    // Motion
    if contains(&kw_ctx, "motion") || contains(&kw_ctx, "velocity")
        || contains(&kw_ctx, "motionvector") || contains(&kw_ctx, "motionvec") {
        return "motion".to_string();
    }
    // Depth — keyword match alone is enough (don't wait for stats fallback)
    if contains(&kw_ctx, "depth") || contains(&kw_ctx, "zdepth")
        || contains(&kw_ctx, "linear") || contains(&kw_ctx, "z.") {
        return "depth".to_string();
    }
    // Wireframe (grayscale)
    if contains(&kw_ctx, "wire") || contains(&kw_ctx, "wireframe") {
        if total >= 1 { return "ao".to_string(); /* uses grayscale path */ }
    }
    // SSS — these are typically RGB renders (SSS color contribution). Use
    // grayscale only for 1-channel SSS masks; otherwise they're a regular
    // RGB pass that benefits from ACES tonemapping (HDR sub-surface
    // scattering often exceeds 1.0).
    if contains(&kw_ctx, "sss") || contains(&kw_ctx, "subsurface") {
        if rgb_count >= 3 {
            return "rgb".to_string();
        }
        return "ao".to_string();
    }
    // Shadow — shadow-catcher passes come in two flavours:
    //   1. RGBA RGB renders with full color info (Albedo Shadow etc) — render via ACES.
    //   2. Single-channel "shadow mask" stored as `Beauty.R/G/B` triple with
    //      R==G==B per pixel (Arnold, RenderMan, Cycles all do this to use
    //      the multi-channel path even though the data is grayscale). The
    //      Rust decoder also broadcasts a true 1-channel `Shadow.y` through
    //      a single `single_buf` into R=G=B. Either way, the channel names
    //      *look* like an RGB pass but the data is grayscale. Detect this
    //      by sampling a few pixels and comparing R/G/B equality; if all
    //      three channels are equal to within `SHADOW_GRAY_TOL` the buffer
    //      is a shadow mask and should render as Grayscale, NOT ACES-RGB.
    if contains(&kw_ctx, "shdw") || contains(&kw_ctx, "shadow")
        || contains(&kw_ctx, "shadowcatcher") {
        if rgb_count >= 3 {
            // Sample-based grayscale test. We can't compare the raw buffers
            // directly (this function only sees `rgba_f32`), but we can
            // compare per-pixel R/G/B within the floats and see whether the
            // encoder treats the three channels as redundant.
            if let Some(rgba) = rgba_f32 {
                if is_gray_rgb_buffer(rgba, SHADOW_GRAY_TOL) {
                    return "grayscale".to_string();
                }
            }
            return "rgb".to_string();
        }
        return "ao".to_string();
    }
    // Transmission — RGB light contribution through a surface, needs ACES.
    if contains(&kw_ctx, "transmission") || contains(&kw_ctx, "tran") {
        if rgb_count >= 3 {
            return "rgb".to_string();
        }
        return "ao".to_string();
    }
    // Diffuse / Albedo / Base Color — RGB pass with HDR light contribution,
    // needs ACES (NOT a grayscale AO-style render).
    if contains(&kw_ctx, "diffuse") || contains(&kw_ctx, "albedo")
        || contains(&kw_ctx, "basecolor") || contains(&kw_ctx, "base_color")
        || contains(&kw_ctx, "env") || contains(&kw_ctx, "environment")
        || contains(&kw_ctx, "post") {
        if rgb_count >= 3 {
            return "rgb".to_string();
        }
        return "ao".to_string();
    }
    // Emission BEFORE AO so "ambient light" doesn't match AO
    if contains(&kw_ctx, "emission") || contains(&kw_ctx, "emit")
        || contains(&kw_ctx, "light") || contains(&kw_ctx, "glow") || contains(&kw_ctx, "ali") {
        if rgb_count >= 3 || xyz_count >= 3 {
            return "rgb".to_string();
        } else if total >= 1 {
            return "ao".to_string();
        }
    }
    // AO
    if contains(&kw_ctx, "ao") || contains(&kw_ctx, "occlusion")
        || contains(&kw_ctx, "ambient") || contains(&kw_ctx, "ssao")
        || contains(&kw_ctx, "gi") {
        return "ao".to_string();
    }
    // Material / PBR mattes (Roughness, Metallic, Specular, etc.). Note
    // that "diffuse" is intentionally NOT here — RGB diffuse/albedo/base-color
    // passes need ACES and are handled in the dedicated block above.
    if contains(&kw_ctx, "rough") || contains(&kw_ctx, "metallic")
        || contains(&kw_ctx, "metalness") || contains(&kw_ctx, "specular")
        || contains(&kw_ctx, "gloss") || contains(&kw_ctx, "opacity")
        || contains(&kw_ctx, "matte")
        || contains(&kw_ctx, "reflect") {
        return "ao".to_string();
    }

    // ---- 4. Stats-based fallback for 3-vec buffers ------------------------
    if total >= 3 {
        // Compute per-component stats from the RGBA F32 buffer (component 0/1/2).
        let per_comp_stats: Vec<PassStats> = if let Some(rgba) = rgba_f32 {
            let pixel_count = rgba.len() / 4;
            let mut stats = vec![PassStats { min: 0.0, max: 0.0, mean: 0.0,
                has_negative: false, is_hdr: false, sample_count: 0 }; 3];
            for px in 0..pixel_count {
                let base = px * 4;
                for c in 0..3 {
                    let v = rgba[base + c];
                    if !v.is_finite() { continue; }
                    if v < stats[c].min { stats[c].min = v; }
                    if v > stats[c].max { stats[c].max = v; }
                    stats[c].mean += v;
                    stats[c].sample_count += 1;
                    if v < -0.001 { stats[c].has_negative = true; }
                    if v > 1.5 { stats[c].is_hdr = true; }
                }
            }
            for c in 0..3 {
                if stats[c].sample_count > 0 {
                    stats[c].mean /= stats[c].sample_count as f32;
                }
            }
            stats
        } else {
            // No buffer available — fall back to keyword-based normal/position
            // by checking channel-component shape: XYZ in 3 channels is most
            // often Position, RGB in 3 channels is most often RGB.
            if xyz_count >= 3 {
                return "position".to_string();
            }
            return "rgb".to_string();
        };

        let stat_refs: Vec<&PassStats> = per_comp_stats.iter().collect();

        // Normal: unit-magnitude vectors with both polarities
        if has_unit_vectors(&stat_refs) {
            return "normal".to_string();
        }

        // HDR Lighting (RGB only, all non-negative, HDR values present)
        let all_non_neg = per_comp_stats.iter().all(|s| !s.has_negative);
        let any_hdr = per_comp_stats.iter().any(|s| s.is_hdr);
        if rgb_count >= 3 && all_non_neg && any_hdr {
            return "hdr".to_string();
        }

        // Position: large magnitude, mixed/negative polarity
        let max_abs = per_comp_stats.iter()
            .map(|s| s.min.abs().max(s.max.abs()))
            .fold(0.0f32, f32::max);
        if max_abs > 1.5 {
            return "position".to_string();
        }

        // Fallthrough for 3-vec data — treat as RGB (covers e.g. blurry HDR).
        if rgb_count >= 3 {
            return "rgb".to_string();
        }
        return "rgb".to_string();
    }

    // ---- 5. UV (2 channels) ------------------------------------------------
    if total == 2 && uv_count >= 2 {
        return "uv".to_string();
    }

    // ---- 6. Single channel — stats-based Depth vs Grayscale vs AO ---------
    if total == 1 {
        if let Some(rgba) = rgba_f32 {
            let s = compute_pass_stats(rgba, channel_names);

            // AO detection (file name + non-negative, mean in upper-middle):
            // Rnd__AO_0015.exr has channel y with values ~ 0.0..1.0.
            if contains(&kw_ctx, "ao") || contains(&kw_ctx, "occlusion")
                || contains(&kw_ctx, "rough") || contains(&kw_ctx, "metal")
                || contains(&kw_ctx, "matte") || contains(&kw_ctx, "specular")
            {
                return "ao".to_string();
            }
            // Depth keywords (file name)
            if contains(&kw_ctx, "depth") || contains(&kw_ctx, "zdepth")
                || file_stem.to_lowercase().contains("z_")
                || file_stem.to_lowercase().contains("_z.")
            {
                return "depth".to_string();
            }
            // Pure statistics fallback (mirrors Python):
            //   min >= -0.001 → not negative → likely surface mask / AO
            //   mean > 0.3 && max >= 0.95 → bright signal → grayscale (AO-like)
            //   otherwise → depth (typical for inverse-distance Z buffers)
            if s.min >= -0.001 {
                if s.mean > 0.3 && s.max >= 0.95 {
                    return "grayscale".to_string();
                }
                // Non-negative, low/mid mean → looks like an inverted depth
                // (Z near camera = high value). Treat as depth to get the
                // standard depth visualisation.
                return "depth".to_string();
            }
            // Negative values present → almost certainly a signed distance
            // or world-position Z, which is depth.
            return "depth".to_string();
        }
        // No pixel buffer available, fall back to filename heuristics.
        if contains(&kw_ctx, "ao") || contains(&kw_ctx, "occlusion") {
            return "ao".to_string();
        }
        if contains(&kw_ctx, "depth") || contains(&kw_ctx, "zdepth") {
            return "depth".to_string();
        }
        if contains(&kw_ctx, "rough") || contains(&kw_ctx, "metal")
            || contains(&kw_ctx, "matte") || contains(&kw_ctx, "specular") {
            return "ao".to_string();
        }
        return "grayscale".to_string();
    }

    // ---- 7. Default --------------------------------------------------------
    "rgb".to_string()
}

// ============================================================================
// OpenEXRCore Wrapper
// ============================================================================

pub struct OpenEXRCore {
    lib: Library,
}

static OPENEXR_CORE_CACHE: OnceCell<Arc<OpenEXRCore>> = OnceCell::new();

/// Simple allocation stats for EXR decode profiling.

static DECODE_ALLOC_COUNT: AtomicUsize = AtomicUsize::new(0);
static DECODE_BUFFER_SIZE_BYTES: AtomicUsize = AtomicUsize::new(0);

/// Reset allocation stats (call at start of sequence).
pub fn reset_decode_stats() {
    DECODE_ALLOC_COUNT.store(0, Ordering::Relaxed);
    DECODE_BUFFER_SIZE_BYTES.store(0, Ordering::Relaxed);
}

/// Record that `count` allocations of `total_bytes` were made for this decode.
fn record_alloc(count: usize, total_bytes: usize) {
    DECODE_ALLOC_COUNT.fetch_add(count, Ordering::Relaxed);
    DECODE_BUFFER_SIZE_BYTES.fetch_add(total_bytes, Ordering::Relaxed);
}

/// Get current allocation stats: (total_allocs, total_bytes_allocated).
pub fn get_decode_stats() -> (usize, usize) {
    (DECODE_ALLOC_COUNT.load(Ordering::Relaxed),
     DECODE_BUFFER_SIZE_BYTES.load(Ordering::Relaxed))
}

fn global_openexr_core() -> Result<Arc<OpenEXRCore>> {
    if let Some(c) = OPENEXR_CORE_CACHE.get() { return Ok(c.clone()); }
    let core = OpenEXRCore::load().map(Arc::new)?;
    // race-safe: another thread may have set it; prefer existing.
    let _ = OPENEXR_CORE_CACHE.set(core.clone());
    Ok(OPENEXR_CORE_CACHE.get().cloned().unwrap_or(core))
}

impl OpenEXRCore {
    pub fn load() -> Result<Self> {
        fn find_dll_dir() -> Option<std::path::PathBuf> {
            // DLLs ship under the bundled `bundle_dist/openexr/` directory.
            // Search order:
            //   1. {exe_dir}/openexr/             — NSIS install layout
            //   2. {exe_dir}/../openexr/          — NSIS `_internal/` flatten
            //   3. walk-up parents looking for `bundle_dist/openexr/` (dev mode)
            let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();

            let direct = exe_dir.join("openexr");
            if direct.join("OpenEXR-3_4.dll").exists() {
                return Some(direct);
            }
            if let Some(parent) = exe_dir.parent() {
                let sibling = parent.join("openexr");
                if sibling.join("OpenEXR-3_4.dll").exists() {
                    return Some(sibling);
                }
            }

            // Dev: walk up parents looking for `bundle_dist/openexr/`.
            let mut walker = exe_dir;
            for _ in 0..10 {
                let candidate = walker.join("bundle_dist").join("openexr");
                if candidate.join("OpenEXR-3_4.dll").exists() {
                    return Some(candidate);
                }
                if !walker.pop() {
                    break;
                }
            }

            None
        }

        let dll_dir = match find_dll_dir() {
            Some(p) => p,
            None => return Err(ExrError::LibraryLoad("Cannot find OpenEXR DLLs".to_string())),
        };

        println!("[OpenEXRCore] Using DLL dir: {:?}", dll_dir);

        unsafe {
            // The OpenEXR DLLs have transitive dependencies on other DLLs in
            // the same directory (zlib, stdlib runtime, etc.). LoadLibraryExW
            // only searches the PATH for those, so add `dll_dir` to PATH for
            // the duration of this process. Without this, IlmThread-3_4.dll
            // fails with `LoadLibraryExW failed` even though the file exists
            // at the expected path because Windows can't resolve its own
            // dependencies (notably when the host PATH doesn't include the
            // bundled openexr/ directory — e.g. dev runs that don't go
            // through NSIS or the post-build resource copy).
            //
            // `PATH` is per-process; modifying it only affects subsequent
            // LoadLibrary calls within this Rust binary.
            let path_env = dll_dir.as_os_str();
            // Prepend so it wins over any system PATH entries.
            let new_path = match std::env::var_os("PATH") {
                Some(existing) => {
                    let mut s = std::ffi::OsString::from(path_env);
                    s.push(";");
                    s.push(existing);
                    s
                }
                None => std::ffi::OsString::from(path_env),
            };
            #[allow(unused_unsafe)]
            unsafe {
                std::env::set_var("PATH", &new_path);
            }

            let load_lib = |name: &str| -> Result<Library> {
                let path = dll_dir.join(name);
                println!("[OpenEXRCore] Loading {}...", name);
                Library::new(&path)
                    .map_err(|e| ExrError::LibraryLoad(format!("Failed to load {}: {}", name, e)))
            };

            let _ilmthread = load_lib("IlmThread-3_4.dll")?;
            let _iex = load_lib("Iex-3_4.dll")?;
            let _imath = load_lib("Imath-3_2.dll")?;
            let _openexr = load_lib("OpenEXR-3_4.dll")?;
            let lib = load_lib("OpenEXRCore-3_4.dll")?;

            println!("[OpenEXRCore] All DLLs loaded successfully");
            Ok(OpenEXRCore { lib })
        }
    }

    pub fn start_read(&self, path: &Path) -> Result<ExrFileReader> {
        let cpath = match CString::new(path.to_string_lossy().into_owned()) {
            Ok(s) => s,
            Err(_) => return Err(ExrError::PathError),
        };

        unsafe {
            let func: Symbol<'_, ExrStartReadFn> = self.lib
                .get(b"exr_start_read")
                .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;

            let mut context: *mut ExrContext = std::ptr::null_mut();

            // 2026-07-13: Pass ExrContextInitializer with tuned performance settings.
            // Previously passed null (all defaults). Now we set:
            // - zip_level = 6 (maximum ZIP compression, also fastest deflate with libdeflate)
            // - dwa_quality = 45.0 (production-quality DWA, faster than max quality -1.0)
            // This is a conservative default; callers can tune per-file-type if needed.
            let mut init = ExrContextInitializer::default();
            init.size = std::mem::size_of::<ExrContextInitializer>();
            init.zip_level = 6;          // default -1 uses library default; 6 is explicit max
            init.dwa_quality = 45.0;     // 45.0 is production standard; -1.0 is max quality (slowest)

            check_result(func(&mut context, cpath.as_ptr(), &mut init))?;

            let mut count: i32 = 0;
            let count_func: Symbol<'_, ExrGetCountFn> = self.lib
                .get(b"exr_get_count")
                .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
            check_result(count_func(context, &mut count))?;

            println!("[OpenEXRCore] File has {} part(s)", count);

            Ok(ExrFileReader { context, lib: &self.lib, part_count: count })
        }
    }
}

pub struct ExrFileReader<'a> {
    context: *mut ExrContext,
    lib: &'a Library,
    part_count: i32,
}

impl<'a> ExrFileReader<'a> {
    pub fn get_first_part_info(&self) -> Result<ExrPartInfo> {
        if self.part_count < 1 {
            return Err(ExrError::InvalidFile);
        }
        self.get_part_info(0)
    }

    pub fn get_part_info(&self, part_index: i32) -> Result<ExrPartInfo> {
        unsafe {
            let mut storage_raw: i32 = 0;
            {
                let func: Symbol<'_, unsafe extern "C" fn(*const ExrContext, i32, *mut i32) -> i32> = self.lib
                    .get(b"exr_get_storage")
                    .map_err(|e| ExrError::LibraryLoad(format!("exr_get_storage: {}", e)))?;
                check_result(func(self.context, part_index, &mut storage_raw))?;
            }
            let storage = ExrStorage::from_c(storage_raw);

            let mut dw: ExrBox2i = ExrBox2i { min_x: 0, min_y: 0, max_x: 0, max_y: 0 };
            {
                let func: Symbol<'_, unsafe extern "C" fn(*const ExrContext, i32, *mut ExrBox2i) -> i32> = self.lib
                    .get(b"exr_get_data_window")
                    .map_err(|e| ExrError::LibraryLoad(format!("exr_get_data_window: {}", e)))?;
                check_result(func(self.context, part_index, &mut dw))?;
            }

            let mut dsw: ExrBox2i = ExrBox2i { min_x: 0, min_y: 0, max_x: 0, max_y: 0 };
            {
                let func: Symbol<'_, unsafe extern "C" fn(*const ExrContext, i32, *mut ExrBox2i) -> i32> = self.lib
                    .get(b"exr_get_display_window")
                    .map_err(|e| ExrError::LibraryLoad(format!("exr_get_display_window: {}", e)))?;
                check_result(func(self.context, part_index, &mut dsw))?;
            }

            let mut comp_raw: i32 = 0;
            {
                let func: Symbol<'_, unsafe extern "C" fn(*const ExrContext, i32, *mut i32) -> i32> = self.lib
                    .get(b"exr_get_compression")
                    .map_err(|e| ExrError::LibraryLoad(format!("exr_get_compression: {}", e)))?;
                check_result(func(self.context, part_index, &mut comp_raw))?;
            }
            let compression = ExrCompression::from_c(comp_raw);

            let mut lo_raw: i32 = 0;
            {
                let func: Symbol<'_, unsafe extern "C" fn(*const ExrContext, i32, *mut i32) -> i32> = self.lib
                    .get(b"exr_get_lineorder")
                    .map_err(|e| ExrError::LibraryLoad(format!("exr_get_lineorder: {}", e)))?;
                check_result(func(self.context, part_index, &mut lo_raw))?;
            }
            let line_order = ExrLineOrder::from_c(lo_raw);

            let mut aspect: f32 = 1.0;
            {
                let func: Symbol<'_, unsafe extern "C" fn(*const ExrContext, i32, *mut f32) -> i32> = self.lib
                    .get(b"exr_get_pixel_aspect_ratio")
                    .map_err(|e| ExrError::LibraryLoad(format!("exr_get_pixel_aspect_ratio: {}", e)))?;
                check_result(func(self.context, part_index, &mut aspect))?;
            }

            let mut swc: ExrV2f = ExrV2f { x: 0.0, y: 0.0 };
            {
                let func: Symbol<'_, unsafe extern "C" fn(*const ExrContext, i32, *mut ExrV2f) -> i32> = self.lib
                    .get(b"exr_get_screen_window_center")
                    .map_err(|e| ExrError::LibraryLoad(format!("exr_get_screen_window_center: {}", e)))?;
                check_result(func(self.context, part_index, &mut swc))?;
            }

            let mut sww: f32 = 1.0;
            {
                let func: Symbol<'_, unsafe extern "C" fn(*const ExrContext, i32, *mut f32) -> i32> = self.lib
                    .get(b"exr_get_screen_window_width")
                    .map_err(|e| ExrError::LibraryLoad(format!("exr_get_screen_window_width: {}", e)))?;
                check_result(func(self.context, part_index, &mut sww))?;
            }

            let mut chunk_count: i32 = 0;
            {
                let func: Symbol<'_, unsafe extern "C" fn(*const ExrContext, i32, *mut i32) -> i32> = self.lib
                    .get(b"exr_get_chunk_count")
                    .map_err(|e| ExrError::LibraryLoad(format!("exr_get_chunk_count: {}", e)))?;
                check_result(func(self.context, part_index, &mut chunk_count))?;
            }

            let mut spc: i32 = 1;
            {
                let func: Symbol<'_, unsafe extern "C" fn(*const ExrContext, i32, *mut i32) -> i32> = self.lib
                    .get(b"exr_get_scanlines_per_chunk")
                    .map_err(|e| ExrError::LibraryLoad(format!("exr_get_scanlines_per_chunk: {}", e)))?;
                check_result(func(self.context, part_index, &mut spc))?;
            }

            let mut ch_count: i32 = 0;
            {
                let func: Symbol<'_, unsafe extern "C" fn(*const ExrContext, i32, *mut *const ExrChannelList) -> i32> = self.lib
                    .get(b"exr_get_channels")
                    .map_err(|e| ExrError::LibraryLoad(format!("exr_get_channels: {}", e)))?;
                let mut chlist_ptr: *const ExrChannelList = std::ptr::null();
                check_result(func(self.context, part_index, &mut chlist_ptr))?;
                if !chlist_ptr.is_null() {
                    let chlist = &*(chlist_ptr as *const ExrAttrChlist);
                    ch_count = chlist.num_channels;
                }
            }

            let mut name_ptr: *const c_char = std::ptr::null();
            {
                let func: Symbol<'_, unsafe extern "C" fn(*const ExrContext, i32, *mut *const c_char) -> i32> = self.lib
                    .get(b"exr_get_name")
                    .map_err(|e| ExrError::LibraryLoad(format!("exr_get_name: {}", e)))?;
                let _ = func(self.context, part_index, &mut name_ptr);
            }

            let name = if name_ptr.is_null() {
                None
            } else {
                Some(std::ffi::CStr::from_ptr(name_ptr).to_string_lossy().into_owned())
            };

            println!("[OpenEXRCore] Part: {}x{}, compression: {:?}, chunks: {}",
                dw.width(), dw.height(), compression, chunk_count);

            Ok(ExrPartInfo {
                name, storage, data_window: dw, display_window: dsw,
                compression, line_order, pixel_aspect_ratio: aspect,
                screen_window_center: swc, screen_window_width: sww,
                chunk_count, scanlines_per_chunk: spc, channel_count: ch_count,
            })
        }
    }

    pub fn get_channel_names(&self, part_index: i32) -> Result<Vec<String>> {
        unsafe {
            let func: Symbol<'_, unsafe extern "C" fn(*const ExrContext, i32, *mut *const ExrChannelList) -> i32> = self.lib
                .get(b"exr_get_channels")
                .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;

            let mut chlist_ptr: *const ExrChannelList = std::ptr::null();
            check_result(func(self.context, part_index, &mut chlist_ptr))?;

            if chlist_ptr.is_null() {
                return Err(ExrError::NoChannels);
            }

            let chlist = &*(chlist_ptr as *const ExrAttrChlist);
            let count = chlist.num_channels;

            let mut names = Vec::new();
            if count > 0 && !chlist.entries.is_null() {
                for i in 0..count as isize {
                    let entry = &*chlist.entries.offset(i);
                    if let Some(name) = entry.name() {
                        names.push(name.to_string());
                    }
                }
            }

            Ok(names)
        }
    }

    /// 2026-07-12: Pixel-type-aware variant of `get_channel_names`.
    ///
    /// OpenEXRCore's `exr_get_channels` returns the raw `exr_attr_chlist_t`
    /// which carries per-channel `pixel_type` (UINT=0 / HALF=1 / FLOAT=2).
    /// The previous fast-metadata path threw that information away and
    /// hard-coded `"float"` for every file, so the JS side couldn't tell a
    /// 16-bit half-float HDRI from a 32-bit float scanline. That caused
    /// the `RawLinearCache` to allocate the wrong buffer size and the
    /// `_loadAndCacheBitmap` path to mis-interpret pixel bytes, which in
    /// turn surfaced as a React "Maximum update depth exceeded" loop on
    /// the next render (the player kept firing `displayFrame(0)` because
    /// the FFI result didn't match the cache-key shape).
    ///
    /// Returns `(name, pixel_type)` pairs in the order OpenEXRCore lists
    /// them. Empty Vec if the file declares zero channels.
    pub fn get_channel_pixel_types(
        &self,
        part_index: i32,
    ) -> Result<Vec<(String, ExrPixelType)>> {
        unsafe {
            let func: Symbol<'_, unsafe extern "C" fn(*const ExrContext, i32, *mut *const ExrChannelList) -> i32> = self.lib
                .get(b"exr_get_channels")
                .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;

            let mut chlist_ptr: *const ExrChannelList = std::ptr::null();
            check_result(func(self.context, part_index, &mut chlist_ptr))?;

            if chlist_ptr.is_null() {
                return Err(ExrError::NoChannels);
            }

            let chlist = &*(chlist_ptr as *const ExrAttrChlist);
            let count = chlist.num_channels;

            let mut out = Vec::with_capacity(count.max(0) as usize);
            if count > 0 && !chlist.entries.is_null() {
                for i in 0..count as isize {
                    let entry = &*chlist.entries.offset(i);
                    if let Some(name) = entry.name() {
                        // exr_pixel_type_t: UINT=0 HALF=1 FLOAT=2 (anything else = Unknown).
                        let pt = ExrPixelType::from_c(entry.pixel_type);
                        out.push((name.to_string(), pt));
                    }
                }
            }
            Ok(out)
        }
    }
}

impl<'a> Drop for ExrFileReader<'a> {
    fn drop(&mut self) {
        unsafe {
            if let Ok(func) = self.lib.get::<Symbol<'_, ExrFinishFn>>(b"exr_finish") {
                let mut ctxt = self.context;
                func(&mut ctxt);
            }
            println!("[OpenEXRCore] File closed");
        }
    }
}

// ============================================================================
// Pixel Conversion
// ============================================================================

fn half_to_float(bits: u16) -> f32 {
    let sign = (bits >> 15) & 0x1;
    let exp = (bits >> 10) & 0x1F;
    let mant = bits & 0x3FF;

    if exp == 0 {
        if mant == 0 { return 0.0; }
        return (mant as f32) / 1024.0 * (1.0 / 16384.0);
    } else if exp == 31 {
        if sign == 1 { return f32::NEG_INFINITY; }
        return f32::INFINITY;
    } else {
        let biased_exp = exp as i32 - 15;
        let m = mant as f32 / 1024.0;
        if sign == 1 {
            if biased_exp >= 0 { -(1.0 + m) * (1u32 << biased_exp) as f32 }
            else { -(1.0 + m) / (1u32 << (-biased_exp)) as f32 }
        } else {
            if biased_exp >= 0 { (1.0 + m) * (1u32 << biased_exp) as f32 }
            else { (1.0 + m) / (1u32 << (-biased_exp)) as f32 }
        }
    }
}

fn sample_to_u8(v: f32) -> u8 {
    let white_level = 1.0;
    let adjusted = v / white_level;
    (adjusted.max(0.0).min(1.0) * 255.0 + 0.5) as u8
}

// ============================================================================
// Decode Pipeline Helper
// ============================================================================

/// Decode a chunk using the full OpenEXRCore decode pipeline
/// Returns planar channel buffers: (name, width, height, bytes_per_element, data)
unsafe fn decode_chunk_with_pipeline(
    reader: &ExrFileReader,
    part_index: i32,
    chunk_idx: i32,
    image_width: usize,
    image_height: usize,
    storage: ExrStorage,
    scanlines_per_chunk: i32,
    data_window_min_y: i32,
) -> Result<Vec<(String, usize, usize, i32, Vec<u8>)>> {

    // Get chunk info - different functions for scanline vs tiled
    let mut chunk_info: ExrChunkInfo = std::mem::zeroed();
    read_chunk_info(reader, part_index, chunk_idx, storage, scanlines_per_chunk, data_window_min_y, &mut chunk_info)?;

    println!("[EXR-FFI] Chunk info: {}x{}, start_y={}", chunk_info.width, chunk_info.height, chunk_info.start_y);

    // Validation: check for invalid chunk dimensions
    if chunk_info.width <= 0 || chunk_info.height <= 0 {
        println!("[EXR-FFI] Invalid chunk dimensions: {}x{}", chunk_info.width, chunk_info.height);
        return Err(ExrError::InvalidFile);
    }

    // Initialize decode pipeline
    let init_func: Symbol<'_, ExrDecodingInitializeFn> = reader.lib
        .get(b"exr_decoding_initialize")
        .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;

    let mut pipeline: ExrDecodePipeline = ExrDecodePipeline::default();
    check_result(init_func(reader.context, part_index, &chunk_info, &mut pipeline))?;

    // Debug: print struct layout info using raw pointers to avoid alignment issues
    let pipeline_ptr = &pipeline as *const ExrDecodePipeline as *const u8;
    let pipe_size_val = unsafe { (pipeline_ptr as *const usize).read_unaligned() };
    let ch_count_val = unsafe { (pipeline_ptr.offset(16) as *const i16).read_unaligned() };
    let channels_ptr_val = unsafe { (pipeline_ptr.offset(8) as *const *mut ExrCodingChannelInfo).read_unaligned() };

    println!("[EXR-FFI] Pipeline struct size: {} bytes", std::mem::size_of::<ExrDecodePipeline>());
    println!("[EXR-FFI] Pipeline pipe_size: {}", pipe_size_val);
    println!("[EXR-FFI] Direct read: channel_count={}, channels={:p}", ch_count_val, channels_ptr_val);

    // Read channel count and pointer from pipeline struct using raw pointers
    let ch_count = unsafe { (pipeline_ptr.offset(16) as *const i16).read_unaligned() };
    let channels_ptr = unsafe { (pipeline_ptr.offset(8) as *const *mut ExrCodingChannelInfo).read_unaligned() };
    let ch_count = pipeline.channel_count;
    let channels_ptr = pipeline.channels;

    println!("[EXR-FFI] Pipeline has {} channels at {:p}", ch_count, channels_ptr);

    // Validate channel count - must be positive and reasonable
    if ch_count <= 0 || ch_count > 100 {
        println!("[EXR-FFI] Invalid channel_count: {} - struct layout mismatch?", ch_count);
        let destroy_func: Symbol<'_, ExrDecodingDestroyFn> = reader.lib
            .get(b"exr_decoding_destroy")
            .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
        let _ = destroy_func(reader.context, &mut pipeline);
        return Err(ExrError::PipelineError);
    }

    if channels_ptr.is_null() {
        println!("[EXR-FFI] channels pointer is NULL");
        let destroy_func: Symbol<'_, ExrDecodingDestroyFn> = reader.lib
            .get(b"exr_decoding_destroy")
            .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
        let _ = destroy_func(reader.context, &mut pipeline);
        return Err(ExrError::NoChannels);
    }

    // Collect channel info and allocate output buffers
    let mut channel_infos: Vec<(String, usize, usize, i32)> = Vec::new();
    let mut channel_buffers = Vec::new();

    // Debug: print channel info struct size and check array stride
    println!("[EXR-FFI] ExrCodingChannelInfo struct size: {} bytes", std::mem::size_of::<ExrCodingChannelInfo>());

    // Read the first few bytes of each channel to see pointer patterns
    for i in 0..ch_count as usize {
        let ch_ptr = channels_ptr.add(i);
        let ch_base = ch_ptr as *const u8;
        let ch_name_ptr = unsafe { (ch_base as *const *const c_char).read_unaligned() };
        println!("[EXR-FFI]   Ch{}: struct at {:p}, channel_name_ptr={:p}", i, ch_base, ch_name_ptr);

        let ch = &mut *ch_ptr;
        let ch_base = ch_ptr as *const u8;
        let all_bytes = unsafe { std::slice::from_raw_parts(ch_base, 56) };
        println!("[EXR-FFI]   Ch{} ALL bytes ({}): {:02x?}", i, all_bytes.len(), all_bytes);
        println!("[EXR-FFI]   Ch{} offsets 0-7:  {:02x?}", i, &all_bytes[0..8]);
        println!("[EXR-FFI]   Ch{} offsets 8-15: {:02x?}", i, &all_bytes[8..16]);
        println!("[EXR-FFI]   Ch{} offsets 16-23:{:02x?}", i, &all_bytes[16..24]);
        println!("[EXR-FFI]   Ch{} offsets 24-31:{:02x?}", i, &all_bytes[24..32]);
        println!("[EXR-FFI]   Ch{} offsets 32-39:{:02x?}", i, &all_bytes[32..40]);
        println!("[EXR-FFI]   Ch{} offsets 40-47:{:02x?}", i, &all_bytes[40..48]);

        let h = unsafe { (ch_base.add(8) as *const i32).read_unaligned() };
        let w = unsafe { (ch_base.add(12) as *const i32).read_unaligned() };
        println!("[EXR-FFI]   Ch{} potential height={}, width={}", i, h, w);

    let chunk_h = image_height;
    let chunk_w = image_width;
    let ch_h = chunk_h;
    let ch_w = chunk_w;
    let bpe = ch.bytes_per_element as i32;
    let pixel_type = ExrPixelType::from_c(ch.data_type as i32);

        println!("[EXR-FFI]   Ch{} struct fields: height={}, width={}, x_samples={}, y_samples={}, bpe={}, data_type={}",
            i, ch.height, ch.width, ch.x_samples, ch.y_samples, ch.bytes_per_element, ch.data_type);

        let name = if !ch.channel_name.is_null() {
            std::ffi::CStr::from_ptr(ch.channel_name)
                .to_string_lossy()
                .into_owned()
        } else {
            format!("ch{}", i)
        };

        println!("[EXR-FFI]   Channel {}: '{}', {}x{}, bpe={}, type={:?}",
            i, name, ch_w, ch_h, bpe, pixel_type);

        if ch_w == 0 || ch_h == 0 || bpe <= 0 {
            println!("[EXR-FFI]   Invalid channel dimensions: {}x{}, bpe={}", ch_w, ch_h, bpe);
            continue;
        }

        let buf_size = (ch_h as usize) * (ch_w as usize) * (bpe as usize);
        if buf_size > 100_000_000 {
            println!("[EXR-FFI]   Buffer size too large: {} bytes", buf_size);
            continue;
        }
        let mut buf = vec![0u8; buf_size.max(1)];

        ch.user_bytes_per_element = bpe as i16;
        ch.user_data_type = ch.data_type;
        ch.user_pixel_stride = bpe;
        ch.user_line_stride = ch_w as i32 * bpe;
        ch.decode_to_ptr = buf.as_mut_ptr();

        channel_infos.push((name.clone(), ch_w as usize, ch_h as usize, bpe));
        channel_buffers.push(buf);
    }

    // Choose default routines (this sets up unpack/convert functions)
    let choose_func: Symbol<'_, ExrDecodingChooseDefaultRoutinesFn> = reader.lib
        .get(b"exr_decoding_choose_default_routines")
        .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
    check_result(choose_func(reader.context, part_index, &mut pipeline))?;

    // Run decode (read -> decompress -> unpack -> convert)
    let run_func: Symbol<'_, ExrDecodingRunFn> = reader.lib
        .get(b"exr_decoding_run")
        .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
    check_result(run_func(reader.context, part_index, &mut pipeline))?;

    println!("[EXR-FFI] Decode complete!");

    // Verify some data was written
    let mut total_sum: u64 = 0;
    for buf in &channel_buffers {
        for &b in &buf[..buf.len().min(100)] {
            total_sum += b as u64;
        }
    }
    println!("[EXR-FFI] Channel buffer sums (first 100 bytes): {}", total_sum);

    // Cleanup (but NOT the channel buffers - those are ours now)
    let destroy_func: Symbol<'_, ExrDecodingDestroyFn> = reader.lib
        .get(b"exr_decoding_destroy")
        .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
    check_result(destroy_func(reader.context, &mut pipeline))?;

    // Build results
    let mut results = Vec::new();
    for (i, buf) in channel_buffers.into_iter().enumerate() {
        let (ref name, w, h, bpe) = channel_infos[i];
        results.push((name.clone(), w, h, bpe, buf));
    }

    Ok(results)
}

// ============================================================================
// Parallel chunk decoder
// ============================================================================
//
// Each worker opens its own `ExrFileReader` (own context) so chunks can be
// decoded concurrently. The OpenEXRCore library is not thread-safe across a
// single context, but multiple contexts against the same file work fine —
// each one independently reads + decompresses its assigned chunks.
//
// After all workers finish, the main thread copies each chunk's pixel data
// into the correct vertical slot of the shared buffer
// (offset = (chunk.start_y - data_window.min_y) * width * bpe), giving us a
// complete frame.
//
// This is dramatically faster than the single-pipeline sequential path:
// for a 32 MB DWAB file with 16 chunks × 43 channels, sequential decoding
// takes ~4.4s, parallel across 8 cores takes ~0.8s.

/// Decode a single chunk on the given (private) reader into compact per-channel
/// buffers sized to `chunk.height × channel.width × bpe` only (not the full
/// image height). Returns `(start_y, height, channel_buffers)` where each
/// `channel_buffers[i]` is `(name, bpe, width, bytes)`.
///
/// Used by the parallel chunk decoder. Identical FFI mechanics to
/// `decode_file_into_shared_buffers` for one chunk, but with no
/// cross-chunk pointer arithmetic.
unsafe fn decode_one_chunk(
    reader: &ExrFileReader,
    part_index: i32,
    chunk_idx: i32,
    storage: ExrStorage,
    scanlines_per_chunk: i32,
    data_window_min_y: i32,
    _num_layers: usize,
) -> Result<(i32, i32, Vec<(String, i32, usize, Vec<u8>)>)> {
    let mut chunk_info: ExrChunkInfo = std::mem::zeroed();
    read_chunk_info(reader, part_index, chunk_idx, storage, scanlines_per_chunk, data_window_min_y, &mut chunk_info)?;

    if chunk_info.width <= 0 || chunk_info.height <= 0 {
        return Err(ExrError::InvalidFile);
    }

    let init_func: Symbol<'_, ExrDecodingInitializeFn> = reader.lib
        .get(b"exr_decoding_initialize")
        .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
    let mut pipeline: ExrDecodePipeline = ExrDecodePipeline::default();
    check_result(init_func(reader.context, part_index, &chunk_info, &mut pipeline))?;

    let ch_count = pipeline.channel_count;
    let channels_ptr = pipeline.channels;

    if ch_count <= 0 || ch_count > 100 || channels_ptr.is_null() {
        let destroy_func: Symbol<'_, ExrDecodingDestroyFn> = reader.lib
            .get(b"exr_decoding_destroy")
            .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
        let _ = destroy_func(reader.context, &mut pipeline);
        return Err(ExrError::PipelineError);
    }

    // Collect per-channel (name, bpe, width, bytes). Buffer is sized to
    // just this chunk's rows, not the full image.
    let mut channel_buffers: Vec<(String, i32, usize, Vec<u8>)> = Vec::with_capacity(ch_count as usize);
    for i in 0..ch_count as usize {
        let ch = &*channels_ptr.add(i);
        let name = if !ch.channel_name.is_null() {
            std::ffi::CStr::from_ptr(ch.channel_name).to_string_lossy().into_owned()
        } else {
            format!("ch{}", i)
        };
        let bpe = ch.bytes_per_element.max(1) as i32;
        let ch_w = ch.width.max(1) as usize;
        let ch_h = chunk_info.height.max(1) as usize;
        let buf_size = ch_h * ch_w * bpe as usize;
        channel_buffers.push((name, bpe, ch_w, vec![0u8; buf_size.max(1)]));
    }
    // Debug: print first 4 channel names + widths so we can compare
    // against `channel_infos` order in the main thread. If they differ,
    // the merge will copy the wrong channel into each shared buffer.
    if chunk_idx == 0 {
        for (i, (n, _, w, _)) in channel_buffers.iter().enumerate().take(8) {
            eprintln!("[EXR-FFI] chunk0 channel[{}]: name='{}', width={}", i, n, w);
        }
    }

    // Set caller-populated fields (planar, one channel per buffer).
    // We need to keep `channel_buffers` intact until after `exr_decoding_run`
    // — pointer to `buf` is handed to C, so we set decode_to_ptr *without*
    // moving the buffer out.
    let ptr_addrs: Vec<(*mut u8, usize)> = channel_buffers
        .iter()
        .map(|(_, bpe, ch_w, buf)| (buf.as_ptr() as *mut u8, (*ch_w) * (*bpe as usize)))
        .collect();
    for i in 0..ch_count as usize {
        let ch = &mut *channels_ptr.add(i);
        let (ptr, line_stride) = ptr_addrs[i];
        ch.user_bytes_per_element = channel_buffers[i].1 as i16;
        ch.user_data_type = ch.data_type;
        ch.user_pixel_stride = channel_buffers[i].1;
        ch.user_line_stride = line_stride as i32;
        ch.decode_to_ptr = ptr;
    }

    let choose_func: Symbol<'_, ExrDecodingChooseDefaultRoutinesFn> = reader.lib
        .get(b"exr_decoding_choose_default_routines")
        .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
    check_result(choose_func(reader.context, part_index, &mut pipeline))?;

    let run_func: Symbol<'_, ExrDecodingRunFn> = reader.lib
        .get(b"exr_decoding_run")
        .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
    check_result(run_func(reader.context, part_index, &mut pipeline))?;

    let destroy_func: Symbol<'_, ExrDecodingDestroyFn> = reader.lib
        .get(b"exr_decoding_destroy")
        .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
    check_result(destroy_func(reader.context, &mut pipeline))?;

    Ok((chunk_info.start_y, chunk_info.height, channel_buffers))
}

/// Decode all chunks of an EXR file in parallel and merge into shared buffers.
///
/// Strategy:
/// - Allocate one full-frame buffer per channel (same as single-thread path).
/// - Partition `chunk_count` chunks across N worker threads (N = num_cpus).
/// - Each worker opens its own context (via OpenEXRCore::load + start_read),
///   decodes its assigned chunks into compact per-chunk buffers, returns them.
/// - Main thread copies each chunk's bytes into the right vertical slot of
///   the shared buffer.
///
/// `num_layers` controls the sacrificial-channel workaround:
///   - `num_layers <= 1`: skip the workaround (single-layer EXR → safe).
///   - `num_layers > 1`: apply the workaround (multi-layer EXR).
unsafe fn decode_chunks_parallel_into_shared_buffers(
    path: &Path,
    part_info: &ExrPartInfo,
    storage: ExrStorage,
    shared_buffers: &mut Vec<Vec<u8>>,
    num_layers: usize,
) -> Result<Vec<(String, usize, usize, i32)>> {
    eprintln!("[EXR-FFI] parallel_decode ENTER");
    use std::sync::Arc;
    let t_total = std::time::Instant::now();
    let t_setup = std::time::Instant::now();

    let chunk_count = part_info.chunk_count;
    let image_width = part_info.width().max(1) as usize;
    let image_height = part_info.height().max(1) as usize;
    let shared_height = image_height;
    let data_window_min_y = part_info.data_window.min_y;
    let scanlines_per_chunk = part_info.scanlines_per_chunk;
    let n_channels = shared_buffers.len();

    // Collect (name, ch_w, bpe) metadata by opening a temporary reader on the
    // main thread. We need this to map chunk channel indices → shared buffer
    // indices and to know per-channel width for the merge step.
    let core = global_openexr_core().map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
    let reader = core.start_read(path)?;
    let channel_names_main = reader.get_channel_names(0).unwrap_or_default();
    if channel_names_main.len() != n_channels {
        return Err(ExrError::PipelineError);
    }

    // Read channel metadata from a probe pipeline initialized against chunk 0.
    let mut probe_chunk: ExrChunkInfo = std::mem::zeroed();
    if chunk_count > 0 {
        read_chunk_info(&reader, 0, 0, storage, scanlines_per_chunk, data_window_min_y, &mut probe_chunk)?;
    }
    let init_func: Symbol<'_, ExrDecodingInitializeFn> = reader.lib
        .get(b"exr_decoding_initialize")
        .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
    let mut probe_pipeline: ExrDecodePipeline = ExrDecodePipeline::default();
    println!("[EXR-FFI] probe chunk info: {}x{}, start_y={}",
        probe_chunk.width, probe_chunk.height, probe_chunk.start_y);
    if chunk_count > 0 {
        check_result(init_func(reader.context, 0, &probe_chunk, &mut probe_pipeline))?;
    }

    // Build a name → channel info map from probe pipeline. We use the probe
    // to learn each channel's (width, bpe) since `get_channel_names(0)` only
    // gives us the names. The probe runs against chunk 0, so it sees only the
    // channels present in chunk 0 (typically a subset of multi-layer files).
    //
    // For multi-layer EXR files like the renderer output (e.g. 46 channels
    // distributed across 8 chunks), chunk 0 only contains ~8 channels and
    // probe can't see the rest. We assume per-channel width == image_width
    // and bpe == 2 for any channel the probe didn't observe (the Python
    // decode path explicitly filters to the requested layer's channels, so
    // this only matters for the FFI path which decodes everything).
    let mut probe_meta: std::collections::HashMap<String, (usize, i32)> = std::collections::HashMap::new();
    if chunk_count > 0 && probe_pipeline.channel_count > 0 && !probe_pipeline.channels.is_null() {
        for i in 0..probe_pipeline.channel_count as usize {
            let ch = &*probe_pipeline.channels.add(i);
            let name = if !ch.channel_name.is_null() {
                std::ffi::CStr::from_ptr(ch.channel_name).to_string_lossy().into_owned()
            } else {
                format!("ch{}", i)
            };
            let ch_w = ch.width.max(1) as usize;
            let bpe = ch.bytes_per_element.max(1) as i32;
            probe_meta.insert(name.clone(), (ch_w, bpe));

            // Debug: print first 8 channel names + widths from probe
            if i < 8 {
                println!("[EXR-FFI] probe channel[{}]: name='{}', width={}, bpe={}",
                    i, name, ch_w, bpe);
            }
        }

        // Tear down probe pipeline.
        if let Ok(destroy_sym) = reader.lib.get::<Symbol<'_, ExrDecodingDestroyFn>>(b"exr_decoding_destroy") {
            let _ = destroy_sym(reader.context, &mut probe_pipeline);
        }
    }

    // Build full channel_infos / channel_widths / channel_bpes vectors for
    // ALL channels reported by the file header (not just chunk 0).
    let mut channel_infos: Vec<(String, usize, usize, i32)> = Vec::with_capacity(n_channels);
    let mut channel_widths: Vec<usize> = Vec::with_capacity(n_channels);
    let mut channel_bpes: Vec<i32> = Vec::with_capacity(n_channels);
    // Map from channel name → shared buffer index, so the merge step can
    // route each chunk's per-channel bytes into the correct buffer.
    let mut name_to_idx: std::collections::HashMap<String, usize> = std::collections::HashMap::with_capacity(n_channels);

    for (i, name) in channel_names_main.iter().enumerate() {
        let (ch_w, bpe) = probe_meta.get(name).copied().unwrap_or((image_width, 2));
        channel_infos.push((name.clone(), image_width, image_height, bpe));
        channel_widths.push(ch_w);
        channel_bpes.push(bpe);
        name_to_idx.insert(name.clone(), i);

        // Make sure shared_buffers[i] is sized to hold the full image.
        let expected_size = image_height * ch_w * bpe as usize;
        if shared_buffers[i].len() < expected_size {
            shared_buffers[i].resize(expected_size, 0);
        }
    }

    // Partition chunks across workers. Each chunk is independent: each
    // worker opens its own context, decodes its chunks, returns bytes.
    // 2026-07-13: use shared thread count to match C++ bridge thread pool.
    // ------------------------------------------------------------------
    let path_str = path.to_string_lossy().into_owned();
    let chunk_indices: Vec<usize> = (0..chunk_count as usize).collect();
    let shared_threads = crate::openexr_ffi::get_openexr_thread_count();
    let num_workers = if shared_threads > 0 {
        shared_threads as usize
    } else {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
    }.min(chunk_indices.len().max(1));

    println!("[EXR-FFI] probe+metadata setup: {:.2?}", t_setup.elapsed());
    let t_workers = std::time::Instant::now();

    println!("[EXR-FFI] parallel decode: {} chunks across {} workers", chunk_count, num_workers);

    // Drop the main-thread reader before spawning workers — each worker
    // opens its own. (Library refcount keeps the DLL loaded.)
    drop(reader);

    // Each entry: (chunk_idx, start_y, height, Vec<(name, bpe, ch_w, bytes)>)
    let chunk_results: Vec<Result<(usize, i32, i32, Vec<(String, i32, usize, Vec<u8>)>)>> = chunk_indices
        .par_iter()
        .map(|&chunk_idx| {
            // Each worker reuses the global cached OpenEXRCore instance —
            // no per-chunk Library::load(), no DLL exhaustion.
            let local_core = match global_openexr_core() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[EXR-FFI] worker {} load failed: {:?}", chunk_idx, e);
                    return Err(ExrError::LibraryLoad(e.to_string()));
                }
            };
            let local_path = std::path::PathBuf::from(&path_str);
            let local_reader = match local_core.start_read(&local_path) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[EXR-FFI] worker {} start_read failed: {:?}", chunk_idx, e);
                    return Err(e);
                }
            };
            let (start_y, height, chans) = unsafe {
                decode_one_chunk(
                    &local_reader,
                    0,
                    chunk_idx as i32,
                    storage,
                    scanlines_per_chunk,
                    data_window_min_y,
                    num_layers,
                )
            }.map_err(|e| {
                eprintln!("[EXR-FFI] worker chunk {} decode_one_chunk FAILED: {:?}", chunk_idx, e);
                e
            })?;
            Ok((chunk_idx, start_y, height, chans))
        })
        .collect();

    println!("[EXR-FFI] parallel decode wall time: {:.2?}", t_workers.elapsed());

    // ------------------------------------------------------------------
    // Merge: copy each chunk's bytes into shared_buffers at the right row.
    // Channels within a chunk may be a SUBSET of the full file's channels
    // (multi-layer EXR files split channels across chunks). We resolve each
    // chunk channel's name against the full file channel list to find the
    // correct destination shared buffer index.
    //
    // IMPORTANT: a single chunk's failure must NOT abort the whole merge —
    // we'd lose every chunk decoded after it, which is exactly the
    // "black stripe down the image" symptom. Log + skip instead.
    // ------------------------------------------------------------------
    let mut merged_chunks = 0usize;
    let mut failed_chunks = 0usize;
    let mut first_err: Option<ExrError> = None;
    for r in chunk_results {
        let (chunk_idx, start_y, height, chunk_chans) = match r {
            Ok(v) => v,
            Err(e) => {
                if first_err.is_none() { first_err = Some(e.clone()); }
                failed_chunks += 1;
                eprintln!("[EXR-FFI]   merge skipped chunk {:?}: {:?}", chunk_idx_of_err(&e), e);
                continue;
            }
        };
        let raw_rows = height.max(0) as usize;
        let row_offset = (start_y - data_window_min_y).max(0) as usize;
        // Clamp height so the last chunk (whose reported height may be the
        // full scanlines_per_chunk even though it actually contains fewer
        // rows than that, with the tail being padding/uninitialised) does
        // not write past the end of the shared buffer. Without this clamp,
        // chunk N's trailing garbage rows overwrite chunk 0's data → black
        // stripes / corrupted stripes down the image.
        let rows = if row_offset < shared_height {
            (shared_height - row_offset).min(raw_rows)
        } else {
            0
        };
        eprintln!("[EXR-FFI]   merge chunk_idx={} start_y={} height={} row_offset={} rows_clamped={} (shared_height={})",
            chunk_idx, start_y, height, row_offset, rows, shared_height);
        for (name, bpe, ch_w, buf) in chunk_chans.into_iter() {
            // Look up the destination index by name. Channels in chunk but
            // not in the file header list (shouldn't happen, but defend
            // against malformed files) are silently skipped.
            let dst_idx = match name_to_idx.get(&name) {
                Some(&i) => i,
                None => {
                    eprintln!("[EXR-FFI]   merge skipped (unknown channel): chunk {} name='{}'",
                        chunk_idx, name);
                    continue;
                }
            };
            if dst_idx >= shared_buffers.len() { continue; }
            let shared_w = channel_widths[dst_idx];
            // The chunk buffer is densely packed at chunk rows × ch_w × bpe.
            // The shared buffer is sized to image_height × shared_w × bpe.
            // When ch_w == shared_w (full-resolution channels), we can copy
            // the whole row block contiguously. When ch_w < shared_w
            // (subsampled channels like chroma/alpha), the strides differ
            // and we must copy row-by-row.
            let row_bytes = ch_w * bpe as usize;
            let shared_row_bytes = shared_w * bpe as usize;
            let total_bytes_needed = rows * row_bytes;

            if row_bytes > buf.len() || total_bytes_needed > buf.len() {
                eprintln!("[EXR-FFI]   merge skipped (src): chunk {} ch '{}' dst_idx={} row_bytes={} buf_len={}",
                    chunk_idx, name, dst_idx, row_bytes, buf.len());
                continue;
            }

            if row_bytes == shared_row_bytes {
                // Same stride: copy the whole block in one go.
                let dst_base = row_offset * shared_row_bytes;
                if dst_base + total_bytes_needed <= shared_buffers[dst_idx].len() {
                    let src_ptr = buf.as_ptr();
                    let dst_ptr = unsafe { shared_buffers[dst_idx].as_mut_ptr().add(dst_base) };
                    unsafe { std::ptr::copy_nonoverlapping(src_ptr, dst_ptr, total_bytes_needed); }
                } else {
                    eprintln!("[EXR-FFI]   merge skipped (dst): chunk {} ch '{}' dst_idx={} dst_base={}+{} shared_len={}",
                        chunk_idx, name, dst_idx, dst_base, total_bytes_needed, shared_buffers[dst_idx].len());
                }
            } else {
                // Different strides: copy row-by-row so the gap between
                // rows in the source (none, packed) becomes the proper
                // gap in the destination (shared_w × bpe).
                let mut dst_row_offset = row_offset;
                let mut src_offset = 0usize;
                for _ in 0..rows {
                    let dst_base = dst_row_offset * shared_row_bytes;
                    if dst_base + row_bytes > shared_buffers[dst_idx].len() {
                        eprintln!("[EXR-FFI]   merge row overflow: chunk {} ch '{}' dst_idx={} row {} dst_base={} shared_len={}",
                            chunk_idx, name, dst_idx, dst_row_offset, dst_base, shared_buffers[dst_idx].len());
                        break;
                    }
                    shared_buffers[dst_idx][dst_base..dst_base + row_bytes]
                        .copy_from_slice(&buf[src_offset..src_offset + row_bytes]);
                    src_offset += row_bytes;
                    dst_row_offset += 1;
                }
            }
            merged_chunks += 1;
        }
    }
    if failed_chunks > 0 {
        eprintln!("[EXR-FFI] merge: {} chunks merged, {} chunks failed (skipped)",
            merged_chunks, failed_chunks);
    }
    if merged_chunks == 0 {
        // Nothing came back from any worker — bail out with the first
        // captured error so the caller still gets a meaningful message.
        return Err(first_err.unwrap_or_else(|| ExrError::DecodeError("no chunks decoded".into())));
    }
    eprintln!("[EXR-FFI] parallel_decode total: {:.2?}", t_total.elapsed());
    Ok(channel_infos)
}

/// Decode all chunks of an EXR file into PRE-ALLOCATED shared buffers
/// (one per channel). Each chunk writes into the correct vertical offset
/// of the shared buffer (based on `chunk_info.start_y` and the data window's
/// `min_y`), so that the result is the full-frame pixel data, not the
/// last-processed chunk overwriting everything else.
///
/// This is the correct multi-chunk FFI path. The previous per-chunk
/// `decode_chunk_with_pipeline` allocated a fresh `image_height` buffer per
/// chunk and pointed `decode_to_ptr` at offset 0, so each new chunk
/// overwrote the previous one's data — only the last chunk's pixels
/// survived, and only in the top portion of the buffer.
///
/// Returns the list of (channel_name, width, height, bytes_per_element)
/// metadata describing the shared buffers.
///
/// `num_layers` controls the sacrificial-channel workaround:
///   - `num_layers <= 1` (single-layer EXR): the bug does not trigger —
///     the optimised 4-channel path is safe because all channels belong
///     to the same layer. We skip the workaround entirely.
///   - `num_layers > 1` (multi-layer EXR): the workaround is required.
unsafe fn decode_file_into_shared_buffers(
    reader: &ExrFileReader,
    part_index: i32,
    part_info: &ExrPartInfo,
    storage: ExrStorage,
    shared_buffers: &mut Vec<Vec<u8>>,
    num_layers: usize,
) -> Result<Vec<(String, usize, usize, i32)>> {
    let t_phase_alloc = std::time::Instant::now();
    let chunk_count = part_info.chunk_count;
    let image_width = part_info.width().max(1) as usize;
    let image_height = part_info.height().max(1) as usize;
    let data_window_min_y = part_info.data_window.min_y;

    let t_setup_start = std::time::Instant::now();
    println!("[EXR-FFI] decode_file_into_shared_buffers: {} chunks, {}x{}, min_y={}",
        chunk_count, image_width, image_height, data_window_min_y);

    let t_after_basic_setup = std::time::Instant::now();

    if shared_buffers.is_empty() {
        return Err(ExrError::NoChannels);
    }

    // ------------------------------------------------------------------
    // 1. Read chunk 0 info and initialize the pipeline ONCE.
    //    `exr_decoding_initialize` populates `channels[]` and the
    //    channel-count field; subsequent chunks use `exr_decoding_update`
    //    to swap chunk metadata without re-allocating buffers.
    // ------------------------------------------------------------------
    let mut chunk_info: ExrChunkInfo = std::mem::zeroed();
    let scanlines_per_chunk = part_info.scanlines_per_chunk;
    read_chunk_info(reader, part_index, 0, storage, scanlines_per_chunk, data_window_min_y, &mut chunk_info)?;

    let init_func: Symbol<'_, ExrDecodingInitializeFn> = reader.lib
        .get(b"exr_decoding_initialize")
        .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;

    let mut pipeline: ExrDecodePipeline = ExrDecodePipeline::default();
    check_result(init_func(reader.context, part_index, &chunk_info, &mut pipeline))?;

    // Read back channel info from the pipeline. `channels_ptr` points to a
    // library-owned array we must treat as borrowed — we'll write to its
    // caller-populated fields but never free it (the destroy call handles
    // that).
    let ch_count = pipeline.channel_count;
    let channels_ptr = pipeline.channels;

    println!("[EXR-FFI] Pipeline has {} channels at {:p}", ch_count, channels_ptr);

    if ch_count <= 0 || ch_count > 100 {
        println!("[EXR-FFI] Invalid channel_count: {} - struct layout mismatch?", ch_count);
        let destroy_func: Symbol<'_, ExrDecodingDestroyFn> = reader.lib
            .get(b"exr_decoding_destroy")
            .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
        let _ = destroy_func(reader.context, &mut pipeline);
        return Err(ExrError::PipelineError);
    }

    if channels_ptr.is_null() {
        let destroy_func: Symbol<'_, ExrDecodingDestroyFn> = reader.lib
            .get(b"exr_decoding_destroy")
            .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
        let _ = destroy_func(reader.context, &mut pipeline);
        return Err(ExrError::NoChannels);
    }

    // Collect per-channel metadata (name, width, height, bpe). The width
    // here is the *image* width; for subsampled channels the library sets
    // `channel.width` to the subsampled width, which is what we want for
    // byte indexing within the shared buffer.
    let mut channel_infos: Vec<(String, usize, usize, i32)> = Vec::with_capacity(ch_count as usize);
    let mut channel_widths: Vec<usize> = Vec::with_capacity(ch_count as usize);
    let mut channel_bpes: Vec<i32> = Vec::with_capacity(ch_count as usize);

    for i in 0..ch_count as usize {
        let ch = &*channels_ptr.add(i);
        let name = if !ch.channel_name.is_null() {
            std::ffi::CStr::from_ptr(ch.channel_name)
                .to_string_lossy()
                .into_owned()
        } else {
            format!("ch{}", i)
        };
        // ch.width / ch.height are the dimensions of this channel in the
        // *current chunk* (256×2000 for DWAB), not the full image. We
        // return the *image* dimensions so callers can compute the full
        // buffer size for `build_raw_rgba` to consume. Per-channel
        // subsampling is still handled correctly because we use the
        // per-channel width for byte indexing inside each shared buffer.
        let ch_w = ch.width.max(1) as usize;
        let bpe = ch.bytes_per_element.max(1) as i32;

        channel_infos.push((name, image_width, image_height, bpe));
        channel_widths.push(ch_w);
        channel_bpes.push(bpe);

        // Skip resize entirely for channels the layer filter excluded —
        // they have an empty Vec and the library will skip them too.
        // Without this early-return, `resize(expected, 0)` would
        // zero-fill 16 MB per skipped channel, which on a 40-channel
        // file was costing ~1.5 s of pure memset work.
        //
        // IMPORTANT: check `is_empty()` is true (length 0, capacity 0)
        // before skipping — kept channels start as `with_capacity(N)`
        // which has length 0 but capacity > 0, and we must resize those.
        if shared_buffers[i].capacity() == 0 {
            continue;
        }

        // Size the shared buffer for the full image (height × channel_width × bpe)
        // so each chunk can be placed at its `start_y` offset.  When the
        // caller pre-allocated with `Vec::with_capacity` (the fast path),
        // we grow the buffer to the exact size using `set_len` instead of
        // `resize` — `resize` would zero-fill the new bytes, which costs
        // ~50–80 ms per 16 MB on a 4K frame.  Skipping the zero-fill is
        // safe because every byte of `shared_buffers` we later consume
        // in `build_raw_rgba` comes from a chunk written by
        // `exr_decoding_run` (chunks cover the full image_height).
        let expected_size = image_height * ch_w * bpe as usize;
        if shared_buffers[i].capacity() < expected_size {
            // Caller didn't reserve enough; allocate+zero-fill (unavoidable).
            shared_buffers[i].resize(expected_size, 0);
        } else if shared_buffers[i].len() < expected_size {
            unsafe { shared_buffers[i].set_len(expected_size); }
        } else if shared_buffers[i].len() > expected_size {
            shared_buffers[i].truncate(expected_size);
        }
    }

    // ------------------------------------------------------------------
    // 2. Set caller-populated fields once. We use PLANAR layout
    //    (one channel per buffer), so:
    //      user_pixel_stride = bpe
    //      user_line_stride  = channel_width * bpe
    //    Each chunk writes `chunk.height` rows starting at the row offset
    //    we compute from `chunk_info.start_y - data_window.min_y`.
    // ------------------------------------------------------------------
    for i in 0..ch_count as usize {
        let ch = &mut *channels_ptr.add(i);
        let bpe = channel_bpes[i];
        let ch_w = channel_widths[i];
        ch.user_bytes_per_element = bpe as i16;
        ch.user_data_type = ch.data_type;
        ch.user_pixel_stride = bpe;
        ch.user_line_stride = (ch_w as i32) * bpe;
        // decode_to_ptr is set PER CHUNK below (depends on chunk row range).
        ch.decode_to_ptr = std::ptr::null_mut();
    }

    // ------------------------------------------------------------------
    // 3. WORKAROUND for OpenEXRCore 3.4 bug in `internal_exr_match_decode`:
    //
    //    The optimised half<->float routines (e.g. unpack_half_to_float_4chan_planar)
    //    get selected when `channel_count == 4 && sametype == HALF && sameouttype == FLOAT`.
    //    For single-layer EXRs (Beauty.R/G/B/A, no other channels) this path is
    //    safe and fast. For multi-layer files (Beauty.R/G/B + Crypto* + Z-depth* ...)
    //    it writes past the per-chunk buffer bounds and can corrupt memory
    //    (issue AcademySoftwareFoundation/openexr#1991).
    //
    //    We only apply the workaround when `num_layers > 1` (multi-layer files).
    //    For single-layer EXRs we skip the workaround entirely and let the
    //    optimised 4-channel path run — it is safe in that case and is 2-3×
    //    faster than the generic unpack path.
    //
    //    We force the generic path by marking one non-essential channel's
    //    `decode_to_ptr = NULL`. The library treats NULL as "skip this channel",
    //    so `chanstofill` becomes `channel_count - 1` and the optimised path
    //    is rejected in favour of `generic_unpack_to_planar`.
    // ------------------------------------------------------------------
    let sacrificial_idx: Option<usize> = {
        let need_workaround = num_layers > 1;
        if !need_workaround {
            eprintln!("[EXR-FFI] single-layer EXR: skipping sacrificial workaround (num_layers={}, ch_count={})",
                num_layers, ch_count);
            None
        } else {
        // Multi-layer: pick a non-RGB channel to sacrifice so the optimised
        // never reads (Z-depth, Crypto*, Emitters, etc.).
        let mut idx: Option<usize> = None;
        for i in 0..ch_count as usize {
            let ch_ptr = channels_ptr.add(i);
            let name_ptr = unsafe { (*ch_ptr).channel_name };
            let name = if !name_ptr.is_null() {
                unsafe { std::ffi::CStr::from_ptr(name_ptr).to_str().unwrap_or("") }
            } else { "" };
            let upper = name.to_uppercase();
            let is_rgb_or_a = upper == "R" || upper == "G" || upper == "B" || upper == "A"
                || upper == "RED" || upper == "GREEN" || upper == "BLUE"
                || upper.ends_with(".R") || upper.ends_with(".G")
                || upper.ends_with(".B") || upper.ends_with(".A");
            if !is_rgb_or_a {
                idx = Some(i);
                break;
            }
        }

        // If the file has ≥5 channels but is purely RGB+A (no sacrifice candidate),
        // sacrifice the LAST channel — build_raw_rgba picks the first match so
        // the last R/G/B/A will still be found among the first 3.
        let result_idx = idx.or(Some((ch_count as usize).saturating_sub(1)));
        if let Some(sidx) = result_idx {
            let ch_name_ptr = unsafe { (*channels_ptr.add(sidx)).channel_name };
            let ch_name = if !ch_name_ptr.is_null() {
                unsafe { std::ffi::CStr::from_ptr(ch_name_ptr).to_str().unwrap_or("?") }
            } else { "?" };
            eprintln!("[EXR-FFI] multi-layer (num_layers={}): sacrificial ch[{}] '{}' (forces generic unpack)",
                num_layers, sidx, ch_name);
        }
        result_idx
        }
    };

    // ------------------------------------------------------------------
    // 4. Choose default unpack/convert routines ONCE for the whole file.
    //    This inspects our caller-populated fields (pixel/line stride,
    //    data type) and wires up the appropriate unpack function. Because
    //    one channel has decode_to_ptr == NULL for every chunk (sacrificial),
    //    `internal_exr_match_decode` is forced to the generic unpack path.
    // ------------------------------------------------------------------
    let choose_func: Symbol<'_, ExrDecodingChooseDefaultRoutinesFn> = reader.lib
        .get(b"exr_decoding_choose_default_routines")
        .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
    let t_choose_start = std::time::Instant::now();
    check_result(choose_func(reader.context, part_index, &mut pipeline))?;
    eprintln!("[EXR-FFI] choose_default_routines: {:.2?}", t_choose_start.elapsed());

    // ------------------------------------------------------------------
    // 4. Decode every chunk. For each chunk:
    //    a) read its chunk_info (gives start_y, height, width)
    //    b) call exr_decoding_update so the pipeline knows the new chunk
    //    c) set decode_to_ptr to the right offset in each shared buffer
    //    d) call exr_decoding_run to actually write the pixel data
    //
    //    Important: `chunk_info.start_y` is in *file* coordinates (relative
    //    to data_window.min_y). For both INCREASING_Y and DECREASING_Y
    //    files, the library still returns the correct absolute start_y per
    //    chunk — we just need to subtract `data_window.min_y` to get a
    //    zero-based row index into our full-frame buffer.
    // ------------------------------------------------------------------
    let update_func: Symbol<'_, ExrDecodingUpdateFn> = reader.lib
        .get(b"exr_decoding_update")
        .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
    let run_func: Symbol<'_, ExrDecodingRunFn> = reader.lib
        .get(b"exr_decoding_run")
        .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;

    // Pre-compute per-channel constants to avoid redundant field writes inside
    // the per-chunk loop (which runs N times per file, N = chunk_count).
    // `user_pixel_stride` and `user_bytes_per_element` are always constant
    // per channel across all chunks. `user_line_stride` only depends on
    // channel width, which is also constant for scanline-based EXRs.
    let pixel_strides: Vec<i32> = channel_bpes.iter().map(|&bpe| bpe).collect();
    let line_strides: Vec<i32> = channel_widths.iter().zip(channel_bpes.iter())
        .map(|(&w, &bpe)| (w as i32) * bpe).collect();
    // Pre-compute which channels have a non-empty shared buffer (kept channels).
    // Used in the per-chunk loop to skip NULL writes for filtered channels.
    let kept_channels: Vec<bool> = (0..ch_count as usize)
        .map(|i| shared_buffers.get(i).map(|b| b.capacity() > 0).unwrap_or(false))
        .collect();
    let kept_count = kept_channels.iter().filter(|&&k| k).count();
    eprintln!("[EXR-FFI] kept {} / {} channels across all chunks (sacrificial may be NULL)",
        kept_count, ch_count);

    // Phase 5A early-return: if the layer filter selected zero channels
    // (e.g. user picked a layer name that doesn't exist in this file), bail
    // before touching `exr_decoding_run` at all. The library still has to
    // inflate every channel's compressed data on every chunk (the chunk
    // loop is the dominant cost ~400-500ms for a 1920x1920 8-chunk file),
    // and there's no point doing that work when the result is going to be
    // discarded. Return an empty shared_buffers array and let the caller
    // fall back to its "all-grey placeholder" path.
    if kept_count == 0 {
        eprintln!("[EXR-FFI] Phase 5A early-return: 0 kept channels, skipping all {} chunks",
            chunk_count);
        exr_log_phase("5A", &format!("early-return 0 kept channels — skipped {} chunks", chunk_count));
        // Free the pipeline context and let the caller's build_raw_rgba
        // produce an empty frame. We still need to close the context cleanly.
        let destroy_func: Symbol<'_, ExrDecodingDestroyFn> = reader.lib
            .get(b"exr_decoding_destroy")
            .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
        check_result(destroy_func(reader.context, &mut pipeline))?;
        return Ok(channel_infos);
    }

    // Per-chunk timing so we can attribute the slow part of the decode
    // (DWAB inflate, generic unpack, or per-chunk setup overhead).
    let mut t_total_run = std::time::Duration::ZERO;
    let mut t_total_update = std::time::Duration::ZERO;
    let mut t_total_setup = std::time::Duration::ZERO;

    // A4: hoist debug_dump_enabled out of the hot loop. eprintln/println has
    // per-call mutex cost (~5-10µs each); checking once outside is free.
    let debug_dump_enabled_outer = std::env::var("RUST_EXR_DEBUG_DUMP").map(|v| v == "1").unwrap_or(false);

    for chunk_idx in 0..chunk_count {
        let t_chunk_start = std::time::Instant::now();
        read_chunk_info(reader, part_index, chunk_idx, storage, scanlines_per_chunk, data_window_min_y, &mut chunk_info)?;

        if chunk_info.width <= 0 || chunk_info.height <= 0 {
            println!("[EXR-FFI]   chunk {} invalid dims {}x{}, skipping",
                chunk_idx, chunk_info.width, chunk_info.height);
            continue;
        }

        let t_pre_update = std::time::Instant::now();
        check_result(update_func(reader.context, part_index, &chunk_info, &mut pipeline))?;
        let update_dur = t_pre_update.elapsed();
        t_total_update += update_dur;

        let row_offset = (chunk_info.start_y - data_window_min_y).max(0) as usize;
        if chunk_idx < 2 {
            println!("[EXR-FFI]   chunk {}: start_y={}, height={}, row_offset={}",
                chunk_idx, chunk_info.start_y, chunk_info.height, row_offset);
        }

        // Set per-channel pointers into shared buffers. We ONLY touch kept channels
        // (those with non-empty shared buffers). For filtered channels (empty buffers)
        // and the sacrificial channel (forces generic unpack path), we leave
        // decode_to_ptr = NULL and skip all other writes.
        //
        // A4 fast-path: if we ran this exact chunk shape before, the byte_offset
        // is the same (scanline-based EXRs have constant chunk_size). We still
        // need to write the pointer for kept channels because the library may
        // re-read it on `update`, but we can skip the verbose debug print
        // (which dominated setup time on large files: ~0.3ms × 8 channels × 8
        // chunks × N debug-iters = 20+ms of eprintln cost on release builds).
        for i in 0..ch_count as usize {
            // Skip non-kept channels (filtered by layer + sacrificial).
            if !kept_channels[i] {
                let ch = &mut *channels_ptr.add(i);
                ch.decode_to_ptr = std::ptr::null_mut();
                continue;
            }
            let ch = &mut *channels_ptr.add(i);
            let ch_w = channel_widths[i];
            let bpe = channel_bpes[i];
            let byte_offset = row_offset * ch_w * bpe as usize;
            let base = shared_buffers[i].as_mut_ptr();
            ch.decode_to_ptr = unsafe { base.add(byte_offset) };
            // Only refresh user_line_stride per chunk (may differ per chunk if
            // chunk widths vary, though this is rare for scanline EXRs).
            // user_pixel_stride and user_bytes_per_element are constant — set once.
            ch.user_line_stride = line_strides[i];
            // A4: removed verbose per-chunk debug print (was 0.3ms×8ch×8chunks = 20ms per file).
            // The original print was: "chunk{} ch[{}] '{}': ch_w={}, bpe={}, byte_offset={}, line_stride={}, dst_buf_len={}"
            // Kept the first 2 chunks' first-2-channel info as a one-shot summary below.
            if chunk_idx == 0 && i < 2 {
                let ch_name = if !ch.channel_name.is_null() {
                    std::ffi::CStr::from_ptr(ch.channel_name).to_str().unwrap_or("?")
                } else { "?" };
                eprintln!("[EXR-FFI]   ch[{}] '{}': ch_w={}, bpe={}, line_stride={}, dst_buf_len={}",
                    i, ch_name, ch_w, bpe, ch.user_line_stride, shared_buffers[i].len());
            }
        }

        let t_pre_run = std::time::Instant::now();
        check_result(run_func(reader.context, part_index, &mut pipeline))?;
        let run_dur = t_pre_run.elapsed();
        t_total_run += run_dur;
        // Chunk total = everything from chunk start through run completion.
        // setup_only = total - update_dur - run_dur (saturating_sub guards
        // against tiny clock skew).
        let chunk_total = t_chunk_start.elapsed();
        let setup_now = chunk_total.saturating_sub(update_dur).saturating_sub(run_dur);
        t_total_setup += setup_now;
        if chunk_idx < 3 || chunk_idx + 1 == chunk_count {
            println!("[EXR-FFI]   chunk {}: total={:.2?} update={:.2?} run={:.2?} setup={:.2?}",
                chunk_idx, chunk_total, update_dur, run_dur, setup_now);
        }

        // DEBUG (opt-in via RUST_EXR_DEBUG_DUMP=1): verify chunk 0 actually wrote data into shared_buffers
        // A4: gated behind env var so release builds skip the entire 4KB-dump loop.
        // The `if debug_dump_enabled_outer` check is fine but the body was 0.5-1ms per chunk
        // even when disabled (cloning, slicing). Moved inside a single check.
        if debug_dump_enabled_outer {
            // Original verbose dump: 4KB+ of eprintln per chunk for 8 channels. Only do chunk 0.
            if chunk_idx == 0 {
                for i in 0..ch_count as usize {
                    if i >= 8 { break; }
                    let ch_w = channel_widths[i];
                    let bpe = channel_bpes[i];
                // Dump first 64 bytes of row_offset=0 row and row_offset=row_height/2
                let rows_total = chunk_info.height as usize;
                let row0_off = 0;
                let row_mid = rows_total / 2;
                let row_mid_off = row_mid * ch_w * bpe as usize;
                let row_last_off = (rows_total - 1) * ch_w * bpe as usize;
                let dump_len = (ch_w * bpe as usize).min(32);
                let head0: Vec<u8> = shared_buffers[i].iter().skip(row0_off).take(dump_len).cloned().collect();
                let head_mid: Vec<u8> = shared_buffers[i].iter().skip(row_mid_off).take(dump_len).cloned().collect();
                let head_last: Vec<u8> = shared_buffers[i].iter().skip(row_last_off).take(dump_len).cloned().collect();
                let nz0 = head0.iter().filter(|&&b| b != 0).count();
                let nzm = head_mid.iter().filter(|&&b| b != 0).count();
                let nzl = head_last.iter().filter(|&&b| b != 0).count();
                let ch_name_ptr = unsafe { (*channels_ptr.add(i)).channel_name };
                let ch_name = if !ch_name_ptr.is_null() {
                    unsafe { std::ffi::CStr::from_ptr(ch_name_ptr).to_str().unwrap_or("?").to_string() }
                } else { format!("ch{}", i) };
                println!("[EXR-FFI]   AFTER chunk{}: shared_buf[{}] '{}': row0[0..32] nz={}/{} row{}[0..32] nz={}/{} row_last[0..32] nz={}/{}",
                    chunk_idx, i, ch_name, nz0, dump_len, row_mid, nzm, dump_len, nzl, dump_len);
                }
            }
        }
    }

    // Per-chunk timing summary. Helps localise DWAB-decode cost vs
    // per-chunk setup overhead when debugging slow EXR loads.
    let total = t_total_run + t_total_update + t_total_setup;
    eprintln!("[EXR-FFI] inner timing: run={:.2?} update={:.2?} setup={:.2?} total={:.2?} (across {} chunks)",
        t_total_run, t_total_update, t_total_setup, total, chunk_count);
    eprintln!("[EXR-FFI] phase: since fn start = {:.2?} (per-chunk loop is {:.0}% of fn)",
        t_setup_start.elapsed(),
        if t_setup_start.elapsed().as_micros() > 0 {
            total.as_micros() as f64 / t_setup_start.elapsed().as_micros() as f64 * 100.0
        } else { 0.0 });
    eprintln!("[EXR-FFI] phase: since basic setup = {:.2?} (pre-loop overhead)",
        t_after_basic_setup.elapsed());

    // Phase 5A: Profile filtered-channel inflate overhead.
    //
    // When a multi-layer EXR (e.g. 46 channels) is decoded with a layer filter
    // (e.g. "Beauty"), we keep only ~3 channels but OpenEXRCore still inflates
    // ALL 46 channels' compressed data. For DWAB files, inflate is the dominant
    // cost (~80-90% of decode time). This profiling quantifies the overhead:
    //
    //   - `skipped_channels = n_channels - kept_count`
    //   - If skipped_channels > 10, inflate waste is significant
    //   - `inflate_estimate` = total * (skipped_channels / n_channels)
    //
    // If the estimate shows > 20% of time is wasted on filtered channels,
    // Phase 5B (pre-create subset EXR files) is justified.
    //
    // Compute kept_count from shared_buffers (non-empty = kept channels).
    let kept_count = shared_buffers.iter().filter(|b| b.capacity() > 0).count();
    let skipped_channels = (ch_count as usize).saturating_sub(kept_count);
    if skipped_channels > 0 {
        let total_channels = ch_count as usize;
        let wasted_pct = if total_channels > 0 {
            (skipped_channels as f64 / total_channels as f64) * 100.0
        } else { 0.0 };
        let inflate_estimate = total.as_secs_f64() * wasted_pct / 100.0;
        eprintln!("[EXR-FFI] Phase 5A profile: kept={}/{} channels, skipped={} ({:.0}% of file) — inflate waste estimate: {:.2}s of {:.2}s",
            kept_count, total_channels, skipped_channels, wasted_pct, inflate_estimate, total.as_secs_f64());
        exr_log_phase("5A", &format!("kept={}/{} skipped={} wasted_pct={:.0}% inflate_estimate={:.2}s of {:.2}s",
            kept_count, total_channels, skipped_channels, wasted_pct, inflate_estimate, total.as_secs_f64()));
        if wasted_pct > 50.0 {
            eprintln!("[EXR-FFI] Phase 5A: WARNING >50% of channels filtered — Phase 5B (subset EXR) strongly recommended");
            exr_log("[PHASE-5A-RECOMMEND] Phase 5B (subset EXR) strongly recommended");
        } else if wasted_pct > 20.0 {
            eprintln!("[EXR-FFI] Phase 5A: NOTE {:.0}% channels filtered — Phase 5B may help for large multi-layer files", wasted_pct);
            exr_log(&format!("[PHASE-5A-RECOMMEND] {:.0}% filtered — Phase 5B may help", wasted_pct));
        } else {
            eprintln!("[EXR-FFI] Phase 5A: filtered overhead is low ({:.0}%) — Phase 5B not needed for this file", wasted_pct);
            exr_log(&format!("[PHASE-5A-RECOMMEND] {:.0}% filtered — Phase 5B not needed", wasted_pct));
        }
    } else {
        eprintln!("[EXR-FFI] Phase 5A: no filtered channels (kept all {} channels) — inflate overhead = 0", ch_count);
        exr_log_phase("5A", &format!("no filtered channels — kept all {} — inflate overhead = 0", ch_count));
    }

    // ------------------------------------------------------------------
    // 5. Tear down the pipeline once at the end.
    //    We deliberately do NOT free `shared_buffers` — those are returned
    //    to the caller to be consumed by `build_raw_rgba`.
    // ------------------------------------------------------------------
    let destroy_func: Symbol<'_, ExrDecodingDestroyFn> = reader.lib
        .get(b"exr_decoding_destroy")
        .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
    check_result(destroy_func(reader.context, &mut pipeline))?;

    // DEBUG: dump Beauty.A/B/G/R raw to disk for diff against Python OpenEXR.
    // Offsets/strides here match what `build_raw_rgba` consumes:
    //   per-channel offset = y * ch_w * bpe
    //   bytes_per_element  = bpe (HALF=2, FLOAT=4)
    // Set RUST_EXR_DEBUG_DUMP=1 to enable.
    let debug_dump_enabled = std::env::var("RUST_EXR_DEBUG_DUMP").map(|v| v == "1").unwrap_or(false);
    let debug_dump_dir = std::path::Path::new(r"C:\tmp");
    if debug_dump_enabled && debug_dump_dir.exists() {
        for i in 0..channel_infos.len() {
            let (ref nm, ch_w, _ch_h, bpe) = channel_infos[i];
            let nm_upper = nm.to_uppercase();
            let is_target = nm_upper.ends_with(".A") || nm_upper.ends_with(".B")
                || nm_upper.ends_with(".G") || nm_upper.ends_with(".R")
                || nm_upper == "A" || nm_upper == "B" || nm_upper == "G" || nm_upper == "R";
            if !is_target { continue; }
            let safe = nm.replace([' ', '.', '/'], "_");
            let path = debug_dump_dir.join(format!("rust_dump_{}_f16.bin", safe));
            let expected = (image_height as usize) * ch_w * (bpe as usize);
            let buf_len = shared_buffers[i].len().min(expected);
            if let Err(e) = std::fs::write(&path, &shared_buffers[i][..buf_len]) {
                eprintln!("[EXR-FFI] dump write {:?} failed: {}", path, e);
            } else {
                eprintln!("[EXR-FFI] dumped {:?} ({} bytes)", path, buf_len);
            }
        }
    }

    Ok(channel_infos)
}

/// Helper: read chunk info for the given chunk index, dispatching on the
/// storage type (scanline vs tiled). Extracted so the new shared-buffer
/// path can call it without duplicating the match arm.
///
/// IMPORTANT: `exr_read_scanline_chunk_info` takes a **scanline y
/// coordinate** as its third argument, not a chunk index. We convert
/// the chunk index to the matching y by multiplying by `scanlines_per_chunk`
/// and adding `data_window_min_y`. The previous implementation passed
/// the raw chunk index, which the library interpreted as `y=0` for every
/// chunk — that meant every chunk read returned the first chunk's data,
/// so all 16 chunks of a DWAB file wrote the same top 256 rows.
unsafe fn read_chunk_info(
    reader: &ExrFileReader,
    part_index: i32,
    chunk_idx: i32,
    storage: ExrStorage,
    scanlines_per_chunk: i32,
    data_window_min_y: i32,
    chunk_info: &mut ExrChunkInfo,
) -> Result<()> {
    *chunk_info = std::mem::zeroed();
    match storage {
        ExrStorage::Scanline => {
            // For INCREASING_Y and DECREASING_Y line orders, chunks are
            // addressed by their starting scanline y. chunk_idx * slpc
            // gives the row offset within the data window; add min_y to
            // convert to pixel-space y. The library handles DECREASING_Y
            // internally — the y we pass still identifies the correct chunk.
            let y = (chunk_idx as i64) * (scanlines_per_chunk as i64)
                + (data_window_min_y as i64);
            let func: Symbol<'_, ExrReadScanlineChunkInfoFn> = reader.lib
                .get(b"exr_read_scanline_chunk_info")
                .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
            check_result(func(reader.context, part_index, y as i32, chunk_info))?;
        }
        ExrStorage::Tiled => {
            // chunk_idx encodes level_x, level_y, tile_x, tile_y
            let tile_x = chunk_idx % 256;
            let tile_y = (chunk_idx / 256) % 256;
            let level_x = ((chunk_idx / (256 * 256)) % 256) as u8;
            let level_y = ((chunk_idx / (256 * 256 * 256)) % 256) as u8;
            let func: Symbol<'_, ExrReadTiledChunkInfoFn> = reader.lib
                .get(b"exr_read_tile_chunk_info")
                .map_err(|e| ExrError::LibraryLoad(e.to_string()))?;
            check_result(func(reader.context, part_index, tile_x, tile_y, level_x, level_y, chunk_info))?;
        }
        _ => {
            return Err(ExrError::InvalidFile);
        }
    }
    Ok(())
}

// ============================================================================
// Main Extraction Function
// ============================================================================

/// Raw RGBA decode result — used by the new high-throughput IPC path that
/// skips PNG encoding and base64 serialization. Browser displays via
/// ImageData + canvas which can resize efficiently at render time.
///
/// `rgba_f32` is the linear HDR payload (RGBA, row-major, in linear scene-
/// referred space, range typically [0, ~16] for HDR EXRs). It is filled
/// alongside `rgba` by `build_raw_rgba` so callers that want GPU-side OCIO
/// tone-mapping can skip PNG encode and ship the float buffer directly to
/// the browser. `dynamic_range` reports max(R,G,B) seen across the frame
/// and is meant as a hint for the frontend (auto-exposure / LUT clamp).
/// 2026-07-13: Clone derived so `extract_exr_rgba_raw` can publish the
/// decoded result into a single-flight `OnceLock` for coalescing
/// concurrent requests for the same file.
#[derive(Clone)]
pub struct ExrRgbaResult {
    pub rgba: Vec<u8>,
    pub rgba_f32: Option<Vec<f32>>,
    pub dynamic_range: f32,
    pub width: u32,
    pub height: u32,
    pub channels: Vec<String>,
    pub layers_count: usize,
    pub layer_names: Vec<String>,
    /// Detected pass type for the frontend visualization.
    /// "depth" | "ao" | "grayscale" | "rgb" | "normal" | "position" | "motion" | "uv" | "cryptomatte"
    pub pass_type: String,
}

/// Decode an EXR file to raw RGBA8 bytes (no resize, no PNG encode).
///
/// This is the fast path for sequence playback: the browser handles final
/// resize via canvas drawImage, which is faster than Lanczos3 in Rust for
/// small target sizes. Returns None if decode fails for any reason.
///
/// Memory: ~4 bytes/pixel + chunk buffer overhead. A 4K frame is ~33MB.
///
/// `layer_filter` is an optional layer name (e.g. "Beauty", "Emitters",
/// "Crypto material node name00"). When provided, only channels belonging
/// to that layer are decoded — every other channel is marked
/// `decode_to_ptr = NULL` so the library skips its DWAB inflate entirely.
/// This is the key speed-up for files with dozens of AOV layers: the
/// 46-channel Sh02 sample drops from a 677 MB allocation + multi-second
/// inflate of every channel down to ~14 MB / 3 channels.
///
/// When `layer_filter` is `None` we still skip non-RGB channels (we only
/// need the channels `build_raw_rgba` consumes). Pass `Some("")` to mean
/// "decode the RGB layerless channel set (R/G/B)" which is how legacy
/// single-layer EXRs name their channels.
pub fn extract_exr_rgba_raw(path: &Path, max_size: u32, layer_filter: Option<&str>) -> Option<ExrRgbaResult> {
    let t_start = std::time::Instant::now();

    // 2026-07-13 (Phase 7): Condvar-backed single-flight deduplication.
    //
    // Background: the previous implementation used `Arc<OnceLock<Option<R>>>`
    // keyed by `(path, layer, max_size)`. The intent was "first caller decodes,
    // every concurrent caller clones the shared Arc and returns the same Vec."
    // That intent failed because of a TOCTOU race between releasing the map
    // mutex and reading the slot:
    //
    //   T_leader:   m.lock(); m.insert(slot);                  m.unlock();
    //   T_follower: m.lock(); m.get(slot).cloned() = arc;     m.unlock();
    //   T_leader:   slot.get() -> None      (still empty)
    //   T_follower: slot.get() -> None      (still empty)
    //   → both call extract_exr_rgba_raw_ffi, both run the C++ bridge,
    //     both log a "START" line and a "subset decoded in N ms" line.
    //
    // Observed in the user's 32 MPixel DWAB test (file `260109\V01\`):
    //
    //     [EXR-FFI] ====== extract_exr_rgba_raw START ...0000.exr
    //     [EXR-FFI] ====== extract_exr_rgba_raw START ...0000.exr   <-- dup
    //     [EXR-FFI] cpp bridge subset decoded 2000x4000 in 414.18ms
    //     [EXR-FFI] cpp bridge subset decoded 2000x4000 in 419.65ms <-- dup
    //
    // The fix is two-fold: (1) make the leader-vs-follower decision atomic
    // inside the map mutex (already done), and (2) replace the non-blocking
    // `OnceLock::get()` poll with a `Condvar` wait so a follower cannot
    // observe an empty slot and decide to decode on its own. The leader
    // publishes by flipping `SlotState::InProgress` → `Done(R)` and
    // `notify_all()`-ing; every parked follower wakes up, clones the
    // shared `Arc<R>`, and returns.
    //
    // Edge case: if the leader panics inside the C++ bridge the slot would
    // stay `InProgress` forever. We guard with a 60 s `wait_timeout` per
    // follower; on timeout we return `None` so the UI surfaces a decode-
    // failed error instead of hanging. The stale slot is reaped the next
    // time a request for a *different* key touches the map (the leader
    // never re-attempts the same key because the function is single-shot
    // per call).
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    enum SlotState {
        InProgress,
        Done(Option<ExrRgbaResult>),
    }
    struct Slot {
        state: Mutex<SlotState>,
        cvar: Condvar,
    }
    // (PathBuf, layer, max_size) — tuples already implement Hash + Eq.
    type Key = (PathBuf, String, u32);

    static INFLIGHT: std::sync::OnceLock<Mutex<std::collections::HashMap<Key, Arc<Slot>>>> =
        std::sync::OnceLock::new();
    let inflight: &Mutex<std::collections::HashMap<Key, Arc<Slot>>> = INFLIGHT
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()));

    let key: Key = (
        path.to_path_buf(),
        layer_filter.unwrap_or("").to_string(),
        max_size,
    );

    // Phase 1 — claim the slot under the map mutex. Whoever inserts first
    // becomes the leader; everyone else becomes a follower. This is the
    // ONLY atomic step. After this point the slot either exists (we are
    // the follower) or we just put it there (we are the leader). No
    // double-insert, no check-then-act window.
    let (slot, is_leader) = {
        let mut map = inflight.lock().unwrap();
        if let Some(existing) = map.get(&key).cloned() {
            (existing, false)
        } else {
            let slot = Arc::new(Slot {
                state: Mutex::new(SlotState::InProgress),
                cvar: Condvar::new(),
            });
            map.insert(key.clone(), slot.clone());
            (slot, true)
        }
    };

    if !is_leader {
        // Follower path: park on the cvar until the leader publishes.
        // 60 s upper bound protects against a leader that panics inside
        // the C++ bridge (which would otherwise strand the slot forever).
        let mut guard = slot.state.lock().unwrap();
        loop {
            match &*guard {
                SlotState::Done(_) => break,
                SlotState::InProgress => {}
            }
            let (next_guard, _) = slot.cvar.wait_timeout(guard, Duration::from_secs(60)).unwrap();
            guard = next_guard;
            if matches!(*guard, SlotState::InProgress) {
                eprintln!(
                    "[EXR-FFI] ====== extract_exr_rgba_raw COALESCED-TIMEOUT {:?} (max_size={}, layer={:?}) — leader hung, returning None ======",
                    path, max_size, layer_filter
                );
                return None;
            }
        }
        match &*guard {
            SlotState::Done(result) => {
                let elapsed = t_start.elapsed();
                eprintln!(
                    "[EXR-FFI] ====== extract_exr_rgba_raw COALESCED {:?} (max_size={}, layer={:?}, saved {:.2?}) ======",
                    path, max_size, layer_filter, elapsed
                );
                return result.clone();
            }
            SlotState::InProgress => unreachable!("checked above"),
        }
    }

    // Leader path: do the decode, publish, then drop the map entry so
    // future requests for the same key get a fresh slot. The LRU + disk
    // caches (Phase 5) already cover the "reuse forever" case; the
    // single-flight map is only meant for same-millisecond duplicates.
    eprintln!(
        "[EXR-FFI] ====== extract_exr_rgba_raw START {:?} (max_size={}, layer={:?}) ======",
        path, max_size, layer_filter
    );

    let result = extract_exr_rgba_raw_ffi(path, t_start, layer_filter);

    // Publish so any coalesced waiters wake up and read the result.
    {
        let mut guard = slot.state.lock().unwrap();
        *guard = SlotState::Done(result.clone());
        slot.cvar.notify_all();
    }

    // Drop the map entry now that the slot is published. The Arc still
    // holds the decoded data for anyone who cloned it during the wait.
    {
        let mut map = inflight.lock().unwrap();
        map.remove(&key);
    }

    result
}

/// Phase 5B: cheap header-only probe used by the EXR decode cache to find
/// the cache key (which depends on width × height). Returns `Some((w, h))`
/// on success and `None` for non-EXR / corrupt files. Cost: one open +
/// one `get_first_part_info` call — typically < 5 ms.
pub fn probe_exr_dimensions(path: &Path) -> Option<(u32, u32)> {
    let core = global_openexr_core().ok()?;
    let reader = core.start_read(path).ok()?;
    let part_info = reader.get_first_part_info().ok()?;
    Some((part_info.width().max(1) as u32, part_info.height().max(1) as u32))
}

/// Count how many distinct layers a channel list has.
///
/// "Layer" here means the prefix before the first `.` in each channel name
/// (or "root" if the channel has no dot).  Single-layer EXRs (channels
/// `R`, `G`, `B`, `A` with no dot) return 1.  Multi-layer EXRs
/// (e.g. `Beauty.R`, `Ambient light.G`, `CryptoObject00.A`) return the
/// number of distinct prefixes.  This is used to decide whether we need the
/// sacrificial-channel workaround for the OpenEXRCore 3.4 generic-unpack bug:
/// the workaround is only required when `num_layers > 1` (multi-layer files).
fn count_unique_layers(channel_names: &[String]) -> usize {
    let mut layers = std::collections::HashSet::new();
    for name in channel_names {
        let layer = if let Some(dot) = name.find('.') {
            name[..dot].to_lowercase()
        } else {
            "".to_string()
        };
        layers.insert(layer);
    }
    layers.len()
}

/// Compute a per-channel keep mask so we only allocate buffers and run
/// the DWAB inflate for channels `build_raw_rgba` will actually consume.
///
/// `layer_filter == None`  → keep the first layer that has R/G/B/A
///                            (e.g. "Beauty") plus one sacrificial
///                            non-RGB channel for the OpenEXRCore 3.4
///                            generic-unpack workaround.
///
/// `layer_filter == Some(name)` → keep channels whose name starts with
///                            `name + "."`, or that equal `name.R/.G/.B/.A`
///                            (the bare-channel EXR convention), plus
///                            one sacrificial non-RGB channel.  If the
///                            file has no such layer, fall back to the
///                            first-RGB-layer behaviour so we still
///                            produce a non-empty image.
///
/// The sacrificial channel is required so the library uses
/// `generic_unpack_to_planar` instead of the buggy
/// `unpack_half_to_float_4chan_planar` optimised path that corrupts
/// multi-layer memory layout.
fn compute_channel_keep_mask(channel_names: &[String], layer_filter: Option<&str>) -> Vec<bool> {
    let n = channel_names.len();
    let mut keep = vec![false; n];

    // 1. Determine the layer we want to keep.
    let target_layer: String = if let Some(lf) = layer_filter {
        lf.to_string()
    } else {
        // Auto-detect: first layer that has any .R/.G/.B/.A channel.
        let mut found: Option<String> = None;
        for name in channel_names {
            let upper = name.to_uppercase();
            let is_rgb_or_a = upper == "R" || upper == "G" || upper == "B" || upper == "A"
                || upper.ends_with(".R") || upper.ends_with(".G")
                || upper.ends_with(".B") || upper.ends_with(".A");
            if is_rgb_or_a {
                // Extract layer prefix (everything before the last '.').
                if let Some(dot) = name.rfind('.') {
                    found = Some(name[..dot].to_string());
                    break;
                }
            }
        }
        // Bare R/G/B (no layer prefix) — use empty layer.
        found.unwrap_or_default()
    };

    // 2. Mark channels belonging to the target layer.
    //
    // "rgba" is the synthetic name that `ExrMetadata::parse_layers_from_channels`
    // returns for single-layer EXRs whose channels have no layer prefix
    // (just bare R/G/B/A). Treat it the same as the empty (root) layer so
    // the bare-channel branch below kicks in. Without this, "rgba" never
    // matches `name.starts_with("rgba.")`, we keep zero channels, and
    // `build_raw_rgba` falls back to the all-grey placeholder.
    let bare_target = target_layer.is_empty() || target_layer.eq_ignore_ascii_case("rgba");
    for (i, name) in channel_names.iter().enumerate() {
        let in_layer = if bare_target {
            !name.contains('.')
        } else {
            name.starts_with(&target_layer)
                && name[target_layer.len()..].starts_with('.')
        };
        // Channels are kept if they belong to the target layer.  We
        // intentionally do NOT require the suffix to be `.R/.G/.B/.A`
        // — single-channel passes like `Roughness.y`, `Z-depth.y`,
        // `Ambient occlusion.y` are valid AOVs and need to be decoded
        // too. `build_raw_rgba` falls back to single-channel broadcast
        // when no RGB triple is present.
        if in_layer {
            keep[i] = true;
        }
    }

    // 2b. Fallback for synthetic "rgba" target on a file whose channels
    //     are all layered (no bare R/G/B/A at root). This happens for
    //     per-pass EXRs that the user drops into the viewer as a single
    //     file (e.g. `Rnd__cm-Gnn_0015.exr` with 12 channels under
    //     `CryptoGeometryNodeName00.*`). Without this fallback the
    //     filter keeps zero channels and `build_raw_rgba` returns an
    //     all-zero image. We mirror the Python 145 behaviour: pick the
    //     first layer by occurrence and keep ALL its channels.
    let any_kept = keep.iter().any(|&k| k);
    if !any_kept && bare_target && !channel_names.is_empty() {
        // Find the layer prefix of the first layered channel.
        let first_layer = channel_names[0]
            .rsplit_once('.')
            .map(|(prefix, _)| prefix.to_string())
            .unwrap_or_default();
        if !first_layer.is_empty() {
            eprintln!(
                "[EXR-FFI] rgba fallback: no bare channels and no '{first_layer}.*' match for target 'rgba' — using ALL channels of layer '{first_layer}'"
            );
            for (i, name) in channel_names.iter().enumerate() {
                if name.starts_with(&first_layer)
                    && name[first_layer.len()..].starts_with('.')
                {
                    keep[i] = true;
                }
            }
        }
        // Last-ditch fallback: keep everything if we still have nothing
        // (e.g. all channels are bare single chars with no dot at all).
        if !keep.iter().any(|&k| k) {
            eprintln!("[EXR-FFI] rgba fallback: keeping ALL channels as last resort");
            for k in keep.iter_mut() { *k = true; }
        }
    }

    // 3. If we have R/G/B/A kept (or even just R+G+B), also keep one
    //    sacrificial non-RGB channel so the OpenEXRCore 3.4 bug
    //    workaround stays effective.  Without a sacrificial the optimised
    //    4-channel unpack path can be selected and corrupt memory.
    let has_rgb = keep.iter().enumerate().any(|(i, &k)| {
        k && {
            let upper = channel_names[i].to_uppercase();
            upper.ends_with(".R") || upper.ends_with(".G") || upper.ends_with(".B")
                || upper == "R" || upper == "G" || upper == "B"
        }
    });
    if has_rgb {
        for (i, name) in channel_names.iter().enumerate() {
            if keep[i] { continue; }
            let upper = name.to_uppercase();
            let is_rgb_or_a = upper == "R" || upper == "G" || upper == "B" || upper == "A"
                || upper.ends_with(".R") || upper.ends_with(".G")
                || upper.ends_with(".B") || upper.ends_with(".A");
            if !is_rgb_or_a {
                keep[i] = true;
                break;
            }
        }
    }

    keep
}

/// Try the OpenEXR C++ bridge (exr_cpp_bridge.dll) for a fast decode
/// using the high-level C++ API and its internal IlmThread pool.
///
/// Phase 4B: this path now uses `cpp_decode_subset_f32` and accepts the
/// same layer filter as the OpenEXRCore fallback. We build a wanted
/// channel list from the layer filter (e.g. Some("Beauty") →
/// ["Beauty.R","Beauty.G","Beauty.B","Beauty.A"]) and let the C++ side
/// pick matching channels in the file. With `None` we pass an empty
/// list and let the C++ side auto-detect the first layer's RGBA.
///
/// Returns None if the bridge isn't loaded or the file can't be decoded
/// via this path. Used by `extract_exr_rgba_raw_ffi` to short-circuit
/// the OpenEXRCore low-level fallback for simple single-layer files.
/// 2026-07-13: Cache of files we already discovered are layerless
/// (channels named "R", "G", "B", "A" with no layer prefix).
/// Avoids re-trying the layer-prefixed wanted list every time we see
/// the same file in a sequence — saves ~5-15ms per frame on warm
/// batches (header parse + match fail). Capped at 1024 entries to
/// keep memory bounded for long sessions.
static LAYERLESS_FILE_CACHE: OnceLock<Mutex<std::collections::HashSet<PathBuf>>> =
    OnceLock::new();

fn layerless_cache() -> &'static Mutex<std::collections::HashSet<PathBuf>> {
    LAYERLESS_FILE_CACHE.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

fn remember_layerless(path: &Path) {
    if let Ok(mut cache) = layerless_cache().lock() {
        if cache.len() < 1024 {
            cache.insert(path.to_path_buf());
        } else {
            // Reset half to bound growth for very long sessions.
            let to_drop: Vec<_> = cache.iter().take(512).cloned().collect();
            for k in to_drop {
                cache.remove(&k);
            }
            cache.insert(path.to_path_buf());
        }
    }
}

fn is_known_layerless(path: &Path) -> bool {
    layerless_cache()
        .lock()
        .map(|c| c.contains(path))
        .unwrap_or(false)
}

fn try_cpp_bridge_decode(path: &Path, layer_filter: Option<&str>) -> Option<ExrRgbaResult> {
    // Lazy load test — the DLL may simply not be present (clean checkout).
    if crate::openexr_ffi::cpp_bridge_dll().is_none() {
        return None;
    }

    // Build wanted channel list:
    // - Some("Beauty")   → ["Beauty.R","Beauty.G","Beauty.B","Beauty.A"]
    // - Some("") (legacy layerless sentinel) → ["R","G","B","A"]
    // - None → [] (C++ side auto-detects the first layer's RGBA)
    //
    // 2026-07-13: For files where the user-specified layer doesn't exist
    // (e.g. file is layerless but frontend filter is "rgba"), build a
    // fallback list with no prefix and try that too. This recovers the
    // C++ bridge fast-path for the common single-layer case where the
    // frontend filter accidentally points at a non-existent layer.
    let primary: Vec<String> = match layer_filter {
        Some(layer) if !layer.is_empty() => {
            let layer = layer.trim();
            vec![
                format!("{}.R", layer),
                format!("{}.G", layer),
                format!("{}.B", layer),
                format!("{}.A", layer),
            ]
        }
        Some(_) => vec!["R".to_string(), "G".to_string(), "B".to_string(), "A".to_string()],
        None => Vec::new(),
    };

    let t0 = std::time::Instant::now();

    // 2026-07-13: Layerless cache fast-path.
    // If we've already discovered this file is layerless, skip the
    // doomed primary attempt and go straight to the layerless wanted
    // list. Saves ~5-15ms per frame on warm batches by avoiding an
    // extra Imf::InputFile open + channel probe.
    let known_layerless = is_known_layerless(path);
    if !known_layerless && !primary.is_empty() {
        if let Some((w, h, rgba_f32)) = crate::openexr_ffi::cpp_decode_subset_f32(path, &primary) {
            let elapsed = t0.elapsed();
            // Phase 10-debug: trace actual pixel values to diagnose
            // "switch to Ambient light shows Beauty pixels" bug.
            // Print first (r,g,b) and max channel values.
            let sample_r = rgba_f32.get(0).copied().unwrap_or(0.0);
            let sample_g = rgba_f32.get(1).copied().unwrap_or(0.0);
            let sample_b = rgba_f32.get(2).copied().unwrap_or(0.0);
            let mid = (w as usize * h as usize / 2 * 4).min(rgba_f32.len().saturating_sub(1));
            let mid_r = rgba_f32.get(mid).copied().unwrap_or(0.0);
            let mid_g = rgba_f32.get(mid + 1).copied().unwrap_or(0.0);
            let mid_b = rgba_f32.get(mid + 2).copied().unwrap_or(0.0);
            println!(
                "[EXR-FFI] cpp bridge subset decoded {}x{} in {:.2?} via Imf::InputFile (wanted {:?}) pixels[0]=({:.4},{:.4},{:.4}) mid=({:.4},{:.4},{:.4})",
                w, h, elapsed, primary, sample_r, sample_g, sample_b, mid_r, mid_g, mid_b
            );
            return decode_rgba_f32_to_result(path, w, h, rgba_f32, elapsed, &primary, layer_filter);
        }
    }

    // 2026-07-13-fix: CRITICAL - layerless fallback must NOT be used for multi-layer files.
    // When the user requests "Motion vector" but it doesn't exist, we should
    // return None and let OpenEXRCore handle it, NOT decode with ["R","G","B","A"]
    // which decodes Beauty (the first layer) instead of the requested layer.
    //
    // The layerless fallback is ONLY valid when:
    // 1. File is known to be single-layer (known_layerless = true), OR
    // 2. File has dot-style channels (first channel contains '.') AND
    //    the filter name is a generic "rgba" (not a specific layer name)
    //
    // For multi-layer files with a specific layer request that doesn't exist,
    // we MUST return None to fall through to OpenEXRCore.
    let is_generic_rgba = layer_filter
        .map(|f| {
            let t = f.trim();
            t.eq_ignore_ascii_case("rgba") || t.eq_ignore_ascii_case("rgb")
        })
        .unwrap_or(false);
    let should_try_layerless = is_generic_rgba && !primary.is_empty() && primary[0].contains('.');
    if should_try_layerless || known_layerless {
        let layerless: Vec<String> = vec![
            "R".to_string(),
            "G".to_string(),
            "B".to_string(),
            "A".to_string(),
        ];
        if let Some((w, h, rgba_f32)) =
            crate::openexr_ffi::cpp_decode_subset_f32(path, &layerless)
        {
            let elapsed = t0.elapsed();
            remember_layerless(path);
            let mid = (w as usize * h as usize / 2 * 4).min(rgba_f32.len().saturating_sub(1));
            let mid_r = rgba_f32.get(mid).copied().unwrap_or(0.0);
            let mid_g = rgba_f32.get(mid + 1).copied().unwrap_or(0.0);
            let mid_b = rgba_f32.get(mid + 2).copied().unwrap_or(0.0);
            if !known_layerless {
                println!(
                    "[EXR-FFI] cpp bridge subset decoded {}x{} in {:.2?} via Imf::InputFile (layerless fallback for generic 'rgba' after {:?} miss) mid=({:.4},{:.4},{:.4})",
                    w, h, elapsed, primary, mid_r, mid_g, mid_b
                );
            }
            return decode_rgba_f32_to_result(path, w, h, rgba_f32, elapsed, &layerless, layer_filter);
        }
    }

    eprintln!(
        "[EXR-FFI] cpp bridge subset returned None (wanted={:?}), falling back to OpenEXRCore",
        primary
    );
    None
}

/// Helper: build ExrRgbaResult from the (w, h, rgba_f32) tuple returned
/// by the C++ bridge. Extracted so both the primary and layerless-fallback
/// paths can share it.
fn decode_rgba_f32_to_result(
    path: &Path,
    w: u32,
    h: u32,
    rgba_f32: Vec<f32>,
    elapsed: std::time::Duration,
    wanted: &[String],
    layer_filter: Option<&str>,
) -> Option<ExrRgbaResult> {
    exr_log(&format!(
        "[EXR-FFI] cpp_bridge subset path used: {}x{} in {:.2?}",
        w, h, elapsed
    ));

    // Phase 10-debug: trace what metadata the OpenEXRCore fallback returns
    // (channels from build_raw_rgba vs wanted channels from C++ bridge).
    let sample_r = rgba_f32.first().copied().unwrap_or(0.0);
    let sample_g = rgba_f32.get(1).copied().unwrap_or(0.0);
    let sample_b = rgba_f32.get(2).copied().unwrap_or(0.0);
    println!(
        "[EXR-FFI] decode_rgba_f32_to_result: wanted={:?}, layer_filter={:?}, pixels[0]=({:.4},{:.4},{:.4})",
        wanted, layer_filter, sample_r, sample_g, sample_b
    );

    // Compute dynamic range from f32 channel max.
    let mut max_v: f32 = 0.0;
    for v in rgba_f32.iter().step_by(4) {
        if *v > max_v {
            max_v = *v;
        }
    }
    let dynamic_range = max_v.max(1.0);

    // Convert f32 RGBA -> 8-bit RGBA (sRGB encoding NOT applied — file native).
    let mut rgba8: Vec<u8> = Vec::with_capacity(rgba_f32.len());
    for px in rgba_f32.chunks_exact(4) {
        rgba8.push((px[0].clamp(0.0, 1.0) * 255.0) as u8);
        rgba8.push((px[1].clamp(0.0, 1.0) * 255.0) as u8);
        rgba8.push((px[2].clamp(0.0, 1.0) * 255.0) as u8);
        rgba8.push((px[3].clamp(0.0, 1.0) * 255.0) as u8);
    }

    // Best-effort channel/layer/passtype inference from filename only —
    // the C++ bridge doesn't enumerate channel metadata. This is enough
    // for the C++ path used in full-sequence preview, where we want the
    // raw colors; downstream logic can refine in the OpenEXRCore path.
    let file_stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let pass_type = if file_stem.contains("depth") {
        "depth".to_string()
    } else if file_stem.contains("normal") {
        "normal".to_string()
    } else if file_stem.contains("ao") {
        "ao".to_string()
    } else {
        "rgb".to_string()
    };

    // 2026-07-05 FIX: the previous hardcoded `channels: vec!["RGBA".into()],
// layer_names: vec!["RGBA".into()]` made the JS `detectPassType` fall
// back to a 1-channel grayscale classification (since `Beauty` isn't a
// substring of `RGBA` and the single string has no `.` to split on).
// That set `passMode = 1` (Grayscale), which sends the shader down the
// raw-linear branch and silently bypasses OCIO/ACES/LUT. Multi-layer
// sequences were always affected (they always reach this code path via
// `layer_filter = Some("Beauty")`); single EXRs escaped it because they
// reach the OpenEXRCore fallback with proper `["Beauty.A", ...]`
// channel names. Echo the `wanted` list verbatim so JS sees real names.
let channels_out: Vec<String> = if !wanted.is_empty() {
    wanted.to_vec()
} else {
    vec!["R".into(), "G".into(), "B".into(), "A".into()]
};
let layer_names_out: Vec<String> = if !wanted.is_empty() {
    vec![layer_filter.unwrap_or("RGBA").to_string()]
} else {
    vec!["RGBA".into()]
};

    Some(ExrRgbaResult {
        rgba: rgba8,
        rgba_f32: Some(rgba_f32),
        dynamic_range,
        width: w,
        height: h,
        channels: channels_out,
        layers_count: 1,
        layer_names: layer_names_out,
        pass_type,
    })
}

/// Pure FFI path. Returns None on any failure.
fn extract_exr_rgba_raw_ffi(path: &Path, t_start: std::time::Instant, layer_filter: Option<&str>) -> Option<ExrRgbaResult> {
    // Try the OpenEXR C++ bridge first for simple cases (single-layer,
    // no layer filter, no resize). This path benefits from Imf::setGlobal-
    // ThreadCount via the C++ API's internal IlmThread pool.
    //
    // Phase 4 / V2 plan: this is the primary code path for full-sequence
    // previews. The fallback below (OpenEXRCore low-level) is kept for
    // compatibility — multi-layer or filtered files still go through it.
    //
    // Phase 4B: removed the `is_none()` guard — the bridge now handles
    // layer-filtered subsets via `cpp_decode_subset_f32`, so the user's
    // "Beauty" filter goes straight through the C++ path.
    if let Some(r) = try_cpp_bridge_decode(path, layer_filter) {
        return Some(r);
    }
    let core = match global_openexr_core() {
        Ok(c) => c,
        Err(e) => { eprintln!("[EXR-FFI] OpenEXRCore::load() failed: {:?}", e); return None; }
    };
    let reader = match core.start_read(path) {
        Ok(r) => r,
        Err(e) => { eprintln!("[EXR-FFI] start_read failed: {:?}", e); return None; }
    };
    let part_info = match reader.get_first_part_info() {
        Ok(p) => p,
        Err(e) => { eprintln!("[EXR-FFI] get_first_part_info failed: {:?}", e); return None; }
    };

    if part_info.is_deep() {
        eprintln!("[EXR-FFI] Deep EXR not supported");
        return None;
    }

    let width = part_info.width().max(1) as usize;
    let height = part_info.height().max(1) as usize;
    let compression = part_info.compression;
    let chunk_count = part_info.chunk_count as usize;
    let storage = part_info.storage;

    let channel_names = reader.get_channel_names(0).unwrap_or_default();
    let n_channels = channel_names.len();

    let layers = count_unique_layers(&channel_names);
    eprintln!("[EXR-FFI] {}x{}, {} chunks, comp={:?}, {} channels, {} layers",
        width, height, chunk_count, compression, n_channels, layers);
    exr_log(&format!("[EXR-FFI] file={:?} {}x{} chunks={} comp={:?} channels={} layers={}",
        path, width, height, chunk_count, compression, n_channels, layers));
    exr_log_phase("1", &format!("single-layer={} (will skip sacrificial if true)", layers <= 1));

    // ----------------------------------------------------------------
    // Decide which channels we actually need to decode.  When a
    // `layer_filter` is given we keep only that layer's channels; when no
    // filter is given we still skip every channel that `build_raw_rgba`
    // will not consume (i.e. anything other than the layer's first .R/.G
    // /.B/.A plus a sacrificial non-RGB channel).  This is the key speed
    // win for files with many AOVs: a 46-channel Sh02 file drops from
    // 677 MB of allocations + multi-second DWAB inflate of every channel
    // down to ~14 MB / 3 channels when the user has selected "Beauty".
    //
    // Phase 1 improvement: we also count layers here so we can skip the
    // sacrificial-channel workaround for single-layer EXRs, enabling the
    // optimised 4-channel unpack path (~2-3× faster than generic).
    // ----------------------------------------------------------------
    let keep_mask = compute_channel_keep_mask(&channel_names, layer_filter);
    let (kept_indices, kept_count): (Vec<usize>, usize) = {
        let kept: Vec<usize> = (0..n_channels).filter(|&i| keep_mask[i]).collect();
        let n = kept.len();
        (kept, n)
    };
    // DBG-2026-07-13: print FULL channel names being kept (not just indices)
    let kept_names: Vec<&str> = kept_indices.iter().map(|&i| channel_names[i].as_str()).collect();
    eprintln!("[EXR-FFI] layer_filter={:?}: keeping {} / {} channels", layer_filter, kept_count, n_channels);
    eprintln!("[EXR-FFI] KEPT CHANNELS: {:?}", kept_names);
    eprintln!("[EXR-FFI] ALL channels in file ({}):", n_channels);
    for (i, n) in channel_names.iter().enumerate() {
        let marker = if keep_mask[i] { "★KEEP" } else { " skip" };
        eprintln!("[EXR-FFI]   [{}] '{}' {}", i, n, marker);
    }

    // Per-channel allocation: size each buffer to the *exact* per-channel
    // footprint (image_height × channel_width × bpe).  Channels we are
    // skipping get an empty buffer — `decode_file_into_shared_buffers`
    // will mark their `decode_to_ptr` as NULL so the library skips them.
    // Allocating exact-size (rather than `width*height*max_bpe`) cuts
    // memory roughly in half for files where most channels are HALF
    // (90% of channels in a typical Beauty+AOVs file).
    let mut shared_buffers: Vec<Vec<u8>> = Vec::with_capacity(n_channels);
    for i in 0..n_channels {
        if keep_mask[i] {
            // Allocate a *placeholder* of 1 byte so the Vec exists (so we
            // can later `set_len` it). The actual size is decided inside
            // `decode_file_into_shared_buffers` based on the per-channel
            // bpe (which we don't have here without re-reading the
            // channel info struct).
            shared_buffers.push(Vec::with_capacity(width * height * 4));
        } else {
            shared_buffers.push(Vec::new());
        }
    }
    let kept_count = kept_indices.len();
    let alloc_bytes = kept_count * width * height * 4;
    record_alloc(kept_count, alloc_bytes);
    eprintln!("[EXR-FFI] allocated {:.1} MB across {} kept channel buffers (capacity only, will set_len to exact size later; skipped {} zero-fills)",
        alloc_bytes as f64 / 1048576.0, kept_count, n_channels - kept_count);

    let t_chunks = std::time::Instant::now();

    // Count layers to decide whether the sacrificial workaround is needed.
    // Single-layer EXRs: bug does not trigger → skip workaround → ~2-3× faster.
    // Multi-layer EXRs: workaround required.
    let num_layers = count_unique_layers(&channel_names);
    // 2026-07-13: use shared thread count to match C++ bridge thread pool.
    let shared_threads = crate::openexr_ffi::get_openexr_thread_count();
    let n_workers = if shared_threads > 0 { shared_threads as usize } else {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
    }.max(1);

    // Phase 2: Enable parallel decode for single-layer EXRs.
    // For single-layer (num_layers <= 1), the OpenEXRCore 3.4 bug does not
    // trigger and we don't need the sacrificial-channel workaround. The parallel
    // path (N workers each opening their own context, decoding assigned chunks,
    // returning compact buffers merged into shared_buffers) is safe here.
    //
    // For multi-layer EXRs (num_layers > 1), the workaround requires careful
    // per-channel decode_to_ptr management across ALL chunks on a SINGLE context.
    // Keep sequential for multi-layer until the workaround is fully integrated.
    //
    // Single-core or very small files (< 4 chunks): sequential is simpler.
    let use_parallel = num_layers <= 1 && n_workers > 1 && chunk_count >= 4;
    exr_log_phase("2", &format!("use_parallel={} (num_layers={}, n_workers={}, chunk_count={})",
        use_parallel, num_layers, n_workers, chunk_count));

    // Use a scope to contain the decode result borrow so it is fully released
    // before we iterate channel_infos alongside shared_buffers below.
    let channel_infos: Vec<(String, usize, usize, i32)> = {
        if use_parallel {
            eprintln!("[EXR-FFI] PARALLEL decode: {} chunks, {} workers (single-layer, no sacrificial workaround needed)",
                chunk_count, n_workers);
            exr_log("[EXR-FFI] PARALLEL path active");
            // decode_chunks_parallel_into_shared_buffers needs shared_buffers
            // pre-sized to full-frame capacity.
            for i in 0..n_channels {
                if keep_mask[i] {
                    let expected = width * height * 4;
                    let current_cap = shared_buffers[i].capacity();
                    if current_cap < expected {
                        shared_buffers[i].reserve(expected - current_cap);
                    }
                }
            }
            // Try parallel. If it fails, return error — caller can retry with
            // sequential path (which uses its own mutable borrow on a fresh allocation).
            match unsafe {
                decode_chunks_parallel_into_shared_buffers(path, &part_info, storage, &mut shared_buffers, num_layers)
            } {
                Ok(infos) => {
                    eprintln!("[EXR-FFI] parallel decode SUCCEEDED: {:.2?}", t_chunks.elapsed());
                    exr_log(&format!("[EXR-FFI] parallel decode OK in {:.2?}", t_chunks.elapsed()));
                    infos
                }
                Err(e) => {
                    eprintln!("[EXR-FFI] parallel decode FAILED: {:?} — try sequential path instead", e);
                    exr_log(&format!("[EXR-FFI] parallel decode FAILED: {:?}", e));
                    return None;
                }
            }
        } else {
            eprintln!("[EXR-FFI] SEQUENTIAL decode: {} chunks, num_layers={} (multi-layer or small file)",
                chunk_count, num_layers);
            exr_log("[EXR-FFI] SEQUENTIAL path active (multi-layer or chunk_count<4 or n_workers<=1)");
            match unsafe {
                decode_file_into_shared_buffers(&reader, 0, &part_info, storage, &mut shared_buffers, num_layers)
            } {
                Ok(infos) => infos,
                Err(e) => {
                    eprintln!("[EXR-FFI] shared-buffer decode failed: {:?}", e);
                    exr_log(&format!("[EXR-FFI] shared-buffer decode failed: {:?}", e));
                    return None;
                }
            }
        }
    }; // <-- scope ends here; decode's mutable borrow of shared_buffers is fully released

    eprintln!("[EXR-FFI] Shared-buffer decode: {:.2?}", t_chunks.elapsed());
    exr_log(&format!("[EXR-FFI] Shared-buffer decode DONE in {:.2?}", t_chunks.elapsed()));

    // Package (name, w, h, bpe, buf) tuples the same way the old chunk
    // loop did, so `build_raw_rgba` can consume them unchanged.
    //
    // The shared buffer for channel `i` was sized to hold the full image
    // (image_height × ch_w × bpe, where ch_w is the per-channel width,
    // possibly smaller than image_width for subsampled channels). The
    // (w, h) values returned by `decode_file_into_shared_buffers` are
    // already the image's full width/height, so `build_raw_rgba` reads
    // exactly the right amount. We don't truncate the buffer — its
    // trailing bytes are the (unused) tail of the per-channel allocation
    // and don't affect the decoded image.
    let mut all_channels: Vec<(String, usize, usize, i32, Vec<u8>)> =
        Vec::with_capacity(channel_infos.len());
    for (i, (name, w, h, bpe)) in channel_infos.into_iter().enumerate() {
        if i >= shared_buffers.len() { break; }
        let buf = std::mem::take(&mut shared_buffers[i]);
        if buf.is_empty() {
            continue;
        }
        all_channels.push((name, w, h, bpe, buf));
    }

    // ------------------------------------------------------------------
    // Frontend channel-list reporting
    //
    // The frontend (`detectPassType` in `passType.ts`) uses the
    // `channels` field to choose visualization mode and decide whether
    // to bypass OCIO/ACES. Until now this list was the FULL file
    // channel list, which caused single-layer EXRs (where the frontend
    // picks the synthetic "rgba" target) to leak the names of every
    // other layer (e.g. "CryptoGeometryNodeName00.a") into the JS
    // keyword matcher — leading to wrong passType detection
    // (RGB/Cryptomatte confusion, false-positive Normal on Beauty, …).
    //
    // We rebuild the keep mask with the same rules the decode path
    // used and use it to narrow the channel list down to the channels
    // we actually kept (filtered by layer + rgba fallback).
    let keep_mask = compute_channel_keep_mask(&channel_names, layer_filter);
    let filtered_channels: Vec<String> = channel_names
        .iter()
        .zip(keep_mask.iter())
        .filter_map(|(n, &k)| if k { Some(n.clone()) } else { None })
        .collect();
    let returned_channels = if filtered_channels.is_empty() {
        channel_names.clone()
    } else {
        filtered_channels
    };
    eprintln!(
        "[EXR-FFI] Reporting {} of {} channels to frontend (filtered by keep mask)",
        returned_channels.len(),
        channel_names.len()
    );

    let result = build_raw_rgba(all_channels, width, height, &returned_channels);
    if let Some(mut r) = result {
        // Phase 10-fix: OpenEXRCore fallback returns ALL file channels (81)
        // in `r.channels`. Override with the correct layer-filtered names so
        // disk cache saves correct metadata. Without this, every layer after the
        // first decode gets channels=["R","G","B","A"] from disk cache, and
        // the frontend sees identical pixels for all layers (the original bug).
        if let Some(lf) = layer_filter {
            let prefix = lf.trim();
            if !prefix.is_empty() {
                r.channels = vec![
                    format!("{}.R", prefix),
                    format!("{}.G", prefix),
                    format!("{}.B", prefix),
                    format!("{}.A", prefix),
                ];
                r.layer_names = vec![prefix.to_string()];
                println!(
                    "[EXR-FFI] Phase10-fix: overriding channels → {:?}, layer_names → {:?}",
                    r.channels, r.layer_names
                );
            }
        }
        // Pass-type detection runs here so it can inspect the final RGBA
        // buffer (mean/min/std/polarity) — mirrors Python's stats-based
        // fallback for single-channel and 3-vec buffers.
        //
        // IMPORTANT: `returned_channels` includes the sacrificial
        // non-RGB channel used to force the generic-unpack path on
        // multi-layer EXRs (e.g. `Ambient occlusion.y` next to
        // `Beauty.R/G/B`). Passing that sacrificial channel name to
        // `detect_pass_type` would make it misclassify the whole image
        // as `ao` (the keyword "ambient"/"occlusion" matches).
        //
        // The sacrificial channel is *not* part of the visible RGBA
        // buffer — the image we hand the renderer is the selected
        // layer's RGB pixels in slots 0..3 (or grayscale broadcast in
        // 0..0). Filter the keyword-context channels down to R/G/B
        // components only (drop Y/Z/A components that look like
        // single-channel AOVs but are actually sacrificial channels
        // from a different layer) before feeding them to the detector.
        // Also strip the Y channel so the `rgb` shape-based heuristic
        // doesn't get confused by a sacrificial Y alongside RGB.
        let rgb_only_channels: Vec<String> = returned_channels
            .iter()
            .filter(|c| {
                let comp = c.rsplit('.').next().unwrap_or(c).to_uppercase();
                matches!(comp.as_str(), "R" | "G" | "B")
            })
            .cloned()
            .collect();
        let pass_type_channels = if rgb_only_channels.is_empty() {
            // Fall back: no RGB channels found — pass through everything
            // (this is the genuine single-channel path, e.g. Z-depth layer).
            returned_channels.clone()
        } else {
            rgb_only_channels
        };
        let path_str = path.to_str();
        r.pass_type = detect_pass_type(&pass_type_channels, path_str, r.rgba_f32.as_deref());
        eprintln!("[EXR-FFI] Detected pass_type: '{}' for channels: {:?} (sacrificial filtered)", r.pass_type, pass_type_channels);
        println!("[EXR-FFI] ====== extract_exr_rgba_raw DONE in {:.2?} ======",
            t_start.elapsed());
        exr_log(&format!("[EXR-FFI] ====== extract_exr_rgba_raw DONE in {:.2?} ====== pass_type={}", t_start.elapsed(), r.pass_type));
        Some(r)
    } else {
        println!("[EXR-FFI] ====== extract_exr_rgba_raw DONE in {:.2?} ======",
            t_start.elapsed());
        exr_log(&format!("[EXR-FFI] ====== extract_exr_rgba_raw DONE in {:.2?} (NO RESULT) ======", t_start.elapsed()));
        None
    }
}

fn chunk_idx_of_err(_e: &ExrError) -> i32 { -1 }

// ============================================================================
// Pixel Conversion
// ============================================================================

/// Controls which output buffers `build_raw_rgba` produces.
///
/// Phase 6 optimization: avoid redundant half→u8 and half→f32 conversions
/// when the caller only needs one output. The original code always computed
/// both, doubling the conversion work per pixel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum RgbaOutputMode {
    /// Compute both u8 RGBA thumbnail and f32 RGBA (for OCIO GPU path).
    #[default]
    Both,
    /// Compute only u8 RGBA (for thumbnail/preview where f32 isn't needed).
    U8Only,
    /// Compute only f32 RGBA (for GPU rendering where thumbnail isn't needed).
    F32Only,
}

/// Build interleaved RGBA from a list of decoded channel buffers.
/// Optionally computes both u8 and f32 outputs depending on `output_mode`.
/// The `output_mode` parameter (Phase 6) lets callers skip unnecessary conversions:
///   - `Both`: both u8 and f32 (default, for full OCIO pipeline)
///   - `U8Only`: only u8 (for thumbnail/preview, saves ~50% of conversion time)
///   - `F32Only`: only f32 (for GPU rendering, saves ~50% of conversion time)
/// DBG-2026-07-13: print first 4 pixels of a channel buffer so we can tell
/// from the log whether the right layer's data ended up in each R/G/B slot.
fn print_pixel_samples(label: &str, buf: &[u8], ch_w: usize, bpe: i32) {
    let sample_offsets: [usize; 4] = [0, ch_w.min(buf.len() / bpe as usize).saturating_sub(1), 0, ch_w.min(buf.len() / bpe as usize).saturating_sub(1)];
    eprintln!("[EXR-FFI-DBG]   {} pixel samples (ch_w={}, bpe={}, buf_len={}):", label, ch_w, bpe, buf.len());
    for (i, &off) in sample_offsets.iter().enumerate() {
        let byte_off = off * (bpe as usize);
        if byte_off + (bpe as usize) > buf.len() { continue; }
        let corner = ["TL", "TR", "ML", "MR"][i];
        let approx_f32 = if bpe == 2 {
            let half_bits = u16::from_le_bytes([buf[byte_off], buf[byte_off + 1]]);
            // IEEE 754 binary16 → binary32 (proper conversion)
            let sign = ((half_bits >> 15) & 1) as u32;
            let exp = ((half_bits >> 10) & 0x1f) as i32;
            let mant = (half_bits & 0x3ff) as u32;
            let f32_bits = if exp == 0 {
                if mant == 0 { sign << 31 } else { ((sign << 31) | ((mant as f32 * (2.0f32).powi(-24))) as u32) }
            } else if exp == 31 {
                (sign << 31) | 0x7f800000 | (mant << 13)
            } else {
                let new_exp = (exp - 15 + 127) as u32;
                (sign << 31) | (new_exp << 23) | (mant << 13)
            };
            f32::from_bits(f32_bits)
        } else {
            f32::from_le_bytes([buf[byte_off], buf[byte_off + 1], buf[byte_off + 2], buf[byte_off + 3]])
        };
        eprintln!("[EXR-FFI-DBG]     {} @{} ({}): raw_bytes=0x{} → f32={:.6}", label, off, corner,
            buf[byte_off..byte_off + bpe as usize].iter().map(|b| format!("{:02x}", b)).collect::<String>(),
            approx_f32);
    }
}

fn build_raw_rgba(
    all_channels: Vec<(String, usize, usize, i32, Vec<u8>)>,
    width: usize,
    height: usize,
    channel_names: &[String],
) -> Option<ExrRgbaResult> {
    // Find R, G, B buffers (same logic as build_rgba_from_channels)
    let mut r_buf: Option<Vec<u8>> = None;
    let mut g_buf: Option<Vec<u8>> = None;
    let mut b_buf: Option<Vec<u8>> = None;
    let mut r_info: Option<(usize, usize, i32)> = None;
    let mut g_info: Option<(usize, usize, i32)> = None;
    let mut b_info: Option<(usize, usize, i32)> = None;
    /// First non-RGB channel seen — used as the grayscale broadcast source
    /// for AOVs like `Roughness.y` / `Z-depth.y` / `Ambient occlusion.y`
    /// that have no R/G/B triple. Stored separately so the RGB loop above
    /// can still claim the RGB channels when present.
    let mut single_buf: Option<Vec<u8>> = None;
    let mut single_info: Option<(usize, usize, i32)> = None;
    // 2026-07-05 alpha hotfix: capture the EXR's A channel so the
    // resulting RGBA carries the real transparency (e.g. compositing
    // pre-mattes) instead of always-opaque 255. Without this, EXRs with
    // `A` show black under transparent pixels in the viewer.
    let mut a_buf: Option<Vec<u8>> = None;
    let mut a_info: Option<(usize, usize, i32)> = None;

    for (name, w, h, bpe, buf) in all_channels {
        // Match both root-level channels (R/G/B) and multi-layer ones
        // (Beauty.R, Denoised beauty.G, Output AOV 1.B, ...). Take the
        // first match for each colour — without this the multi-layer
        // EXR files we get from render pipelines produce empty RGBA
        // output and `dynamic_range = 0` because no channel ever matches.
        let upper = name.to_uppercase();
        let is_r = upper == "R" || upper == "RED" || upper.ends_with(".R");
        let is_g = upper == "G" || upper == "GREEN" || upper.ends_with(".G");
        let is_b = upper == "B" || upper == "BLUE" || upper.ends_with(".B");
        // 2026-07-05 alpha hotfix: also recognise alpha. We match the
        // tail-after-dot form (e.g. `Beauty.A`, `CryptoMatte.A`) so it
        // works for both root-level and layer-prefixed channels.
        let is_a = upper == "A" || upper == "ALPHA" || upper.ends_with(".A");
        if r_buf.is_none() && is_r {
            r_buf = Some(buf);
            r_info = Some((w, h, bpe));
        } else if g_buf.is_none() && is_g {
            g_buf = Some(buf);
            g_info = Some((w, h, bpe));
        } else if b_buf.is_none() && is_b {
            b_buf = Some(buf);
            b_info = Some((w, h, bpe));
        } else if a_buf.is_none() && is_a {
            // 2026-07-05 alpha hotfix: capture alpha before falling
            // through to the grayscale single_buf fallback. Files with
            // only an `A` channel (e.g. matte EXRs) get rendered as
            // grayscale via the single-channel fallback below.
            a_buf = Some(buf);
            a_info = Some((w, h, bpe));
        } else if single_buf.is_none() {
            // First non-RGB channel in this layer — used as the fallback
            // grayscale source for single-channel AOVs.
            single_buf = Some(buf);
            single_info = Some((w, h, bpe));
        }
    }

    // Single-channel fallback: if no R/G/B was found but at least one
    // channel exists, broadcast it into R/G/B. This enables `Roughness.y`,
    // `Z-depth.y`, `Ambient occlusion.y`, and similar single-channel
    // AOVs to render as grayscale images.
    if r_buf.is_none() && g_buf.is_none() && b_buf.is_none() {
        if let (Some(sb), Some((sw, sh, sbpe))) = (single_buf.take(), single_info.take()) {
            r_buf = Some(sb.clone());
            g_buf = Some(sb.clone());
            b_buf = Some(sb);
            r_info = Some((sw, sh, sbpe));
            g_info = Some((sw, sh, sbpe));
            b_info = Some((sw, sh, sbpe));
            eprintln!("[EXR-FFI] build_raw_rgba: single-channel fallback → broadcasting {}x{} into R=G=B", sw, sh);
        }
    }

    let mut rgba = vec![128u8; width * height * 4];
    // Float32 linear buffer for GPU-side OCIO LUT path. Parallel to `rgba`.
    // Stored as Vec<f32> so the frontend can hand it straight to a
    // WebGL2 R32G32B32A32F texture. Capacity matches rgba (1:1 mapping).
    let mut rgba_f32: Vec<f32> = vec![0.0f32; width * height * 4];
    // Tracks max(R,G,B) so the frontend can pick an exposure target.
    // Stored as AtomicU32 bit pattern (f32::to_bits) for lock-free updates.
    let dynamic_range: Arc<AtomicU32> = Arc::new(AtomicU32::new(0.0f32.to_bits()));

    // DBG-2026-07-13: log first 4 pixels of each RGB source buffer so we can
    // verify which channel/layer actually went into the output.
    eprintln!("[EXR-FFI-DBG] build_raw_rgba: width={} height={} channel_names={:?}", width, height, channel_names);
    if let Some(rb) = &r_buf {
        let r_info_v = r_info.unwrap_or((width, height, 2));
        eprintln!("[EXR-FFI-DBG] R buf len={} bpe={} ch_w={}", rb.len(), r_info_v.2, r_info_v.0);
        print_pixel_samples("R", &rb, r_info_v.0, r_info_v.2);
    }
    if let Some(gb) = &g_buf {
        let g_info_v = g_info.unwrap_or((width, height, 2));
        eprintln!("[EXR-FFI-DBG] G buf len={} bpe={} ch_w={}", gb.len(), g_info_v.2, g_info_v.0);
        print_pixel_samples("G", &gb, g_info_v.0, g_info_v.2);
    }
    if let Some(bb) = &b_buf {
        let b_info_v = b_info.unwrap_or((width, height, 2));
        eprintln!("[EXR-FFI-DBG] B buf len={} bpe={} ch_w={}", bb.len(), b_info_v.2, b_info_v.0);
        print_pixel_samples("B", &bb, b_info_v.0, b_info_v.2);
    }

    if let (Some(rb), Some(gb), Some(bb)) = (r_buf, g_buf, b_buf) {
        let (rw, rh, rbpe) = r_info.unwrap_or((width, height, 2));
        let (gw, gh, gbpe) = g_info.unwrap_or((width, height, 2));
        let (bw, bh, bbpe) = b_info.unwrap_or((width, height, 2));
        // 2026-07-05 alpha hotfix: capture alpha buffer (if any). When
        // `has_alpha` is true we disable the SIMD fast-path for this
        // frame because the SIMD inner loop fills 8 pixels per iteration
        // with hard-coded alpha=255; touching it to read from the alpha
        // buffer would require duplicating the half→u8 conversion for
        // the A channel inside `half_row_to_u8_x8`. Scalar is plenty
        // fast (~50ms for 1920×1080) and gets the right alpha.
        let (ab, abpe_opt, has_alpha): (Option<Vec<u8>>, i32, bool) = match a_buf {
            Some(buf) => {
                let (w_a, _h_a, bpe_a) = a_info.unwrap_or((width, height, 2));
                (Some(buf), bpe_a, true)
            }
            None => (None, 2, false),
        };

        let h = height.min(rh);
        let w = width.min(rw);

        // Debug: log buffer sizes so we can spot a size mismatch (this was
        // the bug that produced [0,0,0] for some files: shared buffer
        // was sized to image_height × image_width × max_bpe but the per-
        // channel size was image_height × ch_w × bpe, smaller for HALF).
        eprintln!("[EXR-FFI] build_raw_rgba: rb={}B gb={}B bb={}B → rgba_f32={}B ({w}x{h})",
            rb.len(), gb.len(), bb.len(), rgba_f32.len());

        // SIMD vs scalar row counts are tracked inside the parallel closure below;
        // loaded here after the join via Arc-shared counters.
        let t_interleave = std::time::Instant::now();

        let simd_rows = Arc::new(AtomicUsize::new(0));
        let scalar_rows = Arc::new(AtomicUsize::new(0));

        rgba.par_chunks_mut(w * 4).zip(rgba_f32.par_chunks_mut(w * 4)).enumerate().for_each({
            let dynamic_range = Arc::clone(&dynamic_range);
            let simd_rows = Arc::clone(&simd_rows);
            let scalar_rows = Arc::clone(&scalar_rows);
            move |(y, (row_slice, f32_row))| {
            if y >= h { return; }

            let use_simd = cfg!(target_arch = "x86_64")
                && !has_alpha  // 2026-07-05 alpha hotfix: disable SIMD when alpha channel exists
                && rbpe == 2 && gbpe == 2 && bbpe == 2
                && rw == w && gw == w && bw == w
                && rb.len() >= h * rw * 2
                && gb.len() >= h * gw * 2
                && bb.len() >= h * bw * 2
                && is_x86_feature_detected!("f16c");

            if use_simd {
                simd_rows.fetch_add(1, Ordering::Relaxed);
                let row_r = &rb[y * rw * 2..y * rw * 2 + w * 2];
                let row_g = &gb[y * gw * 2..y * gw * 2 + w * 2];
                let row_b = &bb[y * bw * 2..y * bw * 2 + w * 2];
                let n8 = w / 8;
                for chunk in 0..n8 {
                    let cb = chunk * 16;
                    let co = chunk * 32;
                    let mut rb_bits = [0u16; 8];
                    let mut gb_bits = [0u16; 8];
                    let mut bb_bits = [0u16; 8];
                    for j in 0..8 {
                        rb_bits[j] = u16::from_le_bytes([row_r[cb + j*2], row_r[cb + j*2 + 1]]);
                        gb_bits[j] = u16::from_le_bytes([row_g[cb + j*2], row_g[cb + j*2 + 1]]);
                        bb_bits[j] = u16::from_le_bytes([row_b[cb + j*2], row_b[cb + j*2 + 1]]);
                    }
                    let r_bytes = unsafe { half_row_to_u8_x8(&rb_bits) };
                    let g_bytes = unsafe { half_row_to_u8_x8(&gb_bits) };
                    let b_bytes = unsafe { half_row_to_u8_x8(&bb_bits) };
                    let r_floats = unsafe { half_row_to_f32_x8(&rb_bits) };
                    let g_floats = unsafe { half_row_to_f32_x8(&gb_bits) };
                    let b_floats = unsafe { half_row_to_f32_x8(&bb_bits) };
                    for j in 0..8 {
                        let off = co + j * 4;
                        row_slice[off]     = r_bytes[j];
                        row_slice[off + 1] = g_bytes[j];
                        row_slice[off + 2] = b_bytes[j];
                        row_slice[off + 3] = 255;
                        f32_row[off]     = r_floats[j];
                        f32_row[off + 1] = g_floats[j];
                        f32_row[off + 2] = b_floats[j];
                        f32_row[off + 3] = 1.0;
                        let maxc = r_floats[j].max(g_floats[j]).max(b_floats[j]);
                        if maxc.is_finite() { update_max_f32(&dynamic_range, maxc); }
                    }
                }
                let tail_start = n8 * 8;
                for x in tail_start..w {
                    let base = x * 2;
                    let r_bits = u16::from_le_bytes([row_r[base], row_r[base + 1]]);
                    let g_bits = u16::from_le_bytes([row_g[base], row_g[base + 1]]);
                    let b_bits = u16::from_le_bytes([row_b[base], row_b[base + 1]]);
                    let r_f = half_to_float(r_bits);
                    let g_f = half_to_float(g_bits);
                    let b_f = half_to_float(b_bits);
                    // 2026-07-05 alpha hotfix: read alpha from buffer
                    // when present; default to 255 / 1.0 (opaque) when
                    // the file has no A channel. This branch is reached
                    // only when `has_alpha` is false (SIMD path is
                    // disabled for alpha-bearing files), so `ab` is
                    // None here — fall back to opaque.
                    let (a_u8, a_f) = if has_alpha {
                        // SAFETY: SIMD path is gated off when has_alpha,
                        // so this tail is dead code in that case.
                        // Computed anyway for completeness.
                        (255u8, 1.0f32)
                    } else {
                        (255u8, 1.0f32)
                    };
                    let out = x * 4;
                    row_slice[out]     = sample_to_u8(r_f);
                    row_slice[out + 1] = sample_to_u8(g_f);
                    row_slice[out + 2] = sample_to_u8(b_f);
                    row_slice[out + 3] = a_u8;
                    f32_row[out]     = r_f;
                    f32_row[out + 1] = g_f;
                    f32_row[out + 2] = b_f;
                    f32_row[out + 3] = a_f;
                    let maxc = r_f.max(g_f).max(b_f);
                    if maxc.is_finite() { update_max_f32(&dynamic_range, maxc); }
                }
            } else {
                scalar_rows.fetch_add(1, Ordering::Relaxed);
                for x in 0..w {
                    let r_idx = y * rw * rbpe as usize + x * rbpe as usize;
                    let g_idx = y * gw * gbpe as usize + x * gbpe as usize;
                    let b_idx = y * bw * bbpe as usize + x * bbpe as usize;
                    let a_idx = y * w * abpe_opt as usize + x * abpe_opt as usize;
                    let out_idx = x * 4;

                    // 2026-07-12: The previous code only handled HALF
                    // (bpe == 2) and U8 (bpe == 1, mis-typed as bpe == 4
                    // via the `else` branch which read a single byte and
                    // divided by 255). For FLOAT channels (bpe == 4) that
                    // "else" branch silently read the LSB of each 32-bit
                    // pixel and discarded the other three bytes, producing
                    // pseudo-random noise in every frame. 32-bit scanline
                    // EXRs (e.g. HDRI output from LightWave/Blender) hit
                    // this path because the SIMD fast-path was already
                    // gated to `rbpe == gbpe == bbpe == 2` upstream.
                    let r_f = if r_idx + rbpe as usize - 1 < rb.len() {
                        if rbpe == 2 {
                            half_to_float(u16::from_le_bytes([rb[r_idx], rb[r_idx + 1]]))
                        } else if rbpe == 4 {
                            // IEEE-754 little-endian: bytes [0..4] → f32.
                            f32::from_le_bytes([
                                rb[r_idx],
                                rb[r_idx + 1],
                                rb[r_idx + 2],
                                rb[r_idx + 3],
                            ])
                        } else {
                            // Legacy 8-bit-per-element fallback. EXR spec
                            // doesn't really permit this but some writers
                            // emit UINT channels which we still treat as
                            // 8-bit here for back-compat.
                            rb[r_idx] as f32 / 255.0
                        }
                    } else { 0.5 };
                    let g_f = if g_idx + gbpe as usize - 1 < gb.len() {
                        if gbpe == 2 {
                            half_to_float(u16::from_le_bytes([gb[g_idx], gb[g_idx + 1]]))
                        } else if gbpe == 4 {
                            f32::from_le_bytes([
                                gb[g_idx],
                                gb[g_idx + 1],
                                gb[g_idx + 2],
                                gb[g_idx + 3],
                            ])
                        } else {
                            gb[g_idx] as f32 / 255.0
                        }
                    } else { 0.5 };
                    let b_f = if b_idx + bbpe as usize - 1 < bb.len() {
                        if bbpe == 2 {
                            half_to_float(u16::from_le_bytes([bb[b_idx], bb[b_idx + 1]]))
                        } else if bbpe == 4 {
                            f32::from_le_bytes([
                                bb[b_idx],
                                bb[b_idx + 1],
                                bb[b_idx + 2],
                                bb[b_idx + 3],
                            ])
                        } else {
                            bb[b_idx] as f32 / 255.0
                        }
                    } else { 0.5 };

                    // 2026-07-05 alpha hotfix: read alpha from the
                    // captured A channel. EXR stores linear-light alpha
                    // (or pre-multiplied, depending on writer). We hand
                    // the raw value through unchanged so the downstream
                    // GPU shader / canvas composite treats it as the
                    // compositing mask the artist intended. The clamp
                    // to [0, 1] is done in `sample_to_u8` for the U8
                    // path; the F32 path stores it directly.
                    let (a_u8, a_f) = if let Some(ab) = ab.as_ref() {
                        if a_idx + abpe_opt as usize - 1 < ab.len() {
                            if abpe_opt == 2 {
                                let a_f_local = half_to_float(u16::from_le_bytes([ab[a_idx], ab[a_idx + 1]]));
                                (sample_to_u8(a_f_local), a_f_local)
                            } else if abpe_opt == 4 {
                                // 2026-07-12: same bug as the RGB scalar
                                // path — was reading only the LSB of each
                                // 32-bit float. Now reads the full 4 bytes
                                // and converts IEEE-754 LE to f32.
                                let a_f_local = f32::from_le_bytes([
                                    ab[a_idx],
                                    ab[a_idx + 1],
                                    ab[a_idx + 2],
                                    ab[a_idx + 3],
                                ]);
                                (sample_to_u8(a_f_local), a_f_local)
                            } else {
                                let a_f_local = ab[a_idx] as f32 / 255.0;
                                (ab[a_idx], a_f_local)
                            }
                        } else {
                            (255u8, 1.0f32) // out-of-bounds alpha → opaque
                        }
                    } else {
                        (255u8, 1.0f32)
                    };

                    row_slice[out_idx]     = sample_to_u8(r_f);
                    row_slice[out_idx + 1] = sample_to_u8(g_f);
                    row_slice[out_idx + 2] = sample_to_u8(b_f);
                    row_slice[out_idx + 3] = a_u8;
                    f32_row[out_idx]     = r_f;
                    f32_row[out_idx + 1] = g_f;
                    f32_row[out_idx + 2] = b_f;
                    f32_row[out_idx + 3] = a_f;
                    let maxc = r_f.max(g_f).max(b_f);
                    if maxc.is_finite() { update_max_f32(&dynamic_range, maxc); }
                }
            }
        }});
        println!("[EXR-FFI] Interleave: SIMD_rows={}, scalar_rows={}, total={}, took={:.2?}",
            simd_rows.load(Ordering::Relaxed),
            scalar_rows.load(Ordering::Relaxed),
            h, t_interleave.elapsed());

        // IMPORTANT: fill rows beyond the decoded channel data with black.
        // DWAB-compressed files decode each chunk separately, and chunks are
        // distributed vertically across the frame (tile-based). When a chunk
        // doesn't cover the bottom portion of the frame, those rows keep the
        // initial `128` grey default, producing a grey horizontal band at the
        // bottom of the rendered image.  Filling with 0 (black) avoids this
        // artifact.  The alpha channel stays 255 so the band is invisible
        // rather than transparent.
        if h < height {
            let blank_rows = &mut rgba[(h * width * 4)..];
            for chunk in blank_rows.chunks_mut(width * 4) {
                for px in chunk.chunks_mut(4) {
                    px[0] = 0; // R
                    px[1] = 0; // G
                    px[2] = 0; // B
                    px[3] = 255; // A
                }
            }
            let blank_f32 = &mut rgba_f32[(h * width * 4)..];
            for chunk in blank_f32.chunks_mut(4) {
                chunk[0] = 0.0;
                chunk[1] = 0.0;
                chunk[2] = 0.0;
                chunk[3] = 1.0;
            }
        }

        // DEBUG: dump first 5x5 pixels to compare with Python decoder
        // Set RUST_EXR_DEBUG_PIXELS=1 to enable
        let debug_pixels = std::env::var("RUST_EXR_DEBUG_PIXELS").map(|v| v == "1").unwrap_or(false);
        if debug_pixels {
            let dynamic_max = f32::from_bits(dynamic_range.load(Ordering::Relaxed));
            eprintln!("[EXR-DEBUG] First 5x5 pixels (R,G,B) from FFI:");
            for y in 0..5.min(h) {
                let mut row_vals = String::new();
                for x in 0..5.min(w) {
                    let idx = (y * w + x) * 4;
                    if idx + 2 < rgba_f32.len() {
                        row_vals.push_str(&format!("  [{},{}]=({:.4},{:.4},{:.4})",
                            x, y, rgba_f32[idx], rgba_f32[idx+1], rgba_f32[idx+2]));
                    }
                }
                eprintln!("  Row{}:{}", y, row_vals);
            }
            eprintln!("[EXR-DEBUG] Dynamic range (max R,G,B): {:.4}", dynamic_max);
        }
    }

    let (regular_layers, _crypto) = ExrMetadata::parse_layers_from_channels(channel_names);
    let layer_names: Vec<String> = regular_layers.into_iter().map(|l| l.name).collect();
    let dr = f32::from_bits(dynamic_range.load(Ordering::Relaxed));
    Some(ExrRgbaResult {
        rgba,
        rgba_f32: Some(rgba_f32),
        dynamic_range: dr,
        width: width as u32,
        height: height as u32,
        channels: channel_names.to_vec(),
        layers_count: layer_names.len(),
        layer_names,
        // Filled in by the caller after detection (needs access to the buffer).
        pass_type: String::new(),
    })
}

pub fn extract_exr_thumbnail_ffi(path: &Path, max_size: usize) -> Option<ExrThumbResult> {
    println!("[EXR-FFI] Starting extraction from: {:?}", path);

    let core = match global_openexr_core() {
        Ok(c) => c,
        Err(e) => {
            println!("[EXR-FFI] OpenEXRCore::load() FAILED: {:?}", e);
            return None;
        }
    };

    println!("[EXR-FFI] OpenEXRCore loaded OK, opening file...");

    let reader = match core.start_read(path) {
        Ok(r) => r,
        Err(e) => {
            println!("[EXR-FFI] start_read error: {:?}", e);
            return None;
        }
    };

    let part_info = match reader.get_first_part_info() {
        Ok(info) => info,
        Err(e) => {
            println!("[EXR-FFI] get_first_part_info error: {:?}", e);
            return None;
        }
    };

    if part_info.is_deep() {
        println!("[EXR-FFI] Deep EXR not supported");
        return None;
    }

    let width = part_info.width().max(1) as usize;
    let height = part_info.height().max(1) as usize;
    let compression = part_info.compression;
    let chunk_count = part_info.chunk_count as usize;

    println!("[EXR-FFI] Image: {}x{}, compression: {:?}, chunks: {}", width, height, compression, chunk_count);

    let channel_names = match reader.get_channel_names(0) {
        Ok(names) => names,
        Err(_) => Vec::new(),
    };

    let storage = part_info.storage;

    println!("[EXR-FFI] Using full decode pipeline for {:?}", compression);
    let t_total = std::time::Instant::now();

    // Count layers so the sequential path can skip the sacrificial workaround
    // for single-layer EXRs (enabling the fast optimised 4-channel path).
    let num_layers = count_unique_layers(&channel_names);
    println!("[EXR-FFI] {} channels, {} layers", channel_names.len(), num_layers);

    // Reserve one shared buffer per channel (full-frame size). The shared-
    // buffer FFI path writes each decoded chunk at offset `start_y`, so the
    // final buffers hold the complete image even when there are >1 chunks.
    //
    // The previous per-chunk path (`decode_chunk_with_pipeline` + build_rgba)
    // always pointed `decode_to_ptr` at offset 0, so every chunk overwrote
    // the previous one and only the last chunk's pixels survived. For DWAB
    // EXRs with 5+ chunks that produced an image with ~80% black rows at
    // the top — the "không đủ hình" symptom.
    let n_channels = channel_names.len();
    let mut shared_buffers: Vec<Vec<u8>> = Vec::with_capacity(n_channels);
    for _ in 0..n_channels {
        // Reserve capacity; `decode_file_into_shared_buffers` / `decode_chunks_parallel_into_shared_buffers`
        // grow each buffer to its exact full-frame size via `set_len` / `resize`.
        shared_buffers.push(Vec::with_capacity(width * height * 4));
    }

    let shared_threads = crate::openexr_ffi::get_openexr_thread_count();
    let num_workers = chunk_count.min(
        if shared_threads > 0 { shared_threads as usize }
        else { std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).max(1) }
    );

    let f16c = cfg!(target_arch = "x86_64") && is_x86_feature_detected!("f16c");
    println!("[EXR-FFI] FFI fallback: shared_threads={}, num_workers={}, F16C={}",
        shared_threads, num_workers, f16c);

    // Sequential shared-buffer path: one context, all chunks via `exr_decoding_update`.
    // Used for small files (chunk_count < 4) or single-core hosts.
    if num_workers <= 1 || chunk_count < 4 {
        println!("[EXR-FFI] FFI fallback using SEQUENTIAL shared-buffer decode");
        let t = std::time::Instant::now();
        let channel_infos = match unsafe {
            decode_file_into_shared_buffers(&reader, 0, &part_info, storage, &mut shared_buffers, num_layers)
        } {
            Ok(infos) => infos,
            Err(e) => {
                println!("[EXR-FFI] sequential shared-buffer decode failed: {:?}", e);
                return None;
            }
        };
        println!("[EXR-FFI] FFI fallback sequential chunks: {:.2?}", t.elapsed());

        // Convert channel_infos + shared_buffers into the all_channels shape
        // build_thumb_from_shared_buffers expects.
        let mut all_channels: Vec<(String, usize, usize, i32, Vec<u8>)> =
            Vec::with_capacity(channel_infos.len());
        for (i, (name, w, h, bpe)) in channel_infos.into_iter().enumerate() {
            if i >= shared_buffers.len() { break; }
            let buf = std::mem::take(&mut shared_buffers[i]);
            all_channels.push((name, w, h, bpe, buf));
        }

        let result = build_thumb_from_shared_buffers(all_channels, width, height, max_size, &channel_names);
        println!("[EXR-FFI] FFI fallback total: {:.2?}", t_total.elapsed());
        return result;
    }

    // Parallel shared-buffer path: each worker decodes its chunks on its own
    // context, the main thread merges them into shared_buffers at the right
    // row offset (handled inside `decode_chunks_parallel_into_shared_buffers`).
    println!("[EXR-FFI] FFI fallback using PARALLEL shared-buffer decode: {} chunks across {} workers",
        chunk_count, num_workers);

    let t_chunks = std::time::Instant::now();
    let channel_infos = match unsafe {
        decode_chunks_parallel_into_shared_buffers(path, &part_info, storage, &mut shared_buffers, num_layers)
    } {
        Ok(infos) => infos,
        Err(e) => {
            println!("[EXR-FFI] parallel shared-buffer decode failed: {:?}", e);
            return None;
        }
    };
    println!("[EXR-FFI] FFI fallback parallel chunks: {:.2?}", t_chunks.elapsed());

    let mut all_channels: Vec<(String, usize, usize, i32, Vec<u8>)> =
        Vec::with_capacity(channel_infos.len());
    for (i, (name, w, h, bpe)) in channel_infos.into_iter().enumerate() {
        if i >= shared_buffers.len() { break; }
        let buf = std::mem::take(&mut shared_buffers[i]);
        all_channels.push((name, w, h, bpe, buf));
    }

    let result = build_thumb_from_shared_buffers(all_channels, width, height, max_size, &channel_names);
    println!("[EXR-FFI] FFI fallback total: {:.2?}", t_total.elapsed());
    result
}

/// Build a thumbnail PNG from full-frame shared channel buffers.
///
/// Unlike `build_rgba_from_channels` (the old per-chunk path), each input
/// channel buffer here is already sized to the full image (height × width × bpe)
/// because the shared-buffer FFI path writes every decoded chunk at its
/// `start_y` offset inside the buffer. So we read rows 0..height directly
/// without the chunk_height clamping that produced the "missing rows" bug.
fn build_thumb_from_shared_buffers(
    all_channels: Vec<(String, usize, usize, i32, Vec<u8>)>,
    width: usize,
    height: usize,
    max_size: usize,
    channel_names: &[String],
) -> Option<ExrThumbResult> {

    // Find R, G, B channel buffers (first match wins, also catches
    // multi-layer "Beauty.R" / "Diffuse.G" / "Specular.B" patterns).
    let mut r_buf: Option<Vec<u8>> = None;
    let mut g_buf: Option<Vec<u8>> = None;
    let mut b_buf: Option<Vec<u8>> = None;
    let mut r_info: Option<(usize, usize, i32)> = None;
    let mut g_info: Option<(usize, usize, i32)> = None;
    let mut b_info: Option<(usize, usize, i32)> = None;

    for (name, w, h, bpe, buf) in all_channels {
        let upper = name.to_uppercase();
        let is_r = upper == "R" || upper == "RED" || upper.ends_with(".R");
        let is_g = upper == "G" || upper == "GREEN" || upper.ends_with(".G");
        let is_b = upper == "B" || upper == "BLUE" || upper.ends_with(".B");
        if r_buf.is_none() && is_r {
            r_buf = Some(buf);
            r_info = Some((w, h, bpe));
        } else if g_buf.is_none() && is_g {
            g_buf = Some(buf);
            g_info = Some((w, h, bpe));
        } else if b_buf.is_none() && is_b {
            b_buf = Some(buf);
            b_info = Some((w, h, bpe));
        }
    }

    // Default to mid-grey so any rows a particular channel couldn't supply
    // (e.g. an HDR file clipped at NaN) stay visible instead of black.
    let mut rgba_data = vec![128u8; width * height * 4];

    if let (Some(rb), Some(gb), Some(bb)) = (r_buf, g_buf, b_buf) {
        let (rw, rh, rbpe) = r_info.unwrap_or((width, height, 2));
        let (gw, gh, gbpe) = g_info.unwrap_or((width, height, 2));
        let (bw, bh, bbpe) = b_info.unwrap_or((width, height, 2));

        println!("[EXR-FFI] Building thumb RGBA from R({}x{},{}bpe), G({}x{},{}bpe), B({}x{},{}bpe)",
            rw, rh, rbpe, gw, gh, gbpe, bw, bh, bbpe);

        // Shared buffers already cover the full image, so we can use the
        // full width/height directly — no clamping needed.
        let h = height;
        let w = width;

        use std::sync::atomic::{AtomicUsize, Ordering};
        let simd_rows = AtomicUsize::new(0);
        let scalar_rows = AtomicUsize::new(0);
        let t_interleave = std::time::Instant::now();

        let rb = rb.clone();
        let gb = gb.clone();
        let bb = bb.clone();

        rgba_data.par_chunks_mut(w * 4).enumerate().for_each(|(y, row_slice)| {
            if y >= h { return; }

            // SIMD fast path: x86_64 + F16C + all 3 channels are half-float (bpe=2).
            let use_simd = cfg!(target_arch = "x86_64")
                && rbpe == 2 && gbpe == 2 && bbpe == 2
                && rw == w && gw == w && bw == w
                && rb.len() >= h * rw * 2
                && gb.len() >= h * gw * 2
                && bb.len() >= h * bw * 2
                && is_x86_feature_detected!("f16c");

            if use_simd {
                simd_rows.fetch_add(1, Ordering::Relaxed);
                let row_r = &rb[y * rw * 2..y * rw * 2 + w * 2];
                let row_g = &gb[y * gw * 2..y * gw * 2 + w * 2];
                let row_b = &bb[y * bw * 2..y * bw * 2 + w * 2];
                let n8 = w / 8;
                for chunk in 0..n8 {
                    let cb = chunk * 16;
                    let co = chunk * 32;
                    let mut rb_bits = [0u16; 8];
                    let mut gb_bits = [0u16; 8];
                    let mut bb_bits = [0u16; 8];
                    for j in 0..8 {
                        rb_bits[j] = u16::from_le_bytes([row_r[cb + j*2], row_r[cb + j*2 + 1]]);
                        gb_bits[j] = u16::from_le_bytes([row_g[cb + j*2], row_g[cb + j*2 + 1]]);
                        bb_bits[j] = u16::from_le_bytes([row_b[cb + j*2], row_b[cb + j*2 + 1]]);
                    }
                    let r_bytes = unsafe { half_row_to_u8_x8(&rb_bits) };
                    let g_bytes = unsafe { half_row_to_u8_x8(&gb_bits) };
                    let b_bytes = unsafe { half_row_to_u8_x8(&bb_bits) };
                    for j in 0..8 {
                        let off = co + j * 4;
                        row_slice[off]     = r_bytes[j];
                        row_slice[off + 1] = g_bytes[j];
                        row_slice[off + 2] = b_bytes[j];
                        row_slice[off + 3] = 255;
                    }
                }
                let tail_start = n8 * 8;
                for x in tail_start..w {
                    let base = x * 2;
                    let r_bits = u16::from_le_bytes([row_r[base], row_r[base + 1]]);
                    let g_bits = u16::from_le_bytes([row_g[base], row_g[base + 1]]);
                    let b_bits = u16::from_le_bytes([row_b[base], row_b[base + 1]]);
                    let out = x * 4;
                    row_slice[out]     = sample_to_u8(half_to_float(r_bits));
                    row_slice[out + 1] = sample_to_u8(half_to_float(g_bits));
                    row_slice[out + 2] = sample_to_u8(half_to_float(b_bits));
                    row_slice[out + 3] = 255;
                }
            } else {
                scalar_rows.fetch_add(1, Ordering::Relaxed);
                for x in 0..w {
                    let r_idx = y * rw * rbpe as usize + x * rbpe as usize;
                    let g_idx = y * gw * gbpe as usize + x * gbpe as usize;
                    let b_idx = y * bw * bbpe as usize + x * bbpe as usize;
                    let out_idx = x * 4;

                    let r_val = if r_idx + rbpe as usize - 1 < rb.len() {
                        if rbpe == 2 {
                            let bits = u16::from_le_bytes([rb[r_idx], rb[r_idx + 1]]);
                            sample_to_u8(half_to_float(bits))
                        } else {
                            rb[r_idx]
                        }
                    } else { 128u8 };

                    let g_val = if g_idx + gbpe as usize - 1 < gb.len() {
                        if gbpe == 2 {
                            let bits = u16::from_le_bytes([gb[g_idx], gb[g_idx + 1]]);
                            sample_to_u8(half_to_float(bits))
                        } else {
                            gb[g_idx]
                        }
                    } else { 128u8 };

                    let b_val = if b_idx + bbpe as usize - 1 < bb.len() {
                        if bbpe == 2 {
                            let bits = u16::from_le_bytes([bb[b_idx], bb[b_idx + 1]]);
                            sample_to_u8(half_to_float(bits))
                        } else {
                            bb[b_idx]
                        }
                    } else { 128u8 };

                    row_slice[out_idx] = r_val;
                    row_slice[out_idx + 1] = g_val;
                    row_slice[out_idx + 2] = b_val;
                    row_slice[out_idx + 3] = 255;
                }
            }
        });

        println!("[EXR-FFI] Interleave: SIMD_rows={}, scalar_rows={}, total={}, took={:.2?}",
            simd_rows.load(Ordering::Relaxed),
            scalar_rows.load(Ordering::Relaxed),
            h, t_interleave.elapsed());

        let sum: u64 = rgba_data.iter().map(|&b| b as u64).sum();
        println!("[EXR-FFI] RGBA sum: {}", sum);

        if sum == 0 || sum == (128u64 * 4) * (width * height) as u64 {
            println!("[EXR-FFI] WARNING: All pixels are gray (128) - channel data may be empty");
        }
    } else {
        println!("[EXR-FFI] No RGB channels found, using placeholder");
        rgba_data.par_chunks_mut(width * 4).enumerate().for_each(|(y, row_slice)| {
            for x in 0..width {
                let t = (x + y) as f32 / (width + height - 2).max(1) as f32;
                let idx = x * 4;
                row_slice[idx] = (128.0 * t + 30.0 * (1.0 - t)) as u8;
                row_slice[idx + 1] = (128.0 * t + 30.0 * (1.0 - t)) as u8;
                row_slice[idx + 2] = (128.0 * t + 30.0 * (1.0 - t)) as u8;
                row_slice[idx + 3] = 255;
            }
        });
    }

    let img_buffer = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(width as u32, height as u32, rgba_data)?;
    let (tw, th) = calc_thumb_dims(width as u32, height as u32, max_size);
    let resized = image::imageops::resize(&img_buffer, tw, th, image::imageops::FilterType::Lanczos3);

    let mut png_buf = Vec::new();
    if resized.write_to(&mut std::io::Cursor::new(&mut png_buf), ImageFormat::Png).is_ok() {
        // Use `parse_layers_from_channels` so single-layer root EXRs (just R/G/B
        // with no "Beauty." prefix) are reported as 1 layer, matching the
        // behaviour of `get_exr_metadata`. The previous
        // `extract_layer_names_from_channels` returned 0 for these files.
        let (regular_layers, _crypto) = ExrMetadata::parse_layers_from_channels(channel_names);
        let layer_names: Vec<String> = regular_layers.into_iter().map(|l| l.name).collect();

        Some(ExrThumbResult {
            png_data: png_buf,
            width: width as u32,
            height: height as u32,
            method: "openexr_ffi".to_string(),
            layers_count: layer_names.len(),
            channels: channel_names.to_vec(),
            cryptomatte_layers: vec![],
            layer_names,
        })
    } else {
        None
    }
}

fn calc_thumb_dims(width: u32, height: u32, max_size: usize) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (1, 1);
    }
    let max = max_size as u32;
    if width >= height {
        let h = ((height as f64 / width as f64) * max as f64).ceil().max(1.0) as u32;
        (max, h)
    } else {
        let w = ((width as f64 / height as f64) * max as f64).ceil().max(1.0) as u32;
        (w, max)
    }
}

// ============================================================================
// Fast Metadata-Only Extraction (NO pixel decode)
// ============================================================================

/// Extract EXR metadata WITHOUT decoding any pixels.
/// This is extremely fast (~10-50ms) compared to full decode (~3-10s).
pub fn extract_exr_metadata_fast(path: &Path) -> Option<ExrMetadata> {
    println!("[EXR-META] Fast metadata extraction from: {:?}", path);

    // OpenEXRCore FFI only — no Python fallback.
    extract_exr_metadata_with_ffi(path)
}

/// Metadata extraction using OpenEXRCore FFI
///
/// 2026-07-12: the previous implementation hard-coded
/// `pixel_type: "float".to_string()`, which conflated HALF and FLOAT files
/// on the JS side. That ambiguity caused the RawLinearCache to allocate
/// the wrong buffer size for 32-bit float scanlines, and the mis-shapen
/// FFI result triggered a "Maximum update depth exceeded" loop in
/// `useExrPlayback`. We now read the real per-channel `pixel_type` from
/// `exr_get_channels` (UINT=0 / HALF=1 / FLOAT=2) and pick the *widest*
/// type across all channels so multi-layer EXRs that mix a HALF "Beauty"
/// with a FLOAT "Z" depth channel report "float" (the conservative
/// choice — consumers should treat the report as "F32-capable").
fn extract_exr_metadata_with_ffi(path: &Path) -> Option<ExrMetadata> {
    let core = global_openexr_core().ok()?;
    let reader = core.start_read(path).ok()?;

    let part_info = reader.get_first_part_info().ok()?;

    if part_info.is_deep() {
        return None; // Deep EXR not supported
    }

    let width = part_info.width().max(1) as u32;
    let height = part_info.height().max(1) as u32;

    // Pull both names AND per-channel pixel types in one FFI call so we
    // don't pay for the header parse twice. Falls back to name-only if
    // the typed variant fails (older OpenEXRCore builds), which still
    // preserves the legacy `"float"` placeholder behaviour.
    let (channel_names, pixel_type) = match reader.get_channel_pixel_types(0) {
        Ok(pairs) if !pairs.is_empty() => {
            let names: Vec<String> = pairs.iter().map(|(n, _)| n.clone()).collect();
            // Numeric ranking: UINT < HALF < FLOAT. Max wins so FLOAT
            // channels are never silently downgraded to HALF.
            let worst = pairs
                .iter()
                .map(|(_, pt)| match pt {
                    ExrPixelType::Uint => 0,
                    ExrPixelType::Half => 1,
                    ExrPixelType::Float | ExrPixelType::Unknown => 2,
                })
                .max()
                .unwrap_or(2);
            let label = match worst {
                0 => "uint",
                1 => "half",
                _ => "float",
            };
            (names, label.to_string())
        }
        _ => {
            // Fallback: legacy path. Preserve the original behaviour so
            // a regression in `get_channel_pixel_types` doesn't break
            // metadata extraction entirely.
            let names = reader.get_channel_names(0).ok()?;
            (names, "float".to_string())
        }
    };

    let (layers, cryptomatte_layers) = ExrMetadata::parse_layers_from_channels(&channel_names);

    // Get compression info
    let compression = format!("{:?}", part_info.compression);

    println!(
        "[EXR-META] {}x{} channels={} pixel_type={} comp={}",
        width, height, channel_names.len(), pixel_type, compression
    );

    Some(ExrMetadata {
        width,
        height,
        channel_names,
        layer_names: layers,
        cryptomatte_layers,
        compression,
        pixel_type,
    })
}

// ============================================================================
// Extract Individual Channel as Grayscale PNG
// ============================================================================

/// Extract a specific channel from EXR file and return as grayscale PNG.
///
/// Uses the same shared-buffer-per-channel decode pattern as
/// `extract_exr_channel_from_layer` (decodes all chunks then merges each
/// chunk's compact buffer into the correct vertical offset of a full-frame
/// shared buffer) so that multi-chunk files aren't truncated to the height
/// of the last decoded chunk.
pub fn extract_exr_channel(path: &Path, channel_name: &str) -> Option<ChannelExtractResult> {
    println!("[EXR-Channel] Extracting channel '{}' from {:?}", channel_name, path);
    println!("[EXR-Channel] Trying OpenEXRCore FFI...");

    let core = match global_openexr_core() {
        Ok(c) => c,
        Err(e) => {
            println!("[EXR-Channel] OpenEXRCore::load() FAILED: {:?}", e);
            return None;
        }
    };

    let reader = match core.start_read(path) {
        Ok(r) => r,
        Err(e) => {
            println!("[EXR-Channel] start_read error: {:?}", e);
            return None;
        }
    };

    let part_info = match reader.get_first_part_info() {
        Ok(info) => info,
        Err(e) => {
            println!("[EXR-Channel] get_first_part_info error: {:?}", e);
            return None;
        }
    };

    if part_info.is_deep() {
        println!("[EXR-Channel] Deep EXR not supported");
        return None;
    }

    let width = part_info.width().max(1) as usize;
    let height = part_info.height().max(1) as usize;
    let storage = part_info.storage;
    let chunk_count = part_info.chunk_count as usize;
    let scanlines_per_chunk = part_info.scanlines_per_chunk;
    let data_window_min_y = part_info.data_window.min_y;

    let channel_names_main: Vec<String> = match reader.get_channel_names(0) {
        Ok(names) => names,
        Err(e) => {
            println!("[EXR-Channel] get_channel_names failed: {:?}", e);
            return None;
        }
    };
    let n_channels = channel_names_main.len();
    if n_channels == 0 {
        println!("[EXR-Channel] No channels in header");
        return None;
    }

    // Count layers for the sacrificial-channel workaround (single-layer EXR → skip it).
    let num_layers = count_unique_layers(&channel_names_main);

    // Probe chunk 0 to discover (width, bpe) per channel.
    let mut probe_meta: std::collections::HashMap<String, (usize, i32)> = std::collections::HashMap::new();
    if chunk_count > 0 {
        if let Ok((_, _, chunk0_chans)) = unsafe {
            decode_one_chunk(&reader, 0, 0, storage, scanlines_per_chunk, data_window_min_y, num_layers)
        } {
            for (name, bpe, ch_w, _) in chunk0_chans {
                probe_meta.insert(name, (ch_w, bpe));
            }
        }
    }

    // Build full-frame shared buffer per channel (image_height × width × bpe).
    let mut shared_widths: Vec<usize> = Vec::with_capacity(n_channels);
    let mut shared_bpes: Vec<i32> = Vec::with_capacity(n_channels);
    let mut shared_buffers: Vec<Vec<u8>> = Vec::with_capacity(n_channels);
    let mut name_to_idx: std::collections::HashMap<String, usize> = std::collections::HashMap::with_capacity(n_channels);
    for (i, name) in channel_names_main.iter().enumerate() {
        let (ch_w, bpe) = probe_meta.get(name).copied().unwrap_or((width, 2));
        shared_widths.push(ch_w);
        shared_bpes.push(bpe);
        let buf_size = height * ch_w * bpe as usize;
        shared_buffers.push(vec![0u8; buf_size.max(1)]);
        name_to_idx.insert(name.clone(), i);
    }

    // Decode each chunk and merge into shared buffer at correct vertical offset.
    for chunk_idx in 0..chunk_count {
        match unsafe { decode_one_chunk(&reader, 0, chunk_idx as i32, storage, scanlines_per_chunk, data_window_min_y, num_layers) } {
            Ok((start_y, ch_h, chunk_chans)) => {
                let row_offset = (start_y - data_window_min_y).max(0) as usize;
                let rows = if row_offset < height {
                    (height - row_offset).min(ch_h.max(0) as usize)
                } else {
                    0
                };
                for (name, bpe, ch_w, buf) in chunk_chans.into_iter() {
                    let dst_idx = match name_to_idx.get(&name) {
                        Some(&i) => i,
                        None => continue,
                    };
                    if dst_idx >= shared_buffers.len() { continue; }
                    let shared_w = shared_widths[dst_idx];
                    let row_bytes = ch_w * bpe as usize;
                    let shared_row_bytes = shared_w * bpe as usize;
                    let total_bytes_needed = rows * row_bytes;
                    if row_bytes == 0 || total_bytes_needed > buf.len() { continue; }
                    if row_bytes == shared_row_bytes {
                        let dst_base = row_offset * shared_row_bytes;
                        if dst_base + total_bytes_needed <= shared_buffers[dst_idx].len() {
                            let src_ptr = buf.as_ptr();
                            let dst_ptr = unsafe { shared_buffers[dst_idx].as_mut_ptr().add(dst_base) };
                            unsafe { std::ptr::copy_nonoverlapping(src_ptr, dst_ptr, total_bytes_needed); }
                        }
                    } else {
                        let mut dst_row = row_offset;
                        let mut src_off = 0usize;
                        for _ in 0..rows {
                            let dst_base = dst_row * shared_row_bytes;
                            if dst_base + row_bytes > shared_buffers[dst_idx].len() { break; }
                            shared_buffers[dst_idx][dst_base..dst_base + row_bytes]
                                .copy_from_slice(&buf[src_off..src_off + row_bytes]);
                            src_off += row_bytes;
                            dst_row += 1;
                        }
                    }
                }
            }
            Err(e) => {
                println!("[EXR-Channel] Chunk {} decode failed: {:?}", chunk_idx, e);
            }
        }
    }

    // Find the requested channel: prefer exact name match; otherwise allow
    // suffix match (channel name with optional ".layer" prefix).
    let channel_upper = channel_name.to_uppercase();
    let channel_lower = channel_name.to_lowercase();
    let channel_dot_upper = format!(".{}", channel_upper);
    let channel_dot_lower = format!(".{}", channel_lower);
    let target_idx: Option<(String, usize)> = channel_names_main.iter().enumerate().find_map(|(i, n)| {
        let n_up = n.to_uppercase();
        let n_low = n.to_lowercase();
        let p1 = n_up == channel_upper || n_low == channel_lower;
        let p2 = n_up.ends_with(&channel_dot_upper) || n_low.ends_with(&channel_dot_lower);
        if p1 || p2 { Some((n.clone(), i)) } else { None }
    });

    if let Some((name, dst_idx)) = target_idx {
        println!("[EXR-Channel] Found channel '{}' ({}x{}, bpe={})",
            name, shared_widths[dst_idx], height, shared_bpes[dst_idx]);
        let ch_w = shared_widths[dst_idx];
        let bpe = shared_bpes[dst_idx];
        let buf = &shared_buffers[dst_idx];

        let mut rgba_data = vec![128u8; width * height * 4];

        for y in 0..height {
            for x in 0..width.min(ch_w) {
                let src_idx = y * ch_w + x;
                let out_idx = (y * width + x) * 4;

                if src_idx * (bpe as usize) + (bpe as usize) <= buf.len() && out_idx + 3 < rgba_data.len() {
                    let val = if bpe == 2 {
                        let bits = u16::from_le_bytes([buf[src_idx * 2], buf[src_idx * 2 + 1]]);
                        half_to_float(bits).max(0.0).min(1.0)
                    } else if bpe == 4 {
                        f32::from_le_bytes([buf[src_idx * 4], buf[src_idx * 4 + 1], buf[src_idx * 4 + 2], buf[src_idx * 4 + 3]])
                            .max(0.0).min(1.0)
                    } else if bpe == 1 {
                        (buf[src_idx] as f32 / 255.0).max(0.0).min(1.0)
                    } else {
                        0.5
                    };
                    let v = (val * 255.0) as u8;
                    rgba_data[out_idx] = v;
                    rgba_data[out_idx + 1] = v;
                    rgba_data[out_idx + 2] = v;
                    rgba_data[out_idx + 3] = 255;
                }
            }
        }

        let img_buffer = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(width as u32, height as u32, rgba_data)?;
        let mut png_buf = Vec::new();

        if img_buffer.write_to(&mut std::io::Cursor::new(&mut png_buf), ImageFormat::Png).is_ok() {
            return Some(ChannelExtractResult {
                png_data: png_buf,
                width: width as u32,
                height: height as u32,
                channel_name: name.clone(),
            });
        }
    }

    println!("[EXR-Channel] Channel '{}' not found", channel_name);
    None
}

/// Result structure for channel extraction
pub struct ChannelExtractResult {
    pub png_data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub channel_name: String,
}

/// Extract a specific channel from a specific layer in EXR file.
///
/// `max_size` (2026-07-05, channel-RGB parity):
///   - `None` → return the PNG at the EXR's native resolution.
///   - `Some(n)` → if either the source width or height exceeds `n`,
///     downscale the PNG to fit a `max(n, n)` bounding box (aspect
///     preserved) before encoding. The channel-buffer decode still
///     happens at native resolution (we don't re-sample in FFI); the
///     resize happens once on the grayscale `rgba_data` before PNG
///     encoding, matching how the RGB thumbnail pipeline
///     (`extract_exr_thumbnail_ffi` → `calc_thumb_dims` →
///     `image::imageops::resize`) does it.
pub fn extract_exr_channel_from_layer(path: &Path, channel_name: &str, layer_name: &str, max_size: Option<u32>) -> Option<ChannelExtractResult> {
    println!("[EXR-Channel-Layer] Extracting '{}' from layer '{}' in {:?} (max_size={:?})", channel_name, layer_name, path, max_size);

    // OpenEXRCore FFI only — decode all chunks and filter by layer prefix.
    let core = match global_openexr_core() {
        Ok(c) => c,
        Err(e) => {
            println!("[EXR-Channel-Layer] OpenEXRCore load failed: {:?}", e);
            return None;
        }
    };

    let reader = match core.start_read(path) {
        Ok(r) => r,
        Err(e) => {
            println!("[EXR-Channel-Layer] start_read failed: {:?}", e);
            return None;
        }
    };

    let part_info = match reader.get_first_part_info() {
        Ok(info) => info,
        Err(e) => {
            println!("[EXR-Channel-Layer] get_first_part_info failed: {:?}", e);
            return None;
        }
    };

    if part_info.is_deep() {
        println!("[EXR-Channel-Layer] Deep EXR not supported");
        return None;
    }

    let width = part_info.width().max(1) as usize;
    let height = part_info.height().max(1) as usize;
    let storage = part_info.storage;
    let chunk_count = part_info.chunk_count as usize;
    let scanlines_per_chunk = part_info.scanlines_per_chunk;
    let data_window_min_y = part_info.data_window.min_y;

    // Build a probe on chunk 0 to discover (channel name → (width, bpe)) for
    // every channel in the file. Multi-layer EXRs distribute channels across
    // chunks, so chunk 0 alone won't show the full list — we still need the
    // header channel list, but for width/bpe we use chunk 0 as a best-effort
    // probe and fall back to (image_width, 2) for channels not observed.
    let channel_names_main: Vec<String> = match reader.get_channel_names(0) {
        Ok(names) => names,
        Err(e) => {
            println!("[EXR-Channel-Layer] get_channel_names failed: {:?}", e);
            return None;
        }
    };
    let n_channels = channel_names_main.len();
    if n_channels == 0 {
        println!("[EXR-Channel-Layer] No channels reported in header");
        return None;
    }

    // Count layers for the sacrificial-channel workaround (single-layer EXR → skip it).
    let num_layers = count_unique_layers(&channel_names_main);

    let mut probe_meta: std::collections::HashMap<String, (usize, i32)> = std::collections::HashMap::new();
    if chunk_count > 0 {
        if let Ok((_, _, chunk0_chans)) = unsafe {
            decode_one_chunk(&reader, 0, 0, storage, scanlines_per_chunk, data_window_min_y, num_layers)
        } {
            for (name, bpe, ch_w, _) in chunk0_chans {
                probe_meta.insert(name, (ch_w, bpe));
            }
        }
    }

    // Build full-frame shared buffer per channel (image_height × width × bpe).
    let mut shared_widths: Vec<usize> = Vec::with_capacity(n_channels);
    let mut shared_bpes: Vec<i32> = Vec::with_capacity(n_channels);
    let mut shared_buffers: Vec<Vec<u8>> = Vec::with_capacity(n_channels);
    let mut name_to_idx: std::collections::HashMap<String, usize> = std::collections::HashMap::with_capacity(n_channels);
    for (i, name) in channel_names_main.iter().enumerate() {
        let (ch_w, bpe) = probe_meta.get(name).copied().unwrap_or((width, 2));
        shared_widths.push(ch_w);
        shared_bpes.push(bpe);
        let buf_size = height * ch_w * bpe as usize;
        shared_buffers.push(vec![0u8; buf_size.max(1)]);
        name_to_idx.insert(name.clone(), i);
    }

    // Decode each chunk with `decode_one_chunk` (compact per-chunk buffer),
    // then copy its rows into the right vertical slot of each shared buffer.
    for chunk_idx in 0..chunk_count {
        match unsafe { decode_one_chunk(&reader, 0, chunk_idx as i32, storage, scanlines_per_chunk, data_window_min_y, num_layers) } {
            Ok((start_y, ch_h, chunk_chans)) => {
                let row_offset = (start_y - data_window_min_y).max(0) as usize;
                let rows = if row_offset < height {
                    (height - row_offset).min(ch_h.max(0) as usize)
                } else {
                    0
                };
                for (name, bpe, ch_w, buf) in chunk_chans.into_iter() {
                    let dst_idx = match name_to_idx.get(&name) {
                        Some(&i) => i,
                        None => continue,
                    };
                    if dst_idx >= shared_buffers.len() { continue; }
                    let shared_w = shared_widths[dst_idx];
                    let row_bytes = ch_w * bpe as usize;
                    let shared_row_bytes = shared_w * bpe as usize;
                    let total_bytes_needed = rows * row_bytes;
                    if row_bytes == 0 || total_bytes_needed > buf.len() { continue; }
                    if row_bytes == shared_row_bytes {
                        let dst_base = row_offset * shared_row_bytes;
                        if dst_base + total_bytes_needed <= shared_buffers[dst_idx].len() {
                            let src_ptr = buf.as_ptr();
                            let dst_ptr = unsafe { shared_buffers[dst_idx].as_mut_ptr().add(dst_base) };
                            unsafe { std::ptr::copy_nonoverlapping(src_ptr, dst_ptr, total_bytes_needed); }
                        }
                    } else {
                        let mut dst_row = row_offset;
                        let mut src_off = 0usize;
                        for _ in 0..rows {
                            let dst_base = dst_row * shared_row_bytes;
                            if dst_base + row_bytes > shared_buffers[dst_idx].len() { break; }
                            shared_buffers[dst_idx][dst_base..dst_base + row_bytes]
                                .copy_from_slice(&buf[src_off..src_off + row_bytes]);
                            src_off += row_bytes;
                            dst_row += 1;
                        }
                    }
                }
            }
            Err(e) => {
                println!("[EXR-Channel-Layer] Chunk {} decode failed: {:?}", chunk_idx, e);
            }
        }
    }

    // Build expected channel name with layer prefix
    let layer_prefix_lower = format!("{}.", layer_name.to_lowercase());
    let layer_prefix_upper = format!("{}.", layer_name.to_uppercase());
    let channel_upper = channel_name.to_uppercase();
    let channel_lower = channel_name.to_lowercase();
    let channel_only_upper = format!(".{}", channel_upper);
    let channel_only_lower = format!(".{}", channel_lower);

    // Find target channel index by matching against the header channel list.
    //
    // Priority order is critical here. We must prefer channels that ACTUALLY
    // belong to the requested layer over channels that simply match by
    // component suffix. Without this, a multi-layer EXR like `Rnd_0015.exr`
    // (channels include `Motion vector.G` at idx 43 and a leftover bare `G`
    // at idx 41) would return the bare `G` for `extract_exr_channel_from_layer
    // (path, "G", "Motion vector")` — even though the bare `G` is intended
    // as the file's root composite (Beauty-like), not as Motion Vector's G.
    //
    // The fix: run TWO find_map passes — first looking exclusively for
    // layer-prefixed matches (Priority A: exact layer match + Priority B:
    // suffix-in-layer), and only fall back to bare-channel / wildcard
    // matches (Priority C) if pass A returned nothing. Same for the
    // "rgba" synthetic layer bare-channel case.
    let target_idx: Option<(String, usize)> = {
        // Pass A: channels that are explicitly under the requested layer
        // (e.g. `Motion vector.G`, `Motion vector.g`, etc.). `.g` vs `.G`
        // is a real thing in some pipelines so we check both cases.
        let prefixed = channel_names_main.iter().enumerate().find_map(|(i, n)| {
            let n_up = n.to_uppercase();
            let n_low = n.to_lowercase();

            // Priority A1: exact layer.component match (case-insensitive)
            let p1 = n_up == format!("{}.{}", layer_name.to_uppercase(), channel_upper);
            let p2 = n_low == format!("{}.{}", layer_name.to_lowercase(), channel_lower);

            // Priority A2: any channel whose name starts with the layer
            // prefix (case-insensitive) AND ends with ".channel".
            let p4 = n_low.starts_with(&layer_prefix_lower)
                && (n_up.ends_with(&channel_only_upper) || n_low.ends_with(&channel_only_lower));

            if p1 || p2 || p4 { Some((n.clone(), i)) } else { None }
        });

        if prefixed.is_some() {
            prefixed
        } else {
            // Pass B: fall back to bare-channel or wildcard matches. This is
            // what we want for files where the layer is the synthetic "rgba"
            // (bare R/G/B/A) or where layer_name is empty.
            channel_names_main.iter().enumerate().find_map(|(i, n)| {
                let n_up = n.to_uppercase();
                let n_low = n.to_lowercase();

                // Priority B1: bare-channel match (no dot in name). Only used
                // for the "rgba" / empty-layer synthetic case — bare channels
                // do NOT count as belonging to a named layer.
                let p3 = !n_low.contains('.')
                    && (n_up == channel_upper || n_low == channel_lower)
                    && (layer_name.is_empty() || layer_name.eq_ignore_ascii_case("rgba"));

                // Priority B2: layer_name empty → bare or any .channel.
                let p5 = layer_name.is_empty()
                    && (n_up == channel_upper || n_up.ends_with(&channel_only_upper));

                if p3 || p5 { Some((n.clone(), i)) } else { None }
            })
        }
    };

    if let Some((name, dst_idx)) = target_idx {
        println!("[EXR-Channel-Layer] Found '{}' in layer '{}'", name, layer_name);
        let ch_w = shared_widths[dst_idx];
        let ch_h = height;
        let bpe = shared_bpes[dst_idx];
        let buf = &shared_buffers[dst_idx];

        let mut rgba_data = vec![128u8; width * height * 4];

        for y in 0..ch_h {
            for x in 0..width.min(ch_w) {
                let src_idx = y * ch_w + x;
                let dst_idx4 = (y * width + x) * 4;

                if src_idx * (bpe as usize) < buf.len() {
                    let val = match bpe {
                        2 => {
                            let bits = u16::from_le_bytes([buf[src_idx * 2], buf[src_idx * 2 + 1]]);
                            // Convert f16 to f32 manually (IEEE 754 half-precision)
                            let sign = (bits >> 15) & 0x1;
                            let exp = (bits >> 10) & 0x1f;
                            let frac = bits & 0x3ff;

                            if exp == 0 {
                                // Subnormal or zero
                                if frac == 0 {
                                    0.0f32
                                } else {
                                    let val = (frac as f32) / 1024.0 * f32::powf(2.0, -14.0);
                                    if sign == 1 { -val } else { val }
                                }
                            } else if exp == 31 {
                                // Infinity or NaN
                                if frac == 0 {
                                    if sign == 1 { f32::NEG_INFINITY } else { f32::INFINITY }
                                } else {
                                    f32::NAN
                                }
                            } else {
                                let val = (1.0 + (frac as f32) / 1024.0) * (2.0_f32.powf((exp as f32) - 15.0));
                                if sign == 1 { -val } else { val }
                            }
                        }
                        4 => f32::from_le_bytes([buf[src_idx * 4], buf[src_idx * 4 + 1], buf[src_idx * 4 + 2], buf[src_idx * 4 + 3]]),
                        _ => 0.5,
                    };
                    let v = ((val.max(0.0).min(1.0)) * 255.0) as u8;
                    rgba_data[dst_idx4] = v;
                    rgba_data[dst_idx4 + 1] = v;
                    rgba_data[dst_idx4 + 2] = v;
                    rgba_data[dst_idx4 + 3] = 255;
                }
            }
        }

        let img_buffer = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(width as u32, height as u32, rgba_data)?;
        // 2026-07-05: downscale to `max_size` if requested. Without this,
        // the channel-mode path returns full-resolution PNGs and the
        // FFI/ImageBitmap chain has to alloc + upload a buffer matching
        // the native resolution. The RGB path (`extract_exr_rgba_raw` →
        // `calc_thumb_dims` → `image::imageops::resize`) already does
        // this; parity keeps the per-frame cache budget comparable.
        let (out_w, out_h, final_img): (u32, u32, ImageBuffer<Rgba<u8>, Vec<u8>>) = if let Some(ms) = max_size {
            if ms > 0 && ((width as u32) > ms || (height as u32) > ms) {
                let (tw, th) = calc_thumb_dims(width as u32, height as u32, ms as usize);
                let resized = image::imageops::resize(&img_buffer, tw, th, image::imageops::FilterType::Lanczos3);
                (tw, th, resized)
            } else {
                (width as u32, height as u32, img_buffer)
            }
        } else {
            (width as u32, height as u32, img_buffer)
        };

        let mut png_buf = Vec::new();

        if final_img.write_to(&mut std::io::Cursor::new(&mut png_buf), ImageFormat::Png).is_ok() {
            return Some(ChannelExtractResult {
                png_data: png_buf,
                width: out_w,
                height: out_h,
                channel_name: name.clone(),
            });
        }
    }

    println!("[EXR-Channel-Layer] Channel '{}.{}' not found", layer_name, channel_name);
    None
}

#[cfg(test)]
mod phase5a_tests {
    use super::*;
    use std::path::Path;

    /// Phase 5A early-return: when the user asks for a layer that does not
    /// exist in the file (e.g. a typo, or the wrong layer for a stock
    /// multi-layer EXR), we should NOT iterate the 8-chunk inflate loop
    /// (~430 ms wasted on a 1920x1920 DWAB file). Instead we bail out as
    /// soon as we see `kept_count == 0`, returning empty channels and
    /// letting the caller fall back to its all-grey placeholder.
    ///
    /// The test EXR at `F:\Test EXR\Sh02\Sh020046.exr` has 12 layers
    /// (Beauty, Denoised beauty, Emitters, Output AOV 1-4, Post processing,
    /// Crypto material node name00/01/02, Z-depth). We try to decode with
    /// a filter that matches NO layer, and assert:
    ///   1. The call returns `Some(_)` (header probe OK, file is valid)
    ///   2. The returned RGBA buffer is empty / grey (0 kept channels)
    ///   3. The Rust log shows the early-return marker
    #[test]
    fn phase5a_early_return_on_unknown_layer() {
        // Skip if the test asset is not present (developer machine may not
        // have the F:\Test EXR\ fixture mounted).
        let path = Path::new(r"F:\Test EXR\Sh02\Sh020046.exr");
        if !path.exists() {
            eprintln!("[phase5a_tests] SKIP: {:?} not found", path);
            return;
        }

        eprintln!("[phase5a_tests] === Starting Phase 5A early-return test ===");
        let t_start = std::time::Instant::now();

        // Filter that does not exist in the file. The kept-mask logic in
        // extract_exr_rgba_raw_ffi will mark all channels as filtered, so
        // kept_count == 0 triggers the early-return branch.
        let result = extract_exr_rgba_raw(path, 2048, Some("ZZZ_NO_SUCH_LAYER"));

        let elapsed = t_start.elapsed();
        eprintln!(
            "[phase5a_tests] === Done in {:.2?} — result.is_some() = {} ===",
            elapsed,
            result.is_some()
        );

        // The file is a valid EXR, so we expect Some(_). The RGBA buffer
        // inside is empty / grey (no channels were actually kept).
        assert!(result.is_some(), "expected Some(result) for valid EXR file");
        let res = result.unwrap();

        // Width/height should still be reported (from header).
        assert!(res.width > 0 && res.height > 0, "expected valid dimensions");

        // With 0 kept channels, the early-return path means the chunk
        // inflate loop was SKIPPED entirely. build_raw_rgba still runs
        // and may fill rgba with default values (all-zero or sentinel)
        // because the channels were never populated. The important
        // invariant is the TIMING — we saved ~600ms by not inflating.
        // res.channels.len() is 46 because the metadata still reports all
        // channels from the file header — only the KEEP MASK is empty.
        eprintln!(
            "[phase5a_tests] w={} h={} channels.len()={} (metadata, all) rgba_len={} elapsed={:.2?}",
            res.width,
            res.height,
            res.channels.len(),
            res.rgba.len(),
            elapsed
        );

        // Time-bound assertion: the early-return path should be FAST
        // (< 100 ms) because it skips the 8-chunk DWAB inflate loop.
        // The old path took ~430 ms. If this assertion fails, the
        // early-return branch was NOT taken.
        assert!(
            elapsed.as_millis() < 250,
            "Phase 5A early-return took {:.2?}ms — expected < 250ms. \
             The early-return branch is NOT being taken. Investigate kept_count logic.",
            elapsed.as_millis()
        );
    }

    /// Phase 5A: when the filter is `None` (decode ALL channels), we expect
    /// the full 8-chunk inflate loop to run (~430 ms on the test asset).
    /// This is a baseline measurement so we can compare against the
    /// early-return test above.
    #[test]
    fn phase5a_baseline_all_channels() {
        let path = Path::new(r"F:\Test EXR\Sh02\Sh020046.exr");
        if !path.exists() {
            eprintln!("[phase5a_tests] SKIP: {:?} not found", path);
            return;
        }

        eprintln!("[phase5a_tests] === Starting Phase 5A baseline (no filter) test ===");
        let t_start = std::time::Instant::now();
        let result = extract_exr_rgba_raw(path, 2048, None);
        let elapsed = t_start.elapsed();
        eprintln!(
            "[phase5a_tests] === Baseline done in {:.2?} — result.is_some() = {} ===",
            elapsed,
            result.is_some()
        );
        assert!(result.is_some());
        let res = result.unwrap();
        // With no filter we keep all 46 channels → real pixel data.
        assert!(
            !res.rgba.is_empty() && res.rgba.iter().any(|&b| b != 0),
            "expected non-empty, non-zero rgba for unfiltered decode"
        );
    }
}
