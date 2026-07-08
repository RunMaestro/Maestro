import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { captureException } from '../../main/utils/sentry';
import { WebServer } from '../../main/web-server/WebServer';

vi.mock('../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../main/utils/networkUtils', () => ({
	getLocalIpAddress: vi.fn(async () => '10.0.0.5'),
	getLocalIpAddressSync: vi.fn(() => '10.0.0.5'),
}));

let unexpectedConsoleCalls: unknown[][] = [];

function isExpectedWebServerLog(args: unknown[]) {
	return (
		typeof args[0] === 'string' &&
		(args[0].includes('[WebServer]') ||
			args[0].includes('[LiveSessionManager]') ||
			args[0].includes('[CallbackRegistry]'))
	);
}

describe('WebServer web asset resolution', () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(path.join(os.tmpdir(), 'maestro-web-assets-'));
		vi.spyOn(process, 'cwd').mockReturnValue(tempRoot);
		unexpectedConsoleCalls = [];
		for (const method of ['log', 'info', 'warn', 'error'] as const) {
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				if (!isExpectedWebServerLog(args)) {
					unexpectedConsoleCalls.push(args);
				}
			});
		}
	});

	afterEach(() => {
		expect(unexpectedConsoleCalls).toEqual([]);
		vi.restoreAllMocks();
		vi.clearAllMocks();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it('prefers built dist/web assets over the source web index', () => {
		const distWebDir = path.join(tempRoot, 'dist', 'web');
		mkdirSync(distWebDir, { recursive: true });
		mkdirSync(path.join(distWebDir, 'assets'), { recursive: true });
		writeFileSync(
			path.join(distWebDir, 'index.html'),
			'<script type="module" src="./assets/main.js"></script>'
		);

		const server = new WebServer(0);

		expect((server as any).webAssetsPath).toBe(distWebDir);
	});

	it('rejects source web assets that still reference /main.tsx when no built bundle exists', () => {
		const server = new WebServer(0);

		expect((server as any).webAssetsPath).toBeNull();
	});

	it('reports and rethrows unexpected asset inspection failures', () => {
		const distWebDir = path.join(tempRoot, 'dist', 'web');
		const indexPath = path.join(distWebDir, 'index.html');
		mkdirSync(indexPath, { recursive: true });

		expect(() => new WebServer(0)).toThrow();

		const [[capturedError, captureContext]] = vi.mocked(captureException).mock.calls;
		expect((capturedError as NodeJS.ErrnoException).code).toBe('EISDIR');
		expect(captureContext).toEqual({
			operation: 'webServer:isServableWebAssetsPath',
			candidatePath: distWebDir,
			indexPath,
		});
	});

	it('treats disappearing web assets as unavailable', async () => {
		vi.resetModules();
		vi.doMock('fs', () => {
			const existsSync = vi.fn((target: string) => target.endsWith('index.html'));
			const readFileSync = vi.fn(() => {
				throw Object.assign(new Error('missing index'), { code: 'ENOENT' });
			});
			return {
				default: { existsSync, readFileSync },
				existsSync,
				readFileSync,
			};
		});

		try {
			const { WebServer: MockedWebServer } = await import('../../main/web-server/WebServer');
			const server = new MockedWebServer(0);

			expect((server as any).webAssetsPath).toBeNull();
		} finally {
			vi.doUnmock('fs');
			vi.resetModules();
		}
	});

	it('starts once, wires route/message callbacks, broadcasts state, and stops cleanly', async () => {
		const distWebDir = path.join(tempRoot, 'dist', 'web');
		mkdirSync(path.join(distWebDir, 'assets'), { recursive: true });
		mkdirSync(path.join(distWebDir, 'icons'), { recursive: true });
		writeFileSync(
			path.join(distWebDir, 'index.html'),
			'<script type="module" src="./assets/main.js"></script>'
		);

		const server = new WebServer(0, 'token-123') as any;
		const constructorBroadcastSend = vi.fn();
		server.webClients.set('constructor-client', {
			id: 'constructor-client',
			socket: { readyState: 1, send: constructorBroadcastSend },
		});
		server.broadcastToWebClients({ type: 'constructor-callback' });
		expect(constructorBroadcastSend).toHaveBeenCalledWith(
			JSON.stringify({ type: 'constructor-callback' })
		);
		server.webClients.delete('constructor-client');
		const fastify = {
			register: vi.fn().mockResolvedValue(undefined),
			listen: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			server: { address: vi.fn(() => ({ port: 4321 })) },
		};
		const staticRoutes = { registerRoutes: vi.fn() };
		const apiRoutes = { setCallbacks: vi.fn(), registerRoutes: vi.fn() };
		const wsRoute = { setCallbacks: vi.fn(), registerRoute: vi.fn() };
		const messageHandler = { setCallbacks: vi.fn(), handleMessage: vi.fn() };
		const broadcastService = {
			setGetWebClientsCallback: vi.fn(),
			broadcastToAll: vi.fn(),
			broadcastToSession: vi.fn(),
			broadcastSessionStateChange: vi.fn(),
			broadcastSessionAdded: vi.fn(),
			broadcastSessionRemoved: vi.fn(),
			broadcastSessionsList: vi.fn(),
			broadcastActiveSessionChange: vi.fn(),
			broadcastTabsChange: vi.fn(),
			broadcastThemeChange: vi.fn(),
			broadcastBionifyReadingModeChange: vi.fn(),
			broadcastCustomCommands: vi.fn(),
			broadcastUserInput: vi.fn(),
			broadcastSessionLive: vi.fn(),
			broadcastSessionOffline: vi.fn(),
			broadcastAutoRunState: vi.fn(),
		};

		server.server = fastify;
		server.staticRoutes = staticRoutes;
		server.apiRoutes = apiRoutes;
		server.wsRoute = wsRoute;
		server.messageHandler = messageHandler;
		server.broadcastService = broadcastService;

		const sessions = [{ id: 'session-1' }];
		const sessionDetail = { id: 'session-1', detail: true };
		const theme = { id: 'theme-1' };
		const history = [{ id: 'history-1' }];
		const commands = [{ name: 'Explain', command: '/explain' }];
		const writeToSession = vi.fn();
		const interruptSession = vi.fn().mockResolvedValue(undefined);
		server.setGetSessionsCallback(() => sessions);
		server.setGetSessionDetailCallback((sessionId: string, tabId?: string) => ({
			...sessionDetail,
			sessionId,
			tabId,
		}));
		server.setGetThemeCallback(() => theme);
		server.setGetBionifyReadingModeCallback(() => true);
		server.setGetCustomCommandsCallback(() => commands);
		server.setWriteToSessionCallback(writeToSession);
		server.setExecuteCommandCallback(vi.fn().mockResolvedValue(undefined));
		server.setInterruptSessionCallback(interruptSession);
		server.setSwitchModeCallback(vi.fn().mockResolvedValue(undefined));
		server.setSelectSessionCallback(vi.fn().mockResolvedValue(undefined));
		server.setSelectTabCallback(vi.fn().mockResolvedValue(undefined));
		server.setNewTabCallback(vi.fn().mockResolvedValue(undefined));
		server.setCloseTabCallback(vi.fn().mockResolvedValue(undefined));
		server.setRenameTabCallback(vi.fn().mockResolvedValue(undefined));
		server.setStarTabCallback(vi.fn().mockResolvedValue(undefined));
		server.setReorderTabCallback(vi.fn().mockResolvedValue(undefined));
		server.setToggleBookmarkCallback(vi.fn().mockResolvedValue(undefined));
		server.setGetHistoryCallback(() => history);
		server.setRateLimitConfig({ enabled: false, max: 7, maxPost: 3 });

		const result = await server.start();

		expect(result).toEqual({
			port: 4321,
			token: 'token-123',
			url: 'http://10.0.0.5:4321/token-123',
		});
		expect(server.isActive()).toBe(true);
		expect(server.getUrl()).toBe('http://10.0.0.5:4321');
		expect(server.getPort()).toBe(4321);
		expect(server.getSecurityToken()).toBe('token-123');
		expect(server.getSecureUrl()).toBe('http://10.0.0.5:4321/token-123');
		expect(server.getSessionUrl('session-1')).toBe(
			'http://10.0.0.5:4321/token-123/session/session-1'
		);
		expect(server.getRateLimitConfig()).toMatchObject({ enabled: false, max: 7, maxPost: 3 });
		expect(fastify.register).toHaveBeenCalledWith(expect.any(Function), { origin: true });
		expect(fastify.register).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ prefix: '/token-123/assets/' })
		);
		expect(fastify.register).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ prefix: '/token-123/icons/' })
		);
		expect(fastify.listen).toHaveBeenCalledWith({ port: 0, host: '0.0.0.0' });
		expect(staticRoutes.registerRoutes).toHaveBeenCalledWith(fastify);
		expect(apiRoutes.registerRoutes).toHaveBeenCalledWith(fastify);
		expect(wsRoute.registerRoute).toHaveBeenCalledWith(fastify);

		const allowList = fastify.register.mock.calls.find(([, opts]) => opts?.allowList)?.[1]
			.allowList;
		expect(allowList({ url: '/any' })).toBe(true);
		server.setRateLimitConfig({ enabled: true });
		expect(allowList({ url: '/health' })).toBe(true);
		expect(allowList({ url: '/api/sessions' })).toBe(false);
		const rateLimitOptions = fastify.register.mock.calls.find(
			([, opts]) => opts?.keyGenerator
		)?.[1];
		expect(rateLimitOptions.keyGenerator({ ip: '127.0.0.1' })).toBe('127.0.0.1');
		expect(rateLimitOptions.errorResponseBuilder({}, { after: '5 seconds' })).toEqual({
			statusCode: 429,
			error: 'Too Many Requests',
			message: 'Rate limit exceeded. Try again later.',
			retryAfter: '5 seconds',
		});

		const apiCallbacks = apiRoutes.setCallbacks.mock.calls[0][0];
		expect(apiCallbacks.getSessions()).toBe(sessions);
		expect(apiCallbacks.getSessionDetail('session-1', 'tab-1')).toMatchObject({
			sessionId: 'session-1',
			tabId: 'tab-1',
		});
		expect(apiCallbacks.getTheme()).toBe(theme);
		apiCallbacks.writeToSession('session-1', 'hello');
		expect(writeToSession).toHaveBeenCalledWith('session-1', 'hello');
		await expect(apiCallbacks.interruptSession('session-1')).resolves.toBeUndefined();
		expect(interruptSession).toHaveBeenCalledWith('session-1');
		expect(apiCallbacks.getHistory('/repo', 'session-1')).toBe(history);
		expect(apiCallbacks.getLiveSessionInfo('session-1')).toBeUndefined();
		expect(apiCallbacks.isSessionLive('session-1')).toBe(false);

		const wsCallbacks = wsRoute.setCallbacks.mock.calls[0][0];
		expect(wsCallbacks.getSessions()).toBe(sessions);
		expect(wsCallbacks.getTheme()).toBe(theme);
		expect(wsCallbacks.getBionifyReadingMode()).toBe(true);
		expect(wsCallbacks.getCustomCommands()).toBe(commands);
		expect(wsCallbacks.getAutoRunStates()).toEqual(new Map());
		wsCallbacks.onClientConnect({ id: 'client-1', sessionId: 'session-1' });
		expect(server.getWebClientCount()).toBe(1);
		wsCallbacks.handleMessage('client-1', { type: 'ping' });
		expect(messageHandler.handleMessage).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'client-1' }),
			{ type: 'ping' }
		);
		wsCallbacks.handleMessage('missing-client', { type: 'ping' });
		expect(messageHandler.handleMessage).toHaveBeenCalledTimes(1);
		wsCallbacks.onClientError('client-1');
		expect(server.getWebClientCount()).toBe(0);
		wsCallbacks.onClientConnect({ id: 'client-2' });
		wsCallbacks.onClientDisconnect('client-2');
		expect(server.getWebClientCount()).toBe(0);

		const messageCallbacks = messageHandler.setCallbacks.mock.calls[0][0];
		expect(messageCallbacks.getSessionDetail('session-1')).toMatchObject({
			sessionId: 'session-1',
		});
		await expect(messageCallbacks.executeCommand('session-1', 'pwd', 'terminal')).resolves.toBe(
			undefined
		);
		await expect(messageCallbacks.switchMode('session-1', 'ai')).resolves.toBe(undefined);
		await expect(messageCallbacks.selectSession('session-1', 'tab-1')).resolves.toBe(undefined);
		await expect(messageCallbacks.selectTab('session-1', 'tab-1')).resolves.toBe(undefined);
		await expect(messageCallbacks.newTab('session-1')).resolves.toBe(undefined);
		await expect(messageCallbacks.closeTab('session-1', 'tab-1')).resolves.toBe(undefined);
		await expect(messageCallbacks.renameTab('session-1', 'tab-1', 'Plan')).resolves.toBe(undefined);
		await expect(messageCallbacks.starTab('session-1', 'tab-1', true)).resolves.toBe(undefined);
		await expect(messageCallbacks.reorderTab('session-1', 0, 1)).resolves.toBe(undefined);
		await expect(messageCallbacks.toggleBookmark('session-1')).resolves.toBe(undefined);
		expect(messageCallbacks.getSessions()).toBe(sessions);
		expect(messageCallbacks.getLiveSessionInfo('session-1')).toBeUndefined();
		expect(messageCallbacks.isSessionLive('session-1')).toBe(false);

		server.setSessionLive('session-1', 'agent-session-1');
		expect(server.isSessionLive('session-1')).toBe(true);
		expect(server.getLiveSessions()).toHaveLength(1);
		const autoRunState = { isRunning: true, completedTasks: 1, totalTasks: 2 };
		server.broadcastAutoRunState('session-1', autoRunState);
		expect(apiCallbacks.getLiveSessionInfo('session-1')).toEqual(
			expect.objectContaining({ sessionId: 'session-1', agentSessionId: 'agent-session-1' })
		);
		expect(wsCallbacks.getLiveSessionInfo('session-1')).toEqual(
			expect.objectContaining({ sessionId: 'session-1', agentSessionId: 'agent-session-1' })
		);
		expect(wsCallbacks.isSessionLive('session-1')).toBe(true);
		expect(messageCallbacks.getLiveSessionInfo('session-1')).toEqual(
			expect.objectContaining({ sessionId: 'session-1', agentSessionId: 'agent-session-1' })
		);
		expect(messageCallbacks.isSessionLive('session-1')).toBe(true);
		expect(wsCallbacks.getAutoRunStates()).toEqual(new Map([['session-1', autoRunState]]));
		server.setSessionOffline('session-1');
		expect(server.isSessionLive('session-1')).toBe(false);

		server.broadcastToWebClients({ type: 'all' });
		server.broadcastToSessionClients('session-1', { type: 'session' });
		server.broadcastSessionStateChange('session-1', 'running', { name: 'Agent' });
		server.broadcastSessionAdded({ id: 'session-1' });
		server.broadcastSessionRemoved('session-1');
		server.broadcastSessionsList([{ id: 'session-1' }]);
		server.broadcastActiveSessionChange('session-1');
		server.broadcastTabsChange('session-1', [{ id: 'tab-1' }], 'tab-1');
		server.broadcastThemeChange(theme);
		server.broadcastBionifyReadingModeChange(true);
		server.broadcastCustomCommands(commands);
		server.broadcastUserInput('session-1', 'hello', 'ai');
		expect(broadcastService.broadcastToAll).toHaveBeenCalledWith({ type: 'all' });
		expect(broadcastService.broadcastToSession).toHaveBeenCalledWith('session-1', {
			type: 'session',
		});
		expect(broadcastService.broadcastUserInput).toHaveBeenCalledWith('session-1', 'hello', 'ai');

		await expect(server.start()).resolves.toEqual({
			port: 4321,
			token: 'token-123',
			url: 'http://10.0.0.5:4321/token-123',
		});
		expect(fastify.listen).toHaveBeenCalledTimes(1);
		expect(server.getServer()).toBe(fastify);

		await server.stop();
		expect(fastify.close).toHaveBeenCalledTimes(1);
		expect(server.isActive()).toBe(false);
		await server.stop();
		expect(fastify.close).toHaveBeenCalledTimes(1);
	});

	it('propagates start failures and swallows stop failures after logging', async () => {
		const server = new WebServer(0, 'token-123') as any;
		server.server = {
			register: vi.fn().mockResolvedValue(undefined),
			listen: vi.fn().mockRejectedValue(new Error('listen failed')),
			close: vi.fn().mockRejectedValue(new Error('close failed')),
			server: { address: vi.fn(() => null) },
		};
		server.staticRoutes = { registerRoutes: vi.fn() };
		server.apiRoutes = { setCallbacks: vi.fn(), registerRoutes: vi.fn() };
		server.wsRoute = { setCallbacks: vi.fn(), registerRoute: vi.fn() };
		server.messageHandler = { setCallbacks: vi.fn(), handleMessage: vi.fn() };

		await expect(server.start()).rejects.toThrow('listen failed');

		server.isRunning = true;
		await expect(server.stop()).resolves.toBeUndefined();
		expect(server.isActive()).toBe(true);
	});

	it('starts without optional static asset folders and preserves configured port for non-object addresses', async () => {
		const distWebDir = path.join(tempRoot, 'dist', 'web');
		mkdirSync(distWebDir, { recursive: true });
		writeFileSync(
			path.join(distWebDir, 'index.html'),
			'<script type="module" src="./assets/main.js"></script>'
		);
		const server = new WebServer(1234, 'token-123') as any;
		const fastify = {
			register: vi.fn().mockResolvedValue(undefined),
			listen: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			server: { address: vi.fn(() => 'pipe') },
		};
		server.server = fastify;
		server.staticRoutes = { registerRoutes: vi.fn() };
		server.apiRoutes = { setCallbacks: vi.fn(), registerRoutes: vi.fn() };
		server.wsRoute = { setCallbacks: vi.fn(), registerRoute: vi.fn() };
		server.messageHandler = { setCallbacks: vi.fn(), handleMessage: vi.fn() };

		await expect(server.start()).resolves.toEqual({
			port: 1234,
			token: 'token-123',
			url: 'http://10.0.0.5:1234/token-123',
		});

		expect(fastify.register).not.toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ prefix: '/token-123/assets/' })
		);
		expect(fastify.register).not.toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ prefix: '/token-123/icons/' })
		);
	});
});
