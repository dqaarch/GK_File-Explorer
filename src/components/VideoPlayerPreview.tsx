import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Play, Pause, Maximize, Volume2, VolumeX, Repeat, Palette, Pipette, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, MonitorPlay, ChevronDown } from "lucide-react";
import * as MP4Box from "mp4box";

interface VideoPlayerPreviewProps {
  fileName: string;
  filePath?: string;
  accentColor: string;
}

interface ColorInfo {
  hex: string;
  rgb: string;
  hsl: string;
  r: number;
  g: number;
  b: number;
}

const BASE_FPS = 29.97;
const MOCK_WIDTH = 1920;
const MOCK_HEIGHT = 1080;

const HTTP_SERVER = "http://localhost:18765";

function extractVideoFps(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const encodedPath = encodeURIComponent(filePath);
    const src = `${HTTP_SERVER}/video/stream?path=${encodedPath}&t=${Date.now()}`;

    const xhr = new XMLHttpRequest();
    xhr.open('GET', src, true);
    xhr.responseType = 'arraybuffer';

    xhr.onprogress = (e) => {
      if (e.lengthComputable) {
        const ratio = e.loaded / e.total;
        if (ratio >= 0.05) xhr.abort();
      }
    };

    xhr.onload = () => {
      if (xhr.status !== 200 && xhr.status !== 0) { resolve(null); return; }
      try {
        const rawBuffer = xhr.response as ArrayBuffer & { fileStart?: number };
        rawBuffer.fileStart = 0;
        const mp4boxFile = (MP4Box as any).createFile();
        (mp4boxFile as any).onError = () => resolve(null);
        (mp4boxFile as any).onReady = (info: any) => {
          const track = info.videoTracks[0];
          if (!track) { resolve(null); return; }
          const durationSec = track.duration / track.timescale;
          const fps = durationSec > 0 ? Math.round(track.nb_samples / durationSec) : 0;
          resolve(fps > 0 && fps < 240 ? fps : null);
        };
        (mp4boxFile as any).appendBuffer(rawBuffer);
        (mp4boxFile as any).flush();
      } catch {
        resolve(null);
      }
    };
    xhr.onerror = () => resolve(null);
    xhr.send();
  });
}

function getVideoStreamUrl(filePath: string): string {
  const encodedPath = encodeURIComponent(filePath);
  return `${HTTP_SERVER}/video/stream?path=${encodedPath}`;
}

async function getVideoInfo(filePath: string): Promise<any> {
  const encodedPath = encodeURIComponent(filePath);
  const url = `${HTTP_SERVER}/video/info?path=${encodedPath}`;
  try {
    const response = await fetch(url);
    if (response.ok) return await response.json();
  } catch (e) {
    console.warn("[VideoPlayer] Could not get video info:", e);
  }
  return null;
}

async function getTranscodeProgress(filePath: string): Promise<{
  percent: number;
  currentFrame: number;
  totalFrames: number;
  status: 'idle' | 'encoding' | 'complete' | 'failed' | 'not_found';
} | null> {
  const encodedPath = encodeURIComponent(filePath);
  const url = `${HTTP_SERVER}/transcode/progress?path=${encodedPath}`;
  try {
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      return {
        percent: data.percent || 0,
        currentFrame: data.current_frame || 0,
        totalFrames: data.total_frames || 0,
        status: data.status || 'not_found'
      };
    }
  } catch (e) {
    console.warn("[VideoPlayer] Could not get transcode progress:", e);
  }
  return null;
}

// Fire-and-forget cancel request. Called when the user navigates away from
// a file that's still transcoding — kills the FFmpeg child process on the
// backend so the next /video/stream request doesn't have to wait for it.
function cancelTranscode(filePath: string): void {
  const encodedPath = encodeURIComponent(filePath);
  const url = `${HTTP_SERVER}/transcode/cancel?path=${encodedPath}`;
  fetch(url, { method: 'GET', keepalive: true }).catch(() => {});
}

function rgbToHex(r: number, g: number, b: number) {
  return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1).toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified segment editor: handles both timecode (HH:MM:SS:FF) and frames (NNNNN)
// Uses the current editorMode prop to determine behavior
// ─────────────────────────────────────────────────────────────────────────────
interface SegmentEditorProps {
  value: string;       // current string value
  editorMode: "timecode" | "frames";
  totalFrames: number;  // for frame count display
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  accentColor?: string;
}

function SegmentEditor({ value, editorMode, totalFrames, onChange, onCommit, onCancel, accentColor = "#f97316" }: SegmentEditorProps) {
  const [activeSeg, setActiveSeg] = useState(0);
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

  // Frame-mode: entire value is just the frame string
  const frameValue = editorMode === "frames" ? value : "";
  const framePadLen = totalFrames > 0 ? String(totalFrames).length : 6;

  const updateSeg = (idx: number, raw: string) => {
    if (editorMode === "timecode") {
      const nums = raw.replace(/\D/g, "").slice(-2);
      const newSegs = [...segs];
      newSegs[idx] = nums.padStart(2, "0");
      onChange(newSegs.join(":"));
    } else {
      // Frames mode: allow all digits up to totalFrames digits
      const maxDigits = totalFrames > 0 ? String(totalFrames).length : 6;
      const nums = raw.replace(/\D/g, "").slice(0, maxDigits);
      onChange(nums);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      if (editorMode === "timecode") {
        if (idx < 2) setActiveSeg((idx + 1) as 0 | 1 | 2);
        else onCommit();
      } else {
        onCommit();
      }
    }
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    if (editorMode === "timecode" && e.key === ":") {
      e.preventDefault();
      if (idx < 2) setActiveSeg((idx + 1) as 0 | 1 | 2);
    }
  };

  if (editorMode === "frames") {
    return (
      <input
        ref={inputRef}
        type="text"
        maxLength={framePadLen}
        className="w-8 text-center outline-none bg-transparent font-mono text-[10px] rounded px-0.5"
        style={{ backgroundColor: accentColor + "20", color: accentColor, border: `1px solid ${accentColor}50` }}
        value={frameValue}
        onChange={(e) => updateSeg(0, e.target.value)}
        onKeyDown={(e) => handleKeyDown(e, 0)}
        onBlur={() => {
          setTimeout(() => {
            if (document.activeElement?.hasAttribute("data-seg-input")) return;
            onCommit();
          }, 50);
        }}
        data-seg-input
      />
    );
  }

  return (
    <div className="flex items-center gap-0.5 font-mono text-[10px]">
      {segs.map((seg, i) => {
        if (i === 3) {
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

// Format frame number as padded string
const formatVideoFrames = (frame: number, total: number): string => {
  return frame.toString().padStart(String(total).length, '0');
};

// Format frame number as HH:MM:SS:FF timecode
const formatVideoTimecode = (frame: number, fps: number): string => {
  const s = Math.floor((frame / fps) % 60);
  const m = Math.floor((frame / (fps * 60)) % 60);
  const h = Math.floor(frame / (fps * 3600));
  const f = Math.floor(frame % fps);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${f.toString().padStart(2, '0')}`;
};

// Parse HH:MM:SS:FF → frame number
const parseVideoTimecode = (input: string, fps: number): number => {
  const parts = input.split(":");
  if (parts.length === 4) {
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    const s = parseInt(parts[2], 10) || 0;
    const f = parseInt(parts[3], 10) || 0;
    return Math.round(h * 3600 * fps + m * 60 * fps + s * fps + f);
  }
  return 0;
};

export default function VideoPlayerPreview({ fileName, filePath, accentColor }: VideoPlayerPreviewProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [zoom, setZoom] = useState<number | "Fit">("Fit");
  const [isLooping, setIsLooping] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [isFocusView, setIsFocusView] = useState(false);
  const [isEyeDropperActive, setIsEyeDropperActive] = useState(false);
  const [eyedropperColor, setEyedropperColor] = useState<ColorInfo | null>(null);
  const [copiedHex, setCopiedHex] = useState<string | null>(null);
  const [colors, setColors] = useState<ColorInfo[]>([]);
  const [showColors, setShowColors] = useState(false);
  const [expandedColorIndex, setExpandedColorIndex] = useState<number | null>(null);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoFps, setVideoFps] = useState<number | null>(null);
  const [userFps, setUserFps] = useState<number>(BASE_FPS);
  const [loadingVideo, setLoadingVideo] = useState(false);
  // `buffering` is a lighter-weight indicator: the user is already playing
  // (or has scrubbed) and the browser just needs a moment to fill the buffer.
  // We surface it as a small bottom-center badge instead of the fullscreen
  // transcode overlay so the scrub timeline stays visible and usable.
  const [buffering, setBuffering] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  // The URL we hand to <video src>. Direct stream URL from the local HTTP
  // server — NOT a blob: URL. The backend streams from disk via tiny_http's
  // Response::from_file so bytes flow to the browser as soon as the first
  // chunk is read, instead of waiting for the whole file to be loaded into
  // RAM. The browser's native HTML5 video pipeline handles playback start
  // as soon as it has buffered enough media data.
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [showZoomMenu, setShowZoomMenu] = useState(false);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [timeMode, setTimeMode] = useState<"timecode" | "frames">("frames");
  const [isEditingTime, setIsEditingTime] = useState(false);
  const [editTimeValue, setEditTimeValue] = useState("");
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panRef = useRef({ isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 });

  // Transcode progress state
  const [transcodeProgress, setTranscodeProgress] = useState<{
    percent: number;
    currentFrame: number;
    totalFrames: number;
    status: 'idle' | 'encoding' | 'complete' | 'failed' | 'not_found';
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const colorPickerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameSteppingRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);
  const currentFrameRef = useRef(0);
  // requestAnimationFrame handle for the playback-driven frame counter. The
  // browser's `timeupdate` event fires only every ~250ms (~7-8 frames at 30fps),
  // which made the on-screen frame counter visibly jump in chunks. Instead we
  // poll currentTime in rAF (every browser paint) and update the frame counter
  // from that — every visual frame increments the counter by 1 while playing.
  const rafIdRef = useRef<number | null>(null);

  // Mirror of filePath that's mutated synchronously inside the load effect,
  // BEFORE the async fetch starts. Used by the cleanup function to know the
  // PREVIOUS filePath when filePath changes — React's effect cleanup runs
  // AFTER the new render has already updated the closure variable, so reading
  // `filePath` directly there would return the new path, not the one we want
  // to cancel.
  const filePathRef = useRef<string | null>(null);

  // Effective FPS: extracted FPS takes priority over user FPS
  const effectiveFps = videoFps !== null ? videoFps : userFps;

  // Load video when filePath changes.
  //
  // Strategy: DON'T load video immediately. Video only loads when user clicks
  // play or clicks on the viewport (like image sequence player). This prevents
  // unnecessary transcode for MOV/MKV files until the user actually wants to play.
  useEffect(() => {
    // Capture the previous filePath BEFORE we overwrite the ref. This is the
    // value the cleanup will cancel when this effect re-runs or unmounts.
    const previousPath = filePathRef.current;

    if (!filePath) {
      setVideoSrc(null);
      filePathRef.current = null;
      // If we had a previous path, cancel its transcode now.
      if (previousPath) {
        cancelTranscode(previousPath);
      }
      return;
    }

    filePathRef.current = filePath;

    // Reset state but DON'T load video yet - wait for user interaction
    setLoadingVideo(false);
    setVideoError(false);
    setIsPlaying(false);
    setCurrentFrame(0);
    setTranscodeProgress(null);
    setVideoSrc(null); // Clear video src so play overlay shows

    // Cleanup: cancel the transcode for whatever filePath was active when
    // this effect ran.
    return () => {
      if (previousPath && previousPath !== filePath) {
        cancelTranscode(previousPath);
      } else if (filePath) {
        cancelTranscode(filePath);
      }
    };
  }, [filePath]);

  // Start video playback - triggers transcode and loads video
  const startPlayback = useCallback(() => {
    if (!filePath || videoSrc) return; // Already loaded or no file
    
    setLoadingVideo(true);
    setVideoError(false);
    setTranscodeProgress(null);

    // Build the stream URL with a cache-buster so the browser never replays
    // a cached MP4 for a different source file.
    const encodedPath = encodeURIComponent(filePath);
    const url = `${HTTP_SERVER}/video/stream?path=${encodedPath}&t=${Date.now()}`;
    console.log("[VideoPlayerPreview] start playback", { filePath, url });
    setVideoSrc(url);
  }, [filePath, videoSrc]);

  // Reset the <video> element on filePath change. Documented workaround
  // for the Chrome / WebView2 "request stays pending forever" bug:
  //   https://stackoverflow.com/q/16137381
  useEffect(() => {
    return () => {
      const v = videoRef.current;
      if (!v) return;
      try {
        v.pause();
        v.removeAttribute('src');
        v.load();
      } catch {
        // ignore — element may already be detached
      }
    };
  }, [filePath]);

  // Fetch FPS and video metadata from backend, with MP4Box client-side fallback
  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    const encodedPath = encodeURIComponent(filePath);
    // Cache-buster so we always re-read ffprobe metadata for the current file
    const url = `${HTTP_SERVER}/video/info?path=${encodedPath}&t=${Date.now()}`;
    fetch(url)
      .then(res => {
        return res.json();
      })
      .then(info => {
        if (cancelled) return;
        if (info?.fps && info.fps > 0) {
          setVideoFps(info.fps);
          setUserFps(info.fps);
        } else {
          extractVideoFps(filePath).then(fps => {
            if (cancelled || !fps) return;
            setVideoFps(fps);
            setUserFps(fps);
          });
        }
        if (info?.width && info?.height) setVideoSize({ width: info.width, height: info.height });
        if (info?.duration) setVideoDuration(info.duration);
      })
      .catch(e => {
        console.error("[VideoPlayer] Backend unavailable, trying MP4Box fallback:", e);
        extractVideoFps(filePath).then(fps => {
          if (cancelled || !fps) return;
          setVideoFps(fps);
          setUserFps(fps);
        });
      });
    return () => { cancelled = true; };
  }, [filePath]);

  // Poll transcode progress while video is loading.
//
// Note: we NO LONGER use the poll result to trigger a video element reload.
  // With the fetch() → Blob → blob: URL flow, the fetch() blocks until the
  // cache is ready, then resolves with the full MP4 — no reload needed. We
  // only poll here so the spinner can show real FFmpeg progress to the user
  // (and so we can detect a failed transcode and surface an error).
  // Ref shared with the poll loop: when the <video> fires `canplay`, we set
  // this to true and the next tick of the interval clears itself, so we
  // stop polling as soon as playback can begin.
  const videoReadyRef = useRef(false);
  // Refs mirror values read inside long-lived callbacks/intervals so we
  // don't have to re-create the interval every time the underlying state
  // changes (which would reset the 1Hz cadence and cause flicker in the
  // colors panel).
  const showColorsRef = useRef(false);
  showColorsRef.current = showColors;
  const isEyeDropperActiveRef = useRef(false);
  isEyeDropperActiveRef.current = isEyeDropperActive;
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onCanPlay = () => {
      console.log("[VideoPlayerPreview] videoReady=true, polling will stop next tick");
      videoReadyRef.current = true;
    };
    v.addEventListener("canplay", onCanPlay);
    return () => v.removeEventListener("canplay", onCanPlay);
  }, [videoSrc]);

  useEffect(() => {
    if (!filePath) {
      setTranscodeProgress(null);
      console.log("[VideoPlayerPreview] polling: no filePath, cleared");
      return;
    }

    console.log("[VideoPlayerPreview] polling: START for", filePath);
    setTranscodeProgress(null);
    videoReadyRef.current = false;

    let cancelled = false;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let pollCount = 0;

    const startPolling = () => {
      // Backend writes the full MP4 to disk before responding to /video/stream,
      // so the browser only fires canplay once the cache file is complete
      // and ready to play with correct duration. We stop polling the moment
      // the <video> reports it can play.
      pollInterval = setInterval(async () => {
        if (cancelled) return;
        if (videoReadyRef.current) {
          console.log("[VideoPlayerPreview] poll: STOP (video ready)");
          if (pollInterval) clearInterval(pollInterval);
          return;
        }
        pollCount++;

        try {
          const progress = await getTranscodeProgress(filePath);
          if (cancelled) return;

          console.log(`[VideoPlayerPreview] poll #${pollCount}:`, progress);

            if (progress) {
            setTranscodeProgress(progress);

            if (progress.status === 'complete') {
              console.log("[VideoPlayerPreview] poll: transcode COMPLETE");
              if (pollInterval) clearInterval(pollInterval);
              // Clear the encoding state so the progress bar doesn't
              // reappear when the user later scrubs the timeline. Once
              // playback starts we don't want the overlay to claim
              // "Transcoding…" anymore.
              setTranscodeProgress(null);
              // If the <video> already fired canplay (cache file was
              // served quickly while we were still polling), close the
              // overlay immediately. Otherwise the overlay will be closed
              // by onCanPlay as soon as the browser has the MP4 buffered.
              if (videoReadyRef.current) {
                setLoadingVideo(false);
              }
            } else if (progress.status === 'failed') {
              console.log("[VideoPlayerPreview] poll: transcode FAILED");
              if (pollInterval) clearInterval(pollInterval);
              setLoadingVideo(false);
              setVideoError(true);
            }
            // 'not_found' is NOT a terminal state — keep polling.
            // 'encoding' keeps polling automatically.
          } else {
            console.log(`[VideoPlayerPreview] poll #${pollCount}: null response`);
          }
        } catch (e) {
          console.error("[VideoPlayerPreview] poll error:", e);
        }
      }, 500);
    };

    startPolling();

    return () => {
      console.log("[VideoPlayerPreview] polling: STOP (cleanup)");
      cancelled = true;
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [filePath]);

  // Stop polling when video error occurs
  useEffect(() => {
    if (videoError) {
      setTranscodeProgress(null);
    }
  }, [videoError]);

  // ============================================================
  // Video event handlers — matching V1 logic exactly
  // ============================================================

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.duration || effectiveFps === null) return;
    setCurrentTime(video.currentTime);
    const frame = Math.round(video.currentTime * effectiveFps);
    setCurrentFrame(frame);
    currentFrameRef.current = frame;
  }, [effectiveFps]);

  // Drive the on-screen frame counter from requestAnimationFrame so it
  // ticks once per browser paint (~16ms at 60Hz) instead of once every
  // ~250ms via the timeupdate event. Without this, the counter jumps in
  // chunks of 5-8 frames depending on FPS, which feels broken when
  // scrubbing. The loop is cheap: one Math.round + one setState per
  // frame, and React batches consecutive same-value updates away.
  useEffect(() => {
    if (!isPlaying) {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      return;
    }
    const tick = () => {
      const video = videoRef.current;
      if (!video || effectiveFps === null) {
        rafIdRef.current = requestAnimationFrame(tick);
        return;
      }
      const newFrame = Math.round(video.currentTime * effectiveFps);
      if (newFrame !== currentFrameRef.current) {
        currentFrameRef.current = newFrame;
        setCurrentFrame(newFrame);
        setCurrentTime(video.currentTime);
      }
      rafIdRef.current = requestAnimationFrame(tick);
    };
    rafIdRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [isPlaying, effectiveFps]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setLoadingVideo(false);
    setVideoDuration(video.duration);
    setVideoSize({ width: video.videoWidth, height: video.videoHeight });
    setCurrentFrame(0);
  }, []);

  const handlePlay = useCallback(() => setIsPlaying(true), []);
  const handlePause = useCallback(() => setIsPlaying(false), []);
  // handleWaiting is the inline onWaiting equivalent for any non-React path.
  // We only show the fullscreen loading overlay if the video hasn't played
  // yet (transcode still in flight). Once the user is already playing, a
  // `waiting` event is just a small buffer refill — handled by the bottom
  // badge so the scrub timeline stays usable.
  const handleWaiting = useCallback(() => {
    if (!videoReadyRef.current) {
      setLoadingVideo(true);
    } else {
      setBuffering(true);
    }
  }, []);
  const handleCanPlay = useCallback(() => {
    setLoadingVideo(false);
    setBuffering(false);
  }, []);

  const handleSeeking = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    // Only capture if not already stepping (goToFrame already set pendingSeekRef)
    if (pendingSeekRef.current !== null) return;
    const frame = Math.round(video.currentTime * effectiveFps);
    pendingSeekRef.current = frame;
  }, [effectiveFps]);

  const handleSeeked = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (frameSteppingRef.current) {
      const frame = pendingSeekRef.current ?? Math.round(video.currentTime * effectiveFps);
      setCurrentFrame(frame);
      currentFrameRef.current = frame;
      queueMicrotask(() => {
        frameSteppingRef.current = false;
        pendingSeekRef.current = null;
      });
      return;
    }
    // Normal seek (e.g., scrubbing via progress bar)
    const frame = Math.round(video.currentTime * effectiveFps);
    setCurrentFrame(frame);
    currentFrameRef.current = frame;
    pendingSeekRef.current = null;
  }, [effectiveFps]);

  const handleEnded = useCallback(() => {
    setCurrentFrame(0);
    currentFrameRef.current = 0;
    pendingSeekRef.current = null;
    setIsPlaying(false);
  }, []);

  // ============================================================
  // Seek — matching V1 logic exactly
  // ============================================================

  const seek = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    const clamped = Math.max(0, Math.min(time, video.duration));
    video.currentTime = clamped;
    // Update state immediately so frame/time display reflects the seeked position without waiting for onTimeUpdate
    setCurrentTime(clamped);
    if (effectiveFps !== null) {
      const frame = Math.round(clamped * effectiveFps);
      setCurrentFrame(frame);
      currentFrameRef.current = frame;
    }
  }, [effectiveFps]);

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(ratio * video.duration);
  }, [seek]);

  const handleProgressDrag = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const video = videoRef.current;
    if (!video || !video.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(ratio * video.duration);
  }, [isDragging, seek]);

  // ============================================================
  // Frame navigation — matching V1 logic exactly
  // ============================================================

  const goToFrame = useCallback((frame: number) => {
    const video = videoRef.current;
    if (!video || !video.duration || effectiveFps === null) return;
    const totalFrames = Math.round(video.duration * effectiveFps);
    const clamped = Math.max(0, Math.min(frame, totalFrames));
    const targetTime = clamped / effectiveFps;
    pendingSeekRef.current = clamped;
    frameSteppingRef.current = true;
    video.pause();
    video.currentTime = targetTime;
    // Update all frame/time state immediately so display is always in sync
    setCurrentTime(targetTime);
    setCurrentFrame(clamped);
    currentFrameRef.current = clamped;
  }, [effectiveFps]);

  const goNextFrame = useCallback(() => {
    goToFrame(currentFrameRef.current + 1);
  }, [goToFrame]);

  const goPrevFrame = useCallback(() => {
    goToFrame(currentFrameRef.current - 1);
  }, [goToFrame]);

  // Skip — matching V1: calls seek(currentTime + secs)
  const skip = useCallback((secs: number) => {
    const video = videoRef.current;
    if (!video) return;
    seek(video.currentTime + secs);
  }, [seek]);

  // ============================================================
  // Color extraction (non-VP, preserve from original)
  // ============================================================

  function rgbToHslString(r: number, g: number, b: number): string {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;

    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
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
    return centroids.map(c => ({
      hex: rgbToHex(c[0], c[1], c[2]),
      rgb: `rgb(${c[0]}, ${c[1]}, ${c[2]})`,
      hsl: rgbToHslString(c[0], c[1], c[2]),
      r: c[0], g: c[1], b: c[2],
    }));
  }

  // Eyedropper uses elementFromPoint — no canvas needed

  // Color extraction via setInterval (1Hz). The previous implementation
// used `requestVideoFrameCallback`, which has two practical problems
// here:
//
//   1. rVFC only fires while the video is actually playing / scrubbing.
//      If the user opens the file, hits pause, then toggles the color
//      picker on, `colors` stays `[]` forever (because no frame ever
//      fires) and the panel condition `{showColors && colors.length > 0}`
//      keeps hiding the panel — so users see "the color picker doesn't
//      work". The 1Hz interval, by contrast, samples whatever the
//      video element currently displays, paused or not.
//
//   2. The previous implementation registered rVFC inside `updateFrame`
//      itself, never called `cancelVideoFrameCallback`, and the effect
//      had `showColors` in its dependency array, so toggling showColors
//      re-ran the effect and accumulated parallel rVFC chains (each
//      one calling `setColors` in parallel) with no way to stop them.
//      That's a leak that gets worse the more the user toggled the
//      toggle.
//
// We also keep `setColors` outside the interval callback to read fresh
// state on every tick, and we extract only when `showColors` is true
// (no point burning CPU on background extraction when the panel is
// hidden). Skipping while eyedropper is active avoids racing the
// eyedropper's pixel read.
useEffect(() => {
    const video = videoRef.current;
    const colorCanvas = colorPickerCanvasRef.current;
    if (!video || !colorCanvas || !videoSrc) return;

    const colorCtx = colorCanvas.getContext("2d", { willReadFrequently: true });
    const sample = () => {
      if (!showColorsRef.current || isEyeDropperActiveRef.current) return;
      if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;
      const w = 80;
      const h = Math.max(1, Math.round(80 * video.videoHeight / video.videoWidth));
      if (colorCanvas.width !== w) colorCanvas.width = w;
      if (colorCanvas.height !== h) colorCanvas.height = h;
      if (!colorCtx) return;
      try {
        colorCtx.drawImage(video, 0, 0, w, h);
        const imageData = colorCtx.getImageData(0, 0, w, h);
        setColors(kMeansDominantColors(imageData, 5));
      } catch (err) {
        // Cross-origin without CORS would taint the canvas. Surface it in
        // dev so we don't silently hide a real problem.
        if (typeof console !== "undefined") console.warn("[VideoPlayerPreview] color extract failed", err);
      }
    };

    // Run once immediately so the panel can populate without waiting a
    // full second, then keep sampling at 1Hz.
    sample();
    const id = window.setInterval(sample, 1000);
    return () => window.clearInterval(id);
  }, [videoSrc]);

  // ============================================================
  // Playback engine
  // ============================================================

  // Manual play/pause toggle (after the video is already loaded).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSrc) return;
    if (isPlaying) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [isPlaying, videoSrc]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.volume = volume;
      video.muted = isMuted;
    }
  }, [volume, isMuted]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.loop = isLooping;
    }
  }, [isLooping]);

  // ============================================================
  // Keybindings
  // ============================================================

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
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEyeDropperActive) return;
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;

      if (e.code === "Space") {
        e.preventDefault();
        setIsPlaying(p => !p);
      }

      if (e.code === "ArrowRight") {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          skip(1);
        } else {
          goNextFrame();
        }
      }

      if (e.code === "ArrowLeft") {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          skip(-1);
        } else {
          goPrevFrame();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [skip, goNextFrame, goPrevFrame, isEyeDropperActive]);

  // Scroll zoom — only active when mouse is over the video viewport with Ctrl held
  const [isMouseOverVideo, setIsMouseOverVideo] = useState(false);
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (isEyeDropperActive) return;
      if (document.activeElement instanceof HTMLInputElement) return;
      if (!isMouseOverVideo) return;
      if (!e.ctrlKey) return; // Only zoom with Ctrl+Scroll
      e.preventDefault();
      const delta = e.deltaY * -0.001;
      setZoom(z => {
        const currentZoom = z === "Fit" ? 1 : z;
        return Math.min(Math.max(0.25, currentZoom + delta), 2.0);
      });
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [isMouseOverVideo, isEyeDropperActive]);

  // Stop panning on right-click or document mouseup
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

  // ============================================================
  // Display helpers
  // ============================================================

  const formatTime = (seconds: number): string => {
    if (!seconds || isNaN(seconds) || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const totalFrames = effectiveFps > 0 && videoDuration > 0 ? Math.round(videoDuration * effectiveFps) : 0;
  const progress = videoDuration > 0 ? (currentTime / videoDuration) * 100 : 0;

  const wrapperClasses = isFocusView
    ? `fixed inset-0 z-[500] shadow-2xl overflow-hidden flex flex-col`
    : `w-full h-full flex flex-col relative`;
  const activeZoomScale = zoom === "Fit" ? 1 : zoom;

  return (
    <div ref={containerRef} className={wrapperClasses} style={{ backgroundColor: 'var(--header-bg)' }}>
      {/* Header bar */}
      <div className="absolute top-0 w-full p-2 flex justify-between items-center z-20 pointer-events-none theme-aware-header" style={{ background: `linear-gradient(135deg, ${accentColor}18 0%, var(--header-bg) 100%)`, borderBottom: `1px solid ${accentColor}25` }}>
        <div className="flex items-center gap-2">
          <div className="text-[8px] font-bold px-1 py-0.5 rounded uppercase tracking-wider border" style={{ backgroundColor: accentColor, color: 'var(--row-bg)', borderColor: `${accentColor}80` }}>Video</div>
          <span className="text-[10px] font-mono pointer-events-auto theme-aware-header-text">{fileName}</span>
        </div>
        <div className="text-[10px] font-mono pr-2 flex items-center gap-3 theme-aware-meta">
          <span>{videoSize ? `${videoSize.width}x${videoSize.height}` : (videoSrc ? 'Loading...' : `${MOCK_WIDTH}x${MOCK_HEIGHT}`)}</span>
          <span>fps: {effectiveFps.toFixed(2)}</span>
        </div>
      </div>

      {/* Main Viewport */}
      <div
        className={`flex-1 overflow-hidden flex justify-center items-center relative group ${isEyeDropperActive ? "cursor-crosshair" : ""}`}
        style={{ backgroundColor: 'var(--header-bg)' }}
        onClick={(e) => {
          if (isEyeDropperActive) return;
          if (e.target !== e.currentTarget && (e.target as HTMLElement).closest('.overlay-ui')) return;
          if (!videoSrc) {
            startPlayback();
          } else {
            setIsPlaying(!isPlaying);
          }
        }}
        onMouseDown={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            if (isPanning) {
              setIsPanning(false);
              setPanOffset({ x: 0, y: 0 });
            } else {
              setIsPanning(true);
              panRef.current = { isDragging: true, startX: e.clientX, startY: e.clientY, offsetX: panOffset.x, offsetY: panOffset.y };
            }
          }
        }}
        onMouseMove={(e) => {
          if (isPanning && panRef.current.isDragging) {
            const dx = e.clientX - panRef.current.startX;
            const dy = e.clientY - panRef.current.startY;
            setPanOffset({ x: panRef.current.offsetX + dx, y: panRef.current.offsetY + dy });
          }
          if (!isEyeDropperActive) return;
          const video = videoRef.current;
          if (!video || video.videoWidth === 0) { setEyedropperColor(null); return; }
          const videoRect = video.getBoundingClientRect();
          const vw = video.videoWidth, vh = video.videoHeight;
          const mouseVX = e.clientX - videoRect.left;
          const mouseVY = e.clientY - videoRect.top;
          if (mouseVX < 0 || mouseVX >= videoRect.width || mouseVY < 0 || mouseVY >= videoRect.height) {
            setEyedropperColor(null);
            return;
          }
          const vidX = mouseVX * vw / videoRect.width;
          const vidY = mouseVY * vh / videoRect.height;
          const tmpCanvas = document.createElement("canvas");
          tmpCanvas.width = 1;
          tmpCanvas.height = 1;
          const tmpCtx = tmpCanvas.getContext("2d", { willReadFrequently: true });
          if (!tmpCtx) { setEyedropperColor(null); return; }
          try {
            tmpCtx.drawImage(video, vidX, vidY, 1, 1, 0, 0, 1, 1);
            const pixel = tmpCtx.getImageData(0, 0, 1, 1).data;
            if (pixel[3] === 0) { setEyedropperColor(null); return; }
            const r = pixel[0], g = pixel[1], b = pixel[2];
            const hslStr = rgbToHslString(r, g, b);
            setEyedropperColor({ hex: rgbToHex(r, g, b), rgb: `rgb(${r}, ${g}, ${b})`, hsl: hslStr, r, g, b });
          } catch {
            setEyedropperColor(null);
          }
        }}
        onMouseUp={() => {
          if (panRef.current.isDragging) {
            panRef.current.isDragging = false;
          }
        }}
        onMouseLeave={() => {
          if (isEyeDropperActive) setEyedropperColor(null);
          setIsMouseOverVideo(false);
        }}
        onMouseEnter={() => setIsMouseOverVideo(true)}
      >
        {/* Transcode / loading overlay — centered on the player, uses the
            theme's surface-bg so it blends with both light and dark themes.
            Shows the full progress bar while the backend is still encoding
            (status === 'encoding'), a plain spinner while we wait for the
            first progress event, and disappears once the video is ready. */}
        {loadingVideo && (
          <div
            className="absolute inset-0 z-20 flex flex-col items-center justify-center px-8"
            style={{ backgroundColor: 'var(--surface-bg)' }}
          >
            {transcodeProgress && transcodeProgress.status === 'encoding' ? (
              <>
                <div
                  className="text-xs font-mono mb-3 uppercase tracking-wider"
                  style={{ color: 'var(--fg-2)' }}
                >
                  Transcoding…
                </div>
                <div className="w-full max-w-md h-1.5 rounded-full overflow-hidden mb-2" style={{ backgroundColor: 'var(--stroke-1)' }}>
                  <div
                    className="h-full transition-all duration-300 ease-out rounded-full"
                    style={{
                      width: `${Math.max(2, Math.min(100, transcodeProgress.percent))}%`,
                      backgroundColor: accentColor
                    }}
                  />
                </div>
                <div className="flex items-center justify-between w-full max-w-md text-[10px] font-mono">
                  <span style={{ color: accentColor }}>
                    {transcodeProgress.percent.toFixed(1)}%
                  </span>
                  <span style={{ color: 'var(--fg-2)' }}>
                    {transcodeProgress.totalFrames > 0 ? (
                      <>
                        frame {transcodeProgress.currentFrame.toLocaleString()}
                        {' / '}
                        {transcodeProgress.totalFrames.toLocaleString()}
                      </>
                    ) : (
                      <>encoding…</>
                    )}
                  </span>
                </div>
                <div
                  className="text-[9px] font-mono mt-2"
                  style={{ color: 'var(--fg-2)' }}
                >
                  Video converted to H.264 for browser playback
                </div>
              </>
            ) : transcodeProgress && transcodeProgress.status === 'failed' ? (
              <>
                <div className="text-red-400 text-xs font-mono mb-2">
                  Transcode failed
                </div>
                <div className="text-[10px] text-stone-500 font-mono">
                  Try a different player or codec
                </div>
              </>
            ) : (
              <>
                <div
                  className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mb-2"
                  style={{ borderColor: accentColor, borderTopColor: 'transparent' }}
                />
                <span
                  className="text-xs font-mono"
                  style={{ color: 'var(--fg-2)' }}
                >
                  Loading video...
                </span>
              </>
            )}
          </div>
        )}

        {/* Actual video element — stream directly from the local HTTP
            server so playback can start as soon as the browser has
            buffered the MP4 header. No more fetch+blob roundtrip. */}
        {videoSrc ? (
          <>
            {/* Video background layer */}
            <div className="absolute inset-0" style={{ backgroundColor: 'var(--header-bg)' }} />
            {/* Zoom wrapper: centered flex container, transform applied here so mouse coords are in transformed space */}
            <div
              className="flex items-center justify-center absolute inset-0"
              style={{
                transform: `translate(${panOffset.x}px, ${panOffset.y}px) ${zoom === "Fit" ? "" : `scale(${activeZoomScale})`}`,
                transformOrigin: "center",
                transition: zoom === "Fit" ? "none" : "transform 0.1s ease",
              }}
            >
              <video
                ref={videoRef}
                src={videoSrc}
                crossOrigin="anonymous"
                className="max-w-full max-h-full object-contain"
                style={{ display: 'block', pointerEvents: 'none' }}
                preload="auto"
                onLoadedMetadata={() => {
                  const v = videoRef.current;
                  console.log("[VideoPlayerPreview] onLoadedMetadata", {
                    duration: v?.duration,
                    videoWidth: v?.videoWidth,
                    videoHeight: v?.videoHeight,
                    readyState: v?.readyState,
                    networkState: v?.networkState,
                  });
                  handleLoadedMetadata();
                }}
                onCanPlay={() => {
                  const v = videoRef.current;
                  console.log("[VideoPlayerPreview] onCanPlay", {
                    readyState: v?.readyState,
                    buffered: v?.buffered?.length,
                  });
                  setLoadingVideo(false);
                  // The video is ready for playback. Drop any lingering
                  // "encoding" state so the centered progress bar can't
                  // reappear if the user later triggers a wait event.
                  setTranscodeProgress(null);
                }}
                onCanPlayThrough={() => {
                  const v = videoRef.current;
                  console.log("[VideoPlayerPreview] onCanPlayThrough", { readyState: v?.readyState });
                  handleCanPlay();
                }}
                onWaiting={() => {
                  const v = videoRef.current;
                  console.log("[VideoPlayerPreview] onWaiting", { readyState: v?.readyState });
                  // Only show the fullscreen loading overlay if the video
                  // hasn't played yet at all. Once the user is already
                  // playing and scrubs, the waiting event is just "buffer
                  // refill" — show it via the bottom badge instead of a
                  // fullscreen overlay so the timeline / scrub UX stays
                  // responsive.
                  if (!videoReadyRef.current) {
                    setLoadingVideo(true);
                  } else {
                    setBuffering(true);
                  }
                }}
                onError={(e) => {
                  const v = e.target as HTMLVideoElement;
                  console.error("[VideoPlayerPreview] <video> ERROR", {
                    code: v?.error?.code,
                    message: v?.error?.message,
                    currentSrc: v?.currentSrc?.slice(0, 60),
                    networkState: v?.networkState,
                    readyState: v?.readyState,
                  });
                  setLoadingVideo(false);
                  setVideoError(true);
                }}
                onTimeUpdate={handleTimeUpdate}
                onPlay={handlePlay}
                onPause={handlePause}
                onSeeking={handleSeeking}
                onSeeked={handleSeeked}
                onEnded={handleEnded}
              />
              <canvas ref={colorPickerCanvasRef} style={{ display: "none" }} />
            </div>
          </>
        ) : videoError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ backgroundColor: 'var(--row-bg)', color: 'var(--fg-2)' }}>
            <div className="text-4xl mb-2">!</div>
            <div className="text-xs font-mono">Failed to load video</div>
            <div className="text-[10px] mt-1" style={{ color: 'var(--fg-2)' }}>{fileName}</div>
          </div>
        ) : (
          <div
            ref={playerRef}
            className={`absolute transition-transform duration-75 origin-center will-change-transform flex items-center justify-center ${
              zoom === "Fit" ? "inset-0" : "w-[640px] h-[360px]"
            }`}
            style={{ transform: zoom === "Fit" ? "none" : `scale(${activeZoomScale})` }}
            onClick={(e) => {
              e.stopPropagation();
              startPlayback();
            }}
          >
            {/* Play overlay when video not loaded yet */}
            <div className="flex flex-col items-center justify-center cursor-pointer">
              <button 
                className="p-4 rounded-full transition-all hover:scale-110 active:scale-95"
                style={{ 
                  color: accentColor, 
                  backgroundColor: `${accentColor}20`,
                  border: `2px solid ${accentColor}40`
                }} 
                title="Click to play"
              >
                <Play className="w-12 h-12" fill={accentColor} />
              </button>
              <span className="text-[10px] font-mono mt-3" style={{ color: 'var(--fg-2)' }}>
                Click to load video
              </span>
            </div>
          </div>
        )}

        {/* Eyedropper Floating Tooltip */}
        {(isEyeDropperActive || copiedHex) && eyedropperColor && (
          <div className="absolute top-4 left-4 z-50 pointer-events-none rounded overflow-hidden flex flex-col p-1 shadow-2xl border" style={{ backgroundColor: 'var(--row-bg)', borderColor: 'var(--stroke-1)' }}>
            <div className="flex gap-2 items-center p-1">
              <div className="w-8 h-8 rounded border" style={{ backgroundColor: eyedropperColor.hex, borderColor: 'var(--stroke-1)' }} />
              <div className="flex flex-col w-20 relative">
                {copiedHex ? (
                  <span className="font-mono text-[10px] font-bold px-1 rounded inline-block w-fit" style={{ color: accentColor, backgroundColor: `${accentColor}20` }}>Copied!</span>
                ) : (
                  <span className="font-mono text-[10px]" style={{ color: accentColor }}>{eyedropperColor.hex}</span>
                )}
                <span className="font-mono text-[9px]" style={{ color: 'var(--fg-2)' }}>{eyedropperColor.rgb}</span>
              </div>
            </div>
          </div>
        )}

        {/* Color Picker Overlay */}
        {showColors && colors.length > 0 && (
          <div className="overlay-ui absolute top-10 right-4 p-3 rounded-xl fluent-menu color-picker-panel border shadow-2xl z-30 cursor-default" onClick={e => e.stopPropagation()}>
            <div className="flex flex-col gap-1">
              {colors.map((c, i) => {
                const isExpanded = expandedColorIndex === i;
                return (
                  <div key={i} className={`flex items-center gap-2 cursor-pointer rounded transition-all ${isExpanded ? "bg-white/8 p-2" : "p-1.5 hover:bg-white/5"}`}
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
                    <div className="w-7 h-7 rounded-md border flex-shrink-0 shadow-inner" style={{ backgroundColor: c.hex, borderColor: 'var(--stroke-1)' }} />
                    {isExpanded ? (
                      <div className="flex flex-col gap-0.5 flex-1">
                        {([["HEX", c.hex], ["RGB", `${c.r}, ${c.g}, ${c.b}`], ["HSL", `${c.hsl}`]] as [string, string][]).map(([label, val]) => (
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

      {/* Control Bar */}
      <div className="h-12 shrink-0 border-t flex items-center px-4 justify-between select-none space-x-1" style={{ backgroundColor: 'var(--row-bg)', borderColor: 'var(--stroke-1)' }}>

        {/* Left Side: Frame controls and Timecode */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            {/* Play/Pause */}
            <button 
              onClick={() => {
                if (!videoSrc) {
                  startPlayback();
                } else {
                  setIsPlaying(!isPlaying);
                }
              }} 
              className="p-1.5 rounded transition-colors" 
              style={{ color: accentColor, backgroundColor: 'var(--surface-bg)' }} 
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>

            {/* Back 1s */}
            <button onClick={() => skip(-1)} className="p-1 rounded" style={{ color: 'var(--fg-2)' }} title="Back 1s (Ctrl+Left)">
              <ChevronsLeft className="w-3.5 h-3.5" />
            </button>
            {/* Prev Frame */}
            <button onClick={goPrevFrame} className="p-1 rounded" style={{ color: 'var(--fg-2)' }} title="Prev Frame (Left)">
              <ChevronLeft className="w-4 h-4" />
            </button>

            {/* Time/Frame display — click to toggle mode, shift-click to edit */}
            <div
              className="rounded px-2 py-1 mx-1 flex items-center font-mono text-[10px] cursor-pointer transition-colors border"
              style={{ backgroundColor: 'var(--surface-bg)', borderColor: 'var(--stroke-1)' }}
              onClick={(e) => {
                // If clicking inside the editor input, do nothing — don't toggle or re-open
                if ((e.target as HTMLElement).hasAttribute("data-seg-input")) return;
                if (e.shiftKey) {
                  e.preventDefault();
                  setIsPlaying(false);
                  if (timeMode === "timecode") {
                    setEditTimeValue(formatVideoTimecode(currentFrame, effectiveFps));
                  } else {
                    setEditTimeValue(formatVideoFrames(currentFrame, totalFrames));
                  }
                  setIsEditingTime(true);
                } else {
                  setTimeMode(m => m === "timecode" ? "frames" : "timecode");
                }
              }}
            >
              {isEditingTime ? (
                <SegmentEditor
                  value={editTimeValue}
                  editorMode={timeMode}
                  totalFrames={totalFrames}
                  onChange={setEditTimeValue}
                  accentColor={accentColor}
                  onCommit={() => {
                    if (timeMode === "timecode") {
                      const frame = parseVideoTimecode(editTimeValue, effectiveFps);
                      goToFrame(frame);
                    } else {
                      const parsed = parseInt(editTimeValue, 10);
                      if (!isNaN(parsed)) {
                        goToFrame(Math.max(0, Math.min(parsed, totalFrames - 1)));
                      }
                    }
                    setIsEditingTime(false);
                  }}
                  onCancel={() => setIsEditingTime(false)}
                />
              ) : (
                <span style={{ color: accentColor }}>
                  {timeMode === "timecode"
                    ? formatVideoTimecode(currentFrame, effectiveFps)
                    : `${currentFrame + 1} / ${totalFrames}`}
                </span>
              )}
            </div>

            {/* Next Frame */}
            <button onClick={goNextFrame} className="p-1 rounded" style={{ color: 'var(--fg-2)' }} title="Next Frame (Right)">
              <ChevronRight className="w-4 h-4" />
            </button>

            {/* Next 1s */}
            <button onClick={() => skip(1)} className="p-1 rounded" style={{ color: 'var(--fg-2)' }} title="Next 1s (Ctrl+Right)">
              <ChevronsRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Right Side: Extras */}
        <div className="flex items-center gap-1.5">
          {/* Volume */}
          <div className="flex items-center gap-1 mr-2">
            <button onClick={() => setIsMuted(!isMuted)} className="p-1 rounded" style={{ color: 'var(--fg-2)' }}>
              {isMuted || volume === 0 ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={isMuted ? 0 : volume}
              onChange={(e) => {
                setVolume(parseFloat(e.target.value));
                if (isMuted) setIsMuted(false);
              }}
              className="w-16 h-1 cursor-pointer"
              style={{ accentColor: accentColor }}
            />
          </div>

          {/* Zoom Menu */}
          <div className="relative">
            <button
              onClick={() => setShowZoomMenu(!showZoomMenu)}
              onBlur={() => setTimeout(() => setShowZoomMenu(false), 150)}
              className="rounded px-2 py-1 flex items-center gap-1 font-mono text-[10px] transition-colors border"
              style={{ backgroundColor: 'var(--surface-bg)', borderColor: 'var(--stroke-1)', color: accentColor }}
            >
              <span>{zoom === "Fit" ? "Fit" : `${Math.round(zoom * 100)}%`}</span>
              <ChevronDown className="w-3 h-3 text-stone-500" />
            </button>

            {showZoomMenu && (
              <div className="absolute bottom-full mb-1 right-0 w-24 bg-white dark:bg-[var(--app-bg)] border border-stone-200 dark:border-white/10 rounded py-1 shadow-2xl z-40">
                {([
                  { label: "Fit", val: "Fit" } as const,
                  { label: "25%", val: 0.25 },
                  { label: "50%", val: 0.5 },
                  { label: "125%", val: 1.25 },
                  { label: "200%", val: 2.0 },
                ] as { label: string; val: number | "Fit" }[]).map(o => (
                  <button
                    key={o.label}
                    className={`w-full text-left px-3 py-1 text-[10px] font-mono hover:bg-blue-600 hover:text-white ${zoom === o.val ? "bg-blue-500 text-white" : ""}`}
                    style={zoom === o.val ? undefined : { color: accentColor }}
                    onClick={() => {
                      setZoom(o.val);
                      if (o.val === "Fit") {
                        setPanOffset({ x: 0, y: 0 });
                      }
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="w-[1px] h-4 bg-stone-600 mx-1" />

          {/* Color Picker */}
          <button
            onClick={() => setShowColors(!showColors)}
            className={`p-1.5 rounded transition-colors ${showColors ? '' : 'hover:bg-white/10 text-stone-400'}`}
            style={showColors ? { backgroundColor: accentColor + "20", color: accentColor } : undefined}
            title="Color Picker"
          >
            <Palette className="w-3.5 h-3.5" />
          </button>

          {/* Eyedropper */}
          <button
            onClick={() => setIsEyeDropperActive(!isEyeDropperActive)}
            className={`p-1.5 rounded transition-colors`}
            style={isEyeDropperActive ? { backgroundColor: `${accentColor}20`, color: accentColor } : { color: 'var(--fg-2)' }}
            title="Eye Dropper"
          >
            <Pipette className="w-3.5 h-3.5" />
          </button>

          {/* Loop */}
          <button
            onClick={() => setIsLooping(!isLooping)}
            className={`p-1.5 rounded transition-colors`}
            style={isLooping ? { backgroundColor: `${accentColor}20`, color: accentColor } : { color: 'var(--fg-2)' }}
            title="Loop"
          >
            <Repeat className="w-3.5 h-3.5" />
          </button>

          {/* Speed/FPS Menu */}
          <div className="relative">
            <button
              onClick={() => setShowSpeedMenu(!showSpeedMenu)}
              onBlur={() => setTimeout(() => setShowSpeedMenu(false), 150)}
              className="rounded px-2 py-1 flex items-center gap-1 font-mono text-[10px] transition-colors border"
              style={{ backgroundColor: 'var(--surface-bg)', color: 'var(--fg-2)', borderColor: 'var(--stroke-1)' }}
            >
              <span style={playbackSpeed !== 1 ? { color: accentColor } : undefined}>
                {playbackSpeed === 1 ? `${effectiveFps.toFixed(2)} FPS` : `${playbackSpeed}x`}
              </span>
              <ChevronDown className="w-3 h-3 text-stone-500" />
            </button>

            {showSpeedMenu && (
              <div className="absolute bottom-full mb-1 right-0 w-28 rounded py-1 shadow-2xl z-40 border" style={{ backgroundColor: 'var(--row-bg)', borderColor: 'var(--stroke-1)' }}>
                {([
                  { label: "0.25x", val: 0.25 },
                  { label: "0.5x", val: 0.5 },
                  { label: `${effectiveFps.toFixed(2)} FPS`, val: 1 },
                  { label: "1.25x", val: 1.25 },
                  { label: "1.5x", val: 1.5 },
                  { label: "2x", val: 2 },
                ] as { label: string; val: number }[]).map(o => (
                  <button
                    key={o.label}
                    className={`w-full text-left px-3 py-1 text-[10px] font-mono hover:bg-blue-600 hover:text-white ${playbackSpeed === o.val ? "bg-blue-500 text-white" : ""}`}
                    style={playbackSpeed === o.val ? undefined : { color: accentColor }}
                    onClick={() => setPlaybackSpeed(o.val)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Focus View */}
          <button
            onClick={() => setIsFocusView(!isFocusView)}
            className={`p-1.5 rounded transition-colors`}
            style={isFocusView ? { backgroundColor: `${accentColor}20`, color: accentColor } : { color: 'var(--fg-2)' }}
            title="Focus View"
          >
            <MonitorPlay className="w-3.5 h-3.5" />
          </button>

          {/* Fullscreen */}
            <button onClick={handleFullscreen} className="p-1.5 rounded" style={{ color: 'var(--fg-2)' }} title="Full Screen">
              <Maximize className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Progress Bar */}
      <div
        className="absolute bottom-[48px] left-0 w-full h-3 bg-[var(--header-bg)] cursor-pointer group z-10"
        onClick={handleProgressClick}
        onMouseDown={() => setIsDragging(true)}
        onMouseUp={() => setIsDragging(false)}
        onMouseLeave={() => setIsDragging(false)}
        onMouseMove={handleProgressDrag}
      >
        <div
          className="h-full group-hover:opacity-80"
          style={{
            width: `${progress}%`,
            backgroundColor: accentColor
          }}
        />
      </div>
    </div>
  );
}
