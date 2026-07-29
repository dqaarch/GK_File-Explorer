import React, { useState, useMemo, useCallback, useRef, useEffect, useTransition } from "react";
import { ExplorerAPI } from "../useExplorer";
import { readDirectoryRecursive, FileEntry } from "../TauriFileSystem";
import { 
  BarChart2, HardDrive, RefreshCw, Sparkles, Trash2, ShieldAlert, Check, 
  HelpCircle, AlertTriangle, Info, ArrowLeft, Search
} from "lucide-react";
import { FSItem } from "../types";

interface SpaceAnalyzerProps {
  explorer: ExplorerAPI;
}

interface DuplicateFile {
  name: string;
  path: string;
  size: number;
  modified?: string | null;
  extension?: string | null;
}

type FilterType = "all" | "video" | "image" | "audio" | "code_doc" | "3d" | "document" | "archive" | "other";

export default function SpaceAnalyzerDashboard({ explorer }: SpaceAnalyzerProps) {
  const {
    items,
    getSpaceStats,
    accentColor,
    deleteItem,
    setShowSpaceAnalyzer,
    language,
    activeTab,
  } = explorer;

  const t = (vi: string, en: string) => language === "vi" ? vi : en;

  const [isCleaning, setIsCleaning] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [selectedDuplicates, setSelectedDuplicates] = useState<Set<string>>(new Set());
  const [duplicateFilter, setDuplicateFilter] = useState<FilterType>("all");
  const [duplicateSearch, setDuplicateSearch] = useState("");

  // Recursive scan state
  const [scannedFiles, setScannedFiles] = useState<FileEntry[] | null>(null);
  const [isScanningDuplicates, setIsScanningDuplicates] = useState(false);
  const [scanProgress, setScanProgress] = useState({ scanned: 0, total: 0 });
  const [isPending, startTransition] = useTransition();

  // Ref to track current scan target (avoid stale closure)
  const scanPathRef = useRef<string | null>(null);

  // Check if path is a drive root like "C:\" or "C:/" - never scan drives
  const isDriveRoot = (p: string): boolean => /^[A-Za-z]:[\\/]?$/.test(p);

  // Recursive scan function - runs in Rust, no UI block
  const scanForDuplicatesRecursive = useCallback(async (path: string) => {
    // Refuse to scan drive roots
    if (isDriveRoot(path)) {
      return;
    }

    scanPathRef.current = path;
    setIsScanningDuplicates(true);
    setScannedFiles(null);
    setSelectedDuplicates(new Set());
    setScanProgress({ scanned: 0, total: 0 });

    try {
      // Depth 8 - good balance, Rust is fast
      const entries = await readDirectoryRecursive(path, 8);

      // Verify path didn't change during scan
      if (scanPathRef.current !== path) return;

      setScanProgress({ scanned: entries.length, total: entries.length });

      // Use transition to avoid blocking UI on large datasets
      startTransition(() => {
        setScannedFiles(entries.filter(e => e.is_file));
      });
    } catch (err) {
      console.error("Recursive scan error:", err);
    } finally {
      if (scanPathRef.current === path) {
        setIsScanningDuplicates(false);
      }
    }
  }, []);

  // No auto-scan - user must click "Scan Now" button
  // Reset results when path changes
  useEffect(() => {
    setScannedFiles(null);
    setSelectedDuplicates(new Set());
    scanPathRef.current = null;
  }, [activeTab?.currentPath]);

  const stats = getSpaceStats();
  const driveUsedPercent = stats.totalBytes > 0 
    ? ((stats.usedBytes / stats.totalBytes) * 100).toFixed(4) 
    : "0";
  
  // Get current drive letter for display
  const currentDriveLetter = activeTab?.currentPath?.match(/^([A-Za-z]:)/)?.[1]?.toUpperCase() || "C:";

  // Helpers to classify file type from extension
  const getFileTypeCategory = (ext?: string | null): FilterType => {
    const e = (ext || "").toLowerCase();
    if (["mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v"].includes(e)) return "video";
    if (["jpg", "jpeg", "png", "gif", "bmp", "svg", "webp", "tiff", "ico"].includes(e)) return "image";
    if (["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"].includes(e)) return "audio";
    if (["js", "ts", "jsx", "tsx", "py", "java", "c", "cpp", "cs", "go", "rs", "rb", "php", "html", "css", "scss", "json", "xml", "yml", "yaml", "md", "sh", "bat", "ps1"].includes(e)) return "code_doc";
    if (["obj", "fbx", "gltf", "glb", "dae", "stl", "3ds", "blend", "usd", "usdz", "x"].includes(e)) return "3d";
    if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "odt", "ods", "odp"].includes(e)) return "document";
    if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"].includes(e)) return "archive";
    if (!e) return "other";
    return "other";
  };

  // Group duplicates from recursive scan results
  const groupedDuplicates = useMemo(() => {
    if (!scannedFiles || scannedFiles.length === 0) return [];

    // Group files by name (case-insensitive) and size
    const groups: Record<string, FileEntry[]> = {};
    for (const file of scannedFiles) {
      if (!file.is_file) continue;
      const key = `${file.name.toLowerCase()}_${file.size}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(file);
    }

    // Flatten duplicates (groups with > 1 file)
    const result: { name: string; size: number; files: DuplicateFile[] }[] = [];
    for (const key in groups) {
      const group = groups[key];
      if (group.length > 1) {
        result.push({
          name: group[0].name,
          size: group[0].size,
          files: group.map(f => ({
            name: f.name,
            path: f.path,
            size: f.size,
            modified: f.modified,
            extension: f.extension,
          })),
        });
      }
    }

    // Sort by wasted space (size * (count - 1)) descending
    result.sort((a, b) => (b.size * (b.files.length - 1)) - (a.size * (a.files.length - 1)));

    return result;
  }, [scannedFiles]);

  // Filter duplicates
  const filteredGroups = useMemo(() => {
    let groups = groupedDuplicates;
    
    // Filter by type
    if (duplicateFilter !== "all") {
      groups = groups.map(g => ({
        ...g,
        files: g.files.filter(f => getFileTypeCategory(f.extension) === duplicateFilter)
      })).filter(g => g.files.length > 1);
    }
    
    // Filter by search
    if (duplicateSearch.trim()) {
      const q = duplicateSearch.toLowerCase();
      groups = groups.filter(g => 
        g.name.toLowerCase().includes(q) || 
        g.files.some(f => f.path.toLowerCase().includes(q))
      );
    }
    
    return groups;
  }, [groupedDuplicates, duplicateFilter, duplicateSearch]);

  // Toggle select file
  const toggleFileSelection = (path: string) => {
    setSelectedDuplicates(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // Toggle select all in a group
  const toggleGroupSelection = (files: DuplicateFile[]) => {
    setSelectedDuplicates(prev => {
      const next = new Set(prev);
      const allSelected = files.every(f => next.has(f.path));
      if (allSelected) {
        files.forEach(f => next.delete(f.path));
      } else {
        files.forEach(f => next.add(f.path));
      }
      return next;
    });
  };

  // Delete selected files
  const handleDeleteSelected = async () => {
    const toDelete = Array.from(selectedDuplicates);
    if (toDelete.length === 0) return;
    await handleDeleteFiles(toDelete);
    setSelectedDuplicates(new Set());
  };

  // Calculate total size of selected
  const selectedSize = useMemo(() => {
    let total = 0;
    for (const group of groupedDuplicates) {
      for (const file of group.files) {
        if (selectedDuplicates.has(file.path)) total += file.size;
      }
    }
    return total;
  }, [selectedDuplicates, groupedDuplicates]);

  // Format date
  const formatDate = (dateStr?: string | null) => {
    if (!dateStr) return "—";
    try {
      return new Date(dateStr).toLocaleDateString(language === "vi" ? "vi-VN" : "en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  // 1. Identify large files (> 1000 bytes virtual threshold for this mock FS)
  const heavyFiles = [...items]
    .filter((i) => i.type === "file")
    .sort((a, b) => b.size - a.size)
    .slice(0, 5);

  // System cleanup - delete files by path
  const handleDeleteFiles = async (filePaths: string[]) => {
    setIsCleaning("delete");
    setSuccessMsg(null);
    
    for (const path of filePaths) {
      try {
        await deleteItem(path, "recycle");
      } catch (err) {
        console.error("Delete error:", err);
      }
    }
    
    setIsCleaning(null);
    setSuccessMsg(
      t(
        "Dọn dẹp hoàn tất! Đã giải phóng thành công dung lượng.",
        "Deep clean complete! Successfully freed up space."
      )
    );
    explorer.setStatusMessage(t("Dọn dẹp đĩa hoàn tất.", "Disk cleanup finalized."));
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 text-stone-300 text-xs select-none" style={{ backgroundColor: 'var(--app-bg)' }}>
      {/* Page Heading Ribbon */}
      <div className="flex items-center justify-between mb-6 pb-3 border-b rounded-xl px-4 py-3" style={{ backgroundColor: 'var(--header-bg)', borderColor: 'rgba(255,255,255,0.05)' }}>
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setShowSpaceAnalyzer(false)}
            className="p-1 px-2 border border-white/10 hover:bg-white/10 text-stone-300 rounded-lg flex items-center gap-1 transition cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>{t("Về Explorer", "Back to Explorer")}</span>
          </button>
          <div>
            <h2 className="text-sm font-bold text-stone-100 flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-emerald-400" />
              <span>{t("Phân tích Dung lượng Đĩa", "Smart Disk Space Analyzer")}</span>
            </h2>
            <p className="text-[10px] text-stone-500 font-mono">
              {t("Quản lý và giải phóng dung lượng phân vùng NTFS ảo", "Monitor and optimize virtual NTFS space distribution")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded font-mono">
            Optimized State
          </span>
        </div>
      </div>

      {successMsg && (
        <div className="mb-5 p-3.5 bg-emerald-950/40 border border-emerald-500/20 rounded-xl text-emerald-400 flex items-start gap-2.5">
          <Check className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-stone-100 text-xs">{t("Bộ nhớ đã Tối ưu hóa", "Disk Space Optimized")}</p>
            <p className="text-[11px] mt-0.5 text-stone-400">{successMsg}</p>
          </div>
        </div>
      )}

      {/* Grid of panels */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 mb-5">
        {/* Drive Storage overview card (Gauge) */}
        <div className="lg:col-span-5 rounded-2xl p-5 flex flex-col justify-between border border-white/5" style={{ backgroundColor: 'var(--header-bg)' }}>
          <div>
            <h3 className="font-semibold text-stone-200 text-xs flex items-center gap-1.5 mb-1.5">
              <HardDrive className="w-4 h-4" style={{ color: accentColor }} />
              <span>{t(`Phân vùng Ổ đĩa ${currentDriveLetter}`, `Local Disk Partition ${currentDriveLetter}`)}</span>
            </h3>
            <p className="text-[10px] text-stone-500 font-mono mb-4">{t("Tổng chỉ số phân bổ ảo", "Total virtual allocation metric")}</p>
          </div>

          <div className="flex flex-col items-center justify-center py-4">
            {/* Styled dynamic progress circular visual ring */}
            <div className="relative w-28 h-28 flex items-center justify-center">
              <svg className="w-full h-full transform -rotate-90" viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="15.915" fill="none" stroke="var(--row-bg)" strokeWidth="2.5"></circle>
                <circle 
                  cx="18" 
                  cy="18" 
                  r="15.915" 
                  fill="none" 
                  stroke={accentColor} 
                  strokeWidth="2.5" 
                  strokeDasharray={`${parseFloat(driveUsedPercent) * 20} 100`} // scaling drive size representation
                ></circle>
              </svg>
              <div className="absolute flex flex-col items-center text-center">
                <span className="text-lg font-bold text-stone-100">{isNaN(parseFloat(driveUsedPercent)) || parseFloat(driveUsedPercent) === 0 ? "0.01" : driveUsedPercent}%</span>
                <span className="text-[8px] text-stone-500 uppercase tracking-widest mt-0.5">{t("ĐÃ DÙNG", "USED SPACE")}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 mt-4 font-mono text-[10px] border-t border-white/5 pt-3">
            <div>
              <p className="text-stone-500">{t("Đã dùng:", "Used:")}</p>
              <p className="text-stone-200 font-bold text-xs">{(stats.usedBytes / (1024 * 1024)).toFixed(3)} MB</p>
            </div>
            <div>
              <p className="text-stone-500">{t("Còn trống:", "Free:")}</p>
              <p className="text-stone-200 font-bold text-xs">{((stats.totalBytes - stats.usedBytes) / (1024 * 1024)).toFixed(1)} MB</p>
            </div>
          </div>
        </div>

        {/* Categories Bar Distribution charts */}
        <div className="lg:col-span-7 rounded-2xl p-5 border border-white/5" style={{ backgroundColor: 'var(--header-bg)' }}>
          <h3 className="font-semibold text-stone-200 text-xs mb-3.5 flex items-center gap-1.5">
            <BarChart2 className="w-4 h-4 text-sky-400" />
            <span>{t("Phân bố dung lượng theo định dạng", "Space distribution by format")}</span>
          </h3>
          <div className="space-y-3 font-mono">
            {stats.typeDistribution.map((item) => {
              const itemPercent = ((item.value / stats.usedBytes) * 100).toFixed(1);
              const formatLabel = language === "vi" ? (
                item.name === "Directory" ? "Thư mục" :
                item.name === "3d" ? "Mô hình 3D" :
                item.name === "image" ? "Hình ảnh" :
                item.name === "video" ? "Video / Phim" :
                item.name === "audio" ? "Âm thanh" : "Tài liệu / Kịch bản"
              ) : item.name;
              return (
                <div key={item.name} className="space-y-1">
                  <div className="flex justify-between items-center text-[10px]">
                    <span className="text-stone-300 font-medium">{formatLabel}</span>
                    <span className="text-stone-500">
                      {formatSize(item.value)} ({itemPercent}%)
                    </span>
                  </div>
                  <div className="w-full bg-stone-800 rounded-full h-2 overflow-hidden">
                    <div 
                      className="h-full rounded-full transition-all duration-300"
                      style={{ 
                        width: `${itemPercent}%`,
                        backgroundColor: item.color 
                      }}
                    ></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Large Heavy files - Full Width (single column list) */}
      <div className="rounded-2xl p-5 mb-5 border border-white/5" style={{ backgroundColor: 'var(--header-bg)' }}>
        <h3 className="font-semibold text-stone-200 text-xs mb-3.5 flex items-center gap-1.5">
          <ShieldAlert className="w-4 h-4 text-red-400" />
          <span>{t("Top tệp tin chiếm dung lượng lớn", "Top heaviest files")}</span>
        </h3>
        <div className="divide-y divide-white/5 font-mono text-[11px]">
          {heavyFiles.map((file, idx) => (
            <div key={file.id} className="py-2.5 first:pt-0 last:pb-0 flex items-center gap-4">
              <span className="text-stone-500 w-5 shrink-0 text-center">{idx + 1}</span>
              <div className="truncate flex-1 min-w-0">
                <p className="font-medium text-stone-200 truncate">{file.name}</p>
                <p className="text-[9px] text-stone-500 truncate">{file.name.split(".").pop()?.toUpperCase()} File</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="font-bold text-stone-300">{formatSize(file.size)}</span>
                <button
                  onClick={() => deleteItem(file.id, "recycle")}
                  className="p-1 px-1.5 rounded bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 text-red-400 transition cursor-pointer"
                  title={t("Chuyển vào Thùng rác", "Move to Recycle Bin")}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Duplicate File Finder - Full Width */}
      <div className="rounded-2xl p-5 border border-white/5" style={{ backgroundColor: 'var(--header-bg)' }}>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div>
            <h3 className="font-semibold text-stone-200 text-xs flex items-center gap-1.5">
              <Sparkles className={`w-4 h-4 text-emerald-400 ${isScanningDuplicates ? "animate-pulse" : ""}`} />
              <span>{t("Phát hiện tệp trùng lặp", "Duplicate Files Finder")}</span>
              {isScanningDuplicates ? (
                <span className="text-[9px] text-emerald-400/80 font-mono ml-1 flex items-center gap-1">
                  <RefreshCw className="w-3 h-3 animate-spin" />
                  {t(`đang quét ${scanProgress.scanned} file...`, `scanning ${scanProgress.scanned} files...`)}
                </span>
              ) : scannedFiles ? (
                <span className="text-[9px] text-stone-500 font-mono ml-1">
                  ({groupedDuplicates.length} {t("nhóm trùng lặp", "duplicate groups")} · {scannedFiles.length} {t("file đã quét", "files scanned")})
                </span>
              ) : null}
            </h3>
            <p className="text-[10px] text-stone-500 font-mono mt-0.5">
              {t("Quét đệ quy 8 cấp thư mục, tìm file có cùng tên và kích thước", "Recursively scan 8 folder levels for same name & size files")}
            </p>
          </div>
          {/* Scan Now button */}
          {(() => {
            const currentPath = activeTab?.currentPath;
            const disabled = !currentPath || isDriveRoot(currentPath || "") || isScanningDuplicates;
            return (
              <button
                onClick={() => currentPath && scanForDuplicatesRecursive(currentPath)}
                disabled={disabled}
                title={disabled
                  ? t("Vào 1 thư mục cụ thể (không phải ổ đĩa) để quét", "Navigate into a specific folder (not a drive) to scan")
                  : t(`Quét trong: ${currentPath}`, `Scan in: ${currentPath}`)
                }
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: disabled ? '#3f3f46' : accentColor,
                  color: '#ffffff',
                }}
              >
                {isScanningDuplicates ? (
                  <>
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    {t("Đang quét...", "Scanning...")}
                  </>
                ) : (
                  <>
                    <Search className="w-3 h-3" />
                    {t("Quét ngay", "Scan Now")}
                  </>
                )}
              </button>
            );
          })()}
        </div>

        {/* Filter and search bar */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-stone-500" />
              <input
                type="text"
                placeholder={t("Tìm kiếm theo tên hoặc đường dẫn...", "Search by name or path...")}
                value={duplicateSearch}
                onChange={(e) => setDuplicateSearch(e.target.value)}
                className="w-full pl-7 pr-3 py-1.5 border border-white/5 rounded-lg text-[11px] text-stone-200 placeholder-stone-500 focus:outline-none focus:border-emerald-500/30"
                style={{ backgroundColor: 'var(--row-bg, #1f1f1f)' }}
              />
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              {([
                { id: "all", label: t("Tất cả", "All"), color: "#a8a29e" },
                { id: "video", label: t("Video", "Videos"), color: "#f43f5e" },
                { id: "image", label: t("Hình ảnh", "Images"), color: "#34d399" },
                { id: "audio", label: t("Âm thanh", "Audio"), color: "#fbbf24" },
                { id: "code_doc", label: t("Scripts", "Scripts"), color: "#38bdf8" },
                { id: "3d", label: t("Mô hình 3D", "3D Models"), color: "#818cf8" },
                { id: "document", label: t("Tài liệu", "Documents"), color: "#a78bfa" },
                { id: "archive", label: t("Nén", "Archives"), color: "#f97316" },
                { id: "other", label: t("Khác", "Other"), color: "#64748b" },
              ] as { id: FilterType; label: string; color: string }[]).map(pill => {
                const isActive = duplicateFilter === pill.id;
                return (
                  <button
                    key={pill.id}
                    onClick={() => setDuplicateFilter(pill.id)}
                    className={`px-2 py-1 text-[10px] font-semibold rounded transition border`}
                    style={{
                      backgroundColor: isActive ? `${pill.color}15` : explorer.theme === "light" ? "#ffffff" : "var(--surface-bg, #2c2c2c)",
                      color: isActive ? pill.color : explorer.theme === "light" ? "#1a1a1a" : "#a8a8a8",
                      borderColor: isActive ? `${pill.color}30` : explorer.theme === "light" ? "#e5e5e5" : "rgba(255,255,255,0.05)",
                    }}
                  >
                    {pill.label}
                  </button>
                );
              })}
            </div>
          </div>

        <div className="min-h-[200px]">
          {isScanningDuplicates ? (
            <div 
              className="flex flex-col items-center justify-center h-44 border border-dashed rounded-xl" 
              style={{ 
                backgroundColor: explorer.theme === "light" ? "#ffffff" : "var(--row-bg, #1f1f1f)",
                borderColor: explorer.theme === "light" ? "#e5e5e5" : "rgba(255,255,255,0.05)",
                color: explorer.theme === "light" ? "#4a4a4a" : "#78716c"
              }}
            >
              <RefreshCw className="w-5 h-5 text-emerald-500/60 mb-2 animate-spin" />
              <p>{t(`Đang quét đệ quy thư mục... (${scanProgress.scanned} file)`, `Recursively scanning folder... (${scanProgress.scanned} files)`)}</p>
              <p className="text-[9px] mt-1" style={{ color: explorer.theme === "light" ? "#6a6a6a" : "#78716c" }}>{t("Quá trình này chạy trong Rust, không block UI", "Runs in Rust, no UI block")}</p>
            </div>
          ) : filteredGroups.length === 0 ? (
            <div 
              className="flex flex-col items-center justify-center h-44 border border-dashed rounded-xl" 
              style={{ 
                backgroundColor: explorer.theme === "light" ? "#ffffff" : "var(--row-bg, #1f1f1f)",
                borderColor: explorer.theme === "light" ? "#e5e5e5" : "rgba(255,255,255,0.05)",
                color: explorer.theme === "light" ? "#4a4a4a" : "#78716c"
              }}
            >
              <Info className="w-5 h-5 text-emerald-500/60 mb-2" />
              <p>{!scannedFiles 
                ? t("Bấm \"Quét ngay\" để bắt đầu tìm file trùng lặp trong thư mục hiện tại.", "Click \"Scan Now\" to start finding duplicates in current folder.")
                : t("Không tìm thấy tệp trùng lặp.", "No duplicate files found.")}
              </p>
              <p className="text-[9px] mt-1" style={{ color: explorer.theme === "light" ? "#6a6a6a" : "#78716c" }}>{t("Thử thay đổi bộ lọc hoặc tìm kiếm khác", "Try different filter or search")}</p>
            </div>
          ) : (
            <>
              <div className="space-y-3 max-h-[500px] overflow-y-auto goku-thin-scroll pr-1 rounded-xl p-3" style={{ backgroundColor: explorer.theme === "light" ? "#ffffff" : "var(--app-bg, #191919)" }}>
                {filteredGroups.map((group, groupIdx) => {
                  const allSelected = group.files.every(f => selectedDuplicates.has(f.path));
                  const someSelected = group.files.some(f => selectedDuplicates.has(f.path));
                  // Rotate through hues for each group (golden angle for distinct colors)
                  const groupHue = (groupIdx * 137.5) % 360;
                  const groupColor = groupIdx === 0 ? accentColor : `hsl(${groupHue}, 70%, 55%)`;
                  return (
                    <div 
                      key={groupIdx} 
                      className="rounded-xl overflow-hidden"
                      style={{ 
                        backgroundColor: explorer.theme === "light" ? "#ffffff" : "rgba(44,44,44,0.4)",
                        borderWidth: "1px",
                        borderStyle: "solid",
                        borderColor: explorer.theme === "light" ? "#e5e5e5" : "rgba(255,255,255,0.05)",
                      }}
                    >
                      {/* Group header - styled like a button (first row only) */}
                      <div 
                        className="flex items-center gap-2 p-2.5"
                        style={{ 
                          backgroundColor: accentColor,
                          color: '#ffffff'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                          onChange={() => toggleGroupSelection(group.files)}
                          className="w-3.5 h-3.5 accent-white cursor-pointer"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-xs truncate text-white">{group.name}</p>
                          <p className="text-[9px] font-mono text-white/80">
                            {formatSize(group.size)} × {group.files.length} {t("bản sao", "copies")} | {t("Có thể giải phóng:", "Can free up:")} {formatSize(group.size * (group.files.length - 1))}
                          </p>
                        </div>
                      </div>
                      {/* File list */}
                      <div style={{ backgroundColor: explorer.theme === "light" ? "#ffffff" : undefined }}>
                        {group.files.map((file, fileIdx) => {
                          const isSelected = selectedDuplicates.has(file.path);
                          return (
                            <div 
                              key={fileIdx} 
                              className={`flex items-center gap-3 p-2.5 transition ${isSelected ? 'bg-red-500/5' : 'hover:bg-white/5'}`}
                              style={explorer.theme === "light" ? { 
                                borderBottomWidth: "1px", 
                                borderBottomStyle: "solid",
                                borderBottomColor: "#f0f0f0"
                              } : {}}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleFileSelection(file.path)}
                                className="w-3.5 h-3.5 accent-red-500 cursor-pointer shrink-0"
                              />
                              <div className="flex-1 min-w-0">
                                <button
                                  onClick={() => explorer.openPathInNewTab(file.path)}
                                  className="text-[11px] font-mono truncate text-left w-full transition"
                                  style={{ color: explorer.theme === "light" ? "#1a1a1a" : "#d6d3d1" }}
                                  title={t("Mở vị trí file trong tab mới", "Open file location in new tab")}
                                >
                                  {file.path}
                                </button>
                                <p className="text-[9px] font-mono mt-0.5" style={{ color: explorer.theme === "light" ? "#6a6a6a" : "#78716c" }}>
                                  {formatSize(file.size)} • {formatDate(file.modified)}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              
              {/* Bottom action bar */}
              {selectedDuplicates.size > 0 && (
                <div className="sticky bottom-0 mt-3 p-3 rounded-xl flex items-center justify-between"
                  style={{ 
                    backgroundColor: explorer.theme === "light" ? "#ffffff" : "var(--header-bg)",
                    borderTopWidth: "1px",
                    borderTopStyle: "solid",
                    borderTopColor: explorer.theme === "light" ? "#e5e5e5" : "rgba(255,255,255,0.1)",
                  }}
                >
                  <div className="text-[11px]" style={{ color: explorer.theme === "light" ? "#1a1a1a" : "#d6d3d1" }}>
                    <span className="font-semibold text-emerald-400">{selectedDuplicates.size}</span> {t("tệp đã chọn", "files selected")} • 
                    <span className="font-semibold text-emerald-400 ml-1">{formatSize(selectedSize)}</span> {t("có thể giải phóng", "can be freed")}
                  </div>
                  <button
                    onClick={handleDeleteSelected}
                    disabled={isCleaning !== null}
                    className="flex items-center gap-1.5 px-4 py-1.5 bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-[11px] font-semibold text-red-300 rounded-lg transition disabled:opacity-40 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{isCleaning ? t("Đang xóa...", "Deleting...") : t("Xóa đã chọn", "Delete selected")}</span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
