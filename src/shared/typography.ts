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
	'terminal',
	'chat',
	'filePreview',
	'fileEditor',
] as const;

export type TypographySurface = (typeof TYPOGRAPHY_SURFACES)[number];

/**
 * The two surfaces another surface may follow.
 *
 * They are the two typographic jobs the app actually has: `interface` is the
 * proportional reading face, `terminal` is the fixed-width working face. Every
 * other surface is one or the other, so pointing it at a root means the user
 * picks a face once and it propagates - rather than setting the same monospace
 * font in three places and keeping them in sync by hand.
 */
export const TYPOGRAPHY_ROOTS = ['interface', 'terminal'] as const;
export type TypographyRoot = (typeof TYPOGRAPHY_ROOTS)[number];

/**
 * Sentinel stored in a surface's font setting to mean "follow the terminal".
 *
 * Deliberately NOT a bare empty string, which already means "follow the
 * interface" and must keep meaning that - every existing install stores `''`
 * on surfaces it has never customized, so re-pointing that value would silently
 * move them all onto the terminal font. Prefixed with `@` because a CSS
 * font-family can never begin with one, so this cannot collide with a real
 * font name a user types into the custom-font box.
 */
export const INHERIT_TERMINAL = '@terminal';

/** Stored value meaning "follow the interface font". The historical default. */
export const INHERIT_INTERFACE = '';

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
	 * Which surfaces this one may inherit from, in the order the picker offers
	 * them. Empty for `interface`, the root of everything.
	 *
	 * Exactly two levels by construction: `interface` inherits from nothing,
	 * `terminal` may only inherit `interface`, and every other surface may
	 * inherit either root. A cycle is therefore impossible without a graph walk
	 * to detect one - the type simply cannot express a third level.
	 */
	inheritsFrom: readonly TypographyRoot[];
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
		inheritsFrom: [],
		aliases: ['ui', 'app'],
		description: 'The whole app, and the proportional face other surfaces can follow.',
	},
	chat: {
		id: 'chat',
		label: 'AI Chat',
		fontKey: 'chatFontFamily',
		sizeKey: 'chatFontSize',
		fontVar: '--maestro-font-chat',
		sizeVar: '--maestro-size-chat',
		inheritsFrom: ['interface', 'terminal'],
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
		// Only the interface. Terminal is itself a root, so letting it follow
		// another surface is what would open the door to a cycle.
		inheritsFrom: ['interface'],
		aliases: ['shell', 'command'],
		description:
			'The command terminal, and the fixed-width face other surfaces can follow. A Nerd Font here gets shell prompt glyphs.',
	},
	filePreview: {
		id: 'filePreview',
		label: 'File Preview',
		fontKey: 'filePreviewFontFamily',
		sizeKey: 'filePreviewFontSize',
		fontVar: '--maestro-font-file-preview',
		sizeVar: '--maestro-size-file-preview',
		inheritsFrom: ['interface', 'terminal'],
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
		inheritsFrom: ['interface', 'terminal'],
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

/** Whether a surface may follow another - false only for `interface`. */
export function canInherit(spec: TypographySurfaceSpec): boolean {
	return spec.inheritsFrom.length > 0;
}

/** Whether a stored font value is the "follow the terminal" sentinel. */
export function isTerminalInherit(value: string | undefined | null): boolean {
	return (value ?? '').trim() === INHERIT_TERMINAL;
}

/** Whether a stored font value means "follow the interface" (the empty default). */
export function isInterfaceInherit(value: string | undefined | null): boolean {
	return (value ?? '').trim() === '';
}

/**
 * Which root a surface is currently following, or null when it carries a font
 * of its own. Drives the picker's selected option and the CLI's readout.
 */
export function resolveInheritRoot(value: string | undefined | null): TypographyRoot | null {
	if (isTerminalInherit(value)) return 'terminal';
	if (isInterfaceInherit(value)) return 'interface';
	return null;
}

/**
 * The raw font value a surface should use, following at most one hop of
 * inheritance.
 *
 * Returns the STORED value, not a CSS stack - `resolveSurfaceFont` in
 * fontStack.ts still owns appending the fallback chain. Split that way because
 * the CLI and the Settings picker want to know which font was chosen, while
 * only the renderer needs it turned into something CSS can use.
 *
 * One hop is all that is needed and all that is allowed: `terminal` may only
 * follow `interface`, so a surface pointing at the terminal resolves in two
 * steps at most and can never revisit a surface it has already passed through.
 */
export function resolveInheritedFont(
	surfaceFont: string | undefined | null,
	roots: { interface: string | undefined | null; terminal: string | undefined | null }
): string {
	const value = (surfaceFont ?? '').trim();
	if (value && !isTerminalInherit(value)) return value;

	if (isTerminalInherit(value)) {
		const terminal = (roots.terminal ?? '').trim();
		// The terminal may itself be following the interface, which is the second
		// and final hop. Falling through to the interface here rather than
		// returning empty is what stops a surface from losing its font entirely
		// when the terminal has not been customized.
		if (terminal && !isTerminalInherit(terminal)) return terminal;
	}

	return (roots.interface ?? '').trim();
}

/** The stored value that points a surface at a given root. */
export function inheritValueForRoot(root: TypographyRoot): string {
	return root === 'terminal' ? INHERIT_TERMINAL : INHERIT_INTERFACE;
}

/**
 * The "follow another surface" entries a surface's picker should offer, in
 * order. Built here rather than in the component so the Settings picker and
 * the CLI cannot disagree about which roots a surface may follow.
 */
export function inheritOptionsForSurface(
	spec: TypographySurfaceSpec
): Array<{ value: string; label: string; root: TypographyRoot }> {
	return spec.inheritsFrom.map((root) => ({
		value: inheritValueForRoot(root),
		label: `Same as ${TYPOGRAPHY_SURFACE_SPECS[root].label.toLowerCase()} font`,
		root,
	}));
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
