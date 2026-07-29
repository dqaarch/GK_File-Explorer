/**
 * TauriFileSystem.ts
 * Service layer wrapping all Tauri IPC file system commands.
 * All file operations go through Rust backend for real system access.
 */

import { invoke, convertFileSrc } from "@tauri-apps/api/core";

export type DeleteMode = "recycle" | "permanent";
export type DragDropMode = "copy" | "move";
export type FileOperationKind = "create_file" | "create_folder" | "rename" | "move" | "delete_recycle" | "delete_permanent" | "paste_copy" | "paste_cut" | "extract_zip" | "compress_zip";

export interface FileOperationRecord {
  kind: FileOperationKind;
  sourcePath?: string;
  targetPath?: string;
  originalPath?: string;
  destinationPath?: string;
  mode?: DeleteMode;
}

// Re-export types matching Rust backend
export interface FileEntry {
  name: string;
  path: string;
  is_file: boolean;
  is_dir: boolean;
  size: number;
  modified: string | null;
  created: string | null;
  extension: string | null;
  is_hidden: boolean;
}

export interface DirListing {
  entries: FileEntry[];
  path: string;
}

export interface DiskSpace {
  total: number;
  used: number;
  free: number;
  path: string;
}

// Rich description of a logical drive, returned by get_drive_infos. Mirrors
// the Rust `DriveInfo` struct (camelCase on the wire).
export interface DriveInfo {
  path: string;
  label: string;
  display: string;
  driveType: "fixed" | "removable" | "network" | "cdrom" | "ramdisk" | "unknown";
  filesystem: string;
  /** Cloud provider identifier (e.g. "google_drive", "onedrive", "dropbox", "icloud", "pcloud", "box") */
  cloudProvider: string | null;
  iconUrl: string | null;
  total: number;
  used: number;
  free: number;
}

// ── Read directory ────────────────────────────────────────────────────────────
export async function readDirectory(path: string, showHidden?: boolean): Promise<DirListing> {
  return invoke<DirListing>("read_directory", { path, showHidden: showHidden ?? false });
}

export async function readDirectoryRecursive(path: string, maxDepth?: number): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("read_directory_recursive", { path, maxDepth });
}

// ── Text file operations ──────────────────────────────────────────────────────
export async function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  return invoke<void>("write_text_file", { path, content });
}

// ── File manipulation ────────────────────────────────────────────────────────
export async function deleteItem(path: string, mode: DeleteMode = "recycle"): Promise<void> {
  return invoke<void>("delete_item", { path, mode });
}

export async function createDirectory(path: string): Promise<void> {
  return invoke<void>("create_directory", { path });
}

export async function renameItem(oldPath: string, newPath: string): Promise<void> {
  return invoke<void>("rename_item", { oldPath, newPath });
}

export async function copyFile(source: string, dest: string): Promise<void> {
  return invoke<void>("copy_file", { source, dest });
}

export async function copyItem(source: string, dest: string): Promise<void> {
  return invoke<void>("copy_item", { source, dest });
}

export async function importFiles(sourcePaths: string[], targetDir: string): Promise<string[]> {
  return invoke<string[]>("import_files", { sourcePaths, targetDir });
}

export async function moveFiles(sourcePaths: string[], targetDir: string): Promise<string[]> {
  return invoke<string[]>("move_files", { sourcePaths, targetDir });
}

export async function compressToZip(sourcePaths: string[], destinationZip: string): Promise<void> {
  return invoke<void>("compress_to_zip", { sourcePaths, destinationZip });
}

export async function extractZip(zipPath: string, destinationDir: string): Promise<void> {
  return invoke<void>("extract_zip", { zipPath, destinationDir });
}

export interface ArchiveEntry {
  path: string;
  name: string;
  parentPath: string;
  extension: string | null;
  unpackedSize: number;
  modified: string | null;
  isDirectory: boolean;
  isEncrypted: boolean;
  isSplit: boolean;
}

export interface ArchiveListing {
  format: "rar" | "zip";
  entries: ArchiveEntry[];
  listedEntries: number;
  totalFiles: number;
  totalDirectories: number;
  totalUnpackedSize: number;
  hasEncryptedEntries: boolean;
  isMultipart: boolean;
  truncated: boolean;
  entryLimit: number;
}

export async function listRarEntries(path: string, password?: string): Promise<ArchiveListing> {
  return invoke<ArchiveListing>("list_rar_entries", { path, password: password || null });
}

export async function listZipEntries(path: string): Promise<ArchiveListing> {
  return invoke<ArchiveListing>("list_zip_entries", { path });
}

export function listArchiveEntries(filePath: string, format: ArchiveListing["format"], password?: string): Promise<ArchiveListing> {
  if (format === "zip") {
    return listZipEntries(filePath);
  }
  return listRarEntries(filePath, password);
}

// ── Disk info ────────────────────────────────────────────────────────────────
export async function getDiskSpace(path: string): Promise<DiskSpace> {
  return invoke<DiskSpace>("get_disk_space", { path });
}

// ── Search ────────────────────────────────────────────────────────────────────
export async function searchFiles(
  root: string,
  query: string,
  maxDepth?: number,
  requestId?: number
): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("search_files", { root, query, maxDepth, requestId });
}

// ── Utilities ────────────────────────────────────────────────────────────────
export async function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path });
}

export interface OpenWithApp {
  name: string;
  path: string;
  handler_id?: string | null;
  icon_path?: string | null;
  launch_path?: string | null;
  icon_index?: number | null;
  icon_data_url?: string | null;
  source?: "windows-shell" | "custom";
  package_family_name?: string | null;
  app_user_model_id?: string | null;
  package_full_name?: string | null;
  manifest_path?: string | null;
  is_packaged?: boolean | null;
}

export interface OpenWithAssociation {
  extension: string;
  app: OpenWithApp;
  source: "system" | "custom";
}

export interface OpenWithCandidateResponse {
  extension: string | null;
  default_app: OpenWithApp | null;
  recommended_apps: OpenWithApp[];
  all_apps: OpenWithApp[];
}

export async function openPathWithDefaultApp(path: string): Promise<void> {
  return invoke<void>("open_path_with_default_app", { path });
}

export async function openPathWithApplication(path: string, appPath: string): Promise<void> {
  return invoke<void>("open_path_with_application", { path, appPath });
}

export async function showOpenWithDialog(path: string): Promise<OpenWithApp | null> {
  return invoke<OpenWithApp | null>("show_open_with_dialog", { path });
}

export async function getOpenWithAssociation(path: string): Promise<OpenWithAssociation | null> {
  return invoke<OpenWithAssociation | null>("get_open_with_association", { path });
}

export async function getOpenWithCandidates(path: string): Promise<OpenWithCandidateResponse> {
  return invoke<OpenWithCandidateResponse>("get_open_with_candidates", { path });
}

export async function openPathWithHandler(path: string, app: OpenWithApp): Promise<void> {
  return invoke<void>("open_path_with_handler", { path, app });
}

export async function setOpenWithAssociation(extension: string, app: OpenWithApp): Promise<void> {
  return invoke<void>("set_open_with_association", { extension, app });
}

export async function clearOpenWithAssociation(extension: string): Promise<void> {
  return invoke<void>("clear_open_with_association", { extension });
}

export async function getOpenWithAppIcon(app: OpenWithApp): Promise<string | null> {
  return invoke<string | null>("get_open_with_app_icon", { app });
}

// Batch load icons for multiple apps - much faster than calling getOpenWithAppIcon for each
export async function getOpenWithIconsBatch(apps: OpenWithApp[]): Promise<Record<string, string>> {
  const results = await invoke<[string, string | null][]>("get_open_with_icons_batch", { apps });
  const iconMap: Record<string, string> = {};
  for (const [key, dataUrl] of results) {
    if (dataUrl) {
      iconMap[key.toLowerCase()] = dataUrl;
    }
  }
  return iconMap;
}

// Progressive streaming icon extraction - starts extraction and returns immediately.
// Icons are streamed to frontend via Tauri events: open-with-icon-ready
export async function getOpenWithIconsStream(apps: OpenWithApp[]): Promise<void> {
  await invoke("get_open_with_icons_stream", { apps });
}

export async function debugDumpOpenWith(path: string): Promise<string> {
  return invoke<string>("debug_dump_open_with", { path });
}

export async function getHomeDir(): Promise<string> {
  return invoke<string>("get_home_dir");
}

export async function getDrives(): Promise<string[]> {
  return invoke<string[]>("get_drives");
}

export async function getDriveInfos(): Promise<DriveInfo[]> {
  return invoke<DriveInfo[]>("get_drive_infos");
}

export async function setVolumeLabel(path: string, label: string): Promise<void> {
  await invoke<void>("set_volume_label", { path, label });
}

export async function openInTerminal(path: string): Promise<void> {
  await invoke<void>("open_in_terminal", { path });
}

export async function getSystemAccentColor(): Promise<string | null> {
  try {
    const value = await invoke<string | null>("get_system_accent_color");
    return value ?? null;
  } catch {
    return null;
  }
}

export async function getSystemDoubleClickSpeed(): Promise<number> {
  try {
    return await invoke<number>("get_system_double_click_speed");
  } catch {
    return 500;
  }
}

export interface SystemMemoryInfo {
  total_memory_bytes: number;
  total_memory_gb: number;
  recommended_cache_mb: number;
}

export async function getSystemMemoryInfo(): Promise<SystemMemoryInfo> {
  try {
    return await invoke<SystemMemoryInfo>("get_system_memory_info");
  } catch {
    // Fallback: 8GB total, 6GB recommended cache
    return {
      total_memory_bytes: 8 * 1024 * 1024 * 1024,
      total_memory_gb: 8,
      recommended_cache_mb: 6144,
    };
  }
}

export async function getSpecialFolders(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("get_special_folders");
}

/// Resolves an address-bar string into an absolute filesystem path. The
/// backend mirrors Windows Explorer's address bar:
///   * `%AppData%`           — env var (case-insensitive, sub-paths OK)
///   * `shell:Downloads`     — known shell folder (mapped to a KNOWNFOLDERID)
///   * `::{20D04FE0-...}`    — raw GUID / virtual folder
///   * `C:\Windows`          — already-absolute path (returned unchanged)
/// On non-Windows the backend returns the input unchanged.
export async function resolveAddressPath(input: string): Promise<string> {
  return invoke<string>("resolve_address_path", { input });
}

export interface FileMetadata {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  created?: string;
  modified?: string;
  accessed?: string;
  readonly: boolean;
  extension?: string;
}

export async function getFileMetadata(path: string): Promise<FileMetadata> {
  return invoke<FileMetadata>("get_file_metadata", { path });
}

// ── Read binary file as base64 for preview ───────────────────────────────────
export async function readFileAsBase64(path: string): Promise<string> {
  return invoke<string>("read_file_as_base64", { path });
}

// ── Read file as data URL (data:image/png;base64,...) ──────────────────────
export async function readFileAsDataUrl(path: string): Promise<string> {
  return invoke<string>("read_file_as_data_url", { path });
}

export interface TextPreviewResult {
  content: string;
  encoding: string;
  truncated: boolean;
  line_count: number;
  is_binary: boolean;
  error: string | null;
}

export async function getTextPreview(path: string, maxBytes?: number): Promise<TextPreviewResult> {
  return invoke<TextPreviewResult>("get_text_preview", { path, maxBytes });
}

// ── Path utilities ────────────────────────────────────────────────────────────
export function joinPath(...parts: string[]): string {
  const filtered = parts.filter(Boolean);
  if (filtered.length === 0) return "";

  const separator = filtered.some((part) => /^[A-Za-z]:[\\/]/.test(part) || part.includes("\\")) ? "\\" : "/";

  return filtered
    .map((part, index) => {
      const normalized = part.replace(/[\\/]+/g, separator);
      if (index === 0) {
        return normalized.replace(new RegExp(`${separator}+$`), "");
      }
      return normalized.replace(new RegExp(`^${separator}+|${separator}+$`, "g"), "");
    })
    .filter(Boolean)
    .join(separator);
}

export function getParentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  // Handle drive root like "C:/" - return with trailing slash for consistency
  if (lastSlash <= 2) {
    return normalized.substring(0, 2) + "/";
  }
  return normalized.substring(0, lastSlash);
}

export function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return normalized.substring(lastSlash + 1);
}

export function getFileExtension(path: string): string | null {
  const name = getFileName(path);
  const dot = name.lastIndexOf(".");
  if (dot === -1 || dot === 0) return null;
  return name.substring(dot + 1).toLowerCase();
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// Convert file path to asset URL for use in frontend (images, videos, etc.)
export function getAssetUrl(path: string): string {
  return convertFileSrc(path);
}

// HTTP server URL for thumbnail and video endpoints
const HTTP_SERVER = "http://localhost:18765";

/**
 * Fetch image as data URL via the thumbnail endpoint.
 * The server resizes the image server-side, which is much faster than loading
 * the full raw file and resizing client-side.
 */
export async function fetchThumbnailAsDataUrl(path: string, maxSize: number = 512): Promise<string> {
  const encodedPath = encodeURIComponent(path);
  const url = `${HTTP_SERVER}/thumbnail?path=${encodedPath}&size=${maxSize}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Thumbnail fetch failed: ${response.status} ${response.statusText}`);
  }

  // Try JSON first (fallback path returns {success, data_url} when image::open fails)
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const json = await response.json();
    if (json.success && json.data_url) {
      return json.data_url;
    }
    throw new Error(json.error || "Thumbnail decode failed");
  }

  // Binary image response
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read thumbnail blob"));
    reader.readAsDataURL(blob);
  });
}

// Decode Adobe PSD file to PNG base64 (uses psd-tools equivalent + embedded JPEG fallback)
export interface DecodeResult {
  success: boolean;
  png_base64: string | null;
  width: number | null;
  height: number | null;
  method: string | null;
  layers_count: number | null;
  error: string | null;
}

export async function decodePsd(path: string, maxSize?: number): Promise<DecodeResult> {
  return invoke<DecodeResult>("decode_psd", { path, maxSize });
}

// Decode PSD on-demand (triggered by user click) - avoids loading all PSD files at once
export async function decodePsdOnDemand(path: string): Promise<boolean> {
  return invoke<boolean>("decode_psd_on_demand", { path });
}

// Decode Adobe Illustrator (.ai) / EPS on first click and refresh the
// thumbnail icon in the file grid. Same pattern as `decodePsdOnDemand`.
export async function decodeAiOnDemand(path: string): Promise<boolean> {
  return invoke<boolean>("decode_ai_on_demand", { path });
}

// Decode Adobe AI/EPS file to PNG base64 (uses embedded JPEG + Ghostscript fallback)
export async function decodeAi(path: string, maxSize?: number): Promise<DecodeResult> {
  return invoke<DecodeResult>("decode_ai", { path, maxSize });
}

// Decode C4D file to PNG base64 (extracts embedded JPEG or uses Windows Shell thumbnail)
export async function decodeC4d(path: string, maxSize?: number): Promise<DecodeResult> {
  return invoke<DecodeResult>("decode_c4d", { path, maxSize });
}

// Decode PureRef file to PNG base64 (extracts first image from ZIP archive)
export async function decodePureref(path: string, maxSize?: number): Promise<DecodeResult> {
  return invoke<DecodeResult>("decode_pureref", { path, maxSize });
}

// EPUB decode result interface
export interface EpubDecodeResult {
  success: boolean;
  title: string | null;
  author: string | null;
  publisher: string | null;
  language: string | null;
  description: string | null;
  cover_base64: string | null;  // PNG base64
  cover_width: number | null;
  cover_height: number | null;
  table_of_contents: EpubTocEntry[];
  text_content: string | null;  // First few pages as plain text
  chapters: EpubChapterContent[];  // Individual chapter content
  chapters_count: number;
  error: string | null;
}

export interface EpubChapterContent {
  index: number;
  title: string | null;
  href: string | null;
  content: string;
}

export interface EpubTocEntry {
  title: string;
  href: string;
  level: number;
}

// Decode EPUB file - extracts metadata, cover, and text content
export async function decodeEpub(path: string): Promise<EpubDecodeResult> {
  return invoke<EpubDecodeResult>("decode_epub", { path });
}

// STL decode result interface
export interface StlDecodeResult {
  success: boolean;
  triangles_count: number;
  vertices_count: number;
  // Flattened vertex data: [x1,y1,z1, x2,y2,z2, ..., xn,yn,zn]
  vertices: number[];
  // Flattened normal data: [nx1,ny1,nz1, nx2,ny2,nz2, ..., nxn,nyn,nzn]
  normals: number[];
  error: string | null;
}

// Decode STL file - extracts mesh data for 3D rendering
export async function decodeStl(path: string): Promise<StlDecodeResult> {
  return invoke<StlDecodeResult>("decode_stl", { path });
}

// EXR decode result interface
export interface ExrDecodeResult {
  success: boolean;
  png_base64: string | null;
  width: number | null;
  height: number | null;
  method: string | null;
  layers_count: number | null;
  channels: string[] | null;
  cryptomatte_layers: string[] | null;
  layer_names: string[] | null;  // All layer names in the EXR
  error: string | null;
}

export interface ExrDecodeArgs {
  path: string;
  max_size?: number;
  ocio_mode?: string | null;
  layer_name?: string | null;  // Optional: decode specific layer
}

// Decode EXR file to PNG base64 (uses exr crate for HDR to LDR conversion)
export async function decodeExr(path: string, maxSize?: number, ocioMode?: string | null, layerName?: string | null): Promise<ExrDecodeResult> {
  return invoke<ExrDecodeResult>("decode_exr", {
    args: {
      path,
      max_size: maxSize,
      ocio_mode: ocioMode ?? null,
      layer_name: layerName ?? null,
    }
  });
}

// Decode EXR file to raw RGBA8 bytes (no resize, no PNG encode).
// Faster than decodeExr for sequence playback: skips base64 + JSON
// serialization overhead on the pixel payload. Browser handles final
// resize via canvas drawImage. Note: no OCIO color conversion in this path.
export interface ExrRgbaResponse {
  success: boolean;
  rgba: Uint8Array | null;
  width: number | null;
  height: number | null;
  channels: string[] | null;
  layers_count: number | null;
  layer_names: string[] | null;
  error: string | null;
}

export async function decodeExrRgba(path: string): Promise<ExrRgbaResponse> {
  return invoke<ExrRgbaResponse>("decode_exr_rgba", {
    args: { path }
  });
}

/// Decode an EXR file to raw RGBA float32 (linear HDR, no PNG encode).
/// Used by the GPU-side OCIO LUT renderer — the frontend uploads the
/// payload to a WebGL2 R32G32B32A32F texture and tone-maps with a 3D LUT.
export interface ExrF32Response {
  success: boolean;
  rgba_f32: Float32Array | null;
  width: number | null;
  height: number | null;
  channels: string[] | null;
  layers_count: number | null;
  layer_names: string[] | null;
  dynamic_range: number | null;
  /// Pass type detected by Rust side ("beauty", "depth", "motion_vector", …).
  /// Mirrors `openexr_core::pass_type`. Used by the GPU pipeline to route
  /// non-color passes through the right shader path (skip OCIO/ACES).
  pass_type?: string | null;
  /**
   * Phase 6: Optional raw half-precision pixel buffer (Uint16Array) as
   * received from Rust, bypassing the JS half→float expansion. Set by
   * `decodeExrF16Raw` when the F16 IPC variant was used and no expansion
   * was needed. Null when the F32 path was used (or cache hit returned
   * the cached Float32Array). For the Beauty / RGB / AOV path this is
   * preferred over `rgba_f32` — saves the ~30 ms expansion cost and
   * half the heap allocation (14 MB vs 28 MB per 1920×1920 frame).
   */
  rgba_f16?: Uint16Array | null;
  /**
   * Phase 7: Optional RGBA8 pixel buffer (Uint8ClampedArray, 4 bytes/pixel)
   * for the passthrough `decode_exr_u8_rgba` fast path. When set this is
   * directly uploadable to a WebGL2 `gl.RGBA8` texture — bypasses the
   * half→float conversion entirely and removes the per-frame F32→U8 clamp
   * loop on the JS side. Total IPC payload drops from 28.8 MB (F16) to
   * 14.7 MB (U8) for a 1920×1920 frame.
   */
  rgba_u8?: Uint8ClampedArray | null;
  error: string | null;
}

/// Phase 6D-Lite: Same shape as `ExrF32Response` but the pixel payload is
/// half-precision (2 bytes/pixel). `rgba_f32` is still a `Float32Array`
/// because the rest of the pipeline (GPU upload + OCIO LUT sampling +
/// shader arithmetic) needs f32-precision intermediate values; the
/// half-precision format only saves the on-the-wire IPC bytes.
export interface ExrF16Response extends ExrF32Response {}

/// Phase 6: Raw F16 IPC variant — returns the wire payload
/// (Uint16Array of half-precision IEEE 754 bits) **without** expanding
/// to Float32Array on the JS side. The GPU upload path can consume this
/// directly via `RGBA16F` + `gl.HALF_FLOAT`. This eliminates the
/// ~30 ms half→float expansion per frame plus the 28 MB Float32Array
/// allocation that was wasted on every F16 IPC decode.
///
/// Behaviour: identical wire protocol to `decodeExrF16` (same Tauri
/// command, same byte layout). Only difference: response carries
/// `rgba_f16` instead of pre-expanded `rgba_f32`. The legacy
/// `decodeExrF16` (with expansion) is preserved for any caller that
/// still needs Float32Array input.
export interface ExrF16RawResponse {
  success: boolean;
  rgba_f16: Uint16Array | null;
  width: number | null;
  height: number | null;
  channels: string[] | null;
  layers_count: number | null;
  layer_names: string[] | null;
  dynamic_range: number | null;
  pass_type: string | null;
  error: string | null;
}

export async function decodeExrF32(
  path: string,
  maxSize?: number,
  layerName?: string | null,
): Promise<ExrF32Response> {
  return decodeExrGeneric("decode_exr_f32", path, maxSize, layerName);
}

/// Phase 6D-Lite: Half-precision variant of `decode_exr_f32`. Wire
/// payload is the same shape (header length u32 LE + header JSON +
/// pixel bytes), but the pixel bytes are 2 bytes/f32 instead of 4.
/// The frontend reinterprets the pixel ArrayBuffer as a `Uint16Array`
/// (half-precision IEEE 754 bits) and uploads it directly to a RGBA16F
/// `texImage2D` — no per-pixel JS Float32→Float16 conversion needed.
///
/// For Beauty / AOV passes this halves the IPC time with no visible
/// precision loss (half-float covers ±65504, well above the ACES peak
/// scene white of 16.29). For passes that genuinely need Float32
/// precision (e.g. depth > 16 stops below mid-grey), call
/// `decodeExrF32` instead.
export async function decodeExrF16(
  path: string,
  maxSize?: number,
  layerName?: string | null,
): Promise<ExrF16Response> {
  return decodeExrGeneric("decode_exr_f16", path, maxSize, layerName);
}

/// Phase 7: Passthrough decode for raw sRGB display.
///
/// Rust clamps the linear HDR RGBA buffer to `[0, 1]` and emits a
/// 1 byte/pixel wire payload (14.7 MB for 1920×1920 instead of
/// 28.8 MB F16 or 57.6 MB F32). The returned `rgba_u8:
/// Uint8ClampedArray` can be uploaded straight to a WebGL2
/// `gl.RGBA8` texture with `gl.texImage2D` — no JS half→float
/// expansion, no F32→U8 clamp loop, no `ImageData` round-trip.
///
/// Only valid when the display intent is raw sRGB / Linear with
/// `dynamic_range <= 1.0` (output fits in [0, 1]). For ACES / OCIO
/// LUT passes call `decodeExrF16` instead — the GPU fragment shader
/// needs the wider dynamic range.
export async function decodeExrU8(
  path: string,
  maxSize?: number,
  layerName?: string | null,
): Promise<ExrF32Response> {
  return decodeExrGeneric(
    "decode_exr_u8_rgba",
    path,
    maxSize,
    layerName,
  ) as unknown as ExrF32Response;
}

/// Phase 6: Decode via F16 IPC without expanding half→float on the JS side.
/// Returns `rgba_f16: Uint16Array` (raw half-precision bits, 2 bytes/pixel)
/// ready to be uploaded as `RGBA16F` directly. For passes where the F16
/// precision (1 sign + 5 exp + 10 mantissa = ±65504 range) is acceptable —
/// Beauty, RGB, denoised, AOVs in ACES domain — this is the fast path:
/// saves ~30 ms expansion + 14 MB of Float32Array allocation per frame.
///
/// For passes that need true Float32 precision (depth > 16 stops below
/// mid-grey, normals with negative values, motion vectors) call
/// `decodeExrF32` instead.
export async function decodeExrF16Raw(
  path: string,
  maxSize?: number,
  layerName?: string | null,
): Promise<ExrF16RawResponse> {
  const t0 = performance.now();
  const blob = (await invoke<ArrayBuffer>("decode_exr_f16", {
    args: { path, max_size: maxSize ?? 0, layer_name: layerName ?? null },
  })) as ArrayBuffer;
  const view = new DataView(blob);
  const headerLen = view.getUint32(0, true);
  const headerBytes = new Uint8Array(blob, 4, headerLen);
  const headerJson = new TextDecoder("utf-8").decode(headerBytes);
  const header = JSON.parse(headerJson) as {
    success: boolean;
    width: number | null;
    height: number | null;
    channels: string[] | null;
    layers_count: number | null;
    layer_names: string[] | null;
    dynamic_range: number | null;
    pass_type: string | null;
    error: string | null;
  };

  let rgbaF16: Uint16Array | null = null;
  if (header.success) {
    const pixelByteLen = blob.byteLength - 4 - headerLen;
    // Copy into an aligned buffer because the header length is variable
    // and the resulting pixel offset is not guaranteed to be 2-byte
    // aligned within the IPC ArrayBuffer. (Same trick as the legacy
    // f16→f32 path, minus the expansion.)
    const aligned = new ArrayBuffer(pixelByteLen);
    new Uint8Array(aligned).set(
      new Uint8Array(blob, 4 + headerLen, pixelByteLen),
    );
    rgbaF16 = new Uint16Array(aligned);
  }
  const elapsed = performance.now() - t0;
  if (header.success && rgbaF16) {
    console.log(
      `[Phase6] F16 raw IPC: ${elapsed.toFixed(1)}ms (${(rgbaF16.byteLength / 1024 / 1024).toFixed(2)} MB) — bypassed half→float expansion`,
    );
  } else {
    console.log(`[Phase6] F16 raw IPC failed in ${elapsed.toFixed(1)}ms: ${header.error ?? "unknown"}`);
  }
  return {
    success: header.success,
    rgba_f16: rgbaF16,
    width: header.width,
    height: header.height,
    channels: header.channels,
    layers_count: header.layers_count,
    layer_names: header.layer_names,
    dynamic_range: header.dynamic_range,
    pass_type: header.pass_type ?? null,
    error: header.error,
  };
}

/** Phase 5B: Live EXR cache LRU counters. Hit rate is `hits / (hits+misses)`. */
export interface ExrCacheStats {
  entries: number;
  bytes: number;
  mb: number;
  max_entries: number;
  hits: number;
  misses: number;
  puts: number;
  hit_rate: number;
}

export async function getExrCacheStats(): Promise<ExrCacheStats> {
  return invoke<ExrCacheStats>("get_exr_cache_stats");
}

export async function resetExrCacheStats(): Promise<void> {
  return invoke<void>("reset_exr_cache_stats");
}

async function decodeExrGeneric(
  command:
    | "decode_exr_f32"
    | "decode_exr_f16"
    | "decode_exr_u8_rgba",
  path: string,
  maxSize?: number,
  layerName?: string | null,
): Promise<ExrF32Response | ExrF16Response> {
  const blob = (await invoke<ArrayBuffer>(command, {
    args: { path, max_size: maxSize ?? 0, layer_name: layerName ?? null },
  })) as ArrayBuffer;
  const view = new DataView(blob);
  const headerLen = view.getUint32(0, true);
  const headerBytes = new Uint8Array(blob, 4, headerLen);
  const headerJson = new TextDecoder("utf-8").decode(headerBytes);
  const header = JSON.parse(headerJson) as {
    success: boolean;
    width: number | null;
    height: number | null;
    channels: string[] | null;
    layers_count: number | null;
    layer_names: string[] | null;
    dynamic_range: number | null;
    pass_type: string | null;
    format?: string | null;
    error: string | null;
  };

  let rgbaF32: Float32Array | null = null;
  let rgba_f16: Uint16Array | null = null;
  let rgba_u8: Uint8ClampedArray | null = null;
  if (header.success) {
    const pixelByteLen = blob.byteLength - 4 - headerLen;
    // Phase 7: trust the Rust-emitted `format` tag first, fall back to
    // the command name for backwards compatibility with older builds
    // that did not serialise the field.
    const wireFormat = header.format ?? (
      command === "decode_exr_f16" ? "f16"
      : command === "decode_exr_u8_rgba" ? "u8"
      : "f32"
    );
    if (wireFormat === "u8") {
      // 1 byte/pixel — copy into a fresh ArrayBuffer so the resulting
      // Uint8ClampedArray is exactly the wire payload (4-byte align-
      // ment not required for u8 but we copy anyway to keep the
      // parser uniform with the F16/F32 cases).
      const u8Bytes = new Uint8Array(blob, 4 + headerLen, pixelByteLen);
      const aligned = new ArrayBuffer(pixelByteLen);
      new Uint8Array(aligned).set(u8Bytes);
      rgba_u8 = new Uint8ClampedArray(aligned);
    } else if (wireFormat === "f16") {
      // Wire payload is half-precision IEEE 754 (2 bytes/pixel).
      // CRITICAL ALIGNMENT NOTE: `new Uint16Array(blob, byteOffset)`
      // requires `byteOffset` to be a multiple of 2. The Rust side
      // emits the header (4 bytes) followed by the JSON header, so
      // the pixel payload may start on any byte offset. We copy into
      // a new aligned ArrayBuffer to guarantee 2-byte alignment.
      const halfBytes = new Uint8Array(blob, 4 + headerLen, pixelByteLen);
      const halfAligned = new ArrayBuffer(pixelByteLen);
      new Uint8Array(halfAligned).set(halfBytes);
      rgba_f16 = new Uint16Array(halfAligned);
    } else {
      // f32 wire payload — reinterpret the same bytes as Float32Array.
      // Copy into an aligned buffer because the header length is
      // variable and the resulting pixel offset is not guaranteed to
      // be 4-byte aligned within the IPC ArrayBuffer.
      const aligned = new ArrayBuffer(pixelByteLen);
      new Uint8Array(aligned).set(new Uint8Array(blob, 4 + headerLen, pixelByteLen));
      rgbaF32 = new Float32Array(aligned);
    }
  }
  const base: ExrF32Response = {
    success: header.success,
    rgba_f32: rgbaF32,
    rgba_f16: rgba_f16,
    rgba_u8: rgba_u8,
    width: header.width,
    height: header.height,
    channels: header.channels,
    layers_count: header.layers_count,
    layer_names: header.layer_names,
    dynamic_range: header.dynamic_range,
    pass_type: header.pass_type ?? null,
    error: header.error,
  };
  return base as ExrF32Response;
}

/**
 * Phase 9: batch-decode helper.
 *
 * Wraps the Rust `decode_exr_batch_u8` command which fans out
 * `paths.length` decode jobs across the 32-worker-thread pool in a
 * single IPC roundtrip. Wire format is a small header + per-frame
 * offset table so the frontend can parse each frame with no extra
 * IPC calls.
 *
 * Returns one `ExrF32Response` per input path, in the same order.
 * Failed frames come back with `success: false`; the helper does
 * not throw so a single bad file can't sink the whole batch.
 */
export interface ExrBatchFrame {
  path: string;
  response: ExrF32Response;
}

export async function decodeExrBatch(
  paths: string[],
  maxSize?: number,
  layerName?: string | null,
): Promise<ExrBatchFrame[]> {
  if (paths.length === 0) return [];

  const blob = (await invoke<ArrayBuffer>("decode_exr_batch_u8", {
    args: {
      paths,
      max_size: maxSize ?? 0,
      layer_name: layerName ?? null,
    },
  })) as ArrayBuffer;

  const view = new DataView(blob);
  const frameCount = view.getUint32(0, true);
  const offsetTableLen = view.getUint32(4, true);

  if (frameCount === 0) return [];
  if (offsetTableLen !== frameCount * 8) {
    throw new Error(
      `[EXR-BATCH] Malformed batch payload (frameCount=${frameCount}, offsetTableLen=${offsetTableLen})`,
    );
  }

  const out: ExrBatchFrame[] = new Array(frameCount);
  let cursor = 8 + offsetTableLen;
  for (let i = 0; i < frameCount; i++) {
    const tableBase = 8 + i * 8;
    const headerLen = view.getUint32(tableBase, true);
    const payloadLen = view.getUint32(tableBase + 4, true);
    const headerBytes = new Uint8Array(blob, cursor, headerLen);
    const headerJson = new TextDecoder("utf-8").decode(headerBytes);
    const header = JSON.parse(headerJson) as {
      success: boolean;
      width: number | null;
      height: number | null;
      channels: string[] | null;
      layers_count: number | null;
      layer_names: string[] | null;
      dynamic_range: number | null;
      pass_type: string | null;
      format?: string | null;
      error: string | null;
    };
    cursor += headerLen;

    let rgbaF32: Float32Array | null = null;
    let rgba_f16: Uint16Array | null = null;
    let rgba_u8: Uint8ClampedArray | null = null;

    if (header.success) {
      const wireFormat = header.format ?? "u8";
      if (wireFormat === "u8") {
        const aligned = new ArrayBuffer(payloadLen);
        new Uint8Array(aligned).set(new Uint8Array(blob, cursor, payloadLen));
        rgba_u8 = new Uint8ClampedArray(aligned);
      } else if (wireFormat === "f16") {
        const aligned = new ArrayBuffer(payloadLen);
        new Uint8Array(aligned).set(new Uint8Array(blob, cursor, payloadLen));
        rgba_f16 = new Uint16Array(aligned);
      } else {
        const aligned = new ArrayBuffer(payloadLen);
        new Uint8Array(aligned).set(new Uint8Array(blob, cursor, payloadLen));
        rgbaF32 = new Float32Array(aligned);
      }
    }
    cursor += payloadLen;

    out[i] = {
      path: paths[i] ?? "",
      response: {
        success: header.success,
        rgba_f32: rgbaF32,
        width: header.width,
        height: header.height,
        channels: header.channels,
        layers_count: header.layers_count,
        layer_names: header.layer_names,
        dynamic_range: header.dynamic_range,
        pass_type: header.pass_type,
        rgba_f16,
        rgba_u8,
        error: header.error,
      },
    };
  }
  return out;
}

/**
 * Expand a Uint16Array of IEEE 754 half-precision floats into a Float32Array.
 * Used by `decode_exr_f16` to turn the IPC payload into the f32 buffer the
 * GPU shader expects. Saturating cast — out-of-range half values (±65504)
 * become ±Infinity in f32, which the shader then clamps via the LUT input
 * domain (u_lutInputMax).
 */
function halfFloatArrayToFloat32(half: Uint16Array): Float32Array {
  const buf = new ArrayBuffer(4);
  const fv = new Float32Array(buf);
  const iv = new Uint32Array(buf);
  const out = new Float32Array(half.length);
  for (let i = 0; i < half.length; i++) {
    const h = half[i];
    const sign = (h & 0x8000) << 16;
    let exp = (h >> 10) & 0x1f;
    let mant = h & 0x3ff;
    if (exp === 0) {
      if (mant === 0) {
        iv[0] = sign;
      } else {
        // Subnormal half → subnormal single.
        let e = -1;
        let m = mant;
        while ((m & 0x400) === 0) {
          m <<= 1;
          e--;
        }
        m &= 0x3ff;
        iv[0] = sign | (((e + 127) & 0xff) << 23) | (m << 13);
      }
    } else if (exp === 0x1f) {
      // Inf or NaN.
      iv[0] = sign | (0xff << 23) | (mant ? 0x200000 : 0);
    } else {
      iv[0] = sign | (((exp - 15 + 127) & 0xff) << 23) | (mant << 13);
    }
    out[i] = fv[0];
  }
  return out;
}

// Fast metadata-only extraction for EXR files (no pixel decode)
export interface ExrLayerInfo {
  name: string;
  has_rgb: boolean;
  has_alpha: boolean;
  channels: string[];
}

export interface ExrMetadataResult {
  success: boolean;
  width: number | null;
  height: number | null;
  channel_names: string[] | null;
  layer_names: ExrLayerInfo[] | null;
  cryptomatte_layers: string[] | null;
  layers_count: number | null;
  compression: string | null;
  pixel_type: string | null;
  error: string | null;
}

export async function getExrMetadata(path: string): Promise<ExrMetadataResult> {
  return invoke<ExrMetadataResult>("get_exr_metadata", { path });
}

// ── OCIO 3D LUT ────────────────────────────────────────────────────────────────

/// Compile-time-stable identifiers for the two legacy identity
/// passthrough modes. ACES modes are NOT in this object — their
/// slugs come from `listOcioGroups()` at runtime because the exact
/// set of (display, view) combinations baked in changes whenever
/// someone reruns the OCIO enumeration in `gen_luts.py`.
export const OCIO_MODE_SLUGS = {
  LINEAR_SRGB: "Linear_sRGB",
  RAW: "Raw",
  /**
   * 2026-07-13: Reinhard tone-mapping operator — an HDR compression
   * curve that maps an unbounded linear-light signal into [0, 1]
   * display-referred output. Unlike ACES it's a single closed-form
   * function (`L' = L / (1 + L)`) with no colour-space conversion,
   * so it's a good "preview" mode for HDRI content where the user
   * just wants to *see* the dynamic range without committing to a
   * full ACES RRT+ODT pipeline.
   *
   * Synthesised at runtime by `reinhardLut.ts` (no Rust IPC, no
   * pre-baked asset file). The slug lives here so the rest of the
   * codebase can reference it via the standard OCIO_MODE_SLUGS
   * enum pattern.
   */
  REINHARD: "Reinhard",
} as const;

export type OcioModeSlug = typeof OCIO_MODE_SLUGS[keyof typeof OCIO_MODE_SLUGS];

/// One row in the OCIO mode list returned by `listOcioModes()` /
/// `listOcioGroups()`. Built at compile time by `build.rs` (which
/// calls `Tools/gen_luts.py --list-views`) — this is the runtime
/// mirror of `exr_ocio_lut::OCIO_MODES`. `slug` is what
/// `getOcioLut()` accepts, `label` is the human-readable name shown
/// in the EXR Player dropdown, `lutInputMax` mirrors
/// `OcioLutResponse::input_max` so the renderer doesn't have to
/// refetch the LUT to know the input domain, `isIdentity` flags the
/// no-op passthrough modes (Linear sRGB / Raw).
///
/// 2-level UI fields (added for ACES 1.3 menu): `configSlug` and
/// `configLabel` group entries under an OCIO config (e.g. "ACES 1.3
/// CG"), `display` and `view` are the OCIO Display/View pair baked
/// into that LUT. Identity passthroughs have empty `configSlug` /
/// `configLabel` so the frontend can render them in a separate
/// "Passthrough" section above the config list.
export interface OcioModeInfo {
  slug: string;
  configSlug: string;
  configLabel: string;
  display: string;
  view: string;
  label: string;
  lutInputMax: number;
  isIdentity: boolean;
}

/// One OCIO config group, used to render the 2-level menu (OCIO mode
/// -> View Transform). Identity passthroughs are returned with empty
/// `configSlug` / `configLabel`; the frontend should render them in a
/// separate "Passthrough" section.
export interface OcioConfigGroup {
  configSlug: string;
  configLabel: string;
  views: OcioModeInfo[];
}

/// Fetch every baked LUT entry as a flat list. `listOcioGroups()` is
/// preferred for the UI; this endpoint is kept for callers that just
/// want the full slug set (e.g. for migration code).
export async function listOcioModes(): Promise<OcioModeInfo[]> {
  return invoke<OcioModeInfo[]>("list_ocio_modes");
}

/// Fetch OCIO modes grouped by config (OCIO mode -> View
/// Transforms). This is the preferred endpoint for populating the
/// EXR Player dropdown because the frontend doesn't need to
/// re-parse labels to know which entry belongs to which group.
export async function listOcioGroups(): Promise<OcioConfigGroup[]> {
  return invoke<OcioConfigGroup[]>("list_ocio_groups");
}

export interface OcioLutResponse {
  success: boolean;
  mode: string | null;
  /// Grid resolution (e.g. 33 → 33×33×33 voxels).
  lut_size: number | null;
  /// Flat float32 buffer; voxel order: ((b * N + g) * N + r) * 3.
  /// Length must equal lut_size^3 * 3.
  lut_data: Float32Array | null;
  /// Scene-linear input domain the LUT was baked over (e.g. 16.29 for
  /// ACES RRT peak white). The GPU / CPU renderers divide per-pixel
  /// linear values by this constant before indexing. Always populated
  /// when `success` is true; the frontend passes it to
  /// `setLutInputMax()` on the renderer.
  input_max: number | null;
  error: string | null;
}

/// Fetch a baked OCIO 3D LUT for the given mode slug. Cached on the
/// Rust side, so calling repeatedly is cheap. `mode` is the same
/// string as `OcioModeInfo.slug` returned by `listOcioModes()`.
///
/// **Performance note**: this ships the float32 payload (~25 MB for
/// the 129³ built-in LUTs) over the Tauri IPC bridge as JSON, which
/// V8 has to deserialize into ~786,432 numbers — that's the hot-path
/// bottleneck the EXR Player hit when switching OCIO modes. For
/// pre-baked built-in modes prefer the asset-URL flow:
///
///   const meta = await getOcioLutMetadata(slug);
///   const url  = await getOcioLutAssetUrl(slug);
///   const buf  = await (await fetch(url)).arrayBuffer();
///   const data = new Float32Array(buf);
///
/// That route bypasses JSON marshalling entirely — the bytes stream
/// over Tauri's Asset Protocol (HTTP-style) and the browser parses
/// them directly into an ArrayBuffer. This command is retained for
/// runtime-baked custom OCIO configs returned by `bakeOcioLutFromConfig`,
/// which we don't yet have on disk.
export async function getOcioLut(mode: string): Promise<OcioLutResponse> {
  const raw = await invoke<{
    success: boolean;
    mode: string | null;
    lut_size: number | null;
    lut_data: number[] | null;
    input_max: number | null;
    error: string | null;
  }>("get_ocio_lut", { mode });
  return {
    ...raw,
    lut_data: raw.lut_data ? new Float32Array(raw.lut_data) : null,
  };
}

/// Tiny metadata-only response from `getOcioLutMetadata`. No float32
/// payload — just `lut_size`, `input_max`, and on-disk file size.
export interface OcioLutMetadataResponse {
  success: boolean;
  slug: string | null;
  lut_size: number | null;
  input_max: number | null;
  file_size_bytes: number | null;
  error: string | null;
}

/// Look up the metadata (size, input domain, file size on disk) of a
/// pre-baked OCIO 3D LUT. Pairs with `getOcioLutAssetUrl` to skip the
/// ~400 MB JSON marshalling cost of `getOcioLut`. Throws if the slug
/// is unknown or the .bin file is missing on disk — caller should
/// fall back to `getOcioLut` for runtime-baked custom configs.
export async function getOcioLutMetadata(
  mode: string,
): Promise<OcioLutMetadataResponse> {
  return invoke<OcioLutMetadataResponse>("get_ocio_lut_metadata", { mode });
}

/// Resolve a pre-baked LUT slug to an `asset://localhost/...` URL
/// that the webview can `fetch()` directly. Pairs with
/// `getOcioLutMetadata` — together they avoid the JSON marshalling
/// cost of `getOcioLut` for the 16 built-in modes shipped in
/// `bundle_dist/luts/`. Throws if the slug is unknown or the .bin
/// file is missing on disk.
export async function getOcioLutAssetUrl(mode: string): Promise<string> {
  return invoke<string>("get_ocio_lut_asset_url", { mode });
}

// ─────────────────────────────────────────────────────────────────────────
// Custom OCIO config (user-supplied .ocio file)
// ─────────────────────────────────────────────────────────────────────────
//
// The user can point the EXR viewer at any OCIO config file (built-in
// `ocio://…` URLs work too, as does an `aces_1.2` config they downloaded
// from the OpenColorIO-Config-ACES releases). At runtime we ask the bundled
// Python (which ships with PyOpenColorIO) to bake a 33³ 3D LUT for the
// chosen Display/View pair; the result is cached and uploaded to the GPU
// just like the embedded LUTs.

export interface CustomOcioResponse {
  success: boolean;
  lut_data: Float32Array | null;
  lut_size: number | null;
  /// Scene-linear input domain the LUT was baked over (mirrors
  /// `bake_ocio_lut.LUT_INPUT_MAX`). Only populated for bake
  /// responses; the frontend passes it to `setLutInputMax()` on the
  /// renderer.
  input_max: number | null;
  config_path: string | null;
  display: string | null;
  view: string | null;
  displays: string[] | null;
  views: string[] | null;
  default_display: string | null;
  default_view: string | null;
  error: string | null;
}

/// List the available displays + views of a custom OCIO config without
/// baking. Used by the UI to populate dropdowns once the user has picked
/// a config file.
export async function listOcioConfig(configPath: string): Promise<CustomOcioResponse> {
  const raw = await invoke<{
    success: boolean;
    lut_data: number[] | null;
    lut_size: number | null;
    input_max: number | null;
    config_path: string | null;
    display: string | null;
    view: string | null;
    displays: string[] | null;
    views: string[] | null;
    default_display: string | null;
    default_view: string | null;
    error: string | null;
  }>("list_ocio_config", { configPath });
  return {
    ...raw,
    lut_data: raw.lut_data ? new Float32Array(raw.lut_data) : null,
  };
}

/// Bake a 3D LUT from a custom OCIO config. Cached on the Rust side keyed
/// by (configPath, display, view, size); repeat calls are O(1).
export async function bakeOcioLutFromConfig(
  configPath: string,
  display: string,
  view: string,
  size?: number,
): Promise<CustomOcioResponse> {
  const raw = await invoke<{
    success: boolean;
    lut_data: number[] | null;
    lut_size: number | null;
    input_max: number | null;
    config_path: string | null;
    display: string | null;
    view: string | null;
    displays: string[] | null;
    views: string[] | null;
    default_display: string | null;
    default_view: string | null;
    error: string | null;
  }>("bake_ocio_lut_from_config", {
    configPath,
    display,
    view,
    size: size ?? null,
  });
  return {
    ...raw,
    lut_data: raw.lut_data ? new Float32Array(raw.lut_data) : null,
  };
}

/// Sentinel slug used to identify the "Custom OCIO config" OCIO mode in
/// the frontend. The actual LUT data lives in module-scope state on the
/// EXR pipeline side (not in the embedded-LUT byte arrays), so this slug
/// doesn't appear in `OCIO_MODE_SLUGS` proper.
export const OCIO_CUSTOM_MODE = "Custom_OCIO_Config";

// EXR Channel extraction result
export interface ExrChannelResult {
  success: boolean;
  png_base64: string | null;
  width: number | null;
  height: number | null;
  channel_name: string | null;
  error: string | null;
}

// Decode EXR channel as grayscale PNG (optionally from specific layer).
//
// 2026-07-05: added `maxSize` param so the Rust FFI can downscale the
// PNG to match the player's preview-quality budget (parity with
// `decodeExrF32` which already honours `max_size`). Omitting `maxSize`
// keeps the legacy "native resolution" behaviour for back-compat
// callers.
export async function decodeExrChannel(
  path: string,
  channel: string,
  layerName?: string,
  maxSize?: number,
): Promise<ExrChannelResult> {
  const args: Record<string, unknown> = { path, channel };
  if (layerName) args.layer = layerName;
  // `max_size` is `Option<u32>` on the Rust side — undefined → None.
  if (maxSize !== undefined) args.max_size = maxSize;
  return invoke<ExrChannelResult>("decode_exr_channel", args);
}

export interface ExrCryptoLayerResult {
  success: boolean;
  png_base64: string | null;
  width: number | null;
  height: number | null;
  crypto_layer: string | null;
  channels: string[] | null;
  error: string | null;
}

export async function decodeExrCryptoLayer(path: string, cryptoLayer: string, maxSize?: number, coverageMode: "g" | "a" | "max" = "max"): Promise<ExrCryptoLayerResult> {
  return invoke<ExrCryptoLayerResult>("decode_exr_crypto_layer", {
    path,
    crypto_layer: cryptoLayer,
    max_size: maxSize,
    coverage_mode: coverageMode
  });
}

export interface ExrCryptoChannelResult {
  success: boolean;
  png_base64: string | null;
  width: number | null;
  height: number | null;
  crypto_layer: string | null;
  component: string | null;
  error: string | null;
}

export async function decodeExrCryptoChannel(path: string, cryptoLayer: string, component: string, maxSize?: number): Promise<ExrCryptoChannelResult> {
  return invoke<ExrCryptoChannelResult>("decode_exr_crypto_channel", {
    path,
    crypto_layer: cryptoLayer,
    component,
    max_size: maxSize
  });
}

// Preload EXR sequence is now a no-op (RAM-only cache).
// The UI fires a continuous background loader via LayerCacheManager.
// We keep a stub so existing callers don't break during the transition.
export interface PreloadExrResult {
  success: boolean;
  cached_paths: string[];
  success_count: number;
  cache_dir: string | null;
  error: string | null;
}

export async function preloadExrSequence(
  _paths: string[],
  _maxSize?: number,
  _ocioMode?: string,
  _layerName?: string
): Promise<PreloadExrResult> {
  return {
    success: true,
    cached_paths: [],
    success_count: 0,
    cache_dir: null,
    error: null,
  };
}

// Read cached PNG from disk - no longer used (RAM cache only).
export async function readCachedPng(_cacheDir: string, _frameIndex: number): Promise<string | null> {
  return null;
}

// Get Windows Shell icon for a file as base64 PNG
export async function getFileIconBase64(path: string, size?: number): Promise<string> {
  return invoke<string>("get_file_icon_base64", { path, size });
}

// ── Transfer engine (Phase 0 foundation) ──────────────────────────────────
import type { TransferJobView } from "./types/transfer";

export type {
  TransferMode,
  TransferStatus,
  ConflictAction,
  ConflictKind,
  FailedItem,
  TransferJobView,
  ProgressEvent,
  StatusEvent,
  ConflictEvent,
  StartTransferArgs,
  StartTransferResult,
} from "./types/transfer";

export async function startTransfer(
  sourcePaths: string[],
  targetDir: string,
  mode: "copy" | "move",
): Promise<{ job_id: string }> {
  return invoke<{ job_id: string }>("start_transfer", {
    args: { source_paths: sourcePaths, target_dir: targetDir, mode },
  });
}

export async function pauseTransfer(jobId: string): Promise<void> {
  return invoke<void>("pause_transfer", { jobId });
}

export async function resumeTransfer(jobId: string): Promise<void> {
  return invoke<void>("resume_transfer", { jobId });
}

export async function cancelTransfer(jobId: string): Promise<void> {
  return invoke<void>("cancel_transfer", { jobId });
}

export async function resolveConflict(
  jobId: string,
  itemIndex: number,
  action:
    | "replace"
    | "skip"
    | "keep_both"
    | "replace_all"
    | "skip_all",
): Promise<void> {
  return invoke<void>("resolve_conflict", {
    jobId,
    itemIndex,
    action,
  });
}

export async function listTransfers(): Promise<TransferJobView[]> {
  return invoke<TransferJobView[]>("list_transfers");
}

export interface RestoreResult {
  success: boolean;
  restored_count: number;
  failed_count: number;
  errors: string[];
}

export async function restoreFromRecycleBin(
  sourcePaths: string[],
  destination: string,
): Promise<RestoreResult> {
  return invoke<RestoreResult>("restore_from_recycle_bin", {
    sourcePaths,
    destination,
  });
}

/// Restore a list of structured Recycle Bin entries back to their
/// original locations. This is the right function to call after a
/// "cut from Recycle Bin" paste: the frontend already has each item's
/// `name` + `original_parent` from the listing, so there's no path
/// matching guessing involved.
export async function restoreRecycleBinEntries(
  items: Array<{ parsing_name: string; original_parent: string; name: string }>,
): Promise<RestoreResult> {
  return invoke<RestoreResult>("restore_recycle_bin_entries", { items });
}

/// Enumerate the items currently in the Recycle Bin. Returns structured
/// data the frontend uses to populate the Recycle Bin view AND to send
/// back to `restoreRecycleBinEntries` on cut/paste.
export async function listRecycleBinEntries(): Promise<
  Array<{ parsing_name: string; original_parent: string; name: string }>
> {
  return invoke<Array<{ parsing_name: string; original_parent: string; name: string }>>(
    "list_recycle_bin_entries",
  );
}

export async function dismissTransfer(jobId: string): Promise<void> {
  return invoke<void>("dismiss_transfer", { jobId });
}

export async function clearThumbnails(paths: string[]): Promise<void> {
  return invoke<void>("clear_thumbnails", { paths });
}

import { FSItem } from './types';

// ── Tags (pre-existing stub: useExplorer.ts imports these but they
// were never exported. Defined as no-op stubs so tsc passes. The
// app's tag system actually persists via localStorage, see
// useExplorer.ts:NEXUS_ITEM_TAGS.) ──────────────────────────────────────
export type FSItemTag = "Deliverable" | "WIP" | "Draft" | "Archived" | "Warning";
export function getTags(): Record<string, FSItemTag> {
  try {
    const raw = localStorage.getItem("NEXUS_ITEM_TAGS");
    return raw ? (JSON.parse(raw) as Record<string, FSItemTag>) : {};
  } catch {
    return {};
  }
}
export function saveTags(_tags: Record<string, FSItemTag>): void {
  // Persistence is handled inline at the call sites; this stub exists
  // only to satisfy the existing import in useExplorer.ts.
}

export function fileEntryToFSItem(entry: FileEntry): FSItem {
  const parent = getParentPath(entry.path);
  return {
    id: entry.path,
    name: entry.name,
    path: entry.path,
    type: entry.is_dir ? "directory" : "file",
    parentId: parent,
    size: entry.size,
    content: undefined,
    createdAt: entry.created || new Date().toISOString(),
    updatedAt: entry.modified || new Date().toISOString(),
    isHidden: entry.is_hidden ?? false,
  };
}

// ── Phase 1: Shell Extensions (Windows Registry) ─────────────────────────
// Surfacing the same entries Windows File Explorer's "Show more options"
// shows — context menu handlers registered by antivirus, dev tools, etc.

export type ShellScope =
  | "files"
  | "directory"
  | "background"
  | "drive"
  | "desktop"
  | "all_file_system";

export interface ContextMenuEntry {
  /** Raw command ID assigned by `IContextMenu::QueryContextMenu`. Not stable
   *  across processes — only useful as a tie-breaker when two items share a
   *  verb string. */
  id: number;
  /** Display text with accelerator characters (`&`) stripped. */
  label: string;
  /** Shell verb string (e.g. `"open"`, `"delete"`, `"Found"`, `"7-Zip"`).
   *  May be `null` for static entries that don't expose a verb. */
  command_string: string | null;
  is_separator: boolean;
  is_disabled: boolean;
  is_checked: boolean;
  is_default: boolean;
  /** Nested submenu (Win11 "Show more options" → "Open with" is a common case). */
  submenu: ContextMenuEntry[];
}

export interface ShellEntriesResponse {
  files: ContextMenuEntry[];
  directory: ContextMenuEntry[];
  background: ContextMenuEntry[];
  drive: ContextMenuEntry[];
  desktop: ContextMenuEntry[];
  all_file_system: ContextMenuEntry[];
}

export interface ShellExecuteResult {
  ok: boolean;
  error_code: number;
  message: string;
  verb: string;
}

/**
 * Phase 2 — enumerate shell context menu entries for a specific target path.
 *
 * Returns the same shape as `listShellExtensions`, but the `files` /
 * `directory` / `background` scopes reflect the actual item the user
 * right-clicked. Empty arrays mean the scope wasn't probed (e.g. no parent
 * directory for a top-level file).
 */
export async function listShellExtensionsForTarget(
  targetPath: string
): Promise<ShellEntriesResponse> {
  return invoke<ShellEntriesResponse>("list_shell_extensions_for_target", {
    targetPath,
  });
}

/**
 * Phase 2 — invoke a Windows shell verb on `target`.
 *
 * `verb` must be the exact string from `ContextMenuEntry.command_string`,
 * e.g. `"open"`, `"Found"`, `"properties"`, `"7-Zip"`. We use the same
 * `IContextMenu::InvokeCommand` path the plugin's `invoke_verb` does, so
 * every verb that shows up in Explorer also works here.
 */
export async function executeShellExtensionVerb(
  targetPath: string,
  verb: string
): Promise<ShellExecuteResult> {
  return invoke<ShellExecuteResult>("execute_shell_extension", {
    targetPath,
    verb,
  });
}

/**
 * Phase 2.1 — fetch the standard shell-system icon (16×16 PNG) for a
 * known verb (`open`, `cut`, `copy`, `paste`, `delete`, `rename`,
 * `properties`, …). Returns the data: URL body (base64 PNG) or `null`
 * when the verb has no system icon we recognise.
 *
 * Third-party verbs (e.g. `7-Zip`, `Found`, `Edit with Notepad`) return
 * `null` so the frontend can fall back to its generic icon glyph.
 */
export async function getVerbIcon(verb: string): Promise<string | null> {
  return invoke<string | null>("get_verb_icon", { verb });
}

/**
 * Phase 2 — generic enumeration that uses the current process exe as a probe
 * path. Useful for pre-warming caches or showing the registry inventory
 * without a specific right-click target.
 */
export async function listShellExtensions(): Promise<ShellEntriesResponse> {
  return invoke<ShellEntriesResponse>("list_shell_extensions", {
    targetExtension: null,
  });
}
