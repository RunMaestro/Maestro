import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentErrorRecovery } from '../../../renderer/hooks';
import type { AgentError } from '../../../shared/types';

const baseError: AgentError = {
	type: 'auth_expired',
	message: 'Authentication required',
	recoverable: true,
	agentId: 'claude-code',
	timestamp: 1700000000000,
};

describe('useAgentErrorRecovery', () => {
	it('creates claude-code auth actions naming the login command, plus new session', () => {
		const onAuthenticate = vi.fn();
		const onNewSession = vi.fn();

		const { result } = renderHook(() =>
			useAgentErrorRecovery({
				error: baseError,
				agentId: 'claude-code',
				sessionId: 's1',
				onAuthenticate,
				onNewSession,
			})
		);

		const [authAction, newSessionAction] = result.current.recoveryActions;

		expect(authAction.id).toBe('authenticate');
		expect(authAction.label).toBe('Re-authenticate');
		// The login runs inside Maestro now, so the description names the command
		// rather than telling the user to go find a terminal.
		expect(authAction.description).toBe('Run "claude /login" here');
		expect(authAction.primary).toBe(true);
		expect(newSessionAction.id).toBe('new-session');

		act(() => {
			authAction.onClick();
			newSessionAction.onClick();
		});

		expect(onAuthenticate).toHaveBeenCalledTimes(1);
		expect(onNewSession).toHaveBeenCalledTimes(1);
	});

	describe.each([
		{ host: 'local', sessionId: 'grok-local', sshRemoteId: undefined },
		{ host: 'SSH', sessionId: 'grok-remote', sshRemoteId: 'remote-grok-1' },
	])('Grok authentication recovery on $host', ({ sessionId, sshRemoteId }) => {
		// The hook receives an error, not the selected credential environment.
		// Even login-looking output cannot establish which credential is active.
		it.each([
			['API key', 'API key was rejected'],
			['gateway', 'Gateway authentication failed'],
			['inline credentials', 'Inline authentication failed'],
			['unknown context', 'Authentication required'],
			['login-looking output', 'Run grok login to restore access'],
		])('keeps %s failures conditional and preserves the supplied actions', (_, message) => {
			const onAuthenticate = vi.fn();
			const onNewSession = vi.fn();
			const error: AgentError = {
				...baseError,
				agentId: 'grok',
				message,
				sessionId,
				sshRemoteId,
				raw: { stderr: 'synthetic-credential-marker' },
			};
			const { result } = renderHook(() =>
				useAgentErrorRecovery({
					error,
					agentId: 'grok',
					sessionId,
					onAuthenticate,
					onNewSession,
				})
			);

			expect(result.current.recoveryActions).toHaveLength(2);
			const [authAction, newSessionAction] = result.current.recoveryActions;
			expect(authAction).toMatchObject({
				id: 'authenticate',
				label: 'Review Authentication',
				description:
					'Check the active credentials; sign in only if this account uses provider login',
				primary: true,
			});
			expect(authAction.onClick).toBe(onAuthenticate);
			expect(authAction.description).not.toContain('grok login');
			expect(authAction.description).not.toContain('synthetic-credential-marker');
			expect(newSessionAction.id).toBe('new-session');
			expect(newSessionAction.onClick).toBe(onNewSession);
			expect(onAuthenticate).not.toHaveBeenCalled();

			act(() => {
				result.current.handleRecovery('authenticate');
			});
			expect(onAuthenticate).toHaveBeenCalledExactlyOnceWith();
			expect(onNewSession).not.toHaveBeenCalled();
			expect(error).toMatchObject({ sessionId, sshRemoteId, message });
		});
	});

	it('uses the current Grok authentication callback after switching from local to SSH', () => {
		const localAuthenticate = vi.fn();
		const remoteAuthenticate = vi.fn();
		const { result, rerender } = renderHook(
			({ sessionId, onAuthenticate, sshRemoteId }) =>
				useAgentErrorRecovery({
					error: { ...baseError, agentId: 'grok', sessionId, sshRemoteId },
					agentId: 'grok',
					sessionId,
					onAuthenticate,
				}),
			{
				initialProps: {
					sessionId: 'grok-local',
					onAuthenticate: localAuthenticate,
					sshRemoteId: undefined as string | undefined,
				},
			}
		);

		rerender({
			sessionId: 'grok-remote',
			onAuthenticate: remoteAuthenticate,
			sshRemoteId: 'remote-grok-2',
		});
		expect(result.current.recoveryActions[0].onClick).toBe(remoteAuthenticate);
		act(() => result.current.handleRecovery('authenticate'));
		expect(remoteAuthenticate).toHaveBeenCalledExactlyOnceWith();
		expect(localAuthenticate).not.toHaveBeenCalled();
	});

	it('does not offer Grok authentication without the existing callback', () => {
		const onNewSession = vi.fn();
		const { result } = renderHook(() =>
			useAgentErrorRecovery({
				error: { ...baseError, agentId: 'grok' },
				agentId: 'grok',
				sessionId: 'grok-local',
				onNewSession,
			})
		);
		expect(result.current.recoveryActions.map(({ id }) => id)).toEqual(['new-session']);
		act(() => result.current.handleRecovery('authenticate'));
		expect(onNewSession).not.toHaveBeenCalled();
	});

	it.each([
		['codex', 'Run "codex login" here'],
		['opencode', 'Run "opencode auth login" here'],
		['antigravity', 'Run "agy" here'],
	] as const)('preserves known login guidance for %s', (agentId, description) => {
		const onAuthenticate = vi.fn();
		const { result } = renderHook(() =>
			useAgentErrorRecovery({
				error: { ...baseError, agentId },
				agentId,
				sessionId: 'other-provider',
				onAuthenticate,
			})
		);
		expect(result.current.recoveryActions[0]).toMatchObject({
			id: 'authenticate',
			label: 'Re-authenticate',
			description,
			onClick: onAuthenticate,
		});
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
