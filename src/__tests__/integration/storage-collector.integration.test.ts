import os from 'node:os';
import path from 'node:path';
import * as realFs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Store from 'electron-store';

const mocks = vi.hoisted(() => ({
	getPath: vi.fn(),
	existsSync: vi.fn(),
	statSync: vi.fn(),
	readdirSync: vi.fn(),
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
		statSync: mocks.statSync,
		readdirSync: mocks.readdirSync,
	};
});

import { collectStorage } from '../../main/debug-package/collectors/storage';

function bootstrapStore(customSyncPath: unknown): Store<any> {
	return {
		get: (key: string) => (key === 'customSyncPath' ? customSyncPath : undefined),
	} as Store<any>;
}

function writeFile(filePath: string, content: string): void {
	realFs.mkdirSync(path.dirname(filePath), { recursive: true });
	realFs.writeFileSync(filePath, content);
}

describe('storage collector integration', () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = realFs.mkdtempSync(path.join(os.tmpdir(), 'maestro-storage-collector-'));
		mocks.getPath.mockReturnValue(tempRoot);
		mocks.existsSync.mockImplementation((target: realFs.PathLike) => realFs.existsSync(target));
		mocks.statSync.mockImplementation((target: realFs.PathLike) => realFs.statSync(target));
		mocks.readdirSync.mockImplementation((target: realFs.PathLike) =>
			realFs.readdirSync(target as string)
		);
	});

	afterEach(() => {
		realFs.rmSync(tempRoot, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it('collects sanitized default storage paths and recursive sizes', async () => {
		writeFile(path.join(tempRoot, 'maestro-sessions.json'), 'sessions');
		writeFile(path.join(tempRoot, 'history', 'one.jsonl'), 'history-one');
		writeFile(path.join(tempRoot, 'history', 'nested', 'two.jsonl'), 'history-two');
		writeFile(path.join(tempRoot, 'group-chats', 'group.jsonl'), 'group-chat');

		const result = await collectStorage();

		expect(result.paths).toEqual({
			userData: tempRoot.replace(os.homedir(), '~'),
			sessions: tempRoot.replace(os.homedir(), '~'),
			history: path.join(tempRoot, 'history').replace(os.homedir(), '~'),
			logs: tempRoot.replace(os.homedir(), '~'),
			groupChats: path.join(tempRoot, 'group-chats').replace(os.homedir(), '~'),
			customSyncPath: undefined,
		});
		expect(result.sizes).toEqual({
			sessionsBytes: 'sessions'.length,
			historyBytes: 'history-one'.length + 'history-two'.length,
			logsBytes: 0,
			groupChatsBytes: 'group-chat'.length,
			totalBytes:
				'sessions'.length + 'history-one'.length + 'history-two'.length + 'group-chat'.length,
		});
	});

	it('uses custom sync storage for sessions while keeping user-data history paths', async () => {
		const customSyncPath = path.join(tempRoot, 'custom-sync');
		writeFile(path.join(customSyncPath, 'maestro-sessions.json'), 'custom-sessions');
		writeFile(path.join(tempRoot, 'history', 'history.jsonl'), 'history');

		const result = await collectStorage(bootstrapStore(customSyncPath));

		expect(result.paths.sessions).toBe(customSyncPath.replace(os.homedir(), '~'));
		expect(result.paths.customSyncPath).toBe('[SET]');
		expect(result.sizes.sessionsBytes).toBe('custom-sessions'.length);
		expect(result.sizes.historyBytes).toBe('history'.length);
		expect(result.sizes.totalBytes).toBe('custom-sessions'.length + 'history'.length);
	});

	it('returns zero for missing files, file paths, and inaccessible entries', async () => {
		const historyFilePath = path.join(tempRoot, 'history');
		writeFile(historyFilePath, 'history-as-file');
		realFs.mkdirSync(path.join(tempRoot, 'group-chats'), { recursive: true });
		writeFile(path.join(tempRoot, 'group-chats', 'readable.jsonl'), 'readable');
		writeFile(path.join(tempRoot, 'group-chats', 'blocked.jsonl'), 'blocked');

		mocks.statSync.mockImplementation((target: realFs.PathLike) => {
			if (String(target).endsWith('blocked.jsonl')) {
				throw new Error('blocked');
			}
			return realFs.statSync(target);
		});

		const result = await collectStorage();

		expect(result.sizes.sessionsBytes).toBe(0);
		expect(result.sizes.historyBytes).toBe('history-as-file'.length);
		expect(result.sizes.groupChatsBytes).toBe('readable'.length);
		expect(result.sizes.totalBytes).toBe('history-as-file'.length + 'readable'.length);
	});

	it('returns zero when directory probing fails before iteration', async () => {
		writeFile(path.join(tempRoot, 'maestro-sessions.json'), 'sessions');
		realFs.mkdirSync(path.join(tempRoot, 'history'), { recursive: true });
		realFs.mkdirSync(path.join(tempRoot, 'group-chats'), { recursive: true });

		mocks.existsSync.mockImplementation((target: realFs.PathLike) => {
			if (String(target).endsWith('history')) {
				throw new Error('history unavailable');
			}
			return realFs.existsSync(target);
		});
		mocks.readdirSync.mockImplementation((target: realFs.PathLike) => {
			if (String(target).endsWith('group-chats')) {
				throw new Error('group chats unavailable');
			}
			return realFs.readdirSync(target as string);
		});

		const result = await collectStorage();

		expect(result.sizes.sessionsBytes).toBe('sessions'.length);
		expect(result.sizes.historyBytes).toBe(0);
		expect(result.sizes.groupChatsBytes).toBe(0);
		expect(result.sizes.totalBytes).toBe('sessions'.length);
	});

	it('returns zero when the sessions file stat fails', async () => {
		const sessionsFile = path.join(tempRoot, 'maestro-sessions.json');
		writeFile(sessionsFile, 'sessions');

		mocks.statSync.mockImplementation((target: realFs.PathLike) => {
			if (String(target) === sessionsFile) {
				throw new Error('sessions unavailable');
			}
			return realFs.statSync(target);
		});

		const result = await collectStorage();

		expect(result.sizes.sessionsBytes).toBe(0);
		expect(result.sizes.totalBytes).toBe(0);
	});
});
