import { useEffect, useState } from "react";
import { OpenWithApp, getOpenWithIconsBatch, getOpenWithIconsStream } from "../TauriFileSystem";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

// Global cache for icons across all dialog instances
// Bump CACHE_VERSION whenever the icon extraction strategy changes so that
// stale entries (especially null/missing icons from a previous code path)
// are cleared instead of being permanently remembered for the session.
// v8-icom-v2: aggressively re-request all apps when version changes —
// previously we relied on `failureTimestamps` to skip retry, which meant
// a transient failure (e.g. UWP first-run) stuck the user with no icon
// for the entire session.
const CACHE_VERSION = "v8-icom-v2";
const CACHE_VERSION_KEY = "__openwith_icon_cache_version__";

interface CacheEntry {
  icon: string | null;
  version: string;
}

const sharedOpenWithIconCache = new Map<string, CacheEntry>();
// Track which keys have been requested this session to avoid duplicate streaming requests
const requestedKeys = new Set<string>();
// Track failure timestamps so we don't hammer the backend with retries for
// genuinely broken apps, but still allow one retry per session after a delay.
const failureTimestamps = new Map<string, number>();
const RETRY_DELAY_MS = 30_000;

if (typeof window !== "undefined" && (window as unknown as Record<string, unknown>)[CACHE_VERSION_KEY] !== CACHE_VERSION) {
  // Code version changed: blow away the old cache so users benefit from
  // improvements to the extraction pipeline (UWP apps, etc).
  sharedOpenWithIconCache.clear();
  failureTimestamps.clear();
  requestedKeys.clear();
  (window as unknown as Record<string, unknown>)[CACHE_VERSION_KEY] = CACHE_VERSION;
}

const getOpenWithIconKey = (app: OpenWithApp): string => {
  return (app.handler_id || app.path).toLowerCase();
};

interface OpenWithIconReadyPayload {
  key: string;
  icon: string | null;
}

export function useOpenWithIcons(apps: OpenWithApp[], enabled: boolean, visibleCount?: number) {
  const [icons, setIcons] = useState<Record<string, string>>({});

  // Build a stable keys signature for dependency tracking.
  // This is computed every render but produces the same string for the same set of apps,
  // so useEffect will only re-run when the actual app set changes.
  const keysSignature = (() => {
    const keys: string[] = [];
    const seen = new Set<string>();
    const limit = typeof visibleCount === "number" ? visibleCount : apps.length;
    for (const app of apps) {
      const key = getOpenWithIconKey(app);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      if (keys.length >= limit) break;
    }
    return keys.sort().join("|");
  })();

  // Progressive icon loading: listen to streaming events from Rust
  useEffect(() => {
    if (!enabled) return;

    let unlistenReady: UnlistenFn | null = null;
    let cancelled = false;

    // Resolve keys from signature
    const keys = keysSignature ? keysSignature.split("|") : [];
    if (keys.length === 0) return;

    // Hydrate state from global cache first (instant)
    const cached: Record<string, string> = {};
    const missingKeys: string[] = [];
    const now = Date.now();
    for (const key of keys) {
      const entry = sharedOpenWithIconCache.get(key);
      if (entry && entry.version === CACHE_VERSION && entry.icon) {
        // Fresh hit: use cached icon directly.
        cached[key] = entry.icon;
        continue;
      }
      // Either stale-version entry (from a previous code path), a genuine
      // failure (icon === null), or first-time request. In all three cases
      // we want to re-request so the user sees fresh icons — the backend's
      // IAssocHandler::GetIconLocation + SHLoadIndirectString path now
      // returns good results for previously-broken apps (Photos, Paint,
      // Notepad, etc), so stale "null" entries are actively harmful.
      if (entry && entry.version !== CACHE_VERSION) {
        sharedOpenWithIconCache.delete(key);
        failureTimestamps.delete(key);
      }
      if (entry && entry.version === CACHE_VERSION && entry.icon === null) {
        // Genuine failure at this version — throttle retries so we don't
        // hammer the backend for the same broken app.
        const failedAt = failureTimestamps.get(key);
        if (failedAt && now - failedAt < RETRY_DELAY_MS) {
          continue;
        }
      }
      missingKeys.push(key);
    }
    if (Object.keys(cached).length > 0) {
      setIcons((prev) => ({ ...prev, ...cached }));
    }

    if (missingKeys.length === 0) return;

    // Find app objects for missing keys
    const appsByKey = new Map<string, OpenWithApp>();
    for (const app of apps) {
      const key = getOpenWithIconKey(app);
      if (missingKeys.includes(key)) {
        appsByKey.set(key, app);
      }
    }
    const missingApps = missingKeys.map((k) => appsByKey.get(k)!).filter(Boolean);

    // Mark these keys as requested so subsequent hooks skip them (StrictMode-safe)
    for (const key of missingKeys) {
      requestedKeys.add(key);
    }

    // Subscribe to streaming events BEFORE starting extraction
    const readyPromise = listen<OpenWithIconReadyPayload>("open-with-icon-ready", (event) => {
      if (cancelled) return;
      const { key, icon } = event.payload;
      const normalizedKey = key.toLowerCase();
      if (icon) {
        sharedOpenWithIconCache.set(normalizedKey, { icon, version: CACHE_VERSION });
        failureTimestamps.delete(normalizedKey);
        setIcons((prev) => ({ ...prev, [normalizedKey]: icon }));
      } else {
        sharedOpenWithIconCache.set(normalizedKey, { icon: null, version: CACHE_VERSION });
        failureTimestamps.set(normalizedKey, Date.now());
      }
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return null;
      }
      unlistenReady = unlisten;
      return unlisten;
    });

    // Start streaming extraction (non-blocking)
    getOpenWithIconsStream(missingApps).catch(async () => {
      // Fall back to batch on error
      if (cancelled) return;
      try {
        const newIcons = await getOpenWithIconsBatch(missingApps);
        if (cancelled) return;
        const resolved: Record<string, string> = {};
        for (const [key, dataUrl] of Object.entries(newIcons)) {
          if (dataUrl) {
            sharedOpenWithIconCache.set(key, { icon: dataUrl, version: CACHE_VERSION });
            failureTimestamps.delete(key);
            resolved[key] = dataUrl;
          } else {
            sharedOpenWithIconCache.set(key, { icon: null, version: CACHE_VERSION });
            failureTimestamps.set(key, Date.now());
          }
        }
        if (Object.keys(resolved).length > 0) {
          setIcons((prev) => ({ ...prev, ...resolved }));
        }
      } catch {
        // Mark as failed on error
        if (cancelled) return;
        for (const key of missingKeys) {
          sharedOpenWithIconCache.set(key, { icon: null, version: CACHE_VERSION });
          failureTimestamps.set(key, Date.now());
        }
      }
    });

    return () => {
      cancelled = true;
      readyPromise.then((unlisten) => unlisten?.()).catch(() => {});
      unlistenReady?.();
    };
  }, [enabled, keysSignature]);

  return icons;
}