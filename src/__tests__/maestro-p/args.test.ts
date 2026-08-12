/**
 * @file args.test.ts
 * @description Tests for src/maestro-p/args.ts argv parser.
 *
 * Covers prompt source resolution (-p / positional / stdin), --status mode,
 * pass-through preservation, stripped-flag warnings, --max-wait integer
 * parsing, multi-word positional prompts, and the --resume dual-exposure
 * contract (typed field AND retained in passThroughArgs).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
	parseArgs,
	DEFAULT_MAX_WAIT_SECONDS,
	DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS,
} from '../../maestro-p/args';

describe('parseArgs', () => {
	let warnSpy: ReturnType<typeof vi.fn<(message: string) => void>>;

	beforeEach(() => {
		warnSpy = vi.fn<(message: string) => void>();
	});

	const callArgs = (
		argv: string[],
		overrides: { stdinIsTTY?: boolean; readStdin?: () => string } = {}
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

		it('drops --verbose with a stderr warning', () => {
			const result = callArgs(['--verbose', '-p', 'hi']);
			expect(result.passThroughArgs).toEqual([]);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0][0]).toMatch(/--verbose/);
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
			const messages = warnSpy.mock.calls.map((c) => c[0]).join('\n');
			expect(messages).toMatch(/--print requires a value/);
			expect(messages).toMatch(/--verbose/);
			expect(messages).toMatch(/--output-format/);
		});

		it('does not consume a flag-looking next token as the prompt value for -p', () => {
			const result = callArgs(['-p', '--verbose', 'real prompt']);
			expect(result.prompt).toBe('real prompt');
			const messages = warnSpy.mock.calls.map((c) => c[0]).join('\n');
			expect(messages).toMatch(/-p requires a value/);
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
