/**
 * `proxy_requests` rows for tests of the token proxy's telemetry contract, and
 * of every surface that writes or reads one (the request mapper, the stats
 * writer and aggregator, the report and the CLI). Each helper is one state a
 * stored row can be in, so a test names the state it is about instead of
 * rebuilding it:
 *
 * - {@link legacyProxyRow}: written before the contract. No effective mode, no
 *   block counts and no record of how the provider's counts were given. All
 *   three are unknown, not zero.
 * - {@link passthroughProxyRow}: the proxy never read the body.
 * - {@link skippedProxyRow}: a compress mode request whose body was forwarded
 *   unread.
 * - {@link currentProxyRow}: a compress mode request that was read, with every
 *   fact present and consistent.
 *
 * Treat the constants as read-only. A test that needs a variation spreads one
 * or passes overrides.
 */

import {
	PROXY_PROVIDER_USAGE_CLASSES,
	type ProxyBlockCounts,
	type ProxyEffectiveness,
	type ProxyProviderCoverage,
	type ProxyRequest,
} from '../../shared/stats-types';
import type { TokenProxySkipReason } from '../../shared/local-models/token-proxy';

/** A row as the recorder takes it: everything but the generated id. */
export type ProxyRow = Omit<ProxyRequest, 'id'>;

/**
 * Block counts that hold every rule of the contract: 9 candidates are 3 below
 * the threshold, 1 the cache refused, 2 kept and 3 shortened (the rows below
 * say `blocksCompressed: 3`), and 2 of the 5 decided came from the cache.
 */
export const CONSISTENT_BLOCK_COUNTS: Readonly<ProxyBlockCounts> = Object.freeze({
	protected: 0,
	vetoed: Object.freeze({ failed: 1, recovery: 0, retrieval: 2 }),
	candidates: 9,
	belowThreshold: 3,
	kept: 2,
	storeFailed: 1,
	modelFailed: 1,
});

const BASE = {
	agentId: 'agent-alpha-0001',
	route: 'anthropic',
	kind: 'anthropic-messages',
	startedAt: 1_700_000_000_000,
	durationMs: 900,
	status: 200,
	outcome: 'completed',
	requestBytes: 40_000,
	sentBytes: 40_000,
	responseBytes: 1_500,
	blocksCompressed: 0,
	cacheHits: 0,
} as const;

/** A request the proxy only counted: bytes, and nothing it would have had to read. */
export function passthroughProxyRow(overrides: Partial<ProxyRow> = {}): ProxyRow {
	return { ...BASE, mode: 'passthrough', effectiveMode: 'passthrough', ...overrides };
}

/**
 * A compress mode request as an older build wrote it: tokens, latency, blocks
 * and cache hits, with the provider's counts, and neither `effectiveMode` nor
 * `blockCounts`.
 */
export function legacyProxyRow(overrides: Partial<ProxyRow> = {}): ProxyRow {
	return {
		...BASE,
		mode: 'compress',
		sentBytes: 30_000,
		originalTokens: 10_000,
		sentTokens: 7_500,
		addedLatencyMs: 12,
		blocksCompressed: 3,
		cacheHits: 2,
		compressorCounts: { logs: 2, json: 1 },
		newBlocks: [
			{ hash: 'a'.repeat(64), originalTokens: 2_400, compressedTokens: 300, compressors: ['logs'] },
		],
		providerInputTokens: 4_000,
		providerCacheReadTokens: 120_000,
		providerCacheWriteTokens: 0,
		providerOutputTokens: 600,
		...overrides,
	};
}

/**
 * A compress mode request the proxy read and shortened, with every telemetry
 * fact present: the answer named all four classes of provider usage.
 */
export function currentProxyRow(overrides: Partial<ProxyRow> = {}): ProxyRow {
	return {
		...legacyProxyRow(),
		effectiveMode: 'compress-early',
		blockCounts: { ...CONSISTENT_BLOCK_COUNTS, vetoed: { ...CONSISTENT_BLOCK_COUNTS.vetoed } },
		providerUsageReportedness: {
			input: 'reported',
			cacheRead: 'reported',
			cacheWrite: 'reported',
			output: 'reported',
		},
		...overrides,
	};
}

/**
 * A compress mode request whose body was forwarded unread. The mode in force is
 * known; there are no tokens, no latency to speak of and no block counts, because
 * nothing was counted.
 */
export function skippedProxyRow(
	reason: TokenProxySkipReason,
	overrides: Partial<ProxyRow> = {}
): ProxyRow {
	return {
		...BASE,
		mode: 'compress',
		effectiveMode: 'compress-early',
		skipReason: reason,
		...overrides,
	};
}

/**
 * What the effectiveness aggregation answers for a range with no request, written
 * out in full on purpose: every block present, every count 0 and every unknown
 * stated as one. A fresh object each call, so a test may change it.
 */
export function emptyProxyEffectiveness(): ProxyEffectiveness {
	const providerClasses = Object.fromEntries(
		PROXY_PROVIDER_USAGE_CLASSES.map((usageClass) => [
			usageClass,
			{
				tokens: { kind: 'measured', unit: 'tokens', value: null, unknown: 'not-observed' },
				rows: {
					reported: 0,
					derived: 0,
					'not-applicable': 0,
					unreported: 0,
					legacy: 0,
					absent: 0,
				},
			},
		])
	) as ProxyProviderCoverage;
	return {
		traffic: { carried: 0, read: 0, skipped: 0, shortened: 0, blocksShortened: 0 },
		blocks: { coverage: { scope: 'range', counted: 0, of: 0 }, counts: null },
		skips: [],
		latency: { timed: 0, untimed: 0, distribution: null, unknown: 'not-read' },
		algorithms: { uniqueBlocks: 0, algorithms: [] },
		providerClasses,
		trend: [],
	};
}

/**
 * Where a value holds a string, as dotted paths (`newBlocks[].hash`). An array
 * adds `[]` and its paths are listed once. A row may hold free text nowhere: the
 * paths of a row are the closed set the contract allows, so a new text field
 * shows up as a new path.
 */
export function stringPaths(value: unknown, path = ''): string[] {
	if (typeof value === 'string') return [path];
	if (Array.isArray(value)) {
		return [...new Set(value.flatMap((item) => stringPaths(item, `${path}[]`)))];
	}
	if (value !== null && typeof value === 'object') {
		return Object.entries(value).flatMap(([key, item]) =>
			stringPaths(item, path === '' ? key : `${path}.${key}`)
		);
	}
	return [];
}
