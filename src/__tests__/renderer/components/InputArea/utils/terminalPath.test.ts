import { describe, expect, it } from 'vitest';
import { formatTerminalCwd } from '../../../../../renderer/components/InputArea/utils/terminalPath';
import { AGENT_MODES, createModeSession } from '../../../../helpers';
import { createInputAreaSession } from '../_fixtures';

describe('InputArea terminalPath util', () => {
	it('formats local user paths with tilde', () => {
		const session = createInputAreaSession({
			inputMode: 'terminal',
			shellCwd: '/Users/test/project/src',
		});

		expect(formatTerminalCwd(session)).toBe('~/project/src');
	});

	it('formats linux home paths with tilde', () => {
		const session = createInputAreaSession({
			inputMode: 'terminal',
			shellCwd: '/home/saif/app',
		});

		expect(formatTerminalCwd(session)).toBe('~/app');
	});

	it('prefers the remote cwd and never names the remote (the mode pill is the one mark)', () => {
		const session = createInputAreaSession({
			inputMode: 'terminal',
			sshRemoteId: 'remote-1',
			sshRemote: { name: 'prod' } as any,
			remoteCwd: '/home/ubuntu/repo',
		});

		expect(formatTerminalCwd(session)).toBe('~/repo');
	});

	it('mode parity: local, SSH, and hosted agents show their directory the same way', () => {
		const [local, ssh, hosted] = AGENT_MODES.map((mode) =>
			formatTerminalCwd(
				createModeSession(mode, {
					inputMode: 'terminal',
					cwd: '/home/ubuntu/repo',
					shellCwd: '/home/ubuntu/repo',
					remoteCwd: '/home/ubuntu/repo',
					sshRemote: { name: 'prod' } as any,
				})
			)
		);
		expect(local).toBe('~/repo');
		expect(ssh).toBe(local);
		expect(hosted).toBe(local);
	});

	it('falls back to configured SSH working directory', () => {
		const session = createInputAreaSession({
			inputMode: 'terminal',
			sessionSshRemoteConfig: {
				enabled: true,
				workingDirOverride: '/srv/app',
			} as any,
		});

		expect(formatTerminalCwd(session)).toBe('/srv/app');
	});
});
