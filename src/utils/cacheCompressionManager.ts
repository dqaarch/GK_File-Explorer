/**
 * Cache Compression Manager
 * 
 * Compresses disk cache to save space.
 * Uses pako (gzip) for browser-compatible compression.
 * 
 * Compression levels:
 * - None: Store raw PNG
 * - Fast: gzip level 1 (fast but less compression)
 * - Balanced: gzip level 6 (good balance)
 * - Maximum: gzip level 9 (best compression)
 * 
 * Space savings: ~40-60% for PNG images
 */

export type CompressionLevel = 'none' | 'fast' | 'balanced' | 'maximum';

export interface CompressionStats {
  originalSize: number;
  compressedSize: number;
  savings: number;
  savingsPercent: number;
  compressionRatio: number;
}

export interface CachedFrameCompressed {
  data: Uint8Array;
  metadata: {
    width: number;
    height: number;
    originalSize: number;
    compressedSize: number;
    compressedAt: number;
  };
}

/**
 * Compression Manager for disk cache
 */
export class CacheCompressionManager {
  private level: CompressionLevel = 'balanced';
  private compressionLevel: number = 6;
  private enabled: boolean = true;
  
  // Statistics
  private totalOriginalSize: number = 0;
  private totalCompressedSize: number = 0;
  private framesCompressed: number = 0;

  constructor(level: CompressionLevel = 'balanced') {
    this.setLevel(level);
  }

  /**
   * Set compression level
   */
  setLevel(level: CompressionLevel): void {
    this.level = level;
    
    switch (level) {
      case 'none':
        this.compressionLevel = 0;
        break;
      case 'fast':
        this.compressionLevel = 1;
        break;
      case 'balanced':
        this.compressionLevel = 6;
        break;
      case 'maximum':
        this.compressionLevel = 9;
        break;
    }
    
    console.log(`[CacheCompression] Level set to ${level} (gzip level ${this.compressionLevel})`);
  }

  /**
   * Get current compression level
   */
  getLevel(): CompressionLevel {
    return this.level;
  }

  /**
   * Check if compression is enabled
   */
  isEnabled(): boolean {
    return this.enabled && this.level !== 'none';
  }

  /**
   * Enable/disable compression
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    console.log(`[CacheCompression] ${enabled ? 'Enabled' : 'Disabled'}`);
  }

  /**
   * Compress PNG data
   * Uses pako library for gzip compression
   */
  async compress(pngData: Uint8Array): Promise<Uint8Array> {
    if (!this.isEnabled()) {
      return pngData;
    }

    try {
      // Import pako dynamically
      const pako = await import('pako');
      
      // Compress using gzip
      const compressed = pako.deflate(pngData, { level: this.compressionLevel });
      
      // Update statistics
      this.totalOriginalSize += pngData.length;
      this.totalCompressedSize += compressed.length;
      this.framesCompressed++;
      
      return new Uint8Array(compressed);
    } catch (error) {
      console.error('[CacheCompression] Compression failed:', error);
      return pngData; // Fall back to uncompressed
    }
  }

  /**
   * Decompress data
   */
  async decompress(data: Uint8Array): Promise<Uint8Array> {
    if (!this.isEnabled() || data.length === 0) {
      return data;
    }

    try {
      // Import pako dynamically
      const pako = await import('pako');
      
      // Decompress using gzip
      const decompressed = pako.inflate(data);
      
      return new Uint8Array(decompressed);
    } catch (error) {
      console.error('[CacheCompression] Decompression failed:', error);
      return data; // Try to return original if decompression fails
    }
  }

  /**
   * Compress base64 string
   */
  async compressBase64(base64: string): Promise<string> {
    if (!this.isEnabled()) {
      return base64;
    }

    try {
      // Convert base64 to Uint8Array
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      // Compress
      const compressed = await this.compress(bytes);
      
      // Convert back to base64
      let result = '';
      for (let i = 0; i < compressed.length; i++) {
        result += String.fromCharCode(compressed[i]);
      }
      
      return btoa(result);
    } catch (error) {
      console.error('[CacheCompression] Base64 compression failed:', error);
      return base64;
    }
  }

  /**
   * Decompress base64 string
   */
  async decompressBase64(base64: string): Promise<string> {
    if (!this.isEnabled()) {
      return base64;
    }

    try {
      // Convert base64 to Uint8Array
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      // Decompress
      const decompressed = await this.decompress(bytes);
      
      // Convert back to base64
      let result = '';
      for (let i = 0; i < decompressed.length; i++) {
        result += String.fromCharCode(decompressed[i]);
      }
      
      return btoa(result);
    } catch (error) {
      console.error('[CacheCompression] Base64 decompression failed:', error);
      return base64;
    }
  }

  /**
   * Get compression statistics
   */
  getStats(): CompressionStats & { framesCompressed: number; level: CompressionLevel } {
    return {
      originalSize: this.totalOriginalSize,
      compressedSize: this.totalCompressedSize,
      savings: this.totalOriginalSize - this.totalCompressedSize,
      savingsPercent: this.totalOriginalSize > 0 
        ? ((this.totalOriginalSize - this.totalCompressedSize) / this.totalOriginalSize) * 100 
        : 0,
      compressionRatio: this.totalCompressedSize > 0 
        ? this.totalOriginalSize / this.totalCompressedSize 
        : 0,
      framesCompressed: this.framesCompressed,
      level: this.level
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.totalOriginalSize = 0;
    this.totalCompressedSize = 0;
    this.framesCompressed = 0;
  }

  /**
   * Estimate savings for a given size
   */
  estimateSavings(originalSize: number): number {
    // Based on typical PNG compression ratios
    const ratios: Record<CompressionLevel, number> = {
      'none': 0,
      'fast': 0.35, // ~35% savings
      'balanced': 0.45, // ~45% savings
      'maximum': 0.50 // ~50% savings
    };
    
    return originalSize * ratios[this.level];
  }

  /**
   * Get estimated compressed size
   */
  estimateCompressedSize(originalSize: number): number {
    const savings = this.estimateSavings(originalSize);
    return originalSize - savings;
  }
}

/**
 * Cache File Format
 * 
 * Handles reading/writing compressed cache files.
 * File format:
 * - Header: 4 bytes magic + 4 bytes version + 4 bytes original size + 4 bytes compressed size
 * - Data: compressed image data
 */

const CACHE_MAGIC = 0x474B4341; // 'GKCA' (Goku Cache)
const CACHE_VERSION = 1;

export interface CacheFileHeader {
  magic: number;
  version: number;
  originalSize: number;
  compressedSize: number;
  width: number;
  height: number;
}

/**
 * Cache File Operations
 */
export class CacheFileManager {
  private compression: CacheCompressionManager;
  private cacheDir: string | null = null;

  constructor(compression?: CacheCompressionManager) {
    this.compression = compression || new CacheCompressionManager();
  }

  /**
   * Set cache directory
   */
  setCacheDir(dir: string): void {
    this.cacheDir = dir;
  }

  /**
   * Get header from file data
   */
  private parseHeader(data: Uint8Array): CacheFileHeader | null {
    if (data.length < 20) return null;

    const view = new DataView(data.buffer, data.byteOffset, 20);
    const magic = view.getUint32(0, true);
    const version = view.getUint32(4, true);
    const originalSize = view.getUint32(8, true);
    const compressedSize = view.getUint32(12, true);
    const width = view.getUint32(16, true);

    if (magic !== CACHE_MAGIC) {
      console.warn('[CacheFile] Invalid magic number');
      return null;
    }

    return {
      magic,
      version,
      originalSize,
      compressedSize,
      width,
      height: 0 // Not stored in header v1
    };
  }

  /**
   * Create header bytes
   */
  private createHeader(originalSize: number, compressedSize: number, width: number): Uint8Array {
    const header = new ArrayBuffer(20);
    const view = new DataView(header);
    
    view.setUint32(0, CACHE_MAGIC, true);
    view.setUint32(4, CACHE_VERSION, true);
    view.setUint32(8, originalSize, true);
    view.setUint32(12, compressedSize, true);
    view.setUint32(16, width, true);

    return new Uint8Array(header);
  }

  /**
   * Read and decompress a cache file
   */
  async readCacheFile(frameIndex: number): Promise<{ data: Uint8Array; header: CacheFileHeader } | null> {
    if (!this.cacheDir) return null;

    try {
      // Read file via Tauri
      const { invoke } = await import('@tauri-apps/api/core');
      const base64 = await invoke<string | null>('read_file_as_base64', {
        path: `${this.cacheDir}\\frame_${frameIndex.toString().padStart(6, '0')}.gkc`
      });

      if (!base64) return null;

      // Decode base64
      const binaryString = atob(base64);
      const data = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        data[i] = binaryString.charCodeAt(i);
      }

      // Parse header
      const header = this.parseHeader(data);
      if (!header) return null;

      // Extract compressed data (skip header)
      const compressedData = data.slice(20);

      // Decompress
      const decompressed = await this.compression.decompress(compressedData);

      return { data: decompressed, header };
    } catch (error) {
      console.error(`[CacheFile] Failed to read frame ${frameIndex}:`, error);
      return null;
    }
  }

  /**
   * Compress and write a cache file
   */
  async writeCacheFile(frameIndex: number, data: Uint8Array, width: number): Promise<boolean> {
    if (!this.cacheDir) return false;

    try {
      // Compress data
      const compressed = await this.compression.compress(data);

      // Create header
      const header = this.createHeader(data.length, compressed.length, width);

      // Combine header and data
      const fileData = new Uint8Array(header.length + compressed.length);
      fileData.set(header, 0);
      fileData.set(compressed, header.length);

      // Write file via Tauri
      const { invoke } = await import('@tauri-apps/api/core');
      const base64 = this.uint8ArrayToBase64(fileData);

      await invoke('write_cached_exr_frame', {
        cacheDir: this.cacheDir,
        frameIndex,
        base64Data: base64,
        isCompressed: true
      });

      return true;
    } catch (error) {
      console.error(`[CacheFile] Failed to write frame ${frameIndex}:`, error);
      return false;
    }
  }

  /**
   * Convert Uint8Array to base64
   */
  private uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Check if compressed cache file exists
   */
  async cacheFileExists(frameIndex: number): Promise<boolean> {
    if (!this.cacheDir) return false;

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const path = `${this.cacheDir}\\frame_${frameIndex.toString().padStart(6, '0')}.gkc`;
      return await invoke<boolean>('path_exists', { path });
    } catch {
      return false;
    }
  }

  /**
   * Delete compressed cache file
   */
  async deleteCacheFile(frameIndex: number): Promise<boolean> {
    if (!this.cacheDir) return false;

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const path = `${this.cacheDir}\\frame_${frameIndex.toString().padStart(6, '0')}.gkc`;
      await invoke('delete_item', { path, mode: 'permanent' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get compression statistics
   */
  getCompressionStats(): CompressionStats {
    return this.compression.getStats();
  }

  /**
   * Set compression level
   */
  setCompressionLevel(level: CompressionLevel): void {
    this.compression.setLevel(level);
  }

  /**
   * Enable/disable compression
   */
  setCompressionEnabled(enabled: boolean): void {
    this.compression.setEnabled(enabled);
  }
}

// Singleton instance
export const globalCacheCompression = new CacheCompressionManager();
export const globalCacheFileManager = new CacheFileManager(globalCacheCompression);
