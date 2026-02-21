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
	getGeminiStatsStore,
	parseGeminiSessionContent,
} from '../../../../main/ipc/handlers/agentSessions';
import * as agentSessionStorage from '../../../../main/agents';
import { GEMINI_SESSION_STATS_DEFAULTS } from '../../../../main/stores/defaults';
import type { GeminiSessionStatsData, GeminiSessionTokenStats } from '../../../../main/stores/types';

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

	describe('agentSessions:getAllNamedSessions', () => {
		it('should aggregate named sessions from all storages that support getAllNamedSessions', async () => {
			const mockGeminiStorage = {
				agentId: 'gemini-cli',
				getAllNamedSessions: vi.fn().mockResolvedValue([
					{ agentSessionId: 'gem-1', projectPath: '/project', sessionName: 'Gemini Chat', starred: true },
				]),
			};

			const mockClaudeStorage = {
				agentId: 'claude-code',
				getAllNamedSessions: vi.fn().mockResolvedValue([
					{ agentSessionId: 'claude-1', projectPath: '/project', sessionName: 'Claude Chat' },
					{ agentSessionId: 'claude-2', projectPath: '/other', sessionName: 'Claude Debug', starred: false },
				]),
			};

			// A storage without getAllNamedSessions (e.g., terminal)
			const mockTerminalStorage = {
				agentId: 'terminal',
			};

			vi.mocked(agentSessionStorage.getAllSessionStorages).mockReturnValue(
				[mockGeminiStorage, mockClaudeStorage, mockTerminalStorage] as unknown as agentSessionStorage.AgentSessionStorage[]
			);

			const handler = handlers.get('agentSessions:getAllNamedSessions');
			const result = await handler!({} as any);

			// Should have 3 total (1 gemini + 2 claude), terminal excluded
			expect(result).toHaveLength(3);

			// Verify agentId is added to each session
			expect(result).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						agentId: 'gemini-cli',
						agentSessionId: 'gem-1',
						sessionName: 'Gemini Chat',
						starred: true,
					}),
					expect.objectContaining({
						agentId: 'claude-code',
						agentSessionId: 'claude-1',
						sessionName: 'Claude Chat',
					}),
					expect.objectContaining({
						agentId: 'claude-code',
						agentSessionId: 'claude-2',
						sessionName: 'Claude Debug',
						starred: false,
					}),
				])
			);
		});

		it('should return empty array when no storages support getAllNamedSessions', async () => {
			const mockStorage = {
				agentId: 'terminal',
				// No getAllNamedSessions method
			};

			vi.mocked(agentSessionStorage.getAllSessionStorages).mockReturnValue(
				[mockStorage] as unknown as agentSessionStorage.AgentSessionStorage[]
			);

			const handler = handlers.get('agentSessions:getAllNamedSessions');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});

		it('should continue aggregating if one storage throws an error', async () => {
			const mockFailingStorage = {
				agentId: 'codex',
				getAllNamedSessions: vi.fn().mockRejectedValue(new Error('Storage error')),
			};

			const mockWorkingStorage = {
				agentId: 'gemini-cli',
				getAllNamedSessions: vi.fn().mockResolvedValue([
					{ agentSessionId: 'gem-1', projectPath: '/project', sessionName: 'Gemini Session' },
				]),
			};

			vi.mocked(agentSessionStorage.getAllSessionStorages).mockReturnValue(
				[mockFailingStorage, mockWorkingStorage] as unknown as agentSessionStorage.AgentSessionStorage[]
			);

			const handler = handlers.get('agentSessions:getAllNamedSessions');
			const result = await handler!({} as any);

			// Should still return the working storage's sessions
			expect(result).toHaveLength(1);
			expect(result[0].agentId).toBe('gemini-cli');
			expect(result[0].agentSessionId).toBe('gem-1');
		});
	});

	describe('gemini session stats store', () => {
		it('should return undefined when no store is provided', () => {
			// Default registration (no deps) should leave gemini stats store undefined
			expect(getGeminiStatsStore()).toBeUndefined();
		});

		it('should store reference when geminiSessionStatsStore is provided via deps', () => {
			const mockStore = {
				get: vi.fn(),
				set: vi.fn(),
				store: { stats: {} },
			};

			// Re-register with the mock store
			registerAgentSessionsHandlers({
				getMainWindow: () => null,
				geminiSessionStatsStore: mockStore as any,
			});

			expect(getGeminiStatsStore()).toBe(mockStore);
		});

		it('should have correct schema defaults with empty stats record', () => {
			// Verify the store defaults match the expected GeminiSessionStatsData shape
			expect(GEMINI_SESSION_STATS_DEFAULTS).toEqual({ stats: {} });
			expect(GEMINI_SESSION_STATS_DEFAULTS.stats).toEqual({});
		});

		it('should accept GeminiSessionTokenStats entries keyed by session UUID', () => {
			// Verify the store schema supports the expected data shape
			const entry: GeminiSessionTokenStats = {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 10,
				reasoningTokens: 5,
				lastUpdatedMs: Date.now(),
			};
			const storeData: GeminiSessionStatsData = {
				stats: { 'gemini-uuid-abc': entry },
			};
			expect(storeData.stats['gemini-uuid-abc']).toMatchObject({
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 10,
				reasoningTokens: 5,
			});
			expect(storeData.stats['gemini-uuid-abc'].lastUpdatedMs).toBeGreaterThan(0);
		});
	});

	describe('parseGeminiSessionContent', () => {
		it('should parse messages and return zeroed tokens when no token data in session', () => {
			const content = JSON.stringify({
				messages: [
					{ type: 'user' },
					{ type: 'gemini' },
					{ type: 'user' },
					{ type: 'gemini' },
				],
			});
			const result = parseGeminiSessionContent(content, 1024);
			expect(result.messages).toBe(4);
			expect(result.inputTokens).toBe(0);
			expect(result.outputTokens).toBe(0);
			expect(result.cachedInputTokens).toBe(0);
			expect(result.sizeBytes).toBe(1024);
		});

		it('should fall back to persistedStats when message-level tokens are 0', () => {
			const content = JSON.stringify({
				messages: [
					{ type: 'user' },
					{ type: 'gemini' },
				],
			});
			const persistedStats = {
				inputTokens: 500,
				outputTokens: 1200,
				cacheReadTokens: 100,
				reasoningTokens: 50,
			};
			const result = parseGeminiSessionContent(content, 2048, persistedStats);
			expect(result.messages).toBe(2);
			expect(result.inputTokens).toBe(500);
			expect(result.outputTokens).toBe(1200);
			expect(result.cachedInputTokens).toBe(100);
			expect(result.sizeBytes).toBe(2048);
		});

		it('should NOT fall back to persistedStats when message-level tokens are non-zero', () => {
			// Hypothetical: if Gemini ever adds token data to messages
			const content = JSON.stringify({
				messages: [
					{ type: 'user', tokens: { input: 10, output: 20 } },
				],
			});
			const persistedStats = {
				inputTokens: 500,
				outputTokens: 1200,
				cacheReadTokens: 100,
				reasoningTokens: 50,
			};
			const result = parseGeminiSessionContent(content, 512, persistedStats);
			// Should use the message-level data, not the persisted fallback
			expect(result.inputTokens).toBe(10);
			expect(result.outputTokens).toBe(20);
		});

		it('should handle empty/invalid JSON gracefully with persistedStats fallback', () => {
			const persistedStats = {
				inputTokens: 300,
				outputTokens: 600,
				cacheReadTokens: 50,
				reasoningTokens: 0,
			};
			const result = parseGeminiSessionContent('not valid json', 100, persistedStats);
			expect(result.messages).toBe(0);
			// Parse failed, tokens are 0, so persisted stats should be used
			expect(result.inputTokens).toBe(300);
			expect(result.outputTokens).toBe(600);
			expect(result.cachedInputTokens).toBe(50);
		});

		it('should handle missing messages array', () => {
			const content = JSON.stringify({ sessionId: 'abc-123' });
			const result = parseGeminiSessionContent(content, 50);
			expect(result.messages).toBe(0);
			expect(result.inputTokens).toBe(0);
			expect(result.outputTokens).toBe(0);
		});

		it('should not use persistedStats when undefined', () => {
			const content = JSON.stringify({
				messages: [{ type: 'user' }],
			});
			const result = parseGeminiSessionContent(content, 100);
			expect(result.inputTokens).toBe(0);
			expect(result.outputTokens).toBe(0);
			expect(result.cachedInputTokens).toBe(0);
		});
	});

	describe('sessionId extraction regex (used in getGlobalStats)', () => {
		// This regex is used in getGlobalStats() to extract the sessionId from
		// Gemini session JSON files and look up persisted token stats by UUID.
		const SESSION_ID_REGEX = /"sessionId"\s*:\s*"([^"]+)"/;

		it('should extract sessionId from a realistic Gemini session JSON', () => {
			const content = JSON.stringify({
				sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
				messages: [
					{ type: 'user', content: 'Hello' },
					{ type: 'gemini', content: 'Hi there' },
				],
				startTime: '2026-02-21T10:00:00Z',
				lastUpdated: '2026-02-21T10:05:00Z',
			});
			const match = content.match(SESSION_ID_REGEX);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
		});

		it('should match the same UUID format emitted by init events', () => {
			// The init event emits session_id (snake_case), parser maps to sessionId (camelCase).
			// The session file stores sessionId (camelCase). Both should contain the same UUID.
			const uuid = 'abc-123-def-456';
			const sessionFile = JSON.stringify({ sessionId: uuid, messages: [] });
			const match = sessionFile.match(SESSION_ID_REGEX);
			expect(match).not.toBeNull();
			expect(match![1]).toBe(uuid);
		});

		it('should not match when sessionId field is absent', () => {
			const content = JSON.stringify({ messages: [{ type: 'user' }] });
			const match = content.match(SESSION_ID_REGEX);
			expect(match).toBeNull();
		});

		it('should handle whitespace variations in JSON formatting', () => {
			// JSON.stringify uses no spaces, but manually-formatted JSON might
			const content = '{"sessionId" : "spaced-uuid-123", "messages": []}';
			const match = content.match(SESSION_ID_REGEX);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('spaced-uuid-123');
		});

		it('should enable correct persisted stats lookup', () => {
			// End-to-end: extract sessionId from file, look up in persisted stats, pass to parser
			const uuid = 'live-session-uuid-789';
			const sessionContent = JSON.stringify({
				sessionId: uuid,
				messages: [{ type: 'user' }, { type: 'gemini' }],
			});

			const allPersistedStats: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number }> = {
				[uuid]: { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 300, reasoningTokens: 100 },
				'other-uuid': { inputTokens: 50, outputTokens: 50, cacheReadTokens: 0, reasoningTokens: 0 },
			};

			// Extract sessionId (mirrors getGlobalStats logic)
			const match = sessionContent.match(SESSION_ID_REGEX);
			const persistedStats = match?.[1] ? allPersistedStats[match[1]] : undefined;

			// Pass to parser (mirrors getGlobalStats logic)
			const result = parseGeminiSessionContent(sessionContent, 512, persistedStats);
			expect(result.inputTokens).toBe(1000);
			expect(result.outputTokens).toBe(2000);
			expect(result.cachedInputTokens).toBe(300);
		});
	});
});
