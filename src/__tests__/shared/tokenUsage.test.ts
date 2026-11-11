import { describe, it, expect } from 'vitest';
import { tokenUsageQueryForRange } from '../../shared/tokenUsage';

describe('tokenUsageQueryForRange', () => {
	const now = new Date(2026, 9, 31, 1, 53).getTime();

	it('starts "Today" at local midnight, not 24 hours back (#1960)', () => {
		expect(tokenUsageQueryForRange('day', now)).toEqual({
			sinceMs: new Date(2026, 9, 31).getTime(),
			granularity: 'day',
		});
	});

	it('keeps the rolling lookback for the longer ranges', () => {
		expect(tokenUsageQueryForRange('week', now).sinceMs).toBe(now - 7 * 24 * 60 * 60 * 1000);
		expect(tokenUsageQueryForRange('all', now)).toEqual({ granularity: 'month' });
	});
});
