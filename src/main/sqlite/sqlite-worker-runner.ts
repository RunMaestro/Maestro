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
 * A SESSION (`startSqliteWorkerSession()`: Query mode's explicit transaction)
 * keeps its child across requests instead: it answers its opening, then one
 * request at a time, each with its own timeout, until a reply says it is
 * closed. Stopping it kills the child, which ends whatever it held (a killed
 * transaction is rolled back by SQLite's journal).
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
	answerSqliteWorkerSession,
	openSqliteWorkerSession,
	runSqliteWorkerTask,
	sqliteWorkerError,
	sqliteWorkerFailure,
	type SqliteWorkerData,
	type SqliteWorkerKind,
	type SqliteWorkerReply,
	type SqliteWorkerSessionData,
	type SqliteWorkerSessionKind,
	type SqliteWorkerSessionOpened,
	type SqliteWorkerSessionReply,
	type SqliteWorkerSessions,
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

/** What a session runs with, beside what a single run takes. */
export interface SqliteWorkerSessionOptions {
	/** The error a caller sees when the database is released mid-session. */
	closedMessage: string;
	/** What the session is called in an unexpected-exit error ("The transaction"). */
	label: string;
	/**
	 * Runs once when the session ends, however it ends: with no error and the
	 * child's last reply when the child closed it (`closed`), else with the
	 * error that ended it (a stop, the database released, the child gone).
	 * Runs before the caller of the closing request hears its reply.
	 */
	onEnd: (error: Error | null, reply: SqliteWorkerSessionReply | null) => void;
}

/** One SQLite session in flight: its opening, then one request at a time. */
export interface SqliteWorkerSession<K extends SqliteWorkerSessionKind> {
	/** What opening it answered; rejects when it could not open. */
	opened: Promise<SqliteWorkerSessions[K]['opened']>;
	/**
	 * Send one request; resolves its reply. Refused while another is in
	 * flight or once the session ended. The caller times it: `stop()` ends
	 * the whole session, the only way to stop a request.
	 */
	request(op: SqliteWorkerSessions[K]['op']): Promise<SqliteWorkerSessions[K]['result']>;
	/** Whether a request (or the opening) is in flight. */
	readonly busy: boolean;
	/** Stop it: kill the child, reject what is in flight with `message`. Does nothing once ended. */
	stop(message: string): void;
}

/**
 * Start one session in a child process of its own (see the module comment).
 * The child stays until a reply says the session closed, or it is stopped.
 */
export function startSqliteWorkerSession<K extends SqliteWorkerSessionKind>(
	database: RunDatabase,
	data: SqliteWorkerSessionData<K>,
	options: SqliteWorkerSessionOptions
): SqliteWorkerSession<K> {
	type Sessions = SqliteWorkerSessions[K];
	let child: ChildProcess | null = null;
	let inline: SqliteWorkerSessionOpened<K>['host'] | null = null;
	let ended = false;
	/** The reply awaited now: the opening's, then each request's. */
	let pending: {
		resolve: (reply: SqliteWorkerSessionReply) => void;
		reject: (error: Error) => void;
	} | null = null;

	const end = (error: Error | null, reply: SqliteWorkerSessionReply | null) => {
		if (ended) return;
		ended = true;
		database.releaseHooks.delete(onRelease);
		const waiting = pending;
		pending = null;
		options.onEnd(error, reply);
		if (error) waiting?.reject(error);
	};
	const stop = (message: string) => {
		if (ended) return;
		end(new Error(message), null);
		child?.kill('SIGKILL');
		inline?.abort();
	};
	function onRelease() {
		stop(options.closedMessage);
	}
	database.releaseHooks.add(onRelease);

	/** Settle the request in flight with `reply`; a closed session ends first. */
	const deliver = (reply: SqliteWorkerSessionReply) => {
		if (ended) return;
		const waiting = pending;
		pending = null;
		if (reply.closed) end(null, reply);
		waiting?.resolve(reply);
	};
	const awaitReply = () =>
		new Promise<SqliteWorkerSessionReply>((resolve, reject) => {
			pending = { resolve, reject };
		});
	const unwrap = <R>(reply: SqliteWorkerSessionReply): R => {
		if (reply.ok) return reply.result as R;
		throw sqliteWorkerError(reply.error);
	};

	let opened: Promise<Sessions['opened']>;
	if (existsSync(WORKER_SCRIPT)) {
		const started = forkWorker();
		child = started;
		started.on('message', (reply: SqliteWorkerSessionReply) => deliver(reply));
		started.once('error', (error) => end(error, null));
		started.once('exit', (code, signal) =>
			end(
				new Error(
					`${options.label} ended (${signal ? `signal ${signal}` : `exit code ${code}`}) without a result.`
				),
				null
			)
		);
		opened = awaitReply().then((reply) => unwrap<Sessions['opened']>(reply));
		started.send(data);
	} else {
		opened = awaitReply().then((reply) => unwrap<Sessions['opened']>(reply));
		void Promise.resolve().then(() => {
			if (ended) return;
			let reply: SqliteWorkerSessionReply;
			try {
				const session = openSqliteWorkerSession(data);
				inline = session.host;
				reply = { ok: true, result: session.opened, closed: false };
			} catch (error) {
				reply = { ...sqliteWorkerFailure(error), closed: true };
			}
			deliver(reply);
		});
	}

	return {
		opened,
		get busy() {
			return pending !== null;
		},
		request(op) {
			if (ended) return Promise.reject(new Error(`${options.label} has ended.`));
			if (pending) return Promise.reject(new Error(`${options.label} is still answering.`));
			const reply = awaitReply();
			if (child) {
				child.send(op);
			} else {
				void Promise.resolve().then(() => {
					if (ended || !inline) return;
					deliver(answerSqliteWorkerSession(inline, op));
				});
			}
			return reply.then((answer) => unwrap<Sessions['result']>(answer));
		},
		stop,
	};
}
