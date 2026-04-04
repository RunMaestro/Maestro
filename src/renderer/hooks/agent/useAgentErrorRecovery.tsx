/**
 * useAgentErrorRecovery - Hook for generating recovery actions for agent errors
 *
 * This hook provides agent-specific recovery actions based on the error type.
 * It returns an array of RecoveryAction objects that can be displayed in the
 * AgentErrorModal component.
 *
 * Usage:
 * ```typescript
 * const { recoveryActions, handleRecovery, clearError } = useAgentErrorRecovery({
 *   error: session.agentError,
 *   agentId: session.toolType,
 *   sessionId: session.id,
 *   onNewSession: () => createNewSession(),
 *   onRetry: () => retryLastMessage(),
 *   onClearError: () => clearSessionError(),
 * });
 * ```
 */

import { useMemo, useCallback } from 'react';
import { KeyRound, MessageSquarePlus, RefreshCw, RotateCcw, Wifi, Terminal } from 'lucide-react';
import type { AgentError, ToolType } from '../../types';
import type { RecoveryAction } from '../../components/AgentErrorModal';

export interface UseAgentErrorRecoveryOptions {
	/** The agent error to generate recovery actions for */
	error: AgentError | undefined;
	/** The agent ID (tool type) */
	agentId: ToolType;
	/** The session ID */
	sessionId: string;
	/** Callback to start a new session */
	onNewSession?: () => void;
	/** Callback to retry the last operation */
	onRetry?: () => void;
	/** Callback to clear the error and resume */
	onClearError?: () => void;
	/** Callback to restart the agent */
	onRestartAgent?: () => void;
	/** Callback to open authentication flow */
	onAuthenticate?: () => void;
}

export interface UseAgentErrorRecoveryResult {
	/** Array of recovery actions for the error */
	recoveryActions: RecoveryAction[];
	/** Execute a recovery action by its ID */
	handleRecovery: (actionId: string) => void;
	/** Clear the error and dismiss the modal */
	clearError: () => void;
}

/**
 * Get recovery actions for a specific error type and agent
 */
function getRecoveryActionsForError(
	error: AgentError,
	agentId: ToolType,
	options: UseAgentErrorRecoveryOptions
): RecoveryAction[] {
	const actions: RecoveryAction[] = [];

	switch (error.type) {
		case 'auth_expired':
			// Authentication error - offer to re-authenticate or start new session
			if (options.onAuthenticate) {
				const isClaude = agentId === 'claude-code';
				actions.push({
					id: 'authenticate',
					label: isClaude ? 'Use Terminal' : 'Re-authenticate',
					description: isClaude
						? 'Run "claude login" in terminal'
						: 'Log in again to restore access',
					primary: true,
					icon: isClaude ? <Terminal className="w-4 h-4" /> : <KeyRound className="w-4 h-4" />,
					onClick: options.onAuthenticate,
				});
			}
			if (options.onNewSession) {
				actions.push({
					id: 'new-session',
					label: 'Start New Session',
					description: 'Begin a fresh conversation',
					icon: <MessageSquarePlus className="w-4 h-4" />,
					onClick: options.onNewSession,
				});
			}
			break;

		case 'token_exhaustion':
			// Context exhausted - offer new session or retry with truncation
			if (options.onNewSession) {
				actions.push({
					id: 'new-session',
					label: 'Start New Session',
					description: 'Begin a fresh conversation with full context',
					primary: true,
					icon: <MessageSquarePlus className="w-4 h-4" />,
					onClick: options.onNewSession,
				});
			}
			break;

		case 'rate_limited':
			// Rate limited - offer retry after delay
			if (options.onRetry) {
				actions.push({
					id: 'retry',
					label: 'Try Again',
					description: 'Wait a moment and retry',
					primary: true,
					icon: <RefreshCw className="w-4 h-4" />,
					onClick: options.onRetry,
				});
			}
			break;

		case 'network_error':
			// Network error - offer retry or check connection
			if (options.onRetry) {
				actions.push({
					id: 'retry',
					label: 'Retry Connection',
					description: 'Attempt to reconnect',
					primary: true,
					icon: <Wifi className="w-4 h-4" />,
					onClick: options.onRetry,
				});
			}
			break;

		case 'agent_crashed':
			// Agent crashed - offer restart or fresh session
			if (options.onRestartAgent) {
				actions.push({
					id: 'restart-agent',
					label: 'Restart Agent',
					description: 'Respawn the agent process',
					primary: true,
					icon: <RotateCcw className="w-4 h-4" />,
					onClick: options.onRestartAgent,
				});
			}
			if (options.onNewSession) {
				actions.push({
					id: 'new-session',
					label: 'Start New Session',
					description: 'Begin a fresh conversation',
					icon: <MessageSquarePlus className="w-4 h-4" />,
					onClick: options.onNewSession,
				});
			}
			break;

		case 'permission_denied':
			// Permission denied - offer retry or new session
			if (options.onRetry) {
				actions.push({
					id: 'retry',
					label: 'Try Again',
					description: 'Retry with different approach',
					primary: true,
					icon: <RefreshCw className="w-4 h-4" />,
					onClick: options.onRetry,
				});
			}
			break;

		default:
			// Unknown error - offer generic retry
			if (options.onRetry) {
				actions.push({
					id: 'retry',
					label: 'Try Again',
					description: 'Retry the operation',
					primary: true,
					icon: <RefreshCw className="w-4 h-4" />,
					onClick: options.onRetry,
				});
			}
	}

	return actions;
}

/**
 * Hook for generating recovery actions for agent errors
 */
export function useAgentErrorRecovery(
	options: UseAgentErrorRecoveryOptions
): UseAgentErrorRecoveryResult {
	const { error, agentId, onClearError } = options;

	// Generate recovery actions for the current error
	const recoveryActions = useMemo(() => {
		if (!error) return [];
		return getRecoveryActionsForError(error, agentId, options);
	}, [
		error,
		agentId,
		options.onAuthenticate,
		options.onNewSession,
		options.onRestartAgent,
		options.onRetry,
	]);

	// Handler to execute a recovery action by its ID
	const handleRecovery = useCallback(
		(actionId: string) => {
			const action = recoveryActions.find((a) => a.id === actionId);
			if (action) {
				action.onClick();
			}
		},
		[recoveryActions]
	);

	// Handler to clear the error
	const clearError = useCallback(() => {
		if (onClearError) {
			onClearError();
		}
	}, [onClearError]);

	return {
		recoveryActions,
		handleRecovery,
		clearError,
	};
}

export default useAgentErrorRecovery;
