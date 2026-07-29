/**
 * ExrTransport — playback controls + zoom controls + tool buttons.
 */

import {
  Play,
  Pause,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Repeat,
  Maximize,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  MonitorPlay,
  Palette,
  Pipette,
  ChevronDown,
} from "lucide-react";
import { useEffect, useRef, useState, useCallback } from "react";
import { PLAYBACK_FPS_OPTIONS } from "./constants";
import type { ChannelMode, OcioModeInfo, PlaybackFPS } from "./types";

export interface ExrTransportProps {
  effectiveMaxFrames: number;
  isPlaying: boolean;
  isLooping: boolean;
  playbackFps: PlaybackFPS;
  onPlaybackFpsChange: (fps: PlaybackFPS) => void;
  onPrevFrame: () => void;
  onNextFrame: () => void;
  onJumpBack: () => void;
  onJumpForward: () => void;
  onTogglePlay: () => void;
  onToggleLoop: () => void;
  zoom: number | "Fit";
  showZoomMenu: boolean;
  onToggleZoomMenu: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onPickZoom: (val: number | "Fit") => void;
  onResetView: () => void;
  showColorPicker: boolean;
  isEyedropperActive: boolean;
  isFocusView: boolean;
  onToggleColorPicker: () => void;
  onToggleEyedropper: () => void;
  onToggleFocusView: () => void;
  onFullscreen: () => void;
  accentColor: string;
  /** Active OCIO slug. "Raw" means passthrough. */
  ocioSlug: string;
  /** All baked ACES view transforms. */
  ocioViews: OcioModeInfo[];
  /** Replace the active OCIO view. */
  onOcioChange: (slug: string) => void;
  /** HDRI mode - show static badge instead of dropdown. */
  isHdriMode?: boolean;
  hdriReason?: string;
}

export function ExrTransport(props: ExrTransportProps) {
  const {
    effectiveMaxFrames,
    isPlaying,
    isLooping,
    playbackFps,
    onPlaybackFpsChange,
    onPrevFrame,
    onNextFrame,
    onJumpBack,
    onJumpForward,
    onTogglePlay,
    onToggleLoop,
    zoom,
    showZoomMenu,
    onToggleZoomMenu,
    onZoomOut,
    onZoomIn,
    onPickZoom,
    onResetView,
    showColorPicker,
    isEyedropperActive,
    isFocusView,
    onToggleColorPicker,
    onToggleEyedropper,
    onToggleFocusView,
    onFullscreen,
    accentColor,
    ocioSlug,
    ocioViews,
    onOcioChange,
    isHdriMode = false,
    hdriReason,
  } = props;

  // Unified menu state - close all menus when any opens
  const [showFpsMenu, setShowFpsMenu] = useState(false);
  const fpsMenuWrapRef = useRef<HTMLDivElement | null>(null);
  const [showOcioMenu, setShowOcioMenu] = useState(false);
  const ocioMenuRef = useRef<HTMLDivElement | null>(null);
  const zoomMenuWrapRef = useRef<HTMLDivElement | null>(null);

  const closeAllMenus = useCallback(() => {
    setShowFpsMenu(false);
    setShowOcioMenu(false);
    if (showZoomMenu) onToggleZoomMenu();
  }, [showZoomMenu, onToggleZoomMenu]);

  const toggleFpsMenu = useCallback(() => {
    if (showFpsMenu) {
      setShowFpsMenu(false);
    } else {
      closeAllMenus();
      setShowFpsMenu(true);
    }
  }, [showFpsMenu, closeAllMenus]);

  const toggleOcioMenu = useCallback(() => {
    if (showOcioMenu) {
      setShowOcioMenu(false);
    } else {
      closeAllMenus();
      setShowOcioMenu(true);
    }
  }, [showOcioMenu, closeAllMenus]);

  const toggleZoomMenu = useCallback(() => {
    if (showZoomMenu) {
      onToggleZoomMenu();
    } else {
      closeAllMenus();
      onToggleZoomMenu();
    }
  }, [showZoomMenu, onToggleZoomMenu, closeAllMenus]);

  const closeOcioMenu = useCallback(() => {
    setShowOcioMenu(false);
  }, []);

  // Close menus on outside click / blur
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const isInsideFps = fpsMenuWrapRef.current?.contains(target);
      const isInsideOcio = ocioMenuRef.current?.contains(target);
      const isInsideZoom = zoomMenuWrapRef.current?.contains(target);
      if (!isInsideFps && !isInsideOcio && !isInsideZoom) {
        setShowFpsMenu(false);
        setShowOcioMenu(false);
        if (showZoomMenu) onToggleZoomMenu();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showZoomMenu, onToggleZoomMenu]);

  // Helper to derive short label for button
  const deriveOcioShortLabel = (slug: string) => {
    if (slug === "Raw") return "Raw";
    const view = ocioViews.find((v) => v.slug === slug);
    if (view) return view.view;
    const parts = slug.split("__");
    return parts[parts.length - 1] || slug;
  };

  return (
    <div
      className="h-12 shrink-0 border-t flex items-center px-4 justify-between select-none relative z-50"
      style={{
        backgroundColor: "var(--row-bg)",
        borderColor: "var(--stroke-1)",
      }}
    >
      {/* Left - Playback */}
      <div className="flex items-center gap-2">
        {effectiveMaxFrames > 1 ? (
          <>
            <button
              onClick={onJumpBack}
              className="p-1 rounded text-stone-400 hover:text-white transition-colors"
              title="Jump back"
            >
              <ChevronsLeft className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onPrevFrame}
              className="p-1 rounded text-stone-400 hover:text-white transition-colors"
              title="Previous frame"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onTogglePlay}
              className="p-1 rounded transition-colors"
              style={{ color: accentColor }}
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>
            <button
              onClick={onNextFrame}
              className="p-1 rounded text-stone-400 hover:text-white transition-colors"
              title="Next frame"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onJumpForward}
              className="p-1 rounded text-stone-400 hover:text-white transition-colors"
              title="Jump forward"
            >
              <ChevronsRight className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onToggleLoop}
              className="p-1 rounded transition-colors"
              style={{ color: isLooping ? accentColor : "var(--fg-2)" }}
              title="Toggle loop"
            >
              <Repeat className="w-3.5 h-3.5" />
            </button>
            <div ref={fpsMenuWrapRef} className="relative">
              <button
                type="button"
                onClick={toggleFpsMenu}
                className="h-6 text-[9px] px-2 rounded border flex items-center gap-1 font-mono"
                style={{
                  borderColor: showFpsMenu ? accentColor : "var(--stroke-1)",
                  backgroundColor: showFpsMenu ? `${accentColor}20` : "transparent",
                  color: "var(--fg-2)",
                }}
                title="Playback FPS"
              >
                <span>{playbackFps} fps</span>
                <ChevronDown className={`w-2.5 h-2.5 transition-transform ${showFpsMenu ? "rotate-180" : ""}`} />
              </button>
              {showFpsMenu && (
                <div
                  className="absolute bottom-full left-0 mb-1 w-20 rounded py-1 shadow-2xl z-50 border overflow-hidden"
                  style={{
                    backgroundColor: "var(--row-bg)",
                    borderColor: "var(--stroke-1)",
                  }}
                >
                  {PLAYBACK_FPS_OPTIONS.map((fps) => {
                    const isActive = fps === playbackFps;
                    return (
                      <button
                        key={fps}
                        type="button"
                        onClick={() => {
                          onPlaybackFpsChange(fps);
                          setShowFpsMenu(false);
                        }}
                        className={`w-full text-left px-2 py-1 text-[9px] font-mono transition-colors hover:bg-blue-600 hover:text-white ${
                          isActive ? "bg-blue-500 text-white" : ""
                        }`}
                      >
                        {fps} fps
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <span className="text-[9px] text-stone-500">Single frame</span>
        )}
      </div>

      {/* Center - Zoom */}
      <div className="flex items-center gap-1" ref={zoomMenuWrapRef}>
        <button
          onClick={onZoomOut}
          className="p-1 rounded text-stone-400 hover:text-white transition-colors"
          title="Zoom out"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <div className="relative">
          <button
            onClick={toggleZoomMenu}
            className="px-2 py-1 rounded text-[9px] font-mono border transition-colors min-w-[60px] text-center"
            style={{ borderColor: showZoomMenu ? accentColor : "var(--stroke-1)", color: "var(--fg-2)" }}
            title="Zoom options"
          >
            {zoom === "Fit" ? "Fit" : `${Math.round(zoom * 100)}%`}
            <ChevronDown className="w-2.5 h-2.5 inline ml-1" />
          </button>
          {showZoomMenu && (
            <div
              className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 py-1 rounded border shadow-xl z-50 min-w-[80px]"
              style={{ backgroundColor: "var(--row-bg)", borderColor: "var(--stroke-1)" }}
            >
              <button
                onClick={() => { onPickZoom("Fit"); onToggleZoomMenu(); }}
                className="w-full px-3 py-1 text-[9px] text-left hover:bg-blue-600 hover:text-white transition-colors"
              >
                Fit
              </button>
              {[0.25, 0.5, 1, 2, 4, 8].map((v) => (
                <button
                  key={v}
                  onClick={() => { onPickZoom(v); onToggleZoomMenu(); }}
                  className="w-full px-3 py-1 text-[9px] text-left hover:bg-blue-600 hover:text-white transition-colors font-mono"
                >
                  {v * 100}%
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={onZoomIn}
          className="p-1 rounded text-stone-400 hover:text-white transition-colors"
          title="Zoom in"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onResetView}
          className="p-1 rounded text-stone-400 hover:text-white transition-colors"
          title="Reset view"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Right - Tools */}
      <div className="flex items-center gap-1">
        <button
          onClick={onToggleColorPicker}
          className="p-1 rounded transition-colors"
          style={{ color: showColorPicker ? accentColor : "var(--fg-2)" }}
          title="Color picker"
        >
          <Palette className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onToggleEyedropper}
          className="p-1 rounded transition-colors"
          style={{ color: isEyedropperActive ? accentColor : "var(--fg-2)" }}
          title="Eyedropper"
        >
          <Pipette className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onToggleFocusView}
          className="p-1 rounded transition-colors"
          style={{ color: isFocusView ? accentColor : "var(--fg-2)" }}
          title="Focus view"
        >
          <MonitorPlay className="w-3.5 h-3.5" />
        </button>

        {/* OCIO dropdown */}
        <div className="relative" ref={ocioMenuRef}>
          {isHdriMode ? (
            <span
              className="px-2 py-1 rounded border text-[9px] font-mono"
              style={{ borderColor: accentColor, backgroundColor: `${accentColor}20`, color: accentColor }}
              title={hdriReason ?? "HDRI capture (hdrify + Reinhard E1)"}
            >
              HDRI
            </span>
          ) : (
            <button
              onClick={toggleOcioMenu}
              className="px-2 py-1 rounded border text-[9px] font-mono flex items-center gap-1"
              style={{
                borderColor: showOcioMenu || ocioSlug !== "Raw" ? accentColor : "var(--stroke-1)",
                backgroundColor: showOcioMenu || ocioSlug !== "Raw" ? `${accentColor}20` : "transparent",
                color: showOcioMenu || ocioSlug !== "Raw" ? accentColor : "var(--fg-2)",
              }}
              title={`OCIO: ${ocioSlug === "Raw" ? "Raw passthrough" : deriveOcioShortLabel(ocioSlug)}`}
            >
              OCIO
              <ChevronDown className="w-3 h-3" style={{ opacity: 0.5 }} />
            </button>
          )}

          {showOcioMenu && !isHdriMode && (
            <div
              className="absolute bottom-full mb-1 right-0 w-48 max-h-64 overflow-y-auto rounded py-1 shadow-xl z-50 border"
              style={{ backgroundColor: "var(--row-bg)", borderColor: "var(--stroke-1)" }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {/* Raw option */}
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onOcioChange("Raw"); closeOcioMenu(); }}
                className={`w-full text-left px-3 py-1.5 text-[9px] font-mono flex items-center gap-2 hover:bg-blue-600 hover:text-white ${
                  ocioSlug === "Raw" ? "bg-blue-500 text-white" : ""
                }`}
              >
                <div
                  className={`w-1.5 h-1.5 rounded-full ${ocioSlug === "Raw" ? "" : "border border-transparent"}`}
                  style={ocioSlug === "Raw" ? { backgroundColor: accentColor } : {}}
                />
                Raw
              </button>

              <div className="h-px" style={{ backgroundColor: "var(--stroke-1)" }} />

              {/* ACES views */}
              {ocioViews.length === 0 ? (
                <div className="px-3 py-2 text-[9px] font-mono" style={{ color: "var(--fg-2)" }}>
                  (no baked views)
                </div>
              ) : (
                ocioViews.map((v) => {
                  const selected = ocioSlug === v.slug;
                  return (
                    <button
                      key={v.slug}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { onOcioChange(v.slug); closeOcioMenu(); }}
                      className={`w-full text-left px-3 py-1.5 text-[9px] font-mono flex items-center gap-2 hover:bg-blue-600 hover:text-white ${
                        selected ? "bg-blue-500 text-white" : ""
                      }`}
                      title={v.slug}
                    >
                      <div
                        className={`w-1.5 h-1.5 rounded-full ${selected ? "" : "border border-transparent"}`}
                        style={selected ? { backgroundColor: accentColor } : {}}
                      />
                      <span className="truncate">{v.view}</span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>

        <button
          onClick={onFullscreen}
          className="p-1 rounded text-stone-400 hover:text-white transition-colors"
          title="Fullscreen"
        >
          <Maximize className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
