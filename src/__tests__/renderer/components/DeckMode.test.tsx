/**
 * Deck mode's surfaces, and the two places its layers meet.
 *
 * Deck mode is a one-shot leader mode (arm with a chord, the next bare key
 * fires an action, the mode ends). Its state machine is covered in
 * `stores/uiStore.test.ts` - the lazy timeout, the window-blur guard, and the
 * disarm on a keyboard-mode switch - and its keypress wiring in
 * `hooks/useMainKeyboardHandler.test.ts`, where the leader, every firing key,
 * a miss, and a chord pressed while armed each get a case.
 *
 * Three things are proven HERE, each of them needing more than one unit in the
 * same tree:
 *
 *  - The hint bar: that arming puts the whole key table on screen, read from
 *    the table rather than from a hand-maintained copy, that it names the chord
 *    the live keyboard mode actually binds, and that it takes itself down on
 *    the window the handler disarms on. The bar is the one thing Maestro has
 *    that tmux does not, so "does it show the right keys" is a behavioural
 *    requirement, not a styling detail.
 *  - The two routes that need no leader chord (the palette entry and the help
 *    sheet's section), which is all default mode ships.
 *  - Escape over an open modal, and what keyboard mastery records across the
 *    two routes to one action. Both are cross-layer claims, and the suite at
 *    the bottom says why neither single-layer file can make them.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	useActiveShortcuts,
	useKeyboardShortcutHelpers,
	useMainKeyboardHandler,
} from '../../../renderer/hooks';
import { useModalLayer } from '../../../renderer/hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../../renderer/constants/modalPriorities';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { DeckModeHintBar } from '../../../renderer/components/DeckModeHintBar';
import { ShortcutsHelpModal } from '../../../renderer/components/ShortcutsHelpModal';
import { buildFeatureCommands } from '../../../renderer/components/QuickActionsModal/commands/featureCommands';
import { filterAndSortQuickActions } from '../../../renderer/components/QuickActionsModal/utils/quickActionSorting';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
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
import { deckModeExpired, useUIStore } from '../../../renderer/stores/uiStore';
import type { Shortcut } from '../../../renderer/types';
import { SEQUENCE_TIMEOUT_MS } from '../../../renderer/utils/shortcutSequence';
import { getShortcutKeys, queryAllShortcutKeys } from '../../helpers/shortcutKeys';
import { mockTheme } from '../../helpers/mockTheme';

// `focusRegionLeft` delegates wholesale to a service with its own suite
// (regionFocus.test.ts). Spied rather than run, so the mastery cases at the
// bottom of this file assert that the Deck route and the chord route reach the
// SAME action rather than re-testing reveal-before-focus and the clamps. Only
// the one delegating export is replaced; the rest of the module stays real.
const { mockFocusRegionDirection } = vi.hoisted(() => ({ mockFocusRegionDirection: vi.fn() }));
vi.mock('../../../renderer/services/regionFocus', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/services/regionFocus')>()),
	focusRegionDirection: (...args: unknown[]) => mockFocusRegionDirection(...args),
}));

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

/**
 * The two routes that do not need the leader chord.
 *
 * The leader ships UNASSIGNED in default mode, so without these two surfaces
 * Deck mode would exist for Vim mode alone and be invisible to everyone else.
 * The palette entry is the way in; the help sheet's section is where the table
 * can be read at leisure, which is also where the hint bar's one-sentence
 * announcement sends a screen reader user.
 */
describe('Deck mode without the leader chord', () => {
	describe('the Quick Actions entry that arms it', () => {
		const setQuickActionOpen = vi.fn();

		/** The feature commands, with only the argument this entry reads. */
		function build(deckMode?: (typeof DEFAULT_SHORTCUTS)[string]) {
			return buildFeatureCommands({
				activeSession: undefined,
				setQuickActionOpen,
				setSuccessFlashNotification: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				setActiveAgentSessionId: vi.fn(),
				bionifyReadingMode: false,
				setBionifyReadingMode: vi.fn(),
				audioFeedbackEnabled: false,
				setAudioFeedbackEnabled: vi.fn(),
				idleNotificationEnabled: false,
				setIdleNotificationEnabled: vi.fn(),
				showStarredSessionsSection: true,
				setShowStarredSessionsSection: vi.fn(),
				keyboardMode: 'default',
				shortcuts: { deckMode },
			});
		}

		function deckRow(deckMode?: (typeof DEFAULT_SHORTCUTS)[string]) {
			const found = build(deckMode).find((command) => command.id === DECK_MODE_LEADER_ID);
			if (!found) throw new Error('no palette entry for Deck mode');
			return found;
		}

		beforeEach(() => {
			vi.clearAllMocks();
		});

		// Global, like the keyboard-mode switch beside it: arming is about what the
		// NEXT keystroke means, not about what currently has focus, so it is
		// offered on a brand new install with nothing open.
		it('is offered with no agent and no active tab', () => {
			expect(build().map((command) => command.id)).toContain(DECK_MODE_LEADER_ID);
		});

		// The palette filters on the LABEL alone (a substring match, see
		// `filterAndSortQuickActions`), so the words a user would type have to be
		// in it. "Leader" is the one they reach for having read about tmux.
		it.each(['deck', 'Deck Mode', 'leader'])('is findable by searching %p', (search) => {
			const matches = filterAndSortQuickActions(build(), search, 'main');
			expect(matches.map((command) => command.id)).toContain(DECK_MODE_LEADER_ID);
		});

		it('is named the way the shortcut table names the leader', () => {
			// Not the identical string - the palette row is an ACTION ("Arm ...") -
			// but it has to carry the leader's own wording, or the palette and
			// Settings > Shortcuts read as two different features.
			expect(deckRow().label).toContain(DEFAULT_SHORTCUTS[DECK_MODE_LEADER_ID].label);
		});

		it('wears the live leader chord, and no badge while it is unbound', () => {
			const vimLeader = VIM_SHORTCUTS[DECK_MODE_LEADER_ID];
			expect(deckRow(vimLeader).shortcut).toBe(vimLeader);
			// Default mode ships it unassigned; QuickActionRow draws no pill for an
			// empty `keys`, which is the honest answer for a row whose whole point
			// is that it needs no chord.
			expect(deckRow(DEFAULT_SHORTCUTS[DECK_MODE_LEADER_ID]).shortcut?.keys).toEqual([]);
		});

		// The keys live on screen the moment the mode arms. A second, hand-written
		// list in this subtext would drift the first time a Deck key moved.
		it('counts the keys from the table instead of listing them', () => {
			const subtext = deckRow().subtext ?? '';
			expect(subtext).toContain(String(DECK_MODE_KEYS.length));
			expect(subtext).toContain(DECK_MODE_CANCEL.keys[0]);
			for (const row of DECK_MODE_KEYS) {
				expect(subtext).not.toContain(`\`${row.keys[0]}\``);
			}
		});

		describe('arming', () => {
			beforeEach(() => {
				vi.useFakeTimers();
			});

			afterEach(() => {
				vi.useRealTimers();
				useUIStore.getState().disarmDeckMode();
			});

			// THE REASON THIS IS DEFERRED. A number hotkey (Cmd+3) is not stopped
			// from propagating, so it reaches the window handler AFTER this action
			// has run - and an armed mode reads a chord as "the user meant something
			// else" and disarms. Arming synchronously would let the keystroke that
			// asked for the mode cancel it.
			it('waits for the palette to be gone before arming', () => {
				deckRow().action();

				expect(setQuickActionOpen).toHaveBeenCalledWith(false);
				expect(useUIStore.getState().deckModeArmed).toBe(false);

				act(() => {
					vi.runAllTimers();
				});
				expect(useUIStore.getState().deckModeArmed).toBe(true);
			});

			// The one-shot window is short, so it must start when the user can
			// actually spend it rather than while the palette still has focus.
			it('starts the clock at the arm, not at the click', () => {
				deckRow().action();
				act(() => {
					vi.runAllTimers();
				});

				expect(deckModeExpired(useUIStore.getState().deckModeArmedAt, Date.now())).toBe(false);
			});
		});
	});

	describe('the help sheet section', () => {
		const section = () => screen.queryByTestId('shortcuts-help-deck-mode');

		function renderSheet(shortcuts: Record<string, Shortcut> = DEFAULT_SHORTCUTS) {
			return render(
				<LayerStackProvider>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={shortcuts}
						tabShortcuts={TAB_SHORTCUTS}
						onClose={vi.fn()}
					/>
				</LayerStackProvider>
			);
		}

		afterEach(() => {
			cleanup();
		});

		it("draws one row per Deck key, in the table's order", () => {
			renderSheet();

			const rows = section()!.querySelectorAll('[data-deck-row]');
			expect(Array.from(rows).map((row) => row.getAttribute('data-deck-row'))).toEqual(
				DECK_MODE_HINT_ROWS.map((row) => row.id)
			);
			for (const row of DECK_MODE_HINT_ROWS) {
				const drawn = section()!.querySelector(`[data-deck-row="${row.id}"]`);
				expect(queryAllShortcutKeys(row.keys, drawn!)).toHaveLength(1);
				expect(drawn).toHaveTextContent(row.label);
			}
		});

		it('names the leader and the way out of the mode', () => {
			renderSheet();

			expect(section()).toHaveTextContent(DEFAULT_SHORTCUTS[DECK_MODE_LEADER_ID].label);
			expect(section()).toHaveTextContent(`${DECK_MODE_CANCEL.keys[0]} cancels`);
			// Quoted from the constant the mode expires on, so the figure here and
			// the behaviour cannot drift.
			expect(section()).toHaveTextContent(`${SEQUENCE_TIMEOUT_MS / 1000}s`);
			// The route that needs no chord at all, which is the only route in
			// default mode.
			expect(section()).toHaveTextContent('Quick Actions');
		});

		it('shows the bound leader chord, and says Unassigned while it is not', () => {
			renderSheet();
			expect(section()).toHaveTextContent('Unassigned');

			cleanup();
			renderSheet(VIM_SHORTCUTS as Record<string, Shortcut>);
			expect(
				getShortcutKeys(VIM_SHORTCUTS[DECK_MODE_LEADER_ID].keys!, section()!)
			).toBeInTheDocument();
		});

		// The hint bar hides its table from the accessibility tree because a live
		// region would read eighteen rows aloud over a mode that lives for a
		// second. This is the surface that announcement points at, so here the
		// table has to be readable.
		it('keeps the table in the accessibility tree, unlike the hint bar', () => {
			renderSheet();

			const row = section()!.querySelector('[data-deck-row]');
			expect(row!.closest('[aria-hidden="true"]')).toBeNull();
		});

		// A host that hands the sheet no leader entry has no Deck mode to
		// document; quoting a chord it never passed would be an invention.
		it('stands down when the host lists no leader', () => {
			renderSheet({});
			expect(section()).not.toBeInTheDocument();
		});
	});
});

/**
 * The two claims neither single-layer suite can make on its own.
 *
 * `contexts/LayerStackContext.test.tsx` proves the capture-phase listener
 * declines while the mode is armed, but against a MOCKED layer stack and with
 * no keyboard handler mounted, so it cannot show the modal surviving. The
 * handler suite proves Escape disarms, but with no layer stack at all, so it
 * cannot show the modal surviving either. Only both halves live in one tree
 * proves the thing the user is promised: one mistyped leader costs them one
 * keystroke, not their open modal as well.
 *
 * Mastery is the same shape. The handler suite asserts on a mocked
 * `recordShortcutUsage` and so can only see which ids were OFFERED. Whether
 * `focusRegionLeft` fired from Deck `h` and `focusRegionLeft` fired from
 * Ctrl+Shift+H land as one entry or two is the store's answer, and it is the
 * whole reason a Deck row carries the action's own id instead of one of its
 * own.
 */
describe('Deck mode where its layers meet', () => {
	/**
	 * Everything the handler must find on its context to run without throwing.
	 *
	 * Wired even for the branches a given case asserts did NOT run: a branch
	 * that fires with a missing collaborator throws inside the dispatched
	 * listener, and jsdom reports that as an uncaught exception rather than a
	 * failure - so the test would pass while the action it was policing had in
	 * fact fired and crashed.
	 */
	function keyboardContext(overrides: Record<string, unknown> = {}) {
		return {
			hasOpenLayers: () => false,
			hasOpenModal: () => false,
			editingSessionId: null,
			editingGroupId: null,
			activeGroupChatId: null,
			activeSessionId: 'session-1',
			sessions: [],
			handleSidebarNavigation: vi.fn().mockReturnValue(false),
			handleEnterToActivate: vi.fn().mockReturnValue(false),
			handleTabNavigation: vi.fn().mockReturnValue(false),
			handleEscapeInMain: vi.fn().mockReturnValue(false),
			handleNewTab: vi.fn(),
			setActiveFocus: vi.fn(),
			setQuickActionOpen: vi.fn(),
			mainPanelRef: { current: { clearActiveTerminal: vi.fn() } },
			...overrides,
		};
	}

	/**
	 * The real handler, with App.tsx's own render-time matcher assembly.
	 *
	 * The matchers are built from the LIVE tables rather than forced, because
	 * the claim being made is end-to-end: switching to Vim mode is the whole
	 * setup, and `Ctrl+;` then has to arm a mode nothing else was told about.
	 */
	function KeyboardHost({ ctx }: { ctx: Record<string, unknown> }): null {
		const { keyboardHandlerRef } = useMainKeyboardHandler();
		const { shortcuts, tabShortcuts } = useActiveShortcuts();
		const { isShortcut, isTabShortcut, isPaneShortcut } = useKeyboardShortcutHelpers({
			shortcuts,
			tabShortcuts,
		});
		// Assigned in the render body, which is App.tsx's arrangement too: the
		// handler reads this ref at EVENT time, so there is no stale-closure
		// window to miss and no effect ordering for a first keypress to fall into.
		keyboardHandlerRef.current = {
			...ctx,
			isShortcut,
			isTabShortcut,
			isPaneShortcut,
		} as never;
		return null;
	}

	/** A modal registered the way every modal in the app registers one. */
	function OpenModal({ onEscape }: { onEscape: () => void }): JSX.Element {
		useModalLayer(MODAL_PRIORITIES.SETTINGS, 'Test Modal', onEscape);
		return <div data-testid="open-modal" />;
	}

	/**
	 * Press a key the way a real one travels: capture DOWN from the window to
	 * the target, then bubble back up.
	 *
	 * Dispatched at `document.body` rather than at `window`, which matters here
	 * and nowhere else in this file. An event dispatched AT the window puts both
	 * listeners in the target phase, where they fire in registration order and
	 * the capture flag is ignored - so a pass would depend on which component
	 * mounted first. Through the body, `LayerStackProvider`'s capture listener is
	 * genuinely ahead of the handler's bubble listener, which is the ordering the
	 * yield exists to survive.
	 */
	function press(key: string, init: KeyboardEventInit = {}) {
		const event = new KeyboardEvent('keydown', {
			key,
			bubbles: true,
			cancelable: true,
			...init,
		});
		act(() => {
			document.body.dispatchEvent(event);
		});
		return event;
	}

	/** The leader exactly as a keyboard sends it in Vim mode: Ctrl+; */
	const pressLeader = () => press(';', { ctrlKey: true });

	beforeEach(() => {
		mockFocusRegionDirection.mockClear();
		setKeyboardMode('vim');
		// An AI-mode session, so the terminal blocks above the ladder stay out of
		// the way. Resolved from the store at event time, not from the context.
		useSessionStore.setState({
			sessions: [{ id: 'session-1', name: 'Test', inputMode: 'ai' }] as never,
			activeSessionId: 'session-1',
		});
		useUIStore.getState().disarmDeckMode();
	});

	afterEach(() => {
		useUIStore.getState().disarmDeckMode();
		useSessionStore.setState({ sessions: [], activeSessionId: '' });
		setKeyboardMode('default');
	});

	describe('Escape while armed', () => {
		it('cancels the mode and leaves the open modal open', () => {
			const onModalEscape = vi.fn();
			const ctx = keyboardContext({ hasOpenLayers: () => true, hasOpenModal: () => true });
			render(
				<LayerStackProvider>
					<KeyboardHost ctx={ctx} />
					<OpenModal onEscape={onModalEscape} />
				</LayerStackProvider>
			);

			// Arming is allowed over an open layer: the Deck block sits above the
			// handler's layer guard precisely so the leader still works there.
			pressLeader();
			expect(useUIStore.getState().deckModeArmed).toBe(true);

			const event = press('Escape');

			expect(useUIStore.getState().deckModeArmed).toBe(false);
			// The whole point. One mistyped leader costs one keystroke, not the
			// modal the user had open behind it.
			expect(onModalEscape).not.toHaveBeenCalled();
			expect(screen.getByTestId('open-modal')).toBeInTheDocument();
			// Swallowed by the handler rather than by the layer stack, which is what
			// the capture-phase yield made possible.
			expect(event.defaultPrevented).toBe(true);
		});

		it('hands Escape back to the modal on the very next press', () => {
			const onModalEscape = vi.fn();
			const ctx = keyboardContext({ hasOpenLayers: () => true, hasOpenModal: () => true });
			render(
				<LayerStackProvider>
					<KeyboardHost ctx={ctx} />
					<OpenModal onEscape={onModalEscape} />
				</LayerStackProvider>
			);

			pressLeader();
			press('Escape');
			press('Escape');

			// The yield is scoped to the armed keystroke. A mode that kept Escape
			// after cancelling would leave the modal unclosable.
			expect(onModalEscape).toHaveBeenCalledTimes(1);
		});

		it('leaves the modal alone for the mode it never armed', () => {
			// Default mode ships the leader unbound, so the same two keystrokes
			// there are an unmatched `Ctrl+;` and an ordinary Escape - and the
			// modal closes on the first press, not the second.
			setKeyboardMode('default');
			const onModalEscape = vi.fn();
			const ctx = keyboardContext({ hasOpenLayers: () => true, hasOpenModal: () => true });
			render(
				<LayerStackProvider>
					<KeyboardHost ctx={ctx} />
					<OpenModal onEscape={onModalEscape} />
				</LayerStackProvider>
			);

			pressLeader();
			expect(useUIStore.getState().deckModeArmed).toBe(false);

			press('Escape');

			expect(onModalEscape).toHaveBeenCalledTimes(1);
		});
	});

	describe('what keyboard mastery records', () => {
		/** The REAL store action, which is the thing under test here. */
		function masteryContext(overrides: Record<string, unknown> = {}) {
			return keyboardContext({
				recordShortcutUsage: (id: string) => useSettingsStore.getState().recordShortcutUsage(id),
				...overrides,
			});
		}

		/** The action ids the mastery set has collected, in order. */
		const used = () => useSettingsStore.getState().keyboardMasteryStats.usedShortcuts;

		beforeEach(() => {
			act(() => {
				useSettingsStore.setState({
					keyboardMasteryStats: {
						usedShortcuts: [],
						currentLevel: 0,
						lastLevelUpTimestamp: 0,
						lastAcknowledgedLevel: 0,
					},
				});
			});
		});

		it('records the leader, which is an action with a row of its own', () => {
			render(<KeyboardHost ctx={masteryContext()} />);

			pressLeader();

			expect(used()).toEqual([DECK_MODE_LEADER_ID]);
		});

		// The reason a Deck row carries the action's own id rather than one of its
		// own: mastery is meant to mean "you know this action", not "you know this
		// keystroke", so learning a second route to an action you already have
		// must not move the number.
		it('counts one action however it was fired, not one per route', () => {
			render(<KeyboardHost ctx={masteryContext()} />);

			// Route one: the Deck key, from the leader.
			pressLeader();
			press('h');
			expect(mockFocusRegionDirection).toHaveBeenCalledWith('left');
			expect(used()).toEqual([DECK_MODE_LEADER_ID, 'focusRegionLeft']);

			// Route two: the chord Vim mode binds to the same action.
			press('h', { ctrlKey: true, shiftKey: true });

			expect(mockFocusRegionDirection).toHaveBeenCalledTimes(2);
			expect(used().filter((id) => id === 'focusRegionLeft')).toHaveLength(1);
			expect(used()).toEqual([DECK_MODE_LEADER_ID, 'focusRegionLeft']);
		});

		// The order a user would actually learn them in is the other way round, so
		// run it that way too: the chord first, then the Deck route they discover
		// later. Neither route may add a second entry.
		it('counts one action with the chord learned first', () => {
			render(<KeyboardHost ctx={masteryContext()} />);

			press('h', { ctrlKey: true, shiftKey: true });
			expect(used()).toEqual(['focusRegionLeft']);

			pressLeader();
			press('h');

			expect(used()).toEqual(['focusRegionLeft', DECK_MODE_LEADER_ID]);
		});

		// No `deckH`, no `deck.focusRegionLeft`, nothing the mastery denominator
		// has never heard of: every id in the set has to be an action with a row
		// in Settings > Shortcuts, or the percentage is measured against a
		// different population than it is reported for.
		it('puts no Deck-specific id into the set', () => {
			render(<KeyboardHost ctx={masteryContext()} />);

			pressLeader();
			press('h');
			pressLeader();
			press('q'); // a miss, which fires nothing and so records nothing
			pressLeader();
			press('Escape'); // cancel, which is the mode's behaviour, not an action

			for (const id of used()) {
				expect(DEFAULT_SHORTCUTS[id] ?? TAB_SHORTCUTS[id]).toBeDefined();
			}
			expect(used()).toEqual([DECK_MODE_LEADER_ID, 'focusRegionLeft']);
		});
	});
});
