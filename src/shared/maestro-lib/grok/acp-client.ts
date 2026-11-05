import { RpcRequestTracker } from '../protocol/rpc-requests';
import {
	AcpFrameDecoder,
	GROK_ACP_PROTOCOL_VERSION,
	GrokAcpRequestError,
	GrokAcpTransportError,
	parseAcpInitialization,
	type AcpAnswer,
	type AcpCall,
	type AcpFailure,
	type AcpInitialization,
	type AcpMessage,
	type AcpRequestId,
} from './acp-protocol';
import { getErrorPatterns, matchErrorPattern } from '../parsers/error-patterns';
import type { AgentErrorType } from '../../types';

/** The ACP schema reserves -32000 for auth_required: a protocol meaning, not an inference. */
export const ACP_AUTH_REQUIRED_CODE = -32000;

/**
 * Classify a peer's JSON-RPC error once, here, so nothing downstream needs its message: the
 * ACP auth code first, then the shared Grok error bank over the message text. Only the type
 * leaves this function; the message is dropped with the frame.
 */
function classifyAcpRequestError(code: number, message: unknown): AgentErrorType | undefined {
	if (code === ACP_AUTH_REQUIRED_CODE) return 'auth_expired';
	if (typeof message !== 'string') return undefined;
	return matchErrorPattern(getErrorPatterns('grok'), message)?.type;
}

export interface GrokAcpClientOptions {
	/** Writes one complete UTF-8 frame including LF. Async pipe failures must call close('write'). */
	write: (frame: Uint8Array) => void;
	maxFrameBytes?: number;
	/** Positive finite deadline; defaults to 30 seconds. Turn owners may supply a longer deadline. */
	requestTimeoutMs?: number;
	onNotification?: (message: AcpCall) => void;
	/** Only registered methods are delivered; no permission/effect decision is made here. */
	requestHandlers?: ReadonlyMap<
		string,
		(request: AcpCall & { id: AcpRequestId }, respond: (answer: AcpAnswer) => boolean) => void
	>;
	onClose?: (error: GrokAcpTransportError) => void;
}

/** Host-independent ACP channel. The caller owns pipes, process lifetime and admission. */
export class GrokAcpClient {
	private readonly frames: AcpFrameDecoder;
	private readonly encoder = new TextEncoder();
	private readonly handlers: NonNullable<GrokAcpClientOptions['requestHandlers']>;
	private readonly requests = new RpcRequestTracker((_method, failure) => {
		if (failure.type === 'closed') return this.closedError ?? new GrokAcpTransportError('closed');
		if (failure.type === 'write' && failure.cause instanceof GrokAcpTransportError)
			return failure.cause;
		return new GrokAcpTransportError(failure.type);
	});
	private initialization?: Promise<AcpInitialization>;
	private ready = false;
	private closedError?: GrokAcpTransportError;
	private stderrByteCount = 0;

	constructor(private readonly options: GrokAcpClientOptions) {
		this.frames = new AcpFrameDecoder(options.maxFrameBytes);
		this.handlers = new Map(options.requestHandlers);
		this.deadline(options.requestTimeoutMs);
	}

	/** No initialized notification in ACP. No filesystem, terminal or elicitation claims. */
	initialize(): Promise<AcpInitialization> {
		if (this.closedError) return Promise.reject(this.closedError);
		if (!this.initialization) {
			// Publish the single handshake promise before any writer/notification can reenter.
			this.initialization = Promise.resolve()
				.then(() =>
					this.sendRequest('initialize', {
						protocolVersion: GROK_ACP_PROTOCOL_VERSION,
						clientCapabilities: {},
					})
				)
				.then((result) => {
					if (this.closedError) throw this.closedError;
					const negotiated = parseAcpInitialization(result);
					this.ready = true;
					return negotiated;
				})
				.catch((error: unknown) => {
					this.close('negotiation-failed');
					throw error;
				});
		}
		return this.initialization;
	}

	request<T = unknown>(
		method: string,
		params?: AcpCall['params'],
		options: { timeoutMs?: number } = {}
	): Promise<T> {
		if (this.closedError) return Promise.reject(this.closedError);
		if (!this.ready || method === 'initialize')
			return Promise.reject(new GrokAcpTransportError('not-initialized'));
		return this.sendRequest<T>(method, params, options.timeoutMs);
	}

	notify(method: string, params?: AcpCall['params']): void {
		if (this.closedError) throw this.closedError;
		if (!this.ready || method === 'initialize') throw new GrokAcpTransportError('not-initialized');
		this.write({ method, ...(params === undefined ? {} : { params }) });
	}

	/** Feed stdout bytes only. A bad frame ends the channel and invalidates all pending replies. */
	feedStdout(chunk: Uint8Array): void {
		if (this.isClosed) return;
		try {
			this.frames.push(chunk, (message) => {
				this.receive(message);
				return !this.isClosed;
			});
		} catch (error) {
			this.close(error instanceof GrokAcpTransportError ? error.reason : 'handler-failed');
			if (!(error instanceof GrokAcpTransportError)) throw error;
		}
	}

	/** Stderr is never parsed, buffered or included in errors. Hosts own any redacted log sink. */
	feedStderr(chunk: Uint8Array): void {
		if (!this.isClosed)
			this.stderrByteCount = Math.min(
				Number.MAX_SAFE_INTEGER,
				this.stderrByteCount + chunk.byteLength
			);
	}
	get stderrBytes(): number {
		return this.stderrByteCount;
	}
	get bufferedBytes(): number {
		return this.frames.bufferedBytes;
	}
	get isClosed(): boolean {
		return this.requests.isClosed;
	}

	/** EOF is not a final frame: an unterminated response cannot be accepted as success. */
	close(reason: AcpFailure = 'closed'): void {
		if (this.isClosed) return;
		this.closedError = new GrokAcpTransportError(
			reason === 'closed' && this.bufferedBytes ? 'incomplete-frame' : reason
		);
		this.frames.reset();
		this.ready = false;
		this.requests.close(this.closedError.reason);
		this.options.onClose?.(this.closedError);
	}

	private deadline(timeoutMs = this.options.requestTimeoutMs ?? 30_000): number {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
			throw new GrokAcpTransportError('invalid-timeout');
		return timeoutMs;
	}

	private sendRequest<T = unknown>(
		method: string,
		params?: AcpCall['params'],
		timeoutMs?: number
	): Promise<T> {
		let deadline: number;
		try {
			deadline = this.deadline(timeoutMs);
		} catch (error) {
			return Promise.reject(error);
		}
		return this.requests.request<T>(
			method,
			(id) => this.write({ id, method, ...(params === undefined ? {} : { params }) }),
			deadline
		);
	}

	private receive(message: AcpMessage): void {
		if ('method' in message) {
			if (message.id === undefined) {
				this.options.onNotification?.(message);
				return;
			}
			let answered = false;
			const respond = (answer: AcpAnswer): boolean => {
				if (answered || this.isClosed) return false;
				answered = true;
				this.write({ id: message.id, ...answer });
				return true;
			};
			const handler = this.ready ? this.handlers.get(message.method) : undefined;
			if (handler) handler(message as AcpCall & { id: AcpRequestId }, respond);
			else respond({ error: { code: -32601, message: 'Method not found' } });
			return;
		}
		if (typeof message.id !== 'number') return;
		if (message.error) {
			const code = message.error.code;
			const errorType = classifyAcpRequestError(code, message.error.message);
			this.requests.reject(message.id, () => new GrokAcpRequestError(code, errorType));
		} else this.requests.resolve(message.id, message.result);
	}

	private write(message: Record<string, unknown>): void {
		if (this.closedError) throw this.closedError;
		let json: string;
		try {
			json = JSON.stringify({ jsonrpc: '2.0', ...message });
		} catch {
			throw new GrokAcpTransportError('write');
		}
		if (json.length + 1 > this.frames.maxFrameBytes)
			throw new GrokAcpTransportError('frame-too-large');
		const frame = this.encoder.encode(json + '\n');
		if (frame.byteLength > this.frames.maxFrameBytes)
			throw new GrokAcpTransportError('frame-too-large');
		try {
			this.options.write(frame);
		} catch {
			throw new GrokAcpTransportError('write');
		}
	}
}
