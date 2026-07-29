import { useCallback, useMemo } from "react";
import {
  Pause,
  Play,
  X,
  Copy as CopyIcon,
  Scissors,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Folder,
  File as FileIcon,
  GitMerge,
  ChevronRight,
} from "lucide-react";
import { useTransfer } from "../contexts/TransferContext";
import type { TransferJobView } from "../types/transfer";
import {
  formatBytes,
  formatEta,
  formatThroughput,
  percent,
  statusLabel,
} from "../utils/transferUtils";

interface TransferJobItemProps {
  job: TransferJobView;
  /** Accent color used for the gradient progress bar and primary accents. */
  accentColor: string;
  /** Number of pending conflicts for THIS job. Drives the conflict badge. */
  conflictCount?: number;
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

function isDirectoryPath(path: string): boolean {
  if (path.endsWith("/") || path.endsWith("\\")) return true;
  const base = basename(path);
  return !base.includes(".");
}

/**
 * Build a lighter/darker variant of an accent color for gradient stops.
 * We use a tiny mix-in-place helper so the gradient always matches the
 * user-chosen accent without needing extra Tailwind config.
 */
function withAlpha(hex: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function lighten(hex: string, amount: number): string {
  // amount in [0,1]: 0 = original, 1 = white
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const mix = (c: number) =>
    Math.round(c + (255 - c) * Math.max(0, Math.min(1, amount)));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

export default function TransferJobItem({
  job,
  accentColor,
  conflictCount = 0,
}: TransferJobItemProps) {
  const { pause, resume, cancel, dismiss, language } = useTransfer();
  const lang: "vi" | "en" = language === "en" ? "en" : "vi";
  const isVi = lang === "vi";

  const onPause = useCallback(() => {
    void pause(job.id);
  }, [pause, job.id]);

  const onResume = useCallback(() => {
    void resume(job.id);
  }, [resume, job.id]);

  const onCancel = useCallback(() => {
    void cancel(job.id);
  }, [cancel, job.id]);

  const onDismiss = useCallback(() => {
    dismiss(job.id);
  }, [dismiss, job.id]);

  // ── Derived display state ──────────────────────────────────────────────
  const isActive =
    job.status === "running" ||
    job.status === "paused" ||
    job.status === "queued";
  const isTerminal =
    job.status === "completed" ||
    job.status === "cancelled" ||
    job.status === "failed" ||
    job.status === "partial_success";

  const pct = percent(job.bytes_done, job.bytes_total);
  const sourceCount = job.source_paths.length;
  const firstSource = job.source_paths[0];
  const firstIsDir = firstSource ? isDirectoryPath(firstSource) : false;

  const title =
    sourceCount === 1
      ? basename(firstSource ?? "")
      : sourceCount === 2
        ? `${basename(job.source_paths[0])} + 1`
        : `${basename(job.source_paths[0])} + ${sourceCount - 1}`;

  // Subtitle: where the item lives (source dir).
  const sourceDir =
    sourceCount === 1 && firstSource
      ? dirname(firstSource)
      : isVi
        ? `${sourceCount} mục đã chọn`
        : `${sourceCount} items selected`;

  const targetDir = job.target_dir;
  const targetName = targetDir ? basename(targetDir.replace(/[\\/]+$/, "")) : "";

  const ModeIcon = job.mode === "move" ? Scissors : CopyIcon;
  const modeColor =
    job.mode === "move"
      ? "text-sky-400"
      : "text-emerald-400";
  const modeLabel =
    job.mode === "move"
      ? isVi
        ? "Di chuyển"
        : "Move"
      : isVi
        ? "Sao chép"
        : "Copy";

  // ── Progress bar gradient ──────────────────────────────────────────────
  // The gradient blends the user's accent color with a lighter variant so
  // the bar feels alive (TeraCopy / modern Explorer look).
  const progressGradient = useMemo(() => {
    const light = lighten(accentColor, 0.35);
    return `linear-gradient(90deg, ${accentColor} 0%, ${light} 100%)`;
  }, [accentColor]);

  // Track tints follow the same scheme but softer (used for the bar track
  // background and row separators).
  const trackBg = "rgba(255, 255, 255, 0.06)";

  // ── Status icon ───────────────────────────────────────────────────────
  const StatusIcon = (() => {
    switch (job.status) {
      case "completed":
        return CheckCircle2;
      case "failed":
        return AlertCircle;
      case "partial_success":
        return AlertTriangle;
      case "cancelled":
        return X;
      default:
        return null;
    }
  })();
  const statusIconClass = (() => {
    switch (job.status) {
      case "completed":
        return "text-emerald-400";
      case "failed":
        return "text-red-400";
      case "partial_success":
        return "text-amber-400";
      case "cancelled":
        return "text-stone-500";
      default:
        return "text-stone-400";
    }
  })();

  // Width of the progress fill.
  const fillWidth =
    job.status === "completed" || job.status === "partial_success"
      ? "100%"
      : `${pct}%`;

  // Conflict prompt state — the inline banner shown when a job has
  // unresolved conflicts waiting for user input.
  const hasConflicts = conflictCount > 0;

  return (
    <div
      className="px-3.5 py-3 border-b border-white/5 last:border-b-0 hover:bg-white/[0.02] transition-colors"
      data-testid="transfer-job-item"
      data-job-id={job.id}
      data-status={job.status}
    >

      {/* Header row: source icon + title + mode + action buttons */}
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 mt-0.5">
          {firstIsDir && firstSource ? (
            <Folder className="w-4 h-4" style={{ color: "#fcd34d" }} />
          ) : (
            <FileIcon
              className="w-4 h-4 text-stone-400"
            />
          )}
        </div>

        <div className="flex-1 min-w-0">
          {/* Title + mode pill */}
          <div className="flex items-center gap-1.5">
            <ModeIcon className={`w-3 h-3 shrink-0 ${modeColor}`} />
            <span
              className="text-[12.5px] font-medium truncate text-stone-200"
              title={firstSource ?? ""}
            >
              {title}
            </span>
            <span
              className={`text-[10px] shrink-0 px-1.5 py-[1px] rounded-full ${
                job.mode === "move"
                  ? "bg-sky-500/15 text-sky-300"
                  : "bg-emerald-500/15 text-emerald-300"
              }`}
            >
              {modeLabel}
            </span>
          </div>

          {/* Source line (where it's coming from) */}
          <div
            className="mt-0.5 flex items-center gap-1 text-[10.5px] truncate text-stone-500"
            title={typeof sourceDir === "string" ? sourceDir : undefined}
          >
            <span className="truncate">
              {typeof sourceDir === "string" ? sourceDir : ""}
            </span>
          </div>

          {/* Arrow to destination + destination */}
          <div
            className="mt-0.5 flex items-center gap-1 text-[10.5px] truncate text-stone-500"
            title={targetDir}
          >
            <ChevronRight
              className="w-3 h-3 shrink-0"
              style={{ color: accentColor }}
            />
            <span className="truncate">
              {targetName ? (
                <>
                  <span
                    className="text-stone-300"
                  >
                    {targetName}
                  </span>
                  {targetDir && targetDir !== targetName && (
                    <span className="text-stone-500"> · {targetDir}</span>
                  )}
                </>
              ) : (
                targetDir
              )}
            </span>
          </div>

          {/* Status line */}
          <div
            className="mt-1 flex items-center gap-1.5 text-[11px] text-stone-400"
          >
            {StatusIcon && (
              <StatusIcon className={`w-3 h-3 shrink-0 ${statusIconClass}`} />
            )}
            <span>{statusLabel(job.status, lang)}</span>
            {job.status === "running" && job.current_file && (
              <span className="truncate text-stone-500">
                · {basename(job.current_file)}
              </span>
            )}
            {job.failed_items.length > 0 && (
              <span className="text-red-400">
                · {job.failed_items.length} {isVi ? "lỗi" : "failed"}
              </span>
            )}
            {hasConflicts && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full text-[10px] font-medium bg-amber-500/20 text-amber-300"
                title={
                  isVi
                    ? `${conflictCount} xung đột đang chờ xử lý`
                    : `${conflictCount} conflict(s) awaiting your decision`
                }
              >
                <GitMerge className="w-2.5 h-2.5" />
                {conflictCount}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {isActive && job.status !== "queued" && (
            <button
              type="button"
              onClick={job.status === "paused" ? onResume : onPause}
              className="p-1.5 rounded-md transition cursor-pointer text-stone-400 hover:text-stone-100 hover:bg-white/10"
              title={
                job.status === "paused"
                  ? isVi
                    ? "Tiếp tục"
                    : "Resume"
                  : isVi
                    ? "Tạm dừng"
                    : "Pause"
              }
            >
              {job.status === "paused" ? (
                <Play className="w-3.5 h-3.5" />
              ) : (
                <Pause className="w-3.5 h-3.5" />
              )}
            </button>
          )}
          {(isActive || isTerminal) && (
            <button
              type="button"
              onClick={isActive ? onCancel : onDismiss}
              className="p-1.5 rounded-md transition cursor-pointer text-stone-400 hover:text-red-300 hover:bg-white/10"
              title={
                isActive
                  ? isVi
                    ? "Hủy thao tác"
                    : "Cancel"
                  : isVi
                    ? "Đóng"
                    : "Dismiss"
              }
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Progress bar — gradient fill driven by the user accent color.
          Hidden for queued jobs (nothing to show yet). */}
      {job.status !== "queued" && (
        <div className="mt-2.5">
          <div
            className="relative h-[6px] w-full rounded-full overflow-hidden"
            style={{ background: trackBg }}
          >
            {/* Faint shine overlay so the bar feels "filled" even at 0% */}
            <div
              className="absolute inset-0 opacity-50 pointer-events-none"
              style={{
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(0,0,0,0.18) 100%)",
                mixBlendMode: "overlay",
              }}
            />
            <div
              className="relative h-full rounded-full transition-all duration-200 ease-out"
              style={{
                width: fillWidth,
                background: progressGradient,
                boxShadow: pct > 0 ? `0 0 8px ${withAlpha(accentColor, 0.45)}` : "none",
              }}
            />
          </div>

          {/* Numeric line: bytes / files / throughput / ETA */}
          <div
            className="mt-1.5 flex items-center justify-between gap-2 text-[10.5px] tabular-nums text-stone-500"
          >
            <span>
              <span style={{ color: accentColor }} className="font-medium">
                {formatBytes(job.bytes_done)}
              </span>
              <span> / {formatBytes(job.bytes_total)}</span>
              {job.files_total > 0 && (
                <span className="text-stone-500/80">
                  {" · "}
                  {job.files_done}/{job.files_total} {isVi ? "tệp" : "files"}
                </span>
              )}
            </span>
            {job.status === "running" && (
              <span className="flex items-center gap-2">
                <span>{formatThroughput(job.throughput_bps)}</span>
                <span className="text-stone-600">·</span>
                <span>
                  {isVi ? "còn" : "eta"} {formatEta(job.eta_seconds)}
                </span>
              </span>
            )}
            {job.status === "paused" && (
              <span className="text-amber-500">
                {isVi ? "Đã tạm dừng" : "Paused"}
              </span>
            )}
            {job.status === "completed" && (
              <span
                className="font-medium"
                style={{ color: "#34d399" }}
              >
                {isVi ? "Hoàn tất" : "Done"}
              </span>
            )}
            {job.status === "failed" && (
              <span className="font-medium text-red-500">
                {isVi ? "Thất bại" : "Failed"}
              </span>
            )}
            {job.status === "partial_success" && (
              <span className="font-medium text-amber-500">
                {isVi ? "Một phần" : "Partial"}
              </span>
            )}
            {job.status === "cancelled" && (
              <span className="text-stone-500">
                {isVi ? "Đã hủy" : "Cancelled"}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
