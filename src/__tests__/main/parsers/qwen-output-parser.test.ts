import { describe, it, expect } from 'vitest';
import { QwenOutputParser } from '../../../main/parsers/qwen-output-parser';

describe('QwenOutputParser', () => {
	const parser = new QwenOutputParser();

	describe('agentId', () => {
		it('should be qwen3-coder', () => {
			expect(parser.agentId).toBe('qwen3-coder');
		});
	});

	describe('parseJsonLine', () => {
		it('should return null for empty lines', () => {
			expect(parser.parseJsonLine('')).toBeNull();
			expect(parser.parseJsonLine('   ')).toBeNull();
		});

		it('should surface session id from system session_start messages', () => {
			const line = JSON.stringify({
				type: 'system',
				subtype: 'session_start',
				session_id: 'qwen-sess-123',
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.sessionId).toBe('qwen-sess-123');
			expect(parser.extractSessionId(event!)).toBe('qwen-sess-123');
		});

		it('should parse assistant messages as partial text', () => {
			const line = JSON.stringify({
				type: 'assistant',
				session_id: 'qwen-sess-123',
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'hi' }],
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('text');
			expect(event?.text).toBe('hi');
			expect(event?.sessionId).toBe('qwen-sess-123');
			expect(event?.isPartial).toBe(true);
		});

		it('should parse result messages', () => {
			const line = JSON.stringify({
				type: 'result',
				subtype: 'success',
				result: 'done',
				session_id: 'qwen-sess-123',
				usage: {
					input_tokens: 1000,
					output_tokens: 500,
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('result');
			expect(event?.text).toBe('done');
			expect(event?.sessionId).toBe('qwen-sess-123');
			expect(parser.isResultMessage(event!)).toBe(true);
		});
	});

	describe('extractSessionId', () => {
		it('should extract session id from result message', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'result', result: 'done', session_id: 'qwen-final' })
			);
			expect(parser.extractSessionId(event!)).toBe('qwen-final');
		});
	});

	describe('extractUsage', () => {
		it('should extract token counts from result usage', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'result',
					subtype: 'success',
					result: 'done',
					session_id: 'qwen-sess-123',
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
					},
				})
			);

			const usage = parser.extractUsage(event!);
			expect(usage).not.toBeNull();
			expect(usage?.inputTokens).toBe(1000);
			expect(usage?.outputTokens).toBe(500);
		});
	});
});
