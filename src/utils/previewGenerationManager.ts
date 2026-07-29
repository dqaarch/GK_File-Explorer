/**
 * Preview Generation Manager
 * 
 * Handles "AE-style" preview generation:
 * - Decode first frame immediately for instant preview
 * - Start background decoding of remaining frames
 * - Progressive quality enhancement
 * - Cache warming
 * 
 * Inspired by After Effects' "Quick Preview" and "Draft" modes.
 */

import { globalSmartPreloader, SmartPreloadConfig } from "./smartPreloadManager";
import { globalPersistentCache } from "./persistentExrCache";
import { globalAdaptiveQuality, QualityLevel } from "./adaptiveQualityManager";
import { CachedFrame, FramePriority } from "./ringBufferCache";

export type PreviewMode = 'instant' | 'draft' | 'fast' | 'full';
export type PreviewPhase = 'loading' | 'decoding' | 'warming' | 'ready' | 'error';

export interface PreviewProgress {
  phase: PreviewPhase;
  currentFrame: number;
  totalFrames: number;
  progress: number;
  decodedFrames: number;
  cachedFrames: number;
  estimatedTimeRemaining: number;
  message: string;
}

export interface PreviewConfig {
  /** Initial preview mode */
  initialMode: PreviewMode;
  /** Frames to decode before showing preview */
  framesForInstantPreview: number;
  /** Enable progressive enhancement */
  progressiveEnhancement: boolean;
  /** Enable cache warming */
  cacheWarming: boolean;
  /** Priority for initial decode */
  initialDecodePriority: number;
}

export type PreviewProgressCallback = (progress: PreviewProgress) => void;
export type FrameReadyCallback = (frameIndex: number, frame: CachedFrame) => void;

/**
 * Preview Generation Manager
 * 
 * Manages the preview generation workflow:
 * 1. Decode first frame immediately (instant preview)
 * 2. Start background decoding
 * 3. Progressive quality enhancement
 * 4. Cache warming
 */
export class PreviewGenerationManager {
  private config: PreviewConfig;
  private state: {
    phase: PreviewPhase;
    currentFrame: number;
    totalFrames: number;
    decodedFrames: number;
    startTime: number;
    framePaths: string[];
    settings: { maxSize: number; ocioMode: string; layerName: string };
  };
  
  // Callbacks
  private onProgress?: PreviewProgressCallback;
  private onFrameReady?: FrameReadyCallback;
  private onFirstFrameReady?: (frame: CachedFrame) => void;
  
  // Background tasks
  private backgroundTasks: Set<Promise<void>> = new Set();
  private isCancelled: boolean = false;

  constructor(config?: Partial<PreviewConfig>) {
    this.config = {
      initialMode: 'instant',
      framesForInstantPreview: 3,
      progressiveEnhancement: true,
      cacheWarming: true,
      initialDecodePriority: 0,
      ...config
    };
    
    this.state = {
      phase: 'loading',
      currentFrame: 0,
      totalFrames: 0,
      decodedFrames: 0,
      startTime: 0,
      framePaths: [],
      settings: { maxSize: 2048, ocioMode: "Linear sRGB", layerName: "" }
    };
  }

  /**
   * Start preview generation
   */
  async start(
    framePaths: string[],
    settings: { maxSize: number; ocioMode: string; layerName: string }
  ): Promise<CachedFrame | null> {
    this.isCancelled = false;
    this.state = {
      phase: 'loading',
      currentFrame: 0,
      totalFrames: framePaths.length,
      decodedFrames: 0,
      startTime: Date.now(),
      framePaths,
      settings
    };
    
    console.log(`[PreviewGen] Starting preview for ${framePaths.length} frames`);
    
    try {
      // Configure preloader
      await globalSmartPreloader.configure(framePaths, settings);
      
      // Initialize persistent cache
      await globalPersistentCache.initialize(framePaths, settings);
      
      // Start preview generation based on mode
      switch (this.config.initialMode) {
        case 'instant':
          return await this.generateInstantPreview();
        case 'draft':
          return await this.generateDraftPreview();
        case 'fast':
          return await this.generateFastPreview();
        case 'full':
          return await this.generateFullPreview();
        default:
          return await this.generateInstantPreview();
      }
    } catch (error) {
      console.error('[PreviewGen] Preview generation failed:', error);
      this.state.phase = 'error';
      this.reportProgress('Preview generation failed');
      return null;
    }
  }

  /**
   * Instant Preview: Decode first frame immediately, then background
   */
  private async generateInstantPreview(): Promise<CachedFrame | null> {
    this.state.phase = 'loading';
    this.reportProgress('Loading first frame...');
    
    // Get first frame
    const firstFrame = await globalSmartPreloader.getFrame(0, 0);
    
    if (!firstFrame) {
      console.error('[PreviewGen] Failed to decode first frame');
      return null;
    }
    
    this.state.decodedFrames = 1;
    this.state.phase = 'decoding';
    this.notifyFirstFrameReady(firstFrame);
    this.reportProgress(`First frame ready, decoding remaining...`);
    
    // Start background decoding of remaining frames
    this.startBackgroundDecoding(1);
    
    // Start cache warming
    if (this.config.cacheWarming) {
      this.startCacheWarming();
    }
    
    return firstFrame;
  }

  /**
   * Draft Preview: Decode low-res frames quickly
   */
  private async generateDraftPreview(): Promise<CachedFrame | null> {
    this.state.phase = 'loading';
    this.reportProgress('Generating draft preview...');
    
    // Get first frame at lower resolution
    const draftSettings = {
      ...this.state.settings,
      maxSize: 512 // Lower resolution for draft
    };
    
    await globalSmartPreloader.configure(this.state.framePaths, draftSettings);
    
    const firstFrame = await globalSmartPreloader.getFrame(0, 0);
    
    if (!firstFrame) {
      return null;
    }
    
    this.state.phase = 'warming';
    this.notifyFirstFrameReady(firstFrame);
    this.reportProgress('Draft preview ready, warming cache...');
    
    // Start background decoding at higher quality
    const fullSettings = {
      ...this.state.settings,
      maxSize: 2048
    };
    
    // Decode remaining frames at draft quality first
    this.startBackgroundDecoding(1, 512);
    
    return firstFrame;
  }

  /**
   * Fast Preview: Decode at reduced quality
   */
  private async generateFastPreview(): Promise<CachedFrame | null> {
    this.state.phase = 'loading';
    this.reportProgress('Generating fast preview...');
    
    // Decode at half resolution
    const fastSettings = {
      ...this.state.settings,
      maxSize: 1024
    };
    
    await globalSmartPreloader.configure(this.state.framePaths, fastSettings);
    
    const firstFrame = await globalSmartPreloader.getFrame(0, 0);
    
    if (!firstFrame) {
      return null;
    }
    
    this.state.phase = 'warming';
    this.notifyFirstFrameReady(firstFrame);
    this.reportProgress('Fast preview ready, warming cache...');
    
    // Start background decoding
    this.startBackgroundDecoding(1);
    
    return firstFrame;
  }

  /**
   * Full Preview: Wait for full quality
   */
  private async generateFullPreview(): Promise<CachedFrame | null> {
    this.state.phase = 'loading';
    this.reportProgress('Generating full quality preview...');
    
    // Decode first frame
    const firstFrame = await globalSmartPreloader.getFrame(0, 0);
    
    if (!firstFrame) {
      return null;
    }
    
    this.state.phase = 'decoding';
    this.notifyFirstFrameReady(firstFrame);
    
    // Preload remaining frames
    await globalSmartPreloader.preloadAroundCurrent(0);
    
    this.state.phase = 'warming';
    this.reportProgress('Full preview ready, warming cache...');
    
    return firstFrame;
  }

  /**
   * Start background decoding
   */
  private startBackgroundDecoding(startFrame: number, maxSize?: number): void {
    if (this.isCancelled) return;
    
    const task = this.backgroundDecode(startFrame, maxSize);
    this.backgroundTasks.add(task);
    
    task.finally(() => {
      this.backgroundTasks.delete(task);
    });
  }

  /**
   * Background decode loop
   */
  private async backgroundDecode(startFrame: number, maxSize?: number): Promise<void> {
    const batchSize = 5;
    
    for (let i = startFrame; i < this.state.totalFrames; i += batchSize) {
      if (this.isCancelled) break;
      
      const batch: Promise<void>[] = [];
      
      for (let j = i; j < Math.min(i + batchSize, this.state.totalFrames); j++) {
        if (this.isCancelled) break;
        
        batch.push(
          globalSmartPreloader.getFrame(j, FramePriority.MEDIUM).then(frame => {
            if (frame) {
              this.state.decodedFrames++;
              this.notifyFrameReady(j, frame);
            }
          }).catch(() => {})
        );
      }
      
      await Promise.all(batch);
      this.reportProgress(`Decoded ${this.state.decodedFrames}/${this.state.totalFrames} frames`);
    }
    
    this.state.phase = 'ready';
    this.reportProgress('Preview ready');
  }

  /**
   * Start cache warming
   */
  private startCacheWarming(): void {
    if (this.isCancelled || !this.config.cacheWarming) return;
    
    const task = this.cacheWarmLoop();
    this.backgroundTasks.add(task);
    
    task.finally(() => {
      this.backgroundTasks.delete(task);
    });
  }

  /**
   * Cache warming loop
   */
  private async cacheWarmLoop(): Promise<void> {
    // Warm cache in background
    for (let i = 0; i < this.state.totalFrames; i += 10) {
      if (this.isCancelled) break;
      
      await globalSmartPreloader.preloadAroundCurrent(i, FramePriority.LOW);
      this.reportProgress(`Cache warming: ${Math.round((i / this.state.totalFrames) * 100)}%`);
      
      // Small delay to not block UI
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  /**
   * Progressive quality enhancement
   */
  async enhanceProgressive(quality: QualityLevel): Promise<void> {
    if (!this.config.progressiveEnhancement) return;
    
    console.log(`[PreviewGen] Enhancing to ${quality} quality`);
    
    const currentQuality = globalAdaptiveQuality.getCurrentLevel();
    if (currentQuality === quality) return;
    
    // Update preloader settings based on quality
    const qualitySettings = this.getQualitySettings(quality);
    
    await globalSmartPreloader.configure(this.state.framePaths, {
      ...this.state.settings,
      maxSize: qualitySettings.resolutionScale * this.state.settings.maxSize
    });
    
    // Re-decode visible frames at new quality
    const startFrame = Math.max(0, this.state.currentFrame - 5);
    const endFrame = Math.min(this.state.totalFrames, this.state.currentFrame + 10);
    
    for (let i = startFrame; i < endFrame; i++) {
      if (this.isCancelled) break;
      await globalSmartPreloader.getFrame(i, 0);
    }
  }

  /**
   * Get quality settings
   */
  private getQualitySettings(quality: QualityLevel): { resolutionScale: number } {
    switch (quality) {
      case 'full':
        return { resolutionScale: 1.0 };
      case 'half':
        return { resolutionScale: 0.5 };
      case 'fast':
        return { resolutionScale: 0.5 };
      case 'draft':
        return { resolutionScale: 0.25 };
      default:
        return { resolutionScale: 1.0 };
    }
  }

  /**
   * Report progress
   */
  private reportProgress(message: string): void {
    const progress: PreviewProgress = {
      phase: this.state.phase,
      currentFrame: this.state.currentFrame,
      totalFrames: this.state.totalFrames,
      progress: this.state.totalFrames > 0 
        ? (this.state.decodedFrames / this.state.totalFrames) * 100 
        : 0,
      decodedFrames: this.state.decodedFrames,
      cachedFrames: globalPersistentCache.getCachedFrameIndices().length,
      estimatedTimeRemaining: this.estimateTimeRemaining(),
      message
    };
    
    if (this.onProgress) {
      this.onProgress(progress);
    }
  }

  /**
   * Estimate time remaining
   */
  private estimateTimeRemaining(): number {
    if (this.state.decodedFrames === 0) return -1;
    
    const elapsed = Date.now() - this.state.startTime;
    const avgTimePerFrame = elapsed / this.state.decodedFrames;
    const remainingFrames = this.state.totalFrames - this.state.decodedFrames;
    
    return Math.round(avgTimePerFrame * remainingFrames);
  }

  /**
   * Notify first frame ready
   */
  private notifyFirstFrameReady(frame: CachedFrame): void {
    if (this.onFirstFrameReady) {
      this.onFirstFrameReady(frame);
    }
    if (this.onFrameReady) {
      this.onFrameReady(0, frame);
    }
  }

  /**
   * Notify frame ready
   */
  private notifyFrameReady(frameIndex: number, frame: CachedFrame): void {
    if (this.onFrameReady) {
      this.onFrameReady(frameIndex, frame);
    }
  }

  /**
   * Cancel preview generation
   */
  cancel(): void {
    this.isCancelled = true;
    globalSmartPreloader.clearCaches();
    
    for (const task of this.backgroundTasks) {
      // Tasks will check isCancelled and stop
    }
    
    this.backgroundTasks.clear();
    this.state.phase = 'loading';
    console.log('[PreviewGen] Preview generation cancelled');
  }

  /**
   * Set progress callback
   */
  setProgressCallback(callback: PreviewProgressCallback): void {
    this.onProgress = callback;
  }

  /**
   * Set first frame ready callback
   */
  setFirstFrameReadyCallback(callback: FrameReadyCallback): void {
    this.onFirstFrameReady = callback as unknown as (frame: CachedFrame) => void;
  }

  /**
   * Set frame ready callback
   */
  setFrameReadyCallback(callback: FrameReadyCallback): void {
    this.onFrameReady = callback;
  }

  /**
   * Get current state
   */
  getState(): { phase: PreviewPhase; decodedFrames: number; totalFrames: number } {
    return {
      phase: this.state.phase,
      decodedFrames: this.state.decodedFrames,
      totalFrames: this.state.totalFrames
    };
  }

  /**
   * Get current progress
   */
  getProgress(): PreviewProgress {
    return {
      phase: this.state.phase,
      currentFrame: this.state.currentFrame,
      totalFrames: this.state.totalFrames,
      progress: this.state.totalFrames > 0 
        ? (this.state.decodedFrames / this.state.totalFrames) * 100 
        : 0,
      decodedFrames: this.state.decodedFrames,
      cachedFrames: globalPersistentCache.getCachedFrameIndices().length,
      estimatedTimeRemaining: this.estimateTimeRemaining(),
      message: this.getStatusMessage()
    };
  }

  /**
   * Get status message
   */
  private getStatusMessage(): string {
    switch (this.state.phase) {
      case 'loading':
        return 'Loading...';
      case 'decoding':
        return `Decoding frames (${this.state.decodedFrames}/${this.state.totalFrames})`;
      case 'warming':
        return 'Warming cache...';
      case 'ready':
        return 'Preview ready';
      case 'error':
        return 'Preview generation failed';
      default:
        return '';
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<PreviewConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get configuration
   */
  getConfig(): PreviewConfig {
    return { ...this.config };
  }

  /**
   * Dispose
   */
  dispose(): void {
    this.cancel();
    this.onProgress = undefined;
    this.onFrameReady = undefined;
    this.onFirstFrameReady = undefined;
  }
}

/**
 * Skip Existing Checker
 * 
 * Tracks which frames are already decoded/cached.
 * Used to skip re-decoding frames that are already ready.
 */
export class SkipExistingChecker {
  private cachedFrames: Set<number> = new Set();
  private decodedFrames: Set<number> = new Set();

  /**
   * Mark frame as cached
   */
  markCached(frameIndex: number): void {
    this.cachedFrames.add(frameIndex);
  }

  /**
   * Mark frame as decoded
   */
  markDecoded(frameIndex: number): void {
    this.decodedFrames.add(frameIndex);
  }

  /**
   * Check if frame is cached
   */
  isCached(frameIndex: number): boolean {
    return this.cachedFrames.has(frameIndex);
  }

  /**
   * Check if frame is decoded
   */
  isDecoded(frameIndex: number): boolean {
    return this.decodedFrames.has(frameIndex);
  }

  /**
   * Check if frame needs decoding
   */
  needsDecoding(frameIndex: number): boolean {
    return !this.cachedFrames.has(frameIndex) && !this.decodedFrames.has(frameIndex);
  }

  /**
   * Get frames that need decoding
   */
  getFramesToDecode(frameIndices: number[]): number[] {
    return frameIndices.filter(i => this.needsDecoding(i));
  }

  /**
   * Get cached frame count
   */
  getCachedCount(): number {
    return this.cachedFrames.size;
  }

  /**
   * Get decoded frame count
   */
  getDecodedCount(): number {
    return this.decodedFrames.size;
  }

  /**
   * Clear all
   */
  clear(): void {
    this.cachedFrames.clear();
    this.decodedFrames.clear();
  }

  /**
   * Load from cache metadata
   */
  loadFromMetadata(cachedIndices: number[]): void {
    for (const idx of cachedIndices) {
      this.cachedFrames.add(idx);
    }
  }
}

// Singleton instance
export const globalPreviewGenerator = new PreviewGenerationManager();
export const globalSkipExistingChecker = new SkipExistingChecker();
