import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { ColorPicker } from "./ColorPicker";
import { ExplorerAPI } from "../useExplorer";
import { dropdownEventBus, DROPDOWN_EVENTS } from "../utils/dropdownEvents";
import { getExrCacheSettings, updateExrCacheSettings, type GpuAccelerationMode } from "../stores/exrCacheSettings";
import {
  ArrowLeft, ArrowRight, ArrowUp, RefreshCw, Search, Plus, X,
  LayoutGrid, LayoutList, HardDrive, Sparkles, AlertTriangle, Monitor,
  Square, Minus, Play, Scissors, Copy, Clipboard, Trash2, Edit3, Share2,
  Filter, ChevronDown, Check, Folder, FolderPlus, FilePlus, FileText, Code, Boxes,
  FileImage, Music, Film, ArrowUpDown, Link, Settings, Upload, Navigation,
  Loader2, User
} from "lucide-react";
import { WindowsFolder } from "../hooks/useFolderIcons";
import { pathExists, readDirectory, openPathWithDefaultApp, getSystemMemoryInfo, resolveAddressPath } from "../TauriFileSystem";
import NewItemModal from "./NewItemModal";
import { layerCacheManager } from "../utils/exrCache/LayerCacheManager";

// Window control imports for Tauri v2
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { VIEW_MODE_LABELS, VIEW_MODE_MIN, VIEW_MODE_MAX } from "../types";

interface HeaderProps {
  explorer: ExplorerAPI;
}

export default function ExplorerHeader({ explorer }: HeaderProps) {
  const {
    tabs,
    activeTabId,
    activeTab,
    setActiveTabId,
    refreshCurrentDirectory,
    createNewTab,
    closeTab,
    navigateBack,
    navigateForward,
    navigateUp,
    navigateTo,
    searchFilter,
    setSearchFilter,
    viewMode,
    setViewMode,
    accentColor,
    showHiddenItems,
    setShowHiddenItems,
    hideFileExtensions,
    setHideFileExtensions,
    showSpaceAnalyzer,
    setShowSpaceAnalyzer,
    isSearching,
    searchResultsCount,
    cancelSearch,
    statusMessage,
    items,
    pinnedFolderIds,
    navigationDestinations,
    selectedIds,
    setSelectedIds,
    clipboard,
    createFile,
    createFolder,
    deleteItem,
    renameItem,
    newItemModal,
    setNewItemModal,
    setOpenFileId,
    setGotoPaletteOpen,
  } = explorer;

  // Track window maximized state for titlebar double-click toggle
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);

  // Responsive breadcrumb collapse — measure container width vs. natural
  // width of the fully-expanded strip so we can mirror Windows Explorer's
  // behavior (show every segment when there is room, otherwise "...").
  const crumbsContainerRef = useRef<HTMLDivElement | null>(null);
  const crumbsMeasureRef = useRef<HTMLDivElement | null>(null);
  const [crumbsContainerWidth, setCrumbsContainerWidth] = useState(0);
  const [fullCrumbsWidth, setFullCrumbsWidth] = useState(0);

  useEffect(() => {
    const win = getCurrentWindow();
    let mounted = true;
    let cleanupFn: (() => void) | undefined;

    const setup = async () => {
      try {
        const isMax = await win.isMaximized();
        if (mounted) setIsWindowMaximized(isMax);
      } catch {}

      try {
        const unlisten = await win.onResized(async () => {
          if (!mounted) return;
          try {
            const isMax = await win.isMaximized();
            setIsWindowMaximized(isMax);
          } catch {}
        });
        cleanupFn = () => { unlisten(); };
      } catch (e) {
        console.warn('onResized unavailable:', e);
      }
    };

    setup();

    return () => {
      mounted = false;
      cleanupFn?.();
    };
  }, []);

  const toggleMaximize = useCallback(async () => {
    const win = getCurrentWindow();
    const maximized = await win.isMaximized();
    if (maximized) {
      await win.unmaximize();
      setIsWindowMaximized(false);
    } else {
      await win.maximize();
      setIsWindowMaximized(true);
    }
  }, []);

  const handleTitlebarDoubleClick = useCallback(() => {
    toggleMaximize();
  }, [toggleMaximize]);

  const [searchInput, setSearchInput] = useState(searchFilter.query);
  // Default L1/L2/L3 background layers (Dark theme presets).
  // L1 = app base, L2 = row 1 + active tab, L3 = addressbar/searchbar/selection.
  const [appBg, setAppBg] = useState("#191919");
  const [rowBg, setRowBg] = useState("#1f1f1f");
  const [surfaceBg, setSurfaceBg] = useState("#2c2c2c");
  const [titlebarBg, setTitlebarBg] = useState("#191919");
  const [isLightMode, setIsLightMode] = useState(false);

  const applyLayer = (varName: string, value: string) => {
    // Set with !important to ensure it overrides default CSS
    document.documentElement.style.setProperty(varName, value, 'important');
    // Only L1 also applies to root containers with !important
    if (varName === "--app-bg") {
      document.documentElement.style.setProperty('background-color', value, 'important');
      document.body.style.setProperty('background-color', value, 'important');
      const root = document.getElementById('root');
      if (root) root.style.setProperty('background-color', value, 'important');
      const appRoot = document.querySelector('.goku-app-root');
      if (appRoot) (appRoot as HTMLElement).style.setProperty('background-color', value, 'important');
      // Keep --app-bg-rgb in sync so rgba(var(--app-bg-rgb), ...) matches the
      // actual app background in every theme (light = white, dark = #191919).
      const hex = value.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        document.documentElement.style.setProperty('--app-bg-rgb', `${r}, ${g}, ${b}`, 'important');
      }
    }
  };
  const [activeDropdown, setActiveDropdown] = useState<"new" | "sort" | "view" | "filter" | "delete" | "tabs" | null>(null);
  const [showAuthorMenu, setShowAuthorMenu] = useState(false);
  const [authorMenuPos, setAuthorMenuPos] = useState<{ top: number; left: number } | null>(null);
  const authorBtnRef = useRef<HTMLButtonElement>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [typedPath, setTypedPath] = useState("");
  const [debouncedTypedPath, setDebouncedTypedPath] = useState("");
  const [showHiddenCrumbsMenu, setShowHiddenCrumbsMenu] = useState(false);
  const [hiddenCrumbsDropdownPos, setHiddenCrumbsDropdownPos] = useState({ top: 0, left: 0 });
  const [crumbDropdownPos, setCrumbDropdownPos] = useState({ top: 0, left: 0 });
  const [pathSuggestionsPos, setPathSuggestionsPos] = useState({ top: 0, left: 0, width: 0 });
  const [pathSuggestions, setPathSuggestions] = useState<ShortcutEntry[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [crumbDropdownEntries, setCrumbDropdownEntries] = useState<Record<string, Array<{ name: string; path: string }>>>({});
  const [openCrumbDropdownPath, setOpenCrumbDropdownPath] = useState<string | null>(null);
  const [exrCacheSettings, setExrCacheSettings] = useState(() => getExrCacheSettings());
  const [systemMemoryInfo, setSystemMemoryInfo] = useState<{ totalMemoryGB: number; maxCacheMB: number }>({
    totalMemoryGB: 8,
    maxCacheMB: 65536,
  });

  // Load system memory info on mount
  useEffect(() => {
    getSystemMemoryInfo()
      .then((info) => {
        // Use total RAM as max cache, minimum 8GB (8192 MB), maximum 256GB (262144 MB)
        const maxMB = Math.max(8192, Math.min(262144, info.total_memory_bytes / (1024 * 1024)));
        setSystemMemoryInfo({
          totalMemoryGB: info.total_memory_gb,
          maxCacheMB: Math.round(maxMB),
        });
      })
      .catch(() => {
        // Keep defaults on error
      });
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const pathSuggestionsContainerRef = useRef<HTMLDivElement>(null);
  const breadcrumbRef = useRef<HTMLDivElement>(null);

  // Apply initial app background on mount (load from localStorage)
  useEffect(() => {
    const savedAppBg = localStorage.getItem("NEXUS_LAYER_APP_BG");
    const savedRowBg = localStorage.getItem("NEXUS_LAYER_ROW_BG");
    const savedSurfaceBg = localStorage.getItem("NEXUS_LAYER_SURFACE_BG");
    const savedTitlebarBg = localStorage.getItem("NEXUS_LAYER_HEADER_BG");
    const savedIsLightMode = localStorage.getItem("NEXUS_LAYER_IS_LIGHT_MODE");
    const savedBg2 = localStorage.getItem("NEXUS_LAYER_BG2");
    const savedBg3 = localStorage.getItem("NEXUS_LAYER_BG3");

    if (savedAppBg) { setAppBg(savedAppBg); applyLayer("--app-bg", savedAppBg); }
    if (savedRowBg) { setRowBg(savedRowBg); applyLayer("--row-bg", savedRowBg); }
    if (savedSurfaceBg) { setSurfaceBg(savedSurfaceBg); applyLayer("--surface-bg", savedSurfaceBg); }
    if (savedTitlebarBg) { setTitlebarBg(savedTitlebarBg); document.documentElement.style.setProperty("--header-bg", savedTitlebarBg); }
    if (savedIsLightMode) { setIsLightMode(savedIsLightMode === "true"); }
    if (savedBg2) { document.documentElement.style.setProperty("--bg-2", savedBg2); }
    if (savedBg3) { document.documentElement.style.setProperty("--bg-3", savedBg3); }
  }, []);

  // Apply theme changes when explorer.theme changes
  useEffect(() => {
    const theme = explorer.theme;

    if (theme === "light") {
      const lightDefaults = {
        appBg: "#ffffff",
        rowBg: "#f3f5f5",
        surfaceBg: "#fbfcfc",
        titlebarBg: "#ffffff",
      };

      setAppBg(lightDefaults.appBg);
      setRowBg(lightDefaults.rowBg);
      setSurfaceBg(lightDefaults.surfaceBg);
      setTitlebarBg(lightDefaults.titlebarBg);
      localStorage.setItem("NEXUS_LAYER_APP_BG", lightDefaults.appBg);
      localStorage.setItem("NEXUS_LAYER_ROW_BG", lightDefaults.rowBg);
      localStorage.setItem("NEXUS_LAYER_SURFACE_BG", lightDefaults.surfaceBg);
      localStorage.setItem("NEXUS_LAYER_HEADER_BG", lightDefaults.titlebarBg);
      localStorage.setItem("NEXUS_LAYER_IS_LIGHT_MODE", "true");

      applyLayer("--app-bg", lightDefaults.appBg);
      applyLayer("--row-bg", lightDefaults.rowBg);
      applyLayer("--surface-bg", lightDefaults.surfaceBg);
      document.documentElement.style.setProperty("--header-bg", lightDefaults.titlebarBg);
      document.documentElement.style.setProperty("--bg-2", lightDefaults.rowBg);
      document.documentElement.style.setProperty("--bg-3", lightDefaults.surfaceBg);
    } else {
      const darkDefaults = {
        appBg: "#191919",
        rowBg: "#1f1f1f",
        surfaceBg: "#2c2c2c",
        titlebarBg: "#191919",
      };

      setAppBg(darkDefaults.appBg);
      setRowBg(darkDefaults.rowBg);
      setSurfaceBg(darkDefaults.surfaceBg);
      setTitlebarBg(darkDefaults.titlebarBg);
      localStorage.setItem("NEXUS_LAYER_APP_BG", darkDefaults.appBg);
      localStorage.setItem("NEXUS_LAYER_ROW_BG", darkDefaults.rowBg);
      localStorage.setItem("NEXUS_LAYER_SURFACE_BG", darkDefaults.surfaceBg);
      localStorage.setItem("NEXUS_LAYER_HEADER_BG", darkDefaults.titlebarBg);
      localStorage.setItem("NEXUS_LAYER_IS_LIGHT_MODE", "false");

      applyLayer("--app-bg", darkDefaults.appBg);
      applyLayer("--row-bg", darkDefaults.rowBg);
      applyLayer("--surface-bg", darkDefaults.surfaceBg);
      document.documentElement.style.setProperty("--header-bg", darkDefaults.titlebarBg);
      document.documentElement.style.setProperty("--bg-2", darkDefaults.rowBg);
      document.documentElement.style.setProperty("--bg-3", darkDefaults.surfaceBg);
    }
  }, [explorer.theme]);

  const activeSuggestionRef = useRef<HTMLButtonElement>(null);
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const tabsDropdownButtonRef = useRef<HTMLButtonElement>(null);
  const accentColorButtonRef = useRef<HTMLButtonElement>(null);
  const sliderDraggingRef = useRef(false);
  const [localSliderValue, setLocalSliderValue] = useState<number | null>(null);

  const [showColorPicker, setShowColorPicker] = useState(false);
  const [colorPickerAnchor, setColorPickerAnchor] = useState<DOMRect | null>(null);
  const [settingsPosition, setSettingsPosition] = useState<{ top: number; right: number } | null>(null);
  const [tabsDropdownPosition, setTabsDropdownPosition] = useState<{ top: number; left: number } | null>(null);

  // Dynamic tab width based on number of tabs (min 120px, max 200px)
  const tabWidth = Math.max(120, Math.min(200, Math.floor(800 / tabs.length)));

  const handleLocalFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string || "";
      createFile(file.name, content);
      
      const successMsg = explorer.language === "vi"
        ? `Đã nhập tệp "${file.name}" thành công vào thư mục hiện tại.`
        : `Imported file "${file.name}" successfully into the current directory.`;
      
      explorer.setStatusMessage(successMsg);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // Sync search input when external state or active tab changes.
  // Depend on activeTabId so switching tabs forces a resync, even if
  // both tabs happen to share the same query string.
  useEffect(() => {
    setSearchInput(searchFilter.query);
  }, [searchFilter.query, activeTabId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSearchFilter({ query: searchInput });
    }, 140);
    return () => window.clearTimeout(timeout);
  }, [searchInput, setSearchFilter]);

  useEffect(() => {
    if (!activeTab) return;
    if (!isEditingPath) {
      setTypedPath(activeTab.currentPath);
    }
  }, [activeTab, isEditingPath]);

  // Keep the suggestion dropdown's debounced view of the typed path in sync
  // with the latest `typedPath` value. The previous code only ever read
  // `debouncedTypedPath` without updating it, so the dropdown kept showing
  // the initial empty-query destination list instead of the user's typed
  // shortcut pattern (e.g. `%AppData%`). Mirroring the latest value here is
  // the simplest fix and avoids a wider hook refactor.
  useEffect(() => {
    setDebouncedTypedPath(typedPath);
  }, [typedPath]);

  useEffect(() => {
    if (!showSettings) return;

    const handlePointerDownOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (settingsPanelRef.current?.contains(target) || settingsButtonRef.current?.contains(target)) {
        return;
      }
      setShowSettings(false);
    };

    window.addEventListener("pointerdown", handlePointerDownOutside);
    return () => window.removeEventListener("pointerdown", handlePointerDownOutside);
  }, [showSettings]);

  // Close crumb dropdown when clicking outside.
  //
  // We listen on `mousedown` (not `click`) and use the capture phase so the
  // handler fires before any React handler that calls stopPropagation on the
  // bubbling phase (e.g. file-item click in ExplorerMainPane).
  useEffect(() => {
    if (!openCrumbDropdownPath) return;

    const handlePointerDownOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      // Don't close if clicking inside the crumbs container or dropdown
      if (crumbsContainerRef.current?.contains(target)) return;
      if (target?.closest(".crumb-dropdown-container")) return;
      setOpenCrumbDropdownPath(null);
    };

    // Use a timeout to avoid closing immediately when clicking the chevron
    const timeout = setTimeout(() => {
      document.addEventListener("mousedown", handlePointerDownOutside, true);
    }, 0);

    return () => {
      clearTimeout(timeout);
      document.removeEventListener("mousedown", handlePointerDownOutside, true);
    };
  }, [openCrumbDropdownPath]);

  // Close delete dropdown when clicking outside
  //
  // We listen on `mousedown` (not `click`) and use the capture phase so the
  // handler fires before any React handler that calls stopPropagation on the
  // bubbling phase (e.g. file-item click in ExplorerMainPane).
  useEffect(() => {
    if (activeDropdown !== "delete") return;

    const handlePointerDownOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-delete-dropdown]")) return;
      setActiveDropdown(null);
    };

    const timeout = setTimeout(() => {
      document.addEventListener("mousedown", handlePointerDownOutside, true);
    }, 0);

    return () => {
      clearTimeout(timeout);
      document.removeEventListener("mousedown", handlePointerDownOutside, true);
    };
  }, [activeDropdown, setActiveDropdown]);

  // Close command-bar dropdowns (new/sort/view/filter) when clicking outside
  // the row that contains them. Without this, the menu stays open until the
  // user clicks the trigger button again.
  //
  // We listen on `mousedown` (not `click`) and use the capture phase so the
  // handler fires before any React handler that calls stopPropagation on the
  // bubbling phase (e.g. file-item click in ExplorerMainPane). Click on a file
  // therefore still selects it AND closes the menu.
  useEffect(() => {
    if (!activeDropdown) return;
    // The delete dropdown already has its own dedicated handler above with a
    // data-attribute gate. Skip it here so the two handlers don't fight.
    if (activeDropdown === "delete") return;
    // Crumb dropdown has its own handler via openCrumbDropdownPath.
    if (activeDropdown === "filter") return;

    const handlePointerDownOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-command-bar-row]")) return;
      if (target.closest("[data-active-dropdown]")) return;
      setActiveDropdown(null);
    };

    // Defer attaching to avoid the same mousedown that opened the menu
    // immediately closing it.
    const timeout = setTimeout(() => {
      document.addEventListener("mousedown", handlePointerDownOutside, true);
    }, 0);

    return () => {
      clearTimeout(timeout);
      document.removeEventListener("mousedown", handlePointerDownOutside, true);
    };
  }, [activeDropdown, setActiveDropdown]);

  // Close Author menu when clicking outside
  useEffect(() => {
    if (!showAuthorMenu) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-author-menu]")) return;
      if (target.closest("[data-author-dropdown]")) return;
      setShowAuthorMenu(false);
    };
    const updatePos = () => {
      if (!authorBtnRef.current) return;
      const rect = authorBtnRef.current.getBoundingClientRect();
      setAuthorMenuPos({ top: rect.bottom + 4, left: rect.left });
    };
    updatePos();
    window.addEventListener("resize", updatePos);
    window.addEventListener("scroll", updatePos, true);
    const timeout = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside, true);
    }, 0);
    return () => {
      clearTimeout(timeout);
      document.removeEventListener("mousedown", handleClickOutside, true);
      window.removeEventListener("resize", updatePos);
      window.removeEventListener("scroll", updatePos, true);
    };
  }, [showAuthorMenu]);

  const normalizeAddressPath = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const unquoted = trimmed.replace(/^"|"$/g, "");
    const normalizedSlashes = unquoted.replace(/\//g, "\\");

    if (normalizedSlashes.startsWith("\\\\")) {
      const collapsedUnc = `\\\\${normalizedSlashes.slice(2).replace(/\\+/g, "\\")}`;
      return collapsedUnc.replace(/\\+$/, "");
    }

    const collapsed = normalizedSlashes.replace(/\\+/g, "\\");
    const driveMatch = collapsed.match(/^([A-Za-z]:)(\\?)(.*)$/);
    if (driveMatch) {
      const [, drive, slash, remainder] = driveMatch;
      const resolvedSegments: string[] = [];
      for (const segment of remainder.split(/\\+/).filter(Boolean)) {
        if (segment === ".") continue;
        if (segment === "..") {
          resolvedSegments.pop();
          continue;
        }
        resolvedSegments.push(segment);
      }
      const resolvedPath = `${drive}\\${resolvedSegments.join("\\")}`.replace(/\\+$/, "");
      return resolvedSegments.length === 0 || slash ? `${resolvedPath}\\`.replace(/\\+$/, "\\") : resolvedPath;
    }

    return collapsed.replace(/\\+$/, "");
  }, []);

  const splitTypedPath = useCallback((value: string) => {
    const normalized = normalizeAddressPath(value);
    const lastSlash = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
    if (lastSlash < 0) {
      return { parentPath: "", partialName: normalized };
    }
    return {
      parentPath: normalized.slice(0, lastSlash + 1),
      partialName: normalized.slice(lastSlash + 1),
    };
  }, [normalizeAddressPath]);

  const loadPathEntries = useCallback(async (path: string) => {
    try {
      const listing = await readDirectory(path);
      return listing.entries
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.is_dir ? "directory" as const : "file" as const,
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } catch {
      return [] as Array<{ name: string; path: string; type: "file" | "directory" }>;
    }
  }, []);

  const loadChildDirectories = useCallback(async (path: string) => {
    const entries = await loadPathEntries(path);
    return entries.filter((entry) => entry.type === "directory").map(({ name, path: entryPath }) => ({ name, path: entryPath }));
  }, [loadPathEntries]);

  const buildPathCrumbs = useCallback((path: string) => {
    // Handle virtual shell paths (e.g. "thispc://") used for special locations
    // that don't map to a real filesystem path.
    if (path.startsWith("thispc://")) {
      return [{ name: "This PC", folderId: "thispc://" }];
    }
    if (path.startsWith("recyclebin://")) {
      return [{ name: "Recycle Bin", folderId: "recyclebin://" }];
    }
    if (path.startsWith("network://")) {
      return [{ name: "Network", folderId: "network://" }];
    }

    const normalized = path.replace(/\//g, "\\");
    const driveMatch = normalized.match(/^[A-Za-z]:\\?/);
    if (!driveMatch) {
      const isNetworkPath = normalized.startsWith("\\\\");
      const segments = normalized.split(/\\+/).filter(Boolean);
      if (isNetworkPath) {
        const crumbs = [];
        const sep = String.fromCharCode(92);
        for (let i = 0; i < segments.length; i++) {
          if (i === 0) {
            crumbs.push({ name: segments[0], folderId: sep + sep + segments[0] });
          } else {
            const sub = segments.slice(1, i + 1).join(sep);
            crumbs.push({ name: segments[i], folderId: sep + sep + segments[0] + sep + sub });
          }
        }
        return crumbs;
      }
      return segments.map((segment, index, segs) => ({
        name: segment,
        folderId: segs.slice(0, index + 1).join("\\"),
      }));
    }

    const driveRoot = driveMatch[0].endsWith("\\") ? driveMatch[0] : `${driveMatch[0]}\\`;
    const remainder = normalized.slice(driveMatch[0].length).replace(/^\\+/, "");
    const segments = remainder ? remainder.split(/\\+/).filter(Boolean) : [];
    const crumbs = [{ name: driveRoot, folderId: driveRoot }];
    let currentPath = driveRoot.replace(/\\$/, "");

    for (const segment of segments) {
      currentPath = `${currentPath}\\${segment}`;
      crumbs.push({ name: segment, folderId: currentPath });
    }

    return crumbs;
  }, []);

  const openPathEditor = useCallback(() => {
    setShowHiddenCrumbsMenu(false);
    setOpenCrumbDropdownPath(null);
    // Show friendly name for virtual paths instead of internal paths
    let displayPath = activeTab?.currentPath || "";
    if (displayPath.startsWith("thispc://")) displayPath = "This PC";
    else if (displayPath.startsWith("recyclebin://")) displayPath = "Recycle Bin";
    else if (displayPath.startsWith("network://")) displayPath = "Network";
    setTypedPath(displayPath);
    setIsEditingPath(true);
  }, [activeTab]);

  const cancelPathEditing = useCallback(() => {
    // Show friendly name for virtual paths instead of internal paths
    let displayPath = activeTab?.currentPath || "";
    if (displayPath.startsWith("thispc://")) displayPath = "This PC";
    else if (displayPath.startsWith("recyclebin://")) displayPath = "Recycle Bin";
    else if (displayPath.startsWith("network://")) displayPath = "Network";
    setTypedPath(displayPath);
    setIsEditingPath(false);
  }, [activeTab]);

  const isTextEditablePath = useCallback((path: string) => {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    return /^(json|txt|md|html|css|js|ts|tsx|sh|csv|log|xml|yaml|yml|env|py|rs|go|java|c|cpp|h|hpp|php|rb|swift|kt)$/i.test(ext);
  }, []);

  const submitTypedPath = useCallback(async (inputPath?: string, inputType?: "file" | "directory") => {
    const rawPath = inputPath ?? typedPath;
    if (!rawPath.trim()) {
      explorer.setStatusMessage(
        explorer.language === "vi" ? "Đường dẫn không được để trống." : "Path cannot be empty."
      );
      return;
    }

    // Resolve typed shortcuts (`%AppData%`, `shell:Downloads`,
    // `::{GUID}`) before normalising. The backend mirrors Windows
    // Explorer's address bar and returns either an absolute path or the
    // input unchanged when no rule matched. If the resolved string
    // differs from the input, surface a status message so the user
    // sees the expansion happen.
    let resolvedPath = rawPath;
    try {
      const out = await resolveAddressPath(rawPath);
      if (out && out !== rawPath) {
        resolvedPath = out;
        explorer.setStatusMessage(
          explorer.language === "vi"
            ? `Đã phân giải ${rawPath} → ${out}`
            : `Resolved ${rawPath} → ${out}`
        );
      }
    } catch {
      // Backend reported an error (e.g. unknown env var). Continue with
      // the original input — the existing "path not found" branch will
      // catch the rest.
    }

    const normalizedPath = normalizeAddressPath(resolvedPath);
    if (!normalizedPath) {
      explorer.setStatusMessage(
        explorer.language === "vi" ? "Đường dẫn không được để trống." : "Path cannot be empty."
      );
      return;
    }

    // Match suggestion first (needed for both GUID and normal paths).
    // Try matching by path first, then fall back to matching by name/description.
    let matchedSuggestion = pathSuggestions.find(
      (entry) => normalizeAddressPath(entry.path).toLowerCase() === normalizedPath.toLowerCase()
    );
    
    // If no path match, try matching by name (handles "this pc" → "This PC" GUID)
    if (!matchedSuggestion) {
      const lowerQuery = normalizedPath.toLowerCase().replace(/[_\-\s]+/g, " ").trim();
      matchedSuggestion = pathSuggestions.find((entry) => {
        const entryName = entry.name.toLowerCase().replace(/[_\-\s]+/g, " ").trim();
        const entryDesc = (entry.description || "").toLowerCase().replace(/[_\-\s]+/g, " ").trim();
        return entryName === lowerQuery || entryDesc === lowerQuery ||
          entryName.includes(lowerQuery) || lowerQuery.includes(entryName);
      });
    }

    // If we have a matched suggestion with a GUID path, use it
    if (matchedSuggestion) {
      resolvedPath = matchedSuggestion.path;
    }

    // Map common shell GUIDs to virtual paths so the explorer can handle them.
    const guidToVirtual: Record<string, string> = {
      "::{20d04fe0-3aea-1069-a2d8-08002b30309d}": "thispc://",
      "::{b7534046-3ecb-4c18-be4e-64cd4cb7d6ac}": "recyclebin://",
      "::{d20beec4-5ca8-4905-ae3b-bf251ea32b42}": "network://",
    };
    
    // Check if matchedSuggestion has a GUID path that maps to virtual path
    let virtualTarget: string | undefined;
    if (matchedSuggestion) {
      virtualTarget = guidToVirtual[matchedSuggestion.path.toLowerCase()];
    }
    // Fall back to checking normalizedPath (handles direct GUID input)
    virtualTarget = virtualTarget || guidToVirtual[normalizedPath.toLowerCase()];
    
    const isGuidPath = (matchedSuggestion?.path || normalizedPath).startsWith("::{");
    const isVirtualPath = (matchedSuggestion?.path || normalizedPath).startsWith("thispc://") ||
      (matchedSuggestion?.path || normalizedPath).startsWith("recyclebin://") ||
      (matchedSuggestion?.path || normalizedPath).startsWith("network://");

    // Special shell GUIDs and virtual paths bypass the filesystem existence check.
    const isShellPath = isGuidPath || isVirtualPath;
    const pathToVerify = isShellPath ? (matchedSuggestion?.path || normalizedPath) : normalizedPath;
    const pathExistsResult = isShellPath ? true : await pathExists(pathToVerify);
    if (!pathExistsResult) {
      explorer.setStatusMessage(
        explorer.language === "vi"
          ? `Không tìm thấy đường dẫn: ${normalizedPath}`
          : `Path not found: ${normalizedPath}`
      );
      return;
    }

    // For shell GUIDs → navigate to virtual path
    if (virtualTarget) {
      navigateTo(virtualTarget);
      setShowHiddenCrumbsMenu(false);
      setIsEditingPath(false);
      // Show user-friendly name in address bar instead of internal virtual path
      const displayName = matchedSuggestion?.name ?? 
        (virtualTarget === "thispc://" ? "This PC" :
         virtualTarget === "recyclebin://" ? "Recycle Bin" :
         virtualTarget === "network://" ? "Network" : virtualTarget);
      setTypedPath(displayName);
      setPathSuggestions([]);
      setSelectedSuggestionIndex(-1);
      explorer.setStatusMessage(
        explorer.language === "vi"
          ? `Đã mở: ${matchedSuggestion?.name ?? normalizedPath}`
          : `Opened: ${matchedSuggestion?.name ?? normalizedPath}`
      );
      return;
    }

    const pathType = inputType ?? matchedSuggestion?.type ?? "directory";

    try {
      if (pathType === "file") {
        if (isTextEditablePath(normalizedPath)) {
          setOpenFileId(normalizedPath);
          setShowHiddenCrumbsMenu(false);
          setIsEditingPath(false);
          setTypedPath(normalizedPath);
          explorer.setStatusMessage(
            explorer.language === "vi"
              ? `Đã mở tệp: ${normalizedPath}`
              : `Opened file: ${normalizedPath}`
          );
        } else {
          try {
            await openPathWithDefaultApp(normalizedPath);
            setShowHiddenCrumbsMenu(false);
            setIsEditingPath(false);
            setTypedPath(normalizedPath);
            explorer.setStatusMessage(
              explorer.language === "vi"
                ? `Đã mở tệp bằng ứng dụng mặc định: ${normalizedPath}`
                : `Opened file with default app: ${normalizedPath}`
            );
          } catch {
            explorer.setStatusMessage(
              explorer.language === "vi"
                ? `Không thể mở tệp bằng ứng dụng mặc định: ${normalizedPath}`
                : `Could not open file with default app: ${normalizedPath}`
            );
          }
        }
        return;
      }

      await navigateTo(normalizedPath);
      setShowSpaceAnalyzer(false);
      setShowHiddenCrumbsMenu(false);
      setIsEditingPath(false);
      setTypedPath(normalizedPath);
      setCrumbDropdownEntries({});
    } catch (error) {
      explorer.setStatusMessage(
        explorer.language === "vi"
          ? `Không thể mở đường dẫn: ${normalizedPath}`
          : `Could not open path: ${normalizedPath}`
      );
    }
  }, [explorer, isTextEditablePath, navigateTo, normalizeAddressPath, pathSuggestions, setOpenFileId, setShowSpaceAnalyzer, typedPath]);

  const copyCurrentPath = useCallback(async () => {
    const currentPath = activeTab?.currentPath;
    if (!currentPath) return;
    try {
      await navigator.clipboard.writeText(currentPath);
      explorer.setStatusMessage(
        explorer.language === "vi"
          ? `Đã sao chép đường dẫn: ${currentPath}`
          : `Copied path: ${currentPath}`
      );
    } catch {
      explorer.setStatusMessage(
        explorer.language === "vi"
          ? "Không thể sao chép đường dẫn."
          : "Could not copy path."
      );
    }
  }, [activeTab?.currentPath, explorer]);

  const openCrumbDropdown = useCallback(async (crumbPath: string, rect?: DOMRect) => {
    // Always update position when chevron is clicked
    if (rect) {
      setCrumbDropdownPos({ top: rect.bottom + 8, left: rect.left });
    }
    
    // Toggle: if already open on this path, close it; otherwise open
    const shouldOpen = openCrumbDropdownPath !== crumbPath;
    setOpenCrumbDropdownPath(shouldOpen ? crumbPath : null);

    if (crumbDropdownEntries[crumbPath]) {
      return;
    }

    const directories = await loadChildDirectories(crumbPath);
    setCrumbDropdownEntries((prev) => ({
      ...prev,
      [crumbPath]: directories,
    }));
  }, [crumbDropdownEntries, loadChildDirectories, openCrumbDropdownPath]);

  const applySuggestion = useCallback((suggestionPath: string) => {
    setTypedPath(suggestionPath);
    setPathSuggestions([]);
    setSelectedSuggestionIndex(-1);
  }, []);

  // ── Shortcut suggestion tables ─────────────────────────────────────────────
  // These power the live dropdown when the user types `%`, `shell:`, or
  // `::{` in the address bar. The same mapping exists in the Rust backend
  // (resolve_address_path). The frontend tables are kept in sync with that
  // table so suggestions and resolution never disagree.

  type ShortcutKind = "env" | "shell" | "guid";
  type ShortcutEntry = {
    name: string;
    path: string;
    type: "file" | "directory";
    source: "child" | "destination";
    description: string;
    kind: ShortcutKind;
  };

  const ENV_VAR_SUGGESTIONS: ShortcutEntry[] = [
    { name: "%AppData%", path: "%AppData%", type: "directory", source: "destination", description: "Roaming AppData", kind: "env" },
    { name: "%LocalAppData%", path: "%LocalAppData%", type: "directory", source: "destination", description: "Local AppData", kind: "env" },
    { name: "%UserProfile%", path: "%UserProfile%", type: "directory", source: "destination", description: "User profile folder", kind: "env" },
    { name: "%HomePath%", path: "%HomePath%", type: "directory", source: "destination", description: "User home path", kind: "env" },
    { name: "%HomeDrive%", path: "%HomeDrive%", type: "directory", source: "destination", description: "User home drive", kind: "env" },
    { name: "%ProgramFiles%", path: "%ProgramFiles%", type: "directory", source: "destination", description: "Program Files", kind: "env" },
    { name: "%ProgramFiles(x86)%", path: "%ProgramFiles(x86)%", type: "directory", source: "destination", description: "Program Files (x86)", kind: "env" },
    { name: "%ProgramData%", path: "%ProgramData%", type: "directory", source: "destination", description: "ProgramData", kind: "env" },
    { name: "%ProgramW6432%", path: "%ProgramW6432%", type: "directory", source: "destination", description: "Program Files (64-bit on 32-bit)", kind: "env" },
    { name: "%WinDir%", path: "%WinDir%", type: "directory", source: "destination", description: "Windows folder", kind: "env" },
    { name: "%SystemRoot%", path: "%SystemRoot%", type: "directory", source: "destination", description: "Windows folder", kind: "env" },
    { name: "%SystemDrive%", path: "%SystemDrive%", type: "directory", source: "destination", description: "Windows system drive", kind: "env" },
    { name: "%TEMP%", path: "%TEMP%", type: "directory", source: "destination", description: "Temporary files", kind: "env" },
    { name: "%TMP%", path: "%TMP%", type: "directory", source: "destination", description: "Temporary files", kind: "env" },
    { name: "%Public%", path: "%Public%", type: "directory", source: "destination", description: "Public folder", kind: "env" },
    { name: "%AllUsersProfile%", path: "%AllUsersProfile%", type: "directory", source: "destination", description: "All users profile", kind: "env" },
    { name: "%OneDrive%", path: "%OneDrive%", type: "directory", source: "destination", description: "OneDrive folder", kind: "env" },
    { name: "%CommonProgramFiles%", path: "%CommonProgramFiles%", type: "directory", source: "destination", description: "Common Program Files", kind: "env" },
    { name: "%CommonProgramW6432%", path: "%CommonProgramW6432%", type: "directory", source: "destination", description: "Common Program Files (64)", kind: "env" },
    { name: "%USERPROFILE%", path: "%USERPROFILE%", type: "directory", source: "destination", description: "Alias for UserProfile", kind: "env" },
  ];

  const SHELL_SUGGESTIONS: ShortcutEntry[] = [
    { name: "shell:Desktop", path: "shell:Desktop", type: "directory", source: "destination", description: "Current user desktop", kind: "shell" },
    { name: "shell:Downloads", path: "shell:Downloads", type: "directory", source: "destination", description: "Current user downloads", kind: "shell" },
    { name: "shell:Documents", path: "shell:Documents", type: "directory", source: "destination", description: "Current user documents", kind: "shell" },
    { name: "shell:Pictures", path: "shell:Pictures", type: "directory", source: "destination", description: "Current user pictures", kind: "shell" },
    { name: "shell:Videos", path: "shell:Videos", type: "directory", source: "destination", description: "Current user videos", kind: "shell" },
    { name: "shell:Music", path: "shell:Music", type: "directory", source: "destination", description: "Current user music", kind: "shell" },
    { name: "shell:AppData", path: "shell:AppData", type: "directory", source: "destination", description: "Roaming AppData", kind: "shell" },
    { name: "shell:Local AppData", path: "shell:Local AppData", type: "directory", source: "destination", description: "Local AppData", kind: "shell" },
    { name: "shell:Programs", path: "shell:Programs", type: "directory", source: "destination", description: "User Programs folder", kind: "shell" },
    { name: "shell:ProgramFiles", path: "shell:ProgramFiles", type: "directory", source: "destination", description: "Program Files", kind: "shell" },
    { name: "shell:ProgramFilesX86", path: "shell:ProgramFilesX86", type: "directory", source: "destination", description: "Program Files (x86)", kind: "shell" },
    { name: "shell:ProgramData", path: "shell:ProgramData", type: "directory", source: "destination", description: "ProgramData", kind: "shell" },
    { name: "shell:Windows", path: "shell:Windows", type: "directory", source: "destination", description: "Windows folder", kind: "shell" },
    { name: "shell:System", path: "shell:System", type: "directory", source: "destination", description: "System32", kind: "shell" },
    { name: "shell:UserProfile", path: "shell:UserProfile", type: "directory", source: "destination", description: "User profile", kind: "shell" },
    { name: "shell:Home", path: "shell:Home", type: "directory", source: "destination", description: "User home", kind: "shell" },
    { name: "shell:Public", path: "shell:Public", type: "directory", source: "destination", description: "Public folder", kind: "shell" },
    { name: "shell:PublicDesktop", path: "shell:PublicDesktop", type: "directory", source: "destination", description: "Public desktop", kind: "shell" },
    { name: "shell:PublicDownloads", path: "shell:PublicDownloads", type: "directory", source: "destination", description: "Public downloads", kind: "shell" },
    { name: "shell:PublicDocuments", path: "shell:PublicDocuments", type: "directory", source: "destination", description: "Public documents", kind: "shell" },
    { name: "shell:Startup", path: "shell:Startup", type: "directory", source: "destination", description: "User startup folder", kind: "shell" },
    { name: "shell:CommonStartup", path: "shell:CommonStartup", type: "directory", source: "destination", description: "Common startup folder", kind: "shell" },
    { name: "shell:MyComputerFolder", path: "shell:MyComputerFolder", type: "directory", source: "destination", description: "This PC", kind: "shell" },
    { name: "shell:RecycleBinFolder", path: "shell:RecycleBinFolder", type: "directory", source: "destination", description: "Recycle Bin", kind: "shell" },
    { name: "shell:NetworkFolder", path: "shell:NetworkFolder", type: "directory", source: "destination", description: "Network", kind: "shell" },
    { name: "shell:ControlPanelFolder", path: "shell:ControlPanelFolder", type: "directory", source: "destination", description: "Control Panel", kind: "shell" },
    { name: "shell:PrintersFolder", path: "shell:PrintersFolder", type: "directory", source: "destination", description: "Printers", kind: "shell" },
    { name: "shell:Cookies", path: "shell:Cookies", type: "directory", source: "destination", description: "Cookies", kind: "shell" },
    { name: "shell:Favorites", path: "shell:Favorites", type: "directory", source: "destination", description: "Favorites", kind: "shell" },
    { name: "shell:History", path: "shell:History", type: "directory", source: "destination", description: "Browser history", kind: "shell" },
    { name: "shell:Recent", path: "shell:Recent", type: "directory", source: "destination", description: "Recent items", kind: "shell" },
    { name: "shell:SendTo", path: "shell:SendTo", type: "directory", source: "destination", description: "Send-to menu", kind: "shell" },
    { name: "shell:Templates", path: "shell:Templates", type: "directory", source: "destination", description: "Templates", kind: "shell" },
    { name: "shell:Fonts", path: "shell:Fonts", type: "directory", source: "destination", description: "Installed fonts", kind: "shell" },
  ];

  const GUID_SUGGESTIONS: ShortcutEntry[] = [
    { name: "This PC", path: "::{20d04fe0-3aea-1069-a2d8-08002b30309d}", type: "directory", source: "destination", description: "Computer / Drives and Devices", kind: "guid" },
    { name: "Downloads", path: "::{374de290-123f-4565-9164-39c4925e467b}", type: "directory", source: "destination", description: "User Downloads folder", kind: "guid" },
    { name: "Desktop", path: "::{b4bfcc3a-db2c-424c-b029-7fe99a87c641}", type: "directory", source: "destination", description: "User Desktop", kind: "guid" },
    { name: "AppData (Roaming)", path: "::{3eb685db-65f9-4cf6-a03a-e3ef65729f3d}", type: "directory", source: "destination", description: "Roaming AppData", kind: "guid" },
    { name: "AppData (Local)", path: "::{f1b32785-6fba-4fcf-9d55-7b8e7f157091}", type: "directory", source: "destination", description: "Local AppData", kind: "guid" },
    { name: "Documents", path: "::{fdd39ad0-238f-46af-adb4-6c85480369c7}", type: "directory", source: "destination", description: "User Documents", kind: "guid" },
    { name: "Pictures", path: "::{b7bede81-df94-4682-a7d8-57a52620b86f}", type: "directory", source: "destination", description: "User Pictures", kind: "guid" },
    { name: "Videos", path: "::{18989b1d-99b5-455b-841c-ab7c74e4ddfc}", type: "directory", source: "destination", description: "User Videos", kind: "guid" },
    { name: "Music", path: "::{4bd8d571-6d19-48d3-be97-422220080e43}", type: "directory", source: "destination", description: "User Music", kind: "guid" },
    { name: "Programs", path: "::{a77f5d77-2e2b-44c3-a6a2-aba601054a85}", type: "directory", source: "destination", description: "Start Menu Programs", kind: "guid" },
    { name: "ProgramData", path: "::{62ab5d82-fdc1-4dc3-a9dd-070d1d495d7f}", type: "directory", source: "destination", description: "ProgramData (common files)", kind: "guid" },
    { name: "Windows", path: "::{f38bf404-1d43-42f2-9305-67de0b28fc23}", type: "directory", source: "destination", description: "Windows installation folder", kind: "guid" },
    { name: "System32", path: "::{1ac14e77-02e7-4e5d-b744-2eb1ae5198b7}", type: "directory", source: "destination", description: "System32", kind: "guid" },
    { name: "System32 (x86)", path: "::{d65231b0-b2f1-4857-a4ce-a8e7c6ea7d27}", type: "directory", source: "destination", description: "SysWOW64 (x86) on 64-bit Windows", kind: "guid" },
    { name: "User Profile", path: "::{5e6c858f-0e22-4760-9afe-ea3317b67173}", type: "directory", source: "destination", description: "Current user profile root", kind: "guid" },
    { name: "Public", path: "::{dfdf76a2-c82a-4d63-906a-5644ac457385}", type: "directory", source: "destination", description: "Public shared folder", kind: "guid" },
    { name: "Recycle Bin", path: "::{b7534046-3ecb-4c18-be4e-64cd4cb7d6ac}", type: "directory", source: "destination", description: "Recycle Bin (current user)", kind: "guid" },
    { name: "Network", path: "::{d20beec4-5ca8-4905-ae3b-bf251ea32b42}", type: "directory", source: "destination", description: "Network and Sharing Center", kind: "guid" },
    { name: "Control Panel", path: "::{26EE0668-A00A-44D7-9371-BEB064C92B41}", type: "directory", source: "destination", description: "Control Panel", kind: "guid" },
    { name: "Printers", path: "::{76FC4E2D-D6AD-4519-A663-37BD56068185}", type: "directory", source: "destination", description: "Devices and Printers", kind: "guid" },
    { name: "Program Files", path: "::{905E63B6-C1BF-494E-B29C-65B732D3D21A}", type: "directory", source: "destination", description: "64-bit Program Files", kind: "guid" },
    { name: "Program Files (x86)", path: "::{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}", type: "directory", source: "destination", description: "32-bit Program Files on 64-bit Windows", kind: "guid" },
    { name: "OneDrive", path: "::{018D5C66-4813-4F46-8D33-6A697473C887}", type: "directory", source: "destination", description: "OneDrive root", kind: "guid" },
  ];

  // Quick-jump suggestions that appear when the user types a keyword in the
  // address bar (no % / shell: / ::{ prefix required). These match common
  // natural-language queries for special locations.
  const QUICK_JUMP_SUGGESTIONS: ShortcutEntry[] = [
    { name: "This PC", path: "::{20d04fe0-3aea-1069-a2d8-08002b30309d}", type: "directory", source: "destination", description: "Computer / Drives", kind: "guid" },
    { name: "Recycle Bin", path: "::{b7534046-3ecb-4c18-be4e-64cd4cb7d6ac}", type: "directory", source: "destination", description: "Recycle Bin", kind: "guid" },
    { name: "Network", path: "::{d20beec4-5ca8-4905-ae3b-bf251ea32b42}", type: "directory", source: "destination", description: "Network", kind: "guid" },
    { name: "Control Panel", path: "::{26ee0668-a00a-44d7-9371-beb064c92b41}", type: "directory", source: "destination", description: "Control Panel", kind: "guid" },
    { name: "Downloads", path: "::{374de290-123f-4565-9164-39c4925e467b}", type: "directory", source: "destination", description: "Downloads", kind: "guid" },
    { name: "Desktop", path: "::{b4bfcc3a-db2c-424c-b029-7fe99a87c641}", type: "directory", source: "destination", description: "Desktop", kind: "guid" },
    { name: "Documents", path: "::{fdd39ad0-238f-46af-adb4-6c85480369c7}", type: "directory", source: "destination", description: "Documents", kind: "guid" },
  ];

  const buildShortcutSuggestions = useCallback((query: string): ShortcutEntry[] => {
    const lowerQuery = query.toLowerCase();
    let pool: ShortcutEntry[] = [];

    // Plain keyword query (no prefix) → quick-jump special locations
    if (lowerQuery.startsWith("%")) {
      pool = ENV_VAR_SUGGESTIONS;
    } else if (lowerQuery.startsWith("shell:")) {
      pool = SHELL_SUGGESTIONS;
    } else if (lowerQuery.startsWith("::{")) {
      pool = GUID_SUGGESTIONS;
    } else {
      // Quick-jump: match "this pc", "recycle", "network", "control panel",
      // "downloads", "desktop", "documents", etc. without requiring ::{ prefix.
      pool = QUICK_JUMP_SUGGESTIONS;
    }

    // Filter by name OR description so typing "computer" matches "This PC".
    return pool.filter((entry) =>
      entry.name.toLowerCase().includes(lowerQuery) ||
      entry.description.toLowerCase().includes(lowerQuery) ||
      entry.path.toLowerCase().includes(lowerQuery)
    ).slice(0, 30);
  }, []);

  const scorePathSuggestion = useCallback((entry: ShortcutEntry, rawQuery: string) => {
    const query = normalizeAddressPath(rawQuery).toLowerCase();
    if (!query) {
      let score = entry.source === "destination" ? 30 : 20;
      score += entry.type === "directory" ? 10 : 0;
      return score;
    }

    const lowerName = entry.name.toLowerCase();
    const lowerPath = entry.path.toLowerCase();
    let score = 0;

    if (lowerName === query) score += 140;
    else if (lowerName.startsWith(query)) score += 110;
    else if (lowerName.includes(query)) score += 80;

    if (lowerPath === query) score += 180;
    else if (lowerPath.startsWith(query)) score += 120;
    else if (lowerPath.includes(query)) score += 60;

    const queryChars = [...query].filter((char) => char !== '\\');
    if (queryChars.length > 0) {
      let cursor = 0;
      for (const char of lowerName) {
        if (char === queryChars[cursor]) cursor += 1;
        if (cursor === queryChars.length) {
          score += 35;
          break;
        }
      }
    }

    score += entry.type === "directory" ? 12 : 0;
    score += entry.source === "destination" ? 6 : 0;
    score -= Math.min(entry.path.length / 20, 10);
    return score;
  }, [normalizeAddressPath]);

  const destinationSuggestions = useMemo(() => {
    const query = normalizeAddressPath(debouncedTypedPath).toLowerCase();
    const mapped: ShortcutEntry[] = navigationDestinations
      .filter((destination) => {
        if (!query) return destination.kind !== "current";
        // Exclude virtual paths (thispc://, recyclebin://, network://) from destination suggestions
        // as they're handled by quick-jump suggestions with proper names
        if (destination.path.startsWith("thispc://") || 
            destination.path.startsWith("recyclebin://") || 
            destination.path.startsWith("network://")) {
          return false;
        }
        return destination.label.toLowerCase().includes(query) || destination.path.toLowerCase().includes(query);
      })
      .map((destination) => ({
        name: destination.label,
        path: destination.path,
        type: "directory" as const,
        source: "destination" as const,
        description: destination.label,
        kind: "guid" as ShortcutEntry["kind"],
      }))
      .slice(0, query ? 20 : 24);
    return mapped.sort((a, b) => scorePathSuggestion(b, query) - scorePathSuggestion(a, query));
  }, [debouncedTypedPath, navigationDestinations, normalizeAddressPath, scorePathSuggestion]);

  const trimPathToParentSegment = useCallback((value: string) => {
    const normalized = normalizeAddressPath(value);
    if (!normalized) return "";

    const withoutTrailing = normalized.replace(/\\+$/, "");
    const driveMatch = withoutTrailing.match(/^[A-Za-z]:$/);
    if (driveMatch) {
      return `${driveMatch[0]}\\`;
    }

    if (withoutTrailing.startsWith("\\\\")) {
      const lastSlash = withoutTrailing.lastIndexOf("\\");
      if (lastSlash <= 1) return withoutTrailing;
      return withoutTrailing.slice(0, lastSlash);
    }

    const lastSlash = withoutTrailing.lastIndexOf("\\");
    if (lastSlash < 0) return withoutTrailing;
    if (/^[A-Za-z]:$/.test(withoutTrailing.slice(0, lastSlash))) {
      return `${withoutTrailing.slice(0, lastSlash)}\\`;
    }
    return withoutTrailing.slice(0, lastSlash);
  }, [normalizeAddressPath]);

  const getSuggestionMetaLabel = useCallback((suggestion: ShortcutEntry) => {
    if (suggestion.source === "destination") {
      return explorer.language === "vi" ? "Lối tắt" : "Quick jump";
    }
    return suggestion.type === "directory"
      ? (explorer.language === "vi" ? "Folder" : "Folder")
      : (explorer.language === "vi" ? "File" : "File");
  }, [explorer.language]);

  const getSuggestionBadgeLabel = useCallback((suggestion: ShortcutEntry) => {
    if (suggestion.source === "destination") {
      return explorer.language === "vi" ? "Recent" : "Recent";
    }
    return suggestion.type === "directory"
      ? (explorer.language === "vi" ? "Folder" : "Folder")
      : (explorer.language === "vi" ? "File" : "File");
  }, [explorer.language]);

  const highlightMatch = useCallback((text: string, query: string) => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return <>{text}</>;

    const lowerText = text.toLowerCase();
    const matchIndex = lowerText.indexOf(normalizedQuery);
    if (matchIndex < 0) return <>{text}</>;

    const before = text.slice(0, matchIndex);
    const match = text.slice(matchIndex, matchIndex + normalizedQuery.length);
    const after = text.slice(matchIndex + normalizedQuery.length);

    return (
      <>
        {before}
        <mark className="bg-transparent font-semibold" style={{ color: accentColor }}>{match}</mark>
        {after}
      </>
    );
  }, [accentColor]);

  const crumbs = useMemo(
    () => (activeTab?.currentPath ? buildPathCrumbs(activeTab.currentPath) : []),
    [activeTab?.currentPath, buildPathCrumbs]
  );

  // Measure breadcrumb container width and the natural width of the full
  // strip so we can decide whether to collapse the middle into "...".
  useLayoutEffect(() => {
    if (crumbs.length === 0) {
      setCrumbsContainerWidth(0);
      setFullCrumbsWidth(0);
      return;
    }

    const containerEl = crumbsContainerRef.current;
    const measureEl = crumbsMeasureRef.current;
    if (!containerEl || !measureEl) return;

    const update = () => {
      const cw = containerEl.clientWidth;
      const mw = measureEl.scrollWidth;
      setCrumbsContainerWidth(cw);
      setFullCrumbsWidth(mw);
    };

    update();
    // Re-measure on the next frame to account for any layout that settles
    // after this effect runs (font loading, scrollbar reflow, etc.).
    const rafId = window.requestAnimationFrame(update);

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => update());
      // Observe the container AND the measurement strip so we react to any
      // ancestor resize (window resize, sidebar resize, etc.).
      resizeObserver.observe(containerEl);
      if (measureEl.parentElement) resizeObserver.observe(measureEl.parentElement);
    }

    // Belt-and-suspenders: also listen to the window resize event.
    // Some platforms (older WebView, certain Linux WMs) do not fire
    // ResizeObserver reliably for every ancestor level.
    window.addEventListener("resize", update);

    return () => {
      window.cancelAnimationFrame(rafId);
      if (resizeObserver) resizeObserver.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [crumbs]);
  useEffect(() => {
    const handleClose = () => {
      setActiveDropdown(null);
      setShowHiddenCrumbsMenu(false);
      setOpenCrumbDropdownPath(null);
    };
    window.addEventListener("click", handleClose);
    return () => window.removeEventListener("click", handleClose);
  }, []);

  // Listen for context menu opened event to close header dropdowns
  useEffect(() => {
    const unsubscribe = dropdownEventBus.on(DROPDOWN_EVENTS.CONTEXT_MENU_OPENED, () => {
      setActiveDropdown(null);
      setShowHiddenCrumbsMenu(false);
      setOpenCrumbDropdownPath(null);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!isEditingPath) {
      setPathSuggestions([]);
      setSelectedSuggestionIndex(-1);
      return;
    }

    const trimmed = debouncedTypedPath.trim();

    // Shortcut mode: the user is typing a `%Var`, `shell:Name`, or
    // `::{GUID}` reference. Build a curated suggestion list locally —
    // no need to call into the filesystem because these shortcuts
    // resolve to fixed paths on the current machine.
    if (trimmed.startsWith("%") || trimmed.startsWith("shell:") || trimmed.startsWith("::{")) {
      const matches = buildShortcutSuggestions(trimmed);
      if (matches.length > 0) {
        setPathSuggestions(matches);
        setSelectedSuggestionIndex(0);
      } else {
        setPathSuggestions([]);
        setSelectedSuggestionIndex(-1);
      }
      return;
    }

    let cancelled = false;
    const loadSuggestions = async () => {
      const { parentPath, partialName } = splitTypedPath(debouncedTypedPath);
      const lookupPath = parentPath || activeTab?.currentPath || "";
      const shouldShowDestinationSuggestions = !debouncedTypedPath.trim() || !/[\\/]/.test(debouncedTypedPath);

      if (!lookupPath && !shouldShowDestinationSuggestions) {
        setPathSuggestions([]);
        setSelectedSuggestionIndex(-1);
        return;
      }

      const entries = lookupPath ? await loadPathEntries(lookupPath) : [];
      if (cancelled) return;

      type FileEntry = { name: string; path: string; type: "file" | "directory" };
      const asEntry = (e: FileEntry): ShortcutEntry => ({
        name: e.name,
        path: e.path,
        type: e.type,
        source: "child",
        description: "",
        kind: "env",
      });

      const filtered = entries
        .filter((entry) => {
          if (!partialName) return true;
          const lowerPartial = partialName.toLowerCase();
          return entry.name.toLowerCase().includes(lowerPartial) || entry.path.toLowerCase().includes(lowerPartial);
        })
        .slice(0, 40)
        .map(asEntry)
        .sort((a, b) => scorePathSuggestion(b, partialName || debouncedTypedPath) - scorePathSuggestion(a, partialName || debouncedTypedPath));

      // merged suggestions = quick-jump + destination + child entries
      // Deduplicate by name: quick-jump items take priority (they have better names/descriptions)
      const quickJumpSuggestions = buildShortcutSuggestions(debouncedTypedPath);
      const quickJumpNames = new Set(quickJumpSuggestions.map(s => s.name.toLowerCase()));
      
      // Filter destination suggestions to exclude items with same name as quick-jump
      const filteredDestinations = destinationSuggestions.filter(
        d => !quickJumpNames.has(d.name.toLowerCase())
      );
      
      const mergedSuggestions = shouldShowDestinationSuggestions
        ? [...quickJumpSuggestions, ...filteredDestinations, ...filtered].filter((entry, index, arr) => arr.findIndex((item) => item.path === entry.path) === index)
        : [...quickJumpSuggestions, ...filtered].filter((entry, index, arr) => arr.findIndex((item) => item.path === entry.path) === index);

      setPathSuggestions(mergedSuggestions.slice(0, 40));
      setSelectedSuggestionIndex(mergedSuggestions.length > 0 ? 0 : -1);
    };

    void loadSuggestions();
    return () => {
      cancelled = true;
    };
  }, [activeTab?.currentPath, debouncedTypedPath, destinationSuggestions, isEditingPath, loadPathEntries, scorePathSuggestion, splitTypedPath]);

  useEffect(() => {
    if (!isEditingPath) return;
    const frame = requestAnimationFrame(() => {
      addressInputRef.current?.focus();
      addressInputRef.current?.select();
      // Update suggestion dropdown position
      const rect = addressInputRef.current?.getBoundingClientRect();
      if (rect) {
        setPathSuggestionsPos({
          top: rect.bottom + 8,
          left: rect.left,
          width: rect.width,
        });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [isEditingPath]);

  useEffect(() => {
    if (!isEditingPath || selectedSuggestionIndex < 0) return;
    activeSuggestionRef.current?.scrollIntoView({ block: "nearest" });
  }, [isEditingPath, selectedSuggestionIndex, pathSuggestions]);

  useEffect(() => {
    const handleAddressBarShortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey && key === "l") || (event.altKey && key === "d")) {
        event.preventDefault();
        openPathEditor();
      }
    };

    window.addEventListener("keydown", handleAddressBarShortcut, true);
    return () => window.removeEventListener("keydown", handleAddressBarShortcut, true);
  }, [openPathEditor]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchFilter((prev) => ({ ...prev, query: searchInput, mode: "default" }));
  };

  const handleSearchClear = () => {
    setSearchInput("");
    setSearchFilter((prev) => ({ ...prev, query: "", mode: "default" }));
  };

  // Selection calculations - normalize paths for comparison
  const selectedIdsNorm = selectedIds.map(id => id.replace(/\\/g, "/"));
  const selectedItems = items.filter(item => selectedIdsNorm.includes(item.id.replace(/\\/g, "/")));
  const hasSelection = selectedItems.length > 0;
  const isSingleSelection = selectedItems.length === 1;

  const cmdBtnClass = `flex items-center gap-1.5 px-2.5 py-1.5 rounded-md disabled:opacity-30 disabled:hover:bg-transparent transition cursor-pointer font-medium shrink-0 text-stone-300 hover:bg-white/5 hover:text-white`;

  const filterPills = [
    { type: null, label: "Tất cả", color: "#a8a29e" }, // Neutral/All
    { type: "3d", label: "Mô hình", color: "#818cf8" }, // Indigo
    { type: "image", label: "Hình ảnh", color: "#34d399" }, // Emerald 
    { type: "video", label: "Videos", color: "#f43f5e" }, // Rose
    { type: "audio", label: "Âm thanh", color: "#fbbf24" }, // Amber
    { type: "code_doc", label: "Scripts", color: "#38bdf8" }, // Sky
  ] as const;


  // Responsive collapse calculation (moved outside renderBreadcrumbFlow for dropdown access)
  const isOverflowing = crumbsContainerWidth > 0 && fullCrumbsWidth > crumbsContainerWidth + 1;
  const shouldCollapse = crumbs.length > 0 && isOverflowing;
  const visibleCrumbs = shouldCollapse ? [crumbs[0], ...crumbs.slice(-2)] : crumbs;
  const hiddenCrumbs = shouldCollapse ? crumbs.slice(1, -2) : [];

  const renderBreadcrumbFlow = () => {
    if (crumbs.length === 0) return null;

    return visibleCrumbs.map((crumb, idx) => {
      const isLast = idx === visibleCrumbs.length - 1;
      const showHiddenMenuBefore = shouldCollapse && idx === 1;
      const dropdownEntries = crumbDropdownEntries[crumb.folderId] || [];
      const isDropdownOpen = openCrumbDropdownPath === crumb.folderId;

      return (
        <React.Fragment key={crumb.folderId || idx}>
          {showHiddenMenuBefore && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setHiddenCrumbsDropdownPos({ top: rect.bottom + 8, left: rect.left });
                  setShowHiddenCrumbsMenu((prev) => !prev);
                  setOpenCrumbDropdownPath(null);
                  setActiveDropdown(null);
                }}
                className="px-2 py-0.5 rounded font-bold cursor-pointer text-xs transition-colors text-stone-400 hover:text-white hover:bg-white/5 shrink-0"
                title={explorer.language === "vi" ? "Xem thư mục bị ẩn" : "Show hidden path segments"}
              >
                ...
              </button>
            </>
          )}

          <div
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="relative flex items-center crumb-dropdown-container"
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowHiddenCrumbsMenu(false);
                setOpenCrumbDropdownPath(null);
                navigateTo(crumb.folderId);
                setShowSpaceAnalyzer(false);
              }}
              className={`whitespace-nowrap transition-all duration-150 py-0.5 px-2 rounded max-w-[150px] truncate ${
                isLast
                  ? "font-bold text-xs"
                  : "text-stone-400 hover:text-stone-100 hover:bg-white/5 hover:text-stone-100 text-xs"
              }`}
              style={isLast ? { color: accentColor } : {}}
            >
              {crumb.name}
            </button>

            {!isLast && (
              <div
                onMouseDown={(e) => e.stopPropagation()}
                className="ml-0.5"
              >
                <button
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    setShowHiddenCrumbsMenu(false);
                    setActiveDropdown(null);
                    const rect = e.currentTarget.getBoundingClientRect();
                    void openCrumbDropdown(crumb.folderId, rect);
                  }}
                  className="p-1 rounded transition-colors text-stone-500 hover:text-white hover:bg-white/5"
                  title={explorer.language === "vi" ? "Mở danh sách thư mục con" : "Open child folders"}
                >
                  <ChevronDown className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
        </React.Fragment>
      );
    });
  };

  // Render dropdown menu outside the crumb loop (so it works when crumb is collapsed)
  const activeDropdownPath = openCrumbDropdownPath;
  const activeDropdownEntries = activeDropdownPath ? crumbDropdownEntries[activeDropdownPath] || [] : [];
  const showDropdown = !!activeDropdownPath && activeDropdownEntries.length > 0;

  return (
    <div className="goku-header relative z-[400] flex flex-col select-none transition-colors duration-200"
      style={{ borderBottomWidth: "1px", borderBottomStyle: "solid", borderBottomColor: explorer.theme === "light" ? "#e5e5e5" : "rgba(255,255,255,0.05)" }}
    >
      {showDropdown && (
        <div
          className="fixed min-w-[220px] max-w-[280px] fluent-menu rounded-xl overflow-hidden z-[600]"
          style={{
            top: crumbDropdownPos.top,
            left: crumbDropdownPos.left,
          }}
        >
          {activeDropdownEntries.slice(0, 12).map((entry) => (
            <button
              key={entry.path}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={() => {
                setOpenCrumbDropdownPath(null);
                navigateTo(entry.path);
                setShowSpaceAnalyzer(false);
              }}
              className="w-full text-left px-3 py-2 text-xs transition-colors text-stone-200 hover:bg-white/5 hover:text-white"
              title={entry.path}
            >
              <div className="truncate font-medium">{entry.name}</div>
              <div className="truncate text-[10px] mt-0.5 text-stone-500">
                {entry.path}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Hidden crumbs dropdown - rendered as fixed for overflow handling */}
      {showHiddenCrumbsMenu && hiddenCrumbs.length > 0 && (
        <div
          className="fixed min-w-[200px] fluent-menu rounded-xl overflow-hidden z-[600]"
          style={{
            top: hiddenCrumbsDropdownPos.top,
            left: hiddenCrumbsDropdownPos.left,
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {hiddenCrumbs.map((hiddenCrumb) => (
            <button
              key={hiddenCrumb.folderId}
              onClick={() => {
                setShowHiddenCrumbsMenu(false);
                setOpenCrumbDropdownPath(null);
                navigateTo(hiddenCrumb.folderId);
                setShowSpaceAnalyzer(false);
              }}
              className="w-full text-left px-3 py-2 text-xs transition-colors text-stone-200 hover:bg-white/5 hover:text-white"
              title={hiddenCrumb.folderId}
            >
              <div className="truncate font-medium">{hiddenCrumb.name}</div>
              <div className="truncate text-[10px] mt-0.5 text-stone-500">
                {hiddenCrumb.folderId}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Path suggestions dropdown - rendered as fixed for overflow handling */}
      {isEditingPath && pathSuggestions.length > 0 && (
        <div
          ref={pathSuggestionsContainerRef}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className={`fixed rounded-lg fluent-menu overflow-hidden z-[600] max-h-72 overflow-y-auto goku-thin-scroll overscroll-contain goku-addr-suggest ${explorer.theme === "light" ? "theme-light" : ""}`}
          style={{
            top: pathSuggestionsPos.top,
            left: pathSuggestionsPos.left,
            width: pathSuggestionsPos.width > 0 ? pathSuggestionsPos.width : undefined,
          }}
        >
          {pathSuggestions.map((suggestion, index) => {
            const isActive = index === selectedSuggestionIndex;
            return (
              <button
                ref={isActive ? activeSuggestionRef : null}
                key={suggestion.path}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  // For GUID suggestions, navigate directly instead of just filling the input
                  if (suggestion.path.startsWith("::{")) {
                    const guidLower = suggestion.path.toLowerCase();
                    let virtualPath: string | undefined;
                    if (guidLower === "::{20d04fe0-3aea-1069-a2d8-08002b30309d}") virtualPath = "thispc://";
                    else if (guidLower === "::{b7534046-3ecb-4c18-be4e-64cd4cb7d6ac}") virtualPath = "recyclebin://";
                    else if (guidLower === "::{d20beec4-5ca8-4905-ae3b-bf251ea32b42}") virtualPath = "network://";
                    
                    if (virtualPath) {
                      navigateTo(virtualPath);
                      setIsEditingPath(false);
                      setTypedPath(suggestion.name);
                      setPathSuggestions([]);
                      setSelectedSuggestionIndex(-1);
                      return;
                    }
                  }
                  applySuggestion(suggestion.path);
                }}
                className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                  isActive
                    ? "bg-white/8 text-white"
                    : "text-stone-200 hover:bg-white/5"
                }`}
                title={suggestion.path}
              >
                <div className="flex items-start justify-between gap-2.5">
                  <div className="min-w-0 flex-1 flex items-start gap-2">
                    <div className="mt-0.5 shrink-0">
                      {(() => {
                        const isGuid = suggestion.path.startsWith("::{");
                        const isSpecial = suggestion.kind === "guid" || suggestion.kind === "shell";
                        if (isGuid) {
                          // Resolve shell icon for special GUID locations
                          // Compare GUIDs case-insensitively
                          const guidLower = suggestion.path.toLowerCase();
                          if (guidLower === "::{20d04fe0-3aea-1069-a2d8-08002b30309d}") {
                            return (
                              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "3px", overflow: "hidden", padding: "1px", flexShrink: 0 }}>
                                <svg viewBox="0 0 16 16" width={14} height={14} className="text-sky-400" fill="currentColor">
                                  <path d="M1 3a1 1 0 011-1h3.5a1 1 0 011 1v1h4a1 1 0 011 1v6a1 1 0 01-1 1H2a1 1 0 01-1-1V3zm1.5 0v8h10V4H5V3h-1.5zm2 2h6v1H5V5z" />
                                </svg>
                              </span>
                            );
                          }
                          if (guidLower === "::{b7534046-3ecb-4c18-be4e-64cd4cb7d6ac}") {
                            return (
                              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "3px", overflow: "hidden", padding: "1px", flexShrink: 0 }}>
                                <svg viewBox="0 0 16 16" width={14} height={14} className="text-stone-400" fill="currentColor">
                                  <path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H3a1 1 0 000 2h1v7a2 2 0 002 2h4a2 2 0 002-2V6h1a1 1 0 100-2H7V3a1 1 0 00-1-1z" />
                                </svg>
                              </span>
                            );
                          }
                          if (guidLower === "::{d20beec4-5ca8-4905-ae3b-bf251ea32b42}") {
                            return (
                              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "3px", overflow: "hidden", padding: "1px", flexShrink: 0 }}>
                                <svg viewBox="0 0 16 16" width={14} height={14} className="text-emerald-400" fill="currentColor">
                                  <path d="M6.354 3.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm5.5 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm-4 2.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm0 4a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM4 13a2 2 0 100-4 2 2 0 000 4zm8 0a2 2 0 100-4 2 2 0 000 4z" />
                                </svg>
                              </span>
                            );
                          }
                          // Generic folder icon for other GUIDs
                          return (
                            <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "3px", overflow: "hidden", padding: "1px", flexShrink: 0 }}>
                              <svg viewBox="0 0 16 16" width={14} height={14} className="text-amber-400" fill="currentColor">
                                <path d="M1 3a1 1 0 011-1h4l1 1h6a1 1 0 011 1v8a1 1 0 01-1 1H2a1 1 0 01-1-1V3z" />
                              </svg>
                            </span>
                          );
                        }
                        // Use Lucide Folder icon instead of WindowsFolder for lighter app
                        return suggestion.type === "directory" ? (
                          <Folder className="w-3.5 h-3.5 text-amber-400" />
                        ) : (
                          <FileText className="w-3.5 h-3.5 text-sky-400" />
                        );
                      })()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {highlightMatch(suggestion.name, debouncedTypedPath || typedPath)}
                      </div>
                      <div className="truncate text-[10px] mt-0.5 text-stone-500">
                        {suggestion.kind === "guid" ? suggestion.description : highlightMatch(suggestion.path, debouncedTypedPath || typedPath)}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${suggestion.source === "destination"
                      ? "text-orange-300"
                      : suggestion.type === "directory"
                        ? "bg-amber-500/15 text-amber-300"
                        : "bg-sky-500/15 text-sky-300"}`}
                      style={suggestion.source === "destination" ? { backgroundColor: `${accentColor}20`, color: accentColor } : {}}>
                      {getSuggestionBadgeLabel(suggestion)}
                    </span>
                    <span className="text-[9px] text-stone-500">
                      {getSuggestionMetaLabel(suggestion)}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleLocalFileImport}
        className="hidden"
        accept=".txt,.md,.json,.html,.js,.ts,.tsx,.css,.obj,.stl,.ply,.gcode,.yaml,.yml,.xml"
      />
      
      {/* 1. Titlebar: Goku File Explorer */}
      <div
        data-tauri-drag-region
        onDoubleClick={handleTitlebarDoubleClick}
        className="goku-titlebar flex items-center justify-between px-4 py-2 text-xs shrink-0 border-b transition-colors duration-200 select-none text-stone-400"
        style={{
          background: `linear-gradient(135deg, ${accentColor}15 0%, transparent 100%)`,
          borderColor: `${accentColor}25`,
        }}
      >
        <div className="flex items-center gap-4">
          <Monitor className="w-4 h-4 animate-pulse" style={{ color: accentColor }} />
          <span className="font-extrabold tracking-wider" style={{ color: accentColor }}>GOKU FILE EXPLORER</span>
          <span className="text-[10px] text-stone-200 font-mono">|</span>
          <span className="text-[10px] text-stone-200 font-mono">Design by GokuMedia</span>
          {/* Author button */}
          <div className="relative" data-author-menu>
            <button
              ref={authorBtnRef}
              onClick={() => setShowAuthorMenu((v) => !v)}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] font-medium border cursor-pointer transition-colors"
              style={{
                color: accentColor,
                backgroundColor: showAuthorMenu ? `${accentColor}25` : `${accentColor}15`,
                borderColor: `${accentColor}30`,
              }}
              title={explorer.language === "vi" ? "Tác giả" : "Author"}
            >
              <User className="w-2.5 h-2.5" />
              <span>{explorer.language === "vi" ? "Tác giả" : "Author"}</span>
              <ChevronDown className={`w-2.5 h-2.5 transition-transform ${showAuthorMenu ? "rotate-180" : ""}`} />
            </button>
            {showAuthorMenu && authorMenuPos && createPortal(
              <div
                data-author-dropdown
                className="fixed rounded-lg overflow-hidden border"
                style={{
                  top: authorMenuPos.top,
                  left: authorMenuPos.left,
                  minWidth: 160,
                  zIndex: 99999,
                  backgroundColor: explorer.theme === "light" ? "#ffffff" : "#191919",
                  borderColor: explorer.theme === "light" ? "rgba(133,133,133,0.8)" : "rgba(255,255,255,0.08)",
                }}
              >
                <button
                  onClick={async () => {
                    setShowAuthorMenu(false);
                    console.log("[Frontend] Click Dqa.arch - calling invoke");
                    try {
                      const { invoke } = await import("@tauri-apps/api/core");
                      const result = await invoke("open_external_url", { url: "http://dqa.vn/" });
                      console.log("[Frontend] invoke success:", result);
                    } catch (err) {
                      console.error("[Frontend] invoke error:", err);
                      window.open("http://dqa.vn/", "_blank", "noopener,noreferrer");
                    }
                  }}
                  className="w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2 cursor-pointer"
                  style={{
                    color: explorer.theme === "light" ? "#1f1f1f" : "#e7e5e4",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = explorer.theme === "light" ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.06)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }}
                >
                  <User className="w-3.5 h-3.5" style={{ color: accentColor }} />
                  <span>Dqa.arch</span>
                </button>
                <div
                  style={{
                    height: 1,
                    backgroundColor: explorer.theme === "light" ? "#e5e5e5" : "rgba(255,255,255,0.06)",
                  }}
                />
                <button
                  onClick={async () => {
                    setShowAuthorMenu(false);
                    console.log("[Frontend] Click GokuMedia - calling invoke");
                    try {
                      const { invoke } = await import("@tauri-apps/api/core");
                      const result = await invoke("open_external_url", { url: "https://goku.media/" });
                      console.log("[Frontend] invoke success:", result);
                    } catch (err) {
                      console.error("[Frontend] invoke error:", err);
                      window.open("https://goku.media/", "_blank", "noopener,noreferrer");
                    }
                  }}
                  className="w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2 cursor-pointer"
                  style={{
                    color: explorer.theme === "light" ? "#1f1f1f" : "#e7e5e4",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = explorer.theme === "light" ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.06)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }}
                >
                  <Monitor className="w-3.5 h-3.5" style={{ color: accentColor }} />
                  <span>GokuMedia</span>
                </button>
              </div>,
              document.body
            )}
          </div>
          <div
            className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] font-medium border"
            style={{
              color: accentColor,
              backgroundColor: `${accentColor}15`,
              borderColor: `${accentColor}30`
            }}
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: accentColor }}></span>
              <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ backgroundColor: accentColor }}></span>
            </span>
            <span>V1.0.3 Beta</span>
          </div>
        </div>

        {/* Window controls */}
        <div className="flex items-center gap-3">
          <div className="text-[10px] text-stone-500 font-mono hidden md:block">
            {statusMessage && `${explorer.language === "vi" ? "Trạng thái:" : "Status:"} ${statusMessage}`}
          </div>
          <div className="flex items-center gap-2 pr-1">
            <button
              onClick={() => getCurrentWindow().minimize()}
              className="p-1 px-2 rounded hover:bg-white/10 transition flex items-center justify-center cursor-pointer"
              title="Minimize"
            >
              <div className="w-3.5 h-1 bg-amber-400 rounded-full" />
            </button>
            <button
              onClick={toggleMaximize}
              className="p-1 px-2 rounded hover:bg-white/10 transition flex items-center justify-center cursor-pointer"
              title={isWindowMaximized ? "Restore" : "Maximize"}
            >
              {isWindowMaximized ? (
                // Restored window icon (two overlapping rectangles)
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="2" y="4" width="8" height="8" rx="0.5" stroke="#34d399" strokeWidth="1.5"/>
                  <path d="M4 4V3C4 2.44772 4.44772 2 5 2H11C11.5523 2 12 2.44772 12 3V9C12 9.55228 11.5523 10 11 10H10" stroke="#34d399" strokeWidth="1.5"/>
                </svg>
              ) : (
                // Maximized window icon (single rectangle)
                <div
                  className="w-3 h-3 rounded-sm"
                  style={{ border: "2px solid #34d399" }}
                />
              )}
            </button>
            <button
              onClick={() => getCurrentWindow().close()}
              className="p-1 px-2 rounded hover:bg-red-500/20 transition flex items-center justify-center group cursor-pointer"
              title="Close"
            >
              <X className="w-4 h-4 text-red-500 stroke-[3] group-hover:text-red-400" />
            </button>
          </div>
        </div>
      </div>

      {/* 2. Row 2: Modern Tabs Bar + Settings Panel */}
      <div 
        className="flex items-center justify-between shrink-0 relative px-4 transition-colors duration-200"
      >
        {/* Left side: New tab button + Tabs dropdown */}
        <div className="flex items-center gap-1 shrink-0 z-10" data-active-dropdown>
          {/* New tab button */}
          <button
            onClick={() => createNewTab(null)}
            className="p-1 rounded-full text-stone-400 hover:text-stone-100 hover:bg-white/5 transition cursor-pointer"
            title={explorer.language === "vi" ? "Mở tab mới (Ctrl+T)" : "Open new tab (Ctrl+T)"}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>

          {/* Dropdown button for overflow tabs */}
          {tabs.length > 5 && (
            <div className="relative" data-active-dropdown>
              <button
                ref={tabsDropdownButtonRef}
                onClick={(e) => {
                  e.stopPropagation();
                  if (activeDropdown === "tabs") {
                    setActiveDropdown(null);
                    setTabsDropdownPosition(null);
                  } else {
                    const rect = tabsDropdownButtonRef.current?.getBoundingClientRect();
                    if (rect) {
                      setTabsDropdownPosition({
                        top: rect.bottom + 6,
                        left: rect.left,
                      });
                    }
                    setActiveDropdown("tabs");
                  }
                }}
                className="flex items-center justify-center w-7 h-7 rounded-md text-stone-400 hover:text-stone-100 hover:bg-white/5 transition"
                title="More tabs"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Right side: Tabs container with horizontal scroll */}
        <div className="flex items-stretch overflow-x-auto scrollbar-none flex-1 pt-1.5 select-none min-w-0 ml-2">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => {
                  setActiveTabId(tab.id);
                  setShowSpaceAnalyzer(false);
                }}
                className={`group flex items-center justify-between h-8 px-3 text-xs rounded-t-lg transition-all duration-150 cursor-pointer border-t border-x text-stone-400 border-transparent hover:bg-white/5 hover:text-stone-200 shrink-0 ${isActive ? 'bg-[var(--row-bg)] text-stone-100' : ''}`}
                style={{ ...(isActive ? { marginBottom: '-1px' } : {}), width: tabWidth, maxWidth: tabWidth }}
              >
                <span className="flex items-center gap-1.5 truncate font-sans font-semibold">
                  {tab.currentFolderId?.startsWith("thispc://") ? (
                    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5 shrink-0 text-sky-400" fill="currentColor">
                      <path d="M2 4a2 2 0 012-2h3a2 2 0 012 2v1h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V4zm2 0v12h12V6H6V4zm2 2h2v2H8V6zm0 4h2v2H8v-2zm4-2h2v2h-2V8zm0 4h2v2h-2v-2z" />
                    </svg>
                  ) : tab.currentFolderId?.startsWith("recyclebin://") ? (
                    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5 shrink-0 text-stone-400" fill="currentColor">
                      <path fillRule="evenodd" d="M8 3a1 1 0 00-1 1v1H4a1 1 0 000 2h1v9a2 2 0 002 2h6a2 2 0 002-2V7h1a1 1 0 100-2h-3V4a1 1 0 00-1-1H8zm2 0h2v1H10V3z" />
                    </svg>
                  ) : (
                    <WindowsFolder
                      path={tab.currentPath}
                      size={14}
                      className="shrink-0"
                    />
                  )}
                  <span className="truncate">{tab.title}</span>
                </span>
                {tabs.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    className="p-0.5 rounded-full opacity-40 group-hover:opacity-100 transition hover:bg-white/10 text-stone-300 ml-2 shrink-0"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Far-Right: Settings controls */}
        <div className="relative flex items-center shrink-0 pl-4 py-1 z-50">

          {/* Language Toggle Button */}
          <button
            onClick={() => explorer.setLanguage(explorer.language === "vi" ? "en" : "vi")}
            className="flex items-center gap-1.5 px-2.5 h-6 rounded border text-[10px] font-semibold cursor-pointer transition select-none mr-2 text-stone-300"
            style={{
              backgroundColor: titlebarBg,
              borderColor: "rgba(255,255,255,0.1)",
            }}
            title={explorer.language === "vi" ? "Đổi ngôn ngữ sang tiếng Anh" : "Switch language to Vietnamese"}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = surfaceBg;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = titlebarBg;
            }}
          >
            <span className="font-mono">{explorer.language === "vi" ? "VN" : "ENG"}</span>
            <span>{explorer.language === "vi" ? "Tiếng Việt" : "English"}</span>
          </button>

          {/* Clear EXR in-memory cache.
              Drops `LayerCacheManager` ImageBitmap + RawLinear caches plus
              in-flight decode promises so a duplicate-frame bug (same path,
              swapped content) stops replaying the stale frame. Does NOT
              reload the page, does NOT touch tabs/navigation/pane state. */}
          <button
            onClick={() => {
              layerCacheManager.clearCache();
              explorer.setStatusMessage(
                explorer.language === "vi"
                  ? "Đã xóa cache EXR trong bộ nhớ."
                  : "Cleared in-memory EXR cache."
              );
            }}
            className="p-1.5 rounded-lg transition-all transform hover:scale-105 select-none cursor-pointer flex items-center justify-center mr-2 text-stone-400 hover:text-stone-100"
            title={explorer.language === "vi" ? "Xóa cache EXR trong bộ nhớ" : "Clear in-memory EXR cache"}
            data-testid="exr-cache-clear-button"
          >
            <RefreshCw className="w-4 h-4" />
          </button>

          <button
            ref={settingsButtonRef}
            onClick={() => {
              if (showSettings) {
                setShowSettings(false);
                return;
              }
              // Compute viewport coords so we can render the panel with
              // `position: fixed` outside of any ExplorerHeader stacking
              // context. This guarantees it sits above every other UI
              // layer, including the Selection Inspector (z-40) and
              // any animated badges that may have their own stacking
              // context (e.g. "Selected 1 assets" with fade-in).
              const rect = settingsButtonRef.current?.getBoundingClientRect();
              if (rect) {
                setSettingsPosition({
                  top: rect.bottom + 6,
                  right: window.innerWidth - rect.right,
                });
              }
              setShowSettings(true);
              setActiveDropdown(null);
            }}
            className="p-1.5 rounded-lg transition-all transform hover:scale-105 select-none cursor-pointer flex items-center justify-center text-stone-400 hover:text-stone-100"
            title={explorer.language === "vi" ? "Cài đặt hệ thống" : "System Settings"}
          >
            <Settings 
              className="w-4 h-4 transition-all duration-150" 
              style={{
                stroke: showSettings ? explorer.accentColor : "currentColor",
                fill: showSettings ? explorer.accentColor : "none"
              }}
            />
          </button>

          {/* Settings Overlay Dropdown Drop-in.
              Rendered with `position: fixed` and z-[9999] so it escapes
              every parent stacking context (the header, the row, and
              any animated badges). Coords come from the button's
              bounding rect captured on click. */}
          {showSettings && settingsPosition && createPortal(
            <div
              ref={settingsPanelRef}
              data-theme={explorer.theme}
              className={`fixed fluent-menu rounded-2xl p-4 min-w-[280px] text-left animate-in duration-100 fade-in z-[9999] goku-settings-panel ${explorer.theme === "light" ? "theme-light" : ""}`}
              style={{ 
                top: settingsPosition.top, 
                right: settingsPosition.right,
              }}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div 
                className="flex items-center justify-between mb-3 border-b pb-1.5" 
                style={{ borderColor: "var(--stroke-1)" }}
              >
                <span className="font-semibold font-mono uppercase text-xs"
                  style={{ color: "var(--fg-1)" }}>
                  {explorer.language === "vi" ? "Cài đặt hệ thống" : "System Settings"}
                </span>
              </div>

              {/* 1. Theme Dropdown */}
              <div className="mb-3.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium" style={{ color: "var(--fg-1)" }}>
                    Theme:
                  </span>
                  <select
                    value={explorer.isCustomTheme ? "custom" : explorer.theme}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "custom") return;
                      explorer.setTheme(v as any);
                    }}
                    className="text-[10.5px] p-1 px-2 rounded cursor-pointer font-sans min-w-[130px]"
                    style={{
                      backgroundColor: "var(--surface-bg)",
                      color: "var(--fg-1)",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "var(--stroke-1)",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--row-bg)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "var(--surface-bg)"; }}
                  >
                    {explorer.isCustomTheme && (
                      <option value="custom">— Custom —</option>
                    )}
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                    <option value="mono">Mono (Greyscale)</option>
                  </select>
                </div>
              </div>

              {/* 2. Font dropdown */}
              <div className="mb-3.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium" style={{ color: "var(--fg-1)" }}>
                    {explorer.language === "vi" ? "Phông chữ (Font):" : "System Font:"}
                  </span>
                  <select
                    value={explorer.font}
                    onChange={(e) => explorer.setFont(e.target.value as "segoeui" | "monospace")}
                    className="text-[10.5px] p-0.5 px-2 rounded cursor-pointer font-sans"
                    style={{
                      backgroundColor: "var(--surface-bg)",
                      color: "var(--fg-1)",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "var(--stroke-1)",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--row-bg)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "var(--surface-bg)"; }}
                  >
                    <option value="segoeui">Segoe UI</option>
                    <option value="monospace">Monospace</option>
                  </select>
                </div>
              </div>

              {/* 3. Font Size Range Slider */}
              <div className="mb-3.5 text-xs">
                <div className="flex items-center justify-between gap-4">
                  <span className="font-medium shrink-0" style={{ color: "var(--fg-1)" }}>
                    {explorer.language === "vi" ? "Tỉ lệ chữ:" : "Font Scale:"}
                  </span>
                  <div className="flex items-center gap-2 flex-1 justify-end max-w-[170px]">
                    <input
                      type="range"
                      min="100"
                      max="150"
                      value={explorer.fontSize}
                      onChange={(e) => explorer.setFontSize(parseInt(e.target.value))}
                      className="w-full cursor-pointer h-1 rounded-lg appearance-none"
                      style={{
                        background: "#a0a0a0",
                        accentColor: explorer.accentColor,
                      }}
                    />
                    <span 
                      className="text-[10.5px] font-mono font-medium w-11 text-center py-0.5 rounded shrink-0 select-none" 
                      style={{
                        backgroundColor: "var(--row-bg)",
                        color: "var(--fg-1)"
                      }}
                    >
                      {explorer.fontSize}%
                    </span>
                  </div>
                </div>
              </div>

              {/* 4. Menu BG Opacity Range Slider */}
              <div className="mb-3.5 text-xs">
                <div className="flex items-center justify-between gap-4">
                  <span className="font-medium shrink-0" style={{ color: "var(--fg-1)" }}>
                    {explorer.language === "vi" ? "Transparent BG:" : "Transparent BG:"}
                  </span>
                  <div className="flex items-center gap-2 flex-1 justify-end max-w-[170px]">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={explorer.menuBgOpacity}
                      onChange={(e) => explorer.setMenuBgOpacity(parseInt(e.target.value))}
                      className="w-full cursor-pointer h-1 rounded-lg appearance-none"
                      style={{
                        background: "#a0a0a0",
                        accentColor: explorer.accentColor,
                      }}
                    />
                    <span
                      className="text-[10.5px] font-mono font-medium w-11 text-center py-0.5 rounded shrink-0 select-none"
                      style={{
                        backgroundColor: "var(--row-bg)",
                        color: "var(--fg-1)"
                      }}
                    >
                      {explorer.menuBgOpacity}%
                    </span>
                  </div>
                </div>
              </div>

              {/* 6. Folder Sizes Toggle */}
              <div className="mb-3.5 text-xs">
                <div className="flex items-center justify-between gap-4">
                  <span className="font-medium shrink-0" style={{ color: "var(--fg-1)" }}>
                    {explorer.language === "vi" ? "Kích thước folder:" : "Folder Sizes:"}
                  </span>
                  <button
                    onClick={() => explorer.setShowFolderSizes(!explorer.showFolderSizes)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 cursor-pointer focus:outline-none`}
                    style={{
                      backgroundColor: explorer.showFolderSizes
                        ? explorer.accentColor
                        : "rgba(255,255,255,0.15)"
                    }}
                    title={explorer.language === "vi" ? "Hiển thị kích thước folder" : "Show folder sizes"}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform duration-200`}
                      style={{
                        transform: explorer.showFolderSizes ? "translateX(18px)" : "translateX(2px)"
                      }}
                    />
                  </button>
                </div>
              </div>

              {/* 7. Spacing Slider */}
              <div className="mb-3.5 text-xs">
                <div className="flex items-center justify-between gap-4">
                  <span className="font-medium shrink-0" style={{ color: "var(--fg-1)" }}>
                    {explorer.language === "vi" ? "Khoảng cách (Spacing):" : "Item Spacing:"}
                  </span>
                  <div className="flex items-center gap-2 flex-1 justify-end max-w-[170px]">
                    <input
                      type="range"
                      min="30"
                      max="70"
                      value={explorer.spacing}
                      onChange={(e) => explorer.setSpacing(parseInt(e.target.value))}
                      className="w-full cursor-pointer h-1 rounded-lg appearance-none"
                      style={{
                        background: "#a0a0a0",
                        accentColor: explorer.accentColor,
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* 8. Delete Confirmation Toggle */}
              <div className="mb-3.5 text-xs">
                <div className="flex items-center justify-between gap-4">
                  <span className="font-medium shrink-0" style={{ color: "var(--fg-1)" }}>
                    {explorer.language === "vi" ? "Xác nhận xóa tệp:" : "Delete Confirmation:"}
                  </span>
                  <button
                    onClick={() => explorer.setShowDeleteConfirmation(!explorer.showDeleteConfirmation)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 cursor-pointer focus:outline-none`}
                    style={{
                      backgroundColor: explorer.showDeleteConfirmation
                        ? explorer.accentColor
                        : "rgba(255,255,255,0.15)"
                    }}
                    title={explorer.language === "vi"
                      ? "Hiển thị thông báo xác nhận trước khi xóa"
                      : "Show confirmation dialog before deleting"}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform duration-200`}
                      style={{
                        transform: explorer.showDeleteConfirmation ? "translateX(18px)" : "translateX(2px)"
                      }}
                    />
                  </button>
                </div>
              </div>

              {/* 5. Accent color grid */}
              <div className="text-xs">
                <span className="font-medium block mb-1.5" style={{ color: "var(--fg-1)" }}>
                  {explorer.language === "vi" ? "Màu sắc nổi bật (Accent Color):" : "Accent Palette Choice:"}
                </span>
                <div className="flex gap-2 items-center justify-start pt-3">
                  {[
                    { name: "Win11 Blue", value: "#0078d4" },
                    { name: "Orange", value: "#ea580c" },
                    { name: "Forest Green", value: "#10b981" },
                    { name: "Teal", value: "#008080" },
                    { name: "Amethyst Violet", value: "#8b5cf6" },
                    { name: "Crimson Rose", value: "#e11d48" },
                    { name: "Amber Gold", value: "#f59e0b" },
                  ].map((color) => {
                    const active = explorer.accentColor.toLowerCase() === color.value.toLowerCase();
                    return (
                      <button
                        key={color.name}
                        onClick={() => explorer.setAccentColor(color.value)}
                        className={`w-4.5 h-4.5 rounded-full border transition-all duration-150 transform hover:scale-115 cursor-pointer flex items-center justify-center ${
                          active ? "ring-2 ring-emerald-500 border-white" : "border-stone-500/20"
                        }`}
                        style={{ backgroundColor: color.value }}
                        title={color.name}
                      >
                        {active && <Check className="w-2.5 h-2.5 text-white stroke-[3px]" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 6. Accent Custom Color (free-form picker) */}
              <div className="mt-3.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium shrink-0" style={{ color: "var(--fg-1)" }}>
                    {explorer.language === "vi" ? "Màu sắc tùy chỉnh (Accent):" : "Accent Custom Color:"}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      ref={accentColorButtonRef}
                      type="button"
                      onClick={() => {
                        const rect = accentColorButtonRef.current?.getBoundingClientRect();
                        if (rect) setColorPickerAnchor(rect);
                        setShowColorPicker(true);
                      }}
                      className="w-[18px] h-[18px] rounded-full border transition-all duration-150 transform hover:scale-115 cursor-pointer"
                      style={{
                        backgroundColor: explorer.customAccentColor ?? explorer.accentColor,
                        borderColor: "var(--stroke-1)",
                      }}
                      title={explorer.language === "vi" ? "Chọn màu accent tùy ý" : "Pick any accent color"}
                      aria-label={explorer.language === "vi" ? "Chọn màu accent tùy ý" : "Pick any accent color"}
                    />
                    {explorer.customAccentColor && (
                      <button
                        onClick={() => explorer.setCustomAccentColor(null)}
                        className="text-[9.5px] px-1.5 py-0.5 rounded cursor-pointer"
                        style={{
                          backgroundColor: "var(--surface-bg)",
                          color: "var(--fg-1)",
                          border: "1px solid var(--stroke-1)"
                        }}
                        title={explorer.language === "vi" ? "Xóa màu tùy chỉnh" : "Reset to palette"}
                      >
                        {explorer.language === "vi" ? "Đặt lại" : "Reset"}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Clear Thumbnail Cache */}
              <div className="mt-3.5 text-xs">
                <button
                  onClick={async () => {
                    try {
                      const result = await invoke<{ success: boolean; deleted_count: number }>("clear_thumb_cache");
                      if (result.success) {
                        explorer.setStatusMessage(
                          explorer.language === "vi"
                            ? `Đã xóa ${result.deleted_count} cache thumbnails`
                            : `Cleared ${result.deleted_count} thumbnail cache files`
                        );
                      }
                    } catch (e) {
                      console.error("Failed to clear thumb cache:", e);
                    }
                  }}
                  className="px-3 py-1.5 rounded text-[11px] font-medium transition cursor-pointer"
                  style={{
                    backgroundColor: "var(--surface-bg)",
                    color: "var(--fg-1)",
                    border: "1px solid var(--stroke-1)"
                  }}
                  title={explorer.language === "vi"
                    ? "Xóa cache thumbnail: %LOCALAPPDATA%\\GokuFileExplorer\\thumb_cache"
                    : "Clear thumbnail cache: %LOCALAPPDATA%\\GokuFileExplorer\\thumb_cache"}
                >
                  {explorer.language === "vi" ? "🗑️ Xóa Thumb Cache" : "🗑️ Clear Thumb Cache"}
                </button>
              </div>

              {/* 7. EXR Cache Memory Limit
                  * 2026-07-06: hidden from the settings dropdown per
                  * user request — the cache budget now picks itself
                  * from system RAM at startup (`calculateDefaultMaxMemory`)
                  * and the user no longer needs to tune it. The state
                  * field, the helper exports, and the IPC bridge to
                  * `__globalFrameCache` are all still wired up
                  * underneath so future toggles can resurrect this
                  * UI without re-plumbing. To restore, change
                  * `false` below to `true`.
                  */}
              {false && (
              <div className="mt-4 pt-3 border-t" style={{ borderColor: "var(--stroke-1)" }}>
                <div className="flex items-center gap-2 mb-2">
                  <HardDrive className="w-2.5 h-2.5" style={{ color: explorer.accentColor }} />
                  <span className="font-medium text-xs" style={{ color: "var(--fg-1)" }}>
                    {explorer.language === "vi" ? "Bộ nhớ EXR Cache" : "EXR Cache Memory"}
                  </span>
                  <span style={{ fontSize: "12px", fontFamily: "monospace", color: explorer.accentColor, fontWeight: "bold" }}>
                    {Math.round(exrCacheSettings.maxMemoryMB / 1024)} GB
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span style={{ fontSize: "12px", color: "var(--fg-1)", flexShrink: 0 }}>1GB</span>
                  <input
                    type="range"
                    min="1024"
                    max={systemMemoryInfo.maxCacheMB}
                    step="1024"
                    value={exrCacheSettings.maxMemoryMB}
                    onChange={(e) => {
                      const newValue = parseInt(e.target.value);
                      const updated = updateExrCacheSettings({ maxMemoryMB: newValue });
                      setExrCacheSettings(updated);
                      // Apply to global cache immediately
                      if (typeof window !== 'undefined' && (window as any).__globalFrameCache) {
                        (window as any).__globalFrameCache.setMaxMemoryMB(newValue);
                      }
                    }}
                    className="flex-1 cursor-pointer h-1 rounded-lg appearance-none"
                    style={{
                      background: "#a0a0a0",
                      accentColor: explorer.accentColor,
                    }}
                  />
                  <span style={{ fontSize: "12px", color: "var(--fg-1)", flexShrink: 0 }}>{systemMemoryInfo.totalMemoryGB}GB</span>
                </div>
                <div className="flex items-center justify-between mt-1.5">
                  <span style={{ fontSize: "12px", color: "var(--fg-1)" }}>
                    {explorer.language === "vi" ? "Dùng cho cache frame EXR" : "Used for EXR frame caching"}
                  </span>
                  <button
                    onClick={() => {
                      // Reset to default (25% of system RAM from backend)
                      const defaultMB = Math.round(systemMemoryInfo.maxCacheMB * 0.25);
                      const updated = updateExrCacheSettings({ maxMemoryMB: defaultMB });
                      setExrCacheSettings(updated);
                      if (typeof window !== 'undefined' && (window as any).__globalFrameCache) {
                        (window as any).__globalFrameCache.setMaxMemoryMB(defaultMB);
                      }
                    }}
                    style={{ fontSize: "12px", padding: "2px 4px", borderRadius: "3px", cursor: "pointer", color: "var(--fg-2)" }}
                  >
                    {explorer.language === "vi" ? "Mặc định" : "Default"}
                  </button>
                </div>
              </div>
              )}

              {/* 8. GPU OCIO LUT Acceleration (Phase 4 of GPU plan)
                  * 2026-07-06: hidden from the settings dropdown per
                  * user request — the renderer now always uses the
                  * `auto` strategy (WebGL2 if available, CPU
                  * fallback otherwise). `exrCacheSettings.gpuAcceleration`
                  * is force-set to `"auto"` at every settings init
                  * (see `exrCacheSettings.ts`) so any stale value from
                  * a previous build is overwritten. To restore this
                  * UI, change `false` below to `true`.
                  */}
              {false && (
              <div className="mt-4 pt-3 border-t" style={{ borderColor: "var(--stroke-1)" }}>
                <div className="flex items-center gap-2 mb-2">
                  <Monitor className="w-2.5 h-2.5" style={{ color: explorer.accentColor }} />
                  <span className="font-medium text-xs" style={{ color: "var(--fg-1)" }}>
                    {explorer.language === "vi" ? "Tăng tốc GPU (OCIO LUT)" : "GPU Acceleration (OCIO LUT)"}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {([
                    { id: "auto", label: explorer.language === "vi" ? "Tự động" : "Auto" },
                    { id: "force-gpu", label: explorer.language === "vi" ? "Bắt buộc GPU" : "Force GPU" },
                    { id: "force-cpu", label: explorer.language === "vi" ? "Bắt buộc CPU" : "Force CPU" },
                  ] as { id: GpuAccelerationMode; label: string }[]).map((opt) => {
                    const isActive = exrCacheSettings.gpuAcceleration === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => {
                          const updated = updateExrCacheSettings({ gpuAcceleration: opt.id });
                          setExrCacheSettings(updated);
                        }}
                        className="flex-1 px-2 py-1 rounded text-[10px] font-mono transition-colors border"
                        style={{
                          backgroundColor: isActive ? `${explorer.accentColor}30` : "var(--row-bg)",
                          borderColor: isActive ? explorer.accentColor : "var(--stroke-1)",
                          color: isActive ? explorer.accentColor : "var(--fg-2)",
                          cursor: "pointer",
                        }}
                        title={
                          opt.id === "auto"
                            ? "Use GPU if WebGL2 + EXT_color_buffer_float is available, fall back to CPU"
                            : opt.id === "force-gpu"
                            ? "Require GPU renderer — fail if unavailable"
                            : "Always use legacy decode path"
                        }
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1.5" style={{ fontSize: "11px", color: "var(--fg-2)" }}>
                  {explorer.language === "vi"
                    ? "GPU render OCIO LUT trong shader — nhanh hơn 5-10x so với Python."
                    : "GPU renders OCIO LUT in shader — 5-10x faster than Python subprocess."}
                </div>
              </div>
              )}
            </div>,
            document.body
          )}

          {/* Custom Color Picker */}
          {showColorPicker && createPortal(
            <ColorPicker
              value={explorer.customAccentColor ?? explorer.accentColor}
              onChange={(color) => {
                explorer.setCustomAccentColor(color);
              }}
              onClose={() => {
                setShowColorPicker(false);
                setColorPickerAnchor(null);
              }}
              language={explorer.language}
              accentColor={explorer.accentColor}
              theme={explorer.theme}
              anchorRect={colorPickerAnchor}
              triggerRef={accentColorButtonRef}
            />,
            document.body
          )}
        </div>
      </div>

      {/* 3. Row 3: Navigation Breadcrumbs, Address Bar, and Search Bar */}
      <div className="goku-layer-2 flex flex-col md:flex-row items-center justify-between gap-3 px-4 py-2.5 shrink-0 transition-colors duration-200 text-stone-300">
        
        {/* Navigation buttons + Path breadcrumbs */}
        <div className="flex items-center gap-2 w-full md:w-auto flex-1 min-w-0">
          <div className="flex items-center gap-0.5 p-1 rounded-lg border shrink-0 border-white/5">
            <button
              onClick={navigateBack}
              disabled={!activeTab || activeTab.historyIndex <= 0}
              className="p-1.5 rounded-md disabled:opacity-20 disabled:hover:bg-transparent transition cursor-pointer text-stone-400 hover:text-white hover:bg-white/5"
              title={explorer.language === "vi" ? "Quay lại (Alt+← hoặc X1)" : "Back (Alt+Left or X1)"}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <button
              onClick={navigateForward}
              disabled={!activeTab || activeTab.historyIndex >= (activeTab?.history.length || 1) - 1}
              className="p-1.5 rounded-md disabled:opacity-20 disabled:hover:bg-transparent transition cursor-pointer text-stone-400 hover:text-white hover:bg-white/5"
              title={explorer.language === "vi" ? "Tiến lên (Alt+→ hoặc X2)" : "Forward (Alt+Right or X2)"}
            >
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={navigateUp}
              disabled={!activeTab || activeTab.currentFolderId === null}
              className="p-1.5 rounded-md disabled:opacity-20 disabled:hover:bg-transparent transition cursor-pointer text-stone-400 hover:text-white hover:bg-white/5"
              title={explorer.language === "vi" ? "Thư mục cha" : "Up to parent folder"}
            >
              <ArrowUp className="w-4 h-4" />
            </button>
          </div>

            <button
              onClick={refreshCurrentDirectory}
              className="p-2 py-1.5 rounded-lg border transition cursor-pointer shrink-0 border-white/5 text-stone-400 hover:text-white hover:bg-white/5"
              title={explorer.language === "vi" ? "Làm mới thư mục hiện tại (F5)" : "Refresh current folder (F5)"}
            >
              <RefreshCw className="w-4 h-4" />
            </button>

          {/* Breadcrumb address path bar - Image 2 Style */}
          <div
            className="goku-addressbar goku-layer-3 relative flex items-center flex-1 border rounded-lg px-3.5 h-9 overflow-hidden select-text border-white/5 text-stone-100"
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (!isEditingPath) {
                  openPathEditor();
                }
              }}
              className="mr-2 shrink-0"
              title={explorer.language === "vi" ? "Chỉnh sửa đường dẫn" : "Edit path"}
            >
              <HardDrive className="w-3.5 h-3.5" style={{ color: accentColor }} />
            </button>
            <div className="relative flex items-center flex-1 min-w-0 py-1 font-sans text-xs overflow-hidden">
              {isEditingPath ? (
                <input
                  ref={addressInputRef}
                  type="text"
                  value={typedPath}
                  onChange={(e) => {
                    setTypedPath(e.target.value);
                    setSelectedSuggestionIndex(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown" && pathSuggestions.length > 0) {
                      e.preventDefault();
                      setSelectedSuggestionIndex((prev) => Math.min(prev + 1, pathSuggestions.length - 1));
                    } else if (e.key === "ArrowUp" && pathSuggestions.length > 0) {
                      e.preventDefault();
                      setSelectedSuggestionIndex((prev) => Math.max(prev - 1, 0));
                    } else if ((e.key === "Tab" || e.key === "Enter") && selectedSuggestionIndex >= 0 && pathSuggestions[selectedSuggestionIndex]) {
                      e.preventDefault();
                      const chosenSuggestion = pathSuggestions[selectedSuggestionIndex];
                      const chosenPath = chosenSuggestion.path;
                      // If typed path is a full valid path, prefer it over suggestion.
                      // Shortcut forms (`%AppData%`, `shell:Downloads`, `::{GUID}`)
                      // also bypass the suggestion so the resolver can expand them
                      // to the real path before navigation.
                      const normalizedTypedPath = normalizeAddressPath(typedPath);
                      const isFullTypedPath = normalizedTypedPath.includes("\\") || normalizedTypedPath.includes("/");
                      const isShortcutInput =
                        typedPath.startsWith("%") ||
                        typedPath.toLowerCase().startsWith("shell:") ||
                        typedPath.startsWith("::{");
                      const useTypedPath = isShortcutInput || (isFullTypedPath && typedPath.length > 3);
                      const finalPath = useTypedPath ? normalizedTypedPath : chosenPath;
                      applySuggestion(chosenPath);
                      if (e.key === "Enter") {
                        void submitTypedPath(finalPath, chosenSuggestion.type);
                      }
                    } else if (e.key === "ArrowRight" && selectedSuggestionIndex >= 0 && pathSuggestions[selectedSuggestionIndex]) {
                      const selectedSuggestion = pathSuggestions[selectedSuggestionIndex];
                      if (!typedPath || selectedSuggestion.path.toLowerCase().startsWith(normalizeAddressPath(typedPath).toLowerCase())) {
                        e.preventDefault();
                        applySuggestion(selectedSuggestion.path);
                      }
                    } else if (e.key === "ArrowLeft" && (e.currentTarget.selectionStart ?? 0) === (e.currentTarget.selectionEnd ?? 0) && (e.currentTarget.selectionStart ?? 0) === typedPath.length && /[\\/]/.test(typedPath)) {
                      e.preventDefault();
                      const parentPath = trimPathToParentSegment(typedPath);
                      setTypedPath(parentPath);
                      setSelectedSuggestionIndex(0);
                    } else if (e.key === "Backspace" && e.ctrlKey) {
                      e.preventDefault();
                      const parentPath = trimPathToParentSegment(typedPath);
                      setTypedPath(parentPath);
                      setSelectedSuggestionIndex(0);
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      void submitTypedPath();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelPathEditing();
                    }
                  }}
                  onBlur={() => {
                    setTimeout(() => cancelPathEditing(), 180);
                  }}
                  autoFocus
                  className="w-full bg-transparent border-none text-xs outline-none font-mono text-stone-100"
                />
              ) : (
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    openPathEditor();
                  }}
                  className="flex items-center min-w-0 flex-1 text-left cursor-pointer"
                  title={activeTab?.currentPath || ""}
                >
                  <div
                    ref={crumbsContainerRef}
                    className="relative flex items-center min-w-0 flex-1"
                  >
                    <div className="flex items-center min-w-0 flex-1 overflow-hidden">
                      {renderBreadcrumbFlow()}
                    </div>

                    {/* Offscreen measurement strip — same DOM shape as the
                        visible flow but no handlers. Its scrollWidth tells us
                        how wide the fully-expanded breadcrumb would be. */}
                    {crumbs.length > 0 && (
                      <div
                        ref={crumbsMeasureRef}
                        aria-hidden="true"
                        className="invisible absolute left-0 top-0 flex items-center whitespace-nowrap pointer-events-none"
                      >
                        {crumbs.map((crumb, idx) => (
                          <React.Fragment key={`measure-${crumb.folderId || idx}`}>
                            {idx > 0 && (
                              <span className="mx-1.5 text-[9px] font-sans">&gt;</span>
                            )}
                            <span
                              className={`whitespace-nowrap py-0.5 px-2 rounded ${
                                idx === crumbs.length - 1
                                  ? "font-bold text-xs"
                                  : "text-xs"
                              }`}
                            >
                              {crumb.name}
                            </span>
                          </React.Fragment>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void copyCurrentPath();
              }}
              className="ml-2 shrink-0 p-1 rounded-md transition cursor-pointer text-stone-400 hover:text-white hover:bg-white/5"
              title={explorer.language === "vi" ? "Sao chép đường dẫn" : "Copy path"}
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Searching Row 3 Right */}
        <div className="flex items-center gap-2 w-full md:w-auto shrink-0 justify-end">
          {/* Search results count */}
          {isSearching && searchResultsCount > 0 && (
            <span className="text-xs text-stone-500 font-sans shrink-0">
              {searchResultsCount}
            </span>
          )}

          {/* Fuzzy Search */}
          <form onSubmit={handleSearchSubmit} className="relative flex items-center w-full md:w-72 shrink-0">
            <input
              type="text"
              placeholder={explorer.language === "vi" ? "Tìm file và thư mục..." : "Search files and folders..."}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="goku-layer-3 w-full border rounded-lg pl-3.5 pr-16 py-1.5 text-xs transition h-9 font-sans focus:outline-none border-white/5 text-white placeholder-stone-500"
              style={{ borderColor: undefined }}
              onFocus={(e) => { e.currentTarget.style.borderColor = `${explorer.accentColor}66`; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = ''; }}
            />
            {isSearching ? (
              <div className="absolute right-1.5 flex items-center gap-1">
                <Loader2 className="w-3.5 h-3.5 text-orange-400 animate-spin" />
                <button
                  type="button"
                  onClick={cancelSearch}
                  title={explorer.language === "vi" ? "Hủy tìm kiếm" : "Cancel search"}
                  className="w-5 h-5 flex items-center justify-center text-stone-400 hover:text-stone-200 cursor-pointer rounded"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : searchInput ? (
              <button
                type="button"
                onClick={handleSearchClear}
                className="absolute right-2 text-stone-500 hover:text-stone-300 text-xs cursor-pointer"
              >
                ✕
              </button>
            ) : (
              <Search className="absolute right-2.5 w-3.5 h-3.5 text-stone-500" />
            )}
          </form>
          <button
            type="button"
            onClick={() => setGotoPaletteOpen(true)}
            title={explorer.language === "vi" ? "Đi tới thư mục (Ctrl+K)" : "Go to folder (Ctrl+K)"}
            className="flex items-center gap-1.5 px-2.5 h-9 rounded-lg text-xs font-medium border transition shrink-0 cursor-pointer border-white/5 text-stone-300 hover:bg-white/5 hover:text-white"
          >
            <Navigation className="w-3.5 h-3.5" />
            <span>{explorer.language === "vi" ? "Đi tới" : "Go To"}</span>
          </button>
        </div>

      </div>

      {/* 4. Row 4: Command Bar actions - High z-index overflow-visible to support overlay dropdown rendering.
         The z-index must be lower than the preview's fullscreen focus modal (z-[500])
         so dropdowns from this row render below the focus modal. */}
      <div data-command-bar-row className="flex flex-col md:flex-row md:items-center justify-between gap-3 px-4 py-1.5 border-b relative z-[200] shrink-0 text-xs select-none overflow-visible transition-colors duration-200 border-white/5 text-stone-300">
        
        {/* Core items actions */}
        <div className="flex items-center gap-1.5 overflow-visible relative flex-wrap py-1.5">
          {/* NEW drop down selector */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowHiddenCrumbsMenu(false);
                setOpenCrumbDropdownPath(null);
                setActiveDropdown(activeDropdown === "new" ? null : "new");
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md transition cursor-pointer font-semibold shrink-0 hover:bg-white/5 text-stone-200"
            >
              <Plus className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{explorer.language === "vi" ? "Thêm mới" : "New"}</span>
              <ChevronDown className="w-3 h-3 text-stone-500 shrink-0" />
            </button>
            
            {activeDropdown === "new" && (
              <div
                data-active-dropdown
                className="absolute left-0 top-full mt-1.5 fluent-menu absolute rounded-xl z-[600] py-1.5 min-w-[210px] text-left animate-in fade-in duration-100"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="py-1">
                  <button
                    onClick={() => {
                      setActiveDropdown(null);
                      setNewItemModal({ open: true, mode: "folder" });
                    }}
                    className="flex items-center gap-2.5 w-full px-4 py-2 text-left text-xs cursor-pointer transition hover:bg-white/5 text-stone-200 min-w-0"
                  >
                    <FolderPlus className="w-4 h-4 text-amber-500 shrink-0" />
                    <span className="truncate">{explorer.language === "vi" ? "Thư mục mới (Folder)" : "New Folder"}</span>
                  </button>
                </div>
                <div className="py-1">
                  <button
                    onClick={() => {
                      setActiveDropdown(null);
                      setNewItemModal({ open: true, mode: "file" });
                    }}
                    className="flex items-center gap-2.5 w-full px-4 py-2 text-left text-xs cursor-pointer transition hover:bg-white/5 text-stone-200 min-w-0"
                  >
                    <FilePlus className="w-4 h-4 text-sky-500 shrink-0" />
                    <span className="truncate">{explorer.language === "vi" ? "Tài liệu văn bản (.txt)" : "Text Document (.txt)"}</span>
                  </button>

                  <button
                    onClick={() => {
                      setActiveDropdown(null);
                      setNewItemModal({ open: true, mode: "shortcut" });
                    }}
                    className="flex items-center gap-2.5 w-full px-4 py-2 text-left text-xs cursor-pointer transition hover:bg-white/5 text-stone-200 min-w-0"
                  >
                    <Link className="w-4 h-4 text-teal-500 shrink-0" />
                    <span className="truncate">{explorer.language === "vi" ? "Lối tắt (Shortcut)" : "Shortcut"}</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Separator line */}
          <div className={`w-[1px] h-4 mx-1 shrink-0`} style={{ backgroundColor: explorer.theme === "light" ? "#e5e5e5" : "rgba(255,255,255,0.1)" }} />

          {/* Action icons group */}
          <button
            onClick={explorer.cutItems}
            disabled={!hasSelection}
            className={cmdBtnClass}
            title={explorer.language === "vi" ? "Cắt mục được chọn (Cut)" : "Cut chosen assets"}
          >
            <Scissors className="w-3.5 h-3.5 text-sky-400" />
            <span className="hidden lg:inline">{explorer.language === "vi" ? "Cắt" : "Cut"}</span>
          </button>

          <button
            onClick={explorer.copyItems}
            disabled={!hasSelection}
            className={cmdBtnClass}
            title={explorer.language === "vi" ? "Sao chép mục được chọn (Copy)" : "Copy chosen assets"}
          >
            <Copy className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden lg:inline">{explorer.language === "vi" ? "Sao chép" : "Copy"}</span>
          </button>

          <button
            onClick={explorer.pasteItems}
            disabled={clipboard.itemIds.length === 0}
            className={cmdBtnClass}
            title={explorer.language === "vi" ? "Dán mục từ bộ nhớ tạm (Paste)" : "Paste from clipboard"}
          >
            <Clipboard className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden lg:inline">{explorer.language === "vi" ? "Dán" : "Paste"}</span>
          </button>

          <button
            onClick={() => {
              explorer.startRenameSelected?.();
            }}
            disabled={!isSingleSelection}
            className={cmdBtnClass}
            title={explorer.language === "vi" ? "Đổi tên mục được chọn (Rename / F2)" : "Rename chosen asset (same as F2)"}
          >
            <Edit3 className="w-3.5 h-3.5 text-sky-300" />
            <span className="hidden lg:inline">{explorer.language === "vi" ? "Đổi tên" : "Rename"}</span>
          </button>

          <button
            onClick={() => {
              if (!hasSelection) return;
              const paths = selectedItems.map(i => i.path).join("\n");
              navigator.clipboard.writeText(paths);
              const msg = selectedItems.length === 1
                ? (explorer.language === "vi" ? `Đã sao chép đường dẫn: ${selectedItems[0].path}` : `Copied path: ${selectedItems[0].path}`)
                : (explorer.language === "vi" ? `Đã sao chép ${selectedItems.length} đường dẫn.` : `Copied ${selectedItems.length} paths.`);
              explorer.setStatusMessage(msg);
            }}
            disabled={!hasSelection}
            className={cmdBtnClass}
            title={explorer.language === "vi" ? "Sao chép đường dẫn" : "Copy file path"}
          >
            <Share2 className="w-3.5 h-3.5 text-teal-400" />
            <span className="hidden lg:inline">{explorer.language === "vi" ? "Chia sẻ" : "Share"}</span>
          </button>

          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (hasSelection) {
                  setActiveDropdown(activeDropdown === "delete" ? null : "delete");
                }
              }}
              disabled={!hasSelection}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-rose-400 disabled:opacity-30 disabled:hover:bg-transparent transition cursor-pointer font-bold shrink-0 hover:bg-white/5"
              title={explorer.language === "vi" ? "Xóa mục được chọn" : "Delete selected items"}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span className="hidden lg:inline">{explorer.language === "vi" ? "Xóa" : "Delete"}</span>
              <ChevronDown className="w-3 h-3" />
            </button>

            {activeDropdown === "delete" && (
              <div 
                data-delete-dropdown
                className="absolute left-0 top-full mt-1.5 fluent-menu absolute rounded-xl z-[600] py-1.5 text-left text-xs min-w-[180px] animate-in fade-in duration-100"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  onClick={() => {
                    selectedItems.forEach(i => deleteItem(i.id, "recycle"));
                    setSelectedIds([]);
                    explorer.setStatusMessage(
                      explorer.language === "vi" 
                        ? `Đã chuyển ${selectedItems.length} mục vào Thùng rác.` 
                        : `Moved ${selectedItems.length} item(s) to Recycle Bin.`
                    );
                    setActiveDropdown(null);
                  }}
                  className="flex items-center gap-2 w-full px-4 py-2.5 cursor-pointer text-left transition hover:bg-white/5 text-stone-300"
                >
                  <Trash2 className="w-3.5 h-3.5 text-amber-400" />
                  <span>{explorer.language === "vi" ? "Chuyển vào Thùng rác" : "Move to Recycle Bin"}</span>
                </button>
                <button
                  onClick={() => {
                    selectedItems.forEach(i => deleteItem(i.id, "permanent"));
                    setSelectedIds([]);
                    explorer.setStatusMessage(
                      explorer.language === "vi" 
                        ? `Đã xóa vĩnh viễn ${selectedItems.length} mục.` 
                        : `Permanently deleted ${selectedItems.length} item(s).`
                    );
                    setActiveDropdown(null);
                  }}
                  className="flex items-center gap-2 w-full px-4 py-2.5 cursor-pointer text-left transition hover:bg-white/5 text-rose-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{explorer.language === "vi" ? "Xóa vĩnh viễn" : "Delete Permanently"}</span>
                </button>
              </div>
            )}
          </div>

          {/* Separator line */}
          <div className={`w-[1px] h-4 mx-1 shrink-0`} style={{ backgroundColor: explorer.theme === "light" ? "#e5e5e5" : "rgba(255,255,255,0.1)" }} />

          {/* SORT SELECTION */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsEditingPath(false);
                setShowHiddenCrumbsMenu(false);
                setOpenCrumbDropdownPath(null);
                setActiveDropdown(activeDropdown === "sort" ? null : "sort");
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md transition cursor-pointer font-medium shrink-0 hover:bg-white/5 text-stone-200 hover:text-white"
            >
              <ArrowUpDown className="w-3.5 h-3.5 text-stone-400" />
              <span>{explorer.language === "vi" ? "Sắp xếp" : "Sort"}</span>
              <ChevronDown className="w-3 h-3 text-stone-500" />
            </button>

            {activeDropdown === "sort" && (
              <div
                data-active-dropdown
                className="absolute left-0 top-full mt-1.5 fluent-menu absolute rounded-xl z-[600] py-1.5 text-left text-xs min-w-[195px] animate-in fade-in duration-100"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="py-1">
                  <button
                    onClick={() => {
                      explorer.setSortBy("name");
                      setActiveDropdown(null);
                    }}
                    className="flex items-center justify-between w-full px-4 py-2 cursor-pointer text-left transition hover:bg-white/5 text-stone-300"
                  >
                    <span>{explorer.language === "vi" ? "Sắp xếp theo Tên" : "Sort by Name"}</span>
                    {explorer.sortBy === "name" && <Check className="w-3.5 h-3.5 text-indigo-400" />}
                  </button>
                  <button
                    onClick={() => {
                      explorer.setSortBy("size");
                      setActiveDropdown(null);
                    }}
                    className="flex items-center justify-between w-full px-4 py-2 cursor-pointer text-left transition hover:bg-white/5 text-stone-300"
                  >
                    <span>{explorer.language === "vi" ? "Dung lượng dữ liệu" : "Data Size"}</span>
                    {explorer.sortBy === "size" && <Check className="w-3.5 h-3.5 text-indigo-400" />}
                  </button>
                  <button
                    onClick={() => {
                      explorer.setSortBy("type");
                      setActiveDropdown(null);
                    }}
                    className="flex items-center justify-between w-full px-4 py-2 cursor-pointer text-left transition hover:bg-white/5 text-stone-300"
                  >
                    <span>{explorer.language === "vi" ? "Định dạng tệp tin" : "File Type"}</span>
                    {explorer.sortBy === "type" && <Check className="w-3.5 h-3.5 text-indigo-400" />}
                  </button>
                  <button
                    onClick={() => {
                      explorer.setSortBy("date");
                      setActiveDropdown(null);
                    }}
                    className="flex items-center justify-between w-full px-4 py-2 cursor-pointer text-left transition hover:bg-white/5 text-stone-300"
                  >
                    <span>{explorer.language === "vi" ? "Mốc sửa đổi" : "Modified Date"}</span>
                    {explorer.sortBy === "date" && <Check className="w-3.5 h-3.5 text-indigo-400" />}
                  </button>
                </div>

                <div className="mx-2 border-t border-white/10" />

                <div className="py-1">
                  <button
                    onClick={() => {
                      explorer.setSortDirection("asc");
                      setActiveDropdown(null);
                    }}
                    className="flex items-center justify-between w-full px-4 py-2 cursor-pointer text-left transition hover:bg-white/5 text-stone-300"
                  >
                    <span>{explorer.language === "vi" ? "Tăng dần (A - Z)" : "Ascending (A - Z)"}</span>
                    {explorer.sortDirection === "asc" && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                  </button>
                  <button
                    onClick={() => {
                      explorer.setSortDirection("desc");
                      setActiveDropdown(null);
                    }}
                    className="flex items-center justify-between w-full px-4 py-2 cursor-pointer text-left transition hover:bg-white/5 text-stone-300"
                  >
                    <span>{explorer.language === "vi" ? "Giảm dần (Z - A)" : "Descending (Z - A)"}</span>
                    {explorer.sortDirection === "desc" && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* VIEW SELECTION — preset dropdown with integrated slider */}
          <div className="relative">
            <button
               onClick={(e) => {
                 e.stopPropagation();
                 setIsEditingPath(false);
                 setShowHiddenCrumbsMenu(false);
                 setOpenCrumbDropdownPath(null);
                 setActiveDropdown(activeDropdown === "view" ? null : "view");
               }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md transition cursor-pointer font-medium shrink-0 hover:bg-white/5 text-stone-200 hover:text-white"
            >
              <LayoutGrid className="w-3.5 h-3.5 text-stone-400" />
              <span>{explorer.language === "vi" ? "Xem dạng" : "View Mode"}</span>
              <ChevronDown className="w-3 h-3 text-stone-500" />
            </button>

            {activeDropdown === "view" && (
              <div
                data-active-dropdown
                className="absolute left-0 top-full mt-1.5 fluent-menu absolute rounded-xl z-[600] text-left text-xs animate-in fade-in duration-100 flex flex-col"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Top row: view-mode list + slider (aligned to 7 items) */}
                <div className="flex items-stretch">
                  {/* Left: 7 view mode items */}
                  <div className="py-1 min-w-[220px]">
                    {VIEW_MODE_LABELS.map(({ value, vi, en, group }) => (
                      <button
                        key={value}
                        onClick={() => {
                          setViewMode(value);
                          setActiveDropdown(null);
                        }}
                        className="flex items-center justify-between w-full px-4 py-2 cursor-pointer transition hover:bg-white/5 text-stone-300"
                      >
                        <div className="flex items-center gap-2">
                          {group === "list" ? (
                            <LayoutList className="w-3.5 h-3.5 text-sky-400" />
                          ) : (
                            <LayoutGrid className="w-3.5 h-3.5 text-orange-400" />
                          )}
                          <span>{explorer.language === "vi" ? vi : en}</span>
                        </div>
                        {viewMode === value && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                      </button>
                    ))}
                  </div>

                  {/* Vertical divider */}
                  <div className="w-px shrink-0" style={{ backgroundColor: "rgba(255,255,255,0.08)" }} />

                  {/* Right: vertical slider — minimal: just thumb + thin track, smooth drag */}
                  <div
                    className="flex items-center justify-center px-2 select-none shrink-0"
                    style={{ height: "182px" }}
                    title={
                      explorer.language === "vi"
                        ? "Kéo thanh trượt để đổi chế độ xem (1=Extra Large → 7=Details)"
                        : "Drag the slider to change view mode (1=Extra Large → 7=Details)"
                    }
                  >
                    <input
                      type="range"
                      min={VIEW_MODE_MIN}
                      max={VIEW_MODE_MAX}
                      step="1"
                      value={localSliderValue ?? viewMode}
                      onMouseDown={() => {
                        sliderDraggingRef.current = true;
                        setLocalSliderValue(viewMode);
                      }}
                      onInput={(e) => {
                        const val = parseFloat(e.currentTarget.value);
                        setLocalSliderValue(val);
                        setViewMode(val);
                      }}
                      onMouseUp={(e) => {
                        sliderDraggingRef.current = false;
                        const raw = parseFloat(e.currentTarget.value);
                        setLocalSliderValue(null);
                        setViewMode(raw);
                      }}
                      onMouseLeave={(e) => {
                        if (sliderDraggingRef.current) {
                          sliderDraggingRef.current = false;
                          const raw = parseFloat(e.currentTarget.value);
                          setLocalSliderValue(null);
                          setViewMode(raw);
                        }
                      }}
                      onTouchStart={() => {
                        sliderDraggingRef.current = true;
                        setLocalSliderValue(viewMode);
                      }}
                      onTouchEnd={(e) => {
                        sliderDraggingRef.current = false;
                        const raw = parseFloat(e.currentTarget.value);
                        setLocalSliderValue(null);
                        setViewMode(raw);
                      }}
                      className="view-slider-v-minimal cursor-pointer"
                      style={{ accentColor: explorer.accentColor }}
                      aria-label="View mode slider"
                    />
                  </div>
                </div>

                {/* Divider + 2 toggles below slider */}
                <div className="border-t mx-2 my-1" style={{ borderColor: "rgba(255,255,255,0.08)" }} />

                <button
                  onClick={() => explorer.setShowHiddenItems(!showHiddenItems)}
                  className="flex items-center justify-between w-full px-4 py-2 cursor-pointer transition hover:bg-white/5 text-stone-300"
                >
                  <span>{explorer.language === "vi" ? "Hiện tệp ẩn" : "Show hidden items"}</span>
                  {showHiddenItems && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                </button>

                <button
                  onClick={() => explorer.setHideFileExtensions(!hideFileExtensions)}
                  className="flex items-center justify-between w-full px-4 py-2 cursor-pointer transition hover:bg-white/5 text-stone-300"
                >
                  <span>{explorer.language === "vi" ? "Ẩn phần mở rộng tệp" : "Hide file extensions"}</span>
                  {hideFileExtensions && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                </button>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* 5. Row 5: Media Filters & Space Analyzer - Clean Horizontal Flex (moved to layout row 3 equivalent) */}
      <div className="flex flex-col md:flex-row items-center justify-between gap-3 px-4 py-2 border-b shrink-0 select-none relative z-20 transition-colors duration-200 text-stone-300"
        style={{
          borderBottomColor: explorer.theme === "light" ? "#e5e5e5" : "rgba(255,255,255,0.05)",
        }}
      >
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none font-sans py-1.5 shrink-0">
        </div>

        {/* Quick filter pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none font-sans py-1.5 flex-1 min-w-0">
          {filterPills.map((pill) => {
            const isSelected = searchFilter.typeFilter === pill.type;
            const colorHex = pill.color;
            const label = explorer.language === "vi" ? pill.label : (
              pill.type === null ? "All files" :
              pill.type === "3d" ? "3D Models" :
              pill.type === "image" ? "Images" :
              pill.type === "video" ? "Videos" :
              pill.type === "audio" ? "Audio" : "Scripts"
            );
            return (
              <button
                key={pill.type || "all"}
                onClick={() => {
                  setSearchFilter({ ...searchFilter, typeFilter: pill.type });
                  explorer.setStatusMessage(
                    explorer.language === "vi" 
                      ? (pill.type ? `Đang lọc theo định dạng: ${label}` : "Hiển thị tất cả định dạng tài nguyên.")
                      : (pill.type ? `Filtering by format: ${label}` : "Showing all resource files.")
                  );
                }}
                className="px-3.5 py-1 rounded-[6px] border text-[11px] font-sans font-medium cursor-pointer transition-all duration-200 select-none flex items-center justify-center hover:opacity-90 active:scale-95"
                style={{
                  backgroundColor: isSelected ? `${colorHex}25` : `${colorHex}06`,
                  color: isSelected ? colorHex : (explorer.theme === "light" ? "#000000" : "#8e9196"),
                  borderColor: isSelected ? `${colorHex}70` : (explorer.theme === "light" ? "#e5e5e5" : "rgba(255,255,255,0.05)"),
                }}
              >
                <span>{label}</span>
              </button>
            );
          })}
        </div>

        {/* Legacy container removed language switcher, kept Space Analyzer */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Relocated Space Analyzer Button */}
          <button
            onClick={() => explorer.setShowSpaceAnalyzer(!explorer.showSpaceAnalyzer)}
            className="flex items-center gap-1.5 px-3 h-8 rounded-lg border text-[11px] font-semibold cursor-pointer transition shrink-0"
            style={
              explorer.showSpaceAnalyzer
                ? { backgroundColor: `${explorer.accentColor}99`, borderColor: `${explorer.accentColor}`, color: explorer.theme === "light" ? "#000" : "#fff" }
                : { backgroundColor: `${explorer.accentColor}0d`, borderColor: `${explorer.accentColor}33`, color: `${explorer.accentColor}99` }
            }
            title={explorer.language === "vi" ? "Đồ thị cơ cấu tài nguyên" : "Storage space composition graph"}
          >
            <Sparkles className="w-3 h-3 animate-pulse" style={explorer.showSpaceAnalyzer ? { color: explorer.theme === "light" ? "#000" : "#fff" } : { color: `${explorer.accentColor}99` }} />
            <span>{explorer.language === "vi" ? "Hệ thống bộ nhớ" : "Space Analyzer"}</span>
          </button>

          {/* Details Pane Toggle Button */}
          <button
            onClick={() => {
              // Hide the toggle entirely on virtual shell locations
              // (This PC, Network). The pane would be hidden by App.tsx
              // anyway, but we also don't want users seeing a stuck "on"
              // state when navigating in and out.
              if (activeTab?.currentPath === "thispc://" || activeTab?.currentPath === "network://") return;
              explorer.setShowDetailsPane(!explorer.showDetailsPane);
            }}
            disabled={activeTab?.currentPath === "thispc://" || activeTab?.currentPath === "network://"}
            className={`flex items-center gap-1.5 px-3 h-8 rounded-lg border text-[11px] font-semibold transition shrink-0 ${
              activeTab?.currentPath === "thispc://" || activeTab?.currentPath === "network://"
                ? "opacity-40 cursor-not-allowed border-white/10 text-stone-500"
                : "cursor-pointer"
            }`}
            style={
              activeTab?.currentPath === "thispc://" || activeTab?.currentPath === "network://"
                ? undefined
                : explorer.showDetailsPane
                ? { backgroundColor: `${explorer.accentColor}99`, borderColor: `${explorer.accentColor}`, color: explorer.theme === "light" ? "#000" : "#fff" }
                : { backgroundColor: `${explorer.accentColor}0d`, borderColor: `${explorer.accentColor}33`, color: `${explorer.accentColor}99` }
            }
            title={explorer.language === "vi" ? "Hiện/ẩn Thuộc tính (phím Ctrl+Space)" : "Toggle Properties Pane (Ctrl+Space)"}
          >
            <Monitor className="w-3 h-3" style={explorer.showDetailsPane && !(activeTab?.currentPath === "thispc://" || activeTab?.currentPath === "network://") ? { color: explorer.theme === "light" ? "#000" : "#fff" } : { color: `${explorer.accentColor}99` }} />
            <span>{explorer.language === "vi" ? "Thuộc tính" : "Details"}</span>
          </button>
        </div>
      </div>

      <NewItemModal
        isOpen={newItemModal.open}
        onClose={() => setNewItemModal({ open: false, mode: "folder" })}
        mode={newItemModal.mode}
        language={explorer.language}
        currentPath={activeTab?.currentPath}
        onCreate={(name) => {
          if (newItemModal.mode === "folder") {
            createFolder(name);
          } else if (newItemModal.mode === "file") {
            createFile(name, "");
          } else {
            createFile(name, `[Shortcut]\nTarget=${activeTab?.currentPath || ""}\nIconIndex=0`);
          }
        }}
      />

      {/* Tabs dropdown menu - rendered at the end to ensure highest stacking order */}
      {activeDropdown === "tabs" && tabsDropdownPosition && (
        <div 
          data-active-dropdown
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed min-w-[200px] max-h-[300px] overflow-y-auto fluent-menu rounded-xl py-1.5 text-left animate-in fade-in duration-100"
          style={{ 
            top: tabsDropdownPosition.top,
            left: tabsDropdownPosition.left,
            zIndex: "2147483647",
          }}
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => {
                  setActiveTabId(tab.id);
                  setShowSpaceAnalyzer(false);
                  setActiveDropdown(null);
                }}
                className={`flex items-center gap-2 px-3 py-2 text-xs cursor-pointer hover:bg-white/10 w-full min-w-0 ${isActive ? 'bg-white/5 text-stone-100' : 'text-stone-300'}`}
              >
                {tab.currentFolderId?.startsWith("thispc://") ? (
                  <svg viewBox="0 0 20 20" className="w-4 h-4 shrink-0 text-sky-400" fill="currentColor">
                    <path d="M2 4a2 2 0 012-2h3a2 2 0 012 2v1h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V4zm2 0v12h12V6H6V4zm2 2h2v2H8V6zm0 4h2v2H8v-2zm4-2h2v2h-2V8zm0 4h2v2h-2v-2z" />
                  </svg>
                ) : tab.currentFolderId?.startsWith("recyclebin://") ? (
                  <svg viewBox="0 0 20 20" className="w-4 h-4 shrink-0 text-stone-400" fill="currentColor">
                    <path fillRule="evenodd" d="M8 3a1 1 0 00-1 1v1H4a1 1 0 000 2h1v9a2 2 0 002 2h6a2 2 0 002-2V7h1a1 1 0 100-2h-3V4a1 1 0 00-1-1H8zm2 0h2v1H10V3z" />
                  </svg>
                ) : (
                  <WindowsFolder
                    path={tab.currentPath}
                    size={16}
                    className="shrink-0"
                  />
                )}
                <span className="truncate flex-1">{tab.title}</span>
                {isActive && <Check className="w-3 h-3 shrink-0" />}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  className="p-0.5 rounded hover:bg-white/10 text-stone-400 hover:text-stone-200 shrink-0"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
