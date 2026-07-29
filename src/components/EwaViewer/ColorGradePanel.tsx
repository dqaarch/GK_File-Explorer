/**
 * ColorGradePanel - Compact color grading controls for EWA splat rendering
 * 
 * Based on Lumigrade player's color grade panel.
 * Compact design with label and slider on same row.
 */

import React, { useState } from "react";
import { X, RotateCcw } from "lucide-react";
import type { ColorGradingSettings } from "./EwaSplatRenderer";

interface ColorGradePanelProps {
  renderer: React.MutableRefObject<EwaSplatRenderer | null>;
  language: "vi" | "en";
  accentColor: string;
  onClose: () => void;
}

interface GradeValues extends Omit<ColorGradingSettings, "rGain" | "gGain" | "bGain"> {
  rGain: number;
  gGain: number;
  bGain: number;
}

const DEFAULT_GRADE: GradeValues = {
  exposure: 0,
  temperature: 0,
  tint: 0,
  contrast: 1,
  saturation: 1,
  blackLevel: 0,
  whiteLevel: 1,
  rGain: 1,
  gGain: 1,
  bGain: 1,
};

interface SliderConfig {
  key: keyof GradeValues;
  label: string;
  min: number;
  max: number;
  step: number;
}

const SLIDERS: SliderConfig[] = [
  { key: "exposure", label: "Exp", min: -2, max: 2, step: 0.05 },
  { key: "temperature", label: "Temp", min: -0.3, max: 0.3, step: 0.01 },
  { key: "tint", label: "Tint", min: -0.3, max: 0.3, step: 0.01 },
  { key: "contrast", label: "Con", min: 0.5, max: 1.8, step: 0.05 },
  { key: "saturation", label: "Sat", min: 0, max: 2, step: 0.05 },
  { key: "blackLevel", label: "Black", min: -0.2, max: 0.3, step: 0.01 },
  { key: "whiteLevel", label: "White", min: 0.6, max: 1.4, step: 0.01 },
  { key: "rGain", label: "R", min: 0.5, max: 1.5, step: 0.05 },
  { key: "gGain", label: "G", min: 0.5, max: 1.5, step: 0.05 },
  { key: "bGain", label: "B", min: 0.5, max: 1.5, step: 0.05 },
];

export function ColorGradePanel({ renderer, language, accentColor, onClose }: ColorGradePanelProps) {
  const [values, setValues] = useState<GradeValues>({ ...DEFAULT_GRADE });

  const updateRenderer = (newValues: GradeValues) => {
    if (renderer.current) {
      renderer.current.setColorGrading(newValues);
    }
  };

  const handleChange = (key: keyof GradeValues, value: number) => {
    const newValues = { ...values, [key]: value };
    setValues(newValues);
    updateRenderer(newValues);
  };

  const handleReset = () => {
    setValues({ ...DEFAULT_GRADE });
    updateRenderer(DEFAULT_GRADE);
  };

  return (
    <div 
      className="rounded-lg shadow-xl p-2 w-64"
      style={{ backgroundColor: "var(--app-bg)", border: "1px solid var(--border)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
          {language === "vi" ? "Color Grade" : "Color Grade"}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleReset}
            className="w-5 h-5 rounded flex items-center justify-center transition-colors hover:bg-white/10"
            style={{ color: "var(--text-secondary)" }}
            title={language === "vi" ? "Reset" : "Reset"}
          >
            <RotateCcw className="w-3 h-3" />
          </button>
          <button
            onClick={onClose}
            className="w-5 h-5 rounded flex items-center justify-center transition-colors hover:bg-white/10"
            style={{ color: "var(--text-secondary)" }}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Compact sliders: label + slider on same row */}
      <div className="space-y-1">
        {SLIDERS.map((slider) => {
          const percent = ((values[slider.key] - slider.min) / (slider.max - slider.min)) * 100;
          return (
            <div key={slider.key} className="flex items-center gap-1.5 px-1">
              <span 
                className="text-[9px] w-8 text-right font-mono"
                style={{ color: "var(--text-secondary)" }}
              >
                {slider.label}
              </span>
              <input
                type="range"
                min={slider.min}
                max={slider.max}
                step={slider.step}
                value={values[slider.key]}
                onChange={(e) => handleChange(slider.key, parseFloat(e.target.value))}
                className="flex-1 h-1 rounded-full appearance-none cursor-pointer slider-thumb-accent"
                style={{
                  background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${percent}%, var(--slider-track) ${percent}%, var(--slider-track) 100%)`,
                  ["--accent-from-user" as string]: accentColor,
                }}
              />
              <span 
                className="text-[9px] w-7 text-right font-mono"
                style={{ color: "var(--text-muted)" }}
              >
                {values[slider.key].toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
