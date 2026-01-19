/**
 * @file group-chat-agent.test.ts
 * @description Unit tests for the Group Chat participant (agent) management.
 *
 * Tests cover:
 * - Adding participants (4.1, 4.2)
 * - Sending messages to participants (4.3, 4.4)
 * - Removing participants (4.5)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

// Mock Electron's app module before importing modules that use it
let mockUserDataPath: string;
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === 'userData') {
				return mockUserDataPath;
			}
			throw new Error(`Unknown path name: ${name}`);
		}),
	},
}));

// Mock electron-store to return no custom path (use userData)
vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			get() {
				return undefined;
			} // No custom sync path
			set() {}
		},
	};
});

import {
	addParticipant,
	sendToParticipant,
	removeParticipant,
	getParticipantSessionId,
	isParticipantActive,
	getActiveParticipants,
	clearAllParticipantSessionsGlobal,
	getParticipantSystemPrompt,
} from '../../../main/group-chat/group-chat-agent';
import {
	spawnModerator,
	clearAllModeratorSessions,
	type IProcessManager,
} from '../../../main/group-chat/group-chat-moderator';
import {
	createGroupChat,
	deleteGroupChat,
	loadGroupChat,
} from '../../../main/group-chat/group-chat-storage';
import { readLog } from '../../../main/group-chat/group-chat-log';

describe('group-chat-agent', () => {
	let mockProcessManager: IProcessManager;
	let createdChats: string[] = [];
	let testDir: string;

	beforeEach(async () => {
		// Create a unique temp directory for each test
		testDir = path.join(
			os.tmpdir(),
			`group-chat-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);
		await fs.mkdir(testDir, { recursive: true });

		// Set the mock userData path to our test directory
		mockUserDataPath = testDir;

		// Create a fresh mock for each test
		mockProcessManager = {
			spawn: vi.fn().mockReturnValue({ pid: 12345, success: true }),
			write: vi.fn().mockReturnValue(true),
			kill: vi.fn().mockReturnValue(true),
		};

		// Clear any leftover sessions from previous tests
		clearAllModeratorSessions();
		clearAllParticipantSessionsGlobal();
	});

	afterEach(async () => {
		// Clean up any created chats
		for (const id of createdChats) {
			try {
				await deleteGroupChat(id);
			} catch {
				// Ignore errors
			}
		}
		createdChats = [];

		// Clear sessions
		clearAllModeratorSessions();
		clearAllParticipantSessionsGlobal();

		// Clean up temp directory
		try {
			await fs.rm(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}

		// Clear mocks
		vi.clearAllMocks();
	});

	// Helper to track created chats for cleanup
	async function createTestChat(name: string, agentId: string = 'claude-code') {
		const chat = await createGroupChat(name, agentId);
		createdChats.push(chat.id);
		return chat;
	}

	// Helper to create chat with moderator spawned
	async function createTestChatWithModerator(name: string, agentId: string = 'claude-code') {
		const chat = await createTestChat(name, agentId);
		await spawnModerator(chat, mockProcessManager);
		return chat;
	}

	// ===========================================================================
	// Test 4.1: addParticipant creates session and updates chat
	// ===========================================================================
	describe('addParticipant', () => {
		it('adds participant with new session', async () => {
			const chat = await createTestChatWithModerator('Test');

			const participant = await addParticipant(
				chat.id,
				'Client',
				'claude-code',
				mockProcessManager
			);

			expect(participant.name).toBe('Client');
			expect(participant.agentId).toBe('claude-code');
			expect(participant.sessionId).toBeTruthy();
			expect(participant.sessionId).toContain('participant');
			expect(participant.sessionId).toContain('Client');

			const updated = await loadGroupChat(chat.id);
			expect(updated?.participants).toHaveLength(1);
			expect(updated?.participants[0].name).toBe('Client');
		});

		it('spawns participant session correctly', async () => {
			const chat = await createTestChatWithModerator('Spawn Test');

			await addParticipant(chat.id, 'Backend', 'claude-code', mockProcessManager);

			// spawn is called once for participant (moderator uses batch mode, not spawn)
			expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);

			// Check the participant spawn call
			expect(mockProcessManager.spawn).toHaveBeenLastCalledWith(
				expect.objectContaining({
					toolType: 'claude-code',
					readOnlyMode: false, // Participants can make changes
				})
			);
		});

		it('throws for non-existent chat', async () => {
			await expect(
				addParticipant('non-existent-id', 'Client', 'claude-code', mockProcessManager)
			).rejects.toThrow(/not found/i);
		});

		it('throws for duplicate participant name', async () => {
			const chat = await createTestChatWithModerator('Duplicate Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			await expect(
				addParticipant(chat.id, 'Client', 'opencode', mockProcessManager)
			).rejects.toThrow(/already exists/i);
		});

		it('throws when spawn fails', async () => {
			// Note: spawnModerator no longer calls spawn (uses batch mode),
			// so we only need to mock the participant spawn to fail
			const failingProcessManager: IProcessManager = {
				spawn: vi.fn().mockReturnValue({ pid: -1, success: false }), // Participant fails
				write: vi.fn(),
				kill: vi.fn(),
			};

			const chat = await createTestChat('Fail Test');
			await spawnModerator(chat, failingProcessManager);

			await expect(
				addParticipant(chat.id, 'Client', 'claude-code', failingProcessManager)
			).rejects.toThrow(/Failed to spawn participant/);
		});

		it('throws when moderator is not active', async () => {
			const chat = await createTestChat('No Moderator Test');
			// Don't spawn moderator

			await expect(
				addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager)
			).rejects.toThrow(/Moderator must be active/);
		});

		it('can add multiple participants', async () => {
			const chat = await createTestChatWithModerator('Multiple Test');

			await addParticipant(chat.id, 'Frontend', 'claude-code', mockProcessManager);
			await addParticipant(chat.id, 'Backend', 'opencode', mockProcessManager);
			await addParticipant(chat.id, 'DevOps', 'claude-code', mockProcessManager);

			const updated = await loadGroupChat(chat.id);
			expect(updated?.participants).toHaveLength(3);
			expect(updated?.participants.map((p) => p.name)).toEqual(['Frontend', 'Backend', 'DevOps']);
		});

		it('records addedAt timestamp', async () => {
			const chat = await createTestChatWithModerator('Timestamp Test');
			const beforeAdd = Date.now();

			const participant = await addParticipant(
				chat.id,
				'Client',
				'claude-code',
				mockProcessManager
			);

			const afterAdd = Date.now();
			expect(participant.addedAt).toBeGreaterThanOrEqual(beforeAdd);
			expect(participant.addedAt).toBeLessThanOrEqual(afterAdd);
		});
	});

	// ===========================================================================
	// Test 4.2: addParticipant sends introduction to agent
	// ===========================================================================
	describe('addParticipant - introduction', () => {
		it('sends introduction to new participant', async () => {
			const chat = await createTestChatWithModerator('Intro Test');

			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			// Check that spawn was called with a prompt containing the role
			expect(mockProcessManager.spawn).toHaveBeenLastCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('Your Role: Client'),
				})
			);
		});

		it('includes chat name in introduction', async () => {
			const chat = await createTestChatWithModerator('My Project Chat');

			await addParticipant(chat.id, 'Developer', 'claude-code', mockProcessManager);

			expect(mockProcessManager.spawn).toHaveBeenLastCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('My Project Chat'),
				})
			);
		});

		it('includes log path in introduction', async () => {
			const chat = await createTestChatWithModerator('Log Path Test');

			await addParticipant(chat.id, 'Analyst', 'claude-code', mockProcessManager);

			expect(mockProcessManager.spawn).toHaveBeenLastCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('chat.log'),
				})
			);
		});

		it('getParticipantSystemPrompt generates correct prompt', () => {
			const prompt = getParticipantSystemPrompt('Tester', 'QA Chat', '/path/to/chat.log');

			expect(prompt).toContain('Your Role: Tester');
			expect(prompt).toContain('QA Chat');
			expect(prompt).toContain('/path/to/chat.log');
			expect(prompt).toContain('moderator');
		});
	});

	// ===========================================================================
	// Test 4.3: sendToParticipant routes message correctly
	// ===========================================================================
	describe('sendToParticipant', () => {
		it('sends message to participant session', async () => {
			const chat = await createTestChatWithModerator('Send Test');
			const participant = await addParticipant(
				chat.id,
				'Client',
				'claude-code',
				mockProcessManager
			);

			await sendToParticipant(chat.id, 'Client', 'Please implement auth', mockProcessManager);

			expect(mockProcessManager.write).toHaveBeenCalledWith(
				participant.sessionId,
				expect.stringContaining('Please implement auth')
			);
		});

		it('appends newline to message', async () => {
			const chat = await createTestChatWithModerator('Newline Test');
			const participant = await addParticipant(
				chat.id,
				'Client',
				'claude-code',
				mockProcessManager
			);

			await sendToParticipant(chat.id, 'Client', 'Task message', mockProcessManager);

			expect(mockProcessManager.write).toHaveBeenCalledWith(
				participant.sessionId,
				'Task message\n'
			);
		});

		it('logs message to chat log', async () => {
			const chat = await createTestChatWithModerator('Log Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			await sendToParticipant(chat.id, 'Client', 'Logged message', mockProcessManager);

			const messages = await readLog(chat.logPath);
			expect(
				messages.some((m) => m.from === 'moderator->Client' && m.content === 'Logged message')
			).toBe(true);
		});
	});

	// ===========================================================================
	// Test 4.4: sendToParticipant throws for unknown participant
	// ===========================================================================
	describe('sendToParticipant - errors', () => {
		it('throws for unknown participant', async () => {
			const chat = await createTestChatWithModerator('Unknown Test');

			await expect(
				sendToParticipant(chat.id, 'Unknown', 'Hello', mockProcessManager)
			).rejects.toThrow(/not found/i);
		});

		it('throws for non-existent chat', async () => {
			await expect(
				sendToParticipant('non-existent-id', 'Client', 'Hello', mockProcessManager)
			).rejects.toThrow(/not found/i);
		});

		it('throws for inactive session', async () => {
			const chat = await createTestChatWithModerator('Inactive Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			// Clear sessions to simulate inactive state
			clearAllParticipantSessionsGlobal();

			await expect(
				sendToParticipant(chat.id, 'Client', 'Hello', mockProcessManager)
			).rejects.toThrow(/No active session/i);
		});
	});

	// ===========================================================================
	// Test 4.5: removeParticipant kills session and updates chat
	// ===========================================================================
	describe('removeParticipant', () => {
		it('removes participant and kills session', async () => {
			const chat = await createTestChatWithModerator('Remove Test');
			const participant = await addParticipant(
				chat.id,
				'Client',
				'claude-code',
				mockProcessManager
			);

			await removeParticipant(chat.id, 'Client', mockProcessManager);

			expect(mockProcessManager.kill).toHaveBeenCalledWith(participant.sessionId);

			const updated = await loadGroupChat(chat.id);
			expect(updated?.participants).toHaveLength(0);
		});

		it('removes from active sessions', async () => {
			const chat = await createTestChatWithModerator('Active Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			expect(isParticipantActive(chat.id, 'Client')).toBe(true);

			await removeParticipant(chat.id, 'Client', mockProcessManager);

			expect(isParticipantActive(chat.id, 'Client')).toBe(false);
		});

		it('throws for unknown participant', async () => {
			const chat = await createTestChatWithModerator('Unknown Remove Test');

			await expect(removeParticipant(chat.id, 'Unknown', mockProcessManager)).rejects.toThrow(
				/not found/i
			);
		});

		it('throws for non-existent chat', async () => {
			await expect(
				removeParticipant('non-existent-id', 'Client', mockProcessManager)
			).rejects.toThrow(/not found/i);
		});

		it('handles removal when process manager not provided', async () => {
			const chat = await createTestChatWithModerator('No PM Remove Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			// Remove without process manager - should still update storage
			await removeParticipant(chat.id, 'Client');

			const updated = await loadGroupChat(chat.id);
			expect(updated?.participants).toHaveLength(0);
		});
	});

	// ===========================================================================
	// Additional helper function tests
	// ===========================================================================
	describe('helper functions', () => {
		it('getParticipantSessionId returns correct ID', async () => {
			const chat = await createTestChatWithModerator('Get Session Test');
			const participant = await addParticipant(
				chat.id,
				'Client',
				'claude-code',
				mockProcessManager
			);

			expect(getParticipantSessionId(chat.id, 'Client')).toBe(participant.sessionId);
		});

		it('getParticipantSessionId returns undefined for unknown', () => {
			expect(getParticipantSessionId('unknown-chat', 'Client')).toBeUndefined();
		});

		it('isParticipantActive returns correct status', async () => {
			const chat = await createTestChatWithModerator('Active Status Test');

			expect(isParticipantActive(chat.id, 'Client')).toBe(false);

			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			expect(isParticipantActive(chat.id, 'Client')).toBe(true);
		});

		it('getActiveParticipants returns all active participants', async () => {
			const chat = await createTestChatWithModerator('Active List Test');

			await addParticipant(chat.id, 'Frontend', 'claude-code', mockProcessManager);
			await addParticipant(chat.id, 'Backend', 'claude-code', mockProcessManager);

			const active = getActiveParticipants(chat.id);
			expect(active).toContain('Frontend');
			expect(active).toContain('Backend');
			expect(active).toHaveLength(2);
		});

		it('getActiveParticipants returns empty for unknown chat', () => {
			expect(getActiveParticipants('unknown-chat')).toEqual([]);
		});

		it('clearAllParticipantSessionsGlobal clears all sessions', async () => {
			const chat1 = await createTestChatWithModerator('Global Clear 1');
			const chat2 = await createTestChatWithModerator('Global Clear 2');

			await addParticipant(chat1.id, 'Client1', 'claude-code', mockProcessManager);
			await addParticipant(chat2.id, 'Client2', 'claude-code', mockProcessManager);

			clearAllParticipantSessionsGlobal();

			expect(getActiveParticipants(chat1.id)).toEqual([]);
			expect(getActiveParticipants(chat2.id)).toEqual([]);
		});
	});

	// ===========================================================================
	// Edge cases
	// ===========================================================================
	describe('edge cases', () => {
		it('participants isolated between group chats', async () => {
			const chat1 = await createTestChatWithModerator('Chat 1');
			const chat2 = await createTestChatWithModerator('Chat 2');

			await addParticipant(chat1.id, 'Client', 'claude-code', mockProcessManager);
			await addParticipant(chat2.id, 'Client', 'opencode', mockProcessManager);

			// Same name but different chats - both should work
			expect(isParticipantActive(chat1.id, 'Client')).toBe(true);
			expect(isParticipantActive(chat2.id, 'Client')).toBe(true);

			const updated1 = await loadGroupChat(chat1.id);
			const updated2 = await loadGroupChat(chat2.id);

			expect(updated1?.participants[0].agentId).toBe('claude-code');
			expect(updated2?.participants[0].agentId).toBe('opencode');
		});

		it('works with different agent types', async () => {
			const chat = await createTestChatWithModerator('Multi Agent Test');

			await addParticipant(chat.id, 'Claude', 'claude-code', mockProcessManager);
			await addParticipant(chat.id, 'Open', 'opencode', mockProcessManager);

			const updated = await loadGroupChat(chat.id);
			expect(updated?.participants[0].agentId).toBe('claude-code');
			expect(updated?.participants[1].agentId).toBe('opencode');
		});
	});
});
