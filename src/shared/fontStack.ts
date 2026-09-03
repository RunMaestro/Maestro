/**
 * Font-stack helpers.
 *
 * The interface font is a user setting (`fontFamily`). The font picker
 * (FontConfigurationPanel) and the custom-font input both store a BARE font
 * name with no generic fallback, e.g. `Roboto Mono`. When that bare name isn't
 * installed and isn't web-loaded (the common case on iOS / the web-desktop
 * bundle, where only JetBrains Mono is fetched), the browser can't resolve the
 * family and drops to its document default - which is a proportional SERIF
 * (Times) on Safari. The result is an app that renders in serif instead of
 * monospace.
 *
 * `withMonoFallback` guarantees the applied CSS font-family always ends in a
 * safe monospace chain: the platform's system monospace (`ui-monospace` / SF
 * Mono / Menlo on Apple, Consolas on Windows, Liberation Mono on Linux) and,
 * critically, the `monospace` generic keyword every platform honors. Apply it
 * at the point where the setting becomes a CSS value, NOT at the setting source
 * - the picker's `<select>` needs the raw stored name to match its options.
 */

/**
 * Safe monospace fallback chain appended to a bare interface font. Matches the
 * chain already used by the file-preview surfaces (proseStyles.ts,
 * themeAdapter.ts) so the whole app degrades to the same faces. Ends in the
 * `monospace` generic so no platform can fall through to serif.
 */
export const MONO_FALLBACK_STACK =
	'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

/**
 * Safe proportional fallback chain, the sans counterpart to
 * {@link MONO_FALLBACK_STACK}. Leads with each platform's own UI face so the
 * proportional typography preset looks native rather than imported, and ends in
 * the `sans-serif` generic so no platform can fall through to serif.
 */
export const SANS_FALLBACK_STACK =
	'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * The MAESTRO wordmark's font. Fixed, and deliberately NOT derived from any
 * setting.
 *
 * The wordmark is a brand mark, not text: it is the one string in the app whose
 * shape is the point. Letting it inherit the interface font meant the logo
 * changed identity whenever the user changed their reading font, and the boot
 * splash and the Left Bar header could disagree about what Maestro looks like
 * depending on how far startup had progressed.
 *
 * JetBrains Mono leads because it BUNDLES with the app (see bundledFonts.ts),
 * so this resolves identically on every machine rather than depending on what
 * happens to be installed. The rest of the chain is the pre-bundle fallback,
 * kept so the mark still renders during the first paint of the boot splash,
 * before the webfont has loaded.
 *
 * Kept in sync by hand with `.splash-title` in src/renderer/index.html and
 * `.md-splash__wordmark` in src/web-desktop/index.html, which paint before any
 * JavaScript runs and so cannot import this.
 *
 * Deliberately a separate NAME from {@link MAESTRO_FONT_STACK} even though it
 * currently holds the same value: that one follows the user's `fontFamily`
 * setting as its default and may be changed, this one must never follow it. If
 * the two ever need to diverge, change this one and leave the body text alone.
 */
/**
 * The font stack Maestro itself ships with, and the default the `fontFamily`
 * SETTING carries.
 *
 * It has to be identical in the places that render at different moments during
 * startup, because any disagreement between them shows up as the app visibly
 * changing font while it boots:
 *
 *   1. the splash screen's inline CSS in `src/renderer/index.html`
 *   2. `body` in `src/renderer/index.css`
 *   3. the `font-mono` utility in `tailwind.config.mjs`
 *   4. the `fontFamily` setting default, in BOTH `src/main/stores/defaults.ts`
 *      and `src/renderer/stores/settingsStore.ts`
 *
 * The splash paints before React mounts and the setting arrives from disk after
 * it, so a default naming a different family than the splash repaints the whole
 * window the instant React takes over. That is exactly what shipped: the splash
 * asked for JetBrains Mono while the setting default asked for Roboto Mono, so
 * a cold start went Courier New -> JetBrains Mono -> Menlo.
 *
 * JetBrains Mono leads because it is bundled (see bundledFonts.ts), so it is
 * the one family here guaranteed to resolve; the rest are fallbacks for a
 * renderer that somehow fails to load it.
 */
export const MAESTRO_FONT_STACK = "'JetBrains Mono', 'Fira Code', 'Courier New', monospace";

export const WORDMARK_FONT_STACK = MAESTRO_FONT_STACK;

/**
 * Ensure a CSS font-family value degrades to monospace rather than the browser's
 * serif default. Returns the value unchanged when it already contains a generic
 * family keyword (`monospace` / `sans-serif` / `serif`), so the built-in default
 * (which already carries a fallback chain) and any user value that already ends
 * in a generic are left alone; otherwise appends {@link MONO_FALLBACK_STACK}.
 */
export function withMonoFallback(fontFamily: string | undefined | null): string {
	const value = (fontFamily ?? '').trim();
	if (!value) return MONO_FALLBACK_STACK;
	// Already carries a generic family keyword -> it has a real fallback, leave it.
	if (/\b(monospace|sans-serif|serif)\b/i.test(value)) return value;
	return `${value}, ${MONO_FALLBACK_STACK}`;
}

/**
 * Resolve a per-surface font setting against the interface font.
 *
 * Every surface font (terminal, AI chat, file preview, file editor) stores the
 * empty string to mean "inherit the interface font", so the surface keeps
 * following the UI when the user never touches it. Resolving that chain in one
 * place keeps the pickers, the rendered surfaces, and any future surface from
 * disagreeing about what an empty value means: a surface that re-derives it and
 * forgets the `.trim()` renders a whitespace-only family, which resolves to
 * nothing and drops the pane to the browser default.
 */
export function resolveSurfaceFont(
	surfaceFont: string | undefined | null,
	interfaceFont: string | undefined | null
): string {
	return withMonoFallback((surfaceFont ?? '').trim() || interfaceFont);
}

/**
 * The human-readable name of a font stack: its first family, unquoted.
 *
 * Stored font values are not all bare names. The typography presets write full
 * CSS stacks (`Inter, -apple-system, BlinkMacSystemFont, ...`), which is right
 * for the stored value - the fallback chain is what makes the preset resolve on
 * a machine with nothing installed - but wrong for a label. The picker matches
 * its option list by exact string, so a stack matches nothing, gets surfaced as
 * the "Current" option, and the whole comma-separated chain is what the user
 * reads as the name of their font.
 *
 * DISPLAY ONLY. Never write the result back to a setting: the tail of the stack
 * is the fallback, and dropping it is how a font that is merely missing turns
 * into a serif document default.
 */
export function displayFontLabel(fontFamily: string | undefined | null): string {
	const first = (fontFamily ?? '').split(',')[0]?.trim() ?? '';
	// Strip a matching pair of surrounding quotes; a family whose name contains
	// a quote is not a thing, so an unbalanced one is left alone rather than
	// half-trimmed into something that reads as a typo.
	const unquoted = first.replace(/^(['"])(.*)\1$/, '$2').trim();
	return unquoted || first;
}

/**
 * Sample copy every font preview draws.
 *
 * One pair of strings rather than a per-surface literal: the typography chooser
 * and the Settings pickers both show "what does this face look like", and two
 * different samples would make the same font read as two different choices
 * depending on which screen the user happened to be on. The prose line is a
 * pangram so every letterform is exercised; the code line carries the
 * punctuation and digits a fixed-width face is actually judged on.
 */
export const FONT_PREVIEW_PROSE = 'The quick brown fox jumps over the lazy dog.';
export const FONT_PREVIEW_CODE = 'const tempo = 120; // adagio -> allegro';
