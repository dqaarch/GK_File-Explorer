/**
 * EXRWorkerLutRenderer — uses up to N Web Workers for parallel CPU
 * OCIO LUT lookup. Faster than EXRCpuLutRenderer for big frames on
 * machines with multiple cores; falls back gracefully if Workers
 * aren't available (caller should detect and use EXRCpuLutRenderer
 * instead).
 *
 * The renderer owns the source pixel buffer from `loadFrame` and sends
 * it to the workers by transferring the underlying ArrayBuffer.
 *
 * Phase 6: also accepts Uint16Array (raw half-precision bits). The
 * workers' LUT pipeline operates on Float32, so when F16 input is
 * supplied we expand inline before transferring. Worker fan-out is
 * preserved (chunking is by pixel index, not buffer type).
 */

import type { LutWorkerInput, LutWorkerOutput } from "./lutWorker";

export interface WorkerLutRendererInit {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Number of worker threads (default 4 — matches the plan). */
  workerCount?: number;
}

export class EXRWorkerLutRenderer {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private workers: Worker[] = [];
  private lut: Float32Array | null = null;
  private lutSize = 0;
  private exposure = 1.0;
  private invGamma = 1 / 2.2;
  private linearPassthrough = false;
  private lutIncludesSrgbOetf = false;
  /** Mirror of `EXRCpuLutRenderer.lutInputMax`. Currently the worker
   * path operates in the [0,1] LUT domain internally, but we still
   * accept the setter so the GPU and worker paths share an interface. */
  private lutInputMax = 1.0;
  private currentWidth = 0;
  private currentHeight = 0;
  /** Holds the latest frame; render() reads from here without copying. */
  private currentFrame: Float32Array | null = null;

  constructor(init: WorkerLutRendererInit) {
    this.canvas = init.canvas;
    const ctx = init.canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) throw new Error("Canvas 2D not available");
    this.ctx = ctx;

    const count = Math.max(1, init.workerCount ?? 4);
    for (let i = 0; i < count; i++) {
      try {
        const w = new Worker(
          new URL("./lutWorker.ts", import.meta.url),
          { type: "module" },
        );
        this.workers.push(w);
      } catch {
        // Skip — final fallback check below.
      }
    }
    if (this.workers.length === 0) {
      throw new Error("No Web Workers available");
    }
  }

  setLut(lutData: Float32Array, size: number): void {
    if (lutData.length !== size * size * size * 3) {
      throw new Error("LUT length mismatch");
    }
    this.lut = lutData;
    this.lutSize = size;
  }

  loadFrame(
    pixels: Float32Array | Uint16Array,
    width: number,
    height: number,
    isHalfFloat: boolean = false,
  ): void {
    if (isHalfFloat && pixels instanceof Uint16Array) {
      // Expand half→float for the CPU worker pipeline. Same as the
      // EXRCpuLutRenderer fallback: the worker LUT is f32, so we must
      // widen before transferring.
      const half = pixels;
      const out = new Float32Array(half.length);
      const buf = new ArrayBuffer(4);
      const fv = new Float32Array(buf);
      const iv = new Uint32Array(buf);
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
      this.currentFrame = out;
    } else {
      this.currentFrame = pixels as Float32Array;
    }
    this.currentWidth = width;
    this.currentHeight = height;
  }

  setExposure(stops: number): void {
    this.exposure = Math.max(0.001, stops);
  }

  setGamma(gamma: number): void {
    this.invGamma = 1 / Math.max(0.1, gamma);
  }

  setAutoExposure(_divisor: number): void {}

  setLinearPassthrough(use: boolean): void {
    this.linearPassthrough = use;
  }
  setLutBakedSrgbOetf(baked: boolean): void {
    this.lutIncludesSrgbOetf = baked;
  }
  setLutInputMax(maxIn: number): void {
    // Worker renderer still uses the [0,1] LUT domain on the worker side
    // (worker code mirrors the single-thread CPU renderer). Storing it
    // here lets a future worker-side update pick it up without an
    // interface change.
    this.lutInputMax = Math.max(0.001, maxIn);
    void this.lutInputMax;
  }
  setNeedsBgrSwap(_swap: boolean): void {}
  setBypassOcio(_bypass: boolean): void {}
  setPassMode(_mode: 0 | 1 | 2 | 3 | 4): void {}

  /** Heavy CPU work — produces final ImageData and blits to the canvas. */
  async render(): Promise<void> {
    if (!this.lut) throw new Error("render() before setLut");
    const { currentWidth: w, currentHeight: h, currentFrame } = this;
    if (!w || !h || !currentFrame) {
      throw new Error("render() before loadFrame");
    }

    // Take a copy so the caller can keep their original buffer — we are
    // about to transfer it to a worker and the buffer becomes detached.
    const frameCopy = new Float32Array(currentFrame);

    const strips = this.workers.length;
    const rowsPerStrip = Math.ceil(h / strips);
    const completed: Map<number, Uint8ClampedArray> = new Map();

    await new Promise<void>((resolve) => {
      let remaining = 0;
      let started = 0;
      for (let s = 0; s < strips; s++) {
        const id = s;
        const rowStart = s * rowsPerStrip;
        const rowEnd = Math.min(rowStart + rowsPerStrip, h);
        if (rowStart >= rowEnd) continue;
        remaining++;
        started++;
        const worker = this.workers[s % this.workers.length];
        const msg: LutWorkerInput = {
          id,
          rgbaF32: frameCopy,
          width: w,
          height: h,
          rowStart,
          rowEnd,
          lut: this.lut!,
          lutSize: this.lutSize,
          exposure: this.exposure,
          invGamma: this.invGamma,
          linearPassthrough: this.linearPassthrough,
          lutIncludesSrgbOetf: this.lutIncludesSrgbOetf,
        };
        const handler = (ev: MessageEvent<LutWorkerOutput>) => {
          if (ev.data.id !== id) return;
          worker.removeEventListener("message", handler);
          completed.set(id, ev.data.rgba);
          remaining--;
          if (remaining === 0) resolve();
        };
        worker.addEventListener("message", handler);
        worker.postMessage(msg, [msg.rgbaF32.buffer]);
      }
      if (started === 0) resolve();
    });

    const finalBuf = new Uint8ClampedArray(w * h * 4);
    for (let s = 0; s < strips; s++) {
      const id = s;
      const strip = completed.get(id);
      if (!strip) continue;
      const rowStart = s * rowsPerStrip;
      finalBuf.set(strip, rowStart * w * 4);
    }

    if ("width" in this.canvas) {
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
    }
    const imageData = new ImageData(finalBuf, w, h);
    this.ctx.putImageData(imageData, 0, 0);
  }

  resize(width: number, height: number): void {
    if ("width" in this.canvas) {
      this.canvas.width = Math.max(1, width);
      this.canvas.height = Math.max(1, height);
    }
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.lut = null;
    this.currentFrame = null;
  }
}