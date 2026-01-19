/**
 * Tests for the OpenSpec IPC handlers
 *
 * These tests verify the IPC handlers for managing OpenSpec commands:
 * - Getting metadata
 * - Getting all prompts
 * - Getting individual commands
 * - Saving user customizations
 * - Resetting to defaults
 * - Refreshing from GitHub
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerOpenSpecHandlers } from '../../../../main/ipc/handlers/openspec';
import * as openspecManager from '../../../../main/openspec-manager';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock the openspec-manager module
vi.mock('../../../../main/openspec-manager', () => ({
	getOpenSpecMetadata: vi.fn(),
	getOpenSpecPrompts: vi.fn(),
	getOpenSpecCommandBySlash: vi.fn(),
	saveOpenSpecPrompt: vi.fn(),
	resetOpenSpecPrompt: vi.fn(),
	refreshOpenSpecPrompts: vi.fn(),
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

describe('openspec IPC handlers', () => {
	let handlers: Map<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers
		registerOpenSpecHandlers();
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all openspec handlers', () => {
			const expectedChannels = [
				'openspec:getMetadata',
				'openspec:getPrompts',
				'openspec:getCommand',
				'openspec:savePrompt',
				'openspec:resetPrompt',
				'openspec:refresh',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
		});
	});

	describe('openspec:getMetadata', () => {
		it('should return metadata from manager', async () => {
			const mockMetadata = {
				lastRefreshed: '2025-01-01T00:00:00Z',
				commitSha: 'abc1234',
				sourceVersion: '0.1.0',
				sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
			};

			vi.mocked(openspecManager.getOpenSpecMetadata).mockResolvedValue(mockMetadata);

			const handler = handlers.get('openspec:getMetadata');
			const result = await handler!({} as any);

			expect(openspecManager.getOpenSpecMetadata).toHaveBeenCalled();
			expect(result).toEqual({ success: true, metadata: mockMetadata });
		});

		it('should handle errors gracefully', async () => {
			vi.mocked(openspecManager.getOpenSpecMetadata).mockRejectedValue(new Error('Failed to read'));

			const handler = handlers.get('openspec:getMetadata');
			const result = await handler!({} as any);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to read');
		});
	});

	describe('openspec:getPrompts', () => {
		it('should return all commands from manager', async () => {
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

			vi.mocked(openspecManager.getOpenSpecPrompts).mockResolvedValue(mockCommands);

			const handler = handlers.get('openspec:getPrompts');
			const result = await handler!({} as any);

			expect(openspecManager.getOpenSpecPrompts).toHaveBeenCalled();
			expect(result).toEqual({ success: true, commands: mockCommands });
		});

		it('should handle errors gracefully', async () => {
			vi.mocked(openspecManager.getOpenSpecPrompts).mockRejectedValue(new Error('Failed'));

			const handler = handlers.get('openspec:getPrompts');
			const result = await handler!({} as any);

			expect(result.success).toBe(false);
		});
	});

	describe('openspec:getCommand', () => {
		it('should return command by slash command string', async () => {
			const mockCommand = {
				id: 'proposal',
				command: '/openspec.proposal',
				description: 'Create a change proposal',
				prompt: '# Proposal',
				isCustom: false,
				isModified: false,
			};

			vi.mocked(openspecManager.getOpenSpecCommandBySlash).mockResolvedValue(mockCommand);

			const handler = handlers.get('openspec:getCommand');
			const result = await handler!({} as any, '/openspec.proposal');

			expect(openspecManager.getOpenSpecCommandBySlash).toHaveBeenCalledWith('/openspec.proposal');
			expect(result).toEqual({ success: true, command: mockCommand });
		});

		it('should return null for unknown command', async () => {
			vi.mocked(openspecManager.getOpenSpecCommandBySlash).mockResolvedValue(null);

			const handler = handlers.get('openspec:getCommand');
			const result = await handler!({} as any, '/openspec.unknown');

			expect(result).toEqual({ success: true, command: null });
		});
	});

	describe('openspec:savePrompt', () => {
		it('should save prompt customization', async () => {
			vi.mocked(openspecManager.saveOpenSpecPrompt).mockResolvedValue(undefined);

			const handler = handlers.get('openspec:savePrompt');
			const result = await handler!({} as any, 'proposal', '# Custom Proposal');

			expect(openspecManager.saveOpenSpecPrompt).toHaveBeenCalledWith(
				'proposal',
				'# Custom Proposal'
			);
			expect(result).toEqual({ success: true });
		});

		it('should handle save errors', async () => {
			vi.mocked(openspecManager.saveOpenSpecPrompt).mockRejectedValue(new Error('Write failed'));

			const handler = handlers.get('openspec:savePrompt');
			const result = await handler!({} as any, 'proposal', '# Custom');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Write failed');
		});
	});

	describe('openspec:resetPrompt', () => {
		it('should reset prompt to default', async () => {
			const defaultPrompt = '# Default Proposal';
			vi.mocked(openspecManager.resetOpenSpecPrompt).mockResolvedValue(defaultPrompt);

			const handler = handlers.get('openspec:resetPrompt');
			const result = await handler!({} as any, 'proposal');

			expect(openspecManager.resetOpenSpecPrompt).toHaveBeenCalledWith('proposal');
			expect(result).toEqual({ success: true, prompt: defaultPrompt });
		});

		it('should handle unknown command error', async () => {
			vi.mocked(openspecManager.resetOpenSpecPrompt).mockRejectedValue(
				new Error('Unknown openspec command: nonexistent')
			);

			const handler = handlers.get('openspec:resetPrompt');
			const result = await handler!({} as any, 'nonexistent');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Unknown openspec command');
		});
	});

	describe('openspec:refresh', () => {
		it('should refresh prompts from GitHub', async () => {
			const newMetadata = {
				lastRefreshed: '2025-06-15T12:00:00Z',
				commitSha: 'def5678',
				sourceVersion: '0.1.0',
				sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
			};

			vi.mocked(openspecManager.refreshOpenSpecPrompts).mockResolvedValue(newMetadata);

			const handler = handlers.get('openspec:refresh');
			const result = await handler!({} as any);

			expect(openspecManager.refreshOpenSpecPrompts).toHaveBeenCalled();
			expect(result).toEqual({ success: true, metadata: newMetadata });
		});

		it('should handle network errors', async () => {
			vi.mocked(openspecManager.refreshOpenSpecPrompts).mockRejectedValue(
				new Error('Failed to fetch AGENTS.md: Not Found')
			);

			const handler = handlers.get('openspec:refresh');
			const result = await handler!({} as any);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to fetch');
		});
	});
});
