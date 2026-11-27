/**
 * System One Decision CRUD Operations
 *
 * One row per request that was handed to a System One engine (see
 * `s1_decisions` in schema.ts). The task router records every task run,
 * answered or not, and the agent service records every request an agent's
 * `maestro-cli s1` verb made, so the ledger in Settings > Models > System One
 * and `maestro-cli s1 ledger` can show what was decided and what happened when
 * no answer came. Rows are pruned after the ledger's retention window.
 */

import type Database from 'better-sqlite3';
import type {
	SystemOneDecision,
	SystemOneLedgerEntry,
	SystemOneLedgerQuery,
} from '../../shared/local-models/system-one-ledger';
import type { SystemOneAnswers } from '../../shared/local-models/system-one';
import { SYSTEM_ONE_AGENT_SOURCE_PREFIX } from '../../shared/local-models/system-one-agent';
import type { SystemOneAgentSpend } from '../../shared/local-models/system-one-spend';
import { generateId, LOG_CONTEXT, StatementCache } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

const INSERT_SQL = `
  INSERT INTO s1_decisions
    (id, started_at, task_id, engine, model, question_ids, answers, outcome, error_code,
     latency_ms, tokens_in, tokens_out, cost_usd, agent_id, input, tab_id, cached)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** Record one decision. Returns the generated id. */
export function insertSystemOneDecision(
	db: Database.Database,
	decision: SystemOneDecision
): string {
	const id = generateId();
	stmtCache
		.get(db, INSERT_SQL)
		.run(
			id,
			decision.startedAt,
			decision.taskId,
			decision.engine,
			decision.model ?? null,
			JSON.stringify(decision.questionIds),
			decision.answers ? JSON.stringify(decision.answers) : null,
			decision.outcome,
			decision.code ?? null,
			Math.round(decision.latencyMs),
			decision.usage ? decision.usage.inputTokens : null,
			decision.usage ? decision.usage.outputTokens : null,
			decision.costUsd ?? null,
			decision.agentId ?? null,
			decision.input ?? null,
			decision.tabId ?? null,
			decision.cached ? 1 : 0
		);
	logger.debug(
		`Recorded System One decision: ${decision.taskId} (${decision.outcome})`,
		LOG_CONTEXT
	);
	return id;
}

interface DecisionRow {
	id: string;
	started_at: number;
	task_id: SystemOneDecision['taskId'];
	engine: SystemOneDecision['engine'];
	model: string | null;
	question_ids: string;
	answers: string | null;
	outcome: SystemOneDecision['outcome'];
	error_code: SystemOneDecision['code'] | null;
	latency_ms: number;
	tokens_in: number | null;
	tokens_out: number | null;
	cost_usd: number | null;
	agent_id: string | null;
	input: string | null;
	tab_id: string | null;
	cached: number;
}

/** A JSON column. One that does not parse reads as absent, never as a throw. */
function parseJson(raw: string | null): unknown {
	if (raw === null) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function toEntry(row: DecisionRow): SystemOneLedgerEntry {
	const questionIds = parseJson(row.question_ids);
	const answers = parseJson(row.answers);
	return {
		id: row.id,
		taskId: row.task_id,
		engine: row.engine,
		...(row.model !== null ? { model: row.model } : {}),
		questionIds: Array.isArray(questionIds)
			? questionIds.filter((id): id is string => typeof id === 'string')
			: [],
		...(typeof answers === 'object' && answers !== null && !Array.isArray(answers)
			? { answers: answers as SystemOneAnswers }
			: {}),
		outcome: row.outcome,
		...(row.error_code !== null ? { code: row.error_code } : {}),
		startedAt: row.started_at,
		latencyMs: row.latency_ms,
		...(row.tokens_in !== null && row.tokens_out !== null
			? { usage: { inputTokens: row.tokens_in, outputTokens: row.tokens_out } }
			: {}),
		...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}),
		...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
		...(row.tab_id !== null ? { tabId: row.tab_id } : {}),
		...(row.cached ? { cached: true } : {}),
		...(row.input !== null ? { input: row.input } : {}),
	};
}

/** What one read needs: the query with its time floor and limit already settled. */
export interface SystemOneDecisionsRead extends Pick<SystemOneLedgerQuery, 'taskId' | 'outcome'> {
	/** Epoch ms. Only runs that started at or after it. */
	since: number;
	limit: number;
}

/**
 * Decisions that match, newest first, and how many match in all. The `timeout`
 * filter matches the code, not an outcome: a run that timed out is stored with
 * what its fail policy did.
 */
export function getSystemOneDecisions(
	db: Database.Database,
	read: SystemOneDecisionsRead
): { entries: SystemOneLedgerEntry[]; total: number } {
	const where = ['started_at >= ?'];
	const params: Array<string | number> = [read.since];
	if (read.taskId !== undefined) {
		where.push('task_id = ?');
		params.push(read.taskId);
	}
	if (read.outcome === 'timeout') {
		where.push("error_code = 'timeout'");
	} else if (read.outcome !== undefined) {
		where.push('outcome = ?');
		params.push(read.outcome);
	}
	const clause = where.join(' AND ');

	const rows = stmtCache
		.get(db, `SELECT * FROM s1_decisions WHERE ${clause} ORDER BY started_at DESC LIMIT ?`)
		.all(...params, read.limit) as DecisionRow[];
	const count = stmtCache
		.get(db, `SELECT COUNT(*) AS total FROM s1_decisions WHERE ${clause}`)
		.get(...params) as { total: number } | undefined;
	return { entries: rows.map(toEntry), total: count?.total ?? 0 };
}

/** What one agent's own requests came to since a time. The shape `s1 usage` reports. */
export type SystemOneAgentSpendRow = SystemOneAgentSpend;

/**
 * What agents' own requests (`agent:<verb>` rows) came to since a time, per
 * agent. Task runs are not counted: a Cue gate carries an agent id too, and it
 * is Maestro's spend, not the agent's.
 */
export function getSystemOneAgentSpend(
	db: Database.Database,
	since: number
): SystemOneAgentSpendRow[] {
	const rows = stmtCache
		.get(
			db,
			`SELECT agent_id AS agentId,
			        COUNT(*) AS requests,
			        COALESCE(SUM(cached), 0) AS cachedRequests,
			        COALESCE(SUM(tokens_in), 0) AS tokensIn,
			        COALESCE(SUM(tokens_out), 0) AS tokensOut,
			        COALESCE(SUM(cost_usd), 0) AS costUsd,
			        COALESCE(AVG(CASE WHEN cached = 0 AND outcome = 'ok' THEN latency_ms END), 0)
			          AS averageLatencyMs
			   FROM s1_decisions
			  WHERE started_at >= ? AND task_id LIKE ?
			  GROUP BY agent_id
			  ORDER BY costUsd DESC, requests DESC`
		)
		.all(since, `${SYSTEM_ONE_AGENT_SOURCE_PREFIX}%`) as SystemOneAgentSpendRow[];
	// node:sqlite and better-sqlite3 disagree on integer types for an aggregate.
	return rows.map((row) => ({
		agentId: row.agentId,
		requests: Number(row.requests),
		cachedRequests: Number(row.cachedRequests),
		tokensIn: Number(row.tokensIn),
		tokensOut: Number(row.tokensOut),
		costUsd: Number(row.costUsd),
		averageLatencyMs: Math.round(Number(row.averageLatencyMs)),
	}));
}

/** Delete decisions that started before the cutoff. Returns how many were deleted. */
export function pruneSystemOneDecisions(db: Database.Database, cutoffMs: number): number {
	const result = stmtCache.get(db, 'DELETE FROM s1_decisions WHERE started_at < ?').run(cutoffMs);
	if (result.changes > 0) {
		logger.info(`Pruned ${result.changes} old System One decision(s)`, LOG_CONTEXT);
	}
	return Number(result.changes);
}

/** Clear the statement cache (call when database is closed). */
export function clearSystemOneDecisionsCache(): void {
	stmtCache.clear();
}
