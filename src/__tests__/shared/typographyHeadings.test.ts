import { describe, it, expect } from 'vitest';
import {
	HEADING_FONT_SIZE_MAX,
	HEADING_FONT_SIZE_MIN,
	clampHeadingFontSize,
	defaultHeadingSize,
	headingFontCss,
	headingFontVar,
	headingSizeVar,
	parseHeadingTypography,
	resolveHeadingLevel,
	withHeadingStyle,
} from '../../shared/typography';

describe('heading typography registry', () => {
	it('names one font and one size variable per level', () => {
		expect(headingFontVar('h1')).toBe('--maestro-heading-h1-font');
		expect(headingSizeVar('h6')).toBe('--maestro-heading-h6-size');
	});

	it('keeps the stylesheet size as the fallback and gives the family none', () => {
		// The family must NOT carry a fallback: an unset variable then resolves
		// to the inherited font, which is what headings rendered before.
		// The override is scaled by the pane zoom on the heading itself; with no
		// override the helper property is invalid and the em fallback wins.
		expect(headingFontCss('h2', '1.5em')).toBe(
			'--maestro-heading-h2-scaled-size: calc(var(--maestro-heading-h2-size) * var(--fp-font-scale, 1)); font-size: var(--maestro-heading-h2-scaled-size, 1.5em); font-family: var(--maestro-heading-h2-font);'
		);
	});

	it('resolves loose level spellings', () => {
		expect(resolveHeadingLevel('h1')).toBe('h1');
		expect(resolveHeadingLevel('H3')).toBe('h3');
		expect(resolveHeadingLevel('heading4')).toBe('h4');
		expect(resolveHeadingLevel('6')).toBe('h6');
		expect(resolveHeadingLevel('h7')).toBeNull();
		expect(resolveHeadingLevel('title')).toBeNull();
	});

	it('clamps sizes and keeps 0 as "default"', () => {
		expect(clampHeadingFontSize(0)).toBe(0);
		expect(clampHeadingFontSize(-4)).toBe(0);
		expect(clampHeadingFontSize(Number.NaN)).toBe(0);
		expect(clampHeadingFontSize(2)).toBe(HEADING_FONT_SIZE_MIN);
		expect(clampHeadingFontSize(500)).toBe(HEADING_FONT_SIZE_MAX);
		expect(clampHeadingFontSize(27.6)).toBe(28);
	});

	it('estimates the default size from the base size', () => {
		// The AI chat's scale: H2 at 1.75em, H6 at 1.1em.
		expect(defaultHeadingSize('h1', 14)).toBe(28);
		expect(defaultHeadingSize('h2', 14)).toBe(25);
		expect(defaultHeadingSize('h6', 8)).toBe(9);
		expect(defaultHeadingSize('h1', 0)).toBe(28);
	});
});

describe('parseHeadingTypography', () => {
	it('returns an empty map for anything that is not an object', () => {
		expect(parseHeadingTypography(undefined)).toEqual({});
		expect(parseHeadingTypography('h1')).toEqual({});
		expect(parseHeadingTypography([1, 2])).toEqual({});
	});

	it('keeps valid levels, clamps sizes, and drops unknown keys and empty levels', () => {
		expect(
			parseHeadingTypography({
				h1: { fontFamily: ' Georgia ', fontSize: 200 },
				h2: { fontFamily: '', fontSize: 0 },
				h3: { fontSize: '18' },
				h7: { fontFamily: 'Comic Sans', fontSize: 20 },
				h4: 'bogus',
				h5: { fontFamily: 'Georgia', fontSize: { toString: null } },
			})
		).toEqual({
			h1: { fontFamily: 'Georgia', fontSize: HEADING_FONT_SIZE_MAX },
			h3: { fontFamily: '', fontSize: 18 },
			h5: { fontFamily: 'Georgia', fontSize: 0 },
		});
	});
});

describe('withHeadingStyle', () => {
	it('patches one field and leaves the other alone', () => {
		const start = { h1: { fontFamily: 'Georgia', fontSize: 28 } };
		expect(withHeadingStyle(start, 'h1', { fontSize: 32 })).toEqual({
			h1: { fontFamily: 'Georgia', fontSize: 32 },
		});
		expect(start.h1.fontSize).toBe(28);
	});

	it('drops a level once both fields are back to default', () => {
		const start = { h1: { fontFamily: '', fontSize: 28 } };
		expect(withHeadingStyle(start, 'h1', { fontSize: 0 })).toEqual({});
	});
});
