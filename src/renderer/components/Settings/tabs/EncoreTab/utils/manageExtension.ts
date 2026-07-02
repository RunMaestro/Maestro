/**
 * Plugins-tab navigation helpers. The marketplace (ExtensionsView, mounted at
 * the TOP of the Plugins tab) is THE management surface for first-party
 * features; the per-feature config sections sit below it. These helpers jump
 * between the two: tile -> its config section (Configure) and config section
 * -> its tile (Manage), flashing the same themed highlight the settings
 * search jump uses (.settings-search-highlight).
 */

import type { EncoreFeatureFlags } from '../../../../../types';

/** How long the jump highlight stays on — matches the 3s CSS animation. */
const HIGHLIGHT_MS = 3000;

function jumpTo(el: HTMLElement | null, accentColor: string): void {
	if (!el) return;
	el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
	el.style.setProperty('--settings-search-jump-color', accentColor);
	el.classList.add('settings-search-highlight');
	setTimeout(() => {
		el.classList.remove('settings-search-highlight');
		el.style.removeProperty('--settings-search-jump-color');
	}, HIGHLIGHT_MS);
}

export function scrollToExtensionTile(flag: keyof EncoreFeatureFlags, accentColor: string): void {
	// Prefer the tile itself; when the marketplace is showing a details pane
	// (the grid is unmounted), fall back to the Extensions view container.
	jumpTo(
		document.querySelector<HTMLElement>(`[data-extension-key="builtin:${flag}"]`) ??
			document.querySelector<HTMLElement>('[data-testid="extensions-view"]'),
		accentColor
	);
}

/** data-setting-id anchor of each feature's config section (pianola has no
 * inline section — its config lives in the Pianola modal). */
const CONFIG_SECTION_ANCHORS: Partial<Record<keyof EncoreFeatureFlags, string>> = {
	usageStats: 'encore-usage-stats',
	symphony: 'encore-symphony',
	maestroCue: 'encore-cue',
	directorNotes: 'encore-director-notes',
};

/** Tile "Configure" -> the feature's config section below the marketplace.
 * Returns false when the feature has no inline config section. */
export function scrollToEncoreConfigSection(
	flag: keyof EncoreFeatureFlags,
	accentColor: string
): boolean {
	const anchor = CONFIG_SECTION_ANCHORS[flag];
	if (!anchor) return false;
	jumpTo(document.querySelector<HTMLElement>(`[data-setting-id="${anchor}"]`), accentColor);
	return true;
}
