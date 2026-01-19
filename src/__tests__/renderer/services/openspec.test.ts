/**
 * Tests for src/renderer/services/openspec.ts
 * OpenSpec service that wraps IPC calls to main process
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
	getOpenSpecCommands,
	getOpenSpecMetadata,
	getOpenSpecCommand,
} from '../../../renderer/services/openspec';

// Mock the window.maestro.openspec object
const mockOpenspec = {
	getPrompts: vi.fn(),
	getMetadata: vi.fn(),
	getCommand: vi.fn(),
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
	vi.spyOn(console, 'error').mockImplementation(() => {});
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
			expect(console.error).toHaveBeenCalledWith(
				'[OpenSpec] Failed to get commands:',
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

	describe('getOpenSpecMetadata', () => {
		test('returns metadata when API succeeds', async () => {
			const mockMetadata = {
				lastRefreshed: '2025-01-01T00:00:00Z',
				commitSha: 'abc1234',
				sourceVersion: '0.1.0',
				sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
			};

			mockOpenspec.getMetadata.mockResolvedValue({
				success: true,
				metadata: mockMetadata,
			});

			const result = await getOpenSpecMetadata();

			expect(result).toEqual(mockMetadata);
			expect(mockOpenspec.getMetadata).toHaveBeenCalled();
		});

		test('returns null when API returns success false', async () => {
			mockOpenspec.getMetadata.mockResolvedValue({
				success: false,
				error: 'Something went wrong',
			});

			const result = await getOpenSpecMetadata();

			expect(result).toBeNull();
		});

		test('returns null when API throws', async () => {
			mockOpenspec.getMetadata.mockRejectedValue(new Error('IPC error'));

			const result = await getOpenSpecMetadata();

			expect(result).toBeNull();
			expect(console.error).toHaveBeenCalledWith(
				'[OpenSpec] Failed to get metadata:',
				expect.any(Error)
			);
		});

		test('returns null when metadata is undefined', async () => {
			mockOpenspec.getMetadata.mockResolvedValue({
				success: true,
				metadata: undefined,
			});

			const result = await getOpenSpecMetadata();

			expect(result).toBeNull();
		});
	});

	describe('getOpenSpecCommand', () => {
		test('returns command when API succeeds', async () => {
			const mockCommand = {
				id: 'proposal',
				command: '/openspec.proposal',
				description: 'Create a change proposal',
				prompt: '# Proposal',
				isCustom: false,
				isModified: false,
			};

			mockOpenspec.getCommand.mockResolvedValue({
				success: true,
				command: mockCommand,
			});

			const result = await getOpenSpecCommand('/openspec.proposal');

			expect(result).toEqual(mockCommand);
			expect(mockOpenspec.getCommand).toHaveBeenCalledWith('/openspec.proposal');
		});

		test('returns null when command not found', async () => {
			mockOpenspec.getCommand.mockResolvedValue({
				success: true,
				command: null,
			});

			const result = await getOpenSpecCommand('/openspec.nonexistent');

			expect(result).toBeNull();
		});

		test('returns null when API returns success false', async () => {
			mockOpenspec.getCommand.mockResolvedValue({
				success: false,
				error: 'Something went wrong',
			});

			const result = await getOpenSpecCommand('/openspec.proposal');

			expect(result).toBeNull();
		});

		test('returns null when API throws', async () => {
			mockOpenspec.getCommand.mockRejectedValue(new Error('IPC error'));

			const result = await getOpenSpecCommand('/openspec.proposal');

			expect(result).toBeNull();
			expect(console.error).toHaveBeenCalledWith(
				'[OpenSpec] Failed to get command:',
				expect.any(Error)
			);
		});

		test('returns null when command is undefined', async () => {
			mockOpenspec.getCommand.mockResolvedValue({
				success: true,
				command: undefined,
			});

			const result = await getOpenSpecCommand('/openspec.proposal');

			expect(result).toBeNull();
		});
	});
});
