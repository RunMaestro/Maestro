/**
 * shortcutSequence - does this RUN of keypresses match a key sequence?
 *
 * A chord is one event: `eventMatchesShortcutKeys` in `shortcutMatch.ts` looks
 * at a single keydown and answers yes or no. A sequence is several events in a
 * row (`g g`, `g t`), so something has to remember what was pressed a moment
 * ago, decide whether the run is still going, and decide when the user has
 * walked away from it. That memory is the only thing this file adds.
 *
 * It adds NOTHING to what a match means. Every step is compared with
 * `eventMatchesShortcutKeys`, so modifier equality, Shift-rewritten punctuation
 * (`[` accepts `{`), Shift-rewritten digits, and the Alt/`e.code` fallback all
 * behave exactly as they do for a chord, and stay symmetric with
 * `buildKeysFromEvent` in `shortcutRecorder.ts` - the recorder writes what the
 * matcher reads, and a second copy of those rules here would drift until a
 * sequence step accepted a key its chord spelling rejected.
 *
 * The model is Vimium and Gmail, not a Vim emulator: a flat list of sequences,
 * no counts (`3j`) and no operator-pending grammar (`d i w`). Those only pay
 * off inside a text buffer, and CodeMirror owns that.
 *
 * ## The rules, and why each one exists
 *
 * - **A chord is never a sequence step.** Any event carrying Meta, Ctrl, or Alt
 *   clears the live prefix and returns `'no-match'`, so every chord in the app
 *   keeps working exactly as it did before sequences existed. This is also why
 *   bare keys are bound through `sequence` and never through `keys` (see
 *   `Shortcut.sequence`): a `keys` binding fires regardless of focus, and a
 *   bare `j` there would scroll the agent list while someone typed a prompt.
 * - **Escape clears unconditionally and returns `'no-match'`.** The layer stack
 *   keeps first claim on Escape. A half-typed `g` must not swallow the keypress
 *   that closes a modal, and "my Escape stopped working" is a bug nobody would
 *   connect to a key sequence.
 * - **A step that matches no live prefix clears the buffer.** The run is over
 *   the moment it stops being a run, so the next keypress starts fresh rather
 *   than completing a sequence the user abandoned two keys ago.
 * - **A modifier-only keydown is invisible.** Pressing Shift fires its own
 *   keydown before the character arrives, so treating it as a failed step would
 *   make every sequence with a capital in it (`g G`) impossible to type. It
 *   returns `'no-match'` and LEAVES the prefix alone, which is different from
 *   every other non-matching key.
 * - **The timeout is lazy.** `SEQUENCE_TIMEOUT_MS` since the last capture
 *   expires the prefix, checked when the buffer is next read rather than with a
 *   timer. No timer means no DOM globals, nothing to cancel on unmount, and no
 *   way for a pending callback to fire into a unmounted component. A caller
 *   that needs to repaint when the prefix expires (the prefix indicator) owns
 *   its own timer; the matcher's answer is correct whenever it is asked.
 * - **Ambiguity resolves SHORT.** If a step both completes one sequence and
 *   prefixes a longer one, the completed one fires immediately. Waiting out the
 *   timeout to see whether a longer sequence arrives would make the shorter
 *   action feel broken for a full second, every time. The cost is that the
 *   longer sequence is unreachable, which is why `shortcutSequencesCollide`
 *   treats a prefix relation as a conflict and refuses the pair at the point it
 *   is recorded.
 * - **Identical sequences resolve by binding order.** The first entry in
 *   `bindings` wins. Conflict detection is what keeps that from happening; this
 *   is only the tie-break so the behavior is defined rather than arbitrary.
 *
 * ## Normal mode is the CALLER's gate
 *
 * `feed` knows nothing about focus or modals. Sequences are only legal when
 * focus is not in a text field and no layer is open, and that is checked by the
 * keyboard handler with `isNormalMode` before it feeds an event here. Keeping
 * the gate out of this file is what lets the matcher stay pure and event
 * shaped: it has no DOM and no React, so it can be unit tested by handing it
 * plain objects.
 *
 * ## Steps are stored as the BINDING spells them
 *
 * The captured prefix holds the matched binding's own step (`['g']`), not a
 * reconstruction of the event. The prefix indicator then renders through the
 * same formatter as a chord, and the matcher needs no inverse of
 * `buildKeysFromEvent` for native events.
 */

import type { Shortcut } from '../../shared/shortcut-types';
import { eventMatchesShortcutKeys, type ShortcutKeyEvent } from './shortcutMatch';

/**
 * How long a half-typed sequence stays live, in milliseconds.
 *
 * 1000 ms is the Vimium and Gmail figure, and the two constraints are tight:
 * long enough to type `g` then `t` without hurrying, short enough that a
 * forgotten prefix cannot swallow a keypress the user has stopped connecting to
 * it. Exported so the prefix indicator hides itself on the same clock the
 * matcher expires on.
 */
export const SEQUENCE_TIMEOUT_MS = 1000;

/**
 * One action's key sequence, as the matcher needs it.
 *
 * Structurally satisfied by `Shortcut`, so a caller hands over
 * `Object.values(effectiveShortcuts)` with no adapter in between. Entries
 * without a sequence are skipped, which is almost all of them.
 */
export interface SequenceBinding {
	id: string;
	sequence?: string[][];
}

/**
 * Flatten binding maps into the list {@link SequenceMatcher.feed} wants.
 *
 * The maps handed in are the LIVE keyboard mode's EFFECTIVE set, the same pair
 * `isShortcut` and `isTabShortcut` are given, so a sequence is only ever
 * matched against the bindings the user can actually see in Settings. Reading
 * the raw `shortcuts` / `vimShortcuts` buckets instead would match sequences
 * from the mode that is not live.
 *
 * Entries are keyed by their MAP KEY rather than by `shortcut.id`, because the
 * key is what the handler dispatches with: the matched id goes back into
 * `isShortcut(e, id)` to pick the branch that runs. The two agree today and a
 * structural test says so, but only one of them is the dispatch address.
 *
 * Several maps rather than one because the general and tab maps are separate
 * and a sequence can be bound in either. The id spaces are disjoint, so the
 * order only matters for a duplicate that should not exist; the first map wins,
 * which is the same tie-break `feed` applies to two identical sequences.
 *
 * Returns a fresh array, so a caller that feeds it on every keydown should
 * memoize on the maps' identity (they are identity-stable across unrelated
 * settings changes).
 */
export function collectSequenceBindings(
	...maps: ReadonlyArray<Record<string, Shortcut>>
): SequenceBinding[] {
	const bindings: SequenceBinding[] = [];
	const seen = new Set<string>();
	for (const map of maps) {
		for (const [id, shortcut] of Object.entries(map)) {
			// `sequence: []` is a binding the user cleared in this mode, which
			// is a different thing from an absent one and matches nothing either
			// way.
			if (!shortcut.sequence?.length) continue;
			if (seen.has(id)) continue;
			seen.add(id);
			bindings.push({ id, sequence: shortcut.sequence });
		}
	}
	return bindings;
}

/**
 * What `feed` decided about one event.
 *
 *  - `'no-match'`: not part of any sequence. The caller falls through to the
 *    normal chord ladder, untouched. The only outcome that must NOT be treated
 *    as handled.
 *  - `'consumed-prefix'`: the event advanced a live sequence. The caller calls
 *    `preventDefault()` and returns, because the keypress belongs to the
 *    sequence and must not also reach a chord or the page.
 *  - `'matched'`: `actionId` fired. The caller dispatches it and records the
 *    usage against that action id.
 */
export type SequenceFeedResult =
	| { outcome: 'no-match' }
	| { outcome: 'consumed-prefix'; prefix: readonly string[][] }
	| { outcome: 'matched'; actionId: string };

/** A sequence matcher's live state and the one way to advance it. */
export interface SequenceMatcher {
	/**
	 * Offer one keydown to the sequence layer.
	 *
	 * `bindings` is passed per call rather than captured at construction so the
	 * caller can hand over the live keyboard mode's set without rebuilding the
	 * matcher (and losing a half-typed prefix) whenever settings change.
	 */
	feed(event: ShortcutKeyEvent, bindings: readonly SequenceBinding[]): SequenceFeedResult;
	/**
	 * The steps captured so far, empty when no sequence is in progress.
	 *
	 * Identity is stable while the prefix is unchanged, so a consumer can render
	 * it without re-rendering on every unrelated keypress. Expires a stale
	 * prefix on read, so a poller never shows a prefix the matcher would already
	 * have dropped.
	 */
	prefix(): readonly string[][];
	/**
	 * Drop any live prefix.
	 *
	 * For the events that end a run without being a keypress: a mode switch
	 * (the candidate list is pinned at the first step, so a half-typed sequence
	 * from the old mode must not complete in the new one), a window blur, a
	 * modal opening.
	 */
	reset(): void;
}

/** Shared instances, so a caller comparing by identity sees no change. */
const NO_MATCH: SequenceFeedResult = { outcome: 'no-match' };
const NO_PREFIX: readonly string[][] = [];

/**
 * Keys that are modifiers and nothing else.
 *
 * Meta, Control, and Alt are already caught by the chord gate (their own
 * keydown carries the matching flag), and they are listed anyway to stay
 * symmetric with the set `buildKeysFromEvent` refuses to record. Shift is the
 * one that matters: it arrives with no other modifier flag set, so without this
 * it would read as a failed step and kill the prefix of any sequence containing
 * a capital. CapsLock and AltGraph are here for the same reason.
 */
const MODIFIER_ONLY_KEYS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'AltGraph', 'CapsLock']);

/**
 * Create a sequence matcher.
 *
 * One instance per keyboard pipeline (the app's main handler owns the only one
 * today). The state is a prefix buffer plus the timestamp of the last capture,
 * and nothing else: there is no mode, no pending operator, and no state machine
 * to desync from the DOM.
 */
export function createSequenceMatcher(): SequenceMatcher {
	/** Steps matched so far, in the spelling the bindings use. */
	let captured: readonly string[][] = NO_PREFIX;
	/**
	 * Bindings still alive after `captured`, pinned when the prefix started.
	 *
	 * Pinned rather than re-derived from `bindings` on every step: the sequence
	 * the user began is the one that finishes, so a `bindings` array that
	 * changes mid-run (a settings write, a mode switch) cannot retarget a
	 * half-typed prefix at a different action. Callers end a run that is no
	 * longer meaningful with `reset()`.
	 */
	let candidates: readonly SequenceBinding[] = [];
	/** `Date.now()` of the last captured step. Meaningless with no prefix. */
	let lastCaptureAt = 0;

	const clear = (): void => {
		captured = NO_PREFIX;
		candidates = [];
		lastCaptureAt = 0;
	};

	/** Drop a prefix the user walked away from. See "the timeout is lazy". */
	const expireStalePrefix = (now: number): void => {
		if (captured.length > 0 && now - lastCaptureAt > SEQUENCE_TIMEOUT_MS) clear();
	};

	return {
		feed(event, bindings) {
			// A chord is never a sequence step, and starting one abandons any
			// run in progress.
			if (event.metaKey || event.ctrlKey || event.altKey) {
				clear();
				return NO_MATCH;
			}

			// Escape belongs to the layer stack, always.
			if (event.key === 'Escape') {
				clear();
				return NO_MATCH;
			}

			// Not a step and not a failure: Shift's own keydown precedes the
			// character it shifts.
			if (MODIFIER_ONLY_KEYS.has(event.key)) return NO_MATCH;

			const now = Date.now();
			expireStalePrefix(now);

			// With a live prefix only its survivors can continue; with none,
			// every binding is a candidate for a first step.
			const stepIndex = captured.length;
			const pool = stepIndex > 0 ? candidates : bindings;

			let completed: SequenceBinding | null = null;
			const survivors: SequenceBinding[] = [];
			let nextStep: string[] | null = null;
			for (const binding of pool) {
				const sequence = binding.sequence;
				// `sequence: []` is a cleared binding, and a sequence shorter
				// than the prefix cannot be one of its survivors.
				if (!sequence || sequence.length <= stepIndex) continue;
				if (!eventMatchesShortcutKeys(event, sequence[stepIndex])) continue;
				if (sequence.length === stepIndex + 1) {
					// A completion always wins over a longer sequence that is
					// still going, so the first one found is the answer. The
					// loop runs to the end rather than breaking because the
					// survivor bookkeeping below is harmless either way.
					completed ??= binding;
				} else {
					survivors.push(binding);
					nextStep ??= sequence[stepIndex];
				}
			}

			if (completed) {
				clear();
				return { outcome: 'matched', actionId: completed.id };
			}

			// `nextStep` is set exactly when `survivors` is non-empty; the
			// second half of the test is what tells the compiler so.
			if (survivors.length === 0 || !nextStep) {
				clear();
				return NO_MATCH;
			}

			// Copied, so the buffer never aliases a binding table a consumer
			// could mutate through the returned prefix.
			captured = [...captured, [...nextStep]];
			candidates = survivors;
			lastCaptureAt = now;
			return { outcome: 'consumed-prefix', prefix: captured };
		},

		prefix() {
			expireStalePrefix(Date.now());
			return captured;
		},

		reset: clear,
	};
}
