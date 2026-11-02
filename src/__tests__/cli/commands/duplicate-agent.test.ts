/**
 * @file duplicate-agent.test.ts
 * @description `maestro-cli duplicate-agent`: the Left Bar's Duplicate... from the
 * CLI. The copy is built by the shared carry-over rules and sent through the same
 * `create_session` message `create-agent` uses.
 */

import * as path from 'path';
import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

const { sessions } = vi.hoisted(() => ({
	sessions: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../cli/services/storage')>();
	return {
		...actual,
		readSessions: () => sessions,
		readLiveSessions: () => sessions,
		resolveAgentId: (ref: string) => {
			const match = sessions.find((s) => s.id === ref || s.name === ref);
			if (!match) throw new Error(`Agent not found: ${ref}`);
			return match.id as string;
		},
		getSessionById: (id: string) => sessions.find((s) => s.id === id),
		resolveGroupId: (ref: string) => {
			if (ref.startsWith('grp')) return 'group-2';
			throw new Error(`Group not found: ${ref}`);
		},
	};
});

import { duplicateAgent } from '../../../cli/commands/duplicate-agent';
import { withMaestroClient } from '../../../cli/services/maestro-client';

const source = {
	id: 'agent-1',
	name: 'Alpha',
	toolType: 'claude-code',
	cwd: '/work/proj',
	projectRoot: '/work/proj',
	groupId: 'group-1',
	nudgeMessage: 'Be terse',
	customModel: 'opus',
	customEffort: 'high',
	customEnvVars: { DEBUG: '1' },
	enableMaestroP: false,
	retryOnTokenExhaustion: false,
	codexTransport: 'app-server',
	additionalDirectories: [{ path: '/shared/docs', read: true, write: false }],
};

describe('duplicate-agent command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let sent: Record<string, unknown> | undefined;

	function bridgeReplies(reply: Record<string, unknown>) {
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({
				sendCommand: vi.fn().mockImplementation((payload) => {
					sent = payload;
					return Promise.resolve({ type: 'create_session_result', ...reply });
				}),
			} as never)
		);
	}

	function jsonOutput(): Record<string, unknown> {
		return JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
	}

	beforeEach(() => {
		vi.clearAllMocks();
		sent = undefined;
		sessions.length = 0;
		sessions.push({ ...source });
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`exit ${code}`);
		});
		bridgeReplies({ success: true, sessionId: 'new-1' });
	});

	it('creates "<name> (Copy)" through create_session with the carried settings', async () => {
		await duplicateAgent('agent-1', {});

		expect(sent).toMatchObject({
			type: 'create_session',
			name: 'Alpha (Copy)',
			toolType: 'claude-code',
			cwd: '/work/proj',
			groupId: 'group-1',
			seedFromGroup: false,
			background: false,
			nudgeMessage: 'Be terse',
			customModel: 'opus',
			customEffort: 'high',
			customEnvVars: { DEBUG: '1' },
			enableMaestroP: false,
			retryOnAvailabilityErrors: true,
			retryOnTokenExhaustion: false,
			codexAutoResetOnExhaustion: false,
			codexTransport: 'app-server',
			sessionSshRemoteConfig: { enabled: false, remoteId: null },
			additionalDirectories: [{ path: '/shared/docs', read: true, write: false }],
		});
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('new-1'));
		// A copy shares its source's directory, which the modal also warns about.
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('already used by "Alpha"'));
	});

	it('takes --name', async () => {
		await duplicateAgent('agent-1', { name: 'Beta' });
		expect(sent?.name).toBe('Beta');
	});

	it('refuses a name already in use, as the modal does', async () => {
		sessions.push({ ...source, id: 'agent-2', name: 'Alpha (Copy)', cwd: '/elsewhere' });
		await expect(duplicateAgent('agent-1', { json: true })).rejects.toThrow('exit 1');
		expect(sent).toBeUndefined();
		expect(jsonOutput()).toMatchObject({
			success: false,
			error: expect.stringContaining('Pass --name'),
		});
	});

	it('resolves --group to a group id', async () => {
		await duplicateAgent('agent-1', { group: 'grp' });
		expect(sent?.groupId).toBe('group-2');
	});

	it('fails on an unknown --group', async () => {
		await expect(duplicateAgent('agent-1', { group: 'nope' })).rejects.toThrow('exit 1');
		expect(sent).toBeUndefined();
	});

	it('resolves a local --cwd against the shell directory', async () => {
		await duplicateAgent('agent-1', { cwd: 'sub/dir' });
		expect(sent?.cwd).toBe(path.resolve(process.cwd(), 'sub/dir'));
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it('takes an SSH agent --cwd verbatim and makes it the copy override', async () => {
		sessions[0] = {
			...source,
			cwd: '/local/placeholder',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/srv/app',
			},
		};
		await duplicateAgent('agent-1', { cwd: '~/other' });
		expect(sent).toMatchObject({
			cwd: '~/other',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '~/other',
			},
		});
	});

	it('fails on an unknown source agent without contacting the app', async () => {
		await expect(duplicateAgent('missing', { json: true })).rejects.toThrow('exit 1');
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(jsonOutput()).toMatchObject({ success: false, error: 'Agent not found: missing' });
	});

	it('refuses the Pianola manager like the Left Bar does', async () => {
		sessions[0] = { ...source, isPianola: true };
		await expect(duplicateAgent('agent-1', { json: true })).rejects.toThrow('exit 1');
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(jsonOutput().error).toMatch(/Pianola/);
	});

	it('duplicates a worktree child as a standalone agent', async () => {
		sessions[0] = { ...source, parentSessionId: 'parent', worktreeBranch: 'feat/x' };
		await duplicateAgent('agent-1', {});
		expect(sent).not.toHaveProperty('parentSessionId');
		expect(sent).not.toHaveProperty('worktreeBranch');
	});

	it('reports the copy as JSON, including the shared-directory warning', async () => {
		await duplicateAgent('agent-1', { json: true, background: true });
		expect(sent?.background).toBe(true);
		expect(jsonOutput()).toEqual({
			success: true,
			agentId: 'new-1',
			sourceAgentId: 'agent-1',
			name: 'Alpha (Copy)',
			type: 'claude-code',
			cwd: '/work/proj',
			groupId: 'group-1',
			background: true,
			warning: expect.stringContaining('already used by "Alpha"'),
		});
	});

	it('reports a refused create', async () => {
		bridgeReplies({ success: false, error: 'boom' });
		await expect(duplicateAgent('agent-1', { json: true })).rejects.toThrow('exit 1');
		expect(jsonOutput()).toEqual({ success: false, error: 'boom' });
	});
});
