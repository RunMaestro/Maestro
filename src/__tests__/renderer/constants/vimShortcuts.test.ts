/**
 * Vim mode's binding set, checked over the RESOLVED effective set.
 *
 * `constants/shortcuts.test.ts` owns the per-mode guards that run over every
 * mode in `KEYBOARD_MODES`, so a third mode is covered the day it is added, and
 * it owns the structural guards on the override TABLES (ids, labels, no
 * `FIXED_SHORTCUTS` id, no Escape). This file is the Vim-specific half, and
 * every test in it is computed over `effectiveActionsForMode('vim')` - the
 * override bucket resolved onto the default tables plus `FIXED_SHORTCUTS` -
 * because that is the set a keypress is actually matched against. Reading
 * `VIM_SHORTCUTS` alone cannot answer any of these:
 *
 *  - A chord that looks free in the override bucket can be one an INHERITED
 *    action already holds, and the override bucket is sparse, so most of the
 *    set is inherited.
 *  - A sequence-only override (`goToTab1`, `goToLastTab`) declares no chord at
 *    all, so a table-level chord check never looks at the chord those two
 *    actually answer to in this mode.
 *  - Reachability is a statement about what a mode INHERITS, which the tables
 *    say nothing about.
 *
 * Default mode is NOT part of the comparison, except where a test says so
 * explicitly. Exactly one mode is live at a time, so a Vim chord that default
 * mode gives to a different action is legal and is the whole point of the
 * override bucket; the only thing that has to answer for it is the displaced
 * action having a Vim chord of its own, which the block at the bottom pins.
 *
 * The base maps, the override buckets, their assembly, and the
 * shared-chord allowlist all come from `src/__tests__/helpers/shortcutModes.ts`,
 * so this file and the per-mode block in `shortcuts.test.ts` cannot disagree
 * about what Vim mode is or which collisions are legal.
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	TAB_SHORTCUTS,
} from '../../../renderer/constants/shortcuts';
import { VIM_SHORTCUTS, VIM_TAB_SHORTCUTS } from '../../../renderer/constants/vimShortcuts';
import {
	findReservedShortcutCombo,
	shortcutKeysCollide,
	shortcutKeysEqual,
	shortcutSequencesCollide,
	shortcutSequencesEqual,
} from '../../../shared/shortcutKeys';
import type { Shortcut } from '../../../shared/shortcut-types';
import {
	INTENTIONALLY_SHARED,
	effectiveActionsForMode,
	isIntentionallySharedByIds,
	shortcutIdSetKey,
} from '../../helpers/shortcutModes';

/** Every action Vim mode can fire, with the chord and sequence it fires on. */
const VIM_ACTIONS = effectiveActionsForMode('vim');
/** The same for default mode, for the two tests that compare the two modes. */
const DEFAULT_ACTIONS = effectiveActionsForMode('default');

const vimById = new Map(VIM_ACTIONS.map((sc) => [sc.id, sc]));
const defaultById = new Map(DEFAULT_ACTIONS.map((sc) => [sc.id, sc]));

/** Every chord the Vim tables declare, for the tests that ask what Vim TOOK. */
const DECLARED_VIM_CHORDS = [...Object.values(VIM_SHORTCUTS), ...Object.values(VIM_TAB_SHORTCUTS)]
	.filter((override) => override.keys?.length)
	.map((override) => ({ id: override.id, keys: override.keys as string[] }));

/**
 * Whether a chord is a BARE key: no Meta, no Ctrl, no Alt.
 *
 * Shift alone counts as bare, which is the matcher's own line rather than a
 * stylistic one. `SequenceMatcher.feed` clears the live prefix on any event
 * carrying Meta, Ctrl, or Alt and leaves it alone for Shift, so `Shift+G` is a
 * legal sequence step and `['Shift', 'g']` in `keys` would be a chord that
 * fires inside every text field in the app.
 */
function isBareChord(keys: readonly string[]): boolean {
	const lower = keys.map((k) => k.toLowerCase());
	return !lower.some((k) => ['meta', 'command', 'ctrl', 'control', 'alt', 'option'].includes(k));
}

/**
 * The actions whose CHORD Vim mode changed, inherited ones excluded.
 *
 * Derived rather than read off the override tables so it also catches an action
 * whose chord changed because something else took the one it inherits.
 */
const CHORDS_VIM_CHANGED = VIM_ACTIONS.filter(
	(sc) => !shortcutKeysEqual(sc.keys, defaultById.get(sc.id)?.keys ?? [])
);

/** A chord that reads back as a chord in a failure message, or `(unbound)`. */
function spell(keys: readonly string[] | undefined): string {
	return keys?.length ? keys.join('+') : '(unbound)';
}

/**
 * Reachability, the rule that makes a mode switch safe.
 *
 * Vim mode is an override BUCKET resolved onto the default tables, so the two
 * ways it can leave a user stranded are both silent. An override that takes a
 * chord another action inherits unbinds that action (the resolver reports it in
 * `displaced` and drops its chord), and an override that gives an action only a
 * `sequence` leaves it unreachable from every text field in the app, because
 * the sequence layer is gated on normal mode.
 */
describe('Vim mode reachability', () => {
	it('keeps a chord on every action default mode gives one', () => {
		const lost = DEFAULT_ACTIONS.filter((sc) => sc.keys.length > 0)
			.filter((sc) => !vimById.get(sc.id)?.keys.length)
			.map((sc) => `${sc.id} (${spell(sc.keys)} in default mode)`);

		expect(
			lost,
			'These actions answer to a chord in default mode and to nothing in Vim mode. A Vim override took the chord they inherit; give each one its own Vim chord and record it in the displacement table in vimShortcuts.ts.'
		).toEqual([]);
	});

	it('gives every sequence-bound action a chord too, since a sequence cannot fire from a text field', () => {
		const sequenceOnly = VIM_ACTIONS.filter((sc) => sc.sequence?.length)
			.filter((sc) => sc.keys.length === 0)
			.map((sc) => sc.id);

		expect(
			sequenceOnly,
			'A sequence only fires in normal mode (focus outside a text field, no layer open), so an action bound to one alone cannot be reached from the composer at all. The sequence is the convenience on top of a chord, never the whole binding.'
		).toEqual([]);
	});

	it('binds exactly the eleven actions this phase gives a normal-mode key', () => {
		// Vacuity guard with teeth. Every sequence test below passes trivially on an
		// empty set, and the whole point of Vim mode is that these particular
		// actions answer to a bare key. Spelled out rather than derived so that
		// LOSING one is a failure here, not a silently narrower test run.
		const sequenceBound = VIM_ACTIONS.filter((sc) => sc.sequence?.length)
			.map((sc) => sc.id)
			.sort();

		expect(sequenceBound).toEqual(
			[
				'focusRegionLeft',
				'focusRegionDown',
				'focusRegionUp',
				'focusRegionRight',
				'toggleZenMode',
				'prevTab',
				'nextTab',
				'moveTabLeft',
				'moveTabRight',
				'goToTab1',
				'goToLastTab',
			].sort()
		);
	});
});

/**
 * One chord, one action - inside Vim mode.
 *
 * Compared with `shortcutKeysCollide` rather than key equality, because Ctrl
 * and Cmd are ONE modifier to `eventMatchesShortcutKeys`: a Vim chord spelled
 * `['Ctrl', 'o']` fights an inherited `['Meta', 'o']` at runtime while reading
 * as a different chord on the page. Two actions on one keypress means the
 * earlier branch in `useMainKeyboardHandler` wins and the other silently never
 * fires.
 */
describe('Vim mode gives one chord to one action', () => {
	/** The effective set grouped by the keypress each chord answers to. */
	const groups: { keys: string[]; ids: string[] }[] = [];
	for (const sc of VIM_ACTIONS) {
		// An unassigned action claims no keypress and cannot collide.
		if (sc.keys.length === 0) continue;
		const group = groups.find((g) => shortcutKeysCollide(g.keys, sc.keys));
		if (group) group.ids.push(sc.id);
		else groups.push({ keys: sc.keys, ids: [sc.id] });
	}
	const sharing = groups.filter((g) => g.ids.length > 1);

	it('shares a chord only where the allowlist says why', () => {
		const unexplained = sharing
			.filter((g) => !isIntentionallySharedByIds(g.ids))
			.map((g) => `${spell(g.keys)} is claimed by: ${g.ids.join(', ')}`);

		expect(
			unexplained,
			'Two actions on one keypress in Vim mode. Either move one of them, or add the group to INTENTIONALLY_SHARED in src/__tests__/helpers/shortcutModes.ts with the scope that keeps them apart written down.'
		).toEqual([]);
	});

	it('moves a shared group together, never one member of it', () => {
		// The other direction, and the one no other test can see. A group on the
		// allowlist is exempt because its members can never be live at the same
		// moment, and `clearTerminal` / `toggleShowThinking` is the group this
		// phase MOVES: the region family took Cmd+Shift+K from both of them, and
		// both land on Ctrl+Alt+Shift+K. Splitting them onto two chords collides
		// with nothing and fails nothing else, while quietly turning one deliberate
		// context-scoped pair into two chords a user has to learn separately.
		//
		// Scoped to groups Vim mode actually rebinds: a group it leaves alone stays
		// together by inheritance, and saying so here would be asserting the
		// default tables.
		const rebound = new Set(DECLARED_VIM_CHORDS.map((chord) => chord.id));
		const split = INTENTIONALLY_SHARED.filter((group) => group.ids.some((id) => rebound.has(id)))
			.map((group) => ({
				group,
				chords: group.ids.map((id) => vimById.get(id)?.keys ?? []),
			}))
			.filter(({ chords }) => !chords.every((keys) => shortcutKeysCollide(keys, chords[0])))
			.map(
				({ group, chords }) =>
					`${group.chord} in default mode, split in Vim mode: ${group.ids
						.map((id, i) => `${id} -> ${spell(chords[i])}`)
						.join(', ')}`
			);

		expect(
			split,
			'These actions share one chord on purpose, gated by scope rather than by the chord. Vim mode moved some of them and not the rest, so the group is no longer a group.'
		).toEqual([]);
	});

	it('leaves the allowlist with no Vim-only entry to go stale', () => {
		// Every group that shares a chord in Vim mode is one the allowlist already
		// knows about from default mode. A group that only ever shares in Vim mode
		// would be an exemption with no shipped reason behind it.
		const sharingKeys = new Set(sharing.map((g) => shortcutIdSetKey(g.ids)));
		const vimOnly = INTENTIONALLY_SHARED.filter(
			(group) => !sharingKeys.has(shortcutIdSetKey(group.ids))
		).map((group) => group.chord);

		expect(vimOnly, 'allowlisted in default mode but not sharing a chord in Vim mode').toEqual([]);
	});
});

/**
 * The shape of a chord Vim mode resolves to.
 *
 * Over the resolved set rather than the tables, so an inherited chord is
 * covered too. `shortcuts.test.ts` checks the same three rules against the
 * override tables, where they fail closest to the edit that broke them; this is
 * the version that also sees what the mode inherits, which is most of it, and
 * the chords of the two sequence-only overrides, which declare none.
 */
describe('Vim mode chord shape', () => {
	it('binds no chord the OS or the app menu owns', () => {
		const offenders = VIM_ACTIONS.map((sc) => ({
			sc,
			reserved: findReservedShortcutCombo(sc.keys),
		}))
			.filter(({ reserved }) => reserved !== null)
			.map(({ sc, reserved }) => `${sc.id} (${spell(sc.keys)}): ${reserved?.reason}`);

		// A reserved chord does not conflict with anything - it simply never
		// reaches the renderer, which is the one failure a user cannot diagnose.
		// This is why the region family is Ctrl+Shift and not Ctrl: `['Ctrl', 'h']`
		// IS Cmd+H to the matcher, and the app menu's Hide item swallows it.
		expect(offenders).toEqual([]);
	});

	it('never combines a Ctrl-family key with Meta in a chord it changed', () => {
		// Scoped to the chords Vim mode CHANGED, because the one legitimate Ctrl+Cmd
		// shape is the pane-tiling family, which Vim mode inherits untouched and
		// which `isPaneShortcut` matches by requiring both physical keys held. Vim
		// mode taking that spelling is a different thing from the family having it:
		// deriving the exception from "did this mode change the chord" is what keeps
		// this test off a hand-written list of pane ids.
		const offenders = CHORDS_VIM_CHANGED.filter((sc) => {
			const lower = sc.keys.map((k) => k.toLowerCase());
			const hasMeta = lower.includes('meta') || lower.includes('command');
			const hasCtrl = lower.includes('ctrl') || lower.includes('control');
			return hasMeta && hasCtrl;
		}).map((sc) => `${sc.id} (${spell(sc.keys)})`);

		expect(
			offenders,
			'Ctrl and Cmd are one modifier to eventMatchesShortcutKeys, so a chord naming both is the pane-tiling spelling and is matched by a different function. Spell a Vim chord with Ctrl alone.'
		).toEqual([]);
	});

	it('binds no bare key through keys', () => {
		const offenders = VIM_ACTIONS.filter((sc) => sc.keys.length > 0)
			.filter((sc) => isBareChord(sc.keys))
			.map((sc) => `${sc.id} (${spell(sc.keys)})`);

		expect(
			offenders,
			'A `keys` binding fires wherever focus sits, so a bare key there types nothing and fires an action while the user is writing a prompt. Bare keys go in `sequence`, which is gated on normal mode.'
		).toEqual([]);
	});
});

/**
 * Sequences, which conflict by PREFIX rather than by equality.
 *
 * The matcher resolves ambiguity short: a step that both completes one sequence
 * and continues a longer one fires the completion immediately, because waiting
 * out `SEQUENCE_TIMEOUT_MS` to see whether more keys arrive would make the
 * shorter action feel broken for a full second on every press. So `h` bound
 * beside `h h` is not a race, it is a second binding that can never fire, and
 * the only place to catch it is here.
 */
describe('Vim mode sequences', () => {
	const bound = VIM_ACTIONS.filter((sc) => sc.sequence?.length);
	const spellSequence = (sc: Shortcut): string =>
		(sc.sequence ?? []).map((step) => step.join('+')).join(' ');

	it('shadows no other sequence', () => {
		const conflicts: string[] = [];
		for (let i = 0; i < bound.length; i++) {
			for (let j = i + 1; j < bound.length; j++) {
				if (!shortcutSequencesCollide(bound[i].sequence, bound[j].sequence)) continue;
				conflicts.push(
					`${bound[i].id} (${spellSequence(bound[i])}) vs ${bound[j].id} (${spellSequence(bound[j])})`
				);
			}
		}

		expect(
			conflicts,
			'One of these sequences is a prefix of the other, so the longer one can never fire. The near misses that are FINE all turn on Shift being part of a step: `g T` beside `g t`, and `G` beside `g g`.'
		).toEqual([]);
	});

	it('carries no Meta, Ctrl, or Alt in any step', () => {
		// The mirror of "no bare key in `keys`", and the same single rule: a
		// sequence step is matched only after `feed` has established the event
		// carries none of those three, so a step naming one is not merely odd, it
		// is unmatchable - the event that would complete it clears the prefix first.
		const offenders = bound
			.filter((sc) => (sc.sequence ?? []).some((step) => !isBareChord(step)))
			.map((sc) => `${sc.id} (${spellSequence(sc)})`);

		expect(offenders).toEqual([]);
	});

	it('spells no step empty, which would be a step the run can never pass', () => {
		// `eventMatchesShortcutKeys` never matches an empty chord, so a sequence
		// carrying an empty step is dead rather than conflicting - and
		// `shortcutSequencesCollide` returns false for it, so the prefix test above
		// reports it as free.
		const offenders = bound
			.filter((sc) => (sc.sequence ?? []).some((step) => step.length === 0))
			.map((sc) => sc.id);

		expect(offenders).toEqual([]);
	});
});

/**
 * The five actions the region family displaced, from both ends.
 *
 * This is rule 3 ("a displaced action always gets an explicit Vim chord") made
 * concrete, and it is the one place that checks a Vim chord against DEFAULT
 * mode on purpose. Each of these answers to Cmd+Shift+H/J/K/L in default mode,
 * which is the chord `focusRegion*` takes in Vim mode, so each one appears in a
 * Vim table on the same letter with Alt added. Both halves matter: the Vim
 * chord is what keeps the action reachable, and the default chord being
 * UNTOUCHED is what keeps the promise that switching to Vim mode and back
 * leaves default mode exactly as it was.
 */
describe('the actions the region family displaced', () => {
	const DISPLACED = [
		{ id: 'goToHistory', inDefault: ['Meta', 'Shift', 'h'], inVim: ['Ctrl', 'Alt', 'Shift', 'h'] },
		{ id: 'jumpToBottom', inDefault: ['Meta', 'Shift', 'j'], inVim: ['Ctrl', 'Alt', 'Shift', 'j'] },
		{
			id: 'clearTerminal',
			inDefault: ['Meta', 'Shift', 'k'],
			inVim: ['Ctrl', 'Alt', 'Shift', 'k'],
		},
		{
			id: 'toggleShowThinking',
			inDefault: ['Meta', 'Shift', 'k'],
			inVim: ['Ctrl', 'Alt', 'Shift', 'k'],
		},
		{
			id: 'agentSessions',
			inDefault: ['Meta', 'Shift', 'l'],
			inVim: ['Ctrl', 'Alt', 'Shift', 'l'],
		},
	];

	const CASES = DISPLACED.map((d) => ({ ...d, vim: spell(d.inVim), base: spell(d.inDefault) }));

	it.each(CASES)('$id answers to $vim in Vim mode', ({ id, inVim }) => {
		const keys = vimById.get(id)?.keys ?? [];
		expect(shortcutKeysEqual(keys, inVim), `${id} is on ${spell(keys)}`).toBe(true);
	});

	it.each(CASES)('$id still answers to $base in default mode', ({ id, inDefault }) => {
		const keys = defaultById.get(id)?.keys ?? [];
		expect(shortcutKeysEqual(keys, inDefault), `${id} is on ${spell(keys)}`).toBe(true);
	});

	it('names every action a Vim chord displaces, and no others', () => {
		// The table above is written by hand, which is what makes it readable and
		// what would let it go stale. Derived here from the constants: every action
		// holding a chord in the shipped tables that a Vim chord collides with.
		// A sixth one appearing is a displacement nobody recorded; one of these
		// five dropping out means the region family moved and the Alt-added chord
		// beside it is now just a chord.
		const tables: Record<string, Shortcut>[] = [
			DEFAULT_SHORTCUTS as Record<string, Shortcut>,
			TAB_SHORTCUTS as Record<string, Shortcut>,
			FIXED_SHORTCUTS as Record<string, Shortcut>,
		];
		const taken = new Set<string>();
		for (const table of tables) {
			for (const sc of Object.values(table)) {
				for (const chord of DECLARED_VIM_CHORDS) {
					// An action keeping its own chord in Vim mode displaces nothing.
					if (sc.id === chord.id) continue;
					if (shortcutKeysCollide(sc.keys, chord.keys)) taken.add(sc.id);
				}
			}
		}

		expect([...taken].sort()).toEqual(DISPLACED.map((d) => d.id).sort());
	});
});

/**
 * The h / j / k / l family, by direction.
 *
 * The mapping is Vim's own `<C-w>h/j/k/l`, not something read off the file
 * under test, so a letter wired to the wrong direction fails here. It is the
 * easiest mistake in the whole phase to make and the hardest to notice from a
 * passing test suite: every other test in this file is satisfied by four
 * distinct chords on four distinct actions, in any pairing at all.
 */
describe('the h / j / k / l family', () => {
	const DIRECTIONS = [
		{ letter: 'h', focus: 'focusRegionLeft', displaced: 'goToHistory' },
		{ letter: 'j', focus: 'focusRegionDown', displaced: 'jumpToBottom' },
		{ letter: 'k', focus: 'focusRegionUp', displaced: 'clearTerminal' },
		{ letter: 'l', focus: 'focusRegionRight', displaced: 'agentSessions' },
	];

	it.each(DIRECTIONS)('$letter focuses the region $focus names', ({ letter, focus }) => {
		const action = vimById.get(focus);
		expect(
			shortcutKeysEqual(action?.keys ?? [], ['Ctrl', 'Shift', letter]),
			`${focus} is on ${spell(action?.keys)}`
		).toBe(true);
		expect(
			shortcutSequencesEqual(action?.sequence, [[letter]]),
			`${focus} has the normal-mode key ${action?.sequence?.map((step) => step.join('+')).join(' ')}`
		).toBe(true);
	});

	it.each(DIRECTIONS)(
		'$displaced keeps letter $letter, with Alt added',
		({ letter, displaced }) => {
			// The guessability promise in the displacement table: a user who knows
			// the default chord reaches the Vim one by adding Alt, rather than by
			// learning an unrelated key.
			const action = vimById.get(displaced);
			expect(
				shortcutKeysEqual(action?.keys ?? [], ['Ctrl', 'Alt', 'Shift', letter]),
				`${displaced} is on ${spell(action?.keys)}`
			).toBe(true);
		}
	);

	it('gives the four directions four different keypresses', () => {
		// `focusRegionUp` and `focusRegionDown` both spelled `k` would read as a
		// collision in the one-chord-one-action block above, but only as a nameless
		// pair of ids. This is the same fact stated where the directions are.
		const chords = DIRECTIONS.map(({ focus }) => vimById.get(focus)?.keys ?? []);
		const duplicated = chords.flatMap((keys, i) =>
			chords
				.slice(i + 1)
				.filter((other) => shortcutKeysCollide(keys, other))
				.map(spell)
		);

		expect(duplicated).toEqual([]);
	});
});
