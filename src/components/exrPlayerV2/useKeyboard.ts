/**
 * EXRPlayer V2 — useKeyboard hook
 */

import { useEffect } from "react";
import type { ExrState } from "./useExrState";

export function useKeyboard(params: {
  state: ExrState;
  effectiveMaxFrames: number;
}) {
  const { state, effectiveMaxFrames } = params;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.code) {
        case "Space":
          e.preventDefault();
          state.setIsPlaying((p) => !p);
          break;
        case "ArrowLeft":
          e.preventDefault();
          state.setIsPlaying(false);
          state.setCurrentFrame((f) => Math.max(0, f - 1));
          break;
        case "ArrowRight":
          e.preventDefault();
          state.setIsPlaying(false);
          state.setCurrentFrame((f) => Math.min(effectiveMaxFrames - 1, f + 1));
          break;
        case "Home":
          e.preventDefault();
          state.setIsPlaying(false);
          state.setCurrentFrame(0);
          break;
        case "End":
          e.preventDefault();
          state.setIsPlaying(false);
          state.setCurrentFrame(effectiveMaxFrames - 1);
          break;
        case "KeyJ":
          e.preventDefault();
          state.setIsPlaying(false);
          state.setCurrentFrame((f) => Math.max(0, f - state.playbackFps));
          break;
        case "KeyK":
          e.preventDefault();
          state.setIsPlaying((p) => !p);
          break;
        case "KeyL":
          e.preventDefault();
          state.setIsPlaying(false);
          state.setCurrentFrame((f) => Math.min(effectiveMaxFrames - 1, f + state.playbackFps));
          break;
        case "KeyR":
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            state.setZoom("Fit");
            state.setPanOffset({ x: 0, y: 0 });
          }
          break;
        case "KeyF":
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            state.setIsFocusView((p) => !p);
          }
          break;
        case "Escape":
          // ESC exits the same way Fullscreen does — leave Focus
          // View if it's active. We deliberately do NOT also try
          // to exit the browser's native fullscreen here, because
          // that's already handled by the user-agent and stacking
          // `exitFullscreen()` on top causes a race with the
          // `fullscreenchange` event in `ExrPlayer`.
          if (state.isFocusView) {
            e.preventDefault();
            state.setIsFocusView(false);
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state, effectiveMaxFrames]);
}
