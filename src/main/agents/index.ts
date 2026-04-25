/**
 * Agents Module
 *
 * This module consolidates all agent-related functionality:
 * - Agent detection and configuration
 * - Agent definitions and types
 * - Agent capabilities
 * - Session storage interface
 * - Binary path probing
 *
 * Usage:
 * ```typescript
 * import { AgentDetector, AGENT_DEFINITIONS, getAgentCapabilities } from './agents';
 * ```
 */

// ============ Capabilities ============
export {
	type AgentCapabilities,
	DEFAULT_CAPABILITIES,
	AGENT_CAPABILITIES,
	getAgentCapabilities,
	hasCapability,
} from './capabilities';

// ============ Definitions ============
export {
	type AgentConfigOption,
	type AgentConfig,
	type AgentDefinition,
	AGENT_DEFINITIONS,
	getAgentDefinition,
	getAgentIds,
	getVisibleAgentDefinitions,
} from './definitions';

// ============ Detector ============
export { AgentDetector } from './detector';

// ============ Path Prober ============
export {
	type BinaryDetectionResult,
	getExpandedEnv,
	checkCustomPath,
	probeWindowsPaths,
	probeUnixPaths,
	checkBinaryExists,
} from './path-prober';

// ============ OpenCode Config ============
export {
	type OpenCodeConfig,
	type OpenCodeProvider,
	type OpenCodeModelEntry,
	getOpenCodeConfigPaths,
	getOpenCodeCommandDirs,
	parseOpenCodeConfig,
	extractModelsFromConfig,
	discoverModelsFromLocalConfigs,
} from './opencode-config';

// ============ Session Storage ============
export {
	type AgentSessionOrigin,
	type SessionMessage,
	type AgentSessionInfo,
	type PaginatedSessionsResult,
	type SessionMessagesResult,
	type SessionSearchResult,
	type SessionSearchMode,
	type SessionListOptions,
	type SessionReadOptions,
	type SessionOriginInfo,
	type AgentSessionStorage,
	registerSessionStorage,
	getSessionStorage,
	hasSessionStorage,
	getAllSessionStorages,
	clearStorageRegistry,
} from './session-storage';
