import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
	getClaudeUsageSnapshotForSession,
	useClaudeUsageStore,
	useResolvedClaudeConfigDirKey,
	type ClaudeUsageSnapshot,
} from '../../../renderer/stores/claudeUsageStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import { projectTabProvider } from '../../../renderer/utils/providerTabSessions';

vi.mock('../../../renderer/utils/homeDir', () => ({
	getHomeDir: () => '/home/tester',
	getHomeDirAsync: () => Promise.resolve('/home/tester'),
}));

const snapshot: ClaudeUsageSnapshot = {
	sampledAt: '2026-10-17T00:00:00Z',
	configDirKey: '/accounts/claude',
	session: { percent: 25 },
	weekAllModels: { percent: 25 },
	weekSonnetOnly: { percent: 25 },
};

beforeEach(() => {
	useClaudeUsageStore.getState().__resetForTests();
	window.maestro.agents.getCustomEnvVars = vi.fn().mockResolvedValue({});
});

describe('Claude usage account ownership', () => {
	it('waits for provider account configuration before using an implicit default snapshot', () => {
		window.maestro.agents.getCustomEnvVars = vi
			.fn()
			.mockResolvedValue({ CLAUDE_CONFIG_DIR: '/accounts/provider' });
		useClaudeUsageStore.getState().setSnapshots({ '/home/tester/.claude': snapshot });
		expect(getClaudeUsageSnapshotForSession(createMockSession())).toBeNull();
	});

	it('reads the failed Claude tab account while the agent and selection use Codex', () => {
		const session = createMockSession({
			toolType: 'codex',
			agentErrorTabId: 'failed',
			aiTabs: [
				createMockAITab({ id: 'failed', tabProvider: 'codex', turnProvider: 'claude-code' }),
			],
			providerOverrides: {
				'claude-code': { customEnvVars: { CLAUDE_CONFIG_DIR: '/accounts/claude' } },
			},
			claudeInteractive: {
				mode: 'interactive',
				modeReason: 'auto',
				lastUsageSnapshotKey: '/accounts/stale',
			},
		});
		useClaudeUsageStore.getState().setSnapshots({ '/accounts/claude': snapshot });
		expect(getClaudeUsageSnapshotForSession(session)).toBe(snapshot);
	});

	it('does not use Claude quota for a failed Codex tab on a Claude agent', () => {
		useClaudeUsageStore.getState().setSnapshots({ '/accounts/claude': snapshot });
		const session = createMockSession({
			agentErrorTabId: 'failed',
			aiTabs: [createMockAITab({ id: 'failed', turnProvider: 'codex' })],
			customEnvVars: { CLAUDE_CONFIG_DIR: '/accounts/claude' },
		});
		expect(getClaudeUsageSnapshotForSession(session)).toBeNull();
	});

	it('refuses a different account with the same basename or the only snapshot', () => {
		useClaudeUsageStore.getState().setSnapshots({ '/accounts/claude': snapshot });
		expect(
			getClaudeUsageSnapshotForSession(
				createMockSession({
					customEnvVars: { CLAUDE_CONFIG_DIR: '/other/claude' },
				})
			)
		).toBeNull();
	});

	it('does not borrow a snapshot for a missing target or a remote account', () => {
		useClaudeUsageStore.getState().setSnapshots({ '/accounts/claude': snapshot });
		const session = createMockSession({ customEnvVars: { CLAUDE_CONFIG_DIR: '/accounts/claude' } });
		expect(getClaudeUsageSnapshotForSession(session, 'gone')).toBeNull();
		expect(getClaudeUsageSnapshotForSession({ ...session, sshRemoteId: 'remote' })).toBeNull();
	});

	it('does not use plan quota for API credentials', () => {
		useClaudeUsageStore.getState().setSnapshots({ '/accounts/claude': snapshot });
		expect(
			getClaudeUsageSnapshotForSession(
				createMockSession({
					customEnvVars: { CLAUDE_CONFIG_DIR: '/accounts/claude', ANTHROPIC_API_KEY: 'test-key' },
				})
			)
		).toBeNull();
	});

	it('resolves the selected Claude tab account without a stale default-provider stamp', () => {
		const session = createMockSession({
			toolType: 'codex',
			activeTabId: 'selected',
			aiTabs: [createMockAITab({ id: 'selected', tabProvider: 'claude-code' })],
			providerOverrides: {
				'claude-code': { customEnvVars: { CLAUDE_CONFIG_DIR: '/accounts/claude' } },
			},
			claudeInteractive: {
				mode: 'interactive',
				modeReason: 'auto',
				lastUsageSnapshotKey: '/accounts/stale',
			},
		});
		const projected = projectTabProvider(session, session.aiTabs[0]).agent;
		const { result } = renderHook(() => useResolvedClaudeConfigDirKey(projected));
		expect(result.current).toBe('/accounts/claude');
	});
});
