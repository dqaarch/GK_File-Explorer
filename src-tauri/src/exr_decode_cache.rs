//! Phase 5B: Pre-decoded RGBA f32 disk cache for EXR sequence playback.
//!
//! ## Why this exists
//!
//! Multi-layer EXRs (e.g. 46-channel Sh02 sample, 81-channel Rnd_0015) waste
//! 89–95 % of their DWAB inflate time on channels the user does not need
//! when they select a single layer (e.g. "Beauty" → 4–5 channels kept).
//! Even after Phase 1–4 optimisations the per-frame decode for a 1920×1920
//! 8-chunk file is 450–550 ms because OpenEXRCore must inflate every channel
//! in every chunk before discarding the unwanted ones.
//!
//! For sequence playback the user scrubs the same files repeatedly, so we
//! cache the **final RGBA f32 buffer** (the output of `build_raw_rgba`) on
//! disk. Subsequent requests for the same (file, layer_filter) return the
//! cached buffer without ever opening the EXR. We observed 500 ms → ~10 ms
//! when the cache hits — a ~50× speed-up for repeated frames.
//!
//! ## Cache format
//!
//! Cache files live under `%LOCALAPPDATA%\GokuFileExplorer\exr_decode_cache\`
//! keyed by `SHA256(path | "\0" | layer_filter | "\0" | width×height | "\0" | file_size | "\0" | mtime_unix_nanos)`
//! (a 64-char hex prefix) → `<hash>.bin` and `<hash>.meta.json`.
//!
//! - `<hash>.bin` — raw little-endian `f32` RGBA buffer (width × height × 4 floats).
//! - `<hash>.meta.json` — width, height, channels, layers_count, source mtime, magic.
//!
//! The format is intentionally simple (one float32 blob + a JSON sidecar) so
//! that future schema changes only require bumping `CACHE_MAGIC` and ignoring
//! old entries (no decode-time ambiguity about which version wrote the file).
//!
//! ## When NOT to use the cache
//!
//! - File does not exist on disk (no mtime) → miss.
//! - Source EXR has been modified (mtime newer than cache) → miss.
//! - layer_filter is `None` (full RGBA fallback) — caching still works but
//!   gives less of a win because the user is loading everything anyway.
//! - The cache file is malformed (size mismatch with declared w×h×4×4) →
//!   miss + delete the bad cache entry.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

/// Bumped whenever the on-disk layout changes. Old cache files whose magic
/// does not match are ignored and quietly deleted.
///
/// 2026-07-05: bumped from `0x4558_5243_0001_0001` (1.1) to 1.2 after the
/// alpha-channel hotfix in `build_raw_rgba`. Old cache entries contain
/// u8 alpha=255 in slot 3 of every pixel; re-decoding is mandatory to
/// honour the EXR's true transparency. After the rebuild users may
/// delete `%LOCALAPPDATA%\GokuFileExplorer\exr_decode_cache\` manually
/// to reclaim the disk space the old entries consumed.
const CACHE_MAGIC: u64 = 0x4558_5243_0001_0002; // "EXRC" + version 1.2
const CACHE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GB hard cap for the cache dir

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExrCacheMeta {
    pub magic: u64,
    pub width: u32,
    pub height: u32,
    pub channels: Vec<String>,
    pub layers_count: usize,
    pub layer_names: Vec<String>,
    pub pass_type: String,
    /// Source EXR mtime in nanoseconds since the UNIX epoch. Used to
    /// invalidate the cache if the file is re-rendered.
    pub source_mtime_ns: u128,
    /// Source EXR file size in bytes — extra guard against mtime-preserving
    /// rewrites that we still want to invalidate.
    pub source_size: u64,
}

static CACHE_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

fn cache_dir() -> Option<&'static PathBuf> {
    CACHE_DIR
        .get_or_init(|| {
            std::env::var("LOCALAPPDATA").ok().map(|dir| {
                PathBuf::from(dir)
                    .join("GokuFileExplorer")
                    .join("exr_decode_cache")
            })
        })
        .as_ref()
}

/// SHA-256 cache key. We use the full SHA-256 (hex) so collision risk is
/// negligible — even DefaultHasher would be fine for non-adversarial input
/// but SHA-256 is robust against the birthday bound when many EXRs share
/// similar names.
fn cache_key(path: &Path, layer_filter: Option<&str>, width: u32, height: u32) -> Option<(String, u128, u64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let size = meta.len();

    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(b"\0");
    hasher.update(layer_filter.unwrap_or("").as_bytes());
    hasher.update(b"\0");
    hasher.update(&width.to_le_bytes());
    hasher.update(&height.to_le_bytes());
    hasher.update(b"\0");
    hasher.update(&size.to_le_bytes());
    hasher.update(b"\0");
    hasher.update(&mtime_ns.to_le_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{:02x}", b)).collect();
    Some((hex, mtime_ns, size))
}

/// Try to load a cached RGBA f32 buffer for the given (path, layer_filter,
/// width, height). Returns `(rgba_f32, channels, layers_count, layer_names,
/// pass_type)` on a hit.
pub fn try_load(
    path: &Path,
    layer_filter: Option<&str>,
    width: u32,
    height: u32,
) -> Option<(Vec<f32>, Vec<String>, usize, Vec<String>, String)> {
    let dir = cache_dir()?;
    let (key, mtime_ns, size) = cache_key(path, layer_filter, width, height)?;
    let bin_path = dir.join(format!("{}.bin", key));
    let meta_path = dir.join(format!("{}.meta.json", key));

    // Fast path: both files exist and the source file hasn't changed.
    let bin_meta = fs::metadata(&bin_path).ok()?;
    let meta_meta = fs::metadata(&meta_path).ok()?;
    let expected_size = (width as u64) * (height as u64) * 4 * std::mem::size_of::<f32>() as u64;

    if bin_meta.len() != expected_size {
        // Stale size — delete and bail.
        let _ = fs::remove_file(&bin_path);
        let _ = fs::remove_file(&meta_path);
        return None;
    }

    let meta_raw = fs::read_to_string(&meta_path).ok()?;
    let meta: ExrCacheMeta = match serde_json::from_str(&meta_raw) {
        Ok(m) => m,
        Err(_) => {
            let _ = fs::remove_file(&bin_path);
            let _ = fs::remove_file(&meta_path);
            return None;
        }
    };

    if meta.magic != CACHE_MAGIC
        || meta.width != width
        || meta.height != height
        || meta.source_mtime_ns != mtime_ns
        || meta.source_size != size
    {
        // Stale — delete and bail.
        let _ = fs::remove_file(&bin_path);
        let _ = fs::remove_file(&meta_path);
        return None;
    }

    let mut f = fs::File::open(&bin_path).ok()?;
    let mut buf = Vec::with_capacity(expected_size as usize);
    f.read_to_end(&mut buf).ok()?;
    if buf.len() != expected_size as usize {
        let _ = fs::remove_file(&bin_path);
        let _ = fs::remove_file(&meta_path);
        return None;
    }

    // SAFETY: f32 is Pod and we copy `expected_size` bytes that we just
    // verified match `(width*height*4)*sizeof(f32)`.
    let rgba_f32: Vec<f32> = unsafe {
        let mut out = Vec::with_capacity(buf.len() / 4);
        let ptr = buf.as_ptr() as *const f32;
        for i in 0..(buf.len() / 4) {
            out.push(ptr.add(i).read_unaligned());
        }
        out
    };

    Some((rgba_f32, meta.channels, meta.layers_count, meta.layer_names, meta.pass_type))
}

/// Persist the decoded RGBA f32 buffer to disk. Best-effort: any I/O failure
/// is logged but does not propagate to the caller (the decode itself already
/// succeeded).
pub fn try_save(
    path: &Path,
    layer_filter: Option<&str>,
    width: u32,
    height: u32,
    rgba_f32: &[f32],
    channels: &[String],
    layers_count: usize,
    layer_names: &[String],
    pass_type: &str,
) {
    let dir = match cache_dir() {
        Some(d) => d,
        None => return,
    };
    if let Err(e) = fs::create_dir_all(dir) {
        eprintln!("[EXR-CACHE] failed to create dir: {}", e);
        return;
    }

    let (key, mtime_ns, size) = match cache_key(path, layer_filter, width, height) {
        Some(v) => v,
        None => return,
    };

    let bin_path = dir.join(format!("{}.bin", key));
    let meta_path = dir.join(format!("{}.meta.json", key));
    let tmp_bin = dir.join(format!("{}.bin.tmp", key));
    let tmp_meta = dir.join(format!("{}.meta.json.tmp", key));

    let expected_bytes = rgba_f32.len() * std::mem::size_of::<f32>();
    let bin_bytes: &[u8] = unsafe {
        std::slice::from_raw_parts(rgba_f32.as_ptr() as *const u8, expected_bytes)
    };

    if let Err(e) = fs::File::create(&tmp_bin).and_then(|mut f| f.write_all(bin_bytes)) {
        eprintln!("[EXR-CACHE] failed to write {}: {}", tmp_bin.display(), e);
        let _ = fs::remove_file(&tmp_bin);
        return;
    }

    let meta = ExrCacheMeta {
        magic: CACHE_MAGIC,
        width,
        height,
        channels: channels.to_vec(),
        layers_count,
        layer_names: layer_names.to_vec(),
        pass_type: pass_type.to_string(),
        source_mtime_ns: mtime_ns,
        source_size: size,
    };
    let meta_json = match serde_json::to_string(&meta) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[EXR-CACHE] failed to serialise meta: {}", e);
            let _ = fs::remove_file(&tmp_bin);
            return;
        }
    };

    if let Err(e) = fs::File::create(&tmp_meta).and_then(|mut f| f.write_all(meta_json.as_bytes())) {
        eprintln!("[EXR-CACHE] failed to write {}: {}", tmp_meta.display(), e);
        let _ = fs::remove_file(&tmp_bin);
        let _ = fs::remove_file(&tmp_meta);
        return;
    }

    if let Err(e) = fs::rename(&tmp_bin, &bin_path) {
        eprintln!("[EXR-CACHE] failed to rename bin: {}", e);
        let _ = fs::remove_file(&tmp_bin);
        let _ = fs::remove_file(&tmp_meta);
        return;
    }
    if let Err(e) = fs::rename(&tmp_meta, &meta_path) {
        eprintln!("[EXR-CACHE] failed to rename meta: {}", e);
        let _ = fs::remove_file(&tmp_bin);
        let _ = fs::remove_file(&tmp_meta);
        return;
    }

    // Best-effort LRU eviction (only if cache exceeds cap).
    evict_if_needed();
}

fn evict_if_needed() {
    let dir = match cache_dir() {
        Some(d) => d,
        None => return,
    };
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };

    let mut total: u64 = 0;
    let mut entries: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    for e in read.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("bin") {
            continue;
        }
        if let Ok(md) = e.metadata() {
            let mtime = md.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            total += md.len();
            entries.push((p, md.len(), mtime));
        }
    }
    if total <= CACHE_MAX_BYTES {
        return;
    }

    // Evict oldest files until under cap.
    entries.sort_by_key(|(_, _, mtime)| *mtime);
    let target = (CACHE_MAX_BYTES * 8) / 10; // drop to 80% of cap
    let mut current = total;
    for (path, size, _) in entries {
        if current <= target {
            break;
        }
        if let Ok(()) = fs::remove_file(&path) {
            // remove sibling meta too
            let mut meta_path = path.clone();
            meta_path.set_extension("meta.json");
            let _ = fs::remove_file(&meta_path);
            current -= size;
        }
    }
}

/// Invalidate any cached entries for the given source path. Used when the
/// file is overwritten or the user requests a re-decode.
#[allow(dead_code)]
pub fn invalidate(path: &Path) {
    let dir = match cache_dir() {
        Some(d) => d,
        None => return,
    };
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for e in read.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) == Some("meta.json") {
            if let Ok(s) = fs::read_to_string(&p) {
                if let Ok(meta) = serde_json::from_str::<ExrCacheMeta>(&s) {
                    if let Some((key, _, _)) = cache_key(path, None, meta.width, meta.height) {
                        let bin = dir.join(format!("{}.bin", key));
                        if bin.exists() {
                            let _ = fs::remove_file(&bin);
                        }
                        let _ = fs::remove_file(&p);
                    }
                }
            }
        }
    }
}

// ── SHA-256 (tiny, std-only) ──────────────────────────────────────────────────
//
// We avoid pulling in `sha2` just for this — the implementation below is a
// direct port of the FIPS 180-4 reference algorithm.  It is ~80 lines and
// dependency-free, which keeps the FFI module lean.  Throughput is more
// than enough for a 1-shot cache key derivation per request.

struct Sha256 {
    state: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    bit_count: u128,
}

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

impl Sha256 {
    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
            ],
            buf: [0u8; 64],
            buf_len: 0,
            bit_count: 0,
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.bit_count = self.bit_count.wrapping_add((data.len() as u128) * 8);
        while !data.is_empty() {
            let take = (64 - self.buf_len).min(data.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            data = &data[take..];
            if self.buf_len == 64 {
                let block = self.buf;
                self.compress(&block);
                self.buf_len = 0;
            }
        }
    }

    fn finalize(mut self) -> [u8; 32] {
        let bit_count = self.bit_count;
        // Append 0x80, then zeros, then 128-bit big-endian length.
        self.buf[self.buf_len] = 0x80;
        self.buf_len += 1;
        if self.buf_len > 56 {
            for b in &mut self.buf[self.buf_len..] { *b = 0; }
            let block = self.buf;
            self.compress(&block);
            self.buf_len = 0;
        }
        for b in &mut self.buf[self.buf_len..56] { *b = 0; }
        self.buf[56..64].copy_from_slice(&bit_count.to_be_bytes()[..8]);
        let block = self.buf;
        self.compress(&block);

        let mut out = [0u8; 32];
        for (i, s) in self.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&s.to_be_bytes());
        }
        out
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4], block[i * 4 + 1], block[i * 4 + 2], block[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut a = self.state[0];
        let mut b = self.state[1];
        let mut c = self.state[2];
        let mut d = self.state[3];
        let mut e = self.state[4];
        let mut f = self.state[5];
        let mut g = self.state[6];
        let mut h = self.state[7];
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let mj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(mj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
        self.state[5] = self.state[5].wrapping_add(f);
        self.state[6] = self.state[6].wrapping_add(g);
        self.state[7] = self.state[7].wrapping_add(h);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_vector() {
        let mut h = Sha256::new();
        h.update(b"abc");
        let out = h.finalize();
        let hex: String = out.iter().map(|b| format!("{:02x}", b)).collect();
        assert_eq!(
            hex,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sha256_empty() {
        let h = Sha256::new();
        let out = h.finalize();
        let hex: String = out.iter().map(|b| format!("{:02x}", b)).collect();
        assert_eq!(
            hex,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}