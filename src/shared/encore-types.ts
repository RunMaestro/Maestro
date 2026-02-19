/**
 * Plugin System Types
 *
 * Type definitions for the Maestro encore system.
 * Encores are discovered from userData/encores/ and registered at startup.
 */

// ============================================================================
// Plugin Manifest Types
// ============================================================================

/**
 * Permissions an encore can request.
 * Each permission grants access to specific Maestro capabilities.
 * 'middleware' is included in the type system but deferred to v2 implementation.
 */
export type EncorePermission =
	| 'process:read'
	| 'process:write'
	| 'stats:read'
	| 'settings:read'
	| 'settings:write'
	| 'notifications'
	| 'network'
	| 'storage'
	| 'middleware';

/**
 * All known encore permissions for validation.
 */
export const KNOWN_PERMISSIONS: readonly EncorePermission[] = [
	'process:read',
	'process:write',
	'stats:read',
	'settings:read',
	'settings:write',
	'notifications',
	'network',
	'storage',
	'middleware',
] as const;

/**
 * Definition for a tab an encore can register in the Right Bar.
 */
export interface EncoreTabDefinition {
	id: string;
	label: string;
	icon?: string;
}

/**
 * UI surface registrations for an encore.
 */
export interface EncoreUIConfig {
	rightPanelTabs?: EncoreTabDefinition[];
	settingsSection?: boolean;
	floatingPanel?: boolean;
}

/**
 * A configurable setting that an encore exposes.
 */
export interface EncoreSettingDefinition {
	key: string;
	type: 'boolean' | 'string' | 'number' | 'select';
	label: string;
	default: unknown;
	options?: { label: string; value: unknown }[];
}

/**
 * Encore manifest describing an encore's metadata, entry points, and capabilities.
 * Modeled after the marketplace manifest pattern from marketplace-types.ts.
 */
export interface EncoreManifest {
	/** Unique slug identifier (lowercase alphanumeric + hyphens, e.g., "agent-dashboard") */
	id: string;
	/** Display name */
	name: string;
	/** Semver version string */
	version: string;
	/** Short description */
	description: string;
	/** Plugin author name */
	author: string;
	/** Optional URL to author's website/profile */
	authorLink?: string;
	/** Minimum Maestro version required for compatibility */
	minMaestroVersion?: string;
	/** Main process entry point file relative to encore dir (e.g., "index.js") */
	main: string;
	/** Optional renderer process entry point (e.g., "renderer.js") */
	renderer?: string;
	/** Declared permissions the encore needs */
	permissions: EncorePermission[];
	/** UI surface registrations */
	ui?: EncoreUIConfig;
	/** Configurable settings schema */
	settings?: EncoreSettingDefinition[];
	/** Searchable keyword tags */
	tags?: string[];
	/** Whether this is a first-party Maestro encore (auto-enabled on discovery) */
	firstParty?: boolean;
}

// ============================================================================
// Plugin State Types
// ============================================================================

/**
 * Lifecycle state of an encore.
 * - discovered: manifest read and validated, not yet activated
 * - loaded: code loaded into memory
 * - active: running and providing functionality
 * - error: failed to load or activate
 * - disabled: manually disabled by user
 */
export type EncoreState = 'discovered' | 'loaded' | 'active' | 'error' | 'disabled';

/**
 * An encore that has been discovered and loaded (or failed to load).
 */
export interface LoadedEncore {
	/** The encore's manifest */
	manifest: EncoreManifest;
	/** Current lifecycle state */
	state: EncoreState;
	/** Absolute path to the encore directory */
	path: string;
	/** Error message if state is 'error' */
	error?: string;
	/** README.md content loaded from the encore directory, if present */
	readme?: string;
}

// ============================================================================
// Plugin API Types (Phase 03)
// ============================================================================

import type { UsageStats } from './types';
import type { StatsAggregation } from './stats-types';

/**
 * Simplified tool execution data exposed to encores.
 * Mirrors the relevant fields from process-manager ToolExecution.
 */
export interface EncoreToolExecution {
	toolName: string;
	state: unknown;
	timestamp: number;
}

/**
 * Read-only access to process data and events.
 * Requires 'process:read' permission.
 */
export interface EncoreProcessAPI {
	getActiveProcesses(): Promise<Array<{ sessionId: string; toolType: string; pid: number; startTime: number; name: string | null }>>;
	onData(callback: (sessionId: string, data: string) => void): () => void;
	onUsage(callback: (sessionId: string, stats: UsageStats) => void): () => void;
	onToolExecution(callback: (sessionId: string, tool: EncoreToolExecution) => void): () => void;
	onExit(callback: (sessionId: string, code: number) => void): () => void;
	onThinkingChunk(callback: (sessionId: string, text: string) => void): () => void;
}

/**
 * Write access to control processes.
 * Requires 'process:write' permission.
 */
export interface EncoreProcessControlAPI {
	kill(sessionId: string): boolean;
	write(sessionId: string, data: string): boolean;
}

/**
 * Read-only access to usage statistics.
 * Requires 'stats:read' permission.
 */
export interface EncoreStatsAPI {
	getAggregation(range: string): Promise<StatsAggregation>;
	onStatsUpdate(callback: () => void): () => void;
}

/**
 * Plugin-scoped settings access.
 * Requires 'settings:read' or 'settings:write' permission.
 * Keys are namespaced to `encore:<id>:<key>`.
 */
export interface EncoreSettingsAPI {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	getAll(): Promise<Record<string, unknown>>;
}

/**
 * Plugin-scoped file storage.
 * Requires 'storage' permission.
 * Files are stored under `userData/encores/<id>/data/`.
 */
export interface EncoreStorageAPI {
	read(filename: string): Promise<string | null>;
	write(filename: string, data: string): Promise<void>;
	list(): Promise<string[]>;
	delete(filename: string): Promise<void>;
}

/**
 * Desktop notification capabilities.
 * Requires 'notifications' permission.
 */
export interface EncoreNotificationsAPI {
	show(title: string, body: string): Promise<void>;
	playSound(sound: string): Promise<void>;
}

/**
 * IPC bridge API for split-architecture encores.
 * Allows main-process encore components to communicate with renderer components.
 */
export interface EncoreIpcBridgeAPI {
	/** Register a handler for messages from the renderer component */
	onMessage(channel: string, handler: (...args: unknown[]) => unknown): () => void;
	/** Send a message to the renderer component */
	sendToRenderer(channel: string, ...args: unknown[]): void;
}

/**
 * Always-available Maestro metadata API. No permission required.
 */
export interface EncoreMaestroAPI {
	version: string;
	platform: string;
	encoreId: string;
	encoreDir: string;
	dataDir: string;
}

/**
 * The scoped API object provided to encores.
 * Optional namespaces are present only when the encore has the required permission.
 */
export interface EncoreAPI {
	process?: EncoreProcessAPI;
	processControl?: EncoreProcessControlAPI;
	stats?: EncoreStatsAPI;
	settings?: EncoreSettingsAPI;
	storage?: EncoreStorageAPI;
	notifications?: EncoreNotificationsAPI;
	maestro: EncoreMaestroAPI;
	ipcBridge?: EncoreIpcBridgeAPI;
}

/**
 * Interface that encore modules must conform to.
 * The activate() function is called when the encore is enabled.
 * The deactivate() function is called when the encore is disabled.
 */
export interface EncoreModule {
	activate(api: EncoreAPI): void | Promise<void>;
	deactivate?(): void | Promise<void>;
}

/**
 * Per-encore runtime context managed by EncoreHost.
 */
export interface EncoreContext {
	encoreId: string;
	api: EncoreAPI;
	cleanup: () => void;
	eventSubscriptions: Array<() => void>;
}
