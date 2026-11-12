/**
 * @vitest-environment node
 *
 * The token proxy's effectiveness aggregation (`getProxyEffectiveness`) and the
 * cuts of `getProxyRequestUsage` (agents, effective modes, the total), against a
 * real SQLite engine and the real v22 `proxy_requests` table, seeded through the
 * same writer production uses.
 *
 * What is under test is the SQL and the rules around it: a fact the rows do not
 * state stays unknown and is never written as 0, the cuts of one fact add up to
 * the whole, the algorithms overlap on purpose and are not summed into unique
 * blocks, verdict reuse and the provider's cache reads are different numbers, and
 * a range with nothing in it divides by nothing. A differential case at the end
 * checks the SQL against a plain JavaScript reading of the same rows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations } from '../../../main/stats/migrations';
import { getProxyEffectiveness } from '../../../main/stats/proxy-effectiveness';
import {
	clearProxyRequestsCache,
	getProxyRequestUsage,
	recordProxyRequest,
} from '../../../main/stats/proxy-requests';
import { getTimeRangeStart } from '../../../main/stats/utils';
import { toLocalYmd } from '../../../shared/localDay';
import {
	PROXY_LATENCY_MIN_SAMPLES,
	asTokenProxySkipReason,
	proxyProviderClassReading,
	type ProxyProviderClassReading,
} from '../../../shared/local-models/token-proxy';
import { percentilesFromSorted } from '../../../shared/percentiles';
import {
	PROXY_PROVIDER_USAGE_CLASSES,
	type ProxyEffectiveness,
	type ProxyProviderClassStatus,
	type ProxyProviderUsageClass,
	type ProxyRequestTotals,
	type ProxyRequestUsage,
	type StatsTimeRange,
} from '../../../shared/stats-types';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';
import {
	currentProxyRow,
	emptyProxyEffectiveness,
	legacyProxyRow,
	passthroughProxyRow,
	skippedProxyRow,
	type ProxyRow,
} from '../../helpers/proxyTelemetryFixtures';

const DAY_MS = 86_400_000;

/** A local afternoon in January 2027. Every day below is a local calendar day. */
const NOW = new Date(2027, 0, 20, 15, 0, 0).getTime();

/** Inside every range. */
const RECENT = NOW - 1000;

/**
 * A moment on a local calendar day of January 2027, built from local parts so
 * the day a row lands on does not depend on the time zone of the machine.
 */
function local(day: number, hour = 12, minute = 0): number {
	return new Date(2027, 0, day, hour, minute, 0).getTime();
}

function openDb(): Database.Database {
	const Shim = nodeSqliteBetterSqlite3Mock().default;
	const db = new Shim(':memory:') as unknown as Database.Database;
	runMigrations(db);
	return db;
}

/** Every number in a value, so a test can say none is NaN or infinite. */
function numbersIn(value: unknown): number[] {
	if (typeof value === 'number') return [value];
	if (Array.isArray(value)) return value.flatMap(numbersIn);
	if (value !== null && typeof value === 'object') return Object.values(value).flatMap(numbersIn);
	return [];
}

const READING_ROWS = (overrides: Partial<Record<ProxyProviderClassReading, number>> = {}) => ({
	reported: 0,
	derived: 0,
	'not-applicable': 0,
	unreported: 0,
	legacy: 0,
	absent: 0,
	...overrides,
});

describe.skipIf(!canLoadNodeSqlite())('the proxy usage aggregation on the real v22 table', () => {
	let db: Database.Database;

	/** Record rows at `startedAt`, inside every range unless a case says where. */
	function add(rows: ProxyRow | ProxyRow[], startedAt = RECENT): string[] {
		return [rows].flat().map((row) => recordProxyRequest(db, { ...row, startedAt }));
	}

	function usage(range: StatsTimeRange = 'week'): ProxyRequestUsage {
		return getProxyRequestUsage(db, range);
	}

	function effectiveness(range: StatsTimeRange = 'week'): ProxyEffectiveness {
		const found = usage(range).effectiveness;
		if (!found) throw new Error('getProxyRequestUsage() answered no effectiveness.');
		return found;
	}

	/** `count` read requests that each carry the processing time `ms(index)`. */
	function timedRequests(count: number, ms: (index: number) => number): void {
		for (let index = 1; index <= count; index++) add(legacyProxyRow({ addedLatencyMs: ms(index) }));
	}

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		clearProxyRequestsCache();
		db = openDb();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('a range with nothing in it', () => {
		it('answers every block present, every count 0 and every unknown stated as one', () => {
			const result = usage('week');

			expect(result.effectiveness).toEqual(emptyProxyEffectiveness());
			expect(result.byMode).toEqual([]);
			expect(result.byAgent).toEqual([]);
			expect(result.totals.requests).toBe(0);
		});

		it('divides by nothing anywhere: no NaN and no infinity in the whole answer', () => {
			expect(numbersIn(usage('week')).every(Number.isFinite)).toBe(true);
			// Requests that give every denominator a zero: nothing read, nothing timed,
			// no provider usage, no counts.
			add([passthroughProxyRow(), passthroughProxyRow({ agentId: undefined })]);
			expect(numbersIn(usage('week')).every(Number.isFinite)).toBe(true);
		});

		it('is the same record whatever the range, and answers the same for the same rows', () => {
			for (const range of ['day', 'week', 'month', 'quarter', 'year', 'all'] as const) {
				expect(effectiveness(range)).toEqual(emptyProxyEffectiveness());
			}
			add(currentProxyRow());
			expect(effectiveness('week')).toEqual(effectiveness('week'));
		});
	});

	describe('traffic', () => {
		it('counts the requests by how the proxy handled them', () => {
			add([
				passthroughProxyRow(),
				passthroughProxyRow(),
				legacyProxyRow(),
				currentProxyRow(),
				skippedProxyRow('encoding'),
				// Failed after the compressor returned: skipped, and still read.
				skippedProxyRow('failed', { originalTokens: 100, sentTokens: 100, addedLatencyMs: 4 }),
			]);

			expect(effectiveness().traffic).toEqual({
				carried: 6,
				read: 3,
				skipped: 2,
				shortened: 2,
				blocksShortened: 6,
			});
			// The legacy total reads the same requests.
			expect(usage().totals.requests).toBe(6);
			expect(usage().totals.compressRequests).toBe(3);
		});

		it('leaves out the requests that started before the range, from every part of the answer', () => {
			add(currentProxyRow({ compressorCounts: { logs: 3 } }), NOW - 8 * DAY_MS);
			add(passthroughProxyRow());

			const week = effectiveness('week');
			expect(week.traffic.carried).toBe(1);
			expect(week.blocks.coverage).toEqual({ scope: 'range', counted: 0, of: 0 });
			expect(week.algorithms).toEqual({ uniqueBlocks: 0, algorithms: [] });
			expect(week.trend).toHaveLength(1);

			const month = effectiveness('month');
			expect(month.traffic.carried).toBe(2);
			expect(month.blocks.coverage).toEqual({ scope: 'range', counted: 1, of: 1 });
			expect(month.algorithms.algorithms).toEqual([{ algorithm: 'logs', blocks: 3, requests: 1 }]);
		});

		it('reads from the same start as the totals', () => {
			expect(getTimeRangeStart('week')).toBe(NOW - 7 * DAY_MS);
			add(passthroughProxyRow(), getTimeRangeStart('week'));
			add(passthroughProxyRow(), getTimeRangeStart('week') - 1);

			expect(effectiveness('week').traffic.carried).toBe(1);
			expect(usage('week').totals.requests).toBe(1);
		});
	});

	describe('block counts', () => {
		it('sums the counts over the counted requests only, with how many that is', () => {
			add([
				currentProxyRow(),
				currentProxyRow(),
				legacyProxyRow(),
				legacyProxyRow(),
				legacyProxyRow(),
			]);

			const { blocks, traffic } = effectiveness();

			// Two of the five requests read carry counts.
			expect(blocks.coverage).toEqual({ scope: 'range', counted: 2, of: 5 });
			expect(blocks.counts).toEqual({
				protected: 0,
				vetoed: { failed: 2, recovery: 0, retrieval: 4 },
				candidates: 18,
				belowThreshold: 6,
				kept: 4,
				storeFailed: 2,
				modelFailed: 2,
				shortened: 6,
				verdictReuse: 4,
				requestsWithCandidates: 2,
			});
			// The sums keep the partition each request keeps.
			const counts = blocks.counts!;
			expect(counts.candidates).toBe(
				counts.belowThreshold + counts.storeFailed + counts.kept + counts.shortened
			);
			// The blocks the three legacy requests shortened are real, and are in the
			// total of all requests: they are not in the counted sums.
			expect(traffic.blocksShortened).toBe(15);
			expect(counts.shortened).toBe(6);
		});

		it('says the counts are unknown, not zero, when no request in the range carries them', () => {
			add([legacyProxyRow(), legacyProxyRow()]);

			const { blocks } = effectiveness();

			expect(blocks.coverage).toEqual({ scope: 'range', counted: 0, of: 2 });
			expect(blocks.counts).toBeNull();
		});

		it('keeps a counted zero apart from an unknown', () => {
			const found = currentProxyRow({
				blocksCompressed: 0,
				cacheHits: 0,
				compressorCounts: undefined,
				newBlocks: undefined,
				blockCounts: {
					protected: 0,
					vetoed: { failed: 0, recovery: 0, retrieval: 0 },
					candidates: 0,
					belowThreshold: 0,
					kept: 0,
					storeFailed: 0,
					modelFailed: 0,
				},
			});
			add([found, legacyProxyRow(), legacyProxyRow()]);

			const { blocks } = effectiveness();

			expect(blocks.coverage).toEqual({ scope: 'range', counted: 1, of: 3 });
			expect(blocks.counts).toEqual({
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
			});
		});

		it('does not ask a request forwarded unread to have counts', () => {
			add([passthroughProxyRow(), skippedProxyRow('too-large'), skippedProxyRow('encoding')]);

			expect(effectiveness().blocks).toEqual({
				coverage: { scope: 'range', counted: 0, of: 0 },
				counts: null,
			});
		});

		it('sums every count on its own field, so a swap of two would show', () => {
			// Distinct values, and a partition that holds: 16 + 18 + 17 + 23 = 74.
			add(
				currentProxyRow({
					blocksCompressed: 23,
					cacheHits: 5,
					blockCounts: {
						protected: 11,
						vetoed: { failed: 12, recovery: 13, retrieval: 14 },
						candidates: 74,
						belowThreshold: 16,
						kept: 17,
						storeFailed: 18,
						modelFailed: 19,
					},
				})
			);

			expect(effectiveness().blocks.counts).toEqual({
				protected: 11,
				vetoed: { failed: 12, recovery: 13, retrieval: 14 },
				candidates: 74,
				belowThreshold: 16,
				kept: 17,
				storeFailed: 18,
				modelFailed: 19,
				shortened: 23,
				verdictReuse: 5,
				requestsWithCandidates: 1,
			});
		});

		it('counts the requests that had a candidate apart from the blocks', () => {
			const none = {
				protected: 2,
				vetoed: { failed: 0, recovery: 0, retrieval: 0 },
				candidates: 0,
				belowThreshold: 0,
				kept: 0,
				storeFailed: 0,
				modelFailed: 0,
			};
			add([
				currentProxyRow(),
				currentProxyRow({ blocksCompressed: 0, cacheHits: 0, blockCounts: none }),
			]);

			const counts = effectiveness().blocks.counts!;

			expect(counts.requestsWithCandidates).toBe(1);
			expect(counts.protected).toBe(2);
		});
	});

	describe('verdict reuse and the provider cache', () => {
		it('keeps the two in their own fields, with different numbers', () => {
			add(currentProxyRow({ cacheHits: 2, providerCacheReadTokens: 120_000 }));

			const { blocks, providerClasses } = effectiveness();

			expect(blocks.counts?.verdictReuse).toBe(2);
			expect(providerClasses.cacheRead.tokens).toMatchObject({ kind: 'measured', value: 120_000 });
			// Neither is a function of the other.
			expect(blocks.counts?.verdictReuse).not.toBe(providerClasses.cacheRead.tokens.value);
		});

		it('takes the reuse of the counted requests only, so it is read against their own blocks', () => {
			add([currentProxyRow(), legacyProxyRow({ cacheHits: 50 })]);

			const counts = effectiveness().blocks.counts!;

			expect(counts.verdictReuse).toBe(2);
			expect(counts.verdictReuse).toBeLessThanOrEqual(counts.kept + counts.shortened);
		});
	});

	describe('skips', () => {
		it('counts them by reason, most first, and reads a reason another build wrote as unrecognized', () => {
			add([
				skippedProxyRow('too-large'),
				skippedProxyRow('encoding'),
				skippedProxyRow('encoding'),
				skippedProxyRow('encoding'),
				skippedProxyRow('encoding', { skipReason: 'a-future-reason' }),
				skippedProxyRow('encoding', { skipReason: 'another-future-reason' }),
				passthroughProxyRow(),
			]);

			const { skips, traffic } = effectiveness();

			expect(skips).toEqual([
				{ reason: 'encoding', requests: 3 },
				{ reason: 'unrecognized', requests: 2 },
				{ reason: 'too-large', requests: 1 },
			]);
			// The reasons are one partition of the skipped requests.
			expect(skips.reduce((total, skip) => total + skip.requests, 0)).toBe(traffic.skipped);
			expect(traffic.skipped).toBe(6);
		});

		it('lists none when nothing was skipped', () => {
			add([currentProxyRow(), passthroughProxyRow()]);

			expect(effectiveness().skips).toEqual([]);
		});
	});

	describe('processing time', () => {
		it('withholds the distribution below the minimum and says why, with the count', () => {
			timedRequests(PROXY_LATENCY_MIN_SAMPLES - 1, (index) => index);

			expect(effectiveness().latency).toEqual({
				timed: PROXY_LATENCY_MIN_SAMPLES - 1,
				untimed: 0,
				distribution: null,
				unknown: 'insufficient-samples',
			});
		});

		it('reports the distribution of the timed requests at the minimum', () => {
			timedRequests(PROXY_LATENCY_MIN_SAMPLES, (index) => index);

			const { latency } = effectiveness();
			const expected = percentilesFromSorted(
				Array.from({ length: PROXY_LATENCY_MIN_SAMPLES }, (_, index) => index + 1)
			);

			expect(latency).toEqual({
				timed: PROXY_LATENCY_MIN_SAMPLES,
				untimed: 0,
				distribution: expected,
			});
			expect(expected).toMatchObject({ count: PROXY_LATENCY_MIN_SAMPLES, min: 1, max: 30 });
		});

		it('orders the values before it slices them, whatever order the requests came in', () => {
			const descending = (index: number) => PROXY_LATENCY_MIN_SAMPLES + 1 - index;
			timedRequests(PROXY_LATENCY_MIN_SAMPLES, descending);

			const { latency } = effectiveness();

			expect(latency.distribution).toMatchObject({
				min: 1,
				max: PROXY_LATENCY_MIN_SAMPLES,
				p50: percentilesFromSorted(
					Array.from({ length: PROXY_LATENCY_MIN_SAMPLES }, (_, index) => index + 1)
				).p50,
			});
		});

		it('leaves a read request with no time out of the distribution and counts it as untimed', () => {
			timedRequests(PROXY_LATENCY_MIN_SAMPLES, (index) => index);
			add([
				legacyProxyRow({ addedLatencyMs: undefined }),
				legacyProxyRow({ addedLatencyMs: undefined }),
			]);

			const { latency } = effectiveness();

			expect(latency.timed).toBe(PROXY_LATENCY_MIN_SAMPLES);
			expect(latency.untimed).toBe(2);
			expect(latency.distribution?.count).toBe(PROXY_LATENCY_MIN_SAMPLES);
		});

		it('says not-recorded when the requests that were read carry no time', () => {
			add([
				legacyProxyRow({ addedLatencyMs: undefined }),
				legacyProxyRow({ addedLatencyMs: undefined }),
			]);

			expect(effectiveness().latency).toEqual({
				timed: 0,
				untimed: 2,
				distribution: null,
				unknown: 'not-recorded',
			});
		});

		it('says not-read when nothing was read, and does not count a passthrough request as untimed', () => {
			add([passthroughProxyRow(), skippedProxyRow('encoding')]);

			expect(effectiveness().latency).toEqual({
				timed: 0,
				untimed: 0,
				distribution: null,
				unknown: 'not-read',
			});
		});

		it('takes the mean over the requests that carry a time, so a missing one does not lower it', () => {
			add([
				legacyProxyRow({ addedLatencyMs: 10 }),
				legacyProxyRow({ addedLatencyMs: 20 }),
				legacyProxyRow({ addedLatencyMs: undefined }),
			]);

			const { totals } = usage();

			expect(totals.compressRequests).toBe(3);
			expect(totals.avgAddedLatencyMs).toBe(15);
		});

		it('tells a group with no time from a group measured at 0 ms, for each agent and each mode', () => {
			// The same mean, 0, for two different reasons: one request carries no time, and
			// one was timed at 0 ms. Only the number of timed requests tells them apart.
			add([
				legacyProxyRow({ agentId: 'missing-timing', addedLatencyMs: undefined }),
				currentProxyRow({ agentId: 'measured-zero', addedLatencyMs: 0 }),
			]);

			const result = usage();
			const agent = (id: string) => result.byAgent.find((row) => row.agentId === id)!;
			const mode = (name: string | null) =>
				result.byMode!.find((row) => row.effectiveMode === name)!;

			expect(agent('missing-timing')).toMatchObject({ avgAddedLatencyMs: 0, timedRequests: 0 });
			expect(agent('measured-zero')).toMatchObject({ avgAddedLatencyMs: 0, timedRequests: 1 });
			// Both agents were read; the mode group of the old request has no timed request.
			expect(agent('missing-timing').compressRequests).toBe(1);
			expect(mode(null)).toMatchObject({ avgAddedLatencyMs: 0, timedRequests: 0 });
			expect(mode('compress-early')).toMatchObject({ avgAddedLatencyMs: 0, timedRequests: 1 });
			expect(result.totals).toMatchObject({ avgAddedLatencyMs: 0, timedRequests: 1 });
		});

		it('divides each group by its own timed requests, which add up to the total', () => {
			add([
				legacyProxyRow({ agentId: 'agent-a', addedLatencyMs: 10 }),
				legacyProxyRow({ agentId: 'agent-a', addedLatencyMs: 30 }),
				legacyProxyRow({ agentId: 'agent-a', addedLatencyMs: undefined }),
				currentProxyRow({ agentId: 'agent-b', addedLatencyMs: 100 }),
				passthroughProxyRow({ agentId: 'agent-b' }),
			]);

			const result = usage();

			expect(
				result.byAgent.map((row) => [row.agentId, row.avgAddedLatencyMs, row.timedRequests])
			).toEqual([
				['agent-a', 20, 2],
				['agent-b', 100, 1],
			]);
			for (const rows of [result.byAgent, result.byMode!]) {
				expect(rows.reduce((total, row) => total + (row.timedRequests ?? 0), 0)).toBe(
					result.totals.timedRequests
				);
			}
			// The range-wide view agrees with the sample the totals say they are over.
			expect(effectiveness().latency.timed).toBe(result.totals.timedRequests);
		});

		it('keeps the mean at 0 when no request carries a time, which the latency block tells from a mean of 0', () => {
			add(legacyProxyRow({ addedLatencyMs: undefined }));

			expect(usage().totals.avgAddedLatencyMs).toBe(0);
			expect(effectiveness().latency).toMatchObject({ timed: 0, unknown: 'not-recorded' });
		});
	});

	describe('algorithms', () => {
		it('lists each algorithm without adding the overlap into the unique blocks', () => {
			// One block shortened by two algorithms, twice, and one request with two blocks.
			const overlapping = { json: 1, 'long-lines': 1 };
			add([
				legacyProxyRow({ compressorCounts: overlapping, blocksCompressed: 1 }),
				legacyProxyRow({ compressorCounts: overlapping, blocksCompressed: 1 }),
				legacyProxyRow({ compressorCounts: { logs: 2 }, blocksCompressed: 2 }),
			]);

			const { algorithms } = effectiveness();

			expect(algorithms.uniqueBlocks).toBe(4);
			expect(algorithms.algorithms).toEqual([
				{ algorithm: 'json', blocks: 2, requests: 2 },
				{ algorithm: 'logs', blocks: 2, requests: 1 },
				{ algorithm: 'long-lines', blocks: 2, requests: 2 },
			]);
			const listed = algorithms.algorithms.reduce((total, entry) => total + entry.blocks, 0);
			// The algorithms add up to more than the blocks, which is the overlap.
			expect(listed).toBe(6);
			expect(listed).toBeGreaterThan(algorithms.uniqueBlocks);
			// Unique blocks are the legacy total of blocks shortened, counted once.
			expect(algorithms.uniqueBlocks).toBe(effectiveness().traffic.blocksShortened);
		});

		it('orders by blocks, then by name', () => {
			add([
				legacyProxyRow({ compressorCounts: { model: 1 }, blocksCompressed: 1 }),
				legacyProxyRow({ compressorCounts: { logs: 4, json: 4, search: 5 }, blocksCompressed: 5 }),
			]);

			expect(effectiveness().algorithms.algorithms.map((entry) => entry.algorithm)).toEqual([
				'search',
				'json',
				'logs',
				'model',
			]);
		});

		it('keeps an algorithm another build added, and ignores a cell that is not a map of counts', () => {
			const [first, second, third, fourth] = add([
				legacyProxyRow({ compressorCounts: { logs: 1 }, blocksCompressed: 1 }),
				legacyProxyRow({ compressorCounts: { logs: 1 }, blocksCompressed: 1 }),
				legacyProxyRow({ compressorCounts: { logs: 1 }, blocksCompressed: 1 }),
				legacyProxyRow({ compressorCounts: { logs: 1 }, blocksCompressed: 1 }),
			]);
			const setCell = db.prepare('UPDATE proxy_requests SET compressor_counts = ? WHERE id = ?');
			setCell.run('this is not json', first);
			setCell.run('[1, 2]', second);
			setCell.run(
				'{"future-algorithm": 3, "zero": 0, "negative": -1, "half": 1.5, "text": "4"}',
				third
			);
			// The fourth is left as written.

			const { algorithms } = effectiveness();

			expect(algorithms.algorithms).toEqual([
				{ algorithm: 'future-algorithm', blocks: 3, requests: 1 },
				{ algorithm: 'logs', blocks: 1, requests: 1 },
			]);
			// The cells that could not be read name no algorithm, and their blocks are not attributed.
			expect(algorithms.uniqueBlocks).toBe(2);
			expect(fourth).toBeDefined();
		});

		it('lists nothing for requests that shortened nothing', () => {
			add([
				passthroughProxyRow(),
				currentProxyRow({ compressorCounts: undefined, blocksCompressed: 0 }),
			]);

			expect(effectiveness().algorithms).toEqual({ uniqueBlocks: 0, algorithms: [] });
		});
	});

	describe('provider classes', () => {
		const openAi = () =>
			currentProxyRow({
				providerInputTokens: 100,
				providerCacheReadTokens: 40,
				providerCacheWriteTokens: 0,
				providerOutputTokens: 10,
				providerUsageReportedness: {
					input: 'derived',
					cacheRead: 'reported',
					cacheWrite: 'not-applicable',
					output: 'reported',
				},
			});
		const outputOnly = () =>
			currentProxyRow({
				providerInputTokens: 0,
				providerCacheReadTokens: 0,
				providerCacheWriteTokens: 0,
				providerOutputTokens: 7,
				providerUsageReportedness: {
					input: 'unreported',
					cacheRead: 'unreported',
					cacheWrite: 'unreported',
					output: 'reported',
				},
			});
		const namedZeros = () =>
			currentProxyRow({
				providerInputTokens: 0,
				providerCacheReadTokens: 0,
				providerCacheWriteTokens: 0,
				providerOutputTokens: 5,
				providerUsageReportedness: {
					input: 'reported',
					cacheRead: 'reported',
					cacheWrite: 'reported',
					output: 'reported',
				},
			});

		it('counts each class by how it got its number and sums only what was measured', () => {
			// An OpenAI answer, an Anthropic answer that named only its output, one that named
			// everything as zero, a row from before reporting was tracked, and no usage at all.
			add([openAi(), outputOnly(), namedZeros(), legacyProxyRow(), passthroughProxyRow()]);

			const { providerClasses } = effectiveness();
			const coverage = (counted: number) => ({ scope: 'range', counted, of: 5 });

			expect(providerClasses.input).toEqual({
				tokens: { kind: 'measured', unit: 'tokens', value: 100, coverage: coverage(2) },
				rows: READING_ROWS({ reported: 1, derived: 1, unreported: 1, legacy: 1, absent: 1 }),
			});
			expect(providerClasses.cacheRead).toEqual({
				tokens: { kind: 'measured', unit: 'tokens', value: 40, coverage: coverage(2) },
				rows: READING_ROWS({ reported: 2, unreported: 1, legacy: 1, absent: 1 }),
			});
			// A measured zero is a value; zero by definition is not a measurement.
			expect(providerClasses.cacheWrite).toEqual({
				tokens: { kind: 'measured', unit: 'tokens', value: 0, coverage: coverage(1) },
				rows: READING_ROWS({
					reported: 1,
					'not-applicable': 1,
					unreported: 1,
					legacy: 1,
					absent: 1,
				}),
			});
			expect(providerClasses.output).toEqual({
				tokens: { kind: 'measured', unit: 'tokens', value: 22, coverage: coverage(3) },
				rows: READING_ROWS({ reported: 3, legacy: 1, absent: 1 }),
			});
		});

		it('does not sell the default zeros or the legacy numbers as measured usage', () => {
			add([openAi(), outputOnly(), namedZeros(), legacyProxyRow(), passthroughProxyRow()]);

			const result = usage();

			// The compatibility totals add what is stored: the legacy row's 4,000 input tokens
			// are in them, and they are not a measurement.
			expect(result.totals.provider.inputTokens).toBe(4100);
			expect(result.effectiveness?.providerClasses.input.tokens).toMatchObject({ value: 100 });
			// A request counts as having provider usage when the answer named any.
			expect(result.totals.provider.requests).toBe(4);
		});

		it('adds the six readings of a class up to the requests', () => {
			add([openAi(), outputOnly(), namedZeros(), legacyProxyRow(), passthroughProxyRow()]);
			const rows = db.prepare('SELECT id FROM proxy_requests').all() as Array<{ id: string }>;
			db.prepare('UPDATE proxy_requests SET provider_input_reportedness = ? WHERE id = ?').run(
				'a-future-status',
				rows[0].id
			);

			const { providerClasses, traffic } = effectiveness();

			for (const usageClass of PROXY_PROVIDER_USAGE_CLASSES) {
				const total = Object.values(providerClasses[usageClass].rows).reduce(
					(sum, count) => sum + count,
					0
				);
				expect(total, usageClass).toBe(traffic.carried);
			}
		});

		it('reads a status this build does not know as legacy: unknown, and not summed', () => {
			const [id] = add(openAi());
			db.prepare('UPDATE proxy_requests SET provider_input_reportedness = ? WHERE id = ?').run(
				'a-future-status',
				id
			);

			const { input } = effectiveness().providerClasses;

			expect(input.rows).toEqual(READING_ROWS({ legacy: 1 }));
			expect(input.tokens).toEqual({
				kind: 'measured',
				unit: 'tokens',
				value: null,
				unknown: 'not-recorded',
			});
		});

		it('states a class nobody measured as unknown, with the reason', () => {
			add([legacyProxyRow(), legacyProxyRow()]);
			for (const usageClass of PROXY_PROVIDER_USAGE_CLASSES) {
				expect(effectiveness().providerClasses[usageClass].tokens, usageClass).toEqual({
					kind: 'measured',
					unit: 'tokens',
					value: null,
					unknown: 'not-recorded',
				});
			}
		});

		it('says not-observed for a class the answers did not name, and for answers with no usage', () => {
			add([outputOnly(), outputOnly()]);
			expect(effectiveness().providerClasses.input.tokens).toMatchObject({
				value: null,
				unknown: 'not-observed',
			});
			expect(effectiveness().providerClasses.output.tokens).toMatchObject({ value: 7 * 2 });

			db.exec('DELETE FROM proxy_requests');
			add([passthroughProxyRow()]);
			expect(effectiveness().providerClasses.output.tokens).toMatchObject({
				value: null,
				unknown: 'not-observed',
			});
			expect(effectiveness().providerClasses.output.rows).toEqual(READING_ROWS({ absent: 1 }));
		});

		it('reads the same class as the contract does for every row it can write', () => {
			const rows = [openAi(), outputOnly(), namedZeros(), legacyProxyRow(), passthroughProxyRow()];
			add(rows);

			const { providerClasses } = effectiveness();

			for (const usageClass of PROXY_PROVIDER_USAGE_CLASSES) {
				const expected = READING_ROWS();
				for (const row of rows) expected[proxyProviderClassReading(row, usageClass)] += 1;
				expect(providerClasses[usageClass].rows, usageClass).toEqual(expected);
			}
		});
	});

	describe('the days', () => {
		it('buckets by local calendar day, oldest first, for the days that have a request', () => {
			add(legacyProxyRow({ originalTokens: 10_000, sentTokens: 7_500 }), local(15, 23, 30));
			add(passthroughProxyRow(), local(16, 0, 30));
			add(currentProxyRow({ originalTokens: 4_000, sentTokens: 1_000 }), local(16, 12));
			add([passthroughProxyRow(), passthroughProxyRow()], local(18, 12));

			expect(effectiveness().trend).toEqual([
				{
					date: '2027-01-15',
					requests: 1,
					compressRequests: 1,
					originalTokens: 10_000,
					sentTokens: 7_500,
					blocksShortened: 3,
				},
				{
					date: '2027-01-16',
					requests: 2,
					compressRequests: 1,
					originalTokens: 4_000,
					sentTokens: 1_000,
					blocksShortened: 3,
				},
				{
					date: '2027-01-18',
					requests: 2,
					compressRequests: 0,
					originalTokens: 0,
					sentTokens: 0,
					blocksShortened: 0,
				},
			]);
		});

		it('files a request on the day it started, either side of local midnight', () => {
			add(passthroughProxyRow(), local(16, 0, 0));
			add(passthroughProxyRow(), local(15, 23, 59));

			expect(effectiveness().trend.map((day) => [day.date, day.requests])).toEqual([
				['2027-01-15', 1],
				['2027-01-16', 1],
			]);
			// The key is the one every per-day stat uses.
			expect(effectiveness().trend.map((day) => day.date)).toEqual([
				toLocalYmd(local(15, 23, 59)),
				toLocalYmd(local(16, 0, 0)),
			]);
		});

		it('adds the days up to the totals', () => {
			add(legacyProxyRow(), local(14, 9));
			add(currentProxyRow(), local(15, 9));
			add([passthroughProxyRow(), currentProxyRow()], local(17, 9));
			add(
				skippedProxyRow('failed', { originalTokens: 50, sentTokens: 50, addedLatencyMs: 3 }),
				local(19)
			);

			const result = usage();
			const trend = result.effectiveness!.trend;
			const sum = (pick: (day: (typeof trend)[number]) => number) =>
				trend.reduce((total, day) => total + pick(day), 0);

			expect(sum((day) => day.requests)).toBe(result.totals.requests);
			expect(sum((day) => day.compressRequests)).toBe(result.totals.compressRequests);
			expect(sum((day) => day.originalTokens)).toBe(result.totals.originalTokens);
			expect(sum((day) => day.sentTokens)).toBe(result.totals.sentTokens);
			expect(sum((day) => day.blocksShortened)).toBe(result.effectiveness!.traffic.blocksShortened);
		});

		it('starts a rolling range part way through its first day', () => {
			// A week back from the afternoon of the 20th starts on the afternoon of the 13th.
			add(passthroughProxyRow(), local(13, 9));
			add(passthroughProxyRow(), local(13, 16));

			expect(effectiveness('week').trend).toEqual([
				expect.objectContaining({ date: '2027-01-13', requests: 1 }),
			]);
		});
	});

	describe('the cuts of the totals', () => {
		it('puts the agents, the modes and the total on the same requests', () => {
			add([
				currentProxyRow({ agentId: 'agent-a', effectiveMode: 'compress-early' }),
				currentProxyRow({ agentId: 'agent-a', effectiveMode: 'compress' }),
				legacyProxyRow({ agentId: 'agent-b' }),
				// An agent that was removed, and a request that named none.
				passthroughProxyRow({ agentId: 'agent-gone', effectiveMode: undefined }),
				passthroughProxyRow({ agentId: undefined }),
			]);

			const result = usage();
			const cuts: Record<string, ProxyRequestTotals[]> = {
				agents: result.byAgent,
				modes: result.byMode!,
			};
			const fields = [
				'requests',
				'compressRequests',
				'originalTokens',
				'sentTokens',
				'tokensSaved',
			] as const;

			for (const field of fields) {
				for (const [name, rows] of Object.entries(cuts)) {
					const total = rows.reduce((sum, row) => sum + row[field], 0);
					expect(total, `${name}.${field}`).toBe(result.totals[field]);
				}
			}
			for (const key of [
				'requests',
				'inputTokens',
				'cacheReadTokens',
				'cacheWriteTokens',
				'outputTokens',
			] as const) {
				for (const [name, rows] of Object.entries(cuts)) {
					const total = rows.reduce((sum, row) => sum + row.provider[key], 0);
					expect(total, `${name}.provider.${key}`).toBe(result.totals.provider[key]);
				}
			}
			expect(result.byAgent.map((row) => row.agentId).sort()).toEqual(
				[null, 'agent-a', 'agent-b', 'agent-gone'].sort()
			);
		});

		it('keeps the mode of an old row unknown, a stored passthrough row included', () => {
			add([
				currentProxyRow({ effectiveMode: 'compress-early' }),
				currentProxyRow({ effectiveMode: 'compress' }),
				passthroughProxyRow({ effectiveMode: 'passthrough' }),
				// Written before the mode was recorded: stored `compress`, then stored `passthrough`.
				legacyProxyRow(),
				passthroughProxyRow({ effectiveMode: undefined }),
			]);

			const { byMode } = usage();

			// The stored mode of the old passthrough row is not promoted to a known mode.
			expect(byMode?.map((row) => [row.effectiveMode, row.requests])).toEqual([
				[null, 2],
				['passthrough', 1],
				['compress', 1],
				['compress-early', 1],
			]);
			expect(byMode?.find((row) => row.effectiveMode === null)).toMatchObject({
				requests: 2,
				compressRequests: 1,
			});
		});

		it('reads a stored mode this build does not know as unknown, with the rows that state none', () => {
			const [id] = add(currentProxyRow({ effectiveMode: 'compress' }));
			add(legacyProxyRow());
			db.prepare('UPDATE proxy_requests SET effective_mode = ? WHERE id = ?').run(
				'a-future-mode',
				id
			);

			expect(usage().byMode?.map((row) => [row.effectiveMode, row.requests])).toEqual([[null, 2]]);
		});

		it('orders the modes by requests, then as the policies escalate with the unknown last', () => {
			add([
				currentProxyRow({ effectiveMode: 'compress-early' }),
				currentProxyRow({ effectiveMode: 'compress' }),
				passthroughProxyRow(),
				legacyProxyRow(),
			]);

			expect(usage().byMode?.map((row) => row.effectiveMode)).toEqual([
				'passthrough',
				'compress',
				'compress-early',
				null,
			]);
		});

		it('keeps an agent that was removed in the totals and the cuts', () => {
			add([
				passthroughProxyRow({ agentId: 'agent-gone' }),
				passthroughProxyRow({ agentId: 'agent-gone' }),
			]);

			const result = usage();

			expect(result.byAgent).toEqual([
				expect.objectContaining({ agentId: 'agent-gone', requests: 2 }),
			]);
			expect(result.totals.requests).toBe(2);
		});

		it('sorts equal agents by id so the answer does not depend on the engine', () => {
			add([
				passthroughProxyRow({ agentId: 'agent-b' }),
				passthroughProxyRow({ agentId: 'agent-a' }),
				passthroughProxyRow({ agentId: undefined }),
			]);

			expect(usage().byAgent.map((row) => row.agentId)).toEqual([null, 'agent-a', 'agent-b']);
		});
	});

	describe('against a plain reading of the same rows', () => {
		/** A small deterministic generator, so a failure reproduces. */
		function mulberry32(seed: number): () => number {
			let state = seed;
			return () => {
				state = (state + 0x6d2b79f5) | 0;
				let t = Math.imul(state ^ (state >>> 15), 1 | state);
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
		}

		const STATUSES: readonly ProxyProviderClassStatus[] = [
			'reported',
			'derived',
			'not-applicable',
			'unreported',
		];
		const ALGORITHMS = ['json', 'logs', 'long-lines', 'model'] as const;

		function generate(rand: () => number, count: number): ProxyRow[] {
			const int = (max: number) => Math.floor(rand() * (max + 1));
			const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];

			function counted(): ProxyRow {
				const belowThreshold = int(3);
				const storeFailed = int(2);
				const kept = int(3);
				const shortened = int(3);
				const original = 1_000 + int(9_000);
				const compressors = shortened > 0 ? pick([[0], [1], [0, 1], [2, 3]]) : [];
				return currentProxyRow({
					effectiveMode: pick(['compress', 'compress-early'] as const),
					originalTokens: original,
					sentTokens: original - int(Math.floor(original / 2)),
					addedLatencyMs: rand() < 0.85 ? int(40) : undefined,
					blocksCompressed: shortened,
					cacheHits: int(kept + shortened),
					compressorCounts:
						compressors.length > 0
							? Object.fromEntries(compressors.map((i) => [ALGORITHMS[i], 1 + int(shortened - 1)]))
							: undefined,
					newBlocks: undefined,
					blockCounts: {
						protected: int(3),
						vetoed: { failed: int(2), recovery: int(2), retrieval: int(2) },
						candidates: belowThreshold + storeFailed + kept + shortened,
						belowThreshold,
						kept,
						storeFailed,
						modelFailed: int(kept + shortened),
					},
				});
			}

			function provider(row: ProxyRow): ProxyRow {
				const bare: ProxyRow = {
					...row,
					providerInputTokens: undefined,
					providerCacheReadTokens: undefined,
					providerCacheWriteTokens: undefined,
					providerOutputTokens: undefined,
					providerUsageReportedness: undefined,
				};
				const form = pick(['none', 'legacy', 'reported'] as const);
				if (form === 'none') return bare;
				const tokens = {
					providerInputTokens: int(500),
					providerCacheReadTokens: int(500),
					providerCacheWriteTokens: int(500),
					providerOutputTokens: int(500),
				};
				return form === 'legacy'
					? { ...bare, ...tokens }
					: {
							...bare,
							...tokens,
							providerUsageReportedness: {
								input: pick(STATUSES),
								cacheRead: pick(STATUSES),
								cacheWrite: pick(STATUSES),
								output: pick(STATUSES),
							},
						};
			}

			return Array.from({ length: count }, () => {
				const row = pick(['passthrough', 'legacy', 'counted', 'counted', 'skipped'] as const);
				const base: ProxyRow =
					row === 'passthrough'
						? passthroughProxyRow({ effectiveMode: pick(['passthrough', undefined] as const) })
						: row === 'counted'
							? counted()
							: row === 'skipped'
								? skippedProxyRow('encoding', {
										skipReason: pick(['encoding', 'not-text', 'too-large', 'failed', 'future']),
										...(rand() < 0.3
											? { originalTokens: 80, sentTokens: 80, addedLatencyMs: int(9) }
											: {}),
									})
								: legacyProxyRow({
										originalTokens: 500 + int(500),
										sentTokens: 100 + int(300),
										addedLatencyMs: rand() < 0.85 ? int(40) : undefined,
										blocksCompressed: int(3),
										cacheHits: int(3),
										compressorCounts: rand() < 0.5 ? { logs: 1, json: 1 } : { model: 2 },
									});
				return {
					...provider(base),
					agentId: pick(['agent-a', 'agent-b', undefined] as const),
					startedAt: local(14 + int(5), int(23), int(59)),
				};
			});
		}

		/** What the rows say, read with plain loops: the oracle the SQL is held to. */
		function expectedFrom(rows: ProxyRow[]) {
			const read = rows.filter((row) => row.originalTokens !== undefined);
			const countedRows = rows.filter((row) => row.blockCounts !== undefined);
			const timings = rows
				.flatMap((row) => (row.addedLatencyMs === undefined ? [] : [row.addedLatencyMs]))
				.sort((a, b) => a - b);

			const skips = new Map<string, number>();
			for (const row of rows) {
				if (row.skipReason === undefined) continue;
				const reason = asTokenProxySkipReason(row.skipReason) ?? 'unrecognized';
				skips.set(reason, (skips.get(reason) ?? 0) + 1);
			}

			const algorithms = new Map<string, { blocks: number; requests: number }>();
			let uniqueBlocks = 0;
			for (const row of rows) {
				const counts = Object.entries(row.compressorCounts ?? {}).filter(([, count]) => count > 0);
				if (counts.length === 0) continue;
				uniqueBlocks += row.blocksCompressed;
				for (const [name, count] of counts) {
					const entry = algorithms.get(name) ?? { blocks: 0, requests: 0 };
					entry.blocks += count;
					entry.requests += 1;
					algorithms.set(name, entry);
				}
			}

			const days = new Map<string, ProxyRow[]>();
			for (const row of rows) {
				const day = toLocalYmd(row.startedAt);
				days.set(day, [...(days.get(day) ?? []), row]);
			}

			const sumOf = (list: ProxyRow[], pick: (row: ProxyRow) => number) =>
				list.reduce((total, row) => total + pick(row), 0);

			const classes = Object.fromEntries(
				PROXY_PROVIDER_USAGE_CLASSES.map((usageClass) => {
					const tokenField = (
						{
							input: 'providerInputTokens',
							cacheRead: 'providerCacheReadTokens',
							cacheWrite: 'providerCacheWriteTokens',
							output: 'providerOutputTokens',
						} as const
					)[usageClass];
					const readings = READING_ROWS();
					let measuredTokens = 0;
					for (const row of rows) {
						const reading = proxyProviderClassReading(row, usageClass);
						readings[reading] += 1;
						if (reading === 'reported' || reading === 'derived') {
							measuredTokens += row[tokenField] ?? 0;
						}
					}
					return [usageClass, { readings, measuredTokens }];
				})
			) as Record<
				ProxyProviderUsageClass,
				{ readings: ReturnType<typeof READING_ROWS>; measuredTokens: number }
			>;

			return {
				read,
				countedRows,
				timings,
				skips,
				algorithms,
				uniqueBlocks,
				days,
				classes,
				sumOf,
			};
		}

		it.each([1, 2, 3, 4, 5])('agrees on a generated set of requests (seed %i)', (seed) => {
			const rows = generate(mulberry32(seed), 240);
			for (const row of rows) recordProxyRequest(db, row);
			const found = usage();
			const result = found.effectiveness!;
			const expected = expectedFrom(rows);
			const { sumOf } = expected;

			expect(result.traffic).toEqual({
				carried: rows.length,
				read: expected.read.length,
				skipped: rows.filter((row) => row.skipReason !== undefined).length,
				shortened: rows.filter((row) => row.blocksCompressed > 0).length,
				blocksShortened: sumOf(rows, (row) => row.blocksCompressed),
			});

			const counted = expected.countedRows;
			expect(result.blocks.coverage).toEqual({
				scope: 'range',
				counted: counted.length,
				of: expected.read.length,
			});
			expect(result.blocks.counts).toEqual({
				protected: sumOf(counted, (row) => row.blockCounts!.protected),
				vetoed: {
					failed: sumOf(counted, (row) => row.blockCounts!.vetoed.failed),
					recovery: sumOf(counted, (row) => row.blockCounts!.vetoed.recovery),
					retrieval: sumOf(counted, (row) => row.blockCounts!.vetoed.retrieval),
				},
				candidates: sumOf(counted, (row) => row.blockCounts!.candidates),
				belowThreshold: sumOf(counted, (row) => row.blockCounts!.belowThreshold),
				kept: sumOf(counted, (row) => row.blockCounts!.kept),
				storeFailed: sumOf(counted, (row) => row.blockCounts!.storeFailed),
				modelFailed: sumOf(counted, (row) => row.blockCounts!.modelFailed),
				shortened: sumOf(counted, (row) => row.blocksCompressed),
				verdictReuse: sumOf(counted, (row) => row.cacheHits),
				requestsWithCandidates: counted.filter((row) => row.blockCounts!.candidates > 0).length,
			});

			expect(result.skips).toEqual(
				[...expected.skips.entries()]
					.map(([reason, requests]) => ({ reason, requests }))
					.sort((a, b) => b.requests - a.requests || a.reason.localeCompare(b.reason))
			);

			expect(result.latency).toEqual({
				timed: expected.timings.length,
				untimed: expected.read.filter((row) => row.addedLatencyMs === undefined).length,
				distribution: percentilesFromSorted(expected.timings),
			});

			expect(result.algorithms).toEqual({
				uniqueBlocks: expected.uniqueBlocks,
				algorithms: [...expected.algorithms.entries()]
					.map(([algorithm, entry]) => ({ algorithm, ...entry }))
					.sort((a, b) => b.blocks - a.blocks || a.algorithm.localeCompare(b.algorithm)),
			});

			for (const usageClass of PROXY_PROVIDER_USAGE_CLASSES) {
				const { readings, measuredTokens } = expected.classes[usageClass];
				const measuredRows = readings.reported + readings.derived;
				expect(result.providerClasses[usageClass].rows, usageClass).toEqual(readings);
				expect(result.providerClasses[usageClass].tokens, usageClass).toEqual(
					measuredRows === 0
						? {
								kind: 'measured',
								unit: 'tokens',
								value: null,
								unknown:
									readings.legacy > readings.unreported + readings.absent
										? 'not-recorded'
										: 'not-observed',
							}
						: {
								kind: 'measured',
								unit: 'tokens',
								value: measuredTokens,
								coverage: { scope: 'range', counted: measuredRows, of: rows.length },
							}
				);
			}

			expect(result.trend).toEqual(
				[...expected.days.entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([date, list]) => ({
						date,
						requests: list.length,
						compressRequests: list.filter((row) => row.originalTokens !== undefined).length,
						originalTokens: sumOf(list, (row) => row.originalTokens ?? 0),
						sentTokens: sumOf(list, (row) => row.sentTokens ?? 0),
						blocksShortened: sumOf(list, (row) => row.blocksCompressed),
					}))
			);

			// The cuts of the totals, rolled up from one scan.
			const byMode = new Map<string | null, ProxyRow[]>();
			const byAgent = new Map<string | null, ProxyRow[]>();
			for (const row of rows) {
				byMode.set(row.effectiveMode ?? null, [
					...(byMode.get(row.effectiveMode ?? null) ?? []),
					row,
				]);
				byAgent.set(row.agentId ?? null, [...(byAgent.get(row.agentId ?? null) ?? []), row]);
			}
			const shape = (list: ProxyRow[]) => ({
				requests: list.length,
				compressRequests: list.filter((row) => row.originalTokens !== undefined).length,
				originalTokens: sumOf(list, (row) => row.originalTokens ?? 0),
				sentTokens: sumOf(list, (row) => row.sentTokens ?? 0),
				timedRequests: list.filter((row) => row.addedLatencyMs !== undefined).length,
			});
			const project = (row: {
				requests: number;
				compressRequests: number;
				originalTokens: number;
				sentTokens: number;
				timedRequests?: number;
			}) => ({
				requests: row.requests,
				compressRequests: row.compressRequests,
				originalTokens: row.originalTokens,
				sentTokens: row.sentTokens,
				timedRequests: row.timedRequests,
			});
			expect(new Map(found.byMode!.map((row) => [row.effectiveMode, project(row)]))).toEqual(
				new Map([...byMode.entries()].map(([mode, list]) => [mode, shape(list)]))
			);
			expect(new Map(found.byAgent.map((row) => [row.agentId, project(row)]))).toEqual(
				new Map([...byAgent.entries()].map(([agent, list]) => [agent, shape(list)]))
			);
			expect(project(found.totals)).toEqual(shape(rows));

			// The same rows with the same answer for the effectiveness read alone.
			expect(getProxyEffectiveness(db, getTimeRangeStart('week'))).toEqual(result);
			expect(numbersIn(found).every(Number.isFinite)).toBe(true);
		});
	});
});
