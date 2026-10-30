// WebSocket connection to the running Maestro desktop app's bridge: send a
// message, wait for its typed reply. Uses the discovery file (./discovery) to
// find the server.
//
// Moved into maestro-lib from src/cli/services/maestro-client.ts, where the
// class was `MaestroClient`. In the library that name belongs to the client
// interface the TUI programs against (Plans/maestro-tui-client-api.md, decision
// C8), so the class is `BridgeConnection` here. The CLI keeps `MaestroClient`
// and `withMaestroClient` as aliases, so maestro-cli does not change.

import WebSocket from 'ws';
import { isIP } from 'net';
import {
	readCliServerInfo,
	readCliServerInfoFrom,
	isCliServerRunning,
	isPidAlive,
	type CliServerInfo,
} from './discovery';
import { CLI_SECRET_HEADER } from '../../webLogin';
import { MaestroNotRunningError } from './not-running';

const CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10000;

/**
 * Thrown when the running app echoes a command back unhandled - i.e. it does
 * not recognize the message type. From a desktop this almost always means the
 * app is an older build than this client (a new command was added since the app
 * was last built/restarted). Carrying a distinct type lets callers map it to the
 * `Unsupported` exit code and print a "rebuild/restart the app" hint instead of
 * a generic timeout.
 *
 * A headless host (`maestro-cli host`) echoes too, for a different reason: it
 * serves the runtime's commands and has no window to serve the rest with. So
 * the message names the peer that answered, and does not send someone with no
 * desktop running off to restart one.
 */
export class UnsupportedCommandError extends Error {
	readonly commandType: string;
	constructor(commandType: string, hostKind?: CliServerInfo['hostKind']) {
		super(
			hostKind === 'headless'
				? `The headless Maestro host (\`maestro-cli host\`) does not support the '${commandType}' command. ` +
						'It may need the desktop app, or a newer build of the host.'
				: `The running Maestro app does not support the '${commandType}' command. ` +
						'It is likely an older build - rebuild and restart the desktop app, then retry.'
		);
		this.name = 'UnsupportedCommandError';
		this.commandType = commandType;
	}
}

/** Thrown when the app was reachable but did not answer a command in time. */
export class CommandTimeoutError extends Error {
	readonly responseType: string;
	constructor(responseType: string) {
		super(
			`Timed out waiting for the Maestro app to respond (expected '${responseType}'). ` +
				'The app is reachable but its renderer did not reply - it may be busy or unresponsive.'
		);
		this.name = 'CommandTimeoutError';
		this.responseType = responseType;
	}
}

/**
 * Thrown when the socket ended with a call in flight (`closedByCaller: false`),
 * or when the caller disconnected first (`closedByCaller: true`). The messages
 * are the ones the CLI has always printed.
 */
export class ConnectionClosedError extends Error {
	readonly closedByCaller: boolean;
	readonly code?: number;
	readonly reason?: string;
	constructor(options: { closedByCaller: boolean; code?: number; reason?: string }) {
		super(
			options.closedByCaller
				? 'Client disconnected'
				: `Connection closed${options.code ? ` (code=${options.code})` : ''}${
						options.reason ? `: ${options.reason}` : ''
					}`
		);
		this.name = 'ConnectionClosedError';
		this.closedByCaller = options.closedByCaller;
		this.code = options.code;
		this.reason = options.reason;
	}
}

/**
 * Options that keep the CLI's behavior as the default: a bare
 * `new BridgeConnection()` reads the no-argument discovery, matches a reply by
 * type when its request id is unknown, and reports nothing but replies.
 */
export interface BridgeConnectionOptions {
	/** Read discovery from this data dir instead of the CLI's own derivation. */
	userDataDir?: string;
	/** Extra query parameters on the upgrade URL (`since`, `epoch` for resume). */
	query?: Record<string, string | number>;
	/**
	 * Match a reply by `requestId` only. With several calls in flight, a late
	 * reply to a timed-out call would otherwise resolve the wrong call. A call
	 * opts back into type matching with `matchByType` for the replies the host
	 * sends without a request id.
	 */
	strictReplies?: boolean;
	/** Every parsed frame that is not the reply to a pending call. */
	onFrame?: (frame: Record<string, unknown>) => void;
	/** The socket closed (not called for `disconnect()`). */
	onClose?: (code: number | undefined, reason: string | undefined) => void;
	/** Test seam. */
	WebSocketImpl?: typeof WebSocket;
}

export interface SendCommandOptions {
	/** Accept a reply of the expected type that carries no (or an unknown) request id. */
	matchByType?: boolean;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
	expectedType: string;
	/** The `type` of the message that was sent, used to match unhandled echoes. */
	sentType: string;
	/** May this call be resolved by a reply of its expected type with no request id? */
	matchByType: boolean;
}

export class BridgeConnection {
	private ws: WebSocket | null = null;
	private pendingRequests: Map<string, PendingRequest> = new Map();
	/** What kind of peer the discovery file named, so an error can say who refused. */
	private hostKind: CliServerInfo['hostKind'];

	constructor(private readonly options: BridgeConnectionOptions = {}) {}

	/**
	 * Connect to the running Maestro app.
	 * Throws `MaestroNotRunningError` when no host is running or reachable.
	 */
	async connect(): Promise<void> {
		const info: CliServerInfo | null = this.options.userDataDir
			? readCliServerInfoFrom(this.options.userDataDir)
			: readCliServerInfo();
		if (!info) {
			throw new MaestroNotRunningError('no-discovery-file');
		}
		this.hostKind = info.hostKind;

		const remoteHost = process.env.MAESTRO_CLI_HOST?.trim();
		// The discovery PID belongs to the desktop host, not an SSH remote.
		if (!remoteHost) {
			const alive = this.options.userDataDir ? isPidAlive(info.pid) : isCliServerRunning();
			if (!alive) {
				throw new MaestroNotRunningError(
					'stale-discovery-file',
					`pid ${info.pid} is gone (app may have crashed)`
				);
			}
		}

		// Validate before adding the token: ws includes invalid URLs in its errors.
		let host = remoteHost || '127.0.0.1';
		if (remoteHost) {
			try {
				if (/[\s/@?#\\%]/.test(host)) throw new Error('Not a bare host');
				if (isIP(host) === 6) host = `[${host}]`;
				const parsed = new URL(`ws://${host}`);
				const hostname = parsed.hostname;
				const isIpv6 = hostname.startsWith('[') && isIP(hostname.slice(1, -1)) === 6;
				const isHostname =
					/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?$/i.test(
						hostname
					);
				if ((!isIpv6 && !isHostname) || parsed.pathname !== '/' || host.endsWith(':')) {
					throw new Error('Not a bare host');
				}
			} catch {
				throw new Error(
					'Invalid MAESTRO_CLI_HOST: expected a hostname or IP address, optionally with a port'
				);
			}
		}
		const query = this.options.query
			? `?${new URLSearchParams(
					Object.entries(this.options.query).map(([key, value]): [string, string] => [
						key,
						String(value),
					])
				).toString()}`
			: '';
		// Keep the original IPv4 loopback URL when no override is configured.
		const hasPort = host.startsWith('[') ? host.includes(']:') : host.includes(':');
		const authority = hasPort ? host : `${host}:${info.port}`;
		const url = `ws://${authority}/${info.token}/ws${query}`;
		const WebSocketCtor = this.options.WebSocketImpl ?? WebSocket;

		return new Promise<void>((resolve, reject) => {
			let settled = false;

			// The per-boot secret is what admits the CLI when Web Login is on; the
			// server never exempts a caller by address (the tunnel is loopback too).
			const ws = new WebSocketCtor(
				url,
				info.cliSecret ? { headers: { [CLI_SECRET_HEADER]: info.cliSecret } } : undefined
			);

			const timeout = setTimeout(() => {
				if (!settled) {
					settled = true;
					ws.close();
					reject(new MaestroNotRunningError('connect-timeout'));
				}
			}, CONNECT_TIMEOUT_MS);

			ws.on('open', () => {
				if (settled) {
					ws.close();
					return;
				}
				settled = true;
				clearTimeout(timeout);
				this.ws = ws;
				this.setupMessageHandler();
				resolve();
			});

			ws.on('error', (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				// A socket-level failure carries an errno (ECONNREFUSED, ...): nothing
				// is listening. An HTTP rejection of the upgrade has none - the app
				// answered and said no, so it is running and keeps its own error.
				if ((err as NodeJS.ErrnoException).code) {
					reject(new MaestroNotRunningError('connect-failed', err.message));
				} else {
					reject(new Error(`Failed to connect to Maestro: ${err.message}`));
				}
			});
		});
	}

	/**
	 * Send a message and wait for a typed response.
	 */
	async sendCommand<T>(
		message: Record<string, unknown>,
		responseType: string,
		timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
		commandOptions: SendCommandOptions = {}
	): Promise<T> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('Not connected to Maestro');
		}

		const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const sentType = typeof message.type === 'string' ? message.type : 'unknown';

		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(requestId);
				reject(new CommandTimeoutError(responseType));
			}, timeoutMs);

			this.pendingRequests.set(requestId, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timeout,
				expectedType: responseType,
				sentType,
				matchByType: !this.options.strictReplies || commandOptions.matchByType === true,
			});

			this.ws!.send(JSON.stringify({ ...message, requestId }));
		});
	}

	/** Send a message that expects no reply (a heartbeat `ping`). */
	send(message: Record<string, unknown>): boolean {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
		this.ws.send(JSON.stringify(message));
		return true;
	}

	/** Whether the socket is open. */
	get isOpen(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
	}

	/**
	 * Disconnect gracefully.
	 */
	disconnect(): void {
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(new ConnectionClosedError({ closedByCaller: true }));
		}
		this.pendingRequests.clear();

		if (this.ws) {
			// Detach first so a caller-initiated close is not reported as a drop.
			this.ws.removeAllListeners('close');
			this.ws.close();
			this.ws = null;
		}
	}

	private setupMessageHandler(): void {
		if (!this.ws) return;

		this.ws.on('close', (code?: number, reason?: Buffer) => {
			const reasonStr = reason?.toString();
			for (const [, pending] of this.pendingRequests) {
				clearTimeout(pending.timeout);
				pending.reject(
					new ConnectionClosedError({ closedByCaller: false, code, reason: reasonStr })
				);
			}
			this.pendingRequests.clear();
			this.ws = null;
			this.options.onClose?.(code, reasonStr || undefined);
		});

		this.ws.on('message', (data) => {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(data.toString()) as Record<string, unknown>;
			} catch {
				// Ignore non-JSON messages
				return;
			}
			if (!this.resolvePending(msg)) this.options.onFrame?.(msg);
		});
	}

	/** Settle the pending call a frame answers. Returns false when it answers none. */
	private resolvePending(msg: Record<string, unknown>): boolean {
		const msgType = msg.type as string;
		const msgRequestId = msg.requestId as string | undefined;

		// An `echo` reply means the app didn't recognize the message type
		// (handleUnknown). Reject the matching request immediately with a
		// clear "unsupported command" error instead of waiting for the
		// full timeout - this is the signal that the running app is an
		// older build than this CLI. The original message (with its
		// requestId) is echoed back under `data`.
		if (msgType === 'echo') {
			const original = msg.data as Record<string, unknown> | undefined;
			const originalReqId =
				(original?.requestId as string | undefined) ??
				(msg.originalRequestId as string | undefined);
			const originalType =
				(msg.originalType as string | undefined) ??
				(original?.type as string | undefined) ??
				'unknown';
			if (originalReqId && this.pendingRequests.has(originalReqId)) {
				const pending = this.pendingRequests.get(originalReqId)!;
				clearTimeout(pending.timeout);
				this.pendingRequests.delete(originalReqId);
				pending.reject(new UnsupportedCommandError(originalType, this.hostKind));
				return true;
			}
			// Fall back to matching by the echoed command type.
			for (const [reqId, pending] of this.pendingRequests) {
				if (pending.matchByType && pending.sentType === originalType) {
					clearTimeout(pending.timeout);
					this.pendingRequests.delete(reqId);
					pending.reject(new UnsupportedCommandError(originalType, this.hostKind));
					return true;
				}
			}
			return true;
		}

		// Try matching by requestId first (exact match)
		if (msgRequestId && this.pendingRequests.has(msgRequestId)) {
			const pending = this.pendingRequests.get(msgRequestId)!;
			clearTimeout(pending.timeout);
			this.pendingRequests.delete(msgRequestId);
			pending.resolve(msg);
			return true;
		}

		// Fall back to matching by response type
		for (const [requestId, pending] of this.pendingRequests) {
			if (pending.matchByType && pending.expectedType === msgType) {
				clearTimeout(pending.timeout);
				this.pendingRequests.delete(requestId);
				pending.resolve(msg);
				return true;
			}
		}
		return false;
	}
}

/**
 * Helper: create a connection, connect, run action, disconnect.
 * Handles the connect/disconnect lifecycle for one-shot commands.
 */
export async function withBridgeConnection<T>(
	action: (connection: BridgeConnection) => Promise<T>
): Promise<T> {
	const connection = new BridgeConnection();
	try {
		await connection.connect();
		return await action(connection);
	} finally {
		connection.disconnect();
	}
}
