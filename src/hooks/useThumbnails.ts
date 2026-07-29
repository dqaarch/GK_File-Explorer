import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Map of path -> thumbnail data URL (null = loading/error, string = ready) */
export type ThumbnailMap = Record<string, string | null>;

interface UseThumbnailsOptions {
  /** Max thumbnails to request per batch (avoids IPC flooding) */
  batchSize?: number;
  /** Delay before batching requests (ms) — coalesces rapid navigation */
  batchDelay?: number;
}

/**
 * High-performance thumbnail hook using Windows Shell thumbnail cache.
 *
 * Strategy:
 * 1. Call get_thumbnails_batch for visible files only
 * 2. Cache hits return instantly (~1ms)
 * 3. Cache misses return null immediately, thumbnail is extracted in background
 * 4. Frontend polls Rust cache via events or re-invokes
 *
 * Usage:
 *   const { thumbs, fetchThumbs, clearThumbs } = useThumbnails();
 *   useEffect(() => { fetchThumbs(items.map(i => i.path), 256); }, [folderId]);
 */
export function useThumbnails(options: UseThumbnailsOptions = {}) {
  const { batchSize = 50, batchDelay = 100 } = options;

  const [thumbs, setThumbs] = useState<ThumbnailMap>({});
  const [isLoading, setIsLoading] = useState(false);

  // Track in-flight requests to avoid duplicates
  const inFlightRef = useRef<Set<string>>(new Set());
  // Abort controller for cancellation on folder change
  const abortRef = useRef<AbortController | null>(null);
  // Pending batch timer
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pending paths queue
  const pendingRef = useRef<string[]>([]);

  /** Fetch thumbnails for a list of paths. Deduplicates in-flight requests. */
  const fetchThumbs = useCallback(
    async (paths: string[], size: number = 256) => {
      // Filter out already-loaded and in-flight paths
      const newPaths = paths.filter(
        (p) => !thumbs[p] && !inFlightRef.current.has(p)
      );
      if (newPaths.length === 0) return;

      // Mark as in-flight
      newPaths.forEach((p) => inFlightRef.current.add(p));

      // Mark as loading in state
      setThumbs((prev) => {
        const next = { ...prev };
        newPaths.forEach((p) => { next[p] = null; });
        return next;
      });

      // Process in batches
      for (let i = 0; i < newPaths.length; i += batchSize) {
        const batch = newPaths.slice(i, i + batchSize);

        try {
          const result = await invoke<Record<string, string | null>>(
            "get_thumbnails_batch",
            { paths: batch, size }
          );

          // Merge results
          setThumbs((prev) => {
            const next = { ...prev };
            let hasUpdate = false;
            for (const [path, dataUrl] of Object.entries(result)) {
              if (path in next && next[path] !== null) continue; // already have it
              next[path] = dataUrl;
              hasUpdate = true;
              inFlightRef.current.delete(path);
            }
            return hasUpdate ? next : prev;
          });
        } catch {
          // Mark all as failed
          setThumbs((prev) => {
            const next = { ...prev };
            batch.forEach((p) => {
              next[p] = null;
              inFlightRef.current.delete(p);
            });
            return next;
          });
        }
      }
    },
    [thumbs, batchSize]
  );

  /** Clear all thumbnails (call on folder change) */
  const clearThumbs = useCallback(() => {
    // Cancel pending timer
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    pendingRef.current = [];
    inFlightRef.current.clear();
    setThumbs({});
  }, []);

  /** Fetch thumbs with batch delay (use when scrolling through large folders) */
  const queueThumbs = useCallback(
    (paths: string[], size: number = 256) => {
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
      }
      pendingRef.current.push(...paths);
      batchTimerRef.current = setTimeout(async () => {
        const toFetch = [...new Set(pendingRef.current)];
        pendingRef.current = [];
        await fetchThumbs(toFetch, size);
      }, batchDelay);
    },
    [fetchThumbs, batchDelay]
  );

  return {
    thumbs,
    isLoading,
    fetchThumbs,
    clearThumbs,
    queueThumbs,
    setThumbs,
  };
}
