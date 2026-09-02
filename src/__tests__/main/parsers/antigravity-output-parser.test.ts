import { describe, it, expect, beforeAll } from 'vitest';
import { AntigravityOutputParser } from '../../../main/parsers/antigravity-output-parser';
import { initializeOutputParsers } from '../../../main/parsers';

beforeAll(() => {
	// detectErrorFromParsed / detectErrorFromExit consult the error-pattern registry.
	initializeOutputParsers();
});

describe('AntigravityOutputParser', () => {
	it('parses the init event without inventing a conversation id', () => {
		const parser = new AntigravityOutputParser();

		const event = parser.parseJsonObject({
			event: 'init',
			init: {
				cwd: '/tmp/project',
				tools: ['read_file', 'run_command'],
				permission_mode: 'always-proceed',
				model: 'gemini-3.6-flash-high',
			},
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'init',
				raw: expect.objectContaining({ cwd: '/tmp/project' }),
			})
		);
		// The documented init payload carries no conversation_id.
		expect(event && parser.extractSessionId(event)).toBeNull();
	});

	it('keeps a top-level conversation id on init so an immediate failure stays resumable', () => {
		const parser = new AntigravityOutputParser();

		const event = parser.parseJsonObject({
			event: 'init',
			conversation_id: 'conv-early',
			init: { cwd: '/tmp/project' },
		});

		expect(event && parser.extractSessionId(event)).toBe('conv-early');
	});

	it('emits assistant text deltas as partial text carrying the conversation id', () => {
		const parser = new AntigravityOutputParser();

		const event = parser.parseJsonObject({
			event: 'step_update',
			step_update: {
				conversation_id: '055a398f-db14-4c5f-abbb-1bf03f8120a7',
				step_index: 2,
				state: 'ACTIVE',
				step_type: 'agent_response',
				text_delta: 'Hello',
			},
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'text',
				text: 'Hello',
				isPartial: true,
				sessionId: '055a398f-db14-4c5f-abbb-1bf03f8120a7',
			})
		);
	});

	it('maps tool steps to tool_use with the tool name and lifecycle state', () => {
		const parser = new AntigravityOutputParser();

		const event = parser.parseJsonObject({
			event: 'step_update',
			step_update: {
				conversation_id: 'conv-1',
				step_index: 3,
				state: 'DONE',
				step_type: 'tool',
				tool_name: 'run_command',
				tool_info: { name: 'run_command', parameters: { cmd: 'ls' }, output: 'a\nb' },
			},
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'tool_use',
				toolName: 'run_command',
				toolCallId: '3',
				// toolState is an OBJECT the badge reads `status` off, never the raw
				// lifecycle word: handing over 'DONE' left every badge status-less,
				// input-less and output-less (issue #1485).
				toolState: { status: 'completed', input: { cmd: 'ls' }, output: 'a\nb' },
				sessionId: 'conv-1',
			})
		);
	});

	it('reports an ACTIVE tool step as running with its input and no output yet', () => {
		const parser = new AntigravityOutputParser();

		const event = parser.parseJsonObject({
			event: 'step_update',
			step_update: {
				conversation_id: 'conv-1',
				step_index: 4,
				state: 'ACTIVE',
				step_type: 'tool',
				tool_info: { name: 'run_command', parameters: { cmd: 'pwd' } },
			},
		});

		expect(event?.toolState).toEqual({ status: 'running', input: { cmd: 'pwd' } });
	});

	it('reports a settled tool step carrying an error as failed, not completed', () => {
		// A failed tool reported as completed makes a turn look like it did work
		// it never did.
		const parser = new AntigravityOutputParser();

		const event = parser.parseJsonObject({
			event: 'step_update',
			step_update: {
				conversation_id: 'conv-1',
				step_index: 5,
				state: 'DONE',
				step_type: 'tool',
				tool_info: { name: 'read_file', error: { type: 'ENOENT', message: 'no such file' } },
			},
		});

		expect(event?.toolState).toEqual({ status: 'failed', output: 'no such file' });
	});

	it('leaves an unrecognized lifecycle word running rather than settling the badge', () => {
		const parser = new AntigravityOutputParser();

		const event = parser.parseJsonObject({
			event: 'step_update',
			step_update: {
				conversation_id: 'conv-1',
				step_index: 6,
				state: 'PENDING_APPROVAL',
				step_type: 'tool',
				tool_name: 'run_command',
			},
		});

		expect((event?.toolState as { status?: string }).status).toBe('running');
	});

	it('treats bookkeeping steps as non-user-facing system events', () => {
		const parser = new AntigravityOutputParser();

		const event = parser.parseJsonObject({
			event: 'step_update',
			step_update: { conversation_id: 'conv-1', step_type: 'checkpoint', state: 'DONE' },
		});

		expect(event).toEqual(expect.objectContaining({ type: 'system', sessionId: 'conv-1' }));
	});

	it('parses the terminal result envelope and normalizes snake_case usage', () => {
		const parser = new AntigravityOutputParser();

		const event = parser.parseJsonObject({
			event: 'result',
			result: {
				conversation_id: 'conv-9',
				status: 'SUCCESS',
				response: 'All done.',
				duration_seconds: 12.5,
				num_turns: 1,
				usage: {
					input_tokens: 1200,
					output_tokens: 300,
					thinking_tokens: 80,
					cache_read_tokens: 500,
					total_tokens: 2080,
				},
			},
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'result',
				text: 'All done.',
				sessionId: 'conv-9',
			})
		);
		expect(event && parser.isResultMessage(event)).toBe(true);
		expect(event && parser.extractUsage(event)).toEqual({
			inputTokens: 1200,
			outputTokens: 300,
			cacheReadTokens: 500,
			reasoningTokens: 80,
		});
	});

	it('leaves contextWindow unset so the configured window drives the meter', () => {
		const parser = new AntigravityOutputParser();

		const event = parser.parseJsonObject({
			event: 'result',
			result: { conversation_id: 'c', response: 'ok', usage: { input_tokens: 1 } },
		});

		expect(event?.usage).not.toHaveProperty('contextWindow');
	});

	it('reclassifies a result carrying an error as an error event', () => {
		const parser = new AntigravityOutputParser();

		const event = parser.parseJsonObject({
			event: 'result',
			result: {
				conversation_id: 'conv-2',
				status: 'ERROR',
				response: '',
				error: 'RESOURCE_EXHAUSTED: quota exceeded for this project',
			},
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'error',
				text: 'RESOURCE_EXHAUSTED: quota exceeded for this project',
				sessionId: 'conv-2',
			})
		);
		// A failed envelope must NOT answer isResultMessage. ExitHandler's
		// end-of-stream flush emits event.text as the agent's answer for anything
		// that does, which would surface the failure text as a normal response.
		expect(event && parser.isResultMessage(event)).toBe(false);
	});

	it('classifies a failed result against the registered error patterns', () => {
		const parser = new AntigravityOutputParser();

		const error = parser.detectErrorFromParsed({
			event: 'result',
			result: { status: 'ERROR', error: 'RESOURCE_EXHAUSTED: quota exceeded' },
		});

		expect(error).toEqual(
			expect.objectContaining({ type: 'rate_limited', agentId: 'antigravity', recoverable: true })
		);
	});

	it('does not report an error for a successful result', () => {
		const parser = new AntigravityOutputParser();

		expect(
			parser.detectErrorFromParsed({
				event: 'result',
				result: { status: 'SUCCESS', response: 'fine' },
			})
		).toBeNull();
	});

	it('keys off `error`, not `status`, when deciding a result failed', () => {
		const parser = new AntigravityOutputParser();

		// `status` is a free-form string the docs never enumerate exhaustively, so
		// the parser must not read it. Both envelopes below contradict their own
		// status; the presence or absence of `error` is what has to win.
		expect(
			parser.detectErrorFromParsed({
				event: 'result',
				result: { status: 'SUCCESS', error: 'RESOURCE_EXHAUSTED: quota exceeded' },
			})
		).toEqual(expect.objectContaining({ type: 'rate_limited' }));

		expect(
			parser.detectErrorFromParsed({
				event: 'result',
				result: { status: 'ERROR', response: 'fine' },
			})
		).toBeNull();
	});

	it('keeps the conversation id on a structured error so a retry can resume it', () => {
		const parser = new AntigravityOutputParser();

		const error = parser.detectErrorFromParsed({
			event: 'result',
			result: {
				status: 'ERROR',
				conversation_id: '055a398f-db14-4c5f-abbb-1bf03f8120a7',
				error: 'RESOURCE_EXHAUSTED: quota exceeded',
			},
		});

		expect(error?.sessionId).toBe('055a398f-db14-4c5f-abbb-1bf03f8120a7');
	});

	it('ignores foreign JSON objects in parseJsonObject', () => {
		const parser = new AntigravityOutputParser();

		expect(parser.parseJsonObject({ type: 'assistant', message: {} })).toBeNull();
		expect(parser.parseJsonObject(null)).toBeNull();
	});

	it('surfaces non-JSON output as raw partial text rather than dropping it', () => {
		const parser = new AntigravityOutputParser();

		expect(parser.parseJsonLine('warning: something happened')).toEqual(
			expect.objectContaining({ type: 'text', text: 'warning: something happened' })
		);
		expect(parser.parseJsonLine('   ')).toBeNull();
	});

	it('maps a headless timeout on a non-zero exit to a recoverable network error', () => {
		const parser = new AntigravityOutputParser();

		const error = parser.detectErrorFromExit(1, 'print-timeout of 5m0s exceeded', '');

		expect(error).toEqual(
			expect.objectContaining({ type: 'network_error', recoverable: true, agentId: 'antigravity' })
		);
	});

	it('reports an unrecognized non-zero exit as a crash and stays silent on success', () => {
		const parser = new AntigravityOutputParser();

		expect(parser.detectErrorFromExit(3, 'something inscrutable', '')).toEqual(
			expect.objectContaining({ type: 'agent_crashed', agentId: 'antigravity' })
		);
		expect(parser.detectErrorFromExit(0, '', '')).toBeNull();
	});
});
