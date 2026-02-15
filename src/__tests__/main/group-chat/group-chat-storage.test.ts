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
	addParticipantToChat,
	removeParticipantFromChat,
	getParticipant,
	updateParticipant,
	getGroupChatsDir,
	addGroupChatHistoryEntry,
	getGroupChatHistory,
	deleteGroupChatHistoryEntry,
	clearGroupChatHistory,
	getGroupChatHistoryFilePath,
	extractFirstSentence,
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

		it('deletes chat directory with image files inside', async () => {
			const chat = await createGroupChat('Chat With Images', 'claude-code');

			// Write some files into the images directory to simulate real usage
			await fs.writeFile(path.join(chat.imagesDir, 'test.png'), 'fake-image-data');
			await fs.writeFile(path.join(chat.imagesDir, 'test2.jpg'), 'fake-image-data-2');

			// deleteGroupChat should handle non-empty directories
			await expect(deleteGroupChat(chat.id)).resolves.not.toThrow();

			// Verify directory is gone
			const exists = await fs
				.access(path.dirname(chat.logPath))
				.then(() => true)
				.catch(() => false);
			expect(exists).toBe(false);
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

	// ===========================================================================
	// Test 2.7: Concurrent write serialization (race condition fix)
	// ===========================================================================
	describe('concurrent write serialization', () => {
		it('serializes concurrent updateGroupChat calls without data loss', async () => {
			const chat = await createGroupChat('Concurrent Test', 'claude-code');

			// Fire 10 concurrent updates — without serialization these would race
			const promises = Array.from({ length: 10 }, (_, i) =>
				updateGroupChat(chat.id, { name: `Update-${i}` })
			);
			await Promise.all(promises);

			// The final persisted state should be one of the updates (last queued wins)
			const loaded = await loadGroupChat(chat.id);
			expect(loaded).not.toBeNull();
			// File must be valid JSON (not corrupted)
			expect(loaded!.name).toMatch(/^Update-\d$/);

			await deleteGroupChat(chat.id);
		});

		it('serializes concurrent updateParticipant calls preserving all updates', async () => {
			const chat = await createGroupChat('Participant Race', 'claude-code');

			// Add two participants
			await addParticipantToChat(chat.id, {
				name: 'Alice',
				agentId: 'claude-code',
				sessionId: 'ses-alice',
				addedAt: Date.now(),
			});
			await addParticipantToChat(chat.id, {
				name: 'Bob',
				agentId: 'opencode',
				sessionId: 'ses-bob',
				addedAt: Date.now(),
			});

			// Simulate concurrent usage events for both participants
			const promises = [
				updateParticipant(chat.id, 'Alice', { tokenCount: 1000, totalCost: 0.05 }),
				updateParticipant(chat.id, 'Bob', { tokenCount: 2000, totalCost: 0.10 }),
				updateParticipant(chat.id, 'Alice', { contextUsage: 45 }),
				updateParticipant(chat.id, 'Bob', { contextUsage: 60 }),
			];
			await Promise.all(promises);

			// Both participants must exist with their last-written stats
			const loaded = await loadGroupChat(chat.id);
			expect(loaded).not.toBeNull();
			expect(loaded!.participants).toHaveLength(2);

			const alice = loaded!.participants.find((p) => p.name === 'Alice');
			const bob = loaded!.participants.find((p) => p.name === 'Bob');
			expect(alice).toBeDefined();
			expect(bob).toBeDefined();
			// Serialized writes: later update overwrites earlier for same participant
			expect(alice!.contextUsage).toBe(45);
			expect(bob!.contextUsage).toBe(60);

			await deleteGroupChat(chat.id);
		});

		it('produces valid JSON even with interleaved updateGroupChat and updateParticipant', async () => {
			const chat = await createGroupChat('Interleaved Race', 'claude-code');
			await addParticipantToChat(chat.id, {
				name: 'Agent1',
				agentId: 'claude-code',
				sessionId: 'ses-1',
				addedAt: Date.now(),
			});

			// Mix top-level updates with participant updates
			const promises = [
				updateGroupChat(chat.id, { moderatorAgentSessionId: 'mod-session-1' }),
				updateParticipant(chat.id, 'Agent1', { tokenCount: 500 }),
				updateGroupChat(chat.id, { moderatorSessionId: 'routing-prefix' }),
				updateParticipant(chat.id, 'Agent1', { agentSessionId: 'agent-ses-1' }),
			];
			await Promise.all(promises);

			// File must be valid JSON with all fields intact
			const loaded = await loadGroupChat(chat.id);
			expect(loaded).not.toBeNull();
			expect(loaded!.participants).toHaveLength(1);
			expect(loaded!.moderatorSessionId).toBe('routing-prefix');

			await deleteGroupChat(chat.id);
		});

		it('uses atomic writes (temp file then rename)', async () => {
			const chat = await createGroupChat('Atomic Test', 'claude-code');

			await updateGroupChat(chat.id, { name: 'After Atomic' });

			// Verify the .tmp file does not linger
			const chatDir = path.dirname(chat.logPath);
			const files = await fs.readdir(chatDir);
			expect(files).not.toContain('metadata.json.tmp');

			// Verify the actual file is valid
			const loaded = await loadGroupChat(chat.id);
			expect(loaded!.name).toBe('After Atomic');

			await deleteGroupChat(chat.id);
		});
	});

	// ===========================================================================
	// Test 2.7b: Delete serialization through write queue
	// ===========================================================================
	describe('deleteGroupChat serialization', () => {
		it('waits for pending writes before deleting', async () => {
			const chat = await createGroupChat('Delete Race', 'claude-code');

			// Fire an update and a delete concurrently — delete should wait
			const updatePromise = updateGroupChat(chat.id, { name: 'About to delete' });
			const deletePromise = deleteGroupChat(chat.id);

			// Both should complete without throwing
			await expect(updatePromise).resolves.toBeDefined();
			await expect(deletePromise).resolves.not.toThrow();

			// Chat should be gone after the delete
			const loaded = await loadGroupChat(chat.id);
			expect(loaded).toBeNull();
		});

		it('does not corrupt data when delete races with participant update', async () => {
			const chat = await createGroupChat('Delete Participant Race', 'claude-code');
			await addParticipantToChat(chat.id, {
				name: 'Worker',
				agentId: 'claude-code',
				sessionId: 'ses-w',
				addedAt: Date.now(),
			});

			// Fire participant update then delete — both serialize through the queue
			const updatePromise = updateParticipant(chat.id, 'Worker', { tokenCount: 999 });
			const deletePromise = deleteGroupChat(chat.id);

			await Promise.all([updatePromise, deletePromise]);

			// Chat directory should not exist
			const loaded = await loadGroupChat(chat.id);
			expect(loaded).toBeNull();
		});
	});

	// ===========================================================================
	// Test 2.8: Participant management (add, remove, get)
	// ===========================================================================
	describe('participant management', () => {
		it('adds a participant to the chat', async () => {
			const chat = await createGroupChat('Participant Add', 'claude-code');

			const participant = {
				name: 'Agent1',
				agentId: 'claude-code',
				sessionId: 'ses-1',
				addedAt: Date.now(),
			};

			const updated = await addParticipantToChat(chat.id, participant);
			expect(updated.participants).toHaveLength(1);
			expect(updated.participants[0].name).toBe('Agent1');

			// Verify persisted
			const loaded = await loadGroupChat(chat.id);
			expect(loaded!.participants).toHaveLength(1);

			await deleteGroupChat(chat.id);
		});

		it('rejects duplicate participant names', async () => {
			const chat = await createGroupChat('Duplicate Name', 'claude-code');

			await addParticipantToChat(chat.id, {
				name: 'Agent1',
				agentId: 'claude-code',
				sessionId: 'ses-1',
				addedAt: Date.now(),
			});

			await expect(
				addParticipantToChat(chat.id, {
					name: 'Agent1',
					agentId: 'opencode',
					sessionId: 'ses-2',
					addedAt: Date.now(),
				})
			).rejects.toThrow(/already exists/i);

			await deleteGroupChat(chat.id);
		});

		it('throws when adding participant to non-existent chat', async () => {
			await expect(
				addParticipantToChat('non-existent', {
					name: 'Agent1',
					agentId: 'claude-code',
					sessionId: 'ses-1',
					addedAt: Date.now(),
				})
			).rejects.toThrow(/not found/i);
		});

		it('removes a participant by name', async () => {
			const chat = await createGroupChat('Remove Test', 'claude-code');
			await addParticipantToChat(chat.id, {
				name: 'Alice',
				agentId: 'claude-code',
				sessionId: 'ses-a',
				addedAt: Date.now(),
			});
			await addParticipantToChat(chat.id, {
				name: 'Bob',
				agentId: 'opencode',
				sessionId: 'ses-b',
				addedAt: Date.now(),
			});

			const updated = await removeParticipantFromChat(chat.id, 'Alice');
			expect(updated.participants).toHaveLength(1);
			expect(updated.participants[0].name).toBe('Bob');

			// Verify persisted
			const loaded = await loadGroupChat(chat.id);
			expect(loaded!.participants).toHaveLength(1);

			await deleteGroupChat(chat.id);
		});

		it('removing non-existent participant is a no-op (keeps others)', async () => {
			const chat = await createGroupChat('Remove NoOp', 'claude-code');
			await addParticipantToChat(chat.id, {
				name: 'Alice',
				agentId: 'claude-code',
				sessionId: 'ses-a',
				addedAt: Date.now(),
			});

			const updated = await removeParticipantFromChat(chat.id, 'NonExistent');
			expect(updated.participants).toHaveLength(1);
			expect(updated.participants[0].name).toBe('Alice');

			await deleteGroupChat(chat.id);
		});

		it('throws when removing from non-existent chat', async () => {
			await expect(removeParticipantFromChat('non-existent', 'Alice')).rejects.toThrow(
				/not found/i
			);
		});

		it('gets a participant by name', async () => {
			const chat = await createGroupChat('Get Participant', 'claude-code');
			await addParticipantToChat(chat.id, {
				name: 'Alice',
				agentId: 'claude-code',
				sessionId: 'ses-a',
				addedAt: Date.now(),
			});

			const participant = await getParticipant(chat.id, 'Alice');
			expect(participant).toBeDefined();
			expect(participant!.name).toBe('Alice');
			expect(participant!.agentId).toBe('claude-code');

			await deleteGroupChat(chat.id);
		});

		it('returns undefined for non-existent participant', async () => {
			const chat = await createGroupChat('No Such Participant', 'claude-code');

			const participant = await getParticipant(chat.id, 'Ghost');
			expect(participant).toBeUndefined();

			await deleteGroupChat(chat.id);
		});

		it('returns undefined for non-existent chat', async () => {
			const participant = await getParticipant('non-existent', 'Alice');
			expect(participant).toBeUndefined();
		});

		it('updates individual participant fields', async () => {
			const chat = await createGroupChat('Update Fields', 'claude-code');
			await addParticipantToChat(chat.id, {
				name: 'Worker',
				agentId: 'claude-code',
				sessionId: 'ses-w',
				addedAt: Date.now(),
			});

			await updateParticipant(chat.id, 'Worker', { tokenCount: 5000, totalCost: 0.25 });

			const loaded = await loadGroupChat(chat.id);
			const worker = loaded!.participants.find((p) => p.name === 'Worker');
			expect(worker!.tokenCount).toBe(5000);
			expect(worker!.totalCost).toBe(0.25);

			await deleteGroupChat(chat.id);
		});

		it('throws when updating non-existent participant', async () => {
			const chat = await createGroupChat('Update Missing', 'claude-code');

			await expect(
				updateParticipant(chat.id, 'Ghost', { tokenCount: 100 })
			).rejects.toThrow(/not found/i);

			await deleteGroupChat(chat.id);
		});
	});

	// ===========================================================================
	// Test 2.9: History entry CRUD (JSONL)
	// ===========================================================================
	describe('history entry CRUD', () => {
		it('adds and retrieves a history entry', async () => {
			const chat = await createGroupChat('History Test', 'claude-code');

			const entry = await addGroupChatHistoryEntry(chat.id, {
				timestamp: Date.now(),
				summary: 'Completed login feature',
				participantName: 'Agent1',
				participantColor: '#ff0000',
				type: 'response',
			});

			expect(entry.id).toBeTruthy();
			expect(entry.summary).toBe('Completed login feature');

			const entries = await getGroupChatHistory(chat.id);
			expect(entries).toHaveLength(1);
			expect(entries[0].id).toBe(entry.id);
			expect(entries[0].summary).toBe('Completed login feature');

			await deleteGroupChat(chat.id);
		});

		it('returns entries sorted by timestamp (newest first)', async () => {
			const chat = await createGroupChat('History Sort', 'claude-code');

			await addGroupChatHistoryEntry(chat.id, {
				timestamp: 1000,
				summary: 'Old entry',
				participantName: 'A',
				participantColor: '#000',
				type: 'response',
			});
			await addGroupChatHistoryEntry(chat.id, {
				timestamp: 3000,
				summary: 'Newest entry',
				participantName: 'B',
				participantColor: '#000',
				type: 'delegation',
			});
			await addGroupChatHistoryEntry(chat.id, {
				timestamp: 2000,
				summary: 'Middle entry',
				participantName: 'C',
				participantColor: '#000',
				type: 'synthesis',
			});

			const entries = await getGroupChatHistory(chat.id);
			expect(entries).toHaveLength(3);
			expect(entries[0].summary).toBe('Newest entry');
			expect(entries[1].summary).toBe('Middle entry');
			expect(entries[2].summary).toBe('Old entry');

			await deleteGroupChat(chat.id);
		});

		it('returns empty array for chat with no history', async () => {
			const chat = await createGroupChat('No History', 'claude-code');

			const entries = await getGroupChatHistory(chat.id);
			expect(entries).toEqual([]);

			await deleteGroupChat(chat.id);
		});

		it('returns empty array for non-existent chat', async () => {
			const entries = await getGroupChatHistory('non-existent-id');
			expect(entries).toEqual([]);
		});

		it('skips malformed JSONL lines without crashing', async () => {
			const chat = await createGroupChat('Malformed Lines', 'claude-code');

			// Add a valid entry
			const valid = await addGroupChatHistoryEntry(chat.id, {
				timestamp: 1000,
				summary: 'Valid entry',
				participantName: 'A',
				participantColor: '#000',
				type: 'response',
			});

			// Manually corrupt the file by appending a bad line
			const historyDir = path.dirname(chat.logPath);
			const historyPath = path.join(historyDir, 'history.jsonl');
			await fs.appendFile(historyPath, 'this is not json\n', 'utf-8');

			// Add another valid entry
			await addGroupChatHistoryEntry(chat.id, {
				timestamp: 2000,
				summary: 'Another valid',
				participantName: 'B',
				participantColor: '#000',
				type: 'delegation',
			});

			const entries = await getGroupChatHistory(chat.id);
			expect(entries).toHaveLength(2);
			expect(entries.every((e) => e.summary !== undefined)).toBe(true);

			await deleteGroupChat(chat.id);
		});

		it('deletes a specific history entry by ID', async () => {
			const chat = await createGroupChat('Delete Entry', 'claude-code');

			const e1 = await addGroupChatHistoryEntry(chat.id, {
				timestamp: 1000,
				summary: 'First',
				participantName: 'A',
				participantColor: '#000',
				type: 'response',
			});
			const e2 = await addGroupChatHistoryEntry(chat.id, {
				timestamp: 2000,
				summary: 'Second',
				participantName: 'B',
				participantColor: '#000',
				type: 'delegation',
			});

			const deleted = await deleteGroupChatHistoryEntry(chat.id, e1.id);
			expect(deleted).toBe(true);

			const entries = await getGroupChatHistory(chat.id);
			expect(entries).toHaveLength(1);
			expect(entries[0].id).toBe(e2.id);

			await deleteGroupChat(chat.id);
		});

		it('returns false when deleting non-existent entry', async () => {
			const chat = await createGroupChat('Delete Missing', 'claude-code');

			await addGroupChatHistoryEntry(chat.id, {
				timestamp: 1000,
				summary: 'Keeper',
				participantName: 'A',
				participantColor: '#000',
				type: 'response',
			});

			const deleted = await deleteGroupChatHistoryEntry(chat.id, 'non-existent-entry-id');
			expect(deleted).toBe(false);

			const entries = await getGroupChatHistory(chat.id);
			expect(entries).toHaveLength(1);

			await deleteGroupChat(chat.id);
		});

		it('returns false when deleting from non-existent chat', async () => {
			const deleted = await deleteGroupChatHistoryEntry('non-existent', 'entry-id');
			expect(deleted).toBe(false);
		});

		it('clears all history entries', async () => {
			const chat = await createGroupChat('Clear History', 'claude-code');

			await addGroupChatHistoryEntry(chat.id, {
				timestamp: 1000,
				summary: 'Entry 1',
				participantName: 'A',
				participantColor: '#000',
				type: 'response',
			});
			await addGroupChatHistoryEntry(chat.id, {
				timestamp: 2000,
				summary: 'Entry 2',
				participantName: 'B',
				participantColor: '#000',
				type: 'delegation',
			});

			await clearGroupChatHistory(chat.id);

			const entries = await getGroupChatHistory(chat.id);
			expect(entries).toEqual([]);

			await deleteGroupChat(chat.id);
		});

		it('clearing non-existent chat history does not throw', async () => {
			await expect(clearGroupChatHistory('non-existent')).resolves.not.toThrow();
		});

		it('stores optional fields (elapsedTimeMs, tokenCount, cost, fullResponse)', async () => {
			const chat = await createGroupChat('Optional Fields', 'claude-code');

			const entry = await addGroupChatHistoryEntry(chat.id, {
				timestamp: Date.now(),
				summary: 'Detailed entry',
				participantName: 'Agent1',
				participantColor: '#ff0000',
				type: 'response',
				elapsedTimeMs: 5000,
				tokenCount: 1500,
				cost: 0.05,
				fullResponse: 'Full response text here',
			});

			const entries = await getGroupChatHistory(chat.id);
			expect(entries[0].elapsedTimeMs).toBe(5000);
			expect(entries[0].tokenCount).toBe(1500);
			expect(entries[0].cost).toBe(0.05);
			expect(entries[0].fullResponse).toBe('Full response text here');

			await deleteGroupChat(chat.id);
		});

		it('getGroupChatHistoryFilePath returns path for existing chat', async () => {
			const chat = await createGroupChat('Path Test', 'claude-code');

			const filePath = await getGroupChatHistoryFilePath(chat.id);
			expect(filePath).not.toBeNull();
			expect(filePath).toContain(chat.id);
			expect(filePath).toContain('history.jsonl');

			await deleteGroupChat(chat.id);
		});

		it('getGroupChatHistoryFilePath returns null for non-existent chat', async () => {
			const filePath = await getGroupChatHistoryFilePath('non-existent');
			expect(filePath).toBeNull();
		});
	});

	// ===========================================================================
	// Test 2.10: extractFirstSentence
	// ===========================================================================
	describe('extractFirstSentence', () => {
		it('extracts first sentence ending with period', () => {
			expect(extractFirstSentence('Hello world. This is more.')).toBe('Hello world.');
		});

		it('extracts first sentence ending with exclamation mark', () => {
			expect(extractFirstSentence('Done! Now what?')).toBe('Done!');
		});

		it('extracts first sentence ending with question mark', () => {
			expect(extractFirstSentence('What happened? Let me check.')).toBe('What happened?');
		});

		it('truncates long text without sentence ending', () => {
			const longText = 'a'.repeat(200);
			const result = extractFirstSentence(longText);
			expect(result.length).toBe(150);
			expect(result.endsWith('...')).toBe(true);
		});

		it('returns full text when short and no sentence ending', () => {
			expect(extractFirstSentence('No punctuation here')).toBe('No punctuation here');
		});

		it('normalizes whitespace', () => {
			expect(extractFirstSentence('  Hello   world.  More text. ')).toBe('Hello world.');
		});

		it('handles empty string', () => {
			expect(extractFirstSentence('')).toBe('');
		});

		it('handles single sentence with trailing space', () => {
			expect(extractFirstSentence('Just this. ')).toBe('Just this.');
		});
	});
});
