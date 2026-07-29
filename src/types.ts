/**
 * Types defining our File Explorer & Advanced Explorer states
 */

export interface FSItem {
  id: string;         // Absolute path (unique identifier)
  name: string;
  path: string;        // Absolute filesystem path (real OS path)
  type: "file" | "directory";
  parentId: string | null; // Parent directory path
  size: number; // in bytes
  content?: string; // Textual content for text, markdown, or scripts
  createdAt: string;
  updatedAt: string;
  tag?: "Deliverable" | "WIP" | "Draft" | "Archived" | "Warning";
  mimeType?: string;
  isHidden?: boolean;
}

export type SearchMode = "default";

export interface TabSearchState {
  query: string;
  tag: string | null;
  typeFilter: string | null;
  mode: SearchMode;
  results: FSItem[];
  resultsRoot: string | null;
  isSearching: boolean;
  resultsCount: number;
}

export interface PaneSession {
  folderInspectionPath: string | null;
  inspectorSelectedIds: string[];
  showMultiSelectInspector: boolean;
  multiSelectItems: FSItem[];
  showDetailsPane: boolean;
}

export const DEFAULT_PANE_SESSION: PaneSession = {
  folderInspectionPath: null,
  inspectorSelectedIds: [],
  showMultiSelectInspector: false,
  multiSelectItems: [],
  showDetailsPane: true,
};

export interface ExplorerTab {
  id: string;
  title: string;
  currentPath: string; // Real OS filesystem path, e.g. "C:/Users/Admin/Documents"
  currentFolderId: string | null; // Same as currentPath for real FS (null = drive root)
  history: { folderId: string | null; path: string }[];
  historyIndex: number;
  // Per-tab state
  selectedIds: string[];  // Selected items in this tab
  scrollPosition: number; // Scroll position in this tab
  folderContents: FSItem[]; // Cached folder contents for this tab
  showSpaceAnalyzer?: boolean; // Whether Space Analyzer is open in this tab
  // Per-tab search state
  searchState: TabSearchState;
  // Per-tab right-pane session (inspector / multi-select / details visibility)
  paneSession: PaneSession;
}

// Slider-based view mode (1-7):
//   1: Extra Large icons  (160px)  ─┐
//   2: Large icons        (112px)   │ icon group — sizes interpolate continuously
//   3: Medium icons       (80px)    │
//   4: Small icons        (36px)   ─┘
//   5: Columns view       (list rows in 60-item chunks)
//   6: List view          (single list)
//   7: Details list       (columns with file metadata)
export type ViewMode = number;
export const VIEW_MODE_MIN = 1;
export const VIEW_MODE_MAX = 7;

export const VIEW_MODE_LABELS: Array<{ value: number; vi: string; en: string; group: "icon" | "list" }> = [
  { value: 1, vi: "Biểu tượng cực lớn",  en: "Extra large icons",   group: "icon" },
  { value: 2, vi: "Biểu tượng lớn",      en: "Large icons",         group: "icon" },
  { value: 3, vi: "Biểu tượng trung bình", en: "Medium icons",      group: "icon" },
  { value: 4, vi: "Biểu tượng nhỏ",      en: "Small icons",         group: "icon" },
  { value: 5, vi: "Danh sách cột (Columns)", en: "Columns view",     group: "list" },
  { value: 6, vi: "Danh sách giản lược",  en: "List view",           group: "list" },
  { value: 7, vi: "Danh sách chi tiết",   en: "Details list",        group: "list" },
];

/** Group classification: 1-4 are icon-grid modes, 5-7 are list-based modes. */
export function viewModeGroup(v: number): "icon" | "list" {
  return v >= 1 && v <= 4 ? "icon" : "list";
}

/**
 * Decide thumbnail request size (in pixels) for the backend's
 * `get_thumbnails_batch` IPC. Two tiers:
 *
 *  - list/details/columns (mode 5-7) → 64px (sharp at 16-20px CSS,
 *    inside Windows shell cache discrete sizes; minimal scale-up work).
 *  - icon grid (mode 1-4) → 160px (covers the largest grid icon size
 *    `getIconSizePx(1)=160`; matches the upper end of the grid range).
 *
 * Previously always requested 256px which was wasted bandwidth for the
 * 16px list icons — Windows would downscale inside the shell, but we'd
 * still ship ~50 KB PNGs across IPC only to display them at 16px.
 */
export function thumbRequestSize(viewMode: number): number {
  return viewModeGroup(viewMode) === "list" ? 64 : 160;
}

/**
 * Interpolate icon size in pixels for the icon-grid group (1-4).
 *   value=1 → 160px   value=4 → 36px   linear in between.
 * Returns a `{ width, height }` pair (in px).
 */
export function getIconSizePx(value: number): { width: number; height: number } {
  const v = Math.max(1, Math.min(4, Math.round(value)));
  const progress = (v - 1) / 3; // 0..1
  const px = Math.round(160 - progress * (160 - 36)); // 160 → 36
  return { width: px, height: px };
}

/** Min cell width (px) for the icon grid auto-fill layout. */
export function getIconGridMinCellPx(value: number): number {
  const v = Math.max(1, Math.min(4, Math.round(value)));
  const progress = (v - 1) / 3;
  return Math.round(180 - progress * (180 - 100)); // 180 → 100
}
export type SortBy = "name" | "size" | "type" | "date";
export type SortDirection = "asc" | "desc";

// Backward-compatible alias
export type SearchFilter = TabSearchState;

export interface ClipboardState {
  itemIds: string[];
  action: "copy" | "cut" | null;
  /// The folder these items were copied/cut from. Used by paste to decide
  /// whether to use the Recycle Bin restore path (when source starts with
  /// `recyclebin://`). Optional for backward compatibility with code paths
  /// that still set clipboard the old way.
  sourcePath?: string;
  /// When the items came from the Recycle Bin, this carries the structured
  /// data the Rust restore command needs (name + original_parent +
  /// parsing_name). The `itemIds` array alone is not enough because the
  /// synthetic `path` we generate for display doesn't contain the
  /// `$Recycle.Bin` segment anymore.
  recycleBinEntries?: RecycleBinEntry[];
}

/// Structured data for an item in the Recycle Bin, mirroring the Rust
/// `recycle_bin::RecycleBinEntry` struct. Used by paste-from-recycle-bin
/// to send each cut item back to the Rust restore command.
export interface RecycleBinEntry {
  /// Shell-side identifier (Windows parsing name, e.g. the $Rxxx.ext path
  /// inside $Recycle.Bin/<SID>).
  parsing_name: string;
  /// Folder the file was deleted from.
  original_parent: string;
  /// Original filename.
  name: string;
}

export interface NavigationDestination {
  id: string;
  label: string;
  path: string;
  kind: "recent" | "pinned" | "special" | "drive" | "current";
  iconKey: "folder" | "drive" | "desktop" | "documents" | "downloads" | "pictures" | "videos" | "music" | "computer" | "home" | "star" | "clock";
  description?: string;
  usedGB?: number;
  totalGB?: number;
}

export interface SpaceStats {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  typeDistribution: { name: string; value: number; color: string }[];
  tagsCount: { name: string; count: number; color: string }[];
}

export interface TagSetting {
  id: string;
  nameEn: string;
  nameVi: string;
  color: string;
}

export function getTagTranslation(tag: string | undefined | null, language: "vi" | "en", tagSettings?: TagSetting[]): string {
  if (!tag) return "";
  // Use custom tag settings if provided
  if (tagSettings) {
    const customTag = tagSettings.find(t => t.id === tag);
    if (customTag) {
      return language === "vi" ? customTag.nameVi : customTag.nameEn;
    }
  }
  // Fallback to default translations
  if (language === "vi") {
    switch (tag) {
      case "Warning": return "Toang";
      case "WIP": return "WIP";
      case "Deliverable": return "Đã bàn giao";
      case "Archived": return "Đóng hòm";
      case "Draft": return "Mới nhú";
      default: return tag;
    }
  }
  return tag;
}
