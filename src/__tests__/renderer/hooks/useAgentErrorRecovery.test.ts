import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentErrorRecovery } from '../../../renderer/hooks';
import type { AgentError } from '../../../shared/types';
import type { CredentialIdentity } from '../../../shared/providerAuth';

const baseError: AgentError = {
	type: 'auth_expired',
	message: 'Authentication required',
	recoverable: true,
	agentId: 'claude-code',
	timestamp: 1700000000000,
};

const oauthIdentity: CredentialIdentity = {
	key: 'claude-code::oauth::.claude::local',
	provider: 'claude-code',
	kind: 'oauth',
	scope: '.claude',
	host: 'local',
	configDir: '/Users/test/.claude',
	label: '.claude',
};

const apiKeyIdentity: CredentialIdentity = {
	key: 'claude-code::api-key::fp_1a2b3c4d::local',
	provider: 'claude-code',
	kind: 'api-key',
	scope: 'fp_1a2b3c4d',
	host: 'local',
	envVarName: 'ANTHROPIC_AUTH_TOKEN',
	label: 'Claude Code fp_1a2b3c4d',
};

describe('useAgentErrorRecovery', () => {
	it('offers the in-app login for an oauth credential, named after the account', () => {
		const onAuthenticate = vi.fn();
		const onConfigureCredentials = vi.fn();
		const onNewSession = vi.fn();

		const { result } = renderHook(() =>
			useAgentErrorRecovery({
				error: baseError,
				agentId: 'claude-code',
				sessionId: 's1',
				identity: oauthIdentity,
				accountLabel: 'pedram@example.com',
				onAuthenticate,
				onConfigureCredentials,
				onNewSession,
			})
		);

		const [authAction, newSessionAction] = result.current.recoveryActions;

		expect(authAction.id).toBe('authenticate');
		expect(authAction.label).toBe('Sign in to Claude Code (pedram@example.com)');
		expect(authAction.label).not.toContain('Terminal');
		expect(authAction.description).not.toContain('claude login');
		expect(authAction.primary).toBe(true);
		expect(newSessionAction.id).toBe('new-session');

		act(() => {
			authAction.onClick();
			newSessionAction.onClick();
		});

		expect(onAuthenticate).toHaveBeenCalledTimes(1);
		expect(onConfigureCredentials).not.toHaveBeenCalled();
		expect(onNewSession).toHaveBeenCalledTimes(1);
	});

	it('falls back to the identity label when no account name was probed', () => {
		const { result } = renderHook(() =>
			useAgentErrorRecovery({
				error: baseError,
				agentId: 'claude-code',
				sessionId: 's1',
				identity: oauthIdentity,
				onAuthenticate: vi.fn(),
			})
		);

		expect(result.current.recoveryActions[0].label).toBe('Sign in to Claude Code (.claude)');
	});

	it('offers credential configuration, not a login, for a non-oauth credential', () => {
		const onAuthenticate = vi.fn();
		const onConfigureCredentials = vi.fn();

		const { result } = renderHook(() =>
			useAgentErrorRecovery({
				error: baseError,
				agentId: 'claude-code',
				sessionId: 's1',
				identity: apiKeyIdentity,
				onAuthenticate,
				onConfigureCredentials,
			})
		);

		const [action] = result.current.recoveryActions;

		expect(action.id).toBe('configure-credentials');
		expect(action.description).toContain('ANTHROPIC_AUTH_TOKEN');
		expect(action.primary).toBe(true);

		act(() => {
			action.onClick();
		});

		expect(onConfigureCredentials).toHaveBeenCalledTimes(1);
		expect(onAuthenticate).not.toHaveBeenCalled();
	});

	it('names the gateway host for a gateway credential', () => {
		const { result } = renderHook(() =>
			useAgentErrorRecovery({
				error: baseError,
				agentId: 'claude-code',
				sessionId: 's1',
				identity: {
					key: 'claude-code::gateway::api.z.ai::local',
					provider: 'claude-code',
					kind: 'gateway',
					scope: 'api.z.ai',
					host: 'local',
					envVarName: 'ANTHROPIC_BASE_URL',
					label: 'api.z.ai',
				},
				onAuthenticate: vi.fn(),
				onConfigureCredentials: vi.fn(),
			})
		);

		const [action] = result.current.recoveryActions;
		expect(action.id).toBe('configure-credentials');
		expect(action.description).toContain('ANTHROPIC_BASE_URL');
		expect(action.description).toContain('api.z.ai');
	});

	it('offers no login when the credential has not resolved yet', () => {
		const onAuthenticate = vi.fn();

		const { result } = renderHook(() =>
			useAgentErrorRecovery({
				error: baseError,
				agentId: 'claude-code',
				sessionId: 's1',
				identity: null,
				onAuthenticate,
				onNewSession: vi.fn(),
			})
		);

		expect(result.current.recoveryActions.map((a) => a.id)).toEqual(['new-session']);
		expect(onAuthenticate).not.toHaveBeenCalled();
	});

	it('offers restart + new session for agent crashes', () => {
		const onRestartAgent = vi.fn();
		const onNewSession = vi.fn();

		const { result } = renderHook(() =>
			useAgentErrorRecovery({
				error: { ...baseError, type: 'agent_crashed' },
				agentId: 'claude-code',
				sessionId: 's1',
				onRestartAgent,
				onNewSession,
			})
		);

		const [restartAction, newSessionAction] = result.current.recoveryActions;

		expect(restartAction.id).toBe('restart-agent');
		expect(restartAction.primary).toBe(true);
		expect(newSessionAction.id).toBe('new-session');

		act(() => {
			restartAction.onClick();
			newSessionAction.onClick();
		});

		expect(onRestartAgent).toHaveBeenCalledTimes(1);
		expect(onNewSession).toHaveBeenCalledTimes(1);
	});

	it('returns retry action for rate limits', () => {
		const onRetry = vi.fn();

		const { result } = renderHook(() =>
			useAgentErrorRecovery({
				error: { ...baseError, type: 'rate_limited' },
				agentId: 'claude-code',
				sessionId: 's1',
				onRetry,
			})
		);

		expect(result.current.recoveryActions).toHaveLength(1);
		expect(result.current.recoveryActions[0].id).toBe('retry');

		act(() => {
			result.current.recoveryActions[0].onClick();
		});

		expect(onRetry).toHaveBeenCalledTimes(1);
	});
});
