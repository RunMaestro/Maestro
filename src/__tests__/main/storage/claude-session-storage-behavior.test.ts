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
	calculateClaudeCost: vi.fn(() => 1.23),
	storeData: { origins: {} as Record<string, Record<string, unknown>> },
}));

vi.mock('os', () => ({
	default: {
		homedir: vi.fn(() => mocks.homeDir),
	},
}));

vi.mock('electron-store', () => ({
	default: vi.fn(function MockElectronStore() {
		return {
			get: vi.fn((key: string, defaultValue?: unknown) => {
				return (mocks.storeData as Record<string, unknown>)[key] ?? defaultValue;
			}),
			set: vi.fn((key: string, value: unknown) => {
				(mocks.storeData as Record<string, unknown>)[key] = value;
			}),
		};
	}),
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

vi.mock('../../../main/utils/pricing', () => ({
	calculateClaudeCost: mocks.calculateClaudeCost,
}));

vi.mock('../../../main/utils/statsCache', () => ({
	encodeClaudeProjectPath: vi.fn((projectPath: string) =>
		projectPath.replace(/[^a-zA-Z0-9]/g, '-')
	),
}));

import fs from 'fs/promises';
import { ClaudeSessionStorage } from '../../../main/storage/claude-session-storage';
import type { ClaudeSessionOriginsData } from '../../../main/storage/claude-session-storage';
import type Store from 'electron-store';
import type { SshRemoteConfig } from '../../../shared/types';

const projectPath = '/repo/project';
const encodedProjectPath = '-repo-project';
const projectDir = path.join(mocks.homeDir, '.claude', 'projects', encodedProjectPath);
const remoteProjectDir = `~/.claude/projects/${encodedProjectPath}`;
const sessionId = 'claude-session-1';
const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);
const defaultMtime = new Date('2026-05-11T10:05:00.000Z');

let localFiles: Record<string, string>;
let localDirs: Record<string, string[]>;
let localStats: Record<string, { size: number; mtime: Date }>;

function json(value: unknown): string {
	return JSON.stringify(value);
}

function jsonl(...entries: Array<Record<string, unknown> | string>): string {
	return entries.map((entry) => (typeof entry === 'string' ? entry : json(entry))).join('\n');
}

function userMessage(uuid: string, content: unknown, timestamp = '2026-05-11T10:01:00.000Z') {
	return {
		type: 'user',
		uuid,
		timestamp,
		message: { role: 'user', content },
	};
}

function assistantMessage(uuid: string, content: unknown, timestamp = '2026-05-11T10:03:00.000Z') {
	return {
		type: 'assistant',
		uuid,
		timestamp,
		message: { role: 'assistant', content },
	};
}

function resultEntry(timestamp = '2026-05-11T10:05:00.000Z') {
	return {
		type: 'result',
		timestamp,
		usage: {
			input_tokens: 11,
			output_tokens: 13,
			cache_read_input_tokens: 17,
			cache_creation_input_tokens: 19,
		},
	};
}

function addFile(filePath: string, value: unknown, mtime = defaultMtime, size?: number): void {
	localFiles[filePath] = typeof value === 'string' ? value : json(value);
	localStats[filePath] = { size: size ?? Buffer.byteLength(localFiles[filePath]), mtime };
	const dir = path.dirname(filePath);
	localDirs[dir] = Array.from(new Set([...(localDirs[dir] || []), path.basename(filePath)]));
}

function addDirEntry(dir: string, entry: string): void {
	localDirs[dir] = Array.from(new Set([...(localDirs[dir] || []), entry]));
}

function setupLocalFiles(): void {
	localFiles = {};
	localDirs = {};
	localStats = {};

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
		if (localFiles[target] !== undefined) return localFiles[target];
		throw new Error(`missing file ${target}`);
	});
	vi.mocked(fs.stat).mockImplementation(async (target: string) => {
		const stats = localStats[target];
		if (!stats) throw new Error(`missing stat ${target}`);
		return {
			size: stats.size,
			mtimeMs: stats.mtime.getTime(),
			mtime: stats.mtime,
		} as Awaited<ReturnType<typeof fs.stat>>;
	});
}

function createStorage() {
	const store = {
		get: vi.fn((key: string, defaultValue?: unknown) => {
			return (mocks.storeData as Record<string, unknown>)[key] ?? defaultValue;
		}),
		set: vi.fn((key: string, value: unknown) => {
			(mocks.storeData as Record<string, unknown>)[key] = value;
		}),
	};
	return new ClaudeSessionStorage(store as unknown as Store<ClaudeSessionOriginsData>);
}

function remoteDir(entries: Array<{ name: string; isDirectory: boolean }>) {
	return { success: true, data: entries };
}

describe('ClaudeSessionStorage storage behavior', () => {
	let storage: ClaudeSessionStorage;

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.storeData.origins = {};
		setupLocalFiles();
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		storage = createStorage();
	});

	it('creates the default origins store when no store is injected', () => {
		const defaultStorage = new ClaudeSessionStorage();

		defaultStorage.registerSessionOrigin(projectPath, sessionId, 'user');

		expect(defaultStorage.getSessionOrigins(projectPath)).toEqual({
			[sessionId]: { origin: 'user' },
		});
	});

	it('lists local sessions with metadata, origin info, filtering, and parse failure handling', async () => {
		storage.registerSessionOrigin(projectPath, sessionId, 'auto', 'Named run');
		storage.updateSessionStarred(projectPath, sessionId, true);
		addFile(
			sessionPath,
			jsonl(
				userMessage('u-1', [{ type: 'text', text: 'Build the storage tests' }]),
				'{bad-json',
				assistantMessage('a-1', [{ type: 'text', text: 'Storage tests are ready' }]),
				resultEntry()
			)
		);
		addFile(path.join(projectDir, 'zero-byte.jsonl'), '', defaultMtime, 0);
		addFile(
			path.join(projectDir, 'oversized.jsonl'),
			jsonl(userMessage('u-big', 'Too large')),
			defaultMtime,
			101 * 1024 * 1024
		);
		addDirEntry(projectDir, 'stat-fails.jsonl');
		addFile(path.join(projectDir, 'notes.txt'), 'not a session');

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId,
			projectPath,
			sessionName: 'Named run',
			origin: 'auto',
			starred: true,
			firstMessage: 'Storage tests are ready',
			messageCount: 2,
			sizeBytes: Buffer.byteLength(localFiles[sessionPath]),
			modifiedAt: defaultMtime.toISOString(),
			inputTokens: 11,
			outputTokens: 13,
			cacheReadTokens: 17,
			cacheCreationTokens: 19,
			durationSeconds: 240,
			costUsd: 1.23,
		});
		expect(mocks.calculateClaudeCost).toHaveBeenCalledWith(11, 13, 17, 19);
		expect(fs.readFile).not.toHaveBeenCalledWith(path.join(projectDir, 'notes.txt'), 'utf-8');
		expect(fs.readFile).not.toHaveBeenCalledWith(path.join(projectDir, 'oversized.jsonl'), 'utf-8');
		expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
			operation: 'claudeStorage:processSessionFile',
			filename: 'stat-fails.jsonl',
		});
	});

	it('uses metadata fallbacks for local sessions with empty previews and missing timestamps', async () => {
		mocks.storeData.origins = {
			[projectPath]: {
				'metadata-fallbacks': 'user',
			},
		};
		addFile(
			path.join(projectDir, 'metadata-fallbacks.jsonl'),
			jsonl(
				assistantMessage('a-empty', [{ type: 'text', text: '' }], '2026-05-11T10:00:00.000Z'),
				{
					type: 'user',
					uuid: 'u-no-timestamp',
					message: { role: 'user', content: 'User without timestamp' },
				},
				{ type: 'summary', text: 'no timestamp here' }
			),
			defaultMtime
		);

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId: 'metadata-fallbacks',
			origin: 'user',
			firstMessage: 'User without timestamp',
			timestamp: defaultMtime.toISOString(),
			modifiedAt: defaultMtime.toISOString(),
			messageCount: 2,
			durationSeconds: 0,
		});
	});

	it('skips local sessions that hit parser, range, and read failures', async () => {
		const parseThrowsPath = path.join(projectDir, 'parse-throws.jsonl');
		const rangeErrorPath = path.join(projectDir, 'range-error.jsonl');
		const readErrorPath = path.join(projectDir, 'read-error.jsonl');
		addFile(parseThrowsPath, jsonl(userMessage('u-parse', 'will not parse')));
		addFile(rangeErrorPath, jsonl(userMessage('u-range', 'too large')));
		addFile(readErrorPath, jsonl(userMessage('u-read', 'read fails')));

		vi.mocked(fs.readFile).mockImplementation(async (target: string) => {
			if (target === parseThrowsPath) return null as unknown as string;
			if (target === rangeErrorPath) throw new RangeError('buffer too large');
			if (target === readErrorPath) throw new Error('disk denied');
			if (localFiles[target] !== undefined) return localFiles[target];
			throw new Error(`missing file ${target}`);
		});

		await expect(storage.listSessions(projectPath)).resolves.toEqual([]);

		expect(mocks.logger.error).toHaveBeenCalledWith(
			'Error parsing session content for session: parse-throws',
			expect.any(String),
			expect.any(TypeError)
		);
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			'Session file too large to parse',
			expect.any(String),
			{ filePath: rangeErrorPath }
		);
		expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
			operation: 'claudeStorage:readSessionFile',
			filePath: readErrorPath,
		});
	});

	it('returns empty local list results for missing directories and sorts multiple sessions', async () => {
		await expect(storage.listSessions('/missing/project')).resolves.toEqual([]);
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'No Claude sessions directory found for project: /missing/project',
			expect.any(String)
		);

		addFile(
			path.join(projectDir, 'older.jsonl'),
			jsonl(userMessage('u-old', 'Older')),
			new Date('2026-05-11T09:00:00Z')
		);
		addFile(
			path.join(projectDir, 'newer.jsonl'),
			jsonl(userMessage('u-new', 'Newer')),
			new Date('2026-05-11T11:00:00Z')
		);

		const sessions = await storage.listSessions(projectPath);

		expect(sessions.map((session) => session.sessionId)).toEqual(['newer', 'older']);
	});

	it('paginates local sessions by modified time and reads only the requested page', async () => {
		addFile(
			path.join(projectDir, 'older.jsonl'),
			jsonl(userMessage('u-old', 'Older')),
			new Date('2026-05-11T09:00:00.000Z')
		);
		addFile(
			path.join(projectDir, 'middle.jsonl'),
			jsonl(userMessage('u-mid', 'Middle')),
			new Date('2026-05-11T10:00:00.000Z')
		);
		addFile(
			path.join(projectDir, 'newer.jsonl'),
			jsonl(userMessage('u-new', 'Newer')),
			new Date('2026-05-11T11:00:00.000Z')
		);
		addFile(path.join(projectDir, 'empty.jsonl'), '', new Date('2026-05-11T12:00:00.000Z'), 0);

		const firstPage = await storage.listSessionsPaginated(projectPath, { limit: 2 });
		vi.mocked(fs.readFile).mockClear();
		const secondPage = await storage.listSessionsPaginated(projectPath, {
			cursor: 'middle',
			limit: 2,
		});

		expect(firstPage).toMatchObject({
			hasMore: true,
			totalCount: 3,
			nextCursor: 'middle',
		});
		expect(firstPage.sessions.map((session) => session.sessionId)).toEqual(['newer', 'middle']);
		expect(secondPage).toMatchObject({
			hasMore: false,
			totalCount: 3,
			nextCursor: null,
		});
		expect(secondPage.sessions.map((session) => session.sessionId)).toEqual(['older']);
		expect(fs.readFile).toHaveBeenCalledTimes(1);
		expect(fs.readFile).toHaveBeenCalledWith(path.join(projectDir, 'older.jsonl'), 'utf-8');
	});

	it('handles missing local pagination directories, stat failures, and parse-null page entries', async () => {
		await expect(storage.listSessionsPaginated('/missing/project')).resolves.toEqual({
			sessions: [],
			hasMore: false,
			totalCount: 0,
			nextCursor: null,
		});

		const goodPath = path.join(projectDir, 'good.jsonl');
		const statFailPath = path.join(projectDir, 'stat-fail.jsonl');
		const parseNullPath = path.join(projectDir, 'parse-null.jsonl');
		addFile(goodPath, jsonl(userMessage('u-good', 'Good')), new Date('2026-05-11T11:00:00Z'));
		addFile(
			statFailPath,
			jsonl(userMessage('u-stat', 'Stat fail')),
			new Date('2026-05-11T10:00:00Z')
		);
		addFile(
			parseNullPath,
			jsonl(userMessage('u-null', 'Parse null')),
			new Date('2026-05-11T09:00:00Z')
		);
		delete localStats[statFailPath];
		vi.mocked(fs.readFile).mockImplementation(async (target: string) => {
			if (target === parseNullPath) return null as unknown as string;
			if (localFiles[target] !== undefined) return localFiles[target];
			throw new Error(`missing file ${target}`);
		});

		const page = await storage.listSessionsPaginated(projectPath, {
			cursor: 'does-not-exist',
			limit: 3,
		});

		expect(page.sessions.map((session) => session.sessionId)).toEqual(['good']);
		expect(page.totalCount).toBe(2);
		expect(page.hasMore).toBe(false);
	});

	it('lists remote sessions while skipping stat failures, read failures, directories, and oversized files', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const remoteSessionPath = `${remoteProjectDir}/${sessionId}.jsonl`;
		mocks.readDirRemote.mockResolvedValue(
			remoteDir([
				{ name: `${sessionId}.jsonl`, isDirectory: false },
				{ name: 'stat-fails.jsonl', isDirectory: false },
				{ name: 'read-fails.jsonl', isDirectory: false },
				{ name: 'oversized.jsonl', isDirectory: false },
				{ name: 'nested', isDirectory: true },
				{ name: 'notes.txt', isDirectory: false },
			])
		);
		mocks.statRemote.mockImplementation(async (target: string) => {
			if (target.endsWith('stat-fails.jsonl')) return { success: false };
			if (target.endsWith('oversized.jsonl')) {
				return {
					success: true,
					data: { size: 101 * 1024 * 1024, mtime: defaultMtime.getTime() },
				};
			}
			return { success: true, data: { size: 512, mtime: defaultMtime.getTime() } };
		});
		mocks.readFileRemote.mockImplementation(async (target: string) => {
			if (target.endsWith('read-fails.jsonl')) return { success: false, error: 'read failed' };
			if (target === remoteSessionPath) {
				return {
					success: true,
					data: jsonl(
						userMessage('u-remote', 'Remote prompt'),
						assistantMessage('a-remote', 'Remote answer')
					),
				};
			}
			return { success: false };
		});

		const sessions = await storage.listSessions(projectPath, sshConfig);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId,
			firstMessage: 'Remote answer',
			messageCount: 2,
			sizeBytes: 512,
		});
		expect(mocks.readFileRemote).not.toHaveBeenCalledWith(
			`${remoteProjectDir}/oversized.jsonl`,
			sshConfig
		);
	});

	it('handles remote list failures, thrown remote reads, thrown stats, and remote search', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		mocks.readDirRemote.mockResolvedValueOnce({ success: false, error: 'missing remote dir' });

		await expect(storage.listSessions(projectPath, sshConfig)).resolves.toEqual([]);

		mocks.readDirRemote.mockResolvedValue(
			remoteDir([
				{ name: 'stat-throws.jsonl', isDirectory: false },
				{ name: 'read-throws.jsonl', isDirectory: false },
				{ name: 'searchable.jsonl', isDirectory: false },
				{ name: 'older-searchable.jsonl', isDirectory: false },
			])
		);
		mocks.statRemote.mockImplementation(async (target: string) => {
			if (target.endsWith('stat-throws.jsonl')) throw new Error('stat exploded');
			const isOlder = target.endsWith('older-searchable.jsonl');
			return {
				success: true,
				data: {
					size: 512,
					mtime: new Date(
						isOlder ? '2026-05-11T09:00:00.000Z' : '2026-05-11T10:05:00.000Z'
					).getTime(),
				},
			};
		});
		mocks.readFileRemote.mockImplementation(async (target: string) => {
			if (target.endsWith('read-throws.jsonl')) throw new Error('remote read exploded');
			if (target.endsWith('older-searchable.jsonl')) {
				return {
					success: true,
					data: jsonl(userMessage('u-old-remote', 'Older remote prompt')),
				};
			}
			if (target.endsWith('searchable.jsonl')) {
				return {
					success: true,
					data: jsonl(
						userMessage('u-search', 'Remote search prompt'),
						assistantMessage('a-search', 'Remote search answer')
					),
				};
			}
			return { success: false, error: 'missing' };
		});

		const sessions = await storage.listSessions(projectPath, sshConfig);
		const searchResults = await storage.searchSessions(
			projectPath,
			'search answer',
			'assistant',
			sshConfig
		);

		expect(sessions.map((session) => session.sessionId)).toEqual([
			'searchable',
			'older-searchable',
		]);
		expect(searchResults).toHaveLength(1);
		expect(searchResults[0]).toMatchObject({
			sessionId: 'searchable',
			matchType: 'assistant',
		});
		expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
			operation: 'claudeStorage:processRemoteSessionFile',
			filename: 'stat-throws.jsonl',
		});
		expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
			operation: 'claudeStorage:readRemoteSessionFile',
			filePath: `${remoteProjectDir}/read-throws.jsonl`,
		});
	});

	it('returns empty search results for remote search read failures and thrown local reads', async () => {
		addFile(sessionPath, jsonl(userMessage('u-local', { unsupported: true })));
		await expect(storage.searchSessions(projectPath, 'anything', 'all')).resolves.toEqual([]);

		let localReadCount = 0;
		vi.mocked(fs.readFile).mockImplementation(async (target: string) => {
			if (target === sessionPath && localReadCount++ > 0) {
				throw new Error('search read failed');
			}
			if (localFiles[target] !== undefined) return localFiles[target];
			throw new Error(`missing file ${target}`);
		});
		await expect(storage.searchSessions(projectPath, 'anything', 'all')).resolves.toEqual([]);

		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		mocks.readDirRemote.mockResolvedValue(
			remoteDir([{ name: `${sessionId}.jsonl`, isDirectory: false }])
		);
		mocks.statRemote.mockResolvedValue({
			success: true,
			data: { size: 512, mtime: defaultMtime.getTime() },
		});
		mocks.readFileRemote
			.mockResolvedValueOnce({
				success: true,
				data: jsonl(userMessage('u-remote', 'Remote searchable title')),
			})
			.mockResolvedValueOnce({ success: false, error: 'missing body' });

		await expect(
			storage.searchSessions(projectPath, 'anything', 'all', sshConfig)
		).resolves.toEqual([]);
	});

	it('paginates remote sessions and handles missing remote directories', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		mocks.readDirRemote.mockResolvedValueOnce({ success: false, error: 'missing' });

		await expect(storage.listSessionsPaginated(projectPath, undefined, sshConfig)).resolves.toEqual(
			{
				sessions: [],
				hasMore: false,
				totalCount: 0,
				nextCursor: null,
			}
		);

		mocks.readDirRemote.mockResolvedValue(
			remoteDir([
				{ name: 'newer.jsonl', isDirectory: false },
				{ name: 'older.jsonl', isDirectory: false },
			])
		);
		mocks.statRemote.mockImplementation(async (target: string) => {
			const isNewer = target.endsWith('newer.jsonl');
			return {
				success: true,
				data: {
					size: 512,
					mtime: new Date(
						isNewer ? '2026-05-11T11:00:00.000Z' : '2026-05-11T09:00:00.000Z'
					).getTime(),
				},
			};
		});
		mocks.readFileRemote.mockImplementation(async (target: string) => ({
			success: true,
			data: jsonl(userMessage(`u-${path.basename(target, '.jsonl')}`, path.basename(target))),
		}));

		const page = await storage.listSessionsPaginated(projectPath, { limit: 1 }, sshConfig);

		expect(page).toMatchObject({
			hasMore: true,
			totalCount: 2,
			nextCursor: 'newer',
		});
		expect(page.sessions.map((session) => session.sessionId)).toEqual(['newer']);
	});

	it('paginates remote sessions past a cursor while skipping failed remote stats and null parses', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		mocks.readDirRemote.mockResolvedValue(
			remoteDir([
				{ name: 'newer.jsonl', isDirectory: false },
				{ name: 'middle.jsonl', isDirectory: false },
				{ name: 'older.jsonl', isDirectory: false },
				{ name: 'stat-fails.jsonl', isDirectory: false },
				{ name: 'stat-throws.jsonl', isDirectory: false },
				{ name: 'parse-null.jsonl', isDirectory: false },
			])
		);
		mocks.statRemote.mockImplementation(async (target: string) => {
			if (target.endsWith('stat-fails.jsonl')) return { success: false };
			if (target.endsWith('stat-throws.jsonl')) throw new Error('stat exploded');
			const name = path.basename(target, '.jsonl');
			const timestamps: Record<string, string> = {
				newer: '2026-05-11T12:00:00Z',
				middle: '2026-05-11T11:00:00Z',
				older: '2026-05-11T10:00:00Z',
				'parse-null': '2026-05-11T09:00:00Z',
			};
			return {
				success: true,
				data: { size: 512, mtime: new Date(timestamps[name]).getTime() },
			};
		});
		mocks.readFileRemote.mockImplementation(async (target: string) => {
			if (target.endsWith('parse-null.jsonl')) {
				return { success: true, data: null as unknown as string };
			}
			const name = path.basename(target, '.jsonl');
			return { success: true, data: jsonl(userMessage(`u-${name}`, name)) };
		});

		const page = await storage.listSessionsPaginated(
			projectPath,
			{ cursor: 'newer', limit: 3 },
			sshConfig
		);
		const missingCursorPage = await storage.listSessionsPaginated(
			projectPath,
			{ cursor: 'missing-cursor', limit: 1 },
			sshConfig
		);

		expect(page.sessions.map((session) => session.sessionId)).toEqual(['middle', 'older']);
		expect(page).toMatchObject({
			hasMore: false,
			totalCount: 4,
			nextCursor: null,
		});
		expect(missingCursorPage.sessions.map((session) => session.sessionId)).toEqual(['newer']);
		expect(missingCursorPage).toMatchObject({
			hasMore: true,
			totalCount: 4,
			nextCursor: 'newer',
		});
	});

	it('reads local and remote messages with text blocks, tool use, pagination, malformed lines, and search', async () => {
		addFile(
			sessionPath,
			jsonl(
				userMessage('u-1', 'Create storage tests'),
				'{malformed',
				assistantMessage('a-1', [
					{ type: 'text', text: 'Added Claude behavior tests' },
					{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { cmd: 'npm test' } },
				]),
				{ type: 'user', uuid: 'u-no-content', message: { role: 'user' } },
				userMessage('u-object', { unsupported: true }),
				userMessage('u-empty', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }])
			)
		);

		const messages = await storage.readSessionMessages(projectPath, sessionId, { limit: 1 });
		const searchResults = await storage.searchSessions(projectPath, 'behavior tests', 'assistant');

		expect(messages.total).toBe(2);
		expect(messages.hasMore).toBe(true);
		expect(messages.messages[0]).toMatchObject({
			type: 'assistant',
			role: 'assistant',
			content: 'Added Claude behavior tests',
			uuid: 'a-1',
		});
		expect(messages.messages[0].toolUse).toEqual([
			expect.objectContaining({ type: 'tool_use', id: 'tool-1' }),
		]);
		expect(searchResults).toHaveLength(1);
		expect(searchResults[0].matchType).toBe('assistant');

		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		mocks.readFileRemote.mockResolvedValueOnce({
			success: true,
			data: jsonl(userMessage('u-remote', 'Remote message')),
		});
		await expect(
			storage.readSessionMessages(projectPath, sessionId, undefined, sshConfig)
		).resolves.toMatchObject({ total: 1 });
		mocks.readFileRemote.mockResolvedValueOnce({ success: false, error: 'missing' });
		await expect(
			storage.readSessionMessages(projectPath, sessionId, undefined, sshConfig)
		).resolves.toEqual({ messages: [], total: 0, hasMore: false });
	});

	it('deletes local message pairs, cleans orphan tool results, and supports fallback content', async () => {
		const nextUser = userMessage('u-2', [
			{ type: 'text', text: 'Keep this turn' },
			{ type: 'tool_result', tool_use_id: 'tool-1', content: 'remove me' },
			{ type: 'tool_result', tool_use_id: 'tool-keep', content: 'keep me' },
		]);
		addFile(
			sessionPath,
			jsonl(
				userMessage('u-1', 'Delete this prompt'),
				assistantMessage('a-1', [
					{ type: 'text', text: 'Delete this response' },
					{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
				]),
				nextUser,
				assistantMessage('a-2', 'Keep this response')
			)
		);

		const deleted = await storage.deleteMessagePair(projectPath, sessionId, 'u-1');
		const written = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
		const keptLines = written
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));

		expect(deleted).toEqual({ success: true, linesRemoved: 2 });
		expect(keptLines.map((line) => line.uuid)).toEqual(['u-2', 'a-2']);
		expect(keptLines[0].message.content).toEqual([
			{ type: 'text', text: 'Keep this turn' },
			{ type: 'tool_result', tool_use_id: 'tool-keep', content: 'keep me' },
		]);

		addFile(
			sessionPath,
			jsonl(
				userMessage('u-3', [{ type: 'text', text: 'Delete by content' }]),
				assistantMessage('a-3', 'Deleted by fallback')
			)
		);
		const fallbackDeleted = await storage.deleteMessagePair(
			projectPath,
			sessionId,
			'unknown',
			'Delete by content'
		);
		const missing = await storage.deleteMessagePair(projectPath, sessionId, 'unknown');

		expect(fallbackDeleted).toEqual({ success: true, linesRemoved: 2 });
		expect(missing).toEqual({ success: false, error: 'User message not found' });
	});

	it('deletes by string fallback while preserving malformed lines and removing orphan-only tool results', async () => {
		addFile(
			sessionPath,
			jsonl(
				'{malformed',
				userMessage('u-string', 'Delete string fallback'),
				{ type: 'assistant', uuid: 'a-no-content', message: { role: 'assistant' } },
				assistantMessage('a-delete', [
					{ type: 'tool_use', id: 'tool-delete', name: 'Read', input: {} },
				]),
				{ type: 'user', uuid: 'u-no-content', message: { role: 'user' } },
				userMessage('u-object-content', { unsupported: true }),
				userMessage('u-orphan', [
					{ type: 'tool_result', tool_use_id: 'tool-delete', content: 'remove all' },
				]),
				userMessage('u-string-keep', 'Keep this string turn'),
				userMessage('u-unrelated-tool-result', [
					{ type: 'tool_result', tool_use_id: 'other-tool', content: 'keep unrelated' },
				]),
				assistantMessage('a-keep', 'Keep this response')
			)
		);

		const deleted = await storage.deleteMessagePair(
			projectPath,
			sessionId,
			'unknown',
			'Delete string fallback'
		);
		const written = vi.mocked(fs.writeFile).mock.calls[0][1] as string;

		expect(deleted).toEqual({ success: true, linesRemoved: 3 });
		expect(written.trim().split('\n')).toEqual([
			'{malformed',
			json({ type: 'user', uuid: 'u-no-content', message: { role: 'user' } }),
			json(userMessage('u-object-content', { unsupported: true })),
			json(userMessage('u-string-keep', 'Keep this string turn')),
			json(
				userMessage('u-unrelated-tool-result', [
					{ type: 'tool_result', tool_use_id: 'other-tool', content: 'keep unrelated' },
				])
			),
			json(assistantMessage('a-keep', 'Keep this response')),
		]);
	});

	it('rejects remote deletion and captures local delete read or write failures', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		await expect(
			storage.deleteMessagePair(projectPath, sessionId, 'u-1', undefined, sshConfig)
		).resolves.toEqual({ success: false, error: 'Delete not supported for remote sessions' });

		await expect(storage.deleteMessagePair(projectPath, sessionId, 'u-1')).resolves.toMatchObject({
			success: false,
		});
		expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
			operation: 'claudeStorage:deleteMessagePair',
			sessionId,
		});

		addFile(sessionPath, jsonl(userMessage('u-1', 'Will fail'), assistantMessage('a-1', 'Reply')));
		vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('write denied'));
		await expect(storage.deleteMessagePair(projectPath, sessionId, 'u-1')).resolves.toMatchObject({
			success: false,
			error: 'Error: write denied',
		});
	});

	it('resolves session paths and returns named sessions with last activity while skipping stale entries', async () => {
		const otherProjectPath = '/other/project';
		const otherEncoded = '-other-project';
		const otherSessionPath = path.join(
			mocks.homeDir,
			'.claude',
			'projects',
			otherEncoded,
			'other-session.jsonl'
		);
		mocks.storeData.origins = {
			[projectPath]: {
				[sessionId]: { origin: 'user', sessionName: 'Named session', starred: true },
				'stale-session': { origin: 'auto', sessionName: 'Stale session' },
				unnamed: 'user',
			},
			[otherProjectPath]: {
				'other-session': { origin: 'auto', sessionName: 'Other named' },
			},
		};
		addFile(sessionPath, jsonl(userMessage('u-1', 'Named')), defaultMtime);
		addFile(otherSessionPath, jsonl(userMessage('u-2', 'Other')), new Date('2026-05-11T09:00:00Z'));

		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const namedSessions = await storage.getAllNamedSessions();

		expect(storage.getSessionPath(projectPath, sessionId)).toBe(sessionPath);
		expect(storage.getSessionPath(projectPath, sessionId, sshConfig)).toBe(
			`${remoteProjectDir}/${sessionId}.jsonl`
		);
		expect(namedSessions).toEqual([
			{
				agentSessionId: sessionId,
				projectPath,
				sessionName: 'Named session',
				starred: true,
				lastActivityAt: defaultMtime.getTime(),
			},
			{
				agentSessionId: 'other-session',
				projectPath: otherProjectPath,
				sessionName: 'Other named',
				starred: undefined,
				lastActivityAt: new Date('2026-05-11T09:00:00Z').getTime(),
			},
		]);
	});

	it('skips named sessions when no session path can be resolved', async () => {
		mocks.storeData.origins = {
			[projectPath]: {
				'no-path': { origin: 'user', sessionName: 'No Path' },
			},
		};
		vi.spyOn(storage, 'getSessionPath').mockReturnValue(null);

		await expect(storage.getAllNamedSessions()).resolves.toEqual([]);
	});
});
