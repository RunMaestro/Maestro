import { describe, expect, it } from 'vitest';
import { escapeRegExp } from '../../shared/stringUtils';

const ECMASCRIPT_REGEX_METACHARACTERS = [
	'.',
	'*',
	'+',
	'?',
	'^',
	'$',
	'{',
	'}',
	'(',
	')',
	'|',
	'[',
	']',
	'\\',
];

describe('escapeRegExp', () => {
	it.each(ECMASCRIPT_REGEX_METACHARACTERS)('escapes the %s metacharacter', (character) => {
		expect(escapeRegExp(character)).toBe(`\\${character}`);
	});

	it('produces a literal matcher for every metacharacter in sequence', () => {
		const value = ECMASCRIPT_REGEX_METACHARACTERS.join('');
		expect(new RegExp(`^${escapeRegExp(value)}$`, 'u').test(value)).toBe(true);
	});

	it.each(['plain text', 'café', '你好', 'emoji 😀'])(
		'leaves ordinary Unicode unchanged',
		(value) => {
			expect(escapeRegExp(value)).toBe(value);
		}
	);
});
