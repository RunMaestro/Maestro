/**
 * Tests for `resolveDataviewAgentContext` (src/main/dataview/agent-context.ts): a Dataview query names an
 * agent, and main turns it into the fallback root (DV-4) and the SSH remote (DV-6). SSH that is on but
 * cannot be resolved fails loudly; it never falls back to the local disk.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
	sessions: [] as Array<Record<string, unknown>>,
	sshRemotes: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../main/stores/getters', () => ({
	getLiveSessions: () => h.sessions,
	getSettingsStore: () => ({
		get: (key: string, fallback: unknown) => (key === 'sshRemotes' ? h.sshRemotes : fallback),
	}),
}));

import { resolveDataviewAgentContext } from '../../../main/dataview/agent-context';

describe('resolveDataviewAgentContext', () => {
	beforeEach(() => {
		h.sshRemotes = [{ id: 'remote-1', name: 'Box', enabled: true }];
		h.sessions = [
			{ id: 'local', cwd: '/Users/me/project' },
			{
				id: 'ssh',
				cwd: '/home/me/project',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			},
			{
				id: 'ssh-override',
				cwd: '/home/me/project',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/srv/vault',
				},
			},
			{
				id: 'ssh-off',
				cwd: '/Users/me/other',
				sessionSshRemoteConfig: { enabled: false, remoteId: 'remote-1' },
			},
			{
				id: 'ssh-missing',
				cwd: '/home/me/project',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'gone' },
			},
		];
	});

	it('roots a local agent at its cwd with no remote, SSH turned off included', () => {
		expect(resolveDataviewAgentContext('local')).toEqual({
			agentCwd: '/Users/me/project',
			sshRemoteId: null,
		});
		expect(resolveDataviewAgentContext('ssh-off')).toEqual({
			agentCwd: '/Users/me/other',
			sshRemoteId: null,
		});
	});

	it('roots an SSH agent at its working-directory override, else its cwd, on its remote', () => {
		expect(resolveDataviewAgentContext('ssh')).toEqual({
			agentCwd: '/home/me/project',
			sshRemoteId: 'remote-1',
		});
		expect(resolveDataviewAgentContext('ssh-override')).toEqual({
			agentCwd: '/srv/vault',
			sshRemoteId: 'remote-1',
		});
	});

	it('fails loudly when SSH is on but the remote is missing or disabled', () => {
		expect(() => resolveDataviewAgentContext('ssh-missing')).toThrow(
			/configured remote "gone" could not be resolved/
		);
		h.sshRemotes = [{ id: 'remote-1', name: 'Box', enabled: false }];
		expect(() => resolveDataviewAgentContext('ssh')).toThrow(
			/configured remote "remote-1" could not be resolved/
		);
	});

	it('refuses an agent that is not live', () => {
		expect(() => resolveDataviewAgentContext('nobody')).toThrow(
			'Dataview: no agent with id "nobody"'
		);
	});
});
