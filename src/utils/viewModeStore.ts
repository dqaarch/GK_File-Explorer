import { ViewMode } from "../types";

/**
 * Shared per-folder View Mode store.
 *
 * Both the Explorer Main pane and the Folder Inspector write/read the same
 * `NEXUS_FOLDER_VIEW_MODES` localStorage record so that:
 *   - When the user changes the view mode in the Inspector, the Main pane
 *     reflects that change the next time it navigates back to that folder.
 *   - When the user changes the view mode in the Main pane, an open Inspector
 *     for the same folder updates immediately.
 *
 * We dispatch a `goku-view-mode-changed` CustomEvent on `window` so the
 * other pane (same tab) hears about the change. Plain `storage` events only
 * fire across tabs/windows, so we need a CustomEvent for same-tab sync.
 */

export const FOLDER_VIEW_MODES_KEY = "NEXUS_FOLDER_VIEW_MODES";
export const VIEW_MODE_CHANGED_EVENT = "goku-view-mode-changed";

export interface ViewModeChangeDetail {
  path: string;
  mode: ViewMode;
}

function isViewMode(value: unknown): value is ViewMode {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 7;
}

function loadAll(): Record<string, ViewMode> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(FOLDER_VIEW_MODES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, ViewMode> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof key === "string" && isViewMode(val)) {
        out[key] = val;
      }
    }
    return out;
  } catch (_) {
    return {};
  }
}

function saveAll(map: Record<string, ViewMode>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FOLDER_VIEW_MODES_KEY, JSON.stringify(map));
  } catch (_) {
    /* localStorage might be full or disabled — silently ignore */
  }
}

/**
 * Read the saved view mode for a folder path.
 * Returns null if no preference is saved.
 */
export function getFolderViewMode(path: string): ViewMode | null {
  if (!path) return null;
  const all = loadAll();
  return all[path] ?? null;
}

/**
 * Persist the view mode for a folder path and notify other panes in the
 * same tab via a CustomEvent so they can re-sync.
 */
export function setFolderViewMode(path: string, mode: ViewMode): void {
  if (!path) return;
  const clamped = Math.max(1, Math.min(7, Math.round(mode))) as ViewMode;
  const all = loadAll();
  all[path] = clamped;
  saveAll(all);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<ViewModeChangeDetail>(VIEW_MODE_CHANGED_EVENT, {
        detail: { path, mode: clamped },
      })
    );
  }
}

/**
 * Subscribe to view-mode changes from anywhere in the same tab.
 * Returns an unsubscribe function.
 */
export function subscribeViewModeChange(
  handler: (detail: ViewModeChangeDetail) => void
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<ViewModeChangeDetail>).detail;
    if (detail && typeof detail.path === "string" && isViewMode(detail.mode)) {
      handler(detail);
    }
  };
  window.addEventListener(VIEW_MODE_CHANGED_EVENT, listener);
  return () => window.removeEventListener(VIEW_MODE_CHANGED_EVENT, listener);
}
