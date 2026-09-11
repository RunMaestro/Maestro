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
	routeModeratorResponse,
	routeUserMessage,
} from '../../../main/group-chat/group-chat-router';
import { createGroupChat, deleteGroupChat } from '../../../main/group-chat/group-chat-storage';
import {
	getWorkflowRun,
	resetAllWorkflowRuns,
} from '../../../main/group-chat/workflow-run-registry';

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
