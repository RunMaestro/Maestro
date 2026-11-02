// @vitest-environment node
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import {
	sendBounded,
	WEB_CLIENT_MAX_BUFFERED_BYTES,
} from '../../../../main/web-server/services/socket-send';

describe('bounded WebSocket output', () => {
	it('delivers a large Unicode reply and the following event in order on a healthy socket', async () => {
		const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await once(server, 'listening');
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('No loopback listener');
		const connection = once(server, 'connection');
		const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
		const received: string[] = [];
		client.on('message', (data) => received.push(data.toString()));
		await once(client, 'open');
		const [peer] = await connection;
		try {
			const payload = 'a'.repeat(256 * 1024 - 1) + '😀' + 'z'.repeat(WEB_CLIENT_MAX_BUFFERED_BYTES);
			expect(sendBounded(peer, payload)).toBe(true);
			expect(sendBounded(peer, 'following event')).toBe(true);
			await vi.waitFor(() => expect(received[1]).toBe('following event'), { timeout: 5000 });
			expect(received).toEqual([payload, 'following event']);
			expect(client.readyState).toBe(WebSocket.OPEN);
		} finally {
			client.terminate();
			peer.terminate();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
