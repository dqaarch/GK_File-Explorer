import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { dropdownEventBus, DROPDOWN_EVENTS } from "../utils/dropdownEvents";

export interface WindowsQuickAccessItem {
  name: string;
  path: string;
  last_accessed: number;
}

interface UseWindowsQuickAccessResult {
  items: WindowsQuickAccessItem[];
  loading: boolean;
  lastSync: number;
  refresh: () => Promise<void>;
  /** Pin a folder to Windows Quick Access */
  pinToQuickAccess: (path: string) => Promise<void>;
  /** Unpin a folder from Windows Quick Access */
  unpinFromQuickAccess: (path: string) => Promise<void>;
  /** Check if a path is in Quick Access */
  isInQuickAccess: (path: string) => Promise<boolean>;
  /** Pin to Windows Start Menu */
  pinToStartMenu: (path: string) => Promise<void>;
  /** Unpin from Windows Start Menu */
  unpinFromStartMenu: (path: string) => Promise<void>;
}

/**
 * Read folders from Windows Quick Access using Shell.Application COM.
 * Includes BOTH user-pinned items AND auto-tracked frequent folders —
 * matching exactly what the user sees in Windows Explorer's Quick Access.
 *
 * `kind` field distinguishes:
 *   - "pinned"  → user explicitly pinned via "Pin to Quick access"
 *   - "frequent" → auto-tracked based on usage frequency
 *   - "recent"  → recently accessed (Windows 11 22H2+)
 *
 * Two-way sync: Windows -> App. App pinning affects Windows Quick Access.
 */
export function useWindowsQuickAccess(maxItems: number = 16): UseWindowsQuickAccessResult {
  const [items, setItems] = useState<WindowsQuickAccessItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastSync, setLastSync] = useState<number>(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await invoke<WindowsQuickAccessItem[]>("get_windows_quick_access", {
        limit: maxItems,
      });
      setItems(data);
      setLastSync(Date.now());
    } catch (err) {
      console.error("Failed to load Windows Quick Access:", err);
    } finally {
      setLoading(false);
    }
  }, [maxItems]);

  const pinToQuickAccess = useCallback(async (path: string) => {
    try {
      await invoke("pin_to_quick_access", { path });
      // Refresh the list to show the new pinned item
      await refresh();
    } catch (err) {
      console.error("Failed to pin to Quick Access:", err);
      throw err;
    }
  }, [refresh]);

  const unpinFromQuickAccess = useCallback(async (path: string) => {
    try {
      await invoke("unpin_from_quick_access", { path });
      // Refresh the list to remove the unpinned item
      await refresh();
    } catch (err) {
      console.error("Failed to unpin from Quick Access:", err);
      throw err;
    }
  }, [refresh]);

  const isInQuickAccess = useCallback(async (path: string): Promise<boolean> => {
    try {
      return await invoke<boolean>("is_in_quick_access", { path });
    } catch (err) {
      console.error("Failed to check Quick Access:", err);
      return false;
    }
  }, []);

  const pinToStartMenu = useCallback(async (path: string) => {
    try {
      await invoke("pin_to_start_menu", { path });
    } catch (err) {
      console.error("Failed to pin to Start Menu:", err);
      throw err;
    }
  }, []);

  const unpinFromStartMenu = useCallback(async (path: string) => {
    try {
      await invoke("unpin_from_start_menu", { path });
    } catch (err) {
      console.error("Failed to unpin from Start Menu:", err);
      throw err;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Listen for global refresh events (from ExplorerMainPane context menu)
  useEffect(() => {
    const handleRefresh = () => {
      refresh();
    };
    const unsubscribe = dropdownEventBus.on(DROPDOWN_EVENTS.QUICK_ACCESS_REFRESH, handleRefresh);
    return unsubscribe;
  }, [refresh]);

  return {
    items,
    loading,
    lastSync,
    refresh,
    pinToQuickAccess,
    unpinFromQuickAccess,
    isInQuickAccess,
    pinToStartMenu,
    unpinFromStartMenu,
  };
}
