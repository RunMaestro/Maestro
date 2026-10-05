/**
 * @file group-chat-storage.test.ts
 * @description Tests for the desktop's binding of the group chat store.
 *
 * The storage behavior itself (structure, participants, History, write
 * serialization) is tested in `src/shared/maestro-lib/groupchat/__tests__/storage.test.ts`
 * over a temp directory. What stays here is what only the shim decides: which
 * directory the chats live in (the custom sync path, else Electron's userData,
 * re-read on every call) and that it still exports every function the main
 * process imports.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let mockUserDataPath: string;
let mockCustomSyncPath: string | undefined;
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

vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			get(key: string) {
				return key === 'customSyncPath' ? mockCustomSyncPath : undefined;
			}
			set() {}
		},
	};
});

let mockUuidCounter = 0;
vi.mock('uuid', () => ({
	v4: vi.fn(() => `test-uuid-${++mockUuidCounter}`),
}));

import * as storage from '../../../main/group-chat/group-chat-storage';

describe('group-chat-storage (desktop binding)', () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'group-chat-storage-shim-'));
		mockUserDataPath = path.join(testDir, 'userData');
		mockCustomSyncPath = undefined;
		mockUuidCounter = 0;
	});

	afterEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it('roots chats under <userData>/group-chats when no custom sync path is set', async () => {
		const chat = await storage.createGroupChat('Test Chat', 'claude-code');

		const chatDir = path.join(mockUserDataPath, 'group-chats', chat.id);
		expect(storage.getGroupChatDir(chat.id)).toBe(chatDir);
		expect(chat.logPath).toBe(path.join(chatDir, 'chat.log'));
		expect(chat.imagesDir).toBe(path.join(chatDir, 'images'));
		await expect(fs.stat(path.join(chatDir, 'metadata.json'))).resolves.toBeDefined();
	});

	it('names new chats with the uuid generator the desktop uses', async () => {
		const chat = await storage.createGroupChat('Test Chat', 'claude-code');

		expect(chat.id).toBe('test-uuid-1');
	});

	it('roots chats under <customSyncPath>/group-chats when one is configured', async () => {
		mockCustomSyncPath = path.join(testDir, 'synced');

		const chat = await storage.createGroupChat('Synced Chat', 'claude-code');

		const chatDir = path.join(mockCustomSyncPath, 'group-chats', chat.id);
		expect(storage.getGroupChatDir(chat.id)).toBe(chatDir);
		await expect(fs.stat(path.join(chatDir, 'metadata.json'))).resolves.toBeDefined();
		await expect(fs.stat(path.join(mockUserDataPath, 'group-chats'))).rejects.toThrow();
	});

	it('re-reads the custom sync path on every call', async () => {
		const local = await storage.createGroupChat('Local', 'claude-code');
		mockCustomSyncPath = path.join(testDir, 'synced');
		const synced = await storage.createGroupChat('Synced', 'claude-code');

		expect((await storage.listGroupChats()).map((c) => c.id)).toEqual([synced.id]);
		mockCustomSyncPath = undefined;
		expect((await storage.listGroupChats()).map((c) => c.id)).toEqual([local.id]);
	});

	it('exports every storage function the main process imports', () => {
		for (const name of [
			'getGroupChatDir',
			'createGroupChat',
			'loadGroupChat',
			'listGroupChats',
			'deleteGroupChat',
			'updateGroupChat',
			'addParticipantToChat',
			'removeParticipantFromChat',
			'removeParticipantFromChatWithResult',
			'getParticipant',
			'updateParticipant',
			'addGroupChatHistoryEntry',
			'getGroupChatHistory',
			'deleteGroupChatHistoryEntry',
			'clearGroupChatHistory',
			'getGroupChatHistoryFilePath',
			'extractFirstSentence',
		] as const) {
			expect(typeof storage[name]).toBe('function');
		}
	});
});
