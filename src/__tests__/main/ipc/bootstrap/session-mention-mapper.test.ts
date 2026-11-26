/**
 * The desktop's binding of `toGroupChatSessionInfo`: sessions as the group chat router resolves a
 * mention to them, with the desktop's SSH remote store and its live process liveness.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../main/utils/agent-busy', () => ({
	isAgentBusy: vi.fn((session: { id: string }) => session.id === 'busy'),
}));

import {
	mapSessionsForMentions,
	type HostedBusySource,
} from '../../../../main/ipc/bootstrap/session-mention-mapper';
import { AGENT_MODES, agentModeFields } from '../../../helpers/mockSession';

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
	describe('the same participant in every mode (A1.9)', () => {
		// The host's records as the peer mirror holds them: h1 is mid-turn there, h2 is free.
		const host = (enabled = true): HostedBusySource => ({
			hostingEnabled: () => enabled,
			peers: () => [
				{
					peerId: 'box',
					agents: [
						{ id: 'h1', state: 'idle', aiTabs: [{ id: 't1', state: 'busy' }] },
						{ id: 'h2', state: 'idle', aiTabs: [{ id: 't1', state: 'idle' }] },
					] as never,
				},
			],
		});

		it.each(AGENT_MODES)(
			'a %s agent mid-turn reads busy and a free one reads free, so a busy one waits alike',
			(mode) => {
				const fields = agentModeFields(mode);
				// Where the turn runs: a process here for local and SSH, the host for hosted.
				const running = {
					...fields,
					id: mode === 'hosted' ? 'running' : 'busy',
					name: 'Running',
					toolType: 'claude-code',
					cwd: '/a',
				};
				const free = {
					...fields,
					...(mode === 'hosted' ? { liftedTo: { peer: 'box', agentId: 'h2', at: 1 } } : {}),
					id: 'free',
					name: 'Free',
					toolType: 'claude-code',
					cwd: '/b',
				};
				const mapped = mapSessionsForMentions(
					[running, free],
					remote as never,
					{} as never,
					host()
				);

				expect(mapped.map((s) => s.isBusy)).toEqual([true, false]);
				expect(mapped[1]).toMatchObject({
					sshRemoteName: mode === 'local' ? undefined : 'Box',
					sshRemoteConfig: mode === 'local' ? undefined : { enabled: true, remoteId: 'r1' },
				});
			}
		);

		it('reads a hosted agent as its SSH agent when hosting is off', () => {
			const hosted = {
				...agentModeFields('hosted'),
				id: 'running',
				name: 'A',
				toolType: 'claude-code',
				cwd: '/a',
			};
			const [mapped] = mapSessionsForMentions([hosted], remote as never, {} as never, host(false));
			expect(mapped.isBusy).toBe(false);
		});
	});
});
