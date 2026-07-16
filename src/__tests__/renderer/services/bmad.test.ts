/**
 * Tests for src/renderer/services/bmad.ts
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { getBmadCommands } from '../../../renderer/services/bmad';

const mockBmad = {
	getPrompts: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		...(window as any).maestro,
		bmad: mockBmad,
	};
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('bmad service', () => {
	test('returns commands when API succeeds', async () => {
		const commands = [
			{
				id: 'help',
				command: '/bmad-help',
				description: 'Get help',
				prompt: '# Help',
				isCustom: false,
				isModified: false,
			},
		];
		mockBmad.getPrompts.mockResolvedValue({ success: true, commands });

		const result = await getBmadCommands();

		expect(result).toEqual(commands);
	});

	test('returns an empty array when the command request fails', async () => {
		mockBmad.getPrompts.mockRejectedValue(new Error('IPC error'));

		await expect(getBmadCommands()).resolves.toEqual([]);
	});
});
