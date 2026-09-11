/**
 * @file workflow-prompt-context.test.ts
 * @description Tests for compact active-workflow prompt context.
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
import { clearAllParticipantSessionsGlobal } from '../../../main/group-chat/group-chat-agent';
import {
	clearAllModeratorSessions,
	spawnModerator,
	type IProcessManager,
} from '../../../main/group-chat/group-chat-moderator';
import {
	routeUserMessage,
	spawnModeratorSynthesis,
} from '../../../main/group-chat/group-chat-router';
import { createGroupChat, deleteGroupChat } from '../../../main/group-chat/group-chat-storage';
import {
	buildCurrentStageContext,
	buildPlanContextBlock,
} from '../../../main/group-chat/workflow-prompt-context';
import {
	resetAllWorkflowRuns,
	setWorkflowRun,
} from '../../../main/group-chat/workflow-run-registry';
import {
	approveRun,
	completeStage,
	createRun as createWorkflowRun,
} from '../../../main/group-chat/workflow-state-machine';
import type { GroupChatWorkflowRun } from '../../../shared/group-chat-workflow-types';

function createRun(): GroupChatWorkflowRun {
	return {
		plan: {
			runId: 'run-context',
			title: 'Release workflow',
			createdAt: 1,
			stages: [
				{
					id: 'stage-1',
					name: 'Plan',
					agents: ['Planner'],
					mode: 'serial',
					instruction: 'Plan the release.\n  Keep it focused.',
				},
				{
					id: 'stage-2',
					name: 'Build',
					agents: ['Builder', 'Reviewer'],
					mode: 'parallel',
					instruction: 'Build and review the release.',
				},
				{
					id: 'stage-3',
					name: 'Publish',
					agents: [],
					mode: 'serial',
					instruction: 'Publish the approved artifact.',
					autoRun: { participantName: 'Publisher', filename: 'Release.md' },
				},
			],
		},
		status: 'running',
		currentStageIndex: 1,
		stageStatuses: {
			'stage-1': 'complete',
			'stage-2': 'running',
			'stage-3': 'pending',
		},
		handoffs: [
			{
				stageId: 'stage-1',
				stageName: 'Plan',
				summary: 'Plan complete.\nRelease scope agreed.',
				artifactPaths: ['full-body-must-not-render.md'],
			},
		],
	};
}

describe('buildPlanContextBlock', () => {
	it('renders compact stage state and handoff summaries', () => {
		const context = buildPlanContextBlock(createRun());

		expect(context).toContain('## Active Workflow Plan');
		expect(context).toContain('Current stage: 2 of 3');
		expect(context).toContain(
			'1. [complete] Plan — Agents: @Planner — Plan the release. Keep it focused.'
		);
		expect(context).toContain(
			'2. [running] Build — Agents: @Builder, @Reviewer — Build and review the release.'
		);
		expect(context).toContain(
			'3. [pending] Publish — Agents: Auto Run @Publisher (Release.md) — Publish the approved artifact.'
		);
		expect(context).toContain('- Plan: Plan complete. Release scope agreed.');
		expect(context).not.toContain('full-body-must-not-render.md');
	});

	it('marks a finished cursor and an empty handoff list explicitly', () => {
		const run = createRun();
		run.status = 'complete';
		run.currentStageIndex = run.plan.stages.length;
		run.handoffs = [];

		const context = buildPlanContextBlock(run);

		expect(context).toContain('Current stage: complete (3 of 3)');
		expect(context).toContain('### Handoff Summaries\n(none)');
	});
});

describe('buildCurrentStageContext', () => {
	it('formats inline and artifact responses without expanding artifact bodies', () => {
		const run = createRun();
		run.handoffs.push({
			stageId: 'stage-2',
			stageName: 'Build',
			summary: '',
			artifactPaths: ['/tmp/run/stage-2/Reviewer.md'],
			participantHandoffs: [
				{ participantName: 'Builder', mode: 'inline', content: 'The patch is ready.' },
				{
					participantName: 'Reviewer',
					mode: 'artifact',
					digest: 'The detailed review found two follow-ups.',
					artifactPath: '/tmp/run/stage-2/Reviewer.md',
				},
			],
		});

		const context = buildCurrentStageContext(run);

		expect(context).toContain('### Builder\n\nThe patch is ready.');
		expect(context).toContain('### Reviewer\n\nThe detailed review found two follow-ups.');
		expect(context).toContain('Full output: /tmp/run/stage-2/Reviewer.md');
	});
});

describe('workflow stage context in moderator spawn prompts', () => {
	let mockProcessManager: IProcessManager;
	let mockAgentDetector: AgentDetector;
	let testDir: string;
	let createdChatIds: string[];

	beforeEach(async () => {
		testDir = path.join(
			os.tmpdir(),
			`workflow-prompt-context-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
		await fs.rm(testDir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	async function createChatWithModerator(name: string) {
		const chat = await createGroupChat(name, 'claude-code');
		createdChatIds.push(chat.id);
		await spawnModerator(chat, mockProcessManager);
		vi.mocked(mockProcessManager.spawn).mockClear();
		return chat;
	}

	it('passes the current stage and prior handoff to user and synthesis spawns', async () => {
		const chat = await createChatWithModerator('Active workflow context');
		const run = completeStage(approveRun(createWorkflowRun(createRun().plan)), {
			stageId: 'stage-1',
			stageName: 'Plan',
			summary: 'Release scope agreed and acceptance criteria captured.',
		});
		setWorkflowRun(chat.id, run);

		await routeUserMessage(
			chat.id,
			'Continue the release workflow.',
			mockProcessManager,
			mockAgentDetector
		);

		const userPrompt = vi.mocked(mockProcessManager.spawn).mock.calls[0]?.[0]?.prompt ?? '';
		expect(userPrompt).toContain('## Active Workflow Plan');
		expect(userPrompt).toContain('## Current Stage');
		expect(userPrompt).toContain('Stage 2 of 3: Build');
		expect(userPrompt).toContain(
			'From Plan: Release scope agreed and acceptance criteria captured.'
		);

		vi.mocked(mockProcessManager.spawn).mockClear();
		await spawnModeratorSynthesis(chat.id, mockProcessManager, mockAgentDetector);

		const synthesisPrompt = vi.mocked(mockProcessManager.spawn).mock.calls[0]?.[0]?.prompt ?? '';
		expect(synthesisPrompt).toContain('## Active Workflow Plan');
		expect(synthesisPrompt).toContain('## Current Stage');
		expect(synthesisPrompt).toContain('Stage 2 of 3: Build');
		expect(synthesisPrompt).toContain(
			'From Plan: Release scope agreed and acceptance criteria captured.'
		);
	});

	it('omits stage context from user and synthesis spawns without an active run', async () => {
		const chat = await createChatWithModerator('Inactive workflow context');

		await routeUserMessage(chat.id, 'Help plan a release.', mockProcessManager, mockAgentDetector);

		const userPrompt = vi.mocked(mockProcessManager.spawn).mock.calls[0]?.[0]?.prompt ?? '';
		expect(userPrompt).not.toContain('## Active Workflow Plan');
		expect(userPrompt).not.toContain('## Current Stage');

		vi.mocked(mockProcessManager.spawn).mockClear();
		await spawnModeratorSynthesis(chat.id, mockProcessManager, mockAgentDetector);

		const synthesisPrompt = vi.mocked(mockProcessManager.spawn).mock.calls[0]?.[0]?.prompt ?? '';
		expect(synthesisPrompt).not.toContain('## Active Workflow Plan');
		expect(synthesisPrompt).not.toContain('## Current Stage');
	});
});
