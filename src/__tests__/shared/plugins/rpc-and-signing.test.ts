import { describe, it, expect } from 'vitest';
import { createPublicKey } from 'crypto';
import {
	HOST_METHOD_CAPABILITY,
	extractTarget,
	isHostMethod,
} from '../../../shared/plugins/rpc-protocol';
import {
	buildSigningPayload,
	validateSignatureManifest,
	normalizeRelPath,
	isTrustedKey,
} from '../../../shared/plugins/signing';
import { MAESTRO_PUBLISHER_KEYS, resolveTrustedKeys } from '../../../shared/plugins/publisher-keys';

describe('rpc-protocol', () => {
	it('maps every host method to a capability', () => {
		for (const method of Object.keys(HOST_METHOD_CAPABILITY)) {
			expect(isHostMethod(method)).toBe(true);
		}
	});

	it('extracts path targets for fs methods', () => {
		expect(extractTarget('fs.read', { path: '/a/b' })).toBe('/a/b');
		expect(extractTarget('fs.write', { path: '/a/b' })).toBe('/a/b');
		expect(extractTarget('fs.read', {})).toBeUndefined();
	});

	it('extracts the hostname for net.fetch', () => {
		expect(extractTarget('net.fetch', { url: 'https://api.example.com/x' })).toBe(
			'api.example.com'
		);
		expect(extractTarget('net.fetch', { url: 'not a url' })).toBeUndefined();
		expect(extractTarget('net.fetch', {})).toBeUndefined();
	});

	it('extracts allowlist targets for the Phase-4 act verbs (exact id/name, no parsing)', () => {
		expect(extractTarget('agents.dispatch', { agentId: 'x' })).toBe('x');
		expect(extractTarget('process.spawn', { command: 'echo-tool' })).toBe('echo-tool');
		expect(extractTarget('agents.dispatch', {})).toBeUndefined();
		expect(extractTarget('process.spawn', { command: 42 })).toBeUndefined();
	});

	it('returns undefined target for none-scope methods', () => {
		expect(extractTarget('notifications.toast', { message: 'hi' })).toBeUndefined();
		expect(extractTarget('agents.list', {})).toBeUndefined();
	});

	it('never throws on malformed params', () => {
		expect(extractTarget('fs.read', null)).toBeUndefined();
		expect(extractTarget('net.fetch', 42)).toBeUndefined();
	});
});

describe('signing payload', () => {
	it('is deterministic regardless of key order', () => {
		const a = buildSigningPayload({ 'b.js': 'aa', 'a.js': 'bb' });
		const b = buildSigningPayload({ 'a.js': 'bb', 'b.js': 'aa' });
		expect(a).toBe(b);
		expect(a).toBe('a.js:bb\nb.js:aa');
	});

	it('excludes the signature file itself', () => {
		const payload = buildSigningPayload({ 'plugin.json': 'aa', 'signature.json': 'ff' });
		expect(payload).toBe('plugin.json:aa');
	});

	it('normalizes windows separators and leading ./', () => {
		expect(normalizeRelPath('a\\b\\c.js')).toBe('a/b/c.js');
		expect(normalizeRelPath('./x.js')).toBe('x.js');
		const payload = buildSigningPayload({ 'a\\b.js': 'AA' });
		expect(payload).toBe('a/b.js:aa');
	});
});

describe('validateSignatureManifest', () => {
	const valid = {
		algorithm: 'ed25519',
		publicKey: 'cHVi',
		signature: 'c2ln',
		files: { 'plugin.json': 'a'.repeat(64) },
	};

	it('accepts a well-formed manifest', () => {
		const { manifest, errors } = validateSignatureManifest(valid);
		expect(errors).toEqual([]);
		expect(manifest?.algorithm).toBe('ed25519');
	});

	it('rejects a wrong algorithm', () => {
		expect(validateSignatureManifest({ ...valid, algorithm: 'rsa' }).manifest).toBeNull();
	});

	it('rejects a bad file hash', () => {
		expect(
			validateSignatureManifest({ ...valid, files: { 'x.js': 'nothex' } }).manifest
		).toBeNull();
	});

	it('rejects missing publicKey/signature', () => {
		expect(validateSignatureManifest({ ...valid, publicKey: '' }).manifest).toBeNull();
		expect(validateSignatureManifest({ ...valid, signature: '' }).manifest).toBeNull();
	});
});

describe('isTrustedKey', () => {
	it('matches trimmed exact keys', () => {
		expect(isTrustedKey('abc', ['abc', 'def'])).toBe(true);
		expect(isTrustedKey(' abc ', ['abc'])).toBe(true);
		expect(isTrustedKey('xyz', ['abc'])).toBe(false);
	});
});

describe('resolveTrustedKeys', () => {
	it('merges the baked anchor with user keys, trimmed and de-duplicated', () => {
		const resolved = resolveTrustedKeys([' user-a ', 'user-b', 'user-a', '  ']);
		// Every non-blank user key survives exactly once, trimmed.
		expect(resolved).toContain('user-a');
		expect(resolved).toContain('user-b');
		expect(resolved.filter((k) => k === 'user-a')).toHaveLength(1);
		expect(resolved).not.toContain('');
		expect(resolved).not.toContain('  ');
		// The baked anchor is always included ahead of user keys.
		for (const anchor of MAESTRO_PUBLISHER_KEYS) {
			expect(resolved).toContain(anchor.trim());
		}
	});

	it('returns the baked publisher anchor for an empty user list', () => {
		const anchor = resolveTrustedKeys([]);
		// resolveTrustedKeys([]) is exactly the baked anchor set (trimmed/de-duped).
		expect(anchor).toEqual([...MAESTRO_PUBLISHER_KEYS].map((k) => k.trim()).filter(Boolean));
	});

	it('bakes only well-formed base64 SPKI public keys as the trust anchor', () => {
		// Guarded so this asserts nothing until a real publisher key is baked
		// (MAESTRO_PUBLISHER_KEYS is empty pre-key-mint). Once populated it proves
		// every anchor entry is a non-empty, valid SPKI key crypto can load - never
		// hard-coding the real key value here.
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
