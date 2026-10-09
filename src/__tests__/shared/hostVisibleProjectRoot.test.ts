import { describe, it, expect } from 'vitest';
import {
	hostVisibleProjectRoot,
	remoteVisiblePath,
	resolveHostProjectRoot,
} from '../../shared/hostVisibleProjectRoot';

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

	it('preserves the original project root for a remote with no host mount', () => {
		const session = {
			projectRoot: '/home/dev/app',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'box' },
		};
		expect(hostVisibleProjectRoot(session, remotes, 'C:\\home')).toBe('/home/dev/app');
	});

	it('ignores a disabled SSH config', () => {
		const session = {
			projectRoot: 'C:\\app',
			sessionSshRemoteConfig: { enabled: false, remoteId: 'wsl' },
		};
		expect(hostVisibleProjectRoot(session, remotes, 'C:\\home')).toBe('C:\\app');
	});
	it.each([
		{ projectRoot: 'C:\\raw\\..\\project', cwd: 'ignored' },
		{ cwd: '/home//dev/../project' },
		{ fullPath: '/old//root' },
		{},
	])('preserves all legacy fallback bytes without hostMountRoot: %j', (fields) => {
		const expected = fields.projectRoot || fields.cwd || fields.fullPath || 'fallback';
		for (const ssh of [
			undefined,
			{ enabled: true, remoteId: 'box', workingDirOverride: '/override' },
			{ enabled: true, remoteId: 'missing' },
		]) {
			expect(
				hostVisibleProjectRoot({ ...fields, sessionSshRemoteConfig: ssh }, remotes, 'fallback')
			).toBe(expected);
		}
	});

	it.each(['/../outside', '/home/../../outside', '/home/..\\..\\outside'])(
		'rejects a remote root that escapes the declared filesystem root: %s',
		(projectRoot) => {
			expect(
				hostVisibleProjectRoot(
					{ projectRoot, sessionSshRemoteConfig: { enabled: true, remoteId: 'wsl' } },
					remotes,
					'fallback'
				)
			).toBeNull();
		}
	);

	it('handles mixed Windows separators without escaping the mount', () => {
		expect(
			hostVisibleProjectRoot(
				{
					projectRoot: '/home\\dev/../app',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'wsl' },
				},
				remotes,
				'fallback'
			)
		).toBe('\\\\wsl.localhost\\Ubuntu\\home\\app');
	});

	it('supports a POSIX root mount', () => {
		expect(
			hostVisibleProjectRoot(
				{ projectRoot: '/home/app', sessionSshRemoteConfig: { enabled: true, remoteId: 'root' } },
				[{ id: 'root', hostMountRoot: '/' }],
				'fallback'
			)
		).toBe('/home/app');
	});
});

describe('remoteVisiblePath', () => {
	it('maps Windows and POSIX host mounts without leaking host paths', () => {
		expect(
			remoteVisiblePath('\\\\wsl.localhost\\Ubuntu\\home\\dev\\app\\tasks.md', remotes[0])
		).toBe('/home/dev/app/tasks.md');
		expect(
			remoteVisiblePath('/mnt/box/home/dev/app', { id: 'box', hostMountRoot: '/mnt/box' })
		).toBe('/home/dev/app');
		expect(remoteVisiblePath('/home/app', { id: 'root', hostMountRoot: '/' })).toBe('/home/app');
	});
	it('respects mount boundaries and rejects escape attempts', () => {
		const remote = { id: 'box', hostMountRoot: '/mnt/box' };
		for (const input of ['/mnt/box-other/task.md', '/mnt/box/../outside', '/elsewhere/task.md']) {
			expect(remoteVisiblePath(input, remote)).toBe(input);
		}
		expect(remoteVisiblePath('/mnt/box/a/../task.md', remote)).toBe('/task.md');
	});
});

describe('resolveHostProjectRoot', () => {
	const mountedRemotes = [
		{ id: 'one', hostMountRoot: '/mnt/one' },
		{ id: 'two', hostMountRoot: '/mnt/two' },
	];
	const sessions = mountedRemotes.map((remote) => ({
		id: remote.id,
		projectRoot: '/home/app',
		sessionSshRemoteConfig: { enabled: true, remoteId: remote.id },
	}));
	it('disambiguates identical POSIX roots using identity or host namespace', () => {
		expect(() => resolveHostProjectRoot('/home/app', sessions, mountedRemotes)).toThrow(
			'Ambiguous'
		);
		expect(resolveHostProjectRoot('/home/app', sessions, mountedRemotes, 'two')).toBe(
			'/mnt/two/home/app'
		);
		expect(resolveHostProjectRoot('/mnt/one/home/app', sessions, mountedRemotes)).toBe(
			'/mnt/one/home/app'
		);
	});
	it('preserves a local project sharing a raw remote path', () => {
		expect(
			resolveHostProjectRoot(
				'/home/app',
				[...sessions, { id: 'local', projectRoot: '/home/app' }],
				mountedRemotes
			)
		).toBe('/home/app');
	});
	it('fails closed for a missing identity or mount traversal', () => {
		expect(() => resolveHostProjectRoot('/home/app', sessions, mountedRemotes, 'gone')).toThrow(
			'not found'
		);
		expect(() =>
			resolveHostProjectRoot(
				'/../outside',
				[{ ...sessions[0], projectRoot: '/../outside' }],
				mountedRemotes,
				'one'
			)
		).toThrow('escapes');
	});
});
