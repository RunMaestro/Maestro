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
 * Type size for the History filter pills (USER / AGENT / AUTO / CUE).
 *
 * These are CONTROLS that label the rows beneath them, so they sit below their
 * own content. They are rem-based and grow with the interface font and the
 * Cmd+= zoom, while the History entries are pinned at an absolute
 * `text-[10px]` and never grow - at a 16px interface font with a 1.2 zoom the
 * pills were rendering near 13px against 10px content, reading as the chrome
 * shouting over its own list.
 *
 * Deliberately still in `rem` rather than a pixel literal: a frozen size would
 * stop responding to Cmd+= while everything around it kept scaling, which is
 * the same class of bug in reverse. Only the STEP moves.
 */
export const RIGHT_PANEL_PILL_FONT_SIZE = '0.5625rem';

/**
 * Line height for the pills. Stated explicitly because dropping Tailwind's
 * `text-xs` also drops the `line-height: 1rem` it carried: without this they
 * would resize to whatever line height they happened to inherit, and the point
 * is to shrink the glyphs, not the controls.
 */
export const RIGHT_PANEL_PILL_LINE_HEIGHT = '1rem';

/**
 * Type size for the Files / History / Auto Run tab labels.
 *
 * Deliberately NOT the pill size. These are the panel's HEADING - they name
 * which of three views you are looking at, and are the largest thing in the
 * Right Bar's header by design. Sizing them like the filter pills below them
 * (an earlier pass shared one constant between the two) inverted the hierarchy
 * and made the panel's title read as a footnote.
 *
 * The rule these two constants encode: a heading sits ABOVE its content, a
 * control that labels rows sits BELOW them. They are different jobs and
 * therefore different sizes, which is why sharing one value was wrong.
 *
 * 13/16rem, not 14/16. These tabs sit opposite the Left Bar's section headers
 * (BOOKMARKS, STARRED SESSIONS), which are `text-xs` - and those are uppercase
 * with wide tracking, a treatment that reads quieter than the tabs' mixed case
 * at the same measured size. At 14/16 the tabs were 17% larger by measurement
 * and further apart than that by eye, so the two panels did not read as one
 * system. One step down leaves them clearly the heading without the two sides
 * of the window disagreeing.
 */
export const RIGHT_PANEL_TAB_FONT_SIZE = '0.8125rem';
export const RIGHT_PANEL_TAB_LINE_HEIGHT = '1.25rem';
