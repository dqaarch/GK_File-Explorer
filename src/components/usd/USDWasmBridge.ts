// Phase 1 spike: load Needle Tools USD WASM outside an iframe.
// Verifies that the OpenUSD Hydra bindings + ThreeJsRenderDelegate can hydrate
// from the main React tree and populate a shared THREE.Scene.
//
// The previous design rendered USD files inside an <iframe> that loaded the
// OpenLegged viewer from /usd-viewer/. That kept the WASM isolated but cost us:
//   - a second WebGL canvas that competes with our 3DModelViewer renderer
//   - duplicated lighting, controls, and theme context
//   - "app inside an app" feel
//
// This module wraps @needle-tools/usd's `createThreeHydra` so a USD stage can
// be loaded into an existing Three.js scene just like GLB/FBX/OBJ.
//
// File-system access: USD.FS_createDataFile accepts a Uint8Array. We fetch
// the local file from the running Rust HTTP server at
//   http://localhost:18765/file?path=<encoded path>
// — the same endpoint 3DModelViewer uses for OBJ/FBX/GLTF/Alembic. That works
// in both dev (`tauri dev`, where the Rust HTTP server is started by main.rs)
// and production (the installer ships the same server bound to localhost).
//
// Historically this module fetched from `/@usd-file/`, a Vite middleware that
// only exists in `vite dev` / `vite preview`. The production Tauri build
// serves `dist/` as static assets and does NOT register that route, which is
// why USD loading silently broke in the installer even though it worked in
// dev. Switching to the Rust HTTP server makes both modes identical.

import {
  createThreeHydra,
  getUsdModule,
  type NeedleThreeHydraHandle,
} from "@needle-tools/usd";
import type { Object3D } from "three";

// USD Hydra WASM runtime — served by Tauri from /usd-bindings/ in both dev
// (`tauri dev`) and production (the installer copies `public/usd-bindings/`
// verbatim into the Tauri static asset root via `bundle.resources`).
//
// The Vite build emits these files into `dist/assets/` with content-hash
// filenames. We resolve the URLs through a tiny Vite virtual module so we
// don't have to hard-code a specific hash that changes on every build, then
// copy the post-hash assets into the un-hashed public location at build
// time (see `vite.config.ts → usdBindingsCopy`).
import bindingsUrl from "virtual:usd-bindings";
const USD_BINDINGS_URL = bindingsUrl;
const USD_WASM_URL = `${bindingsUrl.replace(/\.js(?:\?.*)?$/, ".wasm")}?v=20260712a`;

const CACHE_BUST = "v=20260712a"; // bumped 2026-07-12: needle-tools/usd 1.0.0 -> 1.1.1

export interface LoadUsdOptions {
  /** Three.js scene that will receive USD meshes as a child group. */
  scene: Object3D;
  /** Absolute local path to the USD/USDZ file on disk. */
  filePath: string;
  /** Optional callback fired while WASM downloads data segment. */
  onDownloadProgress?: (loaded: number, total: number) => void;
  /** Optional callback fired when the first draw has settled. */
  onReady?: (handle: NeedleThreeHydraHandle) => void;
  /** Auto-advance stage time from the hydra handle's update() loop. */
  autoPlay?: boolean;
}

export interface UsdLoadResult {
  handle: NeedleThreeHydraHandle;
  metadata: {
    upAxis: string;
    startTimeCode: number;
    endTimeCode: number;
    timeCodesPerSecond: number;
  };
}

function toBrowserUrl(filePath: string): string {
  // Hit the Rust HTTP server bundled with the app. Same endpoint
  // 3DModelViewer.tsx uses for OBJ/FBX/GLTF/Alembic — keeps a single
  // local-file fetch path and works identically in dev and the installed
  // build. The dev-mode `/@usd-file/` Vite middleware is no longer used.
  const path = `/file?path=${encodeURIComponent(filePath)}`;
  return `http://localhost:18765${path}`;
}

// Track the last USD handle so we can dispose it before loading another file.
// The Needle delegate leaves entries in the WASM virtual filesystem that
// `FS_unlink("/needle/...")` cannot reliably reach — the files live inside a
// sub-instance of MEMFS that the top-level `readdir("/")` walk doesn't expose.
// Disposing the previous handle unwinds all the bookkeeping the delegate set
// up, which is what actually unblocks the next `FS_createDataFile`.
//
// We also dispose on tab unload so we don't leak WASM memory across HMR.
let activeHandle: NeedleThreeHydraHandle | null = null;
let activeFilePath: string | null = null;
if (typeof window !== "undefined") {
  const disposeActiveHandle = () => {
    if (!activeHandle) return;
    try {
      activeHandle.dispose?.();
    } catch {
      /* ignored — handle may already be torn down */
    }
    activeHandle = null;
    activeFilePath = null;
  };
  window.addEventListener("beforeunload", disposeActiveHandle);
  if (import.meta.hot) {
    import.meta.hot.dispose(disposeActiveHandle);
  }
}

/**
 * Load a USD/USDZ file from local disk into a shared Three.js scene.
 *
 * Returns the hydra handle so the caller can drive animation, redraw on edits,
 * and dispose. The handle's `driver` lives in WASM memory; do not assume it
 * survives a tab reload.
 */
export async function loadUsdIntoScene(options: LoadUsdOptions): Promise<UsdLoadResult> {
  const { scene, filePath, onDownloadProgress, onReady, autoPlay = true } = options;

  // Use console.warn so it always shows up in DevTools (Info-level logs are
  // hidden by default). This is the canary that tells us whether HMR picked
  // up the latest USDWasmBridge.ts — if this line is missing in a reload,
  // the user is still running a stale module.
  console.warn("[USDWasmBridge] loadUsdIntoScene() called", { filePath });

  // 0a. If a previous load left a handle behind, dispose it before doing
  //     anything else. Without this, the WASM delegate's second pass keeps
  //     colliding with files mounted by the previous load, producing
  //     `ErrnoError errno: 20 (ENOTDIR)` on the third load of the same path.
  if (activeHandle && activeFilePath !== filePath) {
    console.warn(
      `[USDWasmBridge] disposing previous handle (was for "${activeFilePath}") before loading "${filePath}"`,
    );
    try {
      activeHandle.dispose?.();
    } catch {
      /* ignored */
    }
    activeHandle = null;
    activeFilePath = null;
  }

  const url = toBrowserUrl(filePath);
  console.warn("[USDWasmBridge] fetching USD file", { url, filePath });

  // 0. Read the USD file into memory ourselves so WASM doesn't need to refetch
  //    it (or its textures) via HTTP. Needle Tools' HTTPAssetResolver inside
  //    the WASM tries to follow paths like
  //      <usdz-url>[0/<texture>.png]
  //    which our `/@usd-file/` middleware can't unpack (the path query is
  //    opaque). When we hand the bytes over via `buffer`, createFile puts the
  //    archive directly into the WASM virtual filesystem, and the resolver
  //    reads siblings from there instead of HTTP.
  const fileResponse = await fetch(url);
  console.warn("[USDWasmBridge] fetch result", {
    url,
    status: fileResponse.status,
    statusText: fileResponse.statusText,
    contentType: fileResponse.headers.get("Content-Type"),
    contentLength: fileResponse.headers.get("Content-Length"),
  });
  if (!fileResponse.ok) {
    throw new Error(
      `[USDWasmBridge] Failed to fetch USD file at ${url}: ${fileResponse.status} ${fileResponse.statusText}`,
    );
  }
  const buffer = await fileResponse.arrayBuffer();
  onDownloadProgress?.(buffer.byteLength, buffer.byteLength);

  // 1. Hydrate the WASM module once. `getUsdModule` is cached internally by
  //    @needle-tools/usd so concurrent calls share the same Module instance.
  //
  //    The custom `locateFile` is what unblocks the dev server. Emscripten's
  //    default lookup walks `Module.locateFile` for both the `.wasm` and the
  //    `.data` preloaded package. We point both at the /usd-bindings/* files
  //    under `public/`, which Vite serves with `Content-Type: application/wasm`
  //    in dev and the same in production (Tauri copies `public/` verbatim into
  //    the bundle).
  const USD = await getUsdModule({
    mainScriptUrlOrBlob: USD_BINDINGS_URL,
    locateFile: (file: string) => {
      console.warn("[USDWasmBridge] locateFile() called", { file });
      if (file.includes("emHdBindings.wasm")) {
        return USD_WASM_URL;
      }
      return file;
    },
    onDownloadProgress: (loaded, total) => {
      onDownloadProgress?.(loaded, total);
    },
  });
  console.warn("[USDWasmBridge] USD module hydrated", {
    hasFS_unlink: typeof (USD as unknown as { FS_unlink?: unknown }).FS_unlink,
    hasFS: typeof (USD as unknown as { FS?: unknown }).FS,
  });

  // Inspect the USD Module to find where the Emscripten virtual FS lives.
  // Run once per session, cached so we don't re-spam the console on every load.
  const inspectCache = (USD as unknown as { __usdInspected?: boolean }).__usdInspected;
  if (!inspectCache) {
    try {
      const rootKeys = Object.keys(USD as object).filter(
        (k) => !/^_|^cwrap|^ccall|^AsciiToString|^stringToUTF8|^UTF8ToString|^intArrayFromString|^intArrayToString|^allocate|^_malloc|^_free|^dynCall|^stackGet|^stackRestore|^stackSave|^addFunction|^removeFunction|^lengthBytesUTF8|^stringToUTF8Array|^writeStringToMemory|^writeArrayToMemory|^getValue|^setValue|^HEAP|^Pointer_stringify|^ccall|^cwrap/.test(k),
      );
      console.warn("[USDWasmBridge] USD module top-level keys", rootKeys.slice(0, 80));
      (USD as unknown as { __usdInspected?: boolean }).__usdInspected = true;
    } catch {
      /* inspection is purely diagnostic; ignore */
    }
  }

  // 1a. Clear any leftover entry the previous load wrote into the shared
  //     WASM virtual FS. `createThreeHydra` mounts the bytes via
  //     `FS_createDataFile(<filePath>, …)` so reloading the SAME file (or
  //     any file whose path was reused after a prior load expanded a
  //     USDZ archive into a directory of the same name) trips Emscripten's
  //     `ENOTDIR (errno 20)` — it tries to write a file over an existing
  //     directory entry. We `tryUnlink` the exact file path first, then
  //     walk the file's parent directory removing sibling files /
  //     sub-directories the delegate created when it extracted the
  //     USDZ archive.
  // Needle Tools' USD WASM exposes the Emscripten virtual FS as flat
  // `FS_*` functions on the module itself (no `FS` wrapper object). Inspect
  // output above confirms: `FS_unlink`, `FS_readdir`, `FS_analyzePath`,
  // `FS_rmdir`, `FS_createPath`, etc.
  const flat = USD as unknown as {
    FS_unlink?: (path: string) => void;
    FS_rmdir?: (path: string) => void;
    FS_readdir?: (path: string) => string[];
    FS_analyzePath?: (path: string) => {
      path: string;
      exists: boolean;
      object: { isFolder: boolean; name: string; contents?: { isFolder: boolean; name: string }[] } | null;
    };
    FS_stat?: (path: string) => { mode: number };
    FS_isDir?: (mode: number) => boolean;
    FS?: {
      unlink: (path: string) => void;
      readdir: (path: string) => string[];
      analyzePath: (path: string) => {
        path: string;
        exists: boolean;
        object: { isFolder: boolean; name: string; contents?: { isFolder: boolean; name: string }[] } | null;
      };
      stat: (path: string) => { mode: number };
      isDir: (mode: number) => boolean;
    };
  };
  // Build a virtual `fs` object so the rest of this function can stay
  // unchanged: prefer the flat FS_* functions, fall back to a wrapped FS
  // namespace if a future build ships one.
  const fs: {
    unlink: (p: string) => void;
    rmdir: (p: string) => void;
    readdir: (p: string) => string[];
    analyzePath: (p: string) => ReturnType<NonNullable<typeof flat.FS_analyzePath>>;
    stat: (p: string) => { mode: number };
    isDir: (mode: number) => boolean;
  } | null = (() => {
    if (flat.FS_unlink && flat.FS_analyzePath) {
      return {
        unlink: (p) => flat.FS_unlink!(p),
        rmdir: (p) => (flat.FS_rmdir ?? flat.FS_unlink!).call(flat, p),
        readdir: (p) => flat.FS_readdir!(p),
        analyzePath: (p) => flat.FS_analyzePath!(p),
        stat: (p) => (flat.FS_stat ?? ((p) => ({ mode: 0 })))(p),
        isDir: (mode) => (flat.FS_isDir ?? ((m) => (m & 0o170000) === 0o040000))(mode),
      };
    }
    if (flat.FS) {
      return flat.FS;
    }
    return null;
  })();
  if (!fs) {
    console.warn("[USDWasmBridge] no FS handle resolved from USD module");
  }
  const tryUnlink = (p: string) => {
    try {
      fs?.unlink?.(p);
    } catch {
      /* already gone — ignore */
    }
  };
  if (fs) {
    // Diagnostic: walk the whole WASM VFS tree so we can see exactly where
    // the previous load left its entries. Needle's WASM mounts files under
    // a `/needle/<basename>/...` subtree, not the literal Windows path,
    // so guessing paths from the filename is unreliable.
    let allEntries: string[] = [];
    let totalCount = 0;
    let truncated = false;
    try {
      const MAX_ENTRIES = 800;
      const MAX_DEPTH = 12;
      const walk = (root: string, depth: number) => {
        if (depth <= 0 || truncated) return;
        let kids: string[];
        try {
          kids = fs.readdir(root);
        } catch {
          return;
        }
        for (const k of kids) {
          if (k === "." || k === "..") continue;
          const child = root.replace(/\/?$/, "/") + k;
          totalCount += 1;
          if (allEntries.length < MAX_ENTRIES) allEntries.push(child);
          else truncated = true;
          let isDir = false;
          try {
            isDir = fs.isDir(fs.stat(child).mode);
          } catch {
            /* ignore */
          }
          if (isDir) walk(child, depth - 1);
        }
      };
      walk("/", MAX_DEPTH);
    } catch {
      /* ignore walk errors */
    }

    // Pre-clean: unlink any leftover file or directory the previous load
    // created, but only at paths that match the file we're about to load.
    // The Needle delegate mounts the USDZ bytes under a path it derives
    // from the basename (drive letter, backslashes and slashes are
    // replaced with `_`), so we mirror that naming here. We deliberately
    // stay away from the wider VFS — earlier sweeps were removing
    // `plugInfo.json` and the resolver plugin files, which crashed
    // `HdWebSyncDriver` with "Failed to find the plugInfo.json file that
    // declares the plugin for ArDefaultResolver".
    const baseWithExt = (filePath.match(/[^\\/]+$/)?.[0] ?? "").toLowerCase();
    const baseNoExt = baseWithExt.replace(/\.[^.]+$/, "");
    const fileNameSanitized = baseWithExt.replace(/[\\/]/g, "_");
    const fileBaseSanitized = fileNameSanitized.replace(/\.[^.]+$/, "");
    const unlinkOne = (p: string) => {
      try {
        fs?.unlink?.(p);
      } catch {
        /* gone — ignore */
      }
    };
    const isDir = (p: string): boolean => {
      try {
        return fs!.isDir(fs!.stat(p).mode);
      } catch {
        return false;
      }
    };
    const cleanDir = (dir: string, depth: number) => {
      if (depth <= 0) return;
      let kids: string[];
      try {
        kids = fs!.readdir(dir);
      } catch {
        return;
      }
      for (const k of kids) {
        if (k === "." || k === "..") continue;
        const child = dir.replace(/\/?$/, "/") + k;
        if (isDir(child)) cleanDir(child, depth - 1);
        unlinkOne(child);
      }
      unlinkOne(dir);
    };
    // Match every plausible path the delegate might have written.
    const candidatePaths: Array<{ path: string; isDir: boolean }> = [];
    const seenPath = new Set<string>();
    const addPath = (p: string) => {
      const norm = p.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
      if (!seenPath.has(norm)) {
        seenPath.add(norm);
        candidatePaths.push({ path: norm, isDir: true });
        candidatePaths.push({ path: norm, isDir: false });
      }
    };
    // 1) The exact mounted file (Needle stores the bytes here).
    addPath(`/needle/${fileNameSanitized}`);
    addPath(`/needle/${fileBaseSanitized}`);
    // 2) The expanded archive directory Needle creates for USDZ files.
    addPath(`/needle/${fileBaseSanitized}/`);
    // 3) The legacy literal-path entry we used before adopting the
    //    Needle convention.
    addPath(`/uploads/${baseWithExt}`);
    addPath(`/uploads/${fileNameSanitized}`);
    for (const { path: p } of candidatePaths) {
      // Probe the entry: it may exist as either a file (the raw bytes) or
      // a directory (the expanded USDZ contents). Remove both shapes.
      try {
        const st = fs!.stat(p);
        if (fs!.isDir(st.mode)) {
          cleanDir(p, 6);
        } else {
          unlinkOne(p);
        }
      } catch {
        // Also try the path with an explicit trailing slash — some VFS
        // implementations keep directories and files on separate keys.
        const altDir = p.replace(/\/?$/, "/");
        if (altDir !== p) {
          try {
            const st = fs!.stat(altDir);
            if (fs!.isDir(st.mode)) cleanDir(altDir, 6);
            else unlinkOne(altDir);
          } catch {
            /* gone */
          }
        }
      }
    }
  }

  // 2. Ask the delegate to populate `scene` from the given buffer. `createThreeHydra`
  //    will:
  //      - write the bytes into the WASM virtual filesystem via FS_createDataFile
  //        (NOT through HTTP — that path was breaking for in-package textures)
  //      - create a ThreeJsRenderDelegate that writes Three.Mesh objects into
  //        a dedicated child group of `scene`
  //      - set up a Hydra driver and run the first Draw()
  //    It does NOT spin up a second WebGL canvas; rendering still happens in
  //    whatever renderer the caller attached to `scene`.
  //
  //    We mount the bytes at a *fixed* POSIX-only path inside the WASM VFS.
  //    Earlier we passed the raw Windows path through, but Needle's delegate
  //    normalises paths internally (drive letters, backslashes, basename
  //    quirks) so the actual mount location is opaque and we can't reliably
  //    clean up the leftover between loads — hence the ENOTDIR race. By
  //    using `/uploads/<basename>.usdz` we get a deterministic path that we
  //    can always unlink before the next load.
  const base = (filePath.match(/[^\\/]+$/) ?? ["model"])[0] || "model";
  const vfsFilePath = `/uploads/${base}`;
  // 2. Ask the delegate to populate `scene` from the given buffer. `createThreeHydra`
  try {
    USD.FS_createPath?.("/uploads", "/", true, true);
  } catch {
    /* dir already exists — ignore */
  }
  // Pre-clean: remove only the exact VFS entry that the previous load
  // wrote (plus its sibling expanded-archive directory, if any). The
  // Needle delegate sanitises the file name by replacing every
  // backslash and slash with `_`, then mounts the file under
  // `needle/<sanitized>`. We mirror that naming here so we can reliably
  // unlink the leftover without touching the plugin metadata that lives
  // under `/usd/` and `/home/`.
  //
  // Do NOT walk the VFS recursively. Earlier debugging sweeps were
  // removing `plugInfo.json` and the resolver plugin files, which made
  // the next `HdWebSyncDriver` ctor crash with
  // "Failed to find the plugInfo.json file that declares the plugin for
  // ArDefaultResolver". `handle.dispose()` already cleans up the files
  // and directories it created (see `unlinkFiles` in
  // node_modules/@needle-tools/usd/src/create.three.js around line
  // 608), so manual sweeping buys us nothing.
  const sanitized = filePath.replace(/\\/g, "/").replace(/\//g, "_");
  const candidateFiles: string[] = [];
  for (const prefix of ["needle/", "/needle/", ""]) {
    candidateFiles.push(prefix + sanitized);
    candidateFiles.push(prefix + sanitized.replace(/\.[^.]+$/, ""));
  }
  candidateFiles.push(vfsFilePath);
  if (fs) {
    for (const p of candidateFiles) {
      try {
        fs.unlink(p);
      } catch {
        /* gone */
      }
    }
  }
  const handle = await createThreeHydra({
    USD,
    url: vfsFilePath,
    buffer,
    scene,
    autoPlay,
    // waitForMaterials=false so the first frame shows the geometry quickly;
    // materials finish streaming in afterwards and trigger another draw.
    waitForMaterials: false,
    complexity: "medium",
  });

  const metadata = handle.stageMetadata();

  // Promote this handle to "active" — the next loadUsdIntoScene call will
  // dispose it before touching the WASM VFS again.
  activeHandle = handle;
  activeFilePath = filePath;

  if (onReady) {
    onReady(handle);
  }

  // Diagnostic — kept compact so it doesn't drown the console. The
  // cacheBust field documents why we append ?v=… to the bindings URL.
  console.warn(`[USDWasmBridge] Loaded ${filePath} (cacheBust=${CACHE_BUST})`);

  return { handle, metadata };
}