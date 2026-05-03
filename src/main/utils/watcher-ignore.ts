/**
 * Shared ignore patterns for recursive file watchers (chokidar).
 *
 * Windows places a handful of always-locked system files at drive roots
 * (pagefile.sys, hiberfil.sys, swapfile.sys, DumpStack.log.tmp, System
 * Volume Information). When a user points Maestro at a drive root — or
 * a path that transitively symlinks to one — chokidar's initial walk
 * hits `EBUSY: resource busy or locked` on each lstat. See MAESTRO-G5/G6.
 *
 * These files can never be meaningfully watched, so skip them everywhere
 * that builds a recursive watch tree.
 */

/** Windows drive-root system files that always fail lstat with EBUSY. */
export const WINDOWS_LOCKED_SYSTEM_FILES: RegExp = new RegExp(
	'(^|[/\\\\])(pagefile\\.sys|hiberfil\\.sys|swapfile\\.sys|DumpStack\\.log(\\.tmp)?|System Volume Information)$',
	'i'
);
