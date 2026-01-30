import { app, BrowserWindow } from 'electron';
import path from 'path';
import crypto from 'crypto';
// Sentry is imported dynamically below to avoid module-load-time access to electron.app
// which causes "Cannot read properties of undefined (reading 'getAppPath')" errors
import { ProcessManager } from './process-manager';
import { WebServer } from './web-server';
import { AgentDetector } from './agent-detector';
import { logger } from './utils/logger';
import { tunnelManager } from './tunnel-manager';
import { powerManager } from './power-manager';
import { getHistoryManager } from './history-manager';
import {
	initializeStores,
	getEarlySettings,
	getSettingsStore,
	getSessionsStore,
	getGroupsStore,
	getAgentConfigsStore,
	getWindowStateStore,
	getClaudeSessionOriginsStore,
	getAgentSessionOriginsStore,
	getSshRemoteById,
} from './stores';
import {
	registerGitHandlers,
	registerAutorunHandlers,
	registerPlaybooksHandlers,
	registerHistoryHandlers,
	registerAgentsHandlers,
	registerProcessHandlers,
	registerPersistenceHandlers,
	registerSystemHandlers,
	registerClaudeHandlers,
	registerAgentSessionsHandlers,
	registerGroupChatHandlers,
	registerDebugHandlers,
	registerSpeckitHandlers,
	registerOpenSpecHandlers,
	registerContextHandlers,
	registerMarketplaceHandlers,
	registerStatsHandlers,
	registerDocumentGraphHandlers,
	registerSshRemoteHandlers,
	registerFilesystemHandlers,
	registerAttachmentsHandlers,
	registerWebHandlers,
	registerLeaderboardHandlers,
	registerNotificationsHandlers,
	registerSymphonyHandlers,
	setupLoggerEventForwarding,
	cleanupAllGroomingSessions,
	getActiveGroomingSessionCount,
} from './ipc/handlers';
import { initializeStatsDB, closeStatsDB, getStatsDB } from './stats-db';
import { groupChatEmitters } from './ipc/handlers/groupChat';
import {
	routeModeratorResponse,
	routeAgentResponse,
	setGetSessionsCallback,
	setGetCustomEnvVarsCallback,
	setGetAgentConfigCallback,
	markParticipantResponded,
	spawnModeratorSynthesis,
	getGroupChatReadOnlyState,
	respawnParticipantWithRecovery,
} from './group-chat/group-chat-router';
import { updateParticipant, loadGroupChat, updateGroupChat } from './group-chat/group-chat-storage';
import { needsSessionRecovery, initiateSessionRecovery } from './group-chat/session-recovery';
import { initializeSessionStorages } from './storage';
import { initializeOutputParsers } from './parsers';
import { calculateContextTokens } from './parsers/usage-aggregator';
import {
	DEMO_MODE,
	DEMO_DATA_PATH,
	REGEX_MODERATOR_SESSION,
	REGEX_MODERATOR_SESSION_TIMESTAMP,
	REGEX_AI_SUFFIX,
	REGEX_AI_TAB_ID,
	REGEX_BATCH_SESSION,
	REGEX_SYNOPSIS_SESSION,
	debugLog,
} from './constants';
// initAutoUpdater is now used by window-manager.ts (Phase 4 refactoring)
import { checkWslEnvironment } from './utils/wslDetector';
// Extracted modules (Phase 1 refactoring)
import { parseParticipantSessionId } from './group-chat/session-parser';
import { extractTextFromStreamJson } from './group-chat/output-parser';
import {
	appendToGroupChatBuffer,
	getGroupChatBufferedOutput,
	clearGroupChatBuffer,
} from './group-chat/output-buffer';
// Phase 2 refactoring - dependency injection
import { createSafeSend, isWebContentsAvailable } from './utils/safe-send';
import { createWebServerFactory } from './web-server/web-server-factory';
// Phase 4 refactoring - app lifecycle
import {
	setupGlobalErrorHandlers,
	createCliWatcher,
	createWindowManager,
	createQuitHandler,
} from './app-lifecycle';
// Phase 3 refactoring - process listeners
import { setupProcessListeners as setupProcessListenersModule } from './process-listeners';

// ============================================================================
// Data Directory Configuration (MUST happen before any Store initialization)
// ============================================================================
// Store type definitions are imported from ./stores/types.ts
const isDevelopment = process.env.NODE_ENV === 'development';

// Capture the production data path before any modification
// Used for stores that should be shared between dev and prod (e.g., agent configs)
const productionDataPath = app.getPath('userData');

// Demo mode: use a separate data directory for fresh demos
if (DEMO_MODE) {
	app.setPath('userData', DEMO_DATA_PATH);
	console.log(`[DEMO MODE] Using data directory: ${DEMO_DATA_PATH}`);
}

// Development mode: use a separate data directory to allow running alongside production
// This prevents database lock conflicts (e.g., Service Worker storage)
// Set USE_PROD_DATA=1 to use the production data directory instead (requires closing production app)
if (isDevelopment && !DEMO_MODE && !process.env.USE_PROD_DATA) {
	const devDataPath = path.join(app.getPath('userData'), '..', 'maestro-dev');
	app.setPath('userData', devDataPath);
	console.log(`[DEV MODE] Using data directory: ${devDataPath}`);
} else if (isDevelopment && process.env.USE_PROD_DATA) {
	console.log(`[DEV MODE] Using production data directory: ${app.getPath('userData')}`);
}

// ============================================================================
// Store Initialization (after userData path is configured)
// ============================================================================
// All stores are initialized via initializeStores() from ./stores module

const { syncPath, bootstrapStore } = initializeStores({ productionDataPath });

// Get early settings before Sentry init (for crash reporting and GPU acceleration)
const { crashReportingEnabled, disableGpuAcceleration } = getEarlySettings(syncPath);

// Disable GPU hardware acceleration if user has opted out or in WSL environment
// Must be called before app.ready event
// In WSL, GPU acceleration is auto-disabled due to EGL/GPU process crash issues
if (disableGpuAcceleration) {
	app.disableHardwareAcceleration();
	console.log('[STARTUP] GPU hardware acceleration disabled');
}

// Generate installation ID on first run (one-time generation)
// This creates a unique identifier per Maestro installation for telemetry differentiation
const store = getSettingsStore();
let installationId = store.get('installationId');
if (!installationId) {
	installationId = crypto.randomUUID();
	store.set('installationId', installationId);
	logger.info('Generated new installation ID', 'Startup', { installationId });
}

// Initialize Sentry for crash reporting (dynamic import to avoid module-load-time errors)
// Only enable in production - skip during development to avoid noise from hot-reload artifacts
// The dynamic import is necessary because @sentry/electron accesses electron.app at module load time
// which fails if the module is imported before app.whenReady() in some Node/Electron version combinations
if (crashReportingEnabled && !isDevelopment) {
	import('@sentry/electron/main')
		.then(({ init, setTag, IPCMode }) => {
			init({
				dsn: 'https://2303c5f787f910863d83ed5d27ce8ed2@o4510554134740992.ingest.us.sentry.io/4510554135789568',
				// Set release version for better debugging
				release: app.getVersion(),
				// Use Classic IPC mode to avoid "sentry-ipc:// URL scheme not supported" errors
				// See: https://github.com/getsentry/sentry-electron/issues/661
				ipcMode: IPCMode.Classic,
				// Only send errors, not performance data
				tracesSampleRate: 0,
				// Filter out sensitive data
				beforeSend(event) {
					// Remove any potential sensitive data from the event
					if (event.user) {
						delete event.user.ip_address;
						delete event.user.email;
					}
					return event;
				},
			});
			// Add installation ID to Sentry for error correlation across installations
			setTag('installationId', installationId);
		})
		.catch((err) => {
			logger.warn('Failed to initialize Sentry', 'Startup', { error: String(err) });
		});
}

// Create local references to stores for use throughout this module
// These are convenience variables - the actual stores are managed by ./stores module
const sessionsStore = getSessionsStore();
const groupsStore = getGroupsStore();
const agentConfigsStore = getAgentConfigsStore();
const windowStateStore = getWindowStateStore();
const claudeSessionOriginsStore = getClaudeSessionOriginsStore();
const agentSessionOriginsStore = getAgentSessionOriginsStore();

// Note: History storage is now handled by HistoryManager which uses per-session files
// in the history/ directory. The legacy maestro-history.json file is migrated automatically.
// See src/main/history-manager.ts for details.

let mainWindow: BrowserWindow | null = null;
let processManager: ProcessManager | null = null;
let webServer: WebServer | null = null;
let agentDetector: AgentDetector | null = null;

// Create safeSend with dependency injection (Phase 2 refactoring)
const safeSend = createSafeSend(() => mainWindow);

// Create CLI activity watcher with dependency injection (Phase 4 refactoring)
const cliWatcher = createCliWatcher({
	getMainWindow: () => mainWindow,
	getUserDataPath: () => app.getPath('userData'),
});

const devServerPort = process.env.VITE_PORT ? parseInt(process.env.VITE_PORT, 10) : 5173;
const devServerUrl = `http://localhost:${devServerPort}`;

// Create window manager with dependency injection (Phase 4 refactoring)
const windowManager = createWindowManager({
	windowStateStore,
	isDevelopment,
	preloadPath: path.join(__dirname, 'preload.js'),
	rendererPath: path.join(__dirname, '../renderer/index.html'),
	devServerUrl: devServerUrl,
});

// Create web server factory with dependency injection (Phase 2 refactoring)
const createWebServer = createWebServerFactory({
	settingsStore: store,
	sessionsStore,
	groupsStore,
	getMainWindow: () => mainWindow,
	getProcessManager: () => processManager,
});

// createWindow is now handled by windowManager (Phase 4 refactoring)
// The window manager creates and configures the BrowserWindow with:
// - Window state persistence (position, size, maximized/fullscreen)
// - DevTools installation in development
// - Auto-updater initialization in production
function createWindow() {
	mainWindow = windowManager.createWindow();
	// Handle closed event to clear the reference
	mainWindow.on('closed', () => {
		mainWindow = null;
	});
}

// Set up global error handlers for uncaught exceptions (Phase 4 refactoring)
setupGlobalErrorHandlers();

app.whenReady().then(async () => {
	// Load logger settings first
	const logLevel = store.get('logLevel', 'info');
	logger.setLogLevel(logLevel);
	const maxLogBuffer = store.get('maxLogBuffer', 1000);
	logger.setMaxLogBuffer(maxLogBuffer);

	logger.info('Maestro application starting', 'Startup', {
		version: app.getVersion(),
		platform: process.platform,
		logLevel,
	});

	// Check for WSL + Windows mount issues early
	checkWslEnvironment(process.cwd());

	// Initialize core services
	logger.info('Initializing core services', 'Startup');
	processManager = new ProcessManager();
	// Note: webServer is created on-demand when user enables web interface (see setupWebServerCallbacks)
	agentDetector = new AgentDetector();

	// Load custom agent paths from settings
	const allAgentConfigs = agentConfigsStore.get('configs', {});
	const customPaths: Record<string, string> = {};
	for (const [agentId, config] of Object.entries(allAgentConfigs)) {
		if (config && typeof config === 'object' && 'customPath' in config && config.customPath) {
			customPaths[agentId] = config.customPath as string;
		}
	}
	if (Object.keys(customPaths).length > 0) {
		agentDetector.setCustomPaths(customPaths);
		logger.info(`Loaded custom agent paths: ${JSON.stringify(customPaths)}`, 'Startup');
	}

	logger.info('Core services initialized', 'Startup');

	// Initialize history manager (handles migration from legacy format if needed)
	logger.info('Initializing history manager', 'Startup');
	const historyManager = getHistoryManager();
	try {
		await historyManager.initialize();
		logger.info('History manager initialized', 'Startup');
		// Start watching history directory for external changes (from CLI, etc.)
		historyManager.startWatching((sessionId) => {
			logger.debug(
				`History file changed for session ${sessionId}, notifying renderer`,
				'HistoryWatcher'
			);
			if (isWebContentsAvailable(mainWindow)) {
				mainWindow.webContents.send('history:externalChange', sessionId);
			}
		});
	} catch (error) {
		// Migration failed - log error but continue with app startup
		// History will be unavailable but the app will still function
		logger.error(`Failed to initialize history manager: ${error}`, 'Startup');
		logger.warn('Continuing without history - history features will be unavailable', 'Startup');
	}

	// Initialize stats database for usage tracking
	logger.info('Initializing stats database', 'Startup');
	try {
		initializeStatsDB();
		logger.info('Stats database initialized', 'Startup');
	} catch (error) {
		// Stats initialization failed - log error but continue with app startup
		// Stats will be unavailable but the app will still function
		logger.error(`Failed to initialize stats database: ${error}`, 'Startup');
		logger.warn('Continuing without stats - usage tracking will be unavailable', 'Startup');
	}

	// Set up IPC handlers
	logger.debug('Setting up IPC handlers', 'Startup');
	setupIpcHandlers();

	// Set up process event listeners
	logger.debug('Setting up process event listeners', 'Startup');
	setupProcessListeners();

	// Create main window
	logger.info('Creating main window', 'Startup');
	createWindow();

	// Note: History file watching is handled by HistoryManager.startWatching() above
	// which uses the new per-session file format in the history/ directory

	// Start CLI activity watcher (Phase 4 refactoring)
	cliWatcher.start();

	// Note: Web server is not auto-started - it starts when user enables web interface
	// via live:startServer IPC call from the renderer

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

// Create and setup quit handler with dependency injection (Phase 4 refactoring)
const quitHandler = createQuitHandler({
	getMainWindow: () => mainWindow,
	getProcessManager: () => processManager,
	getWebServer: () => webServer,
	getHistoryManager,
	tunnelManager,
	getActiveGroomingSessionCount,
	cleanupAllGroomingSessions,
	closeStatsDB,
	stopCliWatcher: () => cliWatcher.stop(),
});
quitHandler.setup();

// startCliActivityWatcher is now handled by cliWatcher (Phase 4 refactoring)

function setupIpcHandlers() {
	// Settings, sessions, and groups persistence - extracted to src/main/ipc/handlers/persistence.ts

	// Web/Live handlers - extracted to src/main/ipc/handlers/web.ts
	registerWebHandlers({
		getWebServer: () => webServer,
		setWebServer: (server) => {
			webServer = server;
		},
		createWebServer,
	});

	// Git operations - extracted to src/main/ipc/handlers/git.ts
	registerGitHandlers({
		settingsStore: store,
	});

	// Auto Run operations - extracted to src/main/ipc/handlers/autorun.ts
	registerAutorunHandlers({
		mainWindow,
		getMainWindow: () => mainWindow,
		app,
		settingsStore: store,
	});

	// Playbook operations - extracted to src/main/ipc/handlers/playbooks.ts
	registerPlaybooksHandlers({
		mainWindow,
		getMainWindow: () => mainWindow,
		app,
	});

	// History operations - extracted to src/main/ipc/handlers/history.ts
	// Uses HistoryManager singleton for per-session storage
	registerHistoryHandlers();

	// Agent management operations - extracted to src/main/ipc/handlers/agents.ts
	registerAgentsHandlers({
		getAgentDetector: () => agentDetector,
		agentConfigsStore,
		settingsStore: store,
	});

	// Process management operations - extracted to src/main/ipc/handlers/process.ts
	registerProcessHandlers({
		getProcessManager: () => processManager,
		getAgentDetector: () => agentDetector,
		agentConfigsStore,
		settingsStore: store,
		getMainWindow: () => mainWindow,
		sessionsStore,
	});

	// Persistence operations - extracted to src/main/ipc/handlers/persistence.ts
	registerPersistenceHandlers({
		settingsStore: store,
		sessionsStore,
		groupsStore,
		getWebServer: () => webServer,
	});

	// System operations - extracted to src/main/ipc/handlers/system.ts
	registerSystemHandlers({
		getMainWindow: () => mainWindow,
		app,
		settingsStore: store,
		tunnelManager,
		getWebServer: () => webServer,
		bootstrapStore, // For iCloud/sync settings
	});

	// Claude Code sessions - extracted to src/main/ipc/handlers/claude.ts
	registerClaudeHandlers({
		claudeSessionOriginsStore,
		getMainWindow: () => mainWindow,
	});

	// Initialize output parsers for all agents (Codex, OpenCode, Claude Code)
	// This must be called before any agent output is processed
	initializeOutputParsers();

	// Initialize session storages and register generic agent sessions handlers
	// This provides the new window.maestro.agentSessions.* API
	// Pass the shared claudeSessionOriginsStore so session names/stars are consistent
	initializeSessionStorages({ claudeSessionOriginsStore });
	registerAgentSessionsHandlers({ getMainWindow: () => mainWindow, agentSessionOriginsStore });

	// Helper to get agent config values (custom args/env vars, model, etc.)
	const getAgentConfigForAgent = (agentId: string): Record<string, any> => {
		const allConfigs = agentConfigsStore.get('configs', {});
		return allConfigs[agentId] || {};
	};

	// Helper to get custom env vars for an agent
	const getCustomEnvVarsForAgent = (agentId: string): Record<string, string> | undefined => {
		return getAgentConfigForAgent(agentId).customEnvVars as Record<string, string> | undefined;
	};

	// Register Group Chat handlers
	registerGroupChatHandlers({
		getMainWindow: () => mainWindow,
		getProcessManager: () => processManager,
		getAgentDetector: () => agentDetector,
		getCustomEnvVars: getCustomEnvVarsForAgent,
		getAgentConfig: getAgentConfigForAgent,
	});

	// Register Debug Package handlers
	registerDebugHandlers({
		getMainWindow: () => mainWindow,
		getAgentDetector: () => agentDetector,
		getProcessManager: () => processManager,
		getWebServer: () => webServer,
		settingsStore: store,
		sessionsStore,
		groupsStore,
		bootstrapStore,
	});

	// Register Spec Kit handlers (no dependencies needed)
	registerSpeckitHandlers();

	// Register OpenSpec handlers (no dependencies needed)
	registerOpenSpecHandlers();

	// Register Context Merge handlers for session context transfer and grooming
	registerContextHandlers({
		getMainWindow: () => mainWindow,
		getProcessManager: () => processManager,
		getAgentDetector: () => agentDetector,
	});

	// Register Marketplace handlers for fetching and importing playbooks
	registerMarketplaceHandlers({
		app,
		settingsStore: store,
	});

	// Register Stats handlers for usage tracking
	registerStatsHandlers({
		getMainWindow: () => mainWindow,
		settingsStore: store,
	});

	// Register Document Graph handlers for file watching
	registerDocumentGraphHandlers({
		getMainWindow: () => mainWindow,
		app,
	});

	// Register SSH Remote handlers for managing SSH configurations
	registerSshRemoteHandlers({
		settingsStore: store,
	});

	// Set up callback for group chat router to lookup sessions for auto-add @mentions
	setGetSessionsCallback(() => {
		const sessions = sessionsStore.get('sessions', []);
		return sessions.map((s: any) => {
			// Resolve SSH remote name if session has SSH config
			let sshRemoteName: string | undefined;
			if (s.sessionSshRemoteConfig?.enabled && s.sessionSshRemoteConfig.remoteId) {
				const sshConfig = getSshRemoteById(s.sessionSshRemoteConfig.remoteId);
				sshRemoteName = sshConfig?.name;
			}
			return {
				id: s.id,
				name: s.name,
				toolType: s.toolType,
				cwd: s.cwd || s.fullPath || process.env.HOME || '/tmp',
				customArgs: s.customArgs,
				customEnvVars: s.customEnvVars,
				customModel: s.customModel,
				sshRemoteName,
			};
		});
	});

	// Set up callback for group chat router to lookup custom env vars for agents
	setGetCustomEnvVarsCallback(getCustomEnvVarsForAgent);
	setGetAgentConfigCallback(getAgentConfigForAgent);

	// Setup logger event forwarding to renderer
	setupLoggerEventForwarding(() => mainWindow);

	// Register filesystem handlers (extracted to handlers/filesystem.ts)
	registerFilesystemHandlers();

	// System operations (dialog, fonts, shells, tunnel, devtools, updates, logger)
	// extracted to src/main/ipc/handlers/system.ts

	// Claude Code sessions - extracted to src/main/ipc/handlers/claude.ts

	// Agent Error Handling API - extracted to src/main/ipc/handlers/agent-error.ts

	// Register notification handlers (extracted to handlers/notifications.ts)
	registerNotificationsHandlers();

	// Register attachments handlers (extracted to handlers/attachments.ts)
	registerAttachmentsHandlers({ app });

	// Register leaderboard handlers (extracted to handlers/leaderboard.ts)
	registerLeaderboardHandlers({
		app,
		settingsStore: store,
	});

	// Register Symphony handlers for token donation / open source contributions
	registerSymphonyHandlers({
		app,
		getMainWindow: () => mainWindow,
	});
}

// Handle process output streaming (set up after initialization)
// Phase 3 refactoring - delegates to extracted process-listeners module
function setupProcessListeners() {
	if (processManager) {
		setupProcessListenersModule(processManager, {
			getProcessManager: () => processManager,
			getWebServer: () => webServer,
			getAgentDetector: () => agentDetector,
			safeSend,
			powerManager,
			groupChatEmitters,
			groupChatRouter: {
				routeModeratorResponse,
				routeAgentResponse,
				markParticipantResponded,
				spawnModeratorSynthesis,
				getGroupChatReadOnlyState,
				respawnParticipantWithRecovery,
			},
			groupChatStorage: {
				loadGroupChat,
				updateGroupChat,
				updateParticipant,
			},
			sessionRecovery: {
				needsSessionRecovery,
				initiateSessionRecovery,
			},
			outputBuffer: {
				appendToGroupChatBuffer,
				getGroupChatBufferedOutput,
				clearGroupChatBuffer,
			},
			outputParser: {
				extractTextFromStreamJson,
				parseParticipantSessionId,
			},
			usageAggregator: {
				calculateContextTokens,
			},
			getStatsDB,
			debugLog,
			patterns: {
				REGEX_MODERATOR_SESSION,
				REGEX_MODERATOR_SESSION_TIMESTAMP,
				REGEX_AI_SUFFIX,
				REGEX_AI_TAB_ID,
				REGEX_BATCH_SESSION,
				REGEX_SYNOPSIS_SESSION,
			},
			logger,
		});
	}
}
