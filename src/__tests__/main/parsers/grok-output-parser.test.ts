import { describe, it, expect } from 'vitest';
import { GrokOutputParser } from '../../../main/parsers/grok-output-parser';

// All event lines below are copied verbatim from real captured fixtures
// (grok v0.2.93, `--output-format streaming-json`):
// Working/grok-simple-turn.jsonl, Working/grok-tool-use.jsonl,
// Working/grok-resume.jsonl, and Working/grok-error-bad-model.txt in the
// Phase 01 Auto Run folder. Grok's stream has exactly four event types
// (thought, text, end, error); there is no init event, no tool_use event,
// and no usage/cost data in the stream.

const SIMPLE_TURN_END_LINE =
	'{"type":"end","stopReason":"EndTurn","sessionId":"019f47fa-e297-7993-a1f6-adfaf940ba8c","requestId":"b860c3ae-0e8c-4cc4-b478-01d4ba187c9a"}';

const RESUME_END_LINE =
	'{"type":"end","stopReason":"EndTurn","sessionId":"019f47fb-2316-7f21-98db-55907d4ddb60","requestId":"1194fbc9-a074-4819-a625-d087cee7226c"}';

const BAD_MODEL_ERROR_LINE =
	'{"type":"error","message":"Couldn\'t set model \'nonexistent-model-xyz\': Invalid params: \\"unknown model id\\". Run \'grok models\' to see available models."}';

const BAD_MODEL_STDERR =
	"Error: Couldn't set model 'nonexistent-model-xyz': Invalid params: \"unknown model id\". Run 'grok models' to see available models.";

// Verbatim stderr from `grok -p "hi" --resume 00000000-0000-0000-0000-000000000000
// --output-format streaming-json` (Working/grok-error-bad-resume.txt). Stdout is
// EMPTY for this failure (no JSON error event), so only detectErrorFromExit can
// catch it. A transient spinner line between the two is elided.
const BAD_RESUME_STDERR =
	'Session 00000000-0000-0000-0000-000000000000 not found locally, restoring from remote...\n' +
	'Error: Failed to restore session from remote: fetching session record: session get failed: 404 Not Found';

describe('GrokOutputParser', () => {
	it('parses text delta events as partial text events', () => {
		const parser = new GrokOutputParser();

		// From Working/grok-simple-turn.jsonl
		const event = parser.parseJsonLine('{"type":"text","data":"Hello"}');

		expect(event).toEqual(
			expect.objectContaining({
				type: 'text',
				text: 'Hello',
				isPartial: true,
			})
		);
		expect(event?.isReasoning).toBeUndefined();
		expect(event && parser.isResultMessage(event)).toBe(false);
	});

	it('concatenates cleanly across consecutive text deltas (whitespace embedded in payloads)', () => {
		const parser = new GrokOutputParser();

		// Consecutive lines from Working/grok-tool-use.jsonl
		const deltas = [
			'{"type":"text","data":"Created"}',
			'{"type":"text","data":" `"}',
			'{"type":"text","data":"hello"}',
			'{"type":"text","data":".txt"}',
			'{"type":"text","data":"`"}',
		];

		const text = deltas.map((line) => parser.parseJsonLine(line)?.text).join('');
		expect(text).toBe('Created `hello.txt`');
	});

	it('tags thought delta events with isReasoning for the ThinkingMode lifecycle', () => {
		const parser = new GrokOutputParser();

		// From Working/grok-simple-turn.jsonl
		const event = parser.parseJsonLine('{"type":"thought","data":"The"}');

		expect(event).toEqual(
			expect.objectContaining({
				type: 'text',
				text: 'The',
				isPartial: true,
				isReasoning: true,
			})
		);
		expect(event && parser.isResultMessage(event)).toBe(false);
	});

	it('drops empty-payload thought and text deltas', () => {
		const parser = new GrokOutputParser();

		expect(parser.parseJsonLine('{"type":"text","data":""}')).toBeNull();
		expect(parser.parseJsonLine('{"type":"thought","data":""}')).toBeNull();
		expect(parser.parseJsonLine('{"type":"text"}')).toBeNull();
	});

	it('parses the end event as a result event', () => {
		const parser = new GrokOutputParser();

		const event = parser.parseJsonLine(SIMPLE_TURN_END_LINE);

		expect(event).toEqual(
			expect.objectContaining({
				type: 'result',
				sessionId: '019f47fa-e297-7993-a1f6-adfaf940ba8c',
			})
		);
		expect(event && parser.isResultMessage(event)).toBe(true);
	});

	it('extracts the session ID from the result event (grok has no init event)', () => {
		// The session ID appears ONLY on the final `end` event, so extraction
		// must work on the result event rather than an init event.
		const parser = new GrokOutputParser();

		const event = parser.parseJsonLine(SIMPLE_TURN_END_LINE);
		expect(event && parser.extractSessionId(event)).toBe('019f47fa-e297-7993-a1f6-adfaf940ba8c');

		// Deltas carry no session ID
		const delta = parser.parseJsonLine('{"type":"text","data":"Hello"}');
		expect(delta && parser.extractSessionId(delta)).toBeNull();
	});

	it('extracts the same session ID from a resumed turn', () => {
		// From Working/grok-resume.jsonl - resume preserves the sessionId of the
		// resumed session in its end event.
		const parser = new GrokOutputParser();

		const event = parser.parseJsonLine(RESUME_END_LINE);
		expect(event && parser.extractSessionId(event)).toBe('019f47fb-2316-7f21-98db-55907d4ddb60');
	});

	it('emits no tool_use events - tool turns stream only thought/text/end lines', () => {
		// Verified in Working/grok-tool-use.jsonl: the turn created and read a
		// file, yet zero tool events appeared on stdout. Tool telemetry lives
		// only in the on-disk session files (Phase 02 material).
		const parser = new GrokOutputParser();

		// Representative lines from Working/grok-tool-use.jsonl
		const toolTurnLines = [
			'{"type":"thought","data":"Now"}',
			'{"type":"thought","data":" read"}',
			'{"type":"thought","data":" it"}',
			'{"type":"thought","data":" back"}',
			'{"type":"text","data":"Created"}',
			'{"type":"end","stopReason":"EndTurn","sessionId":"019f47fb-2316-7f21-98db-55907d4ddb60","requestId":"1194fbc9-a074-4819-a625-d087cee7226c"}',
		];

		const events = toolTurnLines.map((line) => parser.parseJsonLine(line));
		expect(events.every((e) => e !== null && e.type !== 'tool_use')).toBe(true);
	});

	it('reports no usage - the grok stream carries no token or cost data', () => {
		const parser = new GrokOutputParser();

		const result = parser.parseJsonLine(SIMPLE_TURN_END_LINE);
		expect(result && parser.extractUsage(result)).toBeNull();

		const delta = parser.parseJsonLine('{"type":"text","data":"Hello"}');
		expect(delta && parser.extractUsage(delta)).toBeNull();
	});

	it('maps unknown event types to system events', () => {
		const parser = new GrokOutputParser();

		const event = parser.parseJsonLine('{"type":"future_event","data":"something new"}');
		expect(event).toEqual(expect.objectContaining({ type: 'system' }));
		expect(event && parser.isResultMessage(event)).toBe(false);
	});

	it('parses error events and classifies the verified bad-model failure', () => {
		const parser = new GrokOutputParser();

		// From Working/grok-error-bad-model.txt (stdout, streaming-json)
		const event = parser.parseJsonLine(BAD_MODEL_ERROR_LINE);
		expect(event).toEqual(
			expect.objectContaining({
				type: 'error',
				text: expect.stringContaining('unknown model id'),
			})
		);

		const error = parser.detectErrorFromLine(BAD_MODEL_ERROR_LINE);
		expect(error).toEqual(
			expect.objectContaining({
				type: 'agent_crashed',
				message: expect.stringContaining('grok models'),
				recoverable: true,
				agentId: 'grok',
			})
		);
	});

	it('detects auth_expired errors', () => {
		const parser = new GrokOutputParser();

		const error = parser.detectErrorFromParsed({
			type: 'error',
			message: 'Not authenticated. Run grok login to continue.',
		});

		expect(error).toEqual(
			expect.objectContaining({
				type: 'auth_expired',
				recoverable: true,
				agentId: 'grok',
			})
		);
	});

	it('detects rate_limited errors', () => {
		const parser = new GrokOutputParser();

		const error = parser.detectErrorFromParsed({
			type: 'error',
			message: 'Rate limit exceeded, please slow down.',
		});

		expect(error).toEqual(
			expect.objectContaining({
				type: 'rate_limited',
				recoverable: true,
				agentId: 'grok',
			})
		);
	});

	it('detects token_exhaustion errors', () => {
		const parser = new GrokOutputParser();

		const error = parser.detectErrorFromParsed({
			type: 'error',
			message: 'Context window exceeded for this session.',
		});

		expect(error).toEqual(
			expect.objectContaining({
				type: 'token_exhaustion',
				recoverable: true,
				agentId: 'grok',
			})
		);
	});

	it('detects network_error errors', () => {
		const parser = new GrokOutputParser();

		const error = parser.detectErrorFromParsed({
			type: 'error',
			message: 'fetch failed: ECONNREFUSED 127.0.0.1:443',
		});

		expect(error).toEqual(
			expect.objectContaining({
				type: 'network_error',
				recoverable: true,
				agentId: 'grok',
			})
		);
	});

	it('falls back to a recoverable unknown error for unmatched error messages', () => {
		const parser = new GrokOutputParser();

		const error = parser.detectErrorFromParsed({
			type: 'error',
			message: 'Something entirely novel went wrong.',
		});

		expect(error).toEqual(
			expect.objectContaining({
				type: 'unknown',
				message: 'Something entirely novel went wrong.',
				recoverable: true,
				agentId: 'grok',
			})
		);
	});

	it('does not treat non-error event types as agent errors', () => {
		const parser = new GrokOutputParser();

		expect(
			parser.detectErrorFromParsed({ type: 'thought', data: 'error handling strategy' })
		).toBeNull();
		expect(parser.detectErrorFromParsed({ type: 'text', data: 'An error occurred' })).toBeNull();
		expect(parser.detectErrorFromLine(SIMPLE_TURN_END_LINE)).toBeNull();
	});

	it('ignores error events with an empty message', () => {
		const parser = new GrokOutputParser();

		expect(parser.detectErrorFromParsed({ type: 'error' })).toBeNull();
		expect(parser.detectErrorFromParsed({ type: 'error', message: '   ' })).toBeNull();
	});

	it('classifies exit failures from the duplicated stderr message', () => {
		// Grok duplicates its error on stderr as `Error: <message>` and exits 1
		// (verified in Working/grok-error-bad-model.txt).
		const parser = new GrokOutputParser();

		const error = parser.detectErrorFromExit(1, BAD_MODEL_STDERR, '');

		expect(error).toEqual(
			expect.objectContaining({
				type: 'agent_crashed',
				message: expect.stringContaining('grok models'),
				agentId: 'grok',
			})
		);
	});

	it('classifies a failed --resume as session_not_found from stderr alone', () => {
		// Grok emits nothing on stdout when the resumed session does not exist,
		// so the exit path must classify the stderr text (see BAD_RESUME_STDERR).
		const parser = new GrokOutputParser();

		const error = parser.detectErrorFromExit(1, BAD_RESUME_STDERR, '');

		expect(error).toEqual(
			expect.objectContaining({
				type: 'session_not_found',
				recoverable: true,
				agentId: 'grok',
			})
		);
	});

	it('classifies the standalone "session get failed" cause as session_not_found', () => {
		const parser = new GrokOutputParser();

		const error = parser.detectErrorFromExit(1, 'session get failed: 404 Not Found', '');

		expect(error).toEqual(
			expect.objectContaining({
				type: 'session_not_found',
				recoverable: true,
				agentId: 'grok',
			})
		);
	});

	it('does not classify the informational "not found locally" restore line as session_not_found', () => {
		// This line also precedes SUCCESSFUL remote restores; only the fatal
		// "Failed to restore session" string identifies a dead session. A crash
		// after this line without that string falls back to the generic error.
		const parser = new GrokOutputParser();

		const error = parser.detectErrorFromExit(
			1,
			'Session 019f47fb-2316-7f21-98db-55907d4ddb60 not found locally, restoring from remote...',
			''
		);

		expect(error?.type).toBe('agent_crashed');
		expect(error?.message).toBe('Agent exited with code 1');
	});

	it('falls back to a generic crash error on nonzero exit with unmatched output', () => {
		const parser = new GrokOutputParser();

		const error = parser.detectErrorFromExit(1, 'inscrutable failure', '');
		expect(error).toEqual(
			expect.objectContaining({
				type: 'agent_crashed',
				message: 'Agent exited with code 1',
				recoverable: true,
				agentId: 'grok',
			})
		);

		expect(parser.detectErrorFromExit(0, '', '')).toBeNull();
	});

	it('returns null for non-JSON garbage and blank lines', () => {
		const parser = new GrokOutputParser();

		expect(parser.parseJsonLine('')).toBeNull();
		expect(parser.parseJsonLine('   ')).toBeNull();
		expect(parser.parseJsonLine('not json at all')).toBeNull();
		expect(parser.parseJsonLine('{"type":"text","data":')).toBeNull();
		expect(parser.parseJsonLine('Error: Couldn\'t set model "x"')).toBeNull();
		expect(parser.parseJsonLine('null')).toBeNull();
		expect(parser.parseJsonLine('"just a string"')).toBeNull();
		expect(parser.parseJsonLine('42')).toBeNull();

		expect(parser.detectErrorFromLine('')).toBeNull();
		expect(parser.detectErrorFromLine('not json at all')).toBeNull();
	});
});
