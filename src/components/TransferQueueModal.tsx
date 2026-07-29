import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import {
  ChevronDown,
  ChevronUp,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  X,
} from "lucide-react";
import { useTransfer } from "../contexts/TransferContext";
import TransferJobItem from "./TransferJobItem";
import TransferConflictDialog from "./TransferConflictDialog";
import type { TransferJobView, TransferStatus } from "../types/transfer";
import { useExplorer } from "../useExplorer";

/**
 * TransferQueueModal
 *
 * Floating overlay anchored to the bottom-right of the main window.
 * Renders nothing when the queue is empty so it never blocks the
 * viewport. When at least one job exists, shows a compact summary
 * header; expanding the header reveals the per-job cards.
 *
 * Positioning rules:
 *  - z-index 80 (below NewItemModal z=200, above main content).
 *  - pointer-events: none on the wrapper, auto on the card so clicks
 *    pass through empty space to the explorer behind.
 */
export default function TransferQueueModal() {
  const { jobs, activeCount, queuedCount, hasFailures, conflicts, dismiss } =
    useTransfer();
  const explorer = useExplorer();
  const accentColor = explorer.accentColor;

  const [expanded, setExpanded] = useState<boolean>(true);
  const wasNonEmptyRef = useRef<boolean>(false);
  const failedJobsRef = useRef<Set<string>>(new Set());

  // Sort: running first, then queued, then everything else by insertion order
  const ordered = useMemo<TransferJobView[]>(() => {
    const rank = (s: TransferStatus): number => {
      switch (s) {
        case "running": return 0;
        case "queued": return 1;
        case "paused": return 2;
        case "partial_success": return 3;
        case "failed": return 4;
        case "cancelled": return 5;
        case "completed": return 6;
        default: return 7;
      }
    };
    return [...jobs].sort((a, b) => {
      const r = rank(a.status) - rank(b.status);
      if (r !== 0) return r;
      return a.id < b.id ? -1 : 1;
    });
  }, [jobs]);

  // Count of conflicts per job — used for inline badges.
  const conflictCountByJob = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const c of conflicts) {
      map[c.job_id] = (map[c.job_id] ?? 0) + 1;
    }
    return map;
  }, [conflicts]);

  // Helper function - must be defined before useEffects that call it
  const handleDismissFinished = useCallback(() => {
    const finishedIds = jobs
      .filter(
        (j) =>
          j.status === "completed" ||
          j.status === "cancelled" ||
          j.status === "failed" ||
          j.status === "partial_success",
      )
      .map((j) => j.id);
    if (finishedIds.length > 0) {
      // Log dismiss intent to help diagnose "X button doesn't close the modal"
      // bugs — if the count is 0 the reducer won't change state, which is the
      // most common reason for a no-op close button.
      console.debug(
        `[TransferQueueModal] handleDismissFinished: removing ${finishedIds.length} terminal job(s)`,
        finishedIds,
      );
    }
    finishedIds.forEach((id) => dismiss(id));
  }, [jobs, dismiss]);

  // Auto-dismiss terminal (finished) jobs immediately when no active jobs remain
  useEffect(() => {
    const terminalJobs = jobs.filter(
      (j) =>
        j.status === "completed" ||
        j.status === "cancelled" ||
        j.status === "failed" ||
        j.status === "partial_success",
    );

    const hasActive = jobs.some(
      (j) => j.status === "running" || j.status === "paused" || j.status === "queued",
    );

    // Dismiss immediately if all jobs are terminal (no active work)
    if (terminalJobs.length > 0 && !hasActive) {
      // Small delay to let final status render first
      const timer = setTimeout(() => {
        handleDismissFinished();
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [jobs, handleDismissFinished]);

  // Auto-close window after 10s when there are failed jobs and no active work
  useEffect(() => {
    const failedJobs = jobs.filter((j) => j.status === "failed");
    const hasActive = jobs.some(
      (j) => j.status === "running" || j.status === "paused" || j.status === "queued",
    );

    // If there are failed jobs and no active work, set a 10s timer to dismiss
    if (failedJobs.length > 0 && !hasActive) {
      // Find newly failed jobs (not in our tracking set)
      const newFailedJobIds = failedJobs
        .map((j) => j.id)
        .filter((id) => !failedJobsRef.current.has(id));

      // Track all failed job IDs
      failedJobs.forEach((j) => failedJobsRef.current.add(j.id));

      // Only start timer for newly failed jobs
      if (newFailedJobIds.length > 0) {
        const timer = setTimeout(() => {
          // Dismiss all failed jobs
          failedJobs.forEach((j) => dismiss(j.id));
          failedJobsRef.current.clear();
        }, 10000); // 10 seconds
        return () => clearTimeout(timer);
      }
    } else if (hasActive) {
      // Clear failed tracking when work resumes
      failedJobsRef.current.clear();
    }

    return () => {};
  }, [jobs, dismiss]);

  // Keyboard shortcut: Escape to close the window
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if transfer window is visible
      if (e.key === "Escape" && jobs.length > 0) {
        handleDismissFinished();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [jobs, handleDismissFinished]);

  // Auto-expand when a new job appears.
  useEffect(() => {
    if (jobs.length > 0) {
      wasNonEmptyRef.current = true;
      setExpanded((prev) => (prev ? prev : true));
    }
  }, [jobs.length]);

  // Don't render if queue is empty - MUST be after all hooks
  if (jobs.length === 0) {
    return null;
  }

  const isWorking = activeCount > 0 || queuedCount > 0;
  const isVi = explorer.language === "en" ? false : true;

  const summaryIcon = isWorking ? (
    <Loader2 className="w-4 h-4 animate-spin" style={{ color: accentColor }} />
  ) : hasFailures ? (
    <AlertTriangle className="w-4 h-4 text-red-400" />
  ) : (
    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
  );

  const headerLabel = isWorking
    ? `${activeCount > 0 ? `${activeCount} active` : ""}${
        activeCount > 0 && queuedCount > 0 ? " · " : ""
      }${queuedCount > 0 ? `${queuedCount} queued` : ""}`
    : hasFailures
      ? "1+ failed"
      : "Done";

  // Dark theme only — use CSS variable so theme switching updates bg automatically
  const cardBg = "var(--app-bg)";
  const cardBorderStyle =
    "1px solid rgba(255,255,255,0.10)";
  const headerHover = "hover:bg-white/[0.03]";
  const textPrimary = "text-stone-200";
  const textMuted = "text-stone-400";
  const textMuted2 = "text-stone-400";
  const chevronCls = "text-stone-500";
  const dividerColor = "rgba(255,255,255,0.05)";

  return (
    <div
      className="fixed bottom-4 right-4 z-[80] pointer-events-none flex flex-col items-end gap-2"
      style={{ maxWidth: "min(440px, calc(100vw - 32px))" }}
      data-testid="transfer-queue-modal"
    >
      {/* Conflict dialog — inline panel ABOVE the queue, no backdrop */}
      {conflicts.length > 0 && (
        <div className="w-full pointer-events-auto">
          <TransferConflictDialog
            accentColor={accentColor}
            language={explorer.language}
          />
        </div>
      )}

      {/* Header card */}
      <div
        className="pointer-events-auto w-full rounded-xl shadow-2xl overflow-hidden backdrop-blur-md"
        style={{
          background: cardBg,
          border: cardBorderStyle,
        }}
      >
        {/* Header row: icon + label + conflict badge + action buttons */}
        <div
          className={`flex items-center gap-2 px-3.5 py-2.5 ${headerHover} transition-colors cursor-pointer`}
          onClick={() => setExpanded((v) => !v)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v); }}
        >
          {summaryIcon}

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className={`text-sm font-semibold ${textPrimary}`}>
                File Transfers
              </span>
              <span className={`text-[10px] uppercase tracking-wider font-medium ${textMuted}`}>
                {jobs.length} job{jobs.length === 1 ? "" : "s"}
              </span>
              {conflicts.length > 0 && (
                <span
                  className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-[1px] rounded-full bg-amber-500/20 text-amber-300"
                  title={
                    isWorking
                      ? (isVi ? "Xung đột đang chờ xử lý" : "Conflicts awaiting your decision")
                      : (isVi ? "Xung đột chưa xử lý" : "Unresolved conflicts")
                  }
                >
                  {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <div className={`text-[11px] mt-0.5 truncate ${textMuted2}`}>
              {headerLabel}
            </div>
          </div>

          {/* Action buttons — separate from header click area */}
          <div className="flex items-center gap-1 shrink-0">
            {/* Close button - always visible. Dismisses ALL terminal jobs in
                the queue. We intentionally call this with a per-job loop so
                that any in-flight progress / status event that races against
                the dispatch can't undo the dismiss. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleDismissFinished();
              }}
              className="p-1.5 rounded-lg transition cursor-pointer text-stone-500 hover:text-stone-200 hover:bg-white/10"
              title={isVi ? "Đóng (Esc)" : "Close (Esc)"}
            >
              <X className="w-3.5 h-3.5" />
            </button>
            {expanded ? (
              <ChevronDown className={`w-4 h-4 ${chevronCls}`} />
            ) : (
              <ChevronUp className={`w-4 h-4 ${chevronCls}`} />
            )}
          </div>
        </div>

        {/* Job list */}
        {expanded && (
          <div
            className="border-t max-h-[60vh] overflow-y-auto goku-thin-scroll"
            style={{ borderColor: dividerColor }}
          >
            {ordered.map((job) => (
              <TransferJobItem
                key={job.id}
                job={job}
                accentColor={accentColor}
                conflictCount={conflictCountByJob[job.id] ?? 0}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
