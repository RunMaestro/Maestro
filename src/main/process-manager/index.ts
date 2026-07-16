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

// Utilities that are used externally
export { buildUnixBasePath } from './utils/envBuilder';
export { detectNodeVersionManagerBinPaths } from '../../shared/pathUtils';
