import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { captureException } from '../../../main/utils/sentry';
import { WebServer } from '../../../main/web-server/WebServer';

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

type PrivateWebServer = WebServer & Record<string, any>;

function createServer(): PrivateWebServer {
	return new WebServer(0, 'test-token') as PrivateWebServer;
}

function createSpyBag(): Record<string, ReturnType<typeof vi.fn>> {
	const spies = new Map<string, ReturnType<typeof vi.fn>>();
	return new Proxy(
		{},
		{
			get(_target, prop) {
				if (typeof prop !== 'string') return undefined;
				if (!spies.has(prop)) spies.set(prop, vi.fn());
				return spies.get(prop);
			},
		}
	) as Record<string, ReturnType<typeof vi.fn>>;
}

describe('WebServer web asset resolution', () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(path.join(os.tmpdir(), 'maestro-web-assets-'));
		vi.spyOn(process, 'cwd').mockReturnValue(tempRoot);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it('prefers built dist/web assets over the source web index', () => {
		const distWebDir = path.join(tempRoot, 'dist', 'web');
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
});

describe('WebServer', () => {
	let server: PrivateWebServer;

	beforeEach(() => {
		vi.clearAllMocks();
		server = createServer();
	});

	it('delegates registry callback setters to CallbackRegistry', () => {
		const directTerminalSetters = new Set([
			'setWriteToTerminalCallback',
			'setResizeTerminalCallback',
			'setSpawnTerminalForWebCallback',
			'setKillTerminalForWebCallback',
		]);
		const registrySetters = Object.getOwnPropertyNames(WebServer.prototype).filter(
			(name) =>
				name.startsWith('set') && name.endsWith('Callback') && !directTerminalSetters.has(name)
		);
		const registry = createSpyBag();
		server.callbackRegistry = registry;

		for (const setterName of registrySetters) {
			const callback = vi.fn();

			server[setterName](callback);

			expect(registry[setterName]).toHaveBeenCalledWith(callback);
		}
	});

	it('stores direct terminal callbacks separately from CallbackRegistry', () => {
		const writeToTerminal = vi.fn();
		const resizeTerminal = vi.fn();
		const spawnTerminalForWeb = vi.fn();
		const killTerminalForWeb = vi.fn();

		server.setWriteToTerminalCallback(writeToTerminal);
		server.setResizeTerminalCallback(resizeTerminal);
		server.setSpawnTerminalForWebCallback(spawnTerminalForWeb);
		server.setKillTerminalForWebCallback(killTerminalForWeb);

		expect(server.writeToTerminalCallback).toBe(writeToTerminal);
		expect(server.resizeTerminalCallback).toBe(resizeTerminal);
		expect(server.spawnTerminalForWebCallback).toBe(spawnTerminalForWeb);
		expect(server.killTerminalForWebCallback).toBe(killTerminalForWeb);
	});

	it('delegates broadcast methods to broadcast and live-session services', () => {
		const broadcastService = createSpyBag();
		const liveSessionManager = { setAutoRunState: vi.fn() };
		server.broadcastService = broadcastService;
		server.liveSessionManager = liveSessionManager;

		const message = { type: 'ping' };
		const session = { id: 'session-1' };
		const tabs = [{ id: 'tab-1' }];
		const theme = { id: 'dark' };
		const toolLog = {
			id: 'tool-1',
			timestamp: 1,
			source: 'tool',
			text: 'Running',
			metadata: { toolState: { name: 'Read', status: 'running' } },
		};
		const cases: Array<[string, string, unknown[]]> = [
			['broadcastToWebClients', 'broadcastToAll', [message]],
			['broadcastNotificationEvent', 'broadcastNotificationEvent', [{ id: 'notification-1' }]],
			['broadcastToSessionClients', 'broadcastToSession', ['session-1', message]],
			[
				'broadcastSessionStateChange',
				'broadcastSessionStateChange',
				['session-1', 'busy', { cwd: '/tmp' }],
			],
			['broadcastSessionAdded', 'broadcastSessionAdded', [session]],
			['broadcastSessionRemoved', 'broadcastSessionRemoved', ['session-1']],
			['broadcastSessionsList', 'broadcastSessionsList', [[session]]],
			['broadcastActiveSessionChange', 'broadcastActiveSessionChange', ['session-1']],
			['broadcastTabsChange', 'broadcastTabsChange', ['session-1', tabs, 'tab-1']],
			['broadcastThemeChange', 'broadcastThemeChange', [theme]],
			['broadcastBionifyReadingModeChange', 'broadcastBionifyReadingModeChange', [true]],
			['broadcastCustomCommands', 'broadcastCustomCommands', [[{ name: 'Build' }]]],
			['broadcastSettingsChanged', 'broadcastSettingsChanged', [{ theme: 'dark' }]],
			[
				'broadcastAutoRunDocsChanged',
				'broadcastAutoRunDocsChanged',
				['session-1', [{ name: 'doc.md' }]],
			],
			['broadcastUserInput', 'broadcastUserInput', ['session-1', 'npm test', 'terminal']],
			['broadcastGroupChatMessage', 'broadcastGroupChatMessage', ['chat-1', { text: 'hello' }]],
			[
				'broadcastGroupChatStateChange',
				'broadcastGroupChatStateChange',
				['chat-1', { status: 'running' }],
			],
			[
				'broadcastContextOperationProgress',
				'broadcastContextOperationProgress',
				['session-1', 'merge', 50],
			],
			[
				'broadcastContextOperationComplete',
				'broadcastContextOperationComplete',
				['session-1', 'merge', true],
			],
			['broadcastCueActivity', 'broadcastCueActivity', [{ id: 'activity-1' }]],
			['broadcastCueSubscriptionsChanged', 'broadcastCueSubscriptionsChanged', [[{ id: 'sub-1' }]]],
			['broadcastToolEvent', 'broadcastToolEvent', ['session-1', 'tab-1', toolLog]],
			['broadcastGroupsChanged', 'broadcastGroupsChanged', [[{ id: 'group-1', name: 'Group' }]]],
		];

		for (const [serverMethod, serviceMethod, args] of cases) {
			server[serverMethod](...args);

			expect(broadcastService[serviceMethod]).toHaveBeenCalledWith(...args);
		}

		server.broadcastAutoRunState('session-1', { isRunning: true });

		expect(liveSessionManager.setAutoRunState).toHaveBeenCalledWith('session-1', {
			isRunning: true,
		});
	});

	it('wires API and WebSocket route callbacks to current managers', () => {
		const registry = createSpyBag();
		const liveSessionManager = createSpyBag();
		const staticRoutes = { registerRoutes: vi.fn() };
		let apiCallbacks: Record<string, (...args: any[]) => any> = {};
		let wsCallbacks: Record<string, (...args: any[]) => any> = {};
		const apiRoutes = {
			setCallbacks: vi.fn((callbacks) => {
				apiCallbacks = callbacks;
			}),
			registerRoutes: vi.fn(),
		};
		const wsRoute = {
			setCallbacks: vi.fn((callbacks) => {
				wsCallbacks = callbacks;
			}),
			registerRoute: vi.fn(),
		};
		const messageHandler = { handleMessage: vi.fn() };
		const killTerminalForWeb = vi.fn().mockReturnValue(true);

		server.callbackRegistry = registry;
		server.liveSessionManager = liveSessionManager;
		server.staticRoutes = staticRoutes;
		server.apiRoutes = apiRoutes;
		server.wsRoute = wsRoute;
		server.messageHandler = messageHandler;
		server.killTerminalForWebCallback = killTerminalForWeb;

		server.setupRoutes();

		expect(staticRoutes.registerRoutes).toHaveBeenCalledTimes(1);
		expect(apiRoutes.registerRoutes).toHaveBeenCalledTimes(1);
		expect(wsRoute.registerRoute).toHaveBeenCalledTimes(1);

		apiCallbacks.getSessions();
		apiCallbacks.getSessionDetail('session-1', 'tab-1');
		apiCallbacks.getTheme();
		apiCallbacks.writeToSession('session-1', 'hello');
		void apiCallbacks.interruptSession('session-1');
		apiCallbacks.getHistory('/repo', 'session-1');
		apiCallbacks.getLiveSessionInfo('session-1');
		apiCallbacks.isSessionLive('session-1');

		expect(registry.getSessions).toHaveBeenCalled();
		expect(registry.getSessionDetail).toHaveBeenCalledWith('session-1', 'tab-1');
		expect(registry.getTheme).toHaveBeenCalled();
		expect(registry.writeToSession).toHaveBeenCalledWith('session-1', 'hello');
		expect(registry.interruptSession).toHaveBeenCalledWith('session-1');
		expect(registry.getHistory).toHaveBeenCalledWith('/repo', 'session-1');
		expect(liveSessionManager.getLiveSessionInfo).toHaveBeenCalledWith('session-1');
		expect(liveSessionManager.isSessionLive).toHaveBeenCalledWith('session-1');

		wsCallbacks.getSessions();
		wsCallbacks.getTheme();
		wsCallbacks.getBionifyReadingMode();
		wsCallbacks.getCustomCommands();
		wsCallbacks.getAutoRunStates();
		wsCallbacks.getLiveSessionInfo('session-1');
		wsCallbacks.isSessionLive('session-1');
		wsCallbacks.onClientConnect({ id: 'client-1' });
		server.webClients.set('client-1', {
			id: 'client-1',
			subscribedSessionId: 'session-1',
		});
		wsCallbacks.onClientDisconnect('client-1');
		server.webClients.set('client-2', { id: 'client-2' });
		wsCallbacks.onClientError('client-2');
		server.webClients.set('client-3', { id: 'client-3' });
		wsCallbacks.handleMessage('client-3', { type: 'ping' });

		expect(registry.getBionifyReadingMode).toHaveBeenCalled();
		expect(registry.getCustomCommands).toHaveBeenCalled();
		expect(liveSessionManager.getAutoRunStates).toHaveBeenCalled();
		expect(killTerminalForWeb).toHaveBeenCalledWith('session-1');
		expect(server.webClients.has('client-1')).toBe(false);
		expect(server.webClients.has('client-2')).toBe(false);
		expect(messageHandler.handleMessage).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'client-3' }),
			{ type: 'ping' }
		);
	});

	it('wires message-handler callbacks to CallbackRegistry and terminal callbacks', async () => {
		const registry = createSpyBag();
		let callbacks: Record<string, (...args: any[]) => any> = {};
		const messageHandler = {
			setCallbacks: vi.fn((registeredCallbacks) => {
				callbacks = registeredCallbacks;
			}),
		};
		server.callbackRegistry = registry;
		server.liveSessionManager = createSpyBag();
		server.messageHandler = messageHandler;

		server.setupMessageHandlerCallbacks();

		const skippedCallbacks = new Set([
			'getLiveSessionInfo',
			'isSessionLive',
			'listCuePipelines',
			'getCuePipeline',
			'setCuePipeline',
			'removeCuePipeline',
			'writeToTerminal',
			'resizeTerminal',
			'spawnTerminalForWeb',
			'killTerminalForWeb',
		]);
		const argsByCallback: Record<string, unknown[]> = {
			executeCommand: ['session-1', 'npm test', 'terminal', 'tab-1', true, ['image.png']],
			switchMode: ['session-1', 'terminal'],
			selectSession: ['session-1', 'tab-1', true],
			selectTab: ['session-1', 'tab-1'],
			newTab: ['session-1'],
			closeTab: ['session-1', 'tab-1'],
			renameTab: ['session-1', 'tab-1', 'New name'],
			starTab: ['session-1', 'tab-1', true],
			reorderTab: ['session-1', 0, 1],
			toggleBookmark: ['session-1'],
			openFileTab: ['session-1', '/tmp/file.ts', true],
			refreshFileTree: ['session-1'],
			openBrowserTab: ['session-1', 'https://example.com'],
			openTerminalTab: ['session-1', { cwd: '/tmp' }],
			newAITabWithPrompt: ['session-1', 'hello'],
			refreshAutoRunDocs: ['session-1'],
			configureAutoRun: ['session-1', { enabled: true }],
			setSessionAutoRunFolder: ['session-1', '/tmp/docs'],
			getAutoRunDocs: ['session-1'],
			getAutoRunDocContent: ['session-1', 'doc.md'],
			saveAutoRunDoc: ['session-1', 'doc.md', 'content'],
			stopAutoRun: ['session-1'],
			resetAutoRunDocTasks: ['session-1', 'doc.md'],
			resumeAutoRunError: ['session-1'],
			skipAutoRunDocument: ['session-1'],
			abortAutoRunError: ['session-1'],
			listPlaybooks: ['session-1'],
			createPlaybook: ['session-1', { name: 'Book' }],
			updatePlaybook: ['session-1', 'playbook-1', { name: 'Updated' }],
			deletePlaybook: ['session-1', 'playbook-1'],
			setSetting: ['theme', 'dark'],
			createGroup: ['Group', 'G'],
			renameGroup: ['group-1', 'Renamed'],
			deleteGroup: ['group-1'],
			moveSessionToGroup: ['session-1', 'group-1'],
			createSession: ['Agent', 'codex', '/repo', 'group-1', { provider: 'codex' }],
			createWorktreeSession: ['session-1', { branch: 'feature' }],
			deleteSession: ['session-1'],
			renameSession: ['session-1', 'Renamed'],
			updateSessionCwd: ['session-1', '/repo'],
			updateSessionSsh: ['session-1', { enabled: true }],
			getGitStatus: ['session-1'],
			getGitDiff: ['session-1', 'file.ts'],
			getGitBranchesForSession: ['session-1'],
			listWorktreesForSession: ['session-1'],
			startGroupChat: ['Topic', ['session-1']],
			getGroupChatState: ['chat-1'],
			stopGroupChat: ['chat-1'],
			sendGroupChatMessage: ['chat-1', 'hello'],
			mergeContext: ['session-1', 'session-2'],
			transferContext: ['session-1', 'session-2'],
			summarizeContext: ['session-1'],
			createGist: ['session-1', 'description', false],
			getCueSubscriptions: ['session-1'],
			toggleCueSubscription: ['subscription-1', true],
			getCueActivity: ['session-1', 10],
			triggerCueSubscription: ['subscription', 'prompt', 'session-1'],
			getUsageDashboard: ['week'],
			generateDirectorNotesSynopsis: [7, 'codex'],
			notifyToast: [{ title: 'Done' }],
			notifyCenterFlash: [{ title: 'Notice' }],
			getMarketplaceManifest: [{ force: true }],
			getMarketplaceDocument: ['playbook/path', 'doc.md'],
			getMarketplaceReadme: ['playbook/path'],
			importMarketplacePlaybook: ['session-1', 'playbook-1', 'Imported'],
			getSessionHistory: ['tab-1', { limit: 10 }],
		};

		for (const [name, callback] of Object.entries(callbacks)) {
			if (skippedCallbacks.has(name)) continue;

			await callback(...(argsByCallback[name] ?? []));

			expect(registry[name]).toHaveBeenCalled();
		}

		expect(callbacks.writeToTerminal('session-1', 'x')).toBe(false);
		expect(callbacks.resizeTerminal('session-1', 80, 24)).toBe(false);
		await expect(callbacks.spawnTerminalForWeb('session-1', { cwd: '/tmp' })).resolves.toEqual({
			success: false,
			pid: 0,
		});
		expect(callbacks.killTerminalForWeb('session-1')).toBe(false);

		server.setWriteToTerminalCallback(vi.fn().mockReturnValue(true));
		server.setResizeTerminalCallback(vi.fn().mockReturnValue(true));
		server.setSpawnTerminalForWebCallback(vi.fn().mockResolvedValue({ success: true, pid: 123 }));
		server.setKillTerminalForWebCallback(vi.fn().mockReturnValue(true));

		expect(callbacks.writeToTerminal('session-1', 'x')).toBe(true);
		expect(callbacks.resizeTerminal('session-1', 80, 24)).toBe(true);
		await expect(callbacks.spawnTerminalForWeb('session-1', { cwd: '/tmp' })).resolves.toEqual({
			success: true,
			pid: 123,
		});
		expect(callbacks.killTerminalForWeb('session-1')).toBe(true);
	});
});
