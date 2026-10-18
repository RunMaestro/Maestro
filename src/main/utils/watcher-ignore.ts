/**
 * Shared ignore patterns for recursive file watchers (chokidar).
 *
 * Windows places a handful of always-locked system files at drive roots
 * (pagefile.sys, hiberfil.sys, swapfile.sys, DumpStack.log.tmp, System
 * Volume Information). When a user points Maestro at a drive root - or
 * a path that transitively symlinks to one - chokidar's initial walk
 * hits `EBUSY: resource busy or locked` on each lstat. See MAESTRO-G5/G6.
 *
 * These files can never be meaningfully watched, so skip them everywhere
 * that builds a recursive watch tree.
 */

import path from 'path';

/** Windows drive-root system files that always fail lstat with EBUSY. */
export const WINDOWS_LOCKED_SYSTEM_FILES: RegExp = new RegExp(
	'(^|[/\\\\])(pagefile\\.sys|hiberfil\\.sys|swapfile\\.sys|DumpStack\\.log(\\.tmp)?|System Volume Information)$',
	'i'
);

const DOTFILE_SEGMENT = /(^|[/\\])\./;

/**
 * chokidar `ignored` matcher for dotfiles and dot-directories BELOW `root`.
 *
 * chokidar tests `ignored` against the ABSOLUTE path, so the bare
 * `/(^|[/\\])\../` regex also matches every file under a watched root that
 * itself sits inside a dot-directory: `/repo/.maestro/playbooks/a.md` matches
 * on `.maestro`, and the watcher silently reports nothing. The Auto Run folder
 * lives at `.maestro/playbooks` by default, so its live updates never arrived.
 * Only the part of the path under `root` decides; the root and its ancestors
 * never count.
 */
export function ignoreDotfilesUnder(root: string): (testPath: string) => boolean {
	return (testPath) => {
		const rel = path.relative(root, testPath);
		if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
			return false;
		}
		return DOTFILE_SEGMENT.test(rel);
	};
}
