/**
 * Tests for the display resolver: the lookup every surface that DRAWS a chord
 * goes through.
 *
 * The invariant worth protecting is that display and behavior read the same
 * table. A resolver that quietly fell back to another map, or to the default
 * tables, would put a chord on screen that fires something else - which is the
 * exact failure the Vim mode work exists to fix.
 */

import { describe, it, expect } from 'vitest';
import {
	resolveShortcutKeys,
	UNBOUND_SHORTCUT,
	type ShortcutDisplayMaps,
} from '../../../renderer/utils/shortcutResolve';
import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	TAB_SHORTCUTS,
} from '../../../renderer/constants/shortcuts';
import { VIM_SHORTCUTS, VIM_TAB_SHORTCUTS } from '../../../renderer/constants/vimShortcuts';
import { resolveEffectiveShortcuts } from '../../../shared/effectiveShortcuts';
import type { Shortcut } from '../../../shared/shortcut-types';

const DEFAULT_MAPS: ShortcutDisplayMaps = {
	shortcuts: DEFAULT_SHORTCUTS,
	tabShortcuts: TAB_SHORTCUTS,
};

const VIM_EFFECTIVE = resolveEffectiveShortcuts(
	{ shortcuts: DEFAULT_SHORTCUTS, tabShortcuts: TAB_SHORTCUTS },
	{ vimShortcuts: VIM_SHORTCUTS, vimTabShortcuts: VIM_TAB_SHORTCUTS }
);

const VIM_MAPS: ShortcutDisplayMaps = {
	shortcuts: VIM_EFFECTIVE.shortcuts,
	tabShortcuts: VIM_EFFECTIVE.tabShortcuts,
};

/** A map of one entry, for the precedence cases. */
function mapOf(shortcut: Shortcut): Record<string, Shortcut> {
	return { [shortcut.id]: shortcut };
}

describe('resolveShortcutKeys', () => {
	it('answers with the live mode chord, which differs between the two modes', () => {
		// The phase's worked example: default mode puts History on Cmd+Shift+H,
		// and Vim mode gives that chord to region focus and moves History.
		expect(resolveShortcutKeys('goToHistory', DEFAULT_MAPS).keys).toEqual(['Meta', 'Shift', 'h']);
		expect(resolveShortcutKeys('goToHistory', VIM_MAPS).keys).toEqual([
			'Ctrl',
			'Alt',
			'Shift',
			'h',
		]);
	});

	it('answers with the inherited default chord for an action a mode does not override', () => {
		const id = 'settings';
		expect(VIM_SHORTCUTS[id]).toBeUndefined();
		expect(resolveShortcutKeys(id, VIM_MAPS).keys).toEqual(DEFAULT_SHORTCUTS[id].keys);
	});

	it('carries the sequence beside the chord, because both triggers fire', () => {
		// goToTab1 keeps its chord in Vim mode AND gains `g g`.
		const resolved = resolveShortcutKeys('goToTab1', VIM_MAPS);
		expect(resolved.sequence).toEqual([['g'], ['g']]);
		expect(resolved.keys.length).toBeGreaterThan(0);
	});

	it('leaves the sequence absent in a mode that does not bind one', () => {
		expect(resolveShortcutKeys('goToTab1', DEFAULT_MAPS).sequence).toBeUndefined();
	});

	it('reads a FIXED_SHORTCUTS action, which no mode or user rebinds', () => {
		expect(resolveShortcutKeys('fontSizeIncrease', DEFAULT_MAPS).keys).toEqual(
			FIXED_SHORTCUTS.fontSizeIncrease.keys
		);
		expect(resolveShortcutKeys('fontSizeIncrease', VIM_MAPS).keys).toEqual(
			FIXED_SHORTCUTS.fontSizeIncrease.keys
		);
	});

	it('prefers the tab table over the global one, like isTabShortcut', () => {
		const resolved = resolveShortcutKeys('dupe', {
			shortcuts: mapOf({ id: 'dupe', label: 'Dupe', keys: ['Meta', 'g'] }),
			tabShortcuts: mapOf({ id: 'dupe', label: 'Dupe', keys: ['Meta', 't'] }),
		});
		expect(resolved.keys).toEqual(['Meta', 't']);
	});

	it('prefers the fixed table, so reading through here matches the merged map', () => {
		const resolved = resolveShortcutKeys('dupe', {
			shortcuts: mapOf({ id: 'dupe', label: 'Dupe', keys: ['Meta', 'g'] }),
			tabShortcuts: mapOf({ id: 'dupe', label: 'Dupe', keys: ['Meta', 't'] }),
			fixedShortcuts: mapOf({ id: 'dupe', label: 'Dupe', keys: ['Meta', 'f'] }),
		});
		expect(resolved.keys).toEqual(['Meta', 'f']);
	});

	describe('an action with nothing to draw', () => {
		it('resolves an unknown id to the shared unbound answer', () => {
			expect(resolveShortcutKeys('noSuchAction', DEFAULT_MAPS)).toBe(UNBOUND_SHORTCUT);
			expect(UNBOUND_SHORTCUT.keys).toEqual([]);
			expect(UNBOUND_SHORTCUT.sequence).toBeUndefined();
		});

		it('resolves a missing id to the unbound answer, so a hook can run unconditionally', () => {
			expect(resolveShortcutKeys(undefined, DEFAULT_MAPS)).toBe(UNBOUND_SHORTCUT);
		});

		it('resolves an action the user cleared to unbound, not to another table chord', () => {
			// `keys: []` is a registered-but-unassigned action. Falling through
			// to the next table would draw a chord that fires nothing.
			const resolved = resolveShortcutKeys('dupe', {
				shortcuts: mapOf({ id: 'dupe', label: 'Dupe', keys: ['Meta', 'g'] }),
				tabShortcuts: mapOf({ id: 'dupe', label: 'Dupe', keys: [] }),
			});
			expect(resolved).toBe(UNBOUND_SHORTCUT);
		});

		it('resolves a displaced action to unbound', () => {
			// A mode override that takes a chord another action inherits leaves
			// that action unbound until the user records one of its own, and the
			// chord it used to wear now fires something else. The shipped Vim
			// table displaces nothing (it rebinds every collision explicitly),
			// so the state is built here rather than borrowed from it.
			const base = {
				shortcuts: {
					loser: { id: 'loser', label: 'Loser', keys: ['Meta', 'Shift', 'k'] },
					winner: { id: 'winner', label: 'Winner', keys: ['Alt', 'Meta', 'o'] },
				},
				tabShortcuts: {},
			};
			const effective = resolveEffectiveShortcuts(base, {
				vimShortcuts: {
					winner: { id: 'winner', label: 'Winner', keys: ['Meta', 'Shift', 'k'] },
				},
				vimTabShortcuts: {},
			});
			expect(effective.displaced).toContain('loser');

			const maps = { shortcuts: effective.shortcuts, tabShortcuts: effective.tabShortcuts };
			expect(resolveShortcutKeys('loser', maps)).toBe(UNBOUND_SHORTCUT);
			expect(resolveShortcutKeys('winner', maps).keys).toEqual(['Meta', 'Shift', 'k']);
		});

		it('keeps a sequence-only action bound', () => {
			// A sequence is a trigger on its own terms, so an action with no
			// chord but a `g g` still has something to draw.
			const resolved = resolveShortcutKeys('dupe', {
				shortcuts: mapOf({ id: 'dupe', label: 'Dupe', keys: [], sequence: [['g'], ['g']] }),
				tabShortcuts: {},
			});
			expect(resolved.keys).toEqual([]);
			expect(resolved.sequence).toEqual([['g'], ['g']]);
		});

		it('treats an empty sequence as none, so a caller never prints a gap', () => {
			const resolved = resolveShortcutKeys('dupe', {
				shortcuts: mapOf({ id: 'dupe', label: 'Dupe', keys: ['Meta', 'g'], sequence: [] }),
				tabShortcuts: {},
			});
			expect(resolved.sequence).toBeUndefined();
		});
	});

	it('passes the key arrays through by reference, so a consumer memo survives', () => {
		const first = resolveShortcutKeys('goToHistory', DEFAULT_MAPS);
		const second = resolveShortcutKeys('goToHistory', DEFAULT_MAPS);
		expect(first.keys).toBe(second.keys);
	});
});
