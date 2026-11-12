/**
 * Normalize a worktree path for equality checks across process and platform
 * boundaries. This does not resolve relative paths; callers that operate on a
 * local filesystem must resolve them against the same cwd used by Git first.
 */
export function normalizeWorktreePath(path: string, posix = false): string {
	// SSH paths preserve literal backslashes. Local UNC paths retain their
	// semantic double separator; ordinary redundant separators collapse.
	const hasUncPrefix = !posix && /^[\\/]{2}[^\\/]/.test(path);
	const separated = posix ? path : path.replace(/\\/g, '/');
	const collapsed = separated.replace(/\/+/g, '/');
	const normalized = hasUncPrefix ? `/${collapsed}` : collapsed;
	if (normalized === '/' || (!posix && /^[A-Za-z]:\/$/.test(normalized))) return normalized;
	return normalized.replace(/\/+$/, '');
}

/** Compare POSIX worktree prefixes without matching similarly named siblings. */
export function isPathAtOrUnderRoot(path: string, root: string): boolean {
	const candidate = normalizeWorktreePath(path, true);
	const base = normalizeWorktreePath(root, true);
	return candidate === base || candidate.startsWith(base === '/' ? '/' : `${base}/`);
}
