import { describe, expect, it } from 'vitest';
import {
	ALL_TIME_LOOKBACK_HOURS,
	DEFAULT_LOOKBACK_HOURS,
	LOOKBACK_PERIODS,
} from '../../../../renderer/components/History/lookbackOptions';

describe('history lookback registry', () => {
	it('preserves the persisted ordering and bounded default', () => {
		expect(LOOKBACK_PERIODS.map((period) => period.hours)).toEqual([
			24,
			72,
			168,
			336,
			720,
			4320,
			8760,
			null,
		]);
		expect(DEFAULT_LOOKBACK_HOURS).toBe(24);
	});

	it('uses null as the all-time storage and URL sentinel', () => {
		expect(ALL_TIME_LOOKBACK_HOURS).toBeNull();
		expect(LOOKBACK_PERIODS.at(-1)?.hours).toBe(ALL_TIME_LOOKBACK_HOURS);
	});
});
