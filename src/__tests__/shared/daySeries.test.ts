import { describe, it, expect } from 'vitest';
import { fillDaySeries, localDaysBetween } from '../../shared/daySeries';

describe('localDaysBetween', () => {
	it('lists every day inclusive, across a month boundary', () => {
		expect(localDaysBetween('2026-10-30', '2026-11-02')).toEqual([
			'2026-10-30',
			'2026-10-31',
			'2026-11-01',
			'2026-11-02',
		]);
	});

	it('is empty for an inverted window', () => {
		expect(localDaysBetween('2026-11-02', '2026-11-01')).toEqual([]);
	});
});

describe('fillDaySeries', () => {
	it('fills idle days with the empty row and drops rows outside the window', () => {
		const rows = [
			{ date: '2026-10-29', count: 9 },
			{ date: '2026-10-31', count: 2 },
		];
		expect(fillDaySeries(rows, '2026-10-30', '2026-11-01', (date) => ({ date, count: 0 }))).toEqual(
			[
				{ date: '2026-10-30', count: 0 },
				{ date: '2026-10-31', count: 2 },
				{ date: '2026-11-01', count: 0 },
			]
		);
	});
});
