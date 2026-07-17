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
