// ABOUTME: Core Prompts Module - provides prompt ID constants for type safety.
// ABOUTME: Prompts are loaded from disk at runtime via the prompt-manager.

/**
 * Core Prompts Module
 *
 * Prompts are loaded from disk at runtime via the prompt-manager.
 * This file provides prompt IDs as constants for type safety.
 *
 * To customize prompts: Edit the .md files in the app's Resources/prompts/core/
 * directory and restart the app.
 */

// Prompt IDs - use these with getPrompt() or window.maestro.prompts.get()
export const PROMPT_IDS = {
	// Wizard
	WIZARD_SYSTEM: 'wizard-system',
	WIZARD_SYSTEM_CONTINUATION: 'wizard-system-continuation',
	WIZARD_DOCUMENT_GENERATION: 'wizard-document-generation',

	// Inline Wizard
	WIZARD_INLINE_SYSTEM: 'wizard-inline-system',
	WIZARD_INLINE_ITERATE: 'wizard-inline-iterate',
	WIZARD_INLINE_NEW: 'wizard-inline-new',
	WIZARD_INLINE_ITERATE_GENERATION: 'wizard-inline-iterate-generation',

	// AutoRun
	AUTORUN_DEFAULT: 'autorun-default',
	AUTORUN_SYNOPSIS: 'autorun-synopsis',

	// Commands
	IMAGE_ONLY_DEFAULT: 'image-only-default',
	COMMIT_COMMAND: 'commit-command',

	// System
	MAESTRO_SYSTEM_PROMPT: 'maestro-system-prompt',

	// Group Chat
	GROUP_CHAT_MODERATOR_SYSTEM: 'group-chat-moderator-system',
	GROUP_CHAT_MODERATOR_SYNTHESIS: 'group-chat-moderator-synthesis',
	GROUP_CHAT_PARTICIPANT: 'group-chat-participant',
	GROUP_CHAT_PARTICIPANT_REQUEST: 'group-chat-participant-request',

	// Context
	CONTEXT_GROOMING: 'context-grooming',
	CONTEXT_TRANSFER: 'context-transfer',
	CONTEXT_SUMMARIZE: 'context-summarize',

	// Tab Naming
	TAB_NAMING: 'tab-naming',

	// Director's Notes
	DIRECTOR_NOTES: 'director-notes',
} as const;

export type PromptId = (typeof PROMPT_IDS)[keyof typeof PROMPT_IDS];
