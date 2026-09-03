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

// Template variable autocomplete: shared state machine plus one binding per
// text surface (textarea, CodeMirror).
export { useTemplateAutocomplete } from './useTemplateAutocomplete';
export { useEditorTemplateAutocomplete } from './useEditorTemplateAutocomplete';
export { useTemplateAutocompleteEngine } from './useTemplateAutocompleteEngine';
export type {
	AutocompleteState,
	TemplateAutocompleteTarget,
} from './useTemplateAutocompleteEngine';

// Input keyboard handling (slash commands, tab completion, @ mentions, enter-to-send)
export { useInputKeyDown } from './useInputKeyDown';
export type { InputKeyDownDeps, InputKeyDownReturn } from './useInputKeyDown';

// Input handler orchestration (Phase 2J)
export { useInputHandlers } from './useInputHandlers';
export type { UseInputHandlersDeps, UseInputHandlersReturn } from './useInputHandlers';

// Input mode toggle (Tier 3A)
export { useInputMode } from './useInputMode';
export type { UseInputModeDeps, UseInputModeReturn } from './useInputMode';
