import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';

const testPaths = vi.hoisted(() => ({
	userData: `${process.env.TMPDIR || '/tmp'}/maestro-group-chat-storage-integration`,
}));

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => testPaths.userData),
	},
}));

import {
	addGroupChatHistoryEntry,
	addParticipantToChat,
	clearGroupChatHistory,
	createGroupChat,
	deleteGroupChat,
	deleteGroupChatHistoryEntry,
	extractFirstSentence,
	getGroupChatDir,
	getGroupChatHistory,
	getGroupChatHistoryFilePath,
	getGroupChatsDir,
	getParticipant,
	loadGroupChat,
	listGroupChats,
	removeParticipantFromChat,
	updateGroupChat,
	updateParticipant,
	type GroupChatParticipant,
} from '../../main/group-chat/group-chat-storage';

function participant(name: string, agentId = 'claude-code'): GroupChatParticipant {
	return {
		name,
		agentId,
		sessionId: `session-${name}`,
		addedAt: Date.now(),
		color: '#4f8cff',
	};
}

async function resetStorage() {
	await fs.rm(testPaths.userData, { recursive: true, force: true });
}

describe('group chat storage integration', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		await resetStorage();
	});

	afterEach(async () => {
		vi.useRealTimers();
		await resetStorage();
	});

	it('creates, loads, lists, and filters group chat metadata from the real filesystem', async () => {
		await expect(listGroupChats()).resolves.toEqual([]);
		await expect(createGroupChat('Bad Moderator', 'terminal')).rejects.toThrow(
			'does not support group chat moderation'
		);

		const chat = await createGroupChat(' <>:"/\\|?* ', 'claude-code', {
			customPrompt: 'moderate carefully',
		});
		expect(chat.name).toBe('Untitled Chat');
		expect(chat.moderatorConfig).toEqual({ customPrompt: 'moderate carefully' });
		expect(await fs.readFile(chat.logPath, 'utf-8')).toBe('');
		await expect(fs.stat(chat.imagesDir)).resolves.toMatchObject({
			isDirectory: expect.any(Function),
		});

		await fs.mkdir(path.join(getGroupChatsDir(), 'empty-chat'), { recursive: true });
		await fs.writeFile(
			path.join(getGroupChatsDir(), 'empty-chat', 'metadata.json'),
			'   ',
			'utf-8'
		);
		await fs.mkdir(path.join(getGroupChatsDir(), 'corrupt-chat'), { recursive: true });
		await fs.writeFile(
			path.join(getGroupChatsDir(), 'corrupt-chat', 'metadata.json'),
			'{not json',
			'utf-8'
		);
		await fs.writeFile(path.join(getGroupChatsDir(), 'not-a-chat.txt'), 'ignored', 'utf-8');

		await expect(loadGroupChat('missing-chat')).resolves.toBeNull();
		await expect(loadGroupChat('empty-chat')).resolves.toBeNull();
		await expect(loadGroupChat('corrupt-chat')).resolves.toBeNull();
		await expect(listGroupChats()).resolves.toEqual([expect.objectContaining({ id: chat.id })]);

		const loaded = await loadGroupChat(chat.id);
		expect(loaded).toMatchObject({
			id: chat.id,
			name: 'Untitled Chat',
			moderatorAgentId: 'claude-code',
		});
	});

	it('propagates non-ENOENT filesystem failures', async () => {
		await fs.mkdir(getGroupChatsDir(), { recursive: true });
		await fs.mkdir(path.join(getGroupChatsDir(), 'metadata-dir-chat', 'metadata.json'), {
			recursive: true,
		});
		await expect(loadGroupChat('metadata-dir-chat')).rejects.toThrow();

		await resetStorage();
		await fs.mkdir(testPaths.userData, { recursive: true });
		await fs.writeFile(getGroupChatsDir(), 'not a directory', 'utf-8');
		await expect(listGroupChats()).rejects.toThrow();

		await resetStorage();
		const chat = await createGroupChat('Failure History', 'claude-code');
		const historyPath = (await getGroupChatHistoryFilePath(chat.id))!;
		await fs.mkdir(historyPath, { recursive: true });
		await expect(getGroupChatHistory(chat.id)).rejects.toThrow();
		await expect(deleteGroupChatHistoryEntry(chat.id, 'missing')).rejects.toThrow();
		await expect(clearGroupChatHistory(chat.id)).rejects.toThrow();
	});

	it('serializes metadata updates, participants, duplicate joins, and deletion', async () => {
		const chat = await createGroupChat('Storage Room', 'claude-code');

		await expect(updateGroupChat('missing-chat', { name: 'Nope' })).rejects.toThrow(
			'Group chat not found'
		);
		const renamed = await updateGroupChat(chat.id, {
			name: 'Renamed Room',
			archived: true,
			moderatorSessionId: 'moderator-session',
		});
		expect(renamed).toMatchObject({
			name: 'Renamed Room',
			archived: true,
			moderatorSessionId: 'moderator-session',
		});

		await expect(addParticipantToChat('missing-chat', participant('Ada'))).rejects.toThrow(
			'Group chat not found'
		);
		const withAda = await addParticipantToChat(chat.id, participant('Ada'));
		expect(withAda.participants).toHaveLength(1);
		const duplicate = await addParticipantToChat(chat.id, participant('Ada'));
		expect(duplicate.participants).toHaveLength(1);
		await expect(getParticipant(chat.id, 'Ada')).resolves.toMatchObject({ name: 'Ada' });
		await expect(getParticipant('missing-chat', 'Ada')).resolves.toBeUndefined();

		await expect(updateParticipant('missing-chat', 'Ada', { messageCount: 1 })).rejects.toThrow(
			'Group chat not found'
		);
		await expect(updateParticipant(chat.id, 'Grace', { messageCount: 1 })).rejects.toThrow(
			"Participant 'Grace' not found"
		);
		const updated = await updateParticipant(chat.id, 'Ada', {
			messageCount: 3,
			tokenCount: 42,
			totalCost: 0.12,
			agentSessionId: 'agent-session',
		});
		expect(updated.participants[0]).toMatchObject({
			messageCount: 3,
			tokenCount: 42,
			totalCost: 0.12,
			agentSessionId: 'agent-session',
		});

		await expect(removeParticipantFromChat('missing-chat', 'Ada')).rejects.toThrow(
			'Group chat not found'
		);
		const removed = await removeParticipantFromChat(chat.id, 'Ada');
		expect(removed.participants).toEqual([]);

		await deleteGroupChat(chat.id);
		await expect(loadGroupChat(chat.id)).resolves.toBeNull();
	});

	it('stores, sorts, deletes, clears, and locates JSONL history files', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const chat = await createGroupChat('History Room', 'claude-code');
		const older = await addGroupChatHistoryEntry(chat.id, {
			groupChatId: chat.id,
			timestamp: 100,
			type: 'user-message',
			summary: 'Older',
			details: 'Older details',
		});
		const newer = await addGroupChatHistoryEntry(chat.id, {
			groupChatId: chat.id,
			timestamp: 200,
			type: 'moderator-response',
			summary: 'Newer',
			details: 'Newer details',
		});
		const historyPath = await getGroupChatHistoryFilePath(chat.id);
		expect(historyPath).toBe(path.join(getGroupChatDir(chat.id), 'history.jsonl'));
		await fs.appendFile(historyPath!, '\n{malformed json}\n', 'utf-8');

		const history = await getGroupChatHistory(chat.id);
		expect(history.map((entry) => entry.id)).toEqual([newer.id, older.id]);
		expect(warnSpy.mock.calls.flat().join('\n')).toContain('Skipping malformed line');

		await expect(deleteGroupChatHistoryEntry(chat.id, 'missing-entry')).resolves.toBe(false);
		await expect(deleteGroupChatHistoryEntry(chat.id, older.id)).resolves.toBe(true);
		const afterDelete = await getGroupChatHistory(chat.id);
		expect(afterDelete.map((entry) => entry.id)).toEqual([newer.id]);

		await clearGroupChatHistory(chat.id);
		await expect(getGroupChatHistory(chat.id)).resolves.toEqual([]);
		await expect(deleteGroupChatHistoryEntry('missing-chat', 'entry')).resolves.toBe(false);
		await expect(clearGroupChatHistory('missing-chat')).resolves.toBeUndefined();
		await expect(getGroupChatHistory('missing-chat')).resolves.toEqual([]);
		await expect(getGroupChatHistoryFilePath('missing-chat')).resolves.toBeNull();
	});

	it('extracts concise summaries from messages', () => {
		expect(extractFirstSentence('  Ada checked this. Next sentence.  ')).toBe('Ada checked this.');
		const long = 'word '.repeat(40);
		expect(extractFirstSentence(long)).toHaveLength(150);
		expect(extractFirstSentence('short fragment')).toBe('short fragment');
	});
});
