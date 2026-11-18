/**
 * Federation is opportunistic: an SSH remote takes part unless it opted out, and only the opt-out
 * is ever stored.
 */

import { describe, expect, it } from 'vitest';
import { federationFieldFor, isFederationRemote } from '../../shared/federationRemote';

describe('federationRemote', () => {
	it('takes part unless the remote opted out', () => {
		expect(isFederationRemote({})).toBe(true);
		expect(isFederationRemote({ federation: true })).toBe(true);
		expect(isFederationRemote({ federation: false })).toBe(false);
	});

	it('stores nothing for on and false for off', () => {
		expect(federationFieldFor(true)).toBeUndefined();
		expect(federationFieldFor(false)).toBe(false);
	});
});
