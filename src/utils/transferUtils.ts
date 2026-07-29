/**
 * Small formatter helpers for the transfer UI. Keep them dependency-free
 * (no Intl.RelativeTimeFormat shenanigans) so they work identically in
 * the dev preview and the bundled Tauri webview.
 */

/**
 * Human-readable byte count. Always uses 1024-base (binary), matching
 * Windows Explorer.
 *   0   -> "0 B"
 *   512 -> "512 B"
 *   1536 -> "1.5 KB"
 *   5 GB -> "5.0 GB"
 */
export function formatBytes(bytes: number, fractionDigits: number = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const k = 1024;
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(k)),
  );
  const value = bytes / Math.pow(k, i);
  // For bytes (< 1 KB), no decimal.
  const digits = i === 0 ? 0 : fractionDigits;
  return `${value.toFixed(digits)} ${units[i]}`;
}

/**
 * Throughput in bytes/second -> "84.3 MB/s" (auto-scales to GB/s).
 */
export function formatThroughput(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "—";
  // Use the same byte formatter but append "/s".
  return `${formatBytes(bps)}/s`;
}

/**
 * Seconds -> "0:09" / "1:23" / "1:02:30".
 */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  if (seconds === 0) return "0s";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${sec
      .toString()
      .padStart(2, "0")}`;
  }
  if (m > 0) {
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }
  return `${sec}s`;
}

/**
 * Translate the most common status codes into a short, user-facing
 * label. The caller is responsible for i18n if needed.
 */
export function statusLabel(
  status:
    | "queued"
    | "running"
    | "paused"
    | "completed"
    | "cancelled"
    | "failed"
    | "partial_success",
  language: "vi" | "en" = "vi",
): string {
  const dict: Record<string, { vi: string; en: string }> = {
    queued: { vi: "Đang chờ", en: "Queued" },
    running: { vi: "Đang chuyển", en: "Transferring" },
    paused: { vi: "Tạm dừng", en: "Paused" },
    completed: { vi: "Hoàn tất", en: "Completed" },
    cancelled: { vi: "Đã hủy", en: "Cancelled" },
    failed: { vi: "Lỗi", en: "Failed" },
    partial_success: { vi: "Hoàn tất một phần", en: "Partial success" },
  };
  return dict[status]?.[language] ?? status;
}

/**
 * Progress percent with one decimal, clamped to [0, 100].
 * Returns 100 when total is zero (avoids NaN).
 */
export function percent(bytesDone: number, bytesTotal: number): number {
  if (!Number.isFinite(bytesTotal) || bytesTotal <= 0) return 100;
  const pct = (bytesDone / bytesTotal) * 100;
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}
