import { beforeEach, describe, expect, it } from 'vitest';
import { agentCommandScope, getAgentCommands } from '../../../renderer/utils/agentCommands';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

describe('provider command scopes', () => {
	beforeEach(() => useSettingsStore.setState({ shellEnvVars: {} }));
	it('requires provenance for legacy lists and hides another provider or account', () => {
		const session = createMockSession({
			customEnvVars: { CLAUDE_CONFIG_DIR: '/accounts/a' },
			agentCommands: [{ command: '/ship', description: 'Ship' }],
		});
		expect(getAgentCommands(session)).toBeUndefined();
		session.agentCommandsScope = agentCommandScope(session);
		expect(getAgentCommands(session)).toBe(session.agentCommands);
		expect(getAgentCommands(session, createMockAITab({ tabProvider: 'codex' }))).toBeUndefined();
		expect(
			getAgentCommands({ ...session, customEnvVars: { CLAUDE_CONFIG_DIR: '/accounts/b' } })
		).toBeUndefined();
	});
	it('separates remote hosts, directories and binaries and excludes secrets from persisted scope', () => {
		const session = createMockSession({
			customEnvVars: { CLAUDE_CONFIG_DIR: '/accounts/a', API_KEY: 'secret-test-value' },
		});
		const scope = agentCommandScope(session);
		expect(scope).not.toContain('secret-test-value');
		for (const change of [
			{ cwd: '/elsewhere' },
			{ customPath: '/another/claude' },
			{ sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-a' } },
		]) {
			expect(agentCommandScope({ ...session, ...change })).not.toBe(scope);
		}
	});
	it('resolves the selected harness account from parked overrides and global env', () => {
		useSettingsStore.setState({ shellEnvVars: { CODEX_HOME: '/global/codex' } });
		const session = createMockSession({
			providerOverrides: { codex: { customEnvVars: { CODEX_HOME: '/work/codex' } } },
		});
		const tab = createMockAITab({ tabProvider: 'codex' });
		expect(JSON.parse(agentCommandScope(session, tab))).toMatchObject({
			provider: 'codex',
			account: '/work/codex',
		});
		expect(JSON.parse(agentCommandScope({ ...session, providerOverrides: {} }, tab)).account).toBe(
			'/global/codex'
		);
	});
});
