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
import { shouldOpenExternally } from './fileExplorer';

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
	if (!/^file:\/\//.test(href)) return false;

	const path = href.replace(/^file:\/\//, '');
	if (onFileClick && !shouldOpenExternally(getBasename(path))) {
		onFileClick(path);
		return true;
	}

	void window.maestro.shell.openPath(path);
	return true;
}
