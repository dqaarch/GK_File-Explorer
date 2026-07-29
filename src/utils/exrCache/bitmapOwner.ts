/**
 * Bitmap lifecycle helpers — cache owns the bitmaps.
 *
 * The previous design had a single-owner "dispose on swap" hook (`swapAndDisposePending`)
 * that closed the previously displayed bitmap when React scheduled a new bitmap.
 * That approach was correct for **GPU-pipeline-owned** bitmaps (i.e. when
 * `pipeline.decodeFrameToBitmap()` returned a fresh `ImageBitmap` every call and
 * the React layer had to dispose the previous one to avoid GPU leaks), but
 * it's broken now that the **layer cache** owns bitmaps: when the cache returns
 * the same `cached.bitmap` reference back for a cache HIT, that bitmap may have
 * already been closed by the swap — `drawImage` then throws
 * `InvalidStateError: The image source is detached`.
 *
 * Concretely: scrub timeline → cache hits old frame → bitmap was closed when
 * the new frame was displayed → frame goes black + `drawImage failed` log.
 *
 * The fix is to stop closing bitmaps here. The cache (`ImageBitmapCache`) is
 * now the sole owner and disposes on LRU eviction / `clearAll`. Bitmaps that
 * are *not yet* in the cache (i.e. decode-produced bitmaps that the cache call
 * already handed back inside the LRU-managed entry) are alive for as long as
 * the cache holds them, and are explicitly closed by `disposeOnlyIfUncached`
 * (called from React layer for decode results that the cache missed-then-store
 * but the user navigated away from before LRU evict).
 *
 * This module stays as a no-op shim so existing imports keep compiling and
 * future-proof for the day we want explicit close-on-unmount.
 */

let pendingClose: ImageBitmap | null = null;
let pendingCloseUncachedOnly = true;

/**
 * Dispose the bitmap that's pending close (from a previous `swapAndDispose`).
 * Safe to call multiple times — clears the slot after disposing.
 *
 * **DEPRECATED behaviour**: this is now a no-op. The cache owns bitmaps and
 * closes them on LRU eviction. Calling this on a cache-owned bitmap would
 * invalidate future cache HIT returns for the same frame.
 */
export function disposePendingBitmap(): void {
  // The cache is the sole owner of these bitmaps. Don't close them here —
  // doing so would make subsequent cache HITs return a detached bitmap and
  // trigger `InvalidStateError: The image source is detached` on
  // `ctx.drawImage`.
  pendingClose = null;
}

/**
 * Replace the pending bitmap and dispose the previous one.
 *
 * **DEPRECATED behaviour**: this is now effectively a no-op for the bitmap
 * itself; we still record `newBitmap` so future debugger tooling can see what
 * was last installed. The cache owns the bitmap and is responsible for close.
 *
 * Call from the React display effect right after `drawImage(newBitmap, 0, 0)`.
 * Previously this closed the previous bitmap synchronously — that broke
 * cache HIT returns once the user scrubbed back to a frame that had already
 * been evicted from "currently displayed" but was still in the cache.
 */
export function swapAndDisposePending(newBitmap: ImageBitmap | null): void {
  pendingClose = newBitmap;
}

/**
 * Dispose any currently-pending bitmap without installing a new one.
 *
 * Same no-op rationale as `disposePendingBitmap`: the cache is the bitmap
 * owner. We do clear the slot here so future debugging reads `null`.
 */
export function disposeAllPending(): void {
  pendingClose = null;
}

/** Test/debug only: peek at the current pending bitmap without disposing it. */
export function _peekPending(): ImageBitmap | null {
  return pendingClose;
}