/**
 * Curated subset of desktop shortcuts that map to actions the mobile web UI
 * actually implements. The web client reads user customizations from
 * `settings.shortcuts` and merges them on top of these defaults.
 *
 * DEFAULT MODE ONLY, deliberately. `settings.shortcuts` is the default-mode
 * bucket; the Vim buckets (`vimShortcuts` / `vimTabShortcuts`) are sparse
 * OVERRIDE tables whose entries may legitimately carry no `keys` at all, which
 * is the spelling for "inherit the default-mode chord" (see
 * `src/shared/effectiveShortcuts.ts`). Resolving a mode here would mean
 * duplicating that resolver for the sixteen actions below, so the web client
 * stays on the default-mode set and `keyboardMode` is simply not read: a Vim
 * user on a phone gets the default chords, which are the ones the on-screen
 * hints show. Nothing here throws on any of the three keys - a mode string is
 * never consulted, and {@link resolveWebShortcuts} drops an entry without a
 * usable chord rather than handing it to the matcher.
 */

import type { Shortcut } from '../../shared/shortcut-types';
import { DEFAULT_SHORTCUTS } from '../../renderer/constants/shortcuts';

/** Action IDs the mobile web UI supports. Keys match desktop shortcut IDs. */
export const WEB_SHORTCUT_IDS = [
	'quickAction',
	'toggleMode',
	'prevTab',
	'nextTab',
	'cyclePrev',
	'cycleNext',
	'newInstance',
	'settings',
	'goToFiles',
	'goToHistory',
	'goToAutoRun',
	'agentSessions',
	'usageDashboard',
	'openCue',
	'newGroupChat',
	'killInstance',
] as const;

export type WebShortcutId = (typeof WEB_SHORTCUT_IDS)[number];

/** Defaults for the web-supported subset (filtered from DEFAULT_SHORTCUTS). */
export const WEB_DEFAULT_SHORTCUTS: Record<string, Shortcut> = WEB_SHORTCUT_IDS.reduce(
	(acc, id) => {
		const sc = DEFAULT_SHORTCUTS[id];
		if (sc) acc[id] = sc;
		return acc;
	},
	{} as Record<string, Shortcut>
);

/**
 * Whether a persisted entry carries a chord this client can match.
 *
 * The argument is whatever is in the settings file, so it is `unknown` however
 * it is typed: the web client receives settings over the socket, and the file
 * can be hand-edited, sync-mangled, or (the case that motivated this) an entry
 * from one of the sparse Vim override buckets, where a missing `keys` is a real
 * and meaningful value. `matchesShortcut` in `useMobileKeyboardHandler` calls
 * `sc.keys.map(...)` unguarded, so an entry without an array of strings there is
 * a TypeError inside a window keydown listener - which takes out every other
 * shortcut on the page, not just the bad one. An empty array is rejected too:
 * it means "cleared", and the default it would otherwise replace is a chord the
 * user asked not to have.
 */
function hasUsableChord(entry: unknown): entry is Shortcut {
	if (!entry || typeof entry !== 'object') return false;
	const keys = (entry as { keys?: unknown }).keys;
	return Array.isArray(keys) && keys.length > 0 && keys.every((key) => typeof key === 'string');
}

/**
 * Merge user shortcut overrides on top of the web defaults.
 *
 * Ignores overrides for action IDs the web UI doesn't implement, and ignores an
 * entry whose chord this client cannot match - see {@link hasUsableChord}. A
 * dropped entry leaves the shipped default in place, so the action keeps
 * working rather than going dead or taking the handler down with it.
 */
export function resolveWebShortcuts(
	userOverrides: Record<string, unknown> | undefined
): Record<string, Shortcut> {
	if (!userOverrides) return WEB_DEFAULT_SHORTCUTS;
	const merged: Record<string, Shortcut> = { ...WEB_DEFAULT_SHORTCUTS };
	for (const id of WEB_SHORTCUT_IDS) {
		const override = userOverrides[id];
		if (hasUsableChord(override)) merged[id] = override;
	}
	return merged;
}
