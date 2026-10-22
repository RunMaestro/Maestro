// src/main/codex-app-server/rpc-client.ts

/**
 * The client half of `codex app-server`'s newline-delimited JSON-RPC 2.0.
 *
 * Owns request ids and the table of requests waiting on a response, nothing
 * else: it neither reads the child's stdout nor decides what a notification
 * means. The spawner frames stdout into lines, hands every RESPONSE here
 * (`handleResponse`), and routes notifications and server requests itself.
 * Kept apart from the spawner so the steering phase can send `turn/steer` over
 * the same channel and get the same error shapes back.
 */

import type { CodexAppServerResponse, CodexRpcError } from './protocol';
import type { CodexServerRequestAnswer } from './server-requests';

/** The server answered a request with a JSON-RPC error. `code` is the server's. */
export class CodexRpcRequestError extends Error {
	readonly code: number;
	readonly data: unknown;
	constructor(
		readonly method: string,
		error: CodexRpcError
	) {
		super(`${method} failed: ${error.message}`);
		this.name = 'CodexRpcRequestError';
		this.code = error.code;
		this.data = error.data;
	}
}

/**
 * The request never got an answer: the child is gone, stdin could not be
 * written, or the response did not arrive in time.
 */
export class CodexRpcTransportError extends Error {
	constructor(
		readonly method: string,
		message: string
	) {
		super(`${method}: ${message}`);
		this.name = 'CodexRpcTransportError';
	}
}

export interface CodexRpcRequestOptions {
	/** Reject with a transport error when no response arrives in this many ms. */
	timeoutMs?: number;
}

interface PendingRequest {
	method: string;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

export class CodexAppServerRpc {
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private closedReason: string | null = null;

	/**
	 * @param writeLine Writes one serialized line (without the newline) to the
	 * child's stdin. May throw when stdin is gone; the request then rejects.
	 */
	constructor(private readonly writeLine: (line: string) => void) {}

	/** Send a request; resolves with `result`, rejects on an error response or transport failure. */
	request<T = unknown>(
		method: string,
		params?: unknown,
		options: CodexRpcRequestOptions = {}
	): Promise<T> {
		if (this.closedReason !== null) {
			return Promise.reject(new CodexRpcTransportError(method, this.closedReason));
		}
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const entry: PendingRequest = {
				method,
				resolve: resolve as (result: unknown) => void,
				reject,
			};
			if (options.timeoutMs !== undefined) {
				entry.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new CodexRpcTransportError(method, `no response after ${options.timeoutMs}ms`));
				}, options.timeoutMs);
			}
			this.pending.set(id, entry);
			try {
				this.write({ id, method, ...(params === undefined ? {} : { params }) });
			} catch (error) {
				this.settle(id);
				reject(new CodexRpcTransportError(method, `write failed: ${String(error)}`));
			}
		});
	}

	/** Send a notification (no response expected). Throws when stdin is gone. */
	notify(method: string, params?: unknown): void {
		this.write({ method, ...(params === undefined ? {} : { params }) });
	}

	/** Answer a server-to-client request. */
	respond(id: number | string, answer: CodexServerRequestAnswer): void {
		this.write({ id, ...answer });
	}

	/** Settle the request a response belongs to. False when no request was waiting on it. */
	handleResponse(response: CodexAppServerResponse): boolean {
		if (typeof response.id !== 'number') return false;
		const entry = this.settle(response.id);
		if (!entry) return false;
		if (response.error) entry.reject(new CodexRpcRequestError(entry.method, response.error));
		else entry.resolve(response.result);
		return true;
	}

	/** Reject every waiting request and refuse new ones: the child is gone. */
	close(reason: string): void {
		if (this.closedReason !== null) return;
		this.closedReason = reason;
		for (const [id, entry] of [...this.pending]) {
			this.settle(id);
			entry.reject(new CodexRpcTransportError(entry.method, reason));
		}
	}

	get isClosed(): boolean {
		return this.closedReason !== null;
	}

	private settle(id: number): PendingRequest | undefined {
		const entry = this.pending.get(id);
		if (!entry) return undefined;
		this.pending.delete(id);
		if (entry.timer) clearTimeout(entry.timer);
		return entry;
	}

	private write(message: Record<string, unknown>): void {
		this.writeLine(JSON.stringify({ jsonrpc: '2.0', ...message }));
	}
}
