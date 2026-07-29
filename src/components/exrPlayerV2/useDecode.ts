/**
 * EXRPlayer V2 — useDecode hook
 *
 * Owns the "load a frame as an `ImageBitmap`" half of the pipeline.
 * The 2-phase OCIO splitting (Phase 1 = raw linear, Phase 2 = LUT)
 * happens ENTIRELY in the Rust-side `exrGpuPipeline` —
 * `LayerCacheManager.configure(slug)` then `loadFrameWithBitmap(idx)`
 * composes the right `ImageBitmap` for display.
 *
 * Concretely the flow is:
 *   1. `layerCacheManager.configure(layer, paths, slug, ...)` (in
 *      `ExrPlayer`) sets the active OCIO slug + cache key.
 *   2. `displayFrame(idx)` checks `isFrameLoaded(idx)` against
 *      `ImageBitmapCache` keyed by `${slug}:${layer}:${frame}`.
 *      A hit returns the already-baked bitmap; a miss runs
 *      `loadFrameWithBitmap`, which (for non-passthrough slugs)
 *      pulls the raw linear from `exrGpuPipeline.RawLinearCache`
 *      and re-renders with the LUT — without re-decoding the EXR.
 *   3. The bitmap install effect (below) paints the `ImageBitmap`
 *      onto the 2D viewport canvas.
 */

import { useCallback, useEffect, useRef } from "react";
import { layerCacheManager } from "../../utils/exrCache";
import { swapAndDisposePending, disposeAllPending } from "../../utils/exrCache/bitmapOwner";
import { dbg } from "../../utils/debug";
import type { ExrState } from "./useExrState";

type Channel = "RGB" | "R" | "G" | "B" | "A" | "Y";

export function useDecode(params: { state: ExrState; ocioSlug: string }) {
  const { state } = params;
  const lastBitmapLoadKeyRef = useRef<string>("");
  const channelModeRefMirror = useRef<string>("RGB");

  const displayFrame = useCallback(
    async (frameIndex: number, forceChannel?: string) => {
      const channel = (forceChannel ?? channelModeRefMirror.current) as Channel;

      if (layerCacheManager.isFrameLoaded(frameIndex, channel)) {
        const callGen = layerCacheManager.getGeneration();
        const bitmapKey = `${frameIndex}:${callGen}:${channel}`;

        if (bitmapKey !== lastBitmapLoadKeyRef.current) {
          lastBitmapLoadKeyRef.current = bitmapKey;
          state.setIsLoading(false);
          state.setError(null);

          layerCacheManager
            .loadFrameWithBitmap(frameIndex, channel)
            .then((bitmapResult) => {
              if (
                bitmapResult &&
                bitmapResult.generation === callGen &&
                state.currentFrameRef.current === frameIndex
              ) {
                state.setImageBitmap(bitmapResult.bitmap);
                if (channel === "RGB" || bitmapResult.channels.length > 1) {
                  state.setAvailableChannels(bitmapResult.channels);
                  state.setMetadata({ channels: bitmapResult.channels });
                  const layer = state.selectedLayerRef.current || "";
                  if (layer && bitmapResult.channels.length > 0) {
                    state.layerChannelsRef.current[layer] = bitmapResult.channels;
                  }
                }
              }
            })
            .catch((err) => {
              dbg.log(`[EXR-Player] displayFrame error:`, err);
            });
        }
        return;
      }

      state.setIsLoading(true);
      state.setError(null);
      if (state.imageBitmap) state.setImageBitmap(null);

      const submittedGeneration = layerCacheManager.getGeneration();
      lastBitmapLoadKeyRef.current = `${frameIndex}:${submittedGeneration}:${channel}`;

      layerCacheManager
        .loadFrameWithBitmap(frameIndex, channel)
        .then((bitmapResult) => {
          if (layerCacheManager.getGeneration() !== submittedGeneration) {
            if (state.currentFrameRef.current === frameIndex) {
              state.setIsLoading(false);
            }
            return;
          }

          if (bitmapResult && state.currentFrameRef.current === frameIndex) {
            state.setImageBitmap(bitmapResult.bitmap);
            state.setIsLoading(false);
            state.setError(null);

            if (channel === "RGB" || bitmapResult.channels.length > 1) {
              state.setAvailableChannels(bitmapResult.channels);
              state.setMetadata({ channels: bitmapResult.channels });
              const layer = state.selectedLayerRef.current || "";
              if (layer && bitmapResult.channels.length > 0) {
                state.layerChannelsRef.current[layer] = bitmapResult.channels;
              }
            }
          }
        })
        .catch((err) => {
          if (layerCacheManager.getGeneration() !== submittedGeneration) return;
          if (state.currentFrameRef.current === frameIndex) {
            state.setError(`Failed to load frame: ${err}`);
            state.setIsLoading(false);
          }
        });
    },
    // Empty deps so displayFrame is stable — re-creating it causes
    // the configure+startContinuousLoad effect in ExrPlayer to loop.
    [],
  );

  useEffect(() => {
    if (!state) return;

    const bitmap = state.imageBitmap;
    const canvas = state.imageCanvasRef?.current;

    if (!canvas) return;

    if (bitmap) {
      const w = bitmap.width;
      const h = bitmap.height;
      const resized = canvas.width !== w || canvas.height !== h;
      if (resized) {
        canvas.width = w;
        canvas.height = h;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(bitmap, 0, 0);
      state.imageBitmapRef.current = bitmap;
      swapAndDisposePending(bitmap);
    } else {
      swapAndDisposePending(null);
      state.imageBitmapRef.current = null;
    }
  }, [state?.imageBitmap]);

  useEffect(() => {
    channelModeRefMirror.current = state?.channelMode ?? "RGB";
  }, [state?.channelMode]);

  useEffect(() => {
    return () => {
      disposeAllPending();
    };
  }, []);

  return { displayFrame };
}