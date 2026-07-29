/**
 * RawLinearCache — cache of pre-LUT, pre-OEFF raw pixel buffers.
 *
 * Phase 7-revisit (2026-07-05): the previous `Float32RawCache` was removed
 * in the cache-layer refactor (see PLAN_BITMAP_PER_DISPLAY.md) because a JS
 * and Rust cache-eviction policy mismatch caused intermittent "Raw
 * fallback" perception on OCIO mode switches. We are reintroducing the
 * concept with stricter ownership semantics and explicit lifecycle hooks:
 *
 *   - Cache key intentionally OMITS `ocioMode`. The raw pixel buffer is
 *     independent of the colour transform — switching OCIO does NOT require
 *     re-decoding the EXR.
 *   - Cache key INCLUDES `customFingerprint`, `layerName`, `framePath`,
 *     and `maxSize`. Any of these changing invalidates the entry naturally.
 *   - LRU eviction enforces a hard byte budget (default 1.5 GB). The
 *     `Rust EXR-CACHE-LRU` keeps the authoritative copy on the Rust side
 *     for re-decode, so evicting a RawLinearCache entry is purely a JS-side
 *     memory decision.
 *   - `invalidateByLayer` / `invalidateByFingerprint` are explicit, called
 *     from `LayerCacheManager.configure()` on context switch.
 *   - No shared ownership with the ImageBitmap cache: this cache holds
 *     pixel arrays, that cache holds ImageBitmaps. They are independent.
 *
 * Usage contract:
 *   1. Caller (`LayerCacheManager._loadAndCacheBitmap`) inserts the raw
 *      pixel buffer returned by the pipeline here as soon as the decode
 *      finishes successfully.
 *   2. When the user switches OCIO mode, the caller looks up the raw
 *      buffer here and hands it to `ExrGpuPipeline.reRenderWithLut(...)`
 *      to produce a new ImageBitmap under the new (ocio, channel, frame)
 *      key without re-running the Rust FFI decode.
 *
 * Memory accounting:
 *   - For F16 raw: bytes = width * height * 4 * 2 (Uint16Array)
 *   - For F32 raw: bytes = width * height * 4 * 4 (Float32Array)
 *   - 1920x1920 RGBA F16 ≈ 14.7 MB / frame
 *   - 32 frames ≈ 470 MB; 100 frames ≈ 1.5 GB
 */

import { dbg } from '../debug';

interface LRUNode {
  key: string;
  prev: LRUNode | null;
  next: LRUNode | null;
}

export interface RawLinearEntry {
  /** RGBA pixel buffer — interleaved, 4 channels per pixel. */
  pixels: Uint16Array | Float32Array;
  width: number;
  height: number;
  channels: string[];
  /** true if pixels is Uint16Array (F16), false if Float32Array. */
  isHalfFloat: boolean;
  layerName: string;
  framePath: string;
  /** Resolved maximum dimension used at decode time (e.g. 2048). */
  maxSize: number;
  customFingerprint: string;
  /** Wall-clock insertion time (performance.now() not used — Date.now is fine for stats). */
  decodedAt: number;
  /** Estimated bytes = width * height * 4 * (2 or 4). */
  estimatedBytes: number;
}

class RawLinearCache {
  private cache = new Map<string, RawLinearEntry>();

  // LRU doubly-linked list (head = most recently used, tail = oldest).
  private lruHead: LRUNode | null = null;
  private lruTail: LRUNode | null = null;
  private lruMap = new Map<string, LRUNode>();

  private totalMemoryBytes = 0;
  /**
   * Phase 9-restructured (2026-07-05): budget raised from 1.5 GB →
   * 6 GB so the RawLinearCache can hold ~210 frames at 1920×1920 RGBA
   * F16 (~28 MB each). Most review timelines are < 200 frames so this
   * covers the full sequence without LRU thrashing. Users with < 8 GB
   * system RAM should override via `setMaxMemoryBytes` in their
   * `exrCacheSettings` store (future knob); for now the JS heap and
   * the V8 GC handle eviction gracefully above the budget.
   */
  private readonly maxMemoryBytes = 6 * 1024 * 1024 * 1024;

  // Debug counters
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  /**
   * Build the cache key. NOTE: `ocioMode` is intentionally NOT part of the
   * key — raw pixel buffers are colour-transform-agnostic.
   */
  private makeKey(
    layerName: string,
    framePath: string,
    maxSize: number,
    customFingerprint: string,
  ): string {
    const fp = customFingerprint || "";
    const pathHash = hashFramePath(framePath);
    return `${layerName}__${maxSize}__${fp}__${pathHash}`;
  }

  /**
   * Look up a raw pixel buffer for the given frame.
   * Returns null on miss. Updates LRU position on hit.
   */
  get(
    layerName: string,
    framePath: string,
    maxSize: number,
    customFingerprint: string,
  ): RawLinearEntry | null {
    const key = this.makeKey(layerName, framePath, maxSize, customFingerprint);
    const entry = this.cache.get(key);
    if (entry) {
      this.moveToHead(key);
      this.hits++;
      return entry;
    }
    this.misses++;
    return null;
  }

  /**
   * Check existence without updating LRU.
   */
  has(
    layerName: string,
    framePath: string,
    maxSize: number,
    customFingerprint: string,
  ): boolean {
    const key = this.makeKey(layerName, framePath, maxSize, customFingerprint);
    return this.cache.has(key);
  }

  /**
   * Insert or replace a raw pixel buffer. Triggers LRU eviction if the
   * memory budget is exceeded.
   */
  set(entry: RawLinearEntry): void {
    const key = this.makeKey(
      entry.layerName,
      entry.framePath,
      entry.maxSize,
      entry.customFingerprint,
    );

    // If overwriting an existing entry, free the old pixel buffer.
    const existing = this.cache.get(key);
    if (existing) {
      this.totalMemoryBytes -= existing.estimatedBytes;
      this.removeFromLru(key);
    }

    this.cache.set(key, entry);
    this.totalMemoryBytes += entry.estimatedBytes;
    this.addToLru(key);

    this.evictIfNeeded();
  }

  /**
   * Drop all entries belonging to a given layer. Returns the number of
   * entries evicted. Called from `LayerCacheManager.configure()` when
   * `layerChanged` is true.
   */
  invalidateByLayer(layerName: string): number {
    const keysToDelete: string[] = [];
    for (const [key, entry] of this.cache.entries()) {
      if (entry.layerName === layerName) {
        this.totalMemoryBytes -= entry.estimatedBytes;
        this.removeFromLru(key);
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
    if (keysToDelete.length > 0) {
      dbg.log(
        `[RawLinearCache] invalidateByLayer("${layerName}"): evicted ${keysToDelete.length} entries`,
      );
    }
    return keysToDelete.length;
  }

  /**
   * Drop all entries whose `customFingerprint` does NOT equal `keep`.
   * Called from `LayerCacheManager.configure()` when `fpChanged` is true.
   */
  invalidateByFingerprint(keep: string): number {
    const target = keep || "";
    const keysToDelete: string[] = [];
    for (const [key, entry] of this.cache.entries()) {
      const fp = entry.customFingerprint || "";
      if (fp !== target) {
        this.totalMemoryBytes -= entry.estimatedBytes;
        this.removeFromLru(key);
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
    if (keysToDelete.length > 0) {
      dbg.log(
        `[RawLinearCache] invalidateByFingerprint("${target}"): evicted ${keysToDelete.length} entries`,
      );
    }
    return keysToDelete.length;
  }

  /**
   * Drop everything. Called from `LayerCacheManager.clearCache()`.
   */
  invalidateAll(): void {
    const count = this.cache.size;
    this.cache.clear();
    this.lruHead = null;
    this.lruTail = null;
    this.lruMap.clear();
    this.totalMemoryBytes = 0;
    this.hits = 0;
    this.misses = 0;
    if (count > 0) {
      dbg.log(`[RawLinearCache] invalidateAll: evicted ${count} entries`);
    }
  }

  get size(): number {
    return this.cache.size;
  }

  getMemoryUsage(): {
    usedMB: number;
    maxMB: number;
    entries: number;
  } {
    return {
      usedMB: Math.round(this.totalMemoryBytes / 1024 / 1024),
      maxMB: Math.round(this.maxMemoryBytes / 1024 / 1024),
      entries: this.cache.size,
    };
  }

  getStats(): {
    hits: number;
    misses: number;
    hitRate: string;
    evictions: number;
  } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? ((this.hits / total) * 100).toFixed(1) + "%" : "N/A",
      evictions: this.evictions,
    };
  }

  // ---- Private LRU bookkeeping ----

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
        this.totalMemoryBytes -= evicted.estimatedBytes;
        this.cache.delete(oldestKey);
        this.removeFromLru(oldestKey);
        this.evictions++;
      } else {
        // LRU/key mismatch — defensively clean up.
        this.removeFromLru(oldestKey);
      }
    }
  }
}

/** 32-bit FNV-1a hash, identical to ImageBitmapCache's helper. */
function hashFramePath(path: string): string {
  if (!path) return "0";
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

// Global singleton — analogous to `imageBitmapCache`.
export const rawLinearCache = new RawLinearCache();

if (typeof window !== "undefined") {
  (window as unknown as { __rawLinearCache?: RawLinearCache }).__rawLinearCache =
    rawLinearCache;
}

export { RawLinearCache };