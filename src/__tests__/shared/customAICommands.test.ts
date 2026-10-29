import { describe, expect, it, vi } from 'vitest';
import { createCustomAICommand, mergeCustomAICommands } from '../../shared/customAICommands';

describe('global command defaults at host and renderer boundaries', () => {
	it('retains the built-in on first save and refuses a colliding draft', () => {
		const current = mergeCustomAICommands(undefined, 'effective commit prompt');
		expect(current).toEqual([
			{
				id: 'commit',
				command: '/commit',
				description: 'Commit outstanding changes and push up',
				prompt: 'effective commit prompt',
				isBuiltIn: true,
			},
		]);
		expect(
			createCustomAICommand({ command: 'commit', description: 'Draft', prompt: 'Draft' }, current)
		).toBeUndefined();
		const created = createCustomAICommand(
			{ command: 'new', description: 'New', prompt: 'New' },
			current
		)!;
		expect(mergeCustomAICommands([...current, created], 'effective commit prompt')).toEqual([
			...current,
			created,
		]);
	});
	it('shares legacy cleanup and preserves edited built-in fields and protection', () => {
		const malformed = vi.fn();
		expect(
			mergeCustomAICommands(
				[
					null,
					{ command: '/broken', prompt: 'broken' },
					{ id: 'synopsis', command: '/synopsis', prompt: 'legacy' },
					{ id: 'commit', command: '/commit', prompt: 'Edited', isBuiltIn: false },
					{ id: 'custom', command: '/custom', prompt: 'Custom' },
				],
				'Default',
				malformed
			)
		).toEqual([
			{ id: 'commit', command: '/commit', prompt: 'Edited', description: '', isBuiltIn: true },
			{ id: 'custom', command: '/custom', prompt: 'Custom', description: '' },
		]);
		expect(malformed).toHaveBeenCalledTimes(2);
	});
});
