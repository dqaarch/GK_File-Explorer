import React, { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { ExplorerAPI } from "../useExplorer";
import SharedOpenWithList from "./SharedOpenWithList";

interface OpenWithSubmenuProps {
  explorer: ExplorerAPI;
  anchor: { x: number; y: number } | null;
  targetPath: string | null;
  onClose: () => void;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
}

export default function OpenWithSubmenu({ explorer, anchor, targetPath, onClose, onHoverEnter, onHoverLeave }: OpenWithSubmenuProps) {
  const { openWithState, language } = explorer;
  const [isExpanded, setIsExpanded] = useState(false);
  const t = (vi: string, en: string) => language === "vi" ? vi : en;

  useEffect(() => {
    setIsExpanded(false);
  }, [anchor?.x, anchor?.y, targetPath]);

  const recommendedApps = useMemo(() => {
    if (!openWithState?.candidates) return [];

    const recommendedOnly = [
      openWithState.association?.app,
      openWithState.candidates.default_app,
      ...(openWithState.candidates.recommended_apps ?? []),
    ].filter(Boolean);

    return recommendedOnly.filter((app, index, arr) => {
      const entry = app!;
      const key = (entry.handler_id || entry.path).toLowerCase();
      return arr.findIndex((candidate) => ((candidate!.handler_id || candidate!.path).toLowerCase() === key)) === index;
    });
  }, [openWithState]);

  const expandedApps = useMemo(() => {
    if (!openWithState?.candidates) return [];

    const fullList = [
      ...recommendedApps,
      ...openWithState.recentApps,
      openWithState.selectedApp,
      ...(openWithState.candidates.all_apps ?? []),
    ].filter(Boolean);

    return fullList.filter((app, index, arr) => {
      const entry = app!;
      const key = (entry.handler_id || entry.path).toLowerCase();
      return arr.findIndex((candidate) => ((candidate!.handler_id || candidate!.path).toLowerCase() === key)) === index;
    });
  }, [openWithState, recommendedApps]);

  const visibleApps = isExpanded ? expandedApps : recommendedApps;

  const dedupedRecommendedCount = recommendedApps.length;

  const totalAvailableApps = expandedApps.length;

  return (
    <div
      className="fixed z-[600] w-[300px] max-h-[min(70vh,420px)] rounded-xl fluent-menu overflow-hidden explorer-context-menu flex flex-col"
      style={{ top: anchor.y, left: anchor.x }}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <SharedOpenWithList
        apps={visibleApps}
        selectedKey={(openWithState.selectedApp?.handler_id || openWithState.selectedApp?.path)?.toLowerCase() ?? null}
        defaultKey={(openWithState.candidates?.default_app?.handler_id || openWithState.candidates?.default_app?.path)?.toLowerCase() ?? null}
        alwaysUseKey={openWithState.association?.source === "custom" ? (openWithState.association.app.handler_id || openWithState.association.app.path).toLowerCase() : null}
        language={language}
        expanded={isExpanded}
        showBrowseToggle={totalAvailableApps > dedupedRecommendedCount}
        accentColor={explorer.accentColor}
        onToggleExpanded={() => setIsExpanded((prev) => !prev)}
        browseLabel={isExpanded
          ? t("Thu gọn danh sách", "Show fewer apps")
          : t("Hiển thị thêm ứng dụng", "Show more apps")}
        onSelect={(app) => {
          void explorer.launchOpenWithApp?.(targetPath, app, Boolean(openWithState.alwaysUse)).catch(() => {
            explorer.setStatusMessage?.(t("Không thể mở bằng ứng dụng đã chọn.", "Could not open with the selected app."));
          });
          onClose();
        }}
      />

      <button
        onClick={async () => {
          try {
            const chosenApp = await explorer.browseOpenWithApp?.();
            if (chosenApp) {
              await explorer.launchOpenWithApp?.(targetPath, chosenApp, Boolean(openWithState.alwaysUse));
            }
          } catch {
            // handled by explorer state
          }
          onClose();
        }}
        className="shrink-0 flex w-full items-center gap-2.5 border-t border-white/10 px-3 py-2 text-left hover:bg-white/8 cursor-pointer"
      >
        <ExternalLink className="h-4 w-4 text-stone-300 shrink-0" />
        <span className="text-[12px] text-stone-100">{t("Duyệt file .exe thủ công", "Browse for an .exe manually")}</span>
      </button>
    </div>
  );
}
