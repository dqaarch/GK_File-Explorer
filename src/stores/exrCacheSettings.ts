// EXR Cache Settings Store - persisted in localStorage

export type GpuAccelerationMode = "auto" | "force-gpu" | "force-cpu";

export interface ExrCacheSettings {
  maxMemoryMB: number;        // Max memory for EXR cache
  enableContinuousPreload: boolean;  // Enable/disable continuous preload
  preloadBatchSize: number;   // Frames per batch during preload
  channelCacheEnabled: boolean; // Cache individual channels separately
  /**
   * GPU-side OCIO LUT acceleration (Phase 4 of PLAN_GPU_EXR_RENDERER.md).
   *   - "auto"      : use WebGL2 if EXT_color_buffer_float is available
   *   - "force-gpu" : fail loudly if GPU is unavailable (user asked for it)
   *   - "force-cpu" : skip GPU, use legacy decodeExr path
   */
  gpuAcceleration: GpuAccelerationMode;

  /**
   * 2026-07-06: EXR Sequence Player preview-background overlay.
   * `exrPlayerBgColorEnabled = false` (default) keeps the existing
   * `checkerboard` class on the viewport — the translucent Nuke /
   * Photoshop-style grey grid the player has shipped with. When the
   * user flips the toggle in the player header, the viewport is
   * re-painted with `exrPlayerBgColor` (any CSS color string —
   * `#000`, `#1a1a1a`, `rgba(...)`, etc.) and the checkerboard is
   * hidden underneath. Persisted through this same store so the
   * choice survives across files and app restarts.
   */
  exrPlayerBgColorEnabled: boolean;
  exrPlayerBgColor: string;
}

const DEFAULT_SETTINGS: ExrCacheSettings = {
  maxMemoryMB: 6144,          // Default 6GB (will be overridden by system memory on init)
  enableContinuousPreload: true,
  preloadBatchSize: 2,
  channelCacheEnabled: true,
  gpuAcceleration: "auto",
  exrPlayerBgColorEnabled: false,
  exrPlayerBgColor: "#1a1a1a",
};

const STORAGE_KEY = "NEXUS_EXR_CACHE_SETTINGS";

let _currentSettings: ExrCacheSettings = { ...DEFAULT_SETTINGS };
let _systemMaxCacheMB: number = 65536; // Will be set from backend
const _listeners: Set<(settings: ExrCacheSettings) => void> = new Set();

// Called from frontend to set system max cache based on actual RAM
export function setSystemMaxCacheMB(maxMB: number): void {
  _systemMaxCacheMB = Math.max(8192, Math.min(262144, maxMB));
}

export function getSystemMaxCacheMB(): number {
  return _systemMaxCacheMB;
}

// Initialize from localStorage
export function initExrCacheSettings(systemMaxMB?: number): ExrCacheSettings {
  if (systemMaxMB !== undefined) {
    _systemMaxCacheMB = Math.max(8192, Math.min(262144, systemMaxMB));
  }

  // 2026-07-06: the user-facing "GPU Acceleration" picker in the
  // settings dropdown was removed (see `ExplorerHeader.tsx`). The
  // runtime always uses the `auto` strategy now: WebGL2 +
  // EXT_color_buffer_float when available, CPU fallback otherwise.
  // Any stale value (`force-gpu` / `force-cpu`) persisted from
  // older builds would override the new behaviour, so we explicitly
  // force `auto` here regardless of what was stored on disk.
  //
  // Note we deliberately do NOT call `persistSettings()` after
  // rewriting the value — leaving the stale entry in localStorage
  // is harmless (it gets rewritten on the next user action that
  // touches settings) and avoids a spurious write on every cold
  // start.
  _currentSettings.gpuAcceleration = "auto";

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      _currentSettings = { ...DEFAULT_SETTINGS, ...parsed };
      // Ensure maxMemoryMB is within valid range
      _currentSettings.maxMemoryMB = Math.max(1024, Math.min(_systemMaxCacheMB, _currentSettings.maxMemoryMB));
      // Re-assert auto after the spread above — see comment above.
      _currentSettings.gpuAcceleration = "auto";
    } else {
      _currentSettings.maxMemoryMB = calculateDefaultMaxMemory();
      persistSettings();
    }
  } catch {
    _currentSettings.maxMemoryMB = calculateDefaultMaxMemory();
    _currentSettings.gpuAcceleration = "auto";
  }
  return _currentSettings;
}

function calculateDefaultMaxMemory(): number {
  // Default to 25% of system max cache (conservative default for EXR frame caching)
  return Math.round(_systemMaxCacheMB * 0.25);
}

function persistSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_currentSettings));
  } catch {
    console.warn('[ExrCacheSettings] Failed to persist settings');
  }
}

export function getExrCacheSettings(): ExrCacheSettings {
  return { ..._currentSettings };
}

export function updateExrCacheSettings(updates: Partial<ExrCacheSettings>): ExrCacheSettings {
  _currentSettings = { ..._currentSettings, ...updates };
  persistSettings();
  _listeners.forEach(listener => listener(_currentSettings));
  return { ..._currentSettings };
}

export function subscribeToExrCacheSettings(
  listener: (settings: ExrCacheSettings) => void
): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

export function getMaxMemoryBytes(): number {
  return _currentSettings.maxMemoryMB * 1024 * 1024;
}
