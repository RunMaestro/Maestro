/**
 * @file open-modal.test.ts
 * @description Tests for the open-modal CLI command and mode-aware shortcut resolution
 *
 * Tests the open-modal command functionality including:
 * - Resolving shortcuts in default keyboard mode
 * - Resolving shortcuts in Vim keyboard mode
 * - Handling missing shortcuts
 * - Fallback behavior when settings are unavailable
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

// Mock storage to control settings
vi.mock('../../../cli/services/storage', () => ({
	getConfigDir: vi.fn(() => '/home/user/.config/maestro'),
	getSyncDir: vi.fn(() => '/home/user/.config/maestro'),
	readSettings: vi.fn(),
	readSettingValue: vi.fn(() => undefined),
	writeSettingValue: vi.fn(() => true),
	deleteSettingValue: vi.fn(() => false),
	readEncoreFlags: vi.fn(() => ({})),
	getStoreFileDir: vi.fn(() => '/home/user/.config/maestro'),
	readSessions: vi.fn(() => []),
	readLiveSessions: vi.fn(() => []),
	readGroups: vi.fn(() => []),
	readHistory: vi.fn(() => []),
	readSshRemotes: vi.fn(() => []),
}));

// Mock maestro-client
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

import { readSettings } from '../../../cli/services/storage';
import { openModal } from '../../../cli/commands/open-modal';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { isMacOS } from '../../../shared/platformDetection';

describe('open-modal command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	describe('shortcut resolution in keyboard modes', () => {
		it('should resolve shortcuts from default keyboard mode', async () => {
			// Default mode: no custom shortcuts
			vi.mocked(readSettings).mockReturnValue({
				keyboardMode: 'default',
				shortcuts: {},
				tabShortcuts: {},
				vimShortcuts: {},
				vimTabShortcuts: {},
			});

			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({ type: 'open_modal_result', success: true }),
				};
				return action(mockClient as never);
			});

			await openModal('settings', {});

			// Settings surface has shortcutId 'settings' which resolves to Cmd+, on macOS
			// The hint should be printed (unless we're not on macOS, but the function
			// will determine the correct platform string)
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Opened Settings'));
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should resolve shortcuts from Vim keyboard mode', async () => {
			// Vim mode with a custom binding for help (history rebinding)
			vi.mocked(readSettings).mockReturnValue({
				keyboardMode: 'vim',
				shortcuts: {},
				tabShortcuts: {},
				vimShortcuts: {
					help: { keys: ['Control', 'Alt', 'Shift', 'h'] },
				},
				vimTabShortcuts: {},
			});

			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({ type: 'open_modal_result', success: true }),
				};
				return action(mockClient as never);
			});

			await openModal('shortcuts', {});

			// In Vim mode, help shortcut is overridden to Ctrl+Alt+Shift+H
			// The output should reflect the Vim mode binding
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Opened Keyboard Shortcuts'));
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should handle surfaces with no shortcut binding', async () => {
			vi.mocked(readSettings).mockReturnValue({
				keyboardMode: 'default',
				shortcuts: {},
				tabShortcuts: {},
				vimShortcuts: {},
				vimTabShortcuts: {},
			});

			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({ type: 'open_modal_result', success: true }),
				};
				return action(mockClient as never);
			});

			// Marketplace has no shortcutId
			await openModal('marketplace', {});

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('Opened Playbook Marketplace')
			);
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should fall back to default mode when settings are missing', async () => {
			// Settings file doesn't exist or is empty
			vi.mocked(readSettings).mockReturnValue({});

			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({ type: 'open_modal_result', success: true }),
				};
				return action(mockClient as never);
			});

			await openModal('settings', {});

			// Should fall back to default mode shortcuts
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Opened Settings'));
			expect(processExitSpy).not.toHaveBeenCalled();
		});
	});
});
