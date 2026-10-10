/**
 * @file transcript-mining.test.ts
 * @description Unit tests for the pure transcript miner: per-format line parsing,
 * decision-pair extraction (reusing the shared brain), polarity, and aggregation.
 */

import { describe, it, expect } from 'vitest';
import {
	parseClaudeTranscriptLine,
	parseCodexTranscriptLine,
	parseClaudeCwd,
	parseCodexCwd,
	flattenContent,
	replyPolarity,
	extractDecisionPairs,
	aggregateDecisionPairs,
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
		return {
			agent: 'claude-code',
			sessionId: 's',
			classification: {
				kind: 'question',
				risk,
				topic: 't',
				confidence: 'high',
				evidence: { messageId: null, reason: 'test', structured: true },
			},
			ask: 'ask?',
			reply: 'r',
			polarity,
			askedAt: 't1',
			repliedAt: 't2',
		};
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
