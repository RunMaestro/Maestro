import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
	getSpeckitCommand,
	getSpeckitCommands,
	getSpeckitMetadata,
} from '../../../renderer/services/speckit';

const mockSpeckit = {
	getPrompts: vi.fn(),
	getMetadata: vi.fn(),
	getCommand: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();

	window.maestro = {
		...window.maestro,
		speckit: mockSpeckit,
	};

	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('speckit service', () => {
	describe('getSpeckitCommands', () => {
		test('returns commands when API succeeds', async () => {
			const commands = [
				{
					id: 'specify',
					command: '/speckit.specify',
					description: 'Create a specification',
					prompt: '# Specify',
					isCustom: false,
					isModified: false,
				},
			];

			mockSpeckit.getPrompts.mockResolvedValue({ success: true, commands });

			await expect(getSpeckitCommands()).resolves.toEqual(commands);
			expect(mockSpeckit.getPrompts).toHaveBeenCalledTimes(1);
		});

		test('returns empty array when API fails or omits commands', async () => {
			mockSpeckit.getPrompts.mockResolvedValueOnce({ success: false });
			await expect(getSpeckitCommands()).resolves.toEqual([]);

			mockSpeckit.getPrompts.mockResolvedValueOnce({ success: true });
			await expect(getSpeckitCommands()).resolves.toEqual([]);
		});

		test('returns empty array and logs when API throws', async () => {
			mockSpeckit.getPrompts.mockRejectedValue(new Error('IPC error'));

			await expect(getSpeckitCommands()).resolves.toEqual([]);
			expect(console.error).toHaveBeenCalledWith(
				'[SpecKit] Failed to get commands:',
				expect.any(Error)
			);
		});
	});

	describe('getSpeckitMetadata', () => {
		test('returns metadata when API succeeds', async () => {
			const metadata = {
				lastRefreshed: '2026-01-01T00:00:00Z',
				commitSha: 'abc1234',
				sourceVersion: '0.2.0',
				sourceUrl: 'https://github.com/github/spec-kit',
			};
			mockSpeckit.getMetadata.mockResolvedValue({ success: true, metadata });

			await expect(getSpeckitMetadata()).resolves.toEqual(metadata);
			expect(mockSpeckit.getMetadata).toHaveBeenCalledTimes(1);
		});

		test('returns null when API fails or omits metadata', async () => {
			mockSpeckit.getMetadata.mockResolvedValueOnce({ success: false });
			await expect(getSpeckitMetadata()).resolves.toBeNull();

			mockSpeckit.getMetadata.mockResolvedValueOnce({ success: true });
			await expect(getSpeckitMetadata()).resolves.toBeNull();
		});

		test('returns null and logs when API throws', async () => {
			mockSpeckit.getMetadata.mockRejectedValue(new Error('IPC error'));

			await expect(getSpeckitMetadata()).resolves.toBeNull();
			expect(console.error).toHaveBeenCalledWith(
				'[SpecKit] Failed to get metadata:',
				expect.any(Error)
			);
		});
	});

	describe('getSpeckitCommand', () => {
		test('returns command when API succeeds', async () => {
			const command = {
				id: 'plan',
				command: '/speckit.plan',
				description: 'Create an implementation plan',
				prompt: '# Plan',
				isCustom: false,
				isModified: false,
			};
			mockSpeckit.getCommand.mockResolvedValue({ success: true, command });

			await expect(getSpeckitCommand('/speckit.plan')).resolves.toEqual(command);
			expect(mockSpeckit.getCommand).toHaveBeenCalledWith('/speckit.plan');
		});

		test('returns null when API fails or omits command', async () => {
			mockSpeckit.getCommand.mockResolvedValueOnce({ success: false });
			await expect(getSpeckitCommand('/speckit.plan')).resolves.toBeNull();

			mockSpeckit.getCommand.mockResolvedValueOnce({ success: true });
			await expect(getSpeckitCommand('/speckit.plan')).resolves.toBeNull();
		});

		test('returns null and logs when API throws', async () => {
			mockSpeckit.getCommand.mockRejectedValue(new Error('IPC error'));

			await expect(getSpeckitCommand('/speckit.plan')).resolves.toBeNull();
			expect(console.error).toHaveBeenCalledWith(
				'[SpecKit] Failed to get command:',
				expect.any(Error)
			);
		});
	});
});
