import React, { useState, useRef, useEffect, useCallback, Suspense } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ViewportGizmo } from "three-viewport-gizmo";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { IGESLoader } from "three-iges-loader";
import { Box, Grid3x3, Maximize, MonitorPlay, AlertCircle, Play, Pause, RotateCcw, Bone, FlipVertical2 } from "lucide-react";
import { ModelLoadingProgress } from "./ModelLoadingProgress";
import {
  convertPlyToKsplat,
  detectGaussianSplatFormat,
  type ConvertProgress,
} from "../utils/gaussianSplatConverter";
import { loadAlembicFromBuffer, closeAlembic } from "../utils/WabcLoader";
import USDScene, { type USDViewerHandle } from "./usd/USDScene";
import EwaViewer from "./EwaViewer/EwaViewer";
import { decodeStl, type StlDecodeResult } from "../TauriFileSystem";

interface ThreeDModelViewerProps {
  fileName: string;
  filePath?: string;
  accentColor: string;
  language?: "vi" | "en";
}

type ViewMode = "default" | "wireframe" | "matcap" | "xray";
type MatcapId = "default" | "normal";

// Bundled matcaps served by Vite at /matcaps/<file>. Object fits on a sphere
// projection, so each matcap colour reads as a shaded surface from any angle.
// Use absolute paths rooted at `/matcaps/` so the fetch works regardless of
// which chunk this module is bundled into (Vite emits hashed chunks under
// `/assets/`, so a relative "./matcaps/..." would resolve to the wrong
// directory).
const MATCAPS: Record<MatcapId, { label: string; file: string }> = {
  default: { label: "Default", file: "/matcaps/matcap-default.png" },
  normal:  { label: "Normal",  file: "/matcaps/matcap-normal.png" },
};

// Resolve a matcap path to an absolute URL honouring the dev-server origin
// when running under `vite dev`, and the `tauri.localhost` origin when
// running under a built Tauri bundle. This produces a URL that the active
// fetch context can always reach, regardless of which chunk the module was
// bundled into.
function resolveMatcapUrl(file: string): string {
  try {
    const origin = typeof window !== "undefined" && window.location
      ? window.location.origin
      : "";
    return origin ? new URL(file, origin + "/").toString() : file;
  } catch {
    return file;
  }
}

// Module-level cache: shared across every <ThreeDModelViewer /> mount so we
// only hit the network/GPU once per app session. The parent preview swaps the
// `key` on every file change which forces a full unmount/remount of this
// component; without this cache each remount would re-fetch the PNGs and the
// Tauri WebView2 would intermittently reject the second fetch with an opaque
// Event error from three.js's TextureLoader.
const matcapGlobalCache: Partial<Record<MatcapId, THREE.Texture>> = {};
const matcapGlobalPending: Partial<Record<MatcapId, Promise<THREE.Texture | null>>> = {};

function getMatcapTexture(matcaps: Record<MatcapId, THREE.Texture | null>, id: MatcapId): THREE.Texture | null {
  return matcaps[id] ?? null;
}

const HTTP_SERVER = "http://localhost:18765";
const DRACO_DECODER_PATH = "./draco/";

// CAD Worker management
let cadWorkerInstance: Worker | null = null;
let cadWorkerReady = false;
let cadWorkerInitPromise: Promise<void> | null = null;

async function initCadWorker(): Promise<void> {
  if (cadWorkerReady) return;
  if (cadWorkerInitPromise) return cadWorkerInitPromise;

  cadWorkerInitPromise = new Promise((resolve) => {
    cadWorkerInstance = new Worker(new URL("/workers/cad-decoder.js", import.meta.url), {
      type: 'module'
    });

    cadWorkerInstance.onmessage = (e) => {
      const { type, success } = e.data;
      if (type === "init" && success) {
        cadWorkerReady = true;
        resolve();
      }
    };

    cadWorkerInstance.onerror = (err) => {
      console.error('[CAD Worker] Error:', err);
      resolve(); // Continue anyway - will use sync fallback
    };

    // Initialize with WASM binary
    fetch(new URL("occt-import-js/dist/occt-import-js.wasm", import.meta.url))
      .then(r => r.arrayBuffer())
      .then(buf => {
        cadWorkerInstance?.postMessage({ type: "init", wasmBuffer: buf });
      })
      .catch(err => {
        console.error('[CAD Worker] Failed to load WASM:', err);
        resolve();
      });
  });

  return cadWorkerInitPromise;
}

function getCadWorker(): Worker | null {
  return cadWorkerInstance;
}

function getFileExt(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() || "";
}

async function fetchArrayBuffer(
  url: string,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching model`);
  }
  const contentLength = response.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  const reader = response.body?.getReader();
  if (!reader) {
    onProgress?.(50);
    return await response.arrayBuffer();
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastProgressUpdate = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) {
      if (total > 0) {
        onProgress(Math.round((received / total) * 50));
      } else {
        // No content-length: estimate based on chunk count (every ~8 chunks = 10%)
        const estimatedPercent = Math.floor(chunks.length / 8) * 10;
        if (estimatedPercent !== lastProgressUpdate && estimatedPercent < 50) {
          onProgress(estimatedPercent);
          lastProgressUpdate = estimatedPercent;
        }
      }
    }
  }
  const buffer = new Uint8Array(received);
  let position = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, position);
    position += chunk.length;
  }
  onProgress?.(50);
  return buffer.buffer as ArrayBuffer;
}

function isGlbBinary(data: ArrayBuffer): boolean {
  if (data.byteLength < 4) return false;
  const header = new Uint8Array(data, 0, 4);
  return header[0] === 0x67 && header[1] === 0x6c && header[2] === 0x54 && header[3] === 0x46;
}

function makeDefaultMatcapMaterial(matcap: THREE.Texture | null, matcapId: MatcapId = "default", flatShading = false): THREE.MeshMatcapMaterial {
  // Pick a base tint that flatters each matcap. The PNG already encodes
  // bake shading, so we keep the material itself neutral and let the texture
  // carry the colour.
  const tinted = matcapId === "normal"
    ? new THREE.Color(0xffffff)
    : new THREE.Color(0xc8c8c8);
  // Reuse one matcap texture instance for every default material so we only
  // upload it to the GPU once.
  //
  // - DoubleSide: render both faces. Alembic meshes can have inconsistent
  //   winding between exported objects, and i-saint's renderer doesn't care
  //   about back-face culling — so we match that here.
  // - flatShading: Controls smoothing. Alembic has no normal data so uses
  //   flat shading. Other formats (FBX, OBJ, GLTF, etc.) have normal data
  //   so use smooth shading to preserve the original shading.
  return new THREE.MeshMatcapMaterial({
    color: tinted,
    matcap: matcap,
    side: THREE.DoubleSide,
    flatShading: flatShading,
  });
}

// True when a material carries any PBR map that should be preserved.
// We treat the material as "textured" if any of the standard PBR slots are
// populated, otherwise the model is untextured and we substitute a matcap.
function materialHasTextureMap(material: THREE.Material | undefined | null): boolean {
  if (!material) return false;
  const m = material as unknown as Record<string, unknown>;
  return Boolean(
    m.map ||
      m.normalMap ||
      m.roughnessMap ||
      m.metalnessMap ||
      m.aoMap ||
      m.emissiveMap ||
      m.bumpMap ||
      m.displacementMap ||
      m.alphaMap ||
      m.specularMap ||
      m.specularIntensityMap ||
      m.clearcoatMap ||
      m.clearcoatRoughnessMap ||
      m.clearcoatNormalMap ||
      m.sheenColorMap ||
      m.sheenRoughnessMap ||
      m.iridescenceMap ||
      m.iridescenceThicknessMap ||
      m.transmissionMap ||
      m.thicknessMap,
  );
}

function meshHasAnyTextureMap(mesh: THREE.Mesh): boolean {
  if (Array.isArray(mesh.material)) {
    return mesh.material.some((m) => materialHasTextureMap(m));
  }
  return materialHasTextureMap(mesh.material as THREE.Material);
}

function decodeTextChunk(data: Uint8Array): string {
  return new TextDecoder("utf-8").decode(data);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Convert an occt-import-js result (STEP/IGES/BREP) to a THREE.Group.
 * The result format is documented in occt-import-js README:
 * - meshes[].attributes.position.array: Float32Array of vertex positions
 * - meshes[].attributes.normal.array: Float32Array of normals (optional)
 * - meshes[].index.array: Uint32Array of triangle indices
 * - meshes[].color: [r, g, b] (optional)
 */
function occtResultToThreeGroup(result: {
  success: boolean;
  root?: { name: string; meshes: number[]; children: unknown[] };
  meshes?: Array<{
    name?: string;
    color?: number[];
    attributes?: {
      position?: { array: Float32Array };
      normal?: { array: Float32Array };
    };
    index?: { array: Uint32Array | number[] };
  }>;
}): THREE.Group {
  const group = new THREE.Group();

  if (!result.success || !result.meshes || result.meshes.length === 0) {
    return group;
  }

  for (const mesh of result.meshes) {
    const posAttr = mesh.attributes?.position;
    const normAttr = mesh.attributes?.normal;
    const idxAttr = mesh.index;

    if (!posAttr?.array || !idxAttr?.array) continue;

    const positions = posAttr.array;
    const indices = idxAttr.array;
    const normals = normAttr?.array;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

    if (normals && normals.length > 0) {
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    } else {
      geometry.computeVertexNormals();
    }

    // occt-import-js uses Uint32Array for indices in WASM, but might be plain array
    const indexArray = indices instanceof Uint32Array
      ? indices
      : new Uint32Array(indices as number[]);
    geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));

    const material = new THREE.MeshStandardMaterial({
      color: mesh.color ? new THREE.Color(mesh.color[0], mesh.color[1], mesh.color[2]) : 0xcccccc,
      side: THREE.DoubleSide,
      flatShading: false,
    });

    const threeMesh = new THREE.Mesh(geometry, material);
    if (mesh.name) threeMesh.name = mesh.name;
    group.add(threeMesh);
  }

  return group;
}

/**
 * Convert a 3DGS PLY buffer in-memory and hand it to the
 * @mkkellogg/gaussian-splats-3d viewer wired to our existing three.js
 * scene, renderer and camera. Returns once the splat mesh has been added
 * to the scene; the Viewer keeps running until the caller disposes it.
 *
 * Lifecycle:
 *   - The ksplat ArrayBuffer is kept on `ksplatBufferRef.current` so the
 *     unmount cleanup can release it (its size can reach hundreds of MB).
 *   - The Viewer instance is kept on `splatViewerRef.current` for the same
 *     reason.
 *   - The intermediate blob: URL is revoked after addSplatScene resolves;
 *     the viewer copies the buffer into its own GPU texture during load.
 */
/**
 * Load a pre-compressed SPZ splat file directly into the GaussianSplats3D
 * viewer without conversion. SPZ files are already in ksplat format.
 */
async function loadSpzScene(
  spzBuffer: ArrayBuffer,
  setProgress: (p: ConvertProgress | null) => void,
  splatViewerRef: React.MutableRefObject<{ dispose: () => void; start: () => void } | null>,
  blobUrlRef: React.MutableRefObject<string | null>,
  animateFrameRef: React.MutableRefObject<number>,
  isMounted: () => boolean,
  getRenderer: () => THREE.WebGLRenderer | null,
  getScene: () => THREE.Scene | null,
  getCamera: () => THREE.PerspectiveCamera | null,
  getControls: () => OrbitControls | null,
  setError: (msg: string | null) => void,
  setLoading: (b: boolean) => void,
  initialFlipY: boolean = true,
  language: "vi" | "en" = "en",
): Promise<void> {
  const t = (vi: string, en: string) => (language === "vi" ? vi : en);

  const TWO_GB = 2 * 1024 * 1024 * 1024;
  if (spzBuffer.byteLength > TWO_GB) {
    throw new Error(
      t(
        `File ${formatBytes(spzBuffer.byteLength)} vượt giới hạn 2 GB của V8 ArrayBuffer.`,
        `File ${formatBytes(spzBuffer.byteLength)} exceeds the 2 GB V8 ArrayBuffer limit.`,
      ),
    );
  }

  setProgress({
    percent: 0,
    label: t("Đang chuẩn bị SPZ Splats...", "Preparing SPZ Splats..."),
    etaSeconds: null,
  });
  setLoading(true);
  setError(null);

  const renderer = getRenderer();
  const scene = getScene();
  const camera = getCamera();
  if (!renderer || !scene || !camera) {
    throw new Error("Three.js scene not ready when feeding splat viewer.");
  }

  setProgress({
    percent: 50,
    label: t("Đang tải splat mesh lên GPU...", "Uploading splat mesh to GPU..."),
    etaSeconds: 2,
  });

  const { Viewer, SceneFormat, RenderMode, SpzLoader } = await import("@mkkellogg/gaussian-splats-3d");

  const viewer = new Viewer({
    selfDrivenMode: false,
    threeScene: scene,
    renderer,
    camera,
    useBuiltInControls: false,
    sharedMemoryForWorkers: false,
    gpuAcceleratedSort: false,
    enableSIMDInSort: false,
    integerBasedSort: true,
    halfPrecisionCovariancesOnGPU: false,
    dynamicScene: false,
    freeIntermediateSplatData: true,
    renderMode: RenderMode.Always,
    showLoadingUI: false,
  });

  splatViewerRef.current = viewer as unknown as { dispose: () => void; start: () => void };

  // SPZ is already in spz format - just wrap in blob and load
  const blob = new Blob([spzBuffer], { type: "application/octet-stream" });
  const blobUrl = URL.createObjectURL(blob);
  blobUrlRef.current = blobUrl;

  try {
    // Debug: Check SPZ file header
    const first4BytesArr = new Uint8Array(spzBuffer.slice(0, 4));
    const first4Chars = Array.from(first4BytesArr).map(b => String.fromCharCode(b)).join('');
    const isGzip = first4BytesArr[0] === 0x1f && first4BytesArr[1] === 0x8b;
    const headerHex = Array.from(new Uint8Array(spzBuffer.slice(0, 16))).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log('[SPZ DEBUG] First 4 chars:', JSON.stringify(first4Chars), '| gzip:', isGzip, '| header:', headerHex);

    // Check if it's a PLY file
    if (first4Chars.startsWith('ply')) {
      console.log('[SPZ DEBUG] Detected PLY format, redirecting...');
      throw new Error('PLY');
    }

    setProgress({
      percent: 55,
      label: t("Đang giải nén SPZ...", "Decompressing SPZ..."),
      etaSeconds: null,
    });

    console.log('[SPZ DEBUG] Calling SpzLoader.loadFromFileData...');
    const splatBuffer = await SpzLoader.loadFromFileData(spzBuffer);
    console.log('[SPZ DEBUG] SpzLoader.loadFromFileData completed, splatBuffer:', splatBuffer);

    setProgress({
      percent: 80,
      label: t("Đang tạo splat mesh...", "Creating splat mesh..."),
      etaSeconds: null,
    });

    console.log('[SPZ DEBUG] Calling viewer.addSplatBuffers...');
    // Add the splat buffer to the viewer
    (viewer as any).addSplatBuffers([splatBuffer], [{
      rotation: [0, 0, 0, 1],
      scale: [1, initialFlipY ? -1 : 1, 1],
    }], true, false, false, false, false);
    console.log('[SPZ DEBUG] viewer.addSplatBuffers completed');

    if (viewer.splatMesh && initialFlipY) {
      viewer.splatMesh.scale.y = -1;
    }

    // selfDrivenMode:false => we drive our own render loop, identical to PLY path.
    const splatViewer = viewer as unknown as {
      update: () => void;
      render: () => void;
      shouldRender?: () => boolean;
      dispose: () => Promise<void>;
    };
    const controls = getControls();
    const renderSplats = () => {
      animateFrameRef.current = requestAnimationFrame(renderSplats);
      controls?.update();
      splatViewer.update();
      try {
        if (!splatViewer.shouldRender || splatViewer.shouldRender()) {
          splatViewer.render();
        }
      } catch (e) {
        console.warn("[3DViewer] splat render failed:", e);
      }
    };
    animateFrameRef.current = requestAnimationFrame(renderSplats);

    // Auto-frame camera around scene center
    const splatBufferAny = splatBuffer as any;
    const sceneCenter = splatBufferAny?.getSceneCenter?.()
      ?? splatBufferAny?.sceneCenter
      ?? { x: 0, y: 0, z: 0 };
    const distance = 3;
    camera.position.set(
      sceneCenter.x + distance,
      sceneCenter.y + distance * 0.6,
      sceneCenter.z + distance,
    );
    camera.lookAt(
      new THREE.Vector3(sceneCenter.x, sceneCenter.y, sceneCenter.z),
    );
    camera.updateProjectionMatrix();
    controls?.target.set(sceneCenter.x, sceneCenter.y, sceneCenter.z);
    controls?.update();

    setProgress({ percent: 100, label: t("Hoàn tất!", "Done!"), etaSeconds: 0 });
    setLoading(false);

    // Hide progress overlay after a brief moment so the user sees the
    // "Done!" message before it disappears.
    setTimeout(() => {
      if (!isMounted()) return;
      setProgress(null);
    }, 600);

    // Clean up blob URL after load
    setTimeout(() => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    }, 1000);
  } catch (err: any) {
    setError(err?.message || String(err));
    setLoading(false);
  }
}

async function loadGaussianSplatScene(
  plyBuffer: ArrayBuffer,
  _initialProgress: ConvertProgress | null,
  setProgress: (p: ConvertProgress | null) => void,
  cancel: { cancelled: boolean },
  ksplatBufferRef: React.MutableRefObject<ArrayBuffer | null>,
  splatViewerRef: React.MutableRefObject<{ dispose: () => void; start: () => void } | null>,
  blobUrlRef: React.MutableRefObject<string | null>,
  animateFrameRef: React.MutableRefObject<number>,
  isMounted: () => boolean,
  getRenderer: () => THREE.WebGLRenderer | null,
  getScene: () => THREE.Scene | null,
  getCamera: () => THREE.PerspectiveCamera | null,
  getControls: () => OrbitControls | null,
  setError: (msg: string | null) => void,
  setLoading: (b: boolean) => void,
  plyInfo: { format: string; splatCount: number; headerText: string },
  initialFlipY: boolean = true,
  language: "vi" | "en" = "en",
): Promise<void> {
  const t = (vi: string, en: string) => (language === "vi" ? vi : en);
  // Resource guards. We allow up to ~2 GB (V8 ArrayBuffer limit on 64-bit) but
  // warn the user through the console for files that already chew through
  // hundreds of MB at load time.
  const TWO_GB = 2 * 1024 * 1024 * 1024;
  if (plyBuffer.byteLength > TWO_GB) {
    throw new Error(
      t(
        `File ${formatBytes(plyBuffer.byteLength)} vượt giới hạn 2 GB của V8 ArrayBuffer. Hãy cắt bớt splats trước khi mở.`,
        `File ${formatBytes(plyBuffer.byteLength)} exceeds the 2 GB V8 ArrayBuffer limit. Try trimming splats before opening.`,
      ),
    );
  }
  if (plyBuffer.byteLength > 500 * 1024 * 1024) {
    console.warn(
      `[3DViewer] 3DGS PLY ${formatBytes(plyBuffer.byteLength)} > 500 MB; ` +
        t(
          `sẽ tốn RAM đáng kể. Nếu app đơ / crash, hãy mở file nhỏ hơn.`,
          `will use a lot of RAM. If the app freezes or crashes, try a smaller file.`,
        ),
    );
  }

  setProgress({
    percent: 0,
    label: t("Đang chuẩn bị Gaussian Splats...", "Preparing Gaussian Splats..."),
    etaSeconds: null,
  });
  setLoading(true);
  setError(null);

  // Run the actual convert on the main thread. The library parses PLY in
  // ~5–15s for a 2M-splat file. We yield between stages so the progress bar
  // can paint at least once per stage.
  //
  // outSphericalHarmonicsDegree = 0 means we only use f_dc_0/1/2 (base
  // colour). That keeps the convert fast and the ksplat buffer small.
  // For PlayCanvas-compressed PLYs there are no f_rest_* properties
  // anyway, so this setting has no effect on those files.
  const result = await convertPlyToKsplat(
    plyBuffer,
    (p) => {
      if (cancel.cancelled || !isMounted()) return;
      setProgress(p);
    },
    {
      splatAlphaRemovalThreshold: 5,
      compressionLevel: 1,
      outSphericalHarmonicsDegree: 0,
    },
  );

  if (cancel.cancelled || !isMounted()) return;

  ksplatBufferRef.current = result.ksplatBuffer;

  const renderer = getRenderer();
  const scene = getScene();
  const camera = getCamera();
  const controls = getControls();
  if (!renderer || !scene || !camera) {
    throw new Error("Three.js scene not ready when feeding splat viewer.");
  }

  const formatLabel =
    plyInfo.format === "playcanvas_compressed"
      ? "PlayCanvas compressed"
      : plyInfo.format === "inria_v2"
      ? "INRIA V2 (codebook)"
      : "INRIA V1 (uncompressed)";

  setProgress({
    percent: 96,
    label: t("Đang tải splat mesh lên GPU...", "Uploading splat mesh to GPU..."),
    etaSeconds: 2,
  });

  const { Viewer, SceneFormat, RenderMode } = await import("@mkkellogg/gaussian-splats-3d");

  // Create the Viewer. selfDrivenMode:false because we own the animation
  // loop already (we have lights, gizmo, controls, etc. that need to
  // update every frame). We tell the viewer to render every frame via
  // renderMode:Always so the user always sees the latest splat sort.
  // sharedMemoryForWorkers:false avoids SharedArrayBuffer requirements
  // that Tauri WebView can't satisfy.
  const viewer = new Viewer({
    selfDrivenMode: false,
    threeScene: scene,
    renderer,
    camera,
    useBuiltInControls: false,
    sharedMemoryForWorkers: false,
    // gpuAcceleratedSort requires WebGL2 transform-feedback, which
    // WebView2 on older Edge installs lacks or has bugs with. CPU sort
    // is slower but stable. Same story for SIMD.
    gpuAcceleratedSort: false,
    enableSIMDInSort: false,
    integerBasedSort: true,
    halfPrecisionCovariancesOnGPU: false,
    // dynamicScene:false is fine here — the user isn't animating splats.
    dynamicScene: false,
    freeIntermediateSplatData: true,
    // Always render so the splat mesh is visible even before the user
    // moves the camera. The library's default is OnChange, which only
    // fires when camera position/quaternion cross a delta threshold.
    renderMode: RenderMode.Always,
    // Keep the library's internal loading UI off — we own the overlay.
    showLoadingUI: false,
  });
  const splatViewer = viewer as unknown as {
    update: () => void;
    render: () => void;
    shouldRender?: () => boolean;
    dispose: () => Promise<void>;
  };
  splatViewerRef.current = viewer as unknown as { dispose: () => void; start: () => void };

  // The Viewer's addSplatScene expects a URL string, so we wrap our
  // in-memory ksplat buffer in a Blob URL. The Viewer fetches it via
  // fetchWithProgress and then disposes of the response; we revoke the
  // blob URL after the load completes to release the ArrayBuffer ref.
  const blob = new Blob([result.ksplatBuffer], { type: "application/octet-stream" });
  const blobUrl = URL.createObjectURL(blob);
  blobUrlRef.current = blobUrl;

  try {
    // Note on orientation: postshot (and a few other INRIA V1 exporters)
    // emit PLYs whose +Y axis points down instead of up. The library
    // renders splats 1:1 so a Y-down scene shows up upside-down. We
    // compensate by flipping Y on the splat mesh's scale once it's
    // attached. The user can toggle this via the "Flip Y" toolbar
    // button if a different exporter needs the opposite correction.
    await viewer.addSplatScene(blobUrl, {
      format: SceneFormat.KSplat,
      showLoadingUI: false,
      progressiveLoad: false,
      splatAlphaRemovalThreshold: 5,
    });
    if (viewer.splatMesh && initialFlipY) {
      viewer.splatMesh.scale.y = -1;
    }
  } catch (addErr) {
    console.error("[3DViewer] addSplatScene threw:", addErr);
    throw addErr;
  } finally {
    // Release the blob URL as soon as the viewer is done with it.
    URL.revokeObjectURL(blobUrl);
    blobUrlRef.current = null;
  }

  // The Viewer doesn't auto-render in selfDrivenMode:false. We start our
  // own render loop that drives camera updates → splat sort → GPU upload.
  const renderSplats = () => {
    animateFrameRef.current = requestAnimationFrame(renderSplats);
    controls?.update();
    splatViewer.update();
    try {
      // shouldRender() returns false when nothing changed and the camera is
      // static — saves real GPU time on idle frames.
      if (!splatViewer.shouldRender || splatViewer.shouldRender()) {
        splatViewer.render();
      }
    } catch (e) {
      console.warn("[3DViewer] splat render failed:", e);
    }
    // Render the viewport gizmo so it stays visible during Gaussian Splat playback
    if (typeof gizmoRef !== 'undefined' && gizmoRef.current) {
      gizmoRef.current.render();
    }
  };
  animateFrameRef.current = requestAnimationFrame(renderSplats);

  // Auto-frame the camera around the scene center encoded in the ksplat
  // header. If the centre is at the origin (typical for splats trained
  // around 0,0,0) we sit the camera 3 units away on each axis. If the
  // scene has been re-centered, we offset the camera to match so the
  // splats are framed correctly without the user having to orbit.
  const cam = camera;
  const target = new THREE.Vector3(
    result.sceneCenter.x,
    result.sceneCenter.y,
    result.sceneCenter.z,
  );
  const distance = 3;
  cam.position.set(
    result.sceneCenter.x + distance,
    result.sceneCenter.y + distance * 0.6,
    result.sceneCenter.z + distance,
  );
  cam.lookAt(target);
  cam.updateProjectionMatrix();
  controls?.target.copy(target);
  controls?.update();

  setProgress({
    percent: 100,
    label: `Xong · ${result.splatCount.toLocaleString()} splats`,
    etaSeconds: 0,
  });
  setLoading(false);

  // Clear the progress overlay a moment later so the user sees the 100%
  // bar before it disappears.
  setTimeout(() => {
    if (!cancel.cancelled && isMounted()) setProgress(null);
  }, 800);
}

function glbJsonChunk(data: ArrayBuffer): string | null {
  if (!isGlbBinary(data) || data.byteLength < 20) return null;

  const view = new DataView(data);
  const chunkLength = view.getUint32(12, true);
  const chunkType = view.getUint32(16, true);
  const jsonChunkType = 0x4e4f534a;
  if (chunkType !== jsonChunkType) return null;

  const chunkStart = 20;
  const chunkEnd = chunkStart + chunkLength;
  if (chunkEnd > data.byteLength) return null;

  return decodeTextChunk(new Uint8Array(data.slice(chunkStart, chunkEnd)));
}

function gltfJsonText(data: ArrayBuffer): string | null {
  if (isGlbBinary(data)) {
    return glbJsonChunk(data);
  }

  try {
    return decodeTextChunk(new Uint8Array(data));
  } catch {
    return null;
  }
}

function detectCompressionMode(data: ArrayBuffer): { usesDraco: boolean; usesMeshopt: boolean } {
  const jsonText = gltfJsonText(data);
  if (!jsonText) {
    return { usesDraco: false, usesMeshopt: false };
  }

  const usesDraco = jsonText.includes("KHR_draco_mesh_compression");
  const usesMeshopt = jsonText.includes("EXT_meshopt_compression");
  return { usesDraco, usesMeshopt };
}

export default function ThreeDModelViewer({ fileName, filePath, accentColor, language = "en" }: ThreeDModelViewerProps) {
  const t = (vi: string, en: string) => (language === "vi" ? vi : en);
  const viewerShellRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelRef = useRef<THREE.Object3D | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const gridPlaneRef = useRef<THREE.Mesh | null>(null);
  const centerLinesRef = useRef<THREE.Line[]>([]);
  const gizmoRef = useRef<ViewportGizmo | null>(null);
  const animFrameRef = useRef<number>(0);
  const uvCheckerUniformRef = useRef<{ value: number } | null>(null);
  const matcapTexturesRef = useRef<Record<MatcapId, THREE.Texture | null>>({
    default: null,
    normal: null,
  });
  const [currentMatcapId, setCurrentMatcapId] = useState<MatcapId>("default");
  // Mirror currentMatcapId into a ref so callbacks memoised with an empty
  // dependency array (notably applyViewMode) can still see the latest value
  // when the user switches matcaps. Without this, every matcap change after
  // mount would re-use the "default" id from the closure.
  const currentMatcapIdRef = useRef<MatcapId>(currentMatcapId);
  currentMatcapIdRef.current = currentMatcapId;
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const skeletonHelperRef = useRef<THREE.SkeletonHelper | null>(null);
  const activeActionRef = useRef<THREE.AnimationAction | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState<string>("Initializing...");
  const [loadingPercent, setLoadingPercent] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("default");
  const [showGrid, setShowGrid] = useState(true);
  const [isFocusView, setIsFocusView] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showUVChecker, setShowUVChecker] = useState(false);
  const [uvCheckerScale, setUvCheckerScale] = useState(6); // default 6x, range 4..16
  const [uvCheckerNotice, setUvCheckerNotice] = useState<string | null>(null);
  // Brightness slider: controls renderer.toneMappingExposure to adjust scene-wide
  // luminance. Default 1.0; range 0.05–2.0. Applied to all formats and shaders
  // uniformly without touching material properties.
  const [brightness, setBrightness] = useState(1.0);
  const [meshInfo, setMeshInfo] = useState<{ vertices: number; faces: number; meshes: number; hasUV: boolean } | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  // Ref version so the animation loop reads the current value synchronously
  // (no stale-closure delay that useState has with setIsAnimating's async batching).
  const isAnimPlayingRef = useRef(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [animationInfo, setAnimationInfo] = useState<{ clipName: string; clipCount: number } | null>(null);

  // USD-specific state. USDScene is now a "dumb renderer" — all UI and
  // playhead state live here so the shell stays in lockstep with the rest
  // of the 3D viewer chrome (toolbar, timeline, focus/fullscreen toggle).
  const usdViewerRef = useRef<USDViewerHandle | null>(null);
  const [usdShowWorkplane, setUsdShowWorkplane] = useState(true);
  const [usdCurrentTime, setUsdCurrentTime] = useState(0);
  const [usdIsPlaying, setUsdIsPlaying] = useState(true);
  const [usdTimeRange, setUsdTimeRange] = useState<{
    start: number;
    end: number;
    fps: number;
  } | null>(null);

  // Detect USD files. USD/USDZ are routed to a dedicated component (USDScene)
  // that loads the OpenUSD Hydra WASM directly into this React tree instead of
  // mounting an <iframe> to the bundled OpenLegged viewer. That keeps the
  // Three.js renderer, OrbitControls, and ViewportGizmo in one place and avoids
  // the "app inside an app" feel of the previous iframe branch.
  // Must be declared BEFORE any hook (e.g. the USD subscribe effect below)
  // references it — otherwise the hook hits a TDZ on first render.
  const isUsdFile = filePath ? /^(usdz?|usda?|usdc?)$/i.test(getFileExt(filePath)) : false;

  // Detect EWA files (LumiGrade volumetric video format)
  const isEwaFile = filePath ? /^ewa$/i.test(getFileExt(filePath)) : false;

  // Subscribe to USDScene's imperative callbacks so the timeline scrubber
  // and play/pause button reflect the actual stage state. We re-run when
  // isUsdFile flips because USDScene only mounts in that case.
  useEffect(() => {
    if (!isUsdFile) return;
    const handle = usdViewerRef.current;
    if (!handle) return;
    // Hydrate initial state in case the renderer already reported.
    setUsdCurrentTime(handle.getCurrentTime());
    setUsdIsPlaying(handle.getIsPlaying());
    setUsdTimeRange(handle.getTimeRange());
    const offTime = handle.onTimeUpdate((t) => setUsdCurrentTime(t));
    const offPlay = handle.onPlayStateChange((p) => setUsdIsPlaying(p));
    // Poll the time range once a second for the first 10 seconds so the
    // timeline UI gains the start/end/fps as soon as the WASM resolves
    // `ready()`. After that we stop polling to avoid pointless React churn.
    let polls = 0;
    const poll = setInterval(() => {
      polls += 1;
      const r = handle.getTimeRange();
      if (r) setUsdTimeRange(r);
      if (r || polls >= 10) clearInterval(poll);
    }, 1000);
    return () => {
      offTime();
      offPlay();
      clearInterval(poll);
    };
  }, [isUsdFile, filePath]);

  // 3D Gaussian Splatting (3DGS) state.
  // PLY files can be either triangle meshes (handled below) or 3DGS point
  // clouds with property names like f_dc_0/rot_*. When detected we convert
  // the raw PLY to a compressed .ksplat buffer in-memory before handing it
  // off to the GaussianSplats3D Viewer.
  const [gsProgress, setGsProgress] = useState<ConvertProgress | null>(null);
  const [gsError, setGsError] = useState<string | null>(null);
  const [gsFlipY, setGsFlipY] = useState(true); // postshot exports Y-down
  const gsCancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  // Abort controller for cancelling fetch/decode when user navigates away
  const loadAbortRef = useRef<AbortController | null>(null);
  // Web Worker for CAD decoding (STEP/IGES) - runs off main thread
  const cadWorkerRef = useRef<{ worker: Worker; id: number } | null>(null);
  // The ksplat ArrayBuffer + the bound Viewer instance survive across renders
  // so the Viewer.dispose() on teardown can release their GPU resources.
  const gsKsplatBufferRef = useRef<ArrayBuffer | null>(null);
  const gsSplatViewerRef = useRef<{ dispose: () => void; start: () => void } | null>(null);
  // Cached blob URL used to feed the Viewer. Revoked on dispose.
  const gsBlobUrlRef = useRef<string | null>(null);
  // Alembic (.abc) handle returned by wabc_open_buffer; released on unmount
  // and on filePath change to prevent WASM heap leaks.
  const abcHandleRef = useRef<number | null>(null);
  // Seek-based animation state for Alembic: drives seekGeometry() every frame.
  // This matches i-saint's SceneABC::seekImpl pattern — no Three.js morph targets
  // (which fail silently in some WebView/Three.js combinations).
  const abcAnimRef = useRef<{
    seekGeometry: (time: number) => void;
    times: number[];
    elapsed: number;
    minTime: number;
    maxTime: number;
  } | null>(null);
  // Tracks the current animation time for the scrubber UI.
  const [abcCurrentTime, setAbcCurrentTime] = useState(0);
  const [abcTimeRange, setAbcTimeRange] = useState<[number, number] | null>(null);
  // FPS + frame count for the Alembic timeline. fps=0 means acyclic /
  // unknown sampling (UI shows "fps: No Data"). frameCount=0 means no animation.
  const [abcFps, setAbcFps] = useState(0);
  const [abcFrameCount, setAbcFrameCount] = useState(0);
  // FBX/GLTF animation state: unified time scrubber for all animation clips
  // (ABC uses its own seek-based system; FBX/GLTF uses Three.js AnimationMixer)
  const [fbxCurrentTime, setFbxCurrentTime] = useState(0);
  const [fbxTimeRange, setFbxTimeRange] = useState<[number, number] | null>(null);
  // FPS for FBX (read from GlobalSettings.FrameRate). 0 = unknown / not FBX.
  // GLTF has no native FPS metadata; we leave this 0 and the UI shows "No Data".
  const [fbxFps, setFbxFps] = useState(0);
  // Frame count for FBX/GLTF. Sourced from FBX (FrameRate × duration) or from
  // GLTF/three.js AnimationClip (we expose the largest track.times.length as a
  // sparse-keyframe estimate — UI marks it "key frames" so the user knows it's
  // not the same as Alembic's authoritative frame count).
  const [fbxFrameCount, setFbxFrameCount] = useState(0);
  // Whether fbxFrameCount is an authoritative frame count or a sparse
  // keyframe estimate. "frames" = authoritative (FBX with FrameRate);
  // "keyFrames" = sparse estimate (GLTF, or FBX without metadata).
  const fbxFrameCountKindRef = useRef<"frames" | "keyFrames">("frames");
  // Ref version so the animation loop reads the current value synchronously
  const fbxTimeRangeRef = useRef<[number, number] | null>(null);
  const [fbxAnimations, setFbxAnimations] = useState<THREE.AnimationClip[]>([]);
  // requestAnimationFrame id of our splat-only render loop. Tracked
  // separately from `animFrameRef` (the regular mesh loop) because the GS
  // branch never starts the mesh loop.
  const gsAnimateFrameRef = useRef<number>(0);

  void fileName;
  void accentColor;

  const applyViewMode = useCallback((mode: ViewMode) => {
    const model = modelRef.current;
    if (!model) {
      // Model not loaded yet — this can happen on the initial mount before
      // the user has selected a file, or immediately after a model reset.
      // The viewMode state effect will re-fire applyViewMode when a model
      // finishes loading (see the useEffect that runs on modelRef changes).
      return;
    }
    if (!sceneRef.current) { console.warn("[3DViewer] applyViewMode: scene not ready"); return; }

    const allOverlays: THREE.Object3D[] = [];
    model.traverse((node) => {
      if (node.parent) {
        const overlays = node.parent.children.filter(c => (c as any).isOverlay);
        allOverlays.push(...overlays);
      }
    });

    allOverlays.forEach(overlay => {
      if (overlay instanceof THREE.Mesh || overlay instanceof THREE.LineSegments || overlay instanceof THREE.Line) {
        const obj = overlay as (THREE.Mesh | THREE.LineSegments | THREE.Line);
        if (obj.geometry) obj.geometry.dispose();
        if ((obj as THREE.Mesh).material) {
          const mat = (obj as THREE.Mesh).material;
          if (Array.isArray(mat)) mat.forEach((m: THREE.Material) => m.dispose());
          else (mat as THREE.Material).dispose();
        }
      }
      if (overlay.parent) overlay.parent.remove(overlay);
    });

    let totalVertices = 0;
    let totalFaces = 0;
    let totalMeshes = 0;
    let hasUV = false;

    const collectMeshInfo = (root: THREE.Object3D) => {
      let v = 0, f = 0, m = 0, uv = false;
      root.traverse((c) => {
        if (!(c instanceof THREE.Mesh)) return;
        m++;
        const geo = c.geometry;
        if (!geo) return;
        const posAttr = geo.attributes.position;
        if (posAttr) v += posAttr.count;
        if (geo.index) f += geo.index.count / 3;
        else if (posAttr) f += posAttr.count / 3;
        if (geo.attributes.uv) uv = true;
      });
      return { vertices: v, faces: Math.round(f), meshes: m, hasUV: uv };
    };

    const collected = collectMeshInfo(model);

    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;

      const geo = child.geometry as any;
      const origMat = geo._origMaterial as THREE.Material | undefined;

      if (mode === "wireframe") {
        // MeshBasicMaterial.wireframe=true only draws triangle edges and ignores
        // normals/lighting, so we don't need computeVertexNormals() here.
        // Skipping that call also keeps the geometry's normal attribute intact,
        // so switching back to Default/Matcap/Xray preserves smooth shading.
        const wireMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true });
        if (child.material && !Array.isArray(child.material)) (child.material as THREE.Material).dispose();
        child.material = wireMat;
        child.visible = true;
      }

      if (mode === "default") {
        // Restore the load-time default: loader PBR material for textured meshes,
        // matcap fallback for untextured meshes. If the current material is
        // already that default, leave it alone (no needless dispose/reassign).
        if (origMat && child.material !== origMat) {
          if (child.material && !Array.isArray(child.material)) (child.material as THREE.Material).dispose();
          child.material = origMat;
        }
        child.visible = true;
      }

      if (mode === "matcap") {
        // STL files are loaded with flatShading: true MeshStandardMaterial and
        // must NEVER be overridden with a matcap — STL has no normal attribute
        // so the matcap would render as a flat/uniform colour (normal=0) or
        // produce visual artifacts. Leave STL meshes untouched in matcap mode.
        const geoAny = child.geometry as any;
        if (geoAny._fileExt === "stl") {
          child.visible = true;
          return;
        }
        const tex = getMatcapTexture(matcapTexturesRef.current, currentMatcapIdRef.current);
        const newMat = makeDefaultMatcapMaterial(tex);
        if (child.material && !Array.isArray(child.material)) (child.material as THREE.Material).dispose();
        child.material = newMat;
        child.visible = true;
      }

      if (mode === "xray") {
        // STL participates in xray mode. MeshBasicMaterial is unlit (no shading)
        // so flatShading is irrelevant — each triangle face is already rendered
        // with the same color regardless of orientation. Keep it consistent
        // with the regular xray material but use a mid-gray so the STL facets
        // remain clearly visible through the transparency.
        const geoAny = child.geometry as any;
        const xrayMat = new THREE.MeshBasicMaterial({
          color: geoAny._fileExt === "stl" ? 0x999999 : 0xffffff,
          transparent: true,
          opacity: 0.2,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        if (child.material && !Array.isArray(child.material)) (child.material as THREE.Material).dispose();
        child.material = xrayMat;
        child.visible = true;
      }
    });

    setMeshInfo(collected);

    if (rendererRef.current && sceneRef.current && cameraRef.current) {
      rendererRef.current.render(sceneRef.current, cameraRef.current);
    }
  }, []);

  // Apply whenever either the active mode or the chosen matcap changes.
// Listing currentMatcapId as a dep here is important: if the user is already
// in matcap mode and clicks another matcap variant, viewMode stays "matcap"
// and the [viewMode] effect would not re-run, leaving the previous texture
// on every mesh.
useEffect(() => {
    applyViewMode(viewMode);
  }, [viewMode, currentMatcapId, applyViewMode]);

  // When the user picks a different matcap while in matcap mode, swap every
  // mesh's material so the new texture is visible immediately.
  useEffect(() => {
    if (viewMode !== "matcap") return;
    if (!modelRef.current) return;
    applyViewMode("matcap");
  }, [currentMatcapId, viewMode, applyViewMode]);

  // Stores the brightness from the previous effect run to compute a delta
  // instead of compounding on already-modified colors.
  const prevBrightnessRef = useRef(1.0);

  // Brightness slider: adjusts material color scale to dim/brighten only lit
  // meshes without touching the scene (grid, gizmo, overlays). Applied uniformly
  // to MeshStandard, MeshPhysical, MeshPhong, MeshLambert, and MeshToon materials.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const ratio = brightness / prevBrightnessRef.current;

    if (brightness >= 0.9999) {
      // At max — restore original colors.
      scene.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const geo = child.geometry as any;
        if (!geo._origColors) return;
        const origs: (THREE.Color | null)[] = geo._origColors;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m, i) => {
          if (origs[i]) m.color.copy(origs[i]!);
        });
        delete geo._origColors;
      });
    } else {
      scene.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const geo = child.geometry as any;

        const mats = Array.isArray(child.material) ? child.material : [child.material];
        if (mats.every(m => m instanceof THREE.MeshBasicMaterial)) return;

        if (!geo._origColors) {
          geo._origColors = mats.map(m => m.color ? m.color.clone() : null);
        }

        mats.forEach(m => {
          const c = m.color;
          if (!c) return;
          if (m instanceof THREE.MeshBasicMaterial) return;
          c.multiplyScalar(ratio);
        });
      });
    }

    prevBrightnessRef.current = brightness;
  }, [brightness]);

  const patchMaterialWithUVChecker = useCallback((originalMaterial: THREE.Material, geometry: THREE.BufferGeometry) => {
    const canvasSize = 1024;
    const cellsU = 10;
    const cellsV = 10;
    const cellW = canvasSize / cellsU;
    const cellH = canvasSize / cellsV;

    const canvas = document.createElement("canvas");
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    for (let row = 0; row < cellsV; row++) {
      for (let col = 0; col < cellsU; col++) {
        const x = col * cellW;
        const y = row * cellH;
        const u0 = col / cellsU;
        const u1 = (col + 1) / cellsU;
        const v0 = row / cellsV;
        const v1 = (row + 1) / cellsV;

        const c00 = { r: u0, g: 0.0, b: v0 };
        const c11 = { r: u1, g: 0.4, b: v1 };

        const grad = ctx.createLinearGradient(x, y + cellH, x + cellW, y);
        grad.addColorStop(0, `rgb(${Math.round(c00.r * 255)},${Math.round(c00.g * 255)},${Math.round(c00.b * 255)})`);
        grad.addColorStop(1, `rgb(${Math.round(c11.r * 255)},${Math.round(c11.g * 255)},${Math.round(c11.b * 255)})`);

        ctx.fillStyle = grad;
        ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
      }
    }

    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2;
    for (let i = 0; i <= cellsU; i++) {
      const x = i * cellW;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvasSize);
      ctx.stroke();
    }
    for (let j = 0; j <= cellsV; j++) {
      const y = j * cellH;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvasSize, y);
      ctx.stroke();
    }

    ctx.font = `bold ${Math.round(cellW * 0.22)}px "Courier New", monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    for (let row = 0; row < cellsV; row++) {
      for (let col = 0; col < cellsU; col++) {
        const x = col * cellW + 3;
        const y = row * cellH + 3;
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillText(`${col}`, x, y);
        ctx.fillStyle = "rgba(80,80,80,0.7)";
        ctx.font = `${Math.round(cellW * 0.18)}px "Courier New", monospace`;
        ctx.fillText(`${row}`, x, y + Math.round(cellW * 0.22));
        ctx.font = `bold ${Math.round(cellW * 0.22)}px "Courier New", monospace`;
      }
    }

    const crossSize = cellW * 0.08;
    ctx.strokeStyle = "#ff00ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-crossSize, 0); ctx.lineTo(crossSize, 0);
    ctx.moveTo(0, -crossSize); ctx.lineTo(0, crossSize);
    ctx.stroke();

    const checkerTexture = new THREE.CanvasTexture(canvas);
    checkerTexture.wrapS = THREE.RepeatWrapping;
    checkerTexture.wrapT = THREE.RepeatWrapping;
    checkerTexture.repeat.set(uvCheckerScale, uvCheckerScale);
    checkerTexture.minFilter = THREE.LinearFilter;
    checkerTexture.magFilter = THREE.LinearFilter;
    checkerTexture.colorSpace = THREE.SRGBColorSpace;

    const checkerMat = new THREE.MeshBasicMaterial({
      map: checkerTexture,
      side: (originalMaterial as any).side !== undefined ? (originalMaterial as any).side : THREE.FrontSide,
      transparent: originalMaterial.transparent === true,
      opacity: originalMaterial.transparent === true ? originalMaterial.opacity : 1.0,
    });

    uvCheckerUniformRef.current = checkerMat as any;

    if (Array.isArray(originalMaterial)) return;
    if ((geometry as any)._savedMaterial === undefined) {
      (geometry as any)._savedMaterial = originalMaterial;
    }
    (geometry as any)._checkerMaterial = checkerMat;
  }, [uvCheckerScale]);

  const detectHasUV = useCallback((root: THREE.Object3D | null): boolean => {
    if (!root) return false;
    let found = false;
    root.traverse((c) => {
      if (found) return;
      if (!(c instanceof THREE.Mesh)) return;
      if (c.geometry && c.geometry.attributes && c.geometry.attributes.uv) {
        found = true;
      }
    });
    return found;
  }, []);

  const setupAnimations = useCallback((loadedObject: THREE.Object3D, animations: THREE.AnimationClip[]) => {
    if (!sceneRef.current) return;
    const mixer = new THREE.AnimationMixer(loadedObject);
    mixerRef.current = mixer;

    // Collect ALL animation clips, not just the first one.
    // FBX files can have multiple clips (e.g., one per object). We now
    // create actions for every clip and play them all so all animated
    // objects are visible.
    const validClips: THREE.AnimationClip[] = [];
    for (const clip of animations) {
      if (!clip) continue;
      if (!clip.tracks || clip.tracks.length === 0) continue;
      // Check if at least one track has a resolvable target in the scene
      // FBX animations reference bones/objects by name. Try to resolve each track.
      let hasResolvedTracks = false;
      const unresolved: string[] = [];
      const resolvedTracks: string[] = [];
      for (const track of clip.tracks) {
        const boneName = track.name.replace(/\.position$|\.quaternion$|\.scale$/, "");
        // Try to find the target in the loaded object hierarchy
        const resolved = loadedObject.getObjectByName(boneName)
          || (loadedObject as THREE.Object3D & { bones?: THREE.Bone[] }).bones?.find((b) => b.name === boneName);
        if (resolved) {
          hasResolvedTracks = true;
          resolvedTracks.push(track.name);
        } else {
          unresolved.push(track.name);
        }
      }
      if (hasResolvedTracks) {
        validClips.push(clip);
      } else {
        // Skipped - no resolved targets
      }
    }

    if (validClips.length === 0) {
      setAnimationInfo(null);
      setIsAnimating(false);
      return;
    }

    // Create and play ALL actions. IMPORTANT: call clipAction() ONCE per clip —
    // calling it twice for the same clip creates a duplicate action that interferes
    // with playback.
    for (const clip of validClips) {
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
    }
    // Keep the first action as the "primary" for simple play/pause controls
    // (points to the same object already playing, not a new instance).
    activeActionRef.current = mixer.existingAction(validClips[0]) ?? null;

    // Seed the FBX scrubber state
    let minT = Infinity, maxT = -Infinity;
    for (const clip of validClips) {
      if (clip.duration > 0) {
        minT = Math.min(minT, clip.duration > 0 ? 0 : Infinity);
        maxT = Math.max(maxT, clip.duration);
      }
    }
    if (isFinite(minT) && isFinite(maxT) && maxT > minT) {
      setFbxTimeRange([0, maxT]);
      fbxTimeRangeRef.current = [0, maxT];
      setFbxCurrentTime(0);
      // Derive total frame count. For FBX (fps>0) use the authoritative
      // FrameRate × duration. For GLTF / FBX-without-metadata, fall back to
      // the largest keyframe count we can see in any track — but mark it as
      // "key frames" in the UI so the user knows it's a sparse estimate, not
      // the same kind of authoritative count as Alembic.
      let computedFrames = 0;
      let isKeyframeEstimate = false;
      if (fbxFps > 0) {
        computedFrames = Math.round(maxT * fbxFps) + 1;
      } else {
        for (const clip of validClips) {
          for (const track of clip.tracks) {
            if (track.times && track.times.length > computedFrames) {
              computedFrames = track.times.length;
              isKeyframeEstimate = true;
            }
          }
        }
      }
      setFbxFrameCount(computedFrames);
      // Stash "isKeyframeEstimate" in a module-level variable via a ref
      // workaround: encode it into fbxFps sign? Simpler: keep a separate ref.
      fbxFrameCountKindRef.current = isKeyframeEstimate ? "keyFrames" : "frames";
    }

    let skeletonHelper: THREE.SkeletonHelper | null = null;
    loadedObject.traverse((child) => {
      if (child instanceof THREE.SkinnedMesh && !skeletonHelper) {
        skeletonHelper = new THREE.SkeletonHelper(child.skeleton.bones[0]);
        skeletonHelper.setColors(new THREE.Color(0xe000ff), new THREE.Color(0x00e0ff));
        skeletonHelper.visible = false;
        sceneRef.current!.add(skeletonHelper);
        skeletonHelperRef.current = skeletonHelper;
      }
    });

    setFbxAnimations(validClips);
    setAnimationInfo({
      clipName: validClips.length === 1
        ? (validClips[0].name || "Clip 1")
        : `${validClips.length} clips`,
      clipCount: validClips.length,
    });
    setIsAnimating(true);
    isAnimPlayingRef.current = true; // Start auto-played on load
    setLoading(false); // Mark loading complete after model + animations are ready
  }, []);

  const cleanupAnimations = useCallback(() => {
    if (mixerRef.current) {
      mixerRef.current.stopAllAction();
      mixerRef.current = null;
    }
    if (skeletonHelperRef.current && sceneRef.current) {
      sceneRef.current.remove(skeletonHelperRef.current);
      skeletonHelperRef.current = null;
    }
    activeActionRef.current = null;
    setAnimationInfo(null);
    isAnimPlayingRef.current = false;
    setIsAnimating(false);
    setShowSkeleton(false);
    // Reset FBX animation scrubber state
    setFbxTimeRange(null);
    setFbxCurrentTime(0);
    setFbxAnimations([]);
    setFbxFps(0);
    setFbxFrameCount(0);
    fbxFrameCountKindRef.current = "frames";
  }, []);

  const playAnimation = useCallback(() => {
    if (mixerRef.current) {
      const actions = mixerRef.current._actions;
      if (actions && actions.length > 0) {
        const action = actions[0] as any;
        mixerRef.current.time = action.time;
        action.paused = false;
        action.enabled = true;
        activeActionRef.current = action;
      }
    }
    isAnimPlayingRef.current = true;
    setIsAnimating(true);
  }, []);

  const pauseAnimation = useCallback(() => {
    if (mixerRef.current) {
      for (const action of mixerRef.current._actions as unknown as THREE.AnimationAction[]) {
        action.paused = true;
      }
    }
    isAnimPlayingRef.current = false;
    setIsAnimating(false);
  }, []);

  const resetAnimation = useCallback(() => {
    // Reset FBX/GLTF animation: reset mixer time to 0
    if (mixerRef.current) {
      mixerRef.current.setTime(0);
      for (const action of mixerRef.current._actions as unknown as THREE.AnimationAction[]) {
        action.reset();
        action.paused = false;
      }
    }
    // Reset ABC animation: reset elapsed, seek to start
    if (abcAnimRef.current) {
      abcAnimRef.current.elapsed = 0;
      const t0 = abcAnimRef.current.minTime;
      abcAnimRef.current.seekGeometry(t0);
      setAbcCurrentTime(t0);
    }
    setFbxCurrentTime(0);
    isAnimPlayingRef.current = true;
    setIsAnimating(true);
  }, []);

  const toggleSkeleton = useCallback(() => {
    setShowSkeleton((prev) => {
      const next = !prev;
      if (skeletonHelperRef.current) {
        skeletonHelperRef.current.visible = next;
      }
      return next;
    });
  }, []);

  const toggleUVChecker = useCallback(() => {
    const model = modelRef.current;
    if (!model) return;

    if (showUVChecker) {
      // UV Checker OFF: restore the material the viewMode had set before we
      // overlaid the checker, then re-apply the current mode.
      sceneRef.current?.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        if (child === gridPlaneRef.current) return;
        if ((child as any).isGridHelper === true) return;
        if (child.parent && (child.parent as any).isGridHelper === true) return;
        const geo = child.geometry as any;
        if (geo._checkerMaterial) {
          const cm = geo._checkerMaterial as THREE.MeshBasicMaterial;
          if (cm.map) cm.map.dispose();
          cm.dispose();
        }
        // Restore whatever the viewMode set before the checker overlay.
        if (geo._savedMaterial !== undefined) {
          child.material = geo._savedMaterial;
          delete geo._savedMaterial;
        }
        delete geo._checkerMaterial;
      });
      uvCheckerUniformRef.current = null;
      setShowUVChecker(false);
      setUvCheckerNotice(null);
      // Re-apply current viewMode so the model looks correct after removing checker.
      applyViewMode(viewMode);
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
      return;
    }

    const hasUV = detectHasUV(model);
    if (!hasUV) {
      setUvCheckerNotice(t("Model không có UV coordinates để hiển thị checker.", "Model has no UV coordinates to display the checker."));
      window.setTimeout(() => setUvCheckerNotice(null), 3500);
      return;
    }
    setUvCheckerNotice(null);

    // Patch every mesh in the SCENE (not just the model root) so that all
    // models/objects in the scene get the checker overlay.
    const collectMeshes = (root: THREE.Object3D): THREE.Mesh[] => {
      const out: THREE.Mesh[] = [];
      root.traverse((c) => { if (c instanceof THREE.Mesh) out.push(c); });
      return out;
    };
    const allMeshes: THREE.Mesh[] = [];
    sceneRef.current?.traverse((c) => {
      if (!(c instanceof THREE.Mesh)) return;
      // Skip viewer-owned helper geometry: workplane, ground grid, anything
      // that is part of the viewport's own UI rather than a loaded model.
      if (c === gridPlaneRef.current) return;
      if ((c as any).isGridHelper === true) return;
      if (c.parent && (c.parent as any).isGridHelper === true) return;
      // Tag meshes that are descendants of a loaded model root. If none are
      // tagged, fall back to all non-helper meshes.
      allMeshes.push(c);
    });
    // Also include anything not under scene (e.g. viewer's own modelRef)
    collectMeshes(model).forEach((m) => { if (!allMeshes.includes(m)) allMeshes.push(m); });

    let patched = 0;
    let skippedNoUV = 0;
    allMeshes.forEach((child) => {
      if (!child.geometry) { skippedNoUV++; return; }
      const geo = child.geometry as any;
      if (!geo.attributes.uv) { skippedNoUV++; return; }
      patchMaterialWithUVChecker(child.material as THREE.Material, child.geometry);
      if (geo._checkerMaterial) {
        child.material = geo._checkerMaterial;
        patched++;
      }
    });

    setShowUVChecker(true);
    if (rendererRef.current && sceneRef.current && cameraRef.current) {
      rendererRef.current.render(sceneRef.current, cameraRef.current);
    }
  }, [showUVChecker, detectHasUV, patchMaterialWithUVChecker]);

  // Update UV checker tile scale on the fly. When the slider moves we
  // simply rewrite texture.repeat on the already-patched checker materials
  // (no need to re-patch everything, which would flash).
  useEffect(() => {
    if (!showUVChecker) return;
    let count = 0;
    sceneRef.current?.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const geo = child.geometry as any;
      if (!geo || !geo._checkerMaterial) return;
      const cm = geo._checkerMaterial as THREE.MeshBasicMaterial;
      const tex = cm.map;
      if (!tex) return;
      tex.repeat.set(uvCheckerScale, uvCheckerScale);
      tex.needsUpdate = true;
      count++;
    });
    if (count > 0 && rendererRef.current && sceneRef.current && cameraRef.current) {
      rendererRef.current.render(sceneRef.current, cameraRef.current);
    }
  }, [uvCheckerScale, showUVChecker]);

  useEffect(() => {
    if (gridRef.current) {
      gridRef.current.visible = showGrid;
    }
    if (gridPlaneRef.current) {
      gridPlaneRef.current.visible = showGrid;
    }
    // Also toggle the XZ axis lines (red/green center lines)
    centerLinesRef.current.forEach(line => {
      line.visible = showGrid;
    });
  }, [showGrid]);

  const fitToView = useCallback(() => {
    if (!cameraRef.current || !controlsRef.current || !modelRef.current) return;
    try {
      const box = new THREE.Box3().setFromObject(modelRef.current);
      if (!isFinite(box.min.x) || !isFinite(box.max.x)) throw new Error("invalid bbox");
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const dist = maxDim * 2;
      cameraRef.current.position.set(dist, dist * 0.6, dist);
      controlsRef.current.target.copy(center);
      controlsRef.current.update();
    } catch (e) {
      // Fallback: try direct geometry scan
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let valid = false;
      modelRef.current.traverse((c: any) => {
        if (!c.geometry?.attributes?.position) return;
        const arr = c.geometry.attributes.position.array as Float32Array;
        for (let i = 0; i < c.geometry.attributes.position.count; i++) {
          const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
          if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
          valid = true;
        }
      });
      if (valid) {
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
        const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
        const dist = maxDim * 2;
        cameraRef.current.position.set(cx + dist, cy + dist * 0.6, cz + dist);
        controlsRef.current.target.set(cx, cy, cz);
        controlsRef.current.update();
      }
    }
  }, []);

  const resizeViewport = useCallback(() => {
    if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;
    const width = containerRef.current.clientWidth || 1;
    const height = containerRef.current.clientHeight || 1;
    rendererRef.current.setSize(width, height);
    cameraRef.current.aspect = width / height;
    cameraRef.current.updateProjectionMatrix();
    rendererRef.current.render(sceneRef.current!, cameraRef.current);
  }, []);

  // CSS layout (fixed inset-0 / rounded relative) takes ~1-2 ticks to settle
  // after React commits the className change. setTimeout(0) defers past that
  // so we always resize+fit against a stable, correctly-sized shell.
  useEffect(() => {
    if (isFocusView) {
      const tid = setTimeout(() => {
        resizeViewport();
        const shell = viewerShellRef.current;
        if (shell && isUsdFile) {
          usdViewerRef.current?.resize(shell.clientWidth, shell.clientHeight);
        }
      }, 0);
      return () => clearTimeout(tid);
    }
  }, [isFocusView, resizeViewport, isUsdFile]);

  useEffect(() => {
    if (isFullscreen) {
      const tid = setTimeout(() => {
        resizeViewport();
        const shell = viewerShellRef.current;
        if (shell && isUsdFile) {
          usdViewerRef.current?.resize(shell.clientWidth, shell.clientHeight);
        }
      }, 0);
      return () => clearTimeout(tid);
    }
  }, [isFullscreen, resizeViewport, isUsdFile]);

  const handleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      viewerShellRef.current?.requestFullscreen().catch(() => {});
    } else {
      void document.exitFullscreen();
    }
  }, []);

  // ResizeObserver drives USDScene's WebGL canvas. Non-USD uses
  // window.resize via resizeViewport() above; the USD branch has its own
  // dedicated renderer so we mirror the same DOM-observing pattern here
  // instead of trying to wedge it into the existing resizeViewport.
  useEffect(() => {
    if (!isUsdFile) return;
    const shell = viewerShellRef.current;
    if (!shell) return;
    const ro = new ResizeObserver(() => {
      const r = usdViewerRef.current;
      const w = shell.clientWidth;
      const h = shell.clientHeight;
      if (r) r.resize(w, h);
    });
    ro.observe(shell);
    // Kick once after mount so the canvas is sized before the first paint.
    queueMicrotask(() => {
      const r = usdViewerRef.current;
      if (r) r.resize(shell.clientWidth, shell.clientHeight);
    });
    return () => ro.disconnect();
  }, [isUsdFile]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const isViewerFullscreen = document.fullscreenElement === viewerShellRef.current;
      setIsFullscreen(isViewerFullscreen);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // Escape exits focus view. Fullscreen is left to the browser — Escape on
  // a fullscreened element naturally triggers `fullscreenchange`. Without
  // this, the user could focus-view a USD file and have no keyboard way
  // out — the toolbar Focus View button is the only escape hatch otherwise.
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
    // Reset any leftover 3DGS state whenever the user picks a different
    // file. The actual cleanup of the Viewer/dispose happens in the
    // initThree effect's cleanup callback below.
    setGsProgress(null);
    setGsError(null);
    gsCancelRef.current.cancelled = false;
    // Cancel any in-flight fetch/decode from previous file
    if (loadAbortRef.current) {
      loadAbortRef.current.abort();
      loadAbortRef.current = null;
    }
  }, [filePath]);

  useEffect(() => {
    if (!containerRef.current || !filePath) return;

    // Guard: prevent re-initialization if we already have a valid renderer
    // This prevents "Too many WebGL contexts" during React Fast Refresh / HMR
    if (rendererRef.current && containerRef.current.contains(rendererRef.current.domElement.parentNode)) {
      console.info("[3DViewer] Renderer already exists, skipping re-init");
      return;
    }

    let mounted = true;

    async function initThree() {
      try {
        // Create abort controller for this load operation
        const abortCtrl = new AbortController();
        loadAbortRef.current = abortCtrl;

        setLoading(true);
        setLoadingProgress("Initializing renderer...");
        setError(null);

        const THREE = await import("three");
        const { OrbitControls: OC } = await import("three/examples/jsm/controls/OrbitControls.js");

        let OBJLoader: any, FBXLoader: any, GLTFLoader: any, STLLoader: any, PLYLoader: any, TDSLoader: any, DRACOLoader: any, MeshoptDecoder: any, ThreeMFLoader: any;

        const ext = getFileExt(filePath);

        setLoadingProgress(`Loading ${ext.toUpperCase()} file...`);

        // Both ext === "ply" and ext === "3dgs_ply" map to the same enum value,
        // so normalize once for the rest of the pipeline.
        // We keep "ply" as the file extension and sniff the PLY header to
        // determine whether it's a triangle mesh (default three.js PLYLoader)
        // or a 3D Gaussian Splatting cloud (which we hand off to the
        // @mkkellogg/gaussian-splats-3d viewer).
        const isPossiblyGsPly = ext === "ply";

        if (ext === "obj") {
          // Standard OBJLoader is used in the legacy code path; the large-file path
          // uses OBJLoader2 via modelBuffer fetch below. We import both here.
          const mod = await import("three/examples/jsm/loaders/OBJLoader.js");
          OBJLoader = mod.OBJLoader;
        } else if (ext === "fbx") {
          const mod = await import("three/examples/jsm/loaders/FBXLoader.js");
          FBXLoader = mod.FBXLoader;
        } else if (ext === "stl") {
          const mod = await import("three/examples/jsm/loaders/STLLoader.js");
          STLLoader = mod.STLLoader;
        } else if (ext === "ply") {
          const mod = await import("three/examples/jsm/loaders/PLYLoader.js");
          PLYLoader = mod.PLYLoader;
        } else if (ext === "3ds") {
          try {
            const mod = await import("three/examples/jsm/loaders/TDSLoader.js");
            TDSLoader = mod.TDSLoader;
          } catch {}
        } else if (ext === "3mf") {
          const mod = await import("three/examples/jsm/loaders/3MFLoader.js");
          ThreeMFLoader = mod.ThreeMFLoader;
        } else if (ext === "abc") {
          // wabc loader — no three.js Loader needed; WabcLoader builds the
          // THREE.Group directly via the wabc C ABI. Handled in a dedicated
          // branch below the main loader dispatch.
        } else if (ext === "spz") {
          // SPZ is a pre-compressed splat format for 3D Gaussian Splatting.
          // Load directly into the GaussianSplats3D viewer — no three.js
          // mesh loader needed.
        } else {
          const [gltfMod, dracoMod, meshoptMod] = await Promise.all([
            import("three/examples/jsm/loaders/GLTFLoader.js"),
            import("three/examples/jsm/loaders/DRACOLoader.js"),
            import("meshoptimizer")
          ]);
          GLTFLoader = gltfMod.GLTFLoader;
          DRACOLoader = dracoMod.DRACOLoader;
          MeshoptDecoder = meshoptMod.MeshoptDecoder;
        }

        if (!mounted || !containerRef.current) return;

        const container = containerRef.current;
        const width = container.clientWidth || 400;
        const height = container.clientHeight || 320;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.shadowMap.enabled = true;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.2;
        container.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x3f3f3f);
        scene.fog = new THREE.Fog(0x3f3f3f, 8, 35);
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(45, width / height, 0.001, 100000);
        camera.position.set(3, 2, 3);
        cameraRef.current = camera;

        const controls = new OC(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        // No zoom limits: very large models (architectural scenes) need
        // to be zoomed out well beyond 100 units, and small details need
        // to be zoomed in well below 0.5 units. Leaving both bounds at
        // their sentinel values (Infinity / 0) lets the user freely
        // inspect any model regardless of its native scale.
        controls.minDistance = 0;
        controls.maxDistance = Infinity;
        controlsRef.current = controls;

        // Gizmo can throw on some browsers/configs (Tauri WebView quirks,
        // missing container dimensions). Wrap creation in try/catch so a
        // gizmo failure never kills the whole viewer init — better to have
        // a working model + grid with no gizmo than a blank scene.
        try {
          const gizmo = new ViewportGizmo(camera, renderer, {
            container,
            placement: "top-right",
            size: 128,
            offset: { top: 10, right: 10 },
          });
          gizmoRef.current = gizmo;
          try {
            gizmo.attachControls(controls);
          } catch (e) {
            console.warn("[ModelViewer] gizmo.attachControls failed:", e);
          }
        } catch (e) {
          console.error("[ModelViewer] ViewportGizmo creation failed; continuing without it.", e);
          gizmoRef.current = null;
        }

        const ambient = new THREE.AmbientLight(0xffffff, 0.4);
        scene.add(ambient);

        const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
        keyLight.position.set(5, 10, 7);
        scene.add(keyLight);

        const fillLight = new THREE.DirectionalLight(0xe6f0ff, 0.6);
        fillLight.position.set(-6, 4, -4);
        scene.add(fillLight);

        const rimLight = new THREE.DirectionalLight(0xffffff, 0.5);
        rimLight.position.set(0, -2, -8);
        scene.add(rimLight);

        const pmremGenerator = new THREE.PMREMGenerator(renderer);
        pmremGenerator.compileEquirectangularShader();
        const environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
        scene.environment = environment;
        pmremGenerator.dispose();

        const gridSize = 200;
        const gridDivisions = 80;

        const gridShaderMaterial = new THREE.ShaderMaterial({
          uniforms: {
            uColor1: { value: new THREE.Color(0x3a3a3a) },
            uColor2: { value: new THREE.Color(0x353535) },
            uFadeStart: { value: 30.0 },
            uFadeEnd: { value: 50.0 },
            uCameraPos: { value: camera.position },
          },
          vertexShader: `
            varying vec3 vWorldPosition;
            void main() {
              vec4 worldPos = modelMatrix * vec4(position, 1.0);
              vWorldPosition = worldPos.xyz;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: `
            uniform vec3 uColor1;
            uniform vec3 uColor2;
            uniform float uFadeStart;
            uniform float uFadeEnd;
            uniform vec3 uCameraPos;
            varying vec3 vWorldPosition;

            void main() {
              vec2 coord = vWorldPosition.xz;
              float majorLine = 0.0;
              float minorLine = 0.0;

              float major = 0.7;
              float minor = 0.25;

              vec2 cell = abs(fract(coord * 4.0 - 0.5) - 0.5) / fwidth(coord * 4.0);
              float line = min(cell.x, cell.y);
              minorLine = 1.0 - min(line, 1.0);

              vec2 majorCell = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
              float majorGrid = min(majorCell.x, majorCell.y);
              majorLine = 1.0 - min(majorGrid, 1.0);

              vec3 color = uColor2 * minorLine * minor + uColor1 * majorLine * major;
              float alpha = (minorLine * minor + majorLine * major) * 0.5;

              float dist = length(vWorldPosition - uCameraPos);
              float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, dist);
              alpha *= fade;

              gl_FragColor = vec4(color, alpha);
            }
          `,
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
        });

        const gridPlane = new THREE.Mesh(
          new THREE.PlaneGeometry(gridSize, gridSize),
          gridShaderMaterial
        );
        gridPlane.rotation.x = -Math.PI / 2;
        gridPlane.position.y = -0.01;
        scene.add(gridPlane);
        gridPlaneRef.current = gridPlane;

        const gridLines = new THREE.GridHelper(gridSize, gridDivisions, 0x505050, 0x404040);
        gridLines.position.y = -0.01;
        gridLines.material.transparent = true;
        gridLines.material.opacity = 0.3;
        scene.add(gridLines);
        gridRef.current = gridLines as any;

        const lineLength = 100;
        const lineThickness = 1.5;
        const lineMaterialRed = new THREE.LineBasicMaterial({ color: 0xff5365, linewidth: lineThickness, transparent: true, opacity: 0.9 });
        const lineMaterialGreen = new THREE.LineBasicMaterial({ color: 0x0088ff, linewidth: lineThickness, transparent: true, opacity: 0.9 });

        const xLinePoints = [
          new THREE.Vector3(-lineLength / 2, 0.001, 0.0),
          new THREE.Vector3(lineLength / 2, 0.001, 0.0),
        ];
        const xLineGeometry = new THREE.BufferGeometry().setFromPoints(xLinePoints);
        const xLine = new THREE.Line(xLineGeometry, lineMaterialRed);
        xLine.renderOrder = -1;
        scene.add(xLine);

        const zLinePoints = [
          new THREE.Vector3(0.0, 0.001, -lineLength / 2),
          new THREE.Vector3(0.0, 0.001, lineLength / 2),
        ];
        const zLineGeometry = new THREE.BufferGeometry().setFromPoints(zLinePoints);
        const zLine = new THREE.Line(zLineGeometry, lineMaterialGreen);
        zLine.renderOrder = -1;
        scene.add(zLine);

        centerLinesRef.current = [xLine, zLine];

        // These two callbacks are referenced by the loader dispatch below AND by the
        // STL rust-path block above (line ~1765), so they MUST be declared before any
        // call site. Hoisting with `const` does NOT protect against TDZ — the call at
        // line 1765 fires before declaration at line 1942 unless we reorder them here.
        const handleLoadedObject = (result: any) => {
          if (!mounted || !sceneRef.current) return;

          const object = result.scene || result;
          const animations: THREE.AnimationClip[] = result.animations || object.animations || [];

          cleanupAnimations();

          // DIAGNOSTIC: dump the entire object tree to understand structure
          let totalChildren = 0;
          let totalMeshes = 0;
          let totalGeoWithPos = 0;
          object.traverse((c: any) => {
            totalChildren++;
            if (c.isMesh || c.isSkinnedMesh) totalMeshes++;
            if (c.geometry && c.geometry.attributes && c.geometry.attributes.position) totalGeoWithPos++;
          });

          // Box3.setFromObject can throw "t.updateWorldMatrix is not a function"
          // when the loader returns a non-Object3D (e.g. raw BufferGeometry from
          // a point cloud PLY). Compute the bbox from the geometry directly
          // and fall back to a unit cube when that fails.
          let box: THREE.Box3;
          let bboxValid = false;
          let hadNaN = false;

          try {
            box = new THREE.Box3().setFromObject(object);
            // DIAGNOSTIC: count children + per-child bbox to find what setFromObject
            // is including
            let childIdx = 0;
            let hasAnyValidGeo = false;
            object.traverse((c: any) => {
              if (!c.geometry) return;
              if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
              const gb = c.geometry.boundingBox;
              if (!gb) return;
              const szX = gb.max.x - gb.min.x;
              const szY = gb.max.y - gb.min.y;
              const szZ = gb.max.z - gb.min.z;
              const isValid = isFinite(gb.min.x) && isFinite(gb.max.x) &&
                              szX < 1e15 && szY < 1e15 && szZ < 1e15;
              if (isValid) hasAnyValidGeo = true;
            });
            if (!isFinite(box.min.x) || !isFinite(box.max.x) || !hasAnyValidGeo) {
              throw new Error("non-finite bbox or no valid geometry");
            }
            bboxValid = true;
          } catch (e) {
            box = new THREE.Box3();
            let validVertCount = 0;
            let totalVertCount = 0;
            object.traverse((c: any) => {
              if (!c.geometry || !c.geometry.attributes.position) return;
              const posAttr = c.geometry.attributes.position;
              totalVertCount += posAttr.count;
              let minX = Infinity, minY = Infinity, minZ = Infinity;
              let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
              let localHadNaN = false;
              let localValidCount = 0;
              const arr = posAttr.array as Float32Array;
              for (let i = 0; i < posAttr.count; i++) {
                const x = arr[i * 3];
                const y = arr[i * 3 + 1];
                const z = arr[i * 3 + 2];
                if (isFinite(x) && isFinite(y) && isFinite(z)) {
                  if (x < minX) minX = x;
                  if (x > maxX) maxX = x;
                  if (y < minY) minY = y;
                  if (y > maxY) maxY = y;
                  if (z < minZ) minZ = z;
                  if (z > maxZ) maxZ = z;
                  localValidCount++;
                } else {
                  localHadNaN = true;
                }
              }
              if (localHadNaN) hadNaN = true;
              if (localValidCount > 0) {
                validVertCount += localValidCount;
                // Also apply the fix: clamp NaN/Infinity to 0 to prevent GPU issues
                if (localHadNaN) {
                  for (let i = 0; i < arr.length; i++) {
                    if (!isFinite(arr[i])) arr[i] = 0;
                  }
                  posAttr.needsUpdate = true;
                }
                box.expandByPoint(new THREE.Vector3(minX, minY, minZ));
                box.expandByPoint(new THREE.Vector3(maxX, maxY, maxZ));
              }
            });
            if (!isFinite(box.min.x) || !isFinite(box.max.x) || validVertCount === 0) {
              // Completely empty geometry — this typically happens for large OBJ files
              // (>~256MB) that exceed browser string limits. The OBJLoader uses a
              // synchronous string parser that cannot handle files this large in a
              // browser environment. Recommend converting to GLB.
              const isObj = filePath?.toLowerCase().endsWith('.obj');
              const errMsg = isObj
                ? `OBJ file appears to be empty after parsing. This can happen with files >~256MB due to browser string limits. Consider converting to GLB/FBX format.`
                : `No valid geometry found, using unit cube`;
              console.error(`[3DViewer] ${errMsg}`);
              box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
              bboxValid = false;
            } else {
              bboxValid = true;
            }
          }
          const size = box.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z);
          // Normalize model to fit within a ~2.5-unit bounding box regardless of
          // original size. This keeps both tiny STL parts and huge architectural
          // FBX/OBJ files comfortably in frame.
          const scale = maxDim > 0 ? 2.5 / maxDim : 1;

          object.traverse((child: any) => {
            if (child.isMesh && child.geometry && child.geometry.attributes.position) {
              child.castShadow = true;
              child.receiveShadow = true;

              // Only apply flat shading + matcap for Alembic (.abc) files
              // Alembic has no normal data, so we need to compute it
              // Other formats (FBX, OBJ, GLTF, etc.) keep their original shading
              if (ext === "abc") {
                child.geometry.computeVertexNormals();
                if (!meshHasAnyTextureMap(child)) {
                  const mats = Array.isArray(child.material) ? child.material : [child.material];
                  mats.forEach((m: THREE.Material) => m.dispose());
                  child.material = makeDefaultMatcapMaterial(
                    getMatcapTexture(matcapTexturesRef.current, currentMatcapIdRef.current),
                    currentMatcapIdRef.current,
                    true // flatShading for Alembic
                  );
                }
              }

              // GLB/GLTF without textures: the loader produces plain MeshStandardMaterial
              // (color: 0xffffff) which on a 0x3f3f3f scene background produces a low-contrast
              // "white blob" that looks like nothing rendered. Detect the untextured case
              // and swap the default material for a matcap (same fallback the .abc branch uses),
              // so the model is clearly visible regardless of scene lighting.
              //
              // CRITICAL: MeshMatcapMaterial samples the matcap using vertex normals — if the
              // GLB was exported without normals (or with DRACO compression that dropped the
              // NORMAL attribute), the matcap renders as a black/invisible surface and the
              // user sees an empty viewer. In that case we fall back to a flat-shaded
              // MeshBasicMaterial + auto-computed normals so the model is always visible.
              // A user toggle to wireframe is already provided in the toolbar, so we don't
              // force-wireframe here — we just guarantee SOMETHING renders.
              // Only apply default matcap to GLB/GLTF files that have no texture maps.
              // SKP files go through the Python converter which already embeds
              // PBR materials in the GLB output — keep those intact.
              if ((ext === "glb" || ext === "gltf") && !meshHasAnyTextureMap(child)) {
                const normalAttr = child.geometry.attributes.normal as
                  | THREE.BufferAttribute
                  | undefined;
                const uvAttr = child.geometry.attributes.uv as
                  | THREE.BufferAttribute
                  | undefined;
                const colorAttr = child.geometry.attributes.color as
                  | THREE.BufferAttribute
                  | undefined;
                const hasNormals = !!normalAttr && normalAttr.count > 0;
                const hasUVs = !!uvAttr && uvAttr.count > 0;
                const hasVertexColors = !!colorAttr && colorAttr.count > 0;
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach((m: THREE.Material) => m.dispose());

                if (hasNormals) {
                  // Smooth shading works because vertices already carry normals.
                  child.material = makeDefaultMatcapMaterial(
                    getMatcapTexture(matcapTexturesRef.current, currentMatcapIdRef.current),
                    currentMatcapIdRef.current,
                    false,
                  );
                } else {
                  // No normal channel — compute vertex normals in-place so the
                  // matcap has something to sample, then apply the same
                  // default matcap as the textured-matcap branch. This
                  // guarantees the model is visible with consistent shading
                  // even when the GLB was exported without normals (common
                  // with DRACO-compressed geometry and point-cloud pipelines)
                  // and gives the user a neutral, predictable default look
                  // rather than the rainbow "normal map" visualization.
                  child.geometry.computeVertexNormals();
                  child.material = makeDefaultMatcapMaterial(
                    getMatcapTexture(matcapTexturesRef.current, currentMatcapIdRef.current),
                    currentMatcapIdRef.current,
                    true, // flatShading for normals we just computed
                  );
                  console.warn(
                    "[3DViewer] GLB mesh has no NORMAL attribute; using " +
                      "default matcap (flat, computed normals) as fallback so " +
                      "the model is visible. Mesh name:",
                    child.name || "(unnamed)",
                    "uv=",
                    hasUVs,
                    "vertexColors=",
                    hasVertexColors,
                  );
                }
              }

              // Save the final-load material as the "default" so we can restore
              // it when the user switches back to Default from any view mode.
              (child.geometry as any)._origMaterial = child.material;
            }
          });

          // Center horizontally (X, Z) so the model sits in the middle of the
          // workplane, but keep its real Y position — i.e. translate only by
          // the XZ center and the negative Y-min so the model's lowest point
          // rests on the workplane (y=0). Previously we centered all three
          // axes around the box midpoint, which made the workplane slice the
          // model in half.
          const center = box.getCenter(new THREE.Vector3());
          // Center XZ around origin, and lift Y so model's lowest point sits on the workplane (y=0).
          object.position.x = -center.x;
          object.position.y = -box.min.y;
          object.position.z = -center.z;
          object.position.multiplyScalar(scale);
          object.scale.setScalar(scale);

          // Fix SkinnedMesh bounding box issues: SkinnedMesh from FBX often has
          // undefined boundingBox which can cause frustum culling to exclude the mesh.
          // Force-compute bounding box and disable frustum culling for skinned meshes.
          object.traverse((c: any) => {
            if (c.isSkinnedMesh) {
              if (!c.geometry) return;
              c.geometry.computeBoundingBox();
              c.geometry.computeBoundingSphere();
              c.frustumCulled = false;
            }
          });

          // Debug bbox wireframe was used for diagnostics; removed for final render
          // since it created a pyramid-like overlay that confused the visual comparison
          // with i-saint. (See wabc plan lessons learned.)
          sceneRef.current.add(object);
          modelRef.current = object;

          (() => {
            let v = 0, f = 0, m = 0, uv = false;
            object.traverse((c: any) => {
              if (!c.isMesh) return;
              m++;
              const geo = c.geometry;
              if (!geo) return;
              const posAttr = geo.attributes.position;
              if (posAttr) v += posAttr.count;
              if (geo.index) f += geo.index.count / 3;
              else if (posAttr) f += posAttr.count / 3;
              if (geo.attributes.uv) uv = true;
            });
            setMeshInfo({ vertices: v, faces: Math.round(f), meshes: m, hasUV: uv });
          })();

          // Camera distance: account for the scale that was applied to the model.
          // The scale fits the model to a reasonable size (e.g., 2.5 units for
          // normal models). Camera distance is based on the scaled size so models
          // of very different scales (e.g., a 300-unit FBX vs a 1-unit GLTF)
          // both frame nicely.
          const fov = cameraRef.current!.fov * (Math.PI / 180);
          const scaledDim = maxDim * scale;
          const fitDist = (scaledDim * 0.85) / Math.sin(fov / 2);
          cameraRef.current!.position.set(fitDist, fitDist * 0.6, fitDist);
          // Object is centered at origin (after translation + scale), so target is always (0,0,0).
          controlsRef.current!.target.set(0, 0, 0);
          controlsRef.current!.update();

          setLoading(false);

          if (animations.length > 0) {
            setupAnimations(object, animations);
          }

          // Re-run fitToView after one frame so the camera settles on the
          // model the same way the user-triggered Fit To View button does.
          // This also accounts for any sub-frame bbox recomputation.
          requestAnimationFrame(() => {
            if (mounted) fitToView();
          });

          // Track elapsed time for the animation loop delta.
          // THREE.Clock is deprecated in three.js 0.184+ (warn: THREE.Timer instead)
          // but remains functional. We compute delta manually to avoid coupling to
          // the deprecated Clock API.
          const frameStartMs = { value: performance.now() };
          let lastTimeMs = frameStartMs.value;

          function animate() {
            if (!mounted) return;
            animFrameRef.current = requestAnimationFrame(animate);
            controlsRef.current?.update();

            const nowMs = performance.now();
            const deltaSec = Math.min((nowMs - lastTimeMs) / 1000, 0.1);
            lastTimeMs = nowMs;

            // Check if FBX/GLTF animation should play
            const fbxAnimActive = mixerRef.current && (isAnimPlayingRef.current || fbxTimeRangeRef.current !== null);
            
            if (mixerRef.current) {
              // Only update mixer time when animation is actively playing
              if (isAnimPlayingRef.current) {
                mixerRef.current.update(deltaSec);
                // Sync scrubber with mixer time only when playing
                const timeRange = fbxTimeRangeRef.current;
                if (timeRange && timeRange[1] > 0) {
                  const clipDuration = timeRange[1];
                  let currentT = mixerRef.current.time % clipDuration;
                  if (currentT < 0) currentT += clipDuration;
                  setFbxCurrentTime(currentT);
                }
              }
              // When paused (scrubbing), DON'T update fbxCurrentTime - let user control
            }

            const abcRef = abcAnimRef.current;
            const playing = abcRef ? isAnimPlayingRef.current : false;
            if (abcRef && playing) {
              abcRef.elapsed += deltaSec;
              const totalSpan = abcRef.maxTime - abcRef.minTime;
              const cycleT = totalSpan > 0 ? (abcRef.elapsed % totalSpan) / totalSpan : 0;
              const t = abcRef.minTime + cycleT * totalSpan;
              abcRef.seekGeometry(t);
              setAbcCurrentTime(t);
            }

            gridShaderMaterial.uniforms.uCameraPos.value.copy(camera.position);

            rendererRef.current?.render(sceneRef.current!, cameraRef.current!);
            gizmoRef.current?.render();
          }
          animate();
        };

        const handleLoadError = (err: any) => {
          console.error("[ModelViewer] Load error:", err);
          if (mounted) {
            setError("Failed to load model: " + (err?.message || "Unknown error"));
            setLoading(false);
          }
        };

        let loader: any;
        // meshPostProcess disabled for testing
        /*
        let meshPostProcess: ((obj: THREE.Object3D) => void) | null = null;
        */
        let modelUrl: string;
        let modelBuffer: ArrayBuffer | null = null;

        const encodedPath = encodeURIComponent(filePath);
        modelUrl = `${HTTP_SERVER}/file?path=${encodedPath}`;

        if (ext === "obj") {
          // For large OBJ files (>~100MB), the standard OBJLoader fails because it
          // loads the entire file into a single JS string which hits Chrome's ~256MB
          // limit. OBJLoader2 from wwobjloader2 accepts ArrayBuffer directly and
          // parses it without creating a monolithic string, supporting files up to
          // 1GB+ in a browser. We fetch as ArrayBuffer and use OBJLoader2.parse().
          setLoadingPercent(0);
          modelBuffer = await fetchArrayBuffer(modelUrl, (p) => setLoadingPercent(p), abortCtrl.signal);
          if (!mounted) return;
        } else if (ext === "fbx") {
          setLoadingProgress("Parsing FBX model...");
          loader = new FBXLoader();
        } else if (ext === "stl") {
          // Use Rust backend (stl_io) for better performance on large files
          setLoadingProgress("Loading STL model via Rust...");
          const stlResult = await decodeStl(filePath);
          // Check if user navigated away during decode
          if (!mounted || abortCtrl.signal.aborted) return;
          if (!stlResult.success) {
            throw new Error(stlResult.error || "Failed to parse STL");
          }
          // Build BufferGeometry from Rust data.
          // STL stores 3 vertices per triangle as a flat list — every 3
          // consecutive positions form one triangle, NOT a smooth triangle
          // strip. The per-face normal from stl_io is the correct normal for
          // that triangle, but if we re-use those normals as per-vertex
          // normals on a non-indexed BufferGeometry, every face ends up
          // smooth-shaded against its neighbours (the famous "smooth STL"
          // look). For STL we want flat shading: drop the per-vertex normal
          // channel and let the material's `flatShading: true` recompute a
          // true face-normal in the fragment shader.
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(stlResult.vertices, 3)
          );
          // Intentionally do NOT set the `normal` attribute — see comment above.
          // The geometry's `computeVertexNormals()` would also be wrong here
          // because the positions are non-indexed and would average across
          // triangle boundaries.
          geometry.computeBoundingSphere();

          // Tag the geometry so applyViewMode knows to never swap the STL's
          // flat-shaded material for a matcap or xray overlay.
          (geometry as any)._fileExt = "stl";

          // STL files are authored in Z-up (Z = vertical axis). Three.js uses
          // Y-up. Rotate the geometry -90° around X to convert Z→Y without
          // changing the visual appearance. After this rotation the geometry's
          // local +Z becomes local +Y (world up).
          geometry.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));

          // Create mesh: flatShading is essential for STL because STL triangles
          // are planar facets with no UVs and no shared normals — smooth
          // shading produces visible artifacts. MeshStandardMaterial with
          // flatShading: true gives the best preview for engineering meshes
          // (gears, brackets, prints) while still respecting the scene's
          // matcap fallback for untextured GLB/GLTF elsewhere.
          const mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({
              // Mid-gray: neutral for engineering STL parts. Combined with the
              // 3-light rig + ACESFilmic tone mapping + exposure 1.2, 0x808080
              // reads as a clean medium gray under normal light.
              color: 0x808080,
              side: THREE.DoubleSide,
              flatShading: true,
              metalness: 0.0,
              roughness: 0.7,
            })
          );
          handleLoadedObject(mesh);
          // STL is flat-shaded — dim default brightness to 0.1 for better preview
          setBrightness(0.1);
          return; // Skip the rest of the loader logic
        } else if (ext === "ply") {
          setLoadingProgress("Parsing PLY model...");
          loader = new PLYLoader();
        } else if (ext === "3ds" && TDSLoader) {
          setLoadingProgress("Parsing 3DS model...");
          loader = new TDSLoader();
        } else if (ext === "3mf" && ThreeMFLoader) {
          setLoadingProgress("Parsing 3MF model...");
          setLoadingPercent(0);
          loader = new ThreeMFLoader();
          // Set URL modifier so embedded textures are loaded through our HTTP server
          const textureDir = filePath.replace(/[\\/][^\\/]+$/, "");
          (loader as any).manager?.setURLModifier?.((url: string) => {
            if (url.startsWith("http") || url.startsWith("blob:") || url.startsWith("data:")) return url;
            return `${HTTP_SERVER}/file?path=${encodeURIComponent(textureDir + "/" + url)}`;
          });
          modelBuffer = await fetchArrayBuffer(modelUrl, (p) => setLoadingPercent(p), abortCtrl.signal);
          if (!mounted || abortCtrl.signal.aborted) return;
          // Parse 3MF synchronously (ThreeMFLoader doesn't use callbacks)
          setLoadingPercent(80);
          const group = loader.parse(modelBuffer);
          if (!mounted || abortCtrl.signal.aborted) return;
          group.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });

          // Tag the geometry so applyViewMode knows this is a CAD format
          group.traverse((child) => {
            if (child instanceof THREE.Mesh && child.geometry) {
              (child.geometry as any)._fileExt = "3mf";
            }
          });

          // 3MF files are authored in Z-up (Z = vertical axis). Three.js uses
          // Y-up. Rotate the group -90° around X to convert Z→Y.
          group.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));

          (group as any)._fileExt = "3mf";
          setLoadingPercent(100);
          handleLoadedObject(group);
          // 3MF is a CAD format — dim default brightness to 0.1 for better preview
          setBrightness(0.1);
          return; // Done - skip remaining loader logic
        } else if ((ext === "igs" || ext === "iges" || ext === "step" || ext === "stp")) {
          // IGES, STEP need modelBuffer — fetch it early
          if (!modelBuffer) {
            setLoadingProgress(`Fetching ${ext.toUpperCase()} file...`);
            setLoadingPercent(0);
            modelBuffer = await fetchArrayBuffer(modelUrl, (p) => setLoadingPercent(p), abortCtrl.signal);
          }
        } else if (ext === "abc") {
          // wabc loader — we don't need a three.js Loader; the WabcLoader
          // produces a complete THREE.Group synchronously. The dispatch
          // branch below handles .abc directly via handleLoadedObject.
        } else if (ext === "spz") {
          // SPZ is handled separately below — no three.js loader needed.
        } else if (ext === "dae") {
          // Collada .dae is XML text — fetch it as a plain string so we can
          // hand it directly to ColladaLoader.parse() which expects raw text.
          // (ColladaLoader.load() would also work but goes through FileLoader
          // with the same URL, so a plain fetch + parse is cleaner.)
          if (!modelBuffer) {
            setLoadingProgress("Fetching Collada file...");
            setLoadingPercent(0);
            const response = await fetch(modelUrl, { signal: abortCtrl.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status} fetching DAE`);
            const text = await response.text();
            if (!mounted) return;
            modelBuffer = text as unknown as ArrayBuffer; // cast: parse branch reads it as string
            setLoadingPercent(100);
          }
        } else if (ext === "skp") {
          // SketchUp .skp: parse via openskp Python sidecar → GLB → GLTFLoader.
          // The Python sidecar does not emit progress events today, so a raw
          // "set 5% then await the sidecar" makes the bar look frozen on
          // large files. Animate the bar upward on a slow tick (and refresh
          // the label) so the user can tell the worker is alive.
          try {
            setLoadingProgress("Parsing SketchUp model...");
            setLoadingPercent(5);
            const invoke = (window as any).__TAURI__?.core?.invoke
              ?? (window as any).__TAURI_INTERNALS__?.invoke;
            if (!invoke) throw new Error("Tauri invoke not available");

            let skpPercent = 5;
            const progressTimer = window.setInterval(() => {
              if (!mounted) return;
              // Asymptote toward 55% so the bar never claims completion
              // while the sidecar is still working.
              skpPercent = Math.min(55, skpPercent + Math.max(0.4, (55 - skpPercent) * 0.05));
              setLoadingPercent(Math.round(skpPercent));
            }, 350);

            let result: any;
            try {
              result = await invoke("parse_skp_file", { path: filePath });
            } finally {
              window.clearInterval(progressTimer);
            }
            if (!mounted) return;
            if (!result?.glb) throw new Error("skp-parser returned an empty GLB payload");

            setLoadingProgress("Building scene...");
            setLoadingPercent(60);

            // Tauri serialises Rust `Vec<u8>` as a JS `number[]`, so build the
            // GLB bytes directly from the array. (No base64 round-trip needed.)
            const bytes = Array.isArray(result.glb)
              ? Uint8Array.from(result.glb)
              : new Uint8Array(result.glb);
            const blob = new Blob([bytes.buffer], { type: result.mime || "model/gltf-binary" });
            const blobUrl = URL.createObjectURL(blob);

            // Load into three.js via dynamic imports (avoids relying on outer-scope loader vars).
            const [gltfMod, dracoMod] = await Promise.all([
              import("three/examples/jsm/loaders/GLTFLoader.js"),
              import("three/examples/jsm/loaders/DRACOLoader.js"),
            ]);
            const gltf = await new Promise<any>((resolve, reject) => {
              const loader = new gltfMod.GLTFLoader();
              const dLoader = new dracoMod.DRACOLoader();
              dLoader.setDecoderPath(DRACO_DECODER_PATH);
              (dLoader as any).setDecoderConfig?.({ type: "js" });
              loader.setDRACOLoader(dLoader);
              loader.load(
                blobUrl,
                (g) => resolve(g),
                undefined,
                (e) => reject(e instanceof Error ? e : new Error(String(e))),
              );
            });
            URL.revokeObjectURL(blobUrl);
            if (!mounted) return;

            const group = gltf.scene || gltf.scenes?.[0];
            if (!group) throw new Error("GLB parsed but no scene was returned");
            (group as any)._fileExt = "skp";
            group.traverse?.((c: any) => { if (c.isMesh) c.castShadow = true; });
            setLoadingPercent(100);
            handleLoadedObject(group);
            return;
          } catch (err: any) {
            const msg = String(err?.message ?? err ?? "");
            if (msg.startsWith("skp_too_old:")) {
              const parts = msg.split(":");
              throw new Error(
                "SketchUp version " + (parts[1] || "unknown") + " is older than " + (parts[2] || "2021") + ". " +
                  "Save the file from SketchUp 2021 or newer to preview it.",
              );
            }
            if (msg.includes("Python not found")) {
              throw new Error("Python 3.9+ is required to preview SketchUp files.");
            }
            throw new Error("SketchUp preview failed: " + (msg || "unknown error"));
          }
        } else {
          setLoadingProgress("Loading GLTF/GLB model...");
          setLoadingPercent(0);
          loader = new GLTFLoader();
          modelBuffer = await fetchArrayBuffer(modelUrl, (p) => setLoadingPercent(p), abortCtrl.signal);
          const { usesDraco, usesMeshopt } = detectCompressionMode(modelBuffer);

          if (usesDraco && DRACOLoader) {
            const dracoLoader = new DRACOLoader();
            dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
            // Force the JS decoder (draco_decoder.js) instead of the WASM
            // variant (draco_wasm_wrapper.js + .wasm).
            (dracoLoader as any).setDecoderConfig?.({ type: "js" });
            // CRITICAL: DRACOLoader's default `_initDecoder` builds a Worker
            // from `new Blob([…])` via `URL.createObjectURL()`. Tauri WebView
            // chokes on the resulting blob (SyntaxError 'Unexpected token ":"'
            // at 2:9 — the Emscripten-generated body is not safe for
            // Tauri's Worker parser). We override the loader with a hand-
            // written Worker file that lives at /draco/dracoWorker.js, where
            // dracoWorker.js does `importScripts('./draco_decoder.js')` and
            // then implements the same `onmessage` protocol the inline body
            // would have used.
            (dracoLoader as any)._initDecoder = function () {
              if ((dracoLoader as any).decoderPending) {
                return (dracoLoader as any).decoderPending;
              }
              (dracoLoader as any).decoderPending = new Promise((resolve) => {
                // Resolve immediately; the Worker file is in /draco/ and
                // doesn't need any preload. The 'init' message from
                // _getWorker will still be sent to the worker so the
                // decoder module config is plumbed through.
                const workerUrl = `${DRACO_DECODER_PATH}dracoWorker.js`;
                (dracoLoader as any).workerSourceURL = workerUrl;
                resolve();
              });
              return (dracoLoader as any).decoderPending;
            };
            (loader as any).setDRACOLoader(dracoLoader);
          }

          if (usesMeshopt && MeshoptDecoder) {
            await MeshoptDecoder.ready;
            (loader as any).setMeshoptDecoder(MeshoptDecoder);
          }
        }

        // ─── 3D Gaussian Splatting detection ───────────────────────────────────
        // PLY files with property names like f_dc_0 / rot_* are 3DGS clouds,
        // not triangle meshes. We early-out into a dedicated branch that
        // downloads → converts to .ksplat in memory → renders through the
        // @mkkellogg/gaussian-splats-3d viewer. This branch skips the
        // entire three.js mesh pipeline below.
        if (isPossiblyGsPly) {
          setLoadingPercent(0);
          const plyBuffer = await fetchArrayBuffer(modelUrl, (p) => setLoadingPercent(p), abortCtrl.signal);
          if (!mounted) return;

          // Heuristic: if the file path itself hints at 3DGS ("splat",
          // "gaussian", "3dgs"), treat the file as 3DGS even if the
          // header detector is unsure. This catches renamed files and
          // unusual variants that don't match the standard signatures.
          const filenameLooksLikeGs = /\b(splat|gaussian|3dgs|3d_gs|gs_ply)\b/i.test(filePath);

          let plyInfo: Awaited<ReturnType<typeof detectGaussianSplatFormat>> | null = null;
          try {
            plyInfo = await detectGaussianSplatFormat(plyBuffer);
          } catch (_sniffErr) {
            // ignore
          }
          const plyFormat = plyInfo?.format ?? "unknown";
          const plyHeaderSaysGs = plyFormat !== "unknown";
          const plyHeaderSaysMesh =
            /\belement\s+face\b/i.test(plyInfo?.headerText ?? "");
          const plyHeaderSaysGsFinal = plyHeaderSaysGs || (filenameLooksLikeGs && !plyHeaderSaysMesh);

          // If the PLY is 3DGS, route to the splat viewer. If the file
          // has a "face" element, it's a real mesh PLY and we fall
          // through to the standard loader. Otherwise (no face element
          // and no 3DGS signature) it's a raw point cloud — try the
          // legacy PLYLoader but expect it to look bad.
          if (plyHeaderSaysGsFinal && plyInfo && !plyHeaderSaysMesh) {
            try {
              await loadGaussianSplatScene(
                plyBuffer,
                gsProgress,
                setGsProgress,
                gsCancelRef.current,
                gsKsplatBufferRef,
                gsSplatViewerRef,
                gsBlobUrlRef,
                gsAnimateFrameRef,
                () => mounted,
                () => rendererRef.current,
                () => sceneRef.current,
                () => cameraRef.current,
                () => controlsRef.current,
                setGsError,
                setLoading,
                plyInfo,
                gsFlipY,
                language,
              );
              return () => {};
            } catch (err: any) {
              setGsError((err?.message || String(err)));
              setLoading(false);
              return () => {};
            }
          }
          // Not 3DGS — reuse the buffer with the standard PLYLoader below.
          // We also wrap the legacy mesh path in a try/catch downstream
          // via handleLoadError so 3DGS-shaped point clouds don't trip
          // Box3.setFromObject's updateWorldMatrix() call (which only
          // works on real Object3D meshes, not raw vertex soup).
          modelBuffer = plyBuffer;
          loader = new PLYLoader();
        }

        // ─── SPZ (Pre-compressed Splat) loading ───────────────────────────────
        // SPZ files are pre-compressed splat archives that load directly into
        // the GaussianSplats3D viewer without needing PLY→ksplat conversion.
        if (ext === "spz") {
          setLoadingPercent(0);
          const spzBuffer = await fetchArrayBuffer(modelUrl, (p) => setLoadingPercent(p), abortCtrl.signal);
          if (!mounted) return;

          try {
            await loadSpzScene(
              spzBuffer,
              setGsProgress,
              gsSplatViewerRef,
              gsBlobUrlRef,
              gsAnimateFrameRef,
              () => mounted,
              () => rendererRef.current,
              () => sceneRef.current,
              () => cameraRef.current,
              () => controlsRef.current,
              setGsError,
              setLoading,
              gsFlipY,
              language,
            );
            return () => {};
          } catch (err: any) {
            setGsError((err?.message || String(err)));
            setLoading(false);
            return () => {};
          }
        }

        // Both GLTFLoader and USDLoader use THREE.LoadingManager internally.
        // Without interception that manager resolves relative texture URIs
        // (e.g. "foo.png") against the HTTP basePath instead of the on-disk
        // directory, producing 404s. Rewrite every URL through /file?path=...
        // so whatever folder the model came from, its accompanying PNGs follow.
        // Guard against undefined loader (.abc / wabc path does not create a
        // three.js Loader — the WabcLoader builds the Group directly).
        const textureDir = filePath.replace(/[\\/][^\\/]+$/, "");
        if (loader) {
          (loader as any).manager?.setURLModifier?.((url: string) => {
            if (url.startsWith("http") || url.startsWith("blob:") || url.startsWith("data:")) return url;
            return `${HTTP_SERVER}/file?path=${encodeURIComponent(textureDir + "/" + url)}`;
          });
        }

        if (ext === "glb" || ext === "gltf") {
          if (!modelBuffer) throw new Error("Model buffer missing for GLTF/GLB parse.");
          // Don't pass a basePath derived from the HTTP URL — GLTFLoader
          // would concatenate it with relative texture URIs like
          // "wraith_...png" and try http://localhost/PORT/foo.png which
          // 404s. The URL modifier above rewrites every URI to the
          // /file?path=... endpoint instead, so an empty path is fine.
          loader.parse(modelBuffer, "", handleLoadedObject, handleLoadError);
        } else if (ext === "abc") {
          // wabc (WebAlembicViewer) loader: bypasses the three.js Loader
          // path. WabcLoader.loadAlembicFromBuffer produces a fully-built
          // THREE.Group, a list of animation times, and a morph count. We use
          // handleLoadedObject for the standard bounding-box / fit-to-view
          // setup, then wire up manual morph interpolation directly so we
          // don't depend on Three.js AnimationMixer's PropertyBinding (which
          // requires the mesh name to match the track path and breaks for
          // .abc files whose mesh is named after the file).
          if (!filePath) throw new Error("Alembic (.abc) load requires filePath.");
          console.info("[3DViewer] Loading ABC via wabc...");
          loadAlembicFromBuffer(new ArrayBuffer(0), undefined, filePath, modelUrl)
            .then((result) => {
              if (!mounted) {
                closeAlembic(result.handle);
                return;
              }
              abcHandleRef.current = result.handle;
              // Feed the group into the standard pipeline for bbox, fit-to-view, etc.
              // IMPORTANT: this calls cleanupAnimations() which resets
              // isAnimPlayingRef.current to false. So we must register
              // abcAnimRef + isAnimPlayingRef AFTER handleLoadedObject, or the
              // animation will be silently killed.
              const fakeResult = {
                scene: result.group,
                animations: [] as THREE.AnimationClip[],
              };
              handleLoadedObject(fakeResult);
              if (result.isAnimated) {
                const [t0, t1] = [result.times[0], result.times[result.times.length - 1]];
                abcAnimRef.current = {
                  seekGeometry: result.seekGeometry,
                  times: result.times,
                  elapsed: 0,
                  minTime: t0,
                  maxTime: t1,
                };
                // Auto-play Alembic animation on load. The seekGeometry path
                // is now safe: we removed the per-frame normal recomputation
                // (the source of the previous crash) and the loader just
                // writes the new expanded positions into the existing
                // BufferAttribute.
                isAnimPlayingRef.current = true;
                console.info(
                  `[3DViewer] ABC loaded, animated=${result.times.length > 1} (auto-play), t=[${t0.toFixed(3)}, ${t1.toFixed(3)}], frames=${result.times.length}`,
                );
                setAbcTimeRange([t0, t1]);
                setAbcCurrentTime(t0);
                setAbcFps(result.fps);
                setAbcFrameCount(result.frameCount);
                setAnimationInfo({
                  clipName: "Alembic",
                  clipCount: 1,
                });
                setIsAnimating(true);
              } else {
                setAbcTimeRange(null);
                setAbcCurrentTime(0);
                setAbcFps(0);
                setAbcFrameCount(0);
              }
            })
            .catch(handleLoadError);
        } else if (ext === "obj") {
          // Large OBJ (>~100MB) path: fetch as ArrayBuffer and parse with OBJLoader2.
          // OBJLoader2.parse(ArrayBuffer) processes the binary data directly without
          // creating a monolithic JS string, so it handles files up to ~1GB reliably.
          // Small OBJ files fall back to the legacy OBJLoader.load() path below.
          if (!modelBuffer) throw new Error("Model buffer missing for OBJ parse.");
          const obj2 = await import("wwobjloader2");
          const loader2 = new obj2.OBJLoader2();
          // Set the base path so any .mtl / .png referenced in the OBJ are
          // fetched through our HTTP server instead of a relative path.
          loader2.setPath(`${HTTP_SERVER}/file?path=${encodeURIComponent(textureDir)}`);
          // OBJLoader2.parse accepts ArrayBuffer directly.
          // fetchArrayBuffer returns a plain ArrayBuffer (not a typed array view),
          // so we pass it directly — no need for .buffer/.byteOffset gymnastics.
          const group = loader2.parse(modelBuffer);
          setLoadingPercent(100);
          handleLoadedObject(group);
        } else if (ext === "fbx" && modelBuffer) {
          // FBX: pre-fetched the buffer above for FrameRate extraction. Parse it
          // directly here so we don't double-fetch via loader.load(modelUrl).
          loader.parse(modelBuffer, "", handleLoadedObject, handleLoadError);
        } else if (ext === "usdz" || ext === "usd" || ext === "usda" || ext === "usdc") {
          if (!modelBuffer) throw new Error("Model buffer missing for USD parse.");
          // USDLoader.parse() returns the parsed Group synchronously and
          // (unlike GLTFLoader) does NOT accept onLoad/onError callbacks in
          // three.js 0.184. We therefore wrap parse() ourselves: catch any
          // thrown error and feed the result into the same handleLoadedObject
          // path used by every other loader.
          //
          // USDComposer internally creates `new Image()` for textures but
          // does not set `crossOrigin`. Inside the Tauri WebView this
          // triggers a `SecurityError: image element contains cross-origin
          // data` from WebGL `texSubImage2D`, so the textures never show
          // up. We temporarily monkey-patch `Image` to set
          // `crossOrigin = "anonymous"` while we call parse() — same-origin
          // blob/data URLs are unaffected, but the WebGL upload goes through.
          const OriginalImage = (globalThis as any).Image;
          class PatchedImage extends OriginalImage {
            constructor(width?: number, height?: number) {
              super(width, height);
              try {
                this.crossOrigin = "anonymous";
              } catch {
                /* ignore */
              }
            }
          }
          (globalThis as any).Image = PatchedImage;
          try {
            // USDLoader.parse() is synchronous - no progress animation needed
            const group = loader.parse(modelBuffer);
            (globalThis as any).Image = OriginalImage;
            handleLoadedObject(group);
          } catch (err) {
            (globalThis as any).Image = OriginalImage;
            handleLoadError(err);
          }
        } else if ((ext === "step" || ext === "stp") && modelBuffer) {
          // STEP files via CAD Worker (off main thread) with sync fallback
          if (!mounted || abortCtrl.signal.aborted) return;

          try {
            // First, ensure worker is initialized
            setLoadingProgress("Initializing CAD decoder...");
            await initCadWorker();

            if (!mounted || abortCtrl.signal.aborted) return;

            const worker = getCadWorker();

            if (worker && cadWorkerReady) {
              // Use worker (non-blocking)
              setLoadingProgress("Parsing STEP model (off main thread)...");
              const decodeId = Date.now() + Math.random();

              const result = await new Promise<any>((resolve, reject) => {
                const timeout = setTimeout(() => {
                  worker.removeEventListener('message', handler);
                  reject(new Error('STEP decode timeout'));
                }, 120000);

                const handler = (e: MessageEvent) => {
                  const { type, id, result: r, error, percent } = e.data;
                  if (id !== decodeId) return;

                  if (type === 'progress') {
                    setLoadingPercent(percent);
                  } else if (type === 'result') {
                    clearTimeout(timeout);
                    worker.removeEventListener('message', handler);
                    resolve(r);
                  } else if (type === 'error') {
                    clearTimeout(timeout);
                    worker.removeEventListener('message', handler);
                    reject(new Error(error));
                  }
                };

                worker.addEventListener('message', handler);

                if (abortCtrl.signal.aborted) {
                  clearTimeout(timeout);
                  worker.removeEventListener('message', handler);
                  reject(new Error('Aborted'));
                  return;
                }

                worker.postMessage({
                  type: 'decode',
                  id: decodeId,
                  buffer: modelBuffer,
                  format: 'step'
                });
              });

              if (!mounted || abortCtrl.signal.aborted) return;

              if (!result.success) {
                throw new Error(result.message || "STEP import failed");
              }

              // Convert the result to a THREE.Group
              const group = occtResultToThreeGroup(result);
              // STEP has no normals/UVs — use flat shading like STL
              group.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                  child.castShadow = true;
                  child.receiveShadow = true;
                  if (Array.isArray(child.material)) {
                    child.material = child.material.map(m =>
                      new THREE.MeshStandardMaterial({
                        color: 0x808080,
                        side: THREE.DoubleSide,
                        flatShading: true,
                        metalness: 0.0,
                        roughness: 0.7,
                      })
                    );
                  } else {
                    child.material = new THREE.MeshStandardMaterial({
                      color: 0x808080,
                      side: THREE.DoubleSide,
                      flatShading: true,
                      metalness: 0.0,
                      roughness: 0.7,
                    });
                  }
                }
              });
              // Tag so applyViewMode knows this is a CAD file
              (group as any)._fileExt = "step";
              setLoadingPercent(100);
              handleLoadedObject(group);
              setBrightness(0.1);
            } else {
              // Worker not available - use sync fallback
              throw new Error('Worker not available');
            }
          } catch (workerErr) {
            // Fallback to synchronous decode
            console.warn('[3DViewer] CAD Worker failed, using sync fallback:', workerErr);
            try {
              setLoadingProgress("Loading OpenCASCADE (sync mode)...");

              if (!mounted || abortCtrl.signal.aborted) return;

              const occtModule = await import("occt-import-js");

              setLoadingProgress("Fetching OpenCASCADE WASM...");
              const wasmBinary = await fetch(
                new URL("occt-import-js/dist/occt-import-js.wasm", import.meta.url),
                { signal: abortCtrl.signal, integrity: undefined }
              ).then(r => r.arrayBuffer());
              if (!mounted || abortCtrl.signal.aborted) return;

              setLoadingProgress("Initializing OpenCASCADE...");
              const occt = await occtModule.default({ wasmBinary });
              if (!mounted || abortCtrl.signal.aborted) return;

              setLoadingProgress("Parsing STEP model (sync)...");
              const result = occt.ReadStepFile(new Uint8Array(modelBuffer), {
                linearDeflection: 0.001,
                angularDeflection: 0.5,
              });
              if (!mounted || abortCtrl.signal.aborted) return;

              if (!result.success) {
                throw new Error(result.message || "STEP import failed");
              }

              const group = occtResultToThreeGroup(result);
              group.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                  child.castShadow = true;
                  child.receiveShadow = true;
                  if (Array.isArray(child.material)) {
                    child.material = child.material.map(m =>
                      new THREE.MeshStandardMaterial({
                        color: 0x808080,
                        side: THREE.DoubleSide,
                        flatShading: true,
                        metalness: 0.0,
                        roughness: 0.7,
                      })
                    );
                  } else {
                    child.material = new THREE.MeshStandardMaterial({
                      color: 0x808080,
                      side: THREE.DoubleSide,
                      flatShading: true,
                      metalness: 0.0,
                      roughness: 0.7,
                    });
                  }
                }
              });
              (group as any)._fileExt = "step";
              setLoadingPercent(100);
              handleLoadedObject(group);
              setBrightness(0.1);
            } catch (err) {
              handleLoadError(err);
            }
          }
        } else if ((ext === "igs" || ext === "iges") && modelBuffer) {
          // IGES files via occt-import-js (OpenCASCADE WASM)
          if (!mounted || abortCtrl.signal.aborted) return;
          try {
            setLoadingProgress("Parsing IGES model...");
            // Use three-iges-loader for IGES (simpler than occt for IGES)
            const igesLoader = new IGESLoader();
            const text = new TextDecoder("utf-8", { fatal: false }).decode(modelBuffer);
            if (!mounted || abortCtrl.signal.aborted) return;
            const group = igesLoader.parse(text);
            // IGES has no normals/UVs — use flat shading like STL
            group.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                if (Array.isArray(child.material)) {
                  child.material = child.material.map(m =>
                    new THREE.MeshStandardMaterial({
                      color: 0x808080,
                      side: THREE.DoubleSide,
                      flatShading: true,
                      metalness: 0.0,
                      roughness: 0.7,
                    })
                  );
                } else {
                  child.material = new THREE.MeshStandardMaterial({
                    color: 0x808080,
                    side: THREE.DoubleSide,
                    flatShading: true,
                    metalness: 0.0,
                    roughness: 0.7,
                  });
                }
              }
            });
            // Tag so applyViewMode knows this is a CAD file
            (group as any)._fileExt = "igs";
            setLoadingPercent(100);
            handleLoadedObject(group);
            // IGES is flat-shaded — dim default brightness to 0.1 for better preview
            setBrightness(0.1);
          } catch (err) {
            handleLoadError(err);
          }
        } else if (ext === "dae") {
          // Collada .dae: fetch text → ColladaLoader.parse() → Group.
          // Fetch was done in Block 1 and stored as modelBuffer (cast to string).
          const daeText = modelBuffer as unknown as string;
          setLoadingProgress("Parsing Collada scene...");
          setLoadingPercent(30);
          try {
            const { ColladaLoader: DAE } = await import("three/examples/jsm/loaders/ColladaLoader.js");
            const loader = new DAE();
            // parse(text, basePath) — basePath lets textures be resolved relative
            // to the original DAE file location.
            const basePath = modelUrl.substring(0, modelUrl.lastIndexOf("/") + 1);
            const result = loader.parse(daeText, basePath);
            const group = result.scene;
            // DAE files commonly have Z_UP — ColladaLoader handles the visual
            // rotation but Box3.setFromObject may not see it until after the
            // next render frame, so we let fitToView() on the next RAF handle it.
            (group as any)._fileExt = "dae";
            setLoadingPercent(100);
            handleLoadedObject(group);
            // Collada materials often look washed out under the default white
            // ambient + directional lights — dim to 0.1 for a more readable preview.
            setBrightness(0.1);
          } catch (err) {
            handleLoadError(err);
          }
        } else if (ext === "3ds" && TDSLoader) {
          // 3DS files are authored in Z-up. Wrap the load callback so the
          // resulting Group is rotated -90° around X (Z→Y) before being
          // handed to handleLoadedObject. We tag the group with _fileExt
          // so applyViewMode (matcap/x-ray toggles) can special-case it
          // the same way 3MF does.
          const wrappedOnLoad = (result: any) => {
            const object = result.scene || result;
            object.traverse((child: THREE.Object3D) => {
              if (child instanceof THREE.Mesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                (child.geometry as any)._fileExt = "3ds";
              }
            });
            // Z-up → Y-up: rotate -90° around X. Same transform used for 3MF.
            object.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
            (object as any)._fileExt = "3ds";
            handleLoadedObject(object);
          };
          loader.load(modelUrl, wrappedOnLoad, undefined, handleLoadError);
        } else {
          loader.load(modelUrl, handleLoadedObject, undefined, handleLoadError);
        }

        const handleResize = () => {
          resizeViewport();
          gizmoRef.current?.update();
        };
        const resizeObserver = new ResizeObserver(() => {
          resizeViewport();
          gizmoRef.current?.update();
        });
        resizeObserver.observe(container);
        window.addEventListener("resize", handleResize);

        const teardown = () => {
          resizeObserver.disconnect();
          window.removeEventListener("resize", handleResize);
        };
        // Return a teardown function from the async block. Wrapped in
        // Promise.resolve() so the outer useEffect cleanup callback can
        // retrieve it via the resolution value.
        return Promise.resolve(teardown);
      } catch (err: any) {
        console.error("[ModelViewer] Init error:", err);
        if (mounted) {
          setError("Three.js initialization failed: " + (err?.message || String(err)));
          setLoading(false);
        }
      }
    }

    initThree();

    return () => {
      mounted = false;
      // Mark any in-flight 3DGS convert as cancelled so its progress
      // callback no-ops instead of trying to update unmounted state.
      gsCancelRef.current.cancelled = true;
      // Tear down any live GaussianSplats3D viewer and free its GPU
      // resources plus the in-memory .ksplat ArrayBuffer before tearing
      // down three.js.
      if (gsAnimateFrameRef.current) {
        cancelAnimationFrame(gsAnimateFrameRef.current);
        gsAnimateFrameRef.current = 0;
      }
      if (gsSplatViewerRef.current) {
        try { gsSplatViewerRef.current.dispose(); } catch (e) { console.warn("[3DViewer] splat dispose failed:", e); }
        gsSplatViewerRef.current = null;
      }
      if (gsBlobUrlRef.current) {
        URL.revokeObjectURL(gsBlobUrlRef.current);
        gsBlobUrlRef.current = null;
      }
      gsKsplatBufferRef.current = null;
      // Release any open Alembic handle so the wabc WASM heap doesn't leak
      // across file changes.
      if (abcHandleRef.current !== null) {
        closeAlembic(abcHandleRef.current);
        abcHandleRef.current = null;
      }
      // Cancel any in-flight fetch/decode
      if (loadAbortRef.current) {
        loadAbortRef.current.abort();
        loadAbortRef.current = null;
      }
      abcAnimRef.current = null;
      setAbcTimeRange(null);
      setAbcCurrentTime(0);
      setAbcFps(0);
      setAbcFrameCount(0);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      cleanupAnimations();
      if (gizmoRef.current) {
        gizmoRef.current.detachControls();
        gizmoRef.current.dispose();
      }
      // Matcap textures are owned by the dedicated useEffect below, not here.
      if (rendererRef.current && containerRef.current) {
        containerRef.current.removeChild(rendererRef.current.domElement);
        rendererRef.current.dispose();
      }
    };
  }, [filePath]);

  // Populate matcap textures using a module-level cache. Because the parent
  // re-mounts this component on every file change (key={previewKey}), we
  // cannot rely on a per-mount fetch: the second fetch inside the Tauri
  // WebView2 occasionally fails with an opaque "Event" error from three.js's
  // TextureLoader. Sharing the cache (and the in-flight Promise) across all
  // mounts guarantees exactly one network/GPU upload per app session, while
  // still letting each instance reuse the textures through matcapTexturesRef.
  useEffect(() => {
    let cancelled = false;
    (Object.keys(MATCAPS) as MatcapId[]).forEach((id) => {
      // Already cached globally — copy reference into this instance's ref.
      const cached = matcapGlobalCache[id];
      if (cached) {
        matcapTexturesRef.current[id] = cached;
        return;
      }
      // Already loading — subscribe to the in-flight promise.
      const pending = matcapGlobalPending[id];
      if (pending) {
        pending.then((tex) => {
          if (cancelled || !tex) return;
          matcapTexturesRef.current[id] = tex;
          if (
            id === currentMatcapIdRef.current &&
            viewMode === "matcap" &&
            modelRef.current
          ) {
            applyViewMode("matcap");
          }
          if (
            rendererRef.current &&
            sceneRef.current &&
            cameraRef.current
          ) {
            rendererRef.current.render(sceneRef.current, cameraRef.current);
          }
        });
        return;
      }
      // First request for this matcap — kick off the load and cache the promise.
      const entry = MATCAPS[id];
      const resolvedUrl = resolveMatcapUrl(entry.file);
      const promise = (async () => {
        const T = await import("three");
        return new Promise<THREE.Texture | null>((resolve) => {
          const loader = new T.TextureLoader();
          loader.load(
            resolvedUrl,
            (tex) => {
              tex.colorSpace = T.SRGBColorSpace;
              tex.needsUpdate = true;
              matcapGlobalCache[id] = tex;
              resolve(tex);
            },
            undefined,
            (err) => {
              console.warn(`[3DViewer] Failed to load matcap '${id}'`);
              resolve(null);
            },
          );
        });
      })();
      matcapGlobalPending[id] = promise;
      promise.then(() => {
        delete matcapGlobalPending[id];
      });
      promise.then((tex) => {
        if (cancelled || !tex) return;
        matcapTexturesRef.current[id] = tex;
        if (
          id === currentMatcapIdRef.current &&
          viewMode === "matcap" &&
          modelRef.current
        ) {
          applyViewMode("matcap");
        }
        if (
          rendererRef.current &&
          sceneRef.current &&
          cameraRef.current
        ) {
          rendererRef.current.render(sceneRef.current, cameraRef.current);
        }
      });
    });
    return () => {
      // Do NOT dispose cached textures or cancel the global load — they
      // outlive this mount and are reused by the next one.
      cancelled = true;
      // Detach our per-instance refs so they can be GC'd; the global cache
      // still holds the underlying GPU texture alive.
      matcapTexturesRef.current = { default: null, normal: null };
    };
    // Intentionally only fires once on mount. filePath/state are read via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={viewerShellRef}
      className={`overflow-hidden bg-[#3f3f3f] ${
        isFocusView
          ? "fixed inset-0 z-[500] h-screen w-screen rounded-none shadow-2xl"
          : "relative w-full h-full rounded"
      }`}
    >
      {/* USD/USDZ files are rendered through USDScene, which loads the OpenUSD
          Hydra WASM directly into this React tree. That keeps the Three.js
          renderer, OrbitControls, ViewportGizmo and animation state in one
          place instead of the previous iframe-based "app inside an app".
          USDScene is now a "dumb renderer" — it exposes USDViewerHandle so
          the toolbar/timeline/focus controls below stay in lockstep with
          the rest of the 3D viewer chrome.

          The workplane (grid + axes) is owned by USDScene itself: it's
          rendered inside the same Three.js scene as the USD stage, so
          it stays in world space and stays synced to the camera exactly
          like the non-USD branch (whose grid lives inside its own
          WebGL renderer). No overlay here — that would be screen-space
          and drift away from the model as soon as the user orbits. */}
      {isUsdFile ? (
        <>
          <USDScene
            ref={usdViewerRef}
            filePath={filePath!}
            fileName={fileName}
            accentColor={accentColor}
          />
          {/* USD toolbar: mirrors the non-USD flow's left-top toolbar,
              filtered to USD-relevant buttons only (no view modes, no UV
              checker — those are mesh-specific). */}
          <div className="absolute top-2 left-2 z-20 flex gap-1">
            <button
              onClick={() => usdViewerRef.current?.fitToScene()}
              className="w-8 h-8 rounded flex items-center justify-center transition-colors bg-black/40 text-white/60 hover:bg-white/10"
              title="Fit to View"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
              </svg>
            </button>
            <button
              onClick={() => {
                const next = !usdShowWorkplane;
                setUsdShowWorkplane(next);
                usdViewerRef.current?.setShowWorkplane(next);
              }}
              className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                usdShowWorkplane ? "bg-white/20 text-white" : "bg-black/40 text-white/40 hover:bg-white/10"
              }`}
              title="Toggle Workplane"
            >
              <Grid3x3 className="w-4 h-4" />
            </button>

            <div className="w-px h-6 bg-white/20 mx-1 self-center" />

            <button
              onClick={() => setIsFocusView(!isFocusView)}
              className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                isFocusView ? "bg-white/20 text-white" : "bg-black/40 text-white/60 hover:bg-white/10"
              }`}
              title="Focus View"
            >
              <MonitorPlay className="w-4 h-4" />
            </button>

            <button
              onClick={handleFullscreen}
              className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                isFullscreen ? "bg-white/20 text-white" : "bg-black/40 text-white/60 hover:bg-white/10"
              }`}
              title="Full Screen"
            >
              <Maximize className="w-4 h-4" />
            </button>
          </div>
          {/* USD timeline — only when the loaded stage has a real animation
              range. Mirrors the ABC/FBX timeline layout at the bottom. */}
          {usdTimeRange &&
            usdTimeRange.end > usdTimeRange.start &&
            usdTimeRange.fps > 0 && (
              <div
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 backdrop-blur rounded-lg px-3 py-2 shadow-lg"
                style={{ backgroundColor: 'var(--surface-bg)', color: 'var(--timeline-fg)' }}
              >
                <button
                  onClick={() => usdViewerRef.current?.togglePlay()}
                  className="w-9 h-9 rounded flex items-center justify-center transition-colors hover:opacity-80"
                  style={{ backgroundColor: 'var(--timeline-btn-bg)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--timeline-btn-bg-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--timeline-btn-bg)'; }}
                  title={usdIsPlaying ? "Pause Animation" : "Play Animation"}
                >
                  {usdIsPlaying ? (
                    <Pause className="w-4 h-4" style={{ color: 'var(--timeline-fg)' }} />
                  ) : (
                    <Play className="w-4 h-4" style={{ color: 'var(--timeline-fg)' }} />
                  )}
                </button>
                <button
                  onClick={() => usdViewerRef.current?.reset()}
                  className="w-9 h-9 rounded flex items-center justify-center transition-colors hover:opacity-80"
                  style={{ backgroundColor: 'var(--timeline-btn-bg)', opacity: 0.8 }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--timeline-btn-bg-hover)'; e.currentTarget.style.opacity = '1'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--timeline-btn-bg)'; e.currentTarget.style.opacity = '0.8'; }}
                  title="Reset Animation"
                >
                  <RotateCcw className="w-4 h-4" style={{ color: 'var(--timeline-fg)' }} />
                </button>
                <div className="w-px h-6 mx-1" style={{ backgroundColor: 'var(--timeline-divider)' }} />
                <span className="text-[10px] font-mono w-16 text-right tabular-nums" style={{ color: 'var(--timeline-fg)' }}>
                  {(
                    (usdCurrentTime - usdTimeRange.start) / usdTimeRange.fps
                  ).toFixed(2)}s
                </span>
                <input
                  type="range"
                  min={usdTimeRange.start}
                  max={usdTimeRange.end}
                  step={1 / Math.max(usdTimeRange.fps, 1)}
                  value={usdCurrentTime}
                  onMouseDown={() => usdViewerRef.current?.pause()}
                  onChange={(e) => {
                    const t = parseFloat(e.target.value);
                    usdViewerRef.current?.seek(t);
                  }}
                  className="w-48 h-1.5 appearance-none rounded cursor-pointer"
                  style={{ accentColor: 'var(--accent-from-user, currentColor)', backgroundColor: 'var(--timeline-track)' }}
                />
                <span className="text-[10px] font-mono w-16 tabular-nums" style={{ color: 'var(--timeline-fg-muted)' }}>
                  {(
                    (usdTimeRange.end - usdTimeRange.start) /
                    usdTimeRange.fps
                  ).toFixed(2)}s
                </span>
                <div className="w-px h-6 mx-1" style={{ backgroundColor: 'var(--timeline-divider)' }} />
                <span className="text-[10px] font-mono tabular-nums whitespace-nowrap" style={{ color: 'var(--timeline-fg)' }}>
                  {usdTimeRange.fps.toFixed(2)} fps
                </span>
              </div>
            )}
        </>
      ) : isEwaFile ? (
        <EwaViewer
          fileName={fileName}
          filePath={filePath!}
          accentColor={accentColor}
          language={language}
        />
      ) : (
        <>
          <div className="absolute top-2 left-2 z-20 flex gap-1">
            {/* View modes (Default / Wireframe / Matcap / X-ray) plus UV checker
            only make sense for traditional triangle meshes. For 3DGS scenes
            the splat data is rendered by GaussianSplats3D's own shader and
            we don't expose material/material-swap concepts to the user, so
            we hide these controls and present the dedicated Flip-Y toggle
            instead. Detected via: gsSplatViewerRef is populated (viewer
            instance exists) AND we are not currently mid-conversion/error. */}
            {!gsSplatViewerRef.current && (
              <>
                <button
                  onClick={() => setViewMode("default")}
                  className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                    viewMode === "default" ? "bg-white/20 text-white" : "bg-black/40 text-white/60 hover:bg-white/10"
                  }`}
                  title="Default"
                >
                  <Box className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setViewMode("wireframe")}
                  className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                    viewMode === "wireframe" ? "bg-white/20 text-white" : "bg-black/40 text-white/60 hover:bg-white/10"
                  }`}
                  title="Wireframe"
                >
                  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                <line x1="12" y1="22.08" x2="12" y2="12"/>
              </svg>
            </button>
            <button
              onClick={() => {
                setViewMode(viewMode === "matcap" ? "default" : "matcap");
              }}
              className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                viewMode === "matcap" ? "bg-white/20 text-white" : "bg-black/40 text-white/60 hover:bg-white/10"
              }`}
              title="Matcap"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="9"/>
                <path d="M12 3 C 7 8, 7 16, 12 21" strokeWidth="1"/>
                <path d="M3 12 C 8 7, 16 7, 21 12" strokeWidth="1"/>
              </svg>
            </button>
            {viewMode === "matcap" && (
              <div className="flex items-center gap-1 ml-1 pl-1 border-l border-white/10">
                {(Object.keys(MATCAPS) as MatcapId[]).map((id) => {
                  const active = currentMatcapId === id;
                  return (
                    <button
                      key={id}
                      onClick={() => {
                        setCurrentMatcapId(id);
                        // Make sure we're actually in matcap mode. Picking a matcap
                        // without enabling the mode would be a no-op because the
                        // render path only swaps materials when mode === "matcap".
                        setViewMode("matcap");
                      }}
                      className={`h-8 rounded overflow-hidden flex items-center gap-1.5 pl-1 pr-2 text-xs transition-colors ${
                        active
                          ? "bg-white/20 text-white ring-1 ring-white/40"
                          : "bg-black/40 text-white/70 hover:bg-white/10"
                      }`}
                      title={`Matcap: ${MATCAPS[id].label}`}
                    >
                      <span
                        className="w-6 h-6 rounded-full border border-white/20 bg-black/30"
                        style={{
                          backgroundImage: `url(${MATCAPS[id].file})`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                        }}
                        aria-hidden
                      />
                      {MATCAPS[id].label}
                    </button>
                  );
                })}
              </div>
            )}
            <button
              onClick={() => setViewMode("xray")}
              className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                viewMode === "xray" ? "bg-white/20 text-white" : "bg-black/40 text-white/60 hover:bg-white/10"
              }`}
              title="X-Ray"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="9" strokeDasharray="4 2"/>
                <path d="M12 3 C 7 8, 7 16, 12 21"/>
                <path d="M3 12 C 8 7, 16 7, 21 12"/>
              </svg>
            </button>

            <div className="w-px h-6 bg-white/20 mx-1 self-center" />
            {/* UV checker — only meaningful for textured meshes. */}
            <button
              onClick={toggleUVChecker}
              className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                showUVChecker ? "bg-white/20 text-white" : "bg-black/40 text-white/60 hover:bg-white/10"
              }`}
              title={uvCheckerNotice ?? "Toggle UV Checker"}
              disabled={!!uvCheckerNotice}
            >
              <Grid3x3 className="w-4 h-4" />
            </button>

            <div className="w-px h-6 bg-white/20 mx-1 self-center" />
            {/* Brightness slider: scales lit material colors. Does NOT affect
            toneMappingExposure, so grid/axes/gizmo/overlays stay unchanged. */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => setBrightness(b => b !== 1.0 ? 1.0 : 0.7)}
                className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                  brightness !== 1.0 ? "bg-white/20 text-white" : "bg-black/40 text-white/60 hover:bg-white/10"
                }`}
                title={brightness !== 1.0 ? `Brightness: ${brightness.toFixed(1)} (click to reset)` : "Adjust brightness"}
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="4"/>
                  <line x1="12" y1="2" x2="12" y2="5"/>
                  <line x1="12" y1="19" x2="12" y2="22"/>
                  <line x1="2" y1="12" x2="5" y2="12"/>
                  <line x1="19" y1="12" x2="22" y2="12"/>
                  <line x1="4.22" y1="4.22" x2="6.34" y2="6.34"/>
                  <line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/>
                  <line x1="4.22" y1="19.78" x2="6.34" y2="17.66"/>
                  <line x1="17.66" y1="6.34" x2="19.78" y2="4.22"/>
                </svg>
              </button>
              {brightness !== 1.0 && (
                <input
                  type="range"
                  min={0.05}
                  max={0.9}
                  step={0.05}
                  value={brightness}
                  onChange={e => setBrightness(parseFloat(e.target.value))}
                  className="w-20 h-1 accent-white cursor-pointer"
                  title={`Brightness: ${brightness.toFixed(2)}`}
                />
              )}
            </div>
          </>
        )}

        <div className="w-px h-6 bg-white/20 mx-1 self-center" />

        <button
          onClick={fitToView}
          className="w-8 h-8 rounded flex items-center justify-center transition-colors bg-black/40 text-white/60 hover:bg-white/10"
          title="Fit to View"
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
          </svg>
        </button>

        <button
          onClick={() => setShowGrid(!showGrid)}
          className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
            showGrid ? "bg-white/20 text-white" : "bg-black/40 text-white/40 hover:bg-white/10"
          }`}
          title="Toggle Grid"
        >
          <Grid3x3 className="w-4 h-4" />
        </button>

        {/* Flip Y: only relevant for 3DGS scenes where the exporter used a
            Y-down convention (postshot and a few others). Toggling at
            runtime just flips the splat mesh's scale.y between +1 and -1
            so the user can recover an upright scene without re-loading. */}
        {gsProgress === null && gsError === null && gsSplatViewerRef.current && (
          <button
            onClick={() => {
              setGsFlipY((v) => {
                const next = !v;
                const viewer: any = gsSplatViewerRef.current as any;
                const mesh = viewer?.splatMesh;
                if (mesh) mesh.scale.y = next ? -1 : 1;
                return next;
              });
            }}
            className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
              gsFlipY ? "bg-white/20 text-white" : "bg-black/40 text-white/40 hover:bg-white/10"
            }`}
            title="Flip Y axis (for Y-down 3DGS exporters)"
          >
            <FlipVertical2 className="w-4 h-4" />
          </button>
        )}

        {animationInfo && (
          <button
            onClick={toggleSkeleton}
            className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
              showSkeleton ? "bg-white/20 text-white" : "bg-black/40 text-white/60 hover:bg-white/10"
            }`}
            title="Toggle Skeleton"
          >
            <Bone className="w-4 h-4" />
          </button>
        )}

        <div className="w-px h-6 bg-white/20 mx-1 self-center" />

        <button
          onClick={() => setIsFocusView(!isFocusView)}
          className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
            isFocusView ? "bg-white/20 text-white" : "bg-black/40 text-white/60 hover:bg-white/10"
          }`}
          title="Focus View"
        >
          <MonitorPlay className="w-4 h-4" />
        </button>

        <button
          onClick={handleFullscreen}
          className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
            isFullscreen ? "bg-white/20 text-white" : "bg-black/40 text-white/60 hover:bg-white/10"
          }`}
          title="Full Screen"
        >
          <Maximize className="w-4 h-4" />
        </button>
        </div>

      {uvCheckerNotice && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 bg-amber-500/90 text-black px-3 py-1.5 rounded shadow-lg">
          <AlertCircle className="w-4 h-4" />
          <span className="text-xs font-medium">{uvCheckerNotice}</span>
        </div>
      )}

      {showUVChecker && (
        <>
          <div className="absolute top-14 left-2 z-30 flex items-center gap-1 bg-emerald-500/90 text-black px-2 py-1 rounded text-[10px] font-mono font-medium">
            <Grid3x3 className="w-3 h-3" />
            UV Checker · {uvCheckerScale}x
          </div>
          <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 bg-black/70 text-white px-3 py-2 rounded-md shadow-lg backdrop-blur-sm">
            <span className="text-[10px] font-mono uppercase tracking-wide text-white/70">UV</span>
            <span className="text-[10px] font-mono w-10 text-right text-white/90">{uvCheckerScale}x</span>
            <span className="text-[10px] font-mono text-white/50">4</span>
            <input
              type="range"
              min={4}
              max={16}
              step={1}
              value={uvCheckerScale}
              onChange={(e) => setUvCheckerScale(Number(e.target.value))}
              className="w-44 accent-emerald-400 cursor-pointer"
              aria-label="UV checker scale"
            />
            <span className="text-[10px] font-mono text-white/50">16</span>
          </div>
        </>
      )}

      <div ref={containerRef} className="relative z-10 w-full h-full" />

      {/* Bottom animation toolbar — shared for ABC and FBX animations.
          Timeline scrubbing unit: ABC timeline (when FPS is known from
          uniform sampling) shows frames; everything else falls back to
          seconds. The internal state (abcCurrentTime / fbxCurrentTime)
          stays in seconds because seekGeometry() / mixer.update() consume
          seconds — the slider's min/max/step + labels switch unit, and
          onChange converts the slider value back to seconds. */}
      {(abcTimeRange || fbxTimeRange) && (() => {
        const abcUseFrames = abcTimeRange != null && abcFps > 0;
        const abcFrameMin = abcTimeRange ? Math.round(abcTimeRange[0] * abcFps) : 0;
        const abcFrameMax = abcTimeRange ? Math.round(abcTimeRange[1] * abcFps) : 0;
        const abcFrameCurrent = abcUseFrames ? Math.round(abcCurrentTime * abcFps) : abcCurrentTime;
        const abcSliderStep = abcUseFrames ? 1 : 0.01;
        const abcFrameToTime = (frameOrTime: number) =>
          abcUseFrames ? frameOrTime / abcFps : frameOrTime;

        return (
        <div
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 backdrop-blur rounded-lg px-3 py-2 shadow-lg"
          style={{ backgroundColor: 'var(--surface-bg)', color: 'var(--timeline-fg)' }}
        >
          <button
            onClick={isAnimating ? pauseAnimation : playAnimation}
            className="w-9 h-9 rounded flex items-center justify-center transition-colors hover:opacity-80"
            style={{ backgroundColor: 'var(--timeline-btn-bg)' }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--timeline-btn-bg-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--timeline-btn-bg)'; }}
            title={isAnimating ? "Pause Animation" : "Play Animation"}
          >
            {isAnimating ? <Pause className="w-4 h-4" style={{ color: 'var(--timeline-fg)' }} /> : <Play className="w-4 h-4" style={{ color: 'var(--timeline-fg)' }} />}
          </button>
          <button
            onClick={resetAnimation}
            className="w-9 h-9 rounded flex items-center justify-center transition-colors hover:opacity-80"
            style={{ backgroundColor: 'var(--timeline-btn-bg)', opacity: 0.8 }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--timeline-btn-bg-hover)'; e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--timeline-btn-bg)'; e.currentTarget.style.opacity = '0.8'; }}
            title="Reset Animation"
          >
            <RotateCcw className="w-4 h-4" style={{ color: 'var(--timeline-fg)' }} />
          </button>
          <div className="w-px h-6 mx-1" style={{ backgroundColor: 'var(--timeline-divider)' }} />
          {/* ABC time scrubber */}
          {abcTimeRange && (
            <>
              <span className="text-[10px] font-mono w-14 text-right tabular-nums" style={{ color: 'var(--timeline-fg)' }}>
                {abcUseFrames
                  ? `frame ${abcFrameCurrent}`
                  : `${abcCurrentTime.toFixed(2)}s`}
              </span>
              <input
                type="range"
                min={abcFrameMin}
                max={abcFrameMax}
                step={abcSliderStep}
                value={abcFrameCurrent}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  const t = abcFrameToTime(v);
                  setAbcCurrentTime(t);
                  if (abcAnimRef.current) {
                    abcAnimRef.current.seekGeometry(t);
                  }
                }}
                className="w-48 h-1.5 appearance-none rounded cursor-pointer"
                style={{ accentColor: 'var(--accent-from-user, currentColor)', backgroundColor: 'var(--timeline-track)' }}
              />
              <span className="text-[10px] font-mono w-14 tabular-nums" style={{ color: 'var(--timeline-fg-muted)' }}>
                {abcUseFrames
                  ? `frame ${abcFrameMax}`
                  : `${abcTimeRange[1].toFixed(2)}s`}
              </span>
              <div className="w-px h-6 mx-1" style={{ backgroundColor: 'var(--timeline-divider)' }} />
              {/* FPS + frame count for Alembic. fps=0 means acyclic/unknown
                  sampling; the UI shows "fps: No Data" instead of a made-up
                  number. frameCount=0 means the archive has no animation. */}
              <span className="text-[10px] font-mono w-14 tabular-nums whitespace-nowrap" style={{ color: 'var(--timeline-fg)' }}>
                {abcFps > 0 ? `${abcFps.toFixed(2)} fps` : "fps: No Data"}
              </span>
              <span className="text-[10px] font-mono tabular-nums whitespace-nowrap" style={{ color: 'var(--timeline-fg-muted)' }}>
                {abcFrameCount > 0 ? `${abcFrameCount} frames` : "— frames"}
              </span>
            </>
          )}
          {/* FBX/GLTF time scrubber */}
          {fbxTimeRange && !abcTimeRange && (
            <>
              <span className="text-[10px] font-mono w-10 text-right tabular-nums" style={{ color: 'var(--timeline-fg)' }}>
                {fbxCurrentTime.toFixed(2)}
              </span>
              <input
                type="range"
                min={fbxTimeRange[0]}
                max={fbxTimeRange[1]}
                step={0.01}
                value={fbxCurrentTime}
                onChange={(e) => {
                  // Only scrub when animation is paused
                  if (!isAnimPlayingRef.current && mixerRef.current) {
                    const t = parseFloat(e.target.value);
                    setFbxCurrentTime(t);
                    const actions = mixerRef.current._actions;
                    if (actions && actions.length > 0) {
                      const action = actions[0] as any;
                      action.time = t;
                      mixerRef.current.update(0);
                    }
                  }
                }}
                onMouseDown={() => {
                  // Stop animation and pause for scrubbing
                  isAnimPlayingRef.current = false;
                  setIsAnimating(false);
                  if (mixerRef.current) {
                    const actions = mixerRef.current._actions;
                    if (actions && actions.length > 0) {
                      (actions[0] as any).paused = true;
                    }
                  }
                }}
                onMouseUp={() => {
                  // Keep paused - user presses Play to resume from this point
                }}
                className="w-48 h-1.5 appearance-none rounded cursor-pointer"
                style={{ accentColor: 'var(--accent-from-user, currentColor)', backgroundColor: 'var(--timeline-track)' }}
              />
              <span className="text-[10px] font-mono w-10 tabular-nums" style={{ color: 'var(--timeline-fg-muted)' }}>
                {fbxTimeRange[1].toFixed(2)}
              </span>
              <div className="w-px h-6 mx-1" style={{ backgroundColor: 'var(--timeline-divider)' }} />
              {/* FPS + frame count for FBX/GLTF. FBX with GlobalSettings.FrameRate
                  shows the authoritative number; GLTF (no FPS metadata) shows
                  "fps: No Data" and the frame count is the largest
                  track.times.length — marked "key frames" because it's a
                  sparse estimate (not all frames have keyframes). */}
              <span className="text-[10px] font-mono tabular-nums whitespace-nowrap" style={{ color: 'var(--timeline-fg)' }}>
                {fbxFps > 0 ? `${fbxFps.toFixed(2)} fps` : "fps: No Data"}
              </span>
              <span className="text-[10px] font-mono tabular-nums whitespace-nowrap" style={{ color: 'var(--timeline-fg-muted)' }}>
                {fbxFrameCount > 0
                  ? `${fbxFrameCount} ${fbxFrameCountKindRef.current === "keyFrames" ? "key frames" : "frames"}`
                  : "— frames"}
              </span>
            </>
          )}
          {animationInfo && (
            <>
              <div className="w-px h-6 mx-1" style={{ backgroundColor: 'var(--timeline-divider)' }} />
              <span className="text-[10px] font-mono text-amber-400">{animationInfo.clipName}</span>
            </>
          )}
        </div>
        );
      })()}

      <ModelLoadingProgress
        visible={!!gsProgress}
        label={gsProgress?.label ?? ""}
        percent={gsProgress?.percent ?? 0}
        icon="gs"
        etaSeconds={gsProgress?.etaSeconds}
        accentColor={accentColor}
        description={gsProgress ? (
          <span>
            {t(
              "File PLY đang được nén sang định dạng .ksplat trong bộ nhớ để tăng tốc độ hiển thị. Thời gian xử lý phụ thuộc vào số lượng splats và cấu hình máy.",
              "The PLY file is being compressed into the .ksplat format in memory for faster rendering. Processing time depends on the number of splats and your machine's specs.",
            )}
          </span>
        ) : undefined}
      />

      {gsError && !gsProgress && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70">
          <div className="text-center p-4 max-w-md">
            <p className="text-red-400 text-sm mb-2">{gsError}</p>
            <p className="text-white/60 text-xs">
              {t(
                "File PLY này được nhận diện là 3D Gaussian Splatting nhưng không load được. Hãy thử convert sang .ksplat trước bằng công cụ khác.",
                "This PLY file is recognized as 3D Gaussian Splatting but failed to load. Try converting to .ksplat first using an external tool.",
              )}
            </p>
            <button
              onClick={() => {
                setGsError(null);
                setError(null);
                gsCancelRef.current.cancelled = false;
              }}
              className="mt-4 px-4 py-1.5 rounded bg-white/10 hover:bg-white/20 text-white text-xs"
            >
              {t("Đóng", "Close")}
            </button>
          </div>
        </div>
      )}

      <ModelLoadingProgress
        visible={loading && !gsProgress && !gsError}
        label={loadingProgress}
        percent={loadingPercent}
        icon="3d"
        accentColor={accentColor}
      />

      {error && !gsError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70">
          <div className="text-center p-4">
            <p className="text-red-400 text-sm mb-2">{error}</p>
            <p className="text-white/60 text-xs">
              Supported formats: GLB, GLTF, OBJ, FBX, STL, PLY, SPZ
            </p>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}
