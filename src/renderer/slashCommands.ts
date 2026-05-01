// Slash commands - both built-in Maestro commands and custom AI commands
// Built-in commands are intercepted by Maestro before being sent to the agent

import type { ToolType } from './types';
import { getCommandsForSurface } from '../shared/slashCommands';

export interface SlashCommand {
	command: string;
	description: string;
	terminalOnly?: boolean; // Only show this command in terminal mode
	aiOnly?: boolean; // Only show this command in AI mode
	agentTypes?: ToolType[]; // Only show for specific agent types (if undefined, show for all)
}

// Built-in Maestro slash commands - filtered to desktop surface only
// These are intercepted by Maestro and handled specially (not passed to the agent)
export const slashCommands: SlashCommand[] = getCommandsForSurface('desktop').map((def) => ({
	command: def.verb,
	description: def.description,
	aiOnly: def.aiOnly,
}));
