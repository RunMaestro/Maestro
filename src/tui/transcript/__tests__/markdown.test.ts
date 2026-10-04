import { describe, expect, it } from 'vitest';
import { parseMarkdown, spansText, type Block } from '../markdown';

const only = <K extends Block['kind']>(markdown: string, kind: K) => {
	const blocks = parseMarkdown(markdown);
	expect(blocks).toHaveLength(1);
	expect(blocks[0]!.kind).toBe(kind);
	return blocks[0] as Extract<Block, { kind: K }>;
};

describe('parseMarkdown', () => {
	it('parses headings with their depth', () => {
		const heading = only('### Title **bold**', 'heading');
		expect(heading.depth).toBe(3);
		expect(spansText(heading.spans)).toBe('Title bold');
		expect(heading.spans[1]).toMatchObject({ text: 'bold', bold: true });
	});

	it('styles inline bold, italic, strikethrough, and code, nested', () => {
		const paragraph = only('**a _b_** ~~c~~ `d<e`', 'paragraph');
		expect(paragraph.spans).toEqual([
			{ text: 'a ', bold: true },
			{ text: 'b', bold: true, italic: true },
			{ text: ' ' },
			{ text: 'c', strikethrough: true },
			{ text: ' ' },
			{ text: 'd<e', color: 'yellow' },
		]);
	});

	it('shows a link as its text followed by the URL', () => {
		const paragraph = only('[docs](https://x.test/a)', 'paragraph');
		expect(spansText(paragraph.spans)).toBe('docs (https://x.test/a)');
		expect(paragraph.spans[0]).toMatchObject({ underline: true });
		expect(paragraph.spans[1]).toMatchObject({ dimColor: true });
	});

	it('does not repeat the URL when the link text is the URL', () => {
		const paragraph = only('[https://x.test](https://x.test)', 'paragraph');
		expect(spansText(paragraph.spans)).toBe('https://x.test');
	});

	it('shows an image as a bracketed alt text', () => {
		expect(spansText(only('![a cat](cat.png)', 'paragraph').spans)).toBe('[image: a cat]');
	});

	it('keeps unescaped characters in text', () => {
		expect(spansText(only('a & b <c> "d"', 'paragraph').spans)).toContain('a & b ');
	});

	it('parses a bullet list, nested lists, and task items', () => {
		const list = only('- one\n- [x] done\n- [ ] todo\n  1. inner', 'list');
		expect(list.ordered).toBe(false);
		expect(list.items.map((item) => item.checked)).toEqual([undefined, true, false]);
		const nested = list.items[2]!.blocks[1];
		expect(nested).toMatchObject({ kind: 'list', ordered: true, start: 1 });
	});

	it('keeps the start number of an ordered list', () => {
		expect(only('3. a\n4. b', 'list')).toMatchObject({ ordered: true, start: 3 });
	});

	it('parses a table with alignment', () => {
		const table = only('| a | b |\n|:-|-:|\n| 1 | 2 |', 'table');
		expect(table.align).toEqual(['left', 'right']);
		expect(table.header.map(spansText)).toEqual(['a', 'b']);
		expect(table.rows.map((row) => row.map(spansText))).toEqual([['1', '2']]);
	});

	it('parses a fenced code block with its language and highlighting', () => {
		const code = only('```ts\nconst a = 1;\n```', 'code');
		expect(code.language).toBe('ts');
		expect(code.lines[0]!.find((span) => span.text === 'const')?.color).toBe('magenta');
	});

	it('parses a fence with no language as plain code', () => {
		const code = only('```\nplain\n```', 'code');
		expect(code.language).toBeUndefined();
		expect(code.lines).toEqual([[{ text: 'plain' }]]);
	});

	it('parses a blockquote with its own blocks', () => {
		const quote = only('> quoted\n> more', 'quote');
		expect(quote.blocks[0]!.kind).toBe('paragraph');
	});

	it('parses a rule and keeps raw HTML as text', () => {
		expect(parseMarkdown('---')).toEqual([{ kind: 'rule' }]);
		expect(spansText(only('<b>hi</b>', 'paragraph').spans)).toContain('hi');
	});

	it('returns no blocks for empty text', () => {
		expect(parseMarkdown('')).toEqual([]);
	});
});
