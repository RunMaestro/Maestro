import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentErrorRecovery } from '../../../renderer/hooks';
import type { AgentError, AgentErrorType } from '../../../shared/types';

const baseError: AgentError = {
	type: 'auth_expired',
	message: 'Authentication required',
	recoverable: true,
	agentId: 'claude-code',
	timestamp: 1700000000000,
};

const errorOfType = (type: AgentErrorType): AgentError => ({
	...baseError,
	type,
});

describe('useAgentErrorRecovery', () => {
	it('creates claude-code auth actions with terminal guidance and new session', () => {
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
		expect(authAction.label).toBe('Use Terminal');
		expect(authAction.primary).toBe(true);
		expect(newSessionAction.id).toBe('new-session');

		act(() => {
			authAction.onClick();
			newSessionAction.onClick();
		});

		expect(onAuthenticate).toHaveBeenCalledTimes(1);
		expect(onNewSession).toHaveBeenCalledTimes(1);
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

	it('creates non-Claude auth guidance and can execute recovery by action id', () => {
		const onAuthenticate = vi.fn();

		const { result } = renderHook(() =>
			useAgentErrorRecovery({
				error: baseError,
				agentId: 'codex',
				sessionId: 's1',
				onAuthenticate,
			})
		);

		expect(result.current.recoveryActions).toHaveLength(1);
		expect(result.current.recoveryActions[0]).toMatchObject({
			id: 'authenticate',
			label: 'Re-authenticate',
			description: 'Log in again to restore access',
			primary: true,
		});

		act(() => {
			result.current.handleRecovery('authenticate');
		});

		expect(onAuthenticate).toHaveBeenCalledTimes(1);
	});

	it('returns no auth actions when no auth or new-session callbacks are available', () => {
		const { result } = renderHook(() =>
			useAgentErrorRecovery({
				error: baseError,
				agentId: 'claude-code',
				sessionId: 's1',
			})
		);

		expect(result.current.recoveryActions).toEqual([]);
	});

	it('returns no actions when there is no current error', () => {
		const onRetry = vi.fn();

		const { result } = renderHook(() =>
			useAgentErrorRecovery({
				error: undefined,
				agentId: 'claude-code',
				sessionId: 's1',
				onRetry,
			})
		);

		expect(result.current.recoveryActions).toEqual([]);

		act(() => {
			result.current.handleRecovery('retry');
		});

		expect(onRetry).not.toHaveBeenCalled();
	});

	it('offers a primary new-session action for token exhaustion only when available', () => {
		const onNewSession = vi.fn();

		const { result, rerender } = renderHook(
			({ includeCallback }: { includeCallback: boolean }) =>
				useAgentErrorRecovery({
					error: errorOfType('token_exhaustion'),
					agentId: 'claude-code',
					sessionId: 's1',
					onNewSession: includeCallback ? onNewSession : undefined,
				}),
			{ initialProps: { includeCallback: true } }
		);

		expect(result.current.recoveryActions).toHaveLength(1);
		expect(result.current.recoveryActions[0]).toMatchObject({
			id: 'new-session',
			label: 'Start New Session',
			description: 'Begin a fresh conversation with full context',
			primary: true,
		});

		act(() => {
			result.current.handleRecovery('new-session');
		});

		expect(onNewSession).toHaveBeenCalledTimes(1);

		rerender({ includeCallback: false });

		expect(result.current.recoveryActions).toEqual([]);
	});

	it('offers retry actions for network and permission errors only when retry is available', () => {
		const onRetry = vi.fn();

		const { result, rerender } = renderHook(
			({ type, includeRetry }: { type: AgentErrorType; includeRetry: boolean }) =>
				useAgentErrorRecovery({
					error: errorOfType(type),
					agentId: 'claude-code',
					sessionId: 's1',
					onRetry: includeRetry ? onRetry : undefined,
				}),
			{ initialProps: { type: 'network_error', includeRetry: true } }
		);

		expect(result.current.recoveryActions[0]).toMatchObject({
			id: 'retry',
			label: 'Retry Connection',
			description: 'Attempt to reconnect',
			primary: true,
		});

		act(() => {
			result.current.handleRecovery('retry');
		});

		expect(onRetry).toHaveBeenCalledTimes(1);

		rerender({ type: 'network_error', includeRetry: false });

		expect(result.current.recoveryActions).toEqual([]);

		rerender({ type: 'permission_denied', includeRetry: true });

		expect(result.current.recoveryActions[0]).toMatchObject({
			id: 'retry',
			label: 'Try Again',
			description: 'Retry with different approach',
			primary: true,
		});

		rerender({ type: 'permission_denied', includeRetry: false });

		expect(result.current.recoveryActions).toEqual([]);
	});

	it('omits rate-limit and crash recovery actions when matching callbacks are missing', () => {
		const { result, rerender } = renderHook(
			({ type }: { type: AgentErrorType }) =>
				useAgentErrorRecovery({
					error: errorOfType(type),
					agentId: 'claude-code',
					sessionId: 's1',
				}),
			{ initialProps: { type: 'rate_limited' } }
		);

		expect(result.current.recoveryActions).toEqual([]);

		rerender({ type: 'agent_crashed' });

		expect(result.current.recoveryActions).toEqual([]);
	});

	it('falls back to generic retry for unhandled error types', () => {
		const onRetry = vi.fn();

		const { result, rerender } = renderHook(
			({ includeRetry }: { includeRetry: boolean }) =>
				useAgentErrorRecovery({
					error: errorOfType('session_not_found'),
					agentId: 'claude-code',
					sessionId: 's1',
					onRetry: includeRetry ? onRetry : undefined,
				}),
			{ initialProps: { includeRetry: true } }
		);

		expect(result.current.recoveryActions[0]).toMatchObject({
			id: 'retry',
			label: 'Try Again',
			description: 'Retry the operation',
			primary: true,
		});

		act(() => {
			result.current.handleRecovery('missing-action');
		});

		expect(onRetry).not.toHaveBeenCalled();

		act(() => {
			result.current.handleRecovery('retry');
		});

		expect(onRetry).toHaveBeenCalledTimes(1);

		rerender({ includeRetry: false });

		expect(result.current.recoveryActions).toEqual([]);
	});

	it('clears errors only when a clear callback exists', () => {
		const onClearError = vi.fn();

		const { result, rerender } = renderHook(
			({ includeCallback }: { includeCallback: boolean }) =>
				useAgentErrorRecovery({
					error: baseError,
					agentId: 'claude-code',
					sessionId: 's1',
					onClearError: includeCallback ? onClearError : undefined,
				}),
			{ initialProps: { includeCallback: true } }
		);

		act(() => {
			result.current.clearError();
		});

		expect(onClearError).toHaveBeenCalledTimes(1);

		rerender({ includeCallback: false });

		act(() => {
			result.current.clearError();
		});

		expect(onClearError).toHaveBeenCalledTimes(1);
	});
});
