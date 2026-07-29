/**
 * ImageBitmap Cache - Phase 7: Bitmap-Only Pipeline
 *
 * Replaces the old PNG-based cache (GlobalEXRFrameCache) with a direct
 * ImageBitmap cache. This eliminates the dual-decode problem where
 * each frame was decoded TWICE:
 *   1. Once for PNG (via loadFrame/decodeFrameToDataUrl)
 *   2. Once for ImageBitmap (via loadFrameWithBitmap/decodeFrameToBitmap)
 *
 * The new flow is SIMPLE:
 *   displayFrame()
 *     └─ loadFrameWithBitmap()      // Single decode path
 *           └─ ImageBitmapCache.get()? → return cached bitmap
 *           └─ decodeFrameToBitmap()  → store bitmap, return it
 *           └─ setImageBitmap()     → render to canvas
 *
 * Key changes from PNG cache:
 *   1. Cache stores ImageBitmap directly (GPU texture)
 *   2. Cache key includes OCIO mode + channel mode
 *   3. LRU eviction based on memory estimation
 *   4. NO PNG encoding/decoding in the hot path
 */

import { getMaxMemoryBytes } from '../../stores/exrCacheSettings';
import { dbg } from '../debug';

export interface BitmapCacheEntry {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  channels: string[];
  layerName: string;
  ocioMode: string;
  customFingerprint: string;
  channelMode: string;
  frameIndex: number;
  framePath: string;
  decodedAt: number;
  /** Estimated GPU memory in bytes (width * height * 4 for RGBA) */
  estimatedBytes: number;
}

interface LRUNode {
  key: string;
  prev: LRUNode | null;
  next: LRUNode | null;
}

class ImageBitmapCache {
  // Cache: key = "layer__ocioMode__channel__frameIndex__customFp__pathHash" → BitmapCacheEntry
  private cache = new Map<string, BitmapCacheEntry>();

  // LRU doubly-linked list for memory management
  private lruHead: LRUNode | null = null;
  private lruTail: LRUNode | null = null;
  private lruMap = new Map<string, LRUNode>();

  // Memory tracking
  private totalMemoryBytes = 0;
  private maxMemoryBytes = getMaxMemoryBytes();
  private warningLogged = false;

  // Debug counters
  private hits = 0;
  private misses = 0;

  /**
   * Generate a stable cache key for the given frame parameters.
   * Includes layer, OCIO mode, channel mode, frame index, custom fingerprint,
   * and a hash of the frame path to avoid collisions between different files.
   */
  private getKey(
    layerName: string,
    ocioMode: string,
    channelMode: string,
    frameIndex: number,
    customFingerprint: string,
    framePath: string
  ): string {
    const mode = ocioMode || "default";
    const channel = channelMode || "RGB";
    const fp = customFingerprint || "";
    const pathHash = hashFramePath(framePath);
    return `${layerName}__${mode}__${channel}__${frameIndex}__${fp}__${pathHash}`;
  }

  /**
   * Check if a frame is cached. Returns the entry if found, null otherwise.
   * Updates LRU position on hit.
   */
  get(
    layerName: string,
    ocioMode: string,
    channelMode: string,
    frameIndex: number,
    customFingerprint?: string,
    framePath?: string
  ): BitmapCacheEntry | null {
    const fp = customFingerprint || "";
    const path = framePath || "";
    const key = this.getKey(layerName, ocioMode, channelMode, frameIndex, fp, path);
    const entry = this.cache.get(key);

    if (entry) {
      this.moveToHead(key);
      this.hits++;
      dbgLog(`[BitmapCache] HIT frame ${frameIndex} (total hits: ${this.hits})`);
      return entry;
    }

    this.misses++;
    dbgLog(`[BitmapCache] MISS frame ${frameIndex} (total misses: ${this.misses})`);
    return null;
  }

  /**
   * Check if a frame exists without updating LRU.
   */
  has(
    layerName: string,
    ocioMode: string,
    channelMode: string,
    frameIndex: number,
    customFingerprint?: string,
    framePath?: string
  ): boolean {
    const fp = customFingerprint || "";
    const path = framePath || "";
    const key = this.getKey(layerName, ocioMode, channelMode, frameIndex, fp, path);
    return this.cache.has(key);
  }

  /**
   * Store a decoded ImageBitmap in the cache.
   */
  set(entry: BitmapCacheEntry): void {
    const key = this.getKey(
      entry.layerName,
      entry.ocioMode,
      entry.channelMode,
      entry.frameIndex,
      entry.customFingerprint,
      entry.framePath
    );

    // Remove existing entry if present
    const existing = this.cache.get(key);
    if (existing) {
      this.totalMemoryBytes -= existing.estimatedBytes;
      this.removeFromLru(key);
      // Close the old bitmap to free GPU memory
      try { existing.bitmap.close(); } catch { /* ignore */ }
    }

    this.cache.set(key, entry);
    this.totalMemoryBytes += entry.estimatedBytes;
    this.addToLru(key);

    // Evict LRU entries if over memory limit
    this.evictIfNeeded();

    dbgLog(`[BitmapCache] Stored frame ${entry.frameIndex} (${entry.width}x${entry.height}, ~${Math.round(entry.estimatedBytes / 1024 / 1024)}MB)`);
  }

  /**
   * Remove a specific frame from cache.
   */
  delete(
    layerName: string,
    ocioMode: string,
    channelMode: string,
    frameIndex: number,
    customFingerprint?: string,
    framePath?: string
  ): boolean {
    const fp = customFingerprint || "";
    const path = framePath || "";
    const key = this.getKey(layerName, ocioMode, channelMode, frameIndex, fp, path);
    const entry = this.cache.get(key);

    if (entry) {
      this.totalMemoryBytes -= entry.estimatedBytes;
      this.cache.delete(key);
      this.removeFromLru(key);
      try { entry.bitmap.close(); } catch { /* ignore */ }
      return true;
    }
    return false;
  }

  /**
   * Get count of cached frames.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get memory usage stats.
   */
  getMemoryUsage(): { usedMB: number; maxMB: number; entries: number } {
    return {
      usedMB: Math.round(this.totalMemoryBytes / 1024 / 1024),
      maxMB: Math.round(this.maxMemoryBytes / 1024 / 1024),
      entries: this.cache.size
    };
  }

  /**
   * Get cache statistics for debugging.
   */
  getStats(): { hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    // 2026-07-05: was a `string` (e.g. "12.3%") that broke the
    // declared `number` type. Round to one decimal as a `number` so
    // `JSON.stringify(getStats())` still serialises cleanly when the
    // debug overlay reads it.
    const hitRate: number = total > 0
      ? Math.round((this.hits / total) * 1000) / 10
      : 0;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate,
    };
  }

  /**
   * Clear all entries and close all bitmaps.
   */
  clearAll(): void {
    for (const entry of this.cache.values()) {
      try { entry.bitmap.close(); } catch { /* ignore */ }
    }
    this.cache.clear();
    this.lruHead = null;
    this.lruTail = null;
    this.lruMap.clear();
    this.totalMemoryBytes = 0;
    this.warningLogged = false;
    this.hits = 0;
    this.misses = 0;
    dbgLog("[BitmapCache] Cleared all entries");
  }

  /**
   * Clear entries for a specific layer.
   */
  clearLayer(layerName: string): void {
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (entry.layerName === layerName) {
        try { entry.bitmap.close(); } catch { /* ignore */ }
        this.totalMemoryBytes -= entry.estimatedBytes;
        this.removeFromLru(key);
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
    }

    dbgLog(`[BitmapCache] Cleared ${keysToDelete.length} entries for layer "${layerName}"`);
  }

  /**
   * 2026-07-13: NAV-3 follow-up — clear only the entries belonging to a
   * specific `customFingerprint` (file-content fingerprint from the
   * EXR metadata loader). Used when `configure()` is called for a
   * *different* file: the previous file's bitmaps are no longer
   * relevant, but entries for other previously-warmed files stay in
   * the cache so the user can reopen them instantly.
   *
   * Pass an empty string to clear the entries stored with no
   * fingerprint (single-EXR / pre-fingerprint-resolve state).
   */
  clearByFingerprint(customFingerprint: string): void {
    const fp = customFingerprint || "";
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      const entryFp = entry.customFingerprint || "";
      if (entryFp === fp) {
        try { entry.bitmap.close(); } catch { /* ignore */ }
        this.totalMemoryBytes -= entry.estimatedBytes;
        this.removeFromLru(key);
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
    }

    dbgLog(
      `[BitmapCache] Cleared ${keysToDelete.length} entries for fingerprint="${fp.slice(0, 30)}${fp.length > 30 ? "…" : ""}"`,
    );
  }

  /**
   * Update max memory limit and evict if needed.
   */
  setMaxMemoryMB(mb: number): void {
    const newMaxBytes = mb * 1024 * 1024;
    if (newMaxBytes === this.maxMemoryBytes) return;

    this.maxMemoryBytes = newMaxBytes;
    this.warningLogged = false;
    this.evictIfNeeded();
  }

  // ---- Private methods ----

  private moveToHead(key: string): void {
    const node = this.lruMap.get(key);
    if (!node || node === this.lruHead) return;

    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (node === this.lruTail) this.lruTail = node.prev;

    node.prev = null;
    node.next = this.lruHead;
    if (this.lruHead) this.lruHead.prev = node;
    this.lruHead = node;
    if (!this.lruTail) this.lruTail = node;
  }

  private addToLru(key: string): void {
    const node: LRUNode = { key, prev: null, next: this.lruHead };
    if (this.lruHead) this.lruHead.prev = node;
    this.lruHead = node;
    if (!this.lruTail) this.lruTail = node;
    this.lruMap.set(key, node);
  }

  private removeFromLru(key: string): void {
    const node = this.lruMap.get(key);
    if (!node) return;

    if (node.prev) node.prev.next = node.next;
    else this.lruHead = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.lruTail = node.prev;

    this.lruMap.delete(key);
  }

  private evictIfNeeded(): void {
    while (this.totalMemoryBytes > this.maxMemoryBytes && this.lruTail !== null) {
      const oldestKey = this.lruTail.key;
      const evicted = this.cache.get(oldestKey);

      if (evicted) {
        dbgLog(`[BitmapCache] Evicting frame ${evicted.frameIndex} (LRU)`);
        this.totalMemoryBytes -= evicted.estimatedBytes;
        this.cache.delete(oldestKey);
        this.removeFromLru(oldestKey);
        try { evicted.bitmap.close(); } catch { /* ignore */ }
      } else {
        // Key exists in LRU but not in cache - shouldn't happen, but handle it
        this.removeFromLru(oldestKey);
      }
    }

    if (!this.warningLogged && this.totalMemoryBytes > this.maxMemoryBytes * 0.9) {
      console.warn(`[BitmapCache] Memory usage approaching limit: ${this.getMemoryUsage().usedMB}MB`);
      this.warningLogged = true;
    }
  }
}

/**
 * 32-bit FNV-1a hash of the input string. Stable across runs.
 */
function hashFramePath(path: string): string {
  if (!path) return "0";
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

/**
 * Debug logging helper - only logs when in debug mode.
 */
function dbgLog(msg: string): void {
  if (typeof window !== "undefined" && (window as any).__gokuDebugBitmapCache) {
    dbg.log(msg);
  }
}

// Global singleton instance
export const imageBitmapCache = new ImageBitmapCache();

// Expose to window for debugging
if (typeof window !== 'undefined') {
  (window as any).__imageBitmapCache = imageBitmapCache;
}

export { ImageBitmapCache };
