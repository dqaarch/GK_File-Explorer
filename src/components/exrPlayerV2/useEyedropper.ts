/**
 * useEyedropper — pick the colour under the cursor on the EXR viewport.
 *
 * Performance notes (matters because mousemove fires 60–120 times/sec):
 *
 *  - The 1×1 offscreen canvas + 2D context are created ONCE and
 *    cached in module-scoped singletons (`__scratchCanvas` /
 *    `__scratchCtx`). Allocating a fresh canvas + context on every
 *    mousemove (the old implementation) was the dominant source of
 *    GC pressure and made the tooltip feel visibly laggy compared to
 *    the video player. VideoPlayer has the same pattern but gets away
 *    with it because the painted surface is an HW-accelerated
 *    `<video>` element, which keeps `drawImage` cheap; we sample
 *    from a 2D canvas backed by an `ImageBitmap`, which is slower,
 *    so caching the scratch surface is worth it here.
 *  - Sampling + state writes are coalesced through `requestAnimationFrame`.
 *    Multiple mousemove events between two paints collapse into a
 *    single read and a single `setEyedropperColor` call.
 *  - `clearOnLeave` is exposed separately so the `mouseleave` handler
 *    on the viewport can clear the live sample without going through
 *    the rAF queue.
 */

import { useCallback, useEffect, useRef } from "react";
import type { ExrState } from "./useExrState";
import { rgbToHex } from "./rgbToHex";
import { rgbToHslString } from "./rgbToHsl";

// Module-scope singletons: reused across every component instance
// and every mousemove. `getContext` is expensive; this turns the
// per-event cost into a constant.
let __scratchCanvas: HTMLCanvasElement | null = null;
let __scratchCtx: CanvasRenderingContext2D | null = null;
function getScratch(): CanvasRenderingContext2D | null {
  if (__scratchCtx) return __scratchCtx;
  __scratchCanvas = document.createElement("canvas");
  __scratchCanvas.width = 1;
  __scratchCanvas.height = 1;
  __scratchCtx = __scratchCanvas.getContext("2d", { willReadFrequently: true });
  return __scratchCtx;
}

export function useEyedropper({ state }: { state: ExrState }) {
  // The most-recent pointer position. We update it synchronously on
  // mousemove but defer the actual pixel read to the next animation
  // frame so we never run more than one drawImage per repaint.
  const pendingPointRef = useRef<{ x: number; y: number } | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const runSample = useCallback(() => {
    rafIdRef.current = null;
    if (!state.isEyedropperActive) return;
    const pt = pendingPointRef.current;
    pendingPointRef.current = null;
    if (!pt) return;

    const source = state.imageCanvasRef?.current;
    if (!source) {
      state.setEyedropperColor(null);
      return;
    }
    const iw = source.width || state.imageBitmap?.width || 0;
    const ih = source.height || state.imageBitmap?.height || 0;
    if (!iw || !ih) {
      state.setEyedropperColor(null);
      return;
    }

    const rect = source.getBoundingClientRect();
    if (
      pt.x < rect.left ||
      pt.x >= rect.right ||
      pt.y < rect.top ||
      pt.y >= rect.bottom
    ) {
      state.setEyedropperColor(null);
      return;
    }

    const imgX = (pt.x - rect.left) * (iw / rect.width);
    const imgY = (pt.y - rect.top) * (ih / rect.height);

    const ctx = getScratch();
    if (!ctx) {
      state.setEyedropperColor(null);
      return;
    }

    try {
      ctx.clearRect(0, 0, 1, 1);
      ctx.drawImage(source, imgX, imgY, 1, 1, 0, 0, 1, 1);
      const pixel = ctx.getImageData(0, 0, 1, 1).data;
      const r = pixel[0];
      const g = pixel[1];
      const b = pixel[2];
      const a = pixel[3];
      if (a === 0) {
        state.setEyedropperColor(null);
        return;
      }
      state.setEyedropperColor({
        hex: rgbToHex(r, g, b),
        rgb: `rgb(${r}, ${g}, ${b})`,
        hsl: rgbToHslString(r, g, b),
        r,
        g,
        b,
      });
    } catch {
      state.setEyedropperColor(null);
    }
  }, [state]);

  const sample = useCallback(
    (e: React.MouseEvent) => {
      if (!state.isEyedropperActive) return;
      pendingPointRef.current = { x: e.clientX, y: e.clientY };
      if (rafIdRef.current !== null) return;
      rafIdRef.current = window.requestAnimationFrame(runSample);
    },
    [state.isEyedropperActive, runSample],
  );

  const clear = useCallback(() => {
    pendingPointRef.current = null;
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    state.setEyedropperColor(null);
  }, [state]);

  // If the eyedropper gets toggled off while a frame is queued, the
  // queued frame would still fire `setEyedropperColor(null)` on the
  // next paint — which is harmless but wasteful. Cancel it.
  useEffect(() => {
    if (state.isEyedropperActive) return;
    pendingPointRef.current = null;
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, [state.isEyedropperActive]);

  return { sample, clear };
}