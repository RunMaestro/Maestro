/**
 * Tests for the effective-set resolver, the module that turns "default buckets
 * plus a sparse override table" into the one pair of maps a keyboard mode is
 * matched against.
 *
 * Three invariants are what these cover, because each one is silent when it
 * breaks:
 *
 *  - Nothing becomes unreachable. An action the override table does not mention
 *    keeps its default chord, so switching modes cannot unbind it.
 *  - One chord, one action. When an override takes a chord another action
 *    inherits, the override wins and the other action is reported as displaced
 *    rather than left fighting for the same keypress.
 *  - A user's edit is not shadowed. An override id is looked up in the bucket
 *    that mirrors the base map declaring it FIRST, which is where Settings >
 *    Shortcuts writes the edit, and only then in the other bucket where a
 *    shipped entry may sit.
 *  - The two triggers are independent. An action carries a chord and a key
 *    sequence, both of which fire, and overriding one must never take away the
 *    other. This is the silent one: a Vim table that adds `g g` to an action
 *    would quietly unbind the chord it already answered to, and nothing on
 *    screen would explain it.
 *
 * Store wiring (the selectors, the round trip across a mode switch) is covered
 * in `src/__tests__/renderer/stores/keyboardMode.test.ts`; this file is the
 * pure module on its own.
 */

import { describe, it, expect } from 'vitest';
import {
	resolveEffectiveShortcuts,
	overridesWithEdits,
	isOverrideInherited,
} from '../../shared/effectiveShortcuts';
import type { Shortcut, ShortcutOverride } from '../../shared/shortcut-types';

const sc = (id: string, label: string, keys: string[]): Shortcut => ({ id, label, keys });
const ov = (id: string, label: string, keys?: string[]): ShortcutOverride => ({ id, label, keys });

/** An override that binds only a key sequence, leaving the chord inherited. */
const seqOv = (id: string, label: string, sequence?: string[][]): ShortcutOverride => ({
	id,
	label,
	sequence,
});

/** A base pair shaped like the real one: a tab action declared in each map. */
function baseMaps() {
	return {
		shortcuts: {
			prevTab: sc('prevTab', 'Previous Tab', ['Alt', 'Meta', 'ArrowLeft']),
			nextTab: sc('nextTab', 'Next Tab', ['Alt', 'Meta', 'ArrowRight']),
			openSettings: sc('openSettings', 'Open Settings', ['Meta', ',']),
			openLeaderboard: sc('openLeaderboard', 'Leaderboard', []),
		} as Record<string, Shortcut>,
		tabShortcuts: {
			newTab: sc('newTab', 'New Tab', ['Meta', 't']),
			closeTab: sc('closeTab', 'Close Tab', ['Meta', 'w']),
		} as Record<string, Shortcut>,
	};
}

const noOverrides = { vimShortcuts: {}, vimTabShortcuts: {} };

describe('resolveEffectiveShortcuts', () => {
	it('inherits every base chord when the override tables are empty', () => {
		const base = baseMaps();
		const result = resolveEffectiveShortcuts(base, noOverrides);

		expect(Object.keys(result.shortcuts)).toEqual(Object.keys(base.shortcuts));
		expect(Object.keys(result.tabShortcuts)).toEqual(Object.keys(base.tabShortcuts));
		expect(result.shortcuts.prevTab.keys).toEqual(['Alt', 'Meta', 'ArrowLeft']);
		expect(result.displaced).toEqual([]);
		// Nothing changed, so the maps are handed straight back: the store
		// selectors compare by identity and a fresh map would re-render every
		// keyboard consumer on any settings change.
		expect(result.shortcuts).toBe(base.shortcuts);
		expect(result.tabShortcuts).toBe(base.tabShortcuts);
	});

	it('applies a tab-table override to the base map that DECLARES the action', () => {
		// The shipped shape: prevTab / nextTab are overridden in the tab table
		// because isTabShortcut is what matches them, but DEFAULT_SHORTCUTS is
		// where they are declared.
		const base = baseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: {},
			vimTabShortcuts: { prevTab: ov('prevTab', 'Previous Tab', ['Ctrl', 'PageUp']) },
		});

		expect(result.shortcuts.prevTab.keys).toEqual(['Ctrl', 'PageUp']);
		// Not invented in the tab map: the Shortcuts tab renders the two maps as
		// separate sections, so an id in both would be listed twice with two
		// different chords.
		expect(result.tabShortcuts.prevTab).toBeUndefined();
		expect(result.tabShortcuts).toBe(base.tabShortcuts);
		expect(result.displaced).toEqual([]);
	});

	it('applies a general-table override to a tab-declared action', () => {
		const base = baseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { newTab: ov('newTab', 'New Tab', ['Ctrl', 'n']) },
			vimTabShortcuts: {},
		});

		expect(result.tabShortcuts.newTab.keys).toEqual(['Ctrl', 'n']);
		expect(result.shortcuts.newTab).toBeUndefined();
	});

	it('prefers the bucket mirroring the declaring base map, so an edit is not shadowed', () => {
		// A user re-binds Previous Tab in the Shortcuts tab. It is listed in the
		// General section (DEFAULT_SHORTCUTS declares it), so the edit lands in
		// vimShortcuts while the SHIPPED chord still sits in vimTabShortcuts.
		// Reading the tab bucket first would make the recording a no-op.
		const base = baseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { prevTab: ov('prevTab', 'Previous Tab', ['Ctrl', 'k']) },
			vimTabShortcuts: { prevTab: ov('prevTab', 'Previous Tab', ['Ctrl', 'PageUp']) },
		});

		expect(result.shortcuts.prevTab.keys).toEqual(['Ctrl', 'k']);
	});

	it('prefers the tab bucket for a tab-declared action', () => {
		const base = baseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { newTab: ov('newTab', 'New Tab', ['Ctrl', 'x']) },
			vimTabShortcuts: { newTab: ov('newTab', 'New Tab', ['Ctrl', 'n']) },
		});

		expect(result.tabShortcuts.newTab.keys).toEqual(['Ctrl', 'n']);
	});

	it('treats an override with no keys as "inherit"', () => {
		const base = baseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { openSettings: ov('openSettings', 'Open Settings') },
			vimTabShortcuts: {},
		});

		expect(result.shortcuts.openSettings.keys).toEqual(['Meta', ',']);
		expect(result.shortcuts).toBe(base.shortcuts);
	});

	it('falls back to the other bucket when the preferred entry only says "inherit"', () => {
		const base = baseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { prevTab: ov('prevTab', 'Previous Tab') },
			vimTabShortcuts: { prevTab: ov('prevTab', 'Previous Tab', ['Ctrl', 'PageUp']) },
		});

		expect(result.shortcuts.prevTab.keys).toEqual(['Ctrl', 'PageUp']);
	});

	it('honors an override of keys: [] as "cleared in this mode"', () => {
		// The preferred bucket's empty chord beats a chord in the other bucket:
		// the user cleared it here on purpose.
		const base = baseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { prevTab: ov('prevTab', 'Previous Tab', []) },
			vimTabShortcuts: { prevTab: ov('prevTab', 'Previous Tab', ['Ctrl', 'PageUp']) },
		});

		expect(result.shortcuts.prevTab.keys).toEqual([]);
		// An empty chord takes no keypress, so it displaces nothing.
		expect(result.displaced).toEqual([]);
	});

	it('ignores an override id no base map declares', () => {
		const base = baseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { retiredAction: ov('retiredAction', 'Retired', ['Meta', ',']) },
			vimTabShortcuts: {},
		});

		expect(result.shortcuts.retiredAction).toBeUndefined();
		// And its chord does not displace the live action that holds it.
		expect(result.shortcuts.openSettings.keys).toEqual(['Meta', ',']);
		expect(result.displaced).toEqual([]);
	});

	it('displaces an inherited chord an override takes, and unbinds it', () => {
		const base = baseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: {},
			vimTabShortcuts: { prevTab: ov('prevTab', 'Previous Tab', ['Meta', ',']) },
		});

		expect(result.shortcuts.prevTab.keys).toEqual(['Meta', ',']);
		expect(result.shortcuts.openSettings.keys).toEqual([]);
		expect(result.displaced).toEqual(['openSettings']);
	});

	it('displaces across the Meta / Ctrl collapse', () => {
		// ['Ctrl', 't'] and ['Meta', 't'] are one binding at runtime, so an
		// override spelled with Ctrl still takes the Meta chord's keypress.
		const base = baseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { openSettings: ov('openSettings', 'Open Settings', ['Ctrl', 't']) },
			vimTabShortcuts: {},
		});

		expect(result.tabShortcuts.newTab.keys).toEqual([]);
		expect(result.displaced).toEqual(['newTab']);
	});

	it('displaces an action in each map, in declaration order', () => {
		const base = baseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: {
				prevTab: ov('prevTab', 'Previous Tab', ['Meta', 'w']),
				nextTab: ov('nextTab', 'Next Tab', ['Meta', ',']),
			},
			vimTabShortcuts: {},
		});

		expect(result.displaced).toEqual(['openSettings', 'closeTab']);
	});

	it('never displaces an unassigned action', () => {
		// `keys: []` is "registered but unassigned" and collides with nothing, so
		// an empty default must not be reported as needing a chord in this mode.
		const base = baseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { openSettings: ov('openSettings', 'Open Settings', ['Ctrl', 'g']) },
			vimTabShortcuts: {},
		});

		expect(result.displaced).toEqual([]);
		expect(result.shortcuts.openLeaderboard.keys).toEqual([]);
	});

	it('keeps the identity of every entry it does not change', () => {
		const base = baseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: {},
			vimTabShortcuts: { prevTab: ov('prevTab', 'Previous Tab', ['Ctrl', 'PageUp']) },
		});

		expect(result.shortcuts.openSettings).toBe(base.shortcuts.openSettings);
		expect(result.shortcuts.prevTab).not.toBe(base.shortcuts.prevTab);
		// The base entry is not mutated on the way through.
		expect(base.shortcuts.prevTab.keys).toEqual(['Alt', 'Meta', 'ArrowLeft']);
	});

	it('returns the same empty displaced array every time', () => {
		const base = baseMaps();
		const first = resolveEffectiveShortcuts(base, noOverrides);
		const second = resolveEffectiveShortcuts(baseMaps(), noOverrides);
		expect(first.displaced).toBe(second.displaced);
	});
});

describe('resolveEffectiveShortcuts with key sequences', () => {
	/**
	 * A base pair where one action already carries a sequence, so inheritance
	 * of the sequence can be told apart from inheritance of the chord.
	 *
	 * Separate from `baseMaps()` rather than folded into it: the displacement
	 * tests assert exact `displaced` arrays against that fixture, and a new
	 * action in it would make those assertions depend on this file's ordering.
	 */
	function seqBaseMaps() {
		const base = baseMaps();
		base.shortcuts.focusAgents = {
			id: 'focusAgents',
			label: 'Focus Agents',
			keys: ['Meta', '1'],
			sequence: [['g'], ['a']],
		};
		return base;
	}

	it('applies a sequence override without touching the inherited chord', () => {
		const base = seqBaseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { openSettings: seqOv('openSettings', 'Open Settings', [['g'], ['s']]) },
			vimTabShortcuts: {},
		});

		expect(result.shortcuts.openSettings.sequence).toEqual([['g'], ['s']]);
		// The whole point: adding `g s` did not cost the action its chord.
		expect(result.shortcuts.openSettings.keys).toEqual(['Meta', ',']);
	});

	it('applies a chord override without dropping the inherited sequence', () => {
		const base = seqBaseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { focusAgents: ov('focusAgents', 'Focus Agents', ['Ctrl', '1']) },
			vimTabShortcuts: {},
		});

		expect(result.shortcuts.focusAgents.keys).toEqual(['Ctrl', '1']);
		expect(result.shortcuts.focusAgents.sequence).toEqual([['g'], ['a']]);
	});

	it('applies both fields from one override entry', () => {
		const base = seqBaseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: {
				openSettings: {
					id: 'openSettings',
					label: 'Open Settings',
					keys: ['Ctrl', 'g'],
					sequence: [['g'], ['s']],
				},
			},
			vimTabShortcuts: {},
		});

		expect(result.shortcuts.openSettings.keys).toEqual(['Ctrl', 'g']);
		expect(result.shortcuts.openSettings.sequence).toEqual([['g'], ['s']]);
	});

	it('replaces an inherited sequence rather than merging with it', () => {
		const base = seqBaseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { focusAgents: seqOv('focusAgents', 'Focus Agents', [['g'], ['g']]) },
			vimTabShortcuts: {},
		});

		expect(result.shortcuts.focusAgents.sequence).toEqual([['g'], ['g']]);
	});

	it('inherits the base sequence when the override omits it', () => {
		const base = seqBaseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { focusAgents: ov('focusAgents', 'Focus Agents', ['Ctrl', 'a']) },
			vimTabShortcuts: {},
		});

		expect(result.shortcuts.focusAgents.sequence).toEqual([['g'], ['a']]);
	});

	it('honors an override of sequence: [] as "cleared in this mode"', () => {
		const base = seqBaseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { focusAgents: seqOv('focusAgents', 'Focus Agents', []) },
			vimTabShortcuts: {},
		});

		expect(result.shortcuts.focusAgents.sequence).toEqual([]);
		// Clearing the sequence is not clearing the chord.
		expect(result.shortcuts.focusAgents.keys).toEqual(['Meta', '1']);
	});

	it('takes the sequence and the chord from different buckets independently', () => {
		// The bucket preference is per field. A user's sequence recording lands
		// in the bucket mirroring the declaring base map while a shipped chord
		// sits in the other one, and both have to survive.
		const base = seqBaseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { prevTab: seqOv('prevTab', 'Previous Tab', [['g'], ['h']]) },
			vimTabShortcuts: { prevTab: ov('prevTab', 'Previous Tab', ['Ctrl', 'PageUp']) },
		});

		expect(result.shortcuts.prevTab.sequence).toEqual([['g'], ['h']]);
		expect(result.shortcuts.prevTab.keys).toEqual(['Ctrl', 'PageUp']);
	});

	it('falls back to the other bucket for the sequence alone', () => {
		const base = seqBaseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { newTab: ov('newTab', 'New Tab', ['Ctrl', 'x']) },
			vimTabShortcuts: { newTab: seqOv('newTab', 'New Tab', [['g'], ['n']]) },
		});

		// The tab bucket is preferred for a tab-declared action, and it only
		// speaks to the sequence, so the chord comes from the general bucket.
		expect(result.tabShortcuts.newTab.sequence).toEqual([['g'], ['n']]);
		expect(result.tabShortcuts.newTab.keys).toEqual(['Ctrl', 'x']);
	});

	it('leaves a sequence-only override out of the chord displacement check', () => {
		// A sequence carries no Meta / Ctrl / Alt, so it can never take a
		// chord's keypress. Nothing is displaced by one.
		const base = seqBaseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { prevTab: seqOv('prevTab', 'Previous Tab', [['g'], ['g']]) },
			vimTabShortcuts: {},
		});

		expect(result.displaced).toEqual([]);
		expect(result.shortcuts.openSettings.keys).toEqual(['Meta', ',']);
		expect(result.shortcuts.prevTab.keys).toEqual(['Alt', 'Meta', 'ArrowLeft']);
	});

	it('still displaces a chord on an action that also gains a sequence', () => {
		// The sequence is applied after the chord branch, so it must not shield
		// the action from losing an inherited chord an override took.
		const base = seqBaseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: {
				prevTab: ov('prevTab', 'Previous Tab', ['Meta', ',']),
				openSettings: seqOv('openSettings', 'Open Settings', [['g'], ['s']]),
			},
			vimTabShortcuts: {},
		});

		expect(result.shortcuts.openSettings.keys).toEqual([]);
		expect(result.shortcuts.openSettings.sequence).toEqual([['g'], ['s']]);
		expect(result.displaced).toEqual(['openSettings']);
	});

	it('keeps map and entry identity when no override speaks to either field', () => {
		const base = seqBaseMaps();
		const result = resolveEffectiveShortcuts(base, noOverrides);

		expect(result.shortcuts).toBe(base.shortcuts);
		expect(result.shortcuts.focusAgents).toBe(base.shortcuts.focusAgents);
	});

	it('keeps the identity of entries a sequence override does not touch', () => {
		const base = seqBaseMaps();
		const result = resolveEffectiveShortcuts(base, {
			vimShortcuts: { openSettings: seqOv('openSettings', 'Open Settings', [['g'], ['s']]) },
			vimTabShortcuts: {},
		});

		expect(result.shortcuts.focusAgents).toBe(base.shortcuts.focusAgents);
		expect(result.shortcuts.openSettings).not.toBe(base.shortcuts.openSettings);
		// And the base entry is not mutated on the way through.
		expect(base.shortcuts.openSettings.sequence).toBeUndefined();
	});
});

describe('overridesWithEdits', () => {
	const before = baseMaps().shortcuts;

	it('writes only the row that changed', () => {
		const next = { ...before, openSettings: sc('openSettings', 'Open Settings', ['Ctrl', 'g']) };
		const result = overridesWithEdits({}, before, next);

		expect(result).toEqual({
			openSettings: { id: 'openSettings', label: 'Open Settings', keys: ['Ctrl', 'g'] },
		});
	});

	it('returns the bucket unchanged when nothing differs', () => {
		const current = { prevTab: ov('prevTab', 'Previous Tab', ['Ctrl', 'PageUp']) };
		expect(overridesWithEdits(current, before, { ...before })).toBe(current);
	});

	it('does not write a chord recorded in another order', () => {
		const current: Record<string, ShortcutOverride> = {};
		const next = {
			...before,
			prevTab: sc('prevTab', 'Previous Tab', ['Meta', 'ArrowLeft', 'Alt']),
		};
		expect(overridesWithEdits(current, before, next)).toBe(current);
	});

	it('writes a cleared binding as an explicit empty chord', () => {
		const result = overridesWithEdits({}, before, {
			...before,
			openSettings: sc('openSettings', 'Open Settings', []),
		});

		expect(result.openSettings.keys).toEqual([]);
	});

	it('does not write a clear on an already unassigned action', () => {
		const current: Record<string, ShortcutOverride> = {};
		const next = { ...before, openLeaderboard: sc('openLeaderboard', 'Leaderboard', []) };
		expect(overridesWithEdits(current, before, next)).toBe(current);
	});

	it('leaves the other overrides in the bucket alone', () => {
		const current = { nextTab: ov('nextTab', 'Next Tab', ['Ctrl', 'PageDown']) };
		const result = overridesWithEdits({ ...current }, before, {
			...before,
			prevTab: sc('prevTab', 'Previous Tab', ['Ctrl', 'PageUp']),
		});

		expect(result.nextTab).toEqual(current.nextTab);
		expect(result.prevTab.keys).toEqual(['Ctrl', 'PageUp']);
	});

	it("keeps the row's own sequence override when its chord is re-recorded", () => {
		// The row is rewritten, not patched, so the sequence the user recorded
		// in this mode has to be carried across or a chord edit unbinds it.
		const current = {
			openSettings: seqOv('openSettings', 'Open Settings', [['g'], ['s']]),
		};
		const result = overridesWithEdits({ ...current }, before, {
			...before,
			openSettings: sc('openSettings', 'Open Settings', ['Ctrl', 'g']),
		});

		expect(result.openSettings.keys).toEqual(['Ctrl', 'g']);
		expect(result.openSettings.sequence).toEqual([['g'], ['s']]);
	});

	it('copies the sequence rather than aliasing the steps it was handed', () => {
		const sequence = [['g'], ['s']];
		const result = overridesWithEdits(
			{ openSettings: seqOv('openSettings', 'Open Settings', sequence) },
			before,
			{ ...before, openSettings: sc('openSettings', 'Open Settings', ['Ctrl', 'g']) }
		);
		sequence.push(['x']);
		sequence[0].push('Shift');

		expect(result.openSettings.sequence).toEqual([['g'], ['s']]);
	});

	it('does not promote an INHERITED sequence into an explicit override', () => {
		// `next` is the effective map, where the sequence may have come from the
		// default tables. Writing it to the bucket would freeze it at that day's
		// default, the trap this function exists to avoid for chords.
		const shown: Record<string, Shortcut> = {
			...before,
			openSettings: {
				id: 'openSettings',
				label: 'Open Settings',
				keys: ['Meta', ','],
				sequence: [['g'], ['s']],
			},
		};
		const result = overridesWithEdits({}, shown, {
			...shown,
			openSettings: { ...shown.openSettings, keys: ['Ctrl', 'g'] },
		});

		expect(result.openSettings.keys).toEqual(['Ctrl', 'g']);
		expect(result.openSettings.sequence).toBeUndefined();
	});

	it('copies the chord rather than aliasing the array it was handed', () => {
		const keys = ['Ctrl', 'g'];
		const result = overridesWithEdits({}, before, {
			...before,
			openSettings: sc('openSettings', 'Open Settings', keys),
		});
		keys.push('Shift');

		expect(result.openSettings.keys).toEqual(['Ctrl', 'g']);
	});
});

describe('isOverrideInherited', () => {
	it('is true for an id neither bucket mentions', () => {
		expect(isOverrideInherited('openSettings', noOverrides)).toBe(true);
	});

	it('is true for an entry that omits keys, the explicit spelling of inherit', () => {
		expect(
			isOverrideInherited('openSettings', {
				vimShortcuts: { openSettings: ov('openSettings', 'Open Settings') },
				vimTabShortcuts: {},
			})
		).toBe(true);
	});

	it('is false for an entry with a chord, in either bucket', () => {
		expect(
			isOverrideInherited('prevTab', {
				vimShortcuts: {},
				vimTabShortcuts: { prevTab: ov('prevTab', 'Previous Tab', ['Ctrl', 'PageUp']) },
			})
		).toBe(false);
		expect(
			isOverrideInherited('prevTab', {
				vimShortcuts: { prevTab: ov('prevTab', 'Previous Tab', ['Ctrl', 'k']) },
				vimTabShortcuts: {},
			})
		).toBe(false);
	});

	it('is false for a binding the user cleared in this mode', () => {
		// `keys: []` is a choice, not an absence: the row has to read as
		// customized so the user can tell it apart from an inherited chord.
		expect(
			isOverrideInherited('openSettings', {
				vimShortcuts: { openSettings: ov('openSettings', 'Open Settings', []) },
				vimTabShortcuts: {},
			})
		).toBe(false);
	});
});
