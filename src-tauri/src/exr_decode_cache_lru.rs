//! Phase 5E: In-memory LRU cache of decoded RGBA f32 buffers.
//!
//! This is the *fast path* cache for the EXR sequence player. The disk
//! cache in `exr_decode_cache.rs` (Phase 5B) is still useful for
//! persisting across app restarts, but during a single playback
//! session the user mostly scrubs through frames and the file path
//! changes every frame — Phase 5B never hits. The in-memory LRU keys
//! by `(file path, layer)` so as long as the working set fits in
//! `MAX_ENTRIES` (16 frames ≈ 480 MB), every revisit is essentially
//! free (one Vec clone + zero DWAB inflate).
//!
//! ## Why in-memory only
//!
//! Phase 5A profiling showed DWAB inflate accounts for ~89% of the
//! per-frame cost on multi-layer EXRs. The natural cache unit is
//! therefore the post-inflate rgba_f32 buffer. A disk cache would
//! have to (re)read+parse+inflate the cache file every hit; an
//! in-memory cache just clones a `Vec<f32>`.
//!
//! 30 MB Vec clone on modern hardware is ~50 ms, vs ~500 ms to do a
//! fresh DWAB inflate of 5 channels through the generic-unpack path.
//!
//! ## Thread safety
//!
//! All operations are guarded by a single `std::sync::Mutex`. Hot path
//! is `O(1)` (HashMap lookup + Vec clone + LRU bump), so contention is
//! negligible.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

/// Phase 5B hit/miss counters. Atomic so we can read them from the
/// frontend-bound `get_stats_json()` IPC handler without grabbing the
/// cache mutex (which would contend with hot decode paths).
use std::sync::atomic::{AtomicU64, Ordering};
static HIT_COUNT: AtomicU64 = AtomicU64::new(0);
static MISS_COUNT: AtomicU64 = AtomicU64::new(0);
static PUT_COUNT: AtomicU64 = AtomicU64::new(0);

/// Maximum number of decoded frames to hold.
///
/// Phase 7: now a *soft* upper bound — eviction is driven primarily by the
/// `MAX_BYTES` budget below so that a 2000×4000 DWAB sequence (≈ 128 MB
/// per frame) cannot blow past 1.5 GB regardless of entry count. The count
/// cap is kept as a sanity ceiling so a single tiny frame doesn't pin all
/// memory, and to bound HashMap memory overhead.
const MAX_ENTRIES: usize = 64;

/// Phase 7: bytes-budgeted eviction. Each rgba_f32 frame is
/// `width * height * 4 * sizeof(f32) = width * height * 16` bytes. The
/// user's 32 MPixel DWAB test (2000×4000) is ≈ 128 MB per frame, so even
/// at 32 entries we hit ~4 GB which trashes the OS file cache and pushes
/// the OS into disk-backed paging. Capping at 1.5 GB keeps the working
/// set in physical RAM and prevents the LRU from churning through
/// 16-frame windows before the user can scrub back to them.
const MAX_BYTES: usize = 1_500 * 1024 * 1024;

/// One cached decoded frame. `rgba_f32` owns its data so eviction
/// just drops the entry — no buffer to free.
#[derive(Clone)]
struct CachedFrame {
    rgba_f32: Vec<f32>,
    width: u32,
    height: u32,
    channels: Vec<String>,
    layers_count: usize,
    layer_names: Vec<String>,
    pass_type: String,
    /// Monotonic counter used to break LRU ties.
    last_used_seq: u64,
}

struct Inner {
    entries: HashMap<String, CachedFrame>,
    seq: u64,
}

impl Inner {
    fn new() -> Self {
        Self {
            entries: HashMap::with_capacity(MAX_ENTRIES + 4),
            seq: 0,
        }
    }

    fn next_seq(&mut self) -> u64 {
        self.seq = self.seq.wrapping_add(1);
        self.seq
    }

    fn evict_lru_if_full(&mut self) {
        // Phase 7: two-stage eviction — first drop entries past the count
        // ceiling, then drop entries past the bytes budget. Both ordered
        // by `last_used_seq` (smallest = oldest = LRU victim).
        if self.entries.is_empty() {
            return;
        }

        // Stage 1: count ceiling (cheap O(N), bounded by MAX_ENTRIES).
        while self.entries.len() > MAX_ENTRIES {
            if let Some(key) = self
                .entries
                .iter()
                .min_by_key(|(_, v)| v.last_used_seq)
                .map(|(k, _)| k.clone())
            {
                self.entries.remove(&key);
            } else {
                break;
            }
        }

        // Stage 2: bytes budget. O(N log N) sort by recency, drop oldest
        // first until under budget. N ≤ MAX_ENTRIES = 64 so the sort
        // is sub-millisecond; the savings (avoiding the OS paging dance)
        // are well worth it.
        let total: usize = self
            .entries
            .values()
            .map(|e| e.rgba_f32.len() * 4)
            .sum();
        if total <= MAX_BYTES {
            return;
        }
        let mut keys: Vec<(String, u64)> = self
            .entries
            .iter()
            .map(|(k, v)| (k.clone(), v.last_used_seq))
            .collect();
        keys.sort_by_key(|(_, s)| *s);
        for (key, _) in keys {
            let entry_size = match self.entries.get(&key) {
                Some(e) => e.rgba_f32.len() * 4,
                None => continue,
            };
            self.entries.remove(&key);
            if total.saturating_sub(entry_size) <= MAX_BYTES {
                break;
            }
        }
    }
}

static CACHE: std::sync::OnceLock<Mutex<Inner>> = std::sync::OnceLock::new();

fn cache() -> &'static Mutex<Inner> {
    CACHE.get_or_init(|| {
        Mutex::new(Inner {
            entries: HashMap::with_capacity(MAX_ENTRIES + 4),
            seq: 0,
        })
    })
}

/// Build the cache key. The layer filter is part of the key so the
/// same file decoded for `Beauty` and `Emitters` lives as two
/// entries.
fn cache_key(source_path: &Path, layer_filter: Option<&str>) -> String {
    let path_str = source_path.to_string_lossy();
    match layer_filter {
        Some(layer) => format!("{}::{}", path_str, layer),
        None => format!("{}::__all__", path_str),
    }
}

/// Owned view of a cached frame. The float buffer is freshly cloned
/// so the caller can mutate it without disturbing the cache.
pub struct CachedFrameView {
    pub rgba_f32: Vec<f32>,
    pub width: u32,
    pub height: u32,
    pub channels: Vec<String>,
    pub layers_count: usize,
    pub layer_names: Vec<String>,
    pub pass_type: String,
}

/// Look up a cached frame. Returns `Some(view)` on hit (and bumps
/// the LRU recency) or `None` on miss. Never blocks for more than
/// the time to acquire the lock.
pub fn get(source_path: &Path, layer_filter: Option<&str>) -> Option<CachedFrameView> {
    let key = cache_key(source_path, layer_filter);
    let mut guard = cache().lock().ok()?;
    let seq = guard.next_seq();

    // Read len() before mutable borrow so we don't fight the borrow checker.
    let total_entries = guard.entries.len();

    let entry = guard.entries.get_mut(&key)?;
    let was_seq = entry.last_used_seq;
    entry.last_used_seq = seq;
    let bytes = entry.rgba_f32.len() * 4;
    let width = entry.width;
    let height = entry.height;
    let channels = entry.channels.clone();
    let layers_count = entry.layers_count;
    let layer_names = entry.layer_names.clone();
    let pass_type = entry.pass_type.clone();
    let rgba_f32 = entry.rgba_f32.clone();

    HIT_COUNT.fetch_add(1, Ordering::Relaxed);
    eprintln!(
        "[EXR-CACHE-LRU] HIT {} layer={} ({}x{}, {} bytes, age_seq={}->{}, total entries={})",
        source_path.display(),
        layer_filter.unwrap_or("*"),
        width,
        height,
        bytes,
        was_seq,
        seq,
        total_entries,
    );

    Some(CachedFrameView {
        rgba_f32,
        width,
        height,
        channels,
        layers_count,
        layer_names,
        pass_type,
    })
}

/// Insert a freshly decoded frame. Triggers LRU eviction if we are
/// over capacity. Failures are non-fatal.
#[allow(clippy::too_many_arguments)]
pub fn put(
    source_path: &Path,
    layer_filter: Option<&str>,
    width: u32,
    height: u32,
    rgba_f32: Vec<f32>,
    channels: Vec<String>,
    layers_count: usize,
    layer_names: Vec<String>,
    pass_type: String,
) {
    let key = cache_key(source_path, layer_filter);
    let Ok(mut guard) = cache().lock() else {
        eprintln!("[EXR-CACHE-LRU] PUT FAILED (lock poisoned) for {}", source_path.display());
        return;
    };
    let seq = guard.next_seq();

    let bytes = rgba_f32.len() * 4;
    guard.entries.insert(
        key,
        CachedFrame {
            rgba_f32,
            width,
            height,
            channels,
            layers_count,
            layer_names,
            pass_type,
            last_used_seq: seq,
        },
    );
    let count_after = guard.entries.len();
    guard.evict_lru_if_full();
    let count_final = guard.entries.len();
    PUT_COUNT.fetch_add(1, Ordering::Relaxed);
    eprintln!(
        "[EXR-CACHE-LRU] PUT {} layer={} ({}x{}, {} bytes, after_insert={}, after_evict={})",
        source_path.display(),
        layer_filter.unwrap_or("*"),
        width,
        height,
        bytes,
        count_after,
        count_final,
    );
}

/// Drop every cached frame. Called from `cleanup_all_caches()` on
/// app exit.
pub fn clear_all() {
    if let Ok(mut guard) = cache().lock() {
        guard.entries.clear();
    }
}

/// (count, bytes) for diagnostic logging.
pub fn stats() -> (usize, usize) {
    let Ok(guard) = cache().lock() else { return (0, 0) };
    let count = guard.entries.len();
    let bytes: usize = guard.entries.values().map(|e| e.rgba_f32.len() * 4).sum();
    (count, bytes)
}

/// One-line summary printed on every cache hit / miss so we can see
/// the cache working in the terminal log.
pub fn log_outcome(
    source_path: &Path,
    layer_filter: Option<&str>,
    was_hit: bool,
    width: u32,
    height: u32,
) {
    let label = if was_hit { "HIT " } else { "MISS" };
    let layer_str = layer_filter.unwrap_or("*");
    let (count, bytes) = stats();
    if !was_hit {
        MISS_COUNT.fetch_add(1, Ordering::Relaxed);
    }
    eprintln!(
        "[EXR-CACHE-LRU] {} {} layer={} ({}x{}, entries={}, {:.1} MB held)",
        label,
        source_path.display(),
        layer_str,
        width,
        height,
        count,
        bytes as f64 / (1024.0 * 1024.0),
    );
}

/// Phase 5B diagnostics — exposed to the frontend through the
/// `get_exr_cache_stats` Tauri command so the EXR player UI can show
/// hit rate, miss rate, and current entry count without needing
/// filesystem access.
#[derive(serde::Serialize, Clone, Debug)]
pub struct CacheStats {
    pub entries: usize,
    pub bytes: usize,
    pub mb: f64,
    pub max_entries: usize,
    pub hits: u64,
    pub misses: u64,
    pub puts: u64,
    /// 0.0 - 1.0, or 0 if no requests yet.
    pub hit_rate: f64,
}

pub fn get_stats() -> CacheStats {
    let (entries, bytes) = stats();
    let hits = HIT_COUNT.load(Ordering::Relaxed);
    let misses = MISS_COUNT.load(Ordering::Relaxed);
    let puts = PUT_COUNT.load(Ordering::Relaxed);
    let total = hits + misses;
    let hit_rate = if total > 0 {
        hits as f64 / total as f64
    } else {
        0.0
    };
    CacheStats {
        entries,
        bytes,
        mb: bytes as f64 / (1024.0 * 1024.0),
        max_entries: MAX_ENTRIES,
        hits,
        misses,
        puts,
        hit_rate,
    }
}

/// Reset counters (e.g. on layer change so each session's hit rate
/// reflects the current workload).
pub fn reset_counters() {
    HIT_COUNT.store(0, Ordering::Relaxed);
    MISS_COUNT.store(0, Ordering::Relaxed);
    PUT_COUNT.store(0, Ordering::Relaxed);
}