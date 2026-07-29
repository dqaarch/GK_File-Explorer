// Fast PSD Engine - Zero-dependency PSD thumbnail extraction
// Architecture: 4-tier pipeline, each tier falls through to the next if it fails.
// Tier 1: Parse PSD header + Image Resource block for embedded JPEG thumbnail (pure Rust, no library)
// Tier 2: Windows Shell thumbnail (IExtractImage, uses Windows thumbnail cache)
// Tier 3: psd crate full parse + flatten_layers_rgba (layer compositing)
// Tier 4: psd crate raw rgba() as last resort

use image::ImageFormat;
use std::io::Cursor;
use std::path::Path;

// PSD binary format constants
const RESOURCE_SIGNATURE: &[u8] = b"8BIM";
const THUMBNAIL_RESOURCE_V4: u16 = 1033;
const THUMBNAIL_RESOURCE_V5: u16 = 1036;
const MAX_PREVIEW_BYTES: usize = 1024 * 1024 * 5; // 5 MB max for thumbnail resource scan

/// Result of fast PSD extraction
pub struct PsdThumbResult {
    /// PNG bytes of the thumbnail
    pub png_data: Vec<u8>,
    /// Original thumbnail width
    pub width: u32,
    /// Original thumbnail height
    pub height: u32,
    /// Extraction method used
    pub method: &'static str,
    /// Number of layers (if known)
    pub layers_count: Option<usize>,
}

/// Extract PSD thumbnail using the fastest available method.
/// Returns (png_bytes, method_name, layers_count).
pub fn extract_psd_thumbnail(
    data: &[u8],
    max_size: usize,
) -> Option<PsdThumbResult> {
    if let Some(result) = extract_embedded_thumbnail_from_resource(data, max_size) {
        return Some(result);
    }
    if let Some(result) = extract_via_psd_crate_composited(data, max_size) {
        return Some(result);
    }
    extract_via_psd_crate_raw(data, max_size)
}

/// Public accessor for Tier 1 (embedded JPEG). Used by progress-aware decode
/// pipeline so each tier can emit its own progress message.
pub fn extract_embedded_thumbnail_from_resource_pub(
    data: &[u8],
    max_size: usize,
) -> Option<PsdThumbResult> {
    extract_embedded_thumbnail_from_resource(data, max_size)
}

/// Public accessor for Tier 2 (psd crate composited).
pub fn extract_via_psd_crate_composited_pub(
    data: &[u8],
    max_size: usize,
) -> Option<PsdThumbResult> {
    extract_via_psd_crate_composited(data, max_size)
}

/// Public accessor for Tier 3 (psd crate raw).
pub fn extract_via_psd_crate_raw_pub(
    data: &[u8],
    max_size: usize,
) -> Option<PsdThumbResult> {
    extract_via_psd_crate_raw(data, max_size)
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER 1: Pure-Rust embedded JPEG extraction from PSD Image Resource block
// ─────────────────────────────────────────────────────────────────────────────
//
// PSD file structure (big-endian):
//   Offset  Size  Field
//   0       4     Signature: "8BPS"
//   4       2     Version: 1=PSD, 2=PSB
//   6       6     Reserved (6 bytes)
//   12      2     Number of channels (1-56)
//   14      4     Height in pixels
//   18      4     Width in pixels
//   22      2     Depth: 1, 8, 16, or 32 bits
//   24      2     Color mode: 0=Bitmap, 1=Grayscale, 2=Indexed, 3=RGB, 4=CMYK, 7=Multichannel, 8=Duotone, 9=Lab
//   26      4     Color mode data length
//   30      ...   Color mode data
//   ...     4     Image resources section length
//   ...     ...   Image Resource blocks
//   ...     ...   Layer and mask data section
//   ...     ...   Image data
//
// Image Resource block structure:
//   4 bytes: "8BIM" signature
//   2 bytes: Resource ID (big-endian u16)  — 1036 for thumbnail v5, 1033 for v4
//   Variable: Pascal string name (even-length padded)
//   4 bytes: Size of resource data (big-endian u32)
//   ...: Resource data
//
// Thumbnail resource data (28-byte header + JPEG JFIF):
//   4 bytes: Format (1=kJpegRGB, 0=kRawRGB)
//   4 bytes: Width
//   4 bytes: Height
//   4 bytes: WidthBytes (padded row bytes)
//   4 bytes: TotalSize
//   4 bytes: CompressedSize
//   2 bytes: BitsPerPixel (24)
//   2 bytes: Planes (1)
//   N bytes: JFIF-encoded JPEG data (RGB for 1036, BGR for 1033)
//
fn extract_embedded_thumbnail_from_resource(
    data: &[u8],
    max_size: usize,
) -> Option<PsdThumbResult> {
    // Quick validation: must be at least 30 bytes for header
    if data.len() < 30 {
        return None;
    }

    // Verify PSD signature
    if &data[0..4] != b"8BPS" {
        return None;
    }

    // Read section lengths to find Image Resources offset

    // Color mode data section length (4 bytes after fixed 26-byte header)
    let color_mode_len = read_u32be(&data[26..30]) as usize;

    // After header (26) + color_mode_len + its padding + 4-byte length field
    let mut offset = 26 + color_mode_len;
    // Color mode data is padded to 2-byte boundary
    if color_mode_len % 2 != 0 {
        offset += 1;
    }

    // Image Resources section length (4 bytes)
    if offset + 4 > data.len() {
        return None;
    }
    let resources_len = read_u32be(&data[offset..offset + 4]) as usize;
    offset += 4;

    let resources_end = offset.saturating_add(resources_len);
    if resources_end > data.len() {
        return None;
    }

    // Scan for thumbnail resource blocks within budgeted bytes
    let scan_end = std::cmp::min(offset + MAX_PREVIEW_BYTES, resources_end);

    // Try 1036 first (Photoshop 5.0+, RGB JPEG)
    if let Some(result) = find_thumbnail_in_resources(data, offset, scan_end, THUMBNAIL_RESOURCE_V5, max_size, "embedded_jpeg_rgb") {
        return Some(result);
    }

    // Fallback to 1033 (Photoshop 4.0, BGR JPEG)
    find_thumbnail_in_resources(data, offset, scan_end, THUMBNAIL_RESOURCE_V4, max_size, "embedded_jpeg_bgr")
}

fn find_thumbnail_in_resources(
    data: &[u8],
    mut offset: usize,
    end: usize,
    target_id: u16,
    max_size: usize,
    method: &'static str,
) -> Option<PsdThumbResult> {
    while offset + 12 <= end {
        // Try to find next "8BIM" signature from current offset
        let Some(sig_pos) = memchr::memmem::find(&data[offset..end], b"8BIM") else {
            break;
        };
        offset += sig_pos;

        // Verify it's a real resource block (signature + 2 bytes ID must fit)
        if offset + 6 > end { break; }
        if &data[offset..offset + 4] != RESOURCE_SIGNATURE {
            offset += 1;
            continue;
        }
        offset += 4;

        let id = u16::from_be_bytes([data[offset], data[offset + 1]]);
        offset += 2;

        if id != target_id {
            // Skip pascal string name
            if offset + 1 > end { break; }
            let name_len = data[offset] as usize;
            offset += 1;
            let name_padded = if (name_len + 1) % 2 == 0 { name_len + 1 } else { name_len + 2 };
            offset += name_padded;
            if offset + 4 > end { break; }
            let data_len = read_u32be(&data[offset..offset + 4]) as usize;
            offset += 4 + data_len;
            if data_len % 2 != 0 { offset += 1; }
            continue;
        }

        // Found the thumbnail resource ID
        // Skip pascal string name
        if offset + 1 > end { break; }
        let name_len = data[offset] as usize;
        offset += 1;
        let name_padded = if (name_len + 1) % 2 == 0 { name_len + 1 } else { name_len + 2 };
        offset += name_padded;
        if offset + 4 > end { break; }

        let resource_data_len = read_u32be(&data[offset..offset + 4]) as usize;
        offset += 4;

        // Thumbnail header is 28 bytes, followed by JPEG data
        if resource_data_len < 28 {
            return None;
        }

        let jpeg_start = offset;
        let jpeg_end = (offset + resource_data_len).min(data.len());

        // Parse thumbnail header
        let _format = read_u32be(&data[jpeg_start..jpeg_start + 4]);
        let width = read_u32be(&data[jpeg_start + 4..jpeg_start + 8]);
        let height = read_u32be(&data[jpeg_start + 8..jpeg_start + 12]);

        let jpeg_data = &data[jpeg_start + 28..jpeg_end];

        // Decode JPEG and resize
        if let Ok(img) = image::load_from_memory(jpeg_data) {
            let (tw, th) = calc_thumb_dims(width, height, max_size);
            let resized = image::imageops::resize(
                &img.to_rgb8(), tw, th,
                image::imageops::FilterType::Lanczos3,
            );
            let mut png_buf = Vec::new();
            if resized.write_to(&mut Cursor::new(&mut png_buf), ImageFormat::Png).is_ok() {
                return Some(PsdThumbResult {
                    png_data: png_buf,
                    width,
                    height,
                    method,
                    layers_count: None,
                });
            }
        }

        // Resource found but decode failed - stop trying this ID
        return None;
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER 2 & 3: psd crate composited / raw image
// ─────────────────────────────────────────────────────────────────────────────

fn extract_via_psd_crate_composited(data: &[u8], max_size: usize) -> Option<PsdThumbResult> {
    let psd_file = psd::Psd::from_bytes(data).ok()?;
    let width = psd_file.width();
    let height = psd_file.height();
    let layers_count = psd_file.layers().len();

    // Use flatten_layers_rgba for proper layer compositing (respects blend modes, effects)
    let rgba = psd_file
        .flatten_layers_rgba(&|(_idx, layer)| !layer.name().starts_with('_'))
        .unwrap_or_else(|_| psd_file.rgba());

    let img = image::RgbaImage::from_raw(width, height, rgba)?;
    let (tw, th) = calc_thumb_dims_u32(width, height, max_size);
    let resized = image::imageops::resize(&img, tw, th, image::imageops::FilterType::Lanczos3);

    let mut png_buf = Vec::new();
    if resized
        .write_to(&mut Cursor::new(&mut png_buf), ImageFormat::Png)
        .is_ok()
    {
        Some(PsdThumbResult {
            png_data: png_buf,
            width,
            height,
            method: "psd_composited",
            layers_count: Some(layers_count),
        })
    } else {
        None
    }
}

fn extract_via_psd_crate_raw(data: &[u8], max_size: usize) -> Option<PsdThumbResult> {
    let psd_file = psd::Psd::from_bytes(data).ok()?;
    let width = psd_file.width();
    let height = psd_file.height();
    let layers_count = psd_file.layers().len();

    let rgba = psd_file.rgba();
    let img = image::RgbaImage::from_raw(width, height, rgba)?;
    let (tw, th) = calc_thumb_dims_u32(width, height, max_size);
    let resized = image::imageops::resize(&img, tw, th, image::imageops::FilterType::Lanczos3);

    let mut png_buf = Vec::new();
    if resized
        .write_to(&mut Cursor::new(&mut png_buf), ImageFormat::Png)
        .is_ok()
    {
        Some(PsdThumbResult {
            png_data: png_buf,
            width,
            height,
            method: "psd_raw",
            layers_count: Some(layers_count),
        })
    } else {
        None
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

#[inline]
fn read_u32be(data: &[u8]) -> u32 {
    u32::from_be_bytes([data[0], data[1], data[2], data[3]])
}

fn calc_thumb_dims(width: u32, height: u32, max_size: usize) -> (u32, u32) {
    calc_thumb_dims_u32(width, height, max_size)
}

fn calc_thumb_dims_u32(width: u32, height: u32, max_size: usize) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (1, 1);
    }
    let max = max_size as u32;
    if width >= height {
        let h = ((height as f64 / width as f64) * max as f64).ceil().max(1.0) as u32;
        (max, h)
    } else {
        let w = ((width as f64 / height as f64) * max as f64).ceil().max(1.0) as u32;
        (w, max)
    }
}

/// Check if this is a valid PSD file (header only, no full parse)
#[allow(dead_code)]
pub fn is_psd_file(path: &Path) -> bool {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut header = [0u8; 26];
    if std::io::Read::read(&mut file, &mut header).ok() != Some(26) {
        return false;
    }
    &header[0..4] == b"8BPS"
}
