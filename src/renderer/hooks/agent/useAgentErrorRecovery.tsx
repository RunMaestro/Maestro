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
import { KeyRound, LogIn, MessageSquarePlus, RefreshCw, RotateCcw, Wifi } from 'lucide-react';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import type { CredentialIdentity } from '../../../shared/providerAuth';
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
	/**
	 * Callback to open the in-app login flow (the Auth Recovery Modal). Only ever
	 * called for an `oauth` credential, since that is the only kind a login
	 * repairs.
	 */
	onAuthenticate?: () => void;
	/**
	 * Callback to open the agent's credential configuration, for every credential
	 * kind a login cannot repair (a rejected key, a gateway token, cloud creds).
	 */
	onConfigureCredentials?: () => void;
	/**
	 * The credential the failing agent presents, when Maestro could resolve one.
	 * Decides WHICH auth remedy is offered and names it after the account rather
	 * than after the agent.
	 */
	identity?: CredentialIdentity | null;
	/** Account name from the last probe, when it surfaced one. */
	accountLabel?: string;
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
 * One line explaining why a login button is absent, naming the env var actually
 * in play so the user knows what to go change.
 *
 * The long-form counterpart is `describeCredentialRemedy()` in
 * `components/AuthRecoveryModal.tsx`, which has a paragraph to work with. This
 * one has a button subtitle, so it says the same thing in a sentence rather
 * than sharing a string that fits neither surface.
 */
export function describeCredentialFix(
	identity: CredentialIdentity | null | undefined,
	providerName: string
): string {
	if (!identity) return `Check the credentials ${providerName} presents`;
	const envVar = identity.envVarName;
	switch (identity.kind) {
		case 'api-key':
			return `${envVar ?? 'The API key'} was rejected - signing in cannot fix it`;
		case 'gateway':
			return `${envVar ?? 'A base-URL override'} points at ${identity.label}, so the credential is theirs`;
		case 'cloud-provider':
			return `${identity.label} credentials come from the cloud SDK chain, not from a login`;
		default:
			return `${providerName} has no login flow Maestro can drive`;
	}
}

/**
 * The primary action for an `auth_expired` error.
 *
 * Which one it is comes from the CREDENTIAL, never from the agent id: fifteen
 * agents can share one Anthropic login, and the same agent id can be running on
 * an API key, a gateway token, or Bedrock. Only an `oauth` credential is
 * repaired by signing in, so only `oauth` gets a login button - offering one for
 * a revoked key sends the user to a command that cannot possibly help.
 */
function buildAuthAction(options: UseAgentErrorRecoveryOptions): RecoveryAction | null {
	const { identity, accountLabel, onAuthenticate, onConfigureCredentials } = options;
	// The identity names the provider when there is one; the failing agent's own
	// id is the fallback for the window before the identity resolves.
	const providerName = getAgentDisplayName(identity?.provider ?? options.agentId);

	if (identity?.kind === 'oauth') {
		if (!onAuthenticate) return null;
		const account = accountLabel || identity.label;
		return {
			id: 'authenticate',
			label: account ? `Sign in to ${providerName} (${account})` : `Sign in to ${providerName}`,
			description: 'Sign in here - every agent on this account is unblocked at once',
			primary: true,
			icon: <LogIn className="w-4 h-4" />,
			onClick: onAuthenticate,
		};
	}

	if (!onConfigureCredentials) return null;
	return {
		id: 'configure-credentials',
		label: 'Fix Credentials',
		description: describeCredentialFix(identity, providerName),
		primary: true,
		icon: <KeyRound className="w-4 h-4" />,
		onClick: onConfigureCredentials,
	};
}

/**
 * Get recovery actions for a specific error type and agent
 */
function getRecoveryActionsForError(
	error: AgentError,
	options: UseAgentErrorRecoveryOptions
): RecoveryAction[] {
	const actions: RecoveryAction[] = [];

	switch (error.type) {
		case 'auth_expired': {
			// Authentication error - repair the credential in app, or explain why a
			// login cannot repair this one. Never "go type a command in a terminal".
			const authAction = buildAuthAction(options);
			if (authAction) actions.push(authAction);
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
		}

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
	const { error, onClearError } = options;

	// Generate recovery actions for the current error
	const recoveryActions = useMemo(() => {
		if (!error) return [];
		return getRecoveryActionsForError(error, options);
	}, [
		error,
		// The credential decides which auth remedy is offered and what it is called,
		// so both halves of it belong in the dependency list.
		options.identity,
		options.accountLabel,
		options.onAuthenticate,
		options.onConfigureCredentials,
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
