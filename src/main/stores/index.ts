/**
 * Centralized Store Management
 *
 * This module provides the public API for all store operations:
 * - Type definitions (from ./types)
 * - Store initialization (from ./instances)
 * - Store getters (from ./getters)
 * - Utility functions (from ./utils)
 * - Default values (from ./defaults)
 *
 * IMPORTANT: initializeStores() MUST be called before accessing any store.
 * The app.setPath('userData', ...) calls MUST happen before initialization.
 *
 * Directory structure:
 * ├── index.ts      - Public API (this file)
 * ├── types.ts      - Type definitions for all stores
 * ├── defaults.ts   - Default values for all stores
 * ├── instances.ts  - Store instance management and initialization
 * ├── getters.ts    - Public getter functions
 * └── utils.ts      - Utility functions
 */

// ============================================================================
// Type Definitions
// ============================================================================

export * from './types';

// ============================================================================
// Store Initialization
// ============================================================================

export { initializeStores } from './instances';
export type { StoreInitOptions } from './instances';

// ============================================================================
// Store Getters
// ============================================================================

export {
	getBootstrapStore,
	getSettingsStore,
	getSessionsStore,
	getGroupsStore,
	getAgentConfigsStore,
	getWindowStateStore,
	getClaudeSessionOriginsStore,
	getAgentSessionOriginsStore,
	getGeminiSessionStatsStore,
	getSyncPath,
	getProductionDataPath,
	getSshRemoteById,
} from './getters';

// ============================================================================
// Utility Functions
// ============================================================================

export { getDefaultShell, getCustomSyncPath, getEarlySettings } from './utils';

// ============================================================================
// Default Values (for testing or external use)
// ============================================================================

export {
	SETTINGS_DEFAULTS,
	SESSIONS_DEFAULTS,
	GROUPS_DEFAULTS,
	AGENT_CONFIGS_DEFAULTS,
	WINDOW_STATE_DEFAULTS,
	CLAUDE_SESSION_ORIGINS_DEFAULTS,
	AGENT_SESSION_ORIGINS_DEFAULTS,
	GEMINI_SESSION_STATS_DEFAULTS,
} from './defaults';
