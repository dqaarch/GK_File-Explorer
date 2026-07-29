/**
 * EXRPlayer V2 — Core Orchestrator
 * 
 * Simplified architecture replacing the 3 concurrent decode paths:
 * 1. Single DecodeTaskQueue for all decode requests
 * 2. Reuses existing LayerCacheManager for Rust IPC
 * 3. UnifiedCache for bitmap storage
 * 
 * This is the foundation - UI components will be added separately.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { getExrMetadata } from "../../TauriFileSystem";
import { subscribeFingerprint } from "../../hooks/fingerprintStore";
import { layerCacheManager } from "../../utils/exrCache";
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
import type { ExrPlayerProps, ChannelMode } from "./types";

export function ExrPlayerCore(props: ExrPlayerProps) {
  const {
    fileName,
    filePath,
    mediaInfo,
    accentColor = "#f97316",
    fileFingerprint,
    language = "en",
    theme = "dark",
  } = props;

  const effectiveMaxFrames = mediaInfo?.paths?.length || 0;

  const state = useExrState({
    fileName,
    filePath,
    mediaInfo,
    fileFingerprint,
  });

  const [ocioSlug, setOcioSlug] = useState("Raw");
  const [ocioGroups, setOcioGroups] = useState<string[]>([]);

  const { displayFrame } = useDecode({ state, ocioSlug });
  usePlayback({
    state,
    effectiveMaxFrames,
    displayFrame,
  });

  useKeyboard({ state, effectiveMaxFrames });
  useWheelZoom({ state });
  useStopWarmOnUnmount();

  const [metadataLoaded, setMetadataLoaded] = useState(false);

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
    return () => {
      cancelled = true;
    };
  }, [mediaInfo?.paths?.join("|"), metadataLoaded]);

  const PLACEHOLDER_FINGERPRINT = "0-0";
  const lastSeenFingerprintRef = useRef<string | undefined>(fileFingerprint);

  useEffect(() => {
    if (!filePath) return;
    if (!fileFingerprint) return;
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
    setOcioSlug("Raw");
    lastSeenFingerprintRef.current = fileFingerprint;
  }, [filePath, fileFingerprint, state.decodeGenerationRef]);

  useEffect(() => {
    const unsubscribe = subscribeFingerprint((changedPath) => {
      const normalize = (p: string) =>
        p.replace(/\\/g, "/").replace(/\/+$/, "");
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
  }, [mediaInfo, state.decodeGenerationRef]);

  useEffect(() => {
    if (
      !mediaInfo?.paths?.length ||
      !state.selectedLayerRef.current ||
      !metadataLoaded
    ) {
      return;
    }

    const size = MAX_NATIVE_RESOLUTION;
    layerCacheManager.configure(
      state.selectedLayerRef.current,
      mediaInfo.paths,
      ocioSlug,
      size,
      state.channelModeRef.current || "RGB",
      "",
    );

    const pathsKey = (mediaInfo?.paths ?? []).join("|");
    const isFirstLoadForPaths = pathsKey !== state.firstLoadPathsKeyRef.current;
    if (isFirstLoadForPaths) {
      state.firstLoadPathsKeyRef.current = pathsKey;
      state.isFirstLoadRef.current = false;
      displayFrame(0);
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
  }, [mediaInfo?.paths?.join("|"), metadataLoaded, ocioSlug]);

  const handleLayerChange = useCallback(
    (newLayer: string) => {
      state.setSelectedLayer(newLayer);
      const layerChans = state.layersByNameRef.current[newLayer] || [];
      const auto = inferChannelMode(newLayer, layerChans);
      state.setChannelMode(auto);
      state.channelModeRef.current = auto;

      const size = MAX_NATIVE_RESOLUTION;
      state.clearImageBitmap();
      layerCacheManager.configure(
        newLayer,
        mediaInfo?.paths || [],
        ocioSlug,
        size,
        auto,
      );
      displayFrame(state.currentFrameRef.current, auto);
      layerCacheManager.preloadAhead(state.currentFrameRef.current, 5);
    },
    [state, mediaInfo, displayFrame, ocioSlug],
  );

  const handleChannelChange = useCallback(
    async (channel: ChannelMode) => {
      state.setChannelMode(channel);
      state.channelModeRef.current = channel;

      const size = MAX_NATIVE_RESOLUTION;
      state.clearImageBitmap();
      layerCacheManager.configure(
        state.selectedLayerRef.current || "",
        mediaInfo?.paths || [],
        ocioSlug,
        size,
        channel,
      );
      displayFrame(state.currentFrameRef.current, channel);
      if (channel === "RGB") {
        layerCacheManager.preloadAhead(state.currentFrameRef.current, 5);
      }
    },
    [state, mediaInfo, displayFrame, ocioSlug],
  );

  useEffect(() => {
    state.setCurrentFrame(0);
    state.setIsPlaying(false);
    setMetadataLoaded(false);
    state.decodeGenerationRef.current += 1;
    state.clearImageBitmap();
    layerCacheManager.stopContinuousLoad();
    state.isFirstLoadRef.current = true;
    state.firstLoadPathsKeyRef.current = "";
    return () => {
      layerCacheManager.stopContinuousLoad();
      state.decodeGenerationRef.current += 1;
    };
  }, [filePath]);

  const channelModes = React.useMemo<ChannelMode[]>(
    () =>
      availableChannelModes(
        state.selectedLayer,
        state.layersByNameRef.current[state.selectedLayer || ""] || [],
        state.layerChannelsRef.current[state.selectedLayer || ""] || [],
      ),
    [state.selectedLayer],
  );

  return {
    state,
    ocioSlug,
    setOcioSlug,
    ocioGroups,
    effectiveMaxFrames,
    channelModes,
    handleLayerChange,
    handleChannelChange,
  };
}

// ── Stop warm loops on unmount (NAV-3 parity, 2026-07-13) ──────────────
// `ExrPlayer.tsx` already installs its own `stopAllLoops()` unmount hook.
// This belt-and-braces copy lives in `ExrPlayerCore.tsx` so the loops
// are guaranteed to abort even if a future refactor moves the renderer
// into `ExrPlayerCore` (e.g. extracting it into a wrapper) without
// keeping the parent hook in sync. Both fire on the same component
// unmount → the second call is a no-op (loop flags already cleared).
// Cache is preserved so reopening the same file resumes from the saved
// cursor.
function useStopWarmOnUnmount(): void {
  useEffect(() => {
    return () => {
      layerCacheManager.stopAllLoops();
    };
  }, []);
}

export type ExrPlayerCoreResult = ReturnType<typeof ExrPlayerCore>;
