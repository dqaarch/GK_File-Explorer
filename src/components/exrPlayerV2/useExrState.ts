/**
 * EXRPlayer V2 — simplified state container.
 */

import { useRef, useState, useCallback, useMemo } from "react";
import type { MediaInfo } from "../../utils/fileTypeDetector";
import type { ChannelMode, ColorInfo, FrameMetadata, PlaybackFPS } from "./types";

export interface ExrState {
  currentFrame: number;
  setCurrentFrame: (v: number | ((p: number) => number)) => void;
  currentFrameRef: { current: number };
  isPlaying: boolean;
  setIsPlaying: (v: boolean | ((p: boolean) => boolean)) => void;
  isPlayingRef: { current: boolean };
  isLooping: boolean;
  setIsLooping: (v: boolean | ((p: boolean) => boolean)) => void;
  playbackFps: PlaybackFPS;
  setPlaybackFps: (v: PlaybackFPS | ((p: PlaybackFPS) => PlaybackFPS)) => void;
  isFocusView: boolean;
  setIsFocusView: (v: boolean | ((p: boolean) => boolean)) => void;

  selectedLayer: string;
  setSelectedLayer: (v: string | ((p: string) => string)) => void;
  selectedLayerRef: { current: string };
  allLayers: string[];
  setAllLayers: (v: string[] | ((p: string[]) => string[])) => void;
  availableChannels: string[];
  setAvailableChannels: (v: string[] | ((p: string[]) => string[])) => void;
  channelMode: ChannelMode;
  setChannelMode: (v: ChannelMode | ((p: ChannelMode) => ChannelMode)) => void;
  channelModeRef: { current: ChannelMode };
  layersByNameRef: { current: Record<string, string[]> };
  layerChannelsRef: { current: Record<string, string[]> };
  previousLayerRef: { current: string };

  imageBitmap: ImageBitmap | null;
  setImageBitmap: (v: ImageBitmap | null | ((p: ImageBitmap | null) => ImageBitmap | null)) => void;
  imageBitmapRef: { current: ImageBitmap | null };
  clearImageBitmap: () => void;
  imageCanvasRef: { current: HTMLCanvasElement | null };
  metadata: FrameMetadata | null;
  setMetadata: (v: FrameMetadata | null | ((p: FrameMetadata | null) => FrameMetadata | null)) => void;
  isLoading: boolean;
  setIsLoading: (v: boolean | ((p: boolean) => boolean)) => void;
  error: string | null;
  setError: (v: string | null | ((p: string | null) => string | null)) => void;

  zoom: number | "Fit";
  setZoom: (v: number | "Fit" | ((p: number | "Fit") => number | "Fit")) => void;
  showZoomMenu: boolean;
  setShowZoomMenu: (v: boolean | ((p: boolean) => boolean)) => void;
  panOffset: { x: number; y: number };
  setPanOffset: (v: { x: number; y: number } | ((p: { x: number; y: number }) => { x: number; y: number })) => void;
  isPanning: boolean;
  setIsPanning: (v: boolean | ((p: boolean) => boolean)) => void;
  panRef: { current: { isDragging: boolean; startX: number; startY: number; offsetX: number; offsetY: number } };

  showColorPicker: boolean;
  setShowColorPicker: (v: boolean | ((p: boolean) => boolean)) => void;
  isEyedropperActive: boolean;
  setIsEyedropperActive: (v: boolean | ((p: boolean) => boolean)) => void;
  eyedropperColor: ColorInfo | null;
  setEyedropperColor: (v: ColorInfo | null | ((p: ColorInfo | null) => ColorInfo | null)) => void;
  dominantColors: ColorInfo[];
  setDominantColors: (v: ColorInfo[] | ((p: ColorInfo[]) => ColorInfo[])) => void;
  colorPickerCanvasRef: { current: HTMLCanvasElement | null };
  containerRef: { current: HTMLDivElement | null };

  showOcioConfigMenu: boolean;
  setShowOcioConfigMenu: (v: boolean | ((p: boolean) => boolean)) => void;
  showOcioViewMenu: boolean;
  setShowOcioViewMenu: (v: boolean | ((p: boolean) => boolean)) => void;

  decodeGenerationRef: { current: number };
  tickRef: { current: number };
  lastContinuousStartTickRef: { current: number };
  lastDisplayTickRef: { current: number };
  lastActiveSlugTickRef: { current: number };

  /**
   * Content-aware fingerprint for the file (mtime+size). Used to
   * namespace every cache key so the same layer name + path index in
   * two different files can't collide. The fallback "" must never be
   * passed into `layerCacheManager.configure()` — see `ExrPlayer.tsx`
   * where `fileFingerprint` is propagated into the configure call.
   * Without it, the cache key collapses per (layerName, framePath)
   * across files and the player renders another file's bitmap.
   */
  fileFingerprint: string;
  fileFingerprintRef: { current: string };

  bufferLoaded: number;
  setBufferLoaded: (v: number | ((p: number) => number)) => void;
  bufferLoadedRef: { current: number };
  isFirstLoadRef: { current: boolean };
  firstLoadPathsKeyRef: { current: string };

  frameStatuses: { frameIndex: number; status: string }[];
  setFrameStatuses: (v: { frameIndex: number; status: string }[] | ((p: { frameIndex: number; status: string }[]) => { frameIndex: number; status: string }[])) => void;
}

export function useExrState(params: {
  fileName: string;
  filePath: string;
  mediaInfo: MediaInfo;
  fileFingerprint?: string;
  initialChannelMode?: ChannelMode;
  initialFps?: PlaybackFPS;
}): ExrState {
  const initialFps: PlaybackFPS = params.initialFps ?? 25;
  const initialChannelMode: ChannelMode = params.initialChannelMode ?? "RGB";

  const [currentFrame, setCurrentFrame, currentFrameRef] = useRefState(0);
  const [isPlaying, setIsPlaying, isPlayingRef] = useRefState(false);
  const [isLooping, setIsLooping] = useState(true);
  const [playbackFps, setPlaybackFps] = useState<PlaybackFPS>(initialFps);
  const [isFocusView, setIsFocusView] = useState(false);

  const [selectedLayer, setSelectedLayer, selectedLayerRef] = useRefState("");
  const [allLayers, setAllLayers] = useState<string[]>([]);
  const [availableChannels, setAvailableChannels] = useState<string[]>([]);
  const [channelMode, setChannelMode] = useState<ChannelMode>(initialChannelMode);
  const channelModeRef = useRef<ChannelMode>(initialChannelMode);
  const layersByNameRef = useRef<Record<string, string[]>>({});
  const layerChannelsRef = useRef<Record<string, string[]>>({});
  const previousLayerRef = useRef<string>("");

  const [imageBitmap, setImageBitmap] = useState<ImageBitmap | null>(null);
  const imageBitmapRef = useRef<ImageBitmap | null>(null);
  const imageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [metadata, setMetadata] = useState<FrameMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [zoom, setZoom] = useState<number | "Fit">("Fit");
  const [showZoomMenu, setShowZoomMenu] = useState(false);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panRef = useRef({
    isDragging: false,
    startX: 0,
    startY: 0,
    offsetX: 0,
    offsetY: 0,
  });

  const [showColorPicker, setShowColorPicker] = useState(false);
  const [isEyedropperActive, setIsEyedropperActive] = useState(false);
  const [eyedropperColor, setEyedropperColor] = useState<ColorInfo | null>(null);
  const [dominantColors, setDominantColors] = useState<ColorInfo[]>([]);
  const colorPickerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [showOcioConfigMenu, setShowOcioConfigMenu] = useState(false);
  const [showOcioViewMenu, setShowOcioViewMenu] = useState(false);

  const decodeGenerationRef = useRef(0);
  const tickRef = useRef(0);
  const lastContinuousStartTickRef = useRef(-1);
  const lastDisplayTickRef = useRef(-1);
  const lastActiveSlugTickRef = useRef(-1);

  const PLACEHOLDER_FINGERPRINT = "0-0";
  // Phase 3 (2026-07-13): fileFingerprint must flow into every
  // `layerCacheManager.configure()` call. Two different EXR files can
  // share the same "rgba" layer name and the same single-path
  // structure, so the cache key needs an extra dimension to keep them
  // apart. The ref mirrors the latest prop so async handlers (layer
  // change, channel change) always read the *current* fingerprint
  // instead of the one captured at mount time.
  const fileFingerprint = params.fileFingerprint || PLACEHOLDER_FINGERPRINT;
  const fileFingerprintRef = useRef<string>(fileFingerprint);
  fileFingerprintRef.current = fileFingerprint;

  const [bufferLoaded, setBufferLoaded] = useState(0);
  const bufferLoadedRef = useRef(0);
  const isFirstLoadRef = useRef(true);
  const firstLoadPathsKeyRef = useRef<string>("");

  const [frameStatuses, setFrameStatuses] = useState<
    { frameIndex: number; status: string }[]
  >([]);

  // NOTE: tickRef intentionally NOT auto-incremented here. The old
  // EXRSequencePlayer only bumped `tickRef.current` inside effect
  // bodies so duplicate sibling effects in the same commit pass would
  // see the same value and short-circuit. Incrementing on every render
  // breaks that dedup invariant — every render produces a new tick,
  // every effect run sees a fresh tick, every dedup check passes.
  // See `useExrState.tickRef` consumers in `useExrPlayerState.ts`.

  const setChannelModeStable = useCallback((v: ChannelMode) => {
    channelModeRef.current = v;
    setChannelMode(v);
  }, []);

  const clearImageBitmap = useCallback(() => {
    setImageBitmap(null);
    imageBitmapRef.current = null;
  }, []);

  return useMemo(() => ({
    currentFrame,
    setCurrentFrame,
    currentFrameRef,
    isPlaying,
    setIsPlaying,
    isPlayingRef,
    isLooping,
    setIsLooping,
    playbackFps,
    setPlaybackFps,
    isFocusView,
    setIsFocusView,

    selectedLayer,
    setSelectedLayer,
    selectedLayerRef,
    allLayers,
    setAllLayers,
    availableChannels,
    setAvailableChannels,
    channelMode,
    setChannelMode: setChannelModeStable,
    channelModeRef,
    layersByNameRef,
    layerChannelsRef,
    previousLayerRef,

    imageBitmap,
    setImageBitmap,
    imageBitmapRef,
    clearImageBitmap,
    imageCanvasRef,
    metadata,
    setMetadata,
    isLoading,
    setIsLoading,
    error,
    setError,

    zoom,
    setZoom,
    showZoomMenu,
    setShowZoomMenu,
    panOffset,
    setPanOffset,
    isPanning,
    setIsPanning,
    panRef,

    showColorPicker,
    setShowColorPicker,
    isEyedropperActive,
    setIsEyedropperActive,
    eyedropperColor,
    setEyedropperColor,
    dominantColors,
    setDominantColors,
    colorPickerCanvasRef,
    containerRef,

    showOcioConfigMenu,
    setShowOcioConfigMenu,
    showOcioViewMenu,
    setShowOcioViewMenu,

    decodeGenerationRef,
    tickRef,
    lastContinuousStartTickRef,
    lastDisplayTickRef,
    lastActiveSlugTickRef,

    bufferLoaded,
    setBufferLoaded,
    bufferLoadedRef,
    isFirstLoadRef,
    firstLoadPathsKeyRef,

    frameStatuses,
    setFrameStatuses,

    fileFingerprint,
    fileFingerprintRef,
  }), [
    currentFrame, setCurrentFrame, currentFrameRef,
    isPlaying, setIsPlaying, isPlayingRef,
    isLooping, setIsLooping,
    playbackFps, setPlaybackFps,
    isFocusView, setIsFocusView,
    selectedLayer, setSelectedLayer, selectedLayerRef,
    allLayers, setAllLayers,
    availableChannels, setAvailableChannels,
    channelMode, setChannelModeStable, channelModeRef,
    layersByNameRef, layerChannelsRef, previousLayerRef,
    imageBitmap, setImageBitmap, imageBitmapRef, clearImageBitmap,
    imageCanvasRef, metadata, setMetadata,
    isLoading, setIsLoading, error, setError,
    zoom, setZoom, showZoomMenu, setShowZoomMenu,
    panOffset, setPanOffset, isPanning, setIsPanning, panRef,
    showColorPicker, setShowColorPicker,
    isEyedropperActive, setIsEyedropperActive,
    eyedropperColor, setEyedropperColor,
    dominantColors, setDominantColors,
    colorPickerCanvasRef, containerRef,
    showOcioConfigMenu, setShowOcioConfigMenu,
    showOcioViewMenu, setShowOcioViewMenu,
    decodeGenerationRef, tickRef,
    lastContinuousStartTickRef, lastDisplayTickRef, lastActiveSlugTickRef,
    fileFingerprint,
    fileFingerprintRef,
    fileFingerprint,
    fileFingerprintRef,
    bufferLoaded, setBufferLoaded, bufferLoadedRef,
    isFirstLoadRef, firstLoadPathsKeyRef,
    frameStatuses, setFrameStatuses,
  ]);
}

function useRefState<T>(initial: T) {
  const [state, setState] = useState<T>(initial);
  const ref = useRef<T>(initial);
  ref.current = state;
  return [state, setState, ref] as const;
}
