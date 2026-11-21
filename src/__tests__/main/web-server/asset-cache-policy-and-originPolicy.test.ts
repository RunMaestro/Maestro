// Source: src/__tests__/main/web-server/asset-cache-policy.test.ts
// Source: src/__tests__/main/web-server/originPolicy.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import path from 'path';
import { IMMUTABLE_ASSET_CACHE_CONTROL } from '../../../main/web-server/asset-cache-policy';
import { isContentHashedAsset } from '../../../main/web-server/asset-cache-policy';
import { isAllowedRequestOrigin } from '../../../main/web-server/originPolicy';
describeSourceSuite('asset-cache-policy', () => {
	const root = path.join(path.sep, 'bundle', 'web-desktop', 'assets');
	const at = (...parts: string[]) => path.join(root, ...parts);

	describe('isContentHashedAsset', () => {
		it('accepts the names Vite emits at the top of assets/', () => {
			expect(isContentHashedAsset(root, at('main-BOEbwE3b.js'))).toBe(true);
			expect(isContentHashedAsset(root, at('main-Cq2Yd8xP.css'))).toBe(true);
			// Hashes are base64url, so they can end in `-` or contain `_`.
			expect(isContentHashedAsset(root, at('material-theme-ocean-DKjK2GC-.js'))).toBe(true);
			expect(isContentHashedAsset(root, at('KaTeX_Math-Italic-flOr_0UB.ttf'))).toBe(true);
			expect(isContentHashedAsset(root, at('main-BOEbwE3b.js.map'))).toBe(true);
		});

		it('keeps the unhashed fonts folder revalidating', () => {
			// The bundled-fonts plugin copies these in under stable names, so a font
			// replaced in place would be served stale for a year if marked immutable.
			expect(isContentHashedAsset(root, at('fonts', 'inter-latin-400_700-1.woff2'))).toBe(false);
			expect(isContentHashedAsset(root, at('fonts', 'sub-BOEbwE3b.woff2'))).toBe(false);
		});

		it('rejects names without a hash suffix', () => {
			expect(isContentHashedAsset(root, at('main.js'))).toBe(false);
			expect(isContentHashedAsset(root, at('roboto-latin-400_700-1.woff2'))).toBe(false);
			expect(isContentHashedAsset(root, at('vendor-short.js'))).toBe(false);
		});

		it('rejects anything outside the assets root', () => {
			expect(isContentHashedAsset(root, path.join(root, '..', 'index-BOEbwE3b.js'))).toBe(false);
			expect(isContentHashedAsset(root, root)).toBe(false);
		});

		it('marks hashed files immutable for a year', () => {
			expect(IMMUTABLE_ASSET_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
		});
	});
});
describeSourceSuite('originPolicy', () => {
	describe('isAllowedRequestOrigin', () => {
		it('allows requests with no Origin header', () => {
			expect(isAllowedRequestOrigin({ origin: undefined, host: '127.0.0.1:8080' })).toBe(true);
			expect(isAllowedRequestOrigin({ origin: '', host: '127.0.0.1:8080' })).toBe(true);
		});

		it('allows an Origin matching the Host header, ignoring case and whitespace', () => {
			expect(
				isAllowedRequestOrigin({ origin: 'http://192.168.1.5:27263', host: '192.168.1.5:27263' })
			).toBe(true);
			expect(
				isAllowedRequestOrigin({ origin: 'http://MyMac.local:8080', host: ' mymac.local:8080 ' })
			).toBe(true);
			expect(
				isAllowedRequestOrigin({
					origin: 'https://abc.trycloudflare.com',
					host: 'abc.trycloudflare.com',
				})
			).toBe(true);
		});

		it('refuses an Origin on a different host or port', () => {
			expect(
				isAllowedRequestOrigin({ origin: 'https://evil.example', host: '127.0.0.1:8080' })
			).toBe(false);
			expect(
				isAllowedRequestOrigin({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:8080' })
			).toBe(false);
		});

		it('refuses an Origin when the Host header is missing and nothing is trusted', () => {
			expect(isAllowedRequestOrigin({ origin: 'http://127.0.0.1:8080', host: undefined })).toBe(
				false
			);
		});

		it('refuses the opaque "null" origin, malformed origins, and non-http schemes', () => {
			expect(isAllowedRequestOrigin({ origin: 'null', host: '127.0.0.1:8080' })).toBe(false);
			expect(isAllowedRequestOrigin({ origin: 'not a url', host: '127.0.0.1:8080' })).toBe(false);
			expect(isAllowedRequestOrigin({ origin: 'chrome-extension://abcdef', host: 'abcdef' })).toBe(
				false
			);
		});

		it('refuses repeated Origin headers', () => {
			expect(
				isAllowedRequestOrigin({
					origin: ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
					host: '127.0.0.1:8080',
				})
			).toBe(false);
		});

		it('allows a trusted origin, compared by exact origin', () => {
			const trustedOrigins = ['https://abc-def.trycloudflare.com/some/path'];
			expect(
				isAllowedRequestOrigin({
					origin: 'https://abc-def.trycloudflare.com',
					host: '127.0.0.1:8080',
					trustedOrigins,
				})
			).toBe(true);
			expect(
				isAllowedRequestOrigin({
					origin: 'http://abc-def.trycloudflare.com',
					host: '127.0.0.1:8080',
					trustedOrigins,
				})
			).toBe(false);
			expect(
				isAllowedRequestOrigin({
					origin: 'https://evil.trycloudflare.com',
					host: '127.0.0.1:8080',
					trustedOrigins,
				})
			).toBe(false);
		});
	});
});
