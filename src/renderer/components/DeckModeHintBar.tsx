/**
 * DeckModeHintBar - what an armed Deck mode will do with the next keystroke.
 *
 * This is the one thing Maestro gets to do that a terminal multiplexer cannot.
 * tmux arms its prefix silently and expects the user to have memorized the
 * table; a user who has not just loses the next keystroke to a mode they can
 * neither see nor remember. Here the table is data (`constants/deckMode.ts`),
 * so the moment the leader arms, every key it enables is on screen with the
 * action it fires, read from `DECK_MODE_HINT_ROWS` rather than from a second,
 * hand-maintained copy. Add a Deck key to that array and it appears here.
 * The rows themselves are drawn by {@link DeckModeKeyList}, shared with the
 * help sheet's Deck Mode section so the two surfaces cannot drift apart.
 *
 * Each row draws its label verbatim from the row, and every Deck row's label
 * is the canonical label of the action it fires, so the bar, Settings >
 * Shortcuts and the help sheet cannot disagree about what `x` does.
 *
 * ## Why it is pinned to the TOP
 *
 * The bar is wider and taller than the sequence chip, so it cannot share the
 * bottom-center band that chip occupies: down there it would sit over the
 * composer and the newest output in the transcript, which are the two things a
 * user is actually reading when they reach for the leader. Deck mode exists
 * precisely so the bare keys work WITHOUT leaving the composer, so covering
 * the composer would undo the feature's own point.
 *
 * Top center, at the same {@link TOAST_TOP_OFFSET} a top-anchored toast stack
 * uses, which already clears the 40px title bar and the macOS traffic lights.
 * That band belongs to the tab strip, and overlapping it is the accepted cost:
 * the Deck digits address tabs by POSITION rather than by title, the bar lives
 * for at most a second, and the alternative was the composer.
 *
 * It is `pointer-events-none` with nothing focusable inside, so it can neither
 * take focus nor swallow a click aimed at what it covers, and `select-none`
 * per the click-driven surface rule in CLAUDE.md.
 *
 * ## No animation
 *
 * Nothing fades, slides, or transitions. The whole interaction is two
 * keystrokes and a fast typist finishes it in well under 200ms, so any
 * entrance long enough to notice would still be playing when the mode it
 * advertises has already ended - a bar animating in to describe keys that no
 * longer do anything is worse than no bar at all.
 *
 * ## It outranks a modal, deliberately
 *
 * Deck mode can be armed over an open layer (the handler's block sits above
 * the layer guard, and `LayerStackProvider` yields Escape to it). A hint bar
 * that a palette or a settings modal painted over would make that the one
 * place the user is armed and blind, so it sits at
 * {@link Z_LAYERS.DECK_HINT_BAR}, above the palette and below the center
 * flash.
 */

import { memo, useEffect } from 'react';
import { DeckModeKeyList } from './DeckModeKeyList';
import { ShortcutHint, shortcutSuffix } from './ui/ShortcutHint';
import { DECK_MODE_CANCEL, DECK_MODE_LEADER_ID } from '../constants/deckMode';
import { DEFAULT_SHORTCUTS } from '../constants/shortcuts';
import { Z_LAYERS } from '../constants/zLayers';
import { selectActiveShortcuts } from '../stores/settingsShortcutsSlice';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { SEQUENCE_TIMEOUT_MS } from '../utils/shortcutSequence';
import { TOAST_TOP_OFFSET } from '../../shared/toastPosition';
import type { Theme } from '../types';

/**
 * Widest the bar may grow before its rows wrap.
 *
 * The eighteen rows lay out as a wrapping flex row rather than a column: a
 * column would be eighteen lines tall and run past the fold on a short window,
 * while wrapped chips keep the whole table inside three lines on any window
 * wide enough to show a transcript. `92vw` keeps it off both window edges on a
 * narrow one.
 */
const MAX_WIDTH = 'min(92vw, 880px)';

interface DeckModeHintBarProps {
	theme: Theme;
}

export const DeckModeHintBar = memo(function DeckModeHintBar({
	theme,
}: DeckModeHintBarProps): JSX.Element | null {
	const armed = useUIStore((s) => s.deckModeArmed);
	const armedAt = useUIStore((s) => s.deckModeArmedAt);
	// The LIVE binding, not the shipped one: the leader is an ordinary entry in
	// the shortcut maps, so a user may have rebound it, and Vim mode ships a
	// chord where default mode ships none. Subscribed through the active-mode
	// selector (memoized, so the entry keeps its identity) rather than through
	// `useActiveShortcuts()`, which also returns the setters this read-only
	// overlay has no use for.
	const leader = useSettingsStore((s) => selectActiveShortcuts(s)[DECK_MODE_LEADER_ID]);

	// The store's timeout is LAZY: the stamp is compared against the clock when
	// the handler next reads it, and a user who arms the mode and walks away
	// never reads it again. The handler's answer stays correct either way, but a
	// painted bar does not, so the thing that must repaint owns the timer - the
	// same division of labour `SequencePrefixIndicator` has with the sequence
	// matcher. Keyed on `armedAt`, so a re-arm restarts the clock and the time
	// LEFT is computed rather than assumed: a re-render partway through the
	// window must not hand a half-spent mode a fresh second.
	//
	// The extra millisecond is `deckModeExpired`'s strict `>`. At exactly the
	// deadline the handler would still fire a Deck key, and the bar must not
	// vanish a millisecond before the key it was advertising stops working.
	useEffect(() => {
		if (!armed) return;
		const remaining = Math.max(0, SEQUENCE_TIMEOUT_MS - (Date.now() - armedAt)) + 1;
		const timer = setTimeout(() => useUIStore.getState().disarmDeckMode(), remaining);
		return () => clearTimeout(timer);
	}, [armed, armedAt]);

	if (!armed) return null;

	// Falls back to the shipped entry only if a persisted map somehow predates
	// the action. `migrateShortcuts` merges the shipped table on load, so this
	// is a belt, not a branch anyone should hit.
	const leaderLabel = leader?.label ?? DEFAULT_SHORTCUTS[DECK_MODE_LEADER_ID].label;
	const leaderKeys = leader?.keys ?? [];

	return (
		<div
			// A keyboard-only hint: the one CSS rule on this attribute retires every
			// chord badge on a phone, which has no keyboard to arm Deck mode with.
			// On the ROOT rather than left to the caps inside, which carry it too -
			// hiding only those would leave a bar of bare labels on screen.
			data-shortcut-hint=""
			data-testid="deck-mode-hint-bar"
			role="status"
			aria-live="polite"
			className="fixed left-1/2 -translate-x-1/2 flex flex-col gap-1.5 px-3 py-2 rounded-lg border pointer-events-none select-none"
			style={{
				top: TOAST_TOP_OFFSET,
				zIndex: Z_LAYERS.DECK_HINT_BAR,
				maxWidth: MAX_WIDTH,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: `${theme.colors.accent}55`,
				boxShadow: `0 4px 16px -4px ${theme.colors.accent}40, 0 0 0 1px ${theme.colors.border}55`,
			}}
		>
			{/* The only thing announced, and the reason everything below is hidden
			    from the accessibility tree: a live region reads its CONTENT, and
			    eighteen rows read aloud would still be playing long after a mode
			    that lives for one second has ended. One sentence naming the mode,
			    how it was armed, and the way out; the table itself is in the help
			    sheet, which is a surface a screen reader user can take their time
			    with. The cancel key is spelled from the table rather than typed
			    here, and as its raw name rather than the formatter's `⎋`, which a
			    screen reader would read as a shape. */}
			<span className="sr-only">
				{`Deck mode armed${shortcutSuffix(leaderKeys)}. Press a Deck key, or ${DECK_MODE_CANCEL.keys[0]} to cancel.`}
			</span>

			<div className="flex items-center gap-2" aria-hidden="true">
				<span
					className="text-2xs font-semibold uppercase tracking-wide"
					style={{ color: theme.colors.textMain }}
				>
					{leaderLabel}
				</span>
				{/* Renders nothing while the leader is unbound, which is how it ships
				    in default mode: the mode is reachable there through Quick
				    Actions, and an empty key cap would advertise a chord that does
				    nothing. `ml-auto` pushes the chord to the far end of the title. */}
				<ShortcutHint theme={theme} keys={leaderKeys} />
			</div>

			{/* The table itself, drawn by the one component that draws it anywhere
			    (the help sheet's Deck Mode section is the other caller), and
			    hidden from the accessibility tree for the reason above. */}
			<DeckModeKeyList theme={theme} ariaHidden />
		</div>
	);
});

export default DeckModeHintBar;
