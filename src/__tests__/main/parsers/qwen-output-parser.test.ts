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

	describe('is_error handling', () => {
		it('reclassifies a failed result (is_error true) as an error event', () => {
			const line = JSON.stringify({
				type: 'result',
				subtype: 'error_during_execution',
				is_error: true,
				result: 'something went wrong',
				session_id: 'qwen-sess-err',
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('error');
			expect(event?.text).toBe('something went wrong');
			expect(event?.sessionId).toBe('qwen-sess-err');
			expect(parser.isResultMessage(event!)).toBe(false);
		});

		it('keeps a successful result (is_error false) as a result event', () => {
			const line = JSON.stringify({
				type: 'result',
				subtype: 'success',
				is_error: false,
				result: 'done',
				session_id: 'qwen-sess-ok',
			});

			const event = parser.parseJsonLine(line);
			expect(event?.type).toBe('result');
			expect(parser.isResultMessage(event!)).toBe(true);
		});

		it('falls back to agent_crashed for an unrecognized failure result', () => {
			const error = parser.detectErrorFromParsed({
				type: 'result',
				subtype: 'error_during_execution',
				is_error: true,
				result: 'the task could not be completed',
				session_id: 'qwen-sess-err',
			});

			expect(error).not.toBeNull();
			expect(error?.type).toBe('agent_crashed');
			expect(error?.recoverable).toBe(false);
			expect(error?.message).toBe('the task could not be completed');
			expect(error?.agentId).toBe('qwen3-coder');
		});

		it('classifies a missing session failure result as session_not_found', () => {
			const error = parser.detectErrorFromParsed({
				type: 'result',
				subtype: 'error_during_execution',
				is_error: true,
				result: 'No conversation found with session id qwen-sess-gone',
			});

			expect(error?.type).toBe('session_not_found');
			expect(error?.recoverable).toBe(true);
		});

		it('does not flag a successful result as an error', () => {
			const error = parser.detectErrorFromParsed({
				type: 'result',
				subtype: 'success',
				result: 'done',
				session_id: 'qwen-sess-ok',
			});

			expect(error).toBeNull();
		});
	});
});
