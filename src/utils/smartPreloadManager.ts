/**
 * Smart Preload Manager for EXR Sequences
 * 
 * Implements AE-style adaptive preloading:
 * - Forward bias: Preload more ahead than behind
 * - Backward detection: Detect scrubbing and adjust priority
 * - Adaptive batch size: Increase preload when playback is stable
 * - Disk I/O aware: Adjust based on storage speed
 */

import { RingBufferRAMCache, CachedFrame, FramePriority, PriorityDecodeQueue } from "./ringBufferCache";
import { globalPersistentCache } from "./persistentExrCache";
import { decodeExr } from "../TauriFileSystem";

export interface SmartPreloadConfig {
  /** Maximum frames to cache in RAM */
  ramCacheSize: number;
  /** Base frames to preload ahead */
  basePreloadAhead: number;
  /** Frames to preload behind (usually less than ahead) */
  preloadBehind: number;
  /** Maximum concurrent decode operations */
  maxConcurrentDecodes: number;
  /** Enable disk cache */
  enableDiskCache: boolean;
  /** Maximum disk cache size in bytes */
  maxDiskCacheSize: number;
}

export interface PlaybackState {
  currentFrame: number;
  direction: 1 | -1;
  isPlaying: boolean;
  playbackFps: number;
  frameCount: number;
}

export interface PreloadStats {
  framesInRam: number;
  framesInDisk: number;
  framesLoading: number;
  queueSize: number;
  cacheHitRate: number;
  preloadEfficiency: number;
}

/**
 * Smart Preload Manager
 * 
 * Manages frame preloading with intelligent scheduling:
 * 1. Prioritizes frames in playback direction
 * 2. Adjusts preload based on playback stability
 * 3. Uses both RAM and disk cache
 * 4. Integrates with Rust backend for decoding
 */
export class SmartPreloadManager {
  private config: SmartPreloadConfig;
  private ramCache: RingBufferRAMCache;
  private decodeQueue: PriorityDecodeQueue;
  
  // State
  private framePaths: string[] = [];
  private settings: { maxSize: number; ocioMode: string; layerName: string } = {
    maxSize: 2048,
    ocioMode: "Linear sRGB",
    layerName: ""
  };
  private currentFrame: number = 0;
  private direction: 1 | -1 = 1;
  private isPlaying: boolean = false;
  private playbackFps: number = 25;
  
  // Adaptive parameters
  private stablePlaybackFrames: number = 0;
  private lastStablePosition: number = 0;
  private adaptivePreloadMultiplier: number = 1.0;
  
  // Statistics
  private totalDecodes: number = 0;
  private cacheHits: number = 0;
  private diskCacheHits: number = 0;
  
  // Active decode operations
  private activeDecodes: Map<number, Promise<CachedFrame | null>> = new Map();
  
  // Callbacks
  private onFrameReady?: (frameIndex: number, frame: CachedFrame) => void;
  private onProgress?: (stats: PreloadStats) => void;

  constructor(config?: Partial<SmartPreloadConfig>) {
    this.config = {
      ramCacheSize: 30,
      basePreloadAhead: 5,
      preloadBehind: 2,
      maxConcurrentDecodes: 2,
      enableDiskCache: true,
      maxDiskCacheSize: 2 * 1024 * 1024 * 1024, // 2GB
      ...config
    };
    
    this.ramCache = new RingBufferRAMCache(this.config.ramCacheSize);
    this.decodeQueue = new PriorityDecodeQueue(this.config.maxConcurrentDecodes);
  }

  /**
   * Configure for a new sequence
   */
  async configure(
    framePaths: string[],
    settings: { maxSize: number; ocioMode: string; layerName: string }
  ): Promise<void> {
    this.framePaths = framePaths;
    this.settings = settings;
    
    // Initialize persistent disk cache
    if (this.config.enableDiskCache) {
      await globalPersistentCache.initialize(framePaths, settings);
    }
    
    // Clear caches
    this.ramCache.clear();
    this.decodeQueue.clear();
    this.activeDecodes.clear();
    
    // Reset statistics
    this.totalDecodes = 0;
    this.cacheHits = 0;
    this.diskCacheHits = 0;
    this.stablePlaybackFrames = 0;
    this.adaptivePreloadMultiplier = 1.0;
    
    console.log(`[SmartPreload] Configured for ${framePaths.length} frames, layer=${settings.layerName || '(default)'}, mode=${settings.ocioMode}`);
  }

  /**
   * Update playback state
   */
  updatePlaybackState(state: Partial<PlaybackState>): void {
    const prevFrame = this.currentFrame;
    
    if (state.currentFrame !== undefined) {
      // Detect direction
      if (state.currentFrame > prevFrame) {
        this.direction = 1;
        this.stablePlaybackFrames++;
      } else if (state.currentFrame < prevFrame) {
        this.direction = -1;
        // Reset stable count when scrubbing backward
        this.stablePlaybackFrames = 0;
      }
      
      this.currentFrame = state.currentFrame;
      this.ramCache.setCurrentPosition(state.currentFrame);
    }
    
    if (state.isPlaying !== undefined) {
      this.isPlaying = state.isPlaying;
      
      if (!state.isPlaying) {
        // Reset adaptive multiplier when stopped
        this.adaptivePreloadMultiplier = 1.0;
      }
    }
    
    if (state.playbackFps !== undefined) {
      this.playbackFps = state.playbackFps;
    }
    
    // Update adaptive preload based on stability
    this.updateAdaptivePreload();
  }

  /**
   * Update adaptive preload multiplier based on playback stability
   */
  private updateAdaptivePreload(): void {
    // If playing forward for a while, increase preload
    if (this.stablePlaybackFrames > 30 && this.direction === 1) {
      this.adaptivePreloadMultiplier = Math.min(3.0, 1.0 + this.stablePlaybackFrames / 100);
    } else if (this.direction === -1) {
      // Reduce preload when scrubbing
      this.adaptivePreloadMultiplier = 0.5;
    } else {
      this.adaptivePreloadMultiplier = 1.0;
    }
  }

  /**
   * Get calculated preload count
   */
  private getPreloadCount(): { ahead: number; behind: number } {
    const ahead = Math.round(this.config.basePreloadAhead * this.adaptivePreloadMultiplier);
    const behind = Math.round(this.config.preloadBehind * this.adaptivePreloadMultiplier);
    
    return {
      ahead: Math.min(ahead, this.framePaths.length - 1),
      behind: Math.min(behind, this.currentFrame)
    };
  }

  /**
   * Get a frame (from cache or decode)
   * This is the main entry point for frame access
   */
  async getFrame(frameIndex: number, priority: FramePriority = FramePriority.MEDIUM): Promise<CachedFrame | null> {
    // Check RAM cache first
    const cached = this.ramCache.get(frameIndex);
    if (cached) {
      this.cacheHits++;
      return cached;
    }

    // Check if already decoding
    const existingDecode = this.activeDecodes.get(frameIndex);
    if (existingDecode) {
      return existingDecode;
    }

    // Start decode
    const decodePromise = this.decodeFrame(frameIndex, priority);
    this.activeDecodes.set(frameIndex, decodePromise);
    
    try {
      const result = await decodePromise;
      return result;
    } finally {
      this.activeDecodes.delete(frameIndex);
    }
  }

  /**
   * Decode a single frame
   */
  private async decodeFrame(frameIndex: number, priority: FramePriority): Promise<CachedFrame | null> {
    const framePath = this.framePaths[frameIndex];
    if (!framePath) {
      console.warn(`[SmartPreload] No path for frame ${frameIndex}`);
      return null;
    }

    this.totalDecodes++;
    const startTime = Date.now();

    try {
      // Disk cache has been removed - decode directly via Rust/Python backend.
      const result = await decodeExr(
        framePath,
        this.settings.maxSize,
        this.settings.ocioMode,
        this.settings.layerName || null
      );

      if (result.success && result.png_base64) {
        const imageDataUrl = `data:image/png;base64,${result.png_base64}`;

        const frame: CachedFrame = {
          imageDataUrl,
          channels: result.channels || [],
          method: result.method || 'decode',
          decodedAt: Date.now(),
          frameIndex,
          framePath,
          accessCount: 1,
          lastAccessed: Date.now()
        };

        // Cache in RAM
        this.ramCache.set(frameIndex, frame);

        const elapsed = Date.now() - startTime;
        console.log(`[SmartPreload] Frame ${frameIndex} decoded in ${elapsed}ms (priority=${FramePriority[priority]})`);

        this.notifyFrameReady(frameIndex, frame);
        return frame;
      } else {
        console.error(`[SmartPreload] Decode failed for frame ${frameIndex}:`, result.error);
        return null;
      }
    } catch (err) {
      console.error(`[SmartPreload] Error decoding frame ${frameIndex}:`, err);
      return null;
    }
  }

  /**
   * Preload frames around current position
   * Call this when playback position changes
   */
  async preloadAroundCurrent(centerFrame: number, priority: FramePriority = FramePriority.MEDIUM): Promise<void> {
    const { ahead, behind } = this.getPreloadCount();
    
    // Calculate frames to preload
    const framesToPreload: Array<{ index: number; priority: FramePriority }> = [];
    
    // Frames ahead (higher priority)
    for (let i = 1; i <= ahead; i++) {
      const frameIdx = centerFrame + i;
      if (frameIdx >= 0 && frameIdx < this.framePaths.length) {
        if (!this.ramCache.has(frameIdx)) {
          const framePriority = i <= 2 ? FramePriority.HIGH : priority;
          framesToPreload.push({ index: frameIdx, priority: framePriority });
        }
      }
    }
    
    // Frames behind (lower priority)
    for (let i = 1; i <= behind; i++) {
      const frameIdx = centerFrame - i;
      if (frameIdx >= 0 && frameIdx < this.framePaths.length) {
        if (!this.ramCache.has(frameIdx)) {
          framesToPreload.push({ index: frameIdx, priority: FramePriority.LOW });
        }
      }
    }

    // Start preloading
    for (const { index, priority } of framesToPreload) {
      if (!this.activeDecodes.has(index)) {
        this.getFrame(index, priority).catch(() => {});
      }
    }

    console.log(`[SmartPreload] Preloading ${framesToPreload.length} frames around ${centerFrame} (ahead=${ahead}, behind=${behind})`);
  }

  /**
   * Preload frames for playback start
   * Called when user presses play
   */
  async preloadForPlayback(): Promise<void> {
    console.log(`[SmartPreload] Starting playback preload for frame ${this.currentFrame}`);
    
    // Clear any stale completed frames from queue
    this.decodeQueue.clearCompleted();
    
    // Get initial batch
    const { ahead } = this.getPreloadCount();
    const batchSize = Math.min(ahead * 2, 10); // Initial burst
    
    // Preload current + next frames
    for (let i = 0; i <= batchSize; i++) {
      const frameIdx = this.currentFrame + i;
      if (frameIdx >= 0 && frameIdx < this.framePaths.length) {
        if (!this.ramCache.has(frameIdx)) {
          this.getFrame(frameIdx, i === 0 ? FramePriority.CRITICAL : FramePriority.HIGH).catch(() => {});
        }
      }
    }
  }

  /**
   * Start continuous preloading during playback
   * Should be called periodically during playback
   */
  async continuePreload(): Promise<void> {
    // Preload more frames in current direction
    await this.preloadAroundCurrent(this.currentFrame, FramePriority.MEDIUM);
    
    // Update progress
    this.reportProgress();
  }

  /**
   * Check if a frame is ready (in RAM or being decoded)
   */
  isFrameReady(frameIndex: number): boolean {
    return this.ramCache.has(frameIndex) || this.activeDecodes.has(frameIndex);
  }

  /**
   * Get frame if available (sync)
   */
  getFrameSync(frameIndex: number): CachedFrame | null {
    return this.ramCache.get(frameIndex);
  }

  /**
   * Get preload statistics
   */
  getStats(): PreloadStats {
    const ramStats = this.ramCache.getStats();
    const queueInfo = this.decodeQueue.getInfo();
    
    let diskCacheCount = 0;
    if (this.config.enableDiskCache) {
      diskCacheCount = globalPersistentCache.getCachedFrameIndices().length;
    }
    
    const total = this.cacheHits + this.diskCacheHits + this.totalDecodes;
    const hitRate = total > 0 ? ((this.cacheHits + this.diskCacheHits) / total) * 100 : 0;
    
    // Calculate preload efficiency
    const preloadEfficiency = this.totalDecodes > 0 
      ? (this.cacheHits / this.totalDecodes) * 100 
      : 0;

    return {
      framesInRam: this.ramCache.size,
      framesInDisk: diskCacheCount,
      framesLoading: this.activeDecodes.size,
      queueSize: queueInfo.queueSize,
      cacheHitRate: hitRate,
      preloadEfficiency
    };
  }

  /**
   * Report progress to callback
   */
  private reportProgress(): void {
    if (this.onProgress) {
      this.onProgress(this.getStats());
    }
  }

  /**
   * Notify that a frame is ready
   */
  private notifyFrameReady(frameIndex: number, frame: CachedFrame): void {
    if (this.onFrameReady) {
      this.onFrameReady(frameIndex, frame);
    }
  }

  /**
   * Set callbacks
   */
  setCallbacks(callbacks: {
    onFrameReady?: (frameIndex: number, frame: CachedFrame) => void;
    onProgress?: (stats: PreloadStats) => void;
  }): void {
    if (callbacks.onFrameReady) this.onFrameReady = callbacks.onFrameReady;
    if (callbacks.onProgress) this.onProgress = callbacks.onProgress;
  }

  /**
   * Clear all caches
   */
  async clearCaches(): Promise<void> {
    this.ramCache.clear();
    this.decodeQueue.clear();
    this.decodeQueue.clearCompleted();
    this.activeDecodes.clear();
    
    if (this.config.enableDiskCache) {
      await globalPersistentCache.clearFrames();
    }
    
    console.log('[SmartPreload] All caches cleared');
  }

  /**
   * Clear disk cache only
   */
  async clearDiskCache(): Promise<void> {
    if (this.config.enableDiskCache) {
      await globalPersistentCache.clearAll();
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): SmartPreloadConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SmartPreloadConfig>): void {
    this.config = { ...this.config, ...config };
    
    // Update cache sizes
    this.ramCache.setCapacity(this.config.ramCacheSize);
    this.decodeQueue = new PriorityDecodeQueue(this.config.maxConcurrentDecodes);
  }

  /**
   * Dispose and clean up
   */
  dispose(): void {
    this.ramCache.clear();
    this.decodeQueue.clear();
    this.activeDecodes.clear();
    this.onFrameReady = undefined;
    this.onProgress = undefined;
  }
}

// Singleton instance
export const globalSmartPreloader = new SmartPreloadManager();
