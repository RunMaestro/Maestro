import { describe, it, expect, vi } from 'vitest';

let webDesktop = false;
vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: () => webDesktop,
}));

import {
	SHORTCUT_ENCORE_FLAGS,
	availableShortcuts,
	isShortcutAvailable,
} from '../../../renderer/utils/encoreShortcuts';
import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	TAB_SHORTCUTS,
} from '../../../renderer/constants/shortcuts';
import { ENCORE_FEATURE_DEFAULTS } from '../../../shared/encoreFeatureDefaults';

const ALL_OFF = Object.fromEntries(
	Object.keys(ENCORE_FEATURE_DEFAULTS).map((key) => [key, false])
) as Record<keyof typeof ENCORE_FEATURE_DEFAULTS, boolean>;
const ALL_ON = Object.fromEntries(
	Object.keys(ENCORE_FEATURE_DEFAULTS).map((key) => [key, true])
) as Record<keyof typeof ENCORE_FEATURE_DEFAULTS, boolean>;

describe('encoreShortcuts', () => {
	it('names only shortcuts and flags that exist', () => {
		const known = { ...DEFAULT_SHORTCUTS, ...TAB_SHORTCUTS, ...FIXED_SHORTCUTS };
		for (const [id, flag] of Object.entries(SHORTCUT_ENCORE_FLAGS)) {
			expect(known[id], `shortcut "${id}"`).toBeDefined();
			expect(ENCORE_FEATURE_DEFAULTS, `flag "${flag}"`).toHaveProperty(flag);
		}
	});

	it('drops every Encore shortcut when its feature is off', () => {
		const visible = availableShortcuts({ ...DEFAULT_SHORTCUTS, ...FIXED_SHORTCUTS }, ALL_OFF);
		for (const id of Object.keys(SHORTCUT_ENCORE_FLAGS)) {
			expect(visible[id], id).toBeUndefined();
		}
		// A shortcut with no Encore owner is never dropped.
		expect(visible.quickAction).toBe(DEFAULT_SHORTCUTS.quickAction);
	});

	it('keeps every Encore shortcut when its feature is on', () => {
		webDesktop = false;
		const all = { ...DEFAULT_SHORTCUTS, ...FIXED_SHORTCUTS };
		expect(Object.keys(availableShortcuts(all, ALL_ON))).toEqual(Object.keys(all));
	});

	it('lists the Throughput Gauge toggle only while its feature is on', () => {
		expect(availableShortcuts(DEFAULT_SHORTCUTS, ALL_OFF).toggleThroughputGauge).toBeUndefined();
		expect(
			availableShortcuts(DEFAULT_SHORTCUTS, { ...ALL_OFF, throughputGauge: true })
				.toggleThroughputGauge
		).toBe(DEFAULT_SHORTCUTS.toggleThroughputGauge);
	});

	it.each(['openBoard', 'openProfiles'])('lists %s only with Board and Cue enabled', (id) => {
		expect(isShortcutAvailable(id, { ...ALL_ON, board: false })).toBe(false);
		expect(isShortcutAvailable(id, { ...ALL_ON, maestroCue: false })).toBe(false);
		expect(isShortcutAvailable(id, ALL_ON)).toBe(true);
	});

	it('treats a missing flag map as everything off', () => {
		expect(isShortcutAvailable('openCue', undefined)).toBe(false);
		expect(isShortcutAvailable('quickAction', undefined)).toBe(true);
	});

	it('withholds Computer History on web-desktop even with the flag on', () => {
		webDesktop = true;
		expect(isShortcutAvailable('computerHistory', ALL_ON)).toBe(false);
		webDesktop = false;
		expect(isShortcutAvailable('computerHistory', ALL_ON)).toBe(true);
	});
});
