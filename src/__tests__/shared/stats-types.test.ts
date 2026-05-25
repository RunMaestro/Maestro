import { describe, expect, it } from 'vitest';
import { STATS_DB_VERSION } from '../../shared/stats-types';

describe('stats shared runtime constants', () => {
	it('exposes the current stats database schema version', () => {
		expect(STATS_DB_VERSION).toBe(4);
	});
});
