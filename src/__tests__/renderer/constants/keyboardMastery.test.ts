import { describe, it, expect } from 'vitest';
import {
	collectBoundShortcuts,
	collectBoundShortcutsAcrossModes,
	countUsedBoundShortcuts,
} from '../../../renderer/constants/keyboardMastery';
import type { Shortcut } from '../../../renderer/types';

function shortcut(id: string, keys: string[], sequence?: string[][]): Shortcut {
	return {
		id,
		label: id,
		keys,
		category: 'general',
		...(sequence ? { sequence } : {}),
	} as Shortcut;
}

describe('collectBoundShortcuts', () => {
	it('drops shortcuts with no chord bound', () => {
		const bound = collectBoundShortcuts({
			a: shortcut('a', ['Meta', 'A']),
			b: shortcut('b', []),
		});
		expect(bound.map((s) => s.id)).toEqual(['a']);
	});

	it('lets a later map override an earlier one by id', () => {
		const bound = collectBoundShortcuts(
			{ a: shortcut('a', ['Meta', 'A']) },
			{ a: shortcut('a', []) }
		);
		expect(bound).toEqual([]);
	});

	it('ignores undefined maps', () => {
		const bound = collectBoundShortcuts(undefined, { a: shortcut('a', ['Meta', 'A']) });
		expect(bound.map((s) => s.id)).toEqual(['a']);
	});
});

/**
 * The cross-mode denominator.
 *
 * Mastery is one count across keyboard modes, so what is being pinned here is
 * membership: every action the user could fire in ANY mode, once, whatever
 * order the modes are passed in and whichever mode is live. The two properties
 * that separate this from `collectBoundShortcuts` above are the two the
 * per-mode version gets wrong - a later map must not be able to REMOVE an id,
 * and a sequence counts as bound - and both have a test of their own that fails
 * if the function is reverted to the merge-then-filter shape.
 */
describe('collectBoundShortcutsAcrossModes', () => {
	const ids = (bound: Shortcut[]) => bound.map((s) => s.id).sort();

	it('unions the actions bound in either mode, counting one bound in both once', () => {
		const defaultMode = {
			chordInDefault: shortcut('chordInDefault', ['Meta', 'a']),
			inBoth: shortcut('inBoth', ['Meta', 'b']),
		};
		const vimMode = {
			inBoth: shortcut('inBoth', ['Ctrl', 'b']),
			chordInVim: shortcut('chordInVim', ['Ctrl', 'c']),
		};

		expect(ids(collectBoundShortcutsAcrossModes(defaultMode, vimMode))).toEqual([
			'chordInDefault',
			'chordInVim',
			'inBoth',
		]);
	});

	it('keeps an id a later map leaves unbound, where collectBoundShortcuts drops it', () => {
		const bound = { a: shortcut('a', ['Meta', 'a']) };
		const cleared = { a: shortcut('a', []) };

		// The whole difference between the two functions: a mode where the user
		// cleared the binding must not delete the action from a total the OTHER
		// mode still binds it in.
		expect(ids(collectBoundShortcutsAcrossModes(bound, cleared))).toEqual(['a']);
		expect(collectBoundShortcuts(bound, cleared)).toEqual([]);
	});

	it('lets a later map bind an id an earlier one left unbound', () => {
		const cleared = { a: shortcut('a', []) };
		const bound = { a: shortcut('a', ['Ctrl', 'a']) };

		// The mirror of the test above, and the reason the loop skips an unbound
		// entry instead of claiming the id for it: an action only Vim mode binds
		// has to join the total even though default mode is read first.
		const result = collectBoundShortcutsAcrossModes(cleared, bound);
		expect(ids(result)).toEqual(['a']);
		expect(result[0].keys).toEqual(['Ctrl', 'a']);
	});

	it('cannot lose an id to argument order', () => {
		const defaultMode = {
			a: shortcut('a', ['Meta', 'a']),
			b: shortcut('b', []),
		};
		const vimMode = {
			a: shortcut('a', []),
			b: shortcut('b', [], [['g'], ['b']]),
		};

		// Membership is mode-independent, so the live mode can be passed first
		// (which is how a caller gets the entry it should RENDER) without that
		// choice changing who is in the total.
		expect(ids(collectBoundShortcutsAcrossModes(defaultMode, vimMode))).toEqual(['a', 'b']);
		expect(ids(collectBoundShortcutsAcrossModes(vimMode, defaultMode))).toEqual(['a', 'b']);
	});

	it('counts an action bound only by a key sequence', () => {
		// No chord, but `g g` fires it, so it is as reachable as any chord.
		// Leaving it out would pin the user below 100% exactly as an unbound
		// action does.
		const bound = collectBoundShortcutsAcrossModes({
			gotoTop: shortcut('gotoTop', [], [['g'], ['g']]),
		});
		expect(ids(bound)).toEqual(['gotoTop']);
	});

	it('drops an action with neither a chord nor a sequence', () => {
		// Three spellings of unbound: no chord, a cleared sequence, and both.
		expect(
			collectBoundShortcutsAcrossModes({
				noChord: shortcut('noChord', []),
				clearedSequence: shortcut('clearedSequence', [], []),
			})
		).toEqual([]);
	});

	it('takes the entry from the FIRST map that binds the id', () => {
		const live = { a: shortcut('a', ['Ctrl', 'a']) };
		const other = { a: shortcut('a', ['Meta', 'a']) };

		// Which entry represents an id is what a surface rendering these shows
		// (the Usage Dashboard lists the ones the user has not fired yet), so
		// the caller puts the LIVE mode's maps first and gets the chord the user
		// would press right now.
		expect(collectBoundShortcutsAcrossModes(live, other)[0].keys).toEqual(['Ctrl', 'a']);
		expect(collectBoundShortcutsAcrossModes(other, live)[0].keys).toEqual(['Meta', 'a']);
	});

	it('ignores undefined maps', () => {
		const bound = collectBoundShortcutsAcrossModes(undefined, { a: shortcut('a', ['Meta', 'a']) });
		expect(ids(bound)).toEqual(['a']);
	});
});

describe('countUsedBoundShortcuts', () => {
	const bound = [shortcut('a', ['Meta', 'A']), shortcut('b', ['Meta', 'B'])];

	it('counts only the used ones', () => {
		expect(countUsedBoundShortcuts(bound, ['a'])).toBe(1);
	});

	it('ignores used ids that are no longer bound, so it cannot exceed the total', () => {
		expect(countUsedBoundShortcuts(bound, ['a', 'b', 'retired', 'unbound'])).toBe(2);
	});

	it('cannot pass 100% of the cross-mode total', () => {
		// The pair as the app composes it: this numerator over that denominator.
		// `usedShortcuts` keeps ids whose binding was later cleared and ids of
		// retired actions, and in a mode where an action is unbound it is still
		// in the denominator because the other mode binds it - so the one thing
		// that must hold is that no combination of leftovers pushes the ratio
		// past 1.
		const crossMode = collectBoundShortcutsAcrossModes(
			{ a: shortcut('a', ['Meta', 'a']), unbound: shortcut('unbound', []) },
			{ a: shortcut('a', []), b: shortcut('b', [], [['g'], ['b']]) }
		);
		const used = ['a', 'b', 'unbound', 'retired'];

		expect(countUsedBoundShortcuts(crossMode, used)).toBe(crossMode.length);
		expect((countUsedBoundShortcuts(crossMode, used) / crossMode.length) * 100).toBe(100);
	});

	it('switching keyboard mode changes the displayed chord of an unused action but not the count', () => {
		// Default mode and Vim mode each bind the same action differently, but both
		// count it toward mastery. The cross-mode denominator stays constant, and a
		// surface showing "unused shortcuts" displays the chord from the live mode.
		const defaultMode = {
			history: shortcut('history', ['Meta', 'Shift', 'H']),
		};
		const vimMode = {
			history: shortcut('history', ['Ctrl', 'Alt', 'Shift', 'H']),
		};

		// In default mode, history shows Meta+Shift+H as its chord
		const boundInDefault = collectBoundShortcutsAcrossModes(defaultMode, vimMode);
		expect(boundInDefault).toHaveLength(1);
		expect(boundInDefault[0].id).toBe('history');
		expect(boundInDefault[0].keys).toEqual(['Meta', 'Shift', 'H']);
		const defaultCount = boundInDefault.length;
		const defaultUsed = countUsedBoundShortcuts(boundInDefault, []);

		// In vim mode, the same action is in the denominator but shows Ctrl+Alt+Shift+H
		const boundInVim = collectBoundShortcutsAcrossModes(vimMode, defaultMode);
		expect(boundInVim).toHaveLength(1);
		expect(boundInVim[0].id).toBe('history');
		expect(boundInVim[0].keys).toEqual(['Ctrl', 'Alt', 'Shift', 'H']);
		const vimCount = boundInVim.length;
		const vimUsed = countUsedBoundShortcuts(boundInVim, []);

		// The counts (denominator and numerator) must stay the same when switching modes
		expect(vimCount).toBe(defaultCount);
		expect(vimUsed).toBe(defaultUsed);
		// The displayed chord must change with the mode
		expect(boundInVim[0].keys).not.toEqual(boundInDefault[0].keys);
	});
});
