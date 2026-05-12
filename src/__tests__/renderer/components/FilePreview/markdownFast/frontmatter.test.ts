import { describe, it, expect } from 'vitest';
import {
	parseYamlKeyValues,
	renderFrontmatterHtml,
	splitFrontmatter,
} from '../../../../../renderer/components/FilePreview/markdownFast/frontmatter';

describe('parseYamlKeyValues', () => {
	it('returns an empty array for empty input', () => {
		expect(parseYamlKeyValues('')).toEqual([]);
	});

	it('parses simple key/value pairs', () => {
		expect(parseYamlKeyValues('title: Hello\nauthor: Ada')).toEqual([
			{ key: 'title', value: 'Hello' },
			{ key: 'author', value: 'Ada' },
		]);
	});

	it('trims surrounding whitespace from keys and values', () => {
		expect(parseYamlKeyValues('  title  :   Hello World  ')).toEqual([
			{ key: 'title', value: 'Hello World' },
		]);
	});

	it('strips matching double quotes from values', () => {
		expect(parseYamlKeyValues('title: "Quoted"')).toEqual([{ key: 'title', value: 'Quoted' }]);
	});

	it('strips matching single quotes from values', () => {
		expect(parseYamlKeyValues("title: 'Quoted'")).toEqual([{ key: 'title', value: 'Quoted' }]);
	});

	it('does not strip mismatched quotes', () => {
		expect(parseYamlKeyValues(`title: "Quoted'`)).toEqual([{ key: 'title', value: `"Quoted'` }]);
	});

	it('skips blank lines', () => {
		expect(parseYamlKeyValues('\ntitle: Hello\n\nauthor: Ada\n')).toEqual([
			{ key: 'title', value: 'Hello' },
			{ key: 'author', value: 'Ada' },
		]);
	});

	it('skips comment lines starting with #', () => {
		expect(parseYamlKeyValues('# top comment\ntitle: Hello\n# inline')).toEqual([
			{ key: 'title', value: 'Hello' },
		]);
	});

	it('skips lines without a colon', () => {
		expect(parseYamlKeyValues('orphan-line\ntitle: Hello')).toEqual([
			{ key: 'title', value: 'Hello' },
		]);
	});

	it('skips lines whose colon appears in position zero (no key)', () => {
		expect(parseYamlKeyValues(': no-key\ntitle: Hello')).toEqual([
			{ key: 'title', value: 'Hello' },
		]);
	});

	it('preserves colons inside values', () => {
		expect(parseYamlKeyValues('url: https://example.com')).toEqual([
			{ key: 'url', value: 'https://example.com' },
		]);
	});

	it('preserves whitespace inside quoted values', () => {
		expect(parseYamlKeyValues('title: "  spaced  "')).toEqual([
			{ key: 'title', value: '  spaced  ' },
		]);
	});
});

describe('renderFrontmatterHtml', () => {
	it('returns null for empty entries', () => {
		expect(renderFrontmatterHtml([])).toBeNull();
	});

	it('renders a Document metadata header + table', () => {
		const html = renderFrontmatterHtml([{ key: 'title', value: 'Hello' }]);
		expect(html).toContain('<p><em>Document metadata:</em></p>');
		expect(html).toContain('<table>');
		expect(html).toContain('<tr>');
		expect(html).toContain('<strong>title</strong>');
		expect(html).toContain('Hello');
	});

	it('escapes user-supplied keys and values', () => {
		const html = renderFrontmatterHtml([{ key: '<key>', value: '<script>alert(1)</script>' }])!;
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;key&gt;');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
	});

	it('renders URL values as anchor tags', () => {
		const html = renderFrontmatterHtml([{ key: 'home', value: 'https://example.com/page' }])!;
		expect(html).toContain('<a href="https://example.com/page"');
		expect(html).toContain('https://example.com/page</a>');
	});

	it('truncates long URLs for display but keeps full URL in href + title', () => {
		const long = 'https://example.com/' + 'a'.repeat(80);
		const html = renderFrontmatterHtml([{ key: 'home', value: long }])!;
		expect(html).toContain(`href="${long}"`);
		expect(html).toContain(`title="${long}"`);
		// Display text should be truncated to 50 chars (47 + '...')
		const displayMatch = html.match(/>([^<]+)<\/a>/);
		expect(displayMatch).not.toBeNull();
		expect(displayMatch![1].length).toBe(50);
		expect(displayMatch![1].endsWith('...')).toBe(true);
	});

	it('renders non-URL values as plain text, not links', () => {
		const html = renderFrontmatterHtml([{ key: 'title', value: 'My Doc' }])!;
		expect(html).not.toContain('<a ');
		expect(html).toContain('My Doc');
	});

	it('escapes special characters in URL display text', () => {
		// URLs with raw HTML chars shouldn't be common, but we still escape them
		const html = renderFrontmatterHtml([{ key: 'k', value: 'https://example.com/<x>' }])!;
		expect(html).toContain('&lt;x&gt;');
	});

	it('renders each entry as its own table row', () => {
		const html = renderFrontmatterHtml([
			{ key: 'a', value: '1' },
			{ key: 'b', value: '2' },
			{ key: 'c', value: '3' },
		])!;
		expect((html.match(/<tr>/g) || []).length).toBe(3);
	});
});

describe('splitFrontmatter', () => {
	it('returns null frontmatter and full body when no frontmatter is present', () => {
		expect(splitFrontmatter('# Title\n\nbody')).toEqual({
			frontmatterHtml: null,
			body: '# Title\n\nbody',
		});
	});

	it('strips frontmatter from the body when present', () => {
		const result = splitFrontmatter('---\ntitle: Hello\n---\n# Body');
		expect(result.body).toBe('# Body');
		expect(result.frontmatterHtml).toContain('<strong>title</strong>');
		expect(result.frontmatterHtml).toContain('Hello');
	});

	it('handles CRLF line endings', () => {
		const result = splitFrontmatter('---\r\ntitle: Hello\r\n---\r\n# Body');
		expect(result.body).toBe('# Body');
		expect(result.frontmatterHtml).toContain('Hello');
	});

	it('only strips frontmatter at the very start of the document', () => {
		// Frontmatter only counts when at position 0
		const result = splitFrontmatter('# Heading\n---\ntitle: x\n---\nbody');
		expect(result.frontmatterHtml).toBeNull();
		expect(result.body).toBe('# Heading\n---\ntitle: x\n---\nbody');
	});

	it('returns null frontmatter when the YAML block is empty', () => {
		const result = splitFrontmatter('---\n\n---\nbody');
		// Empty entries → renderFrontmatterHtml returns null
		expect(result.frontmatterHtml).toBeNull();
		expect(result.body).toBe('body');
	});

	it('does not consume trailing whitespace after the closing fence', () => {
		const result = splitFrontmatter('---\ntitle: x\n---\n  body  ');
		expect(result.body).toBe('  body  ');
	});

	it('handles documents that are just frontmatter with no body', () => {
		const result = splitFrontmatter('---\ntitle: x\n---\n');
		expect(result.body).toBe('');
		expect(result.frontmatterHtml).toContain('title');
	});
});
