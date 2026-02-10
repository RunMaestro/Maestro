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

import type {
	BootstrapSettings,
	MaestroSettings,
	SessionsData,
	GroupsData,
	AgentConfigsData,
	WindowState,
	ClaudeSessionOriginsData,
	AgentSessionOriginsData,
} from './types';
import type { MultiWindowState } from '../../shared/types/window';

import {
	SETTINGS_DEFAULTS,
	SESSIONS_DEFAULTS,
	GROUPS_DEFAULTS,
	AGENT_CONFIGS_DEFAULTS,
	WINDOW_STATE_DEFAULTS,
	CLAUDE_SESSION_ORIGINS_DEFAULTS,
	AGENT_SESSION_ORIGINS_DEFAULTS,
} from './defaults';

import { getCustomSyncPath } from './utils';

const DEFAULT_WINDOW_ID =
	WINDOW_STATE_DEFAULTS.multiWindowState?.primaryWindowId ?? 'primary';

function isValidMultiWindowState(state?: MultiWindowState | null): state is MultiWindowState {
	if (!state) {
		return false;
	}
	if (!Array.isArray(state.windows) || state.windows.length === 0) {
		return false;
	}
	if (typeof state.primaryWindowId !== 'string') {
		return false;
	}
	return state.windows.some((window) => window.id === state.primaryWindowId);
}

function buildMultiWindowStateFromLegacy(store: Store<WindowState>): MultiWindowState {
	const fallbackWindowTemplate = WINDOW_STATE_DEFAULTS.multiWindowState?.windows?.[0];
	const width = store.get('width', WINDOW_STATE_DEFAULTS.width);
	const height = store.get('height', WINDOW_STATE_DEFAULTS.height);
	const isMaximized = store.get('isMaximized', WINDOW_STATE_DEFAULTS.isMaximized);
	const isFullScreen = store.get('isFullScreen', WINDOW_STATE_DEFAULTS.isFullScreen);

	return {
		primaryWindowId: DEFAULT_WINDOW_ID,
		windows: [
			{
				id: DEFAULT_WINDOW_ID,
				x: store.get('x'),
				y: store.get('y'),
				width,
				height,
				isMaximized,
				isFullScreen,
				sessionIds: fallbackWindowTemplate?.sessionIds ?? [],
				activeSessionId: fallbackWindowTemplate?.activeSessionId ?? null,
				leftPanelCollapsed: fallbackWindowTemplate?.leftPanelCollapsed ?? false,
				rightPanelCollapsed: fallbackWindowTemplate?.rightPanelCollapsed ?? false,
			},
		],
	};
}

function ensureMultiWindowState(store: Store<WindowState>): void {
	const currentState = store.get('multiWindowState');
	if (isValidMultiWindowState(currentState)) {
		return;
	}
	const migratedState = buildMultiWindowStateFromLegacy(store);
	store.set('multiWindowState', migratedState);
}

// ============================================================================
// Store Instance Variables
// ============================================================================

let _bootstrapStore: Store<BootstrapSettings> | null = null;
let _settingsStore: Store<MaestroSettings> | null = null;
let _sessionsStore: Store<SessionsData> | null = null;
let _groupsStore: Store<GroupsData> | null = null;
let _agentConfigsStore: Store<AgentConfigsData> | null = null;
let _windowStateStore: Store<WindowState> | null = null;
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
	});

	_sessionsStore = new Store<SessionsData>({
		name: 'maestro-sessions',
		cwd: _syncPath,
		defaults: SESSIONS_DEFAULTS,
	});

	_groupsStore = new Store<GroupsData>({
		name: 'maestro-groups',
		cwd: _syncPath,
		defaults: GROUPS_DEFAULTS,
	});

	// Agent configs are ALWAYS stored in the production path, even in dev mode
	// This ensures agent paths, custom args, and env vars are shared between dev and prod
	_agentConfigsStore = new Store<AgentConfigsData>({
		name: 'maestro-agent-configs',
		cwd: _productionDataPath,
		defaults: AGENT_CONFIGS_DEFAULTS,
	});

	// Window state is intentionally NOT synced - it's per-device
	_windowStateStore = new Store<WindowState>({
		name: 'maestro-window-state',
		defaults: WINDOW_STATE_DEFAULTS,
	});
	ensureMultiWindowState(_windowStateStore);

	// Claude session origins - tracks which sessions were created by Maestro
	_claudeSessionOriginsStore = new Store<ClaudeSessionOriginsData>({
		name: 'maestro-claude-session-origins',
		cwd: _syncPath,
		defaults: CLAUDE_SESSION_ORIGINS_DEFAULTS,
	});

	// Generic agent session origins - supports all agents (Codex, OpenCode, etc.)
	_agentSessionOriginsStore = new Store<AgentSessionOriginsData>({
		name: 'maestro-agent-session-origins',
		cwd: _syncPath,
		defaults: AGENT_SESSION_ORIGINS_DEFAULTS,
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
