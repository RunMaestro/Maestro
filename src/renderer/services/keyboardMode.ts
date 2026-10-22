/**
 * Switch the live keyboard binding set, from any of the routes that offer it:
 * the Opt+Cmd+V chord, the command palette, the hamburger menu, and the toggle
 * at the top of Settings > Shortcuts.
 *
 * All of them land here rather than calling `setKeyboardMode` themselves, for
 * two reasons. The acknowledgement is the only thing that tells the user which
 * set is now live (every chord in the app may have just changed under them),
 * and the displaced actions have to be named at the moment of the switch or not
 * at all - an action whose chord Vim mode took is unbound until the user
 * records one, and the toast is the only place that says so unprompted.
 *
 * The one exception is the Settings toggle, which calls `setKeyboardMode`
 * directly: it also has to disarm its own pending reset, and the list of rows
 * below it IS the visible acknowledgement, so a toast over the top of it would
 * only restate what the screen already shows.
 */

import {
	KEYBOARD_MODES,
	KEYBOARD_MODE_LABELS,
	type KeyboardMode,
} from '../../shared/shortcut-types';
import { shortcutKeysCollide } from '../../shared/shortcutKeys';
import { FIXED_SHORTCUTS } from '../constants/shortcuts';
import { notifyToast } from '../stores/notificationStore';
import {
	selectActiveShortcuts,
	selectActiveTabShortcuts,
	selectVimDisplacedActions,
	type ShortcutsState,
} from '../stores/settingsShortcutsSlice';
import { useSettingsStore } from '../stores/settingsStore';
import type { Shortcut } from '../types';

/**
 * The chord that switches modes. Read from `FIXED_SHORTCUTS` rather than
 * written out again, so the handler, the shadow check, and the badges in the
 * palette and the menu cannot drift apart from the entry the help modal and
 * Settings render.
 */
export const KEYBOARD_MODE_TOGGLE_KEYS = FIXED_SHORTCUTS.toggleKeyboardMode.keys;

/**
 * The mode after this one, wrapping at the end of `KEYBOARD_MODES`.
 *
 * Derived from that list rather than a two-way flip, so a third mode becomes a
 * step in the cycle instead of a mode the keyboard can never reach. An
 * unrecognized current mode lands on the first entry, which is the mode that
 * ships.
 */
export function nextKeyboardMode(mode: KeyboardMode): KeyboardMode {
	const at = KEYBOARD_MODES.indexOf(mode);
	return KEYBOARD_MODES[(at + 1) % KEYBOARD_MODES.length];
}

/**
 * The action whose own binding has taken the mode-toggle chord, or null when
 * the chord is free.
 *
 * The user's binding wins. Opt+Cmd+V was `toggleConcerto`'s default once, and
 * anyone may bind it deliberately, so the toggle cannot assume the chord is
 * its own: stealing it would kill a key someone has used for months, with no
 * indication of where it went. Compared with `shortcutKeysCollide` so the
 * Meta/Ctrl collapse counts - a Windows user's `Ctrl+Alt+V` is the same
 * keypress.
 *
 * Takes the maps rather than reading the store, so the Shortcuts tab can ask
 * about the set it is CURRENTLY showing (which is the mode being edited, not
 * necessarily a mode that is live anywhere else yet).
 */
export function findKeyboardModeToggleShadow(
	shortcuts: Record<string, Shortcut>,
	tabShortcuts: Record<string, Shortcut>
): Shortcut | null {
	return (
		[...Object.values(shortcuts), ...Object.values(tabShortcuts)].find((sc) =>
			shortcutKeysCollide(sc.keys, KEYBOARD_MODE_TOGGLE_KEYS)
		) ?? null
	);
}

/**
 * Same question, asked of the live mode's effective set. This is the one the
 * keydown handler asks before firing.
 */
export function keyboardModeToggleShadow(): Shortcut | null {
	const state = useSettingsStore.getState();
	return findKeyboardModeToggleShadow(
		selectActiveShortcuts(state),
		selectActiveTabShortcuts(state)
	);
}

/**
 * The LABELS of the actions Vim mode leaves unbound, for the toast.
 *
 * Read off the default buckets, which declare every action: a displaced action
 * has no override, so the Vim tables have no label for it. `selectVimDisplacedActions`
 * answers whatever mode is live, which is what lets this run while default mode
 * is still the current one.
 */
function displacedActionLabels(state: ShortcutsState): string[] {
	return selectVimDisplacedActions(state).map(
		(id) => state.shortcuts[id]?.label ?? state.tabShortcuts[id]?.label ?? id
	);
}

/**
 * Switch to `target`, or to the next mode in order, and say so.
 *
 * Returns the mode that is now live. A switch to the mode that is already live
 * is a no-op with no toast: an acknowledgement for a change that did not happen
 * teaches the user the toast means nothing.
 */
export function switchKeyboardMode(target?: KeyboardMode): KeyboardMode {
	const state = useSettingsStore.getState();
	const next = target ?? nextKeyboardMode(state.keyboardMode);
	if (next === state.keyboardMode) return next;

	state.setKeyboardMode(next);

	const otherLabel = KEYBOARD_MODE_LABELS[nextKeyboardMode(next)];
	// Only the mode being switched INTO can have displaced actions, and only Vim
	// mode has overrides to displace with: default mode is the set every other
	// mode inherits from.
	const displaced = next === 'vim' ? displacedActionLabels(state) : [];

	notifyToast({
		// Yellow when something needs the user's attention, which a displaced
		// action does: it has no chord at all until they record one.
		color: displaced.length > 0 ? 'yellow' : 'theme',
		title: `Keyboard Mode: ${KEYBOARD_MODE_LABELS[next]}`,
		message:
			displaced.length > 0
				? `Record a ${KEYBOARD_MODE_LABELS[next]} chord for these in Settings > Shortcuts, where they have no binding in this mode: ${displaced.join(', ')}.`
				: `Only this mode's bindings are live. Your ${otherLabel} mode customizations are kept.`,
		// The user pressed a key, picked a menu item, or ran a palette command to
		// get here, so they are looking at the window. An OS banner for an
		// in-app acknowledgement is pure noise.
		skipOsNotification: true,
	});

	return next;
}
