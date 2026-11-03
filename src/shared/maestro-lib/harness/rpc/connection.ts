import type { ChildProcess } from 'child_process';

export type NdJsonProtocol = 'pi' | 'jsonrpc';

export interface NdJsonRecord {
	[key: string]: unknown;
}

export type NdJsonServerResponse =
	| { kind: 'result'; value: unknown }
	| { kind: 'error'; code: number; message: string }
	| { kind: 'extension'; value: Record<string, unknown> }
	| { kind: 'ignore'; value?: undefined };

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export interface NdJsonConnectionOptions {
	protocol: NdJsonProtocol;
	onNotification: (record: NdJsonRecord) => void;
	onServerRequest: (record: NdJsonRecord) => Promise<NdJsonServerResponse>;
	onReady?: (record: NdJsonRecord) => void;
	negotiateV2?: boolean;
	maxReassembledFrameBytes?: number;
	maxLineBytes?: number;
}

const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024 + 64 * 1024;
/** Stateful JSONL client for Pi/OMP commands and JSON-RPC gateway traffic. */
export class NdJsonConnection {
	private buffer = '';
	private bufferBytes = 0;
	private nextId = 0;
	private readonly pending = new Map<string, PendingRequest>();
	private chunk: {
		id: string;
		nextIndex: number;
		count: number;
		byteLength: number;
		parts: Buffer[];
		total: number;
	} | null = null;
	private closed = false;

	constructor(
		private readonly child: ChildProcess,
		private readonly options: NdJsonConnectionOptions
	) {
		const stdout = child.stdout;
		const stdin = child.stdin;
		if (!stdout || !stdin) throw new Error('Native RPC child requires piped stdin and stdout');
		stdout.setEncoding('utf8');
		stdout.on('data', (chunk: unknown) => this.onData(chunk));
		stdout.once('end', () => this.close(new Error('native transport closed')));
		stdout.once('error', (error) => this.close(error));
		stdin.on('error', (error) => this.close(error));
	}

	/** Send a correlated request and reject immediately once the transport is closed. */
	request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error('native transport is closed'));
		const id = `req-${++this.nextId}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.pending.set(id, { resolve, reject });
		this.write(
			this.options.protocol === 'pi'
				? { id, type: method, ...params }
				: { jsonrpc: '2.0', id, method, params }
		);
		return promise;
	}

	/** Emit a JSON-RPC notification, which has no request ID or response to correlate. */
	notify(method: string, params: Record<string, unknown>): void {
		if (this.options.protocol !== 'jsonrpc') throw new Error('notifications require JSON-RPC');
		this.write({ jsonrpc: '2.0', method, params });
	}

	/** Reject every pending request once; repeated close/error events are harmless. */
	close(error = new Error('native transport is closed')): void {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	/** Decode complete lines while preserving UTF-8 and bounding an unterminated buffer. */
	private onData(chunk: unknown): void {
		if (this.closed) return;
		const text = String(chunk);
		this.buffer += text;
		this.bufferBytes += Buffer.byteLength(text);
		let index = this.buffer.indexOf('\n');
		while (index !== -1) {
			const line = this.buffer.slice(0, index);
			this.bufferBytes -= Buffer.byteLength(this.buffer.slice(0, index + 1));
			this.buffer = this.buffer.slice(index + 1);
			if (line.trim()) this.onLine(line);
			index = this.buffer.indexOf('\n');
		}
		if (this.bufferBytes > (this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)) {
			this.buffer = '';
			this.bufferBytes = 0;
			this.chunk = null;
			this.options.onNotification({ type: 'transport_error', error: 'RPC line exceeds limit' });
			this.close(new Error('native transport line exceeds limit'));
		}
	}

	/** Parse one JSONL record without echoing malformed provider payloads into diagnostics. */
	private onLine(line: string): void {
		let record: NdJsonRecord;
		try {
			record = JSON.parse(line.endsWith('\r') ? line.slice(0, -1) : line) as NdJsonRecord;
		} catch {
			this.options.onNotification({ type: 'transport_error', error: 'Malformed JSONL record' });
			return;
		}
		if (record.type === 'rpc_chunk') {
			this.onChunk(record);
			return;
		}
		this.onRecord(record);
	}

	/** Route responses, server requests, and notifications according to the negotiated protocol. */
	private onRecord(record: NdJsonRecord): void {
		if (record.type === 'ready') {
			this.options.onReady?.(record);
			if (
				this.options.negotiateV2 &&
				Array.isArray(record.supportedProtocolVersions) &&
				record.supportedProtocolVersions.includes(2)
			) {
				const max = record.maxReassembledFrameBytes;
				if (typeof max === 'number') this.options.maxReassembledFrameBytes = max;
				void this.request('negotiate_protocol', { protocolVersion: 2 }).catch(() => {
					// v1 remains a valid, bounded protocol when negotiation fails.
				});
			}
		}
		const id =
			typeof record.id === 'string' || typeof record.id === 'number'
				? String(record.id)
				: undefined;
		if (record.type === 'response' || (id && typeof record.method !== 'string')) {
			if (!id) return;
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			if (record.success === false || record.error) {
				const detail =
					typeof record.error === 'string' ? record.error : JSON.stringify(record.error);
				pending.reject(new Error(detail ?? `Native request ${id} failed`));
			} else {
				pending.resolve(record.data ?? record.result);
			}
			return;
		}
		if (id && typeof record.method === 'string') {
			void this.options
				.onServerRequest(record)
				.then((response) => {
					if (response.kind === 'ignore') return;
					if (response.kind === 'extension') {
						this.write({ type: 'extension_ui_response', id: record.id, ...response.value });
					} else if (response.kind === 'error') {
						this.write({
							jsonrpc: '2.0',
							id: record.id,
							error: { code: response.code, message: response.message },
						});
					} else {
						this.write({ jsonrpc: '2.0', id: record.id, result: response.value });
					}
				})
				.catch(() => {
					if (this.options.protocol === 'pi') {
						this.write({ type: 'extension_ui_response', id: record.id, cancelled: true });
						return;
					}
					this.write({
						jsonrpc: '2.0',
						id: record.id,
						error: { code: -32603, message: 'Internal error' },
					});
				});
			return;
		}
		this.options.onNotification(record);
	}

	/** Write one JSONL record unless the connection has already closed. */
	private write(record: NdJsonRecord): void {
		if (this.closed) return;
		this.child.stdin!.write(JSON.stringify(record) + '\n');
	}

	/** Validate and reassemble v2 chunks with sequence and byte-budget enforcement. */
	private onChunk(record: NdJsonRecord): void {
		const max = this.options.maxReassembledFrameBytes ?? 64 * 1024 * 1024;
		const id = record.chunkId;
		const index = record.index;
		const count = record.count;
		const byteLength = record.byteLength;
		const data = record.data;
		if (
			typeof id !== 'string' ||
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			!Number.isSafeInteger(byteLength) ||
			(index as number) < 0 ||
			(count as number) < 1 ||
			(index as number) >= (count as number) ||
			(byteLength as number) < 0 ||
			(byteLength as number) > max ||
			typeof data !== 'string' ||
			(this.chunk ? this.chunk.id !== id : (index as number) !== 0) ||
			(this.chunk && this.chunk.nextIndex !== index)
		) {
			this.options.onNotification({ type: 'rpc_frame_error', error: 'Invalid RPC chunk sequence' });
			this.chunk = null;
			return;
		}
		const part = Buffer.from(data, 'base64');
		if (!this.chunk)
			this.chunk = {
				id,
				nextIndex: 0,
				count: count as number,
				byteLength: byteLength as number,
				parts: [],
				total: 0,
			};
		if (this.chunk.total + part.length > max) {
			this.options.onNotification({ type: 'rpc_frame_error', error: 'RPC frame exceeds limit' });
			this.chunk = null;
			return;
		}
		this.chunk.parts.push(part);
		this.chunk.total += part.length;
		this.chunk.nextIndex += 1;
		if (this.chunk.nextIndex !== this.chunk.count) return;
		const complete = this.chunk;
		this.chunk = null;
		if (complete.total !== complete.byteLength) {
			this.options.onNotification({
				type: 'rpc_frame_error',
				error: 'RPC chunk byte length mismatch',
			});
			return;
		}
		try {
			this.onRecord(JSON.parse(Buffer.concat(complete.parts).toString('utf8')) as NdJsonRecord);
		} catch {
			this.options.onNotification({
				type: 'rpc_frame_error',
				error: 'Malformed reassembled RPC frame',
			});
		}
	}
}
