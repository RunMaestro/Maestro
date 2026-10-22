// The one "desktop app is absent" outcome every app-dependent CLI verb reports.
//
// The class lives in the library (`maestro-lib/client/not-running.ts`) beside
// the bridge connection that throws it. It is re-exported here, apart from the
// client facade (`maestro-client.ts`), for two reasons: the reporter in
// `session-command.ts` and the exit-code map can classify it without importing
// the client, and the many tests that replace `maestro-client` with a factory
// mock still see the real class, so `instanceof` keeps working under the mock.

export {
	MAESTRO_NOT_RUNNING_CODE,
	MAESTRO_NOT_RUNNING_HINT,
	MAESTRO_NOT_RUNNING_MESSAGE,
	MaestroNotRunningError,
	type MaestroNotRunningReason,
} from '../../shared/maestro-lib/client/not-running';
