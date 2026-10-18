import { describe, expect, it } from 'vitest';
import { isAllowedRequestOrigin } from '../../../main/web-server/originPolicy';

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
		expect(isAllowedRequestOrigin({ origin: 'https://evil.example', host: '127.0.0.1:8080' })).toBe(
			false
		);
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
