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

/** Apply the same defaults and legacy cleanup at desktop and host save boundaries. */
export function mergeCustomAICommands(
	saved: unknown,
	commitPrompt: string,
	onMalformed?: () => void
): CustomAICommand[] {
	const commands = new Map<string, CustomAICommand>([
		[
			'commit',
			{
				id: 'commit',
				command: '/commit',
				description: 'Commit outstanding changes and push up',
				prompt: commitPrompt,
				isBuiltIn: true,
			},
		],
	]);
	if (Array.isArray(saved))
		for (const value of saved) {
			if (
				!value ||
				typeof value !== 'object' ||
				typeof value.id !== 'string' ||
				!value.id ||
				typeof value.command !== 'string' ||
				typeof value.prompt !== 'string'
			) {
				onMalformed?.();
				continue;
			}
			if (value.command === '/synopsis' || value.id === 'synopsis') continue;
			const command = {
				...value,
				description: typeof value.description === 'string' ? value.description : '',
			};
			const existing = commands.get(command.id);
			commands.set(command.id, existing ? { ...command, isBuiltIn: existing.isBuiltIn } : command);
		}
	return Array.from(commands.values());
}
