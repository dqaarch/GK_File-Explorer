/**
 * EWA (EWA1) Format Decoder - TypeScript Types
 *
 * Defines the types for the EWA container format used by LumiGrade/LumiAR
 * for streaming volumetric video as 3D Gaussian Splat sequences.
 * Now purely JS-based (WebCodecs + fzstd), replacing the old Rust path.
 */

// EWA file info
export interface EwaInfo {
  n_gaussians: number;
  n_frames: number;
  fps: number;
  codec: string;
  atlas_width: number;
  atlas_height: number;
  atlas_side: number;
  file_size: number;
}

// Range values for de-quantization
export interface EwaRanges {
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

// Frame info from EWA file index
export interface FrameInfo {
  video_offset: number;
  size: number;
  is_keyframe: boolean;
}

// Chunk info for adaptive GOP seeking
export interface ChunkInfo {
  start_frame: number;
  end_frame: number;
}

// Decoded splat data for one frame
export interface DecodedFrame {
  positions: Float32Array;    // [x, y, z, x, y, z, ...] - N*3 floats
  scales: Float32Array;        // [sx, sy, sz, sx, sy, sz, ...] - N*3 floats
  rotations: Float32Array;     // [qw, qx, qy, qz, ...] - N*4 floats
  opacities: Float32Array;     // [opacity, ...] - N floats
  colors: Float32Array;        // [r, g, b, ...] - N*3 floats (linear RGB)
  rest?: Float32Array;         // [N*45] - 15 SH coefficients × 3 channels (RGB), view-dependent color
}
