/**
 * Stream Playback Engine for EXR Sequences
 * 
 * AE-style playback with continuous frame streaming:
 * - Checks RAM cache (instant display)
 * - Loads from disk cache to RAM
 * - Decodes missing frames on-demand
 * - Background preload for smooth playback
 * 
 * Inspired by After Effects High-Performance Preview Playback (HPPP):
 * - Continuous streaming from disk to RAM
 * - Adaptive quality based on performance
 * - Never drops frames during playback
 */

import { SmartPreloadManager, SmartPreloadConfig, PreloadStats } from "./smartPreloadManager";
import { RingBufferRAMCache, CachedFrame, FramePriority } from "./ringBufferCache";

export type PlaybackQuality = 'auto' | 'full' | 'fast';

export interface StreamPlaybackConfig {
  /** Quality mode */
  quality: PlaybackQuality;
  /** Target FPS */
  targetFps: number;
  /** Minimum frames to have ready ahead */
  minBufferFrames: number;
  /** Enable adaptive quality */
  adaptiveQuality: boolean;
  /** Quality downgrade threshold (missed frames %) */
  qualityDowngradeThreshold: number;
  /** Quality upgrade threshold (success %) */
  qualityUpgradeThreshold: number;
}

export interface StreamState {
  currentFrame: number;
  displayedFrame: number | null;
  isPlaying: boolean;
  isBuffering: boolean;
  quality: 'full' | 'fast';
  droppedFrames: number;
  totalFrames: number;
  framesInBuffer: number;
}

export interface FrameRequest {
  frameIndex: number;
  priority: FramePriority;
  timestamp: number;
}

/**
 * Stream Playback Engine
 * 
 * Manages smooth playback by:
 * 1. Maintaining a buffer of decoded frames
 * 2. Streaming frames from disk cache to RAM
 * 3. Decoding frames on-demand
 * 4. Adjusting quality based on performance
 */
export class StreamPlaybackEngine {
  private config: StreamPlaybackConfig;
  private preloadManager: SmartPreloadManager;
  private state: StreamState;
  
  // Playback control
  private playbackLoop: ReturnType<typeof setTimeout> | null = null;
  private lastFrameTime: number = 0;
  private frameInterval: number = 1000 / 25; // Default 25 FPS
  
  // Buffer management
  private frameBuffer: Map<number, CachedFrame> = new Map();
  private maxBufferSize: number = 10;
  private bufferLowWater: number = 3;
  
  // Performance tracking
  private frameTimes: number[] = [];
  private missedFrameCount: number = 0;
  private totalFrameCount: number = 0;
  
  // Callbacks
  private onFrameDisplay?: (frameIndex: number, frame: CachedFrame) => void;
  private onStateChange?: (state: StreamState) => void;
  private onBufferChange?: (bufferedFrames: number, totalBuffer: number) => void;
  private onQualityChange?: (quality: 'full' | 'fast') => void;

  constructor(config?: Partial<StreamPlaybackConfig>) {
    this.config = {
      quality: 'auto',
      targetFps: 25,
      minBufferFrames: 3,
      adaptiveQuality: true,
      qualityDowngradeThreshold: 30, // 30% missed frames
      qualityUpgradeThreshold: 90, // 90% success rate
      ...config
    };
    
    this.preloadManager = new SmartPreloadManager({
      ramCacheSize: 30,
      basePreloadAhead: 5,
      maxConcurrentDecodes: 2,
      enableDiskCache: true
    });
    
    this.state = {
      currentFrame: 0,
      displayedFrame: null,
      isPlaying: false,
      isBuffering: false,
      quality: 'full',
      droppedFrames: 0,
      totalFrames: 0,
      framesInBuffer: 0
    };
    
    this.frameInterval = 1000 / this.config.targetFps;
  }

  /**
   * Initialize for a sequence
   */
  async initialize(
    framePaths: string[],
    settings: { maxSize: number; ocioMode: string; layerName: string },
    frameCount: number
  ): Promise<void> {
    await this.preloadManager.configure(framePaths, settings);
    
    this.state.totalFrames = frameCount;
    this.state.currentFrame = 0;
    this.state.displayedFrame = null;
    this.frameBuffer.clear();
    
    console.log(`[StreamEngine] Initialized for ${frameCount} frames`);
  }

  /**
   * Start playback
   */
  async play(): Promise<void> {
    if (this.state.isPlaying) return;
    
    this.state.isPlaying = true;
    this.notifyStateChange();
    
    // Preload initial frames
    await this.preloadManager.preloadForPlayback();
    
    // Start playback loop
    this.lastFrameTime = performance.now();
    this.scheduleNextFrame();
    
    console.log('[StreamEngine] Playback started');
  }

  /**
   * Pause playback
   */
  pause(): void {
    if (!this.state.isPlaying) return;
    
    this.state.isPlaying = false;
    
    if (this.playbackLoop) {
      clearTimeout(this.playbackLoop);
      this.playbackLoop = null;
    }
    
    this.notifyStateChange();
    console.log('[StreamEngine] Playback paused');
  }

  /**
   * Stop playback and reset
   */
  stop(): void {
    this.pause();
    this.state.currentFrame = 0;
    this.state.displayedFrame = null;
    this.frameBuffer.clear();
    this.notifyStateChange();
  }

  /**
   * Seek to a specific frame
   */
  async seek(frameIndex: number): Promise<void> {
    const wasPlaying = this.state.isPlaying;
    
    // Pause during seek
    if (wasPlaying) {
      this.pause();
    }
    
    // Update position
    this.state.currentFrame = Math.max(0, Math.min(frameIndex, this.state.totalFrames - 1));
    this.preloadManager.updatePlaybackState({
      currentFrame: this.state.currentFrame,
      direction: frameIndex > (this.state.displayedFrame || 0) ? 1 : -1
    });
    
    // Load frame at position
    await this.displayFrame(this.state.currentFrame);
    
    // Resume if was playing
    if (wasPlaying) {
      await this.play();
    }
  }

  /**
   * Schedule next frame in playback loop
   */
  private scheduleNextFrame(): void {
    if (!this.state.isPlaying) return;
    
    const now = performance.now();
    const elapsed = now - this.lastFrameTime;
    const delay = Math.max(0, this.frameInterval - elapsed);
    
    this.playbackLoop = setTimeout(async () => {
      await this.playbackStep();
    }, delay);
  }

  /**
   * Playback step - advance one frame
   */
  private async playbackStep(): Promise<void> {
    if (!this.state.isPlaying) return;
    
    this.lastFrameTime = performance.now();
    this.totalFrameCount++;
    
    // Check if we have the next frame in buffer
    const nextFrame = this.state.currentFrame + 1;
    
    // Check buffer first
    let frame = this.frameBuffer.get(nextFrame);
    
    if (frame) {
      // Frame is buffered, display immediately
      this.frameBuffer.delete(nextFrame);
      this.displayFrameData(nextFrame, frame);
      this.state.currentFrame = nextFrame;
      
      // Update buffer status
      this.updateBufferStatus();
    } else {
      // Frame not in buffer, check if we can get it quickly
      const cached = this.preloadManager.getFrameSync(nextFrame);
      
      if (cached) {
        this.displayFrameData(nextFrame, cached);
        this.state.currentFrame = nextFrame;
      } else {
        // Can't display frame, count as dropped
        this.missedFrameCount++;
        this.state.droppedFrames++;
        
        // Still advance position but mark as dropped
        this.state.currentFrame = nextFrame;
        console.warn(`[StreamEngine] Dropped frame ${nextFrame}`);
        
        // Check for quality adjustment
        this.checkQualityAdjustment();
      }
    }
    
    // Check for end of sequence
    if (this.state.currentFrame >= this.state.totalFrames - 1) {
      this.pause();
      console.log('[StreamEngine] End of sequence');
      return;
    }
    
    // Continue preloading
    this.preloadManager.continuePreload();
    
    // Schedule next frame
    this.scheduleNextFrame();
  }

  /**
   * Display a frame (for non-playing seeking)
   */
  async displayFrame(frameIndex: number): Promise<void> {
    // Check buffer first
    let frame = this.frameBuffer.get(frameIndex);
    
    if (frame) {
      this.frameBuffer.delete(frameIndex);
      this.displayFrameData(frameIndex, frame);
      this.updateBufferStatus();
      return;
    }
    
    // Check RAM cache
    frame = this.preloadManager.getFrameSync(frameIndex);
    
    if (frame) {
      this.displayFrameData(frameIndex, frame);
      return;
    }
    
    // Need to load
    this.state.isBuffering = true;
    this.notifyStateChange();
    
    try {
      frame = await this.preloadManager.getFrame(frameIndex, FramePriority.CRITICAL);
      
      if (frame) {
        this.displayFrameData(frameIndex, frame);
      }
    } finally {
      this.state.isBuffering = false;
      this.notifyStateChange();
    }
  }

  /**
   * Display frame data and trigger callback
   */
  private displayFrameData(frameIndex: number, frame: CachedFrame): void {
    this.state.displayedFrame = frameIndex;
    this.notifyStateChange();
    
    if (this.onFrameDisplay) {
      this.onFrameDisplay(frameIndex, frame);
    }
  }

  /**
   * Update buffer status
   */
  private updateBufferStatus(): void {
    this.state.framesInBuffer = this.frameBuffer.size;
    
    if (this.onBufferChange) {
      this.onBufferChange(this.frameBuffer.size, this.maxBufferSize);
    }
  }

  /**
   * Buffer a frame for future playback
   */
  async bufferFrame(frameIndex: number): Promise<void> {
    if (this.frameBuffer.has(frameIndex)) return;
    if (this.frameBuffer.size >= this.maxBufferSize) {
      // Remove oldest frame from buffer
      const oldestKey = this.frameBuffer.keys().next().value;
      if (oldestKey !== undefined) {
        this.frameBuffer.delete(oldestKey);
      }
    }
    
    const frame = await this.preloadManager.getFrame(frameIndex, FramePriority.HIGH);
    if (frame) {
      this.frameBuffer.set(frameIndex, frame);
      this.updateBufferStatus();
    }
  }

  /**
   * Check and adjust quality based on performance
   */
  private checkQualityAdjustment(): void {
    if (!this.config.adaptiveQuality) return;
    if (this.totalFrameCount < 30) return; // Wait for enough samples
    
    const missRate = (this.missedFrameCount / this.totalFrameCount) * 100;
    
    // Downgrade if missing too many frames
    if (missRate >= this.config.qualityDowngradeThreshold && this.state.quality === 'full') {
      this.state.quality = 'fast';
      this.missedFrameCount = 0;
      this.totalFrameCount = 0;
      
      if (this.onQualityChange) {
        this.onQualityChange('fast');
      }
      
      console.log(`[StreamEngine] Quality downgraded to FAST (miss rate: ${missRate.toFixed(1)}%)`);
      return;
    }
    
    // Upgrade if performing well
    if (missRate <= this.config.qualityUpgradeThreshold && this.state.quality === 'fast') {
      this.state.quality = 'full';
      this.missedFrameCount = 0;
      this.totalFrameCount = 0;
      
      if (this.onQualityChange) {
        this.onQualityChange('full');
      }
      
      console.log(`[StreamEngine] Quality upgraded to FULL (miss rate: ${missRate.toFixed(1)}%)`);
    }
  }

  /**
   * Get current state
   */
  getState(): StreamState {
    return { ...this.state };
  }

  /**
   * Get preload statistics
   */
  getPreloadStats(): PreloadStats {
    return this.preloadManager.getStats();
  }

  /**
   * Set callbacks
   */
  setCallbacks(callbacks: {
    onFrameDisplay?: (frameIndex: number, frame: CachedFrame) => void;
    onStateChange?: (state: StreamState) => void;
    onBufferChange?: (bufferedFrames: number, totalBuffer: number) => void;
    onQualityChange?: (quality: 'full' | 'fast') => void;
  }): void {
    if (callbacks.onFrameDisplay) this.onFrameDisplay = callbacks.onFrameDisplay;
    if (callbacks.onStateChange) this.onStateChange = callbacks.onStateChange;
    if (callbacks.onBufferChange) this.onBufferChange = callbacks.onBufferChange;
    if (callbacks.onQualityChange) this.onQualityChange = callbacks.onQualityChange;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<StreamPlaybackConfig>): void {
    this.config = { ...this.config, ...config };
    this.frameInterval = 1000 / this.config.targetFps;
  }

  /**
   * Set playback FPS
   */
  setFps(fps: number): void {
    this.config.targetFps = fps;
    this.frameInterval = 1000 / fps;
  }

  /**
   * Skip forward/backward by frame count
   */
  async skip(frames: number): Promise<void> {
    await this.seek(this.state.currentFrame + frames);
  }

  /**
   * Step to next/previous frame (single step)
   */
  async stepNext(): Promise<void> {
    await this.seek(this.state.currentFrame + 1);
  }

  async stepPrevious(): Promise<void> {
    await this.seek(this.state.currentFrame - 1);
  }

  /**
   * Notify state change
   */
  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange(this.getState());
    }
  }

  /**
   * Clear all caches
   */
  async clearCaches(): Promise<void> {
    this.frameBuffer.clear();
    await this.preloadManager.clearCaches();
    this.missedFrameCount = 0;
    this.totalFrameCount = 0;
    this.state.droppedFrames = 0;
  }

  /**
   * Dispose and clean up
   */
  dispose(): void {
    this.pause();
    this.frameBuffer.clear();
    this.preloadManager.dispose();
    this.onFrameDisplay = undefined;
    this.onStateChange = undefined;
    this.onBufferChange = undefined;
    this.onQualityChange = undefined;
  }
}

// Singleton instance
export const globalStreamEngine = new StreamPlaybackEngine();
