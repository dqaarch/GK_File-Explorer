// Phase 9: Parallel batch EXR decoder.
//
// Goal: replace the sequential `decode_exr_u8_rgba` path that the
// continuous loader (LayerCacheManager.startContinuousLoad) used to
// call one frame at a time. With one file per Tauri command we pay
// an IPC roundtrip per frame and we never exploit the 32 worker
// threads the C++ bridge already spawned at startup.
//
// The new `decode_exr_batch_u8` command takes `paths: Vec<String>`
// and fans the work out via `rayon::par_iter()`:
//   * each item checks `exr_decode_cache_lru` first (cheap mutex
//     acquisition, never touches the disk);
//   * on miss, falls through to `openexr_core::extract_exr_rgba_raw`
//     (which itself uses the Imf global thread pool);
//   * stores the result back into the LRU so the next batch picks
//     it up;
//   * converts f32 → u8 once per item and packs the same wire
//     format `decode_exr_u8_rgba` already produces (4-byte header
//     length, JSON `ExrF32Meta`, RGBA8 pixels).
//
// Wire format for the batch response:
//
//   [u32 frame_count]
//   [u32 offset_table_len]            // == frame_count * 8
//   [frame_count × (u32 header_len, u32 payload_len)]
//   [frame 0: header_json | u8 pixels]
//   [frame 1: header_json | u8 pixels]
//   ...
//
// Frontend parses the table with a DataView, then reads each
// payload the same way `decode_exr_u8_rgba` already does.

use crate::exr_decode_cache;
use crate::exr_decode_cache_lru;
use crate::exr_passthrough;
use crate::openexr_core;
use rayon::prelude::*;

#[derive(serde::Deserialize)]
pub struct ExrBatchArgs {
    pub paths: Vec<String>,
    pub max_size: Option<u32>,
    pub layer_name: Option<String>,
}

/// Single-frame decoded payload. Mirrors the structure produced by
/// `decode_exr_u8_rgba` so the JS-side parser doesn't need a new
/// branch.
struct BatchFramePayload {
    header: crate::ExrF32Meta,
    u8_bytes: Vec<u8>,
}

/// Decode one file. Tries the in-memory LRU first, then the on-disk
/// cache, then falls back to OpenEXRCore. Mirrors the single-file
/// `decode_exr_u8_rgba` path exactly so the cache contents stay
/// identical regardless of which entry point populated them.
fn decode_one(path_str: &str, max_size: u32, layer: Option<&str>) -> BatchFramePayload {
    let path = std::path::PathBuf::from(path_str);

    // LRU cache hit.
    if let Some(view) = exr_decode_cache_lru::get(&path, layer) {
        let u8_bytes = exr_passthrough::f32_rgba_to_u8_bytes(&view.rgba_f32);
        return BatchFramePayload {
            header: crate::ExrF32Meta {
                success: true,
                width: Some(view.width),
                height: Some(view.height),
                channels: Some(view.channels),
                layers_count: Some(view.layers_count),
                layer_names: Some(view.layer_names),
                dynamic_range: Some(0.0),
                pass_type: Some(view.pass_type),
                format: Some("u8".to_string()),
                error: None,
            },
            u8_bytes,
        };
    }

    // Probe dimensions (needed before disk-cache lookup so we can
    // log a MISS against the correct size bucket).
    let (w, h) = match openexr_core::probe_exr_dimensions(&path) {
        Some(v) => v,
        None => {
            return BatchFramePayload {
                header: failed_header(),
                u8_bytes: Vec::new(),
            };
        }
    };
    exr_decode_cache_lru::log_outcome(&path, layer, false, w, h);

    // Disk cache hit.
    if let Some((rgba_f32, channels, layers_count, layer_names, pass_type)) =
        exr_decode_cache::try_load(&path, layer, w, h)
    {
        let u8_bytes = exr_passthrough::f32_rgba_to_u8_bytes(&rgba_f32);
        exr_decode_cache_lru::put(
            &path,
            layer,
            w,
            h,
            rgba_f32.clone(),
            channels.clone(),
            layers_count,
            layer_names.clone(),
            pass_type.clone(),
        );
        return BatchFramePayload {
            header: crate::ExrF32Meta {
                success: true,
                width: Some(w),
                height: Some(h),
                channels: Some(channels),
                layers_count: Some(layers_count),
                layer_names: Some(layer_names),
                dynamic_range: Some(0.0),
                pass_type: Some(pass_type),
                format: Some("u8".to_string()),
                error: None,
            },
            u8_bytes,
        };
    }

    // Cold decode.
    match openexr_core::extract_exr_rgba_raw(&path, max_size, layer) {
        Some(r) => {
            if let Some(f32_buf) = r.rgba_f32.as_ref() {
                exr_decode_cache_lru::put(
                    &path,
                    layer,
                    r.width,
                    r.height,
                    f32_buf.clone(),
                    r.channels.clone(),
                    r.layers_count,
                    r.layer_names.clone(),
                    r.pass_type.clone(),
                );
                exr_decode_cache::try_save(
                    &path,
                    layer,
                    r.width,
                    r.height,
                    f32_buf,
                    &r.channels,
                    r.layers_count,
                    &r.layer_names,
                    &r.pass_type,
                );
            }
            let f32_payload: Vec<f32> = r.rgba_f32.unwrap_or_default();
            let u8_bytes = exr_passthrough::f32_rgba_to_u8_bytes(&f32_payload);
            BatchFramePayload {
                header: crate::ExrF32Meta {
                    success: true,
                    width: Some(r.width),
                    height: Some(r.height),
                    channels: Some(r.channels),
                    layers_count: Some(r.layers_count),
                    layer_names: Some(r.layer_names),
                    dynamic_range: Some(r.dynamic_range),
                    pass_type: Some(r.pass_type),
                    format: Some("u8".to_string()),
                    error: None,
                },
                u8_bytes,
            }
        }
        None => BatchFramePayload {
            header: failed_header(),
            u8_bytes: Vec::new(),
        },
    }
}

fn failed_header() -> crate::ExrF32Meta {
    crate::ExrF32Meta {
        success: false,
        width: None,
        height: None,
        channels: None,
        layers_count: None,
        layer_names: None,
        dynamic_range: None,
        pass_type: None,
        format: Some("u8".to_string()),
        error: Some("Could not parse EXR file".to_string()),
    }
}

/// Pack the per-frame payloads into the batch wire format.
///
/// Layout (little-endian everywhere):
///   [u32 frame_count]
///   [u32 offset_table_len]            // == frame_count * 8
///   [frame_count × (u32 header_len, u32 payload_len)]
///   [frame 0: header_json | u8 pixels]
///   [frame 1: header_json | u8 pixels]
///   ...
///
/// The frontend reads the offset table, jumps to each frame's
/// header, `JSON.parse`s it (same `ExrF32Meta` shape as
/// `decode_exr_u8_rgba`), then constructs a `Uint8ClampedArray`
/// from the pixel bytes for the GPU pipeline.
fn pack_batch_payload(frames: Vec<BatchFramePayload>) -> Result<Vec<u8>, String> {
    let frame_count = frames.len();
    let offset_table_len = frame_count * 8;

    // First pass: serialise each frame to (header_json_bytes, u8_bytes)
    // so we know the exact per-frame sizes for the offset table.
    let mut serialised: Vec<(Vec<u8>, Vec<u8>)> = Vec::with_capacity(frame_count);
    let mut body_bytes: usize = 0;
    for fp in frames {
        let header_json = serde_json::to_string(&fp.header)
            .map_err(|e| format!("Batch header serialise failed: {}", e))?;
        let header_bytes = header_json.into_bytes();
        body_bytes += header_bytes.len() + fp.u8_bytes.len();
        serialised.push((header_bytes, fp.u8_bytes));
    }

    // Total = 8 (count + table_len) + offset_table_len + body_bytes
    let mut payload: Vec<u8> = Vec::with_capacity(8 + offset_table_len + body_bytes);
    payload.extend_from_slice(&(frame_count as u32).to_le_bytes());
    payload.extend_from_slice(&(offset_table_len as u32).to_le_bytes());

    // Build offset table by streaming writes — we need the final
    // per-frame (header_len, payload_len) pairs, but we already know
    // those from the `serialised` vec.
    for (header_bytes, u8_bytes) in &serialised {
        payload.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
        payload.extend_from_slice(&(u8_bytes.len() as u32).to_le_bytes());
    }

    // Append the actual frames.
    for (header_bytes, u8_bytes) in serialised {
        payload.extend_from_slice(&header_bytes);
        payload.extend_from_slice(&u8_bytes);
    }

    Ok(payload)
}

/// Tauri command: decode N EXR files in parallel on the Rust
/// thread pool and return one packed binary blob.
///
/// Replaces N sequential `decode_exr_u8_rgba` calls in the JS
/// continuous loader. With 32 worker threads already running on the
/// C++ bridge side, this turns a 270-frame fill (~4.5 minutes
/// serial) into a single batch that should complete in roughly the
/// time of the slowest single frame (~1 s) plus a small per-batch
/// overhead, depending on how many cores the OS grants us.
#[tauri::command]
pub async fn decode_exr_batch_u8(
    args: ExrBatchArgs,
) -> Result<tauri::ipc::Response, String> {
    let paths = args.paths;
    let max_size = args.max_size.unwrap_or(0);
    let layer = args.layer_name.clone();

    println!(
        "[EXR-BATCH] decode_exr_batch_u8 START ({} frames, layer={:?}, max_size={})",
        paths.len(),
        layer,
        max_size
    );

    if paths.is_empty() {
        // Return an empty (but well-formed) batch.
        let empty = pack_batch_payload(Vec::new())?;
        return Ok(tauri::ipc::Response::new(empty));
    }

    // Off-thread decode. `spawn_blocking` is required because the
    // OpenEXR + cache calls are synchronous and we don't want to
    // block the tokio reactor.
    let paths_for_blocking = paths.clone();
    let layer_for_blocking = layer.clone();

    // 2026-07-13: Adaptive concurrency for DWAB-large files.
    //
    // `par_iter()` defaults to rayon_global.num_threads(), which can be
    // 32 on this dev box. For small (≤1MPixel) files that's fine — disk
    // I/O and CPU overlap nicely. But for the large DWAB sequences the
    // user is now testing (2000×4000 = 32 MPixel per frame, 16 frames in
    // flight = 512 MB raw pixels being decompressed simultaneously),
    // spinning 32 parallel decodes thrashes the disk cache, blows past
    // the C++ Imf thread pool, and makes individual frames regress from
    // ~280 ms to ~3 s. The app appears to "hang" while it churns.
    //
    // We probe each file cheaply (header read only, no decode) and
    // bucket into three tiers:
    //   * small (≤ 1 MPixel)    → up to 16 in-flight (default)
    //   * medium (≤ 8 MPixel)   → up to 8 in-flight
    //   * large  (> 8 MPixel)   → up to 4 in-flight (DWAB 4K territory)
    //
    // Each tier uses its own rayon thread pool (a fresh `ThreadPool` so
    // we don't disturb the global pool's other consumers). Note this
    // caps *parallel decode work*, not the C++ Imf thread pool, which
    // still runs at full `physical_cores` inside each individual decode.
    let (concurrency, max_pixels): (usize, u64) = {
        let mut total_pixels: u64 = 0;
        let mut max_pixels: u64 = 0;
        for p in &paths_for_blocking {
            if let Some((w, h)) = openexr_core::probe_exr_dimensions(std::path::Path::new(p)) {
                let px = (w as u64) * (h as u64);
                total_pixels += px;
                if px > max_pixels {
                    max_pixels = px;
                }
            }
        }
        // Mega-pixel cap based on the largest single frame.
        let mpx = max_pixels / 1_000_000;
        let cap = if mpx <= 1 {
            16
        } else if mpx <= 8 {
            8
        } else {
            4
        };
        let cap = cap.min(paths_for_blocking.len().max(1));
        (cap, max_pixels)
    };

    println!(
        "[EXR-BATCH] adaptive concurrency: {} (largest frame ~{} MPixel, {} frames)",
        concurrency,
        max_pixels / 1_000_000,
        paths_for_blocking.len()
    );

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(concurrency)
        .build()
        .map_err(|e| format!("Failed to build batch thread pool: {}", e))?;

    let results: Vec<BatchFramePayload> = tokio::task::spawn_blocking(move || {
        pool.install(|| {
            paths_for_blocking
                .par_iter()
                .map(|p| decode_one(p, max_size, layer_for_blocking.as_deref()))
                .collect()
        })
    })
    .await
    .map_err(|e| format!("Batch decode task panicked: {}", e))?;

    let success_count = results.iter().filter(|r| r.header.success).count();
    println!(
        "[EXR-BATCH] decode_exr_batch_u8 DONE ({}/{} frames OK)",
        success_count,
        results.len()
    );

    let payload = pack_batch_payload(results)?;
    Ok(tauri::ipc::Response::new(payload))
}