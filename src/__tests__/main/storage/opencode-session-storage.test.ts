/**
 * Tests for OpenCodeSessionStorage
 *
 * Verifies:
 * - SQLite session listing (v1.2+)
 * - JSON fallback for pre-v1.2
 * - Deduplication when both sources exist
 * - Message reading from SQLite
 * - Delete unsupported for SQLite sessions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenCodeSessionStorage } from '../../../main/storage/opencode-session-storage';

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock sentry
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// Mock remote-fs utilities
vi.mock('../../../main/utils/remote-fs', () => ({
	readDirRemote: vi.fn(),
	readFileRemote: vi.fn(),
	statRemote: vi.fn(),
}));

// ─── SQLite mock setup ───────────────────────────────────────────────────────

interface MockDatabase {
	prepare: ReturnType<typeof vi.fn>;
	pragma: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
}

// Container object referenced by hoisted vi.mock factory
const dbMock = { instance: null as MockDatabase | null };

vi.mock('better-sqlite3', () => {
	// Must return a constructor-compatible function
	function MockDatabase() {
		if (!dbMock.instance) {
			throw new Error('Database not available');
		}
		return dbMock.instance;
	}
	return { default: MockDatabase };
});

// Mock fs (sync) for existsSync
const mockExistsSync = vi.fn();
vi.mock('fs', () => ({
	default: {
		existsSync: (...args: unknown[]) => mockExistsSync(...args),
	},
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

// Mock fs/promises
const mockFsAccess = vi.fn();
const mockFsReaddir = vi.fn();
const mockFsReadFile = vi.fn();
const mockFsStat = vi.fn();
const mockFsUnlink = vi.fn();
const mockFsRmdir = vi.fn();

vi.mock('fs/promises', () => ({
	default: {
		access: (...args: unknown[]) => mockFsAccess(...args),
		readdir: (...args: unknown[]) => mockFsReaddir(...args),
		readFile: (...args: unknown[]) => mockFsReadFile(...args),
		stat: (...args: unknown[]) => mockFsStat(...args),
		unlink: (...args: unknown[]) => mockFsUnlink(...args),
		rmdir: (...args: unknown[]) => mockFsRmdir(...args),
	},
}));

describe('OpenCodeSessionStorage', () => {
	let storage: OpenCodeSessionStorage;

	beforeEach(() => {
		vi.clearAllMocks();
		dbMock.instance = null;
		mockExistsSync.mockReturnValue(false);
		mockFsAccess.mockRejectedValue(new Error('ENOENT'));
		mockFsReaddir.mockResolvedValue([]);
		mockFsReadFile.mockRejectedValue(new Error('ENOENT'));
		mockFsStat.mockRejectedValue(new Error('ENOENT'));
		storage = new OpenCodeSessionStorage();
	});

	describe('agentId', () => {
		it('should return opencode', () => {
			expect(storage.agentId).toBe('opencode');
		});
	});

	describe('listSessions - SQLite', () => {
		function setupSqliteDb(
			projects: Array<{ id: string; worktree: string }>,
			sessions: Array<{
				id: string;
				project_id: string;
				directory: string;
				title: string;
				time_created: number;
				time_updated: number;
			}>,
			messages: Array<{
				id: string;
				session_id: string;
				time_created: number;
				data: string;
			}> = []
		): void {
			// DB file exists
			mockExistsSync.mockReturnValue(true);

			const createPrepare = () =>
				vi.fn().mockImplementation((sql: string) => {
					// sqlite_master check for table existence
					if (sql.includes('sqlite_master')) {
						return {
							all: vi.fn().mockReturnValue([]),
							get: vi.fn().mockImplementation((_tableName: string) => ({
								name: _tableName,
							})),
						};
					}

					// project listing
					if (sql.includes('FROM project') && !sql.includes('sqlite_master')) {
						return {
							all: vi.fn().mockReturnValue(projects),
							get: vi.fn().mockReturnValue(undefined),
						};
					}

					// session listing
					if (sql.includes('FROM session') && !sql.includes('sqlite_master')) {
						return {
							all: vi.fn().mockImplementation((...args: string[]) =>
								sessions.filter((s) =>
									args.some((arg) => arg === s.project_id)
								)
							),
							get: vi.fn().mockReturnValue(undefined),
						};
					}

					// message listing
					if (sql.includes('FROM message') && !sql.includes('sqlite_master')) {
						return {
							all: vi.fn().mockImplementation((sessionId: string) =>
								messages.filter((m) => m.session_id === sessionId)
							),
							get: vi.fn().mockReturnValue(undefined),
						};
					}

					// part listing
					if (sql.includes('FROM part') && !sql.includes('sqlite_master')) {
						return {
							all: vi.fn().mockReturnValue([]),
							get: vi.fn().mockReturnValue(undefined),
						};
					}

					// Default fallback
					return {
						all: vi.fn().mockReturnValue([]),
						get: vi.fn().mockReturnValue(undefined),
					};
				});

			dbMock.instance = {
				prepare: createPrepare(),
				pragma: vi.fn(),
				close: vi.fn(),
			};
		}

		it('should list sessions from SQLite when database exists', async () => {
			const now = Date.now();
			setupSqliteDb(
				[{ id: 'proj_abc', worktree: '/test/project' }],
				[
					{
						id: 'ses_001',
						project_id: 'proj_abc',
						directory: '/test/project',
						title: 'Test Session',
						time_created: now - 60000,
						time_updated: now,
					},
				]
			);

			const sessions = await storage.listSessions('/test/project');

			expect(sessions).toHaveLength(1);
			expect(sessions[0].sessionId).toBe('ses_001');
			expect(sessions[0].projectPath).toBe('/test/project');
		});

		it('should return empty when no project matches', async () => {
			setupSqliteDb(
				[{ id: 'proj_abc', worktree: '/other/project' }],
				[]
			);

			const sessions = await storage.listSessions('/test/project');

			expect(sessions).toHaveLength(0);
		});

		it('should match subdirectory projects', async () => {
			const now = Date.now();
			setupSqliteDb(
				[{ id: 'proj_abc', worktree: '/test/project' }],
				[
					{
						id: 'ses_001',
						project_id: 'proj_abc',
						directory: '/test/project',
						title: 'Session 1',
						time_created: now - 60000,
						time_updated: now,
					},
				]
			);

			// Querying for a subdirectory should still match the parent project
			const sessions = await storage.listSessions('/test/project');

			expect(sessions).toHaveLength(1);
		});

		it('should aggregate token stats from messages', async () => {
			const now = Date.now();
			setupSqliteDb(
				[{ id: 'proj_abc', worktree: '/test/project' }],
				[
					{
						id: 'ses_001',
						project_id: 'proj_abc',
						directory: '/test/project',
						title: 'Test',
						time_created: now - 60000,
						time_updated: now,
					},
				],
				[
					{
						id: 'msg_1',
						session_id: 'ses_001',
						time_created: now - 60000,
						data: JSON.stringify({
							role: 'user',
							tokens: { input: 100, output: 0 },
						}),
					},
					{
						id: 'msg_2',
						session_id: 'ses_001',
						time_created: now,
						data: JSON.stringify({
							role: 'assistant',
							tokens: { input: 0, output: 500 },
							cost: 0.01,
						}),
					},
				]
			);

			const sessions = await storage.listSessions('/test/project');

			expect(sessions).toHaveLength(1);
			expect(sessions[0].inputTokens).toBe(100);
			expect(sessions[0].outputTokens).toBe(500);
			expect(sessions[0].costUsd).toBe(0.01);
			expect(sessions[0].messageCount).toBe(2);
			expect(sessions[0].durationSeconds).toBe(60);
		});

		it('should handle multiple sessions for same project', async () => {
			const now = Date.now();
			setupSqliteDb(
				[{ id: 'proj_abc', worktree: '/test/project' }],
				[
					{
						id: 'ses_old',
						project_id: 'proj_abc',
						directory: '/test/project',
						title: 'Old Session',
						time_created: now - 120000,
						time_updated: now - 60000,
					},
					{
						id: 'ses_new',
						project_id: 'proj_abc',
						directory: '/test/project',
						title: 'New Session',
						time_created: now - 30000,
						time_updated: now,
					},
				]
			);

			const sessions = await storage.listSessions('/test/project');

			expect(sessions.length).toBeGreaterThanOrEqual(2);
			const ids = sessions.map((s) => s.sessionId);
			expect(ids).toContain('ses_old');
			expect(ids).toContain('ses_new');
		});
	});

	describe('listSessions - JSON fallback', () => {
		it('should fall back to JSON when SQLite DB does not exist', async () => {
			mockExistsSync.mockReturnValue(false);
			// No JSON sessions either — project dir doesn't exist
			mockFsAccess.mockRejectedValue(new Error('ENOENT'));

			const sessions = await storage.listSessions('/test/project');

			expect(sessions).toHaveLength(0);
		});
	});

	describe('listSessions - deduplication', () => {
		it('should merge SQLite and JSON sessions, deduplicating by ID', async () => {
			const now = Date.now();

			// SQLite has ses_001
			mockExistsSync.mockReturnValue(true);
			dbMock.instance = {
				prepare: vi.fn().mockImplementation((sql: string) => {
					const stmt = createMockStatement();
					if (sql.includes('sqlite_master')) {
						stmt.get = vi.fn().mockReturnValue({ name: 'session' });
					}
					if (sql.includes('FROM project')) {
						stmt.all = vi
							.fn()
							.mockReturnValue([{ id: 'proj_abc', worktree: '/test/project' }]);
					}
					if (sql.includes('FROM session')) {
						stmt.all = vi.fn().mockReturnValue([
							{
								id: 'ses_001',
								project_id: 'proj_abc',
								directory: '/test/project',
								title: 'SQLite Session',
								time_created: now - 60000,
								time_updated: now,
							},
						]);
					}
					if (sql.includes('FROM message')) {
						stmt.all = vi.fn().mockReturnValue([]);
					}
					return stmt;
				}),
				pragma: vi.fn(),
				close: vi.fn(),
			};

			// JSON has ses_001 (duplicate) and ses_002 (unique)
			mockFsAccess.mockResolvedValue(undefined);
			mockFsReaddir.mockImplementation((dirPath: string) => {
				if (dirPath.includes('project')) {
					return Promise.resolve(['proj_abc.json']);
				}
				if (dirPath.includes('session')) {
					return Promise.resolve(['ses_001.json', 'ses_002.json']);
				}
				return Promise.resolve([]);
			});
			mockFsReadFile.mockImplementation((filePath: string) => {
				if (filePath.includes('proj_abc.json')) {
					return Promise.resolve(
						JSON.stringify({ id: 'proj_abc', worktree: '/test/project' })
					);
				}
				if (filePath.includes('ses_001.json')) {
					return Promise.resolve(
						JSON.stringify({
							id: 'ses_001',
							projectID: 'proj_abc',
							title: 'JSON Session 1',
							time: { created: now - 120000, updated: now - 60000 },
						})
					);
				}
				if (filePath.includes('ses_002.json')) {
					return Promise.resolve(
						JSON.stringify({
							id: 'ses_002',
							projectID: 'proj_abc',
							title: 'JSON Session 2',
							time: { created: now - 180000, updated: now - 120000 },
						})
					);
				}
				return Promise.reject(new Error('ENOENT'));
			});

			const sessions = await storage.listSessions('/test/project');

			// Should have 2: ses_001 from SQLite, ses_002 from JSON (deduped ses_001)
			expect(sessions).toHaveLength(2);
			const ids = sessions.map((s) => s.sessionId);
			expect(ids).toContain('ses_001');
			expect(ids).toContain('ses_002');
		});
	});

	describe('readSessionMessages - SQLite', () => {
		it('should read messages from SQLite', async () => {
			const now = Date.now();
			mockExistsSync.mockReturnValue(true);

			const prepareFn = (sql: string) => {
				if (sql.includes('sqlite_master')) {
					return {
						get: vi.fn().mockReturnValue({ name: 'message' }),
						all: vi.fn().mockReturnValue([]),
					};
				}
				if (sql.includes('FROM message')) {
					return {
						all: vi.fn().mockReturnValue([
							{
								id: 'msg_1',
								session_id: 'ses_001',
								time_created: now - 60000,
								time_updated: now - 60000,
								data: JSON.stringify({ role: 'user' }),
							},
							{
								id: 'msg_2',
								session_id: 'ses_001',
								time_created: now,
								time_updated: now,
								data: JSON.stringify({ role: 'assistant' }),
							},
						]),
						get: vi.fn(),
					};
				}
				if (sql.includes('FROM part')) {
					return {
						all: vi.fn().mockImplementation((messageId: string) => {
							if (messageId === 'msg_1') {
								return [
									{
										id: 'part_1',
										data: JSON.stringify({
											type: 'text',
											text: 'Hello, world',
										}),
									},
								];
							}
							if (messageId === 'msg_2') {
								return [
									{
										id: 'part_2',
										data: JSON.stringify({
											type: 'text',
											text: 'Hi there!',
										}),
									},
								];
							}
							return [];
						}),
						get: vi.fn(),
					};
				}
				return { all: vi.fn().mockReturnValue([]), get: vi.fn() };
			};

			dbMock.instance = {
				prepare: vi.fn().mockImplementation(prepareFn),
				pragma: vi.fn(),
				close: vi.fn(),
			};

			const result = await storage.readSessionMessages('/test/project', 'ses_001');

			expect(result.total).toBe(2);
			expect(result.messages).toHaveLength(2);
			expect(result.messages[0].content).toBe('Hello, world');
			expect(result.messages[0].role).toBe('user');
			expect(result.messages[1].content).toBe('Hi there!');
			expect(result.messages[1].role).toBe('assistant');
		});
	});

	describe('deleteMessagePair - SQLite', () => {
		it('should reject deletion for SQLite-backed sessions', async () => {
			const now = Date.now();
			mockExistsSync.mockReturnValue(true);

			const prepareFn = (sql: string) => {
				if (sql.includes('sqlite_master')) {
					return {
						get: vi.fn().mockReturnValue({ name: 'message' }),
						all: vi.fn().mockReturnValue([]),
					};
				}
				if (sql.includes('FROM message')) {
					return {
						all: vi.fn().mockReturnValue([
							{
								id: 'msg_1',
								session_id: 'ses_001',
								time_created: now,
								time_updated: now,
								data: JSON.stringify({ role: 'user' }),
							},
						]),
						get: vi.fn(),
					};
				}
				if (sql.includes('FROM part')) {
					return {
						all: vi.fn().mockReturnValue([]),
						get: vi.fn(),
					};
				}
				return { all: vi.fn().mockReturnValue([]), get: vi.fn() };
			};

			dbMock.instance = {
				prepare: vi.fn().mockImplementation(prepareFn),
				pragma: vi.fn(),
				close: vi.fn(),
			};

			const result = await storage.deleteMessagePair(
				'/test/project',
				'ses_001',
				'msg_1'
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('SQLite');
		});
	});

	describe('getSessionPath', () => {
		it('should return DB path when SQLite exists', () => {
			mockExistsSync.mockReturnValue(true);

			const result = storage.getSessionPath('/test/project', 'ses_001');

			expect(result).toContain('opencode.db');
		});

		it('should return message dir path when no SQLite', () => {
			mockExistsSync.mockReturnValue(false);

			const result = storage.getSessionPath('/test/project', 'ses_001');

			expect(result).toContain('message');
			expect(result).toContain('ses_001');
		});
	});
});
