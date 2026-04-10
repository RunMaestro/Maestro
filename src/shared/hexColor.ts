/**
 * Hex color detection for markdown inline code rendering.
 * Used by desktop and mobile markdown renderers to show color swatches.
 */

/** Matches standalone CSS hex color codes: #RGB, #RGBA, #RRGGBB, #RRGGBBAA */
const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Extract a hex color from React children if the entire content is a hex color code.
 * Returns the color string (e.g. "#8B3FFC") or null.
 */
export function extractHexColor(children: unknown): string | null {
	const text = String(children).trim();
	return HEX_COLOR_REGEX.test(text) ? text : null;
}
