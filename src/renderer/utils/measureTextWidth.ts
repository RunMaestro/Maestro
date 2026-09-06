/**
 * Measure how wide a string renders in a given font.
 *
 * For layout thresholds that were calibrated as pixel literals against a
 * specific font and now have to survive a different one. Maestro's interface
 * font is a user setting, so any constant of the form "at 256px the OFFLINE
 * label fits" is only true for the face it was measured against - a
 * proportional face at a larger root needs more room for the same string, and
 * the label collides with whatever sits beside it.
 *
 * Canvas rather than a DOM probe on purpose: `measureText` reads font metrics
 * without inserting anything, so it triggers no layout and cannot feed back
 * into the sizes it is being used to decide. A hidden mirror element would
 * change the document it is measuring.
 */

/**
 * Results are cached by font + spacing + text. The call sites here measure a
 * handful of fixed strings ("MAESTRO", "OFFLINE") whenever the font settings
 * change, so the cache is small and effectively permanent - but it is bounded
 * anyway, since a caller could reasonably start measuring filenames.
 */
const CACHE_LIMIT = 512;
const cache = new Map<string, number>();

let context: CanvasRenderingContext2D | null | undefined;

function getContext(): CanvasRenderingContext2D | null {
	// Resolved once. `undefined` means "not tried yet", `null` means "tried and
	// unavailable", so a headless environment costs one failed attempt rather
	// than one per call.
	if (context === undefined) {
		try {
			context = document.createElement('canvas').getContext('2d');
		} catch {
			context = null;
		}
	}
	return context;
}

/**
 * Width in CSS pixels of `text` rendered in `font`, plus any letter-spacing.
 *
 * @param font CSS shorthand, e.g. `bold 18px Inter, sans-serif`.
 * @param letterSpacingPx Added per character, since `measureText` ignores
 *   letter-spacing on every engine Maestro ships to. The trailing character's
 *   spacing is included, matching how the browser lays out a run.
 * @returns 0 when no canvas is available, which makes callers fall back to
 *   their uncorrected constants rather than collapsing a layout to zero.
 */
export function measureTextWidth(text: string, font: string, letterSpacingPx = 0): number {
	if (!text) return 0;

	const key = `${font}|${letterSpacingPx}|${text}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached;

	const ctx = getContext();
	if (!ctx) return 0;

	ctx.font = font;
	const width = ctx.measureText(text).width + letterSpacingPx * text.length;

	// Cheapest useful eviction: drop the oldest insertion. These are pure
	// measurements, so a wrong eviction costs one re-measure, never correctness.
	if (cache.size >= CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, width);
	return width;
}

/** Drop every cached measurement. For tests, and for a font-file swap at runtime. */
export function clearTextMeasurementCache(): void {
	cache.clear();
	context = undefined;
}
