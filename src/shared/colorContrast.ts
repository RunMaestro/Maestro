/**
 * Color math for keeping foreground/background pairs legible.
 *
 * Themeable surfaces (diagram fills, charts, badges) are frequently derived
 * from a theme's accent or background, which means a theme whose accent sits
 * close to its text color can end up painting near-identical colors on top of
 * each other. `readableTextOn` is the guard: give it the color you want and
 * every background it may be drawn on, and it returns a color that clears
 * WCAG AA - nudging the theme's own color rather than snapping to black/white.
 *
 * Keep this file dependency-free so it can be imported from the main process,
 * the renderer, and the web builds.
 */

/** WCAG 2.1 minimum contrast ratio for normal-size text. */
export const AA_CONTRAST = 4.5;

/** WCAG 2.1 minimum contrast ratio for large (>=18pt / >=14pt bold) text. */
export const AA_LARGE_CONTRAST = 3;

/**
 * Convert a `#rrggbb` color to RGB components. Returns null for any other form
 * (named colors, `rgb()`, `hsl()`, 3-digit shorthand) - callers treat an
 * unparseable color as "leave it alone".
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
	const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	return result
		? {
				r: parseInt(result[1], 16),
				g: parseInt(result[2], 16),
				b: parseInt(result[3], 16),
			}
		: null;
}

function toHex(value: number): string {
	return value.toString(16).padStart(2, '0');
}

/**
 * Shift a color toward white (positive percent) or black (negative percent).
 * The shift is a flat offset on each channel, so hue is broadly preserved.
 */
export function adjustBrightness(hex: string, percent: number): string {
	const rgb = hexToRgb(hex);
	if (!rgb) return hex;

	const adjust = (value: number) =>
		Math.min(255, Math.max(0, Math.round(value + (255 * percent) / 100)));
	return `#${toHex(adjust(rgb.r))}${toHex(adjust(rgb.g))}${toHex(adjust(rgb.b))}`;
}

/**
 * Mix two colors. `ratio` is how much of `color2` ends up in the result
 * (0 = all `color1`, 1 = all `color2`).
 */
export function blendColors(color1: string, color2: string, ratio: number): string {
	const rgb1 = hexToRgb(color1);
	const rgb2 = hexToRgb(color2);
	if (!rgb1 || !rgb2) return color1;

	const mix = (a: number, b: number) => Math.round(a * (1 - ratio) + b * ratio);
	return `#${toHex(mix(rgb1.r, rgb2.r))}${toHex(mix(rgb1.g, rgb2.g))}${toHex(mix(rgb1.b, rgb2.b))}`;
}

/**
 * Flatten `color` at `alpha` opacity over `bgColor` into an opaque color.
 * Useful where a renderer only accepts solid fills (SVG diagram output, canvas
 * charts) but the design calls for a tint.
 */
export function transparentize(color: string, bgColor: string, alpha: number): string {
	return blendColors(bgColor, color, alpha);
}

/**
 * WCAG relative luminance of an sRGB color (0 = black, 1 = white).
 * Returns null when the color can't be parsed.
 */
export function relativeLuminance(hex: string): number | null {
	const rgb = hexToRgb(hex);
	if (!rgb) return null;

	const channel = (value: number) => {
		const c = value / 255;
		return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/**
 * WCAG 2.1 contrast ratio between two colors (1 = identical, 21 = black on
 * white). Returns 21 when either color can't be parsed: we only downgrade a
 * color we can actually measure, so an exotic custom-theme value is left alone.
 */
export function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	if (la === null || lb === null) return 21;

	const lighter = Math.max(la, lb);
	const darker = Math.min(la, lb);
	return (lighter + 0.05) / (darker + 0.05);
}

/** True when `foreground` clears `threshold` against every background given. */
export function isReadableOn(
	foreground: string,
	backgrounds: string[],
	threshold = AA_CONTRAST
): boolean {
	return backgrounds.every((bg) => contrastRatio(foreground, bg) >= threshold);
}

/**
 * Pick a foreground that stays legible on every background it will be painted on.
 *
 * When `preferred` already clears `threshold` against all `backgrounds` it is
 * returned untouched, so themed surfaces keep their intended color. Otherwise it
 * is nudged toward white or black - whichever direction gains contrast - in small
 * steps, and the first step that clears the threshold wins. The result still
 * reads as the theme's color instead of a hard-coded black/white pasted in from
 * another palette.
 *
 * When the backgrounds span both extremes (a near-white fill and a near-black
 * fill sharing one label color), no single color can clear the threshold; the
 * best available endpoint is returned.
 */
export function readableTextOn(
	preferred: string,
	backgrounds: string[],
	threshold = AA_CONTRAST
): string {
	if (backgrounds.length === 0) return preferred;

	const worstCase = (fg: string) => Math.min(...backgrounds.map((bg) => contrastRatio(fg, bg)));
	if (worstCase(preferred) >= threshold) return preferred;

	const towardWhite = worstCase('#ffffff') >= worstCase('#000000');
	for (let step = 5; step <= 100; step += 5) {
		const candidate = adjustBrightness(preferred, towardWhite ? step : -step);
		if (worstCase(candidate) >= threshold) return candidate;
	}
	return towardWhite ? '#ffffff' : '#000000';
}
