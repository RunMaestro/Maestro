import { createHash } from 'crypto';
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
	existsSync: vi.fn(),
	databaseCtor: vi.fn(),
}));

vi.mock('os', () => ({
	default: {
		homedir: vi.fn(() => mocks.homeDir),
	},
}));

vi.mock('fs', () => ({
	default: {
		existsSync: mocks.existsSync,
	},
	existsSync: mocks.existsSync,
}));

vi.mock('fs/promises', () => ({
	default: {
		access: vi.fn(),
		readdir: vi.fn(),
		readFile: vi.fn(),
		stat: vi.fn(),
		unlink: vi.fn(),
		rmdir: vi.fn(),
	},
}));

vi.mock('better-sqlite3', () => ({
	default: mocks.databaseCtor,
}));

vi.mock('../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
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
import { OpenCodeSessionStorage } from '../../../main/storage/opencode-session-storage';
import type { SshRemoteConfig } from '../../../shared/types';

const projectPath = '/repo/project';
const projectId = 'proj-1';
const sessionId = 'ses_abc123';
const storageDir = path.join(mocks.homeDir, '.local', 'share', 'opencode', 'storage');
const projectDir = path.join(storageDir, 'project');
const sessionDir = path.join(storageDir, 'session', projectId);
const messageDir = path.join(storageDir, 'message', sessionId);
const remoteStorageDir = '~/.local/share/opencode/storage';
const remoteProjectDir = `${remoteStorageDir}/project`;

let localFiles: Record<string, string>;
let localDirs: Record<string, string[]>;

function json(value: unknown): string {
	return JSON.stringify(value);
}

function message(
	id: string,
	role: 'user' | 'assistant',
	created: number,
	overrides: Record<string, unknown> = {}
) {
	return {
		id,
		sessionID: sessionId,
		role,
		time: { created },
		...overrides,
	};
}

function part(
	id: string,
	messageID: string,
	type: 'text' | 'tool',
	overrides: Record<string, unknown> = {}
) {
	return {
		id,
		messageID,
		type,
		...overrides,
	};
}

function partDir(messageId: string): string {
	return path.join(storageDir, 'part', messageId);
}

function addFile(filePath: string, value: unknown): void {
	localFiles[filePath] = typeof value === 'string' ? value : json(value);
	const dir = path.dirname(filePath);
	localDirs[dir] = Array.from(new Set([...(localDirs[dir] || []), path.basename(filePath)]));
}

function setupLocalJsonStorage(): void {
	localFiles = {};
	localDirs = {};

	addFile(path.join(projectDir, `${projectId}.json`), {
		id: projectId,
		worktree: projectPath,
	});
	addFile(path.join(sessionDir, `${sessionId}.json`), {
		id: sessionId,
		projectID: projectId,
		directory: projectPath,
		title: 'Session title',
		time: { created: 1778493600000, updated: 1778493900000 },
	});
	addFile(
		path.join(messageDir, 'msg-user.json'),
		message('msg-user', 'user', 1778493600000, {
			tokens: { input: 4, output: 0, cache: { read: 1, write: 2 } },
			cost: 0.01,
		})
	);
	addFile(
		path.join(messageDir, 'msg-assistant.json'),
		message('msg-assistant', 'assistant', 1778493720000, {
			tokens: { input: 0, output: 8, reasoning: 3, cache: { read: 2, write: 0 } },
			cost: 0.02,
		})
	);
	addFile(path.join(partDir('msg-user'), 'part-user.json'), {
		...part('part-user', 'msg-user', 'text'),
		text: 'Implement auth',
	});
	addFile(path.join(partDir('msg-assistant'), 'part-assistant.json'), {
		...part('part-assistant', 'msg-assistant', 'text'),
		text: 'Use a focused plan',
	});
	addFile(path.join(partDir('msg-assistant'), 'tool-1.json'), {
		...part('tool-1', 'msg-assistant', 'tool'),
		tool: 'bash',
		state: { status: 'completed', input: { cmd: 'npm test' }, output: 'passed' },
	});

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
			return { size: Buffer.byteLength(localFiles[target]) } as Awaited<ReturnType<typeof fs.stat>>;
		}
		throw new Error(`missing stat ${target}`);
	});
}

function remoteDir(entries: Array<{ name: string; isDirectory: boolean }>) {
	return { success: true, data: entries };
}

function setupSqliteDatabaseWithPrepare(prepare: (sql: string) => unknown) {
	const db = {
		close: vi.fn(),
		prepare: vi.fn(prepare),
	};
	mocks.existsSync.mockReturnValue(true);
	mocks.databaseCtor.mockImplementation(function MockDatabase() {
		return db;
	});
	return db;
}

function setupSqliteDatabaseMock() {
	const close = vi.fn();
	const sqliteMessages = [
		{
			id: 'sqlite-user',
			session_id: 'ses_sqlite',
			time_created: 1778493600000,
			time_updated: 1778493600000,
			data: json({
				role: 'user',
				tokens: { input: 6, cache: { read: 2, write: 1 } },
				cost: 0.01,
			}),
		},
		{
			id: 'sqlite-assistant',
			session_id: 'ses_sqlite',
			time_created: 1778493720000,
			time_updated: 1778493720000,
			data: json({
				role: 'assistant',
				tokens: { output: 12, reasoning: 3, cache: { read: 1 } },
				cost: 0.02,
			}),
		},
		{
			id: 'sqlite-invalid',
			session_id: 'ses_sqlite',
			time_created: 1778493780000,
			time_updated: 1778493780000,
			data: '{bad-json',
		},
	];
	const sqliteParts = [
		{
			message_id: 'sqlite-user',
			id: 'sqlite-user-text',
			data: json({ type: 'text', text: 'SQLite user prompt' }),
		},
		{
			message_id: 'sqlite-assistant',
			id: 'sqlite-assistant-text',
			data: json({ type: 'text', text: 'SQLite assistant answer' }),
		},
		{
			message_id: 'sqlite-assistant',
			id: 'sqlite-tool',
			data: json({ type: 'tool', tool: 'bash', state: { output: 'ok' } }),
		},
		{
			message_id: 'sqlite-invalid',
			id: 'sqlite-invalid-part',
			data: '{bad-json',
		},
	];
	const db = {
		close,
		prepare: vi.fn((sql: string) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						['session', 'project', 'message', 'part'].includes(tableName)
							? { name: tableName }
							: undefined
					),
				};
			}
			if (sql === 'SELECT 1 FROM session WHERE id = ? LIMIT 1') {
				return {
					get: vi.fn((id: string) => (id === 'ses_sqlite' ? { 1: 1 } : undefined)),
				};
			}
			if (sql === 'SELECT id, worktree FROM project') {
				return {
					all: vi.fn(() => [
						{ id: 'sqlite-project', worktree: projectPath },
						{ id: 'global', worktree: '/' },
					]),
				};
			}
			if (sql.includes('FROM session WHERE project_id IN')) {
				return {
					all: vi.fn(() => [
						{
							id: 'ses_sqlite',
							project_id: 'sqlite-project',
							directory: projectPath,
							title: 'SQLite title',
							version: '1.2.0',
							time_created: 1778493500000,
							time_updated: 1778494000000,
							summary_additions: null,
							summary_deletions: null,
							summary_files: null,
						},
					]),
				};
			}
			if (sql.includes("FROM session WHERE project_id = 'global'")) {
				return {
					all: vi.fn(() => [
						{
							id: 'ses_global_sqlite',
							project_id: 'global',
							directory: `${projectPath}/child`,
							title: 'Global SQLite title',
							version: '1.2.0',
							time_created: 1778493400000,
							time_updated: 1778493800000,
							summary_additions: null,
							summary_deletions: null,
							summary_files: null,
						},
					]),
				};
			}
			if (sql.includes('FROM message WHERE session_id IN')) {
				return {
					all: vi.fn(() => sqliteMessages),
				};
			}
			if (sql.includes('FROM part WHERE message_id IN')) {
				return {
					all: vi.fn(() => sqliteParts),
				};
			}
			if (sql.includes('FROM message WHERE session_id = ?')) {
				return {
					all: vi.fn((id: string) => (id === 'ses_sqlite' ? sqliteMessages : [])),
				};
			}
			if (sql.includes('FROM part WHERE message_id = ?')) {
				return {
					all: vi.fn((messageId: string) =>
						sqliteParts
							.filter((part) => part.message_id === messageId)
							.map(({ id, data }) => ({ id, data }))
					),
				};
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		}),
	};
	mocks.existsSync.mockReturnValue(true);
	mocks.databaseCtor.mockImplementation(function MockDatabase() {
		return db;
	});
	return db;
}

class TestableOpenCodeSessionStorage extends OpenCodeSessionStorage {
	readSearchableMessagesForTest(
		sessionId: string,
		projectPath: string,
		sshConfig?: SshRemoteConfig
	) {
		return this.getSearchableMessages(sessionId, projectPath, sshConfig);
	}
}

describe('OpenCodeSessionStorage', () => {
	let storage: OpenCodeSessionStorage;

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.existsSync.mockReturnValue(false);
		vi.mocked(fs.unlink).mockResolvedValue(undefined);
		vi.mocked(fs.rmdir).mockResolvedValue(undefined);
		setupLocalJsonStorage();
		storage = new OpenCodeSessionStorage();
	});

	it('lists local JSON sessions with message stats, preview, duration, and size', async () => {
		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId,
			projectPath,
			firstMessage: 'Use a focused plan',
			messageCount: 2,
			costUsd: 0.03,
			inputTokens: 4,
			outputTokens: 8,
			cacheReadTokens: 3,
			cacheCreationTokens: 2,
			durationSeconds: 120,
			sizeBytes: Buffer.byteLength(localFiles[path.join(sessionDir, `${sessionId}.json`)]),
		});
	});

	it('falls back to global project sessions and filters by directory', async () => {
		localDirs[projectDir] = ['global.json'];
		addFile(path.join(projectDir, 'global.json'), { id: 'global', worktree: '/' });
		const globalSessionDir = path.join(storageDir, 'session', 'global');
		addFile(path.join(globalSessionDir, 'exact.json'), {
			id: 'ses_exact',
			projectID: 'global',
			directory: projectPath,
			title: 'Global exact',
			time: { created: 1778493600000, updated: 1778493920000 },
		});
		addFile(path.join(globalSessionDir, 'match.json'), {
			id: 'ses_match',
			projectID: 'global',
			directory: `${projectPath}/subdir`,
			title: 'Global match',
			time: { created: 1778493600000, updated: 1778493900000 },
		});
		addFile(path.join(globalSessionDir, 'skip.json'), {
			id: 'ses_skip',
			projectID: 'global',
			directory: '/other/project',
			title: 'Global skip',
			time: { created: 1778493600000, updated: 1778493910000 },
		});
		addFile(path.join(globalSessionDir, 'missing-directory.json'), {
			id: 'ses_missing_directory',
			projectID: 'global',
			title: 'Global missing directory',
			time: { created: 1778493600000, updated: 1778493930000 },
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions.map((session) => session.sessionId)).toEqual(['ses_exact', 'ses_match']);
	});

	it('matches local project metadata whose stored worktree is inside the requested path', async () => {
		localFiles = {};
		localDirs = {};
		addFile(path.join(projectDir, 'other.json'), {
			id: 'other',
			worktree: '/elsewhere/project',
		});
		addFile(path.join(projectDir, `${projectId}.json`), {
			id: projectId,
			worktree: `${projectPath}/packages/app`,
		});
		addFile(path.join(sessionDir, 'ses_child_worktree.json'), {
			id: 'ses_child_worktree',
			projectID: projectId,
			directory: `${projectPath}/packages/app`,
			title: 'Child worktree',
			time: { created: 1778493600000, updated: 1778493900000 },
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: 'ses_child_worktree',
				firstMessage: 'Child worktree',
			}),
		]);
	});

	it('reads local messages with text, tool parts, pagination, and search', async () => {
		const messages = await storage.readSessionMessages(projectPath, sessionId, {
			offset: 0,
			limit: 10,
		});
		const searchResults = await storage.searchSessions(projectPath, 'focused plan', 'assistant');

		expect(messages.total).toBe(2);
		expect(messages.messages.map((message) => message.content)).toEqual([
			'Implement auth',
			'Use a focused plan',
		]);
		expect(messages.messages[1].toolUse).toEqual([
			expect.objectContaining({
				id: 'tool-1',
				type: 'tool',
				tool: 'bash',
			}),
		]);
		expect(searchResults).toHaveLength(1);
		expect(searchResults[0].matchType).toBe('assistant');
	});

	it('skips malformed local messages and parts while preserving valid message reads', async () => {
		addFile(path.join(messageDir, 'broken-message.json'), '{bad-json');
		addFile(
			path.join(messageDir, 'msg-empty-assistant.json'),
			message('msg-empty-assistant', 'assistant', 0, {
				time: undefined,
				tokens: { input: 0, output: 0 },
				cost: 0,
			})
		);
		addFile(
			path.join(messageDir, 'msg-empty-user.json'),
			message('msg-empty-user', 'user', 0, {
				time: undefined,
			})
		);
		addFile(path.join(partDir('msg-empty-assistant'), 'broken-part.json'), '{bad-json');
		addFile(path.join(partDir('msg-empty-assistant'), 'blank-text.json'), {
			...part('blank-text', 'msg-empty-assistant', 'text'),
			text: '',
		});

		const sessions = await storage.listSessions(projectPath);
		const messages = await storage.readSessionMessages(projectPath, sessionId);

		expect(sessions[0]).toMatchObject({
			sessionId,
			firstMessage: 'Use a focused plan',
			messageCount: 4,
			durationSeconds: 0,
		});
		expect(messages.messages.map((msg) => msg.uuid)).toEqual(['msg-user', 'msg-assistant']);
	});

	it('lists and reads SQLite-backed sessions before rejecting SQLite deletion', async () => {
		setupSqliteDatabaseMock();

		const sessions = await storage.listSessions(projectPath);
		const messages = await storage.readSessionMessages(projectPath, 'ses_sqlite');

		expect(sessions.map((session) => session.sessionId)).toEqual([
			'ses_sqlite',
			sessionId,
			'ses_global_sqlite',
		]);
		expect(sessions[0]).toMatchObject({
			projectPath,
			firstMessage: 'SQLite assistant answer',
			messageCount: 3,
			costUsd: 0.03,
			inputTokens: 6,
			outputTokens: 12,
			cacheReadTokens: 3,
			cacheCreationTokens: 1,
			durationSeconds: 180,
		});
		expect(messages.messages).toEqual([
			expect.objectContaining({
				type: 'user',
				content: 'SQLite user prompt',
				timestamp: '2026-05-11T10:00:00.000Z',
				uuid: 'sqlite-user',
			}),
			expect.objectContaining({
				type: 'assistant',
				content: 'SQLite assistant answer',
				timestamp: '2026-05-11T10:02:00.000Z',
				uuid: 'sqlite-assistant',
				toolUse: [expect.objectContaining({ id: 'sqlite-tool', type: 'tool', tool: 'bash' })],
			}),
		]);
		expect(storage.getSessionPath(projectPath, 'ses_sqlite')).toBe(
			path.join(mocks.homeDir, '.local', 'share', 'opencode', 'opencode.db')
		);
		await expect(
			storage.deleteMessagePair(projectPath, 'ses_sqlite', 'sqlite-user')
		).resolves.toEqual({
			success: false,
			error: 'Delete not supported for OpenCode v1.2+ SQLite sessions',
		});
	});

	it('returns SQLite rows without message stats when the message table is absent', async () => {
		localDirs[projectDir] = [];
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						['session', 'project'].includes(tableName) ? { name: tableName } : undefined
					),
				};
			}
			if (sql === 'SELECT id, worktree FROM project') {
				return { all: vi.fn(() => [{ id: 'sqlite-project', worktree: projectPath }]) };
			}
			if (sql.includes('FROM session WHERE project_id IN')) {
				return {
					all: vi.fn(() => [
						{
							id: 'ses_schema_only',
							project_id: 'sqlite-project',
							directory: projectPath,
							title: 'Schema only title',
							version: '1.2.0',
							time_created: 0,
							time_updated: 0,
							summary_additions: null,
							summary_deletions: null,
							summary_files: null,
						},
					]),
				};
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: 'ses_schema_only',
				firstMessage: 'Schema only title',
				messageCount: 0,
				inputTokens: 0,
				outputTokens: 0,
			}),
		]);
	});

	it('converts SQLite sessions with empty message batches and missing timestamps', async () => {
		localDirs[projectDir] = [];
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						['session', 'project', 'message', 'part'].includes(tableName)
							? { name: tableName }
							: undefined
					),
				};
			}
			if (sql === 'SELECT id, worktree FROM project') {
				return { all: vi.fn(() => [{ id: 'sqlite-project', worktree: projectPath }]) };
			}
			if (sql.includes('FROM session WHERE project_id IN')) {
				return {
					all: vi.fn(() => [
						{
							id: 'ses_empty_stats',
							project_id: 'sqlite-project',
							directory: projectPath,
							title: '',
							version: '1.2.0',
							time_created: 0,
							time_updated: 0,
							summary_additions: null,
							summary_deletions: null,
							summary_files: null,
						},
					]),
				};
			}
			if (sql.includes('FROM message WHERE session_id IN')) {
				return { all: vi.fn(() => []) };
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: 'ses_empty_stats',
				firstMessage: '',
				messageCount: 0,
				durationSeconds: 0,
			}),
		]);
		expect(sessions[0].modifiedAt).toBe(sessions[0].timestamp);
	});

	it('falls back to JSON when SQLite lacks required tables or matching sessions', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return { get: vi.fn(() => undefined) };
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		expect(storage.getSessionPath(projectPath, sessionId)).toBe(messageDir);
		await expect(storage.listSessions(projectPath)).resolves.toEqual([
			expect.objectContaining({ sessionId }),
		]);

		vi.clearAllMocks();
		setupLocalJsonStorage();
		storage = new OpenCodeSessionStorage();
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						['session', 'project'].includes(tableName) ? { name: tableName } : undefined
					),
				};
			}
			if (sql === 'SELECT id, worktree FROM project') {
				return { all: vi.fn(() => [{ id: 'other-project', worktree: '/other/project' }]) };
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		await expect(storage.listSessions(projectPath)).resolves.toEqual([
			expect.objectContaining({ sessionId }),
		]);
		expect(mocks.logger.info).toHaveBeenCalledWith(
			expect.stringContaining('No OpenCode sessions found in SQLite'),
			'[OpenCodeSessionStorage]'
		);
	});

	it('falls back to JSON when expected SQLite listing errors occur', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						['session', 'project'].includes(tableName) ? { name: tableName } : undefined
					),
				};
			}
			if (sql === 'SELECT id, worktree FROM project') {
				return {
					all: vi.fn(() => {
						throw new Error('database is locked');
					}),
				};
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		await expect(storage.listSessions(projectPath)).resolves.toEqual([
			expect.objectContaining({ sessionId }),
		]);
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Error reading OpenCode SQLite database'),
			'[OpenCodeSessionStorage]'
		);
	});

	it('falls back to JSON when expected SQLite schema errors occur', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return { get: vi.fn(() => ({ name: 'message' })) };
			}
			if (sql.includes('FROM message WHERE session_id = ?')) {
				return {
					all: vi.fn(() => {
						throw new Error('SQLITE_ERROR: no such table: part');
					}),
				};
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		const messages = await storage.readSessionMessages(projectPath, sessionId);

		expect(messages.messages.map((message) => message.content)).toEqual([
			'Implement auth',
			'Use a focused plan',
		]);
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Error loading messages from OpenCode SQLite'),
			'[OpenCodeSessionStorage]'
		);
	});

	it('falls back to JSON when SQLite message tables are unavailable', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return { get: vi.fn(() => undefined) };
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		const messages = await storage.readSessionMessages(projectPath, sessionId);

		expect(messages.total).toBe(2);
		expect(messages.messages[1].content).toBe('Use a focused plan');
	});

	it('reports unexpected SQLite message loading failures', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return { get: vi.fn(() => ({ name: 'message' })) };
			}
			if (sql.includes('FROM message WHERE session_id = ?')) {
				return {
					all: vi.fn(() => {
						throw new TypeError('message rows unreadable');
					}),
				};
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		await expect(storage.readSessionMessages(projectPath, sessionId)).rejects.toThrow(
			'message rows unreadable'
		);
		expect(mocks.logger.error).toHaveBeenCalledWith(
			expect.stringContaining('Unexpected error loading messages from OpenCode SQLite'),
			'[OpenCodeSessionStorage]'
		);
		expect(mocks.captureException).toHaveBeenCalledWith(expect.any(TypeError));
	});

	it('reports non-Error SQLite message loading failures', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return { get: vi.fn(() => ({ name: 'message' })) };
			}
			if (sql.includes('FROM message WHERE session_id = ?')) {
				return {
					all: vi.fn(() => {
						throw 'message table string failure';
					}),
				};
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		await expect(storage.readSessionMessages(projectPath, sessionId)).rejects.toBe(
			'message table string failure'
		);
		expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error));
	});

	it('reports unexpected SQLite failures instead of silently falling back', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return { get: vi.fn(() => ({ name: 'session' })) };
			}
			if (sql === 'SELECT id, worktree FROM project') {
				return {
					all: vi.fn(() => {
						throw new TypeError('corrupt project table');
					}),
				};
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		await expect(storage.listSessions(projectPath)).rejects.toThrow('corrupt project table');
		expect(mocks.logger.error).toHaveBeenCalledWith(
			expect.stringContaining('Unexpected error reading OpenCode SQLite database'),
			'[OpenCodeSessionStorage]'
		);
		expect(mocks.captureException).toHaveBeenCalledWith(expect.any(TypeError));
	});

	it('handles expected and unexpected non-Error SQLite listing failures distinctly', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						['session', 'project'].includes(tableName) ? { name: tableName } : undefined
					),
				};
			}
			if (sql === 'SELECT id, worktree FROM project') {
				return {
					all: vi.fn(() => {
						throw 'SQLITE_ERROR: no such table: project';
					}),
				};
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		await expect(storage.listSessions(projectPath)).resolves.toEqual([
			expect.objectContaining({ sessionId }),
		]);

		vi.clearAllMocks();
		setupLocalJsonStorage();
		storage = new OpenCodeSessionStorage();
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						['session', 'project'].includes(tableName) ? { name: tableName } : undefined
					),
				};
			}
			if (sql === 'SELECT id, worktree FROM project') {
				return {
					all: vi.fn(() => {
						throw 'corrupt project table string';
					}),
				};
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		await expect(storage.listSessions(projectPath)).rejects.toBe('corrupt project table string');
		expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error));
	});

	it('reports non-Error SQLite open failures', async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.databaseCtor.mockImplementationOnce(function MockDatabase() {
			throw 'open string failure';
		});

		await expect(storage.listSessions(projectPath)).rejects.toBe('open string failure');
		expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
			extra: { dbPath: expect.stringContaining('opencode.db') },
		});
	});

	it('uses the first SQLite user message when no assistant preview exists', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						['session', 'project', 'message', 'part'].includes(tableName)
							? { name: tableName }
							: undefined
					),
				};
			}
			if (sql === 'SELECT id, worktree FROM project') {
				return { all: vi.fn(() => [{ id: 'sqlite-project', worktree: projectPath }]) };
			}
			if (sql.includes('FROM session WHERE project_id IN')) {
				return {
					all: vi.fn(() => [
						{
							id: 'ses_user_preview',
							project_id: 'sqlite-project',
							directory: projectPath,
							title: 'Fallback title',
							version: '1.2.0',
							time_created: 1778493600000,
							time_updated: 1778493900000,
							summary_additions: null,
							summary_deletions: null,
							summary_files: null,
						},
					]),
				};
			}
			if (sql.includes('FROM message WHERE session_id IN')) {
				return {
					all: vi.fn(() => [
						{
							id: 'sqlite-user-only',
							session_id: 'ses_user_preview',
							time_created: 1778493600000,
							data: json({ role: 'user' }),
						},
					]),
				};
			}
			if (sql.includes('FROM part WHERE message_id IN')) {
				return {
					all: vi.fn(() => [
						{
							message_id: 'sqlite-user-only',
							data: json({ type: 'text', text: 'User preview text' }),
						},
					]),
				};
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions[0]).toEqual(
			expect.objectContaining({
				sessionId: 'ses_user_preview',
				firstMessage: 'User preview text',
				messageCount: 1,
			})
		);
	});

	it('uses the SQLite title when preview messages have no parts', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						['session', 'project', 'message', 'part'].includes(tableName)
							? { name: tableName }
							: undefined
					),
				};
			}
			if (sql === 'SELECT id, worktree FROM project') {
				return { all: vi.fn(() => [{ id: 'sqlite-project', worktree: projectPath }]) };
			}
			if (sql.includes('FROM session WHERE project_id IN')) {
				return {
					all: vi.fn(() => [
						{
							id: 'ses_no_part_preview',
							project_id: 'sqlite-project',
							directory: projectPath,
							title: 'Title fallback',
							version: '1.2.0',
							time_created: 1778493600000,
							time_updated: 1778493900000,
							summary_additions: null,
							summary_deletions: null,
							summary_files: null,
						},
					]),
				};
			}
			if (sql.includes('FROM message WHERE session_id IN')) {
				return {
					all: vi.fn(() => [
						{
							id: 'sqlite-assistant-no-parts',
							session_id: 'ses_no_part_preview',
							time_created: 1778493600000,
							data: json({ role: 'assistant' }),
						},
						{
							id: 'sqlite-user-no-parts',
							session_id: 'ses_no_part_preview',
							time_created: 1778493660000,
							data: json({ role: 'user' }),
						},
					]),
				};
			}
			if (sql.includes('FROM part WHERE message_id IN')) {
				return { all: vi.fn(() => []) };
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions[0]).toEqual(
			expect.objectContaining({
				sessionId: 'ses_no_part_preview',
				firstMessage: 'Title fallback',
				messageCount: 2,
			})
		);
	});

	it('uses JSON fallback when a SQLite session query is empty for an unknown session', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						['message', 'session'].includes(tableName) ? { name: tableName } : undefined
					),
				};
			}
			if (sql.includes('FROM message WHERE session_id = ?')) {
				return { all: vi.fn(() => []) };
			}
			if (sql === 'SELECT 1 FROM session WHERE id = ? LIMIT 1') {
				return { get: vi.fn(() => undefined) };
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		const messages = await storage.readSessionMessages(projectPath, sessionId);

		expect(messages.total).toBe(2);
		expect(messages.messages[0].uuid).toBe('msg-user');
	});

	it('returns an empty SQLite result without JSON fallback for known empty SQLite sessions', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						['message', 'session'].includes(tableName) ? { name: tableName } : undefined
					),
				};
			}
			if (sql.includes('FROM message WHERE session_id = ?')) {
				return { all: vi.fn(() => []) };
			}
			if (sql === 'SELECT 1 FROM session WHERE id = ? LIMIT 1') {
				return { get: vi.fn(() => ({ 1: 1 })) };
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		const messages = await storage.readSessionMessages(projectPath, 'ses_empty_sqlite');

		expect(messages).toEqual({ messages: [], total: 0, hasMore: false });
	});

	it('falls back to JSON when SQLite has messages but no session table for an empty result', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						tableName === 'message' ? { name: tableName } : undefined
					),
				};
			}
			if (sql.includes('FROM message WHERE session_id = ?')) {
				return { all: vi.fn(() => []) };
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		const messages = await storage.readSessionMessages(projectPath, sessionId);

		expect(messages.messages.map((message) => message.uuid)).toEqual(['msg-user', 'msg-assistant']);
	});

	it('loads SQLite messages with default roles, invalid parts, and missing optional fields', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						['message', 'part'].includes(tableName) ? { name: tableName } : undefined
					),
				};
			}
			if (sql.includes('FROM message WHERE session_id = ?')) {
				return {
					all: vi.fn(() => [
						{
							id: 'sqlite-default-role',
							session_id: 'ses_sqlite_defaults',
							time_created: 0,
							time_updated: 0,
							data: json({ tokens: { input: 0, output: 0 }, cost: 0 }),
						},
						{
							id: 'sqlite-empty-parts',
							session_id: 'ses_sqlite_defaults',
							time_created: 1778493720000,
							time_updated: 1778493720000,
							data: json({ role: 'assistant' }),
						},
					]),
				};
			}
			if (sql.includes('FROM part WHERE message_id = ?')) {
				return {
					all: vi.fn((messageId: string) =>
						messageId === 'sqlite-default-role'
							? [
									{ id: 'invalid-part', data: '{bad-json' },
									{ id: 'default-text-part', data: json({ text: 'Default role text' }) },
								]
							: []
					),
				};
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		const messages = await storage.readSessionMessages(projectPath, 'ses_sqlite_defaults');

		expect(messages).toEqual({
			messages: [
				expect.objectContaining({
					type: 'user',
					content: 'Default role text',
					timestamp: '',
					uuid: 'sqlite-default-role',
				}),
			],
			total: 1,
			hasMore: false,
		});
	});

	it('returns empty SQLite messages when the part table is absent', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						tableName === 'message' ? { name: tableName } : undefined
					),
				};
			}
			if (sql.includes('FROM message WHERE session_id = ?')) {
				return {
					all: vi.fn(() => [
						{
							id: 'sqlite-no-part-table',
							session_id: 'ses_no_part_table',
							time_created: 1778493600000,
							time_updated: 1778493600000,
							data: json({ role: 'assistant' }),
						},
					]),
				};
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		await expect(storage.readSessionMessages(projectPath, 'ses_no_part_table')).resolves.toEqual({
			messages: [],
			total: 0,
			hasMore: false,
		});
	});

	it('deduplicates JSON sessions when SQLite already reports the same session id', async () => {
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						['session', 'project'].includes(tableName) ? { name: tableName } : undefined
					),
				};
			}
			if (sql === 'SELECT id, worktree FROM project') {
				return { all: vi.fn(() => [{ id: projectId, worktree: projectPath }]) };
			}
			if (sql.includes('FROM session WHERE project_id IN')) {
				return {
					all: vi.fn(() => [
						{
							id: sessionId,
							project_id: projectId,
							directory: projectPath,
							title: 'SQLite authoritative title',
							version: '1.2.0',
							time_created: 1778493600000,
							time_updated: 1778494000000,
							summary_additions: null,
							summary_deletions: null,
							summary_files: null,
						},
					]),
				};
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions.map((session) => session.sessionId)).toEqual([sessionId]);
		expect(sessions[0].firstMessage).toBe('SQLite authoritative title');
	});

	it('summarizes sparse SQLite message rows without global session matches', async () => {
		localDirs[projectDir] = [];
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						['session', 'project', 'message', 'part'].includes(tableName)
							? { name: tableName }
							: undefined
					),
				};
			}
			if (sql === 'SELECT id, worktree FROM project') {
				return {
					all: vi.fn(() => [
						{ id: 'sqlite-project', worktree: projectPath },
						{ id: 'global', worktree: '/' },
					]),
				};
			}
			if (sql.includes('FROM session WHERE project_id IN')) {
				return {
					all: vi.fn(() => [
						{
							id: 'ses_sparse_summary',
							project_id: 'sqlite-project',
							directory: projectPath,
							title: '',
							version: '1.2.0',
							time_created: 1778493600000,
							time_updated: 1778493900000,
							summary_additions: null,
							summary_deletions: null,
							summary_files: null,
						},
					]),
				};
			}
			if (sql.includes("FROM session WHERE project_id = 'global'")) {
				return { all: vi.fn(() => []) };
			}
			if (sql.includes('FROM message WHERE session_id IN')) {
				return {
					all: vi.fn(() => [
						{
							id: 'sparse-user',
							session_id: 'ses_sparse_summary',
							time_created: 0,
							data: json({ role: 'user', tokens: { input: 1 }, cost: 0 }),
						},
						{
							id: 'sparse-assistant',
							session_id: 'ses_sparse_summary',
							time_created: 1778493720000,
							data: json({ role: 'assistant', tokens: { output: 2 }, cost: 0 }),
						},
					]),
				};
			}
			if (sql.includes('FROM part WHERE message_id IN')) {
				return {
					all: vi.fn(() => [
						{ message_id: 'sparse-user', data: json({ type: 'tool', text: 'ignored user tool' }) },
						{
							message_id: 'sparse-assistant',
							data: json({ type: 'tool', text: 'ignored assistant tool' }),
						},
					]),
				};
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: 'ses_sparse_summary',
				firstMessage: '',
				messageCount: 2,
				cacheReadTokens: 0,
				durationSeconds: 0,
			}),
		]);
	});

	it('ignores duplicate SQLite global rows and handles untitled schema-only rows', async () => {
		localDirs[projectDir] = [];
		setupSqliteDatabaseWithPrepare((sql) => {
			if (sql.includes('sqlite_master')) {
				return {
					get: vi.fn((tableName: string) =>
						['session', 'project'].includes(tableName) ? { name: tableName } : undefined
					),
				};
			}
			if (sql === 'SELECT id, worktree FROM project') {
				return {
					all: vi.fn(() => [
						{ id: 'sqlite-project', worktree: projectPath },
						{ id: 'global', worktree: '/' },
					]),
				};
			}
			if (sql.includes('FROM session WHERE project_id IN')) {
				return {
					all: vi.fn(() => [
						{
							id: 'ses_duplicate_global',
							project_id: 'sqlite-project',
							directory: projectPath,
							title: '',
							version: '1.2.0',
							time_created: 1778493600000,
							time_updated: 1778493900000,
							summary_additions: null,
							summary_deletions: null,
							summary_files: null,
						},
					]),
				};
			}
			if (sql.includes("FROM session WHERE project_id = 'global'")) {
				return {
					all: vi.fn(() => [
						{
							id: 'ses_duplicate_global',
							project_id: 'global',
							directory: projectPath,
							title: 'Duplicate global',
							version: '1.2.0',
							time_created: 1778493600000,
							time_updated: 1778493950000,
							summary_additions: null,
							summary_deletions: null,
							summary_files: null,
						},
					]),
				};
			}
			throw new Error(`Unexpected SQLite query: ${sql}`);
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: 'ses_duplicate_global',
				firstMessage: '',
				messageCount: 0,
			}),
		]);
	});

	it('deletes a local JSON message pair, associated parts, and orphaned tool references', async () => {
		addFile(
			path.join(messageDir, 'msg-next-user.json'),
			message('msg-next-user', 'user', 1778493900000)
		);
		addFile(
			path.join(messageDir, 'msg-next-empty-user.json'),
			message('msg-next-empty-user', 'user', 1778493950000)
		);
		addFile(path.join(partDir('msg-next-user'), 'part-next-user.json'), {
			...part('part-next-user', 'msg-next-user', 'text'),
			text: 'Keep this',
		});
		addFile(path.join(partDir('msg-next-user'), 'orphan-tool.json'), {
			...part('orphan-tool', 'msg-next-user', 'tool'),
			state: { input: { previousTool: 'tool-1' } },
		});
		addFile(path.join(partDir('msg-next-user'), 'unrelated-tool.json'), {
			...part('unrelated-tool', 'msg-next-user', 'tool'),
			state: { input: { previousTool: 'tool-2' } },
		});

		const result = await storage.deleteMessagePair(projectPath, sessionId, 'msg-user');

		expect(result.success).toBe(true);
		expect(fs.unlink).toHaveBeenCalledWith(path.join(messageDir, 'msg-user.json'));
		expect(fs.unlink).toHaveBeenCalledWith(path.join(messageDir, 'msg-assistant.json'));
		expect(fs.unlink).toHaveBeenCalledWith(path.join(partDir('msg-assistant'), 'tool-1.json'));
		expect(fs.unlink).toHaveBeenCalledWith(path.join(partDir('msg-next-user'), 'orphan-tool.json'));
		expect(fs.unlink).not.toHaveBeenCalledWith(
			path.join(partDir('msg-next-user'), 'unrelated-tool.json')
		);
		expect(fs.unlink).not.toHaveBeenCalledWith(path.join(messageDir, 'msg-next-user.json'));
		expect(result.linesRemoved).toBeGreaterThanOrEqual(4);
	});

	it('deletes a final user message without tool cleanup work', async () => {
		localFiles = {};
		localDirs = {};
		addFile(path.join(projectDir, `${projectId}.json`), {
			id: projectId,
			worktree: projectPath,
		});
		addFile(path.join(sessionDir, `${sessionId}.json`), {
			id: sessionId,
			projectID: projectId,
			directory: projectPath,
			title: 'Single user',
		});
		addFile(path.join(messageDir, 'msg-lone-user.json'), message('msg-lone-user', 'user', 0));
		addFile(path.join(partDir('msg-lone-user'), 'lone-text.json'), {
			...part('lone-text', 'msg-lone-user', 'text'),
			text: 'Only turn',
		});

		const result = await storage.deleteMessagePair(projectPath, sessionId, 'msg-lone-user');

		expect(result).toEqual({ success: true, linesRemoved: 2 });
		expect(mocks.logger.info).not.toHaveBeenCalledWith(
			'Cleaned up tool parts in OpenCode session',
			'[OpenCodeSessionStorage]',
			expect.anything()
		);
	});

	it('returns a fallback deletion miss when candidate user messages have no parts', async () => {
		localFiles = {};
		localDirs = {};
		addFile(path.join(projectDir, `${projectId}.json`), {
			id: projectId,
			worktree: projectPath,
		});
		addFile(path.join(sessionDir, `${sessionId}.json`), {
			id: sessionId,
			projectID: projectId,
			directory: projectPath,
			title: 'No parts',
		});
		addFile(
			path.join(messageDir, 'msg-no-parts-user.json'),
			message('msg-no-parts-user', 'user', 0)
		);

		await expect(
			storage.deleteMessagePair(projectPath, sessionId, 'unknown', 'Missing content')
		).resolves.toEqual({ success: false, error: 'User message not found' });
	});

	it('deletes a user and following assistant even when the assistant has no part directory', async () => {
		localFiles = {};
		localDirs = {};
		addFile(path.join(projectDir, `${projectId}.json`), {
			id: projectId,
			worktree: projectPath,
		});
		addFile(path.join(sessionDir, `${sessionId}.json`), {
			id: sessionId,
			projectID: projectId,
			directory: projectPath,
			title: 'No assistant parts',
		});
		addFile(path.join(messageDir, 'msg-delete-user.json'), message('msg-delete-user', 'user', 0));
		addFile(
			path.join(messageDir, 'msg-delete-assistant.json'),
			message('msg-delete-assistant', 'assistant', 1)
		);
		addFile(path.join(partDir('msg-delete-user'), 'user-text.json'), {
			...part('user-text', 'msg-delete-user', 'text'),
			text: 'Delete user',
		});

		const result = await storage.deleteMessagePair(projectPath, sessionId, 'msg-delete-user');

		expect(result).toEqual({ success: true, linesRemoved: 3 });
		expect(fs.unlink).toHaveBeenCalledWith(path.join(messageDir, 'msg-delete-assistant.json'));
	});

	it('supports fallback-content deletion and missing-message failures', async () => {
		const deleted = await storage.deleteMessagePair(
			projectPath,
			sessionId,
			'unknown',
			'Implement auth'
		);
		const missing = await storage.deleteMessagePair(projectPath, sessionId, 'unknown');

		expect(deleted.success).toBe(true);
		expect(missing).toEqual({ success: false, error: 'User message not found' });
	});

	it('rejects JSON deletion when a session has no messages', async () => {
		localDirs[messageDir] = [];

		const result = await storage.deleteMessagePair(projectPath, sessionId, 'msg-user');

		expect(result).toEqual({ success: false, error: 'No messages found in session' });
	});

	it('reports unexpected local deletion failures', async () => {
		const error = new Error('database open refused');
		mocks.existsSync.mockReturnValue(true);
		mocks.databaseCtor.mockImplementationOnce(function MockDatabase() {
			throw error;
		});

		const result = await storage.deleteMessagePair(projectPath, sessionId, 'msg-user');

		expect(result).toEqual({ success: false, error: String(error) });
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'Error deleting message pair from OpenCode session',
			'[OpenCodeSessionStorage]',
			expect.objectContaining({ sessionId, error })
		);
		expect(mocks.captureException).toHaveBeenCalledWith(error, {
			operation: 'opencodeStorage:deleteMessagePair',
			sessionId,
		});
	});

	it('rejects remote deletion and resolves local or remote session paths', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;

		expect(storage.getSessionPath(projectPath, sessionId)).toBe(messageDir);
		expect(storage.getSessionPath(projectPath, sessionId, sshConfig)).toBe(
			`~/.local/share/opencode/storage/message/${sessionId}`
		);
		await expect(
			storage.deleteMessagePair(projectPath, sessionId, 'msg-user', undefined, sshConfig)
		).resolves.toEqual({ success: false, error: 'Delete not supported for remote sessions' });
	});

	it('lists and reads remote JSON sessions through SSH utilities', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const remoteSessionDir = `${remoteStorageDir}/session/${projectId}`;
		const remoteMessageDir = `${remoteStorageDir}/message/${sessionId}`;
		const remoteUserPartDir = `${remoteStorageDir}/part/msg-user`;
		const remoteAssistantPartDir = `${remoteStorageDir}/part/msg-assistant`;
		mocks.readDirRemote.mockImplementation(async (target: string) => {
			if (target === remoteProjectDir)
				return remoteDir([{ name: `${projectId}.json`, isDirectory: false }]);
			if (target === remoteSessionDir)
				return remoteDir([{ name: `${sessionId}.json`, isDirectory: false }]);
			if (target === remoteMessageDir) {
				return remoteDir([
					{ name: 'msg-user.json', isDirectory: false },
					{ name: 'msg-assistant.json', isDirectory: false },
				]);
			}
			if (target === remoteUserPartDir)
				return remoteDir([{ name: 'part-user.json', isDirectory: false }]);
			if (target === remoteAssistantPartDir) {
				return remoteDir([{ name: 'part-assistant.json', isDirectory: false }]);
			}
			return { success: false };
		});
		mocks.readFileRemote.mockImplementation(async (target: string) => {
			if (target === `${remoteProjectDir}/${projectId}.json`) {
				return { success: true, data: json({ id: projectId, worktree: projectPath }) };
			}
			if (target === `${remoteSessionDir}/${sessionId}.json`) {
				return {
					success: true,
					data: json({
						id: sessionId,
						projectID: projectId,
						directory: projectPath,
						title: 'Remote session',
						time: { created: 1778493600000, updated: 1778493900000 },
					}),
				};
			}
			if (target === `${remoteMessageDir}/msg-user.json`) {
				return {
					success: true,
					data: json(
						message('msg-user', 'user', 1778493600000, {
							tokens: { input: 7, cache: { read: 2, write: 3 } },
							cost: 0.04,
						})
					),
				};
			}
			if (target === `${remoteMessageDir}/msg-assistant.json`) {
				return {
					success: true,
					data: json(
						message('msg-assistant', 'assistant', 1778493720000, {
							tokens: { output: 11, cache: { read: 5 } },
							cost: 0.06,
						})
					),
				};
			}
			if (target === `${remoteUserPartDir}/part-user.json`) {
				return {
					success: true,
					data: json({ ...part('part-user', 'msg-user', 'text'), text: 'Remote user' }),
				};
			}
			if (target === `${remoteAssistantPartDir}/part-assistant.json`) {
				return {
					success: true,
					data: json({
						...part('part-assistant', 'msg-assistant', 'text'),
						text: 'Remote assistant',
					}),
				};
			}
			return { success: false };
		});
		mocks.statRemote.mockResolvedValue({ success: true, data: { size: 1234 } });

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
			firstMessage: 'Remote assistant',
			sizeBytes: 1234,
			costUsd: 0.1,
			inputTokens: 7,
			outputTokens: 11,
			cacheReadTokens: 7,
			cacheCreationTokens: 3,
			durationSeconds: 120,
		});
		expect(messages.messages.map((message) => message.content)).toEqual([
			'Remote user',
			'Remote assistant',
		]);
	});

	it('uses remote title and timestamp fallbacks when remote messages are malformed or empty', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const remoteSessionDir = `${remoteStorageDir}/session/${projectId}`;
		const remoteMessageDir = `${remoteStorageDir}/message/ses_remote_empty`;
		const remotePartDir = `${remoteStorageDir}/part/remote-empty-message`;
		mocks.readDirRemote.mockImplementation(async (target: string) => {
			if (target === remoteProjectDir)
				return remoteDir([{ name: `${projectId}.json`, isDirectory: false }]);
			if (target === remoteSessionDir)
				return remoteDir([{ name: 'ses_remote_empty.json', isDirectory: false }]);
			if (target === remoteMessageDir) {
				return remoteDir([
					{ name: 'broken.json', isDirectory: false },
					{ name: 'remote-empty-user.json', isDirectory: false },
					{ name: 'remote-empty-message.json', isDirectory: false },
				]);
			}
			if (target === remotePartDir) {
				return remoteDir([
					{ name: 'broken-part.json', isDirectory: false },
					{ name: 'blank-part.json', isDirectory: false },
				]);
			}
			return { success: false };
		});
		mocks.readFileRemote.mockImplementation(async (target: string) => {
			if (target === `${remoteProjectDir}/${projectId}.json`) {
				return { success: true, data: json({ id: projectId, worktree: projectPath }) };
			}
			if (target === `${remoteSessionDir}/ses_remote_empty.json`) {
				return {
					success: true,
					data: json({
						id: 'ses_remote_empty',
						projectID: projectId,
						directory: projectPath,
					}),
				};
			}
			if (target === `${remoteMessageDir}/broken.json`) {
				return { success: true, data: '{bad-json' };
			}
			if (target === `${remoteMessageDir}/remote-empty-user.json`) {
				return {
					success: true,
					data: json(
						message('remote-empty-user', 'user', 0, {
							time: undefined,
						})
					),
				};
			}
			if (target === `${remoteMessageDir}/remote-empty-message.json`) {
				return {
					success: true,
					data: json(
						message('remote-empty-message', 'assistant', 0, {
							time: undefined,
							tokens: { input: 0, output: 0 },
							cost: 0,
						})
					),
				};
			}
			if (target === `${remotePartDir}/broken-part.json`) {
				return { success: true, data: '{bad-json' };
			}
			if (target === `${remotePartDir}/blank-part.json`) {
				return {
					success: true,
					data: json({ ...part('blank-part', 'remote-empty-message', 'text'), text: '' }),
				};
			}
			return { success: false };
		});
		mocks.statRemote.mockResolvedValue({ success: true, data: { size: 99 } });

		const sessions = await storage.listSessions(projectPath, sshConfig);
		const messages = await storage.readSessionMessages(
			projectPath,
			'ses_remote_empty',
			undefined,
			sshConfig
		);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: 'ses_remote_empty',
				firstMessage: '',
				messageCount: 2,
				durationSeconds: 0,
				sizeBytes: 99,
			}),
		]);
		expect(sessions[0].modifiedAt).toBe(sessions[0].timestamp);
		expect(messages).toEqual({ messages: [], total: 0, hasMore: false });
	});

	it('extracts searchable messages directly for local and remote sessions', async () => {
		const searchableStorage = new TestableOpenCodeSessionStorage();

		await expect(
			searchableStorage.readSearchableMessagesForTest(sessionId, projectPath)
		).resolves.toEqual([
			{ role: 'user', textContent: 'Implement auth' },
			{ role: 'assistant', textContent: 'Use a focused plan' },
		]);

		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const remoteMessageDir = `${remoteStorageDir}/message/ses_remote_search`;
		mocks.readDirRemote.mockImplementation(async (target: string) => {
			if (target === remoteMessageDir)
				return remoteDir([{ name: 'remote-search-user.json', isDirectory: false }]);
			return { success: false };
		});
		mocks.readFileRemote.mockImplementation(async (target: string) => {
			if (target === `${remoteMessageDir}/remote-search-user.json`) {
				return {
					success: true,
					data: json(message('remote-search-user', 'user', 1778493600000)),
				};
			}
			return { success: false };
		});

		await expect(
			searchableStorage.readSearchableMessagesForTest('ses_remote_search', projectPath, sshConfig)
		).resolves.toEqual([]);
	});

	it('uses local hash project ids while skipping invalid JSON and non-message roles', async () => {
		const hashedId = createHash('sha1').update(projectPath).digest('hex');
		const hashedSessionDir = path.join(storageDir, 'session', hashedId);
		const hashedSessionFile = path.join(hashedSessionDir, `${sessionId}.json`);
		localDirs[projectDir] = [];
		addFile(path.join(projectDir, 'invalid.json'), { id: 'invalid' });
		addFile(path.join(projectDir, `${hashedId}.json`), { id: hashedId });
		addFile(hashedSessionFile, {
			id: sessionId,
			projectID: hashedId,
			directory: projectPath,
			title: 'Hashed session',
			time: { created: 1778493600000, updated: 1778493900000 },
		});
		addFile(path.join(hashedSessionDir, 'broken.json'), '{bad-json');
		addFile(path.join(messageDir, 'msg-system.json'), {
			id: 'msg-system',
			sessionID: sessionId,
			role: 'system',
			time: { created: 1778493660000 },
		});
		addFile(path.join(partDir('msg-system'), 'part-system.json'), {
			id: 'part-system',
			messageID: 'msg-system',
			type: 'text',
			text: 'Hidden system prompt',
		});
		vi.mocked(fs.stat).mockImplementation(async (target: string) => {
			if (target === hashedSessionFile) {
				throw new Error('stat denied');
			}
			if (localFiles[target]) {
				return { size: Buffer.byteLength(localFiles[target]) } as Awaited<
					ReturnType<typeof fs.stat>
				>;
			}
			throw new Error(`missing stat ${target}`);
		});

		const sessions = await storage.listSessions(projectPath);
		const messages = await storage.readSessionMessages(projectPath, sessionId);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId,
				firstMessage: 'Use a focused plan',
				messageCount: 2,
				sizeBytes: 0,
			}),
		]);
		expect(messages.messages.map((message) => message.content)).toEqual([
			'Implement auth',
			'Use a focused plan',
		]);
	});

	it('matches local project metadata by parent worktree and falls back to session titles', async () => {
		localFiles = {};
		localDirs = {};
		addFile(path.join(projectDir, `${projectId}.json`), {
			id: projectId,
			worktree: '/repo',
		});
		addFile(path.join(sessionDir, 'ses_title.json'), {
			id: 'ses_title',
			projectID: projectId,
			directory: projectPath,
			title: 'Title fallback',
			time: { created: 1778493600000, updated: 1778493900000 },
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: 'ses_title',
				firstMessage: 'Title fallback',
				messageCount: 0,
			}),
		]);
	});

	it('uses empty local previews and current timestamps when JSON sessions lack title and time', async () => {
		localFiles = {};
		localDirs = {};
		addFile(path.join(projectDir, `${projectId}.json`), {
			id: projectId,
			worktree: projectPath,
		});
		addFile(path.join(sessionDir, 'ses_no_title_time.json'), {
			id: 'ses_no_title_time',
			projectID: projectId,
			directory: projectPath,
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: 'ses_no_title_time',
				firstMessage: '',
				messageCount: 0,
				durationSeconds: 0,
			}),
		]);
		expect(sessions[0].modifiedAt).toBe(sessions[0].timestamp);
	});

	it('keeps local JSON duration at zero when all message timestamps are missing', async () => {
		localFiles = {};
		localDirs = {};
		addFile(path.join(projectDir, `${projectId}.json`), {
			id: projectId,
			worktree: projectPath,
		});
		addFile(path.join(sessionDir, 'ses_missing_message_times.json'), {
			id: 'ses_missing_message_times',
			projectID: projectId,
			directory: projectPath,
			title: 'Missing message times',
			time: { created: 1778493600000, updated: 1778493900000 },
		});
		const missingTimeMessageDir = path.join(storageDir, 'message', 'ses_missing_message_times');
		addFile(path.join(missingTimeMessageDir, 'msg-no-time-user.json'), {
			id: 'msg-no-time-user',
			sessionID: 'ses_missing_message_times',
			role: 'user',
		});
		addFile(path.join(missingTimeMessageDir, 'msg-no-time-assistant.json'), {
			id: 'msg-no-time-assistant',
			sessionID: 'ses_missing_message_times',
			role: 'assistant',
		});

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: 'ses_missing_message_times',
				firstMessage: 'Missing message times',
				messageCount: 2,
				durationSeconds: 0,
			}),
		]);
	});

	it('returns no local JSON sessions when session metadata files are malformed', async () => {
		localFiles = {};
		localDirs = {};
		addFile(path.join(projectDir, `${projectId}.json`), {
			id: projectId,
			worktree: projectPath,
		});
		addFile(path.join(sessionDir, 'broken-session.json'), '{bad-json');

		await expect(storage.listSessions(projectPath)).resolves.toEqual([]);
	});

	it('filters remote global sessions and tolerates malformed remote JSON', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const globalSessionDir = `${remoteStorageDir}/session/global`;
		mocks.readDirRemote.mockImplementation(async (target: string) => {
			if (target === remoteProjectDir) {
				return remoteDir([
					{ name: 'global.json', isDirectory: false },
					{ name: 'bad-project.json', isDirectory: false },
					{ name: 'missing-project.json', isDirectory: false },
				]);
			}
			if (target === globalSessionDir) {
				return remoteDir([
					{ name: 'exact.json', isDirectory: false },
					{ name: 'child.json', isDirectory: false },
					{ name: 'missing-dir.json', isDirectory: false },
					{ name: 'other.json', isDirectory: false },
					{ name: 'broken.json', isDirectory: false },
					{ name: 'nested', isDirectory: true },
				]);
			}
			return remoteDir([]);
		});
		mocks.readFileRemote.mockImplementation(async (target: string) => {
			if (target === `${remoteProjectDir}/bad-project.json`) {
				return { success: true, data: '{bad-json' };
			}
			if (target === `${remoteProjectDir}/missing-project.json`) {
				return { success: false };
			}
			if (target === `${globalSessionDir}/exact.json`) {
				return {
					success: true,
					data: json({
						id: 'ses_remote_exact',
						projectID: 'global',
						directory: projectPath,
						title: 'Exact remote',
						time: { created: 1778493600000, updated: 1778493700000 },
					}),
				};
			}
			if (target === `${globalSessionDir}/child.json`) {
				return {
					success: true,
					data: json({
						id: 'ses_remote_child',
						projectID: 'global',
						directory: `${projectPath}/child`,
						title: 'Child remote',
						time: { created: 1778493600000, updated: 1778493900000 },
					}),
				};
			}
			if (target === `${globalSessionDir}/missing-dir.json`) {
				return {
					success: true,
					data: json({
						id: 'ses_remote_missing_dir',
						projectID: 'global',
						title: 'Missing directory',
						time: { created: 1778493600000, updated: 1778493950000 },
					}),
				};
			}
			if (target === `${globalSessionDir}/other.json`) {
				return {
					success: true,
					data: json({
						id: 'ses_remote_other',
						projectID: 'global',
						directory: '/other/project',
						title: 'Other remote',
						time: { created: 1778493600000, updated: 1778494000000 },
					}),
				};
			}
			if (target === `${globalSessionDir}/broken.json`) {
				return { success: true, data: '{bad-json' };
			}
			return { success: false };
		});
		mocks.statRemote.mockResolvedValue({ success: false });

		const sessions = await storage.listSessions(projectPath, sshConfig);

		expect(sessions.map((session) => session.sessionId)).toEqual([
			'ses_remote_child',
			'ses_remote_exact',
		]);
		expect(sessions.map((session) => session.firstMessage)).toEqual([
			'Child remote',
			'Exact remote',
		]);
	});

	it('uses remote hash project ids and handles empty remote session directories', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const hashedId = createHash('sha1').update(projectPath).digest('hex');
		const hashedSessionDir = `${remoteStorageDir}/session/${hashedId}`;
		mocks.readDirRemote.mockImplementation(async (target: string) => {
			if (target === remoteProjectDir) {
				return remoteDir([{ name: 'other.json', isDirectory: false }]);
			}
			if (target === hashedSessionDir) {
				return remoteDir([{ name: 'hashed.json', isDirectory: false }]);
			}
			return remoteDir([]);
		});
		mocks.readFileRemote.mockImplementation(async (target: string) => {
			if (target === `${remoteProjectDir}/other.json`) {
				return { success: true, data: json({ id: 'other', worktree: '/other/project' }) };
			}
			if (target === `${hashedSessionDir}/hashed.json`) {
				return {
					success: true,
					data: json({
						id: 'ses_remote_hash',
						projectID: hashedId,
						directory: projectPath,
						title: 'Hashed remote',
						time: { created: 1778493600000, updated: 1778493900000 },
					}),
				};
			}
			return { success: false };
		});
		mocks.statRemote.mockImplementation(async (target: string) => ({
			success: target === `${remoteProjectDir}/${hashedId}.json`,
			data: target === `${hashedSessionDir}/hashed.json` ? { size: 42 } : undefined,
		}));

		const sessions = await storage.listSessions(projectPath, sshConfig);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: 'ses_remote_hash',
				firstMessage: 'Hashed remote',
			}),
		]);
	});

	it('matches remote project metadata by parent worktree before hash fallback', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const remoteSessionDir = `${remoteStorageDir}/session/${projectId}`;
		mocks.readDirRemote.mockImplementation(async (target: string) => {
			if (target === remoteProjectDir) {
				return remoteDir([{ name: `${projectId}.json`, isDirectory: false }]);
			}
			if (target === remoteSessionDir) {
				return remoteDir([{ name: 'parent.json', isDirectory: false }]);
			}
			return remoteDir([]);
		});
		mocks.readFileRemote.mockImplementation(async (target: string) => {
			if (target === `${remoteProjectDir}/${projectId}.json`) {
				return { success: true, data: json({ id: projectId, worktree: '/repo' }) };
			}
			if (target === `${remoteSessionDir}/parent.json`) {
				return {
					success: true,
					data: json({
						id: 'ses_remote_parent',
						projectID: projectId,
						directory: projectPath,
						title: 'Remote parent',
						time: { created: 1778493600000, updated: 1778493900000 },
					}),
				};
			}
			return { success: false };
		});
		mocks.statRemote.mockResolvedValue({ success: false });

		const sessions = await storage.listSessions(projectPath, sshConfig);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: 'ses_remote_parent',
				firstMessage: 'Remote parent',
			}),
		]);
	});

	it('returns no remote sessions when the remote session directory cannot be listed', async () => {
		const sshConfig = { id: 'remote-1' } as SshRemoteConfig;
		const remoteSessionDir = `${remoteStorageDir}/session/${projectId}`;
		mocks.readDirRemote.mockImplementation(async (target: string) => {
			if (target === remoteProjectDir) {
				return remoteDir([{ name: `${projectId}.json`, isDirectory: false }]);
			}
			if (target === remoteSessionDir) {
				throw new Error('remote directory denied');
			}
			return remoteDir([]);
		});
		mocks.readFileRemote.mockImplementation(async (target: string) => {
			if (target === `${remoteProjectDir}/${projectId}.json`) {
				return { success: true, data: json({ id: projectId, worktree: projectPath }) };
			}
			return { success: false };
		});

		await expect(storage.listSessions(projectPath, sshConfig)).resolves.toEqual([]);
	});

	it('returns empty lists when local or remote project metadata is missing', async () => {
		localDirs[projectDir] = [];
		mocks.readDirRemote.mockResolvedValue({ success: false });

		await expect(storage.listSessions(projectPath)).resolves.toEqual([]);
		await expect(
			storage.listSessions(projectPath, { id: 'remote-1' } as SshRemoteConfig)
		).resolves.toEqual([]);
	});

	it('returns no local sessions when the OpenCode project directory is missing', async () => {
		localFiles = {};
		localDirs = {};

		await expect(storage.listSessions(projectPath)).resolves.toEqual([]);
		expect(mocks.logger.info).toHaveBeenCalledWith(
			expect.stringContaining('OpenCode project directory not found'),
			'[OpenCodeSessionStorage]'
		);
	});

	it('prefers the XDG-style OpenCode data path on Windows', async () => {
		const originalAppData = process.env.APPDATA;
		try {
			process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
			mocks.existsSync.mockReturnValue(false);
			vi.resetModules();
			vi.doMock('../../../shared/platformDetection', () => ({
				isWindows: vi.fn(() => true),
			}));

			const { OpenCodeSessionStorage: WindowsOpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const windowsStorage = new WindowsOpenCodeSessionStorage();

			expect(windowsStorage.getSessionPath('C:\\repo\\project', 'ses_win')).toBe(
				path.join(mocks.homeDir, '.local', 'share', 'opencode', 'storage', 'message', 'ses_win')
			);
		} finally {
			if (originalAppData === undefined) {
				delete process.env.APPDATA;
			} else {
				process.env.APPDATA = originalAppData;
			}
			vi.doMock('../../../shared/platformDetection', () => ({
				isWindows: vi.fn(() => false),
			}));
		}
	});

	it('uses the XDG-style OpenCode data path when Windows APPDATA is unavailable', async () => {
		const originalAppData = process.env.APPDATA;
		try {
			delete process.env.APPDATA;
			mocks.existsSync.mockReturnValue(false);
			vi.resetModules();
			vi.doMock('../../../shared/platformDetection', () => ({
				isWindows: vi.fn(() => true),
			}));

			const { OpenCodeSessionStorage: WindowsOpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const windowsStorage = new WindowsOpenCodeSessionStorage();

			expect(windowsStorage.getSessionPath('C:\\repo\\project', 'ses_win')).toBe(
				path.join(mocks.homeDir, '.local', 'share', 'opencode', 'storage', 'message', 'ses_win')
			);
		} finally {
			if (originalAppData === undefined) {
				delete process.env.APPDATA;
			} else {
				process.env.APPDATA = originalAppData;
			}
			vi.doMock('../../../shared/platformDetection', () => ({
				isWindows: vi.fn(() => false),
			}));
		}
	});
});
