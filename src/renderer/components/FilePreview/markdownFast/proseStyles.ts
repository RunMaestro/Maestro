import type { Theme } from '../../../constants/themes';

/** CSS class name applied to each rendered block by the component. */
export const FAST_BLOCK_CLASS = 'markdown-fast-block';

/**
 * Generate the scoped prose stylesheet for the Fast tier.
 *
 * Returns a CSS string keyed to `FAST_BLOCK_CLASS` so it never conflicts with
 * the Rich path's `.file-preview-content.prose` rules (they coexist when the
 * user flips between tiers via the override chip in Phase 2).
 *
 * Visual parity with the Rich path is intentional - the only difference users
 * should notice between tiers is responsiveness, not styling.
 *
 * Kept as a function (not a static template) so we can re-evaluate when the
 * theme changes; the React shell drops the returned string into a `<style>`
 * tag inside the scrolling container.
 */
export function generateProseCss(theme: Theme): string {
	const c = theme.colors;
	return `
		.${FAST_BLOCK_CLASS} { color: ${c.textMain}; }
		.${FAST_BLOCK_CLASS} h1 { color: ${c.accent}; font-size: 2em; font-weight: bold; margin: 0.67em 0; }
		.${FAST_BLOCK_CLASS} h2 { color: ${c.success}; font-size: 1.5em; font-weight: bold; margin: 0.75em 0; }
		.${FAST_BLOCK_CLASS} h3 { color: ${c.warning}; font-size: 1.17em; font-weight: bold; margin: 0.83em 0; }
		.${FAST_BLOCK_CLASS} h4 { color: ${c.textMain}; font-size: 1em; font-weight: bold; margin: 1em 0; opacity: 0.9; }
		.${FAST_BLOCK_CLASS} h5 { color: ${c.textMain}; font-size: 0.83em; font-weight: bold; margin: 1.17em 0; opacity: 0.8; }
		.${FAST_BLOCK_CLASS} h6 { color: ${c.textDim}; font-size: 0.67em; font-weight: bold; margin: 1.33em 0; }
		.${FAST_BLOCK_CLASS} p { color: ${c.textMain}; margin: 0.5em 0; }
		.${FAST_BLOCK_CLASS} ul, .${FAST_BLOCK_CLASS} ol { color: ${c.textMain}; margin: 0.5em 0; padding-left: 1.5em; }
		.${FAST_BLOCK_CLASS} li { margin: 0.25em 0; }
		.${FAST_BLOCK_CLASS} li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.5em; }
		.${FAST_BLOCK_CLASS} code { background-color: ${c.bgActivity}; color: ${c.textMain}; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
		.${FAST_BLOCK_CLASS} pre { background-color: ${c.bgActivity}; color: ${c.textMain}; padding: 1em; border-radius: 6px; overflow-x: auto; }
		.${FAST_BLOCK_CLASS} pre code { background: none; padding: 0; }
		.${FAST_BLOCK_CLASS} blockquote { border-left: 4px solid ${c.border}; padding-left: 1em; margin: 0.5em 0; color: ${c.textDim}; }
		.${FAST_BLOCK_CLASS} a { color: ${c.accent}; text-decoration: underline; }
		.${FAST_BLOCK_CLASS} hr { border: none; border-top: 2px solid ${c.border}; margin: 1em 0; }
		.${FAST_BLOCK_CLASS} table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
		.${FAST_BLOCK_CLASS} th, .${FAST_BLOCK_CLASS} td { border: 1px solid ${c.border}; padding: 0.5em; text-align: left; }
		.${FAST_BLOCK_CLASS} th { background-color: ${c.bgActivity}; font-weight: bold; }
		.${FAST_BLOCK_CLASS} strong { font-weight: bold; }
		.${FAST_BLOCK_CLASS} em { font-style: italic; }
		.${FAST_BLOCK_CLASS} img { display: block; max-width: 100%; height: auto; }
	`;
}
