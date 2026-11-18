/**
 * @file transcript-mining.test.ts
 * @description Unit tests for the pure transcript miner: per-format line parsing,
 * decision-pair extraction (reusing the shared brain), polarity, and aggregation.
 */

import { describe, it, expect } from 'vitest';
import { createMockNativeDecisionPair } from '../../helpers/pianola';
import {
	parseClaudeTranscriptLine,
	parseCodexTranscriptLine,
	parseClaudeCwd,
	parseCodexCwd,
	flattenContent,
	replyPolarity,
	extractDecisionPairs,
	aggregateDecisionPairs,
	parseGrokTranscriptLine,
	parseGrokCwdFromSessionDir,
	GROK_PERMISSION_DECISIONS_UNSUPPORTED,
	type DecisionPair,
} from '../../../shared/pianola/transcript-mining';
import type { PianolaMessage } from '../../../shared/pianola/types';

let seq = 0;
function msg(role: PianolaMessage['role'], content: string): PianolaMessage {
	seq += 1;
	return {
		id: `m${seq}`,
		role,
		source: role === 'assistant' ? 'ai' : role,
		content,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
	};
}

describe('flattenContent', () => {
	it('returns a bare string unchanged', () => {
		expect(flattenContent('hello there')).toBe('hello there');
	});
	it('joins text blocks and ignores non-text blocks', () => {
		const content = [
			{ type: 'text', text: 'line one' },
			{ type: 'tool_use', name: 'Bash', input: {} },
			{ type: 'text', text: 'line two' },
		];
		expect(flattenContent(content)).toBe('line one\nline two');
	});
	it('returns empty for a tool-result-only array', () => {
		expect(flattenContent([{ type: 'tool_result', content: 'output' }])).toBe('');
	});
	it('returns empty for non-string non-array', () => {
		expect(flattenContent(null)).toBe('');
		expect(flattenContent(42)).toBe('');
	});
});

describe('parseClaudeTranscriptLine', () => {
	it('parses an assistant message with text blocks', () => {
		const line = JSON.stringify({
			isSidechain: false,
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [{ type: 'text', text: 'Should I run the migration now?' }],
			},
			uuid: 'a1',
			timestamp: '2026-06-01T00:00:01.000Z',
			cwd: '/proj',
		});
		const m = parseClaudeTranscriptLine(line);
		expect(m).not.toBeNull();
		expect(m?.role).toBe('assistant');
		expect(m?.content).toBe('Should I run the migration now?');
		expect(m?.id).toBe('a1');
	});
	it('parses a string-content user message', () => {
		const line = JSON.stringify({
			isSidechain: false,
			type: 'user',
			message: { role: 'user', content: 'Yes, go ahead' },
			uuid: 'u1',
			timestamp: '2026-06-01T00:00:05.000Z',
		});
		expect(parseClaudeTranscriptLine(line)?.content).toBe('Yes, go ahead');
	});
	it('returns null for header/metadata lines', () => {
		expect(
			parseClaudeTranscriptLine(JSON.stringify({ type: 'summary', leafUuid: 'x' }))
		).toBeNull();
	});
	it('returns null for sidechain turns', () => {
		const line = JSON.stringify({
			isSidechain: true,
			message: { role: 'assistant', content: 'sub-agent work' },
			uuid: 'sc1',
			timestamp: 't',
		});
		expect(parseClaudeTranscriptLine(line)).toBeNull();
	});
	it('returns null for a tool-result-only user turn (no human text)', () => {
		const line = JSON.stringify({
			isSidechain: false,
			message: { role: 'user', content: [{ type: 'tool_result', content: 'stdout' }] },
			uuid: 'tr1',
			timestamp: 't',
		});
		expect(parseClaudeTranscriptLine(line)).toBeNull();
	});
	it('returns null for invalid JSON', () => {
		expect(parseClaudeTranscriptLine('{not json')).toBeNull();
	});
});

describe('parseCodexTranscriptLine', () => {
	it('parses a response_item message', () => {
		const line = JSON.stringify({
			timestamp: '2026-06-01T00:00:01.000Z',
			type: 'response_item',
			payload: {
				type: 'message',
				role: 'assistant',
				content: [{ type: 'output_text', text: 'Do you want me to delete the file?' }],
			},
		});
		const m = parseCodexTranscriptLine(line);
		expect(m?.role).toBe('assistant');
		expect(m?.content).toBe('Do you want me to delete the file?');
	});
	it('returns null for session_meta', () => {
		const line = JSON.stringify({ type: 'session_meta', payload: { cwd: '/c', id: 's' } });
		expect(parseCodexTranscriptLine(line)).toBeNull();
	});
	it('returns null for non-message response_items (reasoning, tool calls)', () => {
		const line = JSON.stringify({
			type: 'response_item',
			payload: { type: 'reasoning', content: [] },
		});
		expect(parseCodexTranscriptLine(line)).toBeNull();
	});
});

describe('cwd extraction', () => {
	it('reads cwd from a Claude line', () => {
		expect(parseClaudeCwd(JSON.stringify({ cwd: '/proj', type: 'user' }))).toBe('/proj');
	});
	it('reads cwd from a Codex session_meta line', () => {
		expect(parseCodexCwd(JSON.stringify({ type: 'session_meta', payload: { cwd: '/cx' } }))).toBe(
			'/cx'
		);
	});
	it('returns undefined when absent', () => {
		expect(parseCodexCwd(JSON.stringify({ type: 'response_item', payload: {} }))).toBeUndefined();
	});
});

describe('replyPolarity', () => {
	it('classifies affirmatives', () => {
		expect(replyPolarity('yes')).toBe('affirmative');
		expect(replyPolarity('Go ahead, do it')).toBe('affirmative');
		expect(replyPolarity('lgtm')).toBe('affirmative');
	});
	it('classifies negatives', () => {
		expect(replyPolarity('no')).toBe('negative');
		expect(replyPolarity("don't do that")).toBe('negative');
		expect(replyPolarity('stop')).toBe('negative');
	});
	it('falls back to other for substantive replies', () => {
		expect(replyPolarity('Use the repository pattern and add a test')).toBe('other');
		expect(replyPolarity('')).toBe('other');
	});
});

describe('extractDecisionPairs', () => {
	it('pairs an awaiting-input assistant turn with the next user reply', () => {
		const messages: PianolaMessage[] = [
			msg('user', 'Please migrate the database schema.'),
			msg('assistant', 'Do you want me to run the migration now?'),
			msg('user', 'Yes, go ahead'),
		];
		const pairs = extractDecisionPairs(messages, {
			agent: 'claude-code',
			sessionId: 's1',
			projectPath: '/p',
		});
		expect(pairs).toHaveLength(1);
		expect(pairs[0].agent).toBe('claude-code');
		expect(pairs[0].sessionId).toBe('s1');
		expect(pairs[0].polarity).toBe('affirmative');
		expect(pairs[0].classification.kind).not.toBe('none');
		expect(pairs[0].ask).toContain('migration');
		expect(pairs[0].reply).toBe('Yes, go ahead');
	});
	it('does not pair a plain statement with no awaiting input', () => {
		const messages: PianolaMessage[] = [
			msg('user', 'Update the README.'),
			msg('assistant', 'I updated the README and ran the tests.'),
			msg('user', 'thanks'),
		];
		expect(extractDecisionPairs(messages, { agent: 'codex', sessionId: 's2' })).toHaveLength(0);
	});
	it('skips an awaiting turn with no following user reply', () => {
		const messages: PianolaMessage[] = [
			msg('user', 'Refactor the parser.'),
			msg('assistant', 'Should I use tabs or spaces?'),
		];
		expect(extractDecisionPairs(messages, { agent: 'claude-code', sessionId: 's3' })).toHaveLength(
			0
		);
	});
	it('captures heuristic prose asks the strict structured detector would miss', () => {
		// "let me know" is a question phrase the classifier catches heuristically,
		// even without a structured awaiting-input signal - this is the recall gain.
		const messages: PianolaMessage[] = [
			msg('user', 'Wire up the export.'),
			msg('assistant', 'I can keep the old format or switch to JSON. Let me know how to proceed.'),
			msg('user', 'switch to JSON'),
		];
		const pairs = extractDecisionPairs(messages, { agent: 'claude-code', sessionId: 's4' });
		expect(pairs).toHaveLength(1);
		expect(pairs[0].classification.kind).not.toBe('none');
		expect(pairs[0].reply).toBe('switch to JSON');
	});
});

describe('aggregateDecisionPairs', () => {
	function pair(risk: 'low' | 'medium' | 'high', polarity: DecisionPair['polarity']): DecisionPair {
		const value = createMockNativeDecisionPair(++seq);
		value.classification.risk = risk;
		value.polarity = polarity;
		return value;
	}
	it('rolls up risk counts, polarity counts, and the risk x polarity cross-tab', () => {
		const pairs: DecisionPair[] = [
			pair('low', 'affirmative'),
			pair('low', 'affirmative'),
			pair('low', 'negative'),
			pair('high', 'other'),
		];
		const agg = aggregateDecisionPairs(pairs);
		expect(agg.total).toBe(4);
		expect(agg.byRisk).toEqual({ low: 3, high: 1 });
		expect(agg.byPolarity).toEqual({ affirmative: 2, negative: 1, other: 1 });
		expect(agg.byRiskPolarity.low).toEqual({ affirmative: 2, negative: 1, other: 0 });
		expect(agg.byRiskPolarity.high).toEqual({ affirmative: 0, negative: 0, other: 1 });
	});
});

describe('size caps (Q8 robustness)', () => {
	it('truncates flattened string content to the classifier cap', () => {
		const flat = flattenContent('x'.repeat(150_000));
		expect(flat.length).toBe(100_000);
	});

	it('truncates flattened array text content to the classifier cap', () => {
		const flat = flattenContent([{ type: 'text', text: 'y'.repeat(150_000) }]);
		expect(flat.length).toBe(100_000);
	});

	it('leaves normal-sized content unaffected', () => {
		expect(flattenContent('regular reply')).toBe('regular reply');
		expect(flattenContent([{ type: 'text', text: 'a normal block' }])).toBe('a normal block');
	});

	it('skips an oversized Claude JSONL line before parsing', () => {
		const line = JSON.stringify({
			isSidechain: false,
			type: 'assistant',
			message: { role: 'assistant', content: 'z'.repeat(300_000) },
			uuid: 'big1',
			timestamp: 't',
		});
		expect(line.length).toBeGreaterThan(256 * 1024);
		expect(parseClaudeTranscriptLine(line)).toBeNull();
	});

	it('skips an oversized Codex JSONL line before parsing', () => {
		const line = JSON.stringify({
			type: 'response_item',
			payload: {
				type: 'message',
				role: 'assistant',
				content: [{ type: 'output_text', text: 'z'.repeat(300_000) }],
			},
			timestamp: 't',
		});
		expect(line.length).toBeGreaterThan(256 * 1024);
		expect(parseCodexTranscriptLine(line)).toBeNull();
	});

	it('parses a line under the byte cap but truncates its large content', () => {
		const line = JSON.stringify({
			isSidechain: false,
			type: 'assistant',
			message: { role: 'assistant', content: 'w'.repeat(150_000) },
			uuid: 'mid1',
			timestamp: 't',
		});
		expect(line.length).toBeLessThan(256 * 1024);
		const m = parseClaudeTranscriptLine(line);
		expect(m).not.toBeNull();
		expect(m?.content.length).toBe(100_000);
	});

	it('parses a normal line unaffected by the caps', () => {
		const line = JSON.stringify({
			isSidechain: false,
			type: 'assistant',
			message: { role: 'assistant', content: 'short and sweet' },
			uuid: 'ok1',
			timestamp: 't',
		});
		expect(parseClaudeTranscriptLine(line)?.content).toBe('short and sweet');
	});
});

/**
 * Grok native transcript mining. The native rows below follow the
 * sanitized `chat_history.jsonl` shapes the Grok session reader suite pins
 * (`src/__tests__/main/storage/grok-session-storage.test.ts`): format 1
 * `ConversationItem` rows keyed by `type`, a `<user_info>` environment block,
 * `synthetic_reason` injections, `<user_query>` wrappers, reasoning, tool calls
 * and tool results. Every decision is a test input; nothing here is a live or
 * recorded native transcript, so none of it counts as native qualification.
 */
describe('Grok native transcripts', () => {
	const jsonl = (rows: unknown[]): string[] => rows.map((row) => JSON.stringify(row));
	const parseAll = (lines: string[]): PianolaMessage[] =>
		lines
			.map((line, index) => parseGrokTranscriptLine(line, index + 1))
			.filter((m): m is PianolaMessage => m !== null);
	// Assembled at run time so no scanner reads the fixture as a real key.
	const SECRET = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd'].join('-');

	/** Native shape: one prose ask between tool work, answered by a typed reply. */
	const nativeSession = (): string[] =>
		jsonl([
			{ type: 'system', content: 'You are Grok 4.5 released by xAI.' },
			{
				type: 'user',
				content: [
					{ type: 'text', text: '<user_info>\nOS Version: macos\nShell: /bin/zsh\n</user_info>' },
				],
			},
			{
				type: 'user',
				synthetic_reason: 'project_instructions',
				content: [{ type: 'text', text: '<system-reminder>\nShould I? yes\n</system-reminder>' }],
			},
			{
				type: 'user',
				content: [
					{ type: 'text', text: '<user_query>\nRename the helper in utils.ts\n</user_query>' },
				],
			},
			{ type: 'reasoning', id: 'r1', status: 'completed', encrypted_content: 'opaque' },
			{
				type: 'assistant',
				content: '',
				tool_calls: [{ id: 'call-1', name: 'read', arguments: '{"file_path":"utils.ts"}' }],
			},
			{ type: 'tool_result', tool_call_id: 'call-1', content: 'yes' },
			{ type: 'assistant', content: 'Do you want me to rename the tests as well?' },
			{ type: 'tool_result', tool_call_id: 'call-2', content: 'no' },
			{
				type: 'user',
				content: [{ type: 'text', text: '<user_query>\nno, leave the tests\n</user_query>' }],
			},
		]);

	it('keeps only typed user text and assistant prose, with source-line ids and no invented time', () => {
		const messages = parseAll(nativeSession());
		expect(messages).toEqual([
			{
				id: 'grok-line-4',
				role: 'user',
				source: 'user',
				content: 'Rename the helper in utils.ts',
				timestamp: '',
			},
			{
				id: 'grok-line-8',
				role: 'assistant',
				source: 'assistant',
				content: 'Do you want me to rename the tests as well?',
				timestamp: '',
			},
			{
				id: 'grok-line-10',
				role: 'user',
				source: 'user',
				content: 'no, leave the tests',
				timestamp: '',
			},
		]);
	});

	it('pairs the ask with the human reply past tool results, with line provenance', () => {
		const pairs = extractDecisionPairs(parseAll(nativeSession()), {
			agent: 'grok',
			sessionId: 'sess-1',
			projectPath: '/work/proj',
		});
		expect(pairs).toHaveLength(1);
		expect(pairs[0]).toMatchObject({
			agent: 'grok',
			sessionId: 'sess-1',
			projectPath: '/work/proj',
			ask: 'Do you want me to rename the tests as well?',
			reply: 'no, leave the tests',
			polarity: 'negative',
			askedAt: '',
			repliedAt: '',
			provenance: { format: 'grok-chat-history', askLine: 8, replyLine: 10 },
		});
		expect(pairs[0].classification.kind).not.toBe('none');
	});

	it('never treats a tool result, a shell command or a subagent echo as the reply', () => {
		// Synthetic: the ask is followed only by non-human records, so no decision exists.
		const lines = jsonl([
			{ type: 'assistant', content: 'Should I delete the build folder?' },
			{ type: 'tool_result', tool_call_id: 'c1', content: 'yes' },
			{ type: 'user', synthetic_reason: 'direct_bash', content: [{ type: 'text', text: 'yes' }] },
			{ type: 'user', synthetic_reason: 'parent_human_message', content: 'yes go ahead' },
			{
				type: 'user',
				synthetic_reason: 'system_reminder',
				content: [{ type: 'text', text: 'yes' }],
			},
		]);
		expect(extractDecisionPairs(parseAll(lines), { agent: 'grok', sessionId: 's' })).toEqual([]);
	});

	it('never infers a decision from the model describing consent', () => {
		// Synthetic: assistant prose that claims approval, with no typed reply after it.
		const lines = jsonl([
			{
				type: 'user',
				content: [{ type: 'text', text: '<user_query>\nClean up the repo\n</user_query>' }],
			},
			{
				type: 'assistant',
				content: 'Should I remove the old logs? The user approved this earlier.',
			},
			{ type: 'assistant', content: 'You approved the deletion, so I removed the logs.' },
		]);
		expect(extractDecisionPairs(parseAll(lines), { agent: 'grok', sessionId: 's' })).toEqual([]);
	});

	it.each(['human', 'interjection'])('keeps a user record marked synthetic_reason %s', (reason) => {
		const line = JSON.stringify({
			type: 'user',
			synthetic_reason: reason,
			content: [{ type: 'text', text: 'yes do it' }],
		});
		expect(parseGrokTranscriptLine(line, 3)).toMatchObject({
			id: 'grok-line-3',
			role: 'user',
			content: 'yes do it',
		});
	});

	it.each([
		'system_reminder',
		'project_instructions',
		'parent_human_message',
		'direct_bash',
		'unknown_reason',
	])('drops a user record marked synthetic_reason %s', (reason) => {
		const line = JSON.stringify({
			type: 'user',
			synthetic_reason: reason,
			content: [{ type: 'text', text: 'yes' }],
		});
		expect(parseGrokTranscriptLine(line, 1)).toBeNull();
	});

	it('drops system, reasoning, tool_result, tool-call-only and environment rows', () => {
		const lines = jsonl([
			{ type: 'system', content: 'Should I? You are Grok.' },
			{ type: 'reasoning', id: 'r', summary: [{ type: 'text', text: 'Should I ask?' }] },
			{ type: 'tool_result', tool_call_id: 'c', content: 'yes' },
			{ type: 'assistant', content: '', tool_calls: [{ id: 'c', name: 'bash', arguments: '{}' }] },
			{
				type: 'user',
				content: [{ type: 'text', text: '<user_info>\nOS Version: macos\n</user_info>' }],
			},
		]);
		lines.forEach((line, index) => expect(parseGrokTranscriptLine(line, index + 1)).toBeNull());
	});

	it('joins several user_query blocks and keeps unwrapped typed text as is', () => {
		const wrapped = JSON.stringify({
			type: 'user',
			content: [
				{
					type: 'text',
					text: '<user_query>\nfirst\n</user_query>\n<user_query>\n</user_query>\n<user_query>second</user_query>',
				},
			],
		});
		expect(parseGrokTranscriptLine(wrapped, 1)?.content).toBe('first\n\nsecond');
		expect(
			parseGrokTranscriptLine(JSON.stringify({ type: 'user', content: '  plain reply  ' }), 2)
				?.content
		).toBe('plain reply');
	});

	it('reads legacy rows keyed by role', () => {
		expect(
			parseGrokTranscriptLine(JSON.stringify({ role: 'assistant', content: 'Proceed?' }), 5)
		).toMatchObject({
			id: 'grok-line-5',
			role: 'assistant',
			content: 'Proceed?',
		});
		expect(parseGrokTranscriptLine(JSON.stringify({ role: 'user', content: 'yes' }), 6)?.role).toBe(
			'user'
		);
		expect(parseGrokTranscriptLine(JSON.stringify({ role: 'tool', content: 'yes' }), 7)).toBeNull();
	});

	it('returns null for malformed, blank, non-object and oversized lines', () => {
		expect(parseGrokTranscriptLine('{not json', 1)).toBeNull();
		expect(parseGrokTranscriptLine('   ', 2)).toBeNull();
		expect(parseGrokTranscriptLine('"just a string"', 3)).toBeNull();
		expect(parseGrokTranscriptLine('null', 4)).toBeNull();
		const big = JSON.stringify({ type: 'assistant', content: 'z'.repeat(300_000) });
		expect(big.length).toBeGreaterThan(256 * 1024);
		expect(parseGrokTranscriptLine(big, 5)).toBeNull();
	});

	it('mines past malformed and oversized lines with true source line numbers', () => {
		const lines = [
			'{not json',
			JSON.stringify({ type: 'assistant', content: 'z'.repeat(300_000) + ' Should I?' }),
			JSON.stringify({ type: 'assistant', content: 'Should I push the branch now?' }),
			'',
			JSON.stringify({
				type: 'user',
				content: [{ type: 'text', text: '<user_query>\nyes\n</user_query>' }],
			}),
		];
		const pairs = extractDecisionPairs(parseAll(lines), { agent: 'grok', sessionId: 's' });
		expect(pairs).toHaveLength(1);
		expect(pairs[0]).toMatchObject({
			polarity: 'affirmative',
			provenance: { format: 'grok-chat-history', askLine: 3, replyLine: 5 },
		});
	});

	it('redacts secrets in user and assistant text before classification', () => {
		const ask = parseGrokTranscriptLine(
			JSON.stringify({ type: 'assistant', content: `Should I store the key ${SECRET} in .env?` }),
			1
		);
		const reply = parseGrokTranscriptLine(
			JSON.stringify({
				type: 'user',
				content: [{ type: 'text', text: `<user_query>\nno, ${SECRET} is live\n</user_query>` }],
			}),
			2
		);
		expect(ask?.content).not.toContain(SECRET);
		expect(reply?.content).not.toContain(SECRET);
		const pairs = extractDecisionPairs([ask!, reply!], { agent: 'grok', sessionId: 's' });
		expect(JSON.stringify(pairs)).not.toContain(SECRET);
		expect(pairs[0].provenance).toEqual({ format: 'grok-chat-history', askLine: 1, replyLine: 2 });
	});

	it('adds provenance only to Grok pairs built from Grok line ids', () => {
		// Synthetic messages with non-native ids: no line can be named, so none is invented.
		const messages: PianolaMessage[] = [
			msg('assistant', 'Should I run the migration now?'),
			msg('user', 'yes'),
		];
		expect(extractDecisionPairs(messages, { agent: 'grok', sessionId: 's' })[0]).not.toHaveProperty(
			'provenance'
		);
		const native = parseAll(
			jsonl([
				{ type: 'assistant', content: 'Should I run the migration now?' },
				{ type: 'user', content: 'yes' },
			])
		);
		expect(
			extractDecisionPairs(native, { agent: 'claude-code', sessionId: 's' })[0]
		).not.toHaveProperty('provenance');
	});

	it('reports tool-permission decisions as an explicit unsupported result', () => {
		expect(GROK_PERMISSION_DECISIONS_UNSUPPORTED).toEqual({
			code: 'grok-permission-decisions-unrecorded',
			reason: expect.stringContaining(
				'chat_history.jsonl does not record tool-permission decisions'
			),
		});
	});

	it('decodes the project path from the session folder name', () => {
		expect(parseGrokCwdFromSessionDir(encodeURIComponent('/Users/me/my proj'))).toBe(
			'/Users/me/my proj'
		);
		expect(parseGrokCwdFromSessionDir('%E0%A4%A')).toBeUndefined();
		expect(parseGrokCwdFromSessionDir('')).toBeUndefined();
	});
});
