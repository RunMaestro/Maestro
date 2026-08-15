/**
 * Single-entry orchestrator for all IPC handler registrations plus a handful
 * of inline wiring blocks (group-chat mention/session callbacks, the
 * coworking bridge startup, window-registry persistence).
 *
 * Extracted verbatim out of main/index.ts's setupIpcHandlers() (Phase 5
 * refactoring) - same call order preserved exactly, including the
 * currently-dead-but-present raw `mainWindow` field passed alongside
 * `getMainWindow` into registerAutorunHandlers/registerPlaybooksHandlers
 * (only the getter is ever read; do not "clean this up", it's tracked as a
 * separate follow-up).
 */

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
	registerParquetHandlers,
	registerAttachmentsHandlers,
	registerWebHandlers,
	registerLeaderboardHandlers,
	registerNotificationsHandlers,
	registerSymphonyHandlers,
	registerTabNamingHandlers,
	registerAiCommandHandlers,
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
	registerTabsHandlers,
	registerContextTimelineHandlers,
	registerPianolaHandlers,
	registerACappellaHandlers,
	registerPluginsHandlers,
	registerAgentRunHandlers,
	registerCoworkingHandlers,
	registerBrowserSessionHandlers,
	registerWindowsHandlers,
	wireWindowRegistryBroadcast,
	wireEmptySecondaryWindowAutoClose,
	setupLoggerEventForwarding,
} from '../handlers';
import { wireMultiWindowTelemetry } from '../../stats';
import { saveWindowState } from '../../window-state-persistence';
import { ensureCoworkingServerScript } from '../../coworking/coworking-server-paths';
import { startCoworkingBridge } from '../../coworking/coworking-bridge';
import { resolveSessionFromPidWalk } from '../../coworking/pid-resolution';
import { initializeOutputParsers } from '../../parsers';
import { initializeSessionStorages } from '../../storage';
import { getCueProcessList } from '../../cue/cue-executor';
import { getSshRemoteById } from '../../stores';
import { createSshRemoteStoreAdapter } from '../../utils/ssh-remote-resolver';
import { tunnelManager } from '../../tunnel-manager';
import { captureException } from '../../utils/sentry';
import { logger } from '../../utils/logger';
import {
	setGetSessionsCallback,
	setGetCustomEnvVarsCallback,
	setGetAgentConfigCallback,
	setGetModeratorSettingsCallback,
	setSshStore,
	setGetCustomShellPathCallback,
} from '../../group-chat/group-chat-router';
import { mapSessionsForMentions } from './session-mention-mapper';
import type { IpcBootstrapDependencies } from './types';

export type { IpcBootstrapDependencies } from './types';

export function setupIpcHandlers(deps: IpcBootstrapDependencies): void {
	// Settings, sessions, and groups persistence - extracted to src/main/ipc/handlers/persistence.ts

	// Web/Live handlers - extracted to src/main/ipc/handlers/web.ts
	registerWebHandlers({
		getWebServer: deps.getWebServer,
		setWebServer: deps.setWebServer,
		createWebServer: deps.createWebServer,
		settingsStore: deps.settingsStore,
	});

	// Git operations - extracted to src/main/ipc/handlers/git.ts
	registerGitHandlers({
		settingsStore: deps.settingsStore,
		getMainWindow: deps.getMainWindow,
	});

	// Auto Run operations - extracted to src/main/ipc/handlers/autorun.ts
	registerAutorunHandlers({
		mainWindow: deps.getMainWindow(),
		getMainWindow: deps.getMainWindow,
		app: deps.app,
		settingsStore: deps.settingsStore,
	});

	// Playbook operations - extracted to src/main/ipc/handlers/playbooks.ts
	registerPlaybooksHandlers({
		mainWindow: deps.getMainWindow(),
		getMainWindow: deps.getMainWindow,
		app: deps.app,
	});

	// History operations - extracted to src/main/ipc/handlers/history.ts
	// Uses HistoryManager singleton for per-session storage
	registerHistoryHandlers({
		safeSend: deps.safeSend,
		emitPluginEvent: (event) => deps.getPluginEventBus()?.emit(event),
		getMaxEntries: () => deps.settingsStore.get('maxLogBuffer', 5000) as number,
		getSshRemoteById,
		getSessionById: (id: string) => {
			const sessions = (
				deps.sessionsStore.get('sessions', []) as Array<Record<string, unknown>>
			).filter((s) => typeof s === 'object' && s !== null);
			return sessions.find((s) => s.id === id);
		},
	});

	// Director's Notes - unified history + synopsis generation
	registerDirectorNotesHandlers({
		getProcessManager: deps.getProcessManager,
		getAgentDetector: deps.getAgentDetector,
		agentConfigsStore: deps.agentConfigsStore,
		getMainWindow: deps.getMainWindow,
	});

	// Cross-agent @mention dispatch - streams a target agent's response back
	// into the source agent's transcript (Phase 03).
	registerCrossAgentHandlers({
		getProcessManager: deps.getProcessManager,
		getAgentDetector: deps.getAgentDetector,
		sessionsStore: deps.sessionsStore,
		agentConfigsStore: deps.agentConfigsStore,
		settingsStore: deps.settingsStore,
		sshStore: createSshRemoteStoreAdapter(deps.settingsStore),
		getCustomEnvVars: deps.getCustomEnvVarsForAgent,
		safeSend: deps.safeSend,
	});

	// Cue - event-driven automation engine
	registerCueHandlers({
		getCueEngine: deps.getCueEngine,
	});

	// Cue Backup - snapshot / restore .maestro/cue.yaml + prompts (Cue modal Backup tab)
	registerCueBackupHandlers({
		sessionsStore: deps.sessionsStore,
	});

	// Agent management operations - extracted to src/main/ipc/handlers/agents.ts
	registerAgentsHandlers({
		getAgentDetector: deps.getAgentDetector,
		agentConfigsStore: deps.agentConfigsStore,
		settingsStore: deps.settingsStore,
		sessionsStore: deps.sessionsStore,
	});

	// Process management operations - extracted to src/main/ipc/handlers/process.ts
	registerProcessHandlers({
		getProcessManager: deps.getProcessManager,
		getAgentDetector: deps.getAgentDetector,
		agentConfigsStore: deps.agentConfigsStore,
		settingsStore: deps.settingsStore,
		getMainWindow: deps.getMainWindow,
		safeSend: deps.safeSend,
		sessionsStore: deps.sessionsStore,
		interactiveReplayController: deps.getInteractiveReplayController() ?? undefined,
		getCueProcesses: () => {
			// Always query the executor's active process map - processes may still be
			// running even if the engine has been disabled (in-flight runs complete
			// independently of engine state).
			const processList = getCueProcessList();
			if (processList.length === 0) return [];
			const activeRuns = deps.getCueEngine()?.getActiveRuns() ?? [];
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
	const persistenceHandlers = registerPersistenceHandlers({
		settingsStore: deps.settingsStore,
		sessionsStore: deps.sessionsStore,
		groupsStore: deps.groupsStore,
		getWebServer: deps.getWebServer,
		// Metadata-only session/agent lifecycle -> subscribed plugins. Null-safe:
		// the bus is created during plugin init and re-authorizes every delivery
		// against live grants, so this is a no-op when plugins are disabled.
		emitPluginEvent: (event) => deps.getPluginEventBus()?.emit(event),
	});
	// Wire the plugin focus verbs into the persistence layer's session.activated
	// dedupe so the two emit paths share one last-emitted id.
	deps.setNoteSessionActivated(persistenceHandlers.noteSessionActivated);

	// System operations - extracted to src/main/ipc/handlers/system.ts
	registerSystemHandlers({
		getMainWindow: deps.getMainWindow,
		app: deps.app,
		settingsStore: deps.settingsStore,
		tunnelManager,
		getWebServer: deps.getWebServer,
		bootstrapStore: deps.bootstrapStore, // For iCloud/sync settings
	});

	// Claude Code sessions - extracted to src/main/ipc/handlers/claude.ts
	registerClaudeHandlers({
		claudeSessionOriginsStore: deps.claudeSessionOriginsStore,
		getMainWindow: deps.getMainWindow,
	});

	// Initialize output parsers for all agents (Codex, OpenCode, Claude Code)
	// This must be called before any agent output is processed
	initializeOutputParsers();

	// Initialize session storages and register generic agent sessions handlers
	// This provides the new window.maestro.agentSessions.* API
	// Pass the shared claudeSessionOriginsStore so session names/stars are consistent
	initializeSessionStorages({ claudeSessionOriginsStore: deps.claudeSessionOriginsStore });
	registerAgentSessionsHandlers({
		getMainWindow: deps.getMainWindow,
		agentSessionOriginsStore: deps.agentSessionOriginsStore,
	});

	// Register Group Chat handlers
	registerGroupChatHandlers({
		getMainWindow: deps.getMainWindow,
		getProcessManager: deps.getProcessManager,
		getAgentDetector: deps.getAgentDetector,
		getCustomEnvVars: deps.getCustomEnvVarsForAgent,
		getAgentConfig: deps.getAgentConfigForAgent,
	});

	// Register Debug Package handlers
	registerDebugHandlers({
		getMainWindow: deps.getMainWindow,
		getAgentDetector: deps.getAgentDetector,
		getProcessManager: deps.getProcessManager,
		getWebServer: deps.getWebServer,
		settingsStore: deps.settingsStore,
		sessionsStore: deps.sessionsStore,
		groupsStore: deps.groupsStore,
		bootstrapStore: deps.bootstrapStore,
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

	// Register tab lifecycle handlers (renderer -> main tab-close notification)
	registerTabsHandlers();

	// Register Context Timeline capture handlers (per-agent turn history backfill).
	// The renderer calls these on every panel open and timeline clear, so leaving
	// them out makes `contextTimeline:*` reject with "No handler registered"
	// (MAESTRO-YV) and the panel silently starts empty after a reload.
	registerContextTimelineHandlers();

	// Register Pianola handlers (autonomous manager: rules, decisions, and the
	// supervised daemon). The supervisor is constructed during core-service init
	// above, so it is available here; guard anyway to keep types honest.
	const pianolaSupervisor = deps.getPianolaSupervisor();
	if (pianolaSupervisor) {
		registerPianolaHandlers({
			settingsStore: deps.settingsStore,
			supervisor: pianolaSupervisor,
		});
	}

	// Register A Cappella handlers (voice sessions). Registration is free: the
	// session service, its providers, and the dispatch executor are all built
	// lazily on the first start-session, so an app with the Encore Feature off
	// pays nothing for these channels being present.
	registerACappellaHandlers({
		settingsStore: deps.settingsStore,
		getMainWindow: deps.getMainWindow,
		safeSend: deps.safeSend,
	});

	// Register Plugins handlers (community plugin subsystem, list-only in Phase 0).
	// The manager is constructed during core-service init above; guard for types.
	const pluginManager = deps.getPluginManager();
	const pluginAuthStore = deps.getPluginAuthStore();
	if (pluginManager && pluginAuthStore) {
		registerPluginsHandlers({
			settingsStore: deps.settingsStore,
			manager: pluginManager,
			sandboxHost: deps.getPluginSandboxHost() ?? undefined,
			authStore: pluginAuthStore,
			groupingRegistry: deps.getPluginGroupingRegistry() ?? undefined,
		});
	}

	// Register AgentRun control-plane handlers (neutral run/campaign ledger).
	registerAgentRunHandlers({
		getProcessManager: deps.getProcessManager,
		settingsStore: deps.settingsStore,
	});

	// Register Browser Session handlers (clear per-partition browsing data)
	registerBrowserSessionHandlers();

	// Register Coworking handlers + start the IPC bridge socket and refresh the bundled
	// MCP-server script. The bridge runs whenever Maestro is up; per-agent activation
	// is opt-in via Settings -> Encore Features -> Coworking Setup. Bridge startup is
	// non-fatal - feature degrades to "not available" until next launch.
	registerCoworkingHandlers({ getMainWindow: deps.getMainWindow });
	void (async () => {
		try {
			await ensureCoworkingServerScript();
			await startCoworkingBridge({
				resolveSessionFromPid: (pid) =>
					resolveSessionFromPidWalk(
						pid,
						(candidate) => deps.getProcessManager()?.getSessionIdByPid(candidate) ?? null
					),
			});
		} catch (err) {
			// EADDRINUSE means another Maestro process already owns the bridge
			// socket/pipe for this userData slug. Bridge startup is deliberately
			// non-fatal (the feature degrades to "not available" until the next
			// launch), so a second instance losing the race is an expected
			// outcome rather than a defect worth reporting (MAESTRO-WH).
			const code = (err as NodeJS.ErrnoException | null)?.code;
			if (code !== 'EADDRINUSE') {
				void captureException(err instanceof Error ? err : new Error(String(err)), {
					operation: 'startup:coworkingBridge',
				});
			}
			logger.warn(`Failed to start coworking bridge: ${String(err)}`, 'Startup');
		}
	})();
	// Register multi-window handlers (windows:* channel surface). Registered here
	// because the running app wires handlers through setupIpcHandlers(), not
	// registerAllHandlers(). The registry and window manager are module-scope
	// instances; lazy getters resolve the live instance at call time.
	registerWindowsHandlers({
		getWindowRegistry: () => deps.windowRegistry,
		getWindowManager: () => deps.windowManager,
	});
	// Push registry ownership moves out to every window so each renderer's
	// WindowContext can refresh which agents it surfaces (and the Left Bar's
	// cross-window badges). The registry is a module-scope instance, so pass it
	// directly rather than through the handlers' lazy getter.
	wireWindowRegistryBroadcast(deps.windowRegistry);
	// Close a secondary window as soon as its last agent moves out - an empty
	// secondary shell can surface nothing (every agent is owned by some window),
	// so the agent-level move flow tidies it up automatically.
	wireEmptySecondaryWindowAutoClose(deps.windowRegistry);
	// Persist a window rename or a panel-collapse toggle as soon as it happens
	// (rather than only on quit), so both survive even an abrupt exit. A panel
	// toggle fires no window move/resize, so without this its saved value would go
	// stale. saveWindowState snapshots the whole live registry, so passing the
	// affected window's id is enough.
	deps.windowRegistry.onChange((change) => {
		if ((change.type === 'name-changed' || change.type === 'panel-changed') && change.windowId) {
			saveWindowState(deps.windowStateStore, deps.windowRegistry, change.windowId);
		}
	});

	// Record aggregate multi-window usage telemetry (secondary windows opened +
	// peak concurrent windows) as windows open. Gated on the user's
	// `statsCollectionEnabled` analytics setting; records nothing when off, and a
	// stats failure can never break window creation (see wireMultiWindowTelemetry).
	wireMultiWindowTelemetry(deps.windowRegistry, { settingsStore: deps.settingsStore });
	// Register Context Merge handlers for session context transfer and grooming
	registerContextHandlers({
		getMainWindow: deps.getMainWindow,
		getProcessManager: deps.getProcessManager,
		getAgentDetector: deps.getAgentDetector,
		agentConfigsStore: deps.agentConfigsStore,
		// Grooming reads the utility-agent selection at spawn time.
		settingsStore: deps.settingsStore,
	});

	// Register Marketplace handlers for fetching and importing playbooks
	registerMarketplaceHandlers({
		app: deps.app,
		settingsStore: deps.settingsStore,
		getMainWindow: deps.getMainWindow,
	});

	// Register Stats handlers for usage tracking
	registerStatsHandlers({
		getMainWindow: deps.getMainWindow,
		settingsStore: deps.settingsStore,
	});

	// Register Cue Stats handlers for the Cue Dashboard aggregation query.
	// Pass `getCueEngine` so the handler can fall back to the live cue config
	// when persisted `pipeline_id` is null (legacy events / events recorded
	// before lineage tracking was enabled).
	registerCueStatsHandlers({
		settingsStore: deps.settingsStore,
		getCueEngine: deps.getCueEngine,
	});

	// Register Document Graph handlers for file watching
	registerDocumentGraphHandlers({
		getMainWindow: deps.getMainWindow,
		app: deps.app,
	});

	// Register SSH Remote handlers for managing SSH configurations
	registerSshRemoteHandlers({
		settingsStore: deps.settingsStore,
	});

	// Set up callback for group chat router to lookup sessions for auto-add @mentions
	setGetSessionsCallback(() =>
		mapSessionsForMentions(deps.sessionsStore.get('sessions', []), getSshRemoteById)
	);

	// Set up callback for group chat router to lookup custom env vars for agents
	setGetCustomEnvVarsCallback(deps.getCustomEnvVarsForAgent);
	setGetAgentConfigCallback(deps.getAgentConfigForAgent);

	// Set up callback for group chat router to get moderator conductor profile
	setGetModeratorSettingsCallback(() => ({
		conductorProfile: (deps.settingsStore.get('conductorProfile', '') as string) || '',
	}));

	// Set up SSH store for group chat SSH remote execution support
	setSshStore(createSshRemoteStoreAdapter(deps.settingsStore));

	// Set up callback for group chat to get custom shell path (for Windows PowerShell preference)
	// This is used by both group-chat-router.ts and group-chat-agent.ts via the shared config module
	const getCustomShellPathFn = () =>
		deps.settingsStore.get('customShellPath', '') as string | undefined;
	setGetCustomShellPathCallback(getCustomShellPathFn);

	// Setup logger event forwarding to renderer
	setupLoggerEventForwarding(deps.getMainWindow);

	// Register filesystem handlers (extracted to handlers/filesystem.ts)
	registerFilesystemHandlers();

	// Parquet preview handlers. Registered HERE, not only in registerAllHandlers()
	// - that function is dead code, so a registration that lives solely there
	// never runs and every Parquet preview fails with no handler.
	registerParquetHandlers();

	// System operations (dialog, fonts, shells, tunnel, devtools, updates, logger)
	// extracted to src/main/ipc/handlers/system.ts

	// Claude Code sessions - extracted to src/main/ipc/handlers/claude.ts

	// Agent Error Handling API - extracted to src/main/ipc/handlers/agent-error.ts
	registerAgentErrorHandlers();

	// Register notification handlers (extracted to handlers/notifications.ts)
	registerNotificationsHandlers({ getMainWindow: deps.getMainWindow });

	// Register attachments handlers (extracted to handlers/attachments.ts)
	registerAttachmentsHandlers({ app: deps.app });

	// Register leaderboard handlers (extracted to handlers/leaderboard.ts)
	registerLeaderboardHandlers({
		app: deps.app,
		settingsStore: deps.settingsStore,
	});

	// Register Symphony handlers for token donation / open source contributions
	registerSymphonyHandlers({
		app: deps.app,
		getMainWindow: deps.getMainWindow,
		sessionsStore: deps.sessionsStore,
		settingsStore: deps.settingsStore,
	});

	// Register tab naming handlers for automatic tab naming
	registerTabNamingHandlers({
		getProcessManager: deps.getProcessManager,
		getAgentDetector: deps.getAgentDetector,
		agentConfigsStore: deps.agentConfigsStore,
		settingsStore: deps.settingsStore,
	});

	// AI Command handlers (plain-English request -> one shell command line).
	// Same dependency shape as tab naming: both spawn a short-lived agent turn.
	registerAiCommandHandlers({
		getProcessManager: deps.getProcessManager,
		getAgentDetector: deps.getAgentDetector,
		agentConfigsStore: deps.agentConfigsStore,
		settingsStore: deps.settingsStore,
	});

	// Register WakaTime handlers (CLI check, API key validation)
	registerWakatimeHandlers(deps.wakatimeManager);

	// Register Maestro CLI handlers (status check + install/update)
	registerMaestroCliHandlers(deps.maestroCliManager);

	// Register feedback handlers (gh auth + feedback submission)
	registerFeedbackHandlers({
		getProcessManager: deps.getProcessManager,
		debugPackageDeps: {
			getAgentDetector: deps.getAgentDetector,
			getProcessManager: deps.getProcessManager,
			getWebServer: deps.getWebServer,
			settingsStore: deps.settingsStore,
			sessionsStore: deps.sessionsStore,
			groupsStore: deps.groupsStore,
			bootstrapStore: deps.bootstrapStore,
		},
	});
}
