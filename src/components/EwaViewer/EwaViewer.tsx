/**
 * EwaViewer - Integrated EWA player using EwaCacheManager
 * 
 * Integrates with 3DModelViewer for seamless EWA file viewing.
 * Uses Lumigrade-style two-tier caching:
 * - Tier 1: Luma + meansLo (Rust, permanent)
 * - Tier 2: Decoded splats (JS, rolling 64 frames)
 * 
 * Warmup: If total splats fit in cache budget (~16M), pre-decode ALL frames
 * before enabling playback for smooth decode-free playback.
 */

import React, { useRef, useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { EwaCacheManager, ewaCacheManager, type EwaPreloadInfo } from "./EwaCacheManager";
import { EwaSplatRenderer } from "./EwaSplatRenderer";
import { MonitorPlay, Pause, RotateCcw, Loader2, Maximize, Play, X, Download } from "lucide-react";
import { ColorGradePanel } from "./ColorGradePanel";

// Flip Y button — flips the scene vertically for postshot-style Y-down exports
function FlipYButton({
  flipY,
  onToggle,
}: {
  flipY: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
        flipY ? "bg-white/20 text-white" : "bg-white/10 hover:bg-white/20 text-white/60 hover:text-white"
      }`}
      title="Flip Y"
    >
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 3v18M19 9l-7 7-7-7"/>
      </svg>
    </button>
  );
}

// Debug flag — set true locally to re-enable verbose EWA viewer logs.
const EWA_DEBUG = false;
const dbg = (...args: unknown[]) => { if (EWA_DEBUG) console.log(...args); };

interface EwaViewerProps {
  fileName: string;
  filePath: string;
  accentColor?: string;
  language?: "vi" | "en";
}

interface EwaPreloadProgress {
  path: string;
  percent: number;
  stage: string;
  message?: string;
}

// Cache budget: ~16M splat-frames (e.g. 180*~80k = 14.4M)
const CACHE_MAX_SPLATS = 16_000_000;

export default function EwaViewer({
  fileName,
  filePath,
  accentColor = "#3b82f6",
  language = "vi",
}: EwaViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<EwaSplatRenderer | null>(null);
  const cacheManagerRef = useRef<EwaCacheManager>(ewaCacheManager);
  const animationFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  
  const [info, setInfo] = useState<EwaPreloadInfo | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadStage, setLoadStage] = useState("");
  const [loadMessage, setLoadMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isWarmingUp, setIsWarmingUp] = useState(false);
  const [warmupFrame, setWarmupFrame] = useState(0);
  const [totalFramesToWarmup, setTotalFramesToWarmup] = useState(0);
  const [canPlay, setCanPlay] = useState(false);
  const [hdriEnabled, setHdriEnabled] = useState(true);
  const [showColorGrade, setShowColorGrade] = useState(false);
  const [flipY, setFlipY] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<string>("");
  const [exportBar, setExportBar] = useState<{ done: number; total: number; lastName: string } | null>(null);
  const [namePromptOpen, setNamePromptOpen] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const pendingExportRef = useRef<{ outputDir: string; defaultBase: string } | null>(null);
  const [isFocusView, setIsFocusView] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const NF = info?.n_frames ?? 0;
  const nG = info?.n_gaussians ?? 0;
  const fps = info?.fps ?? 30;

  // Preload EWA file on mount with progress tracking
  useEffect(() => {
    const cache = cacheManagerRef.current;
    
    // Listen for preload progress events
    const unlistenPromise = listen<EwaPreloadProgress>("ewa-preload-progress", (event) => {
      if (event.payload.path === filePath) {
        setLoadProgress(event.payload.percent);
        setLoadStage(event.payload.stage);
        setLoadMessage(event.payload.message || "");
      }
    });
    
    const preload = async () => {
      setIsLoading(true);
      setError(null);
      setLoadProgress(0);
      setLoadStage("loading_file");

      try {
        const preloadInfo = await cache.preload(filePath);
        setInfo(preloadInfo);

        // After preload, check if we need warmup
        const totalSplatFrames = preloadInfo.n_frames * preloadInfo.n_gaussians;
        if (totalSplatFrames <= CACHE_MAX_SPLATS && preloadInfo.n_frames > 1) {
          // All frames fit in cache - warmup (decode all frames)
          setTotalFramesToWarmup(preloadInfo.n_frames);
          setIsWarmingUp(true);
          setIsLoading(false); // Switch to warmup state

          // Load frame 0 first so user can see something
          try {
            const frame0 = await cache.getFrame(0);
            if (rendererRef.current) {
              rendererRef.current.uploadFrame(frame0);
              rendererRef.current.fitWorkplaneToScene(frame0);
              dbg("[EwaViewer] Frame 0 loaded for preview, splats:", frame0.positions.length / 3);
            }
          } catch (e) {
            console.warn("[EwaViewer] Failed to load frame 0:", e);
          }

          await warmup(preloadInfo.n_frames);
          setIsWarmingUp(false);
          setCanPlay(true);
          // Auto-play after warmup completes so user immediately sees animation
          setCurrentFrame(0);
          setIsPlaying(true);
        } else if (preloadInfo.n_frames > 1) {
          // Multi-frame file but too large to warmup - auto-play immediately
          // (rolling cache will decode frames on demand)
          setIsLoading(false);
          setCanPlay(true);
          try {
            const frame0 = await cache.getFrame(0);
            if (rendererRef.current) {
              rendererRef.current.uploadFrame(frame0);
              rendererRef.current.fitWorkplaneToScene(frame0);
            }
          } catch (e) {
            console.warn("[EwaViewer] Failed to load frame 0:", e);
          }
          setCurrentFrame(0);
          setIsPlaying(true);
        } else {
          // Single-frame file: show frame 0, do not auto-play
          setIsLoading(false);
          setCanPlay(true);
          try {
            const frame0 = await cache.getFrame(0);
            if (rendererRef.current) {
              rendererRef.current.uploadFrame(frame0);
              rendererRef.current.fitWorkplaneToScene(frame0);
            }
          } catch (e) {
            console.warn("[EwaViewer] Failed to load frame 0:", e);
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setIsLoading(false);
      }
    };
    
    preload();

    const exportUnlistenPromise = listen<string>("ewa-export-progress", (event) => {
      setExportProgress(event.payload);
      // Parse "[progress] K/NF [name.ply]" so we can drive a progress bar.
      const m = /\[progress\]\s+(\d+)\s*\/\s*(\d+)(?:\s+(.+))?/.exec(event.payload);
      if (m) {
        setExportBar({
          done: parseInt(m[1], 10),
          total: parseInt(m[2], 10),
          lastName: (m[3] || "").trim(),
        });
      }
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
      exportUnlistenPromise.then(unlisten => unlisten());
      cache.clear();
    };
  }, [filePath]);
  
  // Warmup: decode all frames before enabling playback
  const warmup = async (nFrames: number) => {
    const cache = cacheManagerRef.current;
    for (let f = 1; f < nFrames; f++) {  // Start from 1 since frame 0 is already loaded
      try {
        const decoded = await cache.getFrame(f);
        setWarmupFrame(f);
        
        // Also upload to renderer for preview
        if (rendererRef.current) {
          rendererRef.current.uploadFrame(decoded);
          rendererRef.current.fitWorkplaneToScene(decoded);
        }
        
        // Yield to keep UI responsive
        if (f % 6 === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
      } catch (e) {
        console.warn("[EwaViewer] Warmup failed for frame", f, e);
      }
    }
  };

  // Get stage label for display
  const getStageLabel = (stage: string): string => {
    switch (stage) {
      case "loading_file":
        return language === "vi" ? "Đang tải file..." : "Loading file...";
      case "decoding_vp9":
        return language === "vi" ? "Đang giải mã VP9..." : "Decoding VP9...";
      case "decompressing_means_lo":
        return language === "vi" ? "Đang giải nén dữ liệu..." : "Decompressing data...";
      case "done":
        return language === "vi" ? "Hoàn tất!" : "Done!";
      default:
        return language === "vi" ? "Đang xử lý..." : "Processing...";
    }
  };

  const handleExportPly = useCallback(async () => {
    if (isExporting) return;

    // 1. Pick destination folder
    let outputDir: string | null = null;
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: language === "vi" ? "Chọn thư mục lưu PLY" : "Choose output folder for PLY",
      });
      if (typeof picked === "string") {
        outputDir = picked;
      }
    } catch (e) {
      console.warn("[EwaViewer] open dialog failed", e);
    }
    if (!outputDir) return;

    // 2. Show in-app naming modal (centred, themed, no native browser bar)
    const defaultBase = fileName.replace(/\.[^/.]+$/, "") || "EWA_Export";
    pendingExportRef.current = { outputDir, defaultBase };
    setNameInput(defaultBase);
    setNamePromptOpen(true);
  }, [isExporting, fileName, language]);

  const confirmExportName = useCallback(async () => {
    const pending = pendingExportRef.current;
    if (!pending) return;
    const baseName = nameInput.trim() || pending.defaultBase;
    const outputDir = pending.outputDir;
    setNamePromptOpen(false);
    pendingExportRef.current = null;

    // 3. Invoke Rust command which spawns python
    setIsExporting(true);
    setExportBar({ done: 0, total: NF, lastName: "" });
    setExportProgress(
      language === "vi"
        ? `Đang export ${NF} frames...`
        : `Exporting ${NF} frames...`
    );
    try {
      await invoke<string>("export_ewa_to_ply", {
        ewaPath: filePath,
        outputDir,
        baseName,
      });
      setExportProgress(
        language === "vi"
          ? `Hoàn tất! Đã lưu vào ${outputDir}`
          : `Done! Saved to ${outputDir}`
      );
    } catch (e: any) {
      console.error("[EwaViewer] export failed", e);
      setExportProgress(
        `${language === "vi" ? "Lỗi" : "Error"}: ${String(e)}`
      );
    } finally {
      setIsExporting(false);
    }
  }, [nameInput, filePath, NF, language]);

  const cancelExportName = useCallback(() => {
    setNamePromptOpen(false);
    pendingExportRef.current = null;
  }, []);

  // Initialize renderer
  useEffect(() => {
    if (!canvasRef.current || !info) return;

    const renderer = new EwaSplatRenderer({
      canvas: canvasRef.current,
      fovDeg: 50,
      supersample: 2, // SSAA at 2× device pixel ratio
      colorGrading: {
        exposure: 0,
        temperature: 0,
        tint: 0,
        contrast: 1,
        saturation: 1,
        rGain: 1,
        gGain: 1,
        bGain: 1,
        blackLevel: 0,
        whiteLevel: 1,
      },
      hdri: {
        enabled: false,
        file: "/lumigrade/hdri/neurathen_rock_castle_1k.jpg",
        autoExposure: 1,
        yaw: 0,
        radius: 4,
        capH: 3,
        groundY: -0.825,
        shadowEnabled: true,
        shadowRadius: 40,
      },
    });
    rendererRef.current = renderer;

    // Load HDRi backdrop (local — bundled with the app, no CORS issues)
    renderer.loadHdri("/lumigrade/hdri/neurathen_rock_castle_1k.jpg");

    // Render loop - continuously render the scene
    let rafId: number;
    const renderLoop = () => {
      if (rendererRef.current) {
        rendererRef.current.render();
      }
      rafId = requestAnimationFrame(renderLoop);
    };
    rafId = requestAnimationFrame(renderLoop);

    return () => {
      cancelAnimationFrame(rafId);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [info]);

  // Load frame to renderer
  const loadFrame = useCallback(async (frame: number) => {
    const renderer = rendererRef.current;
    const cache = cacheManagerRef.current;
    if (!renderer || !cache.isReady) return;

    try {
      const decoded = await cache.getFrame(frame);
      dbg("[EwaViewer] loadFrame(" + frame + ") - splats:", decoded.positions.length / 3);
      renderer.uploadFrame(decoded);
      renderer.fitWorkplaneToScene(decoded);
    } catch (e) {
      console.error("[EwaViewer] Failed to load frame:", e);
    }
  }, []);

  // Fit camera to bbox center — called ONCE per file load, NOT per frame
  const fitCamera = useCallback(() => {
    const renderer = rendererRef.current;
    const cache = cacheManagerRef.current;
    if (!renderer || !cache.isReady) return;

    try {
      cache.getFrame(0).then((decoded) => {
        const positions = decoded.positions;
        const n = positions.length / 3;
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < n; i++) {
          const x = positions[i * 3];
          const y = positions[i * 3 + 1];
          const z = positions[i * 3 + 2];
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const cx = (minX + maxX) * 0.5;
        const cy = (minY + maxY) * 0.5;
        const cz = (minZ + maxZ) * 0.5;
        renderer.setCenter(cx, cy, cz);
        renderer.setCameraDistance(
          Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 1.5
        );
        dbg("[EwaViewer] Auto-fit camera to bbox center:", cx.toFixed(3), cy.toFixed(3), cz.toFixed(3));
      });
    } catch (e) {
      console.error("[EwaViewer] Failed to fit camera:", e);
    }
  }, []);

  // Initial frame load + camera fit (once per file)
  useEffect(() => {
    if (info && rendererRef.current) {
      loadFrame(0);
      fitCamera();
    }
  }, [info, loadFrame, fitCamera]);

  // Playback loop
  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(animationFrameRef.current);
      return;
    }

    lastTimeRef.current = performance.now();
    
    const tick = () => {
      const now = performance.now();
      const elapsed = now - lastTimeRef.current;
      const frameDuration = 1000 / fps;
      
      if (elapsed >= frameDuration) {
        lastTimeRef.current = now - (elapsed % frameDuration);
        const nextFrame = (currentFrame + 1) % NF;
        setCurrentFrame(nextFrame);
      }
      
      animationFrameRef.current = requestAnimationFrame(tick);
    };
    
    animationFrameRef.current = requestAnimationFrame(tick);
    
    return () => {
      cancelAnimationFrame(animationFrameRef.current);
    };
  }, [isPlaying, currentFrame, fps, NF]);

  // Load frame when currentFrame changes
  useEffect(() => {
    loadFrame(currentFrame);
  }, [currentFrame, loadFrame]);

  // Background decode (pump) during playback
  useEffect(() => {
    if (!isPlaying) return;

    const pumpInterval = setInterval(() => {
      cacheManagerRef.current.pump(currentFrame, 24);
    }, 100);

    return () => clearInterval(pumpInterval);
  }, [isPlaying, currentFrame]);

  const togglePlay = () => setIsPlaying(p => !p);
  const reset = () => {
    setCurrentFrame(0);
    setIsPlaying(false);
  };

  // Escape exits Focus View
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

  // Show loading/warmup/error state as overlay
  const showLoading = isLoading || isWarmingUp;
  const showError = !!error;

  return (
    <div 
      ref={containerRef}
      className={`relative w-full h-full bg-gray-900 ${isFocusView ? "fixed inset-0 z-[500] shadow-2xl" : ""}`}
      style={isFocusView ? { position: 'fixed' } : undefined}
    >
      {/* Canvas - always mounted so renderer init can find it */}
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ display: "block" }}
      />

      {/* Loading/Warmup overlay */}
      {showLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-900/80 backdrop-blur-sm">
          <div className="text-white/80 text-center max-w-xs">
            {isWarmingUp ? (
              <>
                <Loader2 className="w-16 h-16 mx-auto text-white/60 animate-spin mb-4" />
                <p className="text-sm font-medium mb-2">
                  {language === "vi" ? "Đang decode frames..." : "Decoding frames..."}
                </p>
                <p className="text-xs text-white/40 mb-4">
                  {warmupFrame + 1} / {totalFramesToWarmup}
                </p>
                {/* Warmup progress bar */}
                <div className="w-full bg-white/10 rounded-full h-2 mb-2 overflow-hidden">
                  <div 
                    className="h-full rounded-full transition-all duration-300 ease-out"
                    style={{ 
                      width: `${((warmupFrame + 1) / totalFramesToWarmup) * 100}%`, 
                      backgroundColor: accentColor 
                    }}
                  />
                </div>
                <p className="text-xs text-white/40">
                  {language === "vi" 
                    ? "Vui lòng chờ, đang chuẩn bị dữ liệu..." 
                    : "Please wait, preparing data..."}
                </p>
              </>
            ) : (
              <>
                <div className="animate-pulse mb-4">
                  <MonitorPlay className="w-16 h-16 mx-auto text-white/60" />
                </div>
                <p className="text-sm font-medium mb-2">Loading EWA file...</p>
                <p className="text-xs text-white/40 mb-4 truncate">{fileName}</p>
                
                {/* Progress bar */}
                <div className="w-full bg-white/10 rounded-full h-2 mb-2 overflow-hidden">
                  <div 
                    className="h-full rounded-full transition-all duration-300 ease-out"
                    style={{ 
                      width: `${loadProgress}%`, 
                      backgroundColor: accentColor 
                    }}
                  />
                </div>
                
                {/* Progress info */}
                <div className="flex justify-between text-xs text-white/40">
                  <span>{getStageLabel(loadStage)}</span>
                  <span>{loadProgress}%</span>
                </div>
                
                {loadMessage && (
                  <p className="text-xs text-white/30 mt-2">{loadMessage}</p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Error overlay */}
      {showError && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-900/90 backdrop-blur-sm">
          <div className="text-red-400 text-center p-4">
            <p className="font-medium">Error loading EWA file</p>
            <p className="text-sm mt-1">{error}</p>
          </div>
        </div>
      )}

      {/* Info overlay */}
      <div className="absolute top-2 left-2 text-white/40 text-xs font-mono">
        {nG.toLocaleString()} splats
      </div>

      {/* Timeline */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 pt-12">
        {/* Progress bar */}
        <input
          type="range"
          min={0}
          max={NF - 1}
          value={currentFrame}
          onChange={(e) => {
            const frame = parseInt(e.target.value);
            setCurrentFrame(frame);
            setIsPlaying(false);
          }}
          className="w-full h-1 rounded-full appearance-none cursor-pointer slider-thumb-accent"
          style={{
            background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${
              (currentFrame / (NF - 1)) * 100
            }%, rgba(255,255,255,0.2) ${
              (currentFrame / (NF - 1)) * 100
            }%, rgba(255,255,255,0.2) 100%)`,
            ["--accent-from-user" as string]: accentColor,
          }}
        />

        {/* Controls */}
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-1">
            {/* Play/Pause */}
            <button
              onClick={togglePlay}
              disabled={!canPlay}
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                canPlay
                  ? "bg-white/10 hover:bg-white/20 text-white"
                  : "bg-white/5 text-white/30 cursor-not-allowed"
              }`}
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? (
                <Pause className="w-4 h-4" fill="currentColor" />
              ) : (
                <Play className="w-4 h-4" fill="currentColor" />
              )}
            </button>

            {/* Reset View - fit object */}
            <button
              onClick={() => {
                if (rendererRef.current) {
                  // Get current bounding box and reset camera
                  const cache = cacheManagerRef.current;
                  cache.getFrame(currentFrame).then(frame => {
                    if (!frame || !rendererRef.current) return;
                    let minX = Infinity, maxX = -Infinity;
                    let minY = Infinity, maxY = -Infinity;
                    let minZ = Infinity, maxZ = -Infinity;
                    const p = frame.positions;
                    for (let i = 0; i < p.length; i += 3) {
                      if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
                      if (p[i+1] < minY) minY = p[i+1]; if (p[i+1] > maxY) maxY = p[i+1];
                      if (p[i+2] < minZ) minZ = p[i+2]; if (p[i+2] > maxZ) maxZ = p[i+2];
                    }
                    const cx = (minX + maxX) * 0.5;
                    const cy = (minY + maxY) * 0.5;
                    const cz = (minZ + maxZ) * 0.5;
                    rendererRef.current.setCenter(cx, cy, cz);
                    rendererRef.current.setCameraDistance(
                      Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 1.5
                    );
                  });
                }
              }}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/60 hover:text-white transition-colors"
              title={language === "vi" ? "Fit View" : "Fit View"}
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            {/* HDRI Toggle */}
            <button
              onClick={() => {
                const newVal = !hdriEnabled;
                setHdriEnabled(newVal);
                if (rendererRef.current) {
                  rendererRef.current.setHdriEnabled(newVal);
                }
              }}
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                hdriEnabled
                  ? "bg-white/20 text-white"
                  : "bg-white/10 hover:bg-white/20 text-white/40"
              }`}
              title="HDRI"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="5"/>
                <line x1="12" y1="1" x2="12" y2="3"/>
                <line x1="12" y1="21" x2="12" y2="23"/>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                <line x1="1" y1="12" x2="3" y2="12"/>
                <line x1="21" y1="12" x2="23" y2="12"/>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
            </button>

            {/* Color Grade Toggle */}
            <button
              onClick={() => setShowColorGrade(!showColorGrade)}
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                showColorGrade
                  ? "bg-white/20 text-white"
                  : "bg-white/10 hover:bg-white/20 text-white/60 hover:text-white"
              }`}
              title="Color Grade"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 2a10 10 0 0 1 0 20"/>
                <circle cx="12" cy="12" r="4"/>
              </svg>
            </button>

            {/* Flip Y Toggle */}
            <FlipYButton
              flipY={flipY}
              onToggle={() => {
                const next = !flipY;
                setFlipY(next);
                if (rendererRef.current) {
                  rendererRef.current.setFlipY(next);
                }
              }}
            />

            {/* Export PLY Sequence (one file per frame, auto-numbered) */}
            <button
              onClick={handleExportPly}
              disabled={isExporting || !info}
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                isExporting
                  ? "bg-white/20 text-white cursor-wait"
                  : "bg-white/10 hover:bg-white/20 text-white/60 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
              }`}
              title={language === "vi" ? "Export Ply" : "Export Ply"}
            >
              {isExporting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
            </button>
          </div>

          <div className="flex items-center gap-1">
            <div className="text-white/40 text-xs font-mono">
              {currentFrame + 1} / {NF} @ {fps} fps
            </div>

            {/* Divider */}
            <div className="w-px h-6 bg-white/10 mx-1" />

            {/* Focus View */}
            <button
              onClick={() => setIsFocusView(!isFocusView)}
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                isFocusView
                  ? "bg-white/20 text-white"
                  : "bg-white/10 hover:bg-white/20 text-white/60 hover:text-white"
              }`}
              title="Focus View"
            >
              <Maximize className="w-4 h-4" />
            </button>
            
            {/* Fullscreen */}
            <button
              onClick={() => {
                if (!document.fullscreenElement) {
                  containerRef.current?.requestFullscreen().catch(() => {});
                } else {
                  document.exitFullscreen();
                }
              }}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/60 hover:text-white transition-colors"
              title="Fullscreen"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
              </svg>
            </button>
          </div>
        </div>

        {/* In-app naming modal (replaces native window.prompt) */}
        {namePromptOpen && (
          <div
            className="fixed inset-0 z-40 flex items-center justify-center"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) cancelExportName();
            }}
          >
            <div
              className="w-[360px] rounded-lg shadow-2xl p-4 flex flex-col gap-3 border"
              style={{
                backgroundColor: "var(--app-bg)",
                borderColor: "rgba(var(--app-bg-rgb,25,25,25),0.18)",
                boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-sm font-medium text-white/90">
                {language === "vi" ? "Đặt tên file PLY" : "Name PLY files"}
              </div>
              <div className="text-[11px] text-white/50 leading-relaxed">
                {language === "vi"
                  ? <>Mỗi frame sẽ tự thêm hậu tố <span className="font-mono text-white/70">_001, _002…</span><br />Ví dụ: nhập <span className="font-mono text-white/70">Take 01</span> → <span className="font-mono text-white/70">Take 01_001.ply</span></>
                  : <>Each frame auto-appends <span className="font-mono text-white/70">_001, _002…</span><br />Example: <span className="font-mono text-white/70">Take 01</span> → <span className="font-mono text-white/70">Take 01_001.ply</span></>}
              </div>
              <input
                autoFocus
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    confirmExportName();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelExportName();
                  }
                }}
                className="w-full px-3 py-1.5 rounded text-sm font-mono text-white outline-none border focus:border-sky-400/60"
                style={{
                  backgroundColor: "rgba(var(--app-bg-rgb,25,25,25),0.35)",
                  borderColor: "rgba(255,255,255,0.12)",
                }}
              />
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={cancelExportName}
                  className="px-3 py-1 rounded text-xs text-white/70 hover:bg-white/10 transition-colors"
                >
                  {language === "vi" ? "Huỷ" : "Cancel"}
                </button>
                <button
                  onClick={confirmExportName}
                  className="px-3 py-1 rounded text-xs font-medium bg-sky-500 hover:bg-sky-400 text-white transition-colors"
                >
                  {language === "vi" ? "Export" : "Export"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Export progress — centred modal with progress bar (fixed to viewport) */}
        {isExporting && exportBar && (
          <div
            className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none"
          >
            <div
              className="w-[380px] rounded-lg shadow-2xl p-4 flex flex-col gap-3 border pointer-events-auto"
              style={{
                backgroundColor: "var(--app-bg)",
                borderColor: "rgba(var(--app-bg-rgb,25,25,25),0.18)",
                boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
              }}
            >
              <div className="text-sm font-medium text-white/90">
                {language === "vi" ? "Đang export PLY..." : "Exporting PLY..."}
              </div>
              <div className="text-[11px] text-white/50 font-mono">
                {exportBar.lastName || (language === "vi" ? "Đang chuẩn bị..." : "Preparing...")}
              </div>
              <div
                className="h-2 rounded-full overflow-hidden border"
                style={{
                  backgroundColor: "rgba(var(--app-bg-rgb,25,25,25),0.6)",
                  borderColor: "rgba(255,255,255,0.08)",
                }}
              >
                <div
                  className="h-full transition-[width] duration-150 ease-out"
                  style={{
                    width: `${exportBar.total > 0 ? Math.round((exportBar.done / exportBar.total) * 100) : 0}%`,
                    backgroundColor: "rgb(56, 189, 248)",
                  }}
                />
              </div>
              <div className="text-[11px] text-white/70 font-mono flex justify-between">
                <span>
                  {exportBar.done}/{exportBar.total}
                </span>
                <span>
                  {exportBar.total > 0 ? Math.round((exportBar.done / exportBar.total) * 100) : 0}%
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Color Grade Panel - dropdown below */}
        {showColorGrade && (
          <div className="absolute left-4 bottom-full mb-2 z-20">
            <ColorGradePanel
              renderer={rendererRef}
              language={language}
              accentColor={accentColor}
              onClose={() => setShowColorGrade(false)}
            />
          </div>
        )}
      </div>

      {/* Focus View overlay - click outside to close */}
      {isFocusView && (
        <button
          className="fixed top-4 right-4 z-[510] w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/60 hover:text-white transition-colors"
          onClick={() => setIsFocusView(false)}
          title="Close Focus View"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
