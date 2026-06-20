/**
 * @file worktreeDedup.test.ts
 * @description Unit tests for the shared worktree dedup mechanism.
 *
 * Verifies that paths can be marked as recently created and checked,
 * that clearing works, and that the TTL auto-expires entries.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
	markWorktreePathAsRecentlyCreated,
	clearRecentlyCreatedWorktreePath,
	isRecentlyCreatedWorktreePath,
} from '../../renderer/utils/worktreeDedup';

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

	it('clearing an unmarked path is a no-op', () => {
		clearRecentlyCreatedWorktreePath('/projects/worktrees/not-marked');

		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/not-marked')).toBe(false);
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

		// Re-mark - should reset the 10s TTL
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

		// Advance past original TTL but within new TTL - should still be present
		// (old timer was cleared, only new 5s timer exists)
		vi.advanceTimersByTime(4999);
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/clear-timer')).toBe(true);

		vi.advanceTimersByTime(1);
		expect(isRecentlyCreatedWorktreePath('/projects/worktrees/clear-timer')).toBe(false);
	});
});
