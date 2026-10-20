/**
 * Tests for the key-sequence matcher, the only piece of the keyboard layer that
 * remembers a previous keypress.
 *
 * What these cover is the set of things that are silent when they break:
 *
 *  - A chord still reaches the chord ladder. Any event carrying Meta, Ctrl, or
 *    Alt returns `'no-match'` and abandons the run, so the entire existing
 *    keyboard surface is unaffected by the new layer sitting in front of it.
 *  - Escape still reaches the layer stack. A half-typed prefix that swallowed
 *    Escape would read as "my modal will not close".
 *  - An abandoned run cannot complete later. A wrong key, a timeout, or a mode
 *    switch has to clear the buffer, or a keypress minutes later finishes a
 *    sequence the user has forgotten starting.
 *  - A step means exactly what a chord step means. Each one goes through
 *    `eventMatchesShortcutKeys`, so Shift-rewritten punctuation behaves the
 *    same way in a sequence as it does in a chord.
 *  - Shift's own keydown is not a failed step. Without that, no sequence
 *    containing a capital could ever be typed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	collectSequenceBindings,
	createSequenceMatcher,
	SEQUENCE_TIMEOUT_MS,
	type SequenceBinding,
} from '../../../renderer/utils/shortcutSequence';
import { shortcutSequencesCollide } from '../../../shared/shortcutKeys';
import type { Shortcut } from '../../../shared/shortcut-types';
import type { ShortcutKeyEvent } from '../../../renderer/utils/shortcutMatch';

/** A keydown with no modifiers unless the test asks for one. */
const press = (key: string, mods: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
	metaKey: false,
	ctrlKey: false,
	shiftKey: false,
	altKey: false,
	key,
	...mods,
});

const seq = (id: string, sequence: string[][]): SequenceBinding => ({ id, sequence });

/** `g g` and `g t`, the two shapes the real Vim table is built from. */
const BINDINGS: SequenceBinding[] = [seq('goTop', [['g'], ['g']]), seq('goTab', [['g'], ['t']])];

afterEach(() => {
	vi.useRealTimers();
});

describe('createSequenceMatcher', () => {
	describe('matching', () => {
		it('matches a two-step sequence', () => {
			const matcher = createSequenceMatcher();

			expect(matcher.feed(press('g'), BINDINGS)).toEqual({
				outcome: 'consumed-prefix',
				prefix: [['g']],
			});
			expect(matcher.feed(press('g'), BINDINGS)).toEqual({
				outcome: 'matched',
				actionId: 'goTop',
			});
			// The buffer is empty again, so the next key starts a fresh run.
			expect(matcher.prefix()).toEqual([]);
		});

		it('matches a three-step sequence', () => {
			const bindings = [seq('deep', [['g'], ['o'], ['t']])];
			const matcher = createSequenceMatcher();

			expect(matcher.feed(press('g'), bindings).outcome).toBe('consumed-prefix');
			expect(matcher.feed(press('o'), bindings)).toEqual({
				outcome: 'consumed-prefix',
				prefix: [['g'], ['o']],
			});
			expect(matcher.feed(press('t'), bindings)).toEqual({
				outcome: 'matched',
				actionId: 'deep',
			});
		});

		it('picks the branch the second step names', () => {
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), BINDINGS);
			expect(matcher.feed(press('t'), BINDINGS)).toEqual({
				outcome: 'matched',
				actionId: 'goTab',
			});
		});

		it('fires a one-step sequence without ever holding a prefix', () => {
			// `['Shift', 'g']` is a one-step `G`: a bare key lives in `sequence`
			// even when the binding is a single step, because only `sequence` is
			// gated on normal mode.
			const bindings = [seq('goBottom', [['Shift', 'g']])];
			const matcher = createSequenceMatcher();

			expect(matcher.feed(press('G', { shiftKey: true }), bindings)).toEqual({
				outcome: 'matched',
				actionId: 'goBottom',
			});
			expect(matcher.prefix()).toEqual([]);
		});

		it('compares each step with the chord matcher, Shift-rewritten punctuation included', () => {
			// A binding on `Shift+[` has to accept the `{` the event reports.
			// This is the symmetry with `eventMatchesShortcutKeys` that keeps a
			// sequence step from accepting a different key than its chord
			// spelling would.
			const bindings = [seq('bracket', [['g'], ['Shift', '[']])];
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), bindings);
			expect(matcher.feed(press('{', { shiftKey: true }), bindings)).toEqual({
				outcome: 'matched',
				actionId: 'bracket',
			});
		});

		it('ignores bindings with no sequence and bindings whose sequence was cleared', () => {
			const bindings: SequenceBinding[] = [
				{ id: 'chordOnly' },
				seq('cleared', []),
				seq('goTop', [['g'], ['g']]),
			];
			const matcher = createSequenceMatcher();

			expect(matcher.feed(press('g'), bindings).outcome).toBe('consumed-prefix');
			expect(matcher.feed(press('g'), bindings)).toEqual({
				outcome: 'matched',
				actionId: 'goTop',
			});
		});

		it('resolves two identical sequences by binding order', () => {
			const bindings = [seq('first', [['g'], ['g']]), seq('second', [['g'], ['g']])];
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), bindings);
			expect(matcher.feed(press('g'), bindings)).toEqual({
				outcome: 'matched',
				actionId: 'first',
			});
		});

		it('returns no-match with no bindings at all', () => {
			const matcher = createSequenceMatcher();

			expect(matcher.feed(press('g'), [])).toEqual({ outcome: 'no-match' });
		});
	});

	describe('ambiguity', () => {
		it('fires the shorter sequence when a step both completes and prefixes', () => {
			// `g g` completes while `g g g` is still going. Waiting out the
			// timeout to see whether a third `g` arrives would make `g g` feel
			// broken for a full second on every press.
			const bindings = [seq('short', [['g'], ['g']]), seq('long', [['g'], ['g'], ['g']])];
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), bindings);
			expect(matcher.feed(press('g'), bindings)).toEqual({
				outcome: 'matched',
				actionId: 'short',
			});
			// And the longer one is unreachable, which is why recording the
			// pair is refused rather than allowed and quietly broken.
			expect(matcher.prefix()).toEqual([]);
		});

		it('fires the completion even when it is listed after the longer sequence', () => {
			const bindings = [seq('long', [['g'], ['g'], ['g']]), seq('short', [['g'], ['g']])];
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), bindings);
			expect(matcher.feed(press('g'), bindings)).toEqual({
				outcome: 'matched',
				actionId: 'short',
			});
		});
	});

	describe('abandoning a run', () => {
		it('aborts cleanly on a wrong second key and fires nothing', () => {
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), BINDINGS);
			// The wrong key is reported as no-match, so the caller still runs
			// it through the chord ladder instead of swallowing it.
			expect(matcher.feed(press('x'), BINDINGS)).toEqual({ outcome: 'no-match' });
			expect(matcher.prefix()).toEqual([]);
		});

		it('starts a fresh run after an abort', () => {
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), BINDINGS);
			matcher.feed(press('x'), BINDINGS);

			expect(matcher.feed(press('g'), BINDINGS).outcome).toBe('consumed-prefix');
			expect(matcher.feed(press('g'), BINDINGS)).toEqual({
				outcome: 'matched',
				actionId: 'goTop',
			});
		});

		it('clears a live prefix on Escape and returns no-match', () => {
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), BINDINGS);
			expect(matcher.feed(press('Escape'), BINDINGS)).toEqual({ outcome: 'no-match' });
			expect(matcher.prefix()).toEqual([]);
			// The second `g` must not complete `g g` across the Escape.
			expect(matcher.feed(press('g'), BINDINGS).outcome).toBe('consumed-prefix');
		});

		it('clears a live prefix and returns no-match for Meta, Ctrl and Alt', () => {
			for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
				const matcher = createSequenceMatcher();
				matcher.feed(press('g'), BINDINGS);

				expect(matcher.feed(press('g', mods), BINDINGS)).toEqual({ outcome: 'no-match' });
				expect(matcher.prefix()).toEqual([]);
			}
		});

		it('never starts a run from a modified keypress', () => {
			const matcher = createSequenceMatcher();

			expect(matcher.feed(press('g', { metaKey: true }), BINDINGS)).toEqual({
				outcome: 'no-match',
			});
			expect(matcher.prefix()).toEqual([]);
		});

		it('clears on reset, so a mode switch cannot complete an old run', () => {
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), BINDINGS);
			matcher.reset();

			expect(matcher.prefix()).toEqual([]);
			expect(matcher.feed(press('g'), BINDINGS).outcome).toBe('consumed-prefix');
		});
	});

	describe('modifier-only keydowns', () => {
		it('leaves a live prefix alone so a capital step can be typed', () => {
			const bindings = [seq('shout', [['g'], ['Shift', 'g']])];
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), bindings);
			// Pressing Shift fires its own keydown before the character does.
			expect(matcher.feed(press('Shift', { shiftKey: true }), bindings)).toEqual({
				outcome: 'no-match',
			});
			expect(matcher.prefix()).toEqual([['g']]);

			expect(matcher.feed(press('G', { shiftKey: true }), bindings)).toEqual({
				outcome: 'matched',
				actionId: 'shout',
			});
		});

		it('leaves a live prefix alone for CapsLock', () => {
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), BINDINGS);
			expect(matcher.feed(press('CapsLock'), BINDINGS)).toEqual({ outcome: 'no-match' });
			expect(matcher.prefix()).toEqual([['g']]);
		});
	});

	describe('the timeout', () => {
		it('expires a live prefix', () => {
			vi.useFakeTimers();
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), BINDINGS);
			vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS + 1);

			// The late second `g` starts a NEW run instead of completing the
			// old one.
			expect(matcher.feed(press('g'), BINDINGS)).toEqual({
				outcome: 'consumed-prefix',
				prefix: [['g']],
			});
		});

		it('keeps a prefix that is still inside the window', () => {
			vi.useFakeTimers();
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), BINDINGS);
			vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS - 1);

			expect(matcher.feed(press('g'), BINDINGS)).toEqual({
				outcome: 'matched',
				actionId: 'goTop',
			});
		});

		it('measures from the LAST step, not the first', () => {
			vi.useFakeTimers();
			const bindings = [seq('deep', [['g'], ['o'], ['t']])];
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), bindings);
			vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS - 1);
			matcher.feed(press('o'), bindings);
			vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS - 1);

			expect(matcher.feed(press('t'), bindings)).toEqual({
				outcome: 'matched',
				actionId: 'deep',
			});
		});

		it('expires on read, so a poller never shows a dead prefix', () => {
			vi.useFakeTimers();
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), BINDINGS);
			expect(matcher.prefix()).toEqual([['g']]);

			vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS + 1);
			expect(matcher.prefix()).toEqual([]);
		});
	});

	describe('the prefix buffer', () => {
		it('is empty before anything is typed', () => {
			expect(createSequenceMatcher().prefix()).toEqual([]);
		});

		it('keeps its identity while the prefix is unchanged', () => {
			const matcher = createSequenceMatcher();

			matcher.feed(press('g'), BINDINGS);
			const first = matcher.prefix();
			matcher.feed(press('Shift', { shiftKey: true }), BINDINGS);

			expect(matcher.prefix()).toBe(first);
		});

		it('does not alias the binding table', () => {
			const bindings = [seq('goTop', [['g'], ['g']])];
			const matcher = createSequenceMatcher();

			const result = matcher.feed(press('g'), bindings);
			if (result.outcome !== 'consumed-prefix') throw new Error('expected a live prefix');
			result.prefix[0][0] = 'mutated';

			expect(bindings[0].sequence?.[0]).toEqual(['g']);
		});
	});
});

/**
 * Prefix conflict detection, and the matcher behavior that justifies it.
 *
 * `shortcutSequencesCollide` is unit tested beside its siblings in
 * `src/__tests__/shared/shortcutKeys.test.ts`. What those tests cannot say is
 * WHY a prefix relation counts as a conflict at all, because the reason lives
 * here: the matcher resolves ambiguity SHORT, so the longer member of a prefix
 * pair is not racy, it is unreachable. The two files have to agree or the guard
 * is wrong in one direction or the other - refusing pairs that would have
 * worked, or accepting pairs where one binding silently never fires.
 *
 * So each case below asserts the verdict AND walks the keys through the
 * matcher. If someone changed `feed` to wait out the timeout before firing a
 * completion, the refusals would become unnecessary and these fail; if someone
 * narrowed the collide check to equality, `g` would be accepted beside `g g`
 * and the walk-through shows `g g` is then dead.
 */
describe('prefix conflicts', () => {
	it('refuses `g` beside `g g`, because `g g` could never fire', () => {
		expect(shortcutSequencesCollide([['g']], [['g'], ['g']])).toBe(true);

		const bindings = [seq('bare', [['g']]), seq('goTop', [['g'], ['g']])];
		const matcher = createSequenceMatcher();

		// The first `g` completes the one-step binding immediately, so the
		// second one starts a new run rather than finishing `g g`.
		expect(matcher.feed(press('g'), bindings)).toEqual({ outcome: 'matched', actionId: 'bare' });
		expect(matcher.feed(press('g'), bindings)).toEqual({ outcome: 'matched', actionId: 'bare' });
	});

	it('refuses `g g g` beside `g g`, because the third step is unreachable', () => {
		expect(shortcutSequencesCollide([['g'], ['g'], ['g']], [['g'], ['g']])).toBe(true);

		const bindings = [seq('goTop', [['g'], ['g']]), seq('deep', [['g'], ['g'], ['g']])];
		const matcher = createSequenceMatcher();

		expect(matcher.feed(press('g'), bindings).outcome).toBe('consumed-prefix');
		expect(matcher.feed(press('g'), bindings)).toEqual({
			outcome: 'matched',
			actionId: 'goTop',
		});
		// The run ended at the second step, so a third `g` is the start of
		// another `g g` and never the last step of `g g g`.
		expect(matcher.feed(press('g'), bindings)).toEqual({
			outcome: 'consumed-prefix',
			prefix: [['g']],
		});
	});

	it('accepts `g t` beside `g g`, and both stay reachable', () => {
		expect(shortcutSequencesCollide([['g'], ['t']], [['g'], ['g']])).toBe(false);

		const matcher = createSequenceMatcher();

		matcher.feed(press('g'), BINDINGS);
		expect(matcher.feed(press('g'), BINDINGS)).toEqual({ outcome: 'matched', actionId: 'goTop' });
		matcher.feed(press('g'), BINDINGS);
		expect(matcher.feed(press('t'), BINDINGS)).toEqual({ outcome: 'matched', actionId: 'goTab' });
	});

	it('refuses the pair whichever way round it is recorded', () => {
		// The recorder compares the sequence just typed against every existing
		// one, so the new binding can be either the shorter or the longer side.
		expect(shortcutSequencesCollide([['g'], ['g']], [['g']])).toBe(true);
		expect(shortcutSequencesCollide([['g'], ['g']], [['g'], ['g'], ['g']])).toBe(true);
	});
});

/**
 * Turning the live mode's effective maps into the list `feed` wants.
 *
 * Small, but it is the join between the resolver and the matcher, and both of
 * the things it can get wrong are silent: a dropped entry is a sequence that
 * never fires, and the wrong id is an action that fires the wrong branch.
 */
describe('collectSequenceBindings', () => {
	const entry = (id: string, extra: Partial<Shortcut> = {}): Shortcut => ({
		id,
		label: id,
		keys: [],
		...extra,
	});

	it('keeps only the actions that carry a sequence', () => {
		const bindings = collectSequenceBindings({
			goTop: entry('goTop', { sequence: [['g'], ['g']] }),
			chordOnly: entry('chordOnly', { keys: ['Meta', 'k'] }),
			unassigned: entry('unassigned'),
		});

		expect(bindings).toEqual([{ id: 'goTop', sequence: [['g'], ['g']] }]);
	});

	it('skips a sequence the user cleared in this mode', () => {
		// `sequence: []` is present and deliberate, and matches nothing.
		expect(collectSequenceBindings({ goTop: entry('goTop', { sequence: [] }) })).toEqual([]);
	});

	it('reads across every map it is given', () => {
		const general = { toggleZenMode: entry('toggleZenMode', { sequence: [['z']] }) };
		const tabs = { nextTab: entry('nextTab', { sequence: [['g'], ['t']] }) };

		expect(collectSequenceBindings(general, tabs).map((b) => b.id)).toEqual([
			'toggleZenMode',
			'nextTab',
		]);
	});

	it('keys by the MAP KEY, which is the dispatch address', () => {
		// The id the handler gets back goes straight into `isShortcut(e, id)`,
		// and the key is what that reads. A disagreeing `id` field would send the
		// match to a branch that does not exist.
		const bindings = collectSequenceBindings({
			nextTab: entry('stale-id', { sequence: [['g'], ['t']] }),
		});

		expect(bindings[0].id).toBe('nextTab');
	});

	it('takes the first map that binds an id', () => {
		const first = { nextTab: entry('nextTab', { sequence: [['g'], ['t']] }) };
		const second = { nextTab: entry('nextTab', { sequence: [['l']] }) };

		expect(collectSequenceBindings(first, second)).toEqual([
			{ id: 'nextTab', sequence: [['g'], ['t']] },
		]);
	});

	it('produces a list the matcher can match against', () => {
		const matcher = createSequenceMatcher();
		const bindings = collectSequenceBindings({
			goTop: entry('goTop', { sequence: [['g'], ['g']] }),
		});

		expect(matcher.feed(press('g'), bindings).outcome).toBe('consumed-prefix');
		expect(matcher.feed(press('g'), bindings)).toEqual({ outcome: 'matched', actionId: 'goTop' });
	});
});
