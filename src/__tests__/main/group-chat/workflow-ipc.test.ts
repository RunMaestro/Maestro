/**
 * @file workflow-ipc.test.ts
 * @description Focused coverage for the Group Chat workflow IPC surface.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain, type BrowserWindow } from 'electron';
import type { GroupChatWorkflowPlan } from '../../../shared/group-chat-workflow-types';
import { createRun } from '../../../main/group-chat/workflow-state-machine';
import {
	abortWorkflowRun,
	approveWorkflowRun,
	clearWorkflowRun,
	completeWorkflowStage,
	failWorkflowStage,
	resetAllWorkflowRuns,
	setWorkflowRun,
	setWorkflowRunChangedEmitter,
} from '../../../main/group-chat/workflow-run-registry';
import {
	registerGroupChatHandlers,
	type GroupChatHandlerDependencies,
} from '../../../main/ipc/handlers/groupChat';
import * as groupChatModerator from '../../../main/group-chat/group-chat-moderator';
import * as groupChatRouter from '../../../main/group-chat/group-chat-router';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
	BrowserWindow: vi.fn(),
}));

vi.mock('../../../main/group-chat/group-chat-storage', () => ({
	createGroupChat: vi.fn(),
	loadGroupChat: vi.fn(),
	listGroupChats: vi.fn(),
	deleteGroupChat: vi.fn(),
	updateGroupChat: vi.fn(),
	updateParticipant: vi.fn(),
	addGroupChatHistoryEntry: vi.fn(),
	getGroupChatHistory: vi.fn(),
	deleteGroupChatHistoryEntry: vi.fn(),
	clearGroupChatHistory: vi.fn(),
	getGroupChatHistoryFilePath: vi.fn(),
	getGroupChatDir: vi.fn(),
}));

vi.mock('../../../main/group-chat/group-chat-log', () => ({
	appendToLog: vi.fn(),
	readLog: vi.fn(),
	saveImage: vi.fn(),
}));

vi.mock('../../../main/group-chat/group-chat-moderator', () => ({
	spawnModerator: vi.fn(),
	sendToModerator: vi.fn(),
	killModerator: vi.fn(),
	getModeratorSessionId: vi.fn(),
	isModeratorActive: vi.fn().mockReturnValue(true),
}));

vi.mock('../../../main/group-chat/group-chat-agent', () => ({
	addParticipant: vi.fn(),
	sendToParticipant: vi.fn(),
	removeParticipant: vi.fn(),
	clearAllParticipantSessions: vi.fn(),
}));

vi.mock('../../../main/group-chat/group-chat-router', () => ({
	routeUserMessage: vi.fn(),
	clearPendingParticipants: vi.fn(),
	routeAgentResponse: vi.fn(),
	markParticipantResponded: vi.fn(),
	settleGroupChatToIdle: vi.fn(),
	spawnModeratorSynthesis: vi.fn(),
}));

vi.mock('../../../main/agents', () => ({ AgentDetector: vi.fn() }));

vi.mock('../../../main/stores', () => ({
	getSessionsStore: () => ({ get: () => [] }),
	getSettingsStore: () => ({ get: () => undefined }),
}));

vi.mock('../../../main/group-chat/workflow-artifacts', () => ({
	clearWorkflowRunDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: vi.fn(),
}));

function createPlan(runId = 'run-1'): GroupChatWorkflowPlan {
	return {
		runId,
		title: 'Ship the release',
		createdAt: 1,
		stages: [
			{
				id: 'build',
				name: 'Build',
				agents: ['Builder'],
				mode: 'serial',
				instruction: 'Build it.',
			},
			{
				id: 'verify',
				name: 'Verify',
				agents: ['Reviewer'],
				mode: 'serial',
				instruction: 'Verify it.',
			},
		],
	};
}

describe('Group Chat workflow IPC', () => {
	let handlers: Map<string, Function>;
	let webContentsSend: ReturnType<typeof vi.fn>;
	let processManager: {
		spawn: ReturnType<typeof vi.fn>;
		write: ReturnType<typeof vi.fn>;
		kill: ReturnType<typeof vi.fn>;
	};
	let agentDetector: object;

	beforeEach(() => {
		vi.clearAllMocks();
		resetAllWorkflowRuns();
		setWorkflowRunChangedEmitter(undefined);
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		webContentsSend = vi.fn();
		const mainWindow = {
			isDestroyed: vi.fn().mockReturnValue(false),
			webContents: {
				isDestroyed: vi.fn().mockReturnValue(false),
				send: webContentsSend,
			},
		} as unknown as BrowserWindow;
		processManager = { spawn: vi.fn(), write: vi.fn(), kill: vi.fn() };
		agentDetector = {};

		const dependencies: GroupChatHandlerDependencies = {
			getMainWindow: () => mainWindow,
			getProcessManager: () => processManager,
			getAgentDetector: () => agentDetector as never,
		};
		registerGroupChatHandlers(dependencies);
	});

	afterEach(() => {
		resetAllWorkflowRuns();
		setWorkflowRunChangedEmitter(undefined);
	});

	it('registers all workflow handlers from the registrar used by the live bootstrap', () => {
		const bootstrapSource = readFileSync(
			path.resolve(__dirname, '../../../main/ipc/bootstrap/index.ts'),
			'utf8'
		);
		expect(bootstrapSource).toMatch(/registerGroupChatHandlers\s*\(/);
		for (const channel of [
			'groupChat:getWorkflowRun',
			'groupChat:approveWorkflowPlan',
			'groupChat:cancelWorkflowRun',
		]) {
			expect(handlers.has(channel), `Expected live handler for ${channel}`).toBe(true);
		}
	});

	it('returns the current workflow shape and null when none exists', async () => {
		const run = createRun(createPlan());
		setWorkflowRun('chat-1', run);

		await expect(handlers.get('groupChat:getWorkflowRun')!({}, 'chat-1')).resolves.toBe(run);
		await expect(handlers.get('groupChat:getWorkflowRun')!({}, 'missing')).resolves.toBeNull();
	});

	it('routes button approval and typed go through the same moderator-message function', async () => {
		await expect(
			handlers.get('groupChat:approveWorkflowPlan')!({}, 'chat-1')
		).resolves.toBeUndefined();
		await expect(
			handlers.get('groupChat:sendToModerator')!({}, 'chat-1', 'go')
		).resolves.toBeUndefined();

		expect(groupChatRouter.routeUserMessage).toHaveBeenCalledTimes(2);
		const expectedCall = ['chat-1', 'go', processManager, agentDetector, undefined, undefined];
		expect(vi.mocked(groupChatRouter.routeUserMessage).mock.calls[0]).toEqual(expectedCall);
		expect(vi.mocked(groupChatRouter.routeUserMessage).mock.calls[1]).toEqual(expectedCall);
		expect(groupChatModerator.spawnModerator).not.toHaveBeenCalled();
	});

	it('returns the user-cancelled run shape and null without an active run', async () => {
		setWorkflowRun('chat-1', createRun(createPlan()));

		await expect(handlers.get('groupChat:cancelWorkflowRun')!({}, 'chat-1')).resolves.toMatchObject(
			{
				status: 'aborted',
				abortReason: 'user-cancelled',
			}
		);
		await expect(handlers.get('groupChat:cancelWorkflowRun')!({}, 'missing')).resolves.toBeNull();
		expect(groupChatRouter.clearPendingParticipants).toHaveBeenCalledWith('chat-1');
		expect(groupChatRouter.settleGroupChatToIdle).toHaveBeenCalledWith('chat-1');
	});

	it('emits every stored, approved, advanced, failed, aborted, and cleared transition', async () => {
		const expectLastEmission = (expectedRun: object | null): void => {
			expect(webContentsSend).toHaveBeenLastCalledWith(
				'groupChat:workflowRunChanged',
				'chat-1',
				expectedRun === null ? null : expect.objectContaining(expectedRun)
			);
		};

		setWorkflowRun('chat-1', createRun(createPlan()));
		expectLastEmission({ status: 'awaiting-approval' });

		approveWorkflowRun('chat-1');
		expectLastEmission({ status: 'running', currentStageIndex: 0 });

		completeWorkflowStage('chat-1', {
			stageId: 'build',
			stageName: 'Build',
			summary: 'Built.',
		});
		expectLastEmission({ status: 'running', currentStageIndex: 1 });

		failWorkflowStage('chat-1', 'Verification failed');
		expectLastEmission({ status: 'aborted', abortReason: 'Verification failed' });

		setWorkflowRun('chat-1', createRun(createPlan('run-2')));
		abortWorkflowRun('chat-1', 'user-cancelled');
		expectLastEmission({ status: 'aborted', abortReason: 'user-cancelled' });

		await clearWorkflowRun('chat-1');
		expectLastEmission(null);
		expect(webContentsSend).toHaveBeenCalledTimes(7);
	});
});
