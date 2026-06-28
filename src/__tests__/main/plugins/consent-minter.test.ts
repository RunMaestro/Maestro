/**
 * @file consent-minter.test.ts
 * @description Tests for the consent-nonce registry — the anti-forgery core of
 * the isolated authorization minter. A mint may only proceed with a live,
 * main-issued, one-time nonce bound to the exact plugin, approving a subset of
 * the offered capabilities.
 */

import { describe, it, expect } from 'vitest';
import { ConsentNonceRegistry } from '../../../main/plugins/consent-minter';

function reg(now: { t: number }, seq = { n: 0 }, ttlMs = 1000): ConsentNonceRegistry {
	return new ConsentNonceRegistry({
		now: () => now.t,
		newNonce: () => `nonce-${++seq.n}`,
		ttlMs,
	});
}

describe('ConsentNonceRegistry', () => {
	it('accepts a live nonce for the right plugin approving a subset of offered caps', () => {
		const now = { t: 0 };
		const r = reg(now);
		const nonce = r.issue('p', ['fs:read', 'net:fetch', 'ui:contribute']);
		expect(r.consume(nonce, 'p', ['fs:read', 'ui:contribute'])).toBe(true);
	});

	it('accepts approving the exact offered set', () => {
		const now = { t: 0 };
		const r = reg(now);
		const nonce = r.issue('p', ['fs:read']);
		expect(r.consume(nonce, 'p', ['fs:read'])).toBe(true);
	});

	it('is one-time: a nonce cannot be replayed', () => {
		const now = { t: 0 };
		const r = reg(now);
		const nonce = r.issue('p', ['fs:read']);
		expect(r.consume(nonce, 'p', ['fs:read'])).toBe(true);
		expect(r.consume(nonce, 'p', ['fs:read'])).toBe(false); // replay rejected
	});

	it('rejects an unknown / forged nonce', () => {
		const now = { t: 0 };
		const r = reg(now);
		expect(r.consume('forged', 'p', ['fs:read'])).toBe(false);
	});

	it('rejects a nonce minted for a different plugin', () => {
		const now = { t: 0 };
		const r = reg(now);
		const nonce = r.issue('p', ['fs:read']);
		expect(r.consume(nonce, 'other', ['fs:read'])).toBe(false);
	});

	it('rejects approving a capability that was never offered (no widening)', () => {
		const now = { t: 0 };
		const r = reg(now);
		const nonce = r.issue('p', ['fs:read']);
		expect(r.consume(nonce, 'p', ['fs:read', 'fs:write'])).toBe(false);
	});

	it('rejects an expired nonce', () => {
		const now = { t: 0 };
		const r = reg(now, { n: 0 }, 1000);
		const nonce = r.issue('p', ['fs:read']);
		now.t = 1001; // past ttl
		expect(r.consume(nonce, 'p', ['fs:read'])).toBe(false);
	});

	it('a failed consume still burns the nonce (no retry on a presented nonce)', () => {
		const now = { t: 0 };
		const r = reg(now);
		const nonce = r.issue('p', ['fs:read']);
		expect(r.consume(nonce, 'p', ['fs:write'])).toBe(false); // not offered
		expect(r.consume(nonce, 'p', ['fs:read'])).toBe(false); // already burned
	});

	it('prunes expired nonces on issue', () => {
		const now = { t: 0 };
		const r = reg(now, { n: 0 }, 1000);
		r.issue('p', ['fs:read']);
		expect(r.outstanding()).toBe(1);
		now.t = 2000;
		r.issue('q', ['fs:read']); // triggers prune of the expired first ticket
		expect(r.outstanding()).toBe(1);
	});
});
