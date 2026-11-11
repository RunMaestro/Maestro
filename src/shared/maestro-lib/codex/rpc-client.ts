// src/shared/maestro-lib/codex/rpc-client.ts

/**
 * The client half of `codex app-server`'s newline-delimited JSON-RPC 2.0.
 *
 * Delegates request correlation and lifetime to the shared RPC tracker. It
 * neither reads the child's stdout nor decides what a notification
 * means. The spawner frames stdout into lines, hands every RESPONSE here
 * (`handleResponse`), and routes notifications and server requests itself.
 * Kept apart from the spawner so the steering phase can send `turn/steer` over
 * the same channel and get the same error shapes back.
 */

import { RpcRequestTracker } from '../protocol/rpc-requests';
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

export class CodexAppServerRpc {
	private readonly requests = new RpcRequestTracker((method, failure) => {
		switch (failure.type) {
			case 'closed':
				return new CodexRpcTransportError(method, failure.reason);
			case 'timeout':
				return new CodexRpcTransportError(method, `no response after ${failure.timeoutMs}ms`);
			case 'write':
				return new CodexRpcTransportError(method, `write failed: ${String(failure.cause)}`);
		}
	});

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
		return this.requests.request<T>(
			method,
			(id) => this.write({ id, method, ...(params === undefined ? {} : { params }) }),
			options.timeoutMs
		);
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
		if (response.error) {
			const error = response.error;
			return this.requests.reject(response.id, (method) => new CodexRpcRequestError(method, error));
		}
		return this.requests.resolve(response.id, response.result);
	}

	/** Reject every waiting request and refuse new ones: the child is gone. */
	close(reason: string): void {
		this.requests.close(reason);
	}

	get isClosed(): boolean {
		return this.requests.isClosed;
	}

	private write(message: Record<string, unknown>): void {
		this.writeLine(JSON.stringify({ jsonrpc: '2.0', ...message }));
	}
}
