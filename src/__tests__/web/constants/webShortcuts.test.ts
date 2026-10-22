/**
 * The web client's shortcut merge, against the settings file a desktop user
 * with keyboard modes actually has.
 *
 * The mobile web UI implements a curated sixteen of the desktop actions and
 * resolves them from `settings.shortcuts`, the DEFAULT-mode bucket. Keyboard
 * modes added three more keys to that file - `keyboardMode`, `vimShortcuts`,
 * and `vimTabShortcuts` - and the web client has to be unbothered by all
 * three, because it is handed whatever the desktop persisted.
 *
 * The one that is dangerous is not the mode string (never read) but the shape
 * of a Vim bucket ENTRY. Those buckets are sparse OVERRIDE tables, so an entry
 * with no `keys` at all is normal and meaningful - it spells "inherit the
 * default-mode chord" (`src/shared/effectiveShortcuts.ts`). `matchesShortcut`
 * in `useMobileKeyboardHandler` calls `sc.keys.map(...)` unguarded, and it runs
 * inside a window keydown listener, so one such entry reaching it is a
 * TypeError that takes every OTHER shortcut on the page down with it.
 *
 * So the merge is the gate, and these are its cases.
 */

import { describe, it, expect } from 'vitest';
import {
	WEB_DEFAULT_SHORTCUTS,
	WEB_SHORTCUT_IDS,
	resolveWebShortcuts,
} from '../../../web/constants/webShortcuts';
import { DEFAULT_SHORTCUTS } from '../../../renderer/constants/shortcuts';
import { VIM_SHORTCUTS, VIM_TAB_SHORTCUTS } from '../../../renderer/constants/vimShortcuts';

/** Every merged entry carries a chord the matcher can read. */
function expectEveryEntryMatchable(merged: Record<string, { keys: string[] }>): void {
	const broken = Object.entries(merged)
		.filter(([, sc]) => !Array.isArray(sc?.keys) || sc.keys.some((k) => typeof k !== 'string'))
		.map(([id]) => id);
	expect(
		broken,
		'every merged entry must carry an array of strings, because matchesShortcut calls keys.map() on it inside a window keydown listener'
	).toEqual([]);
}

describe('resolveWebShortcuts', () => {
	it('returns the shipped defaults when the settings file has no shortcuts', () => {
		expect(resolveWebShortcuts(undefined)).toBe(WEB_DEFAULT_SHORTCUTS);
		expectEveryEntryMatchable(resolveWebShortcuts(undefined));
	});

	it('takes a default-mode customization, and only for an id the web implements', () => {
		const merged = resolveWebShortcuts({
			settings: { id: 'settings', label: 'Settings', keys: ['Alt', 'Home'] },
			// A real desktop action the mobile UI has no handler for. Merging it
			// would bind a key to nothing.
			toggleSidebar: { id: 'toggleSidebar', label: 'Toggle Sidebar', keys: ['Alt', 'End'] },
		});

		expect(merged.settings.keys).toEqual(['Alt', 'Home']);
		expect(merged.toggleSidebar).toBeUndefined();
		expect(Object.keys(merged).sort()).toEqual([...WEB_SHORTCUT_IDS].sort());
	});

	/**
	 * The three keyboard-mode settings keys, one case each. None of them may
	 * throw, and none may leave an entry the matcher cannot read.
	 */
	describe('the keyboard-mode settings keys', () => {
		it('is unaffected by keyboardMode, in either value', () => {
			// Not read at all, deliberately: resolving a mode here would mean a
			// second copy of the inheritance and displacement rules for sixteen
			// actions. A Vim user on a phone gets the default chords, which are
			// the ones the on-screen hints show.
			for (const keyboardMode of ['default', 'vim', 'something-else']) {
				const file = { keyboardMode, shortcuts: {} } as Record<string, unknown>;
				const merged = resolveWebShortcuts(file.shortcuts as Record<string, unknown> | undefined);
				expect(merged.settings.keys).toEqual(DEFAULT_SHORTCUTS.settings.keys);
			}
		});

		for (const [name, bucket] of [
			['vimShortcuts', VIM_SHORTCUTS],
			['vimTabShortcuts', VIM_TAB_SHORTCUTS],
		] as const) {
			it(`survives being handed the whole ${name} bucket as it ships`, () => {
				// Whole bucket, entry for entry, including every sequence-carrying
				// and chordless one. Handing an override bucket here is not what
				// the web client does today, but it is one line away from being
				// what a future caller does, and the failure mode is a TypeError
				// in a keydown listener rather than a wrong chord.
				const merged = resolveWebShortcuts(bucket as unknown as Record<string, unknown>);
				expectEveryEntryMatchable(merged);
				// Nothing goes UNBOUND either. Every id the web implements still
				// resolves: to the bucket's chord where it has one, and to the
				// shipped default where the bucket is silent or chordless.
				for (const id of WEB_SHORTCUT_IDS) {
					const entry = (bucket as Record<string, { keys?: string[] }>)[id];
					const expected = entry?.keys?.length ? entry.keys : DEFAULT_SHORTCUTS[id].keys;
					expect(merged[id].keys, id).toEqual(expected);
				}
			});
		}
	});

	/**
	 * A settings file is not a type. It can be hand-edited, half-written by a
	 * crash, mangled by a sync tool, or (the case above) handed in from a bucket
	 * with a different shape.
	 */
	describe('a persisted entry the matcher could not read', () => {
		const unusable: Record<string, unknown> = {
			// "Inherit the default-mode chord" - the Vim-bucket spelling.
			inheritShape: { id: 'settings', label: 'Settings' },
			// A sequence-only override: a real trigger, but not a chord.
			sequenceOnly: { id: 'settings', label: 'Settings', sequence: [['g'], ['s']] },
			// Hand-edited as the string a user would naturally type.
			typedString: { id: 'settings', label: 'Settings', keys: 'Alt+Home' },
			number: { id: 'settings', label: 'Settings', keys: 7 },
			holeInTheArray: { id: 'settings', label: 'Settings', keys: ['Alt', null] },
			objectInTheArray: { id: 'settings', label: 'Settings', keys: [{ key: 'Alt' }] },
			// Present and empty means "cleared in this mode", which must not
			// replace a default the user never asked to lose.
			cleared: { id: 'settings', label: 'Settings', keys: [] },
			notAnObject: 'Alt+Home',
			nulled: null,
		};

		for (const [name, entry] of Object.entries(unusable)) {
			it(`keeps the shipped chord for ${name}`, () => {
				const merged = resolveWebShortcuts({ settings: entry });
				expect(merged.settings.keys).toEqual(DEFAULT_SHORTCUTS.settings.keys);
				expectEveryEntryMatchable(merged);
			});
		}

		it('costs only the bad entry: a good one beside it still lands', () => {
			// The distinction that matters. Rejecting the VALUE loses one chord;
			// throwing loses the handler, and with it all sixteen.
			const merged = resolveWebShortcuts({
				settings: { id: 'settings', label: 'Settings', keys: 'Alt+Home' },
				quickAction: { id: 'quickAction', label: 'Quick Actions', keys: ['Alt', 'End'] },
			});

			expect(merged.settings.keys).toEqual(DEFAULT_SHORTCUTS.settings.keys);
			expect(merged.quickAction.keys).toEqual(['Alt', 'End']);
		});
	});
});
