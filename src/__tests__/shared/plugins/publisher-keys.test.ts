import { describe, it, expect } from 'vitest';
import { createPublicKey } from 'crypto';
import { MAESTRO_PUBLISHER_KEYS, resolveTrustedKeys } from '../../../shared/plugins/publisher-keys';

describe('MAESTRO_PUBLISHER_KEYS', () => {
	it('bakes only well-formed base64 SPKI public keys as the trust anchor', () => {
		// The anchor must stay populated: an accidental future emptying would
		// silently revert to pre-A1 behavior (no bundled plugin ever seeds).
		expect(MAESTRO_PUBLISHER_KEYS.length).toBeGreaterThan(0);
		// Proves every anchor entry is a non-empty, valid SPKI key crypto can
		// load - never hard-coding the real key value here.
		for (const key of MAESTRO_PUBLISHER_KEYS) {
			expect(typeof key).toBe('string');
			expect(key.trim().length).toBeGreaterThan(0);
			// Node decodes base64 leniently (padding/whitespace/url-safe), so a
			// baked string that is not canonical could still load. Round-trip the
			// DER bytes back to base64 and require an exact match to reject any
			// non-canonical anchor.
			const der = Buffer.from(key, 'base64');
			expect(der.toString('base64')).toBe(key);
			const publicKey = createPublicKey({
				key: der,
				format: 'der',
				type: 'spki',
			});
			// The plugin signing scheme is ed25519 (SIGNATURE_ALGORITHM), so the
			// anchor must be an ed25519 public key, not merely any valid SPKI key.
			expect(publicKey.asymmetricKeyType).toBe('ed25519');
		}
	});
});

describe('resolveTrustedKeys', () => {
	it('unions the built-in publisher anchor with user keys, trimmed and de-duplicated', () => {
		expect(resolveTrustedKeys(['userA', '  userB  ', 'userA', ''])).toEqual([
			...MAESTRO_PUBLISHER_KEYS,
			'userA',
			'userB',
		]);
	});

	it('returns just the anchor when there are no user keys', () => {
		expect(resolveTrustedKeys([])).toEqual([...MAESTRO_PUBLISHER_KEYS]);
	});

	it('drops blank and whitespace-only user keys', () => {
		expect(resolveTrustedKeys(['', '   '])).toEqual([...MAESTRO_PUBLISHER_KEYS]);
	});
});
