/**
 * EXRPlayer V2 — UnifiedCache
 * 
 * Single cache replacing ImageBitmapCache + RawLinearCache.
 * No more conflicting cache keys between bitmap and raw data.
 */

export interface UnifiedCacheEntry {
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
  estimatedBytes: number;
}

interface CacheEntry {
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
  estimatedBytes: number;
}

export class UnifiedCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;
  private currentSize = 0;

  constructor(maxSizeMB = 512) {
    this.maxSize = maxSizeMB * 1024 * 1024;
  }

  private makeKey(
    layerName: string,
    ocioMode: string,
    channelMode: string,
    frameIndex: number,
    customFingerprint: string,
    framePath: string
  ): string {
    return `${layerName}__${ocioMode}__${channelMode}__${frameIndex}__${customFingerprint}__${framePath}`;
  }

  get(
    layerName: string,
    ocioMode: string,
    channelMode: string,
    frameIndex: number,
    customFingerprint: string,
    framePath: string
  ): CacheEntry | null {
    const key = this.makeKey(layerName, ocioMode, channelMode, frameIndex, customFingerprint, framePath);
    return this.cache.get(key) ?? null;
  }

  has(
    layerName: string,
    ocioMode: string,
    channelMode: string,
    frameIndex: number,
    customFingerprint: string,
    framePath: string
  ): boolean {
    const key = this.makeKey(layerName, ocioMode, channelMode, frameIndex, customFingerprint, framePath);
    return this.cache.has(key);
  }

  set(entry: CacheEntry): void {
    const key = this.makeKey(
      entry.layerName,
      entry.ocioMode,
      entry.channelMode,
      entry.frameIndex,
      entry.customFingerprint,
      entry.framePath
    );

    if (this.cache.has(key)) {
      const existing = this.cache.get(key)!;
      existing.bitmap.close();
      this.currentSize -= existing.estimatedBytes;
    }

    while (this.currentSize + entry.estimatedBytes > this.maxSize && this.cache.size > 0) {
      this.evictLRU();
    }

    this.cache.set(key, entry);
    this.currentSize += entry.estimatedBytes;
  }

  private evictLRU(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.decodedAt < oldestTime) {
        oldestTime = entry.decodedAt;
        oldest = key;
      }
    }

    if (oldest) {
      const entry = this.cache.get(oldest);
      if (entry) {
        entry.bitmap.close();
        this.currentSize -= entry.estimatedBytes;
      }
      this.cache.delete(oldest);
    }
  }

  clearAll(): void {
    for (const entry of this.cache.values()) {
      try {
        entry.bitmap.close();
      } catch { /* ignore */ }
    }
    this.cache.clear();
    this.currentSize = 0;
  }

  get size(): number {
    return this.cache.size;
  }

  get memoryUsageMB(): number {
    return this.currentSize / (1024 * 1024);
  }
}

export const unifiedCache = new UnifiedCache(512);
