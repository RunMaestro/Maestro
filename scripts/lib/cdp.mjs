import WebSocket from 'ws';

export function resolveCdpPort(env = process.env) {
	return env.MAESTRO_CDP_PORT || '12345';
}

export async function getCdpTargets({ port = resolveCdpPort(), fetchImpl = fetch } = {}) {
	return await (await fetchImpl(`http://127.0.0.1:${port}/json/list`)).json();
}

/**
 * Creates the CDP message transport for a caller-selected target. Target
 * selection and all command/evaluation policy stay with the caller.
 */
export function connectCdp(webSocketDebuggerUrl, { WebSocketImpl = WebSocket } = {}) {
	const ws = new WebSocketImpl(webSocketDebuggerUrl, {
		perMessageDeflate: false,
		maxPayload: 200 * 1024 * 1024,
	});
	let id = 0;
	const pending = new Map();

	const rejectPending = (error) => {
		for (const { reject } of pending.values()) reject(error);
		pending.clear();
	};

	function send(method, params) {
		return new Promise((resolve, reject) => {
			const messageId = ++id;
			pending.set(messageId, { resolve, reject });
			try {
				ws.send(JSON.stringify({ id: messageId, method, params }));
			} catch (error) {
				pending.delete(messageId);
				reject(error);
			}
		});
	}

	ws.on('message', (data) => {
		const message = JSON.parse(data.toString());
		if (message.id && pending.has(message.id)) {
			pending.get(message.id).resolve(message);
			pending.delete(message.id);
		}
	});
	ws.on('close', () => rejectPending(new Error('CDP connection closed')));
	ws.on('error', (error) => rejectPending(error));

	return { ws, send, close: () => ws.close() };
}
