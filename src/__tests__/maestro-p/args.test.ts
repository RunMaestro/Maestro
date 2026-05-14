/**
 * @file args.test.ts
 * @description Tests for the maestro-p argument resolver.
 *
 * Covers:
 * - Prompt resolution priority: -p / --print / --prompt > positional > stdin
 * - --status mode (no prompt input)
 * - Pass-through preservation in original order
 * - Stripped flags drop with stderr warning
 * - --max-wait integer parsing
 * - Multi-word prompts via positional and via flag
 * - --resume <id> forwarded as a pair
 */

import { describe, it, expect, vi } from 'vitest';
import { parseArgs, DEFAULT_MAX_WAIT_SECONDS } from '../../maestro-p/args';

// Helper: parseArgs invocation that pretends stdin is a TTY (no piped input).
// Tests that exercise the stdin branch override these explicitly.
function parse(argv: string[], stderr: (msg: string) => void = () => {}) {
	return parseArgs(argv, { stdinIsTTY: true, stderr });
}

describe('parseArgs — prompt resolution', () => {
	it('takes the prompt from -p', () => {
		const result = parse(['-p', 'hello world']);
		expect(result.prompt).toBe('hello world');
		expect(result.mode).toBe('run');
		expect(result.passThroughArgs).toEqual([]);
	});

	it('takes the prompt from --print', () => {
		const result = parse(['--print', 'from print flag']);
		expect(result.prompt).toBe('from print flag');
	});

	it('takes the prompt from --prompt', () => {
		const result = parse(['--prompt', 'from prompt flag']);
		expect(result.prompt).toBe('from prompt flag');
	});

	it('takes the prompt from --print=value form', () => {
		const result = parse(['--print=inline value']);
		expect(result.prompt).toBe('inline value');
	});

	it('takes the prompt from a single positional argument', () => {
		const result = parse(['what is 2+2?']);
		expect(result.prompt).toBe('what is 2+2?');
		expect(result.passThroughArgs).toEqual([]);
	});

	it('preserves a multi-word positional prompt as a single token', () => {
		// Shell quoting collapses to one argv element.
		const result = parse(['hello there friend']);
		expect(result.prompt).toBe('hello there friend');
	});

	it('reads the prompt from stdin when piped and no flag/positional given', () => {
		const result = parseArgs([], {
			stdinIsTTY: false,
			readStdin: () => 'piped prompt\n',
			stderr: () => {},
		});
		expect(result.prompt).toBe('piped prompt');
	});

	it('treats empty piped stdin as no prompt', () => {
		const result = parseArgs([], {
			stdinIsTTY: false,
			readStdin: () => '',
			stderr: () => {},
		});
		expect(result.prompt).toBeNull();
	});

	it('does not read stdin when stdin is a TTY', () => {
		const reader = vi.fn(() => 'should not be read');
		const result = parseArgs([], { stdinIsTTY: true, readStdin: reader, stderr: () => {} });
		expect(result.prompt).toBeNull();
		expect(reader).not.toHaveBeenCalled();
	});

	it('prefers -p over a positional argument', () => {
		const result = parse(['-p', 'flag wins', 'orphan positional']);
		expect(result.prompt).toBe('flag wins');
		// The orphan positional is forwarded so claude can surface it rather
		// than being silently dropped.
		expect(result.passThroughArgs).toContain('orphan positional');
	});

	it('returns null prompt in --status mode even if a positional is present', () => {
		const result = parse(['--status', 'ignored positional']);
		expect(result.mode).toBe('status');
		expect(result.prompt).toBeNull();
	});
});

describe('parseArgs — mode and toggles', () => {
	it('defaults mode to run', () => {
		expect(parse(['hi']).mode).toBe('run');
	});

	it('switches mode to status when --status is present', () => {
		const result = parse(['--status']);
		expect(result.mode).toBe('status');
	});

	it('sets streamThinking when --stream-thinking is present', () => {
		const result = parse(['--stream-thinking', 'hi']);
		expect(result.streamThinking).toBe(true);
		expect(result.passThroughArgs).toEqual([]);
	});

	it('defaults streamThinking to false', () => {
		expect(parse(['hi']).streamThinking).toBe(false);
	});

	it('defaults maxWaitSeconds to the documented value', () => {
		const result = parse(['hi']);
		expect(result.maxWaitSeconds).toBe(DEFAULT_MAX_WAIT_SECONDS);
		expect(DEFAULT_MAX_WAIT_SECONDS).toBe(300);
	});

	it('parses --max-wait 60 as integer 60', () => {
		const result = parse(['--max-wait', '60', 'hi']);
		expect(result.maxWaitSeconds).toBe(60);
		expect(result.prompt).toBe('hi');
	});

	it('parses --max-wait=60 inline form', () => {
		const result = parse(['--max-wait=120', 'hi']);
		expect(result.maxWaitSeconds).toBe(120);
	});

	it('throws when --max-wait is not a positive integer', () => {
		expect(() => parse(['--max-wait', 'foo'])).toThrow(/positive integer/);
		expect(() => parse(['--max-wait', '0'])).toThrow(/positive integer/);
		expect(() => parse(['--max-wait', '-5'])).toThrow(/positive integer/);
		expect(() => parse(['--max-wait', '1.5'])).toThrow(/positive integer/);
	});

	it('throws when --max-wait has no value', () => {
		expect(() => parse(['--max-wait'])).toThrow(/requires a value/);
	});

	it('throws when --print has no value', () => {
		expect(() => parse(['--print'])).toThrow(/requires a value/);
	});
});

describe('parseArgs — pass-through preservation', () => {
	it('forwards an unknown boolean flag verbatim', () => {
		const result = parse(['--continue', 'hi']);
		// --continue swallows "hi" as its value (heuristic), so prompt is null
		// and both tokens land in passThroughArgs together. This is documented
		// behavior — disambiguate with -p when a boolean flag precedes the
		// positional prompt.
		expect(result.passThroughArgs).toEqual(['--continue', 'hi']);
		expect(result.prompt).toBeNull();
	});

	it('forwards --resume <id> as a pair, with positional as prompt', () => {
		const result = parse(['--resume', 'abc-123-def', 'continue please']);
		expect(result.passThroughArgs).toEqual(['--resume', 'abc-123-def']);
		expect(result.prompt).toBe('continue please');
	});

	it('forwards --model <name> as a pair', () => {
		const result = parse(['--model', 'opus', '-p', 'hi']);
		expect(result.passThroughArgs).toEqual(['--model', 'opus']);
		expect(result.prompt).toBe('hi');
	});

	it('preserves multiple pass-through flags in original order', () => {
		const result = parse([
			'--model',
			'opus',
			'--cwd',
			'/tmp/project',
			'--add-dir',
			'/tmp/extra',
			'-p',
			'hello',
		]);
		expect(result.passThroughArgs).toEqual([
			'--model',
			'opus',
			'--cwd',
			'/tmp/project',
			'--add-dir',
			'/tmp/extra',
		]);
		expect(result.prompt).toBe('hello');
	});

	it('preserves --flag=value form verbatim', () => {
		const result = parse(['--model=opus', '-p', 'hi']);
		expect(result.passThroughArgs).toEqual(['--model=opus']);
	});

	it('preserves pass-through flags in --status mode', () => {
		const result = parse(['--status', '--cwd', '/tmp/project', '--model', 'opus']);
		expect(result.mode).toBe('status');
		expect(result.passThroughArgs).toEqual(['--cwd', '/tmp/project', '--model', 'opus']);
	});
});

describe('parseArgs — stripped flags', () => {
	it('drops --output-format and its value with a stderr warning', () => {
		const stderr = vi.fn();
		const result = parse(['--output-format', 'stream-json', '-p', 'hi'], stderr);
		expect(result.passThroughArgs).toEqual([]);
		expect(result.prompt).toBe('hi');
		expect(stderr).toHaveBeenCalledTimes(1);
		expect(stderr.mock.calls[0][0]).toMatch(/--output-format stripped/);
	});

	it('drops --output-format=stream-json inline form with a warning', () => {
		const stderr = vi.fn();
		const result = parse(['--output-format=stream-json', '-p', 'hi'], stderr);
		expect(result.passThroughArgs).toEqual([]);
		expect(stderr).toHaveBeenCalledTimes(1);
		expect(stderr.mock.calls[0][0]).toMatch(/--output-format stripped/);
	});

	it('drops --input-format and its value with a warning', () => {
		const stderr = vi.fn();
		const result = parse(['--input-format', 'text', '-p', 'hi'], stderr);
		expect(result.passThroughArgs).toEqual([]);
		expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/--input-format stripped/));
	});

	it('drops --verbose with a warning (no value)', () => {
		const stderr = vi.fn();
		const result = parse(['--verbose', '-p', 'hi'], stderr);
		expect(result.passThroughArgs).toEqual([]);
		expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/--verbose stripped/));
	});

	it('warns once per stripped flag occurrence', () => {
		const stderr = vi.fn();
		parse(['--output-format', 'stream-json', '--verbose', '--input-format', 'text'], stderr);
		expect(stderr).toHaveBeenCalledTimes(3);
	});
});

describe('parseArgs — silently consumed flags', () => {
	it('swallows --help without forwarding', () => {
		const result = parse(['--help']);
		expect(result.passThroughArgs).toEqual([]);
		expect(result.prompt).toBeNull();
	});

	it('swallows --version without forwarding', () => {
		const result = parse(['--version']);
		expect(result.passThroughArgs).toEqual([]);
	});
});
