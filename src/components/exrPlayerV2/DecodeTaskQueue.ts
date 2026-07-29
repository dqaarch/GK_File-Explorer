/**
 * EXRPlayer V2 — DecodeTaskQueue
 * 
 * Single decode path replacing the 3 concurrent paths from the old architecture.
 * Uses priority queue to handle: critical (user request), high (preload), low (background).
 * 
 * Key insight: Reuses existing LayerCacheManager for Rust IPC but adds single-flight
 * coordination to prevent duplicate decodes.
 */

import { layerCacheManager } from "../../utils/exrCache";
import { dbg } from "../../utils/debug";

export type TaskPriority = "critical" | "high" | "low";

export interface DecodeTask {
  frameIndex: number;
  framePath: string;
  priority: TaskPriority;
  generation: number;
  controller: AbortController;
}

interface PendingTask {
  task: DecodeTask;
  promise: Promise<ImageBitmap | null>;
  resolve: (v: ImageBitmap | null) => void;
}

export class DecodeTaskQueue {
  private queue: PendingTask[] = [];
  private runningTask: PendingTask | null = null;
  private pendingByFrame = new Map<number, PendingTask>();
  private completedFrames = new Set<number>();
  private generation = 0;
  private isProcessing = false;

  private priorityRank(p: TaskPriority): number {
    switch (p) {
      case "critical": return 0;
      case "high": return 1;
      case "low": return 2;
    }
  }

  enqueue(task: Omit<DecodeTask, "generation" | "controller"> & { controller?: AbortController }): Promise<ImageBitmap | null> {
    const controller = task.controller ?? new AbortController();
    const fullTask: DecodeTask = { ...task, generation: this.generation, controller };

    const existing = this.pendingByFrame.get(task.frameIndex);
    if (existing) {
      if (this.priorityRank(task.priority) < this.priorityRank(existing.task.priority)) {
        existing.task.controller.abort();
        this.removeTask(existing);
      } else {
        return existing.promise;
      }
    }

    let resolveCallback: (v: ImageBitmap | null) => void;
    const promise = new Promise<ImageBitmap | null>((resolve) => {
      resolveCallback = resolve;
    });

    const pending: PendingTask = {
      task: fullTask,
      promise: promise,
      resolve: resolveCallback!,
    };

    const insertIndex = this.queue.findIndex(
      (pt) => this.priorityRank(pt.task.priority) > this.priorityRank(task.priority)
    );

    if (insertIndex === -1) {
      this.queue.push(pending);
    } else {
      this.queue.splice(insertIndex, 0, pending);
    }

    this.pendingByFrame.set(task.frameIndex, pending);
    this.processQueue();

    return promise;
  }

  private removeTask(pending: PendingTask): void {
    const idx = this.queue.indexOf(pending);
    if (idx !== -1) this.queue.splice(idx, 1);
    this.pendingByFrame.delete(pending.task.frameIndex);
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    if (this.runningTask) return;
    if (this.queue.length === 0) return;

    const pending = this.queue.shift()!;
    this.runningTask = pending;
    this.pendingByFrame.delete(pending.task.frameIndex);
    this.isProcessing = true;

    try {
      const result = await layerCacheManager.loadFrameWithBitmap(pending.task.frameIndex);
      if (pending.task.controller.signal.aborted) {
        pending.resolve(null);
        return;
      }
      if (result && result.generation === this.generation) {
        this.completedFrames.add(pending.task.frameIndex);
        pending.resolve(result.bitmap);
      } else {
        pending.resolve(null);
      }
    } catch (err) {
      dbg.log(`[DecodeTaskQueue] Error decoding frame ${pending.task.frameIndex}:`, err);
      pending.resolve(null);
    } finally {
      this.runningTask = null;
      this.isProcessing = false;
      this.processQueue();
    }
  }

  bumpGeneration(): void {
    this.generation++;
    if (this.runningTask && this.runningTask.task.generation !== this.generation) {
      this.runningTask.task.controller.abort();
    }
    for (const pending of this.queue) {
      if (pending.task.generation !== this.generation) {
        pending.task.controller.abort();
        this.removeTask(pending);
      }
    }
  }

  clear(): void {
    for (const pending of this.queue) {
      pending.task.controller.abort();
    }
    this.runningTask?.task.controller.abort();
    this.queue = [];
    this.runningTask = null;
    this.pendingByFrame.clear();
    this.completedFrames.clear();
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  isRunning(): boolean {
    return this.runningTask !== null;
  }

  getCompletedFrames(): number {
    return this.completedFrames.size;
  }
}

export const decodeTaskQueue = new DecodeTaskQueue();