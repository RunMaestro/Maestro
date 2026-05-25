import { describe, expect, it } from 'vitest';
import { slashCommands } from '../../renderer/slashCommands';

describe('slashCommands', () => {
	it('registers built-in Maestro slash commands with their visibility rules', () => {
		expect(slashCommands).toEqual([
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
		]);
	});
});
