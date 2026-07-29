// Pass-type detection for EXR viewer. Ported from
// exr_decoder.py (backup 145) lines 244-776 — only the parts that
// can run without reading pixel data (we don't have pixel data here,
// the GPU decoder already extracted the channels). We rely on layer
// names and channel name patterns to choose the visualization mode.
//
// Pass-type value semantics:
//   0 = RGB (Beauty/Albedo/Lighting) — run OCIO/ACES tonemap
//   1 = Grayscale — single channel (AO/Roughness/ZDepth) — bypass
//   2 = Normal Map — visualize as RGB, bypass OCIO
//   3 = Motion Vector — visualize as RGB, bypass OCIO
//   4 = UV Map — visualize as RGB, bypass OCIO
//   5 = Depth — visualize as RGB, bypass OCIO
//   6 = Tangent — visualize as RGB, bypass OCIO
//   7 = Position — visualize as RGB, bypass OCIO
//   8 = Cryptomatte — grayscale preview, bypass
//   9 = Unknown — fall through to RGB
//  10 = HDR (HDRI) — raw scene-linear HDR, do NOT apply OCIO/ACES LUT.
//       Detected via:
//        - Rust `pass_type = "hdr"` from `detect_pass_type` (RGB channels
//          with all non-negative values and at least one sample > 1.5),
//        - missing `chromaticities` / `whiteLuminance` EXR attributes
//          (set explicitly by renderers like RenderMan/Arnold, omitted
//          by raw HDRI captures from cameras / LightWave / Blender).
//       Without this bypass, applying the ACES LUT to a raw HDR file
//       double-tone-maps an already-scene-linear buffer → dark/noisy
//       output. Worse, the renderer caches the LUT for the next file,
//       so opening any other EXR after the HDR file would also pick up
//       that LUT ("ACES of HDR leaks into other files" bug).
export enum PassType {
  RGB = 0,
  Grayscale = 1,
  Normal = 2,
  Motion = 3,
  UV = 4,
  Depth = 5,
  Tangent = 6,
  Position = 7,
  Cryptomatte = 8,
  Unknown = 9,
  HDR = 10,
}

// Keywords copied verbatim from Python 145 exr_decoder.py lines 244-252.
const NORMAL_KEYWORDS = [
  "normal", "n", "geomnormal", "geometrynormal", "gn",
  "normal3d", "nm", "nn", "g",
];
const POSITION_KEYWORDS = [
  "position", "pos", "p", "worldposition", "worldpos", "pt", "p3d",
];
const TANGENT_KEYWORDS = [
  "tangent", "tan", "tang", "bitangent", "binormal", "bt", "tangent3d",
];
const UV_KEYWORDS = [
  "uv", "st", "texcoord", "texture", "uvcoord", "uv3d", "uvmap",
  "uv_", "_uv", "map",
];
const MOTION_KEYWORDS = [
  "motion", "motionvector", "mv", "velocity", "vel", "vec",
  "v3d", "motion2d", "v2d", "mot",
];
const DEPTH_KEYWORDS = ["depth", "z", "depth3d", "distance"];
// AO/Occlusion — mirrors Python AO_KEYWORDS.
const AO_KEYWORDS = ["ao", "ambient", "occlusion", "ambientocclusion"];
// Material parameters (single-channel grayscale by convention).
const MATTE_KEYWORDS = [
  "roughness", "rough", "glossiness", "gloss", "glossy",
  "metallic", "metalness", "metal", "specular", "spec",
];
// Emission / Lighting — checked BEFORE AO so "ambient light" doesn't
// get mis-classified as Ambient Occlusion (grayscale).
const EMISSION_KEYWORDS = [
  "emission", "emissive", "glow", "light", "lighting",
  "ambient light", "ambient_light",
];
// Shadow / Subsurface / Transmission / Wireframe — the renderer's
// short filename suffixes (Shdw/SSS/Tran/Wire). These get the same
// visualization as Emission (RGB ACES) since they're direct light
// contributions or color-tinted masks; Wire is a binary mask that we
// show as grayscale.
const SHADOW_KEYWORDS = ["shadow", "shdw", "shadows"];
const TRANSMISSION_KEYWORDS = ["transmission", "trans", "tran"];
const WIREFRAME_KEYWORDS = ["wireframe", "wire"];
// Cryptomatte — checked FIRST to avoid false-positive as Position.
// The renderer names channels like `CryptoGeometryNodeName00.a` or
// `crypto_object00.R`; the channel prefix is "crypto" plus more
// identifier text with NO separator (digits immediately follow), so a
// strict whole-word match misses the prefix. We accept either
// "crypto<non-letter>" (allows `crypto00`, `cryptoobj`, `cryptogeom`)
// or a separator-bounded `crypto_object`/`crypto_material` style.
function isCryptomatteContext(text: string): string | null {
  const direct = keywordMatch(CRYPTOMATTE_KEYWORDS, text);
  if (direct) return direct;
  // Prefix match: `crypto` followed by anything.
  // Mirrors Python `ch_lower.startswith('crypto')` which handles both
  // standard naming (cryptoObject, cryptoMaterial) and renderer-specific
  // long-name variants (cryptogeometrynodename, cryptomaterialnodename).
  // Python also checks `ch_lower.startswith('cryptogeometrynodename')` /
  // `ch_lower.startswith('cryptoshadingnodename')` explicitly.
  const re = new RegExp(`(^|[_\\-. ])crypto`);
  if (re.test(text)) return "crypto";
  return null;
}

// Wireframe — check `wire`/`wireframe` in filename or layer name.
// The renderer's convention here is the short suffix `Wire` (filename
// `Rnd__Wire_0015.exr`), so `wire` alone must match.
function isWireframeContext(text: string): string | null {
  const re = new RegExp(`(^|[_\\-. ])wire( frame)?($|[_\\-. ])`);
  const m = re.exec(text);
  return m ? (m[2] ? "wireframe" : "wire") : null;
}

// Subsurface scattering — filename `SSS_0015.exr` (renderer drops the
// long `subsurface` prefix), so accept the bare `sss`.
function isSubsurfaceContext(text: string): string | null {
  const re = new RegExp(`(^|[_\\-. ])(sss|subsurface( scattering)?)($|[_\\-. ])`);
  const m = re.exec(text);
  return m ? (m[2].startsWith("s") ? "sss" : "subsurface") : null;
}
const CRYPTOMATTE_KEYWORDS = [
  "cryptomatte", "crypto_object", "crypto_material", "crypto_asset",
  "cryptoobject", "cryptomaterial", "cryptoasset",
  "cryptogeometrynodename", "cryptoshadingnodename",
  "crypto_node_name", "crypto_geometry", "crypto_shading",
  "cryptogeometry", "cryptoshading",
];

/** Lowercase every channel name so case-insensitive matching works. */
function lowerChans(channels: readonly string[]): string[] {
  return channels.map((c) => c.toLowerCase());
}

/** Split a filename into name parts (strip extension, drop pure numbers). */
function splitFilename(fileName: string): string[] {
  const base = fileName.replace(/\.[^.]+$/, "").toLowerCase();
  const parts = base.split(/[_\-. ]/);
  return parts.filter((p) => p && !/^\d+$/.test(p));
}

/** Whole-word match for a list of keywords inside a space/underscore/dash context. */
function keywordMatch(keywords: readonly string[], text: string): string | null {
  for (const kw of keywords) {
    const re = new RegExp(`(^|[_\\-. ])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[_\\-. ])`);
    if (re.test(text)) return kw;
  }
  return null;
}

/** Split a channel name into {layer, component}. 'Beauty.R' → layer='Beauty', comp='R'. */
function splitLayerComp(chName: string): { layer: string; component: string; compType: string } {
  const lastDot = chName.lastIndexOf(".");
  if (lastDot < 0) return { layer: "", component: chName, compType: classifyComponent(chName) };
  const layer = chName.slice(0, lastDot);
  const component = chName.slice(lastDot + 1);
  return { layer, component, compType: classifyComponent(component) };
}

/** Classify a component name into xyz / rgb / uv / gray. */
function classifyComponent(comp: string): string {
  const c = comp.toLowerCase();
  if (c === "x" || c === "y" || c === "z") return "xyz";
  if (c === "r" || c === "g" || c === "b") return "rgb";
  if (c === "red" || c === "green" || c === "blue") return "rgb";
  if (c === "u" || c === "v" || c === "s" || c === "t") return "uv";
  return "gray";
}

export interface PassTypeResult {
  passType: PassType;
  /** Human-readable label for the UI / debug log. */
  label: string;
  /** True if this pass should bypass OCIO/ACES and render raw. */
  bypassOcio: boolean;
}

/**
 * Detect the pass type from the currently-selected layer's channel
 * names + the file name. Mirrors `detect_pass_type_from_names` in
 * the Python 145 decoder.
 *
 * @param layerName  Currently selected layer ('' for single-layer files).
 * @param channels   Channel names visible to the GPU decoder for the
 *                   selected layer (e.g. ['B', 'G', 'R'] or ['Beauty.R', ...]).
 * @param fileName   Original EXR file name (without path).
 */
export function detectPassType(
  layerName: string,
  channels: readonly string[],
  fileName: string,
  /**
   * Optional pass_type detected by the Rust backend (mirrors Python
   * `detect_pass_type_from_names`). Single-channel bare EXRs (Z, AO,
   * Roughness, ...) need this signal because the keyword-based heuristics
   * can misclassify them. When provided and non-empty, this takes
   * priority over the JS heuristics so single-layer single-channel files
   * render correctly. Use empty string ("") or undefined to fall back
   * to JS-only detection.
   */
  rustPassType?: string,
): PassTypeResult {
  // Rust-detected pass type takes priority for non-trivial signals.
  // It mirrors the Python decoder's component-categorisation logic and
  // correctly distinguishes depth / ao / grayscale when the JS heuristics
  // can't (e.g. a bare `y` channel in `Rnd__Z_*.exr`).
  if (rustPassType && rustPassType !== "rgb" && rustPassType !== "") {
    const lname = layerName?.toLowerCase() || "";
    const fname = (fileName || "").toLowerCase();
    const kwCtx = (lname + " " + fname).trim();
    // Cryptomatte is always raw — no OCIO, no gamma, no LUT.
    if (rustPassType === "cryptomatte") {
      return { passType: PassType.Cryptomatte, label: "Cryptomatte (rust)", bypassOcio: true };
    }
    if (rustPassType === "depth") {
      return { passType: PassType.Depth, label: "Depth (rust)", bypassOcio: true };
    }
    if (
      rustPassType === "ao" ||
      /(^|\W)(ao|occlusion|ambient|roughness|wire)(\W|$)/i.test(kwCtx)
    ) {
      // Note: Shadow/SSS/Transmission RGB passes are handled by the
      // Rust side returning "rgb" instead of "ao" (see openexr_core.rs
      // detect_pass_type), so they bypass this branch entirely.
      return { passType: PassType.Grayscale, label: `${rustPassType} (rust)`, bypassOcio: true };
    }
    if (rustPassType === "normal") {
      return { passType: PassType.Normal, label: "Normal (rust)", bypassOcio: true };
    }
    if (rustPassType === "position") {
      return { passType: PassType.Position, label: "Position (rust)", bypassOcio: true };
    }
    if (rustPassType === "motion") {
      return { passType: PassType.Motion, label: "Motion (rust)", bypassOcio: true };
    }
    if (rustPassType === "uv") {
      return { passType: PassType.UV, label: "UV (rust)", bypassOcio: true };
    }
    if (rustPassType === "grayscale") {
      return { passType: PassType.Grayscale, label: "Grayscale (rust)", bypassOcio: true };
    }
    // HDR files fall through to the same RGB path so users can apply an
    // ACES colour-managed view to HDRI captures. Non-HDR bypass entries
    // above (Cryptomatte, Depth, Normal, Position, Motion, UV, Grayscale,
    // …) are kept — those are non-colour data and shouldn't be tone-mapped.
  }

  if (!channels || channels.length === 0) {
    return { passType: PassType.Unknown, label: "Unknown", bypassOcio: false };
  }

  // ---- Filter channels to the currently-selected layer ----
  //
  // The backend returns the full channel list of the EXR file (e.g. all
  // 81 channels of a multi-layer render), not just the channels for the
  // layer currently selected in the UI. If we feed the full list to the
  // keyword matcher, layer names like "Normal (geometric)", "Position",
  // "Z-depth", "CryptoMaterialNodeName00" all show up in the keyword
  // context and produce a misleading pass type (e.g. selecting the
  // "Beauty" layer would be misread as "Normal" because the file also
  // contains a Normal layer).
  //
  // We narrow `channels` to the channels that actually belong to
  // `layerName` before running detection. Single-layer files (no
  // layerName) keep the full list.
  const layerKey = (layerName || "").toLowerCase();
  const scopedChannels = layerKey
    ? channels.filter((c) => {
        const idx = c.lastIndexOf(".");
        if (idx < 0) return false;
        return c.slice(0, idx).toLowerCase() === layerKey;
      })
    : channels;
  const effectiveChannels = scopedChannels.length > 0 ? scopedChannels : channels;

  // ---- Build per-channel info ----
  const split = effectiveChannels.map((c) => splitLayerComp(c));
  const chLower = lowerChans(effectiveChannels);

  // Per-channel info includes layer, component, comp_type.
  const layers = new Set<string>();
  const compTypes: string[] = [];
  for (const s of split) {
    layers.add(s.layer || "none");
    compTypes.push(s.compType);
  }

  const rgbCount = compTypes.filter((c) => c === "rgb").length;
  const uvCount = compTypes.filter((c) => c === "uv").length;
  const total = compTypes.length;

  // ---- Build keyword context from layer + filename ----
  //
  // Use ONLY the selected layer name (and the file name) for keyword
  // matching. Do NOT spill every other layer in the EXR into the
  // context — that is exactly what caused Beauty to be misread as
  // Normal in multi-layer files.
  const kwContext: string[] = [];
  if (layerName) kwContext.push(layerName.toLowerCase());
  if (fileName) kwContext.push(...splitFilename(fileName));
  const kwCtxStr = " " + kwContext.join(" ") + " ";
  // Also include raw channel names for fall-through keyword checks.
  const allChStr = " " + chLower.join(" ") + " ";

  // ---- 1. Cryptomatte FIRST (false-positive vs Position) ----
  const crypto = isCryptomatteContext(kwCtxStr) ?? isCryptomatteContext(allChStr);
  if (crypto) return { passType: PassType.Cryptomatte, label: `Cryptomatte (${crypto})`, bypassOcio: true };

  // ---- 2. Keyword-driven pass types ----
  // For RGB-style channels (3+ RGB or 2+ UV): check Normal/Position/Tangent.
  if (rgbCount >= 3 || uvCount >= 2) {
    const norm = keywordMatch(NORMAL_KEYWORDS, kwCtxStr);
    if (norm) return { passType: PassType.Normal, label: `Normal (${norm})`, bypassOcio: true };
  }
  if (rgbCount >= 3 || uvCount >= 2) {
    const pos = keywordMatch(POSITION_KEYWORDS, kwCtxStr);
    if (pos) return { passType: PassType.Position, label: `Position (${pos})`, bypassOcio: true };
  }
  if (rgbCount >= 3 || uvCount >= 2) {
    const tan = keywordMatch(TANGENT_KEYWORDS, kwCtxStr);
    if (tan) return { passType: PassType.Tangent, label: `Tangent (${tan})`, bypassOcio: true };
  }
  // For 3+ XYZ channels (e.g. N.X, N.Y, N.Z), the layer is a vector pass
  // (Normal / Position / Tangent). The rgbCount check above misses these
  // because XYZ components don't classify as "rgb" — so we run the
  // keyword check explicitly when every channel is XYZ.
  if (total >= 3 && rgbCount === 0 && uvCount === 0 && compTypes.every((c) => c === "xyz")) {
    const norm = keywordMatch(NORMAL_KEYWORDS, kwCtxStr);
    if (norm) return { passType: PassType.Normal, label: `Normal (${norm}, 3xyz)`, bypassOcio: true };
    const pos = keywordMatch(POSITION_KEYWORDS, kwCtxStr);
    if (pos) return { passType: PassType.Position, label: `Position (${pos}, 3xyz)`, bypassOcio: true };
    const tan = keywordMatch(TANGENT_KEYWORDS, kwCtxStr);
    if (tan) return { passType: PassType.Tangent, label: `Tangent (${tan}, 3xyz)`, bypassOcio: true };
  }
  const uv = keywordMatch(UV_KEYWORDS, kwCtxStr);
  if (uv) return { passType: PassType.UV, label: `UV (${uv})`, bypassOcio: true };

  const motion = keywordMatch(MOTION_KEYWORDS, kwCtxStr);
  if (motion) return { passType: PassType.Motion, label: `Motion (${motion})`, bypassOcio: true };

  const depth = keywordMatch(DEPTH_KEYWORDS, kwCtxStr);
  if (depth) return { passType: PassType.Depth, label: `Depth (${depth})`, bypassOcio: true };

  // Pass types that the renderer uses short suffixes for. Check these
  // BEFORE Emission so `Shadow`, `SSS`, `Wire`, `Tran` get the right
  // visualization (otherwise they fall through to generic RGB).
  const wire = isWireframeContext(kwCtxStr) ?? isWireframeContext(allChStr);
  if (wire) return { passType: PassType.Grayscale, label: `Wireframe (${wire})`, bypassOcio: true };

  const sss = isSubsurfaceContext(kwCtxStr) ?? isSubsurfaceContext(allChStr);
  if (sss) {
    if (rgbCount >= 3) {
      return { passType: PassType.RGB, label: `SSS (${sss})`, bypassOcio: false };
    }
    return { passType: PassType.Grayscale, label: `SSS (${sss})`, bypassOcio: true };
  }

  const shadow = keywordMatch(SHADOW_KEYWORDS, kwCtxStr) ?? keywordMatch(SHADOW_KEYWORDS, allChStr);
  if (shadow) {
    if (rgbCount >= 3) {
      return { passType: PassType.RGB, label: `Shadow (${shadow})`, bypassOcio: false };
    }
    return { passType: PassType.Grayscale, label: `Shadow (${shadow})`, bypassOcio: true };
  }

  const transmission = keywordMatch(TRANSMISSION_KEYWORDS, kwCtxStr) ?? keywordMatch(TRANSMISSION_KEYWORDS, allChStr);
  if (transmission) {
    if (rgbCount >= 3) {
      return { passType: PassType.RGB, label: `Transmission (${transmission})`, bypassOcio: false };
    }
    return { passType: PassType.Grayscale, label: `Transmission (${transmission})`, bypassOcio: true };
  }

  // Emission BEFORE AO so "ambient light" doesn't match AO.
  const emission = keywordMatch(EMISSION_KEYWORDS, kwCtxStr);
  if (emission) {
    if (rgbCount >= 3) {
      return { passType: PassType.RGB, label: `Emission (${emission})`, bypassOcio: false };
    }
    return { passType: PassType.Grayscale, label: `Emission (${emission})`, bypassOcio: true };
  }

  const ao = keywordMatch(AO_KEYWORDS, kwCtxStr);
  if (ao) return { passType: PassType.Grayscale, label: `AO (${ao})`, bypassOcio: true };

  const matte = keywordMatch(MATTE_KEYWORDS, kwCtxStr);
  if (matte) return { passType: PassType.Grayscale, label: `Material (${matte})`, bypassOcio: true };

  // ---- 3. Fallback: shape-based heuristic ----
  // We don't have pixel stats here (GPU side). Use channel pattern.
  if (total === 1) {
    const only = split[0];
    const comp = only.component.toLowerCase();
    // Single Y channel with depth keyword handled above.
    // Default: treat as Grayscale raw (ZDepth/AO/Roughness w/o keyword).
    if (comp === "y" || comp === "z") {
      return { passType: PassType.Grayscale, label: "Grayscale (1ch)", bypassOcio: true };
    }
    return { passType: PassType.Grayscale, label: "Grayscale (1ch)", bypassOcio: true };
  }

  if (total === 2 && uvCount === 2) {
    return { passType: PassType.UV, label: "UV (2ch)", bypassOcio: true };
  }

  if (total >= 3) {
    return { passType: PassType.RGB, label: "RGB (3ch)", bypassOcio: false };
  }

  // Final fallthrough — check UV/Motion keywords in raw channel names too.
  const mvRaw = keywordMatch(MOTION_KEYWORDS, allChStr);
  if (mvRaw) return { passType: PassType.Motion, label: `Motion (${mvRaw})`, bypassOcio: true };
  const uvRaw = keywordMatch(UV_KEYWORDS, allChStr);
  if (uvRaw) return { passType: PassType.UV, label: `UV (${uvRaw})`, bypassOcio: true };

  return { passType: PassType.Unknown, label: "Unknown", bypassOcio: false };
}
