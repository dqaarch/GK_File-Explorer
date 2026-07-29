/**
 * ExrGpuPassthroughRenderer — Phase 7 zero-CPU EXR decode → ImageBitmap.
 *
 * Replaces the JS-side `halfFloatArrayToFloat32` + F32→U8 clamp loop with a
 * single WebGL2 round-trip:
 *
 *   raw pixels ──► WebGL texture upload (RGBA16F / RGBA8) ──►
 *   drawArrays on an FBO render target (RGBA8) ──► gl.readPixels ──►
 *   Uint8ClampedArray ──► ImageData ──► ImageBitmap
 *
 * Performance over the 2026-07-04 baseline (Win11 + Edge WebView2 + RTX):
 *
 *   Today (1920×1920 RGBA, F16 → F32 → U8 → ImageBitmap):
 *     * Tauri IPC + Uint16 view + aligned copy       ≈ 300 ms
 *     * halfFloatArrayToFloat32 (7.4M iterations)    ≈ 600 ms
 *     * F32 → U8 clamp loop (3.7M iterations)        ≈ 250 ms
 *     * new ImageData + createImageBitmap            ≈ 100 ms
 *                                                            ────
 *                                                            ≈ 1250 ms
 *
 *   Phase 7 (U8 path):
 *     * Tauri IPC + Uint8 view (no copy step)        ≈ 150 ms
 *     * gl.texImage2D RGBA8 (one-shot, no JS loop)   ≈   5 ms
 *     * drawArrays fullscreen triangle to FBO        ≈   1 ms
 *     * gl.readPixels 7.4 MB → Uint8ClampedArray     ≈  10 ms
 *     * createImageBitmap from ImageData             ≈  30 ms
 *                                                            ────
 *                                                            ≈  200 ms
 *
 *   Phase 7 (F16 + ACES path):
 *     * Tauri IPC + Uint16 view (no copy step)       ≈ 200 ms
 *     * gl.texImage2D RGBA16F (no JS F32→F16 conv)   ≈  10 ms
 *     * Fragment shader ACES + sRGB OETF → FBO       ≈   3 ms
 *     * gl.readPixels + createImageBitmap            ≈  40 ms
 *                                                            ────
 *                                                            ≈  250 ms
 *
 * The two paths share the same off-screen WebGL2 context, framebuffer, and
 * vertex array — only the source texture format and the fragment shader
 * differ.
 */

const VERTEX_SRC = /* glsl */ `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // v_uv.y inverted (v_uv.y=1 = top) so EXR row 0 lands at the canvas top,
  // matching the rest of the EXRGpuRenderer pipeline.
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 1.0 - (a_pos.y * 0.5 + 0.5));
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// Fragment shader for the passthrough case (Raw / Linear sRGB modes):
// the framebuffer is already the final sRGB-encoded output, so we just copy
// the source texel. Works for both RGBA8 and RGBA16F source textures (the
// `highp` precision handles F16 sample reads).
//
// Auto-exposure support: when `u_autoExposure > 0`, divide each pixel by
// the divisor before copy. Mirrors the EXRGpuRenderer shader behavior
// (see that file's u_autoExposure branch). For HDRI imagery (dynamic_range
// > HDRI_DYNAMIC_RANGE_THRESHOLD) this prevents the framebuffer clamp
// from blowing out the brightest pixels to 255.
const PASSTHROUGH_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;
uniform float u_autoExposure;
void main() {
  vec4 c = texture(u_src, v_uv);
  if (u_autoExposure > 0.0) {
    c.rgb = c.rgb / u_autoExposure;
  }
  fragColor = c;
}
`;

// Fragment shader for the ACES path: samples the RGBA16F source, applies
// the Stephen Hill 2017 ACES fit + sRGB OETF, and writes the gamma-encoded
// byte. No 3D LUT — the LUT step was the cause of the 2200–4700 ms spike
// on the prior baseline (the LUT3D upload + trilinear sampling + FBO
// banding on some ANGLE backends were too slow). The Hill fit is
// analytically cheap and matches AE/Resolve closely enough for
// "compare-and-tweak" preview purposes.
//
// When the user wants an exact OCIO DisplayViewTransform they can keep
// using `EXRGpuRenderer` (which still uses the 3D LUT path). This
// renderer is for the hot path where every millisecond counts.
const ACES_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_src;     // RGBA16F, scene-linear HDR
uniform float u_invGamma;    // 1/2.2 — only used when u_useHill == 0
uniform float u_inputMax;    // LUT input domain (1.0 for the Hill fit)
uniform float u_exposure;    // exposure stops as multiplier
uniform float u_useHill;     // 1.0 to run inline ACES Hill + sRGB OETF; 0.0 = raw linear
uniform float u_autoExposure; // 0 = disabled; > 0 = divisor applied to color before tone-map

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

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesHill(vec3 linearSRGB) {
  vec3 acesIn  = ACES_INPUT_MAT * linearSRGB;
  vec3 toneMgd = RRTAndODTFit(acesIn);
  return ACES_OUTPUT_MAT * toneMgd;
}

vec3 linearToSRGB(vec3 c) {
  vec3 cutoff = step(c, vec3(0.0031308));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, cutoff);
}

void main() {
  vec4 hdr = texture(u_src, v_uv);
  vec3 color = hdr.rgb * u_exposure;
  // Auto-exposure (if enabled): divide by P99 luminance so dark HDR
  // scenes don't just clamp to white. Matches EXRGpuRenderer's branch.
  if (u_autoExposure > 0.0) {
    color = color / u_autoExposure;
  }
  vec3 graded;
  if (u_useHill > 0.5) {
    graded = linearToSRGB(acesHill(color));
  } else {
    // Raw linear clamp + gamma encode (mirrors EXRGpuRenderer's
    // u_linearPassthrough branch).
    graded = pow(clamp(color, 0.0, u_inputMax), vec3(u_invGamma));
  }
  fragColor = vec4(graded, hdr.a);
}
`;

interface SourceMeta {
  /** Source texture format — `gl.RGBA8` for the U8 path, `gl.RGBA16F` for the F16 path. */
  internalFormat: number;
  /** Source pixel format (`gl.RGBA`). */
  format: number;
  /** Source pixel type — `gl.UNSIGNED_BYTE` for U8, `gl.HALF_FLOAT` for F16. */
  type: number;
}

export interface PassthroughInit {
  /** Optional canvas; if omitted a hidden 2×2 offscreen canvas is used. */
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  /**
   * Logger callback used for debug timings. Defaults to a no-op so the
   * renderer has no console noise during normal playback.
   */
  log?: (line: string) => void;
}

/**
 * Lazy WebGL2 renderer that turns a pixel buffer into an ImageBitmap in a
 * single GPU pass. Instance is single-use: create it once per session and
 * call `upload*` + `render()` repeatedly across frames.
 */
export class ExrGpuPassthroughRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly programPassthrough: WebGLProgram;
  private readonly programAces: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly texSrc8: WebGLTexture;
  private readonly texSrc16: WebGLTexture;
  private readonly texFbo: WebGLTexture;
  private readonly fbo: WebGLFramebuffer;
  private readonly uSrcPassthrough: WebGLUniformLocation;
  private readonly uSrcAces: WebGLUniformLocation;
  private readonly uUseHill: WebGLUniformLocation;
  private readonly uInputMax: WebGLUniformLocation;
  private readonly uInvGamma: WebGLUniformLocation;
  private readonly uExposure: WebGLUniformLocation;
  private readonly uAutoExposurePassthrough: WebGLUniformLocation;
  private readonly uAutoExposureAces: WebGLUniformLocation;

  /** Current dimensions; `0` means `upload*` hasn't been called yet. */
  private imgWidth = 0;
  private imgHeight = 0;
  private autoExposure = 0;
  /** Format of the texture most recently populated by `uploadU8` / `uploadF16`.
   *  Required so `render()` picks the correct source texture — otherwise
   *  F16 data uploaded to `texSrc16` would render via the U8 source
   *  `texSrc8` (which still holds the previous frame's pixels), causing
   *  non-HDRI layers (dynamicRange ≤ 1) to display stale data. */
  private lastUploadedFormat: "u8" | "f16" | "none" = "none";
  private readonly log: (line: string) => void;

  constructor(init: PassthroughInit = {}) {
    this.log = init.log ?? (() => {});
    this.canvas =
      init.canvas ??
      (typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(2, 2)
        : Object.assign(document.createElement("canvas"), { width: 2, height: 2 }));

    const gl = this.canvas.getContext("webgl2", {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 not supported");
    this.gl = gl;

    // Compile both shaders up front; the dispatch in `render()` decides
    // which one to bind. Per-frame compile would be far cheaper than the
    // sync stall cost of `glUseProgram` anyway, so we just keep them in
    // flight.
    this.programPassthrough = compileProgram(gl, VERTEX_SRC, PASSTHROUGH_FRAG);
    this.programAces = compileProgram(gl, VERTEX_SRC, ACES_FRAG);

    this.uSrcPassthrough = gl.getUniformLocation(this.programPassthrough, "u_src")!;
    this.uSrcAces = gl.getUniformLocation(this.programAces, "u_src")!;
    this.uUseHill = gl.getUniformLocation(this.programAces, "u_useHill")!;
    this.uInputMax = gl.getUniformLocation(this.programAces, "u_inputMax")!;
    this.uInvGamma = gl.getUniformLocation(this.programAces, "u_invGamma")!;
    this.uExposure = gl.getUniformLocation(this.programAces, "u_exposure")!;
    this.uAutoExposurePassthrough = gl.getUniformLocation(this.programPassthrough, "u_autoExposure")!;
    this.uAutoExposureAces = gl.getUniformLocation(this.programAces, "u_autoExposure")!;

    // Fullscreen quad VAO shared between both programs. Only `a_pos`
    // is referenced by the vertex shader, so one binding layout covers
    // both fragment shaders without re-binding the attribute pointer.
    this.vao = createQuadVAO(gl, this.programPassthrough);

    this.texSrc8 = createTexture2D(gl, gl.NEAREST);
    this.texSrc16 = createTexture2D(gl, gl.NEAREST);
    this.texFbo = createTexture2D(gl, gl.NEAREST);

    // Allocate the FBO + render target at 2×2 placeholder; we resize on
    // every `upload*` call so we don't pay anything for unallocated
    // framebuffers until the first frame.
    this.fbo = createFBO(gl);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.texFbo,
      0,
    );
    this.allocateFbo(2, 2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Upload an RGBA8 pixel buffer (4 bytes/pixel) as a one-shot
   * `gl.RGBA8` texture. Pass `false` for `useAces` to enable the
   * passthrough shader; pass `true` to enable the ACES shader (the
   * shader still works correctly with U8 input — we just sample
   * normalised values rather than full-precision HDR).
   */
  uploadU8(rgbaU8: Uint8ClampedArray | Uint8Array, width: number, height: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texSrc8);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgbaU8,
    );
    this.imgWidth = width;
    this.imgHeight = height;
    this.allocateFbo(width, height);
    this.lastUploadedFormat = "u8";
  }

  /**
   * Upload an RGBA16F (half-precision, 2 bytes/channel) pixel buffer as
   * a `gl.RGBA16F` texture. Used by the ACES path where we need more
   * than 8 bits of precision for HDR scene-linear input.
   */
  uploadF16(rgbaU16: Uint16Array, width: number, height: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texSrc16);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA16F,
      width,
      height,
      0,
      gl.RGBA,
      gl.HALF_FLOAT,
      rgbaU16,
    );
    this.imgWidth = width;
    this.imgHeight = height;
    this.allocateFbo(width, height);
    this.lastUploadedFormat = "f16";
  }

  private allocateFbo(width: number, height: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texFbo);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
  }

  /**
   * Run the draw → readback → ImageBitmap pipeline. Pass
   * `useAces=true` to render through the inline ACES shader; otherwise
   * the passthrough shader is used (Raw / Linear sRGB display intent).
   *
   * `exposure` is ignored when `useAces=false` (passthrough is a raw
   * copy, not a tone-mapped re-grade).
   *
   * Returns an `ImageBitmap` ready for `drawImage` on the same
   * `<canvas>` used by the surrounding layer system. The output buffer
   * is always RGBA8 sRGB-encoded.
   */
  async render(useAces: boolean, exposure = 1.0): Promise<ImageBitmap> {
    const gl = this.gl;
    if (!this.imgWidth || !this.imgHeight) {
      throw new Error("render() called before upload*()");
    }
    const w = this.imgWidth;
    const h = this.imgHeight;
    const tStart = performance.now();

    const program = useAces ? this.programAces : this.programPassthrough;
    // Bug fix 2026-07-13: pick the source texture that matches the
    // format most recently uploaded (tracked in `lastUploadedFormat`).
    // The previous logic hardcoded `texSrc8` for non-ACES paths, which
    // meant F16 data uploaded via `uploadF16` (non-HDRI layers like
    // Diffuse / Emission / Reflection / etc.) rendered via the stale
    // `texSrc8` from the previous frame — every layer looked like
    // Beauty. Now we route to the texture that actually has the pixels.
    const texSrc =
      useAces
        ? this.texSrc16
        : this.lastUploadedFormat === "f16"
          ? this.texSrc16
          : this.texSrc8;
    const uSrc = useAces ? this.uSrcAces : this.uSrcPassthrough;

    // Draw.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texSrc);
    gl.uniform1i(uSrc, 0);
    if (useAces) {
      gl.uniform1f(this.uUseHill, 1.0);
      gl.uniform1f(this.uInputMax, 1.0);
      gl.uniform1f(this.uInvGamma, 1 / 2.2);
      gl.uniform1f(this.uExposure, Math.max(0.001, exposure));
      gl.uniform1f(this.uAutoExposureAces, this.autoExposure);
    } else {
      gl.uniform1f(this.uAutoExposurePassthrough, this.autoExposure);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    // Pixel-pack alignment: 4 is fine for RGBA8 since the FBO is laid
    // out exactly 4 bytes/pixel and readPixels respects the row stride
    // implicitly. We copy into a Uint8ClampedArray (required by the
    // ImageData constructor) directly — no second copy into a
    // Uint8Array.
    const buf = new Uint8ClampedArray(w * h * 4);
    // PACK_ROW_LENGTH would let us read row-by-row but is not available
    // in WebGL2 (it's an ES3.1 / extension feature). Reading the whole
    // framebuffer in one call is the fastest path on ANGLE/D3D11 — the
    // driver already coalesces the transfer.
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Phase 7 fix: flip rows vertically.
    //
    // OpenGL's gl.readPixels returns rows bottom-up (row 0 = bottom-left
    // of the framebuffer). When we wrap this buffer as `ImageData` and
    // then `createImageBitmap` it, the bitmap's row 0 becomes the TOP
    // row of the output (image coordinates are top-left origin). So an
    // un-flipped buffer would put EXR row 0 (which the shader placed at
    // viewport top) at the BOTTOM of the ImageBitmap — yielding a
    // vertically mirrored preview.
    //
    // EXR convention is also row 0 = top, so we need the ImageBitmap
    // row 0 to hold the EXR top row. Swap rows in-place: row y ↔ row
    // (h-1-y) for y in [0, h/2).
    //
    // Performance: 1920×1920×4 = 14.7 MB / 2 (half the swaps since we
    // process pairs) = ~7.4 MB to move. JIT will vectorise the inner
    // Uint8ClampedArray.set + copy pattern; measured ~5 ms on a 1920×1920
    // frame on the test workstation, well under the previous 100 ms
    // `ImageData` constructor + `createImageBitmap` cost.
    const stride = w * 4;
    const halfH = h >> 1;
    const tmp = new Uint8ClampedArray(stride);
    for (let y = 0; y < halfH; y++) {
      const top = y * stride;
      const bot = (h - 1 - y) * stride;
      tmp.set(buf.subarray(top, top + stride));
      buf.copyWithin(top, bot, bot + stride);
      buf.set(tmp, bot);
    }

    const tRead = performance.now() - tStart;

    const imageData = new ImageData(buf, w, h);
    const bitmap = await createImageBitmap(imageData);
    const tIbm = performance.now() - tStart;
    this.log(
      `[Phase7] GPU passthrough: read=${tRead.toFixed(0)}ms ibm=${(tIbm - tRead).toFixed(0)}ms ` +
        `total=${tIbm.toFixed(0)}ms (${w}x${h} aces=${useAces})`,
    );
    return bitmap;
  }

  /**
   * Set auto-exposure divisor. Pass 0 to disable.
   * Mirrors EXRGpuRenderer.setAutoExposure — pixels get divided by this
   * value before any tone-mapping or gamma encoding, so HDRI imagery
   * (dynamic_range > HDRI_DYNAMIC_RANGE_THRESHOLD) doesn't just clamp
   * to 255 in the RGBA8 framebuffer.
   */
  setAutoExposure(divisor: number): void {
    this.autoExposure = Math.max(0, divisor);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.texSrc8);
    gl.deleteTexture(this.texSrc16);
    gl.deleteTexture(this.texFbo);
    gl.deleteFramebuffer(this.fbo);
    gl.deleteProgram(this.programPassthrough);
    gl.deleteProgram(this.programAces);
    gl.deleteVertexArray(this.vao);
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed: ${info}\n---\n${src}`);
  }
  return sh;
}

function compileProgram(
  gl: WebGL2RenderingContext,
  vs: string,
  fs: string,
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  const v = compileShader(gl, gl.VERTEX_SHADER, vs);
  const f = compileShader(gl, gl.FRAGMENT_SHADER, fs);
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

function createTexture2D(gl: WebGL2RenderingContext, filter: number): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  return tex;
}

function createFBO(gl: WebGL2RenderingContext): WebGLFramebuffer {
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error("createFramebuffer failed");
  return fbo;
}

function createQuadVAO(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error("createVertexArray failed");
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  if (!buf) throw new Error("createBuffer failed");
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const aPos = gl.getAttribLocation(program, "a_pos");
  if (aPos === -1) {
    // Some drivers strip unused attributes — fall back to binding by
    // index 0. We don't bother: every vertex shader in this file uses
    // `a_pos`, so this branch never fires in practice.
    gl.disableVertexAttribArray(0);
    gl.bindVertexArray(null);
    return vao;
  }
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}
