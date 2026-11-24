/**
 * The System One decision ledger in the main process: where a decision is
 * kept, and where every surface reads them back.
 *
 * There are two producers, and both go through {@link keepSystemOneDecision}:
 * `runSystemOneTask` (the task router) hands over every task run that reached
 * the System One path, answered or not, and `runAgentSystemOneRequest` (the
 * agent service) hands over every request an agent's `maestro-cli s1` verb
 * made. The ledger in Settings > Models > System One and `maestro-cli s1
 * ledger` both read through {@link readSystemOneLedger}, so they show the same
 * records.
 *
 * A request that was sent to a remote engine is also filed as a run in
 * `local_model_runs` (`systemOneDecisionRun`), which is never pruned: that row
 * is what the Usage Dashboard counts, and the ledger is the audit trail.
 *
 * The records live in `stats.db` (`s1_decisions`), on the same contract as the
 * other stats writers:
 *
 *   - **It honors `statsCollectionEnabled`.** With usage statistics off nothing
 *     new is kept. A read still answers, and says so.
 *   - **Thirty days.** A record older than the retention window is never
 *     returned, and is deleted the next time the ledger is written or read
 *     (at most once a day).
 *   - **No text unless asked.** A record carries question ids and answers. The
 *     state and the questions arrive here only when "Keep inputs in the ledger"
 *     is on, already redacted by the router.
 *
 * The vocabulary (the record, the query, the page) is
 * `src/shared/local-models/system-one-ledger.ts`.
 */

import type { SystemOneTaskRequest } from '../../../shared/local-models/system-one';
import {
	SYSTEM_ONE_LEDGER_DEFAULT_LIMIT,
	SYSTEM_ONE_LEDGER_RETENTION_DAYS,
	SYSTEM_ONE_LEDGER_RETENTION_MS,
	formatSystemOneLedgerInput,
	parseSystemOneLedgerQuery,
	systemOneDecisionRun,
	type SystemOneDecision,
	type SystemOneLedgerPage,
} from '../../../shared/local-models/system-one-ledger';
import type { SystemOneAgentSpendRow } from '../../stats/s1-decisions';
import { getStatsDB } from '../../stats/singleton';
import { isStatsCollectionEnabled, LOG_CONTEXT as STATS_LOG_CONTEXT } from '../../stats/utils';
import { getSettingsStore } from '../../stores/getters';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';

export type {
	SystemOneDecision,
	SystemOneDecisionOutcome,
} from '../../../shared/local-models/system-one-ledger';

const LOG_CONTEXT = 'SystemOne';

/** What a read says when usage statistics are off. */
export const SYSTEM_ONE_LEDGER_STATS_OFF_NOTICE =
	'Usage statistics are switched off, so new decisions are not kept.';

/** What a read says when the statistics database is not open. */
export const SYSTEM_ONE_LEDGER_UNAVAILABLE_NOTICE =
	'The statistics database is not open, so the ledger cannot be read.';

/** How often old records are deleted. A read never returns one in between. */
const PRUNE_INTERVAL_MS = 86_400_000;

let lastPrunedAt = 0;

/** Delete records past the retention window, at most once per interval. */
function pruneIfDue(db: ReturnType<typeof getStatsDB>, now: number): void {
	if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return;
	lastPrunedAt = now;
	db.pruneSystemOneDecisions(now - SYSTEM_ONE_LEDGER_RETENTION_MS);
}

/**
 * Record one decision: a line in the system log, a row in the ledger, and, for
 * a request sent to a remote engine, a run in `local_model_runs`.
 *
 * It may throw when the row cannot be written. A producer calls
 * {@link keepSystemOneDecision}, which reports that and goes on, because a
 * record that cannot be kept must never fail the run it describes.
 */
export function recordSystemOneDecision(decision: SystemOneDecision): void {
	const summary = {
		taskId: decision.taskId,
		engine: decision.engine,
		outcome: decision.outcome,
		latencyMs: decision.latencyMs,
		questionIds: decision.questionIds,
		...(decision.model !== undefined ? { model: decision.model } : {}),
		...(decision.code !== undefined ? { code: decision.code } : {}),
		...(decision.usage ? { inputTokens: decision.usage.inputTokens } : {}),
	};
	if (decision.outcome === 'ok') logger.debug('System One decision', LOG_CONTEXT, summary);
	else logger.info('System One gave no answer', LOG_CONTEXT, summary);

	if (!isStatsCollectionEnabled(getSettingsStore())) return;
	const db = getStatsDB();
	if (!db.isReady()) return;
	pruneIfDue(db, Date.now());
	db.recordSystemOneDecision(decision);
	const run = systemOneDecisionRun(decision);
	if (run) db.recordLocalModelRun(run);
}

/**
 * Record one decision, best-effort: what both producers call. A record that
 * cannot be kept must never turn an answered request into a failed one, so a
 * failure here is logged and reported and the caller goes on. `kept` is the
 * request, when "Keep inputs in the ledger" is on.
 */
export function keepSystemOneDecision(
	decision: SystemOneDecision,
	kept: SystemOneTaskRequest | null
): void {
	try {
		recordSystemOneDecision(
			// The text is redacted here, inside the guard: it is the user's content,
			// and it is built only for a run whose record keeps it.
			kept ? { ...decision, input: formatSystemOneLedgerInput(kept) } : decision
		);
	} catch (error) {
		logger.warn(`Failed to record System One decision: ${error}`, STATS_LOG_CONTEXT);
		void captureException(error instanceof Error ? error : new Error(String(error)), {
			operation: 'systemOne:recordDecision',
			taskId: decision.taskId,
		});
	}
}

/**
 * What agents' own requests came to since a time, per agent, or `null` when the
 * statistics database is not open. It reads whatever rows exist, so spend
 * recorded before usage statistics were switched off still counts.
 */
export function readSystemOneAgentSpend(since: number): SystemOneAgentSpendRow[] | null {
	const db = getStatsDB();
	if (!db.isReady()) return null;
	return db.getSystemOneAgentSpend(since);
}

/**
 * What a reader of the ledger must be told about it right now, or null: it is
 * not open, or it keeps nothing new while usage statistics are off.
 */
export function systemOneLedgerNotice(): string | null {
	if (!getStatsDB().isReady()) return SYSTEM_ONE_LEDGER_UNAVAILABLE_NOTICE;
	return isStatsCollectionEnabled(getSettingsStore()) ? null : SYSTEM_ONE_LEDGER_STATS_OFF_NOTICE;
}

/**
 * Read the ledger: what the view and `maestro-cli s1 ledger` both show. A query
 * that cannot be read rejects with the reason. Nothing older than the retention
 * window is returned, whatever `since` asks for.
 */
export function readSystemOneLedger(raw: unknown, now: number = Date.now()): SystemOneLedgerPage {
	const parsed = parseSystemOneLedgerQuery(raw);
	if (!parsed.ok) throw new Error(parsed.message);
	const { query } = parsed;
	const page = (
		entries: SystemOneLedgerPage['entries'],
		total: number,
		notice: string | null
	): SystemOneLedgerPage => ({
		entries,
		total,
		retentionDays: SYSTEM_ONE_LEDGER_RETENTION_DAYS,
		notice,
	});

	const db = getStatsDB();
	if (!db.isReady()) return page([], 0, SYSTEM_ONE_LEDGER_UNAVAILABLE_NOTICE);
	pruneIfDue(db, now);
	const { entries, total } = db.getSystemOneDecisions({
		...(query.taskId !== undefined ? { taskId: query.taskId } : {}),
		...(query.outcome !== undefined ? { outcome: query.outcome } : {}),
		since: Math.max(query.since ?? 0, now - SYSTEM_ONE_LEDGER_RETENTION_MS),
		limit: query.limit ?? SYSTEM_ONE_LEDGER_DEFAULT_LIMIT,
	});
	return page(entries, total, systemOneLedgerNotice());
}

/** Forget when the ledger was last pruned, so each test starts from a fresh process. */
export function resetSystemOneLedgerForTests(): void {
	lastPrunedAt = 0;
}
