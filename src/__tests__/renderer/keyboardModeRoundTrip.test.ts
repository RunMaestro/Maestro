/**
 * Keyboard modes, end to end: the whole round trip a real install makes.
 *
 * The layers below this one are each covered on their own - the pure resolver
 * in `shared/effectiveShortcuts.test.ts`, the shipped tables in
 * `renderer/constants/shortcuts.test.ts`, the store wiring in
 * `renderer/stores/keyboardMode.test.ts`. What none of them can see is the
 * whole journey: a settings file on disk, hydrated into two independent
 * buckets, resolved into one live set, edited through the Settings door,
 * written back, and read again. Every promise this feature makes is a property
 * of that journey rather than of any one step in it, and each is invisible
 * when it works:
 *
 *  - Customizations in one mode are never written by the other, however many
 *    times the user switches or resets.
 *  - The upgrade EVERY current user is about to make (a persisted `shortcuts` /
 *    `tabShortcuts` pair and no Vim keys at all) keeps their chords, gives the
 *    Vim buckets their shipped tables, and inherits their own chords in Vim
 *    mode rather than the factory ones.
 *  - A hand-edited or half-written settings value degrades to something usable
 *    instead of throwing. A throw inside hydration is caught by
 *    `loadAllSettings`, which abandons the WHOLE patch, so one malformed chord
 *    silently reverts every other setting in the file.
 *  - Switching modes is a read of everything except the mode itself. It must
 *    not touch a tab, a transcript, a panel, an agent, or the mastery count.
 *
 * The real store is seeded and the real `loadAllSettings` is run against a
 * mocked settings file (TEST-PATTERNS.md, "Mocking Zustand Stores"), rather
 * than mocking the slice: a bucket that hydrates into the wrong place is
 * exactly the class of bug a mock would hide. The one component rendered here
 * is the real `ShortcutsTab`, because its own suite mocks `useActiveShortcuts`
 * and so nothing else proves a displaced action reaches the screen.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import type { RenderHookResult } from '@testing-library/react';
import { useSettingsStore, loadAllSettings } from '../../renderer/stores/settingsStore';
import {
	selectActiveShortcuts,
	selectActiveTabShortcuts,
	selectVimDisplacedActions,
	selectMasteryBoundShortcuts,
	type MasteryShortcutsState,
} from '../../renderer/stores/settingsShortcutsSlice';
import { useActiveShortcuts } from '../../renderer/hooks/settings/useActiveShortcuts';
import type { UseActiveShortcutsReturn } from '../../renderer/hooks/settings/useActiveShortcuts';
import { switchKeyboardMode } from '../../renderer/services/keyboardMode';
import { ShortcutsTab } from '../../renderer/components/Settings/tabs/ShortcutsTab';
import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	TAB_SHORTCUTS,
} from '../../renderer/constants/shortcuts';
import { VIM_SHORTCUTS, VIM_TAB_SHORTCUTS } from '../../renderer/constants/vimShortcuts';
import {
	createSequenceMatcher,
	collectSequenceBindings,
} from '../../renderer/utils/shortcutSequence';
import { shortcutKeysCollide } from '../../shared/shortcutKeys';
import { KEYBOARD_MODES, type KeyboardMode } from '../../shared/shortcut-types';
import type { Shortcut } from '../../renderer/types';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useUIStore } from '../../renderer/stores/uiStore';
import { isIntentionallySharedByIds } from '../helpers/shortcutModes';
import { mockTheme } from '../helpers/mockTheme';
import { createMockSession, createMockAITab, resetStore } from '../helpers';

/**
 * Chords on keys NO shipped table binds, in either mode, and that
 * `RESERVED_SHORTCUT_COMBOS` leaves alone - so the hydration's reserved-chord
 * strip cannot quietly revert one on the reload leg of a round trip.
 *
 * `Home`, `End`, and `Insert` are the three keys `shortcuts.ts`,
 * `vimShortcuts.ts`, and `deckMode.ts` between them never mention. Each chord
 * below canonicalizes differently under the Meta/Ctrl collapse
 * (`alt+home`, `end+meta`, `alt+home+shift`, `alt+end+meta`, `alt+insert`), so
 * no two of them are one keypress either.
 */
const CHORD_SIDEBAR = ['Alt', 'Home'];
const CHORD_SETTINGS = ['Ctrl', 'End'];
const CHORD_CLOSE_TAB = ['Alt', 'Shift', 'Home'];
const CHORD_RIGHT_PANEL = ['Ctrl', 'Alt', 'End'];
const CHORD_NEW_TAB = ['Alt', 'Insert'];

/** The chord `VIM_TAB_SHORTCUTS` gives Previous Tab, spelled as a user records it. */
const VIM_PREV_TAB_CHORD = ['Ctrl', 'PageUp'];

type ShortcutsHook = RenderHookResult<UseActiveShortcutsReturn, unknown>;

/**
 * Switch the live mode through the route every chord, palette command, and
 * menu item takes.
 *
 * `switchKeyboardMode` rather than `setKeyboardMode`: it is what the user
 * actually reaches, it raises the acknowledgement that names the displaced
 * actions, and it is the one place a switch could grow a side effect on some
 * other store without any store-level test noticing.
 */
function switchMode(mode: KeyboardMode): void {
	act(() => {
		switchKeyboardMode(mode);
	});
}

/**
 * Record a chord for one action through the live mode's door.
 *
 * Shaped like the recorder in Settings > Shortcuts, which hands back the whole
 * map it was shown with one row changed. That shape is the point: the diff in
 * `overridesWithEdits` is the only thing that knows WHICH binding moved, and a
 * test that wrote the bucket directly would skip it.
 */
function recordChord(hook: ShortcutsHook, id: string, keys: string[]): void {
	act(() => {
		const { shortcuts, setShortcuts } = hook.result.current;
		setShortcuts({ ...shortcuts, [id]: { ...shortcuts[id], keys } });
	});
}

/** The same, for an action the tab matcher owns. */
function recordTabChord(hook: ShortcutsHook, id: string, keys: string[]): void {
	act(() => {
		const { tabShortcuts, setTabShortcuts } = hook.result.current;
		setTabShortcuts({ ...tabShortcuts, [id]: { ...tabShortcuts[id], keys } });
	});
}

/** Every `settings.set` so far, collapsed to the file a reload would read. */
function persistedSettings(): Record<string, unknown> {
	const persisted: Record<string, unknown> = {};
	for (const [key, value] of vi.mocked(window.maestro.settings.set).mock.calls) {
		persisted[key] = value;
	}
	return persisted;
}

/** Wipe the store and hydrate it from `file`, the way a cold start does. */
async function loadFile(file: Record<string, unknown>): Promise<void> {
	resetStore(useSettingsStore);
	vi.mocked(window.maestro.settings.getAll).mockResolvedValue(file);
	await act(async () => {
		await loadAllSettings();
	});
}

/**
 * Every action a mode can fire, read off the LIVE STORE rather than off the
 * constants.
 *
 * `shortcuts.test.ts` runs the same two guards over the shipped tables. This
 * reads the hydrated buckets instead, which is the half that can go wrong
 * without the tables changing at all: a bucket hydrated into the wrong key, a
 * migration that dropped a map, or a persisted customization that lands on a
 * chord another action already holds.
 *
 * `FIXED_SHORTCUTS` is appended because it belongs to every mode: it is not
 * rebindable and no override bucket may name it, so a mode chord landing on
 * one of its chords is a real collision.
 */
function actionsForMode(mode: KeyboardMode): Shortcut[] {
	const state = { ...useSettingsStore.getState(), keyboardMode: mode };
	return [
		...Object.values(selectActiveShortcuts(state)),
		...Object.values(selectActiveTabShortcuts(state)),
		...Object.values(FIXED_SHORTCUTS),
	];
}

/**
 * The ids a mode may legitimately leave unbound: registered-but-unassigned in
 * the hydrated base buckets, and not given a chord by this mode.
 *
 * Derived rather than listed, so an action that gains or loses a default chord
 * needs no edit here.
 */
function expectedUnbound(mode: KeyboardMode): string[] {
	const state = useSettingsStore.getState();
	const unassigned = [
		...Object.values(state.shortcuts),
		...Object.values(state.tabShortcuts),
		...Object.values(FIXED_SHORTCUTS),
	]
		.filter((sc) => sc.keys.length === 0)
		.map((sc) => sc.id);
	if (mode !== 'vim') return unassigned.sort();
	return unassigned
		.filter(
			(id) => !state.vimShortcuts[id]?.keys?.length && !state.vimTabShortcuts[id]?.keys?.length
		)
		.sort();
}

describe('keyboard mode round trip', () => {
	beforeEach(() => {
		resetStore(useSettingsStore);
		resetStore(useSessionStore);
		resetStore(useUIStore);
		// `loadAllSettings` reaches for both of these and neither is in the
		// global `window.maestro` mock. The Cue one backfills `cueTimeMs` once;
		// "no retained history" is the answer that makes it a no-op.
		if (!window.maestro.power) {
			(window.maestro as unknown as Record<string, unknown>).power = {
				setEnabled: vi.fn().mockResolvedValue(undefined),
				setKeepDisplayAwake: vi.fn().mockResolvedValue(undefined),
			};
		}
		(window.maestro as unknown as Record<string, unknown>).cueStats = {
			getHistoricalConductorCredit: vi.fn().mockResolvedValue(0),
		};
		vi.clearAllMocks();
		// Re-stated after the clear: these tests read the recorded `set` calls
		// back as a settings file, and several feed that file to `getAll`.
		vi.mocked(window.maestro.settings.set).mockResolvedValue(true);
		vi.mocked(window.maestro.settings.getAll).mockResolvedValue({});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('five customizations across four mode switches', () => {
		it('keeps all five, with their exact chords, in whichever mode owns them', () => {
			// The single promise that makes two modes usable at once. Each edit
			// lands in the bucket of the mode that was live when it was made,
			// and nothing a later switch does may reach across.
			const hook = renderHook(() => useActiveShortcuts());

			recordChord(hook, 'toggleSidebar', CHORD_SIDEBAR);
			recordChord(hook, 'settings', CHORD_SETTINGS);
			recordTabChord(hook, 'closeTab', CHORD_CLOSE_TAB);

			switchMode('vim');
			recordChord(hook, 'toggleRightPanel', CHORD_RIGHT_PANEL);
			recordTabChord(hook, 'newTab', CHORD_NEW_TAB);

			/** All five, as the LIVE mode should see them. */
			const expectLiveSet = (mode: KeyboardMode) => {
				const { shortcuts, tabShortcuts } = hook.result.current;
				expect(hook.result.current.keyboardMode).toBe(mode);
				// The three default-mode edits are inherited by Vim mode, so
				// they read the same in both.
				expect(shortcuts.toggleSidebar.keys).toEqual(CHORD_SIDEBAR);
				expect(shortcuts.settings.keys).toEqual(CHORD_SETTINGS);
				expect(tabShortcuts.closeTab.keys).toEqual(CHORD_CLOSE_TAB);
				// The two Vim edits exist in Vim mode only; default mode keeps
				// the shipped chords for those actions.
				expect(shortcuts.toggleRightPanel.keys).toEqual(
					mode === 'vim' ? CHORD_RIGHT_PANEL : DEFAULT_SHORTCUTS.toggleRightPanel.keys
				);
				expect(tabShortcuts.newTab.keys).toEqual(
					mode === 'vim' ? CHORD_NEW_TAB : TAB_SHORTCUTS.newTab.keys
				);
			};

			expectLiveSet('vim');
			switchMode('default');
			expectLiveSet('default');
			switchMode('vim');
			expectLiveSet('vim');
			switchMode('default');
			expectLiveSet('default');
			switchMode('vim');
			expectLiveSet('vim');

			// Four switches, and still exactly one write per edited bucket. A
			// second write to a bucket is how one mode's customization gets
			// clobbered by the other without anyone noticing.
			const keys = vi.mocked(window.maestro.settings.set).mock.calls.map(([key]) => key);
			expect(keys.filter((key) => key === 'shortcuts')).toHaveLength(2);
			expect(keys.filter((key) => key === 'tabShortcuts')).toHaveLength(1);
			expect(keys.filter((key) => key === 'vimShortcuts')).toHaveLength(1);
			expect(keys.filter((key) => key === 'vimTabShortcuts')).toHaveLength(1);
		});

		it('survives a reload after the switches, because each mode has its own key', async () => {
			// The in-memory round trip above only proves the buckets are
			// separate in state. This replays what was actually persisted back
			// through hydration, where a shared key, a dropped sparse entry, or
			// a migration reaching across modes would surface.
			const hook = renderHook(() => useActiveShortcuts());
			recordChord(hook, 'toggleSidebar', CHORD_SIDEBAR);
			recordChord(hook, 'settings', CHORD_SETTINGS);
			recordTabChord(hook, 'closeTab', CHORD_CLOSE_TAB);
			switchMode('vim');
			recordChord(hook, 'toggleRightPanel', CHORD_RIGHT_PANEL);
			recordTabChord(hook, 'newTab', CHORD_NEW_TAB);
			switchMode('default');

			await loadFile(persistedSettings());

			const state = useSettingsStore.getState();
			expect(state.keyboardMode).toBe('default');
			expect(state.shortcuts.toggleSidebar.keys).toEqual(CHORD_SIDEBAR);
			expect(state.shortcuts.settings.keys).toEqual(CHORD_SETTINGS);
			expect(state.tabShortcuts.closeTab.keys).toEqual(CHORD_CLOSE_TAB);
			expect(state.vimShortcuts.toggleRightPanel.keys).toEqual(CHORD_RIGHT_PANEL);
			expect(state.vimTabShortcuts.newTab.keys).toEqual(CHORD_NEW_TAB);

			const vimSet = selectActiveShortcuts({ ...state, keyboardMode: 'vim' });
			const vimTabSet = selectActiveTabShortcuts({ ...state, keyboardMode: 'vim' });
			expect(vimSet.toggleSidebar.keys).toEqual(CHORD_SIDEBAR);
			expect(vimSet.toggleRightPanel.keys).toEqual(CHORD_RIGHT_PANEL);
			expect(vimTabSet.closeTab.keys).toEqual(CHORD_CLOSE_TAB);
			expect(vimTabSet.newTab.keys).toEqual(CHORD_NEW_TAB);
		});
	});

	describe('a per-mode reset is per mode', () => {
		it('resetting Vim mode leaves every default-mode customization standing', () => {
			const hook = renderHook(() => useActiveShortcuts());
			recordChord(hook, 'toggleSidebar', CHORD_SIDEBAR);
			recordChord(hook, 'settings', CHORD_SETTINGS);
			recordTabChord(hook, 'closeTab', CHORD_CLOSE_TAB);
			switchMode('vim');
			recordChord(hook, 'toggleRightPanel', CHORD_RIGHT_PANEL);
			recordTabChord(hook, 'newTab', CHORD_NEW_TAB);

			act(() => {
				hook.result.current.resetToDefaults();
			});

			const state = useSettingsStore.getState();
			// Back to the shipped OVERRIDE tables, which is not an empty bucket:
			// the tables carry Vim mode's own chords, and clearing them would
			// leave the mode inheriting default mode wholesale.
			expect(state.vimShortcuts).toEqual(VIM_SHORTCUTS);
			expect(state.vimTabShortcuts).toEqual(VIM_TAB_SHORTCUTS);
			expect(state.shortcuts.toggleSidebar.keys).toEqual(CHORD_SIDEBAR);
			expect(state.shortcuts.settings.keys).toEqual(CHORD_SETTINGS);
			expect(state.tabShortcuts.closeTab.keys).toEqual(CHORD_CLOSE_TAB);
			// And still visible in Vim mode, by inheritance.
			expect(hook.result.current.shortcuts.toggleSidebar.keys).toEqual(CHORD_SIDEBAR);
			expect(hook.result.current.tabShortcuts.closeTab.keys).toEqual(CHORD_CLOSE_TAB);

			switchMode('default');
			expect(hook.result.current.shortcuts.settings.keys).toEqual(CHORD_SETTINGS);
		});

		it('resetting default mode leaves every Vim customization standing', () => {
			// The mirror. Worth stating separately because the two resets are
			// different branches writing different settings keys, and each one
			// could reach across on its own.
			const hook = renderHook(() => useActiveShortcuts());
			switchMode('vim');
			recordChord(hook, 'toggleRightPanel', CHORD_RIGHT_PANEL);
			recordTabChord(hook, 'newTab', CHORD_NEW_TAB);
			switchMode('default');
			recordChord(hook, 'toggleSidebar', CHORD_SIDEBAR);
			recordChord(hook, 'settings', CHORD_SETTINGS);
			recordTabChord(hook, 'closeTab', CHORD_CLOSE_TAB);

			act(() => {
				hook.result.current.resetToDefaults();
			});

			const state = useSettingsStore.getState();
			expect(state.shortcuts).toEqual(DEFAULT_SHORTCUTS);
			expect(state.tabShortcuts).toEqual(TAB_SHORTCUTS);
			expect(state.vimShortcuts.toggleRightPanel.keys).toEqual(CHORD_RIGHT_PANEL);
			expect(state.vimTabShortcuts.newTab.keys).toEqual(CHORD_NEW_TAB);

			switchMode('vim');
			// The Vim edits sit over a freshly reset default floor.
			expect(hook.result.current.shortcuts.toggleRightPanel.keys).toEqual(CHORD_RIGHT_PANEL);
			expect(hook.result.current.tabShortcuts.newTab.keys).toEqual(CHORD_NEW_TAB);
			expect(hook.result.current.shortcuts.toggleSidebar.keys).toEqual(
				DEFAULT_SHORTCUTS.toggleSidebar.keys
			);
		});
	});

	describe('a fresh install', () => {
		beforeEach(async () => {
			// Nothing persisted at all: the state a first launch hydrates from.
			await loadFile({});
		});

		it('hydrates all four buckets from their constant tables, and writes none of them', () => {
			const state = useSettingsStore.getState();
			expect(state.keyboardMode).toBe('default');
			expect(state.shortcuts).toEqual(DEFAULT_SHORTCUTS);
			expect(state.tabShortcuts).toEqual(TAB_SHORTCUTS);
			expect(state.vimShortcuts).toEqual(VIM_SHORTCUTS);
			expect(state.vimTabShortcuts).toEqual(VIM_TAB_SHORTCUTS);
			// A first launch has chosen nothing, and a write here would tell
			// every other window to reload before the user has done anything.
			const written = vi.mocked(window.maestro.settings.set).mock.calls.map(([key]) => key);
			for (const key of ['shortcuts', 'tabShortcuts', 'vimShortcuts', 'vimTabShortcuts']) {
				expect(written).not.toContain(key);
			}
		});

		it.each(KEYBOARD_MODES)('leaves no action unreachable in %s mode', (mode) => {
			// Read off the hydrated store, not the tables: this is the check
			// that a mode switch on a real install cannot leave a key dead.
			const unbound = actionsForMode(mode)
				.filter((sc) => sc.keys.length === 0)
				.map((sc) => sc.id)
				.sort();

			expect(selectVimDisplacedActions(useSettingsStore.getState())).toEqual([]);
			expect(unbound, `unbound in ${mode} mode but not shipped unassigned`).toEqual(
				expectedUnbound(mode)
			);
		});

		it.each(KEYBOARD_MODES)('gives one chord to one action in %s mode', (mode) => {
			// Compared with `shortcutKeysCollide`, not key equality: Ctrl and
			// Meta are ONE modifier to `eventMatchesShortcutKeys`, so a Vim
			// chord spelled `['Ctrl', 'o']` fights a default spelled
			// `['Meta', 'o']` at runtime while reading as a different chord.
			const groups: { keys: string[]; ids: string[] }[] = [];
			for (const sc of actionsForMode(mode)) {
				// An unassigned action claims no keypress and cannot collide.
				if (sc.keys.length === 0) continue;
				const group = groups.find((g) => shortcutKeysCollide(g.keys, sc.keys));
				if (group) group.ids.push(sc.id);
				else groups.push({ keys: sc.keys, ids: [sc.id] });
			}

			const unexplained = groups
				.filter((g) => g.ids.length > 1)
				.filter((g) => !isIntentionallySharedByIds(g.ids))
				.map((g) => `${g.keys.join('+')} is claimed by: ${g.ids.join(', ')}`);

			expect(
				unexplained,
				`Two actions on one keypress in ${mode} mode: the earlier branch in useMainKeyboardHandler wins and the other silently never fires.`
			).toEqual([]);
		});
	});

	describe('the upgrade every current user makes', () => {
		/**
		 * A settings file from a build before keyboard modes existed: both base
		 * buckets persisted in full (anyone who has opened Settings > Shortcuts
		 * once has this), three of them customized, and no Vim key anywhere.
		 *
		 * `toggleSidebar` is deliberately parked on the chord
		 * `VIM_TAB_SHORTCUTS` gives Previous Tab, because that is the one case
		 * the migration cannot simply carry across: in Vim mode the override
		 * wins and this action is left with nothing.
		 */
		function legacyFile(): Record<string, unknown> {
			return {
				shortcuts: {
					...DEFAULT_SHORTCUTS,
					toggleSidebar: { ...DEFAULT_SHORTCUTS.toggleSidebar, keys: VIM_PREV_TAB_CHORD },
					settings: { ...DEFAULT_SHORTCUTS.settings, keys: CHORD_SETTINGS },
				},
				tabShortcuts: {
					...TAB_SHORTCUTS,
					closeTab: { ...TAB_SHORTCUTS.closeTab, keys: CHORD_CLOSE_TAB },
				},
			};
		}

		it('keeps the persisted chords and gives the Vim buckets their shipped tables', async () => {
			await loadFile(legacyFile());

			const state = useSettingsStore.getState();
			expect(state.keyboardMode).toBe('default');
			expect(state.shortcuts.toggleSidebar.keys).toEqual(VIM_PREV_TAB_CHORD);
			expect(state.shortcuts.settings.keys).toEqual(CHORD_SETTINGS);
			expect(state.tabShortcuts.closeTab.keys).toEqual(CHORD_CLOSE_TAB);
			// No Vim key was on disk, so both Vim buckets are the shipped
			// tables rather than empty objects. An empty bucket would leave Vim
			// mode inheriting default mode wholesale and binding none of its
			// own chords.
			expect(state.vimShortcuts).toEqual(VIM_SHORTCUTS);
			expect(state.vimTabShortcuts).toEqual(VIM_TAB_SHORTCUTS);
		});

		it('inherits the user own chords in Vim mode, not the factory ones', async () => {
			await loadFile(legacyFile());
			switchMode('vim');

			const state = useSettingsStore.getState();
			const vimSet = selectActiveShortcuts(state);
			const vimTabSet = selectActiveTabShortcuts(state);
			// Inheritance is from the LIVE default bucket, so a chord recorded
			// years ago is the chord Vim mode starts from.
			expect(vimSet.settings.keys).toEqual(CHORD_SETTINGS);
			expect(vimTabSet.closeTab.keys).toEqual(CHORD_CLOSE_TAB);
			// And Vim mode's own tables are live over the top of it.
			expect(vimSet.prevTab.keys).toEqual(VIM_TAB_SHORTCUTS.prevTab.keys);
			expect(vimTabSet.moveTabLeft.keys).toEqual(VIM_TAB_SHORTCUTS.moveTabLeft.keys);
		});

		it('reports the one chord a Vim override takes as displaced, in either mode', async () => {
			await loadFile(legacyFile());

			// Readable while default mode is still live: the mode toggle has to
			// name the displaced actions at the moment of the switch.
			expect(selectVimDisplacedActions(useSettingsStore.getState())).toEqual(['toggleSidebar']);

			switchMode('vim');

			const state = useSettingsStore.getState();
			expect(selectActiveShortcuts(state).toggleSidebar.keys).toEqual([]);
			expect(selectActiveShortcuts(state).prevTab.keys).toEqual(VIM_PREV_TAB_CHORD);
			// Displacement is a fact about the resolved Vim set, never a write
			// to the other bucket: default mode still has the user's chord.
			expect(state.shortcuts.toggleSidebar.keys).toEqual(VIM_PREV_TAB_CHORD);
		});

		it('surfaces the displaced action in Settings, where the user can rebind it', async () => {
			// The end of the chain, and the step nothing else covers: the
			// ShortcutsTab suite mocks `useActiveShortcuts`, so only here does
			// a real persisted file reach a real rendered tab.
			await loadFile(legacyFile());
			switchMode('vim');

			await act(async () => {
				render(React.createElement(ShortcutsTab, { theme: mockTheme }));
			});

			expect(screen.getByText('Needs a Vim binding')).toBeInTheDocument();
			expect(screen.getAllByText(DEFAULT_SHORTCUTS.toggleSidebar.label).length).toBeGreaterThan(0);
		});

		it('stops reporting the displaced action once it has a Vim chord of its own', async () => {
			// The remedy the report exists for, completing the upgrade story.
			await loadFile(legacyFile());
			const hook = renderHook(() => useActiveShortcuts());
			switchMode('vim');
			expect(hook.result.current.displaced).toEqual(['toggleSidebar']);

			recordChord(hook, 'toggleSidebar', CHORD_SIDEBAR);

			expect(hook.result.current.displaced).toEqual([]);
			expect(hook.result.current.shortcuts.toggleSidebar.keys).toEqual(CHORD_SIDEBAR);
			expect(hook.result.current.shortcuts.prevTab.keys).toEqual(VIM_PREV_TAB_CHORD);
			// Default mode keeps the chord that was displaced.
			switchMode('default');
			expect(hook.result.current.shortcuts.toggleSidebar.keys).toEqual(VIM_PREV_TAB_CHORD);
		});
	});

	describe('corrupt persisted values', () => {
		it.each([['emacs'], [''], [null], [3], [{ mode: 'vim' }], [['vim']]])(
			'falls back to default mode for the persisted keyboardMode %s',
			async (persisted) => {
				// Every consumer reads "not default" as "match an override
				// table", and there is no table for a mode that does not exist.
				await loadFile({ keyboardMode: persisted, fontSize: 17 });

				const state = useSettingsStore.getState();
				expect(state.keyboardMode).toBe('default');
				// The rest of the file still landed, which is the half that
				// says the value was rejected rather than the load abandoned.
				expect(state.fontSize).toBe(17);
			}
		);

		it.each([
			['a string', 'Ctrl+x'],
			['a number', 7],
			['an object', { 0: 'Ctrl', 1: 'x' }],
			['an array with a hole in it', ['Ctrl', null]],
			['an array of objects', [{ key: 'Ctrl' }]],
			['null', null],
		])(
			'falls back to the inherited chord for a Vim override whose keys are %s',
			async (_label, keys) => {
				// `keys` comes off disk, so it can be any JSON value: a
				// hand-edited file, a half-finished sync, an older schema. The
				// code below it calls `.map` on the value and lowercases each
				// member, so an unusable one throws - and the throw is caught by
				// `loadAllSettings`, which abandons the ENTIRE patch. One bad
				// chord would silently revert every other setting in the file,
				// which is why `fontSize` is asserted here too.
				await loadFile({
					fontSize: 17,
					vimShortcuts: {
						toggleRightPanel: {
							id: 'toggleRightPanel',
							label: 'Toggle Right Panel',
							keys,
						},
					},
				});

				const state = useSettingsStore.getState();
				expect(state.fontSize).toBe(17);
				// An override with no usable chord reads as "inherit the
				// default-mode binding", which is the one fallback that leaves
				// the action reachable in both modes.
				const vimSet = selectActiveShortcuts({ ...state, keyboardMode: 'vim' });
				expect(vimSet.toggleRightPanel.keys).toEqual(DEFAULT_SHORTCUTS.toggleRightPanel.keys);
				// And nothing downstream of the resolver trips over it either.
				expect(() => selectVimDisplacedActions(state)).not.toThrow();
				expect(selectVimDisplacedActions(state)).toEqual([]);
			}
		);

		it('keeps a sequence with an empty step from firing, and matches the rest', async () => {
			// An empty step can reach disk from a recorder interrupted
			// mid-capture or a hand-edited file. `eventMatchesShortcutKeys`
			// answers false for an empty chord, so the binding is simply
			// unreachable - the requirement is that it stays a dead binding
			// rather than throwing or swallowing the keypresses around it.
			await loadFile({
				vimTabShortcuts: {
					...VIM_TAB_SHORTCUTS,
					goToTab1: { id: 'goToTab1', label: 'Go to Tab 1', sequence: [['g'], []] },
				},
			});

			const state = useSettingsStore.getState();
			const vimSet = selectActiveShortcuts({ ...state, keyboardMode: 'vim' });
			const vimTabSet = selectActiveTabShortcuts({ ...state, keyboardMode: 'vim' });
			expect(vimTabSet.goToTab1.sequence).toEqual([['g'], []]);

			const bindings = collectSequenceBindings(vimSet, vimTabSet);
			const matcher = createSequenceMatcher();
			const press = (key: string) =>
				matcher.feed(
					{ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
					bindings
				);

			// `g` still opens the run (several real sequences start with it).
			expect(press('g').outcome).toBe('consumed-prefix');
			// The empty second step matches nothing, so the run ends with no
			// action fired rather than with a throw.
			expect(press('x')).toEqual({ outcome: 'no-match' });
			expect(matcher.prefix()).toEqual([]);
			// The sibling sequences in the same table are untouched by it.
			expect(press('g').outcome).toBe('consumed-prefix');
			expect(press('t')).toEqual({ outcome: 'matched', actionId: 'nextTab' });
		});
	});

	describe('a mode switch reads everything except the mode', () => {
		it('leaves tab, transcript, panel, and agent state identical', () => {
			// A switch repoints which binding map is live and nothing else. The
			// temptation it guards against is reaching for a tab or a panel to
			// "refresh" it: the bindings are read at keypress time, so there is
			// nothing to refresh, and anything written here would be lost work.
			const session = createMockSession({
				id: 'agent-1',
				aiTabs: [
					createMockAITab({ id: 'tab-1', output: 'a transcript the switch must not touch' }),
				],
			});
			act(() => {
				useSessionStore.setState({ sessions: [session], activeSessionId: 'agent-1' });
			});
			const sessionsBefore = useSessionStore.getState().sessions;
			const uiBefore = useUIStore.getState();

			switchMode('vim');
			switchMode('default');
			switchMode('vim');

			// Identity, not equality: a store that rebuilt an equal object would
			// still re-render every consumer of it on a keyboard-only change.
			expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
			expect(useSessionStore.getState().activeSessionId).toBe('agent-1');
			expect(useUIStore.getState()).toBe(uiBefore);
			expect(useSettingsStore.getState().keyboardMode).toBe('vim');
		});

		it('never moves keyboardMasteryStats.usedShortcuts', () => {
			// Mastery is one figure across modes: the numerator is a set of
			// action ids with no mode in it. A switch that touched it would
			// make a percentage move for a change that fired no shortcut.
			act(() => {
				useSettingsStore.setState({
					keyboardMasteryStats: {
						usedShortcuts: ['toggleSidebar', 'newTab'],
						currentLevel: 1,
						lastLevelUpTimestamp: 0,
						lastAcknowledgedLevel: 1,
					},
				});
			});
			const statsBefore = useSettingsStore.getState().keyboardMasteryStats;
			const idsFor = (mode: KeyboardMode) =>
				selectMasteryBoundShortcuts({
					...useSettingsStore.getState(),
					keyboardMode: mode,
				} as MasteryShortcutsState)
					.map((sc) => sc.id)
					.sort();
			const denominatorBefore = idsFor('default');

			switchMode('vim');
			switchMode('default');
			switchMode('vim');

			expect(useSettingsStore.getState().keyboardMasteryStats).toBe(statsBefore);
			expect(vi.mocked(window.maestro.settings.set).mock.calls.map(([key]) => key)).not.toContain(
				'keyboardMasteryStats'
			);
			// The denominator is mode-independent too, so the percentage the
			// user sees is the same figure before and after the switch.
			expect(idsFor('vim')).toEqual(denominatorBefore);
		});
	});
});
