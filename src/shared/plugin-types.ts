/**
 * Plugin System Types
 *
 * Type definitions for the Maestro plugin system.
 * Plugins are discovered from userData/plugins/ and registered at startup.
 */

// ============================================================================
// Plugin Manifest Types
// ============================================================================

/**
 * Permissions a plugin can request.
 * Each permission grants access to specific Maestro capabilities.
 * 'middleware' is included in the type system but deferred to v2 implementation.
 */
export type PluginPermission =
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
 * All known plugin permissions for validation.
 */
export const KNOWN_PERMISSIONS: readonly PluginPermission[] = [
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
 * Definition for a tab a plugin can register in the Right Bar.
 */
export interface PluginTabDefinition {
	id: string;
	label: string;
	icon?: string;
}

/**
 * UI surface registrations for a plugin.
 */
export interface PluginUIConfig {
	rightPanelTabs?: PluginTabDefinition[];
	settingsSection?: boolean;
	floatingPanel?: boolean;
}

/**
 * A configurable setting that a plugin exposes.
 */
export interface PluginSettingDefinition {
	key: string;
	type: 'boolean' | 'string' | 'number' | 'select';
	label: string;
	default: unknown;
	options?: { label: string; value: unknown }[];
}

/**
 * Plugin manifest describing a plugin's metadata, entry points, and capabilities.
 * Modeled after the marketplace manifest pattern from marketplace-types.ts.
 */
export interface PluginManifest {
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
	/** Main process entry point file relative to plugin dir (e.g., "index.js") */
	main: string;
	/** Optional renderer process entry point (e.g., "renderer.js") */
	renderer?: string;
	/** Declared permissions the plugin needs */
	permissions: PluginPermission[];
	/** UI surface registrations */
	ui?: PluginUIConfig;
	/** Configurable settings schema */
	settings?: PluginSettingDefinition[];
	/** Searchable keyword tags */
	tags?: string[];
}

// ============================================================================
// Plugin State Types
// ============================================================================

/**
 * Lifecycle state of a plugin.
 * - discovered: manifest read and validated, not yet activated
 * - loaded: code loaded into memory
 * - active: running and providing functionality
 * - error: failed to load or activate
 * - disabled: manually disabled by user
 */
export type PluginState = 'discovered' | 'loaded' | 'active' | 'error' | 'disabled';

/**
 * A plugin that has been discovered and loaded (or failed to load).
 */
export interface LoadedPlugin {
	/** The plugin's manifest */
	manifest: PluginManifest;
	/** Current lifecycle state */
	state: PluginState;
	/** Absolute path to the plugin directory */
	path: string;
	/** Error message if state is 'error' */
	error?: string;
}

// ============================================================================
// Plugin API Types (Phase 03)
// ============================================================================

import type { UsageStats } from './types';
import type { StatsAggregation } from './stats-types';

/**
 * Simplified tool execution data exposed to plugins.
 * Mirrors the relevant fields from process-manager ToolExecution.
 */
export interface PluginToolExecution {
	toolName: string;
	state: unknown;
	timestamp: number;
}

/**
 * Read-only access to process data and events.
 * Requires 'process:read' permission.
 */
export interface PluginProcessAPI {
	getActiveProcesses(): Promise<Array<{ sessionId: string; toolType: string; pid: number; startTime: number }>>;
	onData(callback: (sessionId: string, data: string) => void): () => void;
	onUsage(callback: (sessionId: string, stats: UsageStats) => void): () => void;
	onToolExecution(callback: (sessionId: string, tool: PluginToolExecution) => void): () => void;
	onExit(callback: (sessionId: string, code: number) => void): () => void;
	onThinkingChunk(callback: (sessionId: string, text: string) => void): () => void;
}

/**
 * Write access to control processes.
 * Requires 'process:write' permission.
 */
export interface PluginProcessControlAPI {
	kill(sessionId: string): boolean;
	write(sessionId: string, data: string): boolean;
}

/**
 * Read-only access to usage statistics.
 * Requires 'stats:read' permission.
 */
export interface PluginStatsAPI {
	getAggregation(range: string): Promise<StatsAggregation>;
	onStatsUpdate(callback: () => void): () => void;
}

/**
 * Plugin-scoped settings access.
 * Requires 'settings:read' or 'settings:write' permission.
 * Keys are namespaced to `plugin:<id>:<key>`.
 */
export interface PluginSettingsAPI {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	getAll(): Promise<Record<string, unknown>>;
}

/**
 * Plugin-scoped file storage.
 * Requires 'storage' permission.
 * Files are stored under `userData/plugins/<id>/data/`.
 */
export interface PluginStorageAPI {
	read(filename: string): Promise<string | null>;
	write(filename: string, data: string): Promise<void>;
	list(): Promise<string[]>;
	delete(filename: string): Promise<void>;
}

/**
 * Desktop notification capabilities.
 * Requires 'notifications' permission.
 */
export interface PluginNotificationsAPI {
	show(title: string, body: string): Promise<void>;
	playSound(sound: string): Promise<void>;
}

/**
 * Always-available Maestro metadata API. No permission required.
 */
export interface PluginMaestroAPI {
	version: string;
	platform: string;
	pluginId: string;
	pluginDir: string;
	dataDir: string;
}

/**
 * The scoped API object provided to plugins.
 * Optional namespaces are present only when the plugin has the required permission.
 */
export interface PluginAPI {
	process?: PluginProcessAPI;
	processControl?: PluginProcessControlAPI;
	stats?: PluginStatsAPI;
	settings?: PluginSettingsAPI;
	storage?: PluginStorageAPI;
	notifications?: PluginNotificationsAPI;
	maestro: PluginMaestroAPI;
}

/**
 * Per-plugin runtime context managed by PluginHost.
 */
export interface PluginContext {
	pluginId: string;
	api: PluginAPI;
	cleanup: () => void;
	eventSubscriptions: Array<() => void>;
}
