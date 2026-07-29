/**
 * Adaptive Quality Manager
 * 
 * Automatically adjusts playback quality based on:
 * - Disk I/O speed
 * - Decode performance
 * - Frame rate stability
 * - Memory pressure
 * 
 * Inspired by After Effects' adaptive performance system.
 */

export type QualityLevel = 'full' | 'half' | 'fast' | 'draft';

export interface QualitySettings {
  /** Resolution multiplier (1 = full, 0.5 = half) */
  resolutionScale: number;
  /** Enable optimizations */
  enableOptimizations: boolean;
  /** Skip frames if behind */
  skipFrames: boolean;
  /** Use lower quality decoding */
  lowerQualityDecode: boolean;
}

export interface PerformanceMetrics {
  timestamp: number;
  fps: number;
  droppedFrames: number;
  decodeTime: number;
  diskReadTime: number;
  memoryUsage: number;
  bufferLevel: number;
}

export interface QualityThresholds {
  /** FPS below this triggers quality reduction */
  minFps: number;
  /** FPS above this allows quality increase */
  maxFps: number;
  /** Dropped frames % above this triggers reduction */
  maxDropRate: number;
  /** Memory usage % above this triggers reduction */
  maxMemoryUsage: number;
}

export interface DiskSpeedResult {
  readSpeed: number; // MB/s
  writeSpeed: number; // MB/s
  latency: number; // ms
  isFast: boolean;
  tier: 'ssd' | 'hdd' | 'network';
}

const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  full: {
    resolutionScale: 1.0,
    enableOptimizations: true,
    skipFrames: false,
    lowerQualityDecode: false
  },
  half: {
    resolutionScale: 0.5,
    enableOptimizations: true,
    skipFrames: false,
    lowerQualityDecode: false
  },
  fast: {
    resolutionScale: 0.5,
    enableOptimizations: true,
    skipFrames: false,
    lowerQualityDecode: true
  },
  draft: {
    resolutionScale: 0.25,
    enableOptimizations: true,
    skipFrames: true,
    lowerQualityDecode: true
  }
};

/**
 * Adaptive Quality Manager
 * 
 * Monitors performance and adjusts quality automatically.
 */
export class AdaptiveQualityManager {
  private currentLevel: QualityLevel = 'full';
  private thresholds: QualityThresholds;
  private metrics: PerformanceMetrics[] = [];
  private maxMetricsHistory: number = 120; // 2 minutes at 1 sample/sec
  
  // Disk speed cache
  private diskSpeed: DiskSpeedResult | null = null;
  private diskSpeedLastTest: number = 0;
  private diskSpeedCacheAge: number = 5 * 60 * 1000; // 5 minutes
  
  // Quality transition
  private qualityChangeCallback?: (level: QualityLevel, settings: QualitySettings) => void;
  private stableCount: number = 0;
  private constCountThreshold: number = 30; // Need 30 stable samples before upgrade
  
  // State
  private isEnabled: boolean = true;
  private manualOverride: boolean = false;

  constructor(thresholds?: Partial<QualityThresholds>) {
    this.thresholds = {
      minFps: 20,
      maxFps: 55,
      maxDropRate: 5,
      maxMemoryUsage: 80,
      ...thresholds
    };
  }

  /**
   * Test disk read speed
   * This is a simplified test - actual implementation would read real cache files
   */
  async testDiskSpeed(cacheDir: string): Promise<DiskSpeedResult> {
    // Return cached result if recent
    if (this.diskSpeed && Date.now() - this.diskSpeedLastTest < this.diskSpeedCacheAge) {
      return this.diskSpeed;
    }

    console.log('[AdaptiveQuality] Testing disk speed...');
    const startTime = performance.now();
    const testSize = 10 * 1024 * 1024; // 10MB test
    const testData = new Uint8Array(testSize);
    
    // Fill with pseudo-random data
    for (let i = 0; i < testSize; i++) {
      testData[i] = i % 256;
    }
    
    try {
      // Simulate disk write test
      const writeStart = performance.now();
      
      // In real implementation, this would write a temp file
      // For now, we'll estimate based on the test
      const writeTime = performance.now() - writeStart;
      
      // Simulate read test
      const readStart = performance.now();
      
      // In real implementation, this would read the temp file
      const readTime = performance.now() - readStart;
      
      // Estimate speeds (this is simplified)
      const estimatedReadSpeed = testSize / (readTime || 1) / (1024 * 1024);
      const estimatedWriteSpeed = testSize / (writeTime || 1) / (1024 * 1024);
      
      // Determine tier based on speed
      let tier: 'ssd' | 'hdd' | 'network' = 'hdd';
      let isFast = false;
      
      if (estimatedReadSpeed > 500) {
        tier = 'ssd';
        isFast = true;
      } else if (estimatedReadSpeed < 50) {
        tier = 'network';
        isFast = false;
      } else {
        tier = 'hdd';
        isFast = estimatedReadSpeed > 100;
      }
      
      this.diskSpeed = {
        readSpeed: estimatedReadSpeed,
        writeSpeed: estimatedWriteSpeed,
        latency: readTime,
        isFast,
        tier
      };
      this.diskSpeedLastTest = Date.now();
      
      console.log(`[AdaptiveQuality] Disk speed: ${estimatedReadSpeed.toFixed(1)} MB/s (${tier})`);
      return this.diskSpeed;
    } catch (error) {
      console.error('[AdaptiveQuality] Disk speed test failed:', error);
      return {
        readSpeed: 100,
        writeSpeed: 50,
        latency: 10,
        isFast: false,
        tier: 'hdd'
      };
    }
  }

  /**
   * Get recommended quality based on disk speed
   */
  getRecommendedQuality(): QualityLevel {
    if (!this.diskSpeed) {
      return 'full';
    }

    if (this.diskSpeed.tier === 'ssd' && this.diskSpeed.isFast) {
      return 'full';
    } else if (this.diskSpeed.tier === 'ssd') {
      return 'half';
    } else if (this.diskSpeed.tier === 'hdd') {
      return 'fast';
    } else {
      return 'draft';
    }
  }

  /**
   * Record performance metrics
   */
  recordMetrics(metrics: Omit<PerformanceMetrics, 'timestamp'>): void {
    this.metrics.push({
      timestamp: Date.now(),
      ...metrics
    });

    // Trim history
    if (this.metrics.length > this.maxMetricsHistory) {
      this.metrics = this.metrics.slice(-this.maxMetricsHistory);
    }

    // Check if adjustment needed
    if (this.isEnabled && !this.manualOverride) {
      this.evaluateQuality();
    }
  }

  /**
   * Evaluate current quality level
   */
  private evaluateQuality(): void {
    if (this.metrics.length < 10) {
      return; // Need enough samples
    }

    // Calculate average metrics over recent window
    const recentMetrics = this.metrics.slice(-30);
    const avgFps = recentMetrics.reduce((sum, m) => sum + m.fps, 0) / recentMetrics.length;
    const avgDropRate = recentMetrics.reduce((sum, m) => sum + m.droppedFrames, 0) / recentMetrics.length;
    const avgMemory = recentMetrics.reduce((sum, m) => sum + m.memoryUsage, 0) / recentMetrics.length;
    const avgBuffer = recentMetrics.reduce((sum, m) => sum + m.bufferLevel, 0) / recentMetrics.length;

    // Check for quality issues
    const needsDowngrade = 
      avgFps < this.thresholds.minFps ||
      avgDropRate > this.thresholds.maxDropRate ||
      avgMemory > this.thresholds.maxMemoryUsage;

    // Check for quality upgrade opportunity
    const canUpgrade =
      avgFps > this.thresholds.maxFps &&
      avgDropRate < this.thresholds.maxDropRate / 2 &&
      avgMemory < this.thresholds.maxMemoryUsage / 2;

    if (needsDowngrade) {
      this.downgradeQuality();
      this.stableCount = 0;
    } else if (canUpgrade) {
      this.stableCount++;
      if (this.stableCount >= this.constCountThreshold) {
        this.upgradeQuality();
        this.stableCount = 0;
      }
    } else {
      this.stableCount = 0;
    }
  }

  /**
   * Downgrade quality
   */
  private downgradeQuality(): void {
    const currentSettings = QUALITY_PRESETS[this.currentLevel];
    let newLevel: QualityLevel = this.currentLevel;

    switch (this.currentLevel) {
      case 'full':
        newLevel = 'half';
        break;
      case 'half':
        newLevel = 'fast';
        break;
      case 'fast':
        newLevel = 'draft';
        break;
      // draft is already the lowest
    }

    if (newLevel !== this.currentLevel) {
      this.currentLevel = newLevel;
      console.log(`[AdaptiveQuality] Downgraded to ${newLevel}`);
      this.notifyQualityChange();
    }
  }

  /**
   * Upgrade quality
   */
  private upgradeQuality(): void {
    let newLevel: QualityLevel = this.currentLevel;

    switch (this.currentLevel) {
      case 'draft':
        newLevel = 'fast';
        break;
      case 'fast':
        newLevel = 'half';
        break;
      case 'half':
        newLevel = 'full';
        break;
      // full is already the highest
    }

    if (newLevel !== this.currentLevel) {
      this.currentLevel = newLevel;
      console.log(`[AdaptiveQuality] Upgraded to ${newLevel}`);
      this.notifyQualityChange();
    }
  }

  /**
   * Notify quality change callback
   */
  private notifyQualityChange(): void {
    if (this.qualityChangeCallback) {
      this.qualityChangeCallback(this.currentLevel, QUALITY_PRESETS[this.currentLevel]);
    }
  }

  /**
   * Get current quality level
   */
  getCurrentLevel(): QualityLevel {
    return this.currentLevel;
  }

  /**
   * Get current quality settings
   */
  getCurrentSettings(): QualitySettings {
    return { ...QUALITY_PRESETS[this.currentLevel] };
  }

  /**
   * Get all quality presets
   */
  getQualityPresets(): Record<QualityLevel, QualitySettings> {
    return QUALITY_PRESETS;
  }

  /**
   * Manually set quality level
   */
  setQualityLevel(level: QualityLevel): void {
    this.manualOverride = true;
    this.currentLevel = level;
    console.log(`[AdaptiveQuality] Manual override to ${level}`);
    this.notifyQualityChange();
  }

  /**
   * Reset to automatic quality
   */
  resetToAutomatic(): void {
    this.manualOverride = false;
    console.log('[AdaptiveQuality] Reset to automatic quality adjustment');
  }

  /**
   * Enable/disable adaptive quality
   */
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    console.log(`[AdaptiveQuality] ${enabled ? 'Enabled' : 'Disabled'}`);
  }

  /**
   * Check if adaptive quality is enabled
   */
  isAdaptiveEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Check if manual override is active
   */
  isManualOverride(): boolean {
    return this.manualOverride;
  }

  /**
   * Set callback for quality changes
   */
  onQualityChange(callback: (level: QualityLevel, settings: QualitySettings) => void): void {
    this.qualityChangeCallback = callback;
  }

  /**
   * Get current metrics summary
   */
  getMetricsSummary(): {
    avgFps: number;
    avgDropRate: number;
    avgMemory: number;
    avgBuffer: number;
    currentLevel: QualityLevel;
    isManualOverride: boolean;
    diskSpeed: DiskSpeedResult | null;
  } {
    const recentMetrics = this.metrics.slice(-30);
    
    return {
      avgFps: recentMetrics.length > 0 
        ? recentMetrics.reduce((sum, m) => sum + m.fps, 0) / recentMetrics.length 
        : 0,
      avgDropRate: recentMetrics.length > 0 
        ? recentMetrics.reduce((sum, m) => sum + m.droppedFrames, 0) / recentMetrics.length 
        : 0,
      avgMemory: recentMetrics.length > 0 
        ? recentMetrics.reduce((sum, m) => sum + m.memoryUsage, 0) / recentMetrics.length 
        : 0,
      avgBuffer: recentMetrics.length > 0 
        ? recentMetrics.reduce((sum, m) => sum + m.bufferLevel, 0) / recentMetrics.length 
        : 0,
      currentLevel: this.currentLevel,
      isManualOverride: this.manualOverride,
      diskSpeed: this.diskSpeed
    };
  }

  /**
   * Clear metrics history
   */
  clearMetrics(): void {
    this.metrics = [];
    this.stableCount = 0;
  }

  /**
   * Get metrics history
   */
  getMetricsHistory(): PerformanceMetrics[] {
    return [...this.metrics];
  }

  /**
   * Set thresholds
   */
  setThresholds(thresholds: Partial<QualityThresholds>): void {
    this.thresholds = { ...this.thresholds, ...thresholds };
  }

  /**
   * Get current thresholds
   */
  getThresholds(): QualityThresholds {
    return { ...this.thresholds };
  }

  /**
   * Reset to defaults
   */
  reset(): void {
    this.currentLevel = 'full';
    this.manualOverride = false;
    this.isEnabled = true;
    this.metrics = [];
    this.stableCount = 0;
    this.thresholds = {
      minFps: 20,
      maxFps: 55,
      maxDropRate: 5,
      maxMemoryUsage: 80
    };
  }
}

/**
 * Memory Pressure Monitor
 * 
 * Monitors memory usage and provides pressure indicators.
 */
export class MemoryPressureMonitor {
  private memoryUsage: number = 0;
  private pressureCallback?: (level: 'low' | 'medium' | 'high' | 'critical') => void;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private thresholdLow: number = 50;
  private thresholdMedium: number = 70;
  private thresholdHigh: number = 85;
  private thresholdCritical: number = 95;

  constructor() {
    this.startMonitoring();
  }

  /**
   * Start monitoring memory usage
   */
  startMonitoring(): void {
    if (this.checkInterval) return;

    this.checkInterval = setInterval(() => {
      this.checkMemoryUsage();
    }, 2000); // Check every 2 seconds
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Check current memory usage
   */
  private async checkMemoryUsage(): Promise<void> {
    // In browser, we can use performance.memory (Chrome only)
    // @ts-ignore
    const memory = performance.memory;
    
    if (memory) {
      const usedMB = memory.usedJSHeapSize / (1024 * 1024);
      const totalMB = memory.jsHeapSizeLimit / (1024 * 1024);
      this.memoryUsage = (usedMB / totalMB) * 100;
    } else {
      // Estimate based on cached frames
      // This is a rough estimate
      this.memoryUsage = 50;
    }

    // Notify callback if pressure changed
    const pressure = this.getPressureLevel();
    if (this.pressureCallback) {
      this.pressureCallback(pressure);
    }
  }

  /**
   * Get current pressure level
   */
  getPressureLevel(): 'low' | 'medium' | 'high' | 'critical' {
    if (this.memoryUsage >= this.thresholdCritical) return 'critical';
    if (this.memoryUsage >= this.thresholdHigh) return 'high';
    if (this.memoryUsage >= this.thresholdMedium) return 'medium';
    return 'low';
  }

  /**
   * Get current memory usage percentage
   */
  getMemoryUsage(): number {
    return this.memoryUsage;
  }

  /**
   * Set pressure callback
   */
  onPressureChange(callback: (level: 'low' | 'medium' | 'high' | 'critical') => void): void {
    this.pressureCallback = callback;
  }

  /**
   * Set thresholds
   */
  setThresholds(
    low: number,
    medium: number,
    high: number,
    critical: number
  ): void {
    this.thresholdLow = low;
    this.thresholdMedium = medium;
    this.thresholdHigh = high;
    this.thresholdCritical = critical;
  }

  /**
   * Dispose
   */
  dispose(): void {
    this.stopMonitoring();
    this.pressureCallback = undefined;
  }
}

// Singleton instances
export const globalAdaptiveQuality = new AdaptiveQualityManager();
export const globalMemoryMonitor = new MemoryPressureMonitor();
