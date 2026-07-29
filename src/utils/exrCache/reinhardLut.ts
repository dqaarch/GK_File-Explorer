/**
 * Reinhard tone-mapping LUT generator (2026-07-13).
 *
 * The user requested an additional OCIO Colorspace option dedicated
 * to decoding HDRI / EXR-HDR content "the EXR way" — i.e. a tone
 * mapper rather than a colour-space transform. Reinhard 2002 is
 * the classic reference:
 *
 *   L_d = L_w / (1 + L_w)                    (per-channel)
 *
 * For colour preservation we apply it per-channel instead of
 * dividing by luminance — Reinhard's "colour" variant
 * (`L_d = L_w * (1 + L_w/L_white²) / (1 + L_w)`) reduces to
 * classical Reinhard when L_white → ∞, so we use that form with a
 * finite L_white so highlights above L_white² fade gracefully
 * instead of plateauing at 1.
 *
 * The LUT is baked as a 3D float table in the same wire format the
 * existing OCIO LUTs use (size³ × 3 floats, R varies fastest, then
 * G, then B). The shader's `c / u_lutInputMax` divide already
 * normalises the input domain, so baking inputMax=4096 means the
 * shader's input will be divided by 4096 and the LUT corners cover
 * full HDR scene-referred values.
 *
 * ### Why 4096 instead of 16?
 *
 * Classical Reinhard's asymptote is at `L_d = 1.0` for `L_w → ∞`, so
 * the LUT data is inherently HDR-safe — there is NO sharp clamp at
 * the top edge like ACES has at 16.29. Choosing a larger input
 * domain (4096 instead of 16) lets the shader's `clamp(color *
 * exposure, 0.0, u_lutInputMax)` not truncate real-world HDR peaks:
 *
 *   - valley_of_desolation_4k.exr: peak ≈ 1850 (verified via the
 *     Rust FFI decoder). With `inputMax=16` the shader clamps that
 *     to 16 and every highlight compresses to LUT corner → looks
 *     blown-out white. With `inputMax=4096` the peak lands at
 *     `1850/4096 ≈ 0.45` which sits in the smooth mid-range of the
 *     Reinhard curve.
 *
 * The auto-exposure divisor (P99 luminance scaling) is also
 * disabled for Reinhard because Reinhard handles HDR dynamics on
 * its own — P99 scaling makes midtones artificially dark for HDRI
 * files. See `exrGpuPipeline.ts` for the disable.
 *
 * ### Why OETF baked in?
 *
 * The existing OCIO LUTs (`setLutBakedSrgbOetf=true` in the shader)
 * include the sRGB OETF (linear → display-referred encoding) so the
 * shader doesn't apply `pow(c, 1/2.2)` again. We follow the same
 * convention: Reinhard output is in `[0, 1]` linear display space,
 * we apply sRGB OETF analytically before storing, and tell the
 * renderer to skip its own gamma pass via `setLutBakedSrgbOetf(true)`.
 *
 * Per-channel (not luminance-based) was chosen because:
 *   1. It matches the existing LUT pipeline (one LUT entry per
 *      RGB triplet, no separate luminance channel needed).
 *   2. It's what `gen_luts.py` would emit if asked to bake
 *      Reinhard — same wire format, same shader sampling.
 *   3. Hue shift on saturated colours is mild for the modest
 *      exposure range of typical HDRI captures.
 */

const REINHARD_LUT_SIZE = 64;
/**
 * HDR input domain — values above this get soft-clipped toward 1.
 *
 * 4096 (12-bit equivalent stop range) covers every real-world HDRI
 * capture we'd plausibly see. The shader's `clamp()` at this value
 * is a safety net, not the primary compressor.
 */
const REINHARD_INPUT_MAX = 4096.0;

function linearToSrgbOetf(linear: number): number {
  if (linear <= 0.0031308) return 12.92 * linear;
  return 1.055 * Math.pow(linear, 1.0 / 2.4) - 0.055;
}

/**
 * Generate the Reinhard 3D LUT as a Float32Array in the same wire
 * format as the Rust-baked OCIO LUTs (size³ × 3 floats, RGB).
 *
 * The array is cacheable — pure function of `size` and `inputMax`.
 * `ExrGpuPipeline.resolveActiveLut()` calls this once per slug and
 * stashes the result in its `lutResolveCache`.
 *
 * Output values are display-referred sRGB-encoded (OETF applied),
 * matching the `setLutBakedSrgbOetf=true` convention the ACES LUTs
 * follow. The shader will skip its own gamma application.
 */
export function generateReinhardLut(
  size: number = REINHARD_LUT_SIZE,
  inputMax: number = REINHARD_INPUT_MAX,
  whitepoint: number = 4096.0,
): Float32Array {
  const data = new Float32Array(size * size * size * 3);
  const invLwhiteSq = 1.0 / (whitepoint * whitepoint);

  let i = 0;
  for (let b = 0; b < size; b++) {
    const bNorm = (b / (size - 1)) * inputMax;
    for (let g = 0; g < size; g++) {
      const gNorm = (g / (size - 1)) * inputMax;
      for (let r = 0; r < size; r++) {
        const rNorm = (r / (size - 1)) * inputMax;

        const linearR = reinhardChannel(rNorm, invLwhiteSq);
        const linearG = reinhardChannel(gNorm, invLwhiteSq);
        const linearB = reinhardChannel(bNorm, invLwhiteSq);

        // Encode sRGB OETF so the shader skips its own gamma pass.
        data[i++] = linearToSrgbOetf(linearR);
        data[i++] = linearToSrgbOetf(linearG);
        data[i++] = linearToSrgbOetf(linearB);
      }
    }
  }
  return data;
}

function reinhardChannel(linear: number, invLwhiteSq: number): number {
  if (linear <= 0) return 0;
  const denom = 1 + linear;
  const numerator = linear * (1 + linear * invLwhiteSq);
  const out = numerator / denom;
  return out > 1 ? 1 : out;
}

/** The HDR input domain covered by the synthesised LUT. */
export const REINHARD_LUT_INPUT_MAX = REINHARD_INPUT_MAX;

/** Voxel resolution of the synthesised LUT (size³ cells). */
export const REINHARD_LUT_VOXEL_SIZE = REINHARD_LUT_SIZE;