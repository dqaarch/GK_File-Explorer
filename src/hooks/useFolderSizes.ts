import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** path -> folder size in bytes, null = loading/in-progress */
export type FolderSizeMap = Record<string, number | null>;

/**
 * On-demand recursive folder size calculator with caching.
 */
export function useFolderSizes(_options: object = {}) {
  const [sizes, setSizes] = useState<FolderSizeMap>({});
  const cacheRef = useRef<Record<string, number | null>>({});
  const inFlightRef = useRef<Set<string>>(new Set());

  const getFolderSize = useCallback(async (path: string) => {
    if (path in cacheRef.current) return;
    if (inFlightRef.current.has(path)) return;

    inFlightRef.current.add(path);
    setSizes(prev => ({ ...prev, [path]: null }));

    try {
      const size: number = await invoke<number>("get_folder_size", { path });
      cacheRef.current[path] = size;
      setSizes(prev => ({ ...prev, [path]: size }));
    } catch {
      cacheRef.current[path] = 0;
      setSizes(prev => ({ ...prev, [path]: 0 }));
    } finally {
      inFlightRef.current.delete(path);
    }
  }, []);

  const prefetchSizes = useCallback(async (paths: string[]) => {
    const uncachedPaths = paths.filter(p => !(p in cacheRef.current) && !inFlightRef.current.has(p));
    if (uncachedPaths.length === 0) return;

    const batchSize = 4;
    for (let i = 0; i < uncachedPaths.length; i += batchSize) {
      const batch = uncachedPaths.slice(i, i + batchSize);
      await Promise.all(batch.map(path => {
        inFlightRef.current.add(path);
        setSizes(prev => ({ ...prev, [path]: null }));

        return invoke<number>("get_folder_size", { path })
          .then(size => {
            cacheRef.current[path] = size;
            setSizes(prev => ({ ...prev, [path]: size }));
          })
          .catch(() => {
            cacheRef.current[path] = 0;
            setSizes(prev => ({ ...prev, [path]: 0 }));
          })
          .finally(() => {
            inFlightRef.current.delete(path);
          });
      }));
    }
  }, []);

  const clearSize = useCallback((path: string) => {
    delete cacheRef.current[path];
    setSizes(prev => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    cacheRef.current = {};
    inFlightRef.current.clear();
    setSizes({});
  }, []);

  return { sizes, getFolderSize, prefetchSizes, clearSize, clearAll };
}
