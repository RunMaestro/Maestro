/** TEST ONLY. No discovery, production connect, environment fallback, or injected socket constructor. */
import WebSocket from 'ws';
import { canonicalJson } from '../../../../shared/canonicalJson';
import { generateUUID } from '../../../../shared/uuid';
import { CLI_SECRET_HEADER } from '../../../../shared/webLogin';
import type {
	BridgeConnectionOptions,
	SendCommandOptions,
} from '../../../../shared/maestro-lib/client/bridge-connection';
import {
	CommandTimeoutError,
	ConnectionClosedError,
	UnsupportedCommandError,
} from '../../../../shared/maestro-lib/client/bridge-connection';
import { MaestroNotRunningError } from '../../../../shared/maestro-lib/client/not-running';
import {
	fixtureBridgeMarkers,
	readFixtureBridgeManifest,
	type FixtureBridgeAdmission,
} from './board-fixture-bridge-admission';

export {
	CommandTimeoutError,
	ConnectionClosedError,
	MaestroNotRunningError,
	UnsupportedCommandError,
};
export type { FixtureBridgeAdmission };

let admittedParent: FixtureBridgeAdmission | undefined;
let admittedMarkers: string | undefined;

/** A CLI bundle's test-only substitution wrapper calls this with a parent-bound literal. */
export function admitFixtureBridge(proof: FixtureBridgeAdmission): void {
	const markers = admittedMarkers ?? fixtureBridgeMarkers();
	readFixtureBridgeManifest(proof, markers);
	if (admittedParent && canonicalJson(admittedParent) !== canonicalJson(proof))
		throw new Error('Board fixture bridge parent admission cannot be replaced');
	admittedParent = JSON.parse(canonicalJson(proof));
	admittedMarkers = markers;
}

type Options = Omit<BridgeConnectionOptions, 'WebSocketImpl'> & {
	fixture?: FixtureBridgeAdmission;
};
type Pending = {
	resolve: (frame: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	responseType: string;
	sentType: unknown;
	matchByType: boolean;
};

export class BridgeConnection {
	private socket: WebSocket | undefined;
	private readonly pending = new Map<string, Pending>();
	private readonly proof: FixtureBridgeAdmission | undefined;
	private readonly markers: string;

	constructor(private readonly options: Options = {}) {
		const proof = options.fixture ?? admittedParent;
		this.proof = proof && JSON.parse(canonicalJson(proof));
		this.markers = options.fixture
			? fixtureBridgeMarkers()
			: (admittedMarkers ?? fixtureBridgeMarkers());
	}

	private admit() {
		try {
			const manifest = readFixtureBridgeManifest(this.proof, this.markers);
			if (this.options.userDataDir && this.options.userDataDir !== this.proof!.contract.userData)
				throw new Error('Board fixture bridge userData differs from parent');
			return manifest;
		} catch (error) {
			this.disconnect();
			throw error;
		}
	}

	async connect(): Promise<void> {
		const manifest = this.admit();
		if (this.socket) throw new Error('Board fixture bridge is already connected');
		const query = new URLSearchParams(
			Object.entries(this.options.query ?? {}).map(([key, value]): [string, string] => [
				key,
				String(value),
			])
		);
		const socket = new WebSocket(manifest.url + (query.size ? `?${query}` : ''), {
			headers: { [CLI_SECRET_HEADER]: manifest.cliSecret },
			followRedirects: false,
			maxPayload: 1024 * 1024,
		});
		this.socket = socket;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				socket.terminate();
				reject(new MaestroNotRunningError('connect-timeout'));
			}, 5000);
			socket.once('open', () => {
				clearTimeout(timer);
				try {
					this.admit();
					resolve();
				} catch (error) {
					reject(error);
				}
			});
			socket.on('error', (error) => {
				clearTimeout(timer);
				// Preserve the production CLI distinction: errno means no listener;
				// an HTTP upgrade refusal means the host answered and denied access.
				reject(
					(error as NodeJS.ErrnoException).code
						? new MaestroNotRunningError('connect-failed', error.message)
						: new Error(`Failed to connect to Maestro: ${error.message}`)
				);
			});
			socket.on('close', (code, reason) => {
				clearTimeout(timer);
				const error = new ConnectionClosedError({
					closedByCaller: false,
					code,
					reason: String(reason),
				});
				if (this.socket === socket) {
					this.rejectPending(error);
					this.socket = undefined;
					this.options.onClose?.(code, String(reason) || undefined);
				}
				reject(error);
			});
			socket.on('message', (data) => {
				if (this.socket !== socket) return;
				try {
					this.admit();
				} catch {
					return; // admit closed the socket and rejected all pending calls.
				}
				let frame: Record<string, unknown>;
				try {
					frame = JSON.parse(String(data));
				} catch {
					return;
				}
				if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
				this.receive(frame);
			});
		});
	}

	/** Mirrors the production requestId/echo/type fallback protocol; it has no exported framing helper. */
	private receive(frame: Record<string, unknown>): void {
		const echo = frame.type === 'echo';
		const original = frame.data as Record<string, unknown> | undefined;
		const requestId = echo ? (original?.requestId ?? frame.originalRequestId) : frame.requestId;
		const command = frame.originalType ?? original?.type ?? 'unknown';
		const entry =
			typeof requestId === 'string' && this.pending.has(requestId)
				? ([requestId, this.pending.get(requestId)!] as const)
				: [...this.pending].find(
						([, call]) =>
							call.matchByType &&
							(echo ? call.sentType === command : call.responseType === frame.type)
					);
		if (!entry) {
			if (!echo) this.options.onFrame?.(frame);
			return;
		}
		const [id, call] = entry;
		clearTimeout(call.timer);
		this.pending.delete(id);
		if (echo) call.reject(new UnsupportedCommandError(String(command), 'headless'));
		else call.resolve(frame);
	}

	async sendCommand<T>(
		message: Record<string, unknown>,
		responseType: string,
		timeoutMs = 10000,
		commandOptions: SendCommandOptions = {}
	): Promise<T> {
		this.admit();
		if (!this.isOpen) throw new Error('Not connected to Maestro');
		const requestId = `req_${generateUUID()}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				reject(new CommandTimeoutError(responseType));
			}, timeoutMs);
			this.pending.set(requestId, {
				resolve: resolve as (frame: Record<string, unknown>) => void,
				reject,
				timer,
				responseType,
				sentType: message.type,
				matchByType: !this.options.strictReplies || commandOptions.matchByType === true,
			});
			try {
				this.socket!.send(JSON.stringify({ ...message, requestId }));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(requestId);
				reject(error);
			}
		});
	}

	send(message: Record<string, unknown>): boolean {
		this.admit();
		if (!this.isOpen) return false;
		this.socket!.send(JSON.stringify(message));
		return true;
	}

	get isOpen(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	private rejectPending(error: Error): void {
		for (const call of this.pending.values()) {
			clearTimeout(call.timer);
			call.reject(error);
		}
		this.pending.clear();
	}

	disconnect(): void {
		this.rejectPending(new ConnectionClosedError({ closedByCaller: true }));
		const socket = this.socket;
		this.socket = undefined;
		if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
	}
}

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
