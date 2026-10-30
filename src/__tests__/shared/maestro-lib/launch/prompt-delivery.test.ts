import { describe, it, expect } from 'vitest';
import {
	buildPromptArgv,
	POSIX_PROMPT_ARGV_MAX_BYTES,
	promptExceedsArgvLimit,
	resolvePromptDelivery,
	resolveSystemPromptDelivery,
	WINDOWS_PROMPT_ARGV_MAX_CHARS,
	windowsCommandLineLength,
	windowsQuotedArgLength,
	type PromptDeliveryAgent,
} from '../../../../shared/maestro-lib/launch/prompt-delivery';
import { getAgentDefinition } from '../../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../../shared/maestro-lib/providers/capabilities';

/** A real provider, as the spawners see it: definition plus capabilities. */
function provider(id: string): PromptDeliveryAgent {
	return { ...getAgentDefinition(id), capabilities: getAgentCapabilities(id) };
}

describe('buildPromptArgv', () => {
	it('uses the provider flag when it has one (Copilot: -p)', () => {
		expect(buildPromptArgv(provider('copilot-cli'), 'hi')).toEqual(['-p', 'hi']);
	});

	it('uses Hermes -q', () => {
		expect(buildPromptArgv(provider('hermes'), 'hi')).toEqual(['-q', 'hi']);
	});

	it('puts a bare positional for a CLI that rejects -- (Pi, Factory Droid)', () => {
		expect(buildPromptArgv(provider('pi'), 'hi')).toEqual(['hi']);
		expect(buildPromptArgv(provider('factory-droid'), 'hi')).toEqual(['hi']);
	});

	it('defaults to -- then the prompt (Claude Code)', () => {
		expect(buildPromptArgv(provider('claude-code'), '---frontmatter')).toEqual([
			'--',
			'---frontmatter',
		]);
	});
});

describe('promptExceedsArgvLimit', () => {
	it('uses the CreateProcess cap on Windows', () => {
		expect(promptExceedsArgvLimit('x'.repeat(WINDOWS_PROMPT_ARGV_MAX_CHARS), true)).toBe(false);
		expect(promptExceedsArgvLimit('x'.repeat(WINDOWS_PROMPT_ARGV_MAX_CHARS + 1), true)).toBe(true);
	});

	it('counts UTF-8 bytes off Windows', () => {
		expect(promptExceedsArgvLimit('x'.repeat(POSIX_PROMPT_ARGV_MAX_BYTES), false)).toBe(false);
		expect(promptExceedsArgvLimit('x'.repeat(POSIX_PROMPT_ARGV_MAX_BYTES + 1), false)).toBe(true);
		// 40,000 three-byte characters: short in code units, 120,000 bytes on the wire.
		expect(promptExceedsArgvLimit('\u20ac'.repeat(40_000), false)).toBe(true);
		expect(promptExceedsArgvLimit('\u20ac'.repeat(30_000), false)).toBe(false);
	});

	// A prompt is measured as Node quotes it for CreateProcess, not as written:
	// every `"` gains a backslash, so a prompt well under the cap can cross it.
	it('measures a Windows prompt after quoting', () => {
		const over = '"'.repeat(15_000);
		const under = '"'.repeat(14_997);
		expect(over.length).toBeLessThan(WINDOWS_PROMPT_ARGV_MAX_CHARS);
		expect(windowsQuotedArgLength(over)).toBe(30_002);
		expect(windowsQuotedArgLength(under)).toBe(29_996);

		expect(promptExceedsArgvLimit(over, true)).toBe(true);
		expect(promptExceedsArgvLimit(under, true)).toBe(false);
	});
});

describe('windowsQuotedArgLength', () => {
	// Input and output pairs from libuv's quote_cmd_arg (src/win/process.c).
	it.each([
		['hello"world', '"hello\\"world"'],
		['hello""world', '"hello\\"\\"world"'],
		['hello\\world', 'hello\\world'],
		['hello\\\\world', 'hello\\\\world'],
		['hello\\"world', '"hello\\\\\\"world"'],
		['hello\\\\"world', '"hello\\\\\\\\\\"world"'],
		['hello world\\', '"hello world\\\\"'],
		['', '""'],
		['a b', '"a b"'],
		['a\tb', '"a\tb"'],
		['plain', 'plain'],
	])('counts %j as %j', (input, quoted) => {
		expect(windowsQuotedArgLength(input)).toBe(quoted.length);
	});

	it('joins a command line with single spaces', () => {
		// ssh "a b" plain
		expect(windowsCommandLineLength('ssh', ['a b', 'plain'])).toBe(15);
	});
});

describe('resolvePromptDelivery', () => {
	const linux = { isWindowsHost: false, sshRemote: false };
	const windows = { isWindowsHost: true, sshRemote: false };

	it('delivers nothing when there is no prompt', () => {
		expect(resolvePromptDelivery({ agent: provider('codex'), prompt: '', ...linux })).toEqual({
			via: 'none',
		});
	});

	it('puts the prompt on the command line off Windows', () => {
		expect(resolvePromptDelivery({ agent: provider('codex'), prompt: 'hi', ...linux })).toEqual({
			via: 'argv',
			args: ['--', 'hi'],
		});
	});

	it('moves it to raw stdin on a Windows host for an agent that reads stdin', () => {
		expect(resolvePromptDelivery({ agent: provider('codex'), prompt: 'hi', ...windows })).toEqual({
			via: 'stdin',
			format: 'raw',
			args: [],
		});
	});

	it('adds the provider stdin flags on Windows (Hermes: --query-file -)', () => {
		expect(resolvePromptDelivery({ agent: provider('hermes'), prompt: 'hi', ...windows })).toEqual({
			via: 'stdin',
			format: 'raw',
			args: ['--query-file', '-'],
		});
	});

	it('keeps argv on Windows for an agent that does not read stdin (omp)', () => {
		expect(resolvePromptDelivery({ agent: provider('omp'), prompt: 'hi', ...windows }).via).toBe(
			'argv'
		);
	});

	it('uses stream-json stdin on Windows when images ride with the prompt', () => {
		expect(
			resolvePromptDelivery({
				agent: provider('claude-code'),
				prompt: 'hi',
				hasImages: true,
				...windows,
			})
		).toEqual({ via: 'stdin', format: 'stream-json', args: [] });
	});

	// MAESTRO-16C/16P/RM/VR: off Windows every prompt rode argv, so a synthesis
	// or consult carrying a long history failed the spawn with E2BIG (Linux caps
	// ONE argument at 128 KiB).
	it('moves an over-long prompt to stdin off Windows, for an agent that reads stdin', () => {
		const long = 'x'.repeat(POSIX_PROMPT_ARGV_MAX_BYTES + 1);
		expect(
			resolvePromptDelivery({ agent: provider('claude-code'), prompt: long, ...linux })
		).toEqual({ via: 'stdin', format: 'raw', args: [] });
		expect(
			resolvePromptDelivery({ agent: provider('codex'), prompt: 'x'.repeat(1000), ...linux }).via
		).toBe('argv');
	});

	it('keeps an over-long prompt in argv for an agent that does not read stdin', () => {
		const long = 'x'.repeat(POSIX_PROMPT_ARGV_MAX_BYTES + 1);
		expect(resolvePromptDelivery({ agent: provider('omp'), prompt: long, ...linux }).via).toBe(
			'argv'
		);
	});

	// MAESTRO-16E: Cue keeps a Windows prompt in argv (isWindowsHost: false), so
	// a Codex prompt with the system prompt embedded overran CreateProcess.
	it('applies the Windows cap when the surface keeps short prompts in argv', () => {
		const overWindowsCap = 'x'.repeat(WINDOWS_PROMPT_ARGV_MAX_CHARS + 1);
		expect(
			resolvePromptDelivery({
				agent: provider('codex'),
				prompt: overWindowsCap,
				...linux,
				hostIsWindows: true,
			})
		).toEqual({ via: 'stdin', format: 'raw', args: [] });
		expect(
			resolvePromptDelivery({ agent: provider('codex'), prompt: overWindowsCap, ...linux }).via
		).toBe('argv');
	});

	it('leaves the prompt to the SSH script on a remote, whatever the host OS', () => {
		for (const isWindowsHost of [true, false]) {
			expect(
				resolvePromptDelivery({
					agent: provider('codex'),
					prompt: 'hi',
					isWindowsHost,
					sshRemote: true,
				})
			).toEqual({ via: 'ssh' });
		}
	});
});

describe('resolveSystemPromptDelivery', () => {
	const base = {
		systemPrompt: 'You are Maestro.',
		isWindowsHost: false,
		sshRemote: false,
		isResume: false,
		hasUserPrompt: true,
	};

	it('passes nothing without a system prompt', () => {
		expect(
			resolveSystemPromptDelivery({ ...base, systemPrompt: '', supportsAppendSystemPrompt: true })
		).toEqual({ via: 'none' });
	});

	it('uses the flag for a provider that has it, every turn including resume', () => {
		expect(
			resolveSystemPromptDelivery({ ...base, supportsAppendSystemPrompt: true, isResume: true })
		).toEqual({ via: 'flag' });
	});

	it('uses a temp file on a Windows host', () => {
		expect(
			resolveSystemPromptDelivery({
				...base,
				supportsAppendSystemPrompt: true,
				isWindowsHost: true,
			})
		).toEqual({ via: 'file' });
	});

	it('keeps the inline flag on an SSH remote from a Windows host', () => {
		expect(
			resolveSystemPromptDelivery({
				...base,
				supportsAppendSystemPrompt: true,
				isWindowsHost: true,
				sshRemote: true,
			})
		).toEqual({ via: 'flag' });
	});

	it('embeds it in the first turn for a provider without the flag', () => {
		expect(resolveSystemPromptDelivery({ ...base, supportsAppendSystemPrompt: false })).toEqual({
			via: 'embed',
		});
	});

	it('skips it on resume for a provider without the flag', () => {
		expect(
			resolveSystemPromptDelivery({ ...base, supportsAppendSystemPrompt: false, isResume: true })
		).toEqual({ via: 'skip-on-resume' });
	});

	it('sends it as the prompt when there is no user prompt', () => {
		expect(
			resolveSystemPromptDelivery({
				...base,
				supportsAppendSystemPrompt: false,
				hasUserPrompt: false,
			})
		).toEqual({ via: 'as-prompt' });
	});
});
