/**
 * Tests for the agentSessions IPC handlers
 *
 * These tests verify the generic agent session management API that works
 * with any agent supporting the AgentSessionStorage interface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import * as fsPromises from 'fs/promises';
import { registerAgentSessionsHandlers } from '../../../../main/ipc/handlers/agentSessions';
import * as agentSessionStorage from '../../../../main/agents';
import { getHistoryManager } from '../../../../main/history-manager';

const fsMock = vi.hoisted(() => ({
	access: vi.fn(),
	readdir: vi.fn(),
	readFile: vi.fn(),
	stat: vi.fn(),
}));

const sentryMock = vi.hoisted(() => ({
	captureException: vi.fn(),
}));

const safeSendMock = vi.hoisted(() => ({
	isWebContentsAvailable: vi.fn(),
}));

const pricingMock = vi.hoisted(() => ({
	calculateModelCost: vi.fn(() => 0.01),
	computeClaudeUsageCost: vi.fn(() => ({
		inputTokens: 11,
		outputTokens: 7,
		cacheReadTokens: 3,
		cacheCreationTokens: 2,
		costUsd: 0.04,
	})),
}));

const statsCacheMock = vi.hoisted(() => ({
	GLOBAL_STATS_CACHE_VERSION: 3,
	loadGlobalStatsCache: vi.fn(),
	saveGlobalStatsCache: vi.fn(),
}));

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

vi.mock('fs/promises', () => ({
	default: fsMock,
	...fsMock,
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

vi.mock('../../../../main/history-manager', () => ({
	getHistoryManager: vi.fn(),
}));

vi.mock('../../../../main/utils/sentry', () => sentryMock);

vi.mock('../../../../main/utils/safe-send', () => safeSendMock);

vi.mock('../../../../main/utils/pricing', () => pricingMock);

vi.mock('../../../../main/utils/statsCache', () => statsCacheMock);

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
				'agentSessions:getAllNamedSessions',
				'agentSessions:getOrigins',
				'agentSessions:setSessionName',
				'agentSessions:setSessionStarred',
				'agentSessions:getGlobalStats',
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

	describe('agentSessions origins and named sessions', () => {
		function createOriginsStore(initialOrigins = {}) {
			let origins = initialOrigins;
			return {
				get: vi.fn((_key: string, fallback: unknown) => origins || fallback),
				set: vi.fn((_key: string, value: unknown) => {
					origins = value;
				}),
			};
		}

		function registerWithOriginsStore(originsStore: ReturnType<typeof createOriginsStore>) {
			handlers.clear();
			registerAgentSessionsHandlers({
				getMainWindow: () => null,
				agentSessionOriginsStore: originsStore as any,
			});
		}

		it('returns provider named sessions, generic origin names, and history-derived names', async () => {
			const originsStore = createOriginsStore({
				codex: {
					'/repo': {
						'origin-named': { sessionName: 'Origin Named', starred: true },
						'stale-origin': { sessionName: 'Stale Origin' },
					},
				},
			});
			const providerStorage = {
				agentId: 'claude-code',
				getAllNamedSessions: vi.fn().mockResolvedValue([
					{
						agentSessionId: 'provider-named',
						projectPath: '/repo',
						sessionName: 'Provider Named',
						starred: false,
					},
				]),
				getSessionPath: vi.fn().mockReturnValue(null),
			};
			const codexStorage = {
				agentId: 'codex',
				getSessionPath: vi.fn((projectPath: string, sessionId: string) =>
					sessionId === 'stale-origin'
						? '/missing-origin.jsonl'
						: `${projectPath}/${sessionId}.jsonl`
				),
			};
			vi.mocked(agentSessionStorage.getAllSessionStorages).mockReturnValue([
				providerStorage,
				codexStorage,
			] as unknown as agentSessionStorage.AgentSessionStorage[]);
			vi.mocked(agentSessionStorage.getSessionStorage).mockImplementation((agentId) =>
				agentId === 'codex'
					? (codexStorage as unknown as agentSessionStorage.AgentSessionStorage)
					: null
			);
			vi.mocked(getHistoryManager).mockReturnValue({
				getAllEntriesPaginated: vi.fn().mockResolvedValue({
					entries: [
						{
							agentSessionId: 'history-named',
							projectPath: '/repo',
							sessionName: 'History Named',
						},
						{
							agentSessionId: 'origin-named',
							projectPath: '/repo',
							sessionName: 'Duplicate History',
						},
					],
				}),
			} as any);
			vi.mocked(fsPromises.stat).mockImplementation(async (filePath) => {
				if (String(filePath).includes('missing-origin')) {
					throw new Error('missing');
				}
				return {
					mtime: new Date('2026-06-18T12:00:00.000Z'),
					mtimeMs: Date.parse('2026-06-18T12:00:00.000Z'),
					size: 100,
				} as any;
			});
			registerWithOriginsStore(originsStore);

			const result = await handlers.get('agentSessions:getAllNamedSessions')!({} as any);

			expect(result).toEqual([
				{
					agentId: 'claude-code',
					agentSessionId: 'provider-named',
					projectPath: '/repo',
					sessionName: 'Provider Named',
					starred: false,
				},
				{
					agentId: 'codex',
					agentSessionId: 'origin-named',
					projectPath: '/repo',
					sessionName: 'Origin Named',
					starred: true,
				},
				{
					agentId: 'codex',
					agentSessionId: 'history-named',
					projectPath: '/repo',
					sessionName: 'History Named',
					lastActivityAt: Date.parse('2026-06-18T12:00:00.000Z'),
				},
			]);
			expect(providerStorage.getAllNamedSessions).toHaveBeenCalledTimes(1);
			expect(codexStorage.getSessionPath).toHaveBeenCalledWith('/repo', 'origin-named');
			expect(sentryMock.captureException).not.toHaveBeenCalled();
		});

		it('handles provider and history failures while returning available named sessions', async () => {
			const originsStore = createOriginsStore();
			vi.mocked(agentSessionStorage.getAllSessionStorages).mockReturnValue([
				{
					agentId: 'broken',
					getAllNamedSessions: vi.fn().mockRejectedValue(new Error('provider failed')),
					getSessionPath: vi.fn(),
				},
			] as unknown as agentSessionStorage.AgentSessionStorage[]);
			vi.mocked(getHistoryManager).mockImplementation(() => {
				throw new Error('history failed');
			});
			registerWithOriginsStore(originsStore);

			const result = await handlers.get('agentSessions:getAllNamedSessions')!({} as any);

			expect(result).toEqual([]);
			expect(sentryMock.captureException).toHaveBeenCalledTimes(2);
		});

		it('gets and mutates generic origin metadata with cleanup for empty records', async () => {
			const originsStore = createOriginsStore({
				opencode: {
					'/repo': {
						'session-1': { origin: 'user', sessionName: 'Existing Name', starred: true },
						'session-2': { sessionName: 'Only Name' },
					},
				},
			});
			registerWithOriginsStore(originsStore);

			await expect(
				handlers.get('agentSessions:getOrigins')!({} as any, 'opencode', '/repo')
			).resolves.toEqual({
				'session-1': { origin: 'user', sessionName: 'Existing Name', starred: true },
				'session-2': { sessionName: 'Only Name' },
			});

			await handlers.get('agentSessions:setSessionName')!(
				{} as any,
				'opencode',
				'/repo',
				'session-3',
				'New Name'
			);
			await handlers.get('agentSessions:setSessionStarred')!(
				{} as any,
				'opencode',
				'/repo',
				'session-3',
				true
			);
			await handlers.get('agentSessions:setSessionName')!(
				{} as any,
				'opencode',
				'/repo',
				'session-2',
				null
			);
			await handlers.get('agentSessions:setSessionStarred')!(
				{} as any,
				'opencode',
				'/repo',
				'session-1',
				false
			);

			expect(originsStore.set).toHaveBeenLastCalledWith('origins', {
				opencode: {
					'/repo': {
						'session-1': { origin: 'user', sessionName: 'Existing Name' },
						'session-3': { sessionName: 'New Name', starred: true },
					},
				},
			});
		});

		it('returns safe defaults when the origins store is not configured', async () => {
			const getOriginsResult = await handlers.get('agentSessions:getOrigins')!(
				{} as any,
				'opencode',
				'/repo'
			);

			await expect(
				handlers.get('agentSessions:setSessionName')!(
					{} as any,
					'opencode',
					'/repo',
					'session-1',
					'Name'
				)
			).resolves.toBeUndefined();
			await expect(
				handlers.get('agentSessions:setSessionStarred')!(
					{} as any,
					'opencode',
					'/repo',
					'session-1',
					true
				)
			).resolves.toBeUndefined();
			expect(getOriginsResult).toEqual({});
		});
	});

	describe('agentSessions:getGlobalStats', () => {
		function dirStat() {
			return { isDirectory: () => true, size: 0, mtimeMs: 0, mtime: new Date(0) } as any;
		}

		function fileStat(size: number, mtimeMs: number) {
			return {
				isDirectory: () => false,
				size,
				mtimeMs,
				mtime: new Date(mtimeMs),
			} as any;
		}

		it('builds provider totals from cached sessions and emits progress updates', async () => {
			const webContents = { send: vi.fn() };
			const cache = {
				version: 3,
				lastUpdated: 1,
				providers: {
					'claude-code': {
						sessions: {
							'project/session-a': {
								messages: 2,
								inputTokens: 10,
								outputTokens: 5,
								cacheReadTokens: 3,
								cacheCreationTokens: 1,
								cachedInputTokens: 0,
								sizeBytes: 100,
								costUsd: 0.02,
								fileMtimeMs: 10,
							},
						},
					},
					codex: {
						sessions: {
							'2026/06/18/session-b': {
								messages: 1,
								inputTokens: 7,
								outputTokens: 2,
								cacheReadTokens: 0,
								cacheCreationTokens: 0,
								cachedInputTokens: 4,
								sizeBytes: 50,
								fileMtimeMs: 20,
							},
						},
					},
				},
			};
			statsCacheMock.loadGlobalStatsCache.mockResolvedValue(cache);
			statsCacheMock.saveGlobalStatsCache.mockResolvedValue(undefined);
			safeSendMock.isWebContentsAvailable.mockReturnValue(true);
			vi.mocked(fsPromises.access).mockRejectedValue(new Error('missing sessions dir'));
			handlers.clear();
			registerAgentSessionsHandlers({
				getMainWindow: () => ({ webContents }) as any,
			});

			const result = await handlers.get('agentSessions:getGlobalStats')!({} as any);

			expect(result).toMatchObject({
				totalSessions: 2,
				totalMessages: 3,
				totalInputTokens: 17,
				totalOutputTokens: 7,
				totalCacheReadTokens: 7,
				totalCacheCreationTokens: 1,
				totalCostUsd: 0.02,
				totalSizeBytes: 150,
				hasCostData: true,
				isComplete: true,
				byProvider: {
					'claude-code': {
						sessions: 1,
						messages: 2,
						inputTokens: 10,
						outputTokens: 5,
						costUsd: 0.02,
						hasCostData: true,
					},
					codex: {
						sessions: 1,
						messages: 1,
						inputTokens: 7,
						outputTokens: 2,
						costUsd: 0,
						hasCostData: false,
					},
				},
			});
			expect(cache.providers['claude-code'].sessions['project/session-a'].archived).toBe(true);
			expect(cache.providers.codex.sessions['2026/06/18/session-b'].archived).toBe(true);
			expect(statsCacheMock.saveGlobalStatsCache).toHaveBeenCalledWith(cache);
			expect(webContents.send).toHaveBeenCalledWith(
				'agentSessions:globalStatsUpdate',
				expect.objectContaining({ isComplete: true, totalSessions: 2 })
			);
		});

		it('discovers and parses new Claude and Codex session files into the cache', async () => {
			statsCacheMock.loadGlobalStatsCache.mockResolvedValue(null);
			statsCacheMock.saveGlobalStatsCache.mockResolvedValue(undefined);
			safeSendMock.isWebContentsAvailable.mockReturnValue(false);
			vi.mocked(fsPromises.access).mockResolvedValue(undefined);
			vi.mocked(fsPromises.readdir).mockImplementation(async (target) => {
				const p = String(target);
				if (p.endsWith('/.claude/projects')) return ['encoded-project'] as any;
				if (p.endsWith('/.claude/projects/encoded-project')) return ['claude-session.jsonl'] as any;
				if (p.endsWith('/.codex/sessions')) return ['2026'] as any;
				if (p.endsWith('/.codex/sessions/2026')) return ['06'] as any;
				if (p.endsWith('/.codex/sessions/2026/06')) return ['18'] as any;
				if (p.endsWith('/.codex/sessions/2026/06/18')) return ['rollout-session.jsonl'] as any;
				return [] as any;
			});
			vi.mocked(fsPromises.stat).mockImplementation(async (target) => {
				const p = String(target);
				if (p.endsWith('.jsonl')) {
					return fileStat(
						p.includes('claude-session') ? 120 : 80,
						p.includes('claude') ? 100 : 200
					);
				}
				return dirStat();
			});
			vi.mocked(fsPromises.readFile).mockImplementation(async (target) => {
				const p = String(target);
				if (p.includes('claude-session')) {
					return [
						JSON.stringify({ type: 'user', message: { content: 'Prompt' } }),
						JSON.stringify({ type: 'assistant', message: { content: 'Answer' } }),
					].join('\n');
				}
				return [
					JSON.stringify({
						type: 'response_item',
						payload: { type: 'message', role: 'assistant' },
					}),
					JSON.stringify({
						type: 'event_msg',
						payload: {
							type: 'token_count',
							info: {
								total_token_usage: {
									input_tokens: 5,
									output_tokens: 4,
									reasoning_output_tokens: 1,
									cached_input_tokens: 2,
								},
							},
						},
					}),
					'not json',
				].join('\n');
			});

			const result = await handlers.get('agentSessions:getGlobalStats')!({} as any);

			expect(result).toMatchObject({
				totalSessions: 2,
				totalMessages: 3,
				totalInputTokens: 16,
				totalOutputTokens: 12,
				totalCacheReadTokens: 5,
				totalCacheCreationTokens: 2,
				totalCostUsd: 0.04,
				totalSizeBytes: 200,
				isComplete: true,
			});
			expect(pricingMock.computeClaudeUsageCost).toHaveBeenCalledWith(
				expect.stringContaining('"assistant"')
			);
			expect(statsCacheMock.saveGlobalStatsCache).toHaveBeenCalledWith(
				expect.objectContaining({
					version: 3,
					providers: {
						'claude-code': {
							sessions: expect.objectContaining({
								'encoded-project/claude-session': expect.objectContaining({
									messages: 2,
									fileMtimeMs: 100,
									archived: false,
								}),
							}),
						},
						codex: {
							sessions: expect.objectContaining({
								'2026/06/18/rollout-session': expect.objectContaining({
									messages: 1,
									inputTokens: 5,
									outputTokens: 5,
									cachedInputTokens: 2,
									fileMtimeMs: 200,
									archived: false,
								}),
							}),
						},
					},
				})
			);
		});
	});
});
