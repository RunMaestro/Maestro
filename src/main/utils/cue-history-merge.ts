/**
 * Cue-into-History merge helpers
 *
 * Cue runs stopped being written to the agent's JSONL history file in
 * CUE-HISTORY-02; they now live only in `cue_events` and are read back as
 * `HistoryEntry` rows by `getCueHistoryEntries()` in
 * `src/main/cue/stats/cue-stats-query.ts`.
 *
 * Two handlers have to fold those rows back into a history list - the History
 * panel (`ipc/handlers/history.ts`) and Director's Notes
 * (`ipc/handlers/director-notes.ts`) - and they must agree on every part of it:
 * which agents are in scope, how a database failure degrades, and which rows
 * the JSONL file already carries. This module is that shared half, so the two
 * surfaces cannot drift into showing different Cue activity for the same runs.
 *
 * Every query is passed in rather than imported. Both callers inject it for the
 * same reason: a static edge from a history handler to the Cue SQLite layer
 * would drag `better-sqlite3` (a native binding built for Electron's ABI) into
 * every consumer of these modules.
 */

import type { CueHistoryGroup, HistoryEntry } from '../../shared/types';
import { sortEntriesByTimestamp } from '../../shared/history';
import { logger } from './logger';
import { captureException } from './sentry';
import type {
	CueHistoryBucket,
	CueHistoryBucketQuery,
	CueHistoryGroupRunsQuery,
	CueHistoryQuery,
} from '../cue/stats/cue-stats-query';

const LOG_CONTEXT = '[CueHistory]';

/** Cue runs for one agent, shaped as history rows. */
export type CueHistoryEntriesQuery = (query: CueHistoryQuery) => HistoryEntry[];
/** One agent's Cue runs collapsed to one row per pipeline-level trigger. */
export type CueHistoryGroupsQuery = (query: CueHistoryQuery) => CueHistoryGroup[];
/** The individual runs behind one collapsed group, newest first. */
export type CueHistoryGroupRunsQueryFn = (query: CueHistoryGroupRunsQuery) => HistoryEntry[];
/** Per-minute Cue run counts for the activity graph. */
export type CueHistoryBucketsQuery = (query: CueHistoryBucketQuery) => CueHistoryBucket[];
/** Change-detector for the activity-graph cache key. */
export type CueHistoryFingerprintQuery = (sessionId?: string) => string;

/**
 * The agent metadata a Cue history query needs, resolved from the sessions
 * store. `cue_events` knows which agent ran a job but not where that agent
 * points or what it is called today, so the caller supplies both.
 */
export interface CueScopeAgent {
	id: string;
	name?: string;
	projectPath?: string;
}

/** Read a string field off a loosely-typed session record. */
export function sessionField(
	record: Record<string, unknown> | undefined,
	key: string
): string | undefined {
	const value = record?.[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Where an agent's work happens, as the sessions store spells it. */
function recordProjectPath(record: Record<string, unknown> | undefined): string | undefined {
	return sessionField(record, 'projectRoot') ?? sessionField(record, 'cwd');
}

/** One agent's Cue scope, for a read that already knows the agent id. */
export function cueScopeAgentFromRecord(
	id: string,
	record: Record<string, unknown> | undefined,
	fallbackProjectPath?: string
): CueScopeAgent {
	return {
		id,
		name: sessionField(record, 'name'),
		projectPath: recordProjectPath(record) ?? fallbackProjectPath,
	};
}

/**
 * Every agent whose Cue runs belong in a project-wide or fleet-wide read.
 *
 * Walks the sessions store because an agent's directory lives there, not on the
 * `cue_events` row. `projectPath` narrows to one project; omit it for "every
 * agent".
 */
export function cueScopeAgentsFromRecords(
	records: Array<Record<string, unknown>>,
	projectPath?: string
): CueScopeAgent[] {
	const agents: CueScopeAgent[] = [];
	for (const record of records) {
		const id = sessionField(record, 'id');
		if (!id) continue;
		const dir = recordProjectPath(record);
		if (projectPath && dir !== projectPath) continue;
		agents.push({ id, name: sessionField(record, 'name'), projectPath: dir });
	}
	return agents;
}

/**
 * Cue runs for the agents in scope, as history rows.
 *
 * A DB failure here degrades to "no Cue rows" rather than failing the whole
 * read: the JSONL half of a user's history must stay readable even when the
 * Cue database is missing, locked, or was never initialized.
 */
export function readCueEntries(
	query: CueHistoryEntriesQuery | undefined,
	agents: CueScopeAgent[],
	options: { since?: number; limit?: number } = {}
): HistoryEntry[] {
	if (!query || agents.length === 0) return [];

	const entries: HistoryEntry[] = [];
	for (const agent of agents) {
		try {
			entries.push(
				...query({
					sessionId: agent.id,
					sessionName: agent.name,
					projectPath: agent.projectPath,
					since: options.since,
					limit: options.limit,
				})
			);
		} catch (error) {
			void captureException(error);
			logger.warn(`Failed to read Cue history for session ${agent.id}: ${error}`, LOG_CONTEXT);
		}
	}
	return entries;
}

/**
 * A collapsed group of Cue runs, as the single History row that stands for it.
 *
 * The row IS the group's newest run - the panel's detail modal, keyboard
 * navigation and jump-to-session all keep operating on a real entry - with the
 * count and failure tally hung off it in `cueGroup`.
 *
 * A group of ONE run is returned unchanged. "lint-on-save - 1 run" is strictly
 * worse than the run's own summary, and it would put an expander on a row with
 * nothing behind it.
 */
export function cueGroupToHistoryEntry(group: CueHistoryGroup): HistoryEntry {
	if (group.runCount <= 1) return group.latestEntry;
	return {
		...group.latestEntry,
		cueGroup: {
			key: group.key,
			label: group.label,
			runCount: group.runCount,
			failureCount: group.failureCount,
		},
	};
}

/**
 * Cue runs for the agents in scope, COLLAPSED to one row per pipeline-level
 * trigger. The grouped counterpart of {@link readCueEntries}, degrading the
 * same way on a database failure.
 *
 * Note what this path deliberately does NOT do: it never runs
 * {@link dropCueRowsAlreadyInJsonl}. That suppressor works run-by-run, and a
 * group cannot give up one of its runs without lying about its count. So for
 * the shrinking set of runs recorded while BOTH writers were live (before the
 * JSONL Cue writes were removed in CUE-HISTORY-02), the legacy JSONL row still
 * renders beside the group that also counts it. That is the deliberate trade:
 * the alternative - hiding JSONL Cue rows whose trigger matches a group - would
 * erase runs that have since aged out of the Cue retention window, where the
 * JSONL entry is the only surviving record.
 */
export function readCueGroupedEntries(
	query: CueHistoryGroupsQuery | undefined,
	agents: CueScopeAgent[],
	options: { since?: number; limit?: number } = {}
): HistoryEntry[] {
	if (!query || agents.length === 0) return [];

	const entries: HistoryEntry[] = [];
	for (const agent of agents) {
		try {
			for (const group of query({
				sessionId: agent.id,
				sessionName: agent.name,
				projectPath: agent.projectPath,
				since: options.since,
				limit: options.limit,
			})) {
				entries.push(cueGroupToHistoryEntry(group));
			}
		} catch (error) {
			void captureException(error);
			logger.warn(
				`Failed to read grouped Cue history for session ${agent.id}: ${error}`,
				LOG_CONTEXT
			);
		}
	}
	return entries;
}

/**
 * The runs behind ONE collapsed group, for the History panel's expander.
 *
 * Takes a single agent rather than a scope list because a group belongs to the
 * agent that ran it: the row carries its `sessionId`, so the expander asks for
 * exactly that agent's runs. Two agents whose triggers share a name each get
 * their own row and their own expansion, which is what the user sees.
 *
 * Degrades to "no runs" on a database failure, the same way
 * {@link readCueEntries} does - an unreadable Cue database must leave the rest
 * of the panel working.
 */
export function readCueGroupRuns(
	query: CueHistoryGroupRunsQueryFn | undefined,
	agent: CueScopeAgent,
	options: { groupKey: string; since?: number; limit?: number }
): HistoryEntry[] {
	if (!query) return [];
	try {
		return query({
			sessionId: agent.id,
			sessionName: agent.name,
			projectPath: agent.projectPath,
			groupKey: options.groupKey,
			since: options.since,
			limit: options.limit,
		});
	} catch (error) {
		void captureException(error);
		logger.warn(
			`Failed to read Cue group "${options.groupKey}" for session ${agent.id}: ${error}`,
			LOG_CONTEXT
		);
		return [];
	}
}

/**
 * The Cue half of the activity-graph cache key.
 *
 * Deliberately a separate, cheap query from {@link readCueGraphBuckets} rather
 * than a hash of the buckets themselves: it is asked on every graph read,
 * including the ones the cache answers, so it must not cost a full scan.
 *
 * A failed read returns a value that cannot match any stored fingerprint, so a
 * stale aggregate is never served on the strength of a database we could not
 * actually ask.
 */
export function readCueGraphFingerprint(
	query: CueHistoryFingerprintQuery | undefined,
	sessionId?: string
): string {
	if (!query) return 'none';
	try {
		return query(sessionId);
	} catch (error) {
		void captureException(error);
		logger.warn(
			`Failed to fingerprint Cue history for session ${sessionId ?? '<all>'}: ${error}`,
			LOG_CONTEXT
		);
		return `error-${Date.now()}`;
	}
}

/**
 * Per-minute Cue run counts for an activity graph. Omit `sessionId` for the
 * fleet-wide graph Director's Notes draws.
 *
 * Degrades to "no Cue bars" on a DB failure, for the same reason
 * {@link readCueEntries} degrades to no rows: a missing or locked Cue database
 * must not take the user's own history graph down with it.
 */
export function readCueGraphBuckets(
	query: CueHistoryBucketsQuery | undefined,
	options: { sessionId?: string; since?: number; until?: number } = {}
): CueHistoryBucket[] {
	if (!query) return [];
	try {
		return query(options);
	} catch (error) {
		void captureException(error);
		logger.warn(
			`Failed to read Cue graph buckets for session ${options.sessionId ?? '<all>'}: ${error}`,
			LOG_CONTEXT
		);
		return [];
	}
}

/**
 * Widest plausible gap between when a Cue run was dispatched (the DB row's
 * `created_at`) plus its measured duration, and when the JSONL writer stamped
 * the completed run. Duration is sleep-aware while the two clocks are not, so
 * the tolerance is generous; it only has to be tighter than the interval
 * between two runs of the same trigger producing identical output.
 */
const CUE_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

/**
 * A Cue run's identity as far as the two writers of the same run agreed on it.
 * The JSONL entry and the DB row carry byte-identical summaries - both derived
 * from `buildCuePersistedOutput()` - but different ids and different
 * timestamps, so id dedupe cannot see the overlap.
 */
function cueDuplicateKey(entry: HistoryEntry): string {
	return [
		entry.sessionId,
		entry.cueTriggerName ?? '',
		entry.cueEventType ?? '',
		entry.summary,
	].join(' ');
}

/**
 * Drop DB-sourced Cue rows that the JSONL file already carries.
 *
 * The JSONL Cue writes are gone, but every run recorded before they were
 * removed is still on disk, and stays there: past the Cue retention window
 * those entries are the only record of the run. Without this they would render
 * twice, once from each store.
 *
 * Each JSONL entry suppresses at most ONE database row, matched to the nearest
 * completion time. That matters for a trigger that says the same thing every
 * few minutes - N identical JSONL entries must hide N rows, not collapse the
 * whole series into one.
 */
export function dropCueRowsAlreadyInJsonl(
	jsonlEntries: HistoryEntry[],
	cueRows: HistoryEntry[]
): HistoryEntry[] {
	if (cueRows.length === 0) return cueRows;

	const jsonlTimestamps = new Map<string, number[]>();
	for (const entry of jsonlEntries) {
		if (entry.type !== 'CUE') continue;
		const key = cueDuplicateKey(entry);
		const bucket = jsonlTimestamps.get(key);
		if (bucket) bucket.push(entry.timestamp);
		else jsonlTimestamps.set(key, [entry.timestamp]);
	}
	if (jsonlTimestamps.size === 0) return cueRows;

	return cueRows.filter((row) => {
		const bucket = jsonlTimestamps.get(cueDuplicateKey(row));
		if (!bucket || bucket.length === 0) return true;

		// The DB row is stamped at dispatch; the JSONL entry was stamped when
		// the run finished, so compare against the row's completion time.
		const finishedAt = row.timestamp + (row.elapsedTimeMs ?? 0);
		let matchIndex = -1;
		let smallestDelta = CUE_DUPLICATE_WINDOW_MS;
		for (let i = 0; i < bucket.length; i++) {
			const delta = Math.abs(bucket[i] - finishedAt);
			if (delta <= smallestDelta) {
				smallestDelta = delta;
				matchIndex = i;
			}
		}
		if (matchIndex === -1) return true;
		bucket.splice(matchIndex, 1);
		return false;
	});
}

/**
 * Append `incoming` to `base`, skipping ids already present, and sort
 * newest-first. The same merge the shared-history overlay uses, shared so the
 * Cue rows join the list exactly the way foreign-host entries do.
 */
export function mergeEntriesById(base: HistoryEntry[], incoming: HistoryEntry[]): HistoryEntry[] {
	if (incoming.length === 0) return base;

	const seenIds = new Set(base.map((entry) => entry.id));
	const merged = [...base];
	for (const entry of incoming) {
		if (seenIds.has(entry.id)) continue;
		seenIds.add(entry.id);
		merged.push(entry);
	}
	return sortEntriesByTimestamp(merged);
}
