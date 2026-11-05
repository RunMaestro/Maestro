import { preserveJsonNumberTokens } from '../../jsonUtils';
import type { AgentErrorType } from '../../types';

/** Grok's pinned ACP wire v1 (schema 0.11.4): UTF-8 JSON-RPC lines, not Content-Length. */
export const GROK_ACP_PROTOCOL_VERSION = 1;
/** Includes the terminating LF, matching the pinned upstream line ceiling. */
export const GROK_ACP_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export type AcpRequestId = number | string;
export interface AcpCall {
	jsonrpc: '2.0';
	id?: AcpRequestId;
	method: string;
	params?: Record<string, unknown> | unknown[];
}
export type AcpAnswer =
	| { result: unknown; error?: never }
	| { error: { code: number; message: string; data?: unknown }; result?: never };
export type AcpResponse = AcpAnswer & { jsonrpc: '2.0'; id: AcpRequestId };
export type AcpMessage = AcpCall | AcpResponse;
export interface AcpInitialization {
	protocolVersion: number;
	agentCapabilities: Record<string, unknown>;
	authMethods: Record<string, unknown>[];
	agentInfo?: Record<string, unknown> | null;
	_meta?: Record<string, unknown> | null;
}

export type AcpFailure =
	| 'closed'
	| 'write'
	| 'timeout'
	| 'invalid-timeout'
	| 'malformed-frame'
	| 'frame-too-large'
	| 'invalid-frame-limit'
	| 'incomplete-frame'
	| 'negotiation-failed'
	| 'not-initialized'
	| 'handler-failed';

/** Fixed diagnostics never retain payloads, arbitrary methods, stderr or writer exceptions. */
export class GrokAcpTransportError extends Error {
	constructor(readonly reason: AcpFailure) {
		super(`Grok ACP transport: ${reason}`);
		this.name = 'GrokAcpTransportError';
	}
}

/**
 * A JSON-RPC error the peer answered with. Only the numeric code and the error type it was
 * classified as at the client boundary are kept; the provider's message never is.
 */
export class GrokAcpRequestError extends Error {
	constructor(
		readonly code: number,
		readonly errorType?: AgentErrorType
	) {
		super(`Grok ACP request failed (${code})`);
		this.name = 'GrokAcpRequestError';
	}
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate envelopes only; session/event/permission schemas belong to their adapters. */
export function parseAcpMessage(line: string): AcpMessage {
	let value: unknown;
	try {
		value = JSON.parse(preserveJsonNumberTokens(line, 'costUsdTicks'));
	} catch {
		throw new GrokAcpTransportError('malformed-frame');
	}
	if (object(value) && value.jsonrpc === '2.0') {
		const hasId = Object.prototype.hasOwnProperty.call(value, 'id');
		const validId = typeof value.id === 'string' || Number.isSafeInteger(value.id);
		const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
		const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
		if (Object.prototype.hasOwnProperty.call(value, 'method')) {
			if (
				typeof value.method === 'string' &&
				(!hasId || validId) &&
				!hasResult &&
				!hasError &&
				(value.params === undefined || object(value.params) || Array.isArray(value.params))
			)
				return value as unknown as AcpCall;
		} else if (
			hasId &&
			validId &&
			hasResult !== hasError &&
			!Object.prototype.hasOwnProperty.call(value, 'params')
		) {
			if (
				!hasError ||
				(object(value.error) &&
					Number.isSafeInteger(value.error.code) &&
					typeof value.error.message === 'string')
			)
				return value as unknown as AcpResponse;
		}
	}
	throw new GrokAcpTransportError('malformed-frame');
}

/** Absent defaults are valid in schema 0.11.4; unknown extensions remain opaque data. */
export function parseAcpInitialization(value: unknown): AcpInitialization {
	const fail = () => {
		throw new GrokAcpTransportError('negotiation-failed');
	};
	if (!object(value) || value.protocolVersion !== GROK_ACP_PROTOCOL_VERSION) return fail();
	const caps = value.agentCapabilities === undefined ? {} : value.agentCapabilities;
	const auth = value.authMethods === undefined ? [] : value.authMethods;
	if (!object(caps) || !Array.isArray(auth)) return fail();
	if (caps.loadSession !== undefined && typeof caps.loadSession !== 'boolean') return fail();
	for (const [key, flags] of [
		['promptCapabilities', ['image', 'audio', 'embeddedContext']],
		['mcpCapabilities', ['http', 'sse']],
		['sessionCapabilities', []],
	] as const) {
		const group = caps[key];
		if (group === undefined) continue;
		if (!object(group)) return fail();
		for (const flag of flags)
			if (group[flag] !== undefined && typeof group[flag] !== 'boolean') return fail();
		if (key === 'sessionCapabilities') {
			for (const method of ['list', 'resume', 'close'])
				if (group[method] != null && !object(group[method])) return fail();
		}
	}
	if (value._meta != null && !object(value._meta)) return fail();
	if (
		value.agentInfo != null &&
		(!object(value.agentInfo) ||
			typeof value.agentInfo.name !== 'string' ||
			typeof value.agentInfo.version !== 'string' ||
			(value.agentInfo.title != null && typeof value.agentInfo.title !== 'string'))
	)
		return fail();
	for (const method of auth) {
		if (
			!object(method) ||
			typeof method.id !== 'string' ||
			typeof method.name !== 'string' ||
			(method.description != null && typeof method.description !== 'string')
		)
			return fail();
	}
	return { ...value, agentCapabilities: caps, authMethods: auth } as unknown as AcpInitialization;
}

/**
 * Checks bytes BEFORE decoding/retaining each segment; dispatches one frame at a time.
 * BufferedLineReader caps only leftover string tails after extraction, so it cannot
 * enforce ACP's fatal per-frame byte limit. No complete-frame queue is retained here.
 */
export class AcpFrameDecoder {
	private decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	private text = '';
	private bytes = 0;
	constructor(readonly maxFrameBytes = GROK_ACP_MAX_FRAME_BYTES) {
		if (
			!Number.isSafeInteger(maxFrameBytes) ||
			maxFrameBytes < 1 ||
			maxFrameBytes > GROK_ACP_MAX_FRAME_BYTES
		) {
			throw new GrokAcpTransportError('invalid-frame-limit');
		}
	}

	push(chunk: Uint8Array, accept: (message: AcpMessage) => boolean): void {
		for (let start = 0; start < chunk.length; ) {
			const newline = chunk.indexOf(10, start);
			const end = newline < 0 ? chunk.length : newline;
			this.bytes += end - start + (newline < 0 ? 0 : 1);
			if (this.bytes > this.maxFrameBytes) {
				this.reset();
				throw new GrokAcpTransportError('frame-too-large');
			}
			try {
				this.text += this.decoder.decode(chunk.subarray(start, end), { stream: newline < 0 });
			} catch {
				this.reset();
				throw new GrokAcpTransportError('malformed-frame');
			}
			if (newline < 0) return;
			const line = this.text;
			this.text = '';
			this.bytes = 0;
			if (!/^[\t\r ]*$/.test(line) && !accept(parseAcpMessage(line))) return;
			start = end + 1;
		}
	}

	get bufferedBytes(): number {
		return this.bytes;
	}
	reset(): void {
		this.text = '';
		this.bytes = 0;
		this.decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	}
}
