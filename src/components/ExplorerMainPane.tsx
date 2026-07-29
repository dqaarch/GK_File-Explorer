import React, { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from "react";
import ReactDOM from "react-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import { ExplorerAPI } from "../useExplorer";
import { registerHoverPane, getPaneAtWheelEvent } from "../utils/hoverPane";
import { OpenWithApp, importFiles, writeTextFile, joinPath, getParentPath, formatFileSize, DriveInfo, decodePsdOnDemand, decodeAiOnDemand, listShellExtensionsForTarget, executeShellExtensionVerb, getVerbIcon, ContextMenuEntry, ShellEntriesResponse, ShellExecuteResult } from "../TauriFileSystem";
import { FSItem, ViewMode, SortBy, SortDirection, getTagTranslation, viewModeGroup, getIconSizePx, getIconGridMinCellPx, VIEW_MODE_LABELS, VIEW_MODE_MIN, VIEW_MODE_MAX, thumbRequestSize } from "../types";
import { filterAndSortSearchItems, getMatchHighlightIndices, getRelativeSearchPath, SearchMode } from "../utils/searchRanker";
import { dropdownEventBus, DROPDOWN_EVENTS } from "../utils/dropdownEvents";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
// Native drag via tauri-plugin-drag (wraps drag-rs crate)
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { setThumbsGlobal, hasThumbFailure, markThumbFailure, clearThumbFailure } from "../contexts/thumbnailsStore";
import { normalizeThumbnailSrc } from "../utils/thumbnail";
import { useViewportThumbnails } from "../hooks/useViewportThumbnails";
import { useFolderSizes } from "../hooks/useFolderSizes";
import { useSpecialFolderIcon } from "../hooks/useSpecialFolderIcon";
import {
  Folder, File, FileText, Code, Archive, FileImage, Trash2, Edit3,
  Copy, Scissors, Clipboard, Plus, Check, ChevronRight, ChevronDown, HardDrive, HelpCircle,
  Boxes, Film, Music, Pin, PinOff, Info, RefreshCw, FolderPlus, FilePlus, FolderOpen, Link, AppWindow, ExternalLink,
  Terminal as TerminalIcon, LayoutGrid, LayoutList, ArrowUpDown, MoreHorizontal, Settings2, AppWindow as AppWinIcon, CheckCircle
} from "lucide-react";
import OpenWithSubmenu from "./OpenWithSubmenu";

// ── Phase 2.1: Show more options (Windows shell extensions, plugin-backed) ──
//
// Data source: `win-context-menu` crate (a thin safe wrapper around
// `IContextMenu::QueryContextMenu`). This gives us the exact ordering Explorer
// itself uses, plus both Win11 modern (`IExplorerCommand`) and Win10 legacy
// handlers in one shot.
//
// Rendering: stays custom — ExplorerMainPane's design language (icons,
// spacing, dark theme). We flatten the plugin's tree into rows + hover
// submenus (matching the rest of the app's right-click UX).

type ShowMoreScope = "files" | "directory" | "background";

interface ShowMoreOptionsSectionProps {
  scope: ShowMoreScope;
  targetPath: string | null;
  /** Verbs to hide from the plugin output. Used by the file/background
   *  menus to suppress duplicates we already render in the in-app section
   *  (e.g. `New`, `Give access to` whose submenu the plugin can't resolve,
   *  the system `Open`/`Properties` we expose as dedicated buttons). */
  filterVerbs?: string[];
  /** Called when the user enters a plugin submenu to cancel parent's close timer. */
  onHoverEnter?: () => void;
}

const VERB_OPEN = "open";
const VERB_OPENWITH = "openwith";
const VERB_NEW = "New";
const VERB_DELETE = "delete";
const VERB_PROPERTIES = "properties";
const VERB_LINK = "link";
const VERB_CUT = "cut";
const VERB_COPY = "copy";
const VERB_PASTE = "paste";
const VERB_COPYASPATH = "copyaspath";
const VERB_GRANT = "grantaccess";
const VERB_GRANT_USER = "grantaccessbyuser";

// Verbs we hide from the plugin output because the app surfaces them as
// dedicated buttons or because the shell extension can't provide the
// submenu data we need.
//   - `command_string` matches: `IContextMenu::GetCommandString`
//   - `label_match` (case-insensitive substring): for cases where two
//     shell extensions register different verbs with the same display
//     label (e.g. the built-in "Open with" verb which has no
//     `command_string` in some Explorer builds).
const HIDDEN_VERBS = new Set(
  [VERB_OPEN, VERB_OPENWITH, VERB_NEW, VERB_PROPERTIES, VERB_LINK,
   VERB_CUT, VERB_COPY, VERB_PASTE, VERB_COPYASPATH,
   VERB_GRANT, VERB_GRANT_USER].map((v) => v.toLowerCase())
);
const HIDDEN_LABELS = ["open with", "give access to", "share with"];

/** Drop entries whose `command_string` matches `hidden` or whose
 *  `label` (case-insensitive substring) matches one of `hidden_labels`.
 *  Recurses into submenus. Use `hidden_labels` for verbs that don't
 *  expose a stable `command_string` across Explorer builds. */
function filterEntries(
  entries: ContextMenuEntry[],
  hidden: Set<string>,
  hidden_labels: string[] = HIDDEN_LABELS
): ContextMenuEntry[] {
  const out: ContextMenuEntry[] = [];
  for (const e of entries) {
    if (e.is_separator) {
      if (out.length > 0) out.push(e);
      continue;
    }
    if (e.command_string && hidden.has(e.command_string.toLowerCase())) continue;
    const loweredLabel = e.label?.toLowerCase() ?? "";
    if (hidden_labels.some((l) => loweredLabel.includes(l))) continue;
    if (e.submenu && e.submenu.length > 0) {
      const filtered = filterEntries(e.submenu, hidden, hidden_labels);
      // Drop a parent that, after filtering, ends up with zero visible
      // children — keeps the menu free of placeholder parents.
      if (filtered.length === 0) continue;
      out.push({ ...e, submenu: filtered });
    } else {
      out.push(e);
    }
  }
  // Collapse consecutive separators (may appear after filtering removes items).
  const collapsed: ContextMenuEntry[] = [];
  for (const e of out) {
    if (e.is_separator) {
      if (collapsed.length > 0 && !collapsed[collapsed.length - 1].is_separator) {
        collapsed.push(e);
      }
      // Skip if previous item was also a separator.
    } else {
      collapsed.push(e);
    }
  }
  // Remove trailing orphan separator.
  while (collapsed.length > 0 && collapsed[collapsed.length - 1].is_separator) {
    collapsed.pop();
  }
  // Remove leading orphan separator.
  let startIdx = 0;
  while (startIdx < collapsed.length && collapsed[startIdx].is_separator) {
    startIdx++;
  }
  if (startIdx > 0) {
    collapsed.splice(0, startIdx);
  }
  return collapsed;
}

// Per-path cache. Right-click → menu open is the very hot path; cache so
// repeated right-clicks on the same target are instant.
const __showMoreCache = new Map<
  string,
  { fetchedAt: number; data: ShellEntriesResponse }
>();
const SHOW_MORE_TTL_MS = 30_000;

async function getEntriesForTarget(
  targetPath: string | null
): Promise<ShellEntriesResponse | null> {
  if (!targetPath) return null;
  const cached = __showMoreCache.get(targetPath);
  if (cached && Date.now() - cached.fetchedAt < SHOW_MORE_TTL_MS) {
    return cached.data;
  }
  const data = await listShellExtensionsForTarget(targetPath);
  __showMoreCache.set(targetPath, { fetchedAt: Date.now(), data });
  return data;
}

// Cache of verb → data URL (or null) for system icons. Keyed by verb so we
// only call `getVerbIcon` once per verb per session.
const __verbIconCache = new Map<string, string | null>();
async function getVerbIconCached(verb: string): Promise<string | null> {
  const cached = __verbIconCache.get(verb);
  if (cached !== undefined) return cached;
  const url = await getVerbIcon(verb);
  __verbIconCache.set(verb, url);
  return url;
}

function ShowMoreOptionsSection({
  scope,
  targetPath,
  filterVerbs,
  onHoverEnter,
}: ShowMoreOptionsSectionProps) {
  const [entries, setEntries] = useState<ContextMenuEntry[] | null>(null);
  // One panel-at-a-time for the entire section. Anchored submenu =
  // { entry, parentAnchor, depth, onInvoke, leftPx, topPx }. When non-null
  // we render a portal <div> at top level so the submenu floats above the
  // main menu and never stretches it vertically.
  const [submenuState, setSubmenuState] =
    useState<SubmenuState | null>(null);
  const [containerCloseTimer, setContainerCloseTimer] = useState<number | null>(null);
  const containerCloseTimerRef = useRef<number | null>(null);
  // Track the active submenu parent ID synchronously (not batched like state)
  const submenuParentIdRef = useRef<string | number | null>(null);
  // Track the close timer ID from the row that has submenu open
  const submenuCloseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await getEntriesForTarget(targetPath);
        if (cancelled) return;
        if (!resp) {
          setEntries([]);
          return;
        }
        // Defensive: ensure resp has the expected structure
        if (typeof resp !== 'object' || resp === null) {
          console.error("[show-more-options] invalid response type:", typeof resp);
          setEntries([]);
          return;
        }
        const raw =
          scope === "files"
            ? Array.isArray(resp.files) ? resp.files : []
            : scope === "directory"
            ? Array.isArray(resp.directory) ? resp.directory : []
            : Array.isArray(resp.background) ? resp.background : [];
        const hidden = new Set(
          (filterVerbs ?? []).map((v) => v.toLowerCase())
        );
        setEntries(filterEntries(raw, hidden));
      } catch (e) {
        console.error("[show-more-options] enumerate failed:", e);
        if (!cancelled) setEntries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, targetPath, filterVerbs]);

  useEffect(() => {
    // Refresh submenu state when entries re-load — the previous parent
    // anchor's entry may now be filtered out.
    // Only reset if entries is not null (to avoid resetting during loading state)
    if (entries !== null) {
      setSubmenuState(null); submenuParentIdRef.current = null;
    }
  }, [entries]);

  // Sync containerCloseTimerRef with state
  useEffect(() => {
    containerCloseTimerRef.current = containerCloseTimer;
  }, [containerCloseTimer]);

  const onInvoke = (verb: string | null) => {
    if (!targetPath || !verb) return;
    void executeShellExtensionVerb(targetPath, verb);
  };

  // Clear container close timer when submenu opens - MUST be before any early return
  useEffect(() => {
    if (submenuState !== null && containerCloseTimerRef.current !== null) {
      window.clearTimeout(containerCloseTimerRef.current);
      containerCloseTimerRef.current = null;
      setContainerCloseTimer(null);
    }
  }, [submenuState]);

  // Add safety check for entries state
  const safeEntries = Array.isArray(entries) ? entries : null;

  // Track if component is still mounted to prevent state updates after unmount
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  if (safeEntries !== null && safeEntries.length === 0) {
    // Still render something so the user knows the menu is there
    return (
      <div className="py-1">
        <div className="px-3 py-1.5 text-[11px] text-gray-400">
          No additional options
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        className="py-1"
        onMouseLeave={() => {
          if (submenuState && isMountedRef.current) {
            const timer = window.setTimeout(() => {
              if (isMountedRef.current) {
                setContainerCloseTimer((cur) => (cur === timer ? null : cur));
                setSubmenuState((cur) => (cur === submenuState ? null : cur));
              }
            }, 400);
            containerCloseTimerRef.current = timer;
            setContainerCloseTimer(timer);
          }
        }}
      >
        {safeEntries === null ? (
          <div className="px-3 py-1.5 text-[11px]">Loading...</div>
        ) : (
          safeEntries.map((entry, idx) => {
            // Defensive: skip invalid entries
            if (!entry || typeof entry.id !== 'number') {
              console.warn("[show-more-options] skipping invalid entry:", entry);
              return null;
            }
            return (
              <ContextMenuRow
                key={`${entry.id}-${idx}`}
                entry={entry}
                depth={0}
                onInvoke={onInvoke}
                onRequestSubmenu={(parent, rect) => {
                  if (!isMountedRef.current) return;
                  if (onHoverEnter) onHoverEnter();
                  if (containerCloseTimerRef.current !== null) {
                    window.clearTimeout(containerCloseTimerRef.current);
                    setContainerCloseTimer(null);
                  }
                  if (submenuCloseTimerRef.current !== null) {
                    window.clearTimeout(submenuCloseTimerRef.current);
                    submenuCloseTimerRef.current = null;
                  }
                  submenuParentIdRef.current = parent.id;
                  if (submenuState !== null) {
                    setSubmenuState(null); submenuParentIdRef.current = null;
                  }
                  setSubmenuState({
                    entry: parent,
                    parentRect: rect,
                    onInvoke,
                  });
                }}
                onCloseSubmenu={() => {
                  if (isMountedRef.current) setSubmenuState(null);
                }}
                submenuParentIdRef={submenuParentIdRef}
                submenuCloseTimerRef={submenuCloseTimerRef}
              />
            );
          })
        )}
      </div>

      {submenuState && isMountedRef.current &&
        ReactDOM.createPortal(
          <ErrorBoundary>
            <SubmenuPanel
              state={submenuState}
              onInvoke={(verb) => {
                onInvoke(verb);
                setSubmenuState(null); submenuParentIdRef.current = null;
              }}
              onHover={() => {
                if (containerCloseTimerRef.current !== null) {
                  window.clearTimeout(containerCloseTimerRef.current);
                  setContainerCloseTimer(null);
                  containerCloseTimerRef.current = null;
                }
                if (submenuCloseTimerRef.current !== null) {
                  window.clearTimeout(submenuCloseTimerRef.current);
                  submenuCloseTimerRef.current = null;
                }
                if (onHoverEnter) onHoverEnter();
              }}
              onLeave={() => {
                setTimeout(() => {
                  if (isMountedRef.current) {
                    setSubmenuState((cur) => (cur === submenuState ? null : cur));
                  }
                }, 400);
              }}
              submenuCloseTimerRef={submenuCloseTimerRef}
            />
          </ErrorBoundary>,
          document.body
        )}
    </>
  );
}

interface SubmenuState {
  entry: ContextMenuEntry;
  parentRect: DOMRect;
  onInvoke: (verb: string | null) => void;
}

function SubmenuPanel({
  state,
  onInvoke,
  onHover,
  onLeave,
  submenuCloseTimerRef,
}: {
  state: SubmenuState;
  onInvoke: (verb: string | null) => void;
  onHover: () => void;
  onLeave: () => void;
  submenuCloseTimerRef: React.MutableRefObject<number | null>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; width: number }>({
    x: state.parentRect.right + 4,
    // Start slightly below parent top to eliminate the hover-gap when
    // the mouse moves from trigger → submenu without any element under it.
    y: state.parentRect.top + 2,
    width: 240,
  });

  // Re-position after first mount (so we can measure real height).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = state.parentRect.right + 4;
    let y = state.parentRect.top + 2;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (x + 240 > vw - 12) {
      x = Math.max(12, state.parentRect.left - 240 - 4);
    }
    if (y + rect.height > vh - 12) {
      y = Math.max(12, vh - rect.height - 12);
    }
    setPos({ x, y, width: 240 });
  }, [state]);

  const [openNested, setOpenNested] = useState<SubmenuState | null>(null);

  const [zIdx, setZIdx] = useState(700);

  return (
    <div
      ref={ref}
      className="fixed fluent-menu rounded-xl w-[18rem] max-h-[70vh] overflow-y-auto goku-thin-scroll py-1.5 animate-in fade-in zoom-in-95 duration-75"
      style={{ top: pos.y, left: pos.x, zIndex: zIdx, fontSize: '12px', color: '#e7e5e4' }}
      onMouseEnter={() => {
        setZIdx(800);
        if (submenuCloseTimerRef.current !== null) {
          window.clearTimeout(submenuCloseTimerRef.current);
          submenuCloseTimerRef.current = null;
        }
        onHover();
      }}
      onMouseLeave={() => {
        onLeave();
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {state.entry.submenu!.map((sub, idx) => (
        <ContextMenuRow
          key={`${sub.id}-${idx}`}
          entry={sub}
          depth={1}
          onInvoke={onInvoke}
          onRequestSubmenu={(parent, rect) => {
            onHover();
            setZIdx(900);
            setOpenNested({ entry: parent, parentRect: rect, onInvoke });
          }}
          onCloseSubmenu={() => {
            setOpenNested(null);
            setZIdx(700);
          }}
        />
      ))}

      {openNested &&
        ReactDOM.createPortal(
          <SubmenuPanel
            state={openNested}
            onInvoke={onInvoke}
            onHover={() => {
              onHover();
              setZIdx(1000);
            }}
            onLeave={() => setOpenNested(null)}
            submenuCloseTimerRef={submenuCloseTimerRef}
          />,
          document.body
        )}
    </div>
  );
}

interface ContextMenuRowProps {
  entry: ContextMenuEntry;
  depth: number;
  onInvoke: (verb: string | null) => void;
  /** Called when the user hovers a row with a submenu. The parent will
   *  position an anchored panel. */
  onRequestSubmenu: (entry: ContextMenuEntry, parentRect: DOMRect) => void;
  /** Called when the parent should close its anchored panel. */
  onCloseSubmenu: () => void;
  /** Ref to the active submenu parent ID (synchronous, not batched).
   *  Optional - if not provided, a dummy ref is used internally. */
  submenuParentIdRef?: React.MutableRefObject<string | number | null>;
  /** Ref to the close timer ID from the row that has submenu open.
   *  When submenu opens, parent clears this timer. */
  submenuCloseTimerRef?: React.MutableRefObject<number | null>;
}

const SUBMENU_OPEN_DELAY = 60;
// Match OpenWithSubmenu (which uses a 400ms close grace period) so the
// plugin submenus (7-Zip, Cast to Device, etc.) feel consistent with the
// rest of the app.
const SUBMENU_CLOSE_DELAY = 400;

function ContextMenuRow({
  entry,
  depth,
  onInvoke,
  onRequestSubmenu,
  onCloseSubmenu,
  submenuParentIdRef: externalParentRef,
  submenuCloseTimerRef: externalCloseTimerRef,
}: ContextMenuRowProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  // Use external refs if provided, otherwise use internal refs
  const internalParentRef = useRef<string | number | null>(null);
  const internalCloseTimerRef = useRef<number | null>(null);
  const submenuParentIdRef = externalParentRef ?? internalParentRef;
  const submenuCloseTimerRef = externalCloseTimerRef ?? internalCloseTimerRef;
  const [iconUrl, setIconUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const verb = entry.command_string;
    if (!verb) return;
    (async () => {
      const url = await getVerbIconCached(verb);
      if (!cancelled) setIconUrl(url ? `data:image/png;base64,${url}` : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.command_string]);

  // Cancel closeTimer when submenuParentIdRef changes (e.g., moving to different row's submenu)
  useEffect(() => {
    const currentParentId = submenuParentIdRef.current;
    if (closeTimer.current !== null && currentParentId !== entry.id) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, [entry.id]); // Only depend on entry.id, not the ref

  if (entry.is_separator) {
    return <div className="my-1 mx-2 border-t border-white/5" />;
  }

  // Defensive: ensure entry has required properties
  if (typeof entry.id !== 'number' || typeof entry.label !== 'string') {
    console.error("[ContextMenuRow] invalid entry:", entry);
    return null;
  }

  // Normalize submenu to always be an array
  const normalizedSubmenu = Array.isArray(entry.submenu) ? entry.submenu : null;
  const hasSubmenu =
    !!(normalizedSubmenu && normalizedSubmenu.length > 0) && depth < 2;
  const indent = depth * 12;

  const clearAllTimers = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleOpen = () => {
    if (!hasSubmenu || !buttonRef.current) return;
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (openTimer.current !== null) return;
    const rect = buttonRef.current.getBoundingClientRect();
    openTimer.current = window.setTimeout(() => {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      onRequestSubmenu(entry, rect);
      openTimer.current = null;
    }, SUBMENU_OPEN_DELAY);
  };

  const scheduleClose = () => {
    const currentParentId = submenuParentIdRef.current;
    if (currentParentId === null || currentParentId !== entry.id || depth !== 0) {
      return;
    }
    if (closeTimer.current !== null) return;
    closeTimer.current = window.setTimeout(() => {
      onCloseSubmenu();
      closeTimer.current = null;
      submenuCloseTimerRef.current = null;
    }, SUBMENU_CLOSE_DELAY);
    submenuCloseTimerRef.current = closeTimer.current;
  };

  const handleMouseLeave = () => {
    const currentParentId = submenuParentIdRef.current;
    if (depth === 0 && currentParentId === entry.id) {
      scheduleClose();
    }
  };

  return (
    <button
      ref={(el) => {
        buttonRef.current = el;
        if (el && depth === 0 && entry.submenu) {
          if (closeTimer.current !== null) {
            window.clearTimeout(closeTimer.current);
            closeTimer.current = null;
          }
          if (submenuCloseTimerRef.current !== null) {
            window.clearTimeout(submenuCloseTimerRef.current);
            submenuCloseTimerRef.current = null;
          }
        }
      }}
      type="button"
      disabled={entry.is_disabled}
      onClick={() => {
        clearAllTimers();
        if (!hasSubmenu) {
          onInvoke(entry.command_string);
        }
      }}
      onMouseEnter={() => {
        scheduleOpen();
      }}
      onMouseLeave={handleMouseLeave}
      className={`flex items-center gap-2.5 w-full px-3 py-1.5 text-left text-[12px] cursor-pointer ${
        entry.is_disabled
          ? "opacity-40 cursor-not-allowed"
          : "hover:bg-white/10"
      } ${entry.is_default ? "font-semibold" : ""}`}
      style={{
        color: entry.is_disabled ? "var(--text-muted)" : "var(--text-primary)",
        paddingLeft: 12 + indent
      }}
      title={entry.command_string ?? undefined}
    >
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          className="w-4 h-4 shrink-0 object-contain"
          draggable={false}
        />
      ) : (
        <Settings2
          className="w-3.5 h-3.5 shrink-0"
          style={{ color: "var(--text-secondary)" }}
        />
      )}
      <span className="flex-1 truncate">
        {entry.label}
        {entry.is_checked && (
          <span className="ml-1" style={{ color: "var(--accent)" }}>✓</span>
        )}
      </span>
      {hasSubmenu && (
        <ChevronRight className="w-3 h-3 shrink-0" style={{ color: "var(--text-secondary)" }} />
      )}
    </button>
  );
}

interface MainPaneProps {
  explorer: ExplorerAPI;
  onFolderClick?: (folderPath: string, folderName: string) => void;
  onFileClick?: () => void;
  onViewportClick?: () => void;
  onMultiSelectChange?: (items: FSItem[]) => void;
  onClearMultiSelect?: () => void;
  onCloseFolderInspection?: () => void;
  overridePath?: string;
  overrideItems?: FSItem[];
  overrideSelectedIds?: string[];
  overrideSetSelectedIds?: (ids: string[]) => void;
  overrideViewMode?: ViewMode;
  /**
   * Optional independent sort state for the pane. When supplied (typically
   * only by the Folder Inspector), the pane uses these values instead of
   * the global `explorer.sortBy` / `explorer.sortDirection`. Lets the
   * Inspector show its own ordering without affecting the main pane.
   */
  overrideSortBy?: SortBy;
  overrideSortDirection?: SortDirection;
  /**
   * Optional independent view-mode setter. When supplied, Ctrl+Scroll
   * inside this pane calls this setter instead of the global
   * `explorer.setViewMode`. Lets the Folder Inspector have its own
   * zoom level without affecting the main pane.
   */
  overrideSetViewMode?: (v: ViewMode) => void;
  /** When true, single-click selects only; double-click navigates via onFolderClick. */
  isInspectorPane?: boolean;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  targetItem: FSItem | null; // null represents viewport background
  showMoreOptions?: boolean;
}

interface SearchResultsGroup {
  key: string;
  label: string;
  collapsedByDefault: boolean;
  order: number;
  items: FSItem[];
}

export default function ExplorerMainPane({
  explorer,
  onFolderClick,
  onFileClick,
  onViewportClick,
  onMultiSelectChange,
  onClearMultiSelect,
  onCloseFolderInspection,
  overridePath,
  overrideItems,
  overrideSelectedIds,
  overrideSetSelectedIds,
  overrideViewMode,
  overrideSortBy,
  overrideSortDirection,
  overrideSetViewMode,
  isInspectorPane: isInspectorPaneProp,
}: MainPaneProps) {
  const {
    items,
    searchResults,
    isSearching,
    activeTab,
    selectedIds,
    setSelectedIds,
    viewMode,
    sortBy,
    setSortBy,
    sortDirection,
    setSortDirection,
    accentColor,
    createFolder,
    deleteItem,
    renameItem,
    copyItems,
    cutItems,
    pasteItems,
    clipboard,
    searchFilter,
    navigateTo,
    createNewTab,
    setOpenFileId,
    setShowSpaceAnalyzer,
    openFileForEditing,
    pinnedFolderIds,
    togglePinFolder,
    refreshCurrentDirectory,
    showHiddenItems,
    setShowHiddenItems,
    hideFileExtensions,
    setHideFileExtensions,
    language,
    showFolderSizes,
    driveInfos = [],
  } = explorer;

  const moveOrCopyItems = explorer.moveOrCopyItems;
  const startRenameSelected = explorer.startRenameSelected;
  // Override setter for viewmode (used by Folder Inspector) - lets the
  // Inspector have its own zoom level without affecting the main pane.
  const setEffectiveViewMode = useCallback((val: ViewMode) => {
    if (overrideSetViewMode) {
      overrideSetViewMode(val);
      return;
    }
    explorer.setViewMode(val);
  }, [overrideSetViewMode, explorer.setViewMode]);
  // Inspector mode: when true, single-click only selects (no nav), double-click required to navigate.
  // Prop takes precedence; fallback to detecting via overridePath.
  const isInspectorPane = isInspectorPaneProp ?? Boolean(overridePath);
  const visibleItems = overrideItems ?? items;
  const controlledSelectedIds = overrideSelectedIds ?? selectedIds;
  // Normalize selection IDs to forward slashes for reliable matching with FSItem.id
  const selectedIdsSet = useMemo(
    () => new Set(controlledSelectedIds.map((id) => id.replace(/\\/g, "/"))),
    [controlledSelectedIds]
  );
  const setVisibleSelectedIds = useCallback((ids: string[]) => {
    if (overrideSetSelectedIds) {
      overrideSetSelectedIds(ids);
      return;
    }
    // Use ref to avoid stale closure - always get the latest setSelectedIds
    setSelectedIdsImplRef.current(ids);
    // Sync to multi-select inspector callback - read ref directly to avoid stale closure
    const normalizedIds = ids.map((id) => id.replace(/\\/g, "/"));
    const selectedItems = visibleItems.filter((item) => normalizedIds.includes(item.id.replace(/\\/g, "/")));
    onMultiSelectChangeRef.current?.(selectedItems);
  }, [overrideSetSelectedIds, visibleItems]);
  const effectiveCurrentPath = overridePath ?? activeTab?.currentPath ?? "";
  const isThisPC = effectiveCurrentPath === "shell:::{679F85CB-0220-4080-B29B-5540CC05AAB6}";
  const effectiveViewMode = isThisPC ? 7 : (overrideViewMode ?? viewMode);
  // Independent sort state for the Inspector. When overrides are supplied we
  // render + mutate those values instead of the global explorer ones, so
  // changing the Inspector's sort never disturbs the main pane.
  const effectiveSortBy: SortBy = overrideSortBy ?? sortBy;
  const effectiveSortDirection: SortDirection = overrideSortDirection ?? sortDirection;
  const setEffectiveSortBy = useCallback((val: SortBy) => {
    if (overrideSortBy !== undefined) return; // consumer owns the state
    setSortBy(val);
  }, [overrideSortBy, setSortBy]);
  const setEffectiveSortDirection = useCallback((val: SortDirection) => {
    if (overrideSortDirection !== undefined) return;
    setSortDirection(val);
  }, [overrideSortDirection, setSortDirection]);
  const t = (vi: string, en: string) => language === "vi" ? vi : en;
  const safeOpenWithState = explorer.openWithState ?? {
    visible: false,
    targetPath: null,
    selectedApp: null,
    association: null,
    alwaysUse: false,
    loading: false,
    recentApps: [],
    candidates: null,
  };

  const DRAG_SELECT_DISTANCE_THRESHOLD = 6;
  const DRAG_ITEM_DISTANCE_THRESHOLD = 4;
  const OS_FILE_IMPORT_EXTENSIONS = /\.(txt|md|json|csv|log|xml|yaml|yml|toml|ini|cfg|conf|html|css|js|ts|tsx|jsx|mjs|cjs|py|rs|go|java|c|cpp|h|hpp|cs|rb|php|swift|kt|sh|bat|ps1|env)$/i;

  const [showAllSearchResults, setShowAllSearchResults] = useState(false);
  const [collapsedSearchGroups, setCollapsedSearchGroups] = useState<Record<string, boolean>>({});

  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    clientX: 0,
    clientY: 0,
    targetItem: null,
    showMoreOptions: false,
  });
  const [contextMenuOpenWithFile, setContextMenuOpenWithFile] = useState<FSItem | null>(null);
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [contextMenuHeight, setContextMenuHeight] = useState(420);
  const [contextMenuAdjustedPos, setContextMenuAdjustedPos] = useState<{ x: number; y: number } | null>(null);
  const [isContextMenuHovered, setIsContextMenuHovered] = useState(false);
  // Reset showMoreOptions when context menu closes
  useEffect(() => {
    if (!contextMenu.visible) {
      setShowMoreOptions(false);
      setContextMenuHeight(420); // Reset height for next open
    }
  }, [contextMenu.visible]);
  // Auto-reposition context menu if it overflows viewport
  useEffect(() => {
    if (!contextMenu.visible || !contextMenuRef.current) {
      setContextMenuAdjustedPos(null);
      return;
    }
    const menu = contextMenuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const gap = 12;
    let newX = contextMenu.x;
    let newY = contextMenu.y;

    // Adjust Y if menu overflows bottom
    if (rect.bottom > viewportHeight - gap) {
      newY = Math.max(gap, viewportHeight - rect.height - gap);
    }
    // Adjust X if menu overflows right
    if (rect.right > viewportWidth - gap) {
      newX = Math.max(gap, viewportWidth - rect.width - gap);
    }
    // Adjust Y if menu overflows top (shouldn't happen but safety check)
    if (rect.top < gap) {
      newY = gap;
    }

    if (newX !== contextMenu.x || newY !== contextMenu.y) {
      setContextMenuAdjustedPos({ x: newX, y: newY });
    } else {
      setContextMenuAdjustedPos(null);
    }
  }, [contextMenu.visible, contextMenu.x, contextMenu.y]);
  // Phase 2.2: anchors for the in-menu hover submenus (New only — Delete
  // was demoted to a single button in the Command Bar so it doesn't
  // need an anchor; OpenWith/View/Sort already have their own anchors).
  const [newSubmenuAnchor, setNewSubmenuAnchor] = useState<{ x: number; y: number } | null>(null);
  // Group by submenu (background menu only).
  const [groupBySubmenuAnchor, setGroupBySubmenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const contextTargetItem = contextMenu.targetItem ?? (selectedIdsSet.size === 1 ? visibleItems.find((entry) => selectedIdsSet.has(entry.id.replace(/\\/g, "/"))) ?? null : null);
  const effectiveContextFile = contextMenuOpenWithFile ?? (() => {
    if (contextTargetItem?.type === "file") return contextTargetItem;
    const selectedFileIds = controlledSelectedIds
      .map((id) => visibleItems.find((entry) => entry.id.replace(/\\/g, "/") === id.replace(/\\/g, "/")) ?? null)
      .filter((entry): entry is FSItem => Boolean(entry) && entry.type === "file");
    return selectedFileIds.length === 1 ? selectedFileIds[0] : null;
  })();

  const [renamingId, _setRenamingId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renamingIdRef = useRef<string | null>(null);
  const pendingBlurRef = useRef(false);

  // Selection batching ref - batch multiple selection updates into single RAF update
  const selectionBatchingRef = useRef<{
    rafId: number | null;
    pendingIds: string[] | null;
    previewIds: string[] | null;
  }>({ rafId: null, pendingIds: null, previewIds: null });

  const flushSelectionBatch = useCallback(() => {
    const batch = selectionBatchingRef.current;
    if (batch.rafId !== null) {
      cancelAnimationFrame(batch.rafId);
      batch.rafId = null;
    }
    if (batch.pendingIds !== null) {
      // Use previewIds if available (for drag selection), otherwise use pendingIds
      const ids = batch.previewIds ?? batch.pendingIds;
      commitSelection(ids);
      batch.pendingIds = null;
      batch.previewIds = null;
    }
  }, []);

  // Wrap setRenamingId so ref stays in sync with state synchronously.
  // React's useEffect sync is async (runs after render), causing viewport click
  // to see stale ref values. Using a ref as the source of truth fixes this.
  const setRenamingId = (id: string | null) => {
    renamingIdRef.current = id;
    _setRenamingId(id);
  };

  // Slow-click rename: tracks last click timestamp to distinguish slow click from double-click
  // Drag State
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [isExternalFileDragActive, setIsExternalFileDragActive] = useState(false);
  const [dragDropMode, setDragDropMode] = useState<"none" | "copy" | "move" | "external-copy">("none");
  const [dragGhost, setDragGhost] = useState<{
    visible: boolean;
    x: number;
    y: number;
    label: string;
    count: number;
    mode: "copy" | "move";
  }>({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });
  const [contextMenuSelectionSnapshot, setContextMenuSelectionSnapshot] = useState<string[]>([]);
  const [openWithSubmenuAnchor, setOpenWithSubmenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [viewSubmenuAnchor, setViewSubmenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [sortSubmenuAnchor, setSortSubmenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const submenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isNativeDragActiveRef = useRef(false);
  const pointerDownOnItemRef = useRef(false);
  const viewportPointerClickSuppressRef = useRef(false);
  const pointerDragSessionRef = useRef<{
    active: boolean;
    sourceIds: string[];
    primaryId: string | null;
    latestClientX: number;
    latestClientY: number;
    ctrlKey: boolean;
  }>({ active: false, sourceIds: [], primaryId: null, latestClientX: 0, latestClientY: 0, ctrlKey: false });
  const pointerDownMetaRef = useRef<{
    itemId: string | null;
    x: number;
    y: number;
    moved: boolean;
    dragIntent: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    selectionSnapshot: string[];
  }>({ itemId: null, x: 0, y: 0, moved: false, dragIntent: false, ctrlKey: false, shiftKey: false, selectionSnapshot: [] });

  // Captures the item being moused-down for the pending click event.
  // This is needed because pointerUp clears pointerDownMetaRef.itemId before
  // the click event fires, but onMouseDown always runs before onClick in the
  // React event cycle, making this ref a reliable bridge.
  const pendingClickItemIdRef = useRef<string | null>(null);

  // Store internal drag state in ref to avoid dataTransfer unreliability on drop
  const internalDragStateRef = useRef<{
    active: boolean;
    sourceIds: string[];
    sourcePaths: string[];
    mode: "copy" | "move";
  }>({ active: false, sourceIds: [], sourcePaths: [], mode: "move" });

  // Track if native drag-out has been started (to prevent multiple triggers)
  const nativeDragStartedRef = useRef(false);
  // Timestamp (ms) when the last native drag was initiated. Used to ignore any
  // HTML5 drop event that fires shortly after a native OLE drag completes (the
  // browser still holds the DataTransfer with our internal marker types).
  const lastNativeDragStartAtRef = useRef<number>(0);
  // Set to true once a watchdog timer has been armed for the current drag
  // session, so we don't schedule multiple Esc-injection timeouts if the
  // pointermove handler is re-entered.
  const watchdogFiredForDragRef = useRef(false);
  // Set when the force-reset block fires (after start_native_drag returns).
  // For a short window afterwards the React ghost is forcibly hidden even
  // if subsequent pointermove/pointerdown events briefly race in. This is
  // belt-and-braces protection against the ghost sticking on screen after
  // a drop-outside-app + return sequence.
  const forceResetAtRef = useRef<number>(0);

  // Track pending internal drag operation: when user drags files to the same
  // folder, the OS doesn't perform any action, so we need to handle it ourselves
  // after the native drag ends. This ref stores the operation details.
  const pendingInternalDropRef = useRef<{
    sourcePaths: string[];
    targetPath: string;
    mode: "copy" | "move";
  } | null>(null);

  // Listen for X1/X2 side-button clicks (fired from App.tsx in capture
  // phase). When the user clicks X1/X2 we drop any in-flight drag meta so
  // a subsequent pointermove over an item doesn't re-arm the React ghost.
  useEffect(() => {
    const onAuxClick = () => {
      pointerDownMetaRef.current = { itemId: null, x: 0, y: 0, moved: false, dragIntent: false, ctrlKey: false, shiftKey: false, selectionSnapshot: [] };
      pointerDownOnItemRef.current = false;
      pendingClickItemIdRef.current = null;
      pointerDragSessionRef.current = { active: false, sourceIds: [], primaryId: null, latestClientX: 0, latestClientY: 0, ctrlKey: false };
      internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
      setDragGhost({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });
      setDragOverFolderId(null);
    };
    document.addEventListener("goku:aux-click", onAuxClick);
    return () => document.removeEventListener("goku:aux-click", onAuxClick);
  }, []);

  // Rectangle Selection State
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);

  // Returns true if a native OLE drag was initiated recently (within the last
  // 3 seconds) — guards against the browser's lingering HTML5 drag state
  // re-triggering an internal copy/move when the user re-enters the window.
  const wasRecentNativeDrag = () => {
    if (nativeDragStartedRef.current || isNativeDragActiveRef.current) return true;
    const since = Date.now() - lastNativeDragStartAtRef.current;
    // Widened from 3000ms → 15000ms. Native OLE drags can take a long time
    // when the user drags to another app, hovers, then drags back. If we
    // narrow this window, React's drop handler can fire while OLE is still
    // active and we end up with a duplicate ghost + a bogus internal copy.
    return since >= 0 && since < 15000;
  };
  const [selectionRect, setSelectionRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const selectionPreviewIdsRef = useRef<string[] | null>(null);
  const selectionSessionRef = useRef<{
    active: boolean;
    pointerId: number | null;
    startX: number;
    startY: number;
    startSelectionIds: string[];
    ctrlKey: boolean;
    shiftKey: boolean;
    moved: boolean;
  }>({
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    startSelectionIds: [],
    ctrlKey: false,
    shiftKey: false,
    moved: false,
  });
  const selectionRectCacheRef = useRef<Array<{ id: string; rect: DOMRect }>>([]);
  const lastMarqueeSelectionRef = useRef<string[]>([]);
  const lastClickedItemIdRef = useRef<string | null>(null);

  // Store the modifier keys at the moment of pointerDown.
  // This is separate from pointerDownMetaRef because that ref is reset in pointerUp
  // BEFORE the click event fires (if the user releases the mouse button before releasing the key).
  const pointerDownKeysRef = useRef<{ ctrlKey: boolean; shiftKey: boolean }>({ ctrlKey: false, shiftKey: false });

  // Block clicks briefly after context menu action (prevent accidental click-through)
  const contextMenuActiveRef = useRef<boolean>(false);

  // Local slider state for the View Mode submenu (mirrors Header pattern).
  // Decoupling the slider thumb from the global viewMode lets us drag smoothly
  // without spamming setViewMode on every onInput tick.
  const viewSliderDraggingRef = useRef<boolean>(false);
  const [localViewSlider, setLocalViewSlider] = useState<number | null>(null);

  // Detail View column widths (resizable)
  const [columnWidths, setColumnWidths] = useState<{ name: number; date: number; type: number; size: number }>(() => {
    const saved = localStorage.getItem("NEXUS_DETAIL_COLUMNS");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.name && parsed.date && parsed.type && parsed.size) return parsed;
      } catch { /* ignore */ }
    }
    return { name: 280, date: 160, type: 100, size: 80 };
  });
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  const resizingStartXRef = useRef<number>(0);
  const resizingStartWidthRef = useRef<number>(0);

  // Detail View filter state
  type DateFilterPreset = 'today' | 'yesterday' | 'lastWeek' | 'earlierThisMonth' | 'earlierThisYear' | 'longTimeAgo';
  interface DateFilterState {
    active: boolean;
    mode: 'specific' | 'range' | 'preset';
    specificDate?: string;
    startDate?: string;
    endDate?: string;
    preset?: DateFilterPreset;
  }
  const [dateFilter, setDateFilter] = useState<DateFilterState>({ active: false, mode: 'preset' });
  const [dateFilterDropdownOpen, setDateFilterDropdownOpen] = useState(false);
  const dateFilterDropdownRef = useRef<HTMLDivElement>(null);

  // Type filter state
  const [typeFilter, setTypeFilter] = useState<{ active: boolean; selectedTypes: Set<string> }>({ active: false, selectedTypes: new Set() });
  const [typeFilterDropdownOpen, setTypeFilterDropdownOpen] = useState(false);
  const typeFilterDropdownRef = useRef<HTMLDivElement>(null);

  // Thumbnail state
  const [thumbs, setLocalThumbs] = useState<Record<string, string | null>>({});
  const thumbsInFlight = useRef<Set<string>>(new Set());
  const lastThumbFolderRef = useRef<string>("");
  // Ref so the thumbnail-ready listener (registered once with [] deps) and
  // loadThumbnails (declared before `activeResultsViewMode` is computed) can
  // both read the current view mode at IPC time without capturing stale state.
  const viewModeForReadyRef = useRef<ViewMode | null>(null);

  // Sync thumbs state to global store for other components to read
  useEffect(() => {
    setThumbsGlobal(thumbs);
  }, [thumbs]);



  const containerRef = useRef<HTMLDivElement>(null);
  const shiftKeyRef = useRef(false);
  const ctrlKeyRef = useRef(false);
  const typeSelectBufferRef = useRef("");
  const typeSelectResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // RAF-based updates for smooth rectangle selection (avoids React re-render on every pixel)
  const rafIdRef = useRef<number>(0);
  const pendingRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  // Ref for selection overlay DOM element (for direct manipulation)
  const selectionOverlayRef = useRef<HTMLDivElement>(null);
  const viewportElementRef = useRef<HTMLDivElement | null>(null);
  const sortedChildrenRef = useRef<FSItem[]>([]);
  const activeTabPathRef = useRef<string>("");
  const handleItemPointerUpRef = useRef<(itemId?: string) => void>(() => {});

  // Refs to store latest values for event handlers (avoid stale closures)
  const isSelectingRef = useRef(isSelecting);
  const selectionRectRef = useRef(selectionRect);
  const setSelectedIdsRef = useRef(setVisibleSelectedIds);
  const itemsRef = useRef(visibleItems);
  // Ref to avoid stale setSelectedIds closure in setVisibleSelectedIds
  const setSelectedIdsImplRef = useRef(setSelectedIds);
  // Refs for callbacks passed from parent (to avoid dependency on callbacks in useEffect)
  const onMultiSelectChangeRef = useRef(onMultiSelectChange);
  const onClearMultiSelectRef = useRef(onClearMultiSelect);
  const onCloseFolderInspectionRef = useRef(onCloseFolderInspection);
  const onFolderClickRef = useRef(onFolderClick);
  const onFileClickRef = useRef(onFileClick);
  const onViewportClickRef = useRef(onViewportClick);
  const selectedIdsRef = useRef(controlledSelectedIds);
  const useEffectRunningRef = useRef(false);
  // Ref to track anchor for Shift+Arrow keyboard selection (avoids stale closure issues)
  const shiftArrowAnchorRef = useRef<string | null>(null);
  // Ref to track current edge index during Shift+Arrow session
  const shiftArrowEdgeIdxRef = useRef<number>(-1);

  const updateSelectionSideEffects = useCallback((ids: string[], skipFolderClick: boolean = false) => {
    if (ids.length >= 2) {
      // In inspector pane mode, multi-select should NOT trigger MultiSelectInspector
      // It should just be a simple selection without triggering parent callbacks
      if (!isInspectorPane) {
        const normalizedIds = ids.map((id) => id.replace(/\\/g, "/"));
        const selectedItems = itemsRef.current.filter((item) => normalizedIds.includes(item.id.replace(/\\/g, "/")));
        onMultiSelectChangeRef.current?.(selectedItems);
      }
      return;
    }

    // In inspector mode (overridePath set), skip folder click side effects.
    // Single-click in inspector pane should only select, not navigate.
    if (skipFolderClick || isInspectorPane) {
      if (ids.length === 0) {
        onClearMultiSelectRef.current?.();
        onViewportClickRef.current?.();
      }
      return;
    }

    if (ids.length === 1) {
      const targetId = ids[0].replace(/\\/g, "/");
      const selectedItem = itemsRef.current.find((item) => item.id.replace(/\\/g, "/") === targetId);
      if (selectedItem?.type === "directory") {
        onFolderClickRef.current?.(selectedItem.path, selectedItem.name);
      } else if (selectedItem) {
        onFileClickRef.current?.();
      }
      return;
    }

    onClearMultiSelectRef.current?.();
    onViewportClickRef.current?.();
  }, [isInspectorPane]);

  const commitSelection = useCallback((ids: string[], options?: { suppressViewportClear?: boolean }) => {
    const normalizedIds = ids.map((id) => id.replace(/\\/g, "/"));
    selectionPreviewIdsRef.current = null;
    selectedIdsRef.current = normalizedIds;
    setSelectedIdsRef.current(normalizedIds);

    if (normalizedIds.length === 0 && options?.suppressViewportClear) {
      return;
    }

    updateSelectionSideEffects(normalizedIds);
  }, [updateSelectionSideEffects]);

  const previewSelection = useCallback((ids: string[]) => {
    const normalizedIds = ids.map((id) => id.replace(/\\/g, "/"));
    selectionPreviewIdsRef.current = normalizedIds;
    selectedIdsRef.current = normalizedIds;
    setSelectedIdsRef.current(normalizedIds);
    updateSelectionSideEffects(normalizedIds);
  }, [updateSelectionSideEffects]);

  // Track pending internal drag operation for same-folder drops
  // (this is also declared as a useRef at the top of the component)
  const batchedCommitSelection = useCallback((ids: string[], options?: { suppressViewportClear?: boolean }) => {
    const batch = selectionBatchingRef.current;
    const normalizedIds = ids.map((id) => id.replace(/\\/g, "/"));

    // Cancel any pending RAF
    if (batch.rafId !== null) {
      cancelAnimationFrame(batch.rafId);
    }

    // Update refs immediately for accurate state during drag
    selectionPreviewIdsRef.current = null;
    selectedIdsRef.current = normalizedIds;

    // Schedule RAF to commit to React state
    batch.rafId = requestAnimationFrame(() => {
      batch.rafId = null;
      batch.pendingIds = normalizedIds;
      if (options?.suppressViewportClear) {
        return;
      }
      updateSelectionSideEffects(normalizedIds);
    });

    // Also update the actual setter via ref
    setSelectedIdsRef.current(normalizedIds);
  }, [updateSelectionSideEffects]);

  // Helper for keyboard navigation: set selection AND trigger side effects (multi-select inspector)
  const setSelectionWithSideEffects = useCallback((ids: string[]) => {
    const normalizedIds = ids.map((id) => id.replace(/\\/g, "/"));
    selectedIdsRef.current = normalizedIds;
    setVisibleSelectedIds(normalizedIds);
    // Trigger multi-select inspector update for multi-item selection
    if (normalizedIds.length >= 2) {
      const normalizedSel = normalizedIds.map(id => id.replace(/\\/g, "/"));
      const selectedItems = itemsRef.current.filter((item) => normalizedSel.includes(item.id.replace(/\\/g, "/")));
      onMultiSelectChangeRef.current?.(selectedItems);
    }
  }, []);

  // Batched preview selection - for drag selection that doesn't need immediate UI update
  const batchedPreviewSelection = useCallback((ids: string[]) => {
    const batch = selectionBatchingRef.current;
    const normalizedIds = ids.map((id) => id.replace(/\\/g, "/"));

    // Update refs immediately
    selectionPreviewIdsRef.current = normalizedIds;
    selectedIdsRef.current = normalizedIds;

    // If no RAF pending, schedule one
    if (batch.rafId === null) {
      batch.rafId = requestAnimationFrame(() => {
        batch.rafId = null;
        batch.pendingIds = batch.previewIds ?? normalizedIds;
        batch.previewIds = null;
        updateSelectionSideEffects(batch.pendingIds);
      });
    } else {
      // Update preview IDs - will be committed on next RAF
      batch.previewIds = normalizedIds;
    }

    setSelectedIdsRef.current(normalizedIds);
  }, [updateSelectionSideEffects]);

  const applySelection = useCallback((ids: string[], options?: { suppressViewportClear?: boolean }) => {
    commitSelection(ids, options);
  }, [commitSelection]);

  const renderSelectionOverlay = useCallback((rect: { x: number; y: number; width: number; height: number } | null) => {
    const overlay = selectionOverlayRef.current;
    if (!overlay || !rect) {
      if (overlay) {
        overlay.style.display = "none";
      }
      return;
    }

    overlay.style.display = "block";
    overlay.style.left = `${rect.x}px`;
    overlay.style.top = `${rect.y}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.borderColor = `${accentColor}`;
    overlay.style.backgroundColor = `${accentColor}20`;
  }, [accentColor]);

  const rectsIntersect = useCallback((r1: DOMRect, r2: DOMRect) => {
    return !(r2.left > r1.right || r2.right < r1.left || r2.top > r1.bottom || r2.bottom < r1.top);
  }, []);

  const calculateMarqueeSelection = useCallback((selectionIds: string[]) => {
    const startSel = selectionSessionRef.current.startSelectionIds;
    const isCtrlLikeActive = selectionSessionRef.current.ctrlKey;
    const isShiftActive = selectionSessionRef.current.shiftKey;

    if (isCtrlLikeActive) {
      // Ctrl+Marquee: deselect items INSIDE the marquee area (Windows behavior)
      // Normalize paths for comparison
      const normalizedSel = selectionIds.map(id => id.replace(/\\/g, "/"));
      return startSel.filter(id => !normalizedSel.includes(id.replace(/\\/g, "/")));
    }

    if (isShiftActive) {
      return Array.from(new Set([
        ...startSel,
        ...selectionIds,
      ]));
    }

    return selectionIds;
  }, []);

  const stopSelectionRaf = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
    }
  }, []);

  const flushPendingSelectionRect = useCallback(() => {
    if (!pendingRectRef.current) {
      renderSelectionOverlay(null);
      return;
    }

    const rect = pendingRectRef.current;
    setSelectionRect(rect);
    renderSelectionOverlay(rect);
  }, [renderSelectionOverlay]);

  const scheduleSelectionRectUpdate = useCallback((rect: { x: number; y: number; width: number; height: number } | null) => {
    pendingRectRef.current = rect;
    if (rafIdRef.current) return;

    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = 0;
      flushPendingSelectionRect();
    });
  }, [flushPendingSelectionRect]);

  useEffect(() => {
    isSelectingRef.current = isSelecting;
  }, [isSelecting]);
  useEffect(() => {
    selectionRectRef.current = selectionRect;
    renderSelectionOverlay(selectionRect);
  }, [renderSelectionOverlay, selectionRect]);
  useEffect(() => {
    setSelectedIdsRef.current = setVisibleSelectedIds;
  }, [setVisibleSelectedIds]);
  useEffect(() => {
    setSelectedIdsImplRef.current = setSelectedIds;
  }, [setSelectedIds]);
  // Keep selectedIdsRef in sync with the controlled prop. Without this the
  // ref can become stale when the parent updates selectedIds through any path
  // that does not go through commitSelection (e.g. App.tsx setSelectedIds
  // calls triggered by transfer completions, keyboard nav, or upstream state
  // changes). A stale ref means handleItemPointerMove's `currentSelection`
  // only sees the single item being dragged — and the multi-selection the
  // user just built is silently dropped the moment they start dragging.
  useEffect(() => {
    // Only sync if the ref looks truly out-of-date (length differs). This
    // avoids overwriting a perfectly fresh ref that commitSelection just
    // wrote a frame ago, which would otherwise wipe out a multi-selection
    // when the parent's controlled prop briefly flickers (e.g. between two
    // setSelectedIds calls inside the same event handler).
    if (selectedIdsRef.current.length !== controlledSelectedIds.length) {
      selectedIdsRef.current = controlledSelectedIds.map((id) => id.replace(/\\/g, "/"));
    }
  }, [controlledSelectedIds]);
  // Note: itemsRef is kept in sync with the active view (folder contents or
  // search results) by the useEffect below — declared after
  // isSearchResultsMode / visibleSearchItems are defined.
  useEffect(() => {
    onMultiSelectChangeRef.current = onMultiSelectChange;
  }, [onMultiSelectChange]);
  useEffect(() => {
    onClearMultiSelectRef.current = onClearMultiSelect;
  }, [onClearMultiSelect]);
  useEffect(() => {
    onCloseFolderInspectionRef.current = onCloseFolderInspection;
  }, [onCloseFolderInspection]);
  useEffect(() => {
    onFolderClickRef.current = onFolderClick;
  }, [onFolderClick]);
  useEffect(() => {
    onFileClickRef.current = onFileClick;
  }, [onFileClick]);
  useEffect(() => {
    onViewportClickRef.current = onViewportClick;
  }, [onViewportClick]);
  // Global Backspace handler — works even when the viewport is not focused,
  // matching Windows Explorer's Alt+Left / Backspace behavior for folder navigation.
  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Backspace") return;
      const activeEl = document.activeElement;
      // Skip if user is typing in an input/textarea/rename field
      if (activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA" || (activeEl as HTMLElement).isContentEditable)) return;
      // Skip if a context/command menu is open
      if (contextMenu.visible) return;

      event.preventDefault();
      const currentPath = activeTabPathRef.current;
      if (!currentPath) return;
      const parentPath = getParentPath(currentPath);
      if (parentPath !== currentPath) {
        navigateTo(parentPath);
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [navigateTo]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      shiftKeyRef.current = event.shiftKey;
      ctrlKeyRef.current = event.ctrlKey || event.metaKey;
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      shiftKeyRef.current = event.shiftKey;
      ctrlKeyRef.current = event.ctrlKey || event.metaKey;
    };

    const handleWindowBlur = () => {
      shiftKeyRef.current = false;
      ctrlKeyRef.current = false;
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  useEffect(() => {
    const handleGlobalPointerMove = async (event: PointerEvent) => {
      const dragSession = pointerDragSessionRef.current;
      if (!dragSession.active) return;

      dragSession.latestClientX = event.clientX;
      dragSession.latestClientY = event.clientY;
      dragSession.ctrlKey = event.ctrlKey || event.metaKey;
      
      // Update dragMode in internalDragStateRef if Ctrl key state changed
      if (internalDragStateRef.current.active) {
        const newMode = dragSession.ctrlKey ? "copy" : "move";
        if (internalDragStateRef.current.mode !== newMode) {
          internalDragStateRef.current.mode = newMode;
        }
      }

      const rect = containerRef.current?.getBoundingClientRect();
      const isOutsideWindow = rect ? (
        event.clientX < rect.left - 10 ||
        event.clientX > rect.right + 10 ||
        event.clientY < rect.top - 10 ||
        event.clientY > rect.bottom + 10
      ) : (
        event.clientX < 0 ||
        event.clientY < 0 ||
        event.clientX > window.innerWidth ||
        event.clientY > window.innerHeight
      );

      if (isOutsideWindow && !nativeDragStartedRef.current) {
        nativeDragStartedRef.current = true;
        // Hide ghost immediately so it can't get stuck on the cursor after
        // the OS returns control to us. Synchronous state set before any
        // further pointermove events can re-set it visible.
        setDragGhost({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });
        setDragOverFolderId(null);
        setDraggedItemId(null);

        const dragState = internalDragStateRef.current;
        if (dragState.active && dragState.sourcePaths.length > 0) {
          const mode = dragState.mode;
          const primaryPath = dragState.sourcePaths[0];
          
          // Get icon for drag preview (try to get thumbnail, but don't fail if not available)
          let iconPath = "";
          try {
            iconPath = await invoke("get_drag_icon_path", {
              path: primaryPath,
              size: 48
            }) as string;
          } catch (iconError) {
            console.warn("Could not get drag icon, using OS default:", iconError);
          }
          
          // Set flag to track native drag is in progress
          nativeDragStartedRef.current = true;
          // Record timestamp so any HTML5 drop event fired shortly after the
          // OLE drag completes is still recognised as "after native drag" and
          // ignored — the browser DataTransfer still carries our marker types
          // for a short window and could otherwise re-trigger an internal copy.
          lastNativeDragStartAtRef.current = Date.now();

          // Save the drag operation details for same-folder drop handling
          // (OS doesn't do anything when source = target folder, so we handle it ourselves)
          const sourcePaths = [...dragState.sourcePaths];
          const dragMode = mode;
          const sourceParentPath = getParentPath(primaryPath);

          // Save to ref for later processing
          pendingInternalDropRef.current = {
            sourcePaths,
            targetPath: sourceParentPath,
            mode: dragMode,
          };

          // Clear HTML5 internal-drag state immediately so any subsequent
          // browser drag/drop event (which fires after the OLE drag completes)
          // does NOT trigger a spurious internal copy/move. The OS is now in
          // charge of the drag — we must ignore React-level drag events until
          // the user starts a fresh drag.
          internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
          // CRITICAL: also clear the pointer drag session, otherwise when the
          // OS returns control after a drop (or after our watchdog cancels
          // the OLE drag) the next pointermove inside the window passes the
          // `!pointerDragSessionRef.current.active` guard at line 879 and
          // resurrects the React ghost at line 883 with stale label="" — this
          // is the root cause of the "Move item" tooltip sticking on the cursor.
          pointerDragSessionRef.current = { active: false, sourceIds: [], primaryId: null, latestClientX: 0, latestClientY: 0, ctrlKey: false };
          setDraggedItemId(null);
          setDragGhost({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });
          setDragOverFolderId(null);

          // Start native drag via tauri-plugin-drag (wraps drag-rs crate)
          try {
            await startDrag({
              item: dragState.sourcePaths,
              icon: iconPath || dragState.sourcePaths[0] || "",
              mode: "copy", // Always copy when dragging to external apps - file must stay in original location
            });

            // For internal drag within same folder, the OS doesn't perform any action
            // (no file copy/move happens when source = target). We need to handle this ourselves.
            // Schedule a check after a short delay - if no external event handled the drop,
            // we'll process it as a same-folder copy/move operation.
            setTimeout(async () => {
              const pending = pendingInternalDropRef.current;
              if (!pending) {
                return;
              }

              // Check if this was an internal drag (source and target are the same folder)
              const currentTabPath = activeTabPathRef.current;
              if (pending.sourcePaths.length > 0) {
                const sourceParent = getParentPath(pending.sourcePaths[0]);

                if (currentTabPath && sourceParent === currentTabPath) {
                  try {
                    if (pending.mode === "copy") {
                      // Create copies with "Copy of" prefix
                      for (const sourcePath of pending.sourcePaths) {
                        const fileName = sourcePath.split(/[/\\]/).pop() || "file";
                        const newName = `Copy of ${fileName}`;
                        const newPath = joinPath(currentTabPath, newName);
                        await invoke("copy_file", { source: sourcePath, dest: newPath });
                      }
                    } else {
                      // Move operation within same folder - rename with suffix
                      // (OS already handled move if target is different folder)
                    }
                    await refreshCurrentDirectory?.();
                    explorer.setStatusMessage(
                      language === "vi"
                        ? `Đã sao chép ${pending.sourcePaths.length} mục trong thư mục hiện tại.`
                        : `Copied ${pending.sourcePaths.length} item(s) in current folder.`
                    );
                  } catch (err) {
                    console.error("[startDrag] Internal drop handling failed:", err);
                    explorer.setStatusMessage(`Internal drop error: ${err}`);
                  }
                }
              }

              // Clear pending
              pendingInternalDropRef.current = null;
            }, 500);
          } catch (dragErr) {
          }

          // Force-reset React drag state IMMEDIATELY after OLE drag returns.
          // Previously we waited 3 s before resetting, but that left a window
          // where the React ghost could be re-enabled by a stale pointermove.
          // The 3 s delayed reset is still useful as a safety net (see below)
          // but the primary reset happens here.
          nativeDragStartedRef.current = false;
          isNativeDragActiveRef.current = false;
          // Clear the native drag timestamp so handleViewportDrop can process any
          // subsequent HTML5 drop event (especially for same-folder internal drops
          // where the OS didn't perform any file operation).
          lastNativeDragStartAtRef.current = 0;
          pointerDragSessionRef.current = { active: false, sourceIds: [], primaryId: null, latestClientX: 0, latestClientY: 0, ctrlKey: false };
          internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
          // CRITICAL: reset pointerDownMetaRef so a subsequent pointermove over
          // the previously-dragged item does NOT re-trigger handleItemPointerMove
          // and resurrect the React ghost. The OS owns the drag-out completion
          // path, and pointerUp may never fire in our window if the user
          // released the mouse outside the app.
          pointerDownMetaRef.current = { itemId: null, x: 0, y: 0, moved: false, dragIntent: false, ctrlKey: false, shiftKey: false, selectionSnapshot: [] };
          pointerDownOnItemRef.current = false;
          pendingClickItemIdRef.current = null;
          // Stamp force-reset so any racing pointermove/pointerdown events
          // that arrive in the next 1000ms are guarded against re-showing
          // the React ghost before the React render flushes the new state.
          forceResetAtRef.current = Date.now();
          setDraggedItemId(null);
          setDragGhost({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });
          setDragOverFolderId(null);
          
          // After native drag starts, schedule a delayed reset. The OLE drag may
          // take a few seconds (user dragging across the screen, then dropping
          // on another app), and `dragend` may not fire at all if the drop
          // happens outside our window or the Rust callback is dropped
          // (we've seen "Couldn't find callback id" errors). 3 seconds is
          // generous enough for normal drags while still preventing the
          // React drag-ghost from getting stuck forever.
          setTimeout(() => {
            if (nativeDragStartedRef.current || pointerDragSessionRef.current.active) {
              nativeDragStartedRef.current = false;
              isNativeDragActiveRef.current = false;
              pointerDragSessionRef.current = { active: false, sourceIds: [], primaryId: null, latestClientX: 0, latestClientY: 0, ctrlKey: false };
              internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
              setDraggedItemId(null);
              setDragGhost({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });
              setDragOverFolderId(null);
              explorer?.refreshCurrentDirectory?.();
            }
          }, 3000);

          // HARD watchdog: if the OLE drag has not returned after 8 seconds,
          // the drop target is misbehaving (or the user clicked away). Ask
          // Rust to synthesise an Escape keypress which Windows uses to
          // cancel DoDragDrop — this clears the sticky drag preview tooltip
          // and unblocks the await above. The watchdog fires only once per
          // drag session to avoid spamming SendInput.
          if (!watchdogFiredForDragRef.current) {
            watchdogFiredForDragRef.current = true;
            setTimeout(() => {
              if (nativeDragStartedRef.current || pointerDragSessionRef.current.active) {
                invoke("cancel_native_drag").catch(() => {});
              }
            }, 8000);
          }
          
          return;
        }
        return;
      }

      if (nativeDragStartedRef.current) {
        return;
      }
      // Also skip if a native drag JUST completed — otherwise the very next
      // pointermove after the 500ms reset timer fires will resurrect the ghost.
      if (wasRecentNativeDrag()) {
        return;
      }
      // Block ghost resurrection for 5s after a force-reset. The React
      // render that hides the ghost may not have flushed yet, so without
      // this guard a fast pointermove could re-enable visible:true with
      // stale label/count.
      if (forceResetAtRef.current > 0 && Date.now() - forceResetAtRef.current < 5000) {
        return;
      }

      // CRITICAL: Only show the ghost while a real drag session is active.
      // Without this guard, plain pointermove events (e.g. when the user is
      // simply clicking on an item after returning from a native drag) reset
      // the ghost back to visible:true with empty label/count, recreating
      // the stuck "Move" tooltip.
      if (!pointerDragSessionRef.current.active) {
        return;
      }

      setDragGhost((prev) => {
        // Hard safety net: don't re-show a ghost with empty label/count.
        // If prev is already invisible (which it should be after we cleared
        // state when OLE drag started), keep it invisible. This protects
        // against any future code path that re-enables ghost without data.
        if (!prev.label && !prev.count) {
          return prev;
        }
        return {
          ...prev,
          visible: true,
          x: event.clientX,
          y: event.clientY,
          mode: (event.ctrlKey || event.metaKey) ? "copy" : "move",
        };
      });

      const hoveredElement = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const hoveredItem = hoveredElement?.closest("[data-item-id][data-item-type='directory']") as HTMLElement | null;
      const hoveredFolderId = hoveredItem?.getAttribute("data-item-id");
      const primaryId = dragSession.primaryId;
      if (hoveredFolderId && hoveredFolderId !== primaryId) {
        setDragOverFolderId(hoveredFolderId);
      } else {
        setDragOverFolderId(null);
      }
    };

    const handleGlobalPointerUp = () => {
      const dragSession = pointerDragSessionRef.current;
      if (!dragSession.active) return;
      handleItemPointerUpRef.current(dragSession.primaryId ?? undefined);
    };

// Reset any lingering drag UI state (ghost, hovered folder highlight,
// selection badge) the first time the user clicks back into the window
// after a native OLE drag. Without this, the "Move item" tooltip can
// stick on the cursor until the user starts a fresh drag.
    const handleWindowFirstPointerDown = () => {
      if (lastNativeDragStartAtRef.current > 0) {
        const since = Date.now() - lastNativeDragStartAtRef.current;
        if (since >= 0 && since < 5000) {
          setDragGhost({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });
          setDragOverFolderId(null);
          setDraggedItemId(null);
          pointerDragSessionRef.current = { active: false, sourceIds: [], primaryId: null, latestClientX: 0, latestClientY: 0, ctrlKey: false };
          internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
          lastNativeDragStartAtRef.current = 0;
          nativeDragStartedRef.current = false;
          isNativeDragActiveRef.current = false;
        }
      }
    };

    // When the user releases the mouse while the cursor is outside the app
    // window (e.g. dropping a file onto another application), no pointerup
    // event ever reaches our window. The dragend handler on document covers
    // the normal case, but if it never fires (HMR reload, callback dropped)
    // the "Move item" ghost stays stuck forever. Listen for pointerleave on
    // the document; when the pointer leaves and nativeDragStartedRef is
    // true, kick the same fallback reset used by the 500ms timeout.
    const handleWindowPointerLeave = () => {
      if (!nativeDragStartedRef.current && !pointerDragSessionRef.current.active) return;
      if (wasRecentNativeDrag()) return; // 500ms reset already in flight
      // Defer one frame: if the user actually dropped inside our window we
      // would have received pointerup by then and reset already.
      setTimeout(() => {
        if (nativeDragStartedRef.current || pointerDragSessionRef.current.active) {
          nativeDragStartedRef.current = false;
          pointerDragSessionRef.current = { active: false, sourceIds: [], primaryId: null, latestClientX: 0, latestClientY: 0, ctrlKey: false };
          internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
          setDragGhost({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });
          setDragOverFolderId(null);
          setDraggedItemId(null);
          isNativeDragActiveRef.current = false;
        }
      }, 250);
    };

    window.addEventListener("pointermove", handleGlobalPointerMove, true);
    window.addEventListener("pointerup", handleGlobalPointerUp, true);
    window.addEventListener("pointercancel", handleGlobalPointerUp, true);
    window.addEventListener("pointerdown", handleWindowFirstPointerDown, true);
    // When the pointer leaves the entire viewport we may be heading into a
    // drop on another app. Schedule a defensive reset; if a real pointerup
    // or dragend arrives before the timer fires it will reset anyway and
    // the next check inside the timeout is a no-op.
    const handleViewportMouseLeave = () => {
      if (!nativeDragStartedRef.current && !pointerDragSessionRef.current.active) return;
      setTimeout(() => {
        if (nativeDragStartedRef.current || pointerDragSessionRef.current.active) {
          nativeDragStartedRef.current = false;
          isNativeDragActiveRef.current = false;
          pointerDragSessionRef.current = { active: false, sourceIds: [], primaryId: null, latestClientX: 0, latestClientY: 0, ctrlKey: false };
          internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
          setDragGhost({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });
          setDragOverFolderId(null);
          setDraggedItemId(null);
        }
      }, 250);
    };
    // When the window loses focus mid-drag (e.g. user pressed Escape or
    // Alt-Tabbed away to drop on another app), assume the drag is over from
    // React's perspective. Resetting on blur is much more reliable than
    // relying on pointerup/dragend, which never fire when the drop happens
    // outside our window.
    const handleWindowBlur = () => {
      if (!nativeDragStartedRef.current && !pointerDragSessionRef.current.active) return;
      nativeDragStartedRef.current = false;
      isNativeDragActiveRef.current = false;
      pointerDragSessionRef.current = { active: false, sourceIds: [], primaryId: null, latestClientX: 0, latestClientY: 0, ctrlKey: false };
      internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
      setDragGhost({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });
      setDragOverFolderId(null);
      setDraggedItemId(null);
    };
    document.documentElement.addEventListener("mouseleave", handleViewportMouseLeave);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("pointermove", handleGlobalPointerMove, true);
      window.removeEventListener("pointerup", handleGlobalPointerUp, true);
      window.removeEventListener("pointercancel", handleGlobalPointerUp, true);
      window.removeEventListener("pointerdown", handleWindowFirstPointerDown, true);
      document.documentElement.removeEventListener("mouseleave", handleViewportMouseLeave);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  useEffect(() => {
    return () => {
      stopSelectionRaf();
    };
  }, [stopSelectionRaf]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resetPointerOrigin = () => {
      pointerDownOnItemRef.current = false;
    };

    window.addEventListener("pointerup", resetPointerOrigin, true);
    window.addEventListener("dragend", resetPointerOrigin, true);
    window.addEventListener("drop", resetPointerOrigin, true);

    return () => {
      window.removeEventListener("pointerup", resetPointerOrigin, true);
      window.removeEventListener("dragend", resetPointerOrigin, true);
      window.removeEventListener("drop", resetPointerOrigin, true);
    };
  }, [containerRef.current, effectiveViewMode, visibleItems]);

  // Refresh directory after native drag-drop completes
  useEffect(() => {
    const handleDragEnd = () => {
      if (nativeDragStartedRef.current) {
        nativeDragStartedRef.current = false;
        // Reset drag state
        pointerDragSessionRef.current = { active: false, sourceIds: [], primaryId: null, latestClientX: 0, latestClientY: 0, ctrlKey: false };
        internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
        setDraggedItemId(null);
        setDragGhost({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });
        // Refresh to show updated files
        explorer?.refreshCurrentDirectory?.();
      }
    };

    window.addEventListener("dragend", handleDragEnd);
    return () => window.removeEventListener("dragend", handleDragEnd);
  }, [explorer?.refreshCurrentDirectory]);

  // Focus rename input on activation
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      const selectionSource = renameInputRef.current.value;
      const dotIndex = explorer.hideFileExtensions ? -1 : selectionSource.lastIndexOf(".");
      const selectionEnd = dotIndex > 0 ? dotIndex : selectionSource.length;
      renameInputRef.current.setSelectionRange(0, selectionEnd);
    }
  }, [explorer.hideFileExtensions, renamingId]);

  // Hide context menu on any pointer interaction outside the menu itself
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!contextMenu.visible && !openWithSubmenuAnchor && !viewSubmenuAnchor && !sortSubmenuAnchor) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".explorer-context-menu")) return;
      setContextMenu((prev) => ({ ...prev, visible: false }));
      setContextMenuOpenWithFile(null);
      setOpenWithSubmenuAnchor(null);
      setViewSubmenuAnchor(null);
      setSortSubmenuAnchor(null);
      setNewSubmenuAnchor(null);
      setGroupBySubmenuAnchor(null);
      // Reset local slider thumb so reopening shows the real view mode again
      viewSliderDraggingRef.current = false;
      setLocalViewSlider(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [contextMenu.visible, explorer, openWithSubmenuAnchor, viewSubmenuAnchor, sortSubmenuAnchor]);

  // Update context menu height after it renders
  useEffect(() => {
    if (contextMenu.visible && contextMenuRef.current) {
      const height = contextMenuRef.current.offsetHeight;
      if (height > 0) {
        setContextMenuHeight(height);
      }
    }
  }, [contextMenu.visible]);

  const cancelSubmenuClose = useCallback(() => {
    if (submenuCloseTimerRef.current !== null) {
      clearTimeout(submenuCloseTimerRef.current);
      submenuCloseTimerRef.current = null;
    }
  }, []);

  const scheduleSubmenuClose = useCallback(() => {
    cancelSubmenuClose();
    // 400ms matches OpenWithSubmenu-style behaviour — long enough to
    // traverse the gap between the trigger button and the panel without
    // accidental close, short enough to feel snappy when the user moves
    // elsewhere deliberately.
    submenuCloseTimerRef.current = setTimeout(() => {
      setOpenWithSubmenuAnchor(null);
      setViewSubmenuAnchor(null);
      setSortSubmenuAnchor(null);
      setNewSubmenuAnchor(null);
      setGroupBySubmenuAnchor(null);
    }, 400);
  }, [cancelSubmenuClose]);

  const closeAllSubmenus = useCallback(() => {
    cancelSubmenuClose();
    setOpenWithSubmenuAnchor(null);
    setViewSubmenuAnchor(null);
    setSortSubmenuAnchor(null);
    setNewSubmenuAnchor(null);
    setGroupBySubmenuAnchor(null);
  }, [cancelSubmenuClose]);

  useEffect(() => {
    return () => {
      cancelSubmenuClose();
    };
  }, [cancelSubmenuClose]);

  // Hover tracking: only react to Ctrl+Scroll while the mouse is over THIS pane.
  // We use the shared hovered-pane registry (driven by pointermove +
  // document.elementsFromPoint) so that wheel events are dispatched to
  // EXACTLY ONE pane at a time — no cross-pane leaks.
  useEffect(() => {
    if (!containerRef.current) return;
    return registerHoverPane(containerRef.current, "main");
  }, []);

  // Global wheel handler to close all menus when user scrolls, and Ctrl+Middle Scroll for viewmode
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      // Only handle wheel events from the viewport (not from within menus)
      const target = e.target as HTMLElement | null;
      // Allow scroll in context menus (fluent-menu class) without closing
      if (target?.closest(".fluent-menu")) return;
      if (target?.closest(".explorer-context-menu")) return;
      // Also don't close if hovering over context menu (for scroll)
      if (isContextMenuHovered) return;
      if (target?.closest(".explorer-sidebar")) return;
      if (target?.closest("input, textarea, [contenteditable]")) return;

      // Ctrl + Scroll: dispatch ONLY to the pane currently under the cursor
      if (e.ctrlKey && e.deltaY !== 0) {
        if (getPaneAtWheelEvent(e) !== "main") return;

        e.preventDefault();
        e.stopPropagation();
        // Natural scroll: scroll up (deltaY < 0) -> larger icons (smaller number)
        // scroll down (deltaY > 0) -> smaller icons (larger number)
        const step = e.deltaY > 0 ? 1 : -1;
        const newViewMode = Math.max(1, Math.min(7, viewMode + step));
        if (newViewMode !== viewMode) {
          setEffectiveViewMode(newViewMode);
        }
        return;
      }

      // Close context menu
      setContextMenu((prev) => prev.visible ? { ...prev, visible: false } : prev);
      setContextMenuOpenWithFile(null);
      // Close all submenus
      setOpenWithSubmenuAnchor(null);
      setViewSubmenuAnchor(null);
      setSortSubmenuAnchor(null);
      setNewSubmenuAnchor(null);
    };

    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, [viewMode, setEffectiveViewMode, setContextMenu, setContextMenuOpenWithFile, setOpenWithSubmenuAnchor, setViewSubmenuAnchor, setSortSubmenuAnchor, isContextMenuHovered]);

  // Single/double click guard — MUST be before early return
  const folderClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSingleClickItemRef = useRef<FSItem | null>(null);

  // Memoize fileItems to avoid recomputation on every render
  // Only depends on visibleItems and effectiveCurrentPath - neither changes during resize
  const fileItems = useMemo(() => {
    return visibleItems.filter((item) => {
      if (item.type !== "file") return false;
      const normalizePath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
      const normalizedParentId = normalizePath(item.parentId || "");
      const normalizedCurrentPath = normalizePath(effectiveCurrentPath);
      return normalizedParentId === normalizedCurrentPath;
    });
  }, [visibleItems, effectiveCurrentPath]);

  // Memoize directoryItems for folder size calculations
  const directoryItems = useMemo(() => {
    return visibleItems.filter((item) => {
      if (item.type !== "directory") return false;
      const normalizePath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
      const normalizedParentId = normalizePath(item.parentId || "");
      const normalizedCurrentPath = normalizePath(effectiveCurrentPath);
      return normalizedParentId === normalizedCurrentPath;
    });
  }, [visibleItems, effectiveCurrentPath]);

  // Callback to load thumbnails from backend.
  // Size is derived from the active view mode (64px for list/details/columns,
  // 160px for icon grid) — see `thumbRequestSize` in types.ts.
  // We read through a ref because `loadThumbnails` is declared before
  // `activeResultsViewMode` is computed (the closure runs at IPC time, not
  // declaration time, so hoisting is fine; using the ref also means we
  // don't need to add `activeResultsViewMode` to useCallback deps).
  const loadThumbnails = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;

    const size = viewModeForReadyRef.current !== null
      ? thumbRequestSize(viewModeForReadyRef.current)
      : 160;
    const newPaths = paths.filter((p) => !thumbs[p] && !thumbsInFlight.current.has(p) && !hasThumbFailure(p))
    if (newPaths.length === 0) return;

    newPaths.forEach((p) => thumbsInFlight.current.add(p));

    // Set placeholder state
    setLocalThumbs((prev) => {
      const next = { ...prev };
      newPaths.forEach((p) => { next[p] = null; });
      return next;
    });

    const batchSize = 30;
    for (let i = 0; i < newPaths.length; i += batchSize) {
      const batch = newPaths.slice(i, i + batchSize);
      try {
        const result = await invoke<Record<string, string | null>>(
          "get_thumbnails_batch",
          { paths: batch, size }
        );
        setLocalThumbs((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const [path, dataUrl] of Object.entries(result)) {
            if (dataUrl) {
              next[path] = dataUrl;
              clearThumbFailure(path);
              changed = true;
            } else {
              markThumbFailure(path);
            }
            thumbsInFlight.current.delete(path);
          }
          return changed ? next : prev;
        });
      } catch {
        setLocalThumbs((prev) => {
          const next = { ...prev };
          batch.forEach((p) => {
            next[p] = null;
            thumbsInFlight.current.delete(p);
          });
          return next;
        });
      }
    }
  }, [thumbs]);

  const { setContainerRef } = useViewportThumbnails({
    items: fileItems,
    thumbnails: thumbs,
    onLoadThumbnails: loadThumbnails,
    debounceMs: 50,
    rootMargin: 300,
    batchSize: 30,
  });

  // Folder size calculator for grid/list view
  const { sizes: folderSizes, getFolderSize, prefetchSizes } = useFolderSizes();

  // Container ref callback that connects to both containerRef and viewport hook
  const containerRefCallback = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    viewportElementRef.current = el;
    if (el) {
      el.style.position = "relative";
    }
    setContainerRef(el);
  }, [setContainerRef]);

  // Thumbnail fetch effect — cancel in-flight requests when folder changes.
  // We intentionally do NOT clear the thumbs cache here: Rust side has its own
  // LRU + disk cache, so revisits to old folders get instant hits.  The JS
  // cache is shared across all panes (MainPane + Inspector) so keeping it
  // intact means switching panes shows thumbnails immediately without reload.
  useEffect(() => {
    const folderId = effectiveCurrentPath;
    if (!folderId) return;

    if (folderId !== lastThumbFolderRef.current) {
      lastThumbFolderRef.current = folderId;
      // Cancel pending IPC requests for the previous folder
      thumbsInFlight.current.clear();
      // NOTE: setLocalThumbs({}) and clearThumbsStore() removed here.
      // Previously these nuked the entire thumbnail cache on every folder
      // change, forcing full re-decode + re-base64 on every revisit.
    }
  }, [effectiveCurrentPath]);

  // Prefetch folder sizes when entering a new directory
  useEffect(() => {
    // Skip if folder sizes feature is disabled
    if (!showFolderSizes) return;

    const folderId = effectiveCurrentPath;
    if (!folderId) return;

    // Collect all directory paths in current view
    const folderPaths = directoryItems.map((item) => item.id);

    if (folderPaths.length > 0) {
      prefetchSizes(folderPaths);
    }
  }, [effectiveCurrentPath, directoryItems.length, prefetchSizes, showFolderSizes]);

  // Listen for thumbnail-ready events from background extraction
  useEffect(() => {
    let isDisposed = false;
    let disposeListener: (() => void) | null = null;

    listen<string>("thumbnail-ready", async (event) => {
      if (isDisposed) return;

      const readyPath = event.payload;
      // Remove from in-flight so the cache is re-checked for this path
      thumbsInFlight.current.delete(readyPath);

      const size = viewModeForReadyRef.current !== null
        ? thumbRequestSize(viewModeForReadyRef.current)
        : 160;
      const result = await invoke<Record<string, string | null>>(
        "get_thumbnails_batch",
        { paths: [readyPath], size }
      );

      if (isDisposed) return;
      if (result[readyPath]) {
        setLocalThumbs((prev) => ({ ...prev, [readyPath]: result[readyPath] }));
        clearThumbFailure(readyPath);
      } else {
        markThumbFailure(readyPath);
      }
    }).then((unlisten) => {
      if (isDisposed) {
        unlisten();
        return;
      }
      disposeListener = unlisten;
    });

    return () => {
      isDisposed = true;
      disposeListener?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for thumbnail-cleared events — clear cached thumbnail when file is replaced
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ path: string; mtime_ms: number; size: number }>("thumbnail-cleared", (event) => {
      const path = event.payload?.path;
      if (!path) return;
      thumbsInFlight.current.delete(path);
      setLocalThumbs((prev) => {
        if (!(path in prev)) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      });
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  const normalizePath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const formatDisplayName = (item: FSItem) => {
    if (!explorer.hideFileExtensions || item.type !== "file") return item.name;
    const dotIndex = item.name.lastIndexOf(".");
    if (dotIndex <= 0) return item.name;
    return item.name.slice(0, dotIndex);
  };

  const highlightSearchText = useCallback((text: string) => {
    const query = searchFilter.query.trim();
    if (!query) return <>{text}</>;

    const indices = new Set(getMatchHighlightIndices(text, query));
    if (indices.size === 0) return <>{text}</>;

    return (
      <>
        {Array.from(text).map((char, index) => (
          <mark
            key={`${char}-${index}`}
            className={indices.has(index) ? "bg-transparent font-semibold" : "bg-transparent text-inherit"}
            style={indices.has(index) ? { color: accentColor } : undefined}
          >
            {char}
          </mark>
        ))}
      </>
    );
  }, [accentColor, searchFilter.query]);



  const startRenameForItem = useCallback((item: FSItem) => {
    const displayName = formatDisplayName(item);
    setVisibleSelectedIds([item.id]);
    lastClickedItemIdRef.current = item.id;
    setRenameInput(displayName);
    setRenamingId(item.id);
  }, [explorer.hideFileExtensions, setSelectedIds]);

  const scrollItemIntoView = useCallback((itemId: string, behavior: ScrollBehavior = "smooth") => {
    const container = viewportElementRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`) as HTMLElement | null;
    if (!el) return;

    // Walk up from the matched element to the nearest ancestor that is
    // actually scrollable. The viewport wrapper itself has no overflow, so
    // `el.scrollIntoView({ block: "nearest" })` ends up walking to an
    // arbitrary ancestor in Tauri WebView2 and silently no-ops in nested
    // grid layouts. Computing the scroll position ourselves and calling
    // `scrollTo` on the real scroll container guarantees the item is
    // centred vertically — matching Windows Explorer's type-ahead behaviour
    // where the matched item is brought into the middle of the visible
    // viewport.
    let scrollParent: HTMLElement | null = el.parentElement;
    while (scrollParent && scrollParent !== document.body) {
      const style = window.getComputedStyle(scrollParent);
      const overflowY = style.overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden" || overflowY === "overlay") &&
        scrollParent.scrollHeight > scrollParent.clientHeight
      ) {
        break;
      }
      scrollParent = scrollParent.parentElement;
    }

    if (!scrollParent || scrollParent === document.body) {
      let fallback: HTMLElement | null = el.parentElement;
      while (fallback && fallback !== document.body) {
        if (fallback.scrollHeight > fallback.clientHeight + 1) {
          scrollParent = fallback;
          break;
        }
        fallback = fallback.parentElement;
      }
    }

    const target = scrollParent && scrollParent !== document.body ? scrollParent : container;
    const targetRect = target.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const elTop = elRect.top - targetRect.top + target.scrollTop;
    const desiredTop = elTop - target.clientHeight / 2 + elRect.height / 2;
    const maxTop = Math.max(0, target.scrollHeight - target.clientHeight);
    const clampedTop = Math.max(0, Math.min(desiredTop, maxTop));

    if (Math.abs(clampedTop - target.scrollTop) > 1) {
      target.scrollTo({ top: clampedTop, behavior });
    }
  }, []);

  const handleViewportDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Check for pending internal drop from native drag (same-folder case)
    const pendingDrop = pendingInternalDropRef.current;
    const hasPendingInternalDrop = pendingDrop && pendingDrop.sourcePaths.length > 0;

    // Prefer pendingInternalDropRef over internalDragStateRef for native drag drops
    // because internalDragStateRef is cleared before startDrag resolves
    const dragState = hasPendingInternalDrop ? {
      active: true,
      sourcePaths: pendingDrop.sourcePaths,
      mode: pendingDrop.mode
    } : internalDragStateRef.current;

    // Only consider it an internal selection if:
    // 1. dragState.active is true AND has source paths, OR
    // 2. dataTransfer contains our custom marker
    const hasInternalSelection = (dragState.active && dragState.sourcePaths.length > 0) ||
      Array.from(e.dataTransfer.types || []).includes("text/goku-internal-selection") || hasPendingInternalDrop;

    // Guard: if a native OLE drag was just started (i.e. user dragged OUT of
    // the app and back in), the browser's HTML5 drag is still "active" but the
    // drag was already handled by the OS. Ignore this drop — let the native
    // drag (or its cancellation) take over.
    if (wasRecentNativeDrag()) {
      e.preventDefault();
      e.stopPropagation();
      pointerDownOnItemRef.current = false;
      setIsExternalFileDragActive(false);
      setDragOverFolderId(null);
      return;
    }

    // Belt-and-braces 2: if a pointer drag session is still considered active
    // we are likely in the middle of an OLE drag-back. Skip without doing
    // anything — the OS owns this drag.
    if (pointerDragSessionRef.current.active || isNativeDragActiveRef.current) {
      e.preventDefault();
      e.stopPropagation();
      pointerDownOnItemRef.current = false;
      setIsExternalFileDragActive(false);
      setDragOverFolderId(null);
      return;
    }

    if (hasInternalSelection) {
      e.preventDefault();
      e.stopPropagation();
      isNativeDragActiveRef.current = false;
      setIsExternalFileDragActive(false);
      setDragOverFolderId(null);

      const targetPath = activeTabPathRef.current;

      // Use pendingInternalDropRef if available (for native drag same-folder drops),
      // otherwise fall back to internalDragStateRef
      const sourcePaths = hasPendingInternalDrop ? pendingDrop.sourcePaths : dragState.sourcePaths;
      const mode = hasPendingInternalDrop ? pendingDrop.mode : dragState.mode;

      // Use ref if available (most reliable), otherwise fall back to dataTransfer
      if ((dragState.active || hasPendingInternalDrop) && sourcePaths.length > 0) {
        if (!targetPath) {
          return;
        }

        try {
          const movedOrCopiedPaths = await moveOrCopyItems?.(sourcePaths, targetPath, mode);
          await refreshCurrentDirectory?.();
          if (movedOrCopiedPaths?.length) {
            commitSelection(movedOrCopiedPaths);
          }
          explorer.setStatusMessage(
            mode === "copy"
              ? t("Đã sao chép mục vào thư mục hiện tại.", "Copied item(s) into the current folder.")
              : t("Đã di chuyển mục vào thư mục hiện tại.", "Moved item(s) into the current folder.")
          );
        } catch (error) {
          explorer.setStatusMessage(`${mode === "copy" ? "Copy" : "Move"} error: ${error}`);
        } finally {
          internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
          pendingInternalDropRef.current = null; // Clear pending drop
          setDraggedItemId(null);
          setDragDropMode("none");
        }
        return;
      }

      // Fallback: parse dataTransfer (may be unreliable for internal drops)
      const rawInternalPayload = e.dataTransfer.getData("text/goku-internal-selection");
      const parsedInternalPayload = rawInternalPayload ? JSON.parse(rawInternalPayload) as { kind?: string; sourceIds?: string[]; dragMode?: string } : null;
      const fallbackSourceIds = parsedInternalPayload?.kind === "goku-internal-selection"
        ? (parsedInternalPayload.sourceIds ?? [])
        : (draggedItemId ? [draggedItemId] : []);
      if (fallbackSourceIds.length === 0 || !targetPath) return;

      const fallbackSourcePaths = fallbackSourceIds
        .map((id) => visibleItems.find((item) => item.id === id)?.path)
        .filter((path): path is string => Boolean(path));
      if (fallbackSourcePaths.length === 0) return;

      const fallbackMode = (parsedInternalPayload?.dragMode as "copy" | "move") ?? "move";

      try {
        const movedOrCopiedPaths = await moveOrCopyItems?.(fallbackSourcePaths, targetPath, fallbackMode);
        await refreshCurrentDirectory?.();
        if (movedOrCopiedPaths?.length) {
          commitSelection(movedOrCopiedPaths);
        }
        explorer.setStatusMessage(
          fallbackMode === "copy"
            ? t("Đã sao chép mục vào thư mục hiện tại.", "Copied item(s) into the current folder.")
            : t("Đã di chuyển mục vào thư mục hiện tại.", "Moved item(s) into the current folder.")
        );
      } catch (error) {
        explorer.setStatusMessage(`${fallbackMode === "copy" ? "Copy" : "Move"} error: ${error}`);
      } finally {
        internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
        setDraggedItemId(null);
        setDragDropMode("none");
      }
      return;
    }

    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;

    setIsExternalFileDragActive(false);
    e.preventDefault();
    e.stopPropagation();

    const targetPath = activeTabPathRef.current;
    if (!targetPath) return;

    // Separate text files (readable via FileReader) from binary files (need import via backend)
    const textFiles = files.filter((file) => OS_FILE_IMPORT_EXTENSIONS.test(file.name));
    const binaryFiles = files.filter((file) => !OS_FILE_IMPORT_EXTENSIONS.test(file.name));

    try {
      const results: string[] = [];

      // Import binary files via backend (copy from OS path to target directory)
      if (binaryFiles.length > 0) {
        const binaryPaths = binaryFiles.map((f) => (f as any).path || `FILE:${f.name}`);
        // Filter out empty paths (some browsers don't expose the full path for security)
        const validBinaryPaths = binaryPaths.filter((p: string) => p && p !== `FILE:${binaryFiles.find((bf) => (bf as any).path === p)?.name}`);
        if (validBinaryPaths.length > 0) {
          const importedPaths = await importFiles(validBinaryPaths, targetPath);
          results.push(...importedPaths);
        }
      }

      // Read and create text files via FileReader + writeTextFile (batch, single loadDirectory at end)
      if (textFiles.length > 0) {
        const loadedFiles = await Promise.all(textFiles.map((file) => new Promise<{ name: string; content: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (event) => resolve({
            name: file.name,
            content: typeof event.target?.result === "string" ? event.target.result : "",
          });
          reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
          reader.readAsText(file);
        })));
        for (const { name, content } of loadedFiles) {
          const trimmedName = name.trim() || "untitled.txt";
          const newPath = joinPath(targetPath, trimmedName);
          await writeTextFile(newPath, content);
          results.push(newPath);
        }
      }

      await refreshCurrentDirectory?.();
      if (results.length > 0) {
        commitSelection(results);
      }

      const textCount = textFiles.length;
      const binCount = binaryFiles.length;
      if (textCount > 0 && binCount > 0) {
        explorer.setStatusMessage(
          language === "vi"
            ? `Đã nhập ${textCount} file text/code và ${binCount} file nhị phân vào thư mục hiện hành.`
            : `Imported ${textCount} text/code file(s) and ${binCount} binary file(s) into the current directory.`
        );
      } else if (textCount > 0) {
        explorer.setStatusMessage(
          language === "vi"
            ? `Đã nhập ${textCount} file text/code vào thư mục hiện hành.`
            : `Imported ${textCount} text/code file(s) into the current directory.`
        );
      } else {
        explorer.setStatusMessage(
          language === "vi"
            ? `Đã nhập ${binCount} file vào thư mục hiện hành.`
            : `Imported ${binCount} file(s) into the current directory.`
        );
      }
      setDragDropMode("none");
    } catch (error) {
      setDragDropMode("none");
      explorer.setStatusMessage(`${language === "vi" ? "Lỗi import file" : "File import error"}: ${error}`);
    }
  }, [commitSelection, draggedItemId, explorer, language, moveOrCopyItems, refreshCurrentDirectory, t]);

  const handleQuickAddFile = useCallback(() => {
    explorer.setNewItemModal({ open: true, mode: "file" });
  }, [explorer]);

  const handleQuickAddFolder = useCallback(() => {
    explorer.setNewItemModal({ open: true, mode: "folder" });
  }, [explorer]);

  const handleSortToggle = useCallback((field: typeof sortBy) => {
    if (effectiveSortBy === field) {
      setEffectiveSortDirection(effectiveSortDirection === "asc" ? "desc" : "asc");
    } else {
      setEffectiveSortBy(field);
      setEffectiveSortDirection("asc");
    }
  }, [setEffectiveSortBy, setEffectiveSortDirection, effectiveSortBy, effectiveSortDirection]);

  const handleContextUpdateTag = useCallback((tag: "Warning" | "WIP" | "Deliverable" | "Archived" | "Draft" | null) => {
    if (!contextMenu.targetItem) return;
    const targetId = contextMenu.targetItem.id;
    const stored = localStorage.getItem("NEXUS_ITEM_TAGS");
    const tags: Record<string, string> = stored ? JSON.parse(stored) : {};
    if (tag) {
      tags[targetId] = tag;
    } else {
      delete tags[targetId];
    }
    localStorage.setItem("NEXUS_ITEM_TAGS", JSON.stringify(tags));
    explorer.setStatusMessage(`Tag "${tag || "none"}" applied.`);
  }, [contextMenu.targetItem, explorer]);

  useEffect(() => {
    if (controlledSelectedIds.length === 0) return;
    const lastId = controlledSelectedIds[controlledSelectedIds.length - 1];
    const frame = requestAnimationFrame(() => {
      scrollItemIntoView(lastId, "smooth");
    });
    return () => cancelAnimationFrame(frame);
  }, [controlledSelectedIds, scrollItemIntoView]);

  const currentPath = effectiveCurrentPath;
  const isSearchResultsMode = Boolean(searchFilter.query.trim());

  // When searching, force Details list view (slider value 7)
  const activeResultsViewMode: ViewMode = isSearchResultsMode && !isInspectorPane ? 7 : effectiveViewMode;

  // Keep the thumbnail-ready listener's view mode ref in sync. The listener
  // was registered with [] deps earlier, so it reads through this ref instead
  // of capturing stale state.
  useEffect(() => {
    viewModeForReadyRef.current = activeResultsViewMode;
  }, [activeResultsViewMode]);

  // Group classification: icon-grid modes (1..4) vs list modes (5..7)
  const resultsGroup = viewModeGroup(activeResultsViewMode);
  const iconModeValue = Math.max(1, Math.min(4, activeResultsViewMode));
  const { width: iconWidthPx, height: iconHeightPx } = getIconSizePx(iconModeValue);
  const gridMinCellPx = getIconGridMinCellPx(iconModeValue);

  // 1. Use local folder-only search source for inspector windows
  const searchSource = searchFilter.query.trim()
    ? (isInspectorPane ? visibleItems : searchResults)
    : visibleItems;
  let folderChildren = [...searchSource];

  if (searchFilter.query.trim()) {
    folderChildren = filterAndSortSearchItems(
      folderChildren,
      searchFilter.query,
      (item) => item.name,
      (item) => getRelativeSearchPath(item, currentPath),
      searchFilter.mode,
    );
  }

  // 2. Hide hidden items
  if (!explorer.showHiddenItems) {
    folderChildren = folderChildren.filter((item) => !item.isHidden && !item.name.startsWith("."));
  }

  // 3. Filtering by metadata tags
  if (searchFilter.tag) {
    folderChildren = folderChildren.filter((item) => item.tag === searchFilter.tag);
  }

  // 3.5. Filtering by Designer media/code folder types (3D, Images, Videos, Audio, Code/Docs)
  if (searchFilter.typeFilter) {
    folderChildren = folderChildren.filter((item) => {
      if (item.type === "directory") return false;
      const ext = item.name.split(".").pop()?.toLowerCase() || "";
      switch (searchFilter.typeFilter) {
        case "3d":
          return ["hip", "hipnc", "c4d", "blend", "mb", "ma", "obj", "fbx", "3ds", "gltf", "glb", "stl", "ply", "3dm", "iges", "igs", "step", "stp", "usdz", "usd", "usda", "usdc", "abc", "dae", "skp", "spz", "3mf", "wrl", "vrml"].includes(ext);
        case "image":
          return ["png", "jpg", "jpeg", "gif", "webp", "tiff", "tif", "tga", "bmp", "ico", "svg", "exr", "hdr", "dpx", "psd", "psb", "ai", "heif", "heic", "avif", "jp2", "j2k", "jxl", "dds", "jpe", "jif", "jiff", "jfi", "nef", "arw", "dng", "raw", "cr2", "cr3", "rw2", "nrw", "raf", "rwl", "ktx", "ktx2", "astc", "af"].includes(ext);
        case "video":
          return ["mp4", "mov", "avi", "mkv", "webm"].includes(ext);
        case "audio":
          return ["mp3", "m4a", "wav", "flac"].includes(ext);
        case "code_doc":
          return ["txt", "md", "json", "ts", "tsx", "html", "css", "js", "jsx", "py", "rs", "go", "java", "c", "cpp", "h", "hpp", "cs", "rb", "php", "swift", "kt", "sh", "bat", "ps1", "odt", "ods", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf", "csv", "ttf", "otf", "woff"].includes(ext);
        default:
          return true;
      }
    });
  }

  // 4. Sort calculations
  const sortedChildren = [...folderChildren].sort((a, b) => {
    let comparison = 0;

    // Folders always sorted first
    if (a.type === "directory" && b.type === "file") return -1;
    if (a.type === "file" && b.type === "directory") return 1;

    switch (effectiveSortBy) {
      case "name":
        comparison = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
        break;
      case "size":
        comparison = a.size - b.size;
        break;
      case "type":
        const extA = a.name.split(".").pop() || "";
        const extB = b.name.split(".").pop() || "";
        comparison = extA.localeCompare(extB);
        break;
      case "date":
        comparison = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
        break;
    }

    return effectiveSortDirection === "asc" ? comparison : -comparison;
  });

  const getSearchTimeGroup = (item: FSItem) => {
    const updatedTime = new Date(item.updatedAt).getTime();
    if (!Number.isFinite(updatedTime)) {
      return { key: "unknown", label: t("Không rõ thời gian", "Unknown time"), collapsedByDefault: true, order: 5 };
    }

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const daysAgo = Math.floor((startOfToday - updatedTime) / (1000 * 60 * 60 * 24));

    if (daysAgo <= 1) {
      return { key: "yesterday", label: t("Hôm qua", "Yesterday"), collapsedByDefault: false, order: 0 };
    }
    if (daysAgo <= 7) {
      return { key: "last-week", label: t("Tuần trước", "Last week"), collapsedByDefault: false, order: 1 };
    }
    if (daysAgo <= 31) {
      return { key: "last-month", label: t("Tháng trước", "Last month"), collapsedByDefault: false, order: 2 };
    }
    if (daysAgo <= 366) {
      return { key: "earlier-this-year", label: t("Đầu năm nay", "Earlier this year"), collapsedByDefault: false, order: 3 };
    }

    return { key: "long-time-ago", label: t("Lâu rồi", "A long time ago"), collapsedByDefault: true, order: 4 };
  };

  const groupedSearchResults: SearchResultsGroup[] = !searchFilter.query.trim()
    ? []
    : (() => {
        const groups = new Map<string, SearchResultsGroup>();

        sortedChildren.forEach((item) => {
          const meta = getSearchTimeGroup(item);
          const existing = groups.get(meta.key);
          if (existing) {
            existing.items.push(item);
            return;
          }
          groups.set(meta.key, {
            key: meta.key,
            label: meta.label,
            collapsedByDefault: meta.collapsedByDefault,
            order: meta.order,
            items: [item],
          });
        });

        const orderedGroups = Array.from(groups.values()).sort((a, b) => a.order - b.order);
        if (showAllSearchResults) {
          return orderedGroups;
        }

        let remaining = 24;
        return orderedGroups
          .map((group) => {
            if (remaining <= 0) return null;
            const nextItems = group.items.slice(0, remaining);
            remaining -= nextItems.length;
            return {
              ...group,
              items: nextItems,
            };
          })
          .filter((group): group is SearchResultsGroup => Boolean(group) && group.items.length > 0);
      })();

  // Pre-load Windows folder icons from shell. These are now fetched at
  // display size, so the cache key includes the size. The hook returns
  // instantly from cache on subsequent renders.
  const allFolderPaths = useMemo(
    () => sortedChildren.filter((it) => it.type === "directory").map((it) => it.path),
    [sortedChildren]
  );

  // Keep itemsRef aligned with the currently visible list. In search mode the
  // list is the search results, otherwise it's activeTab.folderContents.
  const visibleSearchItemsForRef = !searchFilter.query.trim()
    ? sortedChildren
    : groupedSearchResults.flatMap((group) => {
        const collapsed = collapsedSearchGroups[group.key] ?? group.collapsedByDefault;
        return collapsed ? [] : group.items;
      });
  useEffect(() => {
    if (isSearchResultsMode) {
      itemsRef.current = visibleSearchItemsForRef;
    } else {
      itemsRef.current = visibleItems;
    }
  }, [isSearchResultsMode, visibleSearchItemsForRef, visibleItems]);

  useEffect(() => {
    setShowAllSearchResults(false);
    setCollapsedSearchGroups({});
  }, [searchFilter.query, activeTab?.currentPath]);

  // Keep refs in sync with current state
  sortedChildrenRef.current = sortedChildren;
  activeTabPathRef.current = effectiveCurrentPath;

  // ── Keyboard Navigation Handler ──────────────────────────────────────────
  const handleViewportKeyDown = (e: KeyboardEvent) => {
    // Skip keys that belong to an active IME composition (e.g. Vietnamese
    // Telex/VNI). While typing, every intermediate keystroke fires a
    // keydown with `isComposing === true` (and historically `keyCode 229`).
    // Letting those through would trigger type-ahead jumps mid-composition
    // — same issue as typing letters into a renamed file. Mirror Windows
    // Explorer's behaviour and silently ignore them.
    if (e.isComposing || e.keyCode === 229) return;
    // Don't handle if typing in input/textarea/rename or context menu is open
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA" || (activeEl as HTMLElement).isContentEditable)) {
      return;
    }
    if (contextMenu.visible) return;

    const items = sortedChildrenRef.current;

    const currentId = controlledSelectedIds[0];
    const currentIndex = currentId ? items.findIndex(item => item.id.replace(/\\/g, "/") === currentId.replace(/\\/g, "/")) : -1;
    const container = viewportElementRef.current;

    // Helper: scroll item into view. Same algorithm as the global
    // `scrollItemIntoView` callback above — see that function for the
    // rationale. We duplicate it here because the local helper closes over
    // `container` (the viewport ref) and uses block/nearest-like alignment
    // that matches the centre-on-match behaviour of Windows Explorer's
    // type-ahead navigation.
    const scrollIntoView = (itemId: string) => {
      if (!container) return;
      const normalizedId = itemId.replace(/\\/g, "/");
      let el = container.querySelector(`[data-item-id="${CSS.escape(normalizedId)}"]`) as HTMLElement | null;
      if (!el) {
        el = container.querySelector(`[data-item-id="${normalizedId}"]`) as HTMLElement | null;
      }
      if (!el) return;

      let scrollParent: HTMLElement | null = el.parentElement;
      while (scrollParent && scrollParent !== document.body) {
        const style = window.getComputedStyle(scrollParent);
        const overflowY = style.overflowY;
        if (
          (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden" || overflowY === "overlay") &&
          scrollParent.scrollHeight > scrollParent.clientHeight
        ) {
          break;
        }
        scrollParent = scrollParent.parentElement;
      }
      if (!scrollParent || scrollParent === document.body) {
        let fallback: HTMLElement | null = el.parentElement;
        while (fallback && fallback !== document.body) {
          if (fallback.scrollHeight > fallback.clientHeight + 1) {
            scrollParent = fallback;
            break;
          }
          fallback = fallback.parentElement;
        }
      }

      const target = scrollParent && scrollParent !== document.body ? scrollParent : container;
      const targetRect = target.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const elTop = elRect.top - targetRect.top + target.scrollTop;
      const desiredTop = elTop - target.clientHeight / 2 + elRect.height / 2;
      const maxTop = Math.max(0, target.scrollHeight - target.clientHeight);
      const clampedTop = Math.max(0, Math.min(desiredTop, maxTop));

      if (Math.abs(clampedTop - target.scrollTop) > 1) {
        target.scrollTo({ top: clampedTop, behavior: "smooth" });
      }
    };

    // Helper: get number of columns in current view
    const getColumnsCount = (): number => {
      if (!container) return 1;
      const containerWidth = container.clientWidth - 40;
      const v = effectiveViewMode;
      const group = viewModeGroup(v);

      if (group === "list") {
        // 5: Columns (288px each), 6: List, 7: Details (1 col)
        if (v === 5) return Math.max(1, Math.floor(containerWidth / 304));
        return 1;
      }
      // Icon group (1..4): interpolate from minCell = 180 → 100
      const minCell = getIconGridMinCellPx(v);
      return Math.max(1, Math.floor(containerWidth / minCell));
    };

    // Helper: get parent path
    const getParentPath = (path: string): string => {
      const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
      const lastSlash = normalized.lastIndexOf("/");
      if (lastSlash <= 2) return normalized.substring(0, 2) + "/";
      return normalized.substring(0, lastSlash);
    };

    const isPrintableCharacter =
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey;

    if (isPrintableCharacter) {
      const typedChar = e.key.toLocaleLowerCase();
      const repeatedSameChar = typeSelectBufferRef.current && [...typeSelectBufferRef.current].every(char => char === typedChar);
      const nextBuffer = repeatedSameChar ? typedChar : `${typeSelectBufferRef.current}${typedChar}`;
      typeSelectBufferRef.current = nextBuffer;

      if (typeSelectResetTimerRef.current) {
        clearTimeout(typeSelectResetTimerRef.current);
      }
      typeSelectResetTimerRef.current = setTimeout(() => {
        typeSelectBufferRef.current = "";
        typeSelectResetTimerRef.current = null;
      }, 1000);

      const normalizedItems = items.map(item => item.name.trim().toLocaleLowerCase());
      const startIndex = currentIndex >= 0 ? currentIndex : -1;
      const searchOrder = [
        ...items.slice(startIndex + 1),
        ...items.slice(0, startIndex + 1),
      ];

      const matchedItem = searchOrder.find(item => item.name.trim().toLocaleLowerCase().startsWith(nextBuffer));

      if (matchedItem) {
        e.preventDefault();
        setVisibleSelectedIds([matchedItem.id]);
        lastClickedItemIdRef.current = matchedItem.id;
        // Defer the scroll by one frame so React has finished committing
        // the selection update — otherwise the matched element may still
        // be at its pre-selection position and the scroll target ends
        // up slightly off in grid layouts.
        requestAnimationFrame(() => {
          scrollIntoView(matchedItem.id);
        });
        return;
      }

      // No item starts with the buffer. Match Windows Explorer behaviour:
      // if the user typed multiple characters and nothing matches, fall back
      // to the first character so they can still navigate when typing too
      // fast or in a fresh directory.
      if (typeSelectBufferRef.current.length > 1) {
        const fallbackChar = typeSelectBufferRef.current.charAt(0);
        const fallbackOrder = [
          ...items.slice(startIndex + 1),
          ...items.slice(0, startIndex + 1),
        ];
        const fallbackItem = fallbackOrder.find(item =>
          item.name.trim().toLocaleLowerCase().startsWith(fallbackChar)
        );
        if (fallbackItem) {
          e.preventDefault();
          setVisibleSelectedIds([fallbackItem.id]);
          lastClickedItemIdRef.current = fallbackItem.id;
          requestAnimationFrame(() => {
            scrollIntoView(fallbackItem.id);
          });
        }
      }
      return;
    };

    // Shift+Arrow keyboard extension:
    // - Anchor is the last clicked item (starting point) - stored in shiftArrowAnchorRef
    // - Edge tracks the current "frontier" - starts at anchor, moves outward
    // - IMPORTANT: shiftArrowAnchorRef keeps anchor stable across Shift+Arrow presses
    // - Grid navigation: ArrowUp/Down moves by 'cols' (same column, next/prev row)
    // - When edge reaches anchor and continues same direction: anchor jumps, extend in opposite direction

    const cols = getColumnsCount();

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        if (e.shiftKey) {
          let anchorId = shiftArrowAnchorRef.current;
          if (!anchorId) {
            anchorId = lastClickedItemIdRef.current;
            // Fall back to the currently-selected item (e.g. first selected)
            if (!anchorId) {
              anchorId = controlledSelectedIds[0] ?? null;
            }
            if (!anchorId) break;
            shiftArrowAnchorRef.current = anchorId;
          }

          const anchorIdx = items.findIndex(item => item.id.replace(/\\/g, "/") === anchorId.replace(/\\/g, "/"));
          if (anchorIdx === -1) break;

          let edgeIdx = shiftArrowEdgeIdxRef.current;
          if (edgeIdx === -1) {
            shiftArrowEdgeIdxRef.current = anchorIdx;
            edgeIdx = anchorIdx;
          }

          // Grid navigation: move DOWN = same column, next row
          // Index increment = number of columns
          const nextIdx = Math.min(edgeIdx + cols, items.length - 1);

          // If edge already at boundary, nothing to do
          if (nextIdx === edgeIdx) break;

          // Windows behavior: when edge reaches anchor and we continue in same direction,
          // anchor "jumps" to previous edge position, then extend in opposite direction
          if (edgeIdx >= anchorIdx) {
            // Currently extending DOWN (edge is at or below anchor) - ArrowDown should EXTEND downward
            if (nextIdx < anchorIdx) {
              // Edge passed anchor going up - jump anchor to old edge, extend downward
              // Special case: if edgeIdx === anchorIdx, we're at a single-item selection
              // ArrowDown should just shrink selection (no anchor jump)
              if (edgeIdx === anchorIdx) {
                // Shrink to just the anchor (already there)
                shiftArrowEdgeIdxRef.current = anchorIdx;
                setSelectionWithSideEffects([items[anchorIdx].id]);
                scrollIntoView(items[anchorIdx].id);
              } else {
                shiftArrowAnchorRef.current = items[edgeIdx].id;
                const newAnchorIdx = edgeIdx;
                const newEdgeIdx = Math.min(edgeIdx + cols, items.length - 1);
                shiftArrowEdgeIdxRef.current = newEdgeIdx;
                const newSel = items.slice(newAnchorIdx, newEdgeIdx + 1).map(item => item.id);
                setSelectionWithSideEffects(newSel);
                scrollIntoView(items[newEdgeIdx].id);
              }
            } else {
              // Normal case: extend selection downward
              shiftArrowEdgeIdxRef.current = nextIdx;
              const newSel = items.slice(anchorIdx, nextIdx + 1).map(item => item.id);
              setSelectionWithSideEffects(newSel);
              scrollIntoView(items[nextIdx].id);
            }
          } else {
            // Currently extending UP (edge is above anchor) - ArrowDown should SHRINK selection
            if (nextIdx >= anchorIdx) {
              // Edge reached/passed anchor - shrink to just anchor
              shiftArrowEdgeIdxRef.current = anchorIdx;
              setSelectionWithSideEffects([items[anchorIdx].id]);
              scrollIntoView(items[anchorIdx].id);
            } else {
              // Normal shrink: move edgeIdx down, selection from nextIdx to anchorIdx
              shiftArrowEdgeIdxRef.current = nextIdx;
              const newSel = items.slice(nextIdx, anchorIdx + 1).map(item => item.id);
              setSelectionWithSideEffects(newSel);
              scrollIntoView(items[nextIdx].id);
            }
          }
        } else if (e.ctrlKey) {
          container?.scrollBy({ top: 80, behavior: "smooth" });
        } else {
          shiftArrowAnchorRef.current = null;
          shiftArrowEdgeIdxRef.current = -1;
          if (currentIndex === -1 || currentIndex >= items.length - 1) {
            setVisibleSelectedIds([items[0].id]);
            lastClickedItemIdRef.current = items[0].id;
            scrollIntoView(items[0].id);
          } else {
            // Grid navigation: move DOWN = index + cols
            const newIndex = Math.min(currentIndex + cols, items.length - 1);
            setVisibleSelectedIds([items[newIndex].id]);
            lastClickedItemIdRef.current = items[newIndex].id;
            scrollIntoView(items[newIndex].id);
          }
        }
        break;
      }

      case "ArrowUp": {
        e.preventDefault();
        if (e.shiftKey) {
          let anchorId = shiftArrowAnchorRef.current;
          if (!anchorId) {
            anchorId = lastClickedItemIdRef.current;
            // Fall back to the currently-selected item (e.g. first selected)
            if (!anchorId) {
              anchorId = controlledSelectedIds[0] ?? null;
            }
            if (!anchorId) break;
            shiftArrowAnchorRef.current = anchorId;
          }

          const anchorIdx = items.findIndex(item => item.id.replace(/\\/g, "/") === anchorId.replace(/\\/g, "/"));
          if (anchorIdx === -1) break;

          let edgeIdx = shiftArrowEdgeIdxRef.current;
          if (edgeIdx === -1) {
            shiftArrowEdgeIdxRef.current = anchorIdx;
            edgeIdx = anchorIdx;
          }

          // Grid navigation: move UP = same column, previous row
          // Index decrement = number of columns
          const nextIdx = Math.max(edgeIdx - cols, 0);

          // If edge already at boundary, nothing to do
          if (nextIdx === edgeIdx) break;

          // Determine crossing condition:
          // After extending, if edge is above anchor (edgeIdx < anchorIdx) and nextIdx reaches/passes anchor,
          // OR if edge is below anchor (edgeIdx > anchorIdx) and nextIdx passes anchor going backward
          // For simplicity: when edgeIdx >= anchorIdx and nextIdx > anchorIdx, we shrink
          // When edgeIdx >= anchorIdx and nextIdx <= anchorIdx, we cross (jump anchor)
          // When edgeIdx < anchorIdx and nextIdx < anchorIdx, we shrink (still below anchor)
          // When edgeIdx < anchorIdx and nextIdx >= anchorIdx, we cross (reached anchor from below)

          if (edgeIdx >= anchorIdx) {
            // Currently extending DOWN (edge is at or below anchor) - ArrowUp should SHRINK selection
            if (nextIdx === anchorIdx) {
              // Edge shrunk back to anchor - selection becomes just anchor
              shiftArrowEdgeIdxRef.current = anchorIdx;
              setSelectionWithSideEffects([items[anchorIdx].id]);
              scrollIntoView(items[anchorIdx].id);
            } else if (nextIdx < anchorIdx) {
              // ArrowUp moving edge past anchor - need to handle based on current state
              // Special case: if edgeIdx === anchorIdx, we're at a single-item selection
              // ArrowUp should just extend selection upward (no shrink)
              if (edgeIdx === anchorIdx) {
                // Simply extend selection upward: items from nextIdx to anchorIdx
                shiftArrowEdgeIdxRef.current = nextIdx;
                const newSel = items.slice(nextIdx, anchorIdx + 1).map(item => item.id);
                setSelectionWithSideEffects(newSel);
                scrollIntoView(items[nextIdx].id);
              } else {
                // Normal shrink: move edgeIdx up, selection from anchorIdx to nextIdx
                shiftArrowEdgeIdxRef.current = nextIdx;
                const newSel = items.slice(anchorIdx, nextIdx + 1).map(item => item.id);
                setSelectionWithSideEffects(newSel);
                scrollIntoView(items[nextIdx].id);
              }
            } else {
              // Normal shrink: move edgeIdx up, selection stays from anchorIdx to nextIdx
              shiftArrowEdgeIdxRef.current = nextIdx;
              const newSel = items.slice(anchorIdx, nextIdx + 1).map(item => item.id);
              setSelectionWithSideEffects(newSel);
              scrollIntoView(items[nextIdx].id);
            }
          } else {
            // Currently extending UP (edge is above anchor) - ArrowUp should EXTEND selection
            // Keep extending up, selection is from anchorIdx to edgeIdx
            if (nextIdx >= anchorIdx) {
              // Edge reached/passed anchor - shrink to just anchor
              shiftArrowEdgeIdxRef.current = anchorIdx;
              setSelectionWithSideEffects([items[anchorIdx].id]);
              scrollIntoView(items[anchorIdx].id);
            } else {
              // Normal extend upward: select items from nextIdx to anchorIdx
              shiftArrowEdgeIdxRef.current = nextIdx;
              const newSel = items.slice(nextIdx, anchorIdx + 1).map(item => item.id);
              setSelectionWithSideEffects(newSel);
              scrollIntoView(items[nextIdx].id);
            }
          }
        } else if (e.ctrlKey) {
          container?.scrollBy({ top: -80, behavior: "smooth" });
        } else {
          shiftArrowAnchorRef.current = null;
          shiftArrowEdgeIdxRef.current = -1;
          if (currentIndex <= 0) {
            setVisibleSelectedIds([items[items.length - 1].id]);
            lastClickedItemIdRef.current = items[items.length - 1].id;
            scrollIntoView(items[items.length - 1].id);
          } else {
            // Grid navigation: move UP = index - cols
            const newIndex = Math.max(currentIndex - cols, 0);
            setVisibleSelectedIds([items[newIndex].id]);
            lastClickedItemIdRef.current = items[newIndex].id;
            scrollIntoView(items[newIndex].id);
          }
        }
        break;
      }

      case "ArrowRight": {
        e.preventDefault();
        const cols = getColumnsCount();
        // Only allow Shift+ArrowRight in multi-column view
        if (e.shiftKey && cols === 1) break;
        if (e.shiftKey) {
          let anchorId = shiftArrowAnchorRef.current;
          if (!anchorId) {
            anchorId = lastClickedItemIdRef.current;
            // Fall back to the currently-selected item
            if (!anchorId) {
              anchorId = controlledSelectedIds[0] ?? null;
            }
            if (!anchorId) break;
            shiftArrowAnchorRef.current = anchorId;
          }

          const anchorIdx = items.findIndex(item => item.id.replace(/\\/g, "/") === anchorId.replace(/\\/g, "/"));
          if (anchorIdx === -1) break;

          let edgeIdx = shiftArrowEdgeIdxRef.current;
          if (edgeIdx === -1) {
            shiftArrowEdgeIdxRef.current = anchorIdx;
            edgeIdx = anchorIdx;
          }

          // Get column for edge
          const edgeCol = edgeIdx % cols;
          const edgeRow = Math.floor(edgeIdx / cols);
          const lastRowIndex = Math.floor((items.length - 1) / cols);
          const maxColInLastRow = items.length - 1 - lastRowIndex * cols;
          const maxColInCurrentRow = (edgeRow === lastRowIndex) ? maxColInLastRow : cols - 1;

          let nextIdx;
          if (edgeCol < maxColInCurrentRow) {
            // Can move right within current row
            nextIdx = edgeIdx + 1;
          } else {
            // At right edge - wrap to next row's first column
            const nextRowFirstIdx = (edgeRow + 1) * cols;
            if (nextRowFirstIdx < items.length) {
              nextIdx = nextRowFirstIdx;
            } else {
              // Already at bottom-right corner - can't move right
              break;
            }
          }

          if (nextIdx === edgeIdx) break;

          shiftArrowEdgeIdxRef.current = nextIdx;
          // Always use min/max to get correct range regardless of direction
          const minIdx = Math.min(anchorIdx, nextIdx);
          const maxIdx = Math.max(anchorIdx, nextIdx);
          const newSel = items.slice(minIdx, maxIdx + 1).map(item => item.id);
          setSelectionWithSideEffects(newSel);
          scrollIntoView(items[nextIdx].id);
        } else {
          shiftArrowAnchorRef.current = null;
          shiftArrowEdgeIdxRef.current = -1;
          // Only move horizontally in multi-column view
          if (cols > 1 && currentIndex !== -1 && currentIndex < items.length - 1) {
            const newIndex = currentIndex + 1;
            setVisibleSelectedIds([items[newIndex].id]);
            lastClickedItemIdRef.current = items[newIndex].id;
            scrollIntoView(items[newIndex].id);
          }
          // In single column (list view), ArrowRight does nothing
        }
        break;
      }

      case "ArrowLeft": {
        e.preventDefault();
        const cols = getColumnsCount();
        // Only allow Shift+ArrowLeft in multi-column view
        if (e.shiftKey && cols === 1) break;
        if (e.shiftKey) {
          let anchorId = shiftArrowAnchorRef.current;
          if (!anchorId) {
            anchorId = lastClickedItemIdRef.current;
            // Fall back to the currently-selected item
            if (!anchorId) {
              anchorId = controlledSelectedIds[0] ?? null;
            }
            if (!anchorId) break;
            shiftArrowAnchorRef.current = anchorId;
          }

          const anchorIdx = items.findIndex(item => item.id.replace(/\\/g, "/") === anchorId.replace(/\\/g, "/"));
          if (anchorIdx === -1) break;

          let edgeIdx = shiftArrowEdgeIdxRef.current;
          if (edgeIdx === -1) {
            shiftArrowEdgeIdxRef.current = anchorIdx;
            edgeIdx = anchorIdx;
          }

          // Get column for edge
          const edgeCol = edgeIdx % cols;
          const edgeRow = Math.floor(edgeIdx / cols);

          let nextIdx;
          if (edgeCol > 0) {
            // Can move left within current row
            nextIdx = edgeIdx - 1;
          } else {
            // At left edge - wrap to previous row's last column
            if (edgeRow > 0) {
              // Go to previous row, last column
              const prevRowLastCol = Math.min((edgeRow) * cols - 1, items.length - 1);
              nextIdx = prevRowLastCol;
            } else {
              // Already at top-left corner - can't move left
              break;
            }
          }

          if (nextIdx === edgeIdx) break;

          shiftArrowEdgeIdxRef.current = nextIdx;
          // Always use min/max to get correct range regardless of direction
          const minIdx = Math.min(anchorIdx, nextIdx);
          const maxIdx = Math.max(anchorIdx, nextIdx);
          const newSel = items.slice(minIdx, maxIdx + 1).map(item => item.id);
          setSelectionWithSideEffects(newSel);
          scrollIntoView(items[nextIdx].id);
        } else {
          shiftArrowAnchorRef.current = null;
          shiftArrowEdgeIdxRef.current = -1;
          // Only move horizontally in multi-column view
          if (cols > 1 && currentIndex > 0) {
            const newIndex = currentIndex - 1;
            setVisibleSelectedIds([items[newIndex].id]);
            lastClickedItemIdRef.current = items[newIndex].id;
            scrollIntoView(items[newIndex].id);
          }
          // In single column (list view), ArrowLeft does nothing
        }
        break;
      }

      case "Home": {
        e.preventDefault();
        if (items.length > 0) {
          shiftArrowAnchorRef.current = null;
          shiftArrowEdgeIdxRef.current = -1;
          if (e.shiftKey) {
            const anchorId = lastClickedItemIdRef.current;
            const anchorIndex = anchorId
              ? items.findIndex(item => item.id.replace(/\\/g, "/") === anchorId.replace(/\\/g, "/"))
              : 0;
            setSelectionWithSideEffects(items.slice(0, Math.max(anchorIndex, 0) + 1).map(item => item.id));
            lastClickedItemIdRef.current = items[0].id;
          } else {
            setVisibleSelectedIds([items[0].id]);
            lastClickedItemIdRef.current = items[0].id;
          }
          scrollIntoView(items[0].id);
          container?.scrollTo({ top: 0, behavior: "smooth" });
        }
        break;
      }

      case "End": {
        e.preventDefault();
        if (items.length > 0) {
          shiftArrowAnchorRef.current = null;
          shiftArrowEdgeIdxRef.current = -1;
          const lastIndex = items.length - 1;
          if (e.shiftKey) {
            const anchorId = lastClickedItemIdRef.current;
            const anchorIndex = anchorId
              ? items.findIndex(item => item.id.replace(/\\/g, "/") === anchorId.replace(/\\/g, "/"))
              : lastIndex;
            const start = Math.min(anchorIndex === -1 ? 0 : anchorIndex, lastIndex);
            const end = lastIndex;
            setSelectionWithSideEffects(items.slice(start, end + 1).map(item => item.id));
            lastClickedItemIdRef.current = items[lastIndex].id;
          } else {
            setVisibleSelectedIds([items[lastIndex].id]);
            lastClickedItemIdRef.current = items[lastIndex].id;
          }
          scrollIntoView(items[lastIndex].id);
        }
        break;
      }

      case "PageUp": {
        e.preventDefault();
        if (!container || items.length === 0) return;
        shiftArrowAnchorRef.current = null;
        shiftArrowEdgeIdxRef.current = -1;
        const scrollAmount = Math.floor(container.clientHeight / 80);
        const targetIndex = currentIndex <= 0 ? 0 : Math.max(0, currentIndex - scrollAmount);
        if (e.shiftKey) {
          const anchorId = lastClickedItemIdRef.current;
          const anchorIndex = anchorId
            ? items.findIndex(item => item.id.replace(/\\/g, "/") === anchorId.replace(/\\/g, "/"))
            : 0;
          const start = Math.min(anchorIndex === -1 ? 0 : anchorIndex, targetIndex);
          const end = Math.max(anchorIndex === -1 ? 0 : anchorIndex, targetIndex);
          setSelectionWithSideEffects(items.slice(start, end + 1).map(item => item.id));
          lastClickedItemIdRef.current = items[targetIndex].id;
        } else {
          setVisibleSelectedIds([items[targetIndex].id]);
          lastClickedItemIdRef.current = items[targetIndex].id;
        }
        scrollIntoView(items[targetIndex].id);
        break;
      }

      case "PageDown": {
        e.preventDefault();
        if (!container || items.length === 0) return;
        shiftArrowAnchorRef.current = null;
        shiftArrowEdgeIdxRef.current = -1;
        const scrollAmount = Math.floor(container.clientHeight / 80);
        const lastIndex = items.length - 1;
        const targetIndex = currentIndex >= lastIndex ? lastIndex : Math.min(lastIndex, currentIndex + scrollAmount);
        if (e.shiftKey) {
          const anchorId = lastClickedItemIdRef.current;
          const anchorIndex = anchorId
            ? items.findIndex(item => item.id.replace(/\\/g, "/") === anchorId.replace(/\\/g, "/"))
            : 0;
          const start = Math.min(anchorIndex === -1 ? 0 : anchorIndex, targetIndex);
          const end = Math.max(anchorIndex === -1 ? 0 : anchorIndex, targetIndex);
          setSelectionWithSideEffects(items.slice(start, end + 1).map(item => item.id));
          lastClickedItemIdRef.current = items[targetIndex].id;
        } else {
          setVisibleSelectedIds([items[targetIndex].id]);
          lastClickedItemIdRef.current = items[targetIndex].id;
        }
        scrollIntoView(items[targetIndex].id);
        break;
      }

      case "Enter": {
        e.preventDefault();
        if (currentId) {
          const item = visibleItems.find(i => i.id === currentId);
          if (item) {
            if (item.type === "directory") {
              navigateTo(item.id);
            } else {
              void openFileForEditing(item.id);
            }
          }
        }
        break;
      }

      case "F2": {
        e.preventDefault();
        if (currentId) {
          const item = visibleItems.find(i => i.id === currentId);
          if (item) {
            startRenameForItem(item);
          }
        }
        break;
      }

      case "Backspace": {
        e.preventDefault();
        const currentPath = activeTabPathRef.current;
        if (currentPath) {
          const parentPath = getParentPath(currentPath);
          if (parentPath !== currentPath) {
            navigateTo(parentPath);
          }
        }
        break;
      }
    }
  };

  // ── Window-level Type-Ahead Navigation ───────────────────────────────────
  //
  // The viewport's `onKeyDown` handler only fires when the viewport wrapper
  // (or a descendant that doesn't stop propagation) holds the focus. If the
  // user just clicked the address bar, search bar, sidebar, or any other
  // focusable element before typing, the per-pane handler silently no-ops
  // and Windows-Explorer-style "type a letter to jump to that file" stops
  // working. Windows itself solves this by handling type-ahead at the
  // window level, so we mirror that here. The handler:
  //
  //   • Runs on every keydown (window capture phase)
  //   • Ignores key events that originate from inputs / textareas /
  //     contentEditable regions (so it never hijacks real typing)
  //   • Ignores key events that arrive while a modal/context menu is open
  //   • Ignores keys that carry modifier flags (Ctrl/Cmd/Alt) so it never
  //     collides with shortcuts like Ctrl+C, Alt+Arrow, etc.
  //   • Scrolls the matched item into view (centre) and selects it
  useEffect(() => {
    const handleWindowTypeAhead = (e: KeyboardEvent) => {
      // Only printable single-character keys, no modifiers.
      if (e.key.length !== 1) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl) {
        const tag = activeEl.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || activeEl.isContentEditable) {
          return;
        }
        // Don't intercept typing inside the sidebar tree (folder navigation),
        // search bar, or address bar — those are real input fields even if
        // they don't use a native <input>.
        if (activeEl.closest?.("[data-explorer-input]")) return;
        if (activeEl.closest?.(".kuref-window-container")) return;
      }
      if (contextMenu.visible) return;

      // CRITICAL: only respond to keys when THIS pane owns the focus.
      // ExplorerMainPane is mounted once for the main viewport and once
      // again per inspected folder (the inspector pane). Without this
      // guard, every instance reacts to the same key event, so typing
      // "S" while focused on the main pane also drives selection in
      // whichever inspector pane happens to have items starting with S.
      const viewport = viewportElementRef.current;
      if (!viewport) return;
      if (!viewport.contains(activeEl) && activeEl !== viewport) {
        return;
      }

      const items = sortedChildrenRef.current;
      if (!items || items.length === 0) return;

      const typedChar = e.key.toLocaleLowerCase();
      const repeatedSameChar =
        typeSelectBufferRef.current.length > 0 &&
        [...typeSelectBufferRef.current].every((ch) => ch === typedChar);
      const nextBuffer = repeatedSameChar ? typedChar : `${typeSelectBufferRef.current}${typedChar}`;
      typeSelectBufferRef.current = nextBuffer;

      if (typeSelectResetTimerRef.current) {
        clearTimeout(typeSelectResetTimerRef.current);
      }
      typeSelectResetTimerRef.current = setTimeout(() => {
        typeSelectBufferRef.current = "";
        typeSelectResetTimerRef.current = null;
      }, 1000);

      const currentId = controlledSelectedIds[0];
      const currentIndex = currentId
        ? items.findIndex((it) => it.id.replace(/\\/g, "/") === currentId.replace(/\\/g, "/"))
        : -1;
      const startIndex = currentIndex >= 0 ? currentIndex : -1;
      const searchOrder = [...items.slice(startIndex + 1), ...items.slice(0, startIndex + 1)];

      let matchedItem = searchOrder.find((item) =>
        item.name.trim().toLocaleLowerCase().startsWith(nextBuffer)
      );

      // If the multi-character buffer doesn't match anything, fall back to
      // just the first character — same behaviour as Windows Explorer.
      if (!matchedItem && nextBuffer.length > 1) {
        const fallbackChar = nextBuffer.charAt(0);
        matchedItem = searchOrder.find((item) =>
          item.name.trim().toLocaleLowerCase().startsWith(fallbackChar)
        );
      }

      if (!matchedItem) return;

      e.preventDefault();
      e.stopPropagation();
      setVisibleSelectedIds([matchedItem.id]);
      lastClickedItemIdRef.current = matchedItem.id;

      // When type-ahead lands on a directory, mirror the click behaviour
      // so the Details Pane and Inspector Pane stay in sync. Without this,
      // typing "S" to jump to "Sample 3D" would highlight the folder but
      // leave the Inspector Pane showing the previous folder's contents
      // (or the "empty" placeholder). Drive the same `onFolderClick`
      // callback the click handler uses — that callback in App.tsx
      // updates `folderInspectionPath`, clears inspector selection, and
      // resets multi-select state. File matches only change selection
      // (which Details Pane already observes).
      if (matchedItem.type === "directory") {
        const folderPath = matchedItem.path || matchedItem.id;
        onFolderClickRef.current?.(folderPath, matchedItem.name);
      }

      // Defer scroll by one frame so React has flushed the selection update
      // before we measure element positions.
      requestAnimationFrame(() => {
        const viewport = viewportElementRef.current;
        if (!viewport) return;

        // Search the whole document for the matched element. Using only
        // this pane's viewport ref as the query root would miss the
        // element when the pane renders items lazily.
        //
        // The id is a Windows path, so it contains backslashes. We try
        // both the raw backslash form (as stored in `data-item-id`)
        // and a forward-slash normalised form, because some parts of
        // the code path normalize via `replace(/\\/g, "/")` while
        // others don't, and CSS attribute selectors must match the
        // exact string in the attribute value.
        const rawId = matchedItem.id;
        const normalizedId = rawId.replace(/\\/g, "/");
        let el: HTMLElement | null = null;

        const tryQuery = (selector: string): HTMLElement | null => {
          try {
            return document.querySelector(selector) as HTMLElement | null;
          } catch {
            return null;
          }
        };

        el = tryQuery(`[data-item-id="${CSS.escape(rawId)}"]`);
        if (!el) el = tryQuery(`[data-item-id="${rawId}"]`);
        if (!el) el = tryQuery(`[data-item-id="${CSS.escape(normalizedId)}"]`);
        if (!el) el = tryQuery(`[data-item-id="${normalizedId}"]`);

        if (!el) {
          // Last resort: linear scan all elements and compare the
          // attribute value manually. Slower but bullet-proof.
          const all = document.querySelectorAll<HTMLElement>("[data-item-id]");
          for (const candidate of all) {
            const attr = candidate.getAttribute("data-item-id");
            if (attr === rawId || attr === normalizedId) {
              el = candidate;
              break;
            }
          }
        }

        if (!el) return;

        // If the matched element belongs to a different ExplorerMainPane
        // instance (e.g. an inspector folder pane), skip — this instance
        // must only scroll its own viewport.
        if (!viewport.contains(el)) return;

        let scrollParent: HTMLElement | null = el.parentElement;
        while (scrollParent && scrollParent !== document.body) {
          const style = window.getComputedStyle(scrollParent);
          const overflowY = style.overflowY;
          if (
            (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden" || overflowY === "overlay") &&
            scrollParent.scrollHeight > scrollParent.clientHeight
          ) {
            break;
          }
          scrollParent = scrollParent.parentElement;
        }
        if (!scrollParent || scrollParent === document.body) {
          let fallback: HTMLElement | null = el.parentElement;
          while (fallback && fallback !== document.body) {
            if (fallback.scrollHeight > fallback.clientHeight + 1) {
              scrollParent = fallback;
              break;
            }
            fallback = fallback.parentElement;
          }
        }
        const target = scrollParent && scrollParent !== document.body ? scrollParent : viewport;
        const targetRect = target.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const elTop = elRect.top - targetRect.top + target.scrollTop;
        const desiredTop = elTop - target.clientHeight / 2 + elRect.height / 2;
        const maxTop = Math.max(0, target.scrollHeight - target.clientHeight);
        const clampedTop = Math.max(0, Math.min(desiredTop, maxTop));

        if (Math.abs(clampedTop - target.scrollTop) > 1) {
          target.scrollTo({ top: clampedTop, behavior: "smooth" });
        }
      });
    };

    // Capture phase so we run before any per-pane React handler that might
    // consume the event. We deliberately do NOT call preventDefault here for
    // non-matching keys — only on a successful match do we preventDefault to
    // stop the key from reaching focused inputs that aren't INPUT/TEXTAREA.
    window.addEventListener("keydown", handleWindowTypeAhead, true);
    return () => window.removeEventListener("keydown", handleWindowTypeAhead, true);
  }, [controlledSelectedIds, setVisibleSelectedIds, contextMenu.visible]);

  const handleViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Block if native drag is active AND we started from an item (item drag)
    // Allow marquee selection even during native drag if we started from empty space
    if (isNativeDragActiveRef.current && pointerDownOnItemRef.current) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("[data-item-id]") || target?.closest(".explorer-context-menu")) {
      return;
    }

    // Belt-and-braces: drop the ghost on empty-space clicks too.
    if (wasRecentNativeDrag() || dragGhost.visible) {
      setDragGhost({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });
      setDragOverFolderId(null);
    }

    if (contextMenu.visible) {
      setContextMenu((prev) => ({ ...prev, visible: false }));
    }
    // Note: don't cancel rename here. Let the onBlur + onClick flow handle it:
    //   - Click on item  → handleItemClick cancels rename
    //   - Click outside  → handleViewportClick submits rename
    // Cancelling here would nullify renamingIdRef before onBlur/onClick run.

    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const startX = e.clientX - rect.left + container.scrollLeft;
    const startY = e.clientY - rect.top + container.scrollTop;

    pointerDownOnItemRef.current = false;
    // Use controlledSelectedIds (prop value) for accurate current selection state
    const currentSel = controlledSelectedIds;
    selectionSessionRef.current = {
      active: true,
      pointerId: e.pointerId,
      startX,
      startY,
      startSelectionIds: [...currentSel],
      ctrlKey: e.ctrlKey || e.metaKey,
      shiftKey: e.shiftKey,
      moved: false,
    };
    selectionRectCacheRef.current = [];
    lastMarqueeSelectionRef.current = [...currentSel];
    setSelectionStart({ x: startX, y: startY });
    setSelectionRect(null);
    pendingRectRef.current = null;
    stopSelectionRaf();
    renderSelectionOverlay(null);
  };

  const handleViewportPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const session = selectionSessionRef.current;
    // Block if selection not active, wrong pointer, OR dragging an item
    if (!session.active || session.pointerId !== e.pointerId || (isNativeDragActiveRef.current && pointerDownOnItemRef.current)) {
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const currentX = e.clientX - rect.left + container.scrollLeft;
    const currentY = e.clientY - rect.top + container.scrollTop;
    const width = Math.abs(currentX - session.startX);
    const height = Math.abs(currentY - session.startY);

    if (!session.moved && width < DRAG_SELECT_DISTANCE_THRESHOLD && height < DRAG_SELECT_DISTANCE_THRESHOLD) {
      return;
    }

    if (!session.moved) {
      session.moved = true;
      setIsSelecting(true);
      selectionRectCacheRef.current = Array.from(container.querySelectorAll<HTMLElement>("[data-item-id]"))
        .map((el) => {
          const id = el.getAttribute("data-item-id");
          if (!id) return null;
          return { id, rect: el.getBoundingClientRect() };
        })
        .filter((entry): entry is { id: string; rect: DOMRect } => Boolean(entry));
    }

    const nextRect = {
      x: Math.min(session.startX, currentX),
      y: Math.min(session.startY, currentY),
      width,
      height,
    };
    scheduleSelectionRectUpdate(nextRect);

    const selectionViewportRect = new DOMRect(
      rect.left + nextRect.x - container.scrollLeft,
      rect.top + nextRect.y - container.scrollTop,
      nextRect.width,
      nextRect.height
    );

    const intersectingIds = selectionRectCacheRef.current
      .filter(({ rect: itemRect }) => rectsIntersect(selectionViewportRect, itemRect))
      .map(({ id }) => id);

    const nextIds = calculateMarqueeSelection(intersectingIds);

    if (JSON.stringify(nextIds) !== JSON.stringify(lastMarqueeSelectionRef.current)) {
      lastMarqueeSelectionRef.current = nextIds;
      previewSelection(nextIds);
    }
  };

  const finishViewportSelection = useCallback((pointerId?: number, options?: { cancel?: boolean }) => {
    const session = selectionSessionRef.current;
    if (!session.active) return false;
    if (pointerId !== undefined && session.pointerId !== null && pointerId !== session.pointerId) return false;

    const moved = session.moved;
    const finalSelectionIds = selectionPreviewIdsRef.current ?? lastMarqueeSelectionRef.current;
    selectionSessionRef.current = {
      active: false,
      pointerId: null,
      startX: 0,
      startY: 0,
      startSelectionIds: [],
      ctrlKey: false,
      shiftKey: false,
      moved: false,
    };
    selectionRectCacheRef.current = [];
    lastMarqueeSelectionRef.current = [];
    stopSelectionRaf();
    pendingRectRef.current = null;
    setSelectionStart(null);
    setIsSelecting(false);
    setSelectionRect(null);
    renderSelectionOverlay(null);

    // Flush any pending batched selection
    if (selectionBatchingRef.current.rafId !== null) {
      cancelAnimationFrame(selectionBatchingRef.current.rafId);
      selectionBatchingRef.current.rafId = null;
    }
    const batchPending = selectionBatchingRef.current.pendingIds ?? finalSelectionIds;
    selectionBatchingRef.current.pendingIds = null;
    selectionBatchingRef.current.previewIds = null;

    if (options?.cancel) {
      selectionPreviewIdsRef.current = null;
      return moved;
    }

    if (moved) {
      viewportPointerClickSuppressRef.current = true;
      commitSelection(batchPending);
      setTimeout(() => {
        viewportPointerClickSuppressRef.current = false;
      }, 0);
      return true;
    }

    commitSelection([]);
    return false;
  }, [commitSelection, renderSelectionOverlay, stopSelectionRaf]);

  const handleViewportPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    finishViewportSelection(e.pointerId);
  };

  const handleViewportPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    finishViewportSelection(e.pointerId, { cancel: true });
  };

    // Handlers
  // Mousedown: start a 500ms timer. If mouseup fires quickly (single click), timer completes and click fires.
  // If mouseup doesn't fire quickly, the timer fires (double-click in progress) and click should be ignored.
  const handleItemPointerDown = (e: React.PointerEvent, item: FSItem) => {
    // Ignore side-button clicks (X1/X2 = button 3/4). Even if the X1/X2
    // mousedown capture handler is missing the event for any reason, the React
    // pointerdown for the item should not start a selection/drag session.
    // Returning here leaves `pointerDownMetaRef` unchanged so the next
    // legitimate left-mouse-down starts fresh.
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    pointerDownOnItemRef.current = true;

    // Always kill any leftover ghost at the start of a new pointer-down.
    // The previous condition (`wasRecentNativeDrag() || dragGhost.visible`)
    // missed the case where a prior drag session was abandoned with the
    // ghost still visible but neither flag set (e.g. cancelled before
    // nativeDragStartedRef fired, or finished without firing
    // handleItemPointerUp). Without this reset the React drag-ghost tooltip
    // could linger on screen and confuse the user.
    if (dragGhost.visible) {
      setDragGhost({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });
      setDragOverFolderId(null);
    }
    selectionSessionRef.current = {
      active: false,
      pointerId: null,
      startX: 0,
      startY: 0,
      startSelectionIds: [],
      ctrlKey: false,
      shiftKey: false,
      moved: false,
    };
    selectionPreviewIdsRef.current = null;
    // Use controlledSelectedIds (prop value) for accurate current selection state
    pointerDownMetaRef.current = {
      itemId: item.id,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      dragIntent: false,
      ctrlKey: e.ctrlKey || e.metaKey,
      shiftKey: e.shiftKey,
      selectionSnapshot: [...controlledSelectedIds],
    };
    // Store modifier keys separately - this ref is NOT reset in pointerUp so it survives until click fires
    pointerDownKeysRef.current = { ctrlKey: e.ctrlKey || e.metaKey, shiftKey: e.shiftKey };

    if (e.button !== 0) return;

    // Update anchor only for non-Shift clicks (Shift+Click preserves the previous anchor)
    if (!e.shiftKey) {
      lastClickedItemIdRef.current = item.id;
      shiftArrowAnchorRef.current = null;
      shiftArrowEdgeIdxRef.current = -1;
    }

    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !selectedIdsRef.current.includes(item.id)) {
      commitSelection([item.id]);
    }
  };

  const handleItemPointerMove = (e: React.PointerEvent, item: FSItem) => {
    if (e.buttons !== 1) {
      // Only left-mouse-button-held (buttons mask == 0b001) should drive a
      // drag. X1/X2 side-buttons leave the mask set to bit 3/4 and would
      // otherwise sneak a drag in when the user just holds a side button
      // while moving the mouse around. Bail out early.
      return;
    }
    const meta = pointerDownMetaRef.current;
    if (meta.itemId !== item.id) return;

    // Don't start a new internal drag session if a native OLE drag is active
    // or has just completed — the OS owns the drag now.
    if (nativeDragStartedRef.current || isNativeDragActiveRef.current || wasRecentNativeDrag()) return;
    // Block ghost resurrection for 5s after force-reset. The React render
    // that hides the ghost may not have flushed yet, so without this guard
    // a fast pointermove (or a click that immediately re-enters drag-start
    // at line 3086+) could re-enable visible:true with stale label/count.
    if (forceResetAtRef.current > 0 && Date.now() - forceResetAtRef.current < 5000) return;

    const dx = e.clientX - meta.x;
    const dy = e.clientY - meta.y;
    if (Math.hypot(dx, dy) >= DRAG_ITEM_DISTANCE_THRESHOLD) {
      meta.moved = true;
      meta.dragIntent = true;

      if (!pointerDragSessionRef.current.active) {
        // Normalize item.id for comparison with snapshot (which uses forward-slash)
        const normalizedItemId = item.id.replace(/\\/g, "/");
        // Normalize snapshot to ensure consistent comparison
        const normalizedSnapshot = meta.selectionSnapshot.map(id => id.replace(/\\/g, "/"));
        // Prefer the snapshot taken at pointer-down time. selectedIdsRef can
        // be momentarily stale (e.g. when the parent re-rendered with an
        // intermediate value between two commits inside the same event
        // handler) and the snapshot reliably reflects the selection the user
        // actually saw when they pressed the mouse button.
        const currentSelection =
          normalizedSnapshot.length > 0
            ? normalizedSnapshot
            : selectedIdsRef.current.map(id => id.replace(/\\/g, "/"));
        let sourceIds: string[];

        if (meta.ctrlKey) {
          sourceIds = currentSelection.includes(normalizedItemId)
            ? currentSelection.filter((id) => id !== normalizedItemId)
            : [...currentSelection, normalizedItemId];
        } else if (meta.shiftKey && lastClickedItemIdRef.current) {
          // Shift+Drag: range selection from anchor to current item
          // Replaces selection with the range (Windows behavior)
          const anchorId = lastClickedItemIdRef.current.replace(/\\/g, "/");
          const normalizedAnchor = anchorId.replace(/\\/g, "/");
          const anchorIndex = sortedChildrenRef.current.findIndex((c) => c.id.replace(/\\/g, "/") === normalizedAnchor);
          const currentIndex = sortedChildrenRef.current.findIndex((c) => c.id.replace(/\\/g, "/") === normalizedItemId);
          if (anchorIndex !== -1 && currentIndex !== -1) {
            const start = Math.min(anchorIndex, currentIndex);
            const end = Math.max(anchorIndex, currentIndex);
            sourceIds = sortedChildrenRef.current.slice(start, end + 1).map((c) => c.id.replace(/\\/g, "/"));
          } else {
            sourceIds = currentSelection.includes(normalizedItemId) ? [...currentSelection] : [normalizedItemId];
          }
        } else {
          sourceIds = currentSelection.includes(normalizedItemId) ? [...currentSelection] : [normalizedItemId];
        }

        if (JSON.stringify(selectedIdsRef.current) !== JSON.stringify(sourceIds)) {
          // Use batched preview for smooth drag selection
          previewSelection(sourceIds);
        }

        pointerDragSessionRef.current = {
          active: true,
          sourceIds,
          primaryId: item.id,
          latestClientX: e.clientX,
          latestClientY: e.clientY,
          ctrlKey: e.ctrlKey || e.metaKey,
        };

        // Also set internalDragStateRef for native drag-out
        const dragMode = (e.ctrlKey || e.metaKey) ? "copy" : "move";
        const sourcePaths = sourceIds
          .map((id) => visibleItems.find((i) => i.id.replace(/\\/g, "/") === id)?.path)
          .filter((p): p is string => Boolean(p));
        internalDragStateRef.current = {
          active: true,
          sourceIds,
          sourcePaths,
          mode: dragMode
        };

        setDraggedItemId(item.id);
        setDragGhost((prevOrInitial) => {
          // Safety: only show ghost with real data
          if (!item.name || sourceIds.length === 0) {
            return prevOrInitial;
          }
          return {
            visible: true,
            x: e.clientX,
            y: e.clientY,
            label: item.name,
            count: sourceIds.length,
            mode: dragMode,
          };
        });
      } else {
        pointerDragSessionRef.current.latestClientX = e.clientX;
        pointerDragSessionRef.current.latestClientY = e.clientY;
        pointerDragSessionRef.current.ctrlKey = e.ctrlKey || e.metaKey;
        setDragGhost((prev) => {
          // Hard safety net: don't show a ghost with empty label/count.
          // If prev has no data, keep it invisible — protects against any
          // stale pointermove after a native OLE drag completes.
          if (!prev.label && !prev.count) {
            return prev;
          }
          return {
            ...prev,
            visible: true,
            x: e.clientX,
            y: e.clientY,
            mode: (e.ctrlKey || e.metaKey) ? "copy" : "move",
          };
        });
      }

      const hoveredElement = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const hoveredItem = hoveredElement?.closest("[data-item-id][data-item-type='directory']") as HTMLElement | null;
      const hoveredFolderId = hoveredItem?.getAttribute("data-item-id");
      if (hoveredFolderId && hoveredFolderId !== item.id) {
        setDragOverFolderId(hoveredFolderId);
      } else {
        setDragOverFolderId(null);
      }
    }
  };

  const handleItemPointerUp = (itemId?: string) => {
    const pointerDrag = pointerDragSessionRef.current;
    if (pointerDrag.active) {
      // Skip if a native OLE drag was just initiated — the OS handled (or is
      // handling) the drop and we must not run an internal copy/move.
      if (wasRecentNativeDrag()) {
        pointerDragSessionRef.current = { active: false, sourceIds: [], primaryId: null, latestClientX: 0, latestClientY: 0, ctrlKey: false };
        internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
        setDragOverFolderId(null);
        setDraggedItemId(null);
        setDragGhost({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });
        return;
      }
      const hoveredElement = document.elementFromPoint(pointerDrag.latestClientX, pointerDrag.latestClientY) as HTMLElement | null;
      const hoveredItem = hoveredElement?.closest("[data-item-id][data-item-type='directory']") as HTMLElement | null;
      const targetFolderId = hoveredItem?.getAttribute("data-item-id");
      const targetFolder = targetFolderId
        ? sortedChildrenRef.current.find((entry) => entry.id === targetFolderId && entry.type === "directory")
        : null;
      const sourceIds = pointerDrag.sourceIds;
      const primaryId = pointerDrag.primaryId;
      const mode = pointerDrag.ctrlKey ? "copy" : "move";
      const dragState = internalDragStateRef.current;
      const primaryItem = primaryId
        ? itemsRef.current.find((entry) => entry.id === primaryId)
        : null;
      const sourceParentPath = primaryItem?.parentId || "";

      // Determine target folder
      const targetPath = targetFolder?.path || null;
      const hasValidFolderDrop = Boolean(
        targetFolder &&
        targetPath &&
        !sourceIds.includes(targetFolder.id) &&
        targetPath !== sourceParentPath
      );

      pointerDragSessionRef.current = { active: false, sourceIds: [], primaryId: null, latestClientX: 0, latestClientY: 0, ctrlKey: false };
      nativeDragStartedRef.current = false;
      setDragOverFolderId(null);
      setDraggedItemId(null);
      setDragGhost({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });

      // Get source paths from ref (most reliable) or convert from IDs
      const sourcePaths = dragState.active && dragState.sourcePaths.length > 0
        ? dragState.sourcePaths
        : sourceIds
            .map((id) => itemsRef.current.find((item) => item.id === id || item.id.replace(/\\/g, "/") === id)?.path)
            .filter((p): p is string => Boolean(p));

      // Handle drop: folder drop takes priority, otherwise viewport drop (copy/move to current folder)
      if (hasValidFolderDrop && moveOrCopyItems) {
        if (sourcePaths.length === 0) {
          internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
          pointerDownOnItemRef.current = false;
          return;
        }

        void moveOrCopyItems(sourcePaths, targetPath!, mode)
          .then(async (movedOrCopiedPaths) => {
            await refreshCurrentDirectory?.();
            if (movedOrCopiedPaths?.length) {
              commitSelection(movedOrCopiedPaths);
            }
            explorer.setStatusMessage(
              mode === "copy"
                ? t("Đã sao chép mục vào thư mục đích.", "Copied item(s) into target folder.")
                : t("Đã di chuyển mục vào thư mục đích.", "Moved item(s) into target folder.")
            );
          })
          .catch((error) => {
            explorer.setStatusMessage(`${mode === "copy" ? "Copy" : "Move"} error: ${error}`);
          });
      } else if (sourceIds.length > 0 && moveOrCopyItems) {
        // No folder was under cursor → viewport drop (dropped on empty space)
        // Only copy (Ctrl+drag) to same folder is allowed; move to same folder = no-op
        const currentPath = activeTabPathRef.current;

        // Derive source paths from IDs (most reliable fallback)
        const derivedSourcePaths = sourceIds
          .map((id) => itemsRef.current.find((item) => item.id === id || item.id.replace(/\\/g, "/") === id)?.path)
          .filter((p): p is string => Boolean(p));

        const isSameFolder = derivedSourcePaths.every((srcPath) => {
          const srcDir = srcPath.substring(0, srcPath.lastIndexOf("\\"));
          return srcDir === currentPath;
        });
        if (currentPath && derivedSourcePaths.length > 0 && !(mode === "move" && isSameFolder)) {
          void moveOrCopyItems(derivedSourcePaths, currentPath, mode)
            .then(async (movedOrCopiedPaths) => {
              await refreshCurrentDirectory?.();
              if (movedOrCopiedPaths?.length) {
                commitSelection(movedOrCopiedPaths);
              }
              explorer.setStatusMessage(
                mode === "copy"
                  ? t("Đã sao chép mục vào thư mục hiện tại.", "Copied item(s) into the current folder.")
                  : t("Đã di chuyển mục vào thư mục hiện tại.", "Moved item(s) into the current folder.")
              );
            })
            .catch((error) => {
              explorer.setStatusMessage(`${mode === "copy" ? "Copy" : "Move"} error: ${error}`);
            });
        }
      }

      internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
      if (!itemId || pointerDownMetaRef.current.itemId === itemId || pointerDownMetaRef.current.itemId === primaryId) {
        pointerDownMetaRef.current = { itemId: null, x: 0, y: 0, moved: false, dragIntent: false, ctrlKey: false, shiftKey: false, selectionSnapshot: [] };
      }
      pointerDownOnItemRef.current = false;
      return;
    }

    if (!itemId || pointerDownMetaRef.current.itemId === itemId) {
      // Slow-click pending flag naturally expires via setTimeout in pointerDown

      pointerDownMetaRef.current = { itemId: null, x: 0, y: 0, moved: false, dragIntent: false, ctrlKey: false, shiftKey: false, selectionSnapshot: [] };
    }
    pointerDownOnItemRef.current = false;
    setDragGhost({ visible: false, x: 0, y: 0, label: "", count: 0, mode: "move" });
  };
  handleItemPointerUpRef.current = handleItemPointerUp;

  // Date filter helper functions
  const formatDateTime = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const formatTimeOnly = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const isToday = (date: Date) => {
    const today = new Date();
    return date.toDateString() === today.toDateString();
  };

  const isYesterday = (date: Date) => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return date.toDateString() === yesterday.toDateString();
  };

  const isLastWeek = (date: Date) => {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    return date >= weekAgo;
  };

  const isEarlierThisMonth = (date: Date) => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    return date >= startOfMonth && date < weekAgo;
  };

  const isEarlierThisYear = (date: Date) => {
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    return date >= startOfYear && date < startOfMonth;
  };

  const isLongTimeAgo = (date: Date) => {
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    return date < startOfYear;
  };

  const itemMatchesDateFilter = (item: FSItem, filter: DateFilterState): boolean => {
    if (!filter.active) return true;
    const itemDate = new Date(item.updatedAt);

    if (filter.mode === 'specific' && filter.specificDate) {
      const filterDate = new Date(filter.specificDate);
      return itemDate.toDateString() === filterDate.toDateString();
    }

    if (filter.mode === 'range' && filter.startDate && filter.endDate) {
      const start = new Date(filter.startDate);
      const end = new Date(filter.endDate);
      return itemDate >= start && itemDate <= end;
    }

    if (filter.mode === 'preset' && filter.preset) {
      switch (filter.preset) {
        case 'today': return isToday(itemDate);
        case 'yesterday': return isYesterday(itemDate);
        case 'lastWeek': return isLastWeek(itemDate);
        case 'earlierThisMonth': return isEarlierThisMonth(itemDate);
        case 'earlierThisYear': return isEarlierThisYear(itemDate);
        case 'longTimeAgo': return isLongTimeAgo(itemDate);
      }
    }

    return true;
  };

  const itemMatchesTypeFilter = (item: FSItem, filter: { active: boolean; selectedTypes: Set<string> }): boolean => {
    if (!filter.active || filter.selectedTypes.size === 0) return true;
    const itemType = item.type === 'directory' ? 'File folder' : `${item.name.split('.').pop()?.toUpperCase() || 'File'} File`;
    return filter.selectedTypes.has(itemType);
  };

  const getDateFilterLabel = (filter: DateFilterState): string => {
    if (!filter.active) return '';
    if (filter.mode === 'specific' && filter.specificDate) {
      return new Date(filter.specificDate).toLocaleDateString();
    }
    if (filter.mode === 'preset' && filter.preset) {
      const labels: Record<DateFilterPreset, string> = {
        today: 'Today',
        yesterday: 'Yesterday',
        lastWeek: 'Last Week',
        earlierThisMonth: 'Earlier This Month',
        earlierThisYear: 'Earlier This Year',
        longTimeAgo: 'A Long Time Ago',
      };
      return labels[filter.preset];
    }
    return '';
  };

  // Calculate visible items (same as before but moved here to avoid hoisting issues)
  const visibleSearchItems = !searchFilter.query.trim()
    ? sortedChildren
    : groupedSearchResults.flatMap((group) => {
        const collapsed = collapsedSearchGroups[group.key] ?? group.collapsedByDefault;
        return collapsed ? [] : group.items;
      });

  // Apply date and type filters for Detail View only
  const detailFilteredItems = useMemo(() => {
    return visibleSearchItems.filter(item =>
      itemMatchesDateFilter(item, dateFilter) && itemMatchesTypeFilter(item, typeFilter)
    );
  }, [visibleSearchItems, dateFilter, typeFilter]);

  // Get unique file types from current items (after visibleSearchItems is defined)
  const uniqueTypes = useMemo(() => {
    const types = new Set<string>();
    visibleSearchItems.forEach(item => {
      if (item.type === 'directory') types.add('File folder');
      else {
        const ext = item.name.split('.').pop()?.toUpperCase() || 'File';
        types.add(`${ext} File`);
      }
    });
    return Array.from(types).sort();
  }, [visibleSearchItems]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dateFilterDropdownRef.current && !dateFilterDropdownRef.current.contains(e.target as Node)) {
        setDateFilterDropdownOpen(false);
      }
      if (typeFilterDropdownRef.current && !typeFilterDropdownRef.current.contains(e.target as Node)) {
        setTypeFilterDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleItemMouseDown = (e: React.MouseEvent, item: FSItem) => {
    pointerDownOnItemRef.current = true;
    e.stopPropagation();
    if (e.button !== 0 || renamingId) return;

    pendingClickItemIdRef.current = item.id;

    if (folderClickTimerRef.current) {
      clearTimeout(folderClickTimerRef.current);
      folderClickTimerRef.current = null;
      pendingSingleClickItemRef.current = null;
    }
  };

  // Detail View column resize handlers
  const handleColumnResizeStart = (e: React.MouseEvent, column: string) => {
    e.preventDefault();
    e.stopPropagation();
    setResizingColumn(column);
    resizingStartXRef.current = e.clientX;
    resizingStartWidthRef.current = columnWidths[column as keyof typeof columnWidths];
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleColumnResizeMove = useCallback((e: MouseEvent) => {
    if (!resizingColumn) return;
    const delta = e.clientX - resizingStartXRef.current;
    const minWidths: Record<string, number> = { name: 120, date: 100, type: 60, size: 50 };
    const newWidth = Math.max(minWidths[resizingColumn] ?? 60, resizingStartWidthRef.current + delta);
    setColumnWidths(prev => ({ ...prev, [resizingColumn]: newWidth }));
  }, [resizingColumn]);

  const handleColumnResizeEnd = useCallback(() => {
    if (!resizingColumn) return;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem("NEXUS_DETAIL_COLUMNS", JSON.stringify(columnWidths));
    setResizingColumn(null);
  }, [resizingColumn, columnWidths]);

  useEffect(() => {
    if (resizingColumn) {
      window.addEventListener('mousemove', handleColumnResizeMove);
      window.addEventListener('mouseup', handleColumnResizeEnd);
      return () => {
        window.removeEventListener('mousemove', handleColumnResizeMove);
        window.removeEventListener('mouseup', handleColumnResizeEnd);
      };
    }
  }, [resizingColumn, handleColumnResizeMove, handleColumnResizeEnd]);

  const handleItemClick = (e: React.MouseEvent, item: FSItem) => {
    e.stopPropagation();

    // Block click if context menu was just closed (prevent click-through)
    if (contextMenuActiveRef.current) {
      return;
    }

    // Trigger on-demand PSD/AI decode on single click so the file grid
    // shows a real preview instead of the default application icon.
    if (item.type === "file") {
      const ext = item.name.toLowerCase().split('.').pop();
      if (ext === "psd" || ext === "psb") {
        void decodePsdOnDemand(item.path);
      } else if (ext === "ai" || ext === "eps") {
        void decodeAiOnDemand(item.path);
      }
    }

    // pendingClickItemIdRef is set by handleItemMouseDown (which runs before onClick in
    // the React event cycle), reliably bridging the gap that pointerMeta.itemId gets
    // cleared by pointerUp before click fires.
    const pendingItemId = pendingClickItemIdRef.current;
    const pointerMeta = pointerDownMetaRef.current;
    const usedMeta = pendingItemId === item.id ? pointerMeta : null;
    if (usedMeta?.moved || usedMeta?.dragIntent) {
      return;
    }

    if (contextMenu.visible) setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });

    // Detect Ctrl/Meta/Shift. Use pointerDownKeysRef because pointerDownMetaRef is reset
    // in handleItemPointerUp BEFORE onClick fires.
    const pointerCtrl = pointerDownKeysRef.current.ctrlKey;
    const pointerShift = pointerDownKeysRef.current.shiftKey;
    // Use controlledSelectedIds (prop value) for accurate current selection state
    const currentSelection = controlledSelectedIds;

    // Cancel rename if user clicks somewhere else
    if (renamingId && renamingId !== item.id) {
      setRenamingId(null);
    }

    if (pointerCtrl) {
      // Ctrl+Click: toggle selection (Windows behavior)
      // - If item is selected: remove from selection
      // - If item is not selected: add to selection
      // Anchor does NOT change with Ctrl+Click
      const normalizedItemId = item.id.replace(/\\/g, "/");
      if (currentSelection.includes(normalizedItemId)) {
        commitSelection(currentSelection.filter((id) => id !== normalizedItemId));
      } else {
        commitSelection([...currentSelection, normalizedItemId]);
      }
      return;
    }

    if (pointerShift && lastClickedItemIdRef.current) {
      // Shift+Click: range selection from anchor to current item (Windows behavior)
      // - Replaces entire selection with the range
      // - Anchor does NOT change with Shift+Click
      const anchorId = lastClickedItemIdRef.current;
      const normalizedAnchor = anchorId.replace(/\\/g, "/");
      const normalizedItem = item.id.replace(/\\/g, "/");
      const anchorIndex = sortedChildren.findIndex(c => c.id.replace(/\\/g, "/") === normalizedAnchor);
      const currentIndex = sortedChildren.findIndex(c => c.id.replace(/\\/g, "/") === normalizedItem);

      if (anchorIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(anchorIndex, currentIndex);
        const end = Math.max(anchorIndex, currentIndex);
        const rangeIds = sortedChildren.slice(start, end + 1).map(c => c.id.replace(/\\/g, "/"));
        commitSelection(rangeIds);
        return;
      }
    }

    // Regular click: replace selection with single item and update anchor
    commitSelection([item.id]);
    lastClickedItemIdRef.current = item.id;

    // Clicking a file in any mode closes the folder inspection pane so the
    // Details Pane can show the file preview. For folders, commitSelection
    // already fires onFolderClick through updateSelectionSideEffects — no
    // extra timer needed (and no delay), because double-click's navigation
    // runs independently via handleItemDoubleClick.
    if (!isInspectorPane && item.type !== "directory") {
      onFileClickRef.current?.();
    }

    // Folders: the 250ms timer was a redundant duplicate of the
    // commitSelection → updateSelectionSideEffects → onFolderClick chain
    // above, which already opens the Folder Inspector on single click.
    // Removing the timer eliminates the visible delay. Double-click still
    // navigates via handleItemDoubleClick, which clears any pending state.
    pendingClickItemIdRef.current = null;
  };

  const handleItemDoubleClick = (item: FSItem) => {
    // Cancel any pending single-click action (folder/file)
    if (folderClickTimerRef.current) {
      clearTimeout(folderClickTimerRef.current);
      folderClickTimerRef.current = null;
    }
    pendingSingleClickItemRef.current = null;

    // In Folder Inspector, only allow double-click to open files, not navigate into folders
    if (isInspectorPane && item.type === "directory") {
      return; // Do nothing - folder navigation is disabled in inspector
    }

    // Outside inspector, double-click always navigates/opens
    if (item.type === "directory") {
      navigateTo(item.id);
    } else {
      void openFileForEditing(item.id);
    }
  };

  const handleViewportClick = (e: React.MouseEvent) => {
    if (viewportPointerClickSuppressRef.current) {
      viewportPointerClickSuppressRef.current = false;
      return;
    }

    const target = e.target as HTMLElement | null;
    if (target?.closest("[data-item-id]")) {
      return;
    }

    const idToSubmit = renamingIdRef.current;
    if (idToSubmit !== null) {
      handleRenameSubmit(idToSubmit);
      return;
    }

    commitSelection([]);
  };

  const handleContextMenu = (e: React.MouseEvent, item: FSItem | null) => {
    e.preventDefault();
    e.stopPropagation();

    if (renamingId) {
      setRenamingId(null);
    }

    // Phase 2.2: Right-clicking empty space deselects any highlighted item
    // so the background menu targets the folder, not the previously selected
    // item. Right-clicking an item that is part of the current selection
    // keeps that selection (Explorer behaviour); right-clicking an
    // unselected item replaces the selection with just that item.
    if (item) {
      if (!selectedIdsSet.has(item.id.replace(/\\/g, "/"))) {
        commitSelection([item.id]);
      }
    } else {
      if (controlledSelectedIds.length > 0) {
        commitSelection([]);
      }
    }

    const openWithTarget = item?.type === "file"
      ? item
      : (() => {
          const selectedFileIds = controlledSelectedIds
            .map((id) => visibleItems.find((entry) => entry.id.replace(/\\/g, "/") === id.replace(/\\/g, "/")) ?? null)
            .filter((entry): entry is FSItem => Boolean(entry) && entry.type === "file");
          return selectedFileIds.length === 1 ? selectedFileIds[0] : null;
        })();
    setContextMenuOpenWithFile(openWithTarget);

    const menuWidth = 240;
    const gap = 12;

    let posX = e.clientX;
    let posY = e.clientY;

    // Adjust X position if menu would overflow right edge
    if (posX + menuWidth > window.innerWidth - gap) {
      posX = window.innerWidth - menuWidth - gap;
      posX = Math.max(gap, posX);
    }

    // Keep Y at click position, only adjust if menu would overflow bottom
    const menuHeight = 420; // Will be updated after render
    if (posY + menuHeight > window.innerHeight - gap) {
      posY = window.innerHeight - menuHeight - gap;
      posY = Math.max(gap, posY);
    }

    setContextMenu({
      visible: true,
      x: posX,
      y: posY,
      clientX: e.clientX,
      clientY: e.clientY,
      targetItem: item,
      showMoreOptions: false,
    });

    // Emit event to close header dropdowns (View, Sort, etc.)
    dropdownEventBus.emit(DROPDOWN_EVENTS.CONTEXT_MENU_OPENED);
  };

  // Rename commit
  const handleRenameSubmit = (id: string) => {
    const inputValue = renameInputRef.current?.value ?? renameInput;
    if (inputValue.trim()) {
      const currentItem = visibleItems.find(item => item.id === id);
      const currentName = currentItem?.name ?? inputValue;
      const dotIndex = currentName.lastIndexOf(".");
      const extension = currentItem?.type === "file" && dotIndex > 0 ? currentName.slice(dotIndex) : "";
      const nextName = explorer.hideFileExtensions && extension && !inputValue.trim().includes(".")
        ? `${inputValue.trim()}${extension}`
        : inputValue.trim();
      renameItem(id, nextName);
    }
    setRenamingId(null);
  };

  // Helper file icons mapper based on extensions
  const getFileIcon = (file: FSItem, sizeClass: string = "w-9 h-9") => {
    const ext = file.name.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "blend":
      case "c4d":
      case "hip":
      case "hipnc":
      case "mb":
      case "ma":
      case "obj":
      case "fbx":
      case "3ds":
      case "gltf":
        return <Boxes className={`${sizeClass} text-indigo-400`} />;
      case "exr":
      case "tiff":
      case "tif":
      case "psd":
      case "ai":
      case "png":
      case "jpg":
      case "jpeg":
      case "gif":
      case "webp":
      case "pur":
        return <FileImage className={`${sizeClass} text-emerald-400`} />;
      case "mp4":
      case "mov":
      case "avi":
      case "mkv":
      case "webm":
        return <Film className={`${sizeClass} text-rose-400`} />;
      case "mp3":
      case "m4a":
      case "wav":
      case "flac":
        return <Music className={`${sizeClass} text-amber-400`} />;
      case "md":
      case "txt":
        return <FileText className={`${sizeClass} text-sky-400`} />;
      case "ts":
      case "tsx":
      case "html":
      case "css":
      case "js":
      case "json":
        return <Code className={`${sizeClass} text-[#8b5cf6]`} />;
      case "zip":
      case "rar":
      case "tar":
      case "gz":
        return <Archive className={`${sizeClass} text-amber-500`} />;
      default:
        return <File className={`${sizeClass} text-gray-400`} />;
    }
  };

  const getTagStyle = (tag?: string) => {
    switch (tag) {
      case "Warning": return "bg-red-500/20 text-red-400 border-red-500/30 font-medium";
      case "WIP": return "bg-blue-500/20 text-blue-400 border-blue-500/30 font-medium";
      case "Deliverable": return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30 font-medium";
      case "Archived": return "bg-amber-500/20 text-amber-400 border-amber-500/30 font-medium";
      case "Draft": return "bg-purple-500/20 text-purple-400 border-purple-500/30 font-medium";
      default: return "";
    }
  };

  const getTagDotStyle = (tag?: string) => {
    switch (tag) {
      case "Warning": return "bg-red-500";
      case "WIP": return "bg-blue-500";
      case "Deliverable": return "bg-emerald-500";
      case "Archived": return "bg-amber-500";
      case "Draft": return "bg-purple-500";
      default: return "bg-stone-500";
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const handleDragStart = (e: React.DragEvent, item: FSItem) => {
    const pointerMeta = pointerDownMetaRef.current;
    if (pointerMeta.itemId === item.id && !pointerMeta.dragIntent) {
      e.preventDefault();
      return;
    }

    pointerDownOnItemRef.current = true;
    e.stopPropagation();
    // Don't set isNativeDragActiveRef here - it should only be set when
    // native OLE drag starts (pointer leaves window). For HTML5 drag within
    // the window, we need it to remain false.

    const currentSelection = selectedIdsRef.current;
    const pointerCtrl = pointerMeta.itemId === item.id ? pointerMeta.ctrlKey : false;
    const pointerShift = pointerMeta.itemId === item.id ? pointerMeta.shiftKey : false;

    let selectedSourceIds: string[];
    if (pointerCtrl) {
      selectedSourceIds = currentSelection.includes(item.id)
        ? currentSelection.filter((id) => id !== item.id)
        : [...currentSelection, item.id];
    } else if (pointerShift && lastClickedItemIdRef.current) {
      // Shift+Drag: range selection from anchor to current item
      // Replaces selection with the range (Windows behavior)
      const anchorId = lastClickedItemIdRef.current;
      const anchorIndex = sortedChildren.findIndex(c => c.id === anchorId);
      const currentIndex = sortedChildren.findIndex(c => c.id === item.id);
      if (anchorIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(anchorIndex, currentIndex);
        const end = Math.max(anchorIndex, currentIndex);
        selectedSourceIds = sortedChildren.slice(start, end + 1).map(c => c.id);
      } else {
        selectedSourceIds = currentSelection.includes(item.id) ? [...currentSelection] : [item.id];
      }
    } else {
      selectedSourceIds = currentSelection.includes(item.id) ? [...currentSelection] : [item.id];
    }

    if (JSON.stringify(controlledSelectedIds) !== JSON.stringify(selectedSourceIds)) {
      commitSelection(selectedSourceIds);
    }

    const internalPayload = JSON.stringify({
      kind: "goku-internal-selection",
      sourceIds: selectedSourceIds,
      primaryId: item.id,
      dragMode: pointerCtrl ? "copy" : "move",
    });

    // Also store in ref for reliable access during drop (dataTransfer may not be available)
    const dragMode = pointerCtrl ? "copy" : "move";
    const sourcePaths = selectedSourceIds
      .map((id) => visibleItems.find((i) => i.id === id)?.path)
      .filter((p): p is string => Boolean(p));
    internalDragStateRef.current = { active: true, sourceIds: selectedSourceIds, sourcePaths, mode: dragMode };
    // Allow a new watchdog timer for this fresh drag session.
    watchdogFiredForDragRef.current = false;

    setDraggedItemId(item.id);
    setDragDropMode(dragMode);
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/plain", item.id);
    e.dataTransfer.setData("text/goku-internal-selection", internalPayload);
  };

  const handleDragEnd = () => {
    handleItemPointerUp();
    isNativeDragActiveRef.current = false;
    nativeDragStartedRef.current = false;
    internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
    setDraggedItemId(null);
    setDragOverFolderId(null);
    setDragDropMode("none");
  };

  const handleDragOver = (e: React.DragEvent, folder: FSItem) => {
    const hasInternalSelection = Array.from(e.dataTransfer.types || []).includes("text/goku-internal-selection");
    if (!hasInternalSelection || folder.type !== "directory" || draggedItemId === folder.id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
    setDragOverFolderId(folder.id);
  };

  const handleDragLeave = (e: React.DragEvent, folderId?: string) => {
    const relatedTarget = e.relatedTarget as Node | null;
    const currentTarget = e.currentTarget as HTMLElement | null;
    if (relatedTarget && currentTarget?.contains(relatedTarget)) return;
    if (!folderId || dragOverFolderId === folderId) {
      setDragOverFolderId(null);
    }
  };

  const handleDrop = async (e: React.DragEvent, targetFolder: FSItem) => {
    pointerDownOnItemRef.current = false;
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolderId(null);

    // Guard: if a native OLE drag was just started (user dragged OUT of the
    // app and back in onto a folder), ignore the drop — the OS already handled
    // the destination copy/move.
    if (wasRecentNativeDrag()) {
      isNativeDragActiveRef.current = false;
      return;
    }

    // Belt-and-braces: if a pointer drag session is still considered active
    // we are likely in the middle of an OLE drag-back. Skip without doing
    // anything — the OS owns this drag.
    if (pointerDragSessionRef.current.active || isNativeDragActiveRef.current) {
      return;
    }

    const dragState = internalDragStateRef.current;

    // Use ref if available (most reliable), otherwise fall back to dataTransfer
    let sourcePaths: string[];
    let mode: "copy" | "move";

    if (dragState.active && dragState.sourcePaths.length > 0) {
      sourcePaths = dragState.sourcePaths;
      mode = dragState.mode;
    } else {
      const rawInternalPayload = e.dataTransfer.getData("text/goku-internal-selection");
      const parsedInternalPayload = rawInternalPayload ? JSON.parse(rawInternalPayload) as { kind?: string; sourceIds?: string[]; dragMode?: string } : null;
      const sourceIds = parsedInternalPayload?.kind === "goku-internal-selection"
        ? (parsedInternalPayload.sourceIds ?? [])
        : (draggedItemId ? [draggedItemId] : []);
      if (sourceIds.length === 0 || sourceIds.includes(targetFolder.id)) return;

      sourcePaths = sourceIds
        .map((id) => visibleItems.find((item) => item.id === id)?.path)
        .filter((path): path is string => Boolean(path));
      if (sourcePaths.length === 0) return;

      mode = (parsedInternalPayload?.dragMode as "copy" | "move") ?? "move";
    }

    try {
      const movedOrCopiedPaths = await moveOrCopyItems?.(sourcePaths, targetFolder.path, mode);
      await refreshCurrentDirectory?.();
      if (movedOrCopiedPaths?.length) {
        commitSelection(movedOrCopiedPaths);
      }
      explorer.setStatusMessage(
        mode === "copy"
          ? t("Đã sao chép mục vào thư mục đích.", "Copied item(s) into target folder.")
          : t("Đã di chuyển mục vào thư mục đích.", "Moved item(s) into target folder.")
      );
    } catch (error) {
      explorer.setStatusMessage(`${mode === "copy" ? "Copy" : "Move"} error: ${error}`);
    } finally {
      internalDragStateRef.current = { active: false, sourceIds: [], sourcePaths: [], mode: "move" };
      setDraggedItemId(null);
      setDragDropMode("none");
    }
  };

  const handleViewportDragOver = (e: React.DragEvent) => {
    const hasInternalSelection = Array.from(e.dataTransfer.types || []).includes("text/goku-internal-selection");
    if (hasInternalSelection) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
      setIsExternalFileDragActive(false);
      // Update dragDropMode based on current ctrl key state
      if (dragDropMode === "none") {
        setDragDropMode(e.ctrlKey ? "copy" : "move");
      }
      return;
    }

    const hasExternalFiles = Array.from(e.dataTransfer.types || []).includes("Files");
    if (hasExternalFiles) {
      e.preventDefault();
      e.stopPropagation();
      if (!isExternalFileDragActive) {
        setIsExternalFileDragActive(true);
      }
      setDragDropMode("external-copy");
      e.dataTransfer.dropEffect = "copy";
      return;
    }

    setIsExternalFileDragActive(false);
  };

  const handleViewportDragLeave = (e: React.DragEvent) => {
    const relatedTarget = e.relatedTarget as Node | null;
    const currentTarget = e.currentTarget as HTMLElement | null;
    if (relatedTarget && currentTarget?.contains(relatedTarget)) return;
    setIsExternalFileDragActive(false);
    setDragDropMode("none");
  };

  const activeTabTitle = activeTab?.title ?? "";

  // Spacing calculation: 0 = most compact, 50 = normal, 100 = most spacious
  const spacing = explorer.spacing;

  // Map spacing (0-100) to class index (0=compact, 1=normal, 2=spacious)
  const spacingLevel = spacing < 33 ? 0 : spacing > 66 ? 2 : 1;

  // Gap classes: [compact, normal, spacious]
  const gridGapClasses = ["gap-1", "gap-2", "gap-3"];
  const listGapClasses = ["gap-0", "gap-1", "gap-2"];
  const tilesGapClasses = ["gap-1", "gap-2", "gap-3"];
  // Dynamic grid gap based on view mode and spacing level
  const gridGapValues: Record<number, [string, string, string]> = {
    1: ["gap-1", "gap-3", "gap-5"], // Icons Large
    2: ["gap-1", "gap-2", "gap-4"], // Icons Medium
    3: ["gap-1", "gap-2", "gap-3"], // Icons Small
  };
  const gridGapClass = gridGapValues[effectiveViewMode]?.[spacingLevel] ?? "gap-2";
  const listGapClass = listGapClasses[spacingLevel];
  const tilesGapClass = tilesGapClasses[spacingLevel];

  // Padding classes: [compact, normal, spacious]
  const listItemPaddingClasses = ["py-0.5 px-2", "py-1 px-2.5", "py-2 px-3"];
  const tilesPaddingClasses = ["p-1", "p-2", "p-3"];
  const gridItemPaddingClasses = ["p-1", "p-2", "p-2.5"];
  const detailsRowPaddingClasses = ["py-0.5", "py-1", "py-2"];

  const listItemPadding = listItemPaddingClasses[spacingLevel];
  const tilesPadding = tilesPaddingClasses[spacingLevel];
  const gridItemPadding = gridItemPaddingClasses[spacingLevel];
  const detailsRowPadding = detailsRowPaddingClasses[spacingLevel];

  // No root background — let goku-content-wrapper show through

  const textTitleColor = "text-stone-100";
  const textMutedColor = "text-stone-500";
  const borderLightColor = "border-white/5";

  const listContainerClass = "bg-theme-content-1/30 border-white/5 divide-white/5 text-stone-300";

  const detailsHeaderClass = "bg-theme-content-4/90 text-stone-400 border-white/5";

  const detailsContainerClass = "text-stone-300 bg-theme-content-2/45 border-white/5";

  const isLightTheme = explorer.theme === "light";

  const isCutItem = (itemId: string) =>
    explorer.clipboard.action === "cut" && explorer.clipboard.itemIds.includes(itemId.replace(/\\/g, "/"));

  const fileItemClass = (isSelected: boolean, isCut: boolean, isHidden: boolean) =>
    isCut
      ? isLightTheme
        ? "bg-black/20 border-black/20 text-black/40 opacity-60"
        : "bg-white/5 border-white/5 text-stone-700 opacity-50"
      : isSelected
        ? "goku-layer-3-selected selection-item text-stone-800 shadow-sm font-bold scale-[1.02]"
        : `bg-overlay/40 border-transparent hover:bg-white/5 hover:border-white/5 text-stone-600${isHidden ? " opacity-50" : ""}`;

  const rowHighlightClass = (isSelected: boolean, isCut: boolean, isHidden: boolean) =>
    isCut
      ? isLightTheme
        ? "bg-black/20 text-black/40 opacity-60"
        : "bg-white/5 text-stone-700 opacity-50"
      : isSelected
        ? "goku-layer-3-selected selection-item"
        : `hover:bg-white/5 text-stone-600 hover:text-stone-800${isHidden ? " opacity-50" : ""}`;

  // Shell icon for "This PC" so the page header matches Windows Explorer.
  // Falls back to a Lucide `HardDrive` while the IPC is in-flight.
  const { dataUrl: thisPcIconUrl } = useSpecialFolderIcon("this_pc");

  // ── This PC (Devices and drives) view ─────────────────────────────────────
  // When the user clicks the "This PC" node in the sidebar we set
  // `currentFolderId = "thispc://"`. Rather than read a real directory we
  // render a dedicated panel that mirrors what Windows File Explorer's
  // "Devices and drives" section shows: a header explaining the location,
  // a categorized list of drives with usage bars, and click-to-open
  // behaviour that routes back through `navigateTo(drivePath)`.
  if (effectiveCurrentPath === "thispc://") {
    const drives: DriveInfo[] =
      driveInfos.length > 0
        ? driveInfos
        : (explorer.drives ?? []).map((p) => ({
            path: p,
            label: "",
            display: `Local Disk (${p.charAt(0).toUpperCase()}:)`,
            driveType: "unknown" as const,
            filesystem: "",
            cloudProvider: null,
            iconUrl: null,
            total: 0,
            used: 0,
            free: 0,
          }));

    return (
      <div
        id="explorer-main-viewport"
        ref={containerRefCallback}
        tabIndex={0}
        onKeyDown={(e) => handleViewportKeyDown(e.nativeEvent)}
        onClick={handleViewportClick}
        onContextMenu={(e) => handleContextMenu(e, null)}
        className="flex-1 overflow-y-auto p-6 relative select-none focus:outline-none"
      >
        <div className="max-w-5xl mx-auto">
          <div className="mb-5">
            <h2 className="text-xl font-semibold text-stone-100 flex items-center gap-2.5">
              {thisPcIconUrl ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "4px",
                    overflow: "hidden",
                    padding: "1px",
                    flexShrink: 0,
                  }}
                >
                  <img
                    src={thisPcIconUrl}
                    alt=""
                    width={22}
                    height={22}
                    style={{ display: "block", imageRendering: "pixelated" }}
                    draggable={false}
                  />
                </span>
              ) : (
                <HardDrive className="w-5 h-5 text-sky-400/90" />
              )}
              {t("This PC", "This PC")}
            </h2>
            <p className="text-[11px] text-stone-500 mt-1">
              {t("Các thiết bị và ổ đĩa được kết nối với máy tính của bạn", "Devices and drives connected to your computer")}
            </p>
          </div>

          <section className="mb-6">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-stone-500 mb-2 px-1">
              {t("Thiết bị và ổ đĩa", "Devices and drives")} ({drives.length})
            </h3>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {drives.map((drive) => {
                const drivePath = drive.path;
                const total = drive.total > 0 ? drive.total : (explorer.diskSpaces?.[drivePath]?.total ?? 0);
                const used = drive.used > 0 ? drive.used : (explorer.diskSpaces?.[drivePath]?.used ?? 0);
                const free = total > 0 ? Math.max(total - used, 0) : 0;
                const usedPercent = total > 0 ? Math.min(Math.max((used / total) * 100, 2), 100) : 0;
                const isDriveSelected = selectedIdsSet.has(drivePath.replace(/\\/g, "/"));

                const handleDriveClick = (e: React.MouseEvent) => {
                  // Single-click on a drive card should only select it,
                  // matching Windows Explorer's "Devices and drives" panel.
                  // Use double-click to actually navigate into the drive.
                  e.stopPropagation();
                  commitSelection([drivePath]);
                };

                const handleDriveDoubleClick = (e: React.MouseEvent) => {
                  e.stopPropagation();
                  navigateTo(drivePath);
                  setShowSpaceAnalyzer(false);
                };

                return (
                  <button
                    key={drivePath}
                    type="button"
                    onClick={handleDriveClick}
                    onDoubleClick={handleDriveDoubleClick}
                    aria-label={`${drive.display}${total > 0 ? `, ${formatFileSize(free)} free of ${formatFileSize(total)}` : ""}`}
                    className={`group/dd flex flex-col items-start gap-2 p-3 rounded-xl bg-white/[0.03] hover:bg-white/[0.07] border transition cursor-pointer text-left ${
                      isDriveSelected
                        ? "border-white/20 ring-1 ring-white/20 bg-white/[0.06]"
                        : "border-white/5 hover:border-white/10"
                    }`}
                    style={isDriveSelected ? { boxShadow: `inset 0 0 0 1px ${accentColor}55` } : undefined}
                    title={`${drive.display}${total > 0 ? `\n${formatFileSize(free)} free of ${formatFileSize(total)}` : ""}\nDouble-click to open`}
                  >
                    <div className="flex items-center gap-2.5 w-full">
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: "4px",
                          overflow: "hidden",
                          padding: "1px",
                          flexShrink: 0,
                        }}
                      >
                        {drive.iconUrl ? (
                          <img
                            src={drive.iconUrl}
                            alt=""
                            width={28}
                            height={28}
                            style={{ display: "block", imageRendering: "pixelated" }}
                            draggable={false}
                          />
                        ) : (
                          <HardDrive className="w-7 h-7 text-sky-400/90" />
                        )}
                      </span>
                      <span className="font-medium text-[13px] text-stone-100 truncate flex-1">
                        {drive.display}
                      </span>
                    </div>
                    {total > 0 && (
                      <div className="w-full">
                        <div
                          className="w-full rounded-full h-1.5 overflow-hidden"
                          style={{ backgroundColor: "rgba(255,255,255,0.08)" }}
                        >
                          <div
                            className="h-full rounded-full transition-all duration-300"
                            style={{
                              width: `${usedPercent}%`,
                              backgroundColor: accentColor,
                            }}
                          />
                        </div>
                        <div className="flex justify-between items-center text-[10px] mt-1 font-mono text-stone-400">
                          <span>{formatFileSize(free)} {t("trống", "free")}</span>
                          <span>{t("trên", "of")} {formatFileSize(total)}</span>
                        </div>
                      </div>
                    )}
                  </button>
                );
              })}
              {drives.length === 0 && (
                <p className="text-[11px] text-stone-500 italic px-3 py-2 col-span-full">
                  {t("Không tìm thấy ổ đĩa nào.", "No drives detected.")}
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div
      id="explorer-main-viewport"
      ref={containerRefCallback}
      tabIndex={0}
      onKeyDown={(e) => handleViewportKeyDown(e.nativeEvent)}
      onPointerDown={handleViewportPointerDown}
      onPointerMove={handleViewportPointerMove}
      onPointerUp={handleViewportPointerUp}
      onPointerCancel={handleViewportPointerCancel}
      onClick={handleViewportClick}
      onContextMenu={(e) => handleContextMenu(e, null)}
      onDragOver={handleViewportDragOver}
      onDragLeave={handleViewportDragLeave}
      onDrop={handleViewportDrop}
      className={`flex-1 overflow-y-auto p-5 relative select-none focus:outline-none`}
    >
      {(isExternalFileDragActive || dragDropMode !== "none") && (
        <div className="pointer-events-none absolute inset-3 z-50 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed shadow-2xl backdrop-blur-sm transition-all duration-200"
          style={{
            backgroundColor:
              dragDropMode === "move" ? "rgba(16, 185, 129, 0.12)" :
              dragDropMode === "copy" ? "rgba(14, 165, 233, 0.12)" :
              dragDropMode === "external-copy" ? "rgba(139, 92, 246, 0.12)" :
              "rgba(16, 185, 129, 0.12)",
            borderColor:
              dragDropMode === "move" ? "rgba(16, 185, 129, 0.8)" :
              dragDropMode === "copy" ? "rgba(14, 165, 233, 0.8)" :
              dragDropMode === "external-copy" ? "rgba(139, 92, 246, 0.8)" :
              "rgba(16, 185, 129, 0.8)",
          }}
        >
          <div className="flex flex-col items-center gap-1.5">
            {dragDropMode === "move" && (
              <>
                <span className="text-2xl font-bold tracking-wide text-emerald-400 drop-shadow-lg" style={{ textShadow: "0 2px 8px rgba(16,185,129,0.5)" }}>Ctrl + Drop to Move</span>
                <span className="text-xs font-medium text-emerald-300/80">Di chuyển file đến thư mục hiện tại</span>
              </>
            )}
            {dragDropMode === "copy" && (
              <>
                <span className="text-2xl font-bold tracking-wide text-sky-400 drop-shadow-lg" style={{ textShadow: "0 2px 8px rgba(14,165,233,0.5)" }}>Drop to Copy</span>
                <span className="text-xs font-medium text-sky-300/80">Sao chép file vào thư mục hiện tại</span>
              </>
            )}
            {dragDropMode === "external-copy" && (
              <>
                <span className="text-2xl font-bold tracking-wide text-violet-400 drop-shadow-lg" style={{ textShadow: "0 2px 8px rgba(139,92,246,0.5)" }}>Drop to Import</span>
                <span className="text-xs font-medium text-violet-300/80">Nhập file từ ứng dụng khác vào thư mục hiện tại</span>
              </>
            )}
          </div>
        </div>
      )}
      <div
        ref={selectionOverlayRef}
        className="pointer-events-none absolute z-40 rounded border-2"
        style={{ display: "none" }}
      />
      {dragGhost.visible && (
        <div
          data-goku-drag-ghost="true"
          className="pointer-events-none fixed fluent-menu-light z-[100] min-w-[120px] max-w-[240px] -translate-x-1/2 -translate-y-[120%] rounded-xl px-3 py-2 text-xs text-white shadow-2xl"
          style={{ left: dragGhost.x, top: dragGhost.y }}
        >
          <div className="flex items-center gap-2">
            <span className={`inline-flex h-2.5 w-2.5 rounded-full ${dragGhost.mode === "copy" ? "bg-sky-400" : "bg-emerald-400"}`} />
            <span className="truncate font-medium">{dragGhost.label}</span>
            {dragGhost.count > 1 && (
              <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-mono text-stone-200">
                {dragGhost.count}
              </span>
            )}
          </div>
          <div className="mt-1 text-[10px] font-mono uppercase tracking-wide text-stone-400">
            {dragGhost.mode === "copy" ? "Copy" : "Move"}
          </div>
        </div>
      )}

      {/* Page Title or Virtual path metadata indicator */}
      <div className={`flex items-center justify-between mb-4 pb-2 border-b ${borderLightColor}`}>
        <h2 className={`text-sm font-semibold flex items-center gap-2 ${textTitleColor}`}>
          <span>{activeTabTitle}</span>
          <span className={`text-[10px] font-normal font-mono ${textMutedColor}`}>
            ({searchFilter.query.trim() ? visibleSearchItems.length : sortedChildren.length} items)
          </span>
        </h2>
        {searchFilter.query && (
          <p 
            className="text-[10px] font-mono px-2 py-0.5 rounded border"
            style={{ 
              color: accentColor, 
              backgroundColor: `${accentColor}12`, 
              borderColor: `${accentColor}25` 
            }}
          >
            {`Search results: "${searchFilter.query}"`}
          </p>
        )}
      </div>

      {searchFilter.query.trim() && isSearching && visibleSearchItems.length === 0 && (
        <div className={`mb-4 rounded-xl border px-4 py-3 text-xs bg-overlay border-white/8 text-stone-400`}>
          {t("Đang tìm kiếm...", "Searching...")}
        </div>
      )}

      {searchFilter.query.trim() && groupedSearchResults.length > 0 && (
        <div className={`mb-4 rounded-xl border overflow-hidden bg-overlay border-white/8`}>
          <div className={`flex items-center justify-between px-4 py-2 text-[11px] border-b border-white/8 text-stone-400`}>
            <span>{showAllSearchResults ? t("Hiển thị tất cả kết quả", "Showing all results") : t("Đang hiển thị kết quả gần nhất", "Showing nearby results")}</span>
            {!showAllSearchResults && sortedChildren.length > groupedSearchResults.reduce((count, group) => count + group.items.length, 0) && (
              <button
                type="button"
                onClick={() => setShowAllSearchResults(true)}
                className="font-medium cursor-pointer hover:underline"
                style={{ color: accentColor }}
              >
                {t("Hiện tất cả", "Show all")}
              </button>
            )}
          </div>
          <div className="divide-y divide-inherit">
            {groupedSearchResults.map((group) => {
              const collapsed = collapsedSearchGroups[group.key] ?? group.collapsedByDefault;
              return (
                <div key={group.key}>
                  <button
                    type="button"
                    onClick={() => setCollapsedSearchGroups((prev) => ({ ...prev, [group.key]: !collapsed }))}
                    className={`w-full flex items-center justify-between px-4 py-2 text-left text-xs cursor-pointer hover:bg-white/5 text-stone-300`}
                  >
                    <span>{group.label}</span>
                    <span className="text-[10px] font-mono">{collapsed ? `+ ${group.items.length}` : group.items.length}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {visibleSearchItems.length === 0 && !isSearching && (
        <div className="flex flex-col items-center justify-center h-64 text-stone-500 text-xs">
          <Folder className="w-16 h-16 opacity-10 mb-3" />
          <p>Thư mục này trống hoặc không khớp bộ lọc.</p>
          <div className="flex gap-2 mt-4">
            <button
              onClick={handleQuickAddFolder}
              className="px-3 py-1 bg-white/5 border border-white/10 hover:bg-white/10 text-stone-300 rounded text-[11px] cursor-pointer"
            >
              + Tạo thư mục mới
            </button>
            <button
              onClick={handleQuickAddFile}
              className="px-3 py-1 bg-white/5 border border-white/10 hover:bg-white/10 text-stone-300 rounded text-[11px] cursor-pointer"
            >
              + Tạo file mới
            </button>
          </div>
        </div>
      )}

      {/* 1. RENDER ICON GRID MODES (1..4): interpolate icon size + grid minmax */}
      {resultsGroup === "icon" && visibleSearchItems.length > 0 && (
        <div
          className={`grid ${gridGapClass} z-10 relative`}
          style={{ gridTemplateColumns: `repeat(auto-fill,minmax(${gridMinCellPx}px,1fr))` }}
        >
          {visibleSearchItems.map((item) => {
            const isSelected = selectedIdsSet.has(item.id.replace(/\\/g, "/"));
            const isBeingDragOver = dragOverFolderId === item.id;
            const cut = isCutItem(item.id);

            // Inline icon size from slider value (1..4) — Tailwind classes for common stops, inline style for interpolation
            const iconStyle = { width: `${iconWidthPx}px`, height: `${iconHeightPx}px` };
            const iconSizeClass =
              iconModeValue === 1 ? "w-40 h-40" :
              iconModeValue === 2 ? "w-28 h-28" :
              iconModeValue === 3 ? "w-20 h-20" :
              "w-9 h-9";

            // Label size: only "Extra Large" (value=1) gets the bigger font
            const labelClass = iconModeValue === 1 ? "text-[12px]" : "text-[11px]";

            return (
              <div
                key={item.id}
                data-item-id={item.id}
                data-item-type={item.type}
                draggable={false}
                onPointerDown={(e) => handleItemPointerDown(e, item)}
                onPointerMove={(e) => handleItemPointerMove(e, item)}
                onPointerUp={() => handleItemPointerUp(item.id)}
                onPointerCancel={() => handleItemPointerUp(item.id)}
                onMouseDown={(e) => handleItemMouseDown(e, item)}
                onClick={(e) => handleItemClick(e, item)}
                onDoubleClick={() => handleItemDoubleClick(item)}
                onContextMenu={(e) => handleContextMenu(e, item)}
                data-item-path={item.path}
                className={`file-item-selectable relative flex flex-col items-center ${gridItemPadding} rounded-xl border transition-all duration-200 cursor-pointer overflow-hidden min-w-0 ${fileItemClass(isSelected, cut, item.isHidden)} ${isBeingDragOver ? "ring-2 ring-emerald-500 scale-[1.04]" : ""}`}
              >
                {/* Icon with priority dot */}
                <div className="mb-2 shrink-0 relative pointer-events-none">
                  {item.type === "directory"
                    ? <Folder className={`${iconSizeClass} text-amber-400`} fill="currentColor" style={{ ...iconStyle, opacity: item.isHidden ? 0.5 : 1 }} />
                    : normalizeThumbnailSrc(thumbs[item.path])
                        ? <img
                            src={normalizeThumbnailSrc(thumbs[item.path])}
                            alt={item.name}
                            className={`${iconSizeClass} object-contain animate-fade-in`}
                            style={{ ...iconStyle, opacity: item.isHidden ? 0.5 : 1 }}
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = "none";
                            }}
                          />
                        : <span style={{ ...iconStyle, opacity: item.isHidden ? 0.5 : 1 }} className={`${iconSizeClass} flex items-center justify-center`}>{getFileIcon(item, "")}</span>
                  }
                  {/* Priority indicator dot at top-right of thumbnail */}
                  {item.tag && (
                    <span
                      className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full ring-2 ring-black/80 shadow-md"
                      style={{
                        backgroundColor:
                          item.tag === "Warning" ? "#ef4444" :
                          item.tag === "WIP" ? "#3b82f6" :
                          item.tag === "Deliverable" ? "#10b981" :
                          item.tag === "Archived" ? "#f59e0b" :
                          "#a855f7"
                      }}
                      title={`Độ ưu tiên: ${item.tag}`}
                    />
                  )}
                </div>

                {/* Editable file labeling */}
                <div className="w-full text-center px-1 pointer-events-none">
                  {renamingId === item.id ? (
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={renameInput}
                      onChange={(e) => setRenameInput(e.target.value)}
                      onBlur={() => {
                        pendingBlurRef.current = true;
                        const capturedId = renamingIdRef.current;
                        setTimeout(() => {
                          if (pendingBlurRef.current) {
                            pendingBlurRef.current = false;
                            if (capturedId !== null) {
                              handleRenameSubmit(capturedId);
                            }
                          }
                        }, 0);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRenameSubmit(item.id);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      className="w-full bg-overlaytext-white text-[11px] rounded px-1.5 py-0.5 border border-white/20 text-center font-mono focus:outline-none"
                    />
                  ) : (
                    <p className={`leading-tight font-medium truncate w-full ${labelClass}${item.isHidden ? " opacity-50" : ""}`}>
                      {highlightSearchText(formatDisplayName(item))}
                    </p>
                  )}
                  {item.type === "file" && (
                    <p className="text-[9px] text-stone-500 font-mono mt-0.5">
                      {formatSize(item.size)}
                    </p>
                  )}
                  {item.type === "directory" && showFolderSizes && (
                    <p className="text-[9px] text-stone-500 font-mono mt-0.5">
                      {folderSizes[item.id] == null
                        ? "..."
                        : formatSize(folderSizes[item.id]!)}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 2. RENDER VIEW LIST MODE (slider value 6) */}
      {activeResultsViewMode === 6 && visibleSearchItems.length > 0 && (
        <div className={`flex flex-col ${listGapClass} max-w-xl z-10 relative`}>
          {visibleSearchItems.map((item) => {
            const isSelected = selectedIdsSet.has(item.id.replace(/\\/g, "/"));
            const isDir = item.type === "directory";
            const cut = isCutItem(item.id);
            return (
              <div
                key={item.id}
                data-item-id={item.id}
                data-item-type={item.type}
                draggable={false}
                onPointerDown={(e) => handleItemPointerDown(e, item)}
                onPointerMove={(e) => handleItemPointerMove(e, item)}
                onPointerUp={() => handleItemPointerUp(item.id)}
                onPointerCancel={() => handleItemPointerUp(item.id)}
                onMouseDown={(e) => handleItemMouseDown(e, item)}
                onClick={(e) => handleItemClick(e, item)}
                onDoubleClick={() => handleItemDoubleClick(item)}
                onContextMenu={(e) => handleContextMenu(e, item)}
                data-item-path={item.path}
                className={`file-item-selectable flex items-center gap-3 rounded-md transition ${listItemPadding} ${rowHighlightClass(isSelected, cut, item.isHidden)}`}
              >
                <div className="relative shrink-0 pointer-events-none">
                  {item.type === "directory"
                    ? <Folder className="w-5 h-5 text-amber-400 shrink-0" fill="currentColor" style={{ opacity: item.isHidden ? 0.5 : 1 }} />
                    : normalizeThumbnailSrc(thumbs[item.path])
                      ? <img
                          src={normalizeThumbnailSrc(thumbs[item.path])}
                          alt={item.name}
                          className="w-5 h-5 object-contain animate-fade-in"
                          style={{ opacity: item.isHidden ? 0.5 : 1 }}
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      : thumbs[item.path] === null
                        ? <span style={{ opacity: item.isHidden ? 0.5 : 1 }}>{getFileIcon(item, "w-5 h-5")}</span>
                        : <span style={{ opacity: item.isHidden ? 0.5 : 1 }}>{getFileIcon(item, "w-5 h-5")}</span>
                  }
                  {/* Priority indicator dot */}
                  {item.tag && (
                    <span
                      className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ring-1 ring-black/60 shadow-sm"
                      style={{
                        backgroundColor:
                          item.tag === "Warning" ? "#ef4444" :
                          item.tag === "WIP" ? "#3b82f6" :
                          item.tag === "Deliverable" ? "#10b981" :
                          item.tag === "Archived" ? "#f59e0b" :
                          "#a855f7"
                      }}
                      title={`Độ ưu tiên: ${item.tag}`}
                    />
                  )}
                </div>
                {renamingId === item.id ? (
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameInput}
                    onChange={(e) => setRenameInput(e.target.value)}
                    onBlur={() => {
                        pendingBlurRef.current = true;
                        const capturedId = renamingIdRef.current;
                        setTimeout(() => {
                          if (pendingBlurRef.current) {
                            pendingBlurRef.current = false;
                            if (capturedId !== null) {
                              handleRenameSubmit(capturedId);
                            }
                          }
                        }, 0);
                      }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRenameSubmit(item.id);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    className="bg-overlaytext-white text-[11px] rounded px-1.5 py-0.5 w-full border border-white/20 focus:outline-none"
                  />
                ) : (
                  <span className="truncate text-[11px]">{highlightSearchText(formatDisplayName(item))}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 4. RENDER VIEW COLUMNS MODE (list-style rows in vertical columns, max 60 items/column) */}
      {activeResultsViewMode === 5 && visibleSearchItems.length > 0 && (
        <div className={`grid grid-cols-[repeat(auto-fill,minmax(288px,1fr))] ${listGapClass} z-10 relative`}>
          {(() => {
            const MAX_PER_COLUMN = 60;
            const chunks: FSItem[][] = [];
            for (let i = 0; i < visibleSearchItems.length; i += MAX_PER_COLUMN) {
              chunks.push(visibleSearchItems.slice(i, i + MAX_PER_COLUMN));
            }
            return chunks.map((chunk, chunkIdx) => (
              <div
                key={`chunk-${chunkIdx}`}
                className={`flex flex-col ${listGapClass} min-w-0`}
              >
                {chunk.map((item) => {
                  const isSelected = selectedIdsSet.has(item.id.replace(/\\/g, "/"));
                  const isDir = item.type === "directory";
                  const cut = isCutItem(item.id);
                  return (
                    <div
                      key={item.id}
                      data-item-id={item.id}
                      data-item-type={item.type}
                      draggable={false}
                      onPointerDown={(e) => handleItemPointerDown(e, item)}
                      onPointerMove={(e) => handleItemPointerMove(e, item)}
                      onPointerUp={() => handleItemPointerUp(item.id)}
                      onPointerCancel={() => handleItemPointerUp(item.id)}
                      onMouseDown={(e) => handleItemMouseDown(e, item)}
                      onClick={(e) => handleItemClick(e, item)}
                      onDoubleClick={() => handleItemDoubleClick(item)}
                      onContextMenu={(e) => handleContextMenu(e, item)}
                      data-item-path={item.path}
                      className={`file-item-selectable flex items-center gap-3 rounded-md transition truncate ${listItemPadding} ${rowHighlightClass(isSelected, cut, item.isHidden)}`}
                    >
                      <div className="relative shrink-0 pointer-events-none">
                        {item.type === "directory"
                    ? <Folder className="w-5 h-5 text-amber-400 shrink-0" fill="currentColor" style={{ opacity: item.isHidden ? 0.5 : 1 }} />
                    : normalizeThumbnailSrc(thumbs[item.path])
                      ? <img
                          src={normalizeThumbnailSrc(thumbs[item.path])}
                          alt={item.name}
                          className="w-5 h-5 object-contain animate-fade-in"
                          style={{ opacity: item.isHidden ? 0.5 : 1 }}
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      : thumbs[item.path] === null
                        ? <span style={{ opacity: item.isHidden ? 0.5 : 1 }}>{getFileIcon(item, "w-5 h-5")}</span>
                        : <span style={{ opacity: item.isHidden ? 0.5 : 1 }}>{getFileIcon(item, "w-5 h-5")}</span>
                        }
                        {/* Priority indicator dot */}
                        {item.tag && (
                          <span
                            className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ring-1 ring-black/60 shadow-sm"
                            style={{
                              backgroundColor:
                                item.tag === "Warning" ? "#ef4444" :
                                item.tag === "WIP" ? "#3b82f6" :
                                item.tag === "Deliverable" ? "#10b981" :
                                item.tag === "Archived" ? "#f59e0b" :
                                "#a855f7"
                            }}
                            title={`Độ ưu tiên: ${item.tag}`}
                          />
                        )}
                      </div>
                      {renamingId === item.id ? (
                        <input
                          ref={renameInputRef}
                          type="text"
                          value={renameInput}
                          onChange={(e) => setRenameInput(e.target.value)}
                          onBlur={() => {
                              pendingBlurRef.current = true;
                              const capturedId = renamingIdRef.current;
                              setTimeout(() => {
                                if (pendingBlurRef.current) {
                                  pendingBlurRef.current = false;
                                  if (capturedId !== null) {
                                    handleRenameSubmit(capturedId);
                                  }
                                }
                              }, 0);
                            }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleRenameSubmit(item.id);
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          className="bg-overlaytext-white text-[11px] rounded px-1.5 py-0.5 w-full border border-white/20 focus:outline-none"
                        />
                      ) : (
                        <span className="truncate text-[11px]">{highlightSearchText(formatDisplayName(item))}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ));
          })()}
        </div>
      )}

      {/* RENDER VIEW DETAILS/LIST MODE */}
      {activeResultsViewMode === 7 && visibleSearchItems.length > 0 && (
        <div className={`w-full text-xs text-left ${detailsContainerClass}`}>
          {/* Header with resizable columns and filter dropdowns */}
          <div className={`flex items-center p-3 font-semibold select-none border-b border-white/10 relative z-20 ${detailsHeaderClass}`}>
            {/* Name column */}
            <div
              className="relative shrink-0 cursor-pointer hover:opacity-80 group"
              style={{ width: columnWidths.name }}
              onClick={() => handleSortToggle("name")}
            >
              <div className="flex items-center gap-1">
                <span>{explorer.language === "vi" ? "Tên" : "Name"}</span>
                {effectiveSortBy === "name" && (effectiveSortDirection === "asc" ? "▲" : "▼")}
              </div>
              {/* Resize handle */}
              <div
                className="absolute right-0 top-0 bottom-0 w-3 cursor-col-resize group-hover:bg-white/10 z-10"
                onMouseDown={(e) => { e.stopPropagation(); handleColumnResizeStart(e, "name"); }}
                onClick={(e) => e.stopPropagation()}
              />
            </div>

            {/* Date column with filter */}
            <div className="relative shrink-0 group overflow-visible" style={{ width: columnWidths.date }}>
              <div
                className="flex items-center gap-1 cursor-pointer hover:opacity-80 h-full overflow-visible"
                onClick={() => handleSortToggle("date")}
              >
                <span>{explorer.language === "vi" ? "Ngày sửa đổi" : "Date Modified"}</span>
                {effectiveSortBy === "date" && (effectiveSortDirection === "asc" ? "▲" : "▼")}
                {dateFilter.active && <span className="text-emerald-400 text-[8px]">✓</span>}
                {/* Filter dropdown button */}
                <div className="relative" ref={dateFilterDropdownRef}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setDateFilterDropdownOpen(!dateFilterDropdownOpen); }}
                    className="p-0.5 hover:bg-white/10 rounded cursor-pointer"
                  >
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {dateFilterDropdownOpen && (
                    <div className="absolute top-full left-0 mt-1 fluent-menu rounded-lg z-50 p-2 min-w-[160px] text-xs">
                      <div className="text-stone-400 mb-2">{explorer.language === "vi" ? "Lọc theo ngày" : "Filter by date"}</div>
                      {[
                        { key: 'today', label: explorer.language === "vi" ? "Hôm nay" : "Today" },
                        { key: 'yesterday', label: explorer.language === "vi" ? "Hôm qua" : "Yesterday" },
                        { key: 'lastWeek', label: explorer.language === "vi" ? "Tuần trước" : "Last Week" },
                        { key: 'earlierThisMonth', label: explorer.language === "vi" ? "Đầu tháng này" : "Earlier This Month" },
                        { key: 'earlierThisYear', label: explorer.language === "vi" ? "Đầu năm nay" : "Earlier This Year" },
                        { key: 'longTimeAgo', label: explorer.language === "vi" ? "Rất lâu rồi" : "A Long Time Ago" },
                      ].map(({ key, label }) => (
                        <button
                          key={key}
                          onClick={() => {
                            setDateFilter({
                              active: true,
                              mode: 'preset',
                              preset: key as DateFilterPreset
                            });
                            setDateFilterDropdownOpen(false);
                          }}
                          className={`w-full text-left px-2 rounded hover:bg-white/10 ${dateFilter.active && dateFilter.preset === key ? 'text-emerald-400' : ''}`}
                        >
                          {label}
                        </button>
                      ))}
                      <div className="border-t border-white/10 my-2" />
                      <button
                        onClick={() => {
                          setDateFilter({ active: false, mode: 'preset' });
                          setDateFilterDropdownOpen(false);
                        }}
                        className="w-full text-left px-2 rounded hover:bg-white/10 text-stone-400"
                      >
                        {explorer.language === "vi" ? "Xóa lọc" : "Clear filter"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {/* Resize handle */}
              <div
                className="absolute right-0 top-0 bottom-0 w-3 cursor-col-resize group-hover:bg-white/10 z-10"
                onMouseDown={(e) => { e.stopPropagation(); handleColumnResizeStart(e, "date"); }}
                onClick={(e) => e.stopPropagation()}
              />
            </div>

            {/* Type column with filter */}
            <div className="relative shrink-0 group overflow-visible" style={{ width: columnWidths.type }}>
              <div
                className="flex items-center gap-1 cursor-pointer hover:opacity-80 h-full overflow-visible"
                onClick={() => handleSortToggle("type")}
              >
                <span>{explorer.language === "vi" ? "Loại" : "Type"}</span>
                {effectiveSortBy === "type" && (effectiveSortDirection === "asc" ? "▲" : "▼")}
                {typeFilter.active && <span className="text-emerald-400 text-[8px]">✓</span>}
                {/* Filter dropdown button */}
                <div className="relative" ref={typeFilterDropdownRef}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setTypeFilterDropdownOpen(!typeFilterDropdownOpen); }}
                    className="p-0.5 hover:bg-white/10 rounded cursor-pointer"
                  >
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {typeFilterDropdownOpen && (
                    <div className="absolute top-full left-0 mt-1 fluent-menu rounded-lg z-50 p-2 min-w-[160px] max-h-[300px] overflow-y-auto text-xs">
                      <div className="text-stone-400 mb-2">{explorer.language === "vi" ? "Lọc theo loại" : "Filter by type"}</div>
                      <button
                        onClick={() => {
                          if (typeFilter.selectedTypes.size === uniqueTypes.length) {
                            setTypeFilter({ active: false, selectedTypes: new Set() });
                          } else {
                            setTypeFilter({ active: true, selectedTypes: new Set(uniqueTypes) });
                          }
                        }}
                        className="w-full text-left px-2 rounded hover:bg-white/10 text-stone-400 mb-1"
                      >
                        {explorer.language === "vi" ? "Chọn tất cả / Bỏ chọn" : "Select All / None"}
                      </button>
                      {uniqueTypes.map(type => (
                        <label
                          key={type}
                          className="flex items-center gap-2 px-2 rounded hover:bg-white/10 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={typeFilter.selectedTypes.has(type)}
                            onChange={(e) => {
                              const newSelected = new Set(typeFilter.selectedTypes);
                              if (e.target.checked) {
                                newSelected.add(type);
                              } else {
                                newSelected.delete(type);
                              }
                              setTypeFilter({
                                active: newSelected.size > 0 && newSelected.size < uniqueTypes.length ? true : newSelected.size === uniqueTypes.length ? false : newSelected.size > 0,
                                selectedTypes: newSelected
                              });
                            }}
                            className="w-3 h-3 accent-emerald-400"
                          />
                          <span className="text-stone-300 truncate">{type}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {/* Resize handle */}
              <div
                className="absolute right-0 top-0 bottom-0 w-3 cursor-col-resize group-hover:bg-white/10 z-10"
                onMouseDown={(e) => { e.stopPropagation(); handleColumnResizeStart(e, "type"); }}
                onClick={(e) => e.stopPropagation()}
              />
            </div>

            {/* Size column */}
            <div
              className="relative shrink-0 cursor-pointer hover:opacity-80 group flex items-center justify-end"
              style={{ width: columnWidths.size }}
              onClick={() => handleSortToggle("size")}
            >
              <span>{explorer.language === "vi" ? "Kích cỡ" : "Size"}</span>
              {effectiveSortBy === "size" && (effectiveSortDirection === "asc" ? "▲" : "▼")}
            </div>
          </div>

          {/* Show filter info if active */}
          {(dateFilter.active || typeFilter.active) && (
            <div className="px-3 py-1.5 bg-theme-content-3/50 text-[10px] text-stone-400 flex items-center gap-2">
              <span>{detailFilteredItems.length} / {visibleSearchItems.length} {explorer.language === "vi" ? "mục" : "items"}</span>
              {dateFilter.active && (
                <span className="px-1.5 py-0.5 bg-white/10 rounded">
                  {explorer.language === "vi" ? "Ngày:" : "Date:"} {getDateFilterLabel(dateFilter)}
                  <button onClick={() => setDateFilter({ active: false, mode: 'preset' })} className="ml-1 hover:text-white">✕</button>
                </span>
              )}
              {typeFilter.active && (
                <span className="px-1.5 py-0.5 bg-white/10 rounded">
                  {explorer.language === "vi" ? "Loại:" : "Type:"} {typeFilter.selectedTypes.size} {explorer.language === "vi" ? "loại" : "types"}
                  <button onClick={() => setTypeFilter({ active: false, selectedTypes: new Set() })} className="ml-1 hover:text-white">✕</button>
                </span>
              )}
              <button
                onClick={() => {
                  setDateFilter({ active: false, mode: 'preset' });
                  setTypeFilter({ active: false, selectedTypes: new Set() });
                }}
                className="ml-auto hover:text-white"
              >
                {explorer.language === "vi" ? "Xóa tất cả" : "Clear all"}
              </button>
            </div>
          )}

          <div className={`font-mono relative z-10`}>
            {detailFilteredItems.map((item) => {
              const isSelected = selectedIdsSet.has(item.id.replace(/\\/g, "/"));
              const cut = isCutItem(item.id);
              return (
                <div
                  key={item.id}
                  data-item-id={item.id}
                  data-item-type={item.type}
                  data-item-path={item.path}
                  draggable={false}
                  onPointerDown={(e) => handleItemPointerDown(e, item)}
                  onPointerMove={(e) => handleItemPointerMove(e, item)}
                  onPointerUp={() => handleItemPointerUp(item.id)}
                  onPointerCancel={() => handleItemPointerUp(item.id)}
                  onMouseDown={(e) => handleItemMouseDown(e, item)}
                  onClick={(e) => handleItemClick(e, item)}
                  onDoubleClick={() => handleItemDoubleClick(item)}
                  onContextMenu={(e) => handleContextMenu(e, item)}
                  className={`flex items-center cursor-pointer transition ${detailsRowPadding} ${rowHighlightClass(isSelected, cut, item.isHidden)} ${dragOverFolderId === item.id ? "ring-2 ring-emerald-500" : ""}`}
                  >
                  {/* Name column */}
                  <div className="flex items-center gap-2.5 truncate shrink-0" style={{ width: columnWidths.name }}>
                    <div className="relative shrink-0 pointer-events-none mt-0.5 mr-0.5">
                      {item.type === "directory"
                    ? <Folder className="w-5 h-5 text-amber-400 shrink-0" fill="currentColor" style={{ opacity: item.isHidden ? 0.5 : 1 }} />
                    : normalizeThumbnailSrc(thumbs[item.path])
                      ? <img
                          src={normalizeThumbnailSrc(thumbs[item.path])}
                          alt={item.name}
                          className="w-5 h-5 object-contain animate-fade-in"
                          style={{ opacity: item.isHidden ? 0.5 : 1 }}
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      : thumbs[item.path] === null
                        ? <span style={{ opacity: item.isHidden ? 0.5 : 1 }}>{getFileIcon(item, "w-5 h-5")}</span>
                        : <span style={{ opacity: item.isHidden ? 0.5 : 1 }}>{getFileIcon(item, "w-5 h-5")}</span>
                      }
                      {/* Priority indicator dot */}
                      {item.tag && (
                        <span
                          className="absolute top-0 right-0 w-2 h-2 rounded-full ring-1 ring-black/60 shadow-sm"
                          style={{
                            backgroundColor:
                              item.tag === "Warning" ? "#ef4444" :
                              item.tag === "WIP" ? "#3b82f6" :
                              item.tag === "Deliverable" ? "#10b981" :
                              item.tag === "Archived" ? "#f59e0b" :
                              "#a855f7"
                          }}
                          title={`Độ ưu tiên: ${item.tag}`}
                        />
                      )}
                    </div>
                    {renamingId === item.id ? (
                      <input
                        ref={renameInputRef}
                        type="text"
                        value={renameInput}
                        onChange={(e) => setRenameInput(e.target.value)}
                        onBlur={() => {
                        pendingBlurRef.current = true;
                        const capturedId = renamingIdRef.current;
                        setTimeout(() => {
                          if (pendingBlurRef.current) {
                            pendingBlurRef.current = false;
                            if (capturedId !== null) {
                              handleRenameSubmit(capturedId);
                            }
                          }
                        }, 0);
                      }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRenameSubmit(item.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        className="bg-overlaytext-white text-xs rounded border border-white/25 px-1 py-0.5 focus:outline-none w-full"
                      />
                    ) : (
                      <span className="truncate font-medium">{highlightSearchText(formatDisplayName(item))}</span>
                    )}
                  </div>
                  {/* Date column */}
                  <div className="shrink-0 truncate" style={{ width: columnWidths.date }}>
                    <span className="text-[10px] text-stone-400">
                      {formatDateTime(item.updatedAt)}
                    </span>
                  </div>
                  {/* Type column */}
                  <div className="shrink-0 truncate capitalize" style={{ width: columnWidths.type }}>
                    <span className="text-[10px] text-stone-400">
                      {item.type === "directory" ? "File folder" : item.name.split(".").pop()?.toUpperCase() || "File"}
                    </span>
                  </div>
                  {/* Size column */}
                  <div className="shrink-0 text-right" style={{ width: columnWidths.size }}>
                    <span className="text-[10px] text-stone-400">
                      {item.type === "file"
                        ? formatSize(item.size)
                        : showFolderSizes
                          ? folderSizes[item.id] == null
                            ? "..."
                            : formatSize(folderSizes[item.id]!)
                          : ""
                      }
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* FLOATING DARK CONTEXT MENU */}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          className="fixed fluent-menu rounded-xl py-1.5 w-[18rem] sm:w-[19rem] max-h-[50vh] overflow-y-auto goku-thin-scroll z-[600] text-xs animate-in fade-in zoom-in-95 duration-100 explorer-context-menu"
          style={{
            top: contextMenuAdjustedPos?.y ?? contextMenu.y,
            left: contextMenuAdjustedPos?.x ?? contextMenu.x,
            color: "var(--text-primary)"
          }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseEnter={() => setIsContextMenuHovered(true)}
          onMouseLeave={() => setIsContextMenuHovered(false)}
        >
          {/* Phase 2.2: Open with… is now part of the file menu proper (a
              hover submenu under the items section). We removed the old
              top-level "Open with..." header because it duplicated the
              submenu and broke the Visual Studio → File Pilot ordering. */}

          {/* Section 1: Item actions — REMOVED in Phase 2.
              Hand-rolled "Open / Pin / Rename / ZIP / New tab / Open location"
              were dropped because the plugin-backed `ShowMoreOptionsSection`
              exposes every verb Windows Explorer itself shows (open, rename,
              copy path, etc.) in the correct order. The plugin also handles
              Open-with via a nested submenu. Adding them here would just
              duplicate the same actions. */}

          {/* Section 1: Quick actions (Paste, Cut, Copy, Delete, Rename) */}
          {contextTargetItem && (
            <div className="py-1">
              <div className="flex items-center gap-1 px-3 py-1">
                {/* Paste */}
                <button
                  onClick={() => {
                    document.dispatchEvent(new CustomEvent("goku-paste"));
                    setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                  }}
                  className="flex-1 flex items-center justify-center py-1.5 rounded hover:bg-white/10 text-amber-400 transition cursor-pointer"
                  title={t("Dán", "Paste")}
                >
                  <Clipboard className="w-3.5 h-3.5 text-amber-400" />
                </button>
                {/* Cut */}
                <button
                  onClick={() => {
                    document.dispatchEvent(new CustomEvent("goku-cut"));
                    setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                  }}
                  className="flex-1 flex items-center justify-center py-1.5 rounded hover:bg-white/10 transition cursor-pointer"
                  title={t("Cắt", "Cut")}
                >
                  <Scissors className="w-3.5 h-3.5 text-sky-400" />
                </button>
                {/* Copy */}
                <button
                  onClick={() => {
                    document.dispatchEvent(new CustomEvent("goku-copy"));
                    setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                  }}
                  className="flex-1 flex items-center justify-center py-1.5 rounded hover:bg-white/10 transition cursor-pointer"
                  title={t("Sao chép", "Copy")}
                >
                  <Copy className="w-3.5 h-3.5 text-emerald-400" />
                </button>
                {/* Delete */}
                <button
                  onClick={() => {
                    document.dispatchEvent(new CustomEvent("goku-delete"));
                    setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                  }}
                  className="flex-1 flex items-center justify-center py-1.5 rounded hover:bg-white/10 text-rose-400 transition cursor-pointer"
                  title={t("Xóa", "Delete")}
                >
                  <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                </button>
                {/* Rename */}
                <button
                  onClick={() => {
                    startRenameForItem(contextTargetItem);
                    setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                  }}
                  className="flex-1 flex items-center justify-center py-1.5 rounded hover:bg-white/10 transition cursor-pointer"
                  title={t("Đổi tên", "Rename")}
                >
                  <Edit3 className="w-3.5 h-3.5 text-sky-300" />
                </button>
              </div>
            </div>
          )}

          {/* Section 2: Priority tag assignment (only for items) */}
          {contextTargetItem && (
            <div className="px-3 pt-2 pb-1">
              <div className="flex items-center justify-between gap-2">
                {(["Warning", "WIP", "Deliverable", "Archived", "Draft", "remove"] as const).map((tagVal) => (
                  <button
                    key={tagVal}
                    onClick={() => {
                      if (tagVal === "remove") {
                        const stored = localStorage.getItem("NEXUS_ITEM_TAGS");
                        const tags: Record<string, string> = stored ? JSON.parse(stored) : {};
                        delete tags[contextTargetItem.id];
                        localStorage.setItem("NEXUS_ITEM_TAGS", JSON.stringify(tags));
                        explorer.setStatusMessage(t("Đã xóa nhãn phân loại.", "Removed classification tag."));
                      } else {
                        const stored = localStorage.getItem("NEXUS_ITEM_TAGS");
                        const tags: Record<string, string> = stored ? JSON.parse(stored) : {};
                        tags[contextTargetItem.id] = tagVal;
                        localStorage.setItem("NEXUS_ITEM_TAGS", JSON.stringify(tags));
                        explorer.setStatusMessage(t(`Tag "${tagVal}" applied.`, `Tagged as "${tagVal}" successfully.`));
                      }
                      setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                      contextMenuActiveRef.current = true;
                      setTimeout(() => { contextMenuActiveRef.current = false; }, 800);
                    }}
                    className={`w-5.5 h-5.5 rounded-full flex items-center justify-center border transition cursor-pointer ${
                      tagVal === "Warning" ? "bg-red-500/10 border-red-500/40 hover:bg-red-500/40" :
                      tagVal === "WIP" ? "bg-blue-500/10 border-blue-500/40 hover:bg-blue-500/40" :
                      tagVal === "Deliverable" ? "bg-emerald-500/10 border-emerald-500/40 hover:bg-emerald-500/40" :
                      tagVal === "Archived" ? "bg-amber-500/10 border-amber-500/40 hover:bg-amber-500/40" :
                      tagVal === "Draft" ? "bg-purple-500/10 border-purple-500/40 hover:bg-purple-500/40" :
                      "bg-stone-500/10 border-stone-500/40 hover:bg-stone-500/40"
                    }`}
                    title={tagVal === "remove" ? t("Gỡ bỏ nhãn ưu tiên", "Remove Priority Tag") : getTagTranslation(tagVal, language)}
                  >
                    {tagVal === "remove" ? (
                      <span className="w-2 h-2 rounded-full bg-stone-400" />
                    ) : (
                      <span className={`w-2 h-2 rounded-full ${
                        tagVal === "Warning" ? "bg-red-500" :
                        tagVal === "WIP" ? "bg-blue-500" :
                        tagVal === "Deliverable" ? "bg-emerald-500" :
                        tagVal === "Archived" ? "bg-amber-500" :
                        "bg-purple-500"
                      }`} />
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Section 3: Clipboard block copy/cut/paste — REMOVED in Phase 2.
              The shell plugin's `copy`, `cut`, `paste`, `copyaspath` verbs
              cover the same actions and route through `IContextMenu`, so the
              result is identical to Windows Explorer's behaviour. */}

          {/* Section 4: View & Sort hover-submenus (synced with row bar) - ExplorerContextMenu */}
          {!contextMenu.targetItem && (
            <div className="py-1">
              {/* View Mode trigger (opens hover submenu) */}
              <button
                onMouseEnter={(e) => {
                  cancelSubmenuClose();
                  setSortSubmenuAnchor(null);
                  setNewSubmenuAnchor(null);
                  setOpenWithSubmenuAnchor(null);
                  const submenuWidth = 290;
                  const submenuHeight = 360;
                  const gap = 4;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const viewportWidth = window.innerWidth;
                  const viewportHeight = window.innerHeight;
                  let x = rect.right + gap;
                  let y = rect.top;
                  if (x + submenuWidth > viewportWidth - 12) {
                    x = Math.max(12, rect.left - submenuWidth - gap);
                  }
                  if (y + submenuHeight > viewportHeight - 12) {
                    y = Math.max(12, viewportHeight - submenuHeight - 12);
                  }
                  setViewSubmenuAnchor({ x, y });
                }}
                onMouseLeave={() => scheduleSubmenuClose()}
                onClick={(e) => e.preventDefault()}
                className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
              >
                <LayoutGrid className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="flex-1">{t("Xem (View Mode)", "View Mode")}</span>
                <span className="text-[10px] text-emerald-400 font-mono capitalize">{effectiveViewMode}</span>
                <ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-secondary)" }} />
              </button>

              {/* Sort trigger (opens hover submenu) */}
              <button
                onMouseEnter={(e) => {
                  cancelSubmenuClose();
                  setViewSubmenuAnchor(null);
                  setNewSubmenuAnchor(null);
                  setOpenWithSubmenuAnchor(null);
                  const submenuWidth = 220;
                  const submenuHeight = 320;
                  const gap = 4;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const viewportWidth = window.innerWidth;
                  const viewportHeight = window.innerHeight;
                  let x = rect.right + gap;
                  let y = rect.top;
                  if (x + submenuWidth > viewportWidth - 12) {
                    x = Math.max(12, rect.left - submenuWidth - gap);
                  }
                  if (y + submenuHeight > viewportHeight - 12) {
                    y = Math.max(12, viewportHeight - submenuHeight - 12);
                  }
                  setSortSubmenuAnchor({ x, y });
                }}
                onMouseLeave={() => scheduleSubmenuClose()}
                onClick={(e) => e.preventDefault()}
                className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
              >
                <ArrowUpDown className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <span className="flex-1">{t("Sắp xếp (Sort by)", "Sort by")}</span>
                <span className="text-[10px] text-sky-400 font-mono capitalize">{effectiveSortBy}</span>
                <ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-secondary)" }} />
              </button>
            </div>
          )}

          {/* Section 5: Refresh (background only) + Open in Terminal */}
          <div className="py-1">
            {!contextMenu.targetItem && (
              <button
                onClick={() => {
                  refreshCurrentDirectory?.();
                  setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                  contextMenuActiveRef.current = true;
                  setTimeout(() => { contextMenuActiveRef.current = false; }, 800);
                }}
                className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
                <span>{t("Làm mới thư mục hiện tại", "Refresh current folder")}</span>
              </button>
            )}

            {/* Paste (background only) — paste into the current folder. */}
            {!contextMenu.targetItem && (
              <button
                onClick={async () => {
                  await explorer.pasteItems?.();
                  setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                  contextMenuActiveRef.current = true;
                  setTimeout(() => { contextMenuActiveRef.current = false; }, 800);
                }}
                disabled={!explorer.clipboard || explorer.clipboard.itemIds.length === 0}
                className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Clipboard className="w-3.5 h-3.5" style={{ color: "var(--text-secondary)" }} />
                <span>{t("Dán", "Paste")}</span>
              </button>
            )}

            {/* Open in Terminal — same row for both background and folder items */}
            {(contextMenu.targetItem?.type === "directory" ||
              (!contextMenu.targetItem && currentPath)) && (
              <button
                onClick={async () => {
                  const targetPath = contextMenu.targetItem
                    ? contextMenu.targetItem.path
                    : currentPath;
                  if (!targetPath) return;
                  setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                  contextMenuActiveRef.current = true;
                  setTimeout(() => { contextMenuActiveRef.current = false; }, 800);
                  try {
                    const { Command } = await import("@tauri-apps/plugin-shell");
                    const cmd = Command.create("wt", [
                      "-d", targetPath.replace(/\//g, "\\"),
                    ]);
                    await cmd.spawn();
                    explorer.setStatusMessage(
                      t(`Đã mở Terminal tại: ${targetPath}`, `Opened Terminal at: ${targetPath}`)
                    );
                  } catch (err) {
                    explorer.setStatusMessage(
                      t(`Không thể mở Terminal: ${String(err)}`, `Could not open Terminal: ${String(err)}`)
                    );
                  }
                }}
                className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
                title={t("Mở Terminal tại thư mục hiện tại", "Open Terminal at current folder")}
              >
                <TerminalIcon className="w-3.5 h-3.5 text-emerald-400" />
                <span>{t("Mở Terminal tại đây", "Open in Terminal")}</span>
              </button>
            )}
          </div>

          {/* ── Phase 2.1: Plugin-driven verbs (extension handlers only).
              For background: sits between "Open in Terminal" and "New / Group by".
              We filter out Properties here and render it as the last row below.
              Hidden by default, shown only when "Show More Options" is clicked. */}
          {!contextMenu.targetItem && showMoreOptions && (
            <ErrorBoundary>
              <ShowMoreOptionsSection
                scope="background"
                targetPath={currentPath}
                filterVerbs={[VERB_NEW, VERB_GRANT, VERB_GRANT_USER, VERB_PROPERTIES, VERB_DELETE]}
                onHoverEnter={cancelSubmenuClose}
              />
            </ErrorBoundary>
          )}

          {/* Section 6: New > (submenu). Available for both background and
              folder items; the folder item uses its own path as the
              parent, while background uses currentPath. */}
          <div className="py-1">
            <button
              onMouseEnter={(e) => {
                cancelSubmenuClose();
                setViewSubmenuAnchor(null);
                setSortSubmenuAnchor(null);
                setOpenWithSubmenuAnchor(null);
                const submenuWidth = 180;
                const submenuHeight = 110;
                const gap = 4;
                const rect = e.currentTarget.getBoundingClientRect();
                const viewportWidth = window.innerWidth;
                const viewportHeight = window.innerHeight;
                let x = rect.right + gap;
                let y = rect.top;
                if (x + submenuWidth > viewportWidth - 12) {
                  x = Math.max(12, rect.left - submenuWidth - gap);
                }
                if (y + submenuHeight > viewportHeight - 12) {
                  y = Math.max(12, viewportHeight - submenuHeight - 12);
                }
                setNewSubmenuAnchor({ x, y });
              }}
              onMouseLeave={() => scheduleSubmenuClose()}
              onClick={(e) => e.preventDefault()}
              className="flex items-center justify-between gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <Plus className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>{t("Tạo mới", "New")}</span>
              </span>
              <ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-secondary)" }} />
            </button>

            {/* Group by (background only) */}
            {!contextMenu.targetItem && (
              <button
                onMouseEnter={(e) => {
                  cancelSubmenuClose();
                  setGroupBySubmenuAnchor(null);
                  setViewSubmenuAnchor(null);
                  setSortSubmenuAnchor(null);
                  setNewSubmenuAnchor(null);
                  setOpenWithSubmenuAnchor(null);
                  const submenuWidth = 220;
                  const submenuHeight = 320;
                  const gap = 4;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const viewportWidth = window.innerWidth;
                  const viewportHeight = window.innerHeight;
                  let x = rect.right + gap;
                  let y = rect.top;
                  if (x + submenuWidth > viewportWidth - 12) {
                    x = Math.max(12, rect.left - submenuWidth - gap);
                  }
                  if (y + submenuHeight > viewportHeight - 12) {
                    y = Math.max(12, viewportHeight - submenuHeight - 12);
                  }
                  setGroupBySubmenuAnchor({ x, y });
                }}
                onMouseLeave={() => scheduleSubmenuClose()}
                onClick={(e) => e.preventDefault()}
                className="flex items-center justify-between gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Boxes className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>{t("Nhóm theo (Group by)", "Group by")}</span>
                </span>
                <ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-secondary)" }} />
              </button>
            )}

            {/* Customize this folder (background only) */}
            {!contextMenu.targetItem && (
              <button
                onClick={async () => {
                  if (!currentPath) return;
                  // Shell verb: System.ShellFolderItem
                  try {
                    await executeShellExtensionVerb(currentPath, "customizethisfolder");
                  } catch {
                    explorer.setStatusMessage(t("Lỗi: không mở được tuỳ chỉnh thư mục", "Error: could not open folder customization"));
                  }
                  setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                }}
                className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
              >
                <Settings2 className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-secondary)" }} />
                <span>{t("Tùy chỉnh thư mục này...", "Customize this folder...")}</span>
              </button>
            )}
          </div>

          {/* Section 7: Item-specific actions — Open / Open with / Create shortcut / etc.
              Note: Paste/Cut/Copy/Delete/Rename are rendered in Section 1 (icon-only row above). */}
          {contextTargetItem && (
            <div className="py-1">
              {/* Open — the default verb for this item, bold + sky accent. */}
              <button
                onClick={async () => {
                  if (!contextTargetItem) return;
                  try {
                    await executeShellExtensionVerb(contextTargetItem.id, "open");
                  } catch (e) {
                    handleItemDoubleClick(contextTargetItem);
                  }
                  setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                  contextMenuActiveRef.current = true;
                  setTimeout(() => { contextMenuActiveRef.current = false; }, 800);
                }}
                className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer text-sky-300 font-semibold"
                title={t("Mở (Enter)", "Open (Enter)")}
              >
                <AppWindow className="w-3.5 h-3.5 shrink-0 text-sky-400" />
                <span>{t("Mở", "Open")}</span>
              </button>

              {/* Open with… hover submenu. */}
              {effectiveContextFile && (
                <button
                  onMouseEnter={(e) => {
                    cancelSubmenuClose();
                    setNewSubmenuAnchor(null);
                    if (!effectiveContextFile?.path) return;
                    const submenuWidth = 300;
                    const submenuHeight = 360;
                    const gap = 4;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const viewportWidth = window.innerWidth;
                    const viewportHeight = window.innerHeight;
                    let x = rect.right + gap;
                    let y = rect.top;
                    if (x + submenuWidth > viewportWidth - 12) {
                      x = Math.max(12, rect.left - submenuWidth - gap);
                    }
                    if (y + submenuHeight > viewportHeight - 12) {
                      y = Math.max(12, viewportHeight - submenuHeight - 12);
                    }
                    setOpenWithSubmenuAnchor({ x, y });
                    void explorer.preloadOpenWithCandidates?.(effectiveContextFile.path);
                  }}
                  onMouseLeave={() => scheduleSubmenuClose()}
                  onClick={(e) => e.preventDefault()}
                  className="flex items-center justify-between gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <AppWindow className="w-3.5 h-3.5 shrink-0" style={{ color: accentColor }} />
                    <span>{t("Mở bằng...", "Open with...")}</span>
                  </span>
                  <ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-secondary)" }} />
                </button>
              )}

              {/* Create shortcut */}
              <button
                onClick={async () => {
                  if (!contextTargetItem) return;
                  try {
                    await executeShellExtensionVerb(contextTargetItem.id, "link");
                  } catch (e) {
                    explorer.setStatusMessage(
                      t(`Không thể tạo shortcut: ${String(e)}`, `Could not create shortcut: ${String(e)}`)
                    );
                  }
                  setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                }}
                className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
              >
                <FilePlus className="w-3.5 h-3.5" style={{ color: "var(--text-secondary)" }} />
                <span>{t("Tạo shortcut", "Create shortcut")}</span>
              </button>

              {/* Copy as path */}
              <button
                onClick={() => {
                  if (contextTargetItem) {
                    navigator.clipboard.writeText(contextTargetItem.path);
                    explorer.setStatusMessage(
                      t(`Đã sao chép: ${contextTargetItem.path}`, `Copied: ${contextTargetItem.path}`)
                    );
                  }
                  setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                }}
                className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
              >
                <Link className="w-3.5 h-3.5" style={{ color: "var(--text-secondary)" }} />
                <span>{t("Sao chép đường dẫn", "Copy as path")}</span>
              </button>

              {/* Phase 2.3 — Pin/Unpin to Quick Access (folder only).
                  Uses shell extension verb "pintohome" / "unpinhome" to match
                  Windows Explorer's behavior. Refreshes the Quick Access sidebar
                  after the operation. */}
              {contextTargetItem.type === "directory" && (
                <div className="py-1 border-t border-white/5">
                  <button
                    onClick={async () => {
                      if (!contextTargetItem) return;
                      try {
                        await executeShellExtensionVerb(contextTargetItem.id, "pintohome");
                        explorer.setStatusMessage(
                          t(`Đã ghim ${contextTargetItem.name} vào Truy cập nhanh.`,
                            `Pinned ${contextTargetItem.name} to Quick Access.`)
                        );
                        // Trigger Quick Access sidebar refresh
                        dropdownEventBus.emit(DROPDOWN_EVENTS.QUICK_ACCESS_REFRESH);
                      } catch (e) {
                        explorer.setStatusMessage(
                          t(`Không thể ghim: ${String(e)}`,
                            `Could not pin: ${String(e)}`)
                        );
                      }
                      setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                    }}
                    className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
                  >
                    <Pin className="w-3.5 h-3.5" style={{ color: "var(--text-secondary)" }} />
                    <span>{t("Ghim vào Truy cập nhanh", "Pin to Quick Access")}</span>
                  </button>
                  <button
                    onClick={async () => {
                      if (!contextTargetItem) return;
                      try {
                        await invoke("unpin_from_quick_access", { path: contextTargetItem.id });
                        explorer.setStatusMessage(
                          t(`Đã bỏ ghim ${contextTargetItem.name} khỏi Truy cập nhanh.`,
                            `Unpinned ${contextTargetItem.name} from Quick Access.`)
                        );
                        // Trigger Quick Access sidebar refresh
                        dropdownEventBus.emit(DROPDOWN_EVENTS.QUICK_ACCESS_REFRESH);
                      } catch (e) {
                        explorer.setStatusMessage(
                          t(`Không thể bỏ ghim: ${String(e)}`,
                            `Could not unpin: ${String(e)}`)
                        );
                      }
                      setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                    }}
                    className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
                  >
                    <PinOff className="w-3.5 h-3.5" style={{ color: "var(--text-secondary)" }} />
                    <span>{t("Bỏ ghim khỏi Truy cập nhanh", "Unpin from Quick Access")}</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Phase 2.1: Plugin-driven verbs (extension handlers).
              For file/folder menus: renders all verbs except Properties.
              For background menu: we already rendered handlers above, so skip here.
              Properties for both is added as a dedicated button below using Rust command.
              Hidden by default, shown only when "Show More Options" is clicked. */}
          {contextTargetItem && showMoreOptions && (
            <ErrorBoundary>
              <ShowMoreOptionsSection
                scope={contextTargetItem.type === "directory" ? "directory" : "files"}
                targetPath={contextTargetItem.id}
                filterVerbs={[
                  VERB_OPEN, VERB_OPENWITH, VERB_CUT, VERB_COPY,
                  VERB_COPYASPATH, VERB_LINK, VERB_GRANT, VERB_GRANT_USER,
                  VERB_PROPERTIES, VERB_NEW, VERB_DELETE,
                  "pintohome",
                ]}
                onHoverEnter={cancelSubmenuClose}
              />
            </ErrorBoundary>
          )}

          {/* Properties button for file/folder using Rust command */}
          {contextTargetItem && (
            <div className="border-t border-white/5">
              <button
                onClick={() => {
                  invoke("open_file_properties", { path: contextTargetItem.id });
                  setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                  contextMenuActiveRef.current = true;
                  setTimeout(() => { contextMenuActiveRef.current = false; }, 800);
                }}
                className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer text-orange-400"
              >
                <Info className="w-3.5 h-3.5" />
                <span>{t("Thuộc tính tệp (Properties)", "File properties")}</span>
              </button>
            </div>
          )}

          {/* Show More Options toggle for file/folder */}
          {contextTargetItem && (
            <button
              onClick={() => setShowMoreOptions(!showMoreOptions)}
              className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
              <span>{showMoreOptions ? t("Ẩn bớt", "Show less") : t("Hiện thêm", "Show more options")}</span>
            </button>
          )}

          {/* Background-only: Properties button using Rust command */}
          {!contextMenu.targetItem && (
            <div className="border-t border-white/5">
              <button
                onClick={() => {
                  if (!currentPath) return;
                  invoke("open_file_properties", { path: currentPath });
                  setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                  contextMenuActiveRef.current = true;
                  setTimeout(() => { contextMenuActiveRef.current = false; }, 800);
                }}
                className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer text-orange-400"
              >
                <Info className="w-3.5 h-3.5" />
                <span>{t("Thuộc tính tệp (Properties)", "File properties")}</span>
              </button>
            </div>
          )}

          {/* Show More Options toggle for background (bottom of menu) */}
          {!contextMenu.targetItem && (
            <button
              onClick={() => setShowMoreOptions(!showMoreOptions)}
              className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
              <span>{showMoreOptions ? t("Ẩn bớt", "Show less") : t("Hiện thêm", "Show more options")}</span>
            </button>
          )}
        </div>
      )}

      {openWithSubmenuAnchor && effectiveContextFile && (
        <OpenWithSubmenu
          explorer={explorer}
          anchor={openWithSubmenuAnchor}
          targetPath={effectiveContextFile.path}
          onHoverEnter={cancelSubmenuClose}
          onHoverLeave={scheduleSubmenuClose}
          onClose={() => {
            cancelSubmenuClose();
            setContextMenuOpenWithFile(null);
            setOpenWithSubmenuAnchor(null);
          }}
        />
      )}

      {/* Phase 2.2: New > hover-submenu (folder + file). */}
      {newSubmenuAnchor && (
        <div
          className="fixed fluent-menu rounded-xl py-1.5 w-56 text-xs shadow-2xl z-[610] animate-in fade-in zoom-in-95 duration-100"
          style={{ top: newSubmenuAnchor.y, left: newSubmenuAnchor.x, color: "var(--text-primary)" }}
          onMouseEnter={cancelSubmenuClose}
          onMouseLeave={scheduleSubmenuClose}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              handleQuickAddFolder();
              setNewSubmenuAnchor(null);
              setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
            }}
            className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
          >
            <FolderPlus className="w-3.5 h-3.5 text-amber-500" />
            <span>{t("Thư mục", "Folder")}</span>
          </button>
          <button
            onClick={() => {
              handleQuickAddFile();
              setNewSubmenuAnchor(null);
              setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
            }}
            className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
          >
            <FilePlus className="w-3.5 h-3.5 text-sky-400" />
            <span>{t("Tệp tin", "File")}</span>
          </button>
        </div>
      )}

      {/* Group by hover-submenu (background only). */}
      {groupBySubmenuAnchor && (
        <div
          className="fixed fluent-menu rounded-xl py-1.5 w-52 text-xs shadow-2xl z-[610] animate-in fade-in zoom-in-95 duration-100"
          style={{ top: groupBySubmenuAnchor.y, left: groupBySubmenuAnchor.x, color: "var(--text-primary)" }}
          onMouseEnter={cancelSubmenuClose}
          onMouseLeave={scheduleSubmenuClose}
          onClick={(e) => e.stopPropagation()}
        >
          {(["name", "size", "itemtype", "datemodified", "datemodified1", "tags"] as const).map((val) => {
            const labels: Record<string, { vi: string; en: string }> = {
              name: { vi: "Tên", en: "Name" },
              size: { vi: "Kích thước", en: "Size" },
              itemtype: { vi: "Loại mục", en: "Item type" },
              datemodified: { vi: "Ngày sửa đổi", en: "Date modified" },
              datemodified1: { vi: "Ngày tạo", en: "Date created" },
              tags: { vi: "Thẻ", en: "Tags" },
            };
            const isActive = effectiveSortBy === val;
            const label = labels[val]?.[explorer.language === "vi" ? "vi" : "en"] ?? val;
            return (
              <button
                key={val}
                onClick={() => {
                  explorer.setSortBy?.(val as SortBy);
                  setGroupBySubmenuAnchor(null);
                  setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                }}
                className={`flex items-center gap-2 w-full px-3 py-1.5 text-left ${
                  isActive ? "text-emerald-400 font-medium" : "hover:bg-white/10"
                }`}
              >
                <span className="flex-1">{label}</span>
                {isActive && <Check className="w-3 h-3 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}

      {/* (Delete submenu removed in Phase 2.3 — Delete is now a single
          button in the Command Bar at the top of the menu. The default
          action moves items to the Recycle Bin; "Permanently delete"
          (Shift+Delete) is reachable via the keyboard shortcut.) */}

      {/* View Mode hover-submenu (ExplorerContextMenu) */}
      {viewSubmenuAnchor && (
        <div
          className="fixed fluent-menu rounded-xl w-[290px] overflow-hidden explorer-context-menu py-1 z-[600]"
          style={{ top: viewSubmenuAnchor.y, left: viewSubmenuAnchor.x, color: "var(--text-primary)" }}
          onMouseEnter={cancelSubmenuClose}
          onMouseLeave={scheduleSubmenuClose}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* Row layout: 7 view-mode items on the left + vertical slider on the right */}
          <div className="flex items-stretch">
            {/* Left: 7 view mode items */}
            <div className="py-1 min-w-[230px] flex-1">
              {/* Show notice for This PC - no view mode change allowed */}
              {effectiveCurrentPath === "shell:::{679F85CB-0220-4080-B29B-5540CC05AAB6}" ? (
                <div className="px-3 py-2 text-xs italic" style={{ color: "var(--text-muted)" }}>
                  {t("This PC sử dụng view mặc định", "This PC uses default view")}
                </div>
              ) : (
                VIEW_MODE_LABELS.map(({ value, vi, en, group }) => (
                  <button
                    key={value}
                    onClick={() => {
                      setEffectiveViewMode(value);
                      const label = explorer.language === "vi" ? vi : en;
                      explorer.setStatusMessage(t(`Đổi sang xem: ${label}`, `View set to ${label}`));
                      setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                      closeAllSubmenus();
                      contextMenuActiveRef.current = true;
                      setTimeout(() => { contextMenuActiveRef.current = false; }, 800);
                    }}
                    className="flex items-center justify-between w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      {group === "list"
                        ? <LayoutList className="w-3 h-3 text-sky-400" />
                        : <LayoutGrid className="w-3 h-3 text-orange-400" />}
                      <span>{t(vi, en)}</span>
                    </div>
                    {effectiveViewMode === value && <Check className="w-3 h-3 text-emerald-400" />}
                  </button>
                ))
              )}
            </div>

            {/* Vertical divider - hide on This PC */}
            {!isThisPC && (
              <>
                <div className="w-px shrink-0" style={{ backgroundColor: "rgba(255,255,255,0.08)" }} />

            {/* Right: vertical slider — same look as the Header slider so the two stay in sync */}
            <div
              className="flex items-center justify-center px-2 select-none shrink-0"
              style={{ minHeight: "210px" }}
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
                value={localViewSlider ?? effectiveViewMode}
                onMouseDown={() => {
                  viewSliderDraggingRef.current = true;
                  setLocalViewSlider(effectiveViewMode);
                }}
                onInput={(e) => {
                  const val = parseFloat(e.currentTarget.value);
                  setLocalViewSlider(val);
                  setEffectiveViewMode(val as ViewMode);
                }}
                onMouseUp={(e) => {
                  viewSliderDraggingRef.current = false;
                  const raw = parseFloat(e.currentTarget.value);
                  setLocalViewSlider(null);
                  setEffectiveViewMode(raw as ViewMode);
                  explorer.setStatusMessage(
                    explorer.language === "vi"
                      ? `Đổi sang xem: ${raw}`
                      : `View set to ${raw}`,
                  );
                  setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                  closeAllSubmenus();
                }}
                onMouseLeave={(e) => {
                  if (viewSliderDraggingRef.current) {
                    viewSliderDraggingRef.current = false;
                    const raw = parseFloat(e.currentTarget.value);
                    setLocalViewSlider(null);
                    setEffectiveViewMode(raw as ViewMode);
                    explorer.setStatusMessage(
                      explorer.language === "vi"
                        ? `Đổi sang xem: ${raw}`
                        : `View set to ${raw}`,
                    );
                    setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                    closeAllSubmenus();
                  }
                }}
                onTouchStart={() => {
                  viewSliderDraggingRef.current = true;
                  setLocalViewSlider(effectiveViewMode);
                }}
                onTouchEnd={(e) => {
                  viewSliderDraggingRef.current = false;
                  const raw = parseFloat(e.currentTarget.value);
                  setLocalViewSlider(null);
                  setEffectiveViewMode(raw as ViewMode);
                  explorer.setStatusMessage(
                    explorer.language === "vi"
                      ? `Đổi sang xem: ${raw}`
                      : `View set to ${raw}`,
                  );
                  setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                  closeAllSubmenus();
                }}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className="view-slider-v-minimal-compact cursor-pointer"
                style={{ accentColor: explorer.accentColor }}
                aria-label="View mode slider"
              />
            </div>
              </>
            )}
          </div>

          <div className="my-1 border-t border-white/5" />

          <button
            onClick={() => {
              explorer.setShowHiddenItems(!showHiddenItems);
              explorer.setStatusMessage(
                showHiddenItems
                  ? t("Đã ẩn tệp ẩn.", "Hidden items hidden.")
                  : t("Đã hiện tệp ẩn.", "Hidden items shown.")
              );
            }}
            className="flex items-center justify-between w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
          >
            <span>{t("Hiện tệp ẩn", "Show hidden items")}</span>
            {showHiddenItems && <Check className="w-3 h-3 text-emerald-400" />}
          </button>

          <button
            onClick={() => {
              explorer.setHideFileExtensions(!hideFileExtensions);
              explorer.setStatusMessage(
                hideFileExtensions
                  ? t("Đã hiện phần mở rộng tệp.", "File extensions shown.")
                  : t("Đã ẩn phần mở rộng tệp.", "File extensions hidden.")
              );
            }}
            className="flex items-center justify-between w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
          >
            <span>{t("Ẩn phần mở rộng tệp", "Hide file extensions")}</span>
            {hideFileExtensions && <Check className="w-3 h-3 text-emerald-400" />}
          </button>
        </div>
      )}

      {/* Sort hover-submenu (ExplorerContextMenu) */}
      {sortSubmenuAnchor && (
        <div
          className="fixed fluent-menu rounded-xl w-[220px] overflow-hidden explorer-context-menu py-1 z-[600]"
          style={{ top: sortSubmenuAnchor.y, left: sortSubmenuAnchor.x, color: "var(--text-primary)" }}
          onMouseEnter={cancelSubmenuClose}
          onMouseLeave={scheduleSubmenuClose}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {([
            { val: "name", vi: "Sắp xếp theo Tên", en: "Sort by Name" },
            { val: "size", vi: "Dung lượng dữ liệu", en: "Data Size" },
            { val: "type", vi: "Định dạng tệp tin", en: "File Type" },
            { val: "date", vi: "Mốc sửa đổi", en: "Modified Date" },
          ] as const).map(({ val, vi, en }) => (
            <button
              key={val}
              onClick={() => {
                setEffectiveSortBy(val);
                explorer.setStatusMessage(t(`Sắp xếp theo: ${val}`, `Sorted items by ${val}`));
                setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
                closeAllSubmenus();
                contextMenuActiveRef.current = true;
                setTimeout(() => { contextMenuActiveRef.current = false; }, 800);
              }}
              className="flex items-center justify-between w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
            >
              <span>{t(vi, en)}</span>
              {effectiveSortBy === val && <Check className="w-3 h-3 text-indigo-400" />}
            </button>
          ))}

          <div className="mx-2 border-t border-white/10" />

          <button
            onClick={() => {
              setEffectiveSortDirection("asc");
              explorer.setStatusMessage(t("Sắp xếp tăng dần.", "Sorted ascending."));
              setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
              closeAllSubmenus();
              contextMenuActiveRef.current = true;
              setTimeout(() => { contextMenuActiveRef.current = false; }, 800);
            }}
            className="flex items-center justify-between w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
          >
            <span>{t("Tăng dần (A - Z)", "Ascending (A - Z)")}</span>
            {effectiveSortDirection === "asc" && <Check className="w-3 h-3 text-emerald-400" />}
          </button>
          <button
            onClick={() => {
              setEffectiveSortDirection("desc");
              explorer.setStatusMessage(t("Sắp xếp giảm dần.", "Sorted descending."));
              setContextMenu({ ...contextMenu, visible: false, showMoreOptions: false });
              closeAllSubmenus();
              contextMenuActiveRef.current = true;
              setTimeout(() => { contextMenuActiveRef.current = false; }, 800);
            }}
            className="flex items-center justify-between w-full px-3 py-1.5 hover:bg-white/10 text-left cursor-pointer"
          >
            <span>{t("Giảm dần (Z - A)", "Descending (Z - A)")}</span>
            {effectiveSortDirection === "desc" && <Check className="w-3 h-3 text-emerald-400" />}
          </button>
        </div>
      )}
    </div>
  );
}
