import { describe, it, expect } from 'vitest';
import { createPublicKey } from 'crypto';
import { MAESTRO_PUBLISHER_KEYS, resolveTrustedKeys } from '../../../shared/plugins/publisher-keys';

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

describe('MAESTRO_PUBLISHER_KEYS', () => {
	it('bakes only well-formed base64 SPKI public keys as the trust anchor', () => {
		// The anchor is populated with the release-signing public key. Prove every
		// entry is a non-empty, valid SPKI key crypto can load - never hard-coding
		// the real key value here.
		expect(MAESTRO_PUBLISHER_KEYS.length).toBeGreaterThan(0);
		for (const key of MAESTRO_PUBLISHER_KEYS) {
			expect(typeof key).toBe('string');
			expect(key.trim().length).toBeGreaterThan(0);
			expect(() =>
				createPublicKey({
					key: Buffer.from(key, 'base64'),
					format: 'der',
					type: 'spki',
				})
			).not.toThrow();
		}
	});
});
