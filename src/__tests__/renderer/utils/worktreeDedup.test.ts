/**
 * @file worktreeDedup.test.ts
 * @description Unit tests for the shared worktree dedup mechanism.
 *
 * Verifies that paths can be marked as recently created and checked,
 * that clearing works, and that the TTL auto-expires entries.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Session } from '../../../renderer/types';
import {
	markWorktreePathAsRecentlyCreated,
	clearRecentlyCreatedWorktreePath,
	isRecentlyCreatedWorktreePath,
	normalizePath,
	sessionMatchesWorktreeRoot,
} from '../../../renderer/utils/worktreeDedup';

describe('worktreeDedup', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		// Clean up any marked paths by advancing past TTL
		vi.advanceTimersByTime(20000);
		vi.useRealTimers();
	});

	it('marks a path as recently created', () => {
		markWorktreePathAsRecentlyCreated('/projects/worktrees/feature-x');
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/feature-x')).toBe(true);
	});

	it('returns false for unmarked paths', () => {
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/nonexistent')).toBe(false);
	});

	it('normalizes paths for comparison (trailing slashes)', () => {
		markWorktreePathAsRecentlyCreated('/projects/worktrees/feature-x/');
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/feature-x')).toBe(true);
	});

	it('normalizes paths for comparison (backslashes)', () => {
		markWorktreePathAsRecentlyCreated('C:\\projects\\worktrees\\feature-x');
		expect(isRecentlyCreatedWorktreePath('C:/projects/worktrees/feature-x')).toBe(true);
	});

	it('normalizes paths for comparison (duplicate slashes)', () => {
		markWorktreePathAsRecentlyCreated('/projects//worktrees///feature-x');
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/feature-x')).toBe(true);
	});

	it('clears a previously marked path', () => {
		markWorktreePathAsRecentlyCreated('/projects/worktrees/to-clear');
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/to-clear')).toBe(true);

		clearRecentlyCreatedWorktreePath('/projects/worktrees/to-clear');
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/to-clear')).toBe(false);
	});

	it('auto-expires after TTL (default 10s)', () => {
		markWorktreePathAsRecentlyCreated('/projects/worktrees/ttl-test');
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/ttl-test')).toBe(true);

		// Just before TTL
		vi.advanceTimersByTime(9999);
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/ttl-test')).toBe(true);

		// At TTL
		vi.advanceTimersByTime(1);
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/ttl-test')).toBe(false);
	});

	it('supports custom TTL', () => {
		markWorktreePathAsRecentlyCreated('/projects/worktrees/custom-ttl', 5000);
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/custom-ttl')).toBe(true);

		vi.advanceTimersByTime(5000);
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/custom-ttl')).toBe(false);
	});

	it('handles multiple concurrent paths independently', () => {
		markWorktreePathAsRecentlyCreated('/projects/worktrees/a');
		markWorktreePathAsRecentlyCreated('/projects/worktrees/b');

		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/a')).toBe(true);
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/b')).toBe(true);

		clearRecentlyCreatedWorktreePath('/projects/worktrees/a');
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/a')).toBe(false);
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/b')).toBe(true);
	});

	it('re-marking a path resets the TTL timer', () => {
		markWorktreePathAsRecentlyCreated('/projects/worktrees/remark', 10000);

		// Advance 8s (within original TTL)
		vi.advanceTimersByTime(8000);
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/remark')).toBe(true);

		// Re-mark — should reset the 10s TTL
		markWorktreePathAsRecentlyCreated('/projects/worktrees/remark', 10000);

		// Advance another 8s (16s total, past original TTL but within re-marked TTL)
		vi.advanceTimersByTime(8000);
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/remark')).toBe(true);

		// Advance past re-marked TTL
		vi.advanceTimersByTime(2001);
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/remark')).toBe(false);
	});

	it('clearRecentlyCreatedWorktreePath cancels pending timer', () => {
		markWorktreePathAsRecentlyCreated('/projects/worktrees/clear-timer', 10000);
		clearRecentlyCreatedWorktreePath('/projects/worktrees/clear-timer');

		// Re-mark with a short TTL
		markWorktreePathAsRecentlyCreated('/projects/worktrees/clear-timer', 5000);

		// Advance past original TTL but within new TTL — should still be present
		// (old timer was cleared, only new 5s timer exists)
		vi.advanceTimersByTime(4999);
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/clear-timer')).toBe(true);

		vi.advanceTimersByTime(1);
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/clear-timer')).toBe(false);
	});
});

describe('normalizePath', () => {
	it('converts backslashes to forward slashes', () => {
		expect(normalizePath('C:\\Users\\test\\repo')).toBe('C:/Users/test/repo');
	});

	it('collapses duplicate slashes', () => {
		expect(normalizePath('/a//b///c')).toBe('/a/b/c');
	});

	it('strips trailing slash', () => {
		expect(normalizePath('/projects/worktrees/feature/')).toBe('/projects/worktrees/feature');
	});

	it('handles mixed separators, duplicates, and trailing slash together', () => {
		expect(normalizePath('C:\\Users//test\\\\repo/')).toBe('C:/Users/test/repo');
	});

	it('returns empty string unchanged', () => {
		expect(normalizePath('')).toBe('');
	});
});

describe('sessionMatchesWorktreeRoot', () => {
	const root = '/projects/worktrees/feature-x';

	function makeSession(overrides: Partial<Session>): Session {
		return {
			id: 'sess-1',
			cwd: '',
			...overrides,
		} as Session;
	}

	it('matches on projectRoot exact equality', () => {
		const s = makeSession({ projectRoot: root, cwd: '/elsewhere' });
		expect(sessionMatchesWorktreeRoot(s, root)).toBe(true);
	});

	it('matches on cwd exact equality when projectRoot is unset', () => {
		const s = makeSession({ cwd: root });
		expect(sessionMatchesWorktreeRoot(s, root)).toBe(true);
	});

	it('matches projectRoot with trailing slash via normalization', () => {
		const s = makeSession({ projectRoot: `${root}/`, cwd: '/elsewhere' });
		expect(sessionMatchesWorktreeRoot(s, root)).toBe(true);
	});

	it('matches projectRoot with backslashes via normalization', () => {
		const s = makeSession({ projectRoot: 'C:\\projects\\worktrees\\feature-x' });
		expect(sessionMatchesWorktreeRoot(s, 'C:/projects/worktrees/feature-x')).toBe(true);
	});

	it('does NOT match a session whose cwd is a subdir of the worktree root', () => {
		// projectRoot fallback exists precisely so this case still matches via
		// projectRoot — but if projectRoot is missing, cwd-only must NOT match.
		const s = makeSession({ cwd: `${root}/src/components` });
		expect(sessionMatchesWorktreeRoot(s, root)).toBe(false);
	});

	it('matches via projectRoot even when cwd has drifted into a subdir', () => {
		const s = makeSession({ projectRoot: root, cwd: `${root}/src/components` });
		expect(sessionMatchesWorktreeRoot(s, root)).toBe(true);
	});

	it('returns false when neither projectRoot nor cwd is set', () => {
		const s = makeSession({ cwd: '' });
		expect(sessionMatchesWorktreeRoot(s, root)).toBe(false);
	});

	it('returns false for a different worktree root', () => {
		const s = makeSession({ projectRoot: '/projects/worktrees/other' });
		expect(sessionMatchesWorktreeRoot(s, root)).toBe(false);
	});
});
