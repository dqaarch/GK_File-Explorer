// Global thumbnails singleton - shared across all components
// ExplorerMainPane writes to it, DetailsPane and MultiSelectInspector read from it
//
// LRU eviction: capped at MAX_ENTRIES (500) to prevent unbounded memory growth.
// When over cap, oldest entries (by insertion order) are evicted first.
// Rust-side LRU + disk cache ensures revisits get instant hits even after JS eviction.

import { listen } from "@tauri-apps/api/event";

type ThumbnailMap = Record<string, string | null>;

type ThumbnailFailureMap = Record<string, true>;

const MAX_ENTRIES = 500;

let _thumbs: ThumbnailMap = {};
let _thumbFailures: ThumbnailFailureMap = {};
// LRU eviction: Array of insertion-ordered keys; evict from front when over cap.
// We use a parallel array instead of Map ordering so we can evict arbitrary entries.
let _lruKeys: string[] = [];
const _listeners: Set<(thumbs: ThumbnailMap) => void> = new Set();

// RAF-based throttling for notifications
let _pendingThumbs: ThumbnailMap | null = null;
let _notifyRafId: number | null = null;
// Prevent re-entrancy: if we're inside a notification cycle, don't schedule another
let _isNotifying = false;

function scheduleThumbNotification() {
  if (_notifyRafId !== null) return;

  _notifyRafId = requestAnimationFrame(() => {
    _notifyRafId = null;
    if (_pendingThumbs === null || isThumbsEqual(_thumbs, _pendingThumbs)) {
      _pendingThumbs = null;
      return;
    }
    _thumbs = _pendingThumbs;
    _pendingThumbs = null;
    _isNotifying = true;
    _listeners.forEach((listener) => listener(_thumbs));
    _isNotifying = false;
  });
}

export function getThumbs(): ThumbnailMap {
  return _thumbs;
}

// Check if two thumbnail maps are equal (shallow compare keys + values)
function isThumbsEqual(a: ThumbnailMap, b: ThumbnailMap): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function setThumbs(thumbs: ThumbnailMap): void {
  // Only update and notify if actually changed
  if (!isThumbsEqual(_thumbs, thumbs)) {
    _pendingThumbs = thumbs;
    // Enforce LRU cap: evict oldest entries if over MAX_ENTRIES
    const newKeys = Object.keys(thumbs);
    if (newKeys.length > MAX_ENTRIES) {
      const toEvict = newKeys.length - MAX_ENTRIES;
      for (let i = 0; i < toEvict; i++) {
        const evictedKey = _lruKeys[i];
        if (evictedKey && evictedKey in _thumbs) {
          delete _thumbs[evictedKey];
        }
      }
      _lruKeys = _lruKeys.slice(toEvict);
    }
    scheduleThumbNotification();
  }
}

// Alias for compatibility
export const setThumbsGlobal = setThumbs;

function isAiLikePath(path: string): boolean {
  return /\.(ai|eps)$/i.test(path);
}

export function hasThumbFailure(path: string): boolean {
  return Boolean(_thumbFailures[path]);
}

export function markThumbFailure(path: string): void {
  if (!isAiLikePath(path)) return;
  _thumbFailures = { ..._thumbFailures, [path]: true };
}

export function clearThumbFailure(path: string): void {
  if (!_thumbFailures[path]) return;
  const next = { ..._thumbFailures };
  delete next[path];
  _thumbFailures = next;
}

export function updateThumbs(update: (prev: ThumbnailMap) => ThumbnailMap): void {
  // Skip if we're inside a notification cycle to prevent re-entrancy loops
  if (_isNotifying) return;
  const newThumbs = update(_thumbs);
  if (!isThumbsEqual(_thumbs, newThumbs)) {
    _pendingThumbs = newThumbs;
    // Track new keys in LRU (move-to-end for touched entries)
    const newKeys = Object.keys(newThumbs);
    for (const key of newKeys) {
      const idx = _lruKeys.indexOf(key);
      if (idx !== -1) {
        // Move to end (most recently used)
        _lruKeys.splice(idx, 1);
      }
      _lruKeys.push(key);
    }
    // Evict oldest entries if over cap
    while (_lruKeys.length > MAX_ENTRIES) {
      const evictedKey = _lruKeys.shift();
      if (evictedKey && evictedKey in _thumbs) {
        delete _thumbs[evictedKey];
      }
    }
    scheduleThumbNotification();
  }
}

export function subscribeThumbs(listener: (thumbs: ThumbnailMap) => void): () => void {
  _listeners.add(listener);
  // Immediately call with current value
  listener(_thumbs);
  return () => _listeners.delete(listener);
}

export function clearThumbs(): void {
  _thumbs = {};
  _thumbFailures = {};
  _lruKeys = [];
  _listeners.forEach((listener) => listener(_thumbs));
}

// Listen for Rust "thumbnail-cleared" events — emitted when the transfer
// engine overwrites an existing file (Replace). We drop our local state
// for the affected path so the next render shows a fresh thumbnail.
let _unlistenThumbCleared: (() => void) | undefined;
listen<{ path: string; mtime_ms: number; size: number }>("thumbnail-cleared", (event) => {
  const path = event.payload?.path;
  if (!path) return;
  if (path in _thumbs) {
    const next: ThumbnailMap = {};
    for (const [k, v] of Object.entries(_thumbs)) {
      if (k !== path) next[k] = v;
    }
    _thumbs = next;
    _listeners.forEach((listener) => listener(_thumbs));
  }
}).then((fn) => { _unlistenThumbCleared = fn; });
