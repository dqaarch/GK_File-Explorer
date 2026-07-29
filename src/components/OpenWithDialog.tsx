import React, { useEffect, useMemo, useRef } from "react";
import { ExternalLink, FolderOpen, RotateCcw, X } from "lucide-react";
import { ExplorerAPI } from "../useExplorer";
import SharedOpenWithList from "./SharedOpenWithList";
import { useOpenWithIcons } from "../hooks/useOpenWithIcons";

interface Props {
  explorer: ExplorerAPI;
}

export default function OpenWithDialog({ explorer }: Props) {
  const {
    openWithState,
    setOpenWithState,
    browseOpenWithApp,
    confirmOpenWith,
    clearOpenWithPreference,
    closeOpenWithModal,
    language,
  } = explorer;
  const primaryActionRef = useRef<HTMLButtonElement>(null);

  const t = (vi: string, en: string) => language === "vi" ? vi : en;
  const isVisible = Boolean(openWithState?.visible);
  const fileName = openWithState?.targetPath?.split(/[\\/]/).pop() || openWithState?.targetPath || "";
  const rememberedApp = openWithState?.association?.source === "custom" ? openWithState.association.app : null;
  const extension = openWithState?.candidates?.extension ?? (() => {
    const dot = fileName.lastIndexOf(".");
    return dot > 0 ? fileName.slice(dot).toLowerCase() : null;
  })();

  const candidateApps = useMemo(() => {
    if (!openWithState) return [];

    const recommendedOnly = [
      openWithState.association?.app,
      openWithState.candidates?.default_app,
      ...(openWithState.candidates?.recommended_apps ?? []),
      ...openWithState.recentApps,
      openWithState.selectedApp,
    ].filter(Boolean);

    const fullList = [
      ...recommendedOnly,
      ...(openWithState.candidates?.all_apps ?? []),
    ].filter(Boolean);

    const sourceApps = openWithState.mode === "browse" ? fullList : recommendedOnly;

    return sourceApps.filter((app, index, arr) => {
      const entry = app!;
      const key = entry.handler_id?.toLowerCase() || entry.path.toLowerCase();
      return arr.findIndex((candidate) => {
        const candidateKey = candidate!.handler_id?.toLowerCase() || candidate!.path.toLowerCase();
        return candidateKey === key;
      }) === index;
    });
  }, [openWithState]);

  useOpenWithIcons(candidateApps, isVisible);

  const hasSelection = Boolean(openWithState?.selectedApp);
  const systemDefaultKey = openWithState?.candidates?.default_app
    ? (openWithState.candidates.default_app.handler_id || openWithState.candidates.default_app.path).toLowerCase()
    : null;
  const customAssociationKey = openWithState?.association && openWithState.association.source === "custom"
    ? (openWithState.association.app.handler_id || openWithState.association.app.path).toLowerCase()
    : null;

  useEffect(() => {
    if (!isVisible || !openWithState) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeOpenWithModal();
        return;
      }

      if (event.key === "Enter" && openWithState.selectedApp) {
        event.preventDefault();
        void confirmOpenWith();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    primaryActionRef.current?.focus();
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeOpenWithModal, confirmOpenWith, isVisible, openWithState]);

  if (!isVisible || !openWithState || !openWithState.targetPath) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 px-4" onMouseDown={closeOpenWithModal}>
      <div
        className="w-full max-w-[520px] overflow-hidden rounded-xl border border-white/10 bg-overlay text-stone-100 shadow-[0_24px_70px_rgba(0,0,0,0.45)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="min-w-0 pr-4">
            <div className="text-sm text-stone-100">{t("Bạn muốn mở tệp này bằng cách nào?", "How do you want to open this file?")}</div>
            <div className="mt-0.5 truncate text-xs text-stone-400">{fileName}</div>
          </div>
          <button
            onClick={closeOpenWithModal}
            className="rounded-md p-1.5 text-stone-400 hover:bg-white/10 hover:text-white cursor-pointer"
            title={t("Đóng", "Close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 pt-4 pb-3">
          <div className="mb-2 text-xs text-stone-400">
            {extension
              ? t(`Ứng dụng được đề xuất cho ${extension}`, `Suggested apps for ${extension}`)
              : t("Ứng dụng được đề xuất", "Suggested apps")}
          </div>

          <div className="max-h-[320px] overflow-y-auto goku-thin-scroll rounded-lg border border-white/10 bg-black/15">
            <SharedOpenWithList
              apps={candidateApps}
              selectedKey={(openWithState.selectedApp?.handler_id || openWithState.selectedApp?.path)?.toLowerCase() ?? null}
              defaultKey={systemDefaultKey}
              alwaysUseKey={customAssociationKey}
              language={language}
              expanded={openWithState.mode === "browse"}
              accentColor={explorer.accentColor}
              onSelect={(app) => setOpenWithState((prev) => ({ ...prev, selectedApp: app }))}
            />
          </div>

          <button
            onClick={() => setOpenWithState((prev) => ({
              ...prev,
              mode: prev.mode === "browse" ? "picker" : "browse",
            }))}
            disabled={openWithState.loading}
            className="mt-3 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-white/6 disabled:opacity-50 cursor-pointer"
          >
            <ExternalLink className="h-4 w-4 shrink-0 text-cyan-300" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-stone-100">
                {openWithState.mode === "browse"
                  ? t("Thu gọn về ứng dụng đề xuất", "Show only suggested apps")
                  : t("Chọn ứng dụng khác", "Choose another app")}
              </div>
              <div className="truncate text-[11px] text-stone-500">
                {openWithState.mode === "browse"
                  ? t("Chỉ hiển thị lại danh sách ứng dụng được đề xuất", "Return to the smaller suggested app list")
                  : t("Mở rộng để xem thêm ứng dụng giống kiểu Windows Explorer", "Expand to see more apps like Windows Explorer")}
              </div>
            </div>
          </button>

          <button
            onClick={() => void browseOpenWithApp()}
            disabled={openWithState.loading}
            className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-white/6 disabled:opacity-50 cursor-pointer"
          >
            <FolderOpen className="h-4 w-4 shrink-0 text-stone-300" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-stone-100">
                {openWithState.loading ? t("Đang duyệt ứng dụng...", "Browsing for an app...") : t("Duyệt file .exe thủ công", "Browse for an .exe manually")}
              </div>
              <div className="truncate text-[11px] text-stone-500">
                {t("Chỉ dùng khi ứng dụng bạn cần không có trong danh sách", "Use only if the app you want is not in the list")}
              </div>
            </div>
          </button>

          {openWithState.mode === "browse" && (
            <label className="mt-2 flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-white/4 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(openWithState.alwaysUse)}
                onChange={(e) => setOpenWithState((prev) => ({ ...prev, alwaysUse: e.target.checked }))}
                className="mt-0.5 accent-cyan-500"
              />
              <div>
                <div className="text-sm text-stone-100">{t("Đặt app đã chọn làm mặc định", "Set the selected app as default")}</div>
                <div className="mt-0.5 text-[11px] text-stone-500">{t("Áp dụng cả khi bạn chọn ứng dụng khác hoặc duyệt file .exe thủ công", "Applies when you select another listed app or browse for an .exe manually")}</div>
              </div>
            </label>
          )}

          {hasSelection && (
            <label className="mt-3 flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-white/4 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(openWithState.alwaysUse)}
                onChange={(e) => setOpenWithState((prev) => ({ ...prev, alwaysUse: e.target.checked }))}
                className="mt-0.5 accent-cyan-500"
              />
              <div>
                <div className="text-sm text-stone-100">{t("Luôn sử dụng ứng dụng này để mở loại tệp này", "Always use this app to open this kind of file")}</div>
                <div className="mt-0.5 text-[11px] text-stone-500">{t("Thiết lập sẽ được lưu theo phần mở rộng của tệp", "This choice will be remembered for the file extension")}</div>
              </div>
            </label>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-white/10 bg-black/10 px-4 py-3">
          <div>
            {rememberedApp && (
              <button
                onClick={() => void clearOpenWithPreference()}
                className="inline-flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-red-200 hover:bg-red-500/10 cursor-pointer"
              >
                <RotateCcw className="h-4 w-4" />
                {t("Xóa mặc định", "Clear default")}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={closeOpenWithModal}
              className="rounded-md px-3.5 py-2 text-sm text-stone-300 hover:bg-white/8 cursor-pointer"
            >
              {t("Hủy", "Cancel")}
            </button>
            <button
              ref={primaryActionRef}
              onClick={() => void confirmOpenWith()}
              disabled={!hasSelection}
              className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
            >
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
