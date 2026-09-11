/**
 * @file group-chat-workflow-routing.test.ts
 * @description Integration tests for workflow plan interception in the Group Chat router.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let mockUserDataPath: string;
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === 'userData') return mockUserDataPath;
			throw new Error(`Unknown path name: ${name}`);
		}),
	},
}));

vi.mock('electron-store', () => ({
	default: class MockStore {
		get() {
			return undefined;
		}
		set() {}
	},
}));

vi.mock('../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => `mock prompt for ${id}`),
}));

import { AgentDetector } from '../../../main/agents';
import { groupChatEmitters } from '../../../main/ipc/handlers/groupChat';
import {
	addParticipant,
	clearAllParticipantSessionsGlobal,
} from '../../../main/group-chat/group-chat-agent';
import {
	clearAllModeratorSessions,
	spawnModerator,
	type IProcessManager,
} from '../../../main/group-chat/group-chat-moderator';
import {
	buildModeratorPromptSections,
	markParticipantResponded,
	routeModeratorResponse,
	routeUserMessage,
	spawnModeratorSynthesis,
} from '../../../main/group-chat/group-chat-router';
import {
	createGroupChat,
	deleteGroupChat,
	getGroupChatHistory,
} from '../../../main/group-chat/group-chat-storage';
import {
	getWorkflowRun,
	resetAllWorkflowRuns,
	setWorkflowRun,
} from '../../../main/group-chat/workflow-run-registry';
import {
	approveRun,
	completeStage,
	createRun,
} from '../../../main/group-chat/workflow-state-machine';
import type { GroupChatWorkflowPlan } from '../../../shared/group-chat-workflow-types';

describe('group-chat workflow routing', () => {
	let mockProcessManager: IProcessManager;
	let mockAgentDetector: AgentDetector;
	let testDir: string;
	let createdChatIds: string[];

	beforeEach(async () => {
		testDir = path.join(
			os.tmpdir(),
			`group-chat-workflow-routing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);
		await fs.mkdir(testDir, { recursive: true });
		mockUserDataPath = testDir;
		createdChatIds = [];

		mockProcessManager = {
			spawn: vi.fn().mockReturnValue({ pid: 12345, success: true }),
			write: vi.fn().mockReturnValue(true),
			kill: vi.fn().mockReturnValue(true),
		};
		mockAgentDetector = {
			getAgent: vi.fn().mockResolvedValue({
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				command: 'claude',
				args: ['--print', '--verbose', '--output-format', 'stream-json'],
				available: true,
				path: '/usr/local/bin/claude',
				capabilities: {},
			}),
			detectAgents: vi.fn().mockResolvedValue([]),
			clearCache: vi.fn(),
			setCustomPaths: vi.fn(),
			getCustomPaths: vi.fn().mockReturnValue({}),
			discoverModels: vi.fn().mockResolvedValue([]),
			clearModelCache: vi.fn(),
		} as unknown as AgentDetector;

		clearAllModeratorSessions();
		clearAllParticipantSessionsGlobal();
		resetAllWorkflowRuns();
	});

	afterEach(async () => {
		for (const chatId of createdChatIds) {
			await deleteGroupChat(chatId).catch(() => undefined);
		}
		clearAllModeratorSessions();
		clearAllParticipantSessionsGlobal();
		resetAllWorkflowRuns();
		groupChatEmitters.emitMessage = undefined;
		groupChatEmitters.emitStateChange = undefined;
		await fs.rm(testDir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	async function createChatWithModerator(name: string) {
		const chat = await createGroupChat(name, 'claude-code');
		createdChatIds.push(chat.id);
		await spawnModerator(chat, mockProcessManager);
		return chat;
	}

	const workflowPlan: GroupChatWorkflowPlan = {
		runId: 'run-prompt-composition',
		title: 'Prompt composition',
		createdAt: 1,
		stages: [
			{
				id: 'stage-1',
				name: 'Build',
				agents: ['Builder'],
				mode: 'serial',
				instruction: 'Build the feature',
			},
		],
	};

	it('composes state-specific workflow guidance', () => {
		const basePrompt = 'BASE MODERATOR PROMPT';
		const awaitingRun = createRun(workflowPlan);
		const runningRun = approveRun(awaitingRun);

		expect(buildModeratorPromptSections(basePrompt, undefined)).toBe(
			`${basePrompt}\n\nmock prompt for group-chat-workflow-planning`
		);
		expect(
			buildModeratorPromptSections(basePrompt, { ...awaitingRun, status: 'complete' })
		).toContain('mock prompt for group-chat-workflow-planning');
		expect(
			buildModeratorPromptSections(basePrompt, { ...awaitingRun, status: 'aborted' })
		).toContain('mock prompt for group-chat-workflow-planning');
		expect(buildModeratorPromptSections(basePrompt, awaitingRun)).toBe(basePrompt);

		const executionPrompt = buildModeratorPromptSections(basePrompt, runningRun);
		expect(executionPrompt).toContain('mock prompt for group-chat-workflow-stage');
		expect(executionPrompt).toContain('## Active Workflow Plan');
		expect(executionPrompt).toContain('## Current Stage');
		expect(executionPrompt).toContain('Stage 1 of 1: Build');
		expect(executionPrompt).toContain('Agents: @Builder');
		expect(executionPrompt).toContain('Instruction: Build the feature');
		expect(executionPrompt).toContain('Expected output: (not specified)');
		expect(executionPrompt).toContain('(none; this is the first stage)');
	});

	it('includes the prior handoff and artifact paths in current-stage context', () => {
		const twoStagePlan: GroupChatWorkflowPlan = {
			...workflowPlan,
			stages: [
				workflowPlan.stages[0],
				{
					id: 'stage-2',
					name: 'Review',
					agents: ['Reviewer'],
					mode: 'serial',
					instruction: 'Review the implementation',
					expects: 'An approval decision',
				},
			],
		};
		const runningRun = approveRun(createRun(twoStagePlan));
		const advancedRun = completeStage(runningRun, {
			stageId: 'stage-1',
			stageName: 'Build',
			summary: 'The implementation and tests are ready.',
			artifactPaths: ['src/feature.ts', 'src/feature.test.ts'],
		});

		const executionPrompt = buildModeratorPromptSections('BASE', advancedRun);
		expect(executionPrompt).toContain('Stage 2 of 2: Review');
		expect(executionPrompt).toContain('Expected output: An approval decision');
		expect(executionPrompt).toContain('From Build: The implementation and tests are ready.');
		expect(executionPrompt).toContain('Full output: src/feature.ts');
		expect(executionPrompt).toContain('Full output: src/feature.test.ts');
	});

	it('places planning guidance after the base prompt and before participant context', async () => {
		const chat = await createChatWithModerator('Workflow Planning Prompt');
		vi.mocked(mockProcessManager.spawn).mockClear();

		await routeUserMessage(chat.id, 'Plan a staged release', mockProcessManager, mockAgentDetector);

		const prompt = vi.mocked(mockProcessManager.spawn).mock.calls[0]?.[0]?.prompt ?? '';
		const baseIndex = prompt.indexOf('mock prompt for group-chat-moderator-system');
		const planningIndex = prompt.indexOf('mock prompt for group-chat-workflow-planning');
		const participantsIndex = prompt.indexOf('## Current Participants:');
		expect(baseIndex).toBeGreaterThanOrEqual(0);
		expect(planningIndex).toBeGreaterThan(baseIndex);
		expect(participantsIndex).toBeGreaterThan(planningIndex);
	});

	it('injects current-stage context into user and synthesis moderator turns', async () => {
		const chat = await createChatWithModerator('Workflow Execution Prompt');
		const runningRun = approveRun(createRun(workflowPlan));
		setWorkflowRun(chat.id, runningRun);
		vi.mocked(mockProcessManager.spawn).mockClear();

		await routeUserMessage(
			chat.id,
			'Please keep the implementation focused.',
			mockProcessManager,
			mockAgentDetector
		);

		const userTurnPrompt = vi.mocked(mockProcessManager.spawn).mock.calls[0]?.[0]?.prompt ?? '';
		expect(userTurnPrompt).toContain('mock prompt for group-chat-workflow-stage');
		expect(userTurnPrompt).toContain('## Active Workflow Plan');
		expect(userTurnPrompt).toContain('## Current Stage');
		expect(userTurnPrompt).toContain('Stage 1 of 1: Build');

		vi.mocked(mockProcessManager.spawn).mockClear();
		await spawnModeratorSynthesis(chat.id, mockProcessManager, mockAgentDetector);

		const synthesisPrompt = vi.mocked(mockProcessManager.spawn).mock.calls[0]?.[0]?.prompt ?? '';
		expect(synthesisPrompt).toContain('mock prompt for group-chat-workflow-stage');
		expect(synthesisPrompt).toContain('## Active Workflow Plan');
		expect(synthesisPrompt).toContain('## Current Stage');
		expect(synthesisPrompt).toContain('Stage 1 of 1: Build');
	});

	it('advances a completed stage, keeps the handoff visible, and spawns the next stage', async () => {
		const chat = await createChatWithModerator('Workflow Stage Advance');
		const twoStagePlan: GroupChatWorkflowPlan = {
			...workflowPlan,
			stages: [
				workflowPlan.stages[0],
				{
					id: 'stage-2',
					name: 'Review',
					agents: ['Reviewer'],
					mode: 'serial',
					instruction: 'Review the implementation',
				},
			],
		};
		setWorkflowRun(chat.id, approveRun(createRun(twoStagePlan)));
		const emitMessage = vi.fn();
		groupChatEmitters.emitMessage = emitMessage;
		vi.mocked(mockProcessManager.spawn).mockClear();

		await routeModeratorResponse(
			chat.id,
			'!stage-complete\nThe implementation and tests are ready.',
			mockProcessManager,
			mockAgentDetector
		);

		expect(getWorkflowRun(chat.id)).toMatchObject({
			status: 'running',
			currentStageIndex: 1,
			handoffs: [expect.objectContaining({ summary: 'The implementation and tests are ready.' })],
		});
		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({
				from: 'system',
				content: 'Stage 1 of 2 complete: Build. Starting stage 2: Review.',
			})
		);
		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({
				from: 'moderator',
				content: 'The implementation and tests are ready.',
			})
		);
		expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
		const prompt = vi.mocked(mockProcessManager.spawn).mock.calls[0]?.[0]?.prompt ?? '';
		expect(prompt).toContain('Stage 2 of 2: Review');
		expect(prompt).toContain('From Build: The implementation and tests are ready.');
		const history = await getGroupChatHistory(chat.id);
		expect(history).toContainEqual(
			expect.objectContaining({
				participantName: 'Moderator',
				type: 'synthesis',
				summary: 'Stage 1 of 2 complete: Build. Starting stage 2: Review.',
			})
		);
	});

	it('completes the terminal stage without spawning another moderator', async () => {
		const chat = await createChatWithModerator('Workflow Terminal Stage');
		setWorkflowRun(chat.id, approveRun(createRun(workflowPlan)));
		const emitMessage = vi.fn();
		groupChatEmitters.emitMessage = emitMessage;
		vi.mocked(mockProcessManager.spawn).mockClear();

		await routeModeratorResponse(
			chat.id,
			'**!stage-complete**\nThe release is complete and verified.',
			mockProcessManager,
			mockAgentDetector
		);

		expect(getWorkflowRun(chat.id)).toMatchObject({ status: 'complete', currentStageIndex: 1 });
		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({
				from: 'system',
				content: 'Workflow complete: all 1 stages finished.',
			})
		);
		expect(mockProcessManager.spawn).not.toHaveBeenCalled();
	});

	it('fails the current stage and stops without dispatching mentioned handoff agents', async () => {
		const chat = await createChatWithModerator('Workflow Stage Failure');
		await addParticipant(chat.id, 'Builder', 'claude-code', mockProcessManager);
		setWorkflowRun(chat.id, approveRun(createRun(workflowPlan)));
		const emitMessage = vi.fn();
		groupChatEmitters.emitMessage = emitMessage;
		vi.mocked(mockProcessManager.spawn).mockClear();

		await routeModeratorResponse(
			chat.id,
			'!stage-failed\nThe dependency is unavailable. @Builder should not be dispatched.',
			mockProcessManager,
			mockAgentDetector
		);

		expect(getWorkflowRun(chat.id)).toMatchObject({
			status: 'aborted',
			abortReason: 'The dependency is unavailable. @Builder should not be dispatched.',
			stageStatuses: { 'stage-1': 'failed' },
		});
		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({
				from: 'system',
				content:
					'Stage 1 of 1 failed: Build. The dependency is unavailable. @Builder should not be dispatched.',
			})
		);
		expect(mockProcessManager.spawn).not.toHaveBeenCalled();
	});

	it('dispatches an off-roster mention and announces the deviation', async () => {
		const chat = await createChatWithModerator('Workflow Roster Deviation');
		await addParticipant(chat.id, 'Reviewer', 'claude-code', mockProcessManager);
		setWorkflowRun(chat.id, approveRun(createRun(workflowPlan)));
		const emitMessage = vi.fn();
		groupChatEmitters.emitMessage = emitMessage;
		vi.mocked(mockProcessManager.spawn).mockClear();

		await routeModeratorResponse(
			chat.id,
			'@Reviewer Please inspect the implementation.',
			mockProcessManager,
			mockAgentDetector
		);

		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({
				from: 'system',
				content: 'Note: stage 1 lists @Builder, but @Reviewer was engaged.',
			})
		);
		expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(mockProcessManager.spawn).mock.calls[0]?.[0]?.sessionId).toContain(
			'participant-Reviewer-'
		);
		expect(getWorkflowRun(chat.id)?.status).toBe('running');
	});

	it('nudges a mentionless moderator twice, then aborts the stage loop', async () => {
		const chat = await createChatWithModerator('Workflow Missing Action');
		setWorkflowRun(chat.id, approveRun(createRun(workflowPlan)));
		const emitMessage = vi.fn();
		groupChatEmitters.emitMessage = emitMessage;
		vi.mocked(mockProcessManager.spawn).mockClear();

		await routeModeratorResponse(
			chat.id,
			'I am still considering the implementation.',
			mockProcessManager,
			mockAgentDetector
		);
		await routeModeratorResponse(
			chat.id,
			'I need to think about it again.',
			mockProcessManager,
			mockAgentDetector
		);
		await routeModeratorResponse(
			chat.id,
			'I have no next action yet.',
			mockProcessManager,
			mockAgentDetector
		);

		expect(mockProcessManager.spawn).toHaveBeenCalledTimes(2);
		for (const call of vi.mocked(mockProcessManager.spawn).mock.calls) {
			const prompt = call[0]?.prompt ?? '';
			expect(prompt).toContain('## Immediate Workflow Correction');
			expect(prompt).toContain(
				'Either mention @Builder now or emit !stage-complete or !stage-failed'
			);
		}
		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({
				from: 'system',
				content:
					'Workflow stage 1 needs a moderator action. Retrying (1 of 2): mention @Builder or emit a stage directive.',
			})
		);
		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({
				from: 'system',
				content:
					'Workflow stage 1 needs a moderator action. Retrying (2 of 2): mention @Builder or emit a stage directive.',
			})
		);
		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({
				from: 'system',
				content:
					'Workflow aborted: the moderator produced no participant mentions or stage directive after 2 retries during stage 1, Build.',
			})
		);
		expect(getWorkflowRun(chat.id)).toMatchObject({
			status: 'aborted',
			abortReason: 'moderator-stage-guidance-exhausted',
		});
	});

	it('passes a mid-run user redirect to the moderator with current plan context', async () => {
		const chat = await createChatWithModerator('Workflow User Redirect');
		setWorkflowRun(chat.id, approveRun(createRun(workflowPlan)));
		vi.mocked(mockProcessManager.spawn).mockClear();

		await routeUserMessage(
			chat.id,
			'Have @Builder verify the edge cases before continuing.',
			mockProcessManager,
			mockAgentDetector
		);

		expect(getWorkflowRun(chat.id)?.status).toBe('running');
		expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
		const prompt = vi.mocked(mockProcessManager.spawn).mock.calls[0]?.[0]?.prompt ?? '';
		expect(prompt).toContain('## Active Workflow Plan');
		expect(prompt).toContain('Stage 1 of 1: Build');
		expect(prompt).toContain('Have @Builder verify the edge cases before continuing.');
	});

	it('cancels a running workflow and clears pending participant tracking', async () => {
		const chat = await createChatWithModerator('Workflow Mid-run Cancel');
		await addParticipant(chat.id, 'Builder', 'claude-code', mockProcessManager);
		setWorkflowRun(chat.id, approveRun(createRun(workflowPlan)));
		const emitMessage = vi.fn();
		groupChatEmitters.emitMessage = emitMessage;
		vi.mocked(mockProcessManager.spawn).mockClear();

		await routeModeratorResponse(
			chat.id,
			'@Builder Please implement the current stage.',
			mockProcessManager,
			mockAgentDetector
		);
		expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);

		vi.mocked(mockProcessManager.spawn).mockClear();
		await routeUserMessage(chat.id, 'Never mind.', mockProcessManager, mockAgentDetector);

		expect(getWorkflowRun(chat.id)).toMatchObject({
			status: 'aborted',
			abortReason: 'user-cancelled',
		});
		expect(markParticipantResponded(chat.id, 'Builder')).toBe(false);
		expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({ from: 'system', content: 'Workflow cancelled.' })
		);
	});

	it('supersedes a running workflow with a new approval-gated plan', async () => {
		const chat = await createChatWithModerator('Workflow Mid-run Replacement');
		setWorkflowRun(chat.id, approveRun(createRun(workflowPlan)));
		const emitMessage = vi.fn();
		groupChatEmitters.emitMessage = emitMessage;
		vi.mocked(mockProcessManager.spawn).mockClear();

		await routeUserMessage(
			chat.id,
			'```maestro-plan\n{"title":"Revised release","stages":[{"name":"Audit","agents":["Reviewer"],"instruction":"Audit the release"}]}\n```',
			mockProcessManager,
			mockAgentDetector
		);

		expect(getWorkflowRun(chat.id)).toMatchObject({
			status: 'awaiting-approval',
			currentStageIndex: 0,
			plan: {
				title: 'Revised release',
				stages: [expect.objectContaining({ name: 'Audit', agents: ['Reviewer'] })],
			},
		});
		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({
				from: 'system',
				content:
					'Previous workflow superseded by a new plan; approval is required before execution resumes.',
			})
		);
		expect(mockProcessManager.spawn).not.toHaveBeenCalled();
	});

	it('intercepts a moderator plan without dispatching participants or starting synthesis', async () => {
		const chat = await createChatWithModerator('Moderator Workflow Plan');
		await addParticipant(chat.id, 'Builder', 'claude-code', mockProcessManager);
		const emitMessage = vi.fn();
		groupChatEmitters.emitMessage = emitMessage;
		vi.mocked(mockProcessManager.spawn).mockClear();
		vi.mocked(mockAgentDetector.getAgent).mockClear();

		await routeModeratorResponse(
			chat.id,
			'```maestro-plan\n{"title":"Ship release","stages":[{"name":"Build","agents":["Builder"],"instruction":"Build the release","expects":"A release artifact"}]}\n```',
			mockProcessManager,
			mockAgentDetector
		);

		const run = getWorkflowRun(chat.id);
		expect(run).toMatchObject({
			status: 'awaiting-approval',
			currentStageIndex: 0,
			plan: {
				title: 'Ship release',
				stages: [expect.objectContaining({ agents: ['Builder'] })],
			},
		});
		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({
				from: 'system',
				content: expect.stringContaining('Reply `go` to start'),
			})
		);
		expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		expect(mockAgentDetector.getAgent).not.toHaveBeenCalled();
	});

	it('emits a validation error for a malformed moderator plan without storing a run', async () => {
		const chat = await createChatWithModerator('Malformed Workflow Plan');
		const emitMessage = vi.fn();
		groupChatEmitters.emitMessage = emitMessage;

		await routeModeratorResponse(
			chat.id,
			'```maestro-plan\n{"title":"Broken","stages":[}\n```',
			mockProcessManager,
			mockAgentDetector
		);

		expect(getWorkflowRun(chat.id)).toBeUndefined();
		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({
				from: 'system',
				content: expect.stringMatching(/workflow plan error.*not valid json/i),
			})
		);
	});

	it('intercepts a user-pasted plan without spawning the moderator', async () => {
		const chat = await createChatWithModerator('User Workflow Plan');
		const emitMessage = vi.fn();
		groupChatEmitters.emitMessage = emitMessage;
		vi.mocked(mockProcessManager.spawn).mockClear();
		vi.mocked(mockAgentDetector.getAgent).mockClear();

		await routeUserMessage(
			chat.id,
			'```maestro-plan\n{"title":"Review","stages":[{"name":"Review","agents":["Reviewer"],"instruction":"Review the change"}]}\n```',
			mockProcessManager,
			mockAgentDetector
		);

		expect(getWorkflowRun(chat.id)?.status).toBe('awaiting-approval');
		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({ from: 'system', content: expect.stringContaining('Review') })
		);
		expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		expect(mockAgentDetector.getAgent).not.toHaveBeenCalled();
	});
});
