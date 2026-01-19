/**
 * Input Processing & Completion Module
 *
 * Hooks for user input processing, slash commands, and autocomplete features.
 */

// Main input processing
export { useInputProcessing, DEFAULT_IMAGE_ONLY_PROMPT } from './useInputProcessing';
export type {
	UseInputProcessingDeps,
	UseInputProcessingReturn,
	/** @deprecated Use BatchRunState from '../../types' directly */
	BatchState as InputBatchState,
} from './useInputProcessing';

// Input state synchronization
export { useInputSync } from './useInputSync';
export type { UseInputSyncReturn, UseInputSyncDeps } from './useInputSync';

// File/path tab completion
export { useTabCompletion } from './useTabCompletion';
export type {
	TabCompletionSuggestion,
	TabCompletionFilter,
	UseTabCompletionReturn,
} from './useTabCompletion';

// @-mention autocomplete
export { useAtMentionCompletion } from './useAtMentionCompletion';

// Template variable autocomplete
export { useTemplateAutocomplete } from './useTemplateAutocomplete';
export type { AutocompleteState } from './useTemplateAutocomplete';
