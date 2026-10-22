/**
 * Tests for the keyboard-mode switch service.
 *
 * Three things have to hold here, and each of them is a way a user could end up
 * stuck or lied to:
 *
 *  - The switch is announced. Every chord in the app may have just changed, and
 *    the toast is the only thing that says which set is now live.
 *  - A displaced action is named at the moment of the switch. It has no chord
 *    at all until the user records one, and nothing else tells them.
 *  - The user's own binding on the toggle chord wins. Opt+Cmd+V was
 *    `toggleConcerto`'s default once, so the toggle cannot assume it owns it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	KEYBOARD_MODE_TOGGLE_KEYS,
	findKeyboardModeToggleShadow,
	keyboardModeToggleShadow,
	nextKeyboardMode,
	switchKeyboardMode,
} from '../../../renderer/services/keyboardMode';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { FIXED_SHORTCUTS } from '../../../renderer/constants/shortcuts';
import type { Shortcut } from '../../../renderer/types';
import type { ShortcutOverride } from '../../../shared/shortcut-types';

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

const BASE_SHORTCUTS: Record<string, Shortcut> = {
	newInstance: { id: 'newInstance', label: 'New Agent', keys: ['Meta', 'n'] },
	prevTab: { id: 'prevTab', label: 'Previous Tab', keys: ['Alt', 'ArrowLeft'] },
	// Ships unbound, so it can never be read as holding the toggle chord.
	openLeaderboard: { id: 'openLeaderboard', label: 'Open Leaderboard', keys: [] },
};

const BASE_TAB_SHORTCUTS: Record<string, Shortcut> = {
	newTab: { id: 'newTab', label: 'New Tab', keys: ['Meta', 't'] },
};

/** Seed the store with a known pair of buckets and a known mode. */
function seed(
	overrides: {
		keyboardMode?: 'default' | 'vim';
		shortcuts?: Record<string, Shortcut>;
		tabShortcuts?: Record<string, Shortcut>;
		vimShortcuts?: Record<string, ShortcutOverride>;
		vimTabShortcuts?: Record<string, ShortcutOverride>;
	} = {}
) {
	useSettingsStore.setState({
		keyboardMode: overrides.keyboardMode ?? 'default',
		shortcuts: overrides.shortcuts ?? BASE_SHORTCUTS,
		tabShortcuts: overrides.tabShortcuts ?? BASE_TAB_SHORTCUTS,
		vimShortcuts: overrides.vimShortcuts ?? {},
		vimTabShortcuts: overrides.vimTabShortcuts ?? {},
	});
}

describe('nextKeyboardMode', () => {
	it('cycles through the modes in the order the toggle offers them', () => {
		expect(nextKeyboardMode('default')).toBe('vim');
		expect(nextKeyboardMode('vim')).toBe('default');
	});

	it('lands on the mode that ships when the current one is not a known mode', () => {
		// The setting is on disk and can be hand-edited, so a mode nobody
		// recognizes must still have a next step rather than stranding the key.
		expect(nextKeyboardMode('emacs' as 'vim')).toBe('default');
	});
});

describe('findKeyboardModeToggleShadow', () => {
	it('reads the chord off the FIXED entry rather than a second copy', () => {
		expect(KEYBOARD_MODE_TOGGLE_KEYS).toBe(FIXED_SHORTCUTS.toggleKeyboardMode.keys);
		expect(KEYBOARD_MODE_TOGGLE_KEYS).toEqual(['Alt', 'Meta', 'v']);
	});

	it('reports no shadow when nothing claims the chord', () => {
		expect(findKeyboardModeToggleShadow(BASE_SHORTCUTS, BASE_TAB_SHORTCUTS)).toBeNull();
	});

	it('names the action that holds the chord', () => {
		const shadow = findKeyboardModeToggleShadow(
			{
				...BASE_SHORTCUTS,
				toggleConcerto: {
					id: 'toggleConcerto',
					label: 'Toggle Concerto',
					keys: ['Alt', 'Meta', 'v'],
				},
			},
			BASE_TAB_SHORTCUTS
		);
		expect(shadow?.label).toBe('Toggle Concerto');
	});

	it('catches the Windows spelling through the Meta/Ctrl collapse', () => {
		// Ctrl+Alt+V is not EQUAL to Alt+Meta+V, but it is the same keypress to
		// the matcher, so an equality check would let the toggle fire on top of a
		// binding the user already has.
		const shadow = findKeyboardModeToggleShadow(
			{
				...BASE_SHORTCUTS,
				newInstance: { id: 'newInstance', label: 'New Agent', keys: ['Ctrl', 'Alt', 'v'] },
			},
			BASE_TAB_SHORTCUTS
		);
		expect(shadow?.id).toBe('newInstance');
	});

	it('searches the tab map too', () => {
		const shadow = findKeyboardModeToggleShadow(BASE_SHORTCUTS, {
			newTab: { id: 'newTab', label: 'New Tab', keys: ['Alt', 'Meta', 'v'] },
		});
		expect(shadow?.id).toBe('newTab');
	});

	it('is not fooled by an unassigned action', () => {
		// keys: [] is "registered but unassigned" and claims nothing. Read as a
		// shadow it would disable the toggle for every user, since several
		// actions ship unbound.
		expect(
			findKeyboardModeToggleShadow({ openLeaderboard: BASE_SHORTCUTS.openLeaderboard }, {})
		).toBeNull();
	});
});

describe('keyboardModeToggleShadow', () => {
	beforeEach(() => {
		seed();
	});

	it('asks the live mode, not the default bucket', () => {
		// The chord is free in default mode and taken in Vim mode, so the answer
		// has to change with the mode. Reading `shortcuts` directly would say
		// "free" in both.
		seed({
			keyboardMode: 'default',
			vimShortcuts: {
				newInstance: { id: 'newInstance', label: 'New Agent', keys: ['Alt', 'Meta', 'v'] },
			},
		});
		expect(keyboardModeToggleShadow()).toBeNull();

		useSettingsStore.setState({ keyboardMode: 'vim' });
		expect(keyboardModeToggleShadow()?.id).toBe('newInstance');
	});
});

describe('switchKeyboardMode', () => {
	beforeEach(() => {
		vi.mocked(notifyToast).mockClear();
		vi.mocked(window.maestro.settings.set).mockClear();
		seed();
	});

	it('switches to the other mode and persists it', () => {
		expect(switchKeyboardMode()).toBe('vim');
		expect(useSettingsStore.getState().keyboardMode).toBe('vim');
		expect(window.maestro.settings.set).toHaveBeenCalledWith('keyboardMode', 'vim');
	});

	it('switches to a named mode', () => {
		seed({ keyboardMode: 'vim' });
		expect(switchKeyboardMode('default')).toBe('default');
		expect(useSettingsStore.getState().keyboardMode).toBe('default');
	});

	it('names the mode that is now live and says the other one is kept', () => {
		switchKeyboardMode();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Keyboard Mode: Vim',
				message: expect.stringContaining('Your Default mode customizations are kept'),
			})
		);
	});

	it('does nothing, and says nothing, when the mode is already live', () => {
		// An acknowledgement for a change that did not happen teaches the user
		// that the toast means nothing.
		expect(switchKeyboardMode('default')).toBe('default');
		expect(notifyToast).not.toHaveBeenCalled();
		expect(window.maestro.settings.set).not.toHaveBeenCalledWith('keyboardMode', 'default');
	});

	it('names the actions Vim mode leaves unbound, and warns rather than informs', () => {
		seed({
			shortcuts: {
				...BASE_SHORTCUTS,
				prevTab: { id: 'prevTab', label: 'Previous Tab', keys: ['Ctrl', 'PageUp'] },
			},
			vimShortcuts: {
				newInstance: { id: 'newInstance', label: 'New Agent', keys: ['Ctrl', 'PageUp'] },
			},
		});

		switchKeyboardMode('vim');

		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				color: 'yellow',
				title: 'Keyboard Mode: Vim',
				// The LABEL, not the id: 'prevTab' is not what the user reads in
				// Settings, so it is not what they can go looking for.
				message: expect.stringContaining('Previous Tab'),
			})
		);
	});

	it('does not name displaced actions on the way back to default mode', () => {
		// Default mode is the set every other mode inherits from, so it displaces
		// nothing - naming Vim's displacement here would be a warning about a
		// mode the user just left.
		seed({
			keyboardMode: 'vim',
			shortcuts: {
				...BASE_SHORTCUTS,
				prevTab: { id: 'prevTab', label: 'Previous Tab', keys: ['Ctrl', 'PageUp'] },
			},
			vimShortcuts: {
				newInstance: { id: 'newInstance', label: 'New Agent', keys: ['Ctrl', 'PageUp'] },
			},
		});

		switchKeyboardMode('default');

		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'theme', title: 'Keyboard Mode: Default' })
		);
		expect(vi.mocked(notifyToast).mock.calls[0][0].message).not.toContain('Previous Tab');
	});

	it('keeps the acknowledgement in the app', () => {
		// The user pressed a key or picked a menu item to get here, so they are
		// looking at the window; an OS banner would be noise.
		switchKeyboardMode();
		expect(notifyToast).toHaveBeenCalledWith(expect.objectContaining({ skipOsNotification: true }));
	});
});
