/**
 * IPC Handler Registration Module
 *
 * This module consolidates all IPC handler registrations, extracted from the main index.ts
 * to improve code organization and maintainability.
 *
 * Each handler module exports a register function that sets up the relevant ipcMain.handle calls.
 */

import { BrowserWindow, App } from 'electron';
import Store from 'electron-store';
import type { AgentConfigsData, ClaudeSessionOriginsData } from '../../stores/types';
import { registerGitHandlers, GitHandlerDependencies } from './git';
import { registerAutorunHandlers } from './autorun';
import { registerPlaybooksHandlers } from './playbooks';
import { registerHistoryHandlers, HistoryHandlerDependencies } from './history';
import { registerAgentsHandlers, AgentsHandlerDependencies } from './agents';
import { registerProcessHandlers, ProcessHandlerDependencies } from './process';
import {
	registerPersistenceHandlers,
	PersistenceHandlerDependencies,
	MaestroSettings,
	SessionsData,
	GroupsData,
} from './persistence';
import {
	registerSystemHandlers,
	setupLoggerEventForwarding,
	SystemHandlerDependencies,
} from './system';
import { registerClaudeHandlers, ClaudeHandlerDependencies } from './claude';
import { registerAgentSessionsHandlers, AgentSessionsHandlerDependencies } from './agentSessions';
import { registerGroupChatHandlers, GroupChatHandlerDependencies } from './groupChat';
import { registerDebugHandlers, DebugHandlerDependencies } from './debug';
import { registerSpeckitHandlers } from './speckit';
import { registerOpenSpecHandlers } from './openspec';
import { registerBmadHandlers } from './bmad';
import {
	registerContextHandlers,
	ContextHandlerDependencies,
	cleanupAllGroomingSessions,
	getActiveGroomingSessionCount,
} from './context';
import { registerMarketplaceHandlers, MarketplaceHandlerDependencies } from './marketplace';
import { registerStatsHandlers, StatsHandlerDependencies } from './stats';
import { registerCueStatsHandlers, CueStatsHandlerDependencies } from './cue-stats';
import { registerDocumentGraphHandlers, DocumentGraphHandlerDependencies } from './documentGraph';
import { registerSshRemoteHandlers, SshRemoteHandlerDependencies } from './ssh-remote';
import { registerFilesystemHandlers } from './filesystem';
import { registerAttachmentsHandlers, AttachmentsHandlerDependencies } from './attachments';
import {
	registerWebHandlers,
	ensureCliServer,
	startCliDiscoveryWatchdog,
	stopCliDiscoveryWatchdog,
	WebHandlerDependencies,
} from './web';
import { registerLeaderboardHandlers, LeaderboardHandlerDependencies } from './leaderboard';
import { registerNotificationsHandlers } from './notifications';
import { registerSymphonyHandlers, SymphonyHandlerDependencies } from './symphony';
import { registerAgentErrorHandlers } from './agent-error';
import { registerTabNamingHandlers, TabNamingHandlerDependencies } from './tabNaming';
import { registerDirectorNotesHandlers, DirectorNotesHandlerDependencies } from './director-notes';
import { registerCrossAgentHandlers } from './cross-agent';
import { registerCueHandlers, CueHandlerDependencies } from './cue';
import { registerCueBackupHandlers } from './cue-backup';
import { registerPianolaHandlers, PianolaHandlerDependencies } from './pianola';
import { registerPluginsHandlers, PluginsHandlerDependencies } from './plugins';
import { registerWakatimeHandlers } from './wakatime';
import { registerCoworkingHandlers } from './coworking';
import { registerBrowserSessionHandlers } from './browser-session';
import { registerFeedbackHandlers } from './feedback';
import { registerMaestroCliHandlers } from './maestro-cli';
import { registerPromptsHandlers } from './prompts';
import { registerMemoryHandlers } from './memory';
import { registerAgentRunHandlers } from './agent-run';
import {
	registerWindowsHandlers,
	wireWindowRegistryBroadcast,
	wireEmptySecondaryWindowAutoClose,
	WindowsHandlerDependencies,
} from './windows';
import { registerAccountHandlers, AccountHandlerDependencies } from './accounts';
import { AgentDetector } from '../../agents';
import type { AccountRegistry } from '../../accounts/account-registry';
import { ProcessManager } from '../../process-manager';
import { WebServer } from '../../web-server';
import type { WindowRegistry } from '../../window-registry';
import type { WindowManager } from '../../app-lifecycle/window-manager';
import { tunnelManager as tunnelManagerInstance } from '../../tunnel-manager';
import { createSafeSend } from '../../utils/safe-send';
import { getSshRemoteById } from '../../stores/getters';

// Type for tunnel manager instance
type TunnelManagerType = typeof tunnelManagerInstance;

// Re-export individual handlers for selective registration
export { registerGitHandlers };
export { registerAutorunHandlers };
export { registerPlaybooksHandlers };
export { registerHistoryHandlers };
export type { HistoryHandlerDependencies };
export { registerAgentsHandlers };
export { registerProcessHandlers };
export { registerPersistenceHandlers };
export { registerSystemHandlers, setupLoggerEventForwarding };
export { registerClaudeHandlers };
export { registerAgentSessionsHandlers };
export { registerGroupChatHandlers };
export { registerCrossAgentHandlers };
export { registerDebugHandlers };
export { registerSpeckitHandlers };
export { registerOpenSpecHandlers };
export { registerBmadHandlers };
export { registerContextHandlers, cleanupAllGroomingSessions, getActiveGroomingSessionCount };
export { registerMarketplaceHandlers };
export type { MarketplaceHandlerDependencies };
export { registerStatsHandlers };
export { registerCueStatsHandlers };
export type { CueStatsHandlerDependencies };
export { registerDocumentGraphHandlers };
export { registerSshRemoteHandlers };
export { registerFilesystemHandlers };
export { registerAttachmentsHandlers };
export type { AttachmentsHandlerDependencies };
export {
	registerWebHandlers,
	ensureCliServer,
	startCliDiscoveryWatchdog,
	stopCliDiscoveryWatchdog,
};
export type { WebHandlerDependencies };
export { registerLeaderboardHandlers };
export type { LeaderboardHandlerDependencies };
export { registerNotificationsHandlers };
export { registerSymphonyHandlers };
export { registerAgentErrorHandlers };
export { registerTabNamingHandlers };
export type { TabNamingHandlerDependencies };
export { registerDirectorNotesHandlers };
export type { DirectorNotesHandlerDependencies };
export { registerCueHandlers };
export type { CueHandlerDependencies };
export { registerCueBackupHandlers };
export { registerPianolaHandlers };
export type { PianolaHandlerDependencies };
export { registerPluginsHandlers };
export type { PluginsHandlerDependencies };
export { registerWakatimeHandlers };
export { registerCoworkingHandlers };
export { registerBrowserSessionHandlers };
export { registerFeedbackHandlers };
export { registerMaestroCliHandlers };
export { registerPromptsHandlers };
export { registerMemoryHandlers };
export { registerAgentRunHandlers };
export { registerWindowsHandlers };
export { wireWindowRegistryBroadcast };
export { wireEmptySecondaryWindowAutoClose };
export type { WindowsHandlerDependencies };
export { registerAccountHandlers };
export type { AccountHandlerDependencies };
export type { AgentsHandlerDependencies };
export type { ProcessHandlerDependencies };
export type { PersistenceHandlerDependencies };
export type { SystemHandlerDependencies };
export type { ClaudeHandlerDependencies };
export type { AgentSessionsHandlerDependencies };
export type { GroupChatHandlerDependencies };
export type { DebugHandlerDependencies };
export type { ContextHandlerDependencies };
export type { StatsHandlerDependencies };
export type { DocumentGraphHandlerDependencies };
export type { SshRemoteHandlerDependencies };
export type { GitHandlerDependencies };
export type { SymphonyHandlerDependencies };
export type { MaestroSettings, SessionsData, GroupsData };

// AgentConfigsData imported from stores/types

// ClaudeSessionOriginInfo and ClaudeSessionOriginsData imported from stores/types

/**
 * Dependencies required for handler registration
 */
export interface HandlerDependencies {
	mainWindow: BrowserWindow | null;
	getMainWindow: () => BrowserWindow | null;
	app: App;
	// Agents-specific dependencies
	getAgentDetector: () => AgentDetector | null;
	agentConfigsStore: Store<AgentConfigsData>;
	// Process-specific dependencies
	getProcessManager: () => ProcessManager | null;
	settingsStore: Store<MaestroSettings>;
	// Persistence-specific dependencies
	sessionsStore: Store<SessionsData>;
	groupsStore: Store<GroupsData>;
	getWebServer: () => WebServer | null;
	// System-specific dependencies
	tunnelManager: TunnelManagerType;
	// Claude-specific dependencies
	claudeSessionOriginsStore: Store<ClaudeSessionOriginsData>;
	// Multi-window dependencies. Optional during the phased rollout - the
	// registry and window manager are wired in main/index.ts at app-ready (a
	// later phase). Until then the windows:* handlers report "not initialized".
	getWindowRegistry?: () => WindowRegistry | null;
	getWindowManager?: () => WindowManager | null;
	getAccountRegistry?: () => AccountRegistry | null;
}

/**
 * Register all IPC handlers.
 * Call this once during app initialization.
 *
 * Note: registerWebHandlers is NOT called here because it requires access to
 * module-level webServer state with getter/setter functions for proper lifecycle
 * management (create, start, stop). The web handlers are registered separately
 * in main/index.ts where the webServer variable is defined.
 */
export function registerAllHandlers(deps: HandlerDependencies): void {
	registerGitHandlers({
		settingsStore: deps.settingsStore,
		getMainWindow: deps.getMainWindow,
	});
	registerAutorunHandlers(deps);
	registerPlaybooksHandlers(deps);
	registerHistoryHandlers({
		safeSend: createSafeSend(() => BrowserWindow.getAllWindows()),
		getMaxEntries: () => deps.settingsStore.get('maxLogBuffer', 5000) as number,
		getSshRemoteById,
		getSessionById: (id: string) => {
			const sessions = (
				deps.sessionsStore.get('sessions', []) as Array<Record<string, unknown>>
			).filter((s) => typeof s === 'object' && s !== null);
			return sessions.find((s) => s.id === id);
		},
	});
	registerAgentsHandlers({
		getAgentDetector: deps.getAgentDetector,
		agentConfigsStore: deps.agentConfigsStore,
		settingsStore: deps.settingsStore,
	});
	registerProcessHandlers({
		getProcessManager: deps.getProcessManager,
		getAgentDetector: deps.getAgentDetector,
		agentConfigsStore: deps.agentConfigsStore,
		settingsStore: deps.settingsStore,
		getMainWindow: deps.getMainWindow,
		safeSend: createSafeSend(() => BrowserWindow.getAllWindows()),
		sessionsStore: deps.sessionsStore,
	});
	registerPersistenceHandlers({
		settingsStore: deps.settingsStore,
		sessionsStore: deps.sessionsStore,
		groupsStore: deps.groupsStore,
		getWebServer: deps.getWebServer,
		safeSend: createSafeSend(() => BrowserWindow.getAllWindows()),
	});
	registerSystemHandlers({
		getMainWindow: deps.getMainWindow,
		app: deps.app,
		settingsStore: deps.settingsStore,
		tunnelManager: deps.tunnelManager,
		getWebServer: deps.getWebServer,
	});
	registerClaudeHandlers({
		claudeSessionOriginsStore: deps.claudeSessionOriginsStore,
		getMainWindow: deps.getMainWindow,
	});
	registerGroupChatHandlers({
		getMainWindow: deps.getMainWindow,
		// ProcessManager is structurally compatible with the group chat's IProcessManager interface
		getProcessManager:
			deps.getProcessManager as unknown as GroupChatHandlerDependencies['getProcessManager'],
		getAgentDetector: deps.getAgentDetector,
	});
	registerDebugHandlers({
		getMainWindow: deps.getMainWindow,
		getAgentDetector: deps.getAgentDetector,
		getProcessManager: deps.getProcessManager,
		getWebServer: deps.getWebServer,
		settingsStore: deps.settingsStore,
		sessionsStore: deps.sessionsStore,
		groupsStore: deps.groupsStore,
		// bootstrapStore is optional - not available in HandlerDependencies
	});
	// Register spec-kit handlers (no dependencies needed)
	registerSpeckitHandlers();
	// Register OpenSpec handlers (no dependencies needed)
	registerOpenSpecHandlers();
	// Register BMAD handlers (no dependencies needed)
	registerBmadHandlers();
	registerContextHandlers({
		getMainWindow: deps.getMainWindow,
		getProcessManager: deps.getProcessManager,
		getAgentDetector: deps.getAgentDetector,
		agentConfigsStore: deps.agentConfigsStore,
		getAccountRegistry: deps.getAccountRegistry || (() => null),
	});
	// Register marketplace handlers
	registerMarketplaceHandlers({
		app: deps.app,
	});
	// Register stats handlers for usage tracking
	registerStatsHandlers({
		getMainWindow: deps.getMainWindow,
		settingsStore: deps.settingsStore,
	});
	// Register Cue Stats handlers for the Cue Dashboard aggregation query
	registerCueStatsHandlers({
		settingsStore: deps.settingsStore,
	});
	// Register document graph handlers for file watching
	registerDocumentGraphHandlers({
		getMainWindow: deps.getMainWindow,
		app: deps.app,
	});
	// Register SSH remote handlers
	registerSshRemoteHandlers({
		settingsStore: deps.settingsStore,
	});
	// Register filesystem handlers (no dependencies needed - uses stores directly)
	registerFilesystemHandlers();
	// Register attachments handlers
	registerAttachmentsHandlers({
		app: deps.app,
	});
	// Register leaderboard handlers
	registerLeaderboardHandlers({
		app: deps.app,
		settingsStore: deps.settingsStore,
	});
	// Register notification handlers (OS notifications and TTS). The window
	// registry getter lets a notification click focus the window that owns the
	// completing agent rather than always the primary window (multi-window).
	registerNotificationsHandlers({
		getMainWindow: deps.getMainWindow,
		getWindowRegistry: deps.getWindowRegistry,
	});
	// Register Symphony handlers for token donation / open source contributions
	registerSymphonyHandlers({
		app: deps.app,
		getMainWindow: deps.getMainWindow,
		sessionsStore: deps.sessionsStore,
		settingsStore: deps.settingsStore,
	});
	// Register agent error handlers (error state management)
	registerAgentErrorHandlers();
	// Register tab naming handlers for automatic tab naming
	registerTabNamingHandlers({
		getProcessManager: deps.getProcessManager,
		getAgentDetector: deps.getAgentDetector,
		agentConfigsStore: deps.agentConfigsStore,
		settingsStore: deps.settingsStore,
	});
	// Register Director's Notes handlers (unified history + synopsis)
	registerDirectorNotesHandlers({
		getProcessManager: deps.getProcessManager,
		getAgentDetector: deps.getAgentDetector,
		agentConfigsStore: deps.agentConfigsStore,
		getMainWindow: deps.getMainWindow,
	});
	// Register Feedback handlers (gh auth + feedback submission)
	registerFeedbackHandlers({
		getProcessManager: deps.getProcessManager,
	});
	// Register Cue Backup handlers (Cue modal Backup tab)
	registerCueBackupHandlers({
		sessionsStore: deps.sessionsStore,
	});
	// Register Core Prompts handlers (no dependencies needed)
	registerPromptsHandlers();
	// Register project Memory handlers (Claude Code per-project memory viewer)
	registerMemoryHandlers();
	// Register AgentRun control-plane handlers (neutral run/campaign ledger)
	registerAgentRunHandlers({
		getProcessManager: deps.getProcessManager,
		settingsStore: deps.settingsStore,
	});
	// Register Coworking handlers (per-agent MCP installer + terminal registry sync)
	registerCoworkingHandlers({ getMainWindow: deps.getMainWindow });
	// Register Browser Session handlers (clear per-partition browsing data)
	registerBrowserSessionHandlers();
	// Register multi-window handlers (windows:* channel surface). The registry
	// and window manager are injected in main/index.ts at app-ready; default to
	// null getters so the handlers compile and report "not initialized" until
	// that wiring lands.
	registerWindowsHandlers({
		getWindowRegistry: deps.getWindowRegistry ?? (() => null),
		getWindowManager: deps.getWindowManager ?? (() => null),
	});
	// Setup logger event forwarding to renderer
	setupLoggerEventForwarding(deps.getMainWindow);
}
