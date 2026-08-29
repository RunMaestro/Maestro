/**
 * Typography surfaces - the single registry of "what can carry its own font".
 *
 * Every consumer reads this rather than re-listing the five surfaces: the
 * Settings pickers, the CSS custom properties the renderer publishes, the
 * presets, the CLI verbs, and the web client. Adding a sixth surface means
 * adding one entry here, not touching eight files that each know four of them.
 *
 * Two settings back each surface:
 *   - `fontKey`  - the family. Empty string means "inherit the interface font",
 *                  so a surface keeps following the UI until the user picks for
 *                  it specifically.
 *   - `sizeKey`  - the size in px. `0` means "inherit the interface size", for
 *                  the same reason. The interface surface itself is the base
 *                  and cannot inherit, so its size is always a real number.
 *
 * Sizes are stored WITHOUT the zoom applied. `fontZoom` is a separate
 * multiplier that Cmd+= / Cmd+- moves, so zooming scales every surface by the
 * same ratio, preserving whatever proportions the user set, and Cmd+Shift+0
 * restores them exactly instead of flattening them back to one size.
 */

/** Ordered so the Settings tab and the CLI list surfaces the same way. */
export const TYPOGRAPHY_SURFACES = [
	'interface',
	'chat',
	'terminal',
	'filePreview',
	'fileEditor',
] as const;

export type TypographySurface = (typeof TYPOGRAPHY_SURFACES)[number];

export interface TypographySurfaceSpec {
	id: TypographySurface;
	/** Human label used by the Settings heading and the CLI table. */
	label: string;
	/** Settings key holding this surface's font family. */
	fontKey: string;
	/** Settings key holding this surface's font size in px. */
	sizeKey: string;
	/**
	 * CSS custom property carrying the RESOLVED family (inheritance applied,
	 * fallback chain appended). Published on `document.documentElement`, so
	 * anything that escapes the app shell through a portal can still reach it.
	 */
	fontVar: string;
	/** CSS custom property carrying the resolved size in px, zoom applied. */
	sizeVar: string;
	/**
	 * Whether this surface may inherit from the interface surface. False only
	 * for `interface` itself, which is the root of the chain.
	 */
	inheritable: boolean;
	/** CLI alias accepted in addition to the id (`preview` for `filePreview`). */
	aliases: string[];
	/** One-line description for `maestro-cli display font --list` and Settings. */
	description: string;
}

export const TYPOGRAPHY_SURFACE_SPECS: Record<TypographySurface, TypographySurfaceSpec> = {
	interface: {
		id: 'interface',
		label: 'Interface',
		fontKey: 'fontFamily',
		sizeKey: 'fontSize',
		fontVar: '--maestro-font-interface',
		sizeVar: '--maestro-size-interface',
		inheritable: false,
		aliases: ['ui', 'app'],
		description: 'The whole app, and the default every other surface inherits.',
	},
	chat: {
		id: 'chat',
		label: 'AI Chat',
		fontKey: 'chatFontFamily',
		sizeKey: 'chatFontSize',
		fontVar: '--maestro-font-chat',
		sizeVar: '--maestro-size-chat',
		inheritable: true,
		aliases: ['ai', 'transcript'],
		description: 'The AI transcript, in the main panel and in tiled panes.',
	},
	terminal: {
		id: 'terminal',
		label: 'Terminal',
		fontKey: 'terminalFontFamily',
		sizeKey: 'terminalFontSize',
		fontVar: '--maestro-font-terminal',
		sizeVar: '--maestro-size-terminal',
		inheritable: true,
		aliases: ['shell', 'command'],
		description: 'The command terminal. A Nerd Font here gets shell prompt glyphs.',
	},
	filePreview: {
		id: 'filePreview',
		label: 'File Preview',
		fontKey: 'filePreviewFontFamily',
		sizeKey: 'filePreviewFontSize',
		fontVar: '--maestro-font-file-preview',
		sizeVar: '--maestro-size-file-preview',
		inheritable: true,
		aliases: ['preview', 'reader'],
		description: 'A file being read.',
	},
	fileEditor: {
		id: 'fileEditor',
		label: 'File Editor',
		fontKey: 'fileEditorFontFamily',
		sizeKey: 'fileEditorFontSize',
		fontVar: '--maestro-font-file-editor',
		sizeVar: '--maestro-size-file-editor',
		inheritable: true,
		aliases: ['editor', 'edit'],
		description: 'A file being edited. Monospace keeps the gutter aligned with the text.',
	},
};

export const TYPOGRAPHY_SURFACE_LIST: TypographySurfaceSpec[] = TYPOGRAPHY_SURFACES.map(
	(id) => TYPOGRAPHY_SURFACE_SPECS[id]
);

/**
 * CSS custom property carrying the font Tailwind's `font-mono` utility resolves
 * to. Distinct from any single surface: `font-mono` marks the ~200 places that
 * want a CODE face regardless of which surface they sit on - shortcut chips,
 * hashes, paths, inline code. Pinning it to a hard-coded stack meant none of
 * them followed the user's chosen monospace font.
 */
export const MONO_ACCENT_VAR = '--maestro-font-mono';

/** Zoom multiplier bounds. Matches the old FONT_SIZE_MIN/MAX range at 14px base. */
export const FONT_ZOOM_MIN = 0.6;
export const FONT_ZOOM_MAX = 2.4;
export const FONT_ZOOM_DEFAULT = 1;
export const FONT_ZOOM_STEP = 0.1;

/** Per-surface size bounds, before zoom. */
export const SURFACE_FONT_SIZE_MIN = 8;
export const SURFACE_FONT_SIZE_MAX = 32;
/** The interface size a fresh install starts at, and what Reset restores. */
export const BASE_FONT_SIZE_DEFAULT = 14;

/** Clamp a zoom multiplier and round it to one decimal so it stays legible. */
export function clampFontZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) return FONT_ZOOM_DEFAULT;
	const clamped = Math.min(FONT_ZOOM_MAX, Math.max(FONT_ZOOM_MIN, zoom));
	return Math.round(clamped * 100) / 100;
}

/** Clamp a stored per-surface size. `0` passes through, meaning "inherit". */
export function clampSurfaceFontSize(size: number): number {
	if (!Number.isFinite(size) || size <= 0) return 0;
	return Math.min(SURFACE_FONT_SIZE_MAX, Math.max(SURFACE_FONT_SIZE_MIN, Math.round(size)));
}

/**
 * The size a surface renders at: its own size or the interface size when unset,
 * times the zoom.
 *
 * Rounded to one decimal rather than a whole pixel. Whole-pixel rounding makes
 * consecutive zoom steps collapse onto the same rendered size at small sizes
 * (11px at 1.0 and at 1.05 both round to 11), so a keypress appears to do
 * nothing; browsers accept fractional px and hint it themselves.
 */
export function resolveSurfaceFontSize(
	surfaceSize: number | undefined,
	baseSize: number,
	zoom: number
): number {
	const base = baseSize > 0 ? baseSize : BASE_FONT_SIZE_DEFAULT;
	const own = surfaceSize && surfaceSize > 0 ? surfaceSize : base;
	return Math.round(own * clampFontZoom(zoom) * 10) / 10;
}

/** Resolve a CLI/user-supplied surface name, accepting ids and aliases. */
export function resolveTypographySurface(name: string): TypographySurfaceSpec | null {
	const needle = name
		.trim()
		.toLowerCase()
		.replace(/[\s_-]/g, '');
	for (const spec of TYPOGRAPHY_SURFACE_LIST) {
		if (spec.id.toLowerCase() === needle) return spec;
		if (spec.aliases.some((alias) => alias.toLowerCase().replace(/[\s_-]/g, '') === needle)) {
			return spec;
		}
	}
	return null;
}
