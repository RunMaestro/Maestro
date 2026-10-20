/**
 * The binding set each keyboard mode is matched against, plus the allowlist of
 * chords more than one action may legitimately claim.
 *
 * Shared by `constants/shortcuts.test.ts` (the per-mode guards, which run over
 * every mode) and `constants/vimShortcuts.test.ts` (the Vim-only guards). Both
 * files have to agree on two things or their verdicts mean nothing:
 *
 *  - WHICH maps a mode is matched against. A mode's effective set is its sparse
 *    override bucket resolved onto the default tables, PLUS `FIXED_SHORTCUTS`,
 *    which is shared by both modes and is not rebindable. A second copy of that
 *    assembly would eventually drift, and the copy that drifted would be the one
 *    quietly leaving a table out - which makes every collision and reachability
 *    test in that file pass vacuously.
 *  - WHICH collisions are legal. A chord two actions share on purpose is a
 *    scope decision with a reason behind it, and a second copy of the list is a
 *    second place for an exemption to outlive that reason.
 */

import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	TAB_SHORTCUTS,
} from '../../renderer/constants/shortcuts';
import { VIM_SHORTCUTS, VIM_TAB_SHORTCUTS } from '../../renderer/constants/vimShortcuts';
import {
	resolveEffectiveShortcuts,
	type EffectiveShortcuts,
	type ShortcutBaseMaps,
	type ShortcutOverrideMaps,
} from '../../shared/effectiveShortcuts';
import type { KeyboardMode, Shortcut } from '../../shared/shortcut-types';

/** One chord claimed by several actions, with the gate that keeps them apart. */
export interface IntentionallySharedGroup {
	chord: string;
	ids: string[];
	why: string;
}

/**
 * Chords that more than one action may legitimately claim, each with the gate
 * that keeps them apart. Add to this ONLY with the reason written down.
 *
 * Read two ways. The shipped-defaults guard matches a group by its `chord`,
 * because that is the chord default mode gives the group. The per-mode guards
 * match on `ids` alone: the gate that keeps a group apart is its scope, not the
 * chord it happens to sit on, so a mode that moves the group to another chord
 * keeps the exemption and a group that gains a member loses it.
 */
export const INTENTIONALLY_SHARED: IntentionallySharedGroup[] = [
	{
		chord: 'Meta+f',
		ids: [
			'filterFiles',
			'filterSessions',
			'filterHistory',
			'searchLogs',
			'searchOutput',
			'searchDirectorNotes',
		],
		why: "Each is scoped to the surface that has focus (Files tab, Left Panel, History tab, System Log viewer, Main Window, Director's Notes). Only one of those surfaces is focused at a time.",
	},
	{
		chord: 'Meta+e',
		ids: ['toggleMarkdownMode', 'renameAgentSession'],
		why: 'The Sessions Browser is a modal layer that blocks lower layers, and its own handler consumes the key before the app-level one runs. With the browser closed there is no session row to rename; with it open there is no markdown pane to flip.',
	},
	{
		chord: 'Meta+Shift+k',
		ids: ['clearTerminal', 'toggleShowThinking'],
		why: 'Mutually exclusive by input mode: clearTerminal is gated on inputMode === "terminal" (useMainKeyboardHandler), toggleShowThinking is a tab shortcut reached only in AI mode.',
	},
];

/** An id set, canonical and order-independent, for comparing sharing groups. */
export function shortcutIdSetKey(ids: readonly string[]): string {
	return [...ids].sort().join(',');
}

/**
 * Whether these ids are exactly an allowlisted sharing group.
 *
 * Exact, deliberately: listing a chord does not license every future action to
 * join that group. A new arrival is a new decision about scope and has to be
 * made on purpose, so a group that gains a member fails until the allowlist
 * says why.
 */
export function isIntentionallySharedByIds(ids: readonly string[]): boolean {
	const key = shortcutIdSetKey(ids);
	return INTENTIONALLY_SHARED.some((group) => shortcutIdSetKey(group.ids) === key);
}

/** The default-mode buckets every mode inherits from. */
export const SHORTCUT_BASE_MAPS: ShortcutBaseMaps = {
	shortcuts: DEFAULT_SHORTCUTS as Record<string, Shortcut>,
	tabShortcuts: TAB_SHORTCUTS as Record<string, Shortcut>,
};

/**
 * Each mode's override bucket, so adding a mode is one row here.
 *
 * Default mode's is empty on purpose, and that is not a stand-in for the real
 * thing: default mode IS the base tables, which is why `selectActiveShortcuts`
 * hands back the bucket itself without resolving. `resolveEffectiveShortcuts`
 * returns those same maps by identity when the overrides are empty, so running
 * both modes through one builder measures exactly what the live mode is matched
 * against.
 */
export const MODE_OVERRIDES: Record<KeyboardMode, ShortcutOverrideMaps> = {
	default: { vimShortcuts: {}, vimTabShortcuts: {} },
	vim: { vimShortcuts: VIM_SHORTCUTS, vimTabShortcuts: VIM_TAB_SHORTCUTS },
};

/** One mode's resolved pair of maps, plus whatever its overrides displaced. */
export function effectiveShortcutsForMode(mode: KeyboardMode): EffectiveShortcuts {
	return resolveEffectiveShortcuts(SHORTCUT_BASE_MAPS, MODE_OVERRIDES[mode]);
}

/**
 * Every action a mode can fire, with the chord and sequence it fires on there.
 *
 * `FIXED_SHORTCUTS` is appended because it is part of every mode's set: it is
 * not rebindable and no override bucket may name it, so both modes are matched
 * against it exactly as it ships and a mode chord landing on one of its chords
 * is a real collision.
 */
export function effectiveActionsForMode(mode: KeyboardMode): Shortcut[] {
	const resolved = effectiveShortcutsForMode(mode);
	return [
		...Object.values(resolved.shortcuts),
		...Object.values(resolved.tabShortcuts),
		...Object.values(FIXED_SHORTCUTS),
	];
}
