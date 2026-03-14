// ABOUTME: Tests for the core prompts IPC handlers.
// ABOUTME: Verifies get, getAll, getAllIds, save, and reset handler registration and behavior.

/**
 * Tests for the Core Prompts IPC handlers
 *
 * These tests verify the IPC handlers for managing core system prompts:
 * - Getting a single prompt by ID
 * - Getting all prompts with metadata
 * - Getting all prompt IDs
 * - Saving user customizations
 * - Resetting to bundled defaults
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerPromptsHandlers } from '../../../../main/ipc/handlers/prompts';
import * as promptManager from '../../../../main/prompt-manager';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock the prompt-manager module
vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn(),
	getAllPrompts: vi.fn(),
	getAllPromptIds: vi.fn(),
	savePrompt: vi.fn(),
	resetPrompt: vi.fn(),
	arePromptsInitialized: vi.fn(),
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('prompts IPC handlers', () => {
	let handlers: Map<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers
		registerPromptsHandlers();
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all prompts handlers', () => {
			const expectedChannels = [
				'prompts:get',
				'prompts:getAll',
				'prompts:getAllIds',
				'prompts:save',
				'prompts:reset',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
		});
	});

	describe('prompts:get', () => {
		it('should return prompt content when initialized', async () => {
			vi.mocked(promptManager.arePromptsInitialized).mockReturnValue(true);
			vi.mocked(promptManager.getPrompt).mockReturnValue('prompt content');

			const handler = handlers.get('prompts:get')!;
			const result = await handler({}, 'wizard-system');

			expect(result).toEqual({ success: true, content: 'prompt content' });
			expect(promptManager.getPrompt).toHaveBeenCalledWith('wizard-system');
		});

		it('should return error when not initialized', async () => {
			vi.mocked(promptManager.arePromptsInitialized).mockReturnValue(false);

			const handler = handlers.get('prompts:get')!;
			const result = await handler({}, 'wizard-system');

			expect(result).toEqual({ success: false, error: 'Prompts not yet initialized' });
		});

		it('should return error on exception', async () => {
			vi.mocked(promptManager.arePromptsInitialized).mockReturnValue(true);
			vi.mocked(promptManager.getPrompt).mockImplementation(() => {
				throw new Error('Unknown prompt ID: invalid');
			});

			const handler = handlers.get('prompts:get')!;
			const result = await handler({}, 'invalid');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Unknown prompt ID');
		});
	});

	describe('prompts:getAll', () => {
		it('should return all prompts when initialized', async () => {
			const mockPrompts = [
				{
					id: 'wizard-system',
					filename: 'wizard-system.md',
					description: 'Main wizard system prompt',
					category: 'wizard',
					content: 'wizard content',
					isModified: false,
				},
			];
			vi.mocked(promptManager.arePromptsInitialized).mockReturnValue(true);
			vi.mocked(promptManager.getAllPrompts).mockReturnValue(mockPrompts);

			const handler = handlers.get('prompts:getAll')!;
			const result = await handler({});

			expect(result).toEqual({ success: true, prompts: mockPrompts });
		});

		it('should return error when not initialized', async () => {
			vi.mocked(promptManager.arePromptsInitialized).mockReturnValue(false);

			const handler = handlers.get('prompts:getAll')!;
			const result = await handler({});

			expect(result).toEqual({ success: false, error: 'Prompts not yet initialized' });
		});
	});

	describe('prompts:getAllIds', () => {
		it('should return all prompt IDs when initialized', async () => {
			const mockIds = ['wizard-system', 'autorun-default'];
			vi.mocked(promptManager.arePromptsInitialized).mockReturnValue(true);
			vi.mocked(promptManager.getAllPromptIds).mockReturnValue(mockIds);

			const handler = handlers.get('prompts:getAllIds')!;
			const result = await handler({});

			expect(result).toEqual({ success: true, ids: mockIds });
		});

		it('should return error when not initialized', async () => {
			vi.mocked(promptManager.arePromptsInitialized).mockReturnValue(false);

			const handler = handlers.get('prompts:getAllIds')!;
			const result = await handler({});

			expect(result).toEqual({ success: false, error: 'Prompts not yet initialized' });
		});
	});

	describe('prompts:save', () => {
		it('should save prompt successfully', async () => {
			vi.mocked(promptManager.savePrompt).mockResolvedValue(undefined);

			const handler = handlers.get('prompts:save')!;
			const result = await handler({}, 'wizard-system', 'new content');

			expect(result).toEqual({ success: true });
			expect(promptManager.savePrompt).toHaveBeenCalledWith('wizard-system', 'new content');
		});

		it('should return error on save failure', async () => {
			vi.mocked(promptManager.savePrompt).mockRejectedValue(new Error('Write failed'));

			const handler = handlers.get('prompts:save')!;
			const result = await handler({}, 'wizard-system', 'new content');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Write failed');
		});
	});

	describe('prompts:reset', () => {
		it('should reset prompt and return bundled content', async () => {
			vi.mocked(promptManager.resetPrompt).mockResolvedValue('bundled default');

			const handler = handlers.get('prompts:reset')!;
			const result = await handler({}, 'wizard-system');

			expect(result).toEqual({ success: true, content: 'bundled default' });
			expect(promptManager.resetPrompt).toHaveBeenCalledWith('wizard-system');
		});

		it('should return error on reset failure', async () => {
			vi.mocked(promptManager.resetPrompt).mockRejectedValue(new Error('Reset failed'));

			const handler = handlers.get('prompts:reset')!;
			const result = await handler({}, 'wizard-system');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Reset failed');
		});
	});
});
