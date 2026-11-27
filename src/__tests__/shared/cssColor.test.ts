import { describe, it, expect } from 'vitest';
import { isStrictCssColor, isValidCssColor, strictCssColors } from '../../shared/cssColor';

describe('isValidCssColor', () => {
	describe('hex colors', () => {
		it('accepts 6- and 8-digit hex', () => {
			expect(isValidCssColor('#282a36')).toBe(true);
			expect(isValidCssColor('#bd93f9')).toBe(true);
			expect(isValidCssColor('#282a36ff')).toBe(true);
		});

		it('accepts 3- and 4-digit hex', () => {
			expect(isValidCssColor('#abc')).toBe(true);
			expect(isValidCssColor('#abcd')).toBe(true);
		});

		it('rejects malformed hex', () => {
			expect(isValidCssColor('#12')).toBe(false);
			expect(isValidCssColor('#xyzxyz')).toBe(false);
			expect(isValidCssColor('282a36')).toBe(false);
		});
	});

	describe('functional notations', () => {
		it('accepts rgb() and rgba()', () => {
			expect(isValidCssColor('rgb(26, 26, 46)')).toBe(true);
			expect(isValidCssColor('rgba(189, 147, 249, 0.2)')).toBe(true);
		});

		it('accepts hsl() and hsla()', () => {
			expect(isValidCssColor('hsl(262, 83%, 58%)')).toBe(true);
			expect(isValidCssColor('hsla(262, 83%, 58%, 0.5)')).toBe(true);
		});
	});

	describe('named colors', () => {
		it('accepts CSS named colors (case-insensitive)', () => {
			expect(isValidCssColor('darkblue')).toBe(true);
			expect(isValidCssColor('rebeccapurple')).toBe(true);
			expect(isValidCssColor('Transparent')).toBe(true);
		});

		it('rejects arbitrary words that are not named colors', () => {
			expect(isValidCssColor('not-a-color')).toBe(false);
			expect(isValidCssColor('bluish')).toBe(false);
		});
	});

	describe('invalid input', () => {
		it('rejects empty and whitespace-only strings', () => {
			expect(isValidCssColor('')).toBe(false);
			expect(isValidCssColor('   ')).toBe(false);
		});

		it('rejects non-string input', () => {
			expect(isValidCssColor(null)).toBe(false);
			expect(isValidCssColor(undefined)).toBe(false);
			expect(isValidCssColor(42)).toBe(false);
		});
	});
});

describe('isStrictCssColor', () => {
	it.each([
		'#abc',
		'#ABCD',
		'#a1b2c3',
		'#A1B2C3D4',
		'rgb(255, 0, 0)',
		'rgb(255,0,0)',
		'RGB(255 0 0)',
		'rgba(189, 147, 249, 0.2)',
		'rgba(1, 2, 3, 50%)',
		'rgb(255 0 0 / 50%)',
		'rgb(255 0 0/0.5)',
		'rgba(255 0 0 / .5)',
		'rgb(100%, 0%, 0%)',
		'rgb( 1 , 2 , 3 )',
		'rgb(\t1\t2\t3\t)',
		'rgb(-1, +2, .5)',
		'hsl(262, 83%, 58%)',
		'hsla(262, 83%, 58%, 0.5)',
		'hsl(120deg 50% 50%)',
		'hsl(120 50 50)',
		'rgb(100% 0 0)',
		'HSL(120DEG 50% 50% / .3)',
		'hsl(-30, 50%, 50%)',
		'red',
		'Red',
		'REBECCAPURPLE',
		'transparent',
		'currentColor',
		'currentcolor',
	])('accepts %j', (value) => {
		expect(isStrictCssColor(value)).toBe(true);
	});

	it.each([
		// Values that leave their declaration or rule.
		'red;} * { background: url(https://x/?a',
		'red} input[value^="a"] { background-image: url(https://x/?p=a) } .x { color: red',
		'red;',
		'red}',
		'#fff}',
		'red{',
		'rgb(1,2,3);x:y',
		// Other functions, including inside a color function.
		'url(https://x/a.png)',
		'expression(alert(1))',
		'var(--x)',
		'rgba(var(--x), 1)',
		'rgb(url(https://x/), 0, 0)',
		'color-mix(in srgb, red, blue)',
		'oklch(0.7 0.1 200)',
		// Escapes, quotes and comments.
		'\\72 ed',
		'red\\',
		'"red"',
		"'red'",
		'red/**/',
		'rgb(1,2,3)/**/',
		// Whitespace and line breaks around or inside the value.
		'#fff\n',
		'\n#fff',
		'red\n',
		'rgb(1,\n2,3)',
		'rgb(1,2,3)\n',
		'#fff\r',
		'red\f',
		' #fff',
		'#fff ',
		`#fff${String.fromCodePoint(0x2028)}`,
		`${String.fromCodePoint(0xa0)}red`,
		`r${String.fromCodePoint(0)}ed`,
		// Malformed colors.
		'',
		'#12',
		'#12345',
		'#xyzxyz',
		'fff',
		'rgb()',
		'rgb(1,2)',
		'rgb(1,2,3,4,5)',
		'rgb(1 2, 3)',
		'rgb(1, 2 3)',
		'rgb(1 2 3 4)',
		'rgb(1 2 3 / 4 / 5)',
		'rgb(1e2, 0, 0)',
		'rgb(1., 0, 0)',
		'rgb(1px, 0, 0)',
		'rgb(10deg, 0, 0)',
		'rgb(100%, 0, 0)',
		'rgb(255, 0%, 0)',
		'hsl(120, 50, 50)',
		'hsl(120, 50%, 50)',
		'hsl(ggg)',
		'inherit',
		'none',
		'bluish',
	])('refuses %j', (value) => {
		expect(isStrictCssColor(value)).toBe(false);
	});

	it('refuses a name that only matches after Unicode case folding', () => {
		// U+212A KELVIN SIGN lowercases to an ASCII "k"; CSS would not read it as one.
		expect(isStrictCssColor(`blac${String.fromCodePoint(0x212a)}`)).toBe(false);
		expect(isStrictCssColor(`${String.fromCodePoint(0x212a)}haki`)).toBe(false);
		expect(isStrictCssColor('black')).toBe(true);
	});

	it('refuses non-string input', () => {
		for (const value of [null, undefined, 42, {}, ['#fff']]) {
			expect(isStrictCssColor(value)).toBe(false);
		}
	});

	it('answers quickly for a long hostile value', () => {
		const started = Date.now();
		expect(isStrictCssColor(`rgb(1 2 3${' '.repeat(50_000)}x`)).toBe(false);
		expect(isStrictCssColor(`rgb(${'1'.repeat(50_000)}x`)).toBe(false);
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});

describe('strictCssColors', () => {
	it('blanks every value that is not a plain color and keeps the rest', () => {
		const colors = strictCssColors({
			bgMain: '#000000',
			textMain: 'red;} * { background: url(https://x/?a',
			accent: 'rgb(1, 2, 3)',
			border: 'url(https://x/a.png)',
		});
		expect(colors).toEqual({
			bgMain: '#000000',
			textMain: '',
			accent: 'rgb(1, 2, 3)',
			border: '',
		});
	});

	it('returns a copy and leaves the palette it was given alone', () => {
		const palette = Object.freeze({ textMain: 'expression(alert(1))', bgMain: '#fff' });
		const colors = strictCssColors(palette);
		expect(colors).not.toBe(palette);
		expect(palette.textMain).toBe('expression(alert(1))');
		expect(colors.textMain).toBe('');
	});

	it('copies a value that is not a string as it is', () => {
		const colors = strictCssColors<{ bgMain: string; selection?: string }>({
			bgMain: '#fff',
			selection: undefined,
		});
		expect('selection' in colors).toBe(true);
		expect(colors.selection).toBeUndefined();
	});
});
