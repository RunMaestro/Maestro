/**
 * Covers `maestro:remoteUpdateSessionCwd` in useAppRemoteEventListeners - the
 * renderer side of `maestro-cli update-agent --cwd`.
 *
 * The invariant under test (#1565): every path field moves together. Moving
 * only `cwd` left `projectRoot` and `autoRunFolderPath` on the old directory,
 * so the Files panel listed nothing and the Edit dialog showed the old path.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { createMockSession } from '../../../helpers/mockSession';
import type { Session } from '../../../../renderer/types';

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
vi.mock('../../../../renderer/utils/ids', () => ({ generateId: () => 'new-tab-id' }));

const ack = vi.fn();

function setup(sessions: Session[]) {
	const sessionsRef = { current: sessions };
	const setSessions = vi.fn();

	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef,
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

/** Run the reducer that setSessions was called with against the given state. */
function applyUpdate(setSessions: Mock, sessions: Session[]): Session[] {
	const updater = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
	return updater(sessions);
}

function dispatchCwd(sessionId: string, newCwd: string) {
	window.dispatchEvent(
		new CustomEvent('maestro:remoteUpdateSessionCwd', {
			detail: { sessionId, newCwd, responseChannel: 'ch' },
		})
	);
}

const oldLocation = () =>
	createMockSession({
		id: 'session-1',
		aiPid: 0,
		cwd: '/projects/old',
		fullPath: '/projects/old',
		shellCwd: '/projects/old',
		projectRoot: '/projects/old',
		autoRunFolderPath: '/projects/old/.maestro/playbooks',
	});

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		process: { sendRemoteUpdateSessionCwdResponse: ack },
	};
});

describe('maestro:remoteUpdateSessionCwd', () => {
	it('moves projectRoot and the Auto Run folder along with cwd', () => {
		const sessions = [oldLocation()];
		const { setSessions } = setup(sessions);

		dispatchCwd('session-1', '/projects/new');

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.cwd).toBe('/projects/new');
		expect(updated.fullPath).toBe('/projects/new');
		expect(updated.shellCwd).toBe('/projects/new');
		expect(updated.projectRoot).toBe('/projects/new');
		expect(updated.autoRunFolderPath).toBe('/projects/new/.maestro/playbooks');
		expect(ack).toHaveBeenCalledWith('ch', { success: true });
	});

	it('clears the old file tree so the Files panel reloads from the new directory', () => {
		const sessions = [
			{ ...oldLocation(), fileTree: [{ name: 'stale.ts', type: 'file' as const }] },
		];
		const { setSessions } = setup(sessions);

		dispatchCwd('session-1', '/projects/new');

		expect(applyUpdate(setSessions, sessions)[0].fileTree).toEqual([]);
	});

	it('repairs an agent an older --cwd left split when moved back to its projectRoot', () => {
		const split = { ...oldLocation(), cwd: '/projects/new', fullPath: '/projects/new' };
		const sessions = [{ ...split, shellCwd: '/projects/new' }];
		const { setSessions } = setup(sessions);

		dispatchCwd('session-1', '/projects/old');

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.cwd).toBe('/projects/old');
		expect(updated.fullPath).toBe('/projects/old');
		expect(updated.shellCwd).toBe('/projects/old');
		expect(updated.projectRoot).toBe('/projects/old');
	});

	it('refuses while the agent process is running', () => {
		const sessions = [{ ...oldLocation(), aiPid: 4242 }];
		const { setSessions } = setup(sessions);

		dispatchCwd('session-1', '/projects/new');

		expect(setSessions).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', {
			success: false,
			error: 'Agent process is running; stop it before changing cwd',
		});
	});
});
