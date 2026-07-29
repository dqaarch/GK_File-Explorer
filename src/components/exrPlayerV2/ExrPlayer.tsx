/**
 * EXRPlayer V2 — Main Component
 * 
 * Full EXR player with all features from the original EXRSequencePlayer.
 * Uses the new simplified architecture.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { getExrMetadata } from "../../TauriFileSystem";
import { subscribeFingerprint } from "../../hooks/fingerprintStore";
import { layerCacheManager } from "../../utils/exrCache";
import { detectHdriFile } from "../../utils/exrCache/hdriDetector";
import { loadHdriFrame } from "../../utils/exrCache/hdriPipeline";
import { dbg } from "../../utils/debug";
import {
  availableChannelModes,
  autoSelectBestLayer,
  inferChannelMode,
} from "../../utils/exrCache/layerPriority";
import { MAX_NATIVE_RESOLUTION } from "./constants";
import {
  getExrCacheSettings,
  subscribeToExrCacheSettings,
  updateExrCacheSettings,
} from "../../stores/exrCacheSettings";
import { useExrState } from "./useExrState";
import { usePlayback } from "./usePlayback";
import { useDecode } from "./useDecode";
import { useKeyboard } from "./useKeyboard";
import { useWheelZoom } from "./useWheelZoom";
import { useEyedropper } from "./useEyedropper";
import { useDominantColors } from "./useDominantColors";
import { useOcioConfig, OCIO_RAW_SLUG } from "./useOcioConfig";
import { ExrHeader } from "./ExrHeader";
import { ExrViewport } from "./ExrViewport";
import { ExrTransport } from "./ExrTransport";
import { ExrTimeline } from "./ExrTimeline";
import { ColorPickerPanel } from "./ColorPickerPanel";
import type { ExrPlayerProps, ChannelMode } from "./types";

export default function ExrPlayer({
  fileName,
  filePath,
  mediaInfo,
  accentColor = "#f97316",
  fileFingerprint,
  language = "en",
  theme = "dark",
}: ExrPlayerProps) {
  const effectiveMaxFrames = mediaInfo?.paths?.length || 0;

  const state = useExrState({
    fileName,
    filePath,
    mediaInfo,
    fileFingerprint,
  });

  // OCIO owns the "what colourspace are we displaying" decision.
  // The slug is what the decode pipeline and the renderer consume;
  // `allViews` powers the dropdown in `ExrHeader`. Default = Raw
  // passthrough (matches V1).
  const ocio = useOcioConfig();
  const [ocioSlug, setOcioSlug] = useState<string>(ocio.slug);
  // Mirror for async / effect handlers that need to read the latest
  // slug without subscribing to a re-render. The previous code
  // tripped React's "Maximum update depth" by writing to
  // `setOcioSlug` from inside an effect — keeping the ref is cheap
  // insurance against that regression.
  const ocioSlugRef = useRef<string>(ocioSlug);
  ocioSlugRef.current = ocioSlug;
  const [metadataLoaded, setMetadataLoaded] = useState(false);
  const [bgEnabled, setBgEnabled] = useState(() => getExrCacheSettings().exrPlayerBgColorEnabled);
  const [bgColor, setBgColor] = useState(() => getExrCacheSettings().exrPlayerBgColor);
  // 2026-07-14: HDRI capture mode flag. When true, the player routes
  // through hdrify + Reinhard E1 (`hdriPipeline.ts`) instead of the
  // Rust OpenEXR FFI + OCIO/ACES/LUT path. The flag is independent of
  // `ocioSlug` so existing render-engine EXR behaviour is untouched.
  const [isHdriMode, setIsHdriMode] = useState(false);
  // Tracks the file path the current HDRI detection was run against
  // so we don't re-run detection (a 2-3s hdrify decode) every render.
  const hdriDetectedPathRef = useRef<string | null>(null);
  // Tracks the hex that was just copied to the clipboard so we can
  // swap the eyedropper tooltip for a "Copied!" pill for ~1.5s,
  // matching the feedback style in `VideoPlayerPreview.tsx`.
  const [copiedHex, setCopiedHex] = useState<string | null>(null);

  const { displayFrame } = useDecode({ state, ocioSlug });
  usePlayback({
    state,
    effectiveMaxFrames,
    displayFrame,
  });
  useKeyboard({ state, effectiveMaxFrames });
  useWheelZoom({ state });
  const eyedropper = useEyedropper({ state });
  const extractColors = useDominantColors({ state });

  useEffect(() => {
    const unsub = subscribeToExrCacheSettings((s) => {
      setBgEnabled(s.exrPlayerBgColorEnabled);
      setBgColor(s.exrPlayerBgColor);
    });
    return unsub;
  }, []);

  const handleToggleBg = useCallback(() => {
    const next = !getExrCacheSettings().exrPlayerBgColorEnabled;
    updateExrCacheSettings({ exrPlayerBgColorEnabled: next });
  }, []);

  const handleChangeBgColor = useCallback((color: string) => {
    updateExrCacheSettings({ exrPlayerBgColor: color });
  }, []);

  useEffect(() => {
    if (metadataLoaded) return;

    let cancelled = false;
    const loadMetadata = async () => {
      if (!mediaInfo?.paths?.length) return;
      try {
        const metaResult = await getExrMetadata(mediaInfo.paths[0]);
        if (cancelled) return;
        if (metaResult.success) {
          const regularLayers: string[] =
            metaResult.layer_names?.map((l: { name: string }) => l.name) || [];
          const cryptoLayers: string[] = metaResult.cryptomatte_layers || [];
          const mergedLayers = [...regularLayers, ...cryptoLayers];
          state.setAllLayers(mergedLayers);

          const map: Record<string, string[]> = {};
          for (const l of metaResult.layer_names || []) {
            map[l.name] = l.channels || [];
          }
          for (const l of cryptoLayers) {
            if (!map[l]) map[l] = ["R", "G", "B", "A"];
          }
          state.layersByNameRef.current = map;

          if (mergedLayers.length > 0) {
            let bestLayer = autoSelectBestLayer(metaResult.layer_names || []);
            if (!bestLayer) bestLayer = "rgba";
            state.setSelectedLayer(bestLayer);
            const layerChans = state.layersByNameRef.current[bestLayer] || [];
            const auto = inferChannelMode(bestLayer, layerChans);
            state.setChannelMode(auto);
            state.channelModeRef.current = auto;
          }
          setMetadataLoaded(true);
        }
      } catch (err) {
        console.error("[EXR] Failed to load metadata:", err);
      }
    };

    loadMetadata();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaInfo?.paths?.join("|"), metadataLoaded]);

  // ── HDRI detection (2026-07-14) ──────────────────────────────────────
  // Runs once per file-path change after metadata is loaded. Detection
  // is a single hdrify `readExr()` decode (~1-3s for 4K HDRIs) so we
  // gate it on filePath + metadataLoaded and only fire when the file
  // actually changed. If the file is an HDRI capture we route through
  // `loadHdriFrame()` (pure-JS, no Rust IPC, no OCIO). Otherwise we
  // fall back to the render-engine pipeline below.
  useEffect(() => {
    if (!filePath || !metadataLoaded) return;
    if (hdriDetectedPathRef.current === filePath) return;

    // 2026-07-14: Bypass HDRI detection for EXR sequences. HDRI
    // captures are always single-frame (.hdr / a single .exr from a
    // camera or scene capture); render-engine EXRs ship as
    // multi-frame sequences (RndAnim_0000.exr, ...). Running
    // `detectHdriFile()` on a sequence's first frame wastes 1-3s
    // AND races with `startContinuousLoad`'s U8 batch — both paths
    // end up decoding the same file concurrently, blowing cold-load
    // time from ~600 ms to ~27 s (observed on RndAnim_0000.exr
    // 1920×1080: hdrify + Rust batch collided, single-frame FFI
    // took 26999 ms vs the typical 600 ms). Sequence files should
    // always go through the render-engine Rust + OCIO pipeline.
    if (mediaInfo && mediaInfo.paths.length > 1) {
      dbg.log(
        `[ExrPlayerV2] HDRI detection SKIP (sequence: ${mediaInfo.paths.length} frames)`,
      );
      hdriDetectedPathRef.current = filePath;
      setIsHdriMode(false);
      return;
    }

    let cancelled = false;
    hdriDetectedPathRef.current = filePath;
    state.setIsLoading(true);

    detectHdriFile(filePath)
      .then(async (result) => {
        if (cancelled) return;
        setIsHdriMode(result.isHdri);

        if (!result.isHdri) {
          // Render-engine EXR — let the configure-effect below handle
          // it through the standard Rust + OCIO pipeline.
          return;
        }

        // HDRI path: decode + Reinhard E1 + createImageBitmap, then
        // install directly onto the canvas (skipping `displayFrame`
        // which would route through `layerCacheManager`).
        dbg.log(`[ExrPlayerV2] HDRI mode active: ${result.reason}`);
        const loaded = await loadHdriFrame(filePath, "reinhard", 1.0);
        if (cancelled || !loaded) {
          if (!cancelled) state.setIsLoading(false);
          return;
        }
        state.setImageBitmap(loaded.bitmap);
        state.setMetadata({ channels: ["R", "G", "B"] });
        state.setIsLoading(false);
        state.setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        dbg.log(`[ExrPlayerV2] HDRI detection failed: ${err}`);
        setIsHdriMode(false);
        state.setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, metadataLoaded]);

  // Reset HDRI detection cache when the file path changes so the next
  // file gets re-classified (a render-engine EXR followed by an HDRI
  // capture would otherwise reuse the previous `false` result).
  useEffect(() => {
    hdriDetectedPathRef.current = null;
    setIsHdriMode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  const PLACEHOLDER_FINGERPRINT = "0-0";
  const lastSeenFingerprintRef = useRef<string | undefined>(fileFingerprint);

  useEffect(() => {
    if (!filePath || !fileFingerprint) return;
    if (lastSeenFingerprintRef.current === fileFingerprint) return;

    const prev = lastSeenFingerprintRef.current;
    const prevIsPlaceholder = !prev || prev === PLACEHOLDER_FINGERPRINT;
    const newIsPlaceholder = fileFingerprint === PLACEHOLDER_FINGERPRINT;

    if (prevIsPlaceholder && !newIsPlaceholder) {
      lastSeenFingerprintRef.current = fileFingerprint;
      return;
    }

    state.decodeGenerationRef.current += 1;
    layerCacheManager.clearCache();
    // Phase 3 (2026-07-13): setOcioSlug("Raw") used to live here, but
    // it triggered "Maximum update depth exceeded" — every effect run
    // re-queued a React render, the `[..., ocioSlug]` configure-effect
    // re-fired, re-decode, re-set, infinite loop. Reset via ref so the
    // next render reads the new slug without re-scheduling a render.
    ocioSlugRef.current = OCIO_RAW_SLUG;
    setOcioSlug(OCIO_RAW_SLUG);
    lastSeenFingerprintRef.current = fileFingerprint;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, fileFingerprint]);

  useEffect(() => {
    const unsubscribe = subscribeFingerprint((changedPath) => {
      const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
      const normalizedChanged = normalize(changedPath);
      const isPartOfSequence = mediaInfo?.paths?.some(
        (fp: string) => normalize(fp) === normalizedChanged,
      );
      if (isPartOfSequence) {
        state.decodeGenerationRef.current += 1;
        layerCacheManager.clearCache();
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaInfo?.paths?.join("|")]);

  useEffect(() => {
    // 2026-07-14: replaced the verbose `configure-effect FIRE deps=[...]
    // meta=false ocio=Raw` log (fired twice — once for meta=false, then
    // again for meta=true) with a single line that only emits once
    // metadata is actually loaded. The earlier "meta=false" trace was
    // pure noise: it just announced that the effect ran with
    // insufficient state and then immediately returned.
    if (!mediaInfo?.paths?.length || !state.selectedLayerRef.current || !metadataLoaded) {
      return;
    }
    // 2026-07-14: HDRI capture files bypass the Rust + OCIO pipeline
    // entirely. The HDRI detector effect above handles `displayFrame`
    // for those — running `layerCacheManager.configure()` here would
    // schedule a Rust decode that competes with hdrify and produces a
    // wrong-colour bitmap when the file IS an HDRI but detection
    // hasn't returned yet (race). Skip until detection completes.
    if (isHdriMode) {
      dbg.log(`[ExrPlayerV2] configure-effect SKIP (HDRI mode)`);
      return;
    }

    const size = MAX_NATIVE_RESOLUTION;
    const selectedLayer = state.selectedLayerRef.current;
    const channelMode = state.channelModeRef.current || "RGB";
    // Phase 3 (2026-07-13): customFingerprint MUST come from
    // state.fileFingerprintRef (which mirrors the prop). Without it,
    // two different EXR files that share a layer name + path layout
    // collapse to the same cache key and the player surfaces another
    // file's bitmap when the user toggles layers / channels.
    // Defensive `?.` for HMR / older builds where the ref hadn't been
    // added to ExrState yet.
    const customFingerprint = state.fileFingerprintRef?.current || "";
    layerCacheManager.configure(
      selectedLayer,
      mediaInfo.paths,
      ocioSlug,
      size,
      channelMode,
      customFingerprint,
    );

    const pathsKey = mediaInfo.paths.join("|");
    if (pathsKey !== state.firstLoadPathsKeyRef.current) {
      dbg.log(`[ExrPlayerV2] first-load for new paths, starting display+continuous`);
      state.firstLoadPathsKeyRef.current = pathsKey;
      state.isFirstLoadRef.current = false;
      displayFrame(0, channelMode);
      // Phase 2 (2026-07-13, ported from old EXRSequencePlayer):
      // the AALab-style continuous fill is only useful for sequence
      // playback — single EXR has exactly one frame, the loop would
      // run exactly once and then sit idle, but `configure()` and
      // `displayFrame(0)` already populate the bitmap. Skip it.
      if (mediaInfo.paths.length > 1) {
        // Dedup: `state.tickRef.current` increments every render; if a
        // sibling effect already started a loader in the same commit
        // pass the two effects would otherwise race.
        if (state.lastContinuousStartTickRef.current !== state.tickRef.current) {
          state.lastContinuousStartTickRef.current = state.tickRef.current;
          layerCacheManager.startContinuousLoad(
            (_frameIndex, _total) => {
              const progress = layerCacheManager.getPreloadProgress();
              state.bufferLoadedRef.current = progress.loaded;
              state.setBufferLoaded(progress.loaded);
              state.setFrameStatuses(layerCacheManager.getFrameStatuses());
            },
            16,
            0,
          );
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaInfo?.paths?.join("|"), metadataLoaded, ocioSlug]);

  const handleLayerChange = useCallback(
    (newLayer: string) => {
      // 2026-07-14: HDRI captures are single-layer RGBA — there's no
      // layer picker to honour. Skip the Rust pipeline entirely.
      if (isHdriMode) {
        state.setSelectedLayer(newLayer);
        return;
      }
      state.setSelectedLayer(newLayer);
      const layerChans = state.layersByNameRef.current[newLayer] || [];
      const auto = inferChannelMode(newLayer, layerChans);
      state.setChannelMode(auto);
      state.channelModeRef.current = auto;

      const size = MAX_NATIVE_RESOLUTION;
      state.clearImageBitmap();
      const customFingerprint = state.fileFingerprintRef?.current || "";
      layerCacheManager.configure(newLayer, mediaInfo?.paths || [], ocioSlug, size, auto, customFingerprint);
      displayFrame(state.currentFrameRef.current, auto);
      layerCacheManager.preloadAhead(state.currentFrameRef.current, 5);
    },
    [state, mediaInfo, displayFrame, ocioSlug, isHdriMode],
  );

  const handleChannelChange = useCallback(
    async (channel: ChannelMode) => {
      // 2026-07-14: HDRI captures are RGB only (no per-channel
      // selector); the picker is still rendered but is a no-op.
      if (isHdriMode) {
        state.setChannelMode(channel);
        state.channelModeRef.current = channel;
        return;
      }
      state.setChannelMode(channel);
      state.channelModeRef.current = channel;

      const size = MAX_NATIVE_RESOLUTION;
      state.clearImageBitmap();
      const customFingerprint = state.fileFingerprintRef?.current || "";
      layerCacheManager.configure(
        state.selectedLayerRef.current || "",
        mediaInfo?.paths || [],
        ocioSlug,
        size,
        channel,
        customFingerprint,
      );
      displayFrame(state.currentFrameRef.current, channel);
      if (channel === "RGB") {
        layerCacheManager.preloadAhead(state.currentFrameRef.current, 5);
      }
    },
    [state, mediaInfo, displayFrame, ocioSlug, isHdriMode],
  );

  // ── OCIO switch effect ──────────────────────────────────────────────────
  // Mirrors V1's "OCIO mode switch" effect (see `EXRSequencePlayer.tsx`
  // in the .bak for reference). The configure-effect above handles
  // first-load + layer/channel changes; this dedicated effect handles
  // slug-only flips so a Raw → ACES swap re-renders the current frame
  // through `LayerCacheManager.configure(slug)` →
  // `exrGpuPipeline.reRenderWithLut`. Without it the bitmap cache key
  // updates but the canvas keeps the previous slug's pixels and the
  // LUT never appears to apply.
  //
  // We use an "initial settle" ref guard so the first fire (mount
  // with a populated OCIO group list) doesn't redundantly re-decode
  // what the configure-effect already kicked off — same pattern V1
  // used via `initialOcioSettledRef`.
  const initialOcioSettledRef = useRef(false);
  useEffect(() => {
    if (!mediaInfo?.paths?.length || !state.selectedLayerRef.current || !metadataLoaded) {
      return;
    }
    // 2026-07-14: HDRI mode bypasses the OCIO switch entirely — the
    // hdrify + Reinhard path is the only thing rendered for HDRI
    // captures, so slug changes have nothing to re-render against.
    if (isHdriMode) return;

    if (!initialOcioSettledRef.current) {
      initialOcioSettledRef.current = true;
      // First fire: just make sure the active layer is configured with
      // the current slug; the configure-effect already started the
      // first decode.
      const size = MAX_NATIVE_RESOLUTION;
      const customFingerprint = state.fileFingerprintRef?.current || "";
      layerCacheManager.configure(
        state.selectedLayerRef.current,
        mediaInfo.paths,
        ocioSlug,
        size,
        state.channelModeRef.current || "RGB",
        customFingerprint,
      );
      return;
    }

    dbg.log(`[ExrPlayerV2] OCIO switch FIRE slug=${ocioSlug}`);
    layerCacheManager.stopContinuousLoad();
    state.decodeGenerationRef.current += 1;
    state.clearImageBitmap();
    const size = MAX_NATIVE_RESOLUTION;
    const customFingerprint = state.fileFingerprintRef?.current || "";
    layerCacheManager.configure(
      state.selectedLayerRef.current,
      mediaInfo.paths,
      ocioSlug,
      size,
      state.channelModeRef.current || "RGB",
      customFingerprint,
    );
    // Re-display the current frame with the new slug. The bitmap cache
    // was flushed inside `configure()` for the OCIO-only change, so
    // this triggers a fresh decode that takes the raw-linear → LUT
    // pipeline (for non-passthrough slugs).
    displayFrame(state.currentFrameRef.current);
    if (mediaInfo.paths.length > 1) {
      if (state.lastContinuousStartTickRef.current !== state.tickRef.current) {
        state.lastContinuousStartTickRef.current = state.tickRef.current;
        layerCacheManager.startContinuousLoad(
          (_frameIndex, _total) => {
            const progress = layerCacheManager.getPreloadProgress();
            state.bufferLoadedRef.current = progress.loaded;
            state.setBufferLoaded(progress.loaded);
            state.setFrameStatuses(layerCacheManager.getFrameStatuses());
          },
          16,
          0,
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocioSlug, metadataLoaded]);

  // ── Raw-linear warm progress poller (V1 parity, 2026-07-13) ─────────────
  // The `RawLinearCache` warmer fills F16 buffers in the background
  // without touching React state. In passthrough mode the bitmap
  // decode callback (above) refreshes `frameStatuses` frequently so
  // the timeline bar tracks progress on its own. In non-passthrough
  // modes (ACES + custom LUTs) the bitmap decode path is skipped —
  // V1's `LayerCacheManager.startContinuousLoad` returns immediately
  // and only `kickContinuousRawLinearWarm` fills in the background.
  // The only way to surface that progress to the UI is to poll
  // `getFrameStatuses()` ourselves every 250 ms. The poll is cheap
  // (it reads the LRU map + an index lookup) and stops itself when
  // the active OCIO slug / paths / layer change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!mediaInfo?.paths?.length) return;
    if (!state.selectedLayerRef.current) return;

    const POLL_MS = 250;
    const timer = window.setInterval(() => {
      // Snapshot current FrameStatuses; React will skip the rerender
      // when the array reference + contents haven't changed (the
      // hook below uses a length === prev.length + element-wise
      // equality check implicitly via React's bailout for hooks).
      const statuses = layerCacheManager.getFrameStatuses();
      const totalLoaded = statuses.filter((s) => s.status === "loaded").length;
      const prev = state.bufferLoadedRef.current ?? 0;
      if (totalLoaded !== prev) {
        state.bufferLoadedRef.current = totalLoaded;
        state.setBufferLoaded(totalLoaded);
      }
      state.setFrameStatuses(statuses);
    }, POLL_MS);
    return () => window.clearInterval(timer);
    // Re-arm when slug / paths / layer changes. The OCR `state` ref
    // gives the `selectedLayerRef` check a fresh read each tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocioSlug, mediaInfo?.paths?.join("|"), state.selectedLayerRef.current]);

  useEffect(() => {
    dbg.log(`[ExrPlayerV2] filePath effect FIRE filePath=${filePath}`);
    state.setCurrentFrame(0);
    state.setIsPlaying(false);
    setMetadataLoaded(false);
    state.decodeGenerationRef.current += 1;
    state.clearImageBitmap();
    // Stop only the U8 batch loop here — `stopAllLoops()` (used in
    // the unmount hook below) is intentionally NOT called because
    // the next file's `configure()` flow will do its own setup
    // without us nuking the warm state. We do want the same-loop
    // drop, however, so the old batch doesn't keep firing while the
    // new file's metadata loads.
    layerCacheManager.stopContinuousLoad();
    state.isFirstLoadRef.current = true;
    state.firstLoadPathsKeyRef.current = "";
    // Force the OCIO switch effect to take the "initial settle" branch
    // again on the next file — without this, a slug picked in the
    // previous file's session would skip the early return and double
    // re-decode the new file's first frame.
    initialOcioSettledRef.current = false;
    return () => {
      layerCacheManager.stopContinuousLoad();
      state.decodeGenerationRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // ── Stop warm loops on unmount (NAV-3 parity, 2026-07-13) ──────────────
  // When the user navigates away from the EXR player (clicks another
  // folder/file in the Details Pane → parent unmounts this component
  // via `key={filePath}`), the U8 batch and the RawLinear warm loops
  // are still spinning in the Rust thread pool. Without this hook they
  // keep issuing FFI calls for the abandoned sequence and the user
  // sees sustained CPU usage in the background. `stopAllLoops()`
  // aborts both loops while preserving `ImageBitmapCache`,
  // `RawLinearCache`, `continuousCursors`, and `configuredLayers` —
  // so navigating back to the same file reuses the warm data
  // instead of paying a cold re-decode.
  useEffect(() => {
    return () => {
      layerCacheManager.stopAllLoops();
    };
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        state.setIsPanning(true);
        state.panRef.current = {
          isDragging: true,
          startX: e.clientX,
          startY: e.clientY,
          offsetX: state.panOffset.x,
          offsetY: state.panOffset.y,
        };
      }
    },
    [state],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (state.isPanning && state.panRef.current.isDragging) {
        const dx = e.clientX - state.panRef.current.startX;
        const dy = e.clientY - state.panRef.current.startY;
        state.setPanOffset({
          x: state.panRef.current.offsetX + dx,
          y: state.panRef.current.offsetY + dy,
        });
      }
      eyedropper.sample(e);
    },
    [state, eyedropper],
  );

  const handleMouseUp = useCallback(() => {
    if (state.panRef.current.isDragging) {
      state.panRef.current.isDragging = false;
    }
  }, [state]);

  useEffect(() => {
    const stopPan = () => {
      if (state.isPanning) {
        state.setIsPanning(false);
        state.panRef.current.isDragging = false;
      }
    };
    window.addEventListener("mouseup", stopPan);
    window.addEventListener("contextmenu", stopPan);
    return () => {
      window.removeEventListener("mouseup", stopPan);
      window.removeEventListener("contextmenu", stopPan);
    };
  }, [state.isPanning, state.setIsPanning, state.panRef]);

  const onZoomOut = useCallback(() => {
    state.setZoom((z) =>
      z === "Fit" ? 1 : Math.max(0.1, (typeof z === "number" ? z : 1) - 0.25),
    );
  }, [state.setZoom]);

  const onZoomIn = useCallback(() => {
    state.setZoom((z) => Math.min(10, (z === "Fit" ? 1 : z) + 0.25));
  }, [state.setZoom]);

  const onResetView = useCallback(() => {
    state.setZoom("Fit");
    state.setPanOffset({ x: 0, y: 0 });
  }, [state.setZoom, state.setPanOffset]);

  const onViewportClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("button") && !target.closest("select") && !target.closest("input")) {
        if (state.isEyedropperActive) {
          // Eyedropper mode: click commits the currently-hovered
          // pixel and copies its hex to the clipboard. The hovered
          // sample is in `state.eyedropperColor` (kept live by
          // `useEyedropper` on mousemove); if the user clicks without
          // ever moving the mouse we fall back to no-op.
          const color = state.eyedropperColor;
          if (color) {
            navigator.clipboard.writeText(color.hex).then(() => {
              setCopiedHex(color.hex);
              window.setTimeout(() => {
                setCopiedHex((curr) => (curr === color.hex ? null : curr));
              }, 1500);
            }).catch(() => {});
          }
          return;
        }
        if (effectiveMaxFrames > 1) {
          state.setIsPlaying(!state.isPlaying);
        }
      }
    },
    [
      effectiveMaxFrames,
      state.isPlaying,
      state.setIsPlaying,
      state.isEyedropperActive,
      state.eyedropperColor,
    ],
  );

  const channelModes = React.useMemo<ChannelMode[]>(
    () =>
      availableChannelModes(
        state.selectedLayer,
        state.layersByNameRef.current[state.selectedLayer || ""] || [],
        state.layerChannelsRef.current[state.selectedLayer || ""] || [],
      ),
    [state.selectedLayer],
  );

  const wrapperClasses = state.isFocusView
    ? `fixed inset-0 z-[500] shadow-2xl overflow-hidden flex flex-col bg-[var(--header-bg)] text-stone-300`
    : `w-full h-full flex flex-col relative bg-[var(--header-bg)] text-stone-300`;

  return (
    <div ref={state.containerRef} className={wrapperClasses}>
      <canvas ref={state.colorPickerCanvasRef} style={{ display: "none" }} />

      <ExrHeader
        fileName={fileName}
        mediaInfoBaseName={mediaInfo?.baseName}
        mediaInfoExt={mediaInfo?.ext}
        effectiveMaxFrames={effectiveMaxFrames}
        bufferLoaded={state.bufferLoaded}
        isPlaying={state.isPlaying}
        allLayers={state.allLayers}
        selectedLayer={state.selectedLayer}
        onLayerChange={handleLayerChange}
        channelModes={channelModes}
        activeChannelMode={state.channelMode}
        onChannelChange={handleChannelChange}
        isLoading={state.isLoading}
        metadata={state.metadata}
        playbackFps={state.playbackFps}
        accentColor={accentColor}
        bgEnabled={bgEnabled}
        bgColor={bgColor}
        onToggleBg={handleToggleBg}
        onChangeBgColor={handleChangeBgColor}
        language={language}
        theme={theme}
        isHdriMode={isHdriMode}
      />

      <ExrViewport
        canvasRef={state.imageCanvasRef}
        isLoading={state.isLoading}
        error={state.error}
        hasBitmap={!!state.imageBitmap}
        currentFrame={state.currentFrame}
        effectiveMaxFrames={effectiveMaxFrames}
        selectedLayer={state.selectedLayer}
        fileName={fileName}
        accentColor={accentColor}
        zoom={state.zoom}
        panOffset={state.panOffset}
        isEyedropperActive={state.isEyedropperActive}
        bgEnabled={bgEnabled}
        bgColor={bgColor}
        onViewportClick={onViewportClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={eyedropper.clear}
      />

      <ExrTransport
        effectiveMaxFrames={effectiveMaxFrames}
        isPlaying={state.isPlaying}
        isLooping={state.isLooping}
        playbackFps={state.playbackFps}
        onPlaybackFpsChange={state.setPlaybackFps}
        onPrevFrame={() => {
          state.setIsPlaying(false);
          state.setCurrentFrame((f) => Math.max(0, f - 1));
        }}
        onNextFrame={() => {
          state.setIsPlaying(false);
          state.setCurrentFrame((f) => Math.min(effectiveMaxFrames - 1, f + 1));
        }}
        onJumpBack={() => {
          state.setIsPlaying(false);
          state.setCurrentFrame((f) => Math.max(0, f - state.playbackFps));
        }}
        onJumpForward={() => {
          state.setIsPlaying(false);
          state.setCurrentFrame((f) => Math.min(effectiveMaxFrames - 1, f + state.playbackFps));
        }}
        onTogglePlay={() => state.setIsPlaying((p) => !p)}
        onToggleLoop={() => state.setIsLooping((p) => !p)}
        zoom={state.zoom}
        showZoomMenu={state.showZoomMenu}
        onToggleZoomMenu={() => state.setShowZoomMenu((p) => !p)}
        onZoomOut={onZoomOut}
        onZoomIn={onZoomIn}
        onPickZoom={(v) => {
          state.setZoom(v);
          state.setShowZoomMenu(false);
          if (v === "Fit") state.setPanOffset({ x: 0, y: 0 });
        }}
        onResetView={onResetView}
        showColorPicker={state.showColorPicker}
        isEyedropperActive={state.isEyedropperActive}
        isFocusView={state.isFocusView}
        onToggleColorPicker={() => {
          state.setShowColorPicker((p) => !p);
          if (!state.showColorPicker) extractColors();
        }}
        onToggleEyedropper={() => state.setIsEyedropperActive((p) => !p)}
        onToggleFocusView={() => state.setIsFocusView((p) => !p)}
        onFullscreen={() => {
          if (!document.fullscreenElement) {
            state.containerRef.current?.requestFullscreen().catch(() => {});
          } else {
            document.exitFullscreen();
          }
        }}
        accentColor={accentColor}
        ocioSlug={ocioSlug}
        ocioViews={ocio.allViews}
        onOcioChange={(slug) => {
          if (isHdriMode) return;
          setOcioSlug(slug);
        }}
        isHdriMode={isHdriMode}
        hdriReason={isHdriMode ? "HDRI capture (hdrify + Reinhard E1)" : undefined}
      />

      {effectiveMaxFrames > 1 && (
        <ExrTimeline
          effectiveMaxFrames={effectiveMaxFrames}
          currentFrame={state.currentFrame}
          frameStatuses={state.frameStatuses}
          accentColor={accentColor}
          onScrub={(f) => {
            state.setCurrentFrame(f);
            state.setIsPlaying(false);
          }}
        />
      )}

      {state.showColorPicker && state.dominantColors.length > 0 && (
        <ColorPickerPanel
          colors={state.dominantColors}
          accentColor={accentColor}
        />
      )}

      {state.isEyedropperActive && state.eyedropperColor && (
        <div
          className="absolute top-16 left-4 z-50 pointer-events-none border shadow-2xl rounded overflow-hidden flex flex-col p-2"
          style={{ backgroundColor: "var(--row-bg)", borderColor: "var(--stroke-1)" }}
        >
          <div className="flex gap-2 items-center">
            <div
              className="w-8 h-8 rounded border"
              style={{ backgroundColor: state.eyedropperColor.hex, borderColor: "var(--stroke-1)" }}
            />
            <div className="flex flex-col w-20 relative">
              {copiedHex === state.eyedropperColor.hex ? (
                <span
                  className="font-mono text-[10px] font-bold px-1 rounded inline-block w-fit"
                  style={{ color: accentColor, backgroundColor: `${accentColor}20` }}
                >
                  Copied!
                </span>
              ) : (
                <span className="font-mono text-[10px]" style={{ color: accentColor }}>
                  {state.eyedropperColor.hex}
                </span>
              )}
              <span className="font-mono text-[9px]" style={{ color: "var(--fg-2)" }}>
                {state.eyedropperColor.rgb}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
