import { describe, it, expect } from 'vitest';
import { resolveSessionProjectPath } from '../../../../../renderer/components/AgentSessionsBrowser/utils/sessionProjectPath';
import type { Session } from '../../../../../renderer/types';

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'sess-1',
		name: 'Test',
		toolType: 'claude-code',
		projectRoot: '/local/project',
		status: 'idle',
		tabs: [],
		groups: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	} as Session;
}

describe('resolveSessionProjectPath', () => {
	it('uses projectRoot for local sessions', () => {
		const result = resolveSessionProjectPath(makeSession({ projectRoot: '/my/project' }));
		expect(result.projectPathForSessions).toBe('/my/project');
	});

	it('uses remoteCwd for SSH sessions with remoteCwd', () => {
		const result = resolveSessionProjectPath(
			makeSession({
				sshRemoteId: 'remote-1',
				remoteCwd: '/remote/cwd',
			})
		);
		expect(result.projectPathForSessions).toBe('/remote/cwd');
	});

	it('uses workingDirOverride when remoteCwd is not set', () => {
		const result = resolveSessionProjectPath(
			makeSession({
				sshRemoteId: 'remote-1',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/override',
				},
			})
		);
		expect(result.projectPathForSessions).toBe('/override');
	});

	it('prefers remoteCwd over workingDirOverride', () => {
		const result = resolveSessionProjectPath(
			makeSession({
				sshRemoteId: 'remote-1',
				remoteCwd: '/remote/cwd',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/override',
				},
			})
		);
		expect(result.projectPathForSessions).toBe('/remote/cwd');
	});

	it('falls back to projectRoot for SSH when neither remoteCwd nor override', () => {
		const result = resolveSessionProjectPath(
			makeSession({
				sshRemoteId: 'remote-1',
				projectRoot: '/local/fallback',
			})
		);
		expect(result.projectPathForSessions).toBe('/local/fallback');
	});

	it('derives sshRemoteId from session.sshRemoteId', () => {
		const result = resolveSessionProjectPath(makeSession({ sshRemoteId: 'my-remote' }));
		expect(result.sshRemoteId).toBe('my-remote');
	});

	it('falls back to sessionSshRemoteConfig.remoteId', () => {
		const result = resolveSessionProjectPath(
			makeSession({
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'config-remote',
					workingDirOverride: undefined,
				},
			})
		);
		expect(result.sshRemoteId).toBe('config-remote');
	});

	it('returns undefined sshRemoteId when neither source is set', () => {
		const result = resolveSessionProjectPath(makeSession());
		expect(result.sshRemoteId).toBeUndefined();
	});

	it('sets isRemoteSession true when sshRemoteId is truthy', () => {
		const result = resolveSessionProjectPath(makeSession({ sshRemoteId: 'r1' }));
		expect(result.isRemoteSession).toBe(true);
	});

	it('sets isRemoteSession false when sshRemoteId is undefined', () => {
		const result = resolveSessionProjectPath(makeSession());
		expect(result.isRemoteSession).toBe(false);
	});

	it('handles undefined activeSession gracefully', () => {
		const result = resolveSessionProjectPath(undefined);
		expect(result.projectPathForSessions).toBeUndefined();
		expect(result.sshRemoteId).toBeUndefined();
		expect(result.isRemoteSession).toBe(false);
	});
});
