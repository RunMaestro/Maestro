/**
 * The words of the Maestro token proxy report.
 *
 * `getProxyRequestUsage()` answers what the proxy did in a range
 * (`ProxyRequestUsage`), and `getTokenProxyRecoveryObservations()` answers which
 * originals were read back since the app started. This module says those facts,
 * one line each, with how sure the figure is (a count Maestro made, an estimate,
 * unknown) and how much of the traffic it covers written into the line. Settings,
 * the Usage Dashboard and `maestro-cli` say them through these functions, so no
 * surface can state a number or its certainty differently from another.
 *
 * Pure strings: no color, no markup, no layout. A surface lays the lines out.
 *
 * Rules every line keeps (they are the rules of the telemetry contract in
 * `src/shared/stats-types.ts`):
 *
 * - A figure of one kind is never added to a figure of another. Counts, estimates
 *   and the provider's own numbers are said apart.
 * - An unknown is said as unknown with its reason, and is never written as 0.
 * - The originals read back are a process-lifetime count. They belong to no date
 *   range and are never subtracted from a saving.
 */

import {
	formatCount,
	formatCountNoun,
	formatDurationDecimal,
	formatSize,
	formatTokensCompact,
} from '../formatters';
import {
	PROXY_PROVIDER_USAGE_CLASSES,
	type ProxyAlgorithmBreakdown,
	type ProxyBlockReport,
	type ProxyEffectiveMode,
	type ProxyEffectiveness,
	type ProxyLatency,
	type ProxyProviderClassTotals,
	type ProxyProviderUsageClass,
	type ProxyRequestUsage,
	type ProxySkipCount,
	type ProxyTraffic,
	type ProxyTrendDay,
} from '../stats-types';
import {
	describeTokensSaved,
	PROXY_LATENCY_MIN_SAMPLES,
	TOKEN_PROXY_MODE_LABELS,
	TOKEN_PROXY_PROVIDER_CLASS_LABELS,
	TOKEN_PROXY_ROUTES,
	TOKEN_PROXY_SKIP_LABELS,
	TOKEN_PROXY_UNKNOWN_LABELS,
	type TokenProxyRecoveryObservations,
	type TokenProxyRecoveryReadCounts,
	type TokenProxyRouteId,
} from './token-proxy';

/** One fact of the report: what it is called, and what it says. */
export interface ProxyReportLine {
	label: string;
	text: string;
}

/**
 * Said beside the provider's classes. They are actual usage, not an estimate:
 * each class is what the provider reported, or what follows from it (OpenAI
 * reports a prompt total and a cached count, and the uncached input is the
 * difference).
 */
export const TOKEN_PROXY_PROVIDER_USAGE_NOTE =
	"Class by class, as the provider reported it or as derived from what it reported (OpenAI's uncached input is its prompt total minus its cached tokens), with the requests each class covers. The estimates above are not subtracted from them.";

/**
 * Said beside the sums of an older desktop, which sent no class and no coverage.
 * They are not promoted to reported or derived counts: nothing says which class
 * an answer named.
 */
export const TOKEN_PROXY_PROVIDER_STORED_SUMS_NOTE =
	'Sums of stored numbers from an older desktop. The provenance and coverage of each class are unknown: a class an answer did not name is stored as 0, so a sum can be too low and is not a verified count of its class. The estimates above are not subtracted from them.';

/** Said wherever a saving is shown: money and answer quality have no basis here. */
export const TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE =
	'Net dollar saving and answer quality: not evaluated. No counterfactual, quality check or dollar basis exists, so the estimates are not turned into money or into a claim about answers.';

/**
 * Said under the days of a range: a day is a local calendar day with a request,
 * and the first day of a rolling range is partial.
 */
export const TOKEN_PROXY_TREND_NOTE =
	'Local calendar days that have a request. The first day of a rolling range holds only the requests after the range started.';

/** How many of the latest days the text report lists. The JSON record holds every day. */
export const PROXY_TREND_TEXT_DAYS = 7;

/** The heading of the recovery lines: what span they cover, and what they are not part of. */
export const TOKEN_PROXY_RECOVERY_HEADING =
	'Original recovery since the app started (not part of the range above)';

const PROVIDER_CLASS_NAMES: Record<ProxyProviderUsageClass, string> = {
	input: 'Input',
	cacheRead: 'Cache read',
	cacheWrite: 'Cache write',
	output: 'Output',
};

/** The mode a group of requests was carried as, or why that is not known. */
export function describeProxyMode(mode: ProxyEffectiveMode | null): string {
	return mode === null ? TOKEN_PROXY_UNKNOWN_LABELS['not-recorded'] : TOKEN_PROXY_MODE_LABELS[mode];
}

/**
 * The provider route a group of requests used, as the Gateway names it (`Claude
 * Code`). A stored route this build does not know is kept as it was stored, and a
 * request that stored none is said so.
 */
export function describeProxyRoute(route: string): string {
	if (route === '') return TOKEN_PROXY_UNKNOWN_LABELS['not-recorded'];
	return Object.prototype.hasOwnProperty.call(TOKEN_PROXY_ROUTES, route)
		? TOKEN_PROXY_ROUTES[route as TokenProxyRouteId].label
		: route;
}

/**
 * The time the proxy held requests: the distribution once there are samples
 * enough, else why there is none. Requests that were read and carry no time are
 * counted apart, because they are unknown and not 0 ms.
 */
export function describeProxyLatency(latency: ProxyLatency): string {
	const untimed =
		latency.untimed > 0
			? `; ${formatCountNoun(latency.untimed, 'read request')} without a time`
			: '';
	if (latency.distribution !== null) {
		const { p50, p95, p99, count } = latency.distribution;
		return `p50 ${formatDurationDecimal(p50)}, p95 ${formatDurationDecimal(p95)}, p99 ${formatDurationDecimal(p99)} over ${formatCountNoun(count, 'timed request')}${untimed}`;
	}
	const detail =
		latency.unknown === 'insufficient-samples'
			? ` (${formatCountNoun(latency.timed, 'timed request')}, ${PROXY_LATENCY_MIN_SAMPLES} needed)`
			: '';
	return `${TOKEN_PROXY_UNKNOWN_LABELS[latency.unknown]}${detail}${untimed}`;
}

/** Requests are subsets of the ones carried and can overlap, so they are said as "of those". */
function describeTraffic(traffic: ProxyTraffic): string {
	return `${formatCountNoun(traffic.carried, 'request')} carried. Of those: ${formatCount(traffic.read)} read, ${formatCount(traffic.skipped)} forwarded without the compressor's result, ${formatCount(traffic.shortened)} with a block shortened (${formatCountNoun(traffic.blocksShortened, 'block')})`;
}

function describeBlocks({ coverage, counts }: ProxyBlockReport): ProxyReportLine[] {
	if (coverage.of === 0) {
		return [{ label: 'Blocks', text: TOKEN_PROXY_UNKNOWN_LABELS['not-read'] }];
	}
	if (counts === null) {
		return [
			{
				label: 'Blocks',
				text: `${TOKEN_PROXY_UNKNOWN_LABELS['not-recorded']}; none of ${formatCountNoun(coverage.of, 'read request')} carries counts`,
			},
		];
	}
	const decided = [
		`${formatCount(counts.shortened)} shortened`,
		`${formatCount(counts.kept)} kept whole`,
		`${formatCount(counts.belowThreshold)} under the size threshold`,
		`${formatCount(counts.storeFailed)} left alone because the cache failed`,
	].join(', ');
	const modelFailed =
		counts.modelFailed > 0 ? `; a model summary failed on ${formatCount(counts.modelFailed)}` : '';
	const lines: ProxyReportLine[] = [
		{
			label: 'Blocks',
			text: `${formatCount(coverage.counted)} of ${formatCountNoun(coverage.of, 'read request')} counted: ${formatCountNoun(counts.candidates, 'candidate block')} (${decided})${modelFailed}; ${formatCountNoun(counts.verdictReuse, 'verdict')} reused from Maestro's compression cache (not the provider's prompt cache)`,
		},
	];
	const setAside = [
		[counts.protected, 'recent or at a cache breakpoint'],
		[counts.vetoed.failed, 'failed results'],
		[counts.vetoed.recovery, 'recovery output'],
		[counts.vetoed.retrieval, 'retrieved text carried forward'],
	] as const;
	const named = setAside.filter(([count]) => count > 0);
	if (named.length > 0) {
		lines.push({
			label: 'Set aside',
			text: `${named.map(([count, why]) => `${formatCount(count)} ${why}`).join(', ')}; each went out whole`,
		});
	}
	return lines;
}

function describeSkips(skips: ProxySkipCount[]): string {
	return skips
		.map(
			({ reason, requests }) =>
				`${formatCount(requests)} ${reason === 'unrecognized' ? 'a reason a newer build recorded' : TOKEN_PROXY_SKIP_LABELS[reason]}`
		)
		.join('; ');
}

/**
 * The unique blocks cover only the requests that recorded their algorithms, so
 * they are a subtotal and are said against the range's total. A block that two
 * algorithms shortened is listed under each, so the lists do not add up.
 */
function describeAlgorithms(
	{ uniqueBlocks, algorithms }: ProxyAlgorithmBreakdown,
	blocksShortened: number
): string {
	const each = algorithms.map(
		({ algorithm, blocks, requests }) =>
			`${algorithm} ${formatCountNoun(blocks, 'block')} in ${formatCountNoun(requests, 'request')}`
	);
	return `${each.join('; ')}. ${formatCountNoun(uniqueBlocks, 'unique block')} in the requests that recorded their algorithms, out of ${formatCount(blocksShortened)} shortened in the range; a block that two algorithms shortened is listed under each, so the lists do not add up`;
}

/**
 * What the proxy did with the requests of a range, beyond the totals: how many it
 * read and shortened, the blocks with the share of requests that were counted,
 * why some were forwarded unread, how long it held them and which algorithms did
 * the work. The counts are counts Maestro made; none is a provider number and none
 * is a token estimate.
 */
export function describeProxyEffectiveness(effectiveness: ProxyEffectiveness): ProxyReportLine[] {
	const lines: ProxyReportLine[] = [
		{ label: 'Requests', text: describeTraffic(effectiveness.traffic) },
		...describeBlocks(effectiveness.blocks),
	];
	if (effectiveness.skips.length > 0) {
		lines.push({ label: 'Skipped', text: describeSkips(effectiveness.skips) });
	}
	lines.push({ label: 'Processing time', text: describeProxyLatency(effectiveness.latency) });
	if (effectiveness.algorithms.algorithms.length > 0) {
		lines.push({
			label: 'Algorithms',
			text: describeAlgorithms(effectiveness.algorithms, effectiveness.traffic.blocksShortened),
		});
	}
	return lines;
}

/**
 * The latest days of a range, oldest first, one line each: the requests, how many
 * were read, the tokens the proxy estimates it saved (said as everywhere else, by
 * {@link describeTokensSaved}) and the blocks it shortened. A day on which no
 * request was read has no estimate, and says so. The trend is the series behind
 * the totals, so its days add up to them; list the latest `limit` and leave the
 * rest to the JSON record.
 */
export function describeProxyTrend(
	trend: ProxyTrendDay[],
	limit = PROXY_TREND_TEXT_DAYS
): ProxyReportLine[] {
	return trend.slice(Math.max(0, trend.length - limit)).map((day) => {
		const read =
			day.compressRequests === 0
				? 'none read'
				: `${formatCount(day.compressRequests)} read, est. tokens saved ${describeTokensSaved({
						compressRequests: day.compressRequests,
						originalTokens: day.originalTokens,
						tokensSaved: day.originalTokens - day.sentTokens,
					})}, ${formatCountNoun(day.blocksShortened, 'block')} shortened`;
		return { label: day.date, text: `${formatCountNoun(day.requests, 'request')}, ${read}` };
	});
}

/**
 * One class of the provider's usage: the tokens summed over the requests whose
 * answer reported or derived it, how many that was, and what the other requests
 * are. A class nobody reported is unknown, with the reason.
 */
function describeProviderClass({ tokens, rows }: ProxyProviderClassTotals): string {
	const requests = Object.values(rows).reduce((sum, count) => sum + count, 0);
	const head =
		tokens.value === null
			? `unknown: ${TOKEN_PROXY_UNKNOWN_LABELS[tokens.unknown]}`
			: `${formatTokensCompact(tokens.value)} tokens on ${formatCount(rows.reported + rows.derived)} of ${formatCountNoun(requests, 'request')}`;
	const others = (['not-applicable', 'unreported', 'legacy', 'absent'] as const)
		.filter((reading) => rows[reading] > 0)
		.map(
			(reading) => `${formatCount(rows[reading])} ${TOKEN_PROXY_PROVIDER_CLASS_LABELS[reading]}`
		);
	return others.length > 0 ? `${head}. Other requests: ${others.join('; ')}` : head;
}

/**
 * The note that goes with the lines {@link describeProviderUsage} returns. Both
 * follow one test (a current desktop sends the classes with their coverage, an
 * older one only sums), so a sum is never printed under the note for a class.
 */
export function describeProviderUsageNote(
	usage: Pick<ProxyRequestUsage, 'totals' | 'effectiveness'>
): string {
	return usage.effectiveness !== undefined
		? TOKEN_PROXY_PROVIDER_USAGE_NOTE
		: TOKEN_PROXY_PROVIDER_STORED_SUMS_NOTE;
}

/**
 * What the provider counted, class by class, with the coverage of each class. A
 * default 0 for a class the answer never named is not a measurement, so it is not
 * summed. A current desktop sends the classes. An older one sends only the sum of
 * stored numbers, which is said as stored sums of unknown provenance: they are not
 * promoted to reported or derived counts. Say {@link describeProviderUsageNote}
 * beside the lines.
 */
export function describeProviderUsage(
	usage: Pick<ProxyRequestUsage, 'totals' | 'effectiveness'>
): ProxyReportLine[] {
	const { totals, effectiveness } = usage;
	if (effectiveness) {
		if (totals.requests === 0) return [];
		const classes = effectiveness.providerClasses;
		if (
			PROXY_PROVIDER_USAGE_CLASSES.every((name) => classes[name].rows.absent === totals.requests)
		) {
			return [
				{
					label: 'All classes',
					text: `unknown: ${TOKEN_PROXY_PROVIDER_CLASS_LABELS.absent} for all ${formatCountNoun(totals.requests, 'request')}`,
				},
			];
		}
		return PROXY_PROVIDER_USAGE_CLASSES.map((name) => ({
			label: PROVIDER_CLASS_NAMES[name],
			text: describeProviderClass(classes[name]),
		}));
	}
	const provider = totals.provider;
	if (!provider || provider.requests === 0) return [];
	return [
		{
			label: 'Stored sums',
			text: `unknown provenance and coverage for each class, over ${formatCountNoun(provider.requests, 'request')} with usage: input ${formatTokensCompact(provider.inputTokens)}, cache read ${formatTokensCompact(provider.cacheReadTokens)}, cache write ${formatTokensCompact(provider.cacheWriteTokens)}, output ${formatTokensCompact(provider.outputTokens)}`,
		},
	];
}

/** Reads of the original text of shortened blocks, by one caller. */
function describeReads(counts: TokenProxyRecoveryReadCounts, noun: 'call' | 'read'): string {
	const parts = [
		`${formatCount(counts.recoveredOriginals)} returned original text (${formatSize(counts.returnedOriginalBytes)}, about ${formatTokensCompact(counts.returnedOriginalTokenEstimate)} tokens, an estimate)`,
	];
	if (counts.unavailableBlocks > 0) {
		parts.push(
			`${formatCount(counts.unavailableBlocks)} named a block with no shortening on record`
		);
	}
	if (counts.missingOriginals > 0) {
		parts.push(`${formatCount(counts.missingOriginals)} found the original no longer stored`);
	}
	if (counts.failedReads > 0) parts.push(`${formatCount(counts.failedReads)} failed`);
	return `${formatCountNoun(counts.invocations, noun)}: ${parts.join('; ')}`;
}

/**
 * The originals read back since the app started, apart from the range's
 * reduction. The retrieve tool's calls are said as served by the tool; every other
 * read has an unknown actor, because an agent can run the CLI as well as a person.
 * A tool response is not proof that a model read it, and a retrieval made by
 * another process or before the app started is not seen, so no net saving follows
 * from these lines.
 */
export function describeProxyRecovery(
	observations: TokenProxyRecoveryObservations
): ProxyReportLine[] {
	const { mcpRetrieveTool, otherReads } = observations.byCaller;
	const lines: ProxyReportLine[] = [
		{ label: 'Retrieve tool', text: describeReads(mcpRetrieveTool, 'call') },
		{
			label: 'Other reads',
			text: `${describeReads(otherReads, 'read')}; the actor is unknown (inspection, the CLI or a script)`,
		},
		{
			label: 'Not known',
			text: 'whether a model read a returned original; retrievals made outside this app or before it started',
		},
		{
			label: 'Net saving',
			text: 'not evaluated. A return is not subtracted from the tokens saved: that figure counts a shortened block each time a later request sends it again, and a return counts the text once',
		},
	];
	if (observations.saturated) {
		lines.push({
			label: 'Limit',
			text: 'a counter reached its largest value, so these figures are lower bounds',
		});
	}
	return lines;
}
