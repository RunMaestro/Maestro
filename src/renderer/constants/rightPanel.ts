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

/**
 * Type size for the Right Bar's own chrome: the Files / History / Auto Run tab
 * labels and the History filter pills.
 *
 * One constant for both because they sit in the same visual band, directly
 * above the content they label - if they drift apart the header reads as two
 * unrelated rows.
 *
 * Sized DOWN from Tailwind's `text-xs` on purpose. These labels are rem-based
 * and so grow with the interface font and the Cmd+= zoom, while the History
 * entries beneath them are pinned at an absolute `text-[10px]` and never grow.
 * At a 16px interface font with a 1.2 zoom the chrome was rendering near 14px
 * against 10px content - a header 40% larger than the rows it describes, which
 * reads as the labels shouting over their own list.
 *
 * Deliberately still in `rem` rather than a pixel literal: these must keep
 * scaling with Cmd+=. Only the STEP moves, so the chrome sits below the content
 * at every zoom level rather than only at one.
 *
 * 9/16rem. Against the sizes these replaced that is roughly -18% for the pills
 * (previously 0.6875rem) and -25% for the tab labels (previously `text-xs`),
 * landing both just above the 10px entry rows instead of well above them. One
 * value for both rather than two exact percentages: a header whose two rows are
 * a hair different in size looks like a mistake, not a hierarchy.
 */
export const RIGHT_PANEL_CHROME_FONT_SIZE = '0.5625rem';

/**
 * Line height for that chrome. Stated explicitly because dropping Tailwind's
 * `text-xs` also drops the `line-height: 1rem` it carried: without this the
 * pills would resize to whatever line height they happened to inherit, and the
 * point is to shrink the glyphs, not the controls.
 */
export const RIGHT_PANEL_CHROME_LINE_HEIGHT = '1rem';
