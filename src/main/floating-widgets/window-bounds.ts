/**
 * Bounds helpers for the small always-on-top windows (Quick Chat and the
 * floating widgets): reading a saved size and spot back out of the
 * window-state store, and deciding whether that spot is still on screen.
 */

import { screen } from 'electron';
import type { FloatingWidgetBounds } from '../../shared/floatingWidgets';
import { resolveVisibleWindowPosition } from '../app-lifecycle/window-position';

/** A finite number, or undefined: a hand-edited store must not place the window at NaN. */
export function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A positive finite number, or undefined: a hand-edited store must not size the window to NaN. */
export function positiveNumber(value: unknown): number | undefined {
	const n = finiteNumber(value);
	return n !== undefined && n > 0 ? n : undefined;
}

/**
 * A saved `{ x, y, width, height }` record with every field that is not a
 * usable number dropped. Position may be any finite number (displays left of
 * or above the primary have negative coordinates); size must be positive.
 */
export function sanitizeSavedBounds(raw: unknown): FloatingWidgetBounds {
	const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	return {
		x: finiteNumber(record.x),
		y: finiteNumber(record.y),
		width: positiveNumber(record.width),
		height: positiveNumber(record.height),
	};
}

/**
 * Where a window of `size` should open at its saved spot, or null when there
 * is no saved spot. The spot goes through the same visibility check the app
 * windows use, so an unplugged monitor cannot leave the window off screen, and
 * the size is clamped to the work area of the display the window lands on.
 */
export function resolveSavedWindowRect(
	saved: Pick<FloatingWidgetBounds, 'x' | 'y'> | null | undefined,
	size: { width: number; height: number }
): Electron.Rectangle | null {
	if (saved?.x === undefined || saved?.y === undefined) return null;
	const { width, height } = size;
	const position = resolveVisibleWindowPosition({ x: saved.x, y: saved.y, width, height });
	const x = position.x ?? saved.x;
	const y = position.y ?? saved.y;
	const area = screen.getDisplayMatching({ x, y, width, height }).workArea;
	return {
		x: Math.round(x),
		y: Math.round(y),
		width: Math.min(width, area.width),
		height: Math.min(height, area.height),
	};
}
