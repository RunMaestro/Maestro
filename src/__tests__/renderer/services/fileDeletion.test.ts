/**
 * Tests for the shared previewed-file deletion flow.
 *
 * The point of the service is that the toolbar's trash button and the command
 * palette's "File: Delete" entry cannot drift: both open a confirmation first,
 * both close the stale preview tab afterwards, and neither leaves the Files
 * panel showing a file that is gone.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { requestFileDeletion } from '../../../renderer/services/fileDeletion';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { notifyCenterFlash } from '../../../renderer/stores/centerFlashStore';
import { createMockSession } from '../../helpers/mockSession';
import type { Session } from '../../../renderer/types';

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

vi.mock('../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: vi.fn(),
}));

vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

const SESSION_ID = 'agent-1';
const FILE_PATH = '/repo/notes.md';

let fsDelete: Mock;

function seedSession(overrides: Partial<Session> = {}): Session {
	const session = createMockSession({
		id: SESSION_ID,
		inputMode: 'ai',
		activeFileTabId: 'file-1',
		filePreviewTabs: [
			{
				id: 'file-1',
				path: FILE_PATH,
				name: 'notes',
				extension: '.md',
				content: '',
				scrollTop: 0,
				searchQuery: '',
				editMode: false,
				editContent: undefined,
				createdAt: 1,
				lastModified: 1,
			},
		],
		unifiedTabOrder: [{ type: 'file', id: 'file-1' }],
		...overrides,
	} as Partial<Session>);

	useSessionStore.setState({ sessions: [session], activeSessionId: SESSION_ID } as never);
	return session;
}

/** Runs the confirm callback the service handed to the confirm modal. */
async function confirm(): Promise<void> {
	const data = useModalStore.getState().modals.get('confirm')?.data as
		| { onConfirm: () => void }
		| undefined;
	expect(data).toBeDefined();
	data!.onConfirm();
	// Let the async delete + tab cleanup settle.
	await vi.waitFor(() => expect(fsDelete).toHaveBeenCalled());
	await Promise.resolve();
}

beforeEach(() => {
	vi.clearAllMocks();
	useModalStore.setState({ modals: new Map() } as never);
	fsDelete = vi.fn().mockResolvedValue({ success: true });
	(window as unknown as { maestro: unknown }).maestro = { fs: { delete: fsDelete } };
});

describe('requestFileDeletion', () => {
	it('confirms before touching the file system', () => {
		seedSession();

		requestFileDeletion({ path: FILE_PATH });

		expect(fsDelete).not.toHaveBeenCalled();
		const entry = useModalStore.getState().modals.get('confirm');
		expect(entry?.open).toBe(true);
		const data = entry?.data as { message: string; destructive: boolean; title: string };
		expect(data.title).toBe('Delete File');
		expect(data.destructive).toBe(true);
		expect(data.message).toContain('notes.md');
	});

	it('deletes, closes the stale preview tab, and refreshes the file tree on confirm', async () => {
		seedSession();
		const refreshed: string[] = [];
		const listener = (e: Event) => refreshed.push((e as CustomEvent).detail.sessionId);
		window.addEventListener('maestro:refreshFileTree', listener);

		requestFileDeletion({ path: FILE_PATH, sshRemoteId: 'remote-1' });
		await confirm();

		window.removeEventListener('maestro:refreshFileTree', listener);

		expect(fsDelete).toHaveBeenCalledWith(FILE_PATH, { sshRemoteId: 'remote-1' });
		const session = useSessionStore.getState().sessions[0];
		expect(session.filePreviewTabs).toHaveLength(0);
		expect(session.activeFileTabId).toBeNull();
		expect(refreshed).toEqual([SESSION_ID]);
		expect(notifyCenterFlash).toHaveBeenCalled();
	});

	it('keeps the tab open and reports the failure when the delete fails', async () => {
		seedSession();
		fsDelete.mockRejectedValue(new Error('EACCES'));

		requestFileDeletion({ path: FILE_PATH });
		await confirm();

		expect(useSessionStore.getState().sessions[0].filePreviewTabs).toHaveLength(1);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', title: 'Delete failed' })
		);
		expect(notifyCenterFlash).not.toHaveBeenCalled();
	});

	it('does nothing without a session to act on', () => {
		useSessionStore.setState({ sessions: [], activeSessionId: '' } as never);

		requestFileDeletion({ path: FILE_PATH });

		expect(useModalStore.getState().modals.get('confirm')?.open).toBeFalsy();
	});
});
