/**
 * Store type definitions
 *
 * Centralized type definitions for all electron-store instances.
 * These types are used across the main process for type-safe store access.
 */

import type { SshRemoteConfig, Group } from '../../shared/types';
import type { AgentCapabilitiesSnapshotMap } from '../../shared/agentCapabilities';
import type { MultiWindowState } from '../../shared/window-types';

// ============================================================================
// Stored Session Type (minimal interface for main process storage)
// ============================================================================

/**
 * Minimal session interface for main process storage.
 * The full Session type is defined in renderer/types/index.ts and has 60+ fields.
 * This interface captures the required fields that the main process needs to understand,
 * while allowing additional properties via index signature for forward compatibility.
 *
 * Note: We use `any` for the index signature instead of `unknown` to maintain
 * backward compatibility with existing code that accesses dynamic session properties.
 */
export interface StoredSession {
	id: string;
	groupId?: string;
	name: string;
	toolType: string;
	cwd: string;
	projectRoot: string;
	[key: string]: any; // Allow additional renderer-specific fields
}

// ============================================================================
// Bootstrap Store (local-only, determines sync path)
// ============================================================================

export interface BootstrapSettings {
	customSyncPath?: string;
	iCloudSyncEnabled?: boolean; // Legacy - kept for backwards compatibility during migration
}

// ============================================================================
// Settings Store
// ============================================================================

export interface MaestroSettings {
	activeThemeId: string;
	llmProvider: string;
	modelSlug: string;
	apiKey: string;
	shortcuts: Record<string, any>;
	fontSize: number;
	fontFamily: string;
	customFonts: string[];
	logLevel: 'debug' | 'info' | 'warn' | 'error';
	defaultShell: string;
	// Web interface authentication
	webAuthEnabled: boolean;
	webAuthToken: string | null;
	// Persistent web link (reuse token across restarts)
	persistentWebLink: boolean;
	// Web interface custom port
	webInterfaceUseCustomPort: boolean;
	webInterfaceCustomPort: number;
	// SSH remote execution
	sshRemotes: SshRemoteConfig[];
	defaultSshRemoteId: string | null;
	// SSH Remote file indexing ignore patterns (glob patterns)
	sshRemoteIgnorePatterns: string[];
	// Whether to honor .gitignore files on remote hosts
	sshRemoteHonorGitignore: boolean;
	// Unique installation identifier (generated once on first run)
	installationId: string | null;
	// WakaTime integration
	wakatimeEnabled: boolean;
	wakatimeApiKey: string;
	wakatimeDetailedTracking: boolean;
	// Standalone hands-on time tracker (migrated from globalStats.totalActiveTimeMs)
	totalActiveTimeMs: number;
	// Last prompt edited in Settings → Maestro Prompts (restored on reopen)
	lastSelectedPromptId: string | null;
	// Spell check in input areas
	spellCheck: boolean;
	// Usage Dashboard provider quota auto-refresh cadence, keyed by provider id
	// ('claude-code' | 'codex'); value is the interval in ms (0 = off). Read by
	// the main-process background scheduler (usage-refresh-scheduler.ts).
	usageRefreshIntervals: Record<string, number>;
	// System-wide hotkey to summon the Maestro window (key array, e.g. ['Meta','Shift','M']).
	// Empty array disables it. Stored in the same format as `shortcuts` so the UI can reuse
	// the existing capture helpers; converted to an Electron Accelerator at registration time.
	globalShowHotkey: string[];
	// Utility agent for auxiliary tasks (tab naming, context grooming). When null,
	// the task uses the session's own agent (fully backward compatible).
	utilityAgentId: string | null;
	// Optional model override for the utility agent. When null, the agent default model is used.
	utilityModelId: string | null;
	// Allow dynamic settings keys (electron-store is a key-value store
	// with many settings not explicitly declared above)
	[key: string]: any;
}

// ============================================================================
// Sessions Store
// ============================================================================

export interface SessionsData {
	sessions: StoredSession[];
	activeSessionId?: string;
}

// ============================================================================
// Groups Store
// ============================================================================

export interface GroupsData {
	groups: Group[];
}

// ============================================================================
// Agent Configs Store
// ============================================================================

export interface AgentConfigsData {
	configs: Record<string, Record<string, any>>; // agentId -> config key-value pairs
}

// ============================================================================
// Agent Capabilities Store (per-device snapshot of detected agent state)
// ============================================================================

export interface AgentCapabilitiesData {
	/** Map of snapshot key -> snapshot. Key is `agentId` or `agentId:remoteUuid`. */
	snapshots: AgentCapabilitiesSnapshotMap;
}

// ============================================================================
// Window State Store (local-only, per-device)
// ============================================================================

export interface WindowState {
	x?: number;
	y?: number;
	width: number;
	height: number;
	isMaximized: boolean;
	isFullScreen: boolean;
	/**
	 * Multi-window persistence (see `MultiWindowState` in
	 * `src/shared/window-types.ts`). Backfilled once by the migration in
	 * `instances.ts` from the legacy flat fields above. During this phase the
	 * flat `x/y/width/height/isMaximized/isFullScreen` fields remain the
	 * single-window source of truth read by `window-manager.ts`; this field
	 * becomes the source of truth once windows are created through the registry.
	 */
	multiWindow?: MultiWindowState;
}

// ============================================================================
// Claude Session Origins Store
// ============================================================================

export type ClaudeSessionOrigin = 'user' | 'auto';

export interface ClaudeSessionOriginInfo {
	origin: ClaudeSessionOrigin;
	sessionName?: string; // User-defined session name from Maestro
	starred?: boolean; // Whether the session is starred
	contextUsage?: number; // Last known context window usage percentage (0-100)
}

export interface ClaudeSessionOriginsData {
	// Map of projectPath -> { agentSessionId -> origin info }
	origins: Record<string, Record<string, ClaudeSessionOrigin | ClaudeSessionOriginInfo>>;
}

// ============================================================================
// Agent Session Origins Store (generic, for non-Claude agents)
// ============================================================================

export interface AgentSessionOriginsData {
	// Structure: { [agentId]: { [projectPath]: { [sessionId]: { origin, sessionName, starred } } } }
	origins: Record<
		string,
		Record<
			string,
			Record<string, { origin?: 'user' | 'auto'; sessionName?: string; starred?: boolean }>
		>
	>;
}

// ============================================================================
// Shared Store Interfaces (used across main process modules)
// ============================================================================

/** Generic read/write store interface for settings */
export interface SettingsStoreInterface {
	get<T>(key: string, defaultValue?: T): T;
	/** Type-safe set for known settings keys */
	set<K extends keyof MaestroSettings>(key: K, value: MaestroSettings[K]): void;
	/** Fallback for dynamic keys — used by the generic settings:set IPC handler
	 *  in persistence.ts which accepts arbitrary key/value pairs from the renderer */
	set(key: string, value: unknown): void;
}
