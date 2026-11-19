/**
 * handleLaunchPlaybookRun: the Playbook Exchange's Run. It starts the run on
 * the named agent through the same launch path as the Auto Run panel's Go,
 * resolves true only once the batch store reports it running, and then
 * reveals the Auto Run panel so its running state shows.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAutoRunHandlers } from '../../../../renderer/hooks/batch/useAutoRunHandlers';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import { clearGoalRunLaunches } from '../../../../renderer/hooks/remote/goalRunLaunch';
import { createMockSession } from '../../../helpers/mockSession';
import type { BatchRunConfig } from '../../../../shared/types';

vi.mock('../../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: () => false }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => toast(...args),
}));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));

const config: BatchRunConfig = {
	documents: [
		{ id: 'one', filename: 'refactor/one', resetOnCompletion: false, isDuplicate: false },
	],
	prompt: 'Do the work',
	loopEnabled: true,
	maxLoops: 10,
	taskSelectionMode: 'task',
	launchSource: 'exchange',
	playbook: { id: 'pb-1', ownerSessionId: 'owner' },
};

const owner = createMockSession({ id: 'owner', autoRunFolderPath: '/docs', cwd: '/repo' });

type StartBatchRun = (
	sessionId: string,
	config: BatchRunConfig,
	folderPath: string
) => Promise<void>;

function makeDeps(startBatchRun: StartBatchRun) {
	return {
		setSessions: vi.fn(),
		setAutoRunDocumentList: vi.fn(),
		setAutoRunDocumentTree: vi.fn(),
		setAutoRunIsLoadingDocuments: vi.fn(),
		setAutoRunSetupModalOpen: vi.fn(),
		setBatchRunnerModalOpen: vi.fn(),
		setActiveRightTab: vi.fn(),
		setRightPanelOpen: vi.fn(),
		setActiveFocus: vi.fn(),
		setSuccessFlashNotification: vi.fn(),
		autoRunDocumentList: [],
		startBatchRun,
	};
}

/** A startBatchRun that publishes a live run, like the real one does once it dispatches START_BATCH. */
function startsRunning() {
	return vi.fn<StartBatchRun>((sessionId) => {
		useBatchStore.setState({
			batchRunStates: { [sessionId]: { ...DEFAULT_BATCH_STATE, isRunning: true } },
		});
		return new Promise<void>(() => {});
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	clearGoalRunLaunches();
	useSessionStore.setState({ sessions: [owner], activeSessionId: owner.id });
	useSettingsStore.setState({ autoRunDisabled: false });
	useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
	window.maestro = {
		logger: { log: vi.fn() },
		process: {},
	} as unknown as typeof window.maestro;
});

describe('handleLaunchPlaybookRun', () => {
	it('starts the run on the named agent with its own folder, then reveals the Auto Run panel', async () => {
		const startBatchRun = startsRunning();
		const deps = makeDeps(startBatchRun);
		const { result } = renderHook(() => useAutoRunHandlers(deps));

		let started = false;
		await act(async () => {
			started = await result.current.handleLaunchPlaybookRun('owner', config);
		});

		expect(started).toBe(true);
		expect(startBatchRun).toHaveBeenCalledWith('owner', config, '/docs');
		expect(deps.setActiveRightTab).toHaveBeenCalledWith('autorun');
		expect(deps.setRightPanelOpen).toHaveBeenCalledWith(true);
		expect(toast).not.toHaveBeenCalled();
	});

	it('resolves false and keeps the panel as it was when the run never reports running', async () => {
		const startBatchRun = vi.fn<StartBatchRun>().mockResolvedValue(undefined);
		const deps = makeDeps(startBatchRun);
		const { result } = renderHook(() => useAutoRunHandlers(deps));

		let started = true;
		await act(async () => {
			started = await result.current.handleLaunchPlaybookRun('owner', config);
		});

		expect(started).toBe(false);
		expect(deps.setActiveRightTab).not.toHaveBeenCalled();
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Auto Run did not start' })
		);
	});

	it('refuses an agent that already has a run going', async () => {
		useBatchStore.setState({
			batchRunStates: { owner: { ...DEFAULT_BATCH_STATE, isRunning: true } },
		});
		const startBatchRun = startsRunning();
		const { result } = renderHook(() => useAutoRunHandlers(makeDeps(startBatchRun)));

		let started = true;
		await act(async () => {
			started = await result.current.handleLaunchPlaybookRun('owner', config);
		});

		expect(started).toBe(false);
		expect(startBatchRun).not.toHaveBeenCalled();
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Auto Run start failed' }));
	});

	it('does nothing but say so when Auto Run is disabled', async () => {
		useSettingsStore.setState({ autoRunDisabled: true });
		const startBatchRun = startsRunning();
		const { result } = renderHook(() => useAutoRunHandlers(makeDeps(startBatchRun)));

		let started = true;
		await act(async () => {
			started = await result.current.handleLaunchPlaybookRun('owner', config);
		});

		expect(started).toBe(false);
		expect(startBatchRun).not.toHaveBeenCalled();
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Auto Run is disabled' }));
	});
});
