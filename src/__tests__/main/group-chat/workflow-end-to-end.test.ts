/**
 * @file workflow-end-to-end.test.ts
 * @description End-to-end coverage for a complete staged Group Chat workflow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let mockUserDataPath: string;
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === 'userData') return mockUserDataPath;
			throw new Error(`Unknown path name: ${name}`);
		}),
	},
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
			ipcHandlers.set(channel, handler);
		}),
		removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
	},
	BrowserWindow: vi.fn(),
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
import {
	addParticipant,
	clearAllParticipantSessionsGlobal,
	getParticipantSessionId,
} from '../../../main/group-chat/group-chat-agent';
import {
	clearAllModeratorSessions,
	spawnModerator,
	type IProcessManager,
} from '../../../main/group-chat/group-chat-moderator';
import {
	clearPendingParticipants,
	markParticipantResponded,
	respawnParticipantWithRecovery,
	routeAgentResponse,
	routeModeratorResponse,
	routeUserMessage,
	setGetSessionsCallback,
	setModeratorResponseTimeout,
	spawnModeratorSynthesis,
} from '../../../main/group-chat/group-chat-router';
import { getWorkflowRunDir } from '../../../main/group-chat/workflow-artifacts';
import {
	getWorkflowRun,
	resetAllWorkflowRuns,
	setWorkflowRun,
	setWorkflowRunChangedEmitter,
} from '../../../main/group-chat/workflow-run-registry';
import { createGroupChat, deleteGroupChat } from '../../../main/group-chat/group-chat-storage';
import { approveRun, createRun } from '../../../main/group-chat/workflow-state-machine';
import {
	registerGroupChatHandlers,
	type GroupChatHandlerDependencies,
} from '../../../main/ipc/handlers/groupChat';
import { powerManager } from '../../../main/power-manager';
import type { GroupChatWorkflowPlan } from '../../../shared/group-chat-workflow-types';

describe('Group Chat workflow end to end', () => {
	let mockProcessManager: IProcessManager & {
		on: ReturnType<typeof vi.fn>;
		off: ReturnType<typeof vi.fn>;
	};
	let mockAgentDetector: AgentDetector;
	let testDir: string;
	let chatId: string;
	let webContentsSend: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		testDir = path.join(
			os.tmpdir(),
			`workflow-end-to-end-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);
		await fs.mkdir(testDir, { recursive: true });
		mockUserDataPath = testDir;
		ipcHandlers.clear();

		mockProcessManager = {
			spawn: vi.fn().mockReturnValue({ pid: 12345, success: true }),
			write: vi.fn().mockReturnValue(true),
			kill: vi.fn().mockReturnValue(true),
			on: vi.fn(),
			off: vi.fn(),
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
		setWorkflowRunChangedEmitter(undefined);

		webContentsSend = vi.fn();
		registerGroupChatHandlers({
			getMainWindow: () =>
				({
					isDestroyed: vi.fn().mockReturnValue(false),
					webContents: {
						isDestroyed: vi.fn().mockReturnValue(false),
						send: webContentsSend,
					},
				}) as never,
			getProcessManager: () => mockProcessManager,
			getAgentDetector: () => mockAgentDetector,
		} satisfies GroupChatHandlerDependencies);

		const chat = await createGroupChat('Four-stage release', 'claude-code');
		chatId = chat.id;
		await spawnModerator(chat, mockProcessManager);
		for (const participantName of [
			'Builder',
			'Reviewer',
			'Tester',
			'Publisher',
			'Verifier',
			'Observer',
		]) {
			await addParticipant(chatId, participantName, 'claude-code', mockProcessManager);
		}

		setGetSessionsCallback(() =>
			['Builder', 'Reviewer', 'Tester', 'Publisher', 'Verifier', 'Observer'].map((name) => ({
				id: `${name.toLowerCase()}-session`,
				name,
				toolType: 'claude-code',
				cwd: path.join(testDir, name.toLowerCase()),
				isBusy: false,
				...(name === 'Publisher' ? { autoRunFolderPath: path.join(testDir, 'autorun') } : {}),
			}))
		);
		vi.mocked(mockProcessManager.spawn).mockClear();
	});

	afterEach(async () => {
		clearPendingParticipants(chatId);
		powerManager.removeBlockReason(`groupchat:${chatId}`);
		clearAllModeratorSessions();
		clearAllParticipantSessionsGlobal();
		resetAllWorkflowRuns();
		setWorkflowRunChangedEmitter(undefined);
		setGetSessionsCallback(() => []);
		await deleteGroupChat(chatId).catch(() => undefined);
		await fs.rm(testDir, { recursive: true, force: true });
		ipcHandlers.clear();
		vi.clearAllMocks();
	});

	function startFailurePathRun(stages?: GroupChatWorkflowPlan['stages']): GroupChatWorkflowPlan {
		const plan: GroupChatWorkflowPlan = {
			runId: `failure-path-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			title: 'Failure path workflow',
			createdAt: Date.now(),
			stages: stages ?? [
				{
					id: 'build',
					name: 'Build',
					agents: ['Builder'],
					mode: 'serial',
					instruction: 'Build the release candidate.',
				},
			],
		};
		setWorkflowRun(chatId, approveRun(createRun(plan)));
		powerManager.addBlockReason(`groupchat:${chatId}`);
		return plan;
	}

	it('runs serial, parallel, Auto Run, and final stages without cross-stage dispatch', async () => {
		const planBlock = `\`\`\`maestro-plan
${JSON.stringify({
	title: 'Four-stage release',
	stages: [
		{
			id: 'build',
			name: 'Build',
			agents: ['Builder'],
			mode: 'serial',
			instruction: 'Build the release candidate.',
		},
		{
			id: 'review',
			name: 'Parallel review',
			agents: ['Reviewer', 'Tester'],
			mode: 'parallel',
			instruction: 'Review and test the release candidate.',
		},
		{
			id: 'publish',
			name: 'Publish playbook',
			agents: [],
			mode: 'serial',
			instruction: 'Run the publication playbook.',
			autoRun: { participantName: 'Publisher', filename: 'Release.md' },
		},
		{
			id: 'verify',
			name: 'Final verification',
			agents: ['Verifier'],
			mode: 'serial',
			instruction: 'Verify the published release.',
		},
	],
})}
\`\`\``;

		await routeModeratorResponse(chatId, planBlock, mockProcessManager, mockAgentDetector);
		expect(getWorkflowRun(chatId)?.status).toBe('awaiting-approval');
		expect(mockProcessManager.spawn).not.toHaveBeenCalled();

		await routeUserMessage(chatId, '!go', mockProcessManager, mockAgentDetector);
		expect(getWorkflowRun(chatId)).toMatchObject({
			status: 'running',
			currentStageIndex: 0,
			stageStatuses: { build: 'running' },
		});

		await routeModeratorResponse(
			chatId,
			'@Builder Build the release candidate.',
			mockProcessManager,
			mockAgentDetector
		);
		await routeAgentResponse(
			chatId,
			'Builder',
			`Build completed.\n\n${'Detailed build output. '.repeat(220)}`,
			mockProcessManager
		);
		expect(markParticipantResponded(chatId, 'Builder')).toBe(true);
		await spawnModeratorSynthesis(chatId, mockProcessManager, mockAgentDetector);
		const runDir = getWorkflowRunDir(chatId, getWorkflowRun(chatId)!.plan.runId);
		await expect(fs.access(runDir)).resolves.toBeUndefined();

		await routeModeratorResponse(
			chatId,
			'!stage-complete\nThe release candidate is ready for parallel review.',
			mockProcessManager,
			mockAgentDetector
		);
		await routeModeratorResponse(
			chatId,
			'@Reviewer Review the changes. @Tester Run the test suite.',
			mockProcessManager,
			mockAgentDetector
		);

		const spawnsBeforeParallelResponses = mockProcessManager.spawn.mock.calls.length;
		await routeAgentResponse(chatId, 'Reviewer', 'Review passed.', mockProcessManager);
		expect(markParticipantResponded(chatId, 'Reviewer')).toBe(false);
		expect(mockProcessManager.spawn).toHaveBeenCalledTimes(spawnsBeforeParallelResponses);
		expect(getWorkflowRun(chatId)).toMatchObject({
			currentStageIndex: 1,
			stageStatuses: { review: 'running' },
			handoffs: [
				expect.anything(),
				expect.objectContaining({
					participantHandoffs: [expect.objectContaining({ participantName: 'Reviewer' })],
				}),
			],
		});
		await routeAgentResponse(chatId, 'Tester', 'All tests passed.', mockProcessManager);
		expect(markParticipantResponded(chatId, 'Tester')).toBe(true);
		await spawnModeratorSynthesis(chatId, mockProcessManager, mockAgentDetector);
		expect(getWorkflowRun(chatId)?.handoffs[1]?.participantHandoffs).toHaveLength(2);

		await routeModeratorResponse(
			chatId,
			'!stage-complete\nReview and tests passed.',
			mockProcessManager,
			mockAgentDetector
		);
		await routeModeratorResponse(
			chatId,
			'!autorun @Publisher:Release.md',
			mockProcessManager,
			mockAgentDetector
		);
		expect(webContentsSend).toHaveBeenCalledWith(
			'groupChat:autoRunTriggered',
			chatId,
			'Publisher',
			'Release.md'
		);

		const reportAutoRunComplete = ipcHandlers.get('groupChat:reportAutoRunComplete');
		expect(reportAutoRunComplete).toBeDefined();
		await reportAutoRunComplete!(
			{},
			chatId,
			'Publisher',
			'Publication playbook completed with all tasks checked.'
		);
		expect(getWorkflowRun(chatId)?.handoffs[2]?.participantHandoffs).toContainEqual({
			participantName: 'Publisher',
			mode: 'inline',
			content: 'Publication playbook completed with all tasks checked.',
		});

		await routeModeratorResponse(
			chatId,
			'!stage-complete\nThe publication playbook completed successfully.',
			mockProcessManager,
			mockAgentDetector
		);
		await routeModeratorResponse(
			chatId,
			'@Verifier Verify the published release.',
			mockProcessManager,
			mockAgentDetector
		);
		await routeAgentResponse(chatId, 'Verifier', 'Published release verified.', mockProcessManager);
		expect(markParticipantResponded(chatId, 'Verifier')).toBe(true);
		await spawnModeratorSynthesis(chatId, mockProcessManager, mockAgentDetector);
		await routeModeratorResponse(
			chatId,
			'!stage-complete\nThe four-stage release is complete.',
			mockProcessManager,
			mockAgentDetector
		);

		// Terminal runs remain as a non-active completion snapshot for the renderer;
		// participant tracking and disposable on-disk state must both be cleared.
		const completedRun = getWorkflowRun(chatId);
		expect(completedRun).toMatchObject({
			status: 'complete',
			currentStageIndex: 4,
			stageStatuses: {
				build: 'complete',
				review: 'complete',
				publish: 'complete',
				verify: 'complete',
			},
		});
		expect(markParticipantResponded(chatId, 'Observer')).toBe(false);
		await expect(fs.access(runDir)).rejects.toMatchObject({ code: 'ENOENT' });

		const participantDispatches = mockProcessManager.spawn.mock.calls
			.map(([options]) => options.sessionId as string)
			.filter((sessionId) => sessionId.includes('-participant-'))
			.map((sessionId) =>
				['Builder', 'Reviewer', 'Tester', 'Publisher', 'Verifier', 'Observer'].find((name) =>
					sessionId.includes(`-participant-${name}-`)
				)
			);
		expect(participantDispatches).toEqual(['Builder', 'Reviewer', 'Tester', 'Verifier']);
	});

	it('fails and releases power when a participant times out mid-stage', async () => {
		vi.useFakeTimers();
		try {
			startFailurePathRun();
			await routeModeratorResponse(
				chatId,
				'@Builder Build the release candidate.',
				mockProcessManager,
				mockAgentDetector
			);
			const participantSessionId = getParticipantSessionId(chatId, 'Builder');

			await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
			await vi.waitFor(() => {
				expect(getWorkflowRun(chatId)).toMatchObject({
					status: 'aborted',
					stageStatuses: { build: 'failed' },
					abortReason: expect.stringContaining('Participant @Builder went silent'),
				});
			});

			expect(mockProcessManager.kill).toHaveBeenCalledWith(participantSessionId);
			expect(powerManager.getStatus().reasons).not.toContain(`groupchat:${chatId}`);
		} finally {
			vi.useRealTimers();
		}
	});

	it('fails and releases power when the moderator times out mid-stage', async () => {
		vi.useFakeTimers();
		try {
			startFailurePathRun();
			const moderatorTurnSessionId = `group-chat-${chatId}-moderator-timeout-turn`;
			setModeratorResponseTimeout(chatId, mockProcessManager, moderatorTurnSessionId);

			await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
			await vi.waitFor(() => {
				expect(getWorkflowRun(chatId)).toMatchObject({
					status: 'aborted',
					stageStatuses: { build: 'failed' },
					abortReason: expect.stringContaining('Moderator went silent'),
				});
				expect(powerManager.getStatus().reasons).not.toContain(`groupchat:${chatId}`);
			});

			expect(mockProcessManager.kill).toHaveBeenCalledWith(moderatorTurnSessionId);
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps the run active after successful participant recovery and releases power on cleanup', async () => {
		startFailurePathRun();
		await routeModeratorResponse(
			chatId,
			'@Builder Build the release candidate.',
			mockProcessManager,
			mockAgentDetector
		);
		vi.mocked(mockProcessManager.spawn).mockClear();

		await respawnParticipantWithRecovery(chatId, 'Builder', mockProcessManager, mockAgentDetector);

		expect(mockProcessManager.spawn).toHaveBeenCalledOnce();
		expect(mockProcessManager.spawn.mock.calls[0]?.[0]?.sessionId).toContain(
			`group-chat-${chatId}-participant-Builder-recovery-`
		);
		expect(getWorkflowRun(chatId)).toMatchObject({
			status: 'running',
			stageStatuses: { build: 'running' },
		});
		expect(powerManager.getStatus().reasons).toContain(`groupchat:${chatId}`);

		await ipcHandlers.get('groupChat:stopAll')!({}, chatId);
		expect(powerManager.getStatus().reasons).not.toContain(`groupchat:${chatId}`);
	});

	it('aborts, clears pending work, and releases power when stopAll runs mid-stage', async () => {
		startFailurePathRun();
		await routeModeratorResponse(
			chatId,
			'@Builder Build the release candidate.',
			mockProcessManager,
			mockAgentDetector
		);
		expect(markParticipantResponded(chatId, 'Builder')).toBe(true);

		await ipcHandlers.get('groupChat:stopAll')!({}, chatId);

		expect(getWorkflowRun(chatId)).toMatchObject({
			status: 'aborted',
			abortReason: 'moderator-stopped',
		});
		expect(markParticipantResponded(chatId, 'Builder')).toBe(false);
		expect(webContentsSend).toHaveBeenCalledWith('groupChat:stateChange', chatId, 'idle');
		expect(powerManager.getStatus().reasons).not.toContain(`groupchat:${chatId}`);
	});

	it('warns without aborting when a later-stage participant is removed and releases power on cleanup', async () => {
		startFailurePathRun([
			{
				id: 'build',
				name: 'Build',
				agents: ['Builder'],
				mode: 'serial',
				instruction: 'Build the release candidate.',
			},
			{
				id: 'review',
				name: 'Review',
				agents: ['Reviewer'],
				mode: 'serial',
				instruction: 'Review the release candidate.',
			},
		]);

		await ipcHandlers.get('groupChat:removeParticipant')!({}, chatId, 'Reviewer');

		expect(getWorkflowRun(chatId)).toMatchObject({
			status: 'running',
			currentStageIndex: 0,
			stageStatuses: { build: 'running', review: 'pending' },
		});
		expect(webContentsSend).toHaveBeenCalledWith(
			'groupChat:message',
			chatId,
			expect.objectContaining({
				from: 'system',
				content: expect.stringContaining('later workflow stages: Review'),
			})
		);
		expect(powerManager.getStatus().reasons).toContain(`groupchat:${chatId}`);

		await ipcHandlers.get('groupChat:stopAll')!({}, chatId);
		expect(powerManager.getStatus().reasons).not.toContain(`groupchat:${chatId}`);
	});
});
