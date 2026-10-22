/**
 * Tests for main/cot-export/normalize.ts.
 *
 * The normalizer decides what of a provider's stream ends up in the log, so
 * these tests pin the rule a reader of the log relies on: every block of the
 * agent's output is recorded, and recorded once.
 *
 * The lines are the shapes the parser tests in `src/__tests__/main/parsers/`
 * use, and each one goes through the provider's REAL parser before it reaches
 * the normalizer. A hand-built `ParsedEvent` can drift from what a parser
 * emits. These cannot. The few tests that build an event by hand say why.
 *
 * Nothing here touches disk.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../main/cot-export/hash-chain';
import { createTurnNormalizeState, normalizeParsedEvent } from '../../../main/cot-export/normalize';
import type { CotBlock, TurnNormalizeState } from '../../../main/cot-export/normalize';
import type { AgentOutputParser, ParsedEvent } from '../../../main/parsers/agent-output-parser';
import { AntigravityOutputParser } from '../../../main/parsers/antigravity-output-parser';
import { ClaudeOutputParser } from '../../../main/parsers/claude-output-parser';
import { CodexOutputParser } from '../../../main/parsers/codex-output-parser';
import { CopilotOutputParser } from '../../../main/parsers/copilot-output-parser';
import { FactoryDroidOutputParser } from '../../../main/parsers/factory-droid-output-parser';
import { GrokOutputParser } from '../../../main/parsers/grok-output-parser';
import { OpenCodeOutputParser } from '../../../main/parsers/opencode-output-parser';
import { PiOutputParser } from '../../../main/parsers/pi-output-parser';
import { QwenOutputParser } from '../../../main/parsers/qwen-output-parser';
import { COT_TOOL_OUTPUT_CAP_BYTES } from '../../../shared/cotExport/types';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Sends stdout lines through the provider's parser and the normalizer, the
 * way a turn does. A line can be an object (it is written as JSON) or a
 * string (it is sent as it is).
 */
function runTurn(
	toolType: string,
	parser: AgentOutputParser,
	lines: unknown[],
	turn: TurnNormalizeState = createTurnNormalizeState()
): CotBlock[] {
	const blocks: CotBlock[] = [];
	for (const line of lines) {
		const event = parser.parseJsonLine(typeof line === 'string' ? line : JSON.stringify(line));
		if (event) blocks.push(...normalizeParsedEvent(toolType, event, turn));
	}
	return blocks;
}

/** The same, for events built by hand. */
function runEvents(toolType: string, events: ParsedEvent[]): CotBlock[] {
	const turn = createTurnNormalizeState();
	return events.flatMap((event) => normalizeParsedEvent(toolType, event, turn));
}

function kinds(blocks: CotBlock[]): string[] {
	return blocks.map((block) => block.kind);
}

function ofKind<K extends CotBlock['kind']>(
	blocks: CotBlock[],
	kind: K
): Extract<CotBlock, { kind: K }>[] {
	return blocks.filter((block): block is Extract<CotBlock, { kind: K }> => block.kind === kind);
}

/** The text of every `thinking` or `text` piece of one kind, joined in order. */
function joined(blocks: CotBlock[], kind: 'thinking' | 'text'): string {
	return ofKind(blocks, kind)
		.map((block) => block.text)
		.join('');
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, 'utf8');
}

// ============================================================================
// Claude lines
// ============================================================================

const MSG = 'msg_01';

const THINKING = { type: 'thinking', thinking: 'The user wants a listing.', signature: 'sig-1' };
const REDACTED = { type: 'redacted_thinking', data: 'RW5jcnlwdGVkUmVhc29uaW5nUGF5bG9hZA==' };
const TEXT = { type: 'text', text: 'I will list the files and read one.' };
const LS = { type: 'tool_use', id: 'toolu_ls', name: 'Bash', input: { command: 'ls' } };
const READ = {
	type: 'tool_use',
	id: 'toolu_read',
	name: 'Read',
	input: { file_path: '/work/a.txt' },
};
const LS_RESULT = { type: 'tool_result', tool_use_id: 'toolu_ls', content: 'a.txt\nb.txt' };
const READ_RESULT = {
	type: 'tool_result',
	tool_use_id: 'toolu_read',
	content: 'File not found',
	is_error: true,
};

/** An `assistant` line. `extra` goes on the line, `message` on the message. */
function assistant(
	content: unknown,
	extra: Record<string, unknown> = {},
	message: Record<string, unknown> = { id: MSG }
) {
	return {
		type: 'assistant',
		session_id: 'sess-1',
		message: { role: 'assistant', content, ...message },
		...extra,
	};
}

/** A `user` line, which is how the CLI reports what tools returned. */
function user(content: unknown, extra: Record<string, unknown> = {}) {
	return { type: 'user', session_id: 'sess-1', message: { role: 'user', content }, ...extra };
}

function result(text: string | undefined, extra: Record<string, unknown> = {}) {
	return {
		type: 'result',
		session_id: 'sess-1',
		...(text === undefined ? {} : { result: text }),
		modelUsage: {
			'claude-opus-5': {
				inputTokens: 7,
				outputTokens: 142,
				cacheReadInputTokens: 59482,
				cacheCreationInputTokens: 9677,
				contextWindow: 1000000,
			},
		},
		total_cost_usd: 0.5,
		...extra,
	};
}

/** What the five blocks and the two results above must come out as. */
const EXPECTED_SEQUENCE: CotBlock[] = [
	{ kind: 'thinking', text: THINKING.thinking, providerMessageId: MSG, blockIndex: 0 },
	{
		kind: 'redacted-thinking',
		byteLength: byteLength(REDACTED.data),
		sha256: sha256Hex(REDACTED.data),
		providerMessageId: MSG,
	},
	{ kind: 'text', text: TEXT.text, providerMessageId: MSG, blockIndex: 2 },
	{ kind: 'tool-call', toolCallId: 'toolu_ls', toolName: 'Bash', input: { command: 'ls' } },
	{
		kind: 'tool-call',
		toolCallId: 'toolu_read',
		toolName: 'Read',
		input: { file_path: '/work/a.txt' },
	},
	{
		kind: 'tool-result',
		toolCallId: 'toolu_ls',
		status: 'completed',
		output: 'a.txt\nb.txt',
		outputSha256: sha256Hex('a.txt\nb.txt'),
	},
	{
		kind: 'tool-result',
		toolCallId: 'toolu_read',
		status: 'failed',
		output: 'File not found',
		outputSha256: sha256Hex('File not found'),
	},
];

/** The lines of the same reply as the CLI really writes it: one block per line. */
const ONE_BLOCK_PER_LINE = [
	assistant([THINKING]),
	assistant([REDACTED]),
	assistant([TEXT]),
	assistant([LS]),
	assistant([READ]),
	user([LS_RESULT]),
	user([READ_RESULT]),
];

function claude(lines: unknown[], turn?: TurnNormalizeState): CotBlock[] {
	return runTurn('claude-code', new ClaudeOutputParser(), lines, turn);
}

// ============================================================================
// Tests
// ============================================================================

describe('cot-export normalize', () => {
	describe('claude-code', () => {
		it('turns a whole message and its tool results into the exact block sequence', () => {
			const blocks = claude([
				assistant([THINKING, REDACTED, TEXT, LS, READ]),
				user([LS_RESULT, READ_RESULT]),
			]);

			expect(blocks).toStrictEqual(EXPECTED_SEQUENCE);
		});

		it('gives the same sequence when the message arrives one block per line', () => {
			// Every line holds its one block at position 0 of `content`, and all of
			// them share one message id. The two tool calls must both be recorded.
			expect(claude(ONE_BLOCK_PER_LINE)).toStrictEqual(EXPECTED_SEQUENCE);
		});

		it('records nothing for a line it has already seen', () => {
			const whole = assistant([THINKING, REDACTED, TEXT, LS, READ]);
			const results = user([LS_RESULT, READ_RESULT]);

			expect(claude([whole, whole, results, results])).toStrictEqual(EXPECTED_SEQUENCE);
			expect(claude(ONE_BLOCK_PER_LINE.flatMap((line) => [line, line]))).toStrictEqual(
				EXPECTED_SEQUENCE
			);
		});

		it('records nothing for a whole message that repeats blocks sent one per line', () => {
			const blocks = claude([
				...ONE_BLOCK_PER_LINE,
				assistant([THINKING, REDACTED, TEXT, LS, READ]),
			]);

			expect(blocks).toStrictEqual(EXPECTED_SEQUENCE);
		});

		it('records a growing text block once, as pieces of one block', () => {
			const blocks = claude([
				assistant([{ type: 'text', text: 'Hel' }]),
				assistant([{ type: 'text', text: 'Hello, wor' }]),
				assistant([{ type: 'text', text: 'Hello, world' }]),
				assistant([{ type: 'text', text: 'Hello, world' }]),
			]);

			expect(blocks).toStrictEqual([
				{ kind: 'text', text: 'Hel', providerMessageId: MSG, blockIndex: 0 },
				{ kind: 'text', text: 'lo, wor', providerMessageId: MSG, blockIndex: 0 },
				{ kind: 'text', text: 'ld', providerMessageId: MSG, blockIndex: 0 },
			]);
			expect(joined(blocks, 'text')).toBe('Hello, world');
		});

		it('records a growing reasoning block once, next to a block that did not grow', () => {
			const blocks = claude([
				assistant([{ type: 'thinking', thinking: 'First I ' }, TEXT]),
				assistant([{ type: 'thinking', thinking: 'First I look.' }, TEXT]),
			]);

			expect(blocks).toStrictEqual([
				{ kind: 'thinking', text: 'First I ', providerMessageId: MSG, blockIndex: 0 },
				{ kind: 'text', text: TEXT.text, providerMessageId: MSG, blockIndex: 1 },
				{ kind: 'thinking', text: 'look.', providerMessageId: MSG, blockIndex: 0 },
			]);
		});

		it('keeps two different text blocks of one message as two blocks', () => {
			const blocks = claude([
				assistant([{ type: 'text', text: 'One.' }]),
				assistant([{ type: 'text', text: 'Two.' }]),
			]);

			expect(blocks).toStrictEqual([
				{ kind: 'text', text: 'One.', providerMessageId: MSG, blockIndex: 0 },
				{ kind: 'text', text: 'Two.', providerMessageId: MSG, blockIndex: 1 },
			]);
		});

		it('keeps two entries of one line that hold the same text as two blocks', () => {
			const hello = { type: 'text', text: 'Hello' };
			const blocks = claude([assistant([hello, hello])]);

			expect(ofKind(blocks, 'text')).toEqual([
				{ kind: 'text', text: 'Hello', providerMessageId: MSG, blockIndex: 0 },
				{ kind: 'text', text: 'Hello', providerMessageId: MSG, blockIndex: 1 },
			]);
		});

		it('keeps two entries of one line as two blocks when one text starts with the other', () => {
			const blocks = claude([
				assistant([
					{ type: 'text', text: 'Hello' },
					{ type: 'text', text: 'Hello world' },
				]),
			]);

			// Not one block that grew: the line holds both, whole.
			expect(ofKind(blocks, 'text')).toEqual([
				{ kind: 'text', text: 'Hello', providerMessageId: MSG, blockIndex: 0 },
				{ kind: 'text', text: 'Hello world', providerMessageId: MSG, blockIndex: 1 },
			]);
		});

		it('records nothing when a line with two alike entries is sent again', () => {
			const line = assistant([
				{ type: 'text', text: 'Hello' },
				{ type: 'text', text: 'Hello' },
			]);
			const turn = createTurnNormalizeState();
			expect(ofKind(claude([line], turn), 'text')).toHaveLength(2);

			// Each entry of the repeat is matched to a block of its own.
			expect(claude([line], turn)).toEqual([]);
		});

		it('still takes a text sent on a later line for the block that grew', () => {
			const turn = createTurnNormalizeState();
			claude([assistant([{ type: 'text', text: 'Hello' }])], turn);

			const blocks = claude([assistant([{ type: 'text', text: 'Hello world' }])], turn);

			expect(blocks).toEqual([
				{ kind: 'text', text: ' world', providerMessageId: MSG, blockIndex: 0 },
			]);
		});

		it('keeps two alike reasoning entries of one line as two blocks', () => {
			const thinking = { type: 'thinking', thinking: 'Check the folder.', signature: 'sig' };
			const blocks = claude([assistant([thinking, thinking])]);

			expect(ofKind(blocks, 'thinking').map((block) => block.blockIndex)).toEqual([0, 1]);
		});

		it('keeps the same text in two different messages', () => {
			const blocks = claude([
				assistant([{ type: 'text', text: 'Done.' }], {}, { id: 'msg_a' }),
				assistant([{ type: 'text', text: 'Done.' }], {}, { id: 'msg_b' }),
			]);

			expect(ofKind(blocks, 'text').map((block) => block.providerMessageId)).toEqual([
				'msg_a',
				'msg_b',
			]);
		});

		it('records reasoning that came back with no text as redacted, never as nothing', () => {
			// What the current models send for most reasoning: an empty `thinking`
			// and a signature.
			const signature = 'c2lnbmVkLW9wYXF1ZS1yZWFzb25pbmc=';
			const line = assistant([{ type: 'thinking', thinking: '', signature }]);
			const blocks = claude([line, line, assistant([TEXT])]);

			expect(blocks).toStrictEqual([
				{
					kind: 'redacted-thinking',
					byteLength: byteLength(signature),
					sha256: sha256Hex(signature),
					providerMessageId: MSG,
				},
				{ kind: 'text', text: TEXT.text, providerMessageId: MSG, blockIndex: 1 },
			]);
		});

		it('never writes the opaque payload of redacted reasoning', () => {
			const signature = 'c2lnbmVkLW9wYXF1ZS1yZWFzb25pbmc=';
			const blocks = claude([
				assistant([REDACTED, { type: 'thinking', thinking: '', signature }, THINKING]),
			]);
			const written = JSON.stringify(blocks);

			expect(kinds(blocks)).toEqual(['redacted-thinking', 'redacted-thinking', 'thinking']);
			expect(written).not.toContain(REDACTED.data);
			expect(written).not.toContain(signature);
			expect(written).not.toContain(THINKING.signature);
		});

		it('records a reasoning block with no text and no signature as nothing', () => {
			expect(claude([assistant([{ type: 'thinking', thinking: '' }])])).toEqual([]);
		});

		it('records all of a tool output the parser cuts to a preview', () => {
			// The parser keeps 4000 characters for the screen.
			const output = 'x'.repeat(20000);
			const [block] = ofKind(
				claude([user([{ type: 'tool_result', tool_use_id: 'toolu_big', content: output }])]),
				'tool-result'
			);

			expect(block.output).toBe(output);
			expect(block.outputSha256).toBe(sha256Hex(output));
			expect(block.truncatedBytes).toBeUndefined();
		});

		it('cuts a tool output past the cap on a character, and hashes all of it', () => {
			// A three byte character lies across the cap.
			const euro = String.fromCodePoint(0x20ac);
			const head = 'a'.repeat(COT_TOOL_OUTPUT_CAP_BYTES - 1);
			const output = `${head}${euro}tail`;
			const [block] = ofKind(
				claude([user([{ type: 'tool_result', tool_use_id: 'toolu_big', content: output }])]),
				'tool-result'
			);

			expect(block.output).toBe(head);
			expect(block.truncatedBytes).toBe(byteLength(output) - byteLength(head));
			expect(block.outputSha256).toBe(sha256Hex(output));
		});

		it('keeps an output of exactly the cap whole', () => {
			const output = 'a'.repeat(COT_TOOL_OUTPUT_CAP_BYTES);
			const [block] = ofKind(
				claude([user([{ type: 'tool_result', tool_use_id: 'toolu_big', content: output }])]),
				'tool-result'
			);

			expect(block.output).toBe(output);
			expect(block.truncatedBytes).toBeUndefined();
		});

		it('writes a structured tool output as canonical JSON', () => {
			const content = [
				{ type: 'text', text: 'first' },
				{ text: 'second', type: 'text' },
			];
			const [block] = ofKind(
				claude([user([{ type: 'tool_result', tool_use_id: 'toolu_mcp', content }])]),
				'tool-result'
			);
			const expected = '[{"text":"first","type":"text"},{"text":"second","type":"text"}]';

			expect(block.output).toBe(expected);
			expect(block.outputSha256).toBe(sha256Hex(expected));
		});

		it('records a tool result with no output as the empty text', () => {
			const [block] = ofKind(
				claude([user([{ type: 'tool_result', tool_use_id: 'toolu_none' }])]),
				'tool-result'
			);

			expect(block.output).toBe('');
			expect(block.outputSha256).toBe(sha256Hex(''));
		});

		it('records usage from a result, and not the reply the turn already holds', () => {
			const blocks = claude([assistant([THINKING]), assistant([TEXT]), result(`${TEXT.text}\n`)]);

			expect(kinds(blocks)).toEqual(['thinking', 'text', 'usage']);
			const [usage] = ofKind(blocks, 'usage');
			expect(usage.usage.inputTokens).toBe(7);
			expect(usage.usage.outputTokens).toBe(142);
			expect(usage.usage.cacheReadInputTokens).toBe(59482);
			expect(usage.usage.cacheCreationInputTokens).toBe(9677);
			expect(usage.usage.totalCostUsd).toBe(0.5);
		});

		it('records the text of a result the turn does not hold yet', () => {
			const blocks = claude([assistant([LS]), user([LS_RESULT]), result('Unknown command: /nope')]);

			expect(kinds(blocks)).toEqual(['tool-call', 'tool-result', 'text', 'usage']);
			expect(ofKind(blocks, 'text')).toStrictEqual([
				{ kind: 'text', text: 'Unknown command: /nope', blockIndex: 0 },
			]);
		});

		it('records the reply before a Stop hook once, and nothing for the hook', () => {
			// The parser shows the held reply joined to the result. The log must
			// hold each reply as the model wrote it.
			const blocks = claude([
				assistant([{ type: 'text', text: 'The answer is 4.' }], {}, { id: 'msg_a' }),
				user('Stop hook feedback: commit your work first.'),
				assistant([{ type: 'text', text: 'Committed.' }], {}, { id: 'msg_b' }),
				result('Committed.'),
			]);

			expect(kinds(blocks)).toEqual(['text', 'text', 'usage']);
			expect(ofKind(blocks, 'text').map((block) => block.text)).toEqual([
				'The answer is 4.',
				'Committed.',
			]);
		});

		it('marks what a subagent produced, and keeps it out of the reply', () => {
			const fromTask = { parent_tool_use_id: 'toolu_task' };
			const blocks = claude([
				assistant([{ type: 'text', text: 'Final answer.' }], {}, { id: 'msg_main' }),
				assistant([{ type: 'text', text: 'Subagent note.' }], fromTask, { id: 'msg_sub' }),
				assistant([LS], fromTask, { id: 'msg_sub' }),
				user([LS_RESULT], fromTask),
				result('Final answer.'),
			]);

			expect(blocks.slice(0, 4)).toStrictEqual([
				{ kind: 'text', text: 'Final answer.', providerMessageId: 'msg_main', blockIndex: 0 },
				{
					kind: 'text',
					text: 'Subagent note.',
					providerMessageId: 'msg_sub',
					blockIndex: 0,
					parentToolCallId: 'toolu_task',
				},
				{
					kind: 'tool-call',
					toolCallId: 'toolu_ls',
					toolName: 'Bash',
					input: { command: 'ls' },
					parentToolCallId: 'toolu_task',
				},
				{
					kind: 'tool-result',
					toolCallId: 'toolu_ls',
					status: 'completed',
					output: 'a.txt\nb.txt',
					outputSha256: sha256Hex('a.txt\nb.txt'),
					parentToolCallId: 'toolu_task',
				},
			]);
			// The subagent's blocks did not end the agent's own reply, so the result
			// is still known as a repeat of it.
			expect(kinds(blocks.slice(4))).toEqual(['usage']);
		});

		it('says so when a message holds a block it cannot record', () => {
			const strange = { type: 'hologram', frames: [1, 2, 3] };
			const line = assistant([TEXT, strange, LS]);
			const blocks = claude([line, line]);

			expect(blocks).toStrictEqual([
				{ kind: 'text', text: TEXT.text, providerMessageId: MSG, blockIndex: 0 },
				{ kind: 'capture-gap', reason: 'unrecognized-block:hologram' },
				{ kind: 'tool-call', toolCallId: 'toolu_ls', toolName: 'Bash', input: { command: 'ls' } },
			]);
		});

		it('records a server tool call and its result like any other', () => {
			const blocks = claude([
				assistant([
					{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
					{ type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: 'hits' },
				]),
			]);

			expect(blocks).toStrictEqual([
				{
					kind: 'tool-call',
					toolCallId: 'srvtoolu_1',
					toolName: 'web_search',
					input: { query: 'x' },
				},
				{
					kind: 'tool-result',
					toolCallId: 'srvtoolu_1',
					status: 'completed',
					output: 'hits',
					outputSha256: sha256Hex('hits'),
				},
			]);
		});

		it('tells a repeat of a line with no message id by the id of the line', () => {
			const line = assistant([TEXT], { uuid: 'line-1' }, {});
			const other = assistant([TEXT], { uuid: 'line-2' }, {});
			const blocks = claude([line, line, other]);

			// No provider message id, so the blocks are numbered by the turn.
			expect(blocks).toStrictEqual([
				{ kind: 'text', text: TEXT.text, blockIndex: 0 },
				{ kind: 'text', text: TEXT.text, blockIndex: 1 },
			]);
		});

		it('keeps both when nothing tells a repeat from a second block', () => {
			const line = assistant('hi', {}, {});

			expect(claude([line, line])).toStrictEqual([
				{ kind: 'text', text: 'hi', blockIndex: 0 },
				{ kind: 'text', text: 'hi', blockIndex: 1 },
			]);
		});

		it('records nothing for lines that are not the output of the agent', () => {
			const blocks = claude([
				{ type: 'system', subtype: 'init', session_id: 'sess-1', slash_commands: ['/help'] },
				{ type: 'system', subtype: 'api_retry', session_id: 'sess-1' },
				user('A reminder the CLI adds in the middle of a turn.'),
				'this stdout line is not JSON',
			]);

			expect(blocks).toEqual([]);
		});
	});

	describe('qwen3-coder', () => {
		it('reads the same stream format the same way', () => {
			const blocks = runTurn('qwen3-coder', new QwenOutputParser(), [
				assistant([THINKING, TEXT, LS]),
				user([LS_RESULT]),
			]);

			expect(kinds(blocks)).toEqual(['thinking', 'text', 'tool-call', 'tool-result']);
			// The parsed event carries the reasoning OR the reply. Both must be here.
			expect(joined(blocks, 'thinking')).toBe(THINKING.thinking);
			expect(joined(blocks, 'text')).toBe(TEXT.text);
		});
	});

	describe('codex', () => {
		function codex(lines: unknown[]): CotBlock[] {
			return runTurn('codex', new CodexOutputParser(), lines);
		}

		it('records an isReasoning event as thinking, with the text as the provider sent it', () => {
			const text = '**Plan** check the files';
			const parsed = new CodexOutputParser().parseJsonLine(
				JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text } })
			);
			// The parser adds blank lines for the screen. The log must not have them.
			expect(parsed?.isReasoning).toBe(true);
			expect(parsed?.text).not.toBe(text);

			expect(codex([{ type: 'item.completed', item: { type: 'reasoning', text } }])).toStrictEqual([
				{ kind: 'thinking', text, blockIndex: 0 },
			]);
		});

		it('records a reasoning summary of the current format as thinking', () => {
			const blocks = codex([
				{
					type: 'response_item',
					payload: {
						type: 'reasoning',
						summary: [{ type: 'summary_text', text: 'Looking at the tests.' }],
						encrypted_content: 'b3BhcXVl',
					},
				},
			]);

			expect(blocks).toStrictEqual([
				{ kind: 'thinking', text: 'Looking at the tests.', blockIndex: 0 },
			]);
		});

		it('records nothing for the notices the parser marks as reasoning', () => {
			const blocks = codex([
				{ type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion)' },
				{ type: 'event_msg', payload: { type: 'stream_error', message: 'stream error; retrying' } },
			]);

			expect(blocks).toEqual([]);
		});

		it('records a command as one call and one result, by the id of its item', () => {
			const blocks = codex([
				{ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls' } },
				{
					type: 'item.completed',
					item: {
						id: 'item_1',
						type: 'command_execution',
						command: 'ls',
						aggregated_output: 'a.txt\n',
						exit_code: 0,
						status: 'completed',
					},
				},
			]);

			expect(blocks).toStrictEqual([
				{ kind: 'tool-call', toolCallId: 'item_1', toolName: 'shell', input: { command: 'ls' } },
				{
					kind: 'tool-result',
					toolCallId: 'item_1',
					status: 'completed',
					output: 'a.txt\n',
					outputSha256: sha256Hex('a.txt\n'),
				},
			]);
		});

		it('records a command that failed as failed, though the parser says completed', () => {
			const blocks = codex([
				{ type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: 'x' } },
				{
					type: 'item.completed',
					item: {
						id: 'item_2',
						type: 'command_execution',
						command: 'x',
						aggregated_output: 'x: not found',
						exit_code: 127,
						status: 'failed',
					},
				},
			]);

			expect(ofKind(blocks, 'tool-result')[0].status).toBe('failed');
		});

		it('records all of a command output the parser cuts', () => {
			// The parser keeps 10000 characters and adds a note.
			const output = 'y'.repeat(30000);
			const blocks = codex([
				{
					type: 'item.completed',
					item: {
						id: 'item_3',
						type: 'command_execution',
						command: 'cat big',
						aggregated_output: output,
						exit_code: 0,
						status: 'completed',
					},
				},
			]);

			// One event carried the call and its result. Both are recorded.
			expect(kinds(blocks)).toEqual(['tool-call', 'tool-result']);
			const [toolResult] = ofKind(blocks, 'tool-result');
			expect(toolResult.output).toBe(output);
			expect(toolResult.outputSha256).toBe(sha256Hex(output));
		});

		it('reads command output that arrives as bytes', () => {
			const bytes = Array.from(Buffer.from('hi\n', 'utf8'));
			const blocks = codex([
				{
					type: 'item.completed',
					item: { type: 'tool_call', tool: 'shell', args: { cmd: 'echo' } },
				},
				{ type: 'item.completed', item: { type: 'tool_result', output: bytes } },
			]);

			// Neither line has an id. The result answers the open call.
			expect(blocks).toStrictEqual([
				{ kind: 'tool-call', toolName: 'shell', input: { cmd: 'echo' } },
				{
					kind: 'tool-result',
					status: 'completed',
					output: 'hi\n',
					outputSha256: sha256Hex('hi\n'),
				},
			]);
		});

		it('pairs a function call with its output by call id', () => {
			const blocks = codex([
				{
					type: 'response_item',
					payload: {
						type: 'function_call',
						name: 'read_file',
						call_id: 'call_1',
						arguments: '{"path":"a.txt"}',
					},
				},
				{
					type: 'response_item',
					payload: { type: 'function_call_output', call_id: 'call_1', output: 'contents' },
				},
			]);

			expect(blocks).toStrictEqual([
				{
					kind: 'tool-call',
					toolCallId: 'call_1',
					toolName: 'read_file',
					input: { path: 'a.txt' },
				},
				{
					kind: 'tool-result',
					toolCallId: 'call_1',
					status: 'completed',
					output: 'contents',
					outputSha256: sha256Hex('contents'),
				},
			]);
		});

		it('records each message of a turn, and a message sent twice only once', () => {
			const blocks = codex([
				{ type: 'item.completed', item: { type: 'agent_message', text: 'Checking.' } },
				{ type: 'item.completed', item: { type: 'agent_message', text: 'All good.' } },
				{ type: 'item.completed', item: { type: 'agent_message', text: 'All good.' } },
				{ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 4 } },
			]);

			expect(kinds(blocks)).toEqual(['text', 'text', 'usage']);
			expect(ofKind(blocks, 'text')).toStrictEqual([
				{ kind: 'text', text: 'Checking.', blockIndex: 0 },
				{ kind: 'text', text: 'All good.', blockIndex: 1 },
			]);
			expect(ofKind(blocks, 'usage')[0].usage.inputTokens).toBe(10);
		});
	});

	describe('opencode', () => {
		function opencode(lines: unknown[]): CotBlock[] {
			return runTurn('opencode', new OpenCodeOutputParser(), lines);
		}

		const STREAM = [
			{ type: 'step_start', sessionID: 'oc-1', part: { type: 'step-start' } },
			{ type: 'text', sessionID: 'oc-1', part: { type: 'text', text: 'I will run the tests.' } },
			{
				type: 'tool_use',
				sessionID: 'oc-1',
				part: {
					type: 'tool',
					tool: 'bash',
					state: { status: 'completed', input: { command: 'npm test' }, output: 'ok' },
				},
			},
			{
				type: 'step_finish',
				sessionID: 'oc-1',
				part: {
					type: 'step-finish',
					reason: 'tool-calls',
					tokens: { input: 100, output: 20, cache: { read: 5, write: 1 } },
					cost: 0.01,
				},
			},
			{ type: 'step_start', sessionID: 'oc-1', part: { type: 'step-start' } },
			{ type: 'text', sessionID: 'oc-1', part: { type: 'text', text: 'The tests pass.' } },
			{
				type: 'step_finish',
				sessionID: 'oc-1',
				part: { type: 'step-finish', reason: 'stop', tokens: { input: 130, output: 6 } },
			},
		];

		it('records a stream as text, tool calls, tool results and usage, and no thinking', () => {
			const blocks = opencode(STREAM);

			expect(kinds(blocks)).toEqual(['text', 'tool-call', 'tool-result', 'usage', 'text', 'usage']);
			expect(ofKind(blocks, 'thinking')).toEqual([]);
			expect(ofKind(blocks, 'redacted-thinking')).toEqual([]);
		});

		it('records the call from the one event that carries call and result', () => {
			const blocks = opencode(STREAM);

			expect(ofKind(blocks, 'tool-call')).toStrictEqual([
				{ kind: 'tool-call', toolName: 'bash', input: { command: 'npm test' } },
			]);
			expect(ofKind(blocks, 'tool-result')).toStrictEqual([
				{ kind: 'tool-result', status: 'completed', output: 'ok', outputSha256: sha256Hex('ok') },
			]);
			expect(ofKind(blocks, 'usage').map((block) => block.usage.inputTokens)).toEqual([100, 130]);
		});

		it('records a tool that ended in an error as failed, with its message', () => {
			const blocks = opencode([
				{
					type: 'tool_use',
					part: {
						type: 'tool',
						tool: 'read',
						state: { status: 'error', input: { path: 'gone' }, error: 'ENOENT' },
					},
				},
			]);

			expect(ofKind(blocks, 'tool-result')).toStrictEqual([
				{
					kind: 'tool-result',
					status: 'failed',
					output: 'ENOENT',
					outputSha256: sha256Hex('ENOENT'),
				},
			]);
		});
	});

	describe('copilot-cli', () => {
		it('records streamed pieces once, and one call for its two announcements', () => {
			const blocks = runTurn('copilot-cli', new CopilotOutputParser(), [
				{ type: 'assistant.turn_start' },
				{ type: 'assistant.reasoning_delta', data: { deltaContent: 'Need the file list. ' } },
				{ type: 'assistant.message_delta', data: { deltaContent: 'Let me ' } },
				{ type: 'assistant.message_delta', data: { deltaContent: 'look.' } },
				{
					type: 'assistant.message',
					data: {
						content: 'Let me look.',
						toolRequests: [{ toolCallId: 'c1', name: 'bash', arguments: { command: 'ls' } }],
						outputTokens: 12,
					},
				},
				{
					type: 'tool.execution_start',
					data: { toolCallId: 'c1', toolName: 'bash', arguments: { command: 'ls' } },
				},
				{
					type: 'tool.execution_complete',
					data: { toolCallId: 'c1', success: true, result: { content: 'a.txt' } },
				},
				{ type: 'assistant.message_delta', data: { deltaContent: 'One ' } },
				{ type: 'assistant.message_delta', data: { deltaContent: 'file.' } },
				{ type: 'assistant.message', data: { content: 'One file.' } },
			]);

			expect(blocks).toStrictEqual([
				{ kind: 'thinking', text: 'Need the file list. ', blockIndex: 0 },
				{ kind: 'text', text: 'Let me ', blockIndex: 1 },
				{ kind: 'text', text: 'look.', blockIndex: 1 },
				{ kind: 'tool-call', toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } },
				ofKind(blocks, 'usage')[0],
				{
					kind: 'tool-result',
					toolCallId: 'c1',
					status: 'completed',
					output: 'a.txt',
					outputSha256: sha256Hex('a.txt'),
				},
				{ kind: 'text', text: 'One ', blockIndex: 2 },
				{ kind: 'text', text: 'file.', blockIndex: 2 },
			]);
			expect(ofKind(blocks, 'usage')[0].usage.outputTokens).toBe(12);
		});
	});

	describe('factory-droid', () => {
		it('records the reply once, with usage, and never thinking', () => {
			const blocks = runTurn('factory-droid', new FactoryDroidOutputParser(), [
				{ type: 'system', subtype: 'init', session_id: 'fd-1' },
				{ type: 'message', role: 'user', text: 'List the files.' },
				{ type: 'message', role: 'assistant', id: 'm1', text: 'There are two files.' },
				{
					type: 'completion',
					finalText: 'There are two files.',
					session_id: 'fd-1',
					usage: { input_tokens: 50, output_tokens: 8, thinking_tokens: 30 },
				},
			]);

			expect(kinds(blocks)).toEqual(['text', 'usage']);
			expect(joined(blocks, 'text')).toBe('There are two files.');
			// The provider counts reasoning tokens and shows no reasoning. The log
			// keeps the count and makes up no reasoning record.
			expect(ofKind(blocks, 'usage')[0].usage.reasoningTokens).toBe(30);
		});
	});

	describe('grok', () => {
		it('records thought and text pieces, and one call for many updates', () => {
			const blocks = runTurn('grok', new GrokOutputParser(), [
				{ type: 'thought', data: 'Check ' },
				{ type: 'thought', data: 'the repo.' },
				{ type: 'tool_call', toolCallId: 't1', toolName: 'run', rawInput: { cmd: 'ls' } },
				{ type: 'tool_call_update', toolCallId: 't1', status: 'in_progress' },
				{ type: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: 'a.txt' },
				{ type: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: 'a.txt' },
				{ type: 'text', data: 'One file.' },
				{ type: 'end', sessionId: 'grok-1', stopReason: 'end_turn' },
			]);

			expect(blocks).toStrictEqual([
				{ kind: 'thinking', text: 'Check ', blockIndex: 0 },
				{ kind: 'thinking', text: 'the repo.', blockIndex: 0 },
				{ kind: 'tool-call', toolCallId: 't1', toolName: 'run', input: { cmd: 'ls' } },
				{
					kind: 'tool-result',
					toolCallId: 't1',
					status: 'completed',
					output: 'a.txt',
					outputSha256: sha256Hex('a.txt'),
				},
				{ kind: 'text', text: 'One file.', blockIndex: 1 },
			]);
		});
	});

	describe('pi', () => {
		it('records progress on a call as nothing, and the final reply once', () => {
			const delta = (type: string, text: string) => ({
				type: 'message_update',
				assistantMessageEvent: { type, delta: text },
			});
			const blocks = runTurn('pi', new PiOutputParser(), [
				delta('thinking_delta', 'Read it first.'),
				{ type: 'tool_execution_start', toolCallId: 'p1', toolName: 'read', args: { path: 'a' } },
				{ type: 'tool_execution_update', toolCallId: 'p1', toolName: 'read', partialResult: 'he' },
				{
					type: 'tool_execution_end',
					toolCallId: 'p1',
					toolName: 'read',
					result: { content: [{ type: 'text', text: 'hello' }] },
				},
				delta('text_delta', 'It says '),
				delta('text_delta', 'hello.'),
				{
					type: 'agent_end',
					messages: [{ role: 'assistant', content: [{ type: 'text', text: 'It says hello.' }] }],
				},
			]);

			expect(kinds(blocks)).toEqual(['thinking', 'tool-call', 'tool-result', 'text', 'text']);
			expect(joined(blocks, 'text')).toBe('It says hello.');
			expect(ofKind(blocks, 'tool-result')[0].output).toBe(
				'{"content":[{"text":"hello","type":"text"}]}'
			);
		});
	});

	describe('antigravity', () => {
		it('records all of a tool output the parser cuts', () => {
			// The parser keeps 4000 characters for the screen.
			const output = 'z'.repeat(9000);
			const step = (state: string, toolInfo: Record<string, unknown>) => ({
				event: 'step_update',
				step_update: {
					conversation_id: 'conv-1',
					step_index: 3,
					state,
					step_type: 'tool',
					tool_info: toolInfo,
				},
			});
			const blocks = runTurn('antigravity', new AntigravityOutputParser(), [
				step('ACTIVE', { name: 'run_command', parameters: { command: 'cat big' } }),
				step('DONE', { name: 'run_command', parameters: { command: 'cat big' }, output }),
			]);

			expect(blocks).toStrictEqual([
				{
					kind: 'tool-call',
					toolCallId: 'conv-1:3',
					toolName: 'run_command',
					input: { command: 'cat big' },
				},
				{
					kind: 'tool-result',
					toolCallId: 'conv-1:3',
					status: 'completed',
					output,
					outputSha256: sha256Hex(output),
				},
			]);
		});
	});

	// These build events by hand: no one parser emits every one of these
	// sequences, and the rule has to hold for any provider.
	describe('any provider', () => {
		const text = (value: string): ParsedEvent => ({ type: 'text', text: value, isPartial: true });
		const usage: ParsedEvent = { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } };
		const tool = (toolCallId: string | undefined, toolState: unknown): ParsedEvent => ({
			type: 'tool_use',
			toolName: 'run',
			...(toolCallId ? { toolCallId } : {}),
			toolState,
		});

		it('never records thinking for text that is not marked as reasoning', () => {
			const blocks = runEvents('some-future-provider', [text('Thinking about it...'), usage]);

			expect(kinds(blocks)).toEqual(['text', 'usage']);
		});

		it('keeps the pieces of one message in one block across a usage event', () => {
			const blocks = runEvents('opencode', [text('a'), usage, text('b')]);

			expect(ofKind(blocks, 'text').map((block) => block.blockIndex)).toEqual([0, 0]);
		});

		it('starts a new block after a tool call, after reasoning, and after a result', () => {
			const blocks = runEvents('opencode', [
				text('a'),
				tool('t1', { status: 'running', input: {} }),
				text('b'),
				{ type: 'text', text: 'why', isPartial: true, isReasoning: true },
				text('c'),
				{ type: 'result', text: 'c' },
				text('d'),
			]);

			expect(blocks.filter((block) => block.kind !== 'tool-call')).toStrictEqual([
				{ kind: 'text', text: 'a', blockIndex: 0 },
				{ kind: 'text', text: 'b', blockIndex: 1 },
				{ kind: 'thinking', text: 'why', blockIndex: 2 },
				{ kind: 'text', text: 'c', blockIndex: 3 },
				{ kind: 'text', text: 'd', blockIndex: 4 },
			]);
		});

		it('records a result that is not the reply already streamed, whole', () => {
			const blocks = runEvents('opencode', [
				text('Partial rep'),
				{ type: 'result', text: 'Reply.' },
			]);

			expect(ofKind(blocks, 'text')).toStrictEqual([
				{ kind: 'text', text: 'Partial rep', blockIndex: 0 },
				{ kind: 'text', text: 'Reply.', blockIndex: 1 },
			]);
		});

		it('records a call again when its arguments arrive later', () => {
			const blocks = runEvents('opencode', [
				tool('t1', { status: 'running' }),
				tool('t1', { status: 'running', input: { command: 'ls' } }),
				tool('t1', { status: 'running', input: { command: 'ls' } }),
				tool('t1', { status: 'completed', input: { command: 'ls' }, output: 'ok' }),
			]);

			expect(blocks).toStrictEqual([
				{ kind: 'tool-call', toolCallId: 't1', toolName: 'run', input: null },
				{ kind: 'tool-call', toolCallId: 't1', toolName: 'run', input: { command: 'ls' } },
				{
					kind: 'tool-result',
					toolCallId: 't1',
					status: 'completed',
					output: 'ok',
					outputSha256: sha256Hex('ok'),
				},
			]);
		});

		it('keeps a second result for a call when it says something new', () => {
			const blocks = runEvents('opencode', [
				tool('t1', { status: 'running', input: {} }),
				tool('t1', { status: 'completed', output: 'part' }),
				tool('t1', { status: 'completed', output: 'part' }),
				tool('t1', { status: 'completed', output: 'part and the rest' }),
				tool('t1', { status: 'failed', output: 'part and the rest' }),
			]);

			expect(ofKind(blocks, 'tool-result').map((block) => [block.status, block.output])).toEqual([
				['completed', 'part'],
				['completed', 'part and the rest'],
				['failed', 'part and the rest'],
			]);
		});

		it('pairs calls and results that carry no id in the order they come', () => {
			const blocks = runEvents('opencode', [
				tool(undefined, { status: 'running', input: { n: 1 } }),
				tool(undefined, { status: 'completed', output: 'one' }),
				tool(undefined, { status: 'completed', input: { n: 2 }, output: 'two' }),
			]);

			expect(kinds(blocks)).toEqual(['tool-call', 'tool-result', 'tool-call', 'tool-result']);
			expect(ofKind(blocks, 'tool-call').map((block) => block.input)).toEqual([{ n: 1 }, { n: 2 }]);
		});

		it('records nothing for an error event but its usage', () => {
			const blocks = runEvents('antigravity', [
				{
					type: 'error',
					text: 'The model is overloaded.',
					usage: { inputTokens: 3, outputTokens: 0 },
				},
			]);

			expect(kinds(blocks)).toEqual(['usage']);
		});

		it('records nothing for a line that was not JSON', () => {
			const line = 'npm WARN deprecated something';
			const blocks = runEvents('factory-droid', [
				{ type: 'text', text: line, isPartial: true, raw: line },
			]);

			expect(blocks).toEqual([]);
		});

		it('does not throw for an event with nothing in it', () => {
			const turn = createTurnNormalizeState();
			const empty: ParsedEvent[] = [
				{ type: 'system' },
				{ type: 'text' },
				{ type: 'result' },
				{ type: 'tool_use' },
				{ type: 'tool_use', toolState: 'DONE' },
				{ type: 'text', raw: null },
			];

			for (const toolType of ['claude-code', 'codex', 'opencode']) {
				for (const event of empty) {
					expect(() => normalizeParsedEvent(toolType, event, turn)).not.toThrow();
				}
			}
		});
	});
});
