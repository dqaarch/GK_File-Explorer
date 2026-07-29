/**
 * ExrHeader — top strip with badge, file name, buffer indicator,
 * layer dropdown, channel tabs, and the preview-background overlay controls.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Square } from "lucide-react";
import { LayerSelector } from "./LayerSelector";
import { ChannelSelector } from "./ChannelSelector";
import { ColorPicker } from "../ColorPicker";
import type { ChannelMode, FrameMetadata, PlaybackFPS } from "./types";

export interface ExrHeaderProps {
  fileName: string;
  mediaInfoBaseName?: string;
  mediaInfoExt?: string;
  effectiveMaxFrames: number;
  bufferLoaded: number;
  isPlaying: boolean;
  allLayers: string[];
  selectedLayer: string;
  onLayerChange: (layer: string) => void;
  channelModes: ChannelMode[];
  activeChannelMode: ChannelMode;
  onChannelChange: (mode: ChannelMode) => void;
  isLoading: boolean;
  metadata: FrameMetadata | null;
  playbackFps: PlaybackFPS;
  accentColor: string;
  bgEnabled?: boolean;
  bgColor?: string;
  onToggleBg?: () => void;
  onChangeBgColor?: (color: string) => void;
  language?: "vi" | "en";
  theme?: "dark" | "light" | "mono";
  /** HDRI mode - disable layer/channel selectors. */
  isHdriMode?: boolean;
}

export function ExrHeader({
  fileName,
  mediaInfoBaseName,
  mediaInfoExt,
  effectiveMaxFrames,
  bufferLoaded,
  allLayers,
  selectedLayer,
  onLayerChange,
  channelModes,
  activeChannelMode,
  onChannelChange,
  isLoading,
  metadata,
  playbackFps,
  accentColor,
  bgEnabled,
  bgColor,
  onToggleBg,
  onChangeBgColor,
  language = "en",
  theme = "dark",
  isHdriMode = false,
}: ExrHeaderProps) {
  const colorSwatchRef = useRef<HTMLButtonElement>(null);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [colorPickerAnchor, setColorPickerAnchor] = useState<DOMRect | null>(null);

  const openColorPicker = useCallback(() => {
    const rect = colorSwatchRef.current?.getBoundingClientRect();
    if (rect) setColorPickerAnchor(rect);
    setShowColorPicker(true);
  }, []);
  const closeColorPicker = useCallback(() => {
    setShowColorPicker(false);
    setColorPickerAnchor(null);
  }, []);

  return (
    <div
      className="absolute top-0 w-full p-2 flex justify-between items-center z-40 pointer-events-auto theme-aware-header"
      style={{
        background: `linear-gradient(135deg, ${accentColor}18 0%, var(--header-bg) 100%)`,
        borderBottom: `1px solid ${accentColor}25`,
      }}
    >
      {/* Left side */}
      <div className="flex items-center gap-2 flex-wrap">
        <div
          className="text-[8px] font-bold px-1 py-0.5 rounded uppercase tracking-wider border"
          style={{
            backgroundColor: accentColor,
            color: "var(--row-bg)",
            borderColor: `${accentColor}80`,
          }}
        >
          {effectiveMaxFrames === 1 ? "EXR" : "EXR SEQ"}
        </div>
        <span className="text-[10px] font-mono theme-aware-header-text">
          {mediaInfoBaseName || fileName}
          {effectiveMaxFrames === 1
            ? ""
            : `.####.${mediaInfoExt || "exr"}`}
        </span>
        {effectiveMaxFrames > 1 && (
          <span className="text-[8px] text-stone-500 font-mono">
            {bufferLoaded > 0 ? `[${bufferLoaded}/${effectiveMaxFrames}]` : ""}
          </span>
        )}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-2 flex-wrap">
        <LayerSelector
          layers={allLayers}
          selected={selectedLayer}
          onChange={onLayerChange}
          disabled={isHdriMode}
        />
        <ChannelSelector
          modes={channelModes}
          active={activeChannelMode}
          onChange={onChannelChange}
          disabled={isHdriMode}
        />
        <button
          onClick={onToggleBg}
          className="p-1 rounded border transition-colors"
          style={{
            borderColor: bgEnabled ? accentColor : "var(--stroke-1)",
            backgroundColor: bgEnabled ? `${accentColor}20` : "transparent",
          }}
          title="Toggle background"
        >
          <Square className="w-3 h-3" style={{ color: bgEnabled ? accentColor : "var(--fg-2)" }} />
        </button>
        {bgEnabled && (
          <button
            ref={colorSwatchRef}
            onClick={openColorPicker}
            className="w-5 h-5 rounded border cursor-pointer hover:scale-110 transition-transform"
            style={{ backgroundColor: bgColor, borderColor: "var(--stroke-1)" }}
            title="Background color"
          />
        )}

      </div>

      {showColorPicker && colorPickerAnchor && onChangeBgColor && createPortal(
        <ColorPicker
          value={bgColor || "#000000"}
          onChange={onChangeBgColor}
          onClose={closeColorPicker}
          anchorRect={colorPickerAnchor}
          language={language}
          theme={theme}
          accentColor={accentColor}
        />,
        document.body
      )}
    </div>
  );
}
