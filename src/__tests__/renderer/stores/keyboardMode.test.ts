/**
 * Keyboard modes end to end: the resolver through the store's selectors, the
 * two independent persistence buckets, and the round trip a user makes by
 * switching modes.
 *
 * The pure rules of the resolver are covered one level down in
 * `src/__tests__/shared/effectiveShortcuts.test.ts` (which calls
 * `resolveEffectiveShortcuts` with hand-built maps), and the hydration and
 * write-back details of each bucket in
 * `src/__tests__/renderer/stores/settingsStore.test.ts`. What is only
 * observable HERE is the wiring: the live mode picking a pair of maps, the
 * memo that keeps those maps identity-stable, and `useActiveShortcuts()` as the
 * one door that pairs a bucket with the mode that is live. The three promises
 * this phase makes are all properties of that wiring:
 *
 *  1. Customizing a chord in one mode never writes the other mode's bucket, so
 *     switching away and back finds both customizations exactly as they were.
 *  2. Nothing becomes unreachable by switching: an action Vim mode does not
 *     mention inherits its default chord, including a chord the user recorded.
 *  3. An action whose inherited chord a Vim override takes is REPORTED as
 *     displaced rather than silently answering the same keypress.
 *
 * The real store is seeded rather than mocked (TEST-PATTERNS.md, "Mocking
 * Zustand Stores"), and the real hook is rendered rather than stubbed: the
 * ShortcutsTab suite mocks `useActiveShortcuts`, so its write path is only
 * exercised from here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RenderHookResult } from '@testing-library/react';
import { useSettingsStore, loadAllSettings } from '../../../renderer/stores/settingsStore';
import {
	selectActiveShortcuts,
	selectActiveTabShortcuts,
	selectVimDisplacedActions,
} from '../../../renderer/stores/settingsShortcutsSlice';
import { useActiveShortcuts } from '../../../renderer/hooks/settings/useActiveShortcuts';
import type { UseActiveShortcutsReturn } from '../../../renderer/hooks/settings/useActiveShortcuts';
import { DEFAULT_SHORTCUTS, TAB_SHORTCUTS } from '../../../renderer/constants/shortcuts';
import { VIM_SHORTCUTS, VIM_TAB_SHORTCUTS } from '../../../renderer/constants/vimShortcuts';
import type { KeyboardMode } from '../../../shared/shortcut-types';
import type { Shortcut } from '../../../renderer/types';
import { resetStore } from '../../helpers';

/**
 * Chords on keys no shipped table binds, so a test customization cannot collide
 * with a real default and change what the assertion is measuring. `PageUp` and
 * `PageDown` are the pair `VIM_TAB_SHORTCUTS` uses, and `Home` / `End` are free
 * in both tables (and in `RESERVED_SHORTCUT_COMBOS`, so the hydration's
 * reserved-chord strip leaves them alone on the reload round trip).
 */
const FREE_CHORD_A = ['Alt', 'Home'];
const FREE_CHORD_B = ['Ctrl', 'End'];
/** The chord `VIM_TAB_SHORTCUTS` gives Previous Tab, spelled as a user would record it. */
const VIM_PREV_TAB_CHORD = ['Ctrl', 'PageUp'];

type ShortcutsHook = RenderHookResult<UseActiveShortcutsReturn, unknown>;

/** Switch the live mode the way the Settings toggle does. */
function switchMode(mode: KeyboardMode): void {
	act(() => {
		useSettingsStore.getState().setKeyboardMode(mode);
	});
}

/**
 * Record a chord for one action through the live mode's door.
 *
 * Shaped like the recorder in Settings > Shortcuts: it hands back the whole map
 * it was shown with one row changed, which is what makes the diff in
 * `overridesWithEdits` the only thing that knows WHICH binding moved.
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

/** The settings keys written so far, in call order. */
function persistedKeys(): string[] {
	return vi.mocked(window.maestro.settings.set).mock.calls.map(([key]) => key);
}

describe('keyboard mode', () => {
	beforeEach(() => {
		resetStore(useSettingsStore);
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
		// back as a settings file, and one of them feeds that file to `getAll`.
		vi.mocked(window.maestro.settings.set).mockResolvedValue(true);
		vi.mocked(window.maestro.settings.getAll).mockResolvedValue({});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('the persisted mode', () => {
		it('is default mode when nothing is persisted, and writes nothing', async () => {
			await loadAllSettings();

			expect(useSettingsStore.getState().keyboardMode).toBe('default');
			// A fresh install has never chosen a mode, and writing one here
			// would tell every other window to reload on first launch.
			expect(persistedKeys()).not.toContain('keyboardMode');
		});

		it('restores a persisted vim mode', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({ keyboardMode: 'vim' });

			await loadAllSettings();

			expect(useSettingsStore.getState().keyboardMode).toBe('vim');
		});

		it.each([['emacs'], [''], [null], [3], [{ mode: 'vim' }]])(
			'falls back to default mode for the persisted value %s, without throwing',
			async (persisted) => {
				// The value is on disk, so it can be hand-edited, written by a
				// build that spelled the modes differently, or mangled by
				// settings sync. Every consumer reads "not default" as "match an
				// override table", and there is no table for a mode that does
				// not exist, so an unrecognized string has to land on default.
				useSettingsStore.setState({ keyboardMode: 'vim' });
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({ keyboardMode: persisted });

				await expect(loadAllSettings()).resolves.not.toThrow();

				expect(useSettingsStore.getState().keyboardMode).toBe('default');
			}
		);
	});

	describe('the live mode selectors', () => {
		it('returns the default buckets themselves in default mode', () => {
			// Identity, not equality: default mode IS the base, so every
			// keyboard consumer in the app has to read exactly the object it
			// read before keyboard modes existed, or it re-renders for nothing.
			const state = useSettingsStore.getState();

			expect(selectActiveShortcuts(state)).toBe(state.shortcuts);
			expect(selectActiveTabShortcuts(state)).toBe(state.tabShortcuts);
			expect(selectVimDisplacedActions(state)).toEqual([]);
		});

		it('returns the resolved maps in Vim mode', () => {
			switchMode('vim');
			const state = useSettingsStore.getState();

			// `prevTab` / `nextTab` are declared in DEFAULT_SHORTCUTS, so the
			// override lands in the GENERAL resolved map even though it is
			// written in the tab bucket.
			const resolved = selectActiveShortcuts(state);
			expect(resolved).not.toBe(state.shortcuts);
			expect(resolved.prevTab.keys).toEqual(VIM_TAB_SHORTCUTS.prevTab.keys);
			expect(resolved.nextTab.keys).toEqual(VIM_TAB_SHORTCUTS.nextTab.keys);

			// The tab map is resolved too: the Vim tables override ids declared in
			// TAB_SHORTCUTS (the tab move pair, and `toggleShowThinking`, which the
			// region family displaced off Cmd+Shift+K).
			const resolvedTabs = selectActiveTabShortcuts(state);
			expect(resolvedTabs).not.toBe(state.tabShortcuts);
			expect(resolvedTabs.moveTabLeft.keys).toEqual(VIM_TAB_SHORTCUTS.moveTabLeft.keys);
			expect(resolvedTabs.moveTabRight.keys).toEqual(VIM_TAB_SHORTCUTS.moveTabRight.keys);
			expect(resolvedTabs.toggleShowThinking.keys).toEqual(
				VIM_TAB_SHORTCUTS.toggleShowThinking.keys
			);
			// A sequence override leaves the inherited chord alone, so `goToTab1`
			// answers to `g g` AND keeps Cmd+1.
			expect(resolvedTabs.goToTab1.sequence).toEqual(VIM_TAB_SHORTCUTS.goToTab1.sequence);
			expect(resolvedTabs.goToTab1.keys).toEqual(state.tabShortcuts.goToTab1.keys);
			// Identity is preserved per entry: an action no Vim override mentions
			// comes back as the same object, so consumers memoizing on it do not
			// re-render on a mode switch.
			expect(resolvedTabs.newTab).toBe(state.tabShortcuts.newTab);
		});

		it('returns the same object across calls, and across an unrelated settings change', () => {
			// The selectors re-run on EVERY settings change, whatever changed.
			// Resolving afresh each time would hand back a new map on a font
			// size and re-render every keyboard consumer in the app.
			switchMode('vim');

			const first = selectActiveShortcuts(useSettingsStore.getState());
			expect(selectActiveShortcuts(useSettingsStore.getState())).toBe(first);

			act(() => {
				useSettingsStore.setState({ fontSize: 15 });
			});

			expect(selectActiveShortcuts(useSettingsStore.getState())).toBe(first);
		});
	});

	describe('inheritance', () => {
		it('carries the default chord for every action Vim mode does not override', () => {
			// This is what stops a mode switch from unbinding anything: the
			// override tables are sparse, and the default bucket is the floor.
			const overridden = new Set([
				...Object.keys(VIM_SHORTCUTS),
				...Object.keys(VIM_TAB_SHORTCUTS),
			]);
			expect(overridden.size).toBeGreaterThan(0);

			switchMode('vim');
			const state = useSettingsStore.getState();
			const resolvedShortcuts = selectActiveShortcuts(state);
			const resolvedTabShortcuts = selectActiveTabShortcuts(state);

			for (const id of Object.keys(state.shortcuts)) {
				if (overridden.has(id)) continue;
				// The same ENTRY object, not just the same chord: the resolver
				// preserves identity for rows it does not change so a consumer
				// memoizing on one row does not re-render on a mode switch.
				expect(resolvedShortcuts[id]).toBe(state.shortcuts[id]);
			}
			for (const id of Object.keys(state.tabShortcuts)) {
				if (overridden.has(id)) continue;
				expect(resolvedTabShortcuts[id]).toBe(state.tabShortcuts[id]);
			}
		});

		it('inherits a chord the user customized in default mode', () => {
			// The inheritance is from the LIVE default bucket, not from the
			// shipped table. A user who re-bound an action in default mode and
			// then switched expects to find their own chord, not the factory
			// one, for everything Vim mode has no opinion about.
			const hook = renderHook(() => useActiveShortcuts());
			recordChord(hook, 'toggleSidebar', FREE_CHORD_A);

			switchMode('vim');

			expect(hook.result.current.keyboardMode).toBe('vim');
			expect(hook.result.current.shortcuts.toggleSidebar.keys).toEqual(FREE_CHORD_A);
			expect(hook.result.current.isInherited('toggleSidebar')).toBe(true);
		});
	});

	describe('displacement', () => {
		it('displaces a default-mode chord a Vim override takes, and keeps the override bound', () => {
			// Within one mode a chord fires one action. When an override takes a
			// chord another action inherits, both would answer the keypress and
			// the winner would come down to branch order in the keyboard
			// handler. The override wins, the inheriting action drops to
			// unbound, and its id is reported so the UI can ask for a chord of
			// its own rather than leaving it dead.
			const hook = renderHook(() => useActiveShortcuts());
			recordChord(hook, 'toggleSidebar', VIM_PREV_TAB_CHORD);

			// Read while default mode is still live: the mode toggle has to be
			// able to name the displaced actions at the moment it switches.
			expect(selectVimDisplacedActions(useSettingsStore.getState())).toContain('toggleSidebar');

			switchMode('vim');

			expect(hook.result.current.displaced).toContain('toggleSidebar');
			expect(hook.result.current.shortcuts.toggleSidebar.keys).toEqual([]);
			expect(hook.result.current.shortcuts.prevTab.keys).toEqual(VIM_PREV_TAB_CHORD);
			// Default mode still has the user's chord. Displacement is a fact
			// about the resolved Vim set, never a write to the other bucket.
			expect(useSettingsStore.getState().shortcuts.toggleSidebar.keys).toEqual(VIM_PREV_TAB_CHORD);
		});

		it('stops reporting a displaced action once it has a Vim chord of its own', () => {
			// The remedy the report exists for. Recording a chord in Vim mode
			// writes an override, and an overridden action no longer inherits
			// the chord that was taken from it.
			const hook = renderHook(() => useActiveShortcuts());
			recordChord(hook, 'toggleSidebar', VIM_PREV_TAB_CHORD);
			switchMode('vim');
			expect(hook.result.current.displaced).toContain('toggleSidebar');

			recordChord(hook, 'toggleSidebar', FREE_CHORD_A);

			expect(hook.result.current.displaced).toEqual([]);
			expect(hook.result.current.shortcuts.toggleSidebar.keys).toEqual(FREE_CHORD_A);
			expect(hook.result.current.shortcuts.prevTab.keys).toEqual(VIM_PREV_TAB_CHORD);
		});
	});

	describe('independent customizations', () => {
		it('keeps both customizations when the user switches away and back', () => {
			// The promise that makes two modes usable at all. Neither bucket is
			// ever written by the other, so the round trip is lossless.
			const hook = renderHook(() => useActiveShortcuts());
			recordChord(hook, 'toggleSidebar', FREE_CHORD_A);

			switchMode('vim');
			recordChord(hook, 'toggleRightPanel', FREE_CHORD_B);

			expect(hook.result.current.shortcuts.toggleRightPanel.keys).toEqual(FREE_CHORD_B);
			// Vim mode's edit landed in the Vim bucket only.
			expect(useSettingsStore.getState().vimShortcuts.toggleRightPanel.keys).toEqual(FREE_CHORD_B);
			expect(useSettingsStore.getState().shortcuts.toggleRightPanel.keys).toEqual(
				DEFAULT_SHORTCUTS.toggleRightPanel.keys
			);

			switchMode('default');

			expect(hook.result.current.shortcuts.toggleSidebar.keys).toEqual(FREE_CHORD_A);
			expect(useSettingsStore.getState().vimShortcuts.toggleRightPanel.keys).toEqual(FREE_CHORD_B);

			switchMode('vim');

			expect(hook.result.current.shortcuts.toggleSidebar.keys).toEqual(FREE_CHORD_A);
			expect(hook.result.current.shortcuts.toggleRightPanel.keys).toEqual(FREE_CHORD_B);
			// Two edits, two settings keys. A write to the other mode's key is
			// how a customization would get clobbered without anyone noticing.
			expect(persistedKeys().filter((key) => key === 'shortcuts')).toHaveLength(1);
			expect(persistedKeys().filter((key) => key === 'vimShortcuts')).toHaveLength(1);
		});

		it('writes a Vim tab edit to the Vim tab bucket, leaving the default tab bucket alone', () => {
			const hook = renderHook(() => useActiveShortcuts());
			switchMode('vim');

			recordTabChord(hook, 'closeTab', FREE_CHORD_B);

			expect(useSettingsStore.getState().vimTabShortcuts.closeTab.keys).toEqual(FREE_CHORD_B);
			expect(useSettingsStore.getState().tabShortcuts.closeTab.keys).toEqual(
				TAB_SHORTCUTS.closeTab.keys
			);
			expect(persistedKeys()).not.toContain('tabShortcuts');
			// The shipped Vim overrides are still in the bucket beside the edit.
			expect(useSettingsStore.getState().vimTabShortcuts.prevTab).toEqual(
				VIM_TAB_SHORTCUTS.prevTab
			);
		});

		it('survives a reload, because each mode has its own settings key', async () => {
			// The in-memory round trip above only proves the two buckets are
			// separate in state. This one replays what was actually persisted
			// back through hydration, which is where a shared key, a dropped
			// sparse entry, or a migration reaching across modes would show up.
			const hook = renderHook(() => useActiveShortcuts());
			recordChord(hook, 'toggleSidebar', FREE_CHORD_A);
			switchMode('vim');
			recordChord(hook, 'toggleRightPanel', FREE_CHORD_B);
			switchMode('default');

			const file = persistedSettings();
			resetStore(useSettingsStore);
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue(file);

			await act(async () => {
				await loadAllSettings();
			});

			const state = useSettingsStore.getState();
			expect(state.keyboardMode).toBe('default');
			expect(state.shortcuts.toggleSidebar.keys).toEqual(FREE_CHORD_A);
			expect(state.vimShortcuts.toggleRightPanel.keys).toEqual(FREE_CHORD_B);
			// And Vim mode still inherits the default-mode chord it did before
			// the reload, which is the half a lost sparse entry would break.
			const vimSet = selectActiveShortcuts({ ...state, keyboardMode: 'vim' });
			expect(vimSet.toggleSidebar.keys).toEqual(FREE_CHORD_A);
			expect(vimSet.toggleRightPanel.keys).toEqual(FREE_CHORD_B);
		});

		it('carries a persisted key sequence across a reload, beside the chord', async () => {
			// The two triggers persist in one entry, and the merge with the
			// shipped table rebuilds that entry from the table's metadata. A
			// merge that only carried `keys` across would drop the sequence on
			// every load, which no amount of in-memory testing would show.
			//
			// Written straight into the settings file rather than recorded: the
			// recorder learns sequences later in this phase, and the hydration
			// has to be right before anything can produce one.
			//
			// The ids are chosen so the merge actually RUNS over them. An id the
			// shipped table does not declare takes the "override-only id" branch,
			// which copies the saved entry wholesale and would hide a merge that
			// drops the field - and `VIM_SHORTCUTS` is empty in this phase, so
			// every general-bucket id is such an id. `prevTab` is in
			// `VIM_TAB_SHORTCUTS`, and the base tables declare everything.
			const file = {
				shortcuts: {
					toggleSidebar: {
						id: 'toggleSidebar',
						label: DEFAULT_SHORTCUTS.toggleSidebar.label,
						keys: FREE_CHORD_A,
						sequence: [['g'], ['s']],
					},
				},
				vimTabShortcuts: {
					prevTab: {
						id: 'prevTab',
						label: VIM_TAB_SHORTCUTS.prevTab.label,
						keys: VIM_PREV_TAB_CHORD,
						sequence: [['g'], ['h']],
					},
					// An entry that speaks only to the sequence leaves the chord
					// inherited, so both halves of "independent" are covered.
					nextTab: {
						id: 'nextTab',
						label: VIM_TAB_SHORTCUTS.nextTab.label,
						sequence: [['g'], ['l']],
					},
				},
			};
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue(file);

			await act(async () => {
				await loadAllSettings();
			});

			const state = useSettingsStore.getState();
			expect(state.shortcuts.toggleSidebar.sequence).toEqual([['g'], ['s']]);
			expect(state.vimTabShortcuts.prevTab.sequence).toEqual([['g'], ['h']]);
			expect(state.vimTabShortcuts.nextTab.sequence).toEqual([['g'], ['l']]);

			const vimSet = selectActiveShortcuts({ ...state, keyboardMode: 'vim' });
			expect(vimSet.prevTab.sequence).toEqual([['g'], ['h']]);
			expect(vimSet.prevTab.keys).toEqual(VIM_PREV_TAB_CHORD);
			// Sequence only: the chord is still the inherited default one.
			expect(vimSet.nextTab.sequence).toEqual([['g'], ['l']]);
			expect(vimSet.nextTab.keys).toEqual(DEFAULT_SHORTCUTS.nextTab.keys);
			// A base-table sequence is live in BOTH modes, since Vim mode
			// inherits the whole entry when it overrides nothing.
			expect(vimSet.toggleSidebar.sequence).toEqual([['g'], ['s']]);
			const defaultSet = selectActiveShortcuts({ ...state, keyboardMode: 'default' });
			expect(defaultSet.toggleSidebar.sequence).toEqual([['g'], ['s']]);
			expect(defaultSet.toggleSidebar.keys).toEqual(FREE_CHORD_A);
			// And the Vim-only sequences stay out of default mode.
			expect(defaultSet.prevTab.sequence).toBeUndefined();
			expect(defaultSet.nextTab.sequence).toBeUndefined();
		});
	});

	describe('per-mode reset', () => {
		it('restores the shipped Vim tables in Vim mode and leaves default mode alone', () => {
			// Back to the shipped OVERRIDE tables, which is not the same as an
			// empty bucket: the tables carry Vim mode's own chords, and clearing
			// them would leave the mode inheriting default mode wholesale.
			const hook = renderHook(() => useActiveShortcuts());
			recordChord(hook, 'toggleSidebar', FREE_CHORD_A);
			switchMode('vim');
			recordChord(hook, 'toggleRightPanel', FREE_CHORD_B);
			recordTabChord(hook, 'closeTab', FREE_CHORD_B);

			act(() => {
				hook.result.current.resetToDefaults();
			});

			const state = useSettingsStore.getState();
			expect(state.vimShortcuts).toEqual(VIM_SHORTCUTS);
			expect(state.vimTabShortcuts).toEqual(VIM_TAB_SHORTCUTS);
			// The other mode's customization is untouched, and neither of its
			// settings keys was written.
			expect(state.shortcuts.toggleSidebar.keys).toEqual(FREE_CHORD_A);
			expect(
				persistedKeys().filter((key) => key === 'shortcuts' || key === 'tabShortcuts')
			).toEqual(['shortcuts']);
		});

		it('restores the shipped default tables in default mode and leaves Vim mode alone', () => {
			const hook = renderHook(() => useActiveShortcuts());
			switchMode('vim');
			recordChord(hook, 'toggleRightPanel', FREE_CHORD_B);
			switchMode('default');
			recordChord(hook, 'toggleSidebar', FREE_CHORD_A);

			act(() => {
				hook.result.current.resetToDefaults();
			});

			const state = useSettingsStore.getState();
			expect(state.shortcuts).toEqual(DEFAULT_SHORTCUTS);
			expect(state.tabShortcuts).toEqual(TAB_SHORTCUTS);
			expect(state.vimShortcuts.toggleRightPanel.keys).toEqual(FREE_CHORD_B);
			expect(
				persistedKeys().filter((key) => key === 'vimShortcuts' || key === 'vimTabShortcuts')
			).toEqual(['vimShortcuts']);

			// And switching back finds the Vim customization still in place,
			// over the freshly reset default floor.
			switchMode('vim');
			const resolved: Record<string, Shortcut> = hook.result.current.shortcuts;
			expect(resolved.toggleRightPanel.keys).toEqual(FREE_CHORD_B);
			expect(resolved.toggleSidebar.keys).toEqual(DEFAULT_SHORTCUTS.toggleSidebar.keys);
		});
	});
});
