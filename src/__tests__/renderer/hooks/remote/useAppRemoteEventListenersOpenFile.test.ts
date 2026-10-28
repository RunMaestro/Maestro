/**
 * Covers `maestro:openFileTab` in useAppRemoteEventListeners - the renderer
 * side of `maestro-cli open-file`.
 *
 * The case under test is `--queue`: audio/video handed to the floating player
 * WITHOUT starting it, so an agent can put media on screen and leave pressing
 * play to the user. Queueing must reach `handleOpenFileTab` as `mediaMode:
 * 'queue'` (anything else plays), and it must not switch agents - the player
 * is app-wide, so there is nowhere to take the user.
 *
 * A folder has no preview tab: it is revealed in the Files panel instead, and
 * only takes focus when the open is allowed to move the view.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { createMockSession } from '../../../helpers/mockSession';
import { requestDocumentChatPanel } from '../../../../renderer/services/documentChatPanel';

vi.mock('../../../../renderer/services/documentChatPanel', () => ({
	requestDocumentChatPanel: vi.fn(),
}));

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
	selectSessionById: vi.fn(),
}));
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
}));
vi.mock('../../../../renderer/hooks/batch/batchUtils', () => ({ DEFAULT_BATCH_PROMPT: '' }));
vi.mock('../../../../renderer/services/git', () => ({ gitService: {} }));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/browserTabPersistence', () => ({
	getBrowserTabPartition: () => 'persist:test',
}));
const mockRevealPathInFileTree = vi.fn().mockReturnValue(true);
vi.mock('../../../../renderer/services/fileTreeReveal', async (importActual) => ({
	...(await importActual<typeof import('../../../../renderer/services/fileTreeReveal')>()),
	revealPathInFileTree: (...args: unknown[]) => mockRevealPathInFileTree(...args),
}));

const STREAM_URL = 'maestro-media://stream/token/abc';

function setup() {
	const setActiveSessionId = vi.fn();
	const handleOpenFileTab = vi.fn();
	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef: { current: [createMockSession({ id: 'session-1', cwd: '/projects/pod' })] },
			setActiveSessionId,
			setSessions: vi.fn(),
			setGroups: vi.fn(),
			handleOpenFileTab,
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);
	return { setActiveSessionId, handleOpenFileTab };
}

function dispatchOpen(detail: Record<string, unknown>) {
	window.dispatchEvent(
		new CustomEvent('maestro:openFileTab', {
			detail: { sessionId: 'session-1', filePath: '/projects/pod/ep1.mp3', ...detail },
		})
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		fs: {
			readFile: vi.fn().mockResolvedValue(STREAM_URL),
			stat: vi.fn().mockResolvedValue(null),
		},
	};
});

describe('maestro:openFileTab', () => {
	it('opens the preview before requesting its embedded voice chat', async () => {
		vi.mocked(window.maestro.fs.readFile).mockResolvedValue('# Document');
		const { handleOpenFileTab } = setup();
		dispatchOpen({ filePath: '/projects/pod/doc.md', documentChat: 'voice' });
		await vi.waitFor(() => expect(requestDocumentChatPanel).toHaveBeenCalled());
		expect(requestDocumentChatPanel).toHaveBeenCalledWith({
			path: '/projects/pod/doc.md',
			sessionId: 'session-1',
			voice: true,
		});
		expect(handleOpenFileTab.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(requestDocumentChatPanel).mock.invocationCallOrder[0]
		);
	});

	it('does not start an embedded chat for a background file open', async () => {
		const { handleOpenFileTab } = setup();
		dispatchOpen({ filePath: '/projects/pod/doc.md', documentChat: 'voice', background: true });
		await vi.waitFor(() => expect(handleOpenFileTab).toHaveBeenCalled());
		expect(requestDocumentChatPanel).not.toHaveBeenCalled();
	});

	it('forwards mediaMode queue and does not switch agents', async () => {
		const { setActiveSessionId, handleOpenFileTab } = setup();

		dispatchOpen({ background: false, switchToAgent: true, mediaMode: 'queue' });

		await vi.waitFor(() => expect(handleOpenFileTab).toHaveBeenCalled());
		expect(handleOpenFileTab.mock.calls[0][1]).toMatchObject({
			targetSessionId: 'session-1',
			mediaMode: 'queue',
		});
		expect(setActiveSessionId).not.toHaveBeenCalled();
	});

	it('keeps the unflagged open: switch agents and play', async () => {
		const { setActiveSessionId, handleOpenFileTab } = setup();

		dispatchOpen({ background: false, switchToAgent: true });

		await vi.waitFor(() => expect(handleOpenFileTab).toHaveBeenCalled());
		expect(handleOpenFileTab.mock.calls[0][1].mediaMode).toBeUndefined();
		expect(setActiveSessionId).toHaveBeenCalledWith('session-1');
	});

	it('reveals a folder in the Files panel instead of opening a tab', async () => {
		(window.maestro.fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isDirectory: true });
		(window.maestro.fs.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(
			Object.assign(new Error('EISDIR'), { code: 'EISDIR' })
		);
		const { handleOpenFileTab } = setup();

		dispatchOpen({ filePath: '/projects/pod/episodes' });

		await vi.waitFor(() => expect(mockRevealPathInFileTree).toHaveBeenCalled());
		expect(mockRevealPathInFileTree).toHaveBeenCalledWith('session-1', '/projects/pod/episodes', {
			focus: true,
		});
		expect(handleOpenFileTab).not.toHaveBeenCalled();
	});

	it('reveals a folder without focus for a background open', async () => {
		(window.maestro.fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isDirectory: true });
		setup();

		dispatchOpen({ filePath: '/projects/pod/episodes', background: true });

		await vi.waitFor(() => expect(mockRevealPathInFileTree).toHaveBeenCalled());
		expect(mockRevealPathInFileTree.mock.calls[0][2]).toEqual({ focus: false });
	});
});
