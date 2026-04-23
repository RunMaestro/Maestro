/**
 * Curated subset of desktop shortcuts that map to actions the mobile web UI
 * actually implements. The web client reads user customizations from
 * `settings.shortcuts` and merges them on top of these defaults.
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
 * Merge user shortcut overrides on top of the web defaults.
 * Ignores overrides for action IDs the web UI doesn't implement.
 */
export function resolveWebShortcuts(
	userOverrides: Record<string, Shortcut> | undefined
): Record<string, Shortcut> {
	if (!userOverrides) return WEB_DEFAULT_SHORTCUTS;
	const merged: Record<string, Shortcut> = { ...WEB_DEFAULT_SHORTCUTS };
	for (const id of WEB_SHORTCUT_IDS) {
		const override = userOverrides[id];
		if (override) merged[id] = override;
	}
	return merged;
}
