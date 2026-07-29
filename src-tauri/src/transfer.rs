// Transfer engine for the File Explorer.
//
// Provides a background job runner that copies/moves files between paths
// with progress reporting, pause/resume, cancellation, and per-file
// conflict resolution. State is shared across Tauri commands via
// `tauri::State<TransferState>`.
//
// Phase 0 (foundation): types + state + a single command that enqueues
// a job and runs the copy on a background thread. Progress is emitted
// via the Tauri event bus under the `transfer://...` prefix.
//
// Concurrency note: the worker runs on a plain `std::thread` (no tokio
// runtime inside the worker). Pause uses a `std::sync::Condvar` so the
// worker can block cleanly without polling. Cancellation is checked at
// every I/O boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{command, AppHandle, Emitter, Manager};
use walkdir::WalkDir;

const PROGRESS_THROTTLE_MS: u64 = 150;

// ── Public event payload types ──────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferMode {
    Copy,
    Move,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferStatus {
    Queued,
    Running,
    Paused,
    Completed,
    Cancelled,
    Failed,
    PartialSuccess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictAction {
    Replace,
    Skip,
    KeepBoth,
    ReplaceAll,
    SkipAll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize)]
pub struct TransferJobView {
    pub id: String,
    pub mode: TransferMode,
    pub source_paths: Vec<String>,
    pub target_dir: String,
    pub status: TransferStatus,
    pub bytes_total: u64,
    pub bytes_done: u64,
    pub files_total: u64,
    pub files_done: u64,
    pub current_file: Option<String>,
    pub elapsed_ms: u64,
    pub throughput_bps: u64,
    pub eta_seconds: Option<u64>,
    pub failed_items: Vec<FailedItem>,
    pub resolved_conflicts: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct FailedItem {
    pub source: String,
    pub destination: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub job: TransferJobView,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusEvent {
    pub job_id: String,
    pub status: TransferStatus,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConflictEvent {
    pub job_id: String,
    pub source: String,
    pub destination: String,
    pub kind: ConflictKind,
    pub timestamp_ms: u64,
}

// Emitted after a Replace conflict decision successfully copies a file over
// an existing destination. The frontend (via main.rs) uses this to clear
// stale thumbnail/preview cache entries.
#[derive(Debug, Clone, Serialize)]
pub struct FileReplacedEvent {
    pub path: String,
    pub timestamp_ms: u64,
}

// ── Internal job representation ────────────────────────────────────────────

struct PauseSignal {
    paused: AtomicBool,
    pair: Mutex<bool>,
    cvar: Condvar,
}

impl PauseSignal {
    fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            pair: Mutex::new(false),
            cvar: Condvar::new(),
        }
    }

    fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }

    fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
        // Wake any waiters.
        let _ = self.pair.lock().map(|mut g| {
            *g = true;
            self.cvar.notify_all();
        });
    }

    // Blocks while `paused` is true. Returns true if cancellation was
    // observed while waiting (so the caller can abort early).
    fn wait_if_paused(&self, cancel_flag: &AtomicBool) -> bool {
        if !self.paused.load(Ordering::SeqCst) {
            return false;
        }
        let mut g = match self.pair.lock() {
            Ok(g) => g,
            Err(_) => return true,
        };
        // Loop: wait while paused AND not cancelled.
        while self.paused.load(Ordering::SeqCst) && !cancel_flag.load(Ordering::SeqCst) {
            let (new_g, _) = match self.cvar.wait_timeout(g, Duration::from_millis(200)) {
                Ok(pair) => pair,
                Err(poisoned) => poisoned.into_inner(),
            };
            g = new_g;
        }
        cancel_flag.load(Ordering::SeqCst)
    }
}

// Separate signal used to gate the worker while a conflict decision is
// pending. It is independent from the user-facing pause/resume so that
// the existing semantics of `pause_transfer` are preserved.
#[derive(Clone)]
struct ConflictGate {
    waiting: Arc<AtomicBool>,
    pair: Arc<Mutex<bool>>,
    cvar: Arc<Condvar>,
}

impl ConflictGate {
    fn new() -> Self {
        Self {
            waiting: Arc::new(AtomicBool::new(false)),
            pair: Arc::new(Mutex::new(false)),
            cvar: Arc::new(Condvar::new()),
        }
    }

    fn arm(&self) {
        self.waiting.store(true, Ordering::SeqCst);
    }

    fn disarm(&self) {
        self.waiting.store(false, Ordering::SeqCst);
        let _ = self.pair.lock().map(|mut g| {
            *g = true;
            self.cvar.notify_all();
        });
    }

    // Blocks while the gate is armed. Returns true if cancellation was
    // observed while waiting.
    fn wait(&self, cancel_flag: &AtomicBool) -> bool {
        if !self.waiting.load(Ordering::SeqCst) {
            return false;
        }
        let mut g = match self.pair.lock() {
            Ok(g) => g,
            Err(_) => return true,
        };
        while self.waiting.load(Ordering::SeqCst) && !cancel_flag.load(Ordering::SeqCst) {
            let (new_g, _) = match self.cvar.wait_timeout(g, Duration::from_millis(200)) {
                Ok(pair) => pair,
                Err(poisoned) => poisoned.into_inner(),
            };
            g = new_g;
        }
        cancel_flag.load(Ordering::SeqCst)
    }
}

struct Job {
    id: String,
    mode: TransferMode,
    source_paths: Vec<String>,
    target_dir: String,
    status: Mutex<TransferStatus>,
    bytes_total: AtomicU64,
    bytes_done: AtomicU64,
    files_total: AtomicU64,
    files_done: AtomicU64,
    current_file: Mutex<Option<String>>,
    started_at: Instant,
    throughput_ema_bps: Mutex<f64>,
    failed_items: Mutex<Vec<FailedItem>>,
    resolved_conflicts: AtomicU64,
    cancelled: Arc<AtomicBool>,
    pause: Arc<PauseSignal>,
    // "Apply to all" decisions: when user picks ReplaceAll/SkipAll, store the
    // normalized form (Replace or Skip) so subsequent conflicts inherit it.
    // KeepBoth does NOT support "apply to all" in the same way — every file
    // produces a unique name, so we just remember the user wants "keep both"
    // for the rest of the job and re-derive the unique path per item.
    global_conflict: Mutex<Option<ConflictAction>>,
    // Per-destination explicit decisions the user has already made.
    // Keyed by the (item_index, destination) tuple represented as a
    // string `"<item_index>:<dest>"`. Used to map a "Keep Both" click
    // back to a concrete destination path.
    per_item_decisions: Mutex<HashMap<String, ConflictAction>>,
    // Gate the worker uses to wait for the user to choose a conflict
    // resolution. Set when we emit a conflict; cleared by the
    // `resolve_conflict` command.
    conflict_gate: ConflictGate,
    // The destination path the worker is currently blocked on. Lets the
    // `resolve_conflict` command know which item the decision applies to
    // when the user didn't include an explicit item_index.
    pending_conflict_dest: Mutex<Option<String>>,
}

impl Job {
    fn view(&self) -> TransferJobView {
        let bytes_done = self.bytes_done.load(Ordering::Relaxed);
        let files_done = self.files_done.load(Ordering::Relaxed);
        let current_file = self
            .current_file
            .lock()
            .ok()
            .and_then(|g| g.clone());
        let failed_items = self
            .failed_items
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        let status = self
            .status
            .lock()
            .map(|g| *g)
            .unwrap_or(TransferStatus::Failed);
        let throughput = self
            .throughput_ema_bps
            .lock()
            .map(|g| *g as u64)
            .unwrap_or(0);
        let elapsed = self.started_at.elapsed();
        let bytes_total_value = self.bytes_total.load(Ordering::Relaxed);
        let eta_seconds = if throughput > 0 && bytes_done < bytes_total_value {
            let remaining = bytes_total_value - bytes_done;
            Some(remaining / throughput.max(1))
        } else {
            None
        };
        TransferJobView {
            id: self.id.clone(),
            mode: self.mode,
            source_paths: self.source_paths.clone(),
            target_dir: self.target_dir.clone(),
            status,
            bytes_total: self.bytes_total.load(Ordering::Relaxed),
            bytes_done,
            files_total: self.files_total.load(Ordering::Relaxed),
            files_done,
            current_file,
            elapsed_ms: elapsed.as_millis() as u64,
            throughput_bps: throughput,
            eta_seconds,
            failed_items,
            resolved_conflicts: self.resolved_conflicts.load(Ordering::Relaxed),
        }
    }
}

// ── Shared state ───────────────────────────────────────────────────────────

pub struct TransferState {
    next_id: AtomicU64,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    app: Option<AppHandle>,
}

impl TransferState {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            jobs: Mutex::new(HashMap::new()),
            app: None,
        }
    }

    pub fn attach(&mut self, app: AppHandle) {
        self.app = Some(app);
    }

    fn app_handle(&self) -> Option<AppHandle> {
        self.app.clone()
    }

    fn alloc_id(&self) -> String {
        let n = self.next_id.fetch_add(1, Ordering::SeqCst);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("job-{}-{}", now, n)
    }

    fn insert_job(&self, job: Arc<Job>) {
        if let Ok(mut map) = self.jobs.lock() {
            map.insert(job.id.clone(), job);
        }
    }

    pub fn get_job(&self, id: &str) -> Option<Arc<Job>> {
        self.jobs.lock().ok().and_then(|m| m.get(id).cloned())
    }

    pub fn snapshot(&self) -> Vec<TransferJobView> {
        self.jobs
            .lock()
            .ok()
            .map(|m| m.values().map(|j| j.view()).collect())
            .unwrap_or_default()
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn emit_status(app: &AppHandle, job_id: &str, status: TransferStatus) {
    let payload = StatusEvent {
        job_id: job_id.to_string(),
        status,
        timestamp_ms: now_ms(),
    };
    let _ = app.emit("transfer://job-status", payload);
}

fn emit_progress(app: &AppHandle, job: &Job) {
    let view = job.view();
    let payload = ProgressEvent {
        job: view,
        timestamp_ms: now_ms(),
    };
    let _ = app.emit("transfer://job-progress", payload);
}

fn emit_conflict(
    app: &AppHandle,
    job_id: &str,
    source: &Path,
    destination: &Path,
    kind: ConflictKind,
) {
    let payload = ConflictEvent {
        job_id: job_id.to_string(),
        source: source.to_string_lossy().to_string(),
        destination: destination.to_string_lossy().to_string(),
        kind,
        timestamp_ms: now_ms(),
    };
    let _ = app.emit("transfer://job-conflict", payload);
}

fn emit_file_replaced(app: &AppHandle, path: &Path) {
    let payload = FileReplacedEvent {
        path: path.to_string_lossy().to_string(),
        timestamp_ms: now_ms(),
    };
    let _ = app.emit("transfer://file-replaced", payload);
}

// Enumerate all files under `root` and total size.
fn enumerate(root: &Path) -> (u64, u64) {
    let mut files: u64 = 0;
    let mut bytes: u64 = 0;
    if !root.exists() {
        return (0, 0);
    }
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            files += 1;
            if let Ok(meta) = entry.metadata() {
                bytes = bytes.saturating_add(meta.len());
            }
        }
    }
    (files, bytes)
}

// Decide destination path with "Keep Both" semantics.
fn unique_destination(target_dir: &Path, source: &Path) -> PathBuf {
    let file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let (base, ext) = match file_name.rfind('.') {
        Some(idx) if idx > 0 => (&file_name[..idx], Some(&file_name[idx..])),
        _ => (file_name, None),
    };
    let mut counter = 1u32;
    loop {
        let candidate_name = match ext {
            Some(e) if counter == 1 => format!("{} - Copy{}", base, e),
            Some(e) => format!("{} - Copy ({}){}", base, counter, e),
            None if counter == 1 => format!("{} - Copy", base),
            None => format!("{} - Copy ({})", base, counter),
        };
        let candidate = target_dir.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
        counter += 1;
        if counter > 9999 {
            let stamp = now_ms();
            let n = match ext {
                Some(e) => format!("{} - {}{}", base, stamp, e),
                None => format!("{} - {}", base, stamp),
            };
            return target_dir.join(n);
        }
    }
}

// Copy a single file from `src` to `dst`, emitting progress. Returns true
// if completed, false if cancelled. Caller checks `cancelled` between
// chunks.
fn copy_file_with_progress(
    src: &Path,
    dst: &Path,
    job: &Job,
    app: &AppHandle,
) -> Result<bool, String> {
    use std::io::{Read, Write};

    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all({}): {}", parent.display(), e))?;
    }

    let mut reader = std::fs::File::open(src)
        .map_err(|e| format!("open({}): {}", src.display(), e))?;
    let mut writer = std::fs::File::create(dst)
        .map_err(|e| format!("create({}): {}", dst.display(), e))?;

    let mut buf = vec![0u8; 1024 * 1024]; // 1 MiB
    let mut last_tick = Instant::now();
    let mut last_tick_bytes = job.bytes_done.load(Ordering::Relaxed);
    let throttle = Duration::from_millis(PROGRESS_THROTTLE_MS);

    {
        if let Ok(mut g) = job.current_file.lock() {
            *g = src.file_name().and_then(|n| n.to_str()).map(String::from);
        }
    }

    loop {
        // Cancellation check
        if job.cancelled.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(dst);
            return Ok(false);
        }
        // Pause check (blocks while paused, returns true if cancelled)
        if job.pause.wait_if_paused(&job.cancelled) {
            let _ = std::fs::remove_file(dst);
            return Ok(false);
        }

        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("read({}): {}", src.display(), e))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .map_err(|e| format!("write({}): {}", dst.display(), e))?;
        job.bytes_done.fetch_add(n as u64, Ordering::Relaxed);

        if last_tick.elapsed() >= throttle {
            let elapsed = last_tick.elapsed().as_secs_f64();
            let bytes_delta = job.bytes_done.load(Ordering::Relaxed) - last_tick_bytes;
            if elapsed > 0.0 {
                let instant_bps = bytes_delta as f64 / elapsed;
                if let Ok(mut g) = job.throughput_ema_bps.lock() {
                    *g = *g * 0.6 + instant_bps * 0.4;
                }
            }
            last_tick = Instant::now();
            last_tick_bytes = job.bytes_done.load(Ordering::Relaxed);
            emit_progress(app, job);
        }
    }

    writer
        .flush()
        .map_err(|e| format!("flush({}): {}", dst.display(), e))?;
    Ok(true)
}

// Move a file or directory. Uses fs::rename for same-volume, falls back
// to copy + delete for cross-volume. (We don't need progress reporting
// for the rename-fast path; for cross-volume copy we use the progress
// variant.)
fn move_item(
    src: &Path,
    dst: &Path,
    job: &Job,
    app: &AppHandle,
) -> Result<bool, String> {
    match std::fs::rename(src, dst) {
        Ok(()) => {
            let (_, bytes) = enumerate(src);
            job.bytes_done.fetch_add(bytes, Ordering::Relaxed);
            Ok(true)
        }
        Err(_) => {
            // Cross-volume or other error: fall back to recursive copy + remove.
            let ok = copy_item_recursive(src, dst, Some((job, app)))?;
            if ok {
                if src.is_dir() {
                    std::fs::remove_dir_all(src).map_err(|e| {
                        format!("remove_dir_all({}): {}", src.display(), e)
                    })?;
                } else {
                    std::fs::remove_file(src).map_err(|e| {
                        format!("remove_file({}): {}", src.display(), e)
                    })?;
                }
            }
            Ok(ok)
        }
    }
}

// Recursive copy of a file or directory. Returns true if completed
// (not cancelled). `progress` is Some for the active transfer worker.
fn copy_item_recursive(
    src: &Path,
    dst: &Path,
    progress: Option<(&Job, &AppHandle)>,
) -> Result<bool, String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)
            .map_err(|e| format!("create_dir_all({}): {}", dst.display(), e))?;
        for entry in std::fs::read_dir(src)
            .map_err(|e| format!("read_dir({}): {}", src.display(), e))?
        {
            let entry = entry.map_err(|e| format!("dir entry: {}", e))?;
            let entry_path = entry.path();
            let dest_child = dst.join(entry.file_name());
            copy_item_recursive(&entry_path, &dest_child, progress)?;
        }
        Ok(true)
    } else {
        match progress {
            Some((job, app)) => copy_file_with_progress(src, dst, job, app),
            None => {
                if let Some(parent) = dst.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| {
                        format!("create_dir_all({}): {}", parent.display(), e)
                    })?;
                }
                std::fs::copy(src, dst)
                    .map(|_| true)
                    .map_err(|e| format!("copy({}->{}): {}", src.display(), dst.display(), e))
            }
        }
    }
}

// Pre-scan all sources to compute total bytes/files and to build the
// per-source destination list. Destinations are kept as the user-typed
// name (no auto-rename to "Copy (1)"). The worker checks for existing
// destinations and surfaces a conflict for each one, blocking on the
// `ConflictGate` until the user picks Replace / Skip / Keep Both.
struct PlannedItem {
    source: PathBuf,
    destination: PathBuf,
    is_dir: bool,
}

fn plan_transfer(sources: &[String], target_dir: &Path) -> (Vec<PlannedItem>, u64, u64) {
    let mut items: Vec<PlannedItem> = Vec::new();
    let mut total_files: u64 = 0;
    let mut total_bytes: u64 = 0;
    for s in sources {
        let src = PathBuf::from(s);
        if !src.exists() {
            continue;
        }
        let is_dir = src.is_dir();
        let dst = target_dir.join(
            src.file_name().unwrap_or_else(|| std::ffi::OsStr::new("file")),
        );
        let (files, bytes) = enumerate(&src);
        total_files = total_files.saturating_add(files);
        total_bytes = total_bytes.saturating_add(bytes);
        items.push(PlannedItem {
            source: src,
            destination: dst,
            is_dir,
        });
    }
    (items, total_files, total_bytes)
}

// Resolve the actual destination path for an item, honouring the user's
// conflict decision stored in `per_item_decisions` or `global_conflict`.
// Returns `Ok(None)` when the user picked "Skip", `Ok(Some(path))` when
// the item should be copied to `path`, or `Err(())` when no decision has
// been made yet (the caller should surface a conflict and wait).
fn resolve_item_destination(
    job: &Job,
    item_index: usize,
    src: &Path,
    original_dst: &Path,
) -> Result<Option<PathBuf>, ()> {
    // Per-item decision (set by an explicit per-item click in the
    // dialog, or a "Keep Both" pick for this specific item).
    let key = format!("{}:{}", item_index, original_dst.to_string_lossy());
    let decision = job
        .per_item_decisions
        .lock()
        .ok()
        .and_then(|m| m.get(&key).copied());

    let action = match decision {
        Some(a) => Some(a),
        None => job
            .global_conflict
            .lock()
            .ok()
            .and_then(|g| g.clone()),
    };

    let action = match action {
        Some(a) => a,
        None => return Err(()),
    };

    Ok(match action {
        ConflictAction::Skip | ConflictAction::SkipAll => None,
        ConflictAction::Replace | ConflictAction::ReplaceAll => {
            // Overwrite the existing destination: remove it first so the
            // copy always succeeds even on read-only handles. For
            // directories, remove_dir_all; for files, remove_file.
            if original_dst.exists() {
                if original_dst.is_dir() {
                    let _ = std::fs::remove_dir_all(original_dst);
                } else {
                    let _ = std::fs::remove_file(original_dst);
                }
            }
            Some(original_dst.to_path_buf())
        }
        ConflictAction::KeepBoth => {
            // Every "Keep Both" call produces a fresh unique name.
            Some(unique_destination(original_dst.parent().unwrap_or(src), src))
        }
    })
}

// Run the actual transfer for a job on a background thread.
fn run_job(app: AppHandle, job: Arc<Job>) {
    let target_dir = PathBuf::from(&job.target_dir);
    let (plan, _files_total, bytes_total) = plan_transfer(&job.source_paths, &target_dir);
    job.files_total.store(plan.len() as u64, Ordering::Relaxed);
    job.bytes_total.store(bytes_total, Ordering::Relaxed);

    {
        let _ = job.status.lock().map(|mut s| *s = TransferStatus::Running);
    }
    emit_status(&app, &job.id, TransferStatus::Running);

    let mut all_ok = true;
    let mut cancelled = false;

    for (item_index, item) in plan.into_iter().enumerate() {
        if job.cancelled.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }

        // Honour user-paused state between items so the global Pause
        // button still works while a conflict dialog is open.
        if job.pause.wait_if_paused(&job.cancelled) {
            cancelled = true;
            break;
        }

        // ── Conflict resolution gate ─────────────────────────────────
        // The destination is "the name the user typed" (no auto-rename
        // in `plan_transfer`). If it already exists, decide what to do
        // based on stored decisions, otherwise emit a conflict event
        // and block until the user replies.
        let destination = if item.destination.exists() {
            match resolve_item_destination(&job, item_index, &item.source, &item.destination) {
                Ok(Some(d)) => d,
                Ok(None) => {
                    // User picked Skip — count it as done and move on.
                    job.resolved_conflicts.fetch_add(1, Ordering::Relaxed);
                    job.files_done.fetch_add(1, Ordering::Relaxed);
                    emit_progress(&app, &job);
                    continue;
                }
                Err(()) => {
                    // No decision yet: surface the conflict and wait.
                    let kind = if item.destination.is_dir() {
                        ConflictKind::Directory
                    } else {
                        ConflictKind::File
                    };
                    job.conflict_gate.arm();
                    if let Ok(mut g) = job.pending_conflict_dest.lock() {
                        *g = Some(item.destination.to_string_lossy().to_string());
                    }
                    {
                        let _ = job.status.lock().map(|mut s| *s = TransferStatus::Paused);
                    }
                    emit_status(&app, &job.id, TransferStatus::Paused);
                    emit_conflict(
                        &app,
                        &job.id,
                        &item.source,
                        &item.destination,
                        kind,
                    );
                    emit_progress(&app, &job);

                    if job.conflict_gate.wait(&job.cancelled) {
                        cancelled = true;
                        job.conflict_gate.disarm();
                        break;
                    }

                    // Re-read the decision after the wake-up.
                    match resolve_item_destination(&job, item_index, &item.source, &item.destination) {
                        Ok(Some(d)) => d,
                        Ok(None) => {
                            // User picked Skip.
                            job.resolved_conflicts.fetch_add(1, Ordering::Relaxed);
                            job.files_done.fetch_add(1, Ordering::Relaxed);
                            {
                                let _ = job.status.lock().map(|mut s| *s = TransferStatus::Running);
                            }
                            emit_status(&app, &job.id, TransferStatus::Running);
                            emit_progress(&app, &job);
                            continue;
                        }
                        Err(()) => {
                            // The gate was disarmed but no decision
                            // recorded — most likely a race with a
                            // cancel. Bail out safely.
                            cancelled = true;
                            job.conflict_gate.disarm();
                            break;
                        }
                    }
                }
            }
        } else {
            // No conflict: copy straight to the user-typed destination.
            item.destination.clone()
        };

        // Re-check: the resolved destination should not exist anymore
        // (Replace removed it, Keep Both produced a unique name, Skip
        // returned). If it still does, the file was added back in
        // parallel — treat it as a transient failure and continue.
        if destination.exists() {
            all_ok = false;
            if let Ok(mut failed) = job.failed_items.lock() {
                failed.push(FailedItem {
                    source: item.source.to_string_lossy().to_string(),
                    destination: destination.to_string_lossy().to_string(),
                    error: "Destination reappeared after conflict resolution".to_string(),
                });
            }
            job.files_done.fetch_add(1, Ordering::Relaxed);
            emit_progress(&app, &job);
            continue;
        }

        perform_item_copy(&app, &job, item_index, &item.source, &destination, &mut all_ok, &mut cancelled);

        if cancelled {
            break;
        }
    }

    let final_status = if cancelled {
        TransferStatus::Cancelled
    } else if !all_ok {
        if job.files_done.load(Ordering::Relaxed) > 0 {
            TransferStatus::PartialSuccess
        } else {
            TransferStatus::Failed
        }
    } else {
        TransferStatus::Completed
    };

    {
        let _ = job.status.lock().map(|mut s| *s = final_status);
    }
    emit_status(&app, &job.id, final_status);
    emit_progress(&app, &job);
}

// Helper: actually copy a single planned item, surfacing progress and
// failed_items. Lives in its own function so the conflict-handling loop
// in `run_job` stays readable.
fn perform_item_copy(
    app: &AppHandle,
    job: &Arc<Job>,
    _item_index: usize,
    source: &Path,
    destination: &Path,
    all_ok: &mut bool,
    cancelled: &mut bool,
) {
    {
        if let Ok(mut g) = job.current_file.lock() {
            *g = source.file_name().and_then(|n| n.to_str()).map(String::from);
        }
    }
    emit_progress(app, job);

    let result = match job.mode {
        TransferMode::Copy => {
            copy_item_recursive(source, destination, Some((job.as_ref(), app)))
        }
        TransferMode::Move => {
            // Safety check: if source is inside Recycle Bin, the move must go
            // through the Shell API (IFileOperation / Shell.Application) so
            // Windows renames the file back to its ORIGINAL name and updates
            // the $I metadata. Doing a plain `fs::rename` or copy+delete on
            // a Recycle Bin path leaks the encrypted $Rxxx filename and an
            // empty payload into the destination (that's the bug the user
            // hit before this guard was added).
            let src_str = source.to_string_lossy().to_string();
            if crate::recycle_bin::is_recycle_bin_path(&src_str) {
                match crate::recycle_bin::restore_from_recycle_bin(
                    &[src_str],
                    &destination.to_string_lossy(),
                ) {
                    Ok(r) if r.success && r.failed_count == 0 => Ok(true),
                    Ok(r) => Err(r.errors.join("; ")),
                    Err(e) => Err(e),
                }
            } else {
                move_item(source, destination, job, app)
            }
        }
    };

    match result {
        Ok(true) => {
            job.files_done.fetch_add(1, Ordering::Relaxed);
            // Emit so the frontend can invalidate any cached thumbnail/preview
            // for the destination path. Safe to emit for all copies (new files
            // simply won't have a stale cache entry).
            emit_file_replaced(app, destination);
        }
        Ok(false) => {
            *cancelled = true;
            *all_ok = false;
        }
        Err(e) => {
            *all_ok = false;
            if let Ok(mut failed) = job.failed_items.lock() {
                failed.push(FailedItem {
                    source: source.to_string_lossy().to_string(),
                    destination: destination.to_string_lossy().to_string(),
                    error: e,
                });
            }
            job.files_done.fetch_add(1, Ordering::Relaxed);
        }
    }

    emit_progress(app, job);
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct StartTransferArgs {
    pub source_paths: Vec<String>,
    pub target_dir: String,
    pub mode: TransferMode,
}

#[derive(Debug, Serialize)]
pub struct StartTransferResult {
    pub job_id: String,
}

#[command]
pub async fn start_transfer(
    app: AppHandle,
    state: tauri::State<'_, TransferState>,
    args: StartTransferArgs,
) -> Result<StartTransferResult, String> {
    if args.source_paths.is_empty() {
        return Err("No source paths provided".to_string());
    }
    let target = PathBuf::from(&args.target_dir);
    if !target.is_dir() {
        return Err(format!(
            "Target directory does not exist: {}",
            args.target_dir
        ));
    }

    let id = state.alloc_id();
    let (_plan, files_total, bytes_total) = plan_transfer(&args.source_paths, &target);

    let job = Arc::new(Job {
        id: id.clone(),
        mode: args.mode,
        source_paths: args.source_paths.clone(),
        target_dir: args.target_dir.clone(),
        status: Mutex::new(TransferStatus::Queued),
        bytes_total: AtomicU64::new(bytes_total),
        bytes_done: AtomicU64::new(0),
        files_total: AtomicU64::new(files_total),
        files_done: AtomicU64::new(0),
        current_file: Mutex::new(None),
        started_at: Instant::now(),
        throughput_ema_bps: Mutex::new(0.0),
        failed_items: Mutex::new(Vec::new()),
        resolved_conflicts: AtomicU64::new(0),
        cancelled: Arc::new(AtomicBool::new(false)),
        pause: Arc::new(PauseSignal::new()),
        global_conflict: Mutex::new(None),
        per_item_decisions: Mutex::new(HashMap::new()),
        conflict_gate: ConflictGate::new(),
        pending_conflict_dest: Mutex::new(None),
    });

    // Emit initial queued status + progress so the UI shows the card.
    emit_status(&app, &id, TransferStatus::Queued);
    emit_progress(&app, &job);

    state.insert_job(job.clone());

    // Spawn the worker on a plain OS thread.
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        run_job(app_for_thread, job);
    });

    Ok(StartTransferResult { job_id: id })
}

#[command]
pub async fn pause_transfer(
    state: tauri::State<'_, TransferState>,
    job_id: String,
) -> Result<(), String> {
    let job = state
        .get_job(&job_id)
        .ok_or_else(|| format!("Unknown job: {}", job_id))?;
    job.pause.pause();
    let app = state.app_handle();
    if let Some(app) = app {
        emit_status(&app, &job_id, TransferStatus::Paused);
    }
    Ok(())
}

#[command]
pub async fn resume_transfer(
    state: tauri::State<'_, TransferState>,
    job_id: String,
) -> Result<(), String> {
    let job = state
        .get_job(&job_id)
        .ok_or_else(|| format!("Unknown job: {}", job_id))?;
    job.pause.resume();
    let app = state.app_handle();
    if let Some(app) = app {
        emit_status(&app, &job_id, TransferStatus::Running);
    }
    Ok(())
}

#[command]
pub async fn cancel_transfer(
    state: tauri::State<'_, TransferState>,
    job_id: String,
) -> Result<(), String> {
    let job = state
        .get_job(&job_id)
        .ok_or_else(|| format!("Unknown job: {}", job_id))?;
    job.cancelled.store(true, Ordering::SeqCst);
    // Also unpause so the worker wakes up and observes cancellation.
    job.pause.resume();
    Ok(())
}

// Resolve a pending conflict. The frontend supplies the conflict's
// destination path (or the item_index, which we cross-check against
// `pending_conflict_dest`) plus the action. The worker is blocked on
// `conflict_gate.wait(...)`; we record the decision and disarm the gate
// so it can continue.
//
// Apply-to-all variants (`ReplaceAll` / `SkipAll`) also write the
// normalized form into `global_conflict` so subsequent items inherit
// the choice. `KeepBoth` is implicitly "apply to all" for the rest of
// the job — every conflicting item just gets a unique "Copy (n)"
// suffix.
#[command]
pub async fn resolve_conflict(
    state: tauri::State<'_, TransferState>,
    job_id: String,
    item_index: usize,
    action: ConflictAction,
) -> Result<(), String> {
    let job = state
        .get_job(&job_id)
        .ok_or_else(|| format!("Unknown job: {}", job_id))?;

    // Apply-to-all branches: store the normalized action globally and
    // disarm the gate. The worker re-reads the decision immediately
    // after waking up.
    let apply_to_all = matches!(
        action,
        ConflictAction::ReplaceAll | ConflictAction::SkipAll | ConflictAction::KeepBoth
    );

    if apply_to_all {
        let normalized = match action {
            ConflictAction::ReplaceAll => ConflictAction::Replace,
            ConflictAction::SkipAll => ConflictAction::Skip,
            // KeepBoth has no normalization — it just means "for every
            // conflict, generate a unique destination".
            other => other,
        };
        if let Ok(mut g) = job.global_conflict.lock() {
            *g = Some(normalized);
        }
    } else {
        // Per-item decision: store under the same key the worker uses
        // (`<item_index>:<destination>`). The destination comes from
        // `pending_conflict_dest`, which the worker set right before
        // arming the gate.
        if let Ok(dest_guard) = job.pending_conflict_dest.lock() {
            if let Some(dest) = dest_guard.as_ref() {
                let key = format!("{}:{}", item_index, dest);
                if let Ok(mut map) = job.per_item_decisions.lock() {
                    map.insert(key, action);
                }
            }
        }
    }

    // Always increment the resolved counter so the UI updates its badge.
    job.resolved_conflicts.fetch_add(1, Ordering::Relaxed);

    // Wake the worker.
    job.conflict_gate.disarm();

    // Make sure the worker isn't also blocked on a user pause.
    job.pause.resume();

    Ok(())
}

#[command]
pub async fn list_transfers(
    state: tauri::State<'_, TransferState>,
) -> Result<Vec<TransferJobView>, String> {
    Ok(state.snapshot())
}

#[command]
pub async fn dismiss_transfer(
    state: tauri::State<'_, TransferState>,
    job_id: String,
) -> Result<(), String> {
    if let Ok(mut map) = state.jobs.lock() {
        map.remove(&job_id);
    }
    Ok(())
}

// ── AppHandle attach helper ────────────────────────────────────────────────

pub fn install(app: &AppHandle) {
    let mut state = TransferState::new();
    state.attach(app.clone());
    app.manage(state);
}
