/**
 * Tests for the terminal's font resolution.
 *
 * A terminal in a proportional font renders a broken grid: xterm sizes its cell
 * from the advance of `W` and then puts every character on that pitch, so narrow
 * letters trail a gap (`Cl aude`, `Mi crosoft`) while wide ones sit flush.
 *
 * The advance numbers below are REAL, read out of the `hmtx` table of the font
 * files on the machine where this bug was found:
 *
 *   Avenir Next  W=1025  i=296  l=298  m=924   -> proportional (3.5x spread)
 *   Menlo        W=1233  i=1233 l=1233 m=1233  -> fixed pitch
 *
 * Avenir Next matters specifically because it was the configured `fontFamily`,
 * and it is a system font that resolves perfectly - so no amount of fallback
 * appending helps. It has to be measured and overridden.
 */

import { describe, expect, it } from 'vitest';
import {
	ensureMonospaceFallback,
	isFixedPitchStack,
	resolveTerminalFontFamily,
	FIXED_PITCH_FALLBACK_STACK,
	type MeasureAdvance,
} from '../../../renderer/components/XTerminal';

/** Advances in font units, keyed by the first family in the stack. */
const REAL_FONT_METRICS: Record<string, { unitsPerEm: number; advances: Record<string, number> }> =
	{
		'avenir next': { unitsPerEm: 1000, advances: { W: 1025, i: 296, l: 298, m: 924 } },
		menlo: { unitsPerEm: 2048, advances: { W: 1233, i: 1233, l: 1233, m: 1233 } },
	};

/**
 * A measurer backed by those real metrics. Resolves the first family in the
 * stack it knows about, mimicking how the browser walks a font stack; an
 * unknown stack falls through to a proportional system default, which is what
 * actually happens when nothing resolves.
 */
function measureWith(knownFamilies = REAL_FONT_METRICS): MeasureAdvance {
	return (cssFont, char) => {
		const stack = cssFont.replace(/^\d+px\s+/, '');
		const size = Number(cssFont.match(/^(\d+)px/)?.[1] ?? 13);
		for (const family of stack.split(',').map((f) => f.trim().replace(/["']/g, '').toLowerCase())) {
			const metrics = knownFamilies[family];
			if (metrics) {
				return (size * (metrics.advances[char] ?? metrics.advances.W)) / metrics.unitsPerEm;
			}
			// The generic always resolves, and always to a fixed-pitch face.
			if (family === 'monospace' || family === 'ui-monospace') return size * 0.6;
		}
		// Nothing resolved: the context default, which is proportional.
		return char === 'W' ? size * 0.9 : size * 0.28;
	};
}

const measure = measureWith();

describe('ensureMonospaceFallback', () => {
	it('leaves a stack that already ends in monospace untouched', () => {
		const stack = 'Roboto Mono, Menlo, "Courier New", monospace';
		expect(ensureMonospaceFallback(stack)).toBe(stack);
	});

	it('appends the generic family to a bare font name', () => {
		expect(ensureMonospaceFallback('Roboto Mono')).toBe('Roboto Mono, monospace');
	});

	it('accepts ui-monospace as a sufficient terminator', () => {
		const stack = 'SF Mono, ui-monospace';
		expect(ensureMonospaceFallback(stack)).toBe(stack);
	});

	it('recognises a generic that is quoted or oddly cased', () => {
		expect(ensureMonospaceFallback('Menlo, "monospace"')).toBe('Menlo, "monospace"');
		expect(ensureMonospaceFallback('Menlo, MONOSPACE')).toBe('Menlo, MONOSPACE');
	});

	it('normalises whitespace and empty entries', () => {
		expect(ensureMonospaceFallback('  Menlo ,, ')).toBe('Menlo, monospace');
	});

	it('falls back to the generic alone when the setting is empty', () => {
		expect(ensureMonospaceFallback('')).toBe('monospace');
	});

	// Documents WHY appending a fallback was not enough on its own: the broken
	// font resolved fine, so the appended generic was never reached.
	it('cannot rescue a proportional font that resolves', () => {
		const patched = ensureMonospaceFallback('Avenir Next');
		expect(patched).toBe('Avenir Next, monospace');
		expect(isFixedPitchStack(patched, 13, measure)).toBe(false);
	});
});

describe('isFixedPitchStack', () => {
	it('detects the real Avenir Next metrics as proportional', () => {
		expect(isFixedPitchStack('Avenir Next', 13, measure)).toBe(false);
	});

	it('detects the real Menlo metrics as fixed pitch', () => {
		expect(isFixedPitchStack('Menlo', 13, measure)).toBe(true);
	});

	it('treats an unresolvable stack as proportional, since the default is', () => {
		expect(isFixedPitchStack('No Such Font', 13, measure)).toBe(false);
	});

	// Subpixel metrics and hinting can leave a fractional difference in a face
	// that is genuinely fixed-pitch; that must not trigger an override.
	it('tolerates sub-pixel jitter in a genuinely fixed-pitch face', () => {
		const jittery: MeasureAdvance = (_f, char) => (char === 'W' ? 7.8301 : 7.8299);
		expect(isFixedPitchStack('Menlo', 13, jittery)).toBe(true);
	});

	it('does not second-guess the font when measurement is unusable', () => {
		expect(isFixedPitchStack('Menlo', 13, () => 0)).toBe(true);
		expect(isFixedPitchStack('Menlo', 13, () => Number.NaN)).toBe(true);
		expect(
			isFixedPitchStack('Menlo', 13, () => {
				throw new Error('canvas gone');
			})
		).toBe(true);
	});
});

describe('resolveTerminalFontFamily', () => {
	// The exact reported bug: fontFamily was "Avenir Next", shared with the app
	// chrome, and every terminal rendered on a broken grid.
	it('overrides the configured proportional font with a fixed-pitch stack', () => {
		expect(resolveTerminalFontFamily('Avenir Next', 13, measure)).toBe(FIXED_PITCH_FALLBACK_STACK);
	});

	it('produces a stack that is itself fixed pitch', () => {
		const resolved = resolveTerminalFontFamily('Avenir Next', 13, measure);
		expect(isFixedPitchStack(resolved, 13, measure)).toBe(true);
	});

	it('leaves a monospace choice alone rather than forcing its own', () => {
		expect(resolveTerminalFontFamily('Menlo', 13, measure)).toBe('Menlo, monospace');
	});

	// A missing font is already handled by the appended generic - the browser
	// reaches it and lands on a fixed-pitch face - so no override is needed. The
	// two mechanisms cover different failures and compose.
	it('lets the appended generic rescue a stack whose fonts are all missing', () => {
		const resolved = resolveTerminalFontFamily('No Such Font', 13, measure);
		expect(resolved).toBe('No Such Font, monospace');
		expect(isFixedPitchStack(resolved, 13, measure)).toBe(true);
	});

	// Without a canvas (jsdom, a locked-down renderer) there is no evidence, so
	// the user's configured font is kept rather than silently replaced.
	it('keeps the configured stack when it cannot measure', () => {
		expect(resolveTerminalFontFamily('Avenir Next', 13, null)).toBe('Avenir Next, monospace');
	});
});
