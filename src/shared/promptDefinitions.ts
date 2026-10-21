/**
 * Shared Prompt Definitions
 *
 * Single source of truth for prompt IDs, filenames, descriptions, and categories.
 * Imported by both the Electron prompt-manager and the CLI prompt loader,
 * so neither needs to hardcode its own mapping.
 */

import { resolveEncoreFeatures, type EncoreFeatureDefaults } from './encoreFeatureDefaults';

// ============================================================================
// Types
// ============================================================================

export interface PromptDefinition {
	id: string;
	filename: string;
	description: string;
	category: string;
	/**
	 * Encore Feature this prompt belongs to. Settings -> Maestro Prompts leaves
	 * it out while that feature is off (see `isPromptAvailable`). It does not
	 * change loading: agents and `maestro-cli prompts get` still resolve it.
	 */
	encoreFlag?: keyof EncoreFeatureDefaults;
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
		id: 'autorun-goal',
		filename: 'autorun-goal.md',
		description: 'Goal-Driven Auto Run behavior prompt',
		category: 'autorun',
	},
	{
		id: 'autorun-synopsis',
		filename: 'autorun-synopsis.md',
		description: 'Auto Run synopsis generation prompt',
		category: 'autorun',
	},
	{
		id: 'autorun-per-task',
		filename: 'autorun-per-task.md',
		description:
			'Task-selection block injected into {{TASK_SELECTION_BLOCK}} when Fresh Context Per is set to Task',
		category: 'autorun',
	},
	{
		id: 'autorun-per-document',
		filename: 'autorun-per-document.md',
		description:
			'Task-selection block injected into {{TASK_SELECTION_BLOCK}} when Fresh Context Per is set to Document',
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
	{
		id: 'ai-command',
		filename: 'ai-command.md',
		description:
			'AI command mode: turns a plain-English request into one shell command line for confirmation',
		category: 'commands',
	},
	// Per-agent prompt preambles
	{
		id: 'copilot-preamble',
		filename: 'copilot-preamble.md',
		description:
			'Prepended to every Copilot-CLI batch prompt to push back on premature task_complete and produce a richer summary',
		category: 'agent-preambles',
	},
	// System
	{
		id: 'maestro-system-prompt',
		filename: 'maestro-system-prompt.md',
		description: 'Maestro system context prompt',
		category: 'system',
	},
	// Pianola (autonomous manager agent)
	{
		id: 'pianola-system',
		filename: 'pianola-system.md',
		description: 'Pianola manager agent system prompt (appended for the pinned Pianola agent)',
		category: 'pianola',
		encoreFlag: 'pianola',
	},
	// Computer History (first-party plugin system-prompt section)
	{
		id: 'computer-history-system',
		filename: 'computer-history-system.md',
		description:
			'Computer History section appended to every local agent system prompt while the feature is on',
		category: 'computer-history',
		encoreFlag: 'computerHistory',
	},
	// Concerto (first-party plugin system-prompt section)
	{
		id: 'concerto-system',
		filename: 'concerto-system.md',
		description:
			'Concerto routing section appended to every agent system prompt while the feature is on',
		category: 'concerto',
		encoreFlag: 'concerto',
	},
	// Maestro Cue (first-party plugin system-prompt section)
	{
		id: 'cue-system',
		filename: 'cue-system.md',
		description:
			'Maestro Cue section appended to every agent system prompt while the feature is on: routing, scheduling, and duty lookup',
		category: 'system',
		encoreFlag: 'maestroCue',
	},
	// Concerto views and the designer workflow (include, read from concerto-system)
	{
		id: '_concerto',
		filename: '_concerto.md',
		description:
			'Concerto guide: cadenza and movement commands, block specs, HTML mockups, and the designer workflow',
		category: 'includes',
		encoreFlag: 'concerto',
	},
	// MaestroRun (first-party plugin system-prompt section, macOS only)
	{
		id: 'maestro-run-system',
		filename: 'maestro-run-system.md',
		description:
			'MaestroRun section appended to every local agent system prompt once the launcher is installed and holds Full Disk Access',
		category: 'maestro-run',
		encoreFlag: 'maestroRun',
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
	{
		id: 'cross-agent-consult-pending',
		filename: 'cross-agent-consult-pending.md',
		description:
			'Appended to a turn that @mentions another agent mid-message: the consult is running in parallel, so work but do not finish yet',
		category: 'context',
	},
	{
		id: 'cross-agent-consult-reply',
		filename: 'cross-agent-consult-reply.md',
		description:
			'The continuation Maestro sends once every consult has replied: the replies verbatim, then finish the answer',
		category: 'context',
	},
	{
		id: 'cross-agent-consult-first',
		filename: 'cross-agent-consult-first.md',
		description:
			'The turn Maestro sends after a consult the user asked to run FIRST: the replies verbatim, then the message to answer',
		category: 'context',
	},
	{
		id: 'cross-agent-handoff-pending',
		filename: 'cross-agent-handoff-pending.md',
		description:
			'Appended to a turn whose result the user asked to send to another agent: the final answer is forwarded when the turn ends',
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
		id: 'quick-chat-route',
		filename: 'quick-chat-route.md',
		description:
			'Quick Chat routing: picks which existing conversation a new message continues, or that it starts a new one',
		category: 'system',
		encoreFlag: 'quickChat',
	},
	{
		id: 'director-notes',
		filename: 'director-notes.md',
		description: "Director's Notes prompt",
		category: 'system',
		encoreFlag: 'directorNotes',
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
	// Includes - reusable blocks referenced from other prompts via {{INCLUDE:name}}.
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
		description: 'Full `maestro-cli` reference covering settings, agents, playbooks, and more',
		category: 'includes',
	},
	{
		id: '_maestro-cue',
		filename: '_maestro-cue.md',
		description:
			'Maestro Cue reference: event types, `maestro-cue.yaml` schema, pipeline topologies, and template variables',
		category: 'includes',
		encoreFlag: 'maestroCue',
	},
	{
		id: '_computer-history',
		filename: '_computer-history.md',
		description:
			'Computer History guide: CLI queries, event meanings, untrusted-content and privacy rules',
		category: 'includes',
		encoreFlag: 'computerHistory',
	},
	{
		id: '_maestro-run',
		filename: '_maestro-run.md',
		description:
			'MaestroRun guide: when to use the launcher, its commands and exit codes, and the approval rule',
		category: 'includes',
		encoreFlag: 'maestroRun',
	},
	{
		id: '_desktop-instrumentation',
		filename: '_desktop-instrumentation.md',
		description:
			'Desktop app instrumentation over CDP: CDP-accessible apps, finding a debug port, safety rules',
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
	{
		id: '_rich-chat-rendering',
		filename: '_rich-chat-rendering.md',
		description:
			'What the chat renderer draws (Mermaid, inline SVG, images, KaTeX, callouts) and what it strips',
		category: 'includes',
	},
	{
		id: '_wizard-rich-replies',
		filename: '_wizard-rich-replies.md',
		description: 'Tells a wizard to draw mockups and diagrams inside its JSON `message`',
		category: 'includes',
	},
];

/**
 * Prompt IDs as constants for type-safe usage.
 */
/**
 * Whether Settings -> Maestro Prompts lists a prompt: false only for one whose
 * Encore Feature is switched off. Unknown ids (plugin prompts) are available.
 */
export function isPromptAvailable(promptId: string, encoreFeatures: unknown): boolean {
	const flag = CORE_PROMPTS.find((def) => def.id === promptId)?.encoreFlag;
	return !flag || resolveEncoreFeatures(encoreFeatures)[flag];
}

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
	AUTORUN_GOAL: 'autorun-goal',
	AUTORUN_SYNOPSIS: 'autorun-synopsis',
	AUTORUN_PER_TASK: 'autorun-per-task',
	AUTORUN_PER_DOCUMENT: 'autorun-per-document',
	// Commands
	IMAGE_ONLY_DEFAULT: 'image-only-default',
	COMMIT_COMMAND: 'commit-command',
	AI_COMMAND: 'ai-command',
	// Per-agent prompt preambles
	COPILOT_PREAMBLE: 'copilot-preamble',
	// System
	MAESTRO_SYSTEM_PROMPT: 'maestro-system-prompt',
	// Pianola
	PIANOLA_SYSTEM: 'pianola-system',
	// Computer History
	COMPUTER_HISTORY_SYSTEM: 'computer-history-system',
	// Maestro Cue
	CUE_SYSTEM: 'cue-system',
	// MaestroRun
	MAESTRO_RUN_SYSTEM: 'maestro-run-system',
	// Concerto
	CONCERTO_SYSTEM: 'concerto-system',
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
	CROSS_AGENT_CONSULT_PENDING: 'cross-agent-consult-pending',
	CROSS_AGENT_CONSULT_REPLY: 'cross-agent-consult-reply',
	CROSS_AGENT_CONSULT_FIRST: 'cross-agent-consult-first',
	CROSS_AGENT_HANDOFF_PENDING: 'cross-agent-handoff-pending',
	// System
	TAB_NAMING: 'tab-naming',
	QUICK_CHAT_ROUTE: 'quick-chat-route',
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
	{ id: 'pianola-system', label: 'Pianola Manager System Prompt' },
	{ id: 'computer-history-system', label: 'Computer History System Prompt Section' },
	{ id: 'maestro-run-system', label: 'MaestroRun System Prompt Section' },
	{ id: 'autorun-default', label: 'Auto Run Default' },
	{ id: 'commit-command', label: 'Commit Command' },
	{ id: 'ai-command', label: 'AI Command Mode' },
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
