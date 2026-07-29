/**
 * EWA Gaussian Splat Renderer - WebGL2 Implementation
 * 
 * Based on LumiGrade's WebGL2 EWA splatting algorithm.
 * Implements:
 * - Counting sort by view-space depth (65536 buckets)
 * - Full color grading pipeline (exp + temp + tint + RGB gain + levels + contrast + sat)
 * - Supersample rendering (SS = max(2, devicePixelRatio))
 * - HDRi equirectangular backdrop with ground projection + contact shadow
 * - Shape-aware contact shadow footprint
 */

import type { DecodedFrame } from "./types";

// Debug flag — set true locally to re-enable verbose EWA renderer logs.
const EWA_DEBUG = false;
const dbg = (...args: unknown[]) => { if (EWA_DEBUG) console.log(...args); };

export interface ColorGradingSettings {
  exposure: number;    // stops (default 0)
  temperature: number; // warm/cool shift (default 0)
  tint: number;        // magenta/green shift (default 0)
  contrast: number;    // contrast (default 1)
  saturation: number;  // saturation (default 1)
  rGain: number;       // per-channel R gain (default 1)
  gGain: number;       // per-channel G gain (default 1)
  bGain: number;       // per-channel B gain (default 1)
  blackLevel: number;  // black level (default 0)
  whiteLevel: number;  // white level (default 1)
}

export interface HdriSettings {
  enabled: boolean;
  file: string;
  autoExposure: number;  // HDRi log-mean based
  yaw: number;           // rotation around Y
  radius: number;       // ground projection radius
  capH: number;         // dome height
  groundY: number;      // ground plane Y
  shadowEnabled: boolean;
  shadowRadius: number; // shadow softness (texels)
}

export interface SplatRendererOptions {
  canvas: HTMLCanvasElement;
  fov?: number;
  fovDeg?: number;
  supersample?: number;
  colorGrading?: Partial<ColorGradingSettings>;
  hdri?: Partial<HdriSettings>;
  falk?: number; // Gaussian falloff sharpness (1.0 default, 4.0 PlayCanvas/alt preset)
}

const NBITS = 16;
const NBUCK = 1 << NBITS; // 65536

export class EwaSplatRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;

  // Splat shader
  private splatProgram: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;

  // Background shader (HDRi equirect + ground dome + shadow)
  private bgProgram: WebGLProgram | null = null;
  private bgVao: WebGLVertexArrayObject | null = null;
  
  // Buffers
  private positionBuffer: WebGLBuffer | null = null;
  private scaleBuffer: WebGLBuffer | null = null;
  private rotationBuffer: WebGLBuffer | null = null;
  private opacityBuffer: WebGLBuffer | null = null;
  private colorBuffer: WebGLBuffer | null = null;
  
  // Preallocated scratch buffers for counting sort (avoid GC per frame)
  private sortKeys: Float32Array;
  private sortBucket: Uint16Array;
  private sortBucketAcc: Uint32Array;
  private sortIdx: Uint32Array;

  // Camera
  private cameraDistance = 5.0;
  private cameraAzimuth = Math.PI; // start behind subject
  private cameraElevation = 0.1;  // slight downward tilt
  private targetCenter = [0, 0.95, 0]; // actor center

  // View matrix
  private viewMatrix = new Float32Array(16);
  private eyePos = new Float32Array(3);
  private basisRight = new Float32Array(3); // un-negated right row, for bg shader
  private basisUp = new Float32Array(3);
  private basisFwd = new Float32Array(3);

  // FOV
  private fovDeg = 50;

  // Workplane Y — default sits at world Y=0 (the floor). The renderer can
  // raise it via setWorkplaneY() when the scene's ground is known.
  private _workplaneY = 0;
  // -1 = needs fitting; set to the frame count after a successful fit so we
  // don't re-fit on every render call.
  private _workplaneFitFrame = -1;

  // Supersample
  private ss = 2;
  
  // Splat count
  private splatCount = 0;

  // Gaussian falloff sharpness — MUST be 1.0 or higher.
  // 1.0 = true Gaussian (soft), 4.0 = PlayCanvas/alt preset (sharper).
  // Defaulting to 0 in GLSL makes exp(0)=1, turning every splat into a solid
  // disc that piles up additively — produces opaque white-blob appearance.
  private falk = 1.0;

  // Workplane (XZ grid + axis lines) — visual reference for camera orbit
  // DISABLED to debug camera visibility issue
  private _showWorkplane = false;
  private gridProgram: WebGLProgram | null = null;
  private gridVao: WebGLVertexArrayObject | null = null;
  public get showWorkplane(): boolean { return this._showWorkplane; }
  public setShowWorkplane(v: boolean): void {
    this._showWorkplane = v;
  }

  public setWorkplaneY(y: number): void {
    this._workplaneY = y;
  }

  /**
   * Compute the lowest Y of the loaded splats and use it as the workplane Y,
   * so the grid sits at the scene's "floor". Quantized to a 0.5 grid for
   * cleaner alignment. Must be called with the frame data after uploadFrame.
   */
  public fitWorkplaneToScene(frame?: DecodedFrame): number {
    if (frame && frame.positions && frame.positions.length > 0) {
      const buf = frame.positions;
      const n = buf.length / 3;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const y = buf[i * 3 + 1];
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      const snapped = Math.floor(minY * 2 + 0.5) / 2;
      if (EWA_DEBUG) console.log(`[EwaSplat] fitWorkplaneToScene: n=${n} minY=${minY.toFixed(3)} maxY=${maxY.toFixed(3)} -> snapped=${snapped}`);
      this._workplaneY = snapped;
      return snapped;
    }
    console.warn(`[EwaSplat] fitWorkplaneToScene: no frame data, keeping Y=${this._workplaneY}`);
    return this._workplaneY;
  }

  // Color grading
  public colorGrading: Required<ColorGradingSettings> = {
    exposure: 0,
    temperature: 0,
    tint: 0,
    contrast: 1,
    saturation: 1,
    rGain: 1,
    gGain: 1,
    bGain: 1,
    blackLevel: 0,
    whiteLevel: 1,
  };

  // HDRi settings
  public hdri: Required<HdriSettings> = {
    enabled: false,
    file: "",
    autoExposure: 1,
    yaw: 0,
    radius: 8,
    capH: 3,
    groundY: 0,
    shadowEnabled: false,
    shadowRadius: 40,
  };

  // Y-flip for scenes that have +Y pointing down instead of up (postshot-style exports)
  private _flipY = false;
  public get flipY(): boolean { return this._flipY; }
  public setFlipY(v: boolean): void {
    this._flipY = v;
    this.updateViewMatrix();
  }

  private hdriTexture: WebGLTexture | null = null;
  private shadowTexture: WebGLTexture | null = null;

  // SH
  private restTexture: WebGLTexture | null = null;
  private hasSH = false;

  // FPS
  private lastFrameTime = 0;
  private fps = 0;
  private frameCount = 0;
  
  // Drag state
  private isDragging = false;
  private lastMouseX = 0;
  private lastMouseY = 0;
  
  constructor(options: SplatRendererOptions) {
    this.canvas = options.canvas;
    
    const gl = this.canvas.getContext("webgl2", {
      antialias: true,
      premultipliedAlpha: false,
    });
    
    if (!gl) {
      throw new Error("WebGL2 not supported");
    }
    
    this.gl = gl;
    
    if (options.fovDeg) this.fovDeg = options.fovDeg;
    if (options.supersample) this.ss = options.supersample;
    if (options.falk) this.falk = options.falk;
    if (options.colorGrading) {
      Object.assign(this.colorGrading, options.colorGrading);
    }
    if (options.hdri) {
      Object.assign(this.hdri, options.hdri);
    }

    // Preallocate scratch buffers for counting sort
    this.sortKeys = new Float32Array(65536);
    this.sortBucket = new Uint16Array(65536);
    this.sortBucketAcc = new Uint32Array(NBUCK + 1);
    this.sortIdx = new Uint32Array(65536);

    this.initSplatShader();
    this.initBackgroundShader();
    this.initGridShader();
    this.initBuffers(); // no-op, buffers created in initSplatShader
    this.resize();
    this.initEventListeners();

    window.addEventListener("resize", () => this.resize());
  }
  
  // Placeholder — buffers are allocated inside initSplatShader()
  private initBuffers(): void {
    // Buffers are created in initSplatShader()
  }

  // ═══════════════════════════════════════════════════════
  // SPLAT SHADER — matches Lumigrade VS2 + FS exactly
  // ═══════════════════════════════════════════════════════

  private initSplatShader(): void {
    const vertexShader = `#version 300 es
      precision highp float;
      
      layout(location = 0) in vec2 aCorner;
      layout(location = 1) in vec3 aPosition;
      layout(location = 2) in vec3 aScale;
      layout(location = 3) in vec4 aRotation;
      layout(location = 4) in float aOpacity;
      layout(location = 5) in vec3 aColor;

      uniform mat4 uViewMatrix;
      uniform vec2 uFocal;
      uniform vec2 uViewport;
      uniform float uDil;
      uniform vec2 uPrincipalPoint;
      uniform vec3 uCameraPos;
      
      out vec2 vPx;
      out float vOp;
      out vec3 vCol;
      out vec4 vConic;
      
      void main() {
        vec4 tc = uViewMatrix * vec4(aPosition, 1.0);
        float tz = tc.z;
        
        if (tz < 0.2) {
          gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
          return;
        }
        
        float w = aRotation.x;
        float x = aRotation.y;
        float y = aRotation.z;
        float z = aRotation.w;
        
        mat3 Rq = mat3(
          1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
          2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
          2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y)
        );
        
        mat3 S = mat3(
          aScale.x, 0.0, 0.0,
          0.0, aScale.y, 0.0,
          0.0, 0.0, aScale.z
        );
        
        mat3 M = Rq * S;
        mat3 V3 = mat3(uViewMatrix);
        mat3 VM = V3 * M;
        mat3 cov3 = VM * transpose(VM);
        
        mat3 J = mat3(
          uFocal.x / tz, 0.0, 0.0,
          0.0, uFocal.y / tz, 0.0,
          -uFocal.x * tc.x / (tz * tz), -uFocal.y * tc.y / (tz * tz), 0.0
        );
        
        mat3 c2m = transpose(J) * cov3 * J;
        
        float a0 = c2m[0][0];
        float b2 = c2m[0][1];
        float c0 = c2m[1][1];
        float a = a0 + uDil;
        float c = c0 + uDil;
        float det0 = a0 * c0 - b2 * b2;
        
        float mid = 0.5 * (a + c);
        float discriminant = mid * mid - (a * c - b2 * b2);
        float r = sqrt(max(1e-6, discriminant));
        
        float lam1 = mid + r;
        float lam2 = max(mid - r, 0.1); // PlayCanvas coverage fix: clamp minor eig >= 0.1
        
        vec2 dir;
        if (abs(b2) < 1e-7 && a >= c) {
          dir = vec2(1.0, 0.0);
        } else {
          dir = normalize(vec2(b2, lam1 - a));
        }
        
        lam1 = min(lam1, lam2 * 100.0); // cap major axis: kill needle spikes (aniso <= 10)
        
        float dx = dir.x;
        float dy = dir.y;
        float A2 = lam1 * dx * dx + lam2 * dy * dy;
        float B2 = (lam1 - lam2) * dx * dy;
        float C2 = lam1 * dy * dy + lam2 * dx * dx;
        
        float det = A2 * C2 - B2 * B2;
        if (det <= 0.0) {
          gl_Position = vec4(0.0, 0.0, -1.0, 1.0);
          return;
        }
        
        float comp = sqrt(max(0.0, det0 / det)); // dilation / AA opacity compensation
        
        float radius = ceil(3.0 * sqrt(lam1));
        
        vPx = aCorner * radius;
        vOp = aOpacity * comp;
        vCol = aColor;
        
        vConic = vec4(C2 / det, -B2 / det, A2 / det, 0.0);
        
        vec2 center = vec2(tc.x * uFocal.x / tz, tc.y * uFocal.y / tz);
        vec2 ndc = (center + vPx) / (uViewport * 0.5);
        ndc.y = -ndc.y;
        ndc += uPrincipalPoint;
        
        gl_Position = vec4(ndc, tz / 100.0, 1.0);
      }
    `;
    
    const fragmentShader = `#version 300 es
      precision highp float;
      
      in vec2 vPx;
      in float vOp;
      in vec3 vCol;
      in vec4 vConic;
      
      // Full Lumigrade color grading pipeline
      uniform float uExposure;    // stops
      uniform float uTemperature; // warm/cool shift
      uniform float uTint;        // magenta/green shift
      uniform float uContrast;    // contrast
      uniform float uSaturation;  // saturation
      uniform float uRGain;       // per-channel R gain
      uniform float uGGain;       // per-channel G gain
      uniform float uBGain;       // per-channel B gain
      uniform float uBlackLevel;  // black level
      uniform float uWhiteLevel;  // white level
      uniform vec3 uAmbient;      // AR relight ambient tint
      uniform float uFalk;        // Gaussian falloff sharpness (1.0=soft, 4.0=PlayCanvas/alt preset)
      
      out vec4 fragColor;
      
      vec3 grade(vec3 c) {
        c *= exp2(uExposure);                           // exposure
        c *= vec3(1.0 + uTemperature, 1.0, 1.0 - uTemperature); // temperature
        c *= vec3(1.0 - uTint, 1.0 + uTint, 1.0 - uTint);     // tint
        c *= vec3(uRGain, uGGain, uBGain);              // per-channel gain
        c = (c - uBlackLevel) / max(uWhiteLevel - uBlackLevel, 0.01); // levels
        c = (c - 0.5) * uContrast + 0.5;               // contrast about mid-grey
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); // luminance
        return mix(vec3(l), c, uSaturation);            // saturation
      }
      
      void main() {
        float A = 0.5 * (
          vConic.x * vPx.x * vPx.x +
          2.0 * vConic.y * vPx.x * vPx.y +
          vConic.z * vPx.y * vPx.y
        );
        
        // CRITICAL: uFalk must be set — without it GLSL defaults to 0 and
        // exp(0)=1, making every splat a solid disc that piles up via additive
        // blending (looks like opaque white blobs). Lumigrade uses 1.0 default,
        // 4.0 for the alt preset.
        float alpha = vOp * exp(-uFalk * A);

        if (alpha < 0.0039) { // ~0.39% — early discard
          discard;
        }
        
        vec3 color = grade(vCol) * uAmbient * alpha;
        fragColor = vec4(color, alpha);
      }
    `;
    
    this.splatProgram = this.createProgram(vertexShader, fragmentShader);
    
    // Create VAO
    this.vao = this.gl.createVertexArray();
    this.gl.bindVertexArray(this.vao);
    
    // Quad corners (location 0)
    const quadCorners = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const quadBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, quadBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, quadCorners, this.gl.STATIC_DRAW);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);
    
    // Instance buffers
    this.positionBuffer = this.gl.createBuffer();
    this.scaleBuffer = this.gl.createBuffer();
    this.rotationBuffer = this.gl.createBuffer();
    this.opacityBuffer = this.gl.createBuffer();
    this.colorBuffer = this.gl.createBuffer();
    
    const bindInst = (buf: WebGLBuffer | null, loc: number, size: number) => {
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buf);
      this.gl.enableVertexAttribArray(loc);
      this.gl.vertexAttribPointer(loc, size, this.gl.FLOAT, false, 0, 0);
      this.gl.vertexAttribDivisor(loc, 1);
    };

    bindInst(this.positionBuffer, 1, 3);
    bindInst(this.scaleBuffer, 2, 3);
    bindInst(this.rotationBuffer, 3, 4);
    bindInst(this.opacityBuffer, 4, 1);
    bindInst(this.colorBuffer, 5, 3);

    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);
    this.gl.disable(this.gl.DEPTH_TEST);
    
    this.gl.bindVertexArray(null);
  }

  // ═══════════════════════════════════════════════════════
  // SHADER COMPILATION HELPER
  // ═══════════════════════════════════════════════════════
  
  private createProgram(vsSource: string, fsSource: string): WebGLProgram {
    const gl = this.gl;
    
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      throw new Error("Vertex shader error: " + gl.getShaderInfoLog(vs));
    }
    
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      throw new Error("Fragment shader error: " + gl.getShaderInfoLog(fs));
    }
    
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error("Program link error: " + gl.getProgramInfoLog(program));
    }
    
    return program;
  }
  
  // ═══════════════════════════════════════════════════════
  // BACKGROUND SHADER — HDRi equirect + ground dome + shadow
  // Matches Lumigrade bgProg exactly
  // ═══════════════════════════════════════════════════════

  private initBackgroundShader(): void {
    const bgVertex = `#version 300 es
      precision highp float;
      layout(location = 0) in vec2 aPos;
      out vec2 vUV;
      void main() {
        vUV = aPos * 0.5 + 0.5;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `;

    const bgFragment = `#version 300 es
      precision highp float;

      in vec2 vUV;
      out vec4 fragColor;

      uniform sampler2D uHdriTex;
      uniform sampler2D uShadowTex;
      uniform mat3 uInvR;        // inverse view rotation
      uniform vec3 uCamPos;
      uniform float uAspect;
      uniform float uThf;        // tan(half-fov)
      uniform float uHdrExpo;    // HDRi auto-exposure
      uniform float uYaw;
      uniform float uRadius;
      uniform float uCapH;
      uniform float uGroundY;
      uniform bool uHasShadow;
      uniform bool uHasHdri;     // HDRi texture is available

      // Rotate a 2D vector by yaw angle
      vec2 rot2(vec2 v, float a) {
        float c = cos(a), s = sin(a);
        return vec2(c*v.x - s*v.y, s*v.x + c*v.y);
      }

      void main() {
        // Ray direction from camera through this pixel
        vec2 ndc = vUV * 2.0 - 1.0;
        vec2 dir2 = ndc * vec2(uAspect, 1.0) * uThf;
        vec3 rd = normalize(uInvR * vec3(dir2, -1.0));

        vec3 col;

        if (uHasHdri) {
          // Equirectangular HDRi lookup (rotate by yaw around Y)
          vec2 equiUV = vec2(
            atan(rd.z, rd.x) / (2.0 * 3.14159265) + 0.5 + uYaw / (2.0 * 3.14159265),
            acos(clamp(-rd.y, -1.0, 1.0)) / 3.14159265
          );
          equiUV.x = fract(equiUV.x);
          col = texture(uHdriTex, equiUV).rgb * uHdrExpo;
        } else {
          // Black background when HDRi is disabled
          col = vec3(0.0, 0.0, 0.0);
        }

        // Ground dome projection: ray-plane intersection
        if (rd.y < -0.001) {
          float t = (uGroundY - uCamPos.y) / rd.y;
          if (t > 0.0) {
            vec3 gp = uCamPos + t * rd;
            float gd = length(gp.xz);
            if (gd < uRadius) {
              float edgeFade = 1.0 - smoothstep(uRadius * 0.85, uRadius, gd);
              float shadow = 1.0;
              if (uHasShadow) {
                vec2 sUV = (gp.xz / (uRadius * 2.0)) + 0.5;
                sUV = clamp(sUV, vec2(0.0), vec2(1.0));
                shadow = 1.0 - texture(uShadowTex, sUV).r;
              }
              float domeFade = edgeFade * shadow * max(0.0, -rd.y);
              // Soft contact-shadow tint (don't fully blacken — keeps ground visible)
              vec3 groundCol = uHasHdri
                ? vec3(0.05, 0.05, 0.06)
                : vec3(0.13, 0.13, 0.14);
              col = mix(col, groundCol, domeFade * 0.85);
            }
          }
        }

        fragColor = vec4(col, 1.0);
      }
    `;

    this.bgProgram = this.createProgram(bgVertex, bgFragment);

    // Full-screen quad VAO
    this.bgVao = this.gl.createVertexArray();
    this.gl.bindVertexArray(this.bgVao);

    const quadBuf = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, quadBuf);
    this.gl.bufferData(this.gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      this.gl.STATIC_DRAW);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);

    this.gl.bindVertexArray(null);
  }

  // ═══════════════════════════════════════════════════════
  // GRID SHADER — XZ workplane (grid + axis lines)
  // Drawn as world-space line strips projected through the same view matrix
  // as splats, so it rotates/pans with the camera exactly like 3DModelViewer.
  // ═══════════════════════════════════════════════════════

  private initGridShader(): void {
    const gl = this.gl;

    // Vertex shader: project world-space XZ line endpoints through view matrix.
    // uY = world Y of the plane. uFlipY mirrors the plane vertically when the
    // user toggles Flip-Y, so the reference stays aligned with the splat scene.
    const vsSource = `#version 300 es
      precision highp float;
      layout(location = 0) in vec3 aPos;
      uniform mat4 uViewMatrix;
      uniform float uY;
      void main() {
        vec4 wp = vec4(aPos.x, uY, aPos.z, 1.0);
        gl_Position = uViewMatrix * wp;
      }
    `;

    // Fragment shader: solid color, constant alpha.
    const fsSource = `#version 300 es
      precision highp float;
      uniform vec4 uColor;
      out vec4 fragColor;
      void main() {
        fragColor = uColor;
      }
    `;

    this.gridProgram = this.createProgram(vsSource, fsSource);

    // Build the geometry: a grid (line strips along X and Z) + axis lines.
    // Default extent ±2 with 0.5-unit cells — compact enough to not dominate
    // the scene; resolution high enough to read as a reference. The workplane
    // Y is set per-frame via the uY uniform so it follows the scene origin.
    const halfExtent = 2;
    const cell = 0.5;
    const positions: number[] = [];

    // Grid lines along X (constant Z)
    for (let z = -halfExtent; z <= halfExtent + 1e-6; z += cell) {
      positions.push(-halfExtent, 0, z,  halfExtent, 0, z);
    }
    // Grid lines along Z (constant X)
    for (let x = -halfExtent; x <= halfExtent + 1e-6; x += cell) {
      positions.push(x, 0, -halfExtent,  x, 0, halfExtent);
    }
    // X axis (red): along Z=0
    positions.push(-halfExtent, 0, 0,  halfExtent, 0, 0);
    // Z axis (green): along X=0
    positions.push(0, 0, -halfExtent,  0, 0, halfExtent);

    const vertCount = positions.length / 3;

    this.gridVao = gl.createVertexArray();
    gl.bindVertexArray(this.gridVao);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array(positions),
      gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    // Stash vert count in a custom property
    (this.gridVao as any)._vertCount = vertCount;
  }

  // ═══════════════════════════════════════════════════════
  // DEPTH SORT — counting sort by view-space Z
  // Lumigrade lines 717–724 (bit-exact)
  // ═══════════════════════════════════════════════════════

  private sortSplats(
    positions: Float32Array,
    n: number
  ): Uint32Array {
    let keys = this.sortKeys;
    let bucket = this.sortBucket;
    const bucketAcc = this.sortBucketAcc;
    let idx = this.sortIdx;

    // Ensure scratch buffers are large enough
    if (keys.length < n) {
      this.sortKeys = keys = new Float32Array(n);
      this.sortBucket = bucket = new Uint16Array(n);
      this.sortIdx = idx = new Uint32Array(n);
    }

    // 1. Compute view-space depth: view[2]*x + view[6]*y + view[10]*z
    const vm = this.viewMatrix;
    for (let i = 0; i < n; i++) {
      keys[i] = vm[2] * positions[i * 3]
              + vm[6] * positions[i * 3 + 1]
              + vm[10] * positions[i * 3 + 2];
    }

    // 2. Find depth range for bucket scaling
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = keys[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }

    // 3. Bucket each splat (NB-1 - bucket → back-to-front order)
    const sc = (NBUCK - 1) / Math.max(1e-9, mx - mn);
    bucketAcc.fill(0);

    for (let i = 0; i < n; i++) {
      const bI = NBUCK - 1 - (((keys[i] - mn) * sc) | 0);
      bucket[i] = bI;
      bucketAcc[bI + 1]++;
    }

    // 4. Prefix sum → bucket start offsets
    for (let b = 0; b < NBUCK; b++) {
      bucketAcc[b + 1] += bucketAcc[b];
    }

    // 5. Write sorted indices
    for (let i = 0; i < n; i++) {
      idx[bucketAcc[bucket[i]]++] = i;
    }

    return idx;
  }

  private reorderFloatArray(arr: Float32Array, order: Uint32Array, n: number, stride: number): void {
    const tmp = new Float32Array(n * stride);
    for (let i = 0; i < n; i++) {
      const si = order[i] * stride;
      const di = i * stride;
      for (let k = 0; k < stride; k++) {
        tmp[di + k] = arr[si + k];
      }
    }
    arr.set(tmp);
  }

  private reorderPositions(positions: Float32Array, order: Uint32Array, n: number): void {
    this.reorderFloatArray(positions, order, n, 3);
  }

  private reorderScales(scales: Float32Array, order: Uint32Array, n: number): void {
    this.reorderFloatArray(scales, order, n, 3);
  }

  private reorderRotations(rotations: Float32Array, order: Uint32Array, n: number): void {
    this.reorderFloatArray(rotations, order, n, 4);
  }

  private reorderOpacities(opacities: Float32Array, order: Uint32Array, n: number): void {
    const tmp = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      tmp[i] = opacities[order[i]];
    }
    opacities.set(tmp);
  }

  private reorderColors(colors: Float32Array, order: Uint32Array, n: number): void {
    this.reorderFloatArray(colors, order, n, 3);
  }

  // ═══════════════════════════════════════════════════════
  // HDRi TEXTURE UPLOAD
  // ═══════════════════════════════════════════════════════

  public async loadHdri(fileUrl: string): Promise<void> {
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = fileUrl;

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to load HDRi image"));
      });

      const gl = this.gl;

      // Upload as 2D texture
      if (!this.hdriTexture) {
        this.hdriTexture = gl.createTexture();
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.hdriTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      this.hdri.enabled = true;
      this.hdri.file = fileUrl;
      this.hdri.autoExposure = 1.0;

      dbg("[EwaSplatRenderer] HDRi loaded:", fileUrl);
    } catch (e) {
      console.warn("[EwaSplatRenderer] HDRi unavailable, using procedural sky:", e);
      this.hdri.enabled = false;
      // Keep the background program available for procedural sky fallback
      // (the bg shader will paint a soft sky gradient instead of the HDRi equirect)
    }
  }

  // ═══════════════════════════════════════════════════════
  // CONTACT SHADOW — top-down opacity footprint
  // ═══════════════════════════════════════════════════════

  public generateContactShadow(
    positions: Float32Array,
    n: number,
    radius: number = 40,
    groundY: number = 0
  ): void {
    const gl = this.gl;
    const sz = radius * 2;

    // Rasterize top-down opacity footprint into a grid
    const shadowData = new Uint8Array(sz * sz);

    // Find bounding box of splats near ground
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    const threshold = 0.5; // splats within 0.5m of groundY

    for (let i = 0; i < n; i++) {
      const py = positions[i * 3 + 1];
      if (Math.abs(py - groundY) < threshold) {
        const px = positions[i * 3];
        const pz = positions[i * 3 + 2];
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (pz < minZ) minZ = pz;
        if (pz > maxZ) maxZ = pz;
      }
    }

    const rangeX = Math.max(maxX - minX, 0.1);
    const rangeZ = Math.max(maxZ - minZ, 0.1);
    const padX = rangeX * 0.2;
    const padZ = rangeZ * 0.2;
    minX -= padX; maxX += padX;
    minZ -= padZ; maxZ += padZ;

    const worldToTex = (wx: number, wz: number) => {
      return [(wx - minX) / (maxX - minX), (wz - minZ) / (maxZ - minZ)];
    };

    // Simple rasterization: for each pixel, find nearest splat above it
    const gsx = (maxX - minX) / sz;
    const gsz = (maxZ - minZ) / sz;

    for (let gy = 0; gy < sz; gy++) {
      for (let gx = 0; gx < sz; gx++) {
        const wx = minX + (gx + 0.5) * gsx;
        const wz = minZ + (gy + 0.5) * gsz;

        let maxOpacity = 0;
        for (let i = 0; i < n; i++) {
          const px = positions[i * 3];
          const pz = positions[i * 3 + 2];
          const dist2 = (wx - px) * (wx - px) + (wz - pz) * (wz - pz);
          // Gaussian footprint, sigma ~ 0.1m
          const contrib = Math.exp(-dist2 / (2 * 0.1 * 0.1));
          if (contrib > maxOpacity) maxOpacity = contrib;
        }
        shadowData[gy * sz + gx] = Math.min(255, maxOpacity * 255) | 0;
      }
    }

    // Separable box blur (2-pass)
    const blurred = new Uint8Array(sz * sz);
    const blurR = 3;
    const blurW = blurR * 2 + 1;
    const blurKernel = new Float32Array(blurW * blurW);
    // Gaussian-like kernel
    for (let ky = -blurR; ky <= blurR; ky++) {
      for (let kx = -blurR; kx <= blurR; kx++) {
        const v = Math.exp(-(kx * kx + ky * ky) / (2 * 2 * 2));
        blurKernel[(ky + blurR) * blurW + (kx + blurR)] = v;
      }
    }
    const blurSum = blurKernel.reduce((a, b) => a + b, 0);

    // Horizontal pass
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        let sum = 0;
        for (let kx = -blurR; kx <= blurR; kx++) {
          const sx = Math.min(Math.max(x + kx, 0), sz - 1);
          sum += shadowData[y * sz + sx] * blurKernel[(kx + blurR)];
        }
        blurred[y * sz + x] = Math.min(255, (sum / blurSum) * 1.0) | 0;
      }
    }

    // Vertical pass
    const finalShadow = new Uint8Array(sz * sz);
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        let sum = 0;
        for (let ky = -blurR; ky <= blurR; ky++) {
          const sy = Math.min(Math.max(y + ky, 0), sz - 1);
          sum += blurred[sy * sz + x] * blurKernel[(ky + blurR)];
        }
        finalShadow[y * sz + x] = Math.min(255, (sum / blurSum) * 0.7) | 0;
      }
    }

    // Upload shadow texture
    if (!this.shadowTexture) {
      this.shadowTexture = gl.createTexture();
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, sz, sz, 0, gl.RED, gl.UNSIGNED_BYTE, finalShadow);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.hdri.shadowEnabled = true;
    this.hdri.shadowRadius = sz;
    dbg(`[EwaSplatRenderer] Contact shadow generated: ${sz}x${sz}`);
  }

  // ═══════════════════════════════════════════════════════
  // FRAME UPLOAD
  // ═══════════════════════════════════════════════════════

  // Track whether SH/shadow have been initialized (once per file)
  private shInitialized = false;
  private shadowInitialized = false;

  public uploadFrame(frame: DecodedFrame | null): void {
    if (!frame) return;

    const n = frame.positions.length / 3;
    this.splatCount = n;
    // New data → re-fit workplane on next render
    this._workplaneFitFrame = -1;

    // ── One-time SH texture upload (file has SH data) ─────
    if (!this.shInitialized && frame.rest && frame.rest.length > 0) {
      this.uploadRestTexture(frame.rest);
      this.shInitialized = true;
    }

    // ── One-time contact shadow generation ──────────────────
    if (!this.shadowInitialized && this.hdri.shadowEnabled) {
      this.generateContactShadow(frame.positions, n, this.hdri.shadowRadius, this.hdri.groundY);
      this.shadowInitialized = true;
    }

    // ── Depth sort by view-space Z ──────────────────────────
    const order = this.sortSplats(frame.positions, n);

    // ── Reorder all attribute buffers back-to-front ─────────
    this.reorderPositions(frame.positions, order, n);
    this.reorderScales(frame.scales, order, n);
    this.reorderRotations(frame.rotations, order, n);
    this.reorderOpacities(frame.opacities, order, n);
    this.reorderColors(frame.colors, order, n);

    // ── Upload sorted buffers ───────────────────────────────
    const gl = this.gl;

    const upload = (buf: WebGLBuffer | null, data: Float32Array | Uint8Array) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    };

    upload(this.positionBuffer, frame.positions);
    upload(this.scaleBuffer, frame.scales);
    upload(this.rotationBuffer, frame.rotations);
    upload(this.opacityBuffer, frame.opacities);
    upload(this.colorBuffer, frame.colors);
  }

  /**
   * Reset initialization flags when loading a new file.
   */
  public reset(): void {
    this.shInitialized = false;
    this.shadowInitialized = false;
    this.splatCount = 0;
    this.hasSH = false;
  }

  private uploadRestTexture(rest: Float32Array): void {
    const gl = this.gl;
    if (!this.restTexture) {
      this.restTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.restTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.restTexture);
    }

    // Pack: width = ceil(45/4)*4 = 48, height = ceil(nG / (width/4))
    // Or simpler: use width=16384 max, height=ceil(n*45/16384)
    // Since WebGL max texture size varies, let's use 1D approach:
    // Actually use the nG as height, but width=45 → width=8192, height=ceil(n*45/8192)
    const n = rest.length / 45;
    const maxW = gl.getParameter(gl.MAX_TEXTURE_SIZE); // ~16384
    const width = Math.min(8192, maxW);
    const height = Math.ceil(n * 45 / width);

    if (height <= gl.getParameter(gl.MAX_TEXTURE_SIZE)) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, width, height, 0, gl.RGB, gl.FLOAT, rest);
      this.hasSH = true;
    } else {
      console.warn("[EwaSplatRenderer] SH texture too large, disabling SH");
      this.hasSH = false;
    }
  }

  // ═══════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════

  public render(): void {
    const gl = this.gl;
    const now = performance.now();

    this.frameCount++;
    if (now - this.lastFrameTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFrameTime = now;
    }

    this.resize();
    this.updateViewMatrix();

    // Clear
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.splatCount === 0) return;

    // ── Draw background (HDRi or procedural sky) ───────────
    if (this.bgProgram) {
      gl.disable(gl.BLEND);
      gl.useProgram(this.bgProgram);
      gl.bindVertexArray(this.bgVao);

      gl.uniform1i(gl.getUniformLocation(this.bgProgram, "uHasHdri"),
        this.hdri.enabled && this.hdriTexture ? 1 : 0);

      if (this.hdri.enabled && this.hdriTexture) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.hdriTexture);
        gl.uniform1i(gl.getUniformLocation(this.bgProgram, "uHdriTex"), 0);
      }

      if (this.shadowTexture && this.hdri.shadowEnabled) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
        gl.uniform1i(gl.getUniformLocation(this.bgProgram, "uShadowTex"), 2);
        gl.uniform1i(gl.getUniformLocation(this.bgProgram, "uHasShadow"), 1);
      } else {
        gl.uniform1i(gl.getUniformLocation(this.bgProgram, "uHasShadow"), 0);
      }

      // inverse view rotation (orthonormal). Lumigrade passes [rx, up, fwd]
      // as 3 row vectors (player/index.html L746). We use the un-negated
      // basis (basisRight) — the negation only applies to the splat path.
      const invR = new Float32Array([
        this.basisRight[0], this.basisRight[1], this.basisRight[2],
        this.basisUp[0],    this.basisUp[1],    this.basisUp[2],
        this.basisFwd[0],   this.basisFwd[1],   this.basisFwd[2],
      ]);
      gl.uniformMatrix3fv(gl.getUniformLocation(this.bgProgram, "uInvR"), false, invR);
      gl.uniform3fv(gl.getUniformLocation(this.bgProgram, "uCamPos"), this.eyePos);
      gl.uniform1f(gl.getUniformLocation(this.bgProgram, "uAspect"),
        this.canvas.width / this.canvas.height);
      gl.uniform1f(gl.getUniformLocation(this.bgProgram, "uThf"),
        Math.tan((this.fovDeg * Math.PI / 180) * 0.5));
      gl.uniform1f(gl.getUniformLocation(this.bgProgram, "uHdrExpo"), this.hdri.autoExposure);
      gl.uniform1f(gl.getUniformLocation(this.bgProgram, "uYaw"), this.hdri.yaw);
      gl.uniform1f(gl.getUniformLocation(this.bgProgram, "uRadius"), this.hdri.radius);
      gl.uniform1f(gl.getUniformLocation(this.bgProgram, "uCapH"), this.hdri.capH);
      gl.uniform1f(gl.getUniformLocation(this.bgProgram, "uGroundY"), this.hdri.groundY);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
      gl.enable(gl.BLEND);
    }

    // ── Draw workplane (XZ grid + axis lines) ─────────────
    // Lazy-fit the workplane Y from splat positions once, on the first frame
    // we actually have data. Read the GPU buffer back is expensive, so we
    // remember the cache and only re-check if the count grows.
    if (this._showWorkplane && this.gridProgram && this.gridVao) {
      if (this._workplaneY === 0 && this.splatCount > 0 && this.positionBuffer && this._workplaneFitFrame < 0) {
        this._workplaneFitFrame = 0;
        const buf = new Float32Array(this.splatCount * 3);
        (this.gl as WebGL2RenderingContext).bindBuffer(
          (this.gl as WebGL2RenderingContext).ARRAY_BUFFER,
          this.positionBuffer,
        );
        (this.gl as WebGL2RenderingContext).getBufferSubData(
          (this.gl as WebGL2RenderingContext).ARRAY_BUFFER,
          0,
          buf,
        );
        let minY = Infinity;
        for (let i = 0; i < this.splatCount; i++) {
          const y = buf[i * 3 + 1];
          if (y < minY) minY = y;
        }
        if (isFinite(minY)) {
          this._workplaneY = Math.floor(minY * 2 + 0.5) / 2;
          console.warn(`[EwaSplat] Render-loop auto-fit: minY=${minY.toFixed(3)} -> wpY=${this._workplaneY}`);
        }
      }

      // Workplane should be readable but not block splats. Disable depth
      // writes (so it never occludes gaussians), and use LEQUAL so it sits
      // *under* any splat that happens to share its Y.
      gl.depthMask(false);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);

      gl.useProgram(this.gridProgram);
      gl.bindVertexArray(this.gridVao);

      const ul = (name: string) => gl.getUniformLocation(this.gridProgram!, name);

      gl.uniformMatrix4fv(ul("uViewMatrix"), false, this.viewMatrix);
      gl.uniform1f(ul("uY"), this._workplaneY);

      // Grid passes: light gray, low alpha so they read as reference, not foreground.
      gl.uniform4f(ul("uColor"), 0.7, 0.7, 0.7, 0.18);

      const totalVerts = (this.gridVao as any)._vertCount as number;
      const axisStart = totalVerts - 4;
      gl.drawArrays(gl.LINES, 0, axisStart);

      // Axis lines: X = red, Z = green
      gl.uniform4f(ul("uColor"), 1.0, 0.25, 0.25, 0.85);
      gl.drawArrays(gl.LINES, axisStart, 2);
      gl.uniform4f(ul("uColor"), 0.25, 1.0, 0.25, 0.85);
      gl.drawArrays(gl.LINES, axisStart + 2, 2);

      gl.bindVertexArray(null);

      // Restore depth state for splat pass.
      gl.depthMask(true);
      gl.depthFunc(gl.LESS);
    }

    // ── Draw splats ───────────────────────────────────────
    gl.useProgram(this.splatProgram);
    gl.bindVertexArray(this.vao);

    const focal = [
      this.focalLengthPx(),
      this.focalLengthPx(),
    ];

    const ul = (name: string) => gl.getUniformLocation(this.splatProgram!, name);

    gl.uniformMatrix4fv(ul("uViewMatrix"), false, this.viewMatrix);
    gl.uniform2fv(ul("uFocal"), focal);
    gl.uniform2f(ul("uViewport"), this.canvas.width, this.canvas.height);
    gl.uniform1f(ul("uDil"), 0.3);
    gl.uniform2f(ul("uPrincipalPoint"), 0.0, 0.0);
    gl.uniform1f(ul("uFalk"), this.falk);

    const cg = this.colorGrading;
    gl.uniform1f(ul("uExposure"), cg.exposure);
    gl.uniform1f(ul("uTemperature"), cg.temperature);
    gl.uniform1f(ul("uTint"), cg.tint);
    gl.uniform1f(ul("uContrast"), cg.contrast);
    gl.uniform1f(ul("uSaturation"), cg.saturation);
    gl.uniform1f(ul("uRGain"), cg.rGain);
    gl.uniform1f(ul("uGGain"), cg.gGain);
    gl.uniform1f(ul("uBGain"), cg.bGain);
    gl.uniform1f(ul("uBlackLevel"), cg.blackLevel);
    gl.uniform1f(ul("uWhiteLevel"), cg.whiteLevel);
    gl.uniform3f(ul("uAmbient"), 1.0, 1.0, 1.0);

    gl.uniform3fv(ul("uCameraPos"), this.eyePos);

    gl.uniform1i(ul("uHasSH"), this.hasSH ? 1 : 0);
    if (this.restTexture && this.hasSH) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.restTexture);
      gl.uniform1i(ul("uRestTex"), 1);
    }

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.splatCount);

    gl.bindVertexArray(null);
  }

  private focalLengthPx(): number {
    // Lumigrade: f = canvas.height / (2 * tan(fov/2))
    // Derived from: tan(fov_y/2) = (canvas.height/2) / f
    // → f = canvas.height / (2 * tan(fov/2))
    return this.canvas.height / (2 * Math.tan((this.fovDeg * Math.PI / 180) * 0.5));
  }

  // ═══════════════════════════════════════════════════════
  // VIEW MATRIX — Lumigrade lines 596–604, 711–715
  // Camera position: azimuth, elevation, distance
  // Target center
  // Screen-X negation for right-handed image
  // ═══════════════════════════════════════════════════════

  private updateViewMatrix(): void {
    const x = this.cameraDistance * Math.cos(this.cameraElevation) * Math.sin(this.cameraAzimuth);
    const y = this.cameraDistance * Math.sin(this.cameraElevation);
    const z = this.cameraDistance * Math.cos(this.cameraElevation) * Math.cos(this.cameraAzimuth);

    this.eyePos[0] = x + this.targetCenter[0];
    this.eyePos[1] = y + this.targetCenter[1];
    this.eyePos[2] = z + this.targetCenter[2];

    const camPos = this.eyePos;

    // ══════════════════════════════════════════════════════════════════════
    // LINE-BY-LINE PORT FROM Lumigrade player/index.html L706-L715
    // Verbatim — NO creative reinterpretation. The 3D orbit camera block is
    // exactly the basis the original player uses (it pre-dates the AR/XR
    // path which uses a different view). Their comment "rx = worldUp×fwd was
    // left-handed" is misleading: that vector IS the conventional right axis
    // for a y-up world. The negation in viewMatrix row 0 is what gives the
    // un-mirrored image (matches cached-data conventions from encode_v2 TX=z180).
    // ══════════════════════════════════════════════════════════════════════
    // L706-L707:  eye = tgt + dist * (cosE*sin(az), sinE, cosE*cos(az))
    // L708:       fwd = (tgt - eye) / dist
    const dist = this.cameraDistance;
    const fwd: [number, number, number] = [
      (this.targetCenter[0] - camPos[0]) / dist,
      (this.targetCenter[1] - camPos[1]) / dist,
      (this.targetCenter[2] - camPos[2]) / dist,
    ];

    // L709:  rx = [fwd.z, 0, -fwd.x];  then normalized
    const rx: [number, number, number] = [fwd[2], 0, -fwd[0]];
    const rl = Math.sqrt(rx[0] * rx[0] + rx[1] * rx[1] + rx[2] * rx[2]) || 1;
    rx[0] /= rl; rx[1] /= rl; rx[2] /= rl;

    // L710:  up = rx × fwd
    const up: [number, number, number] = [
      rx[1] * fwd[2] - rx[2] * fwd[1],
      rx[2] * fwd[0] - rx[0] * fwd[2],
      rx[0] * fwd[1] - rx[1] * fwd[0],
    ];

    // Stash for the background shader's uInvR (Lumigrade passes [rx,up,fwd]
    // row-major; the negation only applies to the splat path's view matrix).
    // Flip Y does NOT touch the HDRI/ground — HDRI stays anchored to the world.
    this.basisRight[0] = rx[0]; this.basisRight[1] = rx[1]; this.basisRight[2] = rx[2];
    this.basisUp[0]    = up[0]; this.basisUp[1]    = up[1]; this.basisUp[2]    = up[2];
    this.basisFwd[0]   = fwd[0]; this.basisFwd[1]  = fwd[1]; this.basisFwd[2]  = fwd[2];

    // L714-L715:  view = column-major [ rx | -up | -fwd | t ]
    //              where t = [ -rx·eye, up·eye, fwd·eye ]
    // Y-flip: negate y-component of basis rows AND translation Y, plus
    // also negate camera Y so we orbit around the inverted up vector.
    const fy = this._flipY ? -1 : 1;
    this.viewMatrix[0]  = rx[0];
    this.viewMatrix[1]  = rx[1] * fy;
    this.viewMatrix[2]  = rx[2];
    this.viewMatrix[3]  = 0;

    this.viewMatrix[4]  = -up[0];
    this.viewMatrix[5]  = -up[1] * fy;
    this.viewMatrix[6]  = -up[2];
    this.viewMatrix[7]  = 0;

    this.viewMatrix[8]  = -fwd[0];
    this.viewMatrix[9]  = -fwd[1] * fy;
    this.viewMatrix[10] = -fwd[2];
    this.viewMatrix[11] = 0;

    // Translation: negate rx component only; negate Y when flipped.
    this.viewMatrix[12] = -(rx[0] * camPos[0] + rx[1] * camPos[1] + rx[2] * camPos[2]);
    this.viewMatrix[13] = (up[0] * camPos[0] + up[1] * camPos[1] + up[2] * camPos[2]) * fy;
    this.viewMatrix[14] = -(fwd[0] * camPos[0] + fwd[1] * camPos[1] + fwd[2] * camPos[2]);
    this.viewMatrix[15] = 1;
  }

  // ═══════════════════════════════════════════════════════
  // RESIZE + SUPERSAMPLE
  // ═══════════════════════════════════════════════════════

  public resize(): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const ss = Math.max(this.ss, dpr); // at least ss-level
    const width = Math.round(this.canvas.clientWidth * ss);
    const height = Math.round(this.canvas.clientHeight * ss);

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.gl.viewport(0, 0, width, height);
    }
  }

  // ═══════════════════════════════════════════════════════
  // EVENT LISTENERS
  // ═══════════════════════════════════════════════════════
  
  private initEventListeners(): void {
    // Keyboard toggle for workplane visibility — useful when debugging
    // whether the scene origin lines up with the model's footprint.
    window.addEventListener("keydown", (e) => {
      if (e.key === "g" || e.key === "G") {
        this._showWorkplane = !this._showWorkplane;
      }
    });

    // Left click = rotate, Right click = pan
    this.canvas.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.isDragging = true;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      // Store which mouse button: 0=left, 2=right
      (this as any)._dragButton = e.button;
    });
    
    // Prevent context menu on right-click
    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
    });
    
    window.addEventListener("mouseup", () => {
      this.isDragging = false;
      (this as any)._dragButton = undefined;
    });
    
    window.addEventListener("mousemove", (e) => {
      if (!this.isDragging) return;
      
      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;
      const dragButton = (this as any)._dragButton;
      
      if (dragButton === 2) {
        // Right click = pan (move camera target)
        const panSpeed = 0.002 * this.cameraDistance;
        this.targetCenter[0] -= dx * panSpeed;
        this.targetCenter[1] += dy * panSpeed;
      } else {
        // Left click = rotate
        this.cameraAzimuth -= dx * 0.005;
        this.cameraElevation -= dy * 0.005;
        // Clamp elevation to prevent flipping
        this.cameraElevation = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this.cameraElevation));
      }
      
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    });
    
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.cameraDistance *= 1 + e.deltaY * 0.001;
      this.cameraDistance = Math.max(0.5, Math.min(100, this.cameraDistance));
    });
    
    let lastTouchDist = 0;
    
    this.canvas.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) {
        this.isDragging = true;
        this.lastMouseX = e.touches[0].clientX;
        this.lastMouseY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastTouchDist = Math.sqrt(dx * dx + dy * dy);
      }
    });
    
    this.canvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      
      if (e.touches.length === 1 && this.isDragging) {
        const dx = e.touches[0].clientX - this.lastMouseX;
        const dy = e.touches[0].clientY - this.lastMouseY;
        
        this.cameraAzimuth -= dx * 0.005;
        this.cameraElevation -= dy * 0.005;
        this.cameraElevation = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this.cameraElevation));
        
        this.lastMouseX = e.touches[0].clientX;
        this.lastMouseY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (lastTouchDist > 0) {
          this.cameraDistance *= lastTouchDist / dist;
          this.cameraDistance = Math.max(0.5, Math.min(100, this.cameraDistance));
        }
        
        lastTouchDist = dist;
      }
    });
    
    this.canvas.addEventListener("touchend", () => {
      this.isDragging = false;
      lastTouchDist = 0;
    });
  }
  
  // ═══════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════

  public setCenter(x: number, y: number, z: number): void {
    this.targetCenter = [x, y, z];
  }

  public setFalk(f: number): void {
    this.falk = f;
  }

  public setCameraAzimuthEl(az: number, el: number): void {
    this.cameraAzimuth = az;
    this.cameraElevation = el;
  }

  public setCameraDistance(d: number): void {
    this.cameraDistance = d;
  }

  public getCameraDistance(): number {
    return this.cameraDistance;
  }

  public getCameraAzimuth(): number {
    return this.cameraAzimuth;
  }

  public getCameraElevation(): number {
    return this.cameraElevation;
  }

  public setFov(deg: number): void {
    this.fovDeg = deg;
  }

  public setSupersample(ss: number): void {
    this.ss = ss;
    this.resize();
  }

  public setColorGrading(cg: Partial<ColorGradingSettings>): void {
    Object.assign(this.colorGrading, cg);
  }

  public setHdriEnabled(enabled: boolean): void {
    this.hdri.enabled = enabled;
  }

  public setHdri(settings: Partial<HdriSettings>): void {
    Object.assign(this.hdri, settings);
  }
  
  public getFps(): number {
    return this.fps;
  }
  
  public getSplatCount(): number {
    return this.splatCount;
  }

  public setSplatCount(n: number): void {
    this.splatCount = n;
  }
  
  public dispose(): void {
    const gl = this.gl;

    if (this.splatProgram) gl.deleteProgram(this.splatProgram);
    if (this.bgProgram) gl.deleteProgram(this.bgProgram);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.bgVao) gl.deleteVertexArray(this.bgVao);

    const deleteBuffer = (b: WebGLBuffer | null) => { if (b) gl.deleteBuffer(b); };
    deleteBuffer(this.positionBuffer);
    deleteBuffer(this.scaleBuffer);
    deleteBuffer(this.rotationBuffer);
    deleteBuffer(this.opacityBuffer);
    deleteBuffer(this.colorBuffer);

    const deleteTex = (t: WebGLTexture | null) => { if (t) gl.deleteTexture(t); };
    deleteTex(this.restTexture);
    deleteTex(this.hdriTexture);
    deleteTex(this.shadowTexture);

    if (this.gridProgram) gl.deleteProgram(this.gridProgram);
    if (this.gridVao) gl.deleteVertexArray(this.gridVao);
  }
}
