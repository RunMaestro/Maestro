import { WebSocket } from 'ws';
import { chunkBrowserRelayText } from '../../../shared/browserRelay';

export const WEB_CLIENT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
export const WEB_CLIENT_CHUNK_WINDOW_BYTES = 256 * 1024;
const CHUNK_ACK_TIMEOUT_MS = 30_000;
const closing = new WeakSet<WebSocket>();
const FRAGMENT_CHARACTERS = 256 * 1024;
const FRAGMENT_BURST = 16;
interface PendingMessage {
	data: string;
	bytes: number;
	offset: number;
	chunks?: Generator<string>;
	nextChunk?: string;
	finished?: boolean;
}
interface UnacknowledgedChunk {
	end: number;
	bytes: number;
	sentAt: number;
}
interface FragmentedOutput {
	current?: PendingMessage;
	queue: PendingMessage[];
	queuedBytes: number;
	writePending?: boolean;
	continuation?: ReturnType<typeof setImmediate>;
	burst: number;
	acknowledgedOffset: number;
	unacknowledged: UnacknowledgedChunk[];
	unacknowledgedBytes: number;
	ackDeadline?: ReturnType<typeof setTimeout>;
}
const fragmented = new WeakMap<WebSocket, FragmentedOutput>();
const chunked = new WeakSet<WebSocket>();

/** Opt-in only: existing browser bundles and CLI clients retain native framing. */
export function enableWebSocketChunks(socket: WebSocket): void {
	chunked.add(socket);
}

/** Accept cumulative acknowledgements only at sent, complete chunk boundaries. */
export function acknowledgeWebSocketChunk(socket: WebSocket, offset: unknown): void {
	const output = fragmented.get(socket);
	if (!output || !Number.isSafeInteger(offset) || (offset as number) <= output.acknowledgedOffset)
		return;
	const index = output.unacknowledged.findIndex((chunk) => chunk.end === offset);
	if (index < 0) return;
	for (const chunk of output.unacknowledged.splice(0, index + 1))
		output.unacknowledgedBytes -= chunk.bytes;
	output.acknowledgedOffset = offset as number;
	armChunkDeadline(socket, output);
	sendFragment(socket, output);
}

/** Partial progress must not renew the age of data that is still unconfirmed. */
function armChunkDeadline(socket: WebSocket, output: FragmentedOutput): void {
	clearTimeout(output.ackDeadline);
	output.ackDeadline = undefined;
	const oldest = output.unacknowledged[0];
	if (!oldest) return;
	const remaining = Math.max(0, oldest.sentAt + CHUNK_ACK_TIMEOUT_MS - Date.now());
	output.ackDeadline = setTimeout(() => disconnectSlowClient(socket), remaining);
	output.ackDeadline.unref();
}

function sendFragment(socket: WebSocket, output: FragmentedOutput): void {
	const current = output.current;
	if (
		!current ||
		fragmented.get(socket) !== output ||
		socket.readyState !== WebSocket.OPEN ||
		closing.has(socket) ||
		output.writePending ||
		output.continuation
	)
		return;
	// ACKs and write completions share one continuation; neither may bypass it.
	if (output.burst >= FRAGMENT_BURST) {
		output.continuation = setImmediate(() => {
			output.continuation = undefined;
			output.burst = 0;
			if (fragmented.get(socket) === output) sendFragment(socket, output);
		});
		return;
	}
	if (current.finished) {
		if (output.unacknowledged.length > 0) return;
		output.current = output.queue.shift();
		output.queuedBytes -= output.current?.bytes ?? 0;
		output.acknowledgedOffset = 0;
		sendFragment(socket, output);
		return;
	}
	const applicationChunks = chunked.has(socket) && current.bytes > 16_384;
	let end: number;
	let fragment: string;
	if (applicationChunks) {
		current.chunks ??= chunkBrowserRelayText(current.data);
		fragment = current.nextChunk ?? (current.chunks.next().value as string);
		end = current.offset + fragment.length;
	} else {
		end = Math.min(current.offset + FRAGMENT_CHARACTERS, current.data.length);
		// Each native fragment is encoded separately; preserve surrogate pairs.
		if (end < current.data.length) {
			const last = current.data.charCodeAt(end - 1);
			if (last >= 0xd800 && last <= 0xdbff) end--;
		}
		fragment = current.data.slice(current.offset, end);
	}
	const fin = end === current.data.length;
	// A browser emits no message event for native continuation frames until FIN.
	// Complete envelopes make real transfer progress visible to its heartbeat.
	const wireData = applicationChunks
		? JSON.stringify({
				type: 'bridge.chunk',
				data: fragment,
				offset: current.offset,
				total: current.data.length,
				final: fin,
			})
		: fragment;
	const wireBytes = Buffer.byteLength(wireData);
	if (applicationChunks && output.unacknowledgedBytes + wireBytes > WEB_CLIENT_CHUNK_WINDOW_BYTES) {
		current.nextChunk = fragment;
		return;
	}
	current.nextChunk = undefined;
	if ((socket.bufferedAmount ?? 0) > WEB_CLIENT_MAX_BUFFERED_BYTES - wireBytes) {
		disconnectSlowClient(socket);
		return;
	}
	current.offset = end;
	current.finished = fin;
	output.writePending = true;
	output.burst++;
	if (applicationChunks) {
		output.unacknowledged.push({ end, bytes: wireBytes, sentAt: Date.now() });
		output.unacknowledgedBytes += wireBytes;
		if (output.unacknowledged.length === 1) armChunkDeadline(socket, output);
	}
	try {
		socket.send(wireData, { fin: applicationChunks || fin, binary: false }, (error) => {
			output.writePending = false;
			if (error) {
				disconnectSlowClient(socket);
				return;
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
	clearTimeout(fragmented.get(socket)?.ackDeadline);
	clearImmediate(fragmented.get(socket)?.continuation);
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
	bytes = Buffer.byteLength(data),
	priority = false
): boolean {
	if (socket.readyState !== WebSocket.OPEN || closing.has(socket)) return false;
	let output = fragmented.get(socket);
	// Only small replies/control packets may pass a chunked transfer. Events
	// retain their original order and sequence; legacy native fragments cannot
	// be interleaved with another data message at all.
	const interleave = chunked.has(socket) && priority && bytes <= 16_384;
	if (output?.current && !interleave) {
		if (output.queuedBytes + (socket.bufferedAmount ?? 0) > WEB_CLIENT_MAX_BUFFERED_BYTES - bytes) {
			disconnectSlowClient(socket);
			return false;
		}
		output.queue.push({ data, bytes, offset: 0 });
		output.queuedBytes += bytes;
		return true;
	}
	if (bytes > (chunked.has(socket) ? 16_384 : WEB_CLIENT_MAX_BUFFERED_BYTES)) {
		if (!output) {
			output = {
				queue: [],
				burst: 0,
				queuedBytes: 0,
				acknowledgedOffset: 0,
				unacknowledged: [],
				unacknowledgedBytes: 0,
			};
			fragmented.set(socket, output);
			socket.once('close', () => {
				clearTimeout(fragmented.get(socket)?.ackDeadline);
				clearImmediate(fragmented.get(socket)?.continuation);
				fragmented.delete(socket);
			});
		}
		// Keep one result, at most 8 MiB queued behind it and a bounded wire window.
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
