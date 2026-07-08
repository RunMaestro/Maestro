import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

const electronMocks = vi.hoisted(() => {
	const appEvents = new Map<string, (...args: unknown[]) => unknown>();
	const powerEvents = new Map<string, (...args: unknown[]) => unknown>();
	return {
		appEvents,
		powerEvents,
		app: {
			getPath: vi.fn(() => '/Users/test/Library/Application Support/Maestro'),
			setPath: vi.fn(),
			disableHardwareAcceleration: vi.fn(),
			getVersion: vi.fn(() => '1.2.3-RC.1'),
			whenReady: vi.fn(() => Promise.resolve()),
			on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
				appEvents.set(event, handler);
			}),
			quit: vi.fn(),
		},
		BrowserWindow: {
			getAllWindows: vi.fn(() => []),
		},
		protocol: {
			handle: vi.fn(),
			registerSchemesAsPrivileged: vi.fn(),
		},
		Menu: {
			buildFromTemplate: vi.fn((template) => ({ template })),
			setApplicationMenu: vi.fn(),
		},
		powerMonitor: {
			on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
				powerEvents.set(event, handler);
			}),
		},
	};
});

const loggerMock = vi.hoisted(() => ({
	debug: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	setLogLevel: vi.fn(),
	setMaxLogBuffer: vi.fn(),
	warn: vi.fn(),
}));

const platformMocks = vi.hoisted(() => ({
	isWindows: vi.fn(() => false),
	isMacOS: vi.fn(() => false),
}));

const settingsStore = vi.hoisted(() => ({
	get: vi.fn((key: string, fallback?: unknown) => {
		const values: Record<string, unknown> = {
			conductorProfile: 'Direct conductor',
			customShellPath: '/bin/zsh',
			installationId: undefined,
			logLevel: 'debug',
			maxLogBuffer: 250,
			moderatorStandingInstructions: 'Keep it short',
			wakatimeEnabled: false,
		};
		return key in values ? values[key] : fallback;
	}),
	set: vi.fn(),
	onDidChange: vi.fn(),
}));

const sessionsStore = vi.hoisted(() => ({
	get: vi.fn(() => [
		{
			id: 'agent-1',
			name: 'Agent One',
			toolType: 'claude-code',
			fullPath: '/repo',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			worktreeConfig: { basePath: '/worktrees' },
		},
	]),
}));

const agentConfigsStore = vi.hoisted(() => ({
	get: vi.fn(() => ({
		'claude-code': {
			customPath: '/opt/claude',
			customEnvVars: { API_MODE: 'test' },
		},
	})),
}));

const genericStore = vi.hoisted(() => ({
	get: vi.fn(),
	set: vi.fn(),
}));

const storeMocks = vi.hoisted(() => ({
	initializeStores: vi.fn(() => ({
		syncPath: '/sync/settings.json',
		bootstrapStore: genericStore,
	})),
	getEarlySettings: vi.fn(() => ({
		autoHideMenuBar: true,
		crashReportingEnabled: true,
		disableGpuAcceleration: true,
		useNativeTitleBar: false,
	})),
	getSettingsStore: vi.fn(() => settingsStore),
	getSessionsStore: vi.fn(() => sessionsStore),
	getGroupsStore: vi.fn(() => genericStore),
	getAgentConfigsStore: vi.fn(() => agentConfigsStore),
	getAgentCapabilitiesStore: vi.fn(() => genericStore),
	getWindowStateStore: vi.fn(() => genericStore),
	getClaudeSessionOriginsStore: vi.fn(() => genericStore),
	getAgentSessionOriginsStore: vi.fn(() => genericStore),
	getSshRemoteById: vi.fn(() => ({ name: 'Remote Workstation' })),
}));

const ipcMocks = vi.hoisted(() => ({
	cleanupAllGroomingSessions: vi.fn(),
	getActiveGroomingSessionCount: vi.fn(() => 0),
	registerAgentErrorHandlers: vi.fn(),
	registerAgentSessionsHandlers: vi.fn(),
	registerAgentsHandlers: vi.fn(),
	registerAttachmentsHandlers: vi.fn(),
	registerAutorunHandlers: vi.fn(),
	registerBmadHandlers: vi.fn(),
	registerClaudeHandlers: vi.fn(),
	registerContextHandlers: vi.fn(),
	registerCueBackupHandlers: vi.fn(),
	registerCueHandlers: vi.fn(),
	registerCueStatsHandlers: vi.fn(),
	registerDebugHandlers: vi.fn(),
	registerDirectorNotesHandlers: vi.fn(),
	registerDocumentGraphHandlers: vi.fn(),
	registerFeedbackHandlers: vi.fn(),
	registerFilesystemHandlers: vi.fn(),
	registerGitHandlers: vi.fn(),
	registerGroupChatHandlers: vi.fn(),
	registerHistoryHandlers: vi.fn(),
	registerLeaderboardHandlers: vi.fn(),
	registerMaestroCliHandlers: vi.fn(),
	registerMarketplaceHandlers: vi.fn(),
	registerMemoryHandlers: vi.fn(),
	registerNotificationsHandlers: vi.fn(),
	registerOpenSpecHandlers: vi.fn(),
	registerPersistenceHandlers: vi.fn(),
	registerPlaybooksHandlers: vi.fn(),
	registerProcessHandlers: vi.fn(),
	registerPromptsHandlers: vi.fn(),
	registerSpeckitHandlers: vi.fn(),
	registerSshRemoteHandlers: vi.fn(),
	registerStatsHandlers: vi.fn(),
	registerSymphonyHandlers: vi.fn(),
	registerSystemHandlers: vi.fn(),
	registerTabNamingHandlers: vi.fn(),
	registerWakatimeHandlers: vi.fn(),
	registerWebHandlers: vi.fn(),
	ensureCliServer: vi.fn(() => Promise.resolve()),
	startCliDiscoveryWatchdog: vi.fn(),
	stopCliDiscoveryWatchdog: vi.fn(),
	setupLoggerEventForwarding: vi.fn(),
}));

const routerMocks = vi.hoisted(() => ({
	clearActiveParticipantTaskSession: vi.fn(),
	getGroupChatReadOnlyState: vi.fn(),
	markParticipantResponded: vi.fn(),
	respawnParticipantWithRecovery: vi.fn(),
	routeAgentResponse: vi.fn(),
	routeModeratorResponse: vi.fn(),
	setGetAgentConfigCallback: vi.fn(),
	setGetCustomEnvVarsCallback: vi.fn(),
	setGetCustomShellPathCallback: vi.fn(),
	setGetModeratorSettingsCallback: vi.fn(),
	setGetSessionsCallback: vi.fn(),
	setSshStore: vi.fn(),
	spawnModeratorSynthesis: vi.fn(),
	clearModeratorResponseTimeout: vi.fn(),
}));

const lifecycleMocks = vi.hoisted(() => {
	const mockWindow = {
		on: vi.fn(),
		webContents: {
			on: vi.fn(),
			send: vi.fn(),
		},
	};
	const cliWatcher = { start: vi.fn(), stop: vi.fn() };
	const settingsWatcher = { start: vi.fn(), stop: vi.fn() };
	const windowManager = { createWindow: vi.fn(() => mockWindow) };
	const quitHandler = { setup: vi.fn() };
	return {
		cliWatcher,
		mockWindow,
		quitHandler,
		settingsWatcher,
		windowManager,
		createCliWatcher: vi.fn(() => cliWatcher),
		createQuitHandler: vi.fn(() => quitHandler),
		createSettingsWatcher: vi.fn(() => settingsWatcher),
		createWindowManager: vi.fn(() => windowManager),
		setupGlobalErrorHandlers: vi.fn(),
	};
});

const serviceMocks = vi.hoisted(() => ({
	AgentDetector: vi.fn(function AgentDetector() {
		return {
			setCustomPaths: vi.fn(),
		};
	}),
	ProcessManager: vi.fn(function ProcessManager() {
		return {
			id: 'process-manager',
			killAll: vi.fn(),
			spawn: vi.fn(),
		};
	}),
	WebServer: vi.fn(),
	MaestroCliManager: vi.fn(function MaestroCliManager() {
		return { id: 'maestro-cli-manager' };
	}),
	WakaTimeManager: vi.fn(function WakaTimeManager() {
		return {
			ensureCliInstalled: vi.fn(),
		};
	}),
}));

const historyMocks = vi.hoisted(() => ({
	startWatchingCallback: undefined as undefined | ((sessionId: string) => void),
	historyManager: {
		addEntry: vi.fn(),
		initialize: vi.fn(() => Promise.resolve()),
		startWatching: vi.fn((callback: (sessionId: string) => void) => {
			historyMocks.startWatchingCallback = callback;
		}),
	},
	getHistoryManager: vi.fn(() => historyMocks.historyManager),
}));

const statsMocks = vi.hoisted(() => ({
	closeStatsDB: vi.fn(),
	getStatsDB: vi.fn(),
	initializeStatsDB: vi.fn(),
}));

const processListenerMocks = vi.hoisted(() => ({
	setupProcessListeners: vi.fn(),
	setupWakaTimeListener: vi.fn(),
}));

const constantsMock = vi.hoisted(() => ({
	DEMO_DATA_PATH: '/demo-data',
	DEMO_MODE: false,
	REGEX_AI_SUFFIX: /ai$/,
	REGEX_AI_TAB_ID: /tab/,
	REGEX_BATCH_SESSION: /batch/,
	REGEX_MODERATOR_SESSION: /moderator/,
	REGEX_MODERATOR_SESSION_TIMESTAMP: /timestamp/,
	REGEX_SYNOPSIS_SESSION: /synopsis/,
	debugLog: vi.fn(),
}));

const safeSendMocks = vi.hoisted(() => {
	const safeSend = vi.fn();
	return {
		safeSend,
		createSafeSend: vi.fn(() => safeSend),
		isWebContentsAvailable: vi.fn((window) => Boolean(window?.webContents)),
	};
});

const webServerFactoryMocks = vi.hoisted(() => {
	const createWebServer = vi.fn(() => ({ id: 'web-server' }));
	return {
		createWebServer,
		createWebServerFactory: vi.fn(() => createWebServer),
	};
});

const sentryMocks = vi.hoisted(() => ({
	IPCMode: { Classic: 'classic' },
	captureException: vi.fn(() => Promise.resolve()),
	init: vi.fn(),
	setTag: vi.fn(),
	startMemoryMonitoring: vi.fn(),
}));

const promptMocks = vi.hoisted(() => ({
	getPrompt: vi.fn(() => 'moderator prompt'),
	initializePrompts: vi.fn(() => Promise.resolve()),
	savePrompt: vi.fn(() => Promise.resolve()),
}));

const cueMocks = vi.hoisted(() => ({
	CueEngine: vi.fn(function CueEngine() {
		return {
			getActiveRuns: vi.fn(() => []),
			getActivityLog: vi.fn(() => []),
			getGraphData: vi.fn(() => []),
			isEnabled: vi.fn(() => false),
			reconcileAfterWake: vi.fn(),
			setSubscriptionEnabled: vi.fn(() => Promise.resolve(true)),
			start: vi.fn(),
			stop: vi.fn(),
			triggerSubscription: vi.fn(() => true),
		};
	}),
	configureCueTelemetry: vi.fn(),
	executeCueCli: vi.fn(),
	executeCueNotify: vi.fn(),
	executeCuePrompt: vi.fn(),
	executeCueShell: vi.fn(),
	getCueProcessList: vi.fn(() => []),
	recordCueHistoryEntry: vi.fn(() => ({ text: 'cue history' })),
	stopCueCliRun: vi.fn(() => false),
	stopCueRun: vi.fn(() => false),
	stopCueShellRun: vi.fn(() => false),
}));

const usageMocks = vi.hoisted(() => ({
	UsageRefreshScheduler: vi.fn(function UsageRefreshScheduler() {
		return {
			start: vi.fn(),
			stop: vi.fn(),
		};
	}),
	createInteractiveReplayController: vi.fn(() => ({ id: 'interactive-replay-controller' })),
	getMaestroPBinPath: vi.fn(() => '/usr/local/bin/maestro-p'),
	runStartupUsageSampling: vi.fn(() => Promise.resolve()),
	sampleClaudeUsage: vi.fn(() => Promise.resolve(null)),
	setClaudeUsageSnapshot: vi.fn(),
}));

const capabilityMocks = vi.hoisted(() => ({
	capabilitySnapshots: {
		get: vi.fn(() => undefined),
		init: vi.fn(),
	},
	createSnapshotBroadcaster: vi.fn(() => vi.fn()),
}));

const deepLinkMocks = vi.hoisted(() => ({
	flushPendingDeepLink: vi.fn(),
	setupDeepLinkHandling: vi.fn(() => true),
}));

vi.mock('electron', () => electronMocks);
vi.mock('../../shared/platformDetection', () => platformMocks);
vi.mock('../../main/utils/logger', () => ({ logger: loggerMock }));
vi.mock('../../main/stores', () => storeMocks);
vi.mock('../../main/ipc/handlers', () => ipcMocks);
vi.mock('../../main/group-chat/group-chat-router', () => routerMocks);
vi.mock('../../main/group-chat/group-chat-storage', () => ({
	loadGroupChat: vi.fn(),
	updateGroupChat: vi.fn(),
	updateParticipant: vi.fn(),
}));
vi.mock('../../main/group-chat/group-chat-moderator', () => ({ stopSessionCleanup: vi.fn() }));
vi.mock('../../main/group-chat/session-recovery', () => ({
	initiateSessionRecovery: vi.fn(),
	needsSessionRecovery: vi.fn(),
}));
vi.mock('../../main/group-chat/session-parser', () => ({ parseParticipantSessionId: vi.fn() }));
vi.mock('../../main/group-chat/output-parser', () => ({ extractTextFromStreamJson: vi.fn() }));
vi.mock('../../main/group-chat/output-buffer', () => ({
	appendToGroupChatBuffer: vi.fn(),
	clearGroupChatBuffer: vi.fn(),
	getGroupChatBufferedOutput: vi.fn(),
}));
vi.mock('../../main/ipc/handlers/groupChat', () => ({ groupChatEmitters: {} }));
vi.mock('../../main/utils/ssh-remote-resolver', () => ({
	createSshRemoteStoreAdapter: vi.fn(() => ({ get: vi.fn() })),
}));
vi.mock('../../main/storage', () => ({ initializeSessionStorages: vi.fn() }));
vi.mock('../../main/parsers', () => ({ initializeOutputParsers: vi.fn() }));
vi.mock('../../main/parsers/usage-aggregator', () => ({ calculateContextTokens: vi.fn() }));
vi.mock('../../main/constants', () => constantsMock);
vi.mock('../../shared/agentConstants', () => ({
	DEFAULT_CONTEXT_WINDOWS: {},
	FALLBACK_CONTEXT_WINDOW: 200000,
}));
vi.mock('../../shared/agentMetadata', () => ({
	getAgentDisplayName: vi.fn(() => 'Claude Code'),
}));
vi.mock('../../shared/sentryFilters', () => ({
	shouldDropSentryEvent: vi.fn((event) =>
		Boolean(
			event?.exception?.values?.some((value: { value?: string }) =>
				value.value?.includes('pagefile.sys')
			)
		)
	),
}));
vi.mock('../../main/agents/definitions', () => ({
	getAgentDefinition: vi.fn(() => ({
		configOptions: [{ key: 'contextWindow', default: 200000 }],
	})),
}));
vi.mock('../../main/global-hotkey-manager', () => ({
	disposeGlobalHotkey: vi.fn(),
	initGlobalHotkey: vi.fn(),
	setGlobalShowHotkey: vi.fn(() => true),
}));
vi.mock('../../main/cue/cue-engine', () => ({ CueEngine: cueMocks.CueEngine }));
vi.mock('../../main/cue/cue-telemetry', () => ({
	configureCueTelemetry: cueMocks.configureCueTelemetry,
}));
vi.mock('../../main/cue/cue-executor', () => ({
	executeCuePrompt: cueMocks.executeCuePrompt,
	getCueProcessList: cueMocks.getCueProcessList,
	recordCueHistoryEntry: cueMocks.recordCueHistoryEntry,
	stopCueRun: cueMocks.stopCueRun,
}));
vi.mock('../../main/cue/cue-shell-executor', () => ({
	executeCueShell: cueMocks.executeCueShell,
	stopCueShellRun: cueMocks.stopCueShellRun,
}));
vi.mock('../../main/cue/cue-cli-executor', () => ({
	executeCueCli: cueMocks.executeCueCli,
	stopCueCliRun: cueMocks.stopCueCliRun,
}));
vi.mock('../../main/cue/cue-notify-executor', () => ({
	executeCueNotify: cueMocks.executeCueNotify,
}));
vi.mock('../../main/agents/capability-snapshot', () => capabilityMocks);
vi.mock('../../main/deep-links', () => deepLinkMocks);
vi.mock('../../main/stores/migrations', () => ({ runSettingsMigrations: vi.fn() }));
vi.mock('../../main/prompt-manager', () => promptMocks);
vi.mock('../../main/utils/wslDetector', () => ({ checkWslEnvironment: vi.fn() }));
vi.mock('../../main/utils/safe-send', () => safeSendMocks);
vi.mock('../../main/web-server/web-server-factory', () => webServerFactoryMocks);
vi.mock('../../main/app-lifecycle', () => lifecycleMocks);
vi.mock('../../main/process-listeners', () => ({
	setupProcessListeners: processListenerMocks.setupProcessListeners,
}));
vi.mock('../../main/process-listeners/wakatime-listener', () => ({
	setupWakaTimeListener: processListenerMocks.setupWakaTimeListener,
}));
vi.mock('../../main/wakatime-manager', () => ({ WakaTimeManager: serviceMocks.WakaTimeManager }));
vi.mock('../../main/maestro-cli-manager', () => ({
	MaestroCliManager: serviceMocks.MaestroCliManager,
}));
vi.mock('../../main/agents/claude-interactive-replay', () => ({
	createInteractiveReplayController: usageMocks.createInteractiveReplayController,
}));
vi.mock('../../main/agents/claude-usage-sampler', () => ({
	sampleUsage: usageMocks.sampleClaudeUsage,
}));
vi.mock('../../main/stores/claudeUsageStore', () => ({
	setSnapshot: usageMocks.setClaudeUsageSnapshot,
}));
vi.mock('../../main/agents/claude-usage-startup', () => ({
	getMaestroPBinPath: usageMocks.getMaestroPBinPath,
	runStartupUsageSampling: usageMocks.runStartupUsageSampling,
}));
vi.mock('../../main/agents/usage-refresh-scheduler', () => ({
	UsageRefreshScheduler: usageMocks.UsageRefreshScheduler,
}));
vi.mock('../../main/process-manager', () => ({ ProcessManager: serviceMocks.ProcessManager }));
vi.mock('../../main/web-server', () => ({ WebServer: serviceMocks.WebServer }));
vi.mock('../../main/agents', () => ({ AgentDetector: serviceMocks.AgentDetector }));
vi.mock('../../main/tunnel-manager', () => ({ tunnelManager: { closeAll: vi.fn() } }));
vi.mock('../../main/power-manager', () => ({
	powerManager: {
		addBlockReason: vi.fn(),
		release: vi.fn(),
		removeBlockReason: vi.fn(),
	},
}));
vi.mock('../../main/history-manager', () => ({
	getHistoryManager: historyMocks.getHistoryManager,
}));
vi.mock('../../main/stats', () => statsMocks);
vi.mock('@sentry/electron/main', () => ({
	IPCMode: sentryMocks.IPCMode,
	init: sentryMocks.init,
	setTag: sentryMocks.setTag,
}));
vi.mock('../../main/utils/sentry', () => ({
	captureException: sentryMocks.captureException,
	startMemoryMonitoring: sentryMocks.startMemoryMonitoring,
}));

let consoleLog: ReturnType<typeof vi.spyOn>;

function getDefaultSetting(key: string, fallback?: unknown) {
	const values: Record<string, unknown> = {
		conductorProfile: 'Direct conductor',
		customShellPath: '/bin/zsh',
		installationId: undefined,
		logLevel: 'debug',
		maxLogBuffer: 250,
		moderatorStandingInstructions: 'Keep it short',
		wakatimeEnabled: false,
	};
	return key in values ? values[key] : fallback;
}

function mockSettingsValues(overrides: Record<string, unknown> = {}) {
	settingsStore.get.mockImplementation((key: string, fallback?: unknown) =>
		key in overrides ? overrides[key] : getDefaultSetting(key, fallback)
	);
}

async function importMainAndWaitForStartup() {
	await import('../../main/index');
	await waitFor(() => expect(lifecycleMocks.windowManager.createWindow).toHaveBeenCalled());
	await waitFor(() => expect(lifecycleMocks.cliWatcher.start).toHaveBeenCalled());
}

describe('main process entrypoint', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		electronMocks.appEvents.clear();
		electronMocks.powerEvents.clear();
		historyMocks.startWatchingCallback = undefined;
		process.env.NODE_ENV = 'test';
		delete process.env.MAESTRO_DATA_DIR;
		delete process.env.USE_PROD_DATA;
		delete process.env.VITE_PORT;
		constantsMock.DEMO_MODE = false;
		electronMocks.app.getPath.mockReturnValue('/Users/test/Library/Application Support/Maestro');
		electronMocks.app.getVersion.mockReturnValue('1.2.3-RC.1');
		platformMocks.isMacOS.mockReturnValue(false);
		agentConfigsStore.get.mockImplementation(() => ({
			'claude-code': {
				customPath: '/opt/claude',
				customEnvVars: { API_MODE: 'test' },
			},
		}));
		sessionsStore.get.mockImplementation(() => [
			{
				id: 'agent-1',
				name: 'Agent One',
				toolType: 'claude-code',
				fullPath: '/repo',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				worktreeConfig: { basePath: '/worktrees' },
			},
		]);
		mockSettingsValues();
		consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
	});

	afterEach(() => {
		consoleLog.mockRestore();
	});

	it('configures startup paths, services, IPC handlers, callbacks, and lifecycle hooks', async () => {
		await importMainAndWaitForStartup();

		expect(electronMocks.app.disableHardwareAcceleration).toHaveBeenCalledTimes(1);
		expect(consoleLog).toHaveBeenCalledWith('[STARTUP] GPU hardware acceleration disabled');
		expect(lifecycleMocks.windowManager.createWindow).toHaveBeenCalledTimes(1);
		expect(settingsStore.set).toHaveBeenCalledWith('installationId', expect.any(String));
		expect(loggerMock.info).toHaveBeenCalledWith(
			'Generated new installation ID',
			'Startup',
			expect.objectContaining({ installationId: expect.any(String) })
		);
		expect(loggerMock.setLogLevel).toHaveBeenCalledWith('debug');
		expect(loggerMock.setMaxLogBuffer).toHaveBeenCalledWith(250);
		expect(serviceMocks.ProcessManager).toHaveBeenCalledTimes(1);
		expect(serviceMocks.AgentDetector).toHaveBeenCalledTimes(1);
		expect(lifecycleMocks.cliWatcher.start).toHaveBeenCalledTimes(1);
		expect(lifecycleMocks.settingsWatcher.start).toHaveBeenCalledTimes(1);
		expect(lifecycleMocks.quitHandler.setup).toHaveBeenCalledTimes(1);
		expect(electronMocks.Menu.setApplicationMenu).toHaveBeenCalledWith(null);

		const processManager = serviceMocks.ProcessManager.mock.results[0].value;
		const agentDetector = serviceMocks.AgentDetector.mock.results[0].value;
		const wakatimeManager = serviceMocks.WakaTimeManager.mock.results[0].value;

		expect(safeSendMocks.createSafeSend.mock.calls[0][0]()).toBe(lifecycleMocks.mockWindow);

		const cliWatcherDeps = lifecycleMocks.createCliWatcher.mock.calls[0][0];
		expect(cliWatcherDeps.getMainWindow()).toBe(lifecycleMocks.mockWindow);
		expect(cliWatcherDeps.getUserDataPath()).toBe(
			'/Users/test/Library/Application Support/Maestro'
		);

		const settingsWatcherDeps = lifecycleMocks.createSettingsWatcher.mock.calls[0][0];
		expect(settingsWatcherDeps.getMainWindow()).toBe(lifecycleMocks.mockWindow);
		expect(settingsWatcherDeps.getSettingsPath()).toBe('/sync/settings.json');
		expect(settingsWatcherDeps.getAgentConfigsPath()).toBe(
			'/Users/test/Library/Application Support/Maestro'
		);

		const webServerFactoryDeps = webServerFactoryMocks.createWebServerFactory.mock.calls[0][0];
		expect(webServerFactoryDeps.getMainWindow()).toBe(lifecycleMocks.mockWindow);
		expect(webServerFactoryDeps.getProcessManager()).toBe(processManager);

		const webHandlerDeps = ipcMocks.registerWebHandlers.mock.calls[0][0];
		expect(webHandlerDeps.getWebServer()).toBeNull();
		webHandlerDeps.setWebServer({ id: 'web-server-instance' });
		expect(webHandlerDeps.getWebServer()).toEqual({ id: 'web-server-instance' });

		expect(ipcMocks.registerAutorunHandlers.mock.calls[0][0].getMainWindow()).toBe(
			lifecycleMocks.mockWindow
		);
		expect(ipcMocks.registerPlaybooksHandlers.mock.calls[0][0].getMainWindow()).toBe(
			lifecycleMocks.mockWindow
		);
		expect(ipcMocks.registerDirectorNotesHandlers.mock.calls[0][0].getProcessManager()).toBe(
			processManager
		);
		expect(ipcMocks.registerDirectorNotesHandlers.mock.calls[0][0].getAgentDetector()).toBe(
			agentDetector
		);
		expect(ipcMocks.registerAgentsHandlers.mock.calls[0][0].getAgentDetector()).toBe(agentDetector);
		expect(ipcMocks.registerProcessHandlers.mock.calls[0][0].getProcessManager()).toBe(
			processManager
		);
		expect(ipcMocks.registerProcessHandlers.mock.calls[0][0].getAgentDetector()).toBe(
			agentDetector
		);
		expect(ipcMocks.registerProcessHandlers.mock.calls[0][0].getMainWindow()).toBe(
			lifecycleMocks.mockWindow
		);
		expect(ipcMocks.registerPersistenceHandlers.mock.calls[0][0].getWebServer()).toEqual({
			id: 'web-server-instance',
		});
		expect(ipcMocks.registerSystemHandlers.mock.calls[0][0].getMainWindow()).toBe(
			lifecycleMocks.mockWindow
		);
		expect(ipcMocks.registerSystemHandlers.mock.calls[0][0].getWebServer()).toEqual({
			id: 'web-server-instance',
		});
		expect(ipcMocks.registerClaudeHandlers.mock.calls[0][0].getMainWindow()).toBe(
			lifecycleMocks.mockWindow
		);
		expect(ipcMocks.registerAgentSessionsHandlers.mock.calls[0][0].getMainWindow()).toBe(
			lifecycleMocks.mockWindow
		);
		expect(ipcMocks.registerGroupChatHandlers.mock.calls[0][0].getMainWindow()).toBe(
			lifecycleMocks.mockWindow
		);
		expect(ipcMocks.registerGroupChatHandlers.mock.calls[0][0].getProcessManager()).toBe(
			processManager
		);
		expect(ipcMocks.registerGroupChatHandlers.mock.calls[0][0].getAgentDetector()).toBe(
			agentDetector
		);
		expect(ipcMocks.registerDebugHandlers.mock.calls[0][0].getMainWindow()).toBe(
			lifecycleMocks.mockWindow
		);
		expect(ipcMocks.registerDebugHandlers.mock.calls[0][0].getAgentDetector()).toBe(agentDetector);
		expect(ipcMocks.registerDebugHandlers.mock.calls[0][0].getProcessManager()).toBe(
			processManager
		);
		expect(ipcMocks.registerDebugHandlers.mock.calls[0][0].getWebServer()).toEqual({
			id: 'web-server-instance',
		});
		expect(ipcMocks.registerContextHandlers.mock.calls[0][0].getMainWindow()).toBe(
			lifecycleMocks.mockWindow
		);
		expect(ipcMocks.registerContextHandlers.mock.calls[0][0].getProcessManager()).toBe(
			processManager
		);
		expect(ipcMocks.registerContextHandlers.mock.calls[0][0].getAgentDetector()).toBe(
			agentDetector
		);
		expect(ipcMocks.registerStatsHandlers.mock.calls[0][0].getMainWindow()).toBe(
			lifecycleMocks.mockWindow
		);
		expect(ipcMocks.registerDocumentGraphHandlers.mock.calls[0][0].getMainWindow()).toBe(
			lifecycleMocks.mockWindow
		);
		expect(ipcMocks.setupLoggerEventForwarding.mock.calls[0][0]()).toBe(lifecycleMocks.mockWindow);
		expect(ipcMocks.registerSymphonyHandlers.mock.calls[0][0].getMainWindow()).toBe(
			lifecycleMocks.mockWindow
		);
		expect(ipcMocks.registerTabNamingHandlers.mock.calls[0][0].getProcessManager()).toBe(
			processManager
		);
		expect(ipcMocks.registerTabNamingHandlers.mock.calls[0][0].getAgentDetector()).toBe(
			agentDetector
		);

		const processListenerOptions = processListenerMocks.setupProcessListeners.mock.calls[0][1];
		expect(processListenerOptions.getProcessManager()).toBe(processManager);
		expect(processListenerOptions.getWebServer()).toEqual({ id: 'web-server-instance' });
		expect(processListenerOptions.getAgentDetector()).toBe(agentDetector);

		const quitDeps = lifecycleMocks.createQuitHandler.mock.calls[0][0];
		expect(quitDeps.getMainWindow()).toBe(lifecycleMocks.mockWindow);
		expect(quitDeps.getProcessManager()).toBe(processManager);
		expect(quitDeps.getWebServer()).toEqual({ id: 'web-server-instance' });
		quitDeps.stopCliWatcher();
		quitDeps.stopSettingsWatcher();
		expect(lifecycleMocks.cliWatcher.stop).toHaveBeenCalledTimes(1);
		expect(lifecycleMocks.settingsWatcher.stop).toHaveBeenCalledTimes(1);

		for (const register of [
			ipcMocks.registerWebHandlers,
			ipcMocks.registerGitHandlers,
			ipcMocks.registerAutorunHandlers,
			ipcMocks.registerPlaybooksHandlers,
			ipcMocks.registerHistoryHandlers,
			ipcMocks.registerDirectorNotesHandlers,
			ipcMocks.registerAgentsHandlers,
			ipcMocks.registerProcessHandlers,
			ipcMocks.registerPersistenceHandlers,
			ipcMocks.registerSystemHandlers,
			ipcMocks.registerClaudeHandlers,
			ipcMocks.registerAgentSessionsHandlers,
			ipcMocks.registerGroupChatHandlers,
			ipcMocks.registerDebugHandlers,
			ipcMocks.registerSpeckitHandlers,
			ipcMocks.registerOpenSpecHandlers,
			ipcMocks.registerContextHandlers,
			ipcMocks.registerMarketplaceHandlers,
			ipcMocks.registerStatsHandlers,
			ipcMocks.registerDocumentGraphHandlers,
			ipcMocks.registerSshRemoteHandlers,
			ipcMocks.registerFilesystemHandlers,
			ipcMocks.registerAgentErrorHandlers,
			ipcMocks.registerNotificationsHandlers,
			ipcMocks.registerAttachmentsHandlers,
			ipcMocks.registerLeaderboardHandlers,
			ipcMocks.registerSymphonyHandlers,
			ipcMocks.registerTabNamingHandlers,
			ipcMocks.registerWakatimeHandlers,
		]) {
			expect(register).toHaveBeenCalled();
		}

		const sessions = routerMocks.setGetSessionsCallback.mock.calls[0][0]();
		expect(sessions[0]).toEqual(
			expect.objectContaining({
				cwd: '/repo',
				sshRemoteName: 'Remote Workstation',
				worktreeBasePath: '/worktrees',
			})
		);
		expect(routerMocks.setGetCustomEnvVarsCallback.mock.calls[0][0]('claude-code')).toEqual({
			API_MODE: 'test',
		});
		expect(routerMocks.setGetAgentConfigCallback.mock.calls[0][0]('claude-code')).toEqual(
			expect.objectContaining({ customPath: '/opt/claude' })
		);
		expect(routerMocks.setGetModeratorSettingsCallback.mock.calls[0][0]()).toEqual({
			conductorProfile: 'Direct conductor',
		});
		expect(routerMocks.setGetCustomShellPathCallback.mock.calls[0][0]()).toBe('/bin/zsh');

		const wakatimeChangeHandler = settingsStore.onDidChange.mock.calls.find(
			([key]) => key === 'wakatimeEnabled'
		)?.[1] as ((newValue: boolean) => void) | undefined;
		expect(wakatimeChangeHandler).toBeDefined();
		wakatimeChangeHandler?.(false);
		expect(wakatimeManager.ensureCliInstalled).not.toHaveBeenCalled();
		wakatimeChangeHandler?.(true);
		expect(wakatimeManager.ensureCliInstalled).toHaveBeenCalledTimes(1);

		historyMocks.startWatchingCallback?.('agent-1');
		expect(lifecycleMocks.mockWindow.webContents.send).toHaveBeenCalledWith(
			'history:externalChange',
			'agent-1'
		);

		electronMocks.powerEvents.get('resume')?.();
		expect(lifecycleMocks.mockWindow.webContents.send).toHaveBeenCalledWith('app:systemResume');

		lifecycleMocks.mockWindow.on.mock.calls.find(([event]) => event === 'closed')?.[1]();
		expect(quitDeps.getMainWindow()).toBeNull();

		electronMocks.appEvents.get('activate')?.();
		expect(lifecycleMocks.windowManager.createWindow).toHaveBeenCalledTimes(2);

		electronMocks.appEvents.get('window-all-closed')?.();
		expect(electronMocks.app.quit).toHaveBeenCalledTimes(1);

		await waitFor(() => expect(sentryMocks.init).toHaveBeenCalledTimes(1));
		expect(sentryMocks.setTag).toHaveBeenCalledWith('installationId', expect.any(String));
		expect(sentryMocks.setTag).toHaveBeenCalledWith('channel', 'rc');
		const sentryBeforeSend = sentryMocks.init.mock.calls[0][0].beforeSend;
		const sentryEvent = {
			user: { email: 'person@example.com', id: 'user-1', ip_address: '127.0.0.1' },
		};
		expect(sentryBeforeSend(sentryEvent)).toBe(sentryEvent);
		expect(sentryEvent.user).toEqual({ id: 'user-1' });
		expect(
			sentryBeforeSend({
				exception: {
					values: [
						{
							value: 'EBUSY: resource busy or locked, lstat C:\\pagefile.sys',
						},
					],
				},
			})
		).toBeNull();
		await waitFor(() =>
			expect(sentryMocks.startMemoryMonitoring).toHaveBeenCalledWith(1024, 60000)
		);
	});

	it('handles alternate startup settings and unavailable renderer windows', async () => {
		process.env.VITE_PORT = '6123';
		electronMocks.app.getVersion.mockReturnValue('1.2.3');
		storeMocks.getEarlySettings.mockReturnValueOnce({
			autoHideMenuBar: false,
			crashReportingEnabled: true,
			disableGpuAcceleration: false,
			useNativeTitleBar: true,
		});
		mockSettingsValues({
			conductorProfile: '',
			installationId: 'existing-installation',
			moderatorStandingInstructions: '',
		});
		agentConfigsStore.get.mockImplementation(() => ({
			'claude-code': {
				customEnvVars: { API_MODE: 'test' },
			},
		}));

		await importMainAndWaitForStartup();

		expect(electronMocks.app.disableHardwareAcceleration).not.toHaveBeenCalled();
		expect(settingsStore.set).not.toHaveBeenCalledWith('installationId', expect.any(String));
		expect(lifecycleMocks.createWindowManager.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				autoHideMenuBar: false,
				devServerUrl: 'http://localhost:6123',
				useNativeTitleBar: true,
			})
		);
		const agentDetector = serviceMocks.AgentDetector.mock.results[0].value;
		expect(agentDetector.setCustomPaths).not.toHaveBeenCalled();

		await waitFor(() => expect(sentryMocks.init).toHaveBeenCalledTimes(1));
		expect(sentryMocks.setTag).toHaveBeenCalledWith('installationId', 'existing-installation');
		expect(sentryMocks.setTag).toHaveBeenCalledWith('channel', 'stable');
		const sentryBeforeSend = sentryMocks.init.mock.calls[0][0].beforeSend;
		const eventWithoutUser = { message: 'no user attached' };
		expect(sentryBeforeSend(eventWithoutUser)).toBe(eventWithoutUser);

		expect(routerMocks.setGetAgentConfigCallback.mock.calls[0][0]('missing-agent')).toEqual({});
		expect(routerMocks.setGetModeratorSettingsCallback.mock.calls[0][0]()).toEqual({
			conductorProfile: '',
		});

		const os = await import('node:os');
		sessionsStore.get.mockReturnValueOnce([
			{
				id: 'agent-local',
				name: 'Local Agent',
				toolType: 'codex',
			},
		]);
		const sessions = routerMocks.setGetSessionsCallback.mock.calls[0][0]();
		expect(sessions[0]).toEqual(
			expect.objectContaining({
				cwd: os.homedir(),
				id: 'agent-local',
				sshRemoteName: undefined,
			})
		);

		lifecycleMocks.mockWindow.webContents.send.mockClear();
		safeSendMocks.isWebContentsAvailable.mockReturnValueOnce(false);
		historyMocks.startWatchingCallback?.('agent-local');
		expect(lifecycleMocks.mockWindow.webContents.send).not.toHaveBeenCalledWith(
			'history:externalChange',
			'agent-local'
		);

		safeSendMocks.isWebContentsAvailable.mockReturnValueOnce(false);
		electronMocks.powerEvents.get('resume')?.();
		expect(lifecycleMocks.mockWindow.webContents.send).not.toHaveBeenCalledWith('app:systemResume');

		lifecycleMocks.windowManager.createWindow.mockClear();
		electronMocks.BrowserWindow.getAllWindows.mockReturnValueOnce([{}]);
		electronMocks.appEvents.get('activate')?.();
		expect(lifecycleMocks.windowManager.createWindow).not.toHaveBeenCalled();

		electronMocks.app.quit.mockClear();
		platformMocks.isMacOS.mockReturnValueOnce(true);
		electronMocks.appEvents.get('window-all-closed')?.();
		expect(electronMocks.app.quit).not.toHaveBeenCalled();
	});

	it('uses the demo data directory when demo mode is enabled', async () => {
		constantsMock.DEMO_MODE = true;

		await importMainAndWaitForStartup();

		expect(consoleLog).toHaveBeenCalledWith('[DEMO MODE] Using data directory: /demo-data');
		expect(electronMocks.app.setPath).toHaveBeenCalledWith('userData', '/demo-data');
	});

	it('uses an explicit data directory before other data-dir modes', async () => {
		process.env.MAESTRO_DATA_DIR = '/tmp/maestro-explicit-data';

		await importMainAndWaitForStartup();

		expect(electronMocks.app.setPath).toHaveBeenCalledWith(
			'userData',
			'/tmp/maestro-explicit-data'
		);
		expect(consoleLog).toHaveBeenCalledWith(
			'[DATA DIR] Using explicit data directory: /tmp/maestro-explicit-data'
		);
	});

	it('uses an isolated data directory during development unless production data is requested', async () => {
		process.env.NODE_ENV = 'development';

		await importMainAndWaitForStartup();

		expect(electronMocks.app.setPath).toHaveBeenCalledWith(
			'userData',
			'/Users/test/Library/Application Support/maestro-dev'
		);
		expect(consoleLog).toHaveBeenCalledWith(
			'[DEV MODE] Using data directory: /Users/test/Library/Application Support/maestro-dev'
		);
		expect(sentryMocks.init).not.toHaveBeenCalled();
	});

	it('keeps the production data directory in development when explicitly requested', async () => {
		process.env.NODE_ENV = 'development';
		process.env.USE_PROD_DATA = '1';

		await importMainAndWaitForStartup();

		expect(electronMocks.app.setPath).not.toHaveBeenCalled();
		expect(consoleLog).toHaveBeenCalledWith(
			'[DEV MODE] Using production data directory: /Users/test/Library/Application Support/Maestro'
		);
		expect(sentryMocks.init).not.toHaveBeenCalled();
	});

	it('auto-installs WakaTime when startup settings enable it', async () => {
		mockSettingsValues({ wakatimeEnabled: true });

		await importMainAndWaitForStartup();

		const wakatimeManager = serviceMocks.WakaTimeManager.mock.results[0].value;
		expect(wakatimeManager.ensureCliInstalled).toHaveBeenCalledTimes(1);
	});

	it('logs recoverable Sentry, history, and stats startup failures', async () => {
		sentryMocks.init.mockImplementationOnce(() => {
			throw new Error('sentry failed');
		});
		historyMocks.historyManager.initialize.mockRejectedValueOnce(new Error('history failed'));
		statsMocks.initializeStatsDB.mockImplementationOnce(() => {
			throw new Error('stats failed');
		});

		await importMainAndWaitForStartup();

		await waitFor(() =>
			expect(loggerMock.warn).toHaveBeenCalledWith(
				'Failed to initialize Sentry',
				'Startup',
				expect.objectContaining({ error: 'Error: sentry failed' })
			)
		);
		expect(loggerMock.error).toHaveBeenCalledWith(
			'Failed to initialize history manager: Error: history failed',
			'Startup'
		);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			'Continuing without history - history features will be unavailable',
			'Startup'
		);
		expect(loggerMock.error).toHaveBeenCalledWith(
			'Failed to initialize stats database: Error: stats failed',
			'Startup'
		);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			'Continuing without stats - usage tracking will be unavailable',
			'Startup'
		);
	});

	it('installs the macOS-safe application menu on macOS', async () => {
		platformMocks.isMacOS.mockReturnValue(true);

		await importMainAndWaitForStartup();

		expect(electronMocks.Menu.buildFromTemplate).toHaveBeenCalledWith([
			{
				role: 'appMenu',
				submenu: [
					{ role: 'about' },
					{ type: 'separator' },
					{ role: 'services' },
					{ type: 'separator' },
					{ role: 'hide' },
					{ role: 'hideOthers' },
					{ role: 'unhide' },
					{ type: 'separator' },
					expect.objectContaining({
						accelerator: 'Cmd+Q',
						label: 'Quit Maestro',
					}),
				],
			},
			{
				label: 'Edit',
				submenu: [
					{ role: 'cut' },
					{ role: 'copy' },
					{ role: 'paste' },
					{ role: 'pasteAndMatchStyle' },
					{ role: 'delete' },
					{ type: 'separator' },
					{ role: 'selectAll' },
				],
			},
			{
				label: 'Window',
				submenu: [{ role: 'minimize' }, { role: 'zoom' }],
			},
		]);
		expect(electronMocks.Menu.setApplicationMenu).toHaveBeenCalledWith({
			template: expect.any(Array),
		});
	});
});
