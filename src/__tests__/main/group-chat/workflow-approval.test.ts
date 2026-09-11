/**
 * @file workflow-approval.test.ts
 * @description Tests for approving, revising, and cancelling pending Group Chat workflows.
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
import { isWorkflowApproval } from '../../../main/group-chat/workflow-plan-parser';
import { routeUserMessage } from '../../../main/group-chat/group-chat-router';
import { createGroupChat, deleteGroupChat } from '../../../main/group-chat/group-chat-storage';
import {
	getWorkflowRun,
	resetAllWorkflowRuns,
	setWorkflowRun,
} from '../../../main/group-chat/workflow-run-registry';
import { createRun } from '../../../main/group-chat/workflow-state-machine';
import type { GroupChatWorkflowPlan } from '../../../shared/group-chat-workflow-types';

describe('workflow approval', () => {
	let mockProcessManager: IProcessManager;
	let mockAgentDetector: AgentDetector;
	let testDir: string;
	let createdChatIds: string[];

	beforeEach(async () => {
		testDir = path.join(
			os.tmpdir(),
			`workflow-approval-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
		groupChatEmitters.emitParticipantState = undefined;
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
		runId: 'run-approval',
		title: 'Approval workflow',
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

	describe('isWorkflowApproval', () => {
		it.each(['go', 'Run it!', 'START.', 'approved', 'yes, go!', 'ship it', '!go'])(
			'accepts %s',
			(text) => {
				expect(isWorkflowApproval(text)).toBe(true);
			}
		);

		it.each([
			'We should go back and revise the rollout before starting anything.',
			'good plan',
			'not approved',
			'go with a different agent',
			'',
		])('rejects %s', (text) => {
			expect(isWorkflowApproval(text)).toBe(false);
		});
	});

	it('moves an approved run to stage 1, emits a system message, and spawns the moderator', async () => {
		const chat = await createChatWithModerator('Approve Workflow');
		setWorkflowRun(chat.id, createRun(workflowPlan));
		const emitMessage = vi.fn();
		groupChatEmitters.emitMessage = emitMessage;
		vi.mocked(mockProcessManager.spawn).mockClear();

		await routeUserMessage(chat.id, 'Ship it!', mockProcessManager, mockAgentDetector);

		const run = getWorkflowRun(chat.id);
		expect(run?.status).toBe('running');
		expect(run?.stageStatuses['stage-1']).toBe('running');
		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({
				from: 'system',
				content: 'Workflow started: stage 1 of 1, Build',
			})
		);
		expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
		const prompt = vi.mocked(mockProcessManager.spawn).mock.calls[0]?.[0]?.prompt ?? '';
		expect(prompt).toContain('## Approved Workflow Stage');
		expect(prompt).toContain('Instruction: Build the feature');
	});

	it('keeps revision feedback pending and gives the prior plan only to the moderator', async () => {
		const chat = await createChatWithModerator('Revise Workflow');
		await addParticipant(chat.id, 'Builder', 'claude-code', mockProcessManager);
		setWorkflowRun(chat.id, createRun(workflowPlan));
		const emitParticipantState = vi.fn();
		groupChatEmitters.emitParticipantState = emitParticipantState;
		vi.mocked(mockProcessManager.spawn).mockClear();

		await routeUserMessage(
			chat.id,
			'Add a security review before the build.',
			mockProcessManager,
			mockAgentDetector
		);

		expect(getWorkflowRun(chat.id)?.status).toBe('awaiting-approval');
		expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
		expect(emitParticipantState).not.toHaveBeenCalled();
		const prompt = vi.mocked(mockProcessManager.spawn).mock.calls[0]?.[0]?.prompt ?? '';
		expect(prompt).toContain('mock prompt for group-chat-workflow-planning');
		expect(prompt).toContain('## Workflow Plan Revision');
		expect(prompt).toContain('emit a replacement `maestro-plan` block');
		expect(prompt).toContain('"runId": "run-approval"');
	});

	it('clears a cancelled run without spawning the moderator', async () => {
		const chat = await createChatWithModerator('Cancel Workflow');
		setWorkflowRun(chat.id, createRun(workflowPlan));
		const emitMessage = vi.fn();
		groupChatEmitters.emitMessage = emitMessage;
		vi.mocked(mockProcessManager.spawn).mockClear();

		await routeUserMessage(chat.id, '!cancel', mockProcessManager, mockAgentDetector);

		expect(getWorkflowRun(chat.id)).toBeUndefined();
		expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		expect(emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({ from: 'system', content: 'Workflow cancelled.' })
		);
	});
});
