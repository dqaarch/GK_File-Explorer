/**
 * EXR Cache Utilities - Index
 *
 * New layer-aware cache system (AALab/DJV style - RAM only)
 */

// Global Frame Cache (AALab-style, unlimited memory).
// Cache stores only PNG data URLs; ImageBitmap lifecycle is owned by
// the React display effect via ./bitmapOwner (see PLAN_BITMAP_PER_DISPLAY.md).
export type { FrameEntry, LayerSettings } from './GlobalEXRFrameCache';
export { GlobalEXRFrameCache, globalFrameCache } from './GlobalEXRFrameCache';

// Bitmap lifecycle helpers (single-owner model).
export {
  swapAndDisposePending,
  disposePendingBitmap,
  disposeAllPending,
} from './bitmapOwner';

// Layer Cache Manager (per-layer cache management)
export type {
  LayerState,
  ChannelFrameResult,
  FrameBitmapResult,
} from './LayerCacheManager';
export { LayerCacheManager, layerCacheManager } from './LayerCacheManager';

// ImageBitmap Cache (Phase 7: replaces PNG-based GlobalEXRFrameCache for frame data)
export type { BitmapCacheEntry } from './ImageBitmapCache';
export { ImageBitmapCache, imageBitmapCache } from './ImageBitmapCache';

// Raw Linear Cache (Phase 7-revisit 2026-07-05): pre-LUT, pre-OETF raw pixel
// buffers. Used by LayerCacheManager to re-render an already-decoded frame
// when the user switches OCIO mode, avoiding a full Rust FFI re-decode.
// See PLAN_PHASE7_OCIO_RERENDER.md for the full design rationale.
export type { RawLinearEntry } from './RawLinearCache';
export { RawLinearCache, rawLinearCache } from './RawLinearCache';

// EXR Disk Cache stub kept for compatibility (no-op since we are RAM-only now)
export type { DiskCacheEntry } from './EXRDiskCache';
export { EXRDiskCache, exrDiskCache } from './EXRDiskCache';

// GPU-side OCIO LUT renderer (Phase 1-3 of the GPU plan). See
// PLAN_GPU_EXR_RENDERER.md for the full pipeline description.
export {
  EXRGpuRenderer,
  canUseGpu,
} from './EXRGpuRenderer';
export { EXRCpuLutRenderer } from './EXRCpuLutRenderer';
export { EXRWorkerLutRenderer } from './EXRWorkerLutRenderer';
export {
  createLutRenderer,
} from './createLutRenderer';
export type {
  RendererHandle,
  RendererKind,
  RendererInit,
  AnyLutRenderer,
} from './createLutRenderer';

// High-level pipeline that ties decode + LUT + render together. Used by
// EXRSequencePlayer when the GPU path is enabled.
export { ExrGpuPipeline } from './exrGpuPipeline';
export type {
  GpuFrameResult,
  PipelineOptions,
} from './exrGpuPipeline';
