/**
 * Browser tab viewport presets: the page widths a browser tab can show a page
 * at, besides filling the tab.
 *
 * A page picks its layout from the width of its viewport, so a laptop with both
 * side bars open can push a site onto its phone layout. `fit` is the default:
 * the page gets the tab's own width, as a browser tab always has. Any other
 * preset names a fixed CSS width (`BROWSER_VIEWPORT_WIDTHS`) the tab shows the
 * page at, scaled down to fit when the tab is narrower.
 *
 * Kept in `src/shared` so the renderer (toolbar, palette, persistence) and the
 * CLI (`maestro-cli browser-viewport`) read one table.
 */

/** Every preset, in the order the toolbar control and the palette list them. */
export const BROWSER_VIEWPORT_PRESETS = ['fit', 'desktop', 'laptop', 'tablet', 'phone'] as const;

export type BrowserViewportPreset = (typeof BROWSER_VIEWPORT_PRESETS)[number];

/** What a tab without a saved preset shows: the page at the tab's own width. */
export const DEFAULT_BROWSER_VIEWPORT_PRESET: BrowserViewportPreset = 'fit';

/** The CSS width the page sees at each fixed preset. `fit` has none. */
export const BROWSER_VIEWPORT_WIDTHS = {
	desktop: 1440,
	laptop: 1280,
	tablet: 768,
	phone: 390,
} as const satisfies Record<Exclude<BrowserViewportPreset, 'fit'>, number>;

const PRESET_LABELS: Record<BrowserViewportPreset, string> = {
	fit: 'Fit',
	desktop: 'Desktop',
	laptop: 'Laptop',
	tablet: 'Tablet',
	phone: 'Phone',
};

/**
 * The preset a value names, or null. Case and surrounding space are ignored so
 * a typed `Phone ` works; anything else (a width, a made-up name, a non-string)
 * is not a preset. Used for CLI input and for tab data read from disk.
 */
export function parseBrowserViewportPreset(value: unknown): BrowserViewportPreset | null {
	if (typeof value !== 'string') return null;
	const name = value.trim().toLowerCase();
	return BROWSER_VIEWPORT_PRESETS.find((preset) => preset === name) ?? null;
}

/** The CSS width a preset shows the page at, or null for `fit`. */
export function browserViewportWidth(preset: BrowserViewportPreset): number | null {
	return preset === 'fit' ? null : BROWSER_VIEWPORT_WIDTHS[preset];
}

/** `Fit`, `Desktop`, `Laptop`, `Tablet`, `Phone`. */
export function browserViewportLabel(preset: BrowserViewportPreset): string {
	return PRESET_LABELS[preset];
}

/** `Phone (390 px wide)`, or `Fit (the tab's width)`: the label with what it means. */
export function describeBrowserViewport(preset: BrowserViewportPreset): string {
	const width = browserViewportWidth(preset);
	return `${PRESET_LABELS[preset]} (${width === null ? "the tab's width" : `${width} px wide`})`;
}
