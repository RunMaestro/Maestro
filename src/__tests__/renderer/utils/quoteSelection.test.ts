import { describe, it, expect } from 'vitest';
import {
	appendQuoteToDraft,
	formatFileLineReference,
	formatFileSelection,
	formatMarkdownQuote,
} from '../../../renderer/utils/quoteSelection';

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

describe('formatFileLineReference', () => {
	it('names one line or a span', () => {
		expect(formatFileLineReference('src/app.ts', 12)).toBe('src/app.ts:12');
		expect(formatFileLineReference('src/app.ts', 12, 12)).toBe('src/app.ts:12');
		expect(formatFileLineReference('src/app.ts', 12, 30)).toBe('src/app.ts:12-30');
	});
});

describe('formatFileSelection', () => {
	it('puts the path and line range above the text in a language fence', () => {
		expect(
			formatFileSelection({
				path: 'src/app.ts',
				startLine: 3,
				endLine: 4,
				text: 'const a = 1;\nconst b = 2;\n',
				language: 'typescript',
			})
		).toBe('`src/app.ts:3-4`\n```typescript\nconst a = 1;\nconst b = 2;\n```');
	});

	it('writes a bare fence for plain text', () => {
		expect(
			formatFileSelection({
				path: 'notes.txt',
				startLine: 1,
				endLine: 1,
				text: 'hi',
				language: 'text',
			})
		).toBe('`notes.txt:1`\n```\nhi\n```');
	});

	it('lengthens the fence past any backtick run inside the passage', () => {
		const text = '```js\nx\n```';
		const out = formatFileSelection({ path: 'README.md', startLine: 1, endLine: 3, text });
		expect(out.split('\n')[1]).toBe('````');
		expect(out.endsWith('\n````')).toBe(true);
	});

	it('quotes into a draft as one block, blank lines included', () => {
		const passage = formatFileSelection({
			path: 'a.py',
			startLine: 1,
			endLine: 3,
			text: 'def f():\n\n    return 1',
			language: 'python',
		});
		expect(appendQuoteToDraft('', passage)).toBe(
			'> `a.py:1-3`\n> ```python\n> def f():\n>\n>     return 1\n> ```\n\n'
		);
	});
});
