import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wrapSpawnWithSsh, type SshSpawnWrapConfig } from '../../../main/utils/ssh-spawn-wrapper';
import type { SshRemoteSettingsStore } from '../../../main/utils/ssh-remote-resolver';
import type { AgentSshRemoteConfig, SshRemoteConfig } from '../../../shared/types';

const mocks = vi.hoisted(() => ({
	buildSshCommand: vi.fn(),
	homedir: vi.fn(() => '/Users/testuser'),
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	return {
		...actual,
		homedir: mocks.homedir,
	};
});

vi.mock('../../../main/utils/ssh-command-builder', () => ({
	buildSshCommand: mocks.buildSshCommand,
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

describe('wrapSpawnWithSsh', () => {
	const remote: SshRemoteConfig = {
		id: 'remote-1',
		name: 'Dev Server',
		host: 'dev.example.com',
		port: 22,
		username: 'dev',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};

	const disabledRemote: SshRemoteConfig = {
		...remote,
		id: 'disabled-remote',
		name: 'Disabled Server',
		enabled: false,
	};

	const sshConfig: AgentSshRemoteConfig = {
		enabled: true,
		remoteId: 'remote-1',
	};

	const localConfig: SshSpawnWrapConfig = {
		command: 'claude',
		args: ['--print'],
		cwd: '/workspace/project',
		prompt: 'Summarize the repo',
		customEnvVars: {
			ANTHROPIC_API_KEY: 'test-key',
		},
	};

	function createStore(remotes: SshRemoteConfig[]): SshRemoteSettingsStore {
		return {
			getSshRemotes: vi.fn(() => remotes),
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.homedir.mockReturnValue('/Users/testuser');
		mocks.buildSshCommand.mockResolvedValue({
			command: 'ssh',
			args: ['-tt', 'dev@dev.example.com', 'claude --print'],
		});
	});

	it('returns the original spawn config when no SSH config is provided', async () => {
		const result = await wrapSpawnWithSsh(localConfig, undefined, createStore([remote]));

		expect(result).toEqual({
			command: 'claude',
			args: ['--print'],
			cwd: '/workspace/project',
			customEnvVars: { ANTHROPIC_API_KEY: 'test-key' },
			prompt: 'Summarize the repo',
			sshRemoteUsed: null,
		});
		expect(mocks.buildSshCommand).not.toHaveBeenCalled();
		expect(mocks.logger.warn).not.toHaveBeenCalled();
	});

	it('returns the original spawn config when SSH is disabled for the session', async () => {
		const result = await wrapSpawnWithSsh(
			localConfig,
			{ enabled: false, remoteId: 'remote-1' },
			createStore([remote])
		);

		expect(result.sshRemoteUsed).toBeNull();
		expect(result.command).toBe(localConfig.command);
		expect(result.args).toEqual(localConfig.args);
		expect(result.cwd).toBe(localConfig.cwd);
		expect(result.customEnvVars).toEqual(localConfig.customEnvVars);
		expect(result.prompt).toBe(localConfig.prompt);
		expect(mocks.buildSshCommand).not.toHaveBeenCalled();
	});

	it('falls back to local execution when the requested remote is missing', async () => {
		const result = await wrapSpawnWithSsh(localConfig, sshConfig, createStore([]));

		expect(result).toEqual({
			command: 'claude',
			args: ['--print'],
			cwd: '/workspace/project',
			customEnvVars: { ANTHROPIC_API_KEY: 'test-key' },
			prompt: 'Summarize the repo',
			sshRemoteUsed: null,
		});
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			'SSH remote config not found, falling back to local execution',
			'[SshSpawnWrapper]',
			{
				remoteId: 'remote-1',
				source: 'none',
			}
		);
		expect(mocks.buildSshCommand).not.toHaveBeenCalled();
	});

	it('falls back to local execution when the requested remote is disabled', async () => {
		const result = await wrapSpawnWithSsh(
			localConfig,
			{ enabled: true, remoteId: 'disabled-remote' },
			createStore([disabledRemote])
		);

		expect(result.sshRemoteUsed).toBeNull();
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			'SSH remote config not found, falling back to local execution',
			'[SshSpawnWrapper]',
			{
				remoteId: 'disabled-remote',
				source: 'none',
			}
		);
		expect(mocks.buildSshCommand).not.toHaveBeenCalled();
	});

	it('wraps a small prompt with the default prompt separator for SSH execution', async () => {
		const result = await wrapSpawnWithSsh(localConfig, sshConfig, createStore([remote]));

		expect(mocks.buildSshCommand).toHaveBeenCalledWith(remote, {
			command: 'claude',
			args: ['--print', '--', 'Summarize the repo'],
			cwd: '/workspace/project',
			env: { ANTHROPIC_API_KEY: 'test-key' },
			useStdin: false,
		});
		expect(result).toEqual({
			command: 'ssh',
			args: ['-tt', 'dev@dev.example.com', 'claude --print'],
			cwd: '/Users/testuser',
			customEnvVars: undefined,
			prompt: undefined,
			sshRemoteUsed: remote,
		});
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'Wrapping spawn with SSH remote execution',
			'[SshSpawnWrapper]',
			{
				remoteId: 'remote-1',
				remoteName: 'Dev Server',
				host: 'dev.example.com',
			}
		);
		expect(mocks.logger.debug).toHaveBeenCalledWith(
			'SSH command built',
			'[SshSpawnWrapper]',
			expect.objectContaining({
				remoteCommand: 'claude',
				remoteArgs: ['--print', '--', 'Summarize the repo'],
				remoteCwd: '/workspace/project',
				sshArgsCount: 3,
				sshBinary: 'ssh',
			})
		);
	});

	it('uses promptArgs and agentBinaryName for provider-specific SSH prompt flags', async () => {
		const promptArgs = vi.fn((prompt: string) => ['-p', prompt]);

		await wrapSpawnWithSsh(
			{
				...localConfig,
				command: '/opt/homebrew/bin/opencode',
				agentBinaryName: 'opencode',
				promptArgs,
			},
			sshConfig,
			createStore([remote])
		);

		expect(promptArgs).toHaveBeenCalledWith('Summarize the repo');
		expect(mocks.buildSshCommand).toHaveBeenCalledWith(
			remote,
			expect.objectContaining({
				command: 'opencode',
				args: ['--print', '-p', 'Summarize the repo'],
				useStdin: false,
			})
		);
	});

	it('passes a small prompt positionally when the agent does not use a separator', async () => {
		await wrapSpawnWithSsh(
			{
				...localConfig,
				noPromptSeparator: true,
			},
			sshConfig,
			createStore([remote])
		);

		expect(mocks.buildSshCommand).toHaveBeenCalledWith(
			remote,
			expect.objectContaining({
				args: ['--print', 'Summarize the repo'],
				useStdin: false,
			})
		);
	});

	it('passes large prompts through stdin mode instead of embedding them in SSH args', async () => {
		const largePrompt = 'x'.repeat(4001);

		const result = await wrapSpawnWithSsh(
			{
				...localConfig,
				prompt: largePrompt,
			},
			sshConfig,
			createStore([remote])
		);

		expect(mocks.buildSshCommand).toHaveBeenCalledWith(
			remote,
			expect.objectContaining({
				args: ['--print', '--input-format', 'stream-json'],
				useStdin: true,
			})
		);
		expect(result.prompt).toBe(largePrompt);
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'Using stdin for large prompt in SSH remote execution',
			'[SshSpawnWrapper]',
			{
				promptLength: 4001,
				reason: 'avoid-command-line-length-limit',
			}
		);
	});

	it('does not enable stdin mode when args include another input format', async () => {
		await wrapSpawnWithSsh(
			{
				...localConfig,
				args: ['--input-format', 'text'],
				prompt: undefined,
			},
			sshConfig,
			createStore([remote])
		);

		expect(mocks.buildSshCommand).toHaveBeenCalledWith(
			remote,
			expect.objectContaining({
				args: ['--input-format', 'text'],
				useStdin: false,
			})
		);
	});

	it('propagates SSH command build failures to the caller', async () => {
		mocks.buildSshCommand.mockRejectedValue(new Error('ssh refused'));

		await expect(wrapSpawnWithSsh(localConfig, sshConfig, createStore([remote]))).rejects.toThrow(
			'ssh refused'
		);
	});
});
