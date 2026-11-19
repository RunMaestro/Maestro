// Source: src/__tests__/renderer/services/fileDeletion.test.ts
// Source: src/__tests__/renderer/services/userJourney.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import { requestFileDeletion } from '../../../renderer/services/fileDeletion';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { notifyCenterFlash } from '../../../renderer/stores/centerFlashStore';
import { recordJourney } from '../../../renderer/services/userJourney';
import { createMockSession } from '../../helpers/mockSession';
import type { Session } from '../../../renderer/types';
import * as journey from '../../../renderer/services/userJourney';
import { captureException } from '../../../renderer/utils/sentry';
vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));
vi.mock('../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: vi.fn(),
}));
vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));
vi.mock('../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));
describe('fileDeletion', () => {
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

	afterEach(() => vi.restoreAllMocks());
	beforeEach(() => {
		vi.spyOn(journey, 'recordJourney').mockImplementation(() => {});
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
			expect(recordJourney).toHaveBeenCalledWith(SESSION_ID, {
				kind: 'file.delete',
				target: FILE_PATH,
			});
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
			expect(recordJourney).not.toHaveBeenCalled();
		});

		it('does nothing without a session to act on', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' } as never);

			requestFileDeletion({ path: FILE_PATH });

			expect(useModalStore.getState().modals.get('confirm')?.open).toBeFalsy();
		});
	});
});
describe('userJourney', () => {
	const NOW = 1_700_000_000_000;
	let append: ReturnType<typeof vi.fn>;

	/** Let the fire-and-forget promise chain settle. */
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		append = vi.fn().mockResolvedValue(true);
		(window as any).maestro = { ...(window as any).maestro, journey: { append } };
		useSessionStore.setState({ sessions: [] });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('recordJourney', () => {
		it('stamps ts and agentId and sends the entry', async () => {
			useSessionStore.setState({ sessions: [createMockSession({ id: 'agent-1' })] });

			const result = recordJourney('agent-1', {
				kind: 'file.open',
				target: '/p/a.ts',
				tabId: 't1',
			});
			expect(result).toBeUndefined();
			await flush();

			expect(append).toHaveBeenCalledWith({
				kind: 'file.open',
				target: '/p/a.ts',
				tabId: 't1',
				ts: NOW,
				agentId: 'agent-1',
			});
		});

		it('stamps sshRemoteId from the session, including a not-yet-spawned SSH config', async () => {
			useSessionStore.setState({
				sessions: [
					createMockSession({ id: 'spawned', sshRemoteId: 'remote-a' }),
					createMockSession({
						id: 'configured',
						sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-b' },
					} as any),
				],
			});

			recordJourney('spawned', { kind: 'file.save', target: '/p/a.ts' });
			recordJourney('configured', { kind: 'file.delete', target: '/p/b.ts' });
			await flush();

			expect(append).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({ sshRemoteId: 'remote-a' })
			);
			expect(append).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({ sshRemoteId: 'remote-b' })
			);
		});

		it('records an unknown agent without an sshRemoteId', async () => {
			recordJourney('ghost', { kind: 'browser.open', target: 'https://example.com/' });
			await flush();

			const sent = append.mock.calls[0][0];
			expect(sent.agentId).toBe('ghost');
			expect('sshRemoteId' in sent).toBe(false);
		});

		it('reports a rejected write to Sentry and never throws', async () => {
			const error = new Error('disk full');
			append.mockRejectedValueOnce(error);

			expect(() =>
				recordJourney('agent-1', { kind: 'file.open', target: '/p/a.ts' })
			).not.toThrow();
			await flush();

			expect(captureException).toHaveBeenCalledWith(error, {
				extra: { operation: 'journey:append', agentId: 'agent-1', kind: 'file.open' },
			});
		});

		it('reports a missing bridge to Sentry instead of throwing into the UI', async () => {
			(window as any).maestro = { ...(window as any).maestro, journey: undefined };

			expect(() =>
				recordJourney('agent-1', { kind: 'file.open', target: '/p/a.ts' })
			).not.toThrow();
			await flush();

			expect(captureException).toHaveBeenCalledTimes(1);
		});
	});
});
