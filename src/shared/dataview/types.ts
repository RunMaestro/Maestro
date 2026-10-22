/**
 * The Dataview wire types (D2): what a query result looks like when it crosses IPC, the WS bridge,
 * or `maestro-cli --json`, and the index contract the query engine runs against.
 *
 * A result is plain JSON. Every value inside it went through `toWireValue()` (`./wire.ts`), which
 * uses upstream's `Transferable` codec for dates, durations, and links, so `reviveDataviewResult()`
 * on the other side turns them back into luxon `DateTime` and `Duration` and Dataview `Link` values.
 */

import type { FullIndex } from './vendor/data-index/index';
import type { IdentifierMeaning } from './vendor/query/engine';
import type { Literal } from './vendor/data-model/value';

/**
 * What the vendored engine reads from an index. DATAVIEW-05 asked for a narrow reader with
 * `getPage`, `pagesForSource`, and `resolveLink`; the vendored engine, source resolver, and
 * `PageMetadata.serialize` read the 9 members of upstream's `FullIndex` contract instead, so the
 * reader IS that contract (DEV-3 in docs/agent-guides/DATAVIEW.md). `VaultIndex` implements it in
 * main and adds the three methods as conveniences.
 */
export type DataviewIndexReader = FullIndex;

/** Where a row id came from: a page path, or a `GROUP BY` key (nested once per group step). */
export type DataviewIdMeaning = IdentifierMeaning;

/** A JSON value. Dates, durations, links, and widgets inside it carry a type tag (see `./wire.ts`). */
export type DataviewWireValue =
	| null
	| boolean
	| number
	| string
	| DataviewWireValue[]
	| { [key: string]: DataviewWireValue };

/**
 * Tasks as a `TASK` query returns them: a flat list, or one level of `{ key, rows }` per `GROUP BY`.
 * Each task is the task's own serialized fields (`text`, `line`, `status`, `completed`, `children`,
 * ...), without the page fields the engine copies onto it for `WHERE` and `SORT`.
 */
export type DataviewTaskGroups<V> = V[] | { key: V; rows: DataviewTaskGroups<V> }[];

interface DataviewRowsResultBase {
	/**
	 * Rows the engine skipped because an expression failed on them (upstream drops those rows
	 * silently). One line per query step that skipped any. Empty when nothing was skipped.
	 */
	warnings: string[];
	idMeaning: DataviewIdMeaning;
}

export interface DataviewTableResult<V = DataviewWireValue> extends DataviewRowsResultBase {
	kind: 'table';
	/** Column names; the id column (`File`, or the group name) comes first unless `WITHOUT ID`. */
	headers: string[];
	rows: V[][];
}

export interface DataviewListResult<V = DataviewWireValue> extends DataviewRowsResultBase {
	kind: 'list';
	/** One per row: the id, the formatted value, or a list-pair widget (`id: value`). */
	items: V[];
}

export interface DataviewTaskResult<V = DataviewWireValue> extends DataviewRowsResultBase {
	kind: 'task';
	groups: DataviewTaskGroups<V>;
}

/** A query type Maestro parses but does not render (`CALENDAR`, DV-1). */
export interface DataviewUnsupportedResult {
	kind: 'unsupported';
	feature: 'CALENDAR';
}

/** A parse or execution error, with Dataview's own text (DV-9). */
export interface DataviewErrorResult {
	kind: 'error';
	message: string;
	/** For a parse error: the 1-based line of the query source the parser stopped on. */
	line?: number;
}

/** The result of one `dataview` block. `V` is the wire form until `reviveDataviewResult()` runs. */
export type DataviewResult<V = DataviewWireValue> =
	| DataviewTableResult<V>
	| DataviewListResult<V>
	| DataviewTaskResult<V>
	| DataviewUnsupportedResult
	| DataviewErrorResult;

/** The same result with Dataview values (dates, durations, links, widgets) restored. */
export type RevivedDataviewResult = DataviewResult<Literal>;

/** The value of one inline `` `= expr` ``. */
export interface DataviewValueResult<V = DataviewWireValue> {
	kind: 'value';
	value: V;
}

/** The result of one inline `` `= expr` ``. */
export type DataviewInlineResult<V = DataviewWireValue> =
	| DataviewValueResult<V>
	| DataviewErrorResult;

export type RevivedDataviewInlineResult = DataviewInlineResult<Literal>;

/** Run one `dataview` block (`dataview:query`). Main resolves the vault root and SSH from the agent. */
export interface DataviewQueryRequest {
	/** Absolute path of the note that holds the block. It binds `this`. */
	filePath: string;
	/** The block's DQL source. */
	source: string;
	/** The agent the note belongs to: its cwd is the fallback root (DV-4), its SSH remote the host (DV-6). */
	agentId: string;
}

/** Evaluate one inline `` `= expr` `` (`dataview:queryInline`). */
export interface DataviewInlineQueryRequest {
	filePath: string;
	/** The expression, with or without its leading `=`. */
	expression: string;
	agentId: string;
}

/**
 * A query answer with the index state it was computed from. A consumer re-runs it when a
 * `dataview:changed` event names the same `root` and `sshRemoteId` with a newer `revision` (DV-7).
 */
export interface DataviewQueryResponse<R = DataviewResult> {
	/** The vault root the query ran against, as main spells it. */
	root: string;
	sshRemoteId: string | null;
	/** The index revision the query read. Revisions only go up per root. */
	revision: number;
	/** The note's vault-relative POSIX path, the one `this` was bound to. */
	path: string;
	result: R;
}

/** How changes reach an open index: a local watcher, the remote poll, or nothing yet. */
export type DataviewWatchMode = 'chokidar' | 'poll' | 'none';

/** What `dataview:status` reports about one open root. */
export interface DataviewIndexStatus {
	root: string;
	sshRemoteId: string | null;
	pageCount: number;
	revision: number;
	/** Duration of the last full scan (a reconcile), or null before the first one finished. */
	lastScanDurationMs: number | null;
	lastScanAt: number | null;
	/** Whether the index was served from the disk cache when it opened. */
	cacheHit: boolean;
	watchMode: DataviewWatchMode;
}

/**
 * Which roots `dataview:status` reports: one root, or every open root. `agentId` names the SSH remote
 * the root lives on (a local root when omitted).
 */
export interface DataviewStatusRequest {
	root?: string;
	agentId?: string;
}

/** Drop one root's cache and index it again (`dataview:rebuild`). */
export interface DataviewRebuildRequest {
	/** Absolute path of the vault root. */
	root: string;
	/** The agent whose SSH remote holds the root; a local root when omitted. */
	agentId?: string;
}

/** One index change (`dataview:changed`), tagged with the root it belongs to (DV-7). */
export interface DataviewChangeEvent {
	root: string;
	sshRemoteId: string | null;
	revision: number;
	/** Vault-relative POSIX paths of every page set, removed, relinked, or (un)starred. */
	changedPaths: string[];
}

/**
 * Run the `dataview` blocks of a note (`maestro-cli dataview query`). Main reads the note through the
 * vault's own file system, so a note on an SSH remote works the same as a local one.
 */
export interface DataviewFileQueryRequest {
	filePath: string;
	agentId: string;
	/** 1-based position among the note's `dataview` fences (`dataviewjs` fences are not counted). Every block when omitted. */
	block?: number;
}

/** One fence of a note and what it rendered to. */
export interface DataviewFileBlock<V = DataviewWireValue> {
	language: 'dataview' | 'dataviewjs';
	/** 1-based position among the note's `dataview` fences; null for a `dataviewjs` fence. */
	block: number | null;
	/** 1-based line of the opening fence. */
	line: number;
	source: string;
	/** The block's result. Absent for a `dataviewjs` fence: DataviewJS renders in the desktop app only. */
	result?: DataviewResult<V>;
}

/** The blocks of one note, or an error result when the note sits outside its vault root. */
export type DataviewFileQueryResult<V = DataviewWireValue> =
	| {
			kind: 'blocks';
			/** How many `dataview` fences the note holds, whichever were run. */
			blockCount: number;
			blocks: DataviewFileBlock<V>[];
	  }
	| DataviewErrorResult;

/**
 * The index as a DataviewJS run sees it (`dataview:jsSnapshot`, D4). Main refuses it unless DataviewJS is on
 * and the note's vault root is trusted.
 */
export interface DataviewJsSnapshotRequest {
	/** Absolute path of the note that holds the `dataviewjs` block. It binds `dv.current()`. */
	filePath: string;
	agentId: string;
}

/**
 * Read one text file inside the vault root of a note (`dataview:readInRoot`): `dv.io.load`, and through it
 * `dv.io.csv` and `dv.view` (D4, D5). Main resolves the root itself, refuses a path that leaves it (also
 * through a symlink) or that the index does not hold, and refuses unless DataviewJS is on and the root trusted.
 */
export interface DataviewReadInRootRequest {
	/** Absolute path of the note the script runs in. Its vault root bounds the read. */
	filePath: string;
	agentId: string;
	/** Vault-relative POSIX path of the file to read. */
	path: string;
}

/** The answer to `dataview:readInRoot`. */
export interface DataviewReadInRootResponse {
	root: string;
	sshRemoteId: string | null;
	/** The path read, normalized. */
	path: string;
	/** The file's text, or null when no such file exists (upstream `dv.io.load` answers undefined). */
	text: string | null;
}

/**
 * The vault root of a note that holds a `dataviewjs` block (`dataview:jsRoot`), and the grant of "Run once"
 * (`dataview:jsRunOnce`, D3). Both take the note, like `DataviewJsSnapshotRequest`, and main resolves the
 * root itself.
 */
export type DataviewJsRootRequest = DataviewJsSnapshotRequest;

/** A note's vault root as main spells it, the spelling the trust list compares (`isTrustedDataviewRoot`). */
export interface DataviewJsRoot {
	root: string;
	sshRemoteId: string | null;
}

/** Add a vault root to `dataviewJsTrustedRoots`, or take it off (`dataview:trust`, `dataview:untrust`, D8). */
export interface DataviewTrustRequest {
	/** An absolute path. It is normalized with `normalizeTrustedRoot()` before it is stored. */
	root: string;
}

/** The answer to a trust edit. */
export interface DataviewTrustResponse {
	/** The root as stored and compared. */
	root: string;
	/** Whether the root is trusted now. */
	trusted: boolean;
	/** False when the list already said so and nothing was written. */
	changed: boolean;
	/** The whole trust list after the edit. */
	roots: string[];
}

/**
 * The actions of the `dataview_command` WS message (`maestro-cli dataview`), one per DataviewService
 * request method. The request's fields travel as the message's own fields. The trust actions answer CLI
 * connections only.
 */
export type DataviewCommandAction =
	| 'query'
	| 'queryInline'
	| 'queryFile'
	| 'status'
	| 'rebuild'
	| 'trust'
	| 'untrust'
	| 'trusted';
