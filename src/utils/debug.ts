/**
 * Debug logger that gates verbose console output behind development builds.
 *
 * Why: When WebView2 has no DevTools attached, console output is buffered
 * without a consumer. Verbose logs from per-frame playback paths (Phase 6C
 * re-renders, decode callbacks) can fill the IPC channel buffer and block
 * the renderer process — manifesting as "app freezes unless F12 DevTools
 * are open". Stripping these logs in production builds prevents this.
 *
 * Vite: define { __DEV__: JSON.stringify(!isProduction) } in vite.config.ts
 * so the dev check is inlined as `false` in production and terser can
 * dead-code-eliminate the gated branches.
 */

declare const __DEV__: boolean;
const IS_DEV: boolean = typeof __DEV__ !== "undefined" ? __DEV__ : false;

let alwaysOn = false;

// Allow forcing logs on at runtime for field debugging (e.g. `dbg.enable()` from devtools).
function enable(): void {
  alwaysOn = true;
}
function disable(): void {
  alwaysOn = false;
}

export const dbg = {
  log: (...args: unknown[]): void => {
    if (IS_DEV || alwaysOn) {
      // eslint-disable-next-line no-console
      console.log(...args);
    }
  },
  warn: (...args: unknown[]): void => {
    if (IS_DEV || alwaysOn) {
      // eslint-disable-next-line no-console
      console.warn(...args);
    }
  },
  error: (...args: unknown[]): void => {
    // Errors always surface, even in prod.
    // eslint-disable-next-line no-console
    console.error(...args);
  },
  enable,
  disable,
  get enabled(): boolean {
    return IS_DEV || alwaysOn;
  },
};

export default dbg;