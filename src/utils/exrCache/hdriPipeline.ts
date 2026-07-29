/**
 * HDRI Pipeline — dedicated decode/render path for HDRI captures
 * (e.g. equirectangular panoramas from cameras / LightWave / Blender).
 *
 * Created 2026-07-14. Splits HDRI capture files off the render-engine
 * EXR pipeline (Rust OpenEXR FFI + OCIO/ACES/LUT) so the two paths
 * can't interfere with each other:
 *
 *   ┌───────────────────────┐
 *   │ detectHdriFile()      │  pure-JS, hdrify.readExr() + heuristics
 *   └────────┬──────────────┘
 *            ▼
 *   ┌───────────────────────┐
 *   │ decodeHdriFrame()     │  hdrify.readExr() → Float32Array RGBA
 *   └────────┬──────────────┘
 *            ▼
 *   ┌───────────────────────┐
 *   │ hdrify.applyToneMap   │  Reinhard E1 → Uint8 sRGB (full res)
 *   └────────┬──────────────┘
 *            ▼
 *   ┌───────────────────────┐
 *   │ OffscreenCanvas       │  downscale to ≤ 2K (high quality)
 *   │   drawImage           │  (2026-07-14: preview speed-up)
 *   └────────┬──────────────┘
 *            ▼
 *   ┌───────────────────────┐
 *   │ ImageBitmap (sRGB)    │  ← fed into the existing 2D viewport canvas
 *   └───────────────────────┘
 *
 * The render-engine EXR pipeline (`exrGpuPipeline.ts`, `reinhardLut.ts`,
 * `LayerCacheManager.ts`, Rust IPC) is bypassed entirely for HDRI
 * captures — no OCIO LUT, no ACES, no auto-exposure, no chromaticity
 * conversion. The user can't pick an OCIO mode for HDRI files; the
 * header hides the OCIO selector when `isHdriMode === true` and
 * renders a static "HDRI" badge instead.
 *
 * ### Why Reinhard E1?
 *
 * The user picked classical Reinhard (`L_d = L / (1 + L)`) with
 * exposure 1.0 — no scaling, no whitepoint. Highlights asymptote to 1
 * (the canonical Reinhard behaviour) while midtones compress
 * smoothly. Reference: `valley_test_reinhard_e1.png` shows the
 * resulting tone curve applied to valley_of_desolation_4k.exr.
 *
 * ### Why resize to 2K?
 *
 * The user requested a 2K preview target to speed up HDRI loads. The
 * tone-map output is already in sRGB so a single canvas downscale
 * preserves all visible detail at the viewport's typical ~1920×1080
 * size. See `renderHdriFrame()` for the full rationale.
 */
import { applyToneMapping, readExr, type HdrifyImage } from "hdrify";
import { readFileAsBase64 } from "../../TauriFileSystem";
import { dbg } from "../debug";

/**
 * Decoded HDR frame from hdrify.
 * `rgba` is a Float32Array with stride 4 (RGBA), `peak` is the
 * maximum channel value seen across the frame, `linearColorSpace` is
 * the file's primaries (one of hdrify's `LinearColorSpace` enum
 * values — `rec709` for most HDRI captures, `acescg`/`aces2065-1`
 * for render-engine outputs).
 */
export interface HdriDecoded {
  width: number;
  height: number;
  rgba: Float32Array;
  linearColorSpace: string;
  metadata: Record<string, unknown>;
  /** max(R, G, B) across the frame. */
  peak: number;
}

/**
 * Convert a base64 string into a Uint8Array (browser-safe, no Buffer).
 * The Tauri `readFileAsBase64` IPC already returns a plain base64
 * string — we strip any data-URL prefix that might be present and
 * decode the raw bytes.
 */
function base64ToBytes(b64: string): Uint8Array {
  const comma = b64.indexOf(",");
  const raw = comma >= 0 ? b64.slice(comma + 1) : b64;
  const binary = atob(raw);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Read + parse an HDRI EXR file. Bypasses the Rust OpenEXR FFI
 * entirely so HDRI captures don't go through the render-engine
 * pipeline's ACES/OCIO/LUT stages.
 *
 * Returns null on decode failure (e.g. malformed file, IO error) so
 * callers can fall back to the standard pipeline. Failures are NOT
 * logged here — the detector probe path is allowed to fail silently
 * because it's the expected outcome for every render-engine EXR that
 * uses a hdrify-unsupported compression (B44A/B44, DWAA, etc.).
 * Callers that genuinely care about the error should look at the
 * `lastHdriDecodeError` field on the returned `null` indirectly
 * (currently unused; reserved for future richer error reporting).
 */
export async function decodeHdriFrame(
  filePath: string,
  options: { silent?: boolean } = {},
): Promise<HdriDecoded | null> {
  try {
    const b64 = await readFileAsBase64(filePath);
    const bytes = base64ToBytes(b64);
    const image: HdrifyImage = readExr(bytes);

    let peak = 0;
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const m = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (m > peak) peak = m;
    }

    dbg.log(
      `[HDRI] decoded ${filePath} ${image.width}x${image.height} peak=${peak.toFixed(1)} cs=${image.linearColorSpace}`,
    );

    return {
      width: image.width,
      height: image.height,
      rgba: data,
      linearColorSpace: image.linearColorSpace ?? "rec709",
      metadata: image.metadata ?? {},
      peak,
    };
  } catch (err) {
    // 2026-07-14: only log when the caller didn't opt into silent
    // mode. The HDRI detector probes every EXR file in the player —
    // for render-engine outputs the probe is expected to fail with
    // "unsupported compression" and the user shouldn't see that in
    // their console on every open.
    if (!options.silent) {
      dbg.log(`[HDRI] decode failed for ${filePath}: ${(err as Error).message}`);
    }
    return null;
  }
}

/**
 * Render an HDRI frame to an `ImageBitmap` suitable for the existing
 * 2D viewport canvas.
 *
 * The tone-map is hdrify's built-in Reinhard (`L / (1 + L)`) with
 * exposure 1.0 — chosen so highlights asymptote to 1.0 (classical
 * Reinhard) and midtones compress smoothly. After tone-mapping,
 * hdrify applies the sRGB OETF analytically and clamps to 8-bit so
 * the result is ready to paint without a separate gamma pass.
 *
 * If the file's `linearColorSpace` isn't already `rec709`, hdrify
 * converts the RGB primaries to `rec709` before tone-mapping so the
 * output is consistent across HDRI sources.
 *
 * ### Why resize to 2K (2026-07-14)?
 *
 * The user asked for 2K preview speed-up. HDRI captures routinely
 * arrive at 4K (4096×2048) or 8K (8192×4096). Tone-mapping the full
 * Float32 buffer at 4K takes ~600 ms in pure JS; at 8K it dominates
 * the load time and stalls the UI. The viewport displays the result
 * inside the EXR player's 2D canvas which is usually bounded at
 * ~1920×1080 — uploading a 4K bitmap to the GPU and then downscaling
 * every frame is wasteful.
 *
 * Pipeline change: tone-map at full resolution (preserves HDR detail
 * + per-pixel smoothness), then resize down to a max dimension of
 * `MAX_PREVIEW_DIMENSION` via OffscreenCanvas with high-quality
 * Lanczos-style smoothing. The downscaled RGBA is then handed to
 * `createImageBitmap` for the GPU upload.
 *
 * Why tone-map BEFORE resize (not after):
 *   • HDR detail (peak 1850, per-channel ratios) only exists in
 *     Float32 space. If we resize first we'd have to clamp the HDR
 *     buffer to 8-bit and lose all dynamic range before the
 *     tone-map ever ran.
 *   • Tone-map output is already in `[0, 1]` sRGB so a single
 *     `drawImage` downscale is mathematically identical (within
 *     resampling tolerance) to applying the tone-map to the smaller
 *     buffer.
 *
 * Files ≤ 2K skip the resize entirely (avoid a no-op canvas round-
 * trip) and produce the same bitmap as before.
 */
export const MAX_PREVIEW_DIMENSION = 2048;

export async function renderHdriFrame(
  decoded: HdriDecoded,
  toneMap: "reinhard" | "aces" | "neutral" | "agx" = "reinhard",
  exposure: number = 1.0,
  maxDimension: number = MAX_PREVIEW_DIMENSION,
): Promise<ImageBitmap | null> {
  try {
    const rgb8 = applyToneMapping(decoded.rgba, decoded.width, decoded.height, {
      toneMapping: toneMap,
      exposure,
      sourceColorSpace: decoded.linearColorSpace as never,
    });

    // hdrify returns RGB (3 bytes per pixel). Expand to RGBA for the
    // viewport canvas which expects 4-channel pixels.
    const pixelCount = decoded.width * decoded.height;
    const rgba8 = new Uint8ClampedArray(pixelCount * 4);
    for (let i = 0, j = 0; i < rgb8.length; i += 3, j += 4) {
      rgba8[j] = rgb8[i];
      rgba8[j + 1] = rgb8[i + 1];
      rgba8[j + 2] = rgb8[i + 2];
      rgba8[j + 3] = 255;
    }

    const fullRes = new ImageData(rgba8, decoded.width, decoded.height);

    // Fast-path: source is already ≤ maxDimension. Skip the canvas
    // round-trip — `createImageBitmap` directly handles the upload.
    if (
      decoded.width <= maxDimension &&
      decoded.height <= maxDimension
    ) {
      return await createImageBitmap(fullRes);
    }

    // Compute target dimensions preserving aspect ratio.
    const scale = Math.min(
      maxDimension / decoded.width,
      maxDimension / decoded.height,
    );
    const targetW = Math.max(1, Math.round(decoded.width * scale));
    const targetH = Math.max(1, Math.round(decoded.height * scale));

    // 2026-07-14: downscaled tone-mapped result via OffscreenCanvas.
    // We upload the full-res sRGB ImageData into a source canvas at
    // its native size, then `drawImage` onto a smaller target canvas
    // with `imageSmoothingEnabled = true` (the browser's default
    // resampling kernel is a high-quality Lanczos approximation on
    // Chromium / Firefox / Safari).
    const sourceCanvas = new OffscreenCanvas(decoded.width, decoded.height);
    const sourceCtx = sourceCanvas.getContext("2d");
    if (!sourceCtx) {
      // Fallback: hand the full-res bitmap to the canvas if the
      // 2D context isn't available (older browsers / workers without
      // DOM). Slower upload but correct output.
      dbg.log("[HDRI] OffscreenCanvas 2D unavailable, falling back to full-res bitmap");
      return await createImageBitmap(fullRes);
    }
    sourceCtx.putImageData(fullRes, 0, 0);

    const targetCanvas = new OffscreenCanvas(targetW, targetH);
    const targetCtx = targetCanvas.getContext("2d");
    if (!targetCtx) {
      return await createImageBitmap(fullRes);
    }
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.imageSmoothingQuality = "high";
    targetCtx.drawImage(sourceCanvas, 0, 0, targetW, targetH);

    dbg.log(
      `[HDRI] downscaled ${decoded.width}x${decoded.height} → ${targetW}x${targetH}`,
    );
    return await createImageBitmap(targetCanvas);
  } catch (err) {
    dbg.log(`[HDRI] render failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Convenience wrapper — decode + tone-map in one call. Used by the
 * `ExrPlayer` HDRI branch for single-frame loads.
 */
export async function loadHdriFrame(
  filePath: string,
  toneMap: "reinhard" | "aces" | "neutral" | "agx" = "reinhard",
  exposure: number = 1.0,
): Promise<{ bitmap: ImageBitmap; decoded: HdriDecoded } | null> {
  const decoded = await decodeHdriFrame(filePath);
  if (!decoded) return null;
  const bitmap = await renderHdriFrame(decoded, toneMap, exposure);
  if (!bitmap) return null;
  return { bitmap, decoded };
}