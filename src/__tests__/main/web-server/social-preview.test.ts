/**
 * Tests for the web-desktop social preview tags.
 *
 * The failure this guards against is silent by construction: a link preview is
 * rendered by a chat client nobody here controls, so a card that points at the
 * wrong origin, or that leaks the security token into an image URL, looks
 * exactly like a working one from inside the app.
 */

import { describe, it, expect } from 'vitest';
import {
	OG_IMAGE_ROUTE,
	OG_IMAGE_WIDTH,
	OG_IMAGE_HEIGHT,
	SOCIAL_TITLE,
	SOCIAL_DESCRIPTION,
	buildSocialPreviewTags,
	resolveRequestOrigin,
} from '../../../main/web-server/social-preview';

describe('resolveRequestOrigin', () => {
	it('builds an http origin from the Host header', () => {
		expect(resolveRequestOrigin({ host: '192.168.1.39:8420' })).toBe('http://192.168.1.39:8420');
	});

	it('returns null when there is no host to name', () => {
		// A card built on a guessed host sends every crawler somewhere other than
		// the address actually being shared, so no card is the better outcome.
		expect(resolveRequestOrigin({})).toBeNull();
		expect(resolveRequestOrigin({ host: '   ' })).toBeNull();
		expect(resolveRequestOrigin({ host: 42 })).toBeNull();
	});

	it('returns null rather than throwing when there are no headers at all', () => {
		expect(resolveRequestOrigin(undefined)).toBeNull();
		expect(resolveRequestOrigin(null)).toBeNull();
	});

	it('honours x-forwarded-proto so a tunnelled page gets an https image URL', () => {
		// The server only ever speaks HTTP. Behind Tailscale Serve or cloudflared
		// the page is https, and an http image on an https page is blocked as
		// mixed content - the card renders with a hole where the image should be.
		expect(resolveRequestOrigin({ host: 'box.ts.net', 'x-forwarded-proto': 'https' })).toBe(
			'https://box.ts.net'
		);
	});

	it('takes the first entry of a proxy chain', () => {
		expect(resolveRequestOrigin({ host: 'box.ts.net', 'x-forwarded-proto': 'https, http' })).toBe(
			'https://box.ts.net'
		);
	});

	it('prefers x-forwarded-host over host', () => {
		// Behind a proxy, Host is the internal address the proxy dialled; the
		// public name the link was shared as is the forwarded one.
		expect(resolveRequestOrigin({ host: '127.0.0.1:8420', 'x-forwarded-host': 'box.ts.net' })).toBe(
			'http://box.ts.net'
		);
	});

	it('refuses a scheme a browser would not follow', () => {
		// The header is caller-controlled, so anything that is not http/https is
		// not passed through into a URL we emit.
		expect(resolveRequestOrigin({ host: 'box', 'x-forwarded-proto': 'javascript' })).toBe(
			'http://box'
		);
	});

	it('accepts a header array, as a proxy may produce', () => {
		expect(
			resolveRequestOrigin({ host: ['192.168.1.39:8420'], 'x-forwarded-proto': ['https'] })
		).toBe('https://192.168.1.39:8420');
	});
});

describe('buildSocialPreviewTags', () => {
	const origin = 'http://192.168.1.39:8420';
	const tags = buildSocialPreviewTags(origin);

	it('names the product without a build qualifier', () => {
		// "Maestro (Web Desktop)" named the bundle rather than the product, and
		// that parenthetical was the headline of every shared link.
		expect(SOCIAL_TITLE).toBe('Maestro');
		expect(tags).toContain('<meta property="og:title" content="Maestro" />');
		expect(tags).not.toContain('Web Desktop');
	});

	it('points og:image at an absolute URL', () => {
		// A crawler resolves og:image against nothing, so a relative path is
		// dropped and the card silently falls back to no image at all.
		expect(tags).toContain(`<meta property="og:image" content="${origin}${OG_IMAGE_ROUTE}" />`);
		expect(tags).toContain(`<meta property="og:url" content="${origin}" />`);
	});

	it('declares the image dimensions so a client can lay out before the fetch', () => {
		expect(tags).toContain(`<meta property="og:image:width" content="${OG_IMAGE_WIDTH}" />`);
		expect(tags).toContain(`<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}" />`);
	});

	it('asks for the large card rather than a thumbnail', () => {
		// summary_large_image is the difference between a designed card and a
		// favicon sitting next to a line of text.
		expect(tags).toContain('<meta name="twitter:card" content="summary_large_image" />');
	});

	it('carries the description in both vocabularies plus the plain one', () => {
		expect(tags).toContain(`<meta property="og:description" content="${SOCIAL_DESCRIPTION}" />`);
		expect(tags).toContain(`<meta name="twitter:description" content="${SOCIAL_DESCRIPTION}" />`);
		expect(tags).toContain(`<meta name="description" content="${SOCIAL_DESCRIPTION}" />`);
	});

	it('keeps the image URL outside the token prefix', () => {
		// Chat clients cache and re-host preview images. The card is a static
		// brand mark, so there is nothing to protect and no reason to hand the
		// security token to whatever caches it.
		expect(OG_IMAGE_ROUTE.startsWith('/')).toBe(true);
		expect(OG_IMAGE_ROUTE.split('/').filter(Boolean)).toHaveLength(1);
	});

	it('escapes a hostile origin instead of letting it close the attribute', () => {
		// The origin is derived from a caller-controlled header, so it reaches an
		// HTML attribute and must not be able to escape it.
		const hostile = buildSocialPreviewTags('http://a"><script>alert(1)</script><x y="');
		expect(hostile).not.toContain('<script>');
		expect(hostile).toContain('&quot;');
	});

	it('emits no session or agent data', () => {
		// A preview is generated by whichever device the message passes through,
		// so anything named here lands in a chat transcript and an image cache.
		expect(tags).not.toMatch(/session/i);
		expect(tags).not.toMatch(/token/i);
	});
});
