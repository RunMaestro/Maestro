/**
 * sequencePrefixStore - the key sequence the user is halfway through typing.
 *
 * `createSequenceMatcher()` in `src/renderer/utils/shortcutSequence.ts` is pure
 * and event shaped on purpose: no React, no DOM, no timers. That is what makes
 * it unit testable, and it is also why it cannot tell anyone when a prefix goes
 * live. The one instance lives inside the keydown effect's closure in
 * `useMainKeyboardHandler`, where no component can reach it.
 *
 * So the handler publishes here, and `SequencePrefixIndicator` reads here. The
 * matcher stays the single authority on what the prefix IS - the handler writes
 * `sequenceMatcher.prefix()` verbatim rather than tracking the steps a second
 * time, so the chip can never show a run the matcher has already dropped.
 *
 * Two properties keep this off the hot path. The matcher's `prefix()` is
 * identity-stable while the run is unchanged, and `setSequencePrefix` skips a
 * write that changes nothing, so the handler may call it on every keydown (it
 * does) without re-rendering the chip or restarting its clock. A user with no
 * sequences bound never reaches the call at all: the handler skips the whole
 * sequence block when the live mode binds none.
 *
 * `capturedAt` exists because the matcher's timeout is LAZY - it expires a
 * prefix when the buffer is next read, which may be never. The indicator owns
 * the timer that hides a prefix nobody finished, and this is the clock it runs
 * off. See `SEQUENCE_TIMEOUT_MS`.
 */

import { create } from 'zustand';

/** Shared empty prefix, so "no run in progress" is one identity. */
const NO_PREFIX: readonly string[][] = [];

interface SequencePrefixState {
	/**
	 * Steps captured so far, in the spelling the BINDING uses (`[['g']]`), so a
	 * consumer renders them through the same formatter as a chord. Empty when no
	 * sequence is in progress.
	 */
	prefix: readonly string[][];
	/**
	 * `Date.now()` of the write that captured the newest step; 0 with no prefix.
	 *
	 * Taken at publish rather than carried out of the matcher: the handler
	 * publishes in the same keydown that captured the step, so the two differ by
	 * microseconds, and the matcher keeps its timestamp private.
	 */
	capturedAt: number;
	/** Internal - callers use `publishSequencePrefix` / `clearSequencePrefix`. */
	setSequencePrefix: (prefix: readonly string[][]) => void;
}

export const useSequencePrefixStore = create<SequencePrefixState>()((set) => ({
	prefix: NO_PREFIX,
	capturedAt: 0,
	setSequencePrefix: (next) =>
		set((s) => {
			// Identity first: the matcher returns the same array for an unchanged
			// run, which is the common case on a keypress that is not a step.
			if (next === s.prefix) return s;
			// Two different empty arrays still mean the same thing. Without this,
			// the matcher's shared empty and this module's would each count as a
			// change and reset a clock that is already stopped.
			if (next.length === 0) {
				return s.prefix.length === 0 ? s : { prefix: NO_PREFIX, capturedAt: 0 };
			}
			return { prefix: next, capturedAt: Date.now() };
		}),
}));

/**
 * Publish the matcher's current prefix.
 *
 * Pass `sequenceMatcher.prefix()` straight through - an empty result is how a
 * matched, aborted, expired, or reset run reaches the indicator, so there is
 * nothing for the caller to branch on.
 */
export function publishSequencePrefix(prefix: readonly string[][]): void {
	useSequencePrefixStore.getState().setSequencePrefix(prefix);
}

/**
 * Drop the published prefix.
 *
 * For the indicator's own expiry timer. It deliberately does NOT reset the
 * matcher: the matcher expires the same prefix on its next read off the same
 * constant, so reaching into it from a component would add a second owner of
 * the run for no change in behavior.
 */
export function clearSequencePrefix(): void {
	useSequencePrefixStore.getState().setSequencePrefix(NO_PREFIX);
}
