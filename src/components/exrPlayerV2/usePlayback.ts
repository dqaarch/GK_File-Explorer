/**
 * EXRPlayer V2 — usePlayback hook
 */

import { useCallback, useEffect, useRef } from "react";
import { layerCacheManager } from "../../utils/exrCache";
import { dbg } from "../../utils/debug";
import type { ExrState } from "./useExrState";

export function usePlayback(params: {
  state: ExrState;
  effectiveMaxFrames: number;
  displayFrame: (frameIndex: number, forceChannel?: string) => Promise<void>;
}) {
  const { state, effectiveMaxFrames, displayFrame } = params;
  const startPreloadFn = useCallback((center: number, count: number) => {
    layerCacheManager.preloadAhead(center, count);
  }, []);
  const frameTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRunningRef = useRef(true);
  const isLoopingRef = useRef(state.isLooping);
  const playbackFpsRef = useRef(state.playbackFps);

  useEffect(() => {
    isLoopingRef.current = state.isLooping;
  }, [state.isLooping]);
  useEffect(() => {
    playbackFpsRef.current = state.playbackFps;
  }, [state.playbackFps]);

  const clearTimer = useCallback(() => {
    if (frameTimeoutRef.current !== null) {
      clearTimeout(frameTimeoutRef.current);
      frameTimeoutRef.current = null;
    }
  }, []);

  const playNextFrame = useCallback(async () => {
    if (!isRunningRef.current || !state.isPlayingRef.current) return;

    const currentF = state.currentFrameRef.current;
    let nextFrame = currentF + 1;
    const decodeGenSnapshot = state.decodeGenerationRef.current;

    if (nextFrame >= effectiveMaxFrames) {
      if (isLoopingRef.current) {
        nextFrame = 0;
      } else {
        state.setIsPlaying(false);
        return;
      }
    }

    if (layerCacheManager.isFrameLoaded(nextFrame)) {
      if (state.decodeGenerationRef.current !== decodeGenSnapshot) {
        const frameDuration = 1000 / playbackFpsRef.current;
        frameTimeoutRef.current = setTimeout(playNextFrame, frameDuration);
        return;
      }

      state.setCurrentFrame(nextFrame);
      const submittedGen = layerCacheManager.getGeneration();
      layerCacheManager
        .loadFrameWithBitmap(nextFrame)
        .then((bitmapResult) => {
          if (
            bitmapResult &&
            bitmapResult.generation === submittedGen &&
            state.isPlayingRef.current &&
            state.currentFrameRef.current === nextFrame
          ) {
            state.imageBitmapRef.current = bitmapResult.bitmap;
            state.setImageBitmap(bitmapResult.bitmap);
          }
        })
        .catch((err) => {
          dbg.log(`[EXR-Player] playNextFrame error:`, err);
        });

      startPreloadFn(nextFrame, 2);
      const frameDuration = 1000 / playbackFpsRef.current;
      frameTimeoutRef.current = setTimeout(playNextFrame, frameDuration);
      return;
    }

    const submittedGen = layerCacheManager.getGeneration();
    const bitmapResult = await layerCacheManager.loadFrameWithBitmap(nextFrame);

    if (layerCacheManager.getGeneration() !== submittedGen) {
      if (state.isPlayingRef.current) {
        const frameDuration = 1000 / playbackFpsRef.current;
        frameTimeoutRef.current = setTimeout(playNextFrame, frameDuration);
      }
      return;
    }

    if (bitmapResult && state.isPlayingRef.current) {
      state.setCurrentFrame(nextFrame);
      state.imageBitmapRef.current = bitmapResult.bitmap;
      state.setImageBitmap(bitmapResult.bitmap);
      const frameDuration = 1000 / playbackFpsRef.current;
      frameTimeoutRef.current = setTimeout(playNextFrame, frameDuration);
      return;
    }

    if (!state.isPlayingRef.current) return;
    frameTimeoutRef.current = setTimeout(playNextFrame, 50);
  }, [effectiveMaxFrames, state, startPreloadFn]);

  useEffect(() => {
    isRunningRef.current = true;
    clearTimer();

    if (state.isPlaying && effectiveMaxFrames > 0) {
      const frameDuration = 1000 / state.playbackFps;
      frameTimeoutRef.current = setTimeout(playNextFrame, frameDuration);
    }

    return () => {
      isRunningRef.current = false;
      clearTimer();
    };
  }, [state.isPlaying, state.isLooping, state.playbackFps, effectiveMaxFrames, playNextFrame, clearTimer]);

  useEffect(() => {
    if (state.currentFrame === 0 && !state.bufferLoadedRef.current) return;
    displayFrame(state.currentFrame);
    startPreloadFn(state.currentFrame, 2);
  }, [state.currentFrame, displayFrame, startPreloadFn]);

  return {
    isPlayingRef: state.isPlayingRef,
  };
}
