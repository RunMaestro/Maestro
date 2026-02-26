/**
 * Shared dedup mechanism for worktree paths.
 *
 * When creating a worktree, the path is marked here BEFORE the directory is
 * created on disk. The file watcher in useWorktreeHandlers checks this set
 * to avoid creating a duplicate session for a worktree that was just created
 * programmatically (e.g., by useAutoRunHandlers or useWorktreeHandlers).
 *
 * Module-level so both hooks can share the same Set without prop drilling.
 */

function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

const recentlyCreatedPaths = new Set<string>();

/**
 * Mark a worktree path as recently created. The file watcher will skip
 * it for `ttlMs` milliseconds to avoid duplicate session creation.
 */
export function markWorktreePathAsRecentlyCreated(path: string, ttlMs = 10000): void {
	const normalized = normalizePath(path);
	recentlyCreatedPaths.add(normalized);
	setTimeout(() => recentlyCreatedPaths.delete(normalized), ttlMs);
}

/**
 * Remove a path from the recently-created set (e.g., on creation failure).
 */
export function clearRecentlyCreatedWorktreePath(path: string): void {
	recentlyCreatedPaths.delete(normalizePath(path));
}

/**
 * Check if a path was recently created programmatically.
 */
export function isRecentlyCreatedWorktreePath(path: string): boolean {
	return recentlyCreatedPaths.has(normalizePath(path));
}
