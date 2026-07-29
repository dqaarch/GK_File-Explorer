import { useState, useEffect, useCallback, useMemo } from "react";
import { FSItem, ExplorerTab, ViewMode, SortBy, SortDirection, TabSearchState } from "./types";
import { readDirectory, fileEntryToFSItem } from "./TauriFileSystem";

interface InspectorExplorerPreferences {
  accentColor: string;
  theme: "dark" | "light" | "mono";
  font: "monospace" | "segoeui";
  fontSize: number;
  spacing: "compact" | "normal" | "spacious";
  language: "vi" | "en";
}

export interface InspectorExplorerAPI {
  items: FSItem[];
  tabs: ExplorerTab[];
  activeTab: ExplorerTab | undefined;
  activeTabId: string;
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  clipboard: { itemIds: string[]; action: null } | { itemIds: string[]; action: "cut" };
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  sortBy: SortBy;
  setSortBy: (by: SortBy) => void;
  sortDirection: SortDirection;
  setSortDirection: (dir: SortDirection) => void;
  accentColor: string;
  theme: "dark" | "light" | "mono";
  font: "monospace" | "segoeui";
  fontSize: number;
  spacing: "compact" | "normal" | "spacious";
  language: "vi" | "en";
  showSpaceAnalyzer: boolean;
  showDetailsPane: boolean;
  sidebarOpen: boolean;
  searchPaletteOpen: boolean;
  gotoPaletteOpen: boolean;
  pinnedFolderIds: string[];
  specialFolders: Record<string, string>;
  drives: string[];
  openFileId: string | null;
  openFileContent: string;
  statusMessage: string;
  searchFilter: TabSearchState;
  isSearching: boolean;
  searchResults: FSItem[];
  error: string | null;

  loadDirectory: (path: string) => void;
  navigateTo: (folderId: string | null) => void;
  navigateBack: () => void;
  navigateForward: () => void;
  navigateUp: () => void;
  createFile: (name: string) => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  renameItem: (id: string, newName: string) => void;
  copyItems: () => void;
  cutItems: () => void;
  pasteItems: () => Promise<void>;
  togglePinFolder: (folderId: string) => void;
  setActiveTabId: (id: string) => void;
  setAccentColor: (color: string) => void;
  setShowSpaceAnalyzer: (show: boolean) => void;
  setShowDetailsPane: (show: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setSearchPaletteOpen: (open: boolean) => void;
  setGotoPaletteOpen: (open: boolean) => void;
  setLanguage: (lang: "vi" | "en") => void;
  setTheme: (theme: "dark" | "light" | "mono") => void;
  setFont: (font: "monospace" | "segoeui") => void;
  setFontSize: (size: number) => void;
  setSpacing: (spacing: "compact" | "normal" | "spacious") => void;
  setSearchFilter: (filter: Partial<TabSearchState>) => void;
  setOpenFileId: (id: string | null) => void;
  setStatusMessage: (msg: string) => void;
  setError: (err: string | null) => void;
  executeSearch: (query: string) => void;
  togglePinFolderAction: (folderId: string) => void;
}

/**
 * Inspector explorer — loads and displays the children of a specific folder.
 * Has its own independent data loading via read_directory.
 */
export function useInspectorExplorer(folderPath: string, preferences: InspectorExplorerPreferences): InspectorExplorerAPI {
  const [folderItems, setFolderItems] = useState<FSItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>(1); // 1 = Extra Large icons
  const [sortBy, setSortBy] = useState<SortBy>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [statusMessage, setStatusMessage] = useState<string>("");

  // Load folder contents when path changes
  useEffect(() => {
    if (!folderPath) {
      setFolderItems([]);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setSelectedIds([]);

    readDirectory(folderPath)
      .then((result) => {
        if (cancelled) return;
        const entries = (result.entries || []).map(fileEntryToFSItem) as FSItem[];
        setFolderItems(entries);
        setIsLoading(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err));
          setFolderItems([]);
          setIsLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [folderPath]);

  // Build fake tab representing the inspected folder
  const tab: ExplorerTab = useMemo(() => ({
    id: "inspector-tab",
    title: folderPath.split(/[\\/]/).pop() || folderPath,
    currentPath: folderPath,
    currentFolderId: folderPath,
    history: [{ folderId: folderPath, path: folderPath }],
    historyIndex: 0,
    selectedIds: [],
    scrollPosition: 0,
    folderContents: [],
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
  }), [folderPath]);

  // Sorted display items
  const items = useMemo(() => {
    return [...folderItems].sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      let comparison = 0;
      switch (sortBy) {
        case "name": comparison = a.name.localeCompare(b.name, undefined, { numeric: true }); break;
        case "size": comparison = a.size - b.size; break;
        case "type": comparison = (a.name.split(".").pop() || "").localeCompare(b.name.split(".").pop() || ""); break;
        case "date": comparison = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(); break;
      }
      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [folderItems, sortBy, sortDirection]);

  // Navigation stubs (double-click handles real navigation)
  const navigateTo = useCallback(() => { setSelectedIds([]); }, []);
  const navigateBack = useCallback(() => {}, []);
  const navigateForward = useCallback(() => {}, []);
  const navigateUp = useCallback(() => {}, []);
  const loadDirectory = useCallback(() => { setSelectedIds([]); }, []);
  const createFile = useCallback(async () => {}, []);
  const createFolder = useCallback(async () => {}, []);
  const deleteItem = useCallback(async (id: string) => {
    setSelectedIds(prev => prev.filter(i => i !== id));
    setFolderItems(prev => prev.filter(item => item.id !== id));
  }, []);
  const renameItem = useCallback(() => {}, []);
  const copyItems = useCallback(() => {}, []);
  const cutItems = useCallback(() => {}, []);
  const pasteItems = useCallback(async () => {}, []);
  const togglePinFolder = useCallback(() => {}, []);

  return {
    items,
    tabs: [tab],
    activeTab: tab,
    activeTabId: "inspector-tab",
    selectedIds,
    setSelectedIds,
    clipboard: { itemIds: [], action: null },
    viewMode,
    setViewMode,
    sortBy,
    setSortBy,
    sortDirection,
    setSortDirection,
    accentColor: preferences.accentColor,
    theme: preferences.theme,
    font: preferences.font,
    fontSize: preferences.fontSize,
    spacing: preferences.spacing,
    language: preferences.language,
    showSpaceAnalyzer: false,
    showDetailsPane: false,
    sidebarOpen: false,
    searchPaletteOpen: false,
    gotoPaletteOpen: false,
    pinnedFolderIds: [],
    specialFolders: {},
    drives: [],
    openFileId: null,
    openFileContent: "",
    statusMessage,
    searchFilter: { query: "", tag: null, typeFilter: null, mode: "default", results: [] as FSItem[], resultsRoot: null, isSearching: false, resultsCount: 0 },
    isSearching: false,
    searchResults: [],
    error,
    loadDirectory,
    navigateTo,
    navigateBack,
    navigateForward,
    navigateUp,
    createFile,
    createFolder,
    deleteItem,
    renameItem,
    copyItems,
    cutItems,
    pasteItems,
    togglePinFolder,
    setActiveTabId: () => {},
    setAccentColor: () => {},
    setShowSpaceAnalyzer: () => {},
    setShowDetailsPane: () => {},
    setSidebarOpen: () => {},
    setSearchPaletteOpen: () => {},
    setGotoPaletteOpen: () => {},
    setLanguage: () => {},
    setTheme: () => {},
    setFont: () => {},
    setFontSize: () => {},
    setSpacing: () => {},
    setSearchFilter: () => {},
    setOpenFileId: () => {},
    setStatusMessage: (msg: string) => { setStatusMessage(msg); },
    setError: (err: string | null) => { setError(err); },
    executeSearch: () => {},
    togglePinFolderAction: () => {},
  };
}
