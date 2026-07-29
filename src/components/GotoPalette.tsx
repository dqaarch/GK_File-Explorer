import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { NavigationDestination } from "../types";
import type { ExplorerAPI } from "../useExplorer";
import { pathExists, readDirectory, getDiskSpace } from "../TauriFileSystem";
import { Folder, HardDrive, Monitor, Download, FileText, Music, Image,
  Video, Search, ChevronDown, ChevronRight, X, Computer, Pin, Clock3, House
} from "lucide-react";

interface GotoPaletteProps {
  explorer: ExplorerAPI;
}

interface GotoItem extends NavigationDestination {
  folderId: string | null;
  section: "recents" | "pinned" | "storage" | "places" | "current";
}

export default function GotoPalette({ explorer }: GotoPaletteProps) {
  const {
    gotoPaletteOpen,
    setGotoPaletteOpen,
    navigateTo,
    language,
    accentColor,
    theme,
    navigationDestinations,
    drives,
    driveInfos = [],
    diskSpaces,
    setDiskSpaces,
    refreshDrives,
  } = explorer;

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [drillPath, setDrillPath] = useState<string | null>(null);
  const [pathSuggestions, setPathSuggestions] = useState<Array<{ name: string; path: string; source?: "child" | "destination" }>>([]);

  const [sectionsExpanded, setSectionsExpanded] = useState({
    current: true,
    recents: true,
    pinned: true,
    storage: true,
    places: true,
  });

  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedQuery(query);
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    if (!gotoPaletteOpen) return;
    setQuery("");
    setDrillPath(null);
    setPathSuggestions([]);
    setFocusedIndex(0);
    setTimeout(() => inputRef.current?.focus(), 50);

    // Refresh the drive list every time the palette opens. This makes sure
    // newly-plugged USB sticks, network shares, etc. show up in the
    // "Storage" section — the list is otherwise captured only at startup.
    let cancelled = false;
    void (async () => {
      await refreshDrives();
      if (cancelled) return;
      // After the drive list refreshes, top up any missing disk-space
      // entries so progress bars render even for drives that failed on
      // startup (e.g. optical drives, removable media still spinning up).
      for (const drive of explorer.drives) {
        try {
          const space = await getDiskSpace(drive);
          if (cancelled) return;
          setDiskSpaces(prev => {
            const existing = prev[drive];
            if (
              existing &&
              existing.total === space.total &&
              existing.used === space.used &&
              existing.free === space.free
            ) {
              return prev;
            }
            return { ...prev, [drive]: space };
          });
        } catch (_) {}
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gotoPaletteOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGotoPaletteOpen(false);
    };
    if (gotoPaletteOpen) window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [gotoPaletteOpen]);

  const t = (vi: string, en: string) => (language === "vi" ? vi : en);

  const iconMap: Record<NavigationDestination["iconKey"], React.ComponentType<any>> = {
    folder: Folder,
    drive: HardDrive,
    desktop: Monitor,
    documents: FileText,
    downloads: Download,
    pictures: Image,
    videos: Video,
    music: Music,
    computer: Computer,
    home: House,
    star: Pin,
    clock: Clock3,
  };

  const normalizedQuery = debouncedQuery.toLowerCase().trim();
  const normalizePath = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const unquoted = trimmed.replace(/^"|"$/g, "");
    const normalized = unquoted.replace(/\//g, "\\");
    if (/^[A-Za-z]:$/.test(normalized)) {
      return `${normalized}\\`;
    }
    return normalized;
  }, []);

  const splitTypedPath = useCallback((value: string) => {
    const normalized = normalizePath(value);
    const lastSlash = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
    if (lastSlash < 0) {
      return { parentPath: "", partialName: normalized };
    }
    return {
      parentPath: normalized.slice(0, lastSlash + 1),
      partialName: normalized.slice(lastSlash + 1),
    };
  }, [normalizePath]);

  const loadChildDirectories = useCallback(async (path: string) => {
    try {
      const listing = await readDirectory(path);
      return listing.entries
        .filter((entry) => entry.is_dir)
        .map((entry) => ({ name: entry.name, path: entry.path }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [] as Array<{ name: string; path: string }>;
    }
  }, []);

  const allDestinations: GotoItem[] = navigationDestinations.map((destination) => ({
    ...destination,
    folderId: destination.path || null,
    section:
      destination.kind === "recent"
        ? "recents"
        : destination.kind === "pinned"
          ? "pinned"
          : destination.kind === "drive"
            ? "storage"
            : destination.kind === "current"
              ? "current"
              : "places",
  }));

  const currentLocations = allDestinations.filter((item) => item.section === "current");
  const recentLocations = allDestinations.filter((item) => item.section === "recents").slice(0, 5);
  const pinnedLocations = allDestinations.filter((item) => item.section === "pinned");
  const placesLocations = allDestinations.filter((item) => item.section === "places");

  // Storage: prefer driveInfos (rich label + icon) and fall back to drives
  // for the brief window before driveInfos resolves on first open.
  const storageLocations: GotoItem[] = (driveInfos.length > 0 ? driveInfos : drives.map((p) => ({
    path: p,
    label: "",
    display: p,
    driveType: "unknown" as const,
    filesystem: "",
    iconUrl: null,
    total: diskSpaces[p]?.total ?? 0,
    used: diskSpaces[p]?.used ?? 0,
    free: diskSpaces[p]?.free ?? 0,
  }))).map((info) => {
    const space = diskSpaces[info.path];
    const total = info.total > 0 ? info.total : (space?.total ?? 0);
    const used = info.used > 0 ? info.used : (space?.used ?? 0);
    return {
      id: `drive:${info.path}`,
      label: info.display,
      path: info.path,
      kind: "drive" as const,
      iconKey: "drive" as const,
      description: info.driveType !== "unknown"
        ? `${info.driveType}${info.filesystem ? ` • ${info.filesystem}` : ""}`
        : (language === "vi" ? "Ổ đĩa" : "Drive"),
      folderId: info.path,
      section: "storage" as const,
      usedGB: total > 0 ? Math.round(used / (1024 * 1024 * 1024)) : undefined,
      totalGB: total > 0 ? Math.round(total / (1024 * 1024 * 1024)) : undefined,
    };
  });

  const expandedList: { section: GotoItem["section"]; item: GotoItem }[] = [];
  if (sectionsExpanded.current) currentLocations.forEach(item => expandedList.push({ section: "current", item }));
  if (sectionsExpanded.recents) recentLocations.forEach(item => expandedList.push({ section: "recents", item }));
  if (sectionsExpanded.pinned) pinnedLocations.forEach(item => expandedList.push({ section: "pinned", item }));
  if (sectionsExpanded.storage) storageLocations.forEach(item => expandedList.push({ section: "storage", item }));
  if (sectionsExpanded.places) placesLocations.forEach(item => expandedList.push({ section: "places", item }));

  const filteredList = expandedList.filter(({ item }) => {
    if (!normalizedQuery) return true;
    return item.label.toLowerCase().includes(normalizedQuery)
      || item.path.toLowerCase().includes(normalizedQuery)
      || (item.description || "").toLowerCase().includes(normalizedQuery);
  });

  const filteredPathSuggestions = useMemo(() => {
    if (!normalizedQuery) return pathSuggestions;
    return pathSuggestions.filter((entry) =>
      entry.name.toLowerCase().includes(normalizedQuery)
      || entry.path.toLowerCase().includes(normalizedQuery)
    );
  }, [normalizedQuery, pathSuggestions]);

  const drillSuggestions = useMemo(() => {
    const normalizedDrillPath = drillPath ? normalizePath(drillPath) : "";
    return filteredPathSuggestions.map((entry) => ({
      item: {
        id: `drill:${entry.path}`,
        label: entry.name,
        path: entry.path,
        kind: entry.source === "destination" ? "recent" : "special",
        iconKey: normalizedDrillPath && entry.path.toLowerCase() === normalizedDrillPath.toLowerCase() ? "drive" : "folder",
        description: entry.source === "destination"
          ? t("Truy cập nhanh", "Quick jump")
          : normalizedDrillPath
            ? t(`Bên trong ${normalizedDrillPath}`, `Inside ${normalizedDrillPath}`)
            : t("Thư mục con", "Child folder"),
        folderId: entry.path,
        section: "places" as const,
      },
    }));
  }, [drillPath, filteredPathSuggestions, normalizePath, t]);

  const visibleList = drillPath ? drillSuggestions : filteredList;
  const focusedEntry = visibleList[focusedIndex]?.item;

  const ensureFocusedItemVisible = useCallback((index: number) => {
    const container = resultsRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`[data-goto-index="${index}"]`);
    target?.scrollIntoView({ block: "nearest" });
  }, []);

  useEffect(() => {
    setFocusedIndex((prev) => {
      if (visibleList.length === 0) return 0;
      return Math.min(prev, visibleList.length - 1);
    });
  }, [visibleList.length]);

  useEffect(() => {
    if (visibleList.length === 0) return;
    requestAnimationFrame(() => ensureFocusedItemVisible(focusedIndex));
  }, [ensureFocusedItemVisible, focusedIndex, visibleList.length]);

  const canDrillForward = Boolean(focusedEntry?.path);
  const canDrillBackward = Boolean(drillPath && normalizePath(drillPath));

  const drillIntoPath = useCallback(async (nextPath: string) => {
    const normalizedPath = normalizePath(nextPath);
    if (!normalizedPath) return;

    try {
      const exists = await pathExists(normalizedPath);
      if (!exists) return;

      const directories = await loadChildDirectories(normalizedPath);
      setPathSuggestions(directories.slice(0, 100).map((entry) => ({ ...entry, source: "child" as const })));
      setDrillPath(normalizedPath);
      setQuery(normalizedPath);
      setFocusedIndex(0);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(normalizedPath.length, normalizedPath.length);
      });
    } catch {
      // ignore invalid drill targets
    }
  }, [loadChildDirectories, normalizePath]);

  const drillBackPath = useCallback(async () => {
    if (!drillPath) return;
    const normalized = normalizePath(drillPath);
    if (!normalized) {
      setDrillPath(null);
      setQuery("");
      setPathSuggestions([]);
      setFocusedIndex(0);
      return;
    }

    const withoutTrailing = normalized.replace(/[\\/]+$/, "");
    const driveRootMatch = withoutTrailing.match(/^[A-Za-z]:$/);
    if (driveRootMatch) {
      setDrillPath(null);
      setQuery("");
      setPathSuggestions([]);
      setFocusedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }

    const lastSlash = Math.max(withoutTrailing.lastIndexOf("\\"), withoutTrailing.lastIndexOf("/"));
    if (lastSlash < 0) {
      setDrillPath(null);
      setQuery("");
      setPathSuggestions([]);
      setFocusedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }

    const parentPath = withoutTrailing.slice(0, lastSlash + 1);
    if (!parentPath || /^[A-Za-z]:\\?$/.test(parentPath)) {
      const normalizedParent = parentPath ? normalizePath(parentPath) : "";
      if (!normalizedParent) {
        setDrillPath(null);
        setQuery("");
        setPathSuggestions([]);
        setFocusedIndex(0);
        requestAnimationFrame(() => inputRef.current?.focus());
        return;
      }

      const directories = await loadChildDirectories(normalizedParent);
      setDrillPath(normalizedParent);
      setQuery(normalizedParent);
      setPathSuggestions(directories.slice(0, 12).map((entry) => ({ ...entry, source: "child" as const })));
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(normalizedParent.length, normalizedParent.length);
      });
      return;
    }

    const directories = await loadChildDirectories(parentPath);
    setDrillPath(parentPath);
    setQuery(parentPath);
    setPathSuggestions(directories.slice(0, 12).map((entry) => ({ ...entry, source: "child" as const })));
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(parentPath.length, parentPath.length);
    });
  }, [drillPath, loadChildDirectories, normalizePath]);

  const handleSelectItem = (target: GotoItem) => {
    setGotoPaletteOpen(false);
    if (target.folderId) {
      void navigateTo(target.folderId);
    } else {
      void navigateTo(null);
    }

    explorer.setStatusMessage(
      t(`Đã chuyển tới ${target.label}`, `Navigated to ${target.label}`)
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex(prev => {
        const next = (prev + 1) % Math.max(1, visibleList.length);
        requestAnimationFrame(() => ensureFocusedItemVisible(next));
        return next;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex(prev => {
        const next = (prev - 1 + visibleList.length) % Math.max(1, visibleList.length);
        requestAnimationFrame(() => ensureFocusedItemVisible(next));
        return next;
      });
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (focusedEntry?.path) {
        void drillIntoPath(focusedEntry.path);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      drillBackPath();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (focusedEntry) handleSelectItem(focusedEntry as GotoItem);
    }
  };

  const toggleSection = (section: keyof typeof sectionsExpanded) => {
    setSectionsExpanded(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const currentGroup = filteredList.filter(f => f.section === "current");
  const recentsGroup = filteredList.filter(f => f.section === "recents");
  const pinnedGroup = filteredList.filter(f => f.section === "pinned");
  const storageGroup = filteredList.filter(f => f.section === "storage");
  const placesGroup = filteredList.filter(f => f.section === "places");

  const renderItem = (item: GotoItem) => {
    const globalIdx = visibleList.findIndex(f => f.item.id === item.id);
    if (normalizedQuery && globalIdx === -1) return null;
    const isFocused = globalIdx === focusedIndex;
    const IconComponent = iconMap[item.iconKey] || Folder;
    const usagePercent = item.usedGB && item.totalGB ? (item.usedGB / item.totalGB) * 100 : 0;

    return (
      <div
        key={item.id}
        data-goto-index={globalIdx}
        onClick={() => handleSelectItem(item)}
        onMouseEnter={() => setFocusedIndex(globalIdx)}
        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition select-none ${
          isFocused
            ? "font-medium"
            : "hover:bg-white/5"
        }`}
        style={isFocused ? {
          backgroundColor: `${accentColor}24`,
          color: "var(--fg-1)",
        } : undefined}
      >
        {item.iconKey === "folder" && item.path ? (
          <Folder className="w-4 h-4 shrink-0 text-amber-400" fill="currentColor" />
        ) : (
          <IconComponent
            className="w-4 h-4 shrink-0"
            style={{
              color: item.iconKey === "drive"
                ? accentColor
                : item.iconKey === "folder"
                  ? "#fbbf24"
                  : "var(--fg-1)",
            }}
            fill={item.iconKey === "folder" ? "currentColor" : undefined}
          />
        )}
        <div className="flex flex-col min-w-0 flex-1">
          <span 
            className="text-xs truncate"
            style={{ color: isFocused ? "var(--fg-1)" : undefined }}
          >
            {item.label}
          </span>
          {item.usedGB && item.totalGB ? (
            <div className="flex items-center gap-2 mt-0.5">
              <div 
                className="w-20 h-1 rounded-full overflow-hidden"
                style={{ backgroundColor: "var(--stroke-1)" }}
              >
                <div className="h-full rounded-full" style={{ width: `${usagePercent}%`, backgroundColor: accentColor }} />
              </div>
              <span 
                className="text-[9px] font-mono"
                style={{ color: isFocused ? "var(--fg-1)" : "var(--fg-3)" }}
              >
                {item.usedGB} GB / {item.totalGB} GB
              </span>
            </div>
          ) : (
            item.description && (
              <span 
                className="text-[10px] truncate mt-0.5"
                style={{ color: isFocused ? "var(--fg-1)" : "var(--fg-3)" }}
              >
                {item.description}
              </span>
            )
          )}
        </div>
        {item.path && (
          <span 
            className="text-[9px] font-mono shrink-0 truncate ml-2 max-w-[180px]"
            style={{ color: isFocused ? "var(--fg-1)" : "var(--fg-3)" }}
          >
            {item.path}
          </span>
        )}
      </div>
    );
  };

  const renderSection = (
    title: string,
    sectionKey: keyof typeof sectionsExpanded,
    items: GotoItem[],
    group: typeof filteredList
  ) => {
    if (!normalizedQuery && items.length === 0) return null;
    if (normalizedQuery && group.length === 0) return null;
    return (
      <div>
        <div
          onClick={() => toggleSection(sectionKey)}
          className="flex items-center justify-between px-2 py-1 text-[11px] font-bold tracking-wide uppercase cursor-pointer select-none rounded"
          style={{ color: "var(--fg-3)" }}
        >
          <span>{title}</span>
          {sectionsExpanded[sectionKey] ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </div>
        {sectionsExpanded[sectionKey] && (
          <div className="mt-1 space-y-0.5">
            {items.map(renderItem)}
          </div>
        )}
      </div>
    );
  };

  if (!gotoPaletteOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/20 flex items-start justify-center pt-20 z-[500] select-none animate-in fade-in duration-200"
      onClick={() => setGotoPaletteOpen(false)}
    >
      <div
        ref={dialogRef}
        onClick={e => e.stopPropagation()}
        className={`w-full max-w-lg rounded-xl shadow-2xl overflow-hidden font-sans transition-all max-h-[75vh] flex flex-col text-stone-300 shadow-black/70 ${theme === "light" ? "fluent-menu theme-light" : "fluent-menu"}`}
        style={{
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: theme === "light" ? undefined : "rgba(255,255,255,0.1)",
          "--fg-1": theme === "light" ? "#000000" : "#ffffff",
          "--fg-2": theme === "light" ? "#1a1a1a" : "#a8a8a8",
          "--fg-3": theme === "light" ? "#4a4a4a" : "#707070",
          "--stroke-1": theme === "light" ? "#e5e5e5" : "rgba(255,255,255,0.1)",
        } as React.CSSProperties}
      >
        {/* Input bar */}
        <div 
          className="flex items-center gap-3 px-4 py-3 font-sans transition-all"
          style={{ 
            borderBottomWidth: "1px",
            borderBottomStyle: "solid",
            borderBottomColor: theme === "light" ? "#858585" : "rgba(255,255,255,0.05)"
          }}
        >
          <Search className="w-4 h-4 shrink-0" style={{ color: "var(--fg-3)" }} />
          <input
            ref={inputRef}
            type="text"
            className="w-full bg-transparent text-sm focus:outline-none placeholder-stone-400"
            style={{ color: "var(--fg-1)" }}
            placeholder={t("Đi tới thư mục...", "Go to folder...")}
            value={query}
            onKeyDown={handleKeyDown}
            onChange={e => { setQuery(e.target.value); setFocusedIndex(0); }}
          />
          <button 
            onClick={() => setGotoPaletteOpen(false)} 
            className="p-1 rounded transition"
            style={{ color: "var(--fg-3)" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results */}
        <div ref={resultsRef} className="flex-1 overflow-y-auto p-2 space-y-3.5 scrollbar-thin goku-thin-scroll">
          {drillPath ? (
            <div className="space-y-2">
              <div className="px-2 py-1 text-[11px] font-bold tracking-wide uppercase" style={{ color: "var(--fg-3)" }}>
                {t("Gợi ý đường dẫn", "Path suggestions")}
              </div>
              {visibleList.length > 0 ? (
                <div className="space-y-0.5">
                  {visibleList.map(({ item }) => renderItem(item))}
                </div>
              ) : (
                <div className="px-3 py-6 text-xs text-center rounded-lg" style={{ backgroundColor: "var(--surface-bg)", color: "var(--fg-3)" }}>
                  {t("Không có thư mục con để gợi ý.", "No child folders to suggest.")}
                </div>
              )}
            </div>
          ) : (
            <>
              {renderSection(t("Hiện tại", "Current"), "current", currentLocations, currentGroup)}
              {renderSection(t("Gần đây", "Recents"), "recents", recentLocations, recentsGroup)}
              {renderSection(t("Đã ghim", "Pinned"), "pinned", pinnedLocations, pinnedGroup)}
              {renderSection(t("Thiết bị lưu trữ", "Storage"), "storage", storageLocations, storageGroup)}
              {renderSection(t("Vị trí", "Places"), "places", placesLocations, placesGroup)}
            </>
          )}
        </div>

        {/* Footer */}
        <div 
          className="p-3 text-[10px] flex items-center gap-4 font-sans shrink-0"
          style={{ 
            borderTopWidth: "1px",
            borderTopStyle: "solid",
            borderTopColor: theme === "light" ? "#858585" : "rgba(255,255,255,0.05)",
            color: "var(--fg-3)"
          }}
        >
          <span><kbd className="px-1 rounded shadow mr-1 border" style={{ backgroundColor: theme === "light" ? "#f0f0f0" : "rgba(255,255,255,0.1)", borderColor: theme === "light" ? "#858585" : "rgba(255,255,255,0.1)" }}>↑↓</kbd>{t("chọn", "navigate")}</span>
          <span><kbd className="px-1 rounded shadow mr-1 border" style={{ backgroundColor: theme === "light" ? "#f0f0f0" : "rgba(255,255,255,0.1)", borderColor: theme === "light" ? "#858585" : "rgba(255,255,255,0.1)" }}>→</kbd>{t("In", "In")}</span>
          <span><kbd className="px-1 rounded shadow mr-1 border" style={{ backgroundColor: theme === "light" ? "#f0f0f0" : "rgba(255,255,255,0.1)", borderColor: theme === "light" ? "#858585" : "rgba(255,255,255,0.1)" }}>←</kbd>{t("Out", "Out")}</span>
          <span><kbd className="px-1 rounded shadow mr-1 border" style={{ backgroundColor: theme === "light" ? "#f0f0f0" : "rgba(255,255,255,0.1)", borderColor: theme === "light" ? "#858585" : "rgba(255,255,255,0.1)" }}>Enter</kbd>{t("mở", "open")}</span>
          <span><kbd className="px-1 rounded shadow mr-1 border" style={{ backgroundColor: theme === "light" ? "#f0f0f0" : "rgba(255,255,255,0.1)", borderColor: theme === "light" ? "#858585" : "rgba(255,255,255,0.1)" }}>Esc</kbd>{t("thoát", "dismiss")}</span>
        </div>
      </div>
    </div>
  );
}
