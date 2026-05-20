import { describe, expect, it } from 'vitest';
import type { WindowInfo } from '../../../shared/types/window';
import {
	getSessionWindowOwnership,
	getWindowNumberById,
} from '../../../renderer/utils/windowSessionOwnership';

const windows: WindowInfo[] = [
	{
		id: 'window-main',
		isMain: true,
		sessionIds: ['session-a'],
		activeSessionId: 'session-a',
	},
	{
		id: 'window-secondary',
		isMain: false,
		sessionIds: ['session-b', 'session-c'],
		activeSessionId: 'session-b',
	},
];

describe('windowSessionOwnership', () => {
	it('numbers windows based on the list order', () => {
		expect(getWindowNumberById(windows)).toEqual(
			new Map([
				['window-main', 1],
				['window-secondary', 2],
			])
		);
	});

	it('returns a badge for sessions open in another window', () => {
		expect(getSessionWindowOwnership('session-b', 'window-main', windows)).toEqual({
			ownerWindowId: 'window-secondary',
			windowNumber: 2,
			isCurrentWindow: false,
			isOpenInOtherWindow: true,
			badgeLabel: 'W2',
		});
	});

	it('does not badge local or unopened sessions', () => {
		expect(getSessionWindowOwnership('session-a', 'window-main', windows).badgeLabel).toBeNull();
		expect(getSessionWindowOwnership('session-unopened', 'window-main', windows)).toEqual({
			ownerWindowId: null,
			windowNumber: null,
			isCurrentWindow: false,
			isOpenInOtherWindow: false,
			badgeLabel: null,
		});
	});
});
