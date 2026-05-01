/**
 * Slash Command Registry — single source of truth for all slash commands.
 *
 * Each entry describes a command that can appear in the chat input autocomplete.
 * The `handler` field names the IPC channel (or built-in action) that executes
 * when the user submits the command.
 *
 * Conventions
 * -----------
 * - `surfaces`   : where the command is shown ('desktop' | 'web')
 * - `encoreFlag` : if set, the command is hidden when that encore feature is disabled
 * - `aiOnly`     : true → only shown in AI input mode
 * - `handler`    : 'builtin:<name>' for renderer-intercepted commands,
 *                  'ipc:<channel>' for commands dispatched to the main process
 */

export type SlashCommandSurface = 'desktop' | 'web';

export type SlashCommandHandler =
	| `builtin:${string}` // handled in renderer (useInputProcessing)
	| `ipc:${string}`; // handled by ipcMain channel

export interface SlashCommandDefinition {
	/** Full command text including leading slash, e.g. "/PM prd-new" */
	verb: string;
	/** Short description shown in the autocomplete list */
	description: string;
	/** Optional argument hint shown after the verb in the autocomplete, e.g. "<name>" */
	args?: string;
	/** Which surfaces expose this command */
	surfaces: SlashCommandSurface[];
	/** If set, command is hidden when this encore feature flag is disabled */
	encoreFlag?: string;
	/** Only show in AI mode (not terminal mode) */
	aiOnly?: boolean;
	/** How the command is executed */
	handler: SlashCommandHandler;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * All slash commands known to Maestro.
 *
 * Built-in commands (handler: 'builtin:*') are intercepted in useInputProcessing
 * before any IPC is involved.  IPC commands (handler: 'ipc:*') are forwarded to
 * the main process via the pm namespace (or the relevant namespace).
 *
 * Ordering: built-ins first, then /PM namespace, then reserved slots.
 */
export const SLASH_COMMAND_REGISTRY: SlashCommandDefinition[] = [
	// -------------------------------------------------------------------------
	// Built-in Maestro commands (renderer-handled)
	// -------------------------------------------------------------------------
	{
		verb: '/history',
		description: 'Generate a synopsis of recent work and add to history',
		surfaces: ['desktop', 'web'],
		aiOnly: true,
		handler: 'builtin:history',
	},
	{
		verb: '/wizard',
		description: 'Start the planning wizard for Auto Run documents',
		args: '[seed text]',
		surfaces: ['desktop', 'web'],
		aiOnly: true,
		handler: 'builtin:wizard',
	},
	{
		verb: '/skills',
		description: 'List available Claude Code skills for this project',
		surfaces: ['desktop'],
		aiOnly: true,
		handler: 'builtin:skills',
	},

	// -------------------------------------------------------------------------
	// /PM namespace — project management suite
	// Gated by the `conversationalPrd` encore feature (shares gate with Conv-PRD).
	// -------------------------------------------------------------------------
	{
		verb: '/PM',
		description: 'Start a new feature end-to-end: Conv-PRD → Epic → Tasks → GitHub',
		args: '<idea>',
		surfaces: ['desktop'],
		aiOnly: true,
		encoreFlag: 'pmSuite',
		handler: 'ipc:pm:orchestrate',
	},
	{
		verb: '/PM prd-new',
		description: 'Open the Conversational PRD planner seeded with a name',
		args: '<name>',
		surfaces: ['desktop'],
		aiOnly: true,
		encoreFlag: 'pmSuite',
		handler: 'ipc:pm:prd-new',
	},
	{
		verb: '/PM prd-list',
		description: 'List all PRDs for the current project',
		surfaces: ['desktop'],
		aiOnly: true,
		encoreFlag: 'pmSuite',
		handler: 'ipc:pm:prd-list',
	},
	{
		verb: '/PM next',
		description: 'Show the next eligible work item ready for implementation',
		surfaces: ['desktop'],
		aiOnly: true,
		encoreFlag: 'pmSuite',
		handler: 'ipc:pm:next',
	},
	{
		verb: '/PM status',
		description: 'Show a current project board snapshot',
		surfaces: ['desktop'],
		aiOnly: true,
		encoreFlag: 'pmSuite',
		handler: 'ipc:pm:status',
	},
	{
		verb: '/PM standup',
		description: 'Generate a standup summary for the current project',
		surfaces: ['desktop'],
		aiOnly: true,
		encoreFlag: 'pmSuite',
		handler: 'ipc:pm:standup',
	},
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return commands that should be visible on a given surface.
 */
export function getCommandsForSurface(surface: SlashCommandSurface): SlashCommandDefinition[] {
	return SLASH_COMMAND_REGISTRY.filter((cmd) => cmd.surfaces.includes(surface));
}

/**
 * Return commands that should be visible given the active encore feature flags.
 * Pass an empty object `{}` to include all commands regardless of flags.
 */
export function getVisibleSlashCommands(
	encoreFeatures: Record<string, boolean>
): SlashCommandDefinition[] {
	return SLASH_COMMAND_REGISTRY.filter((cmd) => {
		if (!cmd.encoreFlag) return true;
		return Boolean(encoreFeatures[cmd.encoreFlag]);
	});
}

/**
 * Look up a command definition by its exact verb string.
 */
export function findSlashCommand(verb: string): SlashCommandDefinition | undefined {
	return SLASH_COMMAND_REGISTRY.find((cmd) => cmd.verb === verb);
}
