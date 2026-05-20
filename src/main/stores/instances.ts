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
	LegacyWindowState,
	MultiWindowState,
	ClaudeSessionOriginsData,
	AgentSessionOriginsData,
	WindowState,
} from './types';

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

import { getCustomSyncPath } from './utils';

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
let _windowStateStore: Store<MultiWindowState> | null = null;
let _claudeSessionOriginsStore: Store<ClaudeSessionOriginsData> | null = null;
let _agentSessionOriginsStore: Store<AgentSessionOriginsData> | null = null;

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

const WINDOW_STATE_SCHEMA: Store.Schema<MultiWindowState> = {
	primaryWindowId: {
		type: 'string',
		default: WINDOW_STATE_DEFAULTS.primaryWindowId,
	},
	windows: {
		type: 'array',
		default: WINDOW_STATE_DEFAULTS.windows,
		items: {
			type: 'object',
			required: [
				'id',
				'x',
				'y',
				'width',
				'height',
				'isMaximized',
				'isFullScreen',
				'sessionIds',
				'activeSessionId',
				'leftPanelCollapsed',
				'rightPanelCollapsed',
			],
			properties: {
				id: { type: 'string' },
				x: { type: 'number' },
				y: { type: 'number' },
				width: { type: 'number', minimum: 1 },
				height: { type: 'number', minimum: 1 },
				isMaximized: { type: 'boolean' },
				isFullScreen: { type: 'boolean' },
				sessionIds: { type: 'array', items: { type: 'string' } },
				activeSessionId: { type: ['string', 'null'] },
				leftPanelCollapsed: { type: 'boolean' },
				rightPanelCollapsed: { type: 'boolean' },
			},
		},
	},
};

function isLegacyWindowState(value: unknown): value is LegacyWindowState {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const candidate = value as Partial<LegacyWindowState>;
	return (
		typeof candidate.width === 'number' &&
		typeof candidate.height === 'number' &&
		typeof candidate.isMaximized === 'boolean' &&
		typeof candidate.isFullScreen === 'boolean'
	);
}

function createPrimaryWindowStateFromLegacy(legacyState: LegacyWindowState): WindowState {
	return {
		id: 'primary',
		x: legacyState.x ?? 0,
		y: legacyState.y ?? 0,
		width: legacyState.width,
		height: legacyState.height,
		isMaximized: legacyState.isMaximized,
		isFullScreen: legacyState.isFullScreen,
		sessionIds: [],
		activeSessionId: null,
		leftPanelCollapsed: false,
		rightPanelCollapsed: false,
	};
}

function migrateLegacyWindowStateStore(windowStateStore: Store<MultiWindowState>): void {
	const rawState = windowStateStore.store as MultiWindowState & Partial<LegacyWindowState>;

	if (!isLegacyWindowState(rawState)) {
		return;
	}

	windowStateStore.store = {
		primaryWindowId: rawState.primaryWindowId || 'primary',
		windows: [createPrimaryWindowStateFromLegacy(rawState)],
	};
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
	_windowStateStore = new Store<MultiWindowState>({
		name: 'maestro-window-state',
		schema: WINDOW_STATE_SCHEMA,
		defaults: WINDOW_STATE_DEFAULTS,
		deserialize: deserializeStoreJson,
	});
	migrateLegacyWindowStateStore(_windowStateStore);

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
	};
}

/** Get cached paths (for getters.ts) */
export function getCachedPaths() {
	return {
		syncPath: _syncPath,
		productionDataPath: _productionDataPath,
	};
}
