/**
 * Tests for the Goal-Driven Auto Run engine (useGoalRunner), exercised through
 * the public useBatchProcessor hook so the real routing, reducer, broadcast, and
 * time-tracking wiring is in play (mirrors the approach in
 * useBatchProcessor.test.ts). The agent is mocked via onSpawnAgent returning a
 * scripted sequence of responses whose `<!-- maestro:... -->` markers drive the
 * loop. See src/shared/goalDriven/* for the pure parser/evaluator under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Session, Group, BatchRunConfig } from '../../../../renderer/types';
import { useBatchProcessor } from '../../../../renderer/hooks';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { createMockSession as baseCreateMockSession } from '../../../helpers/mockSession';
import { GOAL_RUN_HARD_ITERATION_CAP } from '../../../../shared/goalDriven/types';
import { GOAL_SYNOPSIS_REQUEST_PROMPT } from '../../../../shared/goalDriven/goalHandoff';
import {
	setCapabilitiesCache,
	clearCapabilitiesCache,
	DEFAULT_CAPABILITIES,
} from '../../../../renderer/hooks/agent/useAgentCapabilities';

// Mock notifyToast so toasts don't blow up and can be inspected if needed.
const { mockNotifyToast } = vi.hoisted(() => ({ mockNotifyToast: vi.fn() }));
vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => mockNotifyToast(...args),
}));

const SESSION_ID = 'test-session-id';

/** Build a `<!-- maestro:progress N | rationale -->` response string. */
function progressResponse(n: number, rationale?: string): string {
	const marker = rationale
		? `<!-- maestro:progress ${n} | ${rationale} -->`
		: `<!-- maestro:progress ${n} -->`;
	return `Synopsis: did work toward iteration ${n}.\n\n${marker}`;
}

describe('useGoalRunner (Goal-Driven Auto Run engine)', () => {
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

	const createMockGroup = (overrides?: Partial<Group>): Group => ({
		id: 'test-group-id',
		name: 'Test Group',
		collapsed: false,
		...overrides,
	});

	let mockOnUpdateSession: ReturnType<typeof vi.fn>;
	let mockOnSpawnAgent: ReturnType<typeof vi.fn>;
	let mockSpawnBackgroundSynopsis: ReturnType<typeof vi.fn>;
	let mockOnAddHistoryEntry: ReturnType<typeof vi.fn>;
	let mockOnComplete: ReturnType<typeof vi.fn>;
	let mockPowerAddReason: ReturnType<typeof vi.fn>;
	let mockPowerRemoveReason: ReturnType<typeof vi.fn>;

	/** Build a goal-mode BatchRunConfig. */
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

	const renderProcessor = (sessions: Session[], groups: Group[]) =>
		renderHook(() =>
			useBatchProcessor({
				sessions,
				groups,
				onUpdateSession: mockOnUpdateSession,
				onSpawnAgent: mockOnSpawnAgent,
				spawnBackgroundSynopsis: mockSpawnBackgroundSynopsis,
				onAddHistoryEntry: mockOnAddHistoryEntry,
				onComplete: mockOnComplete,
			})
		);

	/**
	 * Find the final-summary history entry. Per-iteration entries now lead with
	 * "Goal progress: N% — …", so the final summary is the "Goal …" entry that is
	 * NOT a per-iteration progress line (its prefix comes from `exitReasonLabel`,
	 * e.g. "Goal completed", "Goal run stalled").
	 */
	const finalSummaryEntry = () =>
		mockOnAddHistoryEntry.mock.calls
			.map((call) => call[0])
			.find(
				(entry) =>
					typeof entry?.summary === 'string' &&
					entry.summary.startsWith('Goal ') &&
					!entry.summary.startsWith('Goal progress:')
			);

	beforeEach(() => {
		useSettingsStore.setState({ autoRunDisabled: false });

		// Warm the capability cache so the between-iteration handoff path (gated on
		// supportsResume) is exercised, matching production where agent detection
		// populates this at startup.
		setCapabilitiesCache('claude-code', { ...DEFAULT_CAPABILITIES, supportsResume: true });

		mockOnUpdateSession = vi.fn();
		mockOnAddHistoryEntry = vi.fn();
		mockOnComplete = vi.fn();
		mockOnSpawnAgent = vi.fn().mockResolvedValue({
			success: true,
			agentSessionId: 'goal-agent-session',
			response: progressResponse(100, 'done'),
		});
		mockSpawnBackgroundSynopsis = vi.fn().mockResolvedValue({
			success: true,
			agentSessionId: 'goal-agent-session',
			response: 'Handoff: data layer migrated; wire up the UI next.',
		});
		mockPowerAddReason = vi.fn();
		mockPowerRemoveReason = vi.fn();

		window.maestro = {
			...window.maestro,
			prompts: {
				...window.maestro.prompts,
				get: vi.fn().mockResolvedValue({
					success: true,
					content:
						'Goal: {{GOAL}}\nExit: {{GOAL_EXIT_CRITERIA}}\nIteration: {{LOOP_NUMBER}}\n{{PREDECESSOR_HANDOFF}}',
				}),
			},
			web: {
				...window.maestro.web,
				broadcastAutoRunState: vi.fn(),
			},
			agentSessions: {
				...window.maestro.agentSessions,
				registerSessionOrigin: vi.fn().mockResolvedValue(undefined),
			},
			power: {
				addReason: mockPowerAddReason,
				removeReason: mockPowerRemoveReason,
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
		clearCapabilitiesCache();
	});

	it('writes an immediate start marker recording the goal and exit criteria', async () => {
		mockOnSpawnAgent.mockResolvedValue({
			success: true,
			agentSessionId: 'goal-agent',
			response: progressResponse(100, 'done'),
		});

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Ship the feature', 'All tests pass', 10),
				'/test/folder'
			);
		});

		// The very first history entry is the start marker (before any iteration).
		const firstEntry = mockOnAddHistoryEntry.mock.calls[0][0];
		expect(firstEntry.type).toBe('AUTO');
		expect(firstEntry.summary).toBe('Goal-Driven Auto Run started');
		expect(firstEntry.sessionId).toBe(SESSION_ID);
		// Documents both driving prompts.
		expect(firstEntry.fullResponse).toContain('**Goal:** Ship the feature');
		expect(firstEntry.fullResponse).toContain('**Exit Criteria:** All tests pass');
		expect(firstEntry.fullResponse).toContain('**Iteration Limit:** 10');
		// Start marker carries no pass/fail flag.
		expect(firstEntry.success).toBeUndefined();
		// Its timestamp matches the run start (also seeded into the batch state).
		expect(typeof firstEntry.timestamp).toBe('number');
	});

	it('marks an empty exit criteria as "(none specified)" and an infinite limit', async () => {
		mockOnSpawnAgent.mockResolvedValue({
			success: true,
			agentSessionId: 'goal-agent',
			response: progressResponse(100, 'done'),
		});

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Just ship it', '   ', null),
				'/test/folder'
			);
		});

		const firstEntry = mockOnAddHistoryEntry.mock.calls[0][0];
		expect(firstEntry.fullResponse).toContain('**Exit Criteria:** _(none specified)_');
		expect(firstEntry.fullResponse).toContain('**Iteration Limit:** Infinite');
	});

	it('climbs to 100% across iterations and exits "completed"', async () => {
		const responses = [
			progressResponse(30, 'scaffolded'),
			progressResponse(70, 'data layer migrated'),
			progressResponse(100, 'feature complete'),
		];
		let call = 0;
		mockOnSpawnAgent.mockImplementation(async () => ({
			success: true,
			agentSessionId: `goal-agent-${call}`,
			response: responses[call++],
		}));

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Ship the feature', 'All tests pass and the feature works', null),
				'/test/folder'
			);
		});

		// Three iterations: 30 -> 70 -> 100, then stop.
		expect(mockOnSpawnAgent).toHaveBeenCalledTimes(3);

		// Per-iteration entries lead with the goal percent + rationale, and keep the
		// agent's full output (which begins with its synopsis) as the body.
		const iterationEntries = mockOnAddHistoryEntry.mock.calls
			.map((call) => call[0])
			.filter((entry) => entry?.summary?.startsWith('Goal progress:'));
		expect(iterationEntries[0].summary).toBe('Goal progress: 30% — scaffolded');
		expect(iterationEntries[1].summary).toBe('Goal progress: 70% — data layer migrated');

		// The internal `<!-- maestro:... -->` control markers are stripped from the
		// stored body so they can never leak into any history render surface.
		for (const entry of iterationEntries) {
			expect(entry.fullResponse).not.toContain('<!-- maestro:');
		}

		// Final summary entry reflects completion.
		const summary = finalSummaryEntry();
		expect(summary).toBeDefined();
		expect(summary.summary).toContain('Goal completed');
		expect(summary.summary).toContain('100%');
		expect(summary.success).toBe(true);

		// onComplete fired with the goal's 100/100 progress and not stopped.
		expect(mockOnComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: SESSION_ID,
				completedTasks: 100,
				totalTasks: 100,
				wasStopped: false,
			})
		);

		// COMPLETE_BATCH reset the state.
		expect(result.current.getBatchState(SESSION_ID).isRunning).toBe(false);
	});

	it('captures a predecessor handoff and threads it into the next iteration prompt', async () => {
		const responses = [progressResponse(40, 'phase 1'), progressResponse(100, 'done')];
		let call = 0;
		mockOnSpawnAgent.mockImplementation(async () => ({
			success: true,
			agentSessionId: `goal-agent-${call}`,
			response: responses[call++],
		}));
		mockSpawnBackgroundSynopsis.mockResolvedValue({
			success: true,
			agentSessionId: 'goal-agent-0',
			// Include a marker to prove it gets stripped from the injected blurb.
			response: 'Migrated the data layer; UI still pending.\n\n<!-- maestro:progress 40 -->',
		});

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Ship the feature', 'All tests pass', null),
				'/test/folder'
			);
		});

		// Two iterations; the handoff resume fires once (after the first, continuing).
		expect(mockOnSpawnAgent).toHaveBeenCalledTimes(2);
		expect(mockSpawnBackgroundSynopsis).toHaveBeenCalledTimes(1);

		// The handoff request resumes the first iteration's session with the synopsis prompt.
		const [sid, , resumeAgentSessionId, handoffPrompt] = mockSpawnBackgroundSynopsis.mock.calls[0];
		expect(sid).toBe(SESSION_ID);
		expect(resumeAgentSessionId).toBe('goal-agent-0');
		expect(handoffPrompt).toBe(GOAL_SYNOPSIS_REQUEST_PROMPT);

		// First iteration prompt has no predecessor block; the second carries the note
		// (with the maestro marker stripped).
		const firstPrompt = mockOnSpawnAgent.mock.calls[0][1] as string;
		const secondPrompt = mockOnSpawnAgent.mock.calls[1][1] as string;
		expect(firstPrompt).not.toContain('Handoff From Your Predecessor');
		expect(secondPrompt).toContain('Handoff From Your Predecessor');
		expect(secondPrompt).toContain('Migrated the data layer; UI still pending.');
		expect(secondPrompt).not.toContain('<!-- maestro:');
	});

	it('does not request a handoff when the agent cannot resume', async () => {
		setCapabilitiesCache('claude-code', { ...DEFAULT_CAPABILITIES, supportsResume: false });
		const responses = [progressResponse(40, 'phase 1'), progressResponse(100, 'done')];
		let call = 0;
		mockOnSpawnAgent.mockImplementation(async () => ({
			success: true,
			agentSessionId: `goal-agent-${call}`,
			response: responses[call++],
		}));

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Ship the feature', 'All tests pass', null),
				'/test/folder'
			);
		});

		expect(mockSpawnBackgroundSynopsis).not.toHaveBeenCalled();
	});

	it('never lets the displayed percent regress when the agent self-report dips', async () => {
		// The agent's self-assessment is noisy: it claims 55% then walks it back to
		// 35%. The displayed percent (history headline + batch state) must be a
		// monotonic high-water mark - 30 -> 55 -> 55 -> 100 - never sliding backward.
		const responses = [
			progressResponse(30, 'scaffolded'),
			progressResponse(55, 'overconfident estimate'),
			progressResponse(35, 'walked it back'),
			progressResponse(100, 'actually done'),
		];
		let call = 0;
		mockOnSpawnAgent.mockImplementation(async () => ({
			success: true,
			agentSessionId: `goal-agent-${call}`,
			response: responses[call++],
		}));

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Ship the feature', 'All tests pass', null),
				'/test/folder'
			);
		});

		// All four iterations ran (the 35% dip is not a completion/stall signal:
		// the raw series 30->55->35 still has an upward tick, so no stall fires).
		expect(mockOnSpawnAgent).toHaveBeenCalledTimes(4);

		const iterationPercents = mockOnAddHistoryEntry.mock.calls
			.map((c) => c[0])
			.filter((entry) => entry?.summary?.startsWith('Goal progress:'))
			.map((entry) => Number(entry.summary.match(/Goal progress: (\d+)%/)?.[1]));

		// Displayed percents climb monotonically - the 35% raw dip surfaces as 55%.
		expect(iterationPercents).toEqual([30, 55, 55, 100]);
		for (let i = 1; i < iterationPercents.length; i++) {
			expect(iterationPercents[i]).toBeGreaterThanOrEqual(iterationPercents[i - 1]);
		}

		// onComplete reports the high-water 100%, not the agent's last dip.
		expect(mockOnComplete).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: SESSION_ID, completedTasks: 100, wasStopped: false })
		);
	});

	it('commits each iteration when the session is a git repo', async () => {
		const responses = [progressResponse(40, 'staged the schema'), progressResponse(100, 'done')];
		let call = 0;
		mockOnSpawnAgent.mockImplementation(async () => ({
			success: true,
			agentSessionId: `goal-agent-${call}`,
			response: responses[call++],
		}));

		const { result } = renderProcessor(
			[createMockSession({ isGitRepo: true })],
			[createMockGroup()]
		);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Ship it', 'All tests pass', null),
				'/test/path'
			);
		});

		const commitAll = window.maestro.git.commitAll as ReturnType<typeof vi.fn>;
		// One commit per iteration (2 iterations: 40% then 100%).
		expect(commitAll).toHaveBeenCalledTimes(2);
		// Commits run in the session cwd with an iteration-stamped message.
		expect(commitAll).toHaveBeenNthCalledWith(
			1,
			'/test/path',
			'Maestro Auto Run (goal) iteration 1 - staged the schema',
			undefined
		);
		expect(commitAll).toHaveBeenNthCalledWith(
			2,
			'/test/path',
			'Maestro Auto Run (goal) iteration 2 - done',
			undefined
		);
	});

	it('does not commit when the session is not a git repo', async () => {
		mockOnSpawnAgent.mockImplementation(async () => ({
			success: true,
			agentSessionId: 'goal-agent',
			response: progressResponse(100, 'done'),
		}));

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Ship it', 'All tests pass', null),
				'/test/path'
			);
		});

		expect(window.maestro.git.commitAll).not.toHaveBeenCalled();
	});

	it('continues the run when an iteration commit fails', async () => {
		(window.maestro.git.commitAll as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: false,
			committed: false,
			error: 'no git identity configured',
		});
		const responses = [progressResponse(50, 'half'), progressResponse(100, 'done')];
		let call = 0;
		mockOnSpawnAgent.mockImplementation(async () => ({
			success: true,
			agentSessionId: `goal-agent-${call}`,
			response: responses[call++],
		}));

		const { result } = renderProcessor(
			[createMockSession({ isGitRepo: true })],
			[createMockGroup()]
		);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Ship it', 'All tests pass', null),
				'/test/path'
			);
		});

		// A failed commit must not abort the run: it still reaches 100% completion.
		expect(mockOnSpawnAgent).toHaveBeenCalledTimes(2);
		expect(mockOnComplete).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: SESSION_ID, completedTasks: 100, wasStopped: false })
		);
	});

	it('exits "stalled" after STALL_THRESHOLD flat iterations', async () => {
		mockOnSpawnAgent.mockImplementation(async () => ({
			success: true,
			agentSessionId: 'goal-agent',
			response: progressResponse(50, 'no movement'),
		}));

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Stuck goal', 'Done when X', null),
				'/test/folder'
			);
		});

		// Stall trips on the 3rd flat iteration.
		expect(mockOnSpawnAgent).toHaveBeenCalledTimes(3);
		const summary = finalSummaryEntry();
		expect(summary.summary).toContain('stalled');
		expect(summary.success).toBe(false);
	});

	it('treats marker-less responses as no progress and stalls instead of looping forever', async () => {
		// Agent forgets to emit a progress marker every iteration. Each is treated
		// as "no progress reported" (carried forward, never silently complete), so
		// after STALL_THRESHOLD flat iterations the run must stop with "stalled".
		mockOnSpawnAgent.mockImplementation(async () => ({
			success: true,
			agentSessionId: 'goal-agent',
			response: 'Synopsis: I did some work but forgot to report a progress marker.',
		}));

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				// Infinite run: only the stall detector can stop this, proving it does.
				goalConfig('Forgetful agent goal', 'Done when X', null),
				'/test/folder'
			);
		});

		// Three marker-less iterations trip the stall — it does NOT spin forever.
		expect(mockOnSpawnAgent).toHaveBeenCalledTimes(3);
		const summary = finalSummaryEntry();
		expect(summary.summary).toContain('stalled');
		expect(summary.success).toBe(false);
		// Carried-forward progress stays at 0 (no marker ever reported).
		expect(mockOnComplete).toHaveBeenCalledWith(
			expect.objectContaining({ completedTasks: 0, wasStopped: false })
		);
	});

	it('exits "deadlock" when the agent declares one', async () => {
		const responses = [
			progressResponse(40, 'working'),
			`Synopsis: blocked.\n\n<!-- maestro:progress 40 | cannot proceed: missing API key -->\n<!-- maestro:deadlock -->`,
		];
		let call = 0;
		mockOnSpawnAgent.mockImplementation(async () => ({
			success: true,
			agentSessionId: 'goal-agent',
			response: responses[call++],
		}));

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Blocked goal', 'Done when X', null),
				'/test/folder'
			);
		});

		expect(mockOnSpawnAgent).toHaveBeenCalledTimes(2);
		const summary = finalSummaryEntry();
		expect(summary.summary).toContain('deadlock');
		expect(summary.fullResponse).toContain('missing API key');
	});

	it('exits "max-iterations" after exactly maxIterations spawns', async () => {
		const responses = [progressResponse(10, 'step 1'), progressResponse(20, 'step 2')];
		let call = 0;
		mockOnSpawnAgent.mockImplementation(async () => ({
			success: true,
			agentSessionId: 'goal-agent',
			response: responses[Math.min(call++, responses.length - 1)],
		}));

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Capped goal', 'Done when X', 2),
				'/test/folder'
			);
		});

		expect(mockOnSpawnAgent).toHaveBeenCalledTimes(2);
		const summary = finalSummaryEntry();
		expect(summary.summary).toContain('iteration limit');
	});

	it('enforces the hard safety cap on an infinite run a buggy agent never finishes', async () => {
		// Agent oscillates 50 -> 51 -> 50 -> 51..., which defeats stall detection
		// (an upward tick keeps resetting the window) and never reaches 100 or
		// deadlocks. Only the absolute safety bound can stop this.
		let call = 0;
		mockOnSpawnAgent.mockImplementation(async () => ({
			success: true,
			agentSessionId: 'goal-agent',
			response: progressResponse(call++ % 2 === 0 ? 50 : 51, 'oscillating'),
		}));

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Never-ending goal', 'Done when X', null),
				'/test/folder'
			);
		});

		// Stops at exactly the hard cap — not one iteration more.
		expect(mockOnSpawnAgent).toHaveBeenCalledTimes(GOAL_RUN_HARD_ITERATION_CAP);
		const summary = finalSummaryEntry();
		expect(summary.summary).toContain('iteration limit');
		expect(summary.fullResponse).toContain('Safety limit reached');
	}, 30000);

	it('fires the run lifecycle: START_BATCH, power, stats, then COMPLETE_BATCH', async () => {
		// Hold the first spawn so we can observe the running state mid-iteration.
		let resolveAgent: (value: {
			success: boolean;
			response: string;
			agentSessionId: string;
		}) => void;
		const agentPromise = new Promise<{
			success: boolean;
			response: string;
			agentSessionId: string;
		}>((resolve) => {
			resolveAgent = resolve;
		});
		mockOnSpawnAgent.mockReturnValue(agentPromise);

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		let finished = false;
		act(() => {
			void result.current
				.startBatchRun(SESSION_ID, goalConfig('Lifecycle goal', 'Done', null), '/test/folder')
				.then(() => {
					finished = true;
				});
		});

		// START_BATCH + SET_RUNNING + stats + power happen before the first spawn resolves.
		await waitFor(() => {
			expect(mockOnSpawnAgent).toHaveBeenCalled();
		});
		await waitFor(() => {
			expect(window.maestro.stats.startAutoRun).toHaveBeenCalled();
		});
		expect(mockPowerAddReason).toHaveBeenCalledWith(`autorun:${SESSION_ID}`);

		const running = result.current.getBatchState(SESSION_ID);
		expect(running.isRunning).toBe(true);
		expect(running.goalMode).toBe(true);

		// Complete the run.
		await act(async () => {
			resolveAgent!({
				success: true,
				response: progressResponse(100, 'done'),
				agentSessionId: 'a',
			});
		});
		await waitFor(() => {
			expect(finished).toBe(true);
		});

		// COMPLETE_BATCH + endAutoRun + power release.
		expect(result.current.getBatchState(SESSION_ID).isRunning).toBe(false);
		expect(window.maestro.stats.endAutoRun).toHaveBeenCalledTimes(1);
		const endCall = (window.maestro.stats.endAutoRun as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(endCall[2]).toBe(100); // finalProgress recorded as "completed tasks"
		expect(mockPowerRemoveReason).toHaveBeenCalledWith(`autorun:${SESSION_ID}`);
	});

	it('breaks the loop with "stopped-by-user" when a stop is requested mid-run', async () => {
		// First (and only) spawn is held until we request a stop.
		let resolveAgent: (value: {
			success: boolean;
			response: string;
			agentSessionId: string;
		}) => void;
		const agentPromise = new Promise<{
			success: boolean;
			response: string;
			agentSessionId: string;
		}>((resolve) => {
			resolveAgent = resolve;
		});
		mockOnSpawnAgent.mockReturnValueOnce(agentPromise);

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		let finished = false;
		act(() => {
			void result.current
				.startBatchRun(SESSION_ID, goalConfig('Stoppable goal', 'Done', null), '/test/folder')
				.then(() => {
					finished = true;
				});
		});

		await waitFor(() => {
			expect(mockOnSpawnAgent).toHaveBeenCalledTimes(1);
		});

		// User requests stop; this sets the stop ref the goal loop checks at the top.
		act(() => {
			result.current.stopBatchRun(SESSION_ID);
		});

		// Resolve the in-flight iteration with sub-100 progress (would otherwise continue).
		await act(async () => {
			resolveAgent!({
				success: true,
				response: progressResponse(30, 'partial'),
				agentSessionId: 'a',
			});
		});
		await waitFor(() => {
			expect(finished).toBe(true);
		});

		// No second spawn — the loop broke at the stop check.
		expect(mockOnSpawnAgent).toHaveBeenCalledTimes(1);
		const summary = finalSummaryEntry();
		expect(summary.summary).toContain('stopped by user');
		expect(mockOnComplete).toHaveBeenCalledWith(expect.objectContaining({ wasStopped: true }));
	});

	it('substitutes goal template variables into the per-iteration prompt', async () => {
		mockOnSpawnAgent.mockResolvedValue({
			success: true,
			agentSessionId: 'a',
			response: progressResponse(100, 'done'),
		});

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Refactor the parser', 'All parser tests green', null),
				'/test/folder'
			);
		});

		const prompt = mockOnSpawnAgent.mock.calls[0][1] as string;
		expect(prompt).toContain('Goal: Refactor the parser');
		expect(prompt).toContain('Exit: All parser tests green');
		expect(prompt).toContain('Iteration: 00001');
	});

	it('prefixes the agent New Session Message onto the per-iteration prompt', async () => {
		mockOnSpawnAgent.mockResolvedValue({
			success: true,
			agentSessionId: 'a',
			response: progressResponse(100, 'done'),
		});

		const { result } = renderProcessor(
			[createMockSession({ newSessionMessage: 'Always check linting first.' })],
			[createMockGroup()]
		);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Refactor the parser', 'All parser tests green', null),
				'/test/folder'
			);
		});

		const prompt = mockOnSpawnAgent.mock.calls[0][1] as string;
		expect(prompt.startsWith('Always check linting first.\n\n---\n\n')).toBe(true);
	});

	it('pauses on a limit error without consuming an iteration, then resumes the same iteration', async () => {
		// Start each run from a clean session store so the limit re-read is deterministic.
		useSessionStore.setState({ sessions: [] } as any);

		let spawnCalls = 0;
		mockOnSpawnAgent.mockImplementation(async () => {
			spawnCalls++;
			if (spawnCalls === 1) {
				// Mimic the agent-error listener stamping the session into the
				// limit-paused state that the goal runner re-reads from the store.
				useSessionStore.setState({
					sessions: [
						{
							...createMockSession(),
							agentError: {
								type: 'rate_limited',
								message: 'Usage limit reached',
								recoverable: true,
								agentId: 'claude-code',
								timestamp: Date.now(),
							},
						},
					],
				} as any);
				return { success: false, error: 'Usage limit reached' };
			}
			// The retried (same) iteration succeeds and completes the goal.
			return {
				success: true,
				agentSessionId: 'goal-agent',
				response: progressResponse(100, 'done'),
			};
		});

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		let finished = false;
		act(() => {
			void result.current
				.startBatchRun(SESSION_ID, goalConfig('Ship it', 'Done when X', null), '/test/folder')
				.then(() => {
					finished = true;
				});
		});

		// First spawn hit the limit; the loop parks awaiting an unblock signal.
		await waitFor(() => {
			expect(mockOnSpawnAgent).toHaveBeenCalledTimes(1);
		});
		expect(finished).toBe(false);
		expect(result.current.getBatchState(SESSION_ID).isRunning).toBe(true);

		// The coordinator (or the user's Resume button) unblocks the run.
		act(() => {
			result.current.resumeAfterError(SESSION_ID);
		});

		await waitFor(() => {
			expect(finished).toBe(true);
		});

		// Two spawns total: the limited attempt + the retried successful attempt.
		expect(mockOnSpawnAgent).toHaveBeenCalledTimes(2);

		// Exactly ONE per-iteration progress entry: the limited attempt did not
		// consume an iteration (no failed-iteration entry was recorded for it).
		const progressEntries = mockOnAddHistoryEntry.mock.calls
			.map((c) => c[0])
			.filter((e) => typeof e?.summary === 'string' && e.summary.startsWith('Goal progress:'));
		expect(progressEntries).toHaveLength(1);
		expect(progressEntries[0].summary).toContain('Goal progress: 100%');
		expect(progressEntries[0].summary).toContain('done');

		// Run completed normally after resume.
		expect(mockOnComplete).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: SESSION_ID, completedTasks: 100, wasStopped: false })
		);

		useSessionStore.setState({ sessions: [] } as any);
	});

	it('does not start when Auto Run is globally disabled', async () => {
		useSettingsStore.setState({ autoRunDisabled: true });

		const { result } = renderProcessor([createMockSession()], [createMockGroup()]);

		await act(async () => {
			await result.current.startBatchRun(
				SESSION_ID,
				goalConfig('Disabled goal', 'Done', null),
				'/test/folder'
			);
		});

		expect(mockOnSpawnAgent).not.toHaveBeenCalled();
		expect(mockPowerAddReason).not.toHaveBeenCalled();

		useSettingsStore.setState({ autoRunDisabled: false });
	});
});
