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
import { createCueSupervisorHooks } from './cue/cue-first-party';
import { PianolaSupervisor } from './pianola/pianola-supervisor';
import { PianolaRelearnScheduler } from './pianola/pianola-relearn-scheduler';
import { runRelearnJob } from './pianola/pianola-relearn';
import { readRules, writeSuggestions, getProfile } from './pianola/pianola-store-main';
import type { DecisionPair } from '../shared/pianola/transcript-mining';
import type { PianolaRule } from '../shared/pianola/types';
import { spawn, execFile, type ChildProcess } from 'child_process';
import { PluginManager } from './plugins/plugin-manager';
import { SpawnBinaryRegistry } from './plugins/spawn-binary-registry';
import { transcriptReadEgressConflict } from '../shared/plugins/capability-policy';
import { evaluateScheduledDispatch } from '../shared/plugins/plugin-dispatch-gate';
import { PermissionBroker } from './plugins/permission-broker';
import { PluginSandboxHost } from './plugins/plugin-sandbox-host';
import { PluginBackgroundSupervisor } from './plugins/plugin-background-supervisor';
import { setActivePluginManager } from './plugins/plugin-manager-singleton';
import { PluginSchedulerHost } from './plugins/plugin-scheduler-host';
import {
	buildHostCallHandlers,
	purgePluginData,
	type PluginSessionMetadata,
	type PluginTabMetadata,
} from './plugins/plugin-host-handlers';
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
import {
	executeCuePrompt,
	recordCueHistoryEntry,
	stopCueRun,
	getCueProcessList,
} from './cue/cue-executor';
import { executeCueShell, stopCueShellRun } from './cue/cue-shell-executor';
import { executeCueCli, stopCueCliRun, resolveMaestroCliScriptPath } from './cue/cue-cli-executor';
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
	registerCrossAgentHandlers,
	registerCueHandlers,
	registerCueBackupHandlers,
	registerWakatimeHandlers,
	registerFeedbackHandlers,
	registerMaestroCliHandlers,
	registerPromptsHandlers,
	registerMemoryHandlers,
	registerPianolaHandlers,
	registerPluginsHandlers,
	registerAgentRunHandlers,
	registerCoworkingHandlers,
	registerBrowserSessionHandlers,
	registerWindowsHandlers,
	wireWindowRegistryBroadcast,
	wireEmptySecondaryWindowAutoClose,
	setupLoggerEventForwarding,
	cleanupAllGroomingSessions,
	getActiveGroomingSessionCount,
} from './ipc/handlers';
import { startCoworkingBridge, stopCoworkingBridge } from './coworking/coworking-bridge';
import { ensureCoworkingServerScript } from './coworking/coworking-server-paths';
import { resolveSessionFromPidWalk } from './coworking/pid-resolution';
import { initializeStatsDB, closeStatsDB, getStatsDB, wireMultiWindowTelemetry } from './stats';
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
import { resolveToFilePath, configureImageStore } from './storage/session-image-store';
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
	deliverCadenzaToHud,
	closeCadenzaHudWindow,
	getCadenzaHudWindow,
	type QuitHandler,
} from './app-lifecycle';
// Multi-window registry (single source of truth for window<->session ownership)
import { WindowRegistry } from './window-registry';
// Multi-window startup restore: turn the persisted MultiWindowState back into
// window-creation specs (pruning agents that no longer exist).
import {
	planWindowRestore,
	pickFocusWindowSpec,
	saveWindowState,
} from './window-state-persistence';
import type { WindowState as SharedWindowState } from '../shared/window-types';
// Phase 3 refactoring - process listeners
import { setupProcessListeners as setupProcessListenersModule } from './process-listeners';
import { setupAgentRunCapture } from './agent-run/setup-capture-listener';
import { setAgentRunSink } from './agent-run/broadcast';
import { startAgentRunStoreWatcher } from './agent-run/store-watcher';
import { setupAgentRunRecovery } from './agent-run/setup-recovery';
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
let pianolaSupervisor: PianolaSupervisor | null = null;
let pianolaRelearnScheduler: PianolaRelearnScheduler | null = null;
let pluginManager: PluginManager | null = null;
let pluginScheduler: PluginSchedulerHost | null = null;
let pluginSandboxHost: PluginSandboxHost | null = null;
let pluginBackgroundSupervisor: PluginBackgroundSupervisor | null = null;
let pluginAuthStore: AuthorizationStore | null = null;
let pluginEventBus: PluginEventBusImpl | null = null;
let usageRefreshScheduler: UsageRefreshScheduler | null = null;
let interactiveReplayController: InteractiveReplayController<ProcessSpawnConfig> | null = null;

/** Cap on decision pairs the scheduled re-learn pulls from the CLI per run. */
const RELEARN_MAX_PAIRS = 100_000;

/**
 * Mine the installed CLIs' native transcripts into a decision corpus by spawning
 * the existing `pianola learn --json` crawler (the single source of transcript
 * discovery + parsing) and parsing its `pairs`. Rejects on spawn/exit/parse
 * failure so a failed mine leaves the previously staged suggestions untouched.
 */
function mineDecisionPairsViaCli(): Promise<DecisionPair[]> {
	const cliScriptPath = resolveMaestroCliScriptPath();
	return new Promise<DecisionPair[]>((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(
				process.execPath,
				[cliScriptPath, 'pianola', 'learn', '--json', '--max-pairs', String(RELEARN_MAX_PAIRS)],
				{
					env: {
						...process.env,
						// In packaged Electron, process.execPath is the app binary, not
						// Node; without this it would launch the app instead of the CLI.
						ELECTRON_RUN_AS_NODE: '1',
						MAESTRO_CLI_JS: cliScriptPath,
					},
					stdio: ['ignore', 'pipe', 'pipe'],
				}
			);
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		let stdout = '';
		let stderr = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (d: string) => {
			stdout += d;
		});
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (d: string) => {
			stderr += d;
		});
		child.on('error', (err) => reject(err));
		child.on('exit', (code) => {
			if (code !== 0) {
				reject(new Error(`pianola learn exited ${code ?? 'null'}: ${stderr.trim().slice(0, 200)}`));
				return;
			}
			try {
				const parsed = JSON.parse(stdout) as { pairs?: unknown };
				resolve(Array.isArray(parsed.pairs) ? (parsed.pairs as DecisionPair[]) : []);
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	});
}

/**
 * Read the user's live rules and global decision-profile markdown for the
 * re-learn baseline. A missing or malformed profiles file degrades to an empty
 * baseline (getProfile already returns a well-formed empty result), so the job
 * stages a fresh draft rather than crashing.
 */
function readExistingForRelearn(): { rules: PianolaRule[]; profile: string } {
	return { rules: readRules(), profile: getProfile().entry?.profile ?? '' };
}

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

// Disabling Concerto must tear down the already-running always-on-top HUD, not
// merely reject future payloads. Without this listener, existing cards and the
// cursor hover poll survive after the user turns the extension off.
store.onDidChange('encoreFeatures', (encoreFeatures) => {
	if (encoreFeatures?.concerto !== true) closeCadenzaHudWindow();
});

/**
 * Route a cadenza payload to the HUD window (creating it lazily). Returns
 * false when there's no main window to parent it, so the caller can fall back
 * to the in-app renderer.
 */
function deliverCadenza(payload: Parameters<typeof deliverCadenzaToHud>[2]): boolean {
	if (!mainWindow) return false;
	// Concerto is an opt-in Encore feature: don't spawn the HUD window (or
	// route anything) unless the user enabled it in Extensions.
	if (store.get('encoreFeatures')?.concerto !== true) return false;
	// The HUD window has no session store, so resolve the owning agent's display
	// name here (for the "opened by X" attribution chip) and stamp it on.
	let stamped = payload;
	if (payload.sessionId && !payload.sourceAgent) {
		const sessions = sessionsStore.get('sessions', []) as Array<{ id?: string; name?: string }>;
		const sourceAgent = sessions.find((s) => s.id === payload.sessionId)?.name;
		if (sourceAgent) stamped = { ...payload, sourceAgent };
	}
	return deliverCadenzaToHud(mainWindow, cadenzaHudDeps, stamped);
}

// A `decision` cadenza's chosen option replies to the owning agent: inject the
// value as a live prompt into that agent's session via the main renderer's
// existing remote-command path (the same one `maestro-cli dispatch` uses). The
// agent process is already spawned (with SSH if configured), so feeding its live
// session inherits that transport - no new spawn, no separate SSH handling.
ipcMain.on('cadenza-hud:decision', (_event, sessionId: string, message: string) => {
	// Same Concerto gate as the other cadenza entry points: with the flag off no
	// decision card can exist, so a decision arriving anyway must not inject a
	// prompt into a live agent session.
	if (store.get('encoreFeatures')?.concerto !== true) return;
	if (!mainWindow || mainWindow.isDestroyed()) return;
	if (!sessionId || !message) return;
	// force=true (5th arg): a decision card is answered mid-turn, so the owning
	// agent is busy by definition; without the force flag the renderer's busy
	// guard would silently drop the choice while the UI reports it was sent.
	mainWindow.webContents.send('remote:executeCommand', sessionId, message, 'ai', undefined, true);
});

// A chat "point" chip that targets a cadenza asks main to pulse it. Cadenzas live
// in the HUD renderer (a separate window with its own store), so the flash must be
// routed to whichever renderer actually holds the card: the HUD window when it's
// up, otherwise the main window (the in-app fallback layer). Gated by Concerto so
// it's inert when off (no cadenzas exist then anyway).
ipcMain.on('cadenza:flash', (_event, id: string) => {
	if (!id) return;
	if (store.get('encoreFeatures')?.concerto !== true) return;
	const hud = getCadenzaHudWindow();
	const target = hud && !hud.isDestroyed() ? hud : mainWindow;
	if (target && !target.isDestroyed()) target.webContents.send('remote:cadenzaFlash', id);
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
		// Gate the OpenCode SDK-serve path behind the default-off
		// `encoreFeatures.opencodeServer` plugin. Read live on every spawn so the
		// Extensions toggle takes effect without an app restart.
		processManager = new ProcessManager(
			() => (store.get('encoreFeatures', {}) as Record<string, boolean>).opencodeServer === true
		);
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
		// L5 usage-stats lift: the sampling loop is the feature's supervised
		// `stats.sampler` background service — don't arm it when the user has
		// explicitly disabled the Usage & Stats tile. `!== false` (not `=== true`)
		// mirrors the renderer default (usageStats defaults ON and the merged
		// flag map may never have been persisted main-side).
		if ((store.get('encoreFeatures', {}) as Record<string, boolean>).usageStats !== false) {
			usageRefreshScheduler.start();
		}

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
				// Push activity updates to renderer (and web-desktop bridge clients)
				if (data) {
					safeSend('cue:activityUpdate', data);
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

		// Initialize the Pianola supervised daemon. It owns Pianola's background
		// watchers and orchestrations as supervised child processes (restart on
		// crash, relaunch on app start, visible health), replacing the unmanaged
		// nohup model. It self-gates on encoreFeatures.pianola and reconciles from a
		// shared store file that both the CLI and renderer write.
		pianolaSupervisor = new PianolaSupervisor({
			isEnabled: () => {
				const ef = store.get('encoreFeatures', {}) as Record<string, boolean>;
				return ef.pianola === true;
			},
			getPianolaAgentId: () => {
				const sessions = sessionsStore.get('sessions', []) as Array<{
					id?: string;
					isPianola?: boolean;
				}>;
				return sessions.find((s) => s?.isPianola === true)?.id;
			},
		});

		// Pianola scheduled re-learn: keeps the learned profile fresh as a PROPOSAL
		// (stages suggestions; never overwrites the live profile/rules) and
		// relaunches stale supervised targets, on a fixed cadence. Self-gates per
		// tick on encoreFeatures.pianola. Mining reuses the existing `pianola learn`
		// crawler via the bundled CLI; the composition is pure with injected deps.
		pianolaRelearnScheduler = new PianolaRelearnScheduler({
			isEnabled: () => {
				const ef = store.get('encoreFeatures', {}) as Record<string, boolean>;
				return ef.pianola === true;
			},
			runJob: async () => {
				await runRelearnJob({
					isEnabled: () => {
						const ef = store.get('encoreFeatures', {}) as Record<string, boolean>;
						return ef.pianola === true;
					},
					mine: mineDecisionPairsViaCli,
					readExisting: readExistingForRelearn,
					writeSuggestions,
					relaunchStale: () => pianolaSupervisor?.relaunchStale() ?? 0,
					now: Date.now,
					log: (line) => logger.info(line, '[PianolaRelearn]'),
				});
			},
		});

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
			return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
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
		// getFirstPartyBridge(flag) — this is the single construction site.
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
				// L5 usage-stats: `stats.sampler` — the background provider-quota
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

		const pluginBroker = new PermissionBroker({
			getGrants: (pluginId) => grantsOf(pluginId),
			// Structurally exclude the entire Maestro userData/config tree (grants,
			// enable-state, encoreFeatures + every setting, agent-configs,
			// cli-server.json token, the plugins dir, plugin KV, supervisor targets,
			// transcripts) from fs:read AND fs:write, enforced on the symlink-resolved
			// real path so no plugin fs scope can ever reach it.
			protectedPaths: () => [app.getPath('userData')],
			onDecision: (pluginId, method, decision) => {
				if (!decision.allowed) {
					logger.warn(
						`[Plugins] denied ${method} for "${pluginId}": ${decision.reason ?? ''}`,
						'[Plugins]'
					);
				}
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
		const pluginTabsFocus = async (tabId: string): Promise<boolean> => {
			const sessions = pluginSessionsRaw();
			let focused = false;
			const next = sessions.map((session) => {
				if ((Array.isArray(session.aiTabs) ? session.aiTabs : []).some((t) => t?.id === tabId)) {
					focused = true;
					sessionsStore.set('activeSessionId', session.id as string);
					return {
						...session,
						activeTabId: tabId,
						activeFileTabId: null,
						activeBrowserTabId: null,
						activeTerminalTabId: null,
						inputMode: 'ai',
					};
				}
				if (
					(Array.isArray(session.terminalTabs) ? session.terminalTabs : []).some(
						(t) => t?.id === tabId
					)
				) {
					focused = true;
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
			if (focused) setPluginSessionsRaw(next);
			return focused;
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
			// runnable plugin that is not running — i.e. the crashed one.
			restartPlugin: () => pluginManager?.refresh(),
			isPluginEnabled: (pluginId) =>
				pluginManager?.getRegistry().records.some((r) => r.id === pluginId && r.enabled) ?? false,
		});
		pluginBackgroundSupervisor = backgroundSupervisor;

		// Shared FC2/FC3 dispatch sink: resolve a runtime session FAIL-CLOSED
		// (exact session id, else exact UNIQUE name — ambiguity is an error, never
		// a guess), audit the resolved id, then hand the prompt to the renderer —
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
						? `agents.dispatch: "${agentId}" matches ${byName.length} sessions — use the session id`
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

		// Host-owned spawn binary allowlist (FC2 / phase-4 §2). Ships EMPTY —
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
				sessionsCreate: pluginSessionsCreate,
				sessionsUpdate: pluginSessionsUpdate,
				sessionsDelete: pluginSessionsDelete,
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
				// signature status. Lazy — pluginManager is assigned below; handlers
				// only run once the sandbox is up. Fail-closed when absent.
				isPluginTrusted: (pluginId) =>
					pluginManager?.getRegistry().records.find((r) => r.id === pluginId)?.signature?.status ===
					'trusted',
				dispatch: async (agentId, prompt) => dispatchPromptToSession(agentId, prompt),
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
			}),
			onLog: (pluginId, level, message) => {
				logger.info(`[Plugin:${pluginId}] ${level}: ${message}`, '[Plugins]');
			},
			onCrash: (pluginId, code) => {
				pluginResourceCleanup?.(pluginId);
				logger.warn(`[Plugins] plugin "${pluginId}" crashed (code ${code})`, '[Plugins]');
				backgroundSupervisor.onPluginCrash(pluginId, code);
			},
			onStop: (pluginId) => {
				pluginResourceCleanup?.(pluginId);
				backgroundSupervisor.onPluginStopped(pluginId);
			},
		});
		pluginSandboxHost = sandboxHost;
		pluginManager = new PluginManager({
			isEnabled: () => {
				const ef = store.get('encoreFeatures', {}) as Record<string, boolean>;
				return ef.plugins === true;
			},
			trustedKeys: () => {
				const keys = store.get('pluginTrustedKeys', []) as unknown;
				return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
			},
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
				});
				backgroundSupervisor.teardown(id);
			},
			onChange: (registry) => {
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
						? `the consent request expired or was superseded — try again.`
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
				// HERE, into the scheduler tick's try/catch — never a false success.
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
		setupIpcHandlers();

		// Set up process event listeners
		logger.debug('Setting up process event listeners', 'Startup');
		setupProcessListeners();

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
		getMainWindow: () => mainWindow,
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
		emitPluginEvent: (event) => pluginEventBus?.emit(event),
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
		getMainWindow: () => mainWindow,
	});

	// Cross-agent @mention dispatch - streams a target agent's response back
	// into the source agent's transcript (Phase 03).
	registerCrossAgentHandlers({
		getProcessManager: () => processManager,
		getAgentDetector: () => agentDetector,
		sessionsStore,
		agentConfigsStore,
		sshStore: createSshRemoteStoreAdapter(store),
		getCustomEnvVars: getCustomEnvVarsForAgent,
		safeSend,
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
		// Metadata-only session/agent lifecycle -> subscribed plugins. Null-safe:
		// the bus is created during plugin init and re-authorizes every delivery
		// against live grants, so this is a no-op when plugins are disabled.
		emitPluginEvent: (event) => pluginEventBus?.emit(event),
		safeSend,
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

	// Register Pianola handlers (autonomous manager: rules, decisions, and the
	// supervised daemon). The supervisor is constructed during core-service init
	// above, so it is available here; guard anyway to keep types honest.
	if (pianolaSupervisor) {
		registerPianolaHandlers({
			settingsStore: store,
			supervisor: pianolaSupervisor,
		});
	}

	// Register Plugins handlers (community plugin subsystem, list-only in Phase 0).
	// The manager is constructed during core-service init above; guard for types.
	if (pluginManager && pluginAuthStore) {
		registerPluginsHandlers({
			settingsStore: store,
			manager: pluginManager,
			sandboxHost: pluginSandboxHost ?? undefined,
			authStore: pluginAuthStore,
		});
	}

	// Register AgentRun control-plane handlers (neutral run/campaign ledger).
	registerAgentRunHandlers({
		getProcessManager: () => processManager,
		settingsStore: store,
	});

	// Register Browser Session handlers (clear per-partition browsing data)
	registerBrowserSessionHandlers();

	// Register Coworking handlers + start the IPC bridge socket and refresh the bundled
	// MCP-server script. The bridge runs whenever Maestro is up; per-agent activation
	// is opt-in via Settings → Encore Features → Coworking Setup. Bridge startup is
	// non-fatal - feature degrades to "not available" until next launch.
	registerCoworkingHandlers({ getMainWindow: () => mainWindow });
	void (async () => {
		try {
			await ensureCoworkingServerScript();
			await startCoworkingBridge({
				resolveSessionFromPid: (pid) =>
					resolveSessionFromPidWalk(
						pid,
						(candidate) => processManager?.getSessionIdByPid(candidate) ?? null
					),
			});
		} catch (err) {
			void captureException(err instanceof Error ? err : new Error(String(err)), {
				operation: 'startup:coworkingBridge',
			});
			logger.warn(`Failed to start coworking bridge: ${String(err)}`, 'Startup');
		}
	})();
	// Register multi-window handlers (windows:* channel surface). Registered here
	// because the running app wires handlers through setupIpcHandlers(), not
	// registerAllHandlers(). The registry and window manager are module-scope
	// instances; lazy getters resolve the live instance at call time.
	registerWindowsHandlers({
		getWindowRegistry: () => windowRegistry,
		getWindowManager: () => windowManager,
	});
	// Push registry ownership moves out to every window so each renderer's
	// WindowContext can refresh which agents it surfaces (and the Left Bar's
	// cross-window badges). The registry is a module-scope instance, so pass it
	// directly rather than through the handlers' lazy getter.
	wireWindowRegistryBroadcast(windowRegistry);
	// Close a secondary window as soon as its last agent moves out - an empty
	// secondary shell can surface nothing (every agent is owned by some window),
	// so the agent-level move flow tidies it up automatically.
	wireEmptySecondaryWindowAutoClose(windowRegistry);
	// Persist a window rename or a panel-collapse toggle as soon as it happens
	// (rather than only on quit), so both survive even an abrupt exit. A panel
	// toggle fires no window move/resize, so without this its saved value would go
	// stale. saveWindowState snapshots the whole live registry, so passing the
	// affected window's id is enough.
	windowRegistry.onChange((change) => {
		if ((change.type === 'name-changed' || change.type === 'panel-changed') && change.windowId) {
			saveWindowState(windowStateStore, windowRegistry, change.windowId);
		}
	});

	// Record aggregate multi-window usage telemetry (secondary windows opened +
	// peak concurrent windows) as windows open. Gated on the user's
	// `statsCollectionEnabled` analytics setting; records nothing when off, and a
	// stats failure can never break window creation (see wireMultiWindowTelemetry).
	wireMultiWindowTelemetry(windowRegistry, { settingsStore: store });
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
		getMainWindow: () => mainWindow,
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
			emitPluginEvent: (event) => pluginEventBus?.emit(event),
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
