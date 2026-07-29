import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Play, Pause, Maximize, Volume2, VolumeX, Repeat, Palette, Pipette, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, MonitorPlay, ChevronDown, Layers, EyeOff, Eye } from "lucide-react";
import { readFileAsDataUrl, decodePsd, decodeAi, decodeC4d, decodePureref, getFileExtension, fetchThumbnailAsDataUrl } from "../TauriFileSystem";
import { MediaInfo } from "../utils/fileTypeDetector";
import { subscribeFingerprint } from "../hooks/fingerprintStore";
import { listen } from "@tauri-apps/api/event";
import * as MP4Box from "mp4box";

interface ColorInfo {
  hex: string;
  rgb: string;
  hsl: string;
  r?: number;
  g?: number;
  b?: number;
}

function hslToRgb(h: number, s: number, l: number) {
  let r, g, b;
  h /= 360;
  s /= 100;
  l /= 100;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function rgbToHex(r: number, g: number, b: number) {
  return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1).toUpperCase();
}

function generateMockColorInfo(hue: number, sat: number, lit: number): ColorInfo {
  const [r, g, b] = hslToRgb(hue, sat, lit);
  return {
    hex: rgbToHex(r, g, b),
    rgb: `rgb(${r}, ${g}, ${b})`,
    hsl: `hsl(${Math.round(hue)}, ${sat}%, ${lit}%)`
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Segmented timecode editor: click HH:MM:SS segments to edit individually
// Format: HH:MM:SS:FF  —  HH, MM, SS are editable (orange), FF is fixed (grey)
// ─────────────────────────────────────────────────────────────────────────────
interface TimecodeEditorProps {
  value: string; // "HH:MM:SS:FF"
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  accentColor?: string;
}

function TimecodeEditor({ value, onChange, onCommit, onCancel, accentColor = "#f97316" }: TimecodeEditorProps) {
  const [activeSeg, setActiveSeg] = useState<0 | 1 | 2>(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Memoize segs so it stays in sync when value changes from parent
  const segs = useMemo(() => {
    const parts = value.split(":");
    return [
      parts[0] || "00",
      parts[1] || "00",
      parts[2] || "00",
      parts[3] || "00",
    ];
  }, [value]);

  const updateSeg = (idx: number, raw: string) => {
    const nums = raw.replace(/\D/g, "").slice(-2);
    const newSegs = [...segs];
    newSegs[idx] = nums.padStart(2, "0");
    onChange(newSegs.join(":"));
  };

  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      if (idx < 2) setActiveSeg((idx + 1) as 0 | 1 | 2);
      else onCommit();
    }
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    if (e.key === ":") {
      e.preventDefault();
      if (idx < 2) setActiveSeg((idx + 1) as 0 | 1 | 2);
    }
  };

  const segLabels = ["HH", "MM", "SS"];

  return (
    <div className="flex items-center gap-0.5 font-mono text-[10px]">
      {segs.map((seg, i) => {
        if (i === 3) {
          // FF segment — fixed, grey
          return (
            <span key={i} className="text-stone-600 select-none">
              :{seg}
            </span>
          );
        }
        const isActive = activeSeg === i;
        return (
          <React.Fragment key={i}>
            {i > 0 && <span className="text-stone-600">:</span>}
            <input
              ref={isActive ? inputRef : undefined}
              type="text"
              maxLength={2}
              className={`w-5 text-center outline-none bg-transparent rounded px-0.5 font-mono text-[10px] transition-colors ${
                isActive
                  ? "cursor-text"
                  : "text-stone-500 cursor-pointer"
              }`}
              style={isActive ? { backgroundColor: accentColor + "20", color: accentColor, border: `1px solid ${accentColor}50` } : undefined}
              value={seg}
              onFocus={() => setActiveSeg(i as 0 | 1 | 2)}
              onChange={(e) => updateSeg(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(e, i)}
              onBlur={() => {
                setTimeout(() => {
                if (document.activeElement?.hasAttribute("data-seg-input")) return;
                  onCommit();
                }, 50);
              }}
              data-seg-input
            />
          </React.Fragment>
        );
      })}
    </div>
  );
}

function kMeansDominantColors(imageData: ImageData, k = 5): ColorInfo[] {
  const data = imageData.data;
  const pixels: [number, number, number][] = [];
  for (let i = 0; i < data.length; i += 16) {
    pixels.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (pixels.length === 0) return [];
  let centroids: [number, number, number][] = pixels.slice(0, k).map(p => [...p] as [number, number, number]);
  while (centroids.length < k) centroids.push([0, 0, 0]);
  for (let iter = 0; iter < 10; iter++) {
    const clusters: [number, number, number][][] = Array.from({ length: k }, () => []);
    for (const px of pixels) {
      let minDist = Infinity, idx = 0;
      for (let c = 0; c < k; c++) {
        const d = (px[0] - centroids[c][0]) ** 2 + (px[1] - centroids[c][1]) ** 2 + (px[2] - centroids[c][2]) ** 2;
        if (d < minDist) { minDist = d; idx = c; }
      }
      clusters[idx].push(px);
    }
    let changed = false;
    for (let c = 0; c < k; c++) {
      if (clusters[c].length === 0) continue;
      const avg: [number, number, number] = [0, 0, 0];
      for (const px of clusters[c]) { avg[0] += px[0]; avg[1] += px[1]; avg[2] += px[2]; }
      avg[0] = Math.round(avg[0] / clusters[c].length);
      avg[1] = Math.round(avg[1] / clusters[c].length);
      avg[2] = Math.round(avg[2] / clusters[c].length);
      if (avg[0] !== centroids[c][0] || avg[1] !== centroids[c][1] || avg[2] !== centroids[c][2]) changed = true;
      centroids[c] = avg;
    }
    if (!changed) break;
  }
  return centroids.map(c => {
    let h = 0, s = 0;
    const r2 = c[0] / 255, g2 = c[1] / 255, b2 = c[2] / 255;
    const max = Math.max(r2, g2, b2), min = Math.min(r2, g2, b2);
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r2: h = ((g2 - b2) / d + (g2 < b2 ? 6 : 0)) / 6; break;
        case g2: h = ((b2 - r2) / d + 2) / 6; break;
        case b2: h = ((r2 - g2) / d + 4) / 6; break;
      }
    }
    return {
      hex: rgbToHex(c[0], c[1], c[2]),
      rgb: `rgb(${c[0]}, ${c[1]}, ${c[2]})`,
      hsl: `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`,
      r: c[0], g: c[1], b: c[2],
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// V1 Pattern: LRU Frame Cache
// ─────────────────────────────────────────────────────────────────────────────
interface CacheEntry {
  dataUrl: string;
  size: number;
}

class FrameCache {
  private cache = new Map<string, CacheEntry>();
  private currentSize = 0;
  // 2026-07-12: bumped from 128MB → 1GB. The previous cap was chosen when the
  // player only ever served 1K-thumbnail preview stills, but a 4K PNG sequence
  // can be 15-30 MB per frame (base64 dataUrl × 0.75), so 128MB held only
  // 3-6 frames and the warmup pass would evict the frame the user is about
  // to play. That caused:
  //   1. Playback stutter (cache miss on every frame advance)
  //   2. The "warm repeat" symptom — `allCached` returns false on the next
  //      Play click because most frames were evicted, so the warmup overlay
  //      shows again.
  // 1GB comfortably holds ~30-50 4K frames (a typical short sequence) while
  // still bounding memory on machines with limited RAM. The cache is
  // dynamically resizable via `setMaxMemoryMB` so users with smaller
  // machines can still pull it down if needed.
  private maxSize = 1024 * 1024 * 1024; // 1GB

  get(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      // Move to end (most recently used) - re-insert
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
    return entry?.dataUrl;
  }

  setMaxMemoryMB(mb: number): void {
    const bytes = Math.max(64, mb) * 1024 * 1024;
    this.maxSize = bytes;
    // Evict anything that doesn't fit under the new ceiling
    while (this.currentSize > this.maxSize && this.cache.size > 0) {
      this.evictLRU();
    }
  }

  getMaxMemoryMB(): number {
    return Math.round(this.maxSize / (1024 * 1024));
  }

  getCurrentSizeMB(): number {
    return Math.round(this.currentSize / (1024 * 1024));
  }

  set(key: string, dataUrl: string, size: number): void {
    // Evict until we have room
    while (this.currentSize + size > this.maxSize && this.cache.size > 0) {
      this.evictLRU();
    }

    // If single item exceeds cache, skip
    if (size > this.maxSize) {
      return;
    }

    // Remove existing entry if present
    const existing = this.cache.get(key);
    if (existing) {
      this.currentSize -= existing.size;
      this.cache.delete(key);
    }

    this.cache.set(key, { dataUrl, size });
    this.currentSize += size;
  }

  private evictLRU(): void {
    // First entry is LRU
    const firstKey = this.cache.keys().next().value;
    if (firstKey) {
      const entry = this.cache.get(firstKey);
      if (entry) {
        this.currentSize -= entry.size;
      }
      this.cache.delete(firstKey);
    }
  }

  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  delete(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      this.currentSize -= entry.size;
      this.cache.delete(key);
    }
  }

  forEachKey(callback: (key: string) => void): void {
    this.cache.forEach((_, key) => callback(key));
  }

  get size(): number { return this.currentSize; }
}

function truncateKey(key: string): string {
  if (key.length <= 80) return key;
  return key.slice(0, 40) + "..." + key.slice(-37);
}

// ─────────────────────────────────────────────────────────────────────────────
// V1 Pattern: Prefetch Scheduler (3 concurrent loads)
// ─────────────────────────────────────────────────────────────────────────────
class PrefetchScheduler {
  private inFlight = new Set<string>();
  private maxConcurrent = 3;
  private cache: FrameCache;
  private maxSize: number;

  constructor(cache: FrameCache, maxSize = 768) {
    this.cache = cache;
    this.maxSize = maxSize;
  }

  schedule(frameIndex: number, paths: string[], loadFn: (path: string, ext: string, maxSize: number) => Promise<void>): void {
    if (!paths || paths.length === 0) return;

    // Prefetch ±2 frames from current position
    const toFetch: number[] = [];
    for (let delta = -2; delta <= 2; delta++) {
      const idx = frameIndex + delta;
      if (idx >= 0 && idx < paths.length && idx !== frameIndex) {
        toFetch.push(idx);
      }
    }

    for (const idx of toFetch) {
      const path = paths[idx];
      const ext = getFileExtension(path) || "";
      const cacheKey = `${path}:${this.maxSize}`;

      if (
        !this.inFlight.has(cacheKey) &&
        !this.cache.get(cacheKey)
      ) {
        // Limit concurrent loads
        if (this.inFlight.size < this.maxConcurrent) {
          this.inFlight.add(cacheKey);
          loadFn(path, ext, this.maxSize)
            .catch(() => {})
            .finally(() => {
              this.inFlight.delete(cacheKey);
            });
        }
      }
    }
  }

  clear(): void {
    this.inFlight.clear();
  }
}

interface ImageSequencePreviewProps {
  fileName: string;
  filePath?: string;
  accentColor: string;
  isEXR?: boolean;
  isSequence?: boolean;
  mediaInfo?: MediaInfo | null;
  /** mtimeMs-size fingerprint for the current file. Used to bust the frame
   *  cache when the file is replaced in place. */
  fileFingerprint?: string;
}

const BASE_FPS = 24;
const PLAYBACK_FPS_OPTIONS = [15, 24, 25, 30, 60, 90, 120] as const;
type PlaybackFPS = typeof PLAYBACK_FPS_OPTIONS[number];

// HMR-friendly singletons: cache and scheduler live on `window` so that when
// Vite hot-reloads ImageSequencePreview.tsx we don't lose the cached frames.
// Without this guard, every save would tear down `globalFrameCache` and
// force re-decoding of every C4D / PSD / AI the user has already opened.
function getOrCreateGlobalFrameCache(): FrameCache {
  if (typeof window === "undefined") {
    return new FrameCache();
  }
  const w = window as any;
  if (!w.__imageSequenceFrameCache) {
    w.__imageSequenceFrameCache = new FrameCache();
  }
  return w.__imageSequenceFrameCache as FrameCache;
}
function getOrCreatePrefetchScheduler(cache: FrameCache): PrefetchScheduler {
  if (typeof window === "undefined") {
    return new PrefetchScheduler(cache, 768);
  }
  const w = window as any;
  if (!w.__imageSequencePrefetchScheduler) {
    w.__imageSequencePrefetchScheduler = new PrefetchScheduler(cache, 768);
  }
  return w.__imageSequencePrefetchScheduler as PrefetchScheduler;
}

const globalFrameCache = getOrCreateGlobalFrameCache();
const globalPrefetchScheduler = getOrCreatePrefetchScheduler(globalFrameCache);

// Keep window references in sync after HMR replaces the module-scoped consts.
// On the first load `globalFrameCache` is the same instance we already put
// on window; on HMR the module reload re-evaluates these lines, the helpers
// above return the existing window-bound instance, and we re-attach so any
// late-arriving debug tooling sees the live reference.
if (typeof window !== "undefined") {
  (window as any).__imageSequenceFrameCache = globalFrameCache;
  (window as any).__imageSequencePrefetchScheduler = globalPrefetchScheduler;
}

export default function ImageSequencePreview({ fileName, filePath, accentColor, isEXR = false, isSequence = false, mediaInfo, fileFingerprint }: ImageSequencePreviewProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [zoom, setZoom] = useState<number | "Fit">("Fit");
  const [isLooping, setIsLooping] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [playbackFps, setPlaybackFps] = useState<PlaybackFPS>(25);
  const [isFocusView, setIsFocusView] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState<number | null>(null); // 0-100 for heavy files
  const [isDecoding, setIsDecoding] = useState(false); // Track if currently decoding
  const [decodeStageMessage, setDecodeStageMessage] = useState<string | null>(null); // Human-readable stage hint (e.g. "Decoding layers...")

  // Clear frame cache when file is replaced. The fingerprintStore is the
  // SINGLE source of truth for "file replaced" events; this component just
  // subscribes once on mount and cleans up on unmount.
  useEffect(() => {
    const unsubscribe = subscribeFingerprint((changedPath) => {
      const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
      const normalizedPath = normalize(changedPath);

      // Clear cache entries that match this path (any size variant)
      const keysToDelete: string[] = [];
      globalFrameCache.forEachKey((key) => {
        const cachePath = key.split(':')[0].replace(/\\/g, "/").replace(/\/+$/, "");
        if (cachePath === normalizedPath) {
          keysToDelete.push(key);
        }
      });
      keysToDelete.forEach((key) => globalFrameCache.delete(key));
    });
    return unsubscribe;
  }, []);

  // Listen for decode progress events from Rust backend
  useEffect(() => {
    const unlisten = listen<{ path: string; percent: number; message?: string }>(
      "decode-progress",
      (event) => {
        if (event.payload && event.payload.path === filePath) {
          setLoadingProgress(event.payload.percent);
          if (event.payload.message) {
            setDecodeStageMessage(event.payload.message);
          }
          // Mark as done when we receive final progress
          if (event.payload.percent >= 100) {
            setIsDecoding(false);
          }
        }
      }
    );
    return () => { unlisten.then(fn => fn()); };
  }, [filePath]);

  // NOTE: Progress bar shows ONLY what the Rust backend emits via
  // decode-progress events (e.g. 10, 30, 50, 80, 100). We do NOT animate
  // on the frontend because mixing the two caused flickering and stuck
  // bars (multiple sources fighting to set the same state).
  // For cache hits (no progress events emitted), the progress bar briefly
  // shows 0% then jumps to null when decoding completes.

  const handleFocusViewToggle = () => {
    setIsFocusView(!isFocusView);
  };
  const [isEyeDropperActive, setIsEyeDropperActive] = useState(false);
  const [eyedropperColor, setEyedropperColor] = useState<ColorInfo | null>(null);
  const [copiedHex, setCopiedHex] = useState<string | null>(null);
  const [colors, setColors] = useState<ColorInfo[]>([]);
  const [showColors, setShowColors] = useState(false);
  const [expandedColorIndex, setExpandedColorIndex] = useState<number | null>(null);
  const colorPickerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [activePass, setActivePass] = useState("Beauty");
  const [showLayerPasses, setShowLayerPasses] = useState(false);
  const [activeChannels, setActiveChannels] = useState<{ [passName: string]: string }>({});
  const [imageError, setImageError] = useState(false);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [loadingImage, setLoadingImage] = useState(false);

  // Warmup state: preloads all frames before playback to prevent black flicker
  // on first play (when LRU cache is cold).
  const [playbackPhase, setPlaybackPhase] = useState<'idle' | 'warmup' | 'playing'>('idle');
  const [warmupProgress, setWarmupProgress] = useState(0); // 0-100
  const [framesLoaded, setFramesLoaded] = useState(0);
  const warmupCancelRef = useRef(false);

  // The chip now only shows frame counts (no timecode). We keep
  // isEditingTime + editTimeValue so we don't disturb state ordering
  // for any code that watches them; timeMode has been removed since
  // the chip is always in "frames" mode now.
  const [isEditingTime, setIsEditingTime] = useState(false);
  const [editTimeValue, setEditTimeValue] = useState("");

  const [showZoomMenu, setShowZoomMenu] = useState(false);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  // Middle-click pan mode: second middle click ends pan, right-click ends pan, document mouseup ends pan
  const [isPanning, setIsPanning] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const panRef = useRef({ isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 });
  // Track the path of the frame currently being loaded (or last loaded) so
  // loadFrameImage can skip the loading→loaded flag flip when called
  // repeatedly for the same frame. Without this guard, the playback
  // interval re-invokes loadFrameImage on every tick and the UI strobes
  // between blank and loaded at the fps rate.
  const currentlyLoadingPathRef = useRef<string | null>(null);
  // Mirror of the latest `imageDataUrl` state, so we can read it inside
  // the loadFrameImage callback (which closes over state at render time)
  // without forcing the callback to depend on `imageDataUrl` (which would
  // re-create the callback every frame and break the prefetch scheduler's
  // dedup).
  const imageDataUrlRef = useRef<string | null>(null);
  // Ref for isEyeDropperActive — read by global keyboard handler. The
  // remaining keyboard-handler refs are declared further below, AFTER
  // `isRealSequence` is computed (since `useRef`'s initializer reads
  // them and would TDZ if hoisted above).
  const isEyeDropperActiveRef = useRef(isEyeDropperActive);
  isEyeDropperActiveRef.current = isEyeDropperActive;

  const isRealSequence = isSequence && mediaInfo && mediaInfo.paths.length > 1;
  const effectiveMaxFrames = isRealSequence && mediaInfo ? mediaInfo.paths.length : 0;

  // Refs mirror values read inside the global keyboard handler (registered
  // with `window.addEventListener`) so the handler doesn't suffer from
  // stale closure when re-attached less often than the underlying state
  // changes. We sync them DURING RENDER (not inside a useEffect) so the
  // handler always reads the latest values, regardless of which effects
  // have run yet. If we synced them inside useEffect, the handler would
  // read stale values for one tick after every state change — which is
  // exactly the bug where Space started playback but couldn't pause it.
  const isPlayingRefForKey = useRef(isPlaying);
  isPlayingRefForKey.current = isPlaying;
  const playbackPhaseRefForKey = useRef(playbackPhase);
  playbackPhaseRefForKey.current = playbackPhase;
  const isRealSequenceRefForKey = useRef(isRealSequence);
  isRealSequenceRefForKey.current = isRealSequence;
  const startWarmupRef = useRef<(() => Promise<void>) | undefined>(undefined);

  // Wrapped `imageDataUrl` setter that mirrors the value into
  // `imageDataUrlRef` so the loadFrameImage callback can read the latest
  // value without depending on `imageDataUrl` (and therefore without being
  // recreated on every frame advance).
  const setImageDataUrlAndRef = useCallback((v: string | null) => {
    imageDataUrlRef.current = v;
    setImageDataUrl(v);
  }, []);
  // Load a single image frame from a file path, with V1-style LRU caching
  const loadFrameImage = useCallback(async (path: string, ext: string, maxSize: number = 768): Promise<void> => {
    // V1 pattern: Check LRU cache FIRST. We do this before any setState
    // calls so that re-clicking a heavy-format file (PSD/AI/C4D) doesn't
    // flash the loading/progress UI for one tick — without this hoisted
    // check, the user sees the progress bar restart even though the cached
    // frame is already in memory.
    const cacheKey = `${path}:${maxSize}:${fileFingerprint ?? "0-0"}`;
    const cached = globalFrameCache.get(cacheKey);
    if (cached) {
      // FAST PATH: cache hit. Reuse the existing `imageDataUrl` if it
      // already matches (callers that re-invoke for the same frame
      // shouldn't cause a re-render at all). Otherwise swap src and let
      // React commit it; the browser will paint the new frame from the
      // already-decoded in-memory bitmap on the next vsync.
      if (cached !== imageDataUrlRef.current) {
        setImageDataUrlAndRef(cached);
        setImageLoaded(true);
      }
      currentlyLoadingPathRef.current = path;
      setLoadingImage(false);
      setImageError(false);
      setLoadingProgress(null);
      setIsDecoding(false);
      return;
    }

    // Track the path of the currently-displayed (or in-flight) frame so we
    // don't flash a blank/loading state when the caller re-renders for the
    // same frame. Without this guard, every playback tick would do
    //   setLoadingImage(true) → re-render (blank) → cache hit →
    //   setLoadingImage(false) → re-render (image)
    // which strobes visibly at 24 fps.
    const isSameFrameAsCurrentlyLoading = currentlyLoadingPathRef.current === path;
    if (!isSameFrameAsCurrentlyLoading) {
      currentlyLoadingPathRef.current = path;
      setLoadingImage(true);
      setImageError(false);
      setImageLoaded(false);
    }

    // Show progress bar for heavy files (PSD/AI/EPS/PSB)
    const isHeavyFormat = ['psd', 'psb', 'ai', 'eps', 'c4d', 'pur', 'pureref'].includes(ext.toLowerCase());
    if (isHeavyFormat) {
      setLoadingProgress(0); // Start at 0% - animation will run to 99%
      setIsDecoding(true); // Trigger animation
      setDecodeStageMessage("Starting...");
    }

    try {
      let dataUrl: string | null = null;
      let size: { width: number; height: number } | null = null;


      // Not in cache - load and decode
      if (ext === "psd" || ext === "psb") {
        const result = await decodePsd(path, maxSize);
        if (result.success && result.png_base64) {
          const mime = result.method?.includes("jpeg") ? "image/jpeg" : "image/png";
          dataUrl = `data:${mime};base64,${result.png_base64}`;
          if (result.width && result.height) size = { width: result.width, height: result.height };
        }
      } else if (ext === "ai" || ext === "eps") {
        // Try decodeAi first — it emits decode-progress events so the
        // progress bar updates in real time. Fall back to the HTTP
        // /thumbnail endpoint (which does NOT emit progress) if decodeAi
        // returns no result.
        try {
          const result = await decodeAi(path, maxSize);
          if (result.success && result.png_base64) {
            const mime = result.method?.includes("jpeg") ? "image/jpeg" : "image/png";
            dataUrl = `data:${mime};base64,${result.png_base64}`;
            if (result.width && result.height) size = { width: result.width, height: result.height };
          }
        } catch {
          // decodeAi threw; fall back to HTTP endpoint
          try {
            dataUrl = await fetchThumbnailAsDataUrl(path, maxSize);
          } catch {
            // Both paths failed
          }
        }
      } else if (ext === "c4d") {
        const result = await decodeC4d(path, maxSize);
        if (result.success && result.png_base64) {
          const mime = result.method?.includes("jpeg") ? "image/jpeg" : "image/png";
          dataUrl = `data:${mime};base64,${result.png_base64}`;
          if (result.width && result.height) size = { width: result.width, height: result.height };
        }
      } else if (ext === "pur" || ext === "pureref") {
        const result = await decodePureref(path, maxSize);
        if (result.success && result.png_base64) {
          const mime = result.method?.includes("png") ? "image/png" : "image/jpeg";
          dataUrl = `data:${mime};base64,${result.png_base64}`;
          if (result.width && result.height) size = { width: result.width, height: result.height };
        }
      } else {
        // Standard images
        const ext_lower = ext.toLowerCase();
        if (ext_lower === "tif" || ext_lower === "tiff") {
          // TIF/TIFF: use /thumbnail endpoint which converts to PNG server-side.
          // Browser cannot decode data:image/tiff;base64 natively, so readFileAsDataUrl
          // (which serves raw TIF bytes) will always fail.
          try {
            dataUrl = await fetchThumbnailAsDataUrl(path, maxSize);
          } catch {
            // thumbnail endpoint failed
          }
        } else {
          // Other formats: read raw bytes (PNG/JPEG/WebP/BMP decode natively in browser)
          try {
            dataUrl = await readFileAsDataUrl(path);
          } catch {
            try {
              dataUrl = await fetchThumbnailAsDataUrl(path, maxSize);
            } catch {
              // nothing worked
            }
          }
        }
      }

      if (dataUrl) {
        // V1 pattern: Estimate data URL size (rough: base64 is ~4/3 of binary)
        const approxBytes = dataUrl.length * 0.75;
        globalFrameCache.set(cacheKey, dataUrl, approxBytes);
        setImageDataUrlAndRef(dataUrl);
        if (size) {
          setImageSize(size);
          setImageLoaded(true);
          setImageError(false);
        } else {
          const img = new Image();
          img.onload = () => {
            setImageSize({ width: img.naturalWidth, height: img.naturalHeight });
            setImageLoaded(true);
          };
          img.onerror = () => {
            setImageError(true);
          };
          img.src = dataUrl;
        }
      } else {
        setImageError(true);
        setImageDataUrlAndRef(null);
      }
    } catch (err) {
      setImageError(true);
      setImageDataUrlAndRef(null);
    } finally {
      setLoadingImage(false);
      setIsDecoding(false); // Stop animation
      if (isHeavyFormat) setLoadingProgress(null);
    }
  }, []);

  function shortenPathForLog(p: string): string {
    if (p.length <= 70) return p;
    return "..." + p.slice(p.length - 67);
  }

  // Load image when filePath changes
  useEffect(() => {
    if (!filePath) {
      setImageDataUrlAndRef(null);
      currentlyLoadingPathRef.current = null;
      setImageError(false);
      setImageLoaded(false);
      return;
    }

    const ext = getFileExtension(filePath) || "";
    if (isRealSequence && mediaInfo) {
      // Real sequence: load the current frame based on currentFrame index
      const frameIndex = Math.min(currentFrame, mediaInfo.paths.length - 1);
      const framePath = mediaInfo.paths[frameIndex];
      const frameExt = getFileExtension(framePath) || ext;
      loadFrameImage(framePath, frameExt, 768);
    } else {
      // Single still image
      loadFrameImage(filePath, ext, 768);
    }
  }, [filePath, isRealSequence, mediaInfo, currentFrame, loadFrameImage, fileFingerprint]);

  // Reset state when file changes
  useEffect(() => {
    setCurrentFrame(0);
    setImageError(false);
    setImageSize(null);
    setImageLoaded(false);
    // Cancel any in-flight warmup when the user switches to another file
    warmupCancelRef.current = true;
    setPlaybackPhase('idle');
    setWarmupProgress(0);
    setFramesLoaded(0);
    setIsPlaying(false);
  }, [filePath]);

  // Cancel warmup on unmount so the worker pool doesn't keep decoding
  // into a stale component instance
  useEffect(() => {
    return () => {
      warmupCancelRef.current = true;
    };
  }, []);

  // Load image dimensions when data URL is ready (for non-sequence)
  useEffect(() => {
    if (imageDataUrl && !isRealSequence) {
      const img = new Image();
      img.onload = () => {
        setImageSize({ width: img.naturalWidth, height: img.naturalHeight });
        setImageLoaded(true);
        setImageError(false);
      };
      img.onerror = () => {
        setImageError(true);
        setImageSize(null);
        setImageLoaded(false);
      };
      img.src = imageDataUrl;
    }
  }, [imageDataUrl, isRealSequence]);

  // V1 Pattern: DO NOT reset frame on pause. V1 only resets when playback actually stops at the end.
  // The old code "if (!isPlaying) setCurrentFrame(0)" caused the jump-to-frame-0 bug.

  // Warmup: preload all sequence frames into the LRU cache before starting
  // playback. Without this, the first playback pass shows black flicker because
  // the playback interval advances frames faster than the disk decode can keep
  // up. After warmup completes once, replays hit the cache and play smoothly.
  const startWarmup = useCallback(async () => {
    if (!isRealSequence || !mediaInfo) return;

    const cacheKey = (path: string) => `${path}:768:${fileFingerprint ?? '0-0'}`;
    const total = mediaInfo.paths.length;
    const allCached = mediaInfo.paths.every(p => globalFrameCache.has(cacheKey(p)));

    if (allCached) {
      // Cache hit — play immediately, no overlay needed
      setIsPlaying(true);
      return;
    }

    setPlaybackPhase('warmup');
    setWarmupProgress(0);
    setFramesLoaded(0);
    warmupCancelRef.current = false;

    // Only warmup the frames that AREN'T already cached. Without this,
    // a previous partial warmup (e.g. user clicked Play, watched 30 frames,
    // stopped, clicked Play again) would redo the first 30 frames and
    // waste ~30 × decode-time. Skipping already-cached frames makes the
    // overlay disappear as fast as possible and avoids redundant disk
    // reads.
    const queue: number[] = [];
    for (let i = 0; i < total; i++) {
      if (!globalFrameCache.has(cacheKey(mediaInfo.paths[i]))) {
        queue.push(i);
      }
    }
    // Progress now reflects the *remaining* work (so the bar fills toward
    // 100% as we drain the queue, instead of jumping because some frames
    // were already cached).
    const initialCached = total - queue.length;
    let loaded = initialCached;
    setFramesLoaded(loaded);
    setWarmupProgress((loaded / total) * 100);

    // Concurrency scales with cache size: a 4K PNG is ~20MB so 1GB cache
    // holds ~50 frames. With only 3 workers the warmup is dominated by
    // tail latency; 6 workers saturate typical SATA SSDs without blowing
    // past the cache ceiling. We cap at 8 because beyond that the OS
    // page cache starts thrashing on HDD.
    const concurrency = Math.min(8, Math.max(3, queue.length));

    const worker = async () => {
      while (queue.length > 0 && !warmupCancelRef.current) {
        const idx = queue.shift();
        if (idx === undefined) break;
        const path = mediaInfo.paths[idx];
        const ext = getFileExtension(path) || '';
        try {
          await loadFrameImage(path, ext, 768);
        } catch {
          // Skip failed frame so the progress bar doesn't stall
        }
        loaded++;
        setFramesLoaded(loaded);
        setWarmupProgress((loaded / total) * 100);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (!warmupCancelRef.current) {
      setPlaybackPhase('playing');
      setWarmupProgress(0);
      setFramesLoaded(0);
      setIsPlaying(true);
    }
  }, [isRealSequence, mediaInfo, loadFrameImage, fileFingerprint]);
  // Keep the ref pointing to the latest startWarmup so the global keyboard
  // handler (registered independently in a useEffect with its own deps)
  // always calls the current version of startWarmup without registering /
  // re-registering listeners on every render.
  startWarmupRef.current = startWarmup;
  // Playback interval - cycles through actual sequence frames (V1: 1000/(FPS*speed) ms per frame)
  useEffect(() => {
    let frameInterval: ReturnType<typeof setInterval>;
    if (isPlaying) {
      frameInterval = setInterval(() => {
        setCurrentFrame(f => {
          if (f >= effectiveMaxFrames - 1) {
            if (isLooping) return 0;
            setIsPlaying(false);
            return f;
          }
          return f + 1;
        });
      }, 1000 / (playbackFps * playbackSpeed));
    }
    return () => clearInterval(frameInterval);
  }, [isPlaying, isLooping, playbackSpeed, effectiveMaxFrames, playbackFps]);

  // V1 Pattern: Prefetch adjacent frames when playing (cache ±2 frames, max 3 concurrent loads)
  useEffect(() => {
    if (!isRealSequence || !mediaInfo || !isPlaying) return;
    globalPrefetchScheduler.schedule(currentFrame, mediaInfo.paths, loadFrameImage);
  }, [currentFrame, isRealSequence, isPlaying, mediaInfo, loadFrameImage]);

  // Escape exits focus view. Mirrors 3DModelViewer's keyboard handler so the
  // focus-view toggle is symmetric with the toolbar button.
  useEffect(() => {
    if (!isFocusView) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setIsFocusView(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFocusView]);

  useEffect(() => {
    // The Space / arrow handlers read live state through refs (kept in
    // sync during render, just above this effect). This avoids stale
    // closure without forcing us to re-register the handler on every
    // isPlaying / playbackPhase change — which would risk dropping Space
    // presses fired while the effect is re-running.
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEyeDropperActiveRef.current) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (isRealSequenceRefForKey.current) {
          // Ignore Space during warmup — the warmup overlay already shows
          // progress and we don't want a second click to abort it (the
          // user can press Space again once playback begins).
          if (playbackPhaseRefForKey.current === 'warmup') return;
          if (!isPlayingRefForKey.current) startWarmupRef.current?.();
          else setIsPlaying(false);
        } else {
          setIsPlaying(p => !p);
        }
      }
      if (e.code === "ArrowRight") { e.preventDefault(); setIsPlaying(false); setCurrentFrame(f => Math.min(effectiveMaxFrames - 1, f + 1)); }
      if (e.code === "ArrowLeft") { e.preventDefault(); setIsPlaying(false); setCurrentFrame(f => Math.max(0, f - 1)); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [effectiveMaxFrames]);

  // Color extraction: setInterval for images, rVFC would only work on video
  useEffect(() => {
    const img = imgRef.current;
    const canvas = colorPickerCanvasRef.current;
    if (!img || !canvas || !imageDataUrl || !showColors) return;

    const colorCtx = canvas.getContext("2d", { willReadFrequently: true });
    let lastColorExtractTimeRef = 0;

    const extractColor = () => {
      if (!showColors || !img.complete || img.naturalWidth === 0) return;
      const nowMs = performance.now();
      if (nowMs - lastColorExtractTimeRef >= 1000) {
        lastColorExtractTimeRef = nowMs;
        canvas.width = 80;
        canvas.height = Math.round(80 * img.naturalHeight / Math.max(img.naturalWidth, 1));
        if (colorCtx) {
          colorCtx.drawImage(img, 0, 0, canvas.width, canvas.height);
          try {
            const imageData = colorCtx.getImageData(0, 0, canvas.width, canvas.height);
            setColors(kMeansDominantColors(imageData, 5));
          } catch { /* cross-origin blocked */ }
        }
      }
    };

    // For images: use setInterval while showColors is on
    const intervalId = setInterval(extractColor, 1000);
    // Also extract immediately on mount
    extractColor();

    return () => clearInterval(intervalId);
  }, [imageDataUrl, showColors]);

  const handleWheel = (e: React.WheelEvent) => {
    if (document.activeElement instanceof HTMLInputElement) return;
    if (!e.ctrlKey) return; // Only zoom with Ctrl+Scroll
    e.preventDefault();
    const delta = e.deltaY * -0.001;
    setZoom(z => {
      const currentZoom = z === "Fit" ? 1 : z;
      return Math.min(Math.max(0.25, currentZoom + delta), 4.0);
    });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) { // Middle mouse button
      e.preventDefault();
      e.stopPropagation();
      if (isPanning) {
        // Second middle click → stop panning, reset offset
        setIsPanning(false);
        setPanOffset({ x: 0, y: 0 });
        return;
      }
      // Start panning
      setIsPanning(true);
      panRef.current = { isDragging: true, startX: e.clientX, startY: e.clientY, offsetX: panOffset.x, offsetY: panOffset.y };
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning && panRef.current.isDragging) {
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      setPanOffset({ x: panRef.current.offsetX + dx, y: panRef.current.offsetY + dy });
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (panRef.current.isDragging) {
      panRef.current.isDragging = false;
    }
  };

  // Stop panning on right-click anywhere or on document mouseup
  useEffect(() => {
    const stopPan = () => {
      if (isPanning) {
        setIsPanning(false);
        panRef.current.isDragging = false;
      }
    };
    window.addEventListener('mouseup', stopPan);
    window.addEventListener('contextmenu', stopPan);
    return () => {
      window.removeEventListener('mouseup', stopPan);
      window.removeEventListener('contextmenu', stopPan);
    };
  }, [isPanning]);

  const handleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  };

  // ── Frame number formatter (always used; we removed the timecode mode
  //     entirely since users want pure frame counts like 000286 instead of a
  //     bare "0"). The display reflects the ACTUAL filename frame number,
  //     so a sequence starting at `IDC_00286.png` shows `00286`, `00287`,
  //     …, not `000`, `001`, …. We use:
  //     - `mediaInfo.padding` if available (added 2026-07-12) so the zero
  //       pad matches the source files exactly.
  //     - Otherwise fall back to the larger of (frameNumbers width,
  //       effectiveMaxFrames width) so we never truncate user-visible
  //       digits. ─────────────────────────────────────────────────────────
  const actualFrameNumber = (frameIndex: number): number => {
    if (!isRealSequence || !mediaInfo) return frameIndex;
    const base = mediaInfo.frameNumbers[0] ?? 0;
    return base + frameIndex;
  };
  const frameDisplayWidth = (() => {
    if (!isRealSequence || !mediaInfo) return 1;
    if (mediaInfo.padding && mediaInfo.padding > 0) return mediaInfo.padding;
    // Fallback: width of the largest frame number in the sequence (covers
    // non-zero starts like 00286 without a recorded padding).
    const widest = mediaInfo.frameNumbers.reduce(
      (m, n) => Math.max(m, String(n).length),
      0,
    );
    return Math.max(widest, String(effectiveMaxFrames).length, 1);
  })();
  const formatFrames = (frame: number) =>
    actualFrameNumber(frame).toString().padStart(frameDisplayWidth, '0');

  // Parse a frame number string (with optional leading zeros) into a valid
  // frame INDEX. We accept both the bare index (`42`) and the full frame
  // number (`00286` for a sequence starting at 00286) so the user can
  // jump to a frame by typing either form. Returns the current frame
  // unchanged on bad input.
  const parseFrameInput = (input: string) => {
    const cleaned = input.replace(/[^0-9]/g, "");
    if (cleaned === "") return currentFrame;
    const parsed = parseInt(cleaned, 10);
    if (isNaN(parsed) || !mediaInfo) return currentFrame;
    const base = mediaInfo.frameNumbers[0] ?? 0;
    const total = mediaInfo.paths.length;
    // Treat the parsed value as an absolute frame number first; if it
    // falls outside [base, base + total), treat it as a 0-based index.
    let asIndex: number;
    if (parsed >= base && parsed < base + total) {
      asIndex = parsed - base;
    } else {
      asIndex = parsed;
    }
    return Math.min(Math.max(0, asIndex), total - 1);
  };

  const themeBg = "bg-[var(--header-bg)] text-stone-300";
  const wrapperClasses = isFocusView
    ? `fixed inset-0 z-[500] shadow-2xl overflow-hidden flex flex-col ${themeBg}`
    : `w-full h-full flex flex-col relative ${themeBg}`;

  const isPsdOrPsb = fileName.toLowerCase().endsWith('.psd') || fileName.toLowerCase().endsWith('.psb');

  const activeZoomScale = zoom === "Fit" ? 1 : zoom;

  return (
    <div ref={containerRef} className={wrapperClasses}>
      <div className="absolute top-0 w-full p-2 flex justify-between items-center z-40 pointer-events-none theme-aware-header" style={{ background: `linear-gradient(135deg, ${accentColor}18 0%, var(--header-bg) 100%)`, borderBottom: `1px solid ${accentColor}25` }}>
         <div className="flex items-center gap-2">
           <div className="text-[8px] font-bold px-1 py-0.5 rounded uppercase tracking-wider border" style={{ backgroundColor: accentColor, color: 'var(--row-bg)', borderColor: `${accentColor}80` }}>{isSequence ? "SEQ" : "IMG"}</div>
           <span className="text-[10px] font-mono pointer-events-auto shadow-sm theme-aware-header-text">{fileName}</span>
         </div>
        <div className="text-[10px] font-mono pr-2 flex items-center gap-3 drop-shadow pointer-events-auto theme-aware-meta">
          <span>{!isPsdOrPsb && imageSize ? `${imageSize.width}x${imageSize.height}` : (isRealSequence ? `Sequence (${effectiveMaxFrames} frames)` : fileName)}</span>
          {isRealSequence && <span>fps: {playbackFps}</span>}
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex relative checkerboard">
        
        {/* Main Viewport */}
        <div
          className={`flex-1 w-full h-full flex justify-center items-center relative group ${isEyeDropperActive ? "cursor-crosshair" : ""}`}
          onClick={(e) => {
            if (isEyeDropperActive) {
              if (eyedropperColor) {
                navigator.clipboard.writeText(eyedropperColor.hex);
                setCopiedHex(eyedropperColor.hex);
                setTimeout(() => setCopiedHex(null), 2000);
              }
              setIsEyeDropperActive(false);
              return;
            }
            if (e.target !== e.currentTarget && (e.target as HTMLElement).closest('.overlay-ui')) return;
            if (isRealSequence) {
              if (playbackPhase === 'warmup') return; // ignore during warmup
              if (!isPlaying) startWarmup();
              else setIsPlaying(false);
            } else {
              setIsPlaying(!isPlaying);
            }
          }}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={(e) => {
            handleMouseMove(e);
            if (!isEyeDropperActive) return;

            const img = imgRef.current;
            if (!img || !img.naturalWidth) { setEyedropperColor(null); return; }

            // Get the image's exact rendered position and size
            const imgRect = img.getBoundingClientRect();
            const iw = img.naturalWidth, ih = img.naturalHeight;

            // Map mouse to image-relative coordinates
            const mouseIX = e.clientX - imgRect.left;
            const mouseIY = e.clientY - imgRect.top;

            // Check if within image bounds
            if (mouseIX < 0 || mouseIX >= imgRect.width || mouseIY < 0 || mouseIY >= imgRect.height) {
              setEyedropperColor(null);
              return;
            }

            // Scale to image element coordinate space (accounts for CSS max-w/max-h scaling)
            const imgX = mouseIX * iw / imgRect.width;
            const imgY = mouseIY * ih / imgRect.height;

            const tmpCanvas = document.createElement("canvas");
            tmpCanvas.width = 1;
            tmpCanvas.height = 1;
            const tmpCtx = tmpCanvas.getContext("2d", { willReadFrequently: true });
            if (!tmpCtx) { setEyedropperColor(null); return; }

            try {
              tmpCtx.drawImage(img, imgX, imgY, 1, 1, 0, 0, 1, 1);
              const pixel = tmpCtx.getImageData(0, 0, 1, 1).data;
              if (pixel[3] === 0) { setEyedropperColor(null); return; }

              const r = pixel[0], g = pixel[1], b = pixel[2];
              const hex = "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1).toUpperCase();
              const r2 = r / 255, g2 = g / 255, b2 = b / 255;
              const max2 = Math.max(r2, g2, b2), min2 = Math.min(r2, g2, b2);
              const l2 = (max2 + min2) / 2;
              let s2 = 0, h2 = 0;
              if (max2 !== min2) {
                const d2 = max2 - min2;
                s2 = l2 > 0.5 ? d2 / (2 - max2 - min2) : d2 / (max2 + min2);
                if (max2 === r2) h2 = ((g2 - b2) / d2 + (g2 < b2 ? 6 : 0)) / 6;
                else if (max2 === g2) h2 = ((b2 - r2) / d2 + 2) / 6;
                else h2 = ((r2 - g2) / d2 + 4) / 6;
              }
              setEyedropperColor({ hex, rgb: `rgb(${r}, ${g}, ${b})`, hsl: `hsl(${Math.round(h2 * 360)}, ${Math.round(s2 * 100)}%, ${Math.round(l2 * 100)}%)`, r, g, b });
            } catch {
              setEyedropperColor(null);
            }
          }}
          onMouseLeave={(e) => {
            if (isEyeDropperActive) setEyedropperColor(null);
            if (panRef.current.isDragging) {
              panRef.current.isDragging = false;
            }
          }}
        >
          <div
            className="absolute inset-0 flex flex-col items-center justify-center transition-transform duration-75 will-change-transform"
            style={{
              transform: `translate(${panOffset.x}px, ${panOffset.y}px) ${zoom === "Fit" ? "" : `scale(${activeZoomScale})`}`,
            }}
          >
            {/* Loading state with optional progress bar for heavy files */}
            {loadingImage && !imageDataUrl && (
              <div className="flex flex-col items-center justify-center">
                {/* Progress bar for heavy formats (PSD/AI/EPS) */}
                {loadingProgress !== null ? (
                  <div className="flex flex-col items-center gap-3">
                    {/* Progress bar track */}
                    <div className="w-64 h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--row-bg)' }}>
                      <div
                        className="h-full rounded-full transition-all duration-300 ease-out"
                        style={{
                          width: `${loadingProgress}%`,
                          background: `linear-gradient(90deg, ${accentColor} 0%, ${accentColor}dd 50%, ${accentColor}88 100%)`,
                        }}
                      />
                    </div>
                    {/* Stage message + percentage */}
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-stone-400 text-xs font-mono tabular-nums">
                        {loadingProgress < 100 ? `${loadingProgress}%` : "Done"}
                      </span>
                      {decodeStageMessage && loadingProgress < 100 && (
                        <span className="text-stone-500 text-[11px] font-mono italic">
                          {decodeStageMessage}
                        </span>
                      )}
                      {loadingProgress >= 100 && decodeStageMessage && (
                        <span className="text-stone-500 text-[11px] font-mono">
                          {decodeStageMessage}
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mb-2" style={{ borderColor: accentColor, borderTopColor: "transparent" }}></div>
                    <span className="text-stone-500 text-xs font-mono">Loading...</span>
                  </>
                )}
              </div>
            )}

            {/* Warmup overlay - shown while preloading the whole sequence for
                smooth playback. Covers the viewport so user sees a progress
                bar instead of black flicker on first play. */}
            {playbackPhase === 'warmup' && (
              <div
                className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-auto"
                style={{ backgroundColor: 'var(--app-bg)' }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex flex-col items-center gap-3 w-full max-w-sm px-8">
                  <div
                    className="text-[10px] font-mono uppercase tracking-widest"
                    style={{ color: 'var(--fg-2)' }}
                  >
                    Preloading sequence
                  </div>
                  <div
                    className="w-full h-1.5 rounded-full overflow-hidden"
                    style={{ backgroundColor: 'var(--stroke-1)' }}
                  >
                    <div
                      className="h-full transition-all duration-200 ease-out rounded-full"
                      style={{
                        width: `${warmupProgress}%`,
                        background: `linear-gradient(90deg, ${accentColor} 0%, ${accentColor}dd 100%)`
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between w-full text-[10px] font-mono">
                    <span style={{ color: accentColor }}>{warmupProgress.toFixed(1)}%</span>
                    <span style={{ color: 'var(--fg-2)' }}>
                      {framesLoaded} / {effectiveMaxFrames} frames
                    </span>
                  </div>
                  <div
                    className="text-[9px] font-mono mt-1"
                    style={{ color: 'var(--fg-2)' }}
                  >
                    Preparing for smooth playback…
                  </div>
                </div>
              </div>
            )}

            {/* Show image when ready (both still images and sequence frames) */}
            {!loadingImage && imageDataUrl && !imageError ? (
              <>
                <img
                  ref={imgRef}
                  src={imageDataUrl}
                  alt={fileName}
                  className="max-w-full max-h-full object-contain"
                  style={{ imageRendering: 'auto' }}
                />
                <canvas ref={colorPickerCanvasRef} style={{ display: "none" }} />
              </>
            ) : imageError && !loadingImage ? (
              /* Error state */
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-[var(--app-bg)] text-stone-400">
                <div className="text-4xl mb-2">⚠️</div>
                <div className="text-xs font-mono">Failed to load image</div>
                <div className="text-[10px] text-stone-500 mt-1">{fileName}</div>
              </div>
            ) : null}

          </div>

          {/* Central play overlay removed — paused previews now keep their
              full brightness and do not show a dimming tint or play badge.
              The spacebar / play button in the toolbar still controls playback. */}

          {/* Eyedropper Floating Tooltip */}
          {(isEyeDropperActive || copiedHex) && eyedropperColor && (
            <div className="absolute top-4 left-4 z-50 pointer-events-none border shadow-2xl rounded overflow-hidden flex flex-col p-1" style={{ backgroundColor: 'var(--row-bg)', borderColor: 'var(--stroke-1)' }}>
               <div className="flex gap-2 items-center p-1">
                 <div className="w-8 h-8 rounded border" style={{ backgroundColor: eyedropperColor.hex, borderColor: 'var(--stroke-1)' }} />
                 <div className="flex flex-col w-20 relative">
                   {copiedHex ? (
                     <span className="font-mono text-[10px] font-bold px-1 rounded inline-block w-fit" style={{ color: accentColor, backgroundColor: `${accentColor}20` }}>Copied!</span>
                   ) : (
                     <span className="font-mono text-[10px]" style={{ color: accentColor }}>{eyedropperColor.hex}</span>
                   )}
                   <span className="font-mono text-[9px] text-stone-400">{eyedropperColor.rgb}</span>
                 </div>
               </div>
            </div>
          )}

          {/* Color Picker Overlay */}
          {showColors && colors.length > 0 && (
            <div className="overlay-ui absolute top-10 right-4 p-3 rounded-xl fluent-menu color-picker-panel border shadow-2xl z-30 cursor-default" style={{ borderColor: 'var(--stroke-1)' }} onClick={e => e.stopPropagation()}>
              <div className="flex flex-col gap-1">
                {colors.map((c, i) => {
                  const isExpanded = expandedColorIndex === i;
                  return (
                    <div key={i} className={`flex items-center gap-2 cursor-pointer rounded-lg transition-all ${isExpanded ? "bg-white/8 p-2" : "p-1.5 hover:bg-white/5"}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isExpanded) {
                          navigator.clipboard.writeText(c.hex).then(() => {
                            setCopiedHex(c.hex);
                            setTimeout(() => setCopiedHex(null), 1500);
                          }).catch(() => {});
                          setExpandedColorIndex(null);
                        } else {
                          setExpandedColorIndex(i);
                        }
                      }}
                    >
                      <div className="w-7 h-7 rounded-md border border-white/15 flex-shrink-0 shadow-inner" style={{ backgroundColor: c.hex }} />
                      {isExpanded ? (
                        <div className="flex flex-col gap-0.5 flex-1">
                          {(([["HEX", c.hex], ["RGB", `${c.r ?? 0}, ${c.g ?? 0}, ${c.b ?? 0}`], ["HSL", c.hsl]] as [string, string][])).map(([label, val]) => (
                            <div key={label} className="flex items-center justify-between gap-4">
                              <span className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--fg-2)' }}>{label}</span>
                              <span className="text-[10px] font-mono" style={{ color: 'var(--fg-1)' }}>{val}</span>
                            </div>
                          ))}
                          {copiedHex === c.hex && <div className="text-[9px] mt-0.5" style={{ color: accentColor }}>Copied!</div>}
                        </div>
                      ) : (
                        <span className="text-[10px] font-mono" style={{ color: 'var(--fg-2)' }}>{c.hex}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Control Bar */}
      <div className="h-12 shrink-0 border-t flex items-center px-4 justify-between select-none space-x-1 relative z-50" style={{ backgroundColor: 'var(--header-bg)', borderColor: 'var(--stroke-1)' }}>
        
        <div className="flex items-center gap-2">
          {isSequence ? (
            <div className="flex items-center gap-1">
              {/* Play/Pause */}
              <button 
                onClick={() => {
                  if (playbackPhase === 'warmup') return; // ignore during warmup
                  if (!isPlaying) startWarmup();
                  else setIsPlaying(false);
                }} 
                className="p-1.5 rounded transition-colors" 
                style={{ color: accentColor, backgroundColor: 'var(--surface-bg)' }} 
                title={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </button>

              <button onClick={() => { setIsPlaying(false); setCurrentFrame(f => Math.max(0, f - playbackFps)); }} className="p-1 rounded text-stone-400 transition-colors hover:text-white" style={{}}>
                <ChevronsLeft className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => { setIsPlaying(false); setCurrentFrame(f => Math.max(0, f - 1)); }} className="p-1 rounded text-stone-400 transition-colors hover:text-white" style={{}}>
                <ChevronLeft className="w-4 h-4" />
              </button>

              {/* Frame number chip — click to edit, Enter to jump, Esc to cancel.
                  Always displays a zero-padded frame count (e.g. 00000000), never
                  the HH:MM:SS:FF timecode form. */}
              <div
                className="rounded px-2 py-1 mx-2 flex items-center font-mono text-[10px] cursor-text transition-colors border"
                style={{ backgroundColor: 'var(--row-bg)', borderColor: 'var(--stroke-1)' }}
                onClick={(e) => {
                  // Don't re-trigger when the user clicks inside the live input
                  if ((e.target as HTMLElement).tagName === "INPUT") return;
                  e.stopPropagation();
                  setIsPlaying(false);
                  setEditTimeValue(formatFrames(currentFrame));
                  setIsEditingTime(true);
                  // focus + select on next tick
                  requestAnimationFrame(() => {
                    const el = document.getElementById("imgseq-frame-input") as HTMLInputElement | null;
                    el?.focus();
                    el?.select();
                  });
                }}
              >
                {isEditingTime ? (
                  <input
                    id="imgseq-frame-input"
                    type="text"
                    inputMode="numeric"
                    value={editTimeValue}
                    onChange={(e) => setEditTimeValue(e.target.value.replace(/[^0-9]/g, ""))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        setCurrentFrame(parseFrameInput(editTimeValue));
                        setIsEditingTime(false);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setIsEditingTime(false);
                      }
                    }}
                    onBlur={() => {
                      setCurrentFrame(parseFrameInput(editTimeValue));
                      setIsEditingTime(false);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="bg-transparent outline-none border-none w-20 text-center font-mono"
                    style={{ color: accentColor }}
                    maxLength={String(effectiveMaxFrames).length}
                  />
                ) : (
                  <span className="text-stone-400 select-none">
                    {formatFrames(currentFrame)}
                  </span>
                )}
              </div>

               <button onClick={() => { setIsPlaying(false); setCurrentFrame(f => Math.min(effectiveMaxFrames - 1, f + 1)); }} className="p-1 rounded text-stone-400 transition-colors hover:text-white" style={{}}>
                 <ChevronRight className="w-4 h-4" />
               </button>
               <button onClick={() => { setIsPlaying(false); setCurrentFrame(f => Math.min(effectiveMaxFrames - 1, f + playbackFps)); }} className="p-1 rounded text-stone-400 transition-colors hover:text-white" style={{}}>
                 <ChevronsRight className="w-3.5 h-3.5" />
               </button>
            </div>
          ) : (
             <div className="font-mono text-[10px] text-stone-500 px-2 py-1 rounded border" style={{ backgroundColor: 'var(--row-bg)', borderColor: 'var(--stroke-1)' }}>Still Image</div>
          )}
        </div>

        <div className="flex items-center gap-1.5">
           <div className="relative">
             <button 
               onClick={() => setShowZoomMenu(!showZoomMenu)}
               onBlur={() => setTimeout(() => setShowZoomMenu(false), 150)}
               className="rounded px-2 py-1 flex items-center gap-1 font-mono text-[10px] transition-colors border"
               style={{ backgroundColor: 'var(--row-bg)', borderColor: 'var(--stroke-1)', color: accentColor }}
             >
               <span>{zoom === "Fit" ? "Fit" : `${Math.round(zoom * 100)}%`}</span>
               <ChevronDown className="w-3 h-3 text-stone-500" />
             </button>
             
             {showZoomMenu && (
               <div className="absolute bottom-full mb-1 right-0 w-24 rounded py-1 shadow-2xl z-40 border" style={{ backgroundColor: 'var(--row-bg)', borderColor: 'var(--stroke-1)' }}>
                 {[ { label: "Custom", val: "Fit" } as const, { label: "25%", val: 0.25 }, { label: "50%", val: 0.5 }, { label: "125%", val: 1.25 }, { label: "200%", val: 2.0 }, ].map(o => (
                  <button
                    key={o.label}
                    className={`w-full text-left px-3 py-1 text-[10px] font-mono ${zoom === o.val ? "text-white" : ""}`}
                    style={zoom === o.val ? { backgroundColor: `${accentColor}50`, color: '#fff' } : { color: accentColor }}
                    onClick={() => {
                      setZoom(o.val);
                      if (o.val === "Fit") {
                        setPanOffset({ x: 0, y: 0 });
                      }
                    }}
                  >{o.label}</button>
                 ))}
               </div>
             )}
           </div>

          {/* Color Picker */}
           <button
            onClick={() => setShowColors(!showColors)}
            className={`p-1.5 rounded transition-colors ${showColors ? '' : 'text-stone-400'}`}
            style={showColors ? { backgroundColor: `${accentColor}30`, color: accentColor } : {}}
             title="Color Picker"
           >
             <Palette className="w-3.5 h-3.5" />
           </button>

           {/* Eyedropper */}
           <button
             onClick={() => setIsEyeDropperActive(!isEyeDropperActive)}
             className={`p-1.5 rounded transition-colors ${isEyeDropperActive ? '' : 'theme-aware-icon'}`}
             style={isEyeDropperActive ? { backgroundColor: `${accentColor}30`, color: accentColor } : {}}
             title="Eye Dropper"
           >
             <Pipette className="w-3.5 h-3.5" />
           </button>

          {/* Loop — only for sequences */}
          {isRealSequence && (
            <button
              onClick={() => setIsLooping(!isLooping)}
              className={`p-1.5 rounded transition-colors ${isLooping ? 'text-sky-400' : 'text-stone-400'}`}
              style={isLooping ? { backgroundColor: `${accentColor}30` } : {}}
              title="Loop"
            >
              <Repeat className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Playback FPS — only for sequences */}
          {isRealSequence && (
            <select
              value={playbackFps}
              onChange={(e) => setPlaybackFps(Number(e.target.value) as PlaybackFPS)}
              className="rounded px-1.5 py-1 font-mono text-[10px] transition-colors cursor-pointer outline-none border"
              style={{ backgroundColor: 'var(--row-bg)', borderColor: 'var(--stroke-1)', color: accentColor }}
              title="Playback FPS"
            >
              {PLAYBACK_FPS_OPTIONS.map(fps => (
                <option key={fps} value={fps} style={{ backgroundColor: 'var(--row-bg)' }}>{fps}</option>
              ))}
            </select>
          )}

           <button
             onClick={handleFocusViewToggle}
             className={`p-1.5 rounded transition-colors ${isFocusView ? 'text-white' : 'text-stone-400'}`}
             style={isFocusView ? { backgroundColor: `${accentColor}30` } : {}}
           >
              <MonitorPlay className="w-3.5 h-3.5" />
           </button>

           <button onClick={handleFullscreen} className="p-1.5 rounded text-stone-400 transition-colors hover:text-white">
              <Maximize className="w-3.5 h-3.5" />
           </button>
        </div>
      </div>
      
      {/* Progress Bar scrubber */}
      {isRealSequence && (
        <div
          className="absolute bottom-[48px] left-0 w-full h-3 cursor-pointer group z-50 border-t border-b"
          style={{ backgroundColor: 'var(--row-bg)', borderColor: 'var(--stroke-1)' }}
          onClick={(e) => {
            if (playbackPhase === 'warmup') {
              warmupCancelRef.current = true;
              setPlaybackPhase('idle');
              setWarmupProgress(0);
              setFramesLoaded(0);
            }
            const rect = e.currentTarget.getBoundingClientRect();
            const percent = (e.clientX - rect.left) / rect.width;
            setCurrentFrame(Math.floor(Math.max(0, Math.min(1, percent)) * effectiveMaxFrames));
          }}
          onMouseMove={(e) => {
            if (e.buttons === 1) {
              const rect = e.currentTarget.getBoundingClientRect();
              const percent = (e.clientX - rect.left) / rect.width;
              setCurrentFrame(Math.floor(Math.max(0, Math.min(1, percent)) * effectiveMaxFrames));
            }
          }}
        >
          <div
            className="h-full group-hover:opacity-80 transition-colors"
            style={{ width: `${(currentFrame / Math.max(1, effectiveMaxFrames - 1)) * 100}%`, backgroundColor: accentColor }}
          />
        </div>
      )}
    </div>
  );
}
