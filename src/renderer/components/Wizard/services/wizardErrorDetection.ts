/**
 * Wizard Error Detection
 *
 * Detects provider errors from agent output during wizard conversations.
 * Provides user-friendly error messages and recovery guidance.
 */

export type WizardErrorType =
	| 'auth_expired'
	| 'rate_limited'
	| 'token_exhaustion'
	| 'network_error'
	| 'agent_crashed'
	| 'unknown';

export interface WizardError {
	type: WizardErrorType;
	title: string;
	message: string;
	recoveryHint: string;
	/** Whether the user can retry this operation */
	canRetry: boolean;
}

/**
 * Error patterns for detecting provider errors in agent output.
 * These patterns match common error messages from Claude Code and other providers.
 */
const ERROR_PATTERNS: Array<{
	pattern: RegExp;
	type: WizardErrorType;
	title: string;
	message: string;
	recoveryHint: string;
	canRetry: boolean;
}> = [
	// Authentication errors
	{
		pattern: /OAuth\s*token\s*has\s*expired/i,
		type: 'auth_expired',
		title: 'Authentication Expired',
		message: 'Your OAuth token has expired.',
		recoveryHint:
			'Run "claude login" in your terminal to re-authenticate, then try the wizard again.',
		canRetry: false,
	},
	{
		pattern: /authentication_error/i,
		type: 'auth_expired',
		title: 'Authentication Error',
		message: 'Authentication failed with the provider.',
		recoveryHint:
			'Run "claude login" in your terminal to re-authenticate, then try the wizard again.',
		canRetry: false,
	},
	{
		pattern: /invalid\s*api\s*key/i,
		type: 'auth_expired',
		title: 'Invalid API Key',
		message: 'Your API key is invalid or has been revoked.',
		recoveryHint: 'Check your API key configuration or run "claude login" to re-authenticate.',
		canRetry: false,
	},
	{
		pattern: /please\s*run\s*.*login/i,
		type: 'auth_expired',
		title: 'Login Required',
		message: 'You need to log in to the provider.',
		recoveryHint: 'Run the login command shown in your terminal, then try the wizard again.',
		canRetry: false,
	},
	{
		pattern: /unauthorized|401/i,
		type: 'auth_expired',
		title: 'Unauthorized',
		message: 'Your credentials are not valid.',
		recoveryHint: 'Re-authenticate with your provider and try the wizard again.',
		canRetry: false,
	},
	{
		pattern: /not\s*authenticated/i,
		type: 'auth_expired',
		title: 'Not Authenticated',
		message: 'You are not currently authenticated.',
		recoveryHint: 'Run the login command for your agent provider.',
		canRetry: false,
	},

	// Rate limiting
	{
		pattern: /rate\s*limit/i,
		type: 'rate_limited',
		title: 'Rate Limited',
		message: 'Too many requests to the provider.',
		recoveryHint: 'Wait a few minutes before trying again.',
		canRetry: true,
	},
	{
		pattern: /too\s*many\s*requests|429/i,
		type: 'rate_limited',
		title: 'Too Many Requests',
		message: 'The provider is limiting your requests.',
		recoveryHint: 'Wait a minute or two before retrying.',
		canRetry: true,
	},
	{
		pattern: /overloaded|529/i,
		type: 'rate_limited',
		title: 'Service Overloaded',
		message: 'The service is temporarily overloaded.',
		recoveryHint: 'The provider is experiencing high demand. Try again in a few moments.',
		canRetry: true,
	},
	{
		pattern: /quota\s*exceeded/i,
		type: 'rate_limited',
		title: 'Quota Exceeded',
		message: 'Your API quota has been exceeded.',
		recoveryHint: 'Check your plan limits or wait for your quota to reset.',
		canRetry: false,
	},

	// Token/context exhaustion
	{
		pattern: /context.*too\s*long|context\s*window/i,
		type: 'token_exhaustion',
		title: 'Context Too Long',
		message: 'The conversation has exceeded the context limit.',
		recoveryHint: 'Start the wizard again with a fresh conversation.',
		canRetry: false,
	},
	{
		pattern: /maximum.*tokens|token\s*limit/i,
		type: 'token_exhaustion',
		title: 'Token Limit Reached',
		message: 'The maximum token limit has been reached.',
		recoveryHint: 'Start the wizard again with a fresh conversation.',
		canRetry: false,
	},

	// Network errors
	{
		pattern: /connection\s*(failed|refused|error|reset)/i,
		type: 'network_error',
		title: 'Connection Failed',
		message: 'Could not connect to the provider.',
		recoveryHint: 'Check your internet connection and try again.',
		canRetry: true,
	},
	{
		pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND/i,
		type: 'network_error',
		title: 'Network Error',
		message: 'A network error occurred.',
		recoveryHint: 'Check your internet connection and firewall settings.',
		canRetry: true,
	},
	{
		pattern: /network\s*(error|failure|unavailable)/i,
		type: 'network_error',
		title: 'Network Unavailable',
		message: 'The network is unavailable.',
		recoveryHint: 'Ensure you have an active internet connection.',
		canRetry: true,
	},
	{
		pattern: /socket\s*hang\s*up/i,
		type: 'network_error',
		title: 'Connection Interrupted',
		message: 'The connection was unexpectedly closed.',
		recoveryHint: 'This may be a temporary issue. Try again.',
		canRetry: true,
	},

	// Agent crashes
	{
		pattern: /fatal\s*error|unhandled\s*error|internal\s*error/i,
		type: 'agent_crashed',
		title: 'Agent Error',
		message: 'The agent encountered an unexpected error.',
		recoveryHint: 'Try again. If the problem persists, check the agent installation.',
		canRetry: true,
	},
	{
		pattern: /panic/i,
		type: 'agent_crashed',
		title: 'Agent Crashed',
		message: 'The agent crashed unexpectedly.',
		recoveryHint: 'Try again or restart the application.',
		canRetry: true,
	},
];

/**
 * Detect provider errors in agent output.
 *
 * @param output - The raw output from the agent (stdout/stderr combined)
 * @returns Detected error or null if no provider error found
 */
export function detectWizardError(output: string): WizardError | null {
	if (!output) return null;

	for (const errorDef of ERROR_PATTERNS) {
		if (errorDef.pattern.test(output)) {
			return {
				type: errorDef.type,
				title: errorDef.title,
				message: errorDef.message,
				recoveryHint: errorDef.recoveryHint,
				canRetry: errorDef.canRetry,
			};
		}
	}

	return null;
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
