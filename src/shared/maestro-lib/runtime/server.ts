/**
 * Serve a runtime over the desktop bridge's WebSocket: the transport of `maestro-cli host`.
 *
 * Another process attaches with `createWsMaestroClient` the same way it attaches to a desktop:
 * `ws://127.0.0.1:<port>/<token>/ws`, the CLI secret in `x-maestro-cli-secret`, a `connected`
 * frame, then typed requests answered by request id and pushes for everything the runtime does.
 * The messages are the desktop bridge's (`server-requests.ts`, `server-frames.ts`), so `status`,
 * `dispatch`, and the TUI need no second protocol for a host with no window.
 *
 * Network rules, in order: loopback only; the token is the path and the secret is a header, and both
 * must match (the desktop asks for the secret only under Web Login, but a detached host has no
 * session cookie to fall back on); a request carrying an `Origin` is a browser and is refused, so a
 * page cannot reach a host whose token it somehow learned. Nothing resumes: a reconnecting client
 * is told `resumed: false` and re-reads the snapshot, which is what the library client does when a
 * host cannot replay.
 *
 * Design: `Plans/maestro-tui-runtime.md` section 2 (the wrappers) and `Plans/maestro-tui-autorun-engine.md` section 4.8.
 */

import * as crypto from 'crypto';
import * as http from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';

import { CLI_SECRET_HEADER } from '../../webLogin';
import {
	HOST_STATUS_MESSAGE,
	HOST_STATUS_REPLY,
	HOST_STOP_MESSAGE,
	HOST_STOP_REPLY,
	hostHasWork,
	type HostCueState,
	type HostStatusReport,
	type HostWork,
} from '../client/host-control';
import { logger } from '../host';
import type { MaestroRuntime } from './index';
import { autoRunStateFrame, createFrameState, framesForEvent, type Frame } from './server-frames';
import { createRequestHandler } from './server-requests';

const LOG_CONTEXT = '[RuntimeServer]';

/** An image rides `enqueue_command` as a data URL, so the cap is generous. */
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

export interface RuntimeServerOptions {
	runtime: MaestroRuntime;
	/** The path segment every request must name. */
	token: string;
	/** The `x-maestro-cli-secret` header every request must carry. */
	cliSecret: string;
	/** Default 0: the system picks one, and the caller publishes it in `cli-server.json`. */
	port?: number;
	/** Default `127.0.0.1`. */
	address?: string;
	/** The host agreed to stop and said so; the caller shuts the process down. */
	onStopRequested(): void;
	/** What only the host process knows: where Cue stands, and the build version. */
	describe?(): { cue: HostCueState; version?: string };
}

export interface RuntimeServer {
	readonly port: number;
	readonly epoch: string;
	/** Clients attached right now. */
	clients(): number;
	/** Drop every client and stop listening. Does not touch the runtime. */
	close(): Promise<void>;
}

function sameSecret(expected: string, given: string | undefined): boolean {
	if (given === undefined) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(given);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function refuse(socket: Duplex, status: string): void {
	socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
	socket.destroy();
}

export async function startRuntimeServer(options: RuntimeServerOptions): Promise<RuntimeServer> {
	const { runtime } = options;
	const epoch = crypto.randomUUID();
	const handle = createRequestHandler(runtime);
	const frameState = createFrameState();
	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
	const sockets = new Set<WebSocket>();
	const expectedPath = `/${options.token}/ws`;
	let seq = 0;

	const server = http.createServer((_request, response) => {
		response.writeHead(404).end();
	});

	server.on('upgrade', (request, socket, head) => {
		if (request.headers.origin !== undefined) return refuse(socket, '403 Forbidden');
		const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
		const header = request.headers[CLI_SECRET_HEADER];
		const secret = Array.isArray(header) ? header[0] : header;
		if (!sameSecret(expectedPath, pathname) || !sameSecret(options.cliSecret, secret)) {
			return refuse(socket, '401 Unauthorized');
		}
		wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
	});

	const send = (ws: WebSocket, frame: Frame): void => {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
	};

	/** A push every attached client hears, numbered the way the desktop numbers its own. */
	const broadcast = (frame: Frame): void => {
		const numbered = { ...frame, seq: ++seq };
		for (const ws of sockets) send(ws, numbered);
	};

	const work = (): HostWork => ({
		turns: runtime.turnsInFlight(),
		runs: runtime.runs.activeRuns(),
	});

	const statusReport = (): HostStatusReport => {
		const described = options.describe?.() ?? { cue: { state: 'disabled' as const } };
		const startedAt = Date.parse(runtime.lock.startedAt);
		return {
			pid: runtime.lock.pid,
			startedAt,
			uptimeMs: Math.max(0, Date.now() - startedAt),
			...(described.version ? { version: described.version } : {}),
			lock: runtime.lock,
			clients: sockets.size,
			work: work(),
			cue: described.cue,
		};
	};

	/** The host's own messages, which the desktop bridge does not have. `afterSend` runs once the reply is out. */
	function hostControlAnswer(
		message: Record<string, unknown>
	): { frame: Frame; afterSend?: () => void } | undefined {
		if (message.type === HOST_STATUS_MESSAGE) {
			return { frame: { type: HOST_STATUS_REPLY, report: statusReport() } };
		}
		if (message.type !== HOST_STOP_MESSAGE) return undefined;
		const current = work();
		if (message.force !== true && hostHasWork(current)) {
			return {
				frame: { type: HOST_STOP_REPLY, stopping: false, reason: 'work-in-flight', work: current },
			};
		}
		// Stopping closes this socket, so the reply goes first.
		return {
			frame: { type: HOST_STOP_REPLY, stopping: true },
			afterSend: () => setImmediate(options.onStopRequested),
		};
	}

	async function onMessage(ws: WebSocket, raw: string): Promise<void> {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return;
		}
		const requestId = message.requestId;
		const reply = (frame: Frame, afterSend?: () => void): void => {
			const numbered = requestId === undefined ? frame : { ...frame, requestId };
			if (ws.readyState !== WebSocket.OPEN) return;
			ws.send(JSON.stringify(numbered), () => afterSend?.());
		};
		try {
			const control = hostControlAnswer(message);
			if (control) {
				reply(control.frame, control.afterSend);
				return;
			}
			const answer = await handle(message);
			if (answer) {
				reply(answer);
				return;
			}
			// What a desktop does with a message it does not know: echo it, which a client reads as "unsupported".
			reply({
				type: 'echo',
				originalType: message.type,
				...(requestId !== undefined ? { originalRequestId: requestId } : {}),
				data: message,
			});
		} catch (error) {
			logger.warn(
				`A ${String(message.type)} request failed: ${error instanceof Error ? error.message : String(error)}`,
				LOG_CONTEXT
			);
			reply({
				type: 'error',
				success: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	wss.on('connection', (ws: WebSocket) => {
		sockets.add(ws);
		ws.on('close', () => sockets.delete(ws));
		ws.on('error', () => sockets.delete(ws));
		ws.on('message', (data) => void onMessage(ws, data.toString()));

		send(ws, { type: 'connected', bridgeEpoch: epoch, bridgeSeq: seq, resumed: false });
		// A client that attaches mid-run learns of it: a run is known only from its progress frames.
		for (const run of runtime.runs.activeRuns()) {
			const state = runtime.runs.latestState(run.agentId);
			if (state) send(ws, autoRunStateFrame(run.agentId, state));
		}
	});

	const unsubscribe = runtime.events.subscribe((event) => {
		for (const frame of framesForEvent(event, frameState)) broadcast(frame);
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port ?? 0, options.address ?? '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('The server has no TCP address.');

	return {
		port: address.port,
		epoch,
		clients: () => sockets.size,
		close: async () => {
			unsubscribe();
			for (const ws of sockets) ws.terminate();
			sockets.clear();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections?.();
			});
		},
	};
}
