import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	homeDir: '/home/test-user',
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	captureException: vi.fn(),
	readDirRemote: vi.fn(),
	readFileRemote: vi.fn(),
	statRemote: vi.fn(),
}));

vi.mock('os', () => ({
	default: {
		homedir: vi.fn(() => mocks.homeDir),
	},
}));

vi.mock('fs/promises', () => ({
	default: {
		access: vi.fn(),
		readdir: vi.fn(),
		readFile: vi.fn(),
		stat: vi.fn(),
		writeFile: vi.fn(),
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: mocks.captureException,
}));

vi.mock('../../../main/utils/remote-fs', () => ({
	readDirRemote: mocks.readDirRemote,
	readFileRemote: mocks.readFileRemote,
	statRemote: mocks.statRemote,
}));

import fs from 'fs/promises';
import { FactoryDroidSessionStorage } from '../../../main/storage/factory-droid-session-storage';
import type { SshRemoteConfig } from '../../../shared/types';

const projectPath = '/repo/project';
const sessionId = 'factory-1';
const encodedProjectPath = '-repo-project';
const projectDir = path.join(mocks.homeDir, '.factory', 'sessions', encodedProjectPath);
const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);
const settingsPath = path.join(projectDir, `${sessionId}.settings.json`);

let localFiles: Record<string, string>;
let localDirs: Record<string, string[]>;
let statMtimes: Record<string, Date>;

function json(value: unknown): string {
	return JSON.stringify(value);
}

function jsonl(...entries: Array<Record<string, unknown> | string>): string {
	return entries.map((entry) => (typeof entry === 'string' ? entry : json(entry))).join('\n');
}

function factoryMessage(
	id: string,
	role: 'user' | 'assistant',
	timestamp: string,
	content: unknown
) {
	return {
		type: 'message',
		id,
		timestamp,
		message: {
			role,
			content,
		},
	};
}

function addFile(filePath: string, value: unknown, mtime = '2026-05-11T10:04:00.000Z'): void {
	localFiles[filePath] = typeof value === 'string' ? value : json(value);
	statMtimes[filePath] = new Date(mtime);
	const dir = path.dirname(filePath);
	localDirs[dir] = Array.from(new Set([...(localDirs[dir] || []), path.basename(filePath)]));
}

function setupLocalFiles(): void {
	localFiles = {};
	localDirs = {};
	statMtimes = {};

	vi.mocked(fs.access).mockImplementation(async (target: string) => {
		if (localDirs[target] || localFiles[target]) return undefined;
		throw new Error(`missing ${target}`);
	});
	vi.mocked(fs.readdir).mockImplementation(async (target: string) => {
		if (localDirs[target]) {
			return localDirs[target] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
		}
		throw new Error(`missing dir ${target}`);
	});
	vi.mocked(fs.readFile).mockImplementation(async (target: string) => {
		if (localFiles[target]) return localFiles[target];
		throw new Error(`missing file ${target}`);
	});
	vi.mocked(fs.stat).mockImplementation(async (target: string) => {
		if (localFiles[target]) {
			const mtime = statMtimes[target] ?? new Date('2026-05-11T10:04:00.000Z');
			return {
				size: Buffer.byteLength(localFiles[target]),
				birthtime: new Date('2026-05-11T10:00:00.000Z'),
				mtime,
				isDirectory: () => false,
			} as Awaited<ReturnType<typeof fs.stat>>;
		}
		throw new Error(`missing stat ${target}`);
	});
}

function remoteDir(entries: Array<{ name: string; isDirectory: boolean }>) {
	return { success: true, data: entries };
}

describe('FactoryDroidSessionStorage', () => {
	let storage: FactoryDroidSessionStorage;

	beforeEach(() => {
		vi.clearAllMocks();
		setupLocalFiles();
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		storage = new FactoryDroidSessionStorage();
	});

	it('lists local sessions with previews, token settings, malformed-line tolerance, and newest sorting', async () => {
		const olderSessionPath = path.join(projectDir, 'factory-older.jsonl');
		addFile(
			sessionPath,
			jsonl(
				factoryMessage('u-1', 'user', '2026-05-11T10:01:00.000Z', [
					{ type: 'thinking', thinking: 'internal' },
					{ type: 'text', text: 'Build the Factory flow' },
				]),
				'{bad-json',
				factoryMessage('a-1', 'assistant', '2026-05-11T10:03:00.000Z', [
					{ type: 'text', text: 'Factory flow is ready' },
				])
			),
			'2026-05-11T10:03:00.000Z'
		);
		addFile(settingsPath, {
			assistantActiveTimeMs: 1250,
			tokenUsage: {
				inputTokens: 10,
				outputTokens: 20,
				cacheReadTokens: 3,
				cacheCreationTokens: 4,
			},
		});
		addFile(
			olderSessionPath,
			jsonl(
				factoryMessage('u-old', 'user', '2026-05-10T09:00:00.000Z', 'Older prompt'),
				factoryMessage('a-old', 'assistant', '2026-05-10T09:02:30.000Z', 'Older reply')
			),
			'2026-05-10T09:02:30.000Z'
		);
		addFile(path.join(projectDir, 'notes.txt'), 'not a session');

		const sessions = await storage.listSessions(projectPath);

		expect(sessions.map((session) => session.sessionId)).toEqual([sessionId, 'factory-older']);
		expect(sessions[0]).toMatchObject({
			projectPath,
			firstMessage: 'Build the Factory flow',
			messageCount: 2,
			inputTokens: 10,
			outputTokens: 20,
			cacheReadTokens: 3,
			cacheCreationTokens: 4,
			durationSeconds: 1,
			timestamp: '2026-05-11T10:01:00.000Z',
			modifiedAt: '2026-05-11T10:03:00.000Z',
		});
		expect(sessions[0].sizeBytes).toBe(Buffer.byteLength(localFiles[sessionPath]));
		expect(sessions[1]).toMatchObject({
			firstMessage: 'Older prompt',
			messageCount: 2,
			durationSeconds: 150,
		});
		expect(fs.readFile).not.toHaveBeenCalledWith(path.join(projectDir, 'notes.txt'), 'utf-8');
	});

	it('returns empty local results when the project directory is missing', async () => {
		localDirs = {};

		await expect(storage.listSessions(projectPath)).resolves.toEqual([]);
		expect(mocks.logger.info).toHaveBeenCalledWith(
			`No Factory Droid sessions directory for project: ${projectPath}`,
			expect.any(String)
		);
	});

	it('reads local messages with text arrays, string content, tool use, pagination, and search', async () => {
		addFile(
			sessionPath,
			jsonl(
				factoryMessage('u-1', 'user', '2026-05-11T10:01:00.000Z', 'Create tests'),
				factoryMessage('a-1', 'assistant', '2026-05-11T10:02:00.000Z', [
					{ type: 'text', text: 'Added focused tests' },
					{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { cmd: 'npm test' } },
					{ type: 'tool_result', tool_use_id: 'tool-1', content: 'passed' },
				]),
				{
					type: 'message',
					id: 'system-1',
					timestamp: '2026-05-11T10:02:30.000Z',
					message: { role: 'system', content: 'Internal event' },
				},
				factoryMessage('u-empty', 'user', '2026-05-11T10:03:00.000Z', [{ type: 'thinking' }])
			)
		);

		const messages = await storage.readSessionMessages(projectPath, sessionId, {
			limit: 1,
		});
		const searchResults = await storage.searchSessions(projectPath, 'focused tests', 'assistant');

		expect(messages.total).toBe(2);
		expect(messages.hasMore).toBe(true);
		expect(messages.messages).toHaveLength(1);
		expect(messages.messages[0]).toMatchObject({
			type: 'assistant',
			role: 'assistant',
			content: 'Added focused tests',
			uuid: 'a-1',
		});
		expect(messages.messages[0].toolUse).toEqual([
			expect.objectContaining({ type: 'tool_use', id: 'tool-1' }),
			expect.objectContaining({ type: 'tool_result', tool_use_id: 'tool-1' }),
		]);
		expect(searchResults).toHaveLength(1);
		expect(searchResults[0].matchType).toBe('assistant');
	});

	it('deletes a local user turn by uuid while preserving malformed lines and the next user turn', async () => {
		const nextUser = factoryMessage('u-2', 'user', '2026-05-11T10:04:00.000Z', 'Keep this prompt');
		addFile(
			sessionPath,
			jsonl(
				factoryMessage('u-1', 'user', '2026-05-11T10:01:00.000Z', 'Delete this prompt'),
				factoryMessage('a-1', 'assistant', '2026-05-11T10:02:00.000Z', 'Delete this reply'),
				'{bad-json',
				'',
				{ type: 'event', id: 'event-after-deleted-turn' },
				nextUser
			)
		);

		const result = await storage.deleteMessagePair(projectPath, sessionId, 'u-1');

		expect(result).toEqual({ success: true, linesRemoved: 3 });
		expect(fs.writeFile).toHaveBeenCalledWith(
			sessionPath,
			`{bad-json\n\n${json(nextUser)}\n`,
			'utf-8'
		);
	});

	it('continues local listing when one session file cannot be read', async () => {
		addFile(
			sessionPath,
			jsonl(factoryMessage('u-1', 'user', '2026-05-11T10:01:00.000Z', 'Valid prompt'))
		);
		localDirs[projectDir] = [...localDirs[projectDir], 'broken.jsonl'];

		const sessions = await storage.listSessions(projectPath);

		expect(sessions.map((session) => session.sessionId)).toEqual([sessionId]);
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			'Error reading Factory Droid session broken',
			expect.any(String),
			expect.objectContaining({ error: expect.any(Error) })
		);
	});

	it('uses local stat fallbacks for empty sessions and returns empty reads for missing files', async () => {
		const emptyPath = path.join(projectDir, 'factory-empty.jsonl');
		addFile(emptyPath, '\n', '2026-05-11T10:09:00.000Z');

		const sessions = await storage.listSessions(projectPath);
		const missingMessages = await storage.readSessionMessages(projectPath, 'missing-session');

		expect(sessions.find((session) => session.sessionId === 'factory-empty')).toMatchObject({
			firstMessage: 'Factory Droid session',
			messageCount: 0,
			timestamp: '2026-05-11T10:00:00.000Z',
			modifiedAt: '2026-05-11T10:09:00.000Z',
			durationSeconds: 0,
		});
		expect(missingMessages).toMatchObject({
			messages: [],
			total: 0,
			hasMore: false,
		});
		expect(mocks.logger.debug).toHaveBeenCalledWith(
			expect.stringContaining('Failed to load session messages:'),
			expect.any(String),
			expect.objectContaining({ error: expect.any(Error) })
		);
	});

	it('uses the first non-empty local user message for the session preview', async () => {
		addFile(
			sessionPath,
			jsonl(
				factoryMessage('a-1', 'assistant', '2026-05-11T10:01:00.000Z', 'Assistant first'),
				factoryMessage('u-empty', 'user', '2026-05-11T10:02:00.000Z', [
					{ type: 'thinking', thinking: 'skip this' },
					{ type: 'text', text: '' },
				]),
				factoryMessage('u-usable', 'user', '2026-05-11T10:03:00.000Z', [
					{ type: 'text', text: 'First usable prompt' },
				])
			)
		);

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId,
			firstMessage: 'First usable prompt',
			messageCount: 3,
			durationSeconds: 120,
		});
	});

	it('supports fallback-content deletion, missing-message failures, and read failures', async () => {
		addFile(
			sessionPath,
			jsonl(
				factoryMessage('u-1', 'user', '2026-05-11T10:01:00.000Z', ' Delete by content '),
				factoryMessage('a-1', 'assistant', '2026-05-11T10:02:00.000Z', 'Deleted reply')
			)
		);

		const deleted = await storage.deleteMessagePair(
			projectPath,
			sessionId,
			'unknown',
			'delete by content'
		);
		const missing = await storage.deleteMessagePair(projectPath, sessionId, 'unknown');
		delete localFiles[sessionPath];
		const failedRead = await storage.deleteMessagePair(projectPath, sessionId, 'u-1');

		expect(deleted).toEqual({ success: true, linesRemoved: 2 });
		expect(missing).toEqual({ success: false, error: 'User message not found' });
		expect(failedRead.success).toBe(false);
		expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
			operation: 'factoryDroidStorage:deleteMessagePair',
			sessionId,
		});
	});

	it('rejects remote deletion and resolves local and remote session paths', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;

		expect(storage.getSessionPath(projectPath, sessionId)).toBe(sessionPath);
		expect(storage.getSessionPath(projectPath, sessionId, sshConfig)).toBe(
			`~/.factory/sessions/${encodedProjectPath}/${sessionId}.jsonl`
		);
		await expect(
			storage.deleteMessagePair(projectPath, sessionId, 'u-1', undefined, sshConfig)
		).resolves.toEqual({ success: false, error: 'Delete not supported for remote sessions' });
	});

	it('lists and reads remote sessions through SSH utilities', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const remoteDirPath = `~/.factory/sessions/${encodedProjectPath}`;
		const remoteSessionPath = `${remoteDirPath}/${sessionId}.jsonl`;
		const remoteSettingsPath = `${remoteDirPath}/${sessionId}.settings.json`;
		mocks.readDirRemote.mockImplementation(async (target: string) => {
			if (target === remoteDirPath) {
				return remoteDir([
					{ name: `${sessionId}.jsonl`, isDirectory: false },
					{ name: `${sessionId}.settings.json`, isDirectory: false },
					{ name: 'nested', isDirectory: true },
				]);
			}
			return { success: false };
		});
		mocks.statRemote.mockResolvedValue({
			success: true,
			data: { size: 321, mtime: new Date('2026-05-11T10:05:00.000Z').getTime() },
		});
		mocks.readFileRemote.mockImplementation(async (target: string) => {
			if (target === remoteSettingsPath) {
				return {
					success: true,
					data: json({
						assistantActiveTimeMs: 3000,
						tokenUsage: { inputTokens: 2, outputTokens: 5 },
					}),
				};
			}
			if (target === remoteSessionPath) {
				return {
					success: true,
					data: jsonl(
						factoryMessage('u-remote', 'user', '2026-05-11T10:01:00.000Z', [
							{ type: 'text', text: 'Remote prompt' },
						]),
						factoryMessage('a-remote', 'assistant', '2026-05-11T10:04:00.000Z', [
							{ type: 'text', text: 'Remote answer' },
						])
					),
				};
			}
			return { success: false };
		});

		const sessions = await storage.listSessions(projectPath, sshConfig);
		const messages = await storage.readSessionMessages(
			projectPath,
			sessionId,
			undefined,
			sshConfig
		);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId,
			projectPath,
			firstMessage: 'Remote prompt',
			messageCount: 2,
			sizeBytes: 321,
			inputTokens: 2,
			outputTokens: 5,
			durationSeconds: 3,
		});
		expect(messages.messages.map((message) => message.content)).toEqual([
			'Remote prompt',
			'Remote answer',
		]);
	});

	it('handles remote malformed files, stat failures, timestamp fallbacks, and remote search', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const remoteDirPath = `~/.factory/sessions/${encodedProjectPath}`;
		const fallbackPath = `${remoteDirPath}/factory-fallback.jsonl`;
		const fallbackSettingsPath = `${remoteDirPath}/factory-fallback.settings.json`;
		const emptyPath = `${remoteDirPath}/factory-empty.jsonl`;
		const emptySettingsPath = `${remoteDirPath}/factory-empty.settings.json`;
		const statFailPath = `${remoteDirPath}/factory-stat-fail.jsonl`;
		const statThrowPath = `${remoteDirPath}/factory-stat-throw.jsonl`;

		mocks.readDirRemote.mockResolvedValue(
			remoteDir([
				{ name: 'factory-stat-fail.jsonl', isDirectory: false },
				{ name: 'factory-stat-throw.jsonl', isDirectory: false },
				{ name: 'factory-empty.jsonl', isDirectory: false },
				{ name: 'factory-fallback.jsonl', isDirectory: false },
			])
		);
		mocks.statRemote.mockImplementation(async (target: string) => {
			if (target === statFailPath) return { success: false };
			if (target === statThrowPath) throw new Error('stat exploded');
			return {
				success: true,
				data: {
					size: target === emptyPath ? 0 : 512,
					mtime: new Date('2026-05-11T10:10:00.000Z').getTime(),
				},
			};
		});
		mocks.readFileRemote.mockImplementation(async (target: string) => {
			if (target === fallbackSettingsPath) {
				return { success: true, data: '{invalid-settings-json' };
			}
			if (target === emptySettingsPath) {
				return { success: false, error: 'missing settings' };
			}
			if (target === emptyPath) {
				throw new Error('remote read exploded');
			}
			if (target === fallbackPath) {
				return {
					success: true,
					data: jsonl(
						'{bad-json',
						factoryMessage('a-1', 'assistant', '2026-05-11T10:02:00.000Z', [
							{ type: 'text', text: 'Assistant first' },
						]),
						{
							type: 'message',
							id: 'u-empty-object',
							timestamp: '2026-05-11T10:03:00.000Z',
							message: { role: 'user', content: { unsupported: true } },
						},
						factoryMessage(
							'u-remote',
							'user',
							'2026-05-11T10:04:00.000Z',
							'Remote fallback prompt'
						),
						factoryMessage(
							'a-remote',
							'assistant',
							'2026-05-11T10:06:30.000Z',
							'Remote fallback answer'
						)
					),
				};
			}
			return { success: false };
		});

		const sessions = await storage.listSessions(projectPath, sshConfig);
		const searchResults = await storage.searchSessions(
			projectPath,
			'fallback prompt',
			'user',
			sshConfig
		);

		expect(sessions.map((session) => session.sessionId)).toEqual([
			'factory-empty',
			'factory-fallback',
		]);
		expect(sessions.find((session) => session.sessionId === 'factory-fallback')).toMatchObject({
			firstMessage: 'Remote fallback prompt',
			messageCount: 4,
			durationSeconds: 270,
			inputTokens: 0,
			outputTokens: 0,
		});
		expect(sessions.find((session) => session.sessionId === 'factory-empty')).toMatchObject({
			firstMessage: 'Factory Droid session',
			messageCount: 0,
			timestamp: '2026-05-11T10:10:00.000Z',
			modifiedAt: '2026-05-11T10:10:00.000Z',
		});
		expect(searchResults).toHaveLength(1);
		expect(searchResults[0]).toMatchObject({
			sessionId: 'factory-fallback',
			matchType: 'user',
		});
		expect(mocks.logger.error).toHaveBeenCalledWith(
			`Failed to stat remote file: ${statFailPath}`,
			expect.any(String)
		);
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			'Error reading remote Factory Droid session factory-stat-throw',
			expect.any(String),
			expect.objectContaining({ error: expect.any(Error) })
		);
	});

	it('returns empty remote results when the remote directory or file reads are unavailable', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		mocks.readDirRemote.mockResolvedValue({ success: false, error: 'missing' });

		await expect(storage.listSessions(projectPath, sshConfig)).resolves.toEqual([]);

		mocks.readFileRemote.mockResolvedValue({ success: false, error: 'missing file' });
		await expect(
			storage.readSessionMessages(projectPath, sessionId, undefined, sshConfig)
		).resolves.toMatchObject({
			messages: [],
			total: 0,
		});
	});
});
