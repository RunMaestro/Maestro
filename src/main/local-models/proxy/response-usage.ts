/**
 * What the provider itself counted for one request: the `usage` object every
 * model API puts in its answer, read from the response the proxy forwards.
 *
 * The proxy's own token figures are characters / 4, which runs about 1.9 times
 * low on logs full of paths and digits and is right on plain prose. The
 * provider's count is exact, covers passthrough requests the proxy never reads,
 * and splits a prompt into the classes that are billed differently: uncached
 * input, cache reads and cache writes. A cache write that grows on a request
 * where nothing new arrived is the sign of a broken cached prefix.
 *
 * The response is read, never changed. {@link createProviderUsageReader} sees
 * the bytes as they are piped to the client. An event stream with no
 * `Content-Encoding` is scanned line by line as it arrives, and only the
 * running usage is kept (and the one line not yet ended). A JSON body, or an
 * encoded answer, needs the whole body to decode, so the reader keeps a bounded
 * copy of it and parses it once the response has ended. A body (or one stream
 * line) past {@link USAGE_READ_MAX_BYTES}, an encoding with no decoder, or a
 * body that names no usage gives `null`, which the stats row stores as
 * unknown, never as zero.
 *
 * An answer rarely names all four classes, and a class it left out is not a
 * zero. The four numbers stay for compatibility, with 0 for a class nobody
 * named, and `reportedness` records how each one got its number: `reported` (the
 * answer named it, a named zero included), `derived` (OpenAI's uncached input,
 * its prompt total minus its cached tokens, which needs both), `not-applicable`
 * (OpenAI has no cache-write class, so 0 is true by definition) or `unreported`
 * (a default 0 that says nothing). A prompt total with no cache detail is
 * therefore not uncached input. The usage is `null` when no class was reported
 * or derived.
 */

import * as zlib from 'zlib';
import type {
	TokenProxyProviderUsage,
	TokenProxyRequestKind,
} from '../../../shared/local-models/token-proxy';
import type {
	ProxyProviderClassStatus,
	ProxyProviderUsageClass,
} from '../../../shared/stats-types';

/**
 * A kept body (or one stream line) past this is not read for its usage. An
 * event stream's usage lines are far smaller.
 */
export const USAGE_READ_MAX_BYTES = 16 * 1024 * 1024;

export interface ProviderUsageReader {
	/** One chunk of the response body exactly as the upstream sent it. */
	push(chunk: Buffer): void;
	/** The usage the body named, once it has ended (or was cut short). */
	finish(): TokenProxyProviderUsage | null;
}

type ZstdSync = (buffer: Buffer) => Buffer;

/** Decode a whole body. Partial output from a stream cut short is still used. */
function decodeBody(raw: Buffer, encoding: string | null): Buffer | null {
	switch (encoding) {
		case null:
		case 'identity':
			return raw;
		case 'gzip':
		case 'x-gzip':
			return zlib.gunzipSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
		case 'deflate':
			return zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
		case 'br':
			return zlib.brotliDecompressSync(raw, {
				finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
			});
		case 'zstd': {
			const zstd = (zlib as unknown as { zstdDecompressSync?: ZstdSync }).zstdDecompressSync;
			return zstd ? zstd(raw) : null;
		}
		default:
			return null;
	}
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? Math.round(value)
		: undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Every place an API puts its usage in one JSON value (an event or a whole body). */
function usageObjectOf(value: unknown): Record<string, unknown> | undefined {
	const root = record(value);
	if (!root) return undefined;
	// Anthropic `message_start`: { message: { usage } }; OpenAI Responses
	// `response.completed`: { response: { usage } }; every other shape: { usage }.
	return (
		record(root.usage) ??
		record(record(root.message)?.usage) ??
		record(record(root.response)?.usage)
	);
}

/**
 * What an answer named, field by field. A field it never carried stays
 * undefined, and that is not a zero. Anthropic names its four classes. OpenAI
 * names a prompt total with its cached tokens inside it (`prompt`), the cached
 * part of it (`cacheRead`) and the output, and never the uncached input, which
 * {@link readingsOf} derives from the first two.
 */
interface NamedUsage {
	input?: number;
	prompt?: number;
	cacheRead?: number;
	cacheWrite?: number;
	output?: number;
}

/**
 * Fold one usage object into what the answer has named so far. Later events
 * carry cumulative counts (Anthropic's `message_delta` repeats output, and lately
 * input, as running totals), so a field that is present replaces the earlier
 * value and a field that is absent leaves it.
 */
function foldUsage(
	kind: TokenProxyRequestKind,
	usage: Record<string, unknown>,
	into: NamedUsage
): void {
	if (kind === 'anthropic-messages') {
		into.input = count(usage.input_tokens) ?? into.input;
		into.cacheRead = count(usage.cache_read_input_tokens) ?? into.cacheRead;
		into.cacheWrite = count(usage.cache_creation_input_tokens) ?? into.cacheWrite;
		into.output = count(usage.output_tokens) ?? into.output;
		return;
	}
	const chat = kind === 'openai-chat-completions';
	const details = record(chat ? usage.prompt_tokens_details : usage.input_tokens_details);
	into.prompt = count(chat ? usage.prompt_tokens : usage.input_tokens) ?? into.prompt;
	into.cacheRead = count(details?.cached_tokens) ?? into.cacheRead;
	into.output = count(chat ? usage.completion_tokens : usage.output_tokens) ?? into.output;
}

/** One class as a row stores it: the number, and how the answer gave it. */
interface ClassReading {
	tokens: number;
	status: ProxyProviderClassStatus;
}

/** A class the answer never named keeps the compatibility value 0, and that 0 says nothing. */
const UNREPORTED: ClassReading = { tokens: 0, status: 'unreported' };

/** A class the answer named, a named zero included. */
function reported(tokens: number | undefined): ClassReading {
	return tokens === undefined ? UNREPORTED : { tokens, status: 'reported' };
}

/** Every class of the answer, in the normalized split: input is uncached input. */
function readingsOf(
	kind: TokenProxyRequestKind,
	named: NamedUsage
): Record<ProxyProviderUsageClass, ClassReading> {
	if (kind === 'anthropic-messages') {
		return {
			input: reported(named.input),
			cacheRead: reported(named.cacheRead),
			cacheWrite: reported(named.cacheWrite),
			output: reported(named.output),
		};
	}
	// OpenAI counts cached tokens INSIDE the prompt total, so uncached input is the
	// total minus the cached part, and it needs both. A total with no cache detail
	// does not say how much of it was uncached, so it is not stored as input. OpenAI
	// writes no cache-write class: 0 is true by definition.
	const { prompt, cacheRead } = named;
	return {
		input:
			prompt !== undefined && cacheRead !== undefined
				? { tokens: Math.max(0, prompt - cacheRead), status: 'derived' }
				: UNREPORTED,
		cacheRead: reported(cacheRead),
		cacheWrite: { tokens: 0, status: 'not-applicable' },
		output: reported(named.output),
	};
}

/**
 * The usage an answer named, or null when it named no class. A class counts when
 * the answer reported it or it is derived from what the answer reported. One that
 * is not applicable is zero by definition and shows nothing was named.
 */
function complete(kind: TokenProxyRequestKind, named: NamedUsage): TokenProxyProviderUsage | null {
	const readings = readingsOf(kind, named);
	const gave = Object.values(readings).some(
		({ status }) => status === 'reported' || status === 'derived'
	);
	if (!gave) return null;
	return {
		inputTokens: readings.input.tokens,
		cacheReadTokens: readings.cacheRead.tokens,
		cacheWriteTokens: readings.cacheWrite.tokens,
		outputTokens: readings.output.tokens,
		reportedness: {
			input: readings.input.status,
			cacheRead: readings.cacheRead.status,
			cacheWrite: readings.cacheWrite.status,
			output: readings.output.status,
		},
	};
}

/** The usage named by a whole response body: an event stream, or one JSON value. */
export function parseProviderUsage(
	kind: TokenProxyRequestKind,
	text: string
): TokenProxyProviderUsage | null {
	if (kind === 'other') return null;
	const named: NamedUsage = {};
	const trimmed = text.trimStart();
	if (trimmed.startsWith('{')) {
		try {
			const usage = usageObjectOf(JSON.parse(trimmed));
			if (usage) foldUsage(kind, usage, named);
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
		}
		return complete(kind, named);
	}
	for (const line of text.split('\n')) foldEventLine(kind, line, named);
	return complete(kind, named);
}

/** Fold one event-stream line into what the answer has named, when it is a `data:` line with a usage. */
function foldEventLine(kind: TokenProxyRequestKind, line: string, into: NamedUsage): void {
	if (!line.startsWith('data:') || !line.includes('"usage"')) return;
	try {
		const usage = usageObjectOf(JSON.parse(line.slice(5).trim()));
		if (usage) foldUsage(kind, usage, into);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
	}
}

const NEWLINE = 0x0a;

/** Whether a byte is JSON or event-stream whitespace (space, tab, CR, LF). */
function isBlankByte(byte: number): boolean {
	return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === NEWLINE;
}

/**
 * A reader for one response. `contentEncoding` is the response's own header
 * (lowercase), or null.
 *
 * With no encoding, the first byte that is not whitespace decides: `{` is one
 * JSON value, kept (bounded) and parsed at the end; anything else is an event
 * stream, read one complete line at a time as it arrives, so the memory it
 * holds is the running usage and the line not yet ended. An encoded answer is
 * kept (bounded) and decoded at the end. Past the bound it answers null.
 */
export function createProviderUsageReader(
	kind: TokenProxyRequestKind,
	contentEncoding: string | null
): ProviderUsageReader {
	const plain = contentEncoding === null || contentEncoding === 'identity';
	// 'sniff' until the first byte that is not whitespace, on a plain answer.
	let mode: 'sniff' | 'lines' | 'body' = plain ? 'sniff' : 'body';
	const chunks: Buffer[] = [];
	let bytes = 0;
	let overflowed = kind === 'other';

	// The event-stream path: what the answer has named so far, and the line not yet ended.
	const named: NamedUsage = {};
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	// A line past the bound is skipped up to its newline, not read.
	let skippingLine = false;

	const keep = (chunk: Buffer): void => {
		bytes += chunk.length;
		if (bytes > USAGE_READ_MAX_BYTES) {
			overflowed = true;
			chunks.length = 0;
			return;
		}
		chunks.push(chunk);
	};

	const endLine = (tail: Buffer): void => {
		if (skippingLine) {
			skippingLine = false;
		} else {
			const line = Buffer.concat([...pending, tail], pendingBytes + tail.length);
			foldEventLine(kind, line.toString('utf-8').replace(/\r$/, ''), named);
		}
		pending = [];
		pendingBytes = 0;
	};

	const scanLines = (chunk: Buffer): void => {
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(NEWLINE, offset);
			if (newline < 0) {
				const rest = chunk.subarray(offset);
				if (skippingLine) return;
				pendingBytes += rest.length;
				if (pendingBytes > USAGE_READ_MAX_BYTES) {
					skippingLine = true;
					pending = [];
					pendingBytes = 0;
					return;
				}
				// A copy, so the unended line does not hold the whole chunk alive.
				pending.push(Buffer.from(rest));
				return;
			}
			endLine(chunk.subarray(offset, newline));
			offset = newline + 1;
		}
	};

	return {
		push(chunk) {
			if (overflowed || chunk.length === 0) return;
			if (mode === 'sniff') {
				let first = 0;
				while (first < chunk.length && isBlankByte(chunk[first])) first++;
				if (first < chunk.length) mode = chunk[first] === 0x7b ? 'body' : 'lines';
				else {
					// All whitespace so far: kept either way, and decided by a later chunk.
					keep(chunk);
					return;
				}
				if (mode === 'lines') {
					const head = Buffer.concat([...chunks, chunk]);
					chunks.length = 0;
					bytes = 0;
					scanLines(head);
					return;
				}
			}
			if (mode === 'lines') scanLines(chunk);
			else keep(chunk);
		},
		finish() {
			if (overflowed) return null;
			if (mode === 'lines') {
				// A stream cut short may end mid line; a whole `data:` line still counts.
				if (pendingBytes > 0) endLine(Buffer.alloc(0));
				return complete(kind, named);
			}
			if (bytes === 0) return null;
			let body: Buffer | null;
			try {
				body = decodeBody(Buffer.concat(chunks, bytes), contentEncoding);
			} catch {
				// A stream cut mid-frame, or bytes that do not decode: unknown.
				return null;
			} finally {
				chunks.length = 0;
			}
			return body ? parseProviderUsage(kind, body.toString('utf-8')) : null;
		},
	};
}
