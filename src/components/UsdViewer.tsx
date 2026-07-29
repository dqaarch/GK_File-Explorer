import React, { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { AlertCircle, Loader2 } from "lucide-react";

declare global {
  interface Window {
    USD: any;
    renderInterface: any;
    driver: any;
    usdRoot: any;
    camera: any;
    scene: any;
    renderer: any;
    _controls: any;
  }
}

interface UsdViewerProps {
  fileName: string;
  filePath?: string;
  accentColor: string;
}

const EMHD_BINDINGS_CACHE_KEY = "20260318a";

function withCacheKey(resourcePath: string): string {
  if (!resourcePath) return resourcePath;
  return resourcePath.includes("?")
    ? `${resourcePath}&v=${EMHD_BINDINGS_CACHE_KEY}`
    : `${resourcePath}?v=${EMHD_BINDINGS_CACHE_KEY}`;
}

async function loadEmHdBindings(): Promise<any> {
  if ((window as any).USD) return (window as any).USD;

  const mainScriptUrl = withCacheKey("/usd-bindings/emHdBindings.js");

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = mainScriptUrl;
    script.async = true;
    script.onload = async () => {
      try {
        const getModule = (window as any)["NEEDLE:USD:GET"];
        if (!getModule) {
          throw new Error("NEEDLE:USD:GET not found after loading emHdBindings.js");
        }

        const USD = await getModule({
          mainScriptUrlOrBlob: mainScriptUrl,
          locateFile: (file: string) => {
            return `/usd-bindings/${file}`;
          },
          PTHREAD_POOL_LIMIT: 4,
          PTHREAD_POOL_SIZE: 2,
          PTHREAD_NUM_CORES: 2,
          PTHREAD_POOL_PREWARM: true,
          print: (...args: any[]) => console.log("[WASM]", ...args),
          printErr: (...args: any[]) => console.error("[WASM Error]", ...args),
        });

        (window as any).USD = USD;
        resolve(USD);
      } catch (error) {
        reject(error);
      }
    };
    script.onerror = () => reject(new Error(`Failed to load ${mainScriptUrl}`));
    document.head.appendChild(script);
  });
}

async function loadUsdFile(USD: any, filePath: string): Promise<void> {
  if (!window.usdRoot || !window.renderer || !window.scene) {
    throw new Error("Scene not initialized");
  }

  console.log("[UsdViewer] Loading USD:", filePath);

  const usdStage = await USD.Stage.Open(filePath);
  if (!usdStage) {
    throw new Error("Failed to open USD stage");
  }

  (window as any).usdStage = usdStage;

  const driver = new USD.HdWebSyncDriver(window.scene, {
    threaded: true,
    maxLights: 16,
  });

  await driver.SyncAll();
  (window as any).driver = driver;

  const renderInterface = new USD.HdWebRenderDelegateInterface(window.scene, driver);
  (window as any).renderInterface = renderInterface;

  window.usdRoot.clear();
  window.scene.add(window.usdRoot);

  renderInterface.PopulateStage(usdStage, window.usdRoot);
  await driver.SyncAll();

  console.log("[UsdViewer] USD loaded successfully");
}

export default function UsdViewer({ fileName, filePath, accentColor }: UsdViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const initialized = useRef(false);
  const animationRef = useRef<number | null>(null);

  const renderScene = useCallback(() => {
    if (window.renderer && window.scene && window.camera) {
      window.renderer.render(window.scene, window.camera);
    }
  }, []);

  const animate = useCallback(() => {
    if (initialized.current) {
      window._controls?.update();
      renderScene();
      animationRef.current = requestAnimationFrame(animate);
    }
  }, [renderScene]);

  const handleResize = useCallback(() => {
    if (!containerRef.current || !window.camera || !window.renderer) return;

    const { clientWidth, clientHeight } = containerRef.current;
    window.camera.aspect = clientWidth / clientHeight;
    window.camera.updateProjectionMatrix();
    window.renderer.setSize(clientWidth, clientHeight);
    renderScene();
  }, [renderScene]);

  useEffect(() => {
    if (!containerRef.current || initialized.current) return;

    const initScene = async () => {
      try {
        setLoading(true);
        setProgress(10);

        const { clientWidth, clientHeight } = containerRef.current!;
        const camera = new THREE.PerspectiveCamera(45, clientWidth / clientHeight, 0.1, 1000);
        camera.position.set(5, 5, 5);
        (window as any).camera = camera;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1a1a2e);
        (window as any).scene = scene;

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(clientWidth, clientHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;
        containerRef.current!.appendChild(renderer.domElement);
        (window as any).renderer = renderer;

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(5, 10, 5);
        scene.add(directionalLight);

        const usdRoot = new THREE.Group();
        usdRoot.name = "USD Root";
        scene.add(usdRoot);
        (window as any).usdRoot = usdRoot;

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        (window as any)._controls = controls;

        setProgress(30);

        window.addEventListener("resize", handleResize);

        setProgress(50);

        const USD = await loadEmHdBindings();
        setProgress(70);

        if (filePath) {
          await loadUsdFile(USD, filePath);
          setProgress(100);
        }

        initialized.current = true;
        setLoading(false);
        animate();

      } catch (err) {
        console.error("[UsdViewer] Error:", err);
        setError(err instanceof Error ? err.message : "Failed to initialize USD viewer");
        setLoading(false);
      }
    };

    initScene();

    return () => {
      initialized.current = false;
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      window.removeEventListener("resize", handleResize);
      if (window.renderer?.domElement && containerRef.current) {
        containerRef.current.removeChild(window.renderer.domElement);
      }
      (window as any).camera = null;
      (window as any).scene = null;
      (window as any).renderer = null;
      (window as any)._controls = null;
      (window as any).usdRoot = null;
      (window as any).USD = null;
    };
  }, [filePath, handleResize, animate]);

  return (
    <div className="relative w-full h-full" ref={containerRef}>
      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#1a1a2e] z-10">
          <Loader2 className="w-12 h-12 animate-spin mb-4" style={{ color: accentColor }} />
          <div className="text-white/80 text-sm mb-2">Loading USD Module...</div>
          <div className="w-48 h-1 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${progress}%`, backgroundColor: accentColor }}
            />
          </div>
          <div className="text-white/50 text-xs mt-1">{progress}%</div>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#1a1a2e] z-10">
          <AlertCircle className="w-12 h-12 text-red-400 mb-4" />
          <div className="text-white/80 text-sm mb-1">Failed to load USD</div>
          <div className="text-red-400 text-xs text-center px-8">{error}</div>
        </div>
      )}

      {!loading && !error && (
        <div className="absolute top-3 left-3 bg-black/50 backdrop-blur-sm rounded-lg px-3 py-1.5">
          <span className="text-white/80 text-xs font-medium">{fileName}</span>
        </div>
      )}
    </div>
  );
}
