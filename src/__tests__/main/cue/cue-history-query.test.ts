// @vitest-environment node
/**
 * CUE-HISTORY-02 task #1 - `getCueHistoryEntries()` in `cue-stats-query.ts`.
 *
 * These run against a REAL SQLite database (`node:sqlite`, via the shim in
 * `src/__tests__/helpers/nodeSqlite.ts`) rather than a mocked statement
 * recorder, because the thing under test IS the SQL: the predicate
 * `output_excerpt IS NOT NULL OR status != 'completed'` decides which Cue runs
 * reach the History panel at all. A mock that records the query string would
 * assert that we typed it, not that it selects the right rows.
 *
 * The three cases that matter, straight from `CUE_EVENT_WORTH_SHOWING_SQL`:
 *   - a chatty run appears (there is something to read)
 *   - a silent successful run does NOT (a heartbeat with nothing to say -
 *     thousands per week of those are what buried real entries)
 *   - a silent FAILED run DOES (valuable precisely because it printed nothing)
 *
 * Timestamps are driven with fake `Date` so `created_at` / `completed_at`,
 * which the DB module stamps itself, stay deterministic.
 *
 * Task #4 adds the activity-graph half to the same suite: `getCueHistoryBuckets()`
 * has to apply that identical predicate through a `GROUP BY`, and
 * `getCueHistoryFingerprint()` has to move whenever it would return different
 * numbers - both facts only a real database can demonstrate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';

vi.mock('better-sqlite3', () => nodeSqliteBetterSqlite3Mock());

vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => os.tmpdir()) },
}));

// The aggregation half of cue-stats-query reaches into per-agent session
// storage on import; stub it so this suite only pulls in the SQL path.
vi.mock('../../../main/cue/stats/cue-token-accessor', () => ({
	getSessionTokenSummaries: vi.fn(async () => new Map()),
	getAgentTypesForSessions: vi.fn(() => new Map()),
}));

import {
	initCueDb,
	closeCueDb,
	recordCueEvent,
	updateCueEventStatus,
	getCueEventsForHistory,
} from '../../../main/cue/cue-db';
import {
	getCueHistoryBuckets,
	getCueHistoryEntries,
	getCueHistoryFingerprint,
	getCueHistoryGroups,
	getCueHistoryGroupRuns,
} from '../../../main/cue/stats/cue-stats-query';
import type { HistoryEntry } from '../../../shared/types';

const AGENT_ID = 'agent-rc';
const OTHER_AGENT_ID = 'agent-main';
const BASE_MS = 1_700_000_000_000;

interface SeedOptions {
	id: string;
	sessionId?: string;
	type?: string;
	triggerName?: string;
	subscriptionName?: string;
	/** Terminal status. Omit to leave the run in flight (`running`). */
	status?: 'completed' | 'failed' | 'timeout' | 'stopped';
	outputExcerpt?: string | null;
	fullOutput?: string | null;
	/** Raw payload column value; pass a non-JSON string to test tolerance. */
	payload?: string;
	/** `created_at` for the row. Defaults to {@link BASE_MS}. */
	createdAt?: number;
	/** `completed_at`. Defaults to `createdAt`, i.e. a zero-duration run. */
	completedAt?: number;
	/** Lineage column. Omit for a run recorded without a pipeline. */
	pipelineId?: string;
}

/**
 * Insert a run the way the engine does - a `running` row at dispatch, then a
 * status flip carrying the completion columns - so the test exercises the same
 * two-write path production uses instead of hand-crafting a final row.
 */
function seedRun(opts: SeedOptions): void {
	const createdAt = opts.createdAt ?? BASE_MS;
	vi.setSystemTime(createdAt);
	recordCueEvent({
		id: opts.id,
		type: opts.type ?? 'time.heartbeat',
		triggerName: opts.triggerName ?? 'Pedsidian-Command-Bus',
		sessionId: opts.sessionId ?? AGENT_ID,
		subscriptionName: opts.subscriptionName ?? 'Pedsidian-Command-Bus',
		status: 'running',
		payload: opts.payload,
		pipelineId: opts.pipelineId,
	});

	if (!opts.status) return;

	vi.setSystemTime(opts.completedAt ?? createdAt);
	updateCueEventStatus(opts.id, opts.status, undefined, {
		outputExcerpt: opts.outputExcerpt ?? null,
		fullOutput: opts.fullOutput ?? null,
	});
}

const idsOf = (entries: HistoryEntry[]): string[] => entries.map((entry) => entry.id);

/**
 * Start of the minute a timestamp falls in - what the bucket query groups on.
 * BASE_MS is deliberately NOT on a minute boundary (it sits 20s in), so the
 * bucket expectations have to be derived rather than written as `BASE_MS + n`.
 */
const minuteStart = (ms: number): number => Math.floor(ms / 60_000) * 60_000;

describe.skipIf(!canLoadNodeSqlite())('getCueHistoryEntries (real SQLite)', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(BASE_MS);
		closeCueDb();
		initCueDb(undefined, ':memory:');
	});

	afterEach(() => {
		closeCueDb();
		vi.useRealTimers();
	});

	it('returns a chatty run, hides a silent success, keeps a silent failure', () => {
		seedRun({ id: 'chatty', status: 'completed', outputExcerpt: 'Synced 4 notes.' });
		seedRun({ id: 'silent-ok', status: 'completed', outputExcerpt: null });
		seedRun({ id: 'silent-fail', status: 'failed', outputExcerpt: null });

		const ids = idsOf(getCueHistoryEntries({ sessionId: AGENT_ID }));

		expect(ids).toContain('chatty');
		expect(ids).toContain('silent-fail');
		expect(ids).not.toContain('silent-ok');
	});

	it('maps every HistoryEntry field off the row', () => {
		seedRun({
			id: 'mapped',
			type: 'agent.completed',
			subscriptionName: 'PR Triage Main',
			status: 'completed',
			outputExcerpt: 'Triaged PR #891.',
			fullOutput: 'Triaged PR #891.\nNo action needed.',
			payload: JSON.stringify({ sourceSession: 'builder' }),
			createdAt: BASE_MS,
			completedAt: BASE_MS + 12_500,
		});

		const [entry] = getCueHistoryEntries({
			sessionId: AGENT_ID,
			sessionName: 'rc',
			projectPath: '/Users/pedram/Projects/Maestro',
		});

		expect(entry).toMatchObject({
			id: 'mapped',
			type: 'CUE',
			timestamp: BASE_MS,
			summary: 'Triaged PR #891.',
			fullResponse: 'Triaged PR #891.\nNo action needed.',
			projectPath: '/Users/pedram/Projects/Maestro',
			sessionId: AGENT_ID,
			sessionName: 'rc',
			success: true,
			elapsedTimeMs: 12_500,
			cueTriggerName: 'PR Triage Main',
			cueEventType: 'agent.completed',
			cueSourceSession: 'builder',
		});
	});

	it('falls back to the trigger-label summary for a silent failure', () => {
		seedRun({
			id: 'quiet-timeout',
			subscriptionName: 'Nightly Sync',
			status: 'timeout',
			outputExcerpt: null,
		});

		const [entry] = getCueHistoryEntries({ sessionId: AGENT_ID, sessionName: 'rc' });

		expect(entry.summary).toBe('"Nightly Sync" · rc');
		expect(entry.success).toBe(false);
		expect(entry.fullResponse).toBeUndefined();
	});

	it('treats an in-flight run as unsuccessful and leaves its duration unset', () => {
		seedRun({ id: 'in-flight', subscriptionName: 'Nightly Sync' });

		const [entry] = getCueHistoryEntries({ sessionId: AGENT_ID, sessionName: 'rc' });

		expect(entry.id).toBe('in-flight');
		expect(entry.success).toBe(false);
		expect(entry.elapsedTimeMs).toBeUndefined();
	});

	it('scopes to one agent and sorts newest first', () => {
		seedRun({ id: 'older', status: 'completed', outputExcerpt: 'a', createdAt: BASE_MS });
		seedRun({ id: 'newer', status: 'completed', outputExcerpt: 'b', createdAt: BASE_MS + 5_000 });
		seedRun({
			id: 'other-agent',
			sessionId: OTHER_AGENT_ID,
			status: 'completed',
			outputExcerpt: 'c',
			createdAt: BASE_MS + 9_000,
		});

		expect(idsOf(getCueHistoryEntries({ sessionId: AGENT_ID }))).toEqual(['newer', 'older']);
	});

	it('honors the since / until window and the row cap', () => {
		seedRun({ id: 'r1', status: 'completed', outputExcerpt: 'a', createdAt: BASE_MS + 1_000 });
		seedRun({ id: 'r2', status: 'completed', outputExcerpt: 'b', createdAt: BASE_MS + 2_000 });
		seedRun({ id: 'r3', status: 'completed', outputExcerpt: 'c', createdAt: BASE_MS + 3_000 });

		const windowed = getCueHistoryEntries({
			sessionId: AGENT_ID,
			since: BASE_MS + 2_000,
			until: BASE_MS + 3_000,
		});
		expect(idsOf(windowed)).toEqual(['r2']);

		const capped = getCueEventsForHistory({ sessionId: AGENT_ID, limit: 2 });
		expect(capped.map((event) => event.id)).toEqual(['r3', 'r2']);
	});

	it('survives a corrupt payload instead of throwing', () => {
		seedRun({ id: 'corrupt', status: 'failed', outputExcerpt: null, payload: '{not json' });

		const [entry] = getCueHistoryEntries({ sessionId: AGENT_ID, sessionName: 'rc' });

		expect(entry.id).toBe('corrupt');
		expect(entry.cueSourceSession).toBeUndefined();
	});

	it('returns nothing once the database is closed rather than throwing', () => {
		seedRun({ id: 'chatty', status: 'completed', outputExcerpt: 'Synced.' });
		closeCueDb();

		expect(getCueHistoryEntries({ sessionId: AGENT_ID })).toEqual([]);
	});
});

describe.skipIf(!canLoadNodeSqlite())('getCueHistoryBuckets (real SQLite)', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(BASE_MS);
		closeCueDb();
		initCueDb(undefined, ':memory:');
	});

	afterEach(() => {
		closeCueDb();
		vi.useRealTimers();
	});

	it('counts runs per minute under the same filter the entry query uses', () => {
		// Three runs inside one minute, of which only two are worth showing.
		seedRun({ id: 'a', status: 'completed', outputExcerpt: 'x', createdAt: BASE_MS });
		seedRun({ id: 'b', status: 'failed', outputExcerpt: null, createdAt: BASE_MS + 1_000 });
		seedRun({
			id: 'silent-ok',
			status: 'completed',
			outputExcerpt: null,
			createdAt: BASE_MS + 2_000,
		});
		// A fourth two minutes later, in its own bucket.
		seedRun({ id: 'c', status: 'completed', outputExcerpt: 'y', createdAt: BASE_MS + 120_000 });

		expect(getCueHistoryBuckets({ sessionId: AGENT_ID })).toEqual([
			{ timestamp: minuteStart(BASE_MS), count: 2 },
			{ timestamp: minuteStart(BASE_MS + 120_000), count: 1 },
		]);
	});

	it('floors each run to the start of its minute', () => {
		// BASE_MS sits 20s into a minute, so +37.5s is still that minute while
		// +40s has crossed into the next one.
		seedRun({
			id: 'same-minute',
			status: 'completed',
			outputExcerpt: 'x',
			createdAt: BASE_MS + 37_500,
		});
		seedRun({
			id: 'next-minute',
			status: 'completed',
			outputExcerpt: 'x',
			createdAt: BASE_MS + 40_000,
		});

		expect(getCueHistoryBuckets({ sessionId: AGENT_ID })).toEqual([
			{ timestamp: minuteStart(BASE_MS), count: 1 },
			{ timestamp: minuteStart(BASE_MS) + 60_000, count: 1 },
		]);
	});

	it('scopes to one agent and honors the since / until window', () => {
		seedRun({ id: 'old', status: 'completed', outputExcerpt: 'x', createdAt: BASE_MS });
		seedRun({ id: 'kept', status: 'completed', outputExcerpt: 'x', createdAt: BASE_MS + 60_000 });
		seedRun({ id: 'new', status: 'completed', outputExcerpt: 'x', createdAt: BASE_MS + 180_000 });
		seedRun({
			id: 'other-agent',
			sessionId: OTHER_AGENT_ID,
			status: 'completed',
			outputExcerpt: 'x',
			createdAt: BASE_MS + 60_000,
		});

		expect(
			getCueHistoryBuckets({
				sessionId: AGENT_ID,
				since: BASE_MS + 60_000,
				until: BASE_MS + 180_000,
			})
		).toEqual([{ timestamp: minuteStart(BASE_MS + 60_000), count: 1 }]);
	});

	// Director's Notes graphs every agent at once, so it omits `sessionId` and
	// lets one GROUP BY answer for the fleet rather than one query per agent.
	it('sums every agent into one series when no agent is named', () => {
		seedRun({ id: 'mine', status: 'completed', outputExcerpt: 'x', createdAt: BASE_MS });
		seedRun({
			id: 'theirs',
			sessionId: OTHER_AGENT_ID,
			status: 'completed',
			outputExcerpt: 'x',
			createdAt: BASE_MS + 1_000,
		});
		// Still filtered: a silent success is not a bar on anyone's graph.
		seedRun({
			id: 'silent-ok',
			sessionId: OTHER_AGENT_ID,
			status: 'completed',
			outputExcerpt: null,
			createdAt: BASE_MS + 2_000,
		});

		expect(getCueHistoryBuckets({})).toEqual([{ timestamp: minuteStart(BASE_MS), count: 2 }]);
	});

	it('honors the since window on the fleet-wide read', () => {
		seedRun({ id: 'old', status: 'completed', outputExcerpt: 'x', createdAt: BASE_MS });
		seedRun({
			id: 'new',
			sessionId: OTHER_AGENT_ID,
			status: 'completed',
			outputExcerpt: 'x',
			createdAt: BASE_MS + 120_000,
		});

		expect(getCueHistoryBuckets({ since: BASE_MS + 60_000 })).toEqual([
			{ timestamp: minuteStart(BASE_MS + 120_000), count: 1 },
		]);
	});

	it('returns nothing once the database is closed rather than throwing', () => {
		seedRun({ id: 'a', status: 'completed', outputExcerpt: 'x' });
		closeCueDb();

		expect(getCueHistoryBuckets({ sessionId: AGENT_ID })).toEqual([]);
	});
});

describe.skipIf(!canLoadNodeSqlite())('getCueHistoryFingerprint (real SQLite)', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(BASE_MS);
		closeCueDb();
		initCueDb(undefined, ':memory:');
	});

	afterEach(() => {
		closeCueDb();
		vi.useRealTimers();
	});

	it('moves when a run lands, and holds still when nothing changes', () => {
		const empty = getCueHistoryFingerprint(AGENT_ID);
		expect(getCueHistoryFingerprint(AGENT_ID)).toBe(empty);

		seedRun({ id: 'a', status: 'completed', outputExcerpt: 'x', createdAt: BASE_MS });
		const afterFirst = getCueHistoryFingerprint(AGENT_ID);
		expect(afterFirst).not.toBe(empty);
		expect(getCueHistoryFingerprint(AGENT_ID)).toBe(afterFirst);

		seedRun({ id: 'b', status: 'completed', outputExcerpt: 'y', createdAt: BASE_MS + 60_000 });
		expect(getCueHistoryFingerprint(AGENT_ID)).not.toBe(afterFirst);
	});

	it('moves when a silent success drops out of the filter', () => {
		// The dispatch row is `running`, so it passes the filter; completing
		// silently removes it, which has to change the stamp or the graph would
		// keep drawing a bar for a run it no longer shows.
		vi.setSystemTime(BASE_MS);
		recordCueEvent({
			id: 'heartbeat',
			type: 'time.heartbeat',
			triggerName: 'Heartbeat',
			sessionId: AGENT_ID,
			subscriptionName: 'Heartbeat',
			status: 'running',
		});
		const inFlight = getCueHistoryFingerprint(AGENT_ID);

		vi.setSystemTime(BASE_MS + 5_000);
		updateCueEventStatus('heartbeat', 'completed', undefined, {
			outputExcerpt: null,
			fullOutput: null,
		});

		expect(getCueHistoryFingerprint(AGENT_ID)).not.toBe(inFlight);
	});

	it('is per agent', () => {
		seedRun({ id: 'a', status: 'completed', outputExcerpt: 'x' });

		expect(getCueHistoryFingerprint(OTHER_AGENT_ID)).not.toBe(getCueHistoryFingerprint(AGENT_ID));
	});

	// The fleet-wide form keys Director's Notes' graph cache: a run landing for
	// ANY agent has to move it, or that graph freezes its CUE bars.
	it('covers every agent when none is named', () => {
		const empty = getCueHistoryFingerprint();

		seedRun({ id: 'a', status: 'completed', outputExcerpt: 'x', createdAt: BASE_MS });
		const afterMine = getCueHistoryFingerprint();
		expect(afterMine).not.toBe(empty);

		seedRun({
			id: 'b',
			sessionId: OTHER_AGENT_ID,
			status: 'completed',
			outputExcerpt: 'y',
			createdAt: BASE_MS + 60_000,
		});
		expect(getCueHistoryFingerprint()).not.toBe(afterMine);
		// A per-agent stamp would not have noticed the other agent's run.
		expect(getCueHistoryFingerprint(AGENT_ID)).toBe(getCueHistoryFingerprint(AGENT_ID));
	});
});

/**
 * CUE-HISTORY-03 task #1 - `getCueHistoryGroups()`.
 *
 * Also against a real database, for the same reason the suites above are: the
 * thing under test is a `GROUP BY` plus SQLite's bare-column rule (with exactly
 * one `MAX()` in the query, bare columns come from the row that produced it).
 * A mocked statement recorder would assert the string, not that the preview
 * body actually belongs to the newest run.
 */
describe.skipIf(!canLoadNodeSqlite())('getCueHistoryGroups (real SQLite)', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(BASE_MS);
		closeCueDb();
		initCueDb(undefined, ':memory:');
	});

	afterEach(() => {
		closeCueDb();
		vi.useRealTimers();
	});

	it('renders a single-run trigger as a group of one', () => {
		seedRun({
			id: 'lonely',
			subscriptionName: 'Nightly Sync',
			status: 'completed',
			outputExcerpt: 'Synced 4 notes.',
		});

		const groups = getCueHistoryGroups({ sessionId: AGENT_ID, sessionName: 'rc' });

		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({
			key: 'Nightly Sync',
			label: 'Nightly Sync',
			runCount: 1,
			failureCount: 0,
			lastRunAtMs: BASE_MS,
		});
		// The one run is shaped exactly as the ungrouped path shapes it, which
		// is what lets the renderer draw a group of one as an ordinary row.
		const [ungrouped] = getCueHistoryEntries({ sessionId: AGENT_ID, sessionName: 'rc' });
		expect(groups[0].latestEntry).toEqual(ungrouped);
	});

	it('collapses a many-run trigger to one row carrying the newest run', () => {
		for (let i = 0; i < 5; i++) {
			seedRun({
				id: `bus-${i}`,
				subscriptionName: 'Pedsidian-Command-Bus',
				status: 'completed',
				outputExcerpt: `Handled command ${i}.`,
				createdAt: BASE_MS + i * 60_000,
			});
		}

		const groups = getCueHistoryGroups({ sessionId: AGENT_ID, sessionName: 'rc' });

		expect(groups).toHaveLength(1);
		expect(groups[0].runCount).toBe(5);
		expect(groups[0].lastRunAtMs).toBe(BASE_MS + 4 * 60_000);
		// Preview body is the NEWEST run's excerpt, not an arbitrary member's.
		expect(groups[0].latestEntry.id).toBe('bus-4');
		expect(groups[0].latestEntry.summary).toBe('Handled command 4.');
	});

	it('counts failures inside a mixed-status trigger without dropping them', () => {
		seedRun({
			id: 'mixed-ok',
			subscriptionName: 'Fact Check',
			status: 'completed',
			outputExcerpt: 'Checked 12 claims.',
			createdAt: BASE_MS,
		});
		seedRun({
			id: 'mixed-fail',
			subscriptionName: 'Fact Check',
			status: 'failed',
			outputExcerpt: null,
			createdAt: BASE_MS + 60_000,
		});
		seedRun({
			id: 'mixed-timeout',
			subscriptionName: 'Fact Check',
			status: 'timeout',
			outputExcerpt: 'Gave up after 300s.',
			createdAt: BASE_MS + 120_000,
		});
		// An in-flight run counts as a failure here, matching the rule the
		// ungrouped entry mapping paints rows with (`success: status ===
		// 'completed'`).
		seedRun({
			id: 'mixed-running',
			subscriptionName: 'Fact Check',
			createdAt: BASE_MS + 180_000,
		});

		const [group] = getCueHistoryGroups({ sessionId: AGENT_ID, sessionName: 'rc' });

		expect(group.runCount).toBe(4);
		expect(group.failureCount).toBe(3);
		expect(group.latestEntry.id).toBe('mixed-running');
	});

	it('does not count a silent success that History would never show', () => {
		seedRun({
			id: 'heard',
			subscriptionName: 'Heartbeat',
			status: 'completed',
			outputExcerpt: 'Ping.',
			createdAt: BASE_MS,
		});
		seedRun({
			id: 'unheard',
			subscriptionName: 'Heartbeat',
			status: 'completed',
			outputExcerpt: null,
			createdAt: BASE_MS + 60_000,
		});

		const [group] = getCueHistoryGroups({ sessionId: AGENT_ID, sessionName: 'rc' });

		expect(group.runCount).toBe(1);
		expect(group.latestEntry.id).toBe('heard');
	});

	it('collapses two chain steps of one pipeline into a single group', () => {
		seedRun({
			id: 'step-1',
			subscriptionName: 'PR Triage-chain-1',
			status: 'completed',
			outputExcerpt: 'Fetched PR #891.',
			createdAt: BASE_MS,
		});
		seedRun({
			id: 'step-2',
			subscriptionName: 'PR Triage-chain-2',
			status: 'failed',
			outputExcerpt: 'Review step crashed.',
			createdAt: BASE_MS + 60_000,
		});
		seedRun({
			id: 'step-sink',
			subscriptionName: 'PR Triage-fanin',
			status: 'completed',
			outputExcerpt: 'Posted the summary.',
			createdAt: BASE_MS + 120_000,
		});

		const groups = getCueHistoryGroups({ sessionId: AGENT_ID, sessionName: 'rc' });

		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({
			label: 'PR Triage',
			runCount: 3,
			failureCount: 1,
			lastRunAtMs: BASE_MS + 120_000,
		});
		expect(groups[0].latestEntry.id).toBe('step-sink');
	});

	it('groups on the recorded pipeline name when the runs carry lineage', () => {
		seedRun({
			id: 'lineage-a',
			subscriptionName: 'Internal-Plumbing-A',
			pipelineId: 'Morning Briefing',
			status: 'completed',
			outputExcerpt: 'Gathered sources.',
			createdAt: BASE_MS,
		});
		seedRun({
			id: 'lineage-b',
			subscriptionName: 'Internal-Plumbing-B',
			pipelineId: 'Morning Briefing',
			status: 'completed',
			outputExcerpt: 'Wrote the briefing.',
			createdAt: BASE_MS + 60_000,
		});

		const groups = getCueHistoryGroups({ sessionId: AGENT_ID, sessionName: 'rc' });

		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ label: 'Morning Briefing', runCount: 2 });
	});

	it('keeps unrelated triggers apart and orders them by their last run', () => {
		seedRun({
			id: 'older',
			subscriptionName: 'Nightly Sync',
			status: 'completed',
			outputExcerpt: 'Synced.',
			createdAt: BASE_MS,
		});
		seedRun({
			id: 'newer',
			subscriptionName: 'Fact Check',
			status: 'completed',
			outputExcerpt: 'Checked.',
			createdAt: BASE_MS + 60_000,
		});

		const groups = getCueHistoryGroups({ sessionId: AGENT_ID, sessionName: 'rc' });

		expect(groups.map((group) => group.label)).toEqual(['Fact Check', 'Nightly Sync']);
	});

	it('scopes to one agent and honors the time window', () => {
		seedRun({
			id: 'mine',
			subscriptionName: 'Nightly Sync',
			status: 'completed',
			outputExcerpt: 'Mine.',
			createdAt: BASE_MS,
		});
		seedRun({
			id: 'theirs',
			sessionId: OTHER_AGENT_ID,
			subscriptionName: 'Nightly Sync',
			status: 'completed',
			outputExcerpt: 'Theirs.',
			createdAt: BASE_MS,
		});
		seedRun({
			id: 'too-old',
			subscriptionName: 'Nightly Sync',
			status: 'completed',
			outputExcerpt: 'Ancient.',
			createdAt: BASE_MS - 600_000,
		});

		const [group] = getCueHistoryGroups({ sessionId: AGENT_ID, since: BASE_MS });

		expect(group.runCount).toBe(1);
		expect(group.latestEntry.id).toBe('mine');
	});

	it('caps GROUPS with `limit`, after every run in the window is counted', () => {
		seedRun({
			id: 'busy-1',
			subscriptionName: 'Pedsidian-Command-Bus',
			status: 'completed',
			outputExcerpt: 'One.',
			createdAt: BASE_MS,
		});
		seedRun({
			id: 'busy-2',
			subscriptionName: 'Pedsidian-Command-Bus',
			status: 'completed',
			outputExcerpt: 'Two.',
			createdAt: BASE_MS + 60_000,
		});
		seedRun({
			id: 'quiet',
			subscriptionName: 'Nightly Sync',
			status: 'completed',
			outputExcerpt: 'Synced.',
			createdAt: BASE_MS - 60_000,
		});

		const groups = getCueHistoryGroups({ sessionId: AGENT_ID, limit: 1 });

		expect(groups).toHaveLength(1);
		expect(groups[0].label).toBe('Pedsidian-Command-Bus');
		// The cap dropped a GROUP; it did not shrink the surviving group's count.
		expect(groups[0].runCount).toBe(2);
	});
});

/**
 * CUE-HISTORY-03 task #4 - `getCueHistoryGroupRuns()`, the expander behind a
 * collapsed row.
 *
 * The contract these pin is the one that makes the collapse honest: what the
 * expander returns must be exactly the set of runs the group COUNTED. So the
 * group filter, the chain-suffix fold and the window all have to agree with
 * `getCueHistoryGroups()` run over the same seeded rows - which is why the
 * assertions read a count off the group and then expect that many runs back.
 */
describe.skipIf(!canLoadNodeSqlite())('getCueHistoryGroupRuns (real SQLite)', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(BASE_MS);
		closeCueDb();
		initCueDb(undefined, ':memory:');
	});

	afterEach(() => {
		closeCueDb();
		vi.useRealTimers();
	});

	it('returns every run the group counted, newest first', () => {
		for (let i = 0; i < 5; i++) {
			seedRun({
				id: `bus-${i}`,
				subscriptionName: 'Pedsidian-Command-Bus',
				status: 'completed',
				outputExcerpt: `Handled command ${i}.`,
				createdAt: BASE_MS + i * 60_000,
			});
		}

		const [group] = getCueHistoryGroups({ sessionId: AGENT_ID, sessionName: 'rc' });
		const runs = getCueHistoryGroupRuns({
			sessionId: AGENT_ID,
			sessionName: 'rc',
			groupKey: group.key,
		});

		expect(runs).toHaveLength(group.runCount);
		expect(idsOf(runs)).toEqual(['bus-4', 'bus-3', 'bus-2', 'bus-1', 'bus-0']);
		// Each run is shaped exactly as the ungrouped read shapes it, so the
		// detail modal opens on a run indistinguishable from an ordinary row.
		expect(runs[0]).toEqual(group.latestEntry);
	});

	it('gathers the chain steps of one pipeline the same way the group did', () => {
		seedRun({
			id: 'step-1',
			subscriptionName: 'PR-Sweep',
			status: 'completed',
			outputExcerpt: 'Swept.',
			createdAt: BASE_MS,
		});
		seedRun({
			id: 'step-2',
			subscriptionName: 'PR-Sweep-chain-1',
			status: 'completed',
			outputExcerpt: 'Chained.',
			createdAt: BASE_MS + 60_000,
		});
		seedRun({
			id: 'step-3',
			subscriptionName: 'PR-Sweep-fanin',
			status: 'completed',
			outputExcerpt: 'Fanned in.',
			createdAt: BASE_MS + 120_000,
		});

		const [group] = getCueHistoryGroups({ sessionId: AGENT_ID });
		const runs = getCueHistoryGroupRuns({ sessionId: AGENT_ID, groupKey: group.key });

		expect(group.runCount).toBe(3);
		expect(idsOf(runs)).toEqual(['step-3', 'step-2', 'step-1']);
	});

	it("leaves another trigger's runs out of the group it was asked for", () => {
		seedRun({
			id: 'bus-run',
			subscriptionName: 'Pedsidian-Command-Bus',
			status: 'completed',
			outputExcerpt: 'Bus.',
			createdAt: BASE_MS,
		});
		seedRun({
			id: 'sync-run',
			subscriptionName: 'Nightly Sync',
			status: 'completed',
			outputExcerpt: 'Sync.',
			createdAt: BASE_MS + 60_000,
		});

		const runs = getCueHistoryGroupRuns({ sessionId: AGENT_ID, groupKey: 'Nightly Sync' });

		expect(idsOf(runs)).toEqual(['sync-run']);
	});

	it('honors the same agent and window the group was counted over', () => {
		seedRun({
			id: 'mine',
			subscriptionName: 'Nightly Sync',
			status: 'completed',
			outputExcerpt: 'Mine.',
			createdAt: BASE_MS,
		});
		seedRun({
			id: 'theirs',
			sessionId: OTHER_AGENT_ID,
			subscriptionName: 'Nightly Sync',
			status: 'completed',
			outputExcerpt: 'Theirs.',
			createdAt: BASE_MS,
		});
		seedRun({
			id: 'too-old',
			subscriptionName: 'Nightly Sync',
			status: 'completed',
			outputExcerpt: 'Ancient.',
			createdAt: BASE_MS - 600_000,
		});

		const [group] = getCueHistoryGroups({ sessionId: AGENT_ID, since: BASE_MS });
		const runs = getCueHistoryGroupRuns({
			sessionId: AGENT_ID,
			since: BASE_MS,
			groupKey: group.key,
		});

		expect(runs).toHaveLength(group.runCount);
		expect(idsOf(runs)).toEqual(['mine']);
	});

	it('caps RUNS with `limit`, keeping the newest', () => {
		// The opposite of `getCueHistoryGroups`, where `limit` caps groups. A
		// 1,382-run group opens on the runs the user most likely came for.
		for (let i = 0; i < 4; i++) {
			seedRun({
				id: `bus-${i}`,
				subscriptionName: 'Pedsidian-Command-Bus',
				status: 'completed',
				outputExcerpt: `Handled command ${i}.`,
				createdAt: BASE_MS + i * 60_000,
			});
		}

		const runs = getCueHistoryGroupRuns({
			sessionId: AGENT_ID,
			groupKey: 'Pedsidian-Command-Bus',
			limit: 2,
		});

		expect(idsOf(runs)).toEqual(['bus-3', 'bus-2']);
	});

	it('keeps the silent failures the group counted', () => {
		// A failed run with no output is exactly the row worth reaching, and the
		// group's failure tally promises it is in there.
		seedRun({
			id: 'ok',
			subscriptionName: 'Fact Check',
			status: 'completed',
			outputExcerpt: 'Checked 12 claims.',
			createdAt: BASE_MS,
		});
		seedRun({
			id: 'silent-fail',
			subscriptionName: 'Fact Check',
			status: 'failed',
			outputExcerpt: null,
			createdAt: BASE_MS + 60_000,
		});

		const [group] = getCueHistoryGroups({ sessionId: AGENT_ID });
		const runs = getCueHistoryGroupRuns({ sessionId: AGENT_ID, groupKey: group.key });

		expect(group.failureCount).toBe(1);
		expect(idsOf(runs)).toEqual(['silent-fail', 'ok']);
		expect(runs[0].success).toBe(false);
	});

	it('returns nothing for a group key no run belongs to', () => {
		seedRun({
			id: 'bus-run',
			subscriptionName: 'Pedsidian-Command-Bus',
			status: 'completed',
			outputExcerpt: 'Bus.',
		});

		expect(getCueHistoryGroupRuns({ sessionId: AGENT_ID, groupKey: 'Nothing' })).toEqual([]);
	});
});
