/**
 * Fixed-pitch font resolution, shared by every surface that renders shell text.
 *
 * Maestro has a single `fontFamily` setting shared with the app chrome, so a
 * user who picks a proportional UI font would otherwise get proportional
 * terminals, command-mode composers and shell-output cards. Shell text is a
 * grid: columns line up, box drawing joins, and a `ls -l` reads as a table only
 * while every glyph is one cell wide. That is not a preference those surfaces
 * can honor, so the font is measured and overridden here.
 *
 * Lives outside XTerminal.tsx so the chat-side surfaces (command mode composer,
 * ShellCommandCard) can reuse it without pulling in xterm.
 *
 * The FALLBACK half of the job is deliberately not implemented here: it belongs
 * to the shared `withMonoFallback` / `MONO_FALLBACK_STACK` in
 * `src/shared/fontStack.ts`, which every surface degrades through. A chain kept
 * locally drifts the first time one of them gains a platform, and this module
 * shipped exactly that duplicate (`ensureMonospaceFallback`,
 * `FIXED_PITCH_FALLBACK_STACK`) before it was folded back in. What IS local is
 * the MEASUREMENT below, which covers the different failure the shared chain
 * cannot: a font that resolves perfectly well and simply is not fixed-pitch.
 */

import { MONO_FALLBACK_STACK, withMonoFallback } from '../../shared/fontStack';

/** Measures the advance width of one character in a given CSS font shorthand. */
export type MeasureAdvance = (cssFont: string, char: string) => number;

/**
 * Whether a font stack resolves to a fixed-pitch face, by measurement.
 *
 * Asking the font system "are you monospace?" is not possible from CSS, so this
 * measures instead: in a fixed-pitch face every glyph shares one advance, so
 * the widest (`W`) and one of the narrowest (`i`) come out equal. In Avenir
 * Next - the font this was found with - they are 1025 and 296, a 3.5x spread.
 *
 * A tolerance is used rather than strict equality because subpixel metrics and
 * hinting can leave a fractional difference in a genuinely monospace face.
 *
 * Unmeasurable input (no canvas, a zero width) returns true: without evidence
 * we do not second-guess the user's font.
 */
export function isFixedPitchStack(
	fontFamily: string,
	fontSize: number,
	measureAdvance: MeasureAdvance
): boolean {
	const cssFont = `${fontSize}px ${fontFamily}`;
	let wide: number;
	let narrow: number;
	try {
		wide = measureAdvance(cssFont, 'W');
		narrow = measureAdvance(cssFont, 'i');
	} catch {
		return true;
	}
	if (!Number.isFinite(wide) || !Number.isFinite(narrow) || wide <= 0 || narrow <= 0) return true;
	return Math.abs(wide - narrow) <= wide * 0.02;
}

/**
 * Pick the font the terminal should actually render with.
 *
 * A terminal in a proportional font is not merely ugly, it is wrong: xterm
 * sizes its grid from the advance of `W` and then puts every character on that
 * fixed pitch, so narrow letters trail a large gap (`Cl aude`, `Mi crosoft`)
 * while wide ones sit flush. The whole grid - box drawing, TUI alignment,
 * cursor position - is built on the assumption that one glyph is one cell.
 *
 * The terminal font INHERITS the interface font whenever the user has not set
 * one of its own (see `resolveSurfaceFont`), so picking a proportional UI font
 * silently breaks every terminal. That is not a preference the terminal can
 * honor, so it is overridden here rather than rendering a broken grid.
 *
 * The fallback chain comes from the shared `withMonoFallback`, which every
 * other surface degrades through - it only covers a font that fails to
 * RESOLVE, and cannot help when the configured font resolves perfectly well
 * and simply is not fixed-pitch. That is what the measurement above is for;
 * the two mechanisms cover different failures and compose.
 */
export function resolveTerminalFontFamily(
	fontFamily: string,
	fontSize: number,
	measureAdvance: MeasureAdvance | null
): string {
	const stack = withMonoFallback(fontFamily);
	// No way to measure (jsdom, no canvas): keep the configured stack rather
	// than overriding a font that may well be fine.
	if (!measureAdvance) return stack;
	if (isFixedPitchStack(stack, fontSize, measureAdvance)) return stack;
	return MONO_FALLBACK_STACK;
}

/** Canvas-backed {@link MeasureAdvance}, or null where canvas is unavailable. */
export function createCanvasMeasureAdvance(): MeasureAdvance | null {
	try {
		const ctx = document.createElement('canvas').getContext('2d');
		if (!ctx) return null;
		return (cssFont, char) => {
			ctx.font = cssFont;
			return ctx.measureText(char).width;
		};
	} catch {
		return null;
	}
}

/**
 * Process-wide measurer, created on first use.
 *
 * The measurement is a ratio between two glyph advances, so it is independent
 * of the size it is taken at and one canvas serves every caller.
 */
let sharedMeasureAdvance: MeasureAdvance | null | undefined;

/**
 * {@link resolveTerminalFontFamily} for callers that have no canvas of their
 * own - the DOM surfaces that render shell text (command-mode composer, shell
 * command cards). Same rule, same fallback, one shared measurer.
 *
 * `fontSize` only sets the scale the two glyphs are measured at, so the default
 * is fine unless a caller already knows its own.
 */
export function resolveFixedPitchFontFamily(fontFamily: string, fontSize = 14): string {
	if (sharedMeasureAdvance === undefined) sharedMeasureAdvance = createCanvasMeasureAdvance();
	return resolveTerminalFontFamily(fontFamily, fontSize, sharedMeasureAdvance);
}
