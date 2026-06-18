/**
 * Tests for src/renderer/services/bmad.ts
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { getBmadCommands, getBmadMetadata, getBmadCommand } from '../../../renderer/services/bmad';

const mockBmad = {
	getPrompts: vi.fn(),
	getMetadata: vi.fn(),
	getCommand: vi.fn(),
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

	test('returns metadata when API succeeds', async () => {
		const metadata = {
			lastRefreshed: '2026-03-14T00:00:00Z',
			commitSha: 'ac769b2',
			sourceVersion: '6.1.0',
			sourceUrl: 'https://github.com/bmad-code-org/BMAD-METHOD',
		};
		mockBmad.getMetadata.mockResolvedValue({ success: true, metadata });

		const result = await getBmadMetadata();

		expect(result).toEqual(metadata);
	});

	test('returns a command when API succeeds', async () => {
		const command = {
			id: 'help',
			command: '/bmad-help',
			description: 'Get help',
			prompt: '# Help',
			isCustom: false,
			isModified: false,
		};
		mockBmad.getCommand.mockResolvedValue({ success: true, command });

		const result = await getBmadCommand('/bmad-help');

		expect(result).toEqual(command);
		expect(mockBmad.getCommand).toHaveBeenCalledWith('/bmad-help');
	});

	test('returns empty/null fallbacks on failures', async () => {
		mockBmad.getPrompts.mockRejectedValue(new Error('IPC error'));
		mockBmad.getMetadata.mockResolvedValue({ success: false });
		mockBmad.getCommand.mockResolvedValue({ success: true, command: null });

		await expect(getBmadCommands()).resolves.toEqual([]);
		await expect(getBmadMetadata()).resolves.toBeNull();
		await expect(getBmadCommand('/bmad-help')).resolves.toBeNull();
	});
});
