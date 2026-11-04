import { describe, it, expect } from 'vitest';
import { sanitizeBlock } from '../../../../../renderer/components/FilePreview/markdownFast/sanitize';

describe('sanitizeBlock', () => {
	it('passes safe HTML through unchanged', () => {
		const out = sanitizeBlock('<p>hello <strong>world</strong></p>');
		expect(out).toBe('<p>hello <strong>world</strong></p>');
	});

	it('strips <script> tags', () => {
		const out = sanitizeBlock('<p>x</p><script>alert(1)</script>');
		expect(out).not.toContain('<script');
		expect(out).not.toContain('alert');
		expect(out).toContain('<p>x</p>');
	});

	it('strips inline event handlers', () => {
		const out = sanitizeBlock('<a href="https://example.com" onclick="alert(1)">click</a>');
		expect(out).not.toContain('onclick');
		expect(out).toContain('href="https://example.com"');
	});

	it('strips javascript: URLs', () => {
		const out = sanitizeBlock('<a href="javascript:alert(1)">x</a>');
		expect(out).not.toContain('javascript:');
	});

	it('preserves http(s) URLs', () => {
		expect(sanitizeBlock('<a href="https://example.com">x</a>')).toContain(
			'href="https://example.com"'
		);
		expect(sanitizeBlock('<a href="http://example.com">x</a>')).toContain(
			'href="http://example.com"'
		);
	});

	it('preserves the maestro-file:// protocol', () => {
		const out = sanitizeBlock('<a href="maestro-file://path/to/file.md">x</a>');
		expect(out).toContain('href="maestro-file://path/to/file.md"');
	});

	it('preserves the maestro:// deep link protocol', () => {
		const out = sanitizeBlock('<a href="maestro://session/abc/tab/xyz">x</a>');
		expect(out).toContain('href="maestro://session/abc/tab/xyz"');
	});

	it('preserves mailto: and tel: URIs', () => {
		expect(sanitizeBlock('<a href="mailto:a@b.com">x</a>')).toContain('mailto:a@b.com');
		expect(sanitizeBlock('<a href="tel:+1234">x</a>')).toContain('tel:+1234');
	});

	it('preserves data-maestro-file data attributes', () => {
		const out = sanitizeBlock('<a data-maestro-file="docs/readme.md">link</a>');
		expect(out).toContain('data-maestro-file="docs/readme.md"');
	});

	it('preserves data-maestro-image data attributes', () => {
		const out = sanitizeBlock('<img data-maestro-image="path.png" src="path.png" alt="x">');
		expect(out).toContain('data-maestro-image="path.png"');
	});

	it('preserves target attributes on anchors', () => {
		const out = sanitizeBlock('<a href="https://example.com" target="_blank">x</a>');
		expect(out).toContain('target="_blank"');
	});

	it('preserves GFM-style tables', () => {
		const html = '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>';
		const out = sanitizeBlock(html);
		expect(out).toContain('<table>');
		expect(out).toContain('<th>a</th>');
		expect(out).toContain('<td>1</td>');
	});

	it('preserves code blocks with language classes', () => {
		const out = sanitizeBlock('<pre><code class="language-ts">x</code></pre>');
		expect(out).toContain('<pre>');
		expect(out).toContain('class="language-ts"');
	});

	it('strips <iframe> tags', () => {
		const out = sanitizeBlock('<p>x</p><iframe src="https://evil.com"></iframe>');
		expect(out).not.toContain('<iframe');
	});

	it('strips <object> and <embed> tags', () => {
		expect(sanitizeBlock('<object data="x"></object>')).not.toContain('<object');
		expect(sanitizeBlock('<embed src="x">')).not.toContain('<embed');
	});

	it('strips <form> + <input> combos but leaves benign content', () => {
		const out = sanitizeBlock('<form><input name="x"></form><p>safe</p>');
		expect(out).toContain('<p>safe</p>');
		expect(out).not.toContain('<form');
		expect(out).not.toContain('<input');
	});

	it('strips <button>, <select>, <textarea> (phishing-surface tags)', () => {
		expect(sanitizeBlock('<button>x</button>')).not.toContain('<button');
		expect(sanitizeBlock('<select><option>y</option></select>')).not.toContain('<select');
		expect(sanitizeBlock('<textarea>z</textarea>')).not.toContain('<textarea');
	});

	it('handles empty input', () => {
		expect(sanitizeBlock('')).toBe('');
	});

	it('handles malformed HTML without throwing', () => {
		expect(() => sanitizeBlock('<p>unterminated <strong>')).not.toThrow();
	});

	it('is idempotent - sanitizing already-clean HTML twice yields the same result', () => {
		const first = sanitizeBlock('<p>hello <a href="https://example.com">x</a></p>');
		const second = sanitizeBlock(first);
		expect(second).toBe(first);
	});
});
