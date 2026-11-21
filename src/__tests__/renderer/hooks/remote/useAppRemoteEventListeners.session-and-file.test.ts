// Source: src/__tests__/renderer/hooks/remote/useAppRemoteEventListenersCreateSession.test.ts
// Source: src/__tests__/renderer/hooks/remote/useAppRemoteEventListenersOpenFile.test.ts
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { type Session } from '../../../../renderer/types';
import { createMockSession } from '../../../helpers/mockSession';
const mockRevealPathInFileTree = vi.fn().mockReturnValue(true);
vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
	selectSessionById: vi.fn(),
}));
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
}));
vi.mock('../../../../renderer/hooks/batch/batchUtils', () => ({ DEFAULT_BATCH_PROMPT: '' }));
vi.mock('../../../../renderer/services/git', () => ({
	gitService: { isRepo: vi.fn(async () => false) },
}));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/browserTabPersistence', () => ({
	getBrowserTabPartition: () => 'persist:test',
}));
vi.mock('../../../../renderer/utils/ids', () => ({ generateId: () => 'new-id' }));
vi.mock('../../../../renderer/services/fileTreeReveal', async (importActual) => ({
	...(await importActual<typeof import('../../../../renderer/services/fileTreeReveal')>()),
	revealPathInFileTree: (...args: unknown[]) => mockRevealPathInFileTree(...args),
}));
describe('useAppRemoteEventListenersCreateSession', () => {
	const ack = vi.fn();

	function setup() {
		const setSessions = vi.fn();
		renderHook(() =>
			useAppRemoteEventListeners({
				sessionsRef: { current: [] },
				setActiveSessionId: vi.fn(),
				setSessions,
				setGroups: vi.fn(),
				handleOpenFileTab: vi.fn(),
				refreshFileTree: vi.fn(),
				handleAutoRunRefresh: vi.fn(),
				startBatchRun: vi.fn(),
				stopBatchRun: vi.fn(),
				resumeAfterError: vi.fn(),
				skipCurrentDocument: vi.fn(),
				abortBatchOnError: vi.fn(),
			} as any)
		);
		return { setSessions };
	}

	async function create(toolType: string, config: Record<string, unknown>): Promise<Session> {
		const { setSessions } = setup();
		window.dispatchEvent(
			new CustomEvent('maestro:remoteCreateSession', {
				detail: {
					name: 'Copy',
					toolType,
					cwd: '/p',
					config,
					responseChannel: 'ch',
					background: true,
				},
			})
		);
		await waitFor(() => expect(ack).toHaveBeenCalledWith('ch', { sessionId: 'new-id' }));
		const updater = (setSessions as Mock).mock.calls[0][0] as (prev: Session[]) => Session[];
		return updater([])[0];
	}

	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = {
			agents: { get: vi.fn(async (id: string) => ({ id })) },
			stats: { recordSessionCreated: vi.fn() },
			sessions: { setMany: vi.fn(async () => undefined) },
			process: { sendRemoteCreateSessionResponse: ack },
		};
	});

	describe('maestro:remoteCreateSession', () => {
		it('stores the duplicate fields and stamps the fresh Claude mode', async () => {
			const agent = await create('claude-code', {
				additionalDirectories: [{ path: '/shared', read: true, write: false }],
				enableMaestroP: true,
				maestroPMode: 'interactive',
				maestroPPath: '/opt/maestro-p',
				retryOnAvailabilityErrors: false,
				retryOnTokenExhaustion: true,
			});

			expect(agent).toMatchObject({
				additionalDirectories: [{ path: '/shared', read: true, write: false }],
				enableMaestroP: true,
				maestroPMode: 'interactive',
				maestroPPath: '/opt/maestro-p',
				retryOnAvailabilityErrors: false,
				retryOnTokenExhaustion: true,
				claudeInteractive: { mode: 'api', modeReason: 'auto' },
			});
		});

		it('keeps an explicit Adaptive Mode off and drops its refinements', async () => {
			const agent = await create('claude-code', {
				enableMaestroP: false,
				maestroPMode: 'interactive',
				maestroPPath: '/opt/maestro-p',
			});

			expect(agent.enableMaestroP).toBe(false);
			expect(agent.maestroPMode).toBeUndefined();
			expect(agent.maestroPPath).toBeUndefined();
		});

		it('stores only the Codex opt-ins, like createNewSession()', async () => {
			const optedIn = await create('codex', {
				codexAutoResetOnExhaustion: true,
				codexTransport: 'app-server',
			});
			expect(optedIn).toMatchObject({
				codexAutoResetOnExhaustion: true,
				codexTransport: 'app-server',
			});
			expect(optedIn.claudeInteractive).toBeUndefined();

			ack.mockClear();
			const defaults = await create('codex', {
				codexAutoResetOnExhaustion: false,
				codexTransport: 'exec',
			});
			expect('codexAutoResetOnExhaustion' in defaults).toBe(false);
			expect('codexTransport' in defaults).toBe(false);
		});
	});
});
describe('useAppRemoteEventListenersOpenFile', () => {
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
});
