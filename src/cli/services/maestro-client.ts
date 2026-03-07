// CLI WebSocket client for communicating with the running Maestro desktop app.
// Uses the discovery file from cli-server-discovery to find the server.

import WebSocket from 'ws';
import { readCliServerInfo, isCliServerRunning } from '../../shared/cli-server-discovery';
import { readSessions } from './storage';

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

		const url = `ws://localhost:${info.port}/${info.token}/ws`;

		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (this.ws) {
					this.ws.close();
					this.ws = null;
				}
				reject(new Error('Connection to Maestro timed out'));
			}, CONNECT_TIMEOUT_MS);

			const ws = new WebSocket(url);

			ws.on('open', () => {
				clearTimeout(timeout);
				this.ws = ws;
				this.setupMessageHandler();
				resolve();
			});

			ws.on('error', (err) => {
				clearTimeout(timeout);
				this.ws = null;
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

			this.ws!.send(JSON.stringify(message));
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

		this.ws.on('message', (data) => {
			try {
				const msg = JSON.parse(data.toString()) as Record<string, unknown>;
				const msgType = msg.type as string;

				// Match response to the first pending request expecting this type
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
		console.error('Error: No sessions found. Create a session in Maestro first.');
		process.exit(1);
	}

	return sessions[0].id;
}

/**
 * Helper: create client, connect, run action, disconnect.
 * Handles the connect/disconnect lifecycle for one-shot commands.
 */
export async function withMaestroClient<T>(action: (client: MaestroClient) => Promise<T>): Promise<T> {
	const client = new MaestroClient();
	try {
		await client.connect();
		return await action(client);
	} finally {
		client.disconnect();
	}
}
