import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import App from './App.tsx';
import { TransferProvider, useTransferDispatch } from './contexts/TransferContext';
import { useTransferEvents } from './hooks/useTransferEvents';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

// Load fzstd for EWA decoding
import './components/EwaViewer/init';

// Suppress Tauri callback warnings in dev mode (hot reload causes these harmless errors)
if (import.meta.env.DEV) {
  const _origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes("Couldn't find callback id")) {
      return;
    }
    _origError(...args);
  };
}

// Force `@needle-tools/materialx` to load its WASM + data file from the local
// bundle emitted by Vite (via the package's `?url` import branch) instead of
// the default CDN — Tauri's static Content Security Policy forbids fetching
// arbitrary cross-origin URLs. Without this, the first USD/USDZ with a
// MaterialX shader would log
//   "Refused to connect because it violates the document's Content Security
//    Policy" and the material would fall back to a basic shader.
// Setting it to `"package"` matches one of the runtime branches checked in
// `@needle-tools/materialx/src/materialx.js` (line ~90): it triggers the
// `import('../bin/JsMaterialX*.wasm?url')` path that Vite has already resolved
// at build time to a hashed `dist/assets/` URL.
(globalThis as { NEEDLE_MATERIALX_LOCATION?: string }).NEEDLE_MATERIALX_LOCATION = 'package';

/**
 * Best-effort cache cleanup on page unload. We hook into both `pagehide`
 * (fires on full reloads, tab close, and bfcache restores) and
 * `beforeunload` (legacy fallback). The call to `invoke` is fire-and-forget;
 * the OS will keep the Rust process alive for the brief moment it takes
 * the command to run, even though the WebView itself is tearing down.
 *
 * Why not rely on `RunEvent::Exit` on the Rust side alone? That fires when
 * the last window closes, but if the WebView reloads (Ctrl+R) the windows
 * stay open — only the React app re-mounts — so Rust never sees an exit.
 * Hooking into the page lifecycle covers both cases.
 */
function registerUnloadCacheCleanup() {
  let fired = false;
  const cleanup = () => {
    if (fired) return;
    fired = true;
    // navigator.sendBeacon would be ideal for a guaranteed fire-and-forget
    // POST, but Tauri commands are not regular HTTP endpoints — they go
    // through the IPC bridge. Plain invoke() works well enough for our
    // case: the call is queued immediately and the Rust side runs it
    // even if the WebView finishes unloading before the response comes back.
    invoke('clear_transcode_cache').catch(() => {
      // Swallow errors during teardown — there is nothing useful we can
      // do with them and we don't want to spam the console right as the
      // user is closing the app.
    });
  };
  window.addEventListener('pagehide', cleanup);
  window.addEventListener('beforeunload', cleanup);
}

registerUnloadCacheCleanup();

/**
 * Inner component that owns the Tauri event subscription. Must live
 * inside <TransferProvider> so the dispatch is in scope.
 */
function TransferEventBridge() {
  const dispatch = useTransferDispatch();
  useTransferEvents(dispatch);
  return null;
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

// NOTE: StrictMode was removed because it double-invokes effects in dev
// mode, which causes the VideoPlayerPreview's "load video" effect (which
// fetches /video/stream and sets a fresh cache-busting URL on each run)
// to fire twice per render. The cleanup-then-remount dance interacts
// badly with our progressive transcode pipeline and trips React's
// "Maximum update depth exceeded" guard, which in turn prevents the
// video element from ever loading. Disabling StrictMode here is safe
// because we already use Effect-based cleanup for all our async work.
createRoot(rootElement).render(
  <ErrorBoundary>
    <TransferProvider>
      <TransferEventBridge />
      <App />
    </TransferProvider>
  </ErrorBoundary>,
);
