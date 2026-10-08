import { describe, expect, it } from 'vitest';
import { PiOutputParser } from '../../../main/parsers/pi-output-parser';

describe('PiOutputParser', () => {
	const parser = new PiOutputParser();

	it('parses session initialization', () => {
		const event = parser.parseJsonObject({ type: 'session', id: 'pi-session-1' });

		expect(event).toMatchObject({ type: 'init', sessionId: 'pi-session-1' });
	});

	it('parses answer and thinking deltas separately', () => {
		const answer = parser.parseJsonObject({
			type: 'message_update',
			assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
		});
		const thinking = parser.parseJsonObject({
			type: 'message_update',
			assistantMessageEvent: { type: 'thinking_delta', delta: 'Checking' },
		});

		expect(answer).toMatchObject({ type: 'text', text: 'Hello', isPartial: true });
		expect(thinking).toMatchObject({
			type: 'text',
			text: 'Checking',
			isPartial: true,
			isReasoning: true,
		});
	});

	it('parses per-turn usage without ending the run', () => {
		const event = parser.parseJsonObject({
			type: 'message_end',
			message: {
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'internal' },
					{ type: 'text', text: 'Final answer' },
				],
				usage: {
					input: 12,
					output: 7,
					cacheRead: 3,
					cacheWrite: 2,
					cost: { total: 0.01 },
				},
			},
		});

		expect(event).toMatchObject({
			type: 'usage',
			usage: {
				inputTokens: 12,
				outputTokens: 7,
				cacheReadTokens: 3,
				cacheCreationTokens: 2,
				costUsd: 0.01,
			},
		});
		expect(parser.isResultMessage(event!)).toBe(false);
	});

	it('uses agent_end as the authoritative final result', () => {
		const event = parser.parseJsonObject({
			type: 'agent_end',
			messages: [
				{
					role: 'assistant',
					content: [{ type: 'text', text: 'Calling a tool' }],
				},
				{ role: 'toolResult', content: [{ type: 'text', text: 'tool output' }] },
				{
					role: 'assistant',
					content: [
						{ type: 'thinking', thinking: 'internal' },
						{ type: 'text', text: 'Final answer' },
					],
				},
			],
		});

		expect(event).toMatchObject({ type: 'result', text: 'Final answer' });
		expect(parser.isResultMessage(event!)).toBe(true);
	});

	it('does not treat an automatic retry cycle as the final result', () => {
		const event = parser.parseJsonObject({
			type: 'agent_end',
			willRetry: true,
			messages: [
				{
					role: 'assistant',
					content: [{ type: 'text', text: 'Transient failure response' }],
				},
			],
		});

		expect(event).toMatchObject({ type: 'system' });
		expect(parser.isResultMessage(event!)).toBe(false);
	});

	it('parses tool lifecycle events', () => {
		const start = parser.parseJsonObject({
			type: 'tool_execution_start',
			toolCallId: 'call-1',
			toolName: 'read',
			args: { path: 'README.md' },
		});
		const end = parser.parseJsonObject({
			type: 'tool_execution_end',
			toolCallId: 'call-1',
			toolName: 'read',
			result: 'contents',
			isError: false,
		});

		expect(start).toMatchObject({
			type: 'tool_use',
			toolCallId: 'call-1',
			toolName: 'read',
			toolState: { status: 'running', input: { path: 'README.md' } },
		});
		expect(end).toMatchObject({
			type: 'tool_use',
			toolState: { status: 'completed', output: 'contents' },
		});
	});

	it('detects structured and exit errors', () => {
		const structured = parser.detectErrorFromParsed({
			type: 'message_end',
			message: { errorMessage: 'invalid api key' },
		});
		const exit = parser.detectErrorFromExit(1, 'connection refused', '');

		expect(structured?.type).toBe('auth_expired');
		expect(exit?.type).toBe('network_error');
		expect(parser.detectErrorFromExit(0, '', 'ok')).toBeNull();
	});

	it('surfaces final agent errors instead of emitting a result', () => {
		const event = parser.parseJsonObject({
			type: 'agent_end',
			messages: [
				{
					role: 'assistant',
					content: [],
					errorMessage: 'rate limit exceeded',
				},
			],
		});

		expect(event).toMatchObject({ type: 'error', text: 'rate limit exceeded' });
	});

	it('preserves non-JSON output as text', () => {
		expect(parser.parseJsonLine('plain output')).toMatchObject({
			type: 'text',
			text: 'plain output',
		});
	});
});
