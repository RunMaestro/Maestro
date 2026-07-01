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

// @-mention autocomplete (files/directories)
export { useAtMentionCompletion } from './useAtMentionCompletion';
export type { AtMentionSuggestion } from './useAtMentionCompletion';

// @-mention autocomplete (agents/groups) - the Agents data source for the picker
export { useAgentMentionCompletion } from './useAgentMentionCompletion';
export type {
	AgentMentionSuggestion,
	UseAgentMentionCompletionReturn,
} from './useAgentMentionCompletion';

// Unified `@` mention picker (files + directories + agents + groups)
export { useMentionPicker, buildMentionAccept, MENTION_CATEGORY_CYCLE } from './useMentionPicker';
export type {
	MentionCategory,
	MentionPickerItem,
	FileMentionItem,
	MentionAcceptResult,
	UseMentionPickerParams,
	UseMentionPickerReturn,
} from './useMentionPicker';

// Template variable autocomplete
export { useTemplateAutocomplete } from './useTemplateAutocomplete';
export type { AutocompleteState } from './useTemplateAutocomplete';

// Input keyboard handling (slash commands, tab completion, @ mentions, enter-to-send)
export { useInputKeyDown } from './useInputKeyDown';
export type { InputKeyDownDeps, InputKeyDownReturn } from './useInputKeyDown';

// Input handler orchestration (Phase 2J)
export { useInputHandlers } from './useInputHandlers';
export type { UseInputHandlersDeps, UseInputHandlersReturn } from './useInputHandlers';

// Input mode toggle (Tier 3A)
export { useInputMode } from './useInputMode';
export type { UseInputModeDeps, UseInputModeReturn } from './useInputMode';
