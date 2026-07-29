/**
 * EXRCpuLutRenderer — CPU-side OCIO LUT lookup fallback.
 *
 * Used when WebGL2 / EXT_color_buffer_float isn't available. Single-thread
 * JS implementation; a parallel Web Worker variant lives in lutWorker.ts.
 *
 * Trade-off vs GPU: ~50-100x slower per pixel, but it always works and
 * keeps the rest of the pipeline identical (still upload via the Rust
 * Float32Array path, still use the same LUT format).
 */

export interface CpuLutRendererInit {
  canvas: HTMLCanvasElement | OffscreenCanvas;
}

export class EXRCpuLutRenderer {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private lut: Float32Array | null = null;
  private lutSize = 0;

  /** Frame scratch — RGBA u8 pixels for ImageData. */
  private rgbaBuf: Uint8ClampedArray | null = null;
  private currentWidth = 0;
  private currentHeight = 0;

  private exposure = 1.0;
  private invGamma = 1 / 2.2;
  private linearPassthrough = false;
  /** When true, the active LUT already encodes sRGB OETF (e.g. ACES CG
   *  LUTs baked as linearToSRGB(acesFilm(...))). Skip the extra
   *  pow(c, invGamma) pass to avoid double-encoding gamma. */
  private lutIncludesSrgbOetf = false;
  /** Scene-linear input domain the active LUT was baked over (mirrors
   * the Rust constant `exr_ocio_lut::LUT_INPUT_MAX` and the Python
   * `gen_luts.LUT_INPUT_MAX` / `bake_ocio_lut.LUT_INPUT_MAX`). The CPU
   * renderer divides per-pixel linear values by this constant before
   * indexing so the LUT covers the ACES RRT scene-referred range.
   * Identity LUTs (Raw / Linear sRGB) keep this at 1.0. */
  private lutInputMax = 1.0;

  constructor(init: CpuLutRendererInit) {
    this.canvas = init.canvas;
    const ctx = init.canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) throw new Error("Canvas 2D not available");
    this.ctx = ctx;
  }

  setLut(lutData: Float32Array, size: number): void {
    if (lutData.length !== size * size * size * 3) {
      throw new Error(
        `LUT length mismatch: got ${lutData.length}, expected ${size ** 3 * 3}`,
      );
    }
    this.lut = lutData;
    this.lutSize = size;
  }

  /**
 * Phase 6: Accept either Float32Array (legacy path) or Uint16Array of
 * raw half-precision bits. The CPU LUT path needs Float32Array internally
 * because `applyLutAndToneMap` operates on scene-linear f32 values; if a
 * Uint16Array is supplied we expand inline (slow path). On machines that
 * actually take the CPU fallback (no WebGL2), the F16 fast path from
 * Phase 6 buys us nothing — the bottleneck is the per-pixel LUT loop,
 * not the F16→F32 conversion — so this is a correct but unoptimised
 * fallback.
 */
  loadFrame(
    pixels: Float32Array | Uint16Array,
    width: number,
    height: number,
    isHalfFloat: boolean = false,
  ): void {
    let rgbaF32: Float32Array;
    if (isHalfFloat && pixels instanceof Uint16Array) {
      // Expand half → float inline. Reuses the same algorithm as the
      // legacy F16 path in TauriFileSystem, duplicated here to avoid
      // an import cycle. For CPU renderer this is acceptable cost —
      // the LUT loop dominates anyway.
      rgbaF32 = halfFloatArrayToFloat32(pixels);
    } else {
      rgbaF32 = pixels as Float32Array;
    }
    if (!this.lut) throw new Error("loadFrame before setLut");
    if (
      this.currentWidth !== width ||
      this.currentHeight !== height ||
      !this.rgbaBuf
    ) {
      this.rgbaBuf = new Uint8ClampedArray(width * height * 4);
      this.currentWidth = width;
      this.currentHeight = height;
    }
    this.applyLutAndToneMap(rgbaF32, this.lut, this.lutSize);
  }

  setExposure(stops: number): void {
    this.exposure = Math.max(0.001, stops);
  }

  setGamma(gamma: number): void {
    this.invGamma = 1 / Math.max(0.1, gamma);
  }

  /** CPU renderer doesn't have per-frame auto-exposure; it's a no-op. */
  setAutoExposure(_divisor: number): void {
    // CPU path auto-exposure could be added here, but typically the
    // GPU path handles it. Left intentionally empty.
  }

  /** CPU renderer ignores the BGR swap hint. */
  setNeedsBgrSwap(_swap: boolean): void {}

  /** CPU renderer doesn't honour bypass-Ocio (no LUT path in current JS port). */
  setBypassOcio(_bypass: boolean): void {}

  /** CPU renderer doesn't honour pass-mode (raw-clamp is always the only path). */
  setPassMode(_mode: 0 | 1 | 2 | 3 | 4): void {}

  /** Skip LUT + gamma when the OCIO mode is "Linear sRGB". */
  setLinearPassthrough(use: boolean): void {
    this.linearPassthrough = use;
  }

  /**
   * Inform the CPU renderer that the active LUT already encodes sRGB OETF
   * (e.g. the Rust-baked ACES Narkowicz + linearToSRGB LUT). When true,
   * the gamma encode pass at the end of the LUT branch is skipped to
   * avoid double-encoding.
   */
  setLutBakedSrgbOetf(baked: boolean): void {
    this.lutIncludesSrgbOetf = baked;
  }

  /** Inform the CPU renderer what scene-linear input domain the active
   * LUT was baked over (e.g. 16.29 for ACES RRT peak white). The CPU
   * renderer divides per-pixel linear values by this constant before
   * indexing. Defaults to 1.0 for identity LUTs. */
  setLutInputMax(maxIn: number): void {
    this.lutInputMax = Math.max(0.001, maxIn);
  }

  private applyLutAndToneMap(rgbaF32: Float32Array, lut: Float32Array, n: number): void {
    const scale = n - 1;
    const exposure = this.exposure;
    const invGamma = this.invGamma;
    const out = this.rgbaBuf!;
    const linearPassthrough = this.linearPassthrough;
    const lutIncludesSrgbOetf = this.lutIncludesSrgbOetf;
    // Scene-linear input domain the LUT was baked over. Identity LUTs
    // (Raw / Linear sRGB) keep `lutInputMax = 1` so the divide is a
    // no-op; ACES configs use 16.29 so highlights map to the proper
    // tone-curve endpoint instead of clamping at the top LUT cell.
    const lutInputMax = this.lutInputMax;
    const lutInputMaxInv = 1 / lutInputMax;

    for (let i = 0; i < rgbaF32.length; i += 4) {
      const r = rgbaF32[i];
      const g = rgbaF32[i + 1];
      const b = rgbaF32[i + 2];
      const a = rgbaF32[i + 3];

      let oR: number, oG: number, oB: number;
      if (linearPassthrough) {
        // Raw linear passthrough — no LUT, no gamma. Values get clamped to
        // [0,1] so they fit the 8-bit framebuffer. Used for "Linear sRGB"
        // and "Raw" OCIO modes.
        oR = Math.max(0, Math.min(1, r * exposure));
        oG = Math.max(0, Math.min(1, g * exposure));
        oB = Math.max(0, Math.min(1, b * exposure));
      } else {
        // Map per-pixel linear value into the LUT's input domain.
        // `lutInputMaxInv` converts the [0, lutInputMax] range into the
        // [0, scale] cell index used below.
        const cr = Math.min(lutInputMax, Math.max(0, r * exposure)) * lutInputMaxInv * scale;
        const cg = Math.min(lutInputMax, Math.max(0, g * exposure)) * lutInputMaxInv * scale;
        const cb = Math.min(lutInputMax, Math.max(0, b * exposure)) * lutInputMaxInv * scale;

        const r0 = Math.floor(cr);
        const g0 = Math.floor(cg);
        const b0 = Math.floor(cb);
        const r1 = Math.min(r0 + 1, scale);
        const g1 = Math.min(g0 + 1, scale);
        const b1 = Math.min(b0 + 1, scale);
        const fr = cr - r0;
        const fg = cg - g0;
        const fb = cb - b0;

        const stride = n * n;
        const base000 = (b0 * stride + g0 * n + r0) * 3;
        const base001 = (b1 * stride + g0 * n + r0) * 3;
        const base010 = (b0 * stride + g1 * n + r0) * 3;
        const base011 = (b1 * stride + g1 * n + r0) * 3;
        const base100 = (b0 * stride + g0 * n + r1) * 3;
        const base101 = (b1 * stride + g0 * n + r1) * 3;
        const base110 = (b0 * stride + g1 * n + r1) * 3;
        const base111 = (b1 * stride + g1 * n + r1) * 3;

        const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

        let lR = 0, lG = 0, lB = 0;
        for (let ch = 0; ch < 3; ch++) {
          const c000 = lut[base000 + ch];
          const c001 = lut[base001 + ch];
          const c010 = lut[base010 + ch];
          const c011 = lut[base011 + ch];
          const c100 = lut[base100 + ch];
          const c101 = lut[base101 + ch];
          const c110 = lut[base110 + ch];
          const c111 = lut[base111 + ch];

          const c00 = lerp(c000, c100, fr);
          const c01 = lerp(c001, c101, fr);
          const c10 = lerp(c010, c110, fr);
          const c11 = lerp(c011, c111, fr);
          const c0 = lerp(c00, c10, fg);
          const c1 = lerp(c01, c11, fg);
          const c = lerp(c0, c1, fb);

          if (ch === 0) lR = c;
          else if (ch === 1) lG = c;
          else lB = c;
        }
        oR = lR;
        oG = lG;
        oB = lB;
      }

      let gammaR: number, gammaG: number, gammaB: number;
      if (linearPassthrough || lutIncludesSrgbOetf) {
        // No gamma in raw-linear mode, and no gamma when the LUT already
        // encoded sRGB OETF (ACES CG/Studio LUTs are baked with
        // linearToSRGB applied in Rust).
        gammaR = oR;
        gammaG = oG;
        gammaB = oB;
      } else {
        // Gamma correction. Math.pow is the slow part — JS engines can't
        // vectorize it. For higher throughput, swap to a 256-entry lookup
        // table if benchmarks show this is a bottleneck.
        gammaR = Math.pow(Math.max(oR, 0), invGamma);
        gammaG = Math.pow(Math.max(oG, 0), invGamma);
        gammaB = Math.pow(Math.max(oB, 0), invGamma);
      }

      out[i] = (gammaR * 255 + 0.5) | 0;
      out[i + 1] = (gammaG * 255 + 0.5) | 0;
      out[i + 2] = (gammaB * 255 + 0.5) | 0;
      out[i + 3] = (a * 255 + 0.5) | 0;
    }
  }

  render(): void {
    if (!this.rgbaBuf) throw new Error("render() before loadFrame");
    const w = this.currentWidth;
    const h = this.currentHeight;
    if ("width" in this.canvas) {
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
    }
    const imageData = new ImageData(this.rgbaBuf, w, h);
    this.ctx.putImageData(imageData, 0, 0);
  }

  resize(width: number, height: number): void {
    if ("width" in this.canvas) {
      this.canvas.width = Math.max(1, width);
      this.canvas.height = Math.max(1, height);
    }
  }

  dispose(): void {
    this.lut = null;
    this.rgbaBuf = null;
  }
}

/**
 * Phase 6: Local copy of the half→float expansion helper (from
 * TauriFileSystem.ts). Duplicated here to avoid an import cycle —
 * TauriFileSystem imports from the GPU/CPU renderers in some other
 * paths, and this renderer is a leaf module. Algorithm is identical
 * to the canonical one in TauriFileSystem.ts; if you change one,
 * change the other.
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