/**
 * Worker thread entry for one SQLite integrity check. Started by
 * `checkSqliteIntegrity()` (sqlite-integrity.ts) with the task as
 * `workerData`; posts one reply and ends.
 *
 * Nothing here, or reachable from here, may import `electron`.
 */

import { parentPort, workerData } from 'worker_threads';

import {
	runSqliteIntegrityCheck,
	type SqliteIntegrityReply,
	type SqliteIntegrityTask,
} from './sqlite-integrity-task';

const port = parentPort;
if (!port) {
	throw new Error('sqlite-integrity-worker must be started as a worker thread');
}

let reply: SqliteIntegrityReply;
try {
	reply = { ok: true, result: runSqliteIntegrityCheck(workerData as SqliteIntegrityTask) };
} catch (error) {
	const code = (error as { code?: unknown } | null)?.code;
	reply = {
		ok: false,
		error: {
			message: error instanceof Error ? error.message : String(error),
			...(typeof code === 'string' ? { code } : {}),
		},
	};
}
port.postMessage(reply);
