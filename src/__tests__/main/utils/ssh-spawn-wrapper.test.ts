import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Covers the two things the wrapper decides that its callers cannot see:
 * which env vars actually cross the SSH boundary, and what it does when the
 * remote the user picked no longer resolves.
 */

const mockGetSshRemoteConfig = vi.fn();
vi.mock('../../../main/utils/ssh-remote-resolver', () => ({
	getSshRemoteConfig: (...args: unknown[]) => mockGetSshRemoteConfig(...args),
}));

const mockBuildSshCommand = vi.fn();
const mockBuildSshCommandWithStdin = vi.fn();
vi.mock('../../../main/utils/ssh-command-builder', () => ({
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
