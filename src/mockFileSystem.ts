/**
 * mockFileSystem.ts
 * Legacy virtual filesystem (kept for compatibility).
 * Most functions are now superseded by TauriFileSystem.ts
 *
 * getBreadcrumbs and findFolderByPath are kept and updated to work with real OS paths.
 */

import { FSItem } from "./types";

/**
 * Build breadcrumb navigation from a real OS path.
 * e.g. "C:/Users/Admin/Documents" -> C: > Users > Admin > Documents
 */
export function getBreadcrumbs(items: FSItem[], path: string | null): { name: string; folderId: string | null }[] {
  const crumbs: { name: string; folderId: string | null }[] = [];

  if (!path) return crumbs;

  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");

  // Check if it's a drive root (e.g., "C:", "C:/", "D:/")
  const isDriveRoot = /^([A-Z]:\/?)$/i.test(normalized) || /^[A-Z]:$/i.test(normalized);
  
  if (isDriveRoot) {
    const driveLetter = normalized.charAt(0).toUpperCase();
    crumbs.push({ name: `${driveLetter}:`, folderId: normalized.replace(/\/+$/, "") });
    return crumbs;
  }

  // Get drive root (e.g. "C:/")
  const driveRoot = normalized.substring(0, 3);

  // Add drive letter as first crumb
  const driveLetter = driveRoot.charAt(0).toUpperCase();
  crumbs.push({ name: `${driveLetter}:`, folderId: driveRoot.replace(/\/+$/, "") });

  // Remove drive root and split
  const remainder = normalized.substring(3);
  if (!remainder) return crumbs;

  const segments = remainder.split("/").filter(Boolean);

  let currentPath = driveRoot;
  for (const segment of segments) {
    currentPath = currentPath + segment + "/";
    crumbs.push({ name: segment, folderId: currentPath.replace(/\/+$/, "") });
  }

  return crumbs;
}

/**
 * Convert an absolute path string to a folderId (which is the same string in real FS mode).
 * Returns null for "This PC" / drive root.
 */
export function findFolderByPath(items: FSItem[], pathStr: string): string | null {
  const cleanPath = pathStr.replace(/\\/g, "/").trim();

  // Root / drive root cases
  if (
    cleanPath === "C:" ||
    cleanPath === "C:/" ||
    cleanPath === "This PC" ||
    cleanPath === "" ||
    cleanPath === "/" ||
    cleanPath.length === 3 // e.g. "D:/"
  ) {
    return null;
  }

  // Remove trailing slash
  const normalized = cleanPath.replace(/\/+$/, "");
  return normalized;
}
