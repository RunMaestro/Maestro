/**
 * Normalize a worktree path for equality checks across process and platform
 * boundaries. This does not resolve relative paths; callers that operate on a
 * local filesystem must resolve them against the same cwd used by Git first.
 */
export function normalizeWorktreePath(path: string): string {
	const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
	if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
	return normalized.replace(/\/+$/, '');
}
