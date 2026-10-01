import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	planAutoRunResume,
	reclaimOrphanedAutoRuns,
	waitForOrphanedTaskExit,
	type ReclaimedAutoRun,
} from '../../../../renderer/hooks/batch/useAutoRunReclaim';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import { getClientInstanceId } from '../../../../renderer/utils/clientInstance';
import type { BatchRunConfig, Session } from '../../../../renderer/types';

const docConfig = (over: Partial<BatchRunConfig> = {}): BatchRunConfig => ({
	documents: [{ id: 'd1', filename: 'plan', resetOnCompletion: false, isDuplicate: false }],
	prompt: 'do the next task',
	loopEnabled: false,
	...over,
});

const mkRun = (over: Partial<ReclaimedAutoRun> = {}): ReclaimedAutoRun => ({
	agentId: 'agent-1',
	config: docConfig(),
	folderPath: '/docs',
	state: { isRunning: true, completedTasks: 1, totalTasks: 4 },
	...over,
});

describe('planAutoRunResume', () => {
	it('resumes a running document run with its own config', () => {
		const run = mkRun();
		expect(planAutoRunResume(run)).toEqual({ kind: 'resume', config: run.config });
	});

	it('does not resume a run the user had asked to stop', () => {
		const plan = planAutoRunResume(mkRun({ state: { isRunning: true, isStopping: true } }));
		expect(plan.kind).toBe('abandon');
	});

	it('does not resume a run paused on an error waiting for the user', () => {
		const plan = planAutoRunResume(mkRun({ state: { isRunning: true, errorPaused: true } }));
		expect(plan.kind).toBe('abandon');
	});

	it('does not resume a run whose config did not survive', () => {
		const plan = planAutoRunResume(mkRun({ config: {} as BatchRunConfig }));
		expect(plan.kind).toBe('abandon');
	});

	it('does not grant a looping run extra passes', () => {
		const plan = planAutoRunResume(
			mkRun({
				config: docConfig({ loopEnabled: true, maxLoops: 3 }),
				state: { isRunning: true, loopIteration: 1 },
			})
		);
		expect(plan).toEqual({
			kind: 'resume',
			config: expect.objectContaining({ maxLoops: 2 }),
		});
	});

	it('always lets the unfinished pass complete', () => {
		const plan = planAutoRunResume(
			mkRun({
				config: docConfig({ loopEnabled: true, maxLoops: 2 }),
				state: { isRunning: true, loopIteration: 5 },
			})
		);
		expect(plan).toEqual({ kind: 'resume', config: expect.objectContaining({ maxLoops: 1 }) });
	});

	it('leaves an unlimited loop unlimited', () => {
		const config = docConfig({ loopEnabled: true, maxLoops: null });
		expect(planAutoRunResume(mkRun({ config }))).toEqual({ kind: 'resume', config });
	});

	it('reduces a goal run by the iterations already spent, and stops at its limit', () => {
		const goalConfig = { goal: 'ship it', exitCriteria: 'done', maxIterations: 5 };
		const config = docConfig({
			documents: [],
			goalConfig: goalConfig as BatchRunConfig['goalConfig'],
		});

		const plan = planAutoRunResume(mkRun({ config, state: { isRunning: true, goalIteration: 2 } }));
		expect(plan.kind).toBe('resume');
		expect(plan.kind === 'resume' && plan.config.goalConfig?.maxIterations).toBe(3);

		expect(
			planAutoRunResume(mkRun({ config, state: { isRunning: true, goalIteration: 5 } })).kind
		).toBe('abandon');
	});
});

describe('waitForOrphanedTaskExit', () => {
	it('waits until no Auto Run task process is left for the agent', async () => {
		const getActive = vi.mocked(window.maestro.process.getActiveProcesses);
		getActive
			.mockResolvedValueOnce([{ sessionId: 'agent-1-batch-123' }] as never)
			.mockRejectedValueOnce(new Error('bridge down'))
			.mockResolvedValueOnce([
				{ sessionId: 'agent-2-batch-9' },
				{ sessionId: 'agent-1-ai-t' },
			] as never);

		await waitForOrphanedTaskExit('agent-1', 0);
		expect(getActive).toHaveBeenCalledTimes(3);
	});
});

describe('reclaimOrphanedAutoRuns', () => {
	const start = vi.fn();

	beforeEach(() => {
		start.mockReset();
		useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
		useSessionStore.setState({
			sessions: [{ id: 'agent-1', name: 'Agent One' } as Session],
		});
		useSettingsStore.setState({ autoRunDisabled: false });
		vi.mocked(window.maestro.process.getActiveProcesses).mockResolvedValue([]);
		vi.mocked(window.maestro.web.abandonAutoRunReclaim).mockClear();
		vi.mocked(window.maestro.web.broadcastAutoRunState).mockClear();
	});

	it('asks main for the runs this client owned and restarts them', async () => {
		const run = mkRun();
		vi.mocked(window.maestro.web.takeOrphanedAutoRuns).mockResolvedValueOnce([run]);

		await reclaimOrphanedAutoRuns(start);

		expect(window.maestro.web.takeOrphanedAutoRuns).toHaveBeenCalledWith(getClientInstanceId());
		expect(start).toHaveBeenCalledWith('agent-1', run.config, '/docs');
	});

	it('drops the replayed mirror so the restart is not refused', async () => {
		useBatchStore.setState({
			batchRunStates: { 'agent-1': { ...DEFAULT_BATCH_STATE, isRunning: true, mirrored: true } },
		});
		vi.mocked(window.maestro.web.takeOrphanedAutoRuns).mockResolvedValueOnce([mkRun()]);
		start.mockImplementation((agentId: string) => {
			expect(useBatchStore.getState().batchRunStates[agentId]).toBeUndefined();
		});

		await reclaimOrphanedAutoRuns(start);
		expect(start).toHaveBeenCalledTimes(1);
	});

	it('hands a run back to main when its agent is gone', async () => {
		vi.mocked(window.maestro.web.takeOrphanedAutoRuns).mockResolvedValueOnce([
			mkRun({ agentId: 'deleted-agent' }),
		]);

		await reclaimOrphanedAutoRuns(start);

		expect(start).not.toHaveBeenCalled();
		expect(window.maestro.web.abandonAutoRunReclaim).toHaveBeenCalledWith(
			'deleted-agent',
			getClientInstanceId()
		);
		// ...and clears it off every other client's screen.
		expect(window.maestro.web.broadcastAutoRunState).toHaveBeenCalledWith('deleted-agent', null);
	});

	it('hands a run back to main when Auto Run is disabled', async () => {
		useSettingsStore.setState({ autoRunDisabled: true });
		vi.mocked(window.maestro.web.takeOrphanedAutoRuns).mockResolvedValueOnce([mkRun()]);

		await reclaimOrphanedAutoRuns(start);

		expect(start).not.toHaveBeenCalled();
		expect(window.maestro.web.abandonAutoRunReclaim).toHaveBeenCalledWith(
			'agent-1',
			getClientInstanceId()
		);
	});

	it('does nothing when main cannot be asked', async () => {
		vi.mocked(window.maestro.web.takeOrphanedAutoRuns).mockRejectedValueOnce(new Error('down'));
		await reclaimOrphanedAutoRuns(start);
		expect(start).not.toHaveBeenCalled();
	});
});
