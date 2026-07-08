/**
 * Tests for the Spec Kit IPC handlers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerSpeckitHandlers } from '../../main/ipc/handlers/speckit';
import * as speckitManager from '../../main/speckit-manager';
import { logger } from '../../main/utils/logger';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

vi.mock('../../main/speckit-manager', () => ({
	getSpeckitMetadata: vi.fn(),
	getSpeckitPrompts: vi.fn(),
	getSpeckitCommandBySlash: vi.fn(),
	saveSpeckitPrompt: vi.fn(),
	resetSpeckitPrompt: vi.fn(),
	refreshSpeckitPrompts: vi.fn(),
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('speckit IPC handlers', () => {
	let handlers: Map<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();

		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		registerSpeckitHandlers();
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('registers all speckit handlers', () => {
			const expectedChannels = [
				'speckit:getMetadata',
				'speckit:getPrompts',
				'speckit:getCommand',
				'speckit:savePrompt',
				'speckit:resetPrompt',
				'speckit:refresh',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}

			expect(logger.debug).toHaveBeenCalledWith('[SpecKit] Spec Kit IPC handlers registered');
		});
	});

	describe('speckit:getMetadata', () => {
		it('returns metadata from the manager', async () => {
			const mockMetadata = {
				lastRefreshed: '2025-01-01T00:00:00Z',
				commitSha: 'abc1234',
				sourceVersion: '0.2.0',
				sourceUrl: 'https://github.com/github/spec-kit',
			};

			vi.mocked(speckitManager.getSpeckitMetadata).mockResolvedValue(mockMetadata);

			const handler = handlers.get('speckit:getMetadata');
			const result = await handler!({} as any);

			expect(speckitManager.getSpeckitMetadata).toHaveBeenCalled();
			expect(result).toEqual({ success: true, metadata: mockMetadata });
		});

		it('returns a recoverable error when metadata loading fails', async () => {
			vi.mocked(speckitManager.getSpeckitMetadata).mockRejectedValue(
				new Error('Failed to read metadata')
			);

			const handler = handlers.get('speckit:getMetadata');
			const result = await handler!({} as any);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to read metadata');
		});
	});

	describe('speckit:getPrompts', () => {
		it('returns all commands from the manager', async () => {
			const mockCommands = [
				{
					id: 'specify',
					command: '/speckit.specify',
					description: 'Create or update a feature specification',
					prompt: '# Specify',
					isCustom: false,
					isModified: false,
				},
				{
					id: 'plan',
					command: '/speckit.plan',
					description: 'Create an implementation plan',
					prompt: '# Plan',
					isCustom: true,
					isModified: true,
				},
			];

			vi.mocked(speckitManager.getSpeckitPrompts).mockResolvedValue(mockCommands);

			const handler = handlers.get('speckit:getPrompts');
			const result = await handler!({} as any);

			expect(speckitManager.getSpeckitPrompts).toHaveBeenCalled();
			expect(result).toEqual({ success: true, commands: mockCommands });
		});

		it('returns a recoverable error when prompt loading fails', async () => {
			vi.mocked(speckitManager.getSpeckitPrompts).mockRejectedValue(
				new Error('Failed to load prompts')
			);

			const handler = handlers.get('speckit:getPrompts');
			const result = await handler!({} as any);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to load prompts');
		});
	});

	describe('speckit:getCommand', () => {
		it('returns a command by slash command string', async () => {
			const mockCommand = {
				id: 'specify',
				command: '/speckit.specify',
				description: 'Create or update a feature specification',
				prompt: '# Specify',
				isCustom: false,
				isModified: false,
			};

			vi.mocked(speckitManager.getSpeckitCommandBySlash).mockResolvedValue(mockCommand);

			const handler = handlers.get('speckit:getCommand');
			const result = await handler!({} as any, '/speckit.specify');

			expect(speckitManager.getSpeckitCommandBySlash).toHaveBeenCalledWith('/speckit.specify');
			expect(result).toEqual({ success: true, command: mockCommand });
		});

		it('returns null for an unknown slash command', async () => {
			vi.mocked(speckitManager.getSpeckitCommandBySlash).mockResolvedValue(null);

			const handler = handlers.get('speckit:getCommand');
			const result = await handler!({} as any, '/speckit.unknown');

			expect(speckitManager.getSpeckitCommandBySlash).toHaveBeenCalledWith('/speckit.unknown');
			expect(result).toEqual({ success: true, command: null });
		});
	});

	describe('speckit:savePrompt', () => {
		it('saves a prompt customization', async () => {
			vi.mocked(speckitManager.saveSpeckitPrompt).mockResolvedValue(undefined);

			const handler = handlers.get('speckit:savePrompt');
			const result = await handler!({} as any, 'specify', '# Custom Specify');

			expect(speckitManager.saveSpeckitPrompt).toHaveBeenCalledWith('specify', '# Custom Specify');
			expect(logger.info).toHaveBeenCalledWith(
				'Saved custom prompt for speckit.specify',
				'[SpecKit]'
			);
			expect(result).toEqual({ success: true });
		});

		it('returns a recoverable error when saving fails', async () => {
			vi.mocked(speckitManager.saveSpeckitPrompt).mockRejectedValue(new Error('Write failed'));

			const handler = handlers.get('speckit:savePrompt');
			const result = await handler!({} as any, 'specify', '# Custom');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Write failed');
		});
	});

	describe('speckit:resetPrompt', () => {
		it('resets a prompt to its bundled default', async () => {
			const defaultPrompt = '# Default Specify';
			vi.mocked(speckitManager.resetSpeckitPrompt).mockResolvedValue(defaultPrompt);

			const handler = handlers.get('speckit:resetPrompt');
			const result = await handler!({} as any, 'specify');

			expect(speckitManager.resetSpeckitPrompt).toHaveBeenCalledWith('specify');
			expect(logger.info).toHaveBeenCalledWith(
				'Reset speckit.specify to bundled default',
				'[SpecKit]'
			);
			expect(result).toEqual({ success: true, prompt: defaultPrompt });
		});

		it('returns a recoverable error for unknown commands', async () => {
			vi.mocked(speckitManager.resetSpeckitPrompt).mockRejectedValue(
				new Error('Unknown speckit command: nonexistent')
			);

			const handler = handlers.get('speckit:resetPrompt');
			const result = await handler!({} as any, 'nonexistent');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Unknown speckit command');
		});
	});

	describe('speckit:refresh', () => {
		it('refreshes prompts from GitHub', async () => {
			const newMetadata = {
				lastRefreshed: '2025-06-15T12:00:00Z',
				commitSha: 'def5678',
				sourceVersion: '0.2.0',
				sourceUrl: 'https://github.com/github/spec-kit',
			};

			vi.mocked(speckitManager.refreshSpeckitPrompts).mockResolvedValue(newMetadata);

			const handler = handlers.get('speckit:refresh');
			const result = await handler!({} as any);

			expect(speckitManager.refreshSpeckitPrompts).toHaveBeenCalled();
			expect(logger.info).toHaveBeenCalledWith('Refreshed spec-kit prompts to 0.2.0', '[SpecKit]');
			expect(result).toEqual({ success: true, metadata: newMetadata });
		});

		it('returns a recoverable error when refresh fails', async () => {
			vi.mocked(speckitManager.refreshSpeckitPrompts).mockRejectedValue(
				new Error('Failed to fetch release: Not Found')
			);

			const handler = handlers.get('speckit:refresh');
			const result = await handler!({} as any);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to fetch release');
		});
	});
});
