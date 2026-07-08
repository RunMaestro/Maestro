import os from 'node:os';
import path from 'node:path';
import * as realFs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getPath: vi.fn(),
	existsSync: vi.fn(),
	readdirSync: vi.fn(),
	readFileSync: vi.fn(),
}));

vi.mock('electron', () => ({
	app: {
		getPath: mocks.getPath,
	},
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return {
		...actual,
		existsSync: mocks.existsSync,
		readdirSync: mocks.readdirSync,
		readFileSync: mocks.readFileSync,
	};
});

import { collectGroupChats } from '../../main/debug-package/collectors/group-chats';

function writeFile(filePath: string, content: string): void {
	realFs.mkdirSync(path.dirname(filePath), { recursive: true });
	realFs.writeFileSync(filePath, content);
}

describe('group chats collector integration', () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = realFs.mkdtempSync(path.join(os.tmpdir(), 'maestro-group-chats-collector-'));
		mocks.getPath.mockReturnValue(tempRoot);
		mocks.existsSync.mockImplementation((target: realFs.PathLike) => realFs.existsSync(target));
		mocks.readdirSync.mockImplementation((target: realFs.PathLike) =>
			realFs.readdirSync(target as string)
		);
		mocks.readFileSync.mockImplementation((target: realFs.PathOrFileDescriptor) =>
			realFs.readFileSync(target, 'utf-8')
		);
	});

	afterEach(() => {
		realFs.rmSync(tempRoot, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it('collects metadata and message counts without returning message content', async () => {
		const chatsPath = path.join(tempRoot, 'group-chats');
		writeFile(
			path.join(chatsPath, 'chat-a.json'),
			JSON.stringify({
				id: 'chat-a-id',
				moderator: { agentId: 'moderator-from-object' },
				participants: [{ agentId: 'agent-one' }, {}],
				createdAt: 10,
				updatedAt: 20,
			})
		);
		writeFile(
			path.join(chatsPath, 'chat-a.log.json'),
			'{"content":"secret"}\n\n{"content":"hidden"}\n'
		);
		writeFile(
			path.join(chatsPath, 'chat-b.json'),
			JSON.stringify({
				moderatorAgentId: 'moderator-direct',
				participants: 'not-an-array',
			})
		);
		writeFile(path.join(chatsPath, 'ignored.log.json'), '{"content":"ignored"}\n');
		writeFile(path.join(chatsPath, 'notes.txt'), 'ignored');
		writeFile(path.join(chatsPath, 'broken.json'), '{');

		const result = (await collectGroupChats()).sort((a, b) => a.id.localeCompare(b.id));

		expect(result).toEqual([
			{
				id: 'chat-a-id',
				moderatorAgentId: 'moderator-from-object',
				participantCount: 2,
				participants: [{ agentId: 'agent-one' }, { agentId: 'unknown' }],
				messageCount: 2,
				createdAt: 10,
				updatedAt: 20,
			},
			{
				id: 'chat-b',
				moderatorAgentId: 'moderator-direct',
				participantCount: 0,
				participants: [],
				messageCount: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		]);
		expect(JSON.stringify(result)).not.toContain('secret');
		expect(JSON.stringify(result)).not.toContain('hidden');
	});

	it('returns an empty list when the group chats directory is missing or unreadable', async () => {
		await expect(collectGroupChats()).resolves.toEqual([]);

		realFs.mkdirSync(path.join(tempRoot, 'group-chats'));
		mocks.readdirSync.mockImplementation(() => {
			throw new Error('directory unavailable');
		});

		await expect(collectGroupChats()).resolves.toEqual([]);
	});

	it('uses safe defaults when chat fields or log files are unavailable', async () => {
		const chatsPath = path.join(tempRoot, 'group-chats');
		writeFile(
			path.join(chatsPath, 'fallback.json'),
			JSON.stringify({ participants: [{ agentId: '' }] })
		);
		writeFile(path.join(chatsPath, 'fallback.log.json'), '{"content":"blocked"}\n');

		mocks.readFileSync.mockImplementation((target: realFs.PathOrFileDescriptor) => {
			if (String(target).endsWith('.log.json')) {
				throw new Error('log unavailable');
			}
			return realFs.readFileSync(target, 'utf-8');
		});

		await expect(collectGroupChats()).resolves.toEqual([
			{
				id: 'fallback',
				moderatorAgentId: 'unknown',
				participantCount: 1,
				participants: [{ agentId: 'unknown' }],
				messageCount: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		]);
	});
});
