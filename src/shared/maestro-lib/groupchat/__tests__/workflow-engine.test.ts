/**
 * @file workflow-engine.test.ts
 * @description Staged workflows through the group chat engine itself, over fake ports and a
 * real store on a temp dir: what a desktop and a headless host both run. The routing reaches
 * the workflow through `turnEnded`, the path a real moderator reply takes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createGroupChatEngine } from '../router';
import { createGroupChatStore } from '../storage';
import { createGroupChatTurnMetrics } from '../turn-metrics';
import { readLog } from '../log';
import { createSleepTracker } from '../../../sleepTracking';
import { MAX_WORKFLOW_STAGE_NUDGES } from '../workflow/controller';
import type { GroupChatWorkflowRun } from '../../../group-chat-workflow-types';
import type { GroupChatEventSink, GroupChatLauncher, GroupChatSpawn } from '../types';

const TWO_STAGE_PLAN = [
	'Review first, then integrate.',
	'',
	'```maestro-plan',
	JSON.stringify({
		title: 'Ship it',
		stages: [
			{ id: 'review', name: 'Review', agents: ['Alice'], instruction: 'Review the change' },
			{ id: 'integrate', name: 'Integrate', agents: ['Bob'], instruction: 'Merge the change' },
		],
	}),
	'```',
].join('\n');

function createHarness(dir: string) {
	const store = createGroupChatStore({ groupChatsDir: () => dir });
	const spawns: GroupChatSpawn[] = [];
	const messages: Array<{ from: string; content: string }> = [];
	const states: string[] = [];
	const runs: Array<GroupChatWorkflowRun | null> = [];
	const tracker = createSleepTracker();
	const events: GroupChatEventSink = {
		message: (_chatId, m) => messages.push({ from: m.from, content: m.content }),
		stateChange: (_chatId, state) => states.push(state),
		participantsChanged: vi.fn(),
		moderatorUsage: vi.fn(),
		historyEntry: vi.fn(),
		participantState: vi.fn(),
		moderatorSessionIdChanged: vi.fn(),
		autoRunTriggered: vi.fn(),
		autoRunBatchComplete: vi.fn(),
		participantLiveOutput: vi.fn(),
		workflowRun: (_chatId, run) => runs.push(run),
	};
	const engine = createGroupChatEngine({
		store,
		events,
		agents: {
			list: () => [],
			providerConfig: () => ({}),
			providerEnvVars: () => undefined,
			conductorProfile: () => '',
			sshStore: () => null,
		},
		prompts: { get: (id) => `[${id}]` },
		power: { block: vi.fn(), unblock: vi.fn() },
		metrics: createGroupChatTurnMetrics({
			spans: { begin: tracker.beginSpan, elapsedMs: tracker.elapsedMs },
		}),
	});
	const launcher: GroupChatLauncher = {
		runner: {
			start: async (spawn) => {
				spawns.push(spawn);
				return { success: true, pid: 4242 };
			},
			stop: vi.fn(),
		},
		resolveAgent: async (providerId) =>
			({
				id: providerId,
				name: 'Claude Code',
				binaryName: 'claude',
				command: 'claude',
				args: ['--print'],
				available: true,
				path: '/usr/local/bin/claude',
				capabilities: {},
			}) as never,
	};
	return { store, engine, launcher, spawns, messages, states, runs };
}

type Harness = ReturnType<typeof createHarness>;

describe('staged workflows in the group chat engine', () => {
	let dir: string;
	let h: Harness;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'group-chat-workflow-'));
		h = createHarness(dir);
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function chatWith(...names: string[]) {
		const chat = await h.store.createGroupChat('Room', 'claude-code');
		await h.engine.spawnModerator(chat);
		for (const name of names) await h.engine.addParticipant(chat.id, name, 'claude-code');
		return chat;
	}

	const moderatorSpawns = () => h.spawns.filter((s) => s.processId.includes('-moderator-'));
	const lastModeratorPrompt = () => moderatorSpawns().at(-1)?.prompt ?? '';

	/** The moderator's turn that is running ends with `text`. */
	async function moderatorSays(text: string) {
		const turn = moderatorSpawns().at(-1);
		if (!turn) throw new Error('No moderator turn is running');
		await h.engine.turnEnded({ processId: turn.processId, text, exitCode: 0 }, h.launcher);
	}

	/** The participant turn of `name` that started last ends with `text`. */
	async function participantSays(name: string, text: string) {
		const turn = h.spawns.filter((s) => s.processId.includes(`-participant-${name}-`)).at(-1);
		if (!turn) throw new Error(`No turn of ${name} is running`);
		await h.engine.turnEnded({ processId: turn.processId, text, exitCode: 0 }, h.launcher);
	}

	/** A chat whose moderator proposed the two-stage plan and the user approved it. */
	async function approvedChat() {
		const chat = await chatWith('Alice', 'Bob');
		await h.engine.routeUserMessage(chat.id, 'Review then integrate', h.launcher);
		await moderatorSays(TWO_STAGE_PLAN);
		await h.engine.routeUserMessage(chat.id, 'go', h.launcher);
		return chat;
	}

	it('tells the moderator how to plan when the chat holds no run', async () => {
		const chat = await chatWith('Alice');
		await h.engine.routeUserMessage(chat.id, 'First review, then merge', h.launcher);
		expect(lastModeratorPrompt()).toContain('[group-chat-workflow-planning]');
		expect(lastModeratorPrompt()).not.toContain('[group-chat-workflow-stage]');
	});

	it('turns a moderator plan into a run that waits, saved in the chat folder, and starts nothing', async () => {
		const chat = await chatWith('Alice', 'Bob');
		await h.engine.routeUserMessage(chat.id, 'Review then integrate', h.launcher);
		const spawnsBefore = h.spawns.length;
		await moderatorSays(TWO_STAGE_PLAN);

		expect(h.spawns).toHaveLength(spawnsBefore);
		const run = await h.engine.getWorkflowRun(chat.id);
		expect(run?.status).toBe('awaiting-approval');
		expect(run?.plan.stages.map((stage) => stage.id)).toEqual(['review', 'integrate']);
		expect((await h.store.loadWorkflowRun(chat.id))?.plan.runId).toBe(run?.plan.runId);
		expect(h.runs.at(-1)?.status).toBe('awaiting-approval');
		expect(h.states.at(-1)).toBe('idle');

		// The prose is posted without the plan block; the summary follows as a system line.
		const log = await readLog(chat.logPath);
		const moderatorLine = log.filter((m) => m.from === 'moderator').at(-1);
		expect(moderatorLine?.content).toBe('Review first, then integrate.');
		expect(log.at(-1)?.from).toBe('system');
		expect(log.at(-1)?.content).toContain('Reply `go` to start');
	});

	it('runs an approved plan stage by stage and ends it with the last stage', async () => {
		const chat = await approvedChat();
		expect((await h.engine.getWorkflowRun(chat.id))?.status).toBe('running');
		expect(lastModeratorPrompt()).toContain('[group-chat-workflow-stage]');
		expect(lastModeratorPrompt()).toContain('Stage 1 of 2: Review');

		// Stage 1: the moderator engages Alice, her reply is the stage's handoff.
		await moderatorSays('@Alice please review the change');
		await participantSays('Alice', 'Reviewed: two nits, otherwise fine.');
		const afterReview = await h.engine.getWorkflowRun(chat.id);
		expect(afterReview?.handoffs[0]?.participantHandoffs).toEqual([
			{ participantName: 'Alice', mode: 'inline', content: 'Reviewed: two nits, otherwise fine.' },
		]);

		// The synthesis ends stage 1; the next moderator turn runs stage 2.
		const beforeAdvance = moderatorSpawns().length;
		await moderatorSays('!stage-complete\nThe review found two nits.');
		expect(moderatorSpawns()).toHaveLength(beforeAdvance + 1);
		expect(lastModeratorPrompt()).toContain('Stage 2 of 2: Integrate');
		expect(lastModeratorPrompt()).toContain('The review found two nits.');

		await moderatorSays('@Bob please merge the change');
		await participantSays('Bob', 'Merged.');
		await moderatorSays('!stage-complete\nMerged to main.');

		const done = await h.engine.getWorkflowRun(chat.id);
		expect(done?.status).toBe('complete');
		expect(h.states.at(-1)).toBe('idle');
		const log = await readLog(chat.logPath);
		expect(log.at(-1)?.content).toContain('Workflow complete: all 2 stages finished.');
	});

	it('saves a long stage reply to a file and hands the next stage its path', async () => {
		const chat = await approvedChat();
		await moderatorSays('@Alice please review the change');
		await participantSays('Alice', `Findings. ${'detail '.repeat(1200)}`);

		const run = await h.engine.getWorkflowRun(chat.id);
		const handoff = run?.handoffs[0]?.participantHandoffs?.[0];
		expect(handoff?.mode).toBe('artifact');
		const artifactPath = handoff?.mode === 'artifact' ? handoff.artifactPath : '';
		expect(artifactPath.startsWith(path.join(dir, chat.id, 'workflow-runs', run!.plan.runId))).toBe(
			true
		);
		expect(await fs.readFile(artifactPath, 'utf-8')).toContain('Findings.');
	});

	it('tells a stalled stage moderator to act, then aborts the run', async () => {
		const chat = await approvedChat();
		for (let retry = 1; retry <= MAX_WORKFLOW_STAGE_NUDGES; retry++) {
			const before = moderatorSpawns().length;
			await moderatorSays('I will think about it.');
			expect(moderatorSpawns()).toHaveLength(before + 1);
			expect(lastModeratorPrompt()).toContain('Immediate Workflow Correction');
		}
		const before = moderatorSpawns().length;
		await moderatorSays('Still thinking.');
		expect(moderatorSpawns()).toHaveLength(before);
		expect((await h.engine.getWorkflowRun(chat.id))?.status).toBe('aborted');
		expect(h.states.at(-1)).toBe('idle');
	});

	it('fails the run on !stage-failed', async () => {
		const chat = await approvedChat();
		await moderatorSays('!stage-failed\nAlice cannot reach the repository.');
		const run = await h.engine.getWorkflowRun(chat.id);
		expect(run?.status).toBe('aborted');
		expect(run?.stageStatuses.review).toBe('failed');
		expect(run?.abortReason).toBe('Alice cannot reach the repository.');
	});

	it('cancels on the user word and on cancelWorkflow, without a moderator turn', async () => {
		const chat = await chatWith('Alice', 'Bob');
		await h.engine.routeUserMessage(chat.id, 'Plan it', h.launcher);
		await moderatorSays(TWO_STAGE_PLAN);
		const before = moderatorSpawns().length;
		await h.engine.routeUserMessage(chat.id, 'cancel', h.launcher);
		expect(moderatorSpawns()).toHaveLength(before);
		expect((await h.engine.getWorkflowRun(chat.id))?.status).toBe('aborted');
		// Nothing left to cancel.
		expect(await h.engine.cancelWorkflow(chat.id)).toBeNull();
	});

	it('takes a plan the user pasted without running the moderator', async () => {
		const chat = await chatWith('Alice', 'Bob');
		await h.engine.routeUserMessage(chat.id, TWO_STAGE_PLAN, h.launcher);
		expect(moderatorSpawns()).toHaveLength(0);
		expect((await h.engine.getWorkflowRun(chat.id))?.status).toBe('awaiting-approval');
		const log = await readLog(chat.logPath);
		expect(log.some((m) => m.from === 'user')).toBe(true);
	});

	it('notes a moderator that engaged an agent the stage does not list', async () => {
		const chat = await approvedChat();
		await moderatorSays('@Alice and @Bob please review');
		const log = await readLog(chat.logPath);
		expect(log.some((m) => m.content.includes('but @Bob was engaged'))).toBe(true);
	});

	it('resumes a saved run after a restart and drops artifacts no run points at', async () => {
		const chat = await approvedChat();
		const runId = (await h.engine.getWorkflowRun(chat.id))!.plan.runId;
		const orphan = path.join(dir, chat.id, 'workflow-runs', 'orphan-run');
		await fs.mkdir(orphan, { recursive: true });

		const restarted = createHarness(dir);
		const run = await restarted.engine.getWorkflowRun(chat.id);
		expect(run?.status).toBe('running');
		expect(run?.plan.runId).toBe(runId);
		await expect(fs.stat(orphan)).rejects.toThrow();
	});

	it('runs a read-only plan read-only when the approval names no mode', async () => {
		const chat = await chatWith('Alice', 'Bob');
		await h.engine.routeUserMessage(chat.id, 'Plan a review', h.launcher, true);
		await moderatorSays(TWO_STAGE_PLAN);
		expect((await h.engine.getWorkflowRun(chat.id))?.readOnly).toBe(true);

		await h.engine.routeUserMessage(chat.id, 'go', h.launcher);
		expect(h.engine.getGroupChatReadOnlyState(chat.id)).toBe(true);
		expect(lastModeratorPrompt()).toContain('READ-ONLY MODE is active.');
	});

	it('fails an Auto Run stage at once when its directive cannot start', async () => {
		const chat = await chatWith('Release-Bot');
		const plan = [
			'```maestro-plan',
			JSON.stringify({
				title: 'Release',
				stages: [
					{
						id: 'publish',
						name: 'Publish',
						instruction: 'Run the release playbook',
						autoRun: { participantName: 'Release-Bot', filename: 'Release.md' },
					},
				],
			}),
			'```',
		].join('\n');
		await h.engine.routeUserMessage(chat.id, plan, h.launcher);
		await h.engine.routeUserMessage(chat.id, 'go', h.launcher);
		const before = moderatorSpawns().length;
		// No agent stands behind the participant, so it has no Auto Run folder.
		await moderatorSays('!autorun @Release-Bot:Release.md');

		expect(moderatorSpawns()).toHaveLength(before);
		const run = await h.engine.getWorkflowRun(chat.id);
		expect(run?.status).toBe('aborted');
		expect(run?.stageStatuses.publish).toBe('failed');
		expect(run?.abortReason).toContain('could not start');
	});

	it('forgets a run when the chat goes away', async () => {
		const chat = await approvedChat();
		await h.engine.forgetWorkflow(chat.id);
		expect(await h.store.loadWorkflowRun(chat.id)).toBeNull();
		expect(await h.engine.getWorkflowRun(chat.id)).toBeNull();
	});
});
