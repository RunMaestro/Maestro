import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';

// Track registered handlers
const registeredHandlers = new Map<string, Function>();

// Mock ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: Function) => {
			registeredHandlers.set(channel, handler);
		}),
	},
}));

// Mock logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock WebServer class
vi.mock('../../../../main/web-server', () => ({
	WebServer: vi.fn(),
}));

// Mock cli-server-discovery so handlers don't touch the real filesystem
vi.mock('../../../../shared/cli-server-discovery', () => ({
	writeCliServerInfo: vi.fn(),
	deleteCliServerInfo: vi.fn(),
}));

import { registerWebHandlers } from '../../../../main/ipc/handlers/web';
import { writeCliServerInfo, deleteCliServerInfo } from '../../../../shared/cli-server-discovery';

describe('web handlers', () => {
	let mockWebServer: any;
	let webServerRef: { current: any };
	let mockCreateWebServer: any;
	let mockSettingsStore: any;

	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();

		// Create mock web server
		mockWebServer = {
			isActive: vi.fn().mockReturnValue(true),
			isSessionLive: vi.fn().mockReturnValue(false),
			setSessionLive: vi.fn(),
			setSessionOffline: vi.fn(),
			getSessionUrl: vi.fn().mockReturnValue('http://localhost:8080/session/123'),
			getSecureUrl: vi.fn().mockReturnValue('http://localhost:8080'),
			getLiveSessions: vi.fn().mockReturnValue([]),
			broadcastActiveSessionChange: vi.fn(),
			broadcastUserInput: vi.fn(),
			broadcastAutoRunState: vi.fn(),
			broadcastTabsChange: vi.fn(),
			broadcastSessionStateChange: vi.fn(),
			getWebClientCount: vi.fn().mockReturnValue(1),
			getSecurityToken: vi.fn().mockReturnValue('mock-security-token'),
			getPort: vi.fn().mockReturnValue(8080),
			start: vi.fn().mockResolvedValue({
				port: 8080,
				token: 'mock-security-token',
				url: 'http://localhost:8080',
			}),
			stop: vi.fn().mockResolvedValue(undefined),
		};

		webServerRef = { current: mockWebServer };
		mockCreateWebServer = vi.fn().mockReturnValue(mockWebServer);
		mockSettingsStore = {
			get: vi.fn(),
			set: vi.fn(),
		};

		registerWebHandlers({
			getWebServer: () => webServerRef.current,
			setWebServer: (server) => {
				webServerRef.current = server;
			},
			createWebServer: mockCreateWebServer,
			settingsStore: mockSettingsStore,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('handler registration', () => {
		it('should register all web/live handlers', () => {
			expect(ipcMain.handle).toHaveBeenCalledWith('web:broadcastUserInput', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith(
				'web:broadcastAutoRunState',
				expect.any(Function)
			);
			expect(ipcMain.handle).toHaveBeenCalledWith('web:broadcastTabsChange', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith(
				'web:broadcastSessionState',
				expect.any(Function)
			);
			expect(ipcMain.handle).toHaveBeenCalledWith('live:toggle', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('live:getStatus', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('live:getDashboardUrl', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('live:getLiveSessions', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith(
				'live:broadcastActiveSession',
				expect.any(Function)
			);
			expect(ipcMain.handle).toHaveBeenCalledWith('live:startServer', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('live:stopServer', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('live:persistCurrentToken', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith(
				'live:clearPersistentToken',
				expect.any(Function)
			);
			expect(ipcMain.handle).toHaveBeenCalledWith('live:disableAll', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('webserver:getUrl', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith(
				'webserver:getConnectedClients',
				expect.any(Function)
			);
		});
	});

	describe('web:broadcastUserInput', () => {
		it('should broadcast user input when web server has clients', async () => {
			const handler = registeredHandlers.get('web:broadcastUserInput');
			const result = await handler!({}, 'session-123', 'test command', 'ai');

			expect(mockWebServer.broadcastUserInput).toHaveBeenCalledWith(
				'session-123',
				'test command',
				'ai'
			);
			expect(result).toBe(true);
		});

		it('should return false when no clients connected', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(0);

			const handler = registeredHandlers.get('web:broadcastUserInput');
			const result = await handler!({}, 'session-123', 'test', 'ai');

			expect(mockWebServer.broadcastUserInput).not.toHaveBeenCalled();
			expect(result).toBe(false);
		});

		it('should return false when web server is null', async () => {
			webServerRef.current = null;

			const handler = registeredHandlers.get('web:broadcastUserInput');
			const result = await handler!({}, 'session-123', 'test', 'ai');

			expect(result).toBe(false);
		});
	});

	describe('web:broadcastAutoRunState', () => {
		it('should broadcast auto run state', async () => {
			const state = {
				isRunning: true,
				totalTasks: 5,
				completedTasks: 2,
				currentTaskIndex: 2,
			};

			const handler = registeredHandlers.get('web:broadcastAutoRunState');
			const result = await handler!({}, 'session-123', state);

			expect(mockWebServer.broadcastAutoRunState).toHaveBeenCalledWith('session-123', state);
			expect(result).toBe(true);
		});
	});

	describe('live:toggle', () => {
		it('should enable live mode for offline session', async () => {
			mockWebServer.isSessionLive.mockReturnValue(false);

			const handler = registeredHandlers.get('live:toggle');
			const result = await handler!({}, 'session-123', 'agent-session-456');

			expect(mockWebServer.setSessionLive).toHaveBeenCalledWith('session-123', 'agent-session-456');
			expect(result).toEqual({ live: true, url: 'http://localhost:8080/session/123' });
		});

		it('should disable live mode for live session', async () => {
			mockWebServer.isSessionLive.mockReturnValue(true);

			const handler = registeredHandlers.get('live:toggle');
			const result = await handler!({}, 'session-123');

			expect(mockWebServer.setSessionOffline).toHaveBeenCalledWith('session-123');
			expect(result).toEqual({ live: false, url: null });
		});

		it('should throw when web server not initialized', async () => {
			webServerRef.current = null;

			const handler = registeredHandlers.get('live:toggle');
			await expect(handler!({}, 'session-123')).rejects.toThrow('Web server not initialized');
		});

		it('should wait for server to become active', async () => {
			// Server starts inactive, becomes active after 200ms
			let callCount = 0;
			mockWebServer.isActive.mockImplementation(() => {
				callCount++;
				return callCount > 2; // Returns true on 3rd call
			});
			mockWebServer.isSessionLive.mockReturnValue(false);

			const handler = registeredHandlers.get('live:toggle');
			const result = await handler!({}, 'session-123');

			expect(mockWebServer.isActive).toHaveBeenCalled();
			expect(result).toEqual({ live: true, url: 'http://localhost:8080/session/123' });
		});

		it('should throw if server fails to start within timeout', async () => {
			// Server never becomes active
			mockWebServer.isActive.mockReturnValue(false);

			const handler = registeredHandlers.get('live:toggle');

			// Use fake timers
			vi.useFakeTimers();

			// Start the promise and immediately attach the rejection handler
			const promise = handler!({}, 'session-123').catch((e: Error) => e);

			// Advance time past the 5000ms timeout
			await vi.runAllTimersAsync();

			// Now check the result
			const error = await promise;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe('Web server failed to start');

			vi.useRealTimers();
		});
	});

	describe('live:getStatus', () => {
		it('should return live status for live session', async () => {
			mockWebServer.isSessionLive.mockReturnValue(true);

			const handler = registeredHandlers.get('live:getStatus');
			const result = await handler!({}, 'session-123');

			expect(result).toEqual({ live: true, url: 'http://localhost:8080/session/123' });
		});

		it('should return offline status for offline session', async () => {
			mockWebServer.isSessionLive.mockReturnValue(false);

			const handler = registeredHandlers.get('live:getStatus');
			const result = await handler!({}, 'session-123');

			expect(result).toEqual({ live: false, url: null });
		});

		it('should return offline when web server is null', async () => {
			webServerRef.current = null;

			const handler = registeredHandlers.get('live:getStatus');
			const result = await handler!({}, 'session-123');

			expect(result).toEqual({ live: false, url: null });
		});
	});

	describe('live:startServer', () => {
		it('should create and start web server if not exists', async () => {
			webServerRef.current = null;
			// Mock the created server to be inactive so start() is called
			mockWebServer.isActive.mockReturnValue(false);

			const handler = registeredHandlers.get('live:startServer');
			const result = await handler!({});

			expect(mockCreateWebServer).toHaveBeenCalled();
			expect(webServerRef.current).toBe(mockWebServer); // Server was set
			expect(mockWebServer.start).toHaveBeenCalled();
			expect(result).toEqual({ success: true, url: 'http://localhost:8080' });
		});

		it('should just start existing server if not active and persistentWebLink is on', async () => {
			mockSettingsStore.get.mockImplementation((key: string, def: unknown) =>
				key === 'persistentWebLink' ? true : def
			);
			mockWebServer.isActive.mockReturnValue(false);

			const handler = registeredHandlers.get('live:startServer');
			const result = await handler!({});

			expect(mockCreateWebServer).not.toHaveBeenCalled();
			expect(mockWebServer.start).toHaveBeenCalled();
			expect(result).toEqual({ success: true, url: 'http://localhost:8080' });
		});

		it('should return url for already running server when persistentWebLink is on', async () => {
			mockSettingsStore.get.mockImplementation((key: string, def: unknown) =>
				key === 'persistentWebLink' ? true : def
			);
			mockWebServer.isActive.mockReturnValue(true);

			const handler = registeredHandlers.get('live:startServer');
			const result = await handler!({});

			expect(mockWebServer.start).not.toHaveBeenCalled();
			expect(result).toEqual({ success: true, url: 'http://localhost:8080' });
		});

		it('should rotate the server (tear down + recreate) on Live ON when persistentWebLink is off', async () => {
			// Existing CLI-only server (e.g. spun up by ensureCliServer after a
			// previous live:stopServer). The next Live ON must mint a fresh
			// security token instead of reusing the prior one.
			mockSettingsStore.get.mockImplementation((key: string, def: unknown) =>
				key === 'persistentWebLink' ? false : def
			);
			const freshServer = {
				...mockWebServer,
				isActive: vi.fn().mockReturnValue(false),
				stop: vi.fn().mockResolvedValue(undefined),
				start: vi.fn().mockResolvedValue({
					port: 8080,
					token: 'fresh-token',
					url: 'http://localhost:8080',
				}),
				getSecurityToken: vi.fn().mockReturnValue('fresh-token'),
				getPort: vi.fn().mockReturnValue(8080),
				getSecureUrl: vi.fn().mockReturnValue('http://localhost:8080'),
			};
			mockCreateWebServer.mockReturnValueOnce(freshServer);

			const handler = registeredHandlers.get('live:startServer');
			const result = await handler!({});

			expect(mockWebServer.stop).toHaveBeenCalled();
			expect(mockCreateWebServer).toHaveBeenCalled();
			expect(freshServer.start).toHaveBeenCalled();
			expect(writeCliServerInfo).toHaveBeenCalledWith(
				expect.objectContaining({ token: 'fresh-token' })
			);
			expect(result).toEqual({ success: true, url: 'http://localhost:8080' });
		});

		it('should bail out and keep the existing server if stop() fails during rotation', async () => {
			// If stop() throws, the old server may still be bound to its port —
			// dropping the reference would leak it and the next start() would either
			// collide on a custom port or run a second server in parallel. The
			// handler must preserve the handle and surface the error.
			mockSettingsStore.get.mockImplementation((key: string, def: unknown) =>
				key === 'persistentWebLink' ? false : def
			);
			mockWebServer.stop.mockRejectedValueOnce(new Error('stop boom'));

			const handler = registeredHandlers.get('live:startServer');
			const result = await handler!({});

			expect(mockWebServer.stop).toHaveBeenCalled();
			expect(webServerRef.current).toBe(mockWebServer); // reference preserved
			expect(mockCreateWebServer).not.toHaveBeenCalled();
			expect(mockWebServer.start).not.toHaveBeenCalled();
			expect(writeCliServerInfo).not.toHaveBeenCalled();
			expect(result).toEqual({ success: false, error: 'stop boom' });
		});

		it('should reuse the server (no rotation) on Live ON when persistentWebLink is on', async () => {
			mockSettingsStore.get.mockImplementation((key: string, def: unknown) =>
				key === 'persistentWebLink' ? true : def
			);
			mockWebServer.isActive.mockReturnValue(true);

			const handler = registeredHandlers.get('live:startServer');
			await handler!({});

			expect(mockWebServer.stop).not.toHaveBeenCalled();
			expect(mockCreateWebServer).not.toHaveBeenCalled();
			expect(writeCliServerInfo).toHaveBeenCalledWith(
				expect.objectContaining({ token: 'mock-security-token' })
			);
		});

		it('should publish CLI discovery file after starting', async () => {
			mockWebServer.isActive.mockReturnValue(false);

			const handler = registeredHandlers.get('live:startServer');
			await handler!({});

			expect(writeCliServerInfo).toHaveBeenCalledWith(
				expect.objectContaining({
					port: 8080,
					token: 'mock-security-token',
					pid: expect.any(Number),
					startedAt: expect.any(Number),
				})
			);
		});

		it('should publish CLI discovery file even when server already running (persistent)', async () => {
			mockSettingsStore.get.mockImplementation((key: string, def: unknown) =>
				key === 'persistentWebLink' ? true : def
			);
			mockWebServer.isActive.mockReturnValue(true);

			const handler = registeredHandlers.get('live:startServer');
			await handler!({});

			expect(writeCliServerInfo).toHaveBeenCalledWith(
				expect.objectContaining({ port: 8080, token: 'mock-security-token' })
			);
		});

		it('should handle start errors', async () => {
			mockWebServer.isActive.mockReturnValue(false);
			mockWebServer.start.mockRejectedValue(new Error('Port in use'));

			const handler = registeredHandlers.get('live:startServer');
			const result = await handler!({});

			expect(result).toEqual({ success: false, error: 'Port in use' });
			expect(writeCliServerInfo).not.toHaveBeenCalled();
		});

		// Regression tests for #859: CLI discovery file must be refreshed so
		// `maestro-cli` can reconnect after a stop/start cycle.
		it('should refresh CLI discovery file after starting a freshly-created server', async () => {
			webServerRef.current = null;
			mockWebServer.isActive.mockReturnValue(false);

			const handler = registeredHandlers.get('live:startServer');
			await handler!({});

			expect(writeCliServerInfo).toHaveBeenCalledTimes(1);
			expect(writeCliServerInfo).toHaveBeenCalledWith(
				expect.objectContaining({
					port: 8080,
					token: 'mock-security-token',
					pid: process.pid,
				})
			);
		});

		it('should refresh CLI discovery file when the existing server is restarted (persistent)', async () => {
			mockSettingsStore.get.mockImplementation((key: string, def: unknown) =>
				key === 'persistentWebLink' ? true : def
			);
			mockWebServer.isActive.mockReturnValue(false);

			const handler = registeredHandlers.get('live:startServer');
			await handler!({});

			expect(writeCliServerInfo).toHaveBeenCalledTimes(1);
			expect(writeCliServerInfo).toHaveBeenCalledWith(
				expect.objectContaining({
					port: 8080,
					token: 'mock-security-token',
				})
			);
		});

		it('should refresh CLI discovery file when the server is already running (persistent)', async () => {
			mockSettingsStore.get.mockImplementation((key: string, def: unknown) =>
				key === 'persistentWebLink' ? true : def
			);
			mockWebServer.isActive.mockReturnValue(true);

			const handler = registeredHandlers.get('live:startServer');
			await handler!({});

			expect(writeCliServerInfo).toHaveBeenCalledTimes(1);
			expect(writeCliServerInfo).toHaveBeenCalledWith(
				expect.objectContaining({
					port: 8080,
					token: 'mock-security-token',
				})
			);
		});

		it('should not refresh CLI discovery file when start throws', async () => {
			mockWebServer.isActive.mockReturnValue(false);
			mockWebServer.start.mockRejectedValue(new Error('Port in use'));

			const handler = registeredHandlers.get('live:startServer');
			await handler!({});

			expect(writeCliServerInfo).not.toHaveBeenCalled();
		});

		// A discovery-file write failure (disk full, unwritable config dir, …)
		// must not mask a genuinely-running server — `ensureCliServer` treats
		// the write as non-fatal and `live:startServer` should too.
		it('should still report success when discovery write fails after a fresh start', async () => {
			mockWebServer.isActive.mockReturnValue(false);
			vi.mocked(writeCliServerInfo).mockImplementationOnce(() => {
				throw new Error('disk full');
			});

			const handler = registeredHandlers.get('live:startServer');
			const result = await handler!({});

			expect(mockWebServer.start).toHaveBeenCalled();
			expect(result).toEqual({ success: true, url: 'http://localhost:8080' });
		});

		it('should still report success when discovery write fails on an already-running server (persistent)', async () => {
			mockSettingsStore.get.mockImplementation((key: string, def: unknown) =>
				key === 'persistentWebLink' ? true : def
			);
			mockWebServer.isActive.mockReturnValue(true);
			vi.mocked(writeCliServerInfo).mockImplementationOnce(() => {
				throw new Error('permission denied');
			});

			const handler = registeredHandlers.get('live:startServer');
			const result = await handler!({});

			expect(mockWebServer.start).not.toHaveBeenCalled();
			expect(result).toEqual({ success: true, url: 'http://localhost:8080' });
		});
	});

	describe('live:stopServer', () => {
		it('should stop web server, delete discovery, and re-establish CLI server', async () => {
			const handler = registeredHandlers.get('live:stopServer');
			const result = await handler!({});

			expect(mockWebServer.stop).toHaveBeenCalled();
			expect(deleteCliServerInfo).toHaveBeenCalledTimes(1);
			// ensureCliServer recreates the server and republishes discovery so
			// maestro-cli keeps working after Live Mode is turned off.
			expect(webServerRef.current).toBe(mockWebServer);
			expect(writeCliServerInfo).toHaveBeenCalled();
			expect(result).toEqual({ success: true });
		});

		it('should still re-establish CLI server when no server existed', async () => {
			webServerRef.current = null;

			const handler = registeredHandlers.get('live:stopServer');
			const result = await handler!({});

			expect(mockCreateWebServer).toHaveBeenCalled();
			expect(writeCliServerInfo).toHaveBeenCalled();
			expect(result).toEqual({ success: true });
		});
	});

	describe('live:disableAll', () => {
		it('should disable all live sessions, stop server, and re-establish CLI', async () => {
			mockWebServer.getLiveSessions.mockReturnValue([
				{ sessionId: 'session-1' },
				{ sessionId: 'session-2' },
			]);

			const handler = registeredHandlers.get('live:disableAll');
			const result = await handler!({});

			expect(mockWebServer.setSessionOffline).toHaveBeenCalledWith('session-1');
			expect(mockWebServer.setSessionOffline).toHaveBeenCalledWith('session-2');
			expect(mockWebServer.stop).toHaveBeenCalled();
			expect(deleteCliServerInfo).toHaveBeenCalledTimes(1);
			// Same as stopServer: CLI must remain reachable.
			expect(writeCliServerInfo).toHaveBeenCalled();
			expect(result).toEqual({ success: true, count: 2 });
		});

		it('should return count 0 when no live sessions', async () => {
			mockWebServer.getLiveSessions.mockReturnValue([]);

			const handler = registeredHandlers.get('live:disableAll');
			const result = await handler!({});

			expect(mockWebServer.stop).toHaveBeenCalled();
			expect(deleteCliServerInfo).toHaveBeenCalledTimes(1);
			expect(result).toEqual({ success: true, count: 0 });
		});
	});

	describe('live:persistCurrentToken', () => {
		it('should write flag before token for crash safety', async () => {
			const handler = registeredHandlers.get('live:persistCurrentToken');
			const result = await handler!({});

			expect(mockWebServer.getSecurityToken).toHaveBeenCalled();
			expect(mockSettingsStore.set).toHaveBeenCalledWith('persistentWebLink', true);
			expect(mockSettingsStore.set).toHaveBeenCalledWith('webAuthToken', 'mock-security-token');
			expect(result).toEqual({ success: true });

			// Verify crash-safe write order: flag enabled before token.
			// A crash between the two writes leaves persistentWebLink=true with
			// a missing token, which the factory handles by generating a fresh UUID.
			const setCalls = vi.mocked(mockSettingsStore.set).mock.calls;
			const flagIndex = setCalls.findIndex(([key]) => key === 'persistentWebLink');
			const tokenIndex = setCalls.findIndex(([key]) => key === 'webAuthToken');
			expect(flagIndex).toBeLessThan(tokenIndex);
		});

		it('should return failure when web server is null', async () => {
			webServerRef.current = null;

			const handler = registeredHandlers.get('live:persistCurrentToken');
			const result = await handler!({});

			expect(result).toEqual({ success: false, message: 'Web server is not running.' });
		});

		it('should return failure when web server is not active', async () => {
			mockWebServer.isActive.mockReturnValue(false);

			const handler = registeredHandlers.get('live:persistCurrentToken');
			const result = await handler!({});

			expect(result).toEqual({ success: false, message: 'Web server is not running.' });
			expect(mockWebServer.getSecurityToken).not.toHaveBeenCalled();
		});

		it('should return failure when settings write throws', async () => {
			mockSettingsStore.set.mockImplementationOnce(() => {
				throw new Error('disk full');
			});

			const handler = registeredHandlers.get('live:persistCurrentToken');
			const result = await handler!({});

			expect(result).toEqual({ success: false, message: 'disk full' });
		});
	});

	describe('live:clearPersistentToken', () => {
		it('should clear flag before token for crash safety', async () => {
			const handler = registeredHandlers.get('live:clearPersistentToken');
			const result = await handler!({});

			// Verify both writes are made
			expect(mockSettingsStore.set).toHaveBeenCalledWith('persistentWebLink', false);
			expect(mockSettingsStore.set).toHaveBeenCalledWith('webAuthToken', null);
			expect(result).toEqual({ success: true });

			// Verify crash-safe write order: flag cleared before token.
			// A crash between the two writes must leave persistentWebLink=false
			// so the factory ignores the stale token on next startup.
			const setCalls = vi.mocked(mockSettingsStore.set).mock.calls;
			const flagIndex = setCalls.findIndex(([key]) => key === 'persistentWebLink');
			const tokenIndex = setCalls.findIndex(([key]) => key === 'webAuthToken');
			expect(flagIndex).toBeLessThan(tokenIndex);
		});

		it('should return failure when settings write throws', async () => {
			mockSettingsStore.set.mockImplementationOnce(() => {
				throw new Error('disk full');
			});

			const handler = registeredHandlers.get('live:clearPersistentToken');
			const result = await handler!({});

			expect(result).toEqual({ success: false, message: 'disk full' });
		});
	});

	describe('webserver:getUrl', () => {
		it('should return web server URL', async () => {
			const handler = registeredHandlers.get('webserver:getUrl');
			const result = await handler!({});

			expect(result).toBe('http://localhost:8080');
		});

		it('should return undefined when server is null', async () => {
			webServerRef.current = null;

			const handler = registeredHandlers.get('webserver:getUrl');
			const result = await handler!({});

			expect(result).toBeUndefined();
		});
	});

	describe('webserver:getConnectedClients', () => {
		it('should return client count', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(5);

			const handler = registeredHandlers.get('webserver:getConnectedClients');
			const result = await handler!({});

			expect(result).toBe(5);
		});

		it('should return 0 when server is null', async () => {
			webServerRef.current = null;

			const handler = registeredHandlers.get('webserver:getConnectedClients');
			const result = await handler!({});

			expect(result).toBe(0);
		});
	});
});
