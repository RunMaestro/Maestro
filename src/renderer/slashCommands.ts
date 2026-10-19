// Slash commands - both built-in Maestro commands and custom AI commands
// Built-in commands are intercepted by Maestro before being sent to the agent

import type { ToolType } from './types';

export interface SlashCommand {
	command: string;
	description: string;
	terminalOnly?: boolean; // Only show this command in terminal mode
	aiOnly?: boolean; // Only show this command in AI mode
	agentTypes?: ToolType[]; // Only show for specific agent types (if undefined, show for all)
}

// Built-in Maestro slash commands
// These are intercepted by Maestro and handled specially (not passed to the agent)
export const slashCommands: SlashCommand[] = [
	{
		command: '/history',
		description: 'Generate a synopsis of recent work and add to history',
		aiOnly: true,
	},
	{
		command: '/wizard',
		description: 'Start the planning wizard for Auto Run documents',
		aiOnly: true,
	},
	{
		command: '/skills',
		description: 'List available Claude Code skills for this project',
		aiOnly: true,
		agentTypes: ['claude-code'],
	},
];

/** A command the composer's `/` picker offers. */
export interface SlashCommandOption {
	command: string;
	description: string;
	terminalOnly?: boolean;
	aiOnly?: boolean;
	prompt?: string;
}

/** A user-defined or bundled command that sends its prompt. */
interface PromptCommandSource {
	command: string;
	description: string;
	prompt?: string;
}

/**
 * Everything the composer's `/` picker offers, in picker order: the built-ins
 * for this agent type, the user's custom AI commands, the bundled methodology
 * commands (Spec Kit, OpenSpec, BMAD), then the agent's own commands. Pass
 * `agentCommands` only when the agent supports slash commands. A tab window
 * leaves out the built-ins that run on the app window's active tab
 * (`excludeBuiltIns`).
 */
export function buildSlashCommandList(sources: {
	toolType?: ToolType;
	customAICommands: PromptCommandSource[];
	speckitCommands?: PromptCommandSource[];
	openspecCommands?: PromptCommandSource[];
	bmadCommands?: PromptCommandSource[];
	agentCommands?: Array<{ command: string; description: string }>;
	excludeBuiltIns?: readonly string[];
}): SlashCommandOption[] {
	const asAiCommand = (cmd: PromptCommandSource): SlashCommandOption => ({
		command: cmd.command,
		description: cmd.description,
		aiOnly: true,
		prompt: cmd.prompt,
	});
	// Filter built-in slash commands by agent type (if specified)
	const builtIns = slashCommands.filter(
		(cmd) =>
			(!cmd.agentTypes || (sources.toolType && cmd.agentTypes.includes(sources.toolType))) &&
			!sources.excludeBuiltIns?.includes(cmd.command)
	);
	return [
		...builtIns,
		...sources.customAICommands.map(asAiCommand),
		...(sources.speckitCommands ?? []).map(asAiCommand),
		...(sources.openspecCommands ?? []).map(asAiCommand),
		...(sources.bmadCommands ?? []).map(asAiCommand),
		// Agent commands are only available in AI mode
		...(sources.agentCommands ?? []).map((cmd) => ({
			command: cmd.command,
			description: cmd.description,
			aiOnly: true,
		})),
	];
}
