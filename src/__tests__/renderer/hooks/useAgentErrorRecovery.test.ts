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
});
