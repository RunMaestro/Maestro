import { describe, expect, it } from 'vitest';
import { ClaudeOutputParser } from '../../main/parsers/claude-output-parser';

describe('ClaudeOutputParser integration', () => {
	const parser = new ClaudeOutputParser();

	it('normalizes init, system, unknown, empty, invalid, and non-object inputs', () => {
		expect(parser.agentId).toBe('claude-code');
		expect(parser.parseJsonLine('')).toBeNull();
		expect(parser.parseJsonLine('  ')).toBeNull();
		expect(parser.parseJsonObject(null)).toBeNull();
		expect(parser.parseJsonObject('nope')).toBeNull();

		const invalid = parser.parseJsonLine('not valid json');
		expect(invalid).toEqual({
			type: 'text',
			text: 'not valid json',
			raw: 'not valid json',
		});

		const init = parser.parseJsonLine(
			JSON.stringify({
				type: 'system',
				subtype: 'init',
				session_id: 'sess-init',
				slash_commands: ['/help', '/compact'],
			})
		);
		expect(init).toEqual(
			expect.objectContaining({
				type: 'init',
				sessionId: 'sess-init',
				slashCommands: ['/help', '/compact'],
			})
		);
		expect(parser.extractSessionId(init!)).toBe('sess-init');
		expect(parser.extractSlashCommands(init!)).toEqual(['/help', '/compact']);
		expect(parser.isResultMessage(init!)).toBe(false);

		const system = parser.parseJsonObject({ type: 'system', session_id: 'sess-system' });
		expect(system).toEqual(expect.objectContaining({ type: 'system', sessionId: 'sess-system' }));

		const unknown = parser.parseJsonObject({ type: 'debug', session_id: 'sess-debug', ok: true });
		expect(unknown).toEqual(expect.objectContaining({ type: 'system', sessionId: 'sess-debug' }));
		expect(parser.extractUsage(unknown!)).toBeNull();
		expect(parser.extractSlashCommands(unknown!)).toBeNull();

		const noSession = parser.parseJsonObject({ type: 'system' });
		expect(noSession).toEqual(expect.objectContaining({ type: 'system', sessionId: undefined }));
		expect(parser.extractSessionId(noSession!)).toBeNull();
	});

	it('extracts result text, fallback text, usage, and usage-only events', () => {
		const result = parser.parseJsonLine(
			JSON.stringify({
				type: 'result',
				result: 'Final answer',
				session_id: 'sess-result',
				modelUsage: {
					'claude-sonnet': {
						inputTokens: 100,
						outputTokens: 50,
						cacheReadInputTokens: 20,
						cacheCreationInputTokens: 10,
						contextWindow: 200000,
					},
					'claude-haiku': {
						inputTokens: 200,
						outputTokens: 40,
					},
				},
				usage: {
					input_tokens: 75,
					output_tokens: 25,
					cache_read_input_tokens: 5,
					cache_creation_input_tokens: 3,
				},
				total_cost_usd: 0.04,
			})
		);
		expect(result).toEqual(
			expect.objectContaining({
				type: 'result',
				text: 'Final answer',
				sessionId: 'sess-result',
			})
		);
		expect(parser.isResultMessage(result!)).toBe(true);
		expect(parser.extractUsage(result!)).toEqual(
			expect.objectContaining({
				inputTokens: 200,
				outputTokens: 50,
				cacheReadTokens: 20,
				cacheCreationTokens: 10,
				contextWindow: 200000,
				costUsd: 0.04,
			})
		);

		const fallback = parser.parseJsonObject({
			type: 'result',
			session_id: 'sess-fallback',
			message: {
				content: [
					{ type: 'text', text: 'Recovered ' },
					{ type: 'thinking', thinking: 'hidden' },
					{ type: 'text', text: 'answer' },
				],
			},
		});
		expect(fallback).toEqual(
			expect.objectContaining({
				type: 'result',
				text: 'Recovered answer',
				sessionId: 'sess-fallback',
			})
		);

		const usageOnly = parser.parseJsonObject({
			session_id: 'sess-usage',
			usage: { input_tokens: 1, output_tokens: 2 },
			total_cost_usd: 0,
		});
		expect(usageOnly).toEqual(
			expect.objectContaining({
				type: 'usage',
				sessionId: 'sess-usage',
				usage: expect.objectContaining({ inputTokens: 1, outputTokens: 2, costUsd: 0 }),
			})
		);

		const modelUsageOnly = parser.parseJsonObject({
			session_id: 'sess-model-usage',
			modelUsage: {
				'claude-sonnet': {
					inputTokens: 3,
					outputTokens: 4,
				},
			},
		});
		expect(modelUsageOnly).toEqual(
			expect.objectContaining({
				type: 'usage',
				usage: expect.objectContaining({ inputTokens: 3, outputTokens: 4, costUsd: 0 }),
			})
		);
	});

	it('extracts assistant text, thinking chunks, and tool-use blocks', () => {
		const stringContent = parser.parseJsonObject({
			type: 'assistant',
			session_id: 'sess-string',
			message: { content: 'String response' },
		});
		expect(stringContent).toEqual(
			expect.objectContaining({
				type: 'text',
				text: 'String response',
				sessionId: 'sess-string',
				isPartial: true,
				toolUseBlocks: undefined,
			})
		);

		const richContent = parser.parseJsonObject({
			type: 'assistant',
			session_id: 'sess-rich',
			message: {
				content: [
					{ type: 'thinking', thinking: 'Analyze ' },
					{ type: 'redacted_thinking', signature: 'encrypted' },
					{ type: 'thinking', thinking: 'carefully.' },
					{ type: 'text', text: 'Visible text' },
					{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'a.ts' } },
					{ type: 'tool_use', id: 'tool-missing-name', input: { file: 'ignored.ts' } },
					{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } },
				],
			},
		});
		expect(richContent).toEqual(
			expect.objectContaining({
				type: 'text',
				text: 'Analyze carefully.',
				toolUseBlocks: [
					{ name: 'Read', id: 'tool-1', input: { file: 'a.ts' } },
					{ name: 'Bash', id: undefined, input: { command: 'pwd' } },
				],
			})
		);

		expect(
			parser.parseJsonObject({
				type: 'assistant',
				message: { content: [{ type: 'image', source: {} }] },
			})
		).toEqual(expect.objectContaining({ type: 'text', text: '', toolUseBlocks: undefined }));
		expect(parser.parseJsonObject({ type: 'assistant', message: {} })).toEqual(
			expect.objectContaining({ type: 'text', text: '' })
		);
	});

	it('detects structured and embedded JSON errors without matching ordinary text', () => {
		expect(parser.detectErrorFromLine('')).toBeNull();
		expect(parser.detectErrorFromLine('Rate limit exceeded')).toBeNull();
		expect(parser.detectErrorFromParsed(null)).toBeNull();
		expect(parser.detectErrorFromParsed({ type: 'result', result: 'ok' })).toBeNull();

		const authLine = JSON.stringify({ type: 'error', message: 'Invalid API key' });
		const auth = parser.detectErrorFromLine(authLine);
		expect(auth).toEqual(
			expect.objectContaining({
				type: 'auth_expired',
				agentId: 'claude-code',
				recoverable: true,
				raw: expect.objectContaining({ errorLine: authLine }),
			})
		);

		expect(parser.detectErrorFromParsed({ error: 'context is too long' })).toEqual(
			expect.objectContaining({ type: 'token_exhaustion' })
		);
		expect(
			parser.detectErrorFromParsed({
				type: 'turn_failed',
				error: { message: 'Connection failed while streaming' },
			})
		).toEqual(expect.objectContaining({ type: 'network_error' }));
		expect(
			parser.detectErrorFromParsed({
				type: 'turn.failed',
				error: { message: 'some novel provider error' },
			})
		).toEqual(expect.objectContaining({ type: 'unknown', message: 'some novel provider error' }));
		expect(
			parser.detectErrorFromParsed({
				error: { code: 'E_PROVIDER', detail: 'new provider failure' },
			})
		).toEqual(
			expect.objectContaining({
				type: 'unknown',
				message: '{"code":"E_PROVIDER","detail":"new provider failure"}',
			})
		);

		const embedded =
			'Error streaming: 400 {"type":"error","error":{"message":"prompt is too long: 206491 tokens > 200000 maximum"}}';
		expect(parser.detectErrorFromLine(embedded)).toEqual(
			expect.objectContaining({
				type: 'token_exhaustion',
				message: expect.stringContaining('206,491'),
				raw: { errorLine: embedded },
			})
		);
		expect(
			parser.detectErrorFromLine(
				'Error streaming: {"type":"error","message":"Rate limit exceeded"}'
			)
		).toEqual(expect.objectContaining({ type: 'rate_limited' }));
		expect(parser.detectErrorFromLine('Status: {"type":"notice","ok":true}')).toBeNull();
		expect(parser.detectErrorFromLine('Error streaming: {"type":"error"')).toBeNull();
		expect(
			parser.detectErrorFromLine(
				'Error streaming: {"type":"error","message":"novel provider failure"}'
			)
		).toBeNull();
	});

	it('detects exit-code errors through embedded JSON, stderr/stdout patterns, and crash fallback', () => {
		expect(parser.detectErrorFromExit(0, '', '')).toBeNull();

		const embedded =
			'Error streaming: 400 {"type":"error","error":{"message":"prompt is too long: 206491 tokens > 200000 maximum"}}';
		expect(parser.detectErrorFromExit(1, embedded, '')).toEqual(
			expect.objectContaining({
				type: 'token_exhaustion',
				raw: expect.objectContaining({ exitCode: 1, stderr: embedded, stdout: '' }),
			})
		);
		expect(parser.detectErrorFromExit(1, 'Invalid API key', '')).toEqual(
			expect.objectContaining({
				type: 'auth_expired',
				raw: expect.objectContaining({ stderr: 'Invalid API key' }),
			})
		);
		expect(parser.detectErrorFromExit(1, '', 'rate limit exceeded')).toEqual(
			expect.objectContaining({
				type: 'rate_limited',
				raw: expect.objectContaining({ stdout: 'rate limit exceeded' }),
			})
		);
		expect(
			parser.detectErrorFromExit(
				2,
				'Error streaming: {"type":"error","message":"novel provider failure"}',
				''
			)
		).toEqual(
			expect.objectContaining({ type: 'agent_crashed', message: 'Agent exited with code 2' })
		);
		expect(parser.detectErrorFromExit(127, 'unrecognized failure', '')).toEqual(
			expect.objectContaining({ type: 'agent_crashed', message: 'Agent exited with code 127' })
		);
	});
});
