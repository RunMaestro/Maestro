/**
 * Wizard Error Detection
 *
 * Detects provider errors from agent output during wizard conversations and
 * turns them into something the conversation screen can show.
 *
 * The regexes are NOT here. This module used to carry its own bank of about
 * twenty patterns, including six for auth, which had already drifted behind the
 * canonical bank in `src/shared/agentErrorPatterns.ts` (eleven auth patterns for
 * claude-code alone) and was provider-agnostic in a screen that always knows
 * which provider it is driving. Two banks means the wizard recognises a failure
 * the rest of the app does not, or misses one it does - and the stale copy told
 * every user to run `claude login`, which is not a real command and is the wrong
 * provider for four of the agents the wizard can drive. So detection now runs
 * through the canonical bank for the agent actually in use, and what stays here
 * is presentation: a title, a recovery hint, and whether retrying the same
 * message could possibly help.
 */

import { getErrorPatterns, matchErrorPattern } from '../../../../shared/agentErrorPatterns';
import { formatAgentLoginCommand, getAgentLoginCommand } from '../../../../shared/agentMetadata';
import type { AgentErrorType, ToolType } from '../../../types';

/**
 * The error taxonomy is the app's, not the wizard's. Kept as an alias because
 * the screens import this name.
 */
export type WizardErrorType = AgentErrorType;

export interface WizardError {
	type: WizardErrorType;
	title: string;
	message: string;
	recoveryHint: string;
	/** Whether the user can retry this operation */
	canRetry: boolean;
}

/** Heading for the error panel, per error type. */
const ERROR_TITLES: Record<AgentErrorType, string> = {
	auth_expired: 'Authentication Required',
	token_exhaustion: 'Context Limit Reached',
	rate_limited: 'Rate Limited',
	network_error: 'Network Error',
	agent_crashed: 'Agent Error',
	permission_denied: 'Permission Denied',
	session_not_found: 'Session Not Found',
	hitl_gate: 'Review Required',
	unknown: 'Agent Error',
};

/** What to do about it, for every type whose remedy does not depend on the agent. */
const RECOVERY_HINTS: Record<AgentErrorType, string> = {
	auth_expired: 'Sign in to your provider again, then start the wizard over.',
	token_exhaustion: 'Start the wizard again with a fresh conversation.',
	rate_limited: 'Wait a moment, then try again.',
	network_error: 'Check your internet connection, then try again.',
	agent_crashed: 'Try again. If it keeps happening, check the agent installation.',
	permission_denied: 'The agent was refused access. Check the folder permissions, then try again.',
	session_not_found: 'Start the wizard again with a fresh conversation.',
	hitl_gate: 'The agent is waiting on a human review step. Try again once it is cleared.',
	unknown: 'Try again. If the problem persists, check the debug logs below.',
};

/**
 * Types where sending the same message again can work.
 *
 * This is NOT the bank's `recoverable` flag, which means "the user can fix
 * this", not "resending helps". An expired login is recoverable and retrying it
 * is pointless until the user signs in.
 */
const RETRYABLE_TYPES: ReadonlySet<AgentErrorType> = new Set<AgentErrorType>([
	'rate_limited',
	'network_error',
	'agent_crashed',
	'unknown',
]);

/**
 * The recovery hint for one error, named for the agent that produced it.
 *
 * Only `auth_expired` varies: the command differs per provider, and some
 * providers have no login subcommand at all (they expose the flow as a slash
 * command inside their TUI), which is exactly what `getAgentLoginCommand`
 * records. When the agent has no login flow, the generic hint stands rather
 * than inventing a command to type into a shell.
 */
function recoveryHintFor(type: AgentErrorType, agentType: ToolType): string {
	const generic = RECOVERY_HINTS[type] ?? RECOVERY_HINTS.unknown;
	if (type !== 'auth_expired') return generic;

	const login = getAgentLoginCommand(agentType);
	if (!login) return generic;

	const command = formatAgentLoginCommand(login);
	const followUp = login.followUp ? `, then type ${login.followUp}` : '';
	return `Run "${command}"${followUp} to sign in again, then start the wizard over.`;
}

/**
 * Detect provider errors in agent output.
 *
 * @param output - The raw output from the agent (stdout/stderr combined)
 * @param agentType - The agent that produced it, which selects the pattern bank
 * @returns Detected error or null if no provider error found
 */
export function detectWizardError(output: string, agentType: ToolType): WizardError | null {
	if (!output) return null;

	// minLength 0: the streaming guard exists for single-token chunks, and this
	// is a whole finished output buffer.
	const match = matchErrorPattern(getErrorPatterns(agentType), output, { minLength: 0 });
	if (!match) return null;

	return {
		type: match.type,
		title: ERROR_TITLES[match.type] ?? ERROR_TITLES.unknown,
		message: match.message,
		recoveryHint: recoveryHintFor(match.type, agentType),
		canRetry: RETRYABLE_TYPES.has(match.type),
	};
}

/**
 * Format a wizard error for display to the user.
 *
 * @param error - The detected error
 * @returns Formatted error message string
 */
export function formatWizardError(error: WizardError): string {
	return `${error.title}: ${error.message}\n\n${error.recoveryHint}`;
}

/**
 * Create an error message from raw output when no specific pattern matches.
 * Extracts the most relevant error information from the output.
 *
 * @param output - Raw agent output
 * @param exitCode - Process exit code
 * @returns User-friendly error message
 */
export function createGenericErrorMessage(output: string, exitCode: number): string {
	// Try to extract JSON error message
	const jsonMatch = output.match(/"message"\s*:\s*"([^"]+)"/);
	if (jsonMatch) {
		return jsonMatch[1];
	}

	// Try to extract error line
	const errorLineMatch = output.match(/error[:\s]+(.+?)(?:\n|$)/i);
	if (errorLineMatch) {
		return errorLineMatch[1].trim();
	}

	// Default message
	return `Agent exited with code ${exitCode}. Check the terminal for details.`;
}
