import { describe, it, expect } from 'vitest';
import { OpenCodeOutputParser } from '../../main/parsers/opencode-output-parser';

describe('OpenCodeOutputParser', () => {
	const parser = new OpenCodeOutputParser();

	describe('agentId', () => {
		it('should be opencode', () => {
			expect(parser.agentId).toBe('opencode');
		});
	});

	describe('parseJsonLine', () => {
		it('should return null for empty lines', () => {
			expect(parser.parseJsonLine('')).toBeNull();
			expect(parser.parseJsonLine('  ')).toBeNull();
			expect(parser.parseJsonLine('\n')).toBeNull();
		});

		it('should parse step_start messages as init', () => {
			const line = JSON.stringify({
				type: 'step_start',
				sessionID: 'oc-sess-123',
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('init');
			expect(event?.sessionId).toBe('oc-sess-123');
		});

		it('should parse text messages as result (final response, not streaming)', () => {
			const line = JSON.stringify({
				type: 'text',
				sessionID: 'oc-sess-123',
				part: {
					text: 'Analyzing your code...',
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('result');
			expect(event?.text).toBe('Analyzing your code...');
			expect(event?.sessionId).toBe('oc-sess-123');
			expect(event?.isPartial).toBeUndefined();
		});

		it('should parse tool_use messages', () => {
			// Actual OpenCode format: tool name in part.tool, state in part.state
			const line = JSON.stringify({
				type: 'tool_use',
				sessionID: 'oc-sess-123',
				part: {
					tool: 'view',
					state: {
						status: 'completed',
						input: { path: '/src/index.ts' },
						output: 'file contents...',
					},
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('tool_use');
			expect(event?.toolName).toBe('view');
			expect(event?.toolState).toEqual({
				status: 'completed',
				input: { path: '/src/index.ts' },
				output: 'file contents...',
			});
			expect(event?.sessionId).toBe('oc-sess-123');
		});

		it('should parse step_finish messages with reason "stop" as system (usage only)', () => {
			// Actual OpenCode format: reason and tokens in part
			// step_finish is now always system - result text comes from the preceding text event
			const line = JSON.stringify({
				type: 'step_finish',
				sessionID: 'oc-sess-123',
				part: {
					reason: 'stop',
					cost: 0.001,
					tokens: {
						input: 500,
						output: 200,
						reasoning: 0,
						cache: { read: 100, write: 50 },
					},
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('system');
			expect(event?.sessionId).toBe('oc-sess-123');
			expect(event?.usage?.inputTokens).toBe(500);
			expect(event?.usage?.outputTokens).toBe(200);
			expect(event?.usage?.cacheReadTokens).toBe(100);
			expect(event?.usage?.cacheCreationTokens).toBe(50);
			expect(event?.usage?.costUsd).toBe(0.001);
		});

		it('should parse step_finish messages with reason "tool-calls" as system', () => {
			// step_finish with reason "tool-calls" means more work is coming
			const line = JSON.stringify({
				type: 'step_finish',
				sessionID: 'oc-sess-123',
				part: {
					reason: 'tool-calls',
					tokens: { input: 100, output: 50 },
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('system');
			expect(event?.sessionId).toBe('oc-sess-123');
		});

		it('should parse error messages', () => {
			const line = JSON.stringify({
				sessionID: 'oc-sess-123',
				error: 'Connection failed: timeout',
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('error');
			expect(event?.text).toBe('Connection failed: timeout');
			expect(event?.sessionId).toBe('oc-sess-123');
		});

		it('should handle messages with only sessionID', () => {
			const line = JSON.stringify({
				sessionID: 'oc-sess-123',
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('system');
			expect(event?.sessionId).toBe('oc-sess-123');
		});

		it('should handle invalid JSON as text', () => {
			const event = parser.parseJsonLine('not valid json');
			expect(event).not.toBeNull();
			expect(event?.type).toBe('text');
			expect(event?.text).toBe('not valid json');
		});

		it('should preserve raw message', () => {
			const original = {
				type: 'step_finish',
				sessionID: 'oc-sess-123',
				part: { reason: 'stop' },
			};
			const line = JSON.stringify(original);

			const event = parser.parseJsonLine(line);
			expect(event?.raw).toEqual(original);
		});
	});

	describe('parseJsonObject', () => {
		it('should return null for nullish and non-object values', () => {
			expect(parser.parseJsonObject(null)).toBeNull();
			expect(parser.parseJsonObject(undefined)).toBeNull();
			expect(parser.parseJsonObject('text')).toBeNull();
		});

		it('should parse pre-parsed OpenCode messages', () => {
			expect(
				parser.parseJsonObject({
					type: 'text',
					sessionID: 'oc-preparsed',
					part: { text: 'Pre-parsed result' },
				})
			).toMatchObject({
				type: 'result',
				text: 'Pre-parsed result',
				sessionId: 'oc-preparsed',
			});
		});

		it('should parse structured error event text from data message', () => {
			expect(
				parser.parseJsonObject({
					type: 'error',
					sessionID: 'oc-error',
					error: { data: { message: 'Provider not found' } },
				})
			).toMatchObject({
				type: 'error',
				text: 'Provider not found',
				sessionId: 'oc-error',
			});
		});

		it('should parse structured error event text from direct message', () => {
			expect(
				parser.parseJsonObject({
					type: 'error',
					error: { message: 'Authentication failed' },
				})
			).toMatchObject({
				type: 'error',
				text: 'Authentication failed',
			});
		});

		it('should return an empty error text when structured error has no message', () => {
			expect(
				parser.parseJsonObject({
					type: 'error',
					error: { name: 'APIError' },
				})
			).toMatchObject({
				type: 'error',
				text: '',
			});
		});

		it('should return an empty error text for type-only error events', () => {
			expect(
				parser.parseJsonObject({
					type: 'error',
					sessionID: 'oc-type-only-error',
				})
			).toMatchObject({
				type: 'error',
				text: '',
				sessionId: 'oc-type-only-error',
			});
		});
	});

	describe('isResultMessage', () => {
		it('should return true for text events (final response)', () => {
			const textEvent = parser.parseJsonLine(
				JSON.stringify({ type: 'text', part: { text: 'Here is the answer' } })
			);
			expect(textEvent).not.toBeNull();
			expect(parser.isResultMessage(textEvent!)).toBe(true);
		});

		it('should return false for step_finish events (usage-only, not result)', () => {
			const stopEvent = parser.parseJsonLine(
				JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } })
			);
			expect(stopEvent).not.toBeNull();
			expect(parser.isResultMessage(stopEvent!)).toBe(false);

			const toolCallsEvent = parser.parseJsonLine(
				JSON.stringify({ type: 'step_finish', part: { reason: 'tool-calls' } })
			);
			expect(toolCallsEvent).not.toBeNull();
			expect(parser.isResultMessage(toolCallsEvent!)).toBe(false);
		});

		it('should return false for non-result events', () => {
			const initEvent = parser.parseJsonLine(
				JSON.stringify({ type: 'step_start', sessionID: 'sess-123' })
			);
			expect(initEvent).not.toBeNull();
			expect(parser.isResultMessage(initEvent!)).toBe(false);

			const toolEvent = parser.parseJsonLine(
				JSON.stringify({ type: 'tool_use', part: { tool: 'bash' } })
			);
			expect(toolEvent).not.toBeNull();
			expect(parser.isResultMessage(toolEvent!)).toBe(false);
		});
	});

	describe('extractSessionId', () => {
		it('should extract session ID from step_start message', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'step_start', sessionID: 'oc-xyz' })
			);
			expect(parser.extractSessionId(event!)).toBe('oc-xyz');
		});

		it('should extract session ID from step_finish message', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'step_finish', sessionID: 'oc-123', part: { reason: 'stop' } })
			);
			expect(parser.extractSessionId(event!)).toBe('oc-123');
		});

		it('should return null when no session ID', () => {
			const event = parser.parseJsonLine(JSON.stringify({ type: 'step_start' }));
			expect(parser.extractSessionId(event!)).toBeNull();
		});
	});

	describe('extractUsage', () => {
		it('should extract usage from step_finish message', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'step_finish',
					part: {
						reason: 'stop',
						tokens: {
							input: 100,
							output: 50,
						},
					},
				})
			);

			const usage = parser.extractUsage(event!);
			expect(usage).not.toBeNull();
			expect(usage?.inputTokens).toBe(100);
			expect(usage?.outputTokens).toBe(50);
		});

		it('should return null when no usage stats', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'step_start', sessionID: 'sess-123' })
			);
			expect(parser.extractUsage(event!)).toBeNull();
		});

		it('should handle zero tokens', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'step_finish',
					part: {
						reason: 'stop',
						tokens: {
							input: 0,
							output: 0,
						},
					},
				})
			);

			const usage = parser.extractUsage(event!);
			expect(usage?.inputTokens).toBe(0);
			expect(usage?.outputTokens).toBe(0);
		});

		it('should default missing usage fields to zero', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'step_finish',
					part: {
						tokens: {},
					},
				})
			);

			expect(parser.extractUsage(event!)).toEqual({
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: 0,
			});
		});
	});

	describe('extractSlashCommands', () => {
		it('should return null - OpenCode may not support slash commands', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'step_start', sessionID: 'sess-123' })
			);
			expect(parser.extractSlashCommands(event!)).toBeNull();
		});

		it('should return slash commands already attached to an event', () => {
			expect(
				parser.extractSlashCommands({
					type: 'system',
					slashCommands: ['/help', '/clear'],
				})
			).toEqual(['/help', '/clear']);
		});
	});

	describe('detectErrorFromLine and detectErrorFromParsed', () => {
		it('should return null for empty, invalid JSON, and non-object inputs', () => {
			expect(parser.detectErrorFromLine('')).toBeNull();
			expect(parser.detectErrorFromLine('not json')).toBeNull();
			expect(parser.detectErrorFromParsed(null)).toBeNull();
			expect(parser.detectErrorFromParsed('error')).toBeNull();
		});

		it('should detect known errors from structured data messages and attach raw line', () => {
			const line = JSON.stringify({
				type: 'error',
				error: { data: { message: 'invalid api key' } },
			});

			const error = parser.detectErrorFromLine(line);

			expect(error).toMatchObject({
				type: 'auth_expired',
				message: 'Invalid API key. Please check your configuration.',
				recoverable: true,
				agentId: 'opencode',
			});
			expect(error?.raw).toMatchObject({ errorLine: line });
		});

		it('should detect known errors from direct error messages', () => {
			expect(
				parser.detectErrorFromParsed({
					type: 'error',
					error: { message: 'rate limit exceeded' },
				})
			).toMatchObject({
				type: 'rate_limited',
				message: 'Rate limit exceeded. Please wait.',
			});
		});

		it('should extract response body messages and return unknown when no pattern matches', () => {
			expect(
				parser.detectErrorFromParsed({
					type: 'error',
					error: {
						responseBody: {
							error: { message: 'unknown provider selected' },
						},
					},
				})
			).toMatchObject({
				type: 'unknown',
				message: 'unknown provider selected',
				recoverable: true,
			});
		});

		it('should detect simple string errors and unknown parsed errors', () => {
			expect(
				parser.detectErrorFromParsed({
					type: 'error',
					error: 'context length exceeded',
				})
			).toMatchObject({
				type: 'token_exhaustion',
			});

			expect(parser.detectErrorFromParsed({ error: 'custom provider exploded' })).toMatchObject({
				type: 'unknown',
				message: 'custom provider exploded',
				recoverable: true,
			});
		});

		it('should detect alternative type error message format', () => {
			expect(
				parser.detectErrorFromParsed({
					type: 'error',
					message: 'network unavailable',
				})
			).toMatchObject({
				type: 'network_error',
				message: 'Network error occurred. Please check your connection.',
			});
		});

		it('should return null when parsed JSON does not contain error text', () => {
			expect(parser.detectErrorFromParsed({ type: 'text', part: { text: 'ok' } })).toBeNull();
			expect(
				parser.detectErrorFromParsed({ type: 'error', error: { name: 'APIError' } })
			).toBeNull();
		});
	});

	describe('detectErrorFromExit', () => {
		it('should detect known patterns when OpenCode exits zero with only stderr', () => {
			expect(parser.detectErrorFromExit(0, 'rate limit exceeded', '')).toMatchObject({
				type: 'rate_limited',
				message: 'Rate limit exceeded. Please wait.',
				raw: {
					exitCode: 0,
					stderr: 'rate limit exceeded',
					stdout: '',
				},
			});
		});

		it('should extract a meaningful stderr line when zero exit has only unknown stderr', () => {
			const stderr = [
				'\u001b[31m847 | const provider = getProvider()',
				'const provider = config.provider',
				'provider.name = value',
				'{}',
				'Invalid provider selected for this workspace\u001b[0m',
			].join('\n');

			const error = parser.detectErrorFromExit(0, stderr, '');

			expect(error).toMatchObject({
				type: 'agent_crashed',
				message: 'OpenCode failed: Invalid provider selected for this workspace',
				recoverable: true,
			});
		});

		it('should use fallback stderr text when no error-like line exists', () => {
			const error = parser.detectErrorFromExit(0, 'plain explanatory message', '');

			expect(error?.message).toBe('OpenCode failed: plain explanatory message');
		});

		it('should use the secondary fallback for code-like stderr lines', () => {
			const error = parser.detectErrorFromExit(0, 'const provider = config.provider', '');

			expect(error?.message).toBe('OpenCode failed: const provider = config.provider');
		});

		it('should use the unknown fallback when stderr has no meaningful lines', () => {
			const error = parser.detectErrorFromExit(0, '1 | code\n{}\n;', '');

			expect(error?.message).toBe('OpenCode failed: Unknown error (check stderr)');
		});

		it('should return null for zero exit when stdout is present', () => {
			expect(parser.detectErrorFromExit(0, 'warning on stderr', 'normal output')).toBeNull();
		});

		it('should detect known patterns for non-zero exits', () => {
			expect(parser.detectErrorFromExit(1, 'fatal error: crashed', '')).toMatchObject({
				type: 'agent_crashed',
				message: 'An error occurred in the agent.',
			});
		});

		it('should report non-zero unknown exits with and without stderr previews', () => {
			expect(parser.detectErrorFromExit(2, 'first stderr line\nsecond', '')).toMatchObject({
				type: 'agent_crashed',
				message: 'Agent exited with code 2: first stderr line',
			});
			expect(parser.detectErrorFromExit(3, '', '')).toMatchObject({
				type: 'agent_crashed',
				message: 'Agent exited with code 3',
			});
		});
	});

	describe('edge cases', () => {
		it('should handle step_finish without reason', () => {
			// step_finish without reason defaults to system event
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'step_finish', sessionID: 'sess-123', part: {} })
			);
			expect(event?.type).toBe('system');
			expect(event?.sessionId).toBe('sess-123');
		});

		it('should handle step_finish with reason "stop" as system', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'step_finish', sessionID: 'sess-123', part: { reason: 'stop' } })
			);
			expect(event?.type).toBe('system');
			expect(event?.sessionId).toBe('sess-123');
		});

		it('should handle missing part.text', () => {
			const event = parser.parseJsonLine(JSON.stringify({ type: 'text', part: {} }));
			expect(event?.type).toBe('result');
			expect(event?.text).toBe('');
		});

		it('should handle missing part entirely', () => {
			const event = parser.parseJsonLine(JSON.stringify({ type: 'text' }));
			expect(event?.type).toBe('result');
			expect(event?.text).toBe('');
		});

		it('should handle missing tool info', () => {
			const event = parser.parseJsonLine(JSON.stringify({ type: 'tool_use', part: {} }));
			expect(event?.type).toBe('tool_use');
			expect(event?.toolName).toBeUndefined();
			expect(event?.toolState).toBeUndefined();
		});

		it('should handle messages without type', () => {
			const event = parser.parseJsonLine(JSON.stringify({ data: 'some data' }));
			expect(event?.type).toBe('system');
		});
	});
});
