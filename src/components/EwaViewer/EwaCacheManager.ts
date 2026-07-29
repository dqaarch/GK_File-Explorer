/**
 * EwaCacheManager - Lumigrade-style WebCodecs decoder
 * 
 * Khác với implementation cũ:
 * - Decode TẤT CẢ VP9 frames một lần trong preload() (giống Lumigrade)
 * - Decode TẤT CẢ meansLo một lần trong preload()
 * - Chỉ splat dequantization là on-demand
 */

import { invoke } from "@tauri-apps/api/core";

// Types matching Rust types
export interface EwaPreloadInfo {
  n_gaussians: number;
  n_frames: number;
  fps: number;
  atlas_width: number;
  atlas_height: number;
  atlas_side: number;
  ranges: EwaRangesSerializable;
  file_size: number;
}

export interface EwaRangesSerializable {
  means_min: [number, number, number];
  means_max: [number, number, number];
  scales_min: [number, number, number];
  scales_max: [number, number, number];
  quats_min: [number, number, number, number];
  quats_max: [number, number, number, number];
  opacity_min: number;
  opacity_max: number;
  sh0_min: [number, number, number];
  sh0_max: [number, number, number];
}

// Debug flag — set true locally if you need to re-enable verbose EWA pipeline logs.
const EWA_DEBUG = false;
const dbg = (...args: unknown[]) => { if (EWA_DEBUG) console.log(...args); };

export interface FrameInfo {
  video_offset: number;
  size: number;
  is_keyframe: boolean;
}

export interface EwaHeaderSerializable {
  n_gaussians: number;
  n_frames: number;
  n_chunks: number;
  chunk_size: number;
  atlas_side: number;
  n_atlas_cols: number;
  n_atlas_rows: number;
  fps: number;
  flags: number;
  codec: string;
}

export interface DecodedFrame {
  positions: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  opacities: Float32Array;
  colors: Float32Array;
}

// Lumigrade state structure (from player)
interface LumigradeState {
  is4dsl: boolean;
  nG: number;
  NF: number;
  R: {
    mMin: number[];
    mMax: number[];
    sMin: number[];
    sMax: number[];
    qMin: number[];
    qMax: number[];
    opMin: number;
    opMax: number;
    hMin: number[];
    hMax: number[];
  };
  lumas: Uint8Array[];      // Y planes for each frame
  los: Uint8Array[];        // meansLo for each frame
  rest: Float32Array;       // SH coefficients
  cache: Map<number, DecodedFrame>;
}

export class EwaCacheManager {
  private static CACHE_MAX_SPLATS = 16_000_000;

  private filePath: string = "";
  private info: EwaPreloadInfo | null = null;
  private preloadReady = false;
  private loading = false;
  private error: string | null = null;

  // Lumigrade-style state
  private state: LumigradeState | null = null;
  private splatCache: Map<number, DecodedFrame> = new Map();

  // Cached values
  private atlasSide = 0;
  private atlasWidth = 0;
  private atlasHeight = 0;
  private nAtlasCols = 5;
  private nAtlasRows = 3;
  private ranges: EwaRangesSerializable | null = null;

  get isReady() { return this.preloadReady; }
  get isLoading() { return this.loading; }
  get error_() { return this.error; }
  get nFrames() { return this.info?.n_frames ?? 0; }
  get nGaussians() { return this.info?.n_gaussians ?? 0; }
  get fps() { return this.info?.fps ?? 30; }

  /**
   * Check WebCodecs support
   */
  isWebCodecsSupported(): boolean {
    if (typeof VideoDecoder === "undefined") {
      return false;
    }
    // Check if VP9 codec is supported
    const vp9Support = VideoDecoder.isConfigSupported({
      codec: "vp09.00.10.08",
      codedWidth: 1920,
      codedHeight: 1080,
    });
    return vp9Support.then(r => r.supported).catch(() => false);
  }

  async checkCodecSupport(codec: string, width: number, height: number): Promise<boolean> {
    try {
      const result = await VideoDecoder.isConfigSupported({
        codec: codec,
        codedWidth: width,
        codedHeight: height,
      });
      dbg(`[EwaCacheManager] Codec ${codec} support:`, result);
      return result.supported;
    } catch (e) {
      console.error("[EwaCacheManager] Codec check failed:", e);
      return false;
    }
  }

  /**
   * Preload EWA file - decode ALL frames (Lumigrade style)
   */
  async preload(filePath: string): Promise<EwaPreloadInfo> {
    if (this.filePath === filePath && this.preloadReady) {
      return this.info!;
    }

    this.clear();
    this.filePath = filePath;
    this.loading = true;
    this.error = null;

    try {
      // 1. Get HTTP URL for file (non-blocking fetch)
      const ewaUrl: string = await invoke("register_ewa_file", { path: filePath });
      dbg("[EwaCacheManager] EWA URL:", ewaUrl);

      // 2. Fetch file via HTTP (non-blocking, like Lumigrade)
      dbg("[EwaCacheManager] Fetching file via HTTP...");
      const response = await fetch(ewaUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const allData = new Uint8Array(await response.arrayBuffer());
      const dv = new DataView(allData.buffer);
      const u8 = allData;
      dbg("[EwaCacheManager] File loaded:", allData.length, "bytes");

      // 3. Parse header from binary (Lumigrade format)
      const magicBytes = new Uint8Array(allData.buffer, 0, 4);
      const magicStr = new TextDecoder().decode(magicBytes);
      if (magicStr !== "EWA1") {
        console.error("[EwaCacheManager] Magic:", magicStr, "bytes:", Array.from(magicBytes));
        throw new Error(`Invalid EWA file: bad magic "${magicStr}"`);
      }
      
      // Lumigrade offset mapping:
      const nG = dv.getUint32(8, true);
      const NF = dv.getUint32(12, true);
      const nChunks = dv.getUint32(16, true);
      const chunkSize = dv.getUint32(20, true);
      const atlasSide = dv.getUint16(24, true) || 194; // default 194 if 0
      const nAtlasCols = u8[26] || 5;
      const nAtlasRows = u8[27] || 3;
      const rangesOff = dv.getUint32(32, true);
      const frameIdxOff = dv.getUint32(40, true);
      const mlOff = dv.getUint32(44, true);
      const vidOff = dv.getUint32(48, true);

      // Read codec (16 bytes at offset 52)
      const codecBytes = new Uint8Array(allData.buffer, 52, 16);
      const codecEnd = codecBytes.indexOf(0);
      const codec = codecEnd > 0
        ? new TextDecoder().decode(codecBytes.subarray(0, codecEnd))
        : new TextDecoder().decode(codecBytes);

      // Chunk index offset (FORMAT.md offset 36: pointer to chunk table)
      const chunkIndexOff = dv.getUint32(36, true);

      // Spherical Harmonics (offset 80-84: u8 shBands, u32 shOff) - Lumigrade format
      const shBands = u8[80];
      const shOff = shBands > 0 ? dv.getUint32(81, true) : 0;

      // Parse chunk boundaries (FORMAT.md: nChunks × 16 B, each: u32 startFrame, u32 endFrame, 8 reserved)
      const chunkStarts: number[] = [];
      const chunkKeyframes: number[] = [];
      for (let c = 0; c < nChunks; c++) {
        const startFrame = dv.getUint32(chunkIndexOff + c * 16, true);
        const endFrame = dv.getUint32(chunkIndexOff + c * 16 + 4, true);
        chunkStarts.push(startFrame);
        chunkKeyframes.push(startFrame); // keyframe is always chunk start
        dbg(`[EwaCacheManager] Chunk ${c}: frames ${startFrame}..${endFrame}, keyframe=${startFrame}`);
      }

      // Parse frames
      const frames: FrameInfo[] = [];
      for (let f = 0; f < NF; f++) {
        const off = dv.getUint32(frameIdxOff + f * 8, true);
        const sizeWithFlag = dv.getUint32(frameIdxOff + f * 8 + 4, true);
        frames.push({
          video_offset: off,
          size: sizeWithFlag & 0x7FFFFFFF,
          is_keyframe: (sizeWithFlag & 0x80000000) !== 0 || f === 0,
        });
      }

      // Calculate atlas dimensions (Lumigrade style)
      const W = atlasSide * nAtlasCols;
      const H = atlasSide * nAtlasRows;
      
      // Set instance properties
      this.atlasSide = atlasSide;
      this.atlasWidth = W;
      this.atlasHeight = H;
      this.nAtlasCols = nAtlasCols;
      this.nAtlasRows = nAtlasRows;
      this.nAtlasCols = nAtlasCols;
      this.nAtlasRows = nAtlasRows;

      // 4. Parse ranges
      const R = this.parseRanges(dv, rangesOff);
      this.ranges = {
        positions: { min: R.mMin, max: R.mMax },
        scales: { min: R.sMin, max: R.sMax },
        opacities: { min: R.opMin, max: R.opMax },
        colors: { min: R.hMin, max: R.hMax },
        rotQuats: { min: R.qMin, max: R.qMax },
      };

      dbg("[EwaCacheManager] Header parsed:", {
        nG, NF, codec,
        atlasSide: this.atlasSide,
        atlasWidth: this.atlasWidth,
        atlasHeight: this.atlasHeight,
        nAtlasCols: this.nAtlasCols,
        nAtlasRows: this.nAtlasRows,
        rangesOff, frameIdxOff, mlOff, vidOff,
        nChunks,
        fileSize: allData.length
      });

      // Debug: dump color ranges (hMin/hMax) so we can compare with reference PLY
      dbg("[EwaCacheManager] Color ranges (hMin/hMax):", {
        hMin_0: R.hMin[0], hMin_1: R.hMin[1], hMin_2: R.hMin[2],
        hMax_0: R.hMax[0], hMax_1: R.hMax[1], hMax_2: R.hMax[2],
      });

      // Validate dimensions
      if (W <= 0 || H <= 0 || nG <= 0 || NF <= 0) {
        throw new Error(`Invalid dimensions: W=${W} H=${H} nG=${nG} NF=${NF}`);
      }

      // Check codec support
      const codecSupported = await this.checkCodecSupport(codec, W, H);
      if (!codecSupported) {
        throw new Error(`Codec ${codec} not supported for ${W}x${H}`);
      }

      // 5. Decode ALL VP9 frames -> lumas (Lumigrade style)
      dbg("[EwaCacheManager] Decoding VP9 frames...");
      const lumas = await this.decodeAllVp9Frames(codec, allData, frames, vidOff, frameIdxOff);
      dbg("[EwaCacheManager] VP9 decode complete, got", lumas.length, "frames");

      // 6. Decode SH data (Lumigrade: rest[]. 45 SH coefficients per splat, view-dependent color)
      let rest: Float32Array;
      if (shBands > 0 && shOff > 0) {
        dbg("[EwaCacheManager] Decoding SH data (bands=" + shBands + ", off=" + shOff + ")...");
        rest = this.decodeSHData(allData, shOff, nG);
      } else {
        dbg("[EwaCacheManager] No SH data (bands=" + shBands + ")");
        rest = new Float32Array(0); // empty — no SH
      }

      // 7. Decode ALL meansLo frames -> los (with XOR delta for non-keyframes)
      dbg("[EwaCacheManager] Decoding meansLo...");
      const los = this.decodeAllMeansLo(allData, mlOff, nG, NF, frames, chunkKeyframes);
      dbg("[EwaCacheManager] meansLo decode complete");

      // 8. Create Lumigrade state
      // FPS from file (u16 at offset 28 — FORMAT.md offset 28)
      const fps = dv.getUint16(28, true) || 30;

      this.state = {
        is4dsl: false,
        nG,
        NF,
        R,
        lumas,
        los,
        rest,
        cache: new Map(),
      };

      this.info = {
        n_gaussians: nG,
        n_frames: NF,
        fps,
        atlas_width: this.atlasWidth,
        atlas_height: this.atlasHeight,
        atlas_side: this.atlasSide,
        ranges: this.ranges,
        file_size: allData.length,
      };

      this.preloadReady = true;
      this.loading = false;

      return this.info;
    } catch (e) {
      this.loading = false;
      this.error = e instanceof Error ? e.message : String(e);
      console.error("[EwaCacheManager] Preload error:", e);
      throw e;
    }
  }

  /**
   * Decode Spherical Harmonics data for view-dependent color (Lumigrade format).
   * Format:
   *   u16  nC          (number of SH coefficients per channel; 45 for SH3 with 15 basis)
   *   256 floats       (codebook: 1024 bytes)
   *   u32  csz         (compressed size of cbytes)
   *   zstd(cbytes)     (codebook entries, lookup table)
   *   u32  nFramesInChunk
   *   u32  lsz         (compressed size of labels)
   *   zstd(labels)     (u16[nG] — index into cbytes for each splat)
   * Result: rest[nG * 45] (3 channels × 15 SH coefficients per splat, RGB).
   */
  private decodeSHData(allData: Uint8Array, shOff: number, nG: number): Float32Array {
    const dv = new DataView(allData.buffer);
    const nC = dv.getUint16(shOff, true);
    const coeffs = 45;

    if (nC !== coeffs) {
      console.warn(`[EwaCacheManager] SH coefficient count mismatch: expected 45, got ${nC}. Falling back to DC-only.`);
      return new Float32Array(nG * coeffs);
    }

    // Read codebook (256 floats = 1024 bytes)
    const cb = new Float32Array(allData.buffer, shOff + 3, 256);

    // Read compressed codebook bytes
    let q = shOff + 3 + 256 * 4;
    const csz = dv.getUint32(q, true);
    const cbytes = this.zstdDecompress(allData.subarray(q + 4, q + 4 + csz));
    q += 4 + csz;

    // Skip nFramesInChunk (matches Lumigrade)
    q += 4;

    // Read compressed labels (u16 per splat)
    const lsz = dv.getUint32(q, true);
    const lraw = this.zstdDecompress(allData.subarray(q + 4, q + 4 + lsz));
    const labels = new Uint16Array(lraw.buffer, lraw.byteOffset, nG);

    // Expand labels → SH coefficients
    const rest = new Float32Array(nG * coeffs);
    for (let i = 0; i < nG; i++) {
      const L = labels[i];
      for (let c = 0; c < coeffs; c++) {
        rest[i * coeffs + c] = cb[cbytes[L * coeffs + c]];
      }
    }
    dbg(`[EwaCacheManager] SH decoded: ${nG} splats × ${coeffs} coeffs, label range [${Math.min(...Array.from(labels).slice(0, 100))}, ${Math.max(...Array.from(labels).slice(0, 100))}]`);
    return rest;
  }

  private zstdDecompress(data: Uint8Array): Uint8Array {
    const fzstdModule = (window as any).fzstd;
    if (!fzstdModule || !fzstdModule.decompress) {
      throw new Error("fzstd library not loaded");
    }
    return fzstdModule.decompress(data);
  }

  /**
   * Parse ranges from header (Lumigrade format)
   */
  private parseRanges(dv: DataView, offset: number) {
    const f32 = (o: number) => dv.getFloat32(o, true);
    let o = offset;
    
    const mMin = [f32(o), f32(o + 4), f32(o + 8)]; o += 12;
    const mMax = [f32(o), f32(o + 4), f32(o + 8)]; o += 12;
    const sMin = [f32(o), f32(o + 4), f32(o + 8)]; o += 12;
    const sMax = [f32(o), f32(o + 4), f32(o + 8)]; o += 12;
    const qMin = [f32(o), f32(o + 4), f32(o + 8), f32(o + 12)]; o += 16;
    const qMax = [f32(o), f32(o + 4), f32(o + 8), f32(o + 12)]; o += 16;
    const opMin = f32(o); o += 4;
    const opMax = f32(o); o += 4;
    const hMin = [f32(o), f32(o + 4), f32(o + 8)]; o += 12;
    const hMax = [f32(o), f32(o + 4), f32(o + 8)];

    return { mMin, mMax, sMin, sMax, qMin, qMax, opMin, opMax, hMin, hMax };
  }

  /**
   * Decode ALL VP9 frames using WebCodecs (Lumigrade style)
   * Tạo một decoder duy nhất, feed tất cả frames, rồi flush()
   */
  private async decodeAllVp9Frames(
    codec: string,
    u8: Uint8Array,
    frames: FrameInfo[],
    vidOff: number,
    _frameIdxOff: number
  ): Promise<Uint8Array[]> {
    const NF = frames.length;
    const W = this.atlasWidth;
    const H = this.atlasHeight;
    const lumas: Uint8Array[] = new Array(NF);

    // Timeout for decoder (30 seconds max)
    const timeout = new Promise<never>((_, rej) => 
      setTimeout(() => rej(new Error("VP9 decode timeout after 30s")), 30000)
    );

    const decodePromise = new Promise<Uint8Array[]>((resolve, reject) => {
      let got = 0;
      let errorLogged = false;
      
      const dec = new VideoDecoder({
        output: async (f) => {
          const i = got++;
          try {
            const fmt = f.format || '';
            
            if (!(fmt.startsWith('I420') || fmt.startsWith('NV12'))) {
              if (!errorLogged) {
                console.error("[EwaCacheManager] VideoDecoder: unsupported format", fmt);
                errorLogged = true;
              }
              f.close();
              reject(new Error('unsupported VideoFrame format ' + fmt));
              return;
            }

            // Extract Y plane (Lumigrade style)
            const tmp = new Uint8Array(f.allocationSize());
            const layout = await f.copyTo(tmp);
            const { offset, stride } = layout[0];
            
            const Yp = new Uint8Array(W * H);
            for (let r = 0; r < H; r++) {
              const srcStart = offset + r * stride;
              const srcEnd = srcStart + W;
              if (srcEnd <= tmp.length) {
                Yp.set(tmp.subarray(srcStart, srcEnd), r * W);
              }
            }
            
            lumas[i] = Yp;
            f.close();

            if (i === NF - 1) {
              dbg("[EwaCacheManager] All VP9 frames decoded:", NF);
              resolve(lumas);
            }
          } catch (e) {
            if (!errorLogged) {
              console.error("[EwaCacheManager] Frame decode error:", e);
              errorLogged = true;
            }
            f.close();
            reject(e);
          }
        },
        error: (e) => {
          console.error("[EwaCacheManager] VideoDecoder error:", e);
          reject(e);
        },
      });

      // Configure decoder
      try {
        dec.configure({
          codec: codec || "vp09.00.10.08",
          codedWidth: W,
          codedHeight: H,
          hardwareAcceleration: "prefer-software",
        });
      } catch (e) {
        console.error("[EwaCacheManager] Decoder configure failed:", e);
        reject(e);
        return;
      }

      // Feed all frames to decoder (Lumigrade style)
      for (let f = 0; f < NF; f++) {
        const frame = frames[f];
        const start = vidOff + frame.video_offset;
        const end = start + frame.size;
        
        if (start < 0 || end > u8.length || start >= end) {
          console.error(`[EwaCacheManager] Invalid frame ${f}: offset=${frame.video_offset} size=${frame.size}`);
          continue;
        }

        dec.decode(new EncodedVideoChunk({
          type: frame.is_keyframe ? "key" : "delta",
          timestamp: f * 33333,
          data: u8.subarray(start, end),
        }));
      }

      // Flush and wait for all frames
      dec.flush().catch(reject);
    });

    return Promise.race([decodePromise, timeout]);
  }

  /**
   * Decode ALL meansLo frames (Lumigrade style).
   * FORMAT.md mentions XOR delta but Lumigrade JS doesn't show it in decoder,
   * suggesting the encoder XORs before compression. Keep this simple first.
   */
  private decodeAllMeansLo(
    u8: Uint8Array,
    mlOff: number,
    nG: number,
    NF: number,
    _frames: FrameInfo[],
    _chunkKeyframes: number[]
  ): Uint8Array[] {
    const los: Uint8Array[] = new Array(NF);
    const flags = new DataView(u8.buffer).getUint32(mlOff, true);
    const isBaseN = (flags & 0x40000000) !== 0;
    const isMlRaw = (flags & 0x80000000) !== 0;

    // Get fzstd from window (loaded by init.ts)
    const fzstdModule = (window as any).fzstd;
    if (!fzstdModule || !fzstdModule.decompress) {
      console.error("[EwaCacheManager] fzstd not loaded!");
      throw new Error("fzstd library not loaded");
    }

    let pos = mlOff + 4;
    for (let f = 0; f < NF; f++) {
      const blobSize = new DataView(u8.buffer).getUint32(pos, true);
      pos += 4;

      const blobStart = pos;
      const blobEnd = blobStart + blobSize;
      const compressed = u8.slice(blobStart, blobEnd);
      pos += blobSize;

      // Decompress with fzstd
      let decompressed: Uint8Array;
      try {
        decompressed = fzstdModule.decompress(compressed);
        if (f < 2) {
          dbg(`[EwaCacheManager] meansLo frame ${f}: blobSize=${blobSize} decompressedLen=${decompressed.length} flags=0x${flags.toString(16)} isBaseN=${isBaseN} isMlRaw=${isMlRaw}`);
        }
      } catch (e) {
        console.error(`[EwaCacheManager] meansLo decompress failed for frame ${f}:`, e);
        throw e;
      }

      // Decode based on flags (Lumigrade style)
      if (isBaseN && decompressed.length > 0) {
        // BASE_N decoding
        const base = decompressed[0];
        const lut = decompressed.slice(1, 1 + base);
        const packed = decompressed.slice(1 + base);

        const b2 = base * base;
        const lo = new Uint8Array(nG * 3);
        for (let j = 0; j < nG && j < packed.length; j++) {
          const v = packed[j];
          const ix = Math.floor(v / b2);
          const rem = v - ix * b2;
          const iy = Math.floor(rem / base);
          lo[j * 3] = lut[ix];
          lo[j * 3 + 1] = lut[iy];
          lo[j * 3 + 2] = lut[rem - iy * base];
        }
        los[f] = lo;
      } else if (isMlRaw) {
        // ML_RAW - raw bytes in col-major order
        const lo = new Uint8Array(nG * 3);
        for (let j = 0; j < nG && j * 3 + 2 < decompressed.length; j++) {
          lo[j * 3] = decompressed[j];
          lo[j * 3 + 1] = decompressed[nG + j];
          lo[j * 3 + 2] = decompressed[2 * nG + j];
        }
        los[f] = lo;
      } else {
        // Raw format
        los[f] = decompressed;
      }
    }

    return los;
  }

  /**
   * Get decoded splat frame (on-demand dequantization)
   */
  async getFrame(frame: number): Promise<DecodedFrame> {
    if (!this.info || frame < 0 || frame >= this.info.n_frames) {
      throw new Error(`Invalid frame: ${frame}`);
    }

    if (!this.state) {
      throw new Error("Not initialized");
    }

    // Check cache first
    if (this.splatCache.has(frame)) {
      return this.splatCache.get(frame)!;
    }

    // Dequantize splats from pre-decoded lumas and los
    const decoded = this.dequantizeSplats(frame);

    // Cache with LRU eviction
    if (this.splatCache.size >= 64) {
      // Remove oldest
      const firstKey = this.splatCache.keys().next().value;
      if (firstKey !== undefined) {
        this.splatCache.delete(firstKey);
      }
    }
    this.splatCache.set(frame, decoded);

    return decoded;
  }

  /**
   * Dequantize splats for a frame (Lumigrade decode algorithm)
   */
  private dequantizeSplats(frame: number): DecodedFrame {
    const state = this.state!;
    const Y = state.lumas[frame];
    const lo = state.los[frame];
    const R = state.R;
    const nG = state.nG;

    if (!Y || !lo) {
      throw new Error(`No data for frame ${frame}`);
    }

    const A = this.atlasSide;
    const W = this.atlasWidth;
    const COLS = this.nAtlasCols;

    const positions = new Float32Array(nG * 3);
    const scales = new Float32Array(nG * 3);
    const rotations = new Float32Array(nG * 4);
    const opacities = new Float32Array(nG);
    const colors = new Float32Array(nG * 3);

    // Lumigrade helpers
    const st = (l: number) => Math.max(0, Math.min(1, (l - 16) / 219));
    const lum = (s: number, i: number): number => {
      const col_slot = s % COLS;
      const row_slot = Math.floor(s / COLS);
      const yi = Math.floor(i / A); // Y BEFORE X (Lumigrade)
      const xi = i % A;
      const big_row = row_slot * A + yi;
      const big_col = col_slot * A + xi;
      const idx = big_row * W + big_col;
      return idx < Y.length ? Y[idx] : 0;
    };
    const lp = (p: number, a: number, b: number) => p * (b - a) + a;
    const HP = Math.PI / 2;

    for (let i = 0; i < nG; i++) {
      // Get normalized values from atlas tiles
      const p = (s: number) => st(lum(s, i));

      // Position: combine hi-byte from atlas with lo-byte from meansLo
      for (let k = 0; k < 3; k++) {
        const hi = Math.round(p(k) * 219);
        const O = hi * 256 + (lo[i * 3 + k] || 0);
        const n = lp(O / 56319, R.mMin[k], R.mMax[k]);
        positions[i * 3 + k] = Math.sign(n) * (Math.exp(Math.abs(n)) - 1);
      }

      // Scale: exp(lerp)
      for (let k = 0; k < 3; k++) {
        const s = 3 + k;
        scales[i * 3 + k] = Math.exp(lp(p(s), R.sMin[k], R.sMax[k]));
      }

      // Rotation: sin-based quaternion
      let qwSum = 0;
      const qRaw = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const s = 6 + k;
        const v = Math.sin(lp(p(s), R.qMin[k], R.qMax[k]) * HP);
        qRaw[k] = v;
        qwSum += v * v;
      }
      const qLen = Math.sqrt(qwSum) || 1;
      // Store sin-decomposed quaternion components (Lumigrade decode line 288).
      // The TX=z180 remap (w,x,y,z) -> (-z, -y, x, w) is applied separately on cached
      // arrays. This matches Lumigrade's structure (rot built in a loop, then
      // remapped in the post-pass at line 268-269).
      rotations[i * 4 + 0] = qRaw[0] / qLen; // w
      rotations[i * 4 + 1] = qRaw[1] / qLen; // x
      rotations[i * 4 + 2] = qRaw[2] / qLen; // y
      rotations[i * 4 + 3] = qRaw[3] / qLen; // z

      // Opacity: sigmoid(lerp)
      opacities[i] = 1 / (1 + Math.exp(-lp(p(10), R.opMin, R.opMax)));

      // Color: matches Lumigrade player CPU decode + shade() (index.html line 291-292, 656).
      // 1) quantize lp -> triplet
      // 2) apply "color shuffle" (BT.601-like YCbCr -> linear)
      // 3) shade() wraps as: rgb = 0.5 + C0 * col  (SH DC band-0 normalization)
      const SH_C0 = 0.28209479177387814;
      const Yc = lp(p(11), R.hMin[0], R.hMax[0]);
      const Cb = lp(p(12), R.hMin[1], R.hMax[1]);
      const Cr = lp(p(13), R.hMin[2], R.hMax[2]);
      // Lumigrade's final rgb uploaded to GPU (post-shade):
      colors[i * 3]     = 0.5 + SH_C0 * (Yc + 1.402 * Cr);
      colors[i * 3 + 1] = 0.5 + SH_C0 * (Yc - 0.344 * Cb - 0.714 * Cr);
      colors[i * 3 + 2] = 0.5 + SH_C0 * (Yc + 1.772 * Cb);
    }

      // Apply TX=z180 coordinate transform (matches Lumigrade decode line 264-269).
    // Position: flip X and Y.
    // Quaternion: (w,x,y,z) -> (-z, -y, x, w) — rotates the orientation to render space.
    for (let i = 0; i < nG; i++) {
      positions[i * 3]     = -positions[i * 3];
      positions[i * 3 + 1] = -positions[i * 3 + 1];

      const w = rotations[i * 4 + 0];
      const x = rotations[i * 4 + 1];
      const y = rotations[i * 4 + 2];
      const z = rotations[i * 4 + 3];
      rotations[i * 4 + 0] = -z;
      rotations[i * 4 + 1] = -y;
      rotations[i * 4 + 2] = x;
      rotations[i * 4 + 3] = w;
    }

    return { positions, scales, rotations, opacities, colors, rest: state.rest };
  }

  /**
   * Preload frames ahead (for smooth playback)
   */
  async pump(current: number, ahead = 24): Promise<void> {
    if (!this.preloadReady) return;

    const NF = this.info?.n_frames ?? 0;
    const budget = 2;

    let decoded = 0;
    for (let k = 1; k <= ahead && decoded < budget; k++) {
      const f = (current + k) % NF;
      if (!this.splatCache.has(f)) {
        try {
          await this.getFrame(f);
          decoded++;
        } catch {
          // Skip failures
        }
      }
    }
  }

  /**
   * Clear all caches
   */
  clear(): void {
    this.splatCache.clear();
    this.preloadReady = false;
    this.loading = false;
    this.state = null;
  }

  /**
   * Full reset
   */
  reset(): void {
    this.clear();
    this.info = null;
    this.filePath = "";
    this.error = null;
  }
}

// Singleton instance
export const ewaCacheManager = new EwaCacheManager();
