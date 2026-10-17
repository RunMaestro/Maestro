/**
 * The token proxy's compressor: shorten the large tool results in one model
 * request, and change nothing else.
 *
 * {@link compressRequestBody} takes the request body as TEXT and returns text.
 * It never parses the body into a value and prints it again: it locates the
 * tool results (`json-spans.ts`), writes a new string literal over each one it
 * compresses, and leaves every other byte as the client sent it. The system
 * prompt, the tool definitions, the assistant's turns and the user's words are
 * not read past what it takes to walk around them.
 *
 * ## What is a tool result
 *
 *   - Anthropic Messages: a `tool_result` block's text (a string, or the `text`
 *     parts of its content list).
 *   - OpenAI Chat Completions: a `tool` role message's content.
 *   - OpenAI Responses: the `output` of a `function_call_output` (or
 *     `custom_tool_call_output`) item.
 *
 * ## What is never touched
 *
 *   - Anything that is not a tool result (so: the system prompt, tool
 *     definitions, every user and assistant message).
 *   - **The most recent user message, and tool results the model has not
 *     answered yet.** The model reads every tool result in full once. In an
 *     Anthropic request fresh tool results ARE the last user message. In the
 *     OpenAI formats they are the tool outputs after the last assistant item,
 *     so those are held back the same way.
 *   - Any block marked with `cache_control`, and everything inside it.
 *   - A tool result under the size threshold.
 *
 * ## Early mode (`options.early`, the agent's `compress-early` proxy mode)
 *
 * The two middle rules above are what make `compress` cost more than
 * passthrough in a short session: a result is written to the provider's prompt
 * cache in full, then written again shortened one request later (measured:
 * 2% to 8% more over 4 to 5 requests). Early mode lifts exactly those two
 * rules. A fresh tool result, and the block carrying the `cache_control`
 * breakpoint, are shortened before the model first reads them, so nothing is
 * ever cached in full. It is still only tool results: the user's words in the
 * same message are not read. What changes is what the model sees, which is why
 * it is a mode the user picks and not the default.
 *
 * ## The order of work for one block
 *
 *   1. Hash the original (SHA-256). A verdict already in the cache is used as
 *      it is: the same bytes as every earlier turn.
 *   2. Otherwise run the heuristics (`compressors.ts`).
 *   3. When the result is still at or above the model threshold, ask the
 *      `token-proxy` Local Models task to shorten it. The task is off by
 *      default; off, unavailable and timed out all leave the heuristic result.
 *   4. Keep the block as sent unless the replacement (with its marker) is at
 *      least {@link MIN_SAVING_RATIO} smaller.
 *   5. Store the verdict, with the original when it was compressed, BEFORE the
 *      replacement is used. A block whose verdict cannot be stored is sent as
 *      it was: an unrecorded compression could not be reproduced or audited.
 *
 * A compressed block ends with `[maestro-compressed sha256=<hash>
 * original_tokens=<n>]` on its own line.
 */

import { estimateTokenCount } from '../../../shared/formatters';
import type { TokenProxyRequestKind } from '../../../shared/local-models/token-proxy';
import { getPrompt } from '../../prompt-manager';
import { createKeyedWriteQueue } from '../../utils/atomic-json-store';
import { logger } from '../../utils/logger';
import { runLocalTask, type LocalTaskUnavailable } from '../task-router';
import { chunkText } from '../text-chunker';
import {
	contentHash,
	getCompressionCache,
	type CompressionCache,
	type CompressionVerdict,
	type CompressorId,
} from './compression-cache';
import { compressWithHeuristics } from './compressors';
import {
	isNullSpan,
	memberOf,
	parseJsonSpans,
	spliceSpans,
	stringValue,
	type JsonSpan,
	type SpanEdit,
} from './json-spans';

const LOG_CONTEXT = '[TokenProxy]';

const TASK_ID = 'token-proxy';

/** A tool result under this many tokens is never touched. */
export const DEFAULT_COMPRESS_MIN_TOKENS = 1000;

/** A tool result still this large after the heuristics is given to the local model. */
export const DEFAULT_MODEL_MIN_TOKENS = 8000;

/**
 * A replacement must be at least this much smaller than the original, marker
 * included. Below that the block is kept: a changed block that saves nothing
 * only costs a cache entry.
 */
export const MIN_SAVING_RATIO = 0.1;

/**
 * The model is not asked to read more than this. Past it the heuristic result
 * stands: the request is waiting on the answer.
 */
export const MODEL_MAX_INPUT_TOKENS = 24000;

/**
 * The model reads the text in pieces of this size and shortens each. A local
 * model's context is 4096 tokens, and the character estimate runs low on logs
 * and code, so a piece has to leave room for that error, the prompt and the
 * reply.
 */
export const MODEL_CHUNK_TOKENS = 1200;

/** The reply budget for one piece: a third of what went in. */
export const MODEL_CHUNK_MAX_TOKENS = 400;

/** How long the model may take over one tool result, all pieces together. */
export const MODEL_TIMEOUT_MS = 60 * 1000;

const MARKER_PATTERN = /\[maestro-compressed sha256=([0-9a-f]{64}) original_tokens=(\d+)\]\s*$/;

/** The line that ends every compressed block. */
export function formatCompressionMarker(hash: string, originalTokens: number): string {
	return `[maestro-compressed sha256=${hash} original_tokens=${originalTokens}]`;
}

/** The marker a compressed block ends with, or `null` when the text has none. */
export function parseCompressionMarker(
	text: string
): { hash: string; originalTokens: number } | null {
	const match = MARKER_PATTERN.exec(text);
	return match ? { hash: match[1], originalTokens: Number(match[2]) } : null;
}

/** What the model tier answered for one tool result. */
export type ModelSummary =
	| { status: 'ok'; text: string }
	/** The task is off, or the text is past what the model is asked to read. */
	| { status: 'skipped' }
	| { status: 'failed'; code: string };

export type ToolResultSummarizer = (text: string) => Promise<ModelSummary>;

export interface CompressRequestOptions {
	/** Defaults to {@link DEFAULT_COMPRESS_MIN_TOKENS}. */
	minTokens?: number;
	/** Defaults to {@link DEFAULT_MODEL_MIN_TOKENS}. */
	modelMinTokens?: number;
	/** Defaults to the app's cache in the Maestro data dir. */
	cache?: CompressionCache;
	/** The model tier. Defaults to {@link summarizeToolResult}. */
	summarize?: ToolResultSummarizer;
	/**
	 * Called when the assigned model could not run, so the caller can tell the
	 * user (`reportLocalTaskUnavailable`). The block falls back to its heuristic
	 * result either way.
	 */
	onModelUnavailable?: (verdict: LocalTaskUnavailable) => void;
	/**
	 * `compress-early` mode: also shorten the tool results the model has NOT
	 * read yet (the fresh ones, and any block carrying the `cache_control`
	 * breakpoint, which is where a client puts it). Off, a fresh result goes out
	 * whole and is shortened on the next request.
	 */
	early?: boolean;
}

/** One block that was replaced in this request. */
export interface CompressedBlock {
	hash: string;
	originalTokens: number;
	compressedTokens: number;
	compressors: CompressorId[];
	/** The verdict came from the cache: no compressor ran for it in this request. */
	cached: boolean;
}

export interface CompressRequestStats {
	/** Tool results outside the protected regions. */
	candidates: number;
	/** Candidates under the size threshold, left alone without being hashed. */
	belowThreshold: number;
	compressed: number;
	/** Candidates that were evaluated and are sent as they were. */
	kept: number;
	/** Verdicts (compressed or kept) that came from the cache. */
	cacheHits: number;
	/** Tokens of the compressed blocks before, and after. */
	originalTokens: number;
	compressedTokens: number;
	/** How many compressed blocks each compressor contributed to. */
	compressors: Record<CompressorId, number>;
	/** Blocks the model tier was tried on in this request and failed. */
	modelFailures: number;
	/** Blocks left alone because the cache could not be read or written. */
	storeFailures: number;
}

export interface CompressRequestResult {
	/** The body to send. The input string itself when nothing changed. */
	body: string;
	changed: boolean;
	blocks: CompressedBlock[];
	stats: CompressRequestStats;
}

function emptyStats(): CompressRequestStats {
	return {
		candidates: 0,
		belowThreshold: 0,
		compressed: 0,
		kept: 0,
		cacheHits: 0,
		originalTokens: 0,
		compressedTokens: 0,
		compressors: { json: 0, logs: 0, 'long-lines': 0, model: 0 },
		modelFailures: 0,
		storeFailures: 0,
	};
}

// ---------------------------------------------------------------------------
// Finding the tool results
// ---------------------------------------------------------------------------

/** Content part types that carry text, across the three APIs. */
const TEXT_PART_TYPES: ReadonlySet<string> = new Set(['text', 'input_text', 'output_text']);

/** Responses input items that are a tool's output. */
const RESPONSES_OUTPUT_TYPES: ReadonlySet<string> = new Set([
	'function_call_output',
	'custom_tool_call_output',
]);

function field(body: string, span: JsonSpan, key: string): string | undefined {
	return stringValue(body, memberOf(span, key));
}

function hasCacheControl(body: string, span: JsonSpan): boolean {
	const marker = memberOf(span, 'cache_control');
	return marker !== undefined && !isNullSpan(body, marker);
}

function lastIndexWhere(items: readonly JsonSpan[], test: (item: JsonSpan) => boolean): number {
	for (let i = items.length - 1; i >= 0; i--) {
		if (test(items[i])) return i;
	}
	return -1;
}

/** The text of a tool result: the string itself, or the text parts of a content list. */
function collectText(
	body: string,
	content: JsonSpan | undefined,
	out: JsonSpan[],
	early: boolean
): void {
	if (!content) return;
	if (content.kind === 'string') {
		out.push(content);
		return;
	}
	if (content.kind !== 'array') return;
	for (const part of content.items) {
		if (!early && hasCacheControl(body, part)) continue;
		if (!TEXT_PART_TYPES.has(field(body, part, 'type') ?? '')) continue;
		const text = memberOf(part, 'text');
		if (text?.kind === 'string') out.push(text);
	}
}

function anthropicToolResults(body: string, root: JsonSpan, early: boolean): JsonSpan[] {
	const messages = memberOf(root, 'messages');
	if (messages?.kind !== 'array') return [];
	// Fresh tool results arrive in the last user message. It goes out whole,
	// unless the mode is early. Only `tool_result` blocks are ever collected, so
	// what the user typed in that message is not read in either mode.
	const lastUser = lastIndexWhere(messages.items, (item) => field(body, item, 'role') === 'user');
	const out: JsonSpan[] = [];
	messages.items.forEach((message, index) => {
		if (!early && index === lastUser) return;
		const content = memberOf(message, 'content');
		if (content?.kind !== 'array') return;
		for (const block of content.items) {
			if (field(body, block, 'type') !== 'tool_result') continue;
			// The breakpoint sits on the newest block, which in early mode is the
			// one to shorten. Only the text is rewritten; the marker stays.
			if (!early && hasCacheControl(body, block)) continue;
			collectText(body, memberOf(block, 'content'), out, early);
		}
	});
	return out;
}

function chatCompletionsToolResults(body: string, root: JsonSpan, early: boolean): JsonSpan[] {
	const messages = memberOf(root, 'messages');
	if (messages?.kind !== 'array') return [];
	// A tool message after the last assistant message has not been answered yet.
	const lastAssistant = lastIndexWhere(
		messages.items,
		(item) => field(body, item, 'role') === 'assistant'
	);
	const end = early ? messages.items.length : lastAssistant;
	const out: JsonSpan[] = [];
	for (let index = 0; index < end; index++) {
		const message = messages.items[index];
		if (field(body, message, 'role') !== 'tool') continue;
		if (!early && hasCacheControl(body, message)) continue;
		collectText(body, memberOf(message, 'content'), out, early);
	}
	return out;
}

/** Whether a Responses input item is something the model produced. */
function isModelItem(body: string, item: JsonSpan): boolean {
	if (field(body, item, 'role') === 'assistant') return true;
	const type = field(body, item, 'type') ?? '';
	return type === 'reasoning' || type.endsWith('_call');
}

function responsesToolResults(body: string, root: JsonSpan, early: boolean): JsonSpan[] {
	const input = memberOf(root, 'input');
	if (input?.kind !== 'array') return [];
	// An output after the last model item has not been answered yet.
	const lastModel = lastIndexWhere(input.items, (item) => isModelItem(body, item));
	const end = early ? input.items.length : lastModel;
	const out: JsonSpan[] = [];
	for (let index = 0; index < end; index++) {
		const item = input.items[index];
		if (!RESPONSES_OUTPUT_TYPES.has(field(body, item, 'type') ?? '')) continue;
		if (!early && hasCacheControl(body, item)) continue;
		collectText(body, memberOf(item, 'output'), out, early);
	}
	return out;
}

/**
 * The string literals of `body` that hold a tool result's text and may be
 * compressed: every tool result outside the protected regions, whatever its
 * size. Exported for tests of the protection rules.
 */
export function findToolResultSpans(
	kind: TokenProxyRequestKind,
	body: string,
	root: JsonSpan,
	options: { early?: boolean } = {}
): JsonSpan[] {
	const early = options.early === true;
	switch (kind) {
		case 'anthropic-messages':
			return anthropicToolResults(body, root, early);
		case 'openai-chat-completions':
			return chatCompletionsToolResults(body, root, early);
		case 'openai-responses':
			return responsesToolResults(body, root, early);
		case 'other':
			return [];
	}
}

// ---------------------------------------------------------------------------
// The model tier
// ---------------------------------------------------------------------------

/**
 * Shorten a tool result with the `token-proxy` Local Models task.
 *
 * The text is read in pieces (a local model's context holds about one), each
 * shortened by itself, and the replies are joined in order. One piece that
 * fails abandons the whole text: a summary with a hole in it would say less
 * than the heuristic result it replaces, without saying so.
 */
export async function summarizeToolResult(
	text: string,
	options: { onUnavailable?: (verdict: LocalTaskUnavailable) => void } = {}
): Promise<ModelSummary> {
	const tokens = estimateTokenCount(text);
	if (tokens > MODEL_MAX_INPUT_TOKENS) return { status: 'skipped' };

	const chunks = chunkText(text, {
		countTokens: estimateTokenCount,
		maxTokens: MODEL_CHUNK_TOKENS,
		overlapTokens: 0,
		// Windows close at line ends, so they can run under-full: never more than
		// twice the even split. The cap only has to be out of the way.
		maxChunks: 2 * Math.ceil(tokens / MODEL_CHUNK_TOKENS) + 1,
	});
	const system = getPrompt('token-proxy-local');
	const signal = AbortSignal.timeout(MODEL_TIMEOUT_MS);
	const parts: string[] = [];

	for (const chunk of chunks) {
		const verdict = await runLocalTask(TASK_ID, {
			system,
			prompt: chunk,
			maxTokens: MODEL_CHUNK_MAX_TOKENS,
			signal,
		});
		switch (verdict.status) {
			// The registry refuses the Utility Agent for this task; a hand-edited
			// settings file is the only way to it, and there is no agent path.
			case 'off':
			case 'use-utility-agent':
				return { status: 'skipped' };
			case 'cancelled':
				logger.warn('Token proxy summary timed out', LOG_CONTEXT, { source: verdict.source });
				return { status: 'failed', code: 'timeout' };
			case 'unavailable':
				logger.warn('Token proxy summary skipped: assigned model unavailable', LOG_CONTEXT, {
					source: verdict.source,
					code: verdict.code,
					reason: verdict.reason,
				});
				options.onUnavailable?.(verdict);
				return { status: 'failed', code: verdict.code };
			case 'ok': {
				const part = verdict.text.trim();
				if (part === '') {
					logger.warn('Assigned model returned an empty token proxy summary', LOG_CONTEXT, {
						source: verdict.source,
					});
					return { status: 'failed', code: 'empty-reply' };
				}
				parts.push(part);
			}
		}
	}
	return { status: 'ok', text: parts.join('\n') };
}

// ---------------------------------------------------------------------------
// One block
// ---------------------------------------------------------------------------

interface BlockContext {
	minTokens: number;
	modelMinTokens: number;
	cache: CompressionCache;
	summarize: ToolResultSummarizer;
}

type BlockResolution =
	| { status: 'below-threshold' }
	| { status: 'store-failed' }
	| { status: 'resolved'; verdict: CompressionVerdict; cached: boolean };

/**
 * One line per content hash, shared by every request in the process. Two
 * requests that carry the same new block must not both decide it: with a model
 * in the path they could decide differently, and the second has only to wait
 * to read the first one's verdict.
 */
const blockQueue = createKeyedWriteQueue();

/** Decide a block that has no verdict yet. */
async function decideBlock(
	text: string,
	hash: string,
	originalTokens: number,
	context: BlockContext
): Promise<CompressionVerdict> {
	const heuristic = compressWithHeuristics(text);
	let shortened = heuristic.text;
	const compressors: CompressorId[] = [...heuristic.applied];
	let modelFailure: string | undefined;

	if (estimateTokenCount(shortened) >= context.modelMinTokens) {
		const summary = await context.summarize(shortened);
		if (summary.status === 'failed') {
			modelFailure = summary.code;
		} else if (summary.status === 'ok') {
			if (summary.text.length < shortened.length) {
				shortened = summary.text;
				compressors.push('model');
			} else {
				modelFailure = 'not-shorter';
			}
		}
	}

	const replacement = `${shortened}\n${formatCompressionMarker(hash, originalTokens)}`;
	const base = {
		hash,
		originalTokens,
		createdAt: Date.now(),
		...(modelFailure !== undefined ? { modelFailure } : {}),
	};
	if (compressors.length === 0 || replacement.length > text.length * (1 - MIN_SAVING_RATIO)) {
		return { ...base, outcome: 'kept' };
	}
	return {
		...base,
		outcome: 'compressed',
		text: replacement,
		compressedTokens: estimateTokenCount(replacement),
		compressors,
	};
}

/** A cache failure the block can survive (it is sent as it was); anything else is a bug. */
function storeFailed(error: unknown, operation: 'read' | 'write', hash: string): BlockResolution {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (typeof code !== 'string') throw error;
	logger.warn(
		`Token proxy cache ${operation} failed; the block is sent uncompressed`,
		LOG_CONTEXT,
		{ hash, code, error: error instanceof Error ? error.message : String(error) }
	);
	return { status: 'store-failed' };
}

async function resolveBlock(text: string, context: BlockContext): Promise<BlockResolution> {
	const originalTokens = estimateTokenCount(text);
	if (originalTokens < context.minTokens) return { status: 'below-threshold' };
	const hash = contentHash(text);
	return blockQueue.enqueue(hash, async (): Promise<BlockResolution> => {
		let cached: CompressionVerdict | null;
		try {
			cached = await context.cache.read(hash);
		} catch (error) {
			return storeFailed(error, 'read', hash);
		}
		if (cached) return { status: 'resolved', verdict: cached, cached: true };

		const verdict = await decideBlock(text, hash, originalTokens, context);
		try {
			await context.cache.write(verdict, text);
		} catch (error) {
			return storeFailed(error, 'write', hash);
		}
		return { status: 'resolved', verdict, cached: false };
	});
}

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

/**
 * Compress the tool results of one request body.
 *
 * `body` is the decoded request text. When nothing was compressed the result
 * carries the same string and `changed: false`, and the caller forwards the
 * bytes it received. A body that is not JSON, or not a shape this module
 * knows, comes back unchanged: this function has no failure that stops a
 * request.
 */
export async function compressRequestBody(
	kind: TokenProxyRequestKind,
	body: string,
	options: CompressRequestOptions = {}
): Promise<CompressRequestResult> {
	const stats = emptyStats();
	const unchanged: CompressRequestResult = { body, changed: false, blocks: [], stats };
	if (kind === 'other') return unchanged;
	const root = parseJsonSpans(body);
	if (!root) return unchanged;

	const context: BlockContext = {
		minTokens: options.minTokens ?? DEFAULT_COMPRESS_MIN_TOKENS,
		modelMinTokens: options.modelMinTokens ?? DEFAULT_MODEL_MIN_TOKENS,
		cache: options.cache ?? getCompressionCache(),
		summarize:
			options.summarize ??
			((text) => summarizeToolResult(text, { onUnavailable: options.onModelUnavailable })),
	};

	const spans = findToolResultSpans(kind, body, root, { early: options.early });
	stats.candidates = spans.length;
	const resolutions = await Promise.all(
		spans.map((span) => {
			const text = stringValue(body, span);
			// A literal that does not decode is not a string this module may rewrite.
			if (text === undefined) return { status: 'below-threshold' } as const;
			return resolveBlock(text, context);
		})
	);

	const edits: SpanEdit[] = [];
	const blocks: CompressedBlock[] = [];
	resolutions.forEach((resolution, index) => {
		if (resolution.status === 'below-threshold') {
			stats.belowThreshold++;
			return;
		}
		if (resolution.status === 'store-failed') {
			stats.storeFailures++;
			return;
		}
		const { verdict, cached } = resolution;
		if (cached) stats.cacheHits++;
		else if (verdict.modelFailure !== undefined) stats.modelFailures++;
		if (verdict.outcome === 'kept') {
			stats.kept++;
			return;
		}
		stats.compressed++;
		stats.originalTokens += verdict.originalTokens;
		stats.compressedTokens += verdict.compressedTokens;
		for (const id of verdict.compressors) stats.compressors[id]++;
		blocks.push({
			hash: verdict.hash,
			originalTokens: verdict.originalTokens,
			compressedTokens: verdict.compressedTokens,
			compressors: verdict.compressors,
			cached,
		});
		edits.push({
			start: spans[index].start,
			end: spans[index].end,
			text: JSON.stringify(verdict.text),
		});
	});

	if (edits.length === 0) return unchanged;
	return { body: spliceSpans(body, edits), changed: true, blocks, stats };
}
