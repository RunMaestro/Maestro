/**
 * Tests for `withCspMetaTag()` (src/shared/cspMeta.ts): the CSP meta tag isolated-guest hosts put first in
 * a served document's head, made when the document has none.
 */

import { describe, expect, it } from 'vitest';
import { withCspMetaTag } from '../../shared/cspMeta';

const CSP = "default-src 'none'; script-src 'unsafe-inline'";
const META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;

describe('withCspMetaTag', () => {
	it('puts the tag first in an existing head, before anything that could run', () => {
		const out = withCspMetaTag('<html><head lang="en"><script>x()</script></head></html>', CSP);
		expect(out).toBe(`<html><head lang="en">${META}<script>x()</script></head></html>`);
	});

	it('makes a head for a document without one', () => {
		expect(withCspMetaTag('<html><body>hi</body></html>', CSP)).toBe(
			`<html><head>${META}</head><body>hi</body></html>`
		);
	});

	it('prefixes a fragment', () => {
		expect(withCspMetaTag('hi', CSP)).toBe(`${META}hi`);
	});

	it('escapes quotes and ampersands, so a policy can never close the attribute', () => {
		const out = withCspMetaTag('<head></head>', 'default-src "x" &');
		expect(out).toContain('content="default-src &quot;x&quot; &amp;"');
	});
});
