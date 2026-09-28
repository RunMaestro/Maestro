import { screen } from 'electron';

/** A display work-area rectangle in screen (DIP) coordinates. */
type DisplayWorkArea = { x: number; y: number; width: number; height: number };

/**
 * The app's preferred minimum window size, in DIPs. This is the floor a window
 * uses on any display large enough to hold it. See `resolveWindowSizeConstraints`
 * for how it is relaxed on smaller displays.
 */
export const DESIGN_MIN_WINDOW_WIDTH = 1000;
export const DESIGN_MIN_WINDOW_HEIGHT = 600;

/**
 * Resolves the size and minimum-size constraints for a window, clamped to the
 * work area of the display it will occupy.
 *
 * A fixed `minWidth`/`minHeight` (the previous behavior) can exceed a real
 * display's work area on small or heavily-scaled screens. `workArea` is reported
 * in DIPs with the panel/dock already subtracted, so on a 1366x768 screen at
 * 125% scale it is only ~1093x593 DIPs - smaller than the 1000x600 design
 * minimum in height. When the enforced minimum is taller than the work area the
 * window can never shrink to fit, so the native "maximize" (which targets the
 * work area) silently no-ops. Relaxing the minimum to the work area lets the
 * window fit and be maximized on such displays, while leaving the design minimum
 * intact on every display large enough to hold it.
 *
 * The returned `width`/`height` are likewise clamped down to the work area so a
 * saved (or default) size larger than the current screen does not spawn
 * oversized. They are only ever clamped down, never enlarged: a smaller saved
 * size is preserved, and the resolved `minWidth`/`minHeight` (which Electron
 * enforces when the window realizes) supplies the floor, exactly as before.
 */
export function resolveWindowSizeConstraints(state: {
	x?: number;
	y?: number;
	width: number;
	height: number;
}): { width: number; height: number; minWidth: number; minHeight: number } {
	// Match the display the window will actually occupy (same rule the position
	// resolver uses) so a window on a small secondary monitor is clamped to that
	// monitor, not the primary. With no saved position, Electron places the
	// window on the primary display, so clamp against that.
	const workArea =
		typeof state.x === 'number' && typeof state.y === 'number'
			? screen.getDisplayMatching({
					x: state.x,
					y: state.y,
					width: state.width,
					height: state.height,
				}).workArea
			: screen.getPrimaryDisplay().workArea;

	const minWidth = Math.min(DESIGN_MIN_WINDOW_WIDTH, workArea.width);
	const minHeight = Math.min(DESIGN_MIN_WINDOW_HEIGHT, workArea.height);
	const width = Math.min(state.width, workArea.width);
	const height = Math.min(state.height, workArea.height);
	return { width, height, minWidth, minHeight };
}

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
