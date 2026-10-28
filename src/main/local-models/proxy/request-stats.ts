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
	ProxyCompressionEntry,
	ProxyRequest,
	ProxyRequestUsage,
	StatsTimeRange,
} from '../../../shared/stats-types';
import { isCompressingTokenProxyMode } from '../../../shared/local-models/token-proxy';
import { getStatsDB } from '../../stats/singleton';
import { isStatsCollectionEnabled } from '../../stats/utils';
import { getSettingsStore } from '../../stores/getters';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import type { TokenProxyRequestLog } from './server';

const LOG_CONTEXT = '[TokenProxy]';

/** The window the Gateway section and `models proxy status` sum over. */
export const TOKEN_PROXY_USAGE_RANGE: StatsTimeRange = 'month';

/** How many rows the "Recent compressions" list holds. */
export const TOKEN_PROXY_RECENT_COMPRESSIONS = 25;

/**
 * The stats row for one request, or null for a request that is not recorded.
 * Pure, so the mapping can be tested without a database.
 */
export function proxyRequestFromLog(entry: TokenProxyRequestLog): Omit<ProxyRequest, 'id'> | null {
	if (entry.route === null || entry.kind === 'other') return null;
	const compression = entry.compression;
	const stats = compression?.stats;
	const newBlocks = (compression?.blocks ?? [])
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
					sentTokens: compression.sentTokens ?? compression.originalTokens,
					addedLatencyMs: compression.addedLatencyMs,
				}
			: {}),
		blocksCompressed: stats?.compressed ?? 0,
		cacheHits: stats?.cacheHits ?? 0,
		...(stats ? { compressorCounts: { ...stats.compressors } } : {}),
		...(newBlocks.length > 0 ? { newBlocks } : {}),
		...(compression?.skipped ? { skipReason: compression.skipped } : {}),
		// Only the target: why a request stayed on the provider is in the log.
		...(entry.background?.routedTo ? { routedTo: entry.background.routedTo } : {}),
	};
}

/** Record one request the proxy carried. Never throws. */
export function recordTokenProxyRequest(entry: TokenProxyRequestLog): void {
	const request = proxyRequestFromLog(entry);
	if (!request) return;
	try {
		if (!isStatsCollectionEnabled(getSettingsStore())) return;
		const db = getStatsDB();
		if (!db.isReady()) return;
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
