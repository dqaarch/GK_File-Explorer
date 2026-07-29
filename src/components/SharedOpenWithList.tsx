import React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { OpenWithApp } from "../TauriFileSystem";
import { useOpenWithIcons } from "../hooks/useOpenWithIcons";

interface SharedOpenWithListProps {
  apps: OpenWithApp[];
  selectedKey?: string | null;
  defaultKey?: string | null;
  alwaysUseKey?: string | null;
  language: "vi" | "en";
  expanded?: boolean;
  showBrowseToggle?: boolean;
  accentColor?: string;
  onSelect: (app: OpenWithApp) => void;
  onToggleExpanded?: () => void;
  browseLabel?: string;
}

export default function SharedOpenWithList({
  apps,
  selectedKey,
  defaultKey,
  alwaysUseKey,
  language,
  expanded = false,
  showBrowseToggle = false,
  accentColor,
  onSelect,
  onToggleExpanded,
  browseLabel,
}: SharedOpenWithListProps) {
  const icons = useOpenWithIcons(apps, true);
  const t = (vi: string, en: string) => language === "vi" ? vi : en;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto goku-thin-scroll py-1">
        {apps.map((app) => {
          const key = (app.handler_id || app.path).toLowerCase();
          const iconSrc = icons[key] || app.icon_data_url || undefined;
          const isSelected = selectedKey === key;
          const isDefault = defaultKey === key;
          const isAlwaysUse = alwaysUseKey === key;
          const fallbackLabel = (app.name || "?").trim().charAt(0).toUpperCase() || "?";

          return (
            <button
              key={key}
              onClick={() => onSelect(app)}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left cursor-pointer ${
                isSelected ? "" : "hover:bg-white/6"
              }`}
              style={isSelected ? { backgroundColor: accentColor ? `${accentColor}1F` : "rgba(0,0,0,0.08)" } : undefined}
            >
              <div
                className={`flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-sm ${isSelected ? "" : "bg-white/5"}`}
                style={isSelected ? { backgroundColor: accentColor ? `${accentColor}26` : "rgba(0,0,0,0.1)" } : undefined}
              >
                {iconSrc ? (
                  <img src={iconSrc} alt={app.name} className="h-4 w-4 object-contain" fetchPriority="high" />
                ) : (
                  <span className="text-[10px] font-semibold text-stone-200">{fallbackLabel}</span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 truncate text-[12px] text-stone-100 leading-tight">
                  <span className="truncate">{app.name}</span>
                  {isDefault && (
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[9px]"
                      style={{
                        backgroundColor: accentColor ? `${accentColor}26` : "rgba(0,0,0,0.15)",
                        color: accentColor || "#ffffff"
                      }}
                    >
                      {t("Mặc định", "Default")}
                    </span>
                  )}
                  {isAlwaysUse && (
                    <span className="rounded-full bg-cyan-500/10 px-1.5 py-0.5 text-[9px] text-cyan-200">
                      {t("Luôn dùng", "Always use")}
                    </span>
                  )}
                  {app.source === "custom" && (
                    <span className="rounded-full bg-white/8 px-1.5 py-0.5 text-[9px] text-stone-300">
                      {t("Tùy chọn", "Custom")}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}

        {apps.length === 0 && (
          <div className="px-3 py-4 text-sm text-stone-400">
            {t("Không có ứng dụng đề xuất. Hãy chọn ứng dụng khác trên PC.", "No suggested apps found. Choose another app on this PC.")}
          </div>
        )}
      </div>

      {showBrowseToggle && onToggleExpanded && (
        <button
          onClick={onToggleExpanded}
          className="shrink-0 flex w-full items-center justify-between gap-2.5 border-t border-white/10 px-3 py-2 text-left hover:bg-white/8 cursor-pointer"
        >
          <span className="text-[12px] text-stone-100">
            {browseLabel ?? (expanded ? t("Thu gọn về ứng dụng đề xuất", "Show only suggested apps") : t("Hiển thị thêm ứng dụng", "Show more apps"))}
          </span>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-stone-300 shrink-0" />
          ) : (
            <ChevronDown className="h-4 w-4 text-stone-300 shrink-0" />
          )}
        </button>
      )}
    </>
  );
}
