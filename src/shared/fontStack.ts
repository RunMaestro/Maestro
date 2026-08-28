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
