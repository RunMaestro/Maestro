import { describe, it, expect } from 'vitest';
import {
	mergeUsagePeaks,
	usagePeaksEqual,
	ZERO_USAGE_PEAKS,
	USAGE_PEAK_KEYS,
} from '../../shared/usagePeaks';

describe('mergeUsagePeaks', () => {
	const stored = {
		maxAgents: 89,
		maxDefinedAgents: 89,
		maxSimultaneousAutoRuns: 8,
		maxSimultaneousQueries: 8,
		maxQueueDepth: 16,
	};

	it('keeps the stored value when the incoming sample is lower', () => {
		const merged = mergeUsagePeaks(stored, {
			maxAgents: 12,
			maxDefinedAgents: 12,
			maxSimultaneousAutoRuns: 1,
			maxSimultaneousQueries: 2,
			maxQueueDepth: 0,
		});
		expect(merged).toEqual(stored);
	});

	it('raises only the counters that were actually beaten', () => {
		const merged = mergeUsagePeaks(stored, { maxQueueDepth: 20, maxAgents: 3 });
		expect(merged.maxQueueDepth).toBe(20);
		expect(merged.maxAgents).toBe(89);
	});

	// The incident this guards: a caller whose own copy is still zeroed (a
	// renderer mid-hydration, a second window) must not be able to lower a peak.
	it('cannot lower a peak from a zeroed baseline', () => {
		const merged = mergeUsagePeaks(stored, ZERO_USAGE_PEAKS);
		expect(merged).toEqual(stored);
	});

	it('treats a missing, null, or undefined side as no observation', () => {
		expect(mergeUsagePeaks(stored, undefined)).toEqual(stored);
		expect(mergeUsagePeaks(null, stored)).toEqual(stored);
		expect(mergeUsagePeaks(undefined, undefined)).toEqual(ZERO_USAGE_PEAKS);
	});

	// Math.max(89, NaN) is NaN, which would wipe the peak it is defending.
	it('coerces junk read back from JSON to 0 instead of NaN', () => {
		const merged = mergeUsagePeaks(stored, {
			maxAgents: NaN,
			maxQueueDepth: -5,
			maxSimultaneousQueries: 'nope' as unknown as number,
		});
		expect(merged).toEqual(stored);
		for (const key of USAGE_PEAK_KEYS) {
			expect(Number.isFinite(merged[key])).toBe(true);
		}
	});

	it('fills in a key the stored object predates', () => {
		const merged = mergeUsagePeaks({ maxAgents: 4 }, { maxQueueDepth: 2 });
		expect(merged).toEqual({
			maxAgents: 4,
			maxDefinedAgents: 0,
			maxSimultaneousAutoRuns: 0,
			maxSimultaneousQueries: 0,
			maxQueueDepth: 2,
		});
	});
});

describe('usagePeaksEqual', () => {
	it('is true when every counter matches', () => {
		expect(usagePeaksEqual(ZERO_USAGE_PEAKS, { ...ZERO_USAGE_PEAKS })).toBe(true);
	});

	it('is false when any counter differs', () => {
		expect(usagePeaksEqual(ZERO_USAGE_PEAKS, { ...ZERO_USAGE_PEAKS, maxQueueDepth: 1 })).toBe(
			false
		);
	});

	it('treats a missing key and an explicit 0 as the same', () => {
		expect(usagePeaksEqual({ maxAgents: 3 }, { maxAgents: 3, maxQueueDepth: 0 })).toBe(true);
	});
});
