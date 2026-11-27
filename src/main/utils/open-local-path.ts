/**
 * Opening a local file or folder that a caller named, with the OS default app.
 *
 * The paths the renderer, the web bridge and plugins hand to the OS end here:
 * `file://` links in chat, the Files panel "Open in Default App", an absolute
 * path that reached `shell:openExternal` (the Open PR button with a path for a
 * URL), and a plugin's `file:` URL. To "open" an app bundle, a script or an
 * installer is to RUN it, so one click on a link that an agent (or a page it
 * read) wrote could launch a program. A launchable target is revealed in the
 * file manager instead. The user sees the file and can still run it on purpose.
 *
 * Launches the host chooses (the Lite pairing window opening Tailscale) call
 * `shell.openPath` directly and do not come through here.
 */

import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { shell, type OpenExternalOptions } from 'electron';
import { isLaunchableFile } from '../../shared/fileCategories';
import { isLinux, isWindows } from '../../shared/platformDetection';
import { logger } from './logger';

/**
 * `shell.openPath` that always settles.
 *
 * On Linux, Electron's `platform_util::OpenPath` launches `xdg-open` with
 * `wait_for_exit = false` and never runs its completion callback, so the promise
 * `shell.openPath` returns there never resolves (Electron 41,
 * `shell/common/platform_util_linux.cc`). An IPC handler that awaits it never
 * replies; once the pending invoke is garbage-collected the renderer gets
 * "Error invoking remote method 'shell:openPath': reply was never sent"
 * (MAESTRO-QH, Linux only). Linux reports nothing either way, so there it is
 * fired and reported as launched; macOS and Windows still return the real
 * error message.
 */
function openPathSettled(target: string): Promise<string> {
	if (isLinux()) {
		void shell.openPath(target);
		return Promise.resolve('');
	}
	return shell.openPath(target);
}

/**
 * Whether opening `target` would run, install or mount something. True when
 * the name of the path, or of what it resolves to (a symlink to an app), is
 * launchable (`isLaunchableFile()`), or when, on POSIX, it resolves to a
 * regular file with an executable bit (a script or a binary with no telling
 * extension). A directory's search bit does not count.
 *
 * A path that cannot be inspected counts as launchable: to reveal a file is
 * always safe, to open it is not.
 */
export function isLaunchableLocalPath(target: string): boolean {
	if (isLaunchableFile(target)) return true;
	try {
		const realPath = fs.realpathSync(target);
		if (isLaunchableFile(realPath)) return true;
		if (isWindows()) return false;
		const stat = fs.statSync(realPath);
		return stat.isFile() && (stat.mode & 0o111) !== 0;
	} catch {
		return true;
	}
}

/**
 * Open a local file or folder in its default app, as a click on a link to it
 * should: a launchable target (`isLaunchableLocalPath()`) is revealed in the
 * file manager and never opened. Resolves to the error message from
 * `shell.openPath`, or `''` on success (a reveal always succeeds).
 */
export function openLocalPath(target: string): Promise<string> {
	if (isLaunchableLocalPath(target)) {
		logger.warn(`Revealed instead of opened (the OS would run or install it): ${target}`, 'Shell');
		shell.showItemInFolder(target);
		return Promise.resolve('');
	}
	return openPathSettled(target);
}

/**
 * Hand a URL to the OS, for a caller that has already decided the URL may be
 * opened (the plugin broker's `shell:openExternal` grant). A `file:` URL opens
 * through `openLocalPath()`, so an app, script or installer is revealed and
 * never run. Any other URL goes to `shell.openExternal` in the form it was
 * checked in (`URL.href`), so the OS cannot read a different URL.
 *
 * Refuses, and opens nothing for, a URL that does not parse and a `file:` URL
 * that names no local path (one with a host, or with an encoded separator).
 */
export async function openExternalUrl(url: string, options?: OpenExternalOptions): Promise<void> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Refused to open a URL that does not parse: ${url}`);
	}
	if (parsed.protocol !== 'file:') {
		await shell.openExternal(parsed.href, options);
		return;
	}
	if (parsed.hostname !== '') {
		throw new Error(`Refused to open a file on another host: ${parsed.hostname}`);
	}
	// Throws for an encoded separator (`%2F`) and, on Windows, a path with no drive.
	const errorMessage = await openLocalPath(fileURLToPath(parsed));
	if (errorMessage) throw new Error(errorMessage);
}
