/**
 * "Manage in Extensions" navigation: the marketplace (ExtensionsView, mounted
 * at the bottom of the Encore tab) is THE management surface for first-party
 * features — the per-feature config sections above it only display state.
 * This scrolls the feature's tile into view and flashes the same themed
 * highlight the settings search jump uses (.settings-search-highlight).
 */

import type { EncoreFeatureFlags } from '../../../../../types';

/** How long the jump highlight stays on — matches the 3s CSS animation. */
const HIGHLIGHT_MS = 3000;

export function scrollToExtensionTile(flag: keyof EncoreFeatureFlags, accentColor: string): void {
	// Prefer the tile itself; when the marketplace is showing a details pane
	// (the grid is unmounted), fall back to the Extensions view container.
	const el =
		document.querySelector<HTMLElement>(`[data-extension-key="builtin:${flag}"]`) ??
		document.querySelector<HTMLElement>('[data-testid="extensions-view"]');
	if (!el) return;
	el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
	el.style.setProperty('--settings-search-jump-color', accentColor);
	el.classList.add('settings-search-highlight');
	setTimeout(() => {
		el.classList.remove('settings-search-highlight');
		el.style.removeProperty('--settings-search-jump-color');
	}, HIGHLIGHT_MS);
}
