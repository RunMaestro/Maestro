/**
 * Tests for QR / pairing URL parsing.
 *
 * Covers both supported formats:
 *  1. `maestro://pair?host=&port=&code=` (pair-code flow, needs redemption)
 *  2. `http(s)://host:port/<uuid>` (web-link flow, token usable directly)
 */

import { parseQrPayload } from '../parseQrPayload';

// A realistic UUID v4 used by the desktop's web-server-factory.
const SAMPLE_TOKEN = '232aead9-b3f8-46b0-9c56-4e104498a97e';

describe('parseQrPayload', () => {
	describe('pair-code URLs', () => {
		describe('valid payloads', () => {
			it('parses a valid maestro://pair URL', () => {
				const result = parseQrPayload('maestro://pair?host=192.168.1.100&port=17170&code=ABC123');
				expect(result).toEqual({
					kind: 'pair-code',
					host: '192.168.1.100',
					port: 17170,
					code: 'ABC123',
				});
			});

			it('handles localhost as host', () => {
				const result = parseQrPayload('maestro://pair?host=localhost&port=8080&code=XYZ');
				expect(result).toEqual({
					kind: 'pair-code',
					host: 'localhost',
					port: 8080,
					code: 'XYZ',
				});
			});

			it('handles URL-encoded host values', () => {
				const result = parseQrPayload('maestro://pair?host=my-computer.local&port=3000&code=TEST');
				expect(result).toEqual({
					kind: 'pair-code',
					host: 'my-computer.local',
					port: 3000,
					code: 'TEST',
				});
			});

			it('handles IPv6 addresses', () => {
				const result = parseQrPayload('maestro://pair?host=%3A%3A1&port=17170&code=IPV6');
				expect(result).toEqual({
					kind: 'pair-code',
					host: '::1',
					port: 17170,
					code: 'IPV6',
				});
			});

			it('handles port 1', () => {
				const result = parseQrPayload('maestro://pair?host=localhost&port=1&code=MIN');
				expect(result).toEqual({
					kind: 'pair-code',
					host: 'localhost',
					port: 1,
					code: 'MIN',
				});
			});

			it('handles port 65535', () => {
				const result = parseQrPayload('maestro://pair?host=localhost&port=65535&code=MAX');
				expect(result).toEqual({
					kind: 'pair-code',
					host: 'localhost',
					port: 65535,
					code: 'MAX',
				});
			});
		});

		describe('missing parameters', () => {
			it('returns null when host is missing', () => {
				expect(parseQrPayload('maestro://pair?port=17170&code=ABC')).toBeNull();
			});

			it('returns null when port is missing', () => {
				expect(parseQrPayload('maestro://pair?host=localhost&code=ABC')).toBeNull();
			});

			it('returns null when code is missing', () => {
				expect(parseQrPayload('maestro://pair?host=localhost&port=17170')).toBeNull();
			});

			it('returns null when all parameters are missing', () => {
				expect(parseQrPayload('maestro://pair')).toBeNull();
			});

			it('returns null when only query string marker is present', () => {
				expect(parseQrPayload('maestro://pair?')).toBeNull();
			});
		});

		describe('invalid port values', () => {
			it('returns null for non-numeric port', () => {
				expect(parseQrPayload('maestro://pair?host=localhost&port=abc&code=X')).toBeNull();
			});

			it('returns null for port 0', () => {
				expect(parseQrPayload('maestro://pair?host=localhost&port=0&code=X')).toBeNull();
			});

			it('returns null for negative port', () => {
				expect(parseQrPayload('maestro://pair?host=localhost&port=-1&code=X')).toBeNull();
			});

			it('returns null for port > 65535', () => {
				expect(parseQrPayload('maestro://pair?host=localhost&port=65536&code=X')).toBeNull();
			});

			it('returns null for float port', () => {
				expect(parseQrPayload('maestro://pair?host=localhost&port=8080.5&code=X')).toBeNull();
			});
		});

		describe('whitespace-only code', () => {
			it('returns null for whitespace-only code', () => {
				expect(parseQrPayload('maestro://pair?host=localhost&port=8080&code=   ')).toBeNull();
			});
		});
	});

	describe('web-link URLs', () => {
		describe('valid payloads', () => {
			it('parses the persistent web link format', () => {
				const result = parseQrPayload(`http://192.168.1.6:61300/${SAMPLE_TOKEN}`);
				expect(result).toEqual({
					kind: 'web-link',
					host: '192.168.1.6',
					port: 61300,
					token: SAMPLE_TOKEN,
				});
			});

			it('accepts a trailing slash after the token', () => {
				const result = parseQrPayload(`http://192.168.1.6:61300/${SAMPLE_TOKEN}/`);
				expect(result).toEqual({
					kind: 'web-link',
					host: '192.168.1.6',
					port: 61300,
					token: SAMPLE_TOKEN,
				});
			});

			it('ignores a trailing path after the token', () => {
				const result = parseQrPayload(`http://192.168.1.6:61300/${SAMPLE_TOKEN}/sessions`);
				expect(result).toEqual({
					kind: 'web-link',
					host: '192.168.1.6',
					port: 61300,
					token: SAMPLE_TOKEN,
				});
			});

			it('accepts uppercase UUID tokens', () => {
				const upper = SAMPLE_TOKEN.toUpperCase();
				const result = parseQrPayload(`http://192.168.1.6:61300/${upper}`);
				expect(result).toEqual({
					kind: 'web-link',
					host: '192.168.1.6',
					port: 61300,
					token: upper,
				});
			});

			it('accepts https web links', () => {
				const result = parseQrPayload(`https://maestro.local:17170/${SAMPLE_TOKEN}`);
				expect(result).toEqual({
					kind: 'web-link',
					host: 'maestro.local',
					port: 17170,
					token: SAMPLE_TOKEN,
				});
			});

			it('trims surrounding whitespace before parsing', () => {
				const result = parseQrPayload(`  http://192.168.1.6:61300/${SAMPLE_TOKEN}  \n`);
				expect(result?.kind).toBe('web-link');
			});
		});

		describe('invalid payloads', () => {
			it('returns null when port is missing', () => {
				expect(parseQrPayload(`http://192.168.1.6/${SAMPLE_TOKEN}`)).toBeNull();
			});

			it('returns null when token is missing', () => {
				expect(parseQrPayload('http://192.168.1.6:61300/')).toBeNull();
			});

			it('returns null when path token is not a UUID', () => {
				expect(parseQrPayload('http://192.168.1.6:61300/not-a-uuid')).toBeNull();
			});

			it('returns null for an arbitrary http URL', () => {
				expect(parseQrPayload('http://example.com:8080/about')).toBeNull();
			});

			it('returns null for a UUID-v1 token (wrong version nibble)', () => {
				// v1 token: third group starts with 1 instead of 4
				expect(
					parseQrPayload('http://192.168.1.6:61300/232aead9-b3f8-16b0-9c56-4e104498a97e')
				).toBeNull();
			});
		});
	});

	describe('invalid URL schemes', () => {
		it('returns null for wrong scheme prefix', () => {
			expect(parseQrPayload('other://pair?host=localhost&port=8080&code=X')).toBeNull();
		});

		it('returns null for maestro:// without pair path', () => {
			expect(parseQrPayload('maestro://connect?host=localhost&port=8080&code=X')).toBeNull();
		});
	});

	describe('malformed inputs', () => {
		it('returns null for empty string', () => {
			expect(parseQrPayload('')).toBeNull();
		});

		it('returns null for null-ish input', () => {
			// @ts-expect-error - testing runtime behavior
			expect(parseQrPayload(null)).toBeNull();
			// @ts-expect-error - testing runtime behavior
			expect(parseQrPayload(undefined)).toBeNull();
		});

		it('returns null for plain text', () => {
			expect(parseQrPayload('hello world')).toBeNull();
		});

		it('returns null for whitespace-only input', () => {
			expect(parseQrPayload('   \n\t  ')).toBeNull();
		});

		it('returns null for malformed pair URL', () => {
			expect(parseQrPayload('maestro://pair?host=localhost&port=')).toBeNull();
		});
	});
});
