import { describe, it, expect, beforeAll } from 'vitest';
import { AntigravityOutputParser } from '../../../main/parsers/antigravity-output-parser';
import { MAX_PERSISTED_TOOL_OUTPUT_CHARS } from '../../../shared/toolOutput';
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
				// Qualified with conversation_id: step_index restarts at 0 per
				// conversation, and the renderer keys tool entries on this id across
				// the whole tab, so a bare index merges two runs into one badge.
				toolCallId: 'conv-1:3',
				// toolState is an OBJECT the badge reads `status` off, never the raw
				// lifecycle word: handing over 'DONE' left every badge status-less,
				// input-less and output-less (issue #1485).
				toolState: { status: 'completed', input: { cmd: 'ls' }, output: 'a\nb' },
				sessionId: 'conv-1',
			})
		);
	});

	it('caps oversized tool output before it enters the renderer session', () => {
		const parser = new AntigravityOutputParser();
		const event = parser.parseJsonObject({
			event: 'step_update',
			step_update: {
				conversation_id: 'conv-1',
				step_index: 4,
				state: 'DONE',
				step_type: 'tool',
				tool_name: 'run_command',
				tool_info: { output: 'x'.repeat(50_000) },
			},
		});

		const output = event?.toolState?.output as string;
		expect(output.length).toBeLessThan(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 100);
		expect(output).toContain('[tool output truncated');
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

// Lines below are shaped like a live agy 1.2.16 `--output-format stream-json`
// run. The stream carries thinking only as `thinking_tokens` and settles every
// tool step DONE with no exit code, so the parser reads both from agy's
// conversation store; a fake store stands in for it here.
describe('AntigravityOutputParser with the conversation store', () => {
	const CONV = 'd4bfb7b1-38c0-4d39-b66a-700cd78e0b2f';
	const step = (fields: Record<string, unknown>) => ({
		event: 'step_update',
		step_update: { conversation_id: CONV, ...fields },
	});

	function parserWith(store: {
		thinking?: Record<number, string>;
		results?: Record<number, string>;
	}) {
		const reads: string[] = [];
		const parser = new AntigravityOutputParser({
			readThinking: (conversationId, index) => {
				reads.push(`thinking:${conversationId}:${index}`);
				return store.thinking?.[index] ?? '';
			},
			readToolResult: (conversationId, index) => {
				reads.push(`result:${conversationId}:${index}`);
				return store.results?.[index] ?? '';
			},
		});
		return { parser, reads };
	}

	it("attaches a tool-calling model step's thinking to its DONE usage tick", () => {
		const { parser } = parserWith({ thinking: { 1: 'List first, then read.' } });

		const event = parser.parseJsonObject(
			step({
				step_index: 1,
				state: 'DONE',
				step_type: 'agent_response',
				usage: { input_tokens: 10, output_tokens: 400, thinking_tokens: 380 },
			})
		);

		expect(event).toMatchObject({
			type: 'system',
			reasoningText: 'List first, then read.\n\n',
		});
		// Per-step usage is not reported: the result carries the turn's totals.
		expect(event?.usage).toBeUndefined();
	});

	// Captured agy 1.3.0 numbers: two model calls, and a result that is their sum.
	// Every usage event Maestro sees is ADDED to the session totals, so the old
	// per-step usage plus the result counted the turn twice, and the context
	// gauge read the 32k sum instead of the last call's 16k.
	it('reports usage once, on the result, with the last model call as occupancy', () => {
		const { parser } = parserWith({});
		const steps = [
			step({
				step_index: 1,
				state: 'DONE',
				step_type: 'agent_response',
				usage: {
					input_tokens: 15800,
					output_tokens: 194,
					thinking_tokens: 86,
					cache_read_tokens: 0,
				},
			}),
			step({
				step_index: 2,
				state: 'DONE',
				step_type: 'tool',
				tool_name: 'run_command',
				tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, output: 'hello.txt' },
			}),
			step({
				step_index: 4,
				state: 'DONE',
				step_type: 'agent_response',
				text_delta: '\n',
				usage: {
					input_tokens: 16275,
					output_tokens: 231,
					thinking_tokens: 195,
					cache_read_tokens: 0,
				},
			}),
		].map((line) => parser.parseJsonObject(line));
		expect(steps.map((event) => event?.usage)).toEqual([undefined, undefined, undefined]);

		const result = {
			event: 'result',
			result: {
				conversation_id: CONV,
				status: 'SUCCESS',
				response: 'ok',
				usage: {
					input_tokens: 32075,
					output_tokens: 425,
					thinking_tokens: 281,
					cache_read_tokens: 0,
				},
			},
		};
		const expected = {
			inputTokens: 32075,
			outputTokens: 425,
			cacheReadTokens: 0,
			reasoningTokens: 281,
			absoluteUsage: {
				inputTokens: 16275,
				outputTokens: 231,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				reasoningTokens: 195,
			},
		};
		expect(parser.parseJsonObject(result)?.usage).toEqual(expected);
		// StdoutHandler can parse the same result line twice; both must agree.
		expect(parser.parseJsonObject(result)?.usage).toEqual(expected);
	});

	it('reads an answer step once, on its first delta, so thinking precedes the text', () => {
		const { parser, reads } = parserWith({ thinking: { 5: 'Uppercasing keeps the order.' } });

		const first = parser.parseJsonObject(
			step({ step_index: 5, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Yes, ' })
		);
		const second = parser.parseJsonObject(
			step({ step_index: 5, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'it does.' })
		);
		const done = parser.parseJsonObject(
			step({ step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: '\n' })
		);

		expect(first).toMatchObject({
			type: 'text',
			text: 'Yes, ',
			reasoningText: 'Uppercasing keeps the order.\n\n',
		});
		expect(second?.reasoningText).toBeUndefined();
		expect(done?.reasoningText).toBeUndefined();
		expect(reads).toEqual([`thinking:${CONV}:5`]);
	});

	it('looks again at DONE when the first line found no thinking yet', () => {
		const thinking: Record<number, string> = {};
		const { parser, reads } = parserWith({ thinking });

		parser.parseJsonObject(
			step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'a' })
		);
		parser.parseJsonObject(
			step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'b' })
		);
		thinking[3] = 'Late summary.';
		const done = parser.parseJsonObject(
			step({ step_index: 3, state: 'DONE', step_type: 'agent_response' })
		);

		expect(done?.reasoningText).toBe('Late summary.\n\n');
		expect(reads).toEqual([`thinking:${CONV}:3`, `thinking:${CONV}:3`]);
	});

	it('marks a command that agy settled DONE failed when its stored exit code is non-zero', () => {
		const { parser } = parserWith({
			results: { 6: '\nThe command exited with code 1.\nStdout:\n\nStderr:\n\n' },
		});

		const active = parser.parseJsonObject(
			step({
				step_index: 6,
				state: 'ACTIVE',
				step_type: 'tool',
				tool_name: 'run_command',
				tool_info: { name: 'run_command', parameters: { CommandLine: 'false' } },
			})
		);
		const done = parser.parseJsonObject(
			step({
				step_index: 6,
				state: 'DONE',
				step_type: 'tool',
				tool_name: 'run_command',
				tool_info: { name: 'run_command', parameters: { CommandLine: 'false' } },
			})
		);

		expect(active?.toolState).toEqual({ status: 'running', input: { CommandLine: 'false' } });
		expect(done?.toolState).toEqual({
			status: 'failed',
			input: { CommandLine: 'false' },
			output: 'The command exited with code 1.',
			exitCode: 1,
		});
	});

	it("keeps the stream's own output, cleaned of CRLF, for a successful command", () => {
		const { parser } = parserWith({
			results: { 2: '\nThe command exited with code 0.\nOutput:\ntotal 8\r\n' },
		});

		const done = parser.parseJsonObject(
			step({
				step_index: 2,
				state: 'DONE',
				step_type: 'tool',
				tool_name: 'run_command',
				tool_info: {
					name: 'run_command',
					parameters: { CommandLine: 'ls -la' },
					output: 'total 8\r\n-rw-r--r--@  1 ron  wheel   20 Oct  6 07:04 hello.txt\r\n',
				},
			})
		);

		expect(done?.toolState).toEqual({
			status: 'completed',
			input: { CommandLine: 'ls -la' },
			output: 'total 8\n-rw-r--r--@  1 ron  wheel   20 Oct  6 07:04 hello.txt',
			exitCode: 0,
		});
	});

	it('shows the diff an edit applied, from the stored result', () => {
		const { parser } = parserWith({
			results: {
				8: "The following changes were made by the replace_file_content tool to: /w/hello.txt. Don't ask for permission.\n[diff_block_start]\n@@ -1,4 +1,4 @@\n alpha\n-bravo\n+BRAVO\n charlie\n[diff_block_end]\n\nPlease note that the above snippet only shows the MODIFIED lines.",
			},
		});

		const done = parser.parseJsonObject(
			step({
				step_index: 8,
				state: 'DONE',
				step_type: 'tool',
				tool_name: 'replace_file_content',
				tool_info: { name: 'replace_file_content', parameters: { TargetFile: '/w/hello.txt' } },
			})
		);

		expect(done?.toolState).toMatchObject({
			status: 'completed',
			output: '@@ -1,4 +1,4 @@\n alpha\n-bravo\n+BRAVO\n charlie',
		});
	});

	it('does not read the store while a tool is still running, and forgets a finished conversation', () => {
		const { parser, reads } = parserWith({ thinking: { 1: 'x' } });

		parser.parseJsonObject(
			step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file' })
		);
		expect(reads).toEqual([]);

		parser.parseJsonObject(step({ step_index: 1, state: 'DONE', step_type: 'agent_response' }));
		parser.parseJsonObject({
			event: 'result',
			result: { conversation_id: CONV, status: 'SUCCESS', response: 'ok' },
		});
		// The result dropped the conversation's entry, so nothing is held for it:
		// seeing the same step again reads it afresh.
		parser.parseJsonObject(step({ step_index: 1, state: 'DONE', step_type: 'agent_response' }));
		expect(reads).toEqual([`thinking:${CONV}:1`, `thinking:${CONV}:1`]);
	});
});
