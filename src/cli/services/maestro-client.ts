import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { readCliServerInfo, isCliServerRunning } from '../../shared/cli-server-discovery';
import { getSessionById, readSessions, readSettings } from './storage';

const CONNECT_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 10000;

interface MaestroMessage {
	type?: string;
	requestId?: string;
	success?: boolean;
	error?: string;
	message?: string;
	[key: string]: unknown;
}

interface PendingRequest<T> {
	responseType: string;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
	timeout: NodeJS.Timeout;
}

export interface SessionResolutionOptions {
	session?: string;
}

export class MaestroClient {
	private ws: WebSocket | null = null;
	private pendingRequests = new Map<string, PendingRequest<unknown>>();

	/** Connect to the running Maestro app. Throws if app not running. */
	async connect(): Promise<void> {
		const info = readCliServerInfo();
		if (!info) {
			throw new Error('Maestro desktop app is not running');
		}

		if (!isCliServerRunning()) {
			throw new Error('Maestro desktop app is not running');
		}

		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(`ws://localhost:${info.port}/${info.token}/ws`);
			let settled = false;

			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				ws.close();
				reject(new Error('Timed out connecting to Maestro desktop app'));
			}, CONNECT_TIMEOUT_MS);

			const cleanup = (): void => {
				clearTimeout(timeout);
				ws.off('open', onOpen);
				ws.off('error', onError);
			};

			const onOpen = (): void => {
				if (settled) return;
				settled = true;
				cleanup();
				this.ws = ws;
				ws.on('message', (data) => this.handleMessage(data));
				ws.on('close', () => this.rejectAllPending(new Error('Connection to Maestro closed')));
				ws.on('error', (error) => this.rejectAllPending(error));
				resolve();
			};

			const onError = (error: Error): void => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};

			ws.once('open', onOpen);
			ws.once('error', onError);
		});
	}

	/** Send a message and wait for a typed response. */
	async sendCommand<T>(
		message: object,
		responseType: string,
		timeoutMs = COMMAND_TIMEOUT_MS
	): Promise<T> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('Not connected to Maestro desktop app');
		}

		const requestId = randomUUID();
		const payload = { ...message, requestId };

		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(requestId);
				reject(new Error(`Timed out waiting for ${responseType}`));
			}, timeoutMs);

			this.pendingRequests.set(requestId, {
				responseType,
				resolve: resolve as (value: unknown) => void,
				reject,
				timeout,
			});

			this.ws!.send(JSON.stringify(payload), (error) => {
				if (!error) return;

				const pending = this.pendingRequests.get(requestId);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pendingRequests.delete(requestId);
					pending.reject(error);
				}
			});
		});
	}

	/** Disconnect gracefully. */
	disconnect(): void {
		this.rejectAllPending(new Error('Disconnected from Maestro desktop app'));
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}

	private handleMessage(data: WebSocket.RawData): void {
		let message: MaestroMessage;
		try {
			message = JSON.parse(data.toString()) as MaestroMessage;
		} catch (error) {
			this.rejectAllPending(new Error('Invalid message from Maestro desktop app'));
			throw error;
		}

		if (message.type === 'error') {
			this.rejectMatchingOrAll(message);
			return;
		}

		if (message.requestId) {
			const pending = this.pendingRequests.get(message.requestId);
			if (!pending || message.type !== pending.responseType) return;

			clearTimeout(pending.timeout);
			this.pendingRequests.delete(message.requestId);

			if (message.success === false) {
				pending.reject(new Error(this.getErrorMessage(message)));
			} else {
				pending.resolve(message);
			}
			return;
		}

		const matchingRequests = [...this.pendingRequests.entries()].filter(
			([, pending]) => message.type === pending.responseType
		);

		if (matchingRequests.length > 1) {
			const error = new Error(`Protocol error: response ${message.type} is missing requestId`);
			for (const [requestId, pending] of matchingRequests) {
				clearTimeout(pending.timeout);
				this.pendingRequests.delete(requestId);
				pending.reject(error);
			}
			return;
		}

		const [match] = matchingRequests;
		if (match) {
			const [requestId, pending] = match;

			clearTimeout(pending.timeout);
			this.pendingRequests.delete(requestId);

			if (message.success === false) {
				pending.reject(new Error(this.getErrorMessage(message)));
			} else {
				pending.resolve(message);
			}
			return;
		}
	}

	private rejectMatchingOrAll(message: MaestroMessage): void {
		const error = new Error(this.getErrorMessage(message));

		if (message.requestId) {
			const pending = this.pendingRequests.get(message.requestId);
			if (pending) {
				clearTimeout(pending.timeout);
				this.pendingRequests.delete(message.requestId);
				pending.reject(error);
			}
			return;
		}

		this.rejectAllPending(error);
	}

	private rejectAllPending(error: Error): void {
		for (const [requestId, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			this.pendingRequests.delete(requestId);
			pending.reject(error);
		}
	}

	private getErrorMessage(message: MaestroMessage): string {
		return message.error || message.message || 'Maestro command failed';
	}
}

/** Helper: create client, connect, run action, disconnect. */
export async function withMaestroClient<T>(
	action: (client: MaestroClient) => Promise<T>
): Promise<T> {
	const client = new MaestroClient();
	await client.connect();
	try {
		return await action(client);
	} finally {
		client.disconnect();
	}
}

export function resolveSessionId(options: SessionResolutionOptions = {}): string {
	if (options.session) {
		return options.session;
	}

	const settings = readSettings();
	if (typeof settings.activeSessionId === 'string' && settings.activeSessionId) {
		const activeSession = getSessionById(settings.activeSessionId);
		if (activeSession) {
			return activeSession.id;
		}
	}

	const firstSession = readSessions()[0];
	if (firstSession) {
		return firstSession.id;
	}

	throw new Error('No Maestro sessions found. Pass --session <id> to target a specific session.');
}
