/**
 * fileDeletion - the single "delete the file I'm looking at" flow.
 *
 * Two surfaces offer it (the File Preview toolbar's trash button and the
 * command palette's "File: Delete" entry) and both route here, so the
 * confirmation copy, the destructive guard, the tab cleanup, and the Files
 * panel refresh can never drift apart between them.
 *
 * The delete itself goes through `window.maestro.fs.delete`, which is the same
 * IPC the Files panel context menu uses and which honors `sshRemoteId` for
 * agents running against a remote host.
 */

import { useModalStore } from '../stores/modalStore';
import { useSessionStore, selectActiveSession } from '../stores/sessionStore';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { notifyToast } from '../stores/notificationStore';
import { closeFileTab } from '../utils/tabHelpers';
import { captureException } from '../utils/sentry';
import { getBasename } from '../../shared/formatters';
import type { Session } from '../types';

export interface DeleteFileRequest {
	/** Absolute path of the file to delete. */
	path: string;
	/** SSH remote the file lives on, when the agent runs remotely. */
	sshRemoteId?: string;
	/**
	 * Session that owns the preview. Defaults to the active session, which is
	 * what both calling surfaces are scoped to.
	 */
	sessionId?: string;
}

/**
 * Closes every file preview tab in `sessionId` that points at `path`.
 *
 * Deliberately bypasses the unsaved-changes prompt that `handleCloseFileTab`
 * puts up: the file is already gone, so offering to keep the tab open would
 * leave the user editing a buffer that can no longer be saved back.
 */
function closePreviewTabsForPath(sessionId: string, path: string): number {
	let closed = 0;
	useSessionStore.getState().setSessions((prev: Session[]) =>
		prev.map((session) => {
			if (session.id !== sessionId) return session;
			let next = session;
			for (const tab of session.filePreviewTabs) {
				if (tab.path !== path) continue;
				const result = closeFileTab(next, tab.id);
				if (!result) continue;
				next = result.session;
				closed++;
			}
			return next;
		})
	);
	return closed;
}

interface ResolvedDeleteRequest {
	path: string;
	sessionId: string;
	sshRemoteId?: string;
}

async function deleteFile({ path, sshRemoteId, sessionId }: ResolvedDeleteRequest): Promise<void> {
	const name = getBasename(path) || path;

	try {
		await window.maestro.fs.delete(path, { sshRemoteId });
	} catch (error) {
		captureException(error, {
			extra: { action: 'delete-previewed-file', path, sessionId, sshRemoteId },
		});
		notifyToast({
			color: 'red',
			title: 'Delete failed',
			message: `${name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
		});
		return;
	}

	closePreviewTabsForPath(sessionId, path);

	// Nudge the Files panel so the deleted entry disappears without waiting for
	// its next auto-refresh. Same CustomEvent the remote/CLI paths dispatch.
	window.dispatchEvent(new CustomEvent('maestro:refreshFileTree', { detail: { sessionId } }));

	notifyCenterFlash({ message: 'Deleted', detail: name, color: 'orange' });
}

/**
 * Opens the delete confirmation for a previewed file. Returns silently when
 * there is no session to act on, so callers do not have to guard.
 */
export function requestFileDeletion({ path, sshRemoteId, sessionId }: DeleteFileRequest): void {
	const resolvedSessionId = sessionId ?? selectActiveSession(useSessionStore.getState())?.id;
	if (!resolvedSessionId || !path) return;

	const name = getBasename(path) || path;

	useModalStore.getState().openModal('confirm', {
		title: 'Delete File',
		message: `Are you sure you want to delete "${name}"? This closes its preview tab and cannot be undone.`,
		destructive: true,
		onConfirm: () => {
			void deleteFile({ path, sshRemoteId, sessionId: resolvedSessionId });
		},
	});
}
