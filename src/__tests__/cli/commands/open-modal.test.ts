/**
 * @file open-modal.test.ts
 * @description Tests for the open-modal CLI command and mode-aware shortcut resolution
 *
 * Tests the open-modal command functionality including:
 * - Resolving shortcuts in default keyboard mode
 * - Resolving shortcuts in Vim keyboard mode
 * - Handling missing shortcuts
 * - Fallback behavior when settings are unavailable
 *
 * The chord is the point of this command, not a decoration on it: an agent
 * answering "where do I see my scheduled tasks?" relays the manual path the
 * CLI printed, so a wrong chord teaches the user a key that does something
 * else. The suite at the bottom therefore asserts the PRINTED STRING rather
 * than that the command succeeded, for each of the four things the resolution
 * has to get right - the user's own default-mode bindings, the live mode's
 * overrides, a mode that is not live contributing nothing, and the fixed
 * table being outside both.
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
import { formatShortcutKeysFor } from '../../../shared/shortcutKeys';
import { DEFAULT_SHORTCUTS } from '../../../renderer/constants/shortcuts';

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

	/**
	 * THE CHORD ITSELF.
	 *
	 * The suite above proves the command runs in both modes; none of it would
	 * fail if the printed key were the wrong one, because every assertion is on
	 * the label. These read the hint line, which is the string an agent relays
	 * to the user, and compare it against the chord formatted from the table the
	 * resolution was supposed to use.
	 *
	 * `--json` is the probe where there is a choice, because the chord is a field
	 * of its own there rather than embedded in a sentence.
	 */
	describe('the chord it prints', () => {
		/** Succeed the IPC call, so the command reaches its output. */
		function succeedOpen(): void {
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({ type: 'open_modal_result', success: true }),
				};
				return action(mockClient as never);
			});
		}

		/** The `shortcut` field of the `--json` payload the command printed. */
		function printedShortcut(): string {
			const line = consoleSpy.mock.calls.map((call) => String(call[0])).at(-1) ?? '';
			return (JSON.parse(line) as { shortcut: string }).shortcut;
		}

		/** The chord as this platform's formatter renders it. */
		function formatted(keys: string[]): string {
			return formatShortcutKeysFor(keys, isMacOS(), '+');
		}

		beforeEach(succeedOpen);

		it('prints the SHIPPED chord when the user has customized nothing', () => {
			vi.mocked(readSettings).mockReturnValue({});

			return openModal('settings', { json: true }).then(() => {
				expect(printedShortcut()).toBe(formatted(DEFAULT_SHORTCUTS.settings.keys));
			});
		});

		it("prints the USER'S default-mode chord, not the one Maestro ships", async () => {
			// The bug this is for: resolving against `DEFAULT_SHORTCUTS` alone
			// printed the factory chord to a user who had rebound the action
			// months ago. The renderer resolves against the hydrated buckets,
			// which are the persisted map merged over the shipped table, and the
			// CLI has to build the same thing.
			vi.mocked(readSettings).mockReturnValue({
				keyboardMode: 'default',
				shortcuts: { settings: { id: 'settings', label: 'Settings', keys: ['Alt', 'Home'] } },
			});

			await openModal('settings', { json: true });

			expect(printedShortcut()).toBe(formatted(['Alt', 'Home']));
		});

		it('keeps the shipped chord for an action the persisted map does not mention', async () => {
			// A persisted `shortcuts` map is whatever the user's install wrote, and
			// it may predate an action existing. Replacing the table rather than
			// merging over it would print nothing for every such action.
			vi.mocked(readSettings).mockReturnValue({
				shortcuts: { settings: { id: 'settings', label: 'Settings', keys: ['Alt', 'Home'] } },
			});

			await openModal('shortcuts', { json: true });

			expect(printedShortcut()).toBe(formatted(DEFAULT_SHORTCUTS.help.keys));
		});

		it("prints the VIM chord while Vim mode is live, over the user's default-mode one", async () => {
			// Both buckets are populated and they disagree. The live mode decides,
			// and an override REPLACES rather than merging with what it overrides.
			vi.mocked(readSettings).mockReturnValue({
				keyboardMode: 'vim',
				shortcuts: { help: { id: 'help', label: 'Show Shortcuts', keys: ['Alt', 'Home'] } },
				vimShortcuts: { help: { id: 'help', keys: ['Ctrl', 'Alt', 'Shift', 'h'] } },
			});

			await openModal('shortcuts', { json: true });

			expect(printedShortcut()).toBe(formatted(['Ctrl', 'Alt', 'Shift', 'h']));
		});

		it('ignores the Vim bucket while default mode is live', async () => {
			// Same file, mode flipped. Default mode is the set every other mode
			// inherits FROM, so its answer must be untouched by what Vim mode
			// would have said.
			vi.mocked(readSettings).mockReturnValue({
				keyboardMode: 'default',
				shortcuts: { help: { id: 'help', label: 'Show Shortcuts', keys: ['Alt', 'Home'] } },
				vimShortcuts: { help: { id: 'help', keys: ['Ctrl', 'Alt', 'Shift', 'h'] } },
			});

			await openModal('shortcuts', { json: true });

			expect(printedShortcut()).toBe(formatted(['Alt', 'Home']));
		});

		it("inherits the user's default-mode chord in Vim mode when no override displaces it", async () => {
			// The inheritance, through the CLI. A Vim-mode user who rebound an
			// action in default mode and never gave it a Vim chord presses the
			// default-mode one, so that is what has to be printed - not the
			// factory chord, and not nothing.
			vi.mocked(readSettings).mockReturnValue({
				keyboardMode: 'vim',
				shortcuts: { settings: { id: 'settings', label: 'Settings', keys: ['Alt', 'Home'] } },
				vimShortcuts: { help: { id: 'help', keys: ['Ctrl', 'Alt', 'Shift', 'h'] } },
			});

			await openModal('settings', { json: true });

			expect(printedShortcut()).toBe(formatted(['Alt', 'Home']));
		});

		it('prints nothing for an action a Vim override displaced', async () => {
			// A displaced action is genuinely unbound in that mode until the user
			// records a chord, and printing the chord it has in the OTHER mode
			// would name a key that does nothing. `resolveEffectiveShortcuts`
			// reports it in `displaced`; here it has to come out as an empty
			// field, and the hint line has to drop the "press ..." clause.
			vi.mocked(readSettings).mockReturnValue({
				keyboardMode: 'vim',
				// `usageDashboard` keeps its inherited chord; `openCue` is given
				// the same one by an override, so the inheriting action loses it.
				vimShortcuts: {
					openCue: { id: 'openCue', keys: DEFAULT_SHORTCUTS.usageDashboard.keys },
				},
			});

			await openModal('usage-dashboard', { json: true });

			expect(printedShortcut()).toBe('');
			const payload = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0])) as { hint: string };
			expect(payload.hint).not.toContain('press');
		});

		it('leaves FIXED_SHORTCUTS outside the mode resolution', async () => {
			// The fixed table is the one no mode overrides and no user rebinds.
			// Feeding it in as a base map put it inside the inheritance and
			// displacement rules, so a Vim override on its chord could have
			// displaced it; it is read separately instead. No surface names a
			// fixed action today, so what this pins is that an override aimed at
			// one changes nothing about the surface that shares its chord.
			vi.mocked(readSettings).mockReturnValue({
				keyboardMode: 'vim',
				vimShortcuts: {
					toggleKeyboardMode: {
						id: 'toggleKeyboardMode',
						keys: DEFAULT_SHORTCUTS.settings.keys,
					},
				},
			});

			await openModal('settings', { json: true });

			expect(printedShortcut()).toBe(formatted(DEFAULT_SHORTCUTS.settings.keys));
		});

		it('reads the settings file once for a whole --list, not once per surface', async () => {
			// `--list` prints every surface. Resolving inside the per-surface
			// lookup meant a parse of maestro-settings.json per row.
			vi.mocked(readSettings).mockReturnValue({});

			await openModal(undefined, { list: true });

			expect(vi.mocked(readSettings)).toHaveBeenCalledTimes(1);
		});

		it('prints the chord in the --list rows too', async () => {
			vi.mocked(readSettings).mockReturnValue({
				shortcuts: { settings: { id: 'settings', label: 'Settings', keys: ['Alt', 'Home'] } },
			});

			await openModal(undefined, { list: true });

			const rows = consoleSpy.mock.calls.map((call) => String(call[0])).join('\n');
			expect(rows).toContain(`key: ${formatted(['Alt', 'Home'])}`);
		});
	});
});
