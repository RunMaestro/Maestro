/**
 * Bounds helpers shared by Quick Chat and the floating widgets.
 *
 * A saved record comes from a store a person can hand-edit, so every field
 * that is not a usable number is dropped. A saved spot opens where it was
 * when it is still on a connected display, is pulled back onto the primary
 * display when it is not, and its size never exceeds the display's work area.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { displays } = vi.hoisted(() => ({
	displays: {
		primary: { workArea: { x: 0, y: 0, width: 1600, height: 1000 } },
		matching: { workArea: { x: 0, y: 0, width: 1600, height: 1000 } },
	},
}));

vi.mock('electron', () => ({
	screen: {
		getDisplayMatching: vi.fn(() => displays.matching),
		getPrimaryDisplay: vi.fn(() => displays.primary),
	},
}));

import {
	finiteNumber,
	positiveNumber,
	resolveSavedWindowRect,
	sanitizeSavedBounds,
} from '../../../main/floating-widgets/window-bounds';

const PRIMARY = { x: 0, y: 0, width: 1600, height: 1000 };

beforeEach(() => {
	displays.primary = { workArea: { ...PRIMARY } };
	displays.matching = { workArea: { ...PRIMARY } };
});

describe('finiteNumber / positiveNumber', () => {
	it('keeps finite numbers and drops everything else', () => {
		expect(finiteNumber(-40)).toBe(-40);
		expect(finiteNumber(0)).toBe(0);
		expect(finiteNumber(NaN)).toBeUndefined();
		expect(finiteNumber(Infinity)).toBeUndefined();
		expect(finiteNumber('12')).toBeUndefined();
		expect(finiteNumber(null)).toBeUndefined();
	});

	it('requires a size to be above zero', () => {
		expect(positiveNumber(300)).toBe(300);
		expect(positiveNumber(0)).toBeUndefined();
		expect(positiveNumber(-1)).toBeUndefined();
		expect(positiveNumber(NaN)).toBeUndefined();
	});
});

describe('sanitizeSavedBounds', () => {
	it('keeps a valid record, including negative coordinates', () => {
		expect(sanitizeSavedBounds({ x: -1200, y: -30, width: 300, height: 220 })).toEqual({
			x: -1200,
			y: -30,
			width: 300,
			height: 220,
		});
	});

	it('drops fields a hand edit broke', () => {
		expect(sanitizeSavedBounds({ x: 'left', y: NaN, width: 0, height: -5 })).toEqual({
			x: undefined,
			y: undefined,
			width: undefined,
			height: undefined,
		});
	});

	it('treats a missing or non-object record as empty', () => {
		const empty = { x: undefined, y: undefined, width: undefined, height: undefined };
		expect(sanitizeSavedBounds(undefined)).toEqual(empty);
		expect(sanitizeSavedBounds(null)).toEqual(empty);
		expect(sanitizeSavedBounds('bounds')).toEqual(empty);
	});
});

describe('resolveSavedWindowRect', () => {
	it('returns null when there is no saved spot', () => {
		expect(resolveSavedWindowRect(null, { width: 300, height: 220 })).toBeNull();
		expect(resolveSavedWindowRect({ x: 10 }, { width: 300, height: 220 })).toBeNull();
		expect(resolveSavedWindowRect({ y: 10 }, { width: 300, height: 220 })).toBeNull();
	});

	it('opens at the saved spot when it is on a connected display', () => {
		expect(resolveSavedWindowRect({ x: 400.4, y: 300.6 }, { width: 300, height: 220 })).toEqual({
			x: 400,
			y: 301,
			width: 300,
			height: 220,
		});
	});

	it('pulls a spot on an unplugged monitor back onto the primary display', () => {
		// The monitor that held x=3000 is gone; the nearest display is the primary.
		const rect = resolveSavedWindowRect({ x: 3000, y: 200 }, { width: 300, height: 220 });
		expect(rect).toEqual({ x: 650, y: 390, width: 300, height: 220 });
	});

	it('clamps the size to the work area of the display it lands on', () => {
		displays.matching = { workArea: { x: 0, y: 0, width: 800, height: 500 } };
		const rect = resolveSavedWindowRect({ x: 10, y: 10 }, { width: 1200, height: 900 });
		expect(rect).toEqual({ x: 10, y: 10, width: 800, height: 500 });
	});
});
