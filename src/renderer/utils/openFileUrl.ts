/**
 * Opening a `file://` link clicked in rendered markdown.
 *
 * These links are what the file-link plugins emit for a path OUTSIDE the
 * project root (`remarkFileLinks`, `markdownItAdapter`); a path inside it
 * becomes a `maestro-file://` link instead. The AI can also write a literal
 * `file://` link of its own, so this is not only a generated shape.
 *
 * Historically every one of them went straight to `shell.openPath`, which is
 * right for a PDF and wrong for everything Maestro renders better itself: a
 * JSON, a log, a config, a source file, or an MP3 handed to the OS pops a
 * second application over the top of the workspace to do something the file
 * preview (or the floating player) already does. Being outside the project
 * root is not a reason to eject the user from the app.
 *
 * The routing question is the same one the file tree already answers, so this
 * asks `shouldOpenExternally()` - the single policy for "the OS owns this file
 * type" (PDFs, Office docs, archives, binaries, formats Chromium cannot
 * decode). Anything else goes back through the caller's file-click handler,
 * which funnels into `handleOpenFileTab` - the choke point that opens a
 * preview tab and diverts playable media to the floating player.
 */

import { getBasename } from '../../shared/formatters';
import { safeDecodeURIComponent } from '../../shared/stringUtils';
import { shouldOpenExternally } from './fileExplorer';

/**
 * The filesystem path behind a `file://` href, or null when the href is not
 * one.
 *
 * Percent-decoding is NOT optional. A `file://` href is a URL, so every
 * producer reaching this point has already encoded it: an agent writes
 * `file:///a/Voice%20Cloning/x.wav` by hand, and mdast-util-to-hast runs
 * every link destination through `normalizeUri` besides. Handing that
 * literal string to `fs.readFile` is an ENOENT, which the file-click handler
 * reports by returning - so the click silently does nothing for any path
 * containing a space, a `#`, or a non-ASCII character. Same rule, same
 * reason as `resolveLocalImagePath` in Markdown/components/LocalImage.tsx.
 *
 * A Windows file URL puts a slash before the drive (`file:///D:/a.png`), so
 * stripping the scheme leaves `/D:/a.png`. Windows resolves that against the
 * current drive and the read fails, so the slash before a drive letter goes.
 */
export function fileUrlToPath(href: string): string | null {
	if (!/^file:\/\//.test(href)) return null;
	const path = safeDecodeURIComponent(href.replace(/^file:\/\//, ''));
	return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

/**
 * The `file://` URL for a Windows drive-absolute path (`D:\a.png` or
 * `D:/a.png`), or null when the path has no drive letter.
 *
 * Markdown URL sanitizers read `D:` as a URL scheme they do not know and blank
 * it, so an image written with a bare Windows path never renders. As a
 * `file:///D:/a.png` URL it passes them, and `fileUrlToPath` turns it back.
 */
export function windowsDrivePathToFileUrl(path: string): string | null {
	if (!/^[A-Za-z]:[\\/]/.test(path)) return null;
	return `file:///${path.replace(/\\/g, '/')}`;
}

/**
 * The `file://` URL for an absolute path on this machine, the inverse of
 * `fileUrlToPath`. Each segment is percent-encoded so spaces and reserved
 * characters survive; a Windows drive keeps its colon (`file:///D:/a%20b.html`).
 *
 * A backslash separates segments in a Windows path only. A path that starts
 * with `/` is POSIX, where a backslash is a character in a file name, so it is
 * kept and encoded (`/tmp/a\b.html` is `file:///tmp/a%5Cb.html`).
 */
export function pathToFileUrl(path: string): string {
	const normalized = path.startsWith('/') ? path : path.replace(/\\/g, '/');
	const isWindowsDrivePath = /^[A-Za-z]:/.test(normalized);
	const rooted = isWindowsDrivePath || !normalized.startsWith('/') ? `/${normalized}` : normalized;
	const encoded = rooted
		.split('/')
		.map((seg, index) => (isWindowsDrivePath && index === 1 ? seg : encodeURIComponent(seg)))
		.join('/');
	return `file://${encoded}`;
}

/**
 * Handle a clicked `file://` href.
 *
 * @param href The link target. Anything that is not `file://` is ignored.
 * @param onFileClick The surface's file-click handler, which resolves the path
 *   and routes it through the normal open path. Previewable files fall back to
 *   the OS when a surface has none.
 * @returns Whether the href was handled, so callers can `return` on true.
 */
export function openFileUrl(href: string, onFileClick?: (path: string) => void): boolean {
	const path = fileUrlToPath(href);
	if (path === null) return false;

	if (onFileClick && !shouldOpenExternally(getBasename(path))) {
		onFileClick(path);
		return true;
	}

	void window.maestro.shell.openPath(path);
	return true;
}
