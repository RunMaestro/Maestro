import { app, BrowserWindow, Menu, powerMonitor, protocol } from 'electron';
import { isMacOS } from '../shared/platformDetection';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { readFile } from 'fs/promises';
// Sentry is imported dynamically below to avoid module-load-time access to electron.app
// which causes "Cannot read properties of undefined (reading 'getAppPath')" errors
import { ProcessManager } from './process-manager';
import { WebServer } from './web-server';
import { AgentDetector } from './agents';
import { getAgentDefinition } from './agents/definitions';
import { DEFAULT_CONTEXT_WINDOWS, FALLBACK_CONTEXT_WINDOW } from '../shared/agentConstants';
import { shouldDropSentryEvent } from '../shared/sentryFilters';
import type { AgentId } from '../shared/agentIds';
import {
	initGlobalHotkey,
	setGlobalShowHotkey,
	disposeGlobalHotkey,
} from './global-hotkey-manager';
import { CueEngine } from './cue/cue-engine';
import { configureCueTelemetry } from './cue/cue-telemetry';
import {
	executeCuePrompt,
	recordCueHistoryEntry,
	stopCueRun,
	getCueProcessList,
} from './cue/cue-executor';
import { executeCueShell, stopCueShellRun } from './cue/cue-shell-executor';
import { executeCueCli, stopCueCliRun } from './cue/cue-cli-executor';
import { executeCueNotify } from './cue/cue-notify-executor';
import { getAgentDisplayName } from '../shared/agentMetadata';
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
	getAgentCapabilitiesStore,
	getWindowStateStore,
	getClaudeSessionOriginsStore,
	getAgentSessionOriginsStore,
	getSshRemoteById,
} from './stores';
import { runSettingsMigrations } from './stores/migrations';
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
	registerBmadHandlers,
	registerContextHandlers,
	registerMarketplaceHandlers,
	registerStatsHandlers,
	registerCueStatsHandlers,
	registerDocumentGraphHandlers,
	registerSshRemoteHandlers,
	registerFilesystemHandlers,
	registerAttachmentsHandlers,
	registerWebHandlers,
	ensureCliServer,
	startCliDiscoveryWatchdog,
	stopCliDiscoveryWatchdog,
	registerLeaderboardHandlers,
	registerNotificationsHandlers,
	registerSymphonyHandlers,
	registerTabNamingHandlers,
	registerAgentErrorHandlers,
	registerDirectorNotesHandlers,
	registerCueHandlers,
	registerCueBackupHandlers,
	registerWakatimeHandlers,
	registerFeedbackHandlers,
	registerMaestroCliHandlers,
	registerPromptsHandlers,
	registerMemoryHandlers,
	registerWindowsHandlers,
	setupLoggerEventForwarding,
	cleanupAllGroomingSessions,
	getActiveGroomingSessionCount,
} from './ipc/handlers';
import { initializeStatsDB, closeStatsDB, getStatsDB } from './stats';
import { groupChatEmitters } from './ipc/handlers/groupChat';
import {
	routeModeratorResponse,
	routeAgentResponse,
	setGetSessionsCallback,
	setGetCustomEnvVarsCallback,
	setGetAgentConfigCallback,
	setGetModeratorSettingsCallback,
	setSshStore,
	setGetCustomShellPathCallback,
	markParticipantResponded,
	spawnModeratorSynthesis,
	getGroupChatReadOnlyState,
	respawnParticipantWithRecovery,
	clearActiveParticipantTaskSession,
	clearModeratorResponseTimeout,
} from './group-chat/group-chat-router';
import { createSshRemoteStoreAdapter } from './utils/ssh-remote-resolver';
import { updateParticipant, loadGroupChat, updateGroupChat } from './group-chat/group-chat-storage';
import { stopSessionCleanup } from './group-chat/group-chat-moderator';
import { needsSessionRecovery, initiateSessionRecovery } from './group-chat/session-recovery';
import { initializePrompts, getPrompt, savePrompt } from './prompt-manager';
import { captureException } from './utils/sentry';
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
import { setupDeepLinkHandling, flushPendingDeepLink } from './deep-links';
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
import { capabilitySnapshots, createSnapshotBroadcaster } from './agents/capability-snapshot';
import { createWebServerFactory } from './web-server/web-server-factory';
// Phase 4 refactoring - app lifecycle
import {
	setupGlobalErrorHandlers,
	createCliWatcher,
	createSettingsWatcher,
	createWindowManager,
	createQuitHandler,
	type QuitHandler,
} from './app-lifecycle';
// Multi-window registry (single source of truth for window<->session ownership)
import { WindowRegistry } from './window-registry';
// Phase 3 refactoring - process listeners
import { setupProcessListeners as setupProcessListenersModule } from './process-listeners';
import { setupWakaTimeListener } from './process-listeners/wakatime-listener';
import { WakaTimeManager } from './wakatime-manager';
import { MaestroCliManager } from './maestro-cli-manager';
import {
	createInteractiveReplayController,
	type InteractiveReplayController,
} from './agents/claude-interactive-replay';
import { sampleUsage as sampleClaudeUsage } from './agents/claude-usage-sampler';
import { setSnapshot as setClaudeUsageSnapshot } from './stores/claudeUsageStore';
import { getMaestroPBinPath, runStartupUsageSampling } from './agents/claude-usage-startup';
import { UsageRefreshScheduler } from './agents/usage-refresh-scheduler';
import type { ProcessConfig as ProcessSpawnConfig } from './process-manager/types';
import type { TemplateContext } from '../shared/templateVariables';

// ============================================================================
// Data Directory Configuration (MUST happen before any Store initialization)
// ============================================================================
// Store type definitions are imported from ./stores/types.ts
const isDevelopment = process.env.NODE_ENV === 'development';

// Electron 41 / Chromium 138 forbid ES module imports from `file://` URLs (the
// production entry chunk loads but its `import { ... } from "./..."` statements
// fail with "Failed to fetch dynamically imported module" and the React app
// never mounts). Serve the production renderer through a custom `app://`
// scheme so static and dynamic ES module imports succeed under a normal
// http(s)-style origin.
const RENDERER_SCHEME = 'app';
if (!isDevelopment) {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: RENDERER_SCHEME,
			privileges: {
				standard: true,
				secure: true,
				supportFetchAPI: true,
				corsEnabled: true,
				stream: true,
			},
		},
	]);
}

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

// Publish the resolved userData path so shared/cli-server-discovery.ts (used by
// both this main process and the maestro-cli) writes/reads the discovery file
// in the same data directory the app actually uses. Without this, dev and prod
// would clobber each other's cli-server.json at the hardcoded platform default.
process.env.MAESTRO_USER_DATA = app.getPath('userData');

// ============================================================================
// Store Initialization (after userData path is configured)
// ============================================================================
// All stores are initialized via initializeStores() from ./stores module

const { syncPath, bootstrapStore } = initializeStores({ productionDataPath });

// Get early settings before Sentry init (for crash reporting and GPU acceleration)
const { crashReportingEnabled, disableGpuAcceleration, useNativeTitleBar, autoHideMenuBar } =
	getEarlySettings(syncPath);

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

// Run one-shot settings-store migrations (idempotent — each migration owns
// its own marker). Mirrors the installation-ID generator above as the
// canonical "first thing we do after the settings store is up" hook.
runSettingsMigrations(store);

// Initialize WakaTime heartbeat manager
const wakatimeManager = new WakaTimeManager(store);
const maestroCliManager = new MaestroCliManager();

// Auto-install WakaTime CLI on startup if enabled
if (store.get('wakatimeEnabled', false)) {
	wakatimeManager.ensureCliInstalled();
}

// Auto-install WakaTime CLI when user enables the feature
store.onDidChange('wakatimeEnabled', (newValue) => {
	if (newValue === true) {
		wakatimeManager.ensureCliInstalled();
	}
});

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
				// Filter out sensitive data + unfixable OS / Chromium / user-env noise.
				// See src/shared/sentryFilters.ts for the full classification.
				beforeSend(event) {
					if (shouldDropSentryEvent(event)) {
						return null;
					}
					if (event.user) {
						delete event.user.ip_address;
						delete event.user.email;
					}
					return event;
				},
			});
			// Add installation ID to Sentry for error correlation across installations
			setTag('installationId', installationId);
			// Tag release channel (rc vs stable) based on version string
			// RC builds use -RC suffix (e.g., 0.16.1-RC), stable builds use plain semver
			const version = app.getVersion();
			setTag('channel', version.includes('-RC') ? 'rc' : 'stable');

			// Start memory monitoring for crash diagnostics (MAESTRO-5A/4Y)
			// Records breadcrumbs with memory state every minute, warns above 1GB heap
			import('./utils/sentry')
				.then(({ startMemoryMonitoring }) => {
					startMemoryMonitoring(1024, 60000);
				})
				.catch((err) => {
					logger.warn('Failed to start memory monitoring', 'Startup', { error: String(err) });
				});
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
const agentCapabilitiesStore = getAgentCapabilitiesStore();
const windowStateStore = getWindowStateStore();
const claudeSessionOriginsStore = getClaudeSessionOriginsStore();
const agentSessionOriginsStore = getAgentSessionOriginsStore();

function getAgentConfigForAgent(agentId: string): Record<string, any> {
	const allConfigs = agentConfigsStore.get('configs', {});
	return allConfigs[agentId] || {};
}

function getCustomEnvVarsForAgent(agentId: string): Record<string, string> | undefined {
	return getAgentConfigForAgent(agentId).customEnvVars as Record<string, string> | undefined;
}

// Note: History storage is now handled by HistoryManager which uses per-session files
// in the history/ directory. The legacy maestro-history.json file is migrated automatically.
// See src/main/history-manager.ts for details.

let mainWindow: BrowserWindow | null = null;
let processManager: ProcessManager | null = null;
let webServer: WebServer | null = null;
let agentDetector: AgentDetector | null = null;
let cueEngine: CueEngine | null = null;
let usageRefreshScheduler: UsageRefreshScheduler | null = null;
let interactiveReplayController: InteractiveReplayController<ProcessSpawnConfig> | null = null;

// Create safeSend with dependency injection (Phase 2 refactoring)
const safeSend = createSafeSend(() => mainWindow);

// Hydrate capability snapshots from disk and wire IPC broadcaster so the
// renderer status pills update live as detection / spawn-error events fire.
capabilitySnapshots.init(agentCapabilitiesStore, createSnapshotBroadcaster(safeSend));

// Create CLI activity watcher with dependency injection (Phase 4 refactoring)
const cliWatcher = createCliWatcher({
	getMainWindow: () => mainWindow,
	getUserDataPath: () => app.getPath('userData'),
});

// Create settings file watcher for external changes (e.g., from maestro-cli)
const settingsWatcher = createSettingsWatcher({
	getMainWindow: () => mainWindow,
	getSettingsPath: () => syncPath,
	getAgentConfigsPath: () => productionDataPath,
});

// Fallback must match DEFAULT_START_PORT in scripts/dev-port.mjs. Never 5173
// (Vite's default) - sharing it lets an agent-built dev server hijack the port
// and replace the whole app window. See scripts/dev-port.mjs for the rationale.
const devServerPort = process.env.VITE_PORT ? parseInt(process.env.VITE_PORT, 10) : 17173;
const devServerUrl = `http://localhost:${devServerPort}`;

// Forward declaration: quitHandler is constructed after the window, but the
// window manager needs a lazy reference so the auto-updater install path can
// bypass the busy-agent quit confirmation gate (otherwise on Windows the
// installer is orphaned by before-quit preventDefault).
let quitHandler: QuitHandler | null = null;

// Registry that tracks every BrowserWindow and which agents (sessions) live in
// each - the single source of truth for window<->session ownership. The object
// is constructed here (it has no app-ready dependencies); it stays empty until
// the primary window registers itself as `isMain` when createWindow() runs on
// app-ready, and secondary windows register via createSecondaryWindow.
const windowRegistry = new WindowRegistry();

// Create window manager with dependency injection (Phase 4 refactoring)
const windowManager = createWindowManager({
	windowStateStore,
	isDevelopment,
	preloadPath: path.join(__dirname, 'preload.js'),
	rendererProductionUrl: `${RENDERER_SCHEME}://app/index.html`,
	devServerUrl: devServerUrl,
	useNativeTitleBar,
	autoHideMenuBar,
	getConfirmQuit: () => quitHandler?.confirmQuit,
	// Multi-window wiring: the manager registers the primary as `isMain` and every
	// secondary window it builds. `getIsQuitting` lets a closing secondary skip
	// registry churn once a quit is already in flight (the registry dies with the
	// process anyway). `settingsStore` is threaded for the per-window panel/session
	// persistence later phases consume.
	windowRegistry,
	settingsStore: store,
	getIsQuitting: () => quitHandler?.isQuitConfirmed() ?? false,
});

// Create web server factory with dependency injection (Phase 2 refactoring)
const createWebServer = createWebServerFactory({
	settingsStore: store,
	sessionsStore,
	groupsStore,
	getMainWindow: () => mainWindow,
	getProcessManager: () => processManager,
	triggerCueSubscription: (subscriptionName, prompt, sourceAgentId) => {
		if (!cueEngine) return false;
		return cueEngine.triggerSubscription(subscriptionName, prompt, sourceAgentId);
	},
	getCueGraphData: () => {
		if (!cueEngine) return [];
		return cueEngine.getGraphData();
	},
	setCueSubscriptionEnabled: async (subscriptionId, enabled) => {
		if (!cueEngine) return false;
		return cueEngine.setSubscriptionEnabled(subscriptionId, enabled);
	},
	getCueActivityLog: () => {
		if (!cueEngine) return [];
		return cueEngine.getActivityLog();
	},
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

		// The primary window is the app's anchor: it owns the auto-updater, the
		// global hotkey, the deep-link target, and the quit-confirmation surface.
		// When it closes while secondary windows are still open (multi-window),
		// those windows are orphaned, so quit the whole app. app.quit() routes
		// through the existing quit handler, preserving the updater/confirmation
		// flow. When the primary is the LAST window, we defer to
		// 'window-all-closed' instead (macOS stays alive for dock relaunch), and
		// we skip if a quit is already in flight to avoid re-entrancy.
		const otherWindowsOpen = BrowserWindow.getAllWindows().length > 0;
		if (otherWindowsOpen && !quitHandler?.isQuitConfirmed()) {
			logger.info('Primary window closed with secondary windows open, quitting app', 'Window');
			app.quit();
		}
	});

	// Kill all managed processes before the renderer reloads after a crash.
	// Without this, the new renderer restores sessions with pid:0 and spawns fresh
	// PTYs, but only the *active* tab's old PTY gets killed (via spawn-before-kill).
	// Non-active tabs' orphaned PTYs survive indefinitely, leaking PTY file descriptors.
	mainWindow.webContents.on('render-process-gone', () => {
		processManager?.killAll();
	});
}

// Set up global error handlers for uncaught exceptions (Phase 4 refactoring)
setupGlobalErrorHandlers();

// Set up deep link protocol handling (must be before app.whenReady for requestSingleInstanceLock)
const gotSingleInstanceLock = setupDeepLinkHandling(() => mainWindow);
if (!gotSingleInstanceLock) {
	app.quit();
	process.exit(0);
}

app
	.whenReady()
	.then(async () => {
		// Serve the production renderer over `app://` so static and dynamic ES
		// module imports succeed on Electron 41 (Chromium 138 blocks both under
		// file://). `net.fetch` cannot read file:// URLs in Electron 41 either, so
		// we read assets directly via fs and return a Response.
		if (!isDevelopment) {
			const rendererRoot = path.resolve(__dirname, '../renderer');
			const mimeByExt: Record<string, string> = {
				'.html': 'text/html; charset=utf-8',
				'.js': 'text/javascript; charset=utf-8',
				'.mjs': 'text/javascript; charset=utf-8',
				'.css': 'text/css; charset=utf-8',
				'.json': 'application/json; charset=utf-8',
				'.svg': 'image/svg+xml',
				'.png': 'image/png',
				'.jpg': 'image/jpeg',
				'.jpeg': 'image/jpeg',
				'.gif': 'image/gif',
				'.ico': 'image/x-icon',
				'.webp': 'image/webp',
				'.woff': 'font/woff',
				'.woff2': 'font/woff2',
				'.ttf': 'font/ttf',
				'.otf': 'font/otf',
				'.map': 'application/json; charset=utf-8',
			};
			protocol.handle(RENDERER_SCHEME, async (request) => {
				const url = new URL(request.url);
				const requestedPath = decodeURIComponent(url.pathname);
				const relative =
					requestedPath === '/' || requestedPath === '' ? '/index.html' : requestedPath;
				const resolved = path.normalize(path.join(rendererRoot, relative));
				// path.relative() guards against prefix-traversal that startsWith()
				// would miss (e.g. `/app/renderer-backup` passing a `/app/renderer`
				// prefix check). A relative path that starts with `..` or is
				// absolute means `resolved` escapes `rendererRoot`.
				const rel = path.relative(rendererRoot, resolved);
				if (rel.startsWith('..') || path.isAbsolute(rel)) {
					return new Response('forbidden', { status: 403 });
				}
				try {
					const data = await readFile(resolved);
					const ext = path.extname(resolved).toLowerCase();
					const contentType = mimeByExt[ext] ?? 'application/octet-stream';
					return new Response(new Uint8Array(data), {
						status: 200,
						headers: { 'content-type': contentType },
					});
				} catch (err) {
					// Only swallow "file not found" — surface every other fs error
					// (EACCES, EISDIR, etc.) so Sentry / the renderer can react
					// instead of silently 404ing on a broken install.
					if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
						logger.warn(`Renderer asset not found: ${resolved}`, 'Window', {
							err: String(err),
						});
						return new Response('not found', { status: 404 });
					}
					throw err;
				}
			});
		}

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

		// Warm the login-shell PATH cache early so the first agent spawn picks up
		// the user's custom PATH (e.g. node installs outside our hardcoded
		// version-manager paths). Fire-and-forget; the spawn flow tolerates a
		// missing cache.
		void (async () => {
			try {
				const { refreshShellPath } = await import('./runtime/getShellPath');
				await refreshShellPath();
				logger.debug('Shell PATH cache warmed at startup', 'Startup');
			} catch (err) {
				// Probe failures are non-fatal; spawn falls back to hardcoded paths.
				logger.debug('Shell PATH cache warm-up skipped', 'Startup', {
					reason: err instanceof Error ? err.message : String(err),
				});
			}
		})();

		// Reactive limit replay controller: armed when a Claude tab spawns in
		// interactive mode, fires the API-mode replay flow on exit code 2.
		// Decoupled from the process handler so its dependencies (sampleUsage,
		// snapshot store write, mode-resolved emit, processManager.spawn) live
		// in one place instead of being threaded through registerProcessHandlers.
		interactiveReplayController = createInteractiveReplayController<ProcessSpawnConfig>({
			emitter: processManager,
			sampleUsage: async (configDirKey) => {
				// Re-run sampleUsage for the relevant config dir so the renderer's
				// dashboard reflects the post-fallback quota state.
				const binPath = getMaestroPBinPath();
				if (!binPath) return;
				const snapshot = await sampleClaudeUsage({
					binPath,
					configDir: configDirKey,
					cwd: app.getPath('home'),
				});
				if (snapshot) {
					setClaudeUsageSnapshot(snapshot);
				}
			},
			updateSessionInteractive: (sessionId, update) => {
				const sessions = sessionsStore.get('sessions', []) as Array<Record<string, unknown>>;
				let mutated = false;
				const next = sessions.map((s) => {
					if (s?.id !== sessionId) return s;
					mutated = true;
					return {
						...s,
						claudeInteractive: {
							mode: update.mode,
							modeReason: update.modeReason,
							lastUsageSnapshotKey: update.lastUsageSnapshotKey,
						},
					};
				});
				if (mutated) {
					sessionsStore.set('sessions', next);
				}
			},
			emitModeResolved: (sessionId, resolution) => {
				if (isWebContentsAvailable(mainWindow)) {
					mainWindow!.webContents.send('process:claude-mode-resolved', sessionId, resolution);
				}
			},
			spawnReplay: (_sessionId, replayConfig) => {
				processManager?.spawn(replayConfig);
			},
			logger: {
				debug: (message, ...args) =>
					logger.debug(message, 'ClaudeInteractiveReplay', ...(args as [])),
				info: (message, ...args) =>
					logger.info(message, 'ClaudeInteractiveReplay', ...(args as [])),
				warn: (message, ...args) =>
					logger.warn(message, 'ClaudeInteractiveReplay', ...(args as [])),
			},
		});

		// Bring up the CLI server and publish the discovery file as early as
		// possible. Done here (before initializePrompts / Cue / history / etc.)
		// so an unhandled error later in startup can't silently leave maestro-cli
		// without a discovery file — the symptom that previously forced users to
		// toggle Live Mode on/off to coax the file into existence.
		const cliServerDeps = {
			getWebServer: () => webServer,
			setWebServer: (server: WebServer | null) => {
				webServer = server;
			},
			createWebServer,
			settingsStore: store,
		};
		await ensureCliServer(cliServerDeps);
		// Defense in depth: if the initial attempt silently dropped the
		// discovery file (or any later code deletes / clobbers it), the
		// watchdog republishes within seconds so maestro-cli works without
		// the user having to toggle Live Mode to coax it back.
		startCliDiscoveryWatchdog(cliServerDeps);

		// Initialize core prompts from disk (must happen before features that use them)
		try {
			await initializePrompts();
		} catch (error) {
			logger.error(`Critical: Failed to initialize prompts: ${error}`, 'Startup');
			await captureException(error instanceof Error ? error : new Error(String(error)), {
				operation: 'startup:initializePrompts',
			});
			const { dialog } = await import('electron');
			dialog.showErrorBox(
				'Startup Error',
				'Failed to load system prompts. Please reinstall the application.'
			);
			app.quit();
			return;
		}

		// One-time migration: bake standing instructions into moderator prompt customization
		const standingInstructions = (store.get('moderatorStandingInstructions', '') as string) || '';
		const migratedKey = 'moderatorStandingInstructionsMigrated';

		if (standingInstructions && !store.get(migratedKey, false)) {
			try {
				const currentPrompt = getPrompt('group-chat-moderator-system');

				// Only migrate if the exact standing instructions content isn't already in the prompt
				if (!currentPrompt.includes(standingInstructions)) {
					const sectionHeader = '## Standing Instructions';
					const newSection = `${sectionHeader}\n\nThe following instructions apply to ALL group chat sessions. Follow them consistently:\n\n${standingInstructions}`;

					let migratedPrompt: string;
					if (currentPrompt.includes(sectionHeader)) {
						migratedPrompt = currentPrompt.replace(
							/## Standing Instructions[\s\S]*?(?=\n## |\s*$)/,
							newSection
						);
					} else {
						migratedPrompt = `${currentPrompt}\n\n${newSection}`;
					}
					await savePrompt('group-chat-moderator-system', migratedPrompt);
					logger.info(
						'Migrated moderator standing instructions into prompt customization',
						'Startup'
					);
				}
				store.set(migratedKey, true);
			} catch (err) {
				await captureException(err instanceof Error ? err : new Error(String(err)), {
					migratedKey,
					standingInstructionsSlice: standingInstructions.slice(0, 200),
				});
				logger.warn(
					'Failed to persist migrated moderator standing instructions, will retry next launch',
					'Startup'
				);
			}
		}

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

		// Fire-and-forget: sample `maestro-p --status` for every CLAUDE_CONFIG_DIR
		// account referenced by a recent Batch Mode-enabled Claude session so the
		// context-window popover has fresh quota data on first turn. Failures here
		// are non-fatal — the spawner's resolver tolerates a null snapshot by
		// defaulting to interactive, and the next sampler refresh will repopulate.
		void runStartupUsageSampling({
			sessionsStore,
			agentConfigsStore,
			settingsStore: store,
			agentDetector,
		}).catch((err: unknown) => {
			logger.warn('Startup Claude usage sampling failed', 'Startup', {
				error: err instanceof Error ? err.message : String(err),
			});
		});

		// Background quota refresh: drives the Usage Dashboard's per-provider
		// "Auto refresh" cadence from the main process so it keeps sampling even
		// when the dashboard is closed (the old renderer setInterval died on
		// unmount). Reads the persisted `usageRefreshIntervals` map and re-arms on
		// change. Idempotent; arms nothing until the user picks an interval.
		usageRefreshScheduler = new UsageRefreshScheduler({
			sessionsStore,
			agentConfigsStore,
			settingsStore: store,
			agentDetector,
		});
		usageRefreshScheduler.start();

		// Initialize Cue Engine for event-driven automation
		cueEngine = new CueEngine({
			getSessions: () => {
				const stored = sessionsStore.get('sessions', []);
				return stored.map((s: any) => ({
					id: s.id,
					name: s.name,
					toolType: s.toolType,
					cwd: s.cwd || s.projectRoot || s.fullPath || os.homedir(),
					projectRoot: s.projectRoot || s.cwd || s.fullPath || os.homedir(),
				}));
			},
			onCueRun: async ({
				runId,
				sessionId,
				prompt,
				subscriptionName,
				event,
				timeoutMs,
				action,
				command,
				notify,
			}) => {
				const storedSessions = sessionsStore.get('sessions', []) as Array<Record<string, any>>;
				const storedSession = storedSessions.find((s) => s.id === sessionId);
				if (!storedSession) {
					throw new Error(`Cue target session not found: ${sessionId}`);
				}

				const projectRoot =
					storedSession.projectRoot || storedSession.cwd || storedSession.fullPath || os.homedir();
				const templateContext: TemplateContext = {
					session: {
						id: storedSession.id,
						name: storedSession.name,
						toolType: storedSession.toolType,
						cwd: projectRoot,
						projectRoot,
						fullPath: storedSession.fullPath,
						autoRunFolderPath: storedSession.autoRunFolderPath,
					},
					conductorProfile: (store.get('conductorProfile', '') as string) || undefined,
				};

				// `action: notify` surfaces a toast through the owning agent instead of
				// spawning anything — handled before command/prompt so the spawn config,
				// SSH wrap, and history-recording paths below stay agent-only. The
				// notify message is pre-resolved by the dispatch service via the
				// fallback chain (notify.message → label → prompt → name); falling
				// back here to `prompt` (which the dispatcher uses as the carrier)
				// covers the queue-restored corner where the in-memory `notify` was
				// lost but the message survived in the persisted `prompt` slot.
				if (action === 'notify') {
					const sessionInfo = {
						id: storedSession.id,
						name: storedSession.name,
						toolType: storedSession.toolType,
						cwd: projectRoot,
						projectRoot,
						autoRunFolderPath: storedSession.autoRunFolderPath,
					};
					const subscription = {
						name: subscriptionName,
						event: event.type,
						enabled: true,
						prompt,
						action,
						notify,
						agent_id: storedSession.id,
					};
					const notifyLog = (level: string, message: string) => {
						if (level === 'error') logger.error(message, 'Cue');
						else if (level === 'warn') logger.warn(message, 'Cue');
						else if (level === 'debug') logger.debug(message, 'Cue');
						else logger.cue(message, 'Cue');
					};
					const message = notify?.message?.trim() || prompt;
					const notifyResult = await executeCueNotify({
						runId,
						session: sessionInfo,
						subscription,
						event,
						agentId: storedSession.id,
						message,
						sticky: notify?.sticky === true,
						title: storedSession.name || getAgentDisplayName(storedSession.toolType),
						mainWindow,
						onLog: notifyLog,
					});
					const notifyHistory = recordCueHistoryEntry(notifyResult, sessionInfo);
					void historyManager.addEntry(storedSession.id, projectRoot, notifyHistory);
					return notifyResult;
				}

				// `action: command` runs a shell command or maestro-cli call instead of an
				// AI prompt — skip agent path resolution and SSH wrapping.
				if (action === 'command') {
					if (!command) {
						// Should be unreachable post-validator, but guard anyway so a
						// misconfigured subscription fails loudly instead of silently
						// executing `prompt` (a shell/cli sentinel) as an AI prompt.
						throw new Error(
							`Cue subscription "${subscriptionName}" has action='command' but no command payload`
						);
					}
					const sessionInfo = {
						id: storedSession.id,
						name: storedSession.name,
						toolType: storedSession.toolType,
						cwd: projectRoot,
						projectRoot,
						autoRunFolderPath: storedSession.autoRunFolderPath,
					};
					const subscription = {
						name: subscriptionName,
						event: event.type,
						enabled: true,
						prompt,
						action,
						command,
					};
					const cmdLog = (level: string, message: string) => {
						if (level === 'error') logger.error(message, 'Cue');
						else if (level === 'warn') logger.warn(message, 'Cue');
						else if (level === 'debug') logger.debug(message, 'Cue');
						else logger.cue(message, 'Cue');
					};
					const cmdResult =
						command.mode === 'shell'
							? await executeCueShell({
									runId,
									session: sessionInfo,
									subscription,
									event,
									shellCommand: command.shell,
									projectRoot,
									templateContext,
									timeoutMs,
									onLog: cmdLog,
									// Forward SSH config so shell commands run on the remote
									// host when the owning session is SSH-remote-enabled.
									sshRemoteConfig: storedSession.sessionSshRemoteConfig,
									sshStore: createSshRemoteStoreAdapter(store),
								})
							: await executeCueCli({
									runId,
									session: sessionInfo,
									subscription,
									event,
									cli: command.cli,
									templateContext,
									timeoutMs,
									onLog: cmdLog,
									// CLI mode intentionally stays local: `maestro-cli send`
									// targets the local Maestro daemon (routing messages to
									// sessions managed by this app), so SSH wrapping would
									// point at the wrong daemon and `maestro-cli.js` may not
									// exist on the remote host.
								});
					const cmdHistory = recordCueHistoryEntry(cmdResult, sessionInfo);
					// Fire-and-forget: this is on the Cue execution path; the
					// caller doesn't need to wait for the disk write to settle.
					void historyManager.addEntry(storedSession.id, projectRoot, cmdHistory);
					return cmdResult;
				}

				const agentConfigValues = getAgentConfigForAgent(storedSession.toolType);

				// Resolve the agent's binary path using the agent detector.
				// Without this, Cue falls back to the bare command name (e.g., 'claude')
				// which fails with ENOENT when spawn() can't find it on PATH.
				let resolvedAgentPath = agentConfigValues.customPath as string | undefined;
				if (!resolvedAgentPath && agentDetector) {
					const detectedAgent = await agentDetector.getAgent(storedSession.toolType);
					if (detectedAgent?.available && detectedAgent.path) {
						resolvedAgentPath = detectedAgent.path;
					}
				}

				const result = await executeCuePrompt({
					runId,
					session: {
						id: storedSession.id,
						name: storedSession.name,
						toolType: storedSession.toolType,
						cwd: projectRoot,
						projectRoot,
						autoRunFolderPath: storedSession.autoRunFolderPath,
					},
					subscription: {
						name: subscriptionName,
						event: event.type,
						enabled: true,
						prompt,
					},
					event,
					promptPath: prompt,
					toolType: storedSession.toolType,
					projectRoot,
					templateContext,
					timeoutMs,
					sshRemoteConfig: storedSession.sessionSshRemoteConfig,
					customPath: resolvedAgentPath,
					customArgs: storedSession.customArgs,
					customEnvVars: storedSession.customEnvVars,
					customModel: storedSession.customModel,
					customEffort: storedSession.customEffort,
					// Claude token-source selection (TUI / API / dynamic), read from
					// the same persisted session record that supplies customModel
					// above, so Cue runs honor the triggering agent's choice.
					enableMaestroP: storedSession.enableMaestroP,
					maestroPMode: storedSession.maestroPMode,
					maestroPPath: storedSession.maestroPPath,
					onLog: (level, message) => {
						if (level === 'error') {
							logger.error(message, 'Cue');
						} else if (level === 'warn') {
							logger.warn(message, 'Cue');
						} else if (level === 'debug') {
							logger.debug(message, 'Cue');
						} else {
							logger.cue(message, 'Cue');
						}
					},
					sshStore: createSshRemoteStoreAdapter(store),
					agentConfigValues,
				});

				const historyEntry = recordCueHistoryEntry(result, {
					id: storedSession.id,
					name: storedSession.name,
					toolType: storedSession.toolType,
					cwd: projectRoot,
					projectRoot,
					autoRunFolderPath: storedSession.autoRunFolderPath,
				});
				void historyManager.addEntry(storedSession.id, projectRoot, historyEntry);
				return result;
			},
			onStopCueRun: (runId) => stopCueRun(runId) || stopCueShellRun(runId) || stopCueCliRun(runId),
			onLog: (_level, message, data) => {
				logger.cue(message, 'Cue', data);
				// Push activity updates to renderer
				if (mainWindow && isWebContentsAvailable(mainWindow) && data) {
					mainWindow.webContents.send('cue:activityUpdate', data);
				}
			},
			onPreventSleep: (reason) => powerManager.addBlockReason(reason),
			onAllowSleep: (reason) => powerManager.removeBlockReason(reason),
			// Phase 01 — gate cue_events stats lineage writes on the
			// `encoreFeatures.usageStats` flag. Read on every record so toggling
			// the Encore flag at runtime takes effect without an app restart.
			getUsageStatsEnabled: () => {
				const ef = store.get('encoreFeatures', {}) as Record<string, boolean>;
				return ef.usageStats === true;
			},
		});

		// Configure Cue telemetry submitter. Reads installationId / encore flags
		// on every event so toggling Cue or usageStats at runtime takes effect
		// without an app restart. Same predicate as cue-stats.ts:isCueStatsEnabled
		// — both flags required.
		configureCueTelemetry({
			getInstallationId: () => store.get('installationId') as string | null,
			getAppVersion: () => app.getVersion(),
			getPlatform: () => process.platform,
			isEncoreEnabled: () => {
				const ef = store.get('encoreFeatures', {}) as Record<string, boolean>;
				return ef.maestroCue === true && ef.usageStats === true;
			},
		});

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
			void captureException(error);
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
			void captureException(error);
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

		// Start Cue engine if the Encore Feature flag is enabled
		const encoreFeatures = store.get('encoreFeatures', {}) as Record<string, boolean>;
		if (encoreFeatures.maestroCue && cueEngine) {
			logger.info('Maestro Cue Encore Feature enabled — starting Cue engine', 'Startup');
			try {
				cueEngine.start('system-boot');
			} catch (err) {
				void captureException(err);
				logger.error(
					`Cue engine failed to start at boot — will remain available for retry via Settings: ${err}`,
					'Startup'
				);
			}
		}

		// Set custom application menu to prevent macOS from injecting native
		// "Show Previous Tab" (Cmd+Shift+{) and "Show Next Tab" (Cmd+Shift+})
		// menu items into the default Window menu. Without this, those keyboard
		// events are intercepted at the NSMenu level and never reach the renderer.
		//
		// IMPORTANT: Do NOT include { role: 'close' } in the Window submenu.
		// The 'close' role registers Cmd+W as a native accelerator, which intercepts
		// the keystroke at the NSMenu level before it reaches the renderer. This
		// breaks Cmd+W tab-close shortcuts in both AI and terminal modes. Window
		// closing is handled by the app lifecycle (Cmd+Q quits, red traffic light
		// hides) so the native Close menu item is unnecessary.
		if (isMacOS()) {
			const template: Electron.MenuItemConstructorOptions[] = [
				{
					// Explicit appMenu — uses a custom Quit item instead of `role: 'quit'`
					// so we can swallow Opt+Cmd+Q. macOS auto-binds Opt+Cmd+Q to any
					// quit role (as "Quit and Keep Windows"), and that keystroke sits
					// one modifier away from Opt+Q (Maestro Cue), causing accidental
					// quits. Click events from accelerators carry modifier flags, so
					// we can detect Option held and ignore the keystroke entirely.
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
						{
							label: 'Quit Maestro',
							accelerator: 'Cmd+Q',
							click: (_item, _window, event) => {
								if (event?.altKey) {
									logger.info(
										'Ignoring Opt+Cmd+Q to prevent accidental quit (too close to Opt+Q for Maestro Cue)',
										'Menu'
									);
									return;
								}
								app.quit();
							},
						},
					],
				},
				{
					// Custom Edit menu — equivalent to `role: 'editMenu'` minus
					// `undo` / `redo`. Those built-in roles register Cmd+Z /
					// Cmd+Shift+Z as NSMenu-level accelerators that intercept the
					// keystroke at the OS layer before the renderer can see it
					// (same trap as `role: 'close'` eating Cmd+W — see the note
					// above the appMenu block). Removing them frees Cmd+Z for the
					// image annotator's stroke-undo handler.
					//
					// Side effect: Chromium in Electron relies on the Edit > Undo
					// menu role to deliver Cmd+Z to focused textareas/inputs on
					// macOS, so without it native text-field undo silently does
					// nothing. The renderer-side `useTextEditorUndo` hook
					// (src/renderer/hooks/keyboard/useTextEditorUndo.ts) restores
					// that behavior by calling `document.execCommand('undo')` on
					// text targets. The annotator's own Cmd+Z listener bails out
					// for text targets, so the two paths don't conflict.
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
			];
			Menu.setApplicationMenu(Menu.buildFromTemplate(template));
		} else {
			// On Windows/Linux, hide the menu bar entirely (Maestro uses its own UI)
			Menu.setApplicationMenu(null);
		}

		// Create main window
		logger.info('Creating main window', 'Startup');
		createWindow();

		// Wire the global "summon Maestro" hotkey. Register the saved binding (if
		// any) and re-register live when the setting changes from any source
		// (settings UI, CLI, external file edit).
		initGlobalHotkey(() => mainWindow);
		const initialHotkey = store.get('globalShowHotkey', []) as string[];
		if (Array.isArray(initialHotkey) && initialHotkey.length > 0) {
			const ok = setGlobalShowHotkey(initialHotkey);
			if (!ok && mainWindow && isWebContentsAvailable(mainWindow)) {
				mainWindow.webContents.send('globalHotkey:registrationFailed', initialHotkey);
			}
		}
		store.onDidChange('globalShowHotkey', (value) => {
			const keys = Array.isArray(value) ? (value as string[]) : [];
			const ok = setGlobalShowHotkey(keys);
			if (!ok && mainWindow && isWebContentsAvailable(mainWindow)) {
				mainWindow.webContents.send('globalHotkey:registrationFailed', keys);
			}
		});
		// Electron auto-unregisters globalShortcuts on quit, but be explicit so the
		// behavior survives any future change to that policy.
		app.on('will-quit', disposeGlobalHotkey);

		// Flush any deep link URL that arrived before the window was ready (cold start)
		flushPendingDeepLink(() => mainWindow);

		// Note: History file watching is handled by HistoryManager.startWatching() above
		// which uses the new per-session file format in the history/ directory

		// Start CLI activity watcher (Phase 4 refactoring)
		cliWatcher.start();

		// CLI server was already started + discovery file published earlier in
		// startup (see ensureCliServer call right after agentDetector init).
		// Republish here too, since callbacks like getMainWindow are now wired
		// to a real window and a stale file from a previous run shouldn't outlive
		// our actual port/token.
		await ensureCliServer(cliServerDeps);

		// Start settings file watcher for external changes (e.g., maestro-cli settings set)
		settingsWatcher.start();

		app.on('activate', () => {
			if (BrowserWindow.getAllWindows().length === 0) {
				createWindow();
			}
		});

		// Listen for system resume (after sleep/suspend) and notify renderer
		// This allows the renderer to refresh settings that may have been reset
		powerMonitor.on('resume', () => {
			logger.info('System resumed from sleep/suspend', 'PowerMonitor');
			if (isWebContentsAvailable(mainWindow)) {
				mainWindow.webContents.send('app:systemResume');
			}
			// Replay missed time-based Cue triggers and kick GitHub pollers so a
			// laptop that's been asleep doesn't sit on stale subscriptions until
			// the next scheduled tick. Idempotent against multiple resume events
			// from the same wake (lid + display + monitor).
			if (cueEngine?.isEnabled()) {
				try {
					cueEngine.reconcileAfterWake();
				} catch (err) {
					logger.error(`Cue reconcileAfterWake failed: ${err}`, 'PowerMonitor');
					void captureException(err, { operation: 'cue.reconcileAfterWake' });
				}
			}
		});
	})
	.catch(async (err) => {
		// Without this, an unhandled rejection anywhere in the long startup chain
		// silently aborts initialization — historically the cause of the missing
		// CLI discovery file. Log loudly and report to Sentry so we can actually
		// diagnose future regressions instead of guessing.
		logger.error(`Fatal error during app startup: ${err}`, 'Startup');
		await captureException(err instanceof Error ? err : new Error(String(err)), {
			operation: 'startup:whenReady',
		});
	});

app.on('window-all-closed', () => {
	// This fires only when every window (primary + any secondary windows) is
	// closed, so the primary is necessarily gone by now. Closing a single
	// secondary window while the primary stays open does NOT fire this event, so
	// secondary windows never trigger a quit here (the primary's own `closed`
	// handler covers the "primary gone, secondaries still open" case above).
	if (!isMacOS()) {
		app.quit();
	} else {
		// On macOS the app stays alive after all windows close (dock click reopens).
		// Kill all managed PTY/child processes now so they don't leak — session
		// restoration will re-spawn fresh PTYs when the window is reopened.
		processManager?.killAll();
	}
});

// Create and setup quit handler with dependency injection (Phase 4 refactoring)
quitHandler = createQuitHandler({
	getMainWindow: () => mainWindow,
	getProcessManager: () => processManager,
	getWebServer: () => webServer,
	getHistoryManager,
	tunnelManager,
	getActiveGroomingSessionCount,
	cleanupAllGroomingSessions,
	closeStatsDB,
	stopCliWatcher: () => {
		cliWatcher.stop();
		// Tear down the discovery-file watchdog so it doesn't try to rewrite
		// the file after the quit handler has just deleted it.
		stopCliDiscoveryWatchdog();
		// Stop Cue engine on app quit
		if (cueEngine?.isEnabled()) {
			cueEngine.stop();
		}
		// Tear down the background quota refresh timers.
		usageRefreshScheduler?.stop();
	},
	stopSettingsWatcher: () => settingsWatcher.stop(),
	powerManager,
	stopSessionCleanup,
	getPersistedSessions: () => sessionsStore.get('sessions', []) as Array<Record<string, unknown>>,
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
		settingsStore: store,
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
	registerHistoryHandlers({
		safeSend,
		getMaxEntries: () => store.get('maxLogBuffer', 5000) as number,
		getSshRemoteById,
		getSessionById: (id: string) => {
			const sessions = (sessionsStore.get('sessions', []) as Array<Record<string, unknown>>).filter(
				(s) => typeof s === 'object' && s !== null
			);
			return sessions.find((s) => s.id === id);
		},
	});

	// Director's Notes - unified history + synopsis generation
	registerDirectorNotesHandlers({
		getProcessManager: () => processManager,
		getAgentDetector: () => agentDetector,
		agentConfigsStore,
	});

	// Cue - event-driven automation engine
	registerCueHandlers({
		getCueEngine: () => cueEngine,
	});

	// Cue Backup - snapshot / restore .maestro/cue.yaml + prompts (Cue modal Backup tab)
	registerCueBackupHandlers({
		sessionsStore,
	});

	// Agent management operations - extracted to src/main/ipc/handlers/agents.ts
	registerAgentsHandlers({
		getAgentDetector: () => agentDetector,
		agentConfigsStore,
		settingsStore: store,
		sessionsStore,
	});

	// Process management operations - extracted to src/main/ipc/handlers/process.ts
	registerProcessHandlers({
		getProcessManager: () => processManager,
		getAgentDetector: () => agentDetector,
		agentConfigsStore,
		settingsStore: store,
		getMainWindow: () => mainWindow,
		safeSend,
		sessionsStore,
		interactiveReplayController: interactiveReplayController ?? undefined,
		getCueProcesses: () => {
			// Always query the executor's active process map — processes may still be
			// running even if the engine has been disabled (in-flight runs complete
			// independently of engine state).
			const processList = getCueProcessList();
			if (processList.length === 0) return [];
			const activeRuns = cueEngine?.getActiveRuns() ?? [];
			// Merge PID/command data from executor with metadata from run manager
			return processList.map((proc) => {
				const run = activeRuns.find((r) => r.runId === proc.runId);
				return {
					...proc,
					sessionName: run?.sessionName ?? '',
					subscriptionName: run?.subscriptionName ?? '',
					eventType: run?.event.type ?? '',
				};
			});
		},
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

	// Register BMAD handlers (no dependencies needed)
	registerBmadHandlers();

	// Register Core Prompts handlers (no dependencies needed)
	registerPromptsHandlers();

	// Register project Memory handlers (Claude Code per-project memory viewer)
	registerMemoryHandlers();

	// Register multi-window handlers (windows:* channel surface). Registered here
	// because the running app wires handlers through setupIpcHandlers(), not
	// registerAllHandlers(). The registry and window manager are module-scope
	// instances; lazy getters resolve the live instance at call time.
	registerWindowsHandlers({
		getWindowRegistry: () => windowRegistry,
		getWindowManager: () => windowManager,
	});

	// Register Context Merge handlers for session context transfer and grooming
	registerContextHandlers({
		getMainWindow: () => mainWindow,
		getProcessManager: () => processManager,
		getAgentDetector: () => agentDetector,
		agentConfigsStore,
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

	// Register Cue Stats handlers for the Cue Dashboard aggregation query.
	// Pass `getCueEngine` so the handler can fall back to the live cue config
	// when persisted `pipeline_id` is null (legacy events / events recorded
	// before lineage tracking was enabled).
	registerCueStatsHandlers({
		settingsStore: store,
		getCueEngine: () => cueEngine,
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
				cwd: s.cwd || s.fullPath || os.homedir(),
				customArgs: s.customArgs,
				customEnvVars: s.customEnvVars,
				customModel: s.customModel,
				// Claude token-source selection, so group chat participants honor
				// the same maestro-p TUI / API / dynamic choice as their agent.
				enableMaestroP: s.enableMaestroP,
				maestroPMode: s.maestroPMode,
				maestroPPath: s.maestroPPath,
				sshRemoteName,
				// Pass full SSH config for remote execution support
				sshRemoteConfig: s.sessionSshRemoteConfig,
				autoRunFolderPath: s.autoRunFolderPath,
				worktreeBasePath: s.worktreeConfig?.basePath,
			};
		});
	});

	// Set up callback for group chat router to lookup custom env vars for agents
	setGetCustomEnvVarsCallback(getCustomEnvVarsForAgent);
	setGetAgentConfigCallback(getAgentConfigForAgent);

	// Set up callback for group chat router to get moderator conductor profile
	setGetModeratorSettingsCallback(() => ({
		conductorProfile: (store.get('conductorProfile', '') as string) || '',
	}));

	// Set up SSH store for group chat SSH remote execution support
	setSshStore(createSshRemoteStoreAdapter(store));

	// Set up callback for group chat to get custom shell path (for Windows PowerShell preference)
	// This is used by both group-chat-router.ts and group-chat-agent.ts via the shared config module
	const getCustomShellPathFn = () => store.get('customShellPath', '') as string | undefined;
	setGetCustomShellPathCallback(getCustomShellPathFn);

	// Setup logger event forwarding to renderer
	setupLoggerEventForwarding(() => mainWindow);

	// Register filesystem handlers (extracted to handlers/filesystem.ts)
	registerFilesystemHandlers();

	// System operations (dialog, fonts, shells, tunnel, devtools, updates, logger)
	// extracted to src/main/ipc/handlers/system.ts

	// Claude Code sessions - extracted to src/main/ipc/handlers/claude.ts

	// Agent Error Handling API - extracted to src/main/ipc/handlers/agent-error.ts
	registerAgentErrorHandlers();

	// Register notification handlers (extracted to handlers/notifications.ts)
	registerNotificationsHandlers({ getMainWindow: () => mainWindow });

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
		sessionsStore,
		settingsStore: store,
	});

	// Register tab naming handlers for automatic tab naming
	registerTabNamingHandlers({
		getProcessManager: () => processManager,
		getAgentDetector: () => agentDetector,
		agentConfigsStore,
		settingsStore: store,
	});

	// Register WakaTime handlers (CLI check, API key validation)
	registerWakatimeHandlers(wakatimeManager);

	// Register Maestro CLI handlers (status check + install/update)
	registerMaestroCliHandlers(maestroCliManager);

	// Register feedback handlers (gh auth + feedback submission)
	registerFeedbackHandlers({
		getProcessManager: () => processManager,
		debugPackageDeps: {
			getAgentDetector: () => agentDetector,
			getProcessManager: () => processManager,
			getWebServer: () => webServer,
			settingsStore: store,
			sessionsStore,
			groupsStore,
			bootstrapStore,
		},
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
				clearActiveParticipantTaskSession,
				clearModeratorResponseTimeout,
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
			getCueEngine: () => cueEngine,
			isCueEnabled: () => {
				const ef = store.get('encoreFeatures', {}) as Record<string, boolean>;
				return !!ef.maestroCue;
			},
			getSshRemoteByName: (name: string) => {
				const remotes = store.get('sshRemotes', []);
				return remotes.find((r) => r.name === name) ?? null;
			},
			getAgentContextWindow: (agentId: string) => {
				// Prefer a runtime-discovered context window from the capability
				// snapshot if one was probed. Falls back to the static table and
				// finally to the agent definition's configOption default.
				const snapshot = capabilitySnapshots.get(agentId);
				if (typeof snapshot?.contextWindow === 'number' && snapshot.contextWindow > 0) {
					return snapshot.contextWindow;
				}
				const def = getAgentDefinition(agentId);
				const contextOpt = def?.configOptions?.find((o) => o.key === 'contextWindow');
				const fallbackDefault =
					typeof contextOpt?.default === 'number' ? contextOpt.default : FALLBACK_CONTEXT_WINDOW;
				return DEFAULT_CONTEXT_WINDOWS[agentId as AgentId] ?? fallbackDefault;
			},
		});

		// WakaTime heartbeat listener (query-complete → heartbeat, exit → cleanup)
		setupWakaTimeListener(processManager, wakatimeManager, store);
	}
}
