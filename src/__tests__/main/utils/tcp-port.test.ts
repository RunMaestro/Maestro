/**
 * @file tcp-port.test.ts
 *
 * Choosing a port for a local server and checking it before a start, against
 * the real network stack: a chosen port can be bound, a held port is named as
 * held, and a probe gives back the port it took.
 */

import { describe, it, expect } from 'vitest';
import * as net from 'net';

import { isTcpPort, pickFreePort, probePort } from '../../../main/utils/tcp-port';

/** Hold a loopback port the way an unrelated program would. */
async function occupy(): Promise<{ port: number; release: () => Promise<void> }> {
	const squatter = net.createServer();
	await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
	const port = (squatter.address() as net.AddressInfo).port;
	return {
		port,
		release: () => new Promise<void>((resolve) => squatter.close(() => resolve())),
	};
}

describe('isTcpPort', () => {
	it('accepts 1 to 65535 and nothing else', () => {
		expect(isTcpPort(1)).toBe(true);
		expect(isTcpPort(8080)).toBe(true);
		expect(isTcpPort(65535)).toBe(true);
		for (const value of [0, 65536, -1, 1.5, Number.NaN, '8080', null, undefined]) {
			expect(isTcpPort(value)).toBe(false);
		}
	});
});

describe('pickFreePort', () => {
	it('returns a port that can be bound on that host', async () => {
		const port = await pickFreePort('127.0.0.1');
		expect(isTcpPort(port)).toBe(true);
		expect(await probePort(port, '127.0.0.1')).toEqual({ free: true });
	});
});

describe('probePort', () => {
	it('names a port another program holds', async () => {
		const held = await occupy();
		try {
			const probe = await probePort(held.port, '127.0.0.1');
			expect(probe.free).toBe(false);
			if (!probe.free) {
				expect(probe.code).toBe('EADDRINUSE');
				expect(probe.message).toMatch(/EADDRINUSE/);
			}
		} finally {
			await held.release();
		}
	});

	it('gives the port back, so the caller can bind it', async () => {
		const port = await pickFreePort('127.0.0.1');
		expect(await probePort(port, '127.0.0.1')).toEqual({ free: true });
		expect(await probePort(port, '127.0.0.1')).toEqual({ free: true });
	});
});
