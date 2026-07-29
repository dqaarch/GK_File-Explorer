// Fast Image Engine - Optimized thumbnail generation for file explorer
// Strategy: Try fastest path first, fall through to full decode only if needed.
//
// Pipeline per format:
//   JPEG  -> EXIF thumbnail (5ms) | image crate JPEG decode + smart resize (50ms)
//   PNG   -> Serve original if < max_size | image crate + resize (30ms)
//   WebP  -> image crate (uses libjpeg-turbo/rav1d under the hood)
//   TIFF  -> Embedded JPEG preview | image crate
//   RAW   -> image crate (limited) | fallback
//   Other -> image crate (standard decode + resize)
//
// Key optimizations:
// 1. JPEG: EXIF thumbnail extraction (no DCT decode needed)
// 2. JPEG: JPEGDecoder for efficient decoding
// 3. TIFF: Embedded JPEG preview extraction
// 4. All formats: Smart resize (keep <768px original, resize >768px only)

use std::fs;
use std::io::{BufReader, Cursor};
use std::path::Path;

use image::ImageDecoder;

pub struct ImageThumbResult {
    pub png_data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub method: &'static str,
}

/// Generate fast thumbnail for any supported image format.
/// Falls through to the next tier if a faster method isn't available.
pub fn extract_thumbnail(
    path: &Path,
    max_size: usize,
) -> Option<ImageThumbResult> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())?;

    match ext.as_str() {
        "jpg" | "jpeg" => extract_jpeg_thumbnail(path, max_size),
        "png" => extract_png_thumbnail(path, max_size),
        "webp" => extract_webp_thumbnail(path, max_size),
        "gif" => extract_gif_thumbnail(path, max_size),
        "bmp" => extract_bmp_thumbnail(path, max_size),
        "tiff" | "tif" => extract_tiff_thumbnail(path, max_size),
        "ico" => extract_ico_thumbnail(path, max_size),
        "tga" => extract_tga_thumbnail(path, max_size),
        "exr" | "hdr" => extract_exr_hdr_thumbnail(path, max_size),
        "cr2" | "nef" | "arw" | "dng" | "raf" | "orf" | "rw2" | "pef" | "srw"
        | "cr3" | "3fr" | "dcr" | "mrw" | "nxp" | "ptx" | "rwl" | "sr2" | "x3f" => {
            extract_raw_thumbnail(path, max_size)
        }
        "heic" | "heif" => extract_heic_thumbnail(path, max_size),
        "avif" => extract_avif_thumbnail(path, max_size),
        _ => None,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// JPEG: Fastest tier - EXIF thumbnail extraction
// ─────────────────────────────────────────────────────────────────────────────

fn extract_jpeg_thumbnail(path: &Path, max_size: usize) -> Option<ImageThumbResult> {
    let data = fs::read(path).ok()?;

    // Tier 1: EXIF thumbnail (embedded JPEG preview in EXIF metadata)
    // This is the fastest path - no DCT decode needed, just EXIF IFD parsing
    if let Some(result) = extract_exif_thumbnail(&data, max_size) {
        return Some(result);
    }

    // Tier 2: Image crate with JPEG decoder (efficient)
    extract_jpeg_via_image_crate(&data, path, max_size)
}

/// Extract embedded JPEG thumbnail from EXIF APP1 segment.
/// Most camera/phone JPEGs have a 160x120 or 320x240 preview embedded here.
fn extract_exif_thumbnail(data: &[u8], max_size: usize) -> Option<ImageThumbResult> {
    // Find APP1 (EXIF) marker: FF E1
    let mut offset = 2; // Skip SOI (FF D8)
    while offset + 4 < data.len() {
        if data[offset] != 0xFF || data[offset + 1] == 0xD8 || data[offset + 1] == 0xD9 {
            offset += 1;
            continue;
        }
        let marker = data[offset + 1];

        // Skip markers without length (0xD0-0xDF range except DA, DB, DC, DD)
        if matches!(marker, 0xD0..=0xDF) && marker != 0xDA && marker != 0xDB {
            offset += 2;
            continue;
        }

        // Skip markers with no data (E0-EF range handled by length read below)
        if marker == 0xD8 || marker == 0xD9 || marker == 0xDA || marker == 0xDB {
            offset += 2;
            continue;
        }

        if offset + 4 > data.len() {
            break;
        }

        let len = u16::from_be_bytes([data[offset + 2], data[offset + 3]]) as usize;
        if offset + 4 + len > data.len() {
            break;
        }

        // APP1 = EXIF
        if marker == 0xE1 && len > 6 {
            let app1_data = &data[offset + 4..offset + 4 + len];

            // Check for "Exif\0\0" header
            if app1_data.starts_with(b"Exif\0\0") {
                let tiff_data = &app1_data[6..];
                if let Some(jpeg_data) = find_exif_jpeg_thumbnail(tiff_data, data) {
                    if let Ok(img) = image::load_from_memory(&jpeg_data) {
                        let (w, h) = (img.width(), img.height());
                        // Skip if thumbnail is too large (not worth serving as preview)
                        if w as usize > max_size * 2 || h as usize > max_size * 2 {
                            return None;
                        }
                        let (tw, th) = calc_smart_dims(w, h, max_size);
                        let resized = if tw == w && th == h {
                            img.to_rgb8()
                        } else {
                            image::imageops::resize(
                                &img.to_rgb8(), tw, th,
                                image::imageops::FilterType::Lanczos3,
                            )
                        };
                        let mut buf = Vec::new();
                        if resized.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png).is_ok() {
                            return Some(ImageThumbResult {
                                png_data: buf,
                                width: w,
                                height: h,
                                method: "exif_thumb",
                            });
                        }
                    }
                }
            }
        }

        offset += 2 + len;
    }

    None
}

/// Parse EXIF IFD to find JPEGInterchangeFormat (offset to embedded JPEG thumbnail).
/// Returns the JPEG bytes from the original file at that offset.
fn find_exif_jpeg_thumbnail(tiff_data: &[u8], original_data: &[u8]) -> Option<Vec<u8>> {
    if tiff_data.len() < 8 {
        return None;
    }

    let (byte_order, _) = match &tiff_data[0..2] {
        b"II" => (ByteOrder::Little, false),
        b"MM" => (ByteOrder::Big, false),
        _ => return None,
    };

    if tiff_data[2] != 0x2A || tiff_data[3] != 0x00 {
        return None;
    }

    let read_u16 = |tiff: &[u8], offset: usize| -> Option<u16> {
        let bytes = tiff.get(offset..offset + 2)?;
        Some(match byte_order {
            ByteOrder::Little => u16::from_le_bytes([bytes[0], bytes[1]]),
            ByteOrder::Big => u16::from_be_bytes([bytes[0], bytes[1]]),
        })
    };

    let read_u32 = |tiff: &[u8], offset: usize| -> Option<u32> {
        let bytes = tiff.get(offset..offset + 4)?;
        Some(match byte_order {
            ByteOrder::Little => u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            ByteOrder::Big => u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        })
    };

    let ifd_offset = read_u32(tiff_data, 4)? as usize;
    let mut offset = ifd_offset;

    let mut thumb_offset: Option<u32> = None;
    let mut thumb_length: Option<u32> = None;
    let mut exif_ifd_offset: Option<u32> = None;

    // Parse IFD0 entries (each is 12 bytes)
    let entry_count = read_u16(tiff_data, offset)? as usize;
    offset += 2;

    for _ in 0..64.min(entry_count) {
        if offset + 12 > tiff_data.len() {
            break;
        }

        let tag = read_u16(tiff_data, offset)?;
        let dtype = read_u16(tiff_data, offset + 2)?;
        let count = read_u32(tiff_data, offset + 4)?;

        match tag {
            0x0201 => thumb_offset = Some(read_value_u32(tiff_data, offset + 8, dtype, count)), // JPEGInterchangeFormat
            0x0202 => thumb_length = Some(read_value_u32(tiff_data, offset + 8, dtype, count)), // JPEGInterchangeFormatLength
            0x8769 => exif_ifd_offset = Some(read_value_u32(tiff_data, offset + 8, dtype, count)), // ExifIFDPointer
            _ => {}
        }
        offset += 12;
    }

    // Read next IFD pointer
    if offset + 4 <= tiff_data.len() {
        let next = read_u32(tiff_data, offset)?;
        if next != 0 {
            // Parse IFD1 (thumbnail IFD) for JPEGInterchangeFormat
            let mut next_offset = next as usize;
            let next_count = read_u16(tiff_data, next_offset)?;
            next_offset += 2;
            for _ in 0..64.min(next_count as usize) {
                if next_offset + 12 > tiff_data.len() { break; }
                let tag = read_u16(tiff_data, next_offset)?;
                let dtype = read_u16(tiff_data, next_offset + 2)?;
                let count = read_u32(tiff_data, next_offset + 4)?;
                if tag == 0x0201 {
                    thumb_offset = Some(read_value_u32(tiff_data, next_offset + 8, dtype, count));
                }
                if tag == 0x0202 {
                    thumb_length = Some(read_value_u32(tiff_data, next_offset + 8, dtype, count));
                }
                next_offset += 12;
            }
        }
    }

    // Search EXIF IFD if not found in IFD0
    if thumb_offset.is_none() {
        if let Some(exif_off) = exif_ifd_offset {
            let mut exif_offset = exif_off as usize;
            let exif_entry_count = read_u16(tiff_data, exif_offset)?.min(128) as usize;
            exif_offset += 2;

            for _ in 0..exif_entry_count {
                if exif_offset + 12 > tiff_data.len() { break; }
                let tag = read_u16(tiff_data, exif_offset)?;
                let dtype = read_u16(tiff_data, exif_offset + 2)?;
                let count = read_u32(tiff_data, exif_offset + 4)?;

                if tag == 0x0201 {
                    thumb_offset = Some(read_value_u32(tiff_data, exif_offset + 8, dtype, count));
                }
                if tag == 0x0202 {
                    thumb_length = Some(read_value_u32(tiff_data, exif_offset + 8, dtype, count));
                }
                exif_offset += 12;
            }
        }
    }

    // Extract JPEG data from original file using the offset
    let off = thumb_offset? as usize;
    let len = thumb_length.unwrap_or(1024 * 1024) as usize;
    let end = (off + len).min(original_data.len());

    // Verify it's a valid JPEG
    if off < original_data.len()
        && original_data.get(off) == Some(&0xFF)
        && original_data.get(off + 1) == Some(&0xD8)
    {
        Some(original_data[off..end].to_vec())
    } else {
        None
    }
}

fn read_value_u32(tiff: &[u8], val_offset: usize, dtype: u16, count: u32) -> u32 {
    let type_size = match dtype {
        1 | 2 | 7 => 1, // BYTE, ASCII, UNDEFINED
        3 => 2,         // SHORT
        4 => 4,         // LONG
        9 => 4,         // SLONG
        _ => 1,
    };

    if count == 1 && type_size <= 4 {
        match type_size {
            2 => {
                let lo = u16::from_le_bytes([tiff[val_offset], tiff[val_offset + 1]]);
                u32::from(lo)
            }
            _ => {
                let bytes: [u8; 4] = [tiff[val_offset], tiff[val_offset + 1], tiff[val_offset + 2], tiff[val_offset + 3]];
                u32::from_le_bytes(bytes)
            }
        }
    } else {
        // Value is a pointer - read from the offset location
        let bytes: [u8; 4] = [tiff[val_offset], tiff[val_offset + 1], tiff[val_offset + 2], tiff[val_offset + 3]];
        let ptr = u32::from_le_bytes(bytes);
        if ptr as usize + 4 <= tiff.len() {
            let bytes: [u8; 4] = [tiff[ptr as usize], tiff[ptr as usize + 1], tiff[ptr as usize + 2], tiff[ptr as usize + 3]];
            u32::from_le_bytes(bytes)
        } else {
            0
        }
    }
}

#[derive(Clone, Copy)]
enum ByteOrder { Little, Big }

/// Image crate JPEG decode with smart sizing.
fn extract_jpeg_via_image_crate(
    _data: &[u8],
    path: &Path,
    max_size: usize,
) -> Option<ImageThumbResult> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let decoder = image::codecs::jpeg::JpegDecoder::new(reader).ok()?;

    let (w, h) = decoder.dimensions();

    // If image is small enough, serve at original size (no resize needed)
    if w as usize <= max_size && h as usize <= max_size {
        if let Ok(img) = image::DynamicImage::from_decoder(decoder) {
            let rgb = img.to_rgb8();
            let mut buf = Vec::new();
            if rgb.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png).is_ok() {
                return Some(ImageThumbResult {
                    png_data: buf,
                    width: w,
                    height: h,
                    method: "jpeg_original",
                });
            }
        }
    }

    // Re-open for full decode (decoder was consumed)
    let img = image::open(path).ok()?;
    let (tw, th) = calc_smart_dims(img.width(), img.height(), max_size);
    let resized = image::imageops::resize(
        &img.to_rgb8(), tw, th,
        image::imageops::FilterType::Lanczos3,
    );
    let mut buf = Vec::new();
    if resized.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png).is_ok() {
        Some(ImageThumbResult {
            png_data: buf,
            width: img.width(),
            height: img.height(),
            method: "jpeg_full",
        })
    } else {
        None
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PNG - Smart serve or resize
// ─────────────────────────────────────────────────────────────────────────────

fn extract_png_thumbnail(path: &Path, max_size: usize) -> Option<ImageThumbResult> {
    generic_image_thumbnail(path, max_size, "png")
}

// ─────────────────────────────────────────────────────────────────────────────
// WebP - via image crate (uses libwebp/rav1d under the hood)
// ─────────────────────────────────────────────────────────────────────────────

fn extract_webp_thumbnail(path: &Path, max_size: usize) -> Option<ImageThumbResult> {
    generic_image_thumbnail(path, max_size, "webp")
}

// ─────────────────────────────────────────────────────────────────────────────
// GIF - Take first frame, nearest neighbor for speed
// ─────────────────────────────────────────────────────────────────────────────

fn extract_gif_thumbnail(path: &Path, max_size: usize) -> Option<ImageThumbResult> {
    let img = image::open(path).ok()?;
    let (w, h) = (img.width(), img.height());
    let (tw, th) = calc_smart_dims(w, h, max_size);
    // GIF uses Nearest for speed (no anti-aliasing benefit on pixel art)
    let resized = image::imageops::resize(&img.to_rgb8(), tw, th, image::imageops::FilterType::Nearest);
    let mut buf = Vec::new();
    if resized.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png).is_ok() {
        Some(ImageThumbResult {
            png_data: buf,
            width: w,
            height: h,
            method: "gif",
        })
    } else {
        None
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BMP, TIFF, ICO, TGA - Generic via image crate
// ─────────────────────────────────────────────────────────────────────────────

fn extract_bmp_thumbnail(path: &Path, max_size: usize) -> Option<ImageThumbResult> {
    generic_image_thumbnail(path, max_size, "bmp")
}

fn extract_tiff_thumbnail(path: &Path, max_size: usize) -> Option<ImageThumbResult> {
    // Skip embedded JPEG preview extraction for TIF — these texture files often use
    // JPEG compression with non-standard color spaces (LAB, CMYK, 16-bit) that produce
    // dark/corrupt thumbnails. Always decode via image crate which handles color conversion.
    generic_image_thumbnail(path, max_size, "tiff")
}

fn extract_ico_thumbnail(path: &Path, max_size: usize) -> Option<ImageThumbResult> {
    generic_image_thumbnail(path, max_size, "ico")
}

fn extract_tga_thumbnail(path: &Path, max_size: usize) -> Option<ImageThumbResult> {
    generic_image_thumbnail(path, max_size, "tga")
}

fn extract_tiff_jpeg_preview(data: &[u8], max_size: usize) -> Option<ImageThumbResult> {
    // TIFF files can embed JPEG data for compression
    if let Some(pos) = memchr::memmem::find(data, b"\xFF\xD8\xFF") {
        let end_pos = memchr::memmem::rfind(data, b"\xFF\xD9")
            .map(|p| p + 2)
            .unwrap_or(data.len());
        let jpeg_data = &data[pos..end_pos.min(pos + 5 * 1024 * 1024)];
        if let Ok(img) = image::load_from_memory(jpeg_data) {
            let (w, h) = (img.width(), img.height());
            let (tw, th) = calc_smart_dims(w, h, max_size);
            let resized = image::imageops::resize(&img.to_rgb8(), tw, th, image::imageops::FilterType::Lanczos3);
            let mut buf = Vec::new();
            if resized.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png).is_ok() {
                return Some(ImageThumbResult {
                    png_data: buf,
                    width: w,
                    height: h,
                    method: "tiff_jpeg",
                });
            }
        }
    }
    None
}

fn generic_image_thumbnail(path: &Path, max_size: usize, method: &'static str) -> Option<ImageThumbResult> {
    let img = image::open(path).ok()?;
    let (w, h) = (img.width(), img.height());
    let (tw, th) = calc_smart_dims(w, h, max_size);
    let resized = image::imageops::resize(&img.to_rgb8(), tw, th, image::imageops::FilterType::Lanczos3);
    let mut buf = Vec::new();
    if resized.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png).is_ok() {
        Some(ImageThumbResult {
            png_data: buf,
            width: w,
            height: h,
            method,
        })
    } else {
        None
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXR / HDR - via image crate
// ─────────────────────────────────────────────────────────────────────────────

fn extract_exr_hdr_thumbnail(path: &Path, max_size: usize) -> Option<ImageThumbResult> {
    generic_image_thumbnail(path, max_size, "exr_hdr")
}

// ─────────────────────────────────────────────────────────────────────────────
// RAW formats - via image crate (CR2, NEF, ARW, DNG, RAF, etc.)
// ─────────────────────────────────────────────────────────────────────────────

fn extract_raw_thumbnail(path: &Path, max_size: usize) -> Option<ImageThumbResult> {
    // image crate has limited RAW support; try it first
    if let Some(result) = generic_image_thumbnail(path, max_size, "raw") {
        return Some(result);
    }
    // Try libraw-sys via image crate's TIFF decoder fallback
    generic_image_thumbnail(path, max_size, "raw_fallback")
}

// ─────────────────────────────────────────────────────────────────────────────
// HEIC / AVIF - via image crate
// ─────────────────────────────────────────────────────────────────────────────

fn extract_heic_thumbnail(path: &Path, max_size: usize) -> Option<ImageThumbResult> {
    generic_image_thumbnail(path, max_size, "heic")
}

fn extract_avif_thumbnail(path: &Path, max_size: usize) -> Option<ImageThumbResult> {
    generic_image_thumbnail(path, max_size, "avif")
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Smart thumbnail dimensions: keep original if smaller than max_size,
/// otherwise resize to max_size while preserving aspect ratio.
fn calc_smart_dims(width: u32, height: u32, max_size: usize) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (1, 1);
    }
    let larger = width.max(height);
    if larger as usize <= max_size {
        return (width, height); // Keep original size
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

/// Check if path has a supported image extension.
pub fn is_supported_image(path: &Path) -> bool {
    let ext = match path.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_lowercase(),
        None => return false,
    };

    matches!(
        ext.as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp"
        | "tiff" | "tif" | "ico" | "tga" | "exr" | "hdr"
        | "cr2" | "nef" | "arw" | "dng" | "raf" | "orf"
        | "rw2" | "pef" | "srw" | "cr3" | "heic" | "heif" | "avif"
    )
}
