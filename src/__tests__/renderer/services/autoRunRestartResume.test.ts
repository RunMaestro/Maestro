import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BatchRunConfig, BatchRunState } from '../../../renderer/types';
import { DEFAULT_BATCH_STATE } from '../../../renderer/hooks/batch/batchReducer';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import {
	buildRestartEntries,
	buildResumedConfig,
	noteAutoRunWorkingCopy,
	resetAutoRunRestartTrackingForTests,
	resumeAutoRunsAfterRestart,
	saveAutoRunsForRestart,
	selectResumableAutoRunIds,
	trackAutoRunLaunch,
	untrackAutoRunLaunch,
} from '../../../renderer/services/autoRunRestartResume';
import { AUTO_RUN_RESTART_RESUME_TTL_MS } from '../../../shared/autorunRestartResume';
import { AGENT_MODES, createMockSession, createModeSession } from '../../helpers/mockSession';

const docConfig: BatchRunConfig = {
	documents: [
		{ id: 'd1', filename: 'setup', resetOnCompletion: true, isDuplicate: false },
		{ id: 'd2', filename: 'tasks', resetOnCompletion: false, isDuplicate: false },
	],
	prompt: 'Do the next task',
	loopEnabled: true,
	maxLoops: 5,
};

const goalConfig: BatchRunConfig = {
	documents: [],
	prompt: '',
	loopEnabled: false,
	goalConfig: {
		goal: 'Ship it',
		exitCriteria: '',
		maxIterations: 10,
	} as BatchRunConfig['goalConfig'],
};

function runState(overrides: Partial<BatchRunState> = {}): BatchRunState {
	return { ...DEFAULT_BATCH_STATE, isRunning: true, ...overrides };
}

function setRuns(states: Record<string, BatchRunState>) {
	useBatchStore.setState({ batchRunStates: states });
}

beforeEach(() => {
	resetAutoRunRestartTrackingForTests();
	setRuns({});
	useSessionStore.setState({
		sessions: [
			createMockSession({ id: 'agent-a', name: 'Alpha' }),
			createMockSession({ id: 'agent-b', name: 'Beta' }),
		],
	});
	vi.mocked(window.maestro.autorun.saveRestartResume).mockReset().mockResolvedValue(0);
	vi.mocked(window.maestro.autorun.takeRestartResume).mockReset().mockResolvedValue([]);
});

describe('selectResumableAutoRunIds', () => {
	it('lists only tracked runs this client owns that are not stopping', () => {
		trackAutoRunLaunch('agent-a', docConfig, '/f');
		trackAutoRunLaunch('agent-b', docConfig, '/f');
		trackAutoRunLaunch('mirror', docConfig, '/f');
		const states = {
			'agent-a': runState(),
			'agent-b': runState({ isStopping: true }),
			mirror: runState({ mirrored: true }),
			untracked: runState(),
		};
		expect(selectResumableAutoRunIds(states)).toEqual(['agent-a']);
	});

	it('forgets a run once its runner untracks it', () => {
		trackAutoRunLaunch('agent-a', docConfig, '/f');
		untrackAutoRunLaunch('agent-a');
		expect(selectResumableAutoRunIds({ 'agent-a': runState() })).toEqual([]);
	});
});

describe('buildRestartEntries', () => {
	it('saves the document cursor and the working copy of the current document', () => {
		trackAutoRunLaunch('agent-a', docConfig, '/folder');
		noteAutoRunWorkingCopy('agent-a', 0, 2, 'Runs/setup-loop-3');
		setRuns({ 'agent-a': runState({ currentDocumentIndex: 0, loopIteration: 2 }) });

		const [entry] = buildRestartEntries('update', 42);
		expect(entry).toMatchObject({
			sessionId: 'agent-a',
			sessionName: 'Alpha',
			folderPath: '/folder',
			resumeFrom: { documentIndex: 0, loopIteration: 2, workingCopyPath: 'Runs/setup-loop-3' },
			reason: 'update',
			savedAt: 42,
		});
	});

	it('drops a working copy that belongs to an earlier document or pass', () => {
		trackAutoRunLaunch('agent-a', docConfig, '/folder');
		noteAutoRunWorkingCopy('agent-a', 0, 1, 'Runs/setup-loop-2');
		setRuns({ 'agent-a': runState({ currentDocumentIndex: 1, loopIteration: 1 }) });

		expect(buildRestartEntries('update')[0].resumeFrom).toEqual({
			documentIndex: 1,
			loopIteration: 1,
		});
	});

	it('stores the launch config without the resume point it was started from', () => {
		trackAutoRunLaunch(
			'agent-a',
			{ ...docConfig, resumeFrom: { documentIndex: 1, loopIteration: 0 } },
			'/folder'
		);
		setRuns({ 'agent-a': runState() });
		expect(buildRestartEntries('update')[0].config).not.toHaveProperty('resumeFrom');
	});

	it('counts finished goal iterations, not the one in flight', () => {
		trackAutoRunLaunch('agent-a', goalConfig, '/folder');
		setRuns({ 'agent-a': runState({ goalMode: true, goalIteration: 4 }) });
		expect(buildRestartEntries('update')[0].goalIterationsCompleted).toBe(3);
	});
});

describe('saveAutoRunsForRestart', () => {
	it('does not touch main when nothing is running', async () => {
		expect(await saveAutoRunsForRestart('update')).toBe(0);
		expect(window.maestro.autorun.saveRestartResume).not.toHaveBeenCalled();
	});

	it('sends every resumable run to main', async () => {
		vi.mocked(window.maestro.autorun.saveRestartResume).mockResolvedValue(1);
		trackAutoRunLaunch('agent-a', docConfig, '/folder');
		setRuns({ 'agent-a': runState() });

		expect(await saveAutoRunsForRestart('update')).toBe(1);
		const [entries] = vi.mocked(window.maestro.autorun.saveRestartResume).mock.calls[0];
		expect(entries.map((e) => e.sessionId)).toEqual(['agent-a']);
	});

	it('rejects when main cannot save, so the caller can cancel the restart', async () => {
		vi.mocked(window.maestro.autorun.saveRestartResume).mockRejectedValue(new Error('disk full'));
		trackAutoRunLaunch('agent-a', docConfig, '/folder');
		setRuns({ 'agent-a': runState() });
		await expect(saveAutoRunsForRestart('update')).rejects.toThrow('disk full');
	});
});

describe('buildResumedConfig', () => {
	const base = {
		sessionId: 'agent-a',
		folderPath: '/folder',
		resumeFrom: { documentIndex: 1, loopIteration: 2 },
		savedAt: 0,
	};

	it('hands a document run its resume point', () => {
		expect(buildResumedConfig({ ...base, config: docConfig }).resumeFrom).toEqual({
			documentIndex: 1,
			loopIteration: 2,
		});
	});

	it('hands a goal run its remaining iteration budget instead', () => {
		const resumed = buildResumedConfig({ ...base, config: goalConfig, goalIterationsCompleted: 3 });
		expect(resumed.goalConfig?.maxIterations).toBe(7);
		expect(resumed).not.toHaveProperty('resumeFrom');
	});
});

describe('resumeAutoRunsAfterRestart', () => {
	const saved = (sessionId: string, savedAt: number) => ({
		sessionId,
		sessionName: sessionId,
		folderPath: '/folder',
		config: docConfig,
		resumeFrom: { documentIndex: 1, loopIteration: 0 },
		savedAt,
	});

	it('starts each saved run at its resume point without waiting for it to finish', async () => {
		const now = 10_000;
		vi.mocked(window.maestro.autorun.takeRestartResume).mockResolvedValue([saved('agent-a', now)]);
		// A run promise that never settles: the resume must not block on it.
		const startBatchRun = vi.fn(() => new Promise<void>(() => {}));

		expect(await resumeAutoRunsAfterRestart(startBatchRun, now)).toBe(1);
		expect(startBatchRun).toHaveBeenCalledWith(
			'agent-a',
			expect.objectContaining({ resumeFrom: { documentIndex: 1, loopIteration: 0 } }),
			'/folder'
		);
	});

	it('skips stale entries, deleted agents, and agents already running Auto Run', async () => {
		const now = AUTO_RUN_RESTART_RESUME_TTL_MS * 3;
		vi.mocked(window.maestro.autorun.takeRestartResume).mockResolvedValue([
			saved('agent-a', 0),
			saved('gone', now),
			saved('agent-b', now),
		]);
		setRuns({ 'agent-b': runState() });
		const startBatchRun = vi.fn().mockResolvedValue(undefined);

		expect(await resumeAutoRunsAfterRestart(startBatchRun, now)).toBe(0);
		expect(startBatchRun).not.toHaveBeenCalled();
		const titles = useNotificationStore.getState().toasts.map((t) => t.title);
		expect(titles).toContain('Auto Run Not Resumed');
	});
});

/**
 * docs/parity/agent-ux-parity.md, "Restore prompts on launch": a run saved before a
 * restart comes back with the same entry, the same start, and the same toast whether
 * its agent is local, SSH, or hosted.
 */
describe('restart resume: mode parity (local, SSH, hosted)', () => {
	async function restartIn(mode: (typeof AGENT_MODES)[number]) {
		resetAutoRunRestartTrackingForTests();
		useNotificationStore.setState({ toasts: [] });
		useSessionStore.setState({
			sessions: [createModeSession(mode, { id: 'agent-a', name: 'Alpha' })],
		});
		trackAutoRunLaunch('agent-a', docConfig, '/folder');
		setRuns({ 'agent-a': runState({ currentDocumentIndex: 1 }) });
		const entries = buildRestartEntries('update', 5_000);

		setRuns({});
		vi.mocked(window.maestro.autorun.takeRestartResume).mockResolvedValue(entries);
		const startBatchRun = vi.fn().mockResolvedValue(undefined);
		const resumed = await resumeAutoRunsAfterRestart(startBatchRun, 5_000);
		const toasts = useNotificationStore
			.getState()
			.toasts.map(({ type, title, message }) => ({ type, title, message }));
		return { entries, resumed, starts: startBatchRun.mock.calls, toasts };
	}

	it('saves, restarts, and announces the run the same way in every mode', async () => {
		const [local, ssh, hosted] = [
			await restartIn('local'),
			await restartIn('ssh'),
			await restartIn('hosted'),
		];
		expect(local.resumed).toBe(1);
		expect(local.toasts.map((t) => t.title)).toEqual(['Auto Run Resumed']);
		expect(ssh).toEqual(local);
		expect(hosted).toEqual(local);
	});
});
