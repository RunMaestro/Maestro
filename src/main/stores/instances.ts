/**
 * Store Instances
 *
 * Manages store instance lifecycle:
 * - Store instance variables (private)
 * - Initialization function
 * - Path caching
 *
 * The actual getter functions are in getters.ts to keep this file focused
 * on initialization logic only.
 */

import { app } from 'electron';
import Store from 'electron-store';
import { parseJsonWithBom } from '../../shared/jsonUtils';

import type {
	BootstrapSettings,
	MaestroSettings,
	SessionsData,
	GroupsData,
	AgentConfigsData,
	AgentCapabilitiesData,
	WindowState,
	ClaudeSessionOriginsData,
	AgentSessionOriginsData,
} from './types';

import type { AccountStoreData } from './account-store-types';

import {
	SETTINGS_DEFAULTS,
	SESSIONS_DEFAULTS,
	GROUPS_DEFAULTS,
	AGENT_CONFIGS_DEFAULTS,
	AGENT_CAPABILITIES_DEFAULTS,
	WINDOW_STATE_DEFAULTS,
	CLAUDE_SESSION_ORIGINS_DEFAULTS,
	AGENT_SESSION_ORIGINS_DEFAULTS,
} from './defaults';

import { ACCOUNT_SWITCH_DEFAULTS } from '../../shared/account-types';

import { getCustomSyncPath } from './utils';
import { migrateWindowStateToMultiWindow } from './migrations/multi-window-state';
import { readExistingAgentIds } from '../window-state-persistence';

function deserializeStoreJson<T = Record<string, unknown>>(value: string): T {
	return parseJsonWithBom<T>(value);
}

// ============================================================================
// Store Instance Variables
// ============================================================================

let _bootstrapStore: Store<BootstrapSettings> | null = null;
let _settingsStore: Store<MaestroSettings> | null = null;
let _sessionsStore: Store<SessionsData> | null = null;
let _groupsStore: Store<GroupsData> | null = null;
let _agentConfigsStore: Store<AgentConfigsData> | null = null;
let _agentCapabilitiesStore: Store<AgentCapabilitiesData> | null = null;
let _windowStateStore: Store<WindowState> | null = null;
let _claudeSessionOriginsStore: Store<ClaudeSessionOriginsData> | null = null;
let _agentSessionOriginsStore: Store<AgentSessionOriginsData> | null = null;
let _accountStore: Store<AccountStoreData> | null = null;

const ACCOUNT_STORE_DEFAULTS: AccountStoreData = {
	accounts: {},
	assignments: {},
	switchConfig: ACCOUNT_SWITCH_DEFAULTS,
	rotationOrder: [],
	rotationIndex: 0,
};

// Cached paths after initialization
let _syncPath: string | null = null;
let _productionDataPath: string | null = null;

// ============================================================================
// Initialization
// ============================================================================

export interface StoreInitOptions {
	/** The production userData path (before any dev mode modifications) */
	productionDataPath: string;
}

/**
 * Initialize all stores. Must be called once during app startup,
 * after app.setPath('userData', ...) has been configured.
 *
 * @returns Object containing syncPath and bootstrapStore for further initialization
 */
export function initializeStores(options: StoreInitOptions): {
	syncPath: string;
	bootstrapStore: Store<BootstrapSettings>;
} {
	const { productionDataPath } = options;
	_productionDataPath = productionDataPath;

	// 1. Initialize bootstrap store first (determines sync path)
	_bootstrapStore = new Store<BootstrapSettings>({
		name: 'maestro-bootstrap',
		cwd: app.getPath('userData'),
		defaults: {},
		deserialize: deserializeStoreJson,
	});

	// 2. Determine sync path
	_syncPath = getCustomSyncPath(_bootstrapStore) || app.getPath('userData');

	// Log paths for debugging
	console.log(`[STARTUP] userData path: ${app.getPath('userData')}`);
	console.log(`[STARTUP] syncPath (sessions/settings): ${_syncPath}`);
	console.log(`[STARTUP] productionDataPath (agent configs): ${_productionDataPath}`);

	// 3. Initialize all other stores
	_settingsStore = new Store<MaestroSettings>({
		name: 'maestro-settings',
		cwd: _syncPath,
		defaults: SETTINGS_DEFAULTS,
		deserialize: deserializeStoreJson,
	});

	_sessionsStore = new Store<SessionsData>({
		name: 'maestro-sessions',
		cwd: _syncPath,
		defaults: SESSIONS_DEFAULTS,
		deserialize: deserializeStoreJson,
	});

	_groupsStore = new Store<GroupsData>({
		name: 'maestro-groups',
		cwd: _syncPath,
		defaults: GROUPS_DEFAULTS,
		deserialize: deserializeStoreJson,
	});

	// Agent configs are ALWAYS stored in the production path, even in dev mode
	// This ensures agent paths, custom args, and env vars are shared between dev and prod
	_agentConfigsStore = new Store<AgentConfigsData>({
		name: 'maestro-agent-configs',
		cwd: _productionDataPath,
		defaults: AGENT_CONFIGS_DEFAULTS,
		deserialize: deserializeStoreJson,
	});

	// Agent capability snapshots — keyed by `agentId` or `agentId:remoteUuid`.
	// Per-device because detection state (installed paths, auth status) is
	// inherently local to the machine, even when other agent settings sync.
	_agentCapabilitiesStore = new Store<AgentCapabilitiesData>({
		name: 'maestro-agent-capabilities',
		cwd: _productionDataPath,
		defaults: AGENT_CAPABILITIES_DEFAULTS,
		deserialize: deserializeStoreJson,
	});

	// Window state is intentionally NOT synced - it's per-device
	_windowStateStore = new Store<WindowState>({
		name: 'maestro-window-state',
		defaults: WINDOW_STATE_DEFAULTS,
		deserialize: deserializeStoreJson,
	});

	// Fold any legacy single-window bounds into the multi-window schema. Runs
	// once (keyed on the persisted data), never throws - a window-state hiccup
	// must not block startup. The legacy build showed every agent in its lone
	// window, so the migrated primary inherits the agents that currently exist
	// and stays their catch-all owner.
	migrateWindowStateToMultiWindow(_windowStateStore, readExistingAgentIds(_sessionsStore));

	// Claude session origins - tracks which sessions were created by Maestro
	_claudeSessionOriginsStore = new Store<ClaudeSessionOriginsData>({
		name: 'maestro-claude-session-origins',
		cwd: _syncPath,
		defaults: CLAUDE_SESSION_ORIGINS_DEFAULTS,
		deserialize: deserializeStoreJson,
	});

	// Generic agent session origins - supports all agents (Codex, OpenCode, etc.)
	_agentSessionOriginsStore = new Store<AgentSessionOriginsData>({
		name: 'maestro-agent-session-origins',
		cwd: _syncPath,
		defaults: AGENT_SESSION_ORIGINS_DEFAULTS,
		deserialize: deserializeStoreJson,
	});

	// Account multiplexing - manages multiple Claude Code accounts
	_accountStore = new Store<AccountStoreData>({
		name: 'maestro-accounts',
		cwd: _syncPath,
		defaults: ACCOUNT_STORE_DEFAULTS,
	});

	return {
		syncPath: _syncPath,
		bootstrapStore: _bootstrapStore,
	};
}

// ============================================================================
// Internal Accessors (used by getters.ts)
// ============================================================================

/** Check if stores have been initialized */
export function isInitialized(): boolean {
	return _settingsStore !== null;
}

/** Get raw store instances (for getters.ts) */
export function getStoreInstances() {
	return {
		bootstrapStore: _bootstrapStore,
		settingsStore: _settingsStore,
		sessionsStore: _sessionsStore,
		groupsStore: _groupsStore,
		agentConfigsStore: _agentConfigsStore,
		agentCapabilitiesStore: _agentCapabilitiesStore,
		windowStateStore: _windowStateStore,
		claudeSessionOriginsStore: _claudeSessionOriginsStore,
		agentSessionOriginsStore: _agentSessionOriginsStore,
		accountStore: _accountStore,
	};
}

/** Get cached paths (for getters.ts) */
export function getCachedPaths() {
	return {
		syncPath: _syncPath,
		productionDataPath: _productionDataPath,
	};
}
