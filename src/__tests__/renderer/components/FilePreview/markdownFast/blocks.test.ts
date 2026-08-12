import { describe, it, expect } from 'vitest';
import { createParser } from '../../../../../renderer/components/FilePreview/markdownFast/parser';
import { tokensToBlocks } from '../../../../../renderer/components/FilePreview/markdownFast/blocks';
import { applyHeadingSlugs } from '../../../../../renderer/components/FilePreview/markdownFast/headingSlugger';

function parseToBlocks(source: string) {
	const md = createParser();
	const tokens = md.parse(source, {});
	return tokensToBlocks(md, tokens);
}

function parseToBlocksWithSlugs(source: string) {
	const md = createParser();
	const tokens = md.parse(source, {});
	applyHeadingSlugs(md, tokens);
	return tokensToBlocks(md, tokens);
}

describe('tokensToBlocks', () => {
	it('returns an empty array for empty input', () => {
		expect(parseToBlocks('')).toEqual([]);
	});

	it('groups a single paragraph into one block', () => {
		const blocks = parseToBlocks('hello world');
		expect(blocks.length).toBe(1);
		expect(blocks[0].html).toContain('<p>hello world</p>');
	});

	it('emits one block per heading', () => {
		const blocks = parseToBlocks('# A\n\n# B\n\n# C');
		expect(blocks.length).toBe(3);
		expect(blocks[0].html).toContain('<h1>A</h1>');
		expect(blocks[1].html).toContain('<h1>B</h1>');
		expect(blocks[2].html).toContain('<h1>C</h1>');
	});

	it('separates heading and paragraph into distinct blocks', () => {
		const blocks = parseToBlocks('# Heading\n\nA paragraph.');
		expect(blocks.length).toBe(2);
		expect(blocks[0].html).toContain('<h1>');
		expect(blocks[1].html).toContain('<p>A paragraph.</p>');
	});

	it('treats fenced code blocks as a single standalone block', () => {
		const blocks = parseToBlocks('```\nfoo\nbar\n```');
		expect(blocks.length).toBe(1);
		expect(blocks[0].html).toContain('<pre>');
		expect(blocks[0].html).toContain('foo');
	});

	it('treats horizontal rule as a single standalone block', () => {
		const blocks = parseToBlocks('---');
		expect(blocks.length).toBe(1);
		expect(blocks[0].html).toContain('<hr>');
	});

	it('keeps nested list items inside their containing list block', () => {
		// A list with nested items should be one block, not many - the inner
		// items live at level > 0 and are skipped by the outer walker.
		const blocks = parseToBlocks('- a\n  - a1\n  - a2\n- b');
		expect(blocks.length).toBe(1);
		expect(blocks[0].html).toContain('<ul>');
		expect(blocks[0].html).toContain('a1');
		expect(blocks[0].html).toContain('a2');
	});

	it('keeps a GFM table as a single block regardless of row count', () => {
		const source = ['| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |'].join('\n');
		const blocks = parseToBlocks(source);
		expect(blocks.length).toBe(1);
		expect(blocks[0].html).toContain('<table>');
		expect(blocks[0].html).toContain('<th>a</th>');
		expect(blocks[0].html).toContain('<td>5</td>');
	});

	it('treats blockquotes as a single block including nested content', () => {
		const blocks = parseToBlocks('> quoted\n>\n> more quote');
		expect(blocks.length).toBe(1);
		expect(blocks[0].html).toContain('<blockquote>');
	});

	it('assigns sequential ids starting at 0', () => {
		const blocks = parseToBlocks('# A\n\n# B\n\n# C');
		expect(blocks.map((b) => b.id)).toEqual([0, 1, 2]);
	});

	it('handles raw HTML blocks as standalone blocks', () => {
		const blocks = parseToBlocks('<div>raw</div>\n\nafter');
		expect(blocks.length).toBe(2);
		expect(blocks[0].html).toContain('<div>raw</div>');
		expect(blocks[1].html).toContain('<p>after</p>');
	});

	it('handles a mix of block types in document order', () => {
		const source = [
			'# Title',
			'',
			'Intro paragraph.',
			'',
			'```',
			'code',
			'```',
			'',
			'- list',
			'',
		].join('\n');
		const blocks = parseToBlocks(source);
		expect(blocks.length).toBe(4);
		expect(blocks[0].html).toContain('<h1>');
		expect(blocks[1].html).toContain('<p>');
		expect(blocks[2].html).toContain('<pre>');
		expect(blocks[3].html).toContain('<ul>');
	});

	it('does not emit any blocks for tokens that are nested (level > 0)', () => {
		// All emitted blocks should themselves wrap their nested content; we
		// should never see a stray inline or text token rendered alone.
		const blocks = parseToBlocks('**bold** *italic* text');
		expect(blocks.length).toBe(1);
		expect(blocks[0].html).toContain('<strong>bold</strong>');
		expect(blocks[0].html).toContain('<em>italic</em>');
	});

	it('produces blocks whose ids are unique', () => {
		const source = Array.from({ length: 20 }, (_, i) => `# Heading ${i}`).join('\n\n');
		const blocks = parseToBlocks(source);
		const ids = new Set(blocks.map((b) => b.id));
		expect(ids.size).toBe(blocks.length);
	});

	describe('headingSlug propagation', () => {
		it('does not attach a headingSlug when no slugger plugin runs', () => {
			const blocks = parseToBlocks('# A\n\nparagraph');
			expect(blocks[0].headingSlug).toBeUndefined();
			expect(blocks[1].headingSlug).toBeUndefined();
		});

		it('attaches headingSlug to heading blocks when slugger plugin runs', () => {
			const blocks = parseToBlocksWithSlugs('# Hello World');
			expect(blocks[0].headingSlug).toBe('hello-world');
		});

		it('leaves non-heading blocks with undefined headingSlug', () => {
			const blocks = parseToBlocksWithSlugs('# H\n\nparagraph\n\n- list');
			expect(blocks[0].headingSlug).toBe('h');
			expect(blocks[1].headingSlug).toBeUndefined();
			expect(blocks[2].headingSlug).toBeUndefined();
		});

		it('preserves slug uniqueness across duplicate headings', () => {
			const blocks = parseToBlocksWithSlugs('# Same\n\n# Same\n\n# Same');
			expect(blocks.map((b) => b.headingSlug)).toEqual(['same', 'same-1', 'same-2']);
		});

		it('handles a doc with no headings at all', () => {
			const blocks = parseToBlocksWithSlugs('just a paragraph\n\nand another');
			expect(blocks.every((b) => b.headingSlug === undefined)).toBe(true);
		});
	});
});
