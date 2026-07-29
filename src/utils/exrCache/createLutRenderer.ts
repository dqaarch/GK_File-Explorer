/**
 * Renderer factory — picks the best available OCIO LUT pipeline.
 *
 * Priority (matches PLAN_GPU_EXR_RENDERER.md §2.2):
 *   1. GPU (WebGL2 + EXT_color_buffer_float) — happy path
 *   2. CPU single thread — WebGL2 unavailable
 *   3. CPU 4-worker parallel — single-thread too slow (only if Workers exist)
 *   4. Caller falls back to legacy decodeExr / Python path
 */

import { EXRGpuRenderer, canUseGpu } from "./EXRGpuRenderer";
import { EXRCpuLutRenderer } from "./EXRCpuLutRenderer";
import { EXRWorkerLutRenderer } from "./EXRWorkerLutRenderer";

export type RendererKind = "gpu" | "cpu-workers" | "cpu-single";

export interface RendererInit {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** User override. "auto" picks the best available. */
  preference?: "auto" | "gpu" | "cpu";
  /** Number of CPU workers to use in the workers path (default 4). */
  workerCount?: number;
}

export type AnyLutRenderer = {
  setLut(lutData: Float32Array, size: number): void;
  /**
   * Phase 6: loadFrame accepts either Float32Array (legacy) or Uint16Array
   * of raw half-precision IEEE 754 bits. The `isHalfFloat` flag tells the
   * renderer which layout is in use; when `false` the input is treated as
   * Float32 and the existing F32 path runs.
   */
  loadFrame(
    pixels: Float32Array | Uint16Array,
    width: number,
    height: number,
    isHalfFloat?: boolean,
  ): void;
  setExposure(stops: number): void;
  setGamma(gamma: number): void;
  setAutoExposure?(divisor: number): void;
  setNeedsBgrSwap?(swap: boolean): void;
  /** GPU renderer only — inline ACES tonemap instead of LUT. */
  setInlineAces?(use: boolean): void;
  /** GPU renderer only — output raw linear pixels (no ACES, no gamma). */
  setLinearPassthrough?(use: boolean): void;
  /** Inform the renderer that the active LUT already encodes sRGB OETF
   * (e.g. ACES CG LUTs baked as linearToSRGB(acesFilm(...))). Skip the
   * extra gamma encode at the end of the LUT branch to avoid
   * double-encoding. */
  setLutBakedSrgbOetf?(baked: boolean): void;
  /** Inform the renderer what scene-linear input domain the active LUT
   * was baked over (e.g. 16.29 for ACES RRT peak white). The shader /
   * CPU renderer divide per-pixel linear values by this constant
   * before indexing the LUT. Defaults to 1.0 for identity LUTs (Raw /
   * Linear sRGB). GPU + CPU single-thread paths honour this; the
   * worker path treats it as a no-op (uses 1.0). */
  setLutInputMax?(maxIn: number): void;
  /** Skip OCIO LUT + ACES tonemap for non-RGB passes (Normal/Motion/UV/Depth). */
  setBypassOcio?(bypass: boolean): void;
  /** Hint how to interpret raw channels (0=RGB, 1=Normal/Tangent, 2=Motion, 3=UV, 4=Gray). */
  setPassMode?(mode: 0 | 1 | 2 | 3 | 4): void;
  /** GPU renderer only — enable per-pixel OCIO debug logging. */
  setDebugOcio?(on: boolean): void;
  render(): void | Promise<void>;
  resize(width: number, height: number): void;
  /** Phase 6C: GPU renderer — returns the current source image dimensions
   *  (used to skip texImage2D upload on same-size re-renders). */
  getWidth?(): number;
  getHeight?(): number;
  /** Phase 6C: GPU renderer — re-upload LUT + draw in one step (avoids
   *  redundant uniform setup for OCIO mode switches). */
  reRenderWithNewLut?(lutData: Float32Array, lutSize: number, inputMax: number): number;
  dispose(): void;
};

export interface RendererHandle {
  renderer: AnyLutRenderer;
  kind: RendererKind;
  dispose(): void;
}

function tryCreateGpu(canvas: HTMLCanvasElement | OffscreenCanvas): EXRGpuRenderer | null {
  try {
    return new EXRGpuRenderer({ canvas });
  } catch {
    return null;
  }
}

function tryCreateWorkers(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  count: number,
): EXRWorkerLutRenderer | null {
  try {
    return new EXRWorkerLutRenderer({ canvas, workerCount: count });
  } catch {
    return null;
  }
}

export function createLutRenderer(init: RendererInit): RendererHandle | null {
  const pref = init.preference ?? "auto";

  if (pref === "gpu" || (pref === "auto" && canUseGpu())) {
    const gpu = tryCreateGpu(init.canvas);
    if (gpu) {
      return {
        renderer: gpu,
        kind: "gpu",
        dispose: () => gpu.dispose(),
      };
    }
    // User explicitly asked for GPU but it failed — return null so the
    // caller can decide whether to fall back or surface an error.
    if (pref === "gpu") return null;
  }

  // CPU fallback chain
  const workerCount = init.workerCount ?? 4;
  const workers = tryCreateWorkers(init.canvas, workerCount);
  if (workers) {
    return {
      renderer: workers,
      kind: "cpu-workers",
      dispose: () => workers.dispose(),
    };
  }
  const single = new EXRCpuLutRenderer({ canvas: init.canvas });
  return {
    renderer: single,
    kind: "cpu-single",
    dispose: () => single.dispose(),
  };
}