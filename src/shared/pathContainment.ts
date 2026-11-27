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

/**
 * HFS+ skips format characters (zero-width joiners, bidi controls, the byte order mark) when it compares
 * names, as git's `next_hfs_char()` does, so a `.git` with one inside is still `.git` there. All of them
 * are in category Cf, which also covers a few more that no file system skips: folding those too only
 * widens what is detected.
 */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/**
 * One path segment reduced to the name a file system may open it as, for DETECTING a name that no spelling
 * may reach. Dropped: the format characters HFS+ skips, an NTFS stream suffix (`.git::$INDEX_ALLOCATION` is
 * the folder `.git`), and trailing dots and spaces (Windows opens `.git.` and `.git ` as `.git`). Case is
 * folded by an upper-case round trip, which also joins U+017F (long s) to `s` the way APFS does.
 *
 * It folds on EVERY platform, because the file that carries an untrusted path is read on one machine and
 * written on another. That is also why it must never ACCEPT a name: on Linux `Prompts` and `prompts` are two
 * folders. For comparing two real paths on the running platform use `foldPathCase()` in
 * `src/main/utils/real-path-containment.ts`.
 */
export function foldPathSegment(segment: string): string {
	return segment
		.replace(FORMAT_CHARACTERS, '')
		.replace(/:[\s\S]*$/, '')
		.replace(/[. ]+$/, '')
		.toUpperCase()
		.toLowerCase();
}

/**
 * Whether any segment of `relativePath` would open as a repository's `.git` folder: `.git` in any case, with
 * trailing dots or spaces, as an NTFS stream, with a zero-width code point inside, or as its NTFS short name
 * `git~1`. These are the spellings git itself refuses to check out. A file written under such a segment can
 * be a hook that runs on the project's next git command, so a path an outsider supplies must not contain one.
 * Both `/` and `\` separate segments, as in {@link normalizeRootRelativePath}.
 */
export function hasGitMetadataSegment(relativePath: string): boolean {
	return relativePath.split(/[/\\]/).some((segment) => {
		const name = foldPathSegment(segment);
		return name === '.git' || name === 'git~1';
	});
}
