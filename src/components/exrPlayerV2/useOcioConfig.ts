/**
 * useOcioConfig — manages the user's chosen OCIO view transform.
 *
 * 2026-07-13 (V2): mirror of V1's `useOcioConfig` minus the per-file
 * persistence (we reset to Raw on every file open, matching V1
 * session-only behaviour).
 *
 * Identity passthrough ("Raw", "Linear sRGB") is treated as
 * "slug === OCIO_PASSTHROUGH_SLUGS.<label>" by the backend; the UI
 * only exposes "Raw" to the user (Linear sRGB is filtered out per
 * the user's request). Anything else (everything starting with
 * "ACES_" or matching a user-baked config slug) flows through
 * `LayerCacheManager.configure()` → `exrGpuPipeline.reRenderWithLut`
 * which composes the LUT into the next `ImageBitmap` paint.
 *
 * Hidden identity modes we explicitly filter out of the dropdown so
 * the menu only ships "Raw" + ACES-derived views.
 */
const HIDDEN_IDENTITY_LABELS: ReadonlySet<string> = new Set([
  "Linear sRGB",
  "Reinhard",
]);

export const OCIO_RAW_SLUG = "Raw";
export const OCIO_RAW_LABEL = "Raw";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listOcioGroups,
  type OcioConfigGroup,
  type OcioModeInfo,
} from "../../TauriFileSystem";

export interface OcioState {
  slug: string;
  groups: OcioConfigGroup[];
  allViews: OcioModeInfo[];
  activeView: OcioModeInfo | null;
  loading: boolean;
}

export interface UseOcioConfigReturn extends OcioState {
  setView: (viewSlug: string) => void;
  resetToRaw: () => void;
}

function isHiddenIdentity(label: string): boolean {
  return HIDDEN_IDENTITY_LABELS.has(label);
}

export function useOcioConfig(): UseOcioConfigReturn {
  const [groups, setGroups] = useState<OcioConfigGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [slug, setSlug] = useState<string>(OCIO_RAW_SLUG);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listOcioGroups()
      .then((g) => {
        if (cancelled) return;
        setGroups(g);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const allViews = useMemo<OcioModeInfo[]>(() => {
    // 2026-07-14: Reinhard tone-mapping was removed from the OCIO
    // dropdown. Render-engine EXR files now see only "Raw" + the baked
    // ACES views. Reinhard is reserved for the HDRI capture path
    // (hdrify + Reinhard E1 via `hdriPipeline.ts`).
    const out: OcioModeInfo[] = [];
    for (const group of groups) {
      for (const view of group.views) {
        // Skip entries that are identity/passthrough modes (Raw slug = passthrough)
        if (view.slug === "Raw") continue;
        // Skip hidden identity labels
        if (isHiddenIdentity(view.view) || isHiddenIdentity(view.display)) continue;
        if (isHiddenIdentity(view.configLabel)) continue;
        out.push(view);
      }
    }
    return out;
  }, [groups]);

  const activeView =
    slug === OCIO_RAW_SLUG
      ? null
      : allViews.find((v) => v.slug === slug) ?? null;

  const setView = useCallback((viewSlug: string) => {
    setSlug(viewSlug || OCIO_RAW_SLUG);
  }, []);

  const resetToRaw = useCallback(() => {
    setSlug(OCIO_RAW_SLUG);
  }, []);

  return {
    slug,
    groups,
    allViews,
    activeView,
    loading,
    setView,
    resetToRaw,
  };
}