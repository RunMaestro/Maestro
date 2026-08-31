/**
 * The fonts Maestro ships with itself.
 *
 * These are downloaded at build time by `scripts/fetch-webfonts.mjs` and served
 * from the app's own bundle, so they exist on every machine regardless of what
 * the user has installed. That is the whole point: a system font can only be
 * OFFERED and hoped for, while a bundled font can be PROMISED. The picker
 * never annotates one "(Not Found)", because it cannot be.
 *
 * Only OFL / Apache-2.0 families are here. The proprietary system faces
 * (Menlo, SF Mono, Consolas, Segoe UI, Arial, Helvetica, Verdana, Tahoma,
 * Georgia, Avenir Next, Trebuchet MS) are licensed to the operating system and
 * are not redistributable, so they stay in the system groups. Several have a
 * metric-compatible open substitute, which is bundled and cross-referenced by
 * `substituteFor` so the picker can say so rather than leaving the user to
 * discover that Arimo is Arial.
 *
 * Keep in sync with the FAMILIES list in scripts/fetch-webfonts.mjs. The test
 * in bundledFonts.test.ts asserts the two agree, since a name that is listed
 * here but never downloaded is a font the picker promises and cannot deliver.
 */

export type BundledFontKind = 'mono' | 'sans' | 'serif';

export interface BundledFont {
	/** CSS family name, exactly as the generated @font-face declares it. */
	name: string;
	kind: BundledFontKind;
	/**
	 * The proprietary face this one is metric-compatible with, if any. Metric
	 * compatible means identical advance widths, so swapping it into a layout
	 * built for the original reflows nothing.
	 */
	substituteFor?: string;
	/** Short note shown beside the name in the picker. */
	note?: string;
}

export const BUNDLED_FONTS: BundledFont[] = [
	// --- Monospace ---
	{ name: 'JetBrains Mono', kind: 'mono', note: 'Maestro default' },
	{ name: 'Fira Code', kind: 'mono' },
	{ name: 'Roboto Mono', kind: 'mono' },
	{ name: 'Source Code Pro', kind: 'mono' },
	{ name: 'IBM Plex Mono', kind: 'mono' },
	{ name: 'Inconsolata', kind: 'mono' },
	{ name: 'Cousine', kind: 'mono', substituteFor: 'Courier New' },
	// --- Proportional ---
	{ name: 'Inter', kind: 'sans' },
	{ name: 'Roboto', kind: 'sans' },
	{ name: 'Open Sans', kind: 'sans' },
	{ name: 'Lato', kind: 'sans' },
	{ name: 'Source Sans 3', kind: 'sans' },
	{ name: 'Nunito Sans', kind: 'sans' },
	{ name: 'Figtree', kind: 'sans' },
	{ name: 'Arimo', kind: 'sans', substituteFor: 'Arial' },
	// --- Serif ---
	{ name: 'Gelasio', kind: 'serif', substituteFor: 'Georgia' },
	{ name: 'Tinos', kind: 'serif', substituteFor: 'Times New Roman' },
];

export const BUNDLED_FONT_NAMES: string[] = BUNDLED_FONTS.map((f) => f.name);

const BUNDLED_LOOKUP = new Map(BUNDLED_FONTS.map((f) => [f.name.toLowerCase(), f]));

/** Whether a family ships with the app, and so is guaranteed to render. */
export function isBundledFont(name: string | undefined | null): boolean {
	if (!name) return false;
	return BUNDLED_LOOKUP.has(name.trim().toLowerCase());
}

export function getBundledFont(name: string | undefined | null): BundledFont | undefined {
	if (!name) return undefined;
	return BUNDLED_LOOKUP.get(name.trim().toLowerCase());
}

/**
 * The bundled family that is metric-compatible with a proprietary face, if one
 * exists. Lets the picker offer "Arimo (metric-compatible with Arial)" to a
 * user on a platform where Arial genuinely is absent.
 */
export function bundledSubstituteFor(name: string): BundledFont | undefined {
	const needle = name.trim().toLowerCase();
	return BUNDLED_FONTS.find((f) => f.substituteFor?.toLowerCase() === needle);
}
