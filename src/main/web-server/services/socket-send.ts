import { WebSocket } from 'ws';

export const WEB_CLIENT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const closing = new WeakSet<WebSocket>();
const FRAGMENT_CHARACTERS = 256 * 1024;
interface PendingMessage {
	data: string;
	bytes: number;
	offset: number;
}
interface FragmentedOutput {
	current?: PendingMessage;
	queue: PendingMessage[];
	queuedBytes: number;
}
const fragmented = new WeakMap<WebSocket, FragmentedOutput>();

function sendFragment(socket: WebSocket, output: FragmentedOutput): void {
	const current = output.current;
	if (!current || socket.readyState !== WebSocket.OPEN || closing.has(socket)) return;
	let end = Math.min(current.offset + FRAGMENT_CHARACTERS, current.data.length);
	// Each text fragment is encoded separately; never split a UTF-16 surrogate pair.
	if (end < current.data.length) {
		const last = current.data.charCodeAt(end - 1);
		if (last >= 0xd800 && last <= 0xdbff) end--;
	}
	const fragment = current.data.slice(current.offset, end);
	if ((socket.bufferedAmount ?? 0) > WEB_CLIENT_MAX_BUFFERED_BYTES - Buffer.byteLength(fragment)) {
		disconnectSlowClient(socket);
		return;
	}
	const fin = end === current.data.length;
	current.offset = end;
	try {
		socket.send(fragment, { fin, binary: false }, (error) => {
			if (error) {
				disconnectSlowClient(socket);
				return;
			}
			if (fin) {
				output.current = output.queue.shift();
				output.queuedBytes -= output.current?.bytes ?? 0;
			}
			sendFragment(socket, output);
		});
	} catch {
		disconnectSlowClient(socket);
	}
}

function disconnectSlowClient(socket: WebSocket): void {
	if (closing.has(socket)) return;
	closing.add(socket);
	fragmented.delete(socket);
	try {
		socket.close(1013, 'Client output backlog exceeded; reconnect to resynchronize');
	} catch {
		socket.terminate();
		return;
	}
	// A peer that stopped reading cannot complete the close handshake either.
	const timer = setTimeout(() => socket.terminate(), 1000);
	timer.unref();
	socket.once('close', () => clearTimeout(timer));
}

/** Bound queued output, not supported result sizes. Native fragments preserve the wire protocol. */
export function sendBounded(
	socket: WebSocket,
	data: string,
	bytes = Buffer.byteLength(data)
): boolean {
	if (socket.readyState !== WebSocket.OPEN || closing.has(socket)) return false;
	let output = fragmented.get(socket);
	if (output?.current) {
		if (output.queuedBytes + (socket.bufferedAmount ?? 0) > WEB_CLIENT_MAX_BUFFERED_BYTES - bytes) {
			disconnectSlowClient(socket);
			return false;
		}
		output.queue.push({ data, bytes, offset: 0 });
		output.queuedBytes += bytes;
		return true;
	}
	if (bytes > WEB_CLIENT_MAX_BUFFERED_BYTES) {
		if (!output) {
			output = { queue: [], queuedBytes: 0 };
			fragmented.set(socket, output);
			socket.once('close', () => fragmented.delete(socket));
		}
		// Keep one existing result, at most 8 MiB behind it, and one drained fragment in transport.
		output.current = { data, bytes, offset: 0 };
		sendFragment(socket, output);
		return !closing.has(socket);
	}
	if ((socket.bufferedAmount ?? 0) > WEB_CLIENT_MAX_BUFFERED_BYTES - bytes) {
		disconnectSlowClient(socket);
		return false;
	}
	try {
		socket.send(data);
		return true;
	} catch {
		disconnectSlowClient(socket);
		return false;
	}
}
