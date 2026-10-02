import { describe, it, expect } from 'vitest';
import { hostVisibleProjectRoot } from '../../shared/hostVisibleProjectRoot';

const remotes = [{ id: 'wsl', hostMountRoot: '\\\\wsl.localhost\\Ubuntu' }, { id: 'box' }];

describe('hostVisibleProjectRoot', () => {
	it('returns the local root for a session without SSH', () => {
		expect(hostVisibleProjectRoot({ projectRoot: 'C:\\app' }, remotes, 'C:\\home')).toBe('C:\\app');
		expect(hostVisibleProjectRoot({}, remotes, 'C:\\home')).toBe('C:\\home');
	});

	it('maps a remote root through the remote host mount', () => {
		const session = {
			projectRoot: '/home/dev/app',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'wsl' },
		};
		expect(hostVisibleProjectRoot(session, remotes, 'C:\\home')).toBe(
			'\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
		);
	});

	it('prefers the working directory override as the remote root', () => {
		const session = {
			projectRoot: 'C:\\stale',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'wsl', workingDirOverride: '/srv/x' },
		};
		expect(hostVisibleProjectRoot(session, remotes, 'C:\\home')).toBe(
			'\\\\wsl.localhost\\Ubuntu\\srv\\x'
		);
	});

	it('returns null for a remote with no host mount, so nothing is read from a wrong path', () => {
		const session = {
			projectRoot: '/home/dev/app',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'box' },
		};
		expect(hostVisibleProjectRoot(session, remotes, 'C:\\home')).toBeNull();
	});

	it('ignores a disabled SSH config', () => {
		const session = {
			projectRoot: 'C:\\app',
			sessionSshRemoteConfig: { enabled: false, remoteId: 'wsl' },
		};
		expect(hostVisibleProjectRoot(session, remotes, 'C:\\home')).toBe('C:\\app');
	});
});
