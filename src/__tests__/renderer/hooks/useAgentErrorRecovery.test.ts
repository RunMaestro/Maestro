import { describe, it, expect, vi, afterEach } from 'vitest';
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

	describe('agent_not_installed', () => {
		const notInstalled: AgentError = {
			...baseError,
			type: 'agent_not_installed',
			message: 'Codex CLI not installed.',
			agentId: 'codex',
		};
		const originalPlatform = (window as unknown as { maestro: { platform?: string } }).maestro
			.platform;

		afterEach(() => {
			(window as unknown as { maestro: { platform?: string } }).maestro.platform = originalPlatform;
		});

		it('offers the install for this platform first, then a retry', () => {
			(window as unknown as { maestro: { platform?: string } }).maestro.platform = 'darwin';
			const onInstall = vi.fn();
			const onRetry = vi.fn();

			const { result } = renderHook(() =>
				useAgentErrorRecovery({
					error: notInstalled,
					agentId: 'codex',
					sessionId: 's1',
					onInstall,
					onRetry,
				})
			);

			const [installAction, retryAction] = result.current.recoveryActions;
			expect(installAction.id).toBe('install');
			expect(installAction.label).toBe('Install Codex');
			expect(installAction.description).toBe('Run "npm install -g @openai/codex" here');
			expect(installAction.primary).toBe(true);
			expect(retryAction.id).toBe('retry');
			expect(retryAction.primary).toBe(false);

			act(() => installAction.onClick());
			expect(onInstall).toHaveBeenCalledTimes(1);
		});

		it('falls back to retry alone when there is no install for the platform', () => {
			(window as unknown as { maestro: { platform?: string } }).maestro.platform = 'browser';
			const { result } = renderHook(() =>
				useAgentErrorRecovery({
					error: notInstalled,
					agentId: 'codex',
					sessionId: 's1',
					onInstall: vi.fn(),
					onRetry: vi.fn(),
				})
			);

			expect(result.current.recoveryActions.map((a) => a.id)).toEqual(['retry']);
			expect(result.current.recoveryActions[0].primary).toBe(true);
		});

		it('never offers a restart, which would fail the same way', () => {
			(window as unknown as { maestro: { platform?: string } }).maestro.platform = 'darwin';
			const { result } = renderHook(() =>
				useAgentErrorRecovery({
					error: notInstalled,
					agentId: 'codex',
					sessionId: 's1',
					onRestartAgent: vi.fn(),
				})
			);
			expect(result.current.recoveryActions).toEqual([]);
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
