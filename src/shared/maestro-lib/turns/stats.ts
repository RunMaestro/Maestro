/**
 * Recording a turn, or an Auto Run, in `stats.db`, the database the Usage Dashboard reads, so work
 * done in the TUI is counted next to work done in the desktop.
 *
 * The row is the desktop's own: one `query_events` row per turn, bound by the shared
 * `bindQueryEvent` over `INSERT_QUERY_EVENT_SQL`, with the shared id format. What differs is
 * who owns the file. The desktop's `StatsDB` creates it, migrates it, backs it up and checks
 * its integrity; a recorder that did any of that would race it. So this one only INSERTS into
 * a database that already exists with the columns it writes, and every other case is a
 * skipped row, never a failed turn:
 *
 * - `disabled`: the user turned usage statistics off (`statsCollectionEnabled`).
 * - `no-database`: `stats.db` does not exist yet. The desktop creates it on its first launch.
 * - `unavailable`: the native SQLite module will not load in this runtime (plain Node with
 *   an Electron-built `better-sqlite3`). The loader's message says how to fix it.
 * - `schema`: the file is older than this build's row. The desktop migrates it on its next
 *   launch.
 * - `failed`: the insert threw.
 *
 * Each reason is logged once per recorder, so a TUI session on a machine without the module
 * says so once rather than on every turn.
 *
 * The library does not import `better-sqlite3` or the CLI's loader (`loadBetterSqlite3`);
 * the host passes a loader in. Any throw from it counts as unavailable.
 */

import * as fs from 'fs';

import type { AutoRunSession, AutoRunTask, QueryEvent } from '../../stats-types';
import { readStoreDocument } from '../store/io';
import { logger } from '../host';
import type { DataDirVerdict } from '../runtime/data-dir-lock';
import type { MaestroPaths } from '../paths/resolve';
import {
	AUTO_RUN_SESSION_COLUMNS,
	AUTO_RUN_TASK_COLUMNS,
	INSERT_AUTO_RUN_SESSION_SQL,
	INSERT_AUTO_RUN_TASK_SQL,
	UPDATE_AUTO_RUN_END_SQL,
	bindAutoRunSession,
	bindAutoRunTask,
} from '../stats/auto-run-insert';
import {
	INSERT_QUERY_EVENT_SQL,
	QUERY_EVENT_COLUMNS,
	bindQueryEvent,
} from '../stats/query-event-insert';
import { generateId } from '../stats/utils';

const LOG_CONTEXT = '[StatsRecorder]';

/** The part of a `better-sqlite3` connection the recorder uses. */
export interface StatsConnection {
	pragma(source: string): unknown;
	prepare(sql: string): { run(...params: unknown[]): unknown };
	close(): unknown;
}

/** The part of the `better-sqlite3` constructor the recorder uses. */
export type StatsConnectionConstructor = new (
	filename: string,
	options?: { fileMustExist?: boolean; timeout?: number }
) => StatsConnection;

export type StatsRecordResult =
	| { ok: true; id: string }
	| {
			ok: false;
			reason: 'disabled' | 'no-database' | 'unavailable' | 'schema' | 'fenced' | 'failed';
			message: string;
	  };

export interface StatsRecorderOptions {
	paths: Pick<MaestroPaths, 'statsFile'>;
	/** The host's `better-sqlite3` loader. It throws when the native module cannot load here. */
	loadSqlite: () => StatsConnectionConstructor;
	/** The user's `statsCollectionEnabled` setting, read fresh. Default: on. */
	isEnabled?: () => boolean | Promise<boolean>;
	/** Is this process still the data directory's writer? Default: always. */
	fence?: () => DataDirVerdict;
}

/**
 * The user's `statsCollectionEnabled` setting, read fresh: the gate the desktop's stats writers use,
 * so usage is collected unless it was explicitly turned off.
 */
export async function readStatsCollectionEnabled(settingsFile: string): Promise<boolean> {
	const read = await readStoreDocument<Record<string, unknown>>(settingsFile);
	return read.status !== 'ok' || read.data.statsCollectionEnabled !== false;
}

export interface StatsRecorder {
	/** Insert one `query_events` row. Never throws. */
	recordQuery(event: Omit<QueryEvent, 'id'>): Promise<StatsRecordResult>;
	/** Insert one `auto_run_sessions` row, the start of a run. `id` is the run's handle. Never throws. */
	startAutoRun(session: Omit<AutoRunSession, 'id'>): Promise<StatsRecordResult>;
	/** Insert one `auto_run_tasks` row for the run `task.autoRunSessionId` names. Never throws. */
	recordAutoTask(task: Omit<AutoRunTask, 'id'>): Promise<StatsRecordResult>;
	/** Close a run: its duration and the tasks it finished. Never throws. */
	endAutoRun(id: string, duration: number, tasksCompleted: number): Promise<StatsRecordResult>;
}

/** How long a writer waits on the desktop's lock before giving up, ms. */
const BUSY_TIMEOUT_MS = 5000;

export function createStatsRecorder(options: StatsRecorderOptions): StatsRecorder {
	const logged = new Set<string>();

	/** A skipped row, logged the first time its reason comes up. */
	function skipped(
		reason: Exclude<StatsRecordResult, { ok: true }>['reason'],
		message: string
	): StatsRecordResult {
		if (!logged.has(reason)) {
			logged.add(reason);
			logger.warn(message, LOG_CONTEXT);
		}
		return { ok: false, reason, message };
	}

	/**
	 * Open the desktop's database for one write, check it has the columns this build writes, run
	 * `write`, and close it. Every way this can not happen is a skipped row, never a throw.
	 */
	async function withDatabase(
		table: string,
		columns: readonly string[],
		write: (db: StatsConnection) => string
	): Promise<StatsRecordResult> {
		if (options.isEnabled && !(await options.isEnabled())) {
			return { ok: false, reason: 'disabled', message: 'Usage statistics are turned off.' };
		}
		const verdict = options.fence?.();
		if (verdict && !verdict.ok) return { ok: false, reason: 'fenced', message: verdict.reason };

		const file = options.paths.statsFile;
		if (!fs.existsSync(file)) {
			return skipped(
				'no-database',
				`${file} does not exist yet, so this work is not in the Usage Dashboard. The desktop creates it on its first launch.`
			);
		}

		let Database: StatsConnectionConstructor;
		try {
			Database = options.loadSqlite();
		} catch (error) {
			return skipped('unavailable', error instanceof Error ? error.message : String(error));
		}

		let db: StatsConnection | undefined;
		try {
			db = new Database(file, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
			db.pragma('journal_mode = WAL');
			db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

			const present = new Set(
				(db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name)
			);
			const missing = columns.filter((column) => !present.has(column));
			if (missing.length > 0) {
				return skipped(
					'schema',
					`${file} has no ${missing.join(', ')} in ${table}: it predates this build. Open the desktop once so it can migrate the file.`
				);
			}

			return { ok: true, id: write(db) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to record in ${file}: ${message}`, LOG_CONTEXT);
			return { ok: false, reason: 'failed', message };
		} finally {
			try {
				db?.close();
			} catch (error) {
				logger.debug(`Closing ${file} failed: ${String(error)}`, LOG_CONTEXT);
			}
		}
	}

	return {
		recordQuery: (event) =>
			withDatabase('query_events', QUERY_EVENT_COLUMNS, (db) => {
				const id = generateId();
				db.prepare(INSERT_QUERY_EVENT_SQL).run(...bindQueryEvent(id, event));
				return id;
			}),
		startAutoRun: (session) =>
			withDatabase('auto_run_sessions', AUTO_RUN_SESSION_COLUMNS, (db) => {
				const id = generateId();
				db.prepare(INSERT_AUTO_RUN_SESSION_SQL).run(...bindAutoRunSession(id, session));
				return id;
			}),
		recordAutoTask: (task) =>
			withDatabase('auto_run_tasks', AUTO_RUN_TASK_COLUMNS, (db) => {
				const id = generateId();
				db.prepare(INSERT_AUTO_RUN_TASK_SQL).run(...bindAutoRunTask(id, task));
				return id;
			}),
		endAutoRun: (id, duration, tasksCompleted) =>
			withDatabase('auto_run_sessions', AUTO_RUN_SESSION_COLUMNS, (db) => {
				db.prepare(UPDATE_AUTO_RUN_END_SQL).run(duration, tasksCompleted, id);
				return id;
			}),
	};
}
