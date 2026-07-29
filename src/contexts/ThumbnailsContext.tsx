import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import { FSItem } from "../types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type ThumbnailMap = Record<string, string | null>;

interface ThumbnailsContextValue {
  thumbs: ThumbnailMap;
  loadThumbsForFolder: (folderPath: string, items: FSItem[]) => void;
  clearThumbs: () => void;
}

const ThumbnailsContext = createContext<ThumbnailsContextValue | null>(null);

export function useThumbnailsContext() {
  const ctx = useContext(ThumbnailsContext);
  if (!ctx) throw new Error("Must be inside ThumbnailsProvider");
  return ctx;
}

export function ThumbnailsProvider({ children }: { children: React.ReactNode }) {
  const [thumbs, setThumbs] = useState<ThumbnailMap>({});
  const thumbsInFlight = useRef<Set<string>>(new Set());
  const lastFolderRef = useRef<string>("");
  const activeBatchRef = useRef<boolean>(false);

  const clearThumbs = useCallback(() => {
    setThumbs({});
    thumbsInFlight.current.clear();
    lastFolderRef.current = "";
  }, []);

  const loadThumbsForFolder = useCallback((folderPath: string, items: FSItem[]) => {
    if (lastFolderRef.current === folderPath && Object.keys(thumbs).length > 0) {
      return; // Already loaded
    }
    
    lastFolderRef.current = folderPath;
    thumbsInFlight.current.clear();
    setThumbs({});

    const imageExt = /\.(png|jpg|jpeg|gif|webp|exr|tiff?|bmp|tga|ico|af)$/i;
    const videoExt = /\.(mp4|mov|avi|mkv|webm|wmv)$/i;
    
    const filePaths = items
      .filter((item) => {
        if (item.type !== "file") return false;
        const isImage = imageExt.test(item.name);
        const isVideo = videoExt.test(item.name) && (item.size || 0) < 100 * 1024 * 1024;
        return isImage || isVideo;
      })
      .map((item) => item.path);

    if (filePaths.length === 0) return;

    const batchSize = 20;
    const batchDelay = 50;
    const size = 256;

    const processBatch = async (batch: string[]) => {
      if (!lastFolderRef.current) return; // Cancelled
      
      const batch_str = batch.join("|");
      try {
        const result = await invoke("get_thumbnails", { paths: batch_str, size }) as ThumbnailMap;
        
        if (lastFolderRef.current) {
          setThumbs((prev) => {
            const next = { ...prev };
            let changed = false;
            for (const [path, data] of Object.entries(result)) {
              if (batch.includes(path) && prev[path] !== data) {
                next[path] = data;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }
      } catch (err) {
        // Silent catch - thumbnails are optional
      }

      // Next batch
      if (batchesRef.current.length > 0 && lastFolderRef.current) {
        await new Promise((r) => setTimeout(r, batchDelay));
        processBatch(batchesRef.current.shift()!);
      } else {
        activeBatchRef.current = false;
      }
    };

    const batchesRef = { current: [] as string[][] };
    for (let i = 0; i < filePaths.length; i += batchSize) {
      batchesRef.current.push(filePaths.slice(i, i + batchSize));
    }

    if (!activeBatchRef.current) {
      activeBatchRef.current = true;
      processBatch(batchesRef.current.shift()!);
    }
  }, [thumbs]);

  // Listen for Rust "thumbnail-cleared" events — emitted when the transfer
  // engine overwrites an existing file (Replace). We drop our local state
  // for the affected path so the next render shows a fresh thumbnail.
  // Payload is a FileReplacedEvent { path, mtime_ms, size } (object), not a string.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ path: string; mtime_ms: number; size: number }>("thumbnail-cleared", (event) => {
      if (cancelled) return;
      const path = event.payload?.path;
      if (!path) return;
      setThumbs((prev) => {
        if (!(path in prev)) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      });
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    }).catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <ThumbnailsContext.Provider value={{ thumbs, loadThumbsForFolder, clearThumbs }}>
      {children}
    </ThumbnailsContext.Provider>
  );
}
