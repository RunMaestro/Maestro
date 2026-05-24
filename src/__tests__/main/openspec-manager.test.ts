/**
 * Tests for the OpenSpec Manager
 *
 * Tests the core functionality for managing bundled OpenSpec prompts including:
 * - Loading bundled prompts from disk
 * - User customization persistence
 * - Resetting to defaults
 * - Parsing AGENTS.md for upstream command extraction
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import { logger } from '../../main/utils/logger';

// Mock electron app module
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn().mockReturnValue('/mock/userData'),
		isPackaged: false,
	},
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
	},
}));

// Mock the logger
vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Import the module after mocks are set up
import {
	getOpenSpecMetadata,
	getOpenSpecPrompts,
	saveOpenSpecPrompt,
	resetOpenSpecPrompt,
	refreshOpenSpecPrompts,
	getOpenSpecCommand,
	getOpenSpecCommandBySlash,
	OpenSpecCommand,
	OpenSpecMetadata,
} from '../../main/openspec-manager';

describe('openspec-manager', () => {
	const mockBundledPrompt = '# Test Prompt\n\nThis is a test prompt.';
	const mockMetadata: OpenSpecMetadata = {
		lastRefreshed: '2025-01-01T00:00:00Z',
		commitSha: 'abc1234',
		sourceVersion: '0.1.0',
		sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		(app as typeof app & { isPackaged: boolean }).isPackaged = false;
		delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	describe('getOpenSpecMetadata', () => {
		it('should return bundled metadata when no customizations exist', async () => {
			// No user customizations file
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});

			const metadata = await getOpenSpecMetadata();

			expect(metadata).toEqual(mockMetadata);
		});

		it('should fall back to bundled metadata when downloaded metadata is missing', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('openspec-prompts') && pathStr.includes('metadata.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});

			const metadata = await getOpenSpecMetadata();

			expect(metadata).toEqual(mockMetadata);
		});

		it('should return customized metadata when available', async () => {
			const customMetadata: OpenSpecMetadata = {
				lastRefreshed: '2025-06-15T12:00:00Z',
				commitSha: 'def5678',
				sourceVersion: '0.2.0',
				sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
			};

			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					return JSON.stringify({
						metadata: customMetadata,
						prompts: {},
					});
				}
				throw new Error('ENOENT');
			});

			const metadata = await getOpenSpecMetadata();

			expect(metadata).toEqual(customMetadata);
		});

		it('should return default metadata when no files exist', async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

			const metadata = await getOpenSpecMetadata();

			expect(metadata.sourceUrl).toBe('https://github.com/Fission-AI/OpenSpec');
			// Check structure rather than specific version (which changes with releases)
			expect(metadata.sourceVersion).toMatch(/^\d+\.\d+\.\d+$/);
			expect(metadata.commitSha).toBeDefined();
			expect(metadata.lastRefreshed).toBeDefined();
		});
	});

	describe('getOpenSpecPrompts', () => {
		it('should return all bundled commands', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('openspec-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const commands = await getOpenSpecPrompts();

			expect(commands.length).toBeGreaterThan(0);
			expect(commands.some((cmd) => cmd.command === '/openspec.help')).toBe(true);
			expect(commands.some((cmd) => cmd.command === '/openspec.proposal')).toBe(true);
			expect(commands.some((cmd) => cmd.command === '/openspec.apply')).toBe(true);
			expect(commands.some((cmd) => cmd.command === '/openspec.archive')).toBe(true);
			expect(commands.some((cmd) => cmd.command === '/openspec.implement')).toBe(true);
		});

		it('should return commands with correct structure', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('openspec-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const commands = await getOpenSpecPrompts();

			for (const cmd of commands) {
				expect(cmd).toHaveProperty('id');
				expect(cmd).toHaveProperty('command');
				expect(cmd).toHaveProperty('description');
				expect(cmd).toHaveProperty('prompt');
				expect(cmd).toHaveProperty('isCustom');
				expect(cmd).toHaveProperty('isModified');
				expect(cmd.command.startsWith('/openspec.')).toBe(true);
			}
		});

		it('should mark custom commands correctly', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('openspec-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const commands = await getOpenSpecPrompts();

			const helpCmd = commands.find((cmd) => cmd.id === 'help');
			const implementCmd = commands.find((cmd) => cmd.id === 'implement');
			const proposalCmd = commands.find((cmd) => cmd.id === 'proposal');

			expect(helpCmd?.isCustom).toBe(true);
			expect(implementCmd?.isCustom).toBe(true);
			expect(proposalCmd?.isCustom).toBe(false);
		});

		it('should use customized prompt when available', async () => {
			const customContent = '# Custom Proposal\n\nThis is my custom prompt.';

			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					return JSON.stringify({
						metadata: mockMetadata,
						prompts: {
							proposal: {
								content: customContent,
								isModified: true,
								modifiedAt: '2025-06-15T12:00:00Z',
							},
						},
					});
				}
				if (pathStr.includes('openspec-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const commands = await getOpenSpecPrompts();
			const proposalCmd = commands.find((cmd) => cmd.id === 'proposal');

			expect(proposalCmd?.prompt).toBe(customContent);
			expect(proposalCmd?.isModified).toBe(true);
		});
	});

	describe('saveOpenSpecPrompt', () => {
		it('should save customization to disk', async () => {
			const customContent = '# My Custom Prompt';

			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await saveOpenSpecPrompt('proposal', customContent);

			expect(fs.writeFile).toHaveBeenCalled();
			const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
			const writtenContent = JSON.parse(writeCall[1] as string);

			expect(writtenContent.prompts.proposal.content).toBe(customContent);
			expect(writtenContent.prompts.proposal.isModified).toBe(true);
			expect(writtenContent.prompts.proposal.modifiedAt).toBeDefined();
		});

		it('should preserve existing customizations', async () => {
			const existingCustomizations = {
				metadata: mockMetadata,
				prompts: {
					apply: {
						content: '# Existing Apply',
						isModified: true,
						modifiedAt: '2025-01-01T00:00:00Z',
					},
				},
			};

			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					return JSON.stringify(existingCustomizations);
				}
				throw new Error('ENOENT');
			});
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await saveOpenSpecPrompt('proposal', '# New Proposal');

			const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
			const writtenContent = JSON.parse(writeCall[1] as string);

			expect(writtenContent.prompts.apply.content).toBe('# Existing Apply');
			expect(writtenContent.prompts.proposal.content).toBe('# New Proposal');
		});
	});

	describe('resetOpenSpecPrompt', () => {
		it('should reset prompt to bundled default', async () => {
			const customizations = {
				metadata: mockMetadata,
				prompts: {
					proposal: {
						content: '# Custom',
						isModified: true,
					},
				},
			};

			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					return JSON.stringify(customizations);
				}
				if (pathStr.includes('openspec-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const result = await resetOpenSpecPrompt('proposal');

			expect(result).toBe(mockBundledPrompt);
			expect(fs.writeFile).toHaveBeenCalled();

			const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
			const writtenContent = JSON.parse(writeCall[1] as string);
			expect(writtenContent.prompts.proposal).toBeUndefined();
		});

		it('should throw for unknown command', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('openspec-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					throw new Error('ENOENT');
				}
				throw new Error('ENOENT');
			});

			await expect(resetOpenSpecPrompt('nonexistent')).rejects.toThrow('Unknown openspec command');
		});

		it('should return bundled default without writing when no customization exists', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					return JSON.stringify({
						metadata: mockMetadata,
						prompts: {},
					});
				}
				if (pathStr.includes('openspec-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const result = await resetOpenSpecPrompt('proposal');

			expect(result).toBe(mockBundledPrompt);
			expect(fs.writeFile).not.toHaveBeenCalled();
		});
	});

	describe('getOpenSpecCommand', () => {
		it('should return command by ID', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('openspec-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const command = await getOpenSpecCommand('proposal');

			expect(command).not.toBeNull();
			expect(command?.id).toBe('proposal');
			expect(command?.command).toBe('/openspec.proposal');
		});

		it('should return null for unknown ID', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('openspec-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const command = await getOpenSpecCommand('nonexistent');

			expect(command).toBeNull();
		});
	});

	describe('getOpenSpecCommandBySlash', () => {
		it('should return command by slash command string', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('openspec-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const command = await getOpenSpecCommandBySlash('/openspec.proposal');

			expect(command).not.toBeNull();
			expect(command?.id).toBe('proposal');
			expect(command?.command).toBe('/openspec.proposal');
		});

		it('should return null for unknown slash command', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('openspec-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const command = await getOpenSpecCommandBySlash('/openspec.nonexistent');

			expect(command).toBeNull();
		});
	});

	describe('user prompts directory priority', () => {
		it('should prefer user prompts directory over bundled for upstream commands', async () => {
			const userPromptContent = '# User Updated Proposal';

			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw new Error('ENOENT');
				}
				// User prompts directory (downloaded updates)
				if (pathStr.includes('openspec-prompts') && pathStr.includes('openspec.proposal.md')) {
					return userPromptContent;
				}
				if (pathStr.includes('openspec-prompts')) {
					throw new Error('ENOENT');
				}
				// Bundled prompts (fallback)
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const commands = await getOpenSpecPrompts();
			const proposalCmd = commands.find((cmd) => cmd.id === 'proposal');

			expect(proposalCmd?.prompt).toBe(userPromptContent);
		});

		it('should always use bundled for custom commands (help, implement)', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('openspec-prompts')) {
					return '# Should not be used for custom commands';
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const commands = await getOpenSpecPrompts();
			const helpCmd = commands.find((cmd) => cmd.id === 'help');
			const implementCmd = commands.find((cmd) => cmd.id === 'implement');

			// Custom commands should use bundled, not user prompts directory
			expect(helpCmd?.prompt).toBe(mockBundledPrompt);
			expect(implementCmd?.prompt).toBe(mockBundledPrompt);
		});
	});

	describe('packaged prompt paths', () => {
		it('should load bundled prompts from process resources when packaged', async () => {
			(app as typeof app & { isPackaged: boolean }).isPackaged = true;
			Object.defineProperty(process, 'resourcesPath', {
				value: '/mock/resources',
				configurable: true,
			});
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('openspec-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('/mock/resources/prompts/openspec') && pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error(`Unexpected path: ${pathStr}`);
			});

			const commands = await getOpenSpecPrompts();

			expect(commands).toHaveLength(5);
			expect(fs.readFile).toHaveBeenCalledWith(
				expect.stringContaining('/mock/resources/prompts/openspec/openspec.help.md'),
				'utf-8'
			);
		});
	});

	describe('refreshOpenSpecPrompts', () => {
		const agentsMd = [
			'# Stage 1: Creating Changes',
			'Write the proposal.',
			'',
			'# Stage 2: Implementing Changes',
			'Implement the approved tasks.',
			'',
			'# Stage 3: Archiving Changes',
			'Archive the completed change.',
			'',
		].join('\n');

		function stubFetch(...responses: unknown[]) {
			const fetchMock = vi.fn();
			for (const response of responses) {
				if (response instanceof Error) {
					fetchMock.mockRejectedValueOnce(response);
				} else {
					fetchMock.mockResolvedValueOnce(response);
				}
			}
			vi.stubGlobal('fetch', fetchMock);
			return fetchMock;
		}

		it('should fetch latest release prompts, preserve existing customizations, and write metadata', async () => {
			stubFetch(
				{
					ok: true,
					json: vi.fn().mockResolvedValue({ tag_name: 'v1.2.3' }),
				},
				{
					ok: true,
					text: vi.fn().mockResolvedValue(agentsMd),
				}
			);
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					return JSON.stringify({
						metadata: mockMetadata,
						prompts: {
							help: {
								content: '# Custom Help',
								isModified: true,
							},
						},
					});
				}
				throw new Error('ENOENT');
			});
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const metadata = await refreshOpenSpecPrompts();

			expect(metadata).toMatchObject({
				commitSha: 'v1.2.3',
				sourceVersion: '1.2.3',
				sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
			});
			expect(fs.mkdir).toHaveBeenCalledWith('/mock/userData/openspec-prompts', {
				recursive: true,
			});
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('openspec.proposal.md'),
				expect.stringContaining('Write the proposal.'),
				'utf8'
			);
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('openspec.apply.md'),
				expect.stringContaining('Implement the approved tasks.'),
				'utf8'
			);
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('openspec.archive.md'),
				expect.stringContaining('Archive the completed change.'),
				'utf8'
			);

			const customizationsWrite = vi
				.mocked(fs.writeFile)
				.mock.calls.find(([filePath]) =>
					filePath.toString().includes('openspec-customizations.json')
				);
			expect(customizationsWrite).toBeDefined();
			const writtenCustomizations = JSON.parse(customizationsWrite![1] as string);
			expect(writtenCustomizations.metadata.commitSha).toBe('v1.2.3');
			expect(writtenCustomizations.prompts.help.content).toBe('# Custom Help');
		});

		it('should warn and throw when release lookup fails and AGENTS.md cannot be fetched', async () => {
			stubFetch(new Error('network down'), {
				ok: false,
				statusText: 'Not Found',
			});

			await expect(refreshOpenSpecPrompts()).rejects.toThrow(
				'Failed to fetch AGENTS.md: Not Found'
			);
			expect(logger.warn).toHaveBeenCalledWith(
				'Could not fetch release info, using main branch',
				'[OpenSpec]'
			);
		});

		it('should use main when no latest release is available and warn for missing sections', async () => {
			stubFetch(
				{ ok: false },
				{
					ok: true,
					text: vi.fn().mockResolvedValue('# Stage 1: Creating Changes\nOnly proposal.'),
				}
			);
			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const metadata = await refreshOpenSpecPrompts();

			expect(metadata.commitSha).toBe('main');
			expect(metadata.sourceVersion).toBe('main');
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('openspec.proposal.md'),
				expect.stringContaining('Only proposal.'),
				'utf8'
			);
			expect(fs.writeFile).not.toHaveBeenCalledWith(
				expect.stringContaining('openspec.apply.md'),
				expect.any(String),
				'utf8'
			);
			expect(logger.warn).toHaveBeenCalledWith(
				'Could not extract apply section from AGENTS.md',
				'[OpenSpec]'
			);
			expect(logger.warn).toHaveBeenCalledWith(
				'Could not extract archive section from AGENTS.md',
				'[OpenSpec]'
			);
		});
	});
});
