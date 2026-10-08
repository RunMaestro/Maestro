import { describe, it, expect } from 'vitest';
import { appendQuoteToDraft, formatMarkdownQuote } from '../../../renderer/utils/quoteSelection';

describe('formatMarkdownQuote', () => {
	it('prefixes every line and keeps inner blank lines inside the quote', () => {
		expect(formatMarkdownQuote('one\n\ntwo')).toBe('> one\n>\n> two');
	});

	it('drops surrounding blank lines and normalizes CRLF', () => {
		expect(formatMarkdownQuote('\r\n  \r\nline one\r\nline two  \r\n\r\n')).toBe(
			'> line one\n> line two'
		);
	});

	it('returns an empty string for a whitespace-only selection', () => {
		expect(formatMarkdownQuote(' \n\t\n')).toBe('');
	});
});

describe('appendQuoteToDraft', () => {
	it('quotes into an empty draft with a blank line after for the comment', () => {
		expect(appendQuoteToDraft('', 'passage')).toBe('> passage\n\n');
	});

	it('appends below existing text separated by one blank line', () => {
		expect(appendQuoteToDraft('> a\n\ncomment on a\n', 'b')).toBe('> a\n\ncomment on a\n\n> b\n\n');
	});

	it('leaves the draft unchanged for an empty selection', () => {
		expect(appendQuoteToDraft('draft', '   ')).toBe('draft');
	});
});
