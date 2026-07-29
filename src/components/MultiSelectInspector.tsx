import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FSItem, ViewMode, VIEW_MODE_LABELS, getIconSizePx } from "../types";
import {
  X, CheckSquare, HardDrive, Folder, File,
  LayoutGrid, LayoutList, ChevronDown, ChevronRight, Check,
  ArrowUpDown,
} from "lucide-react";
import { useFolderIcons } from "../hooks/useFolderIcons";
import { getThumbs, subscribeThumbs } from "../contexts/thumbnailsStore";
import { normalizeThumbnailSrc } from "../utils/thumbnail";

interface MultiSelectStats {
  folder_count: number;
  file_count: number;
  total_size: number;
}

interface MultiSelectInspectorProps {
  selectedItems: FSItem[];
  accentColor: string;
  width: number;
  language: "en" | "vi";
  onClose: () => void;
  /**
   * View Mode for the icon/grid layout. Optional — when omitted, the inspector
   * falls back to its default dense list (used when this component renders
   * the bottom panel of the main Explorer).
   *
   * When provided (e.g. from the Folder Inspector), a compact View Mode
   * dropdown appears in the header and switching the mode renders an icon
   * grid instead of the list.
   */
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  /**
   * Caption shown in the header instead of "X Selected" when this inspector
   * represents a folder rather than a multi-selection. Optional. Accepts a
   * React node so callers can include icons + counts in the same line.
   */
  headerCaption?: React.ReactNode;
  /**
   * Callback for double-clicking an item. Used by Folder Inspector to open files.
   * When not provided, double-click does nothing.
   */
  onItemDoubleClick?: (item: FSItem) => void;
}

export default function MultiSelectInspector({
  selectedItems,
  accentColor,
  width,
  language,
  onClose,
  viewMode,
  onViewModeChange,
  headerCaption,
  onItemDoubleClick,
}: MultiSelectInspectorProps) {
  // Get thumbs from global store
  const [thumbsMap, setThumbsMap] = useState<Record<string, string | null>>(() => getThumbs());
  const [stats, setStats] = useState<MultiSelectStats | null>(null);

  // Inspector's own state for sorting and filtering
  const [showHiddenItems, setShowHiddenItems] = useState(false);
  const [hideFileExtensions, setHideFileExtensions] = useState(false);
  const [sortBy, setSortBy] = useState<"name" | "size" | "type" | "date">("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  // Filter and sort items for display
  const visibleItems = useMemo(() => {
    let items = [...selectedItems];

    // Filter hidden items
    if (!showHiddenItems) {
      items = items.filter(item => {
        const name = item.name.toLowerCase();
        return !(name.startsWith(".") || name.startsWith("~$"));
      });
    }

    // Sort items
    items.sort((a, b) => {
      // Folders always come first
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }

      let cmp = 0;
      switch (sortBy) {
        case "name":
          cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
          break;
        case "size":
          cmp = (a.size || 0) - (b.size || 0);
          break;
        case "type":
          const extA = a.name.split(".").pop()?.toLowerCase() || "";
          const extB = b.name.split(".").pop()?.toLowerCase() || "";
          cmp = extA.localeCompare(extB);
          if (cmp === 0) {
            cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
          }
          break;
        case "date":
          const dateA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const dateB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          cmp = dateA - dateB;
          break;
      }

      return sortDirection === "asc" ? cmp : -cmp;
    });

    return items;
  }, [selectedItems, showHiddenItems, hideFileExtensions, sortBy, sortDirection]);

  // Preload Windows folder icons for every selected folder in a single
  // batched IPC so the list below renders sharp Explorer-style icons
  // without per-row fetch.
  const folderPaths = useMemo(
    () => selectedItems.filter((i) => i.type === "directory").map((i) => i.path),
    [selectedItems]
  );
  useFolderIcons(folderPaths, 32);

  // Subscribe to global thumbs updates
  useEffect(() => {
    const unsubscribe = subscribeThumbs(setThumbsMap);
    return unsubscribe;
  }, []);

  // Fetch multi-select stats from backend. Only meaningful when this
  // component is acting as a multi-select inspector (headerCaption absent).
  useEffect(() => {
    if (headerCaption) {
      setStats(null);
      return;
    }
    const paths = selectedItems.map(item => item.path);
    if (paths.length === 0) {
      setStats(null);
      return;
    }

    invoke<MultiSelectStats>("get_multi_select_stats", { paths })
      .then(result => {
        setStats(result);
      })
      .catch(err => {
        console.error("Failed to get multi-select stats:", err);
        setStats(null);
      });
  }, [selectedItems, headerCaption]);

  // Request thumbnails for selected items when they change (limit to 20 for performance)
  useEffect(() => {
    const fileItems = selectedItems.filter(item => item.type === "file");
    const filePaths = fileItems
      .slice(0, 20)
      .map(item => item.path)
      .filter(path => !getThumbs()[path]);

    if (filePaths.length === 0) return;

    // Request thumbnails for selected files
    invoke<Record<string, string | null>>(
      "get_thumbnails_batch",
      { paths: filePaths, size: 128 }
    ).then(result => {
      // Update global store with results
      const updates: Record<string, string | null> = {};
      for (const [path, dataUrl] of Object.entries(result)) {
        if (dataUrl) {
          updates[path] = dataUrl;
        }
      }
      if (Object.keys(updates).length > 0) {
        setThumbsMap(prev => ({ ...prev, ...updates }));
      }
    }).catch(console.error);
  }, [selectedItems]);

  const t = (vi: string, en: string) => (language === "vi" ? vi : en);

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const idx = Math.min(i, sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, idx)).toFixed(2)) + " " + sizes[idx];
  };

  // List View items
  const listItemPadding = "px-4 py-2.5";

  const isFolderInspector = Boolean(headerCaption);

  // Look up the current view-mode label + group for the icon-mode header.
  // When viewMode is undefined, we behave like the original list-only
  // inspector (preserved behavior for the multi-select bottom panel).
  const currentViewModeLabel =
    viewMode != null
      ? (VIEW_MODE_LABELS.find((entry) => entry.value === viewMode) ?? VIEW_MODE_LABELS[5])
      : null;
  const renderAsGrid = currentViewModeLabel?.group === "icon";

  // Compact icon-grid size for each preview tile (in pixels). Caps the
  // tile even when the user picks "Extra large icons" so the inspector
  // pane stays legible at typical widths.
  const gridTileSize = viewMode != null && viewMode >= 1 && viewMode <= 4
    ? getIconSizePx(viewMode).width
    : 64;

  // Determine how many columns fit per row, based on the inspector width.
  // We render up to N tiles per row using CSS grid auto-fill so the layout
  // reflows naturally when the user resizes the inspector pane.
  const minTilePx = gridTileSize + 24; // tile + label/gap budget
  const gridStyle = {
    gridTemplateColumns: `repeat(auto-fill, minmax(${minTilePx}px, 1fr))`,
  } as React.CSSProperties;

  const renderItemIcon = (item: FSItem, sizePx: number) => {
    if (item.type === "directory") {
      return (
        <Folder
          className="text-amber-400"
          style={{ width: sizePx, height: sizePx }}
          fill="currentColor"
        />
      );
    }
    const thumb = thumbsMap[item.path];
    if (thumb) {
      return (
        <img
          src={normalizeThumbnailSrc(thumb)}
          alt={item.name}
          className="object-contain"
          style={{ width: sizePx, height: sizePx }}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      );
    }
    return (
      <svg
        style={{ width: sizePx, height: sizePx }}
        className="text-stone-400"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    );
  };

  // Map list-mode viewModes to a renderer.
  // - 5 (Columns): Windows "Columns view" — items split into vertical
  //   columns with ~24 items each so users can scan long folders left-to-right.
  // - 6 (List): single-row, dense list with icon + name.
  // - 7 (Details): tabular rows (Name | Type | Size | Modified).
  const renderList = () => {
    if (viewMode === 5) {
      const colChunk = 24;
      const cols = Math.max(1, Math.ceil(visibleItems.length / colChunk));
      return (
        <div className="flex flex-row gap-0 p-2">
          {Array.from({ length: cols }).map((_, colIdx) => {
            const slice = visibleItems.slice(colIdx * colChunk, (colIdx + 1) * colChunk);
            if (slice.length === 0) return null;
            return (
              <div key={colIdx} className="flex-1 flex flex-col border-r border-white/5 last:border-r-0 min-w-[160px]">
                {slice.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-white/5 transition cursor-default"
                    title={item.path}
                    onDoubleClick={() => {
                      if (onItemDoubleClick && item.type !== "directory") {
                        onItemDoubleClick(item);
                      }
                    }}
                  >
                    <div className="shrink-0 w-5 h-5 flex items-center justify-center">
                      {renderItemIcon(item, 18)}
                    </div>
                    <span className="text-[12px] truncate text-stone-200">{hideFileExtensions ? item.name.replace(/\.[^.]+$/, "") : item.name}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      );
    }
    if (viewMode === 7) {
      return (
        <div className="flex flex-col">
          <div
            className="grid grid-cols-[1fr_80px_80px_140px] gap-2 px-4 py-1.5 text-[10px] uppercase tracking-wide text-stone-500 border-b border-white/10 sticky top-0"
            style={{ backgroundColor: "rgba(0,0,0,0.2)" }}
          >
            <span>{t("Tên", "Name")}</span>
            <span className="text-right">{t("Loại", "Type")}</span>
            <span className="text-right">{t("Kích thước", "Size")}</span>
            <span className="text-right">{t("Sửa đổi", "Modified")}</span>
          </div>
          {visibleItems.map((item) => {
            const isDir = item.type === "directory";
            const ext = item.name.split(".").pop()?.toLowerCase() || "";
            const typeLabel = isDir ? t("Thư mục", "Folder") : ext.toUpperCase();
            const modified = item.updatedAt
              ? new Date(item.updatedAt).toLocaleString(language === "vi" ? "vi-VN" : "en-US", { dateStyle: "short", timeStyle: "short" })
              : "";
            const displayName = hideFileExtensions && !isDir ? item.name.replace(/\.[^.]+$/, "") : item.name;
            return (
              <div
                key={item.id}
                className={`grid grid-cols-[1fr_80px_80px_140px] gap-2 items-center ${listItemPadding} transition cursor-default border-b border-white/5 hover:bg-white/5`}
                onDoubleClick={() => {
                  if (onItemDoubleClick && item.type !== "directory") {
                    onItemDoubleClick(item);
                  }
                }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="shrink-0 w-6 h-6 flex items-center justify-center">
                    {renderItemIcon(item, 22)}
                  </div>
                  <span className="text-[13px] truncate text-stone-200">{displayName}</span>
                </div>
                <span className="text-[11px] text-stone-400 text-right truncate">{typeLabel}</span>
                <span className="text-[11px] font-mono text-stone-400 text-right">
                  {isDir ? "" : formatSize(item.size)}
                </span>
                <span className="text-[11px] text-stone-400 text-right truncate">{modified}</span>
              </div>
            );
          })}
        </div>
      );
    }
    // Mode 6 (List) — single-line dense rows: icon + name.
    return (
      <div className="flex flex-col">
        {visibleItems.map((item) => (
          <div
            key={item.id}
            className={`flex items-center gap-3 ${listItemPadding} transition cursor-default border-b border-white/5 hover:bg-white/5`}
            onDoubleClick={() => {
              if (onItemDoubleClick && item.type !== "directory") {
                onItemDoubleClick(item);
              }
            }}
          >
            <div className="shrink-0 w-7 h-7 flex items-center justify-center">
              {renderItemIcon(item, 24)}
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-[13px] truncate text-stone-200 block">{hideFileExtensions && item.type !== "directory" ? item.name.replace(/\.[^.]+$/, "") : item.name}</span>
            </div>
            <div className="text-[11px] font-mono shrink-0 text-stone-400">
              {item.type === "directory" ? "" : formatSize(item.size)}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div
      className={`flex flex-col shrink-0 self-stretch`}
      style={{ width, minWidth: 280, height: "100%", overflow: "hidden" }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 border-b shrink-0 select-none"
        style={{
          background: `linear-gradient(135deg, ${accentColor}18 0%, transparent 100%)`,
          borderColor: `${accentColor}25`,
        }}
      >
        {isFolderInspector ? (
          <Folder className="w-5 h-5 shrink-0" style={{ color: accentColor }} fill="currentColor" />
        ) : (
          <CheckSquare
            className="w-5 h-5 shrink-0"
            style={{ color: accentColor }}
            fill="currentColor"
          />
        )}
        <span className="font-semibold text-[13px] truncate text-stone-200">
          {isFolderInspector && headerCaption
            ? (
              <span className="flex items-center gap-2 truncate">
                <span className="truncate">{headerCaption}</span>
                <span className="text-[10px] font-mono text-stone-500 px-1 shrink-0">
                  {visibleItems.length}{" "}
                  {visibleItems.length === 1 ? t("mục", "item") : t("mục", "items")}
                </span>
              </span>
            )
            : `${selectedItems.length} ${t("Đã chọn", "Selected")}`}
        </span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {isFolderInspector && (
            <>
              <InspectorSortMenu
                sortBy={sortBy}
                onSortBy={setSortBy}
                sortDirection={sortDirection}
                onSortDirection={setSortDirection}
                language={language}
              />
              {viewMode != null && onViewModeChange && (
                <InspectorViewModeMenu
                  viewMode={viewMode}
                  onChange={onViewModeChange}
                  language={language}
                  accentColor={accentColor}
                  showHiddenItems={showHiddenItems}
                  onToggleHidden={() => setShowHiddenItems(!showHiddenItems)}
                  hideFileExtensions={hideFileExtensions}
                  onToggleExtensions={() => setHideFileExtensions(!hideFileExtensions)}
                />
              )}
            </>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg transition-colors hover:bg-white/10 text-stone-400"
            title={t("Đóng", "Close")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Stats Summary Row - only meaningful in multi-select mode */}
      {!isFolderInspector && stats && (
        <div
          className="px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] font-medium border-b shrink-0 border-white/10 text-white/90"
        >
          <span className="flex items-center gap-1.5">
            <Folder className="w-3.5 h-3.5 text-amber-400" />
            <span className="font-semibold text-amber-400">{stats.folder_count}</span>
            <span>{t("Thư mục", "Folders")}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <File className="w-3.5 h-3.5 text-blue-400" />
            <span className="font-semibold text-blue-400">{stats.file_count}</span>
            <span>{t("Tệp", "Files")}</span>
          </span>
          <span className="ml-auto flex items-center gap-1.5 min-w-fit">
            <HardDrive className="w-3.5 h-3.5 text-white/60" />
            <span className="font-semibold text-white/90">{formatSize(stats.total_size)}</span>
          </span>
        </div>
      )}

      {/* Items display */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {renderAsGrid ? (
          <div className="grid gap-2 p-3" style={gridStyle}>
            {visibleItems.map((item) => (
              <div
                key={item.id}
                className="flex flex-col items-center gap-1 p-2 rounded-lg hover:bg-white/5 transition"
                onDoubleClick={() => {
                  if (onItemDoubleClick && item.type !== "directory") {
                    onItemDoubleClick(item);
                  }
                }}
              >
                <div
                  className="flex items-center justify-center"
                  style={{ width: gridTileSize, height: gridTileSize }}
                >
                  {renderItemIcon(item, gridTileSize * 0.75)}
                </div>
                <p className="text-[11px] text-stone-200 text-center line-clamp-2 break-words w-full">
                  {hideFileExtensions && item.type !== "directory" ? item.name.replace(/\.[^.]+$/, "") : item.name}
                </p>
              </div>
            ))}
          </div>
        ) : (
          renderList()
        )}
        {visibleItems.length === 0 && (
          <div className="flex items-center justify-center h-full text-[12px] text-stone-500 px-6 text-center">
            {t("Thư mục trống", "This folder is empty")}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Compact View Mode menu shown in the Folder Inspector header. Mirrors
 * the visual style of the main pane's View Mode submenu:
 * - Row 1-7: View mode items + vertical slider
 * - Show hidden items toggle
 * - Hide file extensions toggle
 */
function InspectorViewModeMenu({
  viewMode,
  onChange,
  language,
  accentColor,
  showHiddenItems,
  onToggleHidden,
  hideFileExtensions,
  onToggleExtensions,
}: {
  viewMode: ViewMode;
  onChange: (mode: ViewMode) => void;
  language: "en" | "vi";
  accentColor: string;
  showHiddenItems: boolean;
  onToggleHidden: () => void;
  hideFileExtensions: boolean;
  onToggleExtensions: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [localSliderValue, setLocalSliderValue] = useState<number | null>(null);
  const [sliderDragging, setSliderDragging] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const t = (vi: string, en: string) => (language === "vi" ? vi : en);
  const currentLabel =
    VIEW_MODE_LABELS.find((entry) => entry.value === viewMode) ?? VIEW_MODE_LABELS[5];

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && wrapperRef.current && !wrapperRef.current.contains(target)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.currentTarget.value);
    setLocalSliderValue(val);
    if (!sliderDragging) {
      setSliderDragging(true);
    }
    onChange(val as ViewMode);
  };

  const handleSliderComplete = () => {
    if (sliderDragging) {
      setSliderDragging(false);
      setLocalSliderValue(null);
    }
  };

  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
        title={t("Đổi chế độ xem", "Change view mode")}
        className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-white/10 transition cursor-pointer text-stone-300 hover:text-white"
      >
        {currentLabel.group === "list" ? (
          <LayoutList className="w-3.5 h-3.5 text-sky-400" />
        ) : (
          <LayoutGrid className="w-3.5 h-3.5 text-orange-400" />
        )}
        <span className="text-[10px] font-medium">
          {t(currentLabel.vi, currentLabel.en)}
        </span>
        <ChevronDown className="w-3 h-3 text-stone-500" />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 fluent-menu rounded-xl z-[600] overflow-hidden text-xs min-w-[290px] animate-in fade-in duration-100 text-stone-200"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* Row layout: view mode items on the left + vertical slider on the right */}
          <div className="flex items-stretch py-1">
            {/* Left: 7 view mode items */}
            <div className="min-w-[230px] flex-1">
              {VIEW_MODE_LABELS.map(({ value, vi, en, group }) => (
                <button
                  key={value}
                  onClick={() => {
                    onChange(value);
                  }}
                  className="flex items-center justify-between w-full px-3 py-1.5 cursor-pointer transition hover:bg-white/5 text-stone-200"
                >
                  <div className="flex items-center gap-2">
                    {group === "list" ? (
                      <LayoutList className="w-3 h-3 text-sky-400" />
                    ) : (
                      <LayoutGrid className="w-3 h-3 text-orange-400" />
                    )}
                    <span>{t(vi, en)}</span>
                  </div>
                  {viewMode === value && <Check className="w-3 h-3 text-emerald-400" />}
                </button>
              ))}
            </div>

            {/* Vertical divider */}
            <div className="w-px shrink-0" style={{ backgroundColor: "rgba(255,255,255,0.08)" }} />

            {/* Right: vertical slider */}
            <div
              className="flex items-center justify-center px-2 select-none shrink-0"
              style={{ minHeight: "210px" }}
              title={language === "vi"
                ? "Kéo thanh trượt để đổi chế độ xem (1=Extra Large → 7=Details)"
                : "Drag the slider to change view mode (1=Extra Large → 7=Details)"}
            >
              <input
                type="range"
                min={1}
                max={7}
                step="1"
                value={localSliderValue ?? viewMode}
                onChange={handleSliderChange}
                onMouseUp={handleSliderComplete}
                onMouseLeave={handleSliderComplete}
                onTouchEnd={handleSliderComplete}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className="view-slider-v-minimal-compact cursor-pointer"
                style={{ accentColor }}
                aria-label="View mode slider"
              />
            </div>
          </div>

          {/* Divider */}
          <div className="mx-2 border-t border-white/5" />

          {/* Show hidden items toggle */}
          <button
            onClick={() => {
              onToggleHidden();
            }}
            className="flex items-center justify-between w-full px-3 py-1.5 cursor-pointer transition hover:bg-white/5 text-stone-200"
          >
            <span>{t("Hiện tệp ẩn", "Show hidden items")}</span>
            {showHiddenItems && <Check className="w-3 h-3 text-emerald-400" />}
          </button>

          {/* Hide file extensions toggle */}
          <button
            onClick={() => {
              onToggleExtensions();
            }}
            className="flex items-center justify-between w-full px-3 py-1.5 cursor-pointer transition hover:bg-white/5 text-stone-200"
          >
            <span>{t("Ẩn phần mở rộng tệp", "Hide file extensions")}</span>
            {hideFileExtensions && <Check className="w-3 h-3 text-emerald-400" />}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Sort menu for Folder Inspector header. Shows current sort field and direction.
 * Layout matches row 4 from main pane context menu.
 */
function InspectorSortMenu({
  sortBy,
  onSortBy,
  sortDirection,
  onSortDirection,
  language,
}: {
  sortBy: "name" | "size" | "type" | "date";
  onSortBy: (sort: "name" | "size" | "type" | "date") => void;
  sortDirection: "asc" | "desc";
  onSortDirection: (dir: "asc" | "desc") => void;
  language: "en" | "vi";
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const t = (vi: string, en: string) => (language === "vi" ? vi : en);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && wrapperRef.current && !wrapperRef.current.contains(target)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
        title={t("Sắp xếp", "Sort")}
        className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-white/10 transition cursor-pointer text-stone-300 hover:text-white"
      >
        <ArrowUpDown className="w-3.5 h-3.5 text-sky-400" />
        <span className="text-[10px] font-medium capitalize">{sortBy}</span>
        <ChevronDown className="w-3 h-3 text-stone-500" />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 fluent-menu rounded-xl z-[600] flex flex-col text-xs min-w-[210px] animate-in fade-in duration-100 text-stone-200 overflow-hidden"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {([
            { val: "name" as const, vi: "Sắp xếp theo Tên", en: "Sort by Name" },
            { val: "size" as const, vi: "Dung lượng dữ liệu", en: "Data Size" },
            { val: "type" as const, vi: "Định dạng tệp tin", en: "File Type" },
            { val: "date" as const, vi: "Mốc sửa đổi", en: "Modified Date" },
          ]).map(({ val, vi, en }) => (
            <button
              key={val}
              onClick={() => {
                onSortBy(val);
              }}
              className="flex items-center justify-between w-full px-3 py-1.5 cursor-pointer transition hover:bg-white/5 text-stone-200"
            >
              <span>{t(vi, en)}</span>
              {sortBy === val && <Check className="w-3 h-3 text-indigo-400" />}
            </button>
          ))}

          <div className="mx-2 border-t border-white/10" />

          <button
            onClick={() => {
              onSortDirection("asc");
            }}
            className="flex items-center justify-between w-full px-3 py-1.5 cursor-pointer transition hover:bg-white/5 text-stone-200"
          >
            <span>{t("Tăng dần (A - Z)", "Ascending (A - Z)")}</span>
            {sortDirection === "asc" && <Check className="w-3 h-3 text-emerald-400" />}
          </button>
          <button
            onClick={() => {
              onSortDirection("desc");
            }}
            className="flex items-center justify-between w-full px-3 py-1.5 cursor-pointer transition hover:bg-white/5 text-stone-200"
          >
            <span>{t("Giảm dần (Z - A)", "Descending (Z - A)")}</span>
            {sortDirection === "desc" && <Check className="w-3 h-3 text-emerald-400" />}
          </button>
        </div>
      )}
    </div>
  );
}
