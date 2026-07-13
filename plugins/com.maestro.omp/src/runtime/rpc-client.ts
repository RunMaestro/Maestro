import { OMP_16_4_8_EVENT_TYPES, OMP_16_4_8_OUTBOUND_CALLBACK_TYPES } from './compatibility';
import { OMP_RPC_VERSION } from './types';
import type {
	OmpInboundCallback,
	OmpOutboundCallback,
	OmpOutboundCallbackType,
	OmpRpcTransport,
	OmpRpcCommand,
	OmpRpcEvent,
	OmpRpcEventType,
	OmpRpcResponse,
} from './types';

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 32 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const MAX_IN_FLIGHT_COMMANDS = 32;

const eventTypeLookup: Record<OmpRpcEventType, true> = Object.fromEntries(
	OMP_16_4_8_EVENT_TYPES.map((type) => [type, true])
) as Record<OmpRpcEventType, true>;
const callbackTypeLookup: Record<OmpOutboundCallbackType, true> = Object.fromEntries(
	OMP_16_4_8_OUTBOUND_CALLBACK_TYPES.filter((type) => type !== 'response').map((type) => [
		type,
		true,
	])
) as Record<OmpOutboundCallbackType, true>;

export type OmpRpcClientStatus = 'starting' | 'ready' | 'failed' | 'exited' | 'closed';

export interface OmpRpcClientOptions {
	readonly maxFrameBytes?: number;
	readonly maxDiagnosticBytes?: number;
	readonly requestTimeoutMs?: number;
	readonly readyTimeoutMs?: number;
}

export interface OmpCommandOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export class OmpProtocolError extends Error {
	readonly code = 'protocol_error';

	constructor(message: string) {
		super(message);
		this.name = 'OmpProtocolError';
	}
}

export class OmpRuntimeClosedError extends Error {
	readonly code = 'runtime_closed';

	constructor(reason?: string) {
		super(reason ? `OMP runtime closed: ${reason}` : 'OMP runtime closed');
		this.name = 'OmpRuntimeClosedError';
	}
}

interface PendingRequest {
	readonly command: OmpRpcCommand['type'];
	readonly resolve: (response: OmpRpcResponse) => void;
	readonly reject: (error: Error) => void;
	readonly clear: () => void;
}

export class OmpRpcClient {
	private readonly maxFrameBytes: number;
	private readonly maxDiagnosticBytes: number;
	private readonly requestTimeoutMs: number;
	private readonly eventListeners: Array<(event: OmpRpcEvent) => void> = [];
	private readonly callbackListeners: Array<(callback: OmpOutboundCallback) => void> = [];
	private readonly diagnosticListeners: Array<(diagnostic: string) => void> = [];
	private readonly failureListeners: Array<(error: OmpProtocolError) => void> = [];
	private readonly pending = new Map<string, PendingRequest>();
	private readonly readyPromise: Promise<void>;
	private resolveReady!: () => void;
	private rejectReady!: (error: Error) => void;
	private statusValue: OmpRpcClientStatus = 'starting';
	private stdoutBuffer = new Uint8Array(0);
	private requestNumber = 0;
	private readyTimer: ReturnType<typeof setTimeout> | undefined;
	private lastRuntimeSequence: number | undefined;
	private readonly detachTransportListeners: readonly (() => void)[];

	constructor(
		private readonly transport: OmpRpcTransport,
		options: OmpRpcClientOptions = {}
	) {
		this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
		this.maxDiagnosticBytes = options.maxDiagnosticBytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.readyPromise = new Promise<void>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		this.detachTransportListeners = [
			transport.onFrame((chunk) => this.receiveStdout(chunk)),
			transport.onDiagnostic((chunk) => this.receiveStderr(chunk)),
			transport.onClosed((reason) => this.receiveClosed(reason)),
		];
		this.readyTimer = setTimeout(
			() => this.fail(new OmpProtocolError('OMP readiness timed out')),
			options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
		);
	}

	get status(): OmpRpcClientStatus {
		return this.statusValue;
	}

	get pendingRequestCount(): number {
		return this.pending.size;
	}

	waitForReady(): Promise<void> {
		return this.readyPromise;
	}

	onEvent(listener: (event: OmpRpcEvent) => void): () => void {
		this.eventListeners.push(listener);
		return () => this.eventListeners.splice(this.eventListeners.indexOf(listener), 1);
	}

	onCallback(listener: (callback: OmpOutboundCallback) => void): () => void {
		this.callbackListeners.push(listener);
		return () => this.callbackListeners.splice(this.callbackListeners.indexOf(listener), 1);
	}

	onDiagnostic(listener: (diagnostic: string) => void): () => void {
		this.diagnosticListeners.push(listener);
		return () => this.diagnosticListeners.splice(this.diagnosticListeners.indexOf(listener), 1);
	}

	onFailure(listener: (error: OmpProtocolError) => void): () => void {
		this.failureListeners.push(listener);
		return () => this.failureListeners.splice(this.failureListeners.indexOf(listener), 1);
	}

	command(command: OmpRpcCommand, options: OmpCommandOptions = {}): Promise<OmpRpcResponse> {
		if (this.statusValue !== 'ready') {
			return Promise.reject(new OmpProtocolError(`OMP is not ready (status: ${this.statusValue})`));
		}
		if (options.signal?.aborted) return Promise.reject(abortError());
		if (this.pending.size >= MAX_IN_FLIGHT_COMMANDS) {
			return Promise.reject(
				new OmpProtocolError(
					`OMP controller allows at most ${MAX_IN_FLIGHT_COMMANDS} in-flight commands`
				)
			);
		}

		const id = `omp-${++this.requestNumber}`;
		const frame = { ...command, id };
		return new Promise<OmpRpcResponse>((resolve, reject) => {
			const timeout = setTimeout(
				() => this.rejectPending(id, new OmpProtocolError(`OMP command ${command.type} timed out`)),
				options.timeoutMs ?? deadlineFor(command.type, this.requestTimeoutMs)
			);
			const onAbort = () => this.rejectPending(id, abortError());
			options.signal?.addEventListener('abort', onAbort, { once: true });
			this.pending.set(id, {
				command: command.type,
				resolve,
				reject,
				clear: () => {
					clearTimeout(timeout);
					options.signal?.removeEventListener('abort', onAbort);
				},
			});
			try {
				Promise.resolve(this.transport.send(`${JSON.stringify(frame)}\n`)).catch(
					(error: unknown) => {
						this.rejectPending(
							id,
							error instanceof Error ? error : new OmpProtocolError('OMP stdin write failed')
						);
					}
				);
			} catch (error) {
				this.rejectPending(
					id,
					error instanceof Error ? error : new OmpProtocolError('OMP stdin write failed')
				);
			}
		});
	}

	sendInbound(callback: OmpInboundCallback): Promise<void> {
		if (this.statusValue !== 'ready') {
			return Promise.reject(new OmpProtocolError(`OMP is not ready (status: ${this.statusValue})`));
		}
		try {
			return Promise.resolve(this.transport.send(`${JSON.stringify(callback)}\n`));
		} catch (error) {
			return Promise.reject(
				error instanceof Error ? error : new OmpProtocolError('OMP stdin write failed')
			);
		}
	}

	close(): void {
		if (this.statusValue === 'closed') return;
		this.statusValue = 'closed';
		this.clearReadyTimer();
		this.rejectOutstanding(new OmpProtocolError('OMP RPC client was closed'));
		for (const detach of this.detachTransportListeners) detach();
	}

	private receiveStdout(chunk: Uint8Array | string): void {
		if (
			this.statusValue === 'failed' ||
			this.statusValue === 'closed' ||
			this.statusValue === 'exited'
		)
			return;
		const bytes = typeof chunk === 'string' ? encodeUtf8(chunk) : chunk;
		const buffered = new Uint8Array(this.stdoutBuffer.length + bytes.length);
		buffered.set(this.stdoutBuffer);
		buffered.set(bytes, this.stdoutBuffer.length);
		this.stdoutBuffer = buffered;
		if (this.stdoutBuffer.length > this.maxFrameBytes && !this.stdoutBuffer.includes(10)) {
			this.fail(new OmpProtocolError(`OMP stdout frame exceeds ${this.maxFrameBytes} bytes`));
			return;
		}
		let newline = this.stdoutBuffer.indexOf(10);
		while (newline >= 0) {
			const frame = this.stdoutBuffer.slice(0, newline);
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (frame.length > this.maxFrameBytes) {
				this.fail(new OmpProtocolError(`OMP stdout frame exceeds ${this.maxFrameBytes} bytes`));
				return;
			}
			if (frame.length > 0) {
				const text = decodeUtf8(frame);
				if (text === undefined) {
					this.fail(new OmpProtocolError('OMP emitted invalid UTF-8 JSONL'));
					return;
				}
				this.decodeAndDispatch(text.replace(/\r$/, ''));
			}
			newline = this.stdoutBuffer.indexOf(10);
		}
	}

	private decodeAndDispatch(line: string): void {
		if (
			this.statusValue === 'failed' ||
			this.statusValue === 'closed' ||
			this.statusValue === 'exited'
		)
			return;
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			this.fail(new OmpProtocolError('OMP emitted malformed JSONL'));
			return;
		}
		if (!isRecord(raw) || typeof raw.type !== 'string') {
			this.fail(new OmpProtocolError('OMP emitted a non-object protocol frame'));
			return;
		}
		if (raw.type === 'ready') {
			if (this.statusValue !== 'starting') {
				this.fail(new OmpProtocolError('OMP emitted ready more than once'));
				return;
			}
			if ('version' in raw && raw.version !== OMP_RPC_VERSION) {
				this.fail(
					new OmpProtocolError(
						`OMP declared unsupported protocol version ${JSON.stringify(raw.version)}`
					)
				);
				return;
			}
			this.statusValue = 'ready';
			this.clearReadyTimer();
			this.resolveReady();
			return;
		}
		if (raw.type === 'response') {
			this.dispatchResponse(raw);
			return;
		}
		if (hasOwn(eventTypeLookup, raw.type)) {
			if (!this.acceptRuntimeSequence(raw)) return;
			const event: OmpRpcEvent = { ...raw, type: raw.type };
			for (const listener of this.eventListeners) listener(event);
			return;
		}
		if (hasOwn(callbackTypeLookup, raw.type)) {
			const callback: OmpOutboundCallback = { ...raw, type: raw.type };
			if (callback.type === 'prompt_result') this.dispatchPromptResult(raw);
			for (const listener of this.callbackListeners) listener(callback);
			return;
		}
		this.fail(
			new OmpProtocolError(`OMP emitted unknown protocol frame type ${JSON.stringify(raw.type)}`)
		);
	}

	private acceptRuntimeSequence(raw: Record<string, unknown>): boolean {
		if (!('sequence' in raw)) return true;
		if (!Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 0) {
			this.fail(new OmpProtocolError('OMP emitted an invalid runtime event sequence'));
			return false;
		}
		if (
			this.lastRuntimeSequence !== undefined &&
			(raw.sequence as number) <= this.lastRuntimeSequence
		) {
			this.fail(new OmpProtocolError('OMP emitted an out-of-order runtime event sequence'));
			return false;
		}
		this.lastRuntimeSequence = raw.sequence as number;
		return true;
	}

	private dispatchResponse(raw: Record<string, unknown>): void {
		if (typeof raw.command !== 'string' || typeof raw.success !== 'boolean') {
			this.fail(new OmpProtocolError('OMP emitted an invalid response frame'));
			return;
		}
		const response: OmpRpcResponse = {
			type: 'response',
			...(typeof raw.id === 'string' ? { id: raw.id } : {}),
			command: raw.command,
			success: raw.success,
			...('data' in raw ? { data: raw.data } : {}),
			...(typeof raw.error === 'string' ? { error: raw.error } : {}),
		};
		if (!response.id) {
			this.fail(new OmpProtocolError('OMP response is missing a correlation id'));
			return;
		}
		const pending = this.pending.get(response.id);
		if (!pending) {
			this.fail(
				new OmpProtocolError(`OMP response did not match an active request ${response.id}`)
			);
			return;
		}
		if (pending.command !== response.command) {
			this.fail(new OmpProtocolError(`OMP response command mismatch for ${response.id}`));
			return;
		}
		if (
			response.success &&
			(pending.command === 'prompt' || pending.command === 'abort_and_prompt')
		) {
			return;
		}
		this.pending.delete(response.id);
		pending.clear();
		if (response.success) pending.resolve(response);
		else
			pending.reject(
				new OmpProtocolError(response.error ?? `OMP command ${response.command} failed`)
			);
	}

	private dispatchPromptResult(raw: Record<string, unknown>): void {
		if (typeof raw.id !== 'string' || typeof raw.success !== 'boolean') {
			this.fail(new OmpProtocolError('OMP emitted an invalid prompt_result frame'));
			return;
		}
		const pending = this.pending.get(raw.id);
		if (!pending) {
			this.fail(
				new OmpProtocolError(`OMP prompt_result did not match an active request ${raw.id}`)
			);
			return;
		}
		if (pending.command !== 'prompt' && pending.command !== 'abort_and_prompt') {
			this.fail(new OmpProtocolError(`OMP prompt_result does not match ${pending.command}`));
			return;
		}
		this.pending.delete(raw.id);
		pending.clear();
		const response: OmpRpcResponse = {
			type: 'response',
			id: raw.id,
			command: pending.command,
			success: raw.success,
			...('result' in raw ? { data: raw.result } : {}),
			...(typeof raw.error === 'string' ? { error: raw.error } : {}),
		};
		if (response.success) pending.resolve(response);
		else pending.reject(new OmpProtocolError(response.error ?? `OMP ${pending.command} failed`));
	}

	private receiveStderr(chunk: Uint8Array | string): void {
		const text = typeof chunk === 'string' ? chunk : (decodeUtf8(chunk) ?? '');
		const diagnostic = redactOmpDiagnostic(text).slice(0, this.maxDiagnosticBytes);
		if (diagnostic.length === 0) return;
		for (const listener of this.diagnosticListeners) listener(diagnostic);
	}

	private receiveClosed(reason?: string): void {
		if (this.statusValue === 'closed' || this.statusValue === 'failed') return;
		this.statusValue = 'exited';
		this.clearReadyTimer();
		const error = new OmpRuntimeClosedError(reason);
		this.rejectReady(error);
		this.rejectOutstanding(error);
	}

	private rejectPending(id: string, error: Error): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		pending.clear();
		pending.reject(error);
	}

	private rejectOutstanding(error: Error): void {
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			pending.clear();
			pending.reject(error);
		}
	}

	private fail(error: OmpProtocolError): void {
		if (this.statusValue === 'failed' || this.statusValue === 'closed') return;
		this.statusValue = 'failed';
		this.clearReadyTimer();
		this.rejectReady(error);
		this.rejectOutstanding(error);
		for (const listener of this.failureListeners) listener(error);
	}

	private clearReadyTimer(): void {
		if (!this.readyTimer) return;
		clearTimeout(this.readyTimer);
		this.readyTimer = undefined;
	}
}

export function redactOmpDiagnostic(diagnostic: string): string {
	return diagnostic
		.replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
		.replace(/(api[_-]?key|token|password|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function deadlineFor(command: OmpRpcCommand['type'], defaultTimeout: number): number {
	switch (command) {
		case 'prompt':
		case 'abort_and_prompt':
			return 30 * 60 * 1_000;
		case 'compact':
		case 'export_html':
			return 2 * 60 * 1_000;
		case 'login':
			return 15 * 60 * 1_000;
		case 'bash':
			return 30 * 1_000;
		default:
			return defaultTimeout;
	}
}

function abortError(): Error {
	const error = new Error('OMP command was cancelled');
	error.name = 'AbortError';
	return error;
}

function encodeUtf8(text: string): Uint8Array {
	const bytes: number[] = [];
	for (let index = 0; index < text.length; index++) {
		let codePoint = text.charCodeAt(index);
		if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < text.length) {
			const low = text.charCodeAt(index + 1);
			if (low >= 0xdc00 && low <= 0xdfff) {
				codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
				index++;
			}
		}
		if (codePoint <= 0x7f) bytes.push(codePoint);
		else if (codePoint <= 0x7ff) bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
		else if (codePoint <= 0xffff)
			bytes.push(
				0xe0 | (codePoint >> 12),
				0x80 | ((codePoint >> 6) & 0x3f),
				0x80 | (codePoint & 0x3f)
			);
		else
			bytes.push(
				0xf0 | (codePoint >> 18),
				0x80 | ((codePoint >> 12) & 0x3f),
				0x80 | ((codePoint >> 6) & 0x3f),
				0x80 | (codePoint & 0x3f)
			);
	}
	return Uint8Array.from(bytes);
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
	let text = '';
	for (let index = 0; index < bytes.length; index++) {
		const first = bytes[index]!;
		if (first <= 0x7f) {
			text += String.fromCharCode(first);
			continue;
		}
		const width =
			first >= 0xf0 && first <= 0xf4
				? 4
				: first >= 0xe0 && first <= 0xef
					? 3
					: first >= 0xc2 && first <= 0xdf
						? 2
						: 0;
		if (width === 0 || index + width > bytes.length) return undefined;
		let codePoint = first & (width === 2 ? 0x1f : width === 3 ? 0x0f : 0x07);
		for (let offset = 1; offset < width; offset++) {
			const next = bytes[index + offset]!;
			if ((next & 0xc0) !== 0x80) return undefined;
			codePoint = (codePoint << 6) | (next & 0x3f);
		}
		if (
			(width === 2 && codePoint < 0x80) ||
			(width === 3 && codePoint < 0x800) ||
			(width === 4 && (codePoint < 0x10000 || codePoint > 0x10ffff))
		)
			return undefined;
		text +=
			codePoint <= 0xffff
				? String.fromCharCode(codePoint)
				: String.fromCharCode(
						0xd800 + ((codePoint - 0x10000) >> 10),
						0xdc00 + ((codePoint - 0x10000) & 0x3ff)
					);
		index += width - 1;
	}
	return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn<T extends string>(record: Record<T, true>, key: string): key is T {
	return Object.prototype.hasOwnProperty.call(record, key);
}
