/**
 * Decode Worker Pool
 * 
 * Manages concurrent decode requests to Rust backend.
 * Since actual decoding happens in Rust (tokio threads),
 * this manages the frontend-side concurrency and request batching.
 * 
 * Features:
 * - Concurrent request limiting
 * - Request batching for efficiency
 * - Priority-based scheduling
 * - Request cancellation
 */

export interface DecodeRequest {
  id: string;
  frameIndex: number;
  framePath: string;
  priority: number;
  createdAt: number;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cancelled: boolean;
}

export interface WorkerPoolConfig {
  /** Maximum concurrent requests */
  maxConcurrent: number;
  /** Batch size for grouping requests */
  batchSize: number;
  /** Batch timeout (ms) - wait this long before processing a batch */
  batchTimeout: number;
  /** Enable request coalescing (duplicate requests merged) */
  coalesceRequests: boolean;
}

interface Batch {
  requests: DecodeRequest[];
  timeout: ReturnType<typeof setTimeout> | null;
  createdAt: number;
}

/**
 * Decode Worker Pool
 * 
 * Manages concurrent decode requests with:
 * - Concurrency limiting
 * - Request batching
 * - Priority scheduling
 * - Request coalescing
 */
export class DecodeWorkerPool {
  private config: WorkerPoolConfig;
  private activeRequests: Map<string, DecodeRequest> = new Map();
  private pendingQueue: DecodeRequest[] = [];
  private batches: Map<number, Batch> = new Map(); // Keyed by frameIndex range
  private requestIdCounter: number = 0;

  constructor(config?: Partial<WorkerPoolConfig>) {
    this.config = {
      maxConcurrent: 3,
      batchSize: 5,
      batchTimeout: 50, // 50ms batching window
      coalesceRequests: true,
      ...config
    };
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `decode_${Date.now()}_${++this.requestIdCounter}`;
  }

  /**
   * Submit a decode request
   */
  submit(
    frameIndex: number,
    framePath: string,
    priority: number = 0,
    executor: (frameIndex: number, framePath: string) => Promise<unknown>
  ): Promise<unknown> {
    // Check for existing request (coalescing)
    if (this.config.coalesceRequests) {
      const existing = this.findExistingRequest(frameIndex);
      if (existing) {
        console.log(`[WorkerPool] Coalescing request for frame ${frameIndex}`);
        return existing.promise;
      }
    }

    return new Promise((resolve, reject) => {
      const request: DecodeRequest = {
        id: this.generateRequestId(),
        frameIndex,
        framePath,
        priority,
        createdAt: Date.now(),
        promise: Promise.resolve(), // Placeholder
        resolve: resolve as (value: unknown) => void,
        reject,
        cancelled: false
      };

      // Create actual promise
      request.promise = new Promise((res, rej) => {
        request.resolve = res as (value: unknown) => void;
        request.reject = rej as (error: Error) => void;
      });

      this.pendingQueue.push(request);
      this.pendingQueue.sort((a, b) => {
        // Sort by priority (lower = higher priority)
        if (a.priority !== b.priority) {
          return a.priority - b.priority;
        }
        // Then by age (older first)
        return a.createdAt - b.createdAt;
      });

      console.log(`[WorkerPool] Submitted request for frame ${frameIndex} (priority=${priority}, queue=${this.pendingQueue.length})`);

      this.processQueue(executor);
    });
  }

  /**
   * Find existing request for same frame
   */
  private findExistingRequest(frameIndex: number): DecodeRequest | null {
    // Check pending queue
    for (const req of this.pendingQueue) {
      if (req.frameIndex === frameIndex && !req.cancelled) {
        return req;
      }
    }

    // Check active requests
    for (const req of this.activeRequests.values()) {
      if (req.frameIndex === frameIndex && !req.cancelled) {
        return req;
      }
    }

    return null;
  }

  /**
   * Process pending queue
   */
  private async processQueue(
    executor: (frameIndex: number, framePath: string) => Promise<unknown>
  ): Promise<void> {
    // Check if we can start new requests
    if (this.activeRequests.size >= this.config.maxConcurrent) {
      return; // Wait for active requests to complete
    }

    // Get next request
    const request = this.pendingQueue.shift();
    if (!request) {
      return; // No pending requests
    }

    if (request.cancelled) {
      // Skip cancelled requests
      this.processQueue(executor);
      return;
    }

    // Start request
    this.activeRequests.set(request.id, request);
    this.executeRequest(request, executor);
  }

  /**
   * Execute a single request
   */
  private async executeRequest(
    request: DecodeRequest,
    executor: (frameIndex: number, framePath: string) => Promise<unknown>
  ): Promise<void> {
    try {
      console.log(`[WorkerPool] Executing frame ${request.frameIndex} (active=${this.activeRequests.size})`);

      const result = await executor(request.frameIndex, request.framePath);

      if (!request.cancelled) {
        request.resolve(result);
      }
    } catch (error) {
      if (!request.cancelled) {
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.activeRequests.delete(request.id);

      // Process next request
      this.processQueue(executor);
    }
  }

  /**
   * Submit multiple requests as a batch
   */
  submitBatch(
    requests: Array<{ frameIndex: number; framePath: string; priority?: number }>,
    executor: (frameIndex: number, framePath: string) => Promise<unknown>
  ): Promise<unknown[]> {
    return Promise.all(
      requests.map(({ frameIndex, framePath, priority = 0 }) =>
        this.submit(frameIndex, framePath, priority, executor)
      )
    );
  }

  /**
   * Cancel a specific request
   */
  cancel(frameIndex: number): boolean {
    // Check pending queue
    for (let i = 0; i < this.pendingQueue.length; i++) {
      const req = this.pendingQueue[i];
      if (req.frameIndex === frameIndex) {
        req.cancelled = true;
        req.reject(new Error('Cancelled'));
        this.pendingQueue.splice(i, 1);
        console.log(`[WorkerPool] Cancelled pending request for frame ${frameIndex}`);
        return true;
      }
    }

    // Cannot cancel active requests (they're already executing)
    return false;
  }

  /**
   * Cancel all pending requests
   */
  cancelAll(): void {
    for (const req of this.pendingQueue) {
      req.cancelled = true;
      req.reject(new Error('Cancelled'));
    }
    this.pendingQueue = [];
    console.log('[WorkerPool] Cancelled all pending requests');
  }

  /**
   * Cancel requests outside a frame range
   */
  cancelOutsideRange(minFrame: number, maxFrame: number): void {
    for (const req of this.pendingQueue) {
      if (req.frameIndex < minFrame || req.frameIndex > maxFrame) {
        req.cancelled = true;
        req.reject(new Error('Cancelled'));
      }
    }
    this.pendingQueue = this.pendingQueue.filter(req => !req.cancelled);
  }

  /**
   * Get pool status
   */
  getStatus(): {
    activeCount: number;
    pendingCount: number;
    maxConcurrent: number;
    utilization: number;
  } {
    return {
      activeCount: this.activeRequests.size,
      pendingCount: this.pendingQueue.length,
      maxConcurrent: this.config.maxConcurrent,
      utilization: (this.activeRequests.size / this.config.maxConcurrent) * 100
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<WorkerPoolConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Set max concurrent requests
   */
  setMaxConcurrent(max: number): void {
    this.config.maxConcurrent = Math.max(1, Math.min(max, 10));
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.cancelAll();
    this.activeRequests.clear();
    this.batches.forEach(batch => {
      if (batch.timeout) clearTimeout(batch.timeout);
    });
    this.batches.clear();
  }

  /**
   * Dispose
   */
  dispose(): void {
    this.clear();
  }
}

/**
 * Request Deduplicator
 * 
 * Prevents duplicate decode requests for the same frame.
 * Useful when multiple components request the same frame.
 */
export class RequestDeduplicator {
  private pending: Map<number, Promise<unknown>> = new Map();
  private results: Map<number, { result: unknown; timestamp: number }> = new Map();
  private maxCacheAge: number = 5 * 60 * 1000; // 5 minutes

  /**
   * Get or create a request for a frame
   */
  async getOrCreate(
    frameIndex: number,
    factory: () => Promise<unknown>
  ): Promise<unknown> {
    // Check if we have a pending request
    const pending = this.pending.get(frameIndex);
    if (pending) {
      return pending;
    }

    // Check if we have a cached result
    const cached = this.results.get(frameIndex);
    if (cached && Date.now() - cached.timestamp < this.maxCacheAge) {
      return cached.result;
    }

    // Create new request
    const promise = factory();
    this.pending.set(frameIndex, promise);

    try {
      const result = await promise;
      this.results.set(frameIndex, { result, timestamp: Date.now() });
      return result;
    } finally {
      this.pending.delete(frameIndex);
    }
  }

  /**
   * Check if a frame is being loaded
   */
  isLoading(frameIndex: number): boolean {
    return this.pending.has(frameIndex);
  }

  /**
   * Check if a frame is cached
   */
  isCached(frameIndex: number): boolean {
    const cached = this.results.get(frameIndex);
    if (!cached) return false;
    return Date.now() - cached.timestamp < this.maxCacheAge;
  }

  /**
   * Clear cached results
   */
  clearCache(): void {
    this.results.clear();
  }

  /**
   * Clear pending requests
   */
  clearPending(): void {
    this.pending.clear();
  }

  /**
   * Clear all
   */
  clear(): void {
    this.clearCache();
    this.clearPending();
  }
}

// Singleton instances
export const globalDecodeWorkerPool = new DecodeWorkerPool({
  maxConcurrent: 3,
  batchSize: 5,
  batchTimeout: 50
});

export const globalRequestDeduplicator = new RequestDeduplicator();
