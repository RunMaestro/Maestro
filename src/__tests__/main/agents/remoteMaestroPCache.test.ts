import { describe, it, expect, beforeEach } from 'vitest';
import {
	setRemoteMaestroPAvailable,
	getRemoteMaestroPAvailable,
	isRemoteMaestroPProbeStale,
	REMOTE_MAESTRO_P_TTL_MS,
	__clearRemoteMaestroPCache,
} from '../../../main/agents/remoteMaestroPCache';

describe('remoteMaestroPCache', () => {
	beforeEach(() => {
		__clearRemoteMaestroPCache();
	});

	it('returns undefined for a never-probed remote', () => {
		expect(getRemoteMaestroPAvailable('remote-1')).toBeUndefined();
	});

	it('returns undefined for a missing/empty remote id', () => {
		expect(getRemoteMaestroPAvailable(undefined)).toBeUndefined();
		expect(getRemoteMaestroPAvailable(null)).toBeUndefined();
		expect(getRemoteMaestroPAvailable('')).toBeUndefined();
	});

	it('records and reads back availability keyed by remote id', () => {
		setRemoteMaestroPAvailable('remote-1', true);
		setRemoteMaestroPAvailable('remote-2', false);
		expect(getRemoteMaestroPAvailable('remote-1')).toBe(true);
		expect(getRemoteMaestroPAvailable('remote-2')).toBe(false);
	});

	it('ignores a set with an empty remote id', () => {
		setRemoteMaestroPAvailable('', true);
		expect(getRemoteMaestroPAvailable('')).toBeUndefined();
	});

	it('treats a never-probed (or empty) remote as stale', () => {
		expect(isRemoteMaestroPProbeStale('remote-1')).toBe(true);
		expect(isRemoteMaestroPProbeStale(undefined)).toBe(true);
	});

	it('treats a fresh result as not stale and an expired one as stale', () => {
		const t0 = 1_000_000;
		setRemoteMaestroPAvailable('remote-1', true, t0);
		expect(isRemoteMaestroPProbeStale('remote-1', t0 + REMOTE_MAESTRO_P_TTL_MS - 1)).toBe(false);
		expect(isRemoteMaestroPProbeStale('remote-1', t0 + REMOTE_MAESTRO_P_TTL_MS + 1)).toBe(true);
	});
});
