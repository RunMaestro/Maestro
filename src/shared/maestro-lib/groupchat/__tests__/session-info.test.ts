/**
 * An agent as a group chat resolves an `@mention` to it (`toGroupChatSessionInfo`).
 */
import { describe, expect, it } from 'vitest';

import { toGroupChatSessionInfo, type MentionableSession } from '../session-info';

const session = (overrides: Partial<MentionableSession> = {}): MentionableSession => ({
	id: 'a1',
	name: 'Alpha',
	toolType: 'claude-code',
	cwd: '/work/alpha',
	...overrides,
});

const context = (overrides = {}) => ({
	sshRemoteName: (id: string) => (id === 'r1' ? 'Box' : undefined),
	isBusy: false,
	homeDir: '/home/me',
	...overrides,
});

describe('toGroupChatSessionInfo', () => {
	it('carries what a participant needs to launch as its agent would', () => {
		const info = toGroupChatSessionInfo(
			session({
				customArgs: '--foo',
				customEnvVars: { A: '1' },
				customModel: 'opus',
				enableMaestroP: true,
				maestroPMode: 'dynamic',
				maestroPPath: '/p.js',
				autoRunFolderPath: '/runs',
			}),
			context({ isBusy: true })
		);

		expect(info).toEqual({
			id: 'a1',
			name: 'Alpha',
			toolType: 'claude-code',
			cwd: '/work/alpha',
			customArgs: '--foo',
			customEnvVars: { A: '1' },
			customModel: 'opus',
			enableMaestroP: true,
			maestroPMode: 'dynamic',
			maestroPPath: '/p.js',
			sshRemoteName: undefined,
			sshRemoteConfig: undefined,
			autoRunFolderPath: '/runs',
			isBusy: true,
		});
	});

	it('falls back from the working directory to the full path to the home directory', () => {
		expect(toGroupChatSessionInfo(session({ cwd: '', fullPath: '/full' }), context()).cwd).toBe(
			'/full'
		);
		expect(toGroupChatSessionInfo(session({ cwd: undefined }), context()).cwd).toBe('/home/me');
	});

	it('names an enabled SSH remote for the participant’s card, and keeps the whole config', () => {
		const ssh = { enabled: true, remoteId: 'r1' };
		const info = toGroupChatSessionInfo(session({ sessionSshRemoteConfig: ssh }), context());
		expect(info.sshRemoteName).toBe('Box');
		expect(info.sshRemoteConfig).toEqual(ssh);
	});

	it('names no remote for a disabled config, or one that no longer exists', () => {
		const off = { enabled: false, remoteId: 'r1' };
		expect(
			toGroupChatSessionInfo(session({ sessionSshRemoteConfig: off }), context()).sshRemoteName
		).toBeUndefined();
		const gone = { enabled: true, remoteId: 'zzz' };
		expect(
			toGroupChatSessionInfo(session({ sessionSshRemoteConfig: gone }), context()).sshRemoteName
		).toBeUndefined();
	});
});
