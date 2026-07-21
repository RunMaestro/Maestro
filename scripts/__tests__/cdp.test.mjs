import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { connectCdp, getCdpTargets } from '../lib/cdp.mjs';

const closers = [];

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()));
});

async function serve(handler) {
	const server = http.createServer(handler);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	closers.push(() => {
		server.closeAllConnections();
		return new Promise((resolve) => server.close(resolve));
	});
	return server.address().port;
}

class FakeWebSocket extends EventEmitter {
	constructor(url, options) {
		super();
		this.url = url;
		this.options = options;
		this.readyState = this.OPEN;
		this.sent = [];
	}

	OPEN = 1;
	CLOSED = 3;

	send(message) {
		this.sent.push(JSON.parse(message));
	}

	close() {
		this.readyState = this.CLOSED;
		this.emit('close');
	}
}

test('getCdpTargets leaves an unavailable endpoint error unchanged', async () => {
	const unavailable = new Error('connect ECONNREFUSED');
	await expect(getCdpTargets({ fetchImpl: async () => Promise.reject(unavailable) })).rejects.toBe(
		unavailable
	);
});

test('getCdpTargets is one-shot while a delayed endpoint becomes discoverable later', async () => {
	let ready = false;
	const port = await serve((_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end(
			JSON.stringify(ready ? [{ type: 'page', webSocketDebuggerUrl: 'ws://ready' }] : [])
		);
	});

	await expect(getCdpTargets({ port })).resolves.toEqual([]);
	ready = true;
	await expect(getCdpTargets({ port })).resolves.toEqual([
		{ type: 'page', webSocketDebuggerUrl: 'ws://ready' },
	]);
});

test('getCdpTargets preserves multiple targets for caller-side target selection', async () => {
	const targets = [
		{ type: 'service_worker', webSocketDebuggerUrl: 'ws://worker' },
		{ type: 'page' },
		{ type: 'page', webSocketDebuggerUrl: 'ws://first-page' },
		{ type: 'page', webSocketDebuggerUrl: 'ws://second-page' },
	];
	const port = await serve((_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify(targets));
	});

	await expect(getCdpTargets({ port })).resolves.toEqual(targets);
});

test('connectCdp sends commands, dispatches replies, and cleans up its socket', async () => {
	const connection = connectCdp('ws://fixture', { WebSocketImpl: FakeWebSocket });
	const reply = connection.send('Runtime.enable');
	const [message] = connection.ws.sent;
	connection.ws.emit(
		'message',
		Buffer.from(JSON.stringify({ id: message.id, result: { ok: true } }))
	);

	await expect(reply).resolves.toMatchObject({ result: { ok: true } });
	connection.close();
	expect(connection.ws.readyState).toBe(connection.ws.CLOSED);
});

test('connectCdp rejects pending commands when the connection is lost', async () => {
	const connection = connectCdp('ws://fixture', { WebSocketImpl: FakeWebSocket });
	const pending = connection.send('Runtime.enable');
	connection.ws.emit('close');

	await expect(pending).rejects.toThrow('CDP connection closed');
});
