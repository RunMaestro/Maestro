/**
 * Tests for the main-process "Maestro created this worktree" registry.
 *
 * The mark is what stops `worktree:discovered` from being broadcast for a
 * worktree Maestro just created itself. Without it every renderer that receives
 * the broadcast - each Electron window and every connected web-desktop client -
 * mints its own child agent at the same path under the same parent (issue #1506).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	markWorktreeCreatedByMaestro,
	clearWorktreeCreatedByMaestro,
	isWorktreeCreatedByMaestro,
	clearWorktreeCreationMarks,
	WORKTREE_CREATION_MARK_TTL_MS,
} from '../../../../../main/ipc/handlers/git/worktreeCreationMarks';

describe('worktreeCreationMarks', () => {
	beforeEach(() => {
		clearWorktreeCreationMarks();
	});

	afterEach(() => {
		vi.useRealTimers();
		clearWorktreeCreationMarks();
	});

	it('reports an unmarked path as not created by Maestro', () => {
		expect(isWorktreeCreatedByMaestro('/worktrees/feature')).toBe(false);
	});

	it('reports a marked path as created by Maestro', () => {
		markWorktreeCreatedByMaestro('/worktrees/feature');
		expect(isWorktreeCreatedByMaestro('/worktrees/feature')).toBe(true);
	});

	it('does not match a different path', () => {
		markWorktreeCreatedByMaestro('/worktrees/feature');
		expect(isWorktreeCreatedByMaestro('/worktrees/other')).toBe(false);
	});

	it('can release a mark after setup fails', () => {
		markWorktreeCreatedByMaestro('/worktrees/feature');
		clearWorktreeCreatedByMaestro('/worktrees/feature/');
		expect(isWorktreeCreatedByMaestro('/worktrees/feature')).toBe(false);
	});

	it('matches across separator and trailing-slash spellings', () => {
		// The renderer asks for `<basePath>/<branch>`; chokidar reports whatever
		// the OS hands back. A trailing slash or a doubled separator must not make
		// the same directory look like a different one.
		markWorktreeCreatedByMaestro('/worktrees/feature');
		expect(isWorktreeCreatedByMaestro('/worktrees/feature/')).toBe(true);
		expect(isWorktreeCreatedByMaestro('/worktrees//feature')).toBe(true);
	});

	it('does not collapse the filesystem root to an empty key', () => {
		markWorktreeCreatedByMaestro('/');
		expect(isWorktreeCreatedByMaestro('/')).toBe(true);
		expect(isWorktreeCreatedByMaestro('/worktrees/feature')).toBe(false);
	});

	it('ignores an empty path on both sides', () => {
		markWorktreeCreatedByMaestro('');
		expect(isWorktreeCreatedByMaestro('')).toBe(false);
	});

	it('expires the mark after its TTL', () => {
		vi.useFakeTimers();
		markWorktreeCreatedByMaestro('/worktrees/feature');
		expect(isWorktreeCreatedByMaestro('/worktrees/feature')).toBe(true);

		vi.advanceTimersByTime(WORKTREE_CREATION_MARK_TTL_MS + 1);
		expect(isWorktreeCreatedByMaestro('/worktrees/feature')).toBe(false);
	});

	it('honours an explicit TTL', () => {
		vi.useFakeTimers();
		markWorktreeCreatedByMaestro('/worktrees/feature', 1000);

		vi.advanceTimersByTime(999);
		expect(isWorktreeCreatedByMaestro('/worktrees/feature')).toBe(true);

		vi.advanceTimersByTime(2);
		expect(isWorktreeCreatedByMaestro('/worktrees/feature')).toBe(false);
	});

	it('re-marking extends the window rather than keeping the old expiry', () => {
		vi.useFakeTimers();
		markWorktreeCreatedByMaestro('/worktrees/feature', 1000);
		vi.advanceTimersByTime(900);
		markWorktreeCreatedByMaestro('/worktrees/feature', 1000);

		vi.advanceTimersByTime(500);
		expect(isWorktreeCreatedByMaestro('/worktrees/feature')).toBe(true);
	});
});
