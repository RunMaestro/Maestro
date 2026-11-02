/**
 * Messages between a root's `DataviewQueryRunner` (main) and its query worker (`dataview-query-worker.ts`).
 * The worker keeps a mirror of the root's `VaultIndex` and runs DQL against it, so a slow query (a
 * catastrophic `regexmatch`, a `FLATTEN` over a large vault) never blocks the main thread, and the runner
 * can stop it by terminating the worker.
 *
 * Updates travel as `begin`, any number of `pages`, then `end`; the worker answers `applied` with the
 * commit sequence it reached. The runner sends nothing else while an update or a query is in flight, so
 * the worker never interleaves two jobs and a query's watchdog measures only that query.
 *
 * Electron-free: the worker imports it.
 */

import type { DataviewInlineResult, DataviewResult } from '../../shared/dataview';

/** One page as the mirror receives it: its cached raw parse, in the `Transferable` form the cache keeps. */
export interface QueryMirrorPage {
	path: string;
	data: unknown;
}

/** The vault file set, every file (any extension) and every folder. */
export interface QueryMirrorPaths {
	files: string[];
	folders: string[];
}

/** One query a worker runs: a `dataview` block, or an inline `` `= expr` ``. */
export type QueryWorkerQuery =
	| { kind: 'dql'; source: string; thisPath: string }
	| { kind: 'inline'; expression: string; thisPath: string };

export type QueryWorkerRequest =
	| {
			type: 'begin';
			/** Start from an empty mirror (the first sync, or after a restart). */
			reset: boolean;
			seq: number;
			revision: number;
			/** The new file set, when it changed (always on a reset). */
			paths?: QueryMirrorPaths;
			removed: string[];
			stars: string[];
	  }
	| { type: 'pages'; pages: QueryMirrorPage[] }
	| { type: 'end' }
	| { type: 'query'; id: number; query: QueryWorkerQuery }
	/** The answer to a `read`: the file's text, or why it could not be read. */
	| { type: 'readResult'; id: number; text: string }
	| { type: 'readResult'; id: number; error: string };

export type QueryWorkerResponse =
	| { type: 'applied'; seq: number }
	| { type: 'result'; id: number; result: DataviewResult | DataviewInlineResult }
	/** A CSV source asks main for a vault file (the worker has no file access of its own). */
	| { type: 'read'; id: number; path: string };
