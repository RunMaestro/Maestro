/**
 * Store type definitions
 *
 * Centralized type definitions for all electron-store instances.
 * These types are used across the main process for type-safe store access.
 */

import type { SshRemoteConfig, Group } from '../../shared/types';

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
	// Web interface custom port
	webInterfaceUseCustomPort: boolean;
	webInterfaceCustomPort: number;
	// SSH remote execution
	sshRemotes: SshRemoteConfig[];
	defaultSshRemoteId: string | null;
	// Unique installation identifier (generated once on first run)
	installationId: string | null;
}

// ============================================================================
// Sessions Store
// ============================================================================

export interface SessionsData {
	sessions: StoredSession[];
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
// Window State Store (local-only, per-device) - LEGACY
// Kept for backwards compatibility with existing single-window state files.
// New installations use MultiWindowStoreData instead.
// ============================================================================

export interface WindowState {
	x?: number;
	y?: number;
	width: number;
	height: number;
	isMaximized: boolean;
	isFullScreen: boolean;
}

// ============================================================================
// Multi-Window State Store (local-only, per-device)
// Supports multiple windows with session assignments.
// ============================================================================

/**
 * Represents the serializable state of a single window for persistence.
 * This is the store-specific version that matches the shared WindowState type
 * but is defined separately to keep store types self-contained.
 */
export interface MultiWindowWindowState {
	/** Unique identifier for the window */
	id: string;

	/** Window X position on screen */
	x: number;

	/** Window Y position on screen */
	y: number;

	/** Window width in pixels */
	width: number;

	/** Window height in pixels */
	height: number;

	/** Whether the window is maximized */
	isMaximized: boolean;

	/** Whether the window is in full-screen mode */
	isFullScreen: boolean;

	/** IDs of sessions open in this window */
	sessionIds: string[];

	/** ID of the currently active session in this window */
	activeSessionId?: string;

	/** Whether the left panel (session list) is collapsed */
	leftPanelCollapsed: boolean;

	/** Whether the right panel (files, history, auto run) is collapsed */
	rightPanelCollapsed: boolean;

	/**
	 * Electron display ID where the window was last positioned.
	 * Used to restore windows to their original display on restart.
	 * If the display is no longer available, the window will be moved
	 * to the primary display gracefully.
	 */
	displayId?: number;
}

/**
 * Store schema for multi-window state persistence.
 * Supports multiple windows with session assignments and restoration on restart.
 */
export interface MultiWindowStoreData {
	/** Array of all window states */
	windows: MultiWindowWindowState[];

	/** ID of the primary (main) window that cannot be closed */
	primaryWindowId: string;

	/** Schema version for migration support */
	version: number;
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
