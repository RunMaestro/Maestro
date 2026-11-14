/**
 * @file group-chat-moderator.test.ts
 * @description Unit tests for the Group Chat moderator management.
 *
 * Tests cover:
 * - Spawning moderator session mapping (3.1)
 * - Sending introduction message (3.2)
 * - Sending messages to moderator and logging (3.3)
 * - Killing moderator session (3.4)
 * - Getting moderator session ID (3.5)
 *
 * Note: Read-only mode propagation is tested in group-chat-router.test.ts (5.6)
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

vi.mock('../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => {
		if (id === 'group-chat-workflow-stage') {
			const fs = require('fs');
			const path = require('path');
			return fs.readFileSync(
				path.resolve(__dirname, '../../../../src/prompts/group-chat-workflow-stage.md'),
				'utf8'
			);
		}
		const prompts: Record<string, string> = {
			'group-chat-moderator-system':
				'You are a Group Chat Moderator.\n\n{{CONDUCTOR_PROFILE}}\n\nCoordinate multiple AI agents using @mentions.',
			'group-chat-workflow-planning':
				'Plan multi-stage workflows and wait for user approval before dispatch.',
			'group-chat-moderator-synthesis':
				'Review the agents responses and synthesize a coherent answer.',
		};
		return prompts[id] ?? `mock prompt for ${id}`;
	}),
}));

import {
	spawnModerator,
	sendToModerator,
	killModerator,
	getModeratorSessionId,
	clearAllModeratorSessions,
	getModeratorSystemPrompt,
	getWorkflowPlanningPrompt,
	getWorkflowStagePrompt,
	type IProcessManager,
} from '../../../main/group-chat/group-chat-moderator';
import {
	createGroupChat,
	deleteGroupChat,
	loadGroupChat,
} from '../../../main/group-chat/group-chat-storage';
import { readLog } from '../../../main/group-chat/group-chat-log';
import { extractTextFromStreamJson } from '../../../main/group-chat/output-parser';
import { extractMentions } from '../../../shared/maestro-lib/groupchat/router';
import type { GroupChatParticipant } from '../../../shared/group-chat-types';

// Use real UUIDs for tests - we don't need predictable IDs since we track created chats
// The uuid mock in other test files doesn't affect us since we import the real uuid

describe('group-chat-moderator', () => {
	let mockProcessManager: IProcessManager;
	let createdChats: string[] = [];
	let testDir: string;

	beforeEach(async () => {
		// Create a unique temp directory for each test
		testDir = path.join(
			os.tmpdir(),
			`group-chat-moderator-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

	// ===========================================================================
	// Test 3.1: spawnModerator sets up session mapping (batch mode)
	// Note: spawnModerator no longer spawns a process directly - it sets up the
	// session ID mapping. Actual process spawning happens per-message in batch mode.
	// ===========================================================================
	describe('spawnModerator', () => {
		it('returns session ID prefix for batch mode', async () => {
			const chat = await createTestChat('Test', 'claude-code');
			const sessionId = await spawnModerator(chat, mockProcessManager);

			expect(sessionId).toBeTruthy();
			expect(sessionId).toContain('group-chat');
			expect(sessionId).toContain('moderator');

			// In batch mode, spawn is not called during spawnModerator
			// The process is spawned per-message in routeUserMessage
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		});

		it('stores session mapping for chat', async () => {
			const chat = await createTestChat('Agent Test', 'opencode');
			const sessionId = await spawnModerator(chat, mockProcessManager);

			// Session ID should be retrievable
			expect(getModeratorSessionId(chat.id)).toBe(sessionId);
		});

		it('succeeds even without process manager activity', async () => {
			// In batch mode, the process manager is not used during spawn
			const chat = await createTestChat('Batch Test', 'claude-code');
			const sessionId = await spawnModerator(chat, mockProcessManager);

			expect(sessionId).toBeTruthy();
			expect(sessionId).toContain(chat.id);
		});

		it('updates group chat with session ID', async () => {
			const chat = await createTestChat('Session Update Test', 'claude-code');
			const sessionId = await spawnModerator(chat, mockProcessManager);

			const updated = await loadGroupChat(chat.id);
			expect(updated?.moderatorSessionId).toBe(sessionId);
		});
	});

	// ===========================================================================
	// Test 3.2: System prompt for moderator
	// ===========================================================================
	describe('spawnModerator - system prompt', () => {
		it('session ID includes chat ID', async () => {
			const chat = await createTestChat('Intro Test', 'claude-code');
			const sessionId = await spawnModerator(chat, mockProcessManager);

			// Session ID should include the chat ID for tracking
			expect(sessionId).toContain(chat.id);
		});

		it('system prompt contains moderator instructions', () => {
			const systemPrompt = getModeratorSystemPrompt();
			expect(systemPrompt).toContain('Coordinate');
			expect(systemPrompt).toContain('@');
			expect(systemPrompt).toContain('agents');
		});

		it('workflow planning prompt contains the approval gate', () => {
			const planningPrompt = getWorkflowPlanningPrompt();
			expect(planningPrompt).toContain('multi-stage workflows');
			expect(planningPrompt).toContain('user approval');
		});

		it('workflow stage prompt contains the execution boundary', () => {
			const stagePrompt = getWorkflowStagePrompt();
			expect(stagePrompt).toContain('ONLY on the current stage');
			expect(stagePrompt).toContain('stage directive');
			expect(stagePrompt).toContain('Required Auto Run directive');
			expect(stagePrompt).toContain('nothing else');
		});
	});

	// ===========================================================================
	// Test 3.3: sendToModerator writes to session and logs
	// ===========================================================================
	describe('sendToModerator', () => {
		it('sends message to moderator and appends to log', async () => {
			const chat = await createTestChat('Send Test', 'claude-code');
			await spawnModerator(chat, mockProcessManager);

			await sendToModerator(chat.id, 'Hello moderator', mockProcessManager);

			// Check log was updated
			const messages = await readLog(chat.logPath);
			expect(messages.some((m) => m.from === 'user' && m.content === 'Hello moderator')).toBe(true);
		});

		it('writes to process manager session', async () => {
			const chat = await createTestChat('Write Test', 'claude-code');
			const sessionId = await spawnModerator(chat, mockProcessManager);

			await sendToModerator(chat.id, 'Test message', mockProcessManager);

			expect(mockProcessManager.write).toHaveBeenCalledWith(sessionId, 'Test message\n');
		});

		it('logs message even without process manager', async () => {
			const chat = await createTestChat('Log Only Test', 'claude-code');

			// Don't spawn moderator, but still send message (log only mode)
			await sendToModerator(chat.id, 'Log only message');

			const messages = await readLog(chat.logPath);
			expect(messages.some((m) => m.content === 'Log only message')).toBe(true);
		});

		it('throws for non-existent chat', async () => {
			await expect(sendToModerator('non-existent-id', 'Hello')).rejects.toThrow(/not found/i);
		});
	});

	// ===========================================================================
	// Test 3.4: killModerator terminates session
	// ===========================================================================
	describe('killModerator', () => {
		it('kills moderator session', async () => {
			const chat = await createTestChat('Kill Test', 'claude-code');
			const sessionId = await spawnModerator(chat, mockProcessManager);

			await killModerator(chat.id, mockProcessManager);

			expect(mockProcessManager.kill).toHaveBeenCalledWith(sessionId);
		});

		it('removes session from active sessions', async () => {
			const chat = await createTestChat('Remove Session Test', 'claude-code');
			await spawnModerator(chat, mockProcessManager);

			expect(getModeratorSessionId(chat.id)).toBeTruthy();

			await killModerator(chat.id, mockProcessManager);

			expect(getModeratorSessionId(chat.id)).toBeUndefined();
		});

		it('clears moderatorSessionId in storage', async () => {
			const chat = await createTestChat('Clear Storage Test', 'claude-code');
			await spawnModerator(chat, mockProcessManager);

			await killModerator(chat.id, mockProcessManager);

			const updated = await loadGroupChat(chat.id);
			expect(updated?.moderatorSessionId).toBe('');
		});

		it('handles non-existent session gracefully', async () => {
			// Should not throw
			await expect(killModerator('non-existent-id', mockProcessManager)).resolves.not.toThrow();
		});
	});

	// ===========================================================================
	// Test 3.5: getModeratorSessionId returns correct ID
	// ===========================================================================
	describe('getModeratorSessionId', () => {
		it('returns moderator session ID', async () => {
			const chat = await createTestChat('Get Session Test', 'claude-code');
			const sessionId = await spawnModerator(chat, mockProcessManager);

			expect(getModeratorSessionId(chat.id)).toBe(sessionId);
		});

		it('returns undefined for non-existent chat', () => {
			expect(getModeratorSessionId('non-existent-id')).toBeUndefined();
		});

		it('returns undefined after moderator is killed', async () => {
			const chat = await createTestChat('Killed Session Test', 'claude-code');
			await spawnModerator(chat, mockProcessManager);

			await killModerator(chat.id, mockProcessManager);

			expect(getModeratorSessionId(chat.id)).toBeUndefined();
		});
	});

	// ===========================================================================
	// Additional tests for edge cases
	// ===========================================================================
	describe('edge cases', () => {
		it('can spawn multiple moderators for different chats', async () => {
			const chat1 = await createTestChat('Chat 1', 'claude-code');
			const chat2 = await createTestChat('Chat 2', 'opencode');

			const sessionId1 = await spawnModerator(chat1, mockProcessManager);
			const sessionId2 = await spawnModerator(chat2, mockProcessManager);

			expect(sessionId1).not.toBe(sessionId2);
			expect(getModeratorSessionId(chat1.id)).toBe(sessionId1);
			expect(getModeratorSessionId(chat2.id)).toBe(sessionId2);
		});

		it('clearAllModeratorSessions removes all sessions', async () => {
			const chat1 = await createTestChat('Clear Test 1', 'claude-code');
			const chat2 = await createTestChat('Clear Test 2', 'claude-code');

			await spawnModerator(chat1, mockProcessManager);
			await spawnModerator(chat2, mockProcessManager);

			clearAllModeratorSessions();

			expect(getModeratorSessionId(chat1.id)).toBeUndefined();
			expect(getModeratorSessionId(chat2.id)).toBeUndefined();
		});
	});

	// Grok in a room. Grok's capability row keeps `supportsGroupChatModeration`
	// false until moderation is qualified, so a Grok moderator is refused at creation rather
	// than becoming another provider; the text cases are the parse the router runs on a Grok
	// participant's result (and on a Grok moderator's, once one is admitted).
	describe('Grok in a room', () => {
		const j = (o: unknown) => JSON.stringify(o);
		const end = j({ type: 'end', stopReason: 'end_turn', sessionId: 'grok-session-1' });
		const participants = ['Alice', 'Bob', 'Eve'].map((name) => ({
			name,
			agentId: 'grok',
			sessionId: `p-${name}`,
			addedAt: 0,
		})) as unknown as GroupChatParticipant[];
		const routed = (lines: string[]) =>
			extractMentions(extractTextFromStreamJson(lines.join('\n'), 'grok'), participants);

		it('refuses a Grok moderator while moderation is unqualified, with no chat and no spawn', async () => {
			await expect(createGroupChat('Grok Room', 'grok')).rejects.toThrow(
				'Invalid moderator agent ID: grok. Agent does not support group chat moderation.'
			);
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
			await expect(fs.readdir(path.join(testDir, 'group-chats'))).rejects.toThrow();
		});

		it('routes on the participants a Grok result names across split-word, multiline deltas, never a thought or tool', () => {
			expect(
				routed([
					j({ type: 'thought', data: 'maybe @Eve should wipe the repo' }),
					j({ type: 'text', data: '@Al' }),
					j({ type: 'text', data: 'ice draft it\n@B' }),
					j({ type: 'text', data: 'ob review it' }),
					j({ type: 'tool_call', toolCallId: 't', toolName: 'grep', rawInput: { q: '@Eve' } }),
					end,
				])
			).toEqual(['Alice', 'Bob']);
		});

		it('reads a Grok result with no mention as final and a failed Grok result as nothing to route', () => {
			expect(
				routed([j({ type: 'text', data: 'All done: ' }), j({ type: 'text', data: 'merged.' }), end])
			).toEqual([]);
			expect(
				extractTextFromStreamJson([j({ type: 'text', data: 'Final.' }), end].join('\n'), 'grok')
			).toBe('Final.');
			for (const failure of [
				j({ type: 'error', message: 'Grok is not signed in' }),
				j({ type: 'end', stopReason: 'cancelled' }),
			]) {
				expect(routed([j({ type: 'text', data: '@Alice continue' }), failure])).toEqual([]);
			}
		});

		it('in a room of Grok participants, forwards queued messages in order and stops writing once cancelled', async () => {
			const chat = await createTestChat('Grok Participants Room', 'claude-code');
			const prefix = await spawnModerator(chat, mockProcessManager);
			await sendToModerator(chat.id, 'first', mockProcessManager);
			await sendToModerator(chat.id, 'queued second', mockProcessManager);
			expect(vi.mocked(mockProcessManager.write).mock.calls).toEqual([
				[prefix, 'first\n'],
				[prefix, 'queued second\n'],
			]);

			await killModerator(chat.id, mockProcessManager);
			expect(mockProcessManager.kill).toHaveBeenCalledWith(prefix);
			expect(getModeratorSessionId(chat.id)).toBeUndefined();
			expect((await loadGroupChat(chat.id))?.moderatorSessionId).toBe('');

			await sendToModerator(chat.id, 'after cancel', mockProcessManager);
			expect(mockProcessManager.write).toHaveBeenCalledTimes(2);
			const log = await readLog(chat.logPath);
			expect(log.filter((m) => m.from === 'user').map((m) => m.content)).toEqual([
				'first',
				'queued second',
				'after cancel',
			]);
		});
	});
});
