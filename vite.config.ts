import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import {defineConfig, type Plugin} from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
/**
 * Vite middleware plugin: serves arbitrary USD/USH/PNG/JPEG/etc. files from
 * the local filesystem under the URL prefix `/@usd-file/`. Used by the
 * bundled OpenLegged USD viewer (in public/usd-viewer/) — its `UsdFsHelper`
 * fetches USD resources via fetch(), and Tauri/webview can only load same
 * origin URLs. By routing through Vite/Tauri static server we get CORS-free
 * same-origin file delivery without spinning up a separate Node process.
 */
function usdFileServer(): Plugin {
  return {
    name: 'usd-file-server',
    configureServer(server) {
      // Emscripten requires .wasm to be served with `Content-Type: application/wasm`
      // and .data files to be served as `application/octet-stream`. Vite's built-in
      // static server already gets .wasm right via sirv's mime lookup, but the
      // `?init`/import-rejected paths used by some tools (and the vite wasm-helper
      // plugin) can short-circuit content-type negotiation. Belt-and-braces: set
      // the header explicitly for any request under /usd-bindings/.
      server.middlewares.use('/usd-bindings/', (req, res, next) => {
        const pathname = (req.url || '').split('?')[0].toLowerCase();
        if (pathname.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        } else if (pathname.endsWith('.data')) {
          res.setHeader('Content-Type', 'application/octet-stream');
        }
        next();
      });

      server.middlewares.use('/@usd-file/', (req, res) => {
        try {
          const url = new URL(req.url || '', 'http://localhost');
          // Path can arrive two ways:
          //   /@usd-file/?path=C%3A%5CUsers%5C...%5Cfile.usdz
          //   /@usd-file/C:/Users/.../file.usdz
          let filePath = url.searchParams.get('path') ?? url.pathname.replace(/^\/@usd-file\/?/, '');
          if (!filePath) {
            res.statusCode = 400;
            res.end('Missing path');
            return;
          }
          filePath = decodeURIComponent(filePath);
          if (!fs.existsSync(filePath)) {
            res.statusCode = 404;
            res.end(`Not found: ${filePath}`);
            return;
          }
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            res.statusCode = 400;
            res.end('Is a directory');
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          const mimeMap: Record<string, string> = {
            '.usd': 'application/octet-stream',
            '.usda': 'application/octet-stream',
            '.usdc': 'application/octet-stream',
            '.usdz': 'application/octet-stream',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.tga': 'image/tga',
            '.exr': 'image/exr',
            '.mtl': 'text/plain',
            '.obj': 'text/plain',
            '.txt': 'text/plain',
            '.json': 'application/json',
          };
          res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
          res.setHeader('Content-Length', String(stat.size));
          res.setHeader('Access-Control-Allow-Origin', '*');
          fs.createReadStream(filePath).pipe(res);
        } catch (err) {
          res.statusCode = 500;
          res.end(`Error: ${(err as Error).message}`);
        }
      });
    },
    configurePreviewServer(server) {
      // Same Content-Type hardening as the dev server, applied to `vite preview`
      // so smoke-testing the built bundle outside Tauri still gets streaming
      // WASM compilation.
      server.middlewares.use('/usd-bindings/', (req, res, next) => {
        const pathname = (req.url || '').split('?')[0].toLowerCase();
        if (pathname.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        } else if (pathname.endsWith('.data')) {
          res.setHeader('Content-Type', 'application/octet-stream');
        }
        next();
      });

      // Apply correct MIME types for all WASM files served from node_modules.
      // MaterialX WASM files are loaded dynamically by @needle-tools/usd.
      server.middlewares.use('/node_modules/@needle-tools/', (req, res, next) => {
        const pathname = (req.url || '').split('?')[0].toLowerCase();
        if (pathname.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        } else if (pathname.endsWith('.data')) {
          res.setHeader('Content-Type', 'application/octet-stream');
        }
        next();
      });

      // Mirror the dev-server route so `vite preview` can also serve USD files
      // (useful for ad-hoc debugging of the bundled viewer outside Tauri).
      server.middlewares.use('/@usd-file/', (req, res) => {
        try {
          const url = new URL(req.url || '', 'http://localhost');
          let filePath = url.searchParams.get('path') ?? url.pathname.replace(/^\/@usd-file\/?/, '');
          if (!filePath) {
            res.statusCode = 400;
            res.end('Missing path');
            return;
          }
          filePath = decodeURIComponent(filePath);
          if (!fs.existsSync(filePath)) {
            res.statusCode = 404;
            res.end(`Not found: ${filePath}`);
            return;
          }
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            res.statusCode = 400;
            res.end('Is a directory');
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          const mimeMap: Record<string, string> = {
            '.usd': 'application/octet-stream',
            '.usda': 'application/octet-stream',
            '.usdc': 'application/octet-stream',
            '.usdz': 'application/octet-stream',
          };
          res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
          res.setHeader('Content-Length', String(stat.size));
          fs.createReadStream(filePath).pipe(res);
        } catch (err) {
          res.statusCode = 500;
          res.end(`Error: ${(err as Error).message}`);
        }
      });
    },
  };
}

/**
 * Sync `public/usd-bindings/` with the version of `emHdBindings.{js,wasm}`
 * that ships inside `@needle-tools/usd`. We only need the public copy to
 * have content identical to the bundled one — Vite/Rollup may rename and
 * hash those files when emitting to `dist/assets/`, but the Emscripten
 * `WebAssembly.compileStreaming` path requires a stable, un-hashed URL.
 *
 * The bundle path is `/usd-bindings/emHdBindings.{js,wasm}`, the same
 * path USDWasmBridge.ts resolves through the `virtual:usd-bindings`
 * module below.
 */
function usdBindingsSync(): Plugin {
  const sourceDir = path.resolve(
    __dirname,
    'node_modules/@needle-tools/usd/src/bindings',
  );
  const targetDir = path.resolve(__dirname, 'public/usd-bindings');
  const copy = () => {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      for (const name of ['emHdBindings.js', 'emHdBindings.wasm']) {
        fs.copyFileSync(
          path.join(sourceDir, name),
          path.join(targetDir, name),
        );
      }
    } catch (err) {
      console.warn('[usd-bindings] sync failed:', err);
    }
  };
  return {
    name: 'usd-bindings-sync',
    buildStart: copy,
    configureServer(server) {
      copy();
      server.httpServer?.on('listening', copy);
    },
    configurePreviewServer(server) {
      copy();
      server.httpServer?.on('listening', copy);
    },
  };
}

/**
 * Virtual module that resolves to the public URL of the Needle USD
 * bindings glue JS. The matching `.wasm` lives next to it, so callers
 * can derive the WASM URL by simple string replacement. Keeping this in
 * a virtual module (rather than a top-of-file constant) makes it easy to
 * override the URL via Vite plugin order if we ever need to.
 */
function usdBindingsVirtual(): Plugin {
  const RESOLVED_VIRTUAL_ID = 'virtual:usd-bindings';
  const RESOLVED_ID = '\0virtual:usd-bindings';
  return {
    name: 'usd-bindings-virtual',
    resolveId(id) {
      if (id === RESOLVED_VIRTUAL_ID) return RESOLVED_ID;
      return null;
    },
    load(id) {
      if (id === RESOLVED_ID) {
        return 'export default "/usd-bindings/emHdBindings.js";';
      }
      return null;
    },
  };
}

export default defineConfig(({ command, mode }) => {
  // Debug standalone build: pass `VITE_BUILD_MODE=debug` (or set
  // `--mode debug` on the CLI). In `debug` mode we keep __DEV__ true and skip
  // minification so the bundle is readable in DevTools. Otherwise the default
  // is production (minified, __DEV__ false → dbg.log calls DCE'd).
  const explicitMode = process.env.VITE_BUILD_MODE || mode;
  const isProd = command === 'build' && explicitMode !== 'debug';
  return {
    base: './',
    define: {
      // Inline-folded by Vite/Terser so `if (__DEV__)` becomes dead code in prod.
      // See src/utils/debug.ts.
      __DEV__: JSON.stringify(!isProd),
      // Cache-bust token for the wabc WASM URL in WabcLoader.ts.
      // Evaluated at bundle-time (Vite startup for dev, rollup for build).
      // Changes on every dev-session / production build, forcing the browser
      // to fetch the freshly rebuilt wasm instead of a stale cached copy.
      __WABC_CACHE_BUST__: JSON.stringify(Date.now()),
    },
    plugins: [
      react(),
      tailwindcss(),
      wasm(),
      topLevelAwait(),
      usdBindingsVirtual(),
      usdFileServer(),
      usdBindingsSync(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        'usd-wasm': path.resolve(__dirname, 'src/usd-wasm/src'),
        'three/addons': path.join(__dirname, 'node_modules/three/examples/jsm'),
      },
    },
    clearScreen: false,
    server: {
      port: 1421,
      strictPort: true,
      watch: {
        ignored: ['**/src-tauri/**'],
      },
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    optimizeDeps: {
      exclude: ['office-oxide-wasm'],
    },
    worker: {
      format: 'es',
    },
    build: {
      target: 'esnext',
      sourcemap: !isProd,
      minify: isProd ? 'terser' : false,
      terserOptions: isProd ? {
        compress: {
          passes: 2,
          keep_classnames: true,
          keep_fnames: true,
        },
        mangle: {
          // Preserve Three.js class identifiers so static-block prototype
          // assignments like `class Vector2{ static { Vector2.prototype.isVector2 = true } }`
          // can resolve to the freshly-declared class binding.
          reserved: [
            'Vector2', 'Vector3', 'Vector4',
            'Quaternion', 'Matrix3', 'Matrix4',
            'Euler', 'Color', 'Box3', 'Sphere', 'Ray',
            'Plane', 'Frustum',
            'Object3D', 'Camera', 'PerspectiveCamera', 'OrthographicCamera',
            'Scene', 'Geometry', 'BufferGeometry', 'Mesh', 'Group', 'Points', 'Line', 'LineLoop', 'LineSegments', 'Sprite',
            'Light', 'DirectionalLight', 'PointLight', 'SpotLight', 'AmbientLight',
            'Material', 'MeshBasicMaterial', 'MeshStandardMaterial', 'MeshPhongMaterial', 'MeshLambertMaterial',
            'MeshPhysicalMaterial', 'LineBasicMaterial', 'PointsMaterial',
            'Texture', 'DataTexture', 'CanvasTexture', 'VideoTexture',
            'ShaderMaterial', 'RawShaderMaterial',
            'WebGLRenderer', 'WebGLRenderTarget',
            'Raycaster', 'LoadingManager', 'Clock',
          ],
        },
        format: {
          comments: false,
        },
      } : undefined,
      rollupOptions: {
        output: {
          manualChunks: {
            'three-vendor': [
              'three',
              'three-viewport-gizmo',
              'three/examples/jsm/controls/OrbitControls.js',
              'three/examples/jsm/loaders/DRACOLoader.js',
              'three/examples/jsm/loaders/FBXLoader.js',
              'three/examples/jsm/loaders/GLTFLoader.js',
              'three/examples/jsm/loaders/OBJLoader.js',
              'three/examples/jsm/loaders/PLYLoader.js',
              'three/examples/jsm/loaders/STLLoader.js',
              'three/examples/jsm/loaders/TDSLoader.js',
              'three/examples/jsm/utils/BufferGeometryUtils.js',
              'three/examples/jsm/utils/SkeletonUtils.js',
            ],
          },
        },
      },
    },
  };
});
