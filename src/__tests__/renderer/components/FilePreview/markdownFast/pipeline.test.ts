import { describe, it, expect } from 'vitest';
import { buildBlocks } from '../../../../../renderer/components/FilePreview/markdownFast/pipeline';

describe('buildBlocks', () => {
	it('returns an empty array for empty input', () => {
		expect(buildBlocks('')).toEqual([]);
	});

	it('returns one block per top-level paragraph', () => {
		const blocks = buildBlocks('first\n\nsecond\n\nthird');
		expect(blocks.length).toBe(3);
		expect(blocks.map((b) => b.html)).toEqual([
			expect.stringContaining('first'),
			expect.stringContaining('second'),
			expect.stringContaining('third'),
		]);
	});

	it('prepends a frontmatter block when YAML frontmatter is present', () => {
		const blocks = buildBlocks('---\ntitle: Doc\n---\n# Heading\n\nbody');
		expect(blocks.length).toBe(3);
		expect(blocks[0].html).toContain('<em>Document metadata:</em>');
		expect(blocks[0].html).toContain('title');
		// Heading carries an id from the slugger plugin in addition to its text.
		expect(blocks[1].html).toMatch(/<h1[^>]*>Heading<\/h1>/);
		expect(blocks[2].html).toContain('<p>body</p>');
	});

	it('does not prepend a frontmatter block when no frontmatter exists', () => {
		const blocks = buildBlocks('# Heading\n\nbody');
		expect(blocks.length).toBe(2);
		expect(blocks[0].html).toMatch(/<h1[^>]*>/);
	});

	it('does not prepend a frontmatter block when YAML is empty', () => {
		const blocks = buildBlocks('---\n\n---\nbody');
		expect(blocks.length).toBe(1);
		expect(blocks[0].html).toContain('<p>body</p>');
	});

	it('assigns sequential ids across frontmatter + body blocks', () => {
		const blocks = buildBlocks('---\ntitle: x\n---\n# A\n\n# B');
		expect(blocks.map((b) => b.id)).toEqual([0, 1, 2]);
	});

	it('handles GFM tables as a single block', () => {
		const source = ['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n');
		const blocks = buildBlocks(source);
		expect(blocks.length).toBe(1);
		expect(blocks[0].html).toContain('<table>');
	});

	it('handles fenced code blocks as their own block', () => {
		const blocks = buildBlocks('# h\n\n```ts\nconst x = 1;\n```\n\nafter');
		expect(blocks.length).toBe(3);
		expect(blocks[1].html).toContain('<pre>');
		expect(blocks[1].html).toContain('language-ts');
	});

	it('emits one block per heading in a document with many headings', () => {
		const source = Array.from({ length: 50 }, (_, i) => `# Heading ${i}`).join('\n\n');
		const blocks = buildBlocks(source);
		expect(blocks.length).toBe(50);
		blocks.forEach((b, i) => {
			expect(b.html).toContain(`Heading ${i}`);
		});
	});

	it('handles a realistic mixed document', () => {
		const source = [
			'---',
			'title: Mixed',
			'---',
			'',
			'# Section A',
			'',
			'Intro **bold** _italic_.',
			'',
			'- item 1',
			'- item 2',
			'',
			'```',
			'code',
			'```',
			'',
			'| h1 | h2 |',
			'| - | - |',
			'| a | b |',
			'',
			'> quote',
			'',
			'---',
			'',
			'# Section B',
		].join('\n');

		const blocks = buildBlocks(source);
		// frontmatter, h1, paragraph, list, code, table, blockquote, hr, h1
		expect(blocks.length).toBeGreaterThanOrEqual(9);
		expect(blocks[0].html).toContain('Document metadata');
		expect(blocks.find((b) => /<h1[^>]*>Section A<\/h1>/.test(b.html))).toBeDefined();
		expect(blocks.find((b) => b.html.includes('<table>'))).toBeDefined();
		expect(blocks.find((b) => b.html.includes('<blockquote>'))).toBeDefined();
		expect(blocks.find((b) => b.html.includes('<hr'))).toBeDefined();
		expect(blocks.find((b) => /<h1[^>]*>Section B<\/h1>/.test(b.html))).toBeDefined();
	});

	it('handles a 5,000-line input without throwing', () => {
		const source = Array.from({ length: 5_000 }, (_, i) => `Line ${i}`).join('\n\n');
		const blocks = buildBlocks(source);
		expect(blocks.length).toBe(5_000);
	});

	it('output is deterministic - same input produces identical blocks twice', () => {
		const source = '# A\n\nparagraph\n\n```\ncode\n```';
		const first = buildBlocks(source);
		const second = buildBlocks(source);
		expect(first).toEqual(second);
	});

	describe('heading slug propagation', () => {
		it('annotates heading blocks with headingSlug', () => {
			const blocks = buildBlocks('# Hello World\n\nbody');
			expect(blocks[0].headingSlug).toBe('hello-world');
		});

		it('emits id="<slug>" inside the rendered HTML of heading blocks', () => {
			const blocks = buildBlocks('# Section A');
			expect(blocks[0].html).toContain('id="section-a"');
		});

		it('skips slugging on non-heading blocks', () => {
			const blocks = buildBlocks('Paragraph.\n\n- list');
			expect(blocks.every((b) => b.headingSlug === undefined)).toBe(true);
		});

		it('disambiguates duplicate headings across the full pipeline', () => {
			const blocks = buildBlocks('# A\n\n# A\n\n# A');
			expect(blocks.map((b) => b.headingSlug)).toEqual(['a', 'a-1', 'a-2']);
		});

		it('keeps slugs stable across runs', () => {
			const src = '# alpha\n\n# beta';
			const a = buildBlocks(src).map((b) => b.headingSlug);
			const b = buildBlocks(src).map((b) => b.headingSlug);
			expect(a).toEqual(b);
		});
	});

	describe('React fences (reactFenceLanguages)', () => {
		const DATAVIEW = new Set(['dataview']);

		it('tags a top-level fence of a listed language with its body and 1-based line', () => {
			const blocks = buildBlocks('# Title\n\n```dataview\nLIST\nFROM "People"\n```\n', {
				reactFenceLanguages: DATAVIEW,
			});
			const fence = blocks.find((b) => b.fence);
			expect(fence?.fence).toEqual({
				language: 'dataview',
				content: 'LIST\nFROM "People"',
				line: 3,
			});
			// The HTML stays as the fallback when the renderer goes away.
			expect(fence?.html).toContain('<pre');
		});

		it('counts the frontmatter lines into the fence line', () => {
			const blocks = buildBlocks('---\ntitle: Doc\n---\n```dataview\nLIST\n```\n', {
				reactFenceLanguages: DATAVIEW,
			});
			expect(blocks.find((b) => b.fence)?.fence?.line).toBe(4);
		});

		it('matches the first info word exactly', () => {
			const blocks = buildBlocks(
				'```dataview extra\nLIST\n```\n\n```dataviewjs\ndv.list([])\n```\n\n```js\nx\n```\n',
				{ reactFenceLanguages: DATAVIEW }
			);
			expect(blocks.filter((b) => b.fence).map((b) => b.fence?.content)).toEqual(['LIST']);
		});

		it('leaves a fence nested in a list as HTML', () => {
			const blocks = buildBlocks('- item\n\n  ```dataview\n  LIST\n  ```\n', {
				reactFenceLanguages: DATAVIEW,
			});
			expect(blocks.some((b) => b.fence)).toBe(false);
		});

		it('tags nothing without the option', () => {
			expect(buildBlocks('```dataview\nLIST\n```\n').some((b) => b.fence)).toBe(false);
		});
	});
});
