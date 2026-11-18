/**
 * Tests for src/shared/maestro-lib/client/local-port.ts: picking a free loopback port and
 * waiting for an SSH forward to listen on it.
 */

import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import {
	availableLocalPort,
	waitForLocalPort,
} from '../../../../shared/maestro-lib/client/local-port';

const servers: net.Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
	);
});

function listen(port: number): Promise<net.Server> {
	return new Promise((resolve, reject) => {
		const server = net.createServer((socket) => socket.destroy());
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => {
			servers.push(server);
			resolve(server);
		});
	});
}

describe('availableLocalPort', () => {
	it('returns a free port that can then be bound', async () => {
		const port = await availableLocalPort();
		expect(port).toBeGreaterThan(0);
		await expect(listen(port)).resolves.toBeDefined();
	});

	it('rejects a requested port that is taken', async () => {
		const port = await availableLocalPort();
		await listen(port);
		await expect(availableLocalPort(port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
	});
});

describe('waitForLocalPort', () => {
	it('resolves true once something listens', async () => {
		const port = await availableLocalPort();
		const waiting = waitForLocalPort(port, { timeoutMs: 5000, intervalMs: 20 });
		setTimeout(() => void listen(port), 60);
		await expect(waiting).resolves.toBe(true);
	});

	it('resolves false on the timeout when nothing listens', async () => {
		const port = await availableLocalPort();
		await expect(waitForLocalPort(port, { timeoutMs: 100, intervalMs: 20 })).resolves.toBe(false);
	});

	it('resolves false at once when shouldStop says so', async () => {
		const port = await availableLocalPort();
		const started = Date.now();
		await expect(waitForLocalPort(port, { timeoutMs: 5000, shouldStop: () => true })).resolves.toBe(
			false
		);
		expect(Date.now() - started).toBeLessThan(1000);
	});
});
