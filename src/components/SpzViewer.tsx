/**
 * SpzViewer - Loads compressed Gaussian Splat files (.spz)
 * 
 * Uses gaussian-splats-3d's Viewer with the existing three.js context
 * passed from 3DModelViewer. SPZ is natively supported by the library
 * so no conversion needed - just download and render.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

const HTTP_SERVER = "http://localhost:18765";

interface SpzViewerProps {
  fileName: string;
  filePath: string;
  accentColor?: string;
  language?: "vi" | "en";
  onDispose?: () => void;
  gsViewerRef: React.MutableRefObject<{ dispose: () => void; start: () => void } | null>;
  gsBlobUrlRef: React.MutableRefObject<string | null>;
  rendererRef: React.MutableRefObject<any>;
  sceneRef: React.MutableRefObject<any>;
  cameraRef: React.MutableRefObject<any>;
  controlsRef: React.MutableRefObject<any>;
  gsAnimateFrameRef: React.MutableRefObject<(() => void) | null>;
}

export default function SpzViewer({
  fileName,
  filePath,
  accentColor = "#3b82f6",
  language = "vi",
  onDispose,
  gsViewerRef,
  gsBlobUrlRef,
  rendererRef,
  sceneRef,
  cameraRef,
  controlsRef,
  gsAnimateFrameRef,
}: SpzViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const animateFrameRef = useRef<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let currentViewer: any = null;

    const loadSpz = async () => {
      try {
        setIsLoading(true);
        setError(null);
        setProgress(5);

        // Build the HTTP URL
        const encodedPath = encodeURIComponent(filePath);
        const modelUrl = `${HTTP_SERVER}/file?path=${encodedPath}`;

        // Import gaussian-splats-3d
        const { Viewer, SceneFormat, RenderMode } = await import("@mkkellogg/gaussian-splats-3d");
        setProgress(15);

        if (!mountedRef.current) return;

        // Create viewer with existing three.js context
        const canvas = canvasRef.current;
        const renderer = rendererRef.current;
        const scene = sceneRef.current;
        const camera = cameraRef.current;

        currentViewer = new Viewer({
          canvas,
          selfDrivenMode: false,
          renderMode: RenderMode.Always,
          sharedMemoryForWorkers: false,
          // Pass three.js context if available
          ...(renderer && { renderer }),
          ...(scene && { threeScene: scene }),
          ...(camera && { camera }),
          useBuiltInControls: false,
          showLoadingUI: false,
          // Disable GPU sort for WebView2 compatibility
          gpuAcceleratedSort: false,
          enableSIMDInSort: false,
          integerBasedSort: true,
          halfPrecisionCovariancesOnGPU: false,
          dynamicScene: false,
        });

        viewerRef.current = currentViewer;
        gsViewerRef.current = currentViewer;

        setProgress(25);

        // Wait for viewer to be ready
        await currentViewer.ready;
        if (!mountedRef.current) return;

        setProgress(35);

        // Load the SPZ scene
        await currentViewer.addSplatScene(modelUrl, {
          format: SceneFormat.Spz,
          showLoadingUI: false,
          progressiveLoad: true,
          splatAlphaRemovalThreshold: 5,
          onProgress: (percent: number) => {
            if (mountedRef.current) {
              setProgress(Math.round(35 + percent * 0.6));
            }
          },
        });

        if (!mountedRef.current) return;

        setProgress(100);
        setIsLoading(false);

        // Start animation loop
        const renderLoop = () => {
          if (!mountedRef.current) return;
          animateFrameRef.current = requestAnimationFrame(renderLoop);
          try {
            controlsRef.current?.update();
            currentViewer.update?.();
            currentViewer.render?.();
          } catch (_e) {
            // Ignore
          }
        };
        animateFrameRef.current = requestAnimationFrame(renderLoop);
        gsAnimateFrameRef.current = () => renderLoop();

      } catch (e) {
        console.error("[SpzViewer] Error:", e);
        if (mountedRef.current) {
          setError(e instanceof Error ? e.message : String(e));
          setIsLoading(false);
        }
      }
    };

    loadSpz();

    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(animateFrameRef.current);
      
      viewerRef.current?.dispose?.();
      gsViewerRef.current?.dispose?.();
      gsViewerRef.current = null;
      
      if (gsBlobUrlRef.current) {
        URL.revokeObjectURL(gsBlobUrlRef.current);
        gsBlobUrlRef.current = null;
      }
      
      onDispose?.();
    };
  }, [filePath]);

  const t = (vi: string, en: string) => (language === "vi" ? vi : en);

  return (
    <div ref={containerRef} className="relative w-full h-full bg-gray-900">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ display: "block" }}
      />

      {isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-900/80 backdrop-blur-sm">
          <div className="text-white/80 text-center">
            <Loader2 className="w-12 h-12 mx-auto text-white/60 animate-spin mb-4" />
            <p className="text-sm font-medium mb-2">
              {t("Đang tải SPZ...", "Loading SPZ...")}
            </p>
            <div className="w-48 h-1 bg-white/20 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${progress}%`, backgroundColor: accentColor }}
              />
            </div>
            <p className="text-xs text-white/40 mt-2">{progress}%</p>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-900/90">
          <div className="text-red-400 text-center max-w-md px-4">
            <p className="text-sm font-medium mb-2">
              {t("Lỗi khi tải SPZ", "Failed to load SPZ")}
            </p>
            <p className="text-xs text-red-400/70 font-mono break-all">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
}
