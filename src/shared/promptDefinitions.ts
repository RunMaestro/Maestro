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
	{
		id: 'group-chat-participant-continuation',
		filename: 'group-chat-participant-continuation.md',
		description:
			'Group chat participant request prompt for resumed sessions (no identity preamble)',
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
	// Includes — reusable blocks referenced from other prompts via {{INCLUDE:name}}.
	// Filenames are leading-underscore by convention; id matches filename stem.
	{
		id: '_toc',
		filename: '_toc.md',
		description: 'Table of contents listing all include files and when to pull them',
		category: 'includes',
	},
	{
		id: '_interface-primitives',
		filename: '_interface-primitives.md',
		description: 'Read / Write / Peek / Poke access model and intent→action routing table',
		category: 'includes',
	},
	{
		id: '_documentation-index',
		filename: '_documentation-index.md',
		description: 'Curated table of external Maestro documentation URLs',
		category: 'includes',
	},
	{
		id: '_history-format',
		filename: '_history-format.md',
		description: 'JSON schema of session history entries at {{AGENT_HISTORY_PATH}}',
		category: 'includes',
	},
	{
		id: '_autorun-playbooks',
		filename: '_autorun-playbooks.md',
		description:
			'Spec for Auto Run documents (playbooks): file naming, task format, and Playbook Exchange',
		category: 'includes',
	},
	{
		id: '_maestro-cli',
		filename: '_maestro-cli.md',
		description: 'Full `maestro-cli` reference covering settings, agents, playbooks, cue, and more',
		category: 'includes',
	},
	{
		id: '_maestro-cue',
		filename: '_maestro-cue.md',
		description:
			'Maestro Cue reference: event types, `maestro-cue.yaml` schema, pipeline topologies, and template variables',
		category: 'includes',
	},
	{
		id: '_file-access-rules',
		filename: '_file-access-rules.md',
		description: 'Agent write restrictions and Auto Run folder carve-out',
		category: 'includes',
	},
	{
		id: '_file-access-wizard',
		filename: '_file-access-wizard.md',
		description: 'Wizard-only file restrictions (writes limited to Auto Run folder)',
		category: 'includes',
	},
	// Conversational PRD Planner
	{
		id: 'conversational-prd-planner',
		filename: 'conversational-prd-planner.md',
		description: 'Conversational PRD planner system prompt',
		category: 'conversational-prd',
	},
	// PM slash-command suite (#428 + #436)
	{
		id: 'pm-orchestrator',
		filename: 'pm/pm-orchestrator.md',
		description: '/PM <idea> orchestrator primer',
		category: 'pm',
	},
	{
		id: 'pm-prd-new',
		filename: 'pm/pm-prd-new.md',
		description: '/PM prd-new seed prompt',
		category: 'pm',
	},
	{
		id: 'pm-prd-edit',
		filename: 'pm/pm-prd-edit.md',
		description: '/PM prd-edit seed prompt',
		category: 'pm',
	},
	{
		id: 'pm-prd-status',
		filename: 'pm/pm-prd-status.md',
		description: '/PM prd-status display prompt',
		category: 'pm',
	},
	{
		id: 'pm-prd-parse',
		filename: 'pm/pm-prd-parse.md',
		description: '/PM prd-parse conversion prompt',
		category: 'pm',
	},
	{
		id: 'pm-prd-list',
		filename: 'pm/pm-prd-list.md',
		description: '/PM prd-list display prompt',
		category: 'pm',
	},
	{
		id: 'pm-epic-decompose',
		filename: 'pm/pm-epic-decompose.md',
		description: '/PM epic-decompose prompt',
		category: 'pm',
	},
	{
		id: 'pm-epic-edit',
		filename: 'pm/pm-epic-edit.md',
		description: '/PM epic-edit prompt',
		category: 'pm',
	},
	{
		id: 'pm-epic-list',
		filename: 'pm/pm-epic-list.md',
		description: '/PM epic-list display prompt',
		category: 'pm',
	},
	{
		id: 'pm-epic-show',
		filename: 'pm/pm-epic-show.md',
		description: '/PM epic-show display prompt',
		category: 'pm',
	},
	{
		id: 'pm-epic-sync',
		filename: 'pm/pm-epic-sync.md',
		description: '/PM epic-sync GitHub sync prompt',
		category: 'pm',
	},
	{
		id: 'pm-epic-start',
		filename: 'pm/pm-epic-start.md',
		description: '/PM epic-start pipeline kick prompt',
		category: 'pm',
	},
	{
		id: 'pm-issue-start',
		filename: 'pm/pm-issue-start.md',
		description: '/PM issue-start claim prompt',
		category: 'pm',
	},
	{
		id: 'pm-issue-show',
		filename: 'pm/pm-issue-show.md',
		description: '/PM issue-show display prompt',
		category: 'pm',
	},
	{
		id: 'pm-issue-status',
		filename: 'pm/pm-issue-status.md',
		description: '/PM issue-status quick status prompt',
		category: 'pm',
	},
	{
		id: 'pm-issue-sync',
		filename: 'pm/pm-issue-sync.md',
		description: '/PM issue-sync GitHub roundtrip prompt',
		category: 'pm',
	},
	{
		id: 'pm-next',
		filename: 'pm/pm-next.md',
		description: '/PM next eligible work item prompt',
		category: 'pm',
	},
	{
		id: 'pm-status',
		filename: 'pm/pm-status.md',
		description: '/PM status board snapshot prompt',
		category: 'pm',
	},
	{
		id: 'pm-standup',
		filename: 'pm/pm-standup.md',
		description: '/PM standup summary prompt',
		category: 'pm',
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
	GROUP_CHAT_PARTICIPANT_CONTINUATION: 'group-chat-participant-continuation',
	// Context
	CONTEXT_GROOMING: 'context-grooming',
	CONTEXT_TRANSFER: 'context-transfer',
	CONTEXT_SUMMARIZE: 'context-summarize',
	// System
	TAB_NAMING: 'tab-naming',
	DIRECTOR_NOTES: 'director-notes',
	FEEDBACK: 'feedback',
	FEEDBACK_CONVERSATION: 'feedback-conversation',
	// Conversational PRD Planner
	CONVERSATIONAL_PRD_PLANNER: 'conversational-prd-planner',
	// PM slash-command suite (#428 + #436)
	PM_ORCHESTRATOR: 'pm-orchestrator',
	PM_PRD_NEW: 'pm-prd-new',
	PM_PRD_EDIT: 'pm-prd-edit',
	PM_PRD_STATUS: 'pm-prd-status',
	PM_PRD_PARSE: 'pm-prd-parse',
	PM_PRD_LIST: 'pm-prd-list',
	PM_EPIC_DECOMPOSE: 'pm-epic-decompose',
	PM_EPIC_EDIT: 'pm-epic-edit',
	PM_EPIC_LIST: 'pm-epic-list',
	PM_EPIC_SHOW: 'pm-epic-show',
	PM_EPIC_SYNC: 'pm-epic-sync',
	PM_EPIC_START: 'pm-epic-start',
	PM_ISSUE_START: 'pm-issue-start',
	PM_ISSUE_SHOW: 'pm-issue-show',
	PM_ISSUE_STATUS: 'pm-issue-status',
	PM_ISSUE_SYNC: 'pm-issue-sync',
	PM_NEXT: 'pm-next',
	PM_STATUS: 'pm-status',
	PM_STANDUP: 'pm-standup',
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
