/**
 * Window icon for Linux.
 *
 * macOS and Windows read the app icon out of the bundle (`.icns` / the exe's
 * embedded `.ico`), so a BrowserWindow there needs no `icon` option. Linux has
 * no such thing: an ELF binary carries no icon, so unless the window sets one
 * the desktop can only find it by matching the window to an installed
 * `.desktop` entry. An AppImage has no installed entry at all, and a deb/rpm
 * only matches when `desktopName` lines up with `StartupWMClass` (see
 * `desktopName` + `build.linux.syncDesktopName` in package.json). Without this
 * the window and its taskbar entry draw the generic Electron/gear icon.
 *
 * - Packaged: `build/icon.png` ships via `linux.extraResources` as
 *   `<resources>/icon.png`.
 * - Dev: the repo's `build/icon.png` (this file compiles to
 *   `dist/main/app-lifecycle/app-icon.js`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { isLinux } from '../../shared/platformDetection';

export const LINUX_ICON_FILENAME = 'icon.png';

/** Absolute path to the window icon on Linux, or undefined elsewhere / when absent. */
export function resolveLinuxWindowIconPath(): string | undefined {
	if (!isLinux()) return undefined;
	const candidates: string[] = [];
	if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
		candidates.push(path.join(process.resourcesPath, LINUX_ICON_FILENAME));
	}
	candidates.push(path.resolve(__dirname, '..', '..', '..', 'build', LINUX_ICON_FILENAME));
	return candidates.find((candidate) => fs.existsSync(candidate));
}
