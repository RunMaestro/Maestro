/**
 * Opening a path that might be a folder.
 *
 * A link in the chat, a deep link, or `maestro-cli open-file` names a path, and
 * nothing about the path says whether it is a file or a directory: an agent
 * writes `[Beta content folder](/Users/me/Course Content/_beta)` exactly the way
 * it writes a link to a Markdown file. Every open path used to assume a file,
 * so `fs.readFile` rejected the directory with EISDIR and the click silently
 * did nothing.
 *
 * A file opens in a preview tab. A folder has no preview, so the equivalent
 * "take me there" is the Files panel: open it, expand every ancestor plus the
 * folder itself, and select the row. The selection lands through the session's
 * `pendingJumpPath`, which `useFileExplorerEffects` resolves against the flat
 * list once it contains the row (a folder past the scan depth cap only appears
 * after the rescan its expansion triggers).
 */

import { normalizeWorktreePath } from '../../shared/worktreePaths';
import { captureException } from '../utils/sentry';
import { selectSessionById, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import type { Session } from '../types';

/** What a path turned out to be, read in one round trip. `null` = missing. */
export type OpenPathTarget =
	| { kind: 'directory' }
	| { kind: 'file'; content: string; lastModified?: number }
	| null;

/**
 * Stat and read a path in parallel and report whether it is a file (with its
 * content) or a directory.
 *
 * The read starts before the stat answers so a file costs one round trip, which
 * matters over SSH. For a directory the read rejects with EISDIR and is never
 * awaited, so its rejection is swallowed here rather than surfacing as
 * unhandled. A read failure for a real file still propagates to the caller.
 */
export async function readPathForOpen(
	fullPath: string,
	sshRemoteId?: string
): Promise<OpenPathTarget> {
	const contentPromise = window.maestro.fs.readFile(fullPath, sshRemoteId);
	contentPromise.catch(() => {});

	const stat = await window.maestro.fs.stat(fullPath, sshRemoteId).catch((err) => {
		// ENOENT is expected (the path may have been deleted since it was linked).
		if (err?.code !== 'ENOENT') {
			captureException(err, { extra: { fullPath, operation: 'file-stat', sshRemoteId } });
		}
		return null;
	});
	if (stat?.isDirectory) return { kind: 'directory' };

	const content = await contentPromise;
	if (content === null) return null;
	const lastModified = stat?.modifiedAt ? new Date(stat.modifiedAt).getTime() : undefined;
	return { kind: 'file', content, lastModified };
}

/**
 * A path relative to the agent's file tree root, in the form the flat file
 * list keys rows by (`/`-joined, no leading slash). `''` is the root itself;
 * `null` means the path is outside the tree and cannot be revealed in it.
 */
export function fileTreeRelativePath(session: Session, absolutePath: string): string | null {
	// SSH paths are POSIX on the remote host; only local paths may carry `\`.
	const posix = Boolean(session.sshRemoteId || session.sessionSshRemoteConfig?.enabled);
	const root = normalizeWorktreePath(session.projectRoot || session.cwd, posix);
	const path = normalizeWorktreePath(absolutePath, posix);
	if (path === root) return '';
	const prefix = root.endsWith('/') ? root : `${root}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/**
 * Reveal a path in the agent's Files panel: expand its ancestors and the path
 * itself, then select its row.
 *
 * `focus` also opens the Right Bar on the Files tab and moves the app's focus
 * there, which is what a click in the chat asks for. Leave it off for a
 * background open, which must not move the view.
 *
 * @returns false when the agent is unknown or the path is outside its tree.
 */
export function revealPathInFileTree(
	sessionId: string,
	absolutePath: string,
	options: { focus?: boolean } = {}
): boolean {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (!session) return false;
	const relativePath = fileTreeRelativePath(session, absolutePath);
	if (relativePath === null) return false;

	const segments = relativePath ? relativePath.split('/') : [];
	updateSessionWith(sessionId, (s) => {
		const expanded = new Set(s.fileExplorerExpanded ?? []);
		segments.forEach((_, i) => expanded.add(segments.slice(0, i + 1).join('/')));
		return { ...s, fileExplorerExpanded: Array.from(expanded), pendingJumpPath: relativePath };
	});

	if (options.focus) {
		const ui = useUIStore.getState();
		ui.setRightPanelOpen(true);
		ui.setActiveRightTab('files');
		ui.setActiveFocus('right');
	}
	return true;
}
