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
import {
	TOKEN_PROXY_OPPORTUNITY_NOTE,
	TOKEN_PROXY_UNAVAILABLE_IDENTITY,
	type TokenProxyReadOpportunities,
	type TokenProxyReport,
	type TokenProxyRecoveryObservations,
	type TokenProxyRecoveryReadCounts,
	type TokenProxySkipReason,
} from '../../shared/local-models/token-proxy';

/** A row as the recorder takes it: everything but the generated id. */
export type ProxyRow = Omit<ProxyRequest, 'id'>;

/** An empty listener/usage report, shared by Gateway and Models inspection tests. */
export function proxyReport(overrides: Partial<TokenProxyReport> = {}): TokenProxyReport {
	return {
		status: { port: null, running: false, agentIds: [], lastError: null, gatewayUrls: null },
		agents: [],
		usage: null,
		recentCompressions: [],
		...overrides,
	};
}

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
 * What the effectiveness aggregation answers for a busy range of 120 requests,
 * written out in full and consistent in the ways the contract demands: the
 * candidates are the sum of their parts, the six readings of each provider class
 * add up to the 120 requests, and the algorithms overlap (270 algorithm-blocks
 * over 200 unique blocks). The latency has a distribution; a test of fewer
 * samples overrides `latency`. A fresh object each call, so a test may change it.
 */
export function busyProxyEffectiveness(): ProxyEffectiveness {
	const range = (counted: number) => ({ scope: 'range' as const, counted, of: 120 });
	const tokens = (value: number, counted: number) => ({
		kind: 'measured' as const,
		unit: 'tokens' as const,
		value,
		coverage: range(counted),
	});
	const rows = (counts: Partial<Record<keyof ProxyProviderCoverage['input']['rows'], number>>) => ({
		...emptyProxyEffectiveness().providerClasses.input.rows,
		...counts,
	});
	return {
		traffic: { carried: 120, read: 100, skipped: 8, shortened: 60, blocksShortened: 210 },
		blocks: {
			coverage: { scope: 'range', counted: 90, of: 100 },
			counts: {
				protected: 120,
				vetoed: { failed: 3, recovery: 0, retrieval: 5 },
				candidates: 300,
				belowThreshold: 80,
				kept: 50,
				storeFailed: 10,
				modelFailed: 2,
				shortened: 160,
				verdictReuse: 40,
				requestsWithCandidates: 85,
			},
		},
		skips: [
			{ reason: 'not-text', requests: 5 },
			{ reason: 'failed', requests: 3 },
		],
		latency: {
			timed: 98,
			untimed: 2,
			distribution: {
				count: 98,
				min: 4,
				p50: 12,
				p75: 20,
				p90: 33,
				p95: 80,
				p99: 1_200,
				max: 1_900,
			},
		},
		algorithms: {
			uniqueBlocks: 200,
			algorithms: [
				{ algorithm: 'json', blocks: 150, requests: 40 },
				{ algorithm: 'logs', blocks: 100, requests: 30 },
				{ algorithm: 'model', blocks: 20, requests: 10 },
			],
		},
		providerClasses: {
			input: {
				tokens: tokens(1_200_000, 100),
				rows: rows({ reported: 90, derived: 10, unreported: 12, legacy: 8 }),
			},
			cacheRead: {
				tokens: tokens(4_100_000, 100),
				rows: rows({ reported: 100, unreported: 12, legacy: 8 }),
			},
			cacheWrite: {
				tokens: tokens(0, 50),
				rows: rows({ reported: 50, 'not-applicable': 50, unreported: 12, legacy: 8 }),
			},
			output: {
				tokens: tokens(61_000, 112),
				rows: rows({ reported: 112, legacy: 8 }),
			},
		},
		trend: [],
	};
}

const NO_READS: Readonly<TokenProxyRecoveryReadCounts> = Object.freeze({
	invocations: 0,
	rangedInvocations: 0,
	recoveredOriginals: 0,
	unavailableBlocks: 0,
	missingOriginals: 0,
	failedReads: 0,
	returnedOriginalBytes: 0,
	returnedOriginalTokenEstimate: 0,
});

/**
 * The recovery snapshot the canonical block reader gives, from the reads of each
 * caller. The top-level counters are the sum of the two parts, as they are until
 * a counter saturates. With no argument nothing was read back.
 */
export function recoveryObservations(
	byCaller: {
		mcpRetrieveTool?: Partial<TokenProxyRecoveryReadCounts>;
		otherReads?: Partial<TokenProxyRecoveryReadCounts>;
	} = {},
	saturated = false
): TokenProxyRecoveryObservations {
	const mcpRetrieveTool = { ...NO_READS, ...byCaller.mcpRetrieveTool };
	const otherReads = { ...NO_READS, ...byCaller.otherReads };
	const total = Object.fromEntries(
		(Object.keys(NO_READS) as Array<keyof TokenProxyRecoveryReadCounts>).map((key) => [
			key,
			mcpRetrieveTool[key] + otherReads[key],
		])
	) as unknown as TokenProxyRecoveryReadCounts;
	return {
		scope: 'process-lifetime',
		coverage: 'canonical-block-reader',
		tokenCountKind: 'character-estimate',
		cliInvocations: null,
		modelExposure: 'unknown',
		unobservedRetrievals: 'unknown',
		...total,
		byCaller: { mcpRetrieveTool, otherReads },
		saturated,
	};
}

/**
 * What the read-opportunity observer reports after an hour: 412 requests
 * examined, 38 with a read among their newest results, and the reads, re-read
 * previews and outlines it related (with the reasons it refused some), plus one
 * unchanged re-read preview that was never applied. Consistent in the ways the
 * contract demands: observation only, nothing realized, an estimate at 4
 * characters per token. A fresh object each call, so a test may change it.
 */
export function readOpportunities(
	overrides: Partial<TokenProxyReadOpportunities> = {}
): TokenProxyReadOpportunities {
	return {
		version: 1,
		mode: 'observation',
		note: TOKEN_PROXY_OPPORTUNITY_NOTE,
		realized: false,
		tokenCountKind: 'character-estimate',
		since: Date.now() - 3_600_000,
		coverage: {
			scope: 'process-lifetime',
			attribution: 'newest-tool-results',
			observed: 412,
			withReads: 38,
			incomplete: 0,
			skipped: { busy: 2, 'too-large': 1, unreadable: 0, 'no-workspace': 0, failed: 0 },
		},
		identity: {
			known: ['agent'],
			unavailable: [...TOKEN_PROXY_UNAVAILABLE_IDENTITY],
			note: 'The proxy knows an agent, not a tab.',
		},
		limits: {
			bodyChars: 8388608,
			readsPerRequest: 256,
			previewPairs: 64,
			outlineSources: 32,
			recentPreviews: 25,
			previewTextChars: 8192,
		},
		reads: {
			examined: 41,
			first: 20,
			identical: 9,
			changed: 4,
			unsupported: 8,
			unsupportedByReason: { 'partial-range': 3, 'outside-workspace': 5 },
		},
		previews: {
			examined: 13,
			unchanged: 9,
			delta: 3,
			unsupported: 1,
			unsupportedByReason: { 'insufficient-reduction': 1 },
			potentialChars: 16800,
			potentialTokens: 4200,
		},
		outlines: {
			examined: 13,
			outlined: 11,
			unsupported: 2,
			unsupportedByReason: { 'parse-error': 2 },
			potentialChars: 124000,
			potentialTokens: 31000,
		},
		recent: [
			{
				kind: 'unchanged-read',
				observedAt: Date.now() - 120_000,
				agentId: 'agent-1',
				route: 'anthropic',
				requestKind: 'anthropic-messages',
				tool: 'Read',
				callId: 'toolu_02',
				path: '/work/app/src/a.ts',
				sourceHash: '3fa2c1d9e0b1',
				baseline: { callId: 'toolu_01', hash: '3fa2c1d9e0b1' },
				baselineBasis: 'same-request-delivered-whole',
				delivery: 'whole',
				potential: {
					kind: 'potential-reduction',
					realized: false,
					basis: 'text-as-sent',
					tokenCountKind: 'character-estimate',
					fullChars: 4800,
					fullTokens: 1200,
					previewChars: 160,
					previewTokens: 40,
					reducibleChars: 4640,
					reducibleTokens: 1160,
				},
				parser: null,
				changes: null,
				text: '[maestro-preview unchanged-read baseline=toolu_01 sha256=3fa2c1d9e0b1 lines=120]',
				textChars: 80,
				cut: false,
				redacted: false,
			},
		],
		...overrides,
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
