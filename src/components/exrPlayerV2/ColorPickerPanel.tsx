/**
 * ColorPickerPanel — the floating "Colors" palette the user opens
 * from the EXR transport. Behaviour matches `VideoPlayerPreview.tsx`:
 *
 *  - Each swatch starts collapsed showing only its HEX label.
 *  - First click expands the swatch to reveal HEX / RGB / HSL rows.
 *  - Second click on the same expanded swatch copies its HEX to the
 *    clipboard and flashes a "Copied!" line for ~1.5s.
 *  - Clicking another swatch moves the expansion there (so only one
 *    row is expanded at a time).
 *
 * The expansion index is local state — kept out of `useExrState`
 * because it is pure UI state that doesn't affect decode or cache
 * pipelines.
 */

import { useEffect, useRef, useState } from "react";
import type { ColorInfo } from "./types";

export interface ColorPickerPanelProps {
  colors: ColorInfo[];
  accentColor: string;
}

export function ColorPickerPanel({ colors, accentColor }: ColorPickerPanelProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [copiedHex, setCopiedHex] = useState<string | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Auto-clear the "Copied!" badge after 1.5s. Using a ref so a
  // subsequent copy cancels the prior timer cleanly.
  useEffect(() => {
    if (!copiedHex) return;
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopiedHex(null);
      copyResetTimerRef.current = null;
    }, 1500);
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
    };
  }, [copiedHex]);

  // Click-outside to collapse the currently expanded swatch. Mirrors
  // the `LayerSelector` dismiss-on-outside-click pattern already used
  // elsewhere in V2.
  useEffect(() => {
    if (expandedIndex === null) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (panelRef.current && target && !panelRef.current.contains(target)) {
        setExpandedIndex(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [expandedIndex]);

  if (colors.length === 0) return null;

  const handleSwatchClick = (c: ColorInfo, i: number) => {
    if (expandedIndex === i) {
      // Already expanded → second click copies + collapses.
      navigator.clipboard.writeText(c.hex).then(() => {
        setCopiedHex(c.hex);
      }).catch(() => {});
      setExpandedIndex(null);
    } else {
      setExpandedIndex(i);
    }
  };

  return (
    <div
      ref={panelRef}
      className="absolute top-14 right-4 p-2 rounded-xl border shadow-2xl z-30 fluent-menu color-picker-panel"
      style={{ borderColor: "var(--stroke-1)" }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col gap-1.5">
        {colors.map((c, i) => {
          const isExpanded = expandedIndex === i;
          return (
            <div
              key={`${c.hex}-${i}`}
              className={`flex items-center gap-2 cursor-pointer rounded transition-all ${
                isExpanded ? "bg-white/8 p-1.5" : "p-1 hover:bg-white/5"
              }`}
              onClick={() => handleSwatchClick(c, i)}
            >
              <div
                className="w-6 h-6 rounded border flex-shrink-0"
                style={{ backgroundColor: c.hex, borderColor: "var(--stroke-1)" }}
                title={`Click to ${isExpanded ? "copy" : "expand"} ${c.hex}`}
              />
              {isExpanded ? (
                <div className="flex flex-col gap-0.5 flex-1 min-w-[140px]">
                  {(
                    [
                      ["HEX", c.hex],
                      ["RGB", `${c.r ?? "?"}, ${c.g ?? "?"}, ${c.b ?? "?"}`],
                      ["HSL", c.hsl ?? "—"],
                    ] as [string, string][]
                  ).map(([label, val]) => (
                    <div key={label} className="flex items-center justify-between gap-4">
                      <span
                        className="text-[8px] uppercase tracking-wider"
                        style={{ color: "var(--fg-2)" }}
                      >
                        {label}
                      </span>
                      <span
                        className="text-[9px] font-mono"
                        style={{ color: "var(--fg-1)" }}
                      >
                        {val}
                      </span>
                    </div>
                  ))}
                  {copiedHex === c.hex && (
                    <div
                      className="text-[8px] mt-0.5"
                      style={{ color: accentColor }}
                    >
                      Copied!
                    </div>
                  )}
                </div>
              ) : (
                <span
                  className="text-[8px] font-mono"
                  style={{ color: "var(--fg-2)" }}
                >
                  {c.hex}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}