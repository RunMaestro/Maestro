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
 * the rest of the app does not, or misses one it does. So detection now runs
 * through the canonical bank for the agent actually in use, and what stays here
 * is presentation: a title, a recovery hint, and whether retrying the same
 * message could possibly help.
 *
 * The auth hint points INTO the app. Maestro signs the user in from the Auth
 * Recovery Modal, so sending them to a terminal to guess a login command is a
 * dead end - see `useWizardAuthRecovery` for the button that opens it.
 */

import { getErrorPatterns, matchErrorPattern } from '../../../../shared/agentErrorPatterns';
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

/**
 * What to do about it. Every line describes something the user can do from
 * here - none of them sends the user to a terminal.
 */
const RECOVERY_HINTS: Record<AgentErrorType, string> = {
	auth_expired:
		'Sign in below and Maestro runs the login for you, then pick up where you left off.',
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
		recoveryHint: RECOVERY_HINTS[match.type] ?? RECOVERY_HINTS.unknown,
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
