/**
 * Electron Preload Script
 *
 * This script runs in the renderer process before any web content is loaded.
 * It exposes a safe subset of Electron and Node.js APIs to the renderer via contextBridge.
 *
 * All APIs are organized in modular files within this directory for maintainability.
 */

import { contextBridge } from 'electron';

// Import all factory functions for contextBridge exposure
import {
	createSettingsApi,
	createSessionsApi,
	createGroupsApi,
	createAgentErrorApi,
} from './settings';
import { createContextApi } from './context';
import { createWebApi, createWebserverApi, createLiveApi } from './web';
import {
	createDialogApi,
	createFontsApi,
	createShellsApi,
	createShellApi,
	createTunnelApi,
	createSyncApi,
	createDevtoolsApi,
	createPowerApi,
	createUpdatesApi,
	createAppApi,
} from './system';
import { createSshRemoteApi } from './sshRemote';
import { createLoggerApi } from './logger';
import { createClaudeApi, createAgentSessionsApi } from './sessions';
import { createTempfileApi, createHistoryApi, createCliApi } from './files';
import { createSpeckitApi, createOpenspecApi, createBmadApi } from './commands';
import { createAutorunApi, createPlaybooksApi, createMarketplaceApi } from './autorun';
import { createDebugApi, createDocumentGraphApi } from './debug';
import { createGroupChatApi } from './groupChat';
import { createCrossAgentApi } from './crossAgent';
import { createStatsApi } from './stats';
import { createCueStatsApi } from './cueStats';
import { createNotificationApi } from './notifications';
import { createLeaderboardApi } from './leaderboard';
import { createAttachmentsApi } from './attachments';
import { createProcessApi } from './process';
import { createGitApi } from './git';
import { createFeedbackApi } from './feedback';
import { createFsApi } from './fs';
import { createAgentsApi } from './agents';
import { createSymphonyApi } from './symphony';
import { createTabNamingApi } from './tabNaming';
import { createDirectorNotesApi } from './directorNotes';
import { createCueApi } from './cue';
import { createProfilesApi } from './profiles';
import { createCueBackupApi } from './cueBackup';
import { createPianolaApi } from './pianola';
import { createPluginsApi } from './plugins';
import { createWakatimeApi } from './wakatime';
import { createMaestroCliApi } from './maestroCli';
import { createPromptsApi } from './prompts';
import { createMemoryApi } from './memory';
import { createAgentRunApi } from './agentRun';
import { createCoworkingApi } from './coworking';
import { createBrowserSessionApi } from './browserSession';
import { createWindowsApi } from './windows';
import { createImagesApi } from './images';
import { MAESTRO_CLI_PATH_ARG_PREFIX } from '../../shared/maestro-cli';

/**
 * The real on-disk maestro-cli.js path, handed in by the main process via an
 * additionalArguments flag (a sandboxed preload can't resolve it from fs).
 * Exposed as `window.maestro.maestroCliPath` so the shared template resolver
 * can point `{{MAESTRO_CLI_PATH}}` at a file that actually exists (dev vs
 * packaged). Null when the main process couldn't find a bundled CLI.
 */
const resolvedMaestroCliPath: string | null =
	process.argv
		.find((a) => a.startsWith(MAESTRO_CLI_PATH_ARG_PREFIX))
		?.slice(MAESTRO_CLI_PATH_ARG_PREFIX.length) ?? null;

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('maestro', {
	// Settings API
	settings: createSettingsApi(),

	// Sessions persistence API
	sessions: createSessionsApi(),

	// Groups persistence API
	groups: createGroupsApi(),

	// Process/Session API
	process: createProcessApi(),
	feedback: createFeedbackApi(),

	// Agent Error Handling API
	agentError: createAgentErrorApi(),

	// Context Merge API
	context: createContextApi(),

	// Web interface API
	web: createWebApi(),

	// Git API
	git: createGitApi(),

	// File System API
	fs: createFsApi(),

	// Web Server API
	webserver: createWebserverApi(),

	// Live Session API
	live: createLiveApi(),

	// Agent API
	agents: createAgentsApi(),

	// Dialog API
	dialog: createDialogApi(),

	// Font API
	fonts: createFontsApi(),

	// Shells API (terminal shells)
	shells: createShellsApi(),

	// Shell API
	shell: createShellApi(),

	// Tunnel API (Cloudflare)
	tunnel: createTunnelApi(),

	// SSH Remote API
	sshRemote: createSshRemoteApi(),

	// Sync API
	sync: createSyncApi(),

	// DevTools API
	devtools: createDevtoolsApi(),

	// Power Management API
	power: createPowerApi(),

	// Updates API
	updates: createUpdatesApi(),

	// Logger API
	logger: createLoggerApi(),

	// Claude Code sessions API (DEPRECATED)
	claude: createClaudeApi(),

	// Agent Sessions API (preferred)
	agentSessions: createAgentSessionsApi(),

	// Temp file API
	tempfile: createTempfileApi(),

	// History API
	history: createHistoryApi(),

	// CLI activity API
	cli: createCliApi(),

	// Spec Kit API
	speckit: createSpeckitApi(),

	// OpenSpec API
	openspec: createOpenspecApi(),

	// BMAD API
	bmad: createBmadApi(),

	// Notification API
	notification: createNotificationApi(),

	// Attachments API
	attachments: createAttachmentsApi(),

	// Auto Run API
	autorun: createAutorunApi(),

	// Playbooks API
	playbooks: createPlaybooksApi(),

	// Marketplace API
	marketplace: createMarketplaceApi(),

	// Debug Package API
	debug: createDebugApi(),

	// Document Graph API
	documentGraph: createDocumentGraphApi(),

	// Group Chat API
	groupChat: createGroupChatApi(),

	// Cross-Agent Dispatch API (@mentions)
	crossAgent: createCrossAgentApi(),

	// App lifecycle API
	app: createAppApi(),

	// Synchronous platform string — process.platform never changes at runtime
	platform: process.platform,

	// Resolved on-disk maestro-cli.js path (dev vs packaged), or null. Used by
	// the shared template resolver for `{{MAESTRO_CLI_PATH}}`.
	maestroCliPath: resolvedMaestroCliPath,

	// Stats API
	stats: createStatsApi(),

	// Cue Stats API (Cue Dashboard aggregation query)
	cueStats: createCueStatsApi(),

	// Leaderboard API
	leaderboard: createLeaderboardApi(),

	// Symphony API (token donations / open source contributions)
	symphony: createSymphonyApi(),

	// Tab Naming API (automatic tab name generation)
	tabNaming: createTabNamingApi(),

	// Director's Notes API (unified history + synopsis)
	directorNotes: createDirectorNotesApi(),

	// Cue API (event-driven automation)
	cue: createCueApi(),

	// Agent Profiles API (named model/effort/role bundles layered on a base agent)
	profiles: createProfilesApi(),

	// Cue Backup API (Cue modal Backup tab — snapshot/restore cue.yaml + prompts)
	cueBackup: createCueBackupApi(),

	// Pianola API (autonomous manager: rules + decision log)
	pianola: createPianolaApi(),

	// Plugins API (community plugin subsystem: list/toggle/install/uninstall)
	plugins: createPluginsApi(),

	// WakaTime API (CLI check, API key validation)
	wakatime: createWakatimeApi(),

	// Maestro CLI API (status + install/update)
	maestroCli: createMaestroCliApi(),
	// Core Prompts API (view, edit, reset system prompts)
	prompts: createPromptsApi(),
	// Per-project Memory API (Claude Code memory viewer)
	memory: createMemoryApi(),
	// AgentRun control-plane API (neutral run/campaign ledger)
	agentRun: createAgentRunApi(),
	// Coworking API (per-agent MCP installer + terminal registry sync)
	coworking: createCoworkingApi(),
	// Browser Session API (clear per-partition browsing data)
	browserSession: createBrowserSessionApi(),

	// Multi-window API (window.maestro.windows.* — enumerate/create/move windows)
	windows: createWindowsApi(),

	// Session Images API (resolve maestro-image:// refs back to data URLs)
	images: createImagesApi(),
});

// Re-export factory functions for external consumers (e.g., tests)
export {
	// Settings and persistence
	createSettingsApi,
	createSessionsApi,
	createGroupsApi,
	createAgentErrorApi,
	// Context
	createContextApi,
	// Web interface
	createWebApi,
	createWebserverApi,
	createLiveApi,
	// System utilities
	createDialogApi,
	createFontsApi,
	createShellsApi,
	createShellApi,
	createTunnelApi,
	createSyncApi,
	createDevtoolsApi,
	createPowerApi,
	createUpdatesApi,
	createAppApi,
	// SSH Remote
	createSshRemoteApi,
	// Logger
	createLoggerApi,
	// Sessions
	createClaudeApi,
	createAgentSessionsApi,
	// Files
	createTempfileApi,
	createHistoryApi,
	createCliApi,
	// Commands
	createSpeckitApi,
	createOpenspecApi,
	createBmadApi,
	// Auto Run
	createAutorunApi,
	createPlaybooksApi,
	createMarketplaceApi,
	// Debug
	createDebugApi,
	createDocumentGraphApi,
	// Group Chat
	createGroupChatApi,
	// Cross-Agent Dispatch (@mentions)
	createCrossAgentApi,
	// Stats
	createStatsApi,
	// Cue Stats (Phase 03 aggregation query)
	createCueStatsApi,
	// Notifications
	createNotificationApi,
	// Leaderboard
	createLeaderboardApi,
	// Attachments
	createAttachmentsApi,
	// Process
	createProcessApi,
	// Feedback
	createFeedbackApi,
	// Git
	createGitApi,
	// Filesystem
	createFsApi,
	// Agents
	createAgentsApi,
	// Symphony
	createSymphonyApi,
	// Tab Naming
	createTabNamingApi,
	// Director's Notes
	createDirectorNotesApi,
	// Cue
	createCueApi,
	// Agent Profiles
	createProfilesApi,
	// Cue Backup
	createCueBackupApi,
	// Pianola
	createPianolaApi,
	// Plugins
	createPluginsApi,
	// WakaTime
	createWakatimeApi,
	// Maestro CLI
	createMaestroCliApi,
	// Core Prompts
	createPromptsApi,
	// Memory Viewer
	createMemoryApi,
	// AgentRun
	createAgentRunApi,
	// Coworking
	createCoworkingApi,
	// Browser Session
	createBrowserSessionApi,
	// Multi-window
	createWindowsApi,
	// Session Images
	createImagesApi,
};

// Re-export types for TypeScript consumers
export type {
	// From settings
	SettingsApi,
	SessionsApi,
	GroupsApi,
	AgentErrorApi,
} from './settings';
export type {
	// From context
	ContextApi,
	StoredMessage,
	StoredSessionResponse,
} from './context';
export type {
	// From web
	WebApi,
	WebserverApi,
	LiveApi,
	AutoRunState,
	AiTabState,
} from './web';
export type {
	// From system
	DialogApi,
	FontsApi,
	ShellsApi,
	ShellApi,
	TunnelApi,
	SyncApi,
	DevtoolsApi,
	PowerApi,
	UpdatesApi,
	AppApi,
	ShellInfo,
	UpdateStatus,
} from './system';
export type { ParsedDeepLink } from '../../shared/types';
export type {
	// From sshRemote
	SshRemoteApi,
	SshRemoteConfig,
	SshConfigHost,
} from './sshRemote';
export type {
	// From logger
	LoggerApi,
} from './logger';
export type {
	// From sessions
	ClaudeApi,
	AgentSessionsApi,
	NamedSessionEntry,
	NamedSessionEntryWithAgent,
	GlobalStatsUpdate,
} from './sessions';
export type {
	// From files
	TempfileApi,
	HistoryApi,
	CliApi,
	HistoryEntry,
} from './files';
export type {
	// From commands
	SpeckitApi,
	OpenspecApi,
	CommandMetadata,
	CommandDefinition,
} from './commands';
export type {
	// From autorun
	AutorunApi,
	PlaybooksApi,
	MarketplaceApi,
	Playbook,
	PlaybookDocument,
	WorktreeSettings,
} from './autorun';
export type {
	// From debug
	DebugApi,
	DocumentGraphApi,
	DebugPackageOptions,
	DocumentGraphChange,
} from './debug';
export type {
	// From groupChat
	GroupChatApi,
	ModeratorConfig,
	Participant,
	ChatMessage,
	GroupChatHistoryEntry,
	ModeratorUsage,
} from './groupChat';
export type {
	// From stats
	StatsApi,
	QueryEvent,
	AutoRunSession,
	AutoRunTask,
	SessionCreatedEvent,
	StatsAggregation,
} from './stats';
export type {
	// From cueStats (Phase 03)
	CueStatsApi,
	CueStatsAggregation,
	CueStatsTimeRange,
} from './cueStats';
export type {
	// From notifications
	NotificationApi,
	NotificationShowResponse,
	NotificationCommandResponse,
} from './notifications';
export type {
	// From leaderboard
	LeaderboardApi,
	LeaderboardSubmitData,
	LeaderboardSubmitResponse,
	AuthStatusResponse,
	ResendConfirmationResponse,
	LeaderboardEntry,
	LongestRunEntry,
	LeaderboardGetResponse,
	LongestRunsGetResponse,
	LeaderboardSyncResponse,
} from './leaderboard';
export type {
	// From attachments
	AttachmentsApi,
	AttachmentResponse,
	AttachmentLoadResponse,
	AttachmentListResponse,
	AttachmentPathResponse,
} from './attachments';
export type {
	// From feedback
	FeedbackApi,
	FeedbackAuthResponse,
	FeedbackSubmitResponse,
} from './feedback';
export type {
	// From process
	ProcessApi,
	ProcessConfig,
	ProcessSpawnResponse,
	RunCommandConfig,
	ActiveProcess,
	UsageStats,
	AgentError,
	ToolExecutionEvent,
	SshRemoteInfo,
} from './process';
export type {
	// From git
	GitApi,
	WorktreeInfo,
	WorktreeEntry,
	GitSubdirEntry,
	GitLogEntry,
	WorktreeDiscoveredData,
} from './git';
export type {
	// From fs
	FsApi,
	DirectoryEntry,
	FileStat,
	DirectorySizeInfo,
	ItemCountInfo,
} from './fs';
export type {
	// From agents
	AgentsApi,
	AgentCapabilities,
	AgentConfig,
	AgentRefreshResult,
} from './agents';
export type {
	// From symphony
	SymphonyApi,
	SymphonyRegistry,
	SymphonyRepository,
	SymphonyIssue,
	DocumentReference,
	ClaimedByPR,
	ActiveContribution,
	CompletedContribution,
	ContributorStats,
	ContributionProgress,
	ContributionTokenUsage,
	SymphonyState,
	GetRegistryResponse,
	GetIssuesResponse,
	GetStateResponse,
	StartContributionParams,
	StartContributionResponse,
	CreateDraftPRResponse,
	CompleteContributionResponse,
} from './symphony';
export type {
	// From tabNaming
	TabNamingApi,
	TabNamingConfig,
} from './tabNaming';
export type {
	// From directorNotes
	DirectorNotesApi,
	UnifiedHistoryOptions,
	UnifiedHistoryEntry,
	SynopsisOptions,
	SynopsisResult,
	SynopsisStats,
} from './directorNotes';
export type {
	// From cue
	CueApi,
	CueRunResult,
	CueSessionStatus,
	CueEvent,
	CueEventType,
	CueRunStatus,
} from './cue';
export type {
	// From profiles
	ProfilesApi,
	AgentProfile,
} from './profiles';
export type {
	// From pianola
	PianolaApi,
} from './pianola';
export type {
	// From wakatime
	WakatimeApi,
} from './wakatime';
export type {
	// From maestroCli
	MaestroCliApi,
} from './maestroCli';
export type {
	// From prompts
	PromptsApi,
	CorePromptData,
} from './prompts';

export type {
	// From agentRun
	AgentRunApi,
	AgentRunListOptions,
	AgentRunListResponse,
	AgentRunRecordResponse,
	AgentRunShowResponse,
	AgentRunEventsResponse,
	AgentRunEventRecordResponse,
	CampaignListOptions,
	CampaignListResponse,
	CampaignRecordResponse,
	CampaignShowResponse,
} from './agentRun';
export type {
	// From coworking
	CoworkingApi,
	CoworkingTerminalEntry,
	CoworkingTerminalRecord,
	CoworkingInstallStatus,
} from './coworking';
export type {
	// From browserSession
	BrowserSessionApi,
} from './browserSession';
export type {
	// From windows
	WindowsApi,
	WindowBounds,
} from './windows';
export type {
	// From images
	ImagesApi,
} from './images';
