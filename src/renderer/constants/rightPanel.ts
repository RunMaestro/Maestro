/**
 * Layout constants for the right panel (Files / History / Auto Run).
 * Shared between the resize logic in `useResizablePanel`, the persistence
 * clamps in `settingsStore`, and the compact-mode toggles inside the tab
 * toolbars so they can never drift out of sync.
 */

/**
 * Smallest panel width where the compact toolbars (text-only buttons) still
 * render without clipping. Below this we'd start cutting off labels.
 */
export const RIGHT_PANEL_MIN_WIDTH = 360;

/** Largest panel width allowed by the resize handle. */
export const RIGHT_PANEL_MAX_WIDTH = 800;

/**
 * Panel width below which toolbars switch to compact (text-only) mode. Above
 * this width the icons + text variants fit without overflowing.
 */
export const RIGHT_PANEL_COMPACT_THRESHOLD = 420;
