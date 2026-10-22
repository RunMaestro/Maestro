// Standardized process exit codes for maestro-cli.
//
// Scripts and CI can branch on these instead of treating every failure as a
// generic non-zero. Keep the set small and stable - each value names a class of
// failure, not a specific message. New code should prefer these over a bare
// `process.exit(1)`; existing call sites are migrated opportunistically.

import {
	CommandTimeoutError,
	MaestroNotRunningError,
	UnsupportedCommandError,
} from './services/maestro-bridge-errors';

export enum ExitCode {
	/** Command succeeded. */
	Success = 0,
	/** Generic / uncategorized failure (the historical `process.exit(1)`). */
	GeneralError = 1,
	/** Bad invocation: unknown flag, missing/invalid argument, nothing to do. */
	InvalidUsage = 2,
	/** The Maestro desktop app is not running or not reachable. */
	NotRunning = 3,
	/** The running app does not support the requested command (older build). */
	Unsupported = 4,
	/** The app was reachable but did not respond in time. */
	Timeout = 5,
	/**
	 * The app declined the request by a switch or a budget (System One is off,
	 * or today's budget is spent). Asking again will not help; go on without it.
	 */
	Refused = 6,
	/**
	 * The request was sent to what answers it and some or all of it has no
	 * answer: the engine failed, or a long job is incomplete.
	 */
	NoAnswer = 7,
	/** The operator interrupted the run (SIGINT, 128 + 2: the shell convention). */
	Interrupted = 130,
}

/**
 * What a verb that answers a question exits with for "no" (`s1 yes`), or for an
 * answer under the confidence the caller asked for (`s1 pick`, `s1 rate`), so
 * the verb can sit in a shell `if`. It is the number `GeneralError` has, so
 * such a verb never reports a failure with it: its failures are 2 or more.
 */
export const NEGATIVE_ANSWER_EXIT_CODE = ExitCode.GeneralError;

/** Exit the process with a typed code. Never returns. */
export function exitWith(code: ExitCode): never {
	return process.exit(code);
}

/**
 * Map a failure from a bridge call to its exit code, so a script can tell a
 * closed app (`NotRunning`), an old app build (`Unsupported`) or a hung
 * renderer (`Timeout`) from an ordinary error without parsing the message.
 */
export function exitCodeForError(error: unknown): ExitCode {
	if (error instanceof MaestroNotRunningError) return ExitCode.NotRunning;
	if (error instanceof UnsupportedCommandError) return ExitCode.Unsupported;
	if (error instanceof CommandTimeoutError) return ExitCode.Timeout;
	return ExitCode.GeneralError;
}
