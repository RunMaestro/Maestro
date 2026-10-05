// The one "desktop app is absent" outcome every app-dependent CLI verb reports.
//
// Kept apart from the WebSocket client that throws it (`maestro-client.ts`
// re-exports all of it) for two reasons: the reporter in `session-command.ts`
// and the exit-code map can classify it without importing the client, and the
// many tests that replace `maestro-client` with a factory mock still see the
// real class, so `instanceof` keeps working under the mock.

/** The one message every app-dependent verb prints when the desktop is absent. */
export const MAESTRO_NOT_RUNNING_MESSAGE = 'Maestro desktop app is not running or not reachable';

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
	constructor(reason: MaestroNotRunningReason, detail?: string) {
		super(MAESTRO_NOT_RUNNING_MESSAGE);
		this.name = 'MaestroNotRunningError';
		this.reason = reason;
		this.detail = detail;
	}
}
