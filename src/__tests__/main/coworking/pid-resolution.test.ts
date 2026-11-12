/**
 * Unit tests for the PID-walk fallback used by the coworking bridge's handshake.
 *
 * `getParentPid` is platform-specific and exercised in the actual app; here we
 * focus on the pure walk logic, which is the part with non-trivial control flow.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	resolveSessionFromPidWalk,
	MAX_PID_WALK_HOPS,
} from '../../../main/coworking/pid-resolution';

describe('resolveSessionFromPidWalk', () => {
	it('returns the session id when the start pid is directly known', async () => {
		const lookup = vi.fn((pid: number) => (pid === 100 ? 'sess-A' : null));
		const getParent = vi.fn(async () => null);

		expect(await resolveSessionFromPidWalk(100, lookup, getParent)).toBe('sess-A');
		expect(lookup).toHaveBeenCalledTimes(1);
		// We hit on first try, so the walk does not consult getParent.
		expect(getParent).not.toHaveBeenCalled();
	});

	it('walks up the parent chain until it finds a known ancestor', async () => {
		// PID tree: 500 (mcp) -> 400 (shell) -> 300 (agent CLI, known)
		const lookup = (pid: number) => (pid === 300 ? 'sess-B' : null);
		const parents: Record<number, number> = { 500: 400, 400: 300, 300: 1 };
		const getParent = vi.fn(async (pid: number) => parents[pid] ?? null);

		expect(await resolveSessionFromPidWalk(500, lookup, getParent)).toBe('sess-B');
		// 500 (miss) -> getParent -> 400 (miss) -> getParent -> 300 (hit).
		expect(getParent).toHaveBeenCalledTimes(2);
	});

	it('gives up after MAX_PID_WALK_HOPS hops', async () => {
		const lookup = () => null;
		// An endlessly-deep chain that never resolves: 10 -> 9 -> 8 -> ...
		const getParent = vi.fn(async (pid: number) => (pid > 2 ? pid - 1 : null));

		expect(await resolveSessionFromPidWalk(100, lookup, getParent)).toBeNull();
		// The walk inspects start + up to MAX_PID_WALK_HOPS ancestors. Once an
		// iteration finds no match it calls getParent, so the call count is
		// bounded by MAX_PID_WALK_HOPS + 1 (the final hop's parent lookup).
		expect(getParent.mock.calls.length).toBeLessThanOrEqual(MAX_PID_WALK_HOPS + 1);
	});

	it('returns null when start pid is invalid', async () => {
		const lookup = vi.fn(() => 'sess-X');
		const getParent = vi.fn(async () => 200);

		expect(await resolveSessionFromPidWalk(0, lookup, getParent)).toBeNull();
		expect(await resolveSessionFromPidWalk(-1, lookup, getParent)).toBeNull();
		expect(await resolveSessionFromPidWalk(1, lookup, getParent)).toBeNull();
		expect(lookup).not.toHaveBeenCalled();
	});

	it('stops walking when getParent reports a self-cycle or pid<=1', async () => {
		const lookup = () => null;
		// Self-cycle: 50's parent is 50. Walk must terminate, not loop.
		const getParent = vi.fn(async (pid: number) => (pid === 50 ? 50 : null));

		expect(await resolveSessionFromPidWalk(50, lookup, getParent)).toBeNull();
		expect(getParent).toHaveBeenCalledTimes(1);
	});

	it('stops walking when getParent returns pid 1 (init/launchd)', async () => {
		const lookup = () => null;
		const getParent = vi.fn(async (pid: number) => (pid === 200 ? 1 : null));

		expect(await resolveSessionFromPidWalk(200, lookup, getParent)).toBeNull();
		expect(getParent).toHaveBeenCalledTimes(1);
	});
});
