/**
 * HDRI Detector — pure-JS check for "is this EXR file an HDRI
 * capture?" Created 2026-07-14.
 *
 * HDRI capture = a panoramic / over-exposed scene-referred EXR
 * that the user wants to view "as-is" (no ACES tone-map, no
 * chromaticity conversion). Render-engine EXR files (Beauty,
 * Albedo, AO, etc.) flow through the existing Rust OpenEXR FFI
 * pipeline with OCIO/ACES/LUT; this detector routes HDRI files to
 * `hdriPipeline.ts` instead so the two paths stay independent.
 *
 * ### Heuristic
 *
 * Three signals vote; a file is HDRI when **all** of:
 *
 *   1. **High peak** — `peak > 50`. Real HDRI captures routinely
 *      exceed 1000 (valley_of_desolation peaks at 1850). Render
 *      engine beauty passes almost never go above ~16 because ACES
 *      filmic clamps the highlights to ~16.29 in the RRT. A 50×
 *      threshold comfortably separates the two.
 *
 *   2. **Equirectangular aspect ratio** — `|aspect - 2.0| < 0.05`.
 *      This is the canonical equirectangular panorama ratio. Render
 *      engine outputs use 16:9 / 2.39:1 / 1:1 / etc. — none land
 *      within 5% of 2:1. (HDR cubemaps use 6:1 or 1:6 and are
 *      intentionally excluded so render engines outputting cubemaps
 *      don't accidentally take the HDRI path.)
 *
 *   3. **No render-engine color space** — `linearColorSpace` is not
 *      `acescg` or `aces2065-1`. These two are the render-industry
 *      standards (ACES 1.0 CG working space, ACES 2065-1 archival
 *      space). Render engines set them explicitly; camera captures
 *      and Blender/LightWave panoramic exports leave the field at
 *      hdrify's default (`rec709`) or empty.
 *
 * If any signal disagrees (e.g. render engine output with peak > 50
 * because the lighting rig pushed the sun into HDR territory), the
 * file is treated as a render-engine EXR and flows through the
 * existing pipeline. That's the correct conservative behaviour — a
 * misclassified HDRI is easy to spot (over-bright but readable),
 * while a misclassified render-engine EXR would skip chromaticity
 * conversion entirely and produce wildly wrong colours.
 *
 * ### Failure mode
 *
 * If hdrify can't decode the file (malformed header, missing
 * dependency, etc.) the detector returns `{ isHdri: false }` and
 * the player falls back to the Rust pipeline. That gives the user
 * a working preview rather than a black screen.
 */
import { decodeHdriFrame } from "./hdriPipeline";
import { dbg } from "../debug";

export interface HdriDetectionResult {
  isHdri: boolean;
  reason: string;
  meta?: {
    peak: number;
    aspect: number;
    linearColorSpace: string;
    layerCount: number;
  };
}

const PEAK_THRESHOLD = 50;
const ASPECT_TARGET = 2.0;
const ASPECT_TOLERANCE = 0.05;
const RENDER_CS = new Set(["acescg", "aces2065-1"]);

export async function detectHdriFile(filePath: string): Promise<HdriDetectionResult> {
  // 2026-07-14: pass `silent: true` so the "decode failed for ..." log
  // doesn't fire on every render-engine EXR. Detection probes the
  // file's peak + colour space via hdrify; for files using B44A/B44/
  // DWAA/DWAB compression (or any future hdrify-unsupported codec)
  // the probe is *expected* to fail and the noise would drown out
  // real errors in the user's console.
  const decoded = await decodeHdriFrame(filePath, { silent: true });
  if (!decoded) {
    return { isHdri: false, reason: "hdrify decode failed (likely non-HDRI compression)" };
  }

  const aspect = decoded.width / decoded.height;
  const highPeak = decoded.peak > PEAK_THRESHOLD;
  const isPanoramic = Math.abs(aspect - ASPECT_TARGET) < ASPECT_TOLERANCE;
  const isNonRenderCS = !RENDER_CS.has(decoded.linearColorSpace);

  // 3-signal AND. Render-engine EXR with HDR sun will usually fail
  // either the panoramic OR the color-space test, which keeps it on
  // the render path.
  const isHdri = highPeak && isPanoramic && isNonRenderCS;

  const signals: string[] = [
    `peak=${decoded.peak.toFixed(1)}${highPeak ? "✓" : "✗"}`,
    `aspect=${aspect.toFixed(2)}${isPanoramic ? "✓" : "✗"}`,
    `cs=${decoded.linearColorSpace}${isNonRenderCS ? "✓" : "✗"}`,
    isHdri ? "→ HDRI" : "→ render",
  ];
  const reason = signals.join(" ");

  dbg.log(`[HDRI-Detect] ${filePath}: ${reason}`);

  return {
    isHdri,
    reason,
    meta: {
      peak: decoded.peak,
      aspect,
      linearColorSpace: decoded.linearColorSpace,
      layerCount: 1,
    },
  };
}