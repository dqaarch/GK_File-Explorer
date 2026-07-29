/**
 * Gaussian Splatting PLY → compressed .ksplat (in-memory) converter.
 *
 * Streams progress to the main thread via the supplied callback. The heavy
 * lifting is done by @mkkellogg/gaussian-splats-3d's PlyParser /
 * SplatBufferGenerator. We wrap it so the UI can render a progress bar and
 * stay responsive while multi-hundred-MB PLYs are being processed.
 *
 * NOTE: We deliberately do NOT use a Web Worker. The library imports `three`
 * at module top-level, which requires DOM/window globals that aren't
 * available in a Worker context. Yielding to the event loop with `await new
 * Promise(r => setTimeout(r, 0))` between parser stages keeps the UI live
 * enough to animate a progress bar.
 */

export interface ConvertProgress {
  /** 0..100 */
  percent: number;
  /** Human-readable label for the UI, e.g. "Đang phân tích header..." */
  label: string;
  /** Estimated seconds remaining, or null when unknown. */
  etaSeconds: number | null;
}

export interface ConvertResult {
  /** Raw .ksplat buffer (KSplat binary layout). */
  ksplatBuffer: ArrayBuffer;
  /** Splat count that survived `splatAlphaRemovalThreshold`. */
  splatCount: number;
  /** Original PLY file size in bytes. */
  originalSizeBytes: number;
  /** Scene center encoded in the ksplat header, used to frame the camera
   *  so the splats don't end up off-screen after the initial render. */
  sceneCenter: { x: number; y: number; z: number };
}

export interface ConvertOptions {
  /**
   * Drop splats whose alpha is below this value before compression.
   * 1 is the library default; we keep the same default here.
   */
  splatAlphaRemovalThreshold?: number;
  /**
   * 1 = medium compression (recommended), 2 = max compression (slower).
   * 0 = uncompressed (huge; not exposed in the UI).
   */
  compressionLevel?: 1 | 2;
  /**
   * Spherical harmonics degree to decode from f_rest. 0 = DC only (fast,
   * looks fine in most cases); 1 = DC + 3 view-dependent coeffs (slower,
   * sharper at glancing angles); 2 = full (very slow, biggest buffers).
   */
  outSphericalHarmonicsDegree?: 0 | 1 | 2;
}

/**
 * Detect "3D Gaussian Splatting" PLY files via header sniff. The detector
 * has to recognise three different on-disk formats because the 3DGS
 * ecosystem is fragmented:
 *
 *   - INRIA V1: uncompressed, plain floats. Properties: x, y, z, f_dc_*,
 *     f_rest_*, opacity, scale_*, rot_*.
 *   - INRIA V2: compressed with codebook_centers element. Properties vary.
 *   - PlayCanvas "compressed" PLY (SuperSplat output): per-chunk
 *     quantisation with properties named packed_position, packed_rotation,
 *     packed_scale, packed_color and an `element chunk` declaration.
 *
 * We try the library's own format detector first (it knows about all three
 * formats) and fall back to a small signature check that looks for any of
 * the well-known 3DGS-specific property names.
 */
export type GaussianSplatFormat = "inria_v1" | "inria_v2" | "playcanvas_compressed" | "unknown";

export interface GaussianSplatHeaderInfo {
  format: GaussianSplatFormat;
  splatCount: number;
  headerText: string;
}

/** Quick signature check that returns true for any of the three 3DGS
 *  PLY variants when the library's own detector is unavailable. */
export function isGaussianSplatPly(headerText: string): boolean {
  if (headerText.length === 0) return false;
  // PlayCanvas compressed PLY: always has a "chunk" element.
  if (/\belement\s+chunk\b/.test(headerText)) return true;
  // INRIA V2: codebook_centers is the giveaway.
  if (/\belement\s+codebook_centers\b/.test(headerText)) return true;
  // PlayCanvas compressed: any "packed_*" property.
  if (/\bpacked_position\b|\bpacked_rotation\b|\bpacked_scale\b|\bpacked_color\b/.test(headerText)) {
    return true;
  }
  // INRIA V1 (or trimmed variant): f_dc_* + opacity + scale_* + rot_*.
  if (
    /\bf_dc_0\b/.test(headerText) &&
    /\bopacity\b/.test(headerText) &&
    /\bscale_0\b/.test(headerText) &&
    /\brot_0\b/.test(headerText)
  ) {
    return true;
  }
  return false;
}

/**
 * Extract the PLY header (all bytes up to and including `end_header\n`)
 * from the start of `buffer`. Reads in 1 KB chunks so multi-MB headers
 * (e.g. INRIA V2 with thousands of f_rest_* properties) still resolve
 * correctly. The previous 32 KB cap silently truncated long headers and
 * caused the detector to misclassify them as plain point clouds.
 */
export function extractPlyHeaderText(buffer: ArrayBuffer): string {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const CHUNK = 1024;
  let offset = 0;
  let text = "";
  // 4 MB hard cap on header text: a sane upper bound. The PLY spec
  // doesn't define a limit but in practice anything beyond that is
  // almost certainly not a header.
  const MAX_HEADER_BYTES = 4 * 1024 * 1024;

  while (offset < buffer.byteLength && offset < MAX_HEADER_BYTES) {
    const slice = new Uint8Array(buffer, offset, Math.min(CHUNK, buffer.byteLength - offset));
    text += decoder.decode(slice, { stream: true });
    if (text.includes("end_header")) break;
    offset += CHUNK;
  }
  return text;
}

/** Return the splat count declared in `element vertex <N>` if present. */
export function parsePlyVertexCount(headerText: string): number {
  const m = headerText.match(/element\s+vertex\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Ask the @mkkellogg/gaussian-splats-3d library to identify the PLY
 * format. Returns "inria_v1" | "inria_v2" | "playcanvas_compressed" |
 * "unknown" — the first three values mean we should route the file to
 * the GaussianSplats3D Viewer.
 *
 * NOTE: The library's internal `PlyParserUtils` helper is not exported
 * (only `PlyParser`, `PlyLoader`, etc. are). Rather than reaching into
 * private symbols we re-implement the format detection here. The logic
 * mirrors `PlyParserUtils.determineHeaderFormatFromHeaderText`: look for
 * the giveaway strings on a per-line basis so a property name that
 * happens to contain "opacity" as a substring (e.g. "opacity_0") still
 * gets matched but doesn't cause false positives elsewhere.
 */
export async function detectGaussianSplatFormat(
  plyBuffer: ArrayBuffer,
): Promise<{ format: GaussianSplatFormat; splatCount: number; headerText: string }> {
  const headerText = extractPlyHeaderText(plyBuffer);

  // Walk the header line-by-line looking for the format-specific markers.
  const lines = headerText.split(/\r?\n/);
  let format: GaussianSplatFormat = "unknown";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "end_header" || line.length === 0) continue;
    if (line.startsWith("element chunk")) {
      format = "playcanvas_compressed";
      // Don't break: keep scanning in case a later line flips the verdict.
    } else if (line.startsWith("element codebook_centers")) {
      format = "inria_v2";
    } else if (/\bpacked_(position|rotation|scale|color)\b/.test(line)) {
      // PlayCanvas compressed variants sometimes omit the `element chunk`
      // line if the file was hand-edited. A single packed_* property is
      // enough to identify it.
      format = "playcanvas_compressed";
    }
  }

  // Fallback for INRIA V1 (uncompressed) and variants where someone has
  // trimmed out f_rest_* properties. We require f_dc_0 (or any f_dc_N) +
  // any one of (opacity, scale_0, rot_0) so we still match the INRIA V1
  // "no SH" variant that some tools emit.
  if (format === "unknown") {
    const hasFd0 = /\bf_dc_0\b/.test(headerText);
    const hasAnyFd = /\bf_dc_\d+\b/.test(headerText);
    const hasOpacity = /\bopacity\b/.test(headerText);
    const hasScale = /\bscale_0\b/.test(headerText);
    const hasRot = /\brot_0\b/.test(headerText);
    if ((hasFd0 || hasAnyFd) && (hasOpacity || hasScale || hasRot)) {
      format = "inria_v1";
    }
  }

  const splatCount = parsePlyVertexCount(headerText);
  return { format, splatCount, headerText };
}

/**
 * Convert a 3DGS PLY ArrayBuffer into a compressed .ksplat ArrayBuffer.
 * Calls `onProgress` repeatedly with percent / label / eta so the caller
 * can drive a UI bar.
 *
 * @param plyBuffer  Raw PLY bytes.
 * @param onProgress Optional progress callback. Called with percent in
 *                   [0, 100]. May be throttled internally; do not rely on
 *                   call frequency for smooth animation.
 */
export async function convertPlyToKsplat(
  plyBuffer: ArrayBuffer,
  onProgress: (p: ConvertProgress) => void = () => {},
  options: ConvertOptions = {},
): Promise<ConvertResult> {
  const start = performance.now();
  const originalSizeBytes = plyBuffer.byteLength;

  const splatAlphaRemovalThreshold = options.splatAlphaRemovalThreshold ?? 1;
  const compressionLevel = options.compressionLevel ?? 1;
  const outSphericalHarmonicsDegree = options.outSphericalHarmonicsDegree ?? 0;

  // ─── 0% → 5% : reading PLY header (we already have it in plyBuffer) ───────
  onProgress({ percent: 1, label: "Đọc header PLY...", etaSeconds: null });
  await yieldEventLoop();

  // We use PlyLoader.loadFromFileData with optimizeSplatData=true, which:
  //   1. parses PLY → UncompressedSplatArray
  //   2. feeds it through SplatBufferGenerator → compressed SplatBuffer
  //
  // This is the same code path the library uses internally for the URL loader,
  // so we get the same layout as if we'd loaded a .ksplat file from disk.
  const { PlyLoader } = await import("@mkkellogg/gaussian-splats-3d");

  // The library parses the entire PLY into an UncompressedSplatArray, which
  // for a 2M-splat file takes ~5–15s. We have no per-splat callback here, so
  // we report an indeterminate message while parsing.
  onProgress({ percent: 8, label: "Đang phân tích Gaussian Splats...", etaSeconds: null });
  await yieldEventLoop();

  const splatBuffer = (await (PlyLoader as unknown as {
    loadFromFileData: (
      data: ArrayBuffer,
      minAlpha: number,
      compression: number,
      optimize: boolean,
      shDegree: number,
      sectionSize?: number,
      sceneCenter?: unknown,
      blockSize?: number,
      bucketSize?: number,
    ) => Promise<{ bufferData: ArrayBuffer; getSplatCount?: () => number }>;
  }).loadFromFileData(
    plyBuffer,
    splatAlphaRemovalThreshold,
    compressionLevel,
    /* optimizeSplatData */ true,
    outSphericalHarmonicsDegree,
  )) as { bufferData: ArrayBuffer; getSplatCount?: () => number };

  // ─── post-parse status updates ────────────────────────────────────────────
  const splatCount = splatBuffer.getSplatCount?.() ?? 0;
  onProgress({
    percent: 88,
    label: `Đã phân tích ${splatCount.toLocaleString()} splats. Đang đóng gói...`,
    etaSeconds: estimateEta(start, 88),
  });
  await yieldEventLoop();

  onProgress({
    percent: 96,
    label: "Hoàn tất...",
    etaSeconds: estimateEta(start, 96),
  });
  await yieldEventLoop();

  // ─── 100% ─────────────────────────────────────────────────────────────────
  // The SplatBuffer we got back already contains the scene-center offset
  // in its ksplat header. Decode it so the caller can frame the camera
  // around the splats' real centroid instead of assuming (0, 0, 0).
  let sceneCenter = { x: 0, y: 0, z: 0 };
  try {
    const SplatBuffer = (await import("@mkkellogg/gaussian-splats-3d")).SplatBuffer;
    const parsed = new SplatBuffer(splatBuffer.bufferData as ArrayBuffer);
    if (parsed.sceneCenter) {
      sceneCenter = {
        x: parsed.sceneCenter.x,
        y: parsed.sceneCenter.y,
        z: parsed.sceneCenter.z,
      };
    }
  } catch (e) {
    console.warn("[GaussianSplat] Could not parse scene center from ksplat header:", e);
  }

  const result: ConvertResult = {
    ksplatBuffer: splatBuffer.bufferData,
    splatCount,
    originalSizeBytes,
    sceneCenter,
  };

  onProgress({
    percent: 100,
    label: `Xong · ${splatCount.toLocaleString()} splats · ${formatMB(result.ksplatBuffer.byteLength)}`,
    etaSeconds: 0,
  });

  const elapsedMs = performance.now() - start;
  console.info(
    `[GaussianSplat] Converted PLY ${formatMB(originalSizeBytes)} → ` +
    `.ksplat ${formatMB(result.ksplatBuffer.byteLength)} ` +
    `(${splatCount.toLocaleString()} splats) ` +
    `in ${(elapsedMs / 1000).toFixed(2)}s.`,
  );

  return result;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function estimateEta(startMs: number, percent: number): number | null {
  if (percent <= 0) return null;
  const elapsed = (performance.now() - startMs) / 1000;
  const total = elapsed / (percent / 100);
  const remaining = total - elapsed;
  return remaining > 0 ? Math.max(0.1, remaining) : 0;
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
