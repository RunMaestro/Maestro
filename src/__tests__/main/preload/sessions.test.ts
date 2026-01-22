/**
 * Tests for sessions preload API
 *
 * Coverage:
 * - createClaudeApi (deprecated): listSessions, listSessionsPaginated, getProjectStats,
 *   readSessionMessages, searchSessions, deleteMessagePair
 * - createAgentSessionsApi: list, listPaginated, read, search, getPath, deleteMessagePair,
 *   hasStorage, getAvailableStorages, getGlobalStats, getAllNamedSessions, onGlobalStatsUpdate,
 *   registerSessionOrigin, updateSessionName, getOrigins, setSessionName, setSessionStarred
 *
 * Note: createClaudeApi is deprecated but still tested for backwards compatibility.
 * These tests ensure the deprecation warnings are logged correctly.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

// Mock console.warn for deprecation warnings
const mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createClaudeApi, createAgentSessionsApi } from '../../../main/preload/sessions';

describe('Sessions Preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockConsoleWarn.mockClear();
	});

	afterAll(() => {
		mockConsoleWarn.mockRestore();
	});

	describe('createClaudeApi (deprecated)', () => {
		let api: ReturnType<typeof createClaudeApi>;

		beforeEach(() => {
			api = createClaudeApi();
		});

		describe('listSessions', () => {
			it('should invoke claude:listSessions and log deprecation warning', async () => {
				mockInvoke.mockResolvedValue([]);

				await api.listSessions('/project');

				expect(mockInvoke).toHaveBeenCalledWith('claude:listSessions', '/project');
				expect(mockConsoleWarn).toHaveBeenCalledWith(expect.stringContaining('deprecated'));
			});
		});

		describe('listSessionsPaginated', () => {
			it('should invoke claude:listSessionsPaginated', async () => {
				mockInvoke.mockResolvedValue({ sessions: [], cursor: null });

				await api.listSessionsPaginated('/project', { limit: 10 });

				expect(mockInvoke).toHaveBeenCalledWith('claude:listSessionsPaginated', '/project', {
					limit: 10,
				});
			});
		});

		describe('getProjectStats', () => {
			it('should invoke claude:getProjectStats', async () => {
				mockInvoke.mockResolvedValue({ totalSessions: 5 });

				await api.getProjectStats('/project');

				expect(mockInvoke).toHaveBeenCalledWith('claude:getProjectStats', '/project');
			});
		});

		describe('readSessionMessages', () => {
			it('should invoke claude:readSessionMessages', async () => {
				mockInvoke.mockResolvedValue({ messages: [] });

				await api.readSessionMessages('/project', 'session-123', { limit: 50 });

				expect(mockInvoke).toHaveBeenCalledWith(
					'claude:readSessionMessages',
					'/project',
					'session-123',
					{ limit: 50 }
				);
			});
		});

		describe('searchSessions', () => {
			it('should invoke claude:searchSessions', async () => {
				mockInvoke.mockResolvedValue([]);

				await api.searchSessions('/project', 'query', 'all');

				expect(mockInvoke).toHaveBeenCalledWith(
					'claude:searchSessions',
					'/project',
					'query',
					'all'
				);
			});
		});

		describe('deleteMessagePair', () => {
			it('should invoke claude:deleteMessagePair', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.deleteMessagePair('/project', 'session-123', 'uuid-456', 'fallback');

				expect(mockInvoke).toHaveBeenCalledWith(
					'claude:deleteMessagePair',
					'/project',
					'session-123',
					'uuid-456',
					'fallback'
				);
			});
		});
	});

	describe('createAgentSessionsApi', () => {
		let api: ReturnType<typeof createAgentSessionsApi>;

		beforeEach(() => {
			api = createAgentSessionsApi();
		});

		describe('list', () => {
			it('should invoke agentSessions:list', async () => {
				mockInvoke.mockResolvedValue([]);

				await api.list('claude-code', '/project');

				expect(mockInvoke).toHaveBeenCalledWith(
					'agentSessions:list',
					'claude-code',
					'/project',
					undefined
				);
			});

			it('should invoke with sshRemoteId', async () => {
				mockInvoke.mockResolvedValue([]);

				await api.list('claude-code', '/project', 'ssh-remote-1');

				expect(mockInvoke).toHaveBeenCalledWith(
					'agentSessions:list',
					'claude-code',
					'/project',
					'ssh-remote-1'
				);
			});
		});

		describe('listPaginated', () => {
			it('should invoke agentSessions:listPaginated', async () => {
				mockInvoke.mockResolvedValue({ sessions: [], cursor: null });

				await api.listPaginated('claude-code', '/project', { limit: 20 });

				expect(mockInvoke).toHaveBeenCalledWith(
					'agentSessions:listPaginated',
					'claude-code',
					'/project',
					{ limit: 20 },
					undefined
				);
			});
		});

		describe('read', () => {
			it('should invoke agentSessions:read', async () => {
				mockInvoke.mockResolvedValue({ messages: [] });

				await api.read('claude-code', '/project', 'session-123', { offset: 0, limit: 50 });

				expect(mockInvoke).toHaveBeenCalledWith(
					'agentSessions:read',
					'claude-code',
					'/project',
					'session-123',
					{ offset: 0, limit: 50 },
					undefined
				);
			});
		});

		describe('search', () => {
			it('should invoke agentSessions:search', async () => {
				mockInvoke.mockResolvedValue([]);

				await api.search('claude-code', '/project', 'search query', 'title');

				expect(mockInvoke).toHaveBeenCalledWith(
					'agentSessions:search',
					'claude-code',
					'/project',
					'search query',
					'title',
					undefined
				);
			});
		});

		describe('getPath', () => {
			it('should invoke agentSessions:getPath', async () => {
				mockInvoke.mockResolvedValue('/path/to/session.json');

				const result = await api.getPath('claude-code', '/project', 'session-123');

				expect(mockInvoke).toHaveBeenCalledWith(
					'agentSessions:getPath',
					'claude-code',
					'/project',
					'session-123',
					undefined
				);
				expect(result).toBe('/path/to/session.json');
			});
		});

		describe('deleteMessagePair', () => {
			it('should invoke agentSessions:deleteMessagePair', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.deleteMessagePair('claude-code', '/project', 'session-123', 'uuid-456');

				expect(mockInvoke).toHaveBeenCalledWith(
					'agentSessions:deleteMessagePair',
					'claude-code',
					'/project',
					'session-123',
					'uuid-456',
					undefined
				);
			});
		});

		describe('hasStorage', () => {
			it('should invoke agentSessions:hasStorage', async () => {
				mockInvoke.mockResolvedValue(true);

				const result = await api.hasStorage('claude-code');

				expect(mockInvoke).toHaveBeenCalledWith('agentSessions:hasStorage', 'claude-code');
				expect(result).toBe(true);
			});
		});

		describe('getAvailableStorages', () => {
			it('should invoke agentSessions:getAvailableStorages', async () => {
				mockInvoke.mockResolvedValue(['claude-code', 'opencode']);

				const result = await api.getAvailableStorages();

				expect(mockInvoke).toHaveBeenCalledWith('agentSessions:getAvailableStorages');
				expect(result).toEqual(['claude-code', 'opencode']);
			});
		});

		describe('getGlobalStats', () => {
			it('should invoke agentSessions:getGlobalStats', async () => {
				const stats = { totalSessions: 100, totalMessages: 1000 };
				mockInvoke.mockResolvedValue(stats);

				const result = await api.getGlobalStats();

				expect(mockInvoke).toHaveBeenCalledWith('agentSessions:getGlobalStats');
				expect(result).toEqual(stats);
			});
		});

		describe('getAllNamedSessions', () => {
			it('should invoke agentSessions:getAllNamedSessions', async () => {
				const sessions = [
					{
						agentId: 'claude-code',
						agentSessionId: '123',
						projectPath: '/project',
						sessionName: 'Test',
					},
				];
				mockInvoke.mockResolvedValue(sessions);

				const result = await api.getAllNamedSessions();

				expect(mockInvoke).toHaveBeenCalledWith('agentSessions:getAllNamedSessions');
				expect(result).toEqual(sessions);
			});
		});

		describe('onGlobalStatsUpdate', () => {
			it('should register event listener and return cleanup function', () => {
				const callback = vi.fn();

				const cleanup = api.onGlobalStatsUpdate(callback);

				expect(mockOn).toHaveBeenCalledWith(
					'agentSessions:globalStatsUpdate',
					expect.any(Function)
				);
				expect(typeof cleanup).toBe('function');
			});

			it('should call callback when event is received', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, stats: unknown) => void;

				mockOn.mockImplementation(
					(_channel: string, handler: (event: unknown, stats: unknown) => void) => {
						registeredHandler = handler;
					}
				);

				api.onGlobalStatsUpdate(callback);

				const stats = { totalSessions: 50 };
				registeredHandler!({}, stats);

				expect(callback).toHaveBeenCalledWith(stats);
			});

			it('should remove listener when cleanup is called', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, stats: unknown) => void;

				mockOn.mockImplementation(
					(_channel: string, handler: (event: unknown, stats: unknown) => void) => {
						registeredHandler = handler;
					}
				);

				const cleanup = api.onGlobalStatsUpdate(callback);
				cleanup();

				expect(mockRemoveListener).toHaveBeenCalledWith(
					'agentSessions:globalStatsUpdate',
					registeredHandler!
				);
			});
		});

		describe('registerSessionOrigin', () => {
			it('should invoke claude:registerSessionOrigin', async () => {
				mockInvoke.mockResolvedValue(true);

				await api.registerSessionOrigin('/project', 'agent-session-123', 'user', 'My Session');

				expect(mockInvoke).toHaveBeenCalledWith(
					'claude:registerSessionOrigin',
					'/project',
					'agent-session-123',
					'user',
					'My Session'
				);
			});
		});

		describe('updateSessionName', () => {
			it('should invoke claude:updateSessionName', async () => {
				mockInvoke.mockResolvedValue(true);

				await api.updateSessionName('/project', 'agent-session-123', 'New Name');

				expect(mockInvoke).toHaveBeenCalledWith(
					'claude:updateSessionName',
					'/project',
					'agent-session-123',
					'New Name'
				);
			});
		});

		describe('getOrigins', () => {
			it('should invoke agentSessions:getOrigins', async () => {
				const origins = { 'session-1': { origin: 'user', sessionName: 'Test' } };
				mockInvoke.mockResolvedValue(origins);

				const result = await api.getOrigins('claude-code', '/project');

				expect(mockInvoke).toHaveBeenCalledWith(
					'agentSessions:getOrigins',
					'claude-code',
					'/project'
				);
				expect(result).toEqual(origins);
			});
		});

		describe('setSessionName', () => {
			it('should invoke agentSessions:setSessionName', async () => {
				mockInvoke.mockResolvedValue(true);

				await api.setSessionName('claude-code', '/project', 'session-123', 'New Name');

				expect(mockInvoke).toHaveBeenCalledWith(
					'agentSessions:setSessionName',
					'claude-code',
					'/project',
					'session-123',
					'New Name'
				);
			});

			it('should handle null to clear name', async () => {
				mockInvoke.mockResolvedValue(true);

				await api.setSessionName('claude-code', '/project', 'session-123', null);

				expect(mockInvoke).toHaveBeenCalledWith(
					'agentSessions:setSessionName',
					'claude-code',
					'/project',
					'session-123',
					null
				);
			});
		});

		describe('setSessionStarred', () => {
			it('should invoke agentSessions:setSessionStarred', async () => {
				mockInvoke.mockResolvedValue(true);

				await api.setSessionStarred('claude-code', '/project', 'session-123', true);

				expect(mockInvoke).toHaveBeenCalledWith(
					'agentSessions:setSessionStarred',
					'claude-code',
					'/project',
					'session-123',
					true
				);
			});
		});
	});
});
