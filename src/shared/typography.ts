/**
 * Typography surfaces - the single registry of "what can carry its own font".
 *
 * Every consumer reads this rather than re-listing the six surfaces: the
 * Settings pickers, the CSS custom properties the renderer publishes, the
 * presets, the CLI verbs, and the web client. Adding another surface means
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
	'documentGraph',
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
	documentGraph: {
		id: 'documentGraph',
		label: 'Document Graph',
		fontKey: 'documentGraphFontFamily',
		sizeKey: 'documentGraphFontSize',
		fontVar: '--maestro-font-document-graph',
		sizeVar: '--maestro-size-document-graph',
		inheritsFrom: ['interface', 'terminal'],
		aliases: ['graph', 'mindmap', 'docgraph'],
		description: 'Node titles and previews in the document graph.',
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

// ============================================================================
// Heading typography (H1-H6)
// ============================================================================
//
// Per-level overrides for rendered markdown headings, the way a word processor
// lets you restyle "Heading 1" once and have every H1 follow. Kept apart from
// the surface registry above because the semantics differ: a surface ALWAYS
// renders at a resolved size, while a heading with no override must keep the
// relative size its own stylesheet gives it (2em in a chat bubble, 1.75em in a
// streaming preview), so "unset" here means "publish nothing", not "inherit".
//
// One settings key, `headingTypography`, holds a sparse map:
//   { h1: { fontFamily: 'Georgia', fontSize: 28 }, h3: { fontSize: 18 } }
// An empty `fontFamily` keeps the surrounding text's font; a `fontSize` of 0
// keeps the stylesheet's relative size. Sizes are px before zoom, like every
// other size in this file.

export const HEADING_LEVELS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
export type HeadingLevel = (typeof HEADING_LEVELS)[number];

export interface HeadingStyle {
	/** CSS font-family. Empty means "same as the surrounding text". */
	fontFamily: string;
	/** Size in px before zoom. 0 means "the stylesheet's default size". */
	fontSize: number;
}

export type HeadingTypography = Partial<Record<HeadingLevel, HeadingStyle>>;

/** Settings key holding the whole map. */
export const HEADING_TYPOGRAPHY_KEY = 'headingTypography';

/** Headings can run larger than body text, so their ceiling sits above the surfaces'. */
export const HEADING_FONT_SIZE_MIN = SURFACE_FONT_SIZE_MIN;
export const HEADING_FONT_SIZE_MAX = 72;

/**
 * The AI chat's heading scale (`generateTerminalProseStyles` paints with it),
 * used to show what an un-overridden level renders at in a chat reply. Other
 * prose stylesheets keep their own scale; this is the number the Settings
 * sample and size control start from, so it must match what the chat draws or
 * a first "increase" could write a size smaller than the heading already is.
 */
export const HEADING_DEFAULT_SCALE: Record<HeadingLevel, number> = {
	h1: 2,
	h2: 1.75,
	h3: 1.5,
	h4: 1.35,
	h5: 1.2,
	h6: 1.1,
};

/** CSS custom property carrying a level's resolved family, when overridden. */
export function headingFontVar(level: HeadingLevel): string {
	return `--maestro-heading-${level}-font`;
}

/** CSS custom property carrying a level's resolved size in px, when overridden. */
export function headingSizeVar(level: HeadingLevel): string {
	return `--maestro-heading-${level}-size`;
}

/**
 * The reading pane's own zoom multiplier (File Preview, Auto Run preview).
 * Unset everywhere else, which reads as 1.
 */
export const PANE_FONT_SCALE_VAR = '--fp-font-scale';

/** Per-element helper property: the override size times the pane zoom. */
function headingScaledSizeVar(level: HeadingLevel): string {
	return `--maestro-heading-${level}-scaled-size`;
}

/**
 * The font declarations a prose stylesheet writes for one heading level.
 *
 * The size falls back to the stylesheet's own value, so nothing changes until
 * the user overrides it. An override is an absolute px length, so it is
 * multiplied by the pane zoom here, on the heading itself (a `var()` inside a
 * custom property set on `:root` would resolve there, where the pane zoom is
 * absent). When no override is published, the helper property references an
 * unset variable and becomes invalid, so `font-size` takes the em fallback,
 * which already follows the pane zoom through the parent's size.
 *
 * The family has NO fallback on purpose: an unset variable makes the
 * declaration invalid at computed-value time, and for an inherited property
 * like font-family that resolves to the parent's value - exactly what a
 * heading did before this declaration existed.
 */
export function headingFontCss(level: HeadingLevel, defaultSize: string): string {
	const scaled = headingScaledSizeVar(level);
	return `${scaled}: calc(var(${headingSizeVar(level)}) * var(${PANE_FONT_SCALE_VAR}, 1)); font-size: var(${scaled}, ${defaultSize}); font-family: var(${headingFontVar(level)});`;
}

/** Clamp a stored heading size. `0` passes through, meaning "default". */
export function clampHeadingFontSize(size: number): number {
	if (!Number.isFinite(size) || size <= 0) return 0;
	return Math.min(HEADING_FONT_SIZE_MAX, Math.max(HEADING_FONT_SIZE_MIN, Math.round(size)));
}

/** Whether a string names a heading level (`h1`, `H2`, `heading3`, `3`). */
export function resolveHeadingLevel(name: string): HeadingLevel | null {
	const match = /^(?:h|heading)?\s*([1-6])$/i.exec(name.trim());
	return match ? (`h${match[1]}` as HeadingLevel) : null;
}

/**
 * Narrow a persisted value into a clean map. The value can come from an older
 * build, a hand-edited settings file, or `maestro-cli settings set`, so every
 * field is checked; levels that end up with nothing overridden are dropped so
 * "is anything customized" is just "is the map empty".
 */
export function parseHeadingTypography(raw: unknown): HeadingTypography {
	const result: HeadingTypography = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
	for (const level of HEADING_LEVELS) {
		const entry = (raw as Record<string, unknown>)[level];
		if (!entry || typeof entry !== 'object') continue;
		const rawFont = (entry as Record<string, unknown>).fontFamily;
		const fontFamily = typeof rawFont === 'string' ? rawFont.trim() : '';
		// Only numbers and numeric strings convert: `Number()` on an arbitrary
		// object can throw (a `toString` that is not callable) and abort the
		// whole parse.
		const rawSize = (entry as Record<string, unknown>).fontSize;
		const fontSize = clampHeadingFontSize(
			typeof rawSize === 'number' || typeof rawSize === 'string' ? Number(rawSize) : 0
		);
		if (fontFamily || fontSize) result[level] = { fontFamily, fontSize };
	}
	return result;
}

/** A copy of `current` with one level's style patched, empty levels dropped. */
export function withHeadingStyle(
	current: HeadingTypography,
	level: HeadingLevel,
	patch: Partial<HeadingStyle>
): HeadingTypography {
	const prev = current[level] ?? { fontFamily: '', fontSize: 0 };
	return parseHeadingTypography({ ...current, [level]: { ...prev, ...patch } });
}

/**
 * The size a level renders at when the user has not overridden it, against a
 * given base size, for display only. Rounded to a whole pixel.
 */
export function defaultHeadingSize(level: HeadingLevel, baseSize: number): number {
	const base = baseSize > 0 ? baseSize : BASE_FONT_SIZE_DEFAULT;
	return Math.round(base * HEADING_DEFAULT_SCALE[level]);
}
