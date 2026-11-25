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
		command: '/btw',
		description:
			'Ask a side question about this conversation without adding to it (runs even while busy)',
		aiOnly: true,
		agentTypes: ['claude-code'],
	},
	{
		command: '/skills',
		description: 'List available Claude Code skills for this project',
		aiOnly: true,
		agentTypes: ['claude-code'],
	},
];
