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
import { createSpeckitApi, createOpenspecApi } from './commands';
import { createAutorunApi, createPlaybooksApi, createMarketplaceApi } from './autorun';
import { createDebugApi, createDocumentGraphApi } from './debug';
import { createGroupChatApi } from './groupChat';
import { createStatsApi } from './stats';
import { createNotificationApi } from './notifications';
import { createLeaderboardApi } from './leaderboard';
import { createAttachmentsApi } from './attachments';
import { createProcessApi } from './process';
import { createGitApi } from './git';
import { createFsApi } from './fs';
import { createAgentsApi } from './agents';

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

	// App lifecycle API
	app: createAppApi(),

	// Stats API
	stats: createStatsApi(),

	// Leaderboard API
	leaderboard: createLeaderboardApi(),
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
	// Auto Run
	createAutorunApi,
	createPlaybooksApi,
	createMarketplaceApi,
	// Debug
	createDebugApi,
	createDocumentGraphApi,
	// Group Chat
	createGroupChatApi,
	// Stats
	createStatsApi,
	// Notifications
	createNotificationApi,
	// Leaderboard
	createLeaderboardApi,
	// Attachments
	createAttachmentsApi,
	// Process
	createProcessApi,
	// Git
	createGitApi,
	// Filesystem
	createFsApi,
	// Agents
	createAgentsApi,
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
	// From notifications
	NotificationApi,
	NotificationShowResponse,
	TtsResponse,
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
