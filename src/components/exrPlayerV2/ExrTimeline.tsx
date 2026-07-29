/**
 * ExrTimeline — scrub bar with frame-status overlay.
 */

export interface ExrTimelineProps {
  effectiveMaxFrames: number;
  currentFrame: number;
  frameStatuses: { frameIndex: number; status: string }[];
  accentColor: string;
  onScrub: (frame: number) => void;
}

function getFrameStatusColor(status: string, accentColor: string): string {
  switch (status) {
    case "loaded":
    case "loading":
      return accentColor;
    case "error":
      return "#ef4444";
    default:
      return "var(--row-bg)";
  }
}

export function ExrTimeline({
  effectiveMaxFrames,
  currentFrame,
  frameStatuses,
  accentColor,
  onScrub,
}: ExrTimelineProps) {
  const pickFrameFromEvent = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const newFrame = Math.floor(
      Math.max(0, Math.min(1, percent)) * effectiveMaxFrames,
    );
    onScrub(newFrame);
  };

  return (
    <div
      className="h-8 cursor-pointer group z-50 relative border-t"
      style={{
        backgroundColor: "var(--row-bg)",
        borderColor: "var(--stroke-1)",
      }}
      onClick={pickFrameFromEvent}
      onMouseMove={(e) => {
        if (e.buttons === 1) pickFrameFromEvent(e);
      }}
    >
      <div className="absolute inset-0 flex items-center">
        <div className="w-full h-2 flex">
          {frameStatuses.length > 0 ? (
            frameStatuses.map((fs, idx) => (
              <div
                key={idx}
                className="flex-1 h-full"
                style={{
                  backgroundColor: getFrameStatusColor(fs.status, accentColor),
                }}
              />
            ))
          ) : (
            <div
              className="w-full h-2"
              style={{ backgroundColor: "var(--surface-bg)" }}
            />
          )}
        </div>
      </div>
      <div
        className="absolute top-0 bottom-0 w-0.5 shadow-lg timeline-scrub-line"
        style={{
          left: `${(currentFrame / Math.max(1, effectiveMaxFrames - 1)) * 100}%`,
        }}
      />
    </div>
  );
}
