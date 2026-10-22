/**
 * A fake desktop bridge for the WebSocket client tests.
 *
 * A real `ws` server on 127.0.0.1 and a temp data dir whose `cli-server.json`
 * points at it, so the client runs its real discovery, handshake, and framing.
 * The server answers the way the desktop's handlers do (reply shapes read from
 * `src/main/web-server/handlers/`): a typed message gets its `*_result` reply
 * with the request id, `bridge.invoke` gets a `bridge.response`, an unknown
 * type is echoed, `ping` gets `pong`. It records everything the client sends.
 *
 * The frames the tests push are authored from those handlers' source, not
 * recorded from a running desktop (a recording would carry the user's agents).
 */

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type Frame = Record<string, unknown>;

export interface FakeConnection {
	url: string;
	headers: IncomingHttpHeaders;
	socket: WebSocket;
}

/** A typed-message responder: the reply object (with its `type`), several, or `'silent'`. */
export type TypedResponder = (message: Frame) => Frame | Frame[] | 'silent';

export const TOKEN = 'tok-0123456789abcdef';
export const CLI_SECRET = 'cli-secret-fedcba9876543210';

export class FakeBridge {
	readonly received: Frame[] = [];
	readonly connections: FakeConnection[] = [];
	readonly typed = new Map<string, TypedResponder>();
	readonly invokes = new Map<string, (args: unknown[]) => unknown>();

	epoch = 'epoch-1';
	seq = 10;
	/** What the next `connected` frame says about resuming. */
	resumed = false;
	/** Frames sent right after `connected` (a resume's replay). */
	replay: Frame[] = [];
	/** Close every new socket with this code after `connected`. */
	closeWith: number | undefined;
	/** When false the server never answers a ping. */
	answerPings = true;
	/** When false the server answers `bridge.invoke` with an `echo`, as a host that predates it does. */
	supportsInvoke = true;

	private constructor(
		private readonly server: WebSocketServer,
		readonly dataDir: string
	) {
		server.on('connection', (socket, request) => this.onConnection(socket, request));
	}

	static async start(): Promise<FakeBridge> {
		const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await new Promise<void>((resolve) => server.once('listening', resolve));
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-ws-client-'));
		const bridge = new FakeBridge(server, dataDir);
		bridge.writeDiscovery();
		return bridge;
	}

	get port(): number {
		return (this.server.address() as AddressInfo).port;
	}

	/** (Re)write `cli-server.json` for this server and this process, which is alive. */
	writeDiscovery(overrides: Record<string, unknown> = {}): void {
		fs.writeFileSync(
			path.join(this.dataDir, 'cli-server.json'),
			JSON.stringify({
				port: this.port,
				token: TOKEN,
				pid: process.pid,
				startedAt: 1_700_000_000_000,
				version: '9.9.9',
				cliSecret: CLI_SECRET,
				...overrides,
			})
		);
	}

	removeDiscovery(): void {
		fs.rmSync(path.join(this.dataDir, 'cli-server.json'), { force: true });
	}

	/** Messages the client sent, optionally of one type. */
	sent(type?: string): Frame[] {
		return type ? this.received.filter((m) => m.type === type) : this.received;
	}

	/** `bridge.invoke` messages for one channel. */
	invoked(channel: string): Frame[] {
		return this.received.filter((m) => m.type === 'bridge.invoke' && m.channel === channel);
	}

	clearReceived(): void {
		this.received.length = 0;
	}

	/** Push a frame to every client, stamped with the next sequence number. */
	push(frame: Frame, stamp = true): void {
		const data = JSON.stringify(stamp ? { ...frame, seq: ++this.seq } : frame);
		for (const { socket } of this.connections) {
			if (socket.readyState === socket.OPEN) socket.send(data);
		}
	}

	pushBridgeEvent(channel: string, ...args: unknown[]): void {
		this.push({ type: 'bridge.event', channel, args, timestamp: 1 });
	}

	/** Drop every client socket the way a vanished host does (the client sees code 1006). */
	dropAll(): void {
		for (const { socket } of this.connections) socket.terminate();
	}

	async stop(): Promise<void> {
		for (const { socket } of this.connections) socket.terminate();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
		fs.rmSync(this.dataDir, { recursive: true, force: true });
	}

	private onConnection(socket: WebSocket, request: import('node:http').IncomingMessage): void {
		this.connections.push({ url: request.url ?? '', headers: request.headers, socket });
		if (this.closeWith !== undefined) {
			// The Web Login gate closes the upgrade before it says anything.
			socket.close(this.closeWith, 'Login required');
			return;
		}
		socket.send(
			JSON.stringify({
				type: 'connected',
				clientId: `client-${this.connections.length}`,
				bridgeEpoch: this.epoch,
				bridgeSeq: this.seq,
				resumed: this.resumed,
				timestamp: 1,
			})
		);
		for (const frame of this.replay) socket.send(JSON.stringify(frame));
		socket.send(JSON.stringify({ type: 'sessions_list', sessions: [], timestamp: 1 }));
		socket.on('message', (data) => this.onMessage(socket, JSON.parse(data.toString()) as Frame));
	}

	private onMessage(socket: WebSocket, message: Frame): void {
		this.received.push(message);
		const send = (frame: Frame): void => {
			if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
		};
		const type = message.type as string;
		const requestId = message.requestId;

		if (type === 'ping') {
			if (this.answerPings) send({ type: 'pong' });
			return;
		}

		if (type === 'bridge.invoke' && !this.supportsInvoke) {
			send({ type: 'echo', data: message });
			return;
		}

		if (type === 'bridge.invoke') {
			const handler = this.invokes.get(message.channel as string);
			if (!handler) {
				send({
					type: 'bridge.response',
					requestId,
					ok: false,
					error: `No ipcMain handler registered for channel "${String(message.channel)}"`,
				});
				return;
			}
			try {
				const result = handler((message.args as unknown[]) ?? []);
				send({ type: 'bridge.response', requestId, ok: true, result });
			} catch (error) {
				send({
					type: 'bridge.response',
					requestId,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}

		const responder = this.typed.get(type);
		if (!responder) {
			// What the desktop's handleUnknown does with a type it does not know.
			send({ type: 'echo', data: message });
			return;
		}
		const reply = responder(message);
		if (reply === 'silent') return;
		for (const frame of Array.isArray(reply) ? reply : [reply]) {
			// `sessions_list` is the one reply the desktop sends without a request id.
			send(frame.type === 'sessions_list' ? frame : { ...frame, requestId });
		}
	}
}

/** An agent as `sessions:getBootstrap` returns it: stored fields, no transcripts. */
export function agentRecord(id: string, extra: Frame = {}): Frame {
	return {
		id,
		name: `Agent ${id}`,
		toolType: 'claude-code',
		state: 'idle',
		cwd: `/work/${id}`,
		aiTabs: [{ id: `${id}-t1`, name: 'main', state: 'idle', logs: [] }],
		activeTabId: `${id}-t1`,
		...extra,
	};
}

/** The process id the desktop gives a tab's turn. */
export function tabProcessId(agentId: string, tabId: string): string {
	return `${agentId}-ai-${tabId}`;
}
