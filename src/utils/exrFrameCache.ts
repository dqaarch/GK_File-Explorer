/**
 * EXR Frame Cache - Simple and Robust
 * Stores decoded frames in memory with LRU eviction
 * Supports disk cache for fast playback
 */

import { decodeExr, readCachedPng } from "../TauriFileSystem";

export interface CachedFrame {
  imageDataUrl: string;
  channels: string[];
  method: string;
  decodedAt: number;
  frameIndex: number;
  framePath: string;
}

export interface FrameStatus {
  frameIndex: number;
  status: 'pending' | 'loading' | 'loaded' | 'error';
}

export class EXRFrameCacheWithPreloader {
  // Cache by frameIndex
  private cache = new Map<number, CachedFrame>();

  // Frame status for UI
  private frameStatus = new Map<number, 'pending' | 'loading' | 'loaded' | 'error'>();

  // Loading promises to prevent duplicate loads
  private loadingPromises = new Map<number, Promise<CachedFrame | null>>();

  // Current settings
  private framePaths: string[] = [];
  private layerName: string = "";
  private ocioMode: string = "Linear sRGB";
  private maxSize: number = 2048;

  // Disk cache directory (set by preloadExrSequence)
  private diskCacheDir: string | null = null;

  // Track which frames have disk cache
  private diskCacheAvailable = new Set<number>();

  // Configure for a new sequence or settings change
  configure(framePaths: string[], layerName: string, ocioMode: string, maxSize: number): void {
    this.framePaths = framePaths;
    this.layerName = layerName;
    this.ocioMode = ocioMode;
    this.maxSize = maxSize;

    // Clear disk cache tracking
    this.diskCacheAvailable.clear();

    // Clear loading promises when settings change
    this.loadingPromises.clear();
  }

  // Set disk cache directory (called after preloadExrSequence)
  setDiskCacheDir(dir: string | null): void {
    this.diskCacheDir = dir;
    console.log(`[EXR Cache] Disk cache dir set to: ${dir}`);
  }

  // Mark a frame as having disk cache available
  markDiskCacheAvailable(frameIndex: number): void {
    this.diskCacheAvailable.add(frameIndex);
  }

  // Mark multiple frames as having disk cache available
  markDiskCacheAvailableBatch(frameIndices: number[]): void {
    frameIndices.forEach(i => this.diskCacheAvailable.add(i));
    console.log(`[EXR Cache] Marked ${frameIndices.length} frames as disk cache available`);
  }

  getDiskCacheDir(): string | null {
    return this.diskCacheDir;
  }

  getFramePath(frameIndex: number): string | undefined {
    if (frameIndex >= 0 && frameIndex < this.framePaths.length) {
      return this.framePaths[frameIndex];
    }
    return undefined;
  }

  getTotalFrames(): number {
    return this.framePaths.length;
  }

  // Check if frame is in memory cache (sync)
  isFrameLoaded(frameIndex: number): boolean {
    const cached = this.cache.get(frameIndex);
    return cached !== undefined &&
           cached.framePath === this.getFramePath(frameIndex) &&
           Date.now() - cached.decodedAt < 5 * 60 * 1000; // 5 min age
  }

  // Check if frame is available in disk cache
  hasDiskCache(frameIndex: number): boolean {
    return this.diskCacheAvailable.has(frameIndex);
  }

  // Check if frame is ready (memory or disk cache) - ASYNC
  async isFrameReady(frameIndex: number): Promise<boolean> {
    // Check memory cache first
    if (this.isFrameLoaded(frameIndex)) {
      console.log(`[EXR Cache] Frame ${frameIndex} ready in memory cache`);
      return true;
    }

    // Check if we know disk cache exists
    if (this.hasDiskCache(frameIndex)) {
      console.log(`[EXR Cache] Frame ${frameIndex} has disk cache, attempting load`);
      // Try to load from disk cache
      const cached = await this.loadFrame(frameIndex);
      return cached !== null;
    }

    // No cache available - frame not ready
    console.log(`[EXR Cache] Frame ${frameIndex} not ready (no memory or disk cache)`);
    return false;
  }

  // Get cached frame synchronously
  getCachedFrame(frameIndex: number): CachedFrame | null {
    const cached = this.cache.get(frameIndex);
    if (cached && cached.framePath === this.getFramePath(frameIndex)) {
      return cached;
    }
    return null;
  }

  getFrameStatus(frameIndex: number): 'pending' | 'loading' | 'loaded' | 'error' {
    return this.frameStatus.get(frameIndex) || 'pending';
  }

  getAllFrameStatuses(): FrameStatus[] {
    const statuses: FrameStatus[] = [];
    for (let i = 0; i < this.framePaths.length; i++) {
      statuses.push({
        frameIndex: i,
        status: this.getFrameStatus(i)
      });
    }
    return statuses;
  }

  // Load a single frame (async, with deduplication)
  // Priority: Memory cache → Disk cache → Decode EXR
  async loadFrame(frameIndex: number): Promise<CachedFrame | null> {
    const framePath = this.getFramePath(frameIndex);
    if (!framePath) {
      console.warn(`[EXR Cache] No path for frame ${frameIndex}`);
      return null;
    }

    // Check memory cache first
    const cached = this.getCachedFrame(frameIndex);
    if (cached) {
      this.frameStatus.set(frameIndex, 'loaded');
      return cached;
    }

    // Check if already loading
    const existingPromise = this.loadingPromises.get(frameIndex);
    if (existingPromise) {
      return existingPromise;
    }

    // Start loading
    this.frameStatus.set(frameIndex, 'loading');

    const loadPromise = this.doLoadFrame(frameIndex, framePath);
    this.loadingPromises.set(frameIndex, loadPromise);

    try {
      const result = await loadPromise;
      return result;
    } finally {
      this.loadingPromises.delete(frameIndex);
    }
  }

  private async doLoadFrame(frameIndex: number, framePath: string): Promise<CachedFrame | null> {
    try {
      // Try disk cache first if available
      if (this.diskCacheDir) {
        console.log(`[EXR Cache] Trying disk cache for frame ${frameIndex}: ${this.diskCacheDir}`);
        try {
          const cachedPng = await readCachedPng(this.diskCacheDir, frameIndex);
          if (cachedPng) {
            console.log(`[EXR Cache] Frame ${frameIndex} loaded from disk cache, PNG length: ${cachedPng.length}`);
            const cached: CachedFrame = {
              imageDataUrl: cachedPng,
              channels: [],
              method: 'disk_cache',
              decodedAt: Date.now(),
              frameIndex,
              framePath
            };
            this.cache.set(frameIndex, cached);
            this.frameStatus.set(frameIndex, 'loaded');
            return cached;
          } else {
            console.log(`[EXR Cache] Disk cache miss for frame ${frameIndex}, falling back to decode`);
          }
        } catch (e) {
          console.log(`[EXR Cache] Disk cache read failed for frame ${frameIndex}: ${e}`);
        }
      }

      // Fall back to decodeExr
      console.log(`[EXR Cache] Falling back to decodeExr for frame ${frameIndex}`);
      const result = await decodeExr(
        framePath,
        this.maxSize,
        this.ocioMode,
        this.layerName || null
      );

      if (result.success && result.png_base64) {
        const imageDataUrl = `data:image/png;base64,${result.png_base64}`;

        const cached: CachedFrame = {
          imageDataUrl,
          channels: result.channels || [],
          method: result.method || 'UNKNOWN',
          decodedAt: Date.now(),
          frameIndex,
          framePath
        };

        // Store in cache
        this.cache.set(frameIndex, cached);
        this.frameStatus.set(frameIndex, 'loaded');

        // Evict old frames if cache too large
        this.evictIfNeeded();

        return cached;
      } else {
        console.error(`[EXR Cache] decodeExr failed for frame ${frameIndex}: ${JSON.stringify(result)}`);
        this.frameStatus.set(frameIndex, 'error');
        return null;
      }
    } catch (err) {
      console.error(`[EXR Cache] Failed to load frame ${frameIndex}:`, err);
      this.frameStatus.set(frameIndex, 'error');
      return null;
    }
  }

  private evictIfNeeded(): void {
    const maxFrames = 30; // Keep max 30 frames in memory

    if (this.cache.size > maxFrames) {
      // Find oldest frames to evict
      const entries = Array.from(this.cache.entries());
      entries.sort((a, b) => a[1].decodedAt - b[1].decodedAt);

      // Remove oldest 10 frames
      const toRemove = entries.slice(0, 10);
      for (const [idx] of toRemove) {
        this.cache.delete(idx);
      }

      console.log(`[EXR Cache] Evicted ${toRemove.length} old frames, ${this.cache.size} remaining`);
    }
  }

  clear(): void {
    this.cache.clear();
    this.frameStatus.clear();
    this.loadingPromises.clear();
    this.diskCacheAvailable.clear();
    console.log('[EXR Cache] Cleared');
  }

  // Preload frames in sequence (for playback)
  async preloadAhead(centerFrame: number, count: number): Promise<void> {
    const promises: Promise<CachedFrame | null>[] = [];

    for (let i = 1; i <= count; i++) {
      const frameIdx = centerFrame + i;
      if (frameIdx < this.framePaths.length && !this.isFrameLoaded(frameIdx)) {
        promises.push(this.loadFrame(frameIdx));
      }
    }

    if (promises.length > 0) {
      console.log(`[EXR Preload] Preloading ${promises.length} frames ahead of ${centerFrame}`);
      await Promise.all(promises);
    }
  }

  // Preload ALL remaining frames in sequence
  async preloadAll(): Promise<void> {
    const promises: Promise<CachedFrame | null>[] = [];

    for (let i = 0; i < this.framePaths.length; i++) {
      if (!this.isFrameLoaded(i)) {
        promises.push(this.loadFrame(i));
      }
    }

    if (promises.length > 0) {
      console.log(`[EXR Preload] Preloading ALL ${promises.length} frames...`);
      await Promise.all(promises);
      console.log(`[EXR Preload] All frames preloaded!`);
    } else {
      console.log(`[EXR Preload] All frames already in cache`);
    }
  }

  // Get preload progress
  getPreloadProgress(): { loaded: number; total: number; percent: number } {
    let loaded = 0;
    for (let i = 0; i < this.framePaths.length; i++) {
      if (this.isFrameLoaded(i)) loaded++;
    }
    return {
      loaded,
      total: this.framePaths.length,
      percent: this.framePaths.length > 0 ? Math.round((loaded / this.framePaths.length) * 100) : 0
    };
  }

  // Get loading progress for buffer
  getLoadedCount(startFrame: number, endFrame: number): number {
    let count = 0;
    for (let i = startFrame; i <= endFrame && i < this.framePaths.length; i++) {
      if (this.isFrameLoaded(i)) count++;
    }
    return count;
  }
}

// Singleton instance
export const globalEXRPreloader = new EXRFrameCacheWithPreloader();
