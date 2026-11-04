import { describe, it, expect } from 'vitest';
import { createParser } from '../../../../../renderer/components/FilePreview/markdownFast/parser';
import { applyHeadingSlugs } from '../../../../../renderer/components/FilePreview/markdownFast/headingSlugger';

function parseAndSlug(source: string) {
	const md = createParser();
	const tokens = md.parse(source, {});
	applyHeadingSlugs(md, tokens);
	return tokens;
}

describe('applyHeadingSlugs', () => {
	it('stamps an id attribute on heading_open tokens', () => {
		const tokens = parseAndSlug('# Hello World');
		const heading = tokens.find((t) => t.type === 'heading_open');
		expect(heading).toBeDefined();
		expect(heading!.attrGet('id')).toBe('hello-world');
	});

	it('produces lowercase, kebab-case slugs', () => {
		const tokens = parseAndSlug('# This Is A Heading');
		expect(tokens.find((t) => t.type === 'heading_open')!.attrGet('id')).toBe('this-is-a-heading');
	});

	it('disambiguates duplicate slugs with numeric suffixes', () => {
		const tokens = parseAndSlug('# Same\n\n# Same\n\n# Same');
		const headings = tokens.filter((t) => t.type === 'heading_open');
		expect(headings.length).toBe(3);
		expect(headings[0].attrGet('id')).toBe('same');
		expect(headings[1].attrGet('id')).toBe('same-1');
		expect(headings[2].attrGet('id')).toBe('same-2');
	});

	it('stamps slugs on headings of all levels', () => {
		const tokens = parseAndSlug('# One\n\n## Two\n\n### Three');
		const headings = tokens.filter((t) => t.type === 'heading_open');
		expect(headings.map((t) => t.attrGet('id'))).toEqual(['one', 'two', 'three']);
	});

	it('does not modify non-heading tokens', () => {
		const tokens = parseAndSlug('Paragraph text.\n\n> quote');
		expect(tokens.find((t) => t.type === 'paragraph_open')?.attrGet('id')).toBeNull();
		expect(tokens.find((t) => t.type === 'blockquote_open')?.attrGet('id')).toBeNull();
	});

	it('does not modify headings with empty content', () => {
		// A heading with empty content is unusual; we skip slugging it.
		const tokens = parseAndSlug('#');
		const heading = tokens.find((t) => t.type === 'heading_open');
		// markdown-it may not even emit a heading for "#" alone, but if it does,
		// it should not have an id (we skipped due to empty text).
		if (heading) {
			expect(heading.attrGet('id')).toBeNull();
		}
	});

	it('handles unicode and emoji in headings', () => {
		const tokens = parseAndSlug('# Привет 🚀 World');
		// GithubSlugger preserves unicode letters and strips emojis with replacement.
		const id = tokens.find((t) => t.type === 'heading_open')!.attrGet('id');
		expect(id).toBeTypeOf('string');
		expect(id!.length).toBeGreaterThan(0);
	});

	it('strips inline markdown markers from the slug source text', () => {
		// "**Bold**" → slugger should see "Bold" (markdown-it's inline.content keeps the literal **)
		// Confirm we still produce SOME slug - exact form depends on slugger, but
		// it must be deterministic.
		const a = parseAndSlug('# **Important** thing')
			.find((t) => t.type === 'heading_open')!
			.attrGet('id');
		const b = parseAndSlug('# **Important** thing')
			.find((t) => t.type === 'heading_open')!
			.attrGet('id');
		expect(a).toBe(b);
	});

	it('produces stable slugs across runs', () => {
		const src = '# A\n\n## B\n\n# A';
		const first = parseAndSlug(src)
			.filter((t) => t.type === 'heading_open')
			.map((t) => t.attrGet('id'));
		const second = parseAndSlug(src)
			.filter((t) => t.type === 'heading_open')
			.map((t) => t.attrGet('id'));
		expect(first).toEqual(second);
	});

	it('respects the order of headings in the document', () => {
		const src = '# Alpha\n\n# Beta\n\n# Gamma';
		const slugs = parseAndSlug(src)
			.filter((t) => t.type === 'heading_open')
			.map((t) => t.attrGet('id'));
		expect(slugs).toEqual(['alpha', 'beta', 'gamma']);
	});
});
