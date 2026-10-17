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
import { generateId, getTimeRangeStart, LOG_CONTEXT, StatementCache } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

const INSERT_SQL = `
  INSERT INTO proxy_requests
    (id, agent_id, route, kind, mode, started_at, duration_ms, status, outcome,
     request_bytes, sent_bytes, response_bytes, original_tokens, sent_tokens,
     added_latency_ms, blocks_compressed, cache_hits, compressor_counts, new_blocks, skip_reason,
     routed_to)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function roundedOrNull(value: number | undefined): number | null {
	return value === undefined ? null : Math.round(value);
}

/** Record one request. Returns the generated id. */
export function recordProxyRequest(
	db: Database.Database,
	request: Omit<ProxyRequest, 'id'>
): string {
	const id = generateId();
	const counts = request.compressorCounts;
	const hasCounts = counts !== undefined && Object.values(counts).some((count) => count > 0);
	const blocks = request.newBlocks;
	stmtCache
		.get(db, INSERT_SQL)
		.run(
			id,
			request.agentId ?? null,
			request.route,
			request.kind,
			request.mode,
			request.startedAt,
			Math.round(request.durationMs),
			request.status,
			request.outcome,
			request.requestBytes,
			request.sentBytes,
			request.responseBytes,
			roundedOrNull(request.originalTokens),
			roundedOrNull(request.sentTokens),
			roundedOrNull(request.addedLatencyMs),
			request.blocksCompressed,
			request.cacheHits,
			hasCounts ? JSON.stringify(counts) : null,
			blocks && blocks.length > 0 ? JSON.stringify(blocks) : null,
			request.skipReason ?? null,
			request.routedTo ?? null
		);
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
}

function toTotals(row: Omit<AgentTotalsRow, 'agent_id'>): ProxyRequestTotals {
	return {
		requests: row.requests,
		compressRequests: row.compress_requests,
		originalTokens: row.original_tokens,
		sentTokens: row.sent_tokens,
		tokensSaved: row.original_tokens - row.sent_tokens,
		avgAddedLatencyMs:
			row.compress_requests > 0 ? Math.round(row.added_latency_ms / row.compress_requests) : 0,
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
        COALESCE(SUM(added_latency_ms), 0) AS added_latency_ms
      FROM proxy_requests
      WHERE started_at >= ?
      GROUP BY agent_id
      ORDER BY requests DESC
    `
	);
	const rows = stmt.all(getTimeRangeStart(range)) as AgentTotalsRow[];
	const sum = {
		requests: 0,
		compress_requests: 0,
		original_tokens: 0,
		sent_tokens: 0,
		added_latency_ms: 0,
	};
	const byAgent: ProxyAgentTotals[] = rows.map((row) => {
		sum.requests += row.requests;
		sum.compress_requests += row.compress_requests;
		sum.original_tokens += row.original_tokens;
		sum.sent_tokens += row.sent_tokens;
		sum.added_latency_ms += row.added_latency_ms;
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
