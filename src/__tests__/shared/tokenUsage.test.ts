import { describe, it, expect } from 'vitest';
import { tokenUsageQueryForRange } from '../../shared/tokenUsage';

describe('tokenUsageQueryForRange', () => {
	const now = new Date(2026, 9, 31, 1, 53).getTime();

	it('starts "Today" at local midnight, not 24 hours back (#1960)', () => {
		// Granularity is left to the accessor, which picks it from the window's span
		// (one rule for the consumption timeline and the speed charts).
		expect(tokenUsageQueryForRange('day', now)).toEqual({
			sinceMs: new Date(2026, 9, 31).getTime(),
		});
	});

	it('starts the longer ranges at local midnight N-1 days back', () => {
		expect(tokenUsageQueryForRange('week', now).sinceMs).toBe(new Date(2026, 9, 25).getTime());
		expect(tokenUsageQueryForRange('all', now)).toEqual({});
	});
});
