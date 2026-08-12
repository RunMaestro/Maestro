import { describe, it, expect } from 'vitest';
import { createParser } from '../../../../../renderer/components/FilePreview/markdownFast/parser';

describe('createParser', () => {
	it('returns a markdown-it instance', () => {
		const md = createParser();
		expect(typeof md.parse).toBe('function');
		expect(typeof md.render).toBe('function');
	});

	it('configures html: true so raw HTML passes through', () => {
		const md = createParser();
		const html = md.render('<span class="x">raw</span>');
		expect(html).toContain('<span class="x">raw</span>');
	});

	it('configures linkify: true so bare URLs become anchors', () => {
		const md = createParser();
		const html = md.render('see https://example.com for details');
		expect(html).toContain('<a href="https://example.com"');
	});

	it('configures breaks: false so single newlines are not <br>', () => {
		const md = createParser();
		const html = md.render('line one\nline two');
		// commonmark: single \n is just a space, not <br>
		expect(html).not.toContain('<br');
	});

	it('configures typographer: false so smart-quotes are not transformed', () => {
		const md = createParser();
		const html = md.render('"hello" -- world');
		// With typographer enabled markdown-it would emit curly quotes and an em dash
		expect(html).toContain('&quot;hello&quot;');
		expect(html).toContain('--');
		expect(html).not.toContain('\u2014');
	});

	it('returns fresh instances on each call (no shared state)', () => {
		const a = createParser();
		const b = createParser();
		expect(a).not.toBe(b);
	});

	it('parses a standard markdown document into a token array', () => {
		const md = createParser();
		const tokens = md.parse('# heading\n\nparagraph', {});
		expect(Array.isArray(tokens)).toBe(true);
		expect(tokens.length).toBeGreaterThan(0);
		expect(tokens.some((t) => t.type === 'heading_open')).toBe(true);
		expect(tokens.some((t) => t.type === 'paragraph_open')).toBe(true);
	});

	it('parses GFM-style tables', () => {
		const md = createParser();
		const html = md.render('| a | b |\n| - | - |\n| 1 | 2 |');
		expect(html).toContain('<table>');
		expect(html).toContain('<th>a</th>');
		expect(html).toContain('<td>1</td>');
	});

	it('parses fenced code blocks', () => {
		const md = createParser();
		const html = md.render('```js\nconst x = 1;\n```');
		expect(html).toContain('<pre>');
		expect(html).toContain('<code class="language-js">');
		expect(html).toContain('const x = 1;');
	});

	it('parses inline code', () => {
		const md = createParser();
		const html = md.render('use `npm test` here');
		expect(html).toContain('<code>npm test</code>');
	});

	it('parses task list checkboxes', () => {
		const md = createParser();
		// Plain markdown-it doesn't render checkboxes specially; they appear as
		// literal text inside list items. The Fast tier intentionally relies on
		// CSS to style these the same way the Rich path does.
		const html = md.render('- [x] done\n- [ ] todo');
		expect(html).toContain('<ul>');
		expect(html).toContain('<li>');
	});
});
