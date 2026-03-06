/**
 * AI Agent Communication Module
 *
 * Hooks for agent execution, capabilities, session management,
 * error recovery, agent sessions browsing, and context operations.
 */

// Agent spawn and execution
export { useAgentExecution } from './useAgentExecution';
export type {
	UseAgentExecutionDeps,
	UseAgentExecutionReturn,
	AgentSpawnResult,
} from './useAgentExecution';

// Agent capability queries
export {
	useAgentCapabilities,
	clearCapabilitiesCache,
	setCapabilitiesCache,
	DEFAULT_CAPABILITIES,
} from './useAgentCapabilities';
export type { AgentCapabilities, UseAgentCapabilitiesReturn } from './useAgentCapabilities';

// Agent session history and resume
export { useAgentSessionManagement } from './useAgentSessionManagement';
export type {
	UseAgentSessionManagementDeps,
	UseAgentSessionManagementReturn,
	HistoryEntryInput,
} from './useAgentSessionManagement';

// Agent error recovery UI
export { useAgentErrorRecovery } from './useAgentErrorRecovery';
export type {
	UseAgentErrorRecoveryOptions,
	UseAgentErrorRecoveryResult,
} from './useAgentErrorRecovery';

// Agent sessions browser
export { useSessionViewer } from './useSessionViewer';
export type {
	UseSessionViewerReturn,
	UseSessionViewerDeps,
	AgentSession,
	ClaudeSession,
	SessionMessage,
} from './useSessionViewer';

// Paginated session loading
export { useSessionPagination } from './useSessionPagination';
export type { UseSessionPaginationReturn, UseSessionPaginationDeps } from './useSessionPagination';

// Agent sessions filtering and sorting
export { useFilteredAndSortedSessions } from './useFilteredAndSortedSessions';
export type {
	UseFilteredAndSortedSessionsReturn,
	UseFilteredAndSortedSessionsDeps,
	SearchResult as FilteredSearchResult,
	SearchMode as FilteredSearchMode,
} from './useFilteredAndSortedSessions';

// Available agents detection
export { useAvailableAgents, useAvailableAgentsForCapability } from './useAvailableAgents';
export type { AgentStatus, AvailableAgent, UseAvailableAgentsReturn } from './useAvailableAgents';

// Session merge (combine sessions)
export { useMergeSession, useMergeSessionWithSessions } from './useMergeSession';
export type {
	MergeState,
	MergeSessionRequest,
	UseMergeSessionResult,
	UseMergeSessionWithSessionsDeps,
	UseMergeSessionWithSessionsResult,
} from './useMergeSession';

// Send to agent (transfer context)
export { useSendToAgent, useSendToAgentWithSessions } from './useSendToAgent';
export type {
	TransferState,
	TransferRequest,
	UseSendToAgentResult,
	UseSendToAgentWithSessionsDeps,
	UseSendToAgentWithSessionsResult,
} from './useSendToAgent';

// Summarize and continue (context compaction)
export { useSummarizeAndContinue } from './useSummarizeAndContinue';
export type {
	SummarizeState,
	TabSummarizeState,
	UseSummarizeAndContinueResult,
} from './useSummarizeAndContinue';

// Merge & transfer orchestration (Phase 2.5)
export { useMergeTransferHandlers } from './useMergeTransferHandlers';
export type {
	UseMergeTransferHandlersDeps,
	UseMergeTransferHandlersReturn,
} from './useMergeTransferHandlers';

// Agent IPC listeners (process event routing)
export { useAgentListeners, getErrorTitleForType } from './useAgentListeners';
export type { UseAgentListenersDeps } from './useAgentListeners';

// Interrupt handler (stop running AI processes)
export { useInterruptHandler } from './useInterruptHandler';
export type { UseInterruptHandlerDeps, UseInterruptHandlerReturn } from './useInterruptHandler';

// Queue handlers (queue browser UI operations)
export { useQueueHandlers } from './useQueueHandlers';
export type { UseQueueHandlersReturn } from './useQueueHandlers';

// Queue processing (execution queue processing and startup recovery)
export { useQueueProcessing } from './useQueueProcessing';
export type { UseQueueProcessingDeps, UseQueueProcessingReturn } from './useQueueProcessing';

// Agent configuration state management (detection, config, models, SSH)
export { useAgentConfiguration } from './useAgentConfiguration';
export type {
	UseAgentConfigurationOptions,
	UseAgentConfigurationReturn,
} from './useAgentConfiguration';
