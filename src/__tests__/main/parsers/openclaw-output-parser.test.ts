import { describe, it, expect } from 'vitest';
import { OpenClawOutputParser } from '../../../main/parsers/openclaw-output-parser';

const parser = new OpenClawOutputParser();

function makeStandardResult(overrides: Partial<any> = {}) {
	return {
		payloads: [{ text: 'Hello', mediaUrl: null }],
		meta: {
			durationMs: 123,
			agentMeta: {
				sessionId: 'session-1',
				provider: 'anthropic',
				model: 'claude-sonnet-4-6',
				usage: { input: 1, output: 2, cacheWrite: 3, total: 6 },
				lastCallUsage: { input: 1, output: 2, cacheRead: 4, cacheWrite: 3, total: 6 },
			},
		},
		...overrides,
	};
}

describe('OpenClawOutputParser', () => {
	describe('parseJsonLine', () => {
		it('should parse valid JSON', () => {
			const line = JSON.stringify(makeStandardResult());
			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event!.type).toBe('result');
			expect(event!.text).toBe('Hello');
		});

		it('should return null for invalid JSON', () => {
			expect(parser.parseJsonLine('{')).toBeNull();
		});

		it('should return null for empty string', () => {
			expect(parser.parseJsonLine('')).toBeNull();
			expect(parser.parseJsonLine('   \t  ')).toBeNull();
		});

		it('should return null for ANSI-only lines', () => {
			const ansiOnly = '\x1b[33m\x1b[39m';
			expect(parser.parseJsonLine(ansiOnly)).toBeNull();
			expect(parser.parseJsonLine(`${ansiOnly}\n`)).toBeNull();
		});
	});

	describe('parseJsonObject', () => {
		it('should parse standard OpenClaw --json result', () => {
			const event = parser.parseJsonObject(makeStandardResult());
			expect(event).not.toBeNull();
			expect(event!.type).toBe('result');
			expect(event!.text).toBe('Hello');
			expect(event!.sessionId).toBe('session-1');
		});

		it('should parse wrapped OpenClaw CLI result objects', () => {
			const wrapped = {
				runId: 'run-1',
				status: 'ok',
				summary: 'completed',
				result: makeStandardResult({
					payloads: [{ text: 'Wrapped hello', mediaUrl: null }],
				}),
			};
			const event = parser.parseJsonObject(wrapped);
			expect(event).not.toBeNull();
			expect(event!.type).toBe('result');
			expect(event!.text).toBe('Wrapped hello');
			expect(event!.sessionId).toBe('session-1');
			expect(event!.raw).toEqual(wrapped);
		});

		it('should parse error event', () => {
			const event = parser.parseJsonObject({ type: 'error', message: 'Boom' });
			expect(event).not.toBeNull();
			expect(event!.type).toBe('error');
			expect(event!.text).toBe('Boom');
		});

		it('should return null for unrecognized structure', () => {
			expect(parser.parseJsonObject({ foo: 'bar' })).toBeNull();
		});

		it('should return null for null/undefined input', () => {
			expect(parser.parseJsonObject(null)).toBeNull();
			expect(parser.parseJsonObject(undefined)).toBeNull();
		});
	});

	describe('parseOpenClawResult (via parseJsonObject)', () => {
		it('should support single payload', () => {
			const event = parser.parseJsonObject(
				makeStandardResult({
					payloads: [{ text: 'Single', mediaUrl: null }],
				})
			);
			expect(event).not.toBeNull();
			expect(event!.type).toBe('result');
			expect(event!.text).toBe('Single');
		});

		it('should concatenate multiple payloads with newline', () => {
			const event = parser.parseJsonObject(
				makeStandardResult({
					payloads: [
						{ text: 'First', mediaUrl: null },
						{ text: 'Second', mediaUrl: null },
					],
				})
			);
			expect(event).not.toBeNull();
			expect(event!.type).toBe('result');
			expect(event!.text).toBe('First\nSecond');
		});

		it('should tolerate missing agentMeta fields', () => {
			const result = makeStandardResult({
				meta: {
					durationMs: 1,
				},
			});
			const event = parser.parseJsonObject(result);
			expect(event).not.toBeNull();
			expect(event!.type).toBe('result');
			expect(event!.sessionId).toBeUndefined();
			expect(event!.usage).toBeUndefined();
			expect(event!.text).toBe('Hello');
		});

		it('should handle empty payloads array', () => {
			const event = parser.parseJsonObject(
				makeStandardResult({
					payloads: [],
				})
			);
			expect(event).not.toBeNull();
			expect(event!.type).toBe('result');
			expect(event!.text).toBe('');
		});
	});

	describe('isResultMessage', () => {
		it('should return true for result and false for non-result', () => {
			const resultEvent = parser.parseJsonObject(makeStandardResult())!;
			const errorEvent = parser.parseJsonObject({ type: 'error', message: 'Nope' })!;
			expect(parser.isResultMessage(resultEvent)).toBe(true);
			expect(parser.isResultMessage(errorEvent)).toBe(false);
		});
	});

	describe('extractSessionId', () => {
		it('should return sessionId when present', () => {
			const event = parser.parseJsonObject(makeStandardResult())!;
			expect(parser.extractSessionId(event)).toBe('session-1');
		});

		it('should return null when missing', () => {
			const event = parser.parseJsonObject(
				makeStandardResult({
					meta: { durationMs: 1, agentMeta: undefined },
				})
			)!;
			expect(parser.extractSessionId(event)).toBeNull();
		});
	});

	describe('extractUsage', () => {
		it('should return full usage when available', () => {
			const event = parser.parseJsonObject(makeStandardResult())!;
			const usage = parser.extractUsage(event);
			expect(usage).not.toBeNull();
			expect(usage!.inputTokens).toBe(1);
			expect(usage!.outputTokens).toBe(2);
			expect(usage!.cacheCreationTokens).toBe(3);
			expect(usage!.cacheReadTokens).toBe(4);
		});

		it('should return partial usage when cacheWrite missing', () => {
			const event = parser.parseJsonObject(
				makeStandardResult({
					meta: {
						durationMs: 1,
						agentMeta: {
							sessionId: 'session-2',
							provider: 'anthropic',
							model: 'claude-sonnet-4-6',
							usage: { input: 10, output: 20 },
							lastCallUsage: { cacheRead: 7 },
						},
					},
				})
			)!;

			const usage = parser.extractUsage(event);
			expect(usage).not.toBeNull();
			expect(usage!.inputTokens).toBe(10);
			expect(usage!.outputTokens).toBe(20);
			expect(usage!.cacheCreationTokens).toBeUndefined();
			expect(usage!.cacheReadTokens).toBe(7);
		});

		it('should preserve zeros for input/output and coerce cache zeros to undefined', () => {
			const event = parser.parseJsonObject(
				makeStandardResult({
					meta: {
						durationMs: 1,
						agentMeta: {
							sessionId: 'session-3',
							provider: 'anthropic',
							model: 'claude-sonnet-4-6',
							usage: { input: 0, output: 0, cacheWrite: 0, total: 0 },
							lastCallUsage: { cacheRead: 0 },
						},
					},
				})
			)!;

			const usage = parser.extractUsage(event);
			expect(usage).not.toBeNull();
			expect(usage!.inputTokens).toBe(0);
			expect(usage!.outputTokens).toBe(0);
			expect(usage!.cacheCreationTokens).toBeUndefined();
			expect(usage!.cacheReadTokens).toBeUndefined();
		});
	});

	describe('detectErrorFromLine', () => {
		it('should detect auth_expired', () => {
			const error = parser.detectErrorFromLine('gateway token invalid');
			expect(error).not.toBeNull();
			expect(error!.type).toBe('auth_expired');
			expect(error!.recoverable).toBe(true);
		});

		it('should detect rate_limited', () => {
			const error = parser.detectErrorFromLine('too many requests (429)');
			expect(error).not.toBeNull();
			expect(error!.type).toBe('rate_limited');
			expect(error!.recoverable).toBe(true);
		});

		it('should detect network_error', () => {
			const error = parser.detectErrorFromLine('gateway unreachable');
			expect(error).not.toBeNull();
			expect(error!.type).toBe('network_error');
			expect(error!.recoverable).toBe(true);
		});

		it('should detect permission_denied', () => {
			const error = parser.detectErrorFromLine('SYSTEM_RUN_DENIED: /usr/bin/rm');
			expect(error).not.toBeNull();
			expect(error!.type).toBe('permission_denied');
			expect(error!.recoverable).toBe(false);
		});

		it('should detect agent_crashed', () => {
			const error = parser.detectErrorFromLine('unhandled error: something exploded');
			expect(error).not.toBeNull();
			expect(error!.type).toBe('agent_crashed');
			expect(error!.recoverable).toBe(true);
		});

		it('should detect session_not_found', () => {
			const error = parser.detectErrorFromLine('invalid session');
			expect(error).not.toBeNull();
			expect(error!.type).toBe('session_not_found');
			expect(error!.recoverable).toBe(true);
		});

		it('should detect token_exhaustion', () => {
			const error = parser.detectErrorFromLine('prompt too long');
			expect(error).not.toBeNull();
			expect(error!.type).toBe('token_exhaustion');
			expect(error!.recoverable).toBe(true);
		});
	});

	describe('detectErrorFromParsed', () => {
		it('should return agent_crashed for error type event', () => {
			const error = parser.detectErrorFromParsed({
				type: 'error',
				message: 'Something went wrong',
			});
			expect(error).not.toBeNull();
			expect(error!.type).toBe('agent_crashed');
			expect(error!.message).toBe('Something went wrong');
			expect(error!.recoverable).toBe(true);
		});

		it('should return null for non-error event', () => {
			expect(parser.detectErrorFromParsed({ type: 'result' })).toBeNull();
		});

		it('should return null for null input', () => {
			expect(parser.detectErrorFromParsed(null)).toBeNull();
		});
	});

	describe('detectErrorFromExit', () => {
		it('should return null for exit 0', () => {
			expect(parser.detectErrorFromExit(0, '', '')).toBeNull();
		});

		it('should return matched error when stderr contains patterns', () => {
			const stderr = '\x1b[31mError:\x1b[0m rate limit exceeded';
			const error = parser.detectErrorFromExit(1, stderr, '');
			expect(error).not.toBeNull();
			expect(error!.type).toBe('rate_limited');
		});

		it('should return agent_crashed for exit 1 without stderr', () => {
			const error = parser.detectErrorFromExit(1, '', '');
			expect(error).not.toBeNull();
			expect(error!.type).toBe('agent_crashed');
			expect(error!.recoverable).toBe(true);
		});

		it('should return agent_crashed for exit 1 with stderr that does not match patterns', () => {
			const error = parser.detectErrorFromExit(1, 'some random stderr', '');
			expect(error).not.toBeNull();
			expect(error!.type).toBe('agent_crashed');
			expect(error!.recoverable).toBe(true);
		});

		it('should return non-recoverable agent_crashed for exit code > 1', () => {
			const error = parser.detectErrorFromExit(2, '', '');
			expect(error).not.toBeNull();
			expect(error!.type).toBe('agent_crashed');
			expect(error!.recoverable).toBe(false);
		});
	});
});
