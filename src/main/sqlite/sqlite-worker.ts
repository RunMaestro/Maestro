/**
 * Child process entry for one SQLite task: an integrity check, a Query-mode
 * run or export, or a backup (see sqlite-worker-task.ts). Forked by `startSqliteWorkerTask()`
 * (sqlite-worker-runner.ts), which sends the task as the first IPC message;
 * this answers with one reply and exits.
 *
 * A session (`startSqliteWorkerSession()`: Query mode's explicit transaction)
 * starts the same way and answers its opening, then each request in turn,
 * and exits once a reply says it is closed. If its parent goes away first,
 * the session is aborted (its connection closed, which rolls back) and the
 * child exits.
 *
 * A process, not a worker thread: better-sqlite3 has no interrupt, and a
 * thread cannot be terminated while SQLite runs native code, so a runaway
 * statement would keep its CPU and its read lock after "stop". A process can
 * always be killed.
 *
 * Nothing here, or reachable from here, may import `electron`.
 */

import {
	answerSqliteWorkerSession,
	isSqliteWorkerSessionData,
	openSqliteWorkerSession,
	runSqliteWorkerTask,
	sqliteWorkerFailure,
	type SqliteWorkerData,
	type SqliteWorkerReply,
	type SqliteWorkerSessionData,
	type SqliteWorkerSessionReply,
} from './sqlite-worker-task';

const send = process.send?.bind(process);
if (!send) {
	throw new Error('sqlite-worker must be started by startSqliteWorkerTask()');
}

/** Answer a session's opening, then each request, until a reply says it is closed. */
function serveSession(data: SqliteWorkerSessionData, reply: NonNullable<typeof send>): void {
	let opened: ReturnType<typeof openSqliteWorkerSession>;
	try {
		opened = openSqliteWorkerSession(data);
	} catch (error) {
		reply({ ...sqliteWorkerFailure(error), closed: true }, () => process.exit(0));
		return;
	}
	const { host } = opened;
	process.once('disconnect', () => {
		host.abort();
		process.exit(0);
	});
	process.on('message', (op: unknown) => {
		const answer = answerSqliteWorkerSession(host, op as never);
		reply(answer, () => {
			if (answer.closed) process.exit(0);
		});
	});
	reply({ ok: true, result: opened.opened, closed: false } satisfies SqliteWorkerSessionReply);
}

process.once('message', (data: SqliteWorkerData | SqliteWorkerSessionData) => {
	if (isSqliteWorkerSessionData(data)) {
		serveSession(data, send);
		return;
	}
	let reply: SqliteWorkerReply;
	try {
		reply = { ok: true, result: runSqliteWorkerTask(data) };
	} catch (error) {
		reply = sqliteWorkerFailure(error);
	}
	send(reply, () => process.exit(0));
});
