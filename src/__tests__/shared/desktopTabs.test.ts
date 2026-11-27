import { describe, expect, it } from 'vitest';
import { inspectTabProvider } from '../../shared/desktopTabs';
import { createMockSession } from '../helpers/mockSession';
import { createMockAITab } from '../helpers/mockTab';

describe('tab provider inspection', () => {
	it('separates selection, explicit pin, agent default and captured turn without exposing secrets', () => {
		const tab = createMockAITab({
			tabProvider: 'codex',
			turnProvider: 'claude-code',
			pendingTranslation: 'claude-code',
			customModel: 'auto',
			runOn: { type: 'provider' },
			providerSessions: { 'claude-code': { agentSessionId: 'private-native-id' } },
		});
		const agent = createMockSession({
			toolType: 'claude-code',
			customEffort: 'high',
			customEnvVars: { API_KEY: 'private-secret' },
			providerOverrides: { codex: { customEffort: 'medium' } },
		});
		expect(inspectTabProvider(tab, agent)).toEqual({
			provider: 'codex',
			agentProvider: 'claude-code',
			tabProvider: 'codex',
			turnProvider: 'claude-code',
			pendingTranslation: 'claude-code',
			effectiveModel: 'auto',
			effectiveEffort: 'medium',
			runOn: { type: 'provider' },
		});
	});
	it('reports inheritance and unknown legacy turn ownership explicitly', () => {
		expect(
			inspectTabProvider(createMockAITab(), createMockSession({ toolType: 'codex' }))
		).toMatchObject({
			provider: 'codex',
			agentProvider: 'codex',
			tabProvider: null,
			turnProvider: null,
		});
	});
});
