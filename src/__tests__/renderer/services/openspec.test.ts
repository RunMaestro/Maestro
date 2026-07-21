/**
 * Tests for src/renderer/services/openspec.ts
 * OpenSpec service that wraps IPC calls to main process
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { logger } from '../../../renderer/utils/logger';
import { getOpenSpecCommands } from '../../../renderer/services/openspec';

// Mock the window.maestro.openspec object
const mockOpenspec = {
	getPrompts: vi.fn(),
};

// Setup mock before each test
beforeEach(() => {
	vi.clearAllMocks();

	// Ensure window.maestro.openspec is mocked
	(window as any).maestro = {
		...(window as any).maestro,
		openspec: mockOpenspec,
	};

	// Mock console.error to prevent noise in test output
	vi.spyOn(logger, 'error').mockImplementation(() => {});
});

describe('openspec service', () => {
	describe('getOpenSpecCommands', () => {
		test('returns commands when API succeeds', async () => {
			const mockCommands = [
				{
					id: 'proposal',
					command: '/openspec.proposal',
					description: 'Create a change proposal',
					prompt: '# Proposal',
					isCustom: false,
					isModified: false,
				},
				{
					id: 'help',
					command: '/openspec.help',
					description: 'Get help',
					prompt: '# Help',
					isCustom: true,
					isModified: false,
				},
			];

			mockOpenspec.getPrompts.mockResolvedValue({
				success: true,
				commands: mockCommands,
			});

			const result = await getOpenSpecCommands();

			expect(result).toEqual(mockCommands);
			expect(mockOpenspec.getPrompts).toHaveBeenCalled();
		});

		test('returns empty array when API returns success false', async () => {
			mockOpenspec.getPrompts.mockResolvedValue({
				success: false,
				error: 'Something went wrong',
			});

			const result = await getOpenSpecCommands();

			expect(result).toEqual([]);
		});

		test('returns empty array when API throws', async () => {
			mockOpenspec.getPrompts.mockRejectedValue(new Error('IPC error'));

			const result = await getOpenSpecCommands();

			expect(result).toEqual([]);
			expect(logger.error).toHaveBeenCalledWith(
				'[OpenSpec] Failed to get commands:',
				undefined,
				expect.any(Error)
			);
		});

		test('returns empty array when commands is undefined', async () => {
			mockOpenspec.getPrompts.mockResolvedValue({
				success: true,
				commands: undefined,
			});

			const result = await getOpenSpecCommands();

			expect(result).toEqual([]);
		});
	});
});
