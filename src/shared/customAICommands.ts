/** Ordinary global slash commands; memory provenance never becomes persisted command state. */
export interface CustomAICommand {
	id: string;
	command: string;
	description: string;
	prompt: string;
	isBuiltIn?: boolean;
}

/** The global create form and host draft save share spelling, IDs and collision rules. */
export function createCustomAICommand(
	fields: Pick<CustomAICommand, 'command' | 'description' | 'prompt'>,
	commands: readonly CustomAICommand[]
): CustomAICommand | undefined {
	const command = fields.command.startsWith('/') ? fields.command : `/${fields.command}`;
	if (commands.some((entry) => entry.command === command)) return undefined;
	const slug = command
		.slice(1)
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '-');
	return {
		id: `custom-${slug}-${Date.now()}`,
		command,
		description: fields.description,
		prompt: fields.prompt,
		isBuiltIn: false,
	};
}
