/**
 * EXRGpuRenderer — WebGL2 renderer with OCIO 3D LUT fragment shader.
 *
 * Pipeline:
 *   1. Allocate a RGBA32F texture sized to the EXR frame.
 *   2. Upload linear HDR floats from Rust `decodeExrF32`.
 *   3. Allocate a RGBA32F 3D LUT texture; upload the OCIO LUT once.
 *   4. Draw a passthrough quad; fragment shader does trilinear LUT
 *      lookup + exposure + gamma correction.
 *
 * Used in the happy path (Win11 + Edge WebView2). For other targets see
 * `EXRCpuLutRenderer.ts`.
 */

import { dbg } from '../debug';

const VERTEX_SRC = /* glsl */ `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // v_uv.x: 0..1 left to right.
  // v_uv.y: invert so v_uv.y=1 corresponds to the top of the canvas,
  // matching the EXR convention (row 0 = top). This replaces
  // UNPACK_FLIP_Y_WEBGL=true which interacts badly with RGBA32F
  // uploads on some WebGL2 backends (causes horizontal banding).
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 1.0 - (a_pos.y * 0.5 + 0.5));
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// Trilinear LUT lookup with manual 8-corner unroll (avoids precision
// issues on some GPUs that can't do texture3DLod with EXT_color_buffer_float).
const FRAGMENT_SRC = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_image;     // RGBA float (linear HDR)
uniform sampler3D u_lut;       // OCIO 3D LUT (RGB -> RGB)
uniform float u_lutSize;       // LUT grid size, e.g. 33.0
uniform float u_exposure;      // exposure stops as multiplier (default 1.0)
uniform float u_invGamma;      // 1/gamma, e.g. 1/2.2 = 0.4545 for sRGB output
uniform float u_autoExposure;  // if > 0, divide color by this before LUT (1/P99 luminance)
uniform float u_needsBgrSwap;  // if 1.0, swap R<->B to fix BGRA upload quirk
uniform float u_inlineAces;    // if 1.0, skip LUT and use inline ACES + sRGB OETF
uniform float u_acesInputAcescg; // 1.0 if the EXR is already in ACEScg (AP1); 0.0 if linear sRGB. Reserved for future use when the EXR-side IDT is detected per-frame. The current pipeline always assumes scene-linear sRGB (the typical renderer output), matching the previous behaviour.
uniform float u_lutInputMax;   // max scene-linear value the baked LUT covers (e.g. 16.29 for ACES). Shader divides color/u_lutInputMax before indexing.
uniform float u_passMode;      // 0=RGB (OCIO+ACES), 1=Grayscale raw, 2=Normal raw, 3=Motion raw, 4=UV raw, 5=Depth raw, 7=Position raw
uniform float u_linearPassthrough; // if 1.0, output raw linear clamped values (no ACES, no gamma). For "Linear sRGB" OCIO mode (the FFI-decode passthrough).
uniform float u_lutBakedSrgbOetf;  // 1.0 if the LUT already encodes sRGB OETF (e.g. ACES modes where Rust-baked LUT includes linearToSRGB); skip the extra pow(..., u_invGamma) in that case.

vec3 lutLookup(vec3 color) {
  // Clamp + apply exposure, then map the linear HDR value into the
  // LUT's input domain (u_lutInputMax, e.g. 16.29 for ACES RRT).
  // The LUT is baked across [0, u_lutInputMax] so the ACES tone curve
  // is sampled at the full highlight range. Values above u_lutInputMax
  // are clamped to the top edge — they map to display white after tone
  // mapping. u_lutInputMax defaults to 1.0 for the identity LUT
  // (Raw / Linear sRGB) so existing behavior is preserved.
  vec3 c = clamp(color * u_exposure, 0.0, u_lutInputMax);
  float scale = u_lutSize - 1.0;
  // Normalize [0, u_lutInputMax] to [0, 1] then to [0, scale].
  vec3 idx = (c / u_lutInputMax) * scale;

  vec3 idxF = floor(idx);
  vec3 idxC = min(idxF + vec3(1.0), vec3(scale));
  vec3 f = idx - idxF;

  // We do manual trilinear interpolation between 8 corner texels.
  // WebGL texture() consumes NORMALIZED [0,1] texture coordinates
  // and GL_LINEAR filtering would apply ITS OWN bilinear blend
  // between the corner texel and its neighbour — resulting in a
  // double interpolation that biases every lookup toward mid-cell
  // values (so cell 1 returns ~0.5*cell0 + 0.5*cell1 instead of
  // cell1, halving the LUT contrast and darkening the output).
  //
  // To avoid that, we look up the EXACT 8 texels the shader wants
  // by computing texel CENTER coordinates: texel i sits at coord
  // (i + 0.5) / size. With GL_NEAREST this returns the texel at
  // that center — which is the one we want, with no extra filter
  // bias. The LUT is uploaded with TEXTURE_MIN_FILTER = GL_NEAREST
  // and TEXTURE_MAG_FILTER = GL_NEAREST (see createFloatTexture)
  // so each texture() call below returns exactly one texel value.
  float invSize = 1.0 / u_lutSize;

  // 8 corner samples at exact texel centers
  vec3 c000 = texture(u_lut, (idxF + 0.5) * invSize).rgb;
  vec3 c001 = texture(u_lut, vec3(idxF.x + 0.5, idxF.y + 0.5, idxC.z + 0.5) * invSize).rgb;
  vec3 c010 = texture(u_lut, vec3(idxF.x + 0.5, idxC.y + 0.5, idxF.z + 0.5) * invSize).rgb;
  vec3 c011 = texture(u_lut, vec3(idxF.x + 0.5, idxC.y + 0.5, idxC.z + 0.5) * invSize).rgb;
  vec3 c100 = texture(u_lut, vec3(idxC.x + 0.5, idxF.y + 0.5, idxF.z + 0.5) * invSize).rgb;
  vec3 c101 = texture(u_lut, vec3(idxC.x + 0.5, idxF.y + 0.5, idxC.z + 0.5) * invSize).rgb;
  vec3 c110 = texture(u_lut, vec3(idxC.x + 0.5, idxC.y + 0.5, idxF.z + 0.5) * invSize).rgb;
  vec3 c111 = texture(u_lut, (idxC + 0.5) * invSize).rgb;

  // Do NOT clamp to [0,1] here. OCIO RRT can produce out-of-gamut negative
  // linear values at saturated cell corners. Previously we clamped because the
  // LUT was clipped to [0,1] at bake time, so clamping before lerp compensated.
  // Now that LUT baking preserves full float32 values (including negatives),
  // we must NOT clamp — the sRGB OETF (linearToSRGB) naturally outputs 0 for
  // c <= 0, so the final output is correct without any explicit clamping.
  // Clamping before lerp would incorrectly zero out valid negative contributions
  // and produce the same ~0.05 G/B channel error we fixed in the Python bake.

  vec3 c00 = mix(c000, c100, f.x);
  vec3 c01 = mix(c001, c101, f.x);
  vec3 c10 = mix(c010, c110, f.x);
  vec3 c11 = mix(c011, c111, f.x);

  vec3 c0 = mix(c00, c10, f.y);
  vec3 c1 = mix(c01, c11, f.y);

  return mix(c0, c1, f.z);
}

// ACES Filmic Tone Mapping.
// Two implementations are provided:
//
//  1. acesNarkowicz — Krzysztof Narkowicz 3-term fit (legacy).
//     Cheap and good enough for snapshots, but desaturates
//     highlights and shifts chroma; doesn't match the full RRT.
//
//  2. acesStephenHill — Stephen Hill's pubished "fit" of the
//     ACES RRT + sRGB ODT (ACES 1.0 reference). Much closer to
//     what AE/Nuke resolve out of ACEScg images.
//
// We default to Hill because user feedback showed Narkowicz's
// output looked "washed out / dull" compared to After Effects.
vec3 acesNarkowicz(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// sRGB EOTF → linear (inverse of IEC 61966-2-1). Only needed when the
// incoming pixels were sRGB-encoded; left as a helper for completeness
// even though the EXR pipeline feeds us raw linear floats.
vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + vec3(0.055)) / 1.055, vec3(2.4));
  return mix(hi, lo, step(c, vec3(0.04045)));
}

// Stephen Hill ACES fit (2017), the same chain baked into
// BakingLab/ACES.hlsl by MJP+Neubelt and used by every modern real-time
// renderer that emulates ACES without running PyOpenColorIO.
//
// The Hill fit collapses the full OCIO ACEScg display-view transform
// into a single analytic shader pass:
//
//   1. Input matrix:  linear sRGB (D65) -> XYZ (D65)
//                          D65_2_D60 CAT (Bradford)
//                          XYZ -> ACEScg (AP1)
//                          AP0 -> AP1 tone-curve roll-off (RRT_SAT)
//   2. Tone curve:    3-term rational fit of the combined ACES RRT + 100 nits ODT
//   3. Output matrix: AP1 -> ODT_SAT dim -> XYZ (D60)
//                          D60_2_D65 CAT (Bradford)
//                          XYZ -> sRGB primaries
//
// ACES 2.0 vs 1.0: AE uses the same Hill constants (S-2014-006).
// The "ACES 2.0 CG" name in OCIO cg-config refers to the CONFIG
// package (OCIO v2 API, config schema), NOT a different math. Both
// ACES 1.0 and ACES 2.0 use the same RRT/ODT tone curve and matrices.
// The user confirmed AE ACES Native OCIO matches Hill, so we stick
// with Hill's published constants.
//
// IMPORTANT: GLSL's mat3(c0, c1, c2) constructor is COLUMN-MAJOR --
// each vec3 argument becomes a *column*, not a row. The Stephen Hill
// ACES fit constants are published in row-major order, so passing them
// straight into the constructor silently transposes the matrix. That
// was the root cause of the 'ACES 2.0 looks too warm / washed out'
// complaint after the sRGB->AP1 IDT fix: M . v was computing with
// the transposed matrix and the output never landed on the ACES
// chromaticity triangle. transpose(...) flips it back.
//
// PREVIOUS BUG FIX #1 -- Double OETF:
// The previous version applied linearToSRGB(...) on top of the Hill
// output. But acesHill() ALREADY returns display-referred LINEAR sRGB
// (through ACES_OUTPUT_MAT which converts AP1 to sRGB). The sRGB OETF
// (gamma encoding) belongs at the VERY END of the pipeline, only once.
// Double-encoding made midtones lift 5-10% and pushed saturated
// channels toward 0.98+, causing the "more saturated than AE" look.
//
// PREVIOUS BUG FIX #2 -- Matrix direction:
// ACES_INPUT_MAT = transpose(mat3(...)) is NOT a bare sRGB->AP1 IDT.
// It folds in the D65->D60 Bradford CAT. This is intentional and correct
// for scene-linear sRGB EXRs (the standard renderer output). Using a
// bare 3x3 sRGB->AP1 (no CAT) moves the white point and desaturates
// the image toward the AP1 primaries. The current matrix is correct.

const mat3 ACES_INPUT_MAT = transpose(mat3(
  vec3(0.59719, 0.35458, 0.04823),
  vec3(0.07600, 0.90834, 0.01566),
  vec3(0.02840, 0.13383, 0.83777)
));

const mat3 ACES_OUTPUT_MAT = transpose(mat3(
  vec3( 1.60475, -0.53108, -0.07367),
  vec3(-0.10208,  1.10813, -0.00605),
  vec3(-0.00327, -0.07276,  1.07602)
));

// 3-term rational fit of ACES RRT + 100 nit sRGB ODT.
// Input: RRT-in rendering space (already through ACES_INPUT_MAT).
// Output: display-referred LINEAR sRGB, ready for sRGB OETF.
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

// Combined display-view transform for linear sRGB EXR input.
// Returns display-referred LINEAR sRGB. Apply sRGB OETF exactly once
// at the end of the render pipeline (in the fragment shader call site).
vec3 acesHill(vec3 linearSRGB) {
  vec3 acesIn  = ACES_INPUT_MAT * linearSRGB;
  vec3 toneMgd = RRTAndODTFit(acesIn);
  return ACES_OUTPUT_MAT * toneMgd;
}

// Linear -> sRGB OETF (IEC 61966-2-1). Matches the behavior of tools
// that produce test_lin.png-style references (clip + gamma).
vec3 linearToSRGB(vec3 c) {
  vec3 cutoff = step(c, vec3(0.0031308));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, cutoff);
}

void main() {
  vec4 hdr = texture(u_image, v_uv);
  vec3 color = hdr.rgb;
  // Auto-exposure (if enabled): divide by P99 luminance so dark HDR
  // scenes don't just clamp to white. u_autoExposure > 0 means enabled.
  if (u_autoExposure > 0.0) {
    color = color / u_autoExposure;
  }
  // Debug BGR swap (only when u_needsBgrSwap == 1.0): some browsers /
  // WebGL2 implementations return sampled texels with channels reversed
  // when uploading as RGBA32F. Toggle this on if colors look wrong.
  if (u_needsBgrSwap > 0.5) {
    color = color.bgr;
  }

  vec3 graded;
  if (u_linearPassthrough > 0.5) {
    // Raw linear passthrough — used for "Linear sRGB" and "Raw" OCIO
    // modes. The OCIO LUT for these modes is identity (baked from
    // 'ocio://default' -> view "Raw" = no transform), so the pixel
    // lands at the shader as scene-linear sRGB. Clamp to [0,1] so the
    // 8-bit framebuffer receives a finite value (HDR pixels clip intentionally -- that's the trade-off of "Linear sRGB" mode),
    // then gamma-encode via sRGB OETF so the monitor renders it with
    // the expected brightness and saturation. AE's Comp Window does
    // the same: even when you pick the "Raw" view, the sRGB monitor
    // still applies the OETF to display the pixels.
    //
    // Previously this path skipped OETF and looked "brighter / warmer
    // than AE" (the inverse direction of the ACES bug). With OETF
    // applied here the Linear sRGB / Raw views match AE for any
    // non-HDR image; HDR pixels clip at white as before.
    graded = linearToSRGB(clamp(color, 0.0, 1.0));
  } else if (u_passMode > 0.5) {
    // Non-color pass (grayscale/depth/normal/etc). Skip OCIO + ACES +
    // sRGB OETF — render raw linear values. For grayscale we put the
    // luminance into R=G=B; for vector passes (normal/motion/uv/
    // position/tangent) the RGB channels already encode the data.
    if (u_passMode > 1.5 && u_passMode < 2.5) {
      // Normal: signed → map [-1,1] → [0,1].
      graded = clamp(color * 0.5 + 0.5, 0.0, 1.0);
    } else if (u_passMode > 4.5 && u_passMode < 5.5) {
      // Depth: large values → clamp high. Use [0,1] for now.
      graded = clamp(color, 0.0, 1.0);
    } else {
      // Grayscale / Motion / UV / Position / Tangent / Crypto: copy
      // the RGB channels directly (already meaningful or equal).
      graded = clamp(color, 0.0, 1.0);
    }
  } else if (u_inlineAces > 0.5) {
    // Inline path: ACES Hill fit (Stephen Hill 2017, S-2014-006).
    //
    // acesHill returns display-referred LINEAR sRGB.
    // We apply the sRGB OETF exactly ONCE to produce the
    // gamma-encoded pixel values the canvas/monitor expects.
    //
    // BUG FIX: the previous version applied linearToSRGB(...) on TOP
    // of the Hill output, double-encoding the gamma. Hill ALREADY
    // returns display-linear through ACES_OUTPUT_MAT. Double OETF
    // made midtones lift and pushed saturated channels to 0.98+,
    // causing the "more saturated than AE" look. Fixed: one OETF only.
    graded = linearToSRGB(acesHill(color));
  } else {
    // Real OCIO LUT path. LutLookup returns the OCIO DisplayViewTransform
    // output, which is ALREADY display-referred sRGB gamma-encoded — PyOpenColorIO
    // confirms input 0.5 -> output ~0.65 (not ~0.5 linear). If
    // u_lutBakedSrgbOetf is set, the LUT already went through
    // linearToSRGB and we output it directly; otherwise we apply
    // the OETF ourselves (for identity LUTs or raw/linear-sRGB modes).
    if (u_lutBakedSrgbOetf > 0.5) {
      graded = lutLookup(color);
    } else {
      graded = linearToSRGB(lutLookup(color));
    }
  }
  fragColor = vec4(graded, hdr.a);
}
`;

export interface GpuRendererInit {
  /** Optional canvas; if omitted a hidden offscreen canvas is used. */
  canvas?: HTMLCanvasElement | OffscreenCanvas;
}

export class EXRGpuRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private texImage: WebGLTexture;
  private texLut: WebGLTexture;
  private uImage: WebGLUniformLocation;
  private uLut: WebGLUniformLocation;
  private uLutSize: WebGLUniformLocation;
  private uExposure: WebGLUniformLocation;
  private uInvGamma: WebGLUniformLocation;
  private uAutoExposure: WebGLUniformLocation;
  private uNeedsBgrSwap: WebGLUniformLocation;
  private uInlineAces: WebGLUniformLocation;
  private uPassMode: WebGLUniformLocation;
  private uLinearPassthrough: WebGLUniformLocation;
  private uLutBakedSrgbOetf: WebGLUniformLocation;
  private uAcesInputAcescg: WebGLUniformLocation;
  private uLutInputMax: WebGLUniformLocation;

  /**
   * When true, skip the OCIO LUT and apply inline ACES filmic tonemap +
   * sRGB OETF in the shader. Used as the build-time fallback when the
   * host doesn't have PyOpenColorIO (so all OCIO LUTs get baked as
   * identity). Set from JS via setInlineAces().
   */
  /**
   * 2026-07-04: default to FALSE so a freshly created renderer goes
   * straight to the LUT path. The previous default of `true` was a
   * legacy fallback for builds missing PyOpenColorIO (where every
   * baked LUT is identity and the Hill fit was the only way to get
   * a filmic rolloff). Now that we ship real OCIO LUTs we don't want
   * any code path to land on the inline ACES branch by accident —
   * especially Phase 6C re-renders, which only upload the LUT and
   * never call setInlineAces.
   */
  private inlineAces = false;

  /**
   * When true, `render()` skips the OCIO LUT + inline ACES tonemap and
   * emits the linear pixel buffer (auto-exposure still applied if
   * active). Set by `setBypassOcio()` for non-colour passes
   * (depth/normal/motion/UV/grayscale/cryptomatte/AO/wireframe/…).
   * Resets on the next non-bypass decode so the LUT path runs again.
   */
  private bypassOcio = false;

  /**
   * When true, the shader outputs the raw linear pixel values clamped to
   * [0,1] with NO transform applied — no ACES tonemap, no sRGB OETF, no
   * gamma encoding. This is what the "Linear sRGB" OCIO mode promises:
   * display the encoded values as-is. Set from JS via setLinearPassthrough().
   * Defaults to false so legacy behavior (inline ACES + LUT) keeps working.
   */
  private linearPassthrough = false;

  private imgWidth = 0;
  private imgHeight = 0;
  private lutSize = 0;
  private pendingUploadFence: WebGLSync | null = null;
  /** True when the source texture was uploaded as RGBA16F; affects debug logs only. */
  private usedHalfFloat = false;
  /** Cached at construction: whether the WebGL2 context supports RGBA16F sampling. */
  private readonly halfFloatSupported: boolean;
  /**
   * Cached reference to the last RGBA-F32 frame passed to loadFrame().
   * Used by the debug pixel dump to read back raw HDR values at the
   * sample pixel coordinates. Weak-ish reference: we keep it alive as
   * long as the renderer is in use; explicitly cleared by dispose().
   */
  private lastUploadedHdr: Float32Array | null = null;

  private exposure = 1.0;
  private invGamma = 1 / 2.2;
  /**
   * Auto-exposure divisor. When > 0, the shader divides every pixel by
   * this value before LUT application. Set to the P99 luminance of the
   * current frame (scaled to ~0.5) so dark HDR scenes don't clamp to
   * pure white. Computed in JS by sampling the float32 buffer; the GPU
   * path doesn't have direct access to histogram data.
   */
  private autoExposure = 0.0;
  /**
   * Toggle verbose per-pixel debug logging in render(). Off by default.
   * Enabled automatically when `?debugOcio=1` is in the URL hash, or
   * programmatically via setDebugOcio(true). When enabled the renderer
   * reads back a few sample pixels after every draw and logs the raw
   * HDR value, the post-LUT value, and the final sRGB byte values.
   */
  private debugOcio = false;
  /**
   * Cached LUT data + size for CPU-side manual lookup, used to produce
   * "what the LUT should output" reference values for the debug log.
   * Set by setLut(); cleared by dispose().
   */
  private lutCpu: Float32Array | null = null;
  private lutCpuSize = 0;
  /**
   * Debug switch: when true, swap R<->B in the shader. Some WebGL2
   * implementations return sampled texels with channels reversed when
   * the source texture was uploaded as RGBA32F. Set this to true if
   * the rendered colors look BGR.
   */
  private needsBgrSwap = false;
  /**
   * Pass-mode selector for the shader. 0 = RGB (apply OCIO/ACES),
   * 1 = Grayscale, 2 = Normal, 3 = Motion, 4 = UV, 5 = Depth,
   * 7 = Position. Non-zero modes bypass OCIO/ACES and render the
   * raw linear channels directly.
   */
  private passMode = 0;
  /**
   * 1.0 if the active LUT already encodes sRGB OETF in its output (e.g.
   * ACES CG/Studio LUTs that Rust bakes via linearToSRGB(acesFilm(...))).
   * When true, the shader skips the extra `pow(graded, u_invGamma)`
   * pass at the end of the LUT branch, otherwise we'd be double-encoding
   * gamma. For non-ACES identity LUTs this stays at 0.
   */
  private lutBakedSrgbOetf = 0;
  /**
   * Max scene-linear value the baked LUT was sampled over (mirrors the
   * Rust constant `exr_ocio_lut::LUT_INPUT_MAX` and `bake_ocio_lut.
   * LUT_INPUT_MAX`). The shader divides per-pixel linear values by
   * this constant before indexing so the LUT covers the ACES RRT's
   * full scene-referred range. Identity LUTs (Raw / Linear sRGB) keep
   * this at 1.0 to preserve the legacy "output = input" behavior.
   */
  private lutInputMax = 1.0;

  /** Result of the last `init()` call; useful for `canUseGpu()` checks. */
  readonly ext: { colorBufferFloat: boolean; textureFloatLinear: boolean };

  constructor(init: GpuRendererInit = {}) {
    const canvas = init.canvas ?? new OffscreenCanvas(1, 1);
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      // NOTE: do NOT enable sRGB encoding on the WebGL canvas (via
      // powerPreference: 'high-performance' or similar is fine; the
      // { colorSpace: 'srgb' } context hint does NOT exist in the WebGL2
      // spec — this comment exists only to prevent someone from adding
      // it in the future). The canvas holds linear RGBA16F render target
      // values; the sRGB OETF is applied explicitly in the fragment
      // shader (linearToSRGB). PNG export via toBlob/toDataURL then
      // correctly encodes these values as sRGB for display on a monitor.
      // Enabling sRGB framebuffer attachment would cause the GPU to
      // auto-decode sRGB→linear on readPixels, and PNG would re-encode
      // linear→sRGB — net effect is the same, but the extra conversion
      // adds precision loss and the framebuffer would need to store
      // linear values instead of sRGB-encoded ones, which breaks the
      // invariant that the shader always writes sRGB-encoded output.
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 not supported");

    this.gl = gl;
    this.program = this.compileProgram(VERTEX_SRC, FRAGMENT_SRC);
    this.vao = this.createQuadVAO();

    this.texImage = this.createFloatTexture(gl.TEXTURE_2D);
    this.texLut = this.createFloatTexture(gl.TEXTURE_3D);

    this.uImage = gl.getUniformLocation(this.program, "u_image")!;
    this.uLut = gl.getUniformLocation(this.program, "u_lut")!;
    this.uLutSize = gl.getUniformLocation(this.program, "u_lutSize")!;
    this.uExposure = gl.getUniformLocation(this.program, "u_exposure")!;
    this.uInvGamma = gl.getUniformLocation(this.program, "u_invGamma")!;
    this.uAutoExposure = gl.getUniformLocation(this.program, "u_autoExposure")!;
    this.uNeedsBgrSwap = gl.getUniformLocation(this.program, "u_needsBgrSwap")!;
    this.uInlineAces = gl.getUniformLocation(this.program, "u_inlineAces")!;
    this.uPassMode = gl.getUniformLocation(this.program, "u_passMode")!;
    this.uLinearPassthrough = gl.getUniformLocation(this.program, "u_linearPassthrough")!;
    this.uLutBakedSrgbOetf = gl.getUniformLocation(this.program, "u_lutBakedSrgbOetf")!;
    this.uAcesInputAcescg = gl.getUniformLocation(this.program, "u_acesInputAcescg")!;
    this.uLutInputMax = gl.getUniformLocation(this.program, "u_lutInputMax")!;

    this.ext = {
      colorBufferFloat: !!gl.getExtension("EXT_color_buffer_float"),
      textureFloatLinear: !!gl.getExtension("OES_texture_float_linear"),
    };

    // Probe RGBA16F support. The ANGLE backend on Windows historically has
    // issues uploading large RGBA32F arrays correctly (causing horizontal
    // stripes at chunk boundaries). RGBA16F is widely supported and more
    // reliable for HDR float uploads on this backend.
    const probe = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, probe);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    let halfOk = false;
    try {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA16F, 2, 2, 0, gl.RGBA, gl.HALF_FLOAT,
        new Uint16Array(16),
      );
      const err = gl.getError();
      halfOk = err === gl.NO_ERROR;
    } catch {
      halfOk = false;
    }
    gl.deleteTexture(probe);
    this.halfFloatSupported = halfOk;
  }

  private compileShader(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error("createShader failed");
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compile failed: ${info}\n---\n${src}`);
    }
    return shader;
  }

  private compileProgram(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const program = gl.createProgram();
    if (!program) throw new Error("createProgram failed");
    const v = this.compileShader(gl.VERTEX_SHADER, vs);
    const f = this.compileShader(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(program, v);
    gl.attachShader(program, f);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Program link failed: ${info}`);
    }
    return program;
  }

  private createFloatTexture(target: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("createTexture failed");
    gl.bindTexture(target, tex);
    // Clamp-to-edge is important for LUT — anything outside [0,1] must
    // not wrap around or bleed from the opposite face.
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    // IMPORTANT: this helper is shared by the 2D HDR texture AND the
    // 3D OCIO LUT. The LUT path manually does its own trilinear
    // interpolation between 8 corner texels in the fragment shader
    // (see `lutLookup()`), so we MUST set NEAREST filtering here —
    // GL_LINEAR would apply its own bilinear blend between adjacent
    // texels and double-interpolate (so the value at cell i becomes
    // ~0.5*cell(i-1) + 0.5*cell(i+1), darkening the LUT contrast
    // and producing visible banding against AE/Resolve). The 2D HDR
    // texture path also uses NEAREST — see loadFrame() — because the
    // user asked for pixel-accurate preview at full resolution.
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return tex;
  }

  private createQuadVAO(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("createVertexArray failed");
    gl.bindVertexArray(vao);

    const buf = gl.createBuffer();
    if (!buf) throw new Error("createBuffer failed");
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // Fullscreen triangle-strip quad covering NDC [-1, +1].
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(this.program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
    return vao;
  }

  /** Upload a new OCIO 3D LUT. Replaces any previously bound LUT. */
  setLut(lutData: Float32Array, size: number): void {
    if (lutData.length !== size * size * size * 3) {
      throw new Error(
        `LUT length mismatch: got ${lutData.length}, expected ${size ** 3 * 3} for ${size}³ grid`,
      );
    }
    // DEBUG (2026-06-30 OCIO cleanup): log a hash of the LUT
    // contents so the user can verify "two different view transforms
    // got two different texture uploads" in DevTools. Hash is just
    // 4 corner values + middle to keep the log one-liner.
    if (typeof window !== "undefined" &&
        (window.location.hash.includes("debugOcio=1") ||
         (window as unknown as { __gokuDebugOcio?: boolean }).__gokuDebugOcio === true)) {
      const last = size * size * size - 1;
      const mid = Math.floor(size / 2);
      const midOff = (mid * size * size + mid * size + mid) * 3;
      const lastOff = last * 3;
      const fingerprint = [
        lutData[0].toFixed(3), lutData[1].toFixed(3), lutData[2].toFixed(3),
        lutData[midOff].toFixed(3), lutData[midOff + 1].toFixed(3), lutData[midOff + 2].toFixed(3),
        lutData[lastOff].toFixed(3), lutData[lastOff + 1].toFixed(3), lutData[lastOff + 2].toFixed(3),
      ].join(",");
      dbg.log(`[OCIO-DEBUG] setLut size=${size} corners=[${fingerprint}]`);
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_3D, this.texLut);
    // UNPACK_FLIP_Y_WEBGL is only valid for 2D textures — leaving it `true`
    // (because the most recent upload was a 2D frame) makes texImage3D throw
    // INVALID_OPERATION: "FLIP_Y or PREMULTIPLY_ALPHA isn't allowed for
    // uploading 3D textures". Disable it explicitly before the 3D upload.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGB32F,
      size,
      size,
      size,
      0,
      gl.RGB,
      gl.FLOAT,
      lutData,
    );
    this.lutSize = size;
    // Cache a copy for the CPU-side reference lookup used by debug logging.
    // 33^3 * 3 = ~107 KB so the memory cost is negligible.
    this.lutCpu = new Float32Array(lutData);
    this.lutCpuSize = size;
  }

  /**
   * Upload a new HDR frame to the source texture.
   * Phase 6: accepts either `Float32Array` (legacy path, will be
   * downcast to F16 internally before RGBA16F upload) or
   * `Uint16Array` (raw half-precision IEEE 754 bits, uploaded
   * directly via `gl.HALF_FLOAT` — bypasses the F32→F16 conversion
   * that costs ~30 ms per 1920×1920 frame).
   *
   * The `isHalfFloat` flag tells the renderer which input layout is
   * in use. When `false` (default), the input is treated as Float32
   * and the existing conversion path runs.
   */
  loadFrame(
    pixels: Float32Array | Uint16Array,
    width: number,
    height: number,
    isHalfFloat: boolean = false,
  ): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texImage);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // IMPORTANT: don't set UNPACK_FLIP_Y_WEBGL=true here. Several WebGL2
    // backends (notably ANGLE/D3D11 on Windows, which Edge WebView2 uses)
    // produce incorrect data — including horizontal black bands at chunk
    // boundaries — when uploading RGBA32F textures with FLIP_Y enabled.
    // The vertex shader inverts V instead so EXR row 0 still ends up at
    // the canvas top.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // Use NEAREST filtering for the HDR source image. Two reasons:
    // 1) DWAB / DWA compressed EXR files decoded via OpenEXRCore produce
    //    per-chunk row data that is independently contiguous in memory, but
    //    the texture upload treats the whole image as one block. LINEAR
    //    sampling across chunk-row boundaries (256-row DWAB chunks) tends
    //    to interpolate against partially-uninitialized texels on
    //    ANGLE/D3D11 → visible horizontal stripes.
    // 2) The HDR values are scene-linear floats. We don't want bilinear
    //    blending smearing bright highlights into neighbouring dim pixels
    //    during the look — let the shader do any resize / blend it wants
    //    after sampling at the exact texel center.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // Upload is asynchronous on most drivers — issue a fence so render()
    // can wait until the pixels are visible before sampling.
    this.pendingUploadFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);

    // Try RGBA16F (half float) first — it's a native WebGL2 format and
    // much more reliably implemented on ANGLE/D3D11 than RGBA32F. If the
    // driver rejects it (some older drivers report success but corrupt
    // data when uploading large RGBA32F arrays), we fall back to RGBA32F.
    const useHalfFloat = this.halfFloatSupported;
    if (useHalfFloat) {
      let half: Uint16Array;
      if (isHalfFloat && pixels instanceof Uint16Array) {
        // Phase 6 fast path: caller already supplied half-precision bits.
        // Upload directly without the F32→F16 conversion (saves ~30 ms for
        // a 1920×1920 frame on the JS main thread).
        half = pixels;
      } else {
        // Legacy path: caller supplied Float32Array (cache hit, depth pass,
        // or any non-Beauty layer). Convert to F16 before upload.
        half = float32ToFloat16Array(pixels as Float32Array);
      }
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA16F,
        width,
        height,
        0,
        gl.RGBA,
        gl.HALF_FLOAT,
        half,
      );
      this.usedHalfFloat = true;
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        width,
        height,
        0,
        gl.RGBA,
        gl.FLOAT,
        // Float32Array view of the pixel data — the legacy path. For
        // Uint16Array input on a halfFloat-unsupported driver we still
        // need to expand, but this case should be rare (halfFloat is
        // present on virtually every WebGL2 device).
        isHalfFloat && pixels instanceof Uint16Array
          ? float32ToFloat16Array(pixels as unknown as Float32Array)
          : (pixels as Float32Array),
      );
      this.usedHalfFloat = false;
    }
    this.imgWidth = width;
    this.imgHeight = height;
    // Keep a reference for the debug pixel dump (see dumpDebugPixels).
    // The renderer doesn't own/mutate this array, so storing it is safe.
    // Phase 6: track the source as either F32 or F16 — debug dumper
    // casts based on `usedHalfFloat` already.
    this.lastUploadedHdr = isHalfFloat
      ? new Float32Array(0) // placeholder — dumper doesn't read this path
      : (pixels as Float32Array);
  }

  setExposure(stops: number): void {
    this.exposure = Math.max(0.001, stops);
  }

  setGamma(gamma: number): void {
    this.invGamma = 1 / Math.max(0.1, gamma);
  }

  /**
   * Set auto-exposure divisor. Pass 0 to disable.
   * Typical values are computed as `0.5 / P99_luminance` so the brightest
   * 1% of pixels end up at ~0.5 in linear space.
   */
  setAutoExposure(divisor: number): void {
    this.autoExposure = Math.max(0.0, divisor);
  }

  /**
   * Force the renderer to skip the OCIO LUT / ACES tonemap and pass
   * the linear pixel buffer straight through (auto-exposure still
   * applied if active). Used when `detectPassType` flags a non-colour
   * pass (depth, normal, position, motion, UV, grayscale, cryptomatte,
   * AO, wireframe, …) — colour-managed passes keep the user's LUT.
   */
  setBypassOcio(bypass: boolean): void {
    this.bypassOcio = bypass;
    if (bypass) {
      // Skip the LUT upload on the next render and clear the inline-ACES
      // hint so the shader takes the bypass branch.
      this.inlineAces = false;
      this.linearPassthrough = true;
    }
  }

  /**
   * Debug toggle for BGR↔RGB channel swap. Enable if WebGL2 reads texels
   * with channels reversed on this GPU.
   */
  setNeedsBgrSwap(swap: boolean): void {
    this.needsBgrSwap = swap;
  }

  /**
   * Toggle the inline ACES + sRGB OETF path in the shader. When true the
   * OCIO 3D LUT is skipped entirely — kept as an escape hatch for
   * builds missing PyOpenColorIO (where every baked LUT is identity
   * and the Hill fit was the only way to get a filmic rolloff). The
   * default is now `false` so the LUT path is always taken when a real
   * OCIO LUT has been uploaded. Flip to true only if you've verified
   * the LUT texture is identity / missing.
   */
  setInlineAces(use: boolean): void {
    this.inlineAces = use;
  }

  /**
   * Enable raw-linear passthrough: the shader skips the OCIO LUT, inline
   * ACES tonemap, sRGB OETF, and gamma encoding, and outputs the linear
   * pixel values directly (clamped to [0,1] for the 8-bit framebuffer).
   * Use for "Linear sRGB" / "Raw" OCIO modes where the user wants no
   * display transform applied.
   */
  setLinearPassthrough(use: boolean): void {
    this.linearPassthrough = use;
    // Clear the HDR bypass whenever the caller explicitly requests
    // passthrough (e.g. switching to "Raw" or "Linear sRGB" OCIO mode).
    // Otherwise the bypass flag would survive across files and force
    // every subsequent decode into bypass mode regardless of the
    // current pass_type classification.
    if (!use) {
      this.bypassOcio = false;
    }
  }

  /**
   * Enable verbose per-pixel OCIO debug logging. When enabled, `render()`
   * reads back 3 sample pixels, computes a CPU reference LUT lookup,
   * and logs: raw HDR → expected LUT output → raw LUT byte output →
   * final sRGB byte output. Use this to compare against After Effects
   * / DaVinci reference values.
   */
  setDebugOcio(on: boolean): void {
    this.debugOcio = on;
  }

  /**
   * Inform the renderer that the active LUT already encodes sRGB OETF
   * (e.g. the Rust-baked ACES Narkowicz + linearToSRGB LUT). When true,
   * the shader skips its own sRGB gamma encode after `lutLookup` so
   * the final output is exactly what the LUT produced (not double-encoded).
   */
  /**
   * Inform the renderer what scene-linear input domain the active LUT
   * was baked over (mirrors the `input_max` returned by Rust's
   * `OcioLutResponse` / `CustomOcioResponse`). Call this after every
   * `setLut()` so the shader divides per-pixel linear values by the
   * correct constant before indexing. Identity LUTs can leave this at
   * 1.0 (the default).
   */
  setLutInputMax(maxIn: number): void {
    this.lutInputMax = Math.max(0.001, maxIn);
  }

  setLutBakedSrgbOetf(baked: boolean): void {
    this.lutBakedSrgbOetf = baked ? 1 : 0;
  }

  /**
   * Set the pass-mode selector used by the shader.
   * 0 = RGB (Beauty)         — apply OCIO/ACES.
   * 1 = Grayscale (AO/Ro/...) — render raw single-channel as luma.
   * 2 = Normal               — render raw, sign remap [-1,1]→[0,1].
   * 3 = Motion Vector        — render raw.
   * 4 = UV                   — render raw.
   * 5 = Depth                — render raw, clamped to [0,1].
   * 7 = Position             — render raw.
   */
  setPassMode(mode: number): void {
    this.passMode = mode | 0;
  }

  /**
   * Phase 6C: Re-render the current frame with a freshly-uploaded LUT
   * (for when the user switches OCIO modes). The HDR texture and the
   * shader state are already set up from the previous frame; this
   * only swaps the LUT and re-issues the draw call. Saves the
   * `texImage2D` upload (~30-50 ms for 1920×1920 RGBA16F) and the
   * Float16 conversion (~30 ms).
   *
   * Returns the render time in milliseconds (for debug logging).
   */
  reRenderWithNewLut(lutData: Float32Array, lutSize: number, inputMax: number): number {
    const t0 = performance.now();
    this.setLut(lutData, lutSize);
    this.setLutInputMax(inputMax);
    this.render();
    return performance.now() - t0;
  }

  /** Draw the current frame to the bound framebuffer. */
  render(): void {
    if (!this.lutSize || !this.imgWidth) {
      throw new Error("render() called before loadFrame/setLut");
    }
    const gl = this.gl;
    gl.viewport(0, 0, this.imgWidth, this.imgHeight);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texImage);
    gl.uniform1i(this.uImage, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.texLut);
    gl.uniform1i(this.uLut, 1);

    gl.uniform1f(this.uLutSize, this.lutSize);
    gl.uniform1f(this.uExposure, this.exposure);
    gl.uniform1f(this.uInvGamma, this.invGamma);
    gl.uniform1f(this.uAutoExposure, this.autoExposure);
    gl.uniform1f(this.uNeedsBgrSwap, this.needsBgrSwap ? 1.0 : 0.0);
    gl.uniform1f(this.uInlineAces, this.inlineAces ? 1.0 : 0.0);
    gl.uniform1f(this.uPassMode, this.passMode);
    gl.uniform1f(this.uLinearPassthrough, this.linearPassthrough ? 1.0 : 0.0);
    gl.uniform1f(this.uLutBakedSrgbOetf, this.lutBakedSrgbOetf ? 1.0 : 0.0);
    gl.uniform1f(this.uLutInputMax, this.lutInputMax);
    // u_acesInputAcescg is kept for backwards shader-source compatibility
    // but the inline ACES path now always assumes the input is in ACEScg
    // (AP1). OCIO's display-view transform handles the per-renderer IDT,
    // so we don't try to detect per-file color spaces here.
    gl.uniform1f(this.uAcesInputAcescg, 1.0);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    // [EXR-GPU-LUT-DBG] Read back 3 pixels from the just-drawn
    // framebuffer so we can confirm the LUT/ACES path actually painted
    // something. `getImageData` on the OffscreenCanvas can fail silently
    // (WebGL canvas → 2D context readback is flaky in some WebView2
    // versions); reading via gl.readPixels is always reliable.
    //
    // Phase 6 perf: `gl.readPixels` is a synchronous GPU→CPU stall on
    // ANGLE/D3D11 — measured ~40 ms per call on the test workstation.
    // The previous code did 3 calls every frame (q1/center/q3) for a
    // total ~120 ms of forced GPU sync per decoded frame. That's
    // bigger than the entire Rust decode cost on some files. Only
    // enable this when the user explicitly turns on OCIO tracing —
    // the gated path also runs the existing `dumpDebugPixels` if
    // `debugOcio` is set, which is the heavier offline-analysis
    // helper. Without these gates, every Beauty preview paid the
    // 120 ms readback tax for no production benefit.
    if (this.debugOcio) {
      try {
        const buf = new Uint8Array(4);
        const cx = Math.floor(this.imgWidth / 2);
        const cy = Math.floor(this.imgHeight / 2);
        gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const mid = [buf[0], buf[1], buf[2], buf[3]];
        gl.readPixels(Math.floor(this.imgWidth * 0.25), cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const q1 = [buf[0], buf[1], buf[2], buf[3]];
        gl.readPixels(Math.floor(this.imgWidth * 0.75), cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const q3 = [buf[0], buf[1], buf[2], buf[3]];
        dbg.log(
          `[EXR-GPU-LUT-DBG] gl.readPixels fb: ` +
            `q1=${JSON.stringify(q1)} center=${JSON.stringify(mid)} q3=${JSON.stringify(q3)} ` +
            `(imgSize=${this.imgWidth}x${this.imgHeight} lutSize=${this.lutSize} ` +
            `linearPassthrough=${this.linearPassthrough} inlineAces=${this.inlineAces} ` +
            `lutBakedSrgbOetf=${this.lutBakedSrgbOetf} lutInputMax=${this.lutInputMax.toFixed(3)})`,
        );
      } catch (e) {
        console.warn(`[EXR-GPU-LUT-DBG] gl.readPixels failed:`, e);
      }
    }

    if (this.debugOcio) {
      try {
        this.dumpDebugPixels();
      } catch (e) {
        console.warn(`[OCIO-DBG] dumpDebugPixels threw:`, e);
      }
    }
  }

  /**
   * Trilinear sample of the cached LUT. Mirrors what the GPU shader does
   * (clamp-to-edge, no bounds check). Returns [r, g, b] in [0, 1] (or
   * beyond if the LUT encodes sRGB OETF and the input is HDR — OCIO's
   * baked LUTs can exceed 1.0 since they're display-referred).
   */
  private sampleLut(r: number, g: number, b: number): [number, number, number] {
    if (!this.lutCpu || this.lutCpuSize < 2) return [r, g, b];
    const n = this.lutCpuSize;
    const last = n - 1;
    // Map [0, u_lutInputMax] to [0, last]. The LUT is baked over
    // [0, u_lutInputMax] (16.29 for ACES RRT, 1.0 for identity
    // LUTs) so input values must be normalised against the LUT
    // domain BEFORE indexing. Without this, mid-tone values like
    // 0.10 land at cell ~6 in an ACES LUT, sampling the wrong
    // corner and producing a "lutRef" that doesn't match the GPU
    // output — defeating the whole point of the debug compare.
    const inputMax = Math.max(0.001, this.lutInputMax);
    const fr = Math.min(1, Math.max(0, r / inputMax)) * last;
    const fg = Math.min(1, Math.max(0, g / inputMax)) * last;
    const fb = Math.min(1, Math.max(0, b / inputMax)) * last;
    const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
    const r1 = Math.min(last, r0 + 1), g1 = Math.min(last, g0 + 1), b1 = Math.min(last, b0 + 1);
    const dr = fr - r0, dg = fg - g0, db = fb - b0;
    const idx = (rr: number, gg: number, bb: number) =>
      ((bb * n + gg) * n + rr) * 3;
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const out: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const c000 = this.lutCpu[idx(r0, g0, b0) + c];
      const c100 = this.lutCpu[idx(r1, g0, b0) + c];
      const c010 = this.lutCpu[idx(r0, g1, b0) + c];
      const c110 = this.lutCpu[idx(r1, g1, b0) + c];
      const c001 = this.lutCpu[idx(r0, g0, b1) + c];
      const c101 = this.lutCpu[idx(r1, g0, b1) + c];
      const c011 = this.lutCpu[idx(r0, g1, b1) + c];
      const c111 = this.lutCpu[idx(r1, g1, b1) + c];
      const c00 = lerp(c000, c100, dr);
      const c10 = lerp(c010, c110, dr);
      const c01 = lerp(c001, c101, dr);
      const c11 = lerp(c011, c111, dr);
      const c0 = lerp(c00, c10, dg);
      const c1 = lerp(c01, c11, dg);
      out[c] = lerp(c0, c1, db);
    }
    return out;
  }

  /**
   * Read back 3 sample pixels + compute CPU reference LUT lookup. Logs:
   *   1. Raw HDR linear (from the Float32Array we just uploaded)
   *   2. CPU-trilinear LUT lookup (what the shader should produce)
   *   3. Final sRGB byte (what the shader actually wrote to the framebuffer)
   * Difference between (2) and (3) = shader-side bug (gamma double-encode,
   * wrong branch, etc.). Difference between (1) and (2) = wrong LUT.
   *
   * Throttled to ~1 dump per second per frame; the preloader otherwise
   * floods the console with hundreds of lines.
   */
  private lastDebugDumpTime = 0;
  private debugDumpCount = 0;
  private dumpDebugPixels(): void {
    if (this.debugDumpCount > 12) return; // Limit first 12 dumps (3 frames x 3 samples + 3 header lines)
    this.debugDumpCount++;
    const now = performance.now();
    if (now - this.lastDebugDumpTime < 0) return;
    this.lastDebugDumpTime = now;
    const gl = this.gl;
    const w = this.imgWidth, h = this.imgHeight;
    if (!w || !h) return;
    // Sample points: center + two off-center for variance.
    const pts: Array<[number, number, string]> = [
      [Math.floor(w / 2), Math.floor(h / 2), "C"],
      [Math.floor(w * 0.25), Math.floor(h * 0.5), "L"],
      [Math.floor(w * 0.75), Math.floor(h * 0.5), "R"],
    ];
    const px = new Uint8Array(4);
    const hdr = this.lastUploadedHdr;
    dbg.log(
      `[OCIO-DBG] ===== frame ${w}x${h} expo=${this.exposure.toFixed(3)} ` +
        `invGamma=${this.invGamma.toFixed(3)} autoExpo=${this.autoExposure.toFixed(3)} ` +
        `linearPass=${this.linearPassthrough} inlineAces=${this.inlineAces} ` +
        `bakedSrgb=${this.lutBakedSrgbOetf} bgrSwap=${this.needsBgrSwap} ` +
        `lutSize=${this.lutSize} halfFloat=${this.usedHalfFloat} =====`,
    );
    for (const [x, y, lbl] of pts) {
      // Read final framebuffer byte
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const finalR = px[0], finalG = px[1], finalB = px[2];

      // Raw HDR linear at the same pixel
      let rawR = 0, rawG = 0, rawB = 0;
      let expR = 0, expG = 0, expB = 0;
      let refR = 0, refG = 0, refB = 0;
      if (hdr) {
        const i = (y * w + x) * 4;
        rawR = hdr[i]; rawG = hdr[i + 1]; rawB = hdr[i + 2];
        // What the shader sees: HDR * exposure, divided by autoExposure if on.
        const e = this.autoExposure > 0 ? this.exposure / this.autoExposure : this.exposure;
        expR = rawR * e; expG = rawG * e; expB = rawB * e;
        const sampled = this.sampleLut(expR, expG, expB);
        refR = sampled[0]; refG = sampled[1]; refB = sampled[2];
      }
      dbg.log(
        `[OCIO-DBG] ${lbl}(${x},${y}) raw=(${rawR.toFixed(4)},${rawG.toFixed(4)},${rawB.toFixed(4)}) ` +
          `postExpo=(${expR.toFixed(4)},${expG.toFixed(4)},${expB.toFixed(4)}) ` +
          `lutRef=(${refR.toFixed(4)},${refG.toFixed(4)},${refB.toFixed(4)}) ` +
          `final=(${finalR},${finalG},${finalB})`,
      );
    }
  }

  /** Resize the underlying canvas. Pass 0 to leave canvas size alone. */
  resize(width: number, height: number): void {
    const target = this.gl.canvas as HTMLCanvasElement | OffscreenCanvas;
    if ("width" in target) {
      target.width = Math.max(1, width);
      target.height = Math.max(1, height);
    }
  }

  /** Phase 6C: getter for the current source image dimensions (used
   *  to skip texImage2D upload when the new frame is the same size). */
  getWidth(): number { return this.imgWidth; }
  getHeight(): number { return this.imgHeight; }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.texImage);
    gl.deleteTexture(this.texLut);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}

/**
 * Convert a Float32Array of RGBA pixels to a Uint16Array of IEEE 754
 * half-precision floats (the bit pattern that WebGL's HALF_FLOAT type
 * expects). We round-to-nearest-even; values outside the half range
 * (±65504) saturate. NaNs and infinities map to the canonical half NaN.
 */
function float32ToFloat16Array(f32: Float32Array): Uint16Array {
  const out = new Uint16Array(f32.length);
  const buf = new ArrayBuffer(4);
  const fv = new Float32Array(buf);
  const iv = new Uint32Array(buf);
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i];
    if (Number.isNaN(v)) { out[i] = 0x7e00; continue; }
    if (!Number.isFinite(v)) { out[i] = v > 0 ? 0x7c00 : 0xfc00; continue; }
    fv[0] = v;
    const x = iv[0];
    const sign = (x >>> 16) & 0x8000;
    let exp = ((x >>> 23) & 0xff) - 127 + 15;
    let mant = x & 0x7fffff;
    if (exp <= 0) {
      if (exp < -10) {
        out[i] = sign;
      } else {
        // Subnormal: shift mantissa with implicit leading 1.
        mant = (mant | 0x800000) >>> (1 - exp);
        // Round to nearest even.
        const roundBit = mant & 0x1000;
        mant >>>= 13;
        if (roundBit) {
          mant = (mant + 1) & 0x3ff;
          if (mant === 0) exp = 1;
        }
        out[i] = sign | mant;
      }
    } else if (exp >= 31) {
      // Overflow → ±Inf.
      out[i] = sign | 0x7c00;
    } else {
      // Round mantissa to 10 bits, nearest even.
      const roundBit = mant & 0x1000;
      mant >>>= 13;
      if (roundBit) {
        const sum = mant + 1;
        if (sum === 0x400) { mant = 0; exp += 1; }
        else mant = sum & 0x3ff;
        if (exp >= 31) out[i] = sign | 0x7c00;
        else out[i] = sign | (exp << 10) | mant;
      } else {
        out[i] = sign | (exp << 10) | mant;
      }
    }
  }
  return out;
}

/**
 * Cheap capability probe used by the renderer factory to decide whether
 * to pick the GPU or CPU path. Safe to call multiple times.
 */
export function canUseGpu(): boolean {
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    if (!gl) return false;
    const ext = gl.getExtension("EXT_color_buffer_float");
    if (!ext) return false;
    // Float textures are core in WebGL2; only the linear filter is the
    // extension we care about for visual quality.
    void gl.getExtension("OES_texture_float_linear");
    return true;
  } catch {
    return false;
  }
}