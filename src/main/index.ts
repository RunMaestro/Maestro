import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import fsSync from 'fs';
import crypto from 'crypto';
// Sentry is imported dynamically below to avoid module-load-time access to electron.app
// which causes "Cannot read properties of undefined (reading 'getAppPath')" errors
import { ProcessManager } from './process-manager';
import { WebServer } from './web-server';
import { AgentDetector } from './agent-detector';
import { logger } from './utils/logger';
import { tunnelManager } from './tunnel-manager';
import { powerManager } from './power-manager';
import { getThemeById } from './themes';
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
import { initializeOutputParsers, getOutputParser } from './parsers';
import { calculateContextTokens } from './parsers/usage-aggregator';
import { DEMO_MODE, DEMO_DATA_PATH } from './constants';
import { initAutoUpdater } from './auto-updater';
import { checkWslEnvironment } from './utils/wslDetector';

// ============================================================================
// Pre-compiled Regex Patterns (Performance Optimization)
// ============================================================================
// These patterns are used in hot paths (process data handlers) that fire hundreds
// of times per second. Pre-compiling them avoids repeated regex compilation overhead.

// Group chat session ID patterns
const REGEX_MODERATOR_SESSION = /^group-chat-(.+)-moderator-/;
const REGEX_MODERATOR_SESSION_TIMESTAMP = /^group-chat-(.+)-moderator-\d+$/;
const REGEX_PARTICIPANT_UUID =
	/^group-chat-(.+)-participant-(.+)-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const REGEX_PARTICIPANT_TIMESTAMP = /^group-chat-(.+)-participant-(.+)-(\d{13,})$/;
const REGEX_PARTICIPANT_FALLBACK = /^group-chat-(.+)-participant-([^-]+)-/;

// Web broadcast session ID patterns
const REGEX_AI_SUFFIX = /-ai-[^-]+$/;
const REGEX_AI_TAB_ID = /-ai-([^-]+)$/;

// ============================================================================
// Debug Logging (Performance Optimization)
// ============================================================================
// Debug logs in hot paths (data handlers) are disabled in production to avoid
// performance overhead from string interpolation and console I/O on every data chunk.
const DEBUG_GROUP_CHAT =
	process.env.NODE_ENV === 'development' || process.env.DEBUG_GROUP_CHAT === '1';

/** Log debug message only in development mode. Avoids overhead in production. */

function debugLog(prefix: string, message: string, ...args: any[]): void {
	if (DEBUG_GROUP_CHAT) {
		console.log(`[${prefix}] ${message}`, ...args);
	}
}

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

// Disable GPU hardware acceleration if user has opted out
// Must be called before app.ready event
if (disableGpuAcceleration) {
	app.disableHardwareAcceleration();
	console.log('[STARTUP] GPU hardware acceleration disabled by user preference');
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
let cliActivityWatcher: fsSync.FSWatcher | null = null;

/**
 * Safely send IPC message to renderer.
 * Handles cases where the renderer has been disposed (e.g., GPU crash, window closing).
 * This prevents "Render frame was disposed before WebFrameMain could be accessed" errors.
 */
function safeSend(channel: string, ...args: unknown[]): void {
	try {
		if (
			mainWindow &&
			!mainWindow.isDestroyed() &&
			mainWindow.webContents &&
			!mainWindow.webContents.isDestroyed()
		) {
			mainWindow.webContents.send(channel, ...args);
		}
	} catch (error) {
		// Silently ignore - renderer is not available
		// This can happen during GPU crashes, window closing, or app shutdown
		logger.debug(`Failed to send IPC message to renderer: ${channel}`, 'IPC', {
			error: String(error),
		});
	}
}

/**
 * Create and configure the web server with all necessary callbacks.
 * Called when user enables the web interface.
 */
function createWebServer(): WebServer {
	// Use custom port if enabled, otherwise 0 for random port assignment
	const useCustomPort = store.get('webInterfaceUseCustomPort', false);
	const customPort = store.get('webInterfaceCustomPort', 8080);
	const port = useCustomPort ? customPort : 0;
	const server = new WebServer(port); // Custom or random port with auto-generated security token

	// Set up callback for web server to fetch sessions list
	server.setGetSessionsCallback(() => {
		const sessions = sessionsStore.get('sessions', []);
		const groups = groupsStore.get('groups', []);
		return sessions.map((s: any) => {
			// Find the group for this session
			const group = s.groupId ? groups.find((g: any) => g.id === s.groupId) : null;

			// Extract last AI response for mobile preview (first 3 lines, max 500 chars)
			// Use active tab's logs as the source of truth
			let lastResponse = null;
			const activeTab = s.aiTabs?.find((t: any) => t.id === s.activeTabId) || s.aiTabs?.[0];
			const tabLogs = activeTab?.logs || [];
			if (tabLogs.length > 0) {
				// Find the last stdout/stderr entry from the AI (not user messages)
				// Note: 'thinking' logs are already excluded since they have a distinct source type
				const lastAiLog = [...tabLogs]
					.reverse()
					.find((log: any) => log.source === 'stdout' || log.source === 'stderr');
				if (lastAiLog && lastAiLog.text) {
					const fullText = lastAiLog.text;
					// Get first 3 lines or 500 chars, whichever is shorter
					const lines = fullText.split('\n').slice(0, 3);
					let previewText = lines.join('\n');
					if (previewText.length > 500) {
						previewText = previewText.slice(0, 497) + '...';
					} else if (fullText.length > previewText.length) {
						previewText = previewText + '...';
					}
					lastResponse = {
						text: previewText,
						timestamp: lastAiLog.timestamp,
						source: lastAiLog.source,
						fullLength: fullText.length,
					};
				}
			}

			// Map aiTabs to web-safe format (strip logs to reduce payload)
			const aiTabs =
				s.aiTabs?.map((tab: any) => ({
					id: tab.id,
					agentSessionId: tab.agentSessionId || null,
					name: tab.name || null,
					starred: tab.starred || false,
					inputValue: tab.inputValue || '',
					usageStats: tab.usageStats || null,
					createdAt: tab.createdAt,
					state: tab.state || 'idle',
					thinkingStartTime: tab.thinkingStartTime || null,
				})) || [];

			return {
				id: s.id,
				name: s.name,
				toolType: s.toolType,
				state: s.state,
				inputMode: s.inputMode,
				cwd: s.cwd,
				groupId: s.groupId || null,
				groupName: group?.name || null,
				groupEmoji: group?.emoji || null,
				usageStats: s.usageStats || null,
				lastResponse,
				agentSessionId: s.agentSessionId || null,
				thinkingStartTime: s.thinkingStartTime || null,
				aiTabs,
				activeTabId: s.activeTabId || (aiTabs.length > 0 ? aiTabs[0].id : undefined),
				bookmarked: s.bookmarked || false,
				// Worktree subagent support
				parentSessionId: s.parentSessionId || null,
				worktreeBranch: s.worktreeBranch || null,
			};
		});
	});

	// Set up callback for web server to fetch single session details
	// Optional tabId param allows fetching logs for a specific tab (avoids race conditions)
	server.setGetSessionDetailCallback((sessionId: string, tabId?: string) => {
		const sessions = sessionsStore.get('sessions', []);
		const session = sessions.find((s: any) => s.id === sessionId);
		if (!session) return null;

		// Get the requested tab's logs (or active tab if no tabId provided)
		// Tabs are the source of truth for AI conversation history
		// Filter out thinking and tool logs - these should never be shown on the web interface
		let aiLogs: any[] = [];
		const targetTabId = tabId || session.activeTabId;
		if (session.aiTabs && session.aiTabs.length > 0) {
			const targetTab = session.aiTabs.find((t: any) => t.id === targetTabId) || session.aiTabs[0];
			const rawLogs = targetTab?.logs || [];
			// Web interface should never show thinking/tool logs regardless of desktop settings
			aiLogs = rawLogs.filter((log: any) => log.source !== 'thinking' && log.source !== 'tool');
		}

		return {
			id: session.id,
			name: session.name,
			toolType: session.toolType,
			state: session.state,
			inputMode: session.inputMode,
			cwd: session.cwd,
			aiLogs,
			shellLogs: session.shellLogs || [],
			usageStats: session.usageStats,
			agentSessionId: session.agentSessionId,
			isGitRepo: session.isGitRepo,
			activeTabId: targetTabId,
		};
	});

	// Set up callback for web server to fetch current theme
	server.setGetThemeCallback(() => {
		const themeId = store.get('activeThemeId', 'dracula');
		return getThemeById(themeId);
	});

	// Set up callback for web server to fetch custom AI commands
	server.setGetCustomCommandsCallback(() => {
		const customCommands = store.get('customAICommands', []) as Array<{
			id: string;
			command: string;
			description: string;
			prompt: string;
		}>;
		return customCommands;
	});

	// Set up callback for web server to fetch history entries
	// Uses HistoryManager for per-session storage
	server.setGetHistoryCallback((projectPath?: string, sessionId?: string) => {
		const historyManager = getHistoryManager();

		if (sessionId) {
			// Get entries for specific session
			const entries = historyManager.getEntries(sessionId);
			// Sort by timestamp descending
			entries.sort((a, b) => b.timestamp - a.timestamp);
			return entries;
		}

		if (projectPath) {
			// Get all entries for sessions in this project
			return historyManager.getEntriesByProjectPath(projectPath);
		}

		// Return all entries (for global view)
		return historyManager.getAllEntries();
	});

	// Set up callback for web server to write commands to sessions
	// Note: Process IDs have -ai or -terminal suffix based on session's inputMode
	server.setWriteToSessionCallback((sessionId: string, data: string) => {
		if (!processManager) {
			logger.warn('processManager is null for writeToSession', 'WebServer');
			return false;
		}

		// Get the session's current inputMode to determine which process to write to
		const sessions = sessionsStore.get('sessions', []);
		const session = sessions.find((s: any) => s.id === sessionId);
		if (!session) {
			logger.warn(`Session ${sessionId} not found for writeToSession`, 'WebServer');
			return false;
		}

		// Append -ai or -terminal suffix based on inputMode
		const targetSessionId =
			session.inputMode === 'ai' ? `${sessionId}-ai` : `${sessionId}-terminal`;
		logger.debug(`Writing to ${targetSessionId} (inputMode=${session.inputMode})`, 'WebServer');

		const result = processManager.write(targetSessionId, data);
		logger.debug(`Write result: ${result}`, 'WebServer');
		return result;
	});

	// Set up callback for web server to execute commands through the desktop
	// This forwards AI commands to the renderer, ensuring single source of truth
	// The renderer handles all spawn logic, state management, and broadcasts
	server.setExecuteCommandCallback(
		async (sessionId: string, command: string, inputMode?: 'ai' | 'terminal') => {
			if (!mainWindow) {
				logger.warn('mainWindow is null for executeCommand', 'WebServer');
				return false;
			}

			// Look up the session to get Claude session ID for logging
			const sessions = sessionsStore.get('sessions', []);
			const session = sessions.find((s: any) => s.id === sessionId);
			const agentSessionId = session?.agentSessionId || 'none';

			// Forward to renderer - it will handle spawn, state, and everything else
			// This ensures web commands go through exact same code path as desktop commands
			// Pass inputMode so renderer uses the web's intended mode (avoids sync issues)
			logger.info(
				`[Web → Renderer] Forwarding command | Maestro: ${sessionId} | Claude: ${agentSessionId} | Mode: ${inputMode || 'auto'} | Command: ${command.substring(0, 100)}`,
				'WebServer'
			);
			mainWindow.webContents.send('remote:executeCommand', sessionId, command, inputMode);
			return true;
		}
	);

	// Set up callback for web server to interrupt sessions through the desktop
	// This forwards to the renderer which handles state updates and broadcasts
	server.setInterruptSessionCallback(async (sessionId: string) => {
		if (!mainWindow) {
			logger.warn('mainWindow is null for interrupt', 'WebServer');
			return false;
		}

		// Forward to renderer - it will handle interrupt, state update, and broadcasts
		// This ensures web interrupts go through exact same code path as desktop interrupts
		logger.debug(`Forwarding interrupt to renderer for session ${sessionId}`, 'WebServer');
		mainWindow.webContents.send('remote:interrupt', sessionId);
		return true;
	});

	// Set up callback for web server to switch session mode through the desktop
	// This forwards to the renderer which handles state updates and broadcasts
	server.setSwitchModeCallback(async (sessionId: string, mode: 'ai' | 'terminal') => {
		logger.info(
			`[Web→Desktop] Mode switch callback invoked: session=${sessionId}, mode=${mode}`,
			'WebServer'
		);
		if (!mainWindow) {
			logger.warn('mainWindow is null for switchMode', 'WebServer');
			return false;
		}

		// Forward to renderer - it will handle mode switch and broadcasts
		// This ensures web mode switches go through exact same code path as desktop
		logger.info(`[Web→Desktop] Sending IPC remote:switchMode to renderer`, 'WebServer');
		mainWindow.webContents.send('remote:switchMode', sessionId, mode);
		return true;
	});

	// Set up callback for web server to select/switch to a session in the desktop
	// This forwards to the renderer which handles state updates and broadcasts
	// If tabId is provided, also switches to that tab within the session
	server.setSelectSessionCallback(async (sessionId: string, tabId?: string) => {
		logger.info(
			`[Web→Desktop] Session select callback invoked: session=${sessionId}, tab=${tabId || 'none'}`,
			'WebServer'
		);
		if (!mainWindow) {
			logger.warn('mainWindow is null for selectSession', 'WebServer');
			return false;
		}

		// Forward to renderer - it will handle session selection and broadcasts
		logger.info(`[Web→Desktop] Sending IPC remote:selectSession to renderer`, 'WebServer');
		mainWindow.webContents.send('remote:selectSession', sessionId, tabId);
		return true;
	});

	// Tab operation callbacks
	server.setSelectTabCallback(async (sessionId: string, tabId: string) => {
		logger.info(
			`[Web→Desktop] Tab select callback invoked: session=${sessionId}, tab=${tabId}`,
			'WebServer'
		);
		if (!mainWindow) {
			logger.warn('mainWindow is null for selectTab', 'WebServer');
			return false;
		}

		mainWindow.webContents.send('remote:selectTab', sessionId, tabId);
		return true;
	});

	server.setNewTabCallback(async (sessionId: string) => {
		logger.info(`[Web→Desktop] New tab callback invoked: session=${sessionId}`, 'WebServer');
		if (!mainWindow) {
			logger.warn('mainWindow is null for newTab', 'WebServer');
			return null;
		}

		// Use invoke for synchronous response with tab ID
		return new Promise((resolve) => {
			const responseChannel = `remote:newTab:response:${Date.now()}`;
			ipcMain.once(responseChannel, (_event, result) => {
				resolve(result);
			});
			mainWindow!.webContents.send('remote:newTab', sessionId, responseChannel);
			// Timeout after 5 seconds
			setTimeout(() => resolve(null), 5000);
		});
	});

	server.setCloseTabCallback(async (sessionId: string, tabId: string) => {
		logger.info(
			`[Web→Desktop] Close tab callback invoked: session=${sessionId}, tab=${tabId}`,
			'WebServer'
		);
		if (!mainWindow) {
			logger.warn('mainWindow is null for closeTab', 'WebServer');
			return false;
		}

		mainWindow.webContents.send('remote:closeTab', sessionId, tabId);
		return true;
	});

	server.setRenameTabCallback(async (sessionId: string, tabId: string, newName: string) => {
		logger.info(
			`[Web→Desktop] Rename tab callback invoked: session=${sessionId}, tab=${tabId}, newName=${newName}`,
			'WebServer'
		);
		if (!mainWindow) {
			logger.warn('mainWindow is null for renameTab', 'WebServer');
			return false;
		}

		mainWindow.webContents.send('remote:renameTab', sessionId, tabId, newName);
		return true;
	});

	return server;
}

function createWindow() {
	// Restore saved window state
	const savedState = windowStateStore.store;

	mainWindow = new BrowserWindow({
		x: savedState.x,
		y: savedState.y,
		width: savedState.width,
		height: savedState.height,
		minWidth: 1000,
		minHeight: 600,
		backgroundColor: '#0b0b0d',
		titleBarStyle: 'hiddenInset',
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	// Restore maximized/fullscreen state after window is created
	if (savedState.isFullScreen) {
		mainWindow.setFullScreen(true);
	} else if (savedState.isMaximized) {
		mainWindow.maximize();
	}

	logger.info('Browser window created', 'Window', {
		size: `${savedState.width}x${savedState.height}`,
		maximized: savedState.isMaximized,
		fullScreen: savedState.isFullScreen,
		mode: process.env.NODE_ENV || 'production',
	});

	// Save window state before closing
	const saveWindowState = () => {
		if (!mainWindow) return;

		const isMaximized = mainWindow.isMaximized();
		const isFullScreen = mainWindow.isFullScreen();
		const bounds = mainWindow.getBounds();

		// Only save bounds if not maximized/fullscreen (to restore proper size later)
		if (!isMaximized && !isFullScreen) {
			windowStateStore.set('x', bounds.x);
			windowStateStore.set('y', bounds.y);
			windowStateStore.set('width', bounds.width);
			windowStateStore.set('height', bounds.height);
		}
		windowStateStore.set('isMaximized', isMaximized);
		windowStateStore.set('isFullScreen', isFullScreen);
	};

	mainWindow.on('close', saveWindowState);

	// Load the app
	if (process.env.NODE_ENV === 'development') {
		// Install React DevTools extension in development mode
		import('electron-devtools-installer')
			.then(({ default: installExtension, REACT_DEVELOPER_TOOLS }) => {
				installExtension(REACT_DEVELOPER_TOOLS)
					.then(() => logger.info('React DevTools extension installed', 'Window'))
					.catch((err: Error) =>
						logger.warn(`Failed to install React DevTools: ${err.message}`, 'Window')
					);
			})
			.catch((err: Error) =>
				logger.warn(`Failed to load electron-devtools-installer: ${err.message}`, 'Window')
			);

		const vitePort = process.env.VITE_PORT || '5173';
		mainWindow.loadURL(`http://localhost:${vitePort}`);
		// DevTools can be opened via Command-K menu instead of automatically on startup
		logger.info(`Loading development server on port ${vitePort}`, 'Window');
	} else {
		mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
		logger.info('Loading production build', 'Window');
		// Open DevTools in production if DEBUG env var is set
		if (process.env.DEBUG === 'true') {
			mainWindow.webContents.openDevTools();
		}
	}

	mainWindow.on('closed', () => {
		logger.info('Browser window closed', 'Window');
		mainWindow = null;
	});

	// Initialize auto-updater (only in production)
	if (process.env.NODE_ENV !== 'development') {
		initAutoUpdater(mainWindow);
		logger.info('Auto-updater initialized', 'Window');
	} else {
		// Register stub handlers in development mode so users get a helpful error
		ipcMain.handle('updates:download', async () => {
			return {
				success: false,
				error: 'Auto-update is disabled in development mode. Please check update first.',
			};
		});
		ipcMain.handle('updates:install', async () => {
			logger.warn('Auto-update install called in development mode', 'AutoUpdater');
		});
		ipcMain.handle('updates:getStatus', async () => {
			return { status: 'idle' as const };
		});
		ipcMain.handle('updates:checkAutoUpdater', async () => {
			return { success: false, error: 'Auto-update is disabled in development mode' };
		});
		logger.info('Auto-updater disabled in development mode (stub handlers registered)', 'Window');
	}
}

// Set up global error handlers for uncaught exceptions
process.on('uncaughtException', (error: Error) => {
	logger.error(`Uncaught Exception: ${error.message}`, 'UncaughtException', {
		stack: error.stack,
		name: error.name,
	});
	// Don't exit the process - let it continue running
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
	logger.error(
		`Unhandled Promise Rejection: ${reason?.message || String(reason)}`,
		'UnhandledRejection',
		{
			reason: reason,
			stack: reason?.stack,
			promise: String(promise),
		}
	);
});

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
			if (mainWindow && !mainWindow.isDestroyed()) {
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

	// Start CLI activity watcher (polls every 2 seconds for CLI playbook runs)
	startCliActivityWatcher();

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

// Track if quit has been confirmed by user (or no busy agents)
let quitConfirmed = false;

// Handle quit confirmation from renderer
ipcMain.on('app:quitConfirmed', () => {
	logger.info('Quit confirmed by renderer', 'Window');
	quitConfirmed = true;
	app.quit();
});

// Handle quit cancellation (user declined)
ipcMain.on('app:quitCancelled', () => {
	logger.info('Quit cancelled by renderer', 'Window');
	// Nothing to do - app stays running
});

// IMPORTANT: This handler must be synchronous for event.preventDefault() to work!
// Async handlers return a Promise immediately, which breaks preventDefault in Electron.
app.on('before-quit', (event) => {
	// If quit not yet confirmed, intercept and ask renderer
	if (!quitConfirmed) {
		event.preventDefault();

		// Ask renderer to check for busy agents
		if (mainWindow && !mainWindow.isDestroyed()) {
			logger.info('Requesting quit confirmation from renderer', 'Window');
			mainWindow.webContents.send('app:requestQuitConfirmation');
		} else {
			// No window, just quit
			quitConfirmed = true;
			app.quit();
		}
		return;
	}

	// Quit confirmed - proceed with cleanup (async operations are fire-and-forget)
	logger.info('Application shutting down', 'Shutdown');

	// Stop history manager watcher
	getHistoryManager().stopWatching();

	// Stop CLI activity watcher
	if (cliActivityWatcher) {
		cliActivityWatcher.close();
		cliActivityWatcher = null;
	}

	// Clean up active grooming sessions (context merge/transfer operations)
	const groomingSessionCount = getActiveGroomingSessionCount();
	if (groomingSessionCount > 0 && processManager) {
		logger.info(`Cleaning up ${groomingSessionCount} active grooming session(s)`, 'Shutdown');
		// Fire and forget - don't await
		cleanupAllGroomingSessions(processManager).catch((err) => {
			logger.error(`Error cleaning up grooming sessions: ${err}`, 'Shutdown');
		});
	}

	// Clean up all running processes
	logger.info('Killing all running processes', 'Shutdown');
	processManager?.killAll();

	// Stop tunnel and web server (fire and forget)
	logger.info('Stopping tunnel', 'Shutdown');
	tunnelManager.stop().catch((err) => {
		logger.error(`Error stopping tunnel: ${err}`, 'Shutdown');
	});

	logger.info('Stopping web server', 'Shutdown');
	webServer?.stop().catch((err) => {
		logger.error(`Error stopping web server: ${err}`, 'Shutdown');
	});

	// Close stats database
	logger.info('Closing stats database', 'Shutdown');
	closeStatsDB();

	logger.info('Shutdown complete', 'Shutdown');
});

/**
 * Start CLI activity file watcher
 * Uses fs.watch() for event-driven detection when CLI is running playbooks
 */
function startCliActivityWatcher() {
	const cliActivityPath = path.join(app.getPath('userData'), 'cli-activity.json');
	const cliActivityDir = path.dirname(cliActivityPath);

	// Ensure directory exists for watching
	if (!fsSync.existsSync(cliActivityDir)) {
		fsSync.mkdirSync(cliActivityDir, { recursive: true });
	}

	// Watch the directory for file changes (handles file creation/deletion)
	// Using directory watch because fs.watch on non-existent file throws
	try {
		cliActivityWatcher = fsSync.watch(cliActivityDir, (_eventType, filename) => {
			if (filename === 'cli-activity.json') {
				logger.debug('CLI activity file changed, notifying renderer', 'CliActivityWatcher');
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainWindow.webContents.send('cli:activityChange');
				}
			}
		});

		cliActivityWatcher.on('error', (error) => {
			logger.error(`CLI activity watcher error: ${error.message}`, 'CliActivityWatcher');
		});

		logger.info('CLI activity watcher started', 'Startup');
	} catch (error) {
		logger.error(`Failed to start CLI activity watcher: ${error}`, 'CliActivityWatcher');
	}
}

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

	// ==========================================================================
	// Agent Error Handling API
	// ==========================================================================

	// Clear an error state for a session (called after recovery action)
	ipcMain.handle('agent:clearError', async (_event, sessionId: string) => {
		logger.debug('Clearing agent error for session', 'AgentError', { sessionId });
		// Note: The actual error state is managed in the renderer.
		// This handler is used to log the clear action and potentially
		// perform any main process cleanup needed.
		return { success: true };
	});

	// Retry the last operation after an error (optionally with modified parameters)
	ipcMain.handle(
		'agent:retryAfterError',
		async (
			_event,
			sessionId: string,
			options?: {
				prompt?: string;
				newSession?: boolean;
			}
		) => {
			logger.info('Retrying after agent error', 'AgentError', {
				sessionId,
				hasPrompt: !!options?.prompt,
				newSession: options?.newSession || false,
			});
			// Note: The actual retry logic is handled in the renderer, which will:
			// 1. Clear the error state
			// 2. Optionally start a new session
			// 3. Re-send the last command or the provided prompt
			// This handler exists for logging and potential future main process coordination.
			return { success: true };
		}
	);

	// Register notification handlers (extracted to handlers/notifications.ts)
	registerNotificationsHandlers();

	// Register attachments handlers (extracted to handlers/attachments.ts)
	registerAttachmentsHandlers({ app });

	// Register leaderboard handlers (extracted to handlers/leaderboard.ts)
	registerLeaderboardHandlers({
		app,
		settingsStore: store,
	});
}

// Buffer for group chat output (keyed by sessionId)
// We buffer output and only route it on process exit to avoid duplicate messages from streaming chunks
// Uses array of chunks for O(1) append performance instead of O(n) string concatenation
// Tracks totalLength incrementally to avoid O(n) reduce on every append
const groupChatOutputBuffers = new Map<string, { chunks: string[]; totalLength: number }>();

/** Append data to group chat output buffer. O(1) operation. */
function appendToGroupChatBuffer(sessionId: string, data: string): number {
	let buffer = groupChatOutputBuffers.get(sessionId);
	if (!buffer) {
		buffer = { chunks: [], totalLength: 0 };
		groupChatOutputBuffers.set(sessionId, buffer);
	}
	buffer.chunks.push(data);
	buffer.totalLength += data.length;
	return buffer.totalLength;
}

/** Get buffered output as a single string. Joins chunks on read. */
function getGroupChatBufferedOutput(sessionId: string): string | undefined {
	const buffer = groupChatOutputBuffers.get(sessionId);
	if (!buffer || buffer.chunks.length === 0) return undefined;
	return buffer.chunks.join('');
}

/**
 * Extract text content from agent JSON output format.
 * Uses the registered output parser for the given agent type.
 * Different agents have different output formats:
 * - Claude: { type: 'result', result: '...' } and { type: 'assistant', message: { content: ... } }
 * - OpenCode: { type: 'text', part: { text: '...' } } and { type: 'step_finish', part: { reason: 'stop' } }
 *
 * @param rawOutput - The raw JSONL output from the agent
 * @param agentType - The agent type (e.g., 'claude-code', 'opencode')
 * @returns Extracted text content
 */
function extractTextFromAgentOutput(rawOutput: string, agentType: string): string {
	const parser = getOutputParser(agentType);

	// If no parser found, try a generic extraction
	if (!parser) {
		logger.warn(
			`No parser found for agent type '${agentType}', using generic extraction`,
			'[GroupChat]'
		);
		return extractTextGeneric(rawOutput);
	}

	const lines = rawOutput.split('\n');

	// Check if this looks like JSONL output (first non-empty line starts with '{')
	// If not JSONL, return the raw output as-is (it's already parsed text from process-manager)
	const firstNonEmptyLine = lines.find((line) => line.trim());
	if (firstNonEmptyLine && !firstNonEmptyLine.trim().startsWith('{')) {
		logger.debug(
			`[GroupChat] Input is not JSONL, returning as plain text (len=${rawOutput.length})`,
			'[GroupChat]'
		);
		return rawOutput;
	}

	const textParts: string[] = [];
	let resultText: string | null = null;
	let _resultMessageCount = 0;
	let _textMessageCount = 0;

	for (const line of lines) {
		if (!line.trim()) continue;

		const event = parser.parseJsonLine(line);
		if (!event) continue;

		// Extract text based on event type
		if (event.type === 'result' && event.text) {
			// Result message is the authoritative final response - save it
			resultText = event.text;
			_resultMessageCount++;
		}

		if (event.type === 'text' && event.text) {
			textParts.push(event.text);
			_textMessageCount++;
		}
	}

	// Prefer result message if available (it contains the complete formatted response)
	if (resultText) {
		return resultText;
	}

	// Fallback: if no result message, concatenate streaming text parts with newlines
	// to preserve paragraph structure from partial streaming events
	return textParts.join('\n');
}

/**
 * Extract text content from stream-json output (JSONL).
 * Uses the agent-specific parser when the agent type is known.
 */
function extractTextFromStreamJson(rawOutput: string, agentType?: string): string {
	if (agentType) {
		return extractTextFromAgentOutput(rawOutput, agentType);
	}

	return extractTextGeneric(rawOutput);
}

/**
 * Generic text extraction fallback for unknown agent types.
 * Tries common patterns for JSON output.
 */
function extractTextGeneric(rawOutput: string): string {
	const lines = rawOutput.split('\n');

	// Check if this looks like JSONL output (first non-empty line starts with '{')
	// If not JSONL, return the raw output as-is (it's already parsed text)
	const firstNonEmptyLine = lines.find((line) => line.trim());
	if (firstNonEmptyLine && !firstNonEmptyLine.trim().startsWith('{')) {
		return rawOutput;
	}

	const textParts: string[] = [];

	for (const line of lines) {
		if (!line.trim()) continue;

		try {
			const msg = JSON.parse(line);

			// Try common patterns
			if (msg.result) return msg.result;
			if (msg.text) textParts.push(msg.text);
			if (msg.part?.text) textParts.push(msg.part.text);
			if (msg.message?.content) {
				const content = msg.message.content;
				if (typeof content === 'string') {
					textParts.push(content);
				}
			}
		} catch {
			// Not valid JSON - include raw text if it looks like content
			if (!line.startsWith('{') && !line.includes('session_id') && !line.includes('sessionID')) {
				textParts.push(line);
			}
		}
	}

	// Join with newlines to preserve paragraph structure
	return textParts.join('\n');
}

/**
 * Parses a group chat participant session ID to extract groupChatId and participantName.
 * Handles hyphenated participant names by matching against UUID or timestamp suffixes.
 *
 * Session ID format: group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
 * Examples:
 * - group-chat-abc123-participant-Claude-1702934567890
 * - group-chat-abc123-participant-OpenCode-Ollama-550e8400-e29b-41d4-a716-446655440000
 *
 * @returns null if not a participant session ID, otherwise { groupChatId, participantName }
 */
function parseParticipantSessionId(
	sessionId: string
): { groupChatId: string; participantName: string } | null {
	// First check if this is a participant session ID at all
	if (!sessionId.includes('-participant-')) {
		return null;
	}

	// Try matching with UUID suffix first (36 chars: 8-4-4-4-12 format)
	// UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
	const uuidMatch = sessionId.match(REGEX_PARTICIPANT_UUID);
	if (uuidMatch) {
		return { groupChatId: uuidMatch[1], participantName: uuidMatch[2] };
	}

	// Try matching with timestamp suffix (13 digits)
	const timestampMatch = sessionId.match(REGEX_PARTICIPANT_TIMESTAMP);
	if (timestampMatch) {
		return { groupChatId: timestampMatch[1], participantName: timestampMatch[2] };
	}

	// Fallback: try the old pattern for backwards compatibility (non-hyphenated names)
	const fallbackMatch = sessionId.match(REGEX_PARTICIPANT_FALLBACK);
	if (fallbackMatch) {
		return { groupChatId: fallbackMatch[1], participantName: fallbackMatch[2] };
	}

	return null;
}

// Handle process output streaming (set up after initialization)
function setupProcessListeners() {
	if (processManager) {
		processManager.on('data', (sessionId: string, data: string) => {
			// Handle group chat moderator output - buffer it
			// Session ID format: group-chat-{groupChatId}-moderator-{uuid} or group-chat-{groupChatId}-moderator-synthesis-{uuid}
			const moderatorMatch = sessionId.match(REGEX_MODERATOR_SESSION);
			if (moderatorMatch) {
				const groupChatId = moderatorMatch[1];
				debugLog('GroupChat:Debug', `MODERATOR DATA received for chat ${groupChatId}`);
				debugLog('GroupChat:Debug', `Session ID: ${sessionId}`);
				debugLog('GroupChat:Debug', `Data length: ${data.length}`);
				// Buffer the output - will be routed on process exit
				const totalLength = appendToGroupChatBuffer(sessionId, data);
				debugLog('GroupChat:Debug', `Buffered total: ${totalLength} chars`);
				return; // Don't send to regular process:data handler
			}

			// Handle group chat participant output - buffer it
			// Session ID format: group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
			const participantInfo = parseParticipantSessionId(sessionId);
			if (participantInfo) {
				debugLog('GroupChat:Debug', 'PARTICIPANT DATA received');
				debugLog(
					'GroupChat:Debug',
					`Chat: ${participantInfo.groupChatId}, Participant: ${participantInfo.participantName}`
				);
				debugLog('GroupChat:Debug', `Session ID: ${sessionId}`);
				debugLog('GroupChat:Debug', `Data length: ${data.length}`);
				// Buffer the output - will be routed on process exit
				const totalLength = appendToGroupChatBuffer(sessionId, data);
				debugLog('GroupChat:Debug', `Buffered total: ${totalLength} chars`);
				return; // Don't send to regular process:data handler
			}

			safeSend('process:data', sessionId, data);

			// Broadcast to web clients - extract base session ID (remove -ai or -terminal suffix)
			// IMPORTANT: Skip PTY terminal output (-terminal suffix) as it contains raw ANSI codes.
			// Web interface terminal commands use runCommand() which emits with plain session IDs.
			if (webServer) {
				// Don't broadcast raw PTY terminal output to web clients
				if (sessionId.endsWith('-terminal')) {
					debugLog('WebBroadcast', `SKIPPING PTY terminal output for web: session=${sessionId}`);
					return;
				}

				// Don't broadcast background batch/synopsis output to web clients
				// These are internal Auto Run operations that should only appear in history, not as chat messages
				if (sessionId.includes('-batch-') || sessionId.includes('-synopsis-')) {
					debugLog('WebBroadcast', `SKIPPING batch/synopsis output for web: session=${sessionId}`);
					return;
				}

				// Extract base session ID and tab ID from format: {id}-ai-{tabId}
				const baseSessionId = sessionId.replace(REGEX_AI_SUFFIX, '');
				const isAiOutput = sessionId.includes('-ai-');

				// Extract tab ID from session ID format: {id}-ai-{tabId}
				const tabIdMatch = sessionId.match(REGEX_AI_TAB_ID);
				const tabId = tabIdMatch ? tabIdMatch[1] : undefined;

				const msgId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
				debugLog(
					'WebBroadcast',
					`Broadcasting session_output: msgId=${msgId}, session=${baseSessionId}, tabId=${tabId || 'none'}, source=${isAiOutput ? 'ai' : 'terminal'}, dataLen=${data.length}`
				);
				webServer.broadcastToSessionClients(baseSessionId, {
					type: 'session_output',
					sessionId: baseSessionId,
					tabId,
					data,
					source: isAiOutput ? 'ai' : 'terminal',
					timestamp: Date.now(),
					msgId,
				});
			}
		});

		processManager.on('exit', (sessionId: string, code: number) => {
			// Remove power block reason for this session
			// This allows system sleep when no AI sessions are active
			powerManager.removeBlockReason(`session:${sessionId}`);

			// Handle group chat moderator exit - route buffered output and set state back to idle
			// Session ID format: group-chat-{groupChatId}-moderator-{uuid}
			// This handles BOTH initial moderator responses AND synthesis responses.
			// The routeModeratorResponse function will check for @mentions:
			// - If @mentions present: route to agents (continue conversation)
			// - If no @mentions: final response to user (conversation complete for this turn)
			const moderatorMatch = sessionId.match(REGEX_MODERATOR_SESSION);
			if (moderatorMatch) {
				const groupChatId = moderatorMatch[1];
				debugLog('GroupChat:Debug', ` ========== MODERATOR PROCESS EXIT ==========`);
				debugLog('GroupChat:Debug', ` Group Chat ID: ${groupChatId}`);
				debugLog('GroupChat:Debug', ` Session ID: ${sessionId}`);
				debugLog('GroupChat:Debug', ` Exit code: ${code}`);
				logger.debug(`[GroupChat] Moderator exit: groupChatId=${groupChatId}`, 'ProcessListener', {
					sessionId,
				});
				// Route the buffered output now that process is complete
				const bufferedOutput = getGroupChatBufferedOutput(sessionId);
				debugLog('GroupChat:Debug', ` Buffered output length: ${bufferedOutput?.length ?? 0}`);
				if (bufferedOutput) {
					debugLog(
						'GroupChat:Debug',
						` Raw buffered output preview: "${bufferedOutput.substring(0, 300)}${bufferedOutput.length > 300 ? '...' : ''}"`
					);
					logger.debug(
						`[GroupChat] Moderator has buffered output (${bufferedOutput.length} chars)`,
						'ProcessListener',
						{ groupChatId }
					);
					void (async () => {
						try {
							const chat = await loadGroupChat(groupChatId);
							debugLog('GroupChat:Debug', ` Chat loaded for parsing: ${chat?.name || 'null'}`);
							const agentType = chat?.moderatorAgentId;
							debugLog('GroupChat:Debug', ` Agent type for parsing: ${agentType}`);
							const parsedText = extractTextFromStreamJson(bufferedOutput, agentType);
							debugLog('GroupChat:Debug', ` Parsed text length: ${parsedText.length}`);
							debugLog(
								'GroupChat:Debug',
								` Parsed text preview: "${parsedText.substring(0, 300)}${parsedText.length > 300 ? '...' : ''}"`
							);
							if (parsedText.trim()) {
								debugLog('GroupChat:Debug', ` Routing moderator response...`);
								logger.info(
									`[GroupChat] Routing moderator response (${parsedText.length} chars)`,
									'ProcessListener',
									{ groupChatId }
								);
								const readOnly = getGroupChatReadOnlyState(groupChatId);
								debugLog('GroupChat:Debug', ` Read-only state: ${readOnly}`);
								routeModeratorResponse(
									groupChatId,
									parsedText,
									processManager ?? undefined,
									agentDetector ?? undefined,
									readOnly
								).catch((err) => {
									debugLog('GroupChat:Debug', ` ERROR routing moderator response:`, err);
									logger.error(
										'[GroupChat] Failed to route moderator response',
										'ProcessListener',
										{ error: String(err) }
									);
								});
							} else {
								debugLog('GroupChat:Debug', ` WARNING: Parsed text is empty!`);
								logger.warn(
									'[GroupChat] Moderator output parsed to empty string',
									'ProcessListener',
									{ groupChatId, bufferedLength: bufferedOutput.length }
								);
							}
						} catch (err) {
							debugLog('GroupChat:Debug', ` ERROR loading chat:`, err);
							logger.error(
								'[GroupChat] Failed to load chat for moderator output parsing',
								'ProcessListener',
								{ error: String(err) }
							);
							const parsedText = extractTextFromStreamJson(bufferedOutput);
							if (parsedText.trim()) {
								const readOnly = getGroupChatReadOnlyState(groupChatId);
								routeModeratorResponse(
									groupChatId,
									parsedText,
									processManager ?? undefined,
									agentDetector ?? undefined,
									readOnly
								).catch((routeErr) => {
									debugLog(
										'GroupChat:Debug',
										` ERROR routing moderator response (fallback):`,
										routeErr
									);
									logger.error(
										'[GroupChat] Failed to route moderator response',
										'ProcessListener',
										{ error: String(routeErr) }
									);
								});
							}
						}
					})().finally(() => {
						groupChatOutputBuffers.delete(sessionId);
						debugLog('GroupChat:Debug', ` Cleared output buffer for session`);
					});
				} else {
					debugLog('GroupChat:Debug', ` WARNING: No buffered output!`);
					logger.warn('[GroupChat] Moderator exit with no buffered output', 'ProcessListener', {
						groupChatId,
						sessionId,
					});
				}
				groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
				debugLog('GroupChat:Debug', ` Emitted state change: idle`);
				debugLog('GroupChat:Debug', ` =============================================`);
				// Don't send to regular exit handler
				return;
			}

			// Handle group chat participant exit - route buffered output and update participant state
			// Session ID format: group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
			const participantExitInfo = parseParticipantSessionId(sessionId);
			if (participantExitInfo) {
				const { groupChatId, participantName } = participantExitInfo;
				debugLog('GroupChat:Debug', ` ========== PARTICIPANT PROCESS EXIT ==========`);
				debugLog('GroupChat:Debug', ` Group Chat ID: ${groupChatId}`);
				debugLog('GroupChat:Debug', ` Participant: ${participantName}`);
				debugLog('GroupChat:Debug', ` Session ID: ${sessionId}`);
				debugLog('GroupChat:Debug', ` Exit code: ${code}`);
				logger.debug(
					`[GroupChat] Participant exit: ${participantName} (groupChatId=${groupChatId})`,
					'ProcessListener',
					{ sessionId }
				);

				// Emit participant state change to show this participant is done working
				groupChatEmitters.emitParticipantState?.(groupChatId, participantName, 'idle');
				debugLog('GroupChat:Debug', ` Emitted participant state: idle`);

				// Route the buffered output now that process is complete
				// IMPORTANT: We must wait for the response to be logged before triggering synthesis
				// to avoid a race condition where synthesis reads the log before the response is written
				const bufferedOutput = getGroupChatBufferedOutput(sessionId);
				debugLog('GroupChat:Debug', ` Buffered output length: ${bufferedOutput?.length ?? 0}`);

				// Helper function to mark participant and potentially trigger synthesis
				const markAndMaybeSynthesize = () => {
					const isLastParticipant = markParticipantResponded(groupChatId, participantName);
					debugLog('GroupChat:Debug', ` Is last participant to respond: ${isLastParticipant}`);
					if (isLastParticipant && processManager && agentDetector) {
						// All participants have responded - spawn moderator synthesis round
						debugLog(
							'GroupChat:Debug',
							` All participants responded - spawning synthesis round...`
						);
						logger.info(
							'[GroupChat] All participants responded, spawning moderator synthesis',
							'ProcessListener',
							{ groupChatId }
						);
						spawnModeratorSynthesis(groupChatId, processManager, agentDetector).catch((err) => {
							debugLog('GroupChat:Debug', ` ERROR spawning synthesis:`, err);
							logger.error('[GroupChat] Failed to spawn moderator synthesis', 'ProcessListener', {
								error: String(err),
								groupChatId,
							});
						});
					} else if (!isLastParticipant) {
						// More participants pending
						debugLog('GroupChat:Debug', ` Waiting for more participants to respond...`);
					}
				};

				if (bufferedOutput) {
					debugLog(
						'GroupChat:Debug',
						` Raw buffered output preview: "${bufferedOutput.substring(0, 300)}${bufferedOutput.length > 300 ? '...' : ''}"`
					);

					// Handle session recovery and normal processing in an async IIFE
					void (async () => {
						// Check if this is a session_not_found error - if so, recover and retry
						const chat = await loadGroupChat(groupChatId);
						const agentType = chat?.participants.find((p) => p.name === participantName)?.agentId;

						if (needsSessionRecovery(bufferedOutput, agentType)) {
							debugLog(
								'GroupChat:Debug',
								` Session not found error detected for ${participantName} - initiating recovery`
							);
							logger.info('[GroupChat] Session recovery needed', 'ProcessListener', {
								groupChatId,
								participantName,
							});

							// Clear the buffer first
							groupChatOutputBuffers.delete(sessionId);

							// Initiate recovery (clears agentSessionId)
							await initiateSessionRecovery(groupChatId, participantName);

							// Re-spawn the participant with recovery context
							if (processManager && agentDetector) {
								debugLog(
									'GroupChat:Debug',
									` Re-spawning ${participantName} with recovery context...`
								);
								try {
									await respawnParticipantWithRecovery(
										groupChatId,
										participantName,
										processManager,
										agentDetector
									);
									debugLog(
										'GroupChat:Debug',
										` Successfully re-spawned ${participantName} for recovery`
									);
									// Don't mark as responded yet - the recovery spawn will complete and trigger this
								} catch (respawnErr) {
									debugLog('GroupChat:Debug', ` Failed to respawn ${participantName}:`, respawnErr);
									logger.error(
										'[GroupChat] Failed to respawn participant for recovery',
										'ProcessListener',
										{
											error: String(respawnErr),
											participant: participantName,
										}
									);
									// Mark as responded since recovery failed
									markAndMaybeSynthesize();
								}
							} else {
								debugLog(
									'GroupChat:Debug',
									` Cannot respawn - processManager or agentDetector not available`
								);
								markAndMaybeSynthesize();
							}
							debugLog('GroupChat:Debug', ` ===============================================`);
							return;
						}

						// Normal processing - parse and route the response
						try {
							debugLog(
								'GroupChat:Debug',
								` Chat loaded for participant parsing: ${chat?.name || 'null'}`
							);
							debugLog('GroupChat:Debug', ` Agent type for parsing: ${agentType}`);
							const parsedText = extractTextFromStreamJson(bufferedOutput, agentType);
							debugLog('GroupChat:Debug', ` Parsed text length: ${parsedText.length}`);
							debugLog(
								'GroupChat:Debug',
								` Parsed text preview: "${parsedText.substring(0, 200)}${parsedText.length > 200 ? '...' : ''}"`
							);
							if (parsedText.trim()) {
								debugLog('GroupChat:Debug', ` Routing agent response from ${participantName}...`);
								// Await the response logging before marking participant as responded
								await routeAgentResponse(
									groupChatId,
									participantName,
									parsedText,
									processManager ?? undefined
								);
								debugLog(
									'GroupChat:Debug',
									` Successfully routed agent response from ${participantName}`
								);
							} else {
								debugLog(
									'GroupChat:Debug',
									` WARNING: Parsed text is empty for ${participantName}!`
								);
							}
						} catch (err) {
							debugLog('GroupChat:Debug', ` ERROR loading chat for participant:`, err);
							logger.error(
								'[GroupChat] Failed to load chat for participant output parsing',
								'ProcessListener',
								{ error: String(err), participant: participantName }
							);
							try {
								const parsedText = extractTextFromStreamJson(bufferedOutput);
								if (parsedText.trim()) {
									await routeAgentResponse(
										groupChatId,
										participantName,
										parsedText,
										processManager ?? undefined
									);
								}
							} catch (routeErr) {
								debugLog('GroupChat:Debug', ` ERROR routing agent response (fallback):`, routeErr);
								logger.error('[GroupChat] Failed to route agent response', 'ProcessListener', {
									error: String(routeErr),
									participant: participantName,
								});
							}
						}
					})().finally(() => {
						groupChatOutputBuffers.delete(sessionId);
						debugLog('GroupChat:Debug', ` Cleared output buffer for participant session`);
						// Mark participant and trigger synthesis AFTER logging is complete
						markAndMaybeSynthesize();
					});
				} else {
					debugLog(
						'GroupChat:Debug',
						` WARNING: No buffered output for participant ${participantName}!`
					);
					// No output to log, so mark participant as responded immediately
					markAndMaybeSynthesize();
				}
				debugLog('GroupChat:Debug', ` ===============================================`);
				// Don't send to regular exit handler
				return;
			}

			safeSend('process:exit', sessionId, code);

			// Broadcast exit to web clients
			if (webServer) {
				// Extract base session ID from formats: {id}-ai-{tabId}, {id}-terminal, {id}-batch-{timestamp}, {id}-synopsis-{timestamp}
				const baseSessionId = sessionId.replace(
					/-ai-[^-]+$|-terminal$|-batch-\d+$|-synopsis-\d+$/,
					''
				);
				webServer.broadcastToSessionClients(baseSessionId, {
					type: 'session_exit',
					sessionId: baseSessionId,
					exitCode: code,
					timestamp: Date.now(),
				});
			}
		});

		processManager.on('session-id', (sessionId: string, agentSessionId: string) => {
			// Handle group chat participant session ID - store the agent's session ID
			// Session ID format: group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
			const participantSessionInfo = parseParticipantSessionId(sessionId);
			if (participantSessionInfo) {
				const { groupChatId, participantName } = participantSessionInfo;
				// Update the participant with the agent's session ID
				updateParticipant(groupChatId, participantName, { agentSessionId })
					.then(async () => {
						// Emit participants changed so UI updates with the new session ID
						const chat = await loadGroupChat(groupChatId);
						if (chat) {
							groupChatEmitters.emitParticipantsChanged?.(groupChatId, chat.participants);
						}
					})
					.catch((err) => {
						logger.error(
							'[GroupChat] Failed to update participant agentSessionId',
							'ProcessListener',
							{ error: String(err), participant: participantName }
						);
					});
				// Don't return - still send to renderer for logging purposes
			}

			// Handle group chat moderator session ID - store the real agent session ID
			// Session ID format: group-chat-{groupChatId}-moderator-{timestamp}
			const moderatorMatch = sessionId.match(REGEX_MODERATOR_SESSION_TIMESTAMP);
			if (moderatorMatch) {
				const groupChatId = moderatorMatch[1];
				// Update the group chat with the moderator's real agent session ID
				// Store in moderatorAgentSessionId (not moderatorSessionId which is the routing prefix)
				updateGroupChat(groupChatId, { moderatorAgentSessionId: agentSessionId })
					.then(() => {
						// Emit session ID change event so UI updates with the new session ID
						groupChatEmitters.emitModeratorSessionIdChanged?.(groupChatId, agentSessionId);
					})
					.catch((err: unknown) => {
						logger.error(
							'[GroupChat] Failed to update moderator agent session ID',
							'ProcessListener',
							{ error: String(err), groupChatId }
						);
					});
				// Don't return - still send to renderer for logging purposes
			}

			safeSend('process:session-id', sessionId, agentSessionId);
		});

		// Handle slash commands from Claude Code init message
		processManager.on('slash-commands', (sessionId: string, slashCommands: string[]) => {
			safeSend('process:slash-commands', sessionId, slashCommands);
		});

		// Handle thinking/streaming content chunks from AI agents
		// Emitted when agents produce partial text events (isPartial: true)
		// Renderer decides whether to display based on tab's showThinking setting
		processManager.on('thinking-chunk', (sessionId: string, content: string) => {
			safeSend('process:thinking-chunk', sessionId, content);
		});

		// Handle tool execution events (OpenCode, Codex)
		processManager.on(
			'tool-execution',
			(sessionId: string, toolEvent: { toolName: string; state?: unknown; timestamp: number }) => {
				safeSend('process:tool-execution', sessionId, toolEvent);
			}
		);

		// Handle stderr separately from runCommand (for clean command execution)
		processManager.on('stderr', (sessionId: string, data: string) => {
			safeSend('process:stderr', sessionId, data);
		});

		// Handle command exit (from runCommand - separate from PTY exit)
		processManager.on('command-exit', (sessionId: string, code: number) => {
			safeSend('process:command-exit', sessionId, code);
		});

		// Handle usage statistics from AI responses
		processManager.on(
			'usage',
			(
				sessionId: string,
				usageStats: {
					inputTokens: number;
					outputTokens: number;
					cacheReadInputTokens: number;
					cacheCreationInputTokens: number;
					totalCostUsd: number;
					contextWindow: number;
					reasoningTokens?: number; // Separate reasoning tokens (Codex o3/o4-mini)
				}
			) => {
				// Handle group chat participant usage - update participant stats
				const participantUsageInfo = parseParticipantSessionId(sessionId);
				if (participantUsageInfo) {
					const { groupChatId, participantName } = participantUsageInfo;

					// Calculate context usage percentage using agent-specific logic
					// Note: For group chat, we don't have agent type here, defaults to Claude behavior
					const totalContextTokens = calculateContextTokens(usageStats);
					const contextUsage =
						usageStats.contextWindow > 0
							? Math.round((totalContextTokens / usageStats.contextWindow) * 100)
							: 0;

					// Update participant with usage stats
					updateParticipant(groupChatId, participantName, {
						contextUsage,
						tokenCount: totalContextTokens,
						totalCost: usageStats.totalCostUsd,
					})
						.then(async () => {
							// Emit participants changed so UI updates
							const chat = await loadGroupChat(groupChatId);
							if (chat) {
								groupChatEmitters.emitParticipantsChanged?.(groupChatId, chat.participants);
							}
						})
						.catch((err) => {
							logger.error('[GroupChat] Failed to update participant usage', 'ProcessListener', {
								error: String(err),
								participant: participantName,
							});
						});
					// Still send to renderer for consistency
				}

				// Handle group chat moderator usage - emit for UI
				const moderatorUsageMatch = sessionId.match(REGEX_MODERATOR_SESSION);
				if (moderatorUsageMatch) {
					const groupChatId = moderatorUsageMatch[1];
					// Calculate context usage percentage using agent-specific logic
					// Note: Moderator is typically Claude, defaults to Claude behavior
					const totalContextTokens = calculateContextTokens(usageStats);
					const contextUsage =
						usageStats.contextWindow > 0
							? Math.round((totalContextTokens / usageStats.contextWindow) * 100)
							: 0;

					// Emit moderator usage for the moderator card
					groupChatEmitters.emitModeratorUsage?.(groupChatId, {
						contextUsage,
						totalCost: usageStats.totalCostUsd,
						tokenCount: totalContextTokens,
					});
				}

				safeSend('process:usage', sessionId, usageStats);
			}
		);

		// Handle agent errors (auth expired, token exhaustion, rate limits, etc.)
		processManager.on(
			'agent-error',
			(
				sessionId: string,
				agentError: {
					type: string;
					message: string;
					recoverable: boolean;
					agentId: string;
					sessionId?: string;
					timestamp: number;
					raw?: {
						exitCode?: number;
						stderr?: string;
						stdout?: string;
						errorLine?: string;
					};
				}
			) => {
				logger.info(`Agent error detected: ${agentError.type}`, 'AgentError', {
					sessionId,
					agentId: agentError.agentId,
					errorType: agentError.type,
					message: agentError.message,
					recoverable: agentError.recoverable,
				});
				safeSend('agent:error', sessionId, agentError);
			}
		);

		// Handle query-complete events for stats tracking
		// This is emitted when a batch mode AI query completes (user or auto)
		processManager.on(
			'query-complete',
			(
				_sessionId: string,
				queryData: {
					sessionId: string;
					agentType: string;
					source: 'user' | 'auto';
					startTime: number;
					duration: number;
					projectPath?: string;
					tabId?: string;
				}
			) => {
				try {
					const db = getStatsDB();
					if (db.isReady()) {
						const id = db.insertQueryEvent({
							sessionId: queryData.sessionId,
							agentType: queryData.agentType,
							source: queryData.source,
							startTime: queryData.startTime,
							duration: queryData.duration,
							projectPath: queryData.projectPath,
							tabId: queryData.tabId,
						});
						logger.debug(`Recorded query event: ${id}`, '[Stats]', {
							sessionId: queryData.sessionId,
							agentType: queryData.agentType,
							source: queryData.source,
							duration: queryData.duration,
						});
						// Broadcast stats update to renderer for real-time dashboard refresh
						safeSend('stats:updated');
					}
				} catch (error) {
					logger.error(`Failed to record query event: ${error}`, '[Stats]', {
						sessionId: queryData.sessionId,
					});
				}
			}
		);
	}
}
