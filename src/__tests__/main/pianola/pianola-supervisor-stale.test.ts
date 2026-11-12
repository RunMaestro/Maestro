/**
 * @file pianola-supervisor-stale.test.ts
 *
 * Unit tests for the pure stale-detection helper backing relaunchStale().
 * Pure: no spawning, no fs - just the enabled/alive predicate.
 */

import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';

// pianola-supervisor pulls in pianola-store-main, which imports electron's `app`
// at module load. Stub it the same way the store-main test does.
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

import { staleTargets } from '../../../main/pianola/pianola-supervisor';
import type { PianolaSupervisedTarget } from '../../../shared/pianola/storage';

function target(id: string, enabled: boolean): PianolaSupervisedTarget {
	return { id, kind: 'watch', enabled, createdAt: 0, tabId: 't', agentId: 'a' };
}

describe('staleTargets', () => {
	it('returns only enabled targets whose isAlive is false', () => {
		const targets = [
			target('alive', true),
			target('dead', true),
			target('disabled-dead', false),
			target('disabled-alive', false),
		];
		const aliveById: Record<string, true> = { alive: true, 'disabled-alive': true };
		const result = staleTargets(targets, (id) => aliveById[id] === true);
		expect(result.map((t) => t.id)).toEqual(['dead']);
	});

	it('returns empty when every enabled target is alive', () => {
		const targets = [target('a', true), target('b', true)];
		expect(staleTargets(targets, () => true)).toEqual([]);
	});

	it('treats an enabled target with no live child as stale', () => {
		const targets = [target('only', true)];
		expect(staleTargets(targets, () => false).map((t) => t.id)).toEqual(['only']);
	});

	it('never relaunches a disabled target even when it is not alive', () => {
		const targets = [target('off', false)];
		expect(staleTargets(targets, () => false)).toEqual([]);
	});

	it('does not mutate the input array', () => {
		const targets = [target('a', true), target('b', true)];
		const snapshot = [...targets];
		staleTargets(targets, () => false);
		expect(targets).toEqual(snapshot);
	});
});
