// Main class
export { ProcessManager } from './ProcessManager';

// Types - all exported for consumers
export type {
	ProcessConfig,
	ManagedProcess,
	SpawnResult,
	CommandResult,
	UsageStats,
	UsageTotals,
	ProcessManagerEvents,
	ParsedEvent,
	AgentOutputParser,
	AgentError,
	AgentErrorType,
	SshRemoteConfig,
} from './types';

// Re-export parser utilities for backwards compatibility
export { getOutputParser } from '../parsers';
export type { ModelStats } from '../parsers/usage-aggregator';
export { aggregateModelUsage } from '../parsers/usage-aggregator';

// Utilities that are used externally
export { buildUnixBasePath } from './utils/envBuilder';
export { detectNodeVersionManagerBinPaths } from '../../shared/pathUtils';
