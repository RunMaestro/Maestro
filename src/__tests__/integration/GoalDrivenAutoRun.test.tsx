/**
 * @file GoalDrivenAutoRun.test.tsx
 * @description End-to-end-ish integration test for Goal-Driven Auto Run.
 *
 * Drives a goal run through the *public* `useBatchProcessor.startBatchRun` entry
 * point - the same surface the UI calls - with a `goalConfig` and a mocked agent
 * whose `<!-- maestro:progress N -->` markers climb to 100%. Unlike the focused
 * `useGoalRunner` unit test, this exercises the full routing + reducer +
 * broadcast + time-tracking wiring and asserts the externally observable
 * contract:
 *   - state transitions to running (`goalMode` + `isRunning`)
 *   - `goalProgress` updates after each iteration
 *   - the run completes with `goalExitReason: 'completed'`
 *   - `onComplete` fires exactly once
 * A second scenario drives a flat run and asserts the `stalled` exit.
 *
 * Modeled on src/__tests__/integration/AutoRunBatchProcessing.test.tsx, but
 * driving the hook (per src/__tests__/renderer/hooks/batch/useGoalRunner.test.ts)
 * rather than a rendered component, since the contract under test is the
 * processor's state machine, not the AutoRun view.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Session, BatchRunConfig } from '../../renderer/types';
import { useBatchProcessor } from '../../renderer/hooks';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { useBatchStore } from '../../renderer/stores/batchStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { createMockGroup } from '../helpers/mockGroup';
import { createMockSession as baseCreateMockSession } from '../helpers/mockSession';
import type { GoalExitReason } from '../../shared/goalDriven/types';

// Mock notifyToast so toasts don't blow up during the run.
const { mockNotifyToast } = vi.hoisted(() => ({ mockNotifyToast: vi.fn() }));
vi.mock('../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => mockNotifyToast(...args),
}));

const SESSION_ID = 'goal-integration-session';

type SpawnResult = {
	success: boolean;
	response?: string;
	agentSessionId?: string;
};

/** Build a `<!-- maestro:progress N -->` agent response string. */
function progressResponse(n: number, rationale = 'iteration work'): string {
	return `Synopsis: did work toward ${n}%.\n\n<!-- maestro:progress ${n} | ${rationale} -->`;
}

describe('Goal-Driven Auto Run (integration via useBatchProcessor)', () => {
	const createMockSession = (overrides?: Partial<Session>): Session =>
		baseCreateMockSession({
			id: SESSION_ID,
			name: 'Goal Session',
			cwd: '/test/path',
			fullPath: '/test/path',
			projectRoot: '/test/path',
			isGitRepo: false, // skip the git-branch fetch path
			...overrides,
		});

	const goalConfig = (
		goal: string,
		exitCriteria: string,
		maxIterations: number | null
	): BatchRunConfig => ({
		documents: [],
		prompt: '',
		loopEnabled: false,
		goalConfig: { goal, exitCriteria, maxIterations },
	});

	let mockOnUpdateSession: ReturnType<typeof vi.fn>;
	let mockOnSpawnAgent: ReturnType<typeof vi.fn>;
	let mockOnAddHistoryEntry: ReturnType<typeof vi.fn>;
	let mockOnComplete: ReturnType<typeof vi.fn>;

	const renderProcessor = () => {
		const sessions = [createMockSession()];
		useSessionStore.setState({ sessions, activeSessionId: SESSION_ID } as never);
		return renderHook(() =>
			useBatchProcessor({
				sessions,
				groups: [createMockGroup({ id: 'test-group-id', emoji: '🎯' })],
				onUpdateSession: mockOnUpdateSession,
				onSpawnAgent: mockOnSpawnAgent,
				onAddHistoryEntry: mockOnAddHistoryEntry,
				onComplete: mockOnComplete,
			})
		);
	};

	/** The final-summary History entry (its summary starts with an exit-reason label). */
	const finalSummaryEntry = () =>
		mockOnAddHistoryEntry.mock.calls
			.map((call) => call[0])
			.find(
				(entry) =>
					typeof entry?.summary === 'string' &&
					entry.summary.startsWith('Goal ') &&
					!entry.summary.startsWith('Goal progress:')
			);

	/**
	 * Record the (deduped) `goalProgress` series and every `goalExitReason` the
	 * store passes through. `goalExitReason` is set immediately before
	 * COMPLETE_BATCH wipes it, so a live subscription is the reliable way to
	 * observe the transient value.
	 */
	const trackBatchState = () => {
		const progressSeen: number[] = [];
		const exitReasonsSeen: Array<GoalExitReason | undefined> = [];
		const unsubscribe = useBatchStore.subscribe((state) => {
			const s = state.batchRunStates[SESSION_ID];
			if (!s) return;
			if (
				typeof s.goalProgress === 'number' &&
				progressSeen[progressSeen.length - 1] !== s.goalProgress
			) {
				progressSeen.push(s.goalProgress);
			}
			if (s.goalExitReason !== undefined) {
				exitReasonsSeen.push(s.goalExitReason);
			}
		});
		return { progressSeen, exitReasonsSeen, unsubscribe };
	};

	beforeEach(() => {
		useSettingsStore.setState({ autoRunDisabled: false });
		useBatchStore.setState({ batchRunStates: {} });

		mockOnUpdateSession = vi.fn();
		mockOnAddHistoryEntry = vi.fn();
		mockOnComplete = vi.fn();
		mockOnSpawnAgent = vi.fn();

		window.maestro = {
			...window.maestro,
			prompts: {
				...window.maestro.prompts,
				get: vi.fn().mockResolvedValue({
					success: true,
					content: 'Goal: {{GOAL}}\nExit: {{GOAL_EXIT_CRITERIA}}\nIteration: {{LOOP_NUMBER}}',
				}),
			},
			agentSessions: {
				...window.maestro.agentSessions,
				registerSessionOrigin: vi.fn().mockResolvedValue(undefined),
			},
			power: {
				addReason: vi.fn(),
				removeReason: vi.fn(),
				setEnabled: vi.fn(),
				isEnabled: vi.fn().mockResolvedValue(true),
				getStatus: vi
					.fn()
					.mockResolvedValue({ enabled: true, blocking: false, reasons: [], platform: 'darwin' }),
			},
		};
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('drives a goal to completion: running -> progress per iteration -> completed, onComplete once', async () => {
		// Deferred agent: each spawn returns a pending promise we resolve by hand,
		// so we can observe the running state and assert progress after each step.
		const resolvers: Array<(value: SpawnResult) => void> = [];
		mockOnSpawnAgent.mockImplementation(
			() => new Promise<SpawnResult>((resolve) => resolvers.push(resolve))
		);

		const { progressSeen, exitReasonsSeen, unsubscribe } = trackBatchState();

		try {
			const { result } = renderProcessor();

			let finished = false;
			act(() => {
				void result.current
					.startBatchRun(
						SESSION_ID,
						goalConfig('Ship the feature', 'All tests pass', null),
						'/test/folder'
					)
					.then(() => {
						finished = true;
					});
			});

			// 1) State transitions to running before the first spawn resolves.
			await waitFor(() => expect(mockOnSpawnAgent).toHaveBeenCalledTimes(1));
			const running = result.current.getBatchState(SESSION_ID);
			expect(running.isRunning).toBe(true);
			expect(running.goalMode).toBe(true);

			// 2) goalProgress updates after each iteration: 30 -> 70 -> 100.
			await act(async () => {
				resolvers[0]({ success: true, agentSessionId: 'a1', response: progressResponse(30) });
			});
			await waitFor(() => expect(mockOnSpawnAgent).toHaveBeenCalledTimes(2));
			expect(result.current.getBatchState(SESSION_ID).goalProgress).toBe(30);

			await act(async () => {
				resolvers[1]({ success: true, agentSessionId: 'a2', response: progressResponse(70) });
			});
			await waitFor(() => expect(mockOnSpawnAgent).toHaveBeenCalledTimes(3));
			expect(result.current.getBatchState(SESSION_ID).goalProgress).toBe(70);

			// 3) Final iteration reports 100% and the run completes.
			await act(async () => {
				resolvers[2]({ success: true, agentSessionId: 'a3', response: progressResponse(100) });
			});
			await waitFor(() => expect(finished).toBe(true));

			// Progress climbed 0 (seed) -> 30 -> 70 -> 100 across iterations.
			expect(progressSeen).toEqual([0, 30, 70, 100]);

			// Completed exit reason was recorded before COMPLETE_BATCH reset the state.
			expect(exitReasonsSeen).toContain('completed');
			const summary = finalSummaryEntry();
			expect(summary?.summary).toContain('Goal completed');
			expect(summary?.success).toBe(true);

			// Run finished and onComplete fired exactly once with the 100/100 result.
			expect(result.current.getBatchState(SESSION_ID).isRunning).toBe(false);
			expect(mockOnComplete).toHaveBeenCalledTimes(1);
			expect(mockOnComplete).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: SESSION_ID,
					completedTasks: 100,
					totalTasks: 100,
					wasStopped: false,
				})
			);
		} finally {
			unsubscribe();
		}
	});

	it('stops a flat run with goalExitReason "stalled" and fires onComplete once', async () => {
		// Agent never moves the needle off 50% - STALL_THRESHOLD (3) flat
		// iterations must trip the stall exit instead of looping forever.
		mockOnSpawnAgent.mockResolvedValue({
			success: true,
			agentSessionId: 'flat-agent',
			response: progressResponse(50, 'no movement'),
		});

		const { exitReasonsSeen, unsubscribe } = trackBatchState();

		try {
			const { result } = renderProcessor();

			await act(async () => {
				await result.current.startBatchRun(
					SESSION_ID,
					goalConfig('Stuck goal', 'Done when X', null),
					'/test/folder'
				);
			});

			// Stall trips on the third flat iteration.
			expect(mockOnSpawnAgent).toHaveBeenCalledTimes(3);
			expect(exitReasonsSeen).toContain('stalled');

			const summary = finalSummaryEntry();
			expect(summary?.summary).toContain('stalled');
			expect(summary?.success).toBe(false);

			expect(result.current.getBatchState(SESSION_ID).isRunning).toBe(false);
			expect(mockOnComplete).toHaveBeenCalledTimes(1);
			expect(mockOnComplete).toHaveBeenCalledWith(expect.objectContaining({ wasStopped: false }));
		} finally {
			unsubscribe();
		}
	});
});
