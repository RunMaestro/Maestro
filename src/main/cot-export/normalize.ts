/**
 * Chain of thought export: the per-provider normalizer.
 *
 * Every provider writes its own stream format, and Maestro's output parsers
 * turn each line into a `ParsedEvent` made for the screen. This module turns
 * the same event into what the log keeps: reasoning, reply text, tool calls,
 * tool results, and usage, as record payloads with no position and no hash
 * yet. The assembler adds the turn and the time, and the writer adds the
 * rest.
 *
 * THE RULE THIS MODULE KEEPS
 * Every block it returns is content the log does not hold yet, exactly once.
 * A block that is recorded twice, or not at all, cannot be put right later: a
 * log file is never rewritten. So:
 * - A line the provider sends again gives nothing.
 * - A block the provider sends again, longer, gives only the part that is
 *   new, as a further piece of the same block.
 * - When the stream does not say whether two blocks are one, both are kept.
 *   A repeat can be seen and discounted by a reader. A block that was left
 *   out cannot.
 *
 * WHAT THE ASSEMBLER CAN RELY ON
 * - `thinking` and `text` blocks with the same `providerMessageId`,
 *   `blockIndex` and `parentToolCallId` are pieces of one block, in order.
 *   Joining pieces that arrive one after the other loses nothing.
 * - A `capture-gap` block says the provider sent content this module cannot
 *   record. It is a record like any other, but `turn-end.recordCount` does
 *   not count a `capture-gap`.
 * - This module does not throw for any event a parser can build.
 *
 * WHERE EACH PROVIDER'S BLOCKS COME FROM
 * - `claude-code` and `qwen3-coder` (which writes the same stream format):
 *   from the raw line, `event.raw`. The parsed event cannot be used. It
 *   carries reasoning OR reply text, never both, so the two cannot be told
 *   apart and one of them is lost when a line holds both. It leaves out
 *   encrypted reasoning, and it cuts tool output to a short preview.
 * - Every other provider: from the parsed event. Text marked `isReasoning`
 *   is `thinking`, and no other text ever is, so a provider that shows no
 *   reasoning gets no `thinking` record. Two parsers cut tool output for the
 *   screen (`codex`, `antigravity`). For those the output is read from the
 *   raw line, because `outputSha256` must cover all of it.
 *
 * THE SHAPE OF A CLAUDE STREAM
 * The CLI writes one line per content block. A reply with reasoning, text
 * and two tool calls is four `assistant` lines that share one `message.id`,
 * and each line's `content` array holds a single block, at position 0. So a
 * position in that array does not name a block, and two tool calls of one
 * message would look like one. Blocks are counted per message as they
 * arrive, and that count is `blockIndex`. A line that holds a whole message
 * gives the same numbers.
 *
 * A block is known again by what it is: a tool call by its id, encrypted
 * reasoning by its hash, reasoning and reply text by their text. Text that
 * starts with all the text of an earlier block of the same kind in the same
 * message is that block, grown. Two entries of ONE line are never one block,
 * though: a line that holds two reply blocks with the same text, or with one
 * text that starts with the other, holds two blocks.
 *
 * A limit, stated plainly: two blocks of one message with the very same text
 * that arrive on two lines cannot be told from one block sent twice, and are
 * recorded once.
 *
 * REASONING WITH NO TEXT
 * The current Claude models return most of their reasoning with an empty
 * `thinking` text and a `signature`: the reasoning took place, and only its
 * signed, opaque form came back. Such a block is recorded as
 * `redacted-thinking` (the size and hash of the signature, never the
 * signature), the same as a `redacted_thinking` block. A turn with no
 * `thinking` record and several `redacted-thinking` records is a turn whose
 * reasoning the provider did not show, not a turn without reasoning.
 *
 * WHAT IS LEFT OUT, ON PURPOSE
 * - Lines that are not the agent's own output: session start, bookkeeping,
 *   retry notices the CLI prints, error envelopes, and stdout lines that are
 *   not JSON. How a turn failed is in `turn-end`.
 * - What a hook or the CLI puts into the conversation in the middle of a
 *   turn. The format has no record kind for input after `turn-start`.
 * - Reasoning that `codex` returns only encrypted. The parser passes it on
 *   as a bookkeeping line.
 *
 * WHAT A `usage` RECORD MEANS
 * The figures are the ones the provider's parser reports, and their meaning
 * differs: one total for the turn (`claude-code`), a running total since the
 * process started (`codex`), or the cost of one step (`opencode`,
 * `copilot-cli`). Every usage event is kept. Do not add them up without
 * knowing the provider.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

import { canonicalJson } from '../../shared/canonicalJson';
import { COT_TOOL_OUTPUT_CAP_BYTES } from '../../shared/cotExport/types';
import type {
	CotRecordPayload,
	CotToolResultPayload,
	CotTurnEndPayload,
	CotTurnStartPayload,
} from '../../shared/cotExport/types';
import { parsedUsageToStats } from '../../shared/maestro-lib/streaming/usage-totals';
import type { ParsedEvent } from '../parsers/agent-output-parser';
import { extractReasoningSummaryText, isCodexRetryNotice } from '../parsers/codex-output-parser';
import { getToolStatus } from '../process-manager/handlers/StdoutHandler';
import { sha256Hex } from './hash-chain';

// ============================================================================
// Contract
// ============================================================================

/**
 * One record payload without its base fields: what the normalizer hands to
 * the assembler. `turn-start` and `turn-end` are the assembler's own, so they
 * are not part of it.
 */
export type CotBlock = Exclude<CotRecordPayload, CotTurnStartPayload | CotTurnEndPayload>;

type ProseKind = 'thinking' | 'text';

/** What is remembered of one block of a message, to know it again. */
interface MessageBlock {
	kind: ProseKind | 'other';
	/** Reasoning and reply text: the hash of the text so far. Else: what names the block. */
	mark: string;
	/** Reasoning and reply text: the length of the text so far. */
	length: number;
	/** The `blockIndex` the block was recorded under. */
	index: number;
}

/**
 * What the normalizer remembers of one turn. Make one with
 * `createTurnNormalizeState` when the turn starts and drop it when the turn
 * ends. It holds hashes and lengths, never the text of a block, so a long
 * turn does not keep its whole output in memory a second time.
 */
export interface TurnNormalizeState {
	/** Claude streams: the blocks recorded of each message, by message id. */
	messages: Map<string, MessageBlock[]>;
	/** Ids of the tool calls recorded this turn. */
	toolCalls: Set<string>;
	/** Ids of the calls recorded before the provider had sent their arguments. */
	callsWithoutInput: Set<string>;
	/** Tool calls recorded without an id that no result has answered yet. */
	openUnnamedCalls: number;
	/** Tool results recorded this turn, by call id, status and output hash. */
	toolResults: Set<string>;
	/** The block that streamed text is being added to, when one is open. */
	stream: { kind: ProseKind; index: number; parent: string | undefined } | null;
	/** The next `blockIndex` for a block with no provider message id. */
	nextBlockIndex: number;
	/** Reply text recorded since the last block that was not reply text. */
	replyRun: string;
	/** The newest reply block alone. */
	replyLast: string;
}

export function createTurnNormalizeState(): TurnNormalizeState {
	return {
		messages: new Map(),
		toolCalls: new Set(),
		callsWithoutInput: new Set(),
		openUnnamedCalls: 0,
		toolResults: new Set(),
		stream: null,
		nextBlockIndex: 0,
		replyRun: '',
		replyLast: '',
	};
}

/**
 * The blocks one parsed event adds to the turn's record, in order. Empty for
 * an event that carries nothing the log keeps, and for a repeat.
 *
 * `toolType` is the provider that ran the turn. `turn` is changed: call this
 * once for each event, in the order the events arrived.
 */
export function normalizeParsedEvent(
	toolType: string,
	event: ParsedEvent,
	turn: TurnNormalizeState
): CotBlock[] {
	// A stdout line that was not JSON comes out of a parser's `parseJsonLine` as
	// a text event whose `raw` is the line itself. It is noise from the process
	// (a shell profile, a startup message), and the live stream never sends it
	// here, so a run that is read back from its whole output must not record it
	// either.
	if (typeof event.raw === 'string') return [];

	const out: CotBlock[] = [];
	if (CLAUDE_STREAM_PROVIDERS.has(toolType)) {
		claudeBlocks(event, turn, out);
	} else {
		parsedEventBlocks(toolType, event, turn, out);
	}
	if (event.usage) {
		out.push({ kind: 'usage', usage: parsedUsageToStats(event.usage) });
	}
	return out;
}

// ============================================================================
// Shared pieces
// ============================================================================

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `parentToolCallId`, only when a subagent produced the block. */
function fromSubagent(parent: string | undefined): { parentToolCallId?: string } {
	return parent ? { parentToolCallId: parent } : {};
}

/**
 * A tool output as text. Text stays as it came. Structured output becomes
 * canonical JSON, so the same output always gives the same text and the same
 * hash. Nothing at all is the empty text.
 */
function outputText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === undefined || value === null) return '';
	try {
		return canonicalJson(value);
	} catch {
		// Canonical JSON refuses a value that is not JSON. A value read from a
		// JSON line always is, so this is for a parser that builds one by hand.
		return String(value);
	}
}

/**
 * Cuts `text` to `COT_TOOL_OUTPUT_CAP_BYTES` of UTF-8 and hashes all of it.
 * The cut never falls inside a character.
 */
function capOutput(
	text: string
): Pick<CotToolResultPayload, 'output' | 'outputSha256' | 'truncatedBytes'> {
	// The hash reads the text as UTF-8 itself. Only the part that can be kept
	// is ever copied into a buffer here: an output can be tens of megabytes,
	// and this runs where the process's output is handled.
	const outputSha256 = sha256Hex(text);
	const byteLength = Buffer.byteLength(text, 'utf8');
	if (byteLength <= COT_TOOL_OUTPUT_CAP_BYTES) {
		return { output: text, outputSha256 };
	}
	// A character is at least one byte, so one character more than the cap
	// holds the whole kept part and the first byte past it.
	const bytes = Buffer.from(text.slice(0, COT_TOOL_OUTPUT_CAP_BYTES + 1), 'utf8');
	// `bytes[end]` is the first byte left out. While it is a continuation byte
	// (10xxxxxx), the character it belongs to began before the cut, so the cut
	// moves back to where that character starts.
	let end = COT_TOOL_OUTPUT_CAP_BYTES;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return {
		output: bytes.toString('utf8', 0, end),
		outputSha256,
		truncatedBytes: byteLength - end,
	};
}

/**
 * A block that is not reply text ends the reply so far, and ends the block
 * that streamed text was being added to. A subagent's blocks do neither: they
 * arrive in between the agent's own and are not part of its reply.
 */
function endProse(turn: TurnNormalizeState, parent: string | undefined): void {
	if (parent) return;
	turn.stream = null;
	turn.replyRun = '';
	turn.replyLast = '';
}

interface ToolCall {
	id: string | undefined;
	name: unknown;
	input: unknown;
	parent: string | undefined;
}

/**
 * Records a tool call, unless the turn already holds it. A call that was
 * recorded before its arguments were known is recorded once more when an
 * event brings them: what the agent asked for must be in the log.
 */
function pushToolCall(turn: TurnNormalizeState, call: ToolCall, out: CotBlock[]): void {
	if (call.id) {
		const bringsInput = call.input !== undefined && turn.callsWithoutInput.has(call.id);
		if (turn.toolCalls.has(call.id) && !bringsInput) return;
		turn.toolCalls.add(call.id);
		if (call.input === undefined) {
			turn.callsWithoutInput.add(call.id);
		} else {
			turn.callsWithoutInput.delete(call.id);
		}
	} else {
		turn.openUnnamedCalls++;
	}
	endProse(turn, call.parent);
	out.push({
		kind: 'tool-call',
		...(call.id ? { toolCallId: call.id } : {}),
		toolName: typeof call.name === 'string' ? call.name : '',
		input: call.input === undefined ? null : call.input,
		...fromSubagent(call.parent),
	});
}

interface ToolResult {
	id: string | undefined;
	failed: boolean;
	output: unknown;
	parent: string | undefined;
}

/**
 * Records a tool result. A result with the same call id, the same status and
 * the same output as one already recorded is a repeat. A result that differs
 * in any of them is kept, because it says something the first did not.
 */
function pushToolResult(turn: TurnNormalizeState, result: ToolResult, out: CotBlock[]): void {
	const capped = capOutput(outputText(result.output));
	const status = result.failed ? 'failed' : 'completed';
	if (result.id) {
		const key = `${result.id}\n${status}\n${capped.outputSha256}`;
		if (turn.toolResults.has(key)) return;
		turn.toolResults.add(key);
	}
	endProse(turn, result.parent);
	out.push({
		kind: 'tool-result',
		...(result.id ? { toolCallId: result.id } : {}),
		status,
		...capped,
		...fromSubagent(result.parent),
	});
}

/** Counts reply text toward the reply so far. `continues` is a further piece of the newest block. */
function noteReply(
	turn: TurnNormalizeState,
	text: string,
	continues: boolean,
	parent: string | undefined
): void {
	if (parent) return;
	turn.replyRun += text;
	turn.replyLast = continues ? turn.replyLast + text : text;
}

/**
 * The text of a result event. Most providers close a turn by sending the
 * final reply once more, whole. It is recorded only when it is not the reply
 * the turn already holds, compared without leading and trailing space.
 *
 * A result also closes the message that was being streamed, whether or not
 * its text is recorded.
 */
function pushResultText(turn: TurnNormalizeState, text: string, out: CotBlock[]): void {
	turn.stream = null;
	const wanted = text.trim();
	if (!wanted) return;
	if (wanted === turn.replyRun.trim() || wanted === turn.replyLast.trim()) return;
	out.push({ kind: 'text', text, blockIndex: turn.nextBlockIndex++ });
	noteReply(turn, text, false, undefined);
}

// ============================================================================
// Claude streams
// ============================================================================

/** Providers whose stdout is Claude Code's stream-json. Their blocks are read from the raw line. */
const CLAUDE_STREAM_PROVIDERS: ReadonlySet<string> = new Set(['claude-code', 'qwen3-coder']);

/** The longest block type kept in a `capture-gap` reason. */
const MAX_BLOCK_TYPE_CHARS = 64;

function claudeBlocks(event: ParsedEvent, turn: TurnNormalizeState, out: CotBlock[]): void {
	const raw = asObject(event.raw);
	if (!raw) return;
	const parent = nonEmptyString(raw.parent_tool_use_id);
	if (raw.type === 'assistant') {
		claudeAssistantBlocks(raw, parent, turn, out);
	} else if (raw.type === 'user') {
		claudeUserBlocks(raw, parent, turn, out);
	} else if (raw.type === 'result') {
		pushResultText(turn, typeof raw.result === 'string' ? raw.result : '', out);
	}
}

/** Whether a content block is a tool call: the client kind, or a server or MCP one. */
function isToolUseType(type: unknown): boolean {
	return typeof type === 'string' && (type === 'tool_use' || type.endsWith('_tool_use'));
}

/** Whether a content block is a tool result of any kind. */
function isToolResultType(type: unknown): boolean {
	return typeof type === 'string' && (type === 'tool_result' || type.endsWith('_tool_result'));
}

/** The content of a message as a list of blocks. A plain string is one text block. */
function contentBlocks(message: JsonObject): unknown[] {
	const { content } = message;
	if (typeof content === 'string') return [{ type: 'text', text: content }];
	return Array.isArray(content) ? content : [];
}

function claudeAssistantBlocks(
	raw: JsonObject,
	parent: string | undefined,
	turn: TurnNormalizeState,
	out: CotBlock[]
): void {
	const message = asObject(raw.message);
	if (!message) return;
	const messageId = nonEmptyString(message.id);
	// A line with no message id is still one line: its own id tells a repeat of
	// that line from a new one. With neither id, nothing can, and every block
	// is kept.
	const ledgerKey = messageId ?? nonEmptyString(raw.uuid);
	let ledger = ledgerKey ? turn.messages.get(ledgerKey) : undefined;
	if (!ledger) {
		ledger = [];
		if (ledgerKey) turn.messages.set(ledgerKey, ledger);
	}
	const fromMessage = messageId ? { providerMessageId: messageId } : {};
	const blocks = ledger;
	// The `blockIndex` of a new reasoning or reply block: its position in the
	// message when the provider names the message, else the next free number
	// of the turn.
	const nextIndex = () => (messageId ? blocks.length : turn.nextBlockIndex++);
	// Whether a block that is not text is new to the message. A new one takes
	// a place in it, so the blocks after it are numbered as the message has
	// them.
	const isNew = (mark: string): boolean => {
		if (blocks.some((block) => block.kind === 'other' && block.mark === mark)) return false;
		blocks.push({ kind: 'other', mark, length: 0, index: blocks.length });
		return true;
	};
	// The blocks this line has already been matched to. A later entry of the
	// same line is another block, whatever its text.
	const claimed = new Set<MessageBlock>();
	const pushProse = (kind: ProseKind, text: string): void => {
		const piece = newProse(blocks, kind, text, nextIndex, claimed);
		if (!piece) return;
		if (kind === 'text') {
			noteReply(turn, piece.text, piece.continues, parent);
		} else {
			endProse(turn, parent);
		}
		out.push({
			kind,
			text: piece.text,
			...fromMessage,
			blockIndex: piece.index,
			...fromSubagent(parent),
		});
	};
	// Reasoning the provider did not return as text. The opaque payload is
	// counted and hashed, and never kept.
	const pushRedacted = (payload: string): void => {
		const bytes = Buffer.from(payload, 'utf8');
		const sha256 = sha256Hex(bytes);
		if (!isNew(`redacted:${sha256}`)) return;
		endProse(turn, parent);
		out.push({
			kind: 'redacted-thinking',
			byteLength: bytes.length,
			sha256,
			...fromMessage,
			...fromSubagent(parent),
		});
	};

	for (const entry of contentBlocks(message)) {
		const block = asObject(entry);
		if (!block) continue;
		const { type } = block;

		if (type === 'text') {
			if (typeof block.text === 'string' && block.text.length > 0) pushProse('text', block.text);
			continue;
		}

		if (type === 'thinking') {
			if (typeof block.thinking === 'string' && block.thinking.length > 0) {
				pushProse('thinking', block.thinking);
			} else {
				// A reasoning block with no text and a signature: the model reasoned,
				// and the provider returned that reasoning only in its signed, opaque
				// form. Most reasoning of the current models arrives this way. Leaving
				// the block out would make such a turn look as if no reasoning took
				// place, so it is recorded the way encrypted reasoning is.
				const signature = nonEmptyString(block.signature);
				if (signature) pushRedacted(signature);
			}
			continue;
		}

		if (type === 'redacted_thinking') {
			pushRedacted(typeof block.data === 'string' ? block.data : outputText(block));
			continue;
		}

		if (isToolUseType(type)) {
			const id = nonEmptyString(block.id);
			const mark = id
				? `call:${id}`
				: `call:${sha256Hex(outputText({ name: block.name, input: block.input }))}`;
			if (!isNew(mark)) continue;
			pushToolCall(turn, { id, name: block.name, input: block.input, parent }, out);
			continue;
		}

		if (isToolResultType(type)) {
			pushClaudeToolResult(block, parent, turn, out);
			continue;
		}

		// A kind of block this version does not know. Leaving it out without a
		// word would make the log look whole when it is not.
		if (!isNew(`unknown:${sha256Hex(outputText(block))}`)) continue;
		out.push({ kind: 'capture-gap', reason: `unrecognized-block:${blockTypeLabel(type)}` });
	}
}

/** A block type as it is written into a `capture-gap` reason: short, and plain characters only. */
function blockTypeLabel(type: unknown): string {
	if (typeof type !== 'string') return 'unknown';
	const label = type.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, MAX_BLOCK_TYPE_CHARS);
	return label || 'unknown';
}

/**
 * What a reasoning or reply block adds to the record: all of it for a new
 * block, the new end for a block that grew, and null for a repeat.
 *
 * `claimed` holds the blocks the current line was already matched to. They
 * are passed over, and the block this text is matched to (or makes) joins
 * them, so that two entries of one line are never taken for one block.
 */
function newProse(
	ledger: MessageBlock[],
	kind: ProseKind,
	text: string,
	nextIndex: () => number,
	claimed: Set<MessageBlock>
): { text: string; index: number; continues: boolean } | null {
	const mark = sha256Hex(text);
	let grown: MessageBlock | undefined;
	for (const block of ledger) {
		if (block.kind !== kind || claimed.has(block)) continue;
		if (block.length === text.length && block.mark === mark) {
			claimed.add(block);
			return null;
		}
		// The longest earlier block this text starts with is the one that grew.
		if (
			block.length < text.length &&
			(!grown || block.length > grown.length) &&
			sha256Hex(text.slice(0, block.length)) === block.mark
		) {
			grown = block;
		}
	}
	if (grown) {
		const added = text.slice(grown.length);
		grown.mark = mark;
		grown.length = text.length;
		claimed.add(grown);
		return { text: added, index: grown.index, continues: true };
	}
	const index = nextIndex();
	const block: MessageBlock = { kind, mark, length: text.length, index };
	ledger.push(block);
	claimed.add(block);
	return { text, index, continues: false };
}

function pushClaudeToolResult(
	block: JsonObject,
	parent: string | undefined,
	turn: TurnNormalizeState,
	out: CotBlock[]
): void {
	pushToolResult(
		turn,
		{
			id: nonEmptyString(block.tool_use_id),
			failed: block.is_error === true,
			output: block.content,
			parent,
		},
		out
	);
}

/**
 * A `user` line in the middle of a turn carries what tools returned. Its
 * other content (a hook's feedback, a reminder the CLI adds) is input to the
 * model, not output of it, and is not recorded.
 */
function claudeUserBlocks(
	raw: JsonObject,
	parent: string | undefined,
	turn: TurnNormalizeState,
	out: CotBlock[]
): void {
	const content = asObject(raw.message)?.content;
	if (!Array.isArray(content)) return;
	for (const entry of content) {
		const block = asObject(entry);
		if (block && isToolResultType(block.type)) {
			pushClaudeToolResult(block, parent, turn, out);
		}
	}
}

// ============================================================================
// Every other provider
// ============================================================================

/** The full result of a tool call, read from the raw line of a provider whose parser cuts it. */
interface RawToolResult {
	output: unknown;
	/** Set when the raw line says more about failure than the parsed status does. */
	failed?: boolean;
}

/** Codex writes some command output as an array of bytes. */
function codexOutputValue(value: unknown): unknown {
	const isBytes =
		Array.isArray(value) &&
		value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
	return isBytes ? Buffer.from(value as number[]).toString('utf8') : value;
}

function codexToolResult(raw: JsonObject): RawToolResult | undefined {
	const item = asObject(raw.item);
	if (raw.type === 'item.completed' && item) {
		if (item.type === 'command_execution') {
			// The parser reports every finished command as completed. The line
			// itself says whether the command failed.
			const exitCode = item.exit_code;
			return {
				output: codexOutputValue(item.aggregated_output),
				failed: item.status === 'failed' || (typeof exitCode === 'number' && exitCode !== 0),
			};
		}
		if (item.type === 'tool_result') {
			return { output: codexOutputValue(item.output) };
		}
	}
	const payload = asObject(raw.payload);
	if (
		raw.type === 'response_item' &&
		payload &&
		(payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')
	) {
		return { output: codexOutputValue(payload.output) };
	}
	return undefined;
}

function antigravityToolResult(raw: JsonObject): RawToolResult | undefined {
	const output = asObject(asObject(raw.step_update)?.tool_info)?.output;
	return typeof output === 'string' ? { output } : undefined;
}

/**
 * Providers whose parser cuts tool output to a preview for the screen. The
 * record needs all of it, so it is read from the raw line. A line in a shape
 * the reader does not know gives undefined, and the parsed output is used.
 */
const RAW_TOOL_RESULT: ReadonlyMap<string, (raw: JsonObject) => RawToolResult | undefined> =
	new Map([
		['codex', codexToolResult],
		['antigravity', antigravityToolResult],
	]);

/**
 * The reasoning text of a Codex event marked `isReasoning`, or null when the
 * event is not reasoning.
 *
 * The Codex parser also marks two progress notices that way, to keep them out
 * of the reply: a retry it is about to make, and a stream error it retries
 * past. The model wrote neither. For real reasoning the text is taken from
 * the raw line where its shape is known, because the parser adds blank lines
 * to the text it shows.
 */
function codexReasoningText(event: ParsedEvent): string | null {
	const raw = asObject(event.raw);
	if (!raw) return event.text || null;
	const payload = asObject(raw.payload);
	if (isCodexRetryNotice(raw)) return null;
	if (raw.type === 'event_msg' && payload?.type === 'stream_error') return null;

	const item = asObject(raw.item);
	if (
		raw.type === 'item.completed' &&
		item?.type === 'reasoning' &&
		typeof item.text === 'string'
	) {
		return item.text || null;
	}
	if (raw.type === 'response_item' && payload?.type === 'reasoning') {
		return extractReasoningSummaryText(payload.summary) || null;
	}
	return event.text || null;
}

/** The kind and text of a text event, or null when it adds nothing to the record. */
function proseOf(toolType: string, event: ParsedEvent): { kind: ProseKind; text: string } | null {
	if (!event.text) return null;
	if (!event.isReasoning) return { kind: 'text', text: event.text };
	const text = toolType === 'codex' ? codexReasoningText(event) : event.text;
	return text ? { kind: 'thinking', text } : null;
}

/**
 * Text that arrives a piece at a time. Pieces of one kind that follow each
 * other are one block, until a block of another kind or a result ends it.
 */
function pushStreamPiece(
	turn: TurnNormalizeState,
	kind: ProseKind,
	text: string,
	parent: string | undefined,
	out: CotBlock[]
): void {
	let block = turn.stream;
	const continues = block !== null && block.kind === kind && block.parent === parent;
	if (!block || !continues) {
		if (kind === 'thinking') endProse(turn, parent);
		block = { kind, index: turn.nextBlockIndex++, parent };
		turn.stream = block;
	}
	if (kind === 'text') noteReply(turn, text, continues, parent);
	out.push({ kind, text, blockIndex: block.index, ...fromSubagent(parent) });
}

interface ToolEvent {
	name: unknown;
	id: string | undefined;
	state: unknown;
	parent: string | undefined;
	raw: unknown;
}

/**
 * One tool event. A provider reports a call as it starts, as it ends, or
 * both, and some report progress in between.
 */
function pushToolEvent(
	toolType: string,
	turn: TurnNormalizeState,
	tool: ToolEvent,
	out: CotBlock[]
): void {
	const status = getToolStatus(tool.state);
	const state = asObject(tool.state) ?? {};
	const call: ToolCall = { id: tool.id, name: tool.name, input: state.input, parent: tool.parent };

	if (status !== 'completed' && status !== 'failed' && status !== 'error') {
		// Running, or progress on a call. A call with an id is recorded once.
		pushToolCall(turn, call, out);
		return;
	}

	// Some providers report a call only when it has ended, with its arguments
	// and its output in one event. The call is recorded from that event, so
	// the log shows what was asked as well as what came back. An event with
	// no arguments has nothing to say about the call.
	if (state.input !== undefined && (tool.id || turn.openUnnamedCalls === 0)) {
		pushToolCall(turn, call, out);
	}
	// A result with no id answers a call with no id.
	if (!tool.id && turn.openUnnamedCalls > 0) turn.openUnnamedCalls--;

	const raw = asObject(tool.raw);
	const full = raw ? RAW_TOOL_RESULT.get(toolType)?.(raw) : undefined;
	// A parser with no output to show puts a failure's message in `error`.
	const parsedOutput = state.output !== undefined ? state.output : state.error;
	pushToolResult(
		turn,
		{
			id: tool.id,
			failed: full?.failed ?? status !== 'completed',
			output: full ? full.output : parsedOutput,
			parent: tool.parent,
		},
		out
	);
}

function parsedEventBlocks(
	toolType: string,
	event: ParsedEvent,
	turn: TurnNormalizeState,
	out: CotBlock[]
): void {
	const parent = nonEmptyString(event.parentToolUseId);

	if (event.type === 'text') {
		const prose = proseOf(toolType, event);
		if (prose) pushStreamPiece(turn, prose.kind, prose.text, parent, out);
	} else if (event.type === 'result') {
		pushResultText(turn, event.text ?? '', out);
	} else if (event.type === 'tool_use') {
		pushToolEvent(
			toolType,
			turn,
			{
				name: event.toolName,
				id: nonEmptyString(event.toolCallId),
				state: event.toolState,
				parent,
				raw: event.raw,
			},
			out
		);
	}

	// Tool calls a message carries next to its text.
	for (const tool of event.toolUseBlocks ?? []) {
		pushToolCall(
			turn,
			{ id: nonEmptyString(tool.id), name: tool.name, input: tool.input, parent },
			out
		);
	}

	// Further results a message carries next to its first.
	for (const result of event.toolResultBlocks ?? []) {
		pushToolEvent(
			toolType,
			turn,
			{
				name: result.toolName,
				id: nonEmptyString(result.toolCallId),
				state: result.toolState,
				parent: nonEmptyString(result.parentToolUseId) ?? parent,
				// The raw line belongs to the first result, not to this one.
				raw: undefined,
			},
			out
		);
	}
}
