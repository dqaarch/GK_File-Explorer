import { memo, ReactNode } from "react";

interface ModelLoadingProgressProps {
  visible: boolean;
  label: string;
  percent: number;
  icon?: "3d" | "gs";
  etaSeconds?: number | null;
  description?: ReactNode;
  accentColor?: string;
}

function formatEta(seconds: number): string {
  const rounded = Math.ceil(seconds);
  return "~" + rounded + "s remaining";
}

export const ModelLoadingProgress = memo(function ModelLoadingProgress({
  visible,
  label,
  percent,
  icon = "3d",
  etaSeconds,
  description,
  accentColor,
}: ModelLoadingProgressProps) {
  if (!visible) return null;

  const resolvedAccent = accentColor || "var(--accent-primary)";
  const iconBg = icon === "gs" ? "bg-blue-500/20" : "bg-white/5";

  let etaLabel: string | null = null;
  if (etaSeconds !== undefined && etaSeconds !== null) {
    etaLabel = etaSeconds > 0 ? formatEta(etaSeconds) : "Complete";
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/65">
      <div
        className="border border-white/10 rounded-lg shadow-2xl w-[420px] max-w-[90vw] p-6"
        style={{ backgroundColor: "var(--app-bg)" }}
      >
        <div className="flex items-start gap-3">
          <div className={"w-10 h-10 rounded-full " + iconBg + " flex items-center justify-center shrink-0"}>
            <div
              className="w-5 h-5 border-2 rounded-full animate-spin"
              style={{
                borderColor: "rgba(255,255,255,0.15)",
                borderTopColor: resolvedAccent
              }}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium mb-1" style={{ color: "var(--fg-1)" }}>
              {icon === "gs" ? "Gaussian Splatting" : "3D Model"}
            </div>
            <div className="text-xs mb-3 truncate" style={{ color: "var(--text-secondary)" }} title={label}>
              {label}
            </div>
            <div
              className="w-full rounded-full h-2 overflow-hidden"
              style={{ backgroundColor: "rgba(255,255,255,0.1)" }}
            >
              <div
                className="h-2 transition-all duration-200 ease-out"
                style={{
                  width: Math.max(0, Math.min(100, percent)) + "%",
                  background: "linear-gradient(to right, " + resolvedAccent + ", " + resolvedAccent + "cc)"
                }}
              />
            </div>
            <div className="flex items-center justify-between mt-2 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
              <span>{Math.round(percent)}%</span>
              {etaLabel && <span>{etaLabel}</span>}
            </div>
          </div>
        </div>
        {description && (
          <div className="mt-4 text-[10px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            {description}
          </div>
        )}
      </div>
    </div>
  );
});