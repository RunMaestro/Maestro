import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Covers the two things the wrapper decides that its callers cannot see:
 * which env vars actually cross the SSH boundary, and what it does when the
 * remote the user picked no longer resolves.
 */

const mockGetSshRemoteConfig = vi.fn();
vi.mock('../../../shared/maestro-lib/launch/ssh-remote-resolver', () => ({
	getSshRemoteConfig: (...args: unknown[]) => mockGetSshRemoteConfig(...args),
}));

const mockBuildSshCommand = vi.fn();
const mockBuildSshCommandWithStdin = vi.fn();
vi.mock('../../../shared/maestro-lib/launch/ssh-command-builder', () => ({
	buildSshCommand: (...args: unknown[]) => mockBuildSshCommand(...args),
	buildSshCommandWithStdin: (...args: unknown[]) => mockBuildSshCommandWithStdin(...args),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
	wrapSpawnWithSsh,
	sshUnresolvedRemoteMessage,
} from '../../../main/utils/ssh-spawn-wrapper';
import {
	POSIX_PROMPT_ARGV_MAX_BYTES,
	promptExceedsArgvLimit,
	WINDOWS_PROMPT_ARGV_MAX_CHARS,
} from '../../../shared/maestro-lib/launch/prompt-delivery';
import type { SshRemoteSettingsStore } from '../../../main/utils/ssh-remote-resolver';

const remote = {
	id: 'jennifer-box',
	name: 'Jennifer',
	host: 'jennifer.local',
	username: 'pedram',
	enabled: true,
};

const sshStore = { getSshRemotes: () => [remote] } as unknown as SshRemoteSettingsStore;

/** Read the `env` the wrapper handed to whichever builder it chose. */
function envPassedToBuilder(builder: ReturnType<typeof vi.fn>): Record<string, string> {
	return (builder.mock.calls[0][1] as { env: Record<string, string> }).env;
}

describe('wrapSpawnWithSsh', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSshRemoteConfig.mockReturnValue({ config: remote, source: 'session' });
		mockBuildSshCommand.mockResolvedValue({
			command: 'ssh',
			args: ['jennifer.local', 'claude'],
			remoteCommandLine: 'claude',
		});
		mockBuildSshCommandWithStdin.mockResolvedValue({
			command: 'ssh',
			args: ['jennifer.local'],
			stdinScript: '#!/bin/bash',
			remoteCommandLine: 'claude',
		});
	});

	const baseConfig = {
		command: '/opt/homebrew/bin/claude',
		args: ['--print'],
		cwd: '/remote/project',
		agentBinaryName: 'claude',
	};

	describe('blank env values', () => {
		it('does not export blank values to the remote host', async () => {
			// Nothing of the local env crosses the SSH boundary, so a blank here can
			// only ever produce `export FOO=''` on the remote - a set-but-empty
			// variable, which is what kills an agent that reads it as a path.
			await wrapSpawnWithSsh(
				{
					...baseConfig,
					customEnvVars: { CLAUDE_CONFIG_DIR: '', PADDED: '  ', KEPT: 'value' },
				},
				{ enabled: true, remoteId: 'jennifer-box' },
				sshStore
			);

			const env = envPassedToBuilder(mockBuildSshCommand);
			expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
			expect('PADDED' in env).toBe(false);
			expect(env.KEPT).toBe('value');
		});

		it('drops blanks on the large-prompt stdin path too', async () => {
			await wrapSpawnWithSsh(
				{
					...baseConfig,
					prompt: 'x'.repeat(4001),
					customEnvVars: { CLAUDE_CONFIG_DIR: '', KEPT: 'value' },
				},
				{ enabled: true, remoteId: 'jennifer-box' },
				sshStore
			);

			expect(mockBuildSshCommandWithStdin).toHaveBeenCalledTimes(1);
			const env = envPassedToBuilder(mockBuildSshCommandWithStdin);
			expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
			expect(env.KEPT).toBe('value');
		});

		it('still stamps the turn-origin marker after the user layers', async () => {
			// The marker is not a user value, so stripping must not reach it, and an
			// agent override must not be able to relabel a Cue run as interactive.
			await wrapSpawnWithSsh(
				{ ...baseConfig, customEnvVars: { MAESTRO_QUERY_SOURCE: 'user' }, querySource: 'cue' },
				{ enabled: true, remoteId: 'jennifer-box' },
				sshStore
			);

			expect(envPassedToBuilder(mockBuildSshCommand).MAESTRO_QUERY_SOURCE).toBe('cue');
		});
	});

	describe('stdin-script launch', () => {
		// Only a stdin-script launch can record the remote agent's pid, which is
		// what lets Stop reach the agent and not only the local ssh client.
		it('launches a small prompt through the stdin script when asked, prompt still in argv', async () => {
			const result = await wrapSpawnWithSsh(
				{ ...baseConfig, prompt: 'do the thing', launchViaStdinScript: true },
				{ enabled: true, remoteId: 'jennifer-box' },
				sshStore
			);

			expect(mockBuildSshCommand).not.toHaveBeenCalled();
			expect(mockBuildSshCommandWithStdin).toHaveBeenCalledTimes(1);
			const options = mockBuildSshCommandWithStdin.mock.calls[0][1] as {
				args: string[];
				stdinInput?: string;
			};
			expect(options.args).toContain('do the thing');
			expect(options.stdinInput).toBeUndefined();
			expect(result.sshStdinScript).toBe('#!/bin/bash');
			expect(result.prompt).toBeUndefined();
		});

		it('keeps the inline command for a small prompt by default', async () => {
			const result = await wrapSpawnWithSsh(
				{ ...baseConfig, prompt: 'do the thing' },
				{ enabled: true, remoteId: 'jennifer-box' },
				sshStore
			);

			expect(mockBuildSshCommand).toHaveBeenCalledTimes(1);
			expect(mockBuildSshCommandWithStdin).not.toHaveBeenCalled();
			expect(result.sshStdinScript).toBeUndefined();
		});

		/** The inline builder folds the remote command into one ssh argument, as the real one does. */
		function remoteCommandAsOneArg() {
			mockBuildSshCommand.mockImplementation(async (_remote, options: { args: string[] }) => ({
				command: 'ssh',
				args: ['jennifer.local', `claude ${options.args.join(' ')}`],
				remoteCommandLine: 'claude',
			}));
		}

		// MAESTRO-172/173/16C: a group chat participant or consult with a short
		// prompt still carries Maestro's whole system prompt inline
		// (`--append-system-prompt`, tens of KB) over SSH. Inline, that rides the
		// LOCAL ssh command line and a Windows host refuses it with ENAMETOOLONG.
		it('switches to the stdin script when the inline command line is too long for a Windows host', async () => {
			const systemPrompt = 'x'.repeat(WINDOWS_PROMPT_ARGV_MAX_CHARS);
			remoteCommandAsOneArg();

			const result = await wrapSpawnWithSsh(
				{
					...baseConfig,
					args: ['--print', '--append-system-prompt', systemPrompt],
					prompt: 'short question',
					isWindowsHost: true,
				},
				{ enabled: true, remoteId: 'jennifer-box' },
				sshStore
			);

			expect(mockBuildSshCommandWithStdin).toHaveBeenCalledTimes(1);
			const options = mockBuildSshCommandWithStdin.mock.calls[0][1] as {
				args: string[];
				stdinInput?: string;
			};
			expect(options.args).toContain(systemPrompt);
			expect(options.args).toContain('short question');
			expect(result.sshStdinScript).toBe('#!/bin/bash');
			expect(result.args).toEqual(['jennifer.local']);
		});

		// The same command starts fine from Linux or macOS, whose limit is per
		// argument (128 KiB on Linux), so it keeps the inline path and its -tt.
		it('keeps that command inline on a Linux or macOS host', async () => {
			remoteCommandAsOneArg();

			const result = await wrapSpawnWithSsh(
				{
					...baseConfig,
					args: ['--print', '--append-system-prompt', 'x'.repeat(WINDOWS_PROMPT_ARGV_MAX_CHARS)],
					prompt: 'short question',
					isWindowsHost: false,
				},
				{ enabled: true, remoteId: 'jennifer-box' },
				sshStore
			);

			expect(mockBuildSshCommandWithStdin).not.toHaveBeenCalled();
			expect(result.sshStdinScript).toBeUndefined();
		});

		// The SSH line is measured with the same quoting rule as a local prompt,
		// so the two cannot disagree: `ssh` plus one argument quoted to 29,996
		// characters is exactly the 30,000 cap, and two more `"` cross it.
		it.each([
			['crosses', 15_000, true],
			['stays under', 14_997, false],
		] as const)(
			'agrees with the prompt check when a Windows line %s the cap once quoted',
			async (_label, quotes, tooLong) => {
				const prompt = '"'.repeat(quotes);
				mockBuildSshCommand.mockResolvedValue({
					command: 'ssh',
					args: [prompt],
					remoteCommandLine: 'claude',
				});

				const result = await wrapSpawnWithSsh(
					{ ...baseConfig, prompt: 'short question', isWindowsHost: true },
					{ enabled: true, remoteId: 'jennifer-box' },
					sshStore
				);

				expect(promptExceedsArgvLimit(prompt, true)).toBe(tooLong);
				expect(mockBuildSshCommandWithStdin).toHaveBeenCalledTimes(tooLong ? 1 : 0);
				expect(result.sshStdinScript === undefined).toBe(!tooLong);
			}
		);

		// sshd hands the remote command to the login shell as one argument, so
		// past the POSIX per-argument cap neither end could start it inline.
		// Measured in UTF-8 bytes: 34,000 euro signs are 102,000 bytes.
		it('switches to the stdin script on a Linux or macOS host once one argument passes the byte cap', async () => {
			remoteCommandAsOneArg();
			const systemPrompt = '\u20ac'.repeat(34_000);
			expect(systemPrompt.length).toBeLessThan(POSIX_PROMPT_ARGV_MAX_BYTES);

			const result = await wrapSpawnWithSsh(
				{
					...baseConfig,
					args: ['--print', '--append-system-prompt', systemPrompt],
					prompt: 'short question',
					isWindowsHost: false,
				},
				{ enabled: true, remoteId: 'jennifer-box' },
				sshStore
			);

			expect(mockBuildSshCommandWithStdin).toHaveBeenCalledTimes(1);
			expect(result.sshStdinScript).toBe('#!/bin/bash');
		});
	});

	describe('unresolved remote', () => {
		it('reports sshRemoteUsed: null rather than throwing', async () => {
			// The wrapper itself degrades to local on purpose; the CONTRACT is that
			// callers detect it. Locking the shape in keeps a future "helpful" throw
			// from silently changing what every call site has to handle.
			mockGetSshRemoteConfig.mockReturnValue({ config: null, source: 'session' });

			const result = await wrapSpawnWithSsh(
				baseConfig,
				{ enabled: true, remoteId: 'gone' },
				sshStore
			);

			expect(result.sshRemoteUsed).toBeNull();
			expect(result.command).toBe('/opt/homebrew/bin/claude');
			// The trap: the cwd handed back is the REMOTE's, so a caller that takes
			// this result runs locally against a path that is missing or wrong.
			expect(result.cwd).toBe('/remote/project');
			expect(mockBuildSshCommand).not.toHaveBeenCalled();
		});

		it('names the remote in the message callers are meant to throw', () => {
			expect(sshUnresolvedRemoteMessage({ enabled: true, remoteId: 'jennifer-box' })).toContain(
				'"jennifer-box"'
			);
			expect(sshUnresolvedRemoteMessage({ enabled: true, remoteId: null })).toContain(
				'could not be resolved'
			);
		});
	});

	it('leaves the config untouched when SSH is switched off', async () => {
		const result = await wrapSpawnWithSsh(
			{ ...baseConfig, customEnvVars: { KEPT: 'value' } },
			{ enabled: false, remoteId: null },
			sshStore
		);

		expect(result.sshRemoteUsed).toBeNull();
		expect(result.customEnvVars).toEqual({ KEPT: 'value' });
		expect(mockGetSshRemoteConfig).not.toHaveBeenCalled();
	});
});
