/**
 * What the Maestro token proxy carried, written to and read from the stats
 * database (`proxy_requests`).
 *
 * One row per request that holds a message list. A request for anything else
 * (token counting, a model list) is forwarded and logged but not recorded: it
 * has no tokens to save and would only dilute the averages.
 *
 * Recording is best-effort, on the same contract as the task router's
 * `local_model_runs`: it honors `statsCollectionEnabled`, and a stats write
 * that fails is reported and swallowed, because a request that was forwarded
 * correctly must never be failed by its own bookkeeping.
 */

import type {
	ProxyBlockCounts,
	ProxyCompressionEntry,
	ProxyRequest,
	ProxyRequestUsage,
	StatsTimeRange,
} from '../../../shared/stats-types';
import {
	isCompressingTokenProxyMode,
	proxyBlockCountsProblem,
} from '../../../shared/local-models/token-proxy';
import { getStatsDB } from '../../stats/singleton';
import { isStatsCollectionEnabled } from '../../stats/utils';
import { getSettingsStore } from '../../stores/getters';
import { logger } from '../../utils/logger';
import { captureException, captureMessage } from '../../utils/sentry';
import type { CompressRequestStats } from './compress';
import type { TokenProxyRequestLog } from './server';

const LOG_CONTEXT = '[TokenProxy]';

/** The window the Gateway section and `models proxy status` sum over. */
export const TOKEN_PROXY_USAGE_RANGE: StatsTimeRange = 'month';

/** How many rows the "Recent compressions" list holds. */
export const TOKEN_PROXY_RECENT_COMPRESSIONS = 25;

/** What the compressor counted for one request, in the shape a row stores. */
function blockCountsFromStats(stats: CompressRequestStats): ProxyBlockCounts {
	const vetoes = stats.eligibilityVetoes;
	return {
		protected: stats.protected,
		// The compressor leaves out a veto it never applied. It ran, so that is a
		// count of 0 and not an unknown.
		vetoed: {
			failed: vetoes?.failed ?? 0,
			recovery: vetoes?.recovery ?? 0,
			retrieval: vetoes?.retrieval ?? 0,
		},
		candidates: stats.candidates,
		belowThreshold: stats.belowThreshold,
		kept: stats.kept,
		storeFailed: stats.storeFailures,
		modelFailed: stats.modelFailures,
	};
}

/**
 * The block counts a request's row may state, or undefined for an unknown.
 *
 * Counts describe what the proxy sent, so they exist only where the body was read,
 * the compressor returned and the body went out as it decided. `stats` is
 * therefore undefined for a passthrough request, for one forwarded as it arrived
 * and for one a background target answered. Counts that break a rule the
 * compressor keeps are a bug of ours: they are reported and left unstored,
 * because counts that disagree are worse than none.
 */
function storableBlockCounts(
	entry: TokenProxyRequestLog,
	stats: CompressRequestStats | undefined,
	blocksCompressed: number,
	cacheHits: number
): ProxyBlockCounts | undefined {
	if (!stats) return undefined;
	const blockCounts = blockCountsFromStats(stats);
	const problem = proxyBlockCountsProblem({ blockCounts, blocksCompressed, cacheHits });
	if (problem === null) return blockCounts;
	logger.warn(`Not storing the block counts of a proxy request: ${problem}`, LOG_CONTEXT);
	void captureMessage('Token proxy block counts break the telemetry contract', 'warning', {
		problem,
		route: entry.route,
		kind: entry.kind,
		mode: entry.mode,
	});
	return undefined;
}

/**
 * The stats row for one request, or null for a request that is not recorded.
 * Pure of the database, so the mapping can be tested without one.
 */
export function proxyRequestFromLog(entry: TokenProxyRequestLog): Omit<ProxyRequest, 'id'> | null {
	if (entry.route === null || entry.kind === 'other') return null;
	const compression = entry.compression;
	// A request forwarded as it arrived (any skip reason) was not shortened. When a
	// failure came after the compressor returned, what it counted describes a body
	// that did not go out, so none of it is credited to the row.
	const reduction = compression?.skipped ? undefined : compression;
	const stats = reduction?.stats;
	const blocksCompressed = stats?.compressed ?? 0;
	const cacheHits = stats?.cacheHits ?? 0;
	const blockCounts = storableBlockCounts(entry, stats, blocksCompressed, cacheHits);
	const newBlocks = (reduction?.blocks ?? [])
		.filter((block) => !block.cached)
		.map((block) => ({
			hash: block.hash,
			originalTokens: block.originalTokens,
			compressedTokens: block.compressedTokens,
			compressors: [...block.compressors],
		}));
	return {
		...(entry.agentId !== null ? { agentId: entry.agentId } : {}),
		route: entry.route,
		kind: entry.kind,
		// The table records whether a request was read and shortened, which both
		// compress modes do. The agent's mode itself is read from its record.
		mode: isCompressingTokenProxyMode(entry.mode) ? 'compress' : 'passthrough',
		// The mode in force for this request, so the two compress modes stay apart.
		// It is the log's own mode, never the agent's setting read later.
		effectiveMode: entry.mode,
		startedAt: entry.startedAt,
		durationMs: entry.durationMs,
		status: entry.status,
		outcome: entry.outcome,
		requestBytes: entry.requestBytes,
		sentBytes: entry.sentBytes,
		responseBytes: entry.responseBytes,
		...(compression?.originalTokens !== undefined
			? {
					originalTokens: compression.originalTokens,
					// Nothing was removed from a request forwarded as it arrived, whatever an
					// attempt before its failure estimated. The time it was held stays.
					sentTokens: reduction
						? (reduction.sentTokens ?? compression.originalTokens)
						: compression.originalTokens,
					addedLatencyMs: compression.addedLatencyMs,
				}
			: {}),
		blocksCompressed,
		cacheHits,
		...(blockCounts ? { blockCounts } : {}),
		...(stats ? { compressorCounts: { ...stats.compressors } } : {}),
		...(newBlocks.length > 0 ? { newBlocks } : {}),
		...(compression?.skipped ? { skipReason: compression.skipped } : {}),
		// Only the target: why a request stayed on the provider is in the log.
		...(entry.background?.routedTo ? { routedTo: entry.background.routedTo } : {}),
		...(entry.providerUsage
			? {
					providerInputTokens: entry.providerUsage.inputTokens,
					providerCacheReadTokens: entry.providerUsage.cacheReadTokens,
					providerCacheWriteTokens: entry.providerUsage.cacheWriteTokens,
					providerOutputTokens: entry.providerUsage.outputTokens,
				}
			: {}),
	};
}

/**
 * Record one request the proxy carried. Never throws: it runs in the server's
 * close handler, so the mapping sits inside the guard with the write, and
 * nothing is mapped while statistics are off.
 */
export function recordTokenProxyRequest(entry: TokenProxyRequestLog): void {
	try {
		if (!isStatsCollectionEnabled(getSettingsStore())) return;
		const db = getStatsDB();
		if (!db.isReady()) return;
		const request = proxyRequestFromLog(entry);
		if (!request) return;
		db.recordProxyRequest(request);
	} catch (error) {
		logger.warn(`Failed to record proxy request: ${error}`, LOG_CONTEXT);
		void captureException(error instanceof Error ? error : new Error(String(error)), {
			operation: 'stats:recordProxyRequest',
			route: entry.route,
		});
	}
}

export interface TokenProxyUsage {
	/** Null when the stats database cannot be read. */
	usage: ProxyRequestUsage | null;
	recentCompressions: ProxyCompressionEntry[];
}

/** What the proxy carried lately, and the blocks it last shortened. Never throws. */
export function readTokenProxyUsage(): TokenProxyUsage {
	try {
		const db = getStatsDB();
		if (!db.isReady()) return { usage: null, recentCompressions: [] };
		return {
			usage: db.getProxyRequestUsage(TOKEN_PROXY_USAGE_RANGE),
			recentCompressions: db.getRecentProxyCompressions(TOKEN_PROXY_RECENT_COMPRESSIONS),
		};
	} catch (error) {
		logger.warn(`Failed to read proxy usage: ${error}`, LOG_CONTEXT);
		return { usage: null, recentCompressions: [] };
	}
}
