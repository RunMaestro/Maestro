/**
 * Shared dedup + path-matching helpers for worktree sessions.
 *
 * Two concerns live here so consumers don't reimplement them:
 * 1. A TTL-bounded Set of recently-created worktree paths used by the file
 *    watcher in useWorktreeHandlers to avoid duplicate session creation when
 *    a worktree was just created programmatically.
 * 2. Path-matching primitives (`normalizePath`, `sessionMatchesWorktreeRoot`)
 *    used by both useWorktreeHandlers and useAutoRunHandlers to locate an
 *    existing session for a given worktree root.
 */

import type { Session } from '../types';

/** Normalize a file path for comparison: forward slashes, no duplicate or trailing slashes. */
export function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

/**
 * Match a session against a worktree root path. We check both `projectRoot`
 * (the stable worktree root captured at session creation) and `cwd` (which
 * may drift if the user `cd`s into a subdirectory of the worktree). Without
 * the projectRoot fallback, a child session that has navigated into a subdir
 * is missed and the recovery flow builds a duplicate session for the same
 * worktree.
 */
export function sessionMatchesWorktreeRoot(session: Session, normalizedRoot: string): boolean {
	if (session.projectRoot && normalizePath(session.projectRoot) === normalizedRoot) return true;
	if (session.cwd && normalizePath(session.cwd) === normalizedRoot) return true;
	return false;
}

const recentlyCreatedPaths = new Set<string>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Mark a worktree path as recently created. The file watcher will skip
 * it for `ttlMs` milliseconds to avoid duplicate session creation.
 */
export function markWorktreePathAsRecentlyCreated(path: string, ttlMs = 10000): void {
	const normalized = normalizePath(path);
	recentlyCreatedPaths.add(normalized);

	// Reset any existing timer so re-marking extends the TTL
	const existingTimer = cleanupTimers.get(normalized);
	if (existingTimer) {
		clearTimeout(existingTimer);
	}

	const timer = setTimeout(() => {
		recentlyCreatedPaths.delete(normalized);
		cleanupTimers.delete(normalized);
	}, ttlMs);
	cleanupTimers.set(normalized, timer);
}

/**
 * Remove a path from the recently-created set (e.g., on creation failure).
 */
export function clearRecentlyCreatedWorktreePath(path: string): void {
	const normalized = normalizePath(path);
	recentlyCreatedPaths.delete(normalized);

	const timer = cleanupTimers.get(normalized);
	if (timer) {
		clearTimeout(timer);
		cleanupTimers.delete(normalized);
	}
}

/**
 * Check if a path was recently created programmatically.
 */
export function isRecentlyCreatedWorktreePath(path: string): boolean {
	return recentlyCreatedPaths.has(normalizePath(path));
}
