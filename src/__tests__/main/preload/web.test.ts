/**
 * Tests for web preload API
 *
 * Coverage:
 * - createWebApi: broadcastUserInput, broadcastAutoRunState, broadcastTabsChange, broadcastSessionState
 * - createWebserverApi: getUrl, getConnectedClients
 * - createLiveApi: toggle, getStatus, getDashboardUrl, getLiveSessions, broadcastActiveSession,
 *   disableAll, startServer, stopServer
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createWebApi, createWebserverApi, createLiveApi } from '../../../main/preload/web';

describe('Web Preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('createWebApi', () => {
		let api: ReturnType<typeof createWebApi>;

		beforeEach(() => {
			api = createWebApi();
		});

		describe('broadcastUserInput', () => {
			it('should invoke web:broadcastUserInput with correct parameters', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.broadcastUserInput('session-123', 'hello world', 'ai');

				expect(mockInvoke).toHaveBeenCalledWith(
					'web:broadcastUserInput',
					'session-123',
					'hello world',
					'ai'
				);
			});

			it('should handle terminal mode', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.broadcastUserInput('session-123', 'ls -la', 'terminal');

				expect(mockInvoke).toHaveBeenCalledWith(
					'web:broadcastUserInput',
					'session-123',
					'ls -la',
					'terminal'
				);
			});
		});

		describe('broadcastAutoRunState', () => {
			it('should invoke web:broadcastAutoRunState with state', async () => {
				mockInvoke.mockResolvedValue(undefined);
				const state = {
					isRunning: true,
					totalTasks: 10,
					completedTasks: 5,
					currentTaskIndex: 5,
				};

				await api.broadcastAutoRunState('session-123', state);

				expect(mockInvoke).toHaveBeenCalledWith('web:broadcastAutoRunState', 'session-123', state);
			});

			it('should handle null state', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.broadcastAutoRunState('session-123', null);

				expect(mockInvoke).toHaveBeenCalledWith('web:broadcastAutoRunState', 'session-123', null);
			});
		});

		describe('broadcastTabsChange', () => {
			it('should invoke web:broadcastTabsChange with tabs', async () => {
				mockInvoke.mockResolvedValue(undefined);
				const tabs = [
					{
						id: 'tab-1',
						agentSessionId: 'agent-1',
						name: 'Tab 1',
						starred: false,
						inputValue: '',
						createdAt: Date.now(),
						state: 'idle' as const,
					},
				];

				await api.broadcastTabsChange('session-123', tabs, 'tab-1');

				expect(mockInvoke).toHaveBeenCalledWith(
					'web:broadcastTabsChange',
					'session-123',
					tabs,
					'tab-1'
				);
			});
		});

		describe('broadcastSessionState', () => {
			it('should invoke web:broadcastSessionState with state', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.broadcastSessionState('session-123', 'busy');

				expect(mockInvoke).toHaveBeenCalledWith(
					'web:broadcastSessionState',
					'session-123',
					'busy',
					undefined
				);
			});

			it('should invoke with additional data', async () => {
				mockInvoke.mockResolvedValue(undefined);
				const additionalData = { name: 'My Session', toolType: 'claude-code' };

				await api.broadcastSessionState('session-123', 'idle', additionalData);

				expect(mockInvoke).toHaveBeenCalledWith(
					'web:broadcastSessionState',
					'session-123',
					'idle',
					additionalData
				);
			});
		});
	});

	describe('createWebserverApi', () => {
		let api: ReturnType<typeof createWebserverApi>;

		beforeEach(() => {
			api = createWebserverApi();
		});

		describe('getUrl', () => {
			it('should invoke webserver:getUrl', async () => {
				mockInvoke.mockResolvedValue('http://localhost:3000');

				const result = await api.getUrl();

				expect(mockInvoke).toHaveBeenCalledWith('webserver:getUrl');
				expect(result).toBe('http://localhost:3000');
			});
		});

		describe('getConnectedClients', () => {
			it('should invoke webserver:getConnectedClients', async () => {
				mockInvoke.mockResolvedValue(['client-1', 'client-2']);

				const result = await api.getConnectedClients();

				expect(mockInvoke).toHaveBeenCalledWith('webserver:getConnectedClients');
				expect(result).toEqual(['client-1', 'client-2']);
			});
		});
	});

	describe('createLiveApi', () => {
		let api: ReturnType<typeof createLiveApi>;

		beforeEach(() => {
			api = createLiveApi();
		});

		describe('toggle', () => {
			it('should invoke live:toggle with sessionId', async () => {
				mockInvoke.mockResolvedValue({ enabled: true });

				await api.toggle('session-123');

				expect(mockInvoke).toHaveBeenCalledWith('live:toggle', 'session-123', undefined);
			});

			it('should invoke live:toggle with agentSessionId', async () => {
				mockInvoke.mockResolvedValue({ enabled: true });

				await api.toggle('session-123', 'agent-session-456');

				expect(mockInvoke).toHaveBeenCalledWith('live:toggle', 'session-123', 'agent-session-456');
			});
		});

		describe('getStatus', () => {
			it('should invoke live:getStatus', async () => {
				mockInvoke.mockResolvedValue({ enabled: true, url: 'https://live.example.com' });

				const result = await api.getStatus('session-123');

				expect(mockInvoke).toHaveBeenCalledWith('live:getStatus', 'session-123');
				expect(result).toEqual({ enabled: true, url: 'https://live.example.com' });
			});
		});

		describe('getDashboardUrl', () => {
			it('should invoke live:getDashboardUrl', async () => {
				mockInvoke.mockResolvedValue('https://dashboard.example.com');

				const result = await api.getDashboardUrl();

				expect(mockInvoke).toHaveBeenCalledWith('live:getDashboardUrl');
				expect(result).toBe('https://dashboard.example.com');
			});
		});

		describe('getLiveSessions', () => {
			it('should invoke live:getLiveSessions', async () => {
				mockInvoke.mockResolvedValue([{ sessionId: '123', agentSessionId: '456' }]);

				const result = await api.getLiveSessions();

				expect(mockInvoke).toHaveBeenCalledWith('live:getLiveSessions');
				expect(result).toEqual([{ sessionId: '123', agentSessionId: '456' }]);
			});
		});

		describe('broadcastActiveSession', () => {
			it('should invoke live:broadcastActiveSession', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.broadcastActiveSession('session-123');

				expect(mockInvoke).toHaveBeenCalledWith('live:broadcastActiveSession', 'session-123');
			});
		});

		describe('disableAll', () => {
			it('should invoke live:disableAll', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.disableAll();

				expect(mockInvoke).toHaveBeenCalledWith('live:disableAll');
			});
		});

		describe('startServer', () => {
			it('should invoke live:startServer', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.startServer();

				expect(mockInvoke).toHaveBeenCalledWith('live:startServer');
			});
		});

		describe('stopServer', () => {
			it('should invoke live:stopServer', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.stopServer();

				expect(mockInvoke).toHaveBeenCalledWith('live:stopServer');
			});
		});
	});
});
