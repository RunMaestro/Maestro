import { describe, it, expect } from 'vitest';
import type { ParsedEvent } from '../../../main/parsers/agent-output-parser';
import { FactoryDroidOutputParser } from '../../../main/parsers/factory-droid-output-parser';

describe('FactoryDroidOutputParser', () => {
	const parser = new FactoryDroidOutputParser();

	describe('agentId', () => {
		it('identifies Factory Droid output', () => {
			expect(parser.agentId).toBe('factory-droid');
		});
	});

	describe('parseJsonLine', () => {
		it('ignores empty lines', () => {
			expect(parser.parseJsonLine('')).toBeNull();
			expect(parser.parseJsonLine('  ')).toBeNull();
			expect(parser.parseJsonLine('\n')).toBeNull();
		});

		it('parses init system events with session ids', () => {
			const raw = {
				type: 'system',
				subtype: 'init',
				session_id: 'factory-session-1',
				model: 'droid-pro',
			};

			const event = parser.parseJsonLine(JSON.stringify(raw));

			expect(event).toEqual({
				type: 'init',
				sessionId: 'factory-session-1',
				raw,
			});
		});

		it('parses non-init system events as system metadata', () => {
			const raw = {
				type: 'system',
				session_id: 'factory-session-2',
				cwd: '/repo',
			};

			const event = parser.parseJsonLine(JSON.stringify(raw));

			expect(event).toEqual({
				type: 'system',
				sessionId: 'factory-session-2',
				raw,
			});
		});

		it('parses assistant messages as partial text', () => {
			const raw = {
				type: 'message',
				role: 'assistant',
				text: 'Working through the plan',
				session_id: 'factory-session-3',
			};

			const event = parser.parseJsonLine(JSON.stringify(raw));

			expect(event).toEqual({
				type: 'text',
				text: 'Working through the plan',
				isPartial: true,
				raw,
			});
		});

		it('parses user echoes as system events', () => {
			const raw = {
				type: 'message',
				role: 'user',
				text: 'Build it',
				session_id: 'factory-session-4',
			};

			const event = parser.parseJsonLine(JSON.stringify(raw));

			expect(event).toEqual({
				type: 'system',
				raw,
			});
		});

		it('drops message events without user-visible text', () => {
			expect(
				parser.parseJsonObject({
					type: 'message',
					role: 'assistant',
				})
			).toBeNull();
			expect(
				parser.parseJsonObject({
					type: 'message',
					role: 'user',
					text: '',
				})
			).toBeNull();
		});

		it('parses completion events with usage statistics', () => {
			const raw = {
				type: 'completion',
				finalText: 'Done',
				session_id: 'factory-session-5',
				usage: {
					input_tokens: 100,
					output_tokens: 25,
					cache_read_input_tokens: 12,
					cache_creation_input_tokens: 6,
					thinking_tokens: 3,
				},
			};

			const event = parser.parseJsonLine(JSON.stringify(raw));

			expect(event).toEqual({
				type: 'result',
				text: 'Done',
				sessionId: 'factory-session-5',
				usage: {
					inputTokens: 100,
					outputTokens: 25,
					cacheReadTokens: 12,
					cacheCreationTokens: 6,
					reasoningTokens: 3,
				},
				raw,
			});
		});

		it('defaults missing completion text and usage fields', () => {
			const raw = {
				type: 'completion',
				session_id: 'factory-session-6',
				usage: {},
			};

			const event = parser.parseJsonLine(JSON.stringify(raw));

			expect(event).toEqual({
				type: 'result',
				text: '',
				sessionId: 'factory-session-6',
				usage: {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					reasoningTokens: 0,
				},
				raw,
			});
		});

		it('leaves usage undefined when completion has no usage payload', () => {
			const raw = {
				type: 'completion',
				finalText: 'No usage here',
			};

			const event = parser.parseJsonLine(JSON.stringify(raw));

			expect(event).toEqual({
				type: 'result',
				text: 'No usage here',
				sessionId: undefined,
				usage: undefined,
				raw,
			});
		});

		it('parses error events from string and object payloads', () => {
			expect(
				parser.parseJsonObject({
					type: 'error',
					error: 'connection failed',
				})
			).toMatchObject({
				type: 'error',
				text: 'connection failed',
			});

			expect(
				parser.parseJsonObject({
					type: 'error',
					error: { data: { message: 'nested failure' }, message: 'outer failure' },
				})
			).toMatchObject({
				type: 'error',
				text: 'nested failure',
			});

			expect(
				parser.parseJsonObject({
					type: 'error',
					error: { message: 'direct failure' },
				})
			).toMatchObject({
				type: 'error',
				text: 'direct failure',
			});

			expect(
				parser.parseJsonObject({
					type: 'error',
					error: {},
				})
			).toMatchObject({
				type: 'error',
				text: 'Unknown error',
			});

			expect(parser.parseJsonObject({ type: 'error' })).toMatchObject({
				type: 'error',
				text: '',
			});
		});

		it('returns text events for invalid JSON and non-Factory JSON', () => {
			expect(parser.parseJsonLine('not json')).toEqual({
				type: 'text',
				text: 'not json',
				isPartial: true,
				raw: 'not json',
			});

			expect(parser.parseJsonLine(JSON.stringify({ event: 'ignored' }))).toEqual({
				type: 'text',
				text: '{"event":"ignored"}',
				isPartial: true,
				raw: { event: 'ignored' },
			});

			expect(parser.parseJsonLine('42')).toEqual({
				type: 'text',
				text: '42',
				isPartial: true,
				raw: 42,
			});
		});
	});

	describe('parseJsonObject', () => {
		it('returns null for invalid objects', () => {
			expect(parser.parseJsonObject(null)).toBeNull();
			expect(parser.parseJsonObject('text')).toBeNull();
			expect(parser.parseJsonObject({})).toBeNull();
			expect(parser.parseJsonObject({ type: 'unknown' })).toBeNull();
		});
	});

	describe('event helpers', () => {
		it('recognizes result events and raw completion events', () => {
			expect(parser.isResultMessage({ type: 'result' })).toBe(true);
			expect(
				parser.isResultMessage({
					type: 'system',
					raw: { type: 'completion' },
				})
			).toBe(true);
			expect(parser.isResultMessage({ type: 'system' })).toBe(false);
		});

		it('extracts session ids from normalized and raw events', () => {
			expect(parser.extractSessionId({ type: 'result', sessionId: 'normalized' })).toBe(
				'normalized'
			);
			expect(
				parser.extractSessionId({
					type: 'system',
					raw: { session_id: 'raw-session' },
				})
			).toBe('raw-session');
			expect(parser.extractSessionId({ type: 'system' })).toBeNull();
		});

		it('extracts usage and returns no slash commands', () => {
			const usage: ParsedEvent['usage'] = {
				inputTokens: 1,
				outputTokens: 2,
			};

			expect(parser.extractUsage({ type: 'result', usage })).toBe(usage);
			expect(parser.extractUsage({ type: 'system' })).toBeNull();
			expect(parser.extractSlashCommands({ type: 'init' })).toBeNull();
		});
	});

	describe('detectErrorFromLine', () => {
		it('ignores empty and non-JSON output', () => {
			expect(parser.detectErrorFromLine('')).toBeNull();
			expect(parser.detectErrorFromLine('not json')).toBeNull();
		});

		it('detects known errors and preserves the source line', () => {
			const line = JSON.stringify({
				type: 'error',
				error: 'FACTORY_API_KEY is required',
			});

			const error = parser.detectErrorFromLine(line);

			expect(error).toMatchObject({
				type: 'auth_expired',
				message: 'Factory API key not set. Please set FACTORY_API_KEY environment variable.',
				recoverable: true,
				agentId: 'factory-droid',
				raw: { errorLine: line },
			});
			expect(error?.timestamp).toEqual(expect.any(Number));
			expect(error?.parsedJson).toEqual({
				type: 'error',
				error: 'FACTORY_API_KEY is required',
			});
		});
	});

	describe('detectErrorFromParsed', () => {
		it('returns null when parsed data does not contain an error message', () => {
			expect(parser.detectErrorFromParsed(null)).toBeNull();
			expect(parser.detectErrorFromParsed('text')).toBeNull();
			expect(parser.detectErrorFromParsed({ type: 'message', text: 'ok' })).toBeNull();
			expect(parser.detectErrorFromParsed({ type: 'error' })).toBeNull();
			expect(parser.detectErrorFromParsed({ type: 'error', error: {} })).toBeNull();
		});

		it('detects nested and direct object error messages', () => {
			expect(
				parser.detectErrorFromParsed({
					type: 'error',
					error: { data: { message: 'prompt too long for context' } },
				})
			).toMatchObject({
				type: 'token_exhaustion',
				message: 'Prompt is too long. Try a shorter message or start a new session.',
				recoverable: true,
			});

			expect(
				parser.detectErrorFromParsed({
					type: 'error',
					error: { message: 'permission denied opening file' },
				})
			).toMatchObject({
				type: 'permission_denied',
				message: 'Permission denied. The agent cannot access the requested resource.',
				recoverable: false,
			});
		});

		it('returns unknown recoverable errors for unmatched messages', () => {
			const raw = {
				type: 'error',
				error: 'something novel happened',
			};

			expect(parser.detectErrorFromParsed(raw)).toMatchObject({
				type: 'unknown',
				message: 'something novel happened',
				recoverable: true,
				agentId: 'factory-droid',
				parsedJson: raw,
			});
		});
	});

	describe('detectErrorFromExit', () => {
		it('ignores successful exits', () => {
			expect(parser.detectErrorFromExit(0, 'ignored', 'ignored')).toBeNull();
		});

		it('matches known stderr and stdout errors', () => {
			expect(parser.detectErrorFromExit(1, 'rate limit reached', '')).toMatchObject({
				type: 'rate_limited',
				message: 'Rate limit exceeded. Please wait before trying again.',
				recoverable: true,
				raw: { exitCode: 1, stderr: 'rate limit reached', stdout: '' },
			});

			expect(parser.detectErrorFromExit(1, '', 'network unavailable')).toMatchObject({
				type: 'network_error',
				message: 'Network error occurred. Please check your connection.',
				recoverable: true,
				raw: { exitCode: 1, stderr: '', stdout: 'network unavailable' },
			});
		});

		it('reports unmatched non-zero exits with stderr preview when available', () => {
			expect(
				parser.detectErrorFromExit(7, 'first failure line\nsecond line', 'stdout')
			).toMatchObject({
				type: 'agent_crashed',
				message: 'Factory Droid exited with code 7: first failure line',
				recoverable: true,
				raw: { exitCode: 7, stderr: 'first failure line\nsecond line', stdout: 'stdout' },
			});

			expect(parser.detectErrorFromExit(9, '', 'stdout only')).toMatchObject({
				type: 'agent_crashed',
				message: 'Factory Droid exited with code 9',
				recoverable: true,
				raw: { exitCode: 9, stderr: '', stdout: 'stdout only' },
			});
		});
	});
});
