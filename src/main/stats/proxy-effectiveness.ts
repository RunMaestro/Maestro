/**
 * Token Proxy Effectiveness Aggregation
 *
 * What the Maestro token proxy did with the requests it carried in a time
 * range, beyond the totals `getProxyRequestUsage()` sums: how many requests it
 * read and shortened, what it did with their tool-result blocks, why it
 * forwarded some without the compressor's result, how long it held them, which
 * algorithms did the shortening, how each class of the provider's usage got its
 * number, and how the days went. One read behind the Settings Gateway section,
 * the Usage Dashboard's Models tab and the CLI, so they cannot disagree.
 *
 * Rules the figures keep (the contract is `ProxyEffectiveness` in
 * shared/stats-types.ts):
 *
 *   - Unknown is not zero. A fact the rows do not state stays unknown: block
 *     counts exist only on rows written since migration v22 that the compressor
 *     ran on, a provider class is measured only where the answer named it, and a
 *     missing processing time is left out of the distribution.
 *   - Kinds do not mix. Counts, estimates (characters / 4) and the provider's own
 *     counts sit in separate fields and are never summed into one number.
 *   - Overlap is not summed. A block that several algorithms shortened is listed
 *     under each, apart from the unique blocks.
 *   - Verdict reuse (`cache_hits`, Maestro's compression cache) is a different
 *     fact from the provider's prompt cache (`provider_cache_read_tokens`).
 *
 * Most facts come from one grouped scan, rolled up in JavaScript. Three more
 * scans answer what a roll-up cannot: the algorithms (each distinct JSON cell is
 * parsed once), the timings (percentiles need the values) and the days.
 */

import type Database from 'better-sqlite3';
import {
	PROXY_LATENCY_MIN_SAMPLES,
	TOKEN_PROXY_PROVIDER_CLASS_LABELS,
	asTokenProxySkipReason,
	proxyFigure,
	type ProxyProviderClassReading,
} from '../../shared/local-models/token-proxy';
import { percentilesFromSorted } from '../../shared/percentiles';
import {
	PROXY_PROVIDER_USAGE_CLASSES,
	type ProxyAlgorithmBreakdown,
	type ProxyAlgorithmCount,
	type ProxyBlockReport,
	type ProxyEffectiveness,
	type ProxyLatency,
	type ProxyProviderCoverage,
	type ProxyProviderUsageClass,
	type ProxySkipCount,
	type ProxyTrendDay,
} from '../../shared/stats-types';

// ============================================================================
// The grouped scan
// ============================================================================

/** The provider count and the reportedness column of each class, as the table names them. */
const PROVIDER_COLUMNS: Record<ProxyProviderUsageClass, { tokens: string; reportedness: string }> =
	{
		input: { tokens: 'provider_input_tokens', reportedness: 'provider_input_reportedness' },
		cacheRead: {
			tokens: 'provider_cache_read_tokens',
			reportedness: 'provider_cache_read_reportedness',
		},
		cacheWrite: {
			tokens: 'provider_cache_write_tokens',
			reportedness: 'provider_cache_write_reportedness',
		},
		output: { tokens: 'provider_output_tokens', reportedness: 'provider_output_reportedness' },
	};

/** Every way a class can be read, from the labels that must name each of them. */
const READINGS = Object.keys(TOKEN_PROXY_PROVIDER_CLASS_LABELS) as ProxyProviderClassReading[];

/**
 * The answer named no usage at all. The writer stores the four counts together,
 * and `proxyProviderClassReading()` calls a row `absent` when none is present.
 */
const NO_PROVIDER_USAGE = `(${Object.values(PROVIDER_COLUMNS)
	.map((column) => `${column.tokens} IS NULL`)
	.join(' AND ')})`;

const RECORDED_STATUSES = "'reported', 'derived', 'not-applicable', 'unreported'";

/**
 * Whether a row reads one way for a class, as `proxyProviderClassReading()`
 * reads it. A status this build does not know reads as `legacy`: unknown, like
 * a row that records none. Each row satisfies exactly one reading per class.
 */
function readingPredicate(reportedness: string, reading: ProxyProviderClassReading): string {
	if (reading === 'absent') return NO_PROVIDER_USAGE;
	const named = `NOT ${NO_PROVIDER_USAGE}`;
	if (reading === 'legacy') {
		return `(${named} AND (${reportedness} IS NULL OR ${reportedness} NOT IN (${RECORDED_STATUSES})))`;
	}
	return `(${named} AND ${reportedness} = '${reading}')`;
}

function readingAlias(
	usageClass: ProxyProviderUsageClass,
	reading: ProxyProviderClassReading
): string {
	return `${usageClass}_${reading.replace('-', '_')}_rows`;
}

function tokensAlias(usageClass: ProxyProviderUsageClass): string {
	return `${usageClass}_measured_tokens`;
}

/** A request carries block counts when the compressor ran: the writer stores the nine together or none. */
const COUNTED = 'blocks_candidates IS NOT NULL';

/**
 * Every figure the grouped scan sums, as `alias: SQL expression`. A NULL sum
 * (no row supplied the value) is read as 0 here, so what an alias means when it
 * is 0 is decided by the coverage beside it (`counted_requests`, the rows of a
 * reading), never by the number.
 */
const SUMMARY_EXPRESSIONS: Record<string, string> = {
	requests: 'COUNT(*)',
	read_requests: 'SUM(CASE WHEN original_tokens IS NOT NULL THEN 1 ELSE 0 END)',
	shortened_requests: 'SUM(CASE WHEN blocks_compressed > 0 THEN 1 ELSE 0 END)',
	blocks_shortened: 'SUM(blocks_compressed)',
	timed_requests: 'COUNT(added_latency_ms)',
	untimed_read_requests:
		'SUM(CASE WHEN original_tokens IS NOT NULL AND added_latency_ms IS NULL THEN 1 ELSE 0 END)',
	counted_requests: 'COUNT(blocks_candidates)',
	counted_with_candidates: 'SUM(CASE WHEN blocks_candidates > 0 THEN 1 ELSE 0 END)',
	counted_shortened: `SUM(CASE WHEN ${COUNTED} THEN blocks_compressed END)`,
	counted_verdict_reuse: `SUM(CASE WHEN ${COUNTED} THEN cache_hits END)`,
	protected_blocks: 'SUM(blocks_protected)',
	vetoed_failed: 'SUM(blocks_vetoed_failed)',
	vetoed_recovery: 'SUM(blocks_vetoed_recovery)',
	vetoed_retrieval: 'SUM(blocks_vetoed_retrieval)',
	candidate_blocks: 'SUM(blocks_candidates)',
	below_threshold_blocks: 'SUM(blocks_below_threshold)',
	kept_blocks: 'SUM(blocks_kept)',
	store_failed_blocks: 'SUM(blocks_store_failed)',
	model_failed_blocks: 'SUM(blocks_model_failed)',
	...Object.fromEntries(
		PROXY_PROVIDER_USAGE_CLASSES.flatMap((usageClass): Array<[string, string]> => {
			const { tokens, reportedness } = PROVIDER_COLUMNS[usageClass];
			return [
				// Only a class the answer reported, or that follows from what it reported,
				// says anything: a default 0 and a legacy number of unknown origin do not.
				[
					tokensAlias(usageClass),
					`SUM(CASE WHEN ${reportedness} IN ('reported', 'derived') THEN ${tokens} END)`,
				],
				...READINGS.map((reading): [string, string] => [
					readingAlias(usageClass, reading),
					`SUM(CASE WHEN ${readingPredicate(reportedness, reading)} THEN 1 ELSE 0 END)`,
				]),
			];
		})
	),
};

const SUMMARY_ALIASES = Object.keys(SUMMARY_EXPRESSIONS);

const SUMMARY_COLUMNS = SUMMARY_ALIASES.map(
	(alias) => `COALESCE(${SUMMARY_EXPRESSIONS[alias]}, 0) AS ${alias}`
).join(',\n         ');

/** Every name and expression in it is a constant of this module, never input. */
const SUMMARY_SQL = `
  SELECT skip_reason,
         ${SUMMARY_COLUMNS}
  FROM proxy_requests
  WHERE started_at >= ?
  GROUP BY skip_reason
`;

type Summary = Record<string, number>;

function numberOf(row: Record<string, unknown>, key: string): number {
	// node:sqlite and better-sqlite3 disagree on integer types for an aggregate.
	return Number(row[key] ?? 0);
}

/** The range summed over every skip reason, and the requests under each reason. */
function readSummary(
	db: Database.Database,
	startTime: number
): { summary: Summary; skips: ProxySkipCount[] } {
	const rows = db.prepare(SUMMARY_SQL).all(startTime) as Array<Record<string, unknown>>;
	const summary: Summary = Object.fromEntries(SUMMARY_ALIASES.map((alias) => [alias, 0]));
	const skipped = new Map<ProxySkipCount['reason'], number>();
	for (const row of rows) {
		for (const alias of SUMMARY_ALIASES) summary[alias] += numberOf(row, alias);
		if (row.skip_reason === null || row.skip_reason === undefined) continue;
		// Open text in the table: a reason another build wrote is still a skip.
		const reason = asTokenProxySkipReason(row.skip_reason) ?? 'unrecognized';
		skipped.set(reason, (skipped.get(reason) ?? 0) + numberOf(row, 'requests'));
	}
	const skips = [...skipped.entries()]
		.map(([reason, requests]) => ({ reason, requests }))
		.sort((a, b) => b.requests - a.requests || a.reason.localeCompare(b.reason));
	return { summary, skips };
}

// ============================================================================
// Shaping
// ============================================================================

function blockReport(summary: Summary): ProxyBlockReport {
	const counted = summary.counted_requests;
	return {
		coverage: { scope: 'range', counted, of: summary.read_requests },
		counts:
			counted === 0
				? null
				: {
						protected: summary.protected_blocks,
						vetoed: {
							failed: summary.vetoed_failed,
							recovery: summary.vetoed_recovery,
							retrieval: summary.vetoed_retrieval,
						},
						candidates: summary.candidate_blocks,
						belowThreshold: summary.below_threshold_blocks,
						kept: summary.kept_blocks,
						storeFailed: summary.store_failed_blocks,
						modelFailed: summary.model_failed_blocks,
						shortened: summary.counted_shortened,
						verdictReuse: summary.counted_verdict_reuse,
						requestsWithCandidates: summary.counted_with_candidates,
					},
	};
}

function providerCoverage(summary: Summary): ProxyProviderCoverage {
	const requests = summary.requests;
	const classes: Partial<ProxyProviderCoverage> = {};
	for (const usageClass of PROXY_PROVIDER_USAGE_CLASSES) {
		const rows = Object.fromEntries(
			READINGS.map((reading) => [reading, summary[readingAlias(usageClass, reading)]])
		) as Record<ProxyProviderClassReading, number>;
		// Why no request qualifies: history that never recorded it, or an answer that
		// did not say. A range can hold both; the larger group names the reason.
		const unrecorded = rows.legacy > rows.unreported + rows.absent;
		classes[usageClass] = {
			tokens: proxyFigure(
				'measured',
				'tokens',
				summary[tokensAlias(usageClass)],
				{ scope: 'range', counted: rows.reported + rows.derived, of: requests },
				unrecorded ? 'not-recorded' : 'not-observed'
			),
			rows,
		};
	}
	return classes as ProxyProviderCoverage;
}

/**
 * The distribution of the processing times, once enough requests carry one. The
 * scan reads only when it will be used: below the minimum the count alone is
 * reported, with the reason there is no distribution.
 */
function latencyOf(db: Database.Database, startTime: number, summary: Summary): ProxyLatency {
	const counts = { timed: summary.timed_requests, untimed: summary.untimed_read_requests };
	if (counts.timed >= PROXY_LATENCY_MIN_SAMPLES) {
		const rows = db
			.prepare(
				`
      SELECT added_latency_ms AS ms
      FROM proxy_requests
      WHERE started_at >= ? AND added_latency_ms IS NOT NULL
      ORDER BY added_latency_ms ASC
    `
			)
			.all(startTime) as Array<{ ms: number }>;
		return { ...counts, distribution: percentilesFromSorted(rows.map((row) => Number(row.ms))) };
	}
	if (counts.timed > 0) {
		return { ...counts, distribution: null, unknown: 'insufficient-samples' };
	}
	// Nothing to time: no request was read, or the ones that were carry no timing.
	return {
		...counts,
		distribution: null,
		unknown: summary.read_requests > 0 ? 'not-recorded' : 'not-read',
	};
}

/** The algorithm counts of one JSON cell. A cell that is not an object of counts reads as none. */
function parseCompressorCounts(raw: string): Array<[string, number]> | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
		return Object.entries(parsed).filter(
			(entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && entry[1] > 0
		);
	} catch {
		return null;
	}
}

/**
 * Which algorithms shortened the blocks. Rows with the same cell are read as one
 * group, so a cell is parsed once however many requests wrote it. The counts
 * overlap by design (see `ProxyAlgorithmBreakdown`).
 */
function algorithmsOf(db: Database.Database, startTime: number): ProxyAlgorithmBreakdown {
	const rows = db
		.prepare(
			`
      SELECT compressor_counts AS counts,
             COUNT(*) AS requests,
             COALESCE(SUM(blocks_compressed), 0) AS blocks
      FROM proxy_requests
      WHERE started_at >= ? AND compressor_counts IS NOT NULL
      GROUP BY compressor_counts
    `
		)
		.all(startTime) as Array<{ counts: string; requests: number; blocks: number }>;

	const algorithms = new Map<string, ProxyAlgorithmCount>();
	let uniqueBlocks = 0;
	for (const row of rows) {
		const counts = parseCompressorCounts(row.counts);
		if (!counts) continue;
		const requests = Number(row.requests);
		uniqueBlocks += Number(row.blocks);
		for (const [algorithm, blocks] of counts) {
			const entry = algorithms.get(algorithm) ?? { algorithm, blocks: 0, requests: 0 };
			entry.blocks += blocks * requests;
			entry.requests += requests;
			algorithms.set(algorithm, entry);
		}
	}
	return {
		uniqueBlocks,
		algorithms: [...algorithms.values()].sort(
			(a, b) => b.blocks - a.blocks || a.algorithm.localeCompare(b.algorithm)
		),
	};
}

/**
 * The range by local calendar day, the boundary every per-day stat uses (SQLite's
 * `localtime`, as `queryByDay` in aggregations.ts). A timestamp SQLite cannot
 * place on a day has no key and is left out of this series, not of the totals.
 */
function trendOf(db: Database.Database, startTime: number): ProxyTrendDay[] {
	const rows = db
		.prepare(
			`
      SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS day,
             COUNT(*) AS requests,
             SUM(CASE WHEN original_tokens IS NOT NULL THEN 1 ELSE 0 END) AS compress_requests,
             COALESCE(SUM(original_tokens), 0) AS original_tokens,
             COALESCE(SUM(sent_tokens), 0) AS sent_tokens,
             COALESCE(SUM(blocks_compressed), 0) AS blocks_shortened
      FROM proxy_requests
      WHERE started_at >= ?
      GROUP BY day
      ORDER BY day ASC
    `
		)
		.all(startTime) as Array<Record<string, unknown>>;

	return rows.flatMap((row) =>
		typeof row.day === 'string'
			? [
					{
						date: row.day,
						requests: numberOf(row, 'requests'),
						compressRequests: numberOf(row, 'compress_requests'),
						originalTokens: numberOf(row, 'original_tokens'),
						sentTokens: numberOf(row, 'sent_tokens'),
						blocksShortened: numberOf(row, 'blocks_shortened'),
					},
				]
			: []
	);
}

// ============================================================================
// Orchestrator
// ============================================================================

/**
 * What the proxy did with the requests carried since `startTime` (epoch ms; the
 * caller reads it once with `getTimeRangeStart()` so every part of one answer
 * covers the same range). A range with no request answers a record with every
 * block present, every count 0 and every unknown stated as one.
 */
export function getProxyEffectiveness(
	db: Database.Database,
	startTime: number
): ProxyEffectiveness {
	const { summary, skips } = readSummary(db, startTime);
	return {
		traffic: {
			carried: summary.requests,
			read: summary.read_requests,
			skipped: skips.reduce((total, skip) => total + skip.requests, 0),
			shortened: summary.shortened_requests,
			blocksShortened: summary.blocks_shortened,
		},
		blocks: blockReport(summary),
		skips,
		latency: latencyOf(db, startTime, summary),
		algorithms: algorithmsOf(db, startTime),
		providerClasses: providerCoverage(summary),
		trend: trendOf(db, startTime),
	};
}
