// The control channel maestro-p listens on so a running turn can be steered.
//
// Transport: a unix domain socket (a named pipe on Windows - `net` covers both
// with one API), path handed in through MAESTRO_P_STEERING_SOCKET. Absent means
// no channel is opened at all, which is the default: a turn nobody can steer
// should not create a socket.
//
// Why not stdin, which already reaches the process
// ------------------------------------------------
// maestro-p reads a piped prompt with a SYNCHRONOUS read to EOF
// (`fs.readFileSync(0, 'utf-8')` in args.ts), and that is the path Maestro uses
// for every image turn (`--input-format stream-json`). stdin is therefore fully
// consumed before the turn even starts, so a control frame written there could
// never be seen. The spawner also calls `stdin.end()` immediately after writing
// the prompt. Reworking that read into a streaming parser would mean changing how
// every prompt arrives - a large blast radius for a channel that does not need to
// share a pipe with the prompt.
//
// Framing: newline-delimited JSON, one frame per line, in both directions. A
// frame that does not parse is ignored rather than fatal - this socket is
// reachable by anything with the path, and a malformed line must not be able to
// kill a turn that is midway through real work.

import * as fs from 'fs';
import * as net from 'net';

import { parseSteeringRequest, type SteeringResultFrame } from './steering';

export interface SteeringServerOptions {
	socketPath: string;
	/**
	 * Handle one request. Resolves with the verdict to send back. Never rejects:
	 * the server treats a throw as an internal error and answers `unknown`, because
	 * a caller blocked on a reply must always get one.
	 */
	onSteer: (id: string, text: string) => Promise<SteeringResultFrame>;
	/** Diagnostics sink. Defaults to stderr. */
	warn?: (message: string) => void;
}

export interface SteeringServer {
	/** Stop listening and remove the socket file. Safe to call more than once. */
	close: () => void;
}

/**
 * Listen for steering frames on `socketPath`.
 *
 * Returns null when the socket cannot be created. That is deliberately NOT fatal:
 * the turn is the product and steering is an accessory, so a run whose channel
 * fails to open must still do the work and simply be un-steerable. The reason
 * goes to stderr where the rest of maestro-p's diagnostics live.
 */
export function startSteeringServer(options: SteeringServerOptions): SteeringServer | null {
	const warn = options.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

	// A stale socket file from a crashed predecessor makes listen() fail with
	// EADDRINUSE, which would cost every later run its channel. Nothing else owns
	// this path (the caller mints a per-run name), so removing it is safe.
	try {
		if (process.platform !== 'win32' && fs.existsSync(options.socketPath)) {
			fs.unlinkSync(options.socketPath);
		}
	} catch {
		// Fall through: listen() will report it if it still matters.
	}

	let server: net.Server;
	try {
		server = net.createServer();
	} catch (err) {
		warn(
			`maestro-p: could not create the steering channel (${String(err)}); this turn cannot be steered.`
		);
		return null;
	}

	server.on('connection', (socket) => {
		socket.setEncoding('utf8');
		let buffer = '';
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			// Guard against a peer that never sends a newline: a control frame is a
			// sentence, so anything past the cap is not a frame we are waiting to
			// complete, and holding it would grow without bound.
			if (buffer.length > MAX_PENDING_LINE_BYTES) {
				warn('maestro-p: steering channel received an oversized frame; dropping it.');
				buffer = '';
				return;
			}
			let newline = buffer.indexOf('\n');
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				void handleLine(line);
				newline = buffer.indexOf('\n');
			}
		});
		socket.on('error', () => {
			// A peer that hangs up mid-frame is ordinary, not exceptional.
		});

		const handleLine = async (line: string): Promise<void> => {
			const request = parseSteeringRequest(line);
			if (!request) {
				if (line.trim()) warn('maestro-p: ignoring an unrecognized steering frame.');
				return;
			}
			let result: SteeringResultFrame;
			try {
				result = await options.onSteer(request.id, request.text);
			} catch (err) {
				// The caller is blocked on an answer. Reporting `unknown` tells it the
				// truth (nobody knows what happened to the text) where a dropped reply
				// would leave it waiting for its own timeout.
				result = {
					type: 'steering',
					id: request.id,
					verdict: 'unknown',
					detail: `the steering attempt failed internally: ${String(err)}`,
				};
			}
			try {
				socket.write(`${JSON.stringify(result)}\n`);
			} catch {
				// Peer gone. The verdict also goes to stdout, so it is not lost.
			}
		};
	});

	server.on('error', (err) => {
		warn(`maestro-p: steering channel error (${String(err)}); this turn cannot be steered.`);
	});

	try {
		server.listen(options.socketPath);
	} catch (err) {
		warn(
			`maestro-p: could not listen on the steering channel (${String(err)}); this turn cannot be steered.`
		);
		return null;
	}

	// Never hold the process open. maestro-p exits when the TURN is done, and a
	// listening socket is a libuv handle that would outlive it and hang the run.
	server.unref();

	let closed = false;
	return {
		close: () => {
			if (closed) return;
			closed = true;
			try {
				server.close();
			} catch {
				// Already down.
			}
			try {
				if (process.platform !== 'win32' && fs.existsSync(options.socketPath)) {
					fs.unlinkSync(options.socketPath);
				}
			} catch {
				// Best effort - a leftover socket file only costs the next run an unlink.
			}
		},
	};
}

/** Cap on one un-terminated control line. A steer is a sentence, not a stream. */
export const MAX_PENDING_LINE_BYTES = 64 * 1024;
