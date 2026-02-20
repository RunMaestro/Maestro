import { describe, it, expect } from 'vitest';
import { GeminiOutputParser } from '../../../main/parsers/gemini-output-parser';

describe('GeminiOutputParser', () => {
	const parser = new GeminiOutputParser();

	describe('agentId', () => {
		it('should be gemini-cli', () => {
			expect(parser.agentId).toBe('gemini-cli');
		});
	});

	describe('parseJsonLine', () => {
		it('should return null for empty lines', () => {
			expect(parser.parseJsonLine('')).toBeNull();
			expect(parser.parseJsonLine('  ')).toBeNull();
			expect(parser.parseJsonLine('\n')).toBeNull();
		});

		it('should return null for non-JSON lines', () => {
			expect(parser.parseJsonLine('not json')).toBeNull();
			expect(parser.parseJsonLine('Loading...')).toBeNull();
		});

		it('should return null for lines not starting with {', () => {
			expect(parser.parseJsonLine('[1,2,3]')).toBeNull();
			expect(parser.parseJsonLine('"hello"')).toBeNull();
		});

		it('should return null for JSON without type field', () => {
			expect(parser.parseJsonLine('{"data":"test"}')).toBeNull();
		});

		describe('init events', () => {
			it('should parse init event with session_id and model', () => {
				const line = JSON.stringify({
					type: 'init',
					timestamp: '2025-01-15T10:30:00Z',
					session_id: '5b845adc',
					model: 'gemini-2.5-flash',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('init');
				expect(event?.sessionId).toBe('5b845adc');
				expect(event?.text).toBe('Gemini CLI session started (model: gemini-2.5-flash)');
			});

			it('should handle init without model', () => {
				const line = JSON.stringify({
					type: 'init',
					session_id: 'abc123',
				});

				const event = parser.parseJsonLine(line);
				expect(event?.text).toBe('Gemini CLI session started (model: unknown)');
			});
		});

		describe('message events', () => {
			it('should parse assistant message with delta', () => {
				const line = JSON.stringify({
					type: 'message',
					role: 'assistant',
					content: "I'll create the file now.",
					delta: true,
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('text');
				expect(event?.text).toBe("I'll create the file now.");
				expect(event?.isPartial).toBe(true);
			});

			it('should parse assistant message without delta', () => {
				const line = JSON.stringify({
					type: 'message',
					role: 'assistant',
					content: 'Done!',
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('text');
				expect(event?.isPartial).toBe(false);
			});

			it('should skip user messages', () => {
				const line = JSON.stringify({
					type: 'message',
					role: 'user',
					content: 'hello',
				});

				expect(parser.parseJsonLine(line)).toBeNull();
			});
		});

		describe('tool_use events', () => {
			it('should parse tool_use event', () => {
				const line = JSON.stringify({
					type: 'tool_use',
					tool_name: 'write_file',
					tool_id: 'tool_123',
					parameters: { path: 'hello.txt', content: 'Hello' },
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('tool_use');
				expect(event?.toolName).toBe('write_file');
				expect(event?.toolState).toEqual({
					id: 'tool_123',
					name: 'write_file',
					parameters: { path: 'hello.txt', content: 'Hello' },
					status: 'running',
				});
			});
		});

		describe('tool_result events', () => {
			it('should parse successful tool_result', () => {
				const line = JSON.stringify({
					type: 'tool_result',
					tool_id: 'tool_123',
					status: 'success',
					output: 'File written successfully',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('tool_use');
				expect(event?.toolState).toEqual({
					id: 'tool_123',
					status: 'success',
					output: 'File written successfully',
					error: undefined,
				});
				expect(event?.text).toBeUndefined();
			});

			it('should parse error tool_result with error text', () => {
				const line = JSON.stringify({
					type: 'tool_result',
					tool_id: 'tool_456',
					status: 'error',
					error: { type: 'permission_denied', message: 'Cannot write to read-only file' },
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('tool_use');
				expect(event?.text).toBe('Tool error: Cannot write to read-only file');
				expect(event?.toolState).toEqual({
					id: 'tool_456',
					status: 'error',
					output: undefined,
					error: { type: 'permission_denied', message: 'Cannot write to read-only file' },
				});
			});

			it('should handle error tool_result without error message', () => {
				const line = JSON.stringify({
					type: 'tool_result',
					tool_id: 'tool_789',
					status: 'error',
				});

				const event = parser.parseJsonLine(line);
				expect(event?.text).toBe('Tool error: Unknown tool error');
			});
		});

		describe('error events (mid-stream)', () => {
			it('should parse warning error event', () => {
				const line = JSON.stringify({
					type: 'error',
					severity: 'warning',
					message: 'Loop detected, stopping execution',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('error');
				expect(event?.text).toBe('Loop detected, stopping execution');
			});

			it('should parse error severity event', () => {
				const line = JSON.stringify({
					type: 'error',
					severity: 'error',
					message: 'Maximum session turns exceeded',
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('error');
				expect(event?.text).toBe('Maximum session turns exceeded');
			});
		});

		describe('result events', () => {
			it('should parse successful result with flat stats', () => {
				const line = JSON.stringify({
					type: 'result',
					status: 'success',
					stats: {
						input_tokens: 500,
						output_tokens: 1000,
						cached: 100,
						duration_ms: 3200,
						tool_calls: 1,
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('result');
				expect(event?.text).toBe('');
				expect(event?.usage).toEqual({
					inputTokens: 500,
					outputTokens: 1000,
					cacheReadTokens: 100,
					reasoningTokens: 0,
				});
			});

			it('should parse successful result with nested model stats', () => {
				const line = JSON.stringify({
					type: 'result',
					status: 'success',
					stats: {
						models: {
							'gemini-2.5-flash': {
								tokens: {
									input: 200,
									prompt: 100,
									candidates: 500,
									total: 800,
									cached: 50,
									thoughts: 30,
								},
							},
						},
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('result');
				expect(event?.usage).toEqual({
					inputTokens: 300, // input + prompt
					outputTokens: 500, // candidates
					cacheReadTokens: 50,
					reasoningTokens: 30,
				});
			});

			it('should parse successful result without stats', () => {
				const line = JSON.stringify({
					type: 'result',
					status: 'success',
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('result');
				expect(event?.usage).toBeUndefined();
			});

			it('should parse error result', () => {
				const line = JSON.stringify({
					type: 'result',
					status: 'error',
					error: { type: 'auth_error', message: 'Token expired' },
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('error');
				expect(event?.text).toBe('Token expired');
			});

			it('should parse error result without error message', () => {
				const line = JSON.stringify({
					type: 'result',
					status: 'error',
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('error');
				expect(event?.text).toBe('Gemini CLI error');
			});
		});

		describe('unknown events', () => {
			it('should return null for unknown event types', () => {
				const line = JSON.stringify({
					type: 'unknown_type',
					data: 'something',
				});

				expect(parser.parseJsonLine(line)).toBeNull();
			});
		});

		it('should preserve raw event data', () => {
			const original = {
				type: 'init',
				session_id: 'test-123',
				model: 'gemini-2.5-pro',
			};
			const event = parser.parseJsonLine(JSON.stringify(original));
			expect(event?.raw).toEqual(original);
		});
	});

	describe('isResultMessage', () => {
		it('should return true for result events', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'result', status: 'success' })
			);
			expect(parser.isResultMessage(event!)).toBe(true);
		});

		it('should return true for error result events', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'result', status: 'error', error: { message: 'fail' } })
			);
			// Error results are emitted as type: 'error', but raw.type is 'result'
			expect(parser.isResultMessage(event!)).toBe(true);
		});

		it('should return false for non-result events', () => {
			const initEvent = parser.parseJsonLine(
				JSON.stringify({ type: 'init', session_id: 'test' })
			);
			expect(parser.isResultMessage(initEvent!)).toBe(false);

			const textEvent = parser.parseJsonLine(
				JSON.stringify({ type: 'message', role: 'assistant', content: 'hi' })
			);
			expect(parser.isResultMessage(textEvent!)).toBe(false);
		});
	});

	describe('extractSessionId', () => {
		it('should extract session ID from init event', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'init', session_id: 'gem-abc' })
			);
			expect(parser.extractSessionId(event!)).toBe('gem-abc');
		});

		it('should extract session ID from sessionId field', () => {
			const event = { type: 'init' as const, sessionId: 'custom-id' };
			expect(parser.extractSessionId(event)).toBe('custom-id');
		});

		it('should return null when no session ID', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'message', role: 'assistant', content: 'hi' })
			);
			expect(parser.extractSessionId(event!)).toBeNull();
		});
	});

	describe('extractUsage', () => {
		it('should extract usage from result event', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'result',
					status: 'success',
					stats: { input_tokens: 100, output_tokens: 200 },
				})
			);

			const usage = parser.extractUsage(event!);
			expect(usage).not.toBeNull();
			expect(usage?.inputTokens).toBe(100);
			expect(usage?.outputTokens).toBe(200);
		});

		it('should return null for events without usage', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'init', session_id: 'test' })
			);
			expect(parser.extractUsage(event!)).toBeNull();
		});
	});

	describe('extractSlashCommands', () => {
		it('should return null - Gemini CLI does not expose slash commands', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'init', session_id: 'test' })
			);
			expect(parser.extractSlashCommands(event!)).toBeNull();
		});
	});

	describe('detectErrorFromLine', () => {
		it('should return null for empty lines', () => {
			expect(parser.detectErrorFromLine('')).toBeNull();
			expect(parser.detectErrorFromLine('   ')).toBeNull();
		});

		it('should detect errors from JSON error events', () => {
			const line = JSON.stringify({
				type: 'error',
				severity: 'error',
				message: 'Maximum session turns exceeded',
			});
			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('token_exhaustion');
			expect(error?.agentId).toBe('gemini-cli');
		});

		it('should detect errors from result error events', () => {
			const line = JSON.stringify({
				type: 'result',
				status: 'error',
				error: { type: 'auth', message: 'credentials expired please login' },
			});
			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('auth_expired');
		});

		it('should NOT detect errors from plain text', () => {
			expect(parser.detectErrorFromLine('credentials expired')).toBeNull();
			expect(parser.detectErrorFromLine('rate limit')).toBeNull();
		});

		it('should return null for non-error JSON', () => {
			const line = JSON.stringify({
				type: 'message',
				role: 'assistant',
				content: 'Hello',
			});
			expect(parser.detectErrorFromLine(line)).toBeNull();
		});
	});

	describe('detectErrorFromExit', () => {
		it('should return null for exit code 0', () => {
			expect(parser.detectErrorFromExit(0, '', '')).toBeNull();
		});

		it('should map exit code 41 to auth_expired', () => {
			const error = parser.detectErrorFromExit(41, '', '');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('auth_expired');
			expect(error?.message).toContain('gemini login');
			expect(error?.recoverable).toBe(true);
		});

		it('should map exit code 42 to unknown (input error)', () => {
			const error = parser.detectErrorFromExit(42, '', '');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('unknown');
			expect(error?.message).toContain('Invalid input');
			expect(error?.recoverable).toBe(false);
		});

		it('should map exit code 52 to unknown (config error)', () => {
			const error = parser.detectErrorFromExit(52, '', '');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('unknown');
			expect(error?.message).toContain('configuration error');
		});

		it('should map exit code 53 to token_exhaustion', () => {
			const error = parser.detectErrorFromExit(53, '', '');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('token_exhaustion');
			expect(error?.message).toContain('turn limit');
			expect(error?.recoverable).toBe(false);
		});

		it('should map exit code 130 to unknown (user cancelled)', () => {
			const error = parser.detectErrorFromExit(130, '', '');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('unknown');
			expect(error?.message).toContain('cancelled');
			expect(error?.recoverable).toBe(true);
		});

		it('should detect errors from stderr before using exit code mapping', () => {
			const error = parser.detectErrorFromExit(1, 'rate limit exceeded', '');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('rate_limited');
		});

		it('should return agent_crashed for unknown non-zero exit', () => {
			const error = parser.detectErrorFromExit(137, '', '');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('agent_crashed');
			expect(error?.message).toContain('137');
			expect(error?.recoverable).toBe(false);
		});

		it('should include raw exit info', () => {
			const error = parser.detectErrorFromExit(42, 'some error', '');
			expect(error?.raw).toEqual({ exitCode: 42, stderr: 'some error' });
		});
	});

	describe('usage extraction edge cases', () => {
		it('should handle nested stats with multiple models', () => {
			const line = JSON.stringify({
				type: 'result',
				status: 'success',
				stats: {
					models: {
						'gemini-2.5-flash': {
							tokens: { input: 100, prompt: 50, candidates: 200, cached: 10, thoughts: 5 },
						},
						'gemini-2.5-pro': {
							tokens: { input: 200, prompt: 100, candidates: 300, cached: 20, thoughts: 10 },
						},
					},
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event?.usage).toEqual({
				inputTokens: 450, // (100+50) + (200+100)
				outputTokens: 500, // 200 + 300
				cacheReadTokens: 30, // 10 + 20
				reasoningTokens: 15, // 5 + 10
			});
		});

		it('should prefer flat stats over nested', () => {
			const line = JSON.stringify({
				type: 'result',
				status: 'success',
				stats: {
					input_tokens: 999,
					output_tokens: 888,
					models: {
						'gemini-2.5-flash': {
							tokens: { input: 1, candidates: 2 },
						},
					},
				},
			});

			const event = parser.parseJsonLine(line);
			// Flat fields take priority
			expect(event?.usage?.inputTokens).toBe(999);
			expect(event?.usage?.outputTokens).toBe(888);
		});

		it('should handle stats with thoughts_tokens in flat format', () => {
			const line = JSON.stringify({
				type: 'result',
				status: 'success',
				stats: {
					input_tokens: 100,
					output_tokens: 200,
					thoughts_tokens: 50,
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event?.usage?.reasoningTokens).toBe(50);
		});
	});
});
