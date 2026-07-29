/**
 * useTransferEvents
 *
 * Subscribes to the Rust event bus and dispatches payloads into the
 * TransferContext reducer. Mounted once at app startup.
 */

import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useTransferBootstrap,
  transferActions,
  type TransferDispatch,
} from "../contexts/TransferContext";
import type {
  ConflictEvent,
  ProgressEvent,
  StatusEvent,
} from "../types/transfer";

const EVT_PROGRESS = "transfer://job-progress";
const EVT_STATUS = "transfer://job-status";
const EVT_CONFLICT = "transfer://job-conflict";

export function useTransferEvents(dispatch: TransferDispatch) {
  // Re-fetch the job list once on mount so a window reload mid-transfer
  // doesn't lose state.
  useTransferBootstrap(dispatch);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    void (async () => {
      try {
        const u1 = await listen<ProgressEvent>(EVT_PROGRESS, (e) => {
          if (disposed) return;
          dispatch(transferActions.progress(e.payload));
        });
        const u2 = await listen<StatusEvent>(EVT_STATUS, (e) => {
          if (disposed) return;
          dispatch(transferActions.status(e.payload));
        });
        const u3 = await listen<ConflictEvent>(EVT_CONFLICT, (e) => {
          if (disposed) return;
          dispatch(transferActions.conflict(e.payload));
        });
        if (disposed) {
          u1();
          u2();
          u3();
          return;
        }
        unlisteners.push(u1, u2, u3);
      } catch {
        // Tauri event bus unavailable in dev (vite-only) — ignore.
      }
    })();

    return () => {
      disposed = true;
      while (unlisteners.length) {
        const u = unlisteners.pop();
        try {
          u?.();
        } catch {
          /* ignore */
        }
      }
    };
  }, [dispatch]);
}
