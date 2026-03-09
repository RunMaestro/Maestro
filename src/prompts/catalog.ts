// ABOUTME: Shared core prompt catalog used by both prompt-manager and PROMPT_IDS exports.
// ABOUTME: Prevents prompt ID drift by defining prompt metadata in a single source.

export interface PromptDefinition {
	id: string;
	filename: string;
	description: string;
	category: string;
}

const CORE_PROMPT_ENTRIES = [
	['WIZARD_SYSTEM', { id: 'wizard-system', filename: 'wizard-system.md', description: 'Main wizard conversation system prompt', category: 'wizard' }],
	['WIZARD_SYSTEM_CONTINUATION', { id: 'wizard-system-continuation', filename: 'wizard-system-continuation.md', description: 'Wizard continuation prompt', category: 'wizard' }],
	['WIZARD_DOCUMENT_GENERATION', { id: 'wizard-document-generation', filename: 'wizard-document-generation.md', description: 'Wizard document generation prompt', category: 'wizard' }],
	['WIZARD_INLINE_SYSTEM', { id: 'wizard-inline-system', filename: 'wizard-inline-system.md', description: 'Inline wizard system prompt', category: 'inline-wizard' }],
	['WIZARD_INLINE_ITERATE', { id: 'wizard-inline-iterate', filename: 'wizard-inline-iterate.md', description: 'Inline wizard iteration prompt', category: 'inline-wizard' }],
	['WIZARD_INLINE_NEW', { id: 'wizard-inline-new', filename: 'wizard-inline-new.md', description: 'Inline wizard new session prompt', category: 'inline-wizard' }],
	['WIZARD_INLINE_ITERATE_GENERATION', { id: 'wizard-inline-iterate-generation', filename: 'wizard-inline-iterate-generation.md', description: 'Inline wizard iteration generation', category: 'inline-wizard' }],
	['AUTORUN_DEFAULT', { id: 'autorun-default', filename: 'autorun-default.md', description: 'Default Auto Run behavior prompt', category: 'autorun' }],
	['AUTORUN_SYNOPSIS', { id: 'autorun-synopsis', filename: 'autorun-synopsis.md', description: 'Auto Run synopsis generation prompt', category: 'autorun' }],
	['IMAGE_ONLY_DEFAULT', { id: 'image-only-default', filename: 'image-only-default.md', description: 'Default prompt for image-only messages', category: 'commands' }],
	['COMMIT_COMMAND', { id: 'commit-command', filename: 'commit-command.md', description: 'Git commit command prompt', category: 'commands' }],
	['MAESTRO_SYSTEM_PROMPT', { id: 'maestro-system-prompt', filename: 'maestro-system-prompt.md', description: 'Maestro system context prompt', category: 'system' }],
	['GROUP_CHAT_MODERATOR_SYSTEM', { id: 'group-chat-moderator-system', filename: 'group-chat-moderator-system.md', description: 'Group chat moderator system prompt', category: 'group-chat' }],
	['GROUP_CHAT_MODERATOR_SYNTHESIS', { id: 'group-chat-moderator-synthesis', filename: 'group-chat-moderator-synthesis.md', description: 'Group chat synthesis prompt', category: 'group-chat' }],
	['GROUP_CHAT_PARTICIPANT', { id: 'group-chat-participant', filename: 'group-chat-participant.md', description: 'Group chat participant prompt', category: 'group-chat' }],
	['GROUP_CHAT_PARTICIPANT_REQUEST', { id: 'group-chat-participant-request', filename: 'group-chat-participant-request.md', description: 'Group chat participant request prompt', category: 'group-chat' }],
	['CONTEXT_GROOMING', { id: 'context-grooming', filename: 'context-grooming.md', description: 'Context grooming prompt', category: 'context' }],
	['CONTEXT_TRANSFER', { id: 'context-transfer', filename: 'context-transfer.md', description: 'Context transfer prompt', category: 'context' }],
	['CONTEXT_SUMMARIZE', { id: 'context-summarize', filename: 'context-summarize.md', description: 'Context summarization prompt', category: 'context' }],
	['TAB_NAMING', { id: 'tab-naming', filename: 'tab-naming.md', description: 'Tab naming prompt', category: 'commands' }],
	['DIRECTOR_NOTES', { id: 'director-notes', filename: 'director-notes.md', description: 'Director notes synopsis prompt', category: 'system' }],
] as const satisfies ReadonlyArray<readonly [string, PromptDefinition]>;

type PromptEntry = (typeof CORE_PROMPT_ENTRIES)[number];
type PromptKey = PromptEntry[0];

export const CORE_PROMPT_DEFINITIONS: PromptDefinition[] = CORE_PROMPT_ENTRIES.map(
	([, definition]) => ({ ...definition })
);

const promptIdEntries = CORE_PROMPT_ENTRIES.map(([key, definition]) => [key, definition.id] as const);

export const PROMPT_IDS = Object.freeze(
	Object.fromEntries(promptIdEntries)
) as {
	readonly [K in PromptKey]: Extract<(typeof promptIdEntries)[number], readonly [K, string]>[1];
};

export type PromptId = (typeof PROMPT_IDS)[keyof typeof PROMPT_IDS];
