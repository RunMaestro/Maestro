/**
 * Child process entry for one SQLite task: an integrity check, a Query-mode
 * run or export, or a backup (see sqlite-worker-task.ts). Forked by `startSqliteWorkerTask()`
 * (sqlite-worker-runner.ts), which sends the task as the first IPC message;
 * this answers with one reply and exits.
 *
 * A process, not a worker thread: better-sqlite3 has no interrupt, and a
 * thread cannot be terminated while SQLite runs native code, so a runaway
 * statement would keep its CPU and its read lock after "stop". A process can
 * always be killed.
 *
 * Nothing here, or reachable from here, may import `electron`.
 */

import {
	runSqliteWorkerTask,
	sqliteWorkerFailure,
	type SqliteWorkerData,
	type SqliteWorkerReply,
} from './sqlite-worker-task';

const send = process.send?.bind(process);
if (!send) {
	throw new Error('sqlite-worker must be started by startSqliteWorkerTask()');
}

process.once('message', (data: SqliteWorkerData) => {
	let reply: SqliteWorkerReply;
	try {
		reply = { ok: true, result: runSqliteWorkerTask(data) };
	} catch (error) {
		reply = sqliteWorkerFailure(error);
	}
	send(reply, () => process.exit(0));
});
