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
 * ## Protected regions in Compress mode
 *
 *   - Anything that is not a tool result (so: the system prompt, tool
 *     definitions, every user and assistant message).
 *   - **The most recent user message, and tool results after the last
 *     assistant/model item.** This does not establish provider exposure. In an
 *     Anthropic request fresh tool results ARE the last user message. In the
 *     OpenAI formats they are the tool outputs after the last assistant item,
 *     so those are held back the same way.
 *   - Any block marked with `cache_control`, and everything inside it.
 *   - A tool result under the size threshold.
 *
 * ## Early mode (`options.early`, the agent's `compress-early` proxy mode)
 *
 * Retaining a result in full and later shortening it can affect provider cache
 * costs (one dated measurement: 2% to 8% more over 4 to 5 requests, an observation
 * and not a rule). Early mode lifts exactly those two structural protections:
 * recent tool results and blocks carrying a `cache_control` breakpoint become
 * eligible too. Actual prior provider exposure and cache history are unknown.
 * Only tool results remain eligible; the user's words in the same message are
 * not read. The timing policy is a mode the user picks, not the default.
 *
 * Without retrieval, early mode keeps every line of content: it uses the
 * `complete` heuristic profile (no array
 * sampling, no line cuts, no record sampling) and never the local model, under
 * its own cache key ({@link verdictKey}). The one exception is a request whose
 * launch was given the retrieve tool ({@link RetrieveToolCapability}): that
 * model can ask for any original by its hash, so the request is decided with
 * the `full` profile under the plain key, exactly as `compress` decides it.
 *
 * ## The order of work for one block
 *
 *   1. Leave explicit failures and recognized original-recovery output whole
 *      (the shell recovery command, and a result of the retrieve tool).
 *      Otherwise hash the original (SHA-256; in early mode without the
 *      retrieve tool, with the profile prefix of {@link verdictKey}). A verdict already in the cache is used as
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
 * A compressed block ends with `[maestro-compressed sha256=<key>
 * original_tokens=<n>]` on its own line. The key names the cache entry: the
 * SHA-256 of the original in `compress` and in early mode with the retrieve
 * tool, {@link verdictKey} in early mode without it.
 */

import { canonicalJson } from '../../../shared/canonicalJson';
import { estimateTokenCount, getBasename, isAbsolutePath } from '../../../shared/formatters';
import { serializedJsonByteLength } from '../../../shared/jsonUtils';
import { literalCommandTokens } from '../../../shared/literalCommand';
import type { TokenProxyRequestKind } from '../../../shared/local-models/token-proxy';
import { TOKEN_PROXY_RETRIEVE_TOOL_NAME } from '../../../shared/local-models/token-proxy-retrieve-tool';
import { describeToolActivityStatus } from '../../../shared/toolActivityLabel';
import { getPrompt } from '../../prompt-manager';
import { logger } from '../../utils/logger';
import { shellEscape } from '../../utils/shell-escape';
import { runLocalTask, type LocalTaskUnavailable } from '../task-router';
import { chunkText } from '../text-chunker';
import {
	contentHash,
	getCompressionCache,
	isContentHash,
	type CompressionCache,
	type CompressionVerdict,
	type CompressorId,
} from './compression-cache';
import { compressWithHeuristics, type HeuristicProfile } from './compressors';
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

/**
 * The line that ends every compressed block. `hash` is the cache key of the
 * entry that holds the original ({@link verdictKey}), which in early mode is
 * not the plain SHA-256 of the content.
 */
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

/**
 * Host-issued evidence for one request's tool execution environment. Paths alone
 * are not proof: a launch binding must establish local POSIX tool/CLI visibility
 * and the archive's desktop/data-directory namespace before supplying this.
 * Never build it from a request body, agent ID or stored SSH settings.
 * No production caller currently supplies it; launch/request wiring is pending.
 */
export interface LocalRecoveryCapability {
	kind: 'local-posix-cli';
	/** Opaque SHA-256 identity of the proven environment, not the agent identity. */
	environmentId: string;
	runtimePath: string;
	cliPath: string;
	dataDir: string;
}

/**
 * Host-issued evidence that one launch was given the MCP retrieve tool
 * (`retrieve_compressed_original` on the per-launch bridge), so its model can
 * ask for any original by hash. Like {@link LocalRecoveryCapability} it comes
 * only from the launch binding the host registered when it injected the
 * bridge; never from a request body, an agent id, or the stored setting alone.
 */
export interface RetrieveToolCapability {
	kind: 'mcp-retrieve-tool';
}

/** What a launch binding may prove about the launch that carries it. */
export type LaunchCapability = LocalRecoveryCapability | RetrieveToolCapability;

/** Whether a launch capability gives the model the retrieve tool. */
export function launchHasRetrieveTool(capability: LaunchCapability | undefined): boolean {
	return capability?.kind === 'mcp-retrieve-tool';
}

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
	 * Explicit host-side capability only. Absent/unsupported means hash-only.
	 * A {@link RetrieveToolCapability} lets early mode use the `full` profile.
	 */
	recovery?: LaunchCapability;
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
	 * whole and is shortened on the next request. Without the retrieve tool
	 * (`recovery`), early mode uses only the `complete` profile.
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
	/**
	 * Recognized text spans left out because the result is recent or the part
	 * carries the cache breakpoint: per tool result, its text spans minus its
	 * eligible ones. A protected part of a vetoed result is counted here and the
	 * rest of that result under `eligibilityVetoes`. `early` lifts both rules, so
	 * it is 0 there.
	 */
	protected: number;
	/** Text spans outside protected regions and eligibility vetoes. */
	candidates: number;
	/** Selected text spans vetoed before hashing/cache access; absent when none. */
	eligibilityVetoes?: { failed: number; recovery: number; retrieval?: number };
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
	/** Cached hints withheld from an unproven/different execution environment. */
	recoveryScopeVetoes?: number;
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
		protected: 0,
		candidates: 0,
		belowThreshold: 0,
		compressed: 0,
		kept: 0,
		cacheHits: 0,
		originalTokens: 0,
		compressedTokens: 0,
		compressors: {
			json: 0,
			logs: 0,
			'long-lines': 0,
			'git-status': 0,
			'git-log': 0,
			search: 0,
			'test-output': 0,
			'build-output': 0,
			'lint-output': 0,
			'json-table': 0,
			model: 0,
		},
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

/** Request-local evidence only; none of these fields changes a cached verdict. */
export interface ToolResultDescriptor {
	result: JsonSpan;
	callId: string | null;
	linkage: 'matched' | 'missing' | 'ambiguous';
	call: JsonSpan | null;
	toolName: string | null;
	input:
		| { kind: 'structured'; source: string; span: JsonSpan }
		| { kind: 'custom'; text: string }
		| { kind: 'unknown' };
	/** All recognized text, including protected parts. Other content stays unknown. */
	contentSpans: JsonSpan[];
	contentStatus: 'text' | 'unknown';
	/** The existing freshness/cache-control selection, independent of metadata. */
	eligibleSpans: JsonSpan[];
	failureStatus: 'failed' | 'not-failed' | 'unknown';
	/** Inspectable means a named, linked structured call, not a recovery match. */
	recoveryEligibility: 'inspectable' | 'unknown';
}

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

function describeToolResult(
	body: string,
	result: JsonSpan,
	content: JsonSpan | undefined,
	eligible: boolean,
	early: boolean
): ToolResultDescriptor {
	const contentSpans: JsonSpan[] = [];
	collectText(body, content, contentSpans, true);
	const eligibleSpans: JsonSpan[] = [];
	if (eligible) collectText(body, content, eligibleSpans, early);
	const textOnly =
		content?.kind === 'string' ||
		(content?.kind === 'array' && content.items.length === contentSpans.length);
	const error = memberOf(result, 'is_error');
	const errorLiteral =
		error?.kind === 'scalar' &&
		result.kind === 'object' &&
		result.members.filter((member) => member.key === 'is_error').length === 1
			? body.slice(error.start, error.end)
			: undefined;
	return {
		result,
		callId: null,
		linkage: 'missing',
		call: null,
		toolName: null,
		input: { kind: 'unknown' },
		contentSpans,
		contentStatus:
			textOnly && contentSpans.every((span) => stringValue(body, span) !== undefined)
				? 'text'
				: 'unknown',
		eligibleSpans,
		failureStatus:
			errorLiteral === 'true' ? 'failed' : errorLiteral === 'false' ? 'not-failed' : 'unknown',
		recoveryEligibility: 'unknown',
	};
}

function anthropicToolResults(
	body: string,
	root: JsonSpan,
	early: boolean,
	calls: JsonSpan[]
): ToolResultDescriptor[] {
	const messages = memberOf(root, 'messages');
	if (messages?.kind !== 'array') return [];
	// Fresh tool results arrive in the last user message. It goes out whole,
	// unless the mode is early. Only `tool_result` blocks are ever collected, so
	// what the user typed in that message is not read in either mode.
	const lastUser = lastIndexWhere(messages.items, (item) => field(body, item, 'role') === 'user');
	const out: ToolResultDescriptor[] = [];
	messages.items.forEach((message, index) => {
		const content = memberOf(message, 'content');
		if (content?.kind !== 'array') return;
		for (const block of content.items) {
			if (
				field(body, message, 'role') === 'assistant' &&
				field(body, block, 'type') === 'tool_use'
			) {
				calls.push(block);
			}
			if (field(body, block, 'type') !== 'tool_result') continue;
			// The breakpoint sits on the newest block, which in early mode is the
			// one to shorten. Only the text is rewritten; the marker stays.
			out.push(
				describeToolResult(
					body,
					block,
					memberOf(block, 'content'),
					early || (index !== lastUser && !hasCacheControl(body, block)),
					early
				)
			);
		}
	});
	return out;
}

function chatCompletionsToolResults(
	body: string,
	root: JsonSpan,
	early: boolean,
	calls: JsonSpan[]
): ToolResultDescriptor[] {
	const messages = memberOf(root, 'messages');
	if (messages?.kind !== 'array') return [];
	// A tool message after the last assistant message has not been answered yet.
	const lastAssistant = lastIndexWhere(
		messages.items,
		(item) => field(body, item, 'role') === 'assistant'
	);
	const end = early ? messages.items.length : lastAssistant;
	const out: ToolResultDescriptor[] = [];
	for (let index = 0; index < messages.items.length; index++) {
		const message = messages.items[index];
		if (field(body, message, 'role') === 'assistant') {
			const toolCalls = memberOf(message, 'tool_calls');
			if (toolCalls?.kind === 'array') {
				for (const call of toolCalls.items) calls.push(call);
			}
		}
		if (field(body, message, 'role') !== 'tool') continue;
		out.push(
			describeToolResult(
				body,
				message,
				memberOf(message, 'content'),
				index < end && (early || !hasCacheControl(body, message)),
				early
			)
		);
	}
	return out;
}

/** Whether a Responses input item is something the model produced. */
function isModelItem(body: string, item: JsonSpan): boolean {
	if (field(body, item, 'role') === 'assistant') return true;
	const type = field(body, item, 'type') ?? '';
	return type === 'reasoning' || type.endsWith('_call');
}

/**
 * Responses shell results can carry their exit code inside a JSON output string,
 * without `is_error` on the result item. Only the known output/metadata envelope
 * and an unambiguous integer code supply failure evidence. This only vetoes;
 * zero does not turn otherwise unknown results into a success claim.
 */
function hasFailedShellEnvelope(body: string, output: JsonSpan | undefined): boolean {
	const text = stringValue(body, output);
	if (!text || !text.trimStart().startsWith('{')) return false;
	const root = parseJsonSpans(text);
	if (
		root?.kind !== 'object' ||
		root.members.filter((member) => member.key === 'metadata').length !== 1 ||
		root.members.filter((member) => member.key === 'output').length !== 1 ||
		memberOf(root, 'output')?.kind !== 'string'
	)
		return false;
	const metadata = memberOf(root, 'metadata');
	if (
		metadata?.kind !== 'object' ||
		metadata.members.filter((member) => member.key === 'exit_code').length !== 1
	)
		return false;
	const code = memberOf(metadata, 'exit_code');
	if (code?.kind !== 'scalar') return false;
	const exitCode = Number(text.slice(code.start, code.end));
	return (
		Number.isSafeInteger(exitCode) &&
		describeToolActivityStatus({ exit_code: exitCode }) === 'failed'
	);
}

// How Codex states that a call ended, in the first lines of the result it hands
// back and before any output the call produced. A `function_call_output` has no
// error field, so these lines are the only failure evidence a Responses request
// carries. They are matched against the raw JSON literal, where a line break is
// the two characters `\n`; the header is plain ASCII, so nothing is decoded.
const WALL_TIME = String.raw`[0-9]+(?:\.[0-9]+)? seconds?`;
/** `exec` (code mode): `Script failed`, as the first text part of the result. */
const SCRIPT_FAILED_HEADER = new RegExp(String.raw`^"Script failed\\nWall time:? ${WALL_TIME}\\n`);
/** `exec_command`: `Process exited with code N`, after the chunk and wall time lines. */
const PROCESS_EXIT_HEADER = new RegExp(
	String.raw`^"Chunk ID: [0-9a-f]+\\nWall time: ${WALL_TIME}\\nProcess exited with code (-?[0-9]{1,10})\\n`
);
/** `shell_command`: `Exit code: N`, then the wall time and `Output:`. */
const SHELL_EXIT_HEADER = new RegExp(
	String.raw`^"Exit code: (-?[0-9]{1,10})\\nWall time: ${WALL_TIME}\\nOutput:\\n`
);
/** The longest header above is under 120 characters. */
const RESULT_HEADER_SCAN_CHARS = 192;

/** The text a result opens with: its string, or the first part of its list when that is text. */
function leadingText(body: string, output: JsonSpan | undefined): JsonSpan | undefined {
	if (output?.kind === 'string') return output;
	if (output?.kind !== 'array') return undefined;
	const [part] = output.items;
	if (!part || !TEXT_PART_TYPES.has(field(body, part, 'type') ?? '')) return undefined;
	const text = memberOf(part, 'text');
	return text?.kind === 'string' ? text : undefined;
}

/**
 * Whether a Responses result opens with one of Codex's own failure headers. The
 * header must lead the text: the same words later in the text, or in a later
 * part, are output the call printed, not how it ended. Like
 * {@link hasFailedShellEnvelope} this only vetoes: a zero code, a `Script
 * completed`, a running call or an unrecognized spelling stays unknown, and a
 * result a program forged to look failed is merely sent whole.
 */
function hasFailedResultHeader(body: string, output: JsonSpan | undefined): boolean {
	const text = leadingText(body, output);
	if (!text) return false;
	const head = body.slice(text.start, Math.min(text.end, text.start + RESULT_HEADER_SCAN_CHARS));
	if (SCRIPT_FAILED_HEADER.test(head)) return true;
	const code = (PROCESS_EXIT_HEADER.exec(head) ?? SHELL_EXIT_HEADER.exec(head))?.[1];
	return code !== undefined && describeToolActivityStatus({ exit_code: Number(code) }) === 'failed';
}

function responsesToolResults(
	body: string,
	root: JsonSpan,
	early: boolean,
	calls: JsonSpan[]
): ToolResultDescriptor[] {
	const input = memberOf(root, 'input');
	if (input?.kind !== 'array') return [];
	// An output after the last model item has not been answered yet.
	const lastModel = lastIndexWhere(input.items, (item) => isModelItem(body, item));
	const end = early ? input.items.length : lastModel;
	const out: ToolResultDescriptor[] = [];
	for (let index = 0; index < input.items.length; index++) {
		const item = input.items[index];
		const type = field(body, item, 'type');
		if (type === 'function_call' || type === 'custom_tool_call') calls.push(item);
		if (!RESPONSES_OUTPUT_TYPES.has(field(body, item, 'type') ?? '')) continue;
		const output = memberOf(item, 'output');
		const descriptor = describeToolResult(
			body,
			item,
			output,
			index < end && (early || !hasCacheControl(body, item)),
			early
		);
		if (
			descriptor.failureStatus !== 'failed' &&
			(hasFailedShellEnvelope(body, output) || hasFailedResultHeader(body, output))
		) {
			descriptor.failureStatus = 'failed';
		}
		out.push(descriptor);
	}
	return out;
}

/** Validate decoded input strings without materializing numbers or duplicate keys. */
function isReadableInput(source: string, span: JsonSpan): boolean {
	if (span.kind === 'string') return stringValue(source, span) !== undefined;
	if (span.kind === 'array') return span.items.every((item) => isReadableInput(source, item));
	if (span.kind !== 'object') return true;
	return (
		new Set(span.members.map((member) => member.key)).size === span.members.length &&
		span.members.every(
			(member) =>
				stringValue(source, { kind: 'string', start: member.keyStart, end: member.keyEnd }) !==
					undefined && isReadableInput(source, member.value)
		)
	);
}

function toolCallInput(
	kind: TokenProxyRequestKind,
	body: string,
	call: JsonSpan
): ToolResultDescriptor['input'] {
	if (!isReadableInput(body, call)) return { kind: 'unknown' };
	if (kind === 'openai-responses' && field(body, call, 'type') === 'custom_tool_call') {
		const text = field(body, call, 'input');
		return text === undefined ? { kind: 'unknown' } : { kind: 'custom', text };
	}
	const container = kind === 'openai-chat-completions' ? memberOf(call, 'function') : call;
	const input = memberOf(container, kind === 'anthropic-messages' ? 'input' : 'arguments');
	const source = kind === 'anthropic-messages' ? body : stringValue(body, input);
	const span =
		kind === 'anthropic-messages' ? input : source === undefined ? null : parseJsonSpans(source);
	return source !== undefined && span?.kind === 'object' && isReadableInput(source, span)
		? { kind: 'structured', source, span }
		: { kind: 'unknown' };
}

/**
 * One descriptor path for all APIs, including protected results. Link only a
 * unique call/result pair in this request, with the call before its result.
 * No transcript, filesystem or agent-wide state supplies missing evidence.
 */
export function findToolResultDescriptors(
	kind: TokenProxyRequestKind,
	body: string,
	root: JsonSpan,
	options: { early?: boolean } = {}
): ToolResultDescriptor[] {
	const early = options.early === true;
	const calls: JsonSpan[] = [];
	let results: ToolResultDescriptor[];
	switch (kind) {
		case 'anthropic-messages':
			results = anthropicToolResults(body, root, early, calls);
			break;
		case 'openai-chat-completions':
			results = chatCompletionsToolResults(body, root, early, calls);
			break;
		case 'openai-responses':
			results = responsesToolResults(body, root, early, calls);
			break;
		case 'other':
			return [];
	}
	const callKey = kind === 'openai-responses' ? 'call_id' : 'id';
	const resultKey =
		kind === 'anthropic-messages'
			? 'tool_use_id'
			: kind === 'openai-chat-completions'
				? 'tool_call_id'
				: 'call_id';
	const byId = new Map<string, JsonSpan | null>();
	for (const call of calls) {
		const id = field(body, call, callKey);
		if (id && call.kind === 'object') {
			const repeatedKey = call.members.filter((member) => member.key === callKey).length !== 1;
			byId.set(id, byId.has(id) || repeatedKey ? null : call);
		}
	}
	const resultCounts = new Map<string, number>();
	for (const result of results) {
		result.callId = field(body, result.result, resultKey) || null;
		if (result.callId) resultCounts.set(result.callId, (resultCounts.get(result.callId) ?? 0) + 1);
	}
	for (const result of results) {
		if (!result.callId) continue;
		const call = byId.get(result.callId);
		const repeatedKey =
			result.result.kind === 'object' &&
			result.result.members.filter((member) => member.key === resultKey).length !== 1;
		if (call === null || (resultCounts.get(result.callId) ?? 0) > 1 || repeatedKey) {
			result.linkage = 'ambiguous';
			continue;
		}
		if (!call || call.end > result.result.start) continue;
		if (
			kind === 'openai-responses' &&
			`${field(body, call, 'type')}_output` !== field(body, result.result, 'type')
		)
			continue;
		result.linkage = 'matched';
		result.call = call;
		const definition = kind === 'openai-chat-completions' ? memberOf(call, 'function') : call;
		if (
			!definition ||
			(kind === 'openai-chat-completions' && field(body, call, 'type') !== 'function')
		)
			continue;
		result.toolName =
			definition.kind === 'object' &&
			definition.members.filter((member) => member.key === 'name').length === 1
				? field(body, definition, 'name') || null
				: null;
		result.input = toolCallInput(kind, body, call);
		if (result.toolName && result.input.kind === 'structured')
			result.recoveryEligibility = 'inspectable';
	}
	return results;
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
	return findToolResultDescriptors(kind, body, root, options).flatMap(
		(result) => result.eligibleSpans
	);
}

/**
 * A result of the retrieve tool, under any client prefix (Claude Code names it
 * `mcp__<server>__retrieve_compressed_original`, Codex `<server>__...` or with
 * `functions.` in front). It is the original the model asked for: compressing
 * it again would make the model ask again, so it is never compressed. Only a
 * result linked to a named call counts; an unlinked one is decided as usual.
 */
function isRetrieveToolResult(result: ToolResultDescriptor): boolean {
	if (result.linkage !== 'matched' || !result.toolName) return false;
	const name = result.toolName.toLowerCase();
	if (name === TOKEN_PROXY_RETRIEVE_TOOL_NAME) return true;
	return ['__', '.', '/', ':'].some((separator) =>
		name.endsWith(`${separator}${TOKEN_PROXY_RETRIEVE_TOOL_NAME}`)
	);
}

/** Only linked, structured shell calls can prove an original-recovery request. */
function isOriginalRecovery(result: ToolResultDescriptor): boolean {
	if (result.recoveryEligibility !== 'inspectable' || result.input.kind !== 'structured')
		return false;
	const name = result.toolName?.replace(/^functions\./, '').toLowerCase();
	if (!name || !['bash', 'shell', 'shell_command', 'exec_command'].includes(name)) return false;
	const { source, span } = result.input;
	const command = memberOf(span, name === 'exec_command' ? 'cmd' : 'command');
	let tokens: string[] | null;
	const assignments = new Set<number>();
	if (command?.kind === 'array') {
		const values = command.items.map((item) => stringValue(source, item));
		if (values.some((value) => value === undefined)) return false;
		tokens = values as string[];
	} else {
		const text = stringValue(source, command);
		tokens = text === undefined ? null : literalCommandTokens(text, assignments);
	}
	if (!tokens?.length) return false;
	// Codex may supply argv for a shell rather than the command itself. One
	// literal -c/-lc wrapper is inspectable; other wrappers stay unknown.
	if (
		tokens.length === 3 &&
		['sh', 'bash', 'zsh'].includes(getBasename(tokens[0])) &&
		['-c', '-lc'].includes(tokens[1])
	) {
		tokens = literalCommandTokens(tokens[2], assignments);
		if (!tokens?.length) return false;
	}
	// The bundled CLI uses Electron as Node, and MAESTRO_USER_DATA selects
	// the archive's desktop bridge. These two literal assignments are the only
	// supported environment prefix; argv alone cannot apply shell assignments.
	let at = 0;
	let dataDir = false;
	let electronAsNode = false;
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[at] ?? '')) {
		if (!assignments.has(at)) return false;
		const assignment = tokens[at++];
		if (assignment.startsWith('MAESTRO_USER_DATA=') && !dataDir) {
			if (!isAbsolutePath(assignment.slice('MAESTRO_USER_DATA='.length))) return false;
			dataDir = true;
		} else if (assignment === 'ELECTRON_RUN_AS_NODE=1' && !electronAsNode) {
			electronAsNode = true;
		} else return false;
	}
	const executable = getBasename(tokens[at] ?? '');
	if (
		(['node', 'node.exe'].includes(executable) ||
			(electronAsNode && isAbsolutePath(tokens[at] ?? ''))) &&
		getBasename(tokens[at + 1] ?? '') === 'maestro-cli.js'
	)
		at += 2;
	else if (
		!electronAsNode &&
		['maestro-cli', 'maestro-cli.exe', 'maestro-cli.cmd'].includes(executable)
	)
		at++;
	else return false;
	if (tokens[at++] !== 'models' || tokens[at++] !== 'proxy' || tokens[at++] !== 'block')
		return false;
	if (!/^[0-9a-f]{64}$/i.test(tokens[at++] ?? '')) return false;
	let original = false;
	for (; at < tokens.length; at++) {
		const option = tokens[at];
		if (option === '--original' && !original) original = true;
		else if (option === '--json') continue;
		else if (
			['--original', '--no-original', '--compressed', '--help', '--version'].includes(
				option.split('=')[0]
			)
		)
			return false;
		// Accept literal numeric/range options without choosing future range flag
		// names. No flag value can swallow --original, nor can `--` quote it.
		else if (/^--[a-z][a-z-]*=\d+(?::\d+)?$/.test(option)) continue;
		else if (/^--[a-z][a-z-]*$/.test(option) && /^\d+(?::\d+)?$/.test(tokens[at + 1] ?? '')) at++;
		else return false;
	}
	return original;
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
			// A provider Utility source resolves this task to `off`: there is no
			// agent path, so `use-utility-agent` is unreachable.
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
	recovery: { scope: string; command: string } | null;
	/** `complete` in early mode: see {@link verdictKey}. */
	profile: HeuristicProfile;
}

/**
 * The prefix that gives a `complete` verdict its own cache key.
 *
 * Early mode shortens a tool result before the model has read it, and the model
 * has no way to ask for what was left out. So early mode accepts only
 * reductions that leave no content out (the `complete` profile) and never asks
 * the local model. The cache is shared by every agent and keyed by content, so
 * a verdict decided for `compress` (which may sample) must never be handed to
 * an early-mode request, and a `complete` verdict must not displace the fuller
 * one. Each profile therefore has its own key. A `full` key is the plain
 * SHA-256 of the text, as before, so every stored verdict keeps its meaning.
 */
const COMPLETE_PROFILE_KEY_PREFIX = 'maestro-token-proxy-profile:complete:v1\n';

/**
 * The heuristic profile one request is decided with: `complete` in early mode
 * unless its launch carries the retrieve tool, `full` otherwise. A launch
 * without the tool never gets a lossy block, whatever an earlier launch of
 * the same conversation was given: the keys differ, so neither sees the
 * other's verdict.
 */
export function requestProfile(
	options: Pick<CompressRequestOptions, 'early' | 'recovery'>
): HeuristicProfile {
	return options.early === true && !launchHasRetrieveTool(options.recovery) ? 'complete' : 'full';
}

/** The cache key of a tool result under a profile. The marker and the cache both use it. */
export function verdictKey(text: string, profile: HeuristicProfile): string {
	return contentHash(profile === 'complete' ? `${COMPLETE_PROFILE_KEY_PREFIX}${text}` : text);
}

const RECOVERY_HINT_PREFIX = '[maestro-recovery ';

/** Validate bounded syntax, not execution capability; the host must prove that. */
function localRecoveryRoute(capability: LaunchCapability | undefined): BlockContext['recovery'] {
	if (
		capability?.kind !== 'local-posix-cli' ||
		!isContentHash(capability.environmentId) ||
		capability.environmentId.length !== 64 ||
		![capability.runtimePath, capability.cliPath, capability.dataDir].every(
			(value) =>
				typeof value === 'string' &&
				value.length <= 2048 &&
				value.startsWith('/') &&
				isAbsolutePath(value) &&
				!/[\x00-\x1f\x7f]/.test(value)
		) ||
		getBasename(capability.cliPath) !== 'maestro-cli.js'
	)
		return null;
	const { environmentId, runtimePath, cliPath, dataDir } = capability;
	const command = `MAESTRO_USER_DATA=${shellEscape(dataDir)} ELECTRON_RUN_AS_NODE=1 ${shellEscape(runtimePath)} ${shellEscape(cliPath)} models proxy block`;
	if (command.length > 2048) return null;
	return {
		command,
		scope: contentHash(canonicalJson({ version: 1, environmentId, runtimePath, cliPath, dataDir })),
	};
}

type BlockResolution =
	| { status: 'below-threshold' }
	| { status: 'store-failed' }
	| { status: 'resolved'; verdict: CompressionVerdict; cached: boolean };

/** Decide a block that has no verdict yet. */
async function decideBlock(
	text: string,
	hash: string,
	originalTokens: number,
	context: BlockContext
): Promise<CompressionVerdict> {
	const heuristic = compressWithHeuristics(text, { profile: context.profile });
	let shortened = heuristic.text;
	const compressors: CompressorId[] = [...heuristic.applied];
	let modelFailure: string | undefined;

	// A model summary leaves content out, so the `complete` profile never asks.
	if (context.profile === 'full' && estimateTokenCount(shortened) >= context.modelMinTokens) {
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

	const hint = context.recovery
		? `${RECOVERY_HINT_PREFIX}${context.recovery.command} ${hash} --original --lines 1:200]\n`
		: '';
	const replacement = `${shortened}\n${hint}${formatCompressionMarker(hash, originalTokens)}`;
	const base = {
		hash,
		originalTokens,
		createdAt: Date.now(),
		...(modelFailure !== undefined ? { modelFailure } : {}),
	};
	if (compressors.length === 0 || replacement.length > text.length * (1 - MIN_SAVING_RATIO)) {
		return { ...base, outcome: 'kept' };
	}
	// Compare serialized UTF-8 only after the marker-inclusive reduction gate.
	// Delimiters/escapes and Unicode need not cost their decoded string lengths.
	// The complete first replacement is frozen, hint included. Scope mismatches
	// withhold it; they never produce another replacement for this content hash.
	const replacementBytes = serializedJsonByteLength(replacement);
	const originalBytes = serializedJsonByteLength(text);
	if (replacementBytes === null || originalBytes === null || replacementBytes >= originalBytes) {
		return { ...base, outcome: 'kept' };
	}
	return {
		...base,
		outcome: 'compressed',
		text: replacement,
		compressedTokens: estimateTokenCount(replacement),
		compressors,
		...(context.recovery ? { recoveryScope: context.recovery.scope } : {}),
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
	const hash = verdictKey(text, context.profile);
	// One line per cache key, held by the cache itself (`withEntry`). Two
	// requests that carry the same new block must not both decide it: with a
	// model in the path they could decide differently, and the second has only
	// to wait to read the first one's verdict. A prune takes the same line, so it
	// never removes an entry (and its original) while a request resolves it.
	return context.cache.withEntry(hash, async (): Promise<BlockResolution> => {
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
		recovery: localRecoveryRoute(options.recovery),
		profile: requestProfile(options),
		summarize:
			options.summarize ??
			((text) => summarizeToolResult(text, { onUnavailable: options.onModelUnavailable })),
	};

	const spans = findToolResultDescriptors(kind, body, root, { early: options.early }).flatMap(
		(result) => {
			stats.protected += result.contentSpans.length - result.eligibleSpans.length;
			if (result.eligibleSpans.length === 0) return [];
			const veto =
				result.failureStatus === 'failed'
					? 'failed'
					: isOriginalRecovery(result)
						? 'recovery'
						: isRetrieveToolResult(result)
							? 'retrieval'
							: null;
			if (!veto) return result.eligibleSpans;
			stats.eligibilityVetoes ??= { failed: 0, recovery: 0 };
			stats.eligibilityVetoes[veto] =
				(stats.eligibilityVetoes[veto] ?? 0) + result.eligibleSpans.length;
			return [];
		}
	);
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
		// A missing/malformed scope on hint-bearing text is also unsafe. Keep
		// the original, with no model work, hint stripping or cache invalidation.
		if (
			(verdict.recoveryScope !== undefined || verdict.text.includes(RECOVERY_HINT_PREFIX)) &&
			(!isContentHash(verdict.recoveryScope) || verdict.recoveryScope !== context.recovery?.scope)
		) {
			stats.recoveryScopeVetoes = (stats.recoveryScopeVetoes ?? 0) + 1;
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
