import { useEffect, useState, useCallback } from "react";
import {
  subscribeFingerprint,
  getCachedFingerprint,
  fetchFingerprint,
  prefetchFingerprints,
  FileReplacedEvent,
} from "./fingerprintStore";

// Re-export for backward compatibility
export type { FileReplacedEvent };

/**
 * Computes a stable, content-aware fingerprint for a file path. Returns a
 * string of the form "mtimeMs-size". The fingerprint updates:
 *   1. When `filePath` changes
 *   2. When the file is replaced in place (thumbnail-cleared event from backend)
 *   3. When the file is fetched for the first time
 *
 * The global fingerprintStore keeps a cache of known fingerprints and a
 * listener for "thumbnail-cleared" events, so even if the user replaces a
 * file while it is NOT currently selected, the store still has the new
 * fingerprint ready when the user later selects it.
 */
export function useFileFingerprint(filePath: string | undefined): string {
  const [fingerprint, setFingerprint] = useState<string>(() => {
    if (filePath) {
      const cached = getCachedFingerprint(filePath);
      if (cached) return cached;
    }
    return "0-0";
  });

  // Subscribe to fingerprint updates from the global store
  useEffect(() => {
    // Skip subscription when path is undefined
    if (!filePath) return;

    const unsubscribe = subscribeFingerprint((changedPath, fp) => {
      const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
      if (normalize(changedPath) === normalize(filePath)) {
        setFingerprint(fp);
      }
    });
    return unsubscribe;
  }, [filePath]);

  // Refresh on filePath change
  useEffect(() => {
    if (!filePath) {
      setFingerprint("0-0");
      return;
    }

    // Use cache if available. This is the second-chance path: even if the
    // "thumbnail-cleared" event fired before we subscribed, the fingerprint
    // store has the new fingerprint cached, so we can pick it up here.
    const cached = getCachedFingerprint(filePath);
    if (cached) {
      setFingerprint(cached);
      return;
    }

    // Otherwise fetch from backend
    let cancelled = false;
    fetchFingerprint(filePath).then((fp) => {
      if (!cancelled && fp) {
        setFingerprint(fp);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return fingerprint;
}

/** Helper to prefetch fingerprints for a list of paths */
export { prefetchFingerprints };
