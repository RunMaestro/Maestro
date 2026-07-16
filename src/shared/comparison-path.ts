/**
 * String-only path normalization for equality and prefix comparisons.
 *
 * These helpers intentionally do not call `path.resolve`, `path.normalize`,
 * `realpath`, or the filesystem. Dot segments, symlink-shaped paths, and remote
 * paths therefore remain lexical values. Callers choose their named policy:
 * worktree matching preserves case and collapses duplicate separators; Copilot
 * metadata matching folds drive-letter paths while preserving UNC separators.
 */

/** Normalize a worktree path for lexical comparison without changing its case. */
export function normalizeWorktreePathForComparison(value: string): string {
	return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

/**
 * Normalize a Copilot metadata path for lexical comparison.
 *
 * Only drive-letter paths are case-folded because Copilot local metadata may
 * describe a Windows volume. POSIX and remote paths retain their case.
 */
export function normalizeCopilotPathForComparison(value?: string): string | null {
	if (!value) return null;

	let normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
	if (!normalized && value === '/') normalized = '/';
	return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}
