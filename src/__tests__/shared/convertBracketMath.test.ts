import { describe, it, expect } from 'vitest';
import { convertBracketMath } from '../../shared/convertBracketMath';

describe('convertBracketMath', () => {
	it('converts inline \\(...\\) to inline $$...$$', () => {
		expect(convertBracketMath('Inline \\(N \\approx 1000\\) here.')).toBe(
			'Inline $$N \\approx 1000$$ here.'
		);
	});

	it('converts display \\[...\\] to a blank-line-isolated $$...$$ block', () => {
		expect(convertBracketMath('Display: \\[E = mc^2\\]')).toBe('Display: \n\n$$E = mc^2$$\n\n');
	});

	it('trims whitespace inside the delimiters', () => {
		expect(convertBracketMath('\\(  x + y  \\)')).toBe('$$x + y$$');
	});

	it('converts multiple inline spans on one line', () => {
		expect(convertBracketMath('Two \\(a\\) and \\(b\\) inline.')).toBe(
			'Two $$a$$ and $$b$$ inline.'
		);
	});

	it('leaves currency and shell variables untouched', () => {
		const input = 'It costs $5 and $10; path is $HOME/bin.';
		expect(convertBracketMath(input)).toBe(input);
	});

	it('does not touch \\(...\\) inside an inline code span', () => {
		const input = 'Code: `\\(y\\)` stays literal';
		expect(convertBracketMath(input)).toBe(input);
	});

	it('does not touch \\[...\\] inside a fenced code block', () => {
		const input = '```\n\\[not math\\]\n```';
		expect(convertBracketMath(input)).toBe(input);
	});

	it('emits an unterminated \\( verbatim (does not swallow the rest)', () => {
		const input = 'Broken \\(x + y and more prose that must survive.';
		expect(convertBracketMath(input)).toBe(input);
	});

	it('returns input unchanged when there are no bracket delimiters', () => {
		const input = 'plain text with $5 and (parentheses) and [brackets]';
		expect(convertBracketMath(input)).toBe(input);
	});

	it('handles a multi-line \\[...\\] display block', () => {
		const input = '\\[\\begin{aligned}\na &= b\n\\end{aligned}\\]';
		expect(convertBracketMath(input)).toBe('\n\n$$\\begin{aligned}\na &= b\n\\end{aligned}$$\n\n');
	});
});
