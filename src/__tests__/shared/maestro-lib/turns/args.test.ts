/**
 * The argument core of a turn and where the system prompt goes: the part of the desktop's
 * spawn handler that is a pure function of its inputs.
 */
import { describe, it, expect } from 'vitest';
import {
	applyCopilotPreamble,
	applySystemPromptDelivery,
	buildTurnArgs,
} from '../../../../shared/maestro-lib/turns/args';
import { embedSystemPromptInPrompt } from '../../../../shared/embeddedSystemPrompt';
import { providerFor } from './fixtures';

describe('buildTurnArgs', () => {
	it('builds the Claude batch arguments, then the config options', () => {
		const provider = providerFor('claude-code');
		const { args } = buildTurnArgs({
			provider,
			baseArgs: [...provider.args],
			prompt: 'hi',
			cwd: '/w',
			permissionMode: 'full',
			providerConfig: {},
			sessionCustomModel: 'opus',
			sessionCustomEffort: 'high',
		});
		expect(args).toEqual([
			'--print',
			'--verbose',
			'--output-format',
			'stream-json',
			'--dangerously-skip-permissions',
			'--model',
			'opus',
			'--effort',
			'high',
		]);
	});

	it('resumes a provider session', () => {
		const provider = providerFor('claude-code');
		const { args } = buildTurnArgs({
			provider,
			baseArgs: [...provider.args],
			prompt: 'hi',
			cwd: '/w',
			permissionMode: 'full',
			resumeSessionId: 'sess-9',
			providerConfig: {},
		});
		expect(args).toContain('--resume');
		expect(args[args.indexOf('--resume') + 1]).toBe('sess-9');
	});

	it('prepends Codex working-dir args and uses its read-only sandbox', () => {
		const provider = providerFor('codex');
		const { args } = buildTurnArgs({
			provider,
			baseArgs: [...provider.args],
			prompt: 'hi',
			cwd: '/w',
			readOnly: true,
			permissionMode: 'readonly',
			providerConfig: {},
		});
		expect(args.slice(0, 3)).toEqual(['-C', '/w', 'exec']);
		expect(args).toContain('--sandbox');
		expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
	});

	it('appends custom args after the config options, honoring quotes', () => {
		const provider = providerFor('claude-code');
		const { args, resolution } = buildTurnArgs({
			provider,
			baseArgs: [...provider.args],
			prompt: 'hi',
			cwd: '/w',
			permissionMode: 'full',
			providerConfig: {},
			sessionCustomArgs: '--foo "two words"',
		});
		expect(args.slice(-2)).toEqual(['--foo', 'two words']);
		expect(resolution.customArgsSource).toBe('session');
	});

	it('uses the provider config value when the session has no override', () => {
		const provider = providerFor('claude-code');
		const { args, resolution } = buildTurnArgs({
			provider,
			baseArgs: [...provider.args],
			prompt: 'hi',
			cwd: '/w',
			permissionMode: 'full',
			providerConfig: { model: 'haiku' },
		});
		expect(args).toContain('haiku');
		expect(resolution.modelSource).toBe('agent');
	});

	it('does not hand read-only mode to the overrides (F10)', () => {
		// OpenCode pins `--agent plan` when read-only; a custom `--agent build` lands later and wins.
		const provider = providerFor('opencode');
		const { args } = buildTurnArgs({
			provider,
			baseArgs: [...provider.args],
			prompt: 'hi',
			cwd: '/w',
			readOnly: true,
			permissionMode: 'readonly',
			providerConfig: {},
			sessionCustomArgs: '--agent build',
		});
		expect(args.lastIndexOf('build')).toBeGreaterThan(args.indexOf('plan'));
	});

	it('passes the base arguments through for a tool type with no provider', () => {
		const { args } = buildTurnArgs({
			provider: null,
			baseArgs: ['--x'],
			prompt: 'hi',
			cwd: '/w',
			providerConfig: {},
		});
		expect(args).toEqual(['--x']);
	});
});

describe('applySystemPromptDelivery', () => {
	const base = {
		args: ['--print'],
		prompt: 'user prompt',
		isResume: false,
		isWindowsHost: false,
		sshRemote: false,
	};

	it('passes the system prompt inline to a provider with the flag', () => {
		const out = applySystemPromptDelivery({
			...base,
			systemPrompt: 'SYS',
			supportsAppendSystemPrompt: true,
		});
		expect(out.delivery).toEqual({ via: 'flag' });
		expect(out.args).toEqual(['--print', '--append-system-prompt', 'SYS']);
		expect(out.prompt).toBe('user prompt');
	});

	it('sends the flag again on a resume: the flag is not kept in the transcript', () => {
		const out = applySystemPromptDelivery({
			...base,
			systemPrompt: 'SYS',
			supportsAppendSystemPrompt: true,
			isResume: true,
		});
		expect(out.args).toContain('--append-system-prompt');
	});

	it('leaves the file form to the caller on a Windows host', () => {
		const out = applySystemPromptDelivery({
			...base,
			systemPrompt: 'SYS',
			supportsAppendSystemPrompt: true,
			isWindowsHost: true,
		});
		expect(out.delivery).toEqual({ via: 'file' });
		expect(out.args).toEqual(['--print']);
	});

	it('keeps the inline flag over SSH even on a Windows host', () => {
		const out = applySystemPromptDelivery({
			...base,
			systemPrompt: 'SYS',
			supportsAppendSystemPrompt: true,
			isWindowsHost: true,
			sshRemote: true,
		});
		expect(out.delivery).toEqual({ via: 'flag' });
	});

	it('embeds the system prompt in the first turn of a provider with no flag', () => {
		const out = applySystemPromptDelivery({
			...base,
			systemPrompt: 'SYS',
			supportsAppendSystemPrompt: false,
		});
		expect(out.delivery).toEqual({ via: 'embed' });
		expect(out.args).toEqual(['--print']);
		expect(out.prompt).toBe(embedSystemPromptInPrompt('SYS', 'user prompt'));
	});

	it('sends nothing on a resume of an embedding provider', () => {
		const out = applySystemPromptDelivery({
			...base,
			systemPrompt: 'SYS',
			supportsAppendSystemPrompt: false,
			isResume: true,
		});
		expect(out.delivery).toEqual({ via: 'skip-on-resume' });
		expect(out.prompt).toBe('user prompt');
	});

	it('makes the system prompt the prompt when there is no user prompt to embed into', () => {
		const out = applySystemPromptDelivery({
			...base,
			prompt: '',
			systemPrompt: 'SYS',
			supportsAppendSystemPrompt: false,
		});
		expect(out.delivery).toEqual({ via: 'as-prompt' });
		expect(out.prompt).toBe('SYS');
	});

	it('changes nothing without a system prompt', () => {
		const out = applySystemPromptDelivery({
			...base,
			systemPrompt: undefined,
			supportsAppendSystemPrompt: true,
		});
		expect(out).toEqual({ args: ['--print'], prompt: 'user prompt', delivery: { via: 'none' } });
	});
});

describe('applyCopilotPreamble', () => {
	it('puts the trimmed preamble in front of a Copilot prompt', () => {
		expect(applyCopilotPreamble('copilot-cli', 'task', '  PRE\n')).toBe('PRE\n\ntask');
	});

	it('leaves other providers alone', () => {
		expect(applyCopilotPreamble('claude-code', 'task', 'PRE')).toBe('task');
	});

	it('does nothing for a blank or missing preamble, or no prompt', () => {
		expect(applyCopilotPreamble('copilot-cli', 'task', '  ')).toBe('task');
		expect(applyCopilotPreamble('copilot-cli', 'task', undefined)).toBe('task');
		expect(applyCopilotPreamble('copilot-cli', undefined, 'PRE')).toBeUndefined();
	});
});
