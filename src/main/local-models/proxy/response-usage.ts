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
 * The response is read, never changed: {@link createProviderUsageReader} keeps a
 * bounded copy of the bytes as they are piped to the client and parses it once
 * the response has ended. A body past {@link USAGE_READ_MAX_BYTES}, an encoding
 * with no decoder, or a body that names no usage gives `null`, which the stats
 * row stores as unknown, never as zero.
 */

import * as zlib from 'zlib';
import type {
	TokenProxyProviderUsage,
	TokenProxyRequestKind,
} from '../../../shared/local-models/token-proxy';

/** A response body past this is not kept for its usage. An event stream is far smaller. */
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
 * Fold one usage object into the running total. Later events carry cumulative
 * counts (Anthropic's `message_delta` repeats output, and lately input, as
 * running totals), so a field that is present replaces the earlier value.
 */
function foldUsage(
	kind: TokenProxyRequestKind,
	usage: Record<string, unknown>,
	into: Partial<TokenProxyProviderUsage>
): void {
	if (kind === 'anthropic-messages') {
		const input = count(usage.input_tokens);
		const read = count(usage.cache_read_input_tokens);
		const write = count(usage.cache_creation_input_tokens);
		const output = count(usage.output_tokens);
		if (input !== undefined) into.inputTokens = input;
		if (read !== undefined) into.cacheReadTokens = read;
		if (write !== undefined) into.cacheWriteTokens = write;
		if (output !== undefined) into.outputTokens = output;
		return;
	}
	// OpenAI counts cached tokens INSIDE the prompt total and writes no separate
	// cache-write class; the split here matches Anthropic's (input is uncached).
	const chat = kind === 'openai-chat-completions';
	const prompt = count(chat ? usage.prompt_tokens : usage.input_tokens);
	const details = record(chat ? usage.prompt_tokens_details : usage.input_tokens_details);
	const cached = count(details?.cached_tokens) ?? 0;
	const output = count(chat ? usage.completion_tokens : usage.output_tokens);
	if (prompt !== undefined) {
		into.inputTokens = Math.max(0, prompt - cached);
		into.cacheReadTokens = cached;
		into.cacheWriteTokens = 0;
	}
	if (output !== undefined) into.outputTokens = output;
}

function complete(usage: Partial<TokenProxyProviderUsage>): TokenProxyProviderUsage | null {
	const { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } = usage;
	if (inputTokens === undefined && outputTokens === undefined) return null;
	return {
		inputTokens: inputTokens ?? 0,
		cacheReadTokens: cacheReadTokens ?? 0,
		cacheWriteTokens: cacheWriteTokens ?? 0,
		outputTokens: outputTokens ?? 0,
	};
}

/** The usage named by a whole response body: an event stream, or one JSON value. */
export function parseProviderUsage(
	kind: TokenProxyRequestKind,
	text: string
): TokenProxyProviderUsage | null {
	if (kind === 'other') return null;
	const total: Partial<TokenProxyProviderUsage> = {};
	const trimmed = text.trimStart();
	if (trimmed.startsWith('{')) {
		try {
			const usage = usageObjectOf(JSON.parse(trimmed));
			if (usage) foldUsage(kind, usage, total);
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
		}
		return complete(total);
	}
	for (const line of text.split('\n')) {
		if (!line.startsWith('data:') || !line.includes('"usage"')) continue;
		try {
			const usage = usageObjectOf(JSON.parse(line.slice(5).trim()));
			if (usage) foldUsage(kind, usage, total);
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
		}
	}
	return complete(total);
}

/**
 * A reader for one response. `contentEncoding` is the response's own header
 * (lowercase), or null. The copy it keeps is bounded; past the bound it stops
 * keeping and answers null.
 */
export function createProviderUsageReader(
	kind: TokenProxyRequestKind,
	contentEncoding: string | null
): ProviderUsageReader {
	const chunks: Buffer[] = [];
	let bytes = 0;
	let overflowed = kind === 'other';
	return {
		push(chunk) {
			if (overflowed) return;
			bytes += chunk.length;
			if (bytes > USAGE_READ_MAX_BYTES) {
				overflowed = true;
				chunks.length = 0;
				return;
			}
			chunks.push(chunk);
		},
		finish() {
			if (overflowed || bytes === 0) return null;
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
