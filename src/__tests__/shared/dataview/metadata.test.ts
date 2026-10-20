/**
 * Tests for M1, the markdown-to-CachedMetadata extractor (src/shared/dataview/metadata.ts), and the
 * `parsePage` wrapper (src/shared/dataview/page.ts), reached through src/shared/dataview/index.ts.
 * The fixture-vault tests for `parsePage` live in page.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { createLinkResolver, extractMetadata, Link, parsePage } from '../../../shared/dataview';
import type { PageParseWarning } from '../../../shared/dataview';

const lines = (...rows: string[]) => rows.join('\n');

describe('extractMetadata', () => {
	it('parses frontmatter with the core schema and records frontmatter links', () => {
		const { metadata, warnings } = extractMetadata(
			lines(
				'---',
				'created: 2026-09-01',
				'Connection: "[[Pedram Amini]]"',
				'List:',
				'  - "[[A|Alias]]"',
				'  - plain',
				'---',
				'Body'
			)
		);
		expect(warnings).toEqual([]);
		// CORE_SCHEMA keeps the date a string, so Dataview's own date parser applies (local zone).
		expect(metadata.frontmatter).toEqual({
			created: '2026-09-01',
			Connection: '[[Pedram Amini]]',
			List: ['[[A|Alias]]', 'plain'],
		});
		expect(metadata.frontmatterPosition?.end.line).toBe(6);
		expect(metadata.frontmatterLinks).toEqual([
			{
				key: 'Connection',
				link: 'Pedram Amini',
				original: '[[Pedram Amini]]',
				displayText: 'Pedram Amini',
			},
			{ key: 'List.0', link: 'A', original: '[[A|Alias]]', displayText: 'Alias' },
		]);
		expect(metadata.sections?.[0]).toMatchObject({
			type: 'yaml',
			position: { start: { line: 0 }, end: { line: 6 } },
		});
	});

	it('turns invalid YAML into a warning and no frontmatter, and still indexes the body', () => {
		const { metadata, warnings } = extractMetadata(
			lines('---', 'key: [unclosed', '---', 'See [[Target]].')
		);
		expect(metadata.frontmatter).toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0].message).toMatch(/^Invalid YAML frontmatter: /);
		expect(metadata.links?.map((l) => [l.link, l.position.start.line])).toEqual([['Target', 3]]);
	});

	it('warns when the frontmatter is not a mapping', () => {
		const { metadata, warnings } = extractMetadata(lines('---', '- a', '- b', '---'));
		expect(metadata.frontmatter).toBeUndefined();
		expect(warnings).toEqual([
			{ line: 0, message: 'Frontmatter is not a YAML mapping; it was ignored.' },
		]);
	});

	it('extracts wiki links, embeds, subpaths, aliases, and markdown links with their lines', () => {
		const { metadata } = extractMetadata(
			lines(
				'# Title',
				'',
				'See [[Note]], [[Note#Heading|Alias]], and [[Note#^block]].',
				'Embed ![[image.png]] and ![[Doc]].',
				'Markdown [x](Other.md) and [spaced](My%20Note.md#Part) but not [site](https://example.com).',
				'| a | b |',
				'|---|---|',
				'| [[Cell\\|Shown]] | c |'
			)
		);
		expect(metadata.links?.map((l) => [l.link, l.displayText, l.position.start.line])).toEqual([
			['Note', 'Note', 2],
			['Note#Heading', 'Alias', 2],
			['Note#^block', 'Note#^block', 2],
			['Other.md', 'x', 4],
			['My Note.md#Part', 'spaced', 4],
			['Cell', 'Shown', 7],
		]);
		expect(metadata.embeds?.map((l) => [l.link, l.position.start.line])).toEqual([
			['image.png', 3],
			['Doc', 3],
		]);
	});

	it('skips links and tags inside code, inline code, HTML, and comments', () => {
		const { metadata } = extractMetadata(
			lines(
				'Real #kept and [[Kept]] but `#span [[Span]]` and %%#hidden [[Hidden]]%%.',
				'',
				'```',
				'#fenced [[Fenced]]',
				'```',
				'',
				'    #indented [[Indented]]',
				'',
				'<div>#html [[Html]]</div>'
			)
		);
		expect(metadata.tags?.map((t) => t.tag)).toEqual(['#kept']);
		expect(metadata.links?.map((l) => l.link)).toEqual(['Kept']);
	});

	it('follows Obsidian tag rules: after whitespace, not all digits, nested tags whole', () => {
		const { metadata } = extractMetadata(
			'#start mid#word #123 #project/alpha #a-b_c, url.com/#frag'
		);
		expect(metadata.tags?.map((t) => t.tag)).toEqual(['#start', '#project/alpha', '#a-b_c']);
	});

	it('records headings and top-level sections', () => {
		const { metadata } = extractMetadata(
			lines(
				'# One',
				'',
				'Para',
				'graph',
				'',
				'- item',
				'',
				'> [!note]',
				'> callout',
				'',
				'---',
				'',
				'## Two'
			)
		);
		expect(metadata.headings?.map((h) => [h.heading, h.level, h.position.start.line])).toEqual([
			['One', 1, 0],
			['Two', 2, 12],
		]);
		expect(
			metadata.sections?.map((s) => [s.type, s.position.start.line, s.position.end.line])
		).toEqual([
			['heading', 0, 0],
			['paragraph', 2, 3],
			['list', 5, 5],
			['callout', 7, 8],
			['thematicBreak', 10, 10],
			['heading', 12, 12],
		]);
	});

	it('records list items with their own lines, parents, task characters, and block ids', () => {
		const { metadata } = extractMetadata(
			lines(
				'Intro',
				'',
				'- [ ] open',
				'  continued',
				'- [x] done ^done-id',
				'- parent',
				'\t- child',
				'\t\t- grandchild',
				'',
				'\t- [/] partial',
				'',
				'1. ordered'
			)
		);
		expect(
			metadata.listItems?.map((item) => [
				item.position.start.line,
				item.position.end.line,
				item.parent,
				item.task,
				item.id,
			])
		).toEqual([
			[2, 3, -2, ' ', undefined],
			[4, 4, -2, 'x', 'done-id'],
			[5, 5, -2, undefined, undefined],
			[6, 6, 5, undefined, undefined],
			[7, 7, 6, undefined, undefined],
			[9, 9, 5, '/', undefined],
			[11, 11, -11, undefined, undefined],
		]);
	});

	it('gives a root item of a list on line 0 a negative parent', () => {
		const { metadata } = extractMetadata(lines('- a', '- b'));
		expect(metadata.listItems?.map((item) => item.parent)).toEqual([-1, -1]);
	});
});

describe('parsePage', () => {
	const resolver = createLinkResolver([
		'People/Pedram Amini.md',
		'Notes/Other.md',
		'Notes/Source.md',
	]);
	const stat = { ctime: Date.UTC(2026, 8, 1), mtime: Date.UTC(2026, 8, 2), size: 10 };

	it('resolves links through the resolver and keeps unresolved ones as written', () => {
		const page = parsePage(
			{
				path: 'Notes/Source.md',
				content: lines(
					'---',
					'Connection: "[[Pedram Amini]]"',
					'---',
					'See [[Pedram Amini|Pedram]], [[Missing]], [o](Other.md).'
				),
				...stat,
			},
			resolver
		);
		expect(page.links.map((l) => l.path)).toEqual([
			'People/Pedram Amini.md',
			'People/Pedram Amini.md',
			'Missing',
			'Notes/Other.md',
		]);
		const connection = page.fields.get('Connection');
		expect(connection).toBeInstanceOf(Link);
		expect((connection as Link).path).toBe('People/Pedram Amini.md');
	});

	it('normalizes CRLF and reports warnings through onWarning without throwing', () => {
		const warnings: PageParseWarning[] = [];
		const page = parsePage(
			{ path: 'Notes/Source.md', content: '---\r\nbad: [x\r\n---\r\nKey:: value\r\n', ...stat },
			resolver,
			{ onWarning: (warning) => warnings.push(warning) }
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ path: 'Notes/Source.md', line: 1 });
		expect(page.frontmatter).toEqual({});
		expect(page.fields.get('Key')).toBe('value');
	});
});
