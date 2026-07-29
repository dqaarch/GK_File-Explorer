import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface StockIconResult {
  /** Base64-encoded data URL for the icon PNG, or null if the shell could
   *  not resolve the requested special location on this platform. */
  data_url: string | null;
  /** Native bitmap dimension the shell returned — informational only; the
   *  frontend scales the bitmap via `<img width>` per view mode. */
  size: number;
}

export type SpecialFolderKind =
  | "this_pc"
  | "network"
  | "recycle_bin"
  | "control_panel"
  | "downloads"
  | "pictures"
  | "music"
  | "videos"
  | "documents"
  | "desktop";

// Module-level cache so repeat renders of "This PC" don't trigger a new
// IPC round-trip. Keyed by kind token.
const cache: Map<string, string | null> = new Map();
const inflight: Map<string, Promise<string | null>> = new Map();
const listeners: Set<() => void> = new Set();

function notify() {
  for (const l of listeners) l();
}

async function resolveKind(kind: SpecialFolderKind): Promise<string | null> {
  if (cache.has(kind)) return cache.get(kind)!;
  const pending = inflight.get(kind);
  if (pending) return pending;

  const p = (async () => {
    try {
      const res = await invoke<StockIconResult>("get_special_folder_icon", { kind });
      const url = res?.data_url ?? null;
      cache.set(kind, url);
      return url;
    } catch {
      cache.set(kind, null);
      return null;
    } finally {
      inflight.delete(kind);
      notify();
    }
  })();
  inflight.set(kind, p);
  return p;
}

/**
 * Resolve the Windows shell icon for a "special" location (This PC,
 * Network, Recycle Bin, …) to a base64 PNG data URL. The result is cached
 * for the lifetime of the page — repeat renders are instant.
 *
 * Returns `null` while the icon is loading, `undefined` if the shell
 * could not resolve it (e.g. non-Windows). Use a Lucide fallback in the
 * latter case.
 */
export function useSpecialFolderIcon(kind: SpecialFolderKind): {
  dataUrl: string | null | undefined;
} {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  // Trigger fetch on mount/kind change if not yet in flight / cached.
  useEffect(() => {
    if (cache.has(kind)) return;
    resolveKind(kind);
  }, [kind]);

  void tick;
  if (cache.has(kind)) return { dataUrl: cache.get(kind) ?? null };
  return { dataUrl: undefined };
}
