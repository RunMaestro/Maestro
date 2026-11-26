// The client half of maestro-p's chat-steering socket (protocol in
// src/shared/chatSteering.ts, server in src/maestro-p/steering-server.ts).
//
// Node-only (it opens a socket), so it is kept out of chatSteering.ts, which the
// renderer imports for its types. Two callers share it, so the line between
// "refused" and "unknown" is drawn in one place:
//   - the main process, for a turn on this machine (process-manager/steering-client.ts);
//   - maestro-p's `--steer-relay` mode, for a turn on an SSH remote, where it runs
//     on the remote beside the turn (src/maestro-p/steering-relay.ts).

import * as net from 'net';

import {
	parseSteeringResult,
	type SteeringRequestFrame,
	type SteeringResultFrame,
} from './chatSteering';

export interface SteeringSocketRequest {
	socketPath: string;
	frame: SteeringRequestFrame;
	timeoutMs: number;
	/**
	 * Diagnostics for a failure that is not the ordinary "no channel" case. Never
	 * carries the steering text.
	 */
	warn?: (message: string, stage: 'connect' | 'mid-request') => void;
}

/**
 * Deliver one request frame to a steering socket and wait for its verdict.
 *
 * Always resolves, never rejects: every outcome is a thing to tell the user. The
 * one rule that matters is where `refused` ends and `unknown` begins. A failure
 * before the connection opened sent nothing, so the caller still owns the message
 * (`refused`, `not-running`). Anything after it may have followed a successful
 * write, so it is `unknown`: reporting a refusal there would invite a re-send that
 * doubles the message into the turn.
 */
export function requestSteeringOverSocket(
	request: SteeringSocketRequest
): Promise<SteeringResultFrame> {
	const { socketPath, frame, timeoutMs } = request;
	const id = frame.id;

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
			// is `unknown`, not `refused`.
			finish({
				type: 'steering',
				id,
				verdict: 'unknown',
				detail: 'maestro-p did not answer the steering request in time',
			});
		}, timeoutMs);

		// Whether the connection was ever established. Tracked rather than inferred
		// from the error code: a reset AFTER connecting may have followed a write.
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
					id,
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
				// Only a verdict for OUR id settles this call.
				if (parsed && parsed.id === id) {
					finish(parsed);
					return;
				}
				newline = buffer.indexOf('\n');
			}
		});

		socket.on('error', (err: NodeJS.ErrnoException) => {
			// Never connected is the ordinary "this turn has no channel" case: the agent
			// is on the API token source, the turn already finished, or this build of
			// maestro-p predates steering. Nothing was sent.
			if (!connected) {
				const expected = err.code === 'ENOENT' || err.code === 'ECONNREFUSED';
				if (!expected) request.warn?.(err.message, 'connect');
				finish({
					type: 'steering',
					id,
					verdict: 'refused',
					refusal: 'not-running',
					detail: 'this turn is not steerable - no steering channel is open for it',
				});
				return;
			}
			request.warn?.(err.message, 'mid-request');
			finish({
				type: 'steering',
				id,
				verdict: 'unknown',
				detail: `the steering channel failed before reporting a verdict: ${err.message}`,
			});
		});

		socket.on('close', () => {
			// Closed without a verdict: the text may have been typed.
			finish({
				type: 'steering',
				id,
				verdict: 'unknown',
				detail: 'the steering channel closed before reporting a verdict',
			});
		});
	});
}
