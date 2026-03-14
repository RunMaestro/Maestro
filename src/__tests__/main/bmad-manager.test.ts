/**
 * Tests for the BMAD Manager
 *
 * Tests the core functionality for managing bundled BMAD prompts including:
 * - Loading bundled prompts from disk
 * - User customization persistence
 * - Resetting to defaults
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn().mockReturnValue('/mock/userData'),
		isPackaged: false,
	},
}));

vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import {
	getBmadMetadata,
	getBmadPrompts,
	saveBmadPrompt,
	resetBmadPrompt,
	getBmadCommand,
	getBmadCommandBySlash,
	type BmadMetadata,
} from '../../main/bmad-manager';

describe('bmad-manager', () => {
	const mockBundledPrompt = '# Test Prompt\n\nThis is a test prompt.';
	const mockMetadata: BmadMetadata = {
		lastRefreshed: '2026-03-14T00:00:00Z',
		commitSha: 'ac769b2',
		sourceVersion: '6.1.0',
		sourceUrl: 'https://github.com/bmad-code-org/BMAD-METHOD',
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('getBmadMetadata', () => {
		it('should return bundled metadata when no customizations exist', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('bmad-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});

			const metadata = await getBmadMetadata();
			expect(metadata).toEqual(mockMetadata);
		});
	});

	describe('getBmadPrompts', () => {
		it('should return bundled commands', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('bmad-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('bmad-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				if (pathStr.endsWith('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});

			const commands = await getBmadPrompts();

			expect(commands.length).toBeGreaterThan(20);
			expect(commands.some((cmd) => cmd.command === '/bmad-help')).toBe(true);
			expect(commands.some((cmd) => cmd.command === '/bmad-bmm-create-prd')).toBe(true);
			expect(commands.some((cmd) => cmd.command === '/bmad-bmm-quick-spec')).toBe(true);
			expect(commands.every((cmd) => cmd.command.startsWith('/bmad'))).toBe(true);
		});
	});

	describe('saveBmadPrompt', () => {
		it('should persist a customized prompt', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('bmad-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});

			await saveBmadPrompt('help', '# Custom Help');

			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('bmad-customizations.json'),
				expect.stringContaining('# Custom Help'),
				'utf-8'
			);
		});
	});

	describe('resetBmadPrompt', () => {
		it('should reset a customized prompt to the bundled default', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('bmad-customizations.json')) {
					return JSON.stringify({
						metadata: mockMetadata,
						prompts: {
							help: {
								content: '# Customized Help',
								isModified: true,
							},
						},
					});
				}
				if (pathStr.includes('bmad-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				if (pathStr.endsWith('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});

			const prompt = await resetBmadPrompt('help');

			expect(prompt).toBe(mockBundledPrompt);
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('bmad-customizations.json'),
				expect.not.stringContaining('# Customized Help'),
				'utf-8'
			);
		});

		it('should throw for an unknown command', async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

			await expect(resetBmadPrompt('missing')).rejects.toThrow('Unknown BMAD command');
		});
	});

	describe('command lookup helpers', () => {
		it('should find a command by slash command', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('bmad-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('bmad-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				if (pathStr.endsWith('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});

			const byId = await getBmadCommand('help');
			const bySlash = await getBmadCommandBySlash('/bmad-help');

			expect(byId?.command).toBe('/bmad-help');
			expect(bySlash?.id).toBe('help');
		});
	});
});
