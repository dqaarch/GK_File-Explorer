import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ExplorerAPI } from "../useExplorer";
import { FSItem, getTagTranslation, ViewMode, VIEW_MODE_LABELS, VIEW_MODE_MIN, VIEW_MODE_MAX } from "../types";
import { registerHoverPane } from "../utils/hoverPane";
import { getTextPreview, TextPreviewResult, listRarEntries, listZipEntries, ArchiveEntry, ArchiveListing } from "../TauriFileSystem";
import { detectMediaType } from "../utils/fileTypeDetector";
import { normalizeThumbnailSrc } from "../utils/thumbnail";
import { getThumbs, subscribeThumbs } from "../contexts/thumbnailsStore";
import { useFileFingerprint } from "../hooks/useFileFingerprint";
import { useFolderSizes } from "../hooks/useFolderSizes";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import {
  FileText, Calendar, Database, HardDrive, AlertCircle,
  HelpCircle, Tag, Loader2, ArrowRightLeft, Trash2, LineChart, Code, Folder, Info, FileImage, Play, Music, Box, Archive, File, AppWindow, ChevronDown, ChevronRight, LayoutGrid, LayoutList, Check, Search, LockKeyhole, RefreshCw, Home, PackageOpen
} from "lucide-react";
import AudioPlayerPreview from "./AudioPlayerPreview";
import VideoPlayerPreview from "./VideoPlayerPreview";
import ThreeDModelViewer from "./3DModelViewer";
import ImageSequencePreview from "./ImageSequencePreview";
import EXRSequencePlayer from "./exrPlayerV2/ExrPlayer";
import PDFPreview from "./PDFPreview";
import DOCPreview from "./DOCPreview";
import DOCXPreview from "./DOCXPreview";
import XLSPreview from "./XLSPreview";
import XLSXPreview from "./XLSXPreview";
import PPTPreview from "./PPTPreview";
import PPTXPreview from "./PPTXPreview";
import EPUBPreview from "./EPUBPreview";
import FontPreview from "./FontPreview";
import { dbg } from "../utils/debug";

interface DetailsPaneProps {
  explorer: ExplorerAPI;
  width?: number;
}

/**
 * Small dropdown that lets the user change the Inspector's view mode.
 * Mirrors the look & feel of the Header's "View Mode" dropdown so both
 * controls stay in sync visually and behaviourally — same options, same
 * slider, same accent color.
 *
 * State is local to this component and does NOT affect the main Explorer.
 */
function FolderInspectorView({ explorer }: { explorer: ExplorerAPI }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const sliderDraggingRef = useRef(false);
  const [localSlider, setLocalSlider] = useState<number | null>(null);
  // Inspector has its OWN view mode - changes here do not affect the main explorer
  // Default: Medium icons (value 3) for first-time users
  const [inspectorViewMode, setInspectorViewMode] = useState<number>(() => {
    const saved = localStorage.getItem("NEXUS_INSPECTOR_VIEW_MODE");
    return saved ? parseInt(saved) || 3 : 3;
  });

  const t = (vi: string, en: string) => (explorer.language === "vi" ? vi : en);
  const vm = inspectorViewMode;
  const liveVm = localSlider ?? vm;
  const currentLabel =
    VIEW_MODE_LABELS.find((entry) => entry.value === vm) ?? VIEW_MODE_LABELS[2];

  // Persist inspector view mode changes
  const handleInspectorViewModeChange = useCallback((mode: number) => {
    setInspectorViewMode(mode);
    localStorage.setItem("NEXUS_INSPECTOR_VIEW_MODE", String(mode));
  }, []);

  // Register this dropdown as the "folder-inspector" pane for any future
  // dispatch needs. Ctrl+Scroll in Folder Inspector is intentionally
  // disabled — only the dropdown click changes its view mode.
  useEffect(() => {
    if (!wrapperRef.current) return;
    return registerHoverPane(wrapperRef.current, "folder-inspector");
  }, []);

  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((prev) => !prev)}
        title={t("Đổi chế độ xem của thư mục", "Change folder view mode")}
        className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-white/5 transition cursor-pointer text-stone-300 hover:text-white"
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
          className="absolute right-0 top-full mt-1.5 fluent-menu rounded-xl z-[600] flex flex-col text-xs animate-in fade-in duration-100 text-stone-200"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* Top: 7 view-mode items + vertical slider, exactly like the Header */}
          <div className="flex items-stretch">
            <div className="py-1 min-w-[220px] flex-1">
              {VIEW_MODE_LABELS.map(({ value, vi, en, group }) => (
                <button
                  key={value}
                  onClick={() => {
                    handleInspectorViewModeChange(value);
                    setOpen(false);
                  }}
                  className="flex items-center justify-between w-full px-4 py-2 cursor-pointer transition hover:bg-white/5 text-stone-200"
                >
                  <div className="flex items-center gap-2">
                    {group === "list" ? (
                      <LayoutList className="w-3.5 h-3.5 text-sky-400" />
                    ) : (
                      <LayoutGrid className="w-3.5 h-3.5 text-orange-400" />
                    )}
                    <span>{t(vi, en)}</span>
                  </div>
                  {vm === value && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                </button>
              ))}
            </div>

            <div className="w-px shrink-0" style={{ backgroundColor: "rgba(255,255,255,0.08)" }} />

            <div
              className="flex items-center justify-center px-2 select-none shrink-0"
              style={{ minHeight: "232px" }}
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
                value={liveVm}
                onMouseDown={() => {
                  sliderDraggingRef.current = true;
                  setLocalSlider(vm);
                }}
                onInput={(e) => {
                  const val = parseFloat(e.currentTarget.value);
                  setLocalSlider(val);
                  handleInspectorViewModeChange(val);
                }}
                onMouseUp={(e) => {
                  sliderDraggingRef.current = false;
                  setLocalSlider(null);
                }}
                onMouseLeave={(e) => {
                  if (sliderDraggingRef.current) {
                    sliderDraggingRef.current = false;
                    setLocalSlider(null);
                  }
                }}
                onTouchStart={() => {
                  sliderDraggingRef.current = true;
                  setLocalSlider(vm);
                }}
                onTouchEnd={() => {
                  sliderDraggingRef.current = false;
                  setLocalSlider(null);
                }}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className="view-slider-v-minimal cursor-pointer"
                style={{ accentColor: explorer.accentColor }}
                aria-label="View mode slider"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const CODE_VIEWER_LANGUAGE_MAP: Record<string, string> = {
  c: "c",
  css: "css",
  cpp: "cpp",
  csv: "plaintext",
  env: "bash",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "xml",
  java: "java",
  js: "javascript",
  json: "json",
  kt: "kotlin",
  lnk: "plaintext",
  log: "plaintext",
  md: "markdown",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  swift: "swift",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatArchiveBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, unitIndex);
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function getArchiveEntryIcon(entry: ArchiveEntry): React.ReactNode {
  if (entry.isDirectory) {
    return <Folder className="w-4 h-4 text-amber-400" fill="currentColor" />;
  }

  const extension = entry.extension || "";
  if (/^(png|jpe?g|gif|webp|bmp|tiff?|tga|exr|svg)$/.test(extension)) {
    return <FileImage className="w-4 h-4 text-emerald-400" />;
  }
  if (/^(mp4|mov|avi|mkv|webm|m4v)$/.test(extension)) {
    return <Play className="w-4 h-4 text-rose-400" />;
  }
  if (/^(mp3|wav|ogg|flac|m4a|aac)$/.test(extension)) {
    return <Music className="w-4 h-4 text-sky-400" />;
  }
  if (/^(zip|rar|7z|tar|gz|bz2|xz)$/.test(extension)) {
    return <Archive className="w-4 h-4 text-orange-400" />;
  }
  if (/^(txt|md|json|xml|csv|log|js|ts|tsx|jsx|css|html|py|rs|cpp|h|pdf|docx?|xlsx?|pptx?)$/.test(extension)) {
    return <FileText className="w-4 h-4 text-violet-400" />;
  }
  return <File className="w-4 h-4 text-stone-400" />;
}

interface ArchivePreviewProps {
  fileName: string;
  filePath: string;
  accentColor: string;
  language: "vi" | "en";
  fileFingerprint: string;
  format: ArchiveListing["format"];
}

function ArchivePreview({ fileName, filePath, accentColor, language, fileFingerprint, format }: ArchivePreviewProps) {
  const [listing, setListing] = useState<ArchiveListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [query, setQuery] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [selectedEntryPath, setSelectedEntryPath] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const t = useCallback((vi: string, en: string) => (language === "vi" ? vi : en), [language]);
  const isRarArchive = format === "rar";
  const supportsPassword = isRarArchive;
  const formatLabel = isRarArchive ? "RAR Archive" : "ZIP Archive";
  const formatLabelVi = isRarArchive ? "Kho RAR" : "Kho ZIP";

  const loadArchive = useCallback(async (archivePassword?: string) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const result = format === "zip"
        ? await listZipEntries(filePath)
        : await listRarEntries(filePath, archivePassword);
      if (requestId !== requestIdRef.current) return;
      setListing(result);
      setShowPassword(false);
      setPassword("");
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setListing(null);
      setError(String(loadError));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [filePath, format]);

  useEffect(() => {
    setCurrentPath("");
    setQuery("");
    setPassword("");
    setShowPassword(false);
    setSelectedEntryPath(null);
    void loadArchive();
    return () => {
      requestIdRef.current += 1;
    };
  }, [filePath, fileFingerprint, format, loadArchive]);

  const visibleEntries = useMemo(() => {
    if (!listing) return [] as ArchiveEntry[];
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery) {
      return listing.entries
        .filter((entry) => entry.path.toLocaleLowerCase().includes(normalizedQuery))
        .slice(0, 2_000)
        .sort((left, right) => {
          if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
          return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" });
        });
    }

    const rows = new Map<string, ArchiveEntry>();
    const prefix = currentPath ? `${currentPath}/` : "";

    for (const entry of listing.entries) {
      if (currentPath && !entry.path.startsWith(prefix)) continue;
      const relativePath = currentPath ? entry.path.slice(prefix.length) : entry.path;
      if (!relativePath) continue;

      const slashIndex = relativePath.indexOf("/");
      if (slashIndex === -1) {
        rows.set(entry.path, entry);
        continue;
      }

      const childName = relativePath.slice(0, slashIndex);
      const childPath = prefix + childName;
      if (!rows.has(childPath)) {
        rows.set(childPath, {
          path: childPath,
          name: childName,
          parentPath: currentPath,
          extension: null,
          unpackedSize: 0,
          modified: null,
          isDirectory: true,
          isEncrypted: false,
          isSplit: false,
        });
      }
    }

    return Array.from(rows.values()).sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    });
  }, [listing, currentPath, query]);

  const selectedEntry = useMemo(
    () => listing?.entries.find((entry) => entry.path === selectedEntryPath) || null,
    [listing, selectedEntryPath]
  );

  const breadcrumbParts = currentPath ? currentPath.split("/") : [];
  const errorSuggestsPassword = /password|encrypted|encrypt|crypt|header/i.test(error || "");

  const openEntry = (entry: ArchiveEntry) => {
    if (entry.isDirectory) {
      setCurrentPath(entry.path);
      setQuery("");
      setSelectedEntryPath(null);
    } else {
      setSelectedEntryPath(entry.path);
    }
  };

  const submitPassword = (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) return;
    void loadArchive(password);
  };

  return (
    <div className="w-full h-full min-h-0 flex flex-col" style={{ backgroundColor: "var(--app-bg)" }}>
      <div className="px-3 py-2.5 border-b shrink-0" style={{ backgroundColor: "var(--header-bg)", borderColor: "var(--stroke-1)" }}>
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: `${accentColor}20`, color: accentColor }}>
            <PackageOpen className="w-4.5 h-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold text-stone-200 truncate" title={fileName}>{fileName}</div>
            <div className="text-[9px] uppercase tracking-[0.14em] text-stone-500">{t(formatLabelVi, formatLabel)}</div>
          </div>
          <button
            type="button"
            onClick={() => void loadArchive()}
            disabled={loading}
            className="p-1.5 rounded-md text-stone-500 hover:text-stone-200 hover:bg-white/5 disabled:opacity-40 transition-colors"
            title={t("Đọc lại archive", "Reload archive")}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          {supportsPassword && (
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="p-1.5 rounded-md text-stone-500 hover:text-stone-200 hover:bg-white/5 transition-colors"
              title={t("Nhập mật khẩu archive", "Enter archive password")}
            >
              <LockKeyhole className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {listing && (
          <div className="flex items-center gap-2 mt-2 text-[9px] text-stone-500 font-mono overflow-hidden">
            <span className="shrink-0">{listing.totalFiles.toLocaleString()} {t("tệp", "files")}</span>
            <span className="text-stone-700">•</span>
            <span className="shrink-0">{formatArchiveBytes(listing.totalUnpackedSize)}</span>
            {listing.hasEncryptedEntries && (
              <>
                <span className="text-stone-700">•</span>
                <span className="flex items-center gap-1 text-amber-400 shrink-0"><LockKeyhole className="w-2.5 h-2.5" />{t("Mã hóa", "Encrypted")}</span>
              </>
            )}
            {listing.isMultipart && <span className="px-1.5 py-0.5 rounded bg-white/5 text-stone-400 shrink-0">MULTIPART</span>}
          </div>
        )}
      </div>

      {supportsPassword && (showPassword || errorSuggestsPassword) && (
        <form onSubmit={submitPassword} className="flex items-center gap-2 px-3 py-2 border-b shrink-0" style={{ borderColor: "var(--stroke-1)" }}>
          <LockKeyhole className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
            autoComplete="off"
            placeholder={t("Mật khẩu RAR", "RAR password")}
            className="min-w-0 flex-1 bg-black/20 border border-white/10 rounded-md px-2 py-1.5 text-[10px] text-stone-200 outline-none focus:border-white/20"
          />
          <button
            type="submit"
            disabled={!password || loading}
            className="px-2.5 py-1.5 rounded-md text-[9px] font-semibold disabled:opacity-40"
            style={{ backgroundColor: `${accentColor}25`, color: accentColor }}
          >
            {t("Mở", "Open")}
          </button>
        </form>
      )}

      {listing && (
        <div className="px-3 py-2 border-b shrink-0 space-y-2" style={{ borderColor: "var(--stroke-1)" }}>
          <div className="flex items-center gap-1 min-w-0 overflow-x-auto no-scrollbar">
            <button
              type="button"
              onClick={() => { setCurrentPath(""); setQuery(""); }}
              className="p-1 rounded text-stone-500 hover:text-stone-200 hover:bg-white/5 shrink-0"
              title={t("Thư mục gốc", "Archive root")}
            >
              <Home className="w-3.5 h-3.5" />
            </button>
            {breadcrumbParts.map((part, index) => {
              const targetPath = breadcrumbParts.slice(0, index + 1).join("/");
              return (
                <React.Fragment key={targetPath}>
                  <ChevronRight className="w-3 h-3 text-stone-700 shrink-0" />
                  <button
                    type="button"
                    onClick={() => { setCurrentPath(targetPath); setQuery(""); }}
                    className="max-w-[120px] truncate px-1.5 py-1 rounded text-[9px] text-stone-400 hover:text-stone-200 hover:bg-white/5 shrink-0"
                    title={targetPath}
                  >
                    {part}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
          <label className="flex items-center gap-2 rounded-md border border-white/8 bg-black/15 px-2 py-1.5 focus-within:border-white/15">
            <Search className="w-3.5 h-3.5 text-stone-600 shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Tìm trong archive...", "Search in archive...")}
              className="min-w-0 flex-1 bg-transparent outline-none text-[10px] text-stone-300 placeholder:text-stone-600"
            />
            {query && <span className="text-[8px] text-stone-600">{visibleEntries.length}</span>}
          </label>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
        {loading && (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-stone-500">
            <Loader2 className="w-7 h-7 animate-spin" style={{ color: accentColor }} />
            <span className="text-[10px]">{isRarArchive
              ? t("Đang đọc nội dung RAR...", "Reading RAR contents...")
              : t("Đang đọc nội dung ZIP...", "Reading ZIP contents...")}</span>
          </div>
        )}

        {!loading && error && (
          <div className="h-full flex flex-col items-center justify-center text-center px-5 py-8">
            <AlertCircle className="w-9 h-9 text-red-400/70 mb-3" />
            <div className="text-[11px] font-semibold text-stone-300">{t("Không thể đọc archive", "Unable to read archive")}</div>
            <div className="text-[9px] leading-relaxed text-stone-500 mt-1.5 max-w-[320px] break-words">{error}</div>
            <div className="flex items-center gap-2 mt-4">
              <button type="button" onClick={() => void loadArchive()} className="px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-[9px] text-stone-300">
                {t("Thử lại", "Retry")}
              </button>
              {!errorSuggestsPassword && (
                <button type="button" onClick={() => setShowPassword(true)} className="px-3 py-1.5 rounded-md text-[9px]" style={{ backgroundColor: `${accentColor}20`, color: accentColor }}>
                  {t("Dùng mật khẩu", "Use password")}
                </button>
              )}
            </div>
          </div>
        )}

        {!loading && listing && visibleEntries.map((entry) => {
          const isSelected = selectedEntryPath === entry.path;
          return (
            <button
              type="button"
              key={entry.path}
              onClick={() => openEntry(entry)}
              className="w-full grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-center px-3 py-2 border-b text-left transition-colors hover:bg-white/[0.035]"
              style={{
                borderColor: "rgba(255,255,255,0.035)",
                backgroundColor: isSelected ? `${accentColor}16` : undefined,
              }}
              title={entry.path}
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className="shrink-0">{getArchiveEntryIcon(entry)}</span>
                <span className="min-w-0">
                  <span className="block text-[10px] text-stone-300 truncate">{query ? entry.path : entry.name}</span>
                  {(entry.isEncrypted || entry.isSplit) && (
                    <span className="flex items-center gap-1.5 mt-0.5 text-[8px] uppercase tracking-wider text-stone-600">
                      {entry.isEncrypted && <span className="text-amber-500">{t("Mã hóa", "Encrypted")}</span>}
                      {entry.isSplit && <span>{t("Nhiều phần", "Split")}</span>}
                    </span>
                  )}
                </span>
              </span>
              <span className="flex items-center gap-1.5 shrink-0 text-[9px] font-mono text-stone-600">
                {!entry.isDirectory && formatArchiveBytes(entry.unpackedSize)}
                {entry.isDirectory && <ChevronRight className="w-3 h-3" />}
              </span>
            </button>
          );
        })}

        {!loading && listing && visibleEntries.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-stone-600 gap-2 px-5 text-center">
            <PackageOpen className="w-8 h-8 opacity-40" />
            <span className="text-[10px]">{query ? t("Không tìm thấy entry phù hợp", "No matching archive entries") : t("Thư mục này trống", "This archive folder is empty")}</span>
          </div>
        )}
      </div>

      {listing && (
        <div className="px-3 py-2 border-t shrink-0 text-[8.5px] text-stone-600 flex items-center gap-2 min-w-0" style={{ borderColor: "var(--stroke-1)" }}>
          {selectedEntry ? (
            <>
              <span className="truncate flex-1" title={selectedEntry.path}>{selectedEntry.path}</span>
              {selectedEntry.modified && <span className="shrink-0">{new Date(selectedEntry.modified).toLocaleDateString(language === "vi" ? "vi-VN" : "en-US")}</span>}
            </>
          ) : (
            <>
              <span className="truncate flex-1">{query ? t("Kết quả tìm kiếm", "Search results") : currentPath || t("Thư mục gốc", "Archive root")}</span>
              <span className="shrink-0">{visibleEntries.length.toLocaleString()} {t("mục", "items")}</span>
            </>
          )}
          {listing.truncated && <span className="text-amber-500 shrink-0" title={`${listing.entryLimit.toLocaleString()} entry limit`}>{t("Đã giới hạn", "Limited")}</span>}
        </div>
      )}
    </div>
  );
}

export const ExplorerDetailsPane = React.memo(function ExplorerDetailsPane({ explorer, width = 280 }: DetailsPaneProps) {
  const {
    items,
    selectedIds,
    accentColor,
    deleteItem,
    updateFileContent,
    activeTab,
    tabs,
    activeTabId,
    searchResults,
    searchFilter,
    showFolderSizes,
  } = explorer;

  // Thumbnails from global store (shared with ExplorerMainPane)
  const [thumbs, setThumbs] = useState<Record<string, string | null>>(() => getThumbs());

  // ── Inspector children selection ─────────────────────────────────────────────
  // The Folder Inspector shows a *different folder* than the MainPane's
  // currentPath, so we cannot reuse the per-tab `selectedIds`. The codebase
  // already exposes a per-pane selection slot on `paneSession` — we read
  // and write it through `setPaneSession` (already wired up in useExplorer).
  // App.tsx's Delete handler reads the same `paneSession.inspectorSelectedIds`
  // and prefers it over `selectedIds`, so clicking a child inside the
  // inspector and pressing Delete deletes exactly that child.
  const { paneSession, setPaneSession } = explorer;
  const inspectorSelectedIds = paneSession.inspectorSelectedIds;

  // Reset inspector selection whenever the inspected folder changes (so
  // old selections don't bleed into a newly-opened folder).
  useEffect(() => {
    setPaneSession((prev) =>
      prev.inspectorSelectedIds.length === 0
        ? prev
        : { ...prev, inspectorSelectedIds: [] }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds[0]]);

  // Esc clears the inspector's child selection. The actual Delete /
  // Shift+Delete handling lives in App.tsx — its handler prefers
  // `paneSession.inspectorSelectedIds` over `selectedIds`.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) {
        return;
      }
      const root = panelRef.current;
      if (!root || !root.contains(active)) return;
      setPaneSession((prev) =>
        prev.inspectorSelectedIds.length > 0
          ? { ...prev, inspectorSelectedIds: [] }
          : prev
      );
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [setPaneSession]);

  const toggleInspectorSelection = useCallback((childId: string, additive: boolean) => {
    setPaneSession((prev) => {
      const cur = prev.inspectorSelectedIds;
      if (additive) {
        const next = cur.includes(childId)
          ? cur.filter((id) => id !== childId)
          : [...cur, childId];
        return { ...prev, inspectorSelectedIds: next };
      }
      const next = cur[0] === childId && cur.length === 1 ? [] : [childId];
      return { ...prev, inspectorSelectedIds: next };
    });
  }, [setPaneSession]);

  // Subscribe to global thumbs updates
  useEffect(() => {
    const unsubscribe = subscribeThumbs(setThumbs);
    return unsubscribe;
  }, []);

  // Folder size calculator
  const { sizes: folderSizes, getFolderSize } = useFolderSizes();

  // Format bytes to human-readable size
  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  // Trigger folder size calculation when a directory is selected
  useEffect(() => {
    const firstId = selectedIds[0];
    if (!firstId) return;

    const normalizedId = firstId.replace(/\\/g, "/");
    const isSearch = Boolean(searchFilter.query.trim());
    const item = items.find(i => i.id.replace(/\\/g, "/") === normalizedId)
      ?? (isSearch ? searchResults.find(i => i.id.replace(/\\/g, "/") === normalizedId) : null);

    if (item && item.type === "directory") {
      getFolderSize(item.id);
    }
  }, [selectedIds[0], items, searchResults, searchFilter]);

  // selectedIds already comes from activeTab.selectedIds (per-tab)
  // items already comes from activeTab.folderContents (per-tab, via displayItems)
  const isSearchMode = Boolean(searchFilter.query.trim());
  const normalizedFirstId = selectedIds[0]?.replace(/\\/g, "/") ?? null;
  // Memoize selectedItem so its reference is stable across renders — the
  // preview children (e.g. VideoPlayerPreview) take `path` from it via
  // `previewItem`, and a new reference here would be cheap but combined
  // with React 18's stricter concurrent rendering can occasionally push
  // hooks over the update-depth limit when downstream consumers
  // (useEffect deps, key={...}, useMemo deps) see a "different" object.
  const selectedItem = useMemo(() => {
    if (selectedIds.length === 0) return null;
    return items.find((i) => i.id.replace(/\\/g, "/") === normalizedFirstId)
      ?? (isSearchMode ? searchResults.find((i) => i.id.replace(/\\/g, "/") === normalizedFirstId) : null)
      ?? null;
  }, [selectedIds, items, searchResults, normalizedFirstId, isSearchMode]);

  // Content-aware fingerprint for the selected file: changes when the file's
  // mtime/size change so the preview component is force-re-mounted when the
  // file is replaced in place. Must be called unconditionally (before any
  // early returns below) to keep React's hook order stable.
  // Normalize path to forward slashes for consistent hash key matching.
  const fileFingerprint = useFileFingerprint(selectedItem?.path?.replace(/\\/g, "/"));

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [textPreview, setTextPreview] = useState<TextPreviewResult | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [focusViewState, setFocusViewState] = useState<{
    type: 'video' | 'image' | 'seq';
    fileName: string;
    filePath?: string;
    isEXR?: boolean;
    isSequence?: boolean;
  } | null>(null);
  
  // Resizable panel state
  const [splitPosition, setSplitPosition] = useState(64); // percentage for top section
  const [isResizing, setIsResizing] = useState(false);
  const [isDescExpanded, setIsDescExpanded] = useState(false); // Description panel collapsed by default
  const panelRef = useRef<HTMLDivElement>(null);

  // Map classify tag to a header tint (background + border).
  // Returns null when no tag is set, in which case the caller should fall
  // back to the default theme colors (preserves prior look).
  const getTagHeaderStyle = (tag: string | undefined): { bg: string; border: string; text: string; dot: string } | null => {
    if (!tag) return null;
    switch (tag) {
      case "Warning": return { bg: "bg-red-500/15", border: "border-red-500/30", text: "text-red-400", dot: "bg-red-500" };
      case "WIP": return { bg: "bg-blue-500/15", border: "border-blue-500/30", text: "text-blue-400", dot: "bg-blue-500" };
      case "Deliverable": return { bg: "bg-emerald-500/15", border: "border-emerald-500/30", text: "text-emerald-400", dot: "bg-emerald-500" };
      case "Archived": return { bg: "bg-amber-500/15", border: "border-amber-500/30", text: "text-amber-400", dot: "bg-amber-500" };
      case "Draft": return { bg: "bg-purple-500/15", border: "border-purple-500/30", text: "text-purple-400", dot: "bg-purple-500" };
      default: return null;
    }
  };

  const closeFocusView = () => setFocusViewState(null);

  // Keyboard shortcut: Esc to close focus view
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && focusViewState) {
        closeFocusView();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focusViewState]);

  // Ctrl+R / F5 / Ctrl+Shift+R are intentionally NOT handled here. The
  // Tauri's WebView2 will perform a full page reload (re-running main.tsx,
  // re-mounting all preview components) which is the behaviour the user
  // expects — and which is finally possible after we set
  // `Flags::empty()` on `tauri-plugin-prevent-default` in main.rs.

  // Resize handling
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panelRef.current) return;
      const rect = panelRef.current.getBoundingClientRect();
      const newPosition = ((e.clientY - rect.top) / rect.height) * 100;
      // Clamp between 30% and 85%
      setSplitPosition(Math.max(30, Math.min(85, newPosition)));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  // Read tag from localStorage
  const storedTags: Record<string, string> = (() => {
    const s = localStorage.getItem("NEXUS_ITEM_TAGS");
    return s ? JSON.parse(s) : {};
  })();
  const currentTag = selectedItem ? storedTags[selectedItem.id] : undefined;

  // Reset preview state when selection changes
  useEffect(() => {
    setErrorMsg(null);
    setTextPreview(null);
  }, [selectedIds[0]]);

  // Load file content when selected item changes (for text and office files)
  useEffect(() => {
    if (!selectedItem || selectedItem.type === "directory") {
      setTextPreview(null);
      return;
    }

    const isTextFile = /\.(json|txt|md|lnk|html|css|js|ts|tsx|sh|csv|log|xml|yaml|yml|env|py|rs|go|java|c|cpp|h|hpp|php|rb|swift|kt)$/i.test(selectedItem.name);

    if (isTextFile) {
      setLoadingContent(true);
      getTextPreview(selectedItem.path)
        .then(result => {
          setTextPreview(result);
          if (result.error) {
            setErrorMsg(result.error);
          }
        })
        .catch(err => {
          console.error("Failed to load text preview:", err);
          setTextPreview(null);
          setErrorMsg(String(err));
        })
        .finally(() => {
          setLoadingContent(false);
        });
    } else {
      setTextPreview(null);
    }
  }, [selectedItem]);

  const handleUpdateTag = (newTag: any) => {
    if (!selectedItem) return;
    const stored = localStorage.getItem("NEXUS_ITEM_TAGS");
    const tags: Record<string, string> = stored ? JSON.parse(stored) : {};
    if (newTag === "none") {
      delete tags[selectedItem.id];
    } else {
      tags[selectedItem.id] = newTag;
    }
    localStorage.setItem("NEXUS_ITEM_TAGS", JSON.stringify(tags));
    explorer.setStatusMessage(`Tag "${newTag}" applied.`);
  };

  const systemFontClass = explorer.font === "monospace" ? "font-mono" : "font-sans";
  const hasSelectedItem = Boolean(selectedItem);
  // Memoize the fallback empty object so its reference is stable across
  // renders. Without this, every render creates a brand-new {} literal,
  // which downstream useMemo/useEffect deps (and `<Component key={…}>`)
  // see as "different", and a chain of cascading memo invalidations can
  // eventually exhaust React's update depth.
  const previewItem = useMemo(() => {
    return selectedItem ?? ({
      id: "",
      name: "",
      type: "file",
      path: "",
      parentId: "",
      content: "",
    } as FSItem);
  }, [selectedItem]);

  const isDir = previewItem.type === "directory";
  const fileExtRaw = previewItem.name.split(".").pop()?.toLowerCase() || "";
  const fileExt = fileExtRaw.toUpperCase() || "TỆP";
  const effectiveContent = textPreview?.content ?? previewItem.content ?? "";
  const lineCount = effectiveContent ? effectiveContent.split("\n").length : 0;

  // Use detectMediaType to properly detect video vs image vs sequence
  // Memoize so the returned object reference is stable across renders
  // when the selected path hasn't changed — otherwise downstream children
  // (and our own `key` / useEffect deps) see a fresh object every render
  // and React can throw "Maximum update depth exceeded".
  const mediaInfo = useMemo(() => {
    if (!hasSelectedItem || previewItem.type === "directory") return null;
    return detectMediaType(previewItem.path, items, previewItem.parentId || "");
  }, [hasSelectedItem, previewItem, items]);

  // Detect file types using proper detection
  const isVideo = mediaInfo?.type === 'video';
  const isSeq = mediaInfo?.type === 'image-sequence' && mediaInfo.paths.length > 1;
  const isStillImg = mediaInfo?.type === 'image-sequence' && mediaInfo.paths.length === 1;
  
  const isAudio = /\.(mp3|wav|ogg|flac|m4a)$/i.test(previewItem.name);
  const isSvg = /\.(svg)$/i.test(previewItem.name);
  const is3DModel = /\.(obj|fbx|3ds|glb|gltf|stl|ply|usdz|usd|usda|usdc|abc|ewa|spz|3mf|igs|iges|step|stp|skp|dae)$/i.test(previewItem.name);
  const isPdf = /\.pdf$/i.test(previewItem.name);
  const isFont = /\.(ttf|otf|woff|woff2)$/i.test(previewItem.name);
  const isEpub = /\.epub$/i.test(previewItem.name);
  const archiveFormatMatch = previewItem.name.match(/\.(rar|zip)$/i);
  const archiveFormat = archiveFormatMatch ? (archiveFormatMatch[1].toLowerCase() as "rar" | "zip") : null;
  const isArchive = archiveFormat !== null;
  const isDoc = /\.doc$/i.test(previewItem.name);
  const isDocx = /\.docx$/i.test(previewItem.name);
  const isXls = /\.xls$/i.test(previewItem.name);
  const isXlsx = /\.xlsx$/i.test(previewItem.name);
  const isPpt = /\.ppt$/i.test(previewItem.name);
  const isPptx = /\.pptx$/i.test(previewItem.name);

  const isCode = /\.(json|txt|md|lnk|html|css|js|ts|tsx|sh|csv|log|xml|yaml|yml|env|py|rs|go|java|c|cpp|h|hpp|php|rb|swift|kt)$/i.test(previewItem.name);
  const isTextDoc = !isDir && /\.(json|txt|md|lnk|html|css|js|ts|tsx|sh|csv|log|xml|yaml|yml|env|py|rs|go|java|c|cpp|h|hpp|php|rb|swift|kt)$/i.test(previewItem.name);
  const codeLanguage = CODE_VIEWER_LANGUAGE_MAP[fileExtRaw] || "plaintext";
  const highlightedLines = useMemo(() => {
    if (!effectiveContent) return [] as string[];
    const lines = effectiveContent.split("\n");
    if (!isCode) {
      return lines.map((line) => escapeHtml(line || " "));
    }
    return lines.map((line) => {
      const safeLine = line || " ";
      try {
        if (codeLanguage === "plaintext") {
          return escapeHtml(safeLine);
        }
        return hljs.highlight(safeLine, { language: codeLanguage, ignoreIllegals: true }).value;
      } catch {
        return escapeHtml(safeLine);
      }
    });
  }, [effectiveContent, isCode, codeLanguage]);

  if (!hasSelectedItem) {
    // Elegant fallback PC properties preview when nothing is chosen
    return (
<div
        className={`h-full p-5 text-xs flex flex-col justify-center items-center text-center select-none shrink-0 hidden lg:flex transition-colors duration-200 text-stone-400`}
        style={{ width }}
      >
        <HardDrive className="w-16 h-16 opacity-10 mb-4 text-[#0078d4]" style={{ color: accentColor }} />
        <h4 className={`font-semibold mb-1 text-stone-300`}>
          {explorer.language === "vi" ? "Thuộc tính Explorer" : "Explorer Properties"}
        </h4>
        <p className="text-[11px] leading-relaxed max-w-[200px]">
          {explorer.language === "vi"
            ? "Chọn một tệp hoặc thư mục để xem chi tiết thuộc tính."
            : "Select a file or directory to view detailed properties."}
        </p>
      </div>
    );
  }

  const selectedItemSafe = previewItem;

  // Keep `previewKey` based on path only (not fingerprint). Including
  // `fileFingerprint` in the key caused EXRSequencePlayer to remount when
  // the fingerprint resolved async ("0-0" → real fingerprint), which
  // re-triggered `displayFrame(0) + startContinuousRamLoad()` for the same
  // file and produced orphan `[TAURI] Couldn't find callback id` warnings
  // (Rust decode in flight from the first mount resolved against a stale
  // callback id). The fingerprint is still passed as a prop so the player
  // can detect "file replaced in place" if needed.
  const previewKey = selectedItemSafe
    ? selectedItemSafe.path.replace(/\\/g, "/")
    : "empty";

  const isPsd = /\.(psd|psb)$/i.test(selectedItemSafe.name);
  const isAi = /\.(ai|eps)$/i.test(selectedItemSafe.name);
  const isC4d = /\.c4d$/i.test(selectedItemSafe.name);
  const isPureRef = /\.(pur|pureref)$/i.test(selectedItemSafe.name);
  const isEXR = /\.(exr)$/i.test(selectedItemSafe.name);
  // Detect EXR vs EXR sequence
  const isSingleEXR = isEXR && !isSeq;
  const isEXRSeq = isEXR && isSeq;
  // Route PSD/AI through ImageSequencePreview (has built-in decode)
  // Pure DCC formats (blend, hip) that can't be previewed - get placeholder
  const isDCC = /\.(blend|hipnc)$/i.test(selectedItemSafe.name);
  // Files that go through ImageSequencePreview (which handles decoding internally)
  const needsImagePreview = isPsd || isAi || isC4d || isPureRef;
        const isImage = /\.(png|jpg|jpeg|gif|webp|tiff?|tga|af)$/i.test(selectedItemSafe.name) && !isSeq;

  const getFallbackPreviewIcon = () => {
    if (isDir) return <Folder className="w-12 h-12 text-amber-400" fill="currentColor" />;
    if (isVideo) return <Play className="w-12 h-12 text-rose-400" />;
    if (isAudio) return <Music className="w-12 h-12 text-blue-400" />;
    if (isImage || isStillImg || isSvg || needsImagePreview || isSingleEXR) return <FileImage className="w-12 h-12 text-emerald-400" />;
    if (is3DModel || isDCC || isC4d) return <Box className="w-12 h-12 text-orange-400" />;
    if (/\.(zip|rar|7z|tar|gz)$/i.test(selectedItemSafe.name)) return <Archive className="w-12 h-12 text-amber-400" />;
    if (isPdf) return <FileText className="w-12 h-12 text-red-400" />;
    if (isFont) return <FileText className="w-12 h-12 text-purple-400" />;
    if (isEpub) return <FileText className="w-12 h-12 text-amber-400" />;
    if (isDoc) return <FileText className="w-12 h-12 text-blue-400" />;
    if (isDocx) return <FileText className="w-12 h-12 text-blue-400" />;
    if (isXlsx) return <FileText className="w-12 h-12 text-emerald-400" />;
    if (isXls) return <FileText className="w-12 h-12 text-emerald-400" />;
    if (isPptx) return <FileText className="w-12 h-12 text-orange-400" />;
    if (isPpt) return <FileText className="w-12 h-12 text-orange-400" />;
    if (isCode || isTextDoc) return <Code className="w-12 h-12 text-violet-400" />;
    if (/\.(exe|msi|bat|cmd)$/i.test(selectedItemSafe.name)) return <AppWindow className="w-12 h-12 text-cyan-400" />;
    return <File className="w-12 h-12 text-sky-400" />;
  };

  // Core Render of the 2/3 top previewer
  const renderPreviewZone = () => {
    if (isArchive && archiveFormat) {
      return (
        <ArchivePreview
          key={previewKey}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          accentColor={accentColor}
          language={explorer.language}
          fileFingerprint={fileFingerprint}
          format={archiveFormat}
        />
      );
    }

    // EXR sequence uses dedicated EXRSequencePlayer
    if (isEXRSeq && mediaInfo) {
      return (
        <EXRSequencePlayer
          key={previewKey}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          mediaInfo={mediaInfo}
          accentColor={accentColor}
          fileFingerprint={fileFingerprint}
          // 2026-07-06: forward host locale + theme so the embedded
          // `<ColorPicker>` popover (preview-background color)
          // renders with the right i18n labels + theme-aware vars.
          language={explorer.language}
          theme={explorer.theme}
        />
      );
    }

    // Single EXR files now use EXRSequencePlayer (shared pipeline, FFI-only).
    // We fabricate a single-item MediaInfo so the same component handles both
    // single-frame and multi-frame EXRs without code duplication.
    if (isSingleEXR) {
      const singleFrameMediaInfo: import("../utils/fileTypeDetector").MediaInfo = {
        type: 'image-sequence',
        paths: [selectedItemSafe.path],
        frameNumbers: [0],
        basePattern: selectedItemSafe.name,
        ext: 'exr',
        baseName: selectedItemSafe.name.replace(/\.exr$/i, ''),
      };
      return (
        <EXRSequencePlayer
          key={previewKey}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          mediaInfo={singleFrameMediaInfo}
          accentColor={accentColor}
          fileFingerprint={fileFingerprint}
        />
      );
    }

    if (isVideo) {
      return (
        <VideoPlayerPreview
          key={selectedItemSafe.path.replace(/\\/g, "/")}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          accentColor={accentColor}
        />
      );
    }
    
    if (isImage || isSeq || isSvg || needsImagePreview) {
      return (
        <ImageSequencePreview
          key={previewKey}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          accentColor={accentColor}
          isSequence={isSeq}
          isEXR={isEXR}
          mediaInfo={mediaInfo}
          fileFingerprint={fileFingerprint}
        />
      );
    }

    if (isSingleEXR) {
      const singleFrameMediaInfo: import("../utils/fileTypeDetector").MediaInfo = {
        type: 'image-sequence',
        paths: [selectedItemSafe.path],
        frameNumbers: [0],
        basePattern: selectedItemSafe.name,
        ext: 'exr',
        baseName: selectedItemSafe.name.replace(/\.exr$/i, ''),
      };
      return (
        <EXRSequencePlayer
          key={previewKey}
          filePath={selectedItemSafe.path}
          fileName={selectedItemSafe.name}
          accentColor={accentColor}
          mediaInfo={singleFrameMediaInfo}
          fileFingerprint={fileFingerprint}
        />
      );
    }

    if (isEXRSeq) {
      return (
        <EXRSequencePlayer
          key={previewKey}
          filePath={selectedItemSafe.path}
          fileName={selectedItemSafe.name}
          accentColor={accentColor}
          mediaInfo={mediaInfo}
          fileFingerprint={fileFingerprint}
        />
      );
    }

    if (is3DModel) {
      return (
        <ThreeDModelViewer
          key={previewKey}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          accentColor={accentColor}
          language={explorer.language}
        />
      );
    }

    // Office document previews
    if (isDoc) {
      return (
        <DOCPreview
          key={previewKey}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          accentColor={accentColor}
        />
      );
    }

    if (isDocx) {
      return (
        <DOCXPreview
          key={previewKey}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          accentColor={accentColor}
        />
      );
    }

    if (isXlsx) {
      return (
        <XLSXPreview
          key={previewKey}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          accentColor={accentColor}
        />
      );
    }

    if (isXls) {
      return (
        <XLSPreview
          key={previewKey}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          accentColor={accentColor}
        />
      );
    }

    if (isPptx) {
      return (
        <PPTXPreview
          key={previewKey}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          accentColor={accentColor}
        />
      );
    }

    if (isPpt) {
      return (
        <PPTPreview
          key={previewKey}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          accentColor={accentColor}
        />
      );
    }

    if (isPdf) {
      return (
        <PDFPreview
          key={previewKey}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          accentColor={accentColor}
        />
      );
    }

    if (isFont) {
      return (
        <FontPreview
          key={previewKey}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          accentColor={accentColor}
          language={explorer.language}
        />
      );
    }

    if (isEpub) {
      return (
        <EPUBPreview
          key={previewKey}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          accentColor={accentColor}
        />
      );
    }
    
    if (isAudio) {
      const audioSiblings = items.filter(i => 
        i.parentId === selectedItemSafe.parentId && 
        /\.(mp3|wav|ogg|flac|m4a)$/i.test(i.name)
      ).sort((a, b) => a.name.localeCompare(b.name));

      return (
        <AudioPlayerPreview
          key={previewKey}
          fileName={selectedItemSafe.name}
          filePath={selectedItemSafe.path}
          accentColor={accentColor}
          playlist={audioSiblings}
        />
      );
    }
    
    if (isDir) {
      const folderContents = items.filter(i => i.parentId === selectedItemSafe.id);

      const renderGridIcon = (child: FSItem) => {
        if (child.type === "directory") {
          return (
            <Folder className="w-8 h-8 text-amber-400 mb-2" fill="currentColor" />
          );
        }
        const ext = child.name.split(".").pop()?.toLowerCase();
        let IconElement = FileText;
        let colorClass = "text-stone-400";
        if (/\.(mp4|mov|avi|mkv|webm)$/i.test(child.name)) {
          IconElement = Play;
          colorClass = "text-red-400";
        } else if (/\.(mp3|wav|ogg|flac|m4a)$/i.test(child.name)) {
          IconElement = Music;
          colorClass = "text-blue-400";
             } else if (/\.(png|jpg|jpeg|gif|webp|exr|tiff?|tga|af)$/i.test(child.name)) {
          IconElement = FileImage;
          colorClass = "text-emerald-400";
        }

        return <IconElement className={`w-8 h-8 ${colorClass} mb-2`} strokeWidth={1.5} />;
      };

        return (
        <div className={`flex-1 w-full h-full flex flex-col pt-8 p-5 overflow-hidden`}>
          <div className="flex gap-2 items-center px-1 mb-4 select-none">
            <Folder className="w-5 h-5 text-amber-400 shrink-0" fill="currentColor" />
            <span className={`font-bold text-xs truncate text-stone-200 flex-1 min-w-0`}>
              {selectedItemSafe.name}
            </span>
            {/* Right side: view mode dropdown (independent of the main Explorer) */}
            <FolderInspectorView explorer={explorer} />
          </div>

          <div className="flex-1 overflow-y-auto no-scrollbar pb-6 pr-2">
             <div className="grid grid-cols-4 gap-3 lg:grid-cols-5">
               {folderContents.map(child => {
                 const isInspectorSelected = inspectorSelectedIds.includes(child.id);
                 return (
                   <div
                     key={child.id}
                     onClick={(e) => toggleInspectorSelection(child.id, e.ctrlKey || e.metaKey)}
                     className={`flex flex-col items-center justify-start text-center p-2 rounded cursor-pointer group transition-colors ${
                       isInspectorSelected
                         ? "bg-amber-500/20 ring-1 ring-amber-500/40"
                         : "hover:bg-black/10 dark:hover:bg-white/5"
                     }`}
                     title={
                       explorer.language === "vi"
                         ? `Bấm Delete để chuyển vào Thùng rác\nShift+Delete để xóa vĩnh viễn\nCtrl+Click để chọn nhiều`
                         : `Press Delete to move to Recycle Bin\nShift+Delete to permanently delete\nCtrl+Click to multi-select`
                     }
                   >
                     <div className="relative">
                        {renderGridIcon(child)}
                     </div>
                     <span className={`text-[9px] font-medium leading-tight truncate w-full mt-1 max-w-full transition-colors ${
                       isInspectorSelected ? "text-amber-300" : "text-stone-500 group-hover:text-amber-500"
                     }`}>
                       {child.name}
                     </span>
                   </div>
                 );
               })}
               {folderContents.length === 0 && (
                 <div className="col-span-full h-20 flex items-center justify-center text-[10px] text-stone-500">
                   Empty Directory
                 </div>
               )}
             </div>
          </div>
        </div>
      );
    }

    if (isDCC) {
      return (
        <div className={`flex flex-col flex-1 h-full justify-center items-center text-center p-4 relative`}>
          {/* Subtle grid background for design files */}
          <div className="absolute inset-0 opacity-[0.03] pointer-events-none checkerboard" style={{ backgroundSize: "20px 20px", backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px" }} />

          <div className="relative w-full max-w-[200px] aspect-video border shadow-lg overflow-hidden flex items-center justify-center bg-black/40 rounded border-white/10 mb-4">
             <Box className="w-12 h-12 text-orange-400 opacity-50" />
             <div className="absolute bottom-2 left-2 right-2 border-t border-white/10 pt-1 flex justify-between items-center text-[7px] font-mono text-stone-400">
               <span>3D Scene</span>
               <span>{fileExt}</span>
             </div>
          </div>

          <span className={`font-semibold truncate max-w-[150px] text-[11px] block text-stone-200`} title={selectedItemSafe.name}>
            {selectedItemSafe.name}
          </span>
          <span className="text-[9px] font-mono text-stone-500 mt-1 uppercase tracking-widest">
            3D Scene File
          </span>

          <div className={`mt-4 text-[9px] font-mono px-3 py-2 rounded border bg-orange-500/10 border-orange-500/20 text-orange-400`}>
            {fileExt.toUpperCase()} requires 3D software for preview
          </div>
        </div>
      );
    }

    if (isImage) {
      // Image resolution logic: Name-based dimensions simulation
      const imgWidth = selectedItemSafe.name.includes("wallpaper") ? 1920 
                     : selectedItemSafe.name.includes("lut") || selectedItemSafe.name.includes("tiff") ? 64 
                     : 1024;
      const imgHeight = selectedItemSafe.name.includes("wallpaper") ? 1080 
                      : selectedItemSafe.name.includes("lut") || selectedItemSafe.name.includes("tiff") ? 64 
                      : 768;
      const isPixelLarge = imgWidth > 512 || imgHeight > 512;

      // Color info stats for pipeline designers (EXR / TIFF formats)
      const isLinear = /\.(exr|tiff)$/i.test(selectedItemSafe.name);

      return (
        <div className={`flex-1 w-full h-full flex flex-col justify-center items-center p-4 relative overflow-auto`}>
          {/* Grid Checkers background */}
          <div 
            className="absolute inset-0 pointer-events-none opacity-20 checkerboard-light"
          />

          {/* Sizing frame wrapper based on resolution rules */}
          <div 
            className={`relative border shadow-xl rounded overflow-hidden flex flex-col items-center justify-center bg-theme-preview-4/90 ${
              isPixelLarge 
                ? "w-[min(512px,100%)] aspect-video max-h-[260px]" // fitting for images over > 512px
                : "w-[128px] h-[128px] border-dashed border-stone-700 bg-theme-preview-5" // centered natural pixel scale for under 512px image
            }`}
            style={{ borderColor: `${accentColor}40` }}
          >
            {/* Visual emulated graphic asset drawings */}
            {isLinear ? (
              <div className="absolute inset-0 w-full h-full flex flex-col justify-between p-3 bg-gradient-to-br from-indigo-950 via-slate-900 to-emerald-950">
                <span className="font-mono text-[7px] text-neutral-400">IEEE 754 float32 linear buffer</span>
                <div className="text-center font-bold text-[14px]" style={{ color: accentColor }}>
                  {fileExt} PASS
                </div>
                <div className="flex justify-between items-center text-[7px] font-mono text-zinc-500 uppercase">
                  <span>Linear Space</span>
                  <span>ACEScg</span>
                </div>
              </div>
            ) : (
              <div className="absolute inset-0 w-full h-full flex flex-col justify-between p-3 bg-gradient-to-tr from-[#134e4a] to-[#701a75]">
                <span className="font-mono text-[7px] text-zinc-400">sRGB Gamma compressed</span>
                <span className="font-extrabold text-[12px] tracking-wider text-center block text-white uppercase mt-4">
                  {selectedItemSafe.name.split("_")[0]}
                </span>
                <div className="text-right text-[7px] font-mono text-zinc-500">8-bit Channels</div>
              </div>
            )}

            {/* Scale alert indicators */}
            <div className="absolute bottom-1 right-2 bg-black/80 px-1 rounded text-[7px] font-mono text-stone-400 pointer-events-none">
              {isPixelLarge ? `Rescaled (Source: ${imgWidth}x${imgHeight})` : `1:1 Native (${imgWidth}x${imgHeight})`}
            </div>
          </div>
        </div>
      );
    }

    if (isCode) {
      const contentLines = effectiveContent.split("\n");
      const displayLineCount = textPreview?.line_count ?? contentLines.length;
      const isBinaryPreview = Boolean(textPreview?.is_binary);
      const previewError = textPreview?.error ?? errorMsg;

      return (
        <div className="flex-1 flex flex-col h-full overflow-hidden select-text text-[#d4d4d8]">
          <div className="p-2.5 border-b flex items-center justify-between shrink-0 border-white/5">
            <span className="font-mono text-[10px] font-bold text-stone-200">
              📝 Code Viewer
            </span>
            <div className="flex items-center gap-2 text-[8.5px] font-mono font-extrabold text-stone-500">
              <span>{displayLineCount} lines</span>
              {textPreview?.encoding ? <span>{textPreview.encoding}</span> : null}
              {textPreview?.truncated ? <span className="text-amber-400">truncated</span> : null}
            </div>
          </div>

          {loadingContent ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="flex items-center gap-2 text-stone-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-xs">Loading file content...</span>
              </div>
            </div>
          ) : isBinaryPreview ? (
            <div className="flex-1 flex items-center justify-center p-6 text-center text-stone-500">
              <div>
                <AlertCircle className="w-8 h-8 mx-auto mb-3 text-amber-400" />
                <div className="text-sm font-semibold text-stone-300">Binary file preview is not available</div>
                <div className="text-[11px] mt-1">This file looks like a binary resource, so the code viewer is hidden.</div>
              </div>
            </div>
          ) : previewError ? (
            <div className="flex-1 flex items-center justify-center p-6 text-center text-red-400 text-[11px]">
              {previewError}
            </div>
          ) : (
            <>
              <div className="code-viewer flex-1 overflow-auto p-3 font-mono text-[10px] leading-relaxed flex scrollbar-thin">
                <div className="text-stone-600 text-right pr-2 select-none border-r border-[#1a1a24] mr-2 w-8 shrink-0 leading-relaxed">
                  {contentLines.map((_, i) => (
                    <div key={i} className="h-4.5">{i + 1}</div>
                  ))}
                </div>
                <pre className="flex-1 whitespace-pre overflow-x-auto leading-relaxed max-w-full">
                  {highlightedLines.map((line, i) => (
                    <div key={i} className="h-4.5 hover:bg-white/5 px-0.5 rounded-sm">
                      <code dangerouslySetInnerHTML={{ __html: line }} />
                    </div>
                  ))}
                </pre>
              </div>
              {textPreview?.truncated ? (
                <div className="border-t border-amber-500/10 bg-amber-500/5 px-3 py-2 text-[10px] text-amber-300">
                  Preview truncated to keep the details pane responsive. Open the full editor to view the entire file.
                </div>
              ) : null}
            </>
          )}
        </div>
      );
    }

    // Default general file extensions previewer
    const thumb = thumbs[selectedItemSafe.path];
    const thumbSrc = normalizeThumbnailSrc(thumb);
    
    return (
      <div className={`flex flex-col flex-1 h-full justify-center items-center text-center p-4`}>
        <div className={`p-4 rounded-2xl mb-3 shadow-md bg-white/5`}>
          {thumbSrc ? (
            <img
              src={thumbSrc}
              alt={selectedItemSafe.name}
              className="w-16 h-16 object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
                const next = (e.target as HTMLImageElement).nextElementSibling as HTMLElement | null;
                if (next) next.style.display = "flex";
              }}
            />
          ) : null}
          <div className={`${thumb ? "hidden" : "flex"} items-center justify-center w-16 h-16`}>
            {getFallbackPreviewIcon()}
          </div>
        </div>
        <span className={`font-semibold truncate max-w-[150px] block text-stone-200`} title={selectedItemSafe.name}>
          {selectedItemSafe.name}
        </span>
        <span className="text-[9.5px] font-mono text-stone-500 mt-1 uppercase">
          Binary Resource Item
        </span>
      </div>
    );
  };

  return (
    <div
      ref={panelRef}
      data-pane="folder-inspector"
      onContextMenu={(event) => event.preventDefault()}
      className={`h-full flex flex-col text-xs select-none shrink-0 overflow-hidden transition-colors duration-200 ${isResizing ? "select-none" : ""} text-stone-300`}
      style={{ width }}
    >
      {/* SECTION 1 (TOP): The preview area — flex-1 so it fills remaining space */}
      <div
        className="flex flex-col border-b overflow-hidden relative flex-1 min-h-0"
        style={{
          borderColor: "rgba(255,255,255,0.05)",
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        {renderPreviewZone()}
      </div>

      {/* Resize Handle — only for non-PDF/Font files that have description */}
      {!isPdf && !isFont && !isEpub && !isArchive && (
        <div
          className="flex items-center justify-center cursor-row-resize shrink-0"
          style={{
            height: "4px",
            backgroundColor: isResizing ? accentColor + "20" : "transparent",
          }}
          onMouseDown={handleMouseDown}
          title="Kéo để thay đổi kích cỡ"
        >
          <div
            className="w-full h-[2px] transition-colors duration-150"
            style={{
              backgroundColor: isResizing
                ? accentColor
                : "rgba(255,255,255,0.05)",
            }}
          />
        </div>
      )}

      {/* SECTION 2 (BOTTOM): Description / properties — hidden for PDF, Font and EPUB */}
      {!isPdf && !isFont && !isEpub && !isArchive && (
        <div
          className="flex flex-col overflow-hidden cursor-default shrink-0 transition-colors duration-200"
        >
          {/* Description header — always visible, color reflects classify tag */}
          <div
            className={`flex items-center justify-between px-4 py-2 border-b cursor-pointer select-none transition-colors duration-200 ${
              (() => {
                const tagStyle = getTagHeaderStyle(currentTag);
                if (tagStyle) {
                  return `${tagStyle.bg} ${tagStyle.border}`;
                }
                return "bg-[var(--header-bg)] border-white/5";
              })()
            }`}
            onClick={() => setIsDescExpanded((v) => !v)}
            title={isDescExpanded ? "Collapse description" : "Expand description"}
          >
            <div className="flex items-center gap-2 min-w-0">
              {isDescExpanded ? (
                <ChevronDown className={`w-3.5 h-3.5 shrink-0 ${(() => {
                  const tagStyle = getTagHeaderStyle(currentTag);
                  return tagStyle ? tagStyle.text : "text-stone-400";
                })()}`} />
              ) : (
                <ChevronRight className={`w-3.5 h-3.5 shrink-0 ${(() => {
                  const tagStyle = getTagHeaderStyle(currentTag);
                  return tagStyle ? tagStyle.text : "text-stone-400";
                })()}`} />
              )}
              <span className={`text-[10px] font-bold uppercase tracking-wider truncate ${(() => {
                const tagStyle = getTagHeaderStyle(currentTag);
                return tagStyle ? tagStyle.text : "text-stone-400";
              })()}`}>
                {explorer.language === "vi" ? "Mô tả" : "Description"}
              </span>
              {currentTag && (() => {
                const tagStyle = getTagHeaderStyle(currentTag);
                return (
                  <span className={`flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold border ${tagStyle?.bg} ${tagStyle?.border} ${tagStyle?.text}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${tagStyle?.dot}`} />
                    {getTagTranslation(currentTag, explorer.language)}
                  </span>
                );
              })()}
            </div>
          </div>

          {/* Collapsible body */}
          {isDescExpanded && (
            <div
              className="flex flex-col justify-between overflow-y-auto p-4 gap-3 scrollbar-thin"
              style={{ minHeight: "120px", maxHeight: "40%" }}
            >
              {/* Core Attributes Panel */}
              <div className={`space-y-2.5 text-[11px] ${systemFontClass}`}>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 border-b pb-2.5" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                  <div>
                    <span className="block text-[9px] uppercase tracking-wider text-stone-500 mb-0.5">Size</span>
                    <span className={`font-semibold text-stone-200`}>
                      {isDir
                        ? showFolderSizes
                          ? folderSizes[selectedItemSafe.id] == null
                            ? <span className="text-stone-500 text-[10px]">...</span>
                            : formatSize(folderSizes[selectedItemSafe.id]!)
                          : formatSize(0)
                        : formatSize(selectedItemSafe.size)
                      }
                    </span>
                  </div>
                  <div>
                    <span className="block text-[9px] uppercase tracking-wider text-stone-500 mb-0.5">Type</span>
                    <span className={`font-semibold uppercase text-stone-200`}>
                      {isDir ? (explorer.language === "vi" ? "Thư mục" : "Folder") : `${fileExt} Format`}
                    </span>
                  </div>
                  <div className="col-span-2">
                    <span className="block text-[9px] uppercase tracking-wider text-stone-500 mb-0.5">Last Modification</span>
                    <span className={`font-semibold text-stone-200`}>
                      {new Date(selectedItemSafe.updatedAt).toLocaleString()}
                    </span>
                  </div>
                </div>

                {/* Tag Selection Row */}
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-stone-400 flex items-center gap-1">
                    <Tag className="w-3.5 h-3.5 text-stone-500" />
                    <span>Classify Tag:</span>
                  </span>
                  <select
                    value={currentTag || "none"}
                    onChange={(e) => handleUpdateTag(e.target.value)}
                    className="text-[10px] rounded px-1.5 py-0.5 focus:outline-none border font-bold border-white/10 text-stone-300"
                    style={{ backgroundColor: 'var(--header-bg)' }}
                  >
                    <option value="none">{explorer.language === "vi" ? "Không có" : "None"}</option>
                    <option value="Warning">{getTagTranslation("Warning", explorer.language)}</option>
                    <option value="WIP">{getTagTranslation("WIP", explorer.language)}</option>
                    <option value="Deliverable">{getTagTranslation("Deliverable", explorer.language)}</option>
                    <option value="Archived">{getTagTranslation("Archived", explorer.language)}</option>
                    <option value="Draft">{getTagTranslation("Draft", explorer.language)}</option>
                  </select>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison: only re-render when content actually changes
  const prevIds = prevProps.explorer.selectedIds;
  const nextIds = nextProps.explorer.selectedIds;
  
  // Re-render if selectedIds changed
  if (prevIds.length !== nextIds.length) return false;
  if (!prevIds.every((id, i) => id === nextIds[i])) return false;
  
  // Re-render if width changed (different preview sizing)
  if (prevProps.width !== nextProps.width) return false;
  
  // Otherwise, skip re-render
  return true;
});

// Default export for backward compatibility
export default ExplorerDetailsPane;
