/**
 * Layer priority auto-selection + channel-mode inference for EXR
 * sequence playback.
 *
 * Extracted from `EXRSequencePlayer.tsx` so the heuristics can be
 * unit-tested in isolation and reused by thumbnail pre-selection
 * without dragging in the player component. Behaviour must remain
 * bit-identical to the original inline implementation.
 */

import { LAYER_PRIORITY } from "../../components/exrPlayerV2/constants";
import type { ExrLayerInfo } from "../../TauriFileSystem";
import type { ChannelMode } from "../../components/exrPlayerV2/types";

/**
 * Pick the "best" layer to show when the user opens an EXR file.
 *
 * @param layers Layer list returned by the Rust `get_exr_metadata`
 *               command. May be empty (single-layer file) in which
 *               case the caller falls back to "rgba" or similar.
 * @returns The name of the layer to display, or "" if `layers` is
 *          empty.
 */
export function autoSelectBestLayer(layers: ExrLayerInfo[]): string {
  if (!layers || layers.length === 0) return "";

  // Priority list: walk in declaration order, case-insensitive.
  // First exact (case-insensitive) match wins.
  for (const priorityName of LAYER_PRIORITY) {
    const match = layers.find((l) => l.name.toLowerCase() === priorityName.toLowerCase());
    if (match) return match.name;
  }

  // Fallback: prefer the first layer that has RGB channels.
  const rgbLayer = layers.find((l) => l.has_rgb);
  if (rgbLayer) return rgbLayer.name;

  // Last resort: just take the first layer.
  return layers[0]?.name || "";
}

/**
 * Strip the layer prefix from a channel name. EXR channels are
 * encoded as `Beauty.R`, `depth.Z`, etc. Returns the LAST
 * `.`-separated segment, uppercased. Mirrors the inline parser
 * used in `handleLayerChange` / `getAvailableChannelModes` so the
 * caller doesn't have to reimplement it.
 */
function componentUpper(channel: string): string {
  const parts = channel.toUpperCase().split(".");
  return parts[parts.length - 1];
}

/**
 * Infer the channel mode to render when the user picks a new layer.
 *
 * Logic:
 *  - Cryptomatte layers always render as combined RGB.
 *  - Grayscale-only layers (Y/Z/DEPTH) collapse to "Y".
 *  - Otherwise default to "RGB".
 *
 * Mirrors the inline `handleLayerChange` block that used to live at
 * lines 1325-1349 of the old `EXRSequencePlayer.tsx`.
 */
export function inferChannelMode(
  layerName: string,
  channels: string[],
): ChannelMode {
  const comps = channels.map(componentUpper);
  const hasR = comps.includes("R");
  const hasG = comps.includes("G");
  const hasB = comps.includes("B");
  const hasA = comps.includes("A");
  const hasY = comps.includes("Y") || comps.includes("Z") || comps.includes("DEPTH");

  const isCrypto = layerName.toLowerCase().startsWith("crypto");
  if (isCrypto) {
    // Cryptomatte always renders via the combined RGB path.
    return "RGB";
  }
  if (!hasR && !hasG && !hasB && hasY) {
    return "Y";
  }
  // Has RGB or unknown channels — use combined view as a safe default.
  return "RGB";
}

/**
 * Determine which channel-mode buttons to surface for the currently
 * selected layer.
 *
 * Behaviour matches the old `getAvailableChannelModes`:
 *  - Cryptomatte: only R, G, B, A (no combined RGB).
 *  - Grayscale-only layers: only "Y".
 *  - RGB layers: "RGB" + per-component R/G/B/(A).
 *  - Empty channel list: "RGB" fallback.
 */
export function availableChannelModes(
  selectedLayer: string,
  primaryChannels: readonly string[],
  fallbackChannels: readonly string[],
): ChannelMode[] {
  const layerName = (selectedLayer || "").toLowerCase();
  const isCryptoLayer = layerName.startsWith("crypto");

  // Special case: Cryptomatte always shows R, G, B, A (no combined RGB mode).
  if (isCryptoLayer) {
    return ["R", "G", "B", "A"];
  }

  // Resolve the channels for THIS layer, falling through:
  //   1. primaryChannels (typically the metadata-time channel list)
  //   2. fallbackChannels (typically the last decode result)
  //   3. ["RGB"] as the last-ditch fallback.
  let channels: string[] = primaryChannels.length > 0 ? [...primaryChannels] : [];
  if (channels.length === 0) channels = [...fallbackChannels];
  if (channels.length === 0) return ["RGB"];

  const components = channels.map((c) => c.toUpperCase().split(".").pop() || "");

  const hasR = components.some((c) => c === "R");
  const hasG = components.some((c) => c === "G");
  const hasB = components.some((c) => c === "B");
  const hasA = components.some((c) => c === "A");
  const hasY = components.some((c) => c === "Y" || c === "Z" || c === "DEPTH");

  const modes: ChannelMode[] = [];

  if (hasR || hasG || hasB) {
    // Combined view first so the user can toggle back from individual channels.
    modes.push("RGB");
    if (hasR) modes.push("R");
    if (hasG) modes.push("G");
    if (hasB) modes.push("B");
    if (hasA) modes.push("A");
  } else if (hasY) {
    modes.push("Y");
  } else {
    modes.push("RGB");
  }

  return modes;
}