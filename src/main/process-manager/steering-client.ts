// Main-process client for maestro-p's chat-steering channel (see
// src/shared/chatSteering.ts for the protocol, src/maestro-p/steering-server.ts
// for the other end).
//
// Two halves, and the first is why this module exists at all: the SPAWNER and the
// CLIENT have to agree on a socket path without one telling the other. The spawn
// decision happens deep in the handle-spawn chain (apply-local-interactive-spawn),
// which builds an env record and returns; the client runs later, from an IPC call
// that knows only the process key. Deriving the path from that key means neither
// has to carry a value for the other.

import * as crypto from 'crypto';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import {
	parseSteeringResult,
	type SteeringResultFrame,
	type SteeringRequestFrame,
} from '../../shared/chatSteering';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[Steering]';

/**
 * Socket path for a given process key (`${sessionId}-ai-${tabId}`).
 *
 * The key is HASHED rather than sanitized into the name, because a unix socket
 * address is capped near 104 bytes on macOS and a session UUID plus a tab id plus
 * a tmpdir already exceeds that - the socket would simply fail to bind, and
 * steering would be silently unavailable with no obvious cause. A short hash is
 * also stable across both callers, which is the whole point.
 *
 * Not a security boundary: anything able to read the directory can find the
 * socket. What protects it is that the server only ever types into the TUI it
 * owns, refuses when the editor is not accepting input, and caps the frame size.
 */
export function steeringSocketPathFor(processKey: string): string {
	const digest = crypto.createHash('sha1').update(processKey).digest('hex').slice(0, 16);
	return path.join(os.tmpdir(), `maestro-steer-${digest}.sock`);
}

/**
 * How long to wait for a verdict before giving up on the socket.
 *
 * Bounded by what the SERVER does, not by how long claude takes to think: the
 * reply comes back as soon as the text is typed and submitted (or refused), and
 * the absorbed/queued refinement arrives later on stdout instead. The typing
 * itself is the slow part - paced at 256 bytes per repaint with a 250ms drain cap,
 * so a full 8 KB frame can take a few seconds on a busy machine.
 */
export const STEERING_REPLY_TIMEOUT_MS = 20_000;

/**
 * Ask a running maestro-p turn to take `text` into the turn in flight.
 *
 * Always resolves, never rejects. The caller is a UI action, and every outcome
 * here is a thing to TELL the user rather than an exception to propagate: a
 * refusal is a normal answer ("a permission prompt is on screen"), and an
 * unreachable socket usually just means this turn is not steerable.
 */
export async function sendSteeringRequest(options: {
	processKey: string;
	text: string;
	/** Correlation id. Echoed back on the verdict. */
	id: string;
	timeoutMs?: number;
}): Promise<SteeringResultFrame> {
	const socketPath = steeringSocketPathFor(options.processKey);
	const timeoutMs = options.timeoutMs ?? STEERING_REPLY_TIMEOUT_MS;
	const frame: SteeringRequestFrame = { type: 'steer', id: options.id, text: options.text };

	return new Promise<SteeringResultFrame>((resolve) => {
		let settled = false;
		let buffer = '';
		const finish = (result: SteeringResultFrame): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				socket.destroy();
			} catch {
				// Already gone.
			}
			resolve(result);
		};

		const timer = setTimeout(() => {
			// The text may well have been typed - we simply never heard back - so this
			// is `unknown`, not `refused`. Telling the caller it was refused would
			// invite a re-send that could double the message into the turn.
			finish({
				type: 'steering',
				id: options.id,
				verdict: 'unknown',
				detail: 'maestro-p did not answer the steering request in time',
			});
		}, timeoutMs);

		// Whether the connection was ever established. This is the line between "not
		// steerable" and "we do not know", and it has to be tracked rather than
		// inferred from the error code: a reset AFTER connecting may have followed a
		// successful write, so calling that a refusal would invite a re-send that
		// doubles the message into the turn.
		let connected = false;

		const socket = net.createConnection(socketPath);
		socket.setEncoding('utf8');

		socket.on('connect', () => {
			connected = true;
			try {
				socket.write(`${JSON.stringify(frame)}\n`);
			} catch (err) {
				finish({
					type: 'steering',
					id: options.id,
					verdict: 'refused',
					refusal: 'tui-exited',
					detail: `the steering channel closed before the message was sent: ${String(err)}`,
				});
			}
		});

		socket.on('data', (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf('\n');
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const parsed = parseSteeringResult(line);
				// Only a verdict for OUR id settles this call. A frame for anything else
				// belongs to a different request on the same channel.
				if (parsed && parsed.id === options.id) {
					finish(parsed);
					return;
				}
				newline = buffer.indexOf('\n');
			}
		});

		socket.on('error', (err: NodeJS.ErrnoException) => {
			// Never connected is the ordinary "this turn has no channel" case: the agent
			// is on the API token source, or the turn already finished, or this build of
			// maestro-p predates steering. That is a clean refusal - nothing was sent,
			// so the caller still owns the message and can send it normally. Not worth a
			// stack trace either.
			if (!connected) {
				const expected = err.code === 'ENOENT' || err.code === 'ECONNREFUSED';
				if (!expected) {
					logger.warn('Steering channel unreachable', LOG_CONTEXT, {
						processKey: options.processKey,
						error: err.message,
					});
				}
				finish({
					type: 'steering',
					id: options.id,
					verdict: 'refused',
					refusal: 'not-running',
					detail: 'this turn is not steerable - no steering channel is open for it',
				});
				return;
			}
			// Failed AFTER connecting (a reset, a broken pipe). The frame may already
			// have been written and typed, so this is `unknown`: reporting a refusal
			// here is what would invite a re-send and double the message into the turn.
			logger.warn('Steering channel failed mid-request', LOG_CONTEXT, {
				processKey: options.processKey,
				error: err.message,
			});
			finish({
				type: 'steering',
				id: options.id,
				verdict: 'unknown',
				detail: `the steering channel failed before reporting a verdict: ${err.message}`,
			});
		});

		socket.on('close', () => {
			// Closed without a verdict. Same reasoning as the timeout: the text may
			// have been typed, so do not invite a re-send.
			finish({
				type: 'steering',
				id: options.id,
				verdict: 'unknown',
				detail: 'the steering channel closed before reporting a verdict',
			});
		});
	});
}
