import { FSItem } from "../types";

/**
 * Image sequence extensions
 */
const IMAGE_SEQ_EXTS = ['exr', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'tga', 'dpx', 'hdr', 'bmp'];

/**
 * Video extensions
 */
const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'ts', 'flv'];

/**
 * Check if extension is an image sequence type
 */
export function isImageSeqExt(ext: string): boolean {
  return IMAGE_SEQ_EXTS.includes(ext.toLowerCase());
}

/**
 * Check if extension is a video type
 */
export function isVideoExt(ext: string): boolean {
  return VIDEO_EXTS.includes(ext.toLowerCase());
}

/**
 * V1 Pattern: Parse filename to extract sequence pattern.
 * Supports:
 * 1. %04d (FFmpeg style)  - shot.%04d.exr
 * 2. #### (hash padding)   - shot.0001.exr
 * 3. @ (single @)          - shot.@.exr
 * 4. Implicit (rightmost)   - file_00000.png (non-greedy match)
 *
 * Returns null for non-sequence filenames.
 */
export function parseSequencePattern(filename: string): {
  prefix: string;
  padding: number;
  suffix: string;
} | null {
  const name = filename.replace(/[/\\]/g, '/').split('/').pop() || filename;
  const lastDot = name.lastIndexOf('.');
  const ext = lastDot >= 0 ? name.substring(lastDot) : '';

  // 1. Try %0Nd pattern (FFmpeg style) - e.g., "shot.%04d.exr"
  const fmtMatch = name.match(/^(.+)%0(\d)d(.*)$/);
  if (fmtMatch) {
    return { prefix: fmtMatch[1], padding: parseInt(fmtMatch[2], 10), suffix: fmtMatch[3] };
  }

  // 2. Try #### pattern (frame number with variable # count) - non-greedy so rightmost
  // e.g., "shot.####.exr" or "shot.##.exr"
  const hashMatch = name.match(/^(.+?)(#+)(.*)$/);
  if (hashMatch && /\d/.test(hashMatch[1])) {
    const prefix = hashMatch[1];
    const hashes = hashMatch[2];
    const suffix = hashMatch[3];
    return { prefix, padding: hashes.length, suffix };
  }

  // 3. Try @ pattern (single @ for frame number)
  const atMatch = name.match(/^(.+)\.@(.*)$/);
  if (atMatch) {
    return { prefix: atMatch[1], padding: 1, suffix: atMatch[2] };
  }

  // 4. Try implicit: rightmost digit sequence with meaningful separator (non-greedy match)
  // Industry standard rules for VFX sequences:
  //   - Frame number is immediately before the extension
  //   - Must have a separator (dot, underscore, dash) between name and frame number
  //   - Frame number must be at least 2 digits (excludes dates like photo_2024.png)
  //   - Prefix must have at least one character before the separator
  // Examples that PASS:  shot_001.exr, render.0001.png,  frame-0002.tif
  // Examples that FAIL:   photo_2024.png, image100.png, IMG_20240101.jpg
  const implicitMatch = name.match(/^(.+?[._-])(\d{2,})(\.[^.]+)$/);
  if (implicitMatch) {
    const prefix = implicitMatch[1];
    const digits = implicitMatch[2];
    const suffix = implicitMatch[3];
    return { prefix, padding: digits.length, suffix };
  }

  // 5. Try no-separator pattern: letters followed immediately by digits (e.g., Sh020031.exr)
  // This handles VFX-style shot sequences where shot code and frame number have no separator
  // Examples: Sh020031.exr, AB01_002.exr (with underscore between shot and frame)
  // We need at least 1 letter in prefix and at least 2 digits for frame number
  const noSepMatch = name.match(/^([A-Za-z]+)(\d{2,})(\.[^.]+)$/);
  if (noSepMatch) {
    const prefix = noSepMatch[1];
    const digits = noSepMatch[2];
    const suffix = noSepMatch[3];
    return { prefix, padding: digits.length, suffix };
  }

  // 6. Try shot_frame pattern: letters_underscore_digits (e.g., Sh02_0031.exr)
  const shotFrameMatch = name.match(/^([A-Za-z]+\d*)([._-])(\d{2,})(\.[^.]+)$/);
  if (shotFrameMatch) {
    const prefix = shotFrameMatch[1] + shotFrameMatch[2];
    const digits = shotFrameMatch[3];
    const suffix = shotFrameMatch[4];
    return { prefix, padding: digits.length, suffix };
  }

  return null;
}

export interface MediaInfo {
  type: 'video' | 'image-sequence';
  paths: string[];
  frameNumbers: number[];
  basePattern: string;
  ext: string;
  baseName: string;
  /**
   * Zero-padding width of the frame-number portion of each filename (e.g. 5
   * for `_00286.png`). Used by the player to render the on-screen frame
   * counter with the same width as the real filenames so sequences that
   * start at a non-zero frame (e.g. `IDC_00286.png`) display correctly
   * instead of "000", "001", … which would confuse users about which file
   * they are actually looking at.
   *
   * Optional for backwards compatibility — falls back to
   * `String(totalFrames).length` in the UI when absent.
   */
  padding?: number;
  fps?: number;
}

/**
 * V1 Pattern: Detect if a file is part of an image sequence.
 *
 * Algorithm:
 * 1. Parse the filename to extract the sequence pattern
 * 2. If no pattern found, treat as a still image
 * 3. Find all matching files in the same directory
 * 4. If 2+ files match, it's a real sequence
 *
 * Pattern matching priority (V1 electron/src/utils/fileTypeDetector.ts):
 * 1. %0Nd (FFmpeg style) - shot.%04d.exr
 * 2. #### (hash padding)  - shot.0001.exr
 * 3. @ (single @)         - shot.@.exr
 * 4. Implicit (rightmost) - file_00000.png (non-greedy match)
 */
export function detectMediaType(
  filePath: string,
  allItems: FSItem[],
  currentPath: string
): MediaInfo | null {
  const name = filePath.split(/[\\/]/).pop() || '';
  const ext = name.split('.').pop()?.toLowerCase() || '';

  // Check if it's a video file
  if (isVideoExt(ext)) {
    return {
      type: 'video',
      paths: [filePath],
      frameNumbers: [0],
      basePattern: name,
      ext,
      baseName: name,
      fps: 30,
    };
  }

  // Check if it's a potential image sequence file
  if (!isImageSeqExt(ext)) {
    return null;
  }

  // Parse the filename to extract sequence pattern
  const pattern = parseSequencePattern(name);

  if (!pattern) {
    // No sequence pattern found - treat as a still image
    return {
      type: 'image-sequence',
      paths: [filePath],
      frameNumbers: [0],
      basePattern: name,
      ext,
      baseName: name,
      fps: 30,
    };
  }

  // Collect all files in the same directory with matching pattern
  const sequenceFrames: { path: string; number: number; baseName: string }[] = [];

  for (const item of allItems) {
    if (item.type === 'directory') continue;
    if (!item.path) continue;

    const itemName = item.name;
    const itemExt = itemName.split('.').pop()?.toLowerCase() || '';
    if (itemExt !== ext) continue;

    // Try to match the item against the same pattern
    // Build expected prefix+suffix from pattern
    const expectedPrefix = pattern.prefix;
    const expectedSuffix = pattern.suffix;

    // Check if item starts with prefix and ends with suffix
    if (!itemName.startsWith(expectedPrefix) || !itemName.endsWith(expectedSuffix)) continue;

    // Extract the digit part between prefix and suffix
    const middle = itemName.substring(expectedPrefix.length, itemName.length - expectedSuffix.length);

    // The middle part should be all digits with the right padding length
    if (middle.length !== pattern.padding) continue;
    if (!/^\d+$/.test(middle)) continue;

    const frameNum = parseInt(middle, 10);
    sequenceFrames.push({
      path: item.path,
      number: frameNum,
      baseName: expectedPrefix,
    });
  }

  // Sort by frame number
  sequenceFrames.sort((a, b) => a.number - b.number);

  // Require at least 2 frames to be a real sequence
  const isRealSequence = sequenceFrames.length >= 2;

  if (isRealSequence) {
    // Build the normalized base pattern (e.g., "shot.####.exr")
    const basePattern = pattern.prefix + '#'.repeat(pattern.padding) + pattern.suffix;
    return {
      type: 'image-sequence',
      paths: sequenceFrames.map(f => f.path),
      frameNumbers: sequenceFrames.map(f => f.number),
      basePattern,
      ext,
      baseName: pattern.prefix,
      padding: pattern.padding,
      fps: 30,
    };
  }

  // Single frame - treat as still image
  return {
    type: 'image-sequence',
    paths: [filePath],
    frameNumbers: [0],
    basePattern: name,
    ext,
    baseName: name,
    fps: 30,
  };
}

/**
 * Check if a filename looks like it could be a sequence frame (for display purposes).
 * Returns true if the file has a sequence pattern (regardless of whether
 * other matching frames exist in the directory).
 */
export function isImageSequenceFile(filename: string): boolean {
  return parseSequencePattern(filename) !== null;
}

/**
 * Check if an image should be treated as a still (no sequence pattern).
 */
export function isStillImage(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (!isImageSeqExt(ext)) return false;
  return parseSequencePattern(filename) === null;
}
