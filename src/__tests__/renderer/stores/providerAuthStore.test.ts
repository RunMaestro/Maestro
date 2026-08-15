/**
 * providerAuthStore - identity resolution, snapshot lookup, and the blocked-agent
 * roll-up. Phase 03 task 5 extends this with the reactive-marking and toast cases.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	markSessionAuthFailure,
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
			providerAuth: { getAll, onChange: () => () => {}, mark: vi.fn() },
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

/**
 * The reactive path: a live `auth_expired` marks the credential, and WHICH mark
 * it writes depends on the credential's kind. An OAuth login can be repaired by
 * signing in; a rejected API key cannot, so it must not land in the bucket the
 * login button reads from.
 */
describe('markSessionAuthFailure', () => {
	const mark = vi.fn().mockResolvedValue(null);

	function installBridge(): void {
		(window as unknown as { maestro: unknown }).maestro = {
			providerAuth: { getAll: vi.fn().mockResolvedValue({}), onChange: () => () => {}, mark },
			agents: { getCustomEnvVars: vi.fn().mockResolvedValue({}) },
			fs: { homeDir: vi.fn().mockResolvedValue('/Users/x') },
		};
	}

	beforeEach(() => {
		useProviderAuthStore.getState().__resetForTests();
		useSessionStore.setState({ sessions: [] });
		mark.mockClear();
		installBridge();
	});

	it('marks an oauth credential logged out, with the identity attached', async () => {
		useSessionStore.setState({ sessions: [makeSession('a')] });

		await markSessionAuthFailure('a', 'Invalid API key - please run /login');

		expect(mark).toHaveBeenCalledTimes(1);
		const [key, request] = mark.mock.calls[0];
		expect(key).toBe('claude-code::oauth::/Users/x/.claude::local');
		expect(request).toMatchObject({
			status: 'logged-out',
			source: 'error-pattern',
			detail: 'Invalid API key - please run /login',
		});
		// The identity rides along so a credential that was never probed still
		// gets a record instead of a silent no-op in main.
		expect(request.identity.key).toBe(key);
	});

	it('marks an api-key credential unsupported, not logged out', async () => {
		useSessionStore.setState({
			sessions: [makeSession('a', { ANTHROPIC_API_KEY: 'sk-ant-secret-value' })],
		});

		await markSessionAuthFailure('a', 'authentication_error');

		const [key, request] = mark.mock.calls[0];
		expect(request.status).toBe('unsupported');
		expect(request.detail).toContain('ANTHROPIC_API_KEY');
		// The raw secret never leaves the identity resolver.
		expect(key).not.toContain('sk-ant-secret-value');
		expect(JSON.stringify(request)).not.toContain('sk-ant-secret-value');
	});

	it('does nothing for a session that resolves to no identity', async () => {
		const result = await markSessionAuthFailure('missing-session', 'expired');
		expect(result).toBeNull();
		expect(mark).not.toHaveBeenCalled();
	});
});
