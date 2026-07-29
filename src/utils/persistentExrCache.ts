/**
 * Persistent Disk Cache for EXR Sequences
 *
 * NOTE: This module is deprecated. EXR frame cache is RAM-only now
 * (AALab/DJV style). The exports are kept as no-op stubs to avoid breaking
 * any leftover imports during the transition. New code should use
 * `LayerCacheManager` and the global frame cache.
 */

import { invoke } from "@tauri-apps/api/core";

export interface CacheMetadata {
  version: number;
  created: number;
  modified: number;
  frameCount: number;
  settings: {
    maxSize: number;
    ocioMode: string;
    layerName: string;
  };
  frameInfo: Record<string, FrameCacheInfo>;
}

export interface FrameCacheInfo {
  index: number;
  filePath: string;
  fileSize: number;
  fileModified: number;
  cachedAt: number;
  cachedSize: number;
  width: number;
  height: number;
}

export interface CacheValidation {
  isValid: boolean;
  reason?: string;
  missingFrames?: number[];
  expiredFrames?: number[];
}

/**
 * Persistent Disk Cache Manager
 * 
 * Cache Structure:
 * %LOCALAPPDATA%/gk_exr_cache/
 *   {hash}/
 *     metadata.json      - Cache metadata and frame info
 *     frame_000000.png   - Cached frame images
 *     frame_000001.png
 *     ...
 */
export class PersistentDiskCache {
  private baseDir: string;
  private cacheDir: string | null = null;
  private metadata: CacheMetadata | null = null;
  private version: number = 1;

  constructor(baseDir?: string) {
    // Default cache directory - use %LOCALAPPDATA%
    this.baseDir = baseDir || "C:\\Users\\Mabu02\\AppData\\Local\\gk_exr_cache";
  }

  /**
   * Generate cache key from sequence info
   * Uses hash of: paths + settings
   */
  private generateCacheKey(
    framePaths: string[],
    settings: { maxSize: number; ocioMode: string; layerName: string }
  ): string {
    // Create a string combining all relevant info
    const pathInfo = framePaths.slice(0, 10).join("|"); // First 10 paths
    const totalFrames = framePaths.length;
    const settingsStr = `${settings.maxSize}|${settings.ocioMode}|${settings.layerName}`;
    
    const keyString = `${pathInfo}|${totalFrames}|${settingsStr}`;
    
    // Simple hash function (browser-compatible)
    let hash = 0;
    for (let i = 0; i < keyString.length; i++) {
      const char = keyString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    // Convert to hex-like string
    const hashStr = Math.abs(hash).toString(16).padStart(8, '0');
    const hashStr2 = Math.abs(hash >>> 16).toString(16).padStart(8, '0');
    
    return `${hashStr}${hashStr2}`;
  }

  /**
   * Get frame file path in cache
   */
  private getFramePath(frameIndex: number): string | null {
    if (!this.cacheDir) return null;
    return `${this.cacheDir}\\frame_${frameIndex.toString().padStart(6, '0')}.png`;
  }

  /**
   * Get metadata file path
   */
  private getMetadataPath(): string | null {
    if (!this.cacheDir) return null;
    return `${this.cacheDir}\\metadata.json`;
  }

  /**
   * Initialize cache for a sequence
   */
  async initialize(
    framePaths: string[],
    settings: { maxSize: number; ocioMode: string; layerName: string }
  ): Promise<CacheValidation> {
    try {
      // Generate cache key
      const cacheKey = this.generateCacheKey(framePaths, settings);
      this.cacheDir = `${this.baseDir}\\${cacheKey}`;
      
      console.log(`[PersistentCache] Initializing cache at: ${this.cacheDir}`);
      
      // Ensure cache directory exists
      await invoke("create_directory", { path: this.cacheDir });
      
      // Load or create metadata
      const metaPath = this.getMetadataPath();
      if (!metaPath) return { isValid: false, reason: "No cache directory" };
      
      try {
        const metaContent = await invoke<string>("read_text_file", { path: metaPath });
        this.metadata = JSON.parse(metaContent);
        
        // Validate existing cache
        return this.validateCache(framePaths, settings);
      } catch {
        // No existing metadata, create new
        this.metadata = {
          version: this.version,
          created: Date.now(),
          modified: Date.now(),
          frameCount: framePaths.length,
          settings: { ...settings },
          frameInfo: {}
        };
        await this.saveMetadata();
        return { isValid: true };
      }
    } catch (err) {
      console.error("[PersistentCache] Init failed:", err);
      return { isValid: false, reason: String(err) };
    }
  }

  /**
   * Validate existing cache against current files
   */
  async validateCache(
    framePaths: string[],
    settings: { maxSize: number; ocioMode: string; layerName: string }
  ): Promise<CacheValidation> {
    if (!this.metadata) {
      return { isValid: true }; // New cache
    }

    // Check settings match
    if (
      this.metadata.settings.maxSize !== settings.maxSize ||
      this.metadata.settings.ocioMode !== settings.ocioMode ||
      this.metadata.settings.layerName !== settings.layerName
    ) {
      console.log("[PersistentCache] Settings changed, invalidating cache");
      return { isValid: false, reason: "Settings changed" };
    }

    // Check frame count
    if (this.metadata.frameCount !== framePaths.length) {
      console.log("[PersistentCache] Frame count changed, invalidating cache");
      return { isValid: false, reason: "Frame count changed" };
    }

    // Check for missing or modified frames
    const missingFrames: number[] = [];
    const expiredFrames: number[] = [];
    const now = Date.now();
    const cacheAge = now - this.metadata.created;
    const maxCacheAge = 7 * 24 * 60 * 60 * 1000; // 7 days

    // Auto-expire cache older than 7 days
    if (cacheAge > maxCacheAge) {
      console.log("[PersistentCache] Cache expired (7 days), invalidating");
      return { isValid: false, reason: "Cache expired" };
    }

    // Check each frame
    for (let i = 0; i < framePaths.length; i++) {
      const frameInfo = this.metadata.frameInfo[i.toString()];
      if (!frameInfo) {
        missingFrames.push(i);
        continue;
      }

      // Check if file still exists
      const framePath = this.getFramePath(i);
      if (!framePath) {
        missingFrames.push(i);
        continue;
      }

      // Check if frame is too old (24 hours)
      const frameAge = now - frameInfo.cachedAt;
      if (frameAge > 24 * 60 * 60 * 1000) {
        expiredFrames.push(i);
      }
    }

    if (missingFrames.length > 0) {
      console.log(`[PersistentCache] ${missingFrames.length} missing frames`);
    }
    
    if (expiredFrames.length > 0) {
      console.log(`[PersistentCache] ${expiredFrames.length} expired frames`);
    }

    // Cache is valid even with missing/expired frames (they'll be re-cached)
    return { 
      isValid: true, 
      missingFrames: missingFrames.length > 0 ? missingFrames : undefined,
      expiredFrames: expiredFrames.length > 0 ? expiredFrames : undefined
    };
  }

  /**
   * Save metadata to disk
   */
  private async saveMetadata(): Promise<void> {
    if (!this.metadata || !this.cacheDir) return;

    this.metadata.modified = Date.now();
    const metaPath = this.getMetadataPath();
    if (!metaPath) return;

    try {
      await invoke("write_text_file", {
        path: metaPath,
        content: JSON.stringify(this.metadata, null, 2)
      });
    } catch (err) {
      console.error("[PersistentCache] Failed to save metadata:", err);
    }
  }

  /**
   * Update frame cache info
   */
  async updateFrameInfo(
    frameIndex: number,
    framePath: string,
    fileSize: number,
    fileModified: number,
    cachedSize: number,
    width: number,
    height: number
  ): Promise<void> {
    if (!this.metadata) return;

    this.metadata.frameInfo[frameIndex.toString()] = {
      index: frameIndex,
      filePath: framePath,
      fileSize,
      fileModified,
      cachedAt: Date.now(),
      cachedSize,
      width,
      height
    };

    await this.saveMetadata();
  }

  /**
   * Check if a frame is cached
   */
  async isFrameCached(frameIndex: number): Promise<boolean> {
    const framePath = this.getFramePath(frameIndex);
    if (!framePath) return false;

    try {
      return await invoke<boolean>("path_exists", { path: framePath });
    } catch {
      return false;
    }
  }

  /**
   * Read cached frame as base64 data URL
   * Deprecated: disk cache has been removed. Returns null.
   */
  async readCachedFrame(_frameIndex: number): Promise<string | null> {
    return null;
  }

  /**
   * Write frame to disk cache
   * Deprecated: disk cache has been removed. Returns false.
   */
  async writeCachedFrame(_frameIndex: number, _pngBase64: string, _layerName?: string): Promise<boolean> {
    return false;
  }

  /**
   * Get cache statistics
   * Deprecated: disk cache has been removed. Returns in-memory metadata only.
   */
  async getCacheStats(): Promise<{ frameCount: number; cachedFrames: number; totalSize: number; cacheAge: number } | null> {
    if (!this.metadata) return null;
    return {
      frameCount: this.metadata.frameCount,
      cachedFrames: 0,
      totalSize: 0,
      cacheAge: Date.now() - this.metadata.created
    };
  }

  /**
   * Get list of cached frame indices
   */
  getCachedFrameIndices(): number[] {
    if (!this.metadata) return [];
    
    return Object.keys(this.metadata.frameInfo)
      .map(k => parseInt(k, 10))
      .filter(i => i >= 0);
  }

  /**
   * Get missing frame indices
   */
  getMissingFrameIndices(): number[] {
    if (!this.metadata) return [];
    
    const cached = new Set(this.getCachedFrameIndices());
    const missing: number[] = [];
    
    for (let i = 0; i < this.metadata.frameCount; i++) {
      if (!cached.has(i)) {
        missing.push(i);
      }
    }
    
    return missing;
  }

  /**
   * Clear all cached frames (keep metadata)
   */
  async clearFrames(): Promise<void> {
    if (!this.cacheDir || !this.metadata) return;

    const indices = this.getCachedFrameIndices();
    for (const idx of indices) {
      const framePath = this.getFramePath(idx);
      if (framePath) {
        try {
          await invoke("delete_item", { path: framePath, mode: "permanent" });
        } catch {
          // Ignore errors
        }
      }
    }

    this.metadata.frameInfo = {};
    await this.saveMetadata();
    console.log("[PersistentCache] Cleared all cached frames");
  }

  /**
   * Clear entire cache including metadata
   */
  async clearAll(): Promise<void> {
    if (!this.cacheDir) return;

    try {
      // Delete cache directory recursively
      await invoke("delete_item", { path: this.cacheDir, mode: "permanent" });
      this.cacheDir = null;
      this.metadata = null;
      console.log("[PersistentCache] Cleared entire cache");
    } catch (err) {
      console.error("[PersistentCache] Failed to clear cache:", err);
    }
  }

  /**
   * Get cache directory path
   */
  getCacheDir(): string | null {
    return this.cacheDir;
  }

  /**
   * Check if cache is initialized
   */
  isInitialized(): boolean {
    return this.cacheDir !== null && this.metadata !== null;
  }
}

// Singleton instance
export const globalPersistentCache = new PersistentDiskCache();
