// Shared dispatch state for Ctrl+Scroll viewmode.
//
// Wheel handlers must dispatch EXACTLY ONE pane — never multiple. We use
// the most reliable source of truth available at the moment the wheel event
// fires: `document.elementsFromPoint(e.clientX, e.clientY)`, walked from
// topmost to bottommost and matched against each pane's registered root
// element. This works correctly even when the mouse is stationary (no
// `pointermove` to refresh a cached hovered state), when dropdown menus
// overlap another pane, or after a React re-render.

export type HoveredPane = "main" | "inspector" | "folder-inspector";

const registeredElements: Array<{ el: HTMLElement; pane: HoveredPane }> = [];

export function registerHoverPane(el: HTMLElement, pane: HoveredPane): () => void {
  const entry = { el, pane };
  registeredElements.push(entry);
  return () => {
    const idx = registeredElements.indexOf(entry);
    if (idx >= 0) registeredElements.splice(idx, 1);
  };
}

/**
 * Resolve which pane (if any) the given client coordinates are over.
 * Walks `elementsFromPoint` from topmost to bottommost, skipping menus and
 * popovers, and returns the first registered pane that contains the node.
 */
export function resolveHoveredPane(
  clientX: number,
  clientY: number
): HoveredPane | null {
  if (typeof document === "undefined") return null;
  const stack = document.elementsFromPoint(clientX, clientY);
  for (const node of stack) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.closest(".explorer-context-menu")) continue;
    if (node.closest(".fluent-menu")) continue;
    for (const reg of registeredElements) {
      if (reg.el === node || reg.el.contains(node)) {
        return reg.pane;
      }
    }
  }
  return null;
}

/**
 * Convenience for wheel handlers: given a WheelEvent, return the pane
 * currently under the cursor. Returns null if no pane is registered at
 * that point (e.g. cursor over the sidebar).
 */
export function getPaneAtWheelEvent(e: WheelEvent): HoveredPane | null {
  return resolveHoveredPane(e.clientX, e.clientY);
}