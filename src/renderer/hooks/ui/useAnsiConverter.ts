/**
 * useAnsiConverter - one theme-aware ANSI -> HTML converter for every surface
 * that shows raw terminal output.
 *
 * The 16 ANSI slots are mapped onto the ACTIVE theme rather than the standard
 * xterm palette, so a red in `git push` output is the same red the transcript,
 * the terminal pane and the shell-command card use. Themes that do not declare
 * an `ansi*` color fall back to their semantic equivalent (error / success /
 * warning / accent), which is why a theme can ship without touching this table.
 *
 * Pair it with `getCachedAnsiHtml()` from `utils/textProcessing`, which is what
 * sanitizes the result - a converter instance alone never reaches the DOM.
 *
 * Do NOT hand-roll another `new Convert({...})`: a second palette drifts from
 * this one the first time a theme adds a color, and the two surfaces then
 * disagree about what "bright green" means.
 */

import { useMemo } from 'react';
import Convert from 'ansi-to-html';
import type { Theme } from '../../types';

/**
 * Build a converter bound to a theme's palette.
 *
 * Exported for non-React callers (and tests). Inside a component use the hook,
 * which memoizes per theme - `getCachedAnsiHtml` keys its cache on the theme id,
 * so a fresh instance per render would still be correct but would re-convert
 * nothing and cost an allocation on every frame of a streaming command.
 */
export function createAnsiConverter(theme: Theme): Convert {
	const c = theme.colors;
	return new Convert({
		fg: c.textMain,
		bg: c.bgMain,
		newline: false,
		escapeXML: true,
		stream: false,
		colors: {
			0: c.ansiBlack ?? c.textMain,
			1: c.ansiRed ?? c.error,
			2: c.ansiGreen ?? c.success,
			3: c.ansiYellow ?? c.warning,
			4: c.ansiBlue ?? c.accent,
			5: c.ansiMagenta ?? c.accentDim,
			6: c.ansiCyan ?? c.accent,
			7: c.ansiWhite ?? c.textDim,
			8: c.ansiBrightBlack ?? c.textDim,
			9: c.ansiBrightRed ?? c.error,
			10: c.ansiBrightGreen ?? c.success,
			11: c.ansiBrightYellow ?? c.warning,
			12: c.ansiBrightBlue ?? c.accent,
			13: c.ansiBrightMagenta ?? c.accentText,
			14: c.ansiBrightCyan ?? c.accentText,
			15: c.ansiBrightWhite ?? c.textMain,
		},
	});
}

/** Memoized `createAnsiConverter`, rebuilt only when the theme changes. */
export function useAnsiConverter(theme: Theme): Convert {
	return useMemo(() => createAnsiConverter(theme), [theme]);
}
