/**
 * Deck mode's user-visible surface: the hint bar.
 *
 * Deck mode is a one-shot leader mode (arm with a chord, the next bare key
 * fires an action, the mode ends). The state machine itself is covered in
 * `stores/uiStore.test.ts`, and the keypress wiring in
 * `hooks/useMainKeyboardHandler.test.ts`. What is proven HERE is the half the
 * user actually sees: that arming puts the whole key table on screen, that it
 * is read from the table rather than from a hand-maintained copy, that it
 * names the chord the live keyboard mode actually binds, and that it takes
 * itself down on the window the handler disarms on.
 *
 * The bar is the one thing Maestro has that tmux does not, so "does it show
 * the right keys" is a behavioural requirement, not a styling detail.
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeckModeHintBar } from '../../../renderer/components/DeckModeHintBar';
import {
	DECK_MODE_CANCEL,
	DECK_MODE_HINT_ROWS,
	DECK_MODE_KEYS,
	DECK_MODE_LEADER_ID,
} from '../../../renderer/constants/deckMode';
import { DEFAULT_SHORTCUTS, TAB_SHORTCUTS } from '../../../renderer/constants/shortcuts';
import { VIM_SHORTCUTS, VIM_TAB_SHORTCUTS } from '../../../renderer/constants/vimShortcuts';
import { Z_LAYERS } from '../../../renderer/constants/zLayers';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { SEQUENCE_TIMEOUT_MS } from '../../../renderer/utils/shortcutSequence';
import { getShortcutKeys, queryAllShortcutKeys } from '../../helpers/shortcutKeys';
import { mockTheme } from '../../helpers/mockTheme';

const bar = () => screen.queryByTestId('deck-mode-hint-bar');

/** Arm the mode the way the leader chord does. */
function arm(): void {
	act(() => {
		useUIStore.getState().armDeckMode();
	});
}

/** End the mode the way every one of its six exits does. */
function disarm(): void {
	act(() => {
		useUIStore.getState().disarmDeckMode();
	});
}

/** Put the bindings back the way they ship, in the mode under test. */
function setKeyboardMode(mode: 'default' | 'vim'): void {
	act(() => {
		useSettingsStore.setState({
			keyboardMode: mode,
			shortcuts: DEFAULT_SHORTCUTS,
			tabShortcuts: TAB_SHORTCUTS,
			vimShortcuts: VIM_SHORTCUTS,
			vimTabShortcuts: VIM_TAB_SHORTCUTS,
		});
	});
}

describe('DeckModeHintBar', () => {
	beforeEach(() => {
		setKeyboardMode('default');
		// Disarm rather than reset: disarming is also what removes the store's
		// window-blur guard, and a guard left installed by one test is a listener
		// the next test did not ask for.
		useUIStore.getState().disarmDeckMode();
	});

	afterEach(() => {
		useUIStore.getState().disarmDeckMode();
		vi.useRealTimers();
	});

	it('renders nothing while the mode is not armed', () => {
		const { container } = render(<DeckModeHintBar theme={mockTheme} />);
		expect(container).toBeEmptyDOMElement();
	});

	it('appears on arm and disappears on disarm', () => {
		render(<DeckModeHintBar theme={mockTheme} />);
		expect(bar()).not.toBeInTheDocument();

		arm();
		expect(bar()).toBeInTheDocument();

		disarm();
		expect(bar()).not.toBeInTheDocument();
	});

	// The point of the whole component: the table is data, so a Deck key added
	// to `DECK_MODE_KEYS` shows up here with no edit to this file.
	it('draws one row per Deck key, cancel included', () => {
		render(<DeckModeHintBar theme={mockTheme} />);
		arm();

		const rows = bar()!.querySelectorAll('[data-deck-row]');
		expect(rows).toHaveLength(DECK_MODE_HINT_ROWS.length);
		expect(Array.from(rows).map((row) => row.getAttribute('data-deck-row'))).toEqual(
			DECK_MODE_HINT_ROWS.map((row) => row.id)
		);
	});

	it('draws each row as its key cap next to the action label', () => {
		render(<DeckModeHintBar theme={mockTheme} />);
		arm();

		for (const row of DECK_MODE_HINT_ROWS) {
			const drawn = bar()!.querySelector(`[data-deck-row="${row.id}"]`);
			expect(drawn).toBeInTheDocument();
			// The cap is drawn by ShortcutKeys, so the chord's text is split
			// across `<kbd>` elements and only `data-shortcut-keys` matches it.
			expect(queryAllShortcutKeys(row.keys, drawn!)).toHaveLength(1);
			expect(drawn).toHaveTextContent(row.label);
		}
	});

	// Deck `h` and Ctrl+Shift+H are ONE action, so the bar must not invent its
	// own wording for it: the labels here are the labels Settings shows.
	it('labels a row with the canonical label of the action it fires', () => {
		render(<DeckModeHintBar theme={mockTheme} />);
		arm();

		const left = bar()!.querySelector('[data-deck-row="focusRegionLeft"]');
		expect(left).toHaveTextContent(DEFAULT_SHORTCUTS.focusRegionLeft.label);
	});

	it('renders the cancel row without it being one of the firing keys', () => {
		render(<DeckModeHintBar theme={mockTheme} />);
		arm();

		expect(bar()!.querySelector(`[data-deck-row="${DECK_MODE_CANCEL.id}"]`)).toBeInTheDocument();
		expect(DECK_MODE_KEYS.some((row) => row.id === DECK_MODE_CANCEL.id)).toBe(false);
	});

	describe('the leader chord in its title', () => {
		it("names the live mode's chord", () => {
			setKeyboardMode('vim');
			render(<DeckModeHintBar theme={mockTheme} />);
			arm();

			const leader = VIM_SHORTCUTS[DECK_MODE_LEADER_ID];
			expect(getShortcutKeys(leader.keys!, bar()!)).toBeInTheDocument();
			expect(bar()).toHaveTextContent(leader.label!);
		});

		// Default mode ships the leader unassigned, and the mode is still
		// reachable there through Quick Actions. An empty key cap would advertise
		// a chord that does nothing, so the title is the label alone.
		it('shows the label and no cap while the leader is unbound', () => {
			render(<DeckModeHintBar theme={mockTheme} />);
			arm();

			expect(bar()).toHaveTextContent(DEFAULT_SHORTCUTS[DECK_MODE_LEADER_ID].label);
			expect(queryAllShortcutKeys(VIM_SHORTCUTS[DECK_MODE_LEADER_ID].keys!, bar()!)).toHaveLength(
				0
			);
		});

		// The leader is an ordinary entry in the shortcut maps, so a user may have
		// rebound it. Reading the shipped table would show them a chord they do
		// not have.
		it('follows the user rebinding it', () => {
			act(() => {
				useSettingsStore.setState({
					shortcuts: {
						...DEFAULT_SHORTCUTS,
						[DECK_MODE_LEADER_ID]: {
							...DEFAULT_SHORTCUTS[DECK_MODE_LEADER_ID],
							keys: ['Alt', 'Meta', 'd'],
						},
					},
				});
			});
			render(<DeckModeHintBar theme={mockTheme} />);
			arm();

			expect(getShortcutKeys(['Alt', 'Meta', 'd'], bar()!)).toBeInTheDocument();
		});
	});

	describe('what it must not do to the surface underneath', () => {
		it('never takes focus and never swallows a click', () => {
			render(<DeckModeHintBar theme={mockTheme} />);
			arm();

			const root = bar()!;
			expect(root.className).toContain('pointer-events-none');
			// Nothing inside can be tabbed to or focused, so arming the mode from a
			// focused composer cannot move the caret out of it.
			expect(root.querySelectorAll('button, a, input, textarea, [tabindex]')).toHaveLength(0);
			expect(document.activeElement).toBe(document.body);
		});

		// Click-driven surface rule in CLAUDE.md. The bar has no content-driven
		// subtree, so there is no `select-text` island inside it.
		it('is not selectable', () => {
			render(<DeckModeHintBar theme={mockTheme} />);
			arm();

			expect(bar()!.className).toContain('select-none');
		});

		// Down in the bottom band it would sit over the composer and the newest
		// output, which are the two things Deck mode exists to keep usable.
		it('is pinned to the top, clear of the composer and the transcript tail', () => {
			render(<DeckModeHintBar theme={mockTheme} />);
			arm();

			const root = bar()!;
			expect(root.className).toContain('fixed');
			expect(root.style.top).toBe('48px');
			expect(root.style.bottom).toBe('');
		});

		// Arming is allowed over an open layer, so a palette drawn on top of the
		// bar would make that the one place the user is armed and blind.
		it('outranks the command palette', () => {
			render(<DeckModeHintBar theme={mockTheme} />);
			arm();

			expect(bar()!.style.zIndex).toBe(String(Z_LAYERS.DECK_HINT_BAR));
			expect(Z_LAYERS.DECK_HINT_BAR).toBeGreaterThan(Z_LAYERS.QUICK_ACTIONS);
		});

		// A fast typist finishes the whole two-keystroke interaction in well under
		// 200ms. Any entrance long enough to notice would still be playing after
		// the mode it describes has ended.
		it('has no animation to outlive a fast keystroke', () => {
			render(<DeckModeHintBar theme={mockTheme} />);
			arm();

			const root = bar()!;
			expect(root.className).not.toMatch(/transition|animate-|duration-/);
			expect(root.style.transition).toBe('');
			expect(root.style.animation).toBe('');
		});

		// One CSS rule retires every element carrying this attribute on a phone,
		// which has no keyboard to arm the mode with. It has to be on the ROOT:
		// the caps inside carry it too, and hiding only those would leave a bar of
		// bare labels floating over the screen.
		it('marks the whole bar as a keyboard-only hint', () => {
			render(<DeckModeHintBar theme={mockTheme} />);
			arm();

			expect(bar()).toHaveAttribute('data-shortcut-hint');
		});
	});

	describe('what a screen reader hears', () => {
		it('announces one sentence naming the mode and the way out', () => {
			setKeyboardMode('vim');
			render(<DeckModeHintBar theme={mockTheme} />);
			arm();

			const root = bar()!;
			expect(root).toHaveAttribute('role', 'status');
			expect(root).toHaveAttribute('aria-live', 'polite');

			const announcement = root.querySelector('.sr-only');
			expect(announcement).toHaveTextContent(/^Deck mode armed/);
			// The raw key name, not the macOS glyph, which reads as a shape.
			expect(announcement).toHaveTextContent('Escape to cancel');
		});

		// Eighteen rows read aloud would still be playing long after a mode that
		// lives for one second has ended. The table is in the help sheet, which is
		// a surface a screen reader user can take their time with.
		it('keeps the table itself out of the live region', () => {
			render(<DeckModeHintBar theme={mockTheme} />);
			arm();

			const row = bar()!.querySelector('[data-deck-row]');
			expect(row!.closest('[aria-hidden="true"]')).not.toBeNull();
		});
	});

	describe('the expiry timer', () => {
		beforeEach(() => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
		});

		// The store's timeout is lazy - it expires on the next READ, and a user
		// who arms the mode and walks away never reads it again. The bar is
		// painted, so it has to take itself down.
		it('takes itself down once the armed window has passed', () => {
			render(<DeckModeHintBar theme={mockTheme} />);
			arm();

			act(() => {
				vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS);
			});
			// Still armed AT the deadline: the store's check is a strict `>`, so
			// the handler would still fire a Deck key in this millisecond.
			expect(bar()).toBeInTheDocument();

			act(() => {
				vi.advanceTimersByTime(2);
			});
			expect(bar()).not.toBeInTheDocument();
		});

		// It disarms the STORE rather than merely hiding, so the painted state and
		// the answer the handler acts on cannot disagree - and the window-blur
		// guard comes down with it.
		it('ends the mode rather than just hiding itself', () => {
			render(<DeckModeHintBar theme={mockTheme} />);
			arm();

			act(() => {
				vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS + 2);
			});

			expect(useUIStore.getState().deckModeArmed).toBe(false);
			expect(useUIStore.getState().deckModeArmedAt).toBe(0);
		});

		it('restarts the clock when the leader is pressed again', () => {
			render(<DeckModeHintBar theme={mockTheme} />);
			arm();

			act(() => {
				vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS - 100);
			});
			arm();

			// Would already be gone on the first arm's clock.
			act(() => {
				vi.advanceTimersByTime(200);
			});
			expect(bar()).toBeInTheDocument();

			act(() => {
				vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS);
			});
			expect(bar()).not.toBeInTheDocument();
		});

		// The effect computes the time LEFT rather than scheduling a fresh window,
		// so a re-render partway through cannot extend an armed mode.
		it("expires on the arm's own clock, not the render's", () => {
			const { rerender } = render(<DeckModeHintBar theme={mockTheme} />);
			arm();

			act(() => {
				vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS - 100);
			});
			rerender(<DeckModeHintBar theme={{ ...mockTheme, id: 'other' }} />);

			act(() => {
				vi.advanceTimersByTime(102);
			});
			expect(bar()).not.toBeInTheDocument();
		});

		it('leaves no timer behind when it unmounts', () => {
			const { unmount } = render(<DeckModeHintBar theme={mockTheme} />);
			arm();
			unmount();

			act(() => {
				vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS * 3);
			});

			// Nothing disarmed the store, because nothing was listening - and
			// nothing threw trying to render into an unmounted tree. The store's
			// own lazy check is what ends the mode when no bar is mounted.
			expect(useUIStore.getState().deckModeArmed).toBe(true);
		});
	});
});
