import { describe, expect, it } from 'vitest';
import { highlightCode, htmlToStyledLines, resolveHighlightLanguage } from '../highlight';

describe('resolveHighlightLanguage', () => {
	it('maps fence labels people write to registered grammars', () => {
		expect(resolveHighlightLanguage('ts')).toBe('typescript');
		expect(resolveHighlightLanguage('TSX')).toBe('typescript');
		expect(resolveHighlightLanguage('sh')).toBe('bash');
		expect(resolveHighlightLanguage('json title="x"')).toBe('json');
	});

	it('returns undefined for no label or an unknown language', () => {
		expect(resolveHighlightLanguage(undefined)).toBeUndefined();
		expect(resolveHighlightLanguage('')).toBeUndefined();
		expect(resolveHighlightLanguage('klingon')).toBeUndefined();
	});
});

describe('highlightCode', () => {
	it('colors keywords and strings, and keeps all of the text', () => {
		const lines = highlightCode('const a = "x";\nreturn 1;', 'ts');
		expect(lines).toHaveLength(2);
		expect(lines.map((line) => line.map((span) => span.text).join('')).join('\n')).toBe(
			'const a = "x";\nreturn 1;'
		);
		const spans = lines.flat();
		expect(spans.find((span) => span.text === 'const')?.color).toBe('magenta');
		expect(spans.find((span) => span.text === '"x"')?.color).toBe('green');
	});

	it('decodes HTML entities in highlighted output', () => {
		const text = highlightCode('if (a < b && c > d) {}', 'js')
			.map((line) => line.map((span) => span.text).join(''))
			.join('\n');
		expect(text).toBe('if (a < b && c > d) {}');
	});

	it('returns plain lines for an unknown language and keeps blank lines', () => {
		expect(highlightCode('a\n\nb', 'klingon')).toEqual([[{ text: 'a' }], [], [{ text: 'b' }]]);
		expect(highlightCode('a', undefined)).toEqual([[{ text: 'a' }]]);
	});

	it('splits a span that crosses a newline so every line stands alone', () => {
		const lines = highlightCode('/* one\ntwo */', 'js');
		expect(lines).toHaveLength(2);
		expect(lines[0]![0]).toMatchObject({ text: '/* one', color: 'gray' });
		expect(lines[1]![0]).toMatchObject({ text: 'two */', color: 'gray' });
	});
});

describe('htmlToStyledLines', () => {
	it('inherits the style of an enclosing span', () => {
		const lines = htmlToStyledLines(
			'<span class="hljs-string">a<span class="hljs-subst">b</span></span>c'
		);
		expect(lines[0]).toEqual([
			{ text: 'a', color: 'green' },
			{ text: 'b', color: 'green' },
			{ text: 'c' },
		]);
	});
});
