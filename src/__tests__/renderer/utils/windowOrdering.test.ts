import { describe, expect, it } from 'vitest';

import {
	getWindowNumberForId,
	orderWindowsForDisplay,
} from '../../../renderer/utils/windowOrdering';
import type { WindowInfo } from '../../../shared/types/window';

const buildWindows = (): WindowInfo[] => [
	{
		id: 'secondary-a',
		isMain: false,
		sessionIds: ['s-2'],
		activeSessionId: null,
	},
	{
		id: 'primary',
		isMain: true,
		sessionIds: ['s-1'],
		activeSessionId: 's-1',
	},
	{
		id: 'secondary-b',
		isMain: false,
		sessionIds: [],
		activeSessionId: null,
	},
];

describe('orderWindowsForDisplay', () => {
	it('returns the main window first, preserving other order', () => {
		const result = orderWindowsForDisplay(buildWindows());
		expect(result).toHaveLength(3);
		expect(result[0].id).toBe('primary');
		expect(result[1].id).toBe('secondary-a');
		expect(result[2].id).toBe('secondary-b');
	});

	it('returns a new array when no main window exists', () => {
		const withoutMain = buildWindows().map((window) => ({
			...window,
			isMain: false,
		}));
		const result = orderWindowsForDisplay(withoutMain);
		expect(result).toHaveLength(withoutMain.length);
		expect(result[0].id).toBe(withoutMain[0].id);
		expect(result[1].id).toBe(withoutMain[1].id);
		expect(result[2].id).toBe(withoutMain[2].id);
		// Ensure original array was not mutated
		expect(withoutMain[0].id).toBe('secondary-a');
	});

	it('handles empty arrays gracefully', () => {
		expect(orderWindowsForDisplay([])).toEqual([]);
	});
});

describe('getWindowNumberForId', () => {
	it('returns the 1-indexed position for known windows', () => {
		const windows = buildWindows();
		expect(getWindowNumberForId(windows, 'primary')).toBe(1);
		expect(getWindowNumberForId(windows, 'secondary-a')).toBe(2);
		expect(getWindowNumberForId(windows, 'secondary-b')).toBe(3);
	});

	it('returns null when the window cannot be found', () => {
		const windows = buildWindows();
		expect(getWindowNumberForId(windows, 'missing')).toBeNull();
		expect(getWindowNumberForId(windows, null)).toBeNull();
	});
});
