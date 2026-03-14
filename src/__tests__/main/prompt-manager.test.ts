// ABOUTME: Tests for the prompt-manager module that loads core system prompts from disk.
// ABOUTME: Verifies initialization, caching, user customization overlay, save, and reset flows.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';

// Mock electron app module
vi.mock('electron', () => ({
	app: {
		isPackaged: false,
		getPath: vi.fn().mockReturnValue('/tmp/test-user-data'),
	},
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
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

describe('prompt-manager', () => {
	const mockReadFile = vi.mocked(fs.readFile);
	const mockWriteFile = vi.mocked(fs.writeFile);

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('should load all prompts from disk', async () => {
		// Return ENOENT for customizations (no user customizations)
		// Return mock content for all bundled prompt files
		mockReadFile.mockImplementation((filePath: any) => {
			const p = String(filePath);
			if (p.includes('core-prompts-customizations.json')) {
				return Promise.reject(new Error('ENOENT'));
			}
			return Promise.resolve('mock prompt content');
		});

		const { initializePrompts, getPrompt } = await import('../../main/prompt-manager');

		await initializePrompts();

		expect(getPrompt('wizard-system')).toBe('mock prompt content');
		expect(getPrompt('autorun-default')).toBe('mock prompt content');
	});

	it('should prefer user customizations over bundled', async () => {
		mockReadFile.mockImplementation((filePath: any) => {
			const p = String(filePath);
			if (p.includes('core-prompts-customizations.json')) {
				return Promise.resolve(JSON.stringify({
					prompts: {
						'wizard-system': { content: 'customized content', isModified: true },
					},
				}));
			}
			return Promise.resolve('bundled content');
		});

		const { initializePrompts, getPrompt } = await import('../../main/prompt-manager');

		await initializePrompts();

		expect(getPrompt('wizard-system')).toBe('customized content');
		// Non-customized prompts should use bundled content
		expect(getPrompt('autorun-default')).toBe('bundled content');
	});

	it('should throw if getPrompt called before init', async () => {
		const { getPrompt } = await import('../../main/prompt-manager');

		expect(() => getPrompt('wizard-system')).toThrow('Prompts not initialized');
	});

	it('should throw for unknown prompt ID', async () => {
		mockReadFile.mockImplementation((filePath: any) => {
			const p = String(filePath);
			if (p.includes('core-prompts-customizations.json')) {
				return Promise.reject(new Error('ENOENT'));
			}
			return Promise.resolve('mock content');
		});

		const { initializePrompts, getPrompt } = await import('../../main/prompt-manager');

		await initializePrompts();

		expect(() => getPrompt('unknown-prompt')).toThrow('Unknown prompt ID');
	});

	it('should save user customization', async () => {
		mockReadFile.mockImplementation((filePath: any) => {
			const p = String(filePath);
			if (p.includes('core-prompts-customizations.json')) {
				return Promise.reject(new Error('ENOENT'));
			}
			return Promise.resolve('bundled content');
		});
		mockWriteFile.mockResolvedValue(undefined);

		const { initializePrompts, savePrompt, getPrompt } = await import('../../main/prompt-manager');

		await initializePrompts();
		await savePrompt('wizard-system', 'new content');

		// Verify file was written with correct structure
		expect(mockWriteFile).toHaveBeenCalled();
		const writtenContent = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		expect(writtenContent.prompts['wizard-system'].content).toBe('new content');
		expect(writtenContent.prompts['wizard-system'].isModified).toBe(true);

		// Verify in-memory cache was updated immediately
		expect(getPrompt('wizard-system')).toBe('new content');
	});

	it('should reject blank prompt customization content', async () => {
		mockReadFile.mockImplementation((filePath: any) => {
			const p = String(filePath);
			if (p.includes('core-prompts-customizations.json')) {
				return Promise.reject(new Error('ENOENT'));
			}
			return Promise.resolve('bundled content');
		});
		mockWriteFile.mockResolvedValue(undefined);

		const { initializePrompts, savePrompt, getPrompt } = await import('../../main/prompt-manager');

		await initializePrompts();
		await expect(savePrompt('wizard-system', '   \n\t')).rejects.toThrow(
			'Prompt content cannot be empty or whitespace'
		);

		expect(mockWriteFile).not.toHaveBeenCalled();
		expect(getPrompt('wizard-system')).toBe('bundled content');
	});

	it('should reset prompt to bundled default', async () => {
		// First init with a customization
		mockReadFile.mockImplementation((filePath: any) => {
			const p = String(filePath);
			if (p.includes('core-prompts-customizations.json')) {
				return Promise.resolve(JSON.stringify({
					prompts: {
						'wizard-system': { content: 'custom', isModified: true },
					},
				}));
			}
			return Promise.resolve('bundled default');
		});
		mockWriteFile.mockResolvedValue(undefined);

		const { initializePrompts, resetPrompt, getPrompt } = await import('../../main/prompt-manager');

		await initializePrompts();
		expect(getPrompt('wizard-system')).toBe('custom');

		const bundledContent = await resetPrompt('wizard-system');

		expect(bundledContent).toBe('bundled default');
		// Verify in-memory cache was updated
		expect(getPrompt('wizard-system')).toBe('bundled default');
	});

	it('should not delete customization when bundled reset read fails', async () => {
		let failBundledReadOnReset = false;

		mockReadFile.mockImplementation((filePath: any) => {
			const p = String(filePath);
			if (p.includes('core-prompts-customizations.json')) {
				return Promise.resolve(
					JSON.stringify({
						prompts: {
							'wizard-system': { content: 'custom', isModified: true },
						},
					})
				);
			}
			if (failBundledReadOnReset && p.endsWith('wizard-system.md')) {
				return Promise.reject(new Error('EACCES: permission denied'));
			}
			return Promise.resolve('bundled default');
		});
		mockWriteFile.mockResolvedValue(undefined);

		const { initializePrompts, resetPrompt, getPrompt } = await import('../../main/prompt-manager');

		await initializePrompts();
		expect(getPrompt('wizard-system')).toBe('custom');

		failBundledReadOnReset = true;
		await expect(resetPrompt('wizard-system')).rejects.toThrow('EACCES');

		// Customization file should not be rewritten if bundled read fails.
		expect(mockWriteFile).not.toHaveBeenCalled();
		expect(getPrompt('wizard-system')).toBe('custom');
	});

	it('should return all prompts with metadata via getAllPrompts', async () => {
		mockReadFile.mockImplementation((filePath: any) => {
			const p = String(filePath);
			if (p.includes('core-prompts-customizations.json')) {
				return Promise.reject(new Error('ENOENT'));
			}
			return Promise.resolve('content');
		});

		const { initializePrompts, getAllPrompts } = await import('../../main/prompt-manager');

		await initializePrompts();

		const prompts = getAllPrompts();
		expect(prompts.length).toBeGreaterThan(0);

		const wizardPrompt = prompts.find((p) => p.id === 'wizard-system');
		expect(wizardPrompt).toBeDefined();
		expect(wizardPrompt!.filename).toBe('wizard-system.md');
		expect(wizardPrompt!.category).toBe('wizard');
		expect(wizardPrompt!.content).toBe('content');
		expect(wizardPrompt!.isModified).toBe(false);
	});

	it('should return all prompt IDs via getAllPromptIds', async () => {
		const { getAllPromptIds } = await import('../../main/prompt-manager');

		const ids = getAllPromptIds();
		expect(ids).toContain('wizard-system');
		expect(ids).toContain('autorun-default');
		expect(ids.length).toBeGreaterThan(0);
	});

	it('should report initialization state via arePromptsInitialized', async () => {
		mockReadFile.mockImplementation((filePath: any) => {
			const p = String(filePath);
			if (p.includes('core-prompts-customizations.json')) {
				return Promise.reject(new Error('ENOENT'));
			}
			return Promise.resolve('content');
		});

		const { arePromptsInitialized, initializePrompts } = await import('../../main/prompt-manager');

		expect(arePromptsInitialized()).toBe(false);

		await initializePrompts();

		expect(arePromptsInitialized()).toBe(true);
	});

	it('should skip re-initialization if already initialized', async () => {
		mockReadFile.mockImplementation((filePath: any) => {
			const p = String(filePath);
			if (p.includes('core-prompts-customizations.json')) {
				return Promise.reject(new Error('ENOENT'));
			}
			return Promise.resolve('content');
		});

		const { initializePrompts, arePromptsInitialized } = await import('../../main/prompt-manager');

		await initializePrompts();
		expect(arePromptsInitialized()).toBe(true);

		// Clear mock call count, then init again
		mockReadFile.mockClear();
		await initializePrompts();

		// Should not have read any files the second time
		expect(mockReadFile).not.toHaveBeenCalled();
	});

	it('should throw if bundled prompt file is missing', async () => {
		mockReadFile.mockImplementation((filePath: any) => {
			const p = String(filePath);
			if (p.includes('core-prompts-customizations.json')) {
				return Promise.reject(new Error('ENOENT'));
			}
			// Fail for the first prompt file
			return Promise.reject(new Error('ENOENT: no such file'));
		});

		const { initializePrompts } = await import('../../main/prompt-manager');

		await expect(initializePrompts()).rejects.toThrow('Failed to load required prompt');
	});

	it('should throw when saving unknown prompt ID', async () => {
		mockReadFile.mockImplementation((filePath: any) => {
			const p = String(filePath);
			if (p.includes('core-prompts-customizations.json')) {
				return Promise.reject(new Error('ENOENT'));
			}
			return Promise.resolve('content');
		});

		const { initializePrompts, savePrompt } = await import('../../main/prompt-manager');

		await initializePrompts();

		await expect(savePrompt('nonexistent-id', 'content')).rejects.toThrow('Unknown prompt ID');
	});

	it('should throw when resetting unknown prompt ID', async () => {
		mockReadFile.mockImplementation((filePath: any) => {
			const p = String(filePath);
			if (p.includes('core-prompts-customizations.json')) {
				return Promise.reject(new Error('ENOENT'));
			}
			return Promise.resolve('content');
		});

		const { initializePrompts, resetPrompt } = await import('../../main/prompt-manager');

		await initializePrompts();

		await expect(resetPrompt('nonexistent-id')).rejects.toThrow('Unknown prompt ID');
	});

	it('should keep prompt IDs in sync with src/prompts constants', async () => {
		const { getAllPromptIds } = await import('../../main/prompt-manager');
		const { PROMPT_IDS } = await import('../../prompts');

		expect(new Set(getAllPromptIds())).toEqual(new Set(Object.values(PROMPT_IDS)));
	});
});
