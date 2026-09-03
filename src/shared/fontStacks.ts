/**
 * The one font stack Maestro ships with.
 *
 * Shared rather than restated because it has to be identical in four places
 * that render at different moments during startup, and any disagreement between
 * them shows up as the app visibly changing font while it boots:
 *
 *   1. the splash screen's inline CSS in `src/renderer/index.html`
 *   2. `body` in `src/renderer/index.css`
 *   3. the `font-mono` utility in `tailwind.config.mjs`
 *   4. the `fontFamily` SETTING default, in both `src/main/stores/defaults.ts`
 *      and `src/renderer/stores/settingsStore.ts`
 *
 * The splash paints before React mounts and the setting arrives from disk after
 * it, so a default that names a different family than the splash repaints the
 * whole window the instant React takes over. That is exactly what shipped: the
 * splash asked for JetBrains Mono while the setting default asked for Roboto
 * Mono, and neither was bundled, so a cold start went Courier New -> JetBrains
 * Mono -> Menlo.
 *
 * JetBrains Mono leads because it is the only family here that is actually
 * bundled (`src/renderer/public/fonts/`), so it is the only one guaranteed to
 * resolve. The rest are fallbacks for a renderer that somehow fails to load it.
 */
export const MAESTRO_FONT_STACK = "'JetBrains Mono', 'Fira Code', 'Courier New', monospace";

/**
 * The stack the MAESTRO wordmark and the splash title are drawn in.
 *
 * Same value as `MAESTRO_FONT_STACK`, deliberately named apart because it is
 * NOT the same thing: this one must never follow the user's `fontFamily`
 * setting. The wordmark is a logo. Before this existed it carried no family of
 * its own, inherited the root element's inline `fontFamily`, and so a user
 * picking a terminal font in Settings silently redrew the brand.
 *
 * Anything that renders the wordmark sets this explicitly. If the two constants
 * ever need to diverge, change this one and leave the body text alone.
 */
export const MAESTRO_WORDMARK_FONT_STACK = MAESTRO_FONT_STACK;
