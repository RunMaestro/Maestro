/**
 * @file steering-server.test.ts
 * @description Tests for src/maestro-p/steering-server.ts - the control channel a
 * caller uses to steer a running turn. Real sockets in a temp dir, because the
 * behaviour under test IS the framing and the failure handling.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SteeringResultFrame } from '../../maestro-p/steering';
import { MAX_PENDING_LINE_BYTES, startSteeringServer } from '../../maestro-p/steering-server';

const opened: Array<{ close: () => void }> = [];
const socketPaths: string[] = [];

function tempSocketPath(): string {
	// Short path on purpose: a unix socket address is capped near 104 bytes on
	// macOS, and the default tmpdir plus a long name can exceed it.
	const p = path.join(os.tmpdir(), `mpst-${Math.random().toString(36).slice(2, 8)}.sock`);
	socketPaths.push(p);
	return p;
}

function serve(
	onSteer: (id: string, text: string) => Promise<SteeringResultFrame>,
	warn: (m: string) => void = () => {}
): string {
	const socketPath = tempSocketPath();
	const server = startSteeringServer({ socketPath, onSteer, warn });
	expect(server).not.toBeNull();
	opened.push(server!);
	return socketPath;
}

/** Send raw bytes, resolving with every reply line received before close. */
function exchange(socketPath: string, payload: string, waitMs = 250): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const lines: string[] = [];
		const client = net.createConnection(socketPath);
		client.setEncoding('utf8');
		client.on('connect', () => client.write(payload));
		client.on('data', (chunk: string) => {
			for (const line of chunk.split('\n')) if (line.trim()) lines.push(line);
		});
		client.on('error', reject);
		setTimeout(() => {
			client.end();
			resolve(lines);
		}, waitMs);
	});
}

async function waitForListening(socketPath: string): Promise<void> {
	// listen() on a unix socket is asynchronous; the file appears a tick later.
	for (let i = 0; i < 50; i += 1) {
		if (fs.existsSync(socketPath)) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`steering socket never appeared at ${socketPath}`);
}

afterEach(() => {
	while (opened.length) opened.pop()!.close();
	for (const p of socketPaths.splice(0)) {
		try {
			if (fs.existsSync(p)) fs.unlinkSync(p);
		} catch {
			// best effort
		}
	}
});

describe('startSteeringServer', () => {
	it('answers a well-formed frame with the handler verdict', async () => {
		const seen: Array<{ id: string; text: string }> = [];
		const socketPath = serve(async (id, text) => {
			seen.push({ id, text });
			return { type: 'steering', id, verdict: 'delivered' };
		});
		await waitForListening(socketPath);

		const lines = await exchange(
			socketPath,
			`${JSON.stringify({ type: 'steer', id: 'x1', text: 'go left' })}\n`
		);

		expect(seen).toEqual([{ id: 'x1', text: 'go left' }]);
		expect(lines.map((l) => JSON.parse(l))).toEqual([
			{ type: 'steering', id: 'x1', verdict: 'delivered' },
		]);
	});

	it('handles two frames arriving in one packet', async () => {
		// NDJSON framing has to split on newlines rather than assume one frame per
		// read; TCP-style coalescing is normal on a socket.
		const socketPath = serve(async (id) => ({ type: 'steering', id, verdict: 'delivered' }));
		await waitForListening(socketPath);

		const payload =
			`${JSON.stringify({ type: 'steer', id: 'a', text: 'one' })}\n` +
			`${JSON.stringify({ type: 'steer', id: 'b', text: 'two' })}\n`;
		const lines = await exchange(socketPath, payload);

		expect(lines.map((l) => JSON.parse(l).id).sort()).toEqual(['a', 'b']);
	});

	it('reassembles a frame split across packets', async () => {
		const socketPath = serve(async (id, text) => ({
			type: 'steering',
			id,
			verdict: 'delivered',
			detail: text,
		}));
		await waitForListening(socketPath);

		const frame = JSON.stringify({ type: 'steer', id: 'split', text: 'half and half' });
		const lines = await new Promise<string[]>((resolve) => {
			const out: string[] = [];
			const client = net.createConnection(socketPath);
			client.setEncoding('utf8');
			client.on('connect', () => {
				client.write(frame.slice(0, 12));
				setTimeout(() => client.write(`${frame.slice(12)}\n`), 30);
			});
			client.on('data', (c: string) => {
				for (const l of c.split('\n')) if (l.trim()) out.push(l);
			});
			setTimeout(() => {
				client.end();
				resolve(out);
			}, 250);
		});

		expect(JSON.parse(lines[0])).toMatchObject({ id: 'split', detail: 'half and half' });
	});

	it('ignores a malformed line without answering and without killing the turn', async () => {
		// The socket is reachable by anything holding the path. A bad line must cost
		// nothing: no handler call, no reply, no throw.
		const warnings: string[] = [];
		let calls = 0;
		const socketPath = serve(
			async (id) => {
				calls += 1;
				return { type: 'steering', id, verdict: 'delivered' };
			},
			(m) => warnings.push(m)
		);
		await waitForListening(socketPath);

		const lines = await exchange(socketPath, '{not json}\n{"type":"other"}\n');

		expect(calls).toBe(0);
		expect(lines).toEqual([]);
		expect(warnings.length).toBeGreaterThan(0);
	});

	it('still serves a good frame after a malformed one on the same connection', async () => {
		const socketPath = serve(async (id) => ({ type: 'steering', id, verdict: 'delivered' }));
		await waitForListening(socketPath);

		const lines = await exchange(
			socketPath,
			`garbage\n${JSON.stringify({ type: 'steer', id: 'after', text: 'ok' })}\n`
		);

		expect(lines.map((l) => JSON.parse(l).id)).toEqual(['after']);
	});

	it('drops an oversized un-terminated frame instead of buffering forever', async () => {
		const warnings: string[] = [];
		const socketPath = serve(
			async (id) => ({ type: 'steering', id, verdict: 'delivered' }),
			(m) => warnings.push(m)
		);
		await waitForListening(socketPath);

		await exchange(socketPath, 'x'.repeat(MAX_PENDING_LINE_BYTES + 10));

		expect(warnings.some((w) => w.includes('oversized'))).toBe(true);
	});

	it('answers `unknown` when the handler throws', async () => {
		// The caller is blocked on a reply. Reporting that nobody knows where the
		// text went is the truth; dropping the reply leaves it waiting for its own
		// timeout and no better informed.
		const socketPath = serve(async () => {
			throw new Error('injection blew up');
		});
		await waitForListening(socketPath);

		const lines = await exchange(
			socketPath,
			`${JSON.stringify({ type: 'steer', id: 'boom', text: 'hi' })}\n`
		);

		const frame = JSON.parse(lines[0]);
		expect(frame).toMatchObject({ type: 'steering', id: 'boom', verdict: 'unknown' });
		expect(frame.detail).toContain('injection blew up');
	});

	it('replaces a stale socket file left by a crashed predecessor', async () => {
		// Otherwise listen() fails with EADDRINUSE and every later run silently
		// loses its channel.
		const socketPath = tempSocketPath();
		fs.writeFileSync(socketPath, 'stale');

		const server = startSteeringServer({
			socketPath,
			onSteer: async (id) => ({ type: 'steering', id, verdict: 'delivered' }),
			warn: () => {},
		});
		expect(server).not.toBeNull();
		opened.push(server!);
		await waitForListening(socketPath);

		const lines = await exchange(
			socketPath,
			`${JSON.stringify({ type: 'steer', id: 's', text: 'hi' })}\n`
		);
		expect(lines.map((l) => JSON.parse(l).id)).toEqual(['s']);
	});

	it('removes the socket file on close, and close is idempotent', async () => {
		const socketPath = serve(async (id) => ({ type: 'steering', id, verdict: 'delivered' }));
		await waitForListening(socketPath);

		const server = opened.pop()!;
		server.close();
		server.close();

		expect(fs.existsSync(socketPath)).toBe(false);
	});
});
