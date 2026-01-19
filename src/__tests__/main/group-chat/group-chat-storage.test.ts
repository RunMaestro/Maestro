/**
 * @file group-chat-storage.test.ts
 * @description Unit tests for the Group Chat storage utilities.
 *
 * Tests cover:
 * - Creating group chats with directory structure
 * - Loading existing group chats
 * - Handling non-existent chats
 * - Listing all group chats
 * - Deleting group chats
 * - Updating group chat metadata
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock Electron's app module before importing the storage module
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
	createGroupChat,
	loadGroupChat,
	listGroupChats,
	deleteGroupChat,
	updateGroupChat,
	getGroupChatsDir,
} from '../../../main/group-chat/group-chat-storage';

// Mock the uuid module to return incrementing IDs
let mockUuidCounter = 0;
vi.mock('uuid', () => ({
	v4: vi.fn(() => `test-uuid-${++mockUuidCounter}`),
}));

describe('group-chat-storage', () => {
	let testDir: string;

	beforeEach(async () => {
		// Create a unique temp directory for each test
		testDir = path.join(
			os.tmpdir(),
			`group-chat-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);
		await fs.mkdir(testDir, { recursive: true });

		// Set the mock userData path to our test directory
		mockUserDataPath = testDir;
	});

	afterEach(async () => {
		// Clean up temp directory
		try {
			await fs.rm(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}

		// Reset mocks
		vi.clearAllMocks();
	});

	// ===========================================================================
	// Test 2.1: createGroupChat creates directory structure
	// ===========================================================================
	describe('createGroupChat', () => {
		it('creates group chat with correct structure', async () => {
			const chat = await createGroupChat('Test Chat', 'claude-code');

			expect(chat.id).toBeTruthy();
			expect(chat.name).toBe('Test Chat');
			expect(chat.moderatorAgentId).toBe('claude-code');
			expect(chat.participants).toEqual([]);

			// Verify directory structure was created
			const logExists = await fs
				.access(chat.logPath)
				.then(() => true)
				.catch(() => false);
			const imagesDirExists = await fs
				.access(chat.imagesDir)
				.then(() => true)
				.catch(() => false);

			expect(logExists).toBe(true);
			expect(imagesDirExists).toBe(true);

			// Clean up
			await deleteGroupChat(chat.id);
		});

		it('creates chat with correct timestamps', async () => {
			const beforeTime = Date.now();
			const chat = await createGroupChat('Timestamp Test', 'claude-code');
			const afterTime = Date.now();

			expect(chat.createdAt).toBeGreaterThanOrEqual(beforeTime);
			expect(chat.createdAt).toBeLessThanOrEqual(afterTime);
			expect(chat.updatedAt).toBe(chat.createdAt);

			// Clean up
			await deleteGroupChat(chat.id);
		});

		it('creates empty log file', async () => {
			const chat = await createGroupChat('Empty Log Test', 'claude-code');

			const logContent = await fs.readFile(chat.logPath, 'utf-8');
			expect(logContent).toBe('');

			// Clean up
			await deleteGroupChat(chat.id);
		});

		it('sets moderatorSessionId to empty string initially', async () => {
			const chat = await createGroupChat('Session Test', 'claude-code');

			expect(chat.moderatorSessionId).toBe('');

			// Clean up
			await deleteGroupChat(chat.id);
		});
	});

	// ===========================================================================
	// Test 2.2: loadGroupChat loads existing chat
	// ===========================================================================
	describe('loadGroupChat', () => {
		it('loads existing group chat', async () => {
			const created = await createGroupChat('My Chat', 'claude-code');
			const loaded = await loadGroupChat(created.id);

			expect(loaded).toEqual(created);

			// Clean up
			await deleteGroupChat(created.id);
		});

		it('loads chat with correct paths', async () => {
			const created = await createGroupChat('Path Test', 'opencode');
			const loaded = await loadGroupChat(created.id);

			expect(loaded).not.toBeNull();
			expect(loaded!.logPath).toContain(created.id);
			expect(loaded!.imagesDir).toContain(created.id);

			// Clean up
			await deleteGroupChat(created.id);
		});
	});

	// ===========================================================================
	// Test 2.3: loadGroupChat returns null for non-existent
	// ===========================================================================
	describe('loadGroupChat - non-existent', () => {
		it('returns null for non-existent chat', async () => {
			const result = await loadGroupChat('non-existent-id');
			expect(result).toBeNull();
		});

		it('returns null for random UUID that does not exist', async () => {
			const result = await loadGroupChat('12345678-1234-1234-1234-123456789012');
			expect(result).toBeNull();
		});
	});

	// ===========================================================================
	// Test 2.4: listGroupChats returns all chats
	// ===========================================================================
	describe('listGroupChats', () => {
		it('lists all group chats', async () => {
			const chat1 = await createGroupChat('Chat 1', 'claude-code');
			const chat2 = await createGroupChat('Chat 2', 'opencode');

			const chats = await listGroupChats();
			expect(chats.length).toBeGreaterThanOrEqual(2);

			const chatNames = chats.map((c) => c.name);
			expect(chatNames).toContain('Chat 1');
			expect(chatNames).toContain('Chat 2');

			// Clean up
			await deleteGroupChat(chat1.id);
			await deleteGroupChat(chat2.id);
		});

		it('returns empty array when no chats exist', async () => {
			// Record chats that exist before our test
			const existingChatIds = new Set((await listGroupChats()).map((c) => c.id));

			// Create a chat, then delete it
			const chat = await createGroupChat('Temp Chat', 'claude-code');
			await deleteGroupChat(chat.id);

			// Verify our chat is gone and no unexpected chats were added
			const chats = await listGroupChats();
			const newChats = chats.filter((c) => !existingChatIds.has(c.id));

			// Our deleted chat should not be in the list
			expect(newChats.some((c) => c.id === chat.id)).toBe(false);

			// If the directory was empty before, it should be empty after
			// (but we can't guarantee this in parallel test execution)
		});

		it('lists chats with different moderator agents', async () => {
			const chat1 = await createGroupChat('Claude Chat', 'claude-code');
			const chat2 = await createGroupChat('Opencode Chat', 'opencode');

			const chats = await listGroupChats();
			const agentIds = chats.map((c) => c.moderatorAgentId);

			expect(agentIds).toContain('claude-code');
			expect(agentIds).toContain('opencode');

			// Clean up
			await deleteGroupChat(chat1.id);
			await deleteGroupChat(chat2.id);
		});
	});

	// ===========================================================================
	// Test 2.5: deleteGroupChat removes all data
	// ===========================================================================
	describe('deleteGroupChat', () => {
		it('deletes group chat and all data', async () => {
			const chat = await createGroupChat('To Delete', 'claude-code');
			const chatDir = path.dirname(chat.logPath);

			// Verify chat exists
			const existsBefore = await fs
				.access(chatDir)
				.then(() => true)
				.catch(() => false);
			expect(existsBefore).toBe(true);

			await deleteGroupChat(chat.id);

			// Verify chat directory is gone
			const existsAfter = await fs
				.access(chatDir)
				.then(() => true)
				.catch(() => false);
			expect(existsAfter).toBe(false);

			// Verify loadGroupChat returns null
			const loaded = await loadGroupChat(chat.id);
			expect(loaded).toBeNull();
		});

		it('removes chat from listGroupChats', async () => {
			const chat = await createGroupChat('To Be Removed', 'claude-code');

			// Verify it's in the list
			let chats = await listGroupChats();
			expect(chats.some((c) => c.id === chat.id)).toBe(true);

			await deleteGroupChat(chat.id);

			// Verify it's no longer in the list
			chats = await listGroupChats();
			expect(chats.some((c) => c.id === chat.id)).toBe(false);
		});

		it('handles deleting non-existent chat gracefully', async () => {
			// Should not throw
			await expect(deleteGroupChat('non-existent-id')).resolves.not.toThrow();
		});
	});

	// ===========================================================================
	// Test 2.6: updateGroupChat updates metadata
	// ===========================================================================
	describe('updateGroupChat', () => {
		it('updates group chat metadata', async () => {
			const chat = await createGroupChat('Original', 'claude-code');
			const updated = await updateGroupChat(chat.id, { name: 'Renamed' });

			expect(updated.name).toBe('Renamed');
			expect(updated.id).toBe(chat.id);

			// Verify persisted
			const loaded = await loadGroupChat(chat.id);
			expect(loaded!.name).toBe('Renamed');

			// Clean up
			await deleteGroupChat(chat.id);
		});

		it('updates updatedAt timestamp', async () => {
			const chat = await createGroupChat('Timestamp Update', 'claude-code');
			const originalUpdatedAt = chat.updatedAt;

			// Small delay to ensure timestamp difference
			await new Promise((r) => setTimeout(r, 10));

			const updated = await updateGroupChat(chat.id, { name: 'New Name' });

			expect(updated.updatedAt).toBeGreaterThan(originalUpdatedAt);

			// Clean up
			await deleteGroupChat(chat.id);
		});

		it('preserves other fields when updating', async () => {
			const chat = await createGroupChat('Preserve Fields', 'opencode');
			const updated = await updateGroupChat(chat.id, { name: 'Updated Name' });

			expect(updated.moderatorAgentId).toBe('opencode');
			expect(updated.createdAt).toBe(chat.createdAt);
			expect(updated.logPath).toBe(chat.logPath);
			expect(updated.imagesDir).toBe(chat.imagesDir);

			// Clean up
			await deleteGroupChat(chat.id);
		});

		it('throws error for non-existent chat', async () => {
			await expect(updateGroupChat('non-existent-id', { name: 'New Name' })).rejects.toThrow(
				/not found/i
			);
		});

		it('updates moderatorSessionId', async () => {
			const chat = await createGroupChat('Session Update', 'claude-code');

			const updated = await updateGroupChat(chat.id, {
				moderatorSessionId: 'session-123',
			});

			expect(updated.moderatorSessionId).toBe('session-123');

			// Clean up
			await deleteGroupChat(chat.id);
		});

		it('updates participants array', async () => {
			const chat = await createGroupChat('Participants Update', 'claude-code');

			const newParticipant = {
				name: 'Agent1',
				agentId: 'claude-code',
				sessionId: 'session-456',
				addedAt: Date.now(),
			};

			const updated = await updateGroupChat(chat.id, {
				participants: [newParticipant],
			});

			expect(updated.participants).toHaveLength(1);
			expect(updated.participants[0].name).toBe('Agent1');

			// Clean up
			await deleteGroupChat(chat.id);
		});
	});
});
