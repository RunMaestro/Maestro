// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/maestro-p/args.test.ts
// Source: src/__tests__/maestro-p/jsonl-tailer.test.ts
// Source: src/__tests__/maestro-p/json-emitter.test.ts
// Source: src/__tests__/maestro-p/billing-mode.test.ts
// Source: src/__tests__/maestro-p/screen-replay.test.ts
// Source: src/__tests__/maestro-p/api-error-row.test.ts
// Source: src/__tests__/maestro-p/child-env.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	parseArgs,
	DEFAULT_MAX_WAIT_SECONDS,
	DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS,
	DEFAULT_READY_TIMEOUT_SECONDS,
} from '../../maestro-p/args';
import * as fs from 'fs';
import * as s2_os from 'os';
import * as path from 'path';
import {
	JsonlTailer,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_EXISTS_TIMEOUT_MS,
	type ParseErrorPayload,
} from '../../maestro-p/jsonl-tailer';
import {
	JsonEmitter,
	type EmitResultOptions,
	type StatusSnapshot,
} from '../../maestro-p/json-emitter';
import { diagnoseApiUsageBilling, showsApiUsageBilling } from '../../maestro-p/billing-mode';
import { getErrorPatterns, matchErrorPattern } from '../../shared/agentErrorPatterns';
import { capturedAlternateScreen, replayTerminalScreen } from '../../maestro-p/screen-replay';
import {
	isRateLimitErrorRow,
	terminalApiErrorTag,
	TERMINAL_API_ERROR_TAGS,
} from '../../maestro-p/api-error-row';
/**
 * @file child-env.test.ts
 * @description Tests for src/maestro-p/child-env.ts - the environment maestro-p
 * hands the claude TUI it spawns.
 */
import * as s7_os from 'os';
import { buildChildEnv, CLAUDE_SESSION_IDENTITY_ENV_VARS } from '../../maestro-p/child-env';
import { STEERING_SOCKET_ENV_VAR } from '../../shared/chatSteering';
// Source: src/__tests__/maestro-p/args.test.ts
describe('', () => {
	describe('parseArgs', () => {
		let warnSpy: ReturnType<typeof vi.fn<(message: string) => void>>;
		beforeEach(() => {
			warnSpy = vi.fn<(message: string) => void>();
		});
		const callArgs = (
			argv: string[],
			overrides: {
				stdinIsTTY?: boolean;
				readStdin?: () => string;
			} = {}
		) =>
			parseArgs(argv, {
				stdinIsTTY: overrides.stdinIsTTY ?? true,
				readStdin: overrides.readStdin,
				warn: warnSpy,
			});
		describe('prompt source resolution', () => {
			it('takes the prompt from -p when supplied', () => {
				const result = callArgs(['-p', 'hello world']);
				expect(result.prompt).toBe('hello world');
				expect(result.mode).toBe('run');
				expect(result.passThroughArgs).toEqual([]);
			});
			it('takes the prompt from --print when supplied', () => {
				const result = callArgs(['--print', 'hello']);
				expect(result.prompt).toBe('hello');
			});
			it('takes the prompt from --prompt when supplied', () => {
				const result = callArgs(['--prompt', 'hello']);
				expect(result.prompt).toBe('hello');
			});
			it('takes the prompt from --prompt=value (inline) form', () => {
				const result = callArgs(['--prompt=hello inline']);
				expect(result.prompt).toBe('hello inline');
			});
			it('takes the prompt from the first non-flag positional', () => {
				const result = callArgs(['what is 2+2?']);
				expect(result.prompt).toBe('what is 2+2?');
				expect(result.passThroughArgs).toEqual([]);
			});
			it('preserves a multi-word positional prompt as a single argv slot', () => {
				const result = callArgs(['summarize this paragraph for me please']);
				expect(result.prompt).toBe('summarize this paragraph for me please');
			});
			it('reads stdin when no prompt flag/positional and stdin is not a TTY', () => {
				const result = callArgs([], {
					stdinIsTTY: false,
					readStdin: () => 'piped prompt\n',
				});
				expect(result.prompt).toBe('piped prompt');
			});
			it('returns prompt=null when no source available and stdin is a TTY', () => {
				const result = callArgs([]);
				expect(result.prompt).toBeNull();
			});
			it('returns prompt=null when stdin is not a TTY but stream is empty', () => {
				const result = callArgs([], {
					stdinIsTTY: false,
					readStdin: () => '   \n  \n',
				});
				expect(result.prompt).toBeNull();
			});
			it('prefers -p over a positional when both are present', () => {
				const result = callArgs(['-p', 'flag prompt', 'positional prompt']);
				expect(result.prompt).toBe('flag prompt');
				// The unconsumed positional falls through to passthrough.
				expect(result.passThroughArgs).toEqual(['positional prompt']);
			});
		});
		describe('--status mode', () => {
			it('switches mode to status and ignores prompt input', () => {
				const result = callArgs(['--status']);
				expect(result.mode).toBe('status');
				expect(result.prompt).toBeNull();
			});
			it('does not read stdin in status mode even when piped', () => {
				const stdinReader = vi.fn(() => 'should be ignored');
				const result = callArgs(['--status'], {
					stdinIsTTY: false,
					readStdin: stdinReader,
				});
				expect(result.mode).toBe('status');
				expect(result.prompt).toBeNull();
				expect(stdinReader).not.toHaveBeenCalled();
			});
			it('still preserves pass-through claude flags in status mode', () => {
				const result = callArgs(['--status', '--cwd', '/tmp']);
				expect(result.mode).toBe('status');
				expect(result.passThroughArgs).toEqual(['--cwd', '/tmp']);
			});
		});
		describe('pass-through forwarding', () => {
			it('forwards unknown flags verbatim, in original order', () => {
				const result = callArgs(['-p', 'hi', '--model', 'opus', '--cwd', '/tmp']);
				expect(result.prompt).toBe('hi');
				expect(result.passThroughArgs).toEqual(['--model', 'opus', '--cwd', '/tmp']);
			});
			it('forwards a value following a passthrough flag (e.g. --model opus)', () => {
				const result = callArgs(['--model', 'opus', 'what is 2+2?']);
				expect(result.passThroughArgs).toEqual(['--model', 'opus']);
				expect(result.prompt).toBe('what is 2+2?');
			});
			it('forwards every value of a variadic flag (--allowedTools a b c)', () => {
				const result = callArgs(['--allowedTools', 'Read', 'Glob', 'Grep', '--', 'the prompt']);
				expect(result.passThroughArgs).toEqual(['--allowedTools', 'Read', 'Glob', 'Grep']);
				expect(result.prompt).toBe('the prompt');
			});
			it('does not let an unknown boolean swallow the next flag or the -- marker', () => {
				const result = callArgs(['--fork-session', '--model', 'opus', '--no-color', '--', 'hi']);
				expect(result.passThroughArgs).toEqual(['--fork-session', '--model', 'opus', '--no-color']);
				expect(result.prompt).toBe('hi');
			});
			it('still takes a dash-led value that is not a flag (e.g. frontmatter)', () => {
				const result = callArgs(['--append-system-prompt', '---\ntitle: x', '-p', 'hi']);
				expect(result.passThroughArgs).toEqual(['--append-system-prompt', '---\ntitle: x']);
			});
			it('parses the wizard spawn line: real prompt, read-only tools, no print-only flags', () => {
				const result = callArgs([
					'--print',
					'--verbose',
					'--output-format',
					'stream-json',
					'--include-partial-messages',
					'--allowedTools',
					'Read',
					'Glob',
					'Grep',
					'LS',
					'--model',
					'opus[1m]',
					'--',
					'Tell me about the project',
				]);
				expect(result.prompt).toBe('Tell me about the project');
				expect(result.passThroughArgs).toEqual([
					'--allowedTools',
					'Read',
					'Glob',
					'Grep',
					'LS',
					'--model',
					'opus[1m]',
				]);
				expect(warnSpy).not.toHaveBeenCalled();
			});
		});
		describe('stripped flags', () => {
			it('drops --output-format and its value with a stderr warning', () => {
				const result = callArgs(['--output-format', 'json', '-p', 'hi']);
				expect(result.passThroughArgs).toEqual([]);
				expect(result.prompt).toBe('hi');
				expect(warnSpy).toHaveBeenCalledTimes(1);
				expect(warnSpy.mock.calls[0][0]).toMatch(/--output-format/);
			});
			it('drops --output-format=json (inline form) with one warning', () => {
				const result = callArgs(['--output-format=json', '-p', 'hi']);
				expect(result.passThroughArgs).toEqual([]);
				expect(result.prompt).toBe('hi');
				expect(warnSpy).toHaveBeenCalledTimes(1);
			});
			it('warns on --input-format text and leaves streamJsonInput false', () => {
				const result = callArgs(['--input-format', 'text', '-p', 'hi']);
				expect(result.passThroughArgs).toEqual([]);
				expect(result.streamJsonInput).toBe(false);
				expect(warnSpy).toHaveBeenCalledTimes(1);
				expect(warnSpy.mock.calls[0][0]).toMatch(/--input-format/);
			});
			it('flips streamJsonInput on --input-format stream-json without forwarding the flag', () => {
				const result = callArgs(['--input-format', 'stream-json', '-p', 'hi']);
				expect(result.streamJsonInput).toBe(true);
				expect(result.passThroughArgs).toEqual([]);
				expect(warnSpy).not.toHaveBeenCalled();
			});
			it('accepts --input-format=stream-json (inline form)', () => {
				const result = callArgs(['--input-format=stream-json', '-p', 'hi']);
				expect(result.streamJsonInput).toBe(true);
				expect(result.passThroughArgs).toEqual([]);
			});
			it('drops --verbose without a warning, since the output is already verbose-shaped', () => {
				const result = callArgs(['--verbose', '-p', 'hi']);
				expect(result.passThroughArgs).toEqual([]);
				expect(warnSpy).not.toHaveBeenCalled();
			});
			it('drops the --print-only partial/replay flags the TUI refuses to start with', () => {
				const result = callArgs([
					'--include-partial-messages',
					'--replay-user-messages',
					'-p',
					'hi',
				]);
				expect(result.passThroughArgs).toEqual([]);
				expect(result.prompt).toBe('hi');
				expect(warnSpy).not.toHaveBeenCalled();
			});
			it('drops --output-format stream-json without a warning', () => {
				const result = callArgs(['--output-format', 'stream-json', '-p', 'hi']);
				expect(result.passThroughArgs).toEqual([]);
				expect(result.prompt).toBe('hi');
				expect(warnSpy).not.toHaveBeenCalled();
			});
			// Regression: when Maestro forwards its API-mode claude args verbatim
			// to a custom-path maestro-p (the opt-in route), the argv looks like
			// `--print --verbose --output-format stream-json --dangerously-skip-permissions <prompt>`.
			// Before the flag-guard in consumeValue(), --print greedily consumed
			// --verbose as its prompt value and the real positional prompt was
			// dropped into passthrough - the TUI then received "--verbose" as the
			// user message.
			it('does not consume a flag-looking next token as the prompt value for --print', () => {
				const result = callArgs([
					'--print',
					'--verbose',
					'--output-format',
					'stream-json',
					'--dangerously-skip-permissions',
					'real prompt',
				]);
				expect(result.prompt).toBe('real prompt');
				expect(result.passThroughArgs).toEqual(['--dangerously-skip-permissions']);
				// --output-format is the STRIPPED branch (claude's API-mode flag), not
				// --input-format, so streamJsonInput stays false here.
				expect(result.streamJsonInput).toBe(false);
				// Maestro passes exactly this line on every spawn, and maestro-p honors
				// all of it, so none of it may produce a warning.
				expect(warnSpy).not.toHaveBeenCalled();
			});
			it('does not consume a flag-looking next token as the prompt value for -p', () => {
				const result = callArgs(['-p', '--verbose', 'real prompt']);
				expect(result.prompt).toBe('real prompt');
				// A bare -p is claude's print-mode switch, not a missing value.
				expect(warnSpy).not.toHaveBeenCalled();
			});
			it('still warns when --prompt has no value', () => {
				callArgs(['--prompt', '--verbose', 'real prompt']);
				const messages = warnSpy.mock.calls.map((c) => c[0]).join('\n');
				expect(messages).toMatch(/--prompt requires a value/);
			});
			it('warns when --output-format asks for something other than stream-json', () => {
				const result = callArgs(['--output-format', 'json', 'real prompt']);
				expect(result.prompt).toBe('real prompt');
				const messages = warnSpy.mock.calls.map((c) => c[0]).join('\n');
				expect(messages).toMatch(
					/ignoring --output-format json - maestro-p always writes stream-json/
				);
			});
			it('accepts --output-format=stream-json inline without a warning', () => {
				const result = callArgs(['--output-format=stream-json', 'real prompt']);
				expect(result.prompt).toBe('real prompt');
				expect(warnSpy).not.toHaveBeenCalled();
			});
			it('still accepts a flag-looking prompt via the inline form', () => {
				const result = callArgs(['--prompt=--foo bar', '--dangerously-skip-permissions']);
				expect(result.prompt).toBe('--foo bar');
			});
			// Regression: Maestro's ChildProcessSpawner appends the prompt after a `--`
			// end-of-options marker (`… --dangerously-skip-permissions -- <prompt>`).
			// Without explicit `--` handling, the generic long-flag branch in the
			// parser swallowed `--` and consumed the prompt as its "value", so the
			// runner aborted with "no prompt provided".
			it('treats `--` as the end-of-options marker (full Maestro spawn line)', () => {
				const result = callArgs([
					'--print',
					'--verbose',
					'--output-format',
					'stream-json',
					'--dangerously-skip-permissions',
					'--',
					'howdy',
				]);
				expect(result.prompt).toBe('howdy');
				expect(result.passThroughArgs).toEqual(['--dangerously-skip-permissions']);
			});
			it('preserves additional positionals after `--` in pass-through, in order', () => {
				const result = callArgs(['--', 'first prompt', 'extra', 'more']);
				expect(result.prompt).toBe('first prompt');
				expect(result.passThroughArgs).toEqual(['extra', 'more']);
			});
		});
		describe('--max-wait', () => {
			it('parses an integer value and returns it in seconds', () => {
				const result = callArgs(['--max-wait', '60', '-p', 'hi']);
				expect(result.maxWaitSeconds).toBe(60);
				expect(result.passThroughArgs).toEqual([]);
			});
			it('parses --max-wait=60 (inline form)', () => {
				const result = callArgs(['--max-wait=60', '-p', 'hi']);
				expect(result.maxWaitSeconds).toBe(60);
			});
			it('uses the default when --max-wait is missing', () => {
				const result = callArgs(['-p', 'hi']);
				expect(result.maxWaitSeconds).toBe(DEFAULT_MAX_WAIT_SECONDS);
			});
			it('warns and falls back to the default for non-integer values', () => {
				const result = callArgs(['--max-wait', 'not-a-number', '-p', 'hi']);
				expect(result.maxWaitSeconds).toBe(DEFAULT_MAX_WAIT_SECONDS);
				expect(warnSpy).toHaveBeenCalledTimes(1);
			});
			it('warns and falls back to the default for zero or negative values', () => {
				const result = callArgs(['--max-wait', '0', '-p', 'hi']);
				expect(result.maxWaitSeconds).toBe(DEFAULT_MAX_WAIT_SECONDS);
				expect(warnSpy).toHaveBeenCalledTimes(1);
			});
		});
		describe('--first-byte-timeout', () => {
			it('parses an integer value and returns it in seconds', () => {
				const result = callArgs(['--first-byte-timeout', '45', '-p', 'hi']);
				expect(result.firstByteTimeoutSeconds).toBe(45);
				expect(result.passThroughArgs).toEqual([]);
			});
			it('parses --first-byte-timeout=45 (inline form)', () => {
				const result = callArgs(['--first-byte-timeout=45', '-p', 'hi']);
				expect(result.firstByteTimeoutSeconds).toBe(45);
			});
			it('uses the default when missing', () => {
				const result = callArgs(['-p', 'hi']);
				expect(result.firstByteTimeoutSeconds).toBe(DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS);
			});
			it('warns and falls back to the default for non-integer values', () => {
				const result = callArgs(['--first-byte-timeout', 'nope', '-p', 'hi']);
				expect(result.firstByteTimeoutSeconds).toBe(DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS);
				expect(warnSpy).toHaveBeenCalledTimes(1);
			});
			it('clamps the first-byte budget to --max-wait when the latter is smaller', () => {
				// A caller with a tight overall budget should not keep waiting for a
				// first byte past the point it wanted the whole run abandoned.
				const result = callArgs(['--max-wait', '30', '-p', 'hi']);
				expect(result.maxWaitSeconds).toBe(30);
				expect(result.firstByteTimeoutSeconds).toBe(30);
			});
			it('leaves the first-byte budget untouched when below --max-wait', () => {
				const result = callArgs(['--max-wait', '600', '--first-byte-timeout', '90', '-p', 'hi']);
				expect(result.maxWaitSeconds).toBe(600);
				expect(result.firstByteTimeoutSeconds).toBe(90);
			});
		});
		describe('--ready-timeout', () => {
			it('defaults well above the old fixed 8s boot ceiling (issue #1765)', () => {
				const result = callArgs(['-p', 'hi']);
				expect(result.readyTimeoutSeconds).toBe(DEFAULT_READY_TIMEOUT_SECONDS);
				expect(DEFAULT_READY_TIMEOUT_SECONDS).toBeGreaterThan(8);
			});
			it('parses --ready-timeout 60 and consumes it (not in passThroughArgs)', () => {
				const result = callArgs(['--ready-timeout', '60', '-p', 'hi']);
				expect(result.readyTimeoutSeconds).toBe(60);
				expect(result.passThroughArgs).toEqual([]);
			});
			it('parses --ready-timeout=60 (inline form)', () => {
				const result = callArgs(['--ready-timeout=60', '-p', 'hi']);
				expect(result.readyTimeoutSeconds).toBe(60);
			});
			it('warns and falls back to the default on a non-positive value', () => {
				const result = callArgs(['--ready-timeout', '0', '-p', 'hi']);
				expect(result.readyTimeoutSeconds).toBe(DEFAULT_READY_TIMEOUT_SECONDS);
				expect(warnSpy).toHaveBeenCalledTimes(1);
			});
			it('clamps the ready budget to the first-byte budget, whose timer spans the handshake', () => {
				const result = callArgs([
					'--first-byte-timeout',
					'20',
					'--ready-timeout',
					'45',
					'-p',
					'hi',
				]);
				expect(result.firstByteTimeoutSeconds).toBe(20);
				expect(result.readyTimeoutSeconds).toBe(20);
			});
		});
		describe('--stream-thinking', () => {
			it('toggles streamThinking and is consumed (not in passThroughArgs)', () => {
				const result = callArgs(['--stream-thinking', '-p', 'hi']);
				expect(result.streamThinking).toBe(true);
				expect(result.passThroughArgs).toEqual([]);
			});
			it('defaults streamThinking to false', () => {
				const result = callArgs(['-p', 'hi']);
				expect(result.streamThinking).toBe(false);
			});
		});
		describe('--resume', () => {
			it('exposes the session id on the typed field AND keeps it in passThroughArgs', () => {
				const result = callArgs(['--resume', 'abc-123', '-p', 'continue please']);
				expect(result.resumeSessionId).toBe('abc-123');
				// Must still reach claude verbatim so the TUI resumes the same session.
				expect(result.passThroughArgs).toEqual(['--resume', 'abc-123']);
				expect(result.prompt).toBe('continue please');
			});
			it('handles --resume=<id> (inline form)', () => {
				const result = callArgs(['--resume=abc-123', '-p', 'continue']);
				expect(result.resumeSessionId).toBe('abc-123');
				expect(result.passThroughArgs).toEqual(['--resume=abc-123']);
			});
			it('defaults resumeSessionId to null when --resume is absent', () => {
				const result = callArgs(['-p', 'hi']);
				expect(result.resumeSessionId).toBeNull();
			});
			it('passes the bare flag through if no value follows (claude can error)', () => {
				const result = callArgs(['--resume']);
				expect(result.resumeSessionId).toBeNull();
				expect(result.passThroughArgs).toEqual(['--resume']);
			});
			it('coexists with --input-format stream-json (follow-up image turn)', () => {
				const fakeEnvelope = JSON.stringify({
					type: 'user',
					message: { role: 'user', content: [{ type: 'text', text: 'follow up' }] },
				});
				const result = callArgs(['--resume', 'session-xyz', '--input-format', 'stream-json'], {
					stdinIsTTY: false,
					readStdin: () => fakeEnvelope,
				});
				expect(result.resumeSessionId).toBe('session-xyz');
				expect(result.streamJsonInput).toBe(true);
				expect(result.prompt).toBe(fakeEnvelope);
				// --input-format is consumed by maestro-p; only --resume reaches claude.
				expect(result.passThroughArgs).toEqual(['--resume', 'session-xyz']);
			});
		});
		describe('consumed boolean help/version flags', () => {
			it('drops --help from passThroughArgs', () => {
				const result = callArgs(['--help']);
				expect(result.passThroughArgs).toEqual([]);
			});
			it('drops -h from passThroughArgs', () => {
				const result = callArgs(['-h']);
				expect(result.passThroughArgs).toEqual([]);
			});
			it('drops --version from passThroughArgs', () => {
				const result = callArgs(['--version']);
				expect(result.passThroughArgs).toEqual([]);
			});
		});
	});
});
// Source: src/__tests__/maestro-p/jsonl-tailer.test.ts
describe('', () => {
	const FAST_POLL_MS = 10;
	async function waitUntil(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
		if (!predicate()) {
			throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
		}
	}
	async function sleep(ms: number): Promise<void> {
		await new Promise<void>((resolve) => setTimeout(resolve, ms));
	}
	interface TailerHarness {
		tailer: JsonlTailer;
		filePath: string;
		entries: unknown[];
		parseErrors: ParseErrorPayload[];
	}
	describe('JsonlTailer', () => {
		let tempDir: string;
		let activeTailer: JsonlTailer | null;
		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(s2_os.tmpdir(), 'maestro-p-tailer-'));
			activeTailer = null;
		});
		afterEach(() => {
			activeTailer?.stop();
			activeTailer = null;
			fs.rmSync(tempDir, { recursive: true, force: true });
		});
		function makeHarness(
			name: string,
			opts: {
				skipExisting?: boolean;
				pollIntervalMs?: number;
				existsTimeoutMs?: number;
			} = {}
		): TailerHarness {
			const filePath = path.join(tempDir, name);
			const tailer = new JsonlTailer({
				path: filePath,
				pollIntervalMs: opts.pollIntervalMs ?? FAST_POLL_MS,
				skipExisting: opts.skipExisting,
				existsTimeoutMs: opts.existsTimeoutMs,
			});
			activeTailer = tailer;
			const entries: unknown[] = [];
			const parseErrors: ParseErrorPayload[] = [];
			tailer.on('entry', (entry: unknown) => entries.push(entry));
			tailer.on('parse-error', (err: unknown) => parseErrors.push(err as ParseErrorPayload));
			return { tailer, filePath, entries, parseErrors };
		}
		// claude writes its cost-state row as it exits; finalize reads it with
		// drain() rather than waiting out a poll interval.
		describe('drain', () => {
			it('emits rows written since the last poll without waiting for the next one', async () => {
				const { tailer, filePath, entries } = makeHarness('drain.jsonl', { pollIntervalMs: 60000 });
				fs.writeFileSync(filePath, '');
				await tailer.start();
				fs.appendFileSync(filePath, JSON.stringify({ type: 'cost-state' }) + '\n');
				tailer.drain();
				expect(entries).toEqual([{ type: 'cost-state' }]);
			});
			it('does nothing once stopped', async () => {
				const { tailer, filePath, entries } = makeHarness('drain-stopped.jsonl', {
					pollIntervalMs: 60000,
				});
				fs.writeFileSync(filePath, '');
				await tailer.start();
				tailer.stop();
				fs.appendFileSync(filePath, JSON.stringify({ type: 'cost-state' }) + '\n');
				tailer.drain();
				expect(entries).toEqual([]);
			});
		});
		describe('exposed constants', () => {
			it('DEFAULT_POLL_INTERVAL_MS = 75 (snappy for streaming, cheap for idle)', () => {
				expect(DEFAULT_POLL_INTERVAL_MS).toBe(75);
			});
			it('DEFAULT_EXISTS_TIMEOUT_MS = 5000 (matches the spec fresh-session race window)', () => {
				expect(DEFAULT_EXISTS_TIMEOUT_MS).toBe(5000);
			});
		});
		describe('skipExisting: false (default)', () => {
			it('emits every pre-existing line as an entry, in order', async () => {
				const { tailer, filePath, entries } = makeHarness('pre.jsonl');
				fs.writeFileSync(filePath, '{"i":1}\n{"i":2}\n{"i":3}\n');
				await tailer.start();
				await waitUntil(() => entries.length === 3);
				expect(entries).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
			});
		});
		describe('skipExisting: true', () => {
			it('ignores pre-existing content', async () => {
				const { tailer, filePath, entries } = makeHarness('skip.jsonl', { skipExisting: true });
				fs.writeFileSync(filePath, '{"i":1}\n{"i":2}\n');
				vi.useFakeTimers();
				try {
					await tailer.start();
					// Drive several scheduler ticks to confirm nothing leaks through.
					await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 5);
					expect(entries).toEqual([]);
				} finally {
					vi.useRealTimers();
				}
			});
			it('emits only entries appended after start()', async () => {
				const { tailer, filePath, entries } = makeHarness('skip-append.jsonl', {
					skipExisting: true,
				});
				fs.writeFileSync(filePath, '{"old":true}\n');
				await tailer.start();
				fs.appendFileSync(filePath, '{"new":true}\n');
				await waitUntil(() => entries.length === 1);
				expect(entries).toEqual([{ new: true }]);
			});
		});
		describe('post-start appends', () => {
			it('emits each appended entry in order', async () => {
				const { tailer, filePath, entries } = makeHarness('seq.jsonl');
				fs.writeFileSync(filePath, '');
				await tailer.start();
				fs.appendFileSync(filePath, '{"i":1}\n{"i":2}\n{"i":3}\n');
				await waitUntil(() => entries.length === 3);
				expect(entries).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
			});
		});
		describe('partial-line buffering', () => {
			it('does not parse a truncated line; finalizes once the newline arrives', async () => {
				const { tailer, filePath, entries, parseErrors } = makeHarness('partial.jsonl');
				fs.writeFileSync(filePath, '');
				await tailer.start();
				// First write leaves a partial trailing line - the tailer must
				// emit only the completed entry and buffer the rest, NOT throw a
				// parse-error on the half-formed `{"b":`.
				fs.appendFileSync(filePath, '{"a":1}\n{"b":');
				await waitUntil(() => entries.length === 1);
				expect(entries).toEqual([{ a: 1 }]);
				expect(parseErrors).toEqual([]);
				// Second write completes the buffered line.
				fs.appendFileSync(filePath, '2}\n');
				await waitUntil(() => entries.length === 2);
				expect(entries).toEqual([{ a: 1 }, { b: 2 }]);
				expect(parseErrors).toEqual([]);
			});
		});
		describe('empty lines', () => {
			it('skips empty lines silently (no entries, no parse-errors)', async () => {
				const { tailer, filePath, entries, parseErrors } = makeHarness('empties.jsonl');
				fs.writeFileSync(filePath, '\n\n{"present":true}\n\n');
				vi.useFakeTimers();
				try {
					await tailer.start();
					// Let scheduler ticks process the real file and expose any erroneous trailing empties.
					await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 3);
					expect(entries).toEqual([{ present: true }]);
					expect(parseErrors).toEqual([]);
				} finally {
					vi.useRealTimers();
				}
			});
		});
		describe('malformed JSON', () => {
			it('emits parse-error and continues reading subsequent lines', async () => {
				const { tailer, filePath, entries, parseErrors } = makeHarness('bad.jsonl');
				fs.writeFileSync(filePath, '{"ok":1}\nnot-json\n{"ok":2}\n');
				await tailer.start();
				await waitUntil(() => entries.length === 2 && parseErrors.length === 1);
				expect(entries).toEqual([{ ok: 1 }, { ok: 2 }]);
				expect(parseErrors).toHaveLength(1);
				expect(parseErrors[0].line).toBe('not-json');
				expect(parseErrors[0].error).toBeInstanceOf(Error);
			});
		});
		describe('file appears after start()', () => {
			it('attaches and emits when the file is created within the timeout', async () => {
				const { tailer, filePath, entries } = makeHarness('late.jsonl', {
					existsTimeoutMs: 2000,
				});
				const startPromise = tailer.start();
				// Simulate the fresh-session race: file shows up shortly after
				// the runner started tailing.
				await sleep(50);
				fs.writeFileSync(filePath, '{"late":true}\n');
				await startPromise;
				await waitUntil(() => entries.length === 1);
				expect(entries).toEqual([{ late: true }]);
			});
			it('rejects when the file never appears within the timeout', async () => {
				const tailer = new JsonlTailer({
					path: path.join(tempDir, 'never.jsonl'),
					pollIntervalMs: FAST_POLL_MS,
					existsTimeoutMs: 100,
				});
				activeTailer = tailer;
				vi.useFakeTimers();
				try {
					const rejection = expect(tailer.start()).rejects.toThrow(/did not appear/);
					await vi.advanceTimersByTimeAsync(175);
					await rejection;
				} finally {
					vi.useRealTimers();
				}
			});
		});
		describe('stop()', () => {
			it('halts polling - no further events fire after stop(), even on new appends', async () => {
				const { tailer, filePath, entries } = makeHarness('stop.jsonl');
				fs.writeFileSync(filePath, '{"i":1}\n');
				vi.useFakeTimers();
				try {
					await tailer.start();
					await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
					expect(entries).toEqual([{ i: 1 }]);
					tailer.stop();
					const snapshotCount = entries.length;
					fs.appendFileSync(filePath, '{"i":2}\n{"i":3}\n');
					// Drive several poll cycles to prove the stopped tailer ignores the append.
					await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 8);
					expect(entries.length).toBe(snapshotCount);
				} finally {
					vi.useRealTimers();
				}
			});
		});
		describe('start() twice', () => {
			it('rejects a second start() call', async () => {
				const { tailer, filePath } = makeHarness('twice.jsonl');
				fs.writeFileSync(filePath, '');
				await tailer.start();
				await expect(tailer.start()).rejects.toThrow(/start\(\) called twice/);
			});
		});
		describe('getLastByteAt()', () => {
			it('advances when the tailer reads new bytes', async () => {
				const { tailer, filePath } = makeHarness('clock.jsonl');
				fs.writeFileSync(filePath, '');
				await tailer.start();
				const before = tailer.getLastByteAt();
				// Sleep so Date.now() observably advances past `before`.
				await sleep(20);
				fs.appendFileSync(filePath, '{"i":1}\n');
				await waitUntil(() => tailer.getLastByteAt() > before);
				expect(tailer.getLastByteAt()).toBeGreaterThan(before);
			});
			it('does not advance when no new bytes are read', async () => {
				const { tailer, filePath } = makeHarness('idle.jsonl');
				fs.writeFileSync(filePath, '');
				vi.useFakeTimers();
				try {
					await tailer.start();
					const before = tailer.getLastByteAt();
					await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 5);
					expect(tailer.getLastByteAt()).toBe(before);
				} finally {
					vi.useRealTimers();
				}
			});
		});
	});
});
// Source: src/__tests__/maestro-p/json-emitter.test.ts
describe('', () => {
	describe('JsonEmitter', () => {
		let writeSpy: ReturnType<typeof vi.spyOn>;
		let writtenLines: string[];
		beforeEach(() => {
			writtenLines = [];
			writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
				chunk: string | Uint8Array
			) => {
				const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
				writtenLines.push(text);
				return true;
			}) as typeof process.stdout.write);
		});
		afterEach(() => {
			writeSpy.mockRestore();
		});
		function parseEmissions(): unknown[] {
			// Each writeLine writes exactly one `JSON.stringify(obj) + '\n'` per call.
			// The spy captures one entry per call, so we parse each entry as a single
			// JSON object (stripping the trailing newline).
			return writtenLines.map((line) => {
				expect(line.endsWith('\n')).toBe(true);
				return JSON.parse(line.slice(0, -1));
			});
		}
		describe('writeLine EPIPE handling', () => {
			it('swallows EPIPE when the stdout reader has gone (no crash)', () => {
				const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
				writeSpy.mockImplementation((() => {
					throw epipe;
				}) as typeof process.stdout.write);
				const emitter = new JsonEmitter();
				// emitInit emits through writeLine; a dead pipe must not crash maestro-p.
				expect(() =>
					emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' })
				).not.toThrow();
			});
			it('re-throws write errors that are not a dead pipe', () => {
				const boom = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
				writeSpy.mockImplementation((() => {
					throw boom;
				}) as typeof process.stdout.write);
				const emitter = new JsonEmitter();
				expect(() => emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' })).toThrow(
					/disk full/
				);
			});
		});
		describe('emitInit', () => {
			it('writes one system/init envelope with the supplied fields', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({
					sessionId: 'abc-123',
					model: 'claude-opus-4-7',
					cwd: '/Users/pedram/proj',
				});
				const events = parseEmissions();
				expect(events).toEqual([
					{
						type: 'system',
						subtype: 'init',
						session_id: 'abc-123',
						model: 'claude-opus-4-7',
						cwd: '/Users/pedram/proj',
					},
				]);
			});
			it('writes model as null when the caller does not know it yet', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				const events = parseEmissions() as Array<Record<string, unknown>>;
				expect(events[0]).toHaveProperty('model', null);
			});
			it('emits the init envelope exactly once (subsequent calls are silent no-ops)', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'first', model: null, cwd: '/cwd' });
				emitter.emitInit({ sessionId: 'second', model: 'opus', cwd: '/cwd' });
				emitter.emitInit({ sessionId: 'third', model: null, cwd: '/cwd' });
				const events = parseEmissions() as Array<Record<string, unknown>>;
				expect(events).toHaveLength(1);
				expect(events[0]).toMatchObject({ session_id: 'first' });
			});
			it('throws if called after a final envelope (emitResult)', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false });
				expect(() => emitter.emitInit({ sessionId: 'def', model: null, cwd: '/cwd' })).toThrow(
					/after final envelope/
				);
			});
		});
		describe('emitAssistantMessage', () => {
			it('throws if called before emitInit', () => {
				const emitter = new JsonEmitter();
				expect(() => emitter.emitAssistantMessage({ role: 'assistant' })).toThrow(
					/before emitInit/
				);
			});
			it('wraps the supplied message verbatim under { type: "assistant", message }', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				const rawMessage = {
					id: 'msg_01',
					role: 'assistant',
					content: [
						{ type: 'text', text: 'hello' },
						{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
					],
					stop_reason: 'end_turn',
					usage: {
						input_tokens: 12,
						output_tokens: 34,
						cache_read_input_tokens: 100,
					},
				};
				emitter.emitAssistantMessage(rawMessage);
				const events = parseEmissions();
				expect(events).toHaveLength(2);
				expect(events[1]).toEqual({
					type: 'assistant',
					message: rawMessage,
					parent_tool_use_id: null,
					session_id: 'abc',
				});
			});
			// `claude -p` tags a subagent's messages with the Task call that started
			// it; Maestro groups the subagent's tool cards under that call by it.
			it('tags a subagent message with the Task call it belongs to', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				emitter.emitAssistantMessage({ role: 'assistant', content: [] }, 'toolu_task');
				emitter.emitUserMessage({ role: 'user', content: [{ type: 'tool_result' }] }, 'toolu_task');
				const events = parseEmissions();
				expect(events[1]).toMatchObject({ parent_tool_use_id: 'toolu_task', session_id: 'abc' });
				expect(events[2]).toMatchObject({ parent_tool_use_id: 'toolu_task', session_id: 'abc' });
			});
			it('does not mutate, clone, or filter the supplied message object', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				// A field that would be tempting to strip (e.g., model: '<synthetic>')
				// - the emitter must pass it through; filtering is the runner's job.
				const rawMessage = {
					model: '<synthetic>',
					content: [{ type: 'text', text: 'No response requested.' }],
					stop_reason: null,
					usage: null,
				};
				emitter.emitAssistantMessage(rawMessage);
				const events = parseEmissions() as Array<{
					message: unknown;
				}>;
				expect(events[1].message).toEqual(rawMessage);
			});
			it('throws if called after emitResult', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false });
				expect(() => emitter.emitAssistantMessage({ role: 'assistant' })).toThrow(
					/after final envelope/
				);
			});
			it('throws if called after emitStatus', () => {
				const emitter = new JsonEmitter();
				const snapshot = makeSnapshot();
				emitter.emitStatus(snapshot);
				expect(() => emitter.emitAssistantMessage({ role: 'assistant' })).toThrow(
					/after final envelope/
				);
			});
		});
		describe('emitUserMessage', () => {
			it('throws if called before emitInit', () => {
				const emitter = new JsonEmitter();
				expect(() => emitter.emitUserMessage({ role: 'user' })).toThrow(/before emitInit/);
			});
			it('wraps the supplied message verbatim under { type: "user", message }', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				const rawMessage = {
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'tu_1',
							content: 'file1.txt\nfile2.txt',
						},
					],
				};
				emitter.emitUserMessage(rawMessage);
				const events = parseEmissions();
				expect(events[1]).toEqual({
					type: 'user',
					message: rawMessage,
					parent_tool_use_id: null,
					session_id: 'abc',
				});
			});
			it('throws if called after emitResult', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false });
				expect(() => emitter.emitUserMessage({ role: 'user' })).toThrow(/after final envelope/);
			});
		});
		describe('emitResult', () => {
			it('throws if called before emitInit', () => {
				const emitter = new JsonEmitter();
				expect(() =>
					emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false })
				).toThrow(/before emitInit/);
			});
			it('writes the minimum success envelope when no optional fields are supplied', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				emitter.emitResult({ sessionId: 'abc', durationMs: 1234, isError: false });
				const events = parseEmissions();
				expect(events[1]).toEqual({
					type: 'result',
					subtype: 'success',
					session_id: 'abc',
					duration_ms: 1234,
					is_error: false,
				});
			});
			it('omits optional result / usage / modelUsage / total_cost_usd / error when not supplied', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false });
				const events = parseEmissions() as Array<Record<string, unknown>>;
				const resultEvent = events[1];
				expect(resultEvent).not.toHaveProperty('result');
				expect(resultEvent).not.toHaveProperty('usage');
				expect(resultEvent).not.toHaveProperty('modelUsage');
				expect(resultEvent).not.toHaveProperty('total_cost_usd');
				expect(resultEvent).not.toHaveProperty('error');
			});
			it('includes optional fields when supplied', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: 'opus', cwd: '/cwd' });
				const opts: EmitResultOptions = {
					sessionId: 'abc',
					durationMs: 5678,
					isError: false,
					result: 'The answer is 4.',
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_read_input_tokens: 200,
						cache_creation_input_tokens: 0,
					},
					modelUsage: {
						'claude-opus-4-7': { inputTokens: 100, outputTokens: 50 },
					},
					totalCostUsd: 0.0042,
				};
				emitter.emitResult(opts);
				const events = parseEmissions() as Array<Record<string, unknown>>;
				expect(events[1]).toEqual({
					type: 'result',
					subtype: 'success',
					session_id: 'abc',
					duration_ms: 5678,
					is_error: false,
					result: 'The answer is 4.',
					usage: opts.usage,
					modelUsage: opts.modelUsage,
					total_cost_usd: 0.0042,
				});
			});
			it('uses subtype "error_during_execution" and includes error string when isError is true', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				emitter.emitResult({
					sessionId: 'abc',
					durationMs: 300000,
					isError: true,
					error: 'timeout',
				});
				const events = parseEmissions();
				expect(events[1]).toEqual({
					type: 'result',
					subtype: 'error_during_execution',
					session_id: 'abc',
					duration_ms: 300000,
					is_error: true,
					error: 'timeout',
				});
			});
			it('preserves error variant strings the runner uses (limit, tui_exited)', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				emitter.emitResult({
					sessionId: 'abc',
					durationMs: 1500,
					isError: true,
					error: 'limit',
				});
				const events = parseEmissions() as Array<Record<string, unknown>>;
				expect(events[1]).toMatchObject({ is_error: true, error: 'limit' });
			});
			it('throws if called a second time', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false });
				expect(() =>
					emitter.emitResult({ sessionId: 'abc', durationMs: 200, isError: false })
				).toThrow(/after final envelope/);
			});
			it('includes total_cost_usd === 0 when explicitly supplied as 0', () => {
				// Guard against `if (totalCostUsd)` falsy bugs: a free turn has a real
				// cost of 0 and consumers should see it, not see the field omitted.
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				emitter.emitResult({
					sessionId: 'abc',
					durationMs: 100,
					isError: false,
					totalCostUsd: 0,
				});
				const events = parseEmissions() as Array<Record<string, unknown>>;
				expect(events[1]).toHaveProperty('total_cost_usd', 0);
			});
		});
		describe('emitStatus', () => {
			it('writes the supplied snapshot verbatim to stdout', () => {
				const emitter = new JsonEmitter();
				const snapshot = makeSnapshot();
				emitter.emitStatus(snapshot);
				const events = parseEmissions();
				expect(events).toEqual([snapshot]);
			});
			it('does not require emitInit (standalone single-line protocol)', () => {
				const emitter = new JsonEmitter();
				expect(() => emitter.emitStatus(makeSnapshot())).not.toThrow();
			});
			it('throws if called after emitResult', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false });
				expect(() => emitter.emitStatus(makeSnapshot())).toThrow(/after final envelope/);
			});
			it('throws if called twice', () => {
				const emitter = new JsonEmitter();
				emitter.emitStatus(makeSnapshot());
				expect(() => emitter.emitStatus(makeSnapshot())).toThrow(/after final envelope/);
			});
		});
		describe('wire format', () => {
			it('writes each event as exactly one stdout.write call (one JSON object + trailing newline)', () => {
				const emitter = new JsonEmitter();
				emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
				emitter.emitAssistantMessage({ role: 'assistant', content: 'hi' });
				emitter.emitUserMessage({ role: 'user', content: [{ type: 'tool_result' }] });
				emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false });
				expect(writtenLines).toHaveLength(4);
				for (const line of writtenLines) {
					expect(line.endsWith('\n')).toBe(true);
					// Exactly one \n at the very end - no embedded newlines splitting
					// what should be a single JSONL record across multiple lines.
					expect(line.indexOf('\n')).toBe(line.length - 1);
					// Parses as a single JSON value.
					expect(() => JSON.parse(line)).not.toThrow();
				}
			});
		});
	});
	function makeSnapshot(): StatusSnapshot {
		return {
			type: 'status',
			config_dir: '/Users/pedram/.claude',
			session: { percent: 23, resets_at: '2026-05-15T18:00:00.000Z' },
			week_all_models: { percent: 58, resets_at: '2026-05-17T18:00:00.000Z' },
			week_sonnet_only: { percent: 0, resets_at: '2026-05-17T18:00:00.000Z' },
		};
	}
});
// Source: src/__tests__/maestro-p/billing-mode.test.ts
describe('', () => {
	describe('showsApiUsageBilling', () => {
		it.each([
			'Fable 5.1 · API Usage Billing',
			// Cursor-addressed paints lose their spaces once ANSI is stripped.
			'Fable5.1·APIUsageBilling',
			'│  Opus 4.8 · api usage billing  │',
		])('detects the header: %s', (text) => {
			expect(showsApiUsageBilling(text)).toBe(true);
		});
		it.each([
			'Fable 5.1 · Claude Max',
			'Fable 5.1 · Claude Pro',
			'',
			// Prose that names the mode without the header's separator.
			'Earlier this account was on API Usage Billing.',
		])('ignores: %s', (text) => {
			expect(showsApiUsageBilling(text)).toBe(false);
		});
	});
	describe('diagnoseApiUsageBilling', () => {
		it('reports a missed login when the environment names no API credential', () => {
			const diagnosis = diagnoseApiUsageBilling(
				{ CLAUDE_CONFIG_DIR: '/cfg', HOME: '/Users/alice', UNSET: undefined },
				'/cfg'
			);
			expect(diagnosis.expected).toBe(false);
			expect(diagnosis.reason).toContain('/cfg');
			expect(diagnosis.reason).toContain('USER');
		});
		it.each([
			['ANTHROPIC_API_KEY', 'sk-test'],
			['ANTHROPIC_AUTH_TOKEN', 'token'],
			['ANTHROPIC_BASE_URL', 'https://gateway.example'],
			['CLAUDE_CODE_USE_BEDROCK', '1'],
		])('treats %s as asking for API billing', (key, value) => {
			const diagnosis = diagnoseApiUsageBilling({ [key]: value }, '/cfg');
			expect(diagnosis.expected).toBe(true);
			expect(diagnosis.reason).toContain(key);
		});
		it('treats a blank API key as unset', () => {
			expect(diagnoseApiUsageBilling({ ANTHROPIC_API_KEY: ' ' }, '/cfg').expected).toBe(false);
		});
		// The desktop scans maestro-p stderr with Claude's error bank, so a reason
		// that happened to read as an auth or limit error would fail a good turn.
		it.each([{}, { ANTHROPIC_API_KEY: 'sk-test' }])(
			'never words a reason the Claude error bank reads as an agent error (%o)',
			(env) => {
				const { reason } = diagnoseApiUsageBilling(env, '/Users/alice/.claude');
				expect(matchErrorPattern(getErrorPatterns('claude-code'), reason)).toBeNull();
			}
		);
	});
});
// Source: src/__tests__/maestro-p/screen-replay.test.ts
describe('', () => {
	describe('replayTerminalScreen', () => {
		it('renders plain text one row per line', () => {
			expect(replayTerminalScreen('one\r\ntwo\nthree\n')).toBe('one\ntwo\nthree');
		});
		it('keeps text a repaint jumped over instead of re-sending', () => {
			// Frame 1 paints the header; frame 2 rewrites only the changed tail and
			// the percentage. Stripping ANSI would read "Fable)18%" as a fragment.
			const raw = 'Current week (Opus)\r\n12% used' + '\x1b[1;15HFable)\x1b[K\x1b[2;1H18%';
			expect(replayTerminalScreen(raw)).toBe('Current week (Fable)\n18% used');
		});
		it('honors relative moves, column jumps, and erase in line', () => {
			const raw = 'abcdef\x1b[3D\x1b[KXY\r\n\x1b[4Cz\x1b[1A\x1b[1Gq';
			expect(replayTerminalScreen(raw)).toBe('qbcXY\n    z');
		});
		it('erases the display from the cursor down, and all of it', () => {
			expect(replayTerminalScreen('keep\r\ngone\r\ngone too\x1b[2;1H\x1b[J')).toBe('keep');
			expect(replayTerminalScreen('old\r\nrows\x1b[2J\x1b[Hnew')).toBe('new');
		});
		it('ignores styling, modes, and OSC strings', () => {
			const raw = '\x1b[?25l\x1b[1mbold\x1b[22m \x1b]0;title\x07\x1b[38;5;153mcolor\x1b[39m';
			expect(replayTerminalScreen(raw)).toBe('bold color');
		});
		it('restores a saved cursor position', () => {
			expect(replayTerminalScreen('ab\x1b7\r\nxyz\x1b8c')).toBe('abc\nxyz');
		});
		it('returns the alternate screen even after the TUI left it', () => {
			const raw = 'shell prompt\r\n\x1b[?1049h\x1b[HCurrent session\r\n23% used\x1b[?1049l';
			expect(replayTerminalScreen(raw)).toBe('Current session\n23% used');
		});
	});
	describe('capturedAlternateScreen', () => {
		it('is true only for a stream that switched into the alternate screen', () => {
			expect(capturedAlternateScreen('\x1b[?1049h\x1b[HCurrent session')).toBe(true);
			expect(capturedAlternateScreen('\x1b[1mCurrent session\x1b[0m\n23% used')).toBe(false);
		});
	});
});
// Source: src/__tests__/maestro-p/api-error-row.test.ts
describe('', () => {
	// The last transcript row of the real run reported in issue #1578.
	const weeklyLimitRow = {
		type: 'assistant',
		isApiErrorMessage: true,
		error: 'rate_limit',
		message: {
			model: '<synthetic>',
			stop_reason: 'stop_sequence',
			content: [
				{
					type: 'text',
					text: "You've hit your weekly limit · resets Aug 27 at 10am (America/Chicago)",
				},
			],
		},
	};
	describe('isRateLimitErrorRow', () => {
		it('recognizes the synthetic weekly-limit row claude writes to the transcript', () => {
			expect(isRateLimitErrorRow(weeklyLimitRow)).toBe(true);
		});
		it('does not depend on the banner wording', () => {
			const reworded = {
				...weeklyLimitRow,
				message: { ...weeklyLimitRow.message, content: [{ type: 'text', text: 'Out of quota.' }] },
			};
			expect(isRateLimitErrorRow(reworded)).toBe(true);
		});
		it('accepts the snake_case flag stream-json stdout uses', () => {
			const { isApiErrorMessage: _flag, ...rest } = weeklyLimitRow;
			expect(isRateLimitErrorRow({ ...rest, is_api_error_message: true })).toBe(true);
		});
		it('ignores API-error rows claude retries past', () => {
			expect(isRateLimitErrorRow({ ...weeklyLimitRow, error: 'server_error' })).toBe(false);
		});
		it('requires the API-error flag', () => {
			const { isApiErrorMessage: _flag, ...unflagged } = weeklyLimitRow;
			expect(isRateLimitErrorRow(unflagged)).toBe(false);
			expect(isRateLimitErrorRow({ ...weeklyLimitRow, isApiErrorMessage: false })).toBe(false);
		});
		it('ignores non-assistant rows', () => {
			expect(isRateLimitErrorRow({ ...weeklyLimitRow, type: 'user' })).toBe(false);
		});
		it('ignores an ordinary assistant row', () => {
			expect(
				isRateLimitErrorRow({
					type: 'assistant',
					message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
				})
			).toBe(false);
		});
		it('ignores non-object input', () => {
			expect(isRateLimitErrorRow(null)).toBe(false);
			expect(isRateLimitErrorRow(undefined)).toBe(false);
			expect(isRateLimitErrorRow('rate_limit')).toBe(false);
		});
	});
	// The row from the run reported in issue #1753 (`--model no-such-model-xyz`).
	const modelNotFoundRow = {
		type: 'assistant',
		isApiErrorMessage: true,
		error: 'model_not_found',
		message: {
			model: '<synthetic>',
			stop_reason: 'stop_sequence',
			content: [
				{
					type: 'text',
					text: "There's an issue with the selected model (no-such-model-xyz). It may not exist or you may not have access to it.",
				},
			],
		},
	};
	describe('terminalApiErrorTag', () => {
		it('recognizes the synthetic model_not_found row', () => {
			expect(terminalApiErrorTag(modelNotFoundRow)).toBe('model_not_found');
		});
		it('recognizes every tag on the terminal allowlist', () => {
			for (const tag of TERMINAL_API_ERROR_TAGS) {
				expect(terminalApiErrorTag({ ...modelNotFoundRow, error: tag })).toBe(tag);
			}
		});
		it('accepts the snake_case flag stream-json stdout uses', () => {
			const { isApiErrorMessage: _flag, ...rest } = modelNotFoundRow;
			expect(terminalApiErrorTag({ ...rest, is_api_error_message: true })).toBe('model_not_found');
		});
		it('leaves rate_limit to isRateLimitErrorRow', () => {
			expect(terminalApiErrorTag(weeklyLimitRow)).toBeNull();
		});
		it('treats provisional and unlisted tags as non-terminal', () => {
			expect(terminalApiErrorTag({ ...modelNotFoundRow, error: 'server_error' })).toBeNull();
			expect(terminalApiErrorTag({ ...modelNotFoundRow, error: 'unknown' })).toBeNull();
			expect(terminalApiErrorTag({ ...modelNotFoundRow, error: 'some_future_tag' })).toBeNull();
		});
		it('requires the API-error flag', () => {
			const { isApiErrorMessage: _flag, ...unflagged } = modelNotFoundRow;
			expect(terminalApiErrorTag(unflagged)).toBeNull();
			expect(terminalApiErrorTag({ ...modelNotFoundRow, isApiErrorMessage: false })).toBeNull();
		});
		it('ignores non-assistant rows and non-string tags', () => {
			expect(terminalApiErrorTag({ ...modelNotFoundRow, type: 'user' })).toBeNull();
			expect(
				terminalApiErrorTag({ ...modelNotFoundRow, error: { type: 'model_not_found' } })
			).toBeNull();
		});
		it('ignores non-object input', () => {
			expect(terminalApiErrorTag(null)).toBeNull();
			expect(terminalApiErrorTag(undefined)).toBeNull();
			expect(terminalApiErrorTag('model_not_found')).toBeNull();
		});
	});
});
// Source: src/__tests__/maestro-p/child-env.test.ts
describe('', () => {
	const posix = { platform: 'darwin' as const, loginName: () => 'alice' };
	describe('buildChildEnv', () => {
		it('strips every Claude session identity marker and keeps auth and config', () => {
			const parent: NodeJS.ProcessEnv = {
				USER: 'alice',
				LOGNAME: 'alice',
				CLAUDE_CONFIG_DIR: '/cfg',
				ANTHROPIC_MODEL: 'fable',
				MAESTRO_CLAUDE_BIN: '/bin/claude',
			};
			for (const key of CLAUDE_SESSION_IDENTITY_ENV_VARS) parent[key] = 'x';
			const env = buildChildEnv(parent, posix);
			for (const key of CLAUDE_SESSION_IDENTITY_ENV_VARS) expect(env).not.toHaveProperty(key);
			expect(env.CLAUDE_CONFIG_DIR).toBe('/cfg');
			expect(env.ANTHROPIC_MODEL).toBe('fable');
			expect(env.MAESTRO_CLAUDE_BIN).toBe('/bin/claude');
		});
		it('removes the steering socket so nothing below this maestro-p can reach its channel', () => {
			// Left in, it rides into claude and every Bash-tool child: a nested
			// maestro-p would open a second server on the same path (taking this turn's
			// channel down), and any tool could type into the turn that spawned it.
			const parent: NodeJS.ProcessEnv = {
				USER: 'alice',
				LOGNAME: 'alice',
				[STEERING_SOCKET_ENV_VAR]: '/tmp/maestro-steer-abc.sock',
			};
			const env = buildChildEnv(parent, posix);
			expect(env).not.toHaveProperty(STEERING_SOCKET_ENV_VAR);
			// The caller's own env still carries it; maestro-p reads it from there.
			expect(parent[STEERING_SOCKET_ENV_VAR]).toBe('/tmp/maestro-steer-abc.sock');
		});
		// #1577: with USER unset, claude misses its keychain login and starts on API
		// Usage Billing. `env -i` wrappers, launchd jobs, and cron all hit this.
		it('fills USER and LOGNAME from the OS account when the caller left them unset', () => {
			const env = buildChildEnv({ HOME: '/Users/alice', PATH: '/usr/bin:/bin' }, posix);
			expect(env.USER).toBe('alice');
			expect(env.LOGNAME).toBe('alice');
		});
		it('treats a blank login name as unset', () => {
			const env = buildChildEnv({ USER: '', LOGNAME: '  ' }, posix);
			expect(env.USER).toBe('alice');
			expect(env.LOGNAME).toBe('alice');
		});
		it('never overwrites a login name the caller set', () => {
			const env = buildChildEnv({ USER: 'bob' }, posix);
			expect(env.USER).toBe('bob');
			expect(env.LOGNAME).toBe('alice');
		});
		it('does not read the OS account when both names are already set', () => {
			const loginName = vi.fn(() => 'alice');
			const env = buildChildEnv({ USER: 'bob', LOGNAME: 'bob' }, { platform: 'linux', loginName });
			expect(loginName).not.toHaveBeenCalled();
			expect(env.USER).toBe('bob');
		});
		it('leaves the login name unset when the OS account cannot be read', () => {
			const env = buildChildEnv({ HOME: '/' }, { platform: 'linux', loginName: () => undefined });
			expect(env).not.toHaveProperty('USER');
			expect(env).not.toHaveProperty('LOGNAME');
		});
		it('does not add USER on Windows, which names the account in USERNAME', () => {
			const env = buildChildEnv(
				{ USERNAME: 'alice' },
				{ platform: 'win32', loginName: () => 'alice' }
			);
			expect(env).not.toHaveProperty('USER');
			expect(env).not.toHaveProperty('LOGNAME');
		});
		it('does not mutate the parent environment', () => {
			const parent: NodeJS.ProcessEnv = { CLAUDECODE: '1' };
			buildChildEnv(parent, posix);
			expect(parent).toEqual({ CLAUDECODE: '1' });
		});
		it('reads the real OS account by default', () => {
			const env = buildChildEnv({ PATH: '/usr/bin' }, { platform: 'linux' });
			expect(env.USER).toBe(s7_os.userInfo().username);
		});
	});
});
