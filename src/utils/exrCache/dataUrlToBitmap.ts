/**
 * dataUrlToBitmap — convert a `data:image/png;base64,...` URL into an
 * `ImageBitmap` suitable for `ctx.drawImage` on the EXR player canvas.
 *
 * Created 2026-07-05 for the channel-mode R/G/B/A/Y fix: the Rust
 * `extract_exr_channel_from_layer` path returns a PNG-encoded grayscale
 * (alpha=255); we base64-decode it to raw bytes and hand those bytes
 * directly to `createImageBitmap(new Blob([bytes]))` to skip the
 * `fetch()` round-trip.
 *
 * ## 2026-07-05 (hotfix): don't use `fetch(dataUrl)`
 *
 * Tauri / WebView2 treats `data:` URLs as network connections and
 * enforces `connect-src` CSP. Without `data:` in the directive,
 * `fetch("data:image/png;base64,...")` throws:
 *
 *   Refused to connect because it violates the document's
 *   Content Security Policy.
 *
 * The AO (`Rnd__AO_0015.exr`) channel-Y decode was hitting this
 * because the file's only channel is a lowercase `y` — the Rust side
 * extracted it correctly (`[EXR-Channel-Layer] Found 'y' in layer
 * 'rgba'`) but the resulting data URL never reached `createImageBitmap`.
 *
 * Fix: extract the base64 payload ourselves with `atob`, wrap in a
 * `Uint8Array`, hand to `createImageBitmap(new Blob([bytes], {type}))`.
 * No network round-trip, no CSP gate.
 *
 * Browser notes:
 *   - `atob` is ~50-200ms for the AO PNG (~5 MB binary). Acceptable
 *     for a cold decode; subsequent cache hits short-circuit at
 *     `imageBitmapCache.get()` in `_loadAndCacheBitmap` and never
 *     re-enter this helper.
 *   - `createImageBitmap` accepts a `Blob` source and returns the
 *     same GPU-backed bitmap type the rest of the pipeline uses.
 */

export async function dataUrlToImageBitmap(dataUrl: string): Promise<ImageBitmap> {
  // 1. Strip the `data:image/<mime>;base64,` prefix (or `;charset=...`)
  //    and pull out the raw base64 payload. Tolerant of extra params.
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx < 0) {
    throw new Error("[dataUrlToBitmap] malformed data URL (no comma)");
  }
  const meta = dataUrl.slice(5, commaIdx); // e.g. "image/png;base64"
  const payload = dataUrl.slice(commaIdx + 1);

  // 2. Detect mime + base64 marker. We currently only see PNG coming
  //    out of `extract_exr_channel_from_layer`; if Rust ever returns
  //    JPEG/EXR we'll need to extend this — but for now stay strict.
  if (!meta.includes("base64")) {
    throw new Error(`[dataUrlToBitmap] only base64 data URLs supported (got meta="${meta}")`);
  }
  const mime = meta.split(";")[0] || "image/png";

  // 3. base64 → bytes. atob returns a "binary string" where each char
  //    holds one byte; convert to a Uint8Array so Blob stores the raw
  //    bytes rather than the encoded string.
  let binary: string;
  try {
    binary = atob(payload);
  } catch (err) {
    throw new Error(
      `[dataUrlToBitmap] atob failed (payload length ${payload.length}): ${err}`,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  // 4. Hand the raw bytes to createImageBitmap via a Blob. The Blob
  //    constructor never hits the network and the resulting bitmap
  //    matches what `<img src="data:...">` would have produced.
  const blob = new Blob([bytes], { type: mime });
  return await createImageBitmap(blob);
}