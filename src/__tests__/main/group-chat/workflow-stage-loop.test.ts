/**
 * @file workflow-stage-loop.test.ts
 * @description Focused unit and integration coverage for workflow stage execution.
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
	markParticipantResponded,
	routeAgentResponse,
	routeModeratorResponse,
	routeUserMessage,
} from '../../../main/group-chat/group-chat-router';
import {
	createGroupChat,
	deleteGroupChat,
	getGroupChatHistory,
} from '../../../main/group-chat/group-chat-storage';
import { readLog } from '../../../main/group-chat/group-chat-log';
import {
	extractStageDirective,
	stripStageDirectives,
} from '../../../main/group-chat/workflow-plan-parser';
import {
	getWorkflowRun,
	resetAllWorkflowRuns,
	setWorkflowRun,
} from '../../../main/group-chat/workflow-run-registry';
import { approveRun, createRun } from '../../../main/group-chat/workflow-state-machine';
import type { GroupChatWorkflowPlan } from '../../../shared/group-chat-workflow-types';

describe('workflow stage loop', () => {
	let mockProcessManager: IProcessManager;
	let mockAgentDetector: AgentDetector;
	let testDir: string;
	let createdChatIds: string[];

	const workflowPlan: GroupChatWorkflowPlan = {
		runId: 'run-stage-loop',
		title: 'Release workflow',
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

	beforeEach(async () => {
		testDir = path.join(
			os.tmpdir(),
			`workflow-stage-loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

	describe('stage directives', () => {
		it.each([
			['!stage-complete\nBuilt and tested the feature.', 'complete'],
			['   !stage-failed\nThe dependency is unavailable.', 'failed'],
			['**!stage-complete**\nReview passed.', 'complete'],
			['\t__!stage-failed__\nReview failed.', 'failed'],
		])('extracts %s', (text, kind) => {
			expect(extractStageDirective(text)).toEqual({
				kind,
				body: text.split('\n').slice(1).join('\n'),
			});
		});

		it('extracts a directive at the start of a later line', () => {
			expect(
				extractStageDirective('Review is finished.\n!stage-complete\nPass the patch to QA.')
			).toEqual({ kind: 'complete', body: 'Pass the patch to QA.' });
		});

		it('does not match absent, inline, or extended directives', () => {
			expect(extractStageDirective('No directive here.')).toBeNull();
			expect(extractStageDirective('Result: !stage-complete')).toBeNull();
			expect(extractStageDirective('!stage-complete later')).toBeNull();
		});

		it('strips only directive lines and keeps handoff prose', () => {
			const text = [
				'Review is finished.',
				' **!stage-complete** ',
				'The tested patch is ready for QA.',
			].join('\n');

			expect(stripStageDirectives(text)).toBe(
				'Review is finished.\n\nThe tested patch is ready for QA.'
			);
		});
	});

	it('advances stage 1 of 3, records its handoff, and spawns stage 2', async () => {
		const chat = await createChatWithModerator('Workflow Stage Advance');
		const threeStagePlan: GroupChatWorkflowPlan = {
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
				{
					id: 'stage-3',
					name: 'Release',
					agents: ['Releaser'],
					mode: 'serial',
					instruction: 'Release the approved implementation',
				},
			],
		};
		setWorkflowRun(chat.id, approveRun(createRun(threeStagePlan)));
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
				content: 'Stage 1 of 3 complete: Build. Starting stage 2: Review.',
			})
		);
		expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
		const prompt = vi.mocked(mockProcessManager.spawn).mock.calls[0]?.[0]?.prompt ?? '';
		expect(prompt).toContain('Stage 2 of 3: Review');
		expect(prompt).toContain('From Build: The implementation and tests are ready.');
		const history = await getGroupChatHistory(chat.id);
		expect(history).toContainEqual(
			expect.objectContaining({
				participantName: 'Moderator',
				type: 'synthesis',
				summary: 'Stage 1 of 3 complete: Build. Starting stage 2: Review.',
			})
		);
	});

	it('writes a large running-stage response as an artifact while emitting the full body', async () => {
		const chat = await createChatWithModerator('Workflow Large Response');
		await addParticipant(chat.id, 'Builder', 'claude-code', mockProcessManager);
		setWorkflowRun(chat.id, approveRun(createRun(workflowPlan)));
		const emitMessage = vi.fn();
		groupChatEmitters.emitMessage = emitMessage;
		const response = `Implementation details.\n\n${'substantial result '.repeat(300)}`;

		await routeAgentResponse(chat.id, 'Builder', response, mockProcessManager);

		const run = getWorkflowRun(chat.id);
		const participantHandoff = run?.handoffs[0]?.participantHandoffs?.[0];
		expect(participantHandoff).toMatchObject({
			participantName: 'Builder',
			mode: 'artifact',
		});
		if (!participantHandoff || participantHandoff.mode !== 'artifact') {
			throw new Error('Expected an artifact handoff');
		}
		expect(run?.handoffs[0].artifactPaths).toEqual([participantHandoff.artifactPath]);
		expect(await fs.readFile(participantHandoff.artifactPath, 'utf-8')).toBe(response);
		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({ from: 'Builder', content: response })
		);
		expect(await readLog(chat.logPath)).toContainEqual(
			expect.objectContaining({ from: 'Builder', content: response })
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

	it('fails the current stage and stops without further dispatch', async () => {
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

		for (const message of [
			'I am still considering the implementation.',
			'I need to think about it again.',
			'I have no next action yet.',
		]) {
			await routeModeratorResponse(chat.id, message, mockProcessManager, mockAgentDetector);
		}

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
});
