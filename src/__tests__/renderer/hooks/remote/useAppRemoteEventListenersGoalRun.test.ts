/**
 * Covers the `maestro:launchGoalRun` listener - the renderer end of
 * `maestro-cli goal-run --visible` (issue #1286).
 *
 * The invariant under test is that the reply is TRUE. Unlike the sibling
 * `configureAutoRun` bridge, which acks up front because its run is long, this
 * one refuses to say "launched" until the run is actually running, and it
 * claims the agent synchronously so two launches cannot overlap on it. Every
 * rejection carries a machine-readable code, because the CLI has to tell
 * "busy" apart from "no such agent" without matching on prose.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { createMockSession } from '../../../helpers/mockSession';
import { clearGoalRunLaunches } from '../../../../renderer/hooks/remote/goalRunLaunch';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import type { Session } from '../../../../renderer/types';

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
	selectSessionById: vi.fn(() => () => undefined),
}));

const autoRunDisabled = { value: false };
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), {
		getState: vi.fn(() => ({
			get autoRunDisabled() {
				return autoRunDisabled.value;
			},
		})),
	}),
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
vi.mock('../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

const ack = vi.fn();

const SESSION_ID = 'agent-1';

function makeSession(): Session {
	return createMockSession({
		id: SESSION_ID,
		name: 'Worker',
		activeTabId: 'tab-7',
		autoRunFolderPath: '/repo/.maestro',
	}) as Session;
}

function setup(startBatchRun: ReturnType<typeof vi.fn>, sessions: Session[] = [makeSession()]) {
	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef: { current: sessions },
			setActiveSessionId: vi.fn(),
			setSessions: vi.fn(),
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun,
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);
}

function launch(sessionId = SESSION_ID, config: Record<string, unknown> = { goal: 'ship it' }) {
	window.dispatchEvent(
		new CustomEvent('maestro:launchGoalRun', {
			detail: { sessionId, config, responseChannel: 'ch' },
		})
	);
}

/** Mark the agent's batch as running, the way START_BATCH would. */
function markRunning(sessionId = SESSION_ID) {
	useBatchStore.setState({
		batchRunStates: { [sessionId]: { ...DEFAULT_BATCH_STATE, isRunning: true } },
	});
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.clearAllMocks();
	clearGoalRunLaunches();
	useBatchStore.setState({ batchRunStates: {} });
	autoRunDisabled.value = false;
	(window as any).maestro = {
		process: { sendRemoteLaunchGoalRunResponse: ack },
		logger: { log: vi.fn() },
	};
});

describe('maestro:launchGoalRun', () => {
	it('routes to startBatchRun with a goalConfig, which is what selects goal mode', async () => {
		const startBatchRun = vi.fn(() => new Promise<void>(() => {}));
		setup(startBatchRun);

		launch(SESSION_ID, {
			goal: '  ship it  ',
			exitCriteria: '  tests pass  ',
			maxIterations: 5,
			model: 'opus',
			effort: 'high',
		});
		await flush();

		expect(startBatchRun).toHaveBeenCalledWith(
			SESSION_ID,
			expect.objectContaining({
				documents: [],
				goalConfig: { goal: 'ship it', exitCriteria: 'tests pass', maxIterations: 5 },
				model: 'opus',
				effort: 'high',
			}),
			'/repo/.maestro'
		);
	});

	it('defaults an absent iteration cap to an infinite run', async () => {
		const startBatchRun = vi.fn(() => new Promise<void>(() => {}));
		setup(startBatchRun);

		launch();
		await flush();

		expect(startBatchRun.mock.calls[0][1]).toMatchObject({
			goalConfig: expect.objectContaining({ maxIterations: null }),
		});
	});

	it('acks success only after the run reports running, and returns the active tab', async () => {
		const startBatchRun = vi.fn(() => new Promise<void>(() => {}));
		setup(startBatchRun);

		launch();
		await flush();
		// Still silent: the run has not started yet.
		expect(ack).not.toHaveBeenCalled();

		markRunning();
		await flush();

		expect(ack).toHaveBeenCalledWith('ch', { success: true, tabId: 'tab-7' });
	});

	it('reports LAUNCH_FAILED when the runner returns without ever starting', async () => {
		// The kill switch, a vanished session, or a prompt template that failed to
		// load all look like this: a resolved promise and no running state.
		const startBatchRun = vi.fn(() => Promise.resolve());
		setup(startBatchRun);

		launch();
		await flush();

		expect(ack).toHaveBeenCalledWith(
			'ch',
			expect.objectContaining({ success: false, code: 'LAUNCH_FAILED' })
		);
	});

	it('reports SESSION_NOT_FOUND for an unknown agent without starting anything', async () => {
		const startBatchRun = vi.fn();
		setup(startBatchRun);

		launch('nope');
		await flush();

		expect(startBatchRun).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith(
			'ch',
			expect.objectContaining({ success: false, code: 'SESSION_NOT_FOUND' })
		);
	});

	it('reports EMPTY_GOAL rather than starting a run with nothing to pursue', async () => {
		const startBatchRun = vi.fn();
		setup(startBatchRun);

		launch(SESSION_ID, { goal: '   ' });
		await flush();

		expect(startBatchRun).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith(
			'ch',
			expect.objectContaining({ success: false, code: 'EMPTY_GOAL' })
		);
	});

	it('reports AUTO_RUN_DISABLED instead of the toast-only silence the runner would give', async () => {
		autoRunDisabled.value = true;
		const startBatchRun = vi.fn();
		setup(startBatchRun);

		launch();
		await flush();

		expect(startBatchRun).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith(
			'ch',
			expect.objectContaining({ success: false, code: 'AUTO_RUN_DISABLED' })
		);
	});

	it('reports AGENT_BUSY when a run is already going', async () => {
		markRunning();
		const startBatchRun = vi.fn();
		setup(startBatchRun);

		launch();
		await flush();

		expect(startBatchRun).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith(
			'ch',
			expect.objectContaining({ success: false, code: 'AGENT_BUSY' })
		);
	});

	it('rejects a second launch that arrives before the first one starts', async () => {
		// The race the reservation exists for: neither launch has reached
		// START_BATCH, so a plain isRunning check would admit both.
		const startBatchRun = vi.fn(() => new Promise<void>(() => {}));
		setup(startBatchRun);

		launch();
		launch();
		await flush();

		expect(startBatchRun).toHaveBeenCalledTimes(1);
		expect(ack).toHaveBeenCalledWith(
			'ch',
			expect.objectContaining({ success: false, code: 'AGENT_BUSY' })
		);
	});

	it('allows a retry after a launch that failed to start', async () => {
		const startBatchRun = vi.fn(() => Promise.resolve());
		setup(startBatchRun);

		launch();
		await flush();
		launch();
		await flush();

		expect(startBatchRun).toHaveBeenCalledTimes(2);
	});
});
