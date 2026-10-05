/**
 * Stored records to assembly inputs: a field of the wrong type reads as absent.
 */
import { describe, it, expect } from 'vitest';
import { toTurnAgent, toTurnTab } from '../../../../shared/maestro-lib/turns/records';
import type { AgentRecord, AITabRecord } from '../../../../shared/maestro-lib/store/records';

const agent = (extra: Record<string, unknown> = {}): AgentRecord => ({
	id: 'a-1',
	name: 'Alpha',
	toolType: 'claude-code',
	cwd: '/w',
	...extra,
});

describe('toTurnAgent', () => {
	it('carries the named fields', () => {
		const turn = toTurnAgent(
			agent({
				projectRoot: '/w',
				groupId: 'g',
				nudgeMessage: 'nudge',
				newSessionMessage: 'new',
				customPath: '/bin/claude',
				customArgs: '--x',
				customEnvVars: { A: '1' },
				customModel: 'opus',
				customEffort: 'high',
				customContextWindow: 1000,
				isGitRepo: true,
				isPianola: true,
				additionalDirectories: [{ path: '/extra', read: true, write: false, description: 'd' }],
				worktreeConfig: { basePath: '/wt' },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
				agentCommands: [{ command: '/x', description: 'X', prompt: 'P' }, { command: '/y' }],
			})
		);
		expect(turn).toMatchObject({
			id: 'a-1',
			cwd: '/w',
			projectRoot: '/w',
			groupId: 'g',
			nudgeMessage: 'nudge',
			newSessionMessage: 'new',
			customPath: '/bin/claude',
			customArgs: '--x',
			customEnvVars: { A: '1' },
			customModel: 'opus',
			customEffort: 'high',
			customContextWindow: 1000,
			isGitRepo: true,
			isPianola: true,
			additionalDirectories: [{ path: '/extra', read: true, write: false, description: 'd' }],
			worktreeConfig: { basePath: '/wt' },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			agentCommands: [{ command: '/x', description: 'X', prompt: 'P' }, { command: '/y' }],
		});
	});

	it('has no turn for an agent with no working directory', () => {
		expect(toTurnAgent(agent({ cwd: '' }))).toBeUndefined();
		expect(toTurnAgent({ id: 'a', name: 'A', toolType: 'codex' })).toBeUndefined();
	});

	it('reads a field of the wrong type as absent', () => {
		const turn = toTurnAgent(
			agent({
				nudgeMessage: 5,
				customArgs: ['x'],
				customEnvVars: { A: 1, B: 'ok' },
				customContextWindow: 'big',
				isGitRepo: 'yes',
				additionalDirectories: 'nope',
				sessionSshRemoteConfig: 'on',
			})
		);
		expect(turn).toMatchObject({ customEnvVars: { B: 'ok' } });
		expect(turn?.nudgeMessage).toBeUndefined();
		expect(turn?.customArgs).toBeUndefined();
		expect(turn?.customContextWindow).toBeUndefined();
		expect(turn?.isGitRepo).toBeUndefined();
		expect(turn?.additionalDirectories).toBeUndefined();
		expect(turn?.sessionSshRemoteConfig).toBeUndefined();
	});

	it('reads SSH as off unless it is literally on', () => {
		expect(
			toTurnAgent(agent({ sessionSshRemoteConfig: { enabled: 'true' } }))?.sessionSshRemoteConfig
		).toMatchObject({ enabled: false, remoteId: null });
	});
});

describe('toTurnTab', () => {
	const tab = (extra: Record<string, unknown> = {}): AITabRecord => ({ id: 't-1', ...extra });

	it('carries the named fields', () => {
		expect(
			toTurnTab(
				tab({
					agentSessionId: 'sess',
					customModel: 'm',
					customEffort: 'e',
					readOnlyMode: true,
					permissionMode: 'standard',
					pendingMergedContext: 'ctx',
				})
			)
		).toEqual({
			id: 't-1',
			agentSessionId: 'sess',
			customModel: 'm',
			customEffort: 'e',
			readOnlyMode: true,
			permissionMode: 'standard',
			pendingMergedContext: 'ctx',
		});
	});

	it('reads a missing or empty session id as none', () => {
		expect(toTurnTab(tab()).agentSessionId).toBeNull();
		expect(toTurnTab(tab({ agentSessionId: '' })).agentSessionId).toBeNull();
	});

	it('drops a permission mode this build does not know', () => {
		expect(toTurnTab(tab({ permissionMode: 'yolo' })).permissionMode).toBeUndefined();
	});
});
