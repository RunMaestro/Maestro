/**
 * @file agent-qualification.test.ts
 *
 * The rules that read an agent qualification run (`helpers/agentQualification.ts`):
 * what Claude Code's and Codex's JSON streams say happened, what the model
 * server's log says about throughput, and the verdict. The opt-in suite that
 * runs real harnesses (`model-agent-qualification-e2e.test.ts`) grants the
 * catalog's `agent` role from these verdicts, so a misread here would grant it
 * to a model that never fixed the bug, or withhold it from one that did.
 *
 * The stream lines are cut down from real runs against gpt-oss 20B.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	CLAUDE_CODE_LOCAL_MAX_OUTPUT_TOKENS,
	QUALIFICATION_MAX_TURNS,
	QUALIFICATION_PROMPT,
	checkQualificationRepo,
	claudeCodeQualificationLaunch,
	codexQualificationLaunch,
	harnessQualified,
	judgeQualification,
	qualificationSettled,
	readClaudeStream,
	readCodexStream,
	readServerTimings,
	tokensPerSecond,
	writeQualificationRepo,
	type HarnessTranscript,
	type QualificationRepoState,
} from '../../helpers/agentQualification';

const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n');

const toolUse = (name: string, input: unknown, id = 't') => ({
	type: 'assistant',
	message: { content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (content: unknown, isError = false, id = 't') => ({
	type: 'user',
	message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});
const claudeResult = (over: Record<string, unknown> = {}) => ({
	type: 'result',
	subtype: 'success',
	is_error: false,
	num_turns: 4,
	result: 'The test now passes: PASS.',
	...over,
});

const item = (body: Record<string, unknown>) => ({ type: 'item.completed', item: body });

const SERVER = {
	baseUrl: 'http://127.0.0.1:59098',
	key: 'sk-test',
	model: 'm',
	contextSize: 40960,
};

describe('readClaudeStream', () => {
	it('counts tool calls and takes the turn count and final message from the result', () => {
		const transcript = readClaudeStream(
			[
				'{"type":"system","subtype":"init"}',
				lines(
					toolUse('Read', { file_path: 'notes.md' }),
					// A tool that ran and failed is the model's mistake, not a malformed call.
					toolResult('File does not exist. Note: your current working directory is /r.', true),
					{ type: 'system', subtype: 'compact_boundary' },
					toolUse('Bash', { command: 'node test.js' }, 'run'),
					toolResult([{ type: 'text', text: 'PASS' }], false, 'run'),
					claudeResult()
				),
			].join('\n')
		);
		expect(transcript).toEqual({
			turns: 4,
			toolCalls: 2,
			malformedToolCalls: [],
			finalMessage: 'The test now passes: PASS.',
			hitTurnLimit: false,
			sawTestPass: true,
			compactions: 1,
			error: null,
		});
	});

	it('credits a test pass only to a call that ran the test and printed PASS', () => {
		const sawPass = (...events: unknown[]) => readClaudeStream(lines(...events)).sawTestPass;
		// A file that merely contains PASS is not a test run.
		expect(
			sawPass(toolUse('Read', { file_path: 'test.js' }), toolResult("console.log('PASS')"))
		).toBe(false);
		// The test ran and failed.
		expect(
			sawPass(toolUse('Bash', { command: 'node test.js' }), toolResult('AssertionError', true))
		).toBe(false);
		expect(
			sawPass(toolUse('Bash', { command: 'cd repo && node ./test.js' }), toolResult('PASS'))
		).toBe(true);
		// Qwen3-Coder-Next runs it by its absolute path.
		expect(
			sawPass(
				toolUse('Bash', { command: 'node "/private/var/tmp/repo/test.js"' }),
				toolResult('PASS')
			)
		).toBe(true);
		expect(
			sawPass(toolUse('Bash', { command: 'node /tmp/repo/not-test.js' }), toolResult('PASS'))
		).toBe(false);
	});

	it('flags a call the harness refused and tool markup leaked into text', () => {
		const transcript = readClaudeStream(
			lines(
				toolUse('Read', {}),
				toolResult(
					'<tool_use_error>InputValidationError: Read failed: file_path is missing</tool_use_error>',
					true
				),
				{
					type: 'assistant',
					message: { content: [{ type: 'text', text: '<tool_call>{"name":"Bash"}</tool_call>' }] },
				},
				toolUse('Shell', {}),
				toolResult('<tool_use_error>Error: No such tool available: Shell</tool_use_error>', true),
				claudeResult()
			)
		);
		expect(transcript.malformedToolCalls).toHaveLength(3);
		expect(transcript.malformedToolCalls[0]).toContain('InputValidationError');
	});

	it('reads the turn limit and an API error as failures of the run', () => {
		const limited = readClaudeStream(
			lines(claudeResult({ subtype: 'error_max_turns', is_error: true, num_turns: 11, result: '' }))
		);
		expect(limited).toMatchObject({ hitTurnLimit: true, turns: 11, error: 'error_max_turns' });

		const refused = readClaudeStream(
			lines(claudeResult({ is_error: true, num_turns: 1, result: 'API Error: 400 context' }))
		);
		expect(refused).toMatchObject({ hitTurnLimit: false, error: 'API Error: 400 context' });
	});

	it('reports a stream that ended without a result, and skips a torn last line', () => {
		const transcript = readClaudeStream(`${lines(toolUse('Read', {}))}\n{"type":"res`);
		expect(transcript.toolCalls).toBe(1);
		expect(transcript.error).toMatch(/without a result/);
	});
});

describe('readCodexStream', () => {
	it('counts tool calls, adds the final answer as a turn, and ignores warnings', () => {
		const transcript = readCodexStream(
			lines(
				{ type: 'thread.started', thread_id: 'x' },
				item({
					type: 'error',
					message: 'Model metadata for `m` not found. Defaulting to fallback.',
				}),
				{ type: 'turn.started' },
				item({ type: 'command_execution', command: "sed -n '1,200p' notes.md", exit_code: 0 }),
				item({ type: 'file_change', changes: [{ path: 'math.js', kind: 'update' }] }),
				item({
					type: 'command_execution',
					command: "/bin/zsh -lc 'node test.js'",
					aggregated_output: 'PASS\n',
					exit_code: 0,
				}),
				item({ type: 'agent_message', text: 'The test now passes.\nPASS' }),
				{ type: 'turn.completed', usage: { input_tokens: 26628, output_tokens: 429 } }
			)
		);
		expect(transcript).toEqual({
			turns: 4,
			toolCalls: 3,
			malformedToolCalls: [],
			finalMessage: 'The test now passes.\nPASS',
			hitTurnLimit: false,
			sawTestPass: true,
			compactions: 0,
			error: null,
		});
		const failedRun = readCodexStream(
			lines(
				item({
					type: 'command_execution',
					command: 'node test.js',
					aggregated_output: 'AssertionError',
					exit_code: 1,
				})
			)
		);
		expect(failedRun.sawTestPass).toBe(false);
	});

	it('flags a refused call and leaked markup, and passes the turn limit past 10', () => {
		const calls = Array.from({ length: QUALIFICATION_MAX_TURNS }, () =>
			item({ type: 'command_execution', command: 'ls', exit_code: 0 })
		);
		const transcript = readCodexStream(
			lines(
				item({ type: 'error', message: 'failed to parse function arguments: EOF' }),
				...calls,
				item({ type: 'agent_message', text: '<|channel|>commentary to=functions.shell' }),
				{ type: 'turn.completed' }
			)
		);
		expect(transcript.malformedToolCalls).toHaveLength(2);
		expect(transcript.turns).toBe(QUALIFICATION_MAX_TURNS + 1);
		expect(transcript.hitTurnLimit).toBe(true);
	});

	it('reads a failed turn and a missing completion as errors', () => {
		expect(
			readCodexStream(lines({ type: 'turn.failed', error: { message: 'stream disconnected' } }))
				.error
		).toBe('stream disconnected');
		expect(readCodexStream(lines({ type: 'turn.started' })).error).toMatch(/without a completed/);
	});
});

describe('readServerTimings', () => {
	it('sums prompt and generation timings separately, one request per generation line', () => {
		const log = [
			'[62104] 0.02.212.575 I slot print_timing: id  2 | task 5 | prompt eval time =     400.00 ms /   100 tokens (    4.00 ms per token,   250.00 tokens per second)',
			'[62104] 0.02.212.577 I slot print_timing: id  2 | task 5 |        eval time =     100.00 ms /    10 tokens (   10.00 ms per token,   100.00 tokens per second)',
			'[62104] 0.02.300.000 I srv  log_server_r: request: POST /v1/messages 127.0.0.1 200',
			'[62104] 0.02.312.575 I slot print_timing: id  2 | task 9 | prompt eval time =     600.00 ms /   400 tokens',
			'[62104] 0.02.312.577 I slot print_timing: id  2 | task 9 |        eval time =     300.00 ms /    30 tokens',
		].join('\n');
		const timings = readServerTimings(log);
		expect(timings).toEqual({
			requests: 2,
			generatedTokens: 40,
			generationMs: 400,
			promptTokens: 500,
			promptMs: 1000,
		});
		expect(tokensPerSecond(timings.generatedTokens, timings.generationMs)).toBe(100);
		expect(tokensPerSecond(timings.promptTokens, timings.promptMs)).toBe(500);
		expect(tokensPerSecond(0, 0)).toBeNull();
	});
});

describe('judgeQualification', () => {
	const transcript = (over: Partial<HarnessTranscript> = {}): HarnessTranscript => ({
		turns: 6,
		toolCalls: 5,
		malformedToolCalls: [],
		finalMessage: 'PASS',
		hitTurnLimit: false,
		sawTestPass: true,
		compactions: 0,
		error: null,
		...over,
	});
	const green: QualificationRepoState = {
		testPasses: true,
		testOutput: 'PASS',
		testFileChanged: false,
	};
	const red: QualificationRepoState = {
		testPasses: false,
		testOutput: 'AssertionError [ERR_ASSERTION]: sum([5]) should be 5',
		testFileChanged: false,
	};

	it('passes a green test within the turn limit, with no malformed call and a report', () => {
		expect(judgeQualification({ transcript: transcript(), repo: green, timedOut: false })).toEqual({
			passed: true,
			failure: null,
			detail: null,
		});
	});

	it('fails for each rule, in the order that best explains the run', () => {
		const failure = (input: Parameters<typeof judgeQualification>[0]) =>
			judgeQualification(input).failure;
		expect(failure({ transcript: transcript(), repo: green, timedOut: true })).toBe('timeout');
		expect(
			failure({
				transcript: transcript({ malformedToolCalls: ['x'] }),
				repo: green,
				timedOut: false,
			})
		).toBe('malformed-tool-call');
		expect(
			failure({
				transcript: transcript(),
				repo: { ...green, testFileChanged: true },
				timedOut: false,
			})
		).toBe('test-file-changed');
		expect(
			failure({ transcript: transcript({ hitTurnLimit: true }), repo: red, timedOut: false })
		).toBe('too-many-turns');
		expect(
			failure({ transcript: transcript({ error: 'API Error: 400' }), repo: red, timedOut: false })
		).toBe('harness-error');
		expect(failure({ transcript: transcript(), repo: red, timedOut: false })).toBe(
			'test-still-failing'
		);
		expect(failure({ transcript: transcript({ turns: 11 }), repo: green, timedOut: false })).toBe(
			'too-many-turns'
		);
		expect(
			failure({ transcript: transcript({ hitTurnLimit: true }), repo: green, timedOut: false })
		).toBe('too-many-turns');
		expect(
			failure({ transcript: transcript({ sawTestPass: false }), repo: green, timedOut: false })
		).toBe('never-ran-test');
		expect(
			failure({ transcript: transcript({ finalMessage: '' }), repo: green, timedOut: false })
		).toBe('no-report');
	});
});

describe('attempts', () => {
	const runs = (...passed: boolean[]) => passed.map((value) => ({ passed: value }));

	it('settles once a majority is reached either way, or every attempt has run', () => {
		expect(qualificationSettled(runs())).toBe(false);
		expect(qualificationSettled(runs(true))).toBe(false);
		expect(qualificationSettled(runs(true, false))).toBe(false);
		expect(qualificationSettled(runs(true, true))).toBe(true);
		expect(qualificationSettled(runs(false, false))).toBe(true);
		expect(qualificationSettled(runs(true), 1)).toBe(true);
	});

	it('qualifies on a majority of the attempts, not of the runs made', () => {
		expect(harnessQualified(runs(true, true))).toBe(true);
		expect(harnessQualified(runs(true, false, true))).toBe(true);
		expect(harnessQualified(runs(true, false, false))).toBe(false);
		expect(harnessQualified(runs(true))).toBe(false);
		expect(harnessQualified(runs(true), 1)).toBe(true);
	});
});

describe('the qualification repo and launch recipes', () => {
	let dir = '';
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = '';
	});

	it('starts red, goes green with the one-character fix, and notices an edited test', () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'agent-qualification-'));
		writeQualificationRepo(dir);
		const before = checkQualificationRepo(dir);
		expect(before.testPasses).toBe(false);
		expect(before.testOutput).toMatch(/sum\(\[5\]\) should be 5/);
		expect(before.testFileChanged).toBe(false);

		const math = path.join(dir, 'math.js');
		writeFileSync(math, readFileSync(math, 'utf8').replace('let i = 1', 'let i = 0'));
		expect(checkQualificationRepo(dir)).toMatchObject({ testPasses: true, testFileChanged: false });

		writeFileSync(path.join(dir, 'test.js'), "console.log('PASS');\n");
		expect(checkQualificationRepo(dir).testFileChanged).toBe(true);
	});

	it('points each harness at the server with its own config home and the turn limit', () => {
		const claude = claudeCodeQualificationLaunch(SERVER, '/tmp/home');
		expect(claude.args).toEqual(
			expect.arrayContaining(['--model', 'm', '--max-turns', String(QUALIFICATION_MAX_TURNS)])
		);
		expect(claude.args.at(-1)).toBe(QUALIFICATION_PROMPT);
		expect(claude.env).toMatchObject({
			ANTHROPIC_BASE_URL: SERVER.baseUrl,
			ANTHROPIC_AUTH_TOKEN: 'sk-test',
			CLAUDE_CONFIG_DIR: '/tmp/home',
			CLAUDE_CODE_MAX_CONTEXT_TOKENS: '40960',
			CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(CLAUDE_CODE_LOCAL_MAX_OUTPUT_TOKENS),
		});

		const codex = codexQualificationLaunch(SERVER, '/tmp/home');
		// TOML literal strings: no double quote and no space, so a shell passes it whole.
		expect(codex.args.join(' ')).toContain(`base_url='${SERVER.baseUrl}/v1'`);
		expect(codex.args).toEqual(expect.arrayContaining(['exec', '--json', '-m', 'm']));
		expect(codex.args.at(-1)).toBe(QUALIFICATION_PROMPT);
		expect(codex.env).toEqual({ MAESTRO_LOCAL_KEY: 'sk-test', CODEX_HOME: '/tmp/home' });
	});
});
