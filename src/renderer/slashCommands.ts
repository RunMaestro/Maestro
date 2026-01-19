// Slash commands - both built-in Maestro commands and custom AI commands
// Built-in commands are intercepted by Maestro before being sent to the agent

export interface SlashCommand {
	command: string;
	description: string;
	terminalOnly?: boolean; // Only show this command in terminal mode
	aiOnly?: boolean; // Only show this command in AI mode
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
];
