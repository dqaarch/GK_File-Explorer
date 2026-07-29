/**
 * Web Worker that runs the OCIO LUT + tone-map pipeline on a chunk of
 * float32 RGBA pixels. The main thread splits the frame into N strips,
 * posts them to N workers, and assembles the result ImageData.
 *
 * Same algorithm as EXRCpuLutRenderer but per-row rather than per-frame,
 * and without the gamma correction (the main thread applies a single
 * gamma pass at the end — small visual delta, ~30% speedup).
 *
 * When `linearPassthrough` is true, the LUT lookup and gamma encoding
 * are both skipped — output is the raw linear pixel value clamped to
 * [0,1]. Used for the "Linear sRGB" OCIO mode (FFI-decode passthrough)
 * so the user sees the actual encoded scene-linear data without any
 * display transform.
 */

export interface LutWorkerInput {
  id: number;
  rgbaF32: Float32Array;
  width: number;
  height: number;
  rowStart: number;
  rowEnd: number;
  lut: Float32Array;
  lutSize: number;
  exposure: number;
  invGamma: number;
  /** When true, skip LUT lookup + gamma encoding. Output raw linear (clamped). */
  linearPassthrough?: boolean;
  /** When true, the active LUT already encodes sRGB OETF (e.g. ACES CG
   *  LUTs baked as linearToSRGB(acesFilm(...))). Skip the extra
   *  pow(c, invGamma) pass to avoid double-encoding gamma. */
  lutIncludesSrgbOetf?: boolean;
}

export interface LutWorkerOutput {
  id: number;
  /** Row-major RGBA8 bytes for the requested strip. */
  rgba: Uint8ClampedArray;
}

self.addEventListener("message", (ev: MessageEvent<LutWorkerInput>) => {
  const msg = ev.data;
  const { rgbaF32, width, rowStart, rowEnd, lut, lutSize, exposure, invGamma, id } = msg;
  const linearPassthrough = msg.linearPassthrough === true;
  const lutIncludesSrgbOetf = msg.lutIncludesSrgbOetf === true;
  const effectiveInvGamma = lutIncludesSrgbOetf ? 1.0 : invGamma;
  const n = lutSize;
  const scale = n - 1;
  const stride = n * n;

  const rowCount = rowEnd - rowStart;
  const rgba = new Uint8ClampedArray(rowCount * width * 4);

  for (let row = 0; row < rowCount; row++) {
    const y = rowStart + row;
    const rowBaseIn = y * width * 4;
    const rowBaseOut = row * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowBaseIn + x * 4;
      const r = rgbaF32[i];
      const g = rgbaF32[i + 1];
      const b = rgbaF32[i + 2];
      const a = rgbaF32[i + 3];

      const out = rowBaseOut + x * 4;

      if (linearPassthrough) {
        // Raw linear passthrough — clamp to [0,1] for the 8-bit framebuffer.
        // Used for "Linear sRGB" / "Raw" OCIO modes. No LUT, no gamma.
        rgba[out]     = (Math.max(0, Math.min(1, r * exposure)) * 255 + 0.5) | 0;
        rgba[out + 1] = (Math.max(0, Math.min(1, g * exposure)) * 255 + 0.5) | 0;
        rgba[out + 2] = (Math.max(0, Math.min(1, b * exposure)) * 255 + 0.5) | 0;
        rgba[out + 3] = (a * 255 + 0.5) | 0;
        continue;
      }

      const cr = Math.min(1, Math.max(0, r * exposure)) * scale;
      const cg = Math.min(1, Math.max(0, g * exposure)) * scale;
      const cb = Math.min(1, Math.max(0, b * exposure)) * scale;

      const r0 = Math.floor(cr);
      const g0 = Math.floor(cg);
      const b0 = Math.floor(cb);
      const r1 = Math.min(r0 + 1, scale);
      const g1 = Math.min(g0 + 1, scale);
      const b1 = Math.min(b0 + 1, scale);
      const fr = cr - r0;
      const fg = cg - g0;
      const fb = cb - b0;

      const base000 = (b0 * stride + g0 * n + r0) * 3;
      const base001 = (b1 * stride + g0 * n + r0) * 3;
      const base010 = (b0 * stride + g1 * n + r0) * 3;
      const base011 = (b1 * stride + g1 * n + r0) * 3;
      const base100 = (b0 * stride + g0 * n + r1) * 3;
      const base101 = (b1 * stride + g0 * n + r1) * 3;
      const base110 = (b0 * stride + g1 * n + r1) * 3;
      const base111 = (b1 * stride + g1 * n + r1) * 3;

      const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

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
        const c1 = lerp(c01, c11, fb);
        const c = lerp(c0, c1, fb);

        const corrected = Math.pow(Math.max(c, 0), effectiveInvGamma);
        rgba[out + ch] = (corrected * 255 + 0.5) | 0;
      }
      rgba[out + 3] = (a * 255 + 0.5) | 0;
    }
  }

  const out: LutWorkerOutput = { id, rgba };
  (self as unknown as Worker).postMessage(out, [rgba.buffer]);
});

export type { LutWorkerInput as LutWorkerInputMsg, LutWorkerOutput as LutWorkerOutputMsg };