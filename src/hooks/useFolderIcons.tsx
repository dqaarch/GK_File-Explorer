import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface FolderIconResult {
  data_url: string | null;
  size: number;
}

interface FolderIconBatchEntry {
  path: string;
  size: number;
  width: number;
  height: number;
  data_url: string | null;
}

// Module-level cache keyed by "size|path". Each entry stores the raw data URL
// (base64 PNG) so callers can render with <img width=size> directly — no canvas
// scaling, no ImageBitmap decode, no complex pipeline. Simple and crisp.
const iconCache: Map<string, string | null> = new Map();
const inflight: Map<string, Promise<unknown>> = new Map();
const listeners: Set<() => void> = new Set();

function notify() {
  for (const l of listeners) l();
}

async function resolveIcon(path: string, size: number): Promise<string | null> {
  const key = `${size}|${path.toLowerCase()}`;
  if (iconCache.has(key)) return iconCache.get(key)!;
  const pending = inflight.get(key);
  if (pending !== undefined) return pending as Promise<string | null>;

  const p = (async () => {
    try {
      const result = await invoke<FolderIconResult>("get_folder_icon", { path, size });
      const url = result?.data_url ?? null;
      iconCache.set(key, url);
      return url;
    } catch {
      iconCache.set(key, null);
      return null;
    } finally {
      inflight.delete(key);
      notify();
    }
  })();
  inflight.set(key, p);
  return p;
}

async function resolveIconBatch(paths: string[], size: number): Promise<void> {
  const needed = paths.filter((p) => {
    const key = `${size}|${p.toLowerCase()}`;
    return !iconCache.has(key) && !inflight.has(key);
  });
  if (needed.length === 0) return;

  const batchKey = `batch|${size}|${needed.slice().sort().join("|")}`;
  if (inflight.has(batchKey)) return;

  const p = (async () => {
    try {
      const entries = await invoke<FolderIconBatchEntry[]>("get_folder_icons_batch", {
        paths: needed,
        size,
      });
      for (const e of entries) {
        const key = `${size}|${e.path.toLowerCase()}`;
        if (!iconCache.has(key)) {
          iconCache.set(key, e.data_url ?? null);
        }
      }
    } catch {
      // On batch failure fall back to per-path.
      await Promise.all(needed.map((p) => resolveIcon(p, size)));
    } finally {
      inflight.delete(batchKey);
      notify();
    }
  })();
  inflight.set(batchKey, p);
}

/**
 * Batch-load Windows Explorer folder icons for a list of paths.
 *
 * Uses the shared module cache so repeat calls with the same paths+size are
 * instant. The returned object maps each path to its base64 data URL (or null
 * if the icon could not be resolved). Render with `<img src={url} width={size}>`.
 *
 * The `size` parameter controls both the cache key and the IPC request:
 * fetching at the display size means the shell returns an icon that is
 * pixel-perfect for that resolution (no blurry canvas upscaling).
 */
export function useFolderIcons(paths: string[], size: number = 24) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  useEffect(() => {
    if (paths.length === 0) return;
    let cancelled = false;
    const toFetch = paths.filter((p) => {
      const key = `${size}|${p.toLowerCase()}`;
      return !iconCache.has(key) && !inflight.has(key);
    });
    if (toFetch.length === 0) return;

    if (toFetch.length >= 2) {
      resolveIconBatch(toFetch, size).finally(() => {
        if (cancelled) return;
      });
    } else {
      const p = toFetch[0];
      resolveIcon(p, size).finally(() => {
        if (cancelled) return;
      });
    }

    return () => {
      cancelled = true;
    };
  }, [paths.join("|"), size]);

  void tick;
  const result: Record<string, string | null> = {};
  for (const p of paths) {
    const key = `${size}|${p.toLowerCase()}`;
    if (iconCache.has(key)) result[p] = iconCache.get(key)!;
    else result[p] = undefined as unknown as string | null;
  }
  return result;
}

/**
 * Hook variant that returns a single path's icon URL at the requested size.
 */
export function useFolderIcon(path: string | null, size: number = 24): string | null {
  const paths = path ? [path] : [];
  const icons = useFolderIcons(paths, size);
  if (!path) return null;
  return path in icons ? icons[path] : undefined as unknown as string | null;
}

/**
 * Component wrapper: render a Windows system icon for a path using <img>.
 *
 * Simple approach — fetch at display size, render directly. No canvas scaling,
 * no bitmap decode, no complex pipeline. Matches how Windows Explorer renders
 * icons at each resolution.
 *
 * On cache miss the component renders the fallback node (or nothing if no
 * fallback is provided). The container still occupies the requested width/height
 * so layout stays stable.
 */
export function FolderIcon({
  path,
  size = 16,
  className,
  style,
  fallback,
}: {
  path: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  fallback?: React.ReactNode;
}) {
  const icons = useFolderIcons([path], size ?? 16);
  const url = (path in icons ? icons[path] : undefined) as string | null | undefined;

  if (url) {
    return (
      <img
        src={url}
        width={size}
        height={size}
        alt=""
        className={className}
        style={{
          display: "inline-block",
          verticalAlign: "middle",
          imageRendering: "auto",
          ...(style || {}),
        }}
        draggable={false}
      />
    );
  }

  return <>{fallback ?? null}</>;
}

/**
 * Drop-in replacement for `<Folder>` from lucide-react. Renders the same
 * Windows Explorer folder icon (yellow glyph with optional file-thumbnail
 * overlay) the shell shows at the requested display size.
 */
export function WindowsFolder({
  path,
  size = 16,
  className,
  style,
  fallback,
}: {
  path: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  fallback?: React.ReactNode;
}) {
  return (
    <FolderIcon
      path={path}
      size={size}
      className={className}
      style={style}
      fallback={fallback}
    />
  );
}
