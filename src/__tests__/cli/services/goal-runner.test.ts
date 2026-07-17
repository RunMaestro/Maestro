/**
 * @file goal-runner.test.ts
 * @description Tests for the CLI Goal-Driven Auto Run engine (runGoal).
 *
 * runGoal is the CLI counterpart to the desktop useGoalRunner hook. It drives the
 * shared pure goal engine (src/shared/goalDriven/*): each iteration spawns a fresh
 * agent with the goal prompt, parses self-reported progress markers, records the
 * iteration, and asks the pure exit evaluator whether to continue. These tests
 * mock the CLI spawn/IO primitives and assert the loop + emitted JSONL events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionInfo } from '../../../shared/types';
import type { JsonlEvent } from '../../../cli/output/jsonl';
import type { GoalRunConfig } from '../../../shared/goalDriven/types';

vi.mock('../../../cli/services/agent-spawner', () => ({
	spawnAgent: vi.fn(),
}));

vi.mock('../../../cli/services/system-prompt', () => ({
	prepareMaestroSystemPromptCli: vi.fn(),
}));

vi.mock('../../../cli/services/prompt-loader', () => ({
	getCliPrompt: vi
		.fn()
		.mockResolvedValue(
			'Goal: {{GOAL}}\nExit: {{GOAL_EXIT_CRITERIA}}\nN: {{LOOP_NUMBER}}\n{{PREDECESSOR_HANDOFF}}'
		),
}));

vi.mock('../../../cli/services/storage', () => ({
	addHistoryEntry: vi.fn(),
	readGroups: vi.fn(),
}));

vi.mock('../../../cli/services/git-utils', () => ({
	getGitBranch: vi.fn().mockReturnValue('main'),
	isGitRepo: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../shared/cli-activity', () => ({
	registerCliActivity: vi.fn(),
	unregisterCliActivity: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		toast: vi.fn(),
		autorun: vi.fn(),
	},
}));

import { runGoal } from '../../../cli/services/goal-runner';
import { GOAL_SYNOPSIS_REQUEST_PROMPT } from '../../../shared/goalDriven/goalHandoff';
import { spawnAgent } from '../../../cli/services/agent-spawner';
import { prepareMaestroSystemPromptCli } from '../../../cli/services/system-prompt';
import { addHistoryEntry, readGroups } from '../../../cli/services/storage';
import { registerCliActivity, unregisterCliActivity } from '../../../shared/cli-activity';

describe('goal-runner (runGoal)', () => {
	const mockSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
		id: 'session-123',
		name: 'Test Session',
		toolType: 'claude-code',
		cwd: '/path/to/project',
		projectRoot: '/path/to/project',
		...overrides,
	});

	const goalConfig = (overrides: Partial<GoalRunConfig> = {}): GoalRunConfig => ({
		goal: 'Ship the feature',
		exitCriteria: 'All tests pass',
		maxIterations: null,
		...overrides,
	});

	/** Build an agent response carrying a progress marker. */
	const progressResponse = (n: number, rationale?: string): string =>
		rationale
			? `Did work toward ${n}.\n\n<!-- maestro:progress ${n} | ${rationale} -->`
			: `Did work toward ${n}.\n\n<!-- maestro:progress ${n} -->`;

	async function collectEvents(generator: AsyncGenerator<JsonlEvent>): Promise<JsonlEvent[]> {
		const events: JsonlEvent[] = [];
		for await (const event of generator) events.push(event);
		return events;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(readGroups).mockReturnValue([]);
		vi.mocked(prepareMaestroSystemPromptCli).mockResolvedValue(undefined);
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: progressResponse(100, 'done'),
			agentSessionId: 'agent-1',
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('emits a goal_start event with the goal config and registers CLI activity', async () => {
		const events = await collectEvents(runGoal(mockSession(), goalConfig()));

		const start = events.find((e) => e.type === 'goal_start');
		expect(start).toBeDefined();
		expect(start?.goal).toBe('Ship the feature');
		expect(start?.exitCriteria).toBe('All tests pass');
		expect(registerCliActivity).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: 'session-123', playbookId: 'goal-run' })
		);
		// Always unregisters activity, even on the happy path.
		expect(unregisterCliActivity).toHaveBeenCalledWith('session-123');
	});

	it('writes an immediate start marker recording goal + exit criteria', async () => {
		await collectEvents(runGoal(mockSession(), goalConfig({ maxIterations: 10 })));

		const startEntry = vi.mocked(addHistoryEntry).mock.calls[0][0];
		expect(startEntry.summary).toBe('Goal-Driven Auto Run started');
		expect(startEntry.fullResponse).toContain('**Goal:** Ship the feature');
		expect(startEntry.fullResponse).toContain('**Exit Criteria:** All tests pass');
		expect(startEntry.fullResponse).toContain('**Iteration Limit:** 10');
		expect(startEntry.success).toBeUndefined();
	});

	it('completes in one iteration when the agent reports 100%', async () => {
		const events = await collectEvents(runGoal(mockSession(), goalConfig()));

		expect(spawnAgent).toHaveBeenCalledTimes(1);
		// Fresh agent each iteration: no agentSessionId passed in.
		expect(vi.mocked(spawnAgent).mock.calls[0][3]).toBeUndefined();
		expect(vi.mocked(spawnAgent).mock.calls[0][4]?.permissionMode).toBe('full');

		const complete = events.find((e) => e.type === 'goal_complete');
		expect(complete?.success).toBe(true);
		expect(complete?.exitReason).toBe('completed');
		expect(complete?.finalProgress).toBe(100);
		expect(complete?.iterations).toBe(1);
	});

	it('prefixes the agent New Session Message onto every iteration prompt', async () => {
		const responses = [progressResponse(40, 'phase 1'), progressResponse(100, 'done')];
		let iterCall = 0;
		vi.mocked(spawnAgent).mockImplementation(async (_tool, _cwd, _prompt, agentSessionId) => {
			// Handoff resume requests must not receive the prefix; they reuse the session.
			if (agentSessionId) {
				return { success: true, response: 'handoff note', agentSessionId };
			}
			return {
				success: true,
				response: responses[iterCall++],
				agentSessionId: `agent-${iterCall}`,
			};
		});

		await collectEvents(
			runGoal(mockSession({ newSessionMessage: 'Always check linting first.' }), goalConfig())
		);

		// Both fresh iteration spawns carry the message; the handoff resume (call 1) does not.
		const firstPrompt = vi.mocked(spawnAgent).mock.calls[0][2];
		const secondPrompt = vi.mocked(spawnAgent).mock.calls[2][2];
		expect(firstPrompt.startsWith('Always check linting first.\n\n---\n\n')).toBe(true);
		expect(secondPrompt.startsWith('Always check linting first.\n\n---\n\n')).toBe(true);
		expect(vi.mocked(spawnAgent).mock.calls[1][2]).not.toContain('Always check linting first.');
	});

	it('loops across iterations and keeps displayed progress monotonic', async () => {
		const responses = [
			progressResponse(30, 'scaffolded'),
			progressResponse(55, 'overconfident'),
			progressResponse(35, 'walked back'),
			progressResponse(100, 'done'),
		];
		let call = 0;
		vi.mocked(spawnAgent).mockImplementation(async (_tool, _cwd, _prompt, agentSessionId) => {
			// Handoff requests resume an existing session (agentSessionId set) - they
			// are not iterations and must not consume an iteration response.
			if (agentSessionId) {
				return { success: true, response: 'handoff note', agentSessionId };
			}
			return { success: true, response: responses[call++], agentSessionId: `agent-${call}` };
		});

		const events = await collectEvents(runGoal(mockSession(), goalConfig()));

		// 4 iterations + a handoff resume after each of the 3 continuing iterations.
		expect(spawnAgent).toHaveBeenCalledTimes(7);
		const progresses = events
			.filter((e) => e.type === 'goal_iteration_complete')
			.map((e) => e.progress as number);
		// Displayed percent never regresses despite the 55 -> 35 dip.
		expect(progresses).toEqual([30, 55, 55, 100]);
		expect(events.find((e) => e.type === 'goal_complete')?.exitReason).toBe('completed');

		// Internal `<!-- maestro:... -->` control markers are stripped from the stored
		// per-iteration body so they never leak into any history render surface.
		const iterationEntries = vi
			.mocked(addHistoryEntry)
			.mock.calls.map((c) => c[0])
			.filter((e) => e.summary?.startsWith('Goal progress:'));
		expect(iterationEntries.length).toBeGreaterThan(0);
		for (const entry of iterationEntries) {
			expect(entry.fullResponse).not.toContain('<!-- maestro:');
		}
	});

	it('captures a predecessor handoff and threads it into the next iteration prompt', async () => {
		const responses = [progressResponse(40, 'phase 1'), progressResponse(100, 'done')];
		let iterCall = 0;
		vi.mocked(spawnAgent).mockImplementation(async (_tool, _cwd, _prompt, agentSessionId) => {
			// A resume call (agentSessionId set) is the handoff request.
			if (agentSessionId) {
				return {
					success: true,
					response: 'Migrated the data layer; UI still pending.',
					agentSessionId,
				};
			}
			return {
				success: true,
				response: responses[iterCall++],
				agentSessionId: `agent-${iterCall}`,
			};
		});

		await collectEvents(runGoal(mockSession(), goalConfig()));

		// 2 iterations + 1 handoff resume after the first (continuing) iteration.
		expect(spawnAgent).toHaveBeenCalledTimes(3);

		// First iteration spawns fresh with no predecessor note in its prompt.
		const firstPrompt = vi.mocked(spawnAgent).mock.calls[0][2];
		expect(vi.mocked(spawnAgent).mock.calls[0][3]).toBeUndefined();
		expect(firstPrompt).not.toContain('Handoff From Your Predecessor');

		// The handoff request resumes the first iteration's session with the synopsis prompt.
		const handoffCall = vi.mocked(spawnAgent).mock.calls[1];
		expect(handoffCall[3]).toBe('agent-1');
		expect(handoffCall[2]).toBe(GOAL_SYNOPSIS_REQUEST_PROMPT);

		// The second iteration's prompt carries the predecessor's note.
		const secondPrompt = vi.mocked(spawnAgent).mock.calls[2][2];
		expect(vi.mocked(spawnAgent).mock.calls[2][3]).toBeUndefined();
		expect(secondPrompt).toContain('Handoff From Your Predecessor');
		expect(secondPrompt).toContain('Migrated the data layer; UI still pending.');
	});

	it('stops with "deadlock" when the agent declares one', async () => {
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response:
				'Blocked.\n\n<!-- maestro:progress 40 -->\n<!-- maestro:deadlock: upstream API down -->',
			agentSessionId: 'agent-1',
		});

		const events = await collectEvents(runGoal(mockSession(), goalConfig()));

		expect(spawnAgent).toHaveBeenCalledTimes(1);
		expect(events.find((e) => e.type === 'goal_complete')?.exitReason).toBe('deadlock');
	});

	it('stops at max-iterations when the goal is never reached', async () => {
		vi.mocked(spawnAgent).mockImplementation(async (_tool, _cwd, _prompt, agentSessionId) =>
			agentSessionId
				? { success: true, response: 'handoff note', agentSessionId }
				: { success: true, response: progressResponse(50, 'inching'), agentSessionId: 'agent-1' }
		);

		const events = await collectEvents(runGoal(mockSession(), goalConfig({ maxIterations: 3 })));

		// 3 iterations + a handoff resume after the 2 continuing ones (none after the
		// final iteration, which trips the max-iterations stop).
		expect(spawnAgent).toHaveBeenCalledTimes(5);
		const iterationCompletes = events.filter((e) => e.type === 'goal_iteration_complete');
		expect(iterationCompletes).toHaveLength(3);
		expect(events.find((e) => e.type === 'goal_complete')?.exitReason).toBe('max-iterations');
	});

	it('skips history writes when writeHistory is false', async () => {
		await collectEvents(runGoal(mockSession(), goalConfig(), { writeHistory: false }));
		expect(addHistoryEntry).not.toHaveBeenCalled();
	});

	it('threads SSH + per-session overrides into every spawn', async () => {
		const session = mockSession({
			customModel: 'opus',
			customEffort: 'high',
			customArgs: '--foo',
			customEnvVars: { BAR: '1' },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } as never,
		});

		await collectEvents(runGoal(session, goalConfig()));

		const opts = vi.mocked(spawnAgent).mock.calls[0][4];
		expect(opts).toMatchObject({
			customModel: 'opus',
			customEffort: 'high',
			customArgs: '--foo',
			customEnvVars: { BAR: '1' },
			sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
	});
});
