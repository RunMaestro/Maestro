/**
 * Token Proxy Request CRUD Operations
 *
 * One row per model request the Maestro token proxy carried (see
 * `proxy_requests` in schema.ts). The proxy records what it received, what it
 * sent, and how long it held the request, so the Local Models tab can show the
 * tokens it saved, the latency it added, and the blocks it last shortened.
 */

import type Database from 'better-sqlite3';
import { asTokenProxyRequestMode } from '../../shared/local-models/token-proxy';
import type {
	ProxyAgentTotals,
	ProxyCompressedBlock,
	ProxyCompressionEntry,
	ProxyEffectiveMode,
	ProxyModeTotals,
	ProxyRequest,
	ProxyRequestTotals,
	ProxyRequestUsage,
	ProxyRouteTotals,
	StatsTimeRange,
} from '../../shared/stats-types';
import { getProxyEffectiveness } from './proxy-effectiveness';
import { ADD_PROXY_REQUEST_TELEMETRY_COLUMNS } from './schema';
import { generateId, getTimeRangeStart, LOG_CONTEXT, StatementCache } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

/** The columns of `proxy_requests` that exist since migration v21, in table order. */
const REQUEST_COLUMNS = [
	'id',
	'agent_id',
	'route',
	'kind',
	'mode',
	'started_at',
	'duration_ms',
	'status',
	'outcome',
	'request_bytes',
	'sent_bytes',
	'response_bytes',
	'original_tokens',
	'sent_tokens',
	'added_latency_ms',
	'blocks_compressed',
	'cache_hits',
	'compressor_counts',
	'new_blocks',
	'skip_reason',
	'routed_to',
	'provider_input_tokens',
	'provider_cache_read_tokens',
	'provider_cache_write_tokens',
	'provider_output_tokens',
] as const;

/**
 * Migration v22's telemetry columns, named by the schema's own list: a column
 * added there is a column `recordProxyRequest()` must supply, or it does not
 * compile.
 */
type TelemetryColumn = (typeof ADD_PROXY_REQUEST_TELEMETRY_COLUMNS)[number]['name'];
type InsertColumn = (typeof REQUEST_COLUMNS)[number] | TelemetryColumn;

/** Every column an INSERT fills, in table order. The placeholders are made from it. */
const INSERT_COLUMNS: readonly InsertColumn[] = [
	...REQUEST_COLUMNS,
	...ADD_PROXY_REQUEST_TELEMETRY_COLUMNS.map((column) => column.name),
];

const INSERT_SQL = `
  INSERT INTO proxy_requests (${INSERT_COLUMNS.join(', ')})
  VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})
`;

function roundedOrNull(value: number | undefined): number | null {
	return value === undefined ? null : Math.round(value);
}

/**
 * Record one request. Returns the generated id.
 *
 * A fact the request does not state is stored as NULL, which every reader takes
 * as unknown. That holds for the telemetry columns above all: the nine block
 * counts go in together or not at all, and the four provider reportedness values
 * are the provider counts' record of how each got its number.
 */
export function recordProxyRequest(
	db: Database.Database,
	request: Omit<ProxyRequest, 'id'>
): string {
	const id = generateId();
	const counts = request.compressorCounts;
	const hasCounts = counts !== undefined && Object.values(counts).some((count) => count > 0);
	const blocks = request.newBlocks;
	const blockCounts = request.blockCounts;
	const reportedness = request.providerUsageReportedness;
	const values: Record<InsertColumn, string | number | null> = {
		id,
		agent_id: request.agentId ?? null,
		route: request.route,
		kind: request.kind,
		mode: request.mode,
		started_at: request.startedAt,
		duration_ms: Math.round(request.durationMs),
		status: request.status,
		outcome: request.outcome,
		request_bytes: request.requestBytes,
		sent_bytes: request.sentBytes,
		response_bytes: request.responseBytes,
		original_tokens: roundedOrNull(request.originalTokens),
		sent_tokens: roundedOrNull(request.sentTokens),
		added_latency_ms: roundedOrNull(request.addedLatencyMs),
		blocks_compressed: request.blocksCompressed,
		cache_hits: request.cacheHits,
		compressor_counts: hasCounts ? JSON.stringify(counts) : null,
		new_blocks: blocks && blocks.length > 0 ? JSON.stringify(blocks) : null,
		skip_reason: request.skipReason ?? null,
		routed_to: request.routedTo ?? null,
		provider_input_tokens: roundedOrNull(request.providerInputTokens),
		provider_cache_read_tokens: roundedOrNull(request.providerCacheReadTokens),
		provider_cache_write_tokens: roundedOrNull(request.providerCacheWriteTokens),
		provider_output_tokens: roundedOrNull(request.providerOutputTokens),
		effective_mode: request.effectiveMode ?? null,
		blocks_protected: blockCounts?.protected ?? null,
		blocks_vetoed_failed: blockCounts?.vetoed.failed ?? null,
		blocks_vetoed_recovery: blockCounts?.vetoed.recovery ?? null,
		blocks_vetoed_retrieval: blockCounts?.vetoed.retrieval ?? null,
		blocks_candidates: blockCounts?.candidates ?? null,
		blocks_below_threshold: blockCounts?.belowThreshold ?? null,
		blocks_kept: blockCounts?.kept ?? null,
		blocks_store_failed: blockCounts?.storeFailed ?? null,
		blocks_model_failed: blockCounts?.modelFailed ?? null,
		provider_input_reportedness: reportedness?.input ?? null,
		provider_cache_read_reportedness: reportedness?.cacheRead ?? null,
		provider_cache_write_reportedness: reportedness?.cacheWrite ?? null,
		provider_output_reportedness: reportedness?.output ?? null,
	};
	stmtCache.get(db, INSERT_SQL).run(...INSERT_COLUMNS.map((column) => values[column]));
	logger.debug(`Recorded proxy request: ${request.route} (${request.mode})`, LOG_CONTEXT);
	return id;
}

/** The sums behind a {@link ProxyRequestTotals}: one group of rows, or several rolled together. */
interface TotalsRow {
	requests: number;
	compress_requests: number;
	original_tokens: number;
	sent_tokens: number;
	added_latency_ms: number;
	/** Requests that carry a processing time: the divisor of the mean, which a missing time must not lower. */
	timed_requests: number;
	provider_requests: number;
	provider_input_tokens: number;
	provider_cache_read_tokens: number;
	provider_cache_write_tokens: number;
	provider_output_tokens: number;
}

/** What one scan returns: one agent, effective mode and stored provider route. */
interface GroupRow extends TotalsRow {
	agent_id: string | null;
	effective_mode: string | null;
	route: string;
}

function emptyTotals(): TotalsRow {
	return {
		requests: 0,
		compress_requests: 0,
		original_tokens: 0,
		sent_tokens: 0,
		added_latency_ms: 0,
		timed_requests: 0,
		provider_requests: 0,
		provider_input_tokens: 0,
		provider_cache_read_tokens: 0,
		provider_cache_write_tokens: 0,
		provider_output_tokens: 0,
	};
}

function toTotals(row: TotalsRow): ProxyRequestTotals {
	return {
		requests: row.requests,
		compressRequests: row.compress_requests,
		originalTokens: row.original_tokens,
		sentTokens: row.sent_tokens,
		tokensSaved: row.original_tokens - row.sent_tokens,
		avgAddedLatencyMs:
			row.timed_requests > 0 ? Math.round(row.added_latency_ms / row.timed_requests) : 0,
		timedRequests: row.timed_requests,
		provider: {
			requests: row.provider_requests,
			inputTokens: row.provider_input_tokens,
			cacheReadTokens: row.provider_cache_read_tokens,
			cacheWriteTokens: row.provider_cache_write_tokens,
			outputTokens: row.provider_output_tokens,
		},
	};
}

/** The groups' sums rolled up by one key. Every group lands in exactly one bucket, so the buckets add up to the whole. */
function rollUp<K>(rows: GroupRow[], keyOf: (row: GroupRow) => K): Map<K, TotalsRow> {
	const buckets = new Map<K, TotalsRow>();
	for (const row of rows) {
		const key = keyOf(row);
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = emptyTotals();
			buckets.set(key, bucket);
		}
		for (const field of Object.keys(bucket) as Array<keyof TotalsRow>) {
			// node:sqlite and better-sqlite3 disagree on integer types for an aggregate.
			bucket[field] += Number(row[field]);
		}
	}
	return buckets;
}

/** The order of modes among equals: the policies as they escalate, then the rows that do not say. */
const MODE_ORDER: ReadonlyArray<ProxyEffectiveMode | null> = [
	'passthrough',
	'compress',
	'compress-early',
	null,
];

/**
 * What the proxy carried within the time range: in total, per agent, per
 * effective mode, per route, and its effectiveness (blocks, skips, timing, algorithms,
 * provider classes, the days). Tokens and latency cover only the requests whose
 * body the proxy read: a passthrough request counts as a request and nothing
 * else.
 *
 * One scan sums every (agent, stored mode, route) group and the cuts are rolled
 * up from it, so the agents, the modes and the total are one partition of the
 * same rows. The mode of a row that does not state one (it predates
 * `effective_mode`) stays unknown, passthrough rows included: a mode is never
 * inferred from the stored `mode` or from an agent's setting.
 */
export function getProxyRequestUsage(
	db: Database.Database,
	range: StatsTimeRange
): ProxyRequestUsage {
	const startTime = getTimeRangeStart(range);
	const stmt = stmtCache.get(
		db,
		`
      SELECT
        agent_id,
        effective_mode,
        route,
        COUNT(*) AS requests,
        SUM(CASE WHEN original_tokens IS NOT NULL THEN 1 ELSE 0 END) AS compress_requests,
        COALESCE(SUM(original_tokens), 0) AS original_tokens,
        COALESCE(SUM(sent_tokens), 0) AS sent_tokens,
        COALESCE(SUM(added_latency_ms), 0) AS added_latency_ms,
        COUNT(added_latency_ms) AS timed_requests,
        SUM(CASE WHEN provider_input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS provider_requests,
        COALESCE(SUM(provider_input_tokens), 0) AS provider_input_tokens,
        COALESCE(SUM(provider_cache_read_tokens), 0) AS provider_cache_read_tokens,
        COALESCE(SUM(provider_cache_write_tokens), 0) AS provider_cache_write_tokens,
        COALESCE(SUM(provider_output_tokens), 0) AS provider_output_tokens
      FROM proxy_requests
      WHERE started_at >= ?
      GROUP BY agent_id, effective_mode, route
    `
	);
	const rows = stmt.all(startTime) as GroupRow[];

	const byAgent: ProxyAgentTotals[] = [...rollUp(rows, (row) => row.agent_id)]
		.map(([agentId, sums]) => ({ agentId, ...toTotals(sums) }))
		.sort((a, b) => b.requests - a.requests || (a.agentId ?? '').localeCompare(b.agentId ?? ''));
	// A stored text that names no known mode is one more row that does not say.
	const byMode: ProxyModeTotals[] = [
		...rollUp(rows, (row) => asTokenProxyRequestMode(row.effective_mode)),
	]
		.map(([effectiveMode, sums]) => ({ effectiveMode, ...toTotals(sums) }))
		.sort(
			(a, b) =>
				b.requests - a.requests ||
				MODE_ORDER.indexOf(a.effectiveMode) - MODE_ORDER.indexOf(b.effectiveMode)
		);
	const totals = [...rollUp(rows, () => 'all').values()][0] ?? emptyTotals();
	const byRoute: ProxyRouteTotals[] = [...rollUp(rows, (row) => row.route)]
		.map(([route, sums]) => ({ route, ...toTotals(sums) }))
		.sort((a, b) => b.requests - a.requests || a.route.localeCompare(b.route));

	return {
		range,
		totals: toTotals(totals),
		byAgent,
		byMode,
		byRoute,
		effectiveness: getProxyEffectiveness(db, startTime),
	};
}

function isCompressedBlock(value: unknown): value is ProxyCompressedBlock {
	const block = value as Partial<ProxyCompressedBlock> | null;
	return (
		typeof block === 'object' &&
		block !== null &&
		typeof block.hash === 'string' &&
		typeof block.originalTokens === 'number' &&
		typeof block.compressedTokens === 'number' &&
		Array.isArray(block.compressors)
	);
}

/** The blocks of one row. A column that does not parse is read as no blocks. */
function parseBlocks(raw: string): ProxyCompressedBlock[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter(isCompressedBlock) : [];
	} catch {
		return [];
	}
}

/**
 * The blocks the proxy most recently shortened, newest first. Each block is
 * listed once: a row holds only the blocks its request shortened for the first
 * time, and the cache makes that verdict the only one a block ever gets.
 */
export function getRecentProxyCompressions(
	db: Database.Database,
	limit: number
): ProxyCompressionEntry[] {
	const wanted = Math.max(0, Math.floor(limit));
	if (wanted === 0) return [];
	const stmt = stmtCache.get(
		db,
		`
      SELECT agent_id, started_at, new_blocks FROM proxy_requests
      WHERE new_blocks IS NOT NULL
      ORDER BY started_at DESC
      LIMIT ?
    `
	);
	// Every row holds at least one block, so `wanted` rows are always enough.
	const rows = stmt.all(wanted) as Array<{
		agent_id: string | null;
		started_at: number;
		new_blocks: string;
	}>;
	const entries: ProxyCompressionEntry[] = [];
	for (const row of rows) {
		for (const block of parseBlocks(row.new_blocks)) {
			if (entries.length === wanted) return entries;
			entries.push({ ...block, agentId: row.agent_id, at: row.started_at });
		}
	}
	return entries;
}

/** Clear the statement cache (call when database is closed). */
export function clearProxyRequestsCache(): void {
	stmtCache.clear();
}
