/**
 * providerAuthStore - identity resolution, snapshot lookup, and the blocked-agent
 * roll-up. Phase 03 task 5 extends this with the reactive-marking and toast cases.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	selectAuthSnapshotForSession,
	selectLoggedOutIdentities,
	useProviderAuthStore,
} from '../../../renderer/stores/providerAuthStore';
import type { Session } from '../../../renderer/types';

const makeSession = (id: string, env?: Record<string, string>): Session =>
	({
		id,
		name: id,
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/tmp',
		projectRoot: '/tmp',
		aiTabs: [],
		filePreviewTabs: [],
		unifiedTabOrder: [],
		inputMode: 'ai',
		customEnvVars: env,
	}) as unknown as Session;

describe('providerAuthStore smoke', () => {
	beforeEach(() => {
		useProviderAuthStore.getState().__resetForTests();
		useSessionStore.setState({ sessions: [] });
	});

	it('resolves sessions onto one shared identity', async () => {
		const getAll = vi.fn().mockResolvedValue({});
		(window as unknown as { maestro: unknown }).maestro = {
			providerAuth: { getAll, onChange: () => () => {}, markLoggedOut: vi.fn() },
			agents: { getCustomEnvVars: vi.fn().mockResolvedValue({}) },
			fs: { homeDir: vi.fn().mockResolvedValue('/Users/x') },
		};

		useSessionStore.setState({
			sessions: [makeSession('a'), makeSession('b'), makeSession('c', { CLAUDE_CONFIG_DIR: '/o' })],
		});
		await useProviderAuthStore.getState().hydrate();
		expect(useProviderAuthStore.getState().homeDir).toBe('/Users/x');

		const snapshot = {
			identity: {
				key: 'claude-code::oauth::/Users/x/.claude::local',
				provider: 'claude-code',
				kind: 'oauth' as const,
				scope: '/Users/x/.claude',
				host: 'local',
				label: '.claude',
			},
			status: 'logged-out' as const,
			checkedAt: 1,
			source: 'probe' as const,
		};
		useProviderAuthStore.getState().applyChange(snapshot.identity.key, snapshot);

		expect(selectAuthSnapshotForSession('a')(useProviderAuthStore.getState())).toEqual(snapshot);
		expect(selectAuthSnapshotForSession('c')(useProviderAuthStore.getState())).toBeNull();

		const blocked = selectLoggedOutIdentities()(useProviderAuthStore.getState());
		expect(blocked).toHaveLength(1);
		expect(blocked[0].sessionIds).toEqual(['a', 'b']);
		// Reference-stable across an unrelated session-object churn.
		useSessionStore.setState({ sessions: [...useSessionStore.getState().sessions] });
		expect(selectLoggedOutIdentities()(useProviderAuthStore.getState())).toBe(blocked);
	});
});
