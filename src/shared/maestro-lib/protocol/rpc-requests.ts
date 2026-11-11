/** Transport failures are formatted by the protocol wrapper, without retaining request payloads. */
export type RpcTransportFailure =
	| { type: 'closed'; reason: string }
	| { type: 'timeout'; timeoutMs: number }
	| { type: 'write'; cause: unknown };

interface PendingRequest {
	method: string;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Request correlation and lifetime shared by bidirectional protocol clients.
 * Each instance owns increasing numeric IDs starting at 1. The wrapper owns
 * framing, response validation, protocol errors and notification handling.
 */
export class RpcRequestTracker {
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private closedReason: string | null = null;

	constructor(
		private readonly transportError: (method: string, failure: RpcTransportFailure) => Error
	) {}

	/** Register before writing so a synchronous response or close can settle the request. */
	request<T = unknown>(
		method: string,
		writeRequest: (id: number) => void,
		timeoutMs?: number
	): Promise<T> {
		if (this.closedReason !== null) {
			return Promise.reject(
				this.transportError(method, { type: 'closed', reason: this.closedReason })
			);
		}
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const entry: PendingRequest = {
				method,
				resolve: resolve as (result: unknown) => void,
				reject,
			};
			if (timeoutMs !== undefined) {
				entry.timer = setTimeout(() => {
					this.reject(id, (method) => this.transportError(method, { type: 'timeout', timeoutMs }));
				}, timeoutMs);
			}
			this.pending.set(id, entry);
			try {
				writeRequest(id);
			} catch (cause) {
				this.reject(id, (method) => this.transportError(method, { type: 'write', cause }));
			}
		});
	}

	/** False for unknown, duplicate or stale IDs. */
	resolve(id: number, result: unknown): boolean {
		const entry = this.settle(id);
		if (!entry) return false;
		entry.resolve(result);
		return true;
	}

	/** Build protocol-specific errors only for a request that is still pending. */
	reject(id: number, error: (method: string) => Error): boolean {
		const entry = this.settle(id);
		if (!entry) return false;
		entry.reject(error(entry.method));
		return true;
	}

	/** Reject every pending request and refuse new ones, preserving the first close reason. */
	close(reason: string): void {
		if (this.closedReason !== null) return;
		this.closedReason = reason;
		for (const id of [...this.pending.keys()]) {
			this.reject(id, (method) => this.transportError(method, { type: 'closed', reason }));
		}
	}

	get isClosed(): boolean {
		return this.closedReason !== null;
	}

	private settle(id: number): PendingRequest | undefined {
		const entry = this.pending.get(id);
		if (!entry) return undefined;
		this.pending.delete(id);
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		return entry;
	}
}
