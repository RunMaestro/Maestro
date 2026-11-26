/**
 * Covers `maestro:remoteDeleteSession` in useAppRemoteEventListeners - the renderer side of
 * `maestro-cli remove-agent` and of a Federation peer's `agents.remove` on a desktop host (T8).
 * It removes what the Left Bar's Remove Agent removes: the processes, the record, and the playbooks.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { createMockSession } from '../../../helpers/mockSession';
import type { Session } from '../../../../renderer/types';

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({ activeSessionId: '' })) }),
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
const killAgentAiProcesses = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../../renderer/services/process', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/services/process')>()),
	killAgentAiProcesses: (...args: unknown[]) => killAgentAiProcesses(...args),
}));

const deleteAll = vi.fn().mockResolvedValue({});
const kill = vi.fn().mockResolvedValue(true);
const setMany = vi.fn().mockResolvedValue(undefined);

function setup(sessions: Session[]) {
	const setSessions = vi.fn();
	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef: { current: sessions },
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

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		process: { kill },
		playbooks: { deleteAll },
		sessions: { setMany },
	};
});

describe('maestro:remoteDeleteSession', () => {
	it("stops the agent's processes, removes its playbooks, and drops its record (T8)", async () => {
		const session = createMockSession({ id: 'agent-1', terminalTabs: [] });
		const { setSessions } = setup([session]);
		window.dispatchEvent(
			new CustomEvent('maestro:remoteDeleteSession', { detail: { sessionId: 'agent-1' } })
		);
		await vi.waitFor(() => expect(setMany).toHaveBeenCalledWith([], ['agent-1']));
		expect(killAgentAiProcesses).toHaveBeenCalledWith('agent-1');
		expect(kill).toHaveBeenCalledWith('agent-1-terminal');
		expect(deleteAll).toHaveBeenCalledWith('agent-1');
		expect(setSessions).toHaveBeenCalled();
	});
});
