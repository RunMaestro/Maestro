/**
 * Batch Processing & Auto Run Module
 *
 * Hooks and utilities for batch/Auto Run document processing,
 * including state management, document handling, and playbook configuration.
 */

// Utility functions for markdown task processing
export {
	countUnfinishedTasks,
	countCheckedTasks,
	uncheckAllTasks,
	DEFAULT_BATCH_PROMPT,
	validateAgentPromptHasTaskReference,
} from './batchUtils';

// Debounce hook for per-session state updates
export { useSessionDebounce } from './useSessionDebounce';
export type { UseSessionDebounceOptions, UseSessionDebounceReturn } from './useSessionDebounce';

// Batch state reducer and types
export { batchReducer, DEFAULT_BATCH_STATE } from './batchReducer';
export type {
	BatchState,
	BatchAction,
	StartBatchPayload,
	UpdateProgressPayload,
	SetErrorPayload,
} from './batchReducer';

// Visibility-aware time tracking hook
export { useTimeTracking } from './useTimeTracking';
export type { UseTimeTrackingOptions, UseTimeTrackingReturn } from './useTimeTracking';

// Document processing hook
export { useDocumentProcessor } from './useDocumentProcessor';
export type {
	DocumentProcessorConfig,
	TaskResult,
	DocumentReadResult,
	DocumentProcessorCallbacks,
	UseDocumentProcessorReturn,
} from './useDocumentProcessor';

// Git worktree management hook
export { useWorktreeManager } from './useWorktreeManager';
export type {
	WorktreeConfig,
	WorktreeSetupResult,
	PRCreationResult,
	CreatePROptions,
	UseWorktreeManagerReturn,
} from './useWorktreeManager';

// Batch processing state machine
export {
	transition,
	canTransition,
	getValidEvents,
	DEFAULT_MACHINE_CONTEXT,
} from './batchStateMachine';
export type {
	BatchProcessingState,
	BatchMachineContext,
	BatchEvent,
	InitializePayload,
	TaskCompletedPayload,
	ErrorOccurredPayload,
	LoopCompletedPayload,
} from './batchStateMachine';

// Main batch processor hook
export { useBatchProcessor } from './useBatchProcessor';
export type { BatchCompleteInfo, PRResultInfo } from './useBatchProcessor';

// Batch handler orchestration (Phase 2I)
export { useBatchHandlers } from './useBatchHandlers';
export type { UseBatchHandlersDeps, UseBatchHandlersReturn } from './useBatchHandlers';

// Auto Run event handlers
export { useAutoRunHandlers } from './useAutoRunHandlers';
export type {
	UseAutoRunHandlersReturn,
	UseAutoRunHandlersDeps,
	AutoRunTreeNode,
} from './useAutoRunHandlers';

// Auto Run image handling
export { useAutoRunImageHandling, imageCache } from './useAutoRunImageHandling';
export type {
	UseAutoRunImageHandlingReturn,
	UseAutoRunImageHandlingDeps,
} from './useAutoRunImageHandling';

// Auto Run undo/redo
export { useAutoRunUndo } from './useAutoRunUndo';
export type { UseAutoRunUndoReturn, UseAutoRunUndoDeps, UndoState } from './useAutoRunUndo';

// Playbook management
export { usePlaybookManagement } from './usePlaybookManagement';
export type {
	UsePlaybookManagementReturn,
	UsePlaybookManagementDeps,
	PlaybookConfigState,
} from './usePlaybookManagement';

// Worktree validation
export { useWorktreeValidation } from './useWorktreeValidation';
export type {
	UseWorktreeValidationReturn,
	UseWorktreeValidationDeps,
} from './useWorktreeValidation';

// Auto Run achievements/badges
export { useAchievements, queueAchievement } from './useAchievements';
export type {
	AchievementState,
	PendingAchievement,
	UseAchievementsReturn,
} from './useAchievements';

// Marketplace browsing and import
export { useMarketplace } from './useMarketplace';
export type { UseMarketplaceReturn } from './useMarketplace';

// Inline wizard for creating/iterating Auto Run documents
export { useInlineWizard } from './useInlineWizard';
export type {
	InlineWizardMode,
	InlineWizardMessage,
	PreviousUIState,
	InlineGeneratedDocument,
	InlineWizardState,
	UseInlineWizardReturn,
} from './useInlineWizard';

// Auto Run achievements tracking (progress intervals, peak stats)
export { useAutoRunAchievements } from './useAutoRunAchievements';
export type { UseAutoRunAchievementsDeps } from './useAutoRunAchievements';

// Auto Run document loader (list, tree, task counts, file watching)
export { useAutoRunDocumentLoader } from './useAutoRunDocumentLoader';
export type { UseAutoRunDocumentLoaderReturn } from './useAutoRunDocumentLoader';

// Auto Run auto-follow (document tracking during batch runs)
export { useAutoRunAutoFollow } from './useAutoRunAutoFollow';
export type { UseAutoRunAutoFollowDeps, UseAutoRunAutoFollowReturn } from './useAutoRunAutoFollow';

// Re-export ExistingDocument type from existingDocsDetector for convenience
export type { ExistingDocument } from '../../utils/existingDocsDetector';
