/**
 * LayerSelector — popover-style layer selector.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ExrState } from "./useExrState";

export interface LayerSelectorProps {
  layers: string[];
  selected: string;
  onChange: (v: string) => void;
  /**
   * 2026-07-14: when true the layer picker is rendered in a
   * dimmed, non-interactive state. Used for HDRI captures which
   * are single-layer RGBA — there's nothing to switch between, so
   * the control is greyed out instead of removed (keeps the header
   * layout stable when the user toggles between render-engine EXR
   * and HDRI files).
   */
  disabled?: boolean;
}

function labelFor(layer: string): string {
  if (layer.startsWith("crypto") || layer.startsWith("Crypto")) {
    return `[Crypto] ${layer}`;
  }
  return layer || "(root)";
}

export function LayerSelector({
  layers,
  selected,
  onChange,
  disabled = false,
}: LayerSelectorProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const current = labelFor(selected);

  return (
    <div
      ref={wrapRef}
      className="flex items-center gap-2 ml-2 flex-wrap rounded border px-2 py-1 relative"
      style={{
        borderColor: "var(--stroke-1)",
        backgroundColor: "var(--row-bg)",
        opacity: disabled ? 0.45 : 1,
        pointerEvents: disabled ? "none" : "auto",
      }}
      title={disabled ? "Layer selection is disabled for HDRI captures" : undefined}
    >
      <span className="text-[9px] font-mono theme-aware-meta">Layer:</span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="min-w-[150px] flex items-center justify-between gap-1 text-[9px] font-mono rounded px-1.5 py-0.5 cursor-pointer border disabled:cursor-not-allowed"
        style={{
          backgroundColor: "var(--row-bg)",
          color: "var(--accent)",
          borderColor: "var(--stroke-1)",
        }}
      >
        <span className="truncate">{current}</span>
        <ChevronDown
          className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          className="absolute top-full left-0 mt-1 min-w-[180px] max-h-56 overflow-y-auto goku-thin-scroll rounded shadow-2xl z-50 border"
          style={{
            backgroundColor: "var(--row-bg)",
            borderColor: "var(--stroke-1)",
          }}
        >
          {layers.map((layer) => {
            const isActive = layer === selected;
            return (
              <button
                key={layer}
                type="button"
                onClick={() => {
                  onChange(layer);
                  setOpen(false);
                }}
                className={`w-full text-left text-[9px] font-mono px-2 py-1 transition-colors hover:bg-blue-600 hover:text-white ${
                  isActive ? "bg-blue-500 text-white" : ""
                }`}
              >
                {labelFor(layer)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
