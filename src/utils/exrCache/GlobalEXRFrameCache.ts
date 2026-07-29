/**
 * Global EXR Frame Cache - AALab Style
 *
 * Features:
 * - No eviction limit (unlimited frames in memory)
 * - Cache key includes layer name AND OCIO mode to prevent cross-mode contamination
 *   (Linear sRGB and ACES 2.0 CG are stored as completely separate frames)
 * - LRU tracking for optional memory management
 * - Persists across layer switches
 * - Only cleared when app closes
 *
 * Bitmap ownership (Phase 6B-per-display):
 * - This cache stores ONLY `imageDataUrl` (PNG). The previous design cached
 *   `ImageBitmap` here too, but that required a `markBitmapInUse`/
 *   `releaseBitmap`/FinalizationRegistry dance to avoid `InvalidStateError`
 *   when the browser's compositing pipeline was still using a "closed"
 *   GPU texture. See PLAN_BITMAP_PER_DISPLAY.md for the full rationale.
 * - Bitmaps are now created transiently by the GPU pipeline and handed
 *   directly to the React display effect, which owns them via
 *   `swapAndDisposePending` (see ./bitmapOwner.ts).
 */

import { getMaxMemoryBytes } from '../../stores/exrCacheSettings';

export interface FrameEntry {
  /** PNG data URL (always set; the `imageDataUrl` is the only payload this
   *  cache persists). Consumers that want GPU-backed rendering create an
   *  ImageBitmap on demand via the GPU pipeline. */
  imageDataUrl: string;
  channels: string[];
  layerName: string;
  /** Human-readable OCIO mode that produced this frame. */
  ocioMode: string;
  /**
   * Per-Drop-View signature (path|display|view|size) of the custom
   * OCIO config active when this frame was rendered, or "" for
   * built-in modes. Used as a cache-key suffix so changing the
   * dropdown selection invalidates cached images.
   */
  customFingerprint: string;
  channelMode?: string;
  frameIndex: number;
  framePath: string;
  decodedAt: number;
  estimatedSizeBytes: number;
}

export interface LayerSettings {
  ocioMode: string;
  /**
   * Per-Drop-View custom OCIO fingerprint (path|display|view|size).
   * Persisted on the layer settings so the cache lookup can rebuild
   * the same key as what was used at setRGB time.
   */
  customFingerprint: string;
  maxSize: number;
  framePaths: string[];
}

interface LRUNode {
  key: string;
  prev: LRUNode | null;
  next: LRUNode | null;
}

class GlobalEXRFrameCache {
  // Cache: key = "${layerName}__${ocioMode}__${frameIndex}" → FrameEntry
  // Using "__" as separator to avoid collisions with layer names that may contain "_"
  private cache = new Map<string, FrameEntry>();

  // LRU doubly-linked list for memory management
  private lruHead: LRUNode | null = null;
  private lruTail: LRUNode | null = null;
  private lruMap = new Map<string, LRUNode>();

  // Settings per layer
  private layerSettings = new Map<string, LayerSettings>();

  // Max memory - loaded from settings (default 6GB)
  private maxMemoryBytes = getMaxMemoryBytes();

  // Memory usage stats
  private totalMemoryBytes = 0;
  private warningLogged = false;

  // Generate cache key - includes OCIO mode, channel mode, the
  // custom-config fingerprint (path|display|view|size), and a stable
  // hash of the resolved frame path (so the same `(layer, mode,
  // frameIndex)` slot in two different EXR files doesn't collide).
  //
  // Layout (left to right) — positions are stable so parseKey() can
  // round-trip the string:
  //   layerName__ocioMode__channel__frameIndex__fp__pathHash
  // All field separators are `__`; the trailing `__pathHash` is
  // intentionally always present so a missing trailing field from
  // the older format still parses safely (legacy entries simply get
  // hash = "").
  private getKey(
    layerName: string,
    ocioMode: string,
    frameIndex: number,
    channelMode: string = "RGB",
    customFingerprint: string = "",
    framePath: string = ""
  ): string {
    const mode = ocioMode || "default";
    const channel = channelMode || "RGB";
    const fp = customFingerprint || "";
    const pathHash = hashFramePath(framePath);
    return `${layerName}__${mode}__${channel}__${frameIndex}__${fp}__${pathHash}`;
  }

  // Parse cache key. Reads from the right — `customFingerprint` is at
  // index -3 in the new format and `pathHash` is at -1. Older keys
  // written before the path-hash change have only the last 5 fields,
  // so we treat a 5-field split as fp/pathHash missing.
  private parseKey(key: string): {
    layerName: string;
    ocioMode: string;
    channelMode: string;
    frameIndex: number;
    customFingerprint: string;
    framePathHash: string;
  } {
    const parts = key.split('__');
    let pathHash = "";
    let customFingerprint = "";
    let frameIndex = NaN;
    let channelMode = "";
    let ocioMode = "";
    let layerName = "";

    if (parts.length >= 6) {
      pathHash = parts[parts.length - 1] ?? "";
      customFingerprint = parts[parts.length - 2] ?? "";
      frameIndex = parseInt(parts[parts.length - 3], 10);
      channelMode = parts[parts.length - 4];
      ocioMode = parts[parts.length - 5];
      layerName = parts.slice(0, -5).join('__');
    } else {
      // Legacy (pre-pathHash) cache keys — fall through to old layout:
      // `layerName__ocioMode__channel__frameIndex__fp`.
      customFingerprint = parts[parts.length - 1] ?? "";
      frameIndex = parseInt(parts[parts.length - 2], 10);
      channelMode = parts[parts.length - 3];
      ocioMode = parts[parts.length - 4];
      layerName = parts.slice(0, -4).join('__');
    }

    return { layerName, ocioMode, channelMode, frameIndex, customFingerprint, framePathHash: pathHash };
  }

  // Update LRU order (move to head = most recently used)
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

  // Add to LRU
  private addToLRU(key: string): void {
    const node: LRUNode = { key, prev: null, next: this.lruHead };
    if (this.lruHead) this.lruHead.prev = node;
    this.lruHead = node;
    if (!this.lruTail) this.lruTail = node;
    this.lruMap.set(key, node);
  }

  // Remove from LRU
  private removeFromLRU(key: string): void {
    const node = this.lruMap.get(key);
    if (!node) return;

    if (node.prev) node.prev.next = node.next;
    else this.lruHead = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.lruTail = node.prev;

    this.lruMap.delete(key);
  }

  /**
   * Resolve the frame path for a `(layer, frameIndex)` lookup, falling
   * back to "" when the layer hasn't been configured yet or the index
   * is out of range. Centralised so the cache key here is the same
   * path-hash the original `set()` stored (otherwise the same key
   * slot can collide across two different EXR files).
   */
  private pathForLayer(layerName: string, frameIndex: number): string {
    const settings = this.layerSettings.get(layerName);
    if (!settings) return "";
    const ps = settings.framePaths;
    if (frameIndex < 0 || frameIndex >= ps.length) return "";
    return ps[frameIndex] ?? "";
  }

  // Get cached frame (sync - super fast)
  get(layerName: string, frameIndex: number, ocioMode?: string, channelMode: string = "RGB", customFingerprint: string = ""): FrameEntry | null {
    const mode = ocioMode ?? this.layerSettings.get(layerName)?.ocioMode ?? "default";
    const key = this.getKey(layerName, mode, frameIndex, channelMode, customFingerprint, this.pathForLayer(layerName, frameIndex));
    const entry = this.cache.get(key);

    if (entry) {
      this.moveToHead(key);
      return entry;
    }
    return null;
  }

  // Check if frame exists in cache (sync)
  has(layerName: string, frameIndex: number, ocioMode?: string, channelMode: string = "RGB", customFingerprint: string = ""): boolean {
    const mode = ocioMode ?? this.layerSettings.get(layerName)?.ocioMode ?? "default";
    return this.cache.has(this.getKey(layerName, mode, frameIndex, channelMode, customFingerprint, this.pathForLayer(layerName, frameIndex)));
  }

  // Store decoded frame (generic - will be renamed)
  set(entry: FrameEntry): void {
    const channelMode = entry.channelMode || "RGB";
    const key = this.getKey(entry.layerName, entry.ocioMode, entry.frameIndex, channelMode, entry.customFingerprint ?? "", entry.framePath ?? "");
    const existingEntry = this.cache.get(key);

    if (existingEntry) {
      this.totalMemoryBytes -= existingEntry.estimatedSizeBytes;
      this.removeFromLRU(key);
    }

    this.cache.set(key, entry);
    this.totalMemoryBytes += entry.estimatedSizeBytes;
    this.addToLRU(key);

    // Evict LRU entries if over memory limit
    while (this.totalMemoryBytes > this.maxMemoryBytes && this.lruTail !== null) {
      const oldestKey = this.lruTail.key;
      const evicted = this.cache.get(oldestKey);
      if (evicted) {
        this.totalMemoryBytes -= evicted.estimatedSizeBytes;
        this.cache.delete(oldestKey);
        this.removeFromLRU(oldestKey);
      } else {
        break;
      }
    }

    if (!this.warningLogged && this.totalMemoryBytes > this.maxMemoryBytes * 0.9) {
      console.warn(`[GlobalCache] Memory usage approaching limit: ${this.getMemoryUsageMB()}MB`);
      this.warningLogged = true;
    }
  }

  // Store RGB frame with channel mode
  setRGB(entry: FrameEntry): void {
    const key = this.getKey(entry.layerName, entry.ocioMode, entry.frameIndex, "RGB", entry.customFingerprint ?? "", entry.framePath ?? "");
    const existingEntry = this.cache.get(key);

    if (existingEntry) {
      this.totalMemoryBytes -= existingEntry.estimatedSizeBytes;
      this.removeFromLRU(key);
    }

    this.cache.set(key, entry);
    this.totalMemoryBytes += entry.estimatedSizeBytes;
    this.addToLRU(key);
  }

  // Get channel frame from cache
  getChannelCache(channel: string, layerName: string, frameIndex: number, ocioMode?: string, customFingerprint: string = ""): FrameEntry | null {
    const mode = ocioMode ?? this.layerSettings.get(layerName)?.ocioMode ?? "default";
    // Use same key format as getKey (includes customFingerprint + path hash)
    const key = this.getKey(layerName, mode, frameIndex, channel, customFingerprint, this.pathForLayer(layerName, frameIndex));

    const entry = this.cache.get(key);

    if (entry) {
      this.moveToHead(key);
      return entry;
    }
    return null;
  }

  // Delete a specific frame
  delete(layerName: string, frameIndex: number, ocioMode?: string, customFingerprint: string = ""): boolean {
    const mode = ocioMode ?? this.layerSettings.get(layerName)?.ocioMode ?? "default";
    const key = this.getKey(layerName, mode, frameIndex, "RGB", customFingerprint, this.pathForLayer(layerName, frameIndex));
    const entry = this.cache.get(key);

    if (entry) {
      this.totalMemoryBytes -= entry.estimatedSizeBytes;
      this.cache.delete(key);
      this.removeFromLRU(key);
      return true;
    }
    return false;
  }

  // Get all frames for a layer (optionally filtered by OCIO mode)
  getLayerFrames(layerName: string, ocioMode?: string): FrameEntry[] {
    const frames = Array.from(this.cache.values())
      .filter(e => e.layerName === layerName)
      .filter(e => !ocioMode || e.ocioMode === ocioMode);

    return frames.sort((a, b) => a.frameIndex - b.frameIndex);
  }

  // Get layer settings
  getLayerSettings(layerName: string): LayerSettings | undefined {
    return this.layerSettings.get(layerName);
  }

  // Save layer settings
  setLayerSettings(layerName: string, settings: LayerSettings): void {
    this.layerSettings.set(layerName, settings);
  }

  // Get all loaded layer names
  getLoadedLayers(): string[] {
    return Array.from(new Set(
      Array.from(this.cache.values()).map(e => e.layerName)
    ));
  }

  // Memory statistics
  getMemoryUsage(): {
    frames: number;
    estimatedMB: number;
    maxMB: number;
    usagePercent: number;
  } {
    const estimatedMB = Math.round(this.totalMemoryBytes / 1024 / 1024);
    return {
      frames: this.cache.size,
      estimatedMB,
      maxMB: Math.round(this.maxMemoryBytes / 1024 / 1024),
      usagePercent: Math.round((this.totalMemoryBytes / this.maxMemoryBytes) * 100)
    };
  }

  getMemoryUsageMB(): number {
    return Math.round(this.totalMemoryBytes / 1024 / 1024);
  }

  setMaxMemoryMB(mb: number): void {
    const newMaxBytes = mb * 1024 * 1024;
    if (newMaxBytes === this.maxMemoryBytes) return;

    this.maxMemoryBytes = newMaxBytes;
    this.warningLogged = false;

    // Trigger eviction if over new limit
    while (this.totalMemoryBytes > this.maxMemoryBytes && this.lruTail !== null) {
      const oldestKey = this.lruTail.key;
      const evicted = this.cache.get(oldestKey);
      if (evicted) {
        this.totalMemoryBytes -= evicted.estimatedSizeBytes;
        this.cache.delete(oldestKey);
        this.removeFromLRU(oldestKey);
      } else {
        break;
      }
    }
  }

  // Clear ALL cache (only call when app closes)
  //
  // Previous bug: this method (and clearLayer / clearLayerMode) used to
  // leave ImageBitmap GPU textures alive when the cache entries were
  // dropped — see Bug A in PLAN_BITMAP_PER_DISPLAY.md. Bitmaps are no
  // longer cached here, so the leak is structurally impossible now.
  clearAll(): void {
    this.cache.clear();
    this.lruHead = null;
    this.lruTail = null;
    this.lruMap.clear();
    this.layerSettings.clear();
    this.totalMemoryBytes = 0;
    this.warningLogged = false;
  }

  // Clear cache for a specific layer (all OCIO modes)
  clearLayer(layerName: string): number {
    const frames = this.getLayerFrames(layerName);
    let freedBytes = 0;

    for (const frame of frames) {
      const key = this.getKey(layerName, frame.ocioMode, frame.frameIndex, frame.channelMode || "RGB", frame.customFingerprint ?? "", frame.framePath ?? "");
      this.cache.delete(key);
      this.removeFromLRU(key);
      freedBytes += frame.estimatedSizeBytes;
    }

    this.totalMemoryBytes -= freedBytes;

    return frames.length;
  }

  // Clear cache for a specific layer + OCIO mode combination
  clearLayerMode(layerName: string, ocioMode: string): number {
    const frames = this.getLayerFrames(layerName, ocioMode);
    let freedBytes = 0;

    for (const frame of frames) {
      const key = this.getKey(layerName, frame.ocioMode, frame.frameIndex, frame.channelMode || "RGB", frame.customFingerprint ?? "", frame.framePath ?? "");
      this.cache.delete(key);
      this.removeFromLRU(key);
      freedBytes += frame.estimatedSizeBytes;
    }

    this.totalMemoryBytes -= freedBytes;

    return frames.length;
  }

  // Get cache stats for debugging
  getStats(): {
    totalFrames: number;
    layers: Record<string, number>;
    modes: Record<string, number>;
    memoryMB: number;
    lruCount: number;
  } {
    const layers: Record<string, number> = {};
    const modes: Record<string, number> = {};
    for (const entry of this.cache.values()) {
      layers[entry.layerName] = (layers[entry.layerName] || 0) + 1;
      modes[entry.ocioMode] = (modes[entry.ocioMode] || 0) + 1;
    }

    return {
      totalFrames: this.cache.size,
      layers,
      modes,
      memoryMB: this.getMemoryUsageMB(),
      lruCount: this.lruMap.size
    };
  }

  // Get LRU info (oldest frames)
  getLRUInfo(count: number = 5): Array<{ layer: string; mode: string; frame: number; age: number }> {
    const result: Array<{ layer: string; mode: string; frame: number; age: number }> = [];
    let node = this.lruTail;

    while (node && result.length < count) {
      const parsed = this.parseKey(node.key);
      const entry = this.cache.get(node.key);
      if (entry) {
        result.push({
          layer: parsed.layerName,
          mode: parsed.ocioMode,
          frame: parsed.frameIndex,
          age: Date.now() - entry.decodedAt
        });
      }
      node = node.prev;
    }

    return result;
  }
}

/**
 * 32-bit FNV-1a hash of the input string. Stable across runs and
 * deterministic for a given path, so we can use it as a cache-key
 * suffix that distinguishes two EXR files whose `(layer, mode,
 * frameIndex)` triple would otherwise collide. An empty input maps to
 * a zero hash so missing-path lookups still hit the legacy "" bucket
 * instead of being treated as "another unknown file".
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

// Global singleton instance
export const globalFrameCache = new GlobalEXRFrameCache();

// Expose to window for settings integration
if (typeof window !== 'undefined') {
  (window as any).__globalFrameCache = globalFrameCache;
}

// Also export the class for testing
export { GlobalEXRFrameCache };
export { hashFramePath };