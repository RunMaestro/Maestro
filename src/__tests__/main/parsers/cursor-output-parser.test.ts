import { describe, it, expect, beforeEach } from 'vitest';
import { CursorOutputParser } from '../../../main/parsers/cursor-output-parser';

describe('CursorOutputParser', () => {
	let parser: CursorOutputParser;

	beforeEach(() => {
		parser = new CursorOutputParser();
	});

	describe('agentId', () => {
		it('should be cursor', () => {
			expect(parser.agentId).toBe('cursor');
		});
	});

	describe('parseJsonLine', () => {
		it('should return null for empty lines', () => {
			expect(parser.parseJsonLine('')).toBeNull();
			expect(parser.parseJsonLine('  ')).toBeNull();
			expect(parser.parseJsonLine('\n')).toBeNull();
		});

		describe('system init events', () => {
			it('should parse system init as init event with model info', () => {
				const line = JSON.stringify({
					type: 'system',
					subtype: 'init',
					model: 'gpt-5.2',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('init');
				expect(event?.text).toBe('Model: gpt-5.2');
			});

			it('should handle system init without model', () => {
				const line = JSON.stringify({
					type: 'system',
					subtype: 'init',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('init');
				expect(event?.text).toBeUndefined();
			});
		});

		describe('assistant events', () => {
			it('should parse assistant message with content array', () => {
				const line = JSON.stringify({
					type: 'assistant',
					message: {
						content: [{ type: 'text', text: 'Hello world' }],
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('text');
				expect(event?.text).toBe('Hello world');
				expect(event?.isPartial).toBe(true);
			});

			it('should parse assistant message with string content', () => {
				const line = JSON.stringify({
					type: 'assistant',
					message: {
						content: 'Direct string content',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('text');
				expect(event?.text).toBe('Direct string content');
				expect(event?.isPartial).toBe(true);
			});

			it('should concatenate multiple text blocks', () => {
				const line = JSON.stringify({
					type: 'assistant',
					message: {
						content: [
							{ type: 'text', text: 'Part 1' },
							{ type: 'text', text: ' Part 2' },
						],
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.text).toBe('Part 1 Part 2');
			});

			it('should handle assistant message with empty content', () => {
				const line = JSON.stringify({
					type: 'assistant',
					message: {},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('text');
				expect(event?.text).toBe('');
			});

			it('should filter non-text content blocks', () => {
				const line = JSON.stringify({
					type: 'assistant',
					message: {
						content: [
							{ type: 'image', url: 'http://example.com/img.png' },
							{ type: 'text', text: 'Caption' },
						],
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.text).toBe('Caption');
			});
		});

		describe('tool_call events', () => {
			it('should parse tool_call started as tool_use with running status', () => {
				const line = JSON.stringify({
					type: 'tool_call',
					subtype: 'started',
					args: { path: '/src/main.ts' },
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('tool_use');
				expect(event?.toolState).toEqual({
					status: 'running',
					input: { path: '/src/main.ts' },
				});
			});

			it('should parse tool_call completed as tool_use with completed status', () => {
				const line = JSON.stringify({
					type: 'tool_call',
					subtype: 'completed',
					args: { path: '/src/main.ts' },
					result: 'file content here',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('tool_use');
				expect(event?.toolState).toEqual({
					status: 'completed',
					output: 'file content here',
				});
			});

			it('should derive write tool name from args with content', () => {
				const line = JSON.stringify({
					type: 'tool_call',
					subtype: 'started',
					args: { path: '/src/file.ts', content: 'new content' },
				});

				const event = parser.parseJsonLine(line);
				expect(event?.toolName).toBe('write');
			});

			it('should derive read tool name from args with path only', () => {
				const line = JSON.stringify({
					type: 'tool_call',
					subtype: 'started',
					args: { path: '/src/file.ts' },
				});

				const event = parser.parseJsonLine(line);
				expect(event?.toolName).toBe('read');
			});

			it('should use toolType field when present (strip ToolCall suffix)', () => {
				const line = JSON.stringify({
					type: 'tool_call',
					subtype: 'started',
					toolType: 'searchToolCall',
					args: { query: 'hello' },
				});

				const event = parser.parseJsonLine(line);
				expect(event?.toolName).toBe('search');
			});

			it('should use toolType field as-is when no ToolCall suffix', () => {
				const line = JSON.stringify({
					type: 'tool_call',
					subtype: 'started',
					toolType: 'bash',
					args: { command: 'ls' },
				});

				const event = parser.parseJsonLine(line);
				expect(event?.toolName).toBe('bash');
			});

			it('should handle tool_call with unknown subtype', () => {
				const line = JSON.stringify({
					type: 'tool_call',
					subtype: 'pending',
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('tool_use');
				expect(event?.toolState).toEqual({
					status: 'pending',
				});
			});

			it('should handle tool_call without subtype', () => {
				const line = JSON.stringify({
					type: 'tool_call',
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('tool_use');
				expect(event?.toolName).toBeUndefined();
				expect(event?.toolState).toEqual({
					status: 'unknown',
				});
			});
		});

		describe('result events', () => {
			it('should parse result with duration_ms', () => {
				const line = JSON.stringify({
					type: 'result',
					duration_ms: 1500,
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('result');
				expect(event?.text).toBe('Completed in 1500ms');
			});

			it('should parse result without duration_ms', () => {
				const line = JSON.stringify({
					type: 'result',
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('result');
				expect(event?.text).toBeUndefined();
			});
		});

		describe('error events', () => {
			it('should parse error type with string error', () => {
				const line = JSON.stringify({
					type: 'error',
					error: 'Something went wrong',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('error');
				expect(event?.text).toBe('Something went wrong');
			});

			it('should parse error type with object error', () => {
				const line = JSON.stringify({
					type: 'error',
					error: { message: 'Model not found', type: 'invalid_request' },
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('error');
				expect(event?.text).toBe('Model not found');
			});

			it('should parse message with error field (no type)', () => {
				const line = JSON.stringify({
					error: 'Connection failed',
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('error');
				expect(event?.text).toBe('Connection failed');
			});
		});

		describe('unknown events', () => {
			it('should parse unknown event types as system', () => {
				const line = JSON.stringify({
					type: 'unknown_event',
					data: 'something',
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('system');
			});

			it('should parse messages without type as system', () => {
				const line = JSON.stringify({ data: 'some data' });

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('system');
			});
		});

		it('should handle invalid JSON as text', () => {
			const event = parser.parseJsonLine('not valid json');
			expect(event).not.toBeNull();
			expect(event?.type).toBe('text');
			expect(event?.text).toBe('not valid json');
		});

		it('should preserve raw message', () => {
			const original = {
				type: 'system',
				subtype: 'init',
				model: 'test-model',
			};
			const line = JSON.stringify(original);

			const event = parser.parseJsonLine(line);
			expect(event?.raw).toEqual(original);
		});
	});

	describe('parseJsonObject', () => {
		it('should return null for null input', () => {
			expect(parser.parseJsonObject(null)).toBeNull();
		});

		it('should return null for non-object input', () => {
			expect(parser.parseJsonObject('string')).toBeNull();
			expect(parser.parseJsonObject(42)).toBeNull();
		});

		it('should parse a valid object', () => {
			const event = parser.parseJsonObject({
				type: 'assistant',
				message: { content: 'hello' },
			});
			expect(event?.type).toBe('text');
			expect(event?.text).toBe('hello');
		});
	});

	describe('isResultMessage', () => {
		it('should return true for result events', () => {
			const event = parser.parseJsonLine(JSON.stringify({ type: 'result', duration_ms: 100 }));
			expect(event).not.toBeNull();
			expect(parser.isResultMessage(event!)).toBe(true);
		});

		it('should return false for non-result events', () => {
			const initEvent = parser.parseJsonLine(JSON.stringify({ type: 'system', subtype: 'init' }));
			expect(parser.isResultMessage(initEvent!)).toBe(false);

			const textEvent = parser.parseJsonLine(
				JSON.stringify({ type: 'assistant', message: { content: 'hi' } })
			);
			expect(parser.isResultMessage(textEvent!)).toBe(false);
		});
	});

	describe('extractSessionId', () => {
		it('should return null when no session ID is present', () => {
			const event = parser.parseJsonLine(JSON.stringify({ type: 'system', subtype: 'init' }));
			expect(parser.extractSessionId(event!)).toBeNull();
		});

		it('should extract session ID if present in event', () => {
			const event = {
				type: 'init' as const,
				sessionId: 'cursor-session-123',
			};
			expect(parser.extractSessionId(event)).toBe('cursor-session-123');
		});
	});

	describe('extractUsage', () => {
		it('should return null - Cursor does not expose usage in CLI output', () => {
			const event = parser.parseJsonLine(JSON.stringify({ type: 'system', subtype: 'init' }));
			expect(parser.extractUsage(event!)).toBeNull();
		});

		it('should pass through usage if present on event', () => {
			const usage = { inputTokens: 100, outputTokens: 50 };
			const event = { type: 'usage' as const, usage };
			expect(parser.extractUsage(event)).toEqual(usage);
		});
	});

	describe('extractSlashCommands', () => {
		it('should return null for init events (Cursor does not expose commands in stream-json)', () => {
			const event = parser.parseJsonLine(JSON.stringify({ type: 'system', subtype: 'init' }));
			expect(parser.extractSlashCommands(event!)).toBeNull();
		});

		it('should return null for non-init events', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'assistant', message: { content: 'hi' } })
			);
			expect(parser.extractSlashCommands(event!)).toBeNull();
		});
	});

	describe('detectErrorFromLine', () => {
		it('should return null for empty lines', () => {
			expect(parser.detectErrorFromLine('')).toBeNull();
			expect(parser.detectErrorFromLine('   ')).toBeNull();
		});

		it('should detect authentication errors from JSON', () => {
			const line = JSON.stringify({ type: 'error', error: 'invalid api key' });
			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('auth_expired');
			expect(error?.agentId).toBe('cursor');
		});

		it('should detect not authenticated errors from JSON', () => {
			const line = JSON.stringify({ type: 'error', error: 'not authenticated' });
			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('auth_expired');
		});

		it('should detect rate limit errors from JSON', () => {
			const line = JSON.stringify({ error: 'rate limit exceeded' });
			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('rate_limited');
		});

		it('should detect token exhaustion errors from JSON', () => {
			const line = JSON.stringify({ type: 'error', error: 'context length exceeded' });
			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('token_exhaustion');
		});

		it('should detect errors from raw text using error patterns', () => {
			const error = parser.detectErrorFromLine('connection failed to server');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('network_error');
			expect(error?.agentId).toBe('cursor');
		});

		it('should include errorLine in raw for JSON errors', () => {
			const line = JSON.stringify({ type: 'error', error: 'invalid api key' });
			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.raw).toHaveProperty('errorLine', line);
		});

		it('should include errorLine in raw for raw text errors', () => {
			const error = parser.detectErrorFromLine('connection failed to server');
			expect(error).not.toBeNull();
			expect(error?.raw).toHaveProperty('errorLine', 'connection failed to server');
		});

		it('should return null for non-error lines', () => {
			expect(parser.detectErrorFromLine('normal output')).toBeNull();
		});

		it('should return unknown type for unrecognized JSON errors', () => {
			const line = JSON.stringify({ type: 'error', error: 'some unusual error message' });
			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('unknown');
			expect(error?.recoverable).toBe(true);
		});
	});

	describe('detectErrorFromParsed', () => {
		it('should return null for null input', () => {
			expect(parser.detectErrorFromParsed(null)).toBeNull();
		});

		it('should return null for non-object input', () => {
			expect(parser.detectErrorFromParsed('string')).toBeNull();
		});

		it('should detect error from parsed object', () => {
			const error = parser.detectErrorFromParsed({
				type: 'error',
				error: 'rate limit exceeded',
			});
			expect(error).not.toBeNull();
			expect(error?.type).toBe('rate_limited');
		});

		it('should return null for non-error objects', () => {
			expect(parser.detectErrorFromParsed({ type: 'assistant' })).toBeNull();
		});

		it('should return unknown for unrecognized error with parsedJson', () => {
			const error = parser.detectErrorFromParsed({
				type: 'error',
				error: 'novel error',
			});
			expect(error).not.toBeNull();
			expect(error?.type).toBe('unknown');
			expect(error?.parsedJson).toBeDefined();
		});

		it('should handle error type with no error field', () => {
			const error = parser.detectErrorFromParsed({
				type: 'error',
			});
			expect(error).not.toBeNull();
			expect(error?.type).toBe('unknown');
			expect(error?.message).toBe('Agent error');
			expect(error?.agentId).toBe('cursor');
		});
	});

	describe('detectErrorFromExit', () => {
		it('should return null for exit code 0', () => {
			expect(parser.detectErrorFromExit(0, '', '')).toBeNull();
		});

		it('should detect errors from stderr', () => {
			const error = parser.detectErrorFromExit(1, 'invalid api key', '');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('auth_expired');
			expect(error?.agentId).toBe('cursor');
		});

		it('should detect errors from stdout', () => {
			const error = parser.detectErrorFromExit(1, '', 'rate limit exceeded');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('rate_limited');
			expect(error?.agentId).toBe('cursor');
		});

		it('should return agent_crashed for unknown non-zero exit', () => {
			const error = parser.detectErrorFromExit(137, '', '');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('agent_crashed');
			expect(error?.message).toContain('137');
			expect(error?.agentId).toBe('cursor');
		});

		it('should include raw exit info', () => {
			const error = parser.detectErrorFromExit(1, 'error stderr', 'output stdout');
			expect(error?.raw).toEqual({
				exitCode: 1,
				stderr: 'error stderr',
				stdout: 'output stdout',
			});
		});
	});
});
