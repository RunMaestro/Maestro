import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wrapSpawnWithSsh } from '../../../main/utils/ssh-spawn-wrapper';
import { buildSshCommand, buildSshCommandWithStdin } from '../../../main/utils/ssh-command-builder';
import type { SshRemoteConfig } from '../../../shared/types';

vi.mock('../../../main/utils/ssh-command-builder', () => ({
	buildSshCommand: vi.fn(),
	buildSshCommandWithStdin: vi.fn(),
}));

const remote: SshRemoteConfig = {
	id: 'remote-1',
	name: 'Remote One',
	host: 'remote.example.com',
	port: 22,
	username: 'dev',
	enabled: true,
};

const sshStore = {
	getSshRemotes: () => [remote],
};

describe('ssh-spawn-wrapper', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(buildSshCommand).mockResolvedValue({
			command: 'ssh',
			args: ['remote.example.com', 'claude'],
			remoteCommandLine: 'claude',
		});
		vi.mocked(buildSshCommandWithStdin).mockResolvedValue({
			command: 'ssh',
			args: ['remote.example.com', '/bin/bash'],
			stdinScript: 'exec claude',
			remoteCommandLine: 'claude',
		});
	});

	it('uses session workingDirOverride as remote cwd for command-line prompts', async () => {
		await wrapSpawnWithSsh(
			{
				command: 'claude',
				args: ['--print'],
				cwd: '/Users/jta/git-projects',
				prompt: 'hi',
				agentBinaryName: 'claude',
			},
			{ enabled: true, remoteId: 'remote-1', workingDirOverride: '~/git-projects' },
			sshStore
		);

		expect(buildSshCommand).toHaveBeenCalledWith(
			remote,
			expect.objectContaining({
				cwd: '~/git-projects',
			})
		);
	});

	it('uses session workingDirOverride as remote cwd for stdin prompts', async () => {
		await wrapSpawnWithSsh(
			{
				command: 'claude',
				args: ['--print'],
				cwd: '/Users/jta/git-projects',
				prompt: 'x'.repeat(4001),
				agentBinaryName: 'claude',
			},
			{ enabled: true, remoteId: 'remote-1', workingDirOverride: '~/git-projects' },
			sshStore
		);

		expect(buildSshCommandWithStdin).toHaveBeenCalledWith(
			remote,
			expect.objectContaining({
				cwd: '~/git-projects',
			})
		);
	});

	it('normalizes local working directory args to current directory for SSH commands', async () => {
		await wrapSpawnWithSsh(
			{
				command: 'codex',
				args: ['-C', '/Users/jta/git-projects/agents/rai', 'exec'],
				cwd: '/Users/jta/git-projects/agents/rai',
				prompt: 'hi',
				agentBinaryName: 'codex',
			},
			{
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/home/rai/git-projects/agents/rai',
			},
			sshStore
		);

		expect(buildSshCommand).toHaveBeenCalledWith(
			remote,
			expect.objectContaining({
				args: ['-C', '.', 'exec', '--', 'hi'],
				cwd: '/home/rai/git-projects/agents/rai',
			})
		);
	});

	it('normalizes inline local working directory args to current directory for SSH commands', async () => {
		await wrapSpawnWithSsh(
			{
				command: 'codex',
				args: ['--cwd=/Users/jta/git-projects/agents/rai', 'exec'],
				cwd: '/Users/jta/git-projects/agents/rai',
				prompt: 'hi',
				agentBinaryName: 'codex',
			},
			{
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/home/rai/git-projects/agents/rai',
			},
			sshStore
		);

		expect(buildSshCommand).toHaveBeenCalledWith(
			remote,
			expect.objectContaining({
				args: ['--cwd=.', 'exec', '--', 'hi'],
				cwd: '/home/rai/git-projects/agents/rai',
			})
		);
	});
});
