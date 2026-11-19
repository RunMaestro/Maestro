/**
 * Run one SQLite task off the main process and keep the means to stop it.
 *
 * Shared by the integrity check (sqlite-integrity.ts) and Query mode
 * (sqlite-query.ts). Each run gets a CHILD PROCESS of its own
 * (sqlite-worker.ts), which opens its own read-only connection, so main only
 * ever sees the result. A process rather than a worker thread because
 * better-sqlite3 has no interrupt and V8 cannot terminate a thread while
 * SQLite runs native code: a "stopped" runaway statement on a thread would
 * keep a core busy, keep growing a sort, and keep its read lock on someone's
 * live database until the app quit. Killing a process always works.
 *
 * The child is this app's own binary run as Node (`ELECTRON_RUN_AS_NODE`,
 * the way the installed `maestro-cli` shim runs it), so it loads the same
 * better-sqlite3 build main does. Messages use the `advanced` serialization,
 * so a REAL `Infinity` survives the trip instead of arriving as `null`.
 *
 * A run stops, its child is killed, and its caller is rejected, when:
 *
 *   - its database is released (the tab closed, the idle reaper), through
 *     the handle's `releaseHooks`;
 *   - it outlives `timeoutMs`, when one is given;
 *   - the caller calls `stop()` (a Stop button, a newer run replacing it).
 *
 * Under vitest the sources are `.ts` and no compiled entry sits beside this
 * file, so the task runs inline there, on the calling thread, where it cannot
 * be interrupted: `stop()` still rejects the caller at once and the result is
 * dropped when it lands. The packaged and dev builds compile the entry with
 * the rest of the main process.
 */

import { fork, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

import type { OpenSqliteDatabase } from './sqlite-database';
import {
	runSqliteWorkerTask,
	sqliteWorkerError,
	type SqliteWorkerData,
	type SqliteWorkerKind,
	type SqliteWorkerReply,
	type SqliteWorkerTasks,
} from './sqlite-worker-task';

const WORKER_SCRIPT = path.join(__dirname, 'sqlite-worker.js');

/** Fork the child: this app's own binary run as Node, talking over advanced-serialization IPC. */
function forkWorker(): ChildProcess {
	return fork(WORKER_SCRIPT, [], {
		execPath: process.execPath,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		serialization: 'advanced',
		stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
	});
}

export interface SqliteWorkerRunOptions {
	/** The error a caller sees when the database is released mid-run. */
	closedMessage: string;
	/** Stop the run after this long, rejecting with `timeoutMessage`. */
	timeoutMs?: number;
	timeoutMessage?: string;
	/** What the run is called in an unexpected-exit error ("Integrity check"). */
	label: string;
}

/** One run in flight. */
export interface SqliteWorkerRun<R> {
	result: Promise<R>;
	/** Stop the run and reject its caller with `message`. Does nothing once settled. */
	stop: (message: string) => void;
}

/** The pieces of an open database a run needs: the path, and the hooks closing it runs. */
type RunDatabase = Pick<OpenSqliteDatabase, 'displayPath' | 'releaseHooks'>;

export function startSqliteWorkerTask<K extends SqliteWorkerKind>(
	database: RunDatabase,
	data: SqliteWorkerData<K>,
	options: SqliteWorkerRunOptions
): SqliteWorkerRun<SqliteWorkerTasks[K]['result']> {
	type Result = SqliteWorkerTasks[K]['result'];
	let child: ChildProcess | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let settled = false;
	let resolveRun!: (value: Result) => void;
	let rejectRun!: (error: Error) => void;
	const result = new Promise<Result>((resolve, reject) => {
		resolveRun = resolve;
		rejectRun = reject;
	});

	const settle = (finish: () => void) => {
		if (settled) return;
		settled = true;
		database.releaseHooks.delete(onRelease);
		if (timer) clearTimeout(timer);
		finish();
	};
	const stop = (message: string) => {
		settle(() => rejectRun(new Error(message)));
		child?.kill('SIGKILL');
	};
	function onRelease() {
		stop(options.closedMessage);
	}
	database.releaseHooks.add(onRelease);
	if (options.timeoutMs !== undefined) {
		timer = setTimeout(
			() => stop(options.timeoutMessage ?? `${options.label} timed out.`),
			options.timeoutMs
		);
	}

	if (existsSync(WORKER_SCRIPT)) {
		const started = forkWorker();
		child = started;
		started.once('message', (reply: SqliteWorkerReply<Result>) =>
			settle(() => {
				if (reply.ok) resolveRun(reply.result);
				else rejectRun(sqliteWorkerError(reply.error));
			})
		);
		started.once('error', (error) => settle(() => rejectRun(error)));
		started.once('exit', (code, signal) =>
			settle(() =>
				rejectRun(
					new Error(
						`${options.label} ended (${signal ? `signal ${signal}` : `exit code ${code}`}) without a result.`
					)
				)
			)
		);
		started.send(data);
	} else {
		void Promise.resolve()
			.then(() => runSqliteWorkerTask(data))
			.then(
				(value) => settle(() => resolveRun(value)),
				(error: unknown) =>
					settle(() => rejectRun(error instanceof Error ? error : new Error(String(error))))
			);
	}

	return { result, stop };
}
