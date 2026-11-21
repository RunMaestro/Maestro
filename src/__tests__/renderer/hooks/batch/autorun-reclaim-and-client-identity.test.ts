// Source: src/__tests__/renderer/hooks/batch/playbookAutoName.test.ts
// Source: src/__tests__/renderer/hooks/batch/useAutoRunReclaim.test.ts
// Source: src/__tests__/renderer/utils/clientInstance.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { autoPlaybookName } from '../../../../renderer/hooks/batch/usePlaybookManagement';
import { extractPlaybookCodename } from '../../../../renderer/hooks/batch/usePlaybookManagement';
import { beforeEach } from 'vitest';
import { vi } from 'vitest';
import { planAutoRunResume } from '../../../../renderer/hooks/batch/useAutoRunReclaim';
import { reclaimOrphanedAutoRuns } from '../../../../renderer/hooks/batch/useAutoRunReclaim';
import { waitForOrphanedTaskExit } from '../../../../renderer/hooks/batch/useAutoRunReclaim';
import type { ReclaimedAutoRun } from '../../../../renderer/hooks/batch/useAutoRunReclaim';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import { getClientInstanceId } from '../../../../renderer/utils/clientInstance';
import type { BatchRunConfig } from '../../../../renderer/types';
import type { Session } from '../../../../renderer/types';
import { afterEach } from 'vitest';
import { isReloadedClientInstance } from '../../../../renderer/utils/clientInstance';
import { resetClientInstanceForTests } from '../../../../renderer/utils/clientInstance';

describeSourceSuite('playbookAutoName', () => {
	describe('extractPlaybookCodename', () => {
		it('uses the dated folder, minus its date', () => {
			expect(extractPlaybookCodename('2026-09-25-Desktop-Apps/CONTEXT')).toBe('Desktop-Apps');
			expect(extractPlaybookCodename('2026-09-26-Census-Dashboard-V2/CENSUS-V2-02.md')).toBe(
				'Census-Dashboard-V2'
			);
		});

		it('uses a flat file name, minus date and phase number', () => {
			expect(extractPlaybookCodename('Auth-Rewrite-01')).toBe('Auth-Rewrite');
			expect(extractPlaybookCodename('2026-01-02-Auth-Rewrite-03.md')).toBe('Auth-Rewrite');
			expect(extractPlaybookCodename('notes')).toBe('notes');
		});

		it('falls back when nothing is left', () => {
			expect(extractPlaybookCodename('2026-01-02')).toBe('Playbook');
			expect(extractPlaybookCodename('')).toBe('Playbook');
		});
	});

	describe('autoPlaybookName', () => {
		const now = new Date(2026, 8, 6, 23, 30);

		it('stamps the local date', () => {
			expect(autoPlaybookName('2026-09-25-Desktop-Apps/CONTEXT', [], now)).toBe(
				'2026-09-06-Desktop-Apps'
			);
		});

		it('suffixes a name that is already taken', () => {
			const taken = ['2026-09-06-Desktop-Apps', '2026-09-06-Desktop-Apps-2'];
			expect(autoPlaybookName('Desktop-Apps-01', taken, now)).toBe('2026-09-06-Desktop-Apps-3');
		});
	});
});
describeSourceSuite('useAutoRunReclaim', () => {
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

			const plan = planAutoRunResume(
				mkRun({ config, state: { isRunning: true, goalIteration: 2 } })
			);
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
				sessions: [{ id: 'agent-1', name: 'Agent One', aiTabs: [] } as Session],
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

		it('releases the run when the restart returns without claiming it', async () => {
			vi.mocked(window.maestro.web.takeOrphanedAutoRuns).mockResolvedValueOnce([mkRun()]);
			// Main still holds the reclaim, so the restart never claimed the run.
			vi.mocked(window.maestro.web.abandonAutoRunReclaim).mockResolvedValueOnce(true);

			await reclaimOrphanedAutoRuns(start);

			expect(start).toHaveBeenCalledTimes(1);
			expect(window.maestro.web.abandonAutoRunReclaim).toHaveBeenCalledWith(
				'agent-1',
				getClientInstanceId()
			);
			expect(window.maestro.web.broadcastAutoRunState).toHaveBeenCalledWith('agent-1', null);
		});

		it('leaves a run the restart claimed alone', async () => {
			vi.mocked(window.maestro.web.takeOrphanedAutoRuns).mockResolvedValueOnce([mkRun()]);
			// The claim cleared the pending reclaim, so main has nothing to abandon.
			vi.mocked(window.maestro.web.abandonAutoRunReclaim).mockResolvedValueOnce(false);

			await reclaimOrphanedAutoRuns(start);

			expect(start).toHaveBeenCalledTimes(1);
			expect(window.maestro.web.broadcastAutoRunState).not.toHaveBeenCalled();
		});

		it('releases the run when the restart throws', async () => {
			vi.mocked(window.maestro.web.takeOrphanedAutoRuns).mockResolvedValueOnce([mkRun()]);
			vi.mocked(window.maestro.web.abandonAutoRunReclaim).mockResolvedValueOnce(true);
			start.mockRejectedValueOnce(new Error('claim refused'));

			await expect(reclaimOrphanedAutoRuns(start)).rejects.toThrow('claim refused');

			expect(window.maestro.web.abandonAutoRunReclaim).toHaveBeenCalledWith(
				'agent-1',
				getClientInstanceId()
			);
			expect(window.maestro.web.broadcastAutoRunState).toHaveBeenCalledWith('agent-1', null);
		});

		it('does nothing when main cannot be asked', async () => {
			vi.mocked(window.maestro.web.takeOrphanedAutoRuns).mockRejectedValueOnce(new Error('down'));
			await reclaimOrphanedAutoRuns(start);
			expect(start).not.toHaveBeenCalled();
		});
	});
});
describe('clientInstance', () => {
	const KEY = 'maestro:clientInstanceId';

	function mockNavigationType(type: string): void {
		vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
			{ type } as unknown as PerformanceEntry,
		]);
	}

	describe('clientInstance', () => {
		beforeEach(() => {
			sessionStorage.clear();
			resetClientInstanceForTests();
		});

		afterEach(() => {
			vi.restoreAllMocks();
			delete (document as Document & { wasDiscarded?: boolean }).wasDiscarded;
		});

		it('mints and remembers an id on a fresh page', () => {
			mockNavigationType('navigate');
			const id = getClientInstanceId();
			expect(id).toBeTruthy();
			expect(getClientInstanceId()).toBe(id);
			expect(sessionStorage.getItem(KEY)).toBe(id);
			expect(isReloadedClientInstance()).toBe(false);
		});

		it('keeps the id across a reload of the same tab', () => {
			sessionStorage.setItem(KEY, 'tab-before-reload');
			mockNavigationType('reload');
			expect(getClientInstanceId()).toBe('tab-before-reload');
			expect(isReloadedClientInstance()).toBe(true);
		});

		it('keeps the id when the browser restores a discarded tab', () => {
			sessionStorage.setItem(KEY, 'tab-before-discard');
			mockNavigationType('navigate');
			(document as Document & { wasDiscarded?: boolean }).wasDiscarded = true;
			expect(getClientInstanceId()).toBe('tab-before-discard');
			expect(isReloadedClientInstance()).toBe(true);
		});

		it('mints a fresh id for a duplicated tab, which inherits sessionStorage without reloading', () => {
			sessionStorage.setItem(KEY, 'parent-tab');
			mockNavigationType('navigate');
			expect(getClientInstanceId()).not.toBe('parent-tab');
			expect(isReloadedClientInstance()).toBe(false);
		});

		it('is not a reload when there was no earlier id', () => {
			mockNavigationType('reload');
			expect(isReloadedClientInstance()).toBe(false);
		});
	});
});
