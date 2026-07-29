/**
 * Transfer engine types
 *
 * Mirrors the Rust types in `src-tauri/src/transfer.rs`. The shape of
 * `TransferJobView` must stay in sync with the Rust `TransferJobView`
 * struct (serde-rename rules: "lowercase" for Mode/Status, "snake_case"
 * for ConflictAction/Kind).
 */

export type TransferMode = "copy" | "move";

export type TransferStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed"
  | "partial_success";

export type ConflictAction =
  | "replace"
  | "skip"
  | "keep_both"
  | "replace_all"
  | "skip_all";

export type ConflictKind = "file" | "directory";

export interface FailedItem {
  source: string;
  destination: string;
  error: string;
}

export interface TransferJobView {
  id: string;
  mode: TransferMode;
  source_paths: string[];
  target_dir: string;
  status: TransferStatus;
  bytes_total: number;
  bytes_done: number;
  files_total: number;
  files_done: number;
  current_file: string | null;
  elapsed_ms: number;
  throughput_bps: number;
  eta_seconds: number | null;
  failed_items: FailedItem[];
  resolved_conflicts: number;
}

export interface ProgressEvent {
  job: TransferJobView;
  timestamp_ms: number;
}

export interface StatusEvent {
  job_id: string;
  status: TransferStatus;
  timestamp_ms: number;
}

export interface ConflictEvent {
  job_id: string;
  source: string;
  destination: string;
  kind: ConflictKind;
  timestamp_ms: number;
}

export interface StartTransferArgs {
  source_paths: string[];
  target_dir: string;
  mode: TransferMode;
}

export interface StartTransferResult {
  job_id: string;
}
