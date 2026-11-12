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
	return ignoreUnderRoot(root);
}

export interface WatchIgnoreOptions {
	/**
	 * Directory names skipped at any depth below the root (dependency and cache
	 * trees such as `node_modules`). Compared case-insensitively.
	 */
	skipDirNames?: readonly string[];
	/**
	 * When set, a FILE whose name ends in none of these (lowercase, with the
	 * dot: `.md`) is ignored. Directories are still walked, so a matching file
	 * deeper down is still seen.
	 */
	onlyFileExtensions?: readonly string[];
}

/** The `stats` chokidar passes once it has stat'ed a path; absent on the first check. */
type WatchStats = { isFile(): boolean };

/**
 * chokidar `ignored` matcher scoped to what lies BELOW `root` (see
 * {@link ignoreDotfilesUnder} for why the root itself must never count).
 *
 * The extra options exist because what a watcher walks is paid for on the
 * Electron main thread, and on Windows chokidar holds one `fs.watch` handle per
 * directory and file it keeps (macOS shares a single FSEvents stream, so the
 * same tree is cheap there). An Auto Run folder that holds a project checkout
 * walked every `node_modules` entry and watched every source file, only to
 * discard all events but `.md`: tens of thousands of handles, and minutes of a
 * main thread too busy to answer IPC. Skipping those trees and the files the
 * watcher would throw away anyway keeps the walk proportional to what it reports.
 */
export function ignoreUnderRoot(
	root: string,
	options: WatchIgnoreOptions = {}
): (testPath: string, stats?: WatchStats) => boolean {
	const skipDirs = new Set((options.skipDirNames ?? []).map((name) => name.toLowerCase()));
	const extensions = options.onlyFileExtensions;
	return (testPath, stats) => {
		const rel = path.relative(root, testPath);
		if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
			return false;
		}
		if (DOTFILE_SEGMENT.test(rel)) return true;
		if (skipDirs.size > 0) {
			for (const segment of rel.split(/[/\\]/)) {
				if (skipDirs.has(segment.toLowerCase())) return true;
			}
		}
		if (extensions && stats?.isFile()) {
			const lower = testPath.toLowerCase();
			return !extensions.some((ext) => lower.endsWith(ext));
		}
		return false;
	};
}
