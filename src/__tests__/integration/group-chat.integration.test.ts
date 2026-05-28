/**
 * @file group-chat.integration.test.ts
 * @description Integration tests for Group Chat feature.
 *
 * These tests require real agents and exercise the full flow:
 * - Moderator spawning and responses
 * - Multi-agent collaboration
 * - Chat log persistence
 * - Message routing
 *
 * Run with: npm run test:integration
 * Skip in CI with: SKIP_INTEGRATION_TESTS=true
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

// Mock Electron app module before importing modules that use it
vi.mock('electron', () => ({
	app: {
		getPath: (name: string) => {
			if (name === 'userData') {
				return path.join(os.tmpdir(), 'maestro-test-group-chat');
			}
			return os.tmpdir();
		},
	},
}));
import { createGroupChat, loadGroupChat } from '../../main/group-chat/group-chat-storage';
import { readLog } from '../../main/group-chat/group-chat-log';
import {
	spawnModerator,
	killModerator,
	IProcessManager,
} from '../../main/group-chat/group-chat-moderator';
import { addParticipant } from '../../main/group-chat/group-chat-agent';
import {
	clearPendingParticipants,
	clearActiveParticipantTaskSession,
	extractAllMentions,
	extractAutoRunDirectives,
	extractMentions,
	getGroupChatReadOnlyState,
	getPendingParticipants,
	markParticipantResponded,
	respawnParticipantWithRecovery,
	routeAgentResponse,
	routeModeratorResponse,
	routeUserMessage,
	setGetAgentConfigCallback,
	setGetCustomEnvVarsCallback,
	setGetModeratorSettingsCallback,
	setGetSessionsCallback,
	setGroupChatReadOnlyState,
	setSshStore,
	spawnModeratorSynthesis,
} from '../../main/group-chat/group-chat-router';
import { groupChatEmitters } from '../../main/ipc/handlers/groupChat';
import { AgentDetector } from '../../main/agents';
import { initializeStores } from '../../main/stores';
import {
	selectTestAgents,
	waitForAgentResponse,
	waitForModeratorResponse,
	extractNumber,
	cleanupGroupChat,
	shouldSkipIntegrationTests,
	TestAgentSelection,
} from './group-chat-test-utils';

/**
 * Mock process manager that simulates agent interactions.
 *
 * In a real integration test environment, this would be replaced with
 * the actual process manager from the Electron main process.
 * For now, we provide a mock that demonstrates the expected behavior.
 */
function createMockProcessManager(): IProcessManager & {
	spawnedSessions: Map<
		string,
		{
			toolType: string;
			prompt?: string;
			cwd?: string;
			command?: string;
			args?: string[];
			readOnlyMode?: boolean;
			customEnvVars?: Record<string, string>;
			shell?: string;
			runInShell?: boolean;
			sendPromptViaStdin?: boolean;
			sendPromptViaStdinRaw?: boolean;
		}
	>;
	writtenMessages: Map<string, string[]>;
} {
	const spawnedSessions = new Map<
		string,
		{
			toolType: string;
			prompt?: string;
			cwd?: string;
			command?: string;
			args?: string[];
			readOnlyMode?: boolean;
			customEnvVars?: Record<string, string>;
			shell?: string;
			runInShell?: boolean;
			sendPromptViaStdin?: boolean;
			sendPromptViaStdinRaw?: boolean;
		}
	>();
	const writtenMessages = new Map<string, string[]>();

	return {
		spawnedSessions,
		writtenMessages,

		spawn(config) {
			spawnedSessions.set(config.sessionId, {
				toolType: config.toolType,
				prompt: config.prompt,
				cwd: config.cwd,
				command: config.command,
				args: config.args,
				readOnlyMode: config.readOnlyMode,
				customEnvVars: config.customEnvVars,
				shell: config.shell,
				runInShell: config.runInShell,
				sendPromptViaStdin: config.sendPromptViaStdin,
				sendPromptViaStdinRaw: config.sendPromptViaStdinRaw,
			});
			return { pid: Math.floor(Math.random() * 10000), success: true };
		},

		write(sessionId: string, data: string) {
			const messages = writtenMessages.get(sessionId) || [];
			messages.push(data);
			writtenMessages.set(sessionId, messages);
			return true;
		},

		kill(sessionId: string) {
			spawnedSessions.delete(sessionId);
			writtenMessages.delete(sessionId);
			return true;
		},
	};
}

/**
 * Get agents for testing.
 * In real integration tests, this would detect installed agents.
 */
function getTestAgents(): TestAgentSelection {
	// For mock tests, we use fixed agent names
	// Real integration tests would call getAvailableAgents()
	return selectTestAgents(['claude-code', 'opencode']);
}

/**
 * Create a mock agent detector for testing.
 */
function createMockAgentDetector(): AgentDetector {
	return {
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
}

function createUnavailableAgentDetector(agentId = 'claude-code'): AgentDetector {
	return {
		...createMockAgentDetector(),
		getAgent: vi.fn().mockResolvedValue({
			id: agentId,
			name: 'Unavailable Agent',
			binaryName: agentId,
			command: agentId,
			args: [],
			available: false,
			path: undefined,
			capabilities: {},
		}),
	} as unknown as AgentDetector;
}

function createSshRemoteStore() {
	return {
		getSshRemotes: vi.fn(() => [
			{
				id: 'remote-1',
				name: 'Dev Remote',
				host: 'dev.example.test',
				port: 22,
				username: 'dev',
				privateKeyPath: '',
				enabled: true,
			},
		]),
	};
}

describe('Group Chat Integration Tests', () => {
	const createdChatIds: string[] = [];

	// Skip integration tests if environment variable is set
	beforeAll(async () => {
		const userDataPath = path.join(os.tmpdir(), 'maestro-test-group-chat');
		await fs.rm(userDataPath, { recursive: true, force: true });
		initializeStores({ productionDataPath: userDataPath });

		if (shouldSkipIntegrationTests()) {
			console.log('Skipping integration tests (SKIP_INTEGRATION_TESTS=true)');
		}
	});

	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		for (const key of Object.keys(groupChatEmitters) as Array<keyof typeof groupChatEmitters>) {
			delete groupChatEmitters[key];
		}
		setGetSessionsCallback(() => []);
		setGetCustomEnvVarsCallback(() => undefined);
		setGetAgentConfigCallback(() => ({}));
		setGetModeratorSettingsCallback(() => ({
			standingInstructions: '',
			conductorProfile: '',
		}));
		setSshStore(null as never);
	});

	// Clean up after each test
	afterEach(async () => {
		for (const chatId of createdChatIds) {
			clearPendingParticipants(chatId);
			await cleanupGroupChat(chatId);
		}
		createdChatIds.length = 0;
		vi.restoreAllMocks();
	});

	async function createStartedChat(name: string, moderatorAgentId = 'claude-code') {
		const processManager = createMockProcessManager();
		const agentDetector = createMockAgentDetector();
		const groupChat = await createGroupChat(name, moderatorAgentId);
		createdChatIds.push(groupChat.id);
		await spawnModerator(groupChat, processManager);
		return { groupChat, processManager, agentDetector };
	}

	it('routes mention parsing, autorun directives, read-only state, and empty pending responses', () => {
		const participants = [
			{ name: 'QA Lead', agentId: 'claude-code', sessionId: 'qa', addedAt: Date.now() },
			{
				name: 'RunMaestro.ai',
				agentId: 'claude-code',
				sessionId: 'maestro',
				addedAt: Date.now(),
			},
			{ name: 'Agent2', agentId: 'opencode', sessionId: 'agent-2', addedAt: Date.now() },
		];

		expect(
			extractMentions(
				'Please ask **@QA-Lead**, `@RunMaestro.ai`, and @Agent2 please.',
				participants
			)
		).toEqual(['QA Lead', 'RunMaestro.ai', 'Agent2']);
		expect(extractAllMentions('Ping _@QA-Lead_ and @Ghost, then @QA-Lead again.')).toEqual([
			'QA-Lead',
			'Ghost',
		]);
		expect(extractMentions('Ignore @** ', participants)).toEqual([]);
		expect(extractAllMentions('Ignore @** ')).toEqual([]);

		const directives = extractAutoRunDirectives(
			'Visible update\n!autorun @QA-Lead:plan.md\n!autorun @QA-Lead\n!autorun @Agent2'
		);
		expect(directives.autoRunDirectives).toEqual([
			{ participantName: 'QA-Lead', filename: 'plan.md' },
			{ participantName: 'Agent2', filename: undefined },
		]);
		expect(directives.autoRunParticipants).toEqual(['QA-Lead', 'Agent2']);
		expect(directives.cleanedText).toBe('Visible update');
		expect(extractAutoRunDirectives('!autorun @**').autoRunDirectives).toEqual([]);

		expect(markParticipantResponded('missing-chat', 'QA Lead')).toBe(false);
		clearActiveParticipantTaskSession('router-helper-chat', 'QA Lead');
		setGroupChatReadOnlyState('router-helper-chat', true);
		expect(getGroupChatReadOnlyState('router-helper-chat')).toBe(true);
		setGroupChatReadOnlyState('router-helper-chat', false);
		expect(getGroupChatReadOnlyState('router-helper-chat')).toBe(false);
	});

	it('auto-adds mentioned sessions before user and moderator routing', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const { groupChat, processManager, agentDetector } = await createStartedChat('Auto Add Router');
		const designCwd = path.join(os.tmpdir(), 'design-cwd');
		const freshCwd = path.join(os.tmpdir(), 'fresh-cwd');
		const emitParticipantsChanged = vi.fn();
		groupChatEmitters.emitParticipantsChanged = emitParticipantsChanged;
		setGetSessionsCallback(() => [
			{
				id: 'design-session',
				name: 'Design Lead',
				toolType: 'opencode',
				cwd: designCwd,
				customArgs: '--fast',
				customEnvVars: { SESSION_ENV: 'yes' },
				customModel: 'qwen-fast',
			},
			{
				id: 'fresh-session',
				name: 'Fresh Voice',
				toolType: 'claude-code',
				cwd: freshCwd,
			},
			{
				id: 'terminal-session',
				name: 'Terminal Only',
				toolType: 'terminal',
				cwd: os.tmpdir(),
			},
		]);

		await routeUserMessage(
			groupChat.id,
			'Please include @Design-Lead and ignore @Terminal-Only.',
			processManager,
			agentDetector
		);

		let updated = await loadGroupChat(groupChat.id);
		expect(updated?.participants.map((p) => p.name)).toContain('Design Lead');
		expect(updated?.participants.map((p) => p.name)).not.toContain('Terminal Only');
		expect(emitParticipantsChanged).toHaveBeenCalledWith(
			groupChat.id,
			expect.arrayContaining([expect.objectContaining({ name: 'Design Lead' })])
		);

		processManager.spawnedSessions.clear();
		await routeModeratorResponse(
			groupChat.id,
			'@Fresh-Voice please review the design direction.',
			processManager,
			agentDetector
		);

		updated = await loadGroupChat(groupChat.id);
		expect(updated?.participants.map((p) => p.name)).toContain('Fresh Voice');
		const freshSpawn = Array.from(processManager.spawnedSessions.values()).find(
			(session) => session.cwd === freshCwd && session.prompt?.includes('Fresh Voice')
		);
		expect(freshSpawn).toBeTruthy();
	});

	it('reports user-message routing failures and dependency fallbacks', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const processManager = createMockProcessManager();
		const agentDetector = createMockAgentDetector();

		await expect(
			routeUserMessage('missing-chat', 'hello', processManager, agentDetector)
		).rejects.toThrow('Group chat not found');

		const inactiveChat = await createGroupChat('Inactive Router', 'claude-code');
		createdChatIds.push(inactiveChat.id);
		await expect(
			routeUserMessage(inactiveChat.id, 'hello', processManager, agentDetector)
		).rejects.toThrow('Moderator is not active');

		const unavailable = await createStartedChat('Unavailable Moderator');
		await expect(
			routeUserMessage(
				unavailable.groupChat.id,
				'hello',
				unavailable.processManager,
				createUnavailableAgentDetector()
			)
		).rejects.toThrow("Agent 'claude-code' is not available");

		const noDetector = await createStartedChat('No Detector Router');
		await expect(
			routeUserMessage(noDetector.groupChat.id, 'hello', noDetector.processManager)
		).rejects.toThrow('AgentDetector not available');
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('AgentDetector not available')
		);

		const noProcessManager = await createStartedChat('No Process Manager Router');
		await routeUserMessage(noProcessManager.groupChat.id, 'logged only', undefined, agentDetector);
		const messages = await readLog(noProcessManager.groupChat.logPath);
		expect(messages.some((message) => message.content === 'logged only')).toBe(true);
	});

	it('force-completes timed-out autorun participants and starts synthesis', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const { groupChat, processManager, agentDetector } = await createStartedChat('Timeout Router');
		await addParticipant(groupChat.id, 'Runner', 'claude-code', processManager);
		setGetSessionsCallback(() => [
			{
				id: 'runner-session',
				name: 'Runner',
				toolType: 'claude-code',
				cwd: os.tmpdir(),
				autoRunFolderPath: path.join(os.tmpdir(), 'autorun-docs'),
			},
		]);

		const emitMessage = vi.fn();
		const emitParticipantState = vi.fn();
		const emitAutoRunBatchComplete = vi.fn();
		const emitStateChange = vi.fn();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		groupChatEmitters.emitMessage = emitMessage;
		groupChatEmitters.emitParticipantState = emitParticipantState;
		groupChatEmitters.emitAutoRunBatchComplete = emitAutoRunBatchComplete;
		groupChatEmitters.emitStateChange = emitStateChange;

		vi.useFakeTimers();
		try {
			await routeModeratorResponse(
				groupChat.id,
				'Please run it.\n!autorun @Runner:plan.md',
				processManager,
				agentDetector
			);
			processManager.spawnedSessions.clear();

			await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
			vi.useRealTimers();
			for (let attempt = 0; attempt < 20; attempt++) {
				const completed = emitParticipantState.mock.calls.some(
					([chatId, participantName, state]) =>
						chatId === groupChat.id && participantName === 'Runner' && state === 'idle'
				);
				if (completed) break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(emitMessage).toHaveBeenCalledWith(
				groupChat.id,
				expect.objectContaining({
					from: 'system',
					content: expect.stringContaining('@Runner did not respond'),
				})
			);
			expect(emitParticipantState).toHaveBeenCalledWith(groupChat.id, 'Runner', 'idle');
			expect(emitAutoRunBatchComplete).toHaveBeenCalledWith(groupChat.id, 'Runner');
			expect(getPendingParticipants(groupChat.id).size).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	}, 60000);

	it('handles moderator response routing errors and idle fallbacks', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const processManager = createMockProcessManager();
		const agentDetector = createMockAgentDetector();
		const emitStateChange = vi.fn();
		const emitMessage = vi.fn();
		groupChatEmitters.emitStateChange = emitStateChange;
		groupChatEmitters.emitMessage = emitMessage;

		await expect(
			routeModeratorResponse(
				'missing-chat',
				'@Ghost please check this.',
				processManager,
				agentDetector
			)
		).rejects.toThrow('Group chat not found');
		await expect(
			routeAgentResponse('missing-chat', 'Ghost', 'hello', processManager)
		).rejects.toThrow('Group chat not found');

		const { groupChat, processManager: participantProcessManager } = await createStartedChat(
			'Unavailable Participant Router'
		);
		await addParticipant(groupChat.id, 'Down Agent', 'claude-code', participantProcessManager);
		participantProcessManager.spawnedSessions.clear();

		await routeModeratorResponse(
			groupChat.id,
			'@Down-Agent please inspect this.',
			participantProcessManager,
			createUnavailableAgentDetector()
		);

		expect(participantProcessManager.spawnedSessions.size).toBe(0);
		expect(emitStateChange).toHaveBeenCalledWith(groupChat.id, 'idle');

		await routeModeratorResponse(groupChat.id, '!autorun @Ghost', processManager, agentDetector);
		expect(emitMessage).toHaveBeenCalledWith(
			groupChat.id,
			expect.objectContaining({
				from: 'system',
				content: expect.stringContaining('none could be activated'),
			})
		);
	});

	it('cleans up synthesis and recovery prerequisites when routing cannot continue', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const processManager = createMockProcessManager();
		const agentDetector = createMockAgentDetector();
		const emitStateChange = vi.fn();
		groupChatEmitters.emitStateChange = emitStateChange;

		await spawnModeratorSynthesis('missing-chat', processManager, agentDetector);

		const inactiveChat = await createGroupChat('Inactive Synthesis Router', 'claude-code');
		createdChatIds.push(inactiveChat.id);
		await spawnModeratorSynthesis(inactiveChat.id, processManager, agentDetector);

		const unavailable = await createStartedChat('Unavailable Synthesis Router');
		unavailable.processManager.spawnedSessions.clear();
		await spawnModeratorSynthesis(
			unavailable.groupChat.id,
			unavailable.processManager,
			createUnavailableAgentDetector()
		);
		expect(unavailable.processManager.spawnedSessions.size).toBe(0);
		expect(emitStateChange).toHaveBeenCalledWith(unavailable.groupChat.id, 'idle');

		const recovery = await createStartedChat('Recovery Error Router');
		await addParticipant(
			recovery.groupChat.id,
			'Recoverable',
			'claude-code',
			recovery.processManager
		);
		await expect(
			respawnParticipantWithRecovery('missing-chat', 'Recoverable', processManager, agentDetector)
		).rejects.toThrow('Group chat not found');
		await expect(
			respawnParticipantWithRecovery(
				recovery.groupChat.id,
				'Ghost',
				recovery.processManager,
				agentDetector
			)
		).rejects.toThrow('Participant not found');
		await expect(
			respawnParticipantWithRecovery(
				recovery.groupChat.id,
				'Recoverable',
				recovery.processManager,
				createUnavailableAgentDetector()
			)
		).rejects.toThrow('Agent not available');
	});

	it('reports spawn failures without blocking later group-chat cleanup', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const agentDetector = createMockAgentDetector();
		const moderatorFailure = await createStartedChat('Moderator Spawn Failure');
		vi.spyOn(moderatorFailure.processManager, 'spawn').mockImplementation(() => {
			throw new Error('spawn failed');
		});
		await expect(
			routeUserMessage(
				moderatorFailure.groupChat.id,
				'trigger spawn failure',
				moderatorFailure.processManager,
				agentDetector
			)
		).rejects.toThrow('Failed to spawn moderator: spawn failed');

		const participantFailure = await createStartedChat('Participant Spawn Failure');
		await addParticipant(
			participantFailure.groupChat.id,
			'Fragile Agent',
			'claude-code',
			participantFailure.processManager
		);
		vi.spyOn(participantFailure.processManager, 'spawn').mockImplementation(() => {
			throw new Error('participant spawn failed');
		});
		await routeModeratorResponse(
			participantFailure.groupChat.id,
			'@Fragile-Agent please try this.',
			participantFailure.processManager,
			agentDetector
		);
		expect(getPendingParticipants(participantFailure.groupChat.id).size).toBe(0);

		const synthesisFailure = await createStartedChat('Synthesis Spawn Failure');
		vi.spyOn(synthesisFailure.processManager, 'spawn').mockImplementation(() => {
			throw new Error('synthesis spawn failed');
		});
		await spawnModeratorSynthesis(
			synthesisFailure.groupChat.id,
			synthesisFailure.processManager,
			agentDetector
		);
	});

	it('wraps moderator, participant, synthesis, and recovery spawns with SSH remotes', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const sshRemoteConfig = { enabled: true, remoteId: 'remote-1' };
		setSshStore(createSshRemoteStore() as never);

		const moderatorProcessManager = createMockProcessManager();
		const agentDetector = createMockAgentDetector();
		const moderatorChat = await createGroupChat('SSH Moderator Router', 'claude-code', {
			sshRemoteConfig,
			customEnvVars: { MODERATOR_ENV: 'yes' },
		});
		createdChatIds.push(moderatorChat.id);
		await spawnModerator(moderatorChat, moderatorProcessManager);
		await routeUserMessage(
			moderatorChat.id,
			'run the moderator remotely',
			moderatorProcessManager,
			agentDetector
		);
		const moderatorSpawn = Array.from(moderatorProcessManager.spawnedSessions.values())[0];
		expect(moderatorSpawn.command).toContain('ssh');
		expect(moderatorSpawn.customEnvVars).toBeUndefined();

		const participant = await createStartedChat('SSH Participant Router');
		await addParticipant(
			participant.groupChat.id,
			'Remote Runner',
			'claude-code',
			participant.processManager
		);
		setGetSessionsCallback(() => [
			{
				id: 'remote-runner-session',
				name: 'Remote Runner',
				toolType: 'claude-code',
				cwd: '/remote/project',
				sshRemoteConfig,
			},
		]);
		participant.processManager.spawnedSessions.clear();
		await routeModeratorResponse(
			participant.groupChat.id,
			'@Remote-Runner inspect the remote workspace.',
			participant.processManager,
			participant.agentDetector
		);
		const participantSpawn = Array.from(participant.processManager.spawnedSessions.values())[0];
		expect(participantSpawn.command).toContain('ssh');
		expect(participantSpawn.customEnvVars).toBeUndefined();

		const synthesisProcessManager = createMockProcessManager();
		const synthesisChat = await createGroupChat('SSH Synthesis Router', 'claude-code', {
			sshRemoteConfig,
		});
		createdChatIds.push(synthesisChat.id);
		await spawnModerator(synthesisChat, synthesisProcessManager);
		await addParticipant(synthesisChat.id, 'Writer', 'claude-code', synthesisProcessManager);
		await routeAgentResponse(synthesisChat.id, 'Writer', 'Remote draft complete.');
		synthesisProcessManager.spawnedSessions.clear();
		await spawnModeratorSynthesis(synthesisChat.id, synthesisProcessManager, agentDetector);
		const synthesisSpawn = Array.from(synthesisProcessManager.spawnedSessions.values())[0];
		expect(synthesisSpawn.command).toContain('ssh');

		const recovery = await createStartedChat('SSH Recovery Router');
		await addParticipant(
			recovery.groupChat.id,
			'Remote Recover',
			'claude-code',
			recovery.processManager
		);
		await routeAgentResponse(
			recovery.groupChat.id,
			'Remote Recover',
			'Prior remote response.',
			recovery.processManager
		);
		setGetSessionsCallback(() => [
			{
				id: 'remote-recover-session',
				name: 'Remote Recover',
				toolType: 'claude-code',
				cwd: '/remote/recover',
				sshRemoteConfig,
			},
		]);
		recovery.processManager.spawnedSessions.clear();
		await respawnParticipantWithRecovery(
			recovery.groupChat.id,
			'Remote Recover',
			recovery.processManager,
			recovery.agentDetector
		);
		const recoverySpawn = Array.from(recovery.processManager.spawnedSessions.values())[0];
		expect(recoverySpawn.command).toContain('ssh');
		expect(recoverySpawn.customEnvVars).toBeUndefined();
	});

	/**
	 * Test 6.1: Basic moderator response
	 *
	 * Verifies that a moderator can be spawned and responds to user messages.
	 */
	it('6.1 moderator responds to user message', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const agents = getTestAgents();
		const processManager = createMockProcessManager();
		const agentDetector = createMockAgentDetector();

		// Create group chat
		const groupChat = await createGroupChat('Test Chat', agents.moderator);
		createdChatIds.push(groupChat.id);

		// Spawn moderator
		await spawnModerator(groupChat, processManager);

		// Send user message
		await routeUserMessage(
			groupChat.id,
			'Hello, what can you help me with?',
			processManager,
			agentDetector
		);

		// Verify message was logged
		const messages = await readLog(groupChat.logPath);
		expect(messages.length).toBeGreaterThan(0);
		expect(messages.some((m) => m.from === 'user')).toBe(true);

		// Verify moderator batch process was spawned (routeUserMessage uses batch mode)
		expect(processManager.spawnedSessions.size).toBeGreaterThan(0);

		// Clean up
		await cleanupGroupChat(groupChat.id);
	}, 60000);

	/**
	 * Test 6.2: Addition task with two agents
	 *
	 * Core integration test: Two agents collaborate on an addition task.
	 * Flow:
	 * 1. User asks moderator to coordinate addition task
	 * 2. Moderator delegates to NumberPicker: "Pick a number 1-100"
	 * 3. NumberPicker responds with a number
	 * 4. Moderator delegates to Calculator: "Add 50 to that number"
	 * 5. Calculator responds with result
	 * 6. Moderator validates and reports final answer
	 */
	it('6.2 two agents collaborate on addition task', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const agents = getTestAgents();
		const processManager = createMockProcessManager();
		const agentDetector = createMockAgentDetector();

		// Create group chat
		const groupChat = await createGroupChat('Addition Test', agents.moderator);
		createdChatIds.push(groupChat.id);

		// Spawn moderator
		await spawnModerator(groupChat, processManager);

		// Add participants
		await addParticipant(groupChat.id, 'NumberPicker', agents.agentA, processManager);
		await addParticipant(groupChat.id, 'Calculator', agents.agentB, processManager);

		// Verify participants were added
		const updated = await loadGroupChat(groupChat.id);
		expect(updated?.participants).toHaveLength(2);
		expect(updated?.participants.map((p) => p.name)).toContain('NumberPicker');
		expect(updated?.participants.map((p) => p.name)).toContain('Calculator');

		// Send task
		await routeUserMessage(
			groupChat.id,
			`
        I need you to coordinate a simple task:
        1. Ask @NumberPicker to pick a random number between 1 and 100
        2. Once they respond, ask @Calculator to add 50 to that number
        3. Verify the calculation is correct and tell me the final result
      `,
			processManager,
			agentDetector
		);

		// Verify message was logged
		const messages = await readLog(groupChat.logPath);
		expect(messages.some((m) => m.from === 'user')).toBe(true);

		// Verify moderator received the message
		const moderatorSession = Array.from(processManager.spawnedSessions.keys()).find((k) =>
			k.includes('moderator')
		);
		expect(moderatorSession).toBeTruthy();

		// Clean up
		await cleanupGroupChat(groupChat.id);
	}, 120000);

	/**
	 * Test 6.3: Agents reference chat log for context
	 *
	 * Verifies that agents can reference the shared chat log.
	 */
	it('6.3 agents can reference chat log for context', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const agents = getTestAgents();
		const processManager = createMockProcessManager();
		const agentDetector = createMockAgentDetector();

		// Create group chat
		const groupChat = await createGroupChat('Context Test', agents.moderator);
		createdChatIds.push(groupChat.id);

		// Spawn moderator
		await spawnModerator(groupChat, processManager);

		// Add participants
		await addParticipant(groupChat.id, 'Writer', agents.agentA, processManager);
		await addParticipant(groupChat.id, 'Reviewer', agents.agentB, processManager);

		// Send user task so it is available in recent chat history.
		await routeUserMessage(
			groupChat.id,
			`
        1. Ask @Writer to write a one-sentence definition of "recursion"
        2. Ask @Reviewer to check @Writer's definition and suggest an improvement
      `,
			processManager,
			agentDetector
		);

		// Moderator handoff spawns one-shot participant task processes.
		await routeModeratorResponse(
			groupChat.id,
			'@Writer: write a one-sentence definition of "recursion".',
			processManager,
			agentDetector
		);

		const writerSession = Array.from(processManager.spawnedSessions.entries()).find(([k]) =>
			k.includes('participant-Writer')
		);
		expect(writerSession).toBeTruthy();
		expect(writerSession?.[1].prompt).toContain(path.dirname(groupChat.logPath));
		expect(writerSession?.[1].prompt).toContain('Recent Chat History');
		expect(writerSession?.[1].prompt).toContain('Ask @Writer to write');

		// Verify message logging
		const messages = await readLog(groupChat.logPath);
		expect(messages.some((m) => m.from === 'user')).toBe(true);

		// Clean up
		await cleanupGroupChat(groupChat.id);
	}, 120000);

	/**
	 * Test 6.4: Moderator handles non-existent participant
	 *
	 * Verifies that the moderator gracefully handles @mentions of participants
	 * that haven't been added to the chat.
	 */
	it('6.4 moderator handles @mention of non-participant', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const agents = getTestAgents();
		const processManager = createMockProcessManager();
		const agentDetector = createMockAgentDetector();

		// Create group chat
		const groupChat = await createGroupChat('Missing Agent Test', agents.moderator);
		createdChatIds.push(groupChat.id);

		// Spawn moderator but don't add any participants
		await spawnModerator(groupChat, processManager);

		// Send message referencing non-existent participant
		await routeUserMessage(
			groupChat.id,
			'Please ask @NonExistent to help me',
			processManager,
			agentDetector
		);

		// Verify message was logged
		const messages = await readLog(groupChat.logPath);
		expect(messages.some((m) => m.from === 'user')).toBe(true);

		// Verify no participant sessions were created
		const participantSessions = Array.from(processManager.spawnedSessions.keys()).filter((k) =>
			k.includes('participant')
		);
		expect(participantSessions).toHaveLength(0);

		// Clean up
		await cleanupGroupChat(groupChat.id);
	}, 60000);

	/**
	 * Test 6.5: Chat log persists across moderator restart
	 *
	 * Verifies that the chat log persists and can be resumed.
	 */
	it('6.5 chat log persists and can be resumed', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const agents = getTestAgents();
		const processManager = createMockProcessManager();
		const agentDetector = createMockAgentDetector();

		// Create group chat
		const groupChat = await createGroupChat('Persistence Test', agents.moderator);
		createdChatIds.push(groupChat.id);

		// Spawn moderator
		await spawnModerator(groupChat, processManager);

		// Send initial message
		await routeUserMessage(
			groupChat.id,
			'Remember the number 12345',
			processManager,
			agentDetector
		);

		// Verify initial message logged
		let messages = await readLog(groupChat.logPath);
		expect(messages.some((m) => m.content.includes('12345'))).toBe(true);

		// Kill moderator
		await killModerator(groupChat.id, processManager);

		// Reload and restart moderator
		const reloaded = await loadGroupChat(groupChat.id);
		expect(reloaded).toBeTruthy();

		// Verify log persisted
		messages = await readLog(reloaded!.logPath);
		expect(messages.some((m) => m.content.includes('12345'))).toBe(true);

		// Restart moderator
		const newProcessManager = createMockProcessManager();
		await spawnModerator(reloaded!, newProcessManager);

		// Send follow-up message
		await routeUserMessage(
			groupChat.id,
			'What number did I ask you to remember? Check the chat log.',
			newProcessManager,
			agentDetector
		);

		// Verify both messages are in log
		messages = await readLog(reloaded!.logPath);
		expect(messages.filter((m) => m.from === 'user')).toHaveLength(2);
		expect(messages.some((m) => m.content.includes('12345'))).toBe(true);

		// Clean up
		await cleanupGroupChat(groupChat.id);
	}, 90000);

	/**
	 * Test 6.6: Mixed agent types work together
	 *
	 * Verifies that different agent types can participate in the same chat.
	 */
	it('6.6 works with mixed agent types', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const agents = getTestAgents();

		// In a real test, we'd check available.length < 2
		// For mock tests, we always proceed
		const moderator = agents.moderator;
		const agentA = agents.agentA;
		const agentB = agents.agentB;

		const processManager = createMockProcessManager();
		const agentDetector = createMockAgentDetector();

		// Create group chat
		const groupChat = await createGroupChat('Mixed Agents', moderator);
		createdChatIds.push(groupChat.id);

		// Spawn moderator
		await spawnModerator(groupChat, processManager);

		// Add participants with potentially different agent types
		await addParticipant(groupChat.id, 'Agent1', agentA, processManager);
		await addParticipant(groupChat.id, 'Agent2', agentB, processManager);

		// Verify different agent types (or same if only one available)
		const loaded = await loadGroupChat(groupChat.id);
		expect(loaded?.participants).toHaveLength(2);

		// Send message into the chat log.
		await routeUserMessage(
			groupChat.id,
			'Ask @Agent1 to say "ping" and @Agent2 to respond with "pong"',
			processManager,
			agentDetector
		);

		// Moderator handoff spawns one-shot participant task processes.
		await routeModeratorResponse(
			groupChat.id,
			'@Agent1: say "ping". @Agent2: respond with "pong".',
			processManager,
			agentDetector
		);

		// Verify both participants have task sessions
		const agent1Session = Array.from(processManager.spawnedSessions.keys()).find((k) =>
			k.includes('participant-Agent1')
		);
		const agent2Session = Array.from(processManager.spawnedSessions.keys()).find((k) =>
			k.includes('participant-Agent2')
		);

		expect(agent1Session).toBeTruthy();
		expect(agent2Session).toBeTruthy();

		// Clean up
		await cleanupGroupChat(groupChat.id);
	}, 120000);

	it('routes valid autorun directives through renderer emitters and pending response tracking', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const { groupChat, processManager, agentDetector } = await createStartedChat('Autorun Router');
		await addParticipant(groupChat.id, 'Runner', 'claude-code', processManager);
		setGetSessionsCallback(() => [
			{
				id: 'runner-session',
				name: 'Runner',
				toolType: 'claude-code',
				cwd: os.tmpdir(),
				autoRunFolderPath: path.join(os.tmpdir(), 'autorun-docs'),
			},
		]);

		const emitAutoRunTriggered = vi.fn();
		const emitParticipantState = vi.fn();
		const emitStateChange = vi.fn();
		groupChatEmitters.emitAutoRunTriggered = emitAutoRunTriggered;
		groupChatEmitters.emitParticipantState = emitParticipantState;
		groupChatEmitters.emitStateChange = emitStateChange;

		await routeModeratorResponse(
			groupChat.id,
			'Please run the focused plan.\n!autorun @Runner:plan.md',
			processManager,
			agentDetector
		);

		expect(emitParticipantState).toHaveBeenCalledWith(groupChat.id, 'Runner', 'working');
		expect(emitStateChange).toHaveBeenCalledWith(groupChat.id, 'agent-working');
		expect(emitAutoRunTriggered).toHaveBeenCalledWith(groupChat.id, 'Runner', 'plan.md');
		expect(Array.from(getPendingParticipants(groupChat.id))).toEqual(['Runner']);

		const messages = await readLog(groupChat.logPath);
		expect(messages.some((m) => m.from === 'moderator' && m.content.includes('focused plan'))).toBe(
			true
		);
		expect(markParticipantResponded(groupChat.id, 'Runner')).toBe(true);
		expect(getPendingParticipants(groupChat.id).size).toBe(0);
	}, 60000);

	it('emits explicit autorun warnings for missing participants and missing folders', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const { groupChat, processManager, agentDetector } =
			await createStartedChat('Autorun Warnings');
		await addParticipant(groupChat.id, 'NoFolder', 'claude-code', processManager);
		setGetSessionsCallback(() => [
			{
				id: 'no-folder-session',
				name: 'NoFolder',
				toolType: 'claude-code',
				cwd: os.tmpdir(),
			},
		]);

		const emitMessage = vi.fn();
		const emitStateChange = vi.fn();
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		groupChatEmitters.emitMessage = emitMessage;
		groupChatEmitters.emitStateChange = emitStateChange;

		await routeModeratorResponse(
			groupChat.id,
			'!autorun @NoFolder\n!autorun @Ghost',
			processManager,
			agentDetector
		);

		const systemMessages = emitMessage.mock.calls.map(([, message]) => message.content);
		expect(
			systemMessages.some((content) => content.includes('No Auto Run folder configured'))
		).toBe(true);
		expect(
			systemMessages.some((content) => content.includes('Could not find participant @Ghost'))
		).toBe(true);
		expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('No autoRunFolderPath'));
		expect(consoleWarn).toHaveBeenCalledWith(
			expect.stringContaining('Autorun participant Ghost not found')
		);
		expect(emitStateChange).toHaveBeenCalledWith(groupChat.id, 'idle');
		expect(processManager.spawnedSessions.size).toBe(0);
	}, 60000);

	it('logs participant responses, updates participant stats, and emits history entries', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const { groupChat, processManager } = await createStartedChat('Agent Response Router');
		await addParticipant(groupChat.id, 'Reviewer', 'claude-code', processManager);

		const emitMessage = vi.fn();
		const emitParticipantsChanged = vi.fn();
		const emitHistoryEntry = vi.fn();
		groupChatEmitters.emitMessage = emitMessage;
		groupChatEmitters.emitParticipantsChanged = emitParticipantsChanged;
		groupChatEmitters.emitHistoryEntry = emitHistoryEntry;

		await routeAgentResponse(groupChat.id, 'Reviewer', 'Reviewed. Looks good.', processManager);

		const messages = await readLog(groupChat.logPath);
		expect(messages.some((m) => m.from === 'Reviewer' && m.content.includes('Looks good'))).toBe(
			true
		);
		const updated = await loadGroupChat(groupChat.id);
		const reviewer = updated?.participants.find((p) => p.name === 'Reviewer');
		expect(reviewer?.messageCount).toBe(1);
		expect(reviewer?.lastSummary).toBe('Reviewed.');
		expect(emitMessage).toHaveBeenCalledWith(
			groupChat.id,
			expect.objectContaining({ from: 'Reviewer', content: 'Reviewed. Looks good.' })
		);
		expect(emitParticipantsChanged).toHaveBeenCalled();
		expect(emitHistoryEntry).toHaveBeenCalledWith(
			groupChat.id,
			expect.objectContaining({ participantName: 'Reviewer', summary: 'Reviewed.' })
		);

		await expect(routeAgentResponse(groupChat.id, 'Ghost', 'No participant')).rejects.toThrow(
			"Participant 'Ghost' not found"
		);
	}, 60000);

	it('spawns moderator synthesis with recent participant context', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const { groupChat, processManager, agentDetector } =
			await createStartedChat('Synthesis Router');
		await addParticipant(groupChat.id, 'Writer', 'claude-code', processManager);
		await routeAgentResponse(
			groupChat.id,
			'Writer',
			'Drafted the proposed answer.',
			processManager
		);
		processManager.spawnedSessions.clear();

		setGetModeratorSettingsCallback(() => ({
			standingInstructions: 'Keep the answer concise.',
			conductorProfile: 'Senior reviewer',
		}));
		const emitStateChange = vi.fn();
		groupChatEmitters.emitStateChange = emitStateChange;

		await spawnModeratorSynthesis(groupChat.id, processManager, agentDetector);

		const synthesisSession = Array.from(processManager.spawnedSessions.entries()).find(([id]) =>
			id.includes('moderator')
		);
		expect(synthesisSession).toBeTruthy();
		expect(synthesisSession?.[1].readOnlyMode).toBe(true);
		expect(synthesisSession?.[1].prompt).toContain('Keep the answer concise.');
		expect(synthesisSession?.[1].prompt).toContain('Drafted the proposed answer.');
		expect(synthesisSession?.[1].prompt).toContain('@Writer');
		expect(emitStateChange).toHaveBeenCalledWith(groupChat.id, 'moderator-thinking');
	}, 60000);

	it('respawns a participant with recovery context and read-only state', async () => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping: integration tests disabled');
			return;
		}

		const { groupChat, processManager, agentDetector } = await createStartedChat('Recovery Router');
		await addParticipant(groupChat.id, 'Recover Me', 'claude-code', processManager);
		await routeAgentResponse(
			groupChat.id,
			'Recover Me',
			'Earlier answer from the lost session.',
			processManager
		);
		setGroupChatReadOnlyState(groupChat.id, true);
		setGetSessionsCallback(() => [
			{
				id: 'recover-session',
				name: 'Recover Me',
				toolType: 'claude-code',
				cwd: path.join(os.tmpdir(), 'recover-cwd'),
				customArgs: '--fast',
				customEnvVars: { SESSION_ENV: 'yes' },
			},
		]);

		const emitParticipantState = vi.fn();
		groupChatEmitters.emitParticipantState = emitParticipantState;
		processManager.spawnedSessions.clear();

		await respawnParticipantWithRecovery(groupChat.id, 'Recover Me', processManager, agentDetector);

		const recoverySession = Array.from(processManager.spawnedSessions.entries()).find(([id]) =>
			id.includes('recovery')
		);
		expect(recoverySession).toBeTruthy();
		expect(recoverySession?.[1].cwd).toBe(path.join(os.tmpdir(), 'recover-cwd'));
		expect(recoverySession?.[1].readOnlyMode).toBe(true);
		expect(recoverySession?.[1].prompt).toContain('Session Recovery Context');
		expect(recoverySession?.[1].prompt).toContain('Earlier answer from the lost session.');
		expect(emitParticipantState).toHaveBeenCalledWith(groupChat.id, 'Recover Me', 'working');
	}, 60000);
});
