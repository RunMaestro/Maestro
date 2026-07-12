/**
 * Tests for shared account utilities: window boundary math used by usage
 * aggregation, capacity-aware routing, and the recovery poller.
 */

import { describe, it, expect } from 'vitest';
import { getWindowBounds } from '../../../main/accounts/account-utils';

const HOUR = 60 * 60 * 1000;
const FIVE_HOURS = 5 * HOUR;

/** Local midnight for a fixed reference day. */
function midnightOf(iso: string): number {
	const d = new Date(iso);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

describe('getWindowBounds', () => {
	const dayStart = midnightOf('2026-03-10T00:00:00');

	it('aligns windows to local midnight', () => {
		const { start, end } = getWindowBounds(dayStart, FIVE_HOURS);
		expect(start).toBe(dayStart);
		expect(end).toBe(dayStart + FIVE_HOURS);
	});

	it('places a mid-window timestamp inside the correct window', () => {
		// 7h after midnight → second 5h window (5h–10h)
		const ts = dayStart + 7 * HOUR;
		const { start, end } = getWindowBounds(ts, FIVE_HOURS);
		expect(start).toBe(dayStart + FIVE_HOURS);
		expect(end).toBe(dayStart + 2 * FIVE_HOURS);
	});

	it('treats a window-boundary timestamp as the start of the next window', () => {
		const ts = dayStart + FIVE_HOURS;
		const { start } = getWindowBounds(ts, FIVE_HOURS);
		expect(start).toBe(dayStart + FIVE_HOURS);
	});

	it('the last window of the day can extend past midnight', () => {
		// 23h with 5h windows → window 4 spans 20h–25h (crosses midnight)
		const ts = dayStart + 23 * HOUR;
		const { start, end } = getWindowBounds(ts, FIVE_HOURS);
		expect(start).toBe(dayStart + 20 * HOUR);
		expect(end).toBe(dayStart + 25 * HOUR);
	});

	it('windows are stable: same window for any timestamp inside it', () => {
		const a = getWindowBounds(dayStart + FIVE_HOURS + 1, FIVE_HOURS);
		const b = getWindowBounds(dayStart + 2 * FIVE_HOURS - 1, FIVE_HOURS);
		expect(a).toEqual(b);
	});

	it('supports other window sizes (1h)', () => {
		const ts = dayStart + 90 * 60 * 1000; // 01:30
		const { start, end } = getWindowBounds(ts, HOUR);
		expect(start).toBe(dayStart + HOUR);
		expect(end).toBe(dayStart + 2 * HOUR);
	});
});
