/**
 * WabcLoader.ts — reads .abc (Alembic) files via the Emscripten-compiled
 * wabc (WebAlembicViewer) WASM module.
 *
 * The WASM binary lives at `/wasm/alembic/wabc.js` and is served by Vite
 * (copied from `wasm_src/build_wabc/` during `wasm_src/build.ps1 -Phase 3 -Vendor`).
 *
 * The C ABI entry points (all start with `wabc_`) are defined in
 * `wasm_src/src/wabc_js_binding.cpp`. They are wrappers around i-saint's
 * `wabc::SceneABC` (Alembic) loader, which supports:
 *   - Mesh: positions, face counts, face indices, expanded verts, wireframe
 *   - Points (particle clouds): positions
 *   - Cameras: position, direction, focal length, aperture, near/far, path
 *   - Time sampling: start/end time, seek to time
 *
 * Design notes
 * ─────────────
 * - wabc uses a MONOLITHIC mesh model: all geometry in the archive is merged
 *   into a single "m_mono_mesh" per sample.
 * - Animation is implemented as **seek → read → update geometry attributes**
 *   at runtime (matching i-saint's SceneABC::seekImpl exactly). We do NOT use
 *   Three.js morph targets — they have subtle initialization requirements
 *   that fail silently in some WebView/Three.js combinations. The seek-based
 *   approach is simpler, faster, and guaranteed to match the reference viewer.
 * - All WASM operations are synchronous on the wasm heap. Heap grows via
 *   ALLOW_MEMORY_GROWTH=1.
 * - Scratch buffers for big arrays (positions, indices) are allocated with
 *   `_malloc` (heap) so they survive across cwrap calls. Small stack-only
 *   buffers use `stackAlloc`.
 * - The C++ wabc `SceneABC` exposes C++ exceptions via `-fexceptions` +
 *   `getExceptionMessage` runtime method; the JS wrapper decodes them.
 */

import * as THREE from "three";

// ─── WASM singleton ────────────────────────────────────────────────────────────

interface WabcModule {
  cwrap: (name: string, returnType: string | null, argTypes: string[]) => (...args: unknown[]) => unknown;
  stackAlloc: (bytes: number) => number;
  stackSave: () => number;
  stackRestore: (sp: number) => void;
  getExceptionMessage: (e: unknown) => [number, number];
  decrementExceptionRefcount: (e: unknown) => void;
  _malloc: (bytes: number) => number;
  _free: (ptr: number) => void;
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  HEAP32: Int32Array;
  UTF8ToString?: (ptr: number) => string;
  // Emscripten's MEMFS API is exposed as discrete helper functions when
  // -s FORCE_FILESYSTEM=1 is set (mirrors i-saint's WebAlembicViewer flags).
  // The parent `FS` object itself is NOT exported by default; we use these
  // individual helpers instead. They sidestep the Emscripten TextDecoder-on-
  // resizable-buffer crash because file content is copied straight from the
  // Uint8Array argument into MEMFS — no JS↔WASM string boundary crossing.
  FS_createDataFile?: (
    parent: string,
    name: string,
    data: Uint8Array | number[],
    canRead: boolean,
    canWrite: boolean,
    canOwn: boolean,
  ) => void;
  FS_unlink?: (path: string) => void;
  FS_createPath?: (parent: string, name: string, canRead: boolean, canWrite: boolean) => void;
}

let wasmModule: WabcModule | null = null;
let wasmLoading: Promise<WabcModule> | null = null;

// ─── Safe WASM call wrapper ────────────────────────────────────────────────────
// Emscripten with -fexceptions surfaces C++ exceptions as raw values (pointers)
// or WebAssembly.Exception objects caught by JS try/catch. This helper restores
// the WASM stack pointer on exception to prevent leaks, then decodes the message
// using getExceptionMessage (exported by EXPORTED_RUNTIME_METHODS).
// Docs: https://emscripten.org/docs/porting/exceptions.html
function callWasm<T>(m: WabcModule, fn: () => T): T {
  const hasStackSave = typeof m.stackSave === "function";
  const sp = hasStackSave ? m.stackSave() : 0;
  try {
    return fn();
  } catch (e: unknown) {
    if (hasStackSave) m.stackRestore(sp);

    let message = "";
    if (typeof m.getExceptionMessage === "function") {
      try {
        const [typePtr, msgPtr] = m.getExceptionMessage(e);
        if (typeof m.decrementExceptionRefcount === "function") {
          m.decrementExceptionRefcount(e);
        }
        const type = typePtr && m.UTF8ToString ? m.UTF8ToString(typePtr) : String(typePtr);
        const msg = msgPtr && m.UTF8ToString ? m.UTF8ToString(msgPtr) : String(msgPtr);
        message = msg ? `${type}: ${msg}` : type;
      } catch {
        // e is not a C++ exception
      }
    }

    if (!message) {
      if (typeof e === "string") {
        message = e;
      } else if (typeof e === "number") {
        message = `WASM error code: ${e}`;
      } else if (e instanceof Error) {
        message = e.message || String(e);
      } else {
        message = String(e);
      }
    }

    console.error(`[wabc] C++ exception: ${message}`, e);
    throw new Error(message);
  }
}

/**
 * Load the wabc wasm module via a classic <script> tag.
 *
 * `wabc.js` is built with Emscripten's MODULARIZE=1 + EXPORT_NAME=WabcModule,
 * which emits an IIFE that, when evaluated, attaches the factory function to
 * `window.WabcModule`. We then call that factory with `{locateFile}` and
 * use the resulting instantiated module.
 *
 * ## TextDecoder / resizable ArrayBuffer workaround
 *
 * The wabc.wasm is built with `-s ALLOW_MEMORY_GROWTH=1`, so the heap is
 * a *resizable* `SharedArrayBuffer`-style backing. When C++ `std::fstream`
 * opens the .abc file, Emscripten routes through `__syscall_openat` which
 * in turn calls `getStr(pathPtr)` → `UTF8ToString(pathPtr)` →
 * `UTF8ArrayToString(HEAPU8, pathPtr)`. On long strings (>16 bytes —
 * our `/abc/<basename>.abc` path always exceeds that threshold) that
 * function takes the fast path:
 *   `UTF8Decoder.decode(HEAPU8.subarray(idx, endPtr))`
 *
 * `HEAPU8.subarray(...)` inherits `resizable=true` from the underlying
 * heap buffer, and modern browsers' `TextDecoder.decode()` rejects
 * resizable ArrayBuffers with:
 *   `The provided ArrayBuffer value must not be resizable`
 *
 * Upstream i-saint's WebAlembicViewer side-steps this entirely by using
 * Embind (which marshals strings through its own BindingType and never
 * touches `UTF8ArrayToString`). Our wabc was built with raw `cwrap`, not
 * Embind, so we hit this Emscripten regression.
 *
 * Strategy: before the script tag runs its IIFE, we fetch wabc.js as
 * text, replace the single line
 *   `var UTF8Decoder=globalThis.TextDecoder&&new TextDecoder`
 * with
 *   `var UTF8Decoder=undefined`
 * and execute the modified blob via an inline `<script>`. The IIFE then
 * falls back to the manual UTF-8 decoder loop inside `UTF8ArrayToString`,
 * which uses raw byte-by-byte assembly and never calls TextDecoder.
 *
 * This is purely a runtime transformation: it does not require rebuilding
 * the wasm and is fully reversible by serving the original wabc.js to
 * any other consumer.
 */
function loadWabcModule(): Promise<WabcModule> {
  return new Promise((resolve, reject) => {
    if ((window as any).WabcModule) {
      instantiate((window as any).WabcModule);
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>("script[data-wabc-wasm]");
    if (existing) {
      const waiter = setInterval(() => {
        if ((window as any).WabcModule) {
          clearInterval(waiter);
          instantiate((window as any).WabcModule);
        }
      }, 16);
      return;
    }

        // ── Fetch wabc.js as text, neutralize TextDecoder usage, eval as inline script.
        // This is the only reliable way to override `var UTF8Decoder = …` because it's
        // captured inside the IIFE closure at parse time — no Module-level hook reaches it.
        (async () => {
          try {
            // Cache-bust: include a version timestamp so the browser always fetches
            // the freshly rebuilt file instead of serving a stale cached copy.
            // Cache-bust via import.meta.env timestamp so the browser always fetches
            // the freshly rebuilt wasm after a Phase 3 rebuild instead of serving a
            // stale cached copy. `__WABC_CACHE_BUST__` is set to `Date.now()` at
            // dev-time by vite.config.ts; for production builds it resolves to a
            // stable build-hash, which is still unique per deployment.
            const url = `/wasm/alembic/wabc.js?v=${__WABC_CACHE_BUST__}`;
            const resp = await fetch(url, { credentials: "same-origin" });
            if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
        let source = await resp.text();
        // Single-line replacement. We match the *exact* source string emitted
        // by the Emscripten version that produced this wabc.js. Match both the
        // WebView2/WASM and a Node fallback in case Emscripten changes output.
        const patterns = [
          "var UTF8Decoder=globalThis.TextDecoder&&new TextDecoder",
          "var UTF8Decoder=new TextDecoder",
        ];
        let replaced = false;
        for (const pat of patterns) {
          if (source.includes(pat)) {
            source = source.replace(pat, "var UTF8Decoder=undefined /* patched by WabcLoader: avoid TextDecoder on resizable heap */");
            replaced = true;
            break;
          }
        }
        if (!replaced) {
          console.warn("[wabc] Could not find UTF8Decoder declaration in wabc.js; assuming already patched or differently built. Continuing without modification.");
        }
        const blob = new Blob([source], { type: "application/javascript" });
        const blobUrl = URL.createObjectURL(blob);
        const script = document.createElement("script");
        script.src = blobUrl;
        script.async = false;
        script.dataset.wabcWasm = "1";
        script.onload = () => {
          // Revoke the blob URL after the script body has been parsed and
          // the IIFE factory is registered on `window.WabcModule`. (We can't
          // revoke earlier — the script element needs the URL to still be
          // valid when its body fetches further resources.)
          URL.revokeObjectURL(blobUrl);
          if (!(window as any).WabcModule) {
            reject(new Error("wabc.js loaded but window.WabcModule is undefined."));
            return;
          }
          instantiate((window as any).WabcModule);
        };
        script.onerror = () => {
          URL.revokeObjectURL(blobUrl);
          reject(new Error("Failed to load patched /wasm/alembic/wabc.js."));
        };
        document.head.appendChild(script);
      } catch (e) {
        reject(e);
      }
    })();

    function instantiate(factory: unknown) {
      if (typeof factory !== "function") {
        resolve(factory as WabcModule);
        return;
      }

      const mod: any = {
        locateFile: (_p: string) => "/wasm/alembic/" + _p,
        // CRITICAL: override dependenciesFulfilled so that Emscripten's async
        // path does NOT call run()/initRuntime() before __post_instantiate runs.
        dependenciesFulfilled: () => {},
        noExitRuntime: true,
        instantiateWasm: async (_imports: any, receiveInstance: (instance: WebAssembly.Instance) => void) => {
          const url = "/wasm/alembic/wabc.wasm";
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
          const { instance } = await WebAssembly.instantiateStreaming(response, _imports);
          // Emscripten's IIFE shim lives entirely in a closure and DOES NOT
          // attach the HEAP views onto `Module`. With ALLOW_MEMORY_GROWTH=1,
          // the HEAP views are only created when updateMemoryViews() runs
          // inside the IIFE (in createWasm's receiveInstance helper), and
          // they are captured by closure — never visible on Module.
          //
          // Expose typed-array views over the raw WebAssembly.Memory export
          // ourselves, so the rest of the loader can do
          // `m.HEAPF32.subarray(ptr >> 2, ...)` exactly like before.
          //
          // We expose them as LIVE getters so reads always see the current
          // buffer (resizable ArrayBuffers can grow mid-load — Emscripten's
          // dlmalloc will call growMemory() during _malloc, which detaches
          // the old buffer and allocates a new one).
          const memExport = Object.values(instance.exports).find(
            (v) => v instanceof WebAssembly.Memory,
          ) as WebAssembly.Memory | undefined;
          if (!memExport) {
            // Diagnostic: list all export keys + types so we know what shape we got.
            const exportInfo = Object.entries(instance.exports)
              .slice(0, 50)
              .map(([k, v]) => {
                const t =
                  v instanceof WebAssembly.Memory ? "Memory" :
                  v instanceof WebAssembly.Table ? "Table" :
                  v instanceof WebAssembly.Global ? "Global" :
                  typeof v;
                return `${k}:${t}`;
              });
            throw new Error(
              `wabc.wasm did not export a WebAssembly.Memory. Available exports: ${exportInfo.join(", ")}`,
            );
          }
          const mem = memExport;
          const defineView = <T extends ArrayBufferView>(name: string, ctor: new (b: ArrayBuffer) => T) => {
            Object.defineProperty(mod, name, {
              configurable: true,
              get() { return new ctor(mem.buffer); },
            });
          };
          defineView("HEAP8",   Int8Array);
          defineView("HEAP16",  Int16Array);
          defineView("HEAPU8",  Uint8Array);
          defineView("HEAPU16", Uint16Array);
          defineView("HEAP32",  Int32Array);
          defineView("HEAPU32", Uint32Array);
          defineView("HEAPF32", Float32Array);
          defineView("HEAPF64", Float64Array);
          defineView("HEAP64",  BigInt64Array);
          defineView("HEAPU64", BigUint64Array);
          // Expose mem itself for code that wants to check buffer state.
          Object.defineProperty(mod, "wasmMemory", {
            configurable: true,
            get() { return mem; },
          });
          receiveInstance(instance);
          return instance;
        },
      };

      const result = (factory as (m: any) => unknown)(mod);
      const settle = (m: any) => {
        if (!m) { reject(new Error("WabcModule factory produced no instance.")); return; }
        if (m.__ATPRERUN__) m.__ATPRERUN__.forEach((cb: () => void) => cb());
        if (m.__ATINIT__) m.__ATINIT__.forEach((cb: () => void) => cb());
        if (m.__ATPOSTRUN__) m.__ATPOSTRUN__.forEach((cb: () => void) => cb());
        resolve(m as WabcModule);
      };

      if (result && typeof (result as any).then === "function") {
        (result as Promise<unknown>).then(settle).catch(reject);
      } else {
        settle(result);
      }
    }
  });
}

async function getWasm(): Promise<WabcModule> {
  if (wasmModule) return wasmModule;
  if (wasmLoading) return wasmLoading;
  wasmLoading = (async () => {
    const mod = await loadWabcModule();
    wasmModule = mod;
    return wasmModule;
  })();
  return wasmLoading;
}

// ─── C-string helpers (stack-allocated strings only) ──────────────────────────

/** Read a null-terminated C string from WASM memory. */
function readCString(m: WabcModule, ptr: number): string {
  if (m.UTF8ToString) return m.UTF8ToString(ptr);
  const view = m.HEAPU8;
  let end = ptr;
  while (view[end] !== 0) end++;
  return new TextDecoder("utf-8").decode(view.subarray(ptr, end));
}

/** Copy a JS string into a stack-allocated WASM buffer as a null-terminated C string. Returns the pointer. */
function writeCString(m: WabcModule, str: string): number {
  const ptr = m.stackAlloc(str.length + 1);
  for (let i = 0; i < str.length; i++) m.HEAPU8[ptr + i] = str.charCodeAt(i);
  m.HEAPU8[ptr + str.length] = 0;
  return ptr;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface AlembicMeta {
  /** full path of the mesh/xform/camera in the archive (single combined mesh) */
  path: string;
  type: "mesh" | "points" | "camera" | "unknown";
  minTime: number;
  maxTime: number;
  sampleCount: number;
}

export interface AlembicLoadResult {
  /** top-level THREE.Group containing mesh + (optional) points + cameras */
  group: THREE.Group;
  /** List of discovered objects for UI / animation scrubbing */
  meta: AlembicMeta[];
  /** Handle to pass to closeAlembic() when done */
  handle: number;
  /** Time stamps (seconds) for each sampled frame. */
  times: number[];
  /** True when the archive contains more than one frame (animation). */
  isAnimated: boolean;
  /** Frame rate (frames per second) derived from the dominant time sampling.
   *  0 = acyclic / unknown sampling (display "No Data" in the UI). */
  fps: number;
  /** Total sample count of the dominant time sampling (i.e. the actual
   *  number of on-disk frames in the longest animation). 0 = no animation. */
  frameCount: number;
  /** The shared BufferGeometry — call seekGeometry(time) each frame. */
  geometry: THREE.BufferGeometry;
  /** Advance to the given time (seconds) and fill the geometry's position/index
   *  buffers from the WASM heap. Call this every animation frame. */
  seekGeometry: (time: number) => void;
}

// ─── Hard caps for wasm heap buffers ─────────────────────────────────────────
//
// These are sanity-check ceilings. We allocate per-frame scratch buffers with
// `_malloc(actualVertCount*12)` for positions and `_malloc(totalIdx*4)` for
// face indices after querying `wabc_get_num_vertices` / `wabc_read_face_counts`.
//
// MAX_FRAMES is the number of frames sampled at load time to discover the
// animation time range. It does NOT represent simultaneous in-memory copies;
// peak heap usage is one frame's worth at a time (frame 0 during load; then
// one frame per seekGeometry() call during playback).
//
// Reference: upstream i-saint/WebAlembicViewer/SceneABC.cpp uses no caps at all
// (everything goes into std::vector). We keep light sanity caps here as a
// defensive OOM guard.
const MAX_VERTS = 40_000_000;       // 40M verts — covers RunningCharacter (33.2M expanded) at ~480 MB heap
const MAX_FACE_INDICES = 60_000_000; // 60M ints × 4 B = 240 MB indices (triangulated n-gons)
const MAX_POINTS = 5_000_000;       // 5M points × 12 B = 60 MB particle clouds
const MAX_FRAMES = 30;              // frames sampled at load time to discover animation range

/**
 * Load an Alembic archive from a file path.
 *
 * The wabc C ABI takes a virtual file path (it opens the file with std::fstream).
 * The Tauri HTTP server at `http://localhost:18765/file?path=...` is the source
 * of truth for the file on disk; the same absolute path is passed through to
 * the wasm side.
 *
 * Returns a group + clips ready to add to a THREE.Scene.
 * Throws on: invalid file, no mesh data, single mesh with > MAX_VERTS verts.
 */
export async function loadAlembicFromBuffer(
  buffer: ArrayBuffer,
  onProgress?: (msg: string) => void,
  filePath?: string,
  /** Optional explicit URL for fetching the bytes (e.g. Tauri HTTP server endpoint). */
  fileUrl?: string,
): Promise<AlembicLoadResult> {
  const m = await getWasm();
  onProgress?.("[wabc] WASM module ready");

  // C ABI wrappers
  const wabcOpenBuffer = m.cwrap("wabc_open_buffer", "number", ["string"]) as (path: string) => number;
  const wabcClose = m.cwrap("wabc_close", null, ["number"]) as (h: number) => void;
  const wabcGetStartTime = m.cwrap("wabc_get_start_time", "number", ["number"]) as (h: number) => number;
  const wabcGetEndTime = m.cwrap("wabc_get_end_time", "number", ["number"]) as (h: number) => number;
  const wabcSeek = m.cwrap("wabc_seek", null, ["number", "number"]) as (h: number, t: number) => void;
  const wabcGetNumVertices = m.cwrap("wabc_get_num_vertices", "number", ["number"]) as (h: number) => number;
  const wabcGetNumFaces = m.cwrap("wabc_get_num_faces", "number", ["number"]) as (h: number) => number;
  const wabcGetNumExpandedVertices = m.cwrap("wabc_get_num_expanded_vertices", "number", ["number"]) as (h: number) => number;
  const wabcGetNumRawExpandedVertices = m.cwrap("wabc_get_num_raw_expanded_vertices", "number", ["number"]) as (h: number) => number;
  // Read indexed (original) positions - not expanded
  const wabcReadPositions = m.cwrap(
    "wabc_read_positions",
    "number",
    ["number", "number", "number"],
  ) as (h: number, dst: number, maxFloats: number) => number;
  const wabcReadExpandedVertices = m.cwrap(
    "wabc_read_expanded_vertices",
    "number",
    ["number", "number", "number"],
  ) as (h: number, dst: number, maxFloats: number) => number;
  const wabcReadRawExpandedVertices = m.cwrap(
    "wabc_read_raw_expanded_vertices",
    "number",
    ["number", "number", "number"],
  ) as (h: number, dst: number, maxFloats: number) => number;
  const wabcReadWireframeIndices = m.cwrap(
    "wabc_read_wireframe_indices",
    "number",
    ["number", "number", "number"],
  ) as (h: number, dst: number, maxInts: number) => number;
  const wabcGetNumPoints = m.cwrap("wabc_get_num_points", "number", ["number"]) as (h: number) => number;
  const wabcReadPoints = m.cwrap(
    "wabc_read_points",
    "number",
    ["number", "number", "number"],
  ) as (h: number, dst: number, maxFloats: number) => number;
  const wabcGetNumCameras = m.cwrap("wabc_get_num_cameras", "number", ["number"]) as (h: number) => number;
  const wabcGetDebugMatrixCount = m.cwrap("wabc_get_debug_matrix_count", "number", []) as () => number;
  const wabcGetDebugMatrices = m.cwrap(
    "wabc_get_debug_matrices",
    "number",
    ["number", "number", "number", "number"],
  ) as (matrixDst: number, pathDst: number, vertsDst: number, maxCount: number) => number;
  const wabcReadCamera = m.cwrap(
    "wabc_read_camera",
    "number",
    ["number", "number", "number", "number", "number", "number"],
  ) as (
    h: number, idx: number, matrix: number, focal: number, apx: number, apy: number,
  ) => number;
  const wabcGetCameraPath = m.cwrap(
    "wabc_get_camera_path",
    "number",
    ["number", "number", "number", "number"],
  ) as (h: number, idx: number, dst: number, maxBytes: number) => number;
  const wabcGetTime = m.cwrap("wabc_get_time", "number", ["number"]) as (h: number) => number;
  const wabcDumpPositions = m.cwrap("wabc_dump_positions", null, ["number", "number"]) as (h: number, maxVerts: number) => void;
  const wabcDumpStructure = m.cwrap("wabc_dump_structure", null, ["number"]) as (h: number) => void;
  const wabcHasGeometry = m.cwrap("wabc_has_geometry", "number", ["number"]) as (h: number) => number;
  const wabcDumpAfterSeek = m.cwrap("wabc_dump_after_seek", null, ["number", "number"]) as (h: number, time: number) => void;
  const wabcGetFps = m.cwrap("wabc_get_fps", "number", ["number"]) as (h: number) => number;
  const wabcGetFrameCount = m.cwrap("wabc_get_frame_count", "number", ["number"]) as (h: number) => number;

  // ── Open archive (MEMFS-backed) ───────────────────────────────────────
  // wabc C ABI takes a virtual filesystem path and opens it via std::fstream.
  // We DO NOT pass the user's disk path directly because Emscripten's
  // __syscall_openat → UTF8ArrayToString → TextDecoder crashes on resizable
  // ArrayBuffers when ALLOW_MEMORY_GROWTH=1.
  //
  // Strategy (mirrors i-saint's WebAlembicViewer loader at src/html/*.html):
  //   1. Caller fetches the .abc bytes (typically via the Tauri HTTP server).
  //   2. We write them into MEMFS at /abc/<basename>.abc via FS_createDataFile.
  //   3. Pass that ASCII path to wabc_open_buffer (cwrap's string marshaller
  //      copies it via stringToUTF8 → the C++ side opens it via MEMFS lookup,
  //      which is a pure in-WASM read and never crosses into the TextDecoder
  //      resizable-buffer code path).
  //   4. After load, FS_unlink to release MEMFS.
  if (!filePath) {
    throw new Error("[wabc] loadAlembicFromBuffer requires a filePath argument (wabc C ABI opens files by path).");
  }
  if (!m.FS_createDataFile || !m.FS_unlink) {
    throw new Error("[wabc] Emscripten MEMFS helpers unavailable. The wasm must be linked with -s FORCE_FILESYSTEM=1.");
  }
  // Fetch the .abc bytes from the caller-provided URL. Prefer `fileUrl`
  // (typically the Tauri HTTP /file?path=... endpoint); fall back to using
  // `filePath` directly if the caller didn't supply one.
  const source = fileUrl ?? filePath;
  const fileBytes = await fetchFileBytes(source, onProgress);
  const { parent, name } = stageInMEMFS(m, fileBytes, filePath);
  let handle: number;
  const memfsPath = `${parent}/${name}`;
  try {
    handle = callWasm(m, () => wabcOpenBuffer(memfsPath));
  } finally {
    // Whether open succeeded or failed, drop the staged file from MEMFS.
    // (On success the C++ std::fstream has already read everything we need.)
    try { m.FS_unlink!(memfsPath); } catch { /* best effort */ }
  }
  if (handle < 0) {
    throw new Error(`[wabc] wabc_open_buffer returned ${handle} — file is not a valid Alembic archive: ${filePath}`);
  }
  // Read time range BEFORE any diagnostic that uses it
  const minTime = callWasm(m, () => wabcGetStartTime(handle));
  const maxTime = callWasm(m, () => wabcGetEndTime(handle));
  // Probe: does seek(minTime) succeed? does it produce geometry?
  try {
    wabcSeek(handle, minTime);
  } catch (e: any) {
    console.error(`[wabc] seek(${minTime}) threw: ${e?.message || e}`);
  }
  const hasGeo = wabcHasGeometry(handle);

  // Capture FPS + total sample count from the dominant time sampling.
  // fps=0 means acyclic / unknown (UI shows "No Data"). frameCount=0 means
  // the archive has no animation.
  const fps = callWasm(m, () => wabcGetFps(handle));
  const frameCount = callWasm(m, () => wabcGetFrameCount(handle));
  console.log(
    `[wabc] animation: fps=${fps.toFixed(3)} frameCount=${frameCount} ` +
    `timeRange=[${minTime.toFixed(3)}, ${maxTime.toFixed(3)}]`,
  );

  // ── Heap scratch buffers ────────────────────────────────────────────────
  const pointsBuf = m._malloc(MAX_POINTS * 3 * 4);

  // Mutable scratch state shared between load and every seekGeometry call.
  // Everything here lives on the WASM heap via the pointers above.
  let vertCount = 0;
  let totalIdx = 0;
  let posBuf = 0;
  let geo: THREE.BufferGeometry;
  let posAttr: THREE.BufferAttribute;
  let posHeap: Float32Array;
  let firstVertCount = 0;
  let firstFaceCount = 0;

  // ── Load frame 0 using EXPANDED mesh (matches i-saint's glDrawArrays) ───
  // i-saint uses glDrawArrays(GL_TRIANGLES) on m_points_ex — non-indexed.
  // We do the same: build BufferGeometry from m_points_ex directly.
  // This is simpler, more robust (no face_indices offset bugs possible),
  // and matches the reference implementation visually.

  // Query expanded vertex count (already triangulated on the C++ side).
  const expandedVertCount = callWasm(m, () => wabcGetNumExpandedVertices(handle));
  if (expandedVertCount <= 0) {
    wabcClose(handle);
    throw new Error("[wabc] Alembic archive has no expanded mesh data.");
  }
  if (expandedVertCount > MAX_VERTS) {
    wabcClose(handle);
    throw new Error(
      `[wabc] Expanded mesh exceeds hard cap: ${expandedVertCount} verts > MAX_VERTS=${MAX_VERTS}. ` +
      `File is too large.`,
    );
  }

  // Allocate buffer for expanded positions (outside try block so seekGeometry can use it).
  const posBufSize = expandedVertCount * 3;
  posBuf = m._malloc(posBufSize * 4);

  // Read-only copies of frame-0 data used to build the geometry at load time.
  let frame0Positions: Float32Array;
  let anyOk = false;

  try {
    // Read expanded (non-indexed) positions.
    // i-saint renders with glDrawArrays(GL_TRIANGLES) on m_points_ex — no face
    // indices lookup, no offset bugs, no risk of triangles referencing stale
    // vertices. We mirror that exactly here.
    const nWritten = callWasm(m, () => wabcReadExpandedVertices(handle, posBuf, posBufSize));
    if (nWritten === 0) {
      wabcClose(handle);
      throw new Error("[wabc] wabc_read_expanded_vertices returned 0 for frame 0.");
    }
    frame0Positions = new Float32Array(expandedVertCount * 3);
    frame0Positions.set(m.HEAPF32.subarray(posBuf >> 2, (posBuf >> 2) + expandedVertCount * 3));
    firstVertCount = expandedVertCount;
    firstFaceCount = expandedVertCount / 3; // each triangle = 3 verts, expanded already triangulated
    anyOk = true;

    // Compute expanded bbox — this is the geometry's actual world-space bbox
    // (i-saint's monolithic merge transforms everything into global space).
    let iMinX = Infinity, iMinY = Infinity, iMinZ = Infinity;
    let iMaxX = -Infinity, iMaxY = -Infinity, iMaxZ = -Infinity;
    const sampleStep = Math.max(1, Math.floor(expandedVertCount / 2000));
    for (let i = 0; i < expandedVertCount; i += sampleStep) {
      const x = frame0Positions[i * 3], y = frame0Positions[i * 3 + 1], z = frame0Positions[i * 3 + 2];
      if (x < iMinX) iMinX = x; if (x > iMaxX) iMaxX = x;
      if (y < iMinY) iMinY = y; if (y > iMaxY) iMaxY = y;
      if (z < iMinZ) iMinZ = z; if (z > iMaxZ) iMaxZ = z;
    }
  } catch (err) {
    m._free(posBuf);
    wabcClose(handle);
    throw err;
  }

  // ── Build the persistent NON-INDEXED THREE.BufferGeometry ─────────────────
  // (matches i-saint's glDrawArrays path; this layout is required because
  // seekGeometry below writes positions back into the same buffer each frame)
  geo = new THREE.BufferGeometry();
  const posArray = new Float32Array(frame0Positions);
  posAttr = new THREE.BufferAttribute(posArray, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", posAttr);
  // No setIndex — non-indexed geometry. WebGL will treat every 3 verts as a triangle.

  posHeap = m.HEAPF32;

  // ── Compute bounding box from the same expanded positions (already in posArray) ──
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  // ── Normals: SKIPPED — match i-saint's renderer. ─────────────────────────
  // i-saint's fragment shader is a solid colour (`gl_FragColor = u_color;`)
  // — it never uses normals. We match that by setting `flatShading: true`
  // on the material, which tells Three.js to derive the per-fragment
  // normal from `dFdx`/`dFdy` of position in the fragment shader. This
  // is cheap, correct, and avoids all of the problems with shipping a
  // broken/expensive normal attribute on dense Alembic exports.
  //
  // Earlier we tried: face-cross-product + spatial-grid welding + 27-cell
  // Laplacian smoothing. The smoothing pass crashed the app on the
  // RunningCharacter (11M verts × 27 cells × bucket lookups blew the
  // memory budget). i-saint's "no normals" approach is both simpler and
  // unconditionally stable, so we use it.

  // Determine sample count for time array
  const timeSpan = maxTime - minTime;
  const numFrames = timeSpan > 0
    ? Math.min(MAX_FRAMES, Math.max(2, Math.ceil(timeSpan * 24)))
    : 1;
  const times: number[] = [];
  for (let i = 0; i < numFrames; i++) {
    times.push(numFrames > 1 ? minTime + (i / (numFrames - 1)) * timeSpan : minTime);
  }

  // ── seekGeometry: called every animation frame ─────────────────────────
  // For non-indexed geometry, we read expanded positions directly (i-saint style).
  let seekErrorCount = 0;
  function seekGeometry(time: number): void {
    const t = Math.max(minTime, Math.min(maxTime, time));
    try {
      callWasm(m, () => wabcSeek(handle, t));
      // Read expanded (non-indexed) positions
      const nWritten = callWasm(m, () => wabcReadExpandedVertices(handle, posBuf, posBufSize));
      if (nWritten === 0) return;
      // Copy positions to the geometry attribute
      posAttr.array.set(posHeap.subarray(posBuf >> 2, (posBuf >> 2) + expandedVertCount * 3));
      posAttr.needsUpdate = true;
      seekErrorCount = 0; // Reset error count on success
    } catch (e) {
      seekErrorCount++;
      if (seekErrorCount === 1) {
        console.warn(`[wabc] seekGeometry failed (further errors suppressed): ${e}`);
      }
      if (seekErrorCount > 5) {
        console.error(`[wabc] Too many seek errors, disabling animation`);
        // Could disable animation here if needed
      }
    }
  }
  const group = new THREE.Group();
  const metaList: AlembicMeta[] = [];

  // Add a visible material. We don't compute normals (i-saint doesn't
  // either), so flatShading=true — the fragment shader will derive a face
  // normal from `dFdx`/`dFdy` of position. Matches i-saint exactly.
  const material = new THREE.MeshStandardMaterial({
    color: 0x88ccff,
    side: THREE.DoubleSide,
    flatShading: true,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = filePath.split(/[\\/]/).pop()?.replace(/\.abc$/i, "") || "abc_mesh";

  group.add(mesh);

  metaList.push({
    path: filePath,
    type: "mesh",
    minTime,
    maxTime,
    sampleCount: numFrames,
  });
  onProgress?.(`[wabc] Mesh ready: ${firstVertCount} verts, ${firstFaceCount} faces, ${times.length} frame(s)`);

  // ── Points (particle clouds) ─────────────────────────────────────────
  // Only try to load points if the function exists in WASM
  let numPts = 0;
  if (typeof wabcGetNumPoints === "function") {
    try {
      numPts = callWasm(m, () => wabcGetNumPoints(handle));
    } catch (e) {
      console.warn(`[wabc] wabcGetNumPoints failed: ${e}`);
      numPts = 0;
    }
  } else {
    console.warn(`[wabc] wabc_get_num_points not exported in this WASM build`);
  }
  if (numPts > 0) {
    if (numPts > MAX_POINTS) {
      console.warn(`[wabc] Points (${numPts}) exceed MAX_POINTS (${MAX_POINTS}); truncating`);
    }
    const nWritten = callWasm(m, () => wabcReadPoints(handle, pointsBuf, MAX_POINTS * 3));
    if (nWritten > 0) {
      const usePts = Math.min(numPts, MAX_POINTS);
      const ptsPos = new Float32Array(usePts * 3);
      ptsPos.set(m.HEAPF32.subarray(pointsBuf >> 2, (pointsBuf >> 2) + usePts * 3));
      const ptsGeo = new THREE.BufferGeometry();
      ptsGeo.setAttribute("position", new THREE.BufferAttribute(ptsPos, 3));
      const ptsMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1, sizeAttenuation: false });
      const ptsObj = new THREE.Points(ptsGeo, ptsMat);
      ptsObj.name = "abc_points";
      group.add(ptsObj);
      onProgress?.(`[wabc] Points: ${usePts} particles`);
      metaList.push({
        path: `${filePath}/points`,
        type: "points",
        minTime,
        maxTime,
        sampleCount: 1,
      });
    }
  }

  // ── Cameras (informational — not added to scene by default) ────────
  const numCams = callWasm(m, () => wabcGetNumCameras(handle));
  if (numCams > 0) {
    const pathBuf = m.stackAlloc(1024);
    const matrixBuf = m.stackAlloc(16 * 4);
    const fovBuf = m.stackAlloc(4);
    const apxBuf = m.stackAlloc(4);
    const apyBuf = m.stackAlloc(4);
    for (let ci = 0; ci < numCams; ci++) {
      const pathLen = callWasm(m, () => wabcGetCameraPath(handle, ci, pathBuf, 1024));
      const camPath = pathLen > 0 ? readCString(m, pathBuf) : `camera_${ci}`;
      const ok = callWasm(m, () => wabcReadCamera(handle, ci, matrixBuf, fovBuf, apxBuf, apyBuf));
      if (ok) {
        const focal = m.HEAPF32[fovBuf >> 2];
        const apx = m.HEAPF32[apxBuf >> 2];
        const apy = m.HEAPF32[apyBuf >> 2];
        console.info(`[wabc] Camera ${ci}: path="${camPath}" focal=${focal}mm aperture=${apx}x${apy}mm`);
      }
      metaList.push({
        path: camPath,
        type: "camera",
        minTime,
        maxTime,
        sampleCount: 1,
      });
    }
  }

  m._free(pointsBuf);

  return {
    group,
    meta: metaList,
    handle,
    times,
    isAnimated: numFrames > 1,
    fps,
    frameCount,
    geometry: geo,
    seekGeometry,
  };
}

/**
 * Fetch the raw bytes of an archive from `source`. `source` can be:
 *   - A Tauri HTTP server URL (e.g. http://localhost:18765/file?path=...)
 *   - A file:// URL
 *   - An http(s):// URL pointing at any served file
 *
 * We use the standard `fetch()` API; the caller's domain model lets us treat
 * the source as a regular network resource, no special Tauri plumbing needed.
 */
async function fetchFileBytes(source: string, onProgress?: (msg: string) => void): Promise<Uint8Array> {
  onProgress?.(`[wabc] Fetching ${source} ...`);
  const resp = await fetch(source);
  if (!resp.ok) {
    throw new Error(`[wabc] HTTP ${resp.status} ${resp.statusText} for ${source}`);
  }
  const buf = await resp.arrayBuffer();
  onProgress?.(`[wabc] Downloaded ${(buf.byteLength / 1024 / 1024).toFixed(2)} MB`);
  return new Uint8Array(buf);
}

/**
 * Write `bytes` into MEMFS at /abc/<basename>.abc and return {parent, name}.
 *
 * Why a fresh "/abc/<basename>.abc" path:
 *   - ASCII-only, so no encoding surprises when the path crosses the
 *     JS↔C++ boundary via cwrap's stringToUTF8.
 *   - Predictable for the cleanup unlink() in the caller's finally block.
 *
 * MEMFS staging is what sidesteps the Emscripten TextDecoder-on-resizable-
 * buffer crash: wabc_open_buffer opens the file via std::fstream which
 * resolves to MEMFS lookup (a pure in-WASM read), never crossing into
 * __syscall_openat where TextDecoder is invoked on the heap ArrayBuffer.
 *
 * We split into (parent, name) because Emscripten's `FS_createDataFile` is
 * exposed as a discrete helper function (Module["FS_createDataFile"]) that
 * takes (parent, name, data, ...) — there is no Module.FS.writeFile helper.
 */
function stageInMEMFS(
  m: WabcModule,
  bytes: Uint8Array,
  sourcePath: string,
): { parent: string; name: string } {
  if (!m.FS_createDataFile || !m.FS_createPath) {
    throw new Error("[wabc] MEMFS helpers unavailable — cannot stage archive.");
  }
  // Derive a safe basename. Strip directory, strip extension, ASCII-fold,
  // fall back to "archive" if anything is left. The .abc extension is
  // important — Alembic uses it to choose the Ogawa/HDF5 reader path.
  const safeBase = (sourcePath.split(/[\\/]/).pop() || "archive.abc")
    .replace(/\.abc$/i, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 64) || "archive";
  const parent = "/abc";
  const name = `${safeBase}.abc`;
  // Best-effort directory creation (FS_createPath throws if it already exists).
  try { m.FS_createPath("/", "abc", true, true); } catch { /* already exists */ }
  // (parent, name, data, canRead, canWrite, canOwn) — canOwn=true so the
  // runtime takes ownership of the underlying buffer (one less copy).
  m.FS_createDataFile(parent, name, bytes, true, true, true);
  return { parent, name };
}

/** Release WASM resources for a previously-loaded archive. */
export function closeAlembic(handle: number): void {
  if (wasmModule && handle >= 0) {
    try {
      (wasmModule.cwrap("wabc_close", null, ["number"]) as (h: number) => void)(handle);
    } catch (e) {
      console.warn("[wabc] wabc_close failed:", e);
    }
  }
}
