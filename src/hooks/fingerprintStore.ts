// Global fingerprint store - shared across all components
// This allows any preview component to know when a file has been
// replaced, even if it wasn't currently selected.
//
// IMPORTANT: The Tauri "listen" call is registered eagerly at module-load
// time so that we never miss a "thumbnail-cleared" event. If we waited
// for the first component to subscribe, the very first replace would
// be lost.

import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

export interface FileReplacedEvent {
  path: string;
  mtime_ms: number;
  size: number;
}

interface FileFingerprint {
  mtimeMs: number;
  size: number;
}

const fpCache = new Map<string, FileFingerprint>();
const listeners = new Set<(path: string, fp: string) => void>();
let _unlisten: UnlistenFn | undefined;

// Cap on number of cached fingerprints. Each entry is just a small
// (mtimeMs, size) object, but we still don't want to grow unboundedly if the
// app is left running and replaces thousands of distinct files over time.
const MAX_FP_CACHE_ENTRIES = 5000;

function notify(path: string, fp: string) {
  for (const l of listeners) {
    try { l(path, fp); } catch {}
  }
}

// Eagerly register the global listener. Module load is one-shot, so this
// is at most once per app session.
listen<FileReplacedEvent>("thumbnail-cleared", (event) => {
  const evt = event.payload;
  if (!evt || !evt.path) {
    return;
  }
  const fp: FileFingerprint = { mtimeMs: evt.mtime_ms, size: evt.size };
  fpCache.set(evt.path, fp);
  // Evict oldest entry if we exceed the cap. Map iteration is in
  // insertion order, so the first key is the oldest.
  if (fpCache.size > MAX_FP_CACHE_ENTRIES) {
    const oldest = fpCache.keys().next().value;
    if (oldest) fpCache.delete(oldest);
  }
  const fpStr = `${evt.mtime_ms}-${evt.size}`;
  notify(evt.path, fpStr);
}).then((fn) => {
  _unlisten = fn;
}).catch((err) => {
  console.error("[fingerprintStore] failed to register listener", err);
});

/** Subscribe to file replacement events */
export function subscribeFingerprint(
  cb: (path: string, fingerprint: string) => void
): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Get cached fingerprint synchronously, or null if unknown */
export function getCachedFingerprint(path: string): string | null {
  const fp = fpCache.get(path);
  if (!fp) return null;
  return `${fp.mtimeMs}-${fp.size}`;
}

/** Fetch fingerprint from backend, update cache, and return */
export async function fetchFingerprint(path: string): Promise<string | null> {
  try {
    const result = await invoke<{ mtime_ms: number; size: number } | null>(
      "get_file_fingerprint",
      { path }
    );
    if (!result) return null;
    const fp: FileFingerprint = { mtimeMs: result.mtime_ms, size: result.size };
    fpCache.set(path, fp);
    return `${result.mtime_ms}-${result.size}`;
  } catch {
    return null;
  }
}

/** Prefetch fingerprints for a list of paths (fire-and-forget) */
export function prefetchFingerprints(paths: string[]): void {
  for (const p of paths) {
    if (!fpCache.has(p)) {
      fetchFingerprint(p).catch(() => {});
    }
  }
}
