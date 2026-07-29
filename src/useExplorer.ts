import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { FSItem, ExplorerTab, ViewMode, SortBy, SortDirection, ClipboardState, TabSearchState, SpaceStats, NavigationDestination, DEFAULT_PANE_SESSION, PaneSession, RecycleBinEntry } from "./types";
import { getRelativeSearchPath } from "./utils/searchRanker";
import { getFolderViewMode, setFolderViewMode, subscribeViewModeChange } from "./utils/viewModeStore";
import {
  FileOperationRecord,
  DragDropMode,
  OpenWithApp,
  OpenWithAssociation,
  OpenWithCandidateResponse,
  FileEntry,
} from "./TauriFileSystem";
import { listen } from "@tauri-apps/api/event";
import {
  readDirectory,
  readDirectoryRecursive,
  readTextFile,
  writeTextFile,
  deleteItem as tauriDeleteItem,
  createDirectory,
  renameItem as tauriRenameItem,
  copyItem,
  compressToZip,
  extractZip,
  getDiskSpace,
  searchFiles,
  getDrives,
  getDriveInfos,
  setVolumeLabel,
  openInTerminal,
  getSystemAccentColor,
  getHomeDir,
  getSpecialFolders,
  joinPath,
  getParentPath,
  formatFileSize,
  fileEntryToFSItem,
  FSItemTag,
  getTags,
  saveTags,
  type DirListing,
  openPathWithDefaultApp,
  openPathWithApplication,
  showOpenWithDialog,
  getOpenWithAssociation,
  getOpenWithCandidates,
  setOpenWithAssociation,
  clearOpenWithAssociation,
  openPathWithHandler,
  DiskSpace,
  DriveInfo,
  listRecycleBinEntries,
} from "./TauriFileSystem";
import { useWindowsQuickAccess, WindowsQuickAccessItem } from "./hooks/useWindowsQuickAccess";

const formatDisplayName = (item: FSItem, hideFileExtensions: boolean): string => {
  if (!hideFileExtensions || item.type !== "file") return item.name;
  const dotIndex = item.name.lastIndexOf(".");
  if (dotIndex <= 0) return item.name;
  return item.name.slice(0, dotIndex);
};

const EDITABLE_TEXT_EXTENSIONS = /^(json|txt|md|html|css|js|ts|tsx|sh|csv|log|xml|yaml|yml|env|py|rs|go|java|c|cpp|h|hpp|php|rb|swift|kt)$/i;

// Normalize a recycle bin path key to forward-slash form. The native
// IShellItem GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING) returns backslash
// paths while PowerShell's $item.Path returned forward slashes; we need
// to match both styles so the index lookup succeeds regardless of which
// listing the tab cache came from.
const normalizeRecycleBinKey = (p: string): string => p.replace(/\\/g, "/").toLowerCase();

const getPathExtension = (path: string): string | null => {
  const fileName = path.split(/[\\/]/).pop() || path;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return null;
  return fileName.slice(dot).toLowerCase();
};

const OPEN_WITH_RECENTS_KEY = "NEXUS_OPEN_WITH_RECENTS";
const OPEN_WITH_RECENTS_LIMIT = 8;

const normalizeOpenWithRecents = (value: unknown): OpenWithApp[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is OpenWithApp => Boolean(entry) && typeof entry === "object" && typeof (entry as OpenWithApp).name === "string" && typeof (entry as OpenWithApp).path === "string")
    .map((entry) => ({
      name: entry.name.trim(),
      path: entry.path.trim(),
      handler_id: entry.handler_id ?? null,
      icon_path: entry.icon_path?.trim() || null,
      launch_path: entry.launch_path?.trim() || null,
      icon_index: entry.icon_index ?? null,
      source: entry.source,
    }))
    .filter((entry) => entry.name.length > 0 && entry.path.length > 0)
    .filter((entry, index, arr) => arr.findIndex((candidate) => candidate.path.toLowerCase() === entry.path.toLowerCase()) === index)
    .slice(0, OPEN_WITH_RECENTS_LIMIT);
};

const loadOpenWithRecents = (): OpenWithApp[] => {
  try {
    const raw = localStorage.getItem(OPEN_WITH_RECENTS_KEY);
    if (!raw) return [];
    return normalizeOpenWithRecents(JSON.parse(raw));
  } catch {
    return [];
  }
};

const persistOpenWithRecents = (apps: OpenWithApp[]) => {
  localStorage.setItem(OPEN_WITH_RECENTS_KEY, JSON.stringify(apps));
};

export function useExplorer() {
  // ── Navigation State ───────────────────────────────────────────────────────
  const [tabs, setTabs] = useState<ExplorerTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");
  const [drives, setDrives] = useState<string[]>([]);
  const [diskSpaces, setDiskSpaces] = useState<Record<string, DiskSpace>>({});
  const [driveInfos, setDriveInfos] = useState<DriveInfo[]>([]);

  // ── File & Folder State ─────────────────────────────────────────────────────
  const [currentFolderEntries, setCurrentFolderEntries] = useState<FSItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigationRef = useRef<number>(0);
  const isInitializedRef = useRef(false);
  const lastLoadedTabIdRef = useRef<string | null>(null);

  // ── Watched transfer jobs ─────────────────────────────────────────────────
  // When the user pastes (or drag-drops) into a tab, we record the
  // active tab + target dir so the App-level watcher can refresh the
  // tab once the job reaches a terminal state.
  const watchedJobIdsRef = useRef<Set<string>>(new Set());
  const watchedJobTargetRef = useRef<Map<string, string>>(new Map());
  const watchedJobTabIdRef = useRef<Map<string, string>>(new Map());
  const searchRequestIdRef = useRef(0);

  // Bumps the search request id — orphans any in-flight Rust scan so its
  // late-arriving batches are ignored. Doesn't touch any tab's searchState.
  // Declared up here so navigation callbacks below can call it.
  const cancelInFlightSearch = useCallback(() => {
    searchRequestIdRef.current += 1;
  }, []);

  // ── Selection & Clipboard ───────────────────────────────────────────────────
  const [clipboard, setClipboard] = useState<ClipboardState>({ itemIds: [], action: null });
  // Map of recycle bin parsing name -> structured entry. Populated every
  // time we load the Recycle Bin listing and used to build the
  // RecycleBinEntry list we hand to the Rust restore command on paste.
  const recycleBinIndexRef = useRef<Map<string, RecycleBinEntry>>(new Map());
  const [undoStack, setUndoStack] = useState<FileOperationRecord[]>([]);
  const [redoStack, setRedoStack] = useState<FileOperationRecord[]>([]);

  // ── View & UI Settings ───────────────────────────────────────────────────
  // Default view mode is "List view" (value 6). On first install (no
  // NEXUS_VIEW_MODE in localStorage) the user lands directly in List mode.
  // If they ever switch away, their choice persists across restarts.
  const [viewMode, setViewMode] = useState<ViewMode>(6);
  const [sortBy, setSortBy] = useState<SortBy>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [showHiddenItems, setShowHiddenItems] = useState<boolean>(false);
  const [hideFileExtensions, _setHideFileExtensions] = useState<boolean>(false);
  const [showDeleteConfirmation, _setShowDeleteConfirmation] = useState<boolean>(() => {
    const stored = localStorage.getItem("NEXUS_SHOW_DELETE_CONFIRMATION");
    return stored === "true"; // Default: false
  });
  const [accentColor, setAccentColor] = useState<string>("#359AF8");
  const [customAccentColor, setCustomAccentColorState] = useState<string | null>("#29a2ff");
  const [theme, _setTheme] = useState<"dark" | "light" | "mono">("dark");
  const [font, _setFont] = useState<"monospace" | "segoeui">("segoeui");
  const [fontSize, _setFontSize] = useState<number>(100);
  const [menuBlurOpacity, _setMenuBlurOpacity] = useState<number>(100);
  const [menuBgOpacity, _setMenuBgOpacity] = useState<number>(100);
  const [spacing, _setSpacing] = useState<number>(() => {
    const saved = localStorage.getItem("NEXUS_SPACING");
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (parsed >= 30 && parsed <= 70) return parsed;
    }
    return 40; // Default is 40
  });
  const [language, _setLanguage] = useState<"vi" | "en">("en");
  const [showFolderSizes, _setShowFolderSizes] = useState<boolean>(() => {
    const stored = localStorage.getItem("NEXUS_SHOW_FOLDER_SIZES");
    return stored === "true"; // Default: false
  });

  // ── Priority Tag Settings ─────────────────────────────────────────────────
  // Default tags with their names (en/vi) and colors
  const DEFAULT_TAGS = [
    { id: "Warning", nameEn: "Warning", nameVi: "Toang", color: "#ef4444" },
    { id: "WIP", nameEn: "WIP", nameVi: "WIP", color: "#3b82f6" },
    { id: "Deliverable", nameEn: "Deliverable", nameVi: "Đã bàn giao", color: "#10b981" },
    { id: "Archived", nameEn: "Archived", nameVi: "Đóng hòm", color: "#f59e0b" },
    { id: "Draft", nameEn: "Draft", nameVi: "Mới nhú", color: "#a855f7" },
  ];

  const [tagSettings, _setTagSettings] = useState<Array<{ id: string; nameEn: string; nameVi: string; color: string }>>(() => {
    const saved = localStorage.getItem("NEXUS_TAG_SETTINGS");
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (_) {}
    }
    return DEFAULT_TAGS;
  });

  const setTagSettings = useCallback((updater: Array<{ id: string; nameEn: string; nameVi: string; color: string }>) => {
    _setTagSettings(updater);
    localStorage.setItem("NEXUS_TAG_SETTINGS", JSON.stringify(updater));
  }, []);

  // ── Windows Quick Access ──────────────────────────────────────────────────
  const {
    items: windowsQuickAccessItems,
    loading: windowsQuickAccessLoading,
    lastSync: windowsQuickAccessLastSync,
    refresh: refreshWindowsQuickAccess,
    pinToQuickAccess,
    unpinFromQuickAccess,
    isInQuickAccess,
    pinToStartMenu,
    unpinFromStartMenu,
  } = useWindowsQuickAccess(30);

  // ── Panel & Window State ───────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [gotoPaletteOpen, setGotoPaletteOpen] = useState<boolean>(false);
  // Note: [searchFilter] global state was removed — search state is now per-tab.
  // See activeSearchState below (derived from activeTab.searchState).
  const [recursiveSearchItems, setRecursiveSearchItems] = useState<FSItem[]>([]);
  const [recursiveSearchRoot, setRecursiveSearchRoot] = useState<string | null>(null);
  const [recursiveSearchDepth, setRecursiveSearchDepth] = useState<number | null>(null);

  // ── File Editor State ───────────────────────────────────────────────────────
  const [openFileId, setOpenFileId] = useState<string | null>(null);
  const [openFileContent, setOpenFileContent] = useState<string>("");
  const [openWithState, setOpenWithState] = useState<{
    visible: boolean;
    targetPath: string | null;
    selectedApp: OpenWithApp | null;
    association: OpenWithAssociation | null;
    alwaysUse: boolean;
    loading: boolean;
    mode: "picker" | "browse";
    recentApps: OpenWithApp[];
    candidates: OpenWithCandidateResponse | null;
  }>({
    visible: false,
    targetPath: null,
    selectedApp: null,
    association: null,
    alwaysUse: false,
    loading: false,
    mode: "picker",
    recentApps: [],
    candidates: null,
  });

  // ── Pinned & Recent ───────────────────────────────────────────────────────
  const [pinnedFolderIds, setPinnedFolderIds] = useState<string[]>([]);
  const [recentFileIds, setRecentFileIds] = useState<string[]>([]);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);

  // ── Quick Access (Special Folders) ───────────────────────────────────────
  const [specialFolders, setSpecialFolders] = useState<Record<string, string>>({});

  // ── New Item Modal State ───────────────────────────────────────────────────
  const [newItemModal, setNewItemModal] = useState<{ open: boolean; mode: "folder" | "file" | "shortcut" }>({ open: false, mode: "folder" });

  // ── Load drives and initialize on startup ─────────────────────────────────────
  useEffect(() => {
    async function init() {
      try {
        const [driveList, home] = await Promise.all([getDrives(), getHomeDir()]);
        setDrives(driveList);

        // Load rich drive metadata (label, drive-type icon, filesystem) for the
        // sidebar. This is best-effort — fall back to the basic drive list if
        // it fails (e.g. on non-Windows targets during dev).
        try {
          const infos = await getDriveInfos();
          setDriveInfos(infos);
          for (const info of infos) {
            if (info.total > 0 || info.free > 0) {
              setDiskSpaces(prev => prev[info.path]
                ? prev
                : { ...prev, [info.path]: { total: info.total, used: info.used, free: info.free, path: info.path } });
            }
          }
        } catch (_) {}

        // Load special folders for Quick Access
        try {
          const folders = await getSpecialFolders();
          setSpecialFolders(folders);
        } catch (_) {}

        // Load disk space for each drive (kept as a fallback / refresh path).
        for (const drive of driveList) {
          try {
            const space = await getDiskSpace(drive);
            setDiskSpaces(prev => ({ ...prev, [drive]: space }));
          } catch (_) {}
        }

        // Load persisted preferences
        const savedColor = localStorage.getItem("NEXUS_ACCENT_COLOR");
        if (savedColor) {
          setAccentColor(savedColor);
        }
        // Default accent #359AF8 is set in useState above for first-time users

        const savedCustomAccent = localStorage.getItem("NEXUS_CUSTOM_ACCENT");
        if (savedCustomAccent) setCustomAccentColorState(savedCustomAccent);

        const savedTheme = localStorage.getItem("NEXUS_THEME");
        // Only "dark", "light", and "mono" are supported.
        if (savedTheme === "dark" || savedTheme === "light" || savedTheme === "mono") {
          _setTheme(savedTheme as any);
        }

        const savedFont = localStorage.getItem("NEXUS_FONT");
        if (savedFont === "monospace" || savedFont === "segoeui") _setFont(savedFont);

        const savedFontSize = localStorage.getItem("NEXUS_FONT_SIZE");
        if (savedFontSize) {
          const parsed = parseInt(savedFontSize);
          if (parsed >= 100 && parsed <= 150) _setFontSize(parsed);
        }

        const savedMenuBlurOpacity = localStorage.getItem("NEXUS_MENU_BLUR_OPACITY");
        if (savedMenuBlurOpacity) {
          const parsed = parseInt(savedMenuBlurOpacity);
          if (parsed >= 0 && parsed <= 100) _setMenuBlurOpacity(parsed);
        }

        const savedMenuBgOpacity = localStorage.getItem("NEXUS_MENU_BG_OPACITY");
        if (savedMenuBgOpacity) {
          const parsed = parseInt(savedMenuBgOpacity);
          if (parsed >= 0 && parsed <= 100) _setMenuBgOpacity(parsed);
        }

        const savedView = localStorage.getItem("NEXUS_VIEW_MODE");
        if (savedView) {
          const parsed = parseInt(savedView);
          if (!isNaN(parsed) && parsed >= 1 && parsed <= 7) setViewMode(parsed);
        }

        const savedLang = localStorage.getItem("NEXUS_LANGUAGE");
        if (savedLang) _setLanguage(savedLang as "vi" | "en");

        const savedShowHidden = localStorage.getItem("NEXUS_SHOW_HIDDEN_ITEMS");
        if (savedShowHidden) setShowHiddenItems(savedShowHidden === "true");

        const savedHideExtensions = localStorage.getItem("NEXUS_HIDE_FILE_EXTENSIONS");
        if (savedHideExtensions) _setHideFileExtensions(savedHideExtensions === "true");

        const savedPinned = localStorage.getItem("NEXUS_PINNED_FOLDERS");
        if (savedPinned) {
          try { setPinnedFolderIds(JSON.parse(savedPinned)); } catch (_) {}
        }

        const savedRecentPaths = localStorage.getItem("NEXUS_RECENT_PATHS");
        if (savedRecentPaths) {
          try { setRecentPaths(JSON.parse(savedRecentPaths)); } catch (_) {}
        }

        setOpenWithState((prev) => ({
          ...prev,
          recentApps: loadOpenWithRecents(),
        }));

        // Open initial tab at home directory
        const initialTab: ExplorerTab = {
          id: "tab-default",
          title: driveList.length > 0 ? driveList[0] : home,
          currentPath: driveList.length > 0 ? driveList[0] : home,
          currentFolderId: driveList.length > 0 ? driveList[0] : home,
          history: [{ folderId: driveList.length > 0 ? driveList[0] : home, path: driveList.length > 0 ? driveList[0] : home }],
          historyIndex: 0,
          selectedIds: [],
          scrollPosition: 0,
          folderContents: [],
          showSpaceAnalyzer: false,
          searchState: {
            query: "",
            tag: null,
            typeFilter: null,
            mode: "default",
            results: [],
            resultsRoot: null,
            isSearching: false,
            resultsCount: 0,
          },
          paneSession: { ...DEFAULT_PANE_SESSION },
        };
        setTabs([initialTab]);
        setActiveTabId("tab-default");

        // Backfill paneSession for any tab that lacks it (e.g. stale state).
        setTabs(prev =>
          prev.map(t => ({
            ...t,
            paneSession: t.paneSession ?? { ...DEFAULT_PANE_SESSION },
          }))
        );

        // Load initial directory
        const initPath = driveList.length > 0 ? driveList[0] : home;
        await loadDirectory(initPath);

      } catch (err) {
        console.error("Init error:", err);
        setError(String(err));
      }
    }
    init();
  }, []);

  // ── Refresh drive list + disk space on demand (e.g. when GotoPalette opens) ──
  const refreshDrives = useCallback(async () => {
    try {
      const driveList = await getDrives();
      setDrives(driveList);
      const updated: Record<string, DiskSpace> = {};
      for (const drive of driveList) {
        try {
          updated[drive] = await getDiskSpace(drive);
        } catch (_) {}
      }
      if (Object.keys(updated).length > 0) setDiskSpaces(prev => ({ ...prev, ...updated }));
      try {
        const infos = await getDriveInfos();
        setDriveInfos(infos);
      } catch (_) {}
    } catch (_) {}
  }, []);

  // ── Load a directory's entries via Tauri IPC ────────────────────────────────
  const loadDirectory = useCallback(async (path: string, tabId?: string) => {
    const targetTabId = tabId || activeTabId;
    const navId = navigationRef.current + 1;
    navigationRef.current = navId;

    setIsLoading(true);
    setError(null);
    try {
      let listing: DirListing;
      if (path.startsWith("recyclebin://")) {
        // Use the native structured listing so we can capture
        // (parsing_name -> RecycleBinEntry) for later restore calls.
        const entries = await listRecycleBinEntries();
        // Debug: log entries with missing original_parent
        const missingParent = entries.filter(e => !e.original_parent);
        if (missingParent.length > 0) {
          console.warn(
            "[RecycleBin] loadDirectory: %d/%d entries have empty original_parent:",
            missingParent.length,
            entries.length,
            missingParent.map(e => ({ name: e.name, parsing_name: e.parsing_name, original_parent: e.original_parent }))
          );
        }
        const map = new Map<string, RecycleBinEntry>();
        for (const e of entries) {
          map.set(normalizeRecycleBinKey(e.parsing_name), e);
        }
        recycleBinIndexRef.current = map;
        listing = {
          path: "recyclebin://",
          entries: entries.map(e => ({
            name: e.name,
            path: e.parsing_name,
            is_dir: false,
            is_file: true,
            size: 0,
            modified: null,
            created: null,
            extension: null,
            is_hidden: false,
          })),
        } as DirListing;
      } else if (path.startsWith("thispc://") || path.startsWith("network://")) {
        // Virtual shell locations. Don't call readDirectory — the backend
        // would try to interpret "thispc://" as a real filesystem path,
        // which used to make navigation hang or crash. The main pane
        // renders a dedicated panel for "thispc://" anyway, so the entry
        // list stays empty. network:// is reserved for a future view and
        // gets the same treatment.
        recycleBinIndexRef.current = new Map();
        listing = {
          path,
          entries: [],
        } as DirListing;
      } else {
        listing = await readDirectory(path, showHiddenItems);
        // Clear the recycle bin index when navigating away from the bin.
        recycleBinIndexRef.current = new Map();
      }
      // Ignore stale responses from previous navigations
      if (navId !== navigationRef.current) {
        return;
      }
      const items = listing.entries.map(fileEntryToFSItem).map(item => ({
        ...item,
        // Use is_hidden from backend (Windows hidden attribute), fallback to dotfile check
        isHidden: item.isHidden || item.name.startsWith("."),
        tag: (item.tag || storedTags[item.id]) as FSItem["tag"],
      }));
      setCurrentFolderEntries(items);
      
      // Also cache items in the active tab
      if (targetTabId) {
        setTabs(prevTabs =>
          prevTabs.map(tab =>
            tab.id === targetTabId
              ? { ...tab, folderContents: items }
              : tab
          )
        );
      }
    } catch (err) {
      // Ignore stale errors from previous navigations
      if (navId !== navigationRef.current) {
        return;
      }
      setError(String(err));
      setCurrentFolderEntries([]);
      // Clear tab cache on error
      if (targetTabId) {
        setTabs(prevTabs =>
          prevTabs.map(tab =>
            tab.id === targetTabId
              ? { ...tab, folderContents: [] }
              : tab
          )
        );
      }
    } finally {
      // Only update loading state if this is still the latest navigation
      if (navId === navigationRef.current) {
        setIsLoading(false);
      }
    }
  }, [activeTabId, showHiddenItems]);

  // ── Active Tab ─────────────────────────────────────────────────────────────
  const activeTab = tabs.find(t => t.id === activeTabId);

  // ── Load directory when tab changes ──────────────────────────────────────────
  // This effect runs when activeTabId changes (tab switch)
  useEffect(() => {
    // Skip on initial mount - init() already loads the directory
    if (!isInitializedRef.current) {
      isInitializedRef.current = true;
      return;
    }
    
    if (!activeTabId) return;
    
    // Find the tab we're switching TO
    const targetTab = tabs.find(t => t.id === activeTabId);
    if (!targetTab) return;
    
    // Skip if this tab was already loaded (prevents duplicate loads)
    if (lastLoadedTabIdRef.current === activeTabId && targetTab.folderContents.length > 0) {
      // Always rebuild the recycle bin index for recycle bin tabs, since
      // the structured entry list isn't cached with the tab. Without this,
      // a cut on a re-mounted tab would have an empty index and fail.
      if (targetTab.currentPath.startsWith("recyclebin://")) {
        Promise.resolve().then(() => {
          void reloadRecycleBinIndex();
        });
      }
      return;
    }

    // Check if this tab's content is already cached
    const hasCachedContent = targetTab.folderContents && targetTab.folderContents.length > 0;
    
    if (hasCachedContent) {
      // Instant display from cache - no loading state
      lastLoadedTabIdRef.current = activeTabId;
      setCurrentFolderEntries(targetTab.folderContents);
      // Rebuild the recycle bin index from cache too, so a cut after a
      // tab switch without a refresh still has structured entries.
      if (targetTab.currentPath.startsWith("recyclebin://")) {
        // Defer to next tick to avoid setState-during-render.
        Promise.resolve().then(() => {
          refreshRecycleBinIndexFromEntries(targetTab.folderContents);
        });
      }
    } else {
      // No cache - need to load (show loading state)
      const loadPath = targetTab.currentPath;
      const navId = navigationRef.current + 1;
      navigationRef.current = navId;
      lastLoadedTabIdRef.current = activeTabId;

      const doLoad = async () => {
        setIsLoading(true);
        setError(null);
        try {
          let listing: DirListing;
          if (loadPath.startsWith("recyclebin://")) {
            const entries = await listRecycleBinEntries();
            const map = new Map<string, RecycleBinEntry>();
            for (const e of entries) {
              map.set(normalizeRecycleBinKey(e.parsing_name), e);
            }
            recycleBinIndexRef.current = map;
            listing = {
              path: "recyclebin://",
              entries: entries.map(e => ({
                name: e.name,
                path: e.parsing_name,
                is_dir: false,
                is_file: true,
                size: 0,
                modified: null,
                created: null,
                extension: null,
                is_hidden: false,
              })),
            } as DirListing;
          } else {
            listing = await readDirectory(loadPath, showHiddenItems);
            recycleBinIndexRef.current = new Map();
          }
          // Ignore stale responses
          if (navId !== navigationRef.current) {
            return;
          }
          const items = listing.entries.map(fileEntryToFSItem).map(item => ({
            ...item,
            // Use is_hidden from backend (Windows hidden attribute), fallback to dotfile check
            isHidden: item.isHidden || item.name.startsWith("."),
            tag: (item.tag || storedTags[item.id]) as FSItem["tag"],
          }));

          // Update both global state and tab cache
          setCurrentFolderEntries(items);
          // Restore selectedIds from tab when switching tabs
          handleSetSelectedIds(targetTab.selectedIds);
          setTabs(prevTabs =>
            prevTabs.map(tab =>
              tab.id === activeTabId
                ? { ...tab, folderContents: items }
                : tab
            )
          );
        } catch (err) {
          // Ignore stale errors
          if (navId !== navigationRef.current) {
            return;
          }
          setError(String(err));
          setCurrentFolderEntries([]);
        } finally {
          if (navId === navigationRef.current) {
            setIsLoading(false);
          }
        }
      };

      doLoad();
    }
  }, [activeTabId, showHiddenItems]);

  // Re-derive the recycle bin index from a list of FSItems (typically the
  // tab cache) when we can't call the Rust IPC directly. This is a
  // best-effort path that won't recover `original_parent` if the entries
  // came from the legacy PowerShell listing - the user must refresh the
  // bin in that case. We still set entries so the cache state is
  // consistent.
  const refreshRecycleBinIndexFromEntries = useCallback((items: FSItem[]) => {
    const map = new Map<string, RecycleBinEntry>();
    for (const item of items) {
      // Try to keep existing structured entry if we already have one.
      const existing = recycleBinIndexRef.current.get(normalizeRecycleBinKey(item.id));
      if (existing) {
        map.set(normalizeRecycleBinKey(item.id), existing);
        continue;
      }
      // Otherwise store a shell entry so we can at least show the user
      // a clear "refresh required" message instead of silently failing.
      map.set(normalizeRecycleBinKey(item.id), {
        parsing_name: item.path,
        original_parent: "",
        name: item.name,
      });
    }
    recycleBinIndexRef.current = map;
  }, []);

  // Re-query the native Recycle Bin IPC and rebuild the index from
  // scratch. Used when a tab is already mounted and we just need the
  // structured entries (the FSItem path list is cached but the index
  // is process-local and not persisted across HMR or tab re-mounts).
  const reloadRecycleBinIndex = useCallback(async () => {
    try {
      const entries = await listRecycleBinEntries();
      const map = new Map<string, RecycleBinEntry>();
      for (const e of entries) {
        map.set(normalizeRecycleBinKey(e.parsing_name), e);
      }
      recycleBinIndexRef.current = map;
      console.log(
        "[RecycleBin] index rebuilt: %d entries",
        map.size,
      );
    } catch (err) {
      console.error("[RecycleBin] failed to rebuild index:", err);
    }
  }, []);

  // ── Navigate to folder ──────────────────────────────────────────────────────
  const navigateTo = useCallback(async (folderId: string | null) => {
    if (!activeTabId) return;
    // Cancel any in-flight search so late-arriving batches don't pollute
    // the new path or leak into the new tab.
    cancelInFlightSearch();

    let targetPath: string;
    let title: string;

    // Derive display title. For virtual shell paths use a human-readable name
    // instead of splitting the path string char-by-char.
    if (folderId === null) {
      // Go to root (drive list) - but we still show the current drive's root
      const currentPath = activeTab?.currentPath || "";
      // Extract drive root (e.g. "C:/")
      const driveRoot = currentPath.substring(0, 3);
      targetPath = driveRoot;
      title = driveRoot;
    } else if (folderId.startsWith("thispc://")) {
      targetPath = folderId;
      title = "This PC";
    } else if (folderId.startsWith("recyclebin://")) {
      targetPath = folderId;
      title = "Recycle Bin";
    } else if (folderId.startsWith("network://")) {
      targetPath = folderId;
      title = "Network";
    } else {
      targetPath = folderId;
      const lastSlash = folderId.replace(/\\/g, "/").lastIndexOf("/");
      title = folderId.substring(lastSlash + 1) || folderId;
    }

    // Update tab history
    setTabs(prevTabs =>
      prevTabs.map(t => {
        if (t.id !== activeTabId) return t;
        const newHistory = t.history.slice(0, t.historyIndex + 1);
        const lastEntry = newHistory[newHistory.length - 1];
        if (!lastEntry || lastEntry.path !== targetPath) {
          newHistory.push({ folderId: targetPath, path: targetPath });
        }
        return {
          ...t,
          title,
          currentPath: targetPath,
          currentFolderId: targetPath,
          history: newHistory,
          historyIndex: newHistory.length - 1,
          selectedIds: [],
          searchState: {
            ...t.searchState,
            query: "",
            tag: null,
            typeFilter: null,
            results: [],
            resultsCount: 0,
            isSearching: false,
            resultsRoot: null,
          },
        };
      })
    );

    setRecentPaths(prev => {
      const updated = [targetPath, ...prev.filter(path => path !== targetPath)].slice(0, 20);
      localStorage.setItem("NEXUS_RECENT_PATHS", JSON.stringify(updated));
      return updated;
    });

    setStatusMessage(language === "vi" ? `Đã chuyển tới ${targetPath}` : `Navigated to ${targetPath}`);

    // Load directory contents for the current tab
    await loadDirectory(targetPath, activeTabId);

    // Restore per-folder view mode
    if (!targetPath.startsWith("thispc://") && !targetPath.startsWith("recyclebin://") && !targetPath.startsWith("network://")) {
      const savedMode = getFolderViewMode(targetPath);
      if (savedMode) {
        setViewMode(savedMode);
      }
    }
  }, [activeTabId, activeTab, language, loadDirectory, cancelInFlightSearch]);

  // ── Navigate Back ──────────────────────────────────────────────────────────
  const navigateBack = useCallback(async () => {
    if (!activeTab || activeTab.historyIndex <= 0) return;
    cancelInFlightSearch();
    const targetIdx = activeTab.historyIndex - 1;
    const { folderId, path } = activeTab.history[targetIdx];

    setTabs(prevTabs =>
      prevTabs.map(t => {
        if (t.id !== activeTabId) return t;
        const lastSlash = (path || "").replace(/\\/g, "/").lastIndexOf("/");
        const baseName = (path || "").substring(lastSlash + 1) || path || "";
        const displayTitle = baseName.startsWith("thispc")
          ? "This PC"
          : baseName.startsWith("recyclebin")
          ? "Recycle Bin"
          : baseName.startsWith("network")
          ? "Network"
          : baseName;
        return {
          ...t,
          title: displayTitle,
          currentPath: path,
          currentFolderId: folderId,
          historyIndex: targetIdx,
          selectedIds: [],
          searchState: {
            ...t.searchState,
            query: "",
            tag: null,
            typeFilter: null,
            results: [],
            resultsCount: 0,
            isSearching: false,
            resultsRoot: null,
          },
        };
      })
    );

    if (path) await loadDirectory(path, activeTabId);

    // Restore per-folder view mode for navigateBack
    if (path && !path.startsWith("thispc://") && !path.startsWith("recyclebin://") && !path.startsWith("network://")) {
      const savedMode = getFolderViewMode(path);
      if (savedMode) {
        setViewMode(savedMode);
      }
    }
  }, [activeTab, activeTabId, loadDirectory, cancelInFlightSearch]);

  // ── Navigate Forward ────────────────────────────────────────────────────────
  const navigateForward = useCallback(async () => {
    if (!activeTab || activeTab.historyIndex >= activeTab.history.length - 1) return;
    cancelInFlightSearch();
    const targetIdx = activeTab.historyIndex + 1;
    const { folderId, path } = activeTab.history[targetIdx];

    setTabs(prevTabs =>
      prevTabs.map(t => {
        if (t.id !== activeTabId) return t;
        const lastSlash = (path || "").replace(/\\/g, "/").lastIndexOf("/");
        const baseName = (path || "").substring(lastSlash + 1) || path || "";
        const displayTitle = baseName.startsWith("thispc")
          ? "This PC"
          : baseName.startsWith("recyclebin")
          ? "Recycle Bin"
          : baseName.startsWith("network")
          ? "Network"
          : baseName;
        return {
          ...t,
          title: displayTitle,
          currentPath: path,
          currentFolderId: folderId,
          historyIndex: targetIdx,
          selectedIds: [],
          searchState: {
            ...t.searchState,
            query: "",
            tag: null,
            typeFilter: null,
            results: [],
            resultsCount: 0,
            isSearching: false,
            resultsRoot: null,
          },
        };
      })
    );

    if (path) await loadDirectory(path, activeTabId);

    // Restore per-folder view mode for navigateBack
    if (path && !path.startsWith("thispc://") && !path.startsWith("recyclebin://") && !path.startsWith("network://")) {
      const savedMode = getFolderViewMode(path);
      if (savedMode) {
        setViewMode(savedMode);
      }
    }
  }, [activeTab, activeTabId, loadDirectory, cancelInFlightSearch]);

  // ── Navigate Up ─────────────────────────────────────────────────────────────
  const navigateUp = useCallback(async () => {
    if (!activeTab || !activeTab.currentFolderId) return;
    const parent = getParentPath(activeTab.currentFolderId);
    await navigateTo(parent);
  }, [activeTab, navigateTo]);

  // ── Computed selectedIds from active tab ────────────────────────────────────────
  // selectedIds should come from active tab's state for per-tab isolation
  const computedSelectedIds = activeTab?.selectedIds || [];

  // Custom setSelectedIds that updates active tab's state
  const handleSetSelectedIds = useCallback((newIds: string[] | ((prev: string[]) => string[])) => {
    if (!activeTabId) return;

    setTabs(prevTabs => {
      const currentTab = prevTabs.find(t => t.id === activeTabId);
      const currentIds = (currentTab?.selectedIds || []).map((id) => id.replace(/\\/g, "/"));
      const idsToSet = typeof newIds === 'function'
        ? newIds(currentIds)
        : newIds.map((id) => id.replace(/\\/g, "/"));

      return prevTabs.map(tab =>
        tab.id === activeTabId
          ? { ...tab, selectedIds: idsToSet }
          : tab
      );
    });
  }, [activeTabId]);

  // ── Create Folder ───────────────────────────────────────────────────────────
  const createFolder = useCallback(async (name: string) => {
    if (!activeTab) return;
    try {
      const trimmedName = name.trim() || "New Folder";
      const newPath = joinPath(activeTab.currentPath, trimmedName);
      await createDirectory(newPath);
      await loadDirectory(activeTab.currentPath, activeTabId);
      handleSetSelectedIds([newPath]);
      pushOperation({ kind: "create_folder", targetPath: newPath });
      setStatusMessage(`Folder "${trimmedName}" created.`);
    } catch (err) {
      setError(String(err));
      setStatusMessage(`Error: ${err}`);
    }
  }, [activeTab, activeTabId, handleSetSelectedIds, loadDirectory]);

  // ── Create File ─────────────────────────────────────────────────────────────
  const createFile = useCallback(async (name: string, content: string = "") => {
    if (!activeTab) return;
    try {
      const trimmedName = name.trim() || "untitled.txt";
      const newPath = joinPath(activeTab.currentPath, trimmedName);
      await writeTextFile(newPath, content);
      await loadDirectory(activeTab.currentPath, activeTabId);
      handleSetSelectedIds([newPath]);
      pushOperation({ kind: "create_file", targetPath: newPath });
      setStatusMessage(`File "${trimmedName}" created.`);
      return { id: newPath, name: trimmedName, path: newPath, type: "file" as const, parentId: activeTab.currentPath, size: content.length, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    } catch (err) {
      setError(String(err));
      setStatusMessage(`Error: ${err}`);
    }
  }, [activeTab, activeTabId, handleSetSelectedIds, loadDirectory]);

  // ── Delete Item ─────────────────────────────────────────────────────────────
  const deleteItem = useCallback(async (id: string, mode: "recycle" | "permanent" = "recycle") => {
    try {
      await tauriDeleteItem(id, mode);
      if (activeTab) await loadDirectory(activeTab.currentPath, activeTabId);
      handleSetSelectedIds(prev => prev.filter(i => i !== id));
      setStatusMessage(
        mode === "permanent"
          ? (language === "vi" ? "Đã xóa vĩnh viễn mục." : "Item permanently deleted.")
          : (language === "vi" ? "Đã chuyển mục vào Thùng rác." : "Item moved to Recycle Bin.")
      );
    } catch (err) {
      setError(String(err));
      setStatusMessage(`Delete error: ${err}`);
    }
  }, [activeTab, activeTabId, handleSetSelectedIds, language, loadDirectory]);

  // ── Rename Item ─────────────────────────────────────────────────────────────
  const renameItem = useCallback(async (id: string, newName: string) => {
    if (!newName.trim() || !activeTab) return;
    try {
      const parent = getParentPath(id);
      const newPath = joinPath(parent, newName.trim());
      await tauriRenameItem(id, newPath);
      await loadDirectory(activeTab.currentPath, activeTabId);
      pushOperation({ kind: parent === getParentPath(newPath) ? "rename" : "move", sourcePath: id, targetPath: newPath });
      setStatusMessage(`Renamed to "${newName}".`);
    } catch (err) {
      setError(String(err));
      setStatusMessage(`Rename error: ${err}`);
    }
  }, [activeTab, activeTabId, loadDirectory]);

  const refreshCurrentDirectory = useCallback(async () => {
    if (!activeTab) return;
    await loadDirectory(activeTab.currentPath, activeTabId);
    setStatusMessage(language === "vi" ? "Đã làm mới thư mục hiện tại." : "Current folder refreshed.");
  }, [activeTab, activeTabId, language, loadDirectory]);

  const closeOpenWithModal = useCallback(() => {
    setOpenWithState((prev) => ({
      visible: false,
      targetPath: null,
      selectedApp: null,
      association: null,
      alwaysUse: false,
      loading: false,
      mode: "picker",
      recentApps: prev.recentApps,
      candidates: null,
    }));
  }, []);

  const rememberOpenWithApp = useCallback((app: OpenWithApp) => {
    setOpenWithState((prev) => {
      const nextRecentApps = [app, ...prev.recentApps.filter((entry) => entry.path.toLowerCase() !== app.path.toLowerCase())]
        .slice(0, OPEN_WITH_RECENTS_LIMIT);
      persistOpenWithRecents(nextRecentApps);
      return {
        ...prev,
        recentApps: nextRecentApps,
      };
    });
  }, []);

  const runOpenWithSelection = useCallback(async (path: string, app: OpenWithApp, alwaysUse: boolean) => {
    if (!path || !app) {
      throw new Error("Path and application are required.");
    }

    if (app.handler_id) {
      await openPathWithHandler(path, app);
      const ext = getPathExtension(path);
      if (alwaysUse && ext) {
        await setOpenWithAssociation(ext, app);
      }
      if (!alwaysUse && ext) {
        await clearOpenWithAssociation(ext).catch(() => {});
      }
      rememberOpenWithApp(app);
      setStatusMessage(
        language === "vi"
          ? `Đã mở ${path} bằng ${app.name}`
          : `Opened ${path} with ${app.name}`
      );
      closeOpenWithModal();
      return;
    }

    const executablePath = app.launch_path || app.path;
    const looksLikeExecutablePath = /^[A-Za-z]:[\\/]/.test(executablePath) || executablePath.startsWith("\\\\");

    if (!looksLikeExecutablePath) {
      throw new Error(`Selected app is not directly launchable: ${app.name}`);
    }

    await openPathWithApplication(path, executablePath);
    const ext = getPathExtension(path);
    if (alwaysUse && ext) {
      await setOpenWithAssociation(ext, app);
    }
    if (!alwaysUse && ext) {
      await clearOpenWithAssociation(ext).catch(() => {});
    }
    rememberOpenWithApp(app);
    setStatusMessage(
      language === "vi"
        ? `Đã mở ${path} bằng ${app.name}`
        : `Opened ${path} with ${app.name}`
    );
    closeOpenWithModal();
  }, [closeOpenWithModal, language, rememberOpenWithApp]);

  const launchOpenWithApp = useCallback(async (path: string, app: OpenWithApp, alwaysUse = false) => {
    await runOpenWithSelection(path, app, alwaysUse);
  }, [runOpenWithSelection]);

  const preloadOpenWithCandidates = useCallback(async (path: string) => {
    try {
      const [association, candidates] = await Promise.all([
        getOpenWithAssociation(path),
        getOpenWithCandidates(path),
      ]);
      setOpenWithState((prev) => ({
        ...prev,
        targetPath: path,
        selectedApp: association?.app ?? candidates.default_app ?? candidates.recommended_apps[0] ?? prev.recentApps[0] ?? null,
        association,
        alwaysUse: association?.source === "custom" ? prev.alwaysUse : false,
        mode: "picker",
        candidates,
      }));
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const openWithPath = useCallback(async (path: string) => {
    try {
      const [association, candidates] = await Promise.all([
        getOpenWithAssociation(path),
        getOpenWithCandidates(path),
      ]);
      setOpenWithState((prev) => ({
        ...prev,
        visible: true,
        targetPath: path,
        selectedApp: association?.app ?? candidates.default_app ?? candidates.recommended_apps[0] ?? prev.recentApps[0] ?? null,
        association,
        alwaysUse: association?.source === "custom",
        loading: false,
        mode: "picker",
        candidates,
      }));
    } catch (err) {
      setError(String(err));
      setOpenWithState((prev) => ({
        ...prev,
        visible: true,
        targetPath: path,
        selectedApp: prev.recentApps[0] ?? null,
        association: null,
        alwaysUse: false,
        loading: false,
        mode: "picker",
        candidates: null,
      }));
    }
  }, []);

  const browseOpenWithApp = useCallback(async () => {
    if (!openWithState.targetPath) return null;
    setOpenWithState(prev => ({ ...prev, loading: true }));
    try {
      const app = await showOpenWithDialog(openWithState.targetPath);
      setOpenWithState(prev => {
        const nextRecentApps = app
          ? [app, ...prev.recentApps.filter((entry) => entry.path.toLowerCase() !== app.path.toLowerCase())].slice(0, OPEN_WITH_RECENTS_LIMIT)
          : prev.recentApps;
        if (app) {
          persistOpenWithRecents(nextRecentApps);
        }
        return {
          ...prev,
          loading: false,
          selectedApp: app ?? prev.selectedApp,
          recentApps: nextRecentApps,
          candidates: prev.candidates
            ? {
                ...prev.candidates,
                all_apps: app
                  ? [app, ...prev.candidates.all_apps.filter((entry) => entry.path.toLowerCase() !== app.path.toLowerCase())]
                  : prev.candidates.all_apps,
              }
            : prev.candidates,
        };
      });
      return app;
    } catch (err) {
      setError(String(err));
      setOpenWithState(prev => ({ ...prev, loading: false }));
      return null;
    }
  }, [openWithState.targetPath]);

  const confirmOpenWith = useCallback(async () => {
    if (!openWithState.targetPath || !openWithState.selectedApp) return;
    try {
      await runOpenWithSelection(openWithState.targetPath, openWithState.selectedApp, openWithState.alwaysUse);
    } catch (err) {
      setError(String(err));
      setStatusMessage(language === "vi" ? "Không thể mở tệp bằng ứng dụng đã chọn." : "Could not open file with the selected app.");
    }
  }, [language, openWithState, runOpenWithSelection]);

  const clearOpenWithPreference = useCallback(async (path?: string) => {
    const target = path ?? openWithState.targetPath;
    const ext = target ? getPathExtension(target) : null;
    if (!ext) return;
    try {
      await clearOpenWithAssociation(ext);
      setOpenWithState(prev => ({ ...prev, association: null, alwaysUse: false }));
      setStatusMessage(language === "vi" ? `Đã xóa ứng dụng mặc định cho ${ext}` : `Cleared default app for ${ext}`);
    } catch (err) {
      setError(String(err));
    }
  }, [language, openWithState.targetPath]);

  const pushOperation = useCallback((operation: FileOperationRecord) => {
    setUndoStack(prev => [...prev, operation].slice(-100));
    setRedoStack([]);
  }, []);

  const undoLastOperation = useCallback(async () => {
    const operation = undoStack[undoStack.length - 1];
    if (!operation) return;

    try {
      switch (operation.kind) {
        case "create_file":
        case "create_folder":
        case "paste_copy":
        case "extract_zip":
        case "compress_zip":
          if (operation.targetPath) {
            await tauriDeleteItem(operation.targetPath, "permanent");
          }
          break;
        case "rename":
        case "move":
        case "paste_cut":
          if (operation.sourcePath && operation.targetPath) {
            await tauriRenameItem(operation.targetPath, operation.sourcePath);
          }
          break;
        default:
          return;
      }

      setUndoStack(prev => prev.slice(0, -1));
      setRedoStack(prev => [...prev, operation]);
      if (activeTab) await loadDirectory(activeTab.currentPath, activeTabId);
      setStatusMessage(language === "vi" ? "Đã hoàn tác thao tác gần nhất." : "Undid last operation.");
    } catch (err) {
      setError(String(err));
      setStatusMessage(`Undo error: ${err}`);
    }
  }, [activeTab, activeTabId, language, loadDirectory, undoStack]);

  const redoLastOperation = useCallback(async () => {
    const operation = redoStack[redoStack.length - 1];
    if (!operation) return;

    try {
      switch (operation.kind) {
        case "create_file":
          if (operation.targetPath) {
            await writeTextFile(operation.targetPath, "");
          }
          break;
        case "create_folder":
          if (operation.targetPath) {
            await createDirectory(operation.targetPath);
          }
          break;
        case "rename":
        case "move":
        case "paste_cut":
          if (operation.sourcePath && operation.targetPath) {
            await tauriRenameItem(operation.sourcePath, operation.targetPath);
          }
          break;
        case "paste_copy":
          if (operation.sourcePath && operation.targetPath) {
            await copyItem(operation.sourcePath, operation.targetPath);
          }
          break;
        case "compress_zip":
          if (operation.sourcePath && operation.targetPath) {
            await compressToZip([operation.sourcePath], operation.targetPath);
          }
          break;
        default:
          return;
      }

      setRedoStack(prev => prev.slice(0, -1));
      setUndoStack(prev => [...prev, operation]);
      if (activeTab) await loadDirectory(activeTab.currentPath, activeTabId);
      setStatusMessage(language === "vi" ? "Đã làm lại thao tác gần nhất." : "Redid last operation.");
    } catch (err) {
      setError(String(err));
      setStatusMessage(`Redo error: ${err}`);
    }
  }, [activeTab, activeTabId, language, loadDirectory, redoStack]);

  // ── Tab Manager ────────────────────────────────────────────────────────────
  const createNewTab = useCallback(async (folderId: string | null = null) => {
    // Cancel any in-flight search in the current tab before opening a new one
    // — prevents stale batches from continuing to leak in.
    cancelInFlightSearch();
    const driveList = drives.length > 0 ? drives : ["C:/"];
    const defaultPath = folderId || driveList[0];
    const lastSlash = defaultPath.replace(/\\/g, "/").lastIndexOf("/");
    const title = defaultPath.substring(lastSlash + 1) || defaultPath;

    const newTabId = `tab-${Date.now()}`;
    const newTab: ExplorerTab = {
      id: newTabId,
      title,
      currentPath: defaultPath,
      currentFolderId: defaultPath,
      history: [{ folderId: defaultPath, path: defaultPath }],
      historyIndex: 0,
      selectedIds: [],
      scrollPosition: 0,
      folderContents: [],
      showSpaceAnalyzer: false,
      searchState: {
        query: "",
        tag: null,
        typeFilter: null,
        mode: "default",
        results: [],
        resultsRoot: null,
        isSearching: false,
        resultsCount: 0,
      },
      paneSession: { ...DEFAULT_PANE_SESSION },
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTabId);
    await loadDirectory(defaultPath, newTabId);

    // Restore per-folder view mode for new tab
    if (!defaultPath.startsWith("thispc://") && !defaultPath.startsWith("recyclebin://") && !defaultPath.startsWith("network://")) {
      const savedMode = getFolderViewMode(defaultPath);
      if (savedMode) {
        setViewMode(savedMode);
      }
    }

    setStatusMessage("New tab opened.");
  }, [drives, loadDirectory, cancelInFlightSearch]);

  const closeTab = useCallback((tabId: string) => {
    if (tabs.length <= 1) return;
    const filtered = tabs.filter(t => t.id !== tabId);
    setTabs(filtered);
    if (activeTabId === tabId) {
      setActiveTabId(filtered[filtered.length - 1].id);
    }
    setStatusMessage("Tab closed.");
  }, [tabs, activeTabId]);

  // Open a folder in a new tab (used by search results "Open folder location").
  const openFolderInNewTab = useCallback(async (folderPath: string) => {
    cancelInFlightSearch();
    const normalizedPath = folderPath.replace(/\\/g, "/");
    const newTabId = `tab-${Date.now()}`;
    const lastSlash = normalizedPath.lastIndexOf("/");
    const title = normalizedPath.substring(lastSlash + 1) || normalizedPath;
    const newTab: ExplorerTab = {
      id: newTabId,
      title,
      currentPath: normalizedPath,
      currentFolderId: normalizedPath,
      history: [{ folderId: normalizedPath, path: normalizedPath }],
      historyIndex: 0,
      selectedIds: [],
      scrollPosition: 0,
      folderContents: [],
      showSpaceAnalyzer: false,
      searchState: {
        query: "",
        tag: null,
        typeFilter: null,
        mode: "default",
        results: [],
        resultsRoot: null,
        isSearching: false,
        resultsCount: 0,
      },
      paneSession: { ...DEFAULT_PANE_SESSION },
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTabId);
    await loadDirectory(normalizedPath, newTabId);

    // Restore per-folder view mode
    const savedMode = getFolderViewMode(normalizedPath);
    if (savedMode) {
      setViewMode(savedMode);
    }

    setStatusMessage(language === "vi" ? `Đã mở thư mục: ${title}` : `Opened folder: ${title}`);
  }, [loadDirectory, language, cancelInFlightSearch]);

  // Open path in new tab (for duplicate finder)
  const openPathInNewTab = useCallback(async (filePath: string) => {
    cancelInFlightSearch();
    // Normalize to forward slashes for consistent ID matching
    const normalizedPath = filePath.replace(/\\/g, "/");
    const lastSlash = normalizedPath.lastIndexOf("/");
    const parentPath = normalizedPath.substring(0, lastSlash);

    // Create new tab with parent path - space analyzer disabled in new tab
    const newTabId = `tab-${Date.now()}`;
    const fileName = normalizedPath.substring(lastSlash + 1);
    const newTab: ExplorerTab = {
      id: newTabId,
      title: parentPath.split("/").pop() || parentPath,
      currentPath: parentPath,
      currentFolderId: parentPath,
      history: [{ folderId: parentPath, path: parentPath }],
      historyIndex: 0,
      selectedIds: [normalizedPath], // Use normalized path to match FSItem.id
      scrollPosition: 0,
      folderContents: [],
      showSpaceAnalyzer: false, // Always closed in new tab
      searchState: {
        query: "",
        tag: null,
        typeFilter: null,
        mode: "default",
        results: [],
        resultsRoot: null,
        isSearching: false,
        resultsCount: 0,
      },
      paneSession: { ...DEFAULT_PANE_SESSION },
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTabId);
    await loadDirectory(parentPath, newTabId);
    setStatusMessage(language === "vi" ? `Đã mở vị trí file: ${fileName}` : `Opened file location: ${fileName}`);
  }, [activeTabId, loadDirectory, language, cancelInFlightSearch]);

  // ── Clipboard Operations ────────────────────────────────────────────────────
  const copySpecificItems = useCallback((itemIds: string[]) => {
    if (itemIds.length === 0) return;
    setClipboard({ itemIds: [...itemIds], action: "copy", sourcePath: activeTab?.currentPath });
    setStatusMessage(`Copied ${itemIds.length} item(s).`);
  }, [activeTab?.currentPath]);

  const cutSpecificItems = useCallback(
    (itemIds: string[], recycleBinEntries?: RecycleBinEntry[]) => {
      if (itemIds.length === 0) return;
      setClipboard({
        itemIds: [...itemIds],
        action: "cut",
        sourcePath: activeTab?.currentPath,
        recycleBinEntries: recycleBinEntries ? [...recycleBinEntries] : undefined,
      });
      setStatusMessage(`Cut ${itemIds.length} item(s).`);
    },
    [activeTab?.currentPath],
  );

  const copyItems = useCallback(() => {
    copySpecificItems(computedSelectedIds);
  }, [copySpecificItems, computedSelectedIds]);

  // When cutting from the Recycle Bin, we need the structured
  // RecycleBinEntry list (name + original_parent + parsing_name) for the
  // Rust restore command. We look it up from the index we populated when
  // the bin was listed. If the index is empty (e.g. HMR re-mounted the
  // component without re-running the IPC), we lazy-rebuild it from the
  // Rust side and then retry.
  const cutItems = useCallback(async () => {
    if (activeTab?.currentPath?.startsWith("recyclebin://")) {
      // Lazy rebuild: if the index is empty but the bin tab has entries
      // showing, refetch from Rust. This handles the HMR case where the
      // tab's folderContents came from cache but the process-local map
      // was lost.
      if (recycleBinIndexRef.current.size === 0 && computedSelectedIds.length > 0) {
        console.log(
          "[RecycleBin] cut: index empty, lazy-rebuilding from Rust IPC",
        );
        await reloadRecycleBinIndex();
      }
      const rbEntries: RecycleBinEntry[] = [];
      const missing: string[] = [];
      for (const id of computedSelectedIds) {
        const known = recycleBinIndexRef.current.get(normalizeRecycleBinKey(id));
        if (known) {
          rbEntries.push({ ...known });
        } else {
          missing.push(id);
        }
      }
      if (missing.length > 0) {
        const msg =
          language === "vi"
            ? `Không tìm thấy ${missing.length}/${computedSelectedIds.length} mục trong chỉ mục. Vui lòng nhấn F5 trên tab Thùng rác để làm mới rồi thử lại.`
            : `${missing.length}/${computedSelectedIds.length} item(s) not in the recycle bin index. Please press F5 on the Recycle Bin tab to refresh and try again.`;
        console.warn("[RecycleBin] cut aborted - missing index entries:", missing);
        setStatusMessage(msg);
        setError(msg);
        return;
      }
      // Detect stale entries (came from cache built before the index
      // was populated, so `original_parent` is empty). Refuse to call
      // the restore command with bad data.
      const stale = rbEntries.filter(e => !e.original_parent);
      if (stale.length > 0) {
        const msg =
          language === "vi"
            ? `Chỉ mục Thùng rác đã cũ (${stale.length}/${rbEntries.length} mục thiếu thông tin vị trí gốc). Vui lòng nhấn F5 trên tab Thùng rác để làm mới rồi thử lại.`
            : `Recycle bin index is stale (${stale.length}/${rbEntries.length} items missing original location). Please press F5 on the Recycle Bin tab to refresh and try again.`;
        console.warn("[RecycleBin] cut aborted - stale entries:", stale);
        setStatusMessage(msg);
        setError(msg);
        return;
      }
      console.log(
        "[RecycleBin] cut: %d entries captured (index size=%d)",
        rbEntries.length,
        recycleBinIndexRef.current.size,
      );
      cutSpecificItems(computedSelectedIds, rbEntries);
      return;
    }
    cutSpecificItems(computedSelectedIds);
  }, [cutSpecificItems, computedSelectedIds, activeTab?.currentPath, language, reloadRecycleBinIndex]);

  const startRenameSelected = useCallback(() => {
    if (computedSelectedIds.length !== 1) return null;
    const item = currentFolderEntries.find(entry => entry.id === computedSelectedIds[0]) || null;
    return item;
  }, [computedSelectedIds, currentFolderEntries]);

  const compressSelectedToZip = useCallback(async (sourcePaths: string[], destinationZip: string) => {
    if (!activeTab || sourcePaths.length === 0) return;
    try {
      await compressToZip(sourcePaths, destinationZip);
      pushOperation({ kind: "compress_zip", sourcePath: sourcePaths[0], targetPath: destinationZip });
      await loadDirectory(activeTab.currentPath, activeTabId);
      setStatusMessage(language === "vi" ? "Đã tạo tệp ZIP." : "ZIP archive created.");
    } catch (err) {
      setError(String(err));
      setStatusMessage(`ZIP error: ${err}`);
    }
  }, [activeTab, activeTabId, language, loadDirectory, pushOperation]);

  const extractZipArchive = useCallback(async (zipPath: string, destinationDir: string) => {
    if (!activeTab) return;
    try {
      await extractZip(zipPath, destinationDir);
      pushOperation({ kind: "extract_zip", targetPath: destinationDir });
      await loadDirectory(activeTab.currentPath, activeTabId);
      setStatusMessage(language === "vi" ? "Đã giải nén tệp ZIP." : "ZIP archive extracted.");
    } catch (err) {
      setError(String(err));
      setStatusMessage(`Extract error: ${err}`);
    }
  }, [activeTab, activeTabId, language, loadDirectory, pushOperation]);

  const moveOrCopyItems = useCallback(async (
    sourcePaths: string[],
    targetDirectory: string,
    mode: DragDropMode
  ) => {
    if (sourcePaths.length === 0) return [] as string[];

    console.log("[moveOrCopyItems] called with:", { sourcePaths, targetDirectory, mode });

    const makeUniqueDestination = (sourcePath: string, existingPaths: Set<string>) => {
      const normalizedSource = sourcePath.replace(/\\/g, "/");
      const sourceName = normalizedSource.split("/").pop() || "file";
      const dotIndex = sourceName.lastIndexOf(".");
      const hasExtension = dotIndex > 0;
      const baseName = hasExtension ? sourceName.slice(0, dotIndex) : sourceName;
      const extension = hasExtension ? sourceName.slice(dotIndex) : "";

      let candidateName = sourceName;
      let candidatePath = joinPath(targetDirectory, candidateName);
      let copyIndex = 1;

      console.log("[makeUniqueDestination] source:", sourcePath, "targetDir:", targetDirectory);
      console.log("[makeUniqueDestination] existingPaths:", [...existingPaths]);

      // Keep generating until we find a name that doesn't conflict with anything
      while (existingPaths.has(candidatePath.replace(/\\/g, "/").toLowerCase())) {
        candidateName = copyIndex === 1
          ? `${baseName}_Copy${extension}`
          : `${baseName}_Copy_${copyIndex}${extension}`;
        candidatePath = joinPath(targetDirectory, candidateName);
        copyIndex += 1;
      }

      console.log("[makeUniqueDestination] result:", candidatePath);
      // Only add the final non-conflicting name to existingPaths
      existingPaths.add(candidatePath.replace(/\\/g, "/").toLowerCase());
      return candidatePath;
    };

    const existingPaths: Set<string> = new Set(currentFolderEntries.map(item => item.path.replace(/\\/g, "/").toLowerCase()));
    const resultPaths: string[] = [];

    for (const sourcePath of sourcePaths) {
      const destPath = makeUniqueDestination(sourcePath, existingPaths);
      try {
        if (mode === "copy") {
          await copyItem(sourcePath, destPath);
          pushOperation({ kind: "paste_copy", sourcePath, targetPath: destPath });
        } else {
          await tauriRenameItem(sourcePath, destPath);
          pushOperation({ kind: "paste_cut", sourcePath, targetPath: destPath });
        }
        resultPaths.push(destPath);
      } catch (err) {
        throw err;
      }
    }
    return resultPaths;
  }, [currentFolderEntries, pushOperation]);

  const pasteItems = useCallback(async () => {
    if (clipboard.itemIds.length === 0 || !activeTab || !clipboard.action) return;
    const target = activeTab.currentPath;

    // Detect Recycle Bin sources via the structured data we captured
    // at cut time. We prefer `clipboard.sourcePath` + the explicit
    // `recycleBinEntries` field, but fall back to the legacy path
    // substring check for any older clipboard entries that don't have it.
    const isRecycleBinSource =
      (clipboard.sourcePath?.startsWith("recyclebin://") ?? false) ||
      clipboard.itemIds.some(id => id.toLowerCase().includes('$recycle.bin'));

    try {
      // If moving from Recycle Bin, use the special restore function.
      // We send the structured RecycleBinEntry list back to Rust so it
      // doesn't have to guess which item each id refers to. Falls back to
      // the legacy path-based restore for any entries that lack
      // structured data.
      if (isRecycleBinSource && clipboard.action === "cut") {
        const { restoreFromRecycleBin, restoreRecycleBinEntries } = await import(
          "./TauriFileSystem"
        );
        let result;
        if (clipboard.recycleBinEntries && clipboard.recycleBinEntries.length > 0) {
          result = await restoreRecycleBinEntries(clipboard.recycleBinEntries);
        } else {
          result = await restoreFromRecycleBin([...clipboard.itemIds], target);
        }

        if (result.success) {
          setClipboard({ itemIds: [], action: null });

          // Auto-refresh the destination folder if it's the currently active tab
          const destFolder = clipboard.recycleBinEntries?.[0]?.original_parent;
          if (destFolder && activeTab?.currentPath === destFolder) {
            await loadDirectory(destFolder, activeTabId);
          } else if (destFolder) {
            // Notify user that destination folder needs refresh
            const destName = destFolder.split(/[\\/]/).pop() || destFolder;
            setStatusMessage(
              language === "vi"
                ? `Đã khôi phục ${result.restored_count} mục. Vui lòng refresh folder "${destName}" để xem.`
                : `Restored ${result.restored_count} item(s). Please refresh folder "${destName}" to view.`,
            );
            return;
          }

          setStatusMessage(
            language === "vi"
              ? `Đã khôi phục ${result.restored_count} mục từ Thùng rác.`
              : `Restored ${result.restored_count} item(s) from Recycle Bin.`,
          );
        } else {
          setError(result.errors.join("; "));
          setStatusMessage(
            language === "vi"
              ? `Lỗi khôi phục: ${result.errors.join(", ")}`
              : `Restore error: ${result.errors.join(", ")}`,
          );
        }
        return;
      }

      // Fire-and-forget the start. The Rust worker handles the actual
      // copy/move and emits progress events that drive the
      // TransferQueueModal. The active directory is refreshed
      // automatically when the corresponding job transitions to a
      // terminal state (see the watcher in App.tsx).
      const { startTransfer } = await import("./TauriFileSystem");
      const { job_id } = await startTransfer(
        [...clipboard.itemIds],
        target,
        clipboard.action === "copy" ? "copy" : "move",
      );
      // Track the job on the active tab so App.tsx can refresh the
      // right tab when it finishes.
      watchedJobIdsRef.current.add(job_id);
      watchedJobTargetRef.current.set(job_id, target);
      watchedJobTabIdRef.current.set(job_id, activeTabId);

      if (clipboard.action === "cut") {
        setClipboard({ itemIds: [], action: null });
      }
      setStatusMessage(
        clipboard.action === "copy"
          ? language === "vi"
            ? `Đang sao chép ${clipboard.itemIds.length} mục...`
            : `Copying ${clipboard.itemIds.length} item(s)...`
          : language === "vi"
            ? `Đang di chuyển ${clipboard.itemIds.length} mục...`
            : `Moving ${clipboard.itemIds.length} item(s)...`,
      );
    } catch (err) {
      setError(String(err));
      setStatusMessage(`Paste error: ${err}`);
    }
  }, [clipboard, activeTab, activeTabId, language, loadDirectory]);

  // ── File Content (for editor) ────────────────────────────────────────────────
  const openFileForEditing = useCallback(async (path: string) => {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const isTextFile = EDITABLE_TEXT_EXTENSIONS.test(ext);

    if (!isTextFile) {
      try {
        const association = await getOpenWithAssociation(path);
        if (association?.app) {
          if (association.app.handler_id) {
            await openPathWithHandler(path, association.app);
          } else {
            await openPathWithApplication(path, association.app.path);
          }
          setStatusMessage(language === "vi" ? `Đã mở tệp bằng ${association.app.name}: ${path}` : `Opened file with ${association.app.name}: ${path}`);
        } else {
          await openPathWithDefaultApp(path);
          setStatusMessage(language === "vi" ? `Đã mở tệp bằng ứng dụng mặc định: ${path}` : `Opened file with default app: ${path}`);
        }
      } catch (err) {
        setError(String(err));
        setStatusMessage(language === "vi" ? `Không thể mở tệp: ${path}` : `Could not open file: ${path}`);
      }
      return;
    }
    
    try {
      const content = await readTextFile(path);
      setOpenFileContent(content);
      setOpenFileId(path);
      setRecentFileIds(prev => {
        const filtered = prev.filter(f => f !== path);
        return [path, ...filtered].slice(0, 8);
      });
    } catch (err) {
      setError(String(err));
      setOpenFileContent(`[Cannot read file: ${err}]`);
      setOpenFileId(path);
    }
  }, [language]);

  const updateFileContent = useCallback(async (id: string, newContent: string) => {
    try {
      await writeTextFile(id, newContent);
      setOpenFileContent(newContent);
      setStatusMessage("File saved.");
    } catch (err) {
      setError(String(err));
      setStatusMessage(`Save error: ${err}`);
    }
  }, []);

  // ── Search / Filter ────────────────────────────────────────────────────────
  // Search state is per-tab. When activeTab changes, components automatically
  // read the new tab's searchState — no stale results carry over.
  // (searchRequestIdRef + cancelInFlightSearch declared near top of hook.)

  const activeSearchState = useMemo(() => activeTab?.searchState ?? {
    query: "",
    tag: null,
    typeFilter: null,
    mode: "default" as const,
    results: [] as FSItem[],
    resultsRoot: null,
    isSearching: false,
    resultsCount: 0,
  }, [activeTab?.searchState]);

  // Aliases for backward compatibility with existing code
  const searchFilter = activeSearchState;
  const searchResults = activeSearchState.results;
  const isSearching = activeSearchState.isSearching;
  const searchResultsCount = activeSearchState.resultsCount;
  const searchResultsRoot = activeSearchState.resultsRoot;

  // Per-tab search filter — updates the active tab's searchState.
  // Partial updates are merged into the existing tab state.
  const setSearchFilter = useCallback((next: Partial<TabSearchState> | ((prev: TabSearchState) => Partial<TabSearchState>)) => {
    if (!activeTabId) return;
    setTabs(prevTabs =>
      prevTabs.map(t => {
        if (t.id !== activeTabId) return t;
        const prev = t.searchState;
        const resolved = typeof next === "function" ? next(prev) : next;
        return {
          ...t,
          searchState: {
            ...t.searchState,
            ...resolved,
            mode: resolved.mode ?? prev.mode ?? "default",
          },
        };
      })
    );
  }, [activeTabId]);

  useEffect(() => {
    if (!activeTab?.currentPath) {
      setRecursiveSearchItems([]);
      setRecursiveSearchRoot(null);
      setRecursiveSearchDepth(null);
      return;
    }

    const trimmedQuery = searchFilter.query.trim();
    const shouldLoadRecursive = trimmedQuery.length >= 2;
    if (!shouldLoadRecursive) {
      setRecursiveSearchItems([]);
      setRecursiveSearchRoot(null);
      setRecursiveSearchDepth(null);
      return;
    }

    const maxDepth = trimmedQuery.length <= 2 ? 6 : trimmedQuery.length <= 4 ? 12 : 24;

    if (
      recursiveSearchRoot === activeTab.currentPath &&
      recursiveSearchDepth === maxDepth &&
      recursiveSearchItems.length > 0
    ) {
      return;
    }

    let cancelled = false;
    setRecursiveSearchItems([]);
    setRecursiveSearchRoot(activeTab.currentPath);
    setRecursiveSearchDepth(maxDepth);

    const loadRecursiveSearchItems = async () => {
      try {
        const entries = await readDirectoryRecursive(activeTab.currentPath, maxDepth);
        if (cancelled) return;

        const mapped = entries.map(fileEntryToFSItem).map((item) => ({
          ...item,
          isHidden: item.name.startsWith("."),
          tag: (item.tag || storedTags[item.id]) as FSItem["tag"],
        }));
        setRecursiveSearchItems(mapped);
      } catch {
        if (!cancelled) {
          setRecursiveSearchItems([]);
          setRecursiveSearchRoot(null);
          setRecursiveSearchDepth(null);
        }
      }
    };

    void loadRecursiveSearchItems();

    return () => {
      cancelled = true;
    };
  }, [activeTab?.currentPath, searchFilter.query, recursiveSearchDepth, recursiveSearchItems.length, recursiveSearchRoot]);

  const cancelSearch = useCallback(() => {
    if (!activeTabId) return;
    searchRequestIdRef.current += 1;
    setTabs(prevTabs =>
      prevTabs.map(t => {
        if (t.id !== activeTabId) return t;
        return {
          ...t,
          searchState: {
            ...t.searchState,
            results: [],
            resultsCount: 0,
            isSearching: false,
          },
        };
      })
    );
  }, [activeTabId]);

  const executeSearch = useCallback(async (query: string) => {
    const trimmedQuery = query.trim();
    const root = activeTab?.currentPath;
    const tabId = activeTabId;

    searchRequestIdRef.current += 1;
    const requestId = searchRequestIdRef.current;

    if (!trimmedQuery || !root || !tabId) return;

    const storedTags = (() => {
      try {
        const stored = localStorage.getItem("NEXUS_ITEM_TAGS");
        return stored ? JSON.parse(stored) as Record<string, string> : {};
      } catch {
        return {};
      }
    })();

    setTabs(prevTabs =>
      prevTabs.map(t => {
        if (t.id !== tabId) return t;
        return { ...t, searchState: { ...t.searchState, results: [], resultsCount: 0, isSearching: true } };
      })
    );

    const unlisten = await listen<{ requestId: number; batch: FileEntry[]; total: number; done: boolean }>(
      "search-progress",
      (event) => {
        if (event.payload.requestId !== requestId) return;

        const mapBatch = (batch: FileEntry[]) => {
          return batch
            .filter(e => !batch.some((b, i) => i < batch.indexOf(e) && b.path === e.path))
            .map(fileEntryToFSItem)
            .map((item) => ({
              ...item,
              isHidden: item.name.startsWith("."),
              tag: (item.tag || storedTags[item.id]) as FSItem["tag"],
            }));
        };

        if (event.payload.done) {
          setTabs(prevTabs =>
            prevTabs.map(t => {
              if (t.id !== tabId) return t;
              const existingPaths = new Set(t.searchState.results.map((p: FSItem) => p.id));
              const newItems = mapBatch(event.payload.batch).filter((e: FSItem) => !existingPaths.has(e.id));
              return {
                ...t,
                searchState: {
                  ...t.searchState,
                  results: [...t.searchState.results, ...newItems],
                  resultsCount: event.payload.batch.length,
                  isSearching: false,
                },
              };
            })
          );
        } else {
          setTabs(prevTabs =>
            prevTabs.map(t => {
              if (t.id !== tabId) return t;
              const existingPaths = new Set(t.searchState.results.map((p: FSItem) => p.id));
              const newItems = mapBatch(event.payload.batch).filter((e: FSItem) => !existingPaths.has(e.id));
              return {
                ...t,
                searchState: {
                  ...t.searchState,
                  results: [...t.searchState.results, ...newItems],
                  resultsCount: t.searchState.resultsCount + event.payload.batch.length,
                },
              };
            })
          );
        }
      }
    );

    try {
      const maxDepth = trimmedQuery.length <= 2 ? 6 : trimmedQuery.length <= 4 ? 12 : 24;
      await searchFiles(root, trimmedQuery, maxDepth, requestId);
      setTabs(prevTabs =>
        prevTabs.map(t => {
          if (t.id !== tabId) return t;
          return { ...t, searchState: { ...t.searchState, resultsRoot: root } };
        })
      );
    } catch {
      if (requestId !== searchRequestIdRef.current) return;
      setTabs(prevTabs =>
        prevTabs.map(t => {
          if (t.id !== tabId) return t;
          return { ...t, searchState: { ...t.searchState, results: [], resultsRoot: root } };
        })
      );
    } finally {
      if (requestId === searchRequestIdRef.current) {
        setTabs(prevTabs =>
          prevTabs.map(t => {
            if (t.id !== tabId) return t;
            return { ...t, searchState: { ...t.searchState, isSearching: false } };
          })
        );
      }
      void unlisten();
    }
  }, [activeTab?.currentPath, activeTabId]);

  useEffect(() => {
    const trimmedQuery = searchFilter.query.trim();
    if (!trimmedQuery) return;
    // Debounce 500ms before executing — prevents search spam during fast typing.
    // If user clears query mid-typing, the timeout is cleaned up below.
    const timer = window.setTimeout(() => {
      void executeSearch(trimmedQuery);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [searchFilter.query, executeSearch]);

  // ── Space Stats ─────────────────────────────────────────────────────────────
  const getSpaceStats = useCallback((): SpaceStats => {
    const currentPath = activeTab?.currentPath || "";
    
    // Try to get disk space for current path, or fall back to the drive root
    let disk = diskSpaces[currentPath];
    if (!disk && currentPath) {
      // Extract drive letter (e.g., "F:\" from "F:\Test\Folder")
      const driveMatch = currentPath.match(/^([A-Za-z]:\\?)/);
      const driveRoot = driveMatch ? driveMatch[1].toUpperCase() + "\\" : null;
      
      if (driveRoot) {
        // Check if diskSpace exists for this drive
        disk = diskSpaces[driveRoot] || diskSpaces[driveRoot.replace(/\\+$/, "")];
      }
      
      // Fallback: find matching drive from drives list
      if (!disk) {
        const normalizedPath = currentPath.toUpperCase();
        for (const d of drives) {
          const normalizedDrive = d.toUpperCase();
          if (normalizedPath.startsWith(normalizedDrive) || normalizedPath.startsWith(normalizedDrive.replace(/\\/g, "/"))) {
            disk = diskSpaces[d];
            break;
          }
        }
      }
    }
    disk = disk || { total: 0, used: 0, free: 0, path: currentPath };
    const usedBytes = currentFolderEntries.reduce((sum, item) => sum + item.size, 0);

    const typeDistribution: { name: string; value: number; color: string }[] = [];
    const distributions: Record<string, number> = {};

    currentFolderEntries.forEach(item => {
      if (item.type === "directory") return;
      const ext = item.name.split(".").pop()?.toLowerCase() || "";
      const key =
        ["md", "txt", "pdf"].includes(ext) ? "Documents" :
        ["zip", "rar", "tar"].includes(ext) ? "Archives" :
        ["png", "jpg", "jpeg", "gif", "webp"].includes(ext) ? "Images" :
        ["exe", "msi"].includes(ext) ? "Executable" :
        ["log", "json"].includes(ext) ? "System" :
        ["ts", "tsx", "js", "jsx", "html", "css"].includes(ext) ? "SourceCode" : "Other";

      distributions[key] = (distributions[key] || 0) + item.size;
    });

    const colorMap: Record<string, string> = {
      Documents: "#3b82f6", Archives: "#eab308", Images: "#10b981",
      System: "#ef4444", SourceCode: "#8b5cf6", Other: "#6b7280", Executable: "#f97316"
    };

    for (const [name, value] of Object.entries(distributions)) {
      if (value > 0) typeDistribution.push({ name, value, color: colorMap[name] || "#6b7280" });
    }

    return {
      totalBytes: disk.total,
      usedBytes: disk.used,
      availableBytes: disk.free,
      typeDistribution,
      tagsCount: [],
    };
  }, [activeTab, diskSpaces, currentFolderEntries]);

  // ── Computed items for display (current folder contents only) ─────────────
  // Local asset fuzzy search is applied downstream in ExplorerMainPane and should not swap
  // the pane's source list to backend searchResults.
  let displayItems = activeTab?.folderContents && activeTab.folderContents.length > 0
    ? activeTab.folderContents
    : currentFolderEntries;

  if (!showHiddenItems) {
    displayItems = displayItems.filter(item => !item.isHidden);
  }

  // Apply tags from localStorage
  const storedTags = (() => {
    try {
      const stored = localStorage.getItem("NEXUS_ITEM_TAGS");
      return stored ? JSON.parse(stored) as Record<string, string> : {};
    } catch {
      return {};
    }
  })();
  displayItems = displayItems.map(item => ({
    ...item,
    tag: (item.tag || storedTags[item.id]) as FSItem["tag"],
  }));

  const recursiveDisplayItems = (recursiveSearchRoot === activeTab?.currentPath ? recursiveSearchItems : [])
    .filter((item) => showHiddenItems || !item.isHidden)
    .map((item) => ({
      ...item,
      tag: (item.tag || storedTags[item.id]) as FSItem["tag"],
    }));

  const normalizedSearchResults = (searchResultsRoot === activeTab?.currentPath ? searchResults : [])
    .filter((item) => showHiddenItems || !item.isHidden)
    .map((item) => ({
      ...item,
      tag: (item.tag || storedTags[item.id]) as FSItem["tag"],
    }));

  // Sort displayItems (NOT recursive items — they are pre-sorted by backend)
  displayItems = [...displayItems].sort((a, b) => {
    if (a.type === "directory" && b.type === "file") return -1;
    if (a.type === "file" && b.type === "directory") return 1;
    let comparison = 0;
    switch (sortBy) {
      case "name": comparison = a.name.localeCompare(b.name, undefined, { numeric: true }); break;
      case "size": comparison = a.size - b.size; break;
      case "type": comparison = (a.name.split(".").pop() || "").localeCompare(b.name.split(".").pop() || ""); break;
      case "date": comparison = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(); break;
    }
    return sortDirection === "asc" ? comparison : -comparison;
  });

  // ── Persist preferences ──────────────────────────────────────────────────────
  const handleCustomColorPreference = useCallback((color: string) => {
    setAccentColor(color);
    localStorage.setItem("NEXUS_ACCENT_COLOR", color);
  }, []);

  const setCustomAccentColor = useCallback((color: string | null) => {
    setCustomAccentColorState(color);
    if (color === null) {
      localStorage.removeItem("NEXUS_CUSTOM_ACCENT");
    } else {
      localStorage.setItem("NEXUS_CUSTOM_ACCENT", color);
    }
  }, []);

  // Effective accent = custom overrides preset
  const effectiveAccentColor = customAccentColor ?? accentColor;
  const isCustomTheme = customAccentColor !== null;

  const handleCustomViewMode = useCallback((mode: ViewMode) => {
    const clamped = Math.max(1, Math.min(7, Math.round(mode))) as ViewMode;
    setViewMode(clamped);
    // Save global default
    localStorage.setItem("NEXUS_VIEW_MODE", String(clamped));
    // Save per-folder view mode for current path — shared with the Inspector
    // so the two panes stay in sync for the same folder.
    const currentPath = activeTab?.currentPath;
    if (currentPath && !currentPath.startsWith("thispc://") &&
        !currentPath.startsWith("recyclebin://") && !currentPath.startsWith("network://")) {
      setFolderViewMode(currentPath, clamped);
    }
  }, [activeTab?.currentPath]);

  // Listen for view-mode changes coming from the Folder Inspector (same tab).
  // When the Inspector flips the mode for the folder we are currently
  // viewing, mirror it here so the main pane stays in sync without reload.
  useEffect(() => {
    const unsubscribe = subscribeViewModeChange(({ path, mode }) => {
      const currentPath = activeTab?.currentPath;
      if (!currentPath) return;
      if (currentPath === path) {
        setViewMode(mode);
      }
    });
    return unsubscribe;
  }, [activeTab?.currentPath]);

  const togglePinFolder = useCallback((folderId: string) => {
    setPinnedFolderIds(prev => {
      let updated: string[];
      if (prev.includes(folderId)) {
        updated = prev.filter(id => id !== folderId);
        setStatusMessage(language === "vi" ? "Đã bỏ ghim thư mục." : "Folder unpinned.");
      } else {
        updated = [...prev, folderId];
        setStatusMessage(language === "vi" ? "Đã ghim thư mục." : "Folder pinned.");
      }
      localStorage.setItem("NEXUS_PINNED_FOLDERS", JSON.stringify(updated));
      return updated;
    });
  }, [language]);

  const navigationDestinations = (() => {
    const driveSpaceByKey = new Map<string, { used: number; total: number }>();
    Object.entries(diskSpaces).forEach(([key, space]) => {
      if (!space) return;
      driveSpaceByKey.set(key.replace(/[\\/]+$/, "").toUpperCase(), {
        used: Math.round(space.used / (1024 * 1024 * 1024)),
        total: Math.round(space.total / (1024 * 1024 * 1024)),
      });
    });

    const driveDestinations: NavigationDestination[] = drives.map((drive) => {
      const normalizedDriveKey = drive.replace(/[\\/]+$/, "").toUpperCase();
      const space = driveSpaceByKey.get(normalizedDriveKey)
        || driveSpaceByKey.get(drive)
        || diskSpaces[drive];
      return {
        id: `drive:${drive}`,
        label: drive,
        path: drive,
        kind: "drive",
        iconKey: "drive",
        description: language === "vi" ? "Ổ đĩa" : "Drive",
        usedGB: space ? Math.round(space.used / (1024 * 1024 * 1024)) : undefined,
        totalGB: space ? Math.round(space.total / (1024 * 1024 * 1024)) : undefined,
      };
    });

    const specialFolderIconMap: Record<string, NavigationDestination["iconKey"]> = {
      desktop: "desktop",
      documents: "documents",
      downloads: "downloads",
      pictures: "pictures",
      music: "music",
      videos: "videos",
      home: "home",
    };

    const specialDestinations: NavigationDestination[] = Object.entries(specialFolders)
      .filter(([, path]) => Boolean(path))
      .map(([key, path]) => ({
        id: `special:${key}`,
        label: key,
        path,
        kind: "special",
        iconKey: specialFolderIconMap[key.toLowerCase()] || "folder",
        description: language === "vi" ? "Thư mục đặc biệt" : "Special folder",
      }));

    const pinnedDestinations: NavigationDestination[] = pinnedFolderIds.map((path) => ({
      id: `pinned:${path}`,
      label: path.split(/[\\/]/).filter(Boolean).pop() || path,
      path,
      kind: "pinned",
      iconKey: "star",
      description: language === "vi" ? "Đã ghim" : "Pinned",
    }));

    const recentDestinations: NavigationDestination[] = recentPaths.map((path) => ({
      id: `recent:${path}`,
      label: path.split(/[\\/]/).filter(Boolean).pop() || path,
      path,
      kind: "recent",
      iconKey: "clock",
      description: language === "vi" ? "Gần đây" : "Recent",
    }));

    const currentDestination: NavigationDestination[] = activeTab?.currentPath
      ? [{
          id: `current:${activeTab.currentPath}`,
          label: activeTab.currentPath.split(/[\\/]/).filter(Boolean).pop() || activeTab.currentPath,
          path: activeTab.currentPath,
          kind: "current",
          iconKey: "folder",
          description: language === "vi" ? "Thư mục hiện tại" : "Current folder",
        }]
      : [];

    return [
      ...currentDestination,
      ...recentDestinations,
      ...pinnedDestinations,
      ...specialDestinations,
      ...driveDestinations,
    ].filter((destination, index, arr) => arr.findIndex((item) => item.path === destination.path) === index);
  })();

  // ── Return all state & actions ───────────────────────────────────────────────
  return {
    // State
    items: displayItems,         // current display items (folder contents or search results)
    recursiveSearchItems: recursiveDisplayItems,
    tabs,
    activeTab,
    activeTabId,
    setActiveTabId: (tabId: string) => {
      // Sync folder contents when switching tabs
      if (activeTab && activeTab.folderContents.length > 0) {
        setCurrentFolderEntries(activeTab.folderContents);
      }
      setActiveTabId(tabId);
    },
    selectedIds: computedSelectedIds,  // per-tab selection
    setSelectedIds: handleSetSelectedIds,  // per-tab selection setter
    clipboard,
    viewMode,
    setViewMode: handleCustomViewMode,
    sortBy,
    setSortBy,
    sortDirection,
    setSortDirection,
    showHiddenItems,
    setShowHiddenItems: (show: boolean) => {
      // Clear tab cache first to force reload with new showHiddenItems value
      if (activeTabId) {
        setTabs(prevTabs =>
          prevTabs.map(tab =>
            tab.id === activeTabId
              ? { ...tab, folderContents: [] }
              : tab
          )
        );
      }
      setShowHiddenItems(show);
      localStorage.setItem("NEXUS_SHOW_HIDDEN_ITEMS", String(show));
    },
    hideFileExtensions,
    setHideFileExtensions: (hide: boolean) => {
      _setHideFileExtensions(hide);
      localStorage.setItem("NEXUS_HIDE_FILE_EXTENSIONS", String(hide));
    },
    showDeleteConfirmation,
    setShowDeleteConfirmation: (show: boolean) => {
      _setShowDeleteConfirmation(show);
      localStorage.setItem("NEXUS_SHOW_DELETE_CONFIRMATION", String(show));
    },
    accentColor: effectiveAccentColor,
    setAccentColor: handleCustomColorPreference,
    customAccentColor,
    setCustomAccentColor,
    isCustomTheme,
    showSpaceAnalyzer: activeTab?.showSpaceAnalyzer ?? false,
    setShowSpaceAnalyzer: (show: boolean) => {
      if (!activeTabId) return;
      setTabs(prev => prev.map(t => 
        t.id === activeTabId ? { ...t, showSpaceAnalyzer: show } : t
      ));
    },
    // Per-tab right-pane session (inspector + multi-select + details visibility).
    // Each tab maintains an independent session so switching tabs preserves state
    // and panes never bleed across tabs.
    paneSession: activeTab?.paneSession ?? DEFAULT_PANE_SESSION,
    setPaneSession: (
      updater: PaneSession | ((prev: PaneSession) => PaneSession)
    ) => {
      if (!activeTabId) return;
      setTabs(prev =>
        prev.map(t => {
          if (t.id !== activeTabId) return t;
          const current = t.paneSession ?? DEFAULT_PANE_SESSION;
          const next =
            typeof updater === "function"
              ? (updater as (prev: PaneSession) => PaneSession)(current)
              : updater;
          return { ...t, paneSession: next };
        })
      );
    },
    showDetailsPane: activeTab?.paneSession?.showDetailsPane ?? true,
    setShowDetailsPane: (show: boolean) => {
      if (!activeTabId) return;
      setTabs(prev =>
        prev.map(t => {
          if (t.id !== activeTabId) return t;
          const current = t.paneSession ?? DEFAULT_PANE_SESSION;
          return {
            ...t,
            paneSession: { ...current, showDetailsPane: show },
          };
        })
      );
    },
    openFileId,
    setOpenFileId: openFileForEditing,
    openFileContent,
    pinnedFolderIds,
    recentFileIds,
    recentPaths,
    specialFolders,
    navigationDestinations,
    togglePinFolder,
    searchFilter,
    setSearchFilter,
    sidebarOpen,
    setSidebarOpen,
    statusMessage,
    setStatusMessage,
    openWithState,
    setOpenWithState,
    language,
    setLanguage: (lang: "vi" | "en") => {
      _setLanguage(lang);
      localStorage.setItem("NEXUS_LANGUAGE", lang);
      setStatusMessage(lang === "vi" ? "Đã chuyển sang Tiếng Việt." : "Language set to English.");
    },
    searchPaletteOpen: false,
    setSearchPaletteOpen: () => {},
    theme,
    setTheme: (newTheme: "dark" | "light" | "mono") => {
      _setTheme(newTheme);
      localStorage.setItem("NEXUS_THEME", newTheme);
    },
    font,
    setFont: (newFont: "monospace" | "segoeui") => {
      _setFont(newFont);
      localStorage.setItem("NEXUS_FONT", newFont);
    },
    fontSize,
    setFontSize: (size: number) => {
      const clamped = Math.max(100, Math.min(150, size));
      _setFontSize(clamped);
      localStorage.setItem("NEXUS_FONT_SIZE", String(clamped));
    },
    menuBlurOpacity,
    setMenuBlurOpacity: (opacity: number) => {
      const clamped = Math.max(0, Math.min(100, opacity));
      _setMenuBlurOpacity(clamped);
      localStorage.setItem("NEXUS_MENU_BLUR_OPACITY", String(clamped));
    },
    menuBgOpacity,
    setMenuBgOpacity: (opacity: number) => {
      const clamped = Math.max(0, Math.min(100, opacity));
      _setMenuBgOpacity(clamped);
      localStorage.setItem("NEXUS_MENU_BG_OPACITY", String(clamped));
    },
    showFolderSizes,
    setShowFolderSizes: (show: boolean) => {
      _setShowFolderSizes(show);
      localStorage.setItem("NEXUS_SHOW_FOLDER_SIZES", String(show));
    },
    tagSettings,
    setTagSettings,
    // Windows Quick Access
    windowsQuickAccess: {
      items: windowsQuickAccessItems,
      loading: windowsQuickAccessLoading,
      lastSync: windowsQuickAccessLastSync,
      refresh: refreshWindowsQuickAccess,
      pinToQuickAccess,
      unpinFromQuickAccess,
      isInQuickAccess,
      pinToStartMenu,
      unpinFromStartMenu,
    },
    spacing,
    setSpacing: (newSpacing: number) => {
      const clamped = Math.max(30, Math.min(70, newSpacing));
      _setSpacing(clamped);
      localStorage.setItem("NEXUS_SPACING", String(clamped));
    },
    gotoPaletteOpen,
    setGotoPaletteOpen,
    setItems: () => { /* no-op - items are loaded from real FS */ },
    drives,
    driveInfos,
    diskSpaces,
    isLoading,
    isSearching,
    searchResults,
    searchResultsCount,
    executeSearch,
    cancelSearch,
    error,

    // Operations
    navigateTo,
    navigateBack,
    navigateForward,
    navigateUp,
    loadDirectory,
    createFile,
    createFolder,
    deleteItem,
    renameItem,
    copyItems,
    cutItems,
    copySpecificItems,
    cutSpecificItems,
    pasteItems,
    startRenameSelected,
    compressSelectedToZip,
    extractZipArchive,
    moveOrCopyItems,
    updateFileContent,
    openFileForEditing,
    openWithPath,
    preloadOpenWithCandidates,
    browseOpenWithApp,
    confirmOpenWith,
    launchOpenWithApp,
    clearOpenWithPreference,
    closeOpenWithModal,
    getSpaceStats,
    refreshCurrentDirectory,
    refreshDrives,
    createNewTab,
    closeTab,
    openPathInNewTab,
    openFolderInNewTab,
    undoLastOperation,
    redoLastOperation,
    newItemModal,
    setNewItemModal,
    setDiskSpaces,

    // Watched transfer jobs (consumed by App.tsx watcher effect)
    watchedJobIdsRef,
    watchedJobTargetRef,
    watchedJobTabIdRef,
  };
}

export type ExplorerAPI = ReturnType<typeof useExplorer>;
