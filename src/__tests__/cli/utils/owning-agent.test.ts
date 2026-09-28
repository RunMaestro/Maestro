/**
 * @file owning-agent.test.ts
 * @description Tests for "which agent's workspace is this path in?".
 *
 * Three verbs (`open-file`, `open-graph`, and the `image save` refresh nudge)
 * ask this question, so the rule has to be one rule: every agent whose `cwd`
 * contains the path is a candidate, the DEEPEST cwd wins so a nested worktree
 * beats its parent checkout, and a genuine tie goes to whichever of those was
 * active most recently. The losers come back as `others` so a caller can say
 * which agent it picked instead of silently guessing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	readSessions: vi.fn(() => []),
	getSessionHistoryMtimeMs: vi.fn(() => 0),
}));

import {
	isPathInside,
	findOwningSessions,
	pickMostRecentlyActive,
	resolveOwningAgent,
} from '../../../cli/utils/owning-agent';
import { getSessionHistoryMtimeMs, readSessions } from '../../../cli/services/storage';
import type { SessionInfo } from '../../../shared/types';

/** Minimal agent shape: this module only reads `id` and `cwd`. */
const agent = (id: string, cwd?: string): SessionInfo => ({ id, cwd }) as SessionInfo;

/** Point the mtime tie-breaker at a fixed answer per agent id. */
function withMtimes(mtimes: Record<string, number>): void {
	vi.mocked(getSessionHistoryMtimeMs).mockImplementation((id: string) => mtimes[id] ?? 0);
}

describe('isPathInside', () => {
	it('treats the directory itself as inside', () => {
		expect(isPathInside('/repo', '/repo')).toBe(true);
	});

	it('accepts a descendant', () => {
		expect(isPathInside('/repo/src/index.ts', '/repo')).toBe(true);
	});

	it('rejects a sibling that merely shares a name prefix', () => {
		// The bug a bare startsWith() would have: /repo-backup is not in /repo.
		expect(isPathInside('/repo-backup/index.ts', '/repo')).toBe(false);
	});

	it('resolves relative segments before comparing', () => {
		expect(isPathInside('/repo/src/../src/a.ts', '/repo/src')).toBe(true);
		expect(isPathInside('/repo/src/../../elsewhere/a.ts', '/repo/src')).toBe(false);
	});
});

describe('findOwningSessions', () => {
	it('returns nothing when no agent owns the path', () => {
		expect(findOwningSessions('/tmp/loose.md', [agent('a', '/repo')])).toEqual([]);
	});

	it('ignores agents with no cwd', () => {
		const owners = findOwningSessions('/repo/a.ts', [agent('no-cwd'), agent('a', '/repo')]);
		expect(owners.map((s) => s.id)).toEqual(['a']);
	});

	it('narrows to the deepest cwd so a nested worktree beats its parent', () => {
		const owners = findOwningSessions('/repo/wt/feature/src/a.ts', [
			agent('parent', '/repo'),
			agent('worktree', '/repo/wt/feature'),
		]);
		expect(owners.map((s) => s.id)).toEqual(['worktree']);
	});

	it('keeps every agent sharing the deepest cwd as a genuine tie', () => {
		const owners = findOwningSessions('/repo/src/a.ts', [
			agent('outer', '/'),
			agent('one', '/repo'),
			agent('two', '/repo'),
		]);
		expect(owners.map((s) => s.id)).toEqual(['one', 'two']);
	});
});

describe('pickMostRecentlyActive', () => {
	beforeEach(() => vi.resetAllMocks());

	it('picks the agent whose history file was written most recently', () => {
		withMtimes({ stale: 100, fresh: 900, middling: 500 });
		const picked = pickMostRecentlyActive([
			agent('stale', '/repo'),
			agent('fresh', '/repo'),
			agent('middling', '/repo'),
		]);
		expect(picked.id).toBe('fresh');
	});

	it('keeps the first candidate when nothing has ever been written', () => {
		withMtimes({});
		const picked = pickMostRecentlyActive([agent('first', '/repo'), agent('second', '/repo')]);
		expect(picked.id).toBe('first');
	});
});

describe('resolveOwningAgent', () => {
	beforeEach(() => vi.resetAllMocks());

	it('returns null when the path is outside every workspace', () => {
		expect(resolveOwningAgent('/elsewhere/a.ts', [agent('a', '/repo')])).toBeNull();
	});

	it('reports an empty `others` for the unambiguous single-owner case', () => {
		const result = resolveOwningAgent('/repo/a.ts', [agent('a', '/repo'), agent('b', '/other')]);
		expect(result?.agent.id).toBe('a');
		// Empty `others` is how a caller tells "obvious" from "a guess".
		expect(result?.others).toEqual([]);
	});

	it('breaks a tie by recency and names the agents it passed over', () => {
		withMtimes({ old: 1, recent: 2 });
		const result = resolveOwningAgent('/repo/a.ts', [
			agent('old', '/repo'),
			agent('recent', '/repo'),
		]);
		expect(result?.agent.id).toBe('recent');
		expect(result?.others.map((s) => s.id)).toEqual(['old']);
	});

	it('reads the sessions file itself when no list is passed', () => {
		vi.mocked(readSessions).mockReturnValue([agent('from-disk', '/repo')]);
		expect(resolveOwningAgent('/repo/a.ts')?.agent.id).toBe('from-disk');
	});
});
