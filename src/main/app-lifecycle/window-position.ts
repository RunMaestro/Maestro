import { screen } from 'electron';

/** A display work-area rectangle in screen (DIP) coordinates. */
type DisplayWorkArea = { x: number; y: number; width: number; height: number };

/**
 * Centers a window of the given size inside a display's work area. The offset is
 * clamped to zero so a window larger than the work area still pins to its
 * top-left corner (its title bar) rather than spilling above/left of it.
 */
function centerWithinWorkArea(
	workArea: DisplayWorkArea,
	width: number,
	height: number
): { x: number; y: number } {
	return {
		x: Math.round(workArea.x + Math.max(0, (workArea.width - width) / 2)),
		y: Math.round(workArea.y + Math.max(0, (workArea.height - height) / 2)),
	};
}

/**
 * Resolves the on-screen position for a window restored from saved bounds,
 * accounting for display-configuration changes between sessions.
 *
 * The saved bounds are validated against the *current* displays:
 * `screen.getDisplayMatching` returns the display the saved rectangle most
 * closely intersects (when the monitor that held the window has been unplugged
 * this falls back to the nearest remaining display), and we check whether the
 * window's title bar would actually be reachable on it. Two cases leave the
 * saved coordinates unusable and the window invisible:
 *   - the window was saved minimized (Windows reports bounds of -32000,-32000), or
 *   - the monitor it lived on has been removed.
 * In both cases the window is repositioned onto the primary display so it can
 * never spawn off-screen. When there is no saved position at all we return
 * undefined x/y so Electron places the window itself.
 */
export function resolveVisibleWindowPosition(state: {
	x?: number;
	y?: number;
	width: number;
	height: number;
}): { x?: number; y?: number } {
	if (typeof state.x !== 'number' || typeof state.y !== 'number') {
		return {};
	}

	const bounds = { x: state.x, y: state.y, width: state.width, height: state.height };

	// Validate against the display the saved bounds most closely intersect. If
	// that monitor is gone, getDisplayMatching returns the nearest remaining one
	// and the reachability check below fails, triggering a reposition.
	const matched = screen.getDisplayMatching(bounds);

	// The window is reachable if the center of its title bar lands inside the
	// matched display's work area, with a bottom margin so the title bar can't
	// sit below the screen edge where it can't be grabbed.
	const BOTTOM_MARGIN = 80;
	const TITLE_BAR_SAMPLE_Y = 16; // approximate title-bar height (px)
	const titleBar = { x: bounds.x + bounds.width / 2, y: bounds.y + TITLE_BAR_SAMPLE_Y };
	const { x, y, width, height } = matched.workArea;
	const isOnScreen =
		titleBar.x >= x &&
		titleBar.x <= x + width &&
		titleBar.y >= y &&
		titleBar.y <= y + height - BOTTOM_MARGIN;

	if (isOnScreen) {
		return { x: bounds.x, y: bounds.y };
	}

	// Off-screen (minimized sentinel or removed monitor): bring the window back
	// onto the primary display so it can never spawn invisible.
	return centerWithinWorkArea(screen.getPrimaryDisplay().workArea, bounds.width, bounds.height);
}
