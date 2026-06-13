// CLI WebSocket client for communicating with the running Maestro desktop app.
// Uses the discovery file from cli-server-discovery to find the server.

import WebSocket from 'ws';
import { readCliServerInfo, isCliServerRunning } from '../../shared/cli-server-discovery';
import { getSessionById, readSessions, readSettings, resolveAgentId } from './storage';

const CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10000;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
	expectedType: string;
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

		// Use 127.0.0.1 instead of `localhost` — Node 18's default DNS resolution
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

		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(requestId);
				reject(new Error(`Command timed out waiting for ${responseType}`));
			}, timeoutMs);

			this.pendingRequests.set(requestId, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timeout,
				expectedType: responseType,
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
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(data.toString()) as Record<string, unknown>;
			} catch (error) {
				this.rejectAllPending(new Error('Invalid message from Maestro desktop app'));
				throw error;
			}

			const msgType = msg.type as string;
			const msgRequestId = msg.requestId as string | undefined;

			if (msgRequestId) {
				const pending = this.pendingRequests.get(msgRequestId);
				if (!pending) return;
				if (pending.expectedType !== msgType && msgType !== 'error') return;
				this.settleRequest(msgRequestId, pending, msg);
				return;
			}

			const matchingRequests = [...this.pendingRequests.entries()].filter(
				([, pending]) => pending.expectedType === msgType
			);
			if (matchingRequests.length === 1) {
				const [requestId, pending] = matchingRequests[0];
				this.settleRequest(requestId, pending, msg);
			} else if (matchingRequests.length > 1) {
				const error = new Error(`Ambiguous ${msgType} response without requestId`);
				for (const [requestId, pending] of matchingRequests) {
					clearTimeout(pending.timeout);
					this.pendingRequests.delete(requestId);
					pending.reject(error);
				}
			}
		});
	}

	private settleRequest(
		requestId: string,
		pending: PendingRequest,
		msg: Record<string, unknown>
	): void {
		clearTimeout(pending.timeout);
		this.pendingRequests.delete(requestId);
		if (msg.type === 'error' || msg.success === false) {
			const message =
				typeof msg.error === 'string'
					? msg.error
					: typeof msg.message === 'string'
						? msg.message
						: 'Command failed';
			pending.reject(new Error(message));
			return;
		}
		pending.resolve(msg);
	}

	private rejectAllPending(error: Error): void {
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}
}

/**
 * Resolve session ID from CLI options.
 * Uses the provided --session value, or falls back to the first available session.
 */
export function resolveSessionId(options: { session?: string } = {}): string {
	if (options.session) {
		return options.session;
	}

	const settings = readSettings();
	if (typeof settings.activeSessionId === 'string' && getSessionById(settings.activeSessionId)) {
		return settings.activeSessionId;
	}

	const sessions = readSessions();
	if (sessions.length === 0) {
		throw new Error('No Maestro sessions found. Pass --session <id> to target a specific session.');
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
 * read in `readSessions`) re-throws so it surfaces as a stack trace — per the
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
