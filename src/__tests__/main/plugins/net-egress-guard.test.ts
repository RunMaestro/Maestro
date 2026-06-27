/**
 * @file net-egress-guard.test.ts
 * @description The net:fetch egress policy classifies blocked IPs (loopback,
 * link-local, cloud metadata, RFC1918, IPv6 local), validates ALL resolved
 * addresses (DNS-rebind defense), blocks the app's own loopback port, and pins
 * the connect via a validating lookup.
 */

import { describe, it, expect } from 'vitest';
import {
	classifyBlockedAddress,
	createEgressGuard,
	createGuardedLookup,
	type GuardedLookup,
} from '../../../main/plugins/net-egress-guard';

describe('classifyBlockedAddress', () => {
	it('blocks loopback, link-local, metadata, RFC1918, unspecified, IPv6 local', () => {
		const blocked = [
			'127.0.0.1',
			'127.1.2.3',
			'10.0.0.1',
			'172.16.0.1',
			'172.31.255.255',
			'192.168.1.1',
			'169.254.1.1',
			'169.254.169.254',
			'0.0.0.0',
			'::1',
			'::',
			'fe80::1',
			'fc00::1',
			'::ffff:10.0.0.1',
		];
		for (const ip of blocked) expect(classifyBlockedAddress(ip)).not.toBeNull();
	});

	it('allows routable public addresses (incl. 172.15/172.32 outside RFC1918)', () => {
		const allowed = [
			'8.8.8.8',
			'1.1.1.1',
			'172.15.255.255',
			'172.32.0.1',
			'93.184.216.34',
			'2606:4700:4700::1111',
		];
		for (const ip of allowed) expect(classifyBlockedAddress(ip)).toBeNull();
	});

	it('classifies the cloud metadata IP distinctly and fails closed on garbage', () => {
		expect(classifyBlockedAddress('169.254.169.254')).toMatch(/metadata/);
		expect(classifyBlockedAddress('not-an-ip')).not.toBeNull();
	});

	it('decodes IPv4-mapped/compatible IPv6 to the embedded v4 and blocks it', () => {
		// Hex-form IPv4-mapped (::ffff:a.b.c.d) cannot be smuggled past as IPv6.
		expect(classifyBlockedAddress('::ffff:7f00:1')).toBe('loopback'); // 127.0.0.1
		expect(classifyBlockedAddress('::ffff:a9fe:a9fe')).toMatch(/metadata/); // 169.254.169.254
		expect(classifyBlockedAddress('::ffff:c0a8:0001')).toMatch(/RFC1918/); // 192.168.0.1
		// Deprecated IPv4-compatible (::a.b.c.d) hex form.
		expect(classifyBlockedAddress('::7f00:1')).toBe('loopback'); // 127.0.0.1
	});

	it('allows a public mapped addr but does NOT mis-unwrap a public addr ending in ffff hextets', () => {
		expect(classifyBlockedAddress('::ffff:8.8.8.8')).toBeNull();
		// High bytes are non-zero, so this is NOT mapped/compatible: it must stay
		// allowed rather than being decoded to the trailing 127.0.0.1.
		expect(classifyBlockedAddress('2001:db8::ffff:7f00:1')).toBeNull();
	});

	it('classifies pure IPv6 specials from bytes', () => {
		expect(classifyBlockedAddress('::1')).toBe('loopback');
		expect(classifyBlockedAddress('fe80::1')).toBe('link-local');
		expect(classifyBlockedAddress('fd00::1')).toMatch(/unique-local/);
	});

	it('still classifies canonical IPv4 forms and allows public v4', () => {
		expect(classifyBlockedAddress('127.0.0.1')).toBe('loopback');
		expect(classifyBlockedAddress('169.254.169.254')).toMatch(/metadata/);
		expect(classifyBlockedAddress('8.8.8.8')).toBeNull();
	});
});

describe('createEgressGuard.assertUrlAllowed', () => {
	const guard = (addrs: string[], blockedPorts: number[] = []) =>
		createEgressGuard({
			resolve: async () => addrs,
			blockedPorts: () => blockedPorts,
			makeDispatcher: () => undefined,
		});

	it('allows a public-resolving https host', async () => {
		await expect(
			guard(['93.184.216.34']).assertUrlAllowed('https://example.com/x')
		).resolves.toBeUndefined();
	});

	it('blocks when the host resolves to RFC1918', async () => {
		await expect(
			guard(['10.0.0.5']).assertUrlAllowed('https://intranet.example.com')
		).rejects.toThrow(/RFC1918/);
	});

	it('blocks the cloud metadata address', async () => {
		await expect(guard(['169.254.169.254']).assertUrlAllowed('http://metadata')).rejects.toThrow(
			/metadata/
		);
	});

	it('blocks a literal loopback url without resolving', async () => {
		await expect(guard([]).assertUrlAllowed('http://127.0.0.1:9000')).rejects.toThrow(/loopback/);
		await expect(guard([]).assertUrlAllowed('http://[::1]/')).rejects.toThrow(/loopback/);
	});

	it("blocks the app's own loopback port even on a public host", async () => {
		await expect(
			guard(['93.184.216.34'], [31337]).assertUrlAllowed('http://example.com:31337')
		).rejects.toThrow(/port 31337/);
	});

	it('rejects non-http(s) schemes', async () => {
		await expect(guard([]).assertUrlAllowed('file:///etc/passwd')).rejects.toThrow(/scheme/);
	});

	it('defeats DNS rebinding: ANY blocked resolved address blocks the request', async () => {
		await expect(
			guard(['93.184.216.34', '10.0.0.5']).assertUrlAllowed('https://rebind.example.com')
		).rejects.toThrow(/RFC1918/);
	});
});

describe('createGuardedLookup (connect-time pin defeats rebinding)', () => {
	function run(
		lookup: GuardedLookup,
		hostname: string,
		options: { all?: boolean }
	): Promise<{ err: unknown; address: unknown }> {
		const { promise, resolve } = Promise.withResolvers<{ err: unknown; address: unknown }>();
		lookup(hostname, options, (err, address) => resolve({ err, address }));
		return promise;
	}

	it('yields validated addresses for a public host', async () => {
		const lookup = createGuardedLookup(async () => ['93.184.216.34']);
		const r = await run(lookup, 'example.com', { all: true });
		expect(r.err).toBeNull();
		expect(r.address).toEqual([{ address: '93.184.216.34', family: 4 }]);
	});

	it('errors when resolution yields a blocked address (the connected IP is vetted)', async () => {
		const lookup = createGuardedLookup(async () => ['10.0.0.5']);
		const r = await run(lookup, 'evil.example.com', { all: true });
		expect(r.err).toBeInstanceOf(Error);
	});

	it('errors when ANY resolved address is blocked', async () => {
		const lookup = createGuardedLookup(async () => ['93.184.216.34', '169.254.169.254']);
		const r = await run(lookup, 'mixed.example.com', { all: true });
		expect(r.err).toBeInstanceOf(Error);
	});
});
