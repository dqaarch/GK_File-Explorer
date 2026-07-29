import React, { useEffect, useState, useRef, useCallback, memo, useMemo } from "react";
import { Play, Pause } from "lucide-react";
import { FSItem } from "../types";
import { convertFileSrc } from "@tauri-apps/api/core";
import WaveSurferPlayer from "@wavesurfer/react";
import type WaveSurfer from "wavesurfer.js";
import { subscribeFingerprint } from "../hooks/fingerprintStore";

interface AudioPlayerPreviewProps {
  fileName: string;
  filePath?: string;
  accentColor: string;
  playlist?: FSItem[];
}

interface TrackData {
  name: string;
  path: string;
  duration: number;
  progress: number;
  isReady: boolean;
  isPlaying: boolean;
  volume: number;
}

const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

interface TrackPlayerProps {
  item: FSItem;
  trackData: TrackData | undefined;
  accentColor: string;
  onReady: (name: string, ws: WaveSurfer) => void;
  onPlay: (name: string) => void;
  onPause: (name: string) => void;
  onTimeUpdate: (name: string, currentTime: number, duration: number) => void;
  onVolumeChange: (name: string, volume: number) => void;
  onFinish: (name: string) => void;
  onError: () => void;
}

const TrackPlayer = ({
  item,
  trackData,
  accentColor,
  onReady,
  onPlay,
  onPause,
  onTimeUpdate,
  onVolumeChange,
  onFinish,
  onError,
}: TrackPlayerProps) => {
  const trackName = item.name;
  const trackPath = item.path || "";
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const duration = trackData?.duration || 0;
  const progress = trackData?.progress || 0;
  const isPlaying = trackData?.isPlaying || false;
  const isReady = trackData?.isReady || false;
  const volume = trackData?.volume ?? 1;

  // Theme colors - dark theme
  const waveColor = "#606060";
  const progressColor = accentColor;
  const themeText = "text-stone-200";
  const containerBg = "bg-[var(--header-bg)]";
  const containerBorder = "border-[#2d2d30]";
  const sliderTrackBg = "#3f3f46";

  // Create audio URL using HTTP server endpoint - more reliable for HTML5 audio
  const audioUrl = useMemo(() => {
    if (!trackPath) return "";
    try {
      const encodedPath = encodeURIComponent(trackPath);
      return `http://localhost:18765/audio?path=${encodedPath}`;
    } catch (e) {
      console.error("Failed to create audio URL:", e);
      return "";
    }
  }, [trackPath]);

  const handlePlayPause = useCallback(() => {
    const ws = wavesurferRef.current;
    if (ws && isReady) {
      if (isPlaying) {
        ws.pause();
      } else {
        ws.play();
      }
    }
  }, [isReady, isPlaying]);

  const handleReady = useCallback((ws: WaveSurfer) => {
    wavesurferRef.current = ws;
    ws.setVolume(volume);
    setIsLoading(false);
    onReady(trackName, ws);

    // Set up timeupdate using ws.on() for reliable updates
    const updateTime = () => {
      onTimeUpdate(trackName, ws.getCurrentTime(), ws.getDuration());
    };

    ws.on("timeupdate", updateTime);
    ws.on("audioprocess", updateTime);
    ws.on("seeking", updateTime);
  }, [trackName, onReady, onTimeUpdate, volume]);

  const handleVolumeClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // For vertical slider: click near top = high volume, near bottom = low volume
    const clickY = rect.bottom - e.clientY;
    const newVolume = Math.max(0, Math.min(1, clickY / rect.height));
    
    const ws = wavesurferRef.current;
    if (ws) {
      ws.setVolume(newVolume);
    }
    onVolumeChange(trackName, newVolume);
  }, [trackName, onVolumeChange]);

  const handleVolumeDrag = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return; // Only drag with left mouse button
    const rect = e.currentTarget.getBoundingClientRect();
    const clickY = rect.bottom - e.clientY;
    const newVolume = Math.max(0, Math.min(1, clickY / rect.height));
    
    const ws = wavesurferRef.current;
    if (ws) {
      ws.setVolume(newVolume);
    }
    onVolumeChange(trackName, newVolume);
  }, [trackName, onVolumeChange]);

  return (
    <div className={`px-4 py-3 rounded-lg flex flex-row items-center gap-3 mb-2 border transition-all ${containerBg} ${containerBorder}`}>
      {/* Track info + Waveform */}
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        {/* Track header */}
        <div className="flex items-center justify-between">
          <div className={`text-[11px] font-medium truncate ${themeText}`}>
            {trackName}
          </div>
          {/* Loading indicator */}
          {isLoading && !isReady && (
            <div className="text-[9px] text-stone-400 animate-pulse">Loading...</div>
          )}
        </div>

        {/* Player controls + waveform */}
        <div className="flex items-center gap-2">
          {/* Play/Pause button */}
          <button
            onClick={handlePlayPause}
            disabled={!isReady}
            className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-white transition-all active:scale-90 ${!isReady ? "opacity-50 cursor-not-allowed" : ""}`}
            style={{
              backgroundColor: isPlaying ? accentColor : "#4b5563",
            }}
          >
            {isPlaying ? (
              <Pause className="w-4 h-4 fill-current" />
            ) : (
              <Play className="w-4 h-4 fill-current translate-x-0.5" />
            )}
          </button>

          {/* Waveform - Artlist style: thin centered bars */}
          <div className="flex-1 min-w-0 relative">
            {audioUrl ? (
              <WaveSurferPlayer
                key={trackPath}
                url={audioUrl}
                height={40}
                waveColor={waveColor}
                progressColor={progressColor}
                cursorColor="transparent"
                cursorWidth={0}
                // @ts-expect-error wavesurfer.js v8 types restrict barAlign to "top"|"bottom", but "center" is valid at runtime
                barAlign="center"
                barWidth={1}
                barGap={0}
                barRadius={0}
                normalize={true}
                minPxPerSec={4}
                interact={true}
                hideScrollbar={true}
                fillParent={true}
                onReady={handleReady}
                onPlay={() => onPlay(trackName)}
                onPause={() => onPause(trackName)}
                onFinish={() => onFinish(trackName)}
                onError={() => {
                  console.error("WaveSurfer error for:", trackPath, "URL:", audioUrl);
                  onError();
                }}
              />
            ) : (
              <div className="h-10 flex items-center justify-center text-[10px] text-stone-400">
                No audio URL
              </div>
            )}
            {/* Time overlay */}
            <div className="absolute top-1/2 -translate-y-1/2 left-0 text-[9px] font-mono font-medium text-stone-500 pointer-events-none z-10 px-1 bg-gradient-to-r from-white/90 dark:from-[#25252a]/90 pr-2">
              {formatTime(progress)}
            </div>
            <div className="absolute top-1/2 -translate-y-1/2 right-0 text-[9px] font-mono font-medium text-stone-500 pointer-events-none z-10 px-1 bg-gradient-to-l from-white/90 dark:from-[#25252a]/90 pl-2">
              {formatTime(duration)}
            </div>
          </div>
        </div>
      </div>

      {/* Vertical Volume Bar - Simple clickable bar without thumb */}
      <div 
        className="w-1.5 h-12 rounded-full cursor-pointer relative overflow-hidden shrink-0"
        style={{ backgroundColor: sliderTrackBg }}
        onClick={handleVolumeClick}
        onMouseMove={handleVolumeDrag}
        title={`Volume: ${Math.round(volume * 100)}%`}
      >
        <div 
          className="absolute bottom-0 left-0 right-0 rounded-full transition-all"
          style={{ 
            height: `${volume * 100}%`,
            backgroundColor: accentColor
          }}
        />
      </div>
    </div>
  );
};

// AudioPlayerPreview - Main component for audio playback
function AudioPlayerPreview({
  fileName,
  filePath,
  accentColor,
  playlist,
}: AudioPlayerPreviewProps) {
  const items = playlist && playlist.length > 0 ? playlist : [{ name: fileName, path: filePath } as FSItem];

  const [tracksData, setTracksData] = useState<Record<string, TrackData>>({});
  const [audioError, setAudioError] = useState(false);

  const wavesurfersRef = useRef<Record<string, WaveSurfer>>({});

  // Initialize tracks data when items change
  useEffect(() => {
    const initialData: Record<string, TrackData> = {};
    items.forEach((item) => {
      const name = item.name;
      if (!tracksData[name]) {
        initialData[name] = {
          name,
          path: item.path || "",
          duration: 0,
          progress: 0,
          isReady: false,
          isPlaying: false,
          volume: 1,
        };
      }
    });
    if (Object.keys(initialData).length > 0) {
      setTracksData((prev) => ({ ...prev, ...initialData }));
    }
  }, [items]);

  // When main file changes, stop all playback
  useEffect(() => {
    Object.values(wavesurfersRef.current).forEach((ws) => {
      if (ws && ws.isPlaying()) {
        ws.pause();
      }
    });
    setTracksData((prev) => {
      const updated = { ...prev };
      Object.keys(updated).forEach((key) => {
        updated[key] = { ...updated[key], isPlaying: false, progress: 0 };
      });
      return updated;
    });
    setAudioError(false);
  }, [filePath]);

  // Force reload audio when file is replaced. Single source of truth for
  // "file replaced" events lives in fingerprintStore, so we just subscribe.
  useEffect(() => {
    const unsubscribe = subscribeFingerprint((changedPath) => {
      const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
      const normalizedFilePath = normalize(filePath || "");
      if (!normalizedFilePath) return;
      if (normalize(changedPath) === normalizedFilePath) {
        // Stop all playback
        Object.values(wavesurfersRef.current).forEach((ws) => {
          if (ws && ws.isPlaying()) {
            ws.pause();
          }
        });
        setTracksData({});
        setAudioError(false);
      }
    });
    return unsubscribe;
  }, [filePath]);

  const handleReady = useCallback((trackName: string, ws: WaveSurfer) => {
    wavesurfersRef.current[trackName] = ws;

    setTracksData((prev) => ({
      ...prev,
      [trackName]: {
        ...prev[trackName],
        name: trackName,
        duration: ws.getDuration(),
        isReady: true,
      },
    }));
  }, []);

  const handlePlay = useCallback((trackName: string) => {
    Object.entries(wavesurfersRef.current).forEach(([name, otherWs]) => {
      if (otherWs && name !== trackName && otherWs.isPlaying()) {
        otherWs.pause();
        setTracksData((prev) => ({
          ...prev,
          [name]: { ...prev[name], isPlaying: false },
        }));
      }
    });

    setTracksData((prev) => ({
      ...prev,
      [trackName]: { ...prev[trackName], isPlaying: true },
    }));
  }, []);

  const handlePause = useCallback((trackName: string) => {
    setTracksData((prev) => ({
      ...prev,
      [trackName]: { ...prev[trackName], isPlaying: false },
    }));
  }, []);

  const handleVolumeChange = useCallback((trackName: string, volume: number) => {
    setTracksData((prev) => ({
      ...prev,
      [trackName]: { ...prev[trackName], volume },
    }));
  }, []);

  const handleFinish = useCallback((trackName: string) => {
    setTracksData((prev) => ({
      ...prev,
      [trackName]: { ...prev[trackName], isPlaying: false, progress: 0 },
    }));
  }, []);

  const handleTimeUpdate = useCallback((trackName: string, currentTime: number, duration: number) => {
    setTracksData((prev) => ({
      ...prev,
      [trackName]: {
        ...prev[trackName],
        progress: currentTime,
        duration: duration > 0 ? duration : prev[trackName]?.duration || 0,
        isReady: true,
      },
    }));
  }, []);

  const handleError = useCallback(() => {
    setAudioError(true);
  }, []);

  return (
    <div className="flex flex-col w-full h-full overflow-hidden" style={{ backgroundColor: 'var(--header-bg)' }}>
      <div className="flex-1 overflow-y-auto p-4">
        {audioError && (
          <div className="flex flex-col items-center justify-center py-8 text-stone-400">
            <div className="text-4xl mb-2">!</div>
            <div className="text-xs font-mono">Failed to load audio</div>
            <div className="text-[10px] text-stone-500 mt-1">{fileName}</div>
            <div className="text-[9px] text-stone-600 mt-2 px-2 py-1 bg-stone-800/10 rounded font-mono max-w-full truncate">
              {filePath}
            </div>
            <div className="text-[9px] text-stone-500 mt-2">
              Check console for details
            </div>
          </div>
        )}

        {!audioError && items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-stone-400">
            <div className="text-4xl mb-2">?</div>
            <div className="text-xs font-mono">No audio tracks found</div>
          </div>
        )}

        {items.map((item, idx) => (
          <TrackPlayer
            key={item.name + idx}
            item={item}
            trackData={tracksData[item.name]}
            accentColor={accentColor}
            onReady={handleReady}
            onPlay={handlePlay}
            onPause={handlePause}
            onTimeUpdate={handleTimeUpdate}
            onVolumeChange={handleVolumeChange}
            onFinish={handleFinish}
            onError={handleError}
          />
        ))}
      </div>
    </div>
  );
}

// Memoize AudioPlayerPreview - only re-render when filePath changes
// This prevents re-render on parent re-renders (e.g., tab switching)
// While still allowing re-render when user selects a different audio file
const MemoizedAudioPlayerPreview = memo(AudioPlayerPreview, (prevProps, nextProps) => {
  // Re-render only when the actual file changes
  return prevProps.filePath === nextProps.filePath && 
         prevProps.playlist === nextProps.playlist;
});

export default MemoizedAudioPlayerPreview;
