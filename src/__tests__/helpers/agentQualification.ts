/**
 * The agent qualification: one scripted coding task a real harness (Claude
 * Code, Codex) runs against a local model through the Maestro model server, the
 * recipe each harness is launched with, and the rules that read what happened.
 *
 * The task, in a scratch git repo:
 *   1. read `notes.md`;
 *   2. fix the bug in `math.js` that the failing test shows;
 *   3. run `node test.js`;
 *   4. report the result.
 *
 * A run passes when `node test.js` goes green within `QUALIFICATION_MAX_TURNS`
 * model turns, `test.js` is untouched, the harness itself ran the test and saw
 * it pass, it reported back, and no tool call was malformed. A harness
 * qualifies a model when a majority of `QUALIFICATION_ATTEMPTS` runs pass, and
 * only a model qualified by at least one harness gets the catalog's `agent` role.
 *
 * NOT re-exported from `./index`: it imports `child_process`, and only the
 * opt-in qualification suite and its unit test need it.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import * as path from 'path';
import type { LocalModelAgentHarness } from '../../shared/local-models/types';
import { jsonLines, toolResultText } from './streamJson';

/** The most model turns a passing run may take. */
export const QUALIFICATION_MAX_TURNS = 10;

/** What the harness is told, verbatim. */
export const QUALIFICATION_PROMPT =
	'Read notes.md. Fix the bug in math.js that the failing test shows. Run `node test.js`. Report the result.';

/**
 * The scratch repo. The bug is an off-by-one that drops the first element, so
 * the failing assertion names the case (`sum([5]) should be 5`) and the fix is
 * one character. A model has to read the code, not guess from the file names.
 */
export const QUALIFICATION_FILES: Readonly<Record<string, string>> = Object.freeze({
	'notes.md': [
		'# Notes',
		'',
		'`test.js` checks the `sum` helper in `math.js`, and it is failing.',
		'Fix the bug in `math.js`. Do not change `test.js`.',
		'When `node test.js` prints PASS, the fix is done.',
		'',
	].join('\n'),
	'math.js': [
		'// Adds up every number in the list.',
		'function sum(values) {',
		'\tlet total = 0;',
		'\tfor (let i = 1; i < values.length; i++) {',
		'\t\ttotal += values[i];',
		'\t}',
		'\treturn total;',
		'}',
		'',
		'module.exports = { sum };',
		'',
	].join('\n'),
	'test.js': [
		"const assert = require('assert');",
		"const { sum } = require('./math');",
		'',
		"assert.strictEqual(sum([]), 0, 'sum([]) should be 0');",
		"assert.strictEqual(sum([5]), 5, 'sum([5]) should be 5');",
		"assert.strictEqual(sum([1, 2, 3, 4]), 10, 'sum([1, 2, 3, 4]) should be 10');",
		"console.log('PASS');",
		'',
	].join('\n'),
});

/** A git command in `cwd` with a throwaway identity, so no user config is needed. */
function git(cwd: string, args: string[]): string {
	return execFileSync(
		'git',
		['-c', 'user.name=Maestro e2e', '-c', 'user.email=e2e@example.invalid', ...args],
		{ cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
	);
}

/** Write the scratch repo into `dir` (created) and commit it, so a diff shows what the harness changed. */
export function writeQualificationRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(QUALIFICATION_FILES)) {
		writeFileSync(path.join(dir, name), content);
	}
	git(dir, ['init', '-q']);
	git(dir, ['add', '.']);
	git(dir, ['commit', '-q', '-m', 'Qualification task']);
}

/** The repo after the harness ran. */
export interface QualificationRepoState {
	/** `node test.js` exited 0 and printed PASS. */
	testPasses: boolean;
	/** One line of what `node test.js` printed: the error it threw, or its last line. */
	testOutput: string;
	/** The harness edited `test.js`, which the notes forbid. */
	testFileChanged: boolean;
}

/** Run the test and diff `test.js` against the committed version. */
export function checkQualificationRepo(dir: string): QualificationRepoState {
	let testPasses = false;
	let testOutput = '';
	try {
		testOutput = execFileSync('node', ['test.js'], {
			cwd: dir,
			encoding: 'utf8',
			timeout: 30_000,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		testPasses = /\bPASS\b/.test(testOutput);
	} catch (error) {
		const failed = error as { stdout?: string; stderr?: string };
		testOutput = `${failed.stdout ?? ''}${failed.stderr ?? ''}`;
	}
	const changed = git(dir, ['status', '--porcelain', '--', 'test.js']).trim();
	const line = /^\w*Error\b.*$/m.exec(testOutput)?.[0] ?? testOutput.trim().split('\n').pop() ?? '';
	return { testPasses, testOutput: line.slice(0, 300), testFileChanged: changed !== '' };
}

// ---------------------------------------------------------------------------
// Launch recipes: the same ones the model server e2e proves a turn with.
// ---------------------------------------------------------------------------

/** Where the model server is and what it serves. */
export interface QualificationServer {
	/** `http://127.0.0.1:<port>`, without a trailing `/v1`. */
	baseUrl: string;
	key: string;
	/** The catalog id, which the server serves the model under. */
	model: string;
	/** The context the server runs the model at. */
	contextSize: number;
}

/**
 * The output budget Claude Code reserves on a local model. Claude Code holds
 * back its maximum output (32,000 tokens by default) from the context window
 * before it decides to compact, which leaves about 9K of a 40,960-token window:
 * less than its own system prompt and tools in most tokenizers, so it compacts
 * on every turn and gives up ("Autocompact is thrashing"). A coding turn's
 * reply is far shorter than 8,192 tokens.
 */
export const CLAUDE_CODE_LOCAL_MAX_OUTPUT_TOKENS = 8192;

/**
 * Claude Code against the server's Anthropic route: the model for every tier,
 * the server's key as the token, the server's context with a local output
 * budget, and a config dir of its own (no login, hooks, MCP servers or user
 * memory, and the user's session list stays untouched).
 */
export function claudeCodeQualificationLaunch(
	server: QualificationServer,
	configDir: string
): { args: string[]; env: Record<string, string> } {
	return {
		args: [
			'--print',
			'--model',
			server.model,
			'--strict-mcp-config',
			'--permission-mode',
			'bypassPermissions',
			'--max-turns',
			String(QUALIFICATION_MAX_TURNS),
			'--output-format',
			'stream-json',
			'--verbose',
			QUALIFICATION_PROMPT,
		],
		env: {
			ANTHROPIC_BASE_URL: server.baseUrl,
			ANTHROPIC_AUTH_TOKEN: server.key,
			ANTHROPIC_DEFAULT_HAIKU_MODEL: server.model,
			CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(server.contextSize),
			CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(CLAUDE_CODE_LOCAL_MAX_OUTPUT_TOKENS),
			CLAUDE_CONFIG_DIR: configDir,
		},
	};
}

/**
 * Codex against the server's Responses route, as a provider of its own, with a
 * `CODEX_HOME` of its own (no user config, login or AGENTS.md) and the
 * workspace-write sandbox, so it can edit the repo and run `node`.
 */
export function codexQualificationLaunch(
	server: QualificationServer,
	codexHome: string
): { args: string[]; env: Record<string, string> } {
	return {
		args: [
			'-c',
			`model_providers.maestro={name='Maestro',base_url='${server.baseUrl}/v1',env_key='MAESTRO_LOCAL_KEY',wire_api='responses'}`,
			'-c',
			"model_provider='maestro'",
			'-c',
			`model_context_window=${server.contextSize}`,
			'exec',
			'--json',
			'--skip-git-repo-check',
			'--sandbox',
			'workspace-write',
			'-m',
			server.model,
			QUALIFICATION_PROMPT,
		],
		env: { MAESTRO_LOCAL_KEY: server.key, CODEX_HOME: codexHome },
	};
}

// ---------------------------------------------------------------------------
// Reading a run
// ---------------------------------------------------------------------------

/** What a harness's JSON stream says happened. */
export interface HarnessTranscript {
	/**
	 * Model turns the harness took. Claude Code reports its own count; for
	 * Codex it is the tool calls plus the final answer, since each tool result
	 * goes back to the model in a request of its own.
	 */
	turns: number;
	toolCalls: number;
	/** Evidence for each malformed tool call, trimmed. */
	malformedToolCalls: string[];
	/** The harness's last message to the user. */
	finalMessage: string;
	/** The harness stopped itself at its turn limit. */
	hitTurnLimit: boolean;
	/**
	 * The harness itself ran `node test.js` and saw it print PASS. A repo that is
	 * green without this was fixed by luck (a background subagent, an edit made
	 * while the model reported "no bug"), not by a model that checked its work.
	 */
	sawTestPass: boolean;
	/**
	 * Times Claude Code compacted its context during the run (its
	 * `compact_boundary` events). Codex's stream has no such event, so it is 0.
	 */
	compactions: number;
	/** What the harness reported as a failure of the run, or null. */
	error: string | null;
}

function emptyTranscript(): HarnessTranscript {
	return {
		turns: 0,
		toolCalls: 0,
		malformedToolCalls: [],
		finalMessage: '',
		hitTurnLimit: false,
		sawTestPass: false,
		compactions: 0,
		error: null,
	};
}

/**
 * A shell command that runs the qualification test, by a relative or an
 * absolute path (`node test.js`, `node ./test.js`, `node "/tmp/repo/test.js"`).
 */
const RUNS_TEST = /\bnode\s+["']?(?:[^\s"']*\/)?test\.js\b/;
/** What the test prints when it passes. */
const TEST_PASSED = /\bPASS\b/;

/**
 * Tool-call markup a chat template emits. Seen in a message's TEXT, it means
 * the server failed to parse a tool call and passed it through as prose: the
 * call never ran, which is a malformed call however the turn went on.
 */
const LEAKED_TOOL_MARKUP =
	/<tool_call>|<\/tool_call>|<\|tool_call|<function=|<\|channel\|>|<\|start\|>|\[TOOL_CALLS\]|<\|python_tag\|>/;

/**
 * Claude Code's words for a tool call it refused before running: arguments
 * that fail the tool's schema, or a tool name it does not have. A tool that ran
 * and failed (a missing file, a non-zero exit) is not malformed.
 */
const CLAUDE_MALFORMED_RESULT =
	/InputValidationError|No such tool available|Invalid tool parameters/i;

/** Codex's words for a function call it could not dispatch. */
const CODEX_MALFORMED_ERROR =
	/failed to parse|invalid (function )?arguments?|unknown (tool|function)|unsupported call/i;

function trimEvidence(text: string): string {
	return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Read Claude Code's `--output-format stream-json --verbose` output. */
export function readClaudeStream(stdout: string): HarnessTranscript {
	const transcript = emptyTranscript();
	let sawResult = false;
	/** Tool use ids of the calls that ran the test, to read their results. */
	const testRuns = new Set<string>();
	for (const event of jsonLines(stdout)) {
		const message = event.message as { content?: unknown } | undefined;
		const blocks = Array.isArray(message?.content)
			? (message.content as Array<Record<string, unknown>>)
			: [];
		if (event.type === 'assistant') {
			for (const block of blocks) {
				if (block.type === 'tool_use') {
					transcript.toolCalls++;
					const input = block.input as { command?: unknown } | undefined;
					if (RUNS_TEST.test(String(input?.command ?? ''))) testRuns.add(String(block.id));
				}
				if (block.type === 'text' && LEAKED_TOOL_MARKUP.test(String(block.text))) {
					transcript.malformedToolCalls.push(trimEvidence(String(block.text)));
				}
			}
		} else if (event.type === 'user') {
			for (const block of blocks) {
				if (block.type !== 'tool_result') continue;
				const text = toolResultText(block.content);
				if (block.is_error !== true) {
					if (testRuns.has(String(block.tool_use_id)) && TEST_PASSED.test(text)) {
						transcript.sawTestPass = true;
					}
				} else if (CLAUDE_MALFORMED_RESULT.test(text)) {
					transcript.malformedToolCalls.push(trimEvidence(text));
				}
			}
		} else if (event.type === 'system' && event.subtype === 'compact_boundary') {
			transcript.compactions++;
		} else if (event.type === 'result') {
			sawResult = true;
			transcript.turns = typeof event.num_turns === 'number' ? event.num_turns : 0;
			transcript.finalMessage = typeof event.result === 'string' ? event.result.trim() : '';
			transcript.hitTurnLimit = event.subtype === 'error_max_turns';
			if (event.is_error === true || event.subtype !== 'success') {
				transcript.error = trimEvidence(transcript.finalMessage || String(event.subtype));
			}
		}
	}
	if (!sawResult) transcript.error = 'The stream ended without a result.';
	return transcript;
}

/** Read `codex exec --json` output. */
export function readCodexStream(stdout: string): HarnessTranscript {
	const transcript = emptyTranscript();
	let completed = false;
	for (const event of jsonLines(stdout)) {
		if (event.type === 'item.completed') {
			const item = (event.item ?? {}) as Record<string, unknown>;
			switch (item.type) {
				case 'command_execution':
					transcript.toolCalls++;
					if (
						RUNS_TEST.test(String(item.command ?? '')) &&
						item.exit_code === 0 &&
						TEST_PASSED.test(String(item.aggregated_output ?? ''))
					) {
						transcript.sawTestPass = true;
					}
					break;
				case 'file_change':
				case 'mcp_tool_call':
				case 'web_search':
					transcript.toolCalls++;
					break;
				case 'agent_message': {
					const text = String(item.text ?? '');
					transcript.finalMessage = text.trim();
					if (LEAKED_TOOL_MARKUP.test(text)) {
						transcript.malformedToolCalls.push(trimEvidence(text));
					}
					break;
				}
				case 'error': {
					// Also carries warnings ("Model metadata ... not found"), which are not
					// a failure of the run; only a refused call counts.
					const text = String(item.message ?? '');
					if (CODEX_MALFORMED_ERROR.test(text)) {
						transcript.malformedToolCalls.push(trimEvidence(text));
					}
					break;
				}
			}
		} else if (event.type === 'turn.completed') {
			completed = true;
		} else if (event.type === 'turn.failed') {
			const failure = event.error as { message?: string } | undefined;
			transcript.error = trimEvidence(failure?.message ?? 'The turn failed.');
		} else if (event.type === 'error') {
			transcript.error = trimEvidence(String(event.message ?? 'Codex reported an error.'));
		}
	}
	transcript.turns = transcript.toolCalls + (transcript.finalMessage ? 1 : 0);
	transcript.hitTurnLimit = transcript.turns > QUALIFICATION_MAX_TURNS;
	if (!completed && !transcript.error)
		transcript.error = 'The stream ended without a completed turn.';
	return transcript;
}

/** The bytes the server log holds now, so a run reads only what it caused. 0 for no log yet. */
export function serverLogSize(logPath: string): number {
	return existsSync(logPath) ? statSync(logPath).size : 0;
}

/** What the server log gained since `from` bytes; all of it when the capped log rotated. */
export function serverLogSince(logPath: string, from: number): string {
	if (!existsSync(logPath)) return '';
	const text = readFileSync(logPath);
	return (text.length >= from ? text.subarray(from) : text).toString('utf8');
}

/** Generation and prompt throughput, summed over the requests the server served. */
export interface ServerTimings {
	requests: number;
	generatedTokens: number;
	generationMs: number;
	promptTokens: number;
	promptMs: number;
}

/** `prompt eval time =  402.59 ms /  102 tokens` and `eval time = 11.09 ms / 2 tokens`. */
const TIMING_LINE = /(prompt )?eval time =\s*([\d.]+) ms \/\s*(\d+) tokens/;

/**
 * Sum the per-request timings `llama-server` prints into its log
 * (`print_timing`), over the slice of the log a run wrote. Every request counts,
 * including a harness's side calls (a title, a summary), since they share the
 * same model and the same wait.
 */
export function readServerTimings(log: string): ServerTimings {
	const timings: ServerTimings = {
		requests: 0,
		generatedTokens: 0,
		generationMs: 0,
		promptTokens: 0,
		promptMs: 0,
	};
	for (const line of log.split('\n')) {
		const match = TIMING_LINE.exec(line);
		if (!match) continue;
		const ms = Number(match[2]);
		const tokens = Number(match[3]);
		if (match[1]) {
			timings.promptMs += ms;
			timings.promptTokens += tokens;
		} else {
			timings.requests++;
			timings.generationMs += ms;
			timings.generatedTokens += tokens;
		}
	}
	return timings;
}

/** Tokens per second to one decimal, or null when nothing was timed. */
export function tokensPerSecond(tokens: number, ms: number): number | null {
	if (tokens <= 0 || ms <= 0) return null;
	return Math.round((tokens / ms) * 10_000) / 10;
}

/** Why a run did not qualify the model. */
export type QualificationFailure =
	| 'timeout'
	| 'malformed-tool-call'
	| 'test-file-changed'
	| 'too-many-turns'
	| 'harness-error'
	| 'test-still-failing'
	| 'never-ran-test'
	| 'no-report';

export interface QualificationVerdict {
	passed: boolean;
	failure: QualificationFailure | null;
	/** One line on what went wrong, or null for a pass. */
	detail: string | null;
}

/**
 * Judge one run. The checks run in order of what most explains a failure: a
 * killed run tells nothing else, a malformed call fails even a green test, and
 * a test that was edited proves nothing about the fix.
 */
export function judgeQualification(input: {
	transcript: HarnessTranscript;
	repo: QualificationRepoState;
	timedOut: boolean;
}): QualificationVerdict {
	const { transcript, repo, timedOut } = input;
	const fail = (failure: QualificationFailure, detail: string): QualificationVerdict => ({
		passed: false,
		failure,
		detail,
	});
	if (timedOut) return fail('timeout', 'The harness was still running at the time limit.');
	if (transcript.malformedToolCalls.length > 0) {
		return fail('malformed-tool-call', transcript.malformedToolCalls[0]);
	}
	if (repo.testFileChanged) return fail('test-file-changed', 'The harness edited test.js.');
	if (!repo.testPasses) {
		if (transcript.hitTurnLimit) {
			return fail('too-many-turns', `Stopped at ${transcript.turns} turns with the test failing.`);
		}
		if (transcript.error) return fail('harness-error', transcript.error);
		return fail('test-still-failing', repo.testOutput || 'node test.js failed.');
	}
	if (transcript.turns > QUALIFICATION_MAX_TURNS || transcript.hitTurnLimit) {
		return fail(
			'too-many-turns',
			`The test went green, but the run took ${transcript.turns} turns (limit ${QUALIFICATION_MAX_TURNS}).`
		);
	}
	if (!transcript.sawTestPass) {
		return fail('never-ran-test', 'The test is green, but the harness never ran it and saw PASS.');
	}
	if (transcript.error) return fail('harness-error', transcript.error);
	if (!transcript.finalMessage) return fail('no-report', 'The harness never reported the result.');
	return { passed: true, failure: null, detail: null };
}

/** The result row the suite records and the doc's table is written from. */
export interface QualificationRecord {
	harness: LocalModelAgentHarness;
	checkedAt: string;
	passed: boolean;
	failure: QualificationFailure | null;
	detail: string | null;
	turns: number;
	toolCalls: number;
	wallMs: number;
	/** Generation throughput over every request the run made. */
	tokensPerSecond: number | null;
	promptTokensPerSecond: number | null;
	requests: number;
	compactions: number;
}

/**
 * Attempts per model and harness. Sampling makes one run a coin flip near the
 * edge of a model's ability (a 1.7B model can stumble into a green test once),
 * so a harness qualifies a model only when a MAJORITY of its attempts pass.
 */
export const QUALIFICATION_ATTEMPTS = 3;

/** Whether the attempts so far already decide the majority, so the rest can be skipped. */
export function qualificationSettled(
	runs: readonly Pick<QualificationRecord, 'passed'>[],
	attempts = QUALIFICATION_ATTEMPTS
): boolean {
	const majority = Math.floor(attempts / 2) + 1;
	const passes = runs.filter((run) => run.passed).length;
	return passes >= majority || runs.length - passes >= majority || runs.length >= attempts;
}

/** Whether a majority of `attempts` passed. */
export function harnessQualified(
	runs: readonly Pick<QualificationRecord, 'passed'>[],
	attempts = QUALIFICATION_ATTEMPTS
): boolean {
	return runs.filter((run) => run.passed).length >= Math.floor(attempts / 2) + 1;
}
