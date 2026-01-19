/**
 * Tests for the agentSessions IPC handlers
 *
 * These tests verify the generic agent session management API that works
 * with any agent supporting the AgentSessionStorage interface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerAgentSessionsHandlers } from '../../../../main/ipc/handlers/agentSessions';
import * as agentSessionStorage from '../../../../main/agent-session-storage';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock the agent-session-storage module
vi.mock('../../../../main/agent-session-storage', () => ({
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
