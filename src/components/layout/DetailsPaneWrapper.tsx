import React from "react";

interface DetailsPaneWrapperProps {
  isVertical: boolean;
  width?: number;
  height?: number;
  children: React.ReactNode;
}

export function DetailsPaneWrapper({
  isVertical,
  width,
  height,
  children,
}: DetailsPaneWrapperProps) {
  return (
    <div
      className="shrink-0 overflow-hidden goku-details-wrapper"
      style={
        isVertical
          ? { height, width: "100%" }
          : { width, height: "100%" }
      }
    >
      {children}
    </div>
  );
}
