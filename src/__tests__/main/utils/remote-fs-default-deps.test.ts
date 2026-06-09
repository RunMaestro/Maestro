import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshRemoteConfig } from '../../../shared/types';

const mocks = vi.hoisted(() => ({
	execFileNoThrow: vi.fn(),
	buildSshArgs: vi.fn(),
	resolveSshPath: vi.fn(),
}));

vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: mocks.execFileNoThrow,
}));

vi.mock('../../../main/ssh-remote-manager', () => ({
	sshRemoteManager: {
		buildSshArgs: mocks.buildSshArgs,
	},
}));

vi.mock('../../../main/utils/cliDetection', () => ({
	resolveSshPath: mocks.resolveSshPath,
}));

import { existsRemote } from '../../../main/utils/remote-fs';

describe('remote-fs default dependencies', () => {
	const baseConfig: SshRemoteConfig = {
		id: 'remote-defaults',
		name: 'Remote Defaults',
		host: 'dev.example.com',
		port: 22,
		username: 'tester',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.resolveSshPath.mockResolvedValue('/usr/bin/ssh');
		mocks.buildSshArgs.mockReturnValue(['-p', '22', 'tester@dev.example.com']);
		mocks.execFileNoThrow.mockResolvedValue({ stdout: 'EXISTS\n', stderr: '', exitCode: 0 });
	});

	it('resolves ssh, builds args from config, and executes through execFileNoThrow', async () => {
		const result = await existsRemote('/tmp/file.txt', baseConfig);

		expect(result).toEqual({ success: true, data: true });
		expect(mocks.resolveSshPath).toHaveBeenCalledOnce();
		expect(mocks.buildSshArgs).toHaveBeenCalledWith(baseConfig);
		expect(mocks.execFileNoThrow).toHaveBeenCalledWith(
			'/usr/bin/ssh',
			[
				'-p',
				'22',
				'tester@dev.example.com',
				`test -e '/tmp/file.txt' && echo "EXISTS" || echo "NOT_EXISTS"`,
			],
			undefined,
			{ timeout: 30000 }
		);
	});
});
