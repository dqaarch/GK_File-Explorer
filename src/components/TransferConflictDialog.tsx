/**
 * TransferConflictDialog
 *
 * Inline conflict resolution card that floats ABOVE the TransferQueue.
 * Mirrors the TeraCopy / Windows 11 Transfer UI pattern:
 *   - No backdrop blur — it sits naturally above the queue
 *   - Source vs destination comparison rows
 *   - Replace / Skip / Keep Both action buttons
 *   - "Apply to all remaining conflicts" toggle
 *
 * The component reads the first pending conflict from the TransferContext
 * and renders nothing when the conflict queue is empty.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Copy as CopyIcon,
  Scissors,
  AlertTriangle,
  Folder,
  File as FileIcon,
  CheckCircle2,
  CornerDownRight,
} from "lucide-react";
import { useTransfer } from "../contexts/TransferContext";
import { joinPath } from "../TauriFileSystem";
import type { ConflictKind } from "../types/transfer";

interface TransferConflictDialogProps {
  accentColor: string;
  language: "vi" | "en";
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.substring(idx + 1) : path;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.substring(0, idx) : "";
}

export default function TransferConflictDialog({
  accentColor,
  language,
}: TransferConflictDialogProps) {
  const isVi = language === "vi";
  const { conflicts, jobs } = useTransfer();

  const currentConflict = conflicts[0] ?? null;
  const currentJob = currentConflict
    ? jobs.find((j) => j.id === currentConflict.job_id) ?? null
    : null;

  const preview = useMemo<{
    kind: ConflictKind;
    mode: "copy" | "move";
    sourceName: string;
    sourceDir: string;
    destName: string;
    destDir: string;
    sourceIsDir: boolean;
    destIsDir: boolean;
    conflictCount: number;
  } | null>(() => {
    if (!currentConflict || !currentJob) return null;
    return {
      kind: currentConflict.kind,
      mode: currentJob.mode,
      sourceName: basename(currentConflict.source),
      sourceDir: dirname(currentConflict.source),
      destName: basename(currentConflict.destination),
      destDir: dirname(currentConflict.destination),
      sourceIsDir: currentConflict.kind === "directory",
      destIsDir: currentConflict.kind === "directory",
      conflictCount: conflicts.length,
    };
  }, [currentConflict, currentJob, conflicts.length]);

  const [applyToAll, setApplyToAll] = useState<boolean>(true);

  useEffect(() => {
    if (conflicts.length === 0) setApplyToAll(true);
  }, [conflicts.length]);

  const resolve = useCallback(
    async (base: "replace" | "skip" | "keep_both") => {
      if (!currentConflict || !currentJob) return;
      const action: "replace" | "skip" | "keep_both" | "replace_all" | "skip_all" =
        applyToAll
          ? base === "replace"
            ? "replace_all"
            : base === "skip"
              ? "skip_all"
              : "keep_both"
          : base;

      try {
        const { resolveConflict } = await import("../TauriFileSystem");
        await resolveConflict(currentJob.id, 0, action);
      } catch (err) {
        console.error("[ConflictDialog] resolve failed", err);
      }
    },
    [currentConflict, currentJob, applyToAll],
  );

  if (!currentConflict || !preview) return null;

  const ModeIcon = preview.mode === "move" ? Scissors : CopyIcon;

  // Use CSS variable so theme switching updates bg automatically
  const bg = "var(--app-bg)";
  const border =
    "1px solid rgba(255,255,255,0.10)";
  const mutedText = "text-stone-400";
  const mainText = "text-stone-100";
  const cardBg = "rgba(255,255,255,0.04)";
  const warningCardBg = "rgba(245, 158, 11, 0.10)";
  const warningBorder = "1px solid rgba(245, 158, 11, 0.25)";

  return (
    <div
      className="w-full pointer-events-auto"
      style={{ maxWidth: "min(440px, calc(100vw - 32px))" }}
      data-testid="transfer-conflict-dialog"
    >
      <div
        className="absolute top-0 left-0 right-0 h-[3px] rounded-t-2xl"
        style={{
          background: `linear-gradient(90deg, ${accentColor} 0%, ${accentColor}aa 100%)`,
        }}
      />

      <div
        className="rounded-2xl shadow-2xl overflow-hidden"
        style={{
          background: bg,
          border,
          boxShadow: `0 8px 32px -8px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04)`,
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-2.5">
          <div
            className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
            style={{ background: `${accentColor}22`, color: accentColor }}
          >
            <AlertTriangle className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-[13px] font-semibold leading-tight ${mainText}`}>
              {isVi
                ? "File đã tồn tại — thay thế, bỏ qua, hay giữ cả hai?"
                : "File already exists — Replace, Skip, or Keep Both?"}
            </div>
            {preview.conflictCount > 1 && (
              <div className={`text-[11px] mt-0.5 ${mutedText}`}>
                {preview.conflictCount - 1}{" "}
                {isVi ? "xung đột khác đang chờ" : "other conflict(s) queued"}
              </div>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="px-4 pb-4">
          {/* Source | Arrow | Destination */}
          <div className="grid grid-cols-[1fr_20px_1fr] gap-1.5 items-stretch">
            <div
              className="rounded-lg px-2.5 py-2 min-w-0"
              style={{ background: cardBg, border: "1px solid transparent" }}
            >
              <div
                className="text-[9px] font-semibold uppercase tracking-wider mb-1"
                style={{ color: "#94a3b8" }}
              >
                {isVi ? "Nguồn" : "Source"}
              </div>
              <FileRow
                name={preview.sourceName}
                dir={preview.sourceDir}
                path={joinPath(preview.sourceDir, preview.sourceName)}
                isDir={preview.sourceIsDir}
              />
            </div>

            <div className={`flex items-center justify-center ${mutedText}`} aria-hidden>
              <ArrowRight className="w-3.5 h-3.5" />
            </div>

            <div
              className="rounded-lg px-2.5 py-2 min-w-0"
              style={{ background: warningCardBg, border: warningBorder }}
            >
              <div
                className="text-[9px] font-semibold uppercase tracking-wider mb-1"
                style={{ color: "#fbbf24" }}
              >
                {isVi ? "Đã có tại đích" : "Already exists"}
              </div>
              <FileRow
                name={preview.destName}
                dir={preview.destDir}
                path={joinPath(preview.destDir, preview.destName)}
                isDir={preview.destIsDir}
              />
            </div>
          </div>

          {/* Mode label */}
          <div className={`mt-2 flex items-center gap-1.5 text-[10.5px] ${mutedText}`}>
            <ModeIcon
              className="w-3 h-3"
              style={{
                color:
                  preview.mode === "move"
                    ? "#7dd3fc"
                    : "#6ee7b7",
              }}
            />
            <span>
              {preview.mode === "move"
                ? isVi ? "Di chuyển vào:" : "Moving into:"
                : isVi ? "Sao chép vào:" : "Copying into:"}
            </span>
            <code
              className="px-1.5 py-[1px] rounded text-[10px] truncate max-w-[180px] inline-block bg-white/5 text-stone-300"
              title={preview.destDir}
            >
              {preview.destDir}
            </code>
          </div>

          {/* Actions */}
          <div
            className="mt-3 flex items-center flex-wrap gap-1.5"
            style={{
              borderTop: "1px solid rgba(255,255,255,0.05)",
              paddingTop: "10px",
            }}
          >
            <label
              className="flex items-center gap-1 text-[11px] cursor-pointer select-none mr-auto text-stone-400 hover:text-stone-200"
            >
              <input
                type="checkbox"
                checked={applyToAll}
                onChange={(e) => setApplyToAll(e.target.checked)}
                className="cursor-pointer"
                style={{ accentColor }}
              />
              <CornerDownRight className="w-3 h-3" />
              <span>{isVi ? "Áp cho tất cả còn lại" : "Apply to all"}</span>
            </label>

            <button
              type="button"
              onClick={() => void resolve("keep_both")}
              className="px-3 py-1.5 rounded-lg text-[11.5px] font-medium transition cursor-pointer text-stone-300 hover:bg-white/10"
            >
              {isVi ? "Giữ cả hai" : "Keep Both"}
            </button>

            <button
              type="button"
              onClick={() => void resolve("skip")}
              className="px-3 py-1.5 rounded-lg text-[11.5px] font-medium transition cursor-pointer text-stone-300 hover:bg-white/10"
            >
              {isVi ? "Bỏ qua" : "Skip"}
            </button>

            <button
              type="button"
              onClick={() => void resolve("replace")}
              className="px-3 py-1.5 rounded-lg text-[11.5px] font-semibold transition cursor-pointer flex items-center gap-1.5 text-white"
              style={{
                background: `linear-gradient(180deg, ${accentColor} 0%, ${accentColor}dd 100%)`,
                boxShadow: `0 1px 0 ${accentColor}55 inset, 0 4px 12px -2px ${accentColor}55`,
              }}
            >
              <CheckCircle2 className="w-3 h-3" />
              {isVi ? "Thay thế" : "Replace"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface FileRowProps {
  name: string;
  dir: string;
  path: string;
  isDir: boolean;
}

function FileRow({ name, dir, path, isDir }: FileRowProps) {
  const mainText = "text-stone-100";
  const muted = "text-stone-400";
  return (
    <div className="flex items-start gap-1.5 min-w-0">
      <div className="shrink-0 mt-0.5">
        {isDir ? (
          <Folder className="w-3.5 h-3.5" style={{ color: "#fcd34d" }} />
        ) : (
          <FileIcon className={`w-3.5 h-3.5 ${muted}`} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className={`text-[12px] font-medium truncate ${mainText}`} title={name}>
          {name}
        </div>
        <div className={`text-[10px] truncate ${muted}`} title={dir}>
          {dir}
        </div>
      </div>
    </div>
  );
}
