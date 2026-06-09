/**
 * Tests for the agentSessions IPC handlers
 *
 * These tests verify the generic agent session management API that works
 * with any agent supporting the AgentSessionStorage interface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerAgentSessionsHandlers } from '../../../../main/ipc/handlers/agentSessions';
import * as agentSessionStorage from '../../../../main/agents';
import fs from 'fs/promises';
import * as statsCache from '../../../../main/utils/statsCache';
import { calculateClaudeCost } from '../../../../main/utils/pricing';
import { isWebContentsAvailable } from '../../../../main/utils/safe-send';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

vi.mock('os', () => ({
	default: {
		homedir: vi.fn(() => '/home/test-user'),
	},
}));

vi.mock('fs/promises', () => ({
	default: {
		access: vi.fn(),
		readdir: vi.fn(),
		stat: vi.fn(),
		readFile: vi.fn(),
	},
}));

// Mock the agents module (session storage exports)
vi.mock('../../../../main/agents', () => ({
	getSessionStorage: vi.fn(),
	hasSessionStorage: vi.fn(),
	getAllSessionStorages: vi.fn(),
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

vi.mock('../../../../main/utils/pricing', () => ({
	calculateClaudeCost: vi.fn(() => 1.5),
}));

vi.mock('../../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn(() => true),
}));

vi.mock('../../../../main/utils/statsCache', () => ({
	GLOBAL_STATS_CACHE_VERSION: 1,
	loadGlobalStatsCache: vi.fn(),
	saveGlobalStatsCache: vi.fn(),
}));

type MockStore<T> = {
	data: T;
	get: ReturnType<typeof vi.fn>;
	set: ReturnType<typeof vi.fn>;
};

function createStore<T extends Record<string, unknown>>(initialData: T): MockStore<T> {
	const store: MockStore<T> = {
		data: initialData,
		get: vi.fn((key: string, defaultValue?: unknown) => store.data[key] ?? defaultValue),
		set: vi.fn((key: string, value: unknown) => {
			store.data[key as keyof T] = value as T[keyof T];
		}),
	};
	return store;
}

function jsonl(...entries: Record<string, unknown>[]): string {
	return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

describe('agentSessions IPC handlers', () => {
	let handlers: Map<string, Function>;

	function registerHandlers(deps?: Parameters<typeof registerAgentSessionsHandlers>[0]) {
		handlers.clear();
		registerAgentSessionsHandlers(deps);
	}

	beforeEach(() => {
		// Clear mocks
		vi.clearAllMocks();

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers
		registerHandlers();
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

		it('should resolve enabled SSH remotes from the settings store', async () => {
			const sshConfig = { id: 'remote-1', enabled: true, host: 'remote.example.com' };
			const settingsStore = createStore({ sshRemotes: [sshConfig] });
			registerHandlers({ settingsStore: settingsStore as any });
			const mockStorage = {
				agentId: 'claude-code',
				listSessions: vi.fn().mockResolvedValue([{ sessionId: 'session-1' }]),
			};
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:list');
			await handler!({} as any, 'claude-code', '/test', 'remote-1');

			expect(settingsStore.get).toHaveBeenCalledWith('sshRemotes', []);
			expect(mockStorage.listSessions).toHaveBeenCalledWith('/test', sshConfig);
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

		it('should resolve enabled SSH remotes from settings for paginated lists', async () => {
			const sshConfig = { id: 'remote-1', enabled: true, host: 'remote.example.com' };
			const settingsStore = createStore({ sshRemotes: [sshConfig] });
			registerHandlers({ settingsStore: settingsStore as any });
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
			const result = await handler!({} as any, 'claude-code', '/test', { limit: 10 }, 'remote-1');

			expect(mockStorage.listSessionsPaginated).toHaveBeenCalledWith(
				'/test',
				{ limit: 10 },
				sshConfig
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

		it('should resolve enabled SSH remotes from settings for message reads', async () => {
			const sshConfig = { id: 'remote-1', enabled: true, host: 'remote.example.com' };
			const settingsStore = createStore({ sshRemotes: [sshConfig] });
			registerHandlers({ settingsStore: settingsStore as any });
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
				'remote-1'
			);

			expect(mockStorage.readSessionMessages).toHaveBeenCalledWith(
				'/test',
				'session-1',
				{ offset: 0, limit: 20 },
				sshConfig
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

		it('should resolve enabled SSH remotes from settings for searches', async () => {
			const sshConfig = { id: 'remote-1', enabled: true, host: 'remote.example.com' };
			const settingsStore = createStore({ sshRemotes: [sshConfig] });
			registerHandlers({ settingsStore: settingsStore as any });
			const mockResults = [
				{
					sessionId: 'session-1',
					matchType: 'content' as const,
					matchPreview: 'hello',
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
			const result = await handler!({} as any, 'claude-code', '/test', 'hello', 'all', 'remote-1');

			expect(mockStorage.searchSessions).toHaveBeenCalledWith('/test', 'hello', 'all', sshConfig);
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

	describe('agentSessions:getAllNamedSessions', () => {
		it('should aggregate named sessions from storages that support them and ignore failures', async () => {
			const namedStorage = {
				agentId: 'claude-code',
				getAllNamedSessions: vi.fn().mockResolvedValue([
					{
						agentSessionId: 'session-1',
						projectPath: '/test',
						sessionName: 'Named',
						starred: true,
						lastActivityAt: 123,
					},
				]),
			};
			const failingStorage = {
				agentId: 'opencode',
				getAllNamedSessions: vi.fn().mockRejectedValue(new Error('store failed')),
			};
			const unsupportedStorage = { agentId: 'codex' };
			vi.mocked(agentSessionStorage.getAllSessionStorages).mockReturnValue([
				namedStorage,
				failingStorage,
				unsupportedStorage,
			] as unknown as agentSessionStorage.AgentSessionStorage[]);

			const handler = handlers.get('agentSessions:getAllNamedSessions');
			const result = await handler!({} as any);

			expect(result).toEqual([
				{
					agentId: 'claude-code',
					agentSessionId: 'session-1',
					projectPath: '/test',
					sessionName: 'Named',
					starred: true,
					lastActivityAt: 123,
				},
			]);
			expect(failingStorage.getAllNamedSessions).toHaveBeenCalled();
		});
	});

	describe('generic session origins', () => {
		it('should return empty origins when no origins store is configured', async () => {
			const handler = handlers.get('agentSessions:getOrigins');

			await expect(handler!({} as any, 'codex', '/test')).resolves.toEqual({});
		});

		it('should get, set, clear, and clean up generic session names and stars', async () => {
			const originsStore = createStore({
				origins: {
					codex: {
						'/test': {
							'session-1': { origin: 'auto' as const, sessionName: 'Old' },
							'session-2': { starred: true },
						},
					},
				},
			});
			registerHandlers({ agentSessionOriginsStore: originsStore as any });

			const getOrigins = handlers.get('agentSessions:getOrigins');
			const setName = handlers.get('agentSessions:setSessionName');
			const setStarred = handlers.get('agentSessions:setSessionStarred');

			await expect(getOrigins!({} as any, 'codex', '/test')).resolves.toEqual({
				'session-1': { origin: 'auto', sessionName: 'Old' },
				'session-2': { starred: true },
			});
			await expect(getOrigins!({} as any, 'missing-agent', '/test')).resolves.toEqual({});
			await expect(getOrigins!({} as any, 'codex', '/missing-project')).resolves.toEqual({});

			await setName!({} as any, 'codex', '/test', 'session-1', 'Renamed');
			expect(originsStore.data.origins.codex['/test']['session-1']).toMatchObject({
				origin: 'auto',
				sessionName: 'Renamed',
			});

			await setName!({} as any, 'codex', '/test', 'session-1', null);
			expect(originsStore.data.origins.codex['/test']['session-1']).toEqual({
				origin: 'auto',
			});
			await setName!({} as any, 'codex', '/test', 'missing-session', null);
			expect(originsStore.data.origins.codex['/test']['missing-session']).toBeUndefined();

			await setStarred!({} as any, 'codex', '/test', 'session-2', false);
			expect(originsStore.data.origins.codex['/test']['session-2']).toBeUndefined();

			await setStarred!({} as any, 'codex', '/test', 'session-1', true);
			await setStarred!({} as any, 'codex', '/test', 'session-1', false);
			expect(originsStore.data.origins.codex['/test']['session-1']).toEqual({
				origin: 'auto',
			});

			await setStarred!({} as any, 'codex', '/test', 'session-3', true);
			expect(originsStore.data.origins.codex['/test']['session-3']).toEqual({
				starred: true,
			});
		});

		it('should no-op name and star updates when no origins store is configured', async () => {
			const setName = handlers.get('agentSessions:setSessionName');
			const setStarred = handlers.get('agentSessions:setSessionStarred');

			await expect(
				setName!({} as any, 'codex', '/test', 'session-1', 'Name')
			).resolves.toBeUndefined();
			await expect(
				setStarred!({} as any, 'codex', '/test', 'session-1', true)
			).resolves.toBeUndefined();
		});

		it('should create missing origins buckets and clean empty metadata entries', async () => {
			const originsStore = createStore({ origins: {} });
			registerHandlers({ agentSessionOriginsStore: originsStore as any });

			const setName = handlers.get('agentSessions:setSessionName');
			const setStarred = handlers.get('agentSessions:setSessionStarred');

			await setName!({} as any, 'codex', '/new-project', 'session-1', 'New Name');
			expect(originsStore.data.origins.codex['/new-project']['session-1']).toEqual({
				sessionName: 'New Name',
			});

			await setName!({} as any, 'codex', '/new-project', 'session-1', null);
			expect(originsStore.data.origins.codex['/new-project']['session-1']).toBeUndefined();

			await setStarred!({} as any, 'opencode', '/star-project', 'session-2', true);
			expect(originsStore.data.origins.opencode['/star-project']['session-2']).toEqual({
				starred: true,
			});

			await setStarred!({} as any, 'codex', '/new-project', 'missing-session', false);
			expect(originsStore.data.origins.codex['/new-project']['missing-session']).toBeUndefined();
		});
	});

	describe('agentSessions:getGlobalStats', () => {
		function setupGlobalStatsFiles() {
			const dirs: Record<string, string[]> = {
				'/home/test-user/.claude/projects': ['-repo-project', 'not-a-dir'],
				'/home/test-user/.claude/projects/-repo-project': [
					'claude-1.jsonl',
					'empty.jsonl',
					'notes.txt',
				],
				'/home/test-user/.codex/sessions': ['2026', '2027', '2028', 'notes'],
				'/home/test-user/.codex/sessions/2026': ['05', '06', '07', 'bad'],
				'/home/test-user/.codex/sessions/2026/05': ['11', '12', '13', '99', 'bad-day'],
				'/home/test-user/.codex/sessions/2026/05/11': [
					'codex-1.jsonl',
					'zero.jsonl',
					'notes.txt',
					'missing-stat.jsonl',
				],
			};
			const files: Record<string, string> = {
				'/home/test-user/.claude/projects/-repo-project/claude-1.jsonl': jsonl(
					{ type: 'user', message: { content: 'hello' } },
					{ type: 'assistant', message: { content: 'hi' } },
					{
						type: 'result',
						usage: {
							input_tokens: 10,
							output_tokens: 20,
							cache_read_input_tokens: 3,
							cache_creation_input_tokens: 4,
						},
					}
				),
				'/home/test-user/.claude/projects/-repo-project/empty.jsonl': '',
				'/home/test-user/.codex/sessions/2026/05/11/codex-1.jsonl': jsonl(
					{ type: 'response_item', payload: { type: 'message', role: 'user' } },
					{ type: 'response_item', payload: { type: 'message', role: 'assistant' } },
					{ type: 'response_item', payload: { type: 'message', role: 'system' } },
					{
						type: 'event_msg',
						payload: {
							type: 'token_count',
							info: {
								total_token_usage: {
									input_tokens: 7,
									output_tokens: 11,
									reasoning_output_tokens: 5,
									cached_input_tokens: 2,
								},
							},
						},
					},
					{
						type: 'event_msg',
						payload: {
							type: 'token_count',
							info: { total_token_usage: {} },
						},
					},
					{ type: 'event_msg', payload: { type: 'token_count', info: {} } },
					{ type: 'event_msg', payload: { type: 'token_count' } },
					'{malformed'
				),
				'/home/test-user/.codex/sessions/2026/05/11/zero.jsonl': '',
			};
			const directorySet = new Set(Object.keys(dirs));
			const mtimeMs = new Date('2026-05-11T10:00:00.000Z').getTime();

			vi.mocked(fs.access).mockImplementation(async (target: string) => {
				if (dirs[target] || files[target] !== undefined) return undefined;
				throw new Error(`missing ${target}`);
			});
			vi.mocked(fs.readdir).mockImplementation(async (target: string) => {
				if (dirs[target]) {
					return dirs[target] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
				}
				throw new Error(`missing dir ${target}`);
			});
			vi.mocked(fs.stat).mockImplementation(async (target: string) => {
				if (directorySet.has(target)) {
					return {
						isDirectory: () => true,
						size: 0,
						mtimeMs,
					} as Awaited<ReturnType<typeof fs.stat>>;
				}
				if (
					target.endsWith('not-a-dir') ||
					target.endsWith('/2027') ||
					target.endsWith('/06') ||
					target.endsWith('/12')
				) {
					return {
						isDirectory: () => false,
						size: 0,
						mtimeMs,
					} as Awaited<ReturnType<typeof fs.stat>>;
				}
				if (files[target] !== undefined) {
					return {
						isDirectory: () => false,
						size: Buffer.byteLength(files[target]),
						mtimeMs,
					} as Awaited<ReturnType<typeof fs.stat>>;
				}
				throw new Error(`missing stat ${target}`);
			});
			vi.mocked(fs.readFile).mockImplementation(async (target: string) => {
				if (files[target] !== undefined) return files[target];
				throw new Error(`missing file ${target}`);
			});
		}

		function cachedStats(
			overrides: Partial<statsCache.CachedSessionStats> = {}
		): statsCache.CachedSessionStats {
			return {
				messages: 1,
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				cachedInputTokens: 0,
				sizeBytes: 10,
				fileMtimeMs: new Date('2026-05-11T10:00:00.000Z').getTime(),
				archived: false,
				...overrides,
			};
		}

		it('discovers Claude and Codex sessions, updates cache, and sends progress updates', async () => {
			setupGlobalStatsFiles();
			vi.mocked(statsCache.loadGlobalStatsCache).mockResolvedValue(null);
			vi.mocked(statsCache.saveGlobalStatsCache).mockResolvedValue(undefined);
			vi.mocked(isWebContentsAvailable).mockReturnValue(true);
			const mainWindow = { webContents: { send: vi.fn() } };
			registerHandlers({ getMainWindow: () => mainWindow as any });

			const handler = handlers.get('agentSessions:getGlobalStats');
			const result = await handler!({} as any);

			expect(result).toMatchObject({
				totalSessions: 2,
				totalMessages: 4,
				totalInputTokens: 17,
				totalOutputTokens: 36,
				totalCacheReadTokens: 5,
				totalCacheCreationTokens: 4,
				totalCostUsd: 1.5,
				hasCostData: true,
				isComplete: true,
				byProvider: {
					'claude-code': {
						sessions: 1,
						messages: 2,
						inputTokens: 10,
						outputTokens: 20,
						costUsd: 1.5,
						hasCostData: true,
					},
					codex: {
						sessions: 1,
						messages: 2,
						inputTokens: 7,
						outputTokens: 16,
						costUsd: 0,
						hasCostData: false,
					},
				},
			});
			expect(calculateClaudeCost).toHaveBeenCalledWith(10, 20, 3, 4);
			expect(statsCache.saveGlobalStatsCache).toHaveBeenCalledWith(
				expect.objectContaining({
					version: statsCache.GLOBAL_STATS_CACHE_VERSION,
					providers: expect.objectContaining({
						'claude-code': expect.objectContaining({
							sessions: expect.objectContaining({
								'-repo-project/claude-1': expect.objectContaining({
									messages: 2,
									archived: false,
								}),
							}),
						}),
						codex: expect.objectContaining({
							sessions: expect.objectContaining({
								'2026/05/11/codex-1': expect.objectContaining({
									messages: 2,
									cachedInputTokens: 2,
									archived: false,
								}),
							}),
						}),
					}),
				})
			);
			expect(mainWindow.webContents.send).toHaveBeenCalledWith(
				'agentSessions:globalStatsUpdate',
				expect.objectContaining({ isComplete: true, totalSessions: 2 })
			);
		});

		it('returns empty global stats when provider history directories are missing', async () => {
			vi.mocked(fs.access).mockRejectedValue(new Error('missing history'));
			vi.mocked(statsCache.loadGlobalStatsCache).mockResolvedValue(null);
			vi.mocked(statsCache.saveGlobalStatsCache).mockResolvedValue(undefined);
			vi.mocked(isWebContentsAvailable).mockReturnValue(false);

			const handler = handlers.get('agentSessions:getGlobalStats');
			const result = await handler!({} as any);

			expect(result).toMatchObject({
				totalSessions: 0,
				totalMessages: 0,
				hasCostData: false,
				isComplete: true,
				byProvider: {},
			});
			expect(statsCache.saveGlobalStatsCache).toHaveBeenCalledWith(
				expect.objectContaining({
					providers: {
						'claude-code': { sessions: {} },
						codex: { sessions: {} },
					},
				})
			);
		});

		it('preserves archived stats and reactivates cached sessions that reappear', async () => {
			setupGlobalStatsFiles();
			vi.mocked(statsCache.loadGlobalStatsCache).mockResolvedValue({
				version: statsCache.GLOBAL_STATS_CACHE_VERSION,
				lastUpdated: 1,
				providers: {
					'claude-code': {
						sessions: {
							'-repo-project/claude-1': cachedStats({ archived: true, messages: 2 }),
							'missing-project/deleted-claude': cachedStats({
								archived: false,
								messages: 3,
							}),
						},
					},
					codex: {
						sessions: {
							'2026/05/11/codex-1': cachedStats({
								archived: true,
								messages: 4,
								cachedInputTokens: 2,
							}),
							'2026/05/10/deleted-codex': cachedStats({
								archived: false,
								messages: 5,
							}),
						},
					},
				},
			});
			vi.mocked(statsCache.saveGlobalStatsCache).mockResolvedValue(undefined);
			vi.mocked(isWebContentsAvailable).mockReturnValue(false);

			const handler = handlers.get('agentSessions:getGlobalStats');
			const result = await handler!({} as any);

			expect(result.totalSessions).toBe(4);
			expect(result.totalMessages).toBe(14);
			expect(fs.readFile).not.toHaveBeenCalled();

			const savedCache = vi.mocked(statsCache.saveGlobalStatsCache).mock.calls[0][0];
			expect(savedCache.providers['claude-code'].sessions['-repo-project/claude-1'].archived).toBe(
				false
			);
			expect(
				savedCache.providers['claude-code'].sessions['missing-project/deleted-claude'].archived
			).toBe(true);
			expect(savedCache.providers.codex.sessions['2026/05/11/codex-1'].archived).toBe(false);
			expect(savedCache.providers.codex.sessions['2026/05/10/deleted-codex'].archived).toBe(true);
		});

		it('keeps active cached sessions active when their files are still present', async () => {
			setupGlobalStatsFiles();
			vi.mocked(statsCache.loadGlobalStatsCache).mockResolvedValue({
				version: statsCache.GLOBAL_STATS_CACHE_VERSION,
				lastUpdated: 1,
				providers: {
					'claude-code': {
						sessions: {
							'-repo-project/claude-1': cachedStats({ archived: false }),
						},
					},
					codex: {
						sessions: {
							'2026/05/11/codex-1': cachedStats({ archived: false }),
						},
					},
				},
			});
			vi.mocked(statsCache.saveGlobalStatsCache).mockResolvedValue(undefined);
			vi.mocked(isWebContentsAvailable).mockReturnValue(false);

			const handler = handlers.get('agentSessions:getGlobalStats');
			const result = await handler!({} as any);

			expect(result.totalSessions).toBe(2);
			const savedCache = vi.mocked(statsCache.saveGlobalStatsCache).mock.calls[0][0];
			expect(savedCache.providers['claude-code'].sessions['-repo-project/claude-1'].archived).toBe(
				false
			);
			expect(savedCache.providers.codex.sessions['2026/05/11/codex-1'].archived).toBe(false);
		});

		it('continues global stats processing when individual session files fail to parse', async () => {
			const claudeProjectDir = '/home/test-user/.claude/projects/-repo-project';
			const codexDayDir = '/home/test-user/.codex/sessions/2026/05/11';
			const dirs: Record<string, string[]> = {
				'/home/test-user/.claude/projects': ['-repo-project'],
				[claudeProjectDir]: ['bad.jsonl', 'good-a.jsonl', 'good-b.jsonl'],
				'/home/test-user/.codex/sessions': ['2026'],
				'/home/test-user/.codex/sessions/2026': ['05'],
				'/home/test-user/.codex/sessions/2026/05': ['11'],
				[codexDayDir]: ['bad.jsonl', 'good-a.jsonl', 'good-b.jsonl'],
			};
			const files: Record<string, string> = {
				[`${claudeProjectDir}/bad.jsonl`]: jsonl({ type: 'user' }),
				[`${claudeProjectDir}/good-a.jsonl`]: jsonl({ type: 'user' }),
				[`${claudeProjectDir}/good-b.jsonl`]: jsonl({ type: 'assistant' }),
				[`${codexDayDir}/bad.jsonl`]: jsonl({
					type: 'response_item',
					payload: { type: 'message', role: 'user' },
				}),
				[`${codexDayDir}/good-a.jsonl`]: jsonl({
					type: 'response_item',
					payload: { type: 'message', role: 'user' },
				}),
				[`${codexDayDir}/good-b.jsonl`]: jsonl({
					type: 'response_item',
					payload: { type: 'message', role: 'assistant' },
				}),
			};
			const directorySet = new Set(Object.keys(dirs));
			const mtimeMs = new Date('2026-05-11T10:00:00.000Z').getTime();

			vi.mocked(fs.access).mockImplementation(async (target: string) => {
				if (dirs[target] || files[target] !== undefined) return undefined;
				throw new Error(`missing ${target}`);
			});
			vi.mocked(fs.readdir).mockImplementation(async (target: string) => {
				if (dirs[target]) return dirs[target] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
				throw new Error(`missing dir ${target}`);
			});
			vi.mocked(fs.stat).mockImplementation(async (target: string) => {
				if (directorySet.has(target)) {
					return { isDirectory: () => true, size: 0, mtimeMs } as Awaited<
						ReturnType<typeof fs.stat>
					>;
				}
				if (files[target] !== undefined) {
					return {
						isDirectory: () => false,
						size: Buffer.byteLength(files[target]),
						mtimeMs,
					} as Awaited<ReturnType<typeof fs.stat>>;
				}
				throw new Error(`missing stat ${target}`);
			});
			vi.mocked(fs.readFile).mockImplementation(async (target: string) => {
				if (target.endsWith('/bad.jsonl')) throw new Error(`bad file ${target}`);
				return files[target];
			});
			vi.mocked(statsCache.loadGlobalStatsCache).mockResolvedValue(null);
			vi.mocked(statsCache.saveGlobalStatsCache).mockResolvedValue(undefined);
			vi.mocked(isWebContentsAvailable).mockReturnValue(false);

			const handler = handlers.get('agentSessions:getGlobalStats');
			const result = await handler!({} as any);

			expect(result.totalSessions).toBe(4);
			expect(result.totalMessages).toBe(4);
			expect(statsCache.saveGlobalStatsCache).toHaveBeenCalledWith(
				expect.objectContaining({
					providers: expect.objectContaining({
						'claude-code': expect.objectContaining({
							sessions: expect.not.objectContaining({ '-repo-project/bad': expect.anything() }),
						}),
						codex: expect.objectContaining({
							sessions: expect.not.objectContaining({
								'2026/05/11/bad': expect.anything(),
							}),
						}),
					}),
				})
			);
		});
	});
});
