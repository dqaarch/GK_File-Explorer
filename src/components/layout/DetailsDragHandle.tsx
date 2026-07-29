import React from "react";

interface DetailsDragHandleProps {
  isVertical: boolean;
  resizing: "sidebar" | "details" | null;
  onResize: () => void;
  onDoubleClick: () => void;
  accentColor: string;
  theme: string;
}

export function DetailsDragHandle({
  isVertical,
  resizing,
  onResize,
  onDoubleClick,
  accentColor,
  theme,
}: DetailsDragHandleProps) {
  const isResizing = resizing === "details";
  const bgColor = isResizing
    ? accentColor
    : theme === "light"
    ? "#e5e5e5"
    : "rgba(255,255,255,0.05)";

  if (isVertical) {
    // Horizontal drag handle (for vertical layout)
    return (
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          onResize();
        }}
        onDoubleClick={onDoubleClick}
        className="h-[4px] cursor-row-resize shrink-0 flex flex-col items-center w-full"
        title="Kéo để thay đổi kích cỡ (nhấp đúp để ẩn)"
      >
        <div className="h-[2px] w-full transition-colors duration-150" style={{ backgroundColor: bgColor }} />
      </div>
    );
  }

  // Vertical drag handle (for horizontal layout)
  return (
    <div
      onMouseDown={(e) => {
        e.preventDefault();
        onResize();
      }}
      onDoubleClick={onDoubleClick}
      className="w-[4px] cursor-col-resize h-full relative z-40 shrink-0 self-stretch flex justify-center"
      title="Kéo để thay đổi kích cỡ (nhấp đúp để ẩn)"
    >
      <div className="w-[2px] h-full transition-colors duration-150" style={{ backgroundColor: bgColor }} />
    </div>
  );
}
