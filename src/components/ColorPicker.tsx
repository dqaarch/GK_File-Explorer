import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Pipette, X } from "lucide-react";

const PRESET_COLORS = [
  "#0078d4", "#00bcf1", "#008080", "#10b981", "#059669", "#84cc16",
  "#eab308", "#f97316", "#ea580c", "#ef4444", "#e11d48", "#f43f5e",
  "#ec4899", "#d946ef", "#a855f7", "#8b5cf6", "#6366f1", "#3b82f6",
  "#6b7280", "#9ca3af", "#f3f4f6", "#1f2937", "#111827", "#000000",
];

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h: h * 360, s: s * 100, v: v * 100 };
}

function hsvToHex(h: number, s: number, v: number): string {
  const hh = h / 360, ss = s / 100, vv = v / 100;
  const i = Math.floor(hh * 6);
  const f = hh * 6 - i;
  const p = vv * (1 - ss);
  const q = vv * (1 - f * ss);
  const t = vv * (1 - (1 - f) * ss);
  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: [r, g, b] = [vv, t, p]; break;
    case 1: [r, g, b] = [q, vv, p]; break;
    case 2: [r, g, b] = [p, vv, t]; break;
    case 3: [r, g, b] = [p, q, vv]; break;
    case 4: [r, g, b] = [t, p, vv]; break;
    case 5: [r, g, b] = [vv, p, q]; break;
  }
  return "#" + [r, g, b].map(x => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}

function isValidHex(str: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(str);
}

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  onClose: () => void;
  language: "vi" | "en";
  accentColor: string;
  theme: "dark" | "light" | "mono";
  /** Anchor rect (button position) to position the popover next to it. */
  anchorRect: DOMRect | null;
  /** Trigger button ref so clicking it again while open doesn't immediately close. */
  triggerRef?: React.RefObject<HTMLElement | null>;
}

export function ColorPicker({ value, onChange, onClose, language, accentColor, theme, anchorRect, triggerRef }: ColorPickerProps) {
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [hexInput, setHexInput] = useState(() => value.toUpperCase());
  const [hexError, setHexError] = useState(false);
  const [hueDragging, setHueDragging] = useState(false);
  const [svDragging, setSvDragging] = useState(false);
  const [copied, setCopied] = useState(false);

  const satBrightRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const currentHex = useMemo(() => hsvToHex(hsv.h, hsv.s, hsv.v), [hsv]);
  const hueColor = useMemo(() => hsvToHex(hsv.h, 100, 100), [hsv]);

  useEffect(() => {
    setHsv(hexToHsv(value));
    setHexInput(value.toUpperCase());
  }, [value]);

  useEffect(() => {
    setHexInput(currentHex.toUpperCase());
    setHexError(false);
  }, [currentHex]);

  // Compute popover position based on anchor rect (right of button by default, flip to left if no room)
  useEffect(() => {
    if (!anchorRect) return;
    const popWidth = 240;
    const popHeight = 320;
    const margin = 8;

    let left = anchorRect.right + margin;
    if (left + popWidth > window.innerWidth - 8) {
      // Flip to left of the button
      left = anchorRect.left - popWidth - margin;
      if (left < 8) {
        // Last resort: clamp to viewport
        left = Math.max(8, Math.min(window.innerWidth - popWidth - 8, anchorRect.left));
      }
    }
    // Vertical: align top to button top
    let top = anchorRect.top - 4;
    if (top + popHeight > window.innerHeight - 8) {
      top = window.innerHeight - popHeight - 8;
    }
    if (top < 8) top = 8;
    setPosition({ top, left });
  }, [anchorRect]);

  const pickFromSatBright = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!satBrightRef.current) return;
    const rect = satBrightRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    setHsv(prev => ({ ...prev, s: x * 100, v: (1 - y) * 100 }));
  }, []);

  const pickFromHue = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!hueRef.current) return;
    const rect = hueRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHsv(prev => ({ ...prev, h: x * 360 }));
  }, []);

  const handleSatBrightMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSvDragging(true);
    pickFromSatBright(e);
  }, [pickFromSatBright]);

  const handleHueMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHueDragging(true);
    pickFromHue(e);
  }, [pickFromHue]);

  useEffect(() => {
    if (!svDragging && !hueDragging) return;

    const handleMove = (e: MouseEvent) => {
      if (svDragging) pickFromSatBright(e);
      if (hueDragging) pickFromHue(e);
    };
    const handleUp = () => {
      if (svDragging || hueDragging) {
        const newHex = hsvToHex(hsv.h, hsv.s, hsv.v);
        onChange(newHex);
      }
      setSvDragging(false);
      setHueDragging(false);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [svDragging, hueDragging, hsv, pickFromSatBright, pickFromHue, onChange]);

  const commitColor = useCallback((color: string) => {
    onChange(color);
  }, [onChange]);

  const handleHexChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = "#" + e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
    setHexInput(raw.toUpperCase());
    if (isValidHex(raw)) {
      setHexError(false);
      setHsv(hexToHsv(raw));
    } else if (raw.length === 7) {
      setHexError(true);
    }
  }, []);

  const handleHexBlur = useCallback(() => {
    if (isValidHex(hexInput)) {
      commitColor(hexInput);
    } else {
      setHexInput(currentHex.toUpperCase());
      setHexError(false);
    }
  }, [hexInput, currentHex, commitColor]);

  const handleHexKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (isValidHex(hexInput)) {
        commitColor(hexInput);
      } else {
        setHexInput(currentHex.toUpperCase());
        setHexError(false);
      }
    }
  }, [hexInput, currentHex, commitColor]);

  // Copy hex to clipboard
  const copyHex = useCallback(async (hex: string) => {
    try {
      await navigator.clipboard.writeText(hex.toUpperCase());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard not available */
    }
  }, []);

  // Eyedropper: use native EyeDropper API. On successful pick, auto-copy hex to clipboard.
  const handleEyedropper = useCallback(async () => {
    // @ts-ignore — EyeDropper is not in TS lib yet
    if (typeof window === "undefined" || !("EyeDropper" in window)) {
      copyHex(currentHex);
      return;
    }
    try {
      // @ts-ignore
      const ed = new window.EyeDropper();
      const result = await ed.open();
      const picked = (result.sRGBHex as string).toUpperCase();
      setHsv(hexToHsv(picked));
      commitColor(picked);
      await copyHex(picked);
    } catch {
      // User cancelled the picker — no-op
    }
  }, [commitColor, copyHex, currentHex]);

  const handlePresetClick = useCallback((color: string) => {
    setHsv(hexToHsv(color));
    commitColor(color);
  }, [commitColor]);

// Close on outside interaction — listen on `window` in CAPTURE phase so we get
// the event before any descendant stopPropagation() can interfere (e.g. file
// row React handlers). Ignore clicks inside the popover OR the trigger button,
// and use a 0ms delay so the same pointerdown that opened the picker doesn't
// re-close it.
useEffect(() => {
  const handlePointerDownOutside = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (!target) return;
    if (popoverRef.current?.contains(target)) return;
    if (triggerRef?.current?.contains(target)) return;
    onChange(currentHex);
    onClose();
  };

  const handleKeyDownOutside = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      onChange(currentHex);
      onClose();
    }
  };

  const timer = setTimeout(() => {
    // Capture phase = `true` so we run before any descendant React handlers
    window.addEventListener("pointerdown", handlePointerDownOutside, true);
    window.addEventListener("keydown", handleKeyDownOutside);
  }, 0);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("pointerdown", handlePointerDownOutside, true);
    window.removeEventListener("keydown", handleKeyDownOutside);
  };
}, [currentHex, onChange, onClose, triggerRef]);

  const t = useCallback((vi: string, en: string) => language === "vi" ? vi : en, [language]);

  // Use CSS vars defined by `.fluent-menu` so we auto-match light/dark themes.
  const strokeColor = "var(--stroke-1)";
  const fg1 = "var(--fg-1)";
  const fg2 = "var(--fg-2)";
  const fg3 = "var(--fg-3)";

  if (!position) return null;

  return createPortal(
    <>
      <div
        ref={popoverRef}
        data-theme={theme}
        className={`fixed rounded-xl p-2.5 flex flex-col gap-2 select-none fluent-menu ${theme === "light" ? "theme-light" : ""}`}
        style={{
          top: position.top,
          left: position.left,
          width: 240,
          zIndex: 10000,
        }}
        onClick={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        onPointerDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: fg2 }}>
            {t("Chọn màu", "Pick a Color")}
          </span>
          <button
            onClick={() => { onChange(currentHex); onClose(); }}
            className="w-4 h-4 flex items-center justify-center rounded cursor-pointer transition-colors duration-100"
            style={{ color: fg2 }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.08)")}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = "transparent")}
            aria-label={t("Đóng", "Close")}
          >
            <X className="w-2.5 h-2.5" strokeWidth={2} />
          </button>
        </div>

        {/* Saturation + Brightness canvas */}
        <div
          ref={satBrightRef}
          className="w-full rounded-lg cursor-crosshair select-none relative overflow-hidden"
          style={{
            height: 120,
            background: `linear-gradient(to bottom, transparent, #000), linear-gradient(to right, #fff, hsl(${hsv.h},100%,50%))`,
          }}
          onMouseDown={handleSatBrightMouseDown}
        >
          <div
            className="absolute rounded-full border-2 border-white pointer-events-none"
            style={{
              width: 12,
              height: 12,
              left: `calc(${hsv.s}% - 6px)`,
              top: `calc(${(1 - hsv.v / 100) * 100}% - 6px)`,
              boxShadow: "0 0 0 1px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(0,0,0,0.4)",
              background: "transparent",
            }}
          />
        </div>

        {/* Hue bar */}
        <div
          ref={hueRef}
          className="w-full rounded-md cursor-pointer select-none relative"
          style={{
            height: 10,
            background: "linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)",
          }}
          onMouseDown={handleHueMouseDown}
        >
          <div
            className="absolute top-0 bottom-0 w-1.5 rounded-full border border-white/60 pointer-events-none"
            style={{
              left: `calc(${hsv.h / 360 * 100}% - 3px)`,
              background: hueColor,
              boxShadow: "0 0 0 1px rgba(0,0,0,0.3)",
            }}
          />
        </div>

        {/* Hex input + preview + eyedropper */}
        <div className="flex items-center gap-1.5">
          <div
            className="rounded-md border flex-shrink-0"
            style={{
              width: 28,
              height: 28,
              backgroundColor: currentHex,
              borderColor: strokeColor,
              boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.05)`,
            }}
          />
          <div
            className="flex items-center rounded-md border flex-1"
            style={{
              backgroundColor: "var(--surface-bg)",
              borderColor: hexError ? "#ff6b6b" : strokeColor,
              height: 28,
              minWidth: 0,
            }}
          >
            <span className="text-[10px] font-medium pl-1.5 select-none" style={{ color: fg3 }}>#</span>
            <input
              type="text"
              value={hexInput.replace("#", "")}
              onChange={handleHexChange}
              onBlur={handleHexBlur}
              onKeyDown={handleHexKeyDown}
              className="flex-1 text-[11px] px-1 py-0 outline-none font-mono"
              style={{
                backgroundColor: "transparent",
                color: hexError ? "#ff6b6b" : fg1,
                letterSpacing: "0.06em",
                minWidth: 0,
                border: "none",
              }}
              maxLength={6}
              spellCheck={false}
              aria-label="Hex color value"
            />
          </div>
          <button
            onClick={handleEyedropper}
            className="rounded-md cursor-pointer transition-colors duration-100 flex-shrink-0 flex items-center justify-center"
            style={{
              width: 28,
              height: 28,
              color: fg2,
              backgroundColor: "var(--surface-bg)",
              border: `1px solid ${strokeColor}`,
            }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.08)")}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = "var(--surface-bg)")}
            title={t("Chọn màu từ màn hình — tự sao chép hex", "Pick color from screen — auto-copies hex")}
            aria-label="Eyedropper"
          >
            <Pipette className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Preset swatches */}
        <div>
          <div className="text-[9px] font-medium mb-1 px-0.5" style={{ color: fg3 }}>
            {t("Màu cài sẵn", "Presets")}
          </div>
          <div className="grid gap-[3px]" style={{ gridTemplateColumns: "repeat(12, 1fr)" }}>
            {PRESET_COLORS.map(color => (
              <button
                key={color}
                onClick={() => handlePresetClick(color)}
                className="rounded-sm cursor-pointer transition-transform duration-100 hover:scale-110"
                style={{
                  width: "100%",
                  aspectRatio: "1",
                  backgroundColor: color,
                  boxShadow: "inset 0 0 0 0.5px rgba(255,255,255,0.08)",
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.boxShadow = `0 0 0 1.5px ${accentColor}, inset 0 0 0 0.5px rgba(255,255,255,0.08)`;
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.boxShadow = "inset 0 0 0 0.5px rgba(255,255,255,0.08)";
                }}
                title={color}
                aria-label={`Select color ${color}`}
              />
            ))}
          </div>
        </div>

        {/* Recent colors section removed */}
      </div>

      {/* Copied toast */}
      {copied && createPortal(
        <div
          className="fixed rounded-md px-2.5 py-1 text-[11px] font-medium fluent-menu"
          style={{
            top: position.top - 32,
            left: position.left,
            color: "var(--fg-1)",
            border: `1px solid ${accentColor}`,
            zIndex: 10003,
            pointerEvents: "none",
          }}
        >
          {t("Đã sao chép ", "Copied ")}{currentHex.toUpperCase()}
        </div>,
        document.body
      )}
    </>,
    document.body
  );
}
