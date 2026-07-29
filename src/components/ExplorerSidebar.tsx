import React, { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { ExplorerAPI } from "../useExplorer";
import { getTagTranslation, TagSetting } from "../types";
import { ColorPicker } from "./ColorPicker";
import {
  HardDrive, Clock, Tag,
  Monitor, Palette, Pin, PinOff, File, Folder, House, RefreshCw, ChevronRight, ChevronDown,
  Settings, X
} from "lucide-react";
import { formatFileSize, DriveInfo } from "../TauriFileSystem";
import { useWindowsQuickAccess } from "../hooks/useWindowsQuickAccess";
import { FolderIcon, useFolderIcons, WindowsFolder } from "../hooks/useFolderIcons";
import { useSpecialFolderIcon } from "../hooks/useSpecialFolderIcon";
import { readDirectory } from "../TauriFileSystem";

// Brand SVG icons for cloud storage providers. Each SVG is encoded as a data URL so it
// renders as an <img> tag in the sidebar alongside the 20px drive icon.
const CLOUD_PROVIDER_ICONS: Record<string, string> = {
  google_drive: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M4 4h16l8 12L20 28H4z" fill="none"/>
  <path d="M4 4L0 16l8 12h8L4 4z" fill="#FBBC05"/>
  <path d="M20 4l8 12-8 12h-8l8-12L20 4z" fill="#34A853"/>
  <path d="M4 4h16L12 16z" fill="#4285F4"/>
  <path d="M4 16l8 12h-8L4 16z" fill="#1967D2"/>
  <path d="M20 16l-8 12h8l8-12z" fill="#188038"/>
</svg>`)}`,

  onedrive: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M16 4C10.5 4 6 8.5 6 14c0 3.5 1.8 6.6 4.5 8.4L6 26c0 2.2 1.8 4 4 4h12c2.2 0 4-1.8 4-4l-4.5-3.6C23.2 20.6 25 17.5 25 14c0-5.5-4.5-10-10-10z" fill="#0078D4"/>
  <text x="16" y="20" font-family="Segoe UI,Arial,sans-serif" font-size="8" font-weight="600" fill="white" text-anchor="middle">OneDrive</text>
</svg>`)}`,

  dropbox: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M10 5L3 10l7 5 7-5-7-5z" fill="#0061FF"/>
  <path d="M22 5l7 5-7 5-7-5 7-5z" fill="#0061FF"/>
  <path d="M10 17l-7 5 7 5 7-5-7-5z" fill="#0061FF"/>
  <path d="M22 17l7 5-7 5-7-5 7-5z" fill="#0061FF"/>
  <path d="M10 11l7 5-7 5-7-5 7-5z" fill="#0061FF"/>
  <path d="M22 11l7 5-7 5-7-5 7-5z" fill="#0061FF"/>
</svg>`)}`,

  icloud: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <text x="16" y="18" font-family="SF Pro Display,Helvetica Neue,Arial,sans-serif" font-size="9" font-weight="500" fill="white" text-anchor="middle">iCloud</text>
</svg>`)}`,

  pcloud: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <circle cx="16" cy="16" r="14" fill="#5D6B96"/>
  <text x="16" y="19" font-family="Segoe UI,Arial,sans-serif" font-size="8" font-weight="600" fill="white" text-anchor="middle">pCloud</text>
</svg>`)}`,

  box: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="5" fill="#0061D5"/>
  <text x="16" y="19" font-family="Segoe UI,Arial,sans-serif" font-size="9" font-weight="600" fill="white" text-anchor="middle">Box</text>
</svg>`)}`,
};

function getDriveIcon(drive: DriveInfo, isCurrent: boolean, accentColor: string) {
  const color = isCurrent ? accentColor : "#9ca3af";
  const wrapStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "4px",
    overflow: "hidden",
    padding: "1px",
    flexShrink: 0,
  };
  // Prefer Windows shell icon if available, fallback to hardcoded cloud icons
  if (drive.iconUrl) {
    return (
      <span style={wrapStyle}>
        <img
          src={drive.iconUrl}
          alt=""
          width={22}
          height={22}
          className="shrink-0 group-hover/drive:scale-105 transition"
          style={{ imageRendering: "pixelated", display: "block" }}
          draggable={false}
        />
      </span>
    );
  }
  if (drive.cloudProvider && CLOUD_PROVIDER_ICONS[drive.cloudProvider]) {
    return (
      <span style={wrapStyle}>
        <img
          src={CLOUD_PROVIDER_ICONS[drive.cloudProvider]}
          alt=""
          width={22}
          height={22}
          className="shrink-0 group-hover/drive:scale-105 transition"
          style={{ imageRendering: "auto", display: "block" }}
          draggable={false}
        />
      </span>
    );
  }
  return (
    <span style={wrapStyle}>
      <HardDrive className="w-[22px] h-[22px] group-hover/drive:scale-105 transition" style={{ color }} />
    </span>
  );
}

interface SidebarProps {
  explorer: ExplorerAPI;
  width?: number;
}

const CUSTOM_ACCENTS = [
  { name: "Win11 Blue", value: "#0078d4" },
  { name: "Teal", value: "#008080" },
  { name: "Amethyst Violet", value: "#8b5cf6" },
  { name: "Crimson Rose", value: "#e11d48" },
  { name: "Forest Green", value: "#10b981" },
  { name: "Amber Gold", value: "#f59e0b" },
];

// Section header with collapse chevron button
function SectionHeader({
  icon: Icon,
  title,
  sectionKey,
  collapsed,
  onToggle,
  extra,
}: {
  icon: React.ElementType;
  title: string;
  sectionKey: string;
  collapsed: boolean;
  onToggle: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-2 mb-2">
      <div className="flex items-center gap-1">
        <Icon className="w-3.5 h-3.5 text-stone-500" />
        <span className="text-[10px] font-semibold text-stone-500 uppercase tracking-wider">{title}</span>
      </div>
      <div className="flex items-center gap-0.5">
        {extra}
        <button
          onClick={onToggle}
          className="p-0.5 rounded transition cursor-pointer hover:bg-white/10 text-stone-300"
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed
            ? <ChevronRight className="w-3.5 h-3.5" />
            : <ChevronDown className="w-3.5 h-3.5" />
          }
        </button>
      </div>
    </div>
  );
}

export default function ExplorerSidebar({ explorer, width = 240 }: SidebarProps) {
  const {
    accentColor,
    setAccentColor,
    navigateTo,
    searchFilter,
    setSearchFilter,
    showSpaceAnalyzer,
    setShowSpaceAnalyzer,
    activeTab,
    pinnedFolderIds = [],
    recentFileIds = [],
    specialFolders = {},
    togglePinFolder,
    items,
    drives,
    driveInfos = [],
    diskSpaces,
    tagSettings,
    setTagSettings,
  } = explorer;

  // Tag settings panel state
  const [showTagSettings, setShowTagSettings] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [colorPickerAnchor, setColorPickerAnchor] = useState<DOMRect | null>(null);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const tagColorButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const t = (vi: string, en: string) => explorer.language === "vi" ? vi : en;

  const handleTagToggle = (tag: string) => {
    if (searchFilter.tag === tag) {
      setSearchFilter({ ...searchFilter, tag: null });
    } else {
      setSearchFilter({ ...searchFilter, tag });
    }
  };

  const [hoveredQA, setHoveredQA] = useState<string | null>(null);
  const { items: windowsPins, loading: windowsPinsLoading, lastSync: windowsPinsLastSync, refresh: refreshWindowsPins } = useWindowsQuickAccess(30);
  // Resolve the Windows shell icon for "This PC" so the sidebar can mirror
  // exactly what File Explorer renders (SIID_MYCOMPUTER). Falls back to a
  // Lucide `HardDrive` glyph while the IPC is in-flight or on platforms
  // where the icon cannot be resolved.
  const { dataUrl: thisPcIconUrl } = useSpecialFolderIcon("this_pc");

  // Pre-load system icons for the Quick Access folders (and Pinned Folders
  // app-pinned paths) so the sidebar shows the same icon Windows Explorer
  // would display — including the network folder icon for `\\server\share`.
  const qaPaths = windowsPins.map((p) => p.path);
  const qaIcons = useFolderIcons(qaPaths, 16);
  const pinnedIcons = useFolderIcons(pinnedFolderIds, 16);

  // Collapsible section states — default all expanded
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    quickAccess: false,
    pinnedFolders: pinnedFolderIds.length === 0,
    thisPC: false,
    recentFiles: recentFileIds.length === 0,
    filterByTag: false,
  });

  const toggleSection = (key: string) => {
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));
  };

// Drive folder-tree expansion: each expanded drive loads its top-level
// subfolders and renders them recursively underneath it (Windows Explorer's
// "expand node" behavior in the left pane).
const [expandedDrives, setExpandedDrives] = useState<Record<string, boolean>>({});
const [driveChildren, setDriveChildren] = useState<Record<string, DriveTreeChild[]>>({});
const [driveChildrenLoading, setDriveChildrenLoading] = useState<Record<string, boolean>>({});
const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
const [folderChildren, setFolderChildren] = useState<Record<string, DriveTreeChild[]>>({});
const [folderChildrenLoading, setFolderChildrenLoading] = useState<Record<string, boolean>>({});

interface DriveTreeChild {
  name: string;
  path: string;
  hasChildren: boolean;
}

const loadDirectoryChildren = useCallback(async (path: string): Promise<DriveTreeChild[]> => {
  try {
    const listing = await readDirectory(path);
    return (listing.entries || [])
      .filter((entry) => entry.is_dir)
      .map((entry) => ({
        name: entry.name,
        path: entry.path,
        hasChildren: true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}, []);

const toggleDriveExpansion = useCallback(async (drive: DriveInfo) => {
  const path = drive.path;
  const willExpand = !expandedDrives[path];
  setExpandedDrives((prev) => ({ ...prev, [path]: willExpand }));
  if (willExpand && !driveChildren[path]) {
    setDriveChildrenLoading((prev) => ({ ...prev, [path]: true }));
    const children = await loadDirectoryChildren(path);
    setDriveChildren((prev) => ({ ...prev, [path]: children }));
    setDriveChildrenLoading((prev) => ({ ...prev, [path]: false }));
  }
}, [expandedDrives, driveChildren, loadDirectoryChildren]);

const toggleFolderExpansion = useCallback(async (path: string) => {
  const willExpand = !expandedFolders[path];
  setExpandedFolders((prev) => ({ ...prev, [path]: willExpand }));
  if (willExpand && !folderChildren[path]) {
    setFolderChildrenLoading((prev) => ({ ...prev, [path]: true }));
    const children = await loadDirectoryChildren(path);
    setFolderChildren((prev) => ({ ...prev, [path]: children }));
    setFolderChildrenLoading((prev) => ({ ...prev, [path]: false }));
  }
}, [expandedFolders, folderChildren, loadDirectoryChildren]);

  return (
    <div
      className="flex flex-col h-full text-xs select-none overflow-y-auto scrollbar-thin shrink-0 transition-colors duration-200 text-stone-300"
      style={{ width }}
    >
      {/* Quick Access (synced from Windows Explorer) */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-1.5">
          <SectionHeader icon={House} title={t("Truy cập nhanh", "Quick Access")} sectionKey="quickAccess" collapsed={collapsed.quickAccess} onToggle={() => toggleSection("quickAccess")} />
          {!collapsed.quickAccess && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                refreshWindowsPins();
              }}
              disabled={windowsPinsLoading}
              className={`p-1 rounded transition cursor-pointer hover:bg-white/10 text-stone-300 ${windowsPinsLoading ? "opacity-50 cursor-wait" : ""}`}
              title={t("Đồng bộ từ Windows", "Sync from Windows Quick Access")}
            >
              <RefreshCw className={`w-3 h-3 ${windowsPinsLoading ? "animate-spin" : ""}`} />
            </button>
          )}
        </div>
        {!collapsed.quickAccess && (
          windowsPins.length === 0 ? (
            <p className="text-[10px] text-stone-500 px-3 py-1.5 italic">
              {windowsPinsLoading
                ? t("Đang tải…", "Loading…")
                : t("Chưa có mục Quick Access nào. Pin folder trong Windows Explorer → Quick Access.", "No Quick Access items. Pin a folder in Windows Explorer → Quick Access.")}
            </p>
          ) : (
            <>
              <ul className="space-y-0.5">
                {windowsPins.map((item) => {
                  const isCurrent = activeTab?.currentFolderId === item.path && !showSpaceAnalyzer;
                  const sysIconUrl = qaIcons[item.path];
                  const iconColor = "text-amber-400/70";
                  return (
                    <li key={item.path}>
                      <button
                        onClick={() => {
                          navigateTo(item.path);
                          setShowSpaceAnalyzer(false);
                        }}
                        className={`flex items-center gap-2.5 w-full pl-3 pr-2 py-1.5 text-left rounded-lg transition duration-150 cursor-pointer ${
                          isCurrent
                            ? "goku-layer-3-selected selection-item text-white font-medium"
                            : "hover:bg-white/5 hover:text-stone-100 text-stone-400"
                        }`}
                        title={`${item.name}\nPath: ${item.path}\nKind: ${item.kind}`}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          {sysIconUrl ? (
                            <img
                              src={sysIconUrl}
                              width={16}
                              height={16}
                              alt=""
                              className="shrink-0"
                              style={{ imageRendering: "pixelated" }}
                              draggable={false}
                            />
                          ) : (
                            <Folder className={`w-4 h-4 shrink-0 ${iconColor}`} />
                          )}
                          <span className="truncate text-[12px] flex-1">{item.name}</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {windowsPinsLastSync > 0 && (
                <p className="text-[9px] text-stone-500/70 px-3 mt-1.5 italic">
                  {t("Đã đồng bộ lần cuối", "Last synced")}: {(() => {
                    const seconds = Math.floor((Date.now() - windowsPinsLastSync) / 1000);
                    if (seconds < 5) return t("vừa xong", "just now");
                    if (seconds < 60) return t(`${seconds}s trước`, `${seconds}s ago`);
                    return t(`${Math.floor(seconds / 60)}m trước`, `${Math.floor(seconds / 60)}m ago`);
                  })()}
                </p>
              )}
            </>
          )
        )}
      </div>

      {/* Pinned Folders Menu */}
      <div className="p-4 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
        <SectionHeader icon={Pin} title={t("Ghim thư mục", "Pinned Folders")} sectionKey="pinnedFolders" collapsed={collapsed.pinnedFolders} onToggle={() => toggleSection("pinnedFolders")} />
        {!collapsed.pinnedFolders && (
          pinnedFolderIds.length === 0 ? (
            <p className="text-[10px] text-stone-500 px-3 py-2 italic font-sans">
              {t("Chưa ghim thư mục nào.", "No pinned folders yet.")}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {pinnedFolderIds.map((folderPath) => {
                const name = folderPath.split(/[/\\]/).pop() || folderPath;
                const isCurrent = activeTab?.currentFolderId === folderPath && !showSpaceAnalyzer;
                const isHovered = hoveredQA === folderPath;
                const sysIconUrl = pinnedIcons[folderPath];

                return (
                  <li
                    key={folderPath}
                    onMouseEnter={() => setHoveredQA(folderPath)}
                    onMouseLeave={() => setHoveredQA(null)}
                  >
                    <div className="relative group/qa flex items-center justify-between w-full">
                      <button
                        onClick={() => {
                          navigateTo(folderPath);
                          setShowSpaceAnalyzer(false);
                        }}
                        className={`flex items-center gap-2.5 w-full pl-3 pr-8 py-2 text-left rounded-lg transition duration-150 cursor-pointer ${
                          isCurrent
                            ? "goku-layer-3-selected selection-item text-white font-medium"
                            : "hover:bg-white/5 hover:text-stone-100 text-stone-400"
                        }`}
                      >
                        {sysIconUrl ? (
                          <img
                            src={sysIconUrl}
                            width={16}
                            height={16}
                            alt=""
                            className="shrink-0"
                            style={{ imageRendering: "pixelated" }}
                            draggable={false}
                          />
                        ) : (
                          <Folder className="w-4 h-4 shrink-0 text-amber-400" />
                        )}
                        <span className="truncate text-[12px]">{name}</span>
                      </button>

                      {/* Unpin Action */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (togglePinFolder) togglePinFolder(folderPath);
                        }}
                        className={`absolute right-1.5 p-1 rounded transition cursor-pointer hover:bg-white/10 text-stone-300 ${
                          isHovered ? "opacity-100" : "opacity-0 group-hover/qa:opacity-50"
                        }`}
                        title={t("Bỏ ghim", "Unpin from Pinned Folders")}
                      >
                        <Pin className="w-3 h-3 fill-orange-500/30" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        )}
      </div>

      {/* Real System Drives (This PC) — clickable root, expands to show drives.
          Matches Windows File Explorer's behavior: clicking the label opens the
          "Devices and drives" view in the main pane; clicking the chevron
          expands the tree inline in the sidebar. */}
      <div className="px-3 pb-3 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
        <div className="pt-3 px-1">
          <div className="flex items-center gap-1.5 mb-1.5">
            <button
              type="button"
              aria-label={collapsed.thisPC ? t("Mở rộng", "Expand") : t("Thu gọn", "Collapse")}
              onClick={() => toggleSection("thisPC")}
              className="shrink-0 p-0.5 -ml-1 rounded text-stone-400 hover:bg-white/10 hover:text-stone-100 cursor-pointer transition"
            >
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${collapsed.thisPC ? "" : "rotate-90"}`} />
            </button>
            <button
              type="button"
              onClick={() => {
                navigateTo("thispc://");
                setShowSpaceAnalyzer(false);
              }}
              className={`flex items-center gap-2.5 flex-1 pl-1 pr-2 py-1.5 text-left rounded-lg transition duration-150 cursor-pointer ${
                activeTab?.currentFolderId === "thispc://" && !showSpaceAnalyzer
                  ? "goku-layer-3-selected selection-item text-white font-medium"
                  : "hover:bg-white/5 text-stone-200"
              }`}
              title={t("Mở This PC (Devices and drives)", "Open This PC (Devices and drives)")}
            >
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
                    width={20}
                    height={20}
                    style={{ display: "block", imageRendering: "pixelated" }}
                    draggable={false}
                  />
                </span>
              ) : (
                <HardDrive className="w-5 h-5 shrink-0 text-sky-400/90 rounded" />
              )}
              <span className="font-medium text-[13px] truncate">
                {t("This PC", "This PC")}
              </span>
            </button>
          </div>
        </div>
        {!collapsed.thisPC && (
          <div className="space-y-1 mt-1">
            {(driveInfos.length > 0 ? driveInfos : drives.map((p) => ({
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
            }))).map((drive) => {
            const drivePath = drive.path;
            const total = drive.total > 0 ? drive.total : (diskSpaces[drivePath]?.total ?? 0);
            const used = drive.used > 0 ? drive.used : (diskSpaces[drivePath]?.used ?? 0);
            const isCurrent = activeTab?.currentFolderId === drivePath && !showSpaceAnalyzer;

            const usedPercent = total > 0 ? Math.min(Math.max((used / total) * 100, 2), 100) : 0;
            const free = total > 0 ? Math.max(total - used, 0) : 0;
            const tooltipLines = [
              drive.display,
              drive.filesystem ? `${drive.filesystem} filesystem` : null,
              drive.driveType !== "unknown" ? `Type: ${drive.driveType}` : null,
              total > 0 ? `${formatFileSize(free)} ${t("trống / free", "free")} ${t("trên tổng", "of")} ${formatFileSize(total)}` : null,
            ].filter(Boolean).join("\n");

            const isExpanded = !!expandedDrives[drivePath];
            const children = driveChildren[drivePath] || [];
            const loading = !!driveChildrenLoading[drivePath];

            return (
              <div key={drivePath}>
                <div
                  onClick={() => {
                    navigateTo(drivePath);
                    setShowSpaceAnalyzer(false);
                  }}
                  title={tooltipLines}
                  className={`group/drive relative px-2 py-1.5 rounded-md transition cursor-pointer hover:bg-white/5 ${
                    isCurrent ? "ring-1" : ""
                  }`}
                  style={isCurrent ? { ["--tw-ring-color" as string]: accentColor, borderColor: accentColor } : {}}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label={isExpanded ? t("Thu gọn", "Collapse") : t("Mở rộng", "Expand")}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleDriveExpansion(drive);
                      }}
                      className="shrink-0 p-0.5 -ml-1 rounded text-stone-400 hover:bg-white/10 hover:text-stone-100 cursor-pointer transition"
                    >
                      <ChevronRight className={`w-3.5 h-3.5 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                    </button>
                    {getDriveIcon(drive, isCurrent, accentColor)}
                    <span className="font-medium text-[12px] text-stone-200 truncate flex-1">
                      {drive.display}
                    </span>
                  </div>
                  {total > 0 && (
                    <div className="pl-6 mt-1">
                      <div className="w-full rounded-full h-1 overflow-hidden" style={{ backgroundColor: 'var(--row-bg)' }}>
                        <div
                          className="h-full rounded-full transition-all duration-300"
                          style={{
                            width: `${usedPercent}%`,
                            backgroundColor: accentColor
                          }}
                        ></div>
                      </div>
                      <div className="flex justify-between items-center text-[9px] mt-1 font-mono text-stone-500">
                        <span>{formatFileSize(free)} {t("trống", "free")}</span>
                        <span>{t("trên", "of")} {formatFileSize(total)}</span>
                      </div>
                    </div>
                  )}
                </div>

                {isExpanded && (
                  <div className="pl-6 mt-0.5">
                    {loading && (
                      <div className="text-[10px] text-stone-500 px-2 py-1">{t("Đang tải…", "Loading…")}</div>
                    )}
                    {!loading && children.length === 0 && (
                      <div className="text-[10px] text-stone-500 px-2 py-1">{t("Không có folder", "No folders")}</div>
                    )}
                    {!loading && children.map((child) => {
                      const childIsExpanded = !!expandedFolders[child.path];
                      const childChildren = folderChildren[child.path] || [];
                      const childLoading = !!folderChildrenLoading[child.path];
                      const isChildCurrent = activeTab?.currentFolderId === child.path && !showSpaceAnalyzer;
                      return (
                        <div key={child.path}>
                          <div
                            onClick={() => navigateTo(child.path)}
                            title={child.name}
                            className={`group/fd flex items-center gap-1.5 px-2 py-1 rounded transition cursor-pointer hover:bg-white/5 ${
                              isChildCurrent ? "ring-1" : ""
                            }`}
                            style={isChildCurrent ? { ["--tw-ring-color" as string]: accentColor, borderColor: accentColor } : {}}
                          >
                            <button
                              type="button"
                              aria-label={childIsExpanded ? t("Thu gọn", "Collapse") : t("Mở rộng", "Expand")}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                toggleFolderExpansion(child.path);
                              }}
                              className="shrink-0 p-0.5 -ml-0.5 rounded text-stone-400 hover:bg-white/10 hover:text-stone-100 cursor-pointer transition"
                            >
                              <ChevronRight className={`w-3 h-3 transition-transform ${childIsExpanded ? "rotate-90" : ""}`} />
                            </button>
                            <WindowsFolder path={child.path} size={18} className="shrink-0 object-contain" />
                            <span className="text-[12px] text-stone-200 truncate">{child.name}</span>
                          </div>
                          {childIsExpanded && (
                            <div className="pl-4">
                              {childLoading && (
                                <div className="text-[10px] text-stone-500 px-2 py-1">{t("Đang tải…", "Loading…")}</div>
                              )}
                              {!childLoading && childChildren.length === 0 && (
                                <div className="text-[10px] text-stone-500 px-2 py-1">{t("Trống", "Empty")}</div>
                              )}
                              {!childLoading && childChildren.map((sub) => {
                                const subCurrent = activeTab?.currentFolderId === sub.path && !showSpaceAnalyzer;
                                return (
                                  <div
                                    key={sub.path}
                                    onClick={() => navigateTo(sub.path)}
                                    title={sub.name}
                                    className={`group/fd2 flex items-center gap-1.5 px-2 py-1 rounded transition cursor-pointer hover:bg-white/5 ${
                                      subCurrent ? "ring-1" : ""
                                    }`}
                                    style={subCurrent ? { ["--tw-ring-color" as string]: accentColor, borderColor: accentColor } : {}}
                                  >
                                    <WindowsFolder path={sub.path} size={16} className="shrink-0 object-contain" />
                                    <span className="text-[12px] text-stone-300 truncate">{sub.name}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          </div>
        )}
      </div>

      {/* Recent Files listing */}
      {recentFileIds.length > 0 && (
        <div className="p-4 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
          <SectionHeader icon={Clock} title={t("Tệp mở gần đây", "Recent Files")} sectionKey="recentFiles" collapsed={collapsed.recentFiles} onToggle={() => toggleSection("recentFiles")} />
          {!collapsed.recentFiles && (
            <ul className="space-y-0.5">
              {recentFileIds.slice(0, 5).map((filePath) => {
                const name = filePath.split(/[/\\]/).pop() || filePath;
                const ext = name.split('.').pop()?.toLowerCase() || "";
                const isTextFile = /\.(json|txt|md|html|css|js|ts|tsx|sh|csv|log|xml|yaml|yml|env|py|rs|go|java|c|cpp|h|hpp|php|rb|swift|kt)$/i.test(name);
                return (
                  <li key={filePath}>
                    <button
                      onClick={() => {
                        if (isTextFile) {
                          explorer.setOpenFileId?.(filePath);
                        }
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-1.5 rounded-lg text-left text-[11px] truncate transition cursor-pointer hover:bg-white/5 text-stone-400 hover:text-stone-100"
                      title={filePath}
                    >
                      <File className="w-3.5 h-3.5 shrink-0 text-orange-400/70" />
                      <span className="truncate">{name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Advanced Tag Categorization Filters */}
      <div className="p-4 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
          <SectionHeader
            icon={Tag}
            title={t("Lọc bằng Nhãn", "Filter by Tag")}
            sectionKey="filterByTag"
            collapsed={collapsed.filterByTag}
            onToggle={() => toggleSection("filterByTag")}
            extra={
              <div className="flex items-center gap-0.5">
                {searchFilter.tag ? (
                  <button
                    onClick={() => setSearchFilter({ ...searchFilter, tag: null })}
                    className="text-[9px] text-stone-500 hover:text-stone-350 cursor-pointer hover:underline mr-1"
                  >
                    {t("Làm sạch", "Clear")}
                  </button>
                ) : null}
                <button
                  onClick={() => setShowTagSettings(true)}
                  className="p-0.5 rounded transition cursor-pointer hover:bg-white/10 text-stone-400"
                  title={t("Cài đặt Priority Tag", "Tag Settings")}
                >
                  <Settings className="w-3.5 h-3.5" />
                </button>
              </div>
            }
          />
        {!collapsed.filterByTag && (
          <div className="flex flex-wrap gap-1.5 px-2">
            {explorer.tagSettings.map((tg) => {
              const isFiltered = searchFilter.tag === tg.id;
              const colorOpacity = isFiltered ? 0.3 : 0.2;
              const textOpacity = isFiltered ? 1 : 0.8;
              return (
                <button
                  key={tg.id}
                  onClick={() => handleTagToggle(tg.id)}
                  className="px-2 py-1 rounded-full text-[10px] border transition cursor-pointer hover:opacity-100"
                  style={{
                    backgroundColor: `${tg.color}${Math.round(colorOpacity * 255).toString(16).padStart(2, '0')}`,
                    color: tg.color,
                    borderColor: `${tg.color}50`,
                    opacity: isFiltered ? 1 : 0.8,
                    transform: isFiltered ? "scale(1.05)" : "scale(1)",
                    outline: isFiltered ? `2px solid ${tg.color}66` : "none",
                    outlineOffset: "1px",
                  }}
                >
                  <span>{getTagTranslation(tg.id, explorer.language, explorer.tagSettings)}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Tag Settings Panel */}
        {showTagSettings && (
          <div
            className="fixed rounded-2xl p-4 min-w-[300px] text-left animate-in duration-100 fade-in z-[9999] fluent-menu"
            style={{
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              backgroundColor: "var(--surface-bg)",
              border: "1px solid var(--stroke-1)",
            }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3 border-b pb-1.5" style={{ borderColor: "var(--stroke-1)" }}>
              <span className="font-semibold font-mono uppercase text-xs" style={{ color: "var(--fg-1)" }}>
                {t("Cài đặt Priority Tag", "Priority Tag Settings")}
              </span>
              <button
                onClick={() => setShowTagSettings(false)}
                className="w-5 h-5 flex items-center justify-center rounded cursor-pointer transition hover:bg-white/10"
                style={{ color: "var(--fg-2)" }}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex flex-col gap-3 max-h-[400px] overflow-y-auto">
              {explorer.tagSettings.map((tag) => (
                <div key={tag.id} className="flex flex-col gap-1.5 p-2 rounded-lg" style={{ backgroundColor: "var(--row-bg)" }}>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-medium" style={{ color: tag.color }}>
                      {getTagTranslation(tag.id, explorer.language, explorer.tagSettings)}
                    </span>
                    <button
                      ref={(el) => { tagColorButtonRefs.current[tag.id] = el; }}
                      type="button"
                      onClick={(e) => {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setColorPickerAnchor({ ...rect, right: rect.right, left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } as DOMRect);
                        setEditingTagId(tag.id);
                        setShowColorPicker(true);
                      }}
                      className="w-[18px] h-[18px] rounded-full border transition-all duration-150 transform hover:scale-110 cursor-pointer"
                      style={{
                        backgroundColor: tag.color,
                        borderColor: "var(--stroke-1)",
                      }}
                      title={t("Đổi màu", "Change color")}
                    />
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={tag.nameEn}
                      onChange={(e) => {
                        const updated = explorer.tagSettings.map(t =>
                          t.id === tag.id ? { ...t, nameEn: e.target.value } : t
                        );
                        explorer.setTagSettings(updated);
                      }}
                      placeholder="English"
                      className="flex-1 text-[10.5px] px-2 py-1 rounded border outline-none"
                      style={{
                        backgroundColor: "var(--surface-bg)",
                        color: "var(--fg-1)",
                        borderColor: "var(--stroke-1)",
                      }}
                    />
                    <input
                      type="text"
                      value={tag.nameVi}
                      onChange={(e) => {
                        const updated = explorer.tagSettings.map(t =>
                          t.id === tag.id ? { ...t, nameVi: e.target.value } : t
                        );
                        explorer.setTagSettings(updated);
                      }}
                      placeholder="Tiếng Việt"
                      className="flex-1 text-[10.5px] px-2 py-1 rounded border outline-none"
                      style={{
                        backgroundColor: "var(--surface-bg)",
                        color: "var(--fg-1)",
                        borderColor: "var(--stroke-1)",
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Color Picker Portal */}
        {showColorPicker && colorPickerAnchor && editingTagId && createPortal(
          <ColorPicker
            value={explorer.tagSettings.find(t => t.id === editingTagId)?.color || "#3b82f6"}
            onChange={(color) => {
              const updated = explorer.tagSettings.map(t =>
                t.id === editingTagId ? { ...t, color } : t
              );
              explorer.setTagSettings(updated);
            }}
            onClose={() => {
              setShowColorPicker(false);
              setEditingTagId(null);
            }}
            language={explorer.language}
            accentColor={explorer.accentColor}
            theme={explorer.theme === "light" ? "light" : explorer.theme === "mono" ? "mono" : "dark"}
            anchorRect={colorPickerAnchor}
            triggerRef={{ current: tagColorButtonRefs.current[editingTagId] || null } as React.RefObject<HTMLElement | null>}
          />,
          document.body
        )}
      </div>
    </div>
  );
}
