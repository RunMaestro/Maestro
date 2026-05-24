/**
 * Tests for the Spec Kit Manager
 *
 * Covers bundled prompt loading, user customization persistence,
 * reset behavior, command lookup, and downloaded prompt precedence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'fs';
import https from 'https';
import { app } from 'electron';

const execAsyncMock = vi.hoisted(() => vi.fn());

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
		rm: vi.fn(),
	},
}));

vi.mock('fs', () => ({
	default: {
		createWriteStream: vi.fn(),
	},
	createWriteStream: vi.fn(),
}));

vi.mock('https', () => ({
	default: {
		get: vi.fn(),
	},
}));

vi.mock('child_process', () => {
	const execMock = vi.fn();
	execMock[Symbol.for('nodejs.util.promisify.custom')] = execAsyncMock;
	return {
		default: {
			exec: execMock,
		},
		exec: execMock,
	};
});

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import {
	getSpeckitMetadata,
	getSpeckitPrompts,
	saveSpeckitPrompt,
	resetSpeckitPrompt,
	getSpeckitCommand,
	getSpeckitCommandBySlash,
	refreshSpeckitPrompts,
	type SpecKitMetadata,
} from '../../main/speckit-manager';

describe('speckit-manager', () => {
	const mockBundledPrompt = '# Test Prompt\n\nThis is a test prompt.';
	const mockMetadata: SpecKitMetadata = {
		lastRefreshed: '2025-01-01T00:00:00Z',
		commitSha: 'v0.1.0',
		sourceVersion: '0.1.0',
		sourceUrl: 'https://github.com/github/spec-kit',
	};

	beforeEach(() => {
		vi.clearAllMocks();
		execAsyncMock.mockReset();
		vi.mocked(app.getPath).mockImplementation((name) =>
			name === 'temp' ? '/mock/temp' : '/mock/userData'
		);
		app.isPackaged = false;
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		app.isPackaged = false;
	});

	describe('getSpeckitMetadata', () => {
		it('returns bundled metadata when no customizations exist', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('speckit-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});

			await expect(getSpeckitMetadata()).resolves.toEqual(mockMetadata);
		});

		it('returns customized metadata when available', async () => {
			const customMetadata: SpecKitMetadata = {
				lastRefreshed: '2025-06-15T12:00:00Z',
				commitSha: 'v0.2.0',
				sourceVersion: '0.2.0',
				sourceUrl: 'https://github.com/github/spec-kit',
			};

			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('speckit-customizations.json')) {
					return JSON.stringify({
						metadata: customMetadata,
						prompts: {},
					});
				}
				throw new Error('ENOENT');
			});

			await expect(getSpeckitMetadata()).resolves.toEqual(customMetadata);
		});

		it('falls back to bundled metadata when downloaded metadata is unavailable', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('speckit-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('speckit-prompts') && pathStr.includes('metadata.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('prompts/speckit/metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});

			await expect(getSpeckitMetadata()).resolves.toEqual(mockMetadata);
		});

		it('returns default metadata when no files exist', async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

			const metadata = await getSpeckitMetadata();

			expect(metadata).toEqual({
				lastRefreshed: '2024-01-01T00:00:00Z',
				commitSha: 'bundled',
				sourceVersion: '0.0.90',
				sourceUrl: 'https://github.com/github/spec-kit',
			});
		});
	});

	describe('getSpeckitPrompts', () => {
		it('returns all bundled commands', async () => {
			mockBundledPromptReads();

			const commands = await getSpeckitPrompts();

			expect(commands.map((cmd) => cmd.command)).toEqual([
				'/speckit.help',
				'/speckit.constitution',
				'/speckit.specify',
				'/speckit.clarify',
				'/speckit.plan',
				'/speckit.tasks',
				'/speckit.analyze',
				'/speckit.checklist',
				'/speckit.taskstoissues',
				'/speckit.implement',
			]);
		});

		it('returns commands with complete public structure', async () => {
			mockBundledPromptReads();

			const commands = await getSpeckitPrompts();

			for (const cmd of commands) {
				expect(cmd).toEqual(
					expect.objectContaining({
						id: expect.any(String),
						command: expect.stringMatching(/^\/speckit\./),
						description: expect.any(String),
						prompt: mockBundledPrompt,
						isCustom: expect.any(Boolean),
						isModified: false,
					})
				);
			}
		});

		it('marks custom commands correctly', async () => {
			mockBundledPromptReads();

			const commands = await getSpeckitPrompts();

			expect(commands.find((cmd) => cmd.id === 'help')?.isCustom).toBe(true);
			expect(commands.find((cmd) => cmd.id === 'implement')?.isCustom).toBe(true);
			expect(commands.find((cmd) => cmd.id === 'specify')?.isCustom).toBe(false);
		});

		it('uses modified custom prompt content when available', async () => {
			const customContent = '# Custom Specify\n\nThis is my custom prompt.';
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('speckit-customizations.json')) {
					return JSON.stringify({
						metadata: mockMetadata,
						prompts: {
							specify: {
								content: customContent,
								isModified: true,
								modifiedAt: '2025-06-15T12:00:00Z',
							},
						},
					});
				}
				if (pathStr.includes('speckit-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const commands = await getSpeckitPrompts();
			const specifyCommand = commands.find((cmd) => cmd.id === 'specify');

			expect(specifyCommand?.prompt).toBe(customContent);
			expect(specifyCommand?.isModified).toBe(true);
		});

		it('ignores stored prompt content when isModified is false', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('speckit-customizations.json')) {
					return JSON.stringify({
						metadata: mockMetadata,
						prompts: {
							specify: {
								content: '# Stale draft',
								isModified: false,
							},
						},
					});
				}
				if (pathStr.includes('speckit-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const commands = await getSpeckitPrompts();

			expect(commands.find((cmd) => cmd.id === 'specify')?.prompt).toBe(mockBundledPrompt);
		});

		it('falls back to placeholder content when a bundled prompt is missing', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('speckit-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('speckit-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('speckit.specify.md')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const commands = await getSpeckitPrompts();

			expect(commands.find((cmd) => cmd.id === 'specify')?.prompt).toBe(
				'# specify\n\nPrompt not available.'
			);
		});

		it('falls back to placeholder content when a custom bundled prompt is missing', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('speckit-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('speckit.help.md')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('speckit-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const commands = await getSpeckitPrompts();

			expect(commands.find((cmd) => cmd.id === 'help')?.prompt).toBe(
				'# help\n\nPrompt not available.'
			);
		});
	});

	describe('saveSpeckitPrompt', () => {
		it('saves a customization to disk', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('speckit-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await saveSpeckitPrompt('specify', '# My Custom Prompt');

			const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
			const writtenContent = JSON.parse(writeCall[1] as string);

			expect(writeCall[0].toString()).toContain('speckit-customizations.json');
			expect(writtenContent.metadata).toEqual(mockMetadata);
			expect(writtenContent.prompts.specify.content).toBe('# My Custom Prompt');
			expect(writtenContent.prompts.specify.isModified).toBe(true);
			expect(writtenContent.prompts.specify.modifiedAt).toBeDefined();
		});

		it('preserves existing customizations', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('speckit-customizations.json')) {
					return JSON.stringify({
						metadata: mockMetadata,
						prompts: {
							plan: {
								content: '# Existing Plan',
								isModified: true,
								modifiedAt: '2025-01-01T00:00:00Z',
							},
						},
					});
				}
				throw new Error('ENOENT');
			});
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await saveSpeckitPrompt('specify', '# New Specify');

			const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
			const writtenContent = JSON.parse(writeCall[1] as string);

			expect(writtenContent.prompts.plan.content).toBe('# Existing Plan');
			expect(writtenContent.prompts.specify.content).toBe('# New Specify');
		});
	});

	describe('resetSpeckitPrompt', () => {
		it('resets a prompt to bundled default', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('speckit-customizations.json')) {
					return JSON.stringify({
						metadata: mockMetadata,
						prompts: {
							specify: {
								content: '# Custom',
								isModified: true,
							},
						},
					});
				}
				if (pathStr.includes('speckit-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const result = await resetSpeckitPrompt('specify');

			expect(result).toBe(mockBundledPrompt);
			const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
			const writtenContent = JSON.parse(writeCall[1] as string);
			expect(writtenContent.prompts.specify).toBeUndefined();
		});

		it('returns bundled default without writing when no customization exists', async () => {
			mockBundledPromptReads();

			await expect(resetSpeckitPrompt('specify')).resolves.toBe(mockBundledPrompt);
			expect(fs.writeFile).not.toHaveBeenCalled();
		});

		it('throws for unknown command', async () => {
			mockBundledPromptReads();

			await expect(resetSpeckitPrompt('nonexistent')).rejects.toThrow(
				'Unknown speckit command: nonexistent'
			);
		});
	});

	describe('command lookup', () => {
		it('returns a command by ID', async () => {
			mockBundledPromptReads();

			const command = await getSpeckitCommand('specify');

			expect(command).toEqual(
				expect.objectContaining({
					id: 'specify',
					command: '/speckit.specify',
				})
			);
		});

		it('returns null for unknown ID', async () => {
			mockBundledPromptReads();

			await expect(getSpeckitCommand('nonexistent')).resolves.toBeNull();
		});

		it('returns a command by slash command string', async () => {
			mockBundledPromptReads();

			const command = await getSpeckitCommandBySlash('/speckit.specify');

			expect(command).toEqual(
				expect.objectContaining({
					id: 'specify',
					command: '/speckit.specify',
				})
			);
		});

		it('returns null for unknown slash command', async () => {
			mockBundledPromptReads();

			await expect(getSpeckitCommandBySlash('/speckit.nope')).resolves.toBeNull();
		});
	});

	describe('user prompts directory priority', () => {
		it('prefers downloaded prompts over bundled prompts for upstream commands', async () => {
			const userPromptContent = '# User Updated Specify';
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('speckit-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('speckit-prompts') && pathStr.includes('speckit.specify.md')) {
					return userPromptContent;
				}
				if (pathStr.includes('speckit-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const commands = await getSpeckitPrompts();

			expect(commands.find((cmd) => cmd.id === 'specify')?.prompt).toBe(userPromptContent);
		});

		it('always uses bundled prompts for custom commands', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('speckit-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('speckit-prompts')) {
					return '# Should not be used for custom commands';
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			const commands = await getSpeckitPrompts();

			expect(commands.find((cmd) => cmd.id === 'help')?.prompt).toBe(mockBundledPrompt);
			expect(commands.find((cmd) => cmd.id === 'implement')?.prompt).toBe(mockBundledPrompt);
		});

		it('prefers downloaded metadata when available', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('speckit-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('speckit-prompts') && pathStr.includes('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});

			await expect(getSpeckitMetadata()).resolves.toEqual(mockMetadata);
		});

		it('uses resources path for bundled prompts when packaged', async () => {
			const originalResourcesPath = process.resourcesPath;
			process.resourcesPath = '/mock/resources';
			app.isPackaged = true;
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('speckit-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('speckit-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw new Error('ENOENT');
			});

			await getSpeckitPrompts();

			expect(
				vi
					.mocked(fs.readFile)
					.mock.calls.some(([filePath]) =>
						filePath.toString().includes('/mock/resources/prompts/speckit/speckit.help.md')
					)
			).toBe(true);
			process.resourcesPath = originalResourcesPath;
		});
	});

	describe('refreshSpeckitPrompts', () => {
		it('throws when release info cannot be fetched', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn().mockResolvedValue({
					ok: false,
					statusText: 'Service Unavailable',
				})
			);

			await expect(refreshSpeckitPrompts()).rejects.toThrow(
				'Failed to fetch release info: Service Unavailable'
			);
		});

		it('throws when release has no Claude template asset', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn().mockResolvedValue({
					ok: true,
					json: vi.fn().mockResolvedValue({
						tag_name: 'v1.2.3',
						assets: [{ name: 'other.zip', browser_download_url: 'https://example.com/other.zip' }],
					}),
				})
			);

			await expect(refreshSpeckitPrompts()).rejects.toThrow(
				'Could not find Claude template in release assets'
			);
		});

		it('downloads, extracts, stores upstream prompts, writes metadata, and cleans temp files', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn().mockResolvedValue({
					ok: true,
					json: vi.fn().mockResolvedValue({
						tag_name: 'v1.2.3',
						assets: [
							{
								name: 'template-claude.zip',
								browser_download_url: 'https://example.com/speckit.zip',
							},
						],
					}),
				})
			);
			mockHttpsDownload(200, 'https://cdn.example.com/speckit.zip');
			execAsyncMock.mockImplementation(async (command: string) => {
				if (command.includes('unzip -l')) {
					return {
						stdout: [
							'Archive: speckit.zip',
							'  123  01-01-2026 00:00   spec-kit-v1/.claude/commands/constitution.md',
							'  456  01-01-2026 00:00   spec-kit-v1/.claude/commands/specify.md',
							'  555  01-01-2026 00:00   spec-kit-v1/.claude/commands/tasks.md',
							'  789  01-01-2026 00:00   spec-kit-v1/.claude/commands/implement.md',
							'  111  01-01-2026 00:00   spec-kit-v1/README.md',
						].join('\n'),
						stderr: '',
					};
				}
				return { stdout: '', stderr: '' };
			});
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);
			vi.mocked(fs.rm).mockResolvedValue(undefined);
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.endsWith('constitution.md')) {
					return '# Constitution prompt';
				}
				if (pathStr.endsWith('specify.md')) {
					return '# Specify prompt';
				}
				if (pathStr.endsWith('tasks.md')) {
					throw new Error('corrupt extract');
				}
				if (pathStr.includes('speckit-customizations.json')) {
					throw new Error('ENOENT');
				}
				throw new Error('ENOENT');
			});

			const metadata = await refreshSpeckitPrompts();

			expect(metadata).toEqual(
				expect.objectContaining({
					commitSha: 'v1.2.3',
					sourceVersion: '1.2.3',
					sourceUrl: 'https://github.com/github/spec-kit',
				})
			);
			expect(https.get).toHaveBeenCalledWith(
				'https://example.com/speckit.zip',
				{ headers: { 'User-Agent': 'Maestro-SpecKit-Refresher' } },
				expect.any(Function)
			);
			expect(https.get).toHaveBeenCalledWith(
				'https://cdn.example.com/speckit.zip',
				{ headers: { 'User-Agent': 'Maestro-SpecKit-Refresher' } },
				expect.any(Function)
			);
			expect(execAsyncMock).toHaveBeenCalledWith(expect.stringContaining('unzip -l'));
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('speckit.constitution.md'),
				'# Constitution prompt',
				'utf8'
			);
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('speckit.specify.md'),
				'# Specify prompt',
				'utf8'
			);
			expect(
				vi
					.mocked(fs.writeFile)
					.mock.calls.some(([filePath]) => filePath.toString().includes('speckit.implement.md'))
			).toBe(false);
			expect(
				vi
					.mocked(fs.writeFile)
					.mock.calls.some(([filePath]) => filePath.toString().includes('speckit.tasks.md'))
			).toBe(false);
			expect(fs.rm).toHaveBeenCalledWith('/mock/temp/maestro-speckit-refresh', {
				recursive: true,
				force: true,
			});
		});

		it('cleans up temp files after download failure', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn().mockResolvedValue({
					ok: true,
					json: vi.fn().mockResolvedValue({
						tag_name: 'v1.2.3',
						assets: [
							{
								name: 'template-claude.zip',
								browser_download_url: 'https://example.com/speckit.zip',
							},
						],
					}),
				})
			);
			mockHttpsDownload(500);
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.rm).mockResolvedValue(undefined);

			await expect(refreshSpeckitPrompts()).rejects.toThrow('HTTP 500');
			expect(fs.rm).toHaveBeenCalledWith('/mock/temp/maestro-speckit-refresh', {
				recursive: true,
				force: true,
			});
		});
	});

	function mockBundledPromptReads() {
		vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
			const pathStr = filePath.toString();
			if (pathStr.includes('speckit-customizations.json')) {
				throw new Error('ENOENT');
			}
			if (pathStr.includes('speckit-prompts')) {
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
	}

	function mockHttpsDownload(statusCode = 200, redirectLocation?: string) {
		const stream = {
			close: vi.fn(),
			on: vi.fn((event: string, callback: () => void) => {
				if (event === 'finish') {
					stream.finish = callback;
				}
				return stream;
			}),
			finish: undefined as undefined | (() => void),
		};
		vi.mocked(fsSync.createWriteStream).mockReturnValue(stream as never);
		let callCount = 0;
		vi.mocked(https.get).mockImplementation((_url, _options, callback) => {
			callCount += 1;
			const responseStatus = redirectLocation && callCount === 1 ? 302 : statusCode;
			const response = {
				statusCode: responseStatus,
				headers: redirectLocation && callCount === 1 ? { location: redirectLocation } : {},
				pipe: vi.fn(() => {
					queueMicrotask(() => stream.finish?.());
				}),
			};
			callback(response as never);
			return { on: vi.fn() } as never;
		});
	}
});
