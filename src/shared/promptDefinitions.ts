/**
 * Shared Prompt Definitions
 *
 * Single source of truth for prompt IDs, filenames, descriptions, and categories.
 * Imported by both the Electron prompt-manager and the CLI prompt loader,
 * so neither needs to hardcode its own mapping.
 */

// ============================================================================
// Types
// ============================================================================

export interface PromptDefinition {
	id: string;
	filename: string;
	description: string;
	category: string;
}

// ============================================================================
// Prompt Definitions
// ============================================================================

export const CORE_PROMPTS: PromptDefinition[] = [
	// Wizard
	{
		id: 'wizard-system',
		filename: 'wizard-system.md',
		description: 'Main wizard conversation system prompt',
		category: 'wizard',
	},
	{
		id: 'wizard-system-continuation',
		filename: 'wizard-system-continuation.md',
		description: 'Wizard continuation prompt',
		category: 'wizard',
	},
	{
		id: 'wizard-document-generation',
		filename: 'wizard-document-generation.md',
		description: 'Wizard document generation prompt',
		category: 'wizard',
	},
	// Inline Wizard
	{
		id: 'wizard-inline-system',
		filename: 'wizard-inline-system.md',
		description: 'Inline wizard system prompt',
		category: 'inline-wizard',
	},
	{
		id: 'wizard-inline-iterate',
		filename: 'wizard-inline-iterate.md',
		description: 'Inline wizard iteration prompt',
		category: 'inline-wizard',
	},
	{
		id: 'wizard-inline-new',
		filename: 'wizard-inline-new.md',
		description: 'Inline wizard new session prompt',
		category: 'inline-wizard',
	},
	{
		id: 'wizard-inline-iterate-generation',
		filename: 'wizard-inline-iterate-generation.md',
		description: 'Inline wizard iteration generation',
		category: 'inline-wizard',
	},
	// AutoRun
	{
		id: 'autorun-default',
		filename: 'autorun-default.md',
		description: 'Default Auto Run behavior prompt',
		category: 'autorun',
	},
	{
		id: 'autorun-synopsis',
		filename: 'autorun-synopsis.md',
		description: 'Auto Run synopsis generation prompt',
		category: 'autorun',
	},
	// Commands
	{
		id: 'image-only-default',
		filename: 'image-only-default.md',
		description: 'Default prompt for image-only messages',
		category: 'commands',
	},
	{
		id: 'commit-command',
		filename: 'commit-command.md',
		description: 'Git commit command prompt',
		category: 'commands',
	},
	// System
	{
		id: 'maestro-system-prompt',
		filename: 'maestro-system-prompt.md',
		description: 'Maestro system context prompt',
		category: 'system',
	},
	// Group Chat
	{
		id: 'group-chat-moderator-system',
		filename: 'group-chat-moderator-system.md',
		description: 'Group chat moderator system prompt',
		category: 'group-chat',
	},
	{
		id: 'group-chat-moderator-synthesis',
		filename: 'group-chat-moderator-synthesis.md',
		description: 'Group chat synthesis prompt',
		category: 'group-chat',
	},
	{
		id: 'group-chat-participant',
		filename: 'group-chat-participant.md',
		description: 'Group chat participant prompt',
		category: 'group-chat',
	},
	{
		id: 'group-chat-participant-request',
		filename: 'group-chat-participant-request.md',
		description: 'Group chat participant request prompt',
		category: 'group-chat',
	},
	// Context
	{
		id: 'context-grooming',
		filename: 'context-grooming.md',
		description: 'Context grooming prompt',
		category: 'context',
	},
	{
		id: 'context-transfer',
		filename: 'context-transfer.md',
		description: 'Context transfer prompt',
		category: 'context',
	},
	{
		id: 'context-summarize',
		filename: 'context-summarize.md',
		description: 'Context summarization prompt',
		category: 'context',
	},
	// System (UI/meta)
	{
		id: 'tab-naming',
		filename: 'tab-naming.md',
		description: 'Tab naming prompt',
		category: 'system',
	},
	{
		id: 'director-notes',
		filename: 'director-notes.md',
		description: "Director's Notes prompt",
		category: 'system',
	},
	{
		id: 'feedback',
		filename: 'feedback.md',
		description: 'Feedback prompt',
		category: 'system',
	},
	{
		id: 'feedback-conversation',
		filename: 'feedback-conversation.md',
		description: 'Feedback conversation prompt',
		category: 'system',
	},
];

/**
 * Prompt IDs as constants for type-safe usage.
 */
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
	// System
	TAB_NAMING: 'tab-naming',
	DIRECTOR_NOTES: 'director-notes',
	FEEDBACK: 'feedback',
	FEEDBACK_CONVERSATION: 'feedback-conversation',
} as const;

export type PromptId = (typeof PROMPT_IDS)[keyof typeof PROMPT_IDS];

/**
 * Prompts surfaced in the command palette (Quick Actions) for direct editing.
 * Edit this list to add or remove prompts from the command palette.
 */
export const QUICK_ACTION_PROMPTS: { id: PromptId; label: string }[] = [
	{ id: 'maestro-system-prompt', label: 'Maestro System Prompt' },
	{ id: 'autorun-default', label: 'Auto Run Default' },
	{ id: 'commit-command', label: 'Commit Command' },
	{ id: 'group-chat-moderator-system', label: 'Group Chat Moderator' },
];

/**
 * Get filename for a prompt ID. Used by CLI loader and prompt-manager.
 */
export function getPromptFilename(id: string): string {
	const def = CORE_PROMPTS.find((p) => p.id === id);
	if (!def) {
		throw new Error(`Unknown prompt ID: ${id}`);
	}
	return def.filename;
}
