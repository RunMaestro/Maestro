/**
 * Error shapes the process layer throws that callers need to recognise by
 * message rather than by type. Kept in `shared/` so the thrower and the
 * matcher cannot drift: an IPC rejection arrives in the renderer as a plain
 * `Error` whose message has been re-wrapped by Electron, so the text really is
 * the only thing left to match on.
 */

/**
 * Prefix of the refusal `ProcessManager.spawn` throws when a session already
 * owns a live agent process. Build the message with
 * `agentAlreadyRunningMessage()` and test for it with
 * `isAgentAlreadyRunningError()` - never re-type the literal.
 */
export const AGENT_ALREADY_RUNNING_PREFIX = 'Agent process already running for session';

/** The exact message `ProcessManager.spawn` throws for an owned session. */
export function agentAlreadyRunningMessage(sessionId: string): string {
	return `${AGENT_ALREADY_RUNNING_PREFIX} ${sessionId}`;
}

/**
 * True when a failure is that refusal, including when it arrives wrapped by
 * Electron's IPC bridge as
 * `Error invoking remote method 'process:spawn': Error: Agent process ...`.
 */
export function isAgentAlreadyRunningError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? '');
	return message.includes(AGENT_ALREADY_RUNNING_PREFIX);
}

/**
 * Log-safe description of a failure: the error class and errno code, never the
 * message. Spawn, injection and SSH errors can echo prompt-bearing argv or
 * private file paths, so a caller that must not leak them still reports WHAT
 * failed (`ENOENT`, `EACCES`, `TypeError`) to the logger or Sentry.
 */
export function redactedErrorFields(error: unknown): { errorName: string; errorCode?: string } {
	const errorName = error instanceof Error ? error.name : typeof error;
	const code =
		error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
	return code ? { errorName, errorCode: code } : { errorName };
}
