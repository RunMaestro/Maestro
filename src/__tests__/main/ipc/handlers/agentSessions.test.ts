/**
 * Tests for the agentSessions IPC handlers
 *
 * These tests verify the generic agent session management API that works
 * with any agent supporting the AgentSessionStorage interface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import {
	registerAgentSessionsHandlers,
	isExpectedSessionReadError,
} from '../../../../main/ipc/handlers/agentSessions';
import * as agentSessionStorage from '../../../../main/agents';
import {
	GLOBAL_STATS_CACHE_MIN_UPGRADABLE_VERSION,
	GLOBAL_STATS_CACHE_VERSION,
	loadGlobalStatsCache,
	saveGlobalStatsCache,
} from '../../../../main/utils/statsCache';
import os from 'os';
import path from 'path';
import { promises as realFs } from 'fs';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock the agents module (session storage exports)
vi.mock('../../../../main/agents', () => ({
	getSessionStorage: vi.fn(),
	hasSessionStorage: vi.fn(),
	getAllSessionStorages: vi.fn(),
}));

// Mock the stores module. The agentSessions handler now resolves SSH remotes
// through the canonical store getter; in the absence of a configured remote
// we want a clean undefined return (matching the prior "no settings store"
// behavior the tests below assert against), not an "uninitialized" throw.
vi.mock('../../../../main/stores', () => ({
	getSshRemoteById: vi.fn().mockReturnValue(undefined),
}));

// The global stats scan reads and writes a cache under userData; start cold
// and discard writes so a test only ever sees the transcripts it created.
vi.mock('../../../../main/utils/statsCache', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/utils/statsCache')>()),
	loadGlobalStatsCache: vi.fn().mockResolvedValue(null),
	saveGlobalStatsCache: vi.fn().mockResolvedValue(undefined),
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('agentSessions IPC handlers', () => {
	let handlers: Map<string, Function>;

	beforeEach(() => {
		// Clear mocks
		vi.clearAllMocks();

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers
		registerAgentSessionsHandlers();
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all agentSessions handlers', () => {
			const expectedChannels = [
				'agentSessions:list',
				'agentSessions:listPaginated',
				'agentSessions:read',
				'agentSessions:search',
				'agentSessions:getPath',
				'agentSessions:deleteMessagePair',
				'agentSessions:hasStorage',
				'agentSessions:getAvailableStorages',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
		});
	});

	describe('agentSessions:list', () => {
		it('should return sessions from storage', async () => {
			const mockSessions = [
				{ sessionId: 'session-1', projectPath: '/test', firstMessage: 'Hello' },
				{ sessionId: 'session-2', projectPath: '/test', firstMessage: 'Hi' },
			];

			const mockStorage = {
				agentId: 'claude-code',
				listSessions: vi.fn().mockResolvedValue(mockSessions),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:list');
			const result = await handler!({} as any, 'claude-code', '/test');

			expect(mockStorage.listSessions).toHaveBeenCalledWith('/test', undefined);
			expect(result).toEqual(mockSessions);
		});

		it('should return empty array when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:list');
			const result = await handler!({} as any, 'unknown-agent', '/test');

			expect(result).toEqual([]);
		});

		it('should pass sshRemoteId to storage when provided', async () => {
			const mockSessions = [{ sessionId: 'session-1', projectPath: '/test' }];

			const mockStorage = {
				agentId: 'claude-code',
				listSessions: vi.fn().mockResolvedValue(mockSessions),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:list');
			// Note: Without settings store, sshConfig will be undefined even if sshRemoteId is passed
			const result = await handler!({} as any, 'claude-code', '/test', 'ssh-remote-1');

			// Since no settings store is configured, sshConfig should be undefined
			expect(mockStorage.listSessions).toHaveBeenCalledWith('/test', undefined);
			expect(result).toEqual(mockSessions);
		});
	});

	describe('agentSessions:listPaginated', () => {
		it('should return paginated sessions from storage', async () => {
			const mockResult = {
				sessions: [{ sessionId: 'session-1' }],
				hasMore: true,
				totalCount: 50,
				nextCursor: 'session-1',
			};

			const mockStorage = {
				agentId: 'claude-code',
				listSessionsPaginated: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:listPaginated');
			const result = await handler!({} as any, 'claude-code', '/test', { limit: 10 });

			expect(mockStorage.listSessionsPaginated).toHaveBeenCalledWith(
				'/test',
				{ limit: 10 },
				undefined
			);
			expect(result).toEqual(mockResult);
		});

		it('should return empty result when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:listPaginated');
			const result = await handler!({} as any, 'unknown-agent', '/test', {});

			expect(result).toEqual({
				sessions: [],
				hasMore: false,
				totalCount: 0,
				nextCursor: null,
			});
		});

		it('should pass sshRemoteId to storage when provided', async () => {
			const mockResult = {
				sessions: [{ sessionId: 'session-1' }],
				hasMore: false,
				totalCount: 1,
				nextCursor: null,
			};

			const mockStorage = {
				agentId: 'claude-code',
				listSessionsPaginated: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:listPaginated');
			const result = await handler!(
				{} as any,
				'claude-code',
				'/test',
				{ limit: 10 },
				'ssh-remote-1'
			);

			// Since no settings store is configured, sshConfig should be undefined
			expect(mockStorage.listSessionsPaginated).toHaveBeenCalledWith(
				'/test',
				{ limit: 10 },
				undefined
			);
			expect(result).toEqual(mockResult);
		});
	});

	describe('agentSessions:read', () => {
		it('should return session messages from storage', async () => {
			const mockResult = {
				messages: [{ type: 'user', content: 'Hello' }],
				total: 10,
				hasMore: true,
			};

			const mockStorage = {
				agentId: 'claude-code',
				readSessionMessages: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:read');
			const result = await handler!({} as any, 'claude-code', '/test', 'session-1', {
				offset: 0,
				limit: 20,
			});

			expect(mockStorage.readSessionMessages).toHaveBeenCalledWith(
				'/test',
				'session-1',
				{
					offset: 0,
					limit: 20,
				},
				undefined
			);
			expect(result).toEqual(mockResult);
		});

		it('should return empty result when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:read');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'session-1', {});

			expect(result).toEqual({ messages: [], total: 0, hasMore: false });
		});

		it('should pass sshRemoteId to storage when provided', async () => {
			const mockResult = {
				messages: [{ type: 'user', content: 'Hello' }],
				total: 1,
				hasMore: false,
			};

			const mockStorage = {
				agentId: 'claude-code',
				readSessionMessages: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:read');
			const result = await handler!(
				{} as any,
				'claude-code',
				'/test',
				'session-1',
				{ offset: 0, limit: 20 },
				'ssh-remote-1'
			);

			// Since no settings store is configured, sshConfig should be undefined
			expect(mockStorage.readSessionMessages).toHaveBeenCalledWith(
				'/test',
				'session-1',
				{ offset: 0, limit: 20 },
				undefined
			);
			expect(result).toEqual(mockResult);
		});
	});

	describe('agentSessions:search', () => {
		it('should return search results from storage', async () => {
			const mockResults = [
				{
					sessionId: 'session-1',
					matchType: 'title' as const,
					matchPreview: 'Hello...',
					matchCount: 1,
				},
			];

			const mockStorage = {
				agentId: 'claude-code',
				searchSessions: vi.fn().mockResolvedValue(mockResults),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:search');
			const result = await handler!({} as any, 'claude-code', '/test', 'hello', 'all');

			expect(mockStorage.searchSessions).toHaveBeenCalledWith('/test', 'hello', 'all', undefined);
			expect(result).toEqual(mockResults);
		});

		it('should return empty array when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:search');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'hello', 'all');

			expect(result).toEqual([]);
		});

		it('should pass sshRemoteId to storage when provided', async () => {
			const mockResults = [
				{
					sessionId: 'session-1',
					matchType: 'title' as const,
					matchPreview: 'Hello...',
					matchCount: 1,
				},
			];

			const mockStorage = {
				agentId: 'claude-code',
				searchSessions: vi.fn().mockResolvedValue(mockResults),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:search');
			const result = await handler!(
				{} as any,
				'claude-code',
				'/test',
				'hello',
				'all',
				'ssh-remote-1'
			);

			// Since no settings store is configured, sshConfig should be undefined
			expect(mockStorage.searchSessions).toHaveBeenCalledWith('/test', 'hello', 'all', undefined);
			expect(result).toEqual(mockResults);
		});
	});

	describe('agentSessions:getPath', () => {
		it('should return session path from storage', async () => {
			const mockStorage = {
				agentId: 'claude-code',
				getSessionPath: vi.fn().mockReturnValue('/path/to/session.jsonl'),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:getPath');
			const result = await handler!({} as any, 'claude-code', '/test', 'session-1');

			expect(mockStorage.getSessionPath).toHaveBeenCalledWith('/test', 'session-1');
			expect(result).toBe('/path/to/session.jsonl');
		});

		it('should return null when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:getPath');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'session-1');

			expect(result).toBe(null);
		});
	});

	describe('agentSessions:deleteMessagePair', () => {
		it('should delete message pair from storage', async () => {
			const mockStorage = {
				agentId: 'claude-code',
				deleteMessagePair: vi.fn().mockResolvedValue({ success: true, linesRemoved: 3 }),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:deleteMessagePair');
			const result = await handler!(
				{} as any,
				'claude-code',
				'/test',
				'session-1',
				'uuid-123',
				'fallback content'
			);

			expect(mockStorage.deleteMessagePair).toHaveBeenCalledWith(
				'/test',
				'session-1',
				'uuid-123',
				'fallback content'
			);
			expect(result).toEqual({ success: true, linesRemoved: 3 });
		});

		it('should return error when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:deleteMessagePair');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'session-1', 'uuid-123');

			expect(result).toEqual({
				success: false,
				error: 'No session storage available for agent: unknown-agent',
			});
		});
	});

	describe('agentSessions:hasStorage', () => {
		it('should return true when storage exists', async () => {
			vi.mocked(agentSessionStorage.hasSessionStorage).mockReturnValue(true);

			const handler = handlers.get('agentSessions:hasStorage');
			const result = await handler!({} as any, 'claude-code');

			expect(agentSessionStorage.hasSessionStorage).toHaveBeenCalledWith('claude-code');
			expect(result).toBe(true);
		});

		it('should return false when storage does not exist', async () => {
			vi.mocked(agentSessionStorage.hasSessionStorage).mockReturnValue(false);

			const handler = handlers.get('agentSessions:hasStorage');
			const result = await handler!({} as any, 'unknown-agent');

			expect(result).toBe(false);
		});
	});

	describe('agentSessions:getAvailableStorages', () => {
		it('should return list of available storage agent IDs', async () => {
			const mockStorages = [{ agentId: 'claude-code' }, { agentId: 'opencode' }];

			vi.mocked(agentSessionStorage.getAllSessionStorages).mockReturnValue(
				mockStorages as unknown as agentSessionStorage.AgentSessionStorage[]
			);

			const handler = handlers.get('agentSessions:getAvailableStorages');
			const result = await handler!({} as any);

			expect(result).toEqual(['claude-code', 'opencode']);
		});
	});
});

describe('isExpectedSessionReadError', () => {
	// The global-stats loops read provider transcripts that belong to the agent
	// CLI, not to us. Failures rooted in the user's filesystem must not reach
	// Sentry (MAESTRO-W9); a genuine parse fault still must.
	it('treats an unreadable transcript as expected (MAESTRO-W9)', () => {
		const error = Object.assign(
			new Error("EACCES: permission denied, open '/Users/x/.claude/projects/a/b.jsonl'"),
			{ code: 'EACCES' }
		);
		expect(isExpectedSessionReadError(error)).toBe(true);
	});

	it('treats a transcript deleted mid-scan as expected', () => {
		const error = Object.assign(new Error('ENOENT: no such file or directory'), {
			code: 'ENOENT',
		});
		expect(isExpectedSessionReadError(error)).toBe(true);
	});

	it.each(['EPERM', 'ENOTDIR', 'EISDIR', 'EBUSY'])('treats %s as expected', (code) => {
		expect(isExpectedSessionReadError(Object.assign(new Error(code), { code }))).toBe(true);
	});

	it('still reports errors that are not filesystem conditions', () => {
		expect(isExpectedSessionReadError(new Error('Unexpected token in JSON'))).toBe(false);
		expect(isExpectedSessionReadError(new RangeError('Invalid string length'))).toBe(false);
		expect(isExpectedSessionReadError(Object.assign(new Error('boom'), { code: 'EMFILE' }))).toBe(
			false
		);
	});

	it('handles non-Error throwables', () => {
		expect(isExpectedSessionReadError(undefined)).toBe(false);
		expect(isExpectedSessionReadError('EACCES')).toBe(false);
	});
});

describe('agentSessions:getGlobalStats discovery', () => {
	let home: string;
	let getGlobalStats: () => Promise<{
		totalSessions: number;
		totalMessages: number;
		totalSizeBytes: number;
		byProvider: Record<string, { sessions: number }>;
	}>;

	beforeEach(async () => {
		home = await realFs.mkdtemp(path.join(os.tmpdir(), 'maestro-global-stats-'));
		vi.spyOn(os, 'homedir').mockReturnValue(home);
		const handlers = new Map<string, Function>();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});
		registerAgentSessionsHandlers();
		const handler = handlers.get('agentSessions:getGlobalStats')!;
		getGlobalStats = () => handler({});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await realFs.rm(home, { recursive: true, force: true });
	});

	it('counts every non-empty transcript across more files than the concurrency cap', async () => {
		const claudeTranscript = '{"type":"user"}\n{"type":"assistant"}\n';
		const projects = path.join(home, '.claude', 'projects');
		// 40 transcripts across two projects: more than either pool's cap, so
		// workers must pull past their first item for the count to come out right.
		for (const project of ['-Users-a', '-Users-b']) {
			await realFs.mkdir(path.join(projects, project), { recursive: true });
			for (let i = 0; i < 20; i++) {
				await realFs.writeFile(path.join(projects, project, `s${i}.jsonl`), claudeTranscript);
			}
		}
		// Skipped: an abandoned 0-byte session, a non-transcript, and a stray file
		// where a project directory is expected.
		await realFs.writeFile(path.join(projects, '-Users-a', 'empty.jsonl'), '');
		await realFs.writeFile(path.join(projects, '-Users-a', 'notes.txt'), 'x');
		await realFs.writeFile(path.join(projects, 'stray.jsonl'), claudeTranscript);

		const codexDay = path.join(home, '.codex', 'sessions', '2026', '10', '11');
		await realFs.mkdir(codexDay, { recursive: true });
		await realFs.writeFile(
			path.join(codexDay, 'rollout.jsonl'),
			'{"type":"response_item","payload":{"type":"message","role":"user"}}\n'
		);

		const stats = await getGlobalStats();

		expect(stats.byProvider['claude-code'].sessions).toBe(40);
		expect(stats.byProvider['codex'].sessions).toBe(1);
		expect(stats.totalSessions).toBe(41);
		expect(stats.totalMessages).toBe(81);
		expect(stats.totalSizeBytes).toBe(
			40 * claudeTranscript.length +
				'{"type":"response_item","payload":{"type":"message","role":"user"}}\n'.length
		);
	});

	it('upgrades a cache from an older Claude parser: re-parses live sessions, rescales archived ones', async () => {
		const projects = path.join(home, '.claude', 'projects', '-Users-a');
		await realFs.mkdir(projects, { recursive: true });
		// One API response written as two lines (one per content block), each
		// repeating the usage: 1M Sonnet input = $3 once deduplicated.
		const line = JSON.stringify({
			type: 'assistant',
			requestId: 'req_1',
			message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000 } },
		});
		await realFs.writeFile(path.join(projects, 'live.jsonl'), `${line}\n${line}\n`);

		const cachedEntry = (inputTokens: number, costUsd: number, archived = false) => ({
			messages: 2,
			inputTokens,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			cachedInputTokens: 0,
			sizeBytes: 1,
			costUsd,
			// Newer than the file, so only the version can force the re-parse.
			fileMtimeMs: Date.now() + 60_000,
			archived,
		});
		vi.mocked(loadGlobalStatsCache).mockResolvedValueOnce({
			version: GLOBAL_STATS_CACHE_MIN_UPGRADABLE_VERSION,
			lastUpdated: 0,
			providers: {
				'claude-code': {
					sessions: {
						'-Users-a/live': cachedEntry(2_000_000, 6),
						'-Users-a/gone': cachedEntry(4_000_000, 12, true),
					},
				},
				codex: { sessions: {} },
			},
		});

		const stats = (await getGlobalStats()) as unknown as {
			totalCostUsd: number;
			totalInputTokens: number;
		};

		// Live re-parsed to $3; the fix halved it, so the archived $12 becomes $6.
		expect(stats.totalCostUsd).toBeCloseTo(9, 10);
		expect(stats.totalInputTokens).toBe(3_000_000);
		const saved = vi.mocked(saveGlobalStatsCache).mock.calls.at(-1)![0];
		expect(saved.version).toBe(GLOBAL_STATS_CACHE_VERSION);
	});

	it("prices a Claude session's subagent transcripts into the totals without counting them as sessions", async () => {
		const project = path.join(home, '.claude', 'projects', '-Users-a');
		const line = (id: string) =>
			JSON.stringify({
				type: 'assistant',
				requestId: `req_${id}`,
				message: { id, model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000 } },
			});
		await realFs.mkdir(path.join(project, 's1', 'subagents'), { recursive: true });
		await realFs.writeFile(path.join(project, 's1.jsonl'), `${line('parent')}\n`);
		await realFs.writeFile(
			path.join(project, 's1', 'subagents', 'agent-x.jsonl'),
			`${line('child')}\n`
		);

		const stats = (await getGlobalStats()) as unknown as {
			totalSessions: number;
			totalInputTokens: number;
			totalCostUsd: number;
		};

		expect(stats.totalSessions).toBe(1);
		expect(stats.totalInputTokens).toBe(2_000_000);
		expect(stats.totalCostUsd).toBeCloseTo(6, 10);
	});

	it('resumes a part-done upgrade: skips upgraded entries and rescales archived ones once', async () => {
		const projects = path.join(home, '.claude', 'projects', '-Users-a');
		await realFs.mkdir(projects, { recursive: true });
		const line = JSON.stringify({
			type: 'assistant',
			requestId: 'req_1',
			message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000 } },
		});
		await realFs.writeFile(path.join(projects, 'live.jsonl'), `${line}\n`);
		// Already upgraded by the killed run. Its content would parse to $3, so a
		// re-parse would show up in the total.
		await realFs.writeFile(path.join(projects, 'done.jsonl'), `${line}\n`);

		const cachedEntry = (inputTokens: number, costUsd: number, extra = {}) => ({
			messages: 1,
			inputTokens,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			cachedInputTokens: 0,
			sizeBytes: 1,
			costUsd,
			fileMtimeMs: Date.now() + 60_000,
			...extra,
		});
		vi.mocked(loadGlobalStatsCache).mockResolvedValueOnce({
			version: GLOBAL_STATS_CACHE_MIN_UPGRADABLE_VERSION,
			lastUpdated: 0,
			upgrade: {
				toVersion: GLOBAL_STATS_CACHE_VERSION,
				baseline: {
					costUsd: { oldSum: 4, newSum: 2 },
					inputTokens: { oldSum: 2_000_000, newSum: 1_000_000 },
				},
			},
			providers: {
				'claude-code': {
					sessions: {
						'-Users-a/live': cachedEntry(2_000_000, 6),
						'-Users-a/done': cachedEntry(5_000_000, 15, {
							derivedVersion: GLOBAL_STATS_CACHE_VERSION,
						}),
						'-Users-a/gone': cachedEntry(4_000_000, 12, { archived: true }),
					},
				},
				codex: { sessions: {} },
			},
		});

		const stats = (await getGlobalStats()) as unknown as {
			totalCostUsd: number;
			totalInputTokens: number;
		};

		// live $6 -> $3 (re-parsed), done $15 (kept), gone $12 scaled by both
		// runs' sums ($10 -> $5) to $6.
		expect(stats.totalCostUsd).toBeCloseTo(24, 10);
		expect(stats.totalInputTokens).toBe(8_000_000);
		const saved = vi.mocked(saveGlobalStatsCache).mock.calls.at(-1)![0];
		expect(saved.version).toBe(GLOBAL_STATS_CACHE_VERSION);
		expect(saved.upgrade).toBeUndefined();
		expect(saved.providers['claude-code'].sessions['-Users-a/gone'].derivedVersion).toBe(
			GLOBAL_STATS_CACHE_VERSION
		);
	});

	it('shares one scan between concurrent requests', async () => {
		vi.mocked(loadGlobalStatsCache).mockClear();
		const [first, second] = await Promise.all([getGlobalStats(), getGlobalStats()]);
		expect(vi.mocked(loadGlobalStatsCache)).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
	});

	it('reports zero when neither provider has a transcript directory', async () => {
		const stats = await getGlobalStats();
		expect(stats.totalSessions).toBe(0);
	});
});
