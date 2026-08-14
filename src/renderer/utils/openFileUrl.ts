/**
 * Opening a `file://` link clicked in rendered markdown.
 *
 * These links are what the file-link plugins emit for a path OUTSIDE the
 * project root (`remarkFileLinks`, `markdownItAdapter`); a path inside it
 * becomes a `maestro-file://` link instead. The AI can also write a literal
 * `file://` link of its own, so this is not only a generated shape.
 *
 * Historically every one of them went straight to `shell.openPath`, which is
 * right for a PDF and wrong for media: Maestro has its own player, and handing
 * an MP3 to the OS pops a second application over the top of the workspace to
 * do something Maestro already does better. Media is routed back through the
 * caller's file-click handler, which funnels into `handleOpenFileTab` - the
 * single choke point that diverts playable media to the floating player before
 * a tab can be created. Everything else still goes to the OS.
 */

import { isMediaFile } from '../../shared/mediaTypes';

/**
 * Handle a clicked `file://` href.
 *
 * @param href The link target. Anything that is not `file://` is ignored.
 * @param onFileClick The surface's file-click handler, which resolves the path
 *   and routes it through the normal open path. Media falls back to the OS
 *   when a surface has none.
 * @returns Whether the href was handled, so callers can `return` on true.
 */
export function openFileUrl(href: string, onFileClick?: (path: string) => void): boolean {
	if (!/^file:\/\//.test(href)) return false;

	const path = href.replace(/^file:\/\//, '');
	if (onFileClick && isMediaFile(path)) {
		onFileClick(path);
		return true;
	}

	void window.maestro.shell.openPath(path);
	return true;
}
