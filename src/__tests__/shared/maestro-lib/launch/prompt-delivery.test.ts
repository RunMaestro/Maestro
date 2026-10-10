import { describe, it, expect } from 'vitest';
import {
	buildPromptArgv,
	resolvePromptDelivery,
	resolveSystemPromptDelivery,
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
