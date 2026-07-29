import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { useExplorer } from "./useExplorer";
import { DEFAULT_PANE_SESSION } from "./types";
import { readDirectory, fileEntryToFSItem, openPathWithDefaultApp, startTransfer, getSystemAccentColor, listShellExtensions } from "./TauriFileSystem";
import { listen } from "@tauri-apps/api/event";
// Side-effect import: registers the global "thumbnail-cleared" listener
// at app startup so the first file replace is never missed, even before
// the user has selected any file.
import "./hooks/fingerprintStore";
import ExplorerHeader from "./components/ExplorerHeader";
import ExplorerSidebar from "./components/ExplorerSidebar";
import ExplorerMainPane from "./components/ExplorerMainPane";
import ExplorerDetailsPane from "./components/ExplorerDetailsPane";
import SpaceAnalyzerDashboard from "./components/SpaceAnalyzerDashboard";
import FileEditorWindow from "./components/FileEditorWindow";
import GotoPalette from "./components/GotoPalette";
import InspectorWindow from "./components/InspectorWindow";
import MultiSelectInspector from "./components/MultiSelectInspector";
import TransferQueueModal from "./components/TransferQueueModal";
import DeleteConfirmDialog from "./components/DeleteConfirmDialog";
import { useTransfer } from "./contexts/TransferContext";
import { SidebarDragHandle } from "./components/layout/SidebarDragHandle";
import { DetailsDragHandle } from "./components/layout/DetailsDragHandle";
import { DetailsPaneWrapper } from "./components/layout/DetailsPaneWrapper";

export default function App() {
  const explorer = useExplorer();

  // Delete confirmation dialog state
  const [deleteConfirmItems, setDeleteConfirmItems] = useState<{ items: any[]; isPermanent: boolean } | null>(null);

  // Panels widths states (persisted via localStorage so reload keeps the user's choice)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === "undefined") return 240;
    const saved = window.localStorage.getItem("NEXUS_SIDEBAR_WIDTH");
    const parsed = saved ? parseInt(saved, 10) : NaN;
    return Number.isFinite(parsed) ? Math.max(160, Math.min(450, parsed)) : 240;
  });
  const [detailsWidth, setDetailsWidth] = useState(() => {
    if (typeof window === "undefined") return 568;
    const saved = window.localStorage.getItem("NEXUS_DETAILS_WIDTH");
    const parsed = saved ? parseInt(saved, 10) : NaN;
    if (Number.isFinite(parsed)) return Math.max(280, Math.min(window.innerWidth / 2, parsed));
    return Math.max(280, Math.min(window.innerWidth / 2.5, 568));
  });

  // Persist width changes
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("NEXUS_DETAILS_WIDTH", String(Math.round(detailsWidth)));
  }, [detailsWidth]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("NEXUS_SIDEBAR_WIDTH", String(Math.round(sidebarWidth)));
  }, [sidebarWidth]);

  // Sync accent color to CSS variable for selection styles
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Always sync the accent color - CSS will use it based on theme class
    document.documentElement.style.setProperty("--accent-from-user", explorer.accentColor);
    document.documentElement.style.setProperty("--accent-hover-from-user", explorer.accentColor);
    document.documentElement.style.setProperty("--accent-pressed-from-user", explorer.accentColor);
  }, [explorer.accentColor]);

  // Initialize CSS variables on mount (runs once) and every time the value changes.
  // Use useLayoutEffect so the variables are applied before the browser paints,
  // which avoids a visible flash in production/debug Tauri builds where the
  // CSS may otherwise see the fallback (--menu-blur: 0px) for one frame.
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const blurOpacity = explorer.menuBlurOpacity / 100;
    const bgOpacity = explorer.menuBgOpacity / 100;
    document.documentElement.style.setProperty(
      "--menu-blur",
      blurOpacity > 0 ? `${20 * blurOpacity}px` : "0px"
    );
    document.documentElement.style.setProperty(
      "--menu-saturate",
      blurOpacity > 0 ? `${100 + 60 * blurOpacity}%` : "100%"
    );
    document.documentElement.style.setProperty(
      "--menu-bg-opacity",
      String(bgOpacity)
    );
  }, [explorer.menuBlurOpacity, explorer.menuBgOpacity]);

  // Additional sync when theme changes to light
  useEffect(() => {
    if (typeof window === "undefined" || explorer.theme !== "light") return;
    document.documentElement.style.setProperty("--accent-from-user", explorer.accentColor);
    document.documentElement.style.setProperty("--accent-hover-from-user", explorer.accentColor);
    document.documentElement.style.setProperty("--accent-pressed-from-user", explorer.accentColor);
  }, [explorer.theme, explorer.accentColor]);

  // Drag-drop modifier keys tracking (for native drag-drop events)
  const dragModifierRef = useRef({ ctrl: false, shift: false });

  // ── Per-tab pane session (read from active tab) ─────────────────────────────
  const paneSession = explorer.paneSession;
  const folderInspectionPath = paneSession.folderInspectionPath;
  const inspectorSelectedIds = paneSession.inspectorSelectedIds;
  const showMultiSelectInspector = paneSession.showMultiSelectInspector;
  const multiSelectItems = paneSession.multiSelectItems;

  // Ref to store multi-select update function (to avoid stale closures)
  const multiSelectUpdateRef = useRef<((items: any[]) => void) | null>(null);
  const clearMultiSelectRef = useRef<(() => void) | null>(null);

  // Callback to update multi-select inspector (writes to active tab's paneSession)
  const handleMultiSelectChange = useCallback((items: any[]) => {
    if (!explorer.showDetailsPane) {
      explorer.setPaneSession(prev => ({
        ...prev,
        multiSelectItems: [],
        showMultiSelectInspector: false,
      }));
      return;
    }
    explorer.setPaneSession(prev => ({
      ...prev,
      multiSelectItems: items as any,
      showMultiSelectInspector: items.length >= 2,
    }));
  }, [explorer.showDetailsPane, explorer.setPaneSession]);

  const handleClearMultiSelect = useCallback(() => {
    explorer.setPaneSession(prev => ({
      ...prev,
      showMultiSelectInspector: false,
      multiSelectItems: [],
    }));
  }, [explorer.setPaneSession]);

  // Keep refs updated
  useEffect(() => {
    multiSelectUpdateRef.current = handleMultiSelectChange;
  }, [handleMultiSelectChange]);
  useEffect(() => {
    clearMultiSelectRef.current = handleClearMultiSelect;
  }, [handleClearMultiSelect]);

  // Stable callback to close folder inspection (per-tab)
  const closeFolderInspection = useCallback(() => {
    explorer.setPaneSession(prev => ({
      ...prev,
      folderInspectionPath: null,
      inspectorSelectedIds: [],
    }));
  }, [explorer.setPaneSession]);

  // Inspector folder contents loader — keyed on active tab's folderInspectionPath
  // plus an optional `reloadKey`. When the user deletes a child from the
  // inspector's own selection list, we bump this key to force a fresh
  // readDirectory so the stale item disappears immediately.
  const [inspectorFolderItems, setInspectorFolderItems] = useState<any[]>([]);
  const [inspectorReloadKey, setInspectorReloadKey] = useState(0);
  useEffect(() => {
    let disposed = false;

    const loadInspectorFolderItems = async () => {
      if (!folderInspectionPath) {
        setInspectorFolderItems([]);
        return;
      }

      try {
        const listing = await readDirectory(folderInspectionPath);
        if (disposed) return;
        const nextItems = listing.entries.map(fileEntryToFSItem).map(item => ({
          ...item,
          isHidden: item.name.startsWith("."),
        }));
        setInspectorFolderItems(nextItems);
      } catch (error) {
        if (!disposed) {
          console.error("[Inspector] Failed to load folder items:", error);
          setInspectorFolderItems([]);
        }
      }
    };

    void loadInspectorFolderItems();

    return () => {
      disposed = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderInspectionPath, inspectorReloadKey]);

  // When the inspected folder changes within a tab, clear that tab's inspector
  // selection so the multi-select & inspector state don't carry stale ids.
  // Note: the dependency is on `folderInspectionPath` only — switching tabs
  // doesn't re-run this because each tab has its own paneSession value.
  useEffect(() => {
    explorer.setPaneSession(prev => ({
      ...prev,
      inspectorSelectedIds: [],
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderInspectionPath]);

  // Panel focus tracking for Tab navigation
  const mainPaneRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const explorerRef = useRef(explorer);

  // Dragging states
  const [resizing, setResizing] = useState<"sidebar" | "details" | null>(null);

  // ── Responsive layout: detect narrow window to reflow Details pane to bottom ──
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1400
  );
  // Details pane drops below main pane when window is too narrow
  const DETAILS_BREAKPOINT = 1200;
  const isDetailsBelow = windowWidth < DETAILS_BREAKPOINT;
  // Height of bottom-pane when isDetailsBelow
  const [detailsBottomHeight, setDetailsBottomHeight] = useState(350);

  // Virtual shell locations don't have meaningful file properties — Windows
  // Explorer itself hides the Details pane on "This PC" / Network. Mirror
  // that by computing an override that disables the pane when we're parked
  // on one of these locations.
  const currentPath = explorer.activeTab?.currentPath ?? "";
  const isThisPCView = currentPath === "thispc://" || currentPath === "network://";
  const detailsPaneEnabled = explorer.showDetailsPane && !isThisPCView;

  // ── Auto-resize details height when switching to vertical layout (50/50 split) ──
  const prevIsDetailsBelow = useRef(isDetailsBelow);
  useEffect(() => {
    if (isDetailsBelow && !prevIsDetailsBelow.current) {
      // Transitioned from wide → narrow: reset details to 50% of viewport height
      setDetailsBottomHeight(Math.round(window.innerHeight * 0.5));
    }
    prevIsDetailsBelow.current = isDetailsBelow;
  }, [isDetailsBelow]);

  // ── Auto-resize details width when window resizes (wide mode only, not user-dragged) ──
  const isUserDraggingDetails = useRef(false);
  useEffect(() => {
    let rafId: number;
    const handleResize = () => {
      if (!isUserDraggingDetails.current) {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          setDetailsWidth(Math.round(window.innerWidth * 0.38));
          setWindowWidth(window.innerWidth);
        });
      }
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(rafId);
    };
  }, []);

  useEffect(() => {
    explorerRef.current = explorer;
  }, [explorer]);


  // Windows Explorer Keyboard Shortcuts Handler
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const explorerState = explorerRef.current;
      // Avoid triggering logic when typing in input or textareas or when
      // focus is inside a secondary pane that owns its own keyboard handling
      // (kuref windows, transfer queue modals, etc.).
      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          (activeEl as HTMLElement).isContentEditable ||
          activeEl.closest('.kuref-window-container'))
      ) {
        return;
      }

      // 1. Ctrl + K -> Go To Navigation Palette
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        explorerState.setGotoPaletteOpen(true);
        return;
      }

      // 2. Ctrl + C -> Copy selected files
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        explorerState.copyItems();
        return;
      }

      // 3. Ctrl + X -> Cut selected files
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x") {
        e.preventDefault();
        explorerState.cutItems();
        return;
      }

      // 4. Ctrl + V -> Paste copied/cut items
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        e.preventDefault();
        explorerState.pasteItems();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        explorerState.undoLastOperation?.();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        explorerState.redoLastOperation?.();
        return;
      }

      // 5. Ctrl + A -> Select all items in current folder
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        const currentFolderId = explorerState.activeTab?.currentFolderId || null;
        const currentItems = explorerState.items.filter(item => item.parentId === currentFolderId);
        explorerState.setSelectedIds(currentItems.map(item => item.id));
        explorerState.setStatusMessage(
          explorerState.language === "vi" 
            ? `Đã chọn tất cả ${currentItems.length} mục.` 
            : `Selected all ${currentItems.length} items.`
        );
        return;
      }

      // 5b. Ctrl + T -> Open a new tab (home folder)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        explorerState.createNewTab(null);
        return;
      }

      // 6. Delete -> Move selected items to Recycle Bin. The Folder Inspector
      // is read-only (no selection), so we operate only on the MainPane's
      // selection.
      if (e.key === "Delete" && !e.shiftKey) {
        e.preventDefault();
        const idsToDelete = explorerState.selectedIds;
        if (idsToDelete.length > 0) {
          // Check if confirmation is enabled
          if (explorerState.showDeleteConfirmation) {
            // Normalize IDs for comparison (both use forward slashes and no trailing slash)
            const normalizedIds = idsToDelete.map(id => id.replace(/\\/g, "/").replace(/\/+$/, ""));
            const itemsToDelete = explorerState.items.filter(item => {
              const normalizedItemId = item.id.replace(/\\/g, "/").replace(/\/+$/, "");
              return normalizedIds.includes(normalizedItemId);
            });
            setDeleteConfirmItems({ items: itemsToDelete, isPermanent: false });
          } else {
            const count = idsToDelete.length;
            (async () => {
              for (const id of idsToDelete) {
                await explorerState.deleteItem(id, "recycle");
              }
              explorerState.setSelectedIds([]);
            })();
            explorerState.setStatusMessage(
              explorerState.language === "vi"
                ? `Đã chuyển ${count} mục vào Thùng rác.`
                : `Moved ${count} item(s) to Recycle Bin.`
            );
          }
        }
        return;
      }

      // 6.5 Shift+Delete -> Permanently delete selected items.
      if (e.key === "Delete" && e.shiftKey) {
        e.preventDefault();
        const idsToDelete = explorerState.selectedIds;
        if (idsToDelete.length > 0) {
          // Check if confirmation is enabled
          if (explorerState.showDeleteConfirmation) {
            // Normalize IDs for comparison (both use forward slashes and no trailing slash)
            const normalizedIds = idsToDelete.map(id => id.replace(/\\/g, "/").replace(/\/+$/, ""));
            const itemsToDelete = explorerState.items.filter(item => {
              const normalizedItemId = item.id.replace(/\\/g, "/").replace(/\/+$/, "");
              return normalizedIds.includes(normalizedItemId);
            });
            setDeleteConfirmItems({ items: itemsToDelete, isPermanent: true });
          } else {
            const count = idsToDelete.length;
            (async () => {
              for (const id of idsToDelete) {
                await explorerState.deleteItem(id, "permanent");
              }
              explorerState.setSelectedIds([]);
            })();
            explorerState.setStatusMessage(
              explorerState.language === "vi"
                ? `Đã xóa vĩnh viễn ${count} mục.`
                : `Permanently deleted ${count} item(s).`
            );
          }
        }
        return;
      }

      // 7. Ctrl+W -> Close folder inspection pane (per-tab)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        explorerRef.current.setPaneSession(prev => ({
          ...prev,
          folderInspectionPath: null,
          inspectorSelectedIds: [],
          showMultiSelectInspector: false,
          multiSelectItems: [],
        }));
        return;
      }

      // 8. F2 -> Inline rename selected item
      if (e.key === "F2") {
        return;
      }

      // 9. Tab / Shift+Tab -> Navigate between panels (Sidebar, Main, Details)
      if (e.key === "Tab") {
        e.preventDefault();
        const mainPane = mainPaneRef.current;
        const sidebar = sidebarRef.current;
        if (!mainPane) return;

        if (sidebar && document.activeElement === sidebar) {
          mainPane.focus();
        } else if (document.activeElement === mainPane) {
          if (e.shiftKey && sidebar) {
            sidebar.focus();
          } else if (!e.shiftKey) {
            if (explorerState.showDetailsPane) {
              mainPane.blur();
            }
          }
        }
        return;
      }

      // 10. Alt+Arrow -> Navigation history (Alt+Left = Back, Alt+Right = Forward)
      if (e.key === "F5") {
        e.preventDefault();
        explorerState.refreshCurrentDirectory?.();
        return;
      }

      // 11. Ctrl+Space -> Toggle Details Pane
      if (e.ctrlKey && (e.key === " " || e.code === "Space")) {
        e.preventDefault();
        explorerState.setShowDetailsPane(!explorerState.showDetailsPane);
        return;
      }

      // 10. Alt+Arrow -> Navigation history (Alt+Left = Back, Alt+Right = Forward)
      if (e.altKey) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          explorerState.navigateBack?.();
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          explorerState.navigateForward?.();
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          const currentPath = explorerState.activeTab?.currentPath;
          if (currentPath) {
            const parts = currentPath.replace(/\\/g, "/").split("/").filter(Boolean);
            if (parts.length > 1) {
              parts.pop();
              const parentPath = parts.join("/") + "/";
              explorerState.navigateTo(parentPath);
            }
          }
          return;
        }
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, []);

  // ── Mouse X1/X2 side buttons → Back/Forward in active tab's history ──────
  // Registered on `document` in capture phase so the handler fires BEFORE
  // React's synthetic event delegation (which would otherwise start a
  // drag-move on the hovered file/folder via onPointerDown / onDragStart).
  useEffect(() => {
    let x1Down = false;
    let x2Down = false;
    const handleAuxMouseDown = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      const state = explorerRef.current;
      if (!state) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") {
        e.stopImmediatePropagation();
      }
      if (e.button === 3) x1Down = true;
      else x2Down = true;
      (window as unknown as { __gokuAux: GokuAuxState }).__gokuAux.notifyAuxClick();
      if (e.button === 3) {
        state.navigateBack?.();
      } else {
        state.navigateForward?.();
      }
    };
    const handleAuxMouseUp = (e: MouseEvent) => {
      if (e.button === 3) x1Down = false;
      else if (e.button === 4) x2Down = false;
    };
    const handleAuxContextLost = () => {
      x1Down = false;
      x2Down = false;
    };
    type GokuAuxState = {
      isX1Down: () => boolean;
      isX2Down: () => boolean;
      notifyAuxClick: () => void;
    };
    (window as unknown as { __gokuAux: GokuAuxState }).__gokuAux = {
      isX1Down: () => x1Down,
      isX2Down: () => x2Down,
      notifyAuxClick: () => {
        const ev = new CustomEvent("goku:aux-click");
        document.dispatchEvent(ev);
      },
    };
    document.addEventListener("mousedown", handleAuxMouseDown, true);
    document.addEventListener("mouseup", handleAuxMouseUp, true);
    const handleAuxPointerDown = (e: PointerEvent) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") {
          e.stopImmediatePropagation();
        }
      }
    };
    document.addEventListener("pointerdown", handleAuxPointerDown, true);
    window.addEventListener("blur", handleAuxContextLost);

    // Listen for X1/X2 events from Rust Windows hook (WebView2 doesn't send these to JS)
    const unlistenXButton = listen<{ button: number }>("mouse-xbutton", (event) => {
      const state = explorerRef.current;
      if (!state) return;
      (window as unknown as { __gokuAux: GokuAuxState }).__gokuAux.notifyAuxClick();
      if (event.payload.button === 3) {
        state.navigateBack?.();
      } else {
        state.navigateForward?.();
      }
    });

    return () => {
      document.removeEventListener("mousedown", handleAuxMouseDown, true);
      document.removeEventListener("mouseup", handleAuxMouseUp, true);
      document.removeEventListener("pointerdown", handleAuxPointerDown, true);
      window.removeEventListener("blur", handleAuxContextLost);
      delete (window as unknown as { __gokuAux?: GokuAuxState }).__gokuAux;
      unlistenXButton.then(fn => fn());
    };
  }, []);

  // ── Track modifier keys for native drag-drop (so Shift/Ctrl are known when drop happens) ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Ctrl") dragModifierRef.current.ctrl = true;
      if (e.key === "Shift") dragModifierRef.current.shift = true;
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Ctrl") dragModifierRef.current.ctrl = false;
      if (e.key === "Shift") dragModifierRef.current.shift = false;
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  // ── Handle native file drag-drop from OS (Tauri drag-drop events with real file paths) ──
  useEffect(() => {
    let disposed = false;
    let unlistenDrop: (() => void) | null = null;
    let unlistenDragEnter: (() => void) | null = null;
    let unlistenDragLeave: (() => void) | null = null;

    const setupListeners = async () => {
      try {
        unlistenDrop = await listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
          console.log("[tauri://drag-drop] event received:", event.payload);
          if (disposed) return;
          const paths = event.payload?.paths ?? [];
          console.log("[tauri://drag-drop] paths:", paths);
          if (paths.length === 0) return;

          const { ctrl, shift } = dragModifierRef.current;
          console.log("[tauri://drag-drop] ctrl:", ctrl, "shift:", shift);
          const currentPath = explorerRef.current.activeTab?.currentPath;
          console.log("[tauri://drag-drop] currentPath:", currentPath);
          if (!currentPath) return;

          // Shift + drop = open files with default app
          if (shift) {
            for (const filePath of paths) {
              try {
                await openPathWithDefaultApp(filePath);
              } catch (err) {
                explorerRef.current.setStatusMessage(
                  `Failed to open: ${filePath} — ${err}`
                );
              }
            }
            return;
          }

          // Ctrl + drop = move files into current directory
          if (ctrl) {
            try {
              const { job_id } = await startTransfer(
                paths,
                currentPath,
                "move",
              );
              const tabId = explorerRef.current.activeTabId;
              if (tabId) {
                explorerRef.current.watchedJobIdsRef.current.add(job_id);
                explorerRef.current.watchedJobTargetRef.current.set(
                  job_id,
                  currentPath,
                );
                explorerRef.current.watchedJobTabIdRef.current.set(
                  job_id,
                  tabId,
                );
              }
              explorerRef.current.setStatusMessage(
                explorerRef.current.language === "vi"
                  ? `Đang di chuyển ${paths.length} mục...`
                  : `Moving ${paths.length} item(s)...`,
              );
            } catch (err) {
              explorerRef.current.setStatusMessage(`Move error: ${err}`);
            }
            return;
          }

          // Default = copy files into current directory
          if (paths.length > 0) {
            try {
              const { job_id } = await startTransfer(
                paths,
                currentPath,
                "copy",
              );
              const tabId = explorerRef.current.activeTabId;
              if (tabId) {
                explorerRef.current.watchedJobIdsRef.current.add(job_id);
                explorerRef.current.watchedJobTargetRef.current.set(
                  job_id,
                  currentPath,
                );
                explorerRef.current.watchedJobTabIdRef.current.set(
                  job_id,
                  tabId,
                );
              }
              explorerRef.current.setStatusMessage(
                explorerRef.current.language === "vi"
                  ? `Đang sao chép ${paths.length} mục...`
                  : `Copying ${paths.length} item(s)...`,
              );
            } catch (err) {
              explorerRef.current.setStatusMessage(`Copy error: ${err}`);
            }
          }
        });

        // Reset modifier flags on drag leave to avoid stale state
        unlistenDragEnter = await listen("tauri://drag-enter", () => {
          // nothing needed, flags reset on keyup
        });
        unlistenDragLeave = await listen("tauri://drag-leave", () => {
          dragModifierRef.current.ctrl = false;
          dragModifierRef.current.shift = false;
        });
      } catch (e) {
        // Tauri drag-drop events may not be available in dev mode or all platforms
      }
    };

    setupListeners();
    return () => {
      disposed = true;
      unlistenDrop?.();
      unlistenDragEnter?.();
      unlistenDragLeave?.();
    };
  }, []);

  // Track if this is the initial mount (to avoid closing inspector on startup)
  const isInitialMount = useRef(true);
  const previousMainPath = useRef<string | null>(null);

  // ── Close Inspector Window #2 when main explorer navigates (back, up, breadcrumb, double-click into folder) ──
  useEffect(() => {
    const mainPath = explorer.activeTab?.currentPath;
    if (!mainPath) return;

    // Skip the initial mount
    if (isInitialMount.current) {
      isInitialMount.current = false;
      previousMainPath.current = mainPath;
      return;
    }

    // Only close inspector if main explorer actually navigated to a DIFFERENT folder
    // (not when we just opened the inspector)
    if (mainPath !== previousMainPath.current) {
      previousMainPath.current = mainPath;
      if (folderInspectionPath) {
        explorer.setPaneSession(prev => ({
          ...prev,
          folderInspectionPath: null,
          inspectorSelectedIds: [],
          showMultiSelectInspector: false,
          multiSelectItems: [],
        }));
      }
    }
  }, [explorer.activeTab?.currentPath]);

  // ── Watcher: refresh the active tab when a tracked transfer job ──
  // ── transitions to a terminal state.                               ──
  const { jobs: transferJobs } = useTransfer();
  useEffect(() => {
    // For each job we previously recorded, check its current status.
    // When it reaches a terminal state, refresh the tab that owned
    // the transfer and stop watching it.
    for (const job of transferJobs) {
      const isTerminal =
        job.status === "completed" ||
        job.status === "cancelled" ||
        job.status === "failed" ||
        job.status === "partial_success";
      if (!isTerminal) continue;
      if (!explorer.watchedJobIdsRef.current.has(job.id)) continue;

      const target = explorer.watchedJobTargetRef.current.get(job.id);
      const tabId = explorer.watchedJobTabIdRef.current.get(job.id);
      if (target && tabId) {
        // Only refresh if the tab is still the same and pointing at the
        // same target. The user may have navigated away.
        const tab = explorer.tabs.find((t) => t.id === tabId);
        if (tab && tab.currentPath === target) {
          void explorer.loadDirectory(target, tabId);
          if (
            job.status === "completed" ||
            job.status === "partial_success"
          ) {
            // Select the newly created top-level items so the user
            // sees what was added.
            explorer.setSelectedIds([...job.source_paths].map((src) => {
              const name = src.split(/[\\/]/).pop() || src;
              return target.replace(/\\/g, "/").replace(/\/+$/, "") +
                "/" +
                name;
            }));
          }
        }
      }

      explorer.watchedJobIdsRef.current.delete(job.id);
      explorer.watchedJobTargetRef.current.delete(job.id);
      explorer.watchedJobTabIdRef.current.delete(job.id);
    }
  }, [transferJobs, explorer]);

  // Handle panel scaling
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizing) return;
      if (resizing === "sidebar") {
        const newWidth = Math.max(160, Math.min(450, e.clientX));
        setSidebarWidth(newWidth);
      } else if (resizing === "details") {
        if (isDetailsBelow) {
          const bottomOffset = window.innerHeight - e.clientY;
          // Reserve at least 150px for main pane on top
          const maxAllowed = Math.max(150, window.innerHeight - 150 - 50);
          setDetailsBottomHeight(Math.max(150, Math.min(maxAllowed, bottomOffset)));
        } else {
          const rightOffset = window.innerWidth - e.clientX;
          setDetailsWidth(Math.max(180, Math.min(window.innerWidth * 0.5, rightOffset)));
        }
      }
    };

    const handleMouseUp = () => {
      isUserDraggingDetails.current = false;
      setResizing(null);
    };

    if (resizing) {
      if (resizing === "details") {
        isUserDraggingDetails.current = true;
      }
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [resizing, isDetailsBelow]);

  const theme = explorer.theme;
  
  // No theme background class — let CSS variable --app-bg show through on body
  let themeBgClass = "";

  const scale = explorer.fontSize / 100;

  return (
    <div
      className={`flex flex-col h-screen w-screen overflow-hidden select-none antialiased ${themeBgClass} theme-${theme}`}
      style={{
        fontFamily: explorer.font === "monospace" ? '"JetBrains Mono", Consolas, Courier, monospace' : '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif',
        fontSize: `calc(11px * ${scale})`
      }}
    >
      <style>{`
        /* Dynamic proportional font size scaling globally using css variables */
        :root, body, #root, [class*="theme-"] {
          --text-xs: calc(12px * ${scale}) !important;
          --text-sm: calc(14px * ${scale}) !important;
          --text-base: calc(16px * ${scale}) !important;
          --text-lg: calc(18px * ${scale}) !important;
          --text-xl: calc(20px * ${scale}) !important;
          --text-2xl: calc(24px * ${scale}) !important;
          --text-3xl: calc(30px * ${scale}) !important;
        }

        .text-[8px] { font-size: calc(8px * ${scale}) !important; }
        .text-[9px] { font-size: calc(9px * ${scale}) !important; }
        .text-[10px] { font-size: calc(10px * ${scale}) !important; }
        .text-[11px] { font-size: calc(11px * ${scale}) !important; }
        .text-[12px] { font-size: calc(12px * ${scale}) !important; }
        .text-[13px] { font-size: calc(13px * ${scale}) !important; }
        .text-[14px] { font-size: calc(14px * ${scale}) !important; }
        .text-[15px] { font-size: calc(15px * ${scale}) !important; }
        .text-[16px] { font-size: calc(16px * ${scale}) !important; }
        
        .text-xs { font-size: calc(12px * ${scale}) !important; }
        .text-sm { font-size: calc(14px * ${scale}) !important; }
        .text-base { font-size: calc(16px * ${scale}) !important; }
        .text-lg { font-size: calc(18px * ${scale}) !important; }
        .text-xl { font-size: calc(20px * ${scale}) !important; }
        .text-2xl { font-size: calc(24px * ${scale}) !important; }

        /* General element elements and inputs font-size mapping */
        input, select, textarea, button, p, span, div, a {
          font-size: inherit;
        }
        
        /* Apply system font choice 100% globally */
        * {
          font-family: ${
            explorer.font === "monospace" 
              ? '"JetBrains Mono", monospace' 
              : '"Segoe UI", "Segoe UI Web (West European)", -apple-system, BlinkMacSystemFont, sans-serif'
          } !important;
        }

        /* Mono Theme: Greyscale only */
        .theme-mono {
          filter: grayscale(100%);
        }

        /* ============================================================
           THEME BACKGROUND VARIABLES
           Centralized so changing the theme updates every surface at
           once instead of editing each component individually.
           ============================================================ */
        :root, body, #root, [class*="theme-"] {
          --bg-app-from: #1f1f1f;
          --bg-app-via: #1f1f1f;
          --bg-app-to: #1f1f1f;

          /* ── Neutral Backgrounds (Windows 11 File Explorer dark mode) ─── */
          /* bg-1: Base layer - App shell */
          --bg-1: #1f1f1f;
          /* bg-2: Secondary - Sidebar, panels */
          --bg-2: #252525;
          /* bg-3: Tertiary - Cards, elevated surfaces */
          --bg-3: #2d2d2d;
          /* bg-4: Highest elevation - modals, floating panels */
          --bg-4: #353535;
          /* bg-5: Deepest - overlays, drawer backs */
          --bg-5: #181818;
          /* bg-6: Row hover */
          --bg-6: #383838;

          /* ── Foreground (Text) ─────────────────────────────── */
          /* Single unified text color: pure white. */
          /* Secondary/muted text uses opacity 0.8 (see utility classes below). */
          --fg-1: #ffffff;
          --fg-2: #ffffff;
          --fg-3: #ffffff;
          --fg-disabled: #666666;
          /* bg-4: Deep - Dropdowns, popovers */
          --bg-4: #383838;
          /* bg-5: Deepest - Media viewer */
          --bg-5: #0a0a0a;
          /* bg-6: Hover surface */
          --bg-6: #404040;

          /* ── Scrollbar (Windows 11 style - semi-transparent) ─── */
          --scrollbar-thumb: rgba(255, 255, 255, 0.4);
          --scrollbar-thumb-hover: rgba(255, 255, 255, 0.6);
          --scrollbar-track: transparent;

          /* ── Foreground (Text) ─────────────────────────────── */
          /* Single unified text color: pure white. */
          /* Secondary/muted text uses opacity 0.8 (see utility classes below). */
          --fg-1: #ffffff;
          --fg-2: #ffffff;
          --fg-3: #ffffff;
          --fg-disabled: #666666;

          /* ── Stroke/Border Colors ────────────────────────── */
          --stroke-1: #404040;
          --stroke-2: #4a4a4a;
          --stroke-3: #5a5a5a;

          /* ── Accent Colors ────────────────────────────────────────── */
          --accent-primary: #60cdff;
          --accent-hover: #8ad4ff;
          --accent-pressed: #4bc1ff;

          /* ── Checkerboard for image/video preview ────────────────── */
          --checkerboard-primary: #1a1a1a;
          --checkerboard-secondary: #252525;

          /* Surfaces — main panels (Windows 11 File Explorer style) */
          --bg-surface-1: #1f1f1f;   /* toolbar / sidebar base */
          --bg-surface-2: #2a2a2a;   /* dropdowns, popovers */
          --bg-surface-3: #252525;   /* breadcrumbs */
          --bg-surface-4: #1f1f1f;   /* sub-toolbar (above list) */
          --bg-surface-5: #222222;   /* sub-toolbar 2 */
          --bg-surface-6: #1f1f1f;   /* tab strip */
          --bg-surface-7: #1a1a1a;   /* bottom toolbar */
          --bg-surface-8: #181818;   /* toolbar inner */

          /* Content areas (file lists, details pane) */
          --bg-content-1: #1f1f1f;   /* list container */
          --bg-content-2: #1f1f1f;   /* details container */
          --bg-content-3: #2a2a2a;   /* item hover */
          --bg-content-4: #252525;   /* details header */

          /* Preview pane backgrounds */
          --bg-preview-1: #2a2a3a;   /* main preview */
          --bg-preview-2: #111111;   /* image sequence */
          --bg-preview-3: #151515;   /* detail content */
          --bg-preview-4: #07070a;   /* pixel-large preview */
          --bg-preview-5: #0e0e14;   /* pixel-small preview */

          /* Modal/dialog overlays */
          --bg-overlay-1: #121216;   /* tooltips, drag ghosts */
          --bg-overlay-2: #121217;   /* dropdowns */
          --bg-overlay-3: #101015;   /* search results */
          --bg-overlay-4: #16161a;   /* context menu */

          /* Player chrome (video/image-sequence controls) */
          --bg-player-bg: #1e1e1e;
          --bg-player-chip: #111;
          --bg-player-chip-border: #333;
          --bg-player-chip-hover: #222;
          --bg-player-elevated: #141414ee;
        }

        /* Note: .theme-light removed — Light Window theme is no longer supported. */

        .theme-light {
          /* ── App Background (fix Space Analyzer in light theme) ────────── */
          --app-bg: #ffffff;
          --app-bg-rgb: 255, 255, 255;
          --row-bg: #f5f5f5;

          /* ── Neutral Backgrounds ─────────────────────────────────── */
          --bg-1: #ffffff;
          --bg-2: #f5f5f5;
          --bg-3: #f0f0f0;
          --bg-4: #ebebeb;
          --bg-5: #e5e5e5;
          --bg-6: #fafafa;

          /* ── Neutral Foregrounds ─────────────────────────────────── */
          --fg-1: #000000;
          --fg-2: #1a1a1a;
          --fg-3: #4a4a4a;
          --fg-disabled: #a0a0a0;

          /* ── Strokes ─────────────────────────────────────────────── */
          --stroke-1: #858585;
          --stroke-2: #9a9a9a;
          --stroke-3: #b0b0b0;

          /* ── Accent Colors (keep original accent) ────────────────── */
          --accent-primary: var(--accent-from-user);
          --accent-hover: var(--accent-hover-from-user);
          --accent-pressed: var(--accent-pressed-from-user);

          /* ── Checkerboard ─────────────────────────────────────────── */
          --checkerboard-primary: #e0e0e0;
          --checkerboard-secondary: #f0f0f0;

          /* ── Legacy surface aliases ──────────────────────────────── */
          --bg-app-from: #ffffff;
          --bg-app-via: #f8f8f8;
          --bg-app-to: #f0f0f0;

          --bg-surface-1: #f5f5f5;
          --bg-surface-2: #ffffff;
          --bg-surface-3: #f8f8f8;
          --bg-surface-4: #f0f0f0;
          --bg-surface-5: #fafafa;
          --bg-surface-6: #f5f5f5;
          --bg-surface-7: #ffffff;
          --bg-surface-8: #f8f8f8;

          --bg-content-1: #ffffff;
          --bg-content-2: #f5f5f5;
          --bg-content-3: #f8f8f8;
          --bg-content-4: #f0f0f0;

          --bg-preview-1: #f5f5f5;
          --bg-preview-2: #ffffff;
          --bg-preview-3: #f8f8f8;
          --bg-preview-4: #ffffff;
          --bg-preview-5: #fafafa;

          --bg-overlay-1: #ffffff;
          --bg-overlay-2: #f5f5f5;
          --bg-overlay-3: #f8f8f8;
          --bg-overlay-4: #ffffff;

          --bg-player-bg: #f5f5f5;
          --bg-player-chip: #ffffff;
          --bg-player-chip-border: #d0d0d0;
          --bg-player-chip-hover: #e8e8e8;
          --bg-player-elevated: #ffffffdd;
        }

        /* Light theme: Override Tailwind text colors */
        .theme-light,
        .theme-light body,
        .theme-light #root {
          color-scheme: light;
        }

        .theme-light {
          /* Override all stone/neutral text colors to dark */
          color: #1a1a1a;
        }

        .theme-light .text-stone-50 { color: #000000 !important; font-weight: 500 !important; }
        .theme-light .text-stone-100 { color: #000000 !important; font-weight: 500 !important; }
        .theme-light .text-stone-200 { color: #000000 !important; font-weight: 500 !important; }
        .theme-light .text-stone-300 { color: #1a1a1a !important; font-weight: 500 !important; }
        .theme-light .text-stone-400 { color: #1a1a1a !important; font-weight: 500 !important; }
        .theme-light .text-stone-500 { color: #1a1a1a !important; font-weight: 500 !important; }
        .theme-light .text-stone-600 { color: #1a1a1a !important; font-weight: 500 !important; }
        .theme-light .text-stone-700 { color: #000000 !important; font-weight: 500 !important; }
        .theme-light .text-stone-800 { color: #000000 !important; font-weight: 500 !important; }
        .theme-light .text-white { color: #000000 !important; font-weight: 500 !important; }

        /* Override Tailwind gray/neutral text classes */
        .theme-light .text-gray-50,
        .theme-light .text-gray-100,
        .theme-light .text-gray-200,
        .theme-light .text-gray-300 { color: #000000 !important; font-weight: 500 !important; }
        .theme-light .text-gray-400 { color: #1a1a1a !important; font-weight: 500 !important; }
        .theme-light .text-gray-500 { color: #1a1a1a !important; font-weight: 500 !important; }

        .theme-light .text-neutral-50,
        .theme-light .text-neutral-100,
        .theme-light .text-neutral-200,
        .theme-light .text-neutral-300 { color: #000000 !important; font-weight: 500 !important; }
        .theme-light .text-neutral-400 { color: #1a1a1a !important; font-weight: 500 !important; }
        .theme-light .text-neutral-500 { color: #1a1a1a !important; font-weight: 500 !important; }

        /* Icon colors */
        .theme-light .text-stone-300,
        .theme-light .text-stone-400,
        .theme-light .text-stone-500 { color: #1a1a1a !important; font-weight: 500 !important; }

        /* Selection text should be dark in light mode */
        .theme-light ::selection {
          background-color: rgba(0, 0, 0, 0.15);
          color: #1a1a1a;
        }

        /* Scrollbar for light mode */
        .theme-light * {
          scrollbar-color: rgba(0, 0, 0, 0.2) transparent;
        }

        /* Light theme: Selected item styling */
        .theme-light .goku-layer-3-selected,
        .theme-light .goku-layer-3-selected.goku-layer-3-selected {
          background-color: var(--surface-bg) !important;
          color: #000000 !important;
          border-color: var(--accent-from-user) !important;
        }

        /* Light theme: File item selection */
        .theme-light .file-item-selectable.selected,
        .theme-light .file-item-selectable[style*="goku-layer-3-selected"] {
          background-color: var(--surface-bg) !important;
          color: #000000 !important;
          border: 1px solid var(--accent-from-user) !important;
        }

        /* Light theme: Override !text-white to black */
        .theme-light .\!text-white {
          color: #000000 !important;
        }

        .theme-light .text-white {
          color: #000000 !important;
        }

        /* Light theme: Row/item hover and selection backgrounds */
        .theme-light .hover\:bg-white\/5:hover,
        .theme-light [class*="hover:bg-white"]:hover {
          background-color: rgba(0, 0, 0, 0.05) !important;
        }

        .theme-light .bg-white\/5,
        .theme-light .bg-white\/10,
        .theme-light .bg-white\/8,
        .theme-light [class*="bg-white/"] {
          background-color: rgba(0, 0, 0, 0.05) !important;
        }

        /* Light theme: Border overrides for selection */
        .theme-light .border-white\/5,
        .theme-light .border-white\/10,
        .theme-light .border-white\/15 {
          border-color: #858585 !important;
        }

        /* Light theme: Icon color overrides (folder/file icons) */
        .theme-light .text-amber-400 {
          color: #fbbf24 !important;
        }

        .theme-light .text-emerald-400 {
          color: #10b981 !important;
        }

        .theme-light .text-rose-400 {
          color: #f43f5e !important;
        }

        .theme-light .text-blue-400 {
          color: #3b82f6 !important;
        }

        /* Light theme: Selection item with accent background fill (like Windows Explorer) */
        .theme-light .selection-item {
          background-color: color-mix(in srgb, var(--accent-from-user) 25%, transparent) !important;
          color: #000000 !important;
          border: 1px solid var(--accent-from-user) !important;
          font-weight: 500 !important;
        }

        /* Light theme: Selected text color */
        .theme-light .selection-item span,
        .theme-light .selection-item div {
          color: #000000 !important;
          font-weight: 500 !important;
        }

        /* Light theme: File item selected in grid view */
        .theme-light .file-item-selectable.selection-item {
          background-color: color-mix(in srgb, var(--accent-from-user) 25%, transparent) !important;
        }

        /* Light theme: Row selected background in list view */
        .theme-light .goku-layer-3-selected.selection-item {
          background-color: color-mix(in srgb, var(--accent-from-user) 20%, transparent) !important;
        }

        /* Light theme: Text selection highlight */
        .theme-light ::selection {
          background-color: color-mix(in srgb, var(--accent-from-user) 30%, transparent);
          color: #000000;
        }

        /* Light theme: File item text - make all text bold */
        .theme-light .file-item-selectable {
          color: #000000 !important;
          font-weight: 500 !important;
        }

        .theme-light .file-item-selectable span,
        .theme-light .file-item-selectable div {
          color: #000000 !important;
          font-weight: 500 !important;
        }

        /* Light theme: Rename input text */
        .theme-light input.bg-overlaytext-white,
        .theme-light .bg-overlaytext-white {
          background-color: var(--surface-bg) !important;
          color: #000000 !important;
        }

        /* Light theme: Drag ghost */
        .theme-light .pointer-events-none.fixed.z-\[100\] {
          background-color: var(--surface-bg) !important;
          color: #000000 !important;
          border-color: var(--accent-from-user) !important;
        }

        /* Light theme: Override hardcoded white text */
        .theme-light [style*="text-white"],
        .theme-light [class*="text-white"] {
          color: #000000 !important;
        }

        /* Light theme: File item text - make unselected text visible */
        .theme-light .file-item-selectable {
          color: #000000 !important;
        }

        .theme-light .file-item-selectable span,
        .theme-light .file-item-selectable div {
          color: #000000 !important;
        }

        /* Light theme: Unselected row text */
        .theme-light .text-stone-600,
        .theme-light .text-stone-700,
        .theme-light .text-stone-800 {
          color: #000000 !important;
        }

        /* Dark theme: Selected/hover text should be WHITE (not dark) */
        .theme-dark .selection-item,
        .theme-dark .selection-item span,
        .theme-dark .selection-item div,
        .theme-dark .file-item-selectable.selected,
        .theme-dark .file-item-selectable.selected span,
        .theme-dark .file-item-selectable.selected div,
        .theme-dark .goku-layer-3-selected,
        .theme-dark .goku-layer-3-selected span,
        .theme-dark .goku-layer-3-selected div {
          color: #ffffff !important;
        }

        /* Light theme: Settings panel text colors (for portal-rendered settings dropdown) */
        /* Use a data attribute to scope light theme styles to the settings portal */
        [data-theme="light"] .text-stone-200,
        [data-theme="light"] .text-stone-300,
        [data-theme="light"] .text-stone-400,
        [data-theme="light"] .text-stone-500 {
          color: #1a1a1a !important;
        }

        /* Light theme: Override !text-white to black */
        [data-theme="light"] .\!text-white,
        [data-theme="light"] .text-white {
          color: #000000 !important;
        }

        /* ── Light Theme: 3D Model Viewer Fix ───────────────────────────── */
        /* 3D viewer has a dark gray canvas, force all toolbar UI to white */
        .theme-light [class*="ThreeDModelViewer"] button,
        .theme-light .bg-\[\\#3f3f3f\] button,
        .theme-light [class*="bg-\\[\\#3f3f3f\\]"] button,
        .theme-light [class*="bg-\\[\\#3f3f3f\\]"] .w-px {
          color: #ffffff !important;
        }
        .theme-light .bg-\[\\#3f3f3f\] .text-stone-400 {
          color: #d4d4d4 !important;
        }
        .theme-light [class*="bg-\\[\\#3f3f3f\\]"] .text-stone-400 {
          color: #d4d4d4 !important;
        }

        /* ── Light Theme: EXR Sequence Timeline Scrub Line ────────────── */
        /* Force the timeline scrub line to black in light theme */
        .theme-light .timeline-scrub-line {
          background-color: #000000 !important;
        }

        /* ── Dark Theme: EXR Sequence Timeline Scrub Line ──────────────── */
        /* Force the timeline scrub line to bright color in dark theme so it's visible */
        .theme-dark .timeline-scrub-line {
          background-color: #ffffff !important;
          box-shadow: 0 0 4px rgba(0, 0, 0, 0.8) !important;
        }

        /* ── Image Sequence Player Header Text Color (theme-aware) ────── */
        /* Light theme: dark text. Dark theme: light text. */
        .theme-light .theme-aware-header,
        .theme-light .theme-aware-header-text {
          color: #1c1c1c !important;
        }
        .theme-light .theme-aware-meta {
          color: #444444 !important;
        }
        .theme-dark .theme-aware-header,
        .theme-dark .theme-aware-header-text {
          color: #f5f5f4 !important;
        }
        .theme-dark .theme-aware-meta {
          color: #d6d3d1 !important;
        }

        /* ── Theme-aware icon color (used by eye dropper, etc.) ───────── */
        .theme-light .theme-aware-icon {
          color: #000000 !important;
        }
        .theme-dark .theme-aware-icon {
          color: #f5f5f4 !important;
        }

        /* ── Light Theme: Range Slider Track Fix ─────────────────────── */
        /* Make slider track visible in light theme (dark track) */
        .theme-light input[type="range"] {
          accent-color: var(--accent-from-user) !important;
        }
        .theme-light input[type="range"]::-webkit-slider-runnable-track {
          background: #b0b0b0 !important;
          height: 4px !important;
          border-radius: 2px !important;
        }
        .theme-light input[type="range"]::-webkit-slider-thumb {
          background: var(--accent-from-user) !important;
          width: 16px !important;
          height: 16px !important;
          margin-top: -6px !important;
          border-radius: 50% !important;
          border: none !important;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3) !important;
        }
        .theme-light input[type="range"]::-moz-range-track {
          background: #b0b0b0 !important;
          height: 4px !important;
          border-radius: 2px !important;
        }
        .theme-light input[type="range"]::-moz-range-thumb {
          background: var(--accent-from-user) !important;
          width: 16px !important;
          height: 16px !important;
          border-radius: 50% !important;
          border: none !important;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3) !important;
        }

        /* ── Light Theme: Hover Background Fix ──────────────────────── */
        /* Change hover from bg-white/5 (lightens in light bg) to bg-black/10 (darkens) */
        .theme-light .hover\:bg-white\/5:hover {
          background-color: rgba(0, 0, 0, 0.1) !important;
        }
        .theme-light [class*="hover:bg-white/5"]:hover {
          background-color: rgba(0, 0, 0, 0.1) !important;
        }

        /* ── Light Theme: Border Visibility Fix ───────────────────────────── */
        /* These rules ensure borders are visible in light theme (#858585) */
        .theme-light .border-white,
        .theme-light .border-white\/0,
        .theme-light .border-white\/5,
        .theme-light .border-white\/10,
        .theme-light .border-white\/15,
        .theme-light .border-white\/20,
        .theme-light .border-white\/25,
        .theme-light .border-white\/30,
        .theme-light .border-white\/40,
        .theme-light .border-white\/50,
        .theme-light .border-white\/75,
        .theme-light .border-slate-50,
        .theme-light .border-slate-100,
        .theme-light .border-gray-50,
        .theme-light .border-gray-100,
        .theme-light .border-stone-50,
        .theme-light .border-stone-100,
        .theme-light .border-neutral-50,
        .theme-light .border-neutral-100,
        .theme-light .border-zinc-50,
        .theme-light .border-zinc-100 {
          border-color: rgba(133, 133, 133, 0.8) !important;
        }

        /* Light theme: Override all border colors to rgba(133,133,133,0.8) for visibility */
        .theme-light [class*="border-"] {
          border-color: rgba(133, 133, 133, 0.8) !important;
        }

        /* But restore specific border colors that should stay light */
        .theme-light .border-transparent {
          border-color: transparent !important;
        }

        .theme-light .border-current {
          border-color: currentColor !important;
        }

        .theme-mono {
          /* ── Neutral Backgrounds ─────────────────────────────────── */
          --bg-1: #1a1a1a;
          --bg-2: #141414;
          --bg-3: #0f0f0f;
          --bg-4: #0a0a0a;
          --bg-5: #000000;
          --bg-6: #252525;

          /* ── Neutral Foregrounds ─────────────────────────────────── */
          --fg-1: #e5e5e5;
          --fg-2: #a8a8a8;
          --fg-3: #707070;
          --fg-disabled: #404040;

          /* ── Strokes ─────────────────────────────────────────────── */
          --stroke-1: #2d2d2d;
          --stroke-2: #3a3a3a;
          --stroke-3: #4a4a4a;

          /* ── Accent Colors (Neutral gray) ─────────────────────────── */
          --accent-primary: #888888;
          --accent-hover: #999999;
          --accent-pressed: #777777;

          /* ── Checkerboard ─────────────────────────────────────────── */
          --checkerboard-primary: #1a1a1a;
          --checkerboard-secondary: #222222;

          /* ── Legacy surface aliases ──────────────────────────────── */
          --bg-app-from: #1a1a1a;
          --bg-app-via: #141414;
          --bg-app-to: #0a0a0a;

          --bg-surface-1: #141414;
          --bg-surface-2: #111111;
          --bg-surface-3: #0f0f0f;
          --bg-surface-4: #0c0c0c;
          --bg-surface-5: #0e0e0e;
          --bg-surface-6: #121212;
          --bg-surface-7: #0d0d0d;
          --bg-surface-8: #0a0a0a;

          --bg-content-1: #181818;
          --bg-content-2: #1c1c1c;
          --bg-content-3: #161616;
          --bg-content-4: #141414;

          --bg-preview-1: #1e1e1e;
          --bg-preview-2: #0e0e0e;
          --bg-preview-3: #121212;
          --bg-preview-4: #080808;
          --bg-preview-5: #0b0b0b;

          --bg-overlay-1: #151515;
          --bg-overlay-2: #161616;
          --bg-overlay-3: #141414;
          --bg-overlay-4: #181818;

          --bg-player-bg: #161616;
          --bg-player-chip: #0e0e0e;
          --bg-player-chip-border: #2a2a2a;
          --bg-player-chip-hover: #1a1a1a;
          --bg-player-elevated: #101010ee;
        }

        /* Convenience utility classes */
        .bg-app-radial {
          background-image: radial-gradient(ellipse at top, var(--tw-gradient-stops));
        }
        .bg-theme-surface-1 { background-color: var(--bg-surface-1); }
        .bg-theme-surface-2 { background-color: var(--bg-surface-2); }
        .bg-theme-surface-3 { background-color: var(--bg-surface-3); }
        .bg-theme-surface-4 { background-color: var(--bg-surface-4); }
        .bg-theme-surface-5 { background-color: var(--bg-surface-5); }
        .bg-theme-surface-6 { background-color: var(--bg-surface-6); }
        .bg-theme-surface-7 { background-color: var(--bg-surface-7); }
        .bg-theme-surface-8 { background-color: var(--bg-surface-8); }
        .bg-theme-content-1 { background-color: var(--bg-content-1); }
        .bg-theme-content-2 { background-color: var(--bg-content-2); }
        .bg-theme-content-3 { background-color: var(--bg-content-3); }
        .bg-theme-content-4 { background-color: var(--bg-content-4); }
        .bg-theme-preview-1 { background-color: var(--bg-preview-1); }
        .bg-theme-preview-2 { background-color: var(--bg-preview-2); }
        .bg-theme-preview-3 { background-color: var(--bg-preview-3); }
        .bg-theme-preview-4 { background-color: var(--bg-preview-4); }
        .bg-theme-preview-5 { background-color: var(--bg-preview-5); }
        .bg-theme-overlay-1 { background-color: var(--bg-overlay-1); }
        .bg-theme-overlay-2 { background-color: var(--bg-overlay-2); }
        .bg-theme-overlay-3 { background-color: var(--bg-overlay-3); }
        .bg-theme-overlay-4 { background-color: var(--bg-overlay-4); }

        /* New semantic background classes using Fluent UI tokens */
        .bg-base { background-color: var(--bg-1); }
        .bg-surface { background-color: var(--bg-2); }
        .bg-elevated { background-color: var(--bg-3); }
        .bg-overlay { background-color: var(--bg-4); }
        .bg-media { background-color: var(--bg-5); }
        .bg-hover { background-color: var(--bg-6); }

        .text-primary { color: var(--fg-1); }
        .text-secondary { color: var(--fg-2); opacity: 0.8; }
        .text-muted { color: var(--fg-3); opacity: 0.8; }
        .text-disabled { color: var(--fg-disabled); }

        .border-default { border-color: var(--stroke-1); }
        .border-subtle { border-color: var(--stroke-2); }
        .border-muted { border-color: var(--stroke-3); }

        /* Checkerboard pattern for image/video preview */
        .checkerboard {
          background-image:
            linear-gradient(45deg, var(--row-bg) 25%, transparent 25%),
            linear-gradient(-45deg, var(--row-bg) 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, var(--row-bg) 75%),
            linear-gradient(-45deg, transparent 75%, var(--row-bg) 75%) !important;
          background-size: 16px 16px !important;
          background-position: 0 0, 0 8px, 8px -8px, -8px 0px !important;
          background-color: var(--surface-bg) !important;
        }
        .checkerboard-light {
          background-image:
            linear-gradient(45deg, var(--surface-bg) 25%, transparent 25%),
            linear-gradient(-45deg, var(--surface-bg) 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, var(--surface-bg) 75%),
            linear-gradient(-45deg, transparent 75%, var(--surface-bg) 75%) !important;
          background-size: 16px 16px !important;
          background-position: 0 0, 0 8px, 8px -8px, -8px 0px !important;
          background-color: var(--row-bg) !important;
        }

        /* Scrollbar styling lives in src/index.css (loaded as a global stylesheet
           so it survives Vite's per-component CSS scoping). The thin variant
           below stays here because it's scoped to .goku-thin-scroll only. */

        /* ── Thin 4px Scrollbars for Dropdowns / Menus ─── */
        /* Force a slim, button-less scrollbar on opt-in elements. The thumb
           colour is non-transparent so WebView2 won't fall back to its native
           Windows 11 overlay scrollbar. */
        .goku-thin-scroll::-webkit-scrollbar {
          width: 6px !important;
          height: 6px !important;
          -webkit-appearance: none !important;
          appearance: none !important;
        }
        .goku-thin-scroll::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.05) !important;
          border-radius: 3px !important;
        }
        .goku-thin-scroll::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.3) !important;
          border-radius: 3px !important;
          border: none !important;
        }
        .goku-thin-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.5) !important;
        }
        .goku-thin-scroll::-webkit-scrollbar-button {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
        .goku-thin-scroll::-webkit-scrollbar-corner {
          background: transparent !important;
        }
        .goku-thin-scroll {
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 255, 255, 0.3) transparent;
        }

        /* ── Debug Background Variables (can be changed at runtime) ─── */
        :root, html, body, #root {
          --app-bg: #191919;
          --menu-opacity: 1;
        }

        /* Video element should be transparent */
        video {
          background-color: transparent !important;
        }

        /* WaveSurfer waveform styling - ensure bars are visible on dark backgrounds */
        wave {
          background-color: var(--app-bg) !important;
        }
        ws-waveform, .ws-waveform {
          background-color: var(--app-bg) !important;
        }
        iframe[src*="wavesurfer"] {
          background-color: var(--app-bg) !important;
        }

        /* Single unified app background */
        html, body, #root, .goku-app-root {
          background-color: var(--app-bg) !important;
        }

        /* Header background is defined in src/index.css (RGB 17 = #111111) so
           it survives Vite's component-level style scoping. The class hook
           still works because it lives in the global stylesheet. */

        /* ════════════════════════════════════════════════════════════════
           UNIFIED TEXT COLOR (single source of truth)
           ─────────────────────────────────────────────────────────────
           Every text utility class collapses to ONE white color so the
           app reads consistently. Secondary/muted is rendered via 80%
           opacity on the element rather than a different hex value.
           Edit this block to retune text color globally in the future.
           ════════════════════════════════════════════════════════════════ */
        .text-primary,
        .text-secondary,
        .text-muted,
        .text-disabled,
        .text-white,
        [class*="text-stone-"],
        [class*="text-gray-"],
        [class*="text-zinc-"],
        [class*="text-neutral-"],
        [class*="text-slate-"] {
          color: #ffffff;
        }
        /* Secondary / muted text: 80% opacity instead of separate gray shades. */
        .text-secondary,
        .text-muted,
        [class~="text-stone-400"],
        [class~="text-stone-500"],
        [class~="text-stone-600"],
        [class~="text-gray-400"],
        [class~="text-gray-500"],
        [class~="text-gray-600"],
        [class~="text-zinc-400"],
        [class~="text-zinc-500"],
        [class~="text-zinc-600"],
        [class~="text-neutral-400"],
        [class~="text-neutral-500"],
        [class~="text-neutral-600"],
        [class~="text-slate-400"],
        [class~="text-slate-500"],
        [class~="text-slate-600"] {
          opacity: 0.8;
        }
        /* Disabled text keeps its dim gray (signals non-interactive state). */
        .text-disabled {
          opacity: 0.4;
        }

        /* Accent custom color: force circular swatch across all WebView2 versions. */
        input[type="color"].rounded-full,
        input[type="color"].rounded-full::-webkit-color-swatch-wrapper,
        input[type="color"].rounded-full::-webkit-color-swatch,
        input[type="color"].rounded-full::-moz-color-swatch {
          border-radius: 9999px !important;
          padding: 0 !important;
        }
      `}</style>
      <div className="goku-app-root flex flex-col h-screen w-screen overflow-hidden" style={{ backgroundColor: 'var(--app-bg)' }}>
      {/* 1. Header Toolbar ribbon */}
      <div className="goku-header" onContextMenu={(e) => e.preventDefault()}>
      <ExplorerHeader explorer={explorer} />
      </div>

      {/* 2. Main Workspace Layout - Unified structure with CSS-only responsive */}
      {/* Layout changes via CSS classes, NOT conditional rendering - prevents preview re-renders */}
      <div 
        className={`flex flex-1 overflow-hidden min-h-0 relative select-none goku-content-wrapper goku-workspace ${isDetailsBelow ? 'goku-workspace-vertical' : 'goku-workspace-horizontal'}`}
        style={isDetailsBelow ? { height: `calc(100vh - 50px)` } : undefined}
      >
        {/* Sidebar */}
        <div ref={sidebarRef} tabIndex={0} className="h-full focus:outline-none shrink-0 goku-sidebar-wrapper" onContextMenu={(e) => e.preventDefault()}>
          <ExplorerSidebar explorer={explorer} width={sidebarWidth} />
        </div>

        {/* Sidebar Drag Handle */}
        <SidebarDragHandle
          resizing={resizing}
          onResize={() => setResizing("sidebar")}
          onDoubleClick={() => setSidebarWidth(240)}
          accentColor={explorer.accentColor}
          theme={explorer.theme}
        />

        {/* Content Area - Main + Details stacked differently based on layout mode */}
        <div 
          ref={mainPaneRef}
          tabIndex={0}
          className={`flex flex-1 min-w-0 overflow-hidden relative focus:outline-none goku-content-area ${isDetailsBelow ? 'goku-content-area-vertical' : 'goku-content-area-horizontal'}`}
        >
          {/* Main Pane Wrapper */}
          <div className={`overflow-hidden relative goku-main-pane-wrapper ${isDetailsBelow ? 'goku-main-pane-vertical' : ''}`}>
            {explorer.showSpaceAnalyzer ? (
              <SpaceAnalyzerDashboard explorer={explorer} />
            ) : (
              <ExplorerMainPane
                explorer={explorer}
                onFolderClick={(folderPath) => {
                  if (!explorer.showDetailsPane) return;
                  explorer.setPaneSession(prev => ({
                    ...prev,
                    folderInspectionPath: folderPath,
                    inspectorSelectedIds: [],
                    showMultiSelectInspector: false,
                    multiSelectItems: [],
                  }));
                }}
                onFileClick={() => {
                  explorer.setPaneSession(prev => ({
                    ...prev,
                    folderInspectionPath: null,
                    showMultiSelectInspector: false,
                    multiSelectItems: [],
                  }));
                }}
                onViewportClick={() => {
                  explorer.setPaneSession(prev => ({
                    ...prev,
                    folderInspectionPath: null,
                    inspectorSelectedIds: [],
                    showMultiSelectInspector: false,
                    multiSelectItems: [],
                  }));
                }}
                onMultiSelectChange={handleMultiSelectChange}
                onClearMultiSelect={handleClearMultiSelect}
                onCloseFolderInspection={closeFolderInspection}
              />
            )}
          </div>

          {/* Details Drag Handle */}
          {detailsPaneEnabled && (
            <DetailsDragHandle
              isVertical={isDetailsBelow}
              resizing={resizing}
              onResize={() => setResizing("details")}
              onDoubleClick={() => explorer.setShowDetailsPane(false)}
              accentColor={explorer.accentColor}
              theme={explorer.theme}
            />
          )}

          {/* Details Pane — hidden on virtual shell locations (This PC, Network)
              since they don't have meaningful per-item properties. */}
          {detailsPaneEnabled && (
            <DetailsPaneWrapper
              isVertical={isDetailsBelow}
              width={isDetailsBelow ? windowWidth - sidebarWidth - 8 : detailsWidth}
              height={isDetailsBelow ? detailsBottomHeight : undefined}
            >
              {showMultiSelectInspector && multiSelectItems.length >= 2 ? (
                <MultiSelectInspector
                  key={`multi-select-${explorer.language}`}
                  selectedItems={multiSelectItems}
                  accentColor={explorer.accentColor}
                  width={isDetailsBelow ? windowWidth - sidebarWidth - 8 : detailsWidth}
                  language={explorer.language}
                  onClose={() => {
                    explorer.setPaneSession(prev => ({
                      ...prev,
                      showMultiSelectInspector: false,
                      multiSelectItems: [],
                    }));
                    explorer.setSelectedIds([]);
                  }}
                />
              ) : folderInspectionPath ? (
                <InspectorWindow
                  explorer={explorer}
                  folderName={folderInspectionPath.split(/[\\/]/).pop() || ""}
                  folderPath={folderInspectionPath}
                  folderItems={inspectorFolderItems}
                  width={isDetailsBelow ? windowWidth - sidebarWidth - 8 : detailsWidth}
                  onClose={() => {
                    explorer.setPaneSession(prev => ({
                      ...prev,
                      folderInspectionPath: null,
                      inspectorSelectedIds: [],
                    }));
                  }}
                  onFileDoubleClick={(item) => {
                    explorer.openFileForEditing(item.path);
                  }}
                />
              ) : (
                <ExplorerDetailsPane explorer={explorer} width={isDetailsBelow ? windowWidth - sidebarWidth - 8 : detailsWidth} />
              )}
            </DetailsPaneWrapper>
          )}
        </div>
      </div>

      {/* 3. Floating Overlay Code / Markdown Editor application */}
      <FileEditorWindow explorer={explorer} />

      {/* 4. Smart Go-to Navigation Palette */}
      <GotoPalette explorer={explorer} />

      {/* 5. Delete Confirmation Dialog */}
      {deleteConfirmItems && (
        <DeleteConfirmDialog
          items={deleteConfirmItems.items}
          isPermanent={deleteConfirmItems.isPermanent}
          accentColor={explorer.accentColor}
          language={explorer.language}
          onConfirm={() => {
            const { items, isPermanent } = deleteConfirmItems;
            const mode = isPermanent ? "permanent" : "recycle";
            const count = items.length;
            (async () => {
              for (const item of items) {
                await explorer.deleteItem(item.id, mode);
              }
              explorer.setSelectedIds([]);
            })();
            explorer.setStatusMessage(
              isPermanent
                ? (explorer.language === "vi"
                  ? `Đã xóa vĩnh viễn ${count} mục.`
                  : `Permanently deleted ${count} item(s).`)
                : (explorer.language === "vi"
                  ? `Đã chuyển ${count} mục vào Thùng rác.`
                  : `Moved ${count} item(s) to Recycle Bin.`)
            );
            setDeleteConfirmItems(null);
          }}
          onCancel={() => setDeleteConfirmItems(null)}
        />
      )}

      {/* 6. Transfer Queue (bottom-right, Phase 1) */}
      <TransferQueueModal />
      </div>
    </div>
  );
}

/* eslint-enable */
