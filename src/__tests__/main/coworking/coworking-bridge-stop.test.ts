/**
 * Stopping the coworking bridge (app quit, or the coworking Encore flag turning
 * off) must drop connections that are already open. Closing the server alone
 * only refuses NEW connections, so an agent whose MCP subprocess connected while
 * the feature was on could otherwise keep calling tools after it was disabled.
 *
 * Uses a real socket (a named pipe on Windows) at a per-run path.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const SOCKET_ID = `maestro-cw-stop-${process.pid}-${Date.now()}`;
const socketPath =
	process.platform === 'win32'
		? `\\\\.\\pipe\\${SOCKET_ID}`
		: path.join(os.tmpdir(), `${SOCKET_ID}.sock`);

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Read lazily (when the bridge starts), after the module-level path exists.
vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => socketPath,
}));

import {
	startCoworkingBridge,
	stopCoworkingBridge,
} from '../../../main/coworking/coworking-bridge';

afterEach(async () => {
	await stopCoworkingBridge();
});

describe('stopCoworkingBridge', () => {
	it('drops a live connection and refuses new ones', async () => {
		await startCoworkingBridge();

		const client = net.createConnection(socketPath);
		await new Promise<void>((resolve, reject) => {
			client.once('connect', resolve);
			client.once('error', reject);
		});
		const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
		client.on('error', () => {
			// A reset while the server tears down is expected here.
		});

		await stopCoworkingBridge();
		await closed;
		expect(client.destroyed).toBe(true);

		const refused = await new Promise<boolean>((resolve) => {
			const again = net.createConnection(socketPath);
			again.once('connect', () => {
				again.destroy();
				resolve(false);
			});
			again.once('error', () => resolve(true));
		});
		expect(refused).toBe(true);
	});

	it('overlapping starts share one server, so a stop leaves nothing listening', async () => {
		await Promise.all([startCoworkingBridge(), startCoworkingBridge()]);
		await stopCoworkingBridge();

		const refused = await new Promise<boolean>((resolve) => {
			const client = net.createConnection(socketPath);
			client.once('connect', () => {
				client.destroy();
				resolve(false);
			});
			client.once('error', () => resolve(true));
		});
		expect(refused).toBe(true);
	});
});
