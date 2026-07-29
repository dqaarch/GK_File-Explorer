/**
 * Layer Cache Manager - Manages per-layer cache state and loading
 *
 * Phase 9-restructured (2026-07-05): Simplified 2-step pipeline
 * ----------------------------------------------------------
 *   Step 1 (background, always-on when a layer is active):
 *     FFI decode F16 (Rust `decode_exr_f16`) → RawLinearCache
 *     Driven by `kickContinuousRawLinearWarm()` with its own AbortController
 *     that aborts on (a) `stopAllLoops()` (Details Pane unmount), or
 *     (b) sequence-id change detected at the top of the warm loop.
 *     OCIO mode alone does NOT abort the warm — RawLinearCache is
 *     OCIO-agnostic, so we keep filling it across OCIO switches.
 *
 *   Step 2 (on-demand, on scrub or OCIO switch):
 *     RawLinearCache.get(frame) → reRenderWithLut → ImageBitmapCache
 *     If RawLinearCache misses for a Beauty frame: warm-then-render
 *     (1 IPC, ~600ms) instead of the legacy FFI fallback.
 *     Non-Beauty layers (Crypto, Emitters, Output AOV, etc.) keep the
 *     legacy `decodeFrameToBitmap` fallback because they may use
 *     custom OCIO configs we don't have a registered warm path for.
 *
 * Lessons from Phase 7-revisit / Phase 9 iterations:
 *   1. Fire-and-forget warmup using the batch's AbortController dies
 *      when `configure()` switches OCIO mode. Always use a dedicated
 *      warmAbortController for the RawLinearCache warmer.
 *   2. Don't run the U8 batch (`decodeBatchToBitmaps`) for non-passthrough
 *      modes — the bitmaps would be colour-incorrect and thrown away.
 *      Skip the Rust roundtrip entirely; let `kickContinuousRawLinearWarm`
 *      do the work in the background.
 *   3. Preserve RawLinearCache across OCIO switches (Raw → ACES, etc.).
 *      Only invalidate on layer/fingerprint change.
 *   4. Beauty layer detection is case-insensitive and includes the
 *      legacy empty-layer name (some EXR files don't prefix "Beauty.").
 *      See `isBeautyLayerName` below.
 */

import { imageBitmapCache, type BitmapCacheEntry } from './ImageBitmapCache';
import { rawLinearCache, type RawLinearEntry } from './RawLinearCache';
import { globalFrameCache } from './GlobalEXRFrameCache';
import { OCIO_MODE_SLUGS } from '../../TauriFileSystem';
import { dbg } from '../debug';
import { dataUrlToImageBitmap } from './dataUrlToBitmap';

/** Human-readable label kept for backwards compatibility */
export const CUSTOM_OCIO_HUMAN_LABEL = "Custom OCIO Config";

/**
 * Phase 9-restructured: detect whether a layer name refers to the
 * Beauty pass. Case-insensitive; treats empty/undefined as "Beauty"
 * because some legacy EXR files don't prefix channel names with
 * "Beauty." (channels sit at the top level as just "R", "G", "B", "A").
 *
 * This controls the warm-then-render fast path in `_loadAndCacheBitmap`:
 * Beauty uses RawLinearCache + reRenderWithLut exclusively; other
 * layers (Crypto, Emitters, Output AOV, Denoised beauty, ...) keep
 * the legacy FFI fallback because they may have custom OCIO configs.
 */
export function isBeautyLayerName(layerName: string | null | undefined): boolean {
  if (!layerName) return true; // empty / null / undefined → legacy "default layer" = Beauty
  const norm = layerName.trim().toLowerCase();
  if (norm === "") return true;
  return norm === "beauty";
}
import { ExrGpuPipeline } from './exrGpuPipeline';
import { getExrCacheSettings } from '../../stores/exrCacheSettings';

export interface LayerState {
  layerName: string;
  framePaths: string[];
  ocioMode: string;
  customFingerprint: string;
  channelMode: string;
  maxSize: number;
}

/** Channel frame result (uses PNG for now) */
export interface ChannelFrameResult {
  success: boolean;
  imageDataUrl: string;
  channels: string[];
  width: number;
  height: number;
}

/**
 * Bitmap decode result with generation tracking.
 */
export interface FrameBitmapResult {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  channels: string[];
  /** Snapshot of the cache manager generation */
  generation: number;
}

class LayerCacheManager {
  // Current active layer state
  private activeLayer: LayerState | null = null;

  // All configured layers
  private configuredLayers = new Map<string, LayerState>();

  // Active loading promises for deduplication (bitmap path)
  private loadingPromises = new Map<string, Promise<FrameBitmapResult | null>>();

  /**
   * Monotonically increasing generation counter. Bumped on file/layer/OCIO switch
   * so in-flight work is detected as stale.
   */
  private generation = 0;
  public getGeneration(): number {
    return this.generation;
  }
  public bumpGeneration(): number {
    return ++this.generation;
  }

  // Background preload state
  private preloadAbortController: AbortController | null = null;

  /**
   * Read the latest `pass_type` string reported by the GPU pipeline
   * (mirrors what `exrGpuPipeline.detectPassType` decided). UI uses
   * this to gate OCIO config picks — e.g. force a "raw" pick when
   * the file is HDR / HDRI so applying ACES doesn't double-tone-map
   * an already-scene-linear buffer.
   */
  getLastDetectedPassType(): string | null {
    return this.getGpuPipeline().getLastPassType?.() ?? null;
  }
  /**
   * Clear the cached pass_type in the GPU pipeline so the UI HDR
   * guard stops returning a stale signal from the previous file.
   * Called from `configure()` when the file path / layer changes.
   */
  invalidateLastDetectedPassType(): void {
    this.getGpuPipeline().invalidateLastPassType?.();
  }

  /**
   * Phase 5B: AbortController shared by every decode started under the
   * current `configure()` context. Whenever the user switches layer /
   * OCIO mode / custom fingerprint, we abort this controller so the
   * slow Rust decode + GPU upload + ImageBitmap conversion bails out
   * at the next await point instead of running to completion just to be
   * dropped by the generation-mismatch check. A new controller is
   * created on the next `configure()` so subsequent decodes still work.
   */
  private decodeAbortController: AbortController = new AbortController();

  // Continuous background loader
  private continuousLoaderRunning: boolean = false;
  private continuousAbortController: AbortController | null = null;
  private continuousCursors = new Map<string, number>();
  private pendingCursorSave: number | null = null;

  // Phase NAV-1 (2026-07-05): fingerprint of the EXR sequence that
  // owns the active continuous load. Captured at the start of every
  // batch iteration; if it no longer matches `currentSequenceId` we
  // break out of the loop. This is the JS-side mirror of "the user
  // navigated away" — the Rust batch already in flight will finish on
  // its own (we don't cancel Rust mid-batch), but no further batches
  // are submitted for the abandoned sequence.
  private currentSequenceId: string = "";

  // Shared GPU pipeline
  private gpuPipeline: ExrGpuPipeline | null = null;

  /** Returns true if GPU acceleration is enabled */
  private shouldUseGpu(): boolean {
    const mode = getExrCacheSettings().gpuAcceleration;
    return mode === "auto" || mode === "force-gpu";
  }

  /** Get or lazily create the singleton GPU pipeline */
  private getGpuPipeline(): ExrGpuPipeline {
    if (!this.gpuPipeline) {
      const settings = getExrCacheSettings();
      this.gpuPipeline = new ExrGpuPipeline({
        preference: settings.gpuAcceleration === "force-gpu" ? "gpu" : "auto",
      });
    }
    return this.gpuPipeline;
  }

  /** Dispose GPU pipeline (for tests/hot-reload) */
  disposeGpuPipeline(): void {
    this.gpuPipeline?.dispose();
    this.gpuPipeline = null;
  }

  // ---- Phase 10 (2026-07-13): Single-flight claim set ----
  // Three concurrent decode paths share the same `framePath` space
  // (`startContinuousLoad`, `kickContinuousRawLinearWarm`,
  // `preloadAhead`) but check *different* cache predicates — so the
  // same file can be submitted twice (once for the U8 batch into
  // `imageBitmapCache`, once for the F16 warm into
  // `rawLinearCache`). The Rust side already parallelises within a
  // batch via `rayon::par_iter()`, so the cheap win is upstream:
  // stop re-submitting work that's already on the wire.
  //
  // `Set<string>` keyed by the raw framePath. Single-thread JS
  // makes `add()` atomic in practice, so `tryClaimFrame` doubles as
  // the lock. The set is cleared inside `clearCache()` (where
  // `generation` is bumped anyway); the claim survives a missing
  // cache HIT because we release in `finally` of every submit path.
  //
  // Phase 10.1 (2026-07-13, post-ship hotfix): prioritised claim.
  // Initial implementation was symmetric — every path called
  // `tryClaimFrame` and the loser yielded. Real-world log showed
  // this is wrong: `_loadAndCacheBitmap` (sync, 1 frame, ~2.8s)
  // claims frame 0 the instant the user opens a sequence; the U8
  // batch (16 frames, ~1.8s for all 16) then skips frame 0 and the
  // first 4–6 frames behind it, producing a visible "decode starts
  // from frame 7" lag. The fix: the U8 batch and warm loop use
  // `tryClaimFramePriority` (steals the claim by force-releasing
  // the loser) because they decode in batches the user actually
  // sees; sync single-frame load uses the gentler
  // `tryClaimFrame` (returns false on conflict).
  //
  // See `docs/EXR-CACHE-PERFORMANCE-PLAN.md` §3 Phase 1 and
  // `docs/EXR-CACHE-LESSONS-LEARNED.md` §11 for the rationale.
  private readonly inFlightFramePaths = new Set<string>();

  /**
   * Try to claim a framePath for in-flight decode. Returns
   * `true` if this caller is now responsible for decoding the
   * frame, `false` if another path already claimed it (in which
   * case the other path is **left untouched** — the loser just
   * gives up).
   *
   * Use this for "polite" callers (single-frame sync loads from
   * `preloadAhead`, ad-hoc `displayFrame` requests) that can
   * safely yield to a concurrent batch decode.
   *
   * Callers MUST pair this with `releaseFrame` in a `finally`
   * block — otherwise the cache becomes a leak that prevents the
   * same frame from ever being re-decoded after a transient
   * failure.
   */
  tryClaimFrame(framePath: string): boolean {
    if (!framePath) return false;
    if (this.inFlightFramePaths.has(framePath)) {
      dbg.log(`[LayerCache-DBG] skip in-flight path=${framePath}`);
      return false;
    }
    this.inFlightFramePaths.add(framePath);
    return true;
  }

  /**
   * Priority claim. Returns `true` if this caller now owns the
   * decode. If another path already claimed the frame, this
   * method:
   *   1. Logs the steal at `[LayerCache-DBG] steal claim path=...`.
   *   2. **Removes the prior claim** (force-release) so the new
   *      owner can take over.
   *   3. Returns `true` so the new owner proceeds.
   *
   * Use this for "aggressive" callers — the U8 batch loop and
   * the RawLinear warm loop — which decode in batches the user
   * is actively watching. A polite sync loader that already
   * claimed frame 0 will silently lose its claim when the U8
   * batch kicks in; the sync loader's `finally` block still
   * releases (idempotent `Set.delete`) and the batch's decode
   * runs to completion.
   */
  tryClaimFramePriority(framePath: string): boolean {
    if (!framePath) return false;
    if (this.inFlightFramePaths.has(framePath)) {
      dbg.log(
        `[LayerCache-DBG] steal claim path=${framePath} (priority claim overrides prior owner)`,
      );
      // Force-release the prior owner's claim. The prior owner's
      // `finally` will run later and call `releaseFrame` again,
      // which is a no-op on a missing key.
      this.inFlightFramePaths.delete(framePath);
    }
    this.inFlightFramePaths.add(framePath);
    return true;
  }

  /** Release a previously-claimed framePath. Safe to call twice. */
  releaseFrame(framePath: string): void {
    if (!framePath) return;
    this.inFlightFramePaths.delete(framePath);
  }

  /** Read-only size accessor for debug overlays / tests. */
  get inFlightFrameCount(): number {
    return this.inFlightFramePaths.size;
  }

  // ---- Cache management ----

  clearCache(): void {
    // Clear ImageBitmap cache
    imageBitmapCache.clearAll();

    // Clear loading promises
    this.loadingPromises.clear();

    // Reset cursor
    if (this.activeLayer) {
      const key = `${this.activeLayer.layerName}__${this.activeLayer.ocioMode}`;
      this.continuousCursors.delete(key);
    }
    this.pendingCursorSave = null;

    // Abort preload
    if (this.preloadAbortController) {
      this.preloadAbortController.abort();
      this.preloadAbortController = null;
    }

    // Phase 5B: abort every in-flight decode so the Rust FFI + GPU
    // upload + ImageBitmap conversion stops at the next await point
    // instead of running to completion and being dropped by the
    // generation-mismatch check (which wasted ~1700ms per frame in
    // the Beauty → Denoised beauty switch the user reported).
    this.decodeAbortController.abort();
    this.decodeAbortController = new AbortController();

    // Drop the shared GPU pipeline + its WebGL textures + LUT (ACES) so
    // a duplicate-frame bug (same path, swapped content; or two EXR files
    // sharing GPU pipeline state) doesn't keep replaying the previous
    // file's OCIO output. The pipeline is recreated lazily on the next
    // frame via `getOrInitGpuPipeline()`.
    this.disposeGpuPipeline();

    // Drop the LRU frame cache keyed by (layer, OCIO mode, frameIndex).
    // `globalFrameCache` is independent of `LayerCacheManager`'s own
    // ImageBitmap/RawLinear caches, so it must be cleared explicitly to
    // fully reset the in-memory EXR state.
    globalFrameCache.clearAll();

    // Phase 10 (2026-07-13): drop the single-flight claim set so
    // any new decode after `clearCache()` doesn't see stale
    // in-flight markers from the abandoned context.
    this.inFlightFramePaths.clear();

    this.bumpGeneration();
    dbg.log('[LayerCache] Cache cleared');
  }

  configure(layerName: string, framePaths: string[], ocioMode: string, maxSize: number, channelMode: string = "RGB", customFingerprint: string = ""): void {
    if (!layerName || !framePaths || framePaths.length === 0) {
      console.warn(`[LayerCache] configure() skipped: invalid inputs (layerName='${layerName}', framePaths.length=${framePaths?.length ?? 0})`);
      return;
    }

    const cur = this.activeLayer;
    if (
      cur &&
      cur.layerName === layerName &&
      cur.ocioMode === ocioMode &&
      cur.customFingerprint === customFingerprint &&
      cur.channelMode === channelMode &&
      cur.maxSize === maxSize &&
      cur.framePaths.length === framePaths.length &&
      cur.framePaths[0] === framePaths[0] &&
      cur.framePaths[cur.framePaths.length - 1] === framePaths[framePaths.length - 1]
    ) {
      // No change — keep `lastPassType` as-is so consumers (timeline
      // labelling, debug logs) don't see a stale signal from a previous
      // file.
      this.currentSequenceId = framePaths.join("|");
      return; // No change
    }

    // Phase 5B: if any dimension that would invalidate in-flight decodes
    // has changed (layer, OCIO mode, custom fingerprint, frame set),
    // abort every decode currently running under the OLD context so the
    // expensive Rust decode + GPU upload + ImageBitmap conversion stops
    // at its next await point. We still let generation-mismatch act as
    // a safety net for anything the abort can't catch (e.g. decode
    // already finished but the result hasn't been written to the cache).
    const layerChanged = !cur || cur.layerName !== layerName;
    const ocioChanged = !cur || cur.ocioMode !== ocioMode;
    const fpChanged = !cur || cur.customFingerprint !== customFingerprint;
    const framesChanged =
      !cur ||
      cur.framePaths.length !== framePaths.length ||
      cur.framePaths[0] !== framePaths[0] ||
      cur.framePaths[cur.framePaths.length - 1] !==
        framePaths[framePaths.length - 1];
    const contextChanged = layerChanged || ocioChanged || fpChanged || framesChanged;
    if (contextChanged) {
      const reason = [
        layerChanged && `layer(${cur?.layerName}→${layerName})`,
        ocioChanged && `ocio(${cur?.ocioMode}→${ocioMode})`,
        fpChanged && `fingerprint`,
        framesChanged && `frames`,
      ]
        .filter(Boolean)
        .join(",");
      dbg.log(
        `[LayerCache] configure context changed (${reason}); aborting in-flight decodes`,
      );
      this.decodeAbortController.abort();
      this.decodeAbortController = new AbortController();

      // Drop the cached `pass_type` signal from the previous file whenever
      // the frame set OR layer changes — keeps `lastPassType` accurate
      // for the current selection.
      if (framesChanged || layerChanged) {
        this.invalidateLastDetectedPassType();
      }

      // Phase 7-revisit (2026-07-05): split the flush policy.
      //
      //   - `layerChanged` or `fpChanged` invalidates EVERY cached entry
      //     because the raw pixel buffer itself is different (different
      //     channels / different OCIO config / different shader). Both
      //     ImageBitmapCache AND RawLinearCache must drop their entries.
      //
      //   - `ocioChanged` ONLY invalidates ImageBitmapCache entries
      //     under the OLD OCIO mode. The raw pixel buffer is colour-
      //     agnostic, so RawLinearCache must KEEP its entries. The new
      //     OCIO mode will re-render from raw via `reRenderWithLut()`,
      //     which is ~30-80ms vs the 4-7s of a full Rust FFI re-decode.
      //
      //   - `framesChanged` (sequence grew/shrank at the tail) only
      //     invalidates entries for frames no longer in the set. We
      //     skip the flush entirely and let stale entries age out via
      //     LRU.
      if (layerChanged || fpChanged) {
        // 2026-07-13 NAV-3 follow-up: previously this called
        // `imageBitmapCache.clearAll()` which wiped every other file's
        // bitmaps too — defeating the "open file A → navigate to B →
        // reopen A instantly" warm-resume behaviour the unmount hook
        // above was designed for. Scope the flush to the OLD
        // fingerprint so entries for other previously-opened files
        // survive. RawLinearCache is already scoped via
        // `invalidateByFingerprint` directly below.
        if (cur) {
          imageBitmapCache.clearByFingerprint(cur.customFingerprint);
        } else {
          // No previous active layer → caller is doing a cold
          // configure. Fall back to the wholesale flush so we don't
          // leak a stale warm-loader's bitmaps from before mount.
          imageBitmapCache.clearAll();
        }
        this.loadingPromises.clear();
        // 2026-07-13: REMOVED `rawLinearCache.invalidateByFingerprint(customFingerprint)`.
        //
        // The function signature is `invalidateByFingerprint(keep: string)` —
        // it KEEPS entries whose `customFingerprint === keep` and evicts
        // everything else. Called with `customFingerprint` (the NEW file's
        // fp), this evicted the OLD file's raw linear entries too, defeating
        // the warm-resume path in `_loadAndCacheBitmapBody`:
        //   - User opens Duy → RawLinearCache fills with Duy.fp entries
        //   - User clicks Rnd → configure() called with Rnd.fp
        //   - `invalidateByFingerprint(Rnd.fp)` → Duy entries evicted (they
        //     don't match Rnd.fp)
        //   - User clicks back to Duy → RawLinearCache.has(Duy.fp, ...) MISS
        //   - Fast `decodeRawLinearToBitmapDirect` path skipped → falls through
        //     to 2.9s FFI decode
        //
        // RawLinearCache entries are tagged with the file's fp in the key
        // (`getKey()` includes fp), so a stale Duy entry can NEVER be
        // returned for a Rnd lookup. The LRU budget naturally caps memory
        // growth; no explicit eviction is needed when switching files.
        //
        // Phase 7-revisit (2026-07-05, fourth arm): the warmer's
        // signal is intentionally tied to layer/fingerprint — not
        // OCIO — so the OCIO switch keeps the warm cache. But a
        // layer/fingerprint change invalidates the raw pixel buffer
        // itself, so the warmer must die here.
        if (this.warmAbortController) {
          this.warmAbortController.abort();
          this.warmAbortController = null;
          this.warmRunning = false;
        }
        dbg.log(
          `[LayerCache] flushed ImageBitmapCache (scoped to fp="${(cur?.customFingerprint ?? "").slice(0, 30)}${(cur?.customFingerprint?.length ?? 0) > 30 ? "…" : ""}") + aborted RawLinear warmer; RawLinearCache entries from other files PRESERVED for warm-resume`,
        );
      } else if (ocioChanged) {
        imageBitmapCache.clearAll();
        this.loadingPromises.clear();
        // RawLinearCache intentionally preserved: the raw pixel buffer
        // is the same, so the next decode in the new OCIO mode can use
        // `reRenderWithLut()` instead of re-running the FFI decode.
        dbg.log(
          `[LayerCache] flushed ImageBitmapCache only (OCIO-only change; RawLinearCache preserved)`,
        );
      }
    }

    const state: LayerState = {
      layerName,
      framePaths,
      ocioMode,
      customFingerprint,
      channelMode,
      maxSize
    };

    this.activeLayer = state;
    this.configuredLayers.set(layerName, state);
    this.bumpGeneration();

    // Phase NAV-1: capture the sequence fingerprint so the batch loop
    // can detect "this sequence was abandoned" if the user navigates
    // away. Uses `framePaths.join("|")` to be order-sensitive — same
    // paths in a different order means a different sequence to the
    // batch loop.
    this.currentSequenceId = framePaths.join("|");

    dbg.log(`[LayerCache] Configured: layer="${layerName}", mode="${ocioMode}", maxSize=${maxSize}, frames=${framePaths.length}`);
  }

  // ---- Frame loading (ImageBitmap only) ----

  /**
   * Check if frame is loaded (in ImageBitmap cache)
   */
  isFrameLoaded(frameIndex: number, channelMode?: string): boolean {
    if (!this.activeLayer) return false;
    const effectiveChannel = channelMode || this.activeLayer.channelMode || "RGB";
    return imageBitmapCache.has(
      this.activeLayer.layerName,
      this.activeLayer.ocioMode,
      effectiveChannel,
      frameIndex,
      this.activeLayer.customFingerprint,
      this.getFramePath(frameIndex)
    );
  }

  /**
   * Get cached frame (deprecated - use isFrameLoaded + loadFrameWithBitmap)
   */
  getFrame(frameIndex: number, _channelMode?: string): null {
    // DEPRECATED: Return null, callers should use isFrameLoaded() + loadFrameWithBitmap()
    return null;
  }

  getFramePath(frameIndex: number): string | undefined {
    if (!this.activeLayer) return undefined;
    if (frameIndex >= 0 && frameIndex < this.activeLayer.framePaths.length) {
      return this.activeLayer.framePaths[frameIndex];
    }
    return undefined;
  }

  getTotalFrames(): number {
    return this.activeLayer?.framePaths.length || 0;
  }

  getActiveLayerName(): string {
    return this.activeLayer?.layerName || '';
  }

  getActiveLayerState(): LayerState | null {
    return this.activeLayer;
  }

  getActiveOcioMode(): string {
    return this.activeLayer?.ocioMode || '';
  }

  // ---- DEPRECATED: Load frame (PNG path removed in Phase 7) ----

  /** @deprecated Use loadFrameWithBitmap() instead */
  async loadFrame(frameIndex: number, _channelMode?: string): Promise<null> {
    // Phase 7: PNG path removed. Use loadFrameWithBitmap() for rendering.
    console.warn('[LayerCache] loadFrame() is deprecated, use loadFrameWithBitmap()');
    return null;
  }

  /**
   * Load channel frame (R, G, B, A, Y) - STILL USES PNG for individual channels
   * This is acceptable because channel frames are rarely used.
   *
   * 2026-07-05: forwards `maxSize` (matching `decode_exr_f32`) so the
   * returned PNG matches the player's active preview-quality budget
   * instead of always being native-resolution. Pass `undefined` to
   * keep the legacy "no resize" behavior for back-compat callers.
   */
  async loadChannelFrame(frameIndex: number, channel: string, maxSize?: number): Promise<ChannelFrameResult | null> {
    if (!this.activeLayer) {
      console.warn('[LayerCache] No active layer configured');
      return null;
    }

    const { layerName } = this.activeLayer;
    const framePath = this.getFramePath(frameIndex);

    if (!framePath) {
      console.warn(`[LayerCache] No path for frame ${frameIndex}`);
      return null;
    }

    // Load via Rust FFI - individual channels still need PNG for now.
    // `decodeExrChannel` was extended with `max_size` on 2026-07-05 so
    // the Rust side resizes the PNG to fit before encoding.
    const { decodeExrChannel } = await import('../../TauriFileSystem');
    const result = await decodeExrChannel(framePath, channel, layerName, maxSize);

    if (result.success && result.png_base64) {
      return {
        success: true,
        imageDataUrl: `data:image/png;base64,${result.png_base64}`,
        channels: [channel],
        width: result.width || 0,
        height: result.height || 0
      };
    }
    return null;
  }

  /**
   * 2026-07-05 (channel-mode R/G/B/A fix):
   *
   * Maps a single-channel letter to the index inside the per-pixel
   * raw-RGBA buffer (0=R, 1=G, 2=B, 3=A). Y uses ITU-R BT.709 luma
   * weights instead of a single channel.
   */
  private static channelToRgbaOffset(channel: string): number | null {
    switch (channel) {
      case "R": return 0;
      case "G": return 1;
      case "B": return 2;
      case "A": return 3;
      default:  return null;
    }
  }

  /**
   * 2026-07-05: CPU-side swizzle from a raw RGBA `RawLinearEntry` to a
   * single-channel grayscale bitmap.
   *
   * - Used as the FAST path for the channel-mode R/G/B/A/Y tabs once
   *   the layer's RawLinearCache is warm. Avoids re-invoking the Rust
   *   `extract_exr_channel_from_layer` IPC (which costs ~80-200 ms even
   *   on the in-process FFI). Result: scrubbing between R/G/B/A tabs is
   *   essentially free after the first decode primes the warm cache.
   * - Returns an `ImageBitmap` (grayscale, alpha=255) ready for
   *   `ctx.drawImage`.
   * - Pixel layout matches what the Rust side would have produced in
   *   `extract_exr_channel_from_layer`: gray = clamp01(channelValue)
   *   expanded to RGBA, A=255.
   */
  private static async swizzleChannelFromRawLinear(
    raw: RawLinearEntry,
    channel: "R" | "G" | "B" | "A" | "Y",
  ): Promise<ImageBitmap> {
    const { width, height, pixels, isHalfFloat, channels } = raw;
    if (!width || !height) {
      throw new Error(`[LayerCache] swizzle: invalid raw dims ${width}x${height}`);
    }
    if (!pixels || pixels.length < width * height * (isHalfFloat ? 2 : 4)) {
      throw new Error(`[LayerCache] swizzle: pixel buffer too small (got ${pixels?.length ?? 0}, want ${width * height * (isHalfFloat ? 2 : 4)})`);
    }

    const totalPixels = width * height;
    const out = new Uint8ClampedArray(totalPixels * 4);

    // Index into the channel list. If a single-channel pass (AO, Z,
    // depth, ...) is broadcast across all four slots by the Rust side,
    // `channels.length` will be 1 with the same value in every slot,
    // and `componentIdx < channels.length` becomes the swizzle guard.
    const chCount = Math.max(1, channels?.length || 4);
    const componentIdx =
      channel === "R" ? 0 :
      channel === "G" ? 1 :
      channel === "B" ? 2 :
      channel === "A" ? 3 :
      /* Y */ -1;

    if (isHalfFloat) {
      const u16 = pixels as Uint16Array;
      for (let i = 0; i < totalPixels; i++) {
        let luma: number;
        if (componentIdx >= 0) {
          // Read the per-pixel RGBA sample at component idx, fall back
          // to idx 0 if the channel set is shorter (single-channel pass).
          const idx = i * 4 + (componentIdx < chCount ? componentIdx : 0);
          const bits = u16[idx]!;
          luma = halfToF32(bits);
        } else {
          // Y: BT.709 luma over whatever channels we have. If only one
          // channel exists, use it directly (single-channel "y" pass).
          const base = i * 4;
          const r = halfToF32(u16[base + 0]!);
          const g = chCount > 1 ? halfToF32(u16[base + 1]!) : r;
          const b = chCount > 2 ? halfToF32(u16[base + 2]!) : r;
          luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
        const v = clamp01ToByte(luma);
        const o = i * 4;
        out[o]     = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = 255;
      }
    } else {
      const f32 = pixels as Float32Array;
      for (let i = 0; i < totalPixels; i++) {
        let luma: number;
        if (componentIdx >= 0) {
          const idx = i * 4 + (componentIdx < chCount ? componentIdx : 0);
          luma = f32[idx]!;
        } else {
          const base = i * 4;
          const r = f32[base + 0]!;
          const g = chCount > 1 ? f32[base + 1]! : r;
          const b = chCount > 2 ? f32[base + 2]! : r;
          luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
        const v = clamp01ToByte(luma);
        const o = i * 4;
        out[o]     = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = 255;
      }
    }

    const imageData = new ImageData(out, width, height);
    return await createImageBitmap(imageData);
  }

  /**
   * 2026-07-05: Bitmap-returning variant of `loadChannelFrame`. Hits
   * the FFI (`decode_exr_channel`) → PNG → `dataUrlToImageBitmap` path
   * and packages the result in the standard `FrameBitmapResult` shape
   * so the player pipeline doesn't need a second code path.
   *
   * Honors both `signal.aborted` (drop in-flight decode on context
   * switch) and the generation guard (drop result if the cache
   * manager advanced past our captured generation). Same semantics as
   * the other branches in `_loadAndCacheBitmap`.
   */
  private async _loadChannelFrameBitmap(
    frameIndex: number,
    framePath: string,
    layerName: string,
    channel: "R" | "G" | "B" | "A" | "Y",
    maxSize: number,
    callGeneration: number,
    signal: AbortSignal,
  ): Promise<FrameBitmapResult | null> {
    if (signal.aborted) {
      dbg.log(`[_loadChannelFrameBitmap] aborted before start frame=${frameIndex} channel=${channel}`);
      return null;
    }

    const result = await this.loadChannelFrame(frameIndex, channel, maxSize);
    if (signal.aborted) {
      dbg.log(`[_loadChannelFrameBitmap] aborted after FFI frame=${frameIndex} channel=${channel}`);
      return null;
    }
    if (callGeneration !== this.generation) {
      dbg.log(`[_loadChannelFrameBitmap] gen mismatch after FFI frame=${frameIndex} channel=${channel}`);
      return null;
    }
    if (!result || !result.success) {
      console.warn(`[_loadChannelFrameBitmap] loadChannelFrame returned no data for frame=${frameIndex} channel=${channel}`);
      return null;
    }

    let bitmap: ImageBitmap;
    try {
      bitmap = await dataUrlToImageBitmap(result.imageDataUrl);
    } catch (err) {
      console.warn(`[_loadChannelFrameBitmap] dataUrlToImageBitmap failed for frame=${frameIndex} channel=${channel}:`, err);
      return null;
    }
    if (signal.aborted) {
      try { bitmap.close(); } catch { /* ignore */ }
      return null;
    }
    if (callGeneration !== this.generation) {
      try { bitmap.close(); } catch { /* ignore */ }
      return null;
    }

    return {
      bitmap,
      width: result.width,
      height: result.height,
      channels: [channel],
      generation: callGeneration,
    };
  }

  // ---- Phase 7: Bitmap-only loadFrame ----

  /**
   * Phase 7: Load frame as ImageBitmap.
   *
   * Flow:
   *   1. Check ImageBitmapCache → HIT → return cached bitmap
   *   2. MISS → decode via GPU pipeline (passthrough or full decode)
   *           → store bitmap → return
   *
   * The Phase 6C Float32RawCache re-render branch was removed in the
   * cache-layer refactor — the Rust `EXR-CACHE-LRU` + `EXR disk cache`
   * are the single source of truth for raw decoded RGBA, so OCIO mode
   * switches simply re-decode from there.
   *
   * This is the ONLY decode path now - no more double decode.
   */
  async loadFrameWithBitmap(frameIndex: number, channelMode?: string): Promise<FrameBitmapResult | null> {
    // 2026-07-14: tightened the per-frame trace to a single line so
    // the user's console isn't flooded with intermediate "Checking",
    // "MISS", "GPU available", "Calling _loadAndCacheBitmap" breadcrumbs
    // for every single-frame load. We still emit the final HIT/MISS
    // summary below; the verbose START log is kept but is the only
    // line in the success path, plus the cache outcome at the end.

    if (!this.activeLayer) {
      console.warn('[LayerCache] No active layer configured');
      return null;
    }

    // Phase 5B: bail out immediately if the user already triggered a
    // context switch. Without this, we waste time reading from caches
    // that no longer apply and might even start a fresh decode.
    if (this.decodeAbortController.signal.aborted) {
      dbg.log(`[LayerCache] loadFrameWithBitmap: signal already aborted, skipping frame=${frameIndex}`);
      return null;
    }

    const { layerName, ocioMode, customFingerprint, maxSize } = this.activeLayer;
    const framePath = this.getFramePath(frameIndex);
    const effectiveChannel = channelMode || this.activeLayer.channelMode || "RGB";

    if (!framePath) {
      console.warn(`[LayerCache] No path for frame ${frameIndex}`);
      return null;
    }

    const callGeneration = this.generation;
    const cacheKey = `${layerName}__${ocioMode}__${effectiveChannel}__${frameIndex}__${customFingerprint}`;

    // Check ImageBitmapCache first
    const cached = imageBitmapCache.get(
      layerName,
      ocioMode,
      effectiveChannel,
      frameIndex,
      customFingerprint,
      framePath
    );
    if (cached) {
      // Phase 8: return cached bitmap directly. Do NOT copy. The cache
      // owns the bitmap; the caller must NOT close it. When the cache
      // evicts the entry, it will close the bitmap and the caller's
      // reference becomes a no-op for redraw.
      return {
        bitmap: cached.bitmap,
        width: cached.width,
        height: cached.height,
        channels: cached.channels,
        generation: callGeneration
      };
    }

    // Check if already loading (deduplication)
    const existingPromise = this.loadingPromises.get(cacheKey);
    if (existingPromise) {
      dbg.log(`[LayerCache] Deduping load for frame ${frameIndex}`);
      const result = await existingPromise;
      if (result && result.generation === this.generation) {
        // No copy — return shared reference (see cache hit path)
        return { ...result, bitmap: result.bitmap };
      }
      return null;
    }

    // GPU path required
    if (!this.shouldUseGpu()) {
      console.warn('[LayerCache] GPU not available, cannot load frame');
      return null;
    }

    // Create loading promise
    const loadPromise = this._loadAndCacheBitmap(
      frameIndex,
      framePath,
      layerName,
      ocioMode,
      maxSize,
      effectiveChannel,
      customFingerprint,
      callGeneration,
      this.decodeAbortController.signal
    );

    this.loadingPromises.set(cacheKey, loadPromise);

    try {
      const result = await loadPromise;
      // 2026-07-14: replaced the always-emit "completed" line with a
      // summary that captures pass/fail in one place. No-op when the
      // helper already logged a more specific failure.
      if (result) {
        dbg.log(`[LayerCache] loadFrameWithBitmap OK frame=${frameIndex} ${result.width}x${result.height}`);
      }
      return result;
    } finally {
      this.loadingPromises.delete(cacheKey);
    }
  }

  /**
   * Internal: Load and cache a single frame as ImageBitmap
   */
  private async _loadAndCacheBitmap(
    frameIndex: number,
    framePath: string,
    layerName: string,
    ocioMode: string,
    maxSize: number,
    channelMode: string,
    customFingerprint: string,
    callGeneration: number,
    signal: AbortSignal
  ): Promise<FrameBitmapResult | null> {
    if (signal.aborted) {
      dbg.log(
        `[_loadAndCacheBitmap] aborted before start frame=${frameIndex}`,
      );
      return null;
    }
    // 2026-07-14: removed the unconditional "START frame=X, path=..."
    // trace. The outer `loadFrameWithBitmap OK frame=X` already covers
    // the per-frame summary; this one was just duplicating it. The
    // remaining log lines (`Calling pipeline...`, `SUCCESS`) fire only
    // on the non-trivial path.

    // Phase 10.2 (2026-07-13, second hotfix): single-flight claim
    // with a wait-for-release fallback. If the framePath is already
    // claimed by another path (U8 batch, warm loop) we *don't*
    // immediately return null — that triggered a tight retry loop
    // in `preloadAhead` / `displayFrame` because the caller kept
    // asking for the same frame every ~100 ms while it was being
    // decoded by a batch.
    //
    // Instead, wait for the claim to be released (max 5 s), then
    // check the cache. If the other path successfully populated the
    // cache we serve the hit; if it failed we return null and the
    // caller decides whether to retry.
    if (!this.tryClaimFrame(framePath)) {
      const released = await this.waitForFrameRelease(framePath, 5000);
      if (released) {
        const cachedAfterWait = imageBitmapCache.get(
          layerName,
          ocioMode,
          channelMode,
          frameIndex,
          customFingerprint,
          framePath,
        );
        if (cachedAfterWait) {
          dbg.log(
            `[_loadAndCacheBitmap] frame=${frameIndex} HIT cache after wait for release (cache size=${imageBitmapCache.size})`,
          );
          return {
            bitmap: cachedAfterWait.bitmap,
            width: cachedAfterWait.width,
            height: cachedAfterWait.height,
            channels: cachedAfterWait.channels,
            generation: callGeneration,
          };
        }
      }
      dbg.log(
        `[_loadAndCacheBitmap] skipped frame=${frameIndex}: already in flight (waited ${released ? 'released, no cache' : 'timeout 5s'})`,
      );
      return null;
    }

    try {
      return await this._loadAndCacheBitmapBody(
        frameIndex,
        framePath,
        layerName,
        ocioMode,
        maxSize,
        channelMode,
        customFingerprint,
        callGeneration,
        signal,
      );
    } finally {
      this.releaseFrame(framePath);
    }
  }

  /**
   * Phase 10.2 helper: await until the framePath claim is released
   * by the current owner (U8 batch, warm loop, ...). Returns
   * `true` if released within `timeoutMs`, `false` otherwise.
   *
   * Polling-based (10 ms cadence) rather than `await`-on-Promise
   * because `releaseFrame` doesn't expose a notifier. The set is
   * mutated under single-thread JS so a polled read is safe.
   */
  private waitForFrameRelease(
    framePath: string,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const poll = () => {
        if (!this.inFlightFramePaths.has(framePath)) {
          resolve(true);
          return;
        }
        if (performance.now() - t0 > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
  }

  /**
   * Phase 10 internal: actual `_loadAndCacheBitmap` body. Lifted
   * out so the outer wrapper can hold the single-flight claim
   * across every `await` (including the awaited
   * `dataUrlToImageBitmap` and GPU shader passes) and release in
   * `finally`.
   */
  private async _loadAndCacheBitmapBody(
    frameIndex: number,
    framePath: string,
    layerName: string,
    ocioMode: string,
    maxSize: number,
    channelMode: string,
    customFingerprint: string,
    callGeneration: number,
    signal: AbortSignal,
  ): Promise<FrameBitmapResult | null> {
    const pipeline = this.getGpuPipeline();
    const slug = this.humanToSlug(ocioMode);
    const t0 = performance.now();

    // Passthrough vs non-passthrough is decided once at the top of
    // this function — every branch below uses the same classification.
    // The user's "default view" semantic ("Raw" / "Linear sRGB") is
    // honoured by routing passthrough modes through pure FFI / CPU
    // paths that NEVER touch the GPU shader, even on a RawLinearCache
    // HIT. See the dedicated block below for the rationale and the
    // 2026-07-05 history of this guard.
        const isPassthrough =
          slug === OCIO_MODE_SLUGS.LINEAR_SRGB || slug === OCIO_MODE_SLUGS.RAW;
    
        // Phase 9-restructured (2026-07-05): check `RawLinearCache` BEFORE
        // any FFI call. The raw pixel buffer is mode-agnostic, so a HIT lets
        // us skip the 4-second Rust re-decode and serve the cached buffer
        // directly. Two distinct branches:
        //
        //   - Passthrough HIT ("Raw" / "Linear sRGB"): the cached F16/F32
        //     buffer goes through `pipeline.decodeRawLinearToBitmapDirect`
        //     which is a pure CPU clamp + `createImageBitmap` step. No
        //     GPU upload, no shader pass, ~30-50 ms per frame on a
        //     1920x1920 buffer. Pixel-identical to FFI Direct.
        //
        //   - Non-passthrough HIT (ACES, custom LUT): the same cached
        //     buffer goes through `reRenderWithLut` (GPU upload + LUT
        //     shader + readback), ~3-30 ms per frame on 1920x1920.
        //
        // Before this fix the HIT path ran `reRenderWithLut` for BOTH
        // passthrough and non-passthrough modes. That produced ~880 ms
        // per frame when the user switched back to "Linear sRGB" after
        // ACES had warmed the raw cache — even though the FFI pipeline
        // could have served the frame in ~5 ms. Splitting the branch
        // restores the FFI-decode semantic the user expects while still
        // preserving the speed win for ACES.
        if (isBeautyLayerName(layerName) && !signal.aborted) {
          const cachedRaw = rawLinearCache.get(
            layerName,
            framePath,
            maxSize,
            customFingerprint,
          );
          if (cachedRaw) {
            if (isPassthrough) {
              // Passthrough HIT: CPU clamp from cached raw buffer. No
              // GPU shader pass — matches the "default view" semantic
              // the user expects when they pick "Raw".
              dbg.log(
                `[_loadAndCacheBitmap] RawLinearCache HIT frame=${frameIndex} (mode=${slug}) — passthrough, CPU clamp (no FFI, no shader)`,
              );
              const dr = await pipeline.decodeRawLinearToBitmapDirect(
                cachedRaw.pixels,
                cachedRaw.width,
                cachedRaw.height,
                cachedRaw.isHalfFloat,
                cachedRaw.channels,
                signal,
              );
              if (signal.aborted) {
                try { dr.bitmap?.close(); } catch {}
                return null;
              }
              if (callGeneration !== this.generation) {
                try { dr.bitmap?.close(); } catch {}
                return null;
              }
              if (dr.success && dr.bitmap) {
                const w = dr.width ?? cachedRaw.width;
                const h = dr.height ?? cachedRaw.height;
                const entry: BitmapCacheEntry = {
                  bitmap: dr.bitmap,
                  width: w,
                  height: h,
                  channels: dr.channels || cachedRaw.channels,
                  layerName,
                  ocioMode,
                  customFingerprint,
                  channelMode,
                  frameIndex,
                  framePath,
                  decodedAt: Date.now(),
                  estimatedBytes: w * h * 4,
                };
                imageBitmapCache.set(entry);
                const elapsed = performance.now() - t0;
                dbg.log(
                  `[_loadAndCacheBitmap] Passthrough HIT SUCCESS: ${elapsed.toFixed(0)}ms (${w}x${h}) — CPU clamp from RawLinearCache`,
                );
                return {
                  bitmap: dr.bitmap,
                  width: w,
                  height: h,
                  channels: dr.channels || cachedRaw.channels,
                  generation: callGeneration,
                };
              }
              console.warn(
                `[_loadAndCacheBitmap] decodeRawLinearToBitmapDirect failed (${dr.error}); falling through to FFI`,
              );
            } else {
              // Non-passthrough HIT: GPU shader path through the active LUT.
              dbg.log(
                `[_loadAndCacheBitmap] RawLinearCache HIT frame=${frameIndex} (mode=${slug}) — skipping FFI, using reRenderWithLut`,
              );
              pipeline.setActiveSlug(slug);
              const rr = await pipeline.reRenderWithLut(
                cachedRaw.pixels,
                cachedRaw.width,
                cachedRaw.height,
                cachedRaw.isHalfFloat,
                cachedRaw.channels,
                layerName,
                maxSize,
                customFingerprint,
                signal,
              );
              if (signal.aborted) {
                try { rr.bitmap?.close(); } catch {}
                return null;
              }
              if (callGeneration !== this.generation) {
                try { rr.bitmap?.close(); } catch {}
                return null;
              }
              if (rr.success && rr.bitmap) {
                const w = rr.width ?? cachedRaw.width;
                const h = rr.height ?? cachedRaw.height;
                const entry: BitmapCacheEntry = {
                  bitmap: rr.bitmap,
                  width: w,
                  height: h,
                  channels: rr.channels || cachedRaw.channels,
                  layerName,
                  ocioMode,
                  customFingerprint,
                  channelMode,
                  frameIndex,
                  framePath,
                  decodedAt: Date.now(),
                  estimatedBytes: w * h * 4,
                };
                imageBitmapCache.set(entry);
                const elapsed = performance.now() - t0;
                dbg.log(
                  `[_loadAndCacheBitmap] Re-render SUCCESS: ${elapsed.toFixed(0)}ms (${w}x${h}) — Phase 9 (non-passthrough HIT path)`,
                );
                return {
                  bitmap: rr.bitmap,
                  width: w,
                  height: h,
                  channels: rr.channels || cachedRaw.channels,
                  generation: callGeneration,
                };
              }
              console.warn(
                `[_loadAndCacheBitmap] reRenderWithLut failed on HIT path (${rr.error}); falling through to FFI`,
              );
            }
          }
        }
    
        // ===================================================================
        // 2026-07-05: Channel-mode R/G/B/A/Y branch.
        //
        // The RGB path below goes through RawLinearCache → shader, but the
        // GPU pipeline doesn't know about single-channel modes (it always
        // decodes full RGBA). For channel=R/G/B/A/Y the cheapest
        // pixel-correct path is:
        //
        //   1. Try the RawLinearCache (already populated by the background
        //      warmer or by a prior RGB decode). If HIT → CPU swizzle
        //      (~1-2 ms for 1920² RGBA, zero Rust IPC). Store the bitmap
        //      back into ImageBitmapCache keyed by channel so the next
        //      frame at the same channel skips the swizzle.
        //   2. MISS → fall back to the dedicated FFI
        //      `decode_exr_channel` path (returns grayscale PNG, ~80-200 ms
        //      depending on compression). PNG → ImageBitmap via
        //      `dataUrlToImageBitmap`. Same cache-store + return shape.
        //
        // This branch returns BEFORE the RGB paths so the existing
        // RawLinearCache.HIT path (which assumes RGB shader consumption)
        // and the Beauty warm-then-render path don't fire for channel mode.
        //
        // NOTE: `_loadAndCacheBitmap` does NOT receive `channelMode` as an
        // argument (the GPU pipeline has no concept of channels — see
        // `exrGpuPipeline.decodeAndRender`). The caller (`loadFrameWithBitmap`,
        // line 652) already typed the cache key with `effectiveChannel`, so
        // we re-derive it here from `activeLayer.channelMode` for symmetry.
        // The cache lookup above at the top of `loadFrameWithBitmap` is the
        // outer HIT gate; this branch handles the inner branch.
        // ===================================================================
        const channelForThisLoad = this.activeLayer?.channelMode ?? "RGB";
        const isSingleChannel = channelForThisLoad === "R" || channelForThisLoad === "G"
          || channelForThisLoad === "B" || channelForThisLoad === "A" || channelForThisLoad === "Y";
        if (isSingleChannel && !signal.aborted) {
          const ch = channelForThisLoad as "R" | "G" | "B" | "A" | "Y";
    
          // Fast path: RawLinearCache HIT → CPU swizzle.
          const cachedRaw = rawLinearCache.get(
            layerName,
            framePath,
            maxSize,
            customFingerprint,
          );
          if (cachedRaw) {
            dbg.log(
              `[_loadAndCacheBitmap] Channel '${ch}' RawLinearCache HIT frame=${frameIndex} — CPU swizzle (no FFI)`,
            );
            let bitmap: ImageBitmap;
            try {
              bitmap = await LayerCacheManager.swizzleChannelFromRawLinear(cachedRaw, ch);
            } catch (err) {
              console.warn(
                `[_loadAndCacheBitmap] swizzle failed for frame=${frameIndex} channel=${ch}, falling back to FFI:`,
                err,
              );
              bitmap = null as unknown as ImageBitmap;
            }
            if (signal.aborted) {
              try { bitmap?.close?.(); } catch { /* ignore */ }
              return null;
            }
            if (callGeneration !== this.generation) {
              try { bitmap?.close?.(); } catch { /* ignore */ }
              return null;
            }
            if (bitmap) {
              const w = bitmap.width || cachedRaw.width;
              const h = bitmap.height || cachedRaw.height;
              const entry: BitmapCacheEntry = {
                bitmap,
                width: w,
                height: h,
                channels: [ch],
                layerName,
                ocioMode,
                customFingerprint,
                channelMode,
                frameIndex,
                framePath,
                decodedAt: Date.now(),
                estimatedBytes: w * h * 4,
              };
              imageBitmapCache.set(entry);
              return {
                bitmap,
                width: w,
                height: h,
                channels: [ch],
                generation: callGeneration,
              };
            }
            // bitmap is null → fall through to FFI
          }
    
          // Slow path: FFI `decode_exr_channel` → PNG → ImageBitmap.
          dbg.log(
            `[_loadAndCacheBitmap] Channel '${ch}' RawLinearCache MISS frame=${frameIndex} — calling FFI decode_exr_channel`,
          );
          const chResult = await this._loadChannelFrameBitmap(
            frameIndex,
            framePath,
            layerName,
            ch,
            maxSize,
            callGeneration,
            signal,
          );
          if (!chResult) {
            return null;
          }
          const w = chResult.width || 0;
          const h = chResult.height || 0;
          const entry: BitmapCacheEntry = {
            bitmap: chResult.bitmap,
            width: w,
            height: h,
            channels: chResult.channels,
            layerName,
            ocioMode,
            customFingerprint,
            channelMode,
            frameIndex,
            framePath,
            decodedAt: Date.now(),
            estimatedBytes: w * h * 4,
          };
          imageBitmapCache.set(entry);
          const elapsed = performance.now() - t0;
          dbg.log(
            `[_loadAndCacheBitmap] Channel '${ch}' FFI SUCCESS: ${elapsed.toFixed(0)}ms (${w}x${h})`,
          );
          return chResult;
        }
    
        // 2026-07-04: Per user request, Raw / Linear sRGB never touch the
        // GPU LUT pipeline. Route them through a pure FFI → ImageBitmap
        // path (added in `ExrGpuPipeline.decodeFrameToBitmapDirect`). This
        // is the fallback when the HIT path above did not match (cache
        // miss / non-Beauty layer / signal aborted) — and it's also the
        // primary path for "Raw" frames the user just clicked into the
        // app for the first time.
        if (isPassthrough) {
          dbg.log(
            `[_loadAndCacheBitmap] Passthrough mode (${slug}) → decodeFrameToBitmapDirect (no LUT, no OETF, raw clamp)`,
          );
          const r = await pipeline.decodeFrameToBitmapDirect(
            framePath,
            maxSize,
            layerName,
            customFingerprint,
            signal,
          );
    
          if (signal.aborted) {
            dbg.log(
              `[_loadAndCacheBitmap] aborted during direct decode frame=${frameIndex}`,
            );
            return null;
          }
    
          if (callGeneration !== this.generation) {
            dbg.log(
              `[_loadAndCacheBitmap] Generation mismatch after direct decode, dropping result`,
            );
            try {
              r.bitmap?.close();
            } catch {}
            return null;
          }
          if (!r.success || !r.bitmap) {
            console.warn(
              `[_loadAndCacheBitmap] decodeFrameToBitmapDirect failed for frame ${frameIndex}`,
            );
            return null;
          }

          const w = r.width ?? 0;
          const h = r.height ?? 0;
    
          // Phase 7-revisit: even passthrough (Raw / Linear sRGB) decodes
          // produce a raw RGBA buffer worth caching. The next OCIO mode
          // switch (e.g. Raw → ACES) will use this via reRenderWithLut.
          const capturedDirect = pipeline.popCapturedRaw();
          if (capturedDirect && capturedDirect.width > 0 && capturedDirect.height > 0) {
            const bytesPerPx = capturedDirect.isHalfFloat ? 2 : 4;
            rawLinearCache.set({
              pixels: capturedDirect.pixels,
              width: capturedDirect.width,
              height: capturedDirect.height,
              channels: capturedDirect.channels,
              isHalfFloat: capturedDirect.isHalfFloat,
              layerName: capturedDirect.layerName || layerName,
              framePath,
              maxSize: capturedDirect.maxSize || maxSize,
              customFingerprint: capturedDirect.customFingerprint || customFingerprint,
              decodedAt: Date.now(),
              estimatedBytes: capturedDirect.width * capturedDirect.height * 4 * bytesPerPx,
            });
            dbg.log(
              `[_loadAndCacheBitmap] Passthrough: RawLinearCache stored ${capturedDirect.width}x${capturedDirect.height}`,
            );
          }
    
          const entry: BitmapCacheEntry = {
            bitmap: r.bitmap,
            width: w,
            height: h,
            channels: r.channels || [],
            layerName,
            ocioMode,
            customFingerprint,
            channelMode,
            frameIndex,
            framePath,
            decodedAt: Date.now(),
            estimatedBytes: w * h * 4,
          };
          imageBitmapCache.set(entry);
    
          const elapsed = performance.now() - t0;
          dbg.log(
            `[_loadAndCacheBitmap] Passthrough decode SUCCESS: ${elapsed.toFixed(0)}ms (${w}x${h})`,
          );
    
          // Phase 8: return cached bitmap directly. Do NOT copy.
          return {
            bitmap: r.bitmap,
            width: w,
            height: h,
            channels: r.channels || [],
            generation: callGeneration,
          };
        }
    
        // Phase 7-revisit re-render block removed in Phase 9-restructured:
        // the universal `RawLinearCache HIT` path at the top of this
        // function already covers both passthrough and non-passthrough
        // modes. If execution reaches this point for a Beauty frame it
        // means the cache missed; the next block (`Beauty warm+reRender`)
        // warms that single frame and re-renders.
    
        // Phase 9-restructured (2026-07-05): For Beauty-layer frames in
        // non-passthrough modes (ACES, custom LUT, ...) the only sensible
        // path is RawLinearCache → reRenderWithLut. The legacy FFI fallback
        // (`decodeFrameToBitmap`) is kept ONLY for non-Beauty layers where
        // the OCIO config may not be covered by a registered warm path.
        //
        // For Beauty: warm this single frame synchronously then re-render.
        // The warm call hits Rust's EXR-CACHE-LRU when the file was just
        // decoded by another path, so it's typically ~50ms instead of
        // 600ms cold IPC.
        //
        // 2026-07-05 (third pass): skip this block entirely for
        // passthrough modes (Raw / Linear sRGB). Passthrough frames go
        // through `decodeFrameToBitmapDirect` (no GPU) which is the
        // user-requested "default view" semantic. Without this guard,
        // a passthrough MISS would route through `reRenderWithLut` →
        // shader pass → ~880ms GPU cost, which violates the FFI-decode
        // promise of passthrough mode.
        if (isBeautyLayerName(layerName) && !signal.aborted && !isPassthrough) {
          dbg.log(
            `[_loadAndCacheBitmap] frame=${frameIndex} Beauty MISS in RawLinearCache; warming then re-rendering`,
          );
          await pipeline.warmRawLinearCache(
            [framePath],
            maxSize,
            layerName,
            customFingerprint,
            signal,
          );
          const cachedAfter = rawLinearCache.get(
            layerName ?? "",
            framePath,
            maxSize,
            customFingerprint,
          );
          if (cachedAfter) {
            pipeline.setActiveSlug(slug);
            const rr2 = await pipeline.reRenderWithLut(
              cachedAfter.pixels,
              cachedAfter.width,
              cachedAfter.height,
              cachedAfter.isHalfFloat,
              cachedAfter.channels,
              layerName,
              maxSize,
              customFingerprint,
              signal,
            );
            if (signal.aborted) {
              try { rr2.bitmap?.close(); } catch {}
              return null;
            }
            if (callGeneration !== this.generation) {
              try { rr2.bitmap?.close(); } catch {}
              return null;
            }
            if (rr2.success && rr2.bitmap) {
              const w = rr2.width ?? cachedAfter.width;
              const h = rr2.height ?? cachedAfter.height;
              imageBitmapCache.set({
                bitmap: rr2.bitmap,
                width: w,
                height: h,
                channels: rr2.channels || cachedAfter.channels,
                layerName,
                ocioMode,
                customFingerprint,
                channelMode,
                frameIndex,
                framePath,
                decodedAt: Date.now(),
                estimatedBytes: w * h * 4,
              });
              const elapsed = performance.now() - t0;
              dbg.log(
                `[_loadAndCacheBitmap] Beauty warm+reRender SUCCESS: ${elapsed.toFixed(0)}ms (${w}x${h}) — Phase 9`,
              );
              return {
                bitmap: rr2.bitmap,
                width: w,
                height: h,
                channels: rr2.channels || cachedAfter.channels,
                generation: callGeneration,
              };
            }
            console.warn(
              `[_loadAndCacheBitmap] Beauty warm+reRender failed (${rr2.error}); falling through to legacy FFI`,
            );
          } else {
            console.warn(
              `[_loadAndCacheBitmap] Beauty warm produced no cache entry for frame=${frameIndex}; falling through to legacy FFI`,
            );
          }
        }
    
        // Legacy FFI fallback path — kept for non-Beauty layers (Crypto,
        // Emitters, Output AOV, ...). Phase 6C removed the JS-side
        // Float32RawCache; the Rust `EXR-CACHE-LRU` + disk cache hold
        // the authoritative copy.
        if (signal.aborted) {
          dbg.log(
            `[_loadAndCacheBitmap] aborted before legacy FFI frame=${frameIndex}`,
          );
          return null;
        }
        dbg.log(`[_loadAndCacheBitmap] Calling pipeline.decodeFrameToBitmap (legacy non-Beauty fallback)`);
        pipeline.setActiveSlug(slug);
        const r = await pipeline.decodeFrameToBitmap(framePath, maxSize, layerName, customFingerprint, signal);
    
        // Phase 5B: signal abort wins over generation mismatch — if user
        // switched context mid-decode, return null immediately so we don't
        // waste time writing the result into ImageBitmapCache only to have
        // the new context ignore it.
        if (signal.aborted) {
          dbg.log(
            `[_loadAndCacheBitmap] aborted during decode frame=${frameIndex}`,
          );
          try { r.bitmap?.close(); } catch {}
          return null;
        }
    
        // Drop stale results
        if (callGeneration !== this.generation) {
          dbg.log(`[_loadAndCacheBitmap] Generation mismatch after decode, dropping result`);
          try { r.bitmap?.close(); } catch {}
          return null;
        }
    
        if (!r.success || !r.bitmap) {
          console.warn(`[_loadAndCacheBitmap] decodeFrameToBitmap failed for frame ${frameIndex}`);
          return null;
        }
    
        const w = r.width ?? 0;
        const h = r.height ?? 0;
    
        // Phase 7-revisit: drain the raw pixel buffer captured by the
        // pipeline during decodeFrameToBitmap, store it in RawLinearCache
        // so the next OCIO mode switch can re-render without an FFI
        // re-decode. `popCapturedRaw()` resets the pipeline's reference,
        // so we own the buffer's lifecycle from here.
        const captured = pipeline.popCapturedRaw();
        if (captured && captured.width > 0 && captured.height > 0) {
          const bytesPerPx = captured.isHalfFloat ? 2 : 4;
          const rawEntry: RawLinearEntry = {
            pixels: captured.pixels,
            width: captured.width,
            height: captured.height,
            channels: captured.channels,
            isHalfFloat: captured.isHalfFloat,
            layerName: captured.layerName || layerName,
            framePath,
            maxSize: captured.maxSize || maxSize,
            customFingerprint: captured.customFingerprint || customFingerprint,
            decodedAt: Date.now(),
            estimatedBytes: captured.width * captured.height * 4 * bytesPerPx,
          };
          rawLinearCache.set(rawEntry);
          dbg.log(
            `[_loadAndCacheBitmap] RawLinearCache stored: ${rawEntry.width}x${rawEntry.height} f16=${rawEntry.isHalfFloat} ~${Math.round(rawEntry.estimatedBytes / 1024 / 1024)}MB`,
          );
        } else if (captured === null && pipeline.peekCapturedRaw() === false) {
          // No capture pending — pipeline didn't expose raw pixels. Common
          // for paths that use legacy fallback or U8-only response. Log
          // once at debug level; no error needed.
          dbg.log(
            `[_loadAndCacheBitmap] no raw capture available (legacy/U8 path); RawLinearCache miss next time`,
          );
        }
    
        // Store in ImageBitmapCache
        const entry: BitmapCacheEntry = {
          bitmap: r.bitmap,
          width: w,
          height: h,
          channels: r.channels || [],
          layerName,
          ocioMode,
          customFingerprint,
          channelMode,
          frameIndex,
          framePath,
          decodedAt: Date.now(),
          estimatedBytes: w * h * 4
        };
        imageBitmapCache.set(entry);
    
        const elapsed = performance.now() - t0;
        dbg.log(`[_loadAndCacheBitmap] Full decode SUCCESS: ${elapsed.toFixed(0)}ms (${w}x${h})`);
    
        // Phase 8: return cached bitmap directly. Do NOT copy. Caller MUST NOT close.
        return {
          bitmap: r.bitmap,
          width: w,
          height: h,
          channels: r.channels || [],
          generation: callGeneration
        };
  }

  // ---- Preloading ----

  /**
   * Preload frames ahead of current frame
   * Uses sequential loading to avoid overwhelming the decode queue
   */
  async preloadAhead(centerFrame: number, count: number): Promise<void> {
    if (!this.activeLayer || count <= 0) return;

    for (let i = 1; i <= count; i++) {
      const idx = centerFrame + i;
      if (idx >= this.getTotalFrames()) break;
      if (this.isFrameLoaded(idx)) continue;

      const result = await this.loadFrameWithBitmap(idx);
      if (!result) {
        console.warn(`[LayerCache] preloadAhead: failed to load frame ${idx}`);
      }
    }
  }

  /**
   * Preload frames behind current frame (for backward scrubbing)
   */
  async preloadBehind(centerFrame: number, count: number): Promise<void> {
    if (!this.activeLayer || count <= 0) return;

    for (let i = 1; i <= count; i++) {
      const idx = centerFrame - i;
      if (idx < 0) break;
      if (this.isFrameLoaded(idx)) continue;

      await this.loadFrameWithBitmap(idx);
    }
  }

  /**
   * Preload a range of frames (bidirectional)
   */
  async preloadRange(centerFrame: number, range: number): Promise<void> {
    if (!this.activeLayer) return;

    const totalFrames = this.getTotalFrames();
    for (let i = -range; i <= range; i++) {
      if (i === 0) continue;
      const idx = centerFrame + i;
      if (idx < 0 || idx >= totalFrames) continue;
      if (this.isFrameLoaded(idx)) continue;

      await this.loadFrameWithBitmap(idx);
    }
  }

  /**
   * Preload ALL frames in current layer
   */
  async preloadAll(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (!this.activeLayer) return;

    const totalFrames = this.getTotalFrames();
    let loaded = 0;

    for (let i = 0; i < totalFrames; i++) {
      if (this.isFrameLoaded(i)) {
        loaded++;
        onProgress?.(loaded, totalFrames);
        continue;
      }

      const result = await this.loadFrameWithBitmap(i);
      if (result) {
        loaded++;
        onProgress?.(loaded, totalFrames);
      }
    }
  }

  // ---- Continuous Background Loader ----

  /**
   * Start continuous background loading (AALab style)
   * Keeps decoding frames into RAM in the background
   */
  startContinuousLoad(
    onFrameLoaded?: (frameIndex: number, total: number) => void,
    batchSize: number = 8,
    _delayMs: number = 0,
    // Phase 2 (2026-07-13): explicit wrap-around policy. Default
    // `'stop'` keeps the one-pass forward-only scan; callers that
    // *want* the historical wrap-to-0 behaviour (e.g. a replay
    // loop) opt-in here. The current preload caller
    // (`useContinuousLoader.ts:115`) does not need replay semantics
    // — the playback UI is the right place for that.
    loopBehavior: "stop" | "wrap" = "stop",
  ): void {
    if (!this.activeLayer) {
      console.warn('[LayerCache] startContinuousLoad: no active layer');
      return;
    }
    if (this.continuousLoaderRunning) {
      dbg.log('[LayerCache] startContinuousLoad: already running, skip');
      return;
    }
    // Phase 9-restructured (2026-07-05): continuous U8 batch load is
    // only useful for passthrough modes (Raw / Linear sRGB). For
    // non-passthrough modes (ACES, custom LUT, ...) the batch bitmaps
    // are colour-incorrect and would be thrown away, and the only
    // cache that matters is RawLinearCache — which the dedicated
    // `kickContinuousRawLinearWarm` already fills (it bails out at
    // its own check for non-passthrough modes, so it's a no-op when
    // the user is on ACES). Skipping the loop here also prevents the
    // hot loop that produced "batch=16 skipped ... 121374 times" in
    // the console after switching from Raw → ACES.
    const initialSlug = this.humanToSlug(this.activeLayer.ocioMode);
    const initialIsPassthrough =
      initialSlug === OCIO_MODE_SLUGS.LINEAR_SRGB ||
      initialSlug === OCIO_MODE_SLUGS.RAW;
    if (!initialIsPassthrough) {
      dbg.log(
        `[LayerCache] startContinuousLoad SKIPPED: mode="${initialSlug}" is non-passthrough; using RawLinear warmer only`,
      );
      // Still try to kick the warm — `kickContinuousRawLinearWarm`
      // is idempotent and bails out for non-passthrough modes on its
      // own, but this keeps the path symmetric with the passthrough
      // case and ensures the LRU warmer is alive for the next time
      // the user flips back to Raw.
      this.kickContinuousRawLinearWarm();
      return;
    }
    dbg.log(`[LayerCache] startContinuousLoad START (batchSize=${batchSize}, totalFrames=${this.activeLayer.framePaths.length})`);

    const cursorKey = `${this.activeLayer.layerName}__${this.activeLayer.ocioMode}`;
    let cursor = this.continuousCursors.get(cursorKey) ?? 0;
    cursor = this.clampCursorToFirstMissing(cursor);
    this.pendingCursorSave = cursor;

    this.continuousLoaderRunning = true;
    this.continuousAbortController = new AbortController();
    const signal = this.continuousAbortController.signal;

    // Phase NAV-1: snapshot the sequence fingerprint at the *start* of
    // this continuous-load invocation. If the user navigates away (or
    // opens a different EXR) `currentSequenceId` will change; the check
    // below makes the batch loop short-circuit at the top of each
    // iteration so no further Rust batches are submitted for the
    // abandoned sequence. Any Rust batch already in flight (submitted
    // before the navigation) will still complete — that's accepted in
    // the plan because cancelling mid-batch requires new Tauri commands.
    const sequenceSnapshot = this.currentSequenceId;

    const run = async () => {
      let currentCursor = cursor;

      while (!signal.aborted && this.activeLayer) {
        // Phase NAV-1: if the sequence changed mid-loop (user clicked
        // another file/folder → Details Pane unmounted → hardStopAll
        // cleared currentSequenceId), bail out before submitting more
        // Rust work. The existing signal.aborted check handles the
        // explicit-abort path; this catches the implicit "sequence
        // replaced" path.
        if (this.currentSequenceId !== sequenceSnapshot) {
          const prev = sequenceSnapshot.length > 60
            ? sequenceSnapshot.slice(0, 30) + "…" + sequenceSnapshot.slice(-30)
            : sequenceSnapshot;
          const cur = this.currentSequenceId.length > 60
            ? this.currentSequenceId.slice(0, 30) + "…" + this.currentSequenceId.slice(-30)
            : this.currentSequenceId || "<empty>";
          dbg.log(
            `[LayerCache] continuous batch loop aborted: sequence cleared/changed (${prev} → ${cur})`,
          );
          break;
        }

        // Re-check passthrough each iteration: `configure()` may have
        // flipped the OCIO mode since this loop started. If it did,
        // the batch bitmaps would be colour-incorrect so we just bail
        // out — RawLinearCache is already preserved across OCIO
        // switches, and `kickContinuousRawLinearWarm` is the
        // authoritative filler for non-passthrough modes.
        const slug = this.humanToSlug(this.activeLayer.ocioMode);
        const isPassthrough =
          slug === OCIO_MODE_SLUGS.LINEAR_SRGB ||
          slug === OCIO_MODE_SLUGS.RAW;
        if (!isPassthrough) {
          dbg.log(
            `[LayerCache] continuous batch loop bailing: mode switched to non-passthrough "${slug}"`,
          );
          break;
        }
        // Phase 9: collect a full batch of unloaded frames up front,
        // then hand them to the Rust `decode_exr_batch_u8` command in
        // a single IPC roundtrip. With 32 worker threads already
        // running on the C++ bridge side this turns a ~1 s/file
        // serial fill into roughly the wall-clock time of the slowest
        // single frame in the batch.
        // Phase 2 (2026-07-13): one-pass forward scan by default.
        // When `loopBehavior === 'wrap'` the caller asked for the
        // historical replay-style behaviour (scan cursor→EOF then
        // wrap to 0). When `'stop'` (the new default) we just stop
        // when the forward scan finds nothing — no spurious batches
        // re-decoding frames already in the cache.
        const scanNext = loopBehavior === "wrap"
          ? (c: number) => this.findNextUnloadedFrameWithWrap(c)
          : (c: number) => this.findNextUnloadedFrame(c);

        const batchIndices: number[] = [];
        for (let i = 0; i < batchSize; i++) {
          const found = scanNext(currentCursor);
          if (found >= 0) {
            batchIndices.push(found);
            currentCursor = found + 1;
          } else {
            // Phase 2: no more unloaded frames ahead. When
            // `loopBehavior === 'stop'` (default) we break
            // immediately; when `'wrap'` the next iteration's
            // scanNext will jump the cursor past EOF for us.
            if (loopBehavior === "stop") break;
          }
        }

        if (batchIndices.length === 0) break;

        await this._decodeAndCacheBatch(batchIndices, signal);

        // Notify the UI / persistence layer for every frame that
        // landed in the cache, regardless of which exact frame in
        // the batch hit. The onFrameLoaded contract is
        // "fire when progress moves forward", and the cache check
        // inside `isFrameLoaded` is cheap.
        for (const frameIdx of batchIndices) {
          if (signal.aborted) break;
          if (this.isFrameLoaded(frameIdx) && onFrameLoaded) {
            onFrameLoaded(frameIdx, this.getTotalFrames());
          }
        }

        this.pendingCursorSave = currentCursor;
        this.continuousCursors.set(cursorKey, currentCursor);
      }

      this.continuousLoaderRunning = false;
    };

    run().catch(err => {
      this.continuousLoaderRunning = false;
      console.error('[LayerCache] Continuous loader error:', err);
    });
  }

  /**
   * Phase 9: Decode N frames in one Rust roundtrip and write the
   * resulting `ImageBitmap`s into the shared `ImageBitmapCache`.
   *
   * Sequential on the JS side (one frame at a time runs through
   * the shader + ImageBitmap conversion so we don't have to
   * multiplex renderers), but the expensive disk+EXR work is
   * done in parallel on the Rust thread pool.
   */
  private async _decodeAndCacheBatch(
    frameIndices: number[],
    signal: AbortSignal,
  ): Promise<void> {
    if (frameIndices.length === 0) return;
    const layer = this.activeLayer;
    if (!layer) return;

    // Phase 10.1 (2026-07-13, post-ship hotfix): priority claim.
    // We use the priority variant because the U8 batch is the
    // fastest path for the user (16 frames in one IPC roundtrip
    // via `decode_exr_batch_u8`'s rayon pool) and the most
    // important to populate first. If a sync single-frame load
    // (e.g. `displayFrame` for frame 0) already claimed a path,
    // we steal that claim — the sync loader's `finally` release
    // will be a no-op, and the batch will finish the work in
    // ~110 ms per frame instead of ~2.8 s.
    const claimedIndices: number[] = [];
    const claimedPaths: string[] = [];
    for (const idx of frameIndices) {
      const p = layer.framePaths[idx];
      if (!p) continue;
      if (!this.tryClaimFramePriority(p)) continue;
      claimedIndices.push(idx);
      claimedPaths.push(p);
    }
    if (claimedPaths.length === 0) {
      dbg.log(
        `[_decodeAndCacheBatch] all ${frameIndices.length} frames already in flight; skip batch`,
      );
      return;
    }

    try {
      await this._decodeAndCacheBatchInner(
        claimedIndices,
        claimedPaths,
        layer,
        signal,
      );
    } finally {
      // Release claims regardless of outcome — both happy-path
      // (cache.set) and error/abort paths need this so the next
      // sweep can re-attempt if needed.
      for (const p of claimedPaths) this.releaseFrame(p);
    }
  }

  /**
   * Phase 10 internal: actual decode+cache logic. Lifted out of
   * `_decodeAndCacheBatch` so the outer wrapper can hold the
   * single-flight claim across the full async path (including
   * awaited pipeline calls) and release in `finally`.
   */
  private async _decodeAndCacheBatchInner(
    frameIndices: number[],
    paths: string[],
    layer: NonNullable<LayerCacheManager["activeLayer"]>,
    signal: AbortSignal,
  ): Promise<void> {
    if (frameIndices.length === 0 || paths.length === 0) return;

        const callGeneration = this.generation;
        const tStart = performance.now();
    
        // Phase 9-restructured (2026-07-05): for non-passthrough modes
        // (ACES, custom LUTs, ...) the U8 batch's bitmaps are colour-
        // incorrect and would be thrown away. Skip the Rust roundtrip
        // entirely and only kick the continuous RawLinearCache warmer.
        // That warmer fills the cache with F16 raw pixels in the
        // background; `loadFrameWithBitmap` will pick them up via
        // reRenderWithLut when the user scrubs.
        const batchSlug = this.humanToSlug(layer.ocioMode);
        const batchIsPassthrough =
          batchSlug === OCIO_MODE_SLUGS.LINEAR_SRGB ||
          batchSlug === OCIO_MODE_SLUGS.RAW;
        if (!batchIsPassthrough) {
          const elapsed = performance.now() - tStart;
          dbg.log(
            `[_decodeAndCacheBatch] batch=${frameIndices.length} skipped (non-passthrough mode=${batchSlug}; only RawLinear warm)`,
          );
          if (!signal.aborted) this.kickContinuousRawLinearWarm();
          return;
        }
    
        let bitmaps: Awaited<
          ReturnType<NonNullable<ReturnType<typeof this.getGpuPipeline>>["decodeBatchToBitmaps"]>
        > | null = null;
        try {
          const pipeline = this.getGpuPipeline();
          pipeline.setActiveSlug(layer.ocioMode);
          bitmaps = await pipeline.decodeBatchToBitmaps(
            paths,
            layer.maxSize,
            layer.layerName,
            signal,
          );
        } catch (err) {
          if (!signal.aborted) {
            console.warn(
              `[LayerCache] _decodeAndCacheBatch: pipeline.decodeBatchToBitmaps failed`,
              err,
            );
          }
          return;
        }
        if (signal.aborted) return;
        if (callGeneration !== this.generation) return;
    
        let successCount = 0;
        // Phase 9: only passthrough modes (Raw / Linear sRGB) feed the
        // batch's u8 → ImageBitmap pipeline. Other OCIO modes (ACES,
        // custom LUTs, etc.) still need the GPU shader pass per frame to
        // apply the LUT — handing a raw u8 image to the canvas would
        // render Raw values under the "ACES" label. Detect passthrough
        // here so we skip a bogus write instead of polluting the cache
        // with shader-less bitmaps that get HIT by future displayFrame
        // calls under the new OCIO context.
        for (let i = 0; i < bitmaps.length; i++) {
          const r = bitmaps[i];
          const frameIdx = frameIndices[i];
          const framePath = paths[i];
          if (!r || !r.success || !r.bitmap || !framePath) continue;
          const w = r.width ?? 0;
          const h = r.height ?? 0;
          // For non-passthrough modes the batch's u8 → ImageBitmap output
          // is colour-incorrect. Drop the result; the next scrub or the
          // single-frame `displayFrame` path will decode it correctly via
          // the shader pipeline. We still keep the batch around for
          // passthrough modes (Raw, Linear sRGB) where the raw u8 bytes
          // ARE the final colour.
          imageBitmapCache.set({
            bitmap: r.bitmap,
            width: w,
            height: h,
            channels: [],
            layerName: layer.layerName,
            ocioMode: layer.ocioMode,
            customFingerprint: layer.customFingerprint,
            channelMode: layer.channelMode,
            frameIndex: frameIdx,
            framePath,
            decodedAt: Date.now(),
            estimatedBytes: w * h * 4,
          });
          successCount++;
        }
        const elapsed = performance.now() - tStart;
        dbg.log(
          `[_decodeAndCacheBatch] batch=${frameIndices.length} ok=${successCount} elapsed=${elapsed.toFixed(0)}ms`,
        );
    
        // Phase 7-revisit (2026-07-05, fourth arm): kick the continuous
        // RawLinearCache warmer if we're in a passthrough mode. The warmer
        // runs on its own AbortController that only aborts when the LAYER
        // or FINGERPRINT changes — not when OCIO mode changes — so it
        // survives the common Raw → ACES switch.
        //
        // Why this is its own loop instead of fire-and-forget per batch:
        //   1. The batch's AbortController is wired into the active decode
        //      signal and gets aborted by `configure()` on every OCIO
        //      switch. Using it for warmup caused the warmup to die halfway
        //      through (8/16 warmed instead of 16/16) right before the
        //      user needed the cache hit the most.
        //   2. A continuous warmer can fill the cache up to the LRU budget
        //      (~6 GB after Phase 9-restructured) without an explicit batch
        //      boundary, so the user gets a smooth ramp-up rather than
        //      16-at-a-time bursts.
        if (!signal.aborted) {
          this.kickContinuousRawLinearWarm();
        }
  }

  /**
   * Phase 7-revisit (2026-07-05, fourth arm): start (or continue)
   * the background RawLinearCache warmer. Idempotent — calling twice
   * while a warmer is already running is a no-op.
   *
   * The warmer:
   *   - Walks every frame path in the active layer.
   *   - Skips frames already in `RawLinearCache` (`rawLinearCache.has`).
   *   - Calls `pipeline.warmRawLinearCache` in concurrency-4 chunks.
   *   - Stops when:
   *     a. The warmer's own AbortController is aborted (only happens
   *        when layer or fingerprint changes — see `configure()`),
   *     b. The `RawLinearCache` is full (LRU budget exceeded),
   *     c. Every frame is warmed (cursor reached end of path list),
   *     d. `activeLayer` is cleared.
   *
   * The warmer deliberately does NOT abort when OCIO mode changes:
   * the RawLinearCache entries are OCIO-agnostic, and the user is
   * most likely to switch OCIO RIGHT NOW while wanting the warm cache.
   */
  private warmAbortController: AbortController | null = null;
  private warmRunning = false;
  kickContinuousRawLinearWarm(): void {
    if (this.warmRunning) return;
    if (!this.activeLayer) return;
    const layer = this.activeLayer;
    const slug = this.humanToSlug(layer.ocioMode);
    if (
      slug !== OCIO_MODE_SLUGS.LINEAR_SRGB &&
      slug !== OCIO_MODE_SLUGS.RAW
    ) {
      // Only worth warming for passthrough modes — non-passthrough
      // already produces HDR (F16/F32) at decode time.
      return;
    }
    this.warmRunning = true;
    this.warmAbortController = new AbortController();
    const signal = this.warmAbortController.signal;
    const pipeline = this.getGpuPipeline();
    const total = layer.framePaths.length;

    // Phase NAV-2 (2026-07-05): snapshot the sequence fingerprint at
    // the start of this warmer invocation. If `currentSequenceId`
    // changes (user navigated away → `stopAllLoops()` set it to "",
    // or user opened a different file → next `configure()` set it to
    // the new path key), bail out of the warm loop before submitting
    // more Rust `decodeExrF16` calls. Without this, the warmer kept
    // issuing FFI calls for the abandoned sequence because
    // `warmAbortController` only aborts on direct `stopAllLoops()`
    // invocation — not when a fresh `configure()` replaces it.
    const sequenceSnapshot = this.currentSequenceId;

    const run = async () => {
      const tStart = performance.now();
      let warmedTotal = 0;
      const CHUNK = 4;
      for (let i = 0; i < total; i += CHUNK) {
        if (signal.aborted) break;
        // Phase NAV-2: sequence guard. Same pattern as the U8 batch
        // loop's `sequenceSnapshot` check in `startContinuousLoad`.
        if (this.currentSequenceId !== sequenceSnapshot) {
          dbg.log(
            `[LayerCache] RawLinear warm aborted: sequence cleared/changed`,
          );
          break;
        }
        // Bail if the LRU is close to its budget — `RawLinearCache`
        // self-evicts old frames as new ones go in, but we don't want
        // to thrash if the user only ever scrolls the first 50 frames
        // and the LRU keeps evicting frame 0 to make room for 270+.
        const usage = rawLinearCache.getMemoryUsage();
        if (usage.usedMB / usage.maxMB > 0.95) {
          dbg.log(
            `[LayerCache] continuous RawLinear warm: pausing at ${usage.usedMB}MB / ${usage.maxMB}MB (budget nearly full)`,
          );
          break;
        }
        const chunk = layer.framePaths.slice(i, i + CHUNK);
        // Phase 10.1 (2026-07-13, post-ship hotfix): priority
        // claim for the warm loop too. The warmer is the
        // background filler; stealing a sync single-frame claim
        // is harmless because the sync loader will release on
        // `finally` regardless and will retry on its next
        // opportunity (which never materialises since the warm
        // result lands in `RawLinearCache`, which the sync loader
        // then hits on retry).
        const claimable = chunk.filter((p): p is string =>
          !!p && this.tryClaimFramePriority(p),
        );
        if (claimable.length === 0) {
          // Nothing to do this chunk — every path is busy
          // elsewhere. Skip without bumping the LRU budget or
          // logging an error.
          continue;
        }
        try {
          const { warmed } = await pipeline.warmRawLinearCache(
            claimable,
            layer.maxSize,
            layer.layerName,
            layer.customFingerprint,
            signal,
          );
          warmedTotal += warmed;
        } catch (err) {
          if (!signal.aborted) {
            console.warn(
              "[LayerCache] continuous RawLinear warm chunk failed (non-fatal):",
              err,
            );
          }
          for (const p of claimable) this.releaseFrame(p);
          break;
        } finally {
          // Release claims on the happy path; the catch above
          // already released before `break`, but `finally`
          // covers the await-cancelled path too.
          for (const p of claimable) this.releaseFrame(p);
        }
      }
      const elapsed = performance.now() - tStart;
      if (warmedTotal > 0 || signal.aborted) {
        dbg.log(
          `[LayerCache] continuous RawLinear warm done: warmed=${warmedTotal}/${total} elapsed=${elapsed.toFixed(0)}ms aborted=${signal.aborted}`,
        );
      }
      this.warmRunning = false;
    };
    void run();
  }

  /**
   * Phase 2 (2026-07-13): single-pass scan for the next frame that is
   * NOT yet in `ImageBitmapCache` (or any other state used by
   * `isFrameLoaded`). Returns -1 when the entire forward range is
   * loaded.
   *
   * Phase 2 deliberately drops the historical wrap-around behaviour.
   * Wrapping caused the cursor to revisit frames that had already
   * been decoded, generating redundant batch submissions and console
   * noise (`continuous batch loop bailing: ...`). Replay looping is a
   * different concern handled by the playback UI setting
   * `loopBehavior: 'wrap'` on `startContinuousLoad` — see
   * `findNextUnloadedFrameWithWrap`.
   */
  private findNextUnloadedFrame(startCursor: number): number {
    const totalFrames = this.getTotalFrames();
    for (let i = startCursor; i < totalFrames; i++) {
      if (!this.isFrameLoaded(i)) return i;
    }
    return -1;
  }

  /**
   * Phase 2 opt-in wrap variant. Only the playback loop's explicit
   * "loop" mode should call this — the default continuous preload
   * uses the no-wrap `findNextUnloadedFrame` above.
   */
  findNextUnloadedFrameWithWrap(startCursor: number): number {
    const totalFrames = this.getTotalFrames();
    for (let i = startCursor; i < totalFrames; i++) {
      if (!this.isFrameLoaded(i)) return i;
    }
    for (let i = 0; i < startCursor; i++) {
      if (!this.isFrameLoaded(i)) return i;
    }
    return -1;
  }

  /**
   * Phase 2 (2026-07-13): clamp cursor to first missing frame,
   * forward-only. Returns the input cursor when everything from
   * `cursor` onward is loaded (instead of wrapping back to 0). The
   * outer loop in `startContinuousLoad` interprets `>= totalFrames`
   * as "stop" rather than "restart from 0".
   */
  private clampCursorToFirstMissing(cursor: number): number {
    const totalFrames = this.getTotalFrames();
    for (let i = cursor; i < totalFrames; i++) {
      if (!this.isFrameLoaded(i)) return i;
    }
    return totalFrames;
  }

  stopContinuousLoad(): void {
    if (this.pendingCursorSave !== null && this.activeLayer) {
      const key = `${this.activeLayer.layerName}__${this.activeLayer.ocioMode}`;
      this.continuousCursors.set(key, this.pendingCursorSave);
    }
    if (this.continuousAbortController) {
      this.continuousAbortController.abort();
      this.continuousAbortController = null;
    }
    this.continuousLoaderRunning = false;
    this.pendingCursorSave = null;
  }

  /**
   * Phase NAV-3 (2026-07-05): stop all background decode loops on
   * Details Pane unmount, but KEEP every cache so reopening the same
   * file later resumes instantly from warm cache.
   *
   * Replaces the Phase NAV-1/NAV-2 `hardStopAll()` method, which
   * dropped `ImageBitmapCache` + `loadingPromises` on every
   * navigation. That was too aggressive: the user reported that
   * reopening the previous file forced a full re-decode from Rust
   * (~200 ms/frame cold), defeating the warm-cache design.
   *
   * This method only stops the THREE async loops that issue Rust
   * FFI calls — the work that consumes CPU and disk I/O. Caches stay.
   *
   * Called from `useContinuousLoader`'s React cleanup effect, which
   * fires when `<EXRSequencePlayer>` unmounts (i.e. user clicked
   * another file/folder in the Details Pane).
   *
   * Stops:
   *  - `continuousAbortController`     → U8 batch loop exits at next iteration
   *  - `warmAbortController`           → RawLinear warm loop exits at next chunk
   *  - `currentSequenceId` = ""        → sequence-id guard in both loops bails out
   *  - `continuousLoaderRunning`       → flag reset so `startContinuousLoad`
   *                                       can re-arm when the user reopens
   *  - `warmRunning`                   → flag reset so `kickContinuousRawLinearWarm`
   *                                       can re-arm
   *
   * Intentionally KEEPS:
   *  - `ImageBitmapCache`              → GPU bitmaps survive nav-away, ready
   *                                       for immediate re-render on reopen
   *  - `RawLinearCache` (JS, 1.5 GB)   → F16 buffers survive; on reopen,
   *                                       `warmRawLinearCache` sees them in
   *                                       `rawLinearCache.has()` and skips
   *                                       re-decode (~200 ms cold → ~0 ms warm)
   *  - Rust `EXR-CACHE-LRU`            → 32-entry LRU f32 buffers survive
   *  - `continuousCursors`             → cursor for the active layer preserved,
   *                                       so the continuous loader resumes
   *                                       from where it left off
   *  - `configuredLayers` map          → keyed by layerName; next `configure()`
   *                                       overwrites its entry
   *  - `loadingPromises`               → if any in-flight decode completes
   *                                       after unmount, its result lands in
   *                                       the cache and is ready for reopen
   *  - `decodeAbortController`         → NOT aborted. The user wants the
   *                                       Rust work to stop ASAP, but the
   *                                       cache result of any in-flight decode
   *                                       to land in `ImageBitmapCache`. If we
   *                                       abort the controller, the cache write
   *                                       at the end of `loadFrameWithBitmap`
   *                                       is skipped and warm-resume loses data.
   *                                       Trade-off: 1-2 s of CPU after nav-away
   *                                       until the in-flight batch naturally
   *                                       completes (Rust threadpool cannot be
   *                                       cancelled mid-batch without new Tauri
   *                                       commands — see plan §2 trade-off).
   *  - `activeLayer`                   → preserved so `configure()`'s
   *                                       `contextChanged` check on reopen
   *                                       returns `false` and the existing
   *                                       caches are used
   */
  stopAllLoops(): void {
    // 1. Mark sequence cleared FIRST so both the U8 batch loop and
    //    the RawLinear warm loop's mid-iteration check
    //    (sequenceSnapshot !== currentSequenceId) breaks out of its
    //    current and any subsequent iteration before more Rust FFI
    //    calls are submitted. Cheap and reliable.
    this.currentSequenceId = "";

    // 2. Abort the U8 continuous-load batch loop. Existing path used
    //    by OCIO switch — safe to reuse. After abort, the loop's
    //    `while (!signal.aborted && this.activeLayer)` exits at the
    //    next iteration.
    if (this.continuousAbortController) {
      this.continuousAbortController.abort();
      this.continuousAbortController = null;
    }
    this.continuousLoaderRunning = false;
    // NOTE: `pendingCursorSave` and `continuousCursors` are
    // intentionally NOT cleared. On reopen, `startContinuousLoad`
    // reads the saved cursor and resumes from there, so the user
    // doesn't lose the work the loader had already done.

    // 3. Abort the RawLinearCache warmer. The warmer uses its own
    //    `warmAbortController`, NOT `continuousAbortController`, so
    //    step 2 alone doesn't stop it. The warmer calls
    //    `pipeline.warmRawLinearCache(chunk, ...)` 4 frames at a time
    //    via `decodeExrF16` (Rust FFI); without an abort it keeps
    //    issuing FFI calls for the abandoned sequence — sustained
    //    ~25-30% CPU observed in production after navigating away.
    if (this.warmAbortController) {
      this.warmAbortController.abort();
      this.warmAbortController = null;
    }
    // `warmRunning` is reset by the run() closure on `signal.aborted`,
    // but resetting it here too is harmless and defensive: if any
    // caller relies on `warmRunning === false` synchronously after
    // `stopAllLoops()` (e.g. for re-arm on next mount), it won't see
    // a stale `true`.
    this.warmRunning = false;

    dbg.log('[LayerCache] stopAllLoops: continuous + warm loops aborted, caches preserved');
  }

  isContinuousLoadRunning(): boolean {
    return this.continuousLoaderRunning;
  }

  // ---- Utility ----

  getPreloadProgress(): { loaded: number; total: number; percent: number } {
    if (!this.activeLayer) return { loaded: 0, total: 0, percent: 0 };

    const totalFrames = this.getTotalFrames();
    let loadedFrames = 0;

    for (let i = 0; i < totalFrames; i++) {
      if (this.isFrameLoaded(i)) loadedFrames++;
    }

    return {
      loaded: loadedFrames,
      total: totalFrames,
      percent: totalFrames > 0 ? Math.round((loadedFrames / totalFrames) * 100) : 0
    };
  }

  /**
   * Timeline progress semantics (2026-07-11):
   *   The blue bar in `PlayerTimeline` reflects the **RawLinear warm
   *   progress**, not the OCIO-specific ImageBitmap cache.
   *
   *   Why:
   *     - `RawLinearCache` survives OCIO mode switches (its key omits
   *       `ocioMode`), so switching OCIO does NOT require re-decoding
   *       the EXR.
   *     - `ImageBitmapCache` is OCIO-specific, so as soon as the user
   *       switches modes the bitmap cache flushes and re-fills — the
   *       blue bar would visibly shrink then slowly regrow, which is
   *       confusing.
   *     - The Raw path is the authoritative decode pipeline: once the
   *       F16 buffer is warm, any subsequent OCIO mode can derive a
   *       final bitmap quickly (GPU LUT or CPU clamp).
   *
   *   So:
   *     `loaded`   = Raw F16 buffer is in `RawLinearCache`.
   *     `loading`  = a bitmap decode for the *current* OCIO mode is in
   *                  flight (cached in `loadingPromises`). This is
   *                  surfaced so the bar still animates while bitmaps
   *                  are being materialised on top of the warm F16.
   *     `pending`  = neither warm nor in flight.
   *
   *   OCIO mode switches do NOT reset `loaded` (Raw warm is preserved).
   *   Layer or fingerprint switches DO reset progress (the warmer is
   *   aborted in `configure()` and `RawLinearCache` entries are evicted).
   *   The OCIO-specific `isFrameLoaded()` remains authoritative for the
   *   actual playback pipeline (see `startContinuousLoad`/`preloadAhead`).
   */
  getFrameStatuses(): Array<{ frameIndex: number; status: 'pending' | 'loading' | 'loaded' }> {
    if (!this.activeLayer) return [];

    const totalFrames = this.getTotalFrames();
    const { layerName, framePaths, maxSize, customFingerprint, ocioMode } = this.activeLayer;

    return Array.from({ length: totalFrames }, (_, i) => {
      const loaded = rawLinearCache.has(
        layerName,
        framePaths[i],
        maxSize,
        customFingerprint,
      );
      if (loaded) {
        return { frameIndex: i, status: 'loaded' as const };
      }
      // `loadingPromises` is keyed by `(layerName, ocioMode, frameIndex)`
      // for the current OCIO-mode bitmap decode. If a bitmap decode is
      // in flight, surface it as 'loading' so the bar still moves while
      // the OCIO bitmap is being materialised against the warm F16.
      const bitmapCacheKey = `${layerName}__${ocioMode}__${i}`;
      if (this.loadingPromises.has(bitmapCacheKey)) {
        return { frameIndex: i, status: 'loading' as const };
      }
      return { frameIndex: i, status: 'pending' as const };
    });
  }

  getStats() {
    const bitmapCacheStats = imageBitmapCache.getStats();
    const bitmapCacheMem = imageBitmapCache.getMemoryUsage();

    return {
      activeLayer: this.activeLayer?.layerName || null,
      activeOcioMode: this.activeLayer?.ocioMode || null,
      totalFrames: this.getTotalFrames(),
      loadedFrames: this.getPreloadProgress().loaded,
      bitmapCache: {
        ...bitmapCacheStats,
        memory: bitmapCacheMem
      },
    };
  }

  getMemoryStats() {
    const bitmapMem = imageBitmapCache.getMemoryUsage();

    return {
      bitmapCacheMB: bitmapMem.usedMB,
      bitmapCacheMaxMB: bitmapMem.maxMB,
      totalMB: bitmapMem.usedMB
    };
  }

  // ---- OCIO helpers ----

  private humanToSlug(human: string): string {
    if (this.labelToSlugOverride) {
      const mapped = this.labelToSlugOverride[human];
      if (mapped) return mapped;
    }
    const map: Record<string, string> = {
      "Raw": OCIO_MODE_SLUGS.RAW,
      "Linear sRGB": "Linear_sRGB",
      "ACES 2.0": "ACES_1_3_CG__sRGB_Display__ACES_1_0_SDR_Video",
      "ACES 2.0 CG": "ACES_1_3_CG__sRGB_Display__ACES_1_0_SDR_Video",
      "ACES 2.0 Studio": "ACES_1_3_CG__sRGB_Display__ACES_1_0_SDR_Video",
      // 2026-07-05 (second pass): "$OCIO" now maps to the Raw
      // passthrough slug (matches the new default view).
      "$OCIO": OCIO_MODE_SLUGS.RAW,
      // 2026-07-13: Reinhard tone-mapping — synthesised by
      // `reinhardLut.ts` and applied through the same `reRenderWithLut`
      // shader path as the ACES LUTs. The user passes the slug
      // directly from `OcioModeInfo.slug`, so both the slug form
      // ("Reinhard") and any human label form resolve to the same
      // constant for idempotency.
      "Reinhard": OCIO_MODE_SLUGS.REINHARD,
    };
    return map[human] ?? human;
  }

  setLabelToSlugMap(map: Record<string, string>): void {
    this.labelToSlugOverride = map;
  }

  private labelToSlugOverride: Record<string, string> | null = null;

  // Legacy compatibility
  setActiveCustomOcioMode(_cfg: any): void { /* no-op */ }
  getActiveCustomOcioMode(): any { return null; }

  // ---- Debug ----

  debugPrint(): void {
    dbg.log('=== LayerCacheManager Debug (Phase 7: Bitmap-Only) ===');
    dbg.log(`Active layer: ${this.activeLayer?.layerName || 'none'}`);
    dbg.log(`Active OCIO mode: ${this.activeLayer?.ocioMode || 'none'}`);
    dbg.log(`Total frames: ${this.getTotalFrames()}`);
    dbg.log(`Loaded frames: ${this.getPreloadProgress().loaded}`);
    dbg.log(`Bitmap cache: ${JSON.stringify(imageBitmapCache.getStats())}`);
    dbg.log(`Memory: ${JSON.stringify(this.getMemoryStats())}`);
    dbg.log(`Continuous loader: ${this.continuousLoaderRunning ? 'RUNNING' : 'stopped'}`);
    dbg.log('=========================================================');
  }
}

// Global singleton instance
export const layerCacheManager = new LayerCacheManager();

export { LayerCacheManager };

// Phase 10 (2026-07-13): expose the singleton on `window` (dev only)
// so the debug overlay and the lessons-learned validation can inspect
// `inFlightFrameCount`. Mirrors the pattern in `ImageBitmapCache.ts`.
if (typeof window !== "undefined") {
  (window as any).__layerCacheManager = layerCacheManager;
}

// =============================================================================
// 2026-07-05: Numeric helpers for the channel-mode R/G/B/A/Y CPU swizzle.
// Kept module-local so `swizzleChannelFromRawLinear` stays readable.
// =============================================================================

/**
 * Convert one IEEE 754 binary16 (half-precision) sample to a JS number.
 * Pure JS so the hot path doesn't pull in a 3rd-party f16 lib — the loop
 * body in `swizzleChannelFromRawLinear` inlines this via the same bit
 * layout. ~30 ns per call on V8.
 */
function halfToF32(bits: number): number {
  const sign = (bits >> 15) & 0x1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) {
    if (frac === 0) return sign ? -0 : 0;
    const v = (frac / 1024) * Math.pow(2, -14);
    return sign ? -v : v;
  }
  if (exp === 31) {
    if (frac === 0) return sign ? -Infinity : Infinity;
    return NaN;
  }
  const v = (1 + frac / 1024) * Math.pow(2, exp - 15);
  return sign ? -v : v;
}

/** Clamp a float to [0, 1] and quantise to an 8-bit unsigned byte. */
function clamp01ToByte(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  return (v * 255) | 0;
}
