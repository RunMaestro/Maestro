import {
	app,
	BrowserWindow,
	Menu,
	powerMonitor,
	protocol,
	safeStorage,
	shell,
	ipcMain,
	type OpenExternalOptions,
	type IpcMainInvokeEvent,
} from 'electron';
import { isMacOS } from '../shared/platformDetection';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import * as https from 'https';
import type { LookupFunction } from 'net';
import WebSocket from 'ws';
import { readFile } from 'fs/promises';
// Sentry is imported dynamically below to avoid module-load-time access to electron.app
// which causes "Cannot read properties of undefined (reading 'getAppPath')" errors
import { ProcessManager } from './process-manager';
import { WebServer } from './web-server';
import { AgentDetector } from './agents';
import { createAgentConfigLookup } from './agents/agent-config-lookup';
import { shouldDropSentryEvent } from '../shared/sentryFilters';
import {
	initGlobalHotkey,
	setGlobalShowHotkey,
	disposeGlobalHotkey,
} from './global-hotkey-manager';
import { CueEngine } from './cue/cue-engine';
import { installTtsrRuntime, type TtsrRuntime } from './ttsr';
import {
	DEFAULT_TTSR_CONTEXT_MODE,
	isTtsrContextMode,
	type TtsrContextMode,
} from '../shared/ttsr-types';
import { createCueSupervisorHooks } from './cue/cue-first-party';
import { PianolaSupervisor } from './pianola/pianola-supervisor';
import { PianolaRelearnScheduler } from './pianola/pianola-relearn-scheduler';
import { createPianolaLifecycle } from './pianola/pianola-lifecycle';
import { execFile } from 'child_process';
import { PluginManager } from './plugins/plugin-manager';
import { resolveTrustedKeys } from '../shared/plugins/publisher-keys';
import { seedBundledPlugins } from './plugins/bundled-plugins';
import { SpawnBinaryRegistry } from './plugins/spawn-binary-registry';
import { transcriptReadEgressConflict } from '../shared/plugins/capability-policy';
import { evaluateScheduledDispatch } from '../shared/plugins/plugin-dispatch-gate';
import { PermissionBroker } from './plugins/permission-broker';
import { PluginSandboxHost } from './plugins/plugin-sandbox-host';
import { PluginBackgroundSupervisor } from './plugins/plugin-background-supervisor';
import { PluginGroupingRegistry } from './plugins/plugin-grouping-registry';
import { setActivePluginManager } from './plugins/plugin-manager-singleton';
import { PluginSchedulerHost } from './plugins/plugin-scheduler-host';
import {
	buildHostCallHandlers,
	purgePluginData,
	type PluginSessionMetadata,
	type PluginTabMetadata,
} from './plugins/plugin-host-handlers';
import { createCadenzaDelivery, registerCadenzaIpcHandlers } from './cadenza-bridge';
import { createPluginHostViewBridge } from './plugin-host-view-bridge';
import { ActionGuard } from './plugins/action-guard';
import { PluginKvStore } from './plugins/plugin-kv-store';
import { PluginEventBusImpl } from './plugins/plugin-event-bus';
import { createEgressGuard } from './plugins/net-egress-guard';
// [UiCommandeer] WS-ui-command host bridge (see runUiCommand wiring below).
import { createRunUiCommand } from './plugins/run-ui-command';
import {
	isPermitted,
	isPermittedUnattended,
	describeCapability,
	capabilityRisk,
	isPluginCapability,
	isHighRiskActCapability,
	describeUnattendedConsent,
	isValidAllowlistMember,
} from '../shared/plugins/permissions';
import {
	createAuthorizationStore,
	createKeyringAnchor,
	shouldDisablePluginForVerifyResult,
	type AuthorizationStore,
} from './plugins/authorization-ledger';
import {
	FirstPartyPluginBridge,
	createFirstPartyGrantMinter,
	setFirstPartyBridges,
	type FirstPartySupervisorHooks,
} from './plugins/first-party-bridge';
import { FIRST_PARTY_PLUGINS, type FirstPartyEncoreFlag } from '../shared/plugins/first-party';
import { pluginIdentity } from './plugins/plugin-identity';
import { PLUGIN_ID_PATTERN } from '../shared/plugins/plugin-manifest';
import { ConsentNonceRegistry, ConsentMinter } from './plugins/consent-minter';
import {
	openConsentWindow,
	consentSurfacePaths,
	type ConsentOffer,
	type OpenedConsentWindow,
} from './plugins/consent-window';
import { configureCueTelemetry } from './cue/cue-telemetry';
import { executeCuePrompt, recordCueHistoryEntry, stopCueRun } from './cue/cue-executor';
import { executeCueShell, stopCueShellRun } from './cue/cue-shell-executor';
import { executeCueCli, stopCueCliRun } from './cue/cue-cli-executor';
import { executeCueNotify } from './cue/cue-notify-executor';
import { getAgentDisplayName } from '../shared/agentMetadata';
import { logger } from './utils/logger';
import { tunnelManager } from './tunnel-manager';
import { powerManager } from './power-manager';
import { getHistoryManager } from './history-manager';
import { initDispatchCallbacks } from './dispatch-callbacks';
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
} from './stores';
import { runSettingsMigrations } from './stores/migrations';
import {
	ensureCliServer,
	startCliDiscoveryWatchdog,
	stopCliDiscoveryWatchdog,
	cleanupAllGroomingSessions,
	getActiveGroomingSessionCount,
} from './ipc/handlers';
import { setupIpcHandlers } from './ipc/bootstrap';
import { stopCoworkingBridge } from './coworking/coworking-bridge';
import { initializeStatsDB, closeStatsDB } from './stats';
import { createSshRemoteStoreAdapter } from './utils/ssh-remote-resolver';
import { stopSessionCleanup } from './group-chat/group-chat-moderator';
import { initializePrompts, getPrompt, savePrompt } from './prompt-manager';
import { captureException } from './utils/sentry';
import { resolveToFilePath, configureImageStore } from './storage/session-image-store';
import { CONCERTO_HTML_SCHEME } from '../shared/concerto-html';
import { createConcertoHtmlResponse } from './concerto-html';
import { MEDIA_SCHEME } from '../shared/mediaTypes';
import { handleMediaStreamRequest } from './media/media-stream';
import { DEMO_MODE, DEMO_DATA_PATH } from './constants';
// initAutoUpdater is now used by window-manager.ts (Phase 4 refactoring)
import { checkWslEnvironment } from './utils/wslDetector';
import { setupDeepLinkHandling, flushPendingDeepLink } from './deep-links';
// Extracted modules (Phase 1 refactoring)
import { wireProcessListeners } from './process-listeners-wiring';
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
	closeCadenzaHudWindow,
	type QuitHandler,
} from './app-lifecycle';
// Multi-window registry (single source of truth for window<->session ownership)
import { WindowRegistry } from './window-registry';
// Multi-window startup restore: turn the persisted MultiWindowState back into
// window-creation specs (pruning agents that no longer exist).
import { planWindowRestore, pickFocusWindowSpec } from './window-state-persistence';
import type { WindowState as SharedWindowState } from '../shared/window-types';
import { setupAgentRunCapture } from './agent-run/setup-capture-listener';
import { setAgentRunSink } from './agent-run/broadcast';
import { startAgentRunStoreWatcher } from './agent-run/store-watcher';
import { setupAgentRunRecovery } from './agent-run/setup-recovery';
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
// Serves pasted conversation images relocated out of maestro-sessions.json by
// the session image store (see src/main/storage/session-image-store.ts). Refs
// look like `maestro-image://store/<sha256>.<ext>` and are loaded directly by
// `<img src>` in the transcript, so the image bytes never re-enter the JSON
// blob or the IPC payload. Registered in dev AND prod so images render in both.
const IMAGE_SCHEME = 'maestro-image';
{
	const privilegedSchemes: Electron.CustomScheme[] = [
		{
			scheme: IMAGE_SCHEME,
			privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
		},
		{
			scheme: CONCERTO_HTML_SCHEME,
			privileges: { standard: true, secure: true },
		},
		// Streams local audio/video into <audio>/<video> in the file preview.
		// `stream: true` keeps range responses flowing chunk-by-chunk instead of
		// buffering, which is what makes seeking a multi-GB video cheap.
		{
			scheme: MEDIA_SCHEME,
			privileges: {
				standard: true,
				secure: true,
				supportFetchAPI: true,
				corsEnabled: true,
				stream: true,
			},
		},
	];
	if (!isDevelopment) {
		privilegedSchemes.push({
			scheme: RENDERER_SCHEME,
			privileges: {
				standard: true,
				secure: true,
				supportFetchAPI: true,
				corsEnabled: true,
				stream: true,
			},
		});
	}
	protocol.registerSchemesAsPrivileged(privilegedSchemes);
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

// Point the session image store at the sync path so pasted conversation images
// live alongside the sessions file (in <syncPath>/session-images/) rather than
// inline as base64 inside maestro-sessions.json.
configureImageStore(syncPath);

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

// Run one-shot settings-store migrations (idempotent - each migration owns
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
				// PERF: drop console breadcrumbs. Sentry's default Breadcrumbs
				// integration wraps every console.* to capture a breadcrumb, and a
				// field trace showed that wrapper (addConsoleBreadcrumb) as the single
				// largest JS CPU consumer. Our logger console.*s on every info+ entry,
				// so this taxed every log line. Console output is still retained via the
				// logger, file logs, and the LogViewer; crash reporting is unaffected.
				beforeBreadcrumb(breadcrumb) {
					return breadcrumb.category === 'console' ? null : breadcrumb;
				},
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

const { getAgentConfigForAgent, getCustomEnvVarsForAgent } =
	createAgentConfigLookup(agentConfigsStore);

// Note: History storage is now handled by HistoryManager which uses per-session files
// in the history/ directory. The legacy maestro-history.json file is migrated automatically.
// See src/main/history-manager.ts for details.

let mainWindow: BrowserWindow | null = null;
let processManager: ProcessManager | null = null;
let webServer: WebServer | null = null;
let agentDetector: AgentDetector | null = null;
let cueEngine: CueEngine | null = null;
/** Time-Traveling Stream Rules runtime; null until the process manager exists. */
let ttsrRuntime: TtsrRuntime | null = null;
let pianolaSupervisor: PianolaSupervisor | null = null;
let pianolaRelearnScheduler: PianolaRelearnScheduler | null = null;
let pluginManager: PluginManager | null = null;
let pluginScheduler: PluginSchedulerHost | null = null;
let pluginSandboxHost: PluginSandboxHost | null = null;
let pluginGroupingRegistry: PluginGroupingRegistry | null = null;
let pluginBackgroundSupervisor: PluginBackgroundSupervisor | null = null;
let pluginAuthStore: AuthorizationStore | null = null;
let pluginEventBus: PluginEventBusImpl | null = null;
// Set by registerPersistenceHandlers (in setupIpcHandlers). Lets the plugin
// focus verbs record into the persistence layer's `session.activated` dedupe so
// the two emit paths never desync. Null before IPC setup / when unavailable.
let noteSessionActivatedInPersistence: ((sessionId: string) => void) | null = null;
let usageRefreshScheduler: UsageRefreshScheduler | null = null;
let interactiveReplayController: InteractiveReplayController<ProcessSpawnConfig> | null = null;

// Create safeSend with dependency injection (Phase 2 refactoring).
// Broadcasts to EVERY open window, not just the primary one - see the
// MULTI-WINDOW INVARIANT in safe-send.ts. Renderers filter agent-scoped
// process:* events to the agents they own.
const safeSend = createSafeSend(() => BrowserWindow.getAllWindows());

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
	// Broadcast to EVERY open window so a settings change (from maestro-cli or
	// another Maestro window) reloads in all of them - not just the main window.
	getBroadcastWindows: () => BrowserWindow.getAllWindows(),
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

// Shared by the main window and the cadenza HUD window (which reuses the same
// preload + renderer bundle, loaded with `?cadenzaHud`).
const preloadPath = path.join(__dirname, 'preload.js');
const rendererProductionUrl = `${RENDERER_SCHEME}://app/index.html`;

// Create window manager with dependency injection (Phase 4 refactoring)
const windowManager = createWindowManager({
	windowStateStore,
	isDevelopment,
	preloadPath,
	rendererProductionUrl,
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

// Deps shared by every cadenza HUD window operation (the HUD reuses the main
// preload + renderer bundle, loaded with `?cadenzaHud`).
const cadenzaHudDeps = {
	isDevelopment,
	preloadPath,
	rendererProductionUrl,
	devServerUrl,
	windowRegistry,
};

// See src/main/cadenza-bridge/ and src/main/plugin-host-view-bridge/ for what
// each of these does (Phase 5 refactoring).
const { deliverCadenza } = createCadenzaDelivery({
	getMainWindow: () => mainWindow,
	sessionsStore,
	settingsStore: store,
	cadenzaHudDeps,
});
const { arePluginHostViewsEnabled, pluginHostViews } = createPluginHostViewBridge({
	getMainWindow: () => mainWindow,
	getPluginManager: () => pluginManager,
	settingsStore: store,
	deliverCadenza,
});
registerCadenzaIpcHandlers({ getMainWindow: () => mainWindow, settingsStore: store });

// Disabling either side of the bridge purges any live views immediately. If both
// are enabled after a flag change, re-sync static data without asking a renderer
// read path to refresh plugin discovery.
store.onDidChange('encoreFeatures', (encoreFeatures) => {
	if (encoreFeatures?.concerto !== true) closeCadenzaHudWindow();
	if (encoreFeatures?.plugins !== true) {
		pluginSandboxHost?.stopAll();
		pluginGroupingRegistry?.clearAll();
	}
	if (!arePluginHostViewsEnabled()) {
		pluginHostViews.purgeAll();
		return;
	}
	pluginHostViews.sync();
});

// ── TTSR gate snapshot ──
// These four values are read from the stdout hot path: `TtsrRuntime.observe`
// consults the gate for EVERY parsed event of EVERY agent, and the enabled path
// re-reads the rest several times per event. electron-store (conf 10.x) re-reads
// and re-parses the whole settings JSON file on every `get`, so reading them live
// would mean synchronous disk I/O per token. Snapshot them here and refresh on
// change, so the deps handed to `installTtsrRuntime` only ever read memory and a
// toggle still takes effect without an app restart.
let ttsrEnabledSetting = store.get('ttsrEnabled', false) === true;
let ttsrEncoreFlag = (store.get('encoreFeatures', {}) as Record<string, boolean>).ttsr === true;
let ttsrDisabledRuleNames = readTtsrDisabledRules(store.get('ttsrDisabledRules', []));
let ttsrContextModeSetting: TtsrContextMode = readTtsrContextMode(
	store.get('ttsrContextMode', DEFAULT_TTSR_CONTEXT_MODE)
);

function readTtsrContextMode(value: unknown): TtsrContextMode {
	return isTtsrContextMode(value) ? value : DEFAULT_TTSR_CONTEXT_MODE;
}

function readTtsrDisabledRules(value: unknown): string[] {
	return Array.isArray(value) ? (value as string[]) : [];
}

store.onDidChange('ttsrEnabled', (value) => {
	ttsrEnabledSetting = value === true;
});
store.onDidChange('encoreFeatures', (value) => {
	ttsrEncoreFlag = (value as Record<string, boolean> | undefined)?.ttsr === true;
});
store.onDidChange('ttsrDisabledRules', (value) => {
	ttsrDisabledRuleNames = readTtsrDisabledRules(value);
});
store.onDidChange('ttsrContextMode', (value) => {
	ttsrContextModeSetting = readTtsrContextMode(value);
});

// Create web server factory with dependency injection (Phase 2 refactoring)
const createWebServer = createWebServerFactory({
	settingsStore: store,
	sessionsStore,
	groupsStore,
	getMainWindow: () => mainWindow,
	deliverCadenza,
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
function createWindow(options?: { sessionIds?: string[]; bounds?: Partial<SharedWindowState> }) {
	mainWindow = windowManager.createWindow(options);
	// The plugin registry may have discovered static views before the renderer
	// existed. Re-forward host-owned data after every renderer load/reload.
	mainWindow.webContents.on('did-finish-load', () => pluginHostViews.replay());
	// Handle closed event to clear the reference
	mainWindow.on('closed', () => {
		mainWindow = null;
		// The cadenza HUD isn't an OS child of the main window (so card clicks
		// can't steal focus), so tear it down explicitly when Maestro closes.
		// It deliberately stays visible while Maestro is merely minimized - the
		// whole point of a HUD is to watch things while working in other apps.
		closeCadenzaHudWindow();

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

/**
 * Restore the saved multi-window layout on startup.
 *
 * Reads the persisted `MultiWindowState`, drops any owned agents that no longer
 * exist, then recreates each saved window with its bounds and agent assignments
 * through the window manager - the primary via {@link createWindow} (which
 * anchors `mainWindow`) and the rest as secondary windows. Off-screen bounds are
 * already guarded inside the window manager's `createBrowserWindow`.
 *
 * When there is no saved layout (a fresh install seeds an empty
 * `MultiWindowState`, and a pre-migration store has none at all) it falls back
 * to a single primary window using the legacy single-window bounds - identical
 * to the previous startup behavior.
 */
function restoreWindows() {
	// The set of agents that still exist, so a window never tries to restore a
	// tab strip for an agent the user has since deleted.
	const existingAgentIds = new Set<string>();
	for (const session of sessionsStore.get('sessions', []) as Array<{ id?: unknown }>) {
		if (typeof session?.id === 'string') existingAgentIds.add(session.id);
	}

	const specs = planWindowRestore(windowStateStore.get('multiWindow'), existingAgentIds);
	if (specs.length === 0) {
		// No saved multi-window layout - single primary window (backward compatible).
		createWindow();
		return;
	}

	logger.info(`Restoring ${specs.length} window(s) from saved layout`, 'Startup');

	// The globally-active agent (Left Bar highlight) should be the window the user
	// lands on. Windows are created primary-first, so without this the last-created
	// secondary keeps OS focus and startup opens onto a window that isn't showing
	// the active agent. Focus the window that owns the active agent (default the
	// primary) once all windows exist, in creation order so `created[i]` maps to
	// `specs[i]`.
	const activeSessionId = sessionsStore.get('activeSessionId') as string | undefined;
	const focusSpec = pickFocusWindowSpec(specs, activeSessionId);
	const created: BrowserWindow[] = [];
	for (const spec of specs) {
		if (spec.isPrimary) {
			createWindow({ sessionIds: spec.sessionIds, bounds: spec.bounds });
			// createWindow anchors the primary on the module-level mainWindow.
			if (mainWindow) created.push(mainWindow);
		} else {
			created.push(windowManager.createSecondaryWindow(spec.sessionIds, spec.bounds));
		}
	}

	const focusWindow = focusSpec ? created[specs.indexOf(focusSpec)] : undefined;
	if (focusWindow && !focusWindow.isDestroyed()) {
		focusWindow.focus();
	}
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
		// Serve agent-authored Concerto mockups as real documents with their own
		// CSP. A srcdoc frame would inherit Maestro's renderer CSP and block the
		// inline scripts that make mockups interactive.
		protocol.handle(CONCERTO_HTML_SCHEME, (request) => createConcertoHtmlResponse(request.url));

		// Serve pasted conversation images relocated out of the sessions JSON by
		// the session image store. `<img src="maestro-image://store/<sha>.<ext>">`
		// resolves here to a file on disk - the bytes never live in the JSON blob
		// or the IPC payload. Registered in dev AND prod. Traversal is guarded by
		// resolveToFilePath (only lowercase-hex sha256 + known image ext resolve).
		protocol.handle(IMAGE_SCHEME, async (request) => {
			const filePath = resolveToFilePath(request.url);
			if (!filePath) return new Response('bad request', { status: 400 });
			try {
				const data = await readFile(filePath);
				const ext = path.extname(filePath).toLowerCase();
				const contentType =
					ext === '.svg'
						? 'image/svg+xml'
						: ext === '.jpg' || ext === '.jpeg'
							? 'image/jpeg'
							: `image/${ext.slice(1)}`;
				return new Response(new Uint8Array(data), {
					status: 200,
					headers: { 'content-type': contentType, 'cache-control': 'max-age=31536000, immutable' },
				});
			} catch (err) {
				if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
					return new Response('not found', { status: 404 });
				}
				throw err;
			}
		});

		// Stream local audio/video files into the file preview's <audio>/<video>
		// element with HTTP range support, so scrubbing a large recording does not
		// pull it through IPC or into the renderer heap. Registered on the default
		// session only, so browser tab webviews (own partitions) cannot reach it.
		protocol.handle(MEDIA_SCHEME, handleMediaStreamRequest);

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
					// Only swallow "file not found" - surface every other fs error
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
		// Gate the OpenCode SDK-serve path behind the default-off
		// `encoreFeatures.opencodeServer` plugin. Read live on every spawn so the
		// Extensions toggle takes effect without an app restart.
		processManager = new ProcessManager(
			() => (store.get('encoreFeatures', {}) as Record<string, boolean>).opencodeServer === true
		);
		// Time-Traveling Stream Rules: watch every agent's normalized output
		// stream and match `.maestro/rules/*.md`. Gated live on the `ttsr` Encore
		// flag AND the `ttsrEnabled` setting, so it is a no-op while off.
		ttsrRuntime = installTtsrRuntime(processManager, {
			// In-memory reads only (see the TTSR gate snapshot above): these run on
			// the stdout hot path, so a `store.get` here would be a disk read per
			// parsed event.
			isGloballyEnabled: () => ttsrEnabledSetting && ttsrEncoreFlag,
			getDisabledRules: () => ttsrDisabledRuleNames,
			// Fallback teardown mode for projects whose `.maestro/ttsr.yaml` does
			// not name one; a project that does still wins.
			getContextMode: () => ttsrContextModeSetting,
			safeSend,
		});
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
				safeSend('process:claude-mode-resolved', sessionId, resolution);
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
		// without a discovery file - the symptom that previously forced users to
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

		// dispatch --notify-on-complete. Wired here because it needs the same
		// web-server handle the CLI round-trips through: the callback is
		// delivered as a real turn in the caller's live tab via the renderer's
		// execution queue, not as a fresh headless process.
		initDispatchCallbacks({
			enqueue: async (agentId, prompt, tabId) => {
				const server = webServer;
				if (!server) return { success: false, error: 'Desktop web server unavailable' };
				const result = await server.enqueueCommandFromMain(agentId, prompt, tabId);
				return {
					success: result.success === true,
					...(result.error ? { error: result.error } : {}),
				};
			},
			getTargetOutput: async (agentId, since) => {
				// Best-effort: the newest history entry the target wrote after the
				// dispatch was armed. History is per agent (entries carry no tabId),
				// so the timestamp floor is the correlation we have - the tab handle
				// in the callback prompt is how the caller reads the real transcript.
				const entries = await getHistoryManager().getEntries(agentId);
				const candidate = entries
					.filter((entry) => entry.timestamp >= since)
					.sort((a, b) => b.timestamp - a.timestamp)[0];
				return candidate?.fullResponse || candidate?.summary || undefined;
			},
			logger: {
				info: (msg, context) => logger.info(msg, context ?? 'DispatchCallback'),
				warn: (msg, context) => logger.warn(msg, context ?? 'DispatchCallback'),
			},
		});

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
		// are non-fatal - the spawner's resolver tolerates a null snapshot by
		// defaulting to interactive, and the next sampler refresh will repopulate.
		const startupUsageSampling = runStartupUsageSampling({
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
		// L5 usage-stats lift: the sampling loop is the feature's supervised
		// `stats.sampler` background service - don't arm it when the user has
		// explicitly disabled the Usage & Stats tile. `!== false` (not `=== true`)
		// mirrors the renderer default (usageStats defaults ON and the merged
		// flag map may never have been persisted main-side).
		if ((store.get('encoreFeatures', {}) as Record<string, boolean>).usageStats !== false) {
			usageRefreshScheduler.start();
		}

		// Warm any provider the strict startup pass left cold (no auto-refresh
		// interval picked, no eligible recent maestro-p session, Codex not sampled
		// on boot at all). Runs after that pass settles so the two can't spawn
		// `maestro-p --status` for the same account at once, and no-ops when the
		// snapshots already hold renderable data. This is what makes the Usage
		// Dashboard's Anthropic / OpenAI tabs show up on the first open instead of
		// only after a close-and-reopen.
		void startupUsageSampling
			.then(() => usageRefreshScheduler?.warmUp())
			.catch((err: unknown) => {
				logger.warn('Provider quota warm-up failed', 'Startup', {
					error: err instanceof Error ? err.message : String(err),
				});
			});

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
				// spawning anything - handled before command/prompt so the spawn config,
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
				// AI prompt - skip agent path resolution and SSH wrapping.
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
				// Push activity updates to renderer (and web-desktop bridge clients)
				if (data) {
					safeSend('cue:activityUpdate', data);
				}
			},
			onPreventSleep: (reason) => powerManager.addBlockReason(reason),
			onAllowSleep: (reason) => powerManager.removeBlockReason(reason),
			// Phase 01 - gate cue_events stats lineage writes on the
			// `encoreFeatures.usageStats` flag. Read on every record so toggling
			// the Encore flag at runtime takes effect without an app restart.
			getUsageStatsEnabled: () => {
				const ef = store.get('encoreFeatures', {}) as Record<string, boolean>;
				return ef.usageStats === true;
			},
			// Surface `cue.fired` to subscribed plugins (events:subscribe). Type
			// only - NEVER prompt text. Null-safe; no-op when plugins are disabled.
			onTriggerFired: (cueType) =>
				pluginEventBus?.emit({
					topic: 'cue.fired',
					at: new Date().toISOString(),
					payload: { cueType },
				}),
			// Surface Cue run lifecycle (`cue.runStarted` / `cue.runFinished`) to
			// subscribed plugins (events:subscribe). Metadata-only; null-safe.
			emitPluginEvent: (event) => pluginEventBus?.emit(event),
		});

		// Configure Cue telemetry submitter. Reads installationId / encore flags
		// on every event so toggling Cue or usageStats at runtime takes effect
		// without an app restart. Same predicate as cue-stats.ts:isCueStatsEnabled
		// - both flags required.
		configureCueTelemetry({
			getInstallationId: () => store.get('installationId') as string | null,
			getAppVersion: () => app.getVersion(),
			getPlatform: () => process.platform,
			isEncoreEnabled: () => {
				const ef = store.get('encoreFeatures', {}) as Record<string, boolean>;
				return ef.maestroCue === true && ef.usageStats === true;
			},
		});

		// Initialize the Pianola supervised daemon and its scheduled re-learn job.
		// See src/main/pianola/pianola-lifecycle.ts for what each one does.
		const pianolaLifecycle = createPianolaLifecycle({
			settingsStore: store,
			sessionsStore,
			logger,
		});
		pianolaSupervisor = pianolaLifecycle.supervisor;
		pianolaRelearnScheduler = pianolaLifecycle.relearnScheduler;

		// Plugin manager: discovers installed community plugins, tracks their
		// enable state, verifies signatures, and (tier 1) runs their sandboxed
		// code. Self-gates on encoreFeatures.plugins. The permission broker is the
		// single authorization gate for every sandbox host call; the sandbox host
		// forks one utilityProcess per running tier-1 plugin.
		// Sealed plugin authorization ledger - the LIVE grant source for the broker,
		// contribution gating, and the refresh verifier. The consent window's minter
		// is the only writer; safeStorage seals the contents and the fixed OS-keyring
		// anchor makes rollback freshness survive app restarts. If native keyring is
		// unavailable, the lazy factory degrades to session-only without crashing app
		// startup.
		// [E2eGaps] Demo instances must never share (or delete!) the developer's
		// real OS-keyring freshness slot, so DEMO_MODE derives a per-demo-dir
		// account name; the e2e harness derives the identical string to clean up.
		const anchorAccount = DEMO_MODE
			? `freshness:${crypto.createHash('sha256').update(DEMO_DATA_PATH, 'utf8').digest('hex').slice(0, 16)}`
			: 'freshness';
		const authStore = createAuthorizationStore({
			safeStorage,
			anchor: createKeyringAnchor('com.maestro.plugin-authorization', anchorAccount),
			ledgerPath: path.join(app.getPath('userData'), 'plugin-authorization.bin'),
		});
		// Expose the same instance to the IPC registration phase below.
		pluginAuthStore = authStore;
		const trustedKeysFor = (): string[] => {
			const keys = store.get('pluginTrustedKeys', []) as unknown;
			const userKeys = Array.isArray(keys)
				? keys.filter((k): k is string => typeof k === 'string')
				: [];
			// Merge the built-in publisher anchor so a signed, bundled first-party
			// plugin is trusted without the user adding a key (publisher-keys.ts).
			return resolveTrustedKeys(userKeys);
		};
		// The live grant source every enforcement seam now reads (sealed, identity-
		// bound, anti-rollback) instead of the forgeable on-disk store.
		const grantsOf = (pluginId: string) => authStore.readGrants(pluginId);

		// First-party plugin bridges (encore-lifts L0): one host-owned lifecycle
		// bridge per Encore feature definition. Enable mints the definition's
		// declared grants through the SAME sealed ledger community consents use
		// (first-party = trusted by construction; the marketplace tile shows the
		// permission list as disclosure); disable/revoke stop supervised work and
		// clear the flag. Feature workers (L1..L5) look their bridge up via
		// getFirstPartyBridge(flag) - this is the single construction site.
		const mintFirstPartyGrants = createFirstPartyGrantMinter(authStore);
		const firstPartySupervisors: Partial<Record<FirstPartyEncoreFlag, FirstPartySupervisorHooks>> =
			{
				pianola: {
					reconcile: () => pianolaSupervisor?.reconcile(),
					stopAll: () => pianolaSupervisor?.stopAll(),
				},
				// [L3MaestroCue] cue engine lifecycle: reconcile (re)starts when the
				// flag+grants hold; stopAll halts every watcher/poller/heartbeat.
				maestroCue: createCueSupervisorHooks(() => cueEngine),
				// L5 usage-stats: `stats.sampler` - the background provider-quota
				// sampling loop (UsageRefreshScheduler). Marketplace disable/revoke
				// stops the timers; enable re-arms from the persisted intervals
				// (start() is idempotent; it arms nothing until the user picks an
				// auto-refresh interval in the dashboard).
				usageStats: {
					reconcile: () => usageRefreshScheduler?.start(),
					stopAll: () => usageRefreshScheduler?.stop(),
				},
			};
		const firstPartyBridges: Partial<Record<FirstPartyEncoreFlag, FirstPartyPluginBridge>> = {};
		for (const flag of Object.keys(FIRST_PARTY_PLUGINS) as FirstPartyEncoreFlag[]) {
			firstPartyBridges[flag] = new FirstPartyPluginBridge(FIRST_PARTY_PLUGINS[flag], {
				settingsStore: store as unknown as {
					get: (key: string) => unknown;
					set: (key: string, value: unknown) => void;
				},
				readGrants: grantsOf,
				mintFirstPartyGrants,
				revokeGrants: (pluginId) => authStore.revoke(pluginId),
				supervisor: firstPartySupervisors[flag],
			});
		}
		setFirstPartyBridges(firstPartyBridges);

		// Issue #1250 visibility: throttle the "dispatch blocked" toast per plugin
		// so a message loop hitting an out-of-date allowlist can't spam the user.
		// The audit log (in onDecision) still records every denial.
		const DISPATCH_DENY_TOAST_THROTTLE_MS = 60_000;
		const dispatchDenyToastAt = new Map<string, number>();

		const pluginBroker = new PermissionBroker({
			getGrants: (pluginId) => grantsOf(pluginId),
			// Structurally exclude the entire Maestro userData/config tree (grants,
			// enable-state, encoreFeatures + every setting, agent-configs,
			// cli-server.json token, the plugins dir, plugin KV, supervisor targets,
			// transcripts) from fs:read AND fs:write, enforced on the symlink-resolved
			// real path so no plugin fs scope can ever reach it.
			protectedPaths: () => [app.getPath('userData')],
			onDecision: (pluginId, method, decision) => {
				if (decision.allowed) return;
				logger.warn(
					`[Plugins] denied ${method} for "${pluginId}": ${decision.reason ?? ''}`,
					'[Plugins]'
				);
				// A denied agents.dispatch means an out-of-date allowlist: the plugin
				// swallows the RPC error and nothing surfaces to the operator (the
				// #1250 bug - 7 of 9 bound agents silently dead). Raise a throttled
				// toast pointing at the host-managed fix.
				if (method !== 'agents.dispatch') return;
				// Only a stale ALLOW LIST is actionable in Settings. If the plugin holds
				// no agents:dispatch grant at all (never consented, revoked, or invalid),
				// the editor is hidden and an "add the agent" toast would point at a fix
				// the user cannot perform - that denial is a consent problem, logged above.
				if (!grantsOf(pluginId).some((g) => g.capability === 'agents:dispatch')) return;
				const now = Date.now();
				if (now - (dispatchDenyToastAt.get(pluginId) ?? 0) < DISPATCH_DENY_TOAST_THROTTLE_MS) {
					return;
				}
				dispatchDenyToastAt.set(pluginId, now);
				if (!mainWindow || !isWebContentsAvailable(mainWindow)) return;
				const name =
					pluginManager?.getRegistry().records.find((r) => r.id === pluginId)?.manifest?.name ??
					pluginId;
				mainWindow.webContents.send('remote:notifyToast', {
					title: 'Plugin dispatch blocked',
					message: `"${name}" tried to dispatch to an agent that is not in its allow list. Add the agent in Settings -> Plugins.`,
					color: 'orange' as const,
				});
			},
		});

		// Phase 1+2 host services backing the new brokered verbs.
		const pluginActionGuard = new ActionGuard({
			audit: (e) =>
				logger.info(
					`[Plugins] high-risk ${e.capability} by "${e.pluginId}"${e.target ? ` -> ${e.target}` : ''}`,
					'[Plugins]'
				),
		});
		const pluginKvStore = new PluginKvStore({
			baseDir: path.join(app.getPath('userData'), 'plugin-data'),
		});
		const pluginEgressGuard = createEgressGuard({
			// The app's own web/CLI server. Loopback + RFC1918 are already blocked by
			// IP classification; this is belt-and-suspenders for a public-bind setup.
			blockedPorts: () => {
				const p = webServer?.getPort();
				return typeof p === 'number' && p > 0 ? [p] : [];
			},
		});

		// net:connect host sink. The SINK owns the raw ws.WebSocket objects; the
		// handler (plugin-host-handlers) owns the socketId -> {pluginId,url} map it
		// uses to re-authorize send/close and to count sockets per plugin. The
		// connect is pinned to the egress-guard lookup (same SSRF/DNS-rebind defense
		// as net.fetch) and inbound frame size is capped by maxPayload; the handler
		// already refused anything but wss:// and any untrusted plugin before here.
		const PLUGIN_SOCKET_MAX_FRAME_BYTES = 64 * 1024;
		const pluginSockets = new Map<string, Map<string, WebSocket>>();
		// Set by the handler (via registerNetSocketRelease). Lets a self-closing
		// socket (remote close / error) free the handler's per-plugin quota slot, so
		// a normal server-initiated close does not leak a stale count toward the cap.
		let pluginNetSocketRelease: ((pluginId: string, socketId: string) => void) | undefined;
		// v1: headers are dropped entirely. The connect URL and the broker host-scope
		// grant are the only client-controlled inputs; a plugin cannot smuggle a
		// forged Host/Origin/Authorization header. If a future gateway needs a bearer
		// token, add a narrow host-validated allowlist here - never a passthrough.
		const sanitizePluginSocketHeaders = (_headers: unknown): undefined => undefined;
		const dropPluginSocket = (pluginId: string, socketId: string): void => {
			const forPlugin = pluginSockets.get(pluginId);
			forPlugin?.delete(socketId);
			if (forPlugin && forPlugin.size === 0) pluginSockets.delete(pluginId);
		};
		const hostnameForAudit = (url: string): string => {
			try {
				return new URL(url).hostname;
			} catch {
				return url;
			}
		};
		const pluginNetConnect = async (
			pluginId: string,
			url: string,
			opts: { protocols?: unknown; headers?: unknown }
		): Promise<{ socketId: string }> => {
			const socketId = `net_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const protocols = Array.isArray(opts.protocols)
				? (opts.protocols.filter((p) => typeof p === 'string') as string[])
				: undefined;
			const ws = new WebSocket(url, protocols, {
				// Pin the TLS connect to the validated address (loopback / RFC1918 /
				// link-local / metadata are already refused by the classifier). The
				// guard's lookup is runtime-compatible with Node's LookupFunction; the
				// cast bridges the type-only `family` widening (string variants) the
				// same way net.fetch casts the undici dispatcher.
				agent: new https.Agent({
					lookup: pluginEgressGuard.lookup as unknown as LookupFunction,
				}),
				handshakeTimeout: 15_000,
				maxPayload: PLUGIN_SOCKET_MAX_FRAME_BYTES,
				headers: sanitizePluginSocketHeaders(opts.headers),
			});
			const forPlugin = pluginSockets.get(pluginId) ?? new Map<string, WebSocket>();
			forPlugin.set(socketId, ws);
			pluginSockets.set(pluginId, forPlugin);
			const push = (payload: Record<string, unknown>): void => {
				pluginSandboxHost?.pushEvent(pluginId, {
					topic: `net.connect:${socketId}`,
					at: new Date().toISOString(),
					payload: { socketId, ...payload },
				});
			};
			ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
				// Defensive inbound cap on top of maxPayload.
				const buf = Array.isArray(data)
					? Buffer.concat(data)
					: Buffer.isBuffer(data)
						? data
						: Buffer.from(data as ArrayBuffer);
				if (buf.byteLength > PLUGIN_SOCKET_MAX_FRAME_BYTES) {
					push({ type: 'error', message: 'inbound frame exceeds size limit' });
					return;
				}
				push({ type: 'message', data: buf.toString('utf8'), binary: isBinary });
			});
			ws.on('close', (code: number, reason: Buffer) => {
				push({ type: 'close', code, reason: reason.toString('utf8') });
				dropPluginSocket(pluginId, socketId);
				// Free the handler's quota slot for this self-closed socket. (ws emits
				// 'close' after 'error' too, so this covers fatal errors as well.)
				pluginNetSocketRelease?.(pluginId, socketId);
			});
			ws.on('error', (err: Error) => {
				// Message string only: never leak the Error object / stack to a plugin.
				push({ type: 'error', message: err.message });
			});
			// Resolve as soon as the socket is created and tracked; the plugin observes
			// the actual OPEN via the first event on the topic (simpler than buffering
			// an open handshake here, and handshakeTimeout still bounds a stuck
			// connect). A send before OPEN is rejected by pluginNetSend.
			logger.info(
				`net.connect by "${pluginId}" -> ${hostnameForAudit(url)} (socket ${socketId})`,
				'[PluginAudit]'
			);
			return { socketId };
		};
		const pluginNetSend = async (
			pluginId: string,
			socketId: string,
			data: string
		): Promise<{ ok: true }> => {
			const ws = pluginSockets.get(pluginId)?.get(socketId);
			if (!ws) throw new Error('net.send: unknown socketId');
			if (ws.readyState !== WebSocket.OPEN) throw new Error('net.send: socket not open');
			ws.send(data);
			return { ok: true };
		};
		const pluginNetClose = async (
			pluginId: string,
			socketId: string,
			code?: number,
			reason?: string
		): Promise<{ ok: true }> => {
			const ws = pluginSockets.get(pluginId)?.get(socketId);
			try {
				ws?.close(code, reason);
			} catch {
				// best-effort: the socket may already be closing/closed
			}
			dropPluginSocket(pluginId, socketId);
			return { ok: true };
		};

		// Loose view of the settings store for dynamic plugin-namespaced keys.
		const pluginSettingsStore = store as unknown as {
			get(key: string): unknown;
			set(key: string, value: unknown): void;
			delete(key: string): void;
		};
		const pluginSettingsGet = (key: string): unknown => pluginSettingsStore.get(key);
		const pluginSettingsSet = (key: string, value: unknown): void =>
			pluginSettingsStore.set(key, value);
		const pluginSettingsDeleteNamespace = (prefix: string): void =>
			pluginSettingsStore.delete(prefix.replace(/\.$/, ''));
		const pluginSessionsList = (): PluginSessionMetadata[] => {
			const sessions = sessionsStore.get('sessions', []) as Array<Record<string, unknown>>;
			return sessions
				.filter((s) => typeof s?.id === 'string')
				.map((s) => ({
					id: s.id as string,
					...(typeof s.name === 'string' ? { title: s.name } : {}),
					...(typeof s.toolType === 'string' ? { agentId: s.toolType } : {}),
					...(typeof s.status === 'string' ? { status: s.status } : {}),
					...(typeof s.createdAt === 'number' ? { createdAt: s.createdAt } : {}),
					...(typeof s.updatedAt === 'number' ? { updatedAt: s.updatedAt } : {}),
					...(typeof s.cwd === 'string' ? { projectPath: s.cwd } : {}),
				}));
		};

		const pluginSessionsRaw = (): Array<Record<string, unknown>> =>
			(sessionsStore.get('sessions', []) as Array<Record<string, unknown>>).filter(
				(s) => typeof s?.id === 'string'
			);
		const setPluginSessionsRaw = (sessions: Array<Record<string, unknown>>): void => {
			sessionsStore.set('sessions', sessions as never);
		};
		const pluginTabsList = (sessionId?: string): PluginTabMetadata[] => {
			const out: PluginTabMetadata[] = [];
			for (const session of pluginSessionsRaw()) {
				if (sessionId && session.id !== sessionId) continue;
				const projectPath =
					typeof session.cwd === 'string'
						? session.cwd
						: typeof session.projectRoot === 'string'
							? session.projectRoot
							: undefined;
				for (const tab of Array.isArray(session.aiTabs) ? session.aiTabs : []) {
					if (!tab || typeof tab !== 'object') continue;
					const rec = tab as Record<string, unknown>;
					if (typeof rec.id !== 'string') continue;
					out.push({
						id: rec.id,
						sessionId: session.id as string,
						type: 'ai',
						...(typeof rec.name === 'string' ? { title: rec.name } : {}),
						...(typeof rec.state === 'string' ? { status: rec.state } : {}),
						...(typeof rec.createdAt === 'number' ? { createdAt: rec.createdAt } : {}),
						...(rec.agentSessionId === null || typeof rec.agentSessionId === 'string'
							? { agentSessionId: rec.agentSessionId as string | null }
							: {}),
						...(projectPath ? { projectPath } : {}),
					});
				}
				for (const tab of Array.isArray(session.terminalTabs) ? session.terminalTabs : []) {
					if (!tab || typeof tab !== 'object') continue;
					const rec = tab as Record<string, unknown>;
					if (typeof rec.id !== 'string') continue;
					out.push({
						id: rec.id,
						sessionId: session.id as string,
						type: 'terminal',
						...(typeof rec.name === 'string' ? { title: rec.name } : {}),
						...(typeof rec.state === 'string' ? { status: rec.state } : {}),
						...(typeof rec.createdAt === 'number' ? { createdAt: rec.createdAt } : {}),
						...(projectPath ? { projectPath } : {}),
					});
				}
			}
			return out;
		};
		const pluginTabsCreate = async (
			params: Record<string, unknown>
		): Promise<PluginTabMetadata | null> => {
			const sessions = pluginSessionsRaw();
			const targetId =
				typeof params.sessionId === 'string'
					? params.sessionId
					: typeof sessionsStore.get('activeSessionId', '') === 'string'
						? (sessionsStore.get('activeSessionId', '') as string)
						: '';
			const session = sessions.find((s) => s.id === targetId);
			if (!session) return null;
			const now = Date.now();
			const tabId = crypto.randomUUID();
			const name = typeof params.title === 'string' ? params.title : null;
			const tab = {
				id: tabId,
				agentSessionId: null,
				name,
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				createdAt: now,
				state: 'idle',
			};
			const nextSession = {
				...session,
				aiTabs: [...(Array.isArray(session.aiTabs) ? session.aiTabs : []), tab],
				activeTabId: tabId,
				activeFileTabId: null,
				activeBrowserTabId: null,
				activeTerminalTabId: null,
				inputMode: 'ai',
				unifiedTabOrder: [
					...(Array.isArray(session.unifiedTabOrder) ? session.unifiedTabOrder : []),
					{ type: 'ai', id: tabId },
				],
				updatedAt: now,
			};
			setPluginSessionsRaw(sessions.map((s) => (s.id === session.id ? nextSession : s)));
			return {
				id: tabId,
				sessionId: session.id as string,
				type: 'ai',
				...(name ? { title: name } : {}),
				status: 'idle',
				createdAt: now,
				agentSessionId: null,
				...(typeof session.cwd === 'string' ? { projectPath: session.cwd } : {}),
			};
		};
		/**
		 * Main-side mirror of the renderer's `aiTabFocusFields()`
		 * (`src/renderer/utils/tabHelpers.ts`): land a session on an AI tab by
		 * clearing every non-AI view that would otherwise outrank it in the render
		 * precedence. Shared by `tabs.focus` and `sessions.focus` so the two plugin
		 * verbs can never drift into different notions of "focused".
		 */
		const pluginAiFocusFields = (tabId?: string): Record<string, unknown> => ({
			...(tabId ? { activeTabId: tabId } : {}),
			activeFileTabId: null,
			activeBrowserTabId: null,
			activeTerminalTabId: null,
			inputMode: 'ai',
			activeGroupId: null,
		});
		// Plugin focus verbs write sessionsStore directly, so they never reach the
		// sessions:setActiveSessionId IPC handler where session.activated is emitted
		// for event subscribers. Emit here so plugins observing focus changes see
		// plugin-driven jumps, not only user-driven Left Bar navigation.
		const emitPluginSessionActivated = (sessionId: string): void => {
			if (!sessionId) return;
			pluginEventBus?.emit({
				topic: 'session.activated',
				at: new Date().toISOString(),
				payload: { sessionId },
			});
			// Keep the persistence-layer dedupe in sync: flushSessionActivated guards
			// repeats with its own last-emitted id, and this direct emit bypasses it.
			// Without recording here, a later user navigation back to the previously
			// focused session would be wrongly suppressed (see PersistenceHandlers).
			noteSessionActivatedInPersistence?.(sessionId);
		};
		const pluginTabsFocus = async (tabId: string): Promise<boolean> => {
			const sessions = pluginSessionsRaw();
			let focused = false;
			let focusedSessionId: string | undefined;
			const next = sessions.map((session) => {
				if ((Array.isArray(session.aiTabs) ? session.aiTabs : []).some((t) => t?.id === tabId)) {
					focused = true;
					focusedSessionId = session.id as string;
					sessionsStore.set('activeSessionId', session.id as string);
					return { ...session, ...pluginAiFocusFields(tabId) };
				}
				if (
					(Array.isArray(session.terminalTabs) ? session.terminalTabs : []).some(
						(t) => t?.id === tabId
					)
				) {
					focused = true;
					focusedSessionId = session.id as string;
					sessionsStore.set('activeSessionId', session.id as string);
					return {
						...session,
						activeTerminalTabId: tabId,
						activeFileTabId: null,
						activeBrowserTabId: null,
						inputMode: 'terminal',
					};
				}
				return session;
			});
			if (focused) {
				setPluginSessionsRaw(next);
				if (focusedSessionId) emitPluginSessionActivated(focusedSessionId);
			}
			return focused;
		};
		/**
		 * Jump the user to an existing session (the `sessions.focus` verb). Without
		 * a tabId it keeps whichever AI tab the session already had active, falling
		 * back to its first AI tab; with one, that tab must belong to the session or
		 * the call is rejected rather than silently landing somewhere else.
		 */
		const pluginSessionsFocus = async (sessionId: string, tabId?: string): Promise<boolean> => {
			const sessions = pluginSessionsRaw();
			const session = sessions.find((s) => s.id === sessionId);
			if (!session) return false;
			const aiTabs = (Array.isArray(session.aiTabs) ? session.aiTabs : []) as Array<
				Record<string, unknown> | undefined
			>;
			const hasAiTab = (id: unknown) =>
				typeof id === 'string' && aiTabs.some((t) => t?.id === id) ? id : undefined;
			if (tabId !== undefined && !hasAiTab(tabId)) return false;
			const target =
				tabId ??
				hasAiTab(session.activeTabId) ??
				(typeof aiTabs[0]?.id === 'string' ? (aiTabs[0].id as string) : undefined);
			sessionsStore.set('activeSessionId', sessionId);
			setPluginSessionsRaw(
				sessions.map((s) => (s.id === sessionId ? { ...s, ...pluginAiFocusFields(target) } : s))
			);
			emitPluginSessionActivated(sessionId);
			// The store write above is only the persistence path: the renderer's
			// Zustand session store is canonical and reads main's store only at
			// startup, then flushes its own tree back down - so a main-side write is
			// invisible to the live UI and gets clobbered on the next flush. Push a
			// focus-request event alongside it so a renderer listener applies the
			// jump through the same canonical helpers, moving the visible workspace.
			safeSend('sessions:focus-request', { sessionId, tabId: target });
			return true;
		};
		const pluginTabsClose = async (tabId: string): Promise<boolean> => {
			const sessions = pluginSessionsRaw();
			let closed = false;
			const next = sessions.map((session) => {
				const aiTabs = Array.isArray(session.aiTabs) ? session.aiTabs : [];
				const terminalTabs = Array.isArray(session.terminalTabs) ? session.terminalTabs : [];
				if (aiTabs.some((t) => t?.id === tabId)) {
					closed = true;
					const remaining = aiTabs.filter((t) => t?.id !== tabId);
					return {
						...session,
						aiTabs: remaining,
						activeTabId:
							session.activeTabId === tabId
								? ((remaining[0] as Record<string, unknown> | undefined)?.id ?? '')
								: session.activeTabId,
						unifiedTabOrder: Array.isArray(session.unifiedTabOrder)
							? session.unifiedTabOrder.filter((t) => t?.id !== tabId)
							: [],
					};
				}
				if (terminalTabs.some((t) => t?.id === tabId)) {
					closed = true;
					const remaining = terminalTabs.filter((t) => t?.id !== tabId);
					return {
						...session,
						terminalTabs: remaining,
						activeTerminalTabId:
							session.activeTerminalTabId === tabId ? null : session.activeTerminalTabId,
						unifiedTabOrder: Array.isArray(session.unifiedTabOrder)
							? session.unifiedTabOrder.filter((t) => t?.id !== tabId)
							: [],
					};
				}
				return session;
			});
			if (closed) setPluginSessionsRaw(next);
			return closed;
		};
		const pluginSessionsGet = (sessionId: string): PluginSessionMetadata | null =>
			pluginSessionsList().find((s) => s.id === sessionId) ?? null;
		const pluginSessionsCreate = async (
			params: Record<string, unknown>
		): Promise<PluginSessionMetadata> => {
			const now = Date.now();
			const sessionId = typeof params.id === 'string' ? params.id : crypto.randomUUID();
			const tabId = crypto.randomUUID();
			const title =
				typeof params.title === 'string'
					? params.title
					: typeof params.name === 'string'
						? params.name
						: 'Plugin Session';
			const toolType =
				typeof params.agentId === 'string'
					? params.agentId
					: typeof params.toolType === 'string'
						? params.toolType
						: 'claude-code';
			const cwd =
				typeof params.projectPath === 'string'
					? params.projectPath
					: typeof params.cwd === 'string'
						? params.cwd
						: os.homedir();
			const session = {
				id: sessionId,
				name: title,
				toolType,
				state: 'idle',
				cwd,
				fullPath: cwd,
				projectRoot: cwd,
				createdAt: now,
				updatedAt: now,
				aiLogs: [],
				shellLogs: [],
				workLog: [],
				contextUsage: 0,
				inputMode: 'ai',
				aiPid: 0,
				terminalPid: 0,
				port: 0,
				isLive: false,
				changedFiles: [],
				isGitRepo: false,
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				executionQueue: [],
				activeTimeMs: 0,
				aiTabs: [
					{
						id: tabId,
						agentSessionId: null,
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: now,
						state: 'idle',
					},
				],
				activeTabId: tabId,
				closedTabHistory: [],
				filePreviewTabs: [],
				activeFileTabId: null,
				browserTabs: [],
				activeBrowserTabId: null,
				terminalTabs: [],
				activeTerminalTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: tabId }],
				unifiedClosedTabHistory: [],
			};
			setPluginSessionsRaw([...pluginSessionsRaw(), session]);
			sessionsStore.set('activeSessionId', sessionId);
			return {
				id: sessionId,
				title,
				agentId: toolType,
				status: 'idle',
				createdAt: now,
				projectPath: cwd,
			};
		};
		const pluginSessionsUpdate = async (
			sessionId: string,
			patch: Record<string, unknown>
		): Promise<PluginSessionMetadata | null> => {
			const sessions = pluginSessionsRaw();
			let updated: Record<string, unknown> | null = null;
			const next = sessions.map((session) => {
				if (session.id !== sessionId) return session;
				updated = {
					...session,
					...(typeof patch.title === 'string' ? { name: patch.title } : {}),
					...(typeof patch.name === 'string' ? { name: patch.name } : {}),
					...(typeof patch.status === 'string' ? { state: patch.status } : {}),
					updatedAt: Date.now(),
				};
				return updated;
			});
			if (!updated) return null;
			setPluginSessionsRaw(next);
			return pluginSessionsGet(sessionId);
		};
		const pluginSessionsDelete = async (sessionId: string): Promise<boolean> => {
			const sessions = pluginSessionsRaw();
			if (!sessions.some((s) => s.id === sessionId)) return false;
			setPluginSessionsRaw(sessions.filter((s) => s.id !== sessionId));
			if (sessionsStore.get('activeSessionId', '') === sessionId) {
				const nextActive = pluginSessionsRaw()[0]?.id;
				sessionsStore.set('activeSessionId', typeof nextActive === 'string' ? nextActive : '');
			}
			return true;
		};
		const pluginListHistoryEntries = async () => {
			const all = [];
			for (const session of pluginSessionsList()) {
				all.push(...(await getHistoryManager().getEntries(session.id)));
			}
			return all;
		};
		const pluginGetHistoryEntry = async (entryId: string) => {
			for (const entry of await pluginListHistoryEntries()) {
				if (entry.id === entryId) return entry;
			}
			return null;
		};
		const pluginRecordDecision = async (pluginId: string, decision: Record<string, unknown>) => {
			const id = crypto.randomUUID();
			const at = Date.now();
			pluginSettingsSet(`plugins.${pluginId}.decisions.${id}`, { ...decision, id, at });
			return { id, at };
		};

		const eventBus = new PluginEventBusImpl({
			isPermitted: (pluginId) => isPermitted(grantsOf(pluginId), 'events:subscribe'),
			hasCapability: (pluginId, capability) => isPermitted(grantsOf(pluginId), capability),
			push: (pluginId, event) => pluginSandboxHost?.pushEvent(pluginId, event) ?? false,
		});
		pluginEventBus = eventBus;

		// Background-service supervision (FC5): registered services survive sandbox
		// crashes via bounded-backoff restart of the owning plugin; the restarted
		// plugin's activate path re-registers. pluginManager is assigned later in
		// this function; both closures read it lazily (never before app-ready use).
		const backgroundSupervisor = new PluginBackgroundSupervisor({
			// refresh() re-reads disk and reconciles sandboxes: it starts every
			// runnable plugin that is not running - i.e. the crashed one.
			restartPlugin: () => pluginManager?.refresh(),
			isPluginEnabled: (pluginId) =>
				pluginManager?.getRegistry().records.some((r) => r.id === pluginId && r.enabled) ?? false,
		});
		pluginBackgroundSupervisor = backgroundSupervisor;

		// Shared FC2/FC3 dispatch sink: resolve a runtime session FAIL-CLOSED
		// (exact session id, else exact UNIQUE name - ambiguity is an error, never
		// a guess), audit the resolved id, then hand the prompt to the renderer -
		// the same single source of truth the web remote path uses. SYNCHRONOUS by
		// design: resolution/renderer failures throw INTO the caller (the scheduler
		// tick's try/catch, the handler's promise chain), never after a false
		// "dispatched" success.
		const dispatchPromptToSession = (
			agentId: string,
			prompt: string
		): { dispatched: true; sessionId: string } => {
			const sessions = sessionsStore.get('sessions', []) as Array<{
				id?: string;
				name?: string;
			}>;
			const byId = sessions.find((s) => s.id === agentId);
			const byName = sessions.filter((s) => s.name === agentId);
			const target = byId ?? (byName.length === 1 ? byName[0] : undefined);
			if (!target?.id) {
				throw new Error(
					byName.length > 1
						? `agents.dispatch: "${agentId}" matches ${byName.length} sessions - use the session id`
						: `agents.dispatch: no session "${agentId}"`
				);
			}
			logger.info(
				`agents.dispatch -> session ${target.id} (requested "${agentId}", ${prompt.length} chars)`,
				'[PluginAudit]'
			);
			const win = mainWindow;
			if (!win || win.isDestroyed() || !isWebContentsAvailable(win)) {
				throw new Error('agents.dispatch: no renderer available to run the agent');
			}
			win.webContents.send('remote:executeCommand', target.id, prompt, 'ai');
			return { dispatched: true, sessionId: target.id };
		};

		// Host-owned spawn binary allowlist (FC2 / phase-4 §2). Ships EMPTY -
		// Maestro blesses no helper binaries by default. DEMO_MODE lets the e2e
		// harness bless ONE binary ('e2e-selftest') via an env-supplied absolute
		// path; the registry still enforces every invariant (absolute path, no
		// shells/interpreters, closed env), so the harness cannot bless bash.
		const spawnBinaryRegistry = new SpawnBinaryRegistry({
			onRegister: (entry) =>
				logger.info(
					`[Plugins] spawn binary blessed: ${entry.name} -> ${entry.binaryPath}`,
					'[PluginAudit]'
				),
		});
		if (DEMO_MODE && process.env.MAESTRO_E2E_SPAWN_BINARY) {
			try {
				spawnBinaryRegistry.register({
					name: 'e2e-selftest',
					binaryPath: process.env.MAESTRO_E2E_SPAWN_BINARY,
				});
			} catch (err) {
				logger.warn(`[Plugins] demo spawn blessing rejected: ${String(err)}`, '[Plugins]');
			}
		}

		let pluginResourceCleanup: ((pluginId: string) => void) | undefined;
		const groupingRegistry = new PluginGroupingRegistry(() => {
			try {
				mainWindow?.webContents.send('plugins:groupings-changed');
			} catch {
				// Renderer may be gone during shutdown; ignore.
			}
		});
		pluginGroupingRegistry = groupingRegistry;
		const sandboxHost = new PluginSandboxHost({
			broker: pluginBroker,
			handlers: buildHostCallHandlers({
				broker: pluginBroker,
				actionGuard: pluginActionGuard,
				kvStore: pluginKvStore,
				eventBus,
				egressGuard: pluginEgressGuard,
				settingsGet: pluginSettingsGet,
				settingsSet: pluginSettingsSet,
				settingsDeleteNamespace: pluginSettingsDeleteNamespace,
				sessionsList: pluginSessionsList,
				sessionsGet: pluginSessionsGet,
				groupingRegistry,
				isDeclaredGrouping: (pluginId, localId) =>
					pluginManager
						?.getContributions()
						.groupings.some(
							(grouping) => grouping.pluginId === pluginId && grouping.localId === localId
						) ?? false,
				sessionsCreate: pluginSessionsCreate,
				sessionsUpdate: pluginSessionsUpdate,
				sessionsDelete: pluginSessionsDelete,
				sessionsFocus: pluginSessionsFocus,
				tabsList: pluginTabsList,
				tabsCreate: pluginTabsCreate,
				tabsFocus: pluginTabsFocus,
				tabsClose: pluginTabsClose,
				listHistoryEntries: pluginListHistoryEntries,
				getHistoryEntry: pluginGetHistoryEntry,
				readSessionTranscript: (sessionId) => getHistoryManager().getEntries(sessionId),
				assertTranscriptReadAllowed: (pluginId) => {
					const reg = pluginManager?.getRegistry();
					const rec = reg?.records?.find((r) => r.id === pluginId);
					const trusted = rec?.signature?.status === 'trusted';
					const reason = transcriptReadEgressConflict(grantsOf(pluginId), { trusted });
					if (reason) throw new Error(reason);
				},
				auditTranscriptRead: (pluginId, info) => {
					logger.info(
						`transcripts.read by "${pluginId}" session=${info.sessionId} project=${info.projectPath ?? '(none)'} fields=[${info.fields.join(',')}] rows=${info.count}`,
						'[PluginAudit]'
					);
				},
				appendSessionTranscript: async (sessionId, projectPath, entries) => {
					for (const entry of entries) {
						await getHistoryManager().addEntry(sessionId, projectPath, entry);
					}
				},
				auditTranscriptWrite: (pluginId, info) => {
					logger.info(
						`transcripts.append by "${pluginId}" session=${info.sessionId} project=${info.projectPath} rows=${info.count}`,
						'[PluginAudit]'
					);
				},
				recordDecision: pluginRecordDecision,
				openExternal: async (url, opts) => {
					if (DEMO_MODE) {
						// [E2eGaps] An isolated demo instance must not open real browsers;
						// the audit line is what the e2e PASS row asserts.
						logger.info(`shell.openExternal by plugin -> ${url} (demo no-op)`, '[PluginAudit]');
						return;
					}
					await shell.openExternal(url, opts as OpenExternalOptions);
				},
				powerPreventSleep: (reason) => powerManager.addBlockReason(reason),
				powerReleaseSleep: (reason) => powerManager.removeBlockReason(reason),
				registerResourceCleanup: (cleanup) => {
					pluginResourceCleanup = cleanup;
				},
				backgroundRegister: async (pluginId, service) =>
					backgroundSupervisor.register(pluginId, service),
				backgroundUnregister: async (pluginId, serviceId) =>
					backgroundSupervisor.unregister(pluginId, serviceId),
				backgroundList: (pluginId) => backgroundSupervisor.health(pluginId),
				storageSqlBaseDir: path.join(app.getPath('userData'), 'plugin-data', 'sql'),
				pushPluginEvent: (pluginId, event) =>
					pluginSandboxHost?.pushEvent(pluginId, event) ?? false,
				// [UiCommandeer] TEMP self-verify wiring for WS-ui-command. Main to
				// integrate canonically (index.ts also takes act-verbs). The dep type
				// is now (commandId, args?) => Promise<boolean>, so the old `() => false`
				// stub no longer type-checks; this round-trips to the renderer's shared
				// command registry (the SAME registry the command palette is built from).
				runUiCommand: createRunUiCommand(() => mainWindow),
				isHostViewsEnabled: arePluginHostViewsEnabled,
				getHostView: (pluginId, localId) => pluginHostViews.getDeclared(pluginId, localId),
				forwardHostView: (pluginId, operation, localId, blocks) => {
					if (operation === 'remove') return pluginHostViews.remove(pluginId, localId);
					return blocks === undefined ? false : pluginHostViews.update(pluginId, localId, blocks);
				},
				// ui.panelPost: resolve the caller's LOCAL panel id against its own
				// declarations (a foreign or already-namespaced id never matches), then
				// broadcast the validated, size-capped JSON to every renderer. The
				// renderer hands it to the matching panel webview; nothing evaluates it.
				getPanel: (pluginId, localId) =>
					pluginManager
						?.getContributions()
						.panels.find((p) => p.pluginId === pluginId && p.localId === localId) ?? null,
				panelPost: (pluginId, panelId, data) => {
					safeSend('plugins:panel-data', { pluginId, panelId, data });
				},
				// ui.openPanel/closePanel/togglePanel: a pure show/hide signal for the
				// caller's own modal panel, already resolved and namespaced by the
				// handler. The renderer owns the single modal-panel mount, so all main
				// does is broadcast the requested action.
				panelVisibility: (pluginId, panelId, action) => {
					safeSend('plugins:panel-visibility', { pluginId, panelId, action });
				},
				listAgents: () => {
					const sessions = sessionsStore.get('sessions', []) as Array<{
						id?: string;
						name?: string;
						cwd?: string;
						toolType?: string;
					}>;
					return sessions
						.filter((s) => typeof s?.id === 'string')
						.map((s) => ({
							id: s.id as string,
							name: s.name ?? '',
							...(s.cwd ? { cwd: s.cwd } : {}),
							...(s.toolType ? { toolType: s.toolType } : {}),
						}));
				},
				// agents.dispatch + process.spawn (FC2, Plans/feature-complete-workplan.md):
				// LIVE as of the FC1 trusted-to-run gate landing. Every call still
				// traverses the full phase-4 pipeline in plugin-host-handlers:
				// trusted-signed plugin + allowlist-scoped grant naming the exact
				// target + separate high-risk consent (+ unattended for scheduler
				// paths) + ActionGuard high caps + audit-before-effect. These sinks
				// are the LAST hop, not a gate.
				// Trust source for assertTrustedActVerb: the live registry's verified
				// signature status. Lazy - pluginManager is assigned below; handlers
				// only run once the sandbox is up. Fail-closed when absent.
				isPluginTrusted: (pluginId) =>
					pluginManager?.getRegistry().records.find((r) => r.id === pluginId)?.signature?.status ===
					'trusted',
				dispatch: async (agentId, prompt) => dispatchPromptToSession(agentId, prompt),
				// Direct plugin dispatch is never user-present, so it requires the
				// separate unattended consent on TOP of the interactive allowlist grant
				// - the same grant source and check the time-based scheduler uses.
				dispatchUnattendedAllowed: (pluginId, agentId) =>
					isPermittedUnattended(grantsOf(pluginId), 'agents:dispatch', agentId),
				spawn: async (pluginId, spec) => {
					logger.info(
						`process.spawn by "${pluginId}": ${spec.name} (${spec.binaryPath}) argv=${JSON.stringify(spec.args)}`,
						'[PluginAudit]'
					);
					// Shell-less by construction: execFile(binary, argv). Env/cwd are
					// host-owned registry values; output is bounded; never shell:true.
					return await new Promise((resolve, reject) => {
						execFile(
							spec.binaryPath,
							spec.args,
							{
								env: spec.env,
								...(spec.cwd ? { cwd: spec.cwd } : {}),
								timeout: 30_000,
								maxBuffer: 1024 * 1024,
								windowsHide: true,
								shell: false,
							},
							(error, stdout, stderr) => {
								if (error && error.code === undefined) {
									// Spawn-level failure (missing binary, timeout kill).
									reject(new Error(`process.spawn: ${error.message}`));
									return;
								}
								resolve({
									exitCode: typeof error?.code === 'number' ? error.code : 0,
									stdout: String(stdout).slice(0, 64 * 1024),
									stderr: String(stderr).slice(0, 64 * 1024),
								});
							}
						);
					});
				},
				resolveSpawnBinary: (name) => spawnBinaryRegistry.resolve(name),
				// net:connect (persistent wss socket) sinks. Wired together so the
				// handler surface is never partial. The handler enforces wss-only,
				// trust, the broker host-scope grant, the per-plugin socket cap, and
				// the outbound frame cap; these sinks own the raw ws objects and pin
				// the connect to pluginEgressGuard.lookup.
				netConnect: pluginNetConnect,
				netSend: pluginNetSend,
				netClose: pluginNetClose,
				registerNetSocketRelease: (release) => {
					pluginNetSocketRelease = release;
				},
			}),
			onLog: (pluginId, level, message) => {
				logger.info(`[Plugin:${pluginId}] ${level}: ${message}`, '[Plugins]');
			},
			onCrash: (pluginId, code) => {
				pluginResourceCleanup?.(pluginId);
				pluginHostViews.purge(pluginId);
				groupingRegistry.removePlugin(pluginId);
				logger.warn(`[Plugins] plugin "${pluginId}" crashed (code ${code})`, '[Plugins]');
				backgroundSupervisor.onPluginCrash(pluginId, code);
			},
			onStop: (pluginId) => {
				pluginResourceCleanup?.(pluginId);
				pluginHostViews.purge(pluginId);
				groupingRegistry.removePlugin(pluginId);
				backgroundSupervisor.onPluginStopped(pluginId);
			},
		});
		pluginSandboxHost = sandboxHost;
		pluginManager = new PluginManager({
			isEnabled: () => {
				const ef = store.get('encoreFeatures', {}) as Record<string, boolean>;
				return ef.plugins === true;
			},
			trustedKeys: trustedKeysFor,
			sandbox: sandboxHost,
			// Gate capability-scoped contributions by the SAME live grant source the
			// broker uses: the sealed authorization ledger.
			getGrants: (pluginId) => grantsOf(pluginId),
			// Refresh-time verifier: force-disable an enabled code-tier plugin whose
			// consented identity no longer matches the bytes on disk (tamper), or that
			// was removed, by checking it against the sealed ledger.
			verifyRecord: (record) => {
				const identity = pluginIdentity(record.source, trustedKeysFor());
				if (!identity) return { disable: true };
				const requested = (record.manifest?.permissions ?? []).map((p) => p.capability);
				const result = authStore.verify(record.id, identity, requested);
				return {
					disable: shouldDisablePluginForVerifyResult(result),
				};
			},
			// Complete uninstall (invariant #8): purge the plugin's KV store, its
			// plugins.<id>.* settings, and its event subscriptions.
			purgePluginData: (id) => {
				purgePluginData(id, {
					kvStore: pluginKvStore,
					settingsDeleteNamespace: pluginSettingsDeleteNamespace,
					eventBus,
					hostViews: pluginHostViews,
				});
				groupingRegistry.removePlugin(id);
				backgroundSupervisor.teardown(id);
			},
			onChange: (registry) => {
				pluginHostViews.sync();
				try {
					mainWindow?.webContents.send('plugins:changed', registry);
				} catch {
					// Renderer may be gone during shutdown; ignore.
				}
			},
		});

		let consentWindowRef: OpenedConsentWindow | null = null;
		const closeConsentWindow = (): void => {
			try {
				consentWindowRef?.window.close();
			} catch {
				// Already destroyed; ignore.
			}
			consentWindowRef = null;
		};
		// The isolated authorization minter: issues a one-time nonce inside this
		// main-owned open path, opens the dedicated consent window, and accepts a
		// confirm ONLY from that window's frame before minting the approved subset.
		const consentMinter = new ConsentMinter({
			registry: new ConsentNonceRegistry(),
			store: authStore,
			requested: (pluginId) => pluginManager?.getRequestedPermissions(pluginId) ?? [],
			identityOf: (pluginId) => {
				const record = pluginManager?.getRegistry().records.find((r) => r.id === pluginId);
				return record ? pluginIdentity(record.source, trustedKeysFor()) : null;
			},
			openPrompt: async ({ pluginId, offered, nonce }) => {
				const record = pluginManager?.getRegistry().records.find((r) => r.id === pluginId);
				const requested = pluginManager?.getRequestedPermissions(pluginId) ?? [];
				// [FC1Finish] Full-trust banner for a CODE plugin (tier >= 1 with an
				// entry file): under Option-B trusted-to-run there is no OS sandbox,
				// so consent must say what enabling actually does.
				const isCodePlugin =
					(record?.manifest?.tier ?? 0) >= 1 &&
					typeof record?.manifest?.entry === 'string' &&
					record.manifest.entry !== '';
				const offer: ConsentOffer = {
					pluginId,
					pluginName: record?.manifest?.name ?? pluginId,
					nonce,
					...(isCodePlugin
						? {
								codeBanner:
									"This plugin's code will run with your account's privileges on this machine.",
							}
						: {}),
					offered: offered.map((cap) => {
						const req = requested.find((r) => r.capability === cap);
						// Phase-4 act verbs render in the consent page's SEPARATE
						// high-risk section (unchecked by default) with the nested,
						// separately-approvable unattended consent line.
						const actVerb = isHighRiskActCapability(cap);
						return {
							capability: cap,
							risk: capabilityRisk(cap),
							...(req?.scope ? { scope: req.scope } : {}),
							...(req?.reason ? { reason: req.reason } : {}),
							description: describeCapability(cap),
							...(actVerb ? { actVerb: true, unattended: describeUnattendedConsent(cap) } : {}),
						};
					}),
				};
				// Supersede any consent window still open (its nonce is now stale) so a
				// second request can never leave a live window that closes the new one.
				closeConsentWindow();
				const paths = consentSurfacePaths(__dirname);
				const opened = await openConsentWindow(offer, {
					parent: mainWindow ?? null,
					preloadPath: paths.preloadPath,
					htmlPath: paths.htmlPath,
				});
				consentWindowRef = opened;
				return opened.sender;
			},
		});
		const senderTokenOf = (event: IpcMainInvokeEvent) => ({
			webContentsId: event.sender.id,
			frameId: event.senderFrame?.routingId ?? -1,
			url: event.senderFrame?.url,
		});
		// Open the consent window. Only the trusted main renderer may ask.
		ipcMain.handle('plugins:request-consent', async (event, pluginId: unknown) => {
			if (event.sender !== mainWindow?.webContents) throw new Error('UntrustedConsentRequester');
			const ef = store.get('encoreFeatures', {}) as Record<string, boolean>;
			if (ef.plugins !== true) throw new Error('PluginsDisabled');
			if (typeof pluginId !== 'string' || !PLUGIN_ID_PATTERN.test(pluginId)) {
				throw new Error('InvalidPluginId');
			}
			await consentMinter.requestConsent(pluginId);
			return { opened: true };
		});
		// Confirm from the consent window: the minter validates the sender frame +
		// one-time nonce before minting. The window is closed either way.
		ipcMain.handle('plugins:confirm-consent', (event, payload: unknown) => {
			const p = (payload ?? {}) as {
				pluginId?: unknown;
				nonce?: unknown;
				approved?: unknown;
				approvedHighRisk?: unknown;
				unattended?: unknown;
			};
			const pluginId = typeof p.pluginId === 'string' ? p.pluginId : '';
			const nonce = typeof p.nonce === 'string' ? p.nonce : '';
			const approved = Array.isArray(p.approved) ? p.approved.filter(isPluginCapability) : [];
			// Distinct Phase-4 channels: act verbs arrive ONLY on approvedHighRisk
			// (the minter rejects one smuggled into approved), and the revocable
			// unattended flag is minted only from the explicit unattended list.
			const approvedHighRisk = Array.isArray(p.approvedHighRisk)
				? p.approvedHighRisk.filter(isPluginCapability)
				: [];
			const unattended = Array.isArray(p.unattended) ? p.unattended.filter(isPluginCapability) : [];
			const outcome = consentMinter.confirm(senderTokenOf(event), {
				pluginId,
				nonce,
				approved,
				approvedHighRisk,
				unattended,
			});
			closeConsentWindow();
			if (outcome.ok) {
				logger.info(
					`[Plugins] consent minted for "${pluginId}": ${outcome.grants.map((g) => g.capability).join(', ') || '(none)'}`,
					'[Plugins]'
				);
				try {
					// Minting IS consent: flip the enable toggle + reconcile the sandbox now
					// that the plugin holds sealed ledger grants. setEnabled fires onChange
					// -> plugins:changed for the renderer.
					pluginManager?.setEnabled(pluginId, true);
				} catch {
					// Best-effort; the grant is already minted.
				}
				return { ok: true, granted: outcome.grants };
			}
			logger.warn(`[Plugins] consent confirm rejected: ${outcome.reason}`, '[Plugins]');
			// The consent window has already closed, so the rejection would otherwise be
			// silent. Surface why, and leave the plugin disabled (no setEnabled here).
			const reasonMsg =
				outcome.reason === 'conflict'
					? `an untrusted plugin can't combine transcripts:read with net:fetch or process:spawn (only a trusted, signed plugin can).`
					: outcome.reason === 'bad-nonce'
						? `the consent request expired or was superseded - try again.`
						: `consent was rejected (${outcome.reason}).`;
			logger.toast(
				`Couldn't enable "${pluginId}": ${reasonMsg} Re-enable it to choose a different set.`,
				'Plugins'
			);
			return { ok: false, reason: outcome.reason };
		});
		ipcMain.handle('plugins:cancel-consent', () => {
			closeConsentWindow();
			return { ok: false, reason: 'cancelled' as const };
		});

		// Host-managed dispatch allowlist (issue #1250). The USER, a DIFFERENT
		// principal from the plugin, edits which agents an already-consented
		// agents:dispatch grant may target. The host re-mints the grant's SCOPE
		// into the sealed ledger through the same authoritative path as
		// consent/revoke; the plugin is never involved and can never reach this.
		// Only the trusted main renderer may ask (like request-consent). The
		// capability, the unattended flag, and the plugin identity are untouched -
		// this only widens/narrows the scope of a capability the user already
		// granted, so a new agent needs no plugin re-pack or re-sign.
		ipcMain.handle(
			'plugins:set-agent-allowlist',
			async (event, pluginId: unknown, agentIds: unknown) => {
				if (event.sender !== mainWindow?.webContents) {
					throw new Error('UntrustedAllowlistRequester');
				}
				const ef = store.get('encoreFeatures', {}) as Record<string, boolean>;
				if (ef.plugins !== true) throw new Error('PluginsDisabled');
				if (typeof pluginId !== 'string' || !PLUGIN_ID_PATTERN.test(pluginId)) {
					throw new Error('InvalidPluginId');
				}
				if (!Array.isArray(agentIds)) throw new Error('InvalidAgentIds');
				// The manifest must actually declare agents:dispatch - the host manages
				// the SCOPE of a declared capability, never one the plugin never asked for.
				const requested = pluginManager?.getRequestedPermissions(pluginId) ?? [];
				if (!requested.some((r) => r.capability === 'agents:dispatch')) {
					throw new Error('DispatchNotRequested');
				}
				// Intersect the submitted ids with the live session set (only a real
				// agent is dispatchable) and drop any token that could corrupt the
				// comma-joined scope. Deduped, order-stable.
				const sessions = sessionsStore.get('sessions', []) as Array<{ id?: string }>;
				const existing = new Set(
					sessions.map((s) => s?.id).filter((id): id is string => typeof id === 'string')
				);
				const seen = new Set<string>();
				const members: string[] = [];
				for (const raw of agentIds) {
					if (!isValidAllowlistMember(raw) || !existing.has(raw) || seen.has(raw)) continue;
					seen.add(raw);
					members.push(raw);
				}
				// Fails when the plugin holds no agents:dispatch grant yet (not
				// consented) - the user must approve the capability at the consent
				// window before its scope can be edited here.
				if (!authStore.setAllowlistScope(pluginId, 'agents:dispatch', members)) {
					throw new Error('DispatchNotGranted');
				}
				logger.info(
					`[Plugins] agents:dispatch allowlist for "${pluginId}" set to ${members.length} agent(s): ${members.join(', ') || '(none)'}`,
					'[PluginAudit]'
				);
				return { requested, granted: authStore.readGrants(pluginId) };
			}
		);

		// Supervised plugin scheduler: fires plugins' declarative cue triggers
		// (interval / daily-time) on a poll loop. Self-gates on the plugins flag.
		// notify -> toast. Dispatch is risk-gated (evaluateScheduledDispatch): a
		// trigger is auto-eligible only when low/medium risk AND the plugin holds
		// agents:dispatch AND is trusted (signed). Eligible triggers are surfaced to
		// the user (notify); a blind auto-send sink is deliberately NOT wired because
		// a static manifest cueTrigger cannot safely address a runtime session id.
		const schedulerManager = pluginManager;
		// Expose the live manager + plugins-flag predicate to the web-server
		// message handlers (the MCP tool bridge) without threading it through
		// their constructor; mirrors the StatsDB singleton.
		setActivePluginManager(pluginManager, () => {
			const ef = store.get('encoreFeatures', {}) as Record<string, boolean>;
			return ef.plugins === true;
		});
		pluginScheduler = new PluginSchedulerHost({
			isEnabled: () => {
				const ef = store.get('encoreFeatures', {}) as Record<string, boolean>;
				return ef.plugins === true;
			},
			getTriggers: () => schedulerManager.getContributions().cueTriggers,
			notify: (trigger) => logger.toast(trigger.payload, `Plugin: ${trigger.pluginId}`),
			// FC3: the auto-dispatch sink. Only reached when evaluateDispatch judged
			// the trigger eligible (allowlist grant naming trigger.agentId + trusted
			// signature + separate unattended consent). Session addressing resolves
			// AT FIRE TIME through the same fail-closed helper as agents.dispatch;
			// a vanished/ambiguous target throws, the scheduler catches + logs, and
			// the trigger is skipped loudly rather than silently dropped.
			dispatch: (trigger) => {
				if (!trigger.agentId) {
					throw new Error(`cue trigger "${trigger.id}" has no agentId to dispatch to`);
				}
				// Synchronous: a vanished/ambiguous session or missing renderer throws
				// HERE, into the scheduler tick's try/catch - never a false success.
				dispatchPromptToSession(trigger.agentId, trigger.payload);
			},
			evaluateDispatch: (trigger) => {
				const rec = pluginManager?.getRegistry().records.find((r) => r.id === trigger.pluginId);
				const grants = grantsOf(trigger.pluginId);
				// Allowlist scope: the grant must NAME the trigger's target agent; a
				// scheduler tick is unattended, so the separate unattended consent on
				// that grant is also required (FC3 / phase-4 §8). Without either, the
				// verdict is ineligible and the trigger falls back to notify-only.
				return evaluateScheduledDispatch(trigger.payload, {
					hasDispatchGrant: isPermitted(grants, 'agents:dispatch', trigger.agentId),
					trusted: rec?.signature?.status === 'trusted',
					hasUnattendedConsent: isPermittedUnattended(grants, 'agents:dispatch', trigger.agentId),
				});
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
				safeSend('history:externalChange', sessionId);
				// Surface a metadata-only update to subscribed plugins (events:subscribe).
				pluginEventBus?.emit({
					topic: 'session.updated',
					at: new Date().toISOString(),
					payload: { sessionId },
				});
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
		setupIpcHandlers({
			getMainWindow: () => mainWindow,
			getProcessManager: () => processManager,
			getWebServer: () => webServer,
			setWebServer: (server) => {
				webServer = server;
			},
			getAgentDetector: () => agentDetector,
			getCueEngine: () => cueEngine,
			getPianolaSupervisor: () => pianolaSupervisor,
			getPluginManager: () => pluginManager,
			getPluginSandboxHost: () => pluginSandboxHost,
			getPluginGroupingRegistry: () => pluginGroupingRegistry,
			getPluginAuthStore: () => pluginAuthStore,
			getPluginEventBus: () => pluginEventBus,
			getInteractiveReplayController: () => interactiveReplayController,
			getTtsrRuntime: () => ttsrRuntime,
			setNoteSessionActivated: (fn) => {
				noteSessionActivatedInPersistence = fn;
			},
			app,
			settingsStore: store,
			sessionsStore,
			groupsStore,
			agentConfigsStore,
			windowStateStore,
			claudeSessionOriginsStore,
			agentSessionOriginsStore,
			bootstrapStore,
			safeSend,
			windowRegistry,
			windowManager,
			createWebServer,
			wakatimeManager,
			maestroCliManager,
			getAgentConfigForAgent,
			getCustomEnvVarsForAgent,
		});

		// Set up process event listeners
		logger.debug('Setting up process event listeners', 'Startup');
		wireProcessListeners({
			getProcessManager: () => processManager,
			getWebServer: () => webServer,
			getAgentDetector: () => agentDetector,
			getCueEngine: () => cueEngine,
			getPluginEventBus: () => pluginEventBus,
			safeSend,
			settingsStore: store,
			wakatimeManager,
		});

		// Wire agent-run lifecycle capture to the ProcessManager (F1). Always-on
		// per D1: minimal metadata capture is observability, not an opt-in feature.
		if (processManager) {
			try {
				setupAgentRunCapture(processManager);
				// F3 live push: forward every ledger write to the renderer + web clients.
				setAgentRunSink({
					runUpdated: (run) => {
						if (isWebContentsAvailable(mainWindow)) {
							mainWindow!.webContents.send('agentRun:updated', run);
						}
						webServer?.broadcastToAll({ type: 'agentRun:updated', run });
					},
					eventAppended: (event) => {
						if (isWebContentsAvailable(mainWindow)) {
							mainWindow!.webContents.send('agentRun:eventAppended', event);
						}
						webServer?.broadcastToAll({ type: 'agentRun:eventAppended', event });
					},
				});
				// F3: also watch the store files so CLI-origin writes (pianola/send/batch)
				// reach the renderer when the app is running (ISC-3.1).
				startAgentRunStoreWatcher();
				// F1/ISC-1.10 crash recovery: settle runs left non-terminal by a previous
				// crash. Runs once, before any new agent spawns; error-tolerant inside.
				setupAgentRunRecovery(processManager);
			} catch (err) {
				logger.warn('Failed to wire agent-run capture', 'Startup', { error: String(err) });
			}
		}

		// Start Cue engine if the Encore Feature flag is enabled
		const encoreFeatures = store.get('encoreFeatures', {}) as Record<string, boolean>;
		if (encoreFeatures.maestroCue && cueEngine) {
			logger.info('Maestro Cue Encore Feature enabled - starting Cue engine', 'Startup');
			try {
				cueEngine.start('system-boot');
			} catch (err) {
				void captureException(err);
				logger.error(
					`Cue engine failed to start at boot - will remain available for retry via Settings: ${err}`,
					'Startup'
				);
			}
		}

		// Start the Pianola supervisor unconditionally: it self-gates on the
		// pianola Encore flag (reconcile kills everything and spawns nothing when
		// off), and starting it always means its file-watch reconcile picks up
		// CLI/renderer changes the moment the feature is enabled, plus enabled
		// targets are relaunched on every app start.
		if (pianolaSupervisor) {
			try {
				pianolaSupervisor.start();
			} catch (err) {
				void captureException(err);
				logger.error(`Pianola supervisor failed to start at boot: ${err}`, 'Startup');
			}
		}

		// Start the Pianola re-learn scheduler unconditionally: it self-gates per
		// tick on the pianola Encore flag, so enabling the feature later begins the
		// cadence without a restart. Each run only PROPOSES (stages suggestions) and
		// relaunches stale supervised targets; it never overwrites live state.
		pianolaRelearnScheduler?.start();

		// Prime the plugin registry from disk, then watch the plugin directory so
		// manual/plugin-fixture edits hot-reload through the same refresh() path.
		// refresh() is a no-op (empty registry) when the plugins Encore flag is off,
		// so this is safe to call unconditionally.
		if (pluginManager) {
			try {
				// Copy trusted bundled first-party plugins into the plugins dir before
				// discovery. Trust-gated + idempotent, so it is safe to run every boot.
				seedBundledPlugins({
					trustedKeys: trustedKeysFor,
					onLog: (message) => logger.info(message, 'Startup'),
					onError: (error) => void captureException(error),
				});
				pluginManager.refresh();
				pluginManager.startWatching();
			} catch (err) {
				void captureException(err);
				logger.error(`Plugin manager failed to start at boot: ${err}`, 'Startup');
			}
		}
		// Start the plugin scheduler unconditionally: it self-gates per tick on the
		// plugins flag, so enabling the feature later begins firing without a restart.
		pluginScheduler?.start();

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
					// Explicit appMenu - uses a custom Quit item instead of `role: 'quit'`
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
					// Custom Edit menu - equivalent to `role: 'editMenu'` minus
					// `undo` / `redo`. Those built-in roles register Cmd+Z /
					// Cmd+Shift+Z as NSMenu-level accelerators that intercept the
					// keystroke at the OS layer before the renderer can see it
					// (same trap as `role: 'close'` eating Cmd+W - see the note
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

		// Restore the saved multi-window layout (or a single primary window when
		// there is nothing saved - backward compatible).
		logger.info('Restoring window layout', 'Startup');
		restoreWindows();

		// Wire the global "summon Maestro" hotkey. Register the saved binding (if
		// any) and re-register live when the setting changes from any source
		// (settings UI, CLI, external file edit).
		initGlobalHotkey(() => mainWindow);
		const initialHotkey = store.get('globalShowHotkey', []) as string[];
		if (Array.isArray(initialHotkey) && initialHotkey.length > 0) {
			const ok = setGlobalShowHotkey(initialHotkey);
			// intentionally not bridged: window-specific
			if (!ok && mainWindow && isWebContentsAvailable(mainWindow)) {
				mainWindow.webContents.send('globalHotkey:registrationFailed', initialHotkey);
			}
		}
		store.onDidChange('globalShowHotkey', (value) => {
			const keys = Array.isArray(value) ? (value as string[]) : [];
			const ok = setGlobalShowHotkey(keys);
			// intentionally not bridged: window-specific
			if (!ok && mainWindow && isWebContentsAvailable(mainWindow)) {
				mainWindow.webContents.send('globalHotkey:registrationFailed', keys);
			}
		});
		// Electron auto-unregisters globalShortcuts on quit, but be explicit so the
		// behavior survives any future change to that policy.
		app.on('will-quit', disposeGlobalHotkey);
		// TTSR repeat bookkeeping is written debounced; force the last write out so
		// a rule that fired seconds before quit is still remembered next launch.
		app.on('will-quit', () => ttsrRuntime?.flushState());

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
			// intentionally not bridged: window-specific
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
		// silently aborts initialization - historically the cause of the missing
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
		// Kill all managed PTY/child processes now so they don't leak - session
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
		// Kill all Pianola supervised children (watchers/orchestrations) and tear
		// down the store-file watcher so nothing is orphaned on quit. Idempotent.
		pianolaSupervisor?.stopAll();
		// Stop the Pianola re-learn cadence.
		pianolaRelearnScheduler?.stop();
		// Tear down plugin hot-reload watching and running sandboxes.
		pluginManager?.stopWatching();
		pluginManager?.stopAllSandboxes();
		// Clear background-service supervision state + pending restart timers
		// (after stopAllSandboxes so per-plugin onStop hooks fire first).
		pluginBackgroundSupervisor?.stopAll();
		// Stop the plugin scheduler poll loop.
		pluginScheduler?.stop();
		// Stop the coworking bridge socket so the file/pipe doesn't outlive the app.
		// Best-effort on quit, but capture unexpected failures so a stale socket on the
		// next launch is at least observable in Sentry.
		void stopCoworkingBridge().catch((error) => {
			void captureException(error instanceof Error ? error : new Error(String(error)), {
				operation: 'shutdown:coworkingBridge',
			});
			logger.warn(`Failed to stop coworking bridge: ${String(error)}`, 'Shutdown');
		});
		// Tear down the background quota refresh timers.
		usageRefreshScheduler?.stop();
	},
	stopSettingsWatcher: () => settingsWatcher.stop(),
	powerManager,
	stopSessionCleanup,
	getPersistedSessions: () => sessionsStore.get('sessions', []) as Array<Record<string, unknown>>,
	// Multi-window persistence: snapshot every window's layout to the window-state
	// store on quit so the next launch can restore it (see window-state-persistence).
	windowStateStore,
	getWindowRegistry: () => windowRegistry,
});
quitHandler.setup();
