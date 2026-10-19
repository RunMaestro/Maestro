/**
 * useActiveShortcuts - the live keyboard mode's bindings, and the only door to
 * editing them.
 *
 * Reading and writing shortcuts both have to go through one place, because
 * there are now two independent persisted key sets and the wrong pairing is
 * silent in both directions: reading the default bucket while Vim mode is live
 * matches chords the user cannot see, and writing it while Vim mode is live
 * edits the set they are not looking at. Nothing outside this hook should pair
 * a bucket with a mode by hand.
 *
 * It subscribes narrowly rather than going through `useSettings()`: that hook
 * returns the whole settings object, so a shortcut consumer would re-render on
 * every unrelated setting.
 */

import { useCallback } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import {
	selectActiveShortcuts,
	selectActiveTabShortcuts,
	selectVimDisplacedActions,
} from '../../stores/settingsShortcutsSlice';
import { isOverrideInherited, overridesWithEdits } from '../../../shared/effectiveShortcuts';
import { DEFAULT_SHORTCUTS, TAB_SHORTCUTS } from '../../constants/shortcuts';
import { VIM_SHORTCUTS, VIM_TAB_SHORTCUTS } from '../../constants/vimShortcuts';
import type { KeyboardMode } from '../../../shared/shortcut-types';
import type { Shortcut } from '../../types';

/** Stable empty list for default mode, where nothing is ever displaced. */
const NO_DISPLACED: string[] = [];

export interface UseActiveShortcutsReturn {
	/** Which binding set is live. */
	keyboardMode: KeyboardMode;
	/** The general shortcut map the live mode is matched against. */
	shortcuts: Record<string, Shortcut>;
	/** The tab shortcut map the live mode is matched against. */
	tabShortcuts: Record<string, Shortcut>;
	/**
	 * Write the general map. Takes the whole map, like the store setter it
	 * replaces, and lands in the LIVE mode's bucket only.
	 */
	setShortcuts: (value: Record<string, Shortcut>) => void;
	/** Write the tab map. See `setShortcuts`. */
	setTabShortcuts: (value: Record<string, Shortcut>) => void;
	/**
	 * Restore the shipped bindings for the LIVE mode, leaving the other mode's
	 * customizations alone.
	 */
	resetToDefaults: () => void;
	/**
	 * Whether this action's chord comes from the default buckets rather than
	 * from this mode. Always false in default mode, which IS the base.
	 */
	isInherited: (actionId: string) => boolean;
	/**
	 * Actions a mode override has taken the chord of, so they are unbound until
	 * the user records one here. Empty in default mode.
	 */
	displaced: string[];
}

export function useActiveShortcuts(): UseActiveShortcutsReturn {
	const keyboardMode = useSettingsStore((s) => s.keyboardMode);
	const shortcuts = useSettingsStore(selectActiveShortcuts);
	const tabShortcuts = useSettingsStore(selectActiveTabShortcuts);
	const vimDisplaced = useSettingsStore(selectVimDisplacedActions);
	// Subscribed directly because `isInherited` has to re-evaluate when an
	// override appears even if it carries the chord the action already
	// inherited: the effective maps do not change in that case, but the row
	// stops being an inherited one.
	const vimShortcuts = useSettingsStore((s) => s.vimShortcuts);
	const vimTabShortcuts = useSettingsStore((s) => s.vimTabShortcuts);

	// The setters read the store at call time instead of closing over state, so
	// they keep one identity for the life of the component (the Shortcuts tab
	// hands them to every row) and can never write a mode that has since
	// changed under them.
	const setShortcuts = useCallback((value: Record<string, Shortcut>) => {
		const state = useSettingsStore.getState();
		if (state.keyboardMode !== 'vim') {
			state.setShortcuts(value);
			return;
		}
		const next = overridesWithEdits(state.vimShortcuts, selectActiveShortcuts(state), value);
		if (next !== state.vimShortcuts) state.setVimShortcuts(next);
	}, []);

	const setTabShortcuts = useCallback((value: Record<string, Shortcut>) => {
		const state = useSettingsStore.getState();
		if (state.keyboardMode !== 'vim') {
			state.setTabShortcuts(value);
			return;
		}
		const next = overridesWithEdits(state.vimTabShortcuts, selectActiveTabShortcuts(state), value);
		if (next !== state.vimTabShortcuts) state.setVimTabShortcuts(next);
	}, []);

	const resetToDefaults = useCallback(() => {
		const state = useSettingsStore.getState();
		if (state.keyboardMode === 'vim') {
			// Back to the shipped override tables, which is NOT the same as an
			// empty bucket: the tables carry this mode's own chords, and clearing
			// them would leave the mode inheriting default mode wholesale.
			state.setVimShortcuts(VIM_SHORTCUTS);
			state.setVimTabShortcuts(VIM_TAB_SHORTCUTS);
			return;
		}
		state.setShortcuts(DEFAULT_SHORTCUTS);
		state.setTabShortcuts(TAB_SHORTCUTS);
	}, []);

	const isInherited = useCallback(
		(actionId: string): boolean =>
			keyboardMode === 'vim' && isOverrideInherited(actionId, { vimShortcuts, vimTabShortcuts }),
		[keyboardMode, vimShortcuts, vimTabShortcuts]
	);

	return {
		keyboardMode,
		shortcuts,
		tabShortcuts,
		setShortcuts,
		setTabShortcuts,
		resetToDefaults,
		isInherited,
		displaced: keyboardMode === 'vim' ? vimDisplaced : NO_DISPLACED,
	};
}
