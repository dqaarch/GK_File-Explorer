/**
 * EXRPlayer V2 — useWheelZoom hook
 */

import { useEffect, useRef } from "react";
import type { ExrState } from "./useExrState";

export function useWheelZoom(params: {
  state: ExrState;
}) {
  const { state } = params;
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        const current = state.zoom === "Fit" ? 1 : state.zoom;
        state.setZoom(Math.max(0.1, Math.min(10, current + delta)));
      }
    };

    const el = state.containerRef.current;
    if (el) {
      el.addEventListener("wheel", handleWheel, { passive: false });
      containerRef.current = el;
    }

    return () => {
      if (containerRef.current) {
        containerRef.current.removeEventListener("wheel", handleWheel);
      }
    };
  }, [state]);
}
