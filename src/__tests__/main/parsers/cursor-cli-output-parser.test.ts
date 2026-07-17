import { describe, it, expect } from 'vitest';
import { CursorCliOutputParser } from '../../../main/parsers/cursor-cli-output-parser';

// Event lines captured from live `agent -p ... --output-format stream-json` runs.

const INIT_LINE =
	'{"type":"system","subtype":"init","apiKeySource":"login","cwd":"C:\\\\test","session_id":"160dac18-6ea0-43dd-8c25-5e82a2dc787d","model":"Composer 2.5 Fast","permissionMode":"default"}';

const THINKING_DELTA =
	'{"type":"thinking","subtype":"delta","text":"The user requested a","session_id":"160dac18-6ea0-43dd-8c25-5e82a2dc787d","timestamp_ms":1784174438858}';

const ASSISTANT_LINE =
	'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]},"session_id":"160dac18-6ea0-43dd-8c25-5e82a2dc787d"}';

const RESULT_LINE =
	'{"type":"result","subtype":"success","duration_ms":2282,"duration_api_ms":2282,"is_error":false,"result":"OK","session_id":"160dac18-6ea0-43dd-8c25-5e82a2dc787d","request_id":"f715cf78-b7ac-4075-883a-690908eeb16d","usage":{"inputTokens":18411,"outputTokens":131,"cacheReadTokens":5959,"cacheWriteTokens":0}}';

const PARTIAL_ASSISTANT_LINE =
	'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"RE"}]},"session_id":"160dac18-6ea0-43dd-8c25-5e82a2dc787d","timestamp_ms":1784174438859}';

const FINAL_ASSISTANT_FLUSH_LINE =
	'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"READY"}]},"session_id":"160dac18-6ea0-43dd-8c25-5e82a2dc787d"}';

describe('CursorCliOutputParser', () => {
	it('parses init events with session_id', () => {
		const parser = new CursorCliOutputParser();
		const event = parser.parseJsonLine(INIT_LINE);

		expect(event).toEqual(
			expect.objectContaining({
				type: 'init',
				sessionId: '160dac18-6ea0-43dd-8c25-5e82a2dc787d',
			})
		);
	});

	it('parses thinking delta events as partial reasoning text', () => {
		const parser = new CursorCliOutputParser();

		const event = parser.parseJsonLine(THINKING_DELTA);

		expect(event).toEqual(
			expect.objectContaining({
				type: 'text',
				text: 'The user requested a',
				isPartial: true,
				isReasoning: true,
			})
		);
	});

	it('parses assistant messages as partial text', () => {
		const parser = new CursorCliOutputParser();

		const event = parser.parseJsonLine(ASSISTANT_LINE);

		expect(event).toEqual(
			expect.objectContaining({
				type: 'text',
				text: 'OK',
				isPartial: true,
			})
		);
		expect(event?.isReasoning).toBeUndefined();
	});

	it('emits timestamped assistant deltas but skips the duplicate final flush', () => {
		const parser = new CursorCliOutputParser();

		expect(parser.parseJsonLine(PARTIAL_ASSISTANT_LINE)).toEqual(
			expect.objectContaining({
				type: 'text',
				text: 'RE',
				isPartial: true,
			})
		);
		expect(parser.parseJsonLine(FINAL_ASSISTANT_FLUSH_LINE)).toBeNull();
	});

	it('skips buffered pre-tool assistant flushes identified by model_call_id', () => {
		const parser = new CursorCliOutputParser();
		const event = parser.parseJsonLine(
			'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"READY"}]},"session_id":"sess-1","timestamp_ms":1,"model_call_id":"model-call-1"}'
		);

		expect(event).toBeNull();
	});

	it('normalizes Cursor tool-call start and completion events', () => {
		const parser = new CursorCliOutputParser();
		const started = parser.parseJsonLine(
			'{"type":"tool_call","subtype":"started","call_id":"tool-1","tool_call":{"readToolCall":{"args":{"path":"package.json","limit":20}},"toolCallId":"tool-1"},"session_id":"sess-1"}'
		);
		const completed = parser.parseJsonLine(
			'{"type":"tool_call","subtype":"completed","call_id":"tool-1","tool_call":{"readToolCall":{"args":{"path":"package.json","limit":20},"result":{"success":{"content":"{\\"name\\":\\"maestro\\"}"}}},"toolCallId":"tool-1"},"session_id":"sess-1"}'
		);

		expect(started).toEqual(
			expect.objectContaining({
				type: 'tool_use',
				toolName: 'read',
				toolCallId: 'tool-1',
				toolState: {
					status: 'running',
					input: { path: 'package.json', limit: 20 },
				},
			})
		);
		expect(completed).toEqual(
			expect.objectContaining({
				type: 'tool_use',
				toolName: 'read',
				toolCallId: 'tool-1',
				toolState: expect.objectContaining({
					status: 'completed',
					output: { content: '{"name":"maestro"}' },
				}),
			})
		);
	});

	it('normalizes generic function tool calls', () => {
		const parser = new CursorCliOutputParser();
		const event = parser.parseJsonLine(
			'{"type":"tool_call","subtype":"started","call_id":"tool-2","tool_call":{"function":{"name":"custom_search","arguments":"{\\"query\\":\\"cursor\\"}"}},"session_id":"sess-1"}'
		);

		expect(event).toEqual(
			expect.objectContaining({
				type: 'tool_use',
				toolName: 'custom_search',
				toolCallId: 'tool-2',
				toolState: {
					status: 'running',
					input: { query: 'cursor' },
				},
			})
		);
	});

	it('parses result events with usage and session id', () => {
		const parser = new CursorCliOutputParser();

		const event = parser.parseJsonLine(RESULT_LINE);

		expect(event).toEqual(
			expect.objectContaining({
				type: 'result',
				text: 'OK',
				sessionId: '160dac18-6ea0-43dd-8c25-5e82a2dc787d',
				usage: {
					inputTokens: 18411,
					outputTokens: 131,
					cacheReadTokens: 5959,
					cacheCreationTokens: 0,
				},
			})
		);
		expect(event && parser.isResultMessage(event)).toBe(true);
	});

	it('extracts session id from result events', () => {
		const parser = new CursorCliOutputParser();
		const event = parser.parseJsonLine(RESULT_LINE);

		expect(parser.extractSessionId(event!)).toBe('160dac18-6ea0-43dd-8c25-5e82a2dc787d');
	});

	it('returns null for empty lines and non-json input', () => {
		const parser = new CursorCliOutputParser();

		expect(parser.parseJsonLine('')).toBeNull();
		expect(parser.parseJsonLine('not json')).toBeNull();
	});

	it('detects auth errors from stderr via pattern bank', () => {
		const parser = new CursorCliOutputParser();

		const error = parser.detectErrorFromLine('Error: Not authenticated. Please run agent login');

		expect(error).toEqual(
			expect.objectContaining({
				type: 'auth_expired',
				recoverable: true,
				agentId: 'cursor-cli',
			})
		);
	});

	it('treats thinking completed events as system (not text)', () => {
		const parser = new CursorCliOutputParser();
		const event = parser.parseJsonLine(
			'{"type":"thinking","subtype":"completed","session_id":"160dac18-6ea0-43dd-8c25-5e82a2dc787d"}'
		);
		expect(event?.type).toBe('system');
	});

	it('maps is_error result events to AgentError', () => {
		const parser = new CursorCliOutputParser();
		const error = parser.detectErrorFromParsed({
			type: 'result',
			is_error: true,
			result: 'Not authenticated. Please run agent login',
			session_id: 'sess-err',
		});
		expect(error).toEqual(
			expect.objectContaining({
				type: 'auth_expired',
				agentId: 'cursor-cli',
			})
		);
	});

	it('parses is_error result events as errors for CLI batch spawning', () => {
		const parser = new CursorCliOutputParser();
		const event = parser.parseJsonObject({
			type: 'result',
			is_error: true,
			result: 'Unexpected Cursor failure',
			session_id: 'sess-err',
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'error',
				text: 'Unexpected Cursor failure',
				sessionId: 'sess-err',
			})
		);
		expect(event && parser.isResultMessage(event)).toBe(false);
	});

	it('detects agent crash from non-zero exit', () => {
		const parser = new CursorCliOutputParser();

		const error = parser.detectErrorFromExit(1, 'unexpected failure', '');

		expect(error).toEqual(
			expect.objectContaining({
				type: 'agent_crashed',
				recoverable: true,
				agentId: 'cursor-cli',
			})
		);
	});
});
