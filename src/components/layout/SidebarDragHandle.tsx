import React from "react";

interface SidebarDragHandleProps {
  resizing: "sidebar" | "details" | null;
  onResize: () => void;
  onDoubleClick: () => void;
  accentColor: string;
  theme: string;
}

export function SidebarDragHandle({
  resizing,
  onResize,
  onDoubleClick,
  accentColor,
  theme,
}: SidebarDragHandleProps) {
  return (
    <div
      onMouseDown={(e) => {
        e.preventDefault();
        onResize();
      }}
      onDoubleClick={onDoubleClick}
      className="w-[4px] cursor-col-resize h-full relative z-40 shrink-0 group flex justify-center"
      title="Kéo để thay đổi kích cỡ Sidebar (Nhấp đúp chuột để đặt lại)"
    >
      <div
        className="w-[2px] h-full transition-colors duration-150"
        style={{
          backgroundColor:
            resizing === "sidebar"
              ? accentColor
              : theme === "light"
              ? "#e5e5e5"
              : "rgba(255,255,255,0.05)",
        }}
      />
    </div>
  );
}
