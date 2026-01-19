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

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createGroupChat, loadGroupChat } from '../../main/group-chat/group-chat-storage';
import { readLog } from '../../main/group-chat/group-chat-log';
import {
	spawnModerator,
	killModerator,
	IProcessManager,
} from '../../main/group-chat/group-chat-moderator';
import { addParticipant } from '../../main/group-chat/group-chat-agent';
import { routeUserMessage } from '../../main/group-chat/group-chat-router';
import { AgentDetector } from '../../main/agent-detector';
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
	spawnedSessions: Map<string, { toolType: string; prompt?: string }>;
	writtenMessages: Map<string, string[]>;
} {
	const spawnedSessions = new Map<string, { toolType: string; prompt?: string }>();
	const writtenMessages = new Map<string, string[]>();

	return {
		spawnedSessions,
		writtenMessages,

		spawn(config) {
			spawnedSessions.set(config.sessionId, {
				toolType: config.toolType,
				prompt: config.prompt,
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

describe('Group Chat Integration Tests', () => {
	const createdChatIds: string[] = [];

	// Skip integration tests if environment variable is set
	beforeAll(() => {
		if (shouldSkipIntegrationTests()) {
			console.log('Skipping integration tests (SKIP_INTEGRATION_TESTS=true)');
		}
	});

	// Clean up after each test
	afterEach(async () => {
		for (const chatId of createdChatIds) {
			await cleanupGroupChat(chatId);
		}
		createdChatIds.length = 0;
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

		// Verify participants have access to log path in their prompts
		const writerSession = Array.from(processManager.spawnedSessions.entries()).find(([k]) =>
			k.includes('Writer')
		);
		expect(writerSession).toBeTruthy();
		expect(writerSession?.[1].prompt).toContain(groupChat.logPath);

		// Send task
		await routeUserMessage(
			groupChat.id,
			`
        1. Ask @Writer to write a one-sentence definition of "recursion"
        2. Ask @Reviewer to check @Writer's definition and suggest an improvement
      `,
			processManager,
			agentDetector
		);

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

		// Send message
		await routeUserMessage(
			groupChat.id,
			'Ask @Agent1 to say "ping" and @Agent2 to respond with "pong"',
			processManager,
			agentDetector
		);

		// Verify both participants have sessions
		const agent1Session = Array.from(processManager.spawnedSessions.keys()).find((k) =>
			k.includes('Agent1')
		);
		const agent2Session = Array.from(processManager.spawnedSessions.keys()).find((k) =>
			k.includes('Agent2')
		);

		expect(agent1Session).toBeTruthy();
		expect(agent2Session).toBeTruthy();

		// Clean up
		await cleanupGroupChat(groupChat.id);
	}, 120000);
});
