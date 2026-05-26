import { describe, expect, it } from 'vitest';
import { formatTerminalCwd } from '../../../../../renderer/components/InputArea/utils/terminalPath';
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

	it('prefixes SSH remote names and prefers remote cwd', () => {
		const session = createInputAreaSession({
			inputMode: 'terminal',
			sshRemoteId: 'remote-1',
			sshRemote: { name: 'prod' } as any,
			remoteCwd: '/home/ubuntu/repo',
		});

		expect(formatTerminalCwd(session)).toBe('PROD:~/repo');
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
