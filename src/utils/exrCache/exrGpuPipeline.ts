/**
 * exrGpuPipeline — high-level driver around the GPU OCIO LUT stack.
 *
 * Combines:
 *   - Rust `decodeExrF32`           (linear HDR RGBA)
 *   - Rust `getOcioLut`             (baked OCIO 3D LUT)
 *   - Renderer factory              (GPU / CPU-workers / CPU-single)
 *
 * Used by EXRSequencePlayer (both single-frame and multi-frame EXR views).
 * Falls back gracefully to the legacy `decodeExr` path if the renderer
 * can't be initialized.
 */

import {
  decodeExrF32,
  decodeExrF16,
  decodeExrF16Raw,
  decodeExrU8,
  decodeExr,
  decodeExrBatch,
  getOcioLut,
  getOcioLutAssetUrl,
  getOcioLutMetadata,
  OCIO_MODE_SLUGS,
  type ExrF32Response,
  type OcioModeSlug,
} from "../../TauriFileSystem";
import {
  createLutRenderer,
  type RendererHandle,
} from "./createLutRenderer";
import { detectPassType } from "./passType";
import { dbg } from "../debug";
import { ExrGpuPassthroughRenderer } from "./exrGpuPassthroughRenderer";
import { rawLinearCache } from "./RawLinearCache";

/**
 * Phase 6: Local copy of the half→float expansion helper. The
 * canonical version lives in TauriFileSystem.ts as a private function
 * (not exported). Copying it here instead of exporting the original
 * because TauriFileSystem is the public API surface — exporting
 * internals would invite callers to depend on the encoding. The
 * algorithm is identical to the canonical one; if you change one,
 * change the other.
 *
 * Used by `decodeFrameToBitmapDirect` (Phase 6 F16 fast path) to
 * widen raw half-precision bits into a Float32Array for the f32→u8
 * clamp loop. Kept as a standalone function (not a method) so the
 * JIT can inline it and the closure capture is empty.
 */
function halfFloatArrayToFloat32(half: Uint16Array): Float32Array {
  const buf = new ArrayBuffer(4);
  const fv = new Float32Array(buf);
  const iv = new Uint32Array(buf);
  const out = new Float32Array(half.length);
  for (let i = 0; i < half.length; i++) {
    const h = half[i];
    const sign = (h & 0x8000) << 16;
    let exp = (h >> 10) & 0x1f;
    let mant = h & 0x3ff;
    if (exp === 0) {
      if (mant === 0) {
        iv[0] = sign;
      } else {
        let e = -1;
        let m = mant;
        while ((m & 0x400) === 0) {
          m <<= 1;
          e--;
        }
        m &= 0x3ff;
        iv[0] = sign | (((e + 127) & 0xff) << 23) | (m << 13);
      }
    } else if (exp === 0x1f) {
      iv[0] = sign | (0xff << 23) | (mant ? 0x200000 : 0);
    } else {
      iv[0] = sign | (((exp - 15 + 127) & 0xff) << 23) | (mant << 13);
    }
    out[i] = fv[0];
  }
  return out;
}

/** Map human-readable OCIO mode names (from EXRSequencePlayer dropdown) to slugs. */
const HUMAN_TO_SLUG: Record<string, OcioModeSlug | string> = {
  "Raw": OCIO_MODE_SLUGS.RAW,
  "Linear sRGB": OCIO_MODE_SLUGS.LINEAR_SRGB,
  // Phase 6D-Lite: legacy "ACES 2.0" label → the build-time baked ACES 1.3 CG slug.
  "ACES 2.0": "ACES_1_3_CG__sRGB_Display__ACES_1_0_SDR_Video",
  "ACES 2.0 CG": "ACES_1_3_CG__sRGB_Display__ACES_1_0_SDR_Video",
  "ACES 2.0 Studio": "ACES_1_3_CG__sRGB_Display__ACES_1_0_SDR_Video",
  // 2026-07-05 (second pass): "$OCIO" now maps to the Raw
  // passthrough slug (matches the new default view). Previously
  // mapped to Linear_sRGB during the single-passthrough period.
  "$OCIO": OCIO_MODE_SLUGS.RAW,
};

/**
 * Threshold above which we route an ACES-mode render to the inline
 * `acesStephenHill` shader instead of the 3D LUT. The LUT is baked
 * across [0, 16.29] (ACES RRT peak scene white — see
 * `gen_luts.ACES_LUT_INPUT_MAX`); assuming the rendered frame's min is
 * not pathologically tiny (≥ 0.01 — anything below that was crushed
 * during CG render), `max = dynamic_range * min`, so we want the
 * implicit max ≤ 16.29, i.e. `dynamic_range ≤ 1629`. We use 200 as a
 * conservative cushion (handles common ACES CG renders cleanly while
 * still catching truly pathological frames).
 */
const OCIO_HDR_LUT_MAX_FACTOR = 200;

/**
 * 2026-07-13: Reinhard tone-mapping slug. Synthesised at runtime
 * by `reinhardLut.ts` — no Rust IPC, no pre-baked .bin asset. Lives
 * alongside `OCIO_MODE_SLUGS` semantically but is duplicated here as
 * a `const string` because this module imports `OCIO_MODE_SLUGS`
 * from `TauriFileSystem` and we'd rather keep the type-only
 * reference in one place than re-export the enum.
 *
 * Used by `resolveActiveLut()` (LUT synthesis) and the 5 HDR-reroute
 * sites (`useInlineAcesForHdr = isAcesMode && hdrSignal &&
 * !isReinhardSlug`) — Reinhard takes the HDR signal through its own
 * LUT instead of falling back to inline ACES (Hill fit).
 */
const REINHARD_MODE_SLUG = "Reinhard";

function isReinhardSlug(slug: string): boolean {
  return slug === REINHARD_MODE_SLUG;
}

/**
 * HDRI gate: files whose Rust-reported `dynamic_range` exceeds this
 * threshold are considered HDR imagery (HDRI / panorama / over-exposed
 * render) and get auto-exposure. Render engine EXR output always has
 * `dynamic_range <= 1.0` (pixels in [0,1]), so 10 is safely above the
 * noise floor while still catching typical HDRI files.
 */
const HDRI_DYNAMIC_RANGE_THRESHOLD = 10.0;

/**
 * Phase 6D-Lite: pass types where half-precision (f16) IPC is safe —
 * the values are either normalised to [0, 1] or have a small enough
 * dynamic range that f16 covers it (±65504).
 *
 * Pass types NOT in this list keep using f32 IPC to preserve precision:
 * - Depth: real-world distances can easily exceed 65504 (large scenes)
 * - Motion: signed vectors need f32 precision in deep shadow areas
 * - UV: f32 uv coords can be >1 outside [0,1] standard range
 */
const F16_SAFE_PASS_TYPES = new Set<string>([
  "rgb",
  "ao",
  "emission",
  "shadow",
  "sss",
  "transmission",
  "cryptomatte",
  "grayscale",
]);

/**
 * Pick between f32 and f16 IPC based on the Rust-detected pass type.
 * Defaults to f16 when the pass type is unknown (covers generic Beauty
 * / AOV / lighting passes where f16 is safe; the LUT clamps at
 * u_lutInputMax so any overflow goes to display white instead of
 * wrapping).
 */
function shouldUseF16Ipc(passType: string | null | undefined): boolean {
  if (!passType) return true;
  return F16_SAFE_PASS_TYPES.has(passType);
}

/**
 * Configuration for the user's custom OCIO config.
 *
 * NOTE: As of the OCIO cleanup (June 2026), the EXR player no longer
 * exposes a "Custom OCIO Config" mode in the UI. This type is kept so
 * `setCustomOcioConfig()` / `getCustomOcioConfig()` still type-check
 * against callers in `LayerCacheManager`, but the methods below are
 * now no-ops — passing a config has no effect on rendering.
 */
export interface CustomOcioConfig {
  configPath: string;
  display: string;
  view: string;
  size?: number;
}

/**
 * Detect whether a baked OCIO LUT is the identity transform. When the build
 * host has no PyOpenColorIO the Rust build script writes an identity LUT as
 * a fallback, but we need to know to route ACES modes through the inline
 * shader in that case.
 *
 * Identity check: pick 8 corner voxels along the diagonal and compare
 * output to (r, g, b) input. Identity LUT means the build couldn't bake
 * real OCIO. With ~33^3 = 35 937 voxels, 8 corners is plenty.
 */
function isLutIdentity(lut: Float32Array | undefined, size: number | undefined): boolean {
  if (!lut || !size || size < 2) {
    return true;
  }
  const last = size - 1;
  const corners: Array<[number, number, number]> = [
    [0, 0, 0],
    [last, 0, 0],
    [0, last, 0],
    [0, 0, last],
    [last, last, 0],
    [last, 0, last],
    [0, last, last],
    [last, last, last],
  ];
  for (const [r, g, b] of corners) {
    const off = ((b * size + g) * size + r) * 3;
    const oR = lut[off];
    const oG = lut[off + 1];
    const oB = lut[off + 2];
    const iR = r / last;
    const iG = g / last;
    const iB = b / last;
    const dr = Math.abs(oR - iR);
    const dg = Math.abs(oG - iG);
    const db = Math.abs(oB - iB);
    if (dr > 0.01 || dg > 0.01 || db > 0.01) {
      return false;
    }
  }
  return true;
}

export interface PipelineOptions {
  /** "auto" picks GPU when available; "cpu" forces CPU path; "gpu" requires GPU. */
  preference?: "auto" | "gpu" | "cpu";
}

export interface GpuFrameResult {
  success: boolean;
  width: number;
  height: number;
  channels: string[];
  dynamicRange: number;
  /** True if we fell back to the legacy PNG path. */
  usedLegacyFallback: boolean;
  error?: string;
}

/**
 * Holds the shared renderer + LUT cache. One instance per player view.
 */
export class ExrGpuPipeline {
  private renderer: RendererHandle | null = null;
  /**
   * Phase 7: shared GPU renderer that turns RGBA8 / RGBA16F pixel buffers
   * straight into `ImageBitmap` with no CPU conversion. Created lazily
   * on the first `decodeFrameToBitmapDirect` call and disposed when the
   * pipeline itself is disposed. Single context per pipeline instance.
   */
  private passthroughRenderer: ExrGpuPassthroughRenderer | null = null;
  private lutLoadedFor: string | null = null;
  private options: PipelineOptions;
  private initialized = false;
  /** Set if any step requires the legacy fallback. */
  private lastUsedLegacy = false;
  /** Shared hidden canvas used for toDataURL() in the cache-friendly path. */
  private offscreenCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  /**
   * The slug actually used for the *previous* frame. The cache path
   * (LayerCacheManager) calls setActiveSlug() before each decodeFrameToDataUrl;
   * we stash it here so getCurrentSlug() returns it back to the renderer.
   */
  private pendingSlug: string = "Linear_sRGB";

  /**
   * Phase 7-revisit (2026-07-05): capture the raw pixel buffer produced
   * by the most recent `decodeFrameToBitmap` call. LayerCacheManager
   * reads this field via `popCapturedRaw()` immediately after the decode
   * succeeds, hands it to the `RawLinearCache` for future OCIO switches,
   * and the pipeline forgets about it. The buffer is owned by the caller
   * once handed off — we never hold a reference after `popCapturedRaw`.
   */
  private lastRawCapture: {
    pixels: Uint16Array | Float32Array;
    width: number;
    height: number;
    channels: string[];
    isHalfFloat: boolean;
    layerName: string;
    maxSize: number;
    customFingerprint: string;
  } | null = null;

  /**
   * Last `pass_type` string the Rust decoder reported for the most
   * recent decode (e.g. "rgb", "hdr", "depth", "ao"). The UI calls
   * this to decide whether to apply ACES — HDR/HDRI files are
   * already scene-linear and would double-tone-map.
   */
  private lastPassType: string | null = null;
  getLastPassType(): string | null {
    return this.lastPassType;
  }
  /**
   * Clear the cached `pass_type` when the file path / layer changes,
   * so the UI HDR guard doesn't see a stale signal from the previous
   * file and lock OCIO to "Raw" for an unrelated Beauty pass.
   */
  invalidateLastPassType(): void {
    this.lastPassType = null;
  }

  /**
   * Phase 6: Pick the pixel buffer to hand to the GPU renderer. Prefers
   * `rgba_f16` (Uint16Array of raw half-precision bits from Rust) when
   * present, falls back to `rgba_f32` (Float32Array) for cache-hit paths
   * or passes that genuinely need F32 precision (depth, position, etc.).
   */
  private pickPixelsForRenderer(resp: ExrF32Response): Float32Array | Uint16Array {
    if (resp.rgba_f16 && resp.rgba_f16.length > 0) {
      return resp.rgba_f16;
    }
    if (!resp.rgba_f32) {
      throw new Error(
        `[Phase6] pickPixelsForRenderer: both rgba_f16 and rgba_f32 are null/empty for ${resp.width}x${resp.height}`,
      );
    }
    return resp.rgba_f32;
  }

/**
 * Phase 6: Companion to `pickPixelsForRenderer` — tells the renderer
   * which layout the pixel buffer is in. Used by `EXRGpuRenderer.loadFrame`
   * to skip the F32→F16 conversion on the JS side when input is already
   * half-precision.
   */
  private pickIsHalfFloat(resp: ExrF32Response): boolean {
    return !!(resp.rgba_f16 && resp.rgba_f16.length > 0);
  }

  /**
   * Phase 6: Centralised F16-with-F32-fallback decode. Tries the F16
   * IPC path first (returns `rgba_f16: Uint16Array`, no JS-side
   * expansion), and only falls back to F32 if the F16 IPC returns
   * nothing useful OR the layer/pass-type is not F16-safe.
   *
   * Used by all 5 decode entry points (decodeAndRender,
   * decodeFrameToBitmap, decodeFrameToDataUrl, decodeFrameToBitmapDirect,
   * renderCachedFrameRaw) so the F16 fast path applies uniformly.
   * Before Phase 6 each entry point had its own copy of the routing
   * logic, and 4 of them were missed — they still called the legacy
   * `decodeExrF16` (with full half→float expansion) or went straight
   * to `decodeExrF32`, missing the bypass. This helper collapses all
   * of those into one path.
   */
  private async decodeForBeauty(
    filePath: string,
    maxSize: number | undefined,
    layerName: string | undefined,
    signal?: AbortSignal,
    /**
     * Phase 7: when true, prefer the U8 IPC variant (cheapest on the
     * wire and on the JS side — 14.7 MB vs 28.8 MB F16, no
     * half→float expansion). Only the **passthrough** (Raw / Linear
     * sRGB) path requests this. The ACES / OCIO LUT path keeps F16
     * because the inline ACES fragment shader needs HDR scene-linear
     * precision (8-bit clamp discards highlights). Default false so
     * legacy ACES callers don't break.
     */
    preferU8: boolean = false,
  ): Promise<ExrF32Response> {
    if (signal?.aborted) {
      return {
        success: false,
        rgba_f32: null,
        rgba_f16: null,
        width: null,
        height: null,
        channels: null,
        layers_count: null,
        layer_names: null,
        dynamic_range: null,
        pass_type: null,
        error: "aborted",
      } as ExrF32Response;
    }

    const lowerLayer = (layerName ?? "").toLowerCase();
    const isLikelyF16Safe =
      !lowerLayer ||
      lowerLayer === "rgba" ||
      lowerLayer === "rgb" ||
      lowerLayer.includes("beauty") ||
      lowerLayer.includes("denoised");

// Phase 7-revisit (2026-07-05): passthrough path prefers U8 for
    // the cheap-to-upload bitmap, BUT we ALSO want an HDR (F16) copy
    // so that an OCIO switch out of passthrough (e.g. Raw → ACES) can
    // re-render the cached HDR buffer instead of doing a full FFI
    // re-decode of every frame.
      //
      // Without this, the Phase 7 `lastRawCapture` skip on U8-only
      // responses kicks in and the entire 270-frame passthrough
      // batch loads are useless for the ACES path — every scrub after
      // a mode switch is a fresh FFI decode.
      // Strategy: kick off the U8 and F16 IPC calls in parallel (Rust
      // side has its own LRU cache so the F16 call is cheap on a U8
      // hit and vice versa). The U8 result drives the bitmap, the F16
      // result populates `rgba_f16` on the returned response so the
      // caller can capture it for re-render.
      //
      // 2026-07-13-fix: RE-ENABLED after fixing dynamic_range bug.
      // The dual path now correctly handles HDR content because dynamic_range
      // is computed from cached f32 pixels.
      if (preferU8 && isLikelyF16Safe) {
      const [u8resp, f16resp] = await Promise.all([
        decodeExrU8(filePath, maxSize, layerName),
        decodeExrF16(filePath, maxSize, layerName),
      ]);
      if (signal?.aborted) {
        return (u8resp ?? f16resp) as ExrF32Response;
      }
      if (u8resp.success && u8resp.rgba_u8 && u8resp.rgba_u8.length > 0) {
        // Stitch the two responses: keep U8 for the bitmap upload,
        // splice F16 into `rgba_f16` so the caller's capture path
        // finds HDR data.
        const merged = u8resp as ExrF32Response & {
          rgba_u8?: Uint8ClampedArray | null;
          rgba_f16?: Uint16Array | null;
        };
        if (f16resp.success && f16resp.rgba_f16 && f16resp.rgba_f16.length > 0) {
          merged.rgba_f16 = f16resp.rgba_f16;
          // 2026-07-13-fix: Always prefer F16 dynamic_range over U8's because
          // U8's is computed AFTER the [0,1] clamp at the FFI boundary (so it
          // caps at ~8.0 for HDR scenes), while F16's was computed BEFORE the
          // clamp (so it captures real HDR peak ratios like 8.46).
          // Without this fix, HDR scenes with dynamic_range slightly above 1.0
          // (e.g. 8.41) would fail the isHdri check (8.41 < 8.0 threshold)
          // and get aces=false = black screen.
          if (f16resp.dynamic_range != null && f16resp.dynamic_range > (merged.dynamic_range ?? 0)) {
            merged.dynamic_range = f16resp.dynamic_range;
          }
          dbg.log(
            `[Phase7-revisit] decodeForBeauty: U8+F16 dual path (U8=${(u8resp.rgba_u8.byteLength / 1024 / 1024).toFixed(2)} MB, F16=${(f16resp.rgba_f16.byteLength / 1024 / 1024).toFixed(2)} MB, ${u8resp.width}x${u8resp.height}) merged.dynamic_range=${merged.dynamic_range} f16resp.dynamic_range=${f16resp.dynamic_range}`,
          );
        } else {
          dbg.log(
            `[Phase7-revisit] decodeForBeauty: U8 path (F16 fallback failed: ${f16resp.error ?? "no pixels"} — HDR capture unavailable for re-render)`,
          );
        }
        return merged;
      }
      // U8 IPC failed — fall through to F16 / F32.
      dbg.log(
        `[Phase7] decodeForBeauty: U8 path failed (${u8resp.error ?? "no pixels"}), falling back to F16`,
      );
      if (f16resp.success && f16resp.rgba_f16 && f16resp.rgba_f16.length > 0) {
        return f16resp as ExrF32Response;
      }
    }

    // Try F16 first. decodeExrF16 now returns rgba_f16: Uint16Array
    // with rgba_f32=null — no JS-side expansion.
    if (isLikelyF16Safe) {
      const f16 = await decodeExrF16(filePath, maxSize, layerName);
      if (signal?.aborted) {
        return f16 as ExrF32Response;
      }
      if (f16.success && f16.rgba_f16 && f16.rgba_f16.length > 0) {
        dbg.log(
          `[Phase6] decodeForBeauty: F16 raw path (${(f16.rgba_f16.byteLength / 1024 / 1024).toFixed(2)} MB, ${f16.width}x${f16.height})`,
        );
        return f16 as ExrF32Response;
      }
      // F16 IPC returned nothing usable — fall through to F32.
      dbg.log(
        `[Phase6] decodeForBeauty: F16 path failed (${f16.error ?? "no pixels"}), falling back to F32`,
      );
    }

    // F32 path. For passes that Rust marks as F16-safe (Beauty, RGB,
    // AOVs without depth), opportunistically upgrade to F16 to halve
    // IPC bytes. The cache hit path returns F32 directly here.
    const f32 = await decodeExrF32(filePath, maxSize, layerName);
    if (signal?.aborted) {
      return f32;
    }
    const rustPassType = (f32 as { pass_type?: string }).pass_type;
    if (shouldUseF16Ipc(rustPassType)) {
      const f16 = await decodeExrF16(filePath, maxSize, layerName);
      if (signal?.aborted) {
        return f16 as ExrF32Response;
      }
      if (f16.success && f16.rgba_f16 && f16.rgba_f16.length > 0) {
        (f32 as { rgba_f32: Float32Array | null }).rgba_f32 = null;
        (f32 as { rgba_f16?: Uint16Array | null }).rgba_f16 = f16.rgba_f16;
        dbg.log(
          `[Phase6] decodeForBeauty: F16 raw upgrade (pass_type=${rustPassType}, ${(f16.rgba_f16.byteLength / 1024 / 1024).toFixed(2)} MB)`,
        );
      } else if (dbg.enabled) {
        dbg.log(
          `[Phase6] decodeForBeauty: F16 upgrade failed, keeping F32 buffer`,
        );
      }
    }
    return f32;
  }

  /**
   * Centralised accessor for the OCIO trace flag so every log
   * site (`setLut`, `decodeAndRender`, `decodeFrameToDataUrl`,
   * `setActiveSlug`) reads the same switch. Returning a fresh
   * boolean each call lets the user toggle it at runtime via
   * `window.__gokuDebugOcio = true` and immediately pick it up on
   * the next frame.
   */
  private isOcioTraceEnabled(): boolean {
    if (typeof window === "undefined") return false;
    return (
      window.location.hash.includes("debugOcio=1") ||
      (window as unknown as { __gokuDebugOcio?: boolean }).__gokuDebugOcio === true
    );
  }

  constructor(options: PipelineOptions = {}) {
    this.options = options;
  }

  /** Lazy-create the renderer on first use, attach to the given canvas. */
  private ensureRenderer(canvas: HTMLCanvasElement | OffscreenCanvas): RendererHandle | null {
    if (this.renderer) return this.renderer;
    this.renderer = createLutRenderer({
      canvas,
      preference: this.options.preference ?? "auto",
    });
    return this.renderer;
  }

  /**
   * Get the underlying renderer (for resize / dispose etc.). Returns null
   * if the renderer couldn't be created (legacy fallback path).
   */
  getRenderer(): RendererHandle | null {
    return this.renderer;
  }

  /**
   * Decode a frame and push it to the renderer + canvas. Returns the
   * metadata so the caller can update UI (size, channels, dynamic range).
   */
  async decodeAndRender(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    filePath: string,
    ocioModeHuman: string,
    layerName?: string,
  ): Promise<GpuFrameResult> {
    // Resolve OCIO slug (or null if unknown).
    const slug = HUMAN_TO_SLUG[ocioModeHuman] ?? OCIO_MODE_SLUGS.LINEAR_SRGB;

    // Auto-enable per-pixel OCIO debug logging when ?debugOcio=1 is in the
    // URL hash. Cheap (3 readPixels per frame) but we don't leave it on
    // by default. Can also be toggled via window.__gokuDebugOcio = true.
    const debugOcio = this.isOcioTraceEnabled();

    const renderer = this.ensureRenderer(canvas);
    if (!renderer) {
      // Last-resort fallback: FFI-only PNG decode via OpenEXRCore.
      // Caller should not show this frame in the GPU canvas; they should still
      // update their <img> from the returned png (handled by EXRSequencePlayer).
      this.lastUsedLegacy = true;
      const legacy = await decodeExr(filePath);
      return {
        success: legacy.success,
        width: legacy.width ?? 0,
        height: legacy.height ?? 0,
        channels: legacy.channels ?? [],
        dynamicRange: 1.0,
        usedLegacyFallback: true,
        error: legacy.error ?? undefined,
      };
    }

    try {
      // Resolve the LUT for the active OCIO mode. We always re-fetch
      // on the first frame after a mode switch so we can detect
      // identity LUTs (no PyOpenColorIO at build time) and decide
      // whether to fall back to the inline ACES shader path.
      let lutData: Float32Array;
      let lutSize: number;
      // `resolved` is hoisted to function scope so the post-LUT
      // logic (`isAcesMode`, `lutIsIdentity`, etc.) can read
      // `resolved.inputMax` / `resolved.isCustom` regardless of
      // whether the `if` or the `else` branch ran.
      const resolved = await this.resolveActiveLut(slug);
      lutData = resolved.data;
      lutSize = resolved.size;
      // DEBUG (2026-06-30 OCIO cleanup): surface what the pipeline
      // actually saw so we can tell apart "LUT is identity" from
      // "shader isn't sampling the LUT" from "values are < 1.0 so
      // SDR Video / Raw look the same". Gated by `?debugOcio=1` or
      // `window.__gokuDebugOcio = true` so it stays out of normal
      // release builds. Shared helper so both `decodeAndRender`
      // and `decodeFrameToDataUrl` pick up the same switch.
      if (this.lutLoadedFor !== slug) {
        renderer.renderer.setLut(lutData, lutSize);
        // Tell the shader what input domain this LUT was baked over so
        // it can divide per-pixel linear values correctly before
        // indexing. Identity LUTs (Raw / Linear sRGB) get 1.0; ACES
        // configs get 16.29.
        if (renderer.renderer.setLutInputMax) {
          renderer.renderer.setLutInputMax(resolved.inputMax);
        }
        this.lutLoadedFor = slug;
        if (this.isOcioTraceEnabled()) {
          // Identity check on the corners (debug-only, gated by
          // ?debugOcio=1). Computing the corners is cheap; the
          // gutter is just to keep the result warm in case a future
          // overlay reads it.
          const lastVoxelOffset = (lutSize * lutSize * lutSize - 1) * 3;
          const _corner000 = [lutData[0], lutData[1], lutData[2]];
          const _corner111 = [
            lutData[lastVoxelOffset],
            lutData[lastVoxelOffset + 1],
            lutData[lastVoxelOffset + 2],
          ];
          const mid = Math.floor(lutSize / 2);
          const midOffset = (mid * lutSize * lutSize + mid * lutSize + mid) * 3;
          const _cornerMid = [
            lutData[midOffset],
            lutData[midOffset + 1],
            lutData[midOffset + 2],
          ];
          void _corner000;
          void _corner111;
          void _cornerMid;
        }
      }

      // Decide which display pipeline to use for this OCIO mode:
      //   - "Linear sRGB" + "Raw": output raw linear pixels (no ACES, no
      //     gamma). This is what those modes promise — values pass
      //     through unclipped/untransformed.
      //   - "ACES 2.0": USE THE REAL OCIO LUT when one was baked at
      //     build time. The LUT was generated by PyOpenColorIO and
      //     encodes the full OCIO display transform (IDT + RRT + ODT +
      //     sRGB OETF). The LUT assumes scene-linear sRGB input (which
      //     is what every modern renderer exports as scene-linear EXR).
      //   - The inline ACES shader path (Hill fit) is the LAST-RESORT
      //     fallback for builds that genuinely don't have Python+OCIO
      //     at build time. In that case the LUT is identity and the
      //     inline path is more useful than identity. Otherwise we
      //     always use the LUT, which is strictly more accurate than
      //     the Hill fit.
      const isRawLinear =
        slug === OCIO_MODE_SLUGS.LINEAR_SRGB || slug === OCIO_MODE_SLUGS.RAW;
      // ACES view transforms are baked over the [0, 16.29] input
      // domain to cover the full ACES RRT output range. Use that as
      // the "is this ACES?" signal so all per-(display, view) ACES
      // slugs take the same shader path -- not just the legacy
      // `OCIO_MODE_SLUGS.ACES_2_0_CG` constant.
      const isAcesMode = resolved.inputMax > 1.0 && !isReinhardSlug(slug);
      const lutIsIdentity = isLutIdentity(lutData, lutSize);
      // IMPORTANT (2026-07-01 OCIO reality check): OCIO cg-config and
      // studio-config for ACES 1.3 split display colorspace into two
      // pieces — the `colorspace` only encodes the gamut/colour
      // science (e.g. sRGB primaries + D65 white), NOT the OETF. The
      // OETF/gamma is owned by the View Transform applied upstream of
      // the display colorspace. When you call
      //   OCIO.DisplayViewTransform(src='ACEScg', display='sRGB - Display',
      //                             view='ACES 1.0 - SDR Video')
      // the resulting processor outputs **display-referred LINEAR
      // sRGB primaries** — you still need to apply the OETF
      // (gamma encode) yourself when feeding 8-bit pixels to the
      // monitor. Verified empirically by calling applyRGB on pure
      // colours: red (1,0,0) ACEScg -> ~(0.96, 0, 0), which is the
      // linear value, not the gamma-encoded value (~0.98).
      //
      // The OCIO DisplayViewTransform applies the full display pipeline
      // including the sRGB OETF (gamma encode). PyOpenColorIO confirms:
      // input 0.5 -> output ~0.65 (gamma-encoded), NOT ~0.5 (linear).
      // So the LUT is already display-referred gamma-encoded — the shader
      // must skip linearToSRGB to avoid double-encoding. Without this fix
      // the output is ~2x darker than After Effects / OCIO Reference.
      const lutIncludesSrgbOetf = true;
      // Linear sRGB / Raw keep their passthrough semantics (no ACES,
      // no IDT) but the shader still needs to gamma-encode the
      // linear pixels so the sRGB monitor displays them with the
      // expected brightness/saturation. Previously `linearPassthrough`
      // skipped OETF — that produced the "brighter/warmer than AE"
      // look the user reported on view Raw. Match AE behaviour: the
      // AE Comp Window view transform always gamma-encodes for
      // display, regardless of which view you pick.
      // Allow ?forceInlineAces=1 to bypass the LUT and use the inline
      // Hill fit. Useful for diagnosing whether the OCIO LUT path is
      // wrong or the Hill fit constants are wrong: if both paths
      // produce the same dark image, the bug is in the Hill fit; if
      // only the LUT path is dark, the bug is in the LUT or its
      // sRGB OETF handling.
      //
      // DEFAULT POLICY (post 2026-06-30 OCIO re-alignment):
      //
      //   For the four built-in ACES modes the GPU pipeline uses the
      //   OCIO-baked LUT in preference to the inline Hill fit. The LUT
      //   is generated at build time by `Tools/gen_luts.py` using
      //   PyOpenColorIO against the official `ocio://cg-config-latest`
      //   / `studio-config-latest` configs. After the June 2026 OCIO
      //   cleanup we stopped pre-multiplying samples with a CAT02
      //   sRGB->ACEScg IDT inside `gen_luts.py` — that pre-multiply
      //   double-counted the IDT (the OCIO config already wires
      //   `ROLE_SCENE_LINEAR` to the right AP1 colours) and was the
      //   root cause of the "more saturated than AE" look that the
      //   inline Hill fit was hiding.
      //
      //   With the IDT pre-multiply removed, the LUT matches the
      //   colour pipeline of the previous Goku release (v1.0.1) which
      //   also ran without an IDT pre-multiply and relied on OCIO's
      //   own colour-routing machinery. The GPU path still accelerates
      //   playback — the LUT is sampled via a 3D texture lookup, one
      //   trilinear fetch per pixel.
      //
      //   The inline Hill fit remains available for two fallback
      //   cases:
      //     (a) the LUT is identity because PyOpenColorIO was missing
      //         at build time (the runtime detects this and routes to
      //         inline so the user still sees a tone-mapped image
      //         instead of crushed linear pixels);
      //     (b) diagnostics: open the app with `?forceInlineAces=1`
      //         to bypass the LUT and see what the inline Hill
      //         3-term rational fit produces in isolation.
      // FIXED (2026-06-30): LUT now matches Python v1.0.1 — use LUT by default
      // for ACES modes instead of inline Hill fit. The Hill fit is an
      // approximation that produces slightly different results.
      // Note: `userInlineChoice` here is the runtime override query param
      // (?forceInlineAces=1). The const was inlined earlier in the file.
      renderer.renderer.setLinearPassthrough(isRawLinear);
      renderer.renderer.setInlineAces(false);
      renderer.renderer.setLutBakedSrgbOetf(lutIncludesSrgbOetf);
      // The "useInlineAces" / "useLut" log is re-emitted after the HDR
      // re-route step below so the final routing decision is visible.

      // Fetch linear HDR pixels. Phase 6: use the F16 raw IPC path
      // (no half→float expansion on JS side) for layers that are F16-safe
      // (Beauty/RGB/AOVs). For non-Beauty layers (depth, position, normals,
      // motion vectors) we keep the F32 IPC path. The fallback to F32 inside
      // this block also covers the case where Rust reports the pass_type is
      // not F16-safe (e.g. "depth") even though the layer name looks innocent.
      const lowerLayer = (layerName ?? "").toLowerCase();
      const isLikelyF16Safe =
        !lowerLayer ||
        lowerLayer === "rgba" ||
        lowerLayer === "rgb" ||
        lowerLayer.includes("beauty") ||
        lowerLayer.includes("denoised");

      let f32Resp: ExrF32Response;
      let useF16Raw = false;
      if (isLikelyF16Safe) {
        // Phase 6 fast path: ask Rust for F16, keep the raw half-precision
        // Uint16Array on the JS side. Saves the ~30 ms half→float expansion
        // plus the 14 MB Float32Array allocation that the old path wasted.
        const f16Raw = await decodeExrF16Raw(filePath, undefined, layerName);
        if (f16Raw.success && f16Raw.rgba_f16) {
          f32Resp = {
            success: true,
            rgba_f32: null,
            rgba_f16: f16Raw.rgba_f16,
            width: f16Raw.width,
            height: f16Raw.height,
            channels: f16Raw.channels ?? [],
            layers_count: f16Raw.layers_count,
            layer_names: f16Raw.layer_names,
            dynamic_range: f16Raw.dynamic_range ?? 1.0,
            pass_type: f16Raw.pass_type ?? null,
            error: null,
          } as ExrF32Response;
          useF16Raw = true;
          if (dbg.enabled) {
            dbg.log(
              `[Phase6] decodeAndRender: F16 raw path active (${(f16Raw.rgba_f16.byteLength / 1024 / 1024).toFixed(2)} MB, ${f16Raw.width}x${f16Raw.height})`,
            );
          }
        } else {
          // F16 IPC returned no pixels (e.g. cache hit path returned
          // ExrF32DecodeOutcome::CacheHit without F16). Fall back to F32.
          if (dbg.enabled) {
            dbg.log(
              `[Phase6] decodeAndRender: F16 raw failed (${f16Raw.error ?? "no pixels"}), falling back to F32`,
            );
          }
          f32Resp = await decodeExrF32(filePath, undefined, layerName);
        }
      } else {
        f32Resp = await decodeExrF32(filePath, undefined, layerName);
        // Upgrade opportunistically if Rust reports a safe pass.
        const rustPassType = (f32Resp as { pass_type?: string }).pass_type;
        if (shouldUseF16Ipc(rustPassType)) {
          // Try the F16 raw path on the upgraded detection — it gives
          // us the speedup even when the layer name didn't match the
          // heuristic above.
          const f16Raw = await decodeExrF16Raw(filePath, undefined, layerName);
          if (f16Raw.success && f16Raw.rgba_f16) {
            (f32Resp as { rgba_f32: Float32Array | null }).rgba_f32 = null;
            (f32Resp as { rgba_f16?: Uint16Array | null }).rgba_f16 = f16Raw.rgba_f16;
            useF16Raw = true;
            if (dbg.enabled) {
              dbg.log(
                `[Phase6] decodeAndRender: F16 raw upgrade active (pass_type=${rustPassType})`,
              );
            }
          } else if (dbg.enabled) {
            dbg.log(
              `[Phase6] decodeAndRender: F16 raw upgrade failed, keeping F32 buffer`,
            );
          }
        }
      }
      // Hand the debug toggle to the renderer.
      if (renderer.renderer.setDebugOcio) {
        renderer.renderer.setDebugOcio(!!debugOcio);
      }
      // [Step 3a] Detect pass type from channels + filename.
      // Prefer Rust-side detection (mirrors Python 145 decoder) so single-channel
      // Y channels in single-layer EXRs (Z, AO, Roughness…) classify correctly.
      const channels = f32Resp.channels ?? [];
      const fileName = (filePath.split(/[\\/]/).pop() || filePath);
      const detected = detectPassType(
        layerName ?? "",
        channels,
        fileName,
        (f32Resp as { pass_type?: string }).pass_type,
      );
      if (this.isOcioTraceEnabled()) {
        dbg.log(
          `[EXR-GPU] Pass type: ${detected.label} (passType=${detected.passType}, bypass=${detected.bypassOcio}) for ${fileName} layer="${layerName ?? ""}" channels=[${channels.join(",")}]`,
        );
      }
      // Capture the raw pass_type for the UI (LayerCacheManager → EXRSequencePlayer)
      // so a HDR file's UI fallback to "Raw" can be enforced.
      this.lastPassType = (f32Resp as { pass_type?: string }).pass_type ?? null;
      // [Step 3b] Push the mode to the shader so non-color passes skip OCIO/ACES.
      renderer.renderer.setPassMode(detected.passType as unknown as 0);

      // Non-colour data passes (depth, normal, position, motion, UV,
      // grayscale, cryptomatte, AO, wireframe, …) skip OCIO/ACES by
      // forcing the renderer into bypass mode. Colour-managed passes
      // (RGB, HDR, HDRi, beauty, etc.) keep the user's LUT active.
      if (detected.bypassOcio) {
        if (renderer.renderer.setBypassOcio) {
          renderer.renderer.setBypassOcio(true);
        }
        this.lutLoadedFor = null;
        this.pendingSlug = null;
      } else {
        if (renderer.renderer.setBypassOcio) {
          renderer.renderer.setBypassOcio(false);
        }
      }

      // [Step 3c] HDR content re-route. The ACES 3D LUT is now baked
      // across [0, 16.29] (the ACES RRT peak scene white — see
      // `gen_luts.MODE_INPUT_MAX`), so the shader's `c / u_lutInputMax`
      // normalises HDR content back into the LUT cell range rather
      // than clamping it to 1.0. Anything above the LUT domain gets
      // squashed, so we still fall back to inline ACES (Hill fit) for
      // super-extreme highlights (e.g. a sun rendered in physical
      // units beyond ACES's peak white).
      //
      // Threshold derivation: dynamic_range is max/min; for our
      // threshold the worst-case we care about is a frame whose MAX
      // channel exceeds the ACES peak. We assume the min isn't
      // pathological (anything < ~0.01 would have been crushed during
      // CG render anyway), so:
      //   max ≈ dynamic_range * 0.01 → max > 16.29  ⇔
      //   dynamic_range > 1629.
      // Using 100× as a fudge factor (`OCIO_HDR_LUT_MAX_FACTOR` below).
      const dr = f32Resp.dynamic_range ?? 1.0;
      const hdrSignal = dr > OCIO_HDR_LUT_MAX_FACTOR;
      // 2026-07-13: Reinhard has its own HDR pipeline (the synthesised
      // 3D LUT already covers [0, 16] linearly with the whitepoint
      // extended Reinhard). Bypassing it to inline ACES (Hill fit)
      // would defeat the user's intent of seeing a Reinhard preview.
      const useInlineAcesForHdr = isAcesMode && hdrSignal && !isReinhardSlug(slug);
      if (useInlineAcesForHdr) {
        // Override the LUT path with inline ACES for HDR content.
        renderer.renderer.setInlineAces(true);
        renderer.renderer.setLutBakedSrgbOetf(false);
        dbg.log(
          `[EXR-GPU] HDR content detected (dynamic_range=${dr.toFixed(3)} > ${OCIO_HDR_LUT_MAX_FACTOR}): forcing inline ACES (Hill fit) instead of LUT for ${fileName}`,
        );
      }
      if (this.isOcioTraceEnabled()) {
        dbg.log(
          `[EXR-GPU] OCIO mode routing: slug=${slug} isRawLinear=${isRawLinear} useLut=${!useInlineAcesForHdr} lutIsIdentity=${lutIsIdentity} useInlineAces=${useInlineAcesForHdr} lutIncludesSrgbOetf=${useInlineAcesForHdr ? false : lutIncludesSrgbOetf}`,
        );
      }
      if (
        !f32Resp.success ||
        !(f32Resp.rgba_f32 || f32Resp.rgba_f16) ||
        !f32Resp.width ||
        !f32Resp.height
      ) {
        throw new Error(f32Resp.error ?? "decodeExr failed (no pixels)");
      }

      // Resize canvas to the source resolution (browser will downscale
      // on draw — same as the legacy path).
      renderer.renderer.resize(f32Resp.width, f32Resp.height);

      // Auto-exposure: enable u_autoExposure when the frame is HDR so the
      // shader divides every pixel by a P99-luminance divisor before tone-
      // mapping. This is what makes HDRI files (e.g. valley_of_desolation
      // with dynamic_range ~185167) actually visible instead of clamping to
      // white. Returns 0 (disabled) for normal render-engine EXR files.
      //
      // 2026-07-13: Reinhard handles HDR dynamics on its own
      // (asymptote at L_d=1.0 for L_w→∞). P99 scaling makes midtones
      // artificially dark and the LUT input clamps to the corner.
      // Disable auto-exposure for Reinhard — the LUT's expanded
      // input domain (4096) plus Reinhard's soft shoulder handles
      // the dynamic range.
      const autoExposure = isReinhardSlug(slug)
        ? 0
        : this.computeAutoExposureIfHdr(
            this.pickPixelsForRenderer(f32Resp),
            f32Resp.width,
            f32Resp.height,
            f32Resp.dynamic_range ?? 1.0,
            this.pickIsHalfFloat(f32Resp),
          );
      if (renderer.renderer.setAutoExposure) {
        renderer.renderer.setAutoExposure(autoExposure);
      }

      // Push to GPU (or CPU) renderer.
      renderer.renderer.loadFrame(
        this.pickPixelsForRenderer(f32Resp),
        f32Resp.width,
        f32Resp.height,
        this.pickIsHalfFloat(f32Resp),
      );
      await renderer.renderer.render();

      this.lastUsedLegacy = false;
      this.initialized = true;

      return {
        success: true,
        width: f32Resp.width,
        height: f32Resp.height,
        channels: f32Resp.channels ?? [],
        dynamicRange: f32Resp.dynamic_range ?? 1.0,
        usedLegacyFallback: false,
      };
    } catch (err) {
      // Any error → fall back to legacy for this frame, keep renderer
      // around for next attempt.
      console.warn("[EXR-GPU] Falling back to legacy:", err);
      this.lastUsedLegacy = true;
      const legacy = await decodeExr(filePath);
      return {
        success: legacy.success,
        width: legacy.width ?? 0,
        height: legacy.height ?? 0,
        channels: legacy.channels ?? [],
        dynamicRange: 1.0,
        usedLegacyFallback: true,
        error: legacy.error ?? undefined,
      };
    }
  }

  /** Render a buffer that was already decoded (e.g. for cached frames). */
  async renderCachedFrame(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    rgbaF32: Float32Array,
    width: number,
    height: number,
    channels: string[],
    dynamicRange: number,
  ): Promise<GpuFrameResult> {
    const renderer = this.ensureRenderer(canvas);
    if (!renderer) {
      return {
        success: false,
        width,
        height,
        channels,
        dynamicRange,
        usedLegacyFallback: true,
        error: "Renderer not initialized",
      };
    }
    renderer.renderer.resize(width, height);
    renderer.renderer.loadFrame(rgbaF32, width, height, false);
    await renderer.renderer.render();
    return {
      success: true,
      width,
      height,
      channels,
      dynamicRange,
      usedLegacyFallback: false,
    };
  }

  /**
   * Phase 6C removed (refactor): `rerenderCachedFrameWithLut` was
   * the JS-side re-render path that depended on Float32RawCache
   * (also removed). OCIO mode switches now always go through a
   * full Rust decode; the Rust `EXR-CACHE-LRU` + `EXR disk cache`
   * make that ~200 ms cheap enough that the JS-side optimisation
   * was no longer worth the cache-eviction-mismatch complexity.
   *
   * The `ensureOffscreenCanvas()` helper is retained below — it is
   * still used by the PNG data-URL path.
   */

  /** Phase 7: lazily create the offscreen canvas and return it. Used
   *  by the PNG data-URL path and by external callers that need to
   *  read back the rendered output. */
  async ensureOffscreenCanvas(): Promise<HTMLCanvasElement | OffscreenCanvas> {
    if (!this.offscreenCanvas) {
      try {
        this.offscreenCanvas = new OffscreenCanvas(1, 1);
      } catch {
        const c = document.createElement("canvas");
        c.width = 1;
        c.height = 1;
        this.offscreenCanvas = c;
      }
    }
    return this.offscreenCanvas;
  }

  /** Phase 6C public helper: convert a canvas to PNG base64 (no `data:` prefix). */
  async canvasToBase64Public(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
    return this.canvasToBase64(canvas);
  }

  hasUsedLegacy(): boolean {
    return this.lastUsedLegacy;
  }

  /**
   * Cache-friendly decode: GPU pipeline → PNG data URL, identical shape to
   * `decodeExr`. Used by LayerCacheManager as a drop-in replacement for
   * the legacy Python OCIO path when GPU mode is enabled.
   *
   * Returns `{ success, png_base64, width, height, channels, usedLegacyFallback, error }`.
   * On GPU failure, falls back to legacy `decodeExr` so the caller never
   * gets a worse result than before.
   */
  /**
   * Decode a frame and return both the rendered PNG data URL AND the
   * raw linear f32 buffer (kept in the Rust LRU + disk cache only).
   * Returns `{ png_base64, raw_f32, width, height, channels, ... }`.
   *
   * The raw f32 buffer is no longer mirrored to a JS-side cache
   * (Float32RawCache was removed in the cache-layer refactor). The
   * Rust `EXR-CACHE-LRU` + `EXR disk cache` hold the authoritative
   * copy; an OCIO mode switch simply re-decodes from there.
   */
  async decodeFrameAndCacheRaw(
    filePath: string,
    maxSize?: number,
    layerName?: string,
  ): Promise<{
    success: boolean;
    png_base64: string | null;
    raw_f32: Float32Array | null;
    width: number | null;
    height: number | null;
    channels: string[] | null;
    passType: string | null;
    usedLegacyFallback: boolean;
    error: string | null;
  }> {
    // ...existing decodeFrameToDataUrl, but also stash the raw f32.
    // We do this by piggy-backing on the existing call: it already
    // calls decodeExrF16 internally and produces a PNG; we just
    // intercept the f32 buffer before texImage2D upload.
    //
    // To keep the change minimal, we duplicate the function body but
    // capture the f32 buffer at the same point. The duplication is
    // acceptable because this is the hot path and any further
    // consolidation would risk regressing the existing one.
    const debugOcio = this.isOcioTraceEnabled();
    if (!this.offscreenCanvas) {
      try {
        this.offscreenCanvas = new OffscreenCanvas(1, 1);
      } catch {
        const c = document.createElement("canvas");
        c.width = 1;
        c.height = 1;
        this.offscreenCanvas = c;
      }
    }
    const canvas = this.offscreenCanvas!;

    const slug = this.getCurrentSlug();
    const tStart = performance.now();

    try {
      const renderer = this.ensureRenderer(canvas);
      if (!renderer) {
        const legacy = await this.legacyFallback(filePath, layerName);
        return {
          success: legacy.success,
          png_base64: legacy.png_base64,
          raw_f32: null,
          width: legacy.width,
          height: legacy.height,
          channels: legacy.channels,
          passType: null,
          usedLegacyFallback: true,
          error: legacy.error,
        };
      }

      const resolved = await this.resolveActiveLut(slug);
      if (this.lutLoadedFor !== slug) {
        renderer.renderer.setLut(resolved.data, resolved.size);
        if (renderer.renderer.setLutInputMax) {
          renderer.renderer.setLutInputMax(resolved.inputMax);
        }
        this.lutLoadedFor = slug;
      }

      const isRawLinear =
        slug === OCIO_MODE_SLUGS.LINEAR_SRGB || slug === OCIO_MODE_SLUGS.RAW;
      const isAcesMode = resolved.inputMax > 1.0 && !isReinhardSlug(slug);
      const lutIncludesSrgbOetf = true;
      const forceInlineCacheless =
        (typeof window !== "undefined" &&
          /forceInlineAces=([01])/.exec(
            window.location.search + window.location.hash,
          )?.[1] === "1");
      const useInlineAces = forceInlineCacheless ?? false;
      renderer.renderer.setLinearPassthrough(isRawLinear);
      renderer.renderer.setInlineAces(useInlineAces);
      renderer.renderer.setLutBakedSrgbOetf(lutIncludesSrgbOetf);

      // Phase 6: delegate to the centralised F16-with-fallback decoder so
      // every entry point gets the same fast path. The legacy inline
      // F16/F32 routing here was missed by Phase 6 round 1 — only
      // decodeAndRender was patched, the rest still paid the ~30 ms
      // half→float expansion cost.
      const f32Resp = await this.decodeForBeauty(filePath, maxSize, layerName);
      const channels = f32Resp.channels ?? [];
      const fileName = (filePath.split(/[\\/]/).pop() || filePath);
      const detected = detectPassType(
        layerName ?? "",
        channels,
        fileName,
        (f32Resp as { pass_type?: string }).pass_type,
      );
      const rustPassType = (f32Resp as { pass_type?: string }).pass_type;
      this.lastPassType = rustPassType ?? null;
      if (this.isOcioTraceEnabled()) {
        dbg.log(
          `[EXR-GPU] Pass type: ${detected.label} (passType=${detected.passType}, bypass=${detected.bypassOcio}) for ${fileName} layer="${layerName ?? ""}" channels=[${channels.join(",")}]`,
        );
      }
      renderer.renderer.setPassMode(detected.passType as unknown as 0);

      const dr2 = f32Resp.dynamic_range ?? 1.0;
      const hdrSignal = dr2 > OCIO_HDR_LUT_MAX_FACTOR;
      // See comment at the first site for the Reinhard rationale.
      const useInlineAcesForHdr = isAcesMode && hdrSignal && !isReinhardSlug(slug);
      if (useInlineAcesForHdr) {
        renderer.renderer.setInlineAces(true);
        renderer.renderer.setLutBakedSrgbOetf(false);
        dbg.log(
          `[EXR-GPU] HDR content detected (dynamic_range=${dr2.toFixed(3)} > ${OCIO_HDR_LUT_MAX_FACTOR}): forcing inline ACES (Hill fit) instead of LUT for ${fileName}`,
        );
      }
      if (
        !f32Resp.success ||
        !(f32Resp.rgba_f32 || f32Resp.rgba_f16) ||
        !f32Resp.width ||
        !f32Resp.height
      ) {
        throw new Error(f32Resp.error ?? "decodeExr failed (no pixels)");
      }

      const w = f32Resp.width;
      const h = f32Resp.height;
      renderer.renderer.resize(w, h);
      // Auto-exposure: enable u_autoExposure when the frame is HDR so the
      // shader divides every pixel by a P99-luminance divisor before tone-
      // mapping. Returns 0 (disabled) for normal render-engine EXR files.
      // 2026-07-13: see comment at the first site — Reinhard handles
      // HDR dynamics on its own, disable auto-exposure for it.
      const autoExposureB = isReinhardSlug(slug)
        ? 0
        : this.computeAutoExposureIfHdr(
            this.pickPixelsForRenderer(f32Resp),
            w,
            h,
            f32Resp.dynamic_range ?? 1.0,
            this.pickIsHalfFloat(f32Resp),
          );
      if (renderer.renderer.setAutoExposure) {
        renderer.renderer.setAutoExposure(autoExposureB);
      }
      if (renderer.renderer.setDebugOcio) {
        renderer.renderer.setDebugOcio(!!debugOcio);
      }
      renderer.renderer.loadFrame(
        this.pickPixelsForRenderer(f32Resp),
        w,
        h,
        this.pickIsHalfFloat(f32Resp),
      );
      await renderer.renderer.render();

      let outW = w;
      let outH = h;
      if (maxSize && Math.max(w, h) > maxSize) {
        const scale = maxSize / Math.max(w, h);
        outW = Math.max(1, Math.round(w * scale));
        outH = Math.max(1, Math.round(h * scale));
        const small = document.createElement("canvas");
        small.width = outW;
        small.height = outH;
        const ctx = small.getContext("2d");
        if (ctx) {
          ctx.drawImage(canvas as HTMLCanvasElement | OffscreenCanvas, 0, 0, outW, outH);
          this.offscreenCanvas = small;
        }
      }

      const png_base64 = await this.canvasToBase64(this.offscreenCanvas);
      const elapsed = performance.now() - tStart;
      dbg.log(`[EXR-GPU] decodeFrameAndCacheRaw OK in ${elapsed.toFixed(1)}ms (${w}x${h})`);

      this.lastUsedLegacy = false;
      this.initialized = true;

      return {
        success: true,
        png_base64,
        raw_f32: f32Resp.rgba_f32, // null on F16 fast path (Phase 6)
        width: outW,
        height: outH,
        channels: f32Resp.channels ?? [],
        passType: rustPassType ?? null,
        usedLegacyFallback: false,
        error: null,
      };
    } catch (err) {
      console.warn("[EXR-GPU] decodeFrameAndCacheRaw failed, falling back to legacy:", err);
      const legacy = await this.legacyFallback(filePath, layerName);
      return {
        success: legacy.success,
        png_base64: legacy.png_base64,
        raw_f32: null,
        width: legacy.width,
        height: legacy.height,
        channels: legacy.channels,
        passType: null,
        usedLegacyFallback: true,
        error: legacy.error,
      };
    }
  }

  async decodeFrameToDataUrl(
    filePath: string,
    maxSize?: number,
    layerName?: string,
  ): Promise<{
    success: boolean;
    png_base64: string | null;
    width: number | null;
    height: number | null;
    channels: string[] | null;
    usedLegacyFallback: boolean;
    error: string | null;
  }> {
    // Per-pixel OCIO trace toggle. Enable from the URL with
    // `?debugOcio=1` or programmatically via `window.__gokuDebugOcio = true`.
    // Disabled by default to keep the console clean.
    const debugOcio = this.isOcioTraceEnabled();

    // Ensure we have a hidden canvas to render into. We lazy-create it
    // here rather than in the constructor because the pipeline is
    // typically created in React render, before any DOM is mounted.
    if (!this.offscreenCanvas) {
      try {
        this.offscreenCanvas = new OffscreenCanvas(1, 1);
      } catch {
        const c = document.createElement("canvas");
        c.width = 1;
        c.height = 1;
        this.offscreenCanvas = c;
      }
    }
    const canvas = this.offscreenCanvas!;

    const slug = this.getCurrentSlug();
    const tStart = performance.now();

    try {
      // Lazily attach renderer to the offscreen canvas.
      const renderer = this.ensureRenderer(canvas);
      if (!renderer) {
        return await this.legacyFallback(filePath, layerName);
      }

      // Resolve LUT for the active OCIO mode.
      let lutData: Float32Array;
      let lutSize: number;
      // `resolved` is hoisted to function scope so the post-LUT
      // logic (`isAcesMode`, `lutIsIdentity`, etc.) can read
      // `resolved.inputMax` / `resolved.isCustom` regardless of
      // which branch above ran. The Rust side caches LUTs by
      // slug, so the re-fetch in the `else` branch is cheap.
      const resolved = await this.resolveActiveLut(slug);
      lutData = resolved.data;
      lutSize = resolved.size;
      if (this.lutLoadedFor !== slug) {
        renderer.renderer.setLut(lutData, lutSize);
        if (renderer.renderer.setLutInputMax) {
          renderer.renderer.setLutInputMax(resolved.inputMax);
        }
        this.lutLoadedFor = slug;
        if (this.isOcioTraceEnabled()) {
          // Identity check on the corners (debug-only, gated by
          // ?debugOcio=1). Computing the corners is cheap; the
          // gutter is just to keep the result warm in case a future
          // overlay reads it.
          const lastVoxelOffset = (lutSize * lutSize * lutSize - 1) * 3;
          const _corner000 = [lutData[0], lutData[1], lutData[2]];
          const _corner111 = [
            lutData[lastVoxelOffset],
            lutData[lastVoxelOffset + 1],
            lutData[lastVoxelOffset + 2],
          ];
          const mid = Math.floor(lutSize / 2);
          const midOffset = (mid * lutSize * lutSize + mid * lutSize + mid) * 3;
          const _cornerMid = [
            lutData[midOffset],
            lutData[midOffset + 1],
            lutData[midOffset + 2],
          ];
          void _corner000;
          void _corner111;
          void _cornerMid;
        }
      }

      // Route the OCIO mode to the right shader path. Mirrors the
      // decodeAndRender() logic — see the comment block there for the
      // full rationale. The OCIO config's ROLE_SCENE_LINEAR is the
      // assumed input color space; no per-file detection.
      const isRawLinear =
        slug === OCIO_MODE_SLUGS.LINEAR_SRGB || slug === OCIO_MODE_SLUGS.RAW;
      // ACES view transforms are baked over the [0, 16.29] input
      // domain to cover the full ACES RRT output range. Use that as
      // the "is this ACES?" signal so all per-(display, view) ACES
      // slugs take the same shader path -- not just the legacy
      // `OCIO_MODE_SLUGS.ACES_2_0_CG` constant.
      const isAcesMode = resolved.inputMax > 1.0 && !isReinhardSlug(slug);
      const lutIsIdentity = isLutIdentity(lutData, lutSize);
      // IMPORTANT (2026-07-01 OCIO reality check): OCIO cg-config and
      // studio-config for ACES 1.3 split display colorspace into two
      // pieces — the `colorspace` only encodes the gamut/colour
      // science (e.g. sRGB primaries + D65 white), NOT the OETF. The
      // OETF/gamma is owned by the View Transform applied upstream of
      // the display colorspace. When you call
      //   OCIO.DisplayViewTransform(src='ACEScg', display='sRGB - Display',
      //                             view='ACES 1.0 - SDR Video')
      // the resulting processor outputs **display-referred LINEAR
      // sRGB primaries** — you still need to apply the OETF
      // (gamma encode) yourself when feeding 8-bit pixels to the
      // monitor. Verified empirically by calling applyRGB on pure
      // colours: red (1,0,0) ACEScg -> ~(0.96, 0, 0), which is the
      // linear value, not the gamma-encoded value (~0.98).
      //
      // The OCIO DisplayViewTransform applies the full display pipeline
      // including the sRGB OETF (gamma encode). PyOpenColorIO confirms:
      // input 0.5 -> output ~0.65 (gamma-encoded), NOT ~0.5 (linear).
      // So the LUT is already display-referred gamma-encoded — the shader
      // must skip linearToSRGB to avoid double-encoding. Without this fix
      // the output is ~2x darker than After Effects / OCIO Reference.
      const lutIncludesSrgbOetf = true;
      // Linear sRGB / Raw keep their passthrough semantics (no ACES,
      // no IDT) but the shader still needs to gamma-encode the
      // linear pixels so the sRGB monitor displays them with the
      // expected brightness/saturation. Previously `linearPassthrough`
      // skipped OETF — that produced the "brighter/warmer than AE"
      // look the user reported on view Raw. Match AE behaviour: the
      // AE Comp Window view transform always gamma-encodes for
      // display, regardless of which view you pick.
      const forceInlineCacheless =
        (typeof window !== "undefined" &&
          /forceInlineAces=([01])/.exec(
            window.location.search + window.location.hash,
          )?.[1] === "1");
      // FIXED (2026-06-30): LUT now matches Python v1.0.1 — use LUT by default.
      const useInlineAces = forceInlineCacheless ?? false;
      renderer.renderer.setLinearPassthrough(isRawLinear);
      renderer.renderer.setInlineAces(useInlineAces);
      renderer.renderer.setLutBakedSrgbOetf(lutIncludesSrgbOetf);

      // Phase 6: delegate to the centralised F16-with-fallback decoder.
      // This entry point (decodeFrameToDataUrl) used to pay the
      // ~30 ms half→float expansion cost on every Beauty/AOV frame.
      const f32Resp = await this.decodeForBeauty(filePath, maxSize, layerName);
      // [Step 3a] Detect pass type — use Rust-side detection first.
      const channels = f32Resp.channels ?? [];
      const fileName = (filePath.split(/[\\/]/).pop() || filePath);
      const detected = detectPassType(
        layerName ?? "",
        channels,
        fileName,
        (f32Resp as { pass_type?: string }).pass_type,
      );
      const rustPassType = (f32Resp as { pass_type?: string }).pass_type;
      this.lastPassType = rustPassType ?? null;
      if (this.isOcioTraceEnabled()) {
        dbg.log(
          `[EXR-GPU] Pass type: ${detected.label} (passType=${detected.passType}, bypass=${detected.bypassOcio}) for ${fileName} layer="${layerName ?? ""}" channels=[${channels.join(",")}]`,
        );
      }
      // Capture the raw pass_type for the UI (LayerCacheManager → EXRSequencePlayer)
      // so a HDR file's UI fallback to "Raw" can be enforced.
      this.lastPassType = (f32Resp as { pass_type?: string }).pass_type ?? null;
      // [Step 3b] Push the mode to the shader so non-color passes skip OCIO/ACES.
      renderer.renderer.setPassMode(detected.passType as unknown as 0);

      // Non-colour data passes (depth, normal, position, motion, UV,
      // grayscale, cryptomatte, AO, wireframe, …) skip OCIO/ACES by
      // forcing the renderer into bypass mode. Colour-managed passes
      // (RGB, HDR, HDRi, beauty, etc.) keep the user's LUT active.
      if (detected.bypassOcio) {
        if (renderer.renderer.setBypassOcio) {
          renderer.renderer.setBypassOcio(true);
        }
        this.lutLoadedFor = null;
        this.pendingSlug = null;
      } else {
        if (renderer.renderer.setBypassOcio) {
          renderer.renderer.setBypassOcio(false);
        }
      }

      // [Step 3c] HDR content re-route. The ACES 3D LUT is now baked
      // across [0, 16.29] (the ACES RRT peak scene white — see
      // `gen_luts.MODE_INPUT_MAX`), so the shader's `c / u_lutInputMax`
      // normalises HDR content back into the LUT cell range rather
      // than clamping it to 1.0. Only super-extreme highlights
      // (dynamic_range > OCIO_HDR_LUT_MAX_FACTOR) exceed the LUT
      // domain and warrant the inline-ACES (Hill fit) fallback.
      const dr2 = f32Resp.dynamic_range ?? 1.0;
      const hdrSignal = dr2 > OCIO_HDR_LUT_MAX_FACTOR;
      // See comment at the first site for the Reinhard rationale.
      const useInlineAcesForHdr = isAcesMode && hdrSignal && !isReinhardSlug(slug);
      if (useInlineAcesForHdr) {
        // Override the LUT path with inline ACES for HDR content.
        renderer.renderer.setInlineAces(true);
        renderer.renderer.setLutBakedSrgbOetf(false);
        dbg.log(
          `[EXR-GPU] HDR content detected (dynamic_range=${dr2.toFixed(3)} > ${OCIO_HDR_LUT_MAX_FACTOR}): forcing inline ACES (Hill fit) instead of LUT for ${fileName}`,
        );
      }
      if (this.isOcioTraceEnabled()) {
        dbg.log(
          `[EXR-GPU] OCIO mode routing: slug=${slug} isRawLinear=${isRawLinear} useLut=${!useInlineAcesForHdr} lutIsIdentity=${lutIsIdentity} useInlineAces=${useInlineAcesForHdr} lutIncludesSrgbOetf=${useInlineAcesForHdr ? false : lutIncludesSrgbOetf}`,
        );
      }
      if (
        !f32Resp.success ||
        !(f32Resp.rgba_f32 || f32Resp.rgba_f16) ||
        !f32Resp.width ||
        !f32Resp.height
      ) {
        throw new Error(f32Resp.error ?? "decodeExr failed (no pixels)");
      }

      const w = f32Resp.width;
      const h = f32Resp.height;

      // Resize offscreen canvas to source resolution. The browser's
      // canvas2d drawImage will handle downscaling if the caller wants a
      // smaller maxSize.
      renderer.renderer.resize(w, h);

      // Auto-exposure: enable u_autoExposure when the frame is HDR so the
      // shader divides every pixel by a P99-luminance divisor before tone-
      // mapping. Returns 0 (disabled) for normal render-engine EXR files.
      // (Previously hard-coded to 0 here; the HDR branch now opts in.)
      // 2026-07-13: see comment at the first site — Reinhard handles
      // HDR dynamics on its own.
      const autoExposureC = isReinhardSlug(slug)
        ? 0
        : this.computeAutoExposureIfHdr(
            this.pickPixelsForRenderer(f32Resp),
            w,
            h,
            f32Resp.dynamic_range ?? 1.0,
        this.pickIsHalfFloat(f32Resp),
      );
      if (renderer.renderer.setAutoExposure) {
        renderer.renderer.setAutoExposure(autoExposureC);
      }

      // TEMPORARY DEBUG: force per-pixel OCIO trace (see decodeAndRender
      // above for the matching block). Set debugOcio to true to dump
      // raw/postExpo/lutRef/final for 3 sample pixels per render.
      if (renderer.renderer.setDebugOcio) {
        renderer.renderer.setDebugOcio(!!debugOcio);
      }
      renderer.renderer.loadFrame(
        this.pickPixelsForRenderer(f32Resp),
        w,
        h,
        this.pickIsHalfFloat(f32Resp),
      );
      await renderer.renderer.render();

      // Optional downscale for memory efficiency (same behavior as
      // legacy decode_exr's max_size param).
      let outW = w;
      let outH = h;
      if (maxSize && Math.max(w, h) > maxSize) {
        const scale = maxSize / Math.max(w, h);
        outW = Math.max(1, Math.round(w * scale));
        outH = Math.max(1, Math.round(h * scale));
        // The canvas's drawImage() downscale is reasonable here for
        // thumbnails. We can't downscale an already-rendered GPU output
        // cheaply, so use a 2D canvas copy.
        const small = document.createElement("canvas");
        small.width = outW;
        small.height = outH;
        const ctx = small.getContext("2d");
        if (ctx) {
          ctx.drawImage(canvas as HTMLCanvasElement | OffscreenCanvas, 0, 0, outW, outH);
          this.offscreenCanvas = small;
        }
      }

      const png_base64 = await this.canvasToBase64(this.offscreenCanvas);
      const elapsed = performance.now() - tStart;
      dbg.log(`[EXR-GPU] decodeFrameToDataUrl OK in ${elapsed.toFixed(1)}ms (${w}x${h})`);

      this.lastUsedLegacy = false;
      this.initialized = true;

      return {
        success: true,
        png_base64,
        width: outW,
        height: outH,
        channels: f32Resp.channels ?? [],
        usedLegacyFallback: false,
        error: null,
      };
    } catch (err) {
      console.warn("[EXR-GPU] decodeFrameToDataUrl failed, falling back to legacy:", err);
      return await this.legacyFallback(filePath, layerName);
    }
  }

  /**
   * Phase 6B: same as `decodeFrameToDataUrl` but the rendered output is
   * returned as an `ImageBitmap` instead of a base64 PNG string. ImageBitmap
   * is GPU-backed and `drawImage(bitmap)` runs at native speed (~5-10 ms
   * vs ~100-200 ms for PNG decode + upload). Used by the cache path when
   * the consumer renders via canvas.drawImage rather than `<img src=>`.
   */
  async decodeFrameToBitmap(
    filePath: string,
    maxSize?: number,
    layerName?: string,
    customFingerprint?: string,
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    bitmap: ImageBitmap | null;
    width: number | null;
    height: number | null;
    channels: string[] | null;
    usedLegacyFallback: boolean;
    error: string | null;
  }> {
    if (signal?.aborted) {
      return {
        success: false,
        bitmap: null,
        width: null,
        height: null,
        channels: null,
        usedLegacyFallback: false,
        error: "aborted",
      };
    }
    const tStart = performance.now();
    const canvas = await this.ensureOffscreenCanvas();
    try {
      const renderer = this.ensureRenderer(canvas);
      if (!renderer) {
        return await this.legacyBitmapFallback(filePath, layerName, maxSize);
      }

    const slug = this.getCurrentSlug();
    dbg.log(
      `[EXR-GPU-LUT] decodeFrameToBitmap BEGIN: slug="${slug}" ` +
        `file="${(filePath.split(/[\\/]/).pop() || filePath)}" layer="${layerName ?? ""}"`,
    );
    const isRawLinearSlug =
      slug === OCIO_MODE_SLUGS.LINEAR_SRGB || slug === OCIO_MODE_SLUGS.RAW;
    dbg.log(
      `[EXR-GPU-LUT] slug classification: isRawLinear=${isRawLinearSlug}`,
    );
    const resolved = await this.resolveActiveLut(slug);
    if (signal?.aborted) {
      return {
        success: false,
        bitmap: null,
        width: null,
        height: null,
        channels: null,
        usedLegacyFallback: false,
        error: "aborted",
      };
    }
    dbg.log(
      `[EXR-GPU-LUT] resolved LUT: size=${resolved.size}³ ` +
        `data.length=${resolved.data.length} inputMax=${resolved.inputMax.toFixed(3)} ` +
        `isCustom=${resolved.isCustom} lutLoadedFor(prior)="${this.lutLoadedFor ?? "<null>"}"`,
    );
    if (this.lutLoadedFor !== slug) {
      renderer.renderer.setLut(resolved.data, resolved.size);
      if (renderer.renderer.setLutInputMax) {
        renderer.renderer.setLutInputMax(resolved.inputMax);
      }
      this.lutLoadedFor = slug;
      dbg.log(
        `[EXR-GPU-LUT] upload: setLut() called (slug changed from "${this.lutLoadedFor}" to "${slug}")`,
      );
    } else {
      dbg.log(
        `[EXR-GPU-LUT] upload: SKIPPED (slug unchanged, reusing already-uploaded LUT)`,
      );
    }

    const isRawLinear =
      slug === OCIO_MODE_SLUGS.LINEAR_SRGB || slug === OCIO_MODE_SLUGS.RAW;
    const isAcesMode = resolved.inputMax > 1.0 && !isReinhardSlug(slug);
    const lutIncludesSrgbOetf = true;
    renderer.renderer.setLinearPassthrough(isRawLinear);
    renderer.renderer.setInlineAces(false);
    renderer.renderer.setLutBakedSrgbOetf(lutIncludesSrgbOetf);
    dbg.log(
      `[EXR-GPU-LUT] shader uniforms: ` +
        `linearPassthrough=${isRawLinear} inlineAces=false lutBakedSrgbOetf=${lutIncludesSrgbOetf} ` +
        `isAcesMode=${isAcesMode} (inputMax=${resolved.inputMax.toFixed(3)})`,
    );

      // Phase 6: delegate to the centralised F16-with-fallback decoder.
      const f32Resp = await this.decodeForBeauty(filePath, maxSize, layerName);
      if (signal?.aborted) {
        return {
          success: false,
          bitmap: null,
          width: null,
          height: null,
          channels: null,
          usedLegacyFallback: false,
          error: "aborted",
        };
      }
      const channels = f32Resp.channels ?? [];
      const fileName = (filePath.split(/[\\/]/).pop() || filePath);
      const detected = detectPassType(
        layerName ?? "",
        channels,
        fileName,
        (f32Resp as { pass_type?: string }).pass_type,
      );
      this.lastPassType = (f32Resp as { pass_type?: string }).pass_type ?? null;
      renderer.renderer.setPassMode(detected.passType as unknown as 0);

      // Non-colour data passes (depth, normal, position, motion, UV,
      // grayscale, cryptomatte, AO, wireframe, …) skip OCIO/ACES by
      // forcing the renderer into bypass mode. Colour-managed passes
      // (RGB, HDR, HDRi, beauty, etc.) keep the user's LUT active.
      // When entering bypass we also clear `lutLoadedFor` so the next
      // non-bypass frame re-uploads the LUT instead of reusing the
      // (now-stale) one for a different buffer.
      if (detected.bypassOcio) {
        if (renderer.renderer.setBypassOcio) {
          renderer.renderer.setBypassOcio(true);
        }
        this.lutLoadedFor = null;
        this.pendingSlug = null;
      } else {
        if (renderer.renderer.setBypassOcio) {
          renderer.renderer.setBypassOcio(false);
        }
      }

      const dr2 = f32Resp.dynamic_range ?? 1.0;
      const hdrSignal = dr2 > OCIO_HDR_LUT_MAX_FACTOR;
      // See comment at the first site for the Reinhard rationale.
      const useInlineAcesForHdr = isAcesMode && hdrSignal && !isReinhardSlug(slug);
      if (useInlineAcesForHdr) {
        renderer.renderer.setInlineAces(true);
        renderer.renderer.setLutBakedSrgbOetf(false);
      }

      if (
        !f32Resp.success ||
        !(f32Resp.rgba_f32 || f32Resp.rgba_f16) ||
        !f32Resp.width ||
        !f32Resp.height
      ) {
        throw new Error(f32Resp.error ?? "decodeExr failed (no pixels)");
      }

      const w = f32Resp.width;
      const h = f32Resp.height;
      renderer.renderer.resize(w, h);

      // Auto-exposure: enable u_autoExposure when the frame is HDR so the
      // shader divides every pixel by a P99-luminance divisor before tone-
      // mapping. Returns 0 (disabled) for normal render-engine EXR files.
      // 2026-07-13: see comment at the first site — Reinhard handles
      // HDR dynamics on its own.
      const autoExposureD = isReinhardSlug(slug)
        ? 0
        : this.computeAutoExposureIfHdr(
            this.pickPixelsForRenderer(f32Resp),
        w,
        h,
        f32Resp.dynamic_range ?? 1.0,
        this.pickIsHalfFloat(f32Resp),
      );
      if (renderer.renderer.setAutoExposure) {
        renderer.renderer.setAutoExposure(autoExposureD);
      }

      // Phase 6A removed (refactor): the raw f32 buffer is no longer
      // stashed in a JS-side cache. The Rust `EXR-CACHE-LRU` + `EXR
      // disk cache` are the single source of truth for decoded RGBA
      // data, and an OCIO mode switch simply re-decodes from there.
      // Saves a duplicate copy in JS heap (≈28-56 MB per cached frame)
      // and removes the JS/Rust cache-eviction mismatch that caused
      // intermittent Raw fallback rendering.

      // [EXR-GPU-LUT-DIAG] Sample 5 pixels (q1/center/q3 + brightest
      // pixel) so we can verify the shader's `gl.readPixels` output
      // matches the HDR pixels. Without this log we'd be guessing
      // whether the shader is wrong or the scene is just dark.
      // Phase 6: when on the F16 fast path the pixel buffer is a
      // Uint16Array, so the sample takes a slightly different route
      // (still derives Rec.709 luminance for the brightest-pixel
      // search). The 4 sampled values are decoded to f32 just for
      // the log line.
      //
      // **GATED behind ?debugOcio=1**: this loop scans 3.7M pixels
      // and, on the F16 path, calls the half→float decoder 3× per
      // pixel (twice: once to find the brightest, once to sample the
      // corners). Measured up to ~3000 ms per ACES frame at 1920×1920
      // — completely dominates the encode path. Keep this diagnostic
      // for shader-debugging only; flip it on with `#debugOcio=1`
      // when you suspect an ACES/OCIO colour bug.
      if (this.isOcioTraceEnabled()) {
        const isF16 = this.pickIsHalfFloat(f32Resp);
        const rgbaF32 = f32Resp.rgba_f32;
        const rgbaF16 = f32Resp.rgba_f16;
        const sampleF32 = (i: number, src: Float32Array) => ({
          r: src[i * 4 + 0],
          g: src[i * 4 + 1],
          b: src[i * 4 + 2],
        });
        const sampleF16 = (i: number, src: Uint16Array, scratch: Float32Array) => {
          const buf = new ArrayBuffer(4);
          const fv = new Float32Array(buf);
          const iv = new Uint32Array(buf);
          for (let k = 0; k < 3; k++) {
            const h = src[i * 4 + k];
            const sign = (h & 0x8000) << 16;
            const exp = (h >> 10) & 0x1f;
            const mant = h & 0x3ff;
            if (exp === 0) {
              iv[0] = sign;
            } else if (exp === 0x1f) {
              iv[0] = sign | (0xff << 23) | (mant ? 0x200000 : 0);
            } else {
              iv[0] = sign | (((exp - 15 + 127) & 0xff) << 23) | (mant << 13);
            }
            scratch[k] = fv[0];
          }
          return { r: scratch[0], g: scratch[1], b: scratch[2] };
        };
        const width = w;
        const height = h;
        const idxQ1 = Math.floor(width * 0.25) + Math.floor(height / 2) * width;
        const idxCtr = Math.floor(width / 2) + Math.floor(height / 2) * width;
        const idxQ3 = Math.floor(width * 0.75) + Math.floor(height / 2) * width;
        // Locate brightest pixel by luminance (Rec.709 weights).
        let maxIdx = 0;
        let maxVal = -Infinity;
        if (rgbaF32) {
          for (let i = 0; i < rgbaF32.length; i += 4) {
            const lum = rgbaF32[i] * 0.2126 + rgbaF32[i + 1] * 0.7152 + rgbaF32[i + 2] * 0.0722;
            if (lum > maxVal) { maxVal = lum; maxIdx = i; }
          }
        } else if (rgbaF16) {
          const scratch = new Float32Array(3);
          for (let i = 0; i < rgbaF16.length; i += 4) {
            const s = sampleF16(i, rgbaF16, scratch);
            const lum = s.r * 0.2126 + s.g * 0.7152 + s.b * 0.0722;
            if (lum > maxVal) { maxVal = lum; maxIdx = i; }
          }
        }
        const maxPxRow = Math.floor((maxIdx / 4) / width);
        const maxPxCol = Math.floor((maxIdx / 4) % width);
        const scratchSample = new Float32Array(3);
        const sampleAt = (i: number) =>
          isF16 && rgbaF16
            ? sampleF16(i, rgbaF16, scratchSample)
            : sampleF32(i, rgbaF32!);
        const sBright = sampleAt(maxIdx / 4 | 0);
        dbg.log(
          `[EXR-GPU-LUT] pre-render HDR: ` +
            `q1=(${(sampleAt(idxQ1).r).toFixed(2)},${(sampleAt(idxQ1).g).toFixed(2)},${(sampleAt(idxQ1).b).toFixed(2)}) ` +
            `center=(${(sampleAt(idxCtr).r).toFixed(2)},${(sampleAt(idxCtr).g).toFixed(2)},${(sampleAt(idxCtr).b).toFixed(2)}) ` +
            `q3=(${(sampleAt(idxQ3).r).toFixed(2)},${(sampleAt(idxQ3).g).toFixed(2)},${(sampleAt(idxQ3).b).toFixed(2)}) ` +
            `brightestPx((${maxPxCol},${maxPxRow})L=${maxVal.toFixed(2)})=(${sBright.r.toFixed(2)},${sBright.g.toFixed(2)},${sBright.b.toFixed(2)})`,
        );
      }
      renderer.renderer.loadFrame(
        this.pickPixelsForRenderer(f32Resp),
        w,
        h,
        this.pickIsHalfFloat(f32Resp),
      );
      await renderer.renderer.render();

      let outW = w;
      let outH = h;
      if (maxSize && Math.max(w, h) > maxSize) {
        const scale = maxSize / Math.max(w, h);
        outW = Math.max(1, Math.round(w * scale));
        outH = Math.max(1, Math.round(h * scale));
        const small = document.createElement("canvas");
        small.width = outW;
        small.height = outH;
        const ctx = small.getContext("2d");
        if (ctx) {
          ctx.drawImage(canvas as HTMLCanvasElement | OffscreenCanvas, 0, 0, outW, outH);
          this.offscreenCanvas = small;
        }
      }

      // Phase 6B: ImageBitmap is GPU-backed; the browser owns it and
      // we get fast drawImage() + GPU compositing without re-decoding.
      const offscreen = await this.ensureOffscreenCanvas();
      const bitmap = await createImageBitmap(offscreen);
      const elapsed = performance.now() - tStart;
      dbg.log(`[EXR-GPU] decodeFrameToBitmap OK in ${elapsed.toFixed(1)}ms (${w}x${h}) — Phase 6B`);
      this.lastUsedLegacy = false;
      this.initialized = true;

      // Phase 7-revisit: stash the raw RGBA buffer so LayerCacheManager
      // can hand it to RawLinearCache. Switching OCIO mode after this
      // point no longer has to re-run the Rust FFI decode — we replay
      // the captured buffer through `reRenderWithLut()` instead. The
      // caller MUST drain this via `popCapturedRaw()` before the next
      // decode, otherwise we leak JS heap (≈14-28 MB per frame).
      try {
        const rawBuffer = this.pickPixelsForRenderer(f32Resp);
        this.lastRawCapture = {
          pixels: rawBuffer,
          width: w,
          height: h,
          channels: f32Resp.channels ?? [],
          isHalfFloat: this.pickIsHalfFloat(f32Resp),
          layerName: layerName ?? "",
          maxSize: maxSize ?? 0,
          customFingerprint: customFingerprint ?? "",
        };
        dbg.log(
          `[EXR-GPU] captured raw buffer for re-render: ${w}x${h} f16=${this.lastRawCapture.isHalfFloat}`,
        );
      } catch (capErr) {
        // Capture must NEVER break the success path. Just log and skip.
        console.warn("[EXR-GPU] raw buffer capture failed (non-fatal):", capErr);
        this.lastRawCapture = null;
      }

      return {
        success: true,
        bitmap,
        width: outW,
        height: outH,
        channels: f32Resp.channels ?? [],
        usedLegacyFallback: false,
        error: null,
      };
    } catch (err) {
      console.warn("[EXR-GPU] decodeFrameToBitmap failed, falling back:", err);
      // On failure we don't want a stale capture from a previous successful
      // decode to leak into the next call. Drop it.
      this.lastRawCapture = null;
      return await this.legacyBitmapFallback(filePath, layerName, maxSize);
    }
  }

  /**
   * Phase 9: Batch-decode N EXR files into ImageBitmaps using a
   * SINGLE Rust IPC call. All heavy work happens inside
   * `decode_exr_batch_u8` on the Rust thread pool (rayon +
   * OpenEXR's own 32 worker threads).
   *
   * The per-frame GPU upload + LUT apply + ImageBitmap conversion
   * still happens on the JS side, but we do it sequentially inside
   * this method so we don't have to fight the renderer's single-
   * context model. With a typical 1920×1920 Beauty frame the
   * shader pass is ~10 ms and `createImageBitmap` is ~5 ms — the
   * batch Rust decode is what removes the ~1 s/file IPC bottleneck.
   *
   * Aborts:
   *   - `signal.aborted` short-circuits the Rust call before it runs
   *     and stops iteration between frames.
   *   - Per-frame decode failures (one bad file) don't sink the
   *     batch; they come back as `{ bitmap: null, ... }`.
   */
  async decodeBatchToBitmaps(
    filePaths: string[],
    maxSize?: number,
    layerName?: string,
    signal?: AbortSignal,
  ): Promise<
    Array<{
      success: boolean;
      bitmap: ImageBitmap | null;
      width: number | null;
      height: number | null;
      error: string | null;
    }>
  > {
    if (signal?.aborted) {
      return filePaths.map(() => ({
        success: false,
        bitmap: null,
        width: null,
        height: null,
        error: "aborted",
      }));
    }

    const canvas = await this.ensureOffscreenCanvas();
    const renderer = this.ensureRenderer(canvas);
    if (!renderer) {
      // GPU pipeline unavailable — fall back to per-file single-shot.
      return Promise.all(
        filePaths.map(async (p) => {
          if (signal?.aborted) {
            return { success: false, bitmap: null, width: null, height: null, error: "aborted" };
          }
          const r = await this.decodeFrameToBitmap(p, maxSize, layerName, undefined, signal);
          return {
            success: r.success,
            bitmap: r.bitmap,
            width: r.width,
            height: r.height,
            error: r.error,
          };
        }),
      );
    }

    // Single round-trip to Rust. `decodeExrBatch` returns a
    // `ExrBatchFrame[]` in the same order as `filePaths`, each with
    // either a populated `rgba_u8` / `rgba_f16` / `rgba_f32` buffer
    // or `success: false`.
    let frames;
    try {
      frames = await decodeExrBatch(filePaths, maxSize, layerName);
    } catch (err) {
      console.warn("[EXR-GPU] decodeBatchToBitmaps: Rust batch failed:", err);
      return filePaths.map(() => ({
        success: false,
        bitmap: null,
        width: null,
        height: null,
        error: String(err),
      }));
    }
    if (signal?.aborted) {
      return frames.map(() => ({
        success: false,
        bitmap: null,
        width: null,
        height: null,
        error: "aborted",
      }));
    }

    const results: Array<{
      success: boolean;
      bitmap: ImageBitmap | null;
      width: number | null;
      height: number | null;
      error: string | null;
    }> = new Array(frames.length);

    for (let i = 0; i < frames.length; i++) {
      if (signal?.aborted) {
        results[i] = { success: false, bitmap: null, width: null, height: null, error: "aborted" };
        continue;
      }
      const f = frames[i];
      const resp = f.response;
      if (
        !resp.success ||
        !(resp.rgba_f32 || resp.rgba_f16 || resp.rgba_u8) ||
        !resp.width ||
        !resp.height
      ) {
        results[i] = {
          success: false,
          bitmap: null,
          width: resp.width,
          height: resp.height,
          error: resp.error ?? "no pixels",
        };
        continue;
      }
      try {
        const w = resp.width;
        const h = resp.height;

        // Phase 9B: u8 fast path — bypass the shader entirely and
        // build the ImageBitmap straight from the RGBA8 bytes via
        // `createImageBitmap(ImageData)`. This is the Raw / Linear
        // sRGB passthrough case (Beauty in this app, ~14.7 MB / frame
        // at 1920×1920). Sending each frame through the GPU shader
        // pipeline would require either an f32→f16 expansion on JS
        // (slow) or a renderer overload that doesn't exist, and the
        // output is identical pixel-for-pixel for these modes — the
        // LUT path is what changes colour, and Raw / Linear don't
        // apply a LUT.
        if (resp.rgba_u8 && resp.rgba_u8.length > 0) {
          const u8 = resp.rgba_u8;
          // createImageBitmap wants a tightly-packed RGBA8 ImageData
          // (4 channels, no row padding). Our buffer is exactly that,
          // so we can hand it straight to the constructor.
          const imgData = new ImageData(
            new Uint8ClampedArray(u8.buffer, u8.byteOffset, u8.byteLength),
            w,
            h,
          );
          let bitmap: ImageBitmap;
          try {
            bitmap = await createImageBitmap(imgData);
          } catch (err) {
            // Fallback: paint onto an OffscreenCanvas, then
            // createImageBitmap from that. ~5 ms slower but always works.
            const off = new OffscreenCanvas(w, h);
            const ctx = off.getContext("2d");
            if (!ctx) throw err;
            ctx.putImageData(imgData, 0, 0);
            bitmap = await createImageBitmap(off);
          }
          let outW = w;
          let outH = h;
          if (maxSize && Math.max(w, h) > maxSize) {
            const scale = maxSize / Math.max(w, h);
            outW = Math.max(1, Math.round(w * scale));
            outH = Math.max(1, Math.round(h * scale));
            const small = new OffscreenCanvas(outW, outH);
            const ctx = small.getContext("2d");
            ctx?.drawImage(bitmap, 0, 0, outW, outH);
            bitmap.close();
            bitmap = await createImageBitmap(small);
          }
results[i] = {
          success: true,
          bitmap,
          width: outW,
          height: outH,
          error: null,
        };
        continue;
      }

        // F16 / F32 path: still needs the shader pass (LUT, OETF,
        // etc.). For non-Beauty passes the GPU renderer is required.
        let f32Like: Float32Array | Uint16Array;
        let isHalfFloat = false;
        if (resp.rgba_f16 && resp.rgba_f16.length > 0) {
          f32Like = resp.rgba_f16;
          isHalfFloat = true;
        } else if (resp.rgba_f32) {
          f32Like = resp.rgba_f32;
        } else {
          results[i] = { success: false, bitmap: null, width: w, height: h, error: "no pixels" };
          continue;
        }

        renderer.renderer.resize(w, h);
        renderer.renderer.loadFrame(f32Like, w, h, isHalfFloat);
        await renderer.renderer.render();

        let outW = w;
        let outH = h;
        if (maxSize && Math.max(w, h) > maxSize) {
          const scale = maxSize / Math.max(w, h);
          outW = Math.max(1, Math.round(w * scale));
          outH = Math.max(1, Math.round(h * scale));
          const small = document.createElement("canvas");
          small.width = outW;
          small.height = outH;
          const ctx = small.getContext("2d");
          if (ctx) {
            ctx.drawImage(canvas as HTMLCanvasElement | OffscreenCanvas, 0, 0, outW, outH);
            this.offscreenCanvas = small;
          }
        }
        const offscreen = await this.ensureOffscreenCanvas();
        const bitmap = await createImageBitmap(offscreen);
        results[i] = {
          success: true,
          bitmap,
          width: outW,
          height: outH,
          error: null,
        };
      } catch (err) {
        results[i] = {
          success: false,
          bitmap: null,
          width: resp.width,
          height: resp.height,
          error: String(err),
        };
      }
    }
    return results;
  }

  /** Legacy fallback for decodeFrameToBitmap: run the PNG path and
   *  decode the PNG into an ImageBitmap. Loses some speedup but keeps
   *  correctness. */
  private async legacyBitmapFallback(
    filePath: string,
    layerName?: string,
    maxSize?: number,
  ): Promise<{
    success: boolean;
    bitmap: ImageBitmap | null;
    width: number | null;
    height: number | null;
    channels: string[] | null;
    usedLegacyFallback: boolean;
    error: string | null;
  }> {
    const r = await decodeExr(filePath, maxSize, undefined, layerName ?? undefined);
    if (!r.success || !r.png_base64) {
      return {
        success: false,
        bitmap: null,
        width: r.width,
        height: r.height,
        channels: r.channels,
        usedLegacyFallback: true,
        error: r.error ?? null,
      };
    }
    // Decode the PNG into a bitmap via fetch+createImageBitmap.
    const dataUrl = `data:image/png;base64,${r.png_base64}`;
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    this.lastUsedLegacy = true;
    return {
      success: true,
      bitmap,
      width: r.width,
      height: r.height,
      channels: r.channels,
      usedLegacyFallback: true,
      error: null,
    };
  }

  /** Internal: run legacy Python OCIO decode as a fallback. */
  private async legacyFallback(
    filePath: string,
    layerName?: string,
  ): Promise<{
    success: boolean;
    png_base64: string | null;
    width: number | null;
    height: number | null;
    channels: string[] | null;
    usedLegacyFallback: boolean;
    error: string | null;
  }> {
    this.lastUsedLegacy = true;
    const r = await decodeExr(filePath, 2048, undefined, layerName ?? undefined);
    return {
      success: r.success,
      png_base64: r.png_base64 ?? null,
      width: r.width ?? null,
      height: r.height ?? null,
      channels: r.channels ?? null,
      usedLegacyFallback: true,
      error: r.error ?? null,
    };
  }

  /**
   * Phase 7-revisit (2026-07-05, third arm): warm the JS-side
   * `RawLinearCache` for a list of files by issuing F16 IPC calls.
   *
   * Why this exists:
   *   The Rust U8 batch (`decode_exr_batch_u8`) is used by
   *   `decodeBatchToBitmaps` for fast ImageBitmap cache fills under
   *   passthrough (Raw / Linear sRGB) modes. But the resulting U8
   *   bytes are already clamped to [0,1] — useless for re-rendering
   *   later under a non-passthrough OCIO mode (e.g. ACES), which
   *   needs HDR above 1.0.
   *
   *   The single-frame `decodeFrameToBitmapDirect` already captures
   *   HDR via the dual U8+F16 IPC (see Phase 7-revisit #2). The
   *   batch path needs its own warm-up pass because the batch IPC
   *   only ships U8.
   *
   *   The Rust `EXR-CACHE-LRU` holds the F32 source bytes for ~32
   *   most-recent files (~1.8 GB at 1920×1920), so a follow-up
   *   `decodeExrF16` round-trip is a cheap cache hit (a few ms
   *   inside Rust, ~28 MB IPC each) without disk re-decode.
   *
   * Concurrency: 4 in flight at once (matches the JS-side spawn
   * pattern of `Promise.all(chunk)` used elsewhere in the repo for
   * Rust calls — Rust has 32 worker threads and each F16 decode is
   * purely memory work).
   *
   * Aborts: `signal.aborted` short-circuits at the next chunk
   * boundary. The IPC calls already in flight are still allowed to
   * complete (the Rust side has no cancellation token yet) but their
   * results are discarded if the layer generation has changed.
   */
  async warmRawLinearCache(
    filePaths: string[],
    maxSize: number | undefined,
    layerName: string | undefined,
    customFingerprint: string,
    signal?: AbortSignal,
  ): Promise<{ warmed: number; failed: number }> {
    if (filePaths.length === 0) return { warmed: 0, failed: 0 };
    if (signal?.aborted) return { warmed: 0, failed: 0 };

    let warmed = 0;
    let failed = 0;
    const CONCURRENCY = 4;
    const tStart = performance.now();

    for (let i = 0; i < filePaths.length; i += CONCURRENCY) {
      if (signal?.aborted) break;
      const chunk = filePaths.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map(async (filePath) => {
          if (signal?.aborted) return;
          // Skip frames we already have — `rawLinearCache.has()` is
          // cheap (no LRU bookkeeping, just `Map.has`).
          if (
            rawLinearCache.has(
              layerName ?? "",
              filePath,
              maxSize ?? 0,
              customFingerprint,
            )
          ) {
            return;
          }
          const r = await decodeExrF16(filePath, maxSize, layerName);
          if (signal?.aborted) return;
          if (!r.success || !r.rgba_f16 || r.rgba_f16.length === 0) {
            failed++;
            return;
          }
          rawLinearCache.set({
            pixels: r.rgba_f16,
            width: r.width ?? 0,
            height: r.height ?? 0,
            channels: r.channels ?? [],
            isHalfFloat: true,
            layerName: layerName ?? "",
            framePath: filePath,
            maxSize: maxSize ?? 0,
            customFingerprint,
            decodedAt: Date.now(),
            estimatedBytes: r.rgba_f16.byteLength,
          });
          warmed++;
        }),
      );
      // Promise.allSettled never rejects; we count inside the mapper.
      void settled;
    }
    const elapsed = performance.now() - tStart;
    dbg.log(
      `[EXR-GPU] warmRawLinearCache(${filePaths.length}): warmed=${warmed} failed=${failed} elapsed=${elapsed.toFixed(0)}ms (concurrency=${CONCURRENCY})`,
    );
    return { warmed, failed };
  }

  /**
   * Map the player's selected OCIO mode (human-readable name) to the
   * slug form used by getOcioLut. Returns whatever was last passed to
   * setActiveSlug() (which LayerCacheManager sets per frame from the
   * current OCIO mode). Falls back to Linear sRGB.
   */
  private getCurrentSlug(): OcioModeSlug {
    return this.pendingSlug as OcioModeSlug;
  }

  /**
   * Set the active OCIO slug for the *next* decodeFrameToDataUrl call.
   * Called by LayerCacheManager._loadAndCacheFrame before each frame.
   */
  setActiveSlug(slug: string): void {
    if (this.lutLoadedFor !== slug) {
      this.lutLoadedFor = null; // force reload on next frame
    }
    this.pendingSlug = slug;
  }

  /**
   * Set the user's custom OCIO config. Used when OCIO mode is
   * "Custom OCIO Config". Pass `null` to clear.
   *
   * NOTE: As of the OCIO cleanup (June 2026), the EXR player no longer
   * exposes a "Custom OCIO Config" mode in the UI, so this is a no-op
   * kept around for backwards compatibility with callers that still
   * invoke it.
   */
  setCustomOcioConfig(_cfg: CustomOcioConfig | null): void {
    /* no-op: custom OCIO mode is no longer exposed in the UI */
  }

  /**
   * Returns the custom OCIO config currently in effect, or null.
   * Always null since the UI no longer exposes custom OCIO.
   */
  getCustomOcioConfig(): CustomOcioConfig | null {
    return null;
  }

  /**
   * Resolve the active OCIO mode and return the LUT data + grid size.
   * Throws if the slug is not a known built-in.
   *
   * Phase 6C optimisation: cache the resolve result by slug. The Rust
   * side has its own baked-LUT cache but every IPC call still costs
   * ~1-2 ms of roundtrip + ~0.5 ms of JSON → ArrayBuffer marshalling
   * for the `lut_data` payload. Within a session the user typically
   * toggles between a small handful of OCIO modes — caching on the JS
   * side turns the IPC into a 0-cost Map lookup.
   */
  private lutResolveCache: Map<
    string,
    { data: Float32Array; size: number; inputMax: number; isCustom: boolean }
  > = new Map();

  private async resolveActiveLut(
    slug: string,
  ): Promise<{ data: Float32Array; size: number; inputMax: number; isCustom: boolean }> {
    const cached = this.lutResolveCache.get(slug);
    if (cached) return cached;

    // 2026-07-13: Reinhard tone-mapping is synthesised in JS, no Rust
    // IPC, no pre-baked .bin asset. Synthesising once per slug and
    // stashing in the same cache the Rust-baked LUTs use keeps the
    // rest of the pipeline uniform — `setLut()` doesn't need to know
    // where the bytes came from.
    if (isReinhardSlug(slug)) {
      const { generateReinhardLut, REINHARD_LUT_INPUT_MAX, REINHARD_LUT_VOXEL_SIZE } =
        await import("./reinhardLut");
      const data = generateReinhardLut();
      const result = {
        data,
        size: REINHARD_LUT_VOXEL_SIZE,
        inputMax: REINHARD_LUT_INPUT_MAX,
        isCustom: true,
      };
      this.lutResolveCache.set(slug, result);
      return result;
    }

    // Fast path: built-in modes are pre-baked .bin files shipped in
    // bundle_dist/luts/. We avoid the JSON-marshalling cost of
    // getOcioLut (which returns Vec<f32> over IPC) by asking Rust for
    // the metadata + asset:// URL separately, then fetching the bytes
    // directly. The browser parses the ArrayBuffer into a Float32Array
    // without ever touching JSON — the marshalling cost drops from
    // ~400 MB / mode switch to a few hundred bytes.
    let data: Float32Array | undefined;
    let size = 0;
    let inputMax = 1.0;
    let usedAssetPath = false;
    try {
      const meta = await getOcioLutMetadata(slug);
      if (
        meta.success &&
        meta.lut_size &&
        meta.input_max !== null &&
        meta.file_size_bytes !== null
      ) {
        const url = await getOcioLutAssetUrl(slug);
        const resp = await fetch(url);
        if (!resp.ok) {
          throw new Error(
            `asset fetch returned HTTP ${resp.status} for ${slug}`,
          );
        }
        const buf = await resp.arrayBuffer();
        // Verify the byte count matches what Rust reported; a mismatch
        // means the .bin on disk is from a different LUT_SIZE bake than
        // what the runtime expects (e.g. 33 vs 129), which would
        // silently corrupt shader sampling.
        if (buf.byteLength !== meta.file_size_bytes) {
          throw new Error(
            `LUT byte count mismatch for ${slug}: fetched ${buf.byteLength}, expected ${meta.file_size_bytes}`,
          );
        }
        data = new Float32Array(buf);
        size = meta.lut_size;
        inputMax = meta.input_max;
        usedAssetPath = true;
      }
    } catch (assetErr) {
      dbg.warn(
        `[exrGpuPipeline] asset URL flow failed for ${slug}, falling back to IPC: ${String(assetErr)}`,
      );
    }

    // Slow path: only used when the asset URL flow fails (custom
    // runtime-baked OCIO configs, missing files on disk, or older
    // Tauri builds without `tauri::convert_file_src`). Keeps the
    // legacy behavior intact.
    if (!usedAssetPath || !data) {
      const resp = await getOcioLut(slug);
      if (!resp.success || !resp.lut_data || !resp.lut_size) {
        throw new Error(resp.error ?? `OCIO LUT fetch failed for mode=${slug}`);
      }
      // Built-in LUTs are baked by `gen_luts.py` over [0, 16.29] for ACES
      // modes and [0, 1] for identity (Raw / Linear sRGB); the Rust side
      // reports this in `OcioLutResponse.input_max`.
      const inputMax = resp.input_max ?? 1.0;
      const result = { data: resp.lut_data, size: resp.lut_size, inputMax, isCustom: false };
      this.lutResolveCache.set(slug, result);
      return result;
    }

    const result = { data, size, inputMax, isCustom: false };
    this.lutResolveCache.set(slug, result);
    return result;
  }

  /**
   * Sample the F32/F16 buffer and return an auto-exposure divisor if the
   * frame is HDR, or 0 to disable auto-exposure.
   *
   * Returns 0 when:
   *   - dynamic_range <= HDRI_DYNAMIC_RANGE_THRESHOLD (LDR / render output)
   *   - P99 luminance sample is degenerate
   *
   * For F32 buffers we delegate to `computeAutoExposure` (P99 of Rec.709
   * luminance). For F16 we use a conservative divisor derived from the
   * Rust-side `dynamic_range` to avoid the cost of half-decoding every
   * sample on the JS side.
   */
  private computeAutoExposureIfHdr(
    pixels: Float32Array | Uint16Array,
    width: number,
    height: number,
    dynamicRange: number,
    isHalfFloat: boolean,
  ): number {
    if (dynamicRange <= HDRI_DYNAMIC_RANGE_THRESHOLD) return 0;
    if (isHalfFloat) {
      // F16 path: skip P99 sampling (too costly to half-decode every
      // sample). Use a heuristic divisor from `dynamicRange` instead:
      // P99 ≈ 2^(2 * log10(dr)) capped at 32. Wide-range HDR captures
      // have huge `peak / midtone` ratios but the midtone P99 itself
      // stays in single-digits, so we taper with log10(dr).
      const stops = Math.log10(Math.max(1, dynamicRange));
      const heuristicP99 = Math.min(32, Math.max(1, stops * 2));
      return Math.max(0.001, heuristicP99);
    }
    return this.computeAutoExposure(
      pixels as Float32Array,
      width,
      height,
    );
  }

  /**
   * Compute auto-exposure divisor from P99 luminance.
   *
   * Returns the value the shader should divide each pixel by so that
   * the brightest 1% of pixels end up at ~0.5 in linear space. This is
   * equivalent to setting exposure so that P99 = 0.5.
   *
   * For 4K frames we sample every Nth pixel (stride) to keep this fast.
   * Returns 0 (disabled) if the buffer is empty or all pixels are 0.
   */
  private computeAutoExposure(
    rgbaF32: Float32Array,
    width: number,
    height: number,
  ): number {
    if (!rgbaF32 || rgbaF32.length < 4) return 0;
    const totalPixels = width * height;
    // Sample ~100k pixels (1% of a 4K frame is plenty for P99 accuracy).
    const targetSamples = Math.min(100_000, totalPixels);
    const stride = Math.max(1, Math.floor(totalPixels / targetSamples));

    // Use a simple in-place quickselect would be ideal but JS doesn't
    // have one. Use a sampling approach: collect N samples, sort, take
    // the 99th percentile of luminance.
    const lums: number[] = [];
    for (let i = 0; i < totalPixels; i += stride) {
      const idx = i * 4;
      const r = rgbaF32[idx];
      const g = rgbaF32[idx + 1];
      const b = rgbaF32[idx + 2];
      // Rec. 709 luminance
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (y > 0) lums.push(y);
    }
    if (lums.length === 0) return 0;
    lums.sort((a, b) => a - b);
    const p99 = lums[Math.floor(lums.length * 0.99)];
    // We want P99 to map to ~0.5 in linear → divisor = P99 / 0.5 = 2 * P99
    // If P99 is very small (e.g. 0.01), divisor would be 0.02 → very bright
    // If P99 is large (e.g. 100), divisor = 200 → very dark
    // Cap divisor to avoid extreme cases: min 0.001, max 1000
    if (p99 <= 0) return 0;
    return Math.min(1000, Math.max(0.001, p99 * 2));
  }

  /** Convert a canvas to a PNG base64 string (no `data:` prefix). */
  private async canvasToBase64(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
    // Use OffscreenCanvas.convertToBlob → FileReader → btoa for fast PNG→base64.
    // The manual String.fromCharCode loop over a 14.7 MB buffer was costing
    // ~4 s per frame (14.7 M iterations of string concat). FileReader avoids
    // that by letting the browser's native base64 engine handle the conversion.
    const blob = await new Promise<Blob>((resolve, reject) => {
      if ("convertToBlob" in canvas && typeof canvas.convertToBlob === "function") {
        (canvas as OffscreenCanvas).convertToBlob({ type: "image/png" }).then(resolve).catch(reject);
      } else {
        (canvas as HTMLCanvasElement).toBlob(blob => blob ? resolve(blob) : reject(new Error("canvas.toBlob returned null")), "image/png");
      }
    });
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // reader.result is "data:image/png;base64,..." — strip the prefix.
        const dataUrl = reader.result as string;
        resolve(dataUrl.replace(/^data:image\/png;base64,/, ""));
      };
      reader.onerror = () => reject(new Error("FileReader failed"));
      reader.readAsDataURL(blob);
    });
  }

  // ===========================================================================
  // 2026-07-04: Raw / Linear-sRGB fast path -- pure FFI → ImageBitmap.
  //
  // Goal: completely bypass the GPU shader pipeline for the two
  // passthrough OCIO modes. Matches V1.0.1 behaviour:
  //
  //   * No 3D LUT lookup (no GPU texImage3D upload).
  //   * No sRGB OETF / gamma encoding (raw linear pixel values).
  //   * No tone-mapping, no ACES, no IDT.
  //
  // Only the Rust `decodeExrF32` call is used: it returns
  // scene-linear RGBA floats which we clamp to [0, 1], scale to
  // 8-bit, and turn into an ImageBitmap directly via `ImageData`.
  //
  // The raw f32 buffer is owned by the Rust `EXR-CACHE-LRU` + disk
  // cache. A later OCIO switch re-decodes from there (no JS-side
  // mirror after the cache-layer refactor).
  // ===========================================================================
  async decodeFrameToBitmapDirect(
    filePath: string,
    maxSize?: number,
    layerName?: string,
    customFingerprint?: string,
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    bitmap: ImageBitmap | null;
    width: number | null;
    height: number | null;
    channels: string[] | null;
    usedLegacyFallback: boolean;
    error: string | null;
  }> {
    if (signal?.aborted) {
      return {
        success: false,
        bitmap: null,
        width: null,
        height: null,
        channels: null,
        usedLegacyFallback: false,
        error: "aborted",
      };
    }
    const tStart = performance.now();
    try {
      // Phase 7: Use the U8 IPC fast path. Rust clamps the linear HDR
      // buffer to [0, 1] and emits RGBA8 bytes — wire payload is
      // 14.7 MB for 1920×1920 instead of 28.8 MB (F16) or 57.6 MB
      // (F32), and the response skips both the half→float expansion
      // and the F32→U8 clamp loop on the JS side.
      //
      // We still go through `decodeForBeauty` for the cache lookup
      // (the F16 path was picked there because of its lower IPC cost
      // vs F32), but instead of letting the F16 result escape to JS we
      // ask Rust for the U8 variant and accept that as the final
      // pixel format. Cache hits that land on U8 give us the same
      // speed win at ~50% the IPC bytes — Rust still has to walk the
      // f32 buffer once to clamp it, but that walk is ~10x faster
      // than the JS-side equivalent.
      const f32Resp = await this.decodeForBeauty(filePath, maxSize, layerName, signal, true);
      if (signal?.aborted || !f32Resp.success) {
        return {
          success: !!f32Resp.success && !signal?.aborted,
          bitmap: null,
          width: f32Resp.width,
          height: f32Resp.height,
          channels: f32Resp.channels ?? null,
          usedLegacyFallback: false,
          error: signal?.aborted ? "aborted" : f32Resp.error ?? "decode failed",
        };
      }
      dbg.log(
        `[EXR-GPU] decodeFrameToBitmapDirect: FFI ${(performance.now() - tStart).toFixed(0)}ms (${f32Resp.width}x${f32Resp.height})`,
      );
      const w = f32Resp.width;
      const h = f32Resp.height;
      const f16 = f32Resp.rgba_f16;
      const f32 = f32Resp.rgba_f32;
      const u8 = f32Resp.rgba_u8;
      if (!w || !h || (!f32 && !f16 && !u8)) {
        return {
          success: false,
          bitmap: null,
          width: w,
          height: h,
          channels: f32Resp.channels ?? null,
          usedLegacyFallback: false,
          error: f32Resp.error ?? "decodeExr returned no pixels",
        };
      }
      const channels = f32Resp.channels ?? [];

      // Phase 7 GPU path: upload then read. We pick the cheapest
      // available source buffer:
      //   1. `rgba_u8` (preferred) — direct U8 texture, no shader.
      //   2. `rgba_f16` — half-float texture + passthrough shader.
      //   3. `rgba_f32` (legacy fallback) — GPU passthrough shader
      //      with U8 framebuffer; the 8-bit clamp happens in the
      //      write-only `gl_FragColor` write.
      const renderer = this.ensurePassthroughRenderer();
      if (!renderer) {
        return this.cpuFallbackForPassthrough(
          f32Resp, w, h, channels, filePath, maxSize, layerName, signal, tStart,
        );
      }

      // Auto-exposure (HDRI gate): enable u_autoExposure when the source is
      // HDR. Without this the passthrough shader would clamp every pixel
      // > 1.0 to 255 in the RGBA8 framebuffer, blowing out the brightest
      // areas of HDRI files to solid white.
      //
      // For HDRI files we MUST use the F16 path (the U8 buffer is already
      // clamped to [0,1] by Rust and has lost all highlight detail), and
      // we MUST go through the ACES shader (the passthrough shader copies
      // HDR pixels straight into an RGBA8 framebuffer, which is what
      // caused the original white-out). Falling through to the ACES
      // shader gives us tone-mapping + sRGB encoding with the P99
      // divisor applied to every pixel first.
      const dynamicRange = f32Resp.dynamic_range ?? 1.0;
      const isHdri = dynamicRange > HDRI_DYNAMIC_RANGE_THRESHOLD;
      const isHalfFloat = !!f16 && !f32;

      // Pick P99 divisor for the F16 / F32 path. U8 path always returns
      // 0 because the input is already [0,1] clamped (any divisor would
      // darken it without recovering detail).
      let autoExposureDir = 0;
      if (isHdri) {
        if (f16) {
          autoExposureDir = this.computeAutoExposureIfHdr(
            f16 as Uint16Array,
            w,
            h,
            dynamicRange,
            true,
          );
        } else if (f32) {
          autoExposureDir = this.computeAutoExposureIfHdr(
            f32 as Float32Array,
            w,
            h,
            dynamicRange,
            false,
          );
        }
      }
      renderer.setAutoExposure(autoExposureDir);
      dbg.log(
        `[EXR-GPU] decodeFrameToBitmapDirect autoExposure: dynamic_range=${dynamicRange.toFixed(2)} divisor=${autoExposureDir.toFixed(4)} sourceFormat=${u8 ? "u8" : (f16 ? "f16" : "f32")} aces=${isHdri && !!f16}`,
      );

      let bitmap: ImageBitmap;
      let sourceFormat: "u8" | "f16" | "f32";
      // Raw OCIO mode: passthrough shader only. HDR pixels > 1.0 clamp
      // to 255 in the RGBA8 framebuffer (intentional "Raw" behaviour).
      // ACES-mode frames go through the separate `decodeFrameToBitmap`
      // path which applies the LUT / shader.
      //
      // 2026-07-13-fix: HDR content (dynamic_range > 1.0) MUST use ACES
      // shader even in Raw mode because passthrough doesn't tone-map and
      // pixels > 1.0 clamp to 0 = black screen.
      const useHdriAces = isHdri;
      // Bug fix 2026-07-13: when ACES is in use we MUST feed the
      // RGBA16F source texture (texSrc16); sampling U8 through the
      // ACES shader destroys HDR highlights because the U8 buffer has
      // already been clamped to [0,1] by Rust. If only U8 is available
      // we upload it to texSrc8, but then have to force passthrough
      // rendering (the alternative is sampling stale texSrc16 from the
      // previous frame — which is exactly the bug that made every layer
      // look like Beauty before this fix).
      const f16Usable = !!f16 && !f32;
      if (useHdriAces && f16Usable) {
        renderer.uploadF16(f16 as Uint16Array, w, h);
        sourceFormat = "f16";
      } else if (u8) {
        renderer.uploadU8(u8, w, h);
        sourceFormat = "u8";
      } else if (f16) {
        renderer.uploadF16(f16 as Uint16Array, w, h);
        sourceFormat = "f16";
      } else {
        // F32-only response — couldn't get a U8 or F16 path from Rust
        // for this frame. Skip the GPU path (which only supports
        // RGBA8 / RGBA16F source) and fall through to the CPU clamp
        // fallback below.
        return this.cpuFallbackForPassthrough(
          f32Resp, w, h, channels, filePath, maxSize, layerName, signal, tStart,
        );
      }
      bitmap = await renderer.render(useHdriAces /* useAces */, 1.0 /* exposure */);

      if (signal?.aborted) {
        try { bitmap.close(); } catch {}
        return {
          success: false,
          bitmap: null,
          width: null,
          height: null,
          channels: null,
          usedLegacyFallback: false,
          error: "aborted",
        };
      }

      const elapsed = performance.now() - tStart;
      dbg.log(
        `[EXR-GPU] decodeFrameToBitmapDirect OK in ${elapsed.toFixed(1)}ms (${w}x${h}) -- GPU passthrough [Phase 7 ${sourceFormat}]`,
      );

      // lastPassType mirrors Rust's pass_type so downstream features
      // (timeline labelling, debug logs) know what the backend
      // classified the frame as. Falls back to "rgb" when Rust
      // didn't report one.
      const rustPassType = (f32Resp as { pass_type?: string }).pass_type;
      this.lastPassType = rustPassType ?? "rgb";

      // Phase 7-revisit (2026-07-05): capture the raw HDR buffer so an
      // OCIO switch out of passthrough (e.g. Raw → ACES) can re-render
      // without an FFI re-decode.
      //
      // The passthrough path now requests U8 + F16 in parallel
      // (Phase 7-revisit `decodeForBeauty` merge) so we have HDR data
      // available here even though the bitmap itself came from U8.
      // We must NOT capture U8 because U8 is already clamped to
      // [0,1] — feeding it into the ACES LUT shader would discard
      // highlights above 1.0 and render wrong colours.
      try {
        const rawBuf = f32 ?? f16;
        if (rawBuf) {
          this.lastRawCapture = {
            pixels: rawBuf as Uint16Array | Float32Array,
            width: w,
            height: h,
            channels,
            isHalfFloat: !!f16 && !f32,
            layerName: layerName ?? "",
            maxSize: maxSize ?? 0,
            customFingerprint: customFingerprint ?? "",
          };
          dbg.log(
            `[EXR-GPU] direct path captured HDR raw buffer for re-render: ${w}x${h} f16=${this.lastRawCapture.isHalfFloat} source=${f32 ? "f32" : "f16"}`,
          );
        } else if (u8) {
          // Both F16 and F32 unavailable — likely the dual U8+F16
          // IPC call returned only U8 (F16 fallback failed). The
          // next OCIO switch will fall back to a full FFI re-decode.
          console.warn(
            `[EXR-GPU] direct path: HDR capture unavailable (F16+F32 both null, U8-only). Next OCIO switch will full-FFI re-decode.`,
          );
          this.lastRawCapture = null;
        }
      } catch (capErr) {
        console.warn("[EXR-GPU] direct path raw capture failed (non-fatal):", capErr);
        this.lastRawCapture = null;
      }

      return {
        success: true,
        bitmap,
        width: w,
        height: h,
        channels,
        usedLegacyFallback: false,
        error: null,
      };
    } catch (err) {
      console.warn("[EXR-GPU] decodeFrameToBitmapDirect failed:", err);
      this.lastRawCapture = null;
      return {
        success: false,
        bitmap: null,
        width: null,
        height: null,
        channels: null,
        usedLegacyFallback: false,
        error: String(err),
      };
    }
  }

  /**
   * Lazy-init the Phase 7 GPU renderer. Falls back to null on
   * WebGL2 init failure so the CPU fallback path can take over.
   */
  private ensurePassthroughRenderer(): ExrGpuPassthroughRenderer | null {
    if (this.passthroughRenderer) return this.passthroughRenderer;
    try {
      this.passthroughRenderer = new ExrGpuPassthroughRenderer({
        log: (line) => dbg.log(line),
      });
    } catch (err) {
      console.warn("[EXR-GPU] ExrGpuPassthroughRenderer init failed, will use CPU fallback:", err);
      this.passthroughRenderer = null;
    }
    return this.passthroughRenderer;
  }

  /**
   * Pure-CPU fallback for the passthrough path. Used when WebGL2 is
   * unavailable (very rare on Win11 / Edge WebView2, but possible on
   * machines with disabled GPU acceleration). Mirrors the pre-Phase-7
   * behaviour: half→float + clamp loop on the JS side, then
   * `createImageBitmap` of the resulting `ImageData`. Tracked here
   * so we don't drop off the cliffs if the GPU init throws.
   */
  private async cpuFallbackForPassthrough(
    f32Resp: ExrF32Response,
    w: number,
    h: number,
    channels: string[],
    _filePath: string,
    _maxSize?: number,
    _layerName?: string,
    signal?: AbortSignal,
    tStart: number = performance.now(),
  ): Promise<{
    success: boolean;
    bitmap: ImageBitmap | null;
    width: number | null;
    height: number | null;
    channels: string[] | null;
    usedLegacyFallback: boolean;
    error: string | null;
  }> {
    const f32ForU8: Float32Array =
      f32Resp.rgba_f32 ??
      (f32Resp.rgba_f16
        ? halfFloatArrayToFloat32(f32Resp.rgba_f16)
        : new Float32Array(0));
    const u8 = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < f32ForU8.length; i += 4, j += 4) {
      let r = f32ForU8[i + 0] * 255;
      let g = f32ForU8[i + 1] * 255;
      let b = f32ForU8[i + 2] * 255;
      // 2026-07-05 alpha hotfix: read the alpha channel from the
      // rgba_f32 buffer (now correctly populated by Rust) instead of
      // hard-coding 255. Files without an A channel still get 1.0 from
      // the Rust fallback, so the clamp below produces 255 anyway.
      let a = f32ForU8[i + 3] * 255;
      if (r < 0) r = 0; else if (r > 255) r = 255;
      if (g < 0) g = 0; else if (g > 255) g = 255;
      if (b < 0) b = 0; else if (b > 255) b = 255;
      if (a < 0) a = 0; else if (a > 255) a = 255;
      u8[j + 0] = r | 0;
      u8[j + 1] = g | 0;
      u8[j + 2] = b | 0;
      u8[j + 3] = a | 0;
    }
    if (signal?.aborted) {
      return {
        success: false,
        bitmap: null,
        width: null,
        height: null,
        channels: null,
        usedLegacyFallback: false,
        error: "aborted",
      };
    }
    const imageData = new ImageData(u8, w, h);
    const bitmap = await createImageBitmap(imageData);
    const elapsed = performance.now() - tStart;
    dbg.log(
      `[EXR-GPU] decodeFrameToBitmapDirect OK in ${elapsed.toFixed(1)}ms (${w}x${h}) -- CPU fallback`,
    );
    return {
      success: true,
      bitmap,
      width: w,
      height: h,
      channels,
      usedLegacyFallback: false,
      error: null,
    };
  }

  /**
   * 2026-07-05: Passthrough HIT-path helper — turn a raw linear
   * pixel buffer (already sitting in `RawLinearCache` from a previous
   * ACES-mode render) into an `ImageBitmap` WITHOUT re-decoding from
   * disk and WITHOUT going through the GPU shader pipeline.
   *
   * Why a separate helper:
   *   * `decodeFrameToBitmapDirect(filePath, ...)` is the public FFI
   *     entry point — it always calls Rust `decodeExrF32` (~3-5 s for
   *     a 1920x1920 frame on cold disk). The cache hit happens AFTER
   *     Rust returns, so it doesn't help when the buffer is already
   *     in `RawLinearCache`.
   *   * `reRenderWithLut(...)` is the GPU shader entry point — it
   *     uploads the F16 buffer, runs the passthrough fragment shader
   *     (linear clamp + write to U8 framebuffer), then reads back.
   *     Pixel-identical to this helper but ~880 ms on a 1920x1920
   *     frame vs ~30-50 ms for the CPU clamp.
   *
   * This helper extracts the clamp loop from `cpuFallbackForPassthrough`
   * and accepts a raw F16/F32 buffer directly. Pixel output is
   * identical to both `decodeFrameToBitmapDirect` and the GPU
   * passthrough shader (linear clamp to [0..255], alpha = 255, no
   * OETF, no LUT). Used by the HIT-path branch in `LayerCacheManager`
   * when the user picks "Raw" / "Linear sRGB" after ACES had already
   * warmed the raw cache.
   *
   * Pixel layout matches `RawLinearEntry`:
   *   - F16: Uint16Array, half-precision bits in IEEE 754 binary16
   *   - F32: Float32Array, IEEE 754 binary32
   *   - RGBA interleaved, 4 channels per pixel, no row padding
   *
   * Aborts: signal aborts mid-clamp return failure with `error: "aborted"`.
   * Channels: returned as-is from the entry; typically `["R","G","B"]`
   * or `["R","G","B","A"]`.
   */
  async decodeRawLinearToBitmapDirect(
    pixels: Uint16Array | Float32Array,
    width: number,
    height: number,
    isHalfFloat: boolean,
    channels: string[],
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    bitmap: ImageBitmap | null;
    width: number | null;
    height: number | null;
    channels: string[] | null;
    usedLegacyFallback: boolean;
    error: string | null;
  }> {
    const tStart = performance.now();
    if (!width || !height || !pixels || pixels.length < width * height * 4) {
      return {
        success: false,
        bitmap: null,
        width: width || null,
        height: height || null,
        channels,
        usedLegacyFallback: false,
        error: "invalid raw buffer (size mismatch)",
      };
    }

    const f32 = isHalfFloat
      ? halfFloatArrayToFloat32(pixels as Uint16Array)
      : (pixels as Float32Array);
    const total = width * height * 4;
    const u8 = new Uint8ClampedArray(width * height * 4);
    // Inline clamp loop: max(0, min(255, x * 255)) for R/G/B, alpha
    // read from the rgba_f32 buffer (now correctly populated by Rust
    // since the 2026-07-05 alpha hotfix). Matches the GPU passthrough
    // shader byte-for-byte for R/G/B.
    for (let i = 0; i < total; i += 4) {
      let r = f32[i + 0] * 255;
      let g = f32[i + 1] * 255;
      let b = f32[i + 2] * 255;
      let a = f32[i + 3] * 255;
      if (r < 0) r = 0; else if (r > 255) r = 255;
      if (g < 0) g = 0; else if (g > 255) g = 255;
      if (b < 0) b = 0; else if (b > 255) b = 255;
      if (a < 0) a = 0; else if (a > 255) a = 255;
      u8[i + 0] = r | 0;
      u8[i + 1] = g | 0;
      u8[i + 2] = b | 0;
      u8[i + 3] = a | 0;
    }

    if (signal?.aborted) {
      return {
        success: false,
        bitmap: null,
        width: null,
        height: null,
        channels: null,
        usedLegacyFallback: false,
        error: "aborted",
      };
    }

    const imageData = new ImageData(u8, width, height);
    const bitmap = await createImageBitmap(imageData);
    const elapsed = performance.now() - tStart;
    dbg.log(
      `[EXR-GPU] decodeRawLinearToBitmapDirect OK in ${elapsed.toFixed(1)}ms (${width}x${height}) — RawLinearCache HIT (${isHalfFloat ? "F16" : "F32"})`,
    );
    return {
      success: true,
      bitmap,
      width,
      height,
      channels,
      usedLegacyFallback: false,
      error: null,
    };
  }

  dispose(): void {
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.lutLoadedFor = null;
    this.initialized = false;
  }

  // ===========================================================================
  // Phase 7-revisit (2026-07-05): OCIO switch re-render from raw pixel buffer.
  //
  // Without this path, switching from e.g. "Raw" → "ACES_1_3_CG" triggers a
  // full Rust FFI re-decode (138-800ms) PLUS the GPU upload + LUT shader
  // pass (3.5-6s for a 1920×1920 frame), totalling 4-7s per frame. By
  // stashing the raw RGBA buffer the first time a frame is decoded, the
  // second (and subsequent) OCIO modes only pay for the GPU shader pass
  // and `createImageBitmap` — typically 30-80ms for the same frame.
  // ===========================================================================

  /**
   * Drain the raw pixel buffer stashed by the most recent successful
   * `decodeFrameToBitmap` call. Returns null if no capture is pending
   * (caller is responsible for handling the "no capture" case by falling
   * back to a full re-decode).
   *
   * After this call, `lastRawCapture` is reset so the next decode will
   * overwrite it. The buffer ownership is TRANSFERRED to the caller —
   * do NOT mutate it from pipeline side after this point.
   */
  popCapturedRaw(): {
    pixels: Uint16Array | Float32Array;
    width: number;
    height: number;
    channels: string[];
    isHalfFloat: boolean;
    layerName: string;
    maxSize: number;
    customFingerprint: string;
  } | null {
    const cap = this.lastRawCapture;
    this.lastRawCapture = null;
    return cap;
  }

  /**
   * Peek at the raw pixel buffer without consuming it. Used for diagnostics.
   */
  peekCapturedRaw(): boolean {
    return this.lastRawCapture !== null;
  }

  /**
   * Re-render a previously-decoded frame through the GPU OCIO LUT stack
   * using a STASHED raw pixel buffer instead of calling the Rust FFI
   * decoder. Used by LayerCacheManager when it has a RawLinearCache hit
   * for the requested (layer, frame, fingerprint, maxSize) tuple.
   *
   * The caller is responsible for:
   *   - confirming `ocioSlug` is valid (must match `getCurrentSlug()`)
   *   - calling `setActiveSlug(slug)` BEFORE invoking this method
   *     (otherwise the GPU pipeline will still be configured for the
   *     previous OCIO mode)
   *   - handling the result correctly: `success=false` means the
   *     re-render failed and the caller should fall back to a full
   *     re-decode
   *
   * Pipeline-side responsibilities:
   *   - upload the raw buffer to the GPU
   *   - apply the LUT for `ocioSlug`
   *   - read back the result into an ImageBitmap
   *
   * Crucially, this method does NOT touch the Rust cache. The capture
   * came from an earlier `decodeFrameToBitmap` call — the Rust side
   * is free to evict its own copy at any time.
   */
  async reRenderWithLut(
    pixels: Uint16Array | Float32Array,
    width: number,
    height: number,
    isHalfFloat: boolean,
    channels: string[],
    layerName: string,
    maxSize: number,
    customFingerprint: string,
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    bitmap: ImageBitmap | null;
    width: number | null;
    height: number | null;
    channels: string[] | null;
    usedLegacyFallback: boolean;
    error: string | null;
  }> {
    if (signal?.aborted) {
      return {
        success: false,
        bitmap: null,
        width: null,
        height: null,
        channels: null,
        usedLegacyFallback: false,
        error: "aborted",
      };
    }
    const tStart = performance.now();
    const canvas = await this.ensureOffscreenCanvas();
    try {
      const renderer = this.ensureRenderer(canvas);
      if (!renderer) {
        return {
          success: false,
          bitmap: null,
          width: null,
          height: null,
          channels: null,
          usedLegacyFallback: true,
          error: "GPU renderer unavailable for re-render",
        };
      }

      const slug = this.getCurrentSlug();
      const isRawLinearSlug =
        slug === OCIO_MODE_SLUGS.LINEAR_SRGB || slug === OCIO_MODE_SLUGS.RAW;
      dbg.log(
        `[EXR-GPU-LUT] reRenderWithLut BEGIN: slug="${slug}" size=${width}x${height} ` +
          `isHalfFloat=${isHalfFloat} layer="${layerName ?? ""}"`,
      );

      // Step 1: resolve LUT for the active slug and upload to the shader if it
      // differs from what was previously loaded.
      const resolved = await this.resolveActiveLut(slug);
      if (signal?.aborted) {
        return {
          success: false,
          bitmap: null,
          width: null,
          height: null,
          channels: null,
          usedLegacyFallback: false,
          error: "aborted",
        };
      }
      if (this.lutLoadedFor !== slug) {
        renderer.renderer.setLut(resolved.data, resolved.size);
        if (renderer.renderer.setLutInputMax) {
          renderer.renderer.setLutInputMax(resolved.inputMax);
        }
        this.lutLoadedFor = slug;
      }

      // Step 2: configure shader uniforms. Mirrors decodeFrameToBitmap's logic.
      const isRawLinear = isRawLinearSlug;
      const isAcesMode = resolved.inputMax > 1.0 && !isReinhardSlug(slug);
      renderer.renderer.setLinearPassthrough(isRawLinear);
      renderer.renderer.setInlineAces(false);
      renderer.renderer.setLutBakedSrgbOetf(true);
      const drHint = 1.0; // assume SDR-ish signal for re-render; the LUT handles HDR via inputMax
      const hdrSignal = drHint > OCIO_HDR_LUT_MAX_FACTOR;
      const useInlineAcesForHdr = isAcesMode && hdrSignal && !isReinhardSlug(slug);
      if (useInlineAcesForHdr) {
        renderer.renderer.setInlineAces(true);
        renderer.renderer.setLutBakedSrgbOetf(false);
      }

      // Step 3: pass type detection (pure function — cheap).
      const fileNameGuess = layerName ?? "";
      const detected = detectPassType(layerName ?? "", channels, fileNameGuess, undefined);
      renderer.renderer.setPassMode(detected.passType as unknown as 0);

      // Same `bypassOcio` switch as the other decode paths: non-colour
      // passes skip the LUT; colour-managed passes keep it active.
      if (detected.bypassOcio) {
        if (renderer.renderer.setBypassOcio) {
          renderer.renderer.setBypassOcio(true);
        }
      } else {
        if (renderer.renderer.setBypassOcio) {
          renderer.renderer.setBypassOcio(false);
        }
      }

      // Step 4: resize, upload, render.
      renderer.renderer.resize(width, height);
      // The renderer takes a Uint16Array | Float32Array. We constructed
      // the raw buffer ourselves in pickPixelsForRenderer, so the type
      // matches.
      renderer.renderer.loadFrame(pixels, width, height, isHalfFloat);
      await renderer.renderer.render();

      // Step 5: optional downscale.
      let outW = width;
      let outH = height;
      if (maxSize && Math.max(width, height) > maxSize) {
        const scale = maxSize / Math.max(width, height);
        outW = Math.max(1, Math.round(width * scale));
        outH = Math.max(1, Math.round(height * scale));
        const small = document.createElement("canvas");
        small.width = outW;
        small.height = outH;
        const ctx = small.getContext("2d");
        if (ctx) {
          ctx.drawImage(canvas as HTMLCanvasElement | OffscreenCanvas, 0, 0, outW, outH);
          this.offscreenCanvas = small;
        }
      }

      const offscreen = await this.ensureOffscreenCanvas();
      const bitmap = await createImageBitmap(offscreen);
      const elapsed = performance.now() - tStart;
      dbg.log(
        `[EXR-GPU-LUT] reRenderWithLut OK in ${elapsed.toFixed(1)}ms (${width}x${height}) — Phase 7-revisit`,
      );
      this.lastUsedLegacy = false;
      this.initialized = true;
      // Refresh the capture so a second re-render (e.g. switch again) can
      // also hit the fast path without waiting on the FFI decode.
      this.lastRawCapture = {
        pixels,
        width,
        height,
        channels,
        isHalfFloat,
        layerName: layerName ?? "",
        maxSize: maxSize ?? 0,
        customFingerprint: customFingerprint ?? "",
      };
      return {
        success: true,
        bitmap,
        width: outW,
        height: outH,
        channels,
        usedLegacyFallback: false,
        error: null,
      };
    } catch (err) {
      console.warn("[EXR-GPU-LUT] reRenderWithLut failed:", err);
      return {
        success: false,
        bitmap: null,
        width: null,
        height: null,
        channels: null,
        usedLegacyFallback: false,
        error: String(err),
      };
    }
  }
}