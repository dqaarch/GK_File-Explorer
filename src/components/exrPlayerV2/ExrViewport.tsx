/**
 * ExrViewport — main image area with loading/error overlays,
 * the GPU-backed canvas, and the frame counter badge.
 */

import { Loader2 } from "lucide-react";

export interface ExrViewportProps {
  isLoading: boolean;
  error: string | null;
  hasBitmap: boolean;
  currentFrame: number;
  effectiveMaxFrames: number;
  selectedLayer: string;
  fileName: string;
  accentColor: string;
  zoom: number | "Fit";
  panOffset: { x: number; y: number };
  isEyedropperActive: boolean;
  bgEnabled?: boolean;
  bgColor?: string;
  onViewportClick: (e: React.MouseEvent) => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseMove: (e: React.MouseEvent) => void;
  onMouseUp: () => void;
  onMouseLeave?: () => void;
  canvasRef?: React.Ref<HTMLCanvasElement>;
}

export function ExrViewport(props: ExrViewportProps) {
  const {
    isLoading,
    error,
    hasBitmap,
    currentFrame,
    effectiveMaxFrames,
    selectedLayer,
    fileName,
    accentColor,
    zoom,
    panOffset,
    isEyedropperActive,
    bgEnabled,
    bgColor,
    onViewportClick,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onMouseLeave,
    canvasRef,
  } = props;

  const activeZoomScale = zoom === "Fit" ? 1 : zoom;

  return (
    <div
      className={`flex-1 overflow-hidden flex relative ${
        bgEnabled ? "" : "checkerboard"
      } ${
        isEyedropperActive ? "cursor-crosshair" : ""
      }`}
      style={
        bgEnabled
          ? { backgroundColor: bgColor ?? "#000000" }
          : undefined
      }
      onClick={onViewportClick}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeave}
    >
      {isLoading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <Loader2
            className="w-10 h-10 animate-spin mb-3"
            style={{ color: accentColor }}
          />
          <span className="text-stone-500 text-xs font-mono">
            Loading Frame {currentFrame + 1}...
          </span>
        </div>
      )}

      {error && !isLoading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-4xl mb-2">!</div>
          <div className="text-xs font-mono text-red-400">{error}</div>
        </div>
      )}

      {!isLoading && !error && hasBitmap && (
        <div className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden">
          <canvas
            ref={canvasRef}
            data-exr-canvas
            className="max-w-full max-h-full object-contain transition-transform duration-75 will-change-transform"
            style={{
              transform:
                zoom === "Fit"
                  ? "translate(0px, 0px)"
                  : `translate(${panOffset.x}px, ${panOffset.y}px) scale(${activeZoomScale})`,
              imageRendering: "auto",
            }}
          />
        </div>
      )}

      <span
        className="absolute bottom-4 left-4 z-10 font-mono text-[9px] p-2 rounded border font-bold"
        style={{
          color: accentColor,
          backgroundColor: "var(--row-bg)",
          borderColor: "var(--stroke-1)",
        }}
      >
        {effectiveMaxFrames > 1
          ? `Frame ${currentFrame
              .toString()
              .padStart(
                String(effectiveMaxFrames).length,
                "0",
              )} / ${(effectiveMaxFrames - 1)
              .toString()
              .padStart(String(effectiveMaxFrames).length, "0")} ${
              selectedLayer && `- ${selectedLayer}`
            }`
          : `${selectedLayer || fileName}`}
      </span>
    </div>
  );
}