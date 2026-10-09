/**
 * Tests for agentAccountSwitch - the renderer half of moving an agent onto
 * another provider account.
 *
 * Covers what the store write depends on: refusing an agent whose credential a
 * switch cannot change, refusing mid-turn but not while a retry is merely
 * scheduled, carrying each open conversation BEFORE the env changes, and the
 * env/stamp the agent ends up with.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	loadAgentAccountContext,
	switchAgentAccount,
} from '../../../renderer/services/agentAccountSwitch';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useRetryStore, type RetryEntry } from '../../../renderer/stores/retryStore';
import { createMockAITab, createMockSession } from '../../helpers';
import type { Session } from '../../../renderer/types';

const HOME = '/home/testuser';

function seed(overrides: Partial<Session> = {}): Session {
	const session = createMockSession({
		id: 's1',
		name: 'Builder',
		cwd: '/work/project',
		aiTabs: [
			createMockAITab({ id: 't1', agentSessionId: 'conv-1' }),
			createMockAITab({ id: 't2', agentSessionId: 'conv-1' }),
			createMockAITab({ id: 't3', agentSessionId: null }),
		],
		customEnvVars: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-a`, KEEP: '1' },
		claudeInteractive: { mode: 'api', modeReason: 'limit', lastUsageSnapshotKey: 'old' },
		...overrides,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	return session;
}

function current(): Session {
	return useSessionStore.getState().sessions[0];
}

beforeEach(() => {
	vi.mocked(window.maestro.agents.getCustomEnvVars).mockResolvedValue(null);
	vi.mocked(window.maestro.agents.carryProviderSession).mockReset().mockResolvedValue('copied');
	vi.mocked(window.maestro.agents.getProviderAccounts).mockReset().mockResolvedValue([]);
	useSettingsStore.setState({ shellEnvVars: {} });
	useRetryStore.setState({ retries: {}, outages: {} });
});

describe('switchAgentAccount', () => {
	it('carries each distinct conversation, then points the agent at the new dir', async () => {
		seed();
		const result = await switchAgentAccount('s1', `${HOME}/.claude-b/`);

		expect(result).toEqual({ ok: true, missingConversations: 0 });
		expect(window.maestro.agents.carryProviderSession).toHaveBeenCalledTimes(1);
		expect(window.maestro.agents.carryProviderSession).toHaveBeenCalledWith({
			toolType: 'claude-code',
			fromAccountKey: `${HOME}/.claude-a`,
			toAccountKey: `${HOME}/.claude-b`,
			sessionId: 'conv-1',
			cwd: '/work/project',
		});
		expect(current().customEnvVars).toEqual({ CLAUDE_CONFIG_DIR: `${HOME}/.claude-b`, KEEP: '1' });
		// The stamp and the sticky limit both described the account being left.
		expect(current().claudeInteractive).toEqual({
			mode: 'api',
			modeReason: 'auto',
			lastUsageSnapshotKey: undefined,
		});
	});

	it('counts conversations whose transcript could not be found', async () => {
		seed();
		vi.mocked(window.maestro.agents.carryProviderSession).mockResolvedValue('missing');
		const result = await switchAgentAccount('s1', `${HOME}/.claude-b`);
		expect(result).toEqual({ ok: true, missingConversations: 1 });
	});

	it('leaves the agent untouched when a carry fails', async () => {
		seed();
		vi.mocked(window.maestro.agents.carryProviderSession).mockRejectedValue(new Error('EACCES'));
		await expect(switchAgentAccount('s1', `${HOME}/.claude-b`)).rejects.toThrow('EACCES');
		expect(current().customEnvVars?.CLAUDE_CONFIG_DIR).toBe(`${HOME}/.claude-a`);
	});

	it('drops a parked copy of the config-dir var once a live one is written', async () => {
		seed({ customEnvVarsDisabled: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-z`, OTHER: 'x' } });
		await switchAgentAccount('s1', `${HOME}/.claude-b`);
		expect(current().customEnvVarsDisabled).toEqual({ OTHER: 'x' });
	});

	it('is a no-op when the agent is already on that account', async () => {
		seed();
		const result = await switchAgentAccount('s1', `${HOME}/.claude-a`);
		expect(result).toEqual({ ok: true, unchanged: true, missingConversations: 0 });
		expect(window.maestro.agents.carryProviderSession).not.toHaveBeenCalled();
	});

	it('refuses an agent that bills an API key', async () => {
		seed({ customEnvVars: { ANTHROPIC_API_KEY: 'sk-1' } });
		const result = await switchAgentAccount('s1', `${HOME}/.claude-b`);
		expect(result.ok).toBe(false);
		expect(current().customEnvVars).toEqual({ ANTHROPIC_API_KEY: 'sk-1' });
	});

	it('refuses mid-turn, but not while a retry is only scheduled', async () => {
		const busyTab = createMockAITab({ id: 't1', agentSessionId: 'conv-1', state: 'busy' });
		seed({ aiTabs: [busyTab] });
		const refused = await switchAgentAccount('s1', `${HOME}/.claude-b`);
		expect(refused).toEqual({ ok: false, error: expect.stringMatching(/middle of a turn/) });

		useRetryStore.setState({
			retries: { 's1:t1': { status: 'scheduled' } as unknown as RetryEntry },
		});
		const allowed = await switchAgentAccount('s1', `${HOME}/.claude-b`);
		expect(allowed.ok).toBe(true);
	});
});

describe('loadAgentAccountContext', () => {
	it('reports the current account and the identities main found', async () => {
		const session = seed();
		const identities = [{ accountKey: `${HOME}/.claude-b`, email: 'b@x.com', signedIn: true }];
		vi.mocked(window.maestro.agents.getProviderAccounts).mockResolvedValue(identities);

		await expect(loadAgentAccountContext(session)).resolves.toEqual({
			blocker: null,
			currentAccountKey: `${HOME}/.claude-a`,
			identities,
		});
	});

	it('returns the blocker without listing accounts for an SSH agent', async () => {
		const session = seed({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'r1', workingDirOverride: undefined },
		});
		const context = await loadAgentAccountContext(session);
		expect(context.blocker).toMatch(/SSH/);
		expect(window.maestro.agents.getProviderAccounts).not.toHaveBeenCalled();
	});
});
