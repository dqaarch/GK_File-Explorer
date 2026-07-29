import React from "react";
import { FSItem } from "../types";
import { Folder, File, X, Check, Calendar, Database, HardDrive, FileImage, Music, Film, Code, Archive } from "lucide-react";
import { normalizeThumbnailSrc } from "../utils/thumbnail";

interface SelectionInspectorProps {
  selectedItems: FSItem[];
  thumbs: Record<string, string | null>;
  accentColor: string;
  onClose: () => void;
}

export default function SelectionInspector({
  selectedItems,
  thumbs,
  accentColor,
  onClose,
}: SelectionInspectorProps) {
  if (selectedItems.length <= 1) return null;

  const bgColor = "bg-elevated";
  const borderColor = "border-white/10";
  const headerBg = "bg-[var(--app-bg)]";
  const textColor = "text-stone-200";
  const mutedColor = "text-stone-400";
  const labelColor = "text-stone-400";

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const formatDate = (dateStr: string | undefined) => {
    if (!dateStr) return "Unknown";
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  const getFileIcon = (item: FSItem) => {
    const ext = item.name.split(".").pop()?.toLowerCase();

    if (item.type === "directory") {
      return <Folder className="w-16 h-16 text-amber-400" fill="currentColor" />;
    }

  const thumbSrc = normalizeThumbnailSrc(thumbs[item.path]);
  if (thumbSrc) {
    return (
      <img
        src={thumbSrc}
          alt={item.name}
          className="w-16 h-16 object-contain"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      );
    }

    switch (ext) {
      case "mp3": case "wav": case "flac": case "aac": case "ogg": case "m4a": case "wma":
        return <div className="w-16 h-16 bg-emerald-500/20 rounded-lg flex items-center justify-center"><Music className="w-8 h-8 text-emerald-400" /></div>;
      case "mp4": case "avi": case "mkv": case "mov": case "wmv": case "webm":
        return <div className="w-16 h-16 bg-purple-500/20 rounded-lg flex items-center justify-center"><Film className="w-8 h-8 text-purple-400" /></div>;
      case "jpg": case "jpeg": case "png": case "gif": case "webp": case "bmp": case "svg": case "ico": case "tiff":
        return <div className="w-16 h-16 bg-blue-500/20 rounded-lg flex items-center justify-center"><FileImage className="w-8 h-8 text-blue-400" /></div>;
      case "pdf":
        return <div className="w-16 h-16 bg-red-500/20 rounded-lg flex items-center justify-center"><File className="w-8 h-8 text-red-400" /></div>;
      case "zip": case "rar": case "7z": case "tar": case "gz": case "bz2":
        return <div className="w-16 h-16 bg-yellow-500/20 rounded-lg flex items-center justify-center"><Archive className="w-8 h-8 text-yellow-400" /></div>;
      case "js": case "ts": case "tsx": case "jsx": case "py": case "rs": case "go": case "java": case "c": case "cpp": case "h": case "hpp": case "cs": case "rb": case "php":
        return <div className="w-16 h-16 bg-cyan-500/20 rounded-lg flex items-center justify-center"><Code className="w-8 h-8 text-cyan-400" /></div>;
      default:
        return <div className="w-16 h-16 bg-stone-500/20 rounded-lg flex items-center justify-center"><File className="w-8 h-8 text-stone-400" /></div>;
    }
  };

  // Calculate totals
  const totalSize = selectedItems.reduce((sum, item) => sum + (item.size || 0), 0);
  const fileCount = selectedItems.filter(i => i.type === "file").length;
  const folderCount = selectedItems.filter(i => i.type === "directory").length;

  return (
    <div
      className={`absolute top-0 right-0 bottom-0 ${bgColor} ${borderColor} border-l shadow-2xl z-40 overflow-hidden flex flex-col`}
      style={{ width: "320px" }}
    >
      {/* Header */}
      <div className={`flex items-center justify-between px-4 py-3 ${headerBg} ${borderColor} border-b`}>
        <div className={`flex items-center gap-2 ${textColor}`}>
          <Check className="w-4 h-4" style={{ color: accentColor }} />
          <span className="text-sm font-semibold">
            {selectedItems.length} selected
          </span>
        </div>
        <button
          onClick={onClose}
          className={`p-1 rounded hover:bg-black/10 ${mutedColor} transition-colors`}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Thumbnail Preview */}
        <div className="p-4 flex flex-col items-center border-b ${borderColor}">
          <div className="relative">
            {getFileIcon(selectedItems[0])}
          </div>
          <p className={`mt-3 text-sm font-medium text-center ${textColor} px-2`} title={selectedItems[0].name}>
            {selectedItems[0].name}
          </p>
          {selectedItems.length > 1 && (
            <p className={`text-xs ${mutedColor} mt-1`}>
              + {selectedItems.length - 1} more item{selectedItems.length - 1 > 1 ? "s" : ""}
            </p>
          )}
        </div>

        {/* Selection Info */}
        <div className={`p-4 space-y-3 ${borderColor} border-b`}>
          <div className="flex items-center gap-3">
            <HardDrive className={`w-4 h-4 ${mutedColor} shrink-0`} />
            <div className="flex-1">
              <p className={`text-[10px] uppercase tracking-wide ${labelColor}`}>Total Size</p>
              <p className={`text-sm font-medium ${textColor}`}>{formatSize(totalSize)}</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Database className={`w-4 h-4 ${mutedColor} shrink-0`} />
            <div className="flex-1">
              <p className={`text-[10px] uppercase tracking-wide ${labelColor}`}>Contains</p>
              <p className={`text-sm ${textColor}`}>
                {fileCount > 0 && <span>{fileCount} file{fileCount > 1 ? "s" : ""}</span>}
                {fileCount > 0 && folderCount > 0 && <span>, </span>}
                {folderCount > 0 && <span>{folderCount} folder{folderCount > 1 ? "s" : ""}</span>}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Calendar className={`w-4 h-4 ${mutedColor} shrink-0`} />
            <div className="flex-1">
              <p className={`text-[10px] uppercase tracking-wide ${labelColor}`}>Modified</p>
              <p className={`text-sm ${textColor}`}>{formatDate(selectedItems[0].updatedAt)}</p>
            </div>
          </div>
        </div>

        {/* All Selected Items List */}
        <div className="p-4">
          <p className={`text-[10px] uppercase tracking-wide ${labelColor} mb-3`}>Selected Items</p>
          <div className="space-y-1 max-h-48 overflow-y-auto goku-thin-scroll">
            {selectedItems.map((item) => (
              <div
                key={item.id}
                className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/5 transition-colors`}
              >
                <div className="shrink-0">
                  {item.type === "directory" ? (
                    <Folder className="w-4 h-4 text-amber-400 shrink-0" fill="currentColor" />
                  ) : (
                    <File className="w-4 h-4 text-stone-400" />
                  )}
                </div>
                <span className={`flex-1 truncate ${textColor}`} title={item.name}>
                  {item.name}
                </span>
                <span className={`text-[10px] font-mono ${mutedColor} shrink-0`}>
                  {item.type === "directory" ? "Folder" : formatSize(item.size)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
