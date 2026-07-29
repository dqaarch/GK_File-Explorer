/**
 * Ring Buffer RAM Cache for EXR Frames
 * 
 * AE-style memory cache with:
 * - Ring buffer with fixed capacity
 * - Priority-based eviction (frames near current position are kept longer)
 * - LRU eviction for frames far from current position
 * - O(1) access time
 * 
 * Unlike Map-based cache, this prioritizes:
 * 1. Current frame (highest priority)
 * 2. Frames near current frame (forward and backward)
 * 3. Frames being preloaded for playback
 */

export interface CachedFrame {
  imageDataUrl: string;
  channels: string[];
  method: string;
  decodedAt: number;
  frameIndex: number;
  framePath: string;
  accessCount: number;
  lastAccessed: number;
}

export interface FrameAccessInfo {
  frameIndex: number;
  distance: number;
  lastAccessed: number;
}

/**
 * Ring Buffer RAM Cache
 * 
 * Maintains a fixed-size cache that prioritizes frames near the current position.
 * When full, evicts frames that are farthest from current position.
 */
export class RingBufferRAMCache {
  private buffer: Map<number, CachedFrame>;
  private capacity: number;
  private currentPosition: number = 0;
  private maxDistance: number;
  
  // Statistics
  private hits: number = 0;
  private misses: number = 0;
  private evictions: number = 0;

  constructor(capacity: number = 30) {
    this.capacity = capacity;
    this.buffer = new Map();
    // Max distance to consider for priority (frames beyond this are lowest priority)
    this.maxDistance = Math.max(capacity * 2, 100);
  }

  /**
   * Set current playback position
   * Frames near this position have higher priority to stay in cache
   */
  setCurrentPosition(position: number): void {
    this.currentPosition = position;
  }

  /**
   * Get a frame from cache
   */
  get(frameIndex: number): CachedFrame | null {
    const frame = this.buffer.get(frameIndex);
    
    if (frame) {
      // Update access info
      frame.accessCount++;
      frame.lastAccessed = Date.now();
      this.hits++;
      return frame;
    }
    
    this.misses++;
    return null;
  }

  /**
   * Get multiple frames at once (for batch operations)
   */
  getMany(frameIndices: number[]): Map<number, CachedFrame> {
    const result = new Map<number, CachedFrame>();
    
    for (const idx of frameIndices) {
      const frame = this.get(idx);
      if (frame) {
        result.set(idx, frame);
      }
    }
    
    return result;
  }

  /**
   * Check if a frame is in cache (without updating access info)
   */
  has(frameIndex: number): boolean {
    return this.buffer.has(frameIndex);
  }

  /**
   * Add a frame to cache
   * If cache is full, evict frames far from current position
   */
  set(frameIndex: number, frame: CachedFrame): void {
    // If already exists, just update
    if (this.buffer.has(frameIndex)) {
      frame.accessCount = this.buffer.get(frameIndex)!.accessCount;
      frame.lastAccessed = Date.now();
      this.buffer.set(frameIndex, frame);
      return;
    }

    // Evict if necessary
    if (this.buffer.size >= this.capacity) {
      this.evictLru();
    }

    // Add to cache
    frame.accessCount = 1;
    frame.lastAccessed = Date.now();
    this.buffer.set(frameIndex, frame);
  }

  /**
   * Add multiple frames at once
   */
  setMany(frames: Array<{ index: number; frame: CachedFrame }>): void {
    // Sort by priority (closer to current position first)
    frames.sort((a, b) => {
      const distA = Math.abs(a.index - this.currentPosition);
      const distB = Math.abs(b.index - this.currentPosition);
      return distA - distB;
    });

    for (const { index, frame } of frames) {
      this.set(index, frame);
    }
  }

  /**
   * Evict the least recently used frame that's far from current position
   */
  private evictLru(): void {
    if (this.buffer.size === 0) return;

    let victimIndex: number | null = null;
    let lowestPriority = Infinity;

    for (const [idx, frame] of this.buffer) {
      const distance = Math.abs(idx - this.currentPosition);
      
      // Calculate priority score
      // Lower score = more likely to be evicted
      // Consider: distance, last accessed, access count
      const distanceScore = distance / this.maxDistance;
      const ageScore = (Date.now() - frame.lastAccessed) / (5 * 60 * 1000); // Normalize to 5 minutes
      const accessScore = 1 / (frame.accessCount + 1);
      
      const priority = distanceScore * 0.5 + ageScore * 0.3 + accessScore * 0.2;
      
      if (priority < lowestPriority) {
        lowestPriority = priority;
        victimIndex = idx;
      }
    }

    if (victimIndex !== null) {
      this.buffer.delete(victimIndex);
      this.evictions++;
      console.log(`[RingBuffer] Evicted frame ${victimIndex} (priority: ${lowestPriority.toFixed(3)})`);
    }
  }

  /**
   * Evict frames far from current position to make room
   * Called before adding a batch of frames for a different position
   */
  evictFarFrames(minDistance: number): number {
    let evicted = 0;
    const toEvict: number[] = [];

    for (const idx of this.buffer.keys()) {
      const distance = Math.abs(idx - this.currentPosition);
      if (distance >= minDistance) {
        toEvict.push(idx);
      }
    }

    // Sort by distance (evict farthest first)
    toEvict.sort((a, b) => {
      return Math.abs(b - this.currentPosition) - Math.abs(a - this.currentPosition);
    });

    // Evict as many as needed
    while (this.buffer.size + evicted > this.capacity && toEvict.length > 0) {
      const idx = toEvict.shift()!;
      if (this.buffer.delete(idx)) {
        evicted++;
        this.evictions++;
      }
    }

    if (evicted > 0) {
      console.log(`[RingBuffer] Evicted ${evicted} far frames to make room`);
    }

    return evicted;
  }

  /**
   * Get frames near current position (for preloading)
   */
  getNearbyFrames(range: number = 10): number[] {
    const result: number[] = [];
    const halfRange = Math.floor(range / 2);

    for (let i = -halfRange; i <= halfRange; i++) {
      const idx = this.currentPosition + i;
      if (this.buffer.has(idx)) {
        result.push(idx);
      }
    }

    return result;
  }

  /**
   * Get all cached frame indices
   */
  getCachedIndices(): number[] {
    return Array.from(this.buffer.keys()).sort((a, b) => a - b);
  }

  /**
   * Get count of cached frames
   */
  get size(): number {
    return this.buffer.size;
  }

  /**
   * Get statistics
   */
  getStats(): {
    size: number;
    capacity: number;
    hits: number;
    misses: number;
    hitRate: number;
    evictions: number;
  } {
    const total = this.hits + this.misses;
    return {
      size: this.buffer.size,
      capacity: this.capacity,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? (this.hits / total) * 100 : 0,
      evictions: this.evictions
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * Clear all frames
   */
  clear(): void {
    this.buffer.clear();
    console.log('[RingBuffer] Cache cleared');
  }

  /**
   * Update capacity
   */
  setCapacity(newCapacity: number): void {
    this.capacity = newCapacity;
    
    // Evict if over capacity
    while (this.buffer.size > this.capacity) {
      this.evictLru();
    }
  }

  /**
   * Get memory estimate (approximate)
   */
  getMemoryEstimate(): number {
    let totalBytes = 0;
    
    for (const frame of this.buffer.values()) {
      // Estimate: base64 string is ~33% larger than binary
      const base64Size = frame.imageDataUrl.length * (4 / 3);
      // Plus overhead for other properties
      totalBytes += base64Size + 500; // ~500 bytes overhead per frame
    }
    
    return totalBytes;
  }
}

/**
 * Priority Queue for frame decoding
 * Ensures frames are decoded in the correct priority order
 */
export enum FramePriority {
  CRITICAL = 0,   // Current frame being displayed
  HIGH = 1,       // Next frame in playback direction
  MEDIUM = 2,     // Frames for smooth playback
  LOW = 3,        // Background preloading
}

export interface DecodeTask {
  frameIndex: number;
  priority: FramePriority;
  createdAt: number;
  promise: Promise<unknown>;
}

export class PriorityDecodeQueue {
  private queue: DecodeTask[] = [];
  private processing: Set<number> = new Set();
  private maxConcurrent: number;
  private completed: Set<number> = new Set();

  constructor(maxConcurrent: number = 2) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Add a frame to the decode queue
   */
  enqueue(frameIndex: number, priority: FramePriority, promise: Promise<unknown>): void {
    // Skip if already completed or in queue
    if (this.completed.has(frameIndex) || this.isQueued(frameIndex)) {
      return;
    }

    const task: DecodeTask = {
      frameIndex,
      priority,
      createdAt: Date.now(),
      promise
    };

    this.queue.push(task);
    this.sortByPriority();
  }

  /**
   * Sort queue by priority (highest priority first)
   */
  private sortByPriority(): void {
    this.queue.sort((a, b) => {
      // First by priority
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      // Then by age (older first)
      return a.createdAt - b.createdAt;
    });
  }

  /**
   * Check if a frame is in queue
   */
  isQueued(frameIndex: number): boolean {
    return this.queue.some(t => t.frameIndex === frameIndex);
  }

  /**
   * Check if a frame is being processed
   */
  isProcessing(frameIndex: number): boolean {
    return this.processing.has(frameIndex);
  }

  /**
   * Check if a frame is completed
   */
  isCompleted(frameIndex: number): boolean {
    return this.completed.has(frameIndex);
  }

  /**
   * Get next task to process
   */
  peek(): DecodeTask | null {
    return this.queue[0] || null;
  }

  /**
   * Dequeue next task
   */
  dequeue(): DecodeTask | null {
    const task = this.queue.shift();
    if (task) {
      this.processing.add(task.frameIndex);
    }
    return task || null;
  }

  /**
   * Mark a frame as completed
   */
  complete(frameIndex: number): void {
    this.processing.delete(frameIndex);
    this.completed.add(frameIndex);
    
    // Remove from queue if still there
    this.queue = this.queue.filter(t => t.frameIndex !== frameIndex);
  }

  /**
   * Mark a frame as failed
   */
  fail(frameIndex: number): void {
    this.processing.delete(frameIndex);
    // Remove from queue if still there
    this.queue = this.queue.filter(t => t.frameIndex !== frameIndex);
  }

  /**
   * Get queue size
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Get processing count
   */
  get processingCount(): number {
    return this.processing.size;
  }

  /**
   * Can start new task?
   */
  canStartNew(): boolean {
    return this.processing.size < this.maxConcurrent;
  }

  /**
   * Clear all tasks
   */
  clear(): void {
    this.queue = [];
    this.processing.clear();
    // Don't clear completed - those frames are already decoded
  }

  /**
   * Clear completed set
   */
  clearCompleted(): void {
    this.completed.clear();
  }

  /**
   * Get queue info
   */
  getInfo(): {
    queueSize: number;
    processingCount: number;
    completedCount: number;
    pendingByPriority: Record<FramePriority, number>;
  } {
    const pendingByPriority: Record<FramePriority, number> = {
      [FramePriority.CRITICAL]: 0,
      [FramePriority.HIGH]: 0,
      [FramePriority.MEDIUM]: 0,
      [FramePriority.LOW]: 0
    };

    for (const task of this.queue) {
      pendingByPriority[task.priority]++;
    }

    return {
      queueSize: this.queue.length,
      processingCount: this.processing.size,
      completedCount: this.completed.size,
      pendingByPriority
    };
  }
}
