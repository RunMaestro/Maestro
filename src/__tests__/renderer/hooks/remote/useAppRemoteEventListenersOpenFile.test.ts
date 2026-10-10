/**
 * Covers `maestro:openFileTab` in useAppRemoteEventListeners - the renderer
 * side of `maestro-cli open-file`.
 *
 * The case under test is `--queue`: audio/video handed to the floating player
 * WITHOUT starting it, so an agent can put media on screen and leave pressing
 * play to the user. Queueing must reach `handleOpenFileTab` as `mediaMode:
 * 'queue'` (anything else plays), and it must not switch agents - the player
 * is app-wide, so there is nowhere to take the user.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { createMockSession } from '../../../helpers/mockSession';

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
});
