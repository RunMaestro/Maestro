/**
 * SequencePrefixIndicator - the chip that shows a key sequence in progress.
 *
 * A chord gives instant feedback: the action happens. A sequence does not - the
 * first `g` of `g g` does nothing visible, so without this the keyboard looks
 * broken for up to a second, and a user who mistypes the second key has no way
 * to know the app was waiting on them at all. The chip is the whole of that
 * feedback: the keys captured so far, and a trailing ellipsis for "still
 * listening".
 *
 * It renders nothing unless a prefix is live, and a prefix dies in four ways,
 * all of which arrive here as an empty prefix: the sequence completed, a key
 * that could not continue it arrived, Escape cleared it (the layer stack keeps
 * first claim on Escape), or the window lost focus. The fifth is the timeout,
 * which is the one the matcher cannot report - see the timer below.
 *
 * ## One app-wide host, not a pill in the composer stack
 *
 * The status pills above the composer (`ThinkingStatusPill`,
 * `ExecutionQueueIndicator`, `QuitWhenIdleIndicator`) only exist while an agent
 * session owns the main panel. A sequence is typeable in a group chat, in the
 * log viewer, and on the empty state, none of which render that stack, so a
 * pill there would silently stop giving feedback in exactly the places a user
 * is most likely to be navigating by keyboard. So this is mounted once in
 * `AppShell` beside the other app-wide hosts and pinned to the bottom of the
 * window, which is the same band those pills occupy.
 *
 * Bottom CENTER specifically: toasts are configurable to any of the four
 * corners, so the center is the one spot on the bottom edge nothing else can be
 * dragged or configured into. The chip is `pointer-events-none` and lives for
 * at most a second, and a prefix can only be live while focus is outside every
 * text field (that is what normal mode means), so overlapping the composer
 * costs the user nothing they were looking at.
 */

import { memo, useEffect } from 'react';
import { ShortcutKeys } from './ui/ShortcutHint';
import { clearSequencePrefix, useSequencePrefixStore } from '../stores/sequencePrefixStore';
import { SEQUENCE_TIMEOUT_MS } from '../utils/shortcutSequence';
import type { Theme } from '../types';

/**
 * Same value the floating media player and throughput gauge use: over the app's
 * own chrome, under a modal. A prefix cannot be live while a layer is open (the
 * handler's gate checks `hasOpenLayers`), so the chip never has to outrank one.
 */
const FLOAT_Z_INDEX = 60;

/** Inset from the window bottom, matching the gutter the toast stack uses. */
const BOTTOM_OFFSET = 16;

interface SequencePrefixIndicatorProps {
	theme: Theme;
}

export const SequencePrefixIndicator = memo(function SequencePrefixIndicator({
	theme,
}: SequencePrefixIndicatorProps): JSX.Element | null {
	const prefix = useSequencePrefixStore((s) => s.prefix);
	const capturedAt = useSequencePrefixStore((s) => s.capturedAt);

	// The matcher's timeout is LAZY: it expires a prefix when the buffer is next
	// read, and a user who presses `g` and walks away never reads it again. The
	// matcher is right either way - its next answer is correct - but the chip is
	// a painted thing and would sit there until the next keypress. So the
	// consumer that must repaint owns the timer, off the matcher's own exported
	// constant, which is the arrangement `shortcutSequence.ts` documents.
	//
	// Keyed on `capturedAt`, so each captured step restarts the clock the way the
	// matcher does, and the remaining time is computed rather than assumed: a
	// re-render for an unrelated reason must not hand a half-expired prefix a
	// fresh second.
	useEffect(() => {
		if (capturedAt === 0) return;
		const remaining = Math.max(0, SEQUENCE_TIMEOUT_MS - (Date.now() - capturedAt));
		const timer = setTimeout(clearSequencePrefix, remaining);
		return () => clearTimeout(timer);
	}, [capturedAt]);

	if (prefix.length === 0) return null;

	return (
		<div
			// A keyboard-only hint: the one CSS rule on this attribute retires every
			// chord badge on a phone, which has no keyboard to type a sequence on.
			// It is on the ROOT rather than left to the caps inside - those carry it
			// too, and hiding only them would leave an empty bubble on screen.
			data-shortcut-hint=""
			data-testid="sequence-prefix-indicator"
			// Announced rather than silent: the chip is the only signal that the app
			// is mid-sequence, and a screen reader user needs it as much as anyone.
			role="status"
			aria-live="polite"
			aria-label={`Key sequence in progress: ${prefix.map((step) => step.join('+')).join(' ')}`}
			className="fixed left-1/2 -translate-x-1/2 flex items-center gap-2 px-2.5 py-1.5 rounded-full border pointer-events-none select-none"
			style={{
				bottom: BOTTOM_OFFSET,
				zIndex: FLOAT_Z_INDEX,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: `${theme.colors.accent}55`,
				boxShadow: `0 4px 16px -4px ${theme.colors.accent}40, 0 0 0 1px ${theme.colors.border}55`,
			}}
		>
			{prefix.map((step, index) => (
				// One `ShortcutKeys` per STEP, never one call with the whole prefix:
				// that component draws a `string[][]` as alternatives ("esc or ⌘ W"),
				// and `g g` is a run, not a choice. Per step it is the same key cap a
				// chord gets anywhere else in the app.
				//
				// Steps are a fixed list captured in order, so index is stable here.
				<ShortcutKeys key={index} theme={theme} keys={step} />
			))}
			<span className="text-2xs leading-none" style={{ color: theme.colors.textDim }}>
				…
			</span>
		</div>
	);
});

export default SequencePrefixIndicator;
