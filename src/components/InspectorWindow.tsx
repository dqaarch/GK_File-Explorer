import React, { useState, useEffect, useRef } from "react";
import { registerHoverPane, getPaneAtWheelEvent } from "../utils/hoverPane";
import MultiSelectInspector from "./MultiSelectInspector";
import { FSItem, ViewMode } from "../types";
import {
  getFolderViewMode,
  setFolderViewMode,
  subscribeViewModeChange,
} from "../utils/viewModeStore";

interface InspectorWindowProps {
  explorer: any;
  folderName: string;
  folderPath: string;
  folderItems: FSItem[];
  width: number;
  onClose: () => void;
  onFileDoubleClick?: (item: FSItem) => void;
}

/**
 * Folder Inspector — read-only, view-only pane that mirrors the contents of
 * a folder selected from the main pane. Clicking items inside this pane
 * does NOT select them (we don't want users confused by what they can act
 * on). Context menu is intentionally absent.
 *
 * The view mode is shared with the main pane through the shared
 * `NEXUS_FOLDER_VIEW_MODES` localStorage record (see utils/viewModeStore),
 * so changing it here mirrors on the main pane and vice-versa.
 */
export default function InspectorWindow({
  explorer,
  folderName,
  folderPath,
  folderItems,
  width,
  onClose,
  onFileDoubleClick,
}: InspectorWindowProps) {
  const t = (vi: string, en: string) => explorer.language === "vi" ? vi : en;

  // ── View Mode state ──────────────────────────────────────────────────────
  // Source of truth = shared localStorage record NEXUS_FOLDER_VIEW_MODES so
  // both panes stay in sync. Initial seed = current explorer value or 6
  // (List view) so the inspector opens with a sensible default.
  const [inspViewMode, setInspViewMode] = useState<ViewMode>(() => {
    const saved = getFolderViewMode(folderPath);
    if (saved != null) return saved;
    return (explorer.viewMode as ViewMode) ?? 6;
  });

  // When the user navigates the inspector to a different folder, restore
  // that folder's saved view mode (or fall back to the global default).
  const lastPathRef = useRef<string>(folderPath);
  useEffect(() => {
    if (lastPathRef.current === folderPath) return;
    lastPathRef.current = folderPath;
    const saved = getFolderViewMode(folderPath);
    if (saved != null) {
      setInspViewMode(saved);
    } else {
      setInspViewMode((explorer.viewMode as ViewMode) ?? 6);
    }
  }, [folderPath, explorer.viewMode]);

  // Subscribe to view-mode changes from anywhere (main pane, this pane,
  // even other instances). When the change targets the folder we are
  // currently showing, mirror it locally.
  useEffect(() => {
    const unsubscribe = subscribeViewModeChange(({ path, mode }) => {
      if (path === folderPath) {
        setInspViewMode(mode);
      }
    });
    return unsubscribe;
  }, [folderPath]);

  // Ctrl + scroll wheel changes view mode inside the inspector pane.
  // Dispatched via the shared hovered-pane registry so each scroll reaches
  // EXACTLY ONE pane — no cross-pane leaks.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!rootRef.current) return;
    const unregister = registerHoverPane(rootRef.current, "inspector");
    return unregister;
  }, []);

  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (getPaneAtWheelEvent(e) !== "inspector") return;
      const target = e.target as HTMLElement | null;
      if (target?.closest(".explorer-context-menu")) return;
      if (target?.closest("input, textarea, [contenteditable]")) return;

      if (e.ctrlKey && e.deltaY !== 0) {
        e.preventDefault();
        e.stopPropagation();
        const step = e.deltaY > 0 ? 1 : -1;
        const newViewMode = Math.max(1, Math.min(7, inspViewMode + step)) as ViewMode;
        if (newViewMode !== inspViewMode) {
          setInspViewMode(newViewMode);
          setFolderViewMode(folderPath, newViewMode);
        }
      }
    };

    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, [inspViewMode, folderPath]);

  const handleViewModeChange = (mode: ViewMode) => {
    setInspViewMode(mode);
    setFolderViewMode(folderPath, mode);
  };

  return (
    <div
      ref={rootRef}
      className={`flex flex-col shrink-0 self-stretch`}
      style={{ width, minWidth: 280, height: "100%", overflow: "hidden" }}
    >
      <MultiSelectInspector
        selectedItems={folderItems}
        accentColor={explorer.accentColor}
        width={width}
        language={explorer.language}
        onClose={onClose}
        viewMode={inspViewMode}
        onViewModeChange={handleViewModeChange}
        onItemDoubleClick={onFileDoubleClick}
        headerCaption={
          <span className="flex items-center gap-2 truncate">
            <span className="truncate">{folderName}</span>
            <span className="text-[10px] font-mono text-stone-500 px-1 shrink-0">
              {folderItems.length}{" "}
              {folderItems.length === 1 ? t("mục", "item") : t("mục", "items")}
            </span>
          </span>
        }
      />
    </div>
  );
}