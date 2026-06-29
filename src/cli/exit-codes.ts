// Standardized process exit codes for maestro-cli.
//
// Scripts and CI can branch on these instead of treating every failure as a
// generic non-zero. Keep the set small and stable - each value names a class of
// failure, not a specific message. New code should prefer these over a bare
// `process.exit(1)`; existing call sites are migrated opportunistically.

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
}

/** Exit the process with a typed code. Never returns. */
export function exitWith(code: ExitCode): never {
	return process.exit(code);
}
