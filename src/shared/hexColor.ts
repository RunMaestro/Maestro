/**
 * Hex color detection for markdown inline code rendering.
 * Used by desktop and mobile markdown renderers to show color swatches.
 */

/**
 * Matches standalone CSS hex color codes: #RRGGBB, #RRGGBBAA.
 * Short 3/4-digit forms are intentionally excluded — they collide with
 * issue/PR references like `#197` that show up constantly in chat.
 */
const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Extract a hex color from React children if the entire content is a hex color code.
 * Returns the color string (e.g. "#8B3FFC") or null.
 */
export function extractHexColor(children: unknown): string | null {
	const text = String(children).trim();
	return HEX_COLOR_REGEX.test(text) ? text : null;
}
