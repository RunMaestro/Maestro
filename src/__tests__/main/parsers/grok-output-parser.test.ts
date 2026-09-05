import { describe, it, expect } from 'vitest';
import { GrokOutputParser } from '../../../main/parsers/grok-output-parser';

// The thought/text/end/error lines below are copied verbatim from real captured
// fixtures (grok v0.2.93, `--output-format streaming-json`): there is no init
// event and no usage/cost data in the stream. grok 1.x adds tool_call and
// tool_call_update; those lines are synthesized from the field names in the
// grok-build 1.0.16 sources, so they pin Maestro's MAPPING rather than grok's
// schema - see the tolerant-reading note in the parser header.

const SIMPLE_TURN_END_LINE =
	'{"type":"end","stopReason":"EndTurn","sessionId":"019f47fa-e297-7993-a1f6-adfaf940ba8c","requestId":"b860c3ae-0e8c-4cc4-b478-01d4ba187c9a"}';

const RESUME_END_LINE =
	'{"type":"end","stopReason":"EndTurn","sessionId":"019f47fb-2316-7f21-98db-55907d4ddb60","requestId":"1194fbc9-a074-4819-a625-d087cee7226c"}';

// Verbatim (sessionId included) from the on-disk updates.jsonl of a real
// grok 1.0.5 headless consult whose run_terminal_command permission prompt was
// auto-cancelled, killing the turn (stopReason "cancelled", 1.x spelling).
const CANCELLED_END_LINE =
	'{"type":"end","stopReason":"cancelled","sessionId":"019f0000-aaaa-7000-8000-00000000c0de","requestId":"019f0000-bbbb-7000-8000-00000000c0de"}';

const BAD_MODEL_ERROR_LINE =
	'{"type":"error","message":"Couldn\'t set model \'nonexistent-model-xyz\': Invalid params: \\"unknown model id\\". Run \'grok models\' to see available models."}';

const BAD_MODEL_STDERR =
	"Error: Couldn't set model 'nonexistent-model-xyz': Invalid params: \"unknown model id\". Run 'grok models' to see available models.";

// Verbatim stderr from `grok -p "hi" --resume 00000000-0000-0000-0000-000000000000
// --output-format streaming-json` (v0.2.93). Stdout is EMPTY for this failure
// (no JSON error event), so only detectErrorFromExit can catch it. A transient
// spinner line between the two is elided.
const BAD_RESUME_STDERR =
	'Session 00000000-0000-0000-0000-000000000000 not found locally, restoring from remote...\n' +
	'Error: Failed to restore session from remote: fetching session record: session get failed: 404 Not Found';

describe('GrokOutputParser', () => {
	it('parses text delta events as partial text events', () => {
		const parser = new GrokOutputParser();

		// From a simple text turn fixture
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

		// Consecutive text deltas from a tool-use turn fixture
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

		// From a simple text turn fixture
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

	it('accepts the 1.x "end_turn" stopReason spelling as a completed turn', () => {
		const parser = new GrokOutputParser();

		const event = parser.parseJsonLine(CANCELLED_END_LINE.replace('"cancelled"', '"end_turn"'));

		expect(event?.type).toBe('result');
		expect(event && parser.isResultMessage(event)).toBe(true);
	});

	it('reclassifies a cancelled end event as an error, keeping the session ID', () => {
		// A headless run answers every permission prompt with "cancelled", which
		// kills the whole turn: the end event then carries stopReason "cancelled"
		// and the streamed text is an unfinished answer. It must NOT become a
		// successful result - and the session ID must survive for resume.
		const parser = new GrokOutputParser();

		const event = parser.parseJsonLine(CANCELLED_END_LINE);

		expect(event?.type).toBe('error');
		expect(event?.sessionId).toBe('019f0000-aaaa-7000-8000-00000000c0de');
		expect(event?.text).toContain('cancelled');
		expect(event && parser.isResultMessage(event)).toBe(false);
	});

	it('detects the cancelled end event as an agent error (dual surfacing)', () => {
		const parser = new GrokOutputParser();

		const error = parser.detectErrorFromLine(CANCELLED_END_LINE);

		expect(error).not.toBeNull();
		expect(error?.type).toBe('unknown');
		expect(error?.recoverable).toBe(true);
		expect(error?.message).toContain('cancelled');
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
		// Resume preserves the sessionId of the
		// resumed session in its end event.
		const parser = new GrokOutputParser();

		const event = parser.parseJsonLine(RESUME_END_LINE);
		expect(event && parser.extractSessionId(event)).toBe('019f47fb-2316-7f21-98db-55907d4ddb60');
	});

	it('emits no tool_use events on a 0.2.93 turn - those stream only thought/text/end', () => {
		// grok 0.2.93 emitted no tool events at all: the turn created and read a
		// file, yet stdout carried only thought/text/end. 1.x adds tool_call /
		// tool_call_update (covered below); this asserts the older shape is still
		// read the same way and does not sprout phantom badges.
		const parser = new GrokOutputParser();

		// Representative lines from a tool-use turn
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

	describe('grok 1.x tool events', () => {
		it('parses a tool_call into a running tool_use keyed by toolCallId', () => {
			const parser = new GrokOutputParser();

			const event = parser.parseJsonLine(
				'{"type":"tool_call","toolCallId":"call_01","toolName":"run_terminal_command","kind":"execute","rawInput":{"command":"ls -la"}}'
			);

			expect(event).toMatchObject({
				type: 'tool_use',
				toolName: 'run_terminal_command',
				toolCallId: 'call_01',
				toolState: { status: 'running', input: { command: 'ls -la' } },
			});
		});

		it('settles a tool_call_update and carries the name forward from the opening call', () => {
			// The update line carries the id but NOT the name. StdoutHandler drops a
			// tool_use event with no toolName, so a badge whose name is not carried
			// forward would stay 'running' forever.
			const parser = new GrokOutputParser();

			parser.parseJsonLine(
				'{"type":"tool_call","toolCallId":"call_01","toolName":"run_terminal_command","rawInput":{"command":"ls"}}'
			);
			const update = parser.parseJsonLine(
				'{"type":"tool_call_update","toolCallId":"call_01","status":"completed","rawOutput":"a.txt\\nb.txt"}'
			);

			expect(update).toMatchObject({
				type: 'tool_use',
				toolName: 'run_terminal_command',
				toolCallId: 'call_01',
				toolState: { status: 'completed', output: 'a.txt\nb.txt' },
			});
			// The opening line's input is not restated on the update; the renderer
			// merges by id and keeps the recorded input.
			expect((update?.toolState as { input?: unknown }).input).toBeUndefined();
		});

		it('keeps two parallel calls to the same tool on their own ids', () => {
			// This is the mis-attribution the name-matching fallback produces when
			// no id is emitted: the first output to land settles the wrong badge.
			const parser = new GrokOutputParser();

			parser.parseJsonLine(
				'{"type":"tool_call","toolCallId":"a","toolName":"read_file","rawInput":{"path":"one.ts"}}'
			);
			parser.parseJsonLine(
				'{"type":"tool_call","toolCallId":"b","toolName":"read_file","rawInput":{"path":"two.ts"}}'
			);

			const settleB = parser.parseJsonLine(
				'{"type":"tool_call_update","toolCallId":"b","status":"completed","rawOutput":"two"}'
			);
			const settleA = parser.parseJsonLine(
				'{"type":"tool_call_update","toolCallId":"a","status":"completed","rawOutput":"one"}'
			);

			expect(settleB).toMatchObject({ toolCallId: 'b', toolName: 'read_file' });
			expect(settleA).toMatchObject({ toolCallId: 'a', toolName: 'read_file' });
			expect((settleB?.toolState as { output?: string }).output).toBe('two');
			expect((settleA?.toolState as { output?: string }).output).toBe('one');
		});

		it('maps a failing update to the failed status and keeps the error text', () => {
			const parser = new GrokOutputParser();

			parser.parseJsonLine('{"type":"tool_call","toolCallId":"c","toolName":"edit_file"}');
			const failed = parser.parseJsonLine(
				'{"type":"tool_call_update","toolCallId":"c","status":"failed","error":"no such file"}'
			);

			// The detail lands in `output`: toolState is {status,input,output}, so an
			// `error` key would render nowhere.
			expect(failed?.toolState).toMatchObject({ status: 'failed', output: 'no such file' });
		});

		it('treats an unrecognized update status as still running', () => {
			// A badge wrongly settled can never be corrected by a later update, so
			// schema drift must not settle one.
			const parser = new GrokOutputParser();

			const event = parser.parseJsonLine(
				'{"type":"tool_call_update","toolCallId":"d","toolName":"read_file","status":"streaming"}'
			);

			expect((event?.toolState as { status?: string }).status).toBe('running');
		});

		it('reads snake_case field spellings too', () => {
			const parser = new GrokOutputParser();

			const event = parser.parseJsonLine(
				'{"type":"tool_call","tool_call_id":"e","tool_name":"list_dir","input":{"path":"."}}'
			);

			expect(event).toMatchObject({
				type: 'tool_use',
				toolName: 'list_dir',
				toolCallId: 'e',
				toolState: { status: 'running', input: { path: '.' } },
			});
		});

		it('absorbs a tool line carrying neither an id nor a name as a system event', () => {
			// Degrade to the old drop-it behaviour rather than render a nameless,
			// uncorrelatable badge.
			const parser = new GrokOutputParser();

			const event = parser.parseJsonLine('{"type":"tool_call","kind":"execute"}');

			expect(event?.type).toBe('system');
		});
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

		// Bad-model failure on stdout (streaming-json)
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
		// parseJsonObject aligns with detectErrorFromParsed (no synthetic "Unknown error")
		expect(parser.parseJsonObject({ type: 'error' })).toBeNull();
		expect(parser.parseJsonObject({ type: 'error', message: '   ' })).toBeNull();
		expect(parser.parseJsonObject({ type: 'error', message: 42 })).toBeNull();
	});

	it('only attaches string sessionIds from end events', () => {
		const parser = new GrokOutputParser();

		const good = parser.parseJsonObject({
			type: 'end',
			stopReason: 'EndTurn',
			sessionId: '019f0000-aaaa-7000-8000-000000000001',
		});
		expect(good?.sessionId).toBe('019f0000-aaaa-7000-8000-000000000001');
		expect(good && parser.extractSessionId(good)).toBe('019f0000-aaaa-7000-8000-000000000001');

		const bad = parser.parseJsonObject({
			type: 'end',
			stopReason: 'EndTurn',
			sessionId: 12345,
		});
		expect(bad?.sessionId).toBeUndefined();
		expect(bad && parser.extractSessionId(bad)).toBeNull();
	});

	it('classifies exit failures from the duplicated stderr message', () => {
		// Grok duplicates its error on stderr as `Error: <message>` and exits 1
		// (verified against grok v0.2.93).
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
		// Unmatched free-form stderr waits for exit classification
		expect(parser.detectErrorFromLine('not json at all')).toBeNull();
	});

	it('classifies mid-run non-JSON stderr against the pattern bank', () => {
		// Grok duplicates failures on stderr as `Error: <message>` before exit.
		const parser = new GrokOutputParser();

		const auth = parser.detectErrorFromLine(
			'Error: Not authenticated. Run grok login to continue.'
		);
		expect(auth).toEqual(
			expect.objectContaining({
				type: 'auth_expired',
				recoverable: true,
				agentId: 'grok',
			})
		);

		const badModel = parser.detectErrorFromLine(BAD_MODEL_STDERR);
		expect(badModel).toEqual(
			expect.objectContaining({
				type: 'agent_crashed',
				message: expect.stringContaining('grok models'),
				agentId: 'grok',
			})
		);
		// Canned UI copy keeps the original on raw.errorLine
		expect(badModel?.raw?.errorLine).toContain('unknown model id');
	});

	it('truncates long unmatched error messages for UI', () => {
		const parser = new GrokOutputParser();
		const longMessage = `x${'y'.repeat(600)}`;
		const error = parser.detectErrorFromParsed({
			type: 'error',
			message: longMessage,
		});

		expect(error?.type).toBe('unknown');
		expect(error?.message.length).toBeLessThanOrEqual(503); // 500 + "..."
		expect(error?.message.endsWith('...')).toBe(true);
		// Full body remains available via parsedJson
		expect((error?.parsedJson as { message?: string })?.message).toBe(longMessage);
	});

	it('absorbs unknown stream types as system events', () => {
		const parser = new GrokOutputParser();
		const event = parser.parseJsonObject({ type: 'future_event', data: { x: 1 } });
		expect(event).toEqual(
			expect.objectContaining({
				type: 'system',
				raw: expect.objectContaining({ type: 'future_event' }),
			})
		);
	});
});
