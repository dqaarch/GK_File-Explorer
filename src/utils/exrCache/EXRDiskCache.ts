/**
 * EXR Disk Cache - Persistent Cache on Disk
 * 
 * Features:
 * - Persists decoded frames across app restarts
 * - Cache key includes layer name, frame index, ocio mode, and max size
 * - Automatic pruning of old entries
 * - Memory-mapped style access for fast reads
 * 
 * Note: This is optional - the main memory cache works without disk cache.
 * Disk cache is for cross-session persistence.
 */

export interface DiskCacheEntry {
  layerName: string;
  frameIndex: number;
  ocioMode: string;
  maxSize: number;
  pngPath: string;
  channels: string[];
  createdAt: number;
  fileSize: number;
}

interface CacheMetadata {
  version: number;
  entries: Record<string, DiskCacheEntry>;
  createdAt: number;
}

class EXRDiskCache {
  private cacheDir: string = '';
  private metadataPath: string = '';
  private initialized: boolean = false;
  private metadata: CacheMetadata | null = null;
  
  // Config
  private maxAgeDays: number = 7; // Keep cache for 7 days
  private maxCacheSizeMB: number = 10240; // 10GB max

  // Initialize the disk cache
  async initialize(subDir: string = 'exr_cache'): Promise<void> {
    if (this.initialized) return;
    
    // For now, just mark as initialized
    // Full disk cache implementation requires Tauri fs plugin
    this.initialized = true;
  }

  // Check if frame is in disk cache
  async has(_layerName: string, _frameIndex: number, 
            _ocioMode: string, _maxSize: number): Promise<boolean> {
    // Placeholder - requires Tauri fs plugin
    return false;
  }

  // Read PNG data from disk cache
  async read(_layerName: string, _frameIndex: number,
             _ocioMode: string, _maxSize: number): Promise<{ pngBase64: string; entry: DiskCacheEntry } | null> {
    // Placeholder - requires Tauri fs plugin
    return null;
  }

  // Write PNG data to disk cache
  async write(_layerName: string, _frameIndex: number,
              _ocioMode: string, _maxSize: number,
              _pngBase64: string,
              _channels: string[]): Promise<boolean> {
    // Placeholder - requires Tauri fs plugin
    return false;
  }

  // Prune old entries
  async prune(): Promise<number> {
    return 0;
  }

  // Get cache statistics
  async getStats(): Promise<{
    entries: number;
    totalSizeMB: number;
    oldestEntry: number | null;
    newestEntry: number | null;
    byLayer: Record<string, number>;
  }> {
    return { 
      entries: 0, 
      totalSizeMB: 0, 
      oldestEntry: null, 
      newestEntry: null, 
      byLayer: {} 
    };
  }

  // Clear all disk cache
  async clearAll(): Promise<void> {
  }

  // Clear cache for specific layer
  async clearLayer(_layerName: string): Promise<number> {
    return 0;
  }
}

// Global singleton instance
export const exrDiskCache = new EXRDiskCache();

// Also export class
export { EXRDiskCache };
