/**
 * Keyboard modes, the edge cases: what has to be true at the MOMENT a mode
 * changes or the window goes away, rather than before and after.
 *
 * Everything here is about state that is only alive for a second. A sequence
 * prefix, an armed Deck window, and an in-field `jk` run are each half of a
 * keyboard idea the user has not finished having, and all three are matched
 * against the LIVE mode's bindings. So a run that outlives the mode it was
 * started in does not merely look stale: it completes against a different
 * table and fires an action the user never asked for. A `g` typed in default
 * mode, followed by a switch and a `t`, fired Vim mode's `g t`.
 *
 * The three suites below are the three ways that second can end:
 *
 *  - The MODE changes, from any of its five routes. Only one of them (the
 *    `Opt+Cmd+V` chord) passes through the keyboard handler at all, so the
 *    abandonment is subscribed to the store rather than hung off the chord.
 *  - The WINDOW loses focus, which has two owners: the handler resets the two
 *    matchers, and `armDeckMode`'s own blur guard in `uiStore` disarms Deck
 *    mode. Each half has a test of its own already; what neither can see is
 *    that ONE blur does both, which is the thing a user with a prefix typed
 *    inside an armed Deck window actually needs.
 *  - The SETTINGS FILE changes outside this window (`maestro-cli settings
 *    set`, a hand edit, or a peer window's write). The main process broadcasts
 *    `settings:externalChange` to every window from
 *    `src/main/app-lifecycle/settings-watcher.ts`, and the renderer answers it
 *    by re-running `loadAllSettings`. A second window has to FOLLOW a mode
 *    change made in the first, including both Vim buckets, or its chords and
 *    the first window's silently disagree.
 *
 * The real store, the real `loadAllSettings`, and the real keyboard handler
 * throughout. A mocked slice would hide the one class of bug these are for:
 * a piece of pending state nobody remembered to clear.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMainKeyboardHandler } from '../../renderer/hooks/keyboard/useMainKeyboardHandler';
import { useReloadSettingsOnExternalChange } from '../../renderer/hooks/settings/useWindowSettingsSync';
import { loadAllSettings, useSettingsStore } from '../../renderer/stores/settingsStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useSequencePrefixStore } from '../../renderer/stores/sequencePrefixStore';
import { deckModeArmedNow, useUIStore } from '../../renderer/stores/uiStore';
import { switchKeyboardMode } from '../../renderer/services/keyboardMode';
import { DECK_MODE_LEADER_ID } from '../../renderer/constants/deckMode';
import { DEFAULT_SHORTCUTS, TAB_SHORTCUTS } from '../../renderer/constants/shortcuts';
import { VIM_SHORTCUTS, VIM_TAB_SHORTCUTS } from '../../renderer/constants/vimShortcuts';
import { resetStore } from '../helpers';

/** What the prefix indicator is currently drawing. */
function publishedPrefix(): readonly string[][] {
	return useSequencePrefixStore.getState().prefix;
}

/** The Deck leader's chord, as `press` spells it below. */
const LEADER_KEY = ';';

/**
 * A keyboard-handler context with `toggleSidebar` reachable ONLY through the
 * `g s` sequence, and the Deck leader reachable through `isShortcut`.
 *
 * `toggleSidebar` is the probe rather than a real binding because a sequence
 * is the only pending state that is genuinely mode-dependent: `feed` takes the
 * live binding list per call, so whether `g s` fires at all depends on which
 * mode is live when the SECOND key lands. If the run survived a switch, the
 * second key would be matched against a table the first key was never offered.
 *
 * `isShortcut` reads the EVENT as well as the id. Answering on the id alone
 * makes every keypress the leader, which arms Deck mode and returns before the
 * sequence block - and the suite then passes or fails for a reason that has
 * nothing to do with what it is testing.
 */
function sequenceContext(overrides: Record<string, unknown> = {}) {
	return {
		hasOpenLayers: () => false,
		hasOpenModal: () => false,
		editingSessionId: null,
		editingGroupId: null,
		handleSidebarNavigation: vi.fn().mockReturnValue(false),
		handleEnterToActivate: vi.fn().mockReturnValue(false),
		handleTabNavigation: vi.fn().mockReturnValue(false),
		handleEscapeInMain: vi.fn().mockReturnValue(false),
		isShortcut: (e: KeyboardEvent, id: string) =>
			id === DECK_MODE_LEADER_ID && e.key === LEADER_KEY && e.ctrlKey,
		isTabShortcut: () => false,
		isPaneShortcut: () => false,
		setActiveFocus: vi.fn(),
		handleNewTab: vi.fn(),
		leftSidebarOpen: true,
		setLeftSidebarOpen: vi.fn(),
		sequenceBindings: [{ id: 'toggleSidebar', sequence: [['g'], ['s']] }],
		recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
		sessions: [{ id: 'session-1' }],
		activeSessionId: 'session-1',
		activeGroupChatId: null,
		...overrides,
	};
}

describe('keyboard mode hardening', () => {
	let unmount: (() => void) | null = null;
	let originalMaestro: unknown;

	/**
	 * Mount the real handler and hand it `ctx`, torn down after the test.
	 *
	 * The session store is seeded as well as the context, because the active
	 * session is resolved at EVENT time from the store - and `toggleSidebar`'s
	 * ladder branch is gated on there being one, so without this the sequence
	 * matches and then fires nothing.
	 */
	function mountHandler(ctx: Record<string, unknown>) {
		useSessionStore.setState({
			sessions: [{ id: 'session-1' }] as never,
			activeSessionId: 'session-1',
		});
		const rendered = renderHook(() => useMainKeyboardHandler());
		unmount = rendered.unmount;
		rendered.result.current.keyboardHandlerRef.current = ctx as never;
		return rendered;
	}

	/** Press a bare key, the shape every sequence step and Deck key arrives in. */
	function press(key: string, init: KeyboardEventInit = {}) {
		const event = new KeyboardEvent('keydown', {
			key,
			bubbles: true,
			cancelable: true,
			...init,
		});
		act(() => {
			window.dispatchEvent(event);
		});
		return event;
	}

	beforeEach(() => {
		resetStore(useSettingsStore);
		resetStore(useSessionStore);
		resetStore(useUIStore);
		useSequencePrefixStore.getState().setSequencePrefix([]);
		originalMaestro = (window as unknown as Record<string, unknown>).maestro;
		const maestro = ((window as unknown as Record<string, unknown>).maestro ?? {}) as Record<
			string,
			unknown
		>;
		(window as unknown as Record<string, unknown>).maestro = {
			...maestro,
			process: { ...((maestro.process as Record<string, unknown>) ?? {}), write: vi.fn() },
		};
	});

	afterEach(() => {
		// The handler's listeners have to go, or the next test's keypresses also
		// reach this one's context. Deck mode is disarmed because arming installs
		// a window-blur listener that lives in the store, not in the component.
		unmount?.();
		unmount = null;
		useUIStore.getState().disarmDeckMode();
		(window as unknown as Record<string, unknown>).maestro = originalMaestro;
		document.body.innerHTML = '';
		vi.clearAllMocks();
	});

	/**
	 * A mode switch is a deliberate fresh start, and every route into one has to
	 * mean that: the chord, the palette, the hamburger menu, the Settings toggle
	 * (which calls `setKeyboardMode` directly and never reaches
	 * `switchKeyboardMode`), and an external settings-file change.
	 */
	describe('a mode switch abandons every half-finished keyboard idea', () => {
		it('drops a live sequence prefix, so the next key cannot finish the old run', () => {
			const setLeftSidebarOpen = vi.fn();
			mountHandler(sequenceContext({ setLeftSidebarOpen }));

			press('g');
			// Asserted live first, or the test passes for a prefix that was never
			// captured at all.
			expect(publishedPrefix()).toEqual([['g']]);

			act(() => {
				switchKeyboardMode('vim');
			});

			expect(publishedPrefix()).toEqual([]);
			// The matcher's own buffer, not just the chip: a reset chip over a live
			// buffer is the worse of the two bugs, because the run then completes
			// invisibly.
			press('s');
			expect(setLeftSidebarOpen).not.toHaveBeenCalled();
		});

		it('leaves the matcher usable: a fresh run in the new mode still fires', () => {
			// `reset()` and "wedged shut" look identical one keypress in. The next
			// full run is what tells them apart.
			const setLeftSidebarOpen = vi.fn();
			mountHandler(sequenceContext({ setLeftSidebarOpen }));

			press('g');
			act(() => {
				switchKeyboardMode('vim');
			});

			press('g');
			press('s');
			expect(setLeftSidebarOpen).toHaveBeenCalledTimes(1);
		});

		it('disarms Deck mode, so the next bare key is not swallowed by the old window', () => {
			const setLeftSidebarOpen = vi.fn();
			mountHandler(sequenceContext({ setLeftSidebarOpen }));

			// The leader arrives as a chord through `isShortcut`, the way it does
			// in the app; this context gives it to `DECK_MODE_LEADER_ID`.
			press(LEADER_KEY, { ctrlKey: true });
			expect(deckModeArmedNow()).toBe(true);

			act(() => {
				switchKeyboardMode('vim');
			});

			expect(deckModeArmedNow()).toBe(false);
			expect(useUIStore.getState().deckModeArmedAt).toBe(0);
		});

		it('abandons both at once when a prefix and an armed window are both live', () => {
			// The two cannot both be reached by keypresses - the leader resets the
			// matcher on its way in, and an armed window then swallows every bare
			// key - so the state is set up through the two stores that own it,
			// which is the same pair the handler writes. What is under test is
			// that ONE mode change reaches both owners.
			mountHandler(sequenceContext());

			useSequencePrefixStore.getState().setSequencePrefix([['g']]);
			useUIStore.getState().armDeckMode();
			expect(deckModeArmedNow()).toBe(true);

			act(() => {
				switchKeyboardMode('vim');
			});

			expect(publishedPrefix()).toEqual([]);
			expect(deckModeArmedNow()).toBe(false);
		});

		it('abandons on the Settings toggle, which never calls switchKeyboardMode', () => {
			// The one route that writes the mode directly: the Settings toggle has
			// to disarm its own pending reset and the rows below it ARE the
			// acknowledgement, so it deliberately skips the service. Subscribing to
			// the store is what makes this route behave like the other four.
			const setLeftSidebarOpen = vi.fn();
			mountHandler(sequenceContext({ setLeftSidebarOpen }));

			press('g');
			expect(publishedPrefix()).toEqual([['g']]);
			useUIStore.getState().armDeckMode();

			act(() => {
				useSettingsStore.getState().setKeyboardMode('vim');
			});

			expect(publishedPrefix()).toEqual([]);
			expect(deckModeArmedNow()).toBe(false);
			// The matcher, not just the chip.
			press('s');
			expect(setLeftSidebarOpen).not.toHaveBeenCalled();
		});

		it('leaves pending state alone when the mode is written but unchanged', () => {
			// A write of the mode already live is not a switch. Clearing on one
			// would make an unrelated settings reload (a theme change in a peer
			// window re-runs the whole hydration) eat a prefix the user is
			// halfway through.
			mountHandler(sequenceContext());

			press('g');
			expect(publishedPrefix()).toEqual([['g']]);

			act(() => {
				useSettingsStore.getState().setKeyboardMode('default');
			});

			expect(publishedPrefix()).toEqual([['g']]);
		});

		it('survives rapid toggling, with nothing pending and the matcher still live', () => {
			// Four switches in four ticks, with a prefix and an armed window
			// re-created between them. The failure this is for is a subscription
			// that fires once, or one whose unsubscribe runs on the first change.
			const setLeftSidebarOpen = vi.fn();
			mountHandler(sequenceContext({ setLeftSidebarOpen }));

			for (const mode of ['vim', 'default', 'vim', 'default'] as const) {
				press('g');
				press(LEADER_KEY, { ctrlKey: true });
				act(() => {
					switchKeyboardMode(mode);
				});
				expect(publishedPrefix()).toEqual([]);
				expect(deckModeArmedNow()).toBe(false);
			}

			expect(useSettingsStore.getState().keyboardMode).toBe('default');
			press('g');
			press('s');
			expect(setLeftSidebarOpen).toHaveBeenCalledTimes(1);
		});

		it('stops abandoning once the handler is unmounted', () => {
			// The subscription is created inside the keydown effect, so it has to
			// be torn down with it. A leaked one would keep clearing a store a
			// dead handler no longer feeds, and would accumulate one per remount.
			//
			// The PREFIX is what this can assert. Deck mode deliberately has a
			// second owner that does not depend on anything being mounted
			// (`setKeyboardMode` disarms it directly), so it stays disarmed here
			// whether or not the subscription leaked - which is the behaviour
			// wanted, and the reason it is not the probe.
			mountHandler(sequenceContext());
			unmount?.();
			unmount = null;

			useSequencePrefixStore.getState().setSequencePrefix([['g']]);

			act(() => {
				switchKeyboardMode('vim');
			});

			expect(publishedPrefix()).toEqual([['g']]);
		});
	});

	/**
	 * Window blur. Both halves already have a test of their own - the matcher
	 * reset in `useMainKeyboardHandler.test.ts`, the Deck guard in
	 * `uiStore.test.ts` - and they live in different modules with different
	 * lifetimes, so nothing proved one blur reaches both.
	 */
	describe('window blur', () => {
		it('clears the sequence prefix and disarms Deck mode in one event', () => {
			// Two owners with different lifetimes: the handler's effect resets the
			// matchers, and the guard `armDeckMode` installs in `uiStore` disarms
			// the window. Both are driven by the same `blur`, and neither suite
			// that covers one of them can see the other.
			mountHandler(sequenceContext());

			useSequencePrefixStore.getState().setSequencePrefix([['g']]);
			useUIStore.getState().armDeckMode();
			expect(deckModeArmedNow()).toBe(true);

			act(() => {
				window.dispatchEvent(new Event('blur'));
			});

			expect(publishedPrefix()).toEqual([]);
			expect(deckModeArmedNow()).toBe(false);
		});

		it('clears a prefix with no Deck window involved', () => {
			const setLeftSidebarOpen = vi.fn();
			mountHandler(sequenceContext({ setLeftSidebarOpen }));

			press('g');
			expect(publishedPrefix()).toEqual([['g']]);

			act(() => {
				window.dispatchEvent(new Event('blur'));
			});

			expect(publishedPrefix()).toEqual([]);
			// And the buffer with it: the keys that would have finished the run
			// went to another window.
			press('s');
			expect(setLeftSidebarOpen).not.toHaveBeenCalled();
		});

		it('leaves the matcher usable for the next run after the window comes back', () => {
			const setLeftSidebarOpen = vi.fn();
			mountHandler(sequenceContext({ setLeftSidebarOpen }));

			press('g');
			act(() => {
				window.dispatchEvent(new Event('blur'));
			});

			press('g');
			press('s');
			expect(setLeftSidebarOpen).toHaveBeenCalledTimes(1);
		});
	});

	/**
	 * An externally changed settings file. The watcher in
	 * `src/main/app-lifecycle/settings-watcher.ts` broadcasts
	 * `settings:externalChange` to EVERY window (targeting only the main one is
	 * the bug that left secondary windows stuck on their mount-time settings),
	 * and the renderer answers by re-running `loadAllSettings`.
	 *
	 * So this suite drives the renderer half: the handler the preload bridge
	 * calls, and what the store holds afterwards. The two Vim buckets matter as
	 * much as the mode does - a window that followed the mode but kept its old
	 * overrides would resolve a set neither window has.
	 */
	describe('an externally changed settings file', () => {
		/** The `onExternalChange` handler the hook registered. */
		let notifyExternalChange: (() => void) | null = null;

		beforeEach(() => {
			const maestro = (window as unknown as Record<string, unknown>).maestro as Record<
				string,
				unknown
			>;
			maestro.settings = {
				...((maestro.settings as Record<string, unknown>) ?? {}),
				getAll: vi.fn().mockResolvedValue({}),
				set: vi.fn().mockResolvedValue(true),
				onExternalChange: (handler: () => void) => {
					notifyExternalChange = handler;
					return () => {
						notifyExternalChange = null;
					};
				},
			};
			maestro.logger = {
				...((maestro.logger as Record<string, unknown>) ?? {}),
				getLogLevel: vi.fn().mockResolvedValue('info'),
				getMaxLogBuffer: vi.fn().mockResolvedValue(1000),
			};
			maestro.cueStats = { getHistoricalConductorCredit: vi.fn().mockResolvedValue(0) };
			maestro.power = {
				setEnabled: vi.fn().mockResolvedValue(undefined),
				setKeepDisplayAwake: vi.fn().mockResolvedValue(undefined),
			};
		});

		/** Mount the listener the same way a renderer window does. */
		function mountListener() {
			const rendered = renderHook(() => useReloadSettingsOnExternalChange());
			return rendered.unmount;
		}

		/** Put `file` on disk and fire the broadcast, awaiting the reload. */
		async function externalChange(file: Record<string, unknown>): Promise<void> {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue(file);
			await act(async () => {
				notifyExternalChange?.();
				// `onExternalChange` fires `loadAllSettings` without awaiting it,
				// so the flush has to be waited on here rather than there.
				await Promise.resolve();
				await Promise.resolve();
			});
		}

		it('follows a mode change made in another window', async () => {
			const unmountListener = mountListener();
			// Hydrated first, so the in-flight filter in `loadAllSettings` is
			// live: it only applies once `settingsLoaded` is true, and it is the
			// thing that could drop `keyboardMode` from the patch.
			await act(async () => {
				await loadAllSettings();
			});
			expect(useSettingsStore.getState().keyboardMode).toBe('default');

			await externalChange({ keyboardMode: 'vim' });

			expect(useSettingsStore.getState().keyboardMode).toBe('vim');
			unmountListener();
		});

		it('follows both Vim buckets, not just the mode', async () => {
			const unmountListener = mountListener();
			await act(async () => {
				await loadAllSettings();
			});

			await externalChange({
				keyboardMode: 'vim',
				vimShortcuts: {
					...VIM_SHORTCUTS,
					toggleSidebar: { id: 'toggleSidebar', keys: ['Alt', 'Home'] },
				},
				vimTabShortcuts: {
					...VIM_TAB_SHORTCUTS,
					newTab: { id: 'newTab', keys: ['Alt', 'Insert'] },
				},
			});

			const state = useSettingsStore.getState();
			expect(state.keyboardMode).toBe('vim');
			expect(state.vimShortcuts.toggleSidebar?.keys).toEqual(['Alt', 'Home']);
			expect(state.vimTabShortcuts.newTab?.keys).toEqual(['Alt', 'Insert']);
			// The default buckets are untouched by a Vim-only write, which is the
			// same two-bucket invariant the round-trip suite proves in memory.
			expect(state.shortcuts.toggleSidebar.keys).toEqual(DEFAULT_SHORTCUTS.toggleSidebar.keys);
			expect(state.tabShortcuts.newTab.keys).toEqual(TAB_SHORTCUTS.newTab.keys);
			unmountListener();
		});

		it('follows a switch back to default mode', async () => {
			// The reverse direction is not symmetric in the hydration: the branch
			// reads `allSettings['keyboardMode'] !== undefined`, so a file that
			// stops mentioning the key keeps the live value, while one that spells
			// `default` moves it.
			const unmountListener = mountListener();
			await act(async () => {
				await loadAllSettings();
			});

			await externalChange({ keyboardMode: 'vim' });
			expect(useSettingsStore.getState().keyboardMode).toBe('vim');

			await externalChange({ keyboardMode: 'default' });
			expect(useSettingsStore.getState().keyboardMode).toBe('default');
			unmountListener();
		});

		it('abandons pending keyboard state, so the second window behaves like the first', async () => {
			// The payoff of subscribing to the store rather than to the switch
			// routes: a window that was never touched follows the mode AND drops
			// whatever its own user had half-typed.
			mountHandler(sequenceContext());
			const unmountListener = mountListener();
			await act(async () => {
				await loadAllSettings();
			});

			press('g');
			press(LEADER_KEY, { ctrlKey: true });
			expect(deckModeArmedNow()).toBe(true);

			await externalChange({ keyboardMode: 'vim' });

			expect(useSettingsStore.getState().keyboardMode).toBe('vim');
			expect(publishedPrefix()).toEqual([]);
			expect(deckModeArmedNow()).toBe(false);
			unmountListener();
		});

		it('stops following once the window unmounts its listener', async () => {
			const unmountListener = mountListener();
			await act(async () => {
				await loadAllSettings();
			});
			unmountListener();

			await externalChange({ keyboardMode: 'vim' });

			expect(useSettingsStore.getState().keyboardMode).toBe('default');
		});
	});
});
