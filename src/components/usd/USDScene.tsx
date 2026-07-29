// USDScene: a self-contained USD/USDZ renderer that mounts inside the same
// React tree as 3DModelViewer.
//
// Design decisions:
//
// 1. **"Dumb renderer" — no UI.** All toolbar/timeline/focus-view/Escape
//    state lives in the host shell (3DModelViewer). This component only owns
//    the WebGL canvas, the Three.js scene, the Hydra WASM driver, the
//    animation loop, and the workplane (grid + XYZ axis helpers). The host
//    drives it through an imperative handle (USDViewerHandle).
//
//    Why: prior revisions had USDScene rendering its own toolbar +
//    timeline. That diverged structurally from the rest of the 3D viewer
//    shell (different DOM tree, different absolute-positioning, different
//    shell layout) and produced resize-distort and icon-mismatch bugs that
//    could only be fixed by mirroring the shell's DOM in both places.
//
// 2. Uses @needle-tools/usd's createThreeHydra helper. This bypasses the
//    OpenLegged viewer entirely and gives us:
//      - the OpenUSD Hydra driver running in WASM (no build step)
//      - Three.js meshes produced by ThreeJsRenderDelegate into our scene
//      - automatic animation (autoPlay) with setTime() / setPlaying() controls
//
// 3. The MaterialX WASM emits the texture-coordinate input as `i_geomprop_st`
//    (Hydra's `st` primvar). To make Three.js bind it to our geometry UV,
//    the onBeforeCompile hook installed in the init effect patches every
//    MaterialX shader:
//      - rewrite `i_geomprop_st` to `uv` so it links to Three.js's
//        auto-prepended `attribute vec2 uv;` declaration,
//      - drop the WASM's `uv = uv;` self-assign (writes a read-only `in`),
//      - strip the WASM's `in`/`attribute` declarations so they don't
//        redeclare it against Three.js's auto-prepend,
//      - rename the WASM's UV varying to a unique token so it links across
//        stages without colliding with Three.js's auto-prepended `attribute uv`,
//      - and as a safety net, inject `_usd_geomprop_v_io = uv;` at the bottom
//        of vertex main() when no body line writes the renamed varying
//        (otherwise the fragment reads garbage → gray ball).
//
//    We only patch MaterialX-generated shaders — every global hook on
//    `ShaderMaterial.prototype.onBeforeCompile` needs an "is this ours?"
//    guard, otherwise we mangle unrelated Three.js helpers (PMREM equirect
//    shader being the worst offender).
//
//    See docs/USD-LESSONS-LEARNED.md sections 3.3, 3.4, 3.5, 9 for the
//    historical context that produced these regex passes.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ViewportGizmo } from "three-viewport-gizmo";
import { AlertCircle } from "lucide-react";
import { loadUsdIntoScene, type UsdLoadResult } from "./USDWasmBridge";
import type { NeedleThreeHydraHandle } from "@needle-tools/usd";

const TOKEN_IO = "_usd_geomprop_v_io";

/**
 * Imperative surface the host shell (3DModelViewer) drives. The renderer
 * does NOT manage focus view, fullscreen, toolbar layout, or the timeline
 * scrubber — the shell does, and calls into this handle to mutate the
 * underlying Three.js / Hydra state.
 */
export interface USDViewerHandle {
  /** Refit the camera so the loaded USD model fits the viewport. */
  fitToScene(): void;
  /** Show or hide the workplane (XZ grid plane + GridHelper + XYZ axes). */
  setShowWorkplane(show: boolean): void;
  /** Resume Hydra animation playback. No-op if already playing. */
  play(): void;
  /** Pause Hydra animation playback. No-op if already paused. */
  pause(): void;
  /** Toggle play/pause. */
  togglePlay(): void;
  /** Seek the Hydra stage to the given timecode (frames). */
  seek(time: number): Promise<void>;
  /** Reset to the metadata start timecode (mirrors 3DModelViewer "Reset"). */
  reset(): Promise<void>;
  /**
   * Resize the WebGL canvas to (w, h). Called by the host shell whenever
   * the wrapper changes size (focus toggle, fullscreen toggle, drag-resize
   * of the detail pane, window resize).
   */
  resize(w: number, h: number): void;
  /** Get the current playhead timecode (frames). */
  getCurrentTime(): number;
  /** Get the stage's time range, or null if not loaded yet. */
  getTimeRange(): { start: number; end: number; fps: number } | null;
  /** Whether the stage is currently playing. */
  getIsPlaying(): boolean;
  /** Subscribe to playhead time updates. Returns an unsubscribe fn. */
  onTimeUpdate(cb: (time: number) => void): () => void;
  /** Subscribe to play/pause state changes. Returns an unsubscribe fn. */
  onPlayStateChange(cb: (playing: boolean) => void): () => void;
}

interface USDSceneProps {
  filePath: string;
  fileName?: string;
  accentColor: string;
}

function isMaterialXShader(
  uniforms: Record<string, unknown> | undefined,
  vsSrc: string,
  fsSrc: string,
): boolean {
  if (
    /i_geomprop_st|_usd_geomprop/.test(vsSrc + "\n" + fsSrc) ||
    /mtlx(World|View|Proj|WorldTranspose)Matrix/.test(vsSrc + "\n" + fsSrc)
  ) {
    return true;
  }
  return !!uniforms && Object.keys(uniforms).some((k) => k.startsWith("mtlx_"));
}

function renameShader(src: string, kind: "vertex" | "fragment"): string {
  let renamed = src;
  renamed = renamed.replace(/\bi_geomprop_st\b/g, "uv");
  renamed = renamed.replace(/\buv\s*=\s*uv\s*;/g, "");
  if (kind === "vertex") {
    renamed = renamed
      .split(/\r?\n/)
      .filter((line) => {
        const probe = line.replace(/\r$/, "").trim().replace(/;.*$/, ";");
        return !/^\s*(attribute|in)\s+(?:(?:highp|mediump|lowp|flat|smooth|noperspective|centroid|sample)\s+)*vec[234]\s+uv\s*;\s*$/.test(
          probe,
        );
      })
      .join("\n");
  }
  if (kind === "vertex") {
    renamed = renamed.replace(/(\bout\b[^;]*\b)uv\s*;/g, `$1${TOKEN_IO};`);
    renamed = renamed.replace(/\buv\s*(=)([^=])/g, `${TOKEN_IO} $1$2`);
  } else {
    renamed = renamed.replace(/(\bin\b[^;]*\b)uv\s*;/g, `$1${TOKEN_IO};`);
    renamed = renamed.replace(/\buv\b/g, TOKEN_IO);
  }
  if (kind === "vertex" && !/_usd_geomprop_v_io\s*=/.test(renamed)) {
    const mainOpen = renamed.search(/\bvoid\s+main\s*\(\s*\)\s*\{\s*[\r\n]/);
    let insertAt = -1;
    if (mainOpen >= 0) {
      let depth = 0;
      for (let i = mainOpen; i < renamed.length; i++) {
        const c = renamed[i];
        if (c === "{") depth++;
        else if (c === "}" && --depth === 0) {
          insertAt = renamed.lastIndexOf("\n", i - 1) + 1;
          break;
        }
      }
    }
    if (insertAt < 0) insertAt = renamed.length;
    renamed =
      renamed.slice(0, insertAt) +
      `    ${TOKEN_IO} = uv;\n` +
      renamed.slice(insertAt);
  }
  return renamed;
}

const USDScene = forwardRef<USDViewerHandle, USDSceneProps>(function USDScene(
  { filePath, fileName },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const gizmoRef = useRef<ViewportGizmo | null>(null);
  const animFrameRef = useRef<number>(0);
  const hydraHandleRef = useRef<NeedleThreeHydraHandle | null>(null);
  const disposeUSDRef = useRef<(() => Promise<void>) | null>(null);

  // Workplane visibility flag is now a no-op in USDScene (the host shell
  // owns the visual workplane) but kept so the imperative API signature
  // stays stable. Same goes for the original `grid*`/`axis*` refs — they
  // remain so we don't churn the typing in `useImperativeHandle` if a
  // future helper wants to share state. They're not assigned anywhere
  // now since we deleted the scene-local workplane setup.
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const gridPlaneRef = useRef<THREE.Mesh | null>(null);
  const gridShaderMaterialRef = useRef<THREE.ShaderMaterial | null>(null);
  const axisXRef = useRef<THREE.Line | null>(null);
  const axisZRef = useRef<THREE.Line | null>(null);
// (Y axis intentionally omitted — see workplane setup above.)
// Workplane visibility flag: USDScene owns the visible workplane (it's the
// scene's only Three.js renderer), so the default here mirrors "show".
  const workplaneVisibleRef = useRef(true);

  // Internal animation state. The host subscribes to updates via the
  // imperative handle (onTimeUpdate / onPlayStateChange callbacks).
  const [loading, setLoading] = useState(true);
  const [loadingLabel, setLoadingLabel] = useState("Initializing USD...");
  const [error, setError] = useState<string | null>(null);

  const isAnimPlayingRef = useRef(true);
  const metadataRef = useRef<UsdLoadResult["metadata"] | null>(null);
  const currentTimeRef = useRef(0);

  // Subscriber lists for the imperative API. Plain Set<callback> keeps the
  // imperative handle O(1) per emission and avoids stale-closure issues.
  const timeSubsRef = useRef<Set<(t: number) => void>>(new Set());
  const playSubsRef = useRef<Set<(p: boolean) => void>>(new Set());

  // Holds the deferred-fit handle from the load effect so we can cancel
  // it on teardown if the file swaps mid-flight.
  const pendingFitCleanupRef = useRef<(() => void) | null>(null);

  // Mount: create renderer + scene + camera + controls + gizmo + workplane.
  // Done once; subsequent file changes only swap the USD stage.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let mounted = true;

    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x3f3f3f);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(3, 3, 3);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    // On shader compile failure, stash the full source on window so the dev
    // can inspect it from DevTools. We don't dump to console here — the
    // routine `renameShader` above has its own per-stage log on success.
    renderer.debug.onShaderError = (gl, program, glVertexShader, glFragmentShader) => {
      const dump = [
        "=== VERTEX INFO LOG ===",
        gl.getShaderInfoLog(glVertexShader) ?? "",
        "=== FRAGMENT INFO LOG ===",
        gl.getShaderInfoLog(glFragmentShader) ?? "",
        "=== PROGRAM INFO LOG ===",
        gl.getProgramInfoLog(program) ?? "",
        "=== VERTEX SOURCE ===",
        gl.getShaderSource(glVertexShader) || "",
        "=== FRAGMENT SOURCE ===",
        gl.getShaderSource(glFragmentShader) || "",
      ].join("\n\n");
      try {
        localStorage.setItem("__usdShaderDump", dump);
      } catch {
        /* quota / private mode — ignore */
      }
      (window as unknown as { __usdShaderDump?: string }).__usdShaderDump = dump;
      console.warn("[USDScene] Shader compile failed — full source at window.__usdShaderDump");
    };
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Install MaterialX shader patch hook. Guarded so we only touch MaterialX
    // shaders (any other shader passing through this hook gets ignored),
    // otherwise we mangle PMREM equirect and other helpers.
    const baseOnBeforeCompile = (THREE.ShaderMaterial.prototype as any)
      .onBeforeCompile;
    (THREE.ShaderMaterial.prototype as any).onBeforeCompile = function (
      shader: any,
      rendererArg: any,
    ) {
      try {
        const vs = shader?.vertexShader ?? "";
        const fs = shader?.fragmentShader ?? "";
        if (isMaterialXShader(shader?.uniforms, vs, fs)) {
          if (vs) shader.vertexShader = renameShader(vs, "vertex");
          if (fs) shader.fragmentShader = renameShader(fs, "fragment");
        }
      } catch (err) {
        console.warn("[USDScene] Shader repair pass failed:", err);
      }
      if (typeof baseOnBeforeCompile === "function") {
        return baseOnBeforeCompile.call(this, shader, rendererArg);
      }
      return undefined;
    };

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    // Keep minDistance below the typical fit distance (~0.4–2 units). The
    // USD bbox is normalized to ~2.5 units but tiny units (e.g. cm) produce
    // a fit distance of ~0.4 — anything > that snaps the camera outward on
    // the first OrbitControls.update() and visually "shrinks" the model.
    controls.minDistance = 0.01;
    controls.maxDistance = 1000;
    controlsRef.current = controls;

    // Lighting matches 3DModelViewer's main scene so USD meshes look identical
    // to GLB/FBX models. AmbientLight is included to match the OpenLegged
    // baseline; MaterialX simply skips it with an "Unsupported light type"
    // warning because it only knows about DirectionalLight / PointLight /
    // SpotLight. The remaining DirectionalLights still drive the MaterialX
    // shaders correctly.
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(5, 10, 7);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xe6f0ff, 0.6);
    fill.position.set(-6, 4, -4);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.5);
    rim.position.set(0, -2, -8);
    scene.add(rim);

    // --- Workplane: grid plane + GridHelper + XYZ axis helpers ---
    // Note: these are kept in the scene graph (with `visible = false`) only
    // to preserve the original render setup. USDScene does not draw them
    // — the host shell (3DModelViewer) renders the shared workplane/axes
    // overlay, so a second visible workplane here would just double-stack
    // and blur the view. Kept-hidden objects aren't picked up by
    // `fitCameraToScene`'s `isMesh` traversal either, but we additionally
    // tag them with `__usdWorkplane = true` as a defence-in-depth so any
    // future helper (raycasting, fit, selection) can opt out trivially.
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
    gridShaderMaterialRef.current = gridShaderMaterial;
    const gridPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(gridSize, gridSize),
      gridShaderMaterial,
    );
    gridPlane.rotation.x = -Math.PI / 2;
    gridPlane.position.y = -0.01;
    gridPlane.userData.__usdWorkplane = true;
    scene.add(gridPlane);
    gridPlaneRef.current = gridPlane;
    const gridLines = new THREE.GridHelper(gridSize, gridDivisions, 0x707070, 0x505050);
    gridLines.position.y = -0.01;
    gridLines.material.transparent = true;
    gridLines.material.opacity = 0.6;
    (gridLines as any).userData.__usdWorkplane = true;
    scene.add(gridLines);
    gridRef.current = gridLines as any;

    // X (red) and Z (blue) axis lines only — the Y axis is omitted to match
// 3DModelViewer's workplane, which keeps the floor uncluttered and lets
// the grid do the depth cueing. ViewportGizmo in the corner still gives
// users a way to read the up direction.
    const lineLength = 100;
    const axisMatX = new THREE.LineBasicMaterial({ color: 0xff5365, transparent: true, opacity: 0.9 });
    const axisMatZ = new THREE.LineBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.9 });
    const xAxis = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-lineLength / 2, 0.001, 0.0),
        new THREE.Vector3(lineLength / 2, 0.001, 0.0),
      ]),
      axisMatX,
    );
    xAxis.renderOrder = -1;
    (xAxis as any).userData.__usdWorkplane = true;
    scene.add(xAxis);
    axisXRef.current = xAxis;
    const zAxis = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0.0, 0.001, -lineLength / 2),
        new THREE.Vector3(0.0, 0.001, lineLength / 2),
      ]),
      axisMatZ,
    );
    zAxis.renderOrder = -1;
    (zAxis as any).userData.__usdWorkplane = true;
    scene.add(zAxis);
    axisZRef.current = zAxis;

    const gizmo = new ViewportGizmo(camera, renderer, {
      container,
      placement: "top-right",
      size: 96,
      offset: { top: 10, right: 10 },
    });
    gizmoRef.current = gizmo;
    gizmo.attachControls(controls);

    // Render loop. The hydra handle's update() advances stage time only when
    // playing; we still need to render every frame so OrbitControls + Gizmo
    // animate smoothly.
    let lastTimeMs = performance.now();
    function animate() {
      if (!mounted) return;
      animFrameRef.current = requestAnimationFrame(animate);
      const nowMs = performance.now();
      const deltaSec = Math.min((nowMs - lastTimeMs) / 1000, 0.1);
      lastTimeMs = nowMs;

      const handle = hydraHandleRef.current;
      if (handle) {
        // Always advance the Hydra driver so it stays in sync — but only
        // forward timecodes to the host subscribers when playing. Mirrors
        // 3DModelViewer's `mixerRef.current.update(deltaSec)` +
        // `setFbxCurrentTime` rhythm.
        handle.update(deltaSec);
        if (isAnimPlayingRef.current) {
          const t = handle.getTime();
          if (isFinite(t)) {
            currentTimeRef.current = t;
            for (const cb of timeSubsRef.current) cb(t);
          }
        }
      }

      controlsRef.current?.update();
      injectMissingUVs(sceneRef.current);
      if (sceneRef.current && cameraRef.current) {
        if (gridShaderMaterialRef.current) {
          gridShaderMaterialRef.current.uniforms.uCameraPos.value.copy(cameraRef.current.position);
        }
        rendererRef.current?.render(sceneRef.current, cameraRef.current);
      }
      gizmoRef.current?.render();
    }
    animate();

    // ResizeObserver: container size is the source of truth (CSS-driven,
    // not host-driven). focus/fullscreen change the shell's className which
    // changes the container's actual size; RO fires when that's stable.
    // This handles the case where the host's useEffect runs before the CSS
    // settle (size races) or fires from a stale ref.
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        if (w === 0 || h === 0) continue;
        const r = rendererRef.current;
        const c = cameraRef.current;
        if (r && c) {
          c.aspect = w / h;
          c.updateProjectionMatrix();
          // updateStyle=true: RO can fire AFTER the host's resize() call
          // (e.g. when the wrapper finishes its CSS transition), and we
          // need to keep the canvas's CSS box in sync with the
          // drawingBuffer. Without this, a later RO callback would leave
          // the canvas's inline width/height at the OLD size while the
          // drawingBuffer is the NEW size — the browser then stretches the
          // small frame onto the large CSS box and the model "warps" /
          // appears squashed in a corner of the viewport.
          r.setSize(w, h);
          // see resize() above for why this matters
          gizmoRef.current?.update();
        }
      }
    });
    ro.observe(container);

    return () => {
      mounted = false;
      ro.disconnect();
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      gizmoRef.current?.detachControls();
      gizmoRef.current?.dispose();
      if (container && renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
      pendingFitCleanupRef.current?.();
      pendingFitCleanupRef.current = null;
      // Restore the original prototype hook so a subsequent USDScene
      // (e.g. after file change in the same tab) doesn't double-patch.
      (THREE.ShaderMaterial.prototype as any).onBeforeCompile =
        baseOnBeforeCompile;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // File change: tear down previous USD stage, load the new one.
  useEffect(() => {
    if (!filePath || !sceneRef.current) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLoadingLabel("Downloading USD WASM runtime...");
    // Reset timeline/handle state so subscribers don't briefly display
    // the previous file's timecodes between file swaps.
    metadataRef.current = null;
    hydraHandleRef.current = null;
    currentTimeRef.current = 0;
    for (const cb of timeSubsRef.current) cb(0);
    for (const cb of playSubsRef.current) cb(true);

    (async () => {
      try {
        // Drop previous stage if any. createThreeHydra populates the scene
        // by adding a child group; we remove that group ourselves because
        // some dispose() paths skip the scene graph walk (especially when
        // the previous load was cancelled mid-flight and the handle was
        // never fully hydrated). We also clear every mesh's
        // `__usdUVChecked` flag so the spherical-UV fallback can re-run
        // for the new geometry.
        if (disposeUSDRef.current) {
          await disposeUSDRef.current().catch(() => {
            /* best-effort; proceed to clear refs even if dispose threw */
          });
          disposeUSDRef.current = null;
          hydraHandleRef.current = null;
        }
        const scene = sceneRef.current!;
        for (let i = scene.children.length - 1; i >= 0; i--) {
          const child = scene.children[i] as THREE.Object3D & {
            __usdHydraRoot?: boolean;
          };
          if (child.__usdHydraRoot) {
            scene.remove(child);
            child.traverse((obj) => {
              if ((obj as THREE.Mesh).isMesh) {
                const mesh = obj as THREE.Mesh & { __usdUVChecked?: boolean };
                delete mesh.__usdUVChecked;
                mesh.geometry?.dispose?.();
                const mat = mesh.material as
                  | THREE.Material
                  | THREE.Material[]
                  | undefined;
                if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
                else mat?.dispose?.();
              }
            });
          }
        }

        setLoadingLabel("Reading USD stage...");

        // Snapshot existing direct children so we can identify which ones
        // the Hydra delegate adds below — otherwise we'd later mark our
        // workplane helpers (grid plane, axes) as USD roots and their
        // 200-unit bbox would dominate the normalize-bbox math, scaling
        // the actual USD stage down to a dot.
        const childrenBeforeLoad = new Set(scene.children);

        const result = await loadUsdIntoScene({
          scene,
          filePath,
          onDownloadProgress: (loaded, total) => {
            if (cancelled) return;
            const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
            setLoadingLabel(`Downloading USD runtime... ${pct}%`);
          },
          autoPlay: true,
        });

        if (cancelled) {
          await result.handle.dispose().catch(() => {});
          return;
        }

        // Mark only the direct children the Hydra delegate added (compared
        // against the snapshot we took before loadUsdIntoScene). Marking
        // every child — workplane helpers included — was the bug that made
        // the grid plane's 200-unit bbox dominate and shrink the model.
        for (const child of scene.children) {
          if (!childrenBeforeLoad.has(child)) {
            (child as THREE.Object3D & { __usdHydraRoot?: boolean }).__usdHydraRoot = true;
          }
        }

        // Normalize model scale so very small (cm) or very large (km) USD stages
        // all sit comfortably inside the viewport. Mirrors 3DModelViewer's
        // 2.5-unit target box. We compute the bbox across every Hydra-owned
        // mesh, then apply scale + center to each Hydra root group so
        // animation/skinning updates continue to drive world matrices
        // correctly. Force-update world matrices first — by this point
        // the delegate has just populated the meshes and Box3 would
        // otherwise read identity transforms.
        {
          scene.updateMatrixWorld(true);
          const box = new THREE.Box3();
          let hasGeom = false;
          for (const root of scene.children) {
            if (!(root as THREE.Object3D & { __usdHydraRoot?: boolean }).__usdHydraRoot) continue;
            root.updateMatrixWorld(true);
            const childBox = new THREE.Box3().setFromObject(root);
            if (!isFinite(childBox.min.x) || !isFinite(childBox.max.x)) continue;
            box.union(childBox);
            hasGeom = true;
          }
          if (hasGeom) {
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            const TARGET = 2.5;
            if (maxDim > 0 && isFinite(maxDim)) {
              const scale = TARGET / maxDim;
              const center = box.getCenter(new THREE.Vector3());
              for (const root of scene.children) {
                if (!(root as THREE.Object3D & { __usdHydraRoot?: boolean }).__usdHydraRoot) continue;
                root.position.x = -center.x;
                root.position.y = -box.min.y;
                root.position.z = -center.z;
                root.scale.setScalar(scale);
                root.updateMatrixWorld(true);
              }
            }
          }
        }

        hydraHandleRef.current = result.handle;
        metadataRef.current = result.metadata;
        disposeUSDRef.current = () => result.handle.dispose();
        const animatable = result.metadata.endTimeCode > result.metadata.startTimeCode;
        isAnimPlayingRef.current = animatable;
        for (const cb of playSubsRef.current) cb(animatable);
        result.handle.setPlaying(animatable);

        await result.handle.ready().catch(() => {});
        if (cancelled) return;
        // First-fit immediately so the user sees something (the bbox read
        // here is "best-effort" — USD skinned meshes get their final world
        // matrices after a few animate() frames).
        fitCameraToScene(scene, cameraRef.current!, controlsRef.current!);
        // Defer a second fit by ~2 frames so the camera settles on the
        // animated/skinning-deformed extents rather than the unskinned
        // base. Without this, models with skinning (USD Skel) come out
        // tiny because the initial bbox reads identity.
        const raf2 = requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (cancelled) return;
            fitCameraToScene(scene, cameraRef.current!, controlsRef.current!);
          });
        });
        pendingFitCleanupRef.current = () => cancelAnimationFrame(raf2);
        setLoading(false);
      } catch (err: unknown) {
        if (cancelled) return;
        console.error("[USDScene] Failed to load USD file:", err);
        const errText =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : (() => {
                  try {
                    return JSON.stringify(err);
                  } catch {
                    return String(err);
                  }
                })();
        setError(errText);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      pendingFitCleanupRef.current?.();
      pendingFitCleanupRef.current = null;
    };
  }, [filePath]);

  // Imperative handle — host shell (3DModelViewer) drives the renderer
  // through this surface. All workplane, animation, and resize mutations
  // happen here.
  useImperativeHandle(
    ref,
    () => ({
      fitToScene: () => {
        const scene = sceneRef.current;
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        if (!scene || !camera || !controls) return;
        fitCameraToScene(scene, camera, controls);
      },
      setShowWorkplane: (show: boolean) => {
        workplaneVisibleRef.current = show;
        const v = show;
        if (gridRef.current) gridRef.current.visible = v;
        if (gridPlaneRef.current) gridPlaneRef.current.visible = v;
        if (axisXRef.current) axisXRef.current.visible = v;
        if (axisZRef.current) axisZRef.current.visible = v;
      },
      play: () => {
        const handle = hydraHandleRef.current;
        if (!handle) return;
        if (!isAnimPlayingRef.current) {
          isAnimPlayingRef.current = true;
          for (const cb of playSubsRef.current) cb(true);
          handle.setPlaying(true);
        }
      },
      pause: () => {
        const handle = hydraHandleRef.current;
        if (!handle) return;
        if (isAnimPlayingRef.current) {
          isAnimPlayingRef.current = false;
          for (const cb of playSubsRef.current) cb(false);
          handle.setPlaying(false);
        }
      },
      togglePlay: () => {
        const handle = hydraHandleRef.current;
        if (!handle) return;
        const next = !isAnimPlayingRef.current;
        isAnimPlayingRef.current = next;
        for (const cb of playSubsRef.current) cb(next);
        handle.setPlaying(next);
      },
      seek: async (time: number) => {
        const handle = hydraHandleRef.current;
        if (!handle) return;
        currentTimeRef.current = time;
        for (const cb of timeSubsRef.current) cb(time);
        await handle.setTime(time).catch(() => {});
      },
      reset: async () => {
        const handle = hydraHandleRef.current;
        const md = metadataRef.current;
        if (!handle || !md) return;
        currentTimeRef.current = md.startTimeCode;
        for (const cb of timeSubsRef.current) cb(md.startTimeCode);
        await handle.setTime(md.startTimeCode).catch(() => {});
      },
      resize: (w: number, h: number) => {
        const renderer = rendererRef.current;
        const camera = cameraRef.current;
        if (!renderer || !camera) return;
        if (w === 0 || h === 0) return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        // The gizmo caches its viewport + scissor at construction time
        // (see `domUpdate` in three-viewport-gizmo). After we resize the
        // renderer, those cached values go stale and gizmo.render() in the
        // animate loop will then `setViewport(...this._originalViewport)`
        // with the OLD size, leaving the main scene's viewport clipped to
        // the pre-resize rectangle — the model then visually "shrinks into
        // a corner" until the next resize happens.
        gizmoRef.current?.update();
        // Per the user's request, we do NOT re-fit on resize. The camera is
        // fit once after USD load. Focus / fullscreen are CSS layout changes
        // that grow the shell; the camera stays put and the user pans/zooms
        // themselves with OrbitControls. Only the projection matrix is
        // updated to match the new aspect ratio.
      },
      getCurrentTime: () => currentTimeRef.current,
      getTimeRange: () => {
        const md = metadataRef.current;
        if (!md) return null;
        return {
          start: md.startTimeCode,
          end: md.endTimeCode,
          fps: md.timeCodesPerSecond,
        };
      },
      getIsPlaying: () => isAnimPlayingRef.current,
      onTimeUpdate: (cb: (t: number) => void) => {
        timeSubsRef.current.add(cb);
        return () => {
          timeSubsRef.current.delete(cb);
        };
      },
      onPlayStateChange: (cb: (p: boolean) => void) => {
        playSubsRef.current.add(cb);
        return () => {
          playSubsRef.current.delete(cb);
        };
      },
    }),
    [],
  );

  return (
    <div className="relative w-full h-full">
      <div
        ref={containerRef}
        className="absolute inset-0"
        data-usd-canvas-root
      />

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 z-30 pointer-events-none">
          <div className="flex items-center gap-2 px-4 py-2 bg-black/70 rounded text-white text-xs">
            <div className="w-4 h-4 border-2 border-white/30 border-t-amber-400 rounded-full animate-spin" />
            <span>{loadingLabel}</span>
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-30">
          <div className="flex flex-col items-center gap-2 max-w-md px-4 py-3 bg-red-900/80 rounded text-white">
            <AlertCircle className="w-6 h-6" />
            <div className="text-sm font-medium">Failed to load USD file</div>
            <div className="text-xs text-white/80 break-words text-center">
              {error}
            </div>
            <div className="text-[10px] text-white/60 mt-1">{filePath}</div>
          </div>
        </div>
      )}
    </div>
  );
});

export default USDScene;

// Some USD meshes come out of Hydra without `uv` attributes (the
// needle-tools delegate doesn't always wire the `UVMap` primvar). Inject
// a spherical projection so the patched vertex shader has something to
// sample. We also publish the same buffer under `i_geomprop_st` so any
// pipeline that still references the legacy Hydra name binds correctly.
function injectMissingUVs(scene: THREE.Scene | null) {
  if (!scene) return;
  scene.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh & { __usdUVChecked?: boolean };
    if (mesh.__usdUVChecked) return;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom) return;
    mesh.__usdUVChecked = true;
    const attrs = Object.keys(geom.attributes || {});
    if (attrs.includes("uv") || attrs.includes("st")) return;
    const posAttr = geom.attributes.position as THREE.BufferAttribute | undefined;
    if (!posAttr || posAttr.count === 0) return;
    const positions = posAttr.array as ArrayLike<number>;
    const count = posAttr.count;
    const uvs = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      const r = Math.sqrt(x * x + y * y + z * z) || 1;
      uvs[i * 2] = Math.atan2(z, x) / (2 * Math.PI) + 0.5;
      uvs[i * 2 + 1] = Math.acos(Math.max(-1, Math.min(1, y / r))) / Math.PI;
    }
    const uvAttr = new THREE.BufferAttribute(uvs, 2);
    geom.setAttribute("i_geomprop_st", uvAttr);
    geom.setAttribute("uv", uvAttr);
  });
}

// Fit camera to scene extents. Mirrors 3DModelViewer's fitToView exactly so
// the framing matches what the rest of the app produces:
//   - Box3.setFromObject walks the world matrix, so it's robust to our
//     normalize-bbox (scale + recenter) step which moves every Hydra root.
//   - Camera sits at offset (dist, 0.6×dist, dist) from the target center,
//     so the model is centered and OrbitControls.target is the centroid.
//   - Adjust near/far based on the model extents so we don't clip faces
//     near the camera nor cut into infinity.
function fitCameraToScene(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
) {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  let hasContent = false;
  scene.traverse((obj) => {
    // Skip workplane helpers (grid plane, GridHelper, axis lines) — they're
    // 100–200 units wide and would otherwise dominate the bbox, scaling the
    // actual USD model down to a dot and parking the camera at +400 units.
    if ((obj as any).userData?.__usdWorkplane) return;
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.computeBoundingBox?.();
    if (!mesh.geometry?.boundingBox) return;
    const worldBox = new THREE.Box3().setFromObject(mesh);
    if (!isFinite(worldBox.min.x) || !isFinite(worldBox.max.x)) return;
    box.union(worldBox);
    hasContent = true;
  });
  if (!hasContent) return;
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const maxDim = Math.max(size.x, size.y, size.z);
  if (!isFinite(maxDim) || maxDim <= 0) return;
  const dist = maxDim * 2;
  // Match non-USD 3DModelViewer's fitToView: camera at (dist, 0.6×dist, dist)
  // from origin so framing is consistent regardless of where the model lives.
  camera.position.set(dist, dist * 0.6, dist);
  camera.near = Math.max(maxDim / 100, 0.001);
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}