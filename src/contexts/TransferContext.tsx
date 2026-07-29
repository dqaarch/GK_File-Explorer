/**
 * TransferContext
 *
 * Global state for the file-transfer queue. The reducer is the single
 * source of truth; events from Rust (and commands) dispatch actions.
 *
 * The modal UI lives elsewhere (TransferQueueModal component, planned
 * for Phase 1); for now the context is wired but no UI consumes it.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import type {
  ConflictEvent,
  ProgressEvent,
  StatusEvent,
  TransferJobView,
} from "../types/transfer";
import {
  cancelTransfer,
  dismissTransfer,
  listTransfers,
  pauseTransfer,
  resumeTransfer,
} from "../TauriFileSystem";

type PendingConflict = ConflictEvent & { id: string };

interface TransferStateShape {
  jobs: Record<string, TransferJobView>;
  /** Order in which jobs were first seen, used to keep the queue stable. */
  order: string[];
  /** Conflicts awaiting user resolution, keyed by a local id. */
  conflicts: PendingConflict[];
}

type TransferAction =
  | { type: "progress"; payload: ProgressEvent }
  | { type: "status"; payload: StatusEvent }
  | { type: "conflict"; payload: ConflictEvent }
  | { type: "conflict-resolved"; conflictId: string }
  | { type: "all-conflicts-cleared-for-job"; jobId: string }
  | { type: "dismiss"; jobId: string }
  | { type: "bulk-snapshot"; jobs: TransferJobView[] };

const initialState: TransferStateShape = {
  jobs: {},
  order: [],
  conflicts: [],
};

function reducer(
  state: TransferStateShape,
  action: TransferAction,
): TransferStateShape {
  switch (action.type) {
    case "progress": {
      const { job } = action.payload;
      const existing = state.jobs[job.id];
      return {
        ...state,
        jobs: {
          ...state.jobs,
          [job.id]: job,
        },
        order: existing ? state.order : [...state.order, job.id],
      };
    }
    case "status": {
      const { job_id, status } = action.payload;
      const existing = state.jobs[job_id];
      if (!existing) return state;
      return {
        ...state,
        jobs: {
          ...state.jobs,
          [job_id]: { ...existing, status },
        },
      };
    }
    case "conflict": {
      const id = `${action.payload.job_id}:${action.payload.timestamp_ms}`;
      // De-dupe identical conflict events (rust may emit on retry).
      if (
        state.conflicts.some(
          (c) =>
            c.job_id === action.payload.job_id &&
            c.source === action.payload.source &&
            c.destination === action.payload.destination,
        )
      ) {
        return state;
      }
      return {
        ...state,
        conflicts: [...state.conflicts, { ...action.payload, id }],
      };
    }
    case "conflict-resolved": {
      return {
        ...state,
        conflicts: state.conflicts.filter((c) => c.id !== action.conflictId),
      };
    }
    case "all-conflicts-cleared-for-job": {
      return {
        ...state,
        conflicts: state.conflicts.filter((c) => c.job_id !== action.jobId),
      };
    }
    case "dismiss": {
      const { [action.jobId]: _removed, ...rest } = state.jobs;
      return {
        ...state,
        jobs: rest,
        order: state.order.filter((id) => id !== action.jobId),
        conflicts: state.conflicts.filter((c) => c.job_id !== action.jobId),
      };
    }
    case "bulk-snapshot": {
      const jobs: Record<string, TransferJobView> = {};
      const order: string[] = [];
      for (const job of action.jobs) {
        jobs[job.id] = job;
        order.push(job.id);
      }
      return { ...state, jobs, order };
    }
    default:
      return state;
  }
}

export interface TransferContextValue {
  /** All known jobs, in insertion order. */
  jobs: TransferJobView[];
  /** All conflicts currently awaiting a user decision. */
  conflicts: PendingConflict[];
  /** Convenience accessors. */
  activeCount: number;
  queuedCount: number;
  hasFailures: boolean;
  hasActivity: boolean;
  /** UI language. Mirrored from the explorer for i18n labels. */
  language: "vi" | "en";
  /** Imperative helpers — used by the modal once it exists. */
  pause: (jobId: string) => Promise<void>;
  resume: (jobId: string) => Promise<void>;
  cancel: (jobId: string) => Promise<void>;
  dismiss: (jobId: string) => void;
}

const TransferContext = createContext<TransferContextValue | null>(null);

interface TransferProviderProps {
  children: React.ReactNode;
}

export function TransferProvider({ children }: TransferProviderProps) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Language mirror: read from the same localStorage key the explorer
  // uses (NEXUS_LANGUAGE). This avoids coupling the transfer context
  // to the explorer hook. Listens to the `storage` event so toggles
  // propagate across windows in the future.
  const readLanguage = (): "vi" | "en" => {
    try {
      const stored = localStorage.getItem("NEXUS_LANGUAGE");
      if (stored === "en") return "en";
    } catch {
      /* ignore */
    }
    return "vi";
  };
  const [language, setLanguageState] = useState<"vi" | "en">(readLanguage);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "NEXUS_LANGUAGE") {
        setLanguageState(readLanguage());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const pause = useCallback(async (jobId: string) => {
    await pauseTransfer(jobId);
  }, []);

  const resume = useCallback(async (jobId: string) => {
    await resumeTransfer(jobId);
  }, []);

  const cancel = useCallback(async (jobId: string) => {
    await cancelTransfer(jobId);
  }, []);

  const dismiss = useCallback((jobId: string) => {
    dispatch({ type: "dismiss", jobId });
    // Fire-and-forget; backend just drops the job from its map.
    dismissTransfer(jobId).catch(() => {});
  }, []);

  const value = useMemo<TransferContextValue>(() => {
    const jobs = state.order
      .map((id) => state.jobs[id])
      .filter((j): j is TransferJobView => Boolean(j));
    const activeCount = jobs.filter(
      (j) => j.status === "running" || j.status === "paused",
    ).length;
    const queuedCount = jobs.filter((j) => j.status === "queued").length;
    const hasFailures = jobs.some(
      (j) => j.status === "failed" || j.failed_items.length > 0,
    );
    return {
      jobs,
      conflicts: state.conflicts,
      activeCount,
      queuedCount,
      hasFailures,
      hasActivity: jobs.length > 0,
      language,
      pause,
      resume,
      cancel,
      dismiss,
    };
  }, [state, pause, resume, cancel, dismiss, language]);

  return (
    <TransferDispatchContext.Provider value={dispatch}>
      <TransferContext.Provider value={value}>
        {children}
      </TransferContext.Provider>
    </TransferDispatchContext.Provider>
  );
}

export function useTransfer(): TransferContextValue {
  const ctx = useContext(TransferContext);
  if (!ctx) {
    throw new Error("useTransfer must be used inside <TransferProvider>");
  }
  return ctx;
}

/**
 * Returns the raw dispatch handle for the transfer queue. Reserved for
 * internal wiring (event listener bridge, dev-tools). Most code should
 * prefer `useTransfer()` which exposes domain-specific actions.
 */
export function useTransferDispatch(): TransferDispatch {
  // The provider exposes dispatch via a separate ref-less channel so the
  // public `useTransfer()` context stays stable.
  const dispatch = useTransferDispatchInner();
  return dispatch;
}

function useTransferDispatchInner(): TransferDispatch {
  // The provider places dispatch in a sibling ref-context. We use a
  // second context for that to avoid re-rendering consumers on every
  // progress tick.
  const ctx = useContext(TransferDispatchContext);
  if (!ctx) {
    throw new Error(
      "useTransferDispatch must be used inside <TransferProvider>",
    );
  }
  return ctx;
}

const TransferDispatchContext = createContext<TransferDispatch | null>(null);

// Internal helpers exported for the event-listener hook.
export const transferActions = {
  progress: (payload: ProgressEvent) =>
    ({ type: "progress" as const, payload }),
  status: (payload: StatusEvent) => ({ type: "status" as const, payload }),
  conflict: (payload: ConflictEvent) =>
    ({ type: "conflict" as const, payload }),
  bulkSnapshot: (jobs: TransferJobView[]) =>
    ({ type: "bulk-snapshot" as const, jobs }),
};

// Bridge for the event hook so it can dispatch without owning the reducer.
export type TransferDispatch = React.Dispatch<TransferAction>;

/**
 * Hook variant for non-React callers (rare) or tests.
 */
export function useTransferState(): readonly [TransferStateShape, TransferDispatch] {
  // Returns a frozen snapshot pair. Mostly used in tests.
  const [state, dispatch] = useReducer(reducer, initialState);
  return [state, dispatch] as const;
}

// Avoid unused-warning for the bridge when no listener is mounted yet.
void transferActions;

/**
 * On mount, fetch the current job list from the backend so the UI
 * recovers state when the window is reloaded mid-transfer.
 */
export function useTransferBootstrap(dispatch: TransferDispatch) {
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const jobs = await listTransfers();
        if (!disposed) {
          dispatch(transferActions.bulkSnapshot(jobs));
        }
      } catch {
        // Backend unavailable (dev mode without tauri) — ignore.
      }
    })();
    return () => {
      disposed = true;
    };
  }, [dispatch]);
}
