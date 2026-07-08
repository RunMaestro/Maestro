import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAgentErrorRecovery } from '../../renderer/hooks/agent/useAgentErrorRecovery';
import type { AgentError, AgentErrorType, ToolType } from '../../renderer/types';

function agentError(type: AgentErrorType): AgentError {
	return {
		type,
		message: `${type} message`,
		recoverable: true,
		agentId: 'codex',
		sessionId: 'session-1',
		timestamp: 1000,
	};
}

function renderRecovery(
	type: AgentErrorType | undefined,
	overrides: Partial<Parameters<typeof useAgentErrorRecovery>[0]> = {}
) {
	return renderHook(() =>
		useAgentErrorRecovery({
			error: type ? agentError(type) : undefined,
			agentId: 'codex',
			sessionId: 'session-1',
			...overrides,
		})
	);
}

describe('useAgentErrorRecovery integration', () => {
	it('returns no actions without an error and safely ignores missing handlers', () => {
		const { result } = renderRecovery(undefined);

		expect(result.current.recoveryActions).toEqual([]);
		expect(() => result.current.handleRecovery('missing')).not.toThrow();
		expect(() => result.current.clearError()).not.toThrow();
	});

	it('builds authentication actions for Claude and non-Claude agents', () => {
		const authenticate = vi.fn();
		const newSession = vi.fn();
		const claude = renderRecovery('auth_expired', {
			agentId: 'claude-code',
			onAuthenticate: authenticate,
			onNewSession: newSession,
		});

		expect(claude.result.current.recoveryActions.map((action) => action.id)).toEqual([
			'authenticate',
			'new-session',
		]);
		expect(claude.result.current.recoveryActions[0]).toMatchObject({
			label: 'Use Terminal',
			description: 'Run "claude login" in terminal',
			primary: true,
		});

		claude.result.current.handleRecovery('authenticate');
		claude.result.current.handleRecovery('new-session');

		expect(authenticate).toHaveBeenCalledTimes(1);
		expect(newSession).toHaveBeenCalledTimes(1);

		const nonClaude = renderRecovery('auth_expired', {
			agentId: 'opencode' as ToolType,
			onAuthenticate: authenticate,
		});

		expect(nonClaude.result.current.recoveryActions).toHaveLength(1);
		expect(nonClaude.result.current.recoveryActions[0]).toMatchObject({
			id: 'authenticate',
			label: 'Re-authenticate',
			description: 'Log in again to restore access',
		});
	});

	it('builds context, rate-limit, network, crash, permission, and unknown recovery actions', () => {
		const newSession = vi.fn();
		const retry = vi.fn();
		const restartAgent = vi.fn();

		const token = renderRecovery('token_exhaustion', { onNewSession: newSession });
		expect(token.result.current.recoveryActions[0]).toMatchObject({
			id: 'new-session',
			label: 'Start New Session',
			primary: true,
		});
		token.result.current.handleRecovery('new-session');

		const rate = renderRecovery('rate_limited', { onRetry: retry });
		expect(rate.result.current.recoveryActions[0]).toMatchObject({
			id: 'retry',
			label: 'Try Again',
			description: 'Wait a moment and retry',
			primary: true,
		});
		rate.result.current.handleRecovery('retry');

		const network = renderRecovery('network_error', { onRetry: retry });
		expect(network.result.current.recoveryActions[0]).toMatchObject({
			id: 'retry',
			label: 'Retry Connection',
			description: 'Attempt to reconnect',
		});
		network.result.current.handleRecovery('retry');

		const crash = renderRecovery('agent_crashed', {
			onRestartAgent: restartAgent,
			onNewSession: newSession,
		});
		expect(crash.result.current.recoveryActions.map((action) => action.id)).toEqual([
			'restart-agent',
			'new-session',
		]);
		crash.result.current.handleRecovery('restart-agent');

		const permission = renderRecovery('permission_denied', { onRetry: retry });
		expect(permission.result.current.recoveryActions[0]).toMatchObject({
			id: 'retry',
			description: 'Retry with different approach',
		});
		permission.result.current.handleRecovery('retry');

		const unknown = renderRecovery('unknown', { onRetry: retry });
		expect(unknown.result.current.recoveryActions[0]).toMatchObject({
			id: 'retry',
			description: 'Retry the operation',
		});
		unknown.result.current.handleRecovery('retry');

		expect(newSession).toHaveBeenCalledTimes(1);
		expect(restartAgent).toHaveBeenCalledTimes(1);
		expect(retry).toHaveBeenCalledTimes(4);
	});

	it('returns empty action lists when optional recovery callbacks are unavailable', () => {
		expect(renderRecovery('auth_expired').result.current.recoveryActions).toEqual([]);
		expect(renderRecovery('token_exhaustion').result.current.recoveryActions).toEqual([]);
		expect(renderRecovery('rate_limited').result.current.recoveryActions).toEqual([]);
		expect(renderRecovery('network_error').result.current.recoveryActions).toEqual([]);
		expect(renderRecovery('agent_crashed').result.current.recoveryActions).toEqual([]);
		expect(renderRecovery('permission_denied').result.current.recoveryActions).toEqual([]);
		expect(renderRecovery('unknown').result.current.recoveryActions).toEqual([]);
	});

	it('clears errors through the provided callback', () => {
		const clearError = vi.fn();
		const { result } = renderRecovery('unknown', { onClearError: clearError });

		result.current.clearError();

		expect(clearError).toHaveBeenCalledTimes(1);
	});
});
