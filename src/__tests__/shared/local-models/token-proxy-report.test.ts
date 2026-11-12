/**
 * @file token-proxy-report.test.ts
 * @description The words of the token proxy report. Every surface (Settings, the
 * Usage Dashboard, `maestro-cli`) says the report through these functions, so the
 * cases pin what each line claims: a measured count is said with its coverage, an
 * unknown is said as unknown with its reason and never as 0, an older desktop's
 * mean is not sold as a measurement, and the originals read back stay apart from
 * the range's reduction.
 */

import { describe, expect, it } from 'vitest';
import {
	describeAddedLatency,
	describeTokensSaved,
	PROXY_LATENCY_MIN_SAMPLES,
	TOKEN_PROXY_MODE_LABELS,
	TOKEN_PROXY_ROUTES,
	TOKEN_PROXY_UNKNOWN_LABELS,
} from '../../../shared/local-models/token-proxy';
import {
	describeProviderUsage,
	describeProviderUsageNote,
	describeProxyEffectiveness,
	describeProxyLatency,
	describeProxyMode,
	describeProxyRecovery,
	describeProxyRoute,
	describeProxyTrend,
	PROXY_TREND_TEXT_DAYS,
	TOKEN_PROXY_PROVIDER_STORED_SUMS_NOTE,
	TOKEN_PROXY_PROVIDER_USAGE_NOTE,
	TOKEN_PROXY_RECOVERY_HEADING,
	TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE,
	TOKEN_PROXY_TREND_NOTE,
	type ProxyReportLine,
} from '../../../shared/local-models/token-proxy-report';
import {
	PROXY_PROVIDER_USAGE_CLASSES,
	type ProxyEffectiveness,
	type ProxyRequestTotals,
	type ProxyRequestUsage,
	type ProxyTrendDay,
} from '../../../shared/stats-types';
import {
	busyProxyEffectiveness,
	emptyProxyEffectiveness,
	recoveryObservations,
} from '../../helpers/proxyTelemetryFixtures';

const TOTALS: ProxyRequestTotals = {
	requests: 120,
	compressRequests: 100,
	originalTokens: 40_000,
	sentTokens: 30_000,
	tokensSaved: 10_000,
	avgAddedLatencyMs: 14,
	timedRequests: 98,
	provider: {
		requests: 112,
		inputTokens: 4_000,
		cacheReadTokens: 120_000,
		cacheWriteTokens: 0,
		outputTokens: 600,
	},
};

function textOf(lines: ProxyReportLine[], label: string): string {
	const line = lines.find((entry) => entry.label === label);
	if (!line)
		throw new Error(`no "${label}" line in ${lines.map((entry) => entry.label).join(', ')}`);
	return line.text;
}

/** En dash and em dash, built from code points so this file holds neither. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

function everyString(lines: ProxyReportLine[]): string[] {
	return lines.flatMap((line) => [line.label, line.text]);
}

describe('describeAddedLatency', () => {
	it('says a dash where the proxy read no request body', () => {
		expect(describeAddedLatency({ ...TOTALS, compressRequests: 0, timedRequests: 0 })).toBe('-');
		expect(describeAddedLatency({ ...TOTALS, compressRequests: 0, timedRequests: undefined })).toBe(
			'-'
		);
	});

	it('says the mean of the requests that carry a time, and a measured zero as 0 ms', () => {
		expect(describeAddedLatency({ ...TOTALS, timedRequests: 98 })).toBe('14 ms');
		expect(describeAddedLatency({ ...TOTALS, avgAddedLatencyMs: 0, timedRequests: 1 })).toBe(
			'0 ms'
		);
		expect(describeAddedLatency({ ...TOTALS, avgAddedLatencyMs: 1_234, timedRequests: 3 })).toBe(
			'1,234 ms'
		);
	});

	it('says unknown, never 0 ms, for a group whose read requests carry no time', () => {
		expect(describeAddedLatency({ ...TOTALS, avgAddedLatencyMs: 0, timedRequests: 0 })).toBe(
			'unknown'
		);
		// Whatever the mean field holds, there is no sample behind it.
		expect(describeAddedLatency({ ...TOTALS, avgAddedLatencyMs: 14, timedRequests: 0 })).toBe(
			'unknown'
		);
	});

	it('keeps an older desktop explicit: a mean without its sample, or unknown', () => {
		const legacy = { ...TOTALS, timedRequests: undefined };
		expect(describeAddedLatency({ ...legacy, avgAddedLatencyMs: 14 })).toBe(
			'14 ms (sample unknown)'
		);
		// A mean of 0 with no sample cannot be told from a measured 0.
		expect(describeAddedLatency({ ...legacy, avgAddedLatencyMs: 0 })).toBe('unknown');
	});

	it('prints "0 ms" for exactly one state: a mean of 0 over at least one timed request', () => {
		const states: string[] = [];
		for (const compressRequests of [0, 3]) {
			for (const timedRequests of [undefined, 0, 1, 5]) {
				for (const avgAddedLatencyMs of [0, 14]) {
					const text = describeAddedLatency({
						...TOTALS,
						compressRequests,
						timedRequests,
						avgAddedLatencyMs,
					});
					if (text === '0 ms')
						states.push(`${compressRequests}/${timedRequests}/${avgAddedLatencyMs}`);
				}
			}
		}
		expect(states).toEqual(['3/1/0', '3/5/0']);
	});

	it('leaves the saved-token description as it was', () => {
		expect(describeTokensSaved(TOTALS)).toBe('10,000 (25%)');
		expect(describeTokensSaved({ ...TOTALS, compressRequests: 0 })).toBe('-');
	});
});

describe('describeProxyMode', () => {
	it('names a mode as the picker does, and a historical request as not recorded', () => {
		expect(describeProxyMode('compress')).toBe(TOKEN_PROXY_MODE_LABELS.compress);
		expect(describeProxyMode('compress-early')).toBe(TOKEN_PROXY_MODE_LABELS['compress-early']);
		expect(describeProxyMode('passthrough')).toBe(TOKEN_PROXY_MODE_LABELS.passthrough);
		expect(describeProxyMode(null)).toBe(TOKEN_PROXY_UNKNOWN_LABELS['not-recorded']);
		expect(describeProxyMode(null)).toBe('not recorded (the request predates this measure)');
	});
});

describe('describeProxyRoute', () => {
	it('names a route as the Gateway does', () => {
		for (const [route, { label }] of Object.entries(TOKEN_PROXY_ROUTES)) {
			expect(describeProxyRoute(route)).toBe(label);
		}
		expect(describeProxyRoute('anthropic')).toBe('Claude Code');
	});

	it('keeps a stored route this build does not know, as it was stored', () => {
		expect(describeProxyRoute('acme-gateway')).toBe('acme-gateway');
		// Names that exist on every object are not routes.
		for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
			expect(describeProxyRoute(inherited)).toBe(inherited);
		}
	});

	it('says a request that stored no route has none recorded', () => {
		expect(describeProxyRoute('')).toBe(TOKEN_PROXY_UNKNOWN_LABELS['not-recorded']);
	});
});

describe('describeProxyLatency', () => {
	const base = { timed: 98, untimed: 0 };

	it('says the distribution with its sample, and the read requests that carry no time', () => {
		const { latency } = busyProxyEffectiveness();
		expect(describeProxyLatency(latency)).toBe(
			'p50 12ms, p95 80ms, p99 1.2s over 98 timed requests; 2 read requests without a time'
		);
		const one = {
			...base,
			timed: 1,
			untimed: 1,
			distribution: { count: 1, min: 5, p50: 5, p75: 5, p90: 5, p95: 5, p99: 5, max: 5 },
		};
		expect(describeProxyLatency(one)).toBe(
			'p50 5ms, p95 5ms, p99 5ms over 1 timed request; 1 read request without a time'
		);
	});

	it('withholds a distribution below the minimum and says how many samples there are', () => {
		expect(
			describeProxyLatency({
				timed: 12,
				untimed: 0,
				distribution: null,
				unknown: 'insufficient-samples',
			})
		).toBe(`too few samples to report (12 timed requests, ${PROXY_LATENCY_MIN_SAMPLES} needed)`);
		expect(
			describeProxyLatency({
				timed: 1,
				untimed: 3,
				distribution: null,
				unknown: 'insufficient-samples',
			})
		).toBe(
			`too few samples to report (1 timed request, ${PROXY_LATENCY_MIN_SAMPLES} needed); 3 read requests without a time`
		);
	});

	it('gives the reason when nothing was timed, and never a number', () => {
		expect(
			describeProxyLatency({ timed: 0, untimed: 0, distribution: null, unknown: 'not-read' })
		).toBe(TOKEN_PROXY_UNKNOWN_LABELS['not-read']);
		expect(
			describeProxyLatency({ timed: 0, untimed: 4, distribution: null, unknown: 'not-recorded' })
		).toBe(`${TOKEN_PROXY_UNKNOWN_LABELS['not-recorded']}; 4 read requests without a time`);
	});
});

describe('describeProxyEffectiveness', () => {
	it('says each fact of a busy range with its coverage', () => {
		const lines = describeProxyEffectiveness(busyProxyEffectiveness());

		expect(lines.map((line) => line.label)).toEqual([
			'Requests',
			'Blocks',
			'Set aside',
			'Skipped',
			'Processing time',
			'Algorithms',
		]);
		// The subsets of the carried requests overlap, so they are said as "of those".
		expect(textOf(lines, 'Requests')).toBe(
			"120 requests carried. Of those: 100 read, 8 forwarded without the compressor's result, 60 with a block shortened (210 blocks)"
		);
		// Counts are said with the share of read requests that carry them, and the
		// proxy's own cache is said not to be the provider's.
		expect(textOf(lines, 'Blocks')).toBe(
			"90 of 100 read requests counted: 300 candidate blocks (160 shortened, 50 kept whole, 80 under the size threshold, 10 left alone because the cache failed); a model summary failed on 2; 40 verdicts reused from Maestro's compression cache (not the provider's prompt cache)"
		);
		expect(textOf(lines, 'Set aside')).toBe(
			'120 recent or at a cache breakpoint, 3 failed results, 5 retrieved text carried forward; each went out whole'
		);
		expect(textOf(lines, 'Skipped')).toBe(
			'5 a body that is not UTF-8 text; 3 decoding or compressing failed, and the original was forwarded'
		);
		expect(textOf(lines, 'Processing time')).toBe(
			'p50 12ms, p95 80ms, p99 1.2s over 98 timed requests; 2 read requests without a time'
		);
		// The algorithms overlap: three lists of blocks, and a count of unique blocks
		// that covers only the requests that recorded their algorithms, said against
		// the range's total.
		expect(textOf(lines, 'Algorithms')).toBe(
			'json 150 blocks in 40 requests; logs 100 blocks in 30 requests; model 20 blocks in 10 requests. 200 unique blocks in the requests that recorded their algorithms, out of 210 shortened in the range; a block that two algorithms shortened is listed under each, so the lists do not add up'
		);
	});

	it('says an empty range as unknown, not as a row of zeros', () => {
		const lines = describeProxyEffectiveness(emptyProxyEffectiveness());

		expect(lines.map((line) => line.label)).toEqual(['Requests', 'Blocks', 'Processing time']);
		expect(textOf(lines, 'Blocks')).toBe(TOKEN_PROXY_UNKNOWN_LABELS['not-read']);
		expect(textOf(lines, 'Processing time')).toBe(TOKEN_PROXY_UNKNOWN_LABELS['not-read']);
		expect(textOf(lines, 'Requests')).toBe(
			"0 requests carried. Of those: 0 read, 0 forwarded without the compressor's result, 0 with a block shortened (0 blocks)"
		);
	});

	it('keeps requests read before counts were recorded apart from a count of zero', () => {
		const effectiveness: ProxyEffectiveness = {
			...emptyProxyEffectiveness(),
			traffic: { carried: 7, read: 7, skipped: 0, shortened: 4, blocksShortened: 9 },
			blocks: { coverage: { scope: 'range', counted: 0, of: 7 }, counts: null },
		};

		expect(textOf(describeProxyEffectiveness(effectiveness), 'Blocks')).toBe(
			`${TOKEN_PROXY_UNKNOWN_LABELS['not-recorded']}; none of 7 read requests carries counts`
		);

		// A counted zero is a fact: the compressor ran and found no candidate.
		const counted: ProxyEffectiveness = {
			...effectiveness,
			blocks: {
				coverage: { scope: 'range', counted: 7, of: 7 },
				counts: {
					protected: 0,
					vetoed: { failed: 0, recovery: 0, retrieval: 0 },
					candidates: 0,
					belowThreshold: 0,
					kept: 0,
					storeFailed: 0,
					modelFailed: 0,
					shortened: 0,
					verdictReuse: 0,
					requestsWithCandidates: 0,
				},
			},
		};
		const lines = describeProxyEffectiveness(counted);
		expect(textOf(lines, 'Blocks')).toBe(
			"7 of 7 read requests counted: 0 candidate blocks (0 shortened, 0 kept whole, 0 under the size threshold, 0 left alone because the cache failed); 0 verdicts reused from Maestro's compression cache (not the provider's prompt cache)"
		);
		// With nothing set aside there is no line about it, and no model failure to report.
		expect(lines.some((line) => line.label === 'Set aside')).toBe(false);
	});

	it('names a skip reason another build wrote, and counts none as zero', () => {
		const effectiveness: ProxyEffectiveness = {
			...busyProxyEffectiveness(),
			skips: [
				{ reason: 'too-large', requests: 4 },
				{ reason: 'unrecognized', requests: 1 },
			],
		};
		expect(textOf(describeProxyEffectiveness(effectiveness), 'Skipped')).toBe(
			'4 a body past the read limit; 1 a reason a newer build recorded'
		);
	});

	it('states the algorithm subtotal as a cohort, never as the range total', () => {
		// Six blocks were shortened; only the requests that recorded their algorithms
		// name three of them.
		const effectiveness: ProxyEffectiveness = {
			...busyProxyEffectiveness(),
			traffic: { carried: 2, read: 2, skipped: 0, shortened: 2, blocksShortened: 6 },
			algorithms: {
				uniqueBlocks: 3,
				algorithms: [
					{ algorithm: 'logs', blocks: 2, requests: 1 },
					{ algorithm: 'json', blocks: 1, requests: 1 },
				],
			},
		};

		const text = textOf(describeProxyEffectiveness(effectiveness), 'Algorithms');
		expect(text).toBe(
			'logs 2 blocks in 1 request; json 1 block in 1 request. 3 unique blocks in the requests that recorded their algorithms, out of 6 shortened in the range; a block that two algorithms shortened is listed under each, so the lists do not add up'
		);
		expect(text).not.toContain('3 blocks shortened in all');
	});

	it('says why there is no distribution', () => {
		const effectiveness: ProxyEffectiveness = {
			...busyProxyEffectiveness(),
			latency: { timed: 12, untimed: 0, distribution: null, unknown: 'insufficient-samples' },
		};
		expect(textOf(describeProxyEffectiveness(effectiveness), 'Processing time')).toBe(
			'too few samples to report (12 timed requests, 30 needed)'
		);
	});
});

describe('describeProviderUsage', () => {
	const busy = (): Pick<ProxyRequestUsage, 'totals' | 'effectiveness'> => ({
		totals: TOTALS,
		effectiveness: busyProxyEffectiveness(),
	});

	it('says each class over the requests that reported it, and names the rest as unknown', () => {
		const lines = describeProviderUsage(busy());

		expect(lines.map((line) => line.label)).toEqual([
			'Input',
			'Cache read',
			'Cache write',
			'Output',
		]);
		expect(textOf(lines, 'Input')).toBe(
			'1.2M tokens on 100 of 120 requests. Other requests: 12 not reported in the answer (unknown, not zero); 8 recorded before reporting was tracked (unknown)'
		);
		expect(textOf(lines, 'Cache read')).toBe(
			'4.1M tokens on 100 of 120 requests. Other requests: 12 not reported in the answer (unknown, not zero); 8 recorded before reporting was tracked (unknown)'
		);
		// A measured zero keeps its coverage; a class the provider lacks is zero by definition.
		expect(textOf(lines, 'Cache write')).toBe(
			'0 tokens on 50 of 120 requests. Other requests: 50 not a class this provider has (zero by definition); 12 not reported in the answer (unknown, not zero); 8 recorded before reporting was tracked (unknown)'
		);
		expect(textOf(lines, 'Output')).toBe(
			'61.0K tokens on 112 of 120 requests. Other requests: 8 recorded before reporting was tracked (unknown)'
		);
	});

	it('does not read the stored sums when the classes are present', () => {
		const effectiveness = busyProxyEffectiveness();
		const lines = describeProviderUsage({
			totals: { ...TOTALS, provider: { ...TOTALS.provider, inputTokens: 999_999_999 } },
			effectiveness,
		});

		expect(textOf(lines, 'Input')).toContain('1.2M tokens');
		expect(everyString(lines).join('\n')).not.toContain('999');
	});

	it('says a class nobody reported as unknown with its reason', () => {
		const effectiveness = busyProxyEffectiveness();
		effectiveness.providerClasses.cacheRead = {
			tokens: { kind: 'measured', unit: 'tokens', value: null, unknown: 'not-observed' },
			rows: { ...effectiveness.providerClasses.cacheRead.rows, reported: 0, unreported: 112 },
		};

		expect(textOf(describeProviderUsage({ totals: TOTALS, effectiveness }), 'Cache read')).toBe(
			`unknown: ${TOKEN_PROXY_UNKNOWN_LABELS['not-observed']}. Other requests: 112 not reported in the answer (unknown, not zero); 8 recorded before reporting was tracked (unknown)`
		);
	});

	it('collapses to one line when no answer named any usage', () => {
		const effectiveness = emptyProxyEffectiveness();
		for (const name of PROXY_PROVIDER_USAGE_CLASSES) {
			effectiveness.providerClasses[name].rows.absent = 6;
		}

		expect(describeProviderUsage({ totals: { ...TOTALS, requests: 6 }, effectiveness })).toEqual([
			{
				label: 'All classes',
				text: 'unknown: the answer named no usage (unknown) for all 6 requests',
			},
		]);
	});

	it('says nothing for a range with no request', () => {
		expect(
			describeProviderUsage({
				totals: { ...TOTALS, requests: 0, provider: { ...TOTALS.provider, requests: 0 } },
				effectiveness: emptyProxyEffectiveness(),
			})
		).toEqual([]);
	});

	it('says the sums of an older desktop as stored sums of unknown provenance', () => {
		const lines = describeProviderUsage({ totals: TOTALS });

		expect(lines).toHaveLength(1);
		// Not "provider counted": nothing says which class an answer named.
		expect(lines[0].label).toBe('Stored sums');
		expect(lines[0].text).toBe(
			'unknown provenance and coverage for each class, over 112 requests with usage: input 4.0K, cache read 120.0K, cache write 0, output 600'
		);
		expect(JSON.stringify(lines)).not.toMatch(/reported|derived|measured/i);
		// A desktop that sent no provider block at all has nothing to say.
		const { provider: _provider, ...withoutProvider } = TOTALS;
		expect(describeProviderUsage({ totals: withoutProvider as ProxyRequestTotals })).toEqual([]);
		expect(
			describeProviderUsage({
				totals: { ...TOTALS, provider: { ...TOTALS.provider, requests: 0 } },
			})
		).toEqual([]);
	});

	it('puts the note for a class beside classes and the note for sums beside sums', () => {
		const classes = { totals: TOTALS, effectiveness: busyProxyEffectiveness() };
		expect(describeProviderUsageNote(classes)).toBe(TOKEN_PROXY_PROVIDER_USAGE_NOTE);
		expect(describeProviderUsageNote({ totals: TOTALS })).toBe(
			TOKEN_PROXY_PROVIDER_STORED_SUMS_NOTE
		);

		// The class note allows derived values: OpenAI's uncached input is a difference.
		expect(TOKEN_PROXY_PROVIDER_USAGE_NOTE).toContain('derived from what it reported');
		expect(TOKEN_PROXY_PROVIDER_USAGE_NOTE).not.toContain('did not change these counts');
		// The sum note promotes nothing: it says provenance and coverage are unknown.
		expect(TOKEN_PROXY_PROVIDER_STORED_SUMS_NOTE).toContain('unknown');
		expect(TOKEN_PROXY_PROVIDER_STORED_SUMS_NOTE).toContain('not a verified count');
		expect(TOKEN_PROXY_PROVIDER_STORED_SUMS_NOTE).not.toMatch(/what the provider reported/i);
	});

	it('keeps a measured zero beside the legacy requests of the same class', () => {
		const effectiveness = emptyProxyEffectiveness();
		// Two answers reported a cache write of zero and three predate reporting.
		effectiveness.providerClasses.cacheWrite = {
			tokens: {
				kind: 'measured',
				unit: 'tokens',
				value: 0,
				coverage: { scope: 'range', counted: 2, of: 5 },
			},
			rows: { ...effectiveness.providerClasses.cacheWrite.rows, reported: 2, legacy: 3 },
		};
		for (const name of ['input', 'cacheRead', 'output'] as const) {
			effectiveness.providerClasses[name].rows.legacy = 5;
		}

		const lines = describeProviderUsage({ totals: { ...TOTALS, requests: 5 }, effectiveness });

		expect(textOf(lines, 'Cache write')).toBe(
			'0 tokens on 2 of 5 requests. Other requests: 3 recorded before reporting was tracked (unknown)'
		);
		// A class no request reported stays unknown, and never reads as a zero.
		expect(textOf(lines, 'Input')).toBe(
			`unknown: ${TOKEN_PROXY_UNKNOWN_LABELS['not-observed']}. Other requests: 5 recorded before reporting was tracked (unknown)`
		);
	});
});

describe('describeProxyTrend', () => {
	const day = (date: string, overrides: Partial<ProxyTrendDay> = {}): ProxyTrendDay => ({
		date,
		requests: 10,
		compressRequests: 8,
		originalTokens: 40_000,
		sentTokens: 30_000,
		blocksShortened: 5,
		...overrides,
	});

	it('says each day with the share read, the estimate and the blocks', () => {
		expect(
			describeProxyTrend([
				day('2026-11-11'),
				day('2026-11-12', {
					requests: 1,
					compressRequests: 1,
					originalTokens: 4_000,
					sentTokens: 3_000,
					blocksShortened: 1,
				}),
			])
		).toEqual([
			{
				label: '2026-11-11',
				text: '10 requests, 8 read, est. tokens saved 10,000 (25%), 5 blocks shortened',
			},
			{
				label: '2026-11-12',
				text: '1 request, 1 read, est. tokens saved 1,000 (25%), 1 block shortened',
			},
		]);
	});

	it('says a day on which nothing was read has no estimate, not a saving of zero', () => {
		const [passthrough] = describeProxyTrend([
			day('2026-11-12', {
				compressRequests: 0,
				originalTokens: 0,
				sentTokens: 0,
				blocksShortened: 0,
			}),
		]);

		expect(passthrough.text).toBe('10 requests, none read');
		expect(passthrough.text).not.toContain('saved');
	});

	it('shows a late fallback as read with a saving of zero, and never divides by zero', () => {
		const lines = describeProxyTrend([
			day('2026-11-11', { originalTokens: 5_000, sentTokens: 5_000, blocksShortened: 0 }),
			day('2026-11-12', { originalTokens: 0, sentTokens: 0 }),
		]);

		expect(lines[0].text).toContain('est. tokens saved 0 (0%)');
		expect(lines[1].text).toContain('est. tokens saved 0 (0%)');
		expect(everyString(lines).join('\n')).not.toMatch(/NaN|Infinity/);
	});

	it('lists the latest days in order and leaves the rest to the JSON record', () => {
		const days = Array.from({ length: 10 }, (_, index) =>
			day(`2026-11-${String(index + 1).padStart(2, '0')}`)
		);

		const lines = describeProxyTrend(days);

		expect(PROXY_TREND_TEXT_DAYS).toBe(7);
		expect(lines.map((line) => line.label)).toEqual([
			'2026-11-04',
			'2026-11-05',
			'2026-11-06',
			'2026-11-07',
			'2026-11-08',
			'2026-11-09',
			'2026-11-10',
		]);
		expect(describeProxyTrend(days, 2).map((line) => line.label)).toEqual([
			'2026-11-09',
			'2026-11-10',
		]);
		expect(describeProxyTrend(days, 0)).toEqual([]);
		expect(describeProxyTrend([])).toEqual([]);
	});

	it('says what a day is and which one is partial', () => {
		expect(TOKEN_PROXY_TREND_NOTE).toContain('Local calendar days');
		expect(TOKEN_PROXY_TREND_NOTE).toContain('first day of a rolling range');
	});
});

describe('describeProxyRecovery', () => {
	const read = {
		mcpRetrieveTool: {
			invocations: 3,
			rangedInvocations: 3,
			recoveredOriginals: 2,
			missingOriginals: 1,
			returnedOriginalBytes: 18_432,
			returnedOriginalTokenEstimate: 4_608,
		},
		otherReads: {
			invocations: 2,
			recoveredOriginals: 1,
			unavailableBlocks: 1,
			returnedOriginalBytes: 2_048,
			returnedOriginalTokenEstimate: 512,
		},
	};

	it('says the retrieve tool apart from every other read', () => {
		const lines = describeProxyRecovery(recoveryObservations(read));

		expect(lines.map((line) => line.label)).toEqual([
			'Retrieve tool',
			'Other reads',
			'Not known',
			'Net saving',
		]);
		expect(textOf(lines, 'Retrieve tool')).toBe(
			'3 calls: 2 returned original text (18.0 KB, about 4.6K tokens, an estimate); 1 found the original no longer stored'
		);
		expect(textOf(lines, 'Other reads')).toBe(
			'2 reads: 1 returned original text (2.0 KB, about 512 tokens, an estimate); 1 named a block with no shortening on record; the actor is unknown (inspection, the CLI or a script)'
		);
	});

	it('claims neither receipt by a model nor a human actor, and no net saving', () => {
		const lines = describeProxyRecovery(recoveryObservations(read));

		expect(textOf(lines, 'Not known')).toBe(
			'whether a model read a returned original; retrievals made outside this app or before it started'
		);
		expect(textOf(lines, 'Net saving')).toBe(
			'not evaluated. A return is not subtracted from the tokens saved: that figure counts a shortened block each time a later request sends it again, and a return counts the text once'
		);
		const text = everyString(lines).join('\n');
		expect(text).not.toMatch(/\bhuman\b|\bperson\b|\buser\b/i);
		expect(TOKEN_PROXY_RECOVERY_HEADING).toContain('not part of the range above');
	});

	it('keeps the two callers separate even when only one read anything', () => {
		const lines = describeProxyRecovery(
			recoveryObservations({
				mcpRetrieveTool: {
					invocations: 1,
					recoveredOriginals: 1,
					returnedOriginalBytes: 100,
					returnedOriginalTokenEstimate: 25,
				},
			})
		);

		expect(textOf(lines, 'Retrieve tool')).toBe(
			'1 call: 1 returned original text (100 B, about 25 tokens, an estimate)'
		);
		expect(textOf(lines, 'Other reads')).toContain(
			'0 reads: 0 returned original text (0 B, about 0 tokens, an estimate)'
		);
	});

	it('says a counter at its limit makes the figures lower bounds', () => {
		const saturated = describeProxyRecovery(recoveryObservations(read, true));
		expect(textOf(saturated, 'Limit')).toBe(
			'a counter reached its largest value, so these figures are lower bounds'
		);
		expect(describeProxyRecovery(recoveryObservations(read)).some((l) => l.label === 'Limit')).toBe(
			false
		);
	});
});

describe('every sentence the report says', () => {
	const all = (): string[] => {
		const effectiveness = busyProxyEffectiveness();
		return [
			...everyString(describeProxyEffectiveness(effectiveness)),
			...everyString(describeProxyEffectiveness(emptyProxyEffectiveness())),
			...everyString(describeProviderUsage({ totals: TOTALS, effectiveness })),
			...everyString(describeProviderUsage({ totals: TOTALS })),
			...everyString(
				describeProxyRecovery(
					recoveryObservations({ mcpRetrieveTool: { invocations: 1, failedReads: 1 } }, true)
				)
			),
			describeProxyMode(null),
			describeProxyRoute('anthropic'),
			describeProxyRoute(''),
			TOKEN_PROXY_PROVIDER_USAGE_NOTE,
			TOKEN_PROXY_PROVIDER_STORED_SUMS_NOTE,
			TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE,
			TOKEN_PROXY_RECOVERY_HEADING,
			TOKEN_PROXY_TREND_NOTE,
			...everyString(
				describeProxyTrend([
					{
						date: '2026-11-12',
						requests: 3,
						compressRequests: 2,
						originalTokens: 0,
						sentTokens: 0,
						blocksShortened: 0,
					},
				])
			),
		];
	};

	it('never prints a value that is not a number or a word', () => {
		for (const text of all()) {
			expect(text).not.toMatch(/NaN|undefined|Infinity|\[object|null/);
		}
	});

	it('uses no em dash or en dash', () => {
		for (const text of all()) expect(text).not.toMatch(DASHES);
	});

	it('says no dollar or quality result exists, and shows no dollar figure', () => {
		expect(TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE).toContain('not evaluated');
		expect(TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE).toContain('dollar');
		expect(TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE).toContain('quality');
		for (const text of all()) {
			if (text === TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE) continue;
			expect(text).not.toMatch(/\$\s?\d/);
		}
		// The estimates are said not to be taken from the provider's own counts.
		expect(TOKEN_PROXY_PROVIDER_USAGE_NOTE).toContain('The estimates above are not subtracted');
		expect(TOKEN_PROXY_PROVIDER_STORED_SUMS_NOTE).toContain(
			'The estimates above are not subtracted'
		);
	});
});
