/**
 * The desktop's binding of `toGroupChatSessionInfo`: sessions as the group chat router resolves a
 * mention to them, with the desktop's SSH remote store and its live process liveness.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../main/utils/agent-busy', () => ({
	isAgentBusy: vi.fn((session: { id: string }) => session.id === 'busy'),
}));

import { mapSessionsForMentions } from '../../../../main/ipc/bootstrap/session-mention-mapper';

const remote = (id: string) => (id === 'r1' ? { id: 'r1', name: 'Box' } : undefined);

describe('mapSessionsForMentions', () => {
	it('maps each session to what a mention needs, with the SSH remote named for the card', () => {
		const [mapped] = mapSessionsForMentions(
			[
				{
					id: 's1',
					name: 'Alpha',
					toolType: 'claude-code',
					cwd: '/work',
					customArgs: '--x',
					customModel: 'opus',
					enableMaestroP: true,
					sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
					autoRunFolderPath: '/runs',
					worktreeConfig: { basePath: '/wt' },
				},
			],
			remote as never,
			{} as never
		);

		expect(mapped).toMatchObject({
			id: 's1',
			name: 'Alpha',
			toolType: 'claude-code',
			cwd: '/work',
			customArgs: '--x',
			customModel: 'opus',
			enableMaestroP: true,
			sshRemoteName: 'Box',
			sshRemoteConfig: { enabled: true, remoteId: 'r1' },
			autoRunFolderPath: '/runs',
			worktreeBasePath: '/wt',
			isBusy: false,
		});
	});

	it('asks live liveness whether an agent is busy: the stored record always reads idle', () => {
		const mapped = mapSessionsForMentions(
			[
				{ id: 'busy', name: 'A', toolType: 'claude-code', cwd: '/a', state: 'idle' },
				{ id: 'free', name: 'B', toolType: 'claude-code', cwd: '/b', state: 'idle' },
			],
			remote as never,
			{} as never
		);
		expect(mapped.map((s) => s.isBusy)).toEqual([true, false]);
	});

	it('falls back to the full path for the directory', () => {
		const [mapped] = mapSessionsForMentions(
			[{ id: 's1', name: 'A', toolType: 'codex', fullPath: '/full' }],
			remote as never
		);
		expect(mapped.cwd).toBe('/full');
	});
});
