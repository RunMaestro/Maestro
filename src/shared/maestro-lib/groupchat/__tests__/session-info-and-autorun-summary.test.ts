import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { toGroupChatSessionInfo } from '../session-info';
import type { MentionableSession } from '../session-info';
import { groupChatAutoRunSummary } from '../autorun-summary';
__maestroMicrobenchDescribe('session-info', () => {
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
					customPath: '/opt/bin/claude',
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
				customPath: '/opt/bin/claude',
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
});
__maestroMicrobenchDescribe('autorun-summary', () => {
	describe('groupChatAutoRunSummary', () => {
		it('says how many tasks a finished run completed', () => {
			expect(
				groupChatAutoRunSummary({
					wasStopped: false,
					completedTasks: 4,
					totalTasks: 4,
					documentsProcessed: 2,
				})
			).toBe('Auto Run complete: 4/4 tasks finished across 2 document(s).');
		});

		it('says a stopped run was stopped, and how far it got', () => {
			expect(
				groupChatAutoRunSummary({
					wasStopped: true,
					completedTasks: 1,
					totalTasks: 4,
					documentsProcessed: 1,
				})
			).toBe('Auto Run stopped: completed 1 of 4 tasks across 1 document(s).');
		});
	});
});
