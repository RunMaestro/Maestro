/**
 * Token Proxy Request CRUD Operations
 *
 * One row per model request the Maestro token proxy carried (see
 * `proxy_requests` in schema.ts). The proxy records what it received, what it
 * sent, and how long it held the request, so the Local Models tab can show the
 * tokens it saved, the latency it added, and the blocks it last shortened.
 */

import type Database from 'better-sqlite3';
import type {
	ProxyAgentTotals,
	ProxyCompressedBlock,
	ProxyCompressionEntry,
	ProxyRequest,
	ProxyRequestTotals,
	ProxyRequestUsage,
	StatsTimeRange,
} from '../../shared/stats-types';
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

interface AgentTotalsRow {
	agent_id: string | null;
	requests: number;
	compress_requests: number;
	original_tokens: number;
	sent_tokens: number;
	added_latency_ms: number;
	provider_requests: number;
	provider_input_tokens: number;
	provider_cache_read_tokens: number;
	provider_cache_write_tokens: number;
	provider_output_tokens: number;
}

type TotalsRow = Omit<AgentTotalsRow, 'agent_id'>;

function toTotals(row: TotalsRow): ProxyRequestTotals {
	return {
		requests: row.requests,
		compressRequests: row.compress_requests,
		originalTokens: row.original_tokens,
		sentTokens: row.sent_tokens,
		tokensSaved: row.original_tokens - row.sent_tokens,
		avgAddedLatencyMs:
			row.compress_requests > 0 ? Math.round(row.added_latency_ms / row.compress_requests) : 0,
		provider: {
			requests: row.provider_requests,
			inputTokens: row.provider_input_tokens,
			cacheReadTokens: row.provider_cache_read_tokens,
			cacheWriteTokens: row.provider_cache_write_tokens,
			outputTokens: row.provider_output_tokens,
		},
	};
}

/**
 * What the proxy carried within the time range, in total and per agent. Tokens
 * and latency cover only the requests whose body the proxy read: a passthrough
 * request counts as a request and nothing else.
 */
export function getProxyRequestUsage(
	db: Database.Database,
	range: StatsTimeRange
): ProxyRequestUsage {
	const stmt = stmtCache.get(
		db,
		`
      SELECT
        agent_id,
        COUNT(*) AS requests,
        SUM(CASE WHEN original_tokens IS NOT NULL THEN 1 ELSE 0 END) AS compress_requests,
        COALESCE(SUM(original_tokens), 0) AS original_tokens,
        COALESCE(SUM(sent_tokens), 0) AS sent_tokens,
        COALESCE(SUM(added_latency_ms), 0) AS added_latency_ms,
        SUM(CASE WHEN provider_input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS provider_requests,
        COALESCE(SUM(provider_input_tokens), 0) AS provider_input_tokens,
        COALESCE(SUM(provider_cache_read_tokens), 0) AS provider_cache_read_tokens,
        COALESCE(SUM(provider_cache_write_tokens), 0) AS provider_cache_write_tokens,
        COALESCE(SUM(provider_output_tokens), 0) AS provider_output_tokens
      FROM proxy_requests
      WHERE started_at >= ?
      GROUP BY agent_id
      ORDER BY requests DESC
    `
	);
	const rows = stmt.all(getTimeRangeStart(range)) as AgentTotalsRow[];
	const sum: TotalsRow = {
		requests: 0,
		compress_requests: 0,
		original_tokens: 0,
		sent_tokens: 0,
		added_latency_ms: 0,
		provider_requests: 0,
		provider_input_tokens: 0,
		provider_cache_read_tokens: 0,
		provider_cache_write_tokens: 0,
		provider_output_tokens: 0,
	};
	const byAgent: ProxyAgentTotals[] = rows.map((row) => {
		for (const key of Object.keys(sum) as Array<keyof TotalsRow>) sum[key] += row[key];
		return { agentId: row.agent_id, ...toTotals(row) };
	});
	return { range, totals: toTotals(sum), byAgent };
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
