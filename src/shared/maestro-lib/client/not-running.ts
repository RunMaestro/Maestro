/**
 * The one "no Maestro host is there" outcome: no discovery file, a discovery
 * file whose pid is gone, a socket that never opened, or one refused at the
 * network level. Thrown by the bridge connection (`bridge-connection.ts`) and
 * classified by every app-dependent `maestro-cli` verb with `instanceof`, never
 * by reading the message. `src/cli/services/maestro-not-running.ts` re-exports
 * it for the CLI.
 */

/** The one message every app-dependent verb prints when the desktop is absent. */
export const MAESTRO_NOT_RUNNING_MESSAGE = 'Maestro desktop app is not running or not reachable';

/**
 * What to do about it, for a person reading a terminal. Kept out of the message
 * itself, which is a documented contract (CLI-HEADLESS.md): the next step names
 * both hosts, the desktop app and the detached `maestro-cli host`.
 */
export const MAESTRO_NOT_RUNNING_HINT =
	'Start the desktop app, or run `maestro-cli host start` for a headless host.';

/** The JSON `code` that goes with {@link MAESTRO_NOT_RUNNING_MESSAGE}. */
export const MAESTRO_NOT_RUNNING_CODE = 'MAESTRO_NOT_RUNNING';

/** Why `connect()` decided the app is absent. Diagnostic only: never printed. */
export type MaestroNotRunningReason =
	| 'no-discovery-file'
	| 'stale-discovery-file'
	| 'connect-timeout'
	| 'connect-failed';

/**
 * Thrown by `connect()` when there is no desktop app to talk to: no discovery
 * file, a discovery file whose pid is gone, a socket that never opened, or one
 * refused at the network level.
 *
 * It is a TYPE so callers classify it with `instanceof` rather than by reading
 * the message. Four commands used to sniff English substrings of the old
 * per-cause messages, and each copy recognized a slightly different subset (none
 * knew the connect timeout). The message is fixed for the same reason: every
 * verb reports this one outcome the same way, and the cause rides `reason`.
 *
 * NOT thrown when the app answered and refused (an HTTP rejection of the
 * upgrade, such as the Web Login gate) or dropped the socket mid-command: the
 * app is running in both cases, and those keep their own errors.
 */
export class MaestroNotRunningError extends Error {
	readonly code = MAESTRO_NOT_RUNNING_CODE;
	readonly reason: MaestroNotRunningReason;
	readonly detail?: string;
	/** What to do about it ({@link MAESTRO_NOT_RUNNING_HINT}); for people, never matched on. */
	readonly hint = MAESTRO_NOT_RUNNING_HINT;
	constructor(reason: MaestroNotRunningReason, detail?: string) {
		super(MAESTRO_NOT_RUNNING_MESSAGE);
		this.name = 'MaestroNotRunningError';
		this.reason = reason;
		this.detail = detail;
	}
}
