import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
const provider = vi.hoisted(() => ({ port: 0, peerId: 'host-node' }));
vi.mock('../../../main/lite/tailnet', () => ({
	tailnetDestination: async () => ({
		hostname: '127.0.0.1',
		port: provider.port,
		localAddress: '127.0.0.1',
		device: 'client-node',
		tailnet: 'synthetic.ts.net',
		peerId: provider.peerId,
	}),
}));
import { openTailnetRelay } from '../../../main/lite/tailnet-relay';
import { ADMISSION_HEADER, CONNECT_PATH } from '../../../main/lite/pairing/protocol';
const credential = 'A'.repeat(43) + '.' + 'B'.repeat(43),
	endpoint = new URL('http://100.64.0.10:56036' + CONNECT_PATH);
let server: Server,
	ws: WebSocketServer,
	relay: Awaited<ReturnType<typeof openTailnetRelay>>,
	abort: AbortController;
let requests = 0,
	commands = 0;
beforeEach(async () => {
	requests = 0;
	commands = 0;
	provider.peerId = 'host-node';
	abort = new AbortController();
	server = createServer((req, res) => {
		requests++;
		if (req.url?.endsWith('/redirect')) {
			res.writeHead(302, { location: 'http://192.0.2.1/private' }).end();
			return;
		}
		res
			.writeHead(200, { 'content-type': 'application/json' })
			.end(JSON.stringify({ authenticated: req.headers[ADMISSION_HEADER] === credential }));
	});
	ws = new WebSocketServer({ noServer: true });
	server.on('upgrade', (req, socket, head) => {
		assertHost(req.headers.host);
		ws.handleUpgrade(req, socket, head, (client) => {
			client.on('message', () => {
				commands++;
				client.send('accepted');
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	provider.port = (server.address() as { port: number }).port;
	relay = await openTailnetRelay(endpoint, credential, abort.signal, 'host-node');
});
function assertHost(host: string | undefined) {
	if (host !== '100.64.0.10:56036') throw new Error('Wrong selected host authority');
}
afterEach(async () => {
	vi.restoreAllMocks();
	await relay?.tunnel.stop();
	for (const socket of ws.clients) socket.terminate();
	ws.close();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
describe('private paired browser relay', () => {
	it('rejects non-ASCII credentials without throwing or contacting the host', async () => {
		const response = await fetch(relay.url + '/api/sessions', {
			headers: { [ADMISSION_HEADER]: '\u00e9'.repeat(credential.length) },
			signal: AbortSignal.timeout(1000),
		});
		expect(response.status).toBe(403);
		expect(requests).toBe(0);
	});
	it('rejects missing credentials, cross-origin requests and sibling paths before contacting the host', async () => {
		expect((await fetch(relay.url + '/api/sessions')).status).toBe(403);
		expect(
			(
				await fetch(relay.url + '/api/sessions', {
					headers: { [ADMISSION_HEADER]: credential, origin: 'http://evil.test' },
				})
			).status
		).toBe(403);
		expect(
			(await fetch(new URL('/health', relay.url), { headers: { [ADMISSION_HEADER]: credential } }))
				.status
		).toBe(403);
		expect(requests).toBe(0);
		expect(
			(await fetch(relay.url + '/api/sessions', { headers: { [ADMISSION_HEADER]: credential } }))
				.status
		).toBe(200);
	});
	it('does not follow redirects or send a credential after the authenticated peer identity changes', async () => {
		expect(
			(await fetch(relay.url + '/redirect', { headers: { [ADMISSION_HEADER]: credential } })).status
		).toBe(502);
		expect(requests).toBe(1);
		provider.peerId = 'replacement-node';
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + 3000);
		expect(
			(await fetch(relay.url + '/api/sessions', { headers: { [ADMISSION_HEADER]: credential } }))
				.status
		).toBe(502);
		expect(requests).toBe(1);
	});
	it('uses real WebSocket upgrade, sends a command only once and closes its sockets on cancellation', async () => {
		const url = new URL(relay.url);
		url.protocol = 'ws:';
		url.pathname = CONNECT_PATH + '/ws';
		const socket = new WebSocket(url, {
			origin: relay.url.origin,
			headers: { [ADMISSION_HEADER]: credential },
		});
		await once(socket, 'open');
		const reply = once(socket, 'message');
		socket.send('one command');
		await reply;
		expect(commands).toBe(1);
		const closed = once(socket, 'close');
		abort.abort();
		await closed;
		expect(socket.readyState).toBe(WebSocket.CLOSED);
		expect(commands).toBe(1);
	});
});
