import React, { useEffect, useRef, useState } from "react";
import {
  FolderOpen,
  ExternalLink,
  Terminal as TerminalIcon,
  Edit3,
  Disc3,
  RefreshCw,
  Info,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ExplorerAPI } from "../useExplorer";
import { DriveInfo, setVolumeLabel, openInTerminal } from "../TauriFileSystem";
import { dropdownEventBus, DROPDOWN_EVENTS } from "../utils/dropdownEvents";

interface DriveContextMenuProps {
  explorer: ExplorerAPI;
  anchor: { x: number; y: number } | null;
  drive: DriveInfo | null;
  onClose: () => void;
}

const EDGE_PADDING = 6;

export default function DriveContextMenu({ explorer, anchor, drive, onClose }: DriveContextMenuProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const t = (vi: string, en: string) => explorer.language === "vi" ? vi : en;

  // Measure the rendered panel after mount and flip position when overflowing the viewport.
  useEffect(() => {
    if (!anchor || !drive) return;
    const panel = panelRef.current;
    if (!panel) return;

    let rafId: number;
    const adjust = () => {
      const w = panel.offsetWidth || 220;
      const h = panel.offsetHeight || 220;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rect = panel.getBoundingClientRect();
      // Already has inline left/top from initial render — update if overflow
      if (rect.right > vw - EDGE_PADDING || rect.bottom > vh - EDGE_PADDING) {
        let left = anchor.x;
        let top = anchor.y;
        if (left + w + EDGE_PADDING > vw) left = Math.max(EDGE_PADDING, vw - w - EDGE_PADDING);
        if (top + h + EDGE_PADDING > vh) top = Math.max(EDGE_PADDING, vh - h - EDGE_PADDING);
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
      }
    };

    rafId = requestAnimationFrame(adjust);
    return () => cancelAnimationFrame(rafId);
  }, [anchor?.x, anchor?.y, drive]);

  useEffect(() => {
    if (!anchor || !drive) return;
    dropdownEventBus.emit(DROPDOWN_EVENTS.CONTEXT_MENU_OPENED);
    const closeAll = () => onClose();
    const unsubClose = dropdownEventBus.on(DROPDOWN_EVENTS.CLOSE_ALL_DROPDOWNS, closeAll);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unsubClose();
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, drive, onClose]);

  if (!anchor || !drive) return null;

  const close = () => {
    setRenaming(false);
    setErrorMsg(null);
    onClose();
  };

  const handleOpen = () => {
    explorer.navigateTo(drive.path);
    close();
  };

  const handleOpenInNewTab = () => {
    if (explorer.createNewTab) {
      explorer.createNewTab(drive.path);
    } else {
      explorer.navigateTo(drive.path);
    }
    close();
  };

  const handleOpenInTerminal = async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      await openInTerminal(drive.path);
    } catch (e: any) {
      setErrorMsg(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
    close();
  };

  const startRename = () => {
    setRenameValue(drive.label);
    setRenaming(true);
    setErrorMsg(null);
  };

  const submitRename = async () => {
    const next = renameValue.trim();
    if (next === drive.label) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      await setVolumeLabel(drive.path, next);
      if (explorer.refreshDrives) await explorer.refreshDrives();
      setRenaming(false);
    } catch (e: any) {
      setErrorMsg(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    if (explorer.refreshDrives) await explorer.refreshDrives();
    close();
  };

  const handleProperties = async () => {
    try {
      await invoke("open_file_properties", { path: drive.path });
    } catch (e: any) {
      setErrorMsg(String(e?.message ?? e));
    }
    close();
  };

  const handleEject = () => {
    setErrorMsg(t(
      "Tính năng Eject sẽ được bổ sung trong phiên bản sau.",
      "Eject will be added in a future release.",
    ));
  };

  const isEjectable = drive.driveType === "removable" || drive.driveType === "cdrom" || drive.driveType === "network";

  return (
    <div
      ref={panelRef}
      role="menu"
      className="fixed fluent-menu rounded-xl explorer-context-menu py-1.5 z-[600] min-w-[220px]"
      style={{ left: anchor.x, top: anchor.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {renaming ? (
        <div className="px-3 py-2">
          <label className="block text-[10px] uppercase tracking-wider text-stone-500 mb-1">
            {t("Đổi tên volume", "Rename volume")}
          </label>
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              else if (e.key === "Escape") { setRenaming(false); }
            }}
            disabled={busy}
            className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-[12px] outline-none focus:border-white/30"
            maxLength={32}
          />
          <div className="flex justify-end gap-2 mt-2">
            <button
              type="button"
              onClick={() => setRenaming(false)}
              className="text-[11px] px-2 py-1 rounded text-stone-300 hover:bg-white/10 cursor-pointer"
            >
              {t("Huỷ", "Cancel")}
            </button>
            <button
              type="button"
              onClick={submitRename}
              disabled={busy}
              className="text-[11px] px-2 py-1 rounded bg-white/15 hover:bg-white/25 text-white cursor-pointer disabled:opacity-50"
            >
              {t("Lưu", "Save")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <DriveMenuItem
            icon={<FolderOpen className="w-3.5 h-3.5" />}
            label={t("Mở", "Open")}
            shortcut=""
            onClick={handleOpen}
          />
          <DriveMenuItem
            icon={<ExternalLink className="w-3.5 h-3.5" />}
            label={t("Mở trong cửa sổ mới", "Open in new window")}
            shortcut=""
            onClick={handleOpenInNewTab}
          />
          <DriveMenuItem
            icon={<TerminalIcon className="w-3.5 h-3.5" />}
            label={t("Mở trong Terminal", "Open in Terminal")}
            shortcut=""
            onClick={handleOpenInTerminal}
            disabled={busy}
          />
          <DriveMenuDivider />
          <DriveMenuItem
            icon={<Edit3 className="w-3.5 h-3.5" />}
            label={t("Đổi tên…", "Rename…")}
            shortcut=""
            onClick={startRename}
          />
          <DriveMenuItem
            icon={<Disc3 className="w-3.5 h-3.5" />}
            label={t("Eject", "Eject")}
            shortcut=""
            onClick={handleEject}
            disabled={!isEjectable}
            title={!isEjectable
              ? t("Không thể eject ổ này", "This drive cannot be ejected")
              : t("Eject sẽ thêm trong bản sau", "Eject coming soon")}
          />
          <DriveMenuItem
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            label={t("Refresh", "Refresh")}
            shortcut=""
            onClick={handleRefresh}
          />
          <DriveMenuDivider />
          <DriveMenuItem
            icon={<Info className="w-3.5 h-3.5" />}
            label={t("Thuộc tính", "Properties")}
            shortcut=""
            onClick={handleProperties}
          />
          {errorMsg && (
            <div className="px-3 py-2 text-[10px] text-red-400 border-t border-white/5 mt-1">
              {errorMsg}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DriveMenuItem({
  icon, label, shortcut, onClick, disabled, title,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      title={title}
      className={`drive-menu-row w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] transition ${
        disabled
          ? "opacity-40 cursor-not-allowed"
          : "cursor-pointer hover:bg-white/10"
      }`}
      style={{ color: disabled ? "var(--text-muted)" : "var(--text-primary)" }}
    >
      <span className="shrink-0" style={{ color: "var(--text-secondary)" }}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {shortcut && <span className="text-[10px] ml-2" style={{ color: "var(--text-muted)" }}>{shortcut}</span>}
    </button>
  );
}

function DriveMenuDivider() {
  return <div className="my-1 mx-2 border-t border-white/5" />;
}