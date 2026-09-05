/**
 * Normalize a worktree path for equality checks across process and platform
 * boundaries. This does not resolve relative paths; callers that operate on a
 * local filesystem must resolve them against the same cwd used by Git first.
 */
export function normalizeWorktreePath(path: string): string {
	// A UNC path's leading double separator is semantic: `\\server\share`
	// must remain distinct from the drive-rooted `\server\share`. Collapse
	// redundant separators everywhere else, then restore that UNC prefix.
	const hasUncPrefix = /^[\\/]{2}[^\\/]/.test(path);
	const collapsed = path.replace(/\\/g, '/').replace(/\/+/g, '/');
	const normalized = hasUncPrefix ? `/${collapsed}` : collapsed;
	if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
	return normalized.replace(/\/+$/, '');
}
