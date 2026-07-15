// CLI WebSocket client for communicating with the running Maestro desktop app.
// Uses the discovery file from cli-server-discovery to find the server.

import WebSocket from 'ws';
import { readCliServerInfo, isCliServerRunning } from '../../shared/cli-server-discovery';
import { readSessions, resolveAgentId } from './storage';

const CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10000;

/**
 * Thrown when the running app echoes a command back unhandled - i.e. it does
 * not recognize the message type. This almost always means the desktop app is
 * an older build than this CLI (a new command was added since the app was last
 * built/restarted). Carrying a distinct type lets callers map it to the
 * `Unsupported` exit code and print a "rebuild/restart the app" hint instead of
 * a generic timeout.
 */
export class UnsupportedCommandError extends Error {
	readonly commandType: string;
	constructor(commandType: string) {
		super(
			`The running Maestro app does not support the '${commandType}' command. ` +
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

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
	expectedType: string;
	/** The `type` of the message that was sent, used to match unhandled echoes. */
	sentType: string;
}

export class MaestroClient {
	private ws: WebSocket | null = null;
	private pendingRequests: Map<string, PendingRequest> = new Map();

	/**
	 * Connect to the running Maestro app.
	 * Throws if the app is not running or connection fails.
	 */
	async connect(): Promise<void> {
		const info = readCliServerInfo();
		if (!info) {
			throw new Error('Maestro desktop app is not running');
		}

		if (!isCliServerRunning()) {
			throw new Error('Maestro discovery file is stale (app may have crashed)');
		}

		// Use 127.0.0.1 instead of `localhost` - Node 18's default DNS resolution
		// resolves `localhost` to IPv6 (::1) first, but the desktop app binds to
		// 0.0.0.0 (IPv4 only), so `localhost` yields ECONNREFUSED on ::1.
		const url = `ws://127.0.0.1:${info.port}/${info.token}/ws`;

		return new Promise<void>((resolve, reject) => {
			let settled = false;

			const ws = new WebSocket(url);

			const timeout = setTimeout(() => {
				if (!settled) {
					settled = true;
					ws.close();
					reject(new Error('Connection to Maestro timed out'));
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
				reject(new Error(`Failed to connect to Maestro: ${err.message}`));
			});
		});
	}

	/**
	 * Send a message and wait for a typed response.
	 */
	async sendCommand<T>(
		message: Record<string, unknown>,
		responseType: string,
		timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS
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
			});

			this.ws!.send(JSON.stringify({ ...message, requestId }));
		});
	}

	/**
	 * Disconnect gracefully.
	 */
	disconnect(): void {
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(new Error('Client disconnected'));
		}
		this.pendingRequests.clear();

		if (this.ws) {
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
					new Error(
						`Connection closed${code ? ` (code=${code})` : ''}${reasonStr ? `: ${reasonStr}` : ''}`
					)
				);
			}
			this.pendingRequests.clear();
			this.ws = null;
		});

		this.ws.on('message', (data) => {
			try {
				const msg = JSON.parse(data.toString()) as Record<string, unknown>;
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
						pending.reject(new UnsupportedCommandError(originalType));
						return;
					}
					// Fall back to matching by the echoed command type.
					for (const [reqId, pending] of this.pendingRequests) {
						if (pending.sentType === originalType) {
							clearTimeout(pending.timeout);
							this.pendingRequests.delete(reqId);
							pending.reject(new UnsupportedCommandError(originalType));
							return;
						}
					}
					return;
				}

				// Try matching by requestId first (exact match)
				if (msgRequestId && this.pendingRequests.has(msgRequestId)) {
					const pending = this.pendingRequests.get(msgRequestId)!;
					clearTimeout(pending.timeout);
					this.pendingRequests.delete(msgRequestId);
					pending.resolve(msg);
					return;
				}

				// Fall back to matching by response type
				for (const [requestId, pending] of this.pendingRequests) {
					if (pending.expectedType === msgType) {
						clearTimeout(pending.timeout);
						this.pendingRequests.delete(requestId);
						pending.resolve(msg);
						return;
					}
				}
			} catch {
				// Ignore non-JSON messages
			}
		});
	}
}

/**
 * Resolve session ID from CLI options.
 * Uses the provided --session value, or falls back to the first available session.
 */
export function resolveSessionId(options: { session?: string }): string {
	if (options.session) {
		return options.session;
	}

	const sessions = readSessions();
	if (sessions.length === 0) {
		console.error('Error: No agents found. Create an agent in Maestro first.');
		process.exit(1);
	}

	return sessions[0].id;
}

/**
 * Resolve a target agent (sessionId) from an optional `--agent` value, or fall
 * back to the first available agent. Centralizes the duplicated try/catch +
 * resolveSessionId pattern that several desktop-handoff verbs share.
 *
 * Only the known `resolveAgentId` errors (ambiguous / not-found) get the
 * friendly stderr + exit(1) treatment. Anything else (e.g. corrupted store
 * read in `readSessions`) re-throws so it surfaces as a stack trace - per the
 * codebase's "let exceptions bubble up" rule for unexpected failures.
 */
export function resolveTargetSessionId(agent?: string): string {
	if (agent) {
		try {
			return resolveAgentId(agent);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const isExpected =
				message.startsWith('Ambiguous agent ID') || message.startsWith('Agent not found:');
			if (!isExpected) {
				throw error;
			}
			console.error(`Error: ${message}`);
			process.exit(1);
		}
	}
	return resolveSessionId({});
}

/**
 * Helper: create client, connect, run action, disconnect.
 * Handles the connect/disconnect lifecycle for one-shot commands.
 */
export async function withMaestroClient<T>(
	action: (client: MaestroClient) => Promise<T>
): Promise<T> {
	const client = new MaestroClient();
	try {
		await client.connect();
		return await action(client);
	} finally {
		client.disconnect();
	}
}
