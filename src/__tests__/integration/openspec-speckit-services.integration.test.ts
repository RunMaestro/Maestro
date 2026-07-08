import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getOpenSpecCommand,
	getOpenSpecCommands,
	getOpenSpecMetadata,
} from '../../renderer/services/openspec';
import {
	getSpeckitCommand,
	getSpeckitCommands,
	getSpeckitMetadata,
} from '../../renderer/services/speckit';
import { logger } from '../../renderer/utils/logger';

const openspecBridge = {
	getPrompts: vi.fn(),
	getMetadata: vi.fn(),
	getCommand: vi.fn(),
};

const speckitBridge = {
	getPrompts: vi.fn(),
	getMetadata: vi.fn(),
	getCommand: vi.fn(),
};

describe('renderer OpenSpec and SpecKit services integration', () => {
	let loggerError: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		window.maestro = {
			...window.maestro,
			openspec: openspecBridge,
			speckit: speckitBridge,
		};
	});

	afterEach(() => {
		loggerError.mockRestore();
	});

	it('returns OpenSpec bridge data and safe fallbacks for missing or rejected payloads', async () => {
		const command = {
			id: 'proposal',
			command: '/openspec.proposal',
			description: 'Create a proposal',
			prompt: '# Proposal',
			isCustom: false,
			isModified: false,
		};
		const metadata = {
			lastRefreshed: '2026-05-27T00:00:00Z',
			commitSha: 'abc123',
			sourceVersion: '1.0.0',
			sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
		};

		openspecBridge.getPrompts
			.mockResolvedValueOnce({ success: true, commands: [command] })
			.mockResolvedValueOnce({ success: true })
			.mockRejectedValueOnce(new Error('prompts failed'));
		openspecBridge.getMetadata
			.mockResolvedValueOnce({ success: true, metadata })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error('metadata failed'));
		openspecBridge.getCommand
			.mockResolvedValueOnce({ success: true, command })
			.mockResolvedValueOnce({ success: true })
			.mockRejectedValueOnce(new Error('command failed'));

		await expect(getOpenSpecCommands()).resolves.toEqual([command]);
		await expect(getOpenSpecCommands()).resolves.toEqual([]);
		await expect(getOpenSpecCommands()).resolves.toEqual([]);
		await expect(getOpenSpecMetadata()).resolves.toEqual(metadata);
		await expect(getOpenSpecMetadata()).resolves.toBeNull();
		await expect(getOpenSpecMetadata()).resolves.toBeNull();
		await expect(getOpenSpecCommand('/openspec.proposal')).resolves.toEqual(command);
		await expect(getOpenSpecCommand('/openspec.missing')).resolves.toBeNull();
		await expect(getOpenSpecCommand('/openspec.error')).resolves.toBeNull();

		expect(openspecBridge.getCommand).toHaveBeenCalledWith('/openspec.proposal');
		expect(loggerError).toHaveBeenCalledWith(
			'[OpenSpec] Failed to get commands:',
			undefined,
			expect.any(Error)
		);
		expect(loggerError).toHaveBeenCalledWith(
			'[OpenSpec] Failed to get metadata:',
			undefined,
			expect.any(Error)
		);
		expect(loggerError).toHaveBeenCalledWith(
			'[OpenSpec] Failed to get command:',
			undefined,
			expect.any(Error)
		);
	});

	it('returns SpecKit bridge data and safe fallbacks for missing or rejected payloads', async () => {
		const command = {
			id: 'plan',
			command: '/speckit.plan',
			description: 'Create a plan',
			prompt: '# Plan',
			isCustom: false,
			isModified: false,
		};
		const metadata = {
			lastRefreshed: '2026-05-27T00:00:00Z',
			commitSha: 'def456',
			sourceVersion: '2.0.0',
			sourceUrl: 'https://github.com/github/spec-kit',
		};

		speckitBridge.getPrompts
			.mockResolvedValueOnce({ success: true, commands: [command] })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error('prompts failed'));
		speckitBridge.getMetadata
			.mockResolvedValueOnce({ success: true, metadata })
			.mockResolvedValueOnce({ success: true })
			.mockRejectedValueOnce(new Error('metadata failed'));
		speckitBridge.getCommand
			.mockResolvedValueOnce({ success: true, command })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error('command failed'));

		await expect(getSpeckitCommands()).resolves.toEqual([command]);
		await expect(getSpeckitCommands()).resolves.toEqual([]);
		await expect(getSpeckitCommands()).resolves.toEqual([]);
		await expect(getSpeckitMetadata()).resolves.toEqual(metadata);
		await expect(getSpeckitMetadata()).resolves.toBeNull();
		await expect(getSpeckitMetadata()).resolves.toBeNull();
		await expect(getSpeckitCommand('/speckit.plan')).resolves.toEqual(command);
		await expect(getSpeckitCommand('/speckit.missing')).resolves.toBeNull();
		await expect(getSpeckitCommand('/speckit.error')).resolves.toBeNull();

		expect(speckitBridge.getCommand).toHaveBeenCalledWith('/speckit.plan');
		expect(loggerError).toHaveBeenCalledWith(
			'[SpecKit] Failed to get commands:',
			undefined,
			expect.any(Error)
		);
		expect(loggerError).toHaveBeenCalledWith(
			'[SpecKit] Failed to get metadata:',
			undefined,
			expect.any(Error)
		);
		expect(loggerError).toHaveBeenCalledWith(
			'[SpecKit] Failed to get command:',
			undefined,
			expect.any(Error)
		);
	});
});
