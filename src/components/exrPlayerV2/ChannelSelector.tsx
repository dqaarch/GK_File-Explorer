/**
 * ChannelSelector — inline R/G/B/A/Y/RGB toggle pills.
 */

import type { ChannelMode } from "./types";

const COLOR_MAP: Record<ChannelMode, string> = {
  RGB: "text-stone-400",
  R: "text-red-400",
  G: "text-emerald-400",
  B: "text-blue-400",
  A: "text-purple-400",
  Y: "text-yellow-400",
};

export interface ChannelSelectorProps {
  modes: ChannelMode[];
  active: ChannelMode;
  onChange: (mode: ChannelMode) => void;
  isLoading?: boolean;
  accentColor?: string;
  /**
   * 2026-07-14: when true the per-channel R/G/B/A/Y pills are
   * rendered in a dimmed, non-interactive state. Used for HDRI
   * captures which are always RGB — no per-channel mode to switch.
   */
  disabled?: boolean;
}

export function ChannelSelector({
  modes,
  active,
  onChange,
  isLoading,
  accentColor = "var(--accent)",
  disabled = false,
}: ChannelSelectorProps) {
  return (
    <div
      className="flex items-center gap-0.5 ml-3 pointer-events-auto"
      style={{
        opacity: disabled ? 0.45 : 1,
        pointerEvents: disabled ? "none" : "auto",
      }}
      title={disabled ? "Channel selection is disabled for HDRI captures" : undefined}
    >
      {modes.map((ch) => {
        const isActive = ch === active;
        const colourClass = COLOR_MAP[ch] ?? "text-stone-400";
        return (
          <button
            key={ch}
            onClick={() => onChange(ch)}
            disabled={disabled}
            className={`w-7 h-6 text-[10px] font-mono font-bold transition-all rounded border disabled:cursor-not-allowed hover:bg-blue-600 hover:text-white hover:border-blue-500 ${
              isActive
                ? `${colourClass} bg-blue-500 border-blue-400`
                : "text-stone-500 bg-black/30 border-transparent"
            }`}
          >
            {ch}
          </button>
        );
      })}
      {isLoading && (
        <div
          className="w-4 h-4 border border-t-transparent rounded-full animate-spin ml-1"
          style={{ borderColor: accentColor, borderTopColor: "transparent" }}
        />
      )}
    </div>
  );
}
