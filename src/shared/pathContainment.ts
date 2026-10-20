/**
 * Lexical containment for UNTRUSTED relative paths: whether a path, read beneath some root, stays inside that
 * root once `.` and `..` are collapsed. Pure string work with no `path` or `fs` import, so main, the renderer,
 * the CLI, and a sandboxed guest page all run the same check.
 *
 * It refuses rather than guesses. Both `/` and `\` separate segments on every platform. A path that is
 * absolute anywhere (`/x`, `\x`, `\\server\share`, `C:\x`, and drive-relative `C:x`) is outside. So is a
 * segment made only of dots and spaces other than `.` and `..`, because Windows trims trailing dots and
 * spaces and can read `.. ` as `..`.
 *
 * Lexical only: it cannot see symlinks. Code that then touches the file system resolves the real path in
 * main and checks again.
 *
 * Not `isPathAtOrUnderRoot()` in `src/shared/worktreePaths.ts` (trusted worktree paths, no `..` collapse),
 * and not the CLI's `isPathInside()` in `src/cli/utils/owning-agent.ts` (absolute paths through Node's
 * `path`).
 */

/** A drive-qualified Windows path: `C:\x`, `C:/x`, and the drive-relative `C:x`. */
const DRIVE_PREFIX = /^[A-Za-z]:/;

/** A segment Windows could trim into `.` or `..`: only dots and spaces (`.` and `..` are handled first). */
const DOTS_AND_SPACES = /^[. ]+$/;

/**
 * `relativePath` normalized beneath a root: `/` separators, no `.` segments, `..` collapsed, and no leading,
 * trailing, or doubled separator. `''` is the root itself. Null when the path could name something outside
 * the root: absolute or drive-qualified, a `..` that climbs above the root, a NUL byte, or a segment of dots
 * and spaces.
 */
export function normalizeRootRelativePath(relativePath: string): string | null {
	if (
		relativePath.includes('\0') ||
		/^[/\\]/.test(relativePath) ||
		DRIVE_PREFIX.test(relativePath)
	) {
		return null;
	}
	const segments: string[] = [];
	for (const segment of relativePath.split(/[/\\]/)) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			if (segments.length === 0) return null;
			segments.pop();
			continue;
		}
		if (DOTS_AND_SPACES.test(segment)) return null;
		segments.push(segment);
	}
	return segments.join('/');
}

/**
 * Whether `relativePath`, read beneath a root, stays inside it (the root itself included). See
 * {@link normalizeRootRelativePath}, which also returns the normalized path.
 */
export function isPathInsideRoot(relativePath: string): boolean {
	return normalizeRootRelativePath(relativePath) !== null;
}
