import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const handlers = new Map<string, Handler>();

let webServer: ReturnType<typeof createWebServerMock> | null;
let createdServer: ReturnType<typeof createWebServerMock>;
let setWebServer: ReturnType<typeof vi.fn>;
let createWebServer: ReturnType<typeof vi.fn>;
let settingsStore: {
	get: ReturnType<typeof vi.fn>;
	set: ReturnType<typeof vi.fn>;
};

function createWebServerMock() {
	return {
		getWebClientCount: vi.fn().mockReturnValue(2),
		broadcastUserInput: vi.fn(),
		broadcastAutoRunState: vi.fn(),
		broadcastTabsChange: vi.fn(),
		broadcastSessionStateChange: vi.fn(),
		isActive: vi.fn().mockReturnValue(true),
		isSessionLive: vi.fn().mockReturnValue(false),
		setSessionOffline: vi.fn(),
		setSessionLive: vi.fn(),
		getSessionUrl: vi.fn((sessionId: string) => `https://maestro.local/session/${sessionId}`),
		getPort: vi.fn().mockReturnValue(3210),
		getSecureUrl: vi.fn().mockReturnValue('https://maestro.local'),
		getLiveSessions: vi.fn().mockReturnValue([
			{ sessionId: 'live-1', url: 'https://maestro.local/session/live-1' },
			{ sessionId: 'live-2', url: 'https://maestro.local/session/live-2' },
		]),
		broadcastActiveSessionChange: vi.fn(),
		start: vi.fn().mockResolvedValue({ port: 3210, url: 'https://maestro.local' }),
		stop: vi.fn().mockResolvedValue(undefined),
		getSecurityToken: vi.fn().mockReturnValue('token-123'),
	};
}

async function registerWebHandlers() {
	const { registerWebHandlers } = await import('../../main/ipc/handlers/web');
	registerWebHandlers({
		getWebServer: () => webServer as never,
		setWebServer: (server) => {
			webServer = server as typeof webServer;
			setWebServer(server);
		},
		createWebServer,
		settingsStore: settingsStore as never,
	});
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
	const handler = handlers.get(channel);
	expect(handler, `Expected ${channel} to be registered`).toBeDefined();
	return (await handler!({}, ...args)) as T;
}

describe('web IPC integration', () => {
	beforeEach(async () => {
		vi.resetModules();
		handlers.clear();
		webServer = createWebServerMock();
		createdServer = createWebServerMock();
		setWebServer = vi.fn();
		createWebServer = vi.fn(() => createdServer);
		settingsStore = {
			get: vi.fn((key: string, defaultValue?: unknown) =>
				key === 'persistentWebLink' ? true : defaultValue
			),
			set: vi.fn(),
		};

		vi.doMock('electron', () => ({
			ipcMain: {
				handle: vi.fn((channel: string, handler: Handler) => {
					handlers.set(channel, handler);
				}),
				removeHandler: vi.fn((channel: string) => {
					handlers.delete(channel);
				}),
			},
		}));
		vi.doMock('../../main/utils/logger', () => ({
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
			},
		}));
		vi.doMock('../../main/web-server', () => ({
			WebServer: class {},
		}));

		await registerWebHandlers();
	});

	afterEach(() => {
		handlers.clear();
		vi.doUnmock('electron');
		vi.doUnmock('../../main/utils/logger');
		vi.doUnmock('../../main/web-server');
		vi.resetModules();
	});

	it('registers web channels and broadcasts desktop state to connected clients', async () => {
		expect([...handlers.keys()].sort()).toEqual([
			'live:broadcastActiveSession',
			'live:clearPersistentToken',
			'live:disableAll',
			'live:getDashboardUrl',
			'live:getLiveSessions',
			'live:getStatus',
			'live:persistCurrentToken',
			'live:startServer',
			'live:stopServer',
			'live:toggle',
			'web:broadcastAutoRunState',
			'web:broadcastSessionState',
			'web:broadcastTabsChange',
			'web:broadcastUserInput',
			'webserver:getConnectedClients',
			'webserver:getUrl',
		]);

		await expect(invoke('web:broadcastUserInput', 'session-1', 'run tests', 'ai')).resolves.toBe(
			true
		);
		await expect(
			invoke('web:broadcastAutoRunState', 'session-1', {
				isRunning: true,
				totalTasks: 2,
				completedTasks: 1,
				currentTaskIndex: 1,
			})
		).resolves.toBe(true);
		await expect(
			invoke('web:broadcastTabsChange', 'session-1', [{ id: 'tab-1', name: 'Plan' }], 'tab-1')
		).resolves.toBe(true);
		await expect(
			invoke('web:broadcastSessionState', 'session-1', 'busy', {
				name: 'Session One',
				toolType: 'codex',
			})
		).resolves.toBe(true);

		expect(webServer!.broadcastUserInput).toHaveBeenCalledWith('session-1', 'run tests', 'ai');
		expect(webServer!.broadcastAutoRunState).toHaveBeenCalledWith(
			'session-1',
			expect.objectContaining({ isRunning: true })
		);
		expect(webServer!.broadcastTabsChange).toHaveBeenCalledWith(
			'session-1',
			[{ id: 'tab-1', name: 'Plan' }],
			'tab-1'
		);
		expect(webServer!.broadcastSessionStateChange).toHaveBeenCalledWith(
			'session-1',
			'busy',
			expect.objectContaining({ name: 'Session One' })
		);

		webServer!.getWebClientCount.mockReturnValue(0);
		await expect(
			invoke('web:broadcastUserInput', 'session-1', 'ignored', 'terminal')
		).resolves.toBe(false);
		await expect(invoke('web:broadcastTabsChange', 'session-1', [], 'tab-1')).resolves.toBe(false);
		await expect(invoke('web:broadcastSessionState', 'session-1', 'idle')).resolves.toBe(false);

		webServer = null;
		await expect(invoke('web:broadcastAutoRunState', 'session-1', null)).resolves.toBe(false);
	});

	it('toggles live sessions and exposes live dashboard state', async () => {
		await expect(invoke('live:toggle', 'session-1', 'agent-session-1')).resolves.toEqual({
			live: true,
			url: 'https://maestro.local/session/session-1',
		});
		expect(webServer!.setSessionLive).toHaveBeenCalledWith('session-1', 'agent-session-1');

		webServer!.isSessionLive.mockReturnValue(true);
		await expect(invoke('live:toggle', 'session-1')).resolves.toEqual({
			live: false,
			url: null,
		});
		expect(webServer!.setSessionOffline).toHaveBeenCalledWith('session-1');

		await expect(invoke('live:getStatus', 'session-1')).resolves.toEqual({
			live: true,
			url: 'https://maestro.local/session/session-1',
		});
		await expect(invoke('live:getDashboardUrl')).resolves.toBe('https://maestro.local');
		await expect(invoke('live:getLiveSessions')).resolves.toHaveLength(2);
		await invoke('live:broadcastActiveSession', 'session-2');
		expect(webServer!.broadcastActiveSessionChange).toHaveBeenCalledWith('session-2');

		webServer = null;
		await expect(invoke('live:getStatus', 'session-1')).resolves.toEqual({
			live: false,
			url: null,
		});
		await expect(invoke('live:getDashboardUrl')).resolves.toBeNull();
		await expect(invoke('live:getLiveSessions')).resolves.toEqual([]);
		await expect(invoke('live:toggle', 'session-1')).rejects.toThrow('Web server not initialized');
		await expect(invoke('live:broadcastActiveSession', 'session-2')).resolves.toBeUndefined();
	});

	it('waits briefly for an inactive web server before toggling a live session', async () => {
		webServer!.isActive.mockReset();
		webServer!.isActive.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);

		await expect(invoke('live:toggle', 'delayed-session')).resolves.toEqual({
			live: true,
			url: 'https://maestro.local/session/delayed-session',
		});

		expect(webServer!.setSessionLive).toHaveBeenCalledWith('delayed-session', undefined);
	});

	it('creates, starts, reuses, stops, and reports web server lifecycle failures', async () => {
		webServer = null;
		createdServer.isActive.mockReturnValueOnce(false).mockReturnValue(true);
		await expect(invoke('live:startServer')).resolves.toEqual({
			success: true,
			url: 'https://maestro.local',
		});
		expect(createWebServer).toHaveBeenCalledOnce();
		expect(setWebServer).toHaveBeenCalledWith(createdServer);
		expect(createdServer.start).toHaveBeenCalledOnce();

		await expect(invoke('live:startServer')).resolves.toEqual({
			success: true,
			url: 'https://maestro.local',
		});
		expect(createdServer.start).toHaveBeenCalledOnce();

		createdServer.isActive.mockReturnValue(false);
		createdServer.start.mockRejectedValueOnce(new Error('port busy'));
		await expect(invoke('live:startServer')).resolves.toEqual({
			success: false,
			error: 'port busy',
		});

		await expect(invoke('live:stopServer')).resolves.toEqual({ success: true });
		expect(createdServer.stop).toHaveBeenCalledOnce();
		expect(setWebServer).toHaveBeenCalledWith(null);

		webServer = null;
		await expect(invoke('live:stopServer')).resolves.toEqual({ success: true });

		webServer = createWebServerMock();
		webServer.stop.mockRejectedValueOnce(new Error('stop failed'));
		await expect(invoke('live:stopServer')).resolves.toEqual({
			success: false,
			error: 'stop failed',
		});
	});

	it('persists and clears persistent web tokens with rollback on settings failures', async () => {
		await expect(invoke('live:persistCurrentToken')).resolves.toEqual({ success: true });
		expect(settingsStore.set).toHaveBeenNthCalledWith(1, 'persistentWebLink', true);
		expect(settingsStore.set).toHaveBeenNthCalledWith(2, 'webAuthToken', 'token-123');

		settingsStore.set.mockClear();
		settingsStore.set.mockImplementation((key: string) => {
			if (key === 'webAuthToken') throw new Error('disk locked');
		});
		await expect(invoke('live:persistCurrentToken')).resolves.toEqual({
			success: false,
			message: 'disk locked',
		});
		expect(settingsStore.set).toHaveBeenLastCalledWith('persistentWebLink', false);

		settingsStore.set.mockReset();
		await expect(invoke('live:clearPersistentToken')).resolves.toEqual({ success: true });
		expect(settingsStore.set).toHaveBeenNthCalledWith(1, 'persistentWebLink', false);
		expect(settingsStore.set).toHaveBeenNthCalledWith(2, 'webAuthToken', null);

		settingsStore.set.mockReset();
		settingsStore.set.mockImplementation((key: string) => {
			if (key === 'webAuthToken') throw new Error('cannot clear');
		});
		await expect(invoke('live:clearPersistentToken')).resolves.toEqual({
			success: false,
			message: 'cannot clear',
		});
		expect(settingsStore.set).toHaveBeenLastCalledWith('persistentWebLink', true);

		webServer = createWebServerMock();
		webServer.isActive.mockReturnValue(false);
		await expect(invoke('live:persistCurrentToken')).resolves.toEqual({
			success: false,
			message: 'Web server is not running.',
		});
	});

	it('disables live sessions and exposes web server URL and client counts', async () => {
		await expect(invoke('webserver:getUrl')).resolves.toBe('https://maestro.local');
		await expect(invoke('webserver:getConnectedClients')).resolves.toBe(2);

		const activeServer = webServer!;
		await expect(invoke('live:disableAll')).resolves.toEqual({ success: true, count: 2 });
		expect(activeServer.setSessionOffline).toHaveBeenCalledWith('live-1');
		expect(activeServer.setSessionOffline).toHaveBeenCalledWith('live-2');
		expect(activeServer.stop).toHaveBeenCalledOnce();
		expect(setWebServer).toHaveBeenCalledWith(null);

		webServer = null;
		await expect(invoke('live:disableAll')).resolves.toEqual({ success: true, count: 0 });
		await expect(invoke('webserver:getUrl')).resolves.toBe('https://maestro.local');
		await expect(invoke('webserver:getConnectedClients')).resolves.toBe(2);

		webServer = createWebServerMock();
		webServer.stop.mockRejectedValueOnce(new Error('stop failed'));
		await expect(invoke('live:disableAll')).resolves.toEqual({
			success: false,
			count: 2,
			error: 'stop failed',
		});
	});
});
