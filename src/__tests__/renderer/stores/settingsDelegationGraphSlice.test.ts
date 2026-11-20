import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSettingsStore, loadAllSettings } from '../../../renderer/stores/settingsStore';
import {
	hydrateDelegationGraphSettings,
	sanitizeDelegationGraphLayouts,
	type DelegationGraphLayouts,
	type DelegationGraphState,
} from '../../../renderer/stores/settingsDelegationGraphSlice';
import { DELEGATION_GRAPH_LAYOUTS_SETTING } from '../../../shared/delegationGraphLayout';
import type { DelegationGraphScope } from '../../../shared/delegationGraph';

const ALL: DelegationGraphScope = { kind: 'all' };
const GROUP: DelegationGraphScope = { kind: 'group', groupId: 'g-1' };

function layouts(): DelegationGraphLayouts {
	return useSettingsStore.getState().delegationGraphLayouts;
}

describe('settingsDelegationGraphSlice', () => {
	beforeEach(() => {
		useSettingsStore.setState({ delegationGraphLayouts: {} });

		// Not in the global setup; loadAllSettings calls both.
		if (!window.maestro.power) {
			(window.maestro as any).power = {
				setEnabled: vi.fn().mockResolvedValue(undefined),
				setKeepDisplayAwake: vi.fn().mockResolvedValue(undefined),
			};
		}
		(window.maestro as any).cueStats = {
			getHistoricalConductorCredit: vi.fn().mockResolvedValue(0),
		};

		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('starts with nothing saved', () => {
		expect(layouts()).toEqual({});
	});

	describe('setDelegationScopeLayout', () => {
		it('saves a scope under its storage key and persists the whole record', () => {
			useSettingsStore
				.getState()
				.setDelegationScopeLayout(ALL, { layout: 'manual', positions: { a: { x: 10, y: 20 } } });

			const expected = { all: { layout: 'manual', positions: { a: { x: 10, y: 20 } } } };
			expect(layouts()).toEqual(expected);
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				DELEGATION_GRAPH_LAYOUTS_SETTING,
				expected
			);
		});

		// The same agent sits in the "all" graph and in its group's graph at
		// different places. Writing one must not move it in the other.
		it('keeps each scope to itself', () => {
			const { setDelegationScopeLayout } = useSettingsStore.getState();
			setDelegationScopeLayout(ALL, { layout: 'manual', positions: { a: { x: 1, y: 1 } } });
			setDelegationScopeLayout(GROUP, { layout: 'force', positions: { a: { x: 900, y: 900 } } });

			expect(layouts()).toEqual({
				all: { layout: 'manual', positions: { a: { x: 1, y: 1 } } },
				'group:g-1': { layout: 'force', positions: { a: { x: 900, y: 900 } } },
			});
		});

		it('replaces what the scope had, it does not merge into it', () => {
			const { setDelegationScopeLayout } = useSettingsStore.getState();
			setDelegationScopeLayout(ALL, {
				layout: 'manual',
				positions: { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } },
			});
			setDelegationScopeLayout(ALL, { layout: 'radial', positions: { a: { x: 5, y: 5 } } });

			expect(layouts().all).toEqual({ layout: 'radial', positions: { a: { x: 5, y: 5 } } });
		});

		it('drops a coordinate that is not finite before it reaches disk', () => {
			useSettingsStore.getState().setDelegationScopeLayout(ALL, {
				layout: 'force',
				positions: { ok: { x: 1, y: 2 }, diverged: { x: NaN, y: 3 } },
			});

			expect(layouts().all.positions).toEqual({ ok: { x: 1, y: 2 } });
			expect(window.maestro.settings.set).toHaveBeenCalledWith(DELEGATION_GRAPH_LAYOUTS_SETTING, {
				all: { layout: 'force', positions: { ok: { x: 1, y: 2 } } },
			});
		});

		// `manual` means "leave every agent where it was put". With nothing put
		// anywhere, the next open would treat every agent as new and pile them up.
		it('does not store manual with no positions', () => {
			const { setDelegationScopeLayout } = useSettingsStore.getState();
			setDelegationScopeLayout(ALL, { layout: 'manual', positions: { a: { x: 1, y: 1 } } });
			setDelegationScopeLayout(ALL, { layout: 'manual', positions: {} });

			expect(layouts()).toEqual({});
			expect(window.maestro.settings.set).toHaveBeenLastCalledWith(
				DELEGATION_GRAPH_LAYOUTS_SETTING,
				{}
			);
		});

		it('does not store the default layout with no positions, which is what no entry means', () => {
			useSettingsStore
				.getState()
				.setDelegationScopeLayout(ALL, { layout: 'hierarchical', positions: {} });
			expect(layouts()).toEqual({});
		});

		it('stores a chosen layout even with no positions yet', () => {
			useSettingsStore
				.getState()
				.setDelegationScopeLayout(GROUP, { layout: 'radial', positions: {} });
			expect(layouts()).toEqual({ 'group:g-1': { layout: 'radial', positions: {} } });
		});
	});

	describe('resetDelegationScopeLayout', () => {
		it('forgets one scope and leaves the others', () => {
			const { setDelegationScopeLayout, resetDelegationScopeLayout } = useSettingsStore.getState();
			setDelegationScopeLayout(ALL, { layout: 'manual', positions: { a: { x: 1, y: 1 } } });
			setDelegationScopeLayout(GROUP, { layout: 'manual', positions: { a: { x: 2, y: 2 } } });

			resetDelegationScopeLayout(ALL);

			const expected = { 'group:g-1': { layout: 'manual', positions: { a: { x: 2, y: 2 } } } };
			expect(layouts()).toEqual(expected);
			expect(window.maestro.settings.set).toHaveBeenLastCalledWith(
				DELEGATION_GRAPH_LAYOUTS_SETTING,
				expected
			);
		});

		it('writes nothing when the scope has nothing saved', () => {
			useSettingsStore.getState().resetDelegationScopeLayout(GROUP);

			expect(layouts()).toEqual({});
			expect(window.maestro.settings.set).not.toHaveBeenCalled();
		});
	});

	describe('sanitizeDelegationGraphLayouts', () => {
		it('keeps a well-formed record as it is', () => {
			const stored = {
				all: { layout: 'manual', positions: { a: { x: 1, y: 2 } } },
				'group:g-1': { layout: 'force', positions: { b: { x: 3, y: 4 } } },
			};
			expect(sanitizeDelegationGraphLayouts(stored)).toEqual(stored);
		});

		it('drops a key that is not a scope key', () => {
			expect(
				sanitizeDelegationGraphLayouts({
					all: { layout: 'force', positions: { a: { x: 1, y: 2 } } },
					'group:': { layout: 'force', positions: { a: { x: 1, y: 2 } } },
					everything: { layout: 'force', positions: { a: { x: 1, y: 2 } } },
				})
			).toEqual({ all: { layout: 'force', positions: { a: { x: 1, y: 2 } } } });
		});

		// A layout written by a later build is not one this build can draw. The
		// coordinates are still where the user's agents are, so they are kept.
		it('falls back to the default for a layout it cannot draw, and keeps the positions', () => {
			expect(
				sanitizeDelegationGraphLayouts({
					all: { layout: 'circular', positions: { a: { x: 1, y: 2 } } },
				})
			).toEqual({ all: { layout: 'hierarchical', positions: { a: { x: 1, y: 2 } } } });
		});

		it('drops bad coordinates and keeps the good ones in the same scope', () => {
			expect(
				sanitizeDelegationGraphLayouts({
					all: { layout: 'manual', positions: { a: { x: 1, y: 2 }, b: { x: 'left', y: 0 } } },
				})
			).toEqual({ all: { layout: 'manual', positions: { a: { x: 1, y: 2 } } } });
		});

		it('drops an entry that says nothing: manual or the default, with no usable position', () => {
			expect(
				sanitizeDelegationGraphLayouts({
					all: { layout: 'manual', positions: {} },
					'group:g-1': { layout: 'manual', positions: { a: { x: null, y: null } } },
					'group:g-2': { layout: 'hierarchical' },
					'group:g-3': {},
				})
			).toEqual({});
		});

		it('drops an entry that is not an object', () => {
			expect(sanitizeDelegationGraphLayouts({ all: 'manual', 'group:g-1': null })).toEqual({});
		});

		it('reads anything that is not a record as nothing saved', () => {
			expect(sanitizeDelegationGraphLayouts(undefined)).toEqual({});
			expect(sanitizeDelegationGraphLayouts(null)).toEqual({});
			expect(sanitizeDelegationGraphLayouts('all')).toEqual({});
			expect(sanitizeDelegationGraphLayouts([])).toEqual({});
		});
	});

	describe('hydrateDelegationGraphSettings', () => {
		it('leaves the patch alone when the key was never stored', () => {
			const patch: Partial<DelegationGraphState> = {};
			hydrateDelegationGraphSettings({}, patch);
			expect(patch).toEqual({});
		});

		it('puts the sanitized record on the patch', () => {
			const patch: Partial<DelegationGraphState> = {};
			hydrateDelegationGraphSettings(
				{
					[DELEGATION_GRAPH_LAYOUTS_SETTING]: {
						all: { layout: 'manual', positions: { a: { x: 1, y: 2 } } },
						junk: { layout: 'manual', positions: { a: { x: 1, y: 2 } } },
					},
				},
				patch
			);
			expect(patch.delegationGraphLayouts).toEqual({
				all: { layout: 'manual', positions: { a: { x: 1, y: 2 } } },
			});
		});
	});

	// The classic "setting resets on restart" bug is a slice whose hydration is
	// never called from loadAllSettings. This goes through the real loader.
	describe('loadAllSettings', () => {
		it('restores a saved arrangement after a restart', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				[DELEGATION_GRAPH_LAYOUTS_SETTING]: {
					all: { layout: 'manual', positions: { a: { x: 120, y: 340 } } },
					'group:g-1': { layout: 'radial', positions: { a: { x: -50, y: 75 } } },
				},
			});

			await loadAllSettings();

			expect(layouts()).toEqual({
				all: { layout: 'manual', positions: { a: { x: 120, y: 340 } } },
				'group:g-1': { layout: 'radial', positions: { a: { x: -50, y: 75 } } },
			});
		});

		it('sanitizes a record that was edited by hand', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				[DELEGATION_GRAPH_LAYOUTS_SETTING]: {
					all: { layout: 'nonsense', positions: { a: { x: 1, y: 2 }, b: { x: 'x', y: 2 } } },
					'not-a-scope': { layout: 'manual', positions: { a: { x: 1, y: 2 } } },
				},
			});

			await loadAllSettings();

			expect(layouts()).toEqual({
				all: { layout: 'hierarchical', positions: { a: { x: 1, y: 2 } } },
			});
		});
	});
});
