import { describe, it, expect } from 'vitest';
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
