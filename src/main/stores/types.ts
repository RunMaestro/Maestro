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
// Window State Store (local-only, per-device)
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
