/**
 * Tests for what the Models tab derives from a `ModelUsage` record: the
 * headline numbers, the sort orders, the latency bar rows and scale, the Run on
 * agents, the System One slices, and the token proxy's trend axis and splits.
 * No rendering.
 */

import { describe, it, expect } from 'vitest';
import {
	PROXY_TREND_MAX_AXIS_DAYS,
	defaultSortDirection,
	describeAgentTargets,
	formatLatency,
	formatShare,
	latencyBarPercent,
	latencyBarRows,
	modelUsageAgentName,
	otherModelSources,
	proxyModeSlices,
	proxyRouteSlices,
	proxyTrendView,
	routedTierSlices,
	routedTurnCount,
	runOnAgents,
	sortModelSources,
	sortModelTasks,
	sourceLocation,
	summarizeModelUsage,
	systemOneOutcomeSlices,
} from '../../../../renderer/components/UsageDashboard/ModelUsage/modelUsageView';
import { getSeriesColor } from '../../../../renderer/components/UsageDashboard/chartUtils';
import {
	COLORBLIND_AGENT_PALETTE,
	COLORBLIND_STATUS_COLORS,
} from '../../../../renderer/constants/colorblindPalettes';
import { addLocalDays } from '../../../../shared/localDay';
import { TOKEN_PROXY_UNKNOWN_LABELS } from '../../../../shared/local-models/token-proxy';
import type { ProxyTrendDay } from '../../../../shared/stats-types';
import {
	BUSY_MODEL_USAGE,
	EMPTY_MODEL_USAGE,
	PROXY_LOADED_AT,
	PROXY_RANGE_SINCE,
	currentProxyUsage,
} from '../../../helpers/modelUsageFixtures';
import { mockTheme } from '../../../helpers/mockTheme';

const labels = (rows: Array<{ label: string }>) => rows.map((row) => row.label);

describe('summarizeModelUsage', () => {
	it('counts the sources that are not a provider cloud, and leaves the provider out of the tokens', () => {
		expect(labels(otherModelSources(BUSY_MODEL_USAGE.sources))).toEqual([
			'Maestro model server',
			'Jev (TypeSafe cloud)',
		]);
		expect(summarizeModelUsage(BUSY_MODEL_USAGE)).toEqual({
			requests: 124,
			allRequests: 164,
			sourceCount: 2,
			errors: 3,
			// The server's 45,000 and Jev's 5,000. The provider's 1.2M is not here.
			tokensIn: 50_000,
			tokensOut: 4100,
			onDeviceShare: 0.25,
			onDeviceRequests: 41,
			onDeviceTokens: 52_000,
			decisions: 90,
			answered: 86,
			costUsd: 0.0019,
		});
	});

	it('is all zeros for a range in which nothing ran', () => {
		expect(summarizeModelUsage(EMPTY_MODEL_USAGE)).toMatchObject({
			requests: 0,
			sourceCount: 0,
			tokensIn: 0,
			onDeviceShare: 0,
			decisions: 0,
		});
	});
});

describe('formatting', () => {
	it('prints a share as a whole percent, and a dash when nothing ran', () => {
		expect(formatShare(0.25, 164)).toBe('25%');
		expect(formatShare(0.614, 10)).toBe('61%');
		expect(formatShare(0, 10)).toBe('0%');
		expect(formatShare(0, 0)).toBe('-');
	});

	it('prints a latency in one unit, from milliseconds to minutes', () => {
		expect(formatLatency(4)).toBe('4ms');
		expect(formatLatency(123.6)).toBe('124ms');
		expect(formatLatency(1200)).toBe('1.2s');
		expect(formatLatency(90_000)).toBe('1.5m');
	});

	it('says where a source ran, and does not guess for one it cannot place', () => {
		expect(sourceLocation({ onDevice: true })).toMatchObject({
			label: 'This machine',
			tone: 'local',
		});
		expect(sourceLocation({ onDevice: false })).toMatchObject({ label: 'Remote', tone: 'remote' });
		expect(sourceLocation({ onDevice: null })).toMatchObject({ label: 'Unknown', tone: 'unknown' });
	});
});

describe('sorting', () => {
	it('starts a name column A to Z and every magnitude biggest first', () => {
		expect(defaultSortDirection('source')).toBe('asc');
		expect(defaultSortDirection('task')).toBe('asc');
		expect(defaultSortDirection('requests')).toBe('desc');
		expect(defaultSortDirection('p95')).toBe('desc');
	});

	it('sorts sources by each column, without changing the record', () => {
		const { sources } = BUSY_MODEL_USAGE;
		const before = labels(sources);

		expect(labels(sortModelSources(sources, 'requests', true))).toEqual([
			'Jev (TypeSafe cloud)',
			'Maestro model server',
			'Claude Code',
		]);
		expect(labels(sortModelSources(sources, 'source', false))).toEqual([
			'Claude Code',
			'Jev (TypeSafe cloud)',
			'Maestro model server',
		]);
		expect(labels(sortModelSources(sources, 'tokensIn', true))[0]).toBe('Claude Code');
		expect(labels(sortModelSources(sources, 'errors', true))[0]).toBe('Jev (TypeSafe cloud)');
		expect(labels(sources)).toEqual(before);
	});

	it('sorts latency on the figure the row shows: a request where there is one, a turn otherwise', () => {
		// Jev 123 ms and the server 240 ms are requests. Claude Code has only
		// turns, at 90 s, so it is the slowest row and sorts last ascending.
		expect(labels(sortModelSources(BUSY_MODEL_USAGE.sources, 'p50', false))).toEqual([
			'Jev (TypeSafe cloud)',
			'Maestro model server',
			'Claude Code',
		]);
	});

	it('breaks a tie by name in both directions', () => {
		const tied = BUSY_MODEL_USAGE.sources.map((source) => ({ ...source, errors: 0 }));
		const ascending = labels(sortModelSources(tied, 'errors', false));
		expect(ascending).toEqual(['Claude Code', 'Jev (TypeSafe cloud)', 'Maestro model server']);
		expect(labels(sortModelSources(tied, 'errors', true))).toEqual(ascending);
	});

	it('sorts tasks by runs, name, tokens and latency', () => {
		const { byTask } = BUSY_MODEL_USAGE;
		expect(labels(sortModelTasks(byTask, 'runs', true))).toEqual(['Cue gate', 'Tab naming']);
		expect(labels(sortModelTasks(byTask, 'task', true))).toEqual(['Tab naming', 'Cue gate']);
		// Tab naming read 9,400 tokens against the gate's 5,900.
		expect(labels(sortModelTasks(byTask, 'tokens', true))).toEqual(['Tab naming', 'Cue gate']);
		expect(labels(sortModelTasks(byTask, 'p95', true))).toEqual(['Tab naming', 'Cue gate']);
	});
});

describe('latency bars', () => {
	it('lists the sources with a sample for the unit, fastest median first', () => {
		expect(latencyBarRows(BUSY_MODEL_USAGE.sources, 'request')).toEqual([
			{ key: 'system-one:jev-cloud', label: 'Jev (TypeSafe cloud)', p50: 123, p95: 410, count: 81 },
			{ key: 'server', label: 'Maestro model server', p50: 240, p95: 1200, count: 10 },
		]);
		// The server is on both charts: it answered requests and ran turns.
		expect(labels(latencyBarRows(BUSY_MODEL_USAGE.sources, 'turn'))).toEqual([
			'Maestro model server',
			'Claude Code',
		]);
		expect(latencyBarRows([], 'request')).toEqual([]);
	});

	it('places a duration on a log scale that ends at the slowest p95', () => {
		expect(latencyBarPercent(1000, 1000)).toBe(100);
		// Ten times faster is one third of the way back on a three-decade track.
		expect(latencyBarPercent(100, 1000)).toBeCloseTo(66.67, 1);
		expect(latencyBarPercent(10, 1000)).toBeCloseTo(33.33, 1);
	});

	it('keeps a very fast source visible and never overruns the track', () => {
		expect(latencyBarPercent(1, 4000)).toBe(2);
		expect(latencyBarPercent(0, 4000)).toBe(2);
		expect(latencyBarPercent(9000, 4000)).toBe(100);
		// A chart whose slowest source is under 10 ms still has a full decade.
		expect(latencyBarPercent(4, 4)).toBeCloseTo(60.2, 1);
	});
});

describe('model source agents', () => {
	it('keeps only the agents that launched a turn on another model', () => {
		expect(runOnAgents(BUSY_MODEL_USAGE.byAgent).map((agent) => agent.name)).toEqual(['Alpha']);
	});

	it('names an agent, one that was removed, and a request with no agent', () => {
		expect(modelUsageAgentName({ agentId: 'agent-alpha-0001', name: 'Alpha' })).toBe('Alpha');
		expect(modelUsageAgentName({ agentId: 'agent-alpha-0001', name: null })).toBe(
			'Removed agent agent-al'
		);
		expect(modelUsageAgentName({ agentId: null, name: null })).toBe(
			'No agent (started outside the app)'
		);
	});

	it('names the first target and counts the rest', () => {
		const [alpha] = BUSY_MODEL_USAGE.byAgent;
		expect(describeAgentTargets(alpha)).toBe('qwen3-coder on Maestro model server');
		expect(
			describeAgentTargets({
				targets: [
					...alpha.targets,
					{ sourceKey: 'endpoint:ep', sourceLabel: 'Ollama', model: 'llama3', turns: 1 },
					{ sourceKey: 'endpoint:ep2', sourceLabel: 'LM Studio', model: 'phi', turns: 1 },
				],
			})
		).toBe('qwen3-coder on Maestro model server +2 more');
		expect(describeAgentTargets({ targets: [] })).toBe('');
	});
});

describe('System One slices', () => {
	it('partitions the decisions into the five outcomes, in the theme status colors', () => {
		const slices = systemOneOutcomeSlices(BUSY_MODEL_USAGE.systemOne, mockTheme, false);
		expect(slices.map((slice) => [slice.label, slice.value])).toEqual([
			['Answered', 86],
			['Failed open', 3],
			['Failed closed', 1],
			['No answer', 0],
			['Cancelled', 0],
		]);
		// Timeouts cut across the failed outcomes, so they are not a slice: the
		// slices sum to the decisions.
		expect(slices.reduce((total, slice) => total + slice.value, 0)).toBe(90);
		expect(slices.slice(0, 3).map((slice) => slice.color)).toEqual([
			mockTheme.colors.success,
			mockTheme.colors.warning,
			mockTheme.colors.error,
		]);
	});

	it('swaps in the colorblind status colors', () => {
		const slices = systemOneOutcomeSlices(BUSY_MODEL_USAGE.systemOne, mockTheme, true);
		expect(slices.slice(0, 3).map((slice) => slice.color)).toEqual([
			COLORBLIND_STATUS_COLORS.success,
			COLORBLIND_STATUS_COLORS.warning,
			COLORBLIND_STATUS_COLORS.error,
		]);
	});

	it('splits the routed turns by tier, low first', () => {
		const { routedTiers } = BUSY_MODEL_USAGE.systemOne;
		expect(routedTurnCount(routedTiers)).toBe(17);
		expect(
			routedTierSlices(routedTiers, mockTheme, false).map((slice) => [slice.label, slice.value])
		).toEqual([
			['Low', 10],
			['Medium', 5],
			['High', 2],
		]);
		expect(routedTierSlices(routedTiers, mockTheme, true).map((slice) => slice.color)).toEqual(
			COLORBLIND_AGENT_PALETTE.slice(0, 3)
		);
		expect(routedTurnCount(EMPTY_MODEL_USAGE.systemOne.routedTiers)).toBe(0);
	});
});

describe('proxyTrendView', () => {
	/** A day of requests the proxy read, with the estimates of what arrived and what was sent. */
	const readDay = (date: string, original: number, sent: number): ProxyTrendDay => ({
		date,
		requests: 10,
		compressRequests: 10,
		originalTokens: original,
		sentTokens: sent,
		blocksShortened: 1,
	});

	it('has nothing to draw for a range with no day', () => {
		expect(proxyTrendView([], PROXY_RANGE_SINCE, PROXY_LOADED_AT)).toEqual({
			days: [],
			original: [],
			sent: [],
			hasData: false,
		});
	});

	it('lays the range out one slot per calendar day, with a gap where nothing was read', () => {
		const { trend } = currentProxyUsage().effectiveness!;
		const view = proxyTrendView(trend, PROXY_RANGE_SINCE, PROXY_LOADED_AT);

		// From the day the range starts to the day the record was read, quiet days included.
		expect(view.days).toEqual([
			'2026-11-05',
			'2026-11-06',
			'2026-11-07',
			'2026-11-08',
			'2026-11-09',
			'2026-11-10',
			'2026-11-11',
			'2026-11-12',
		]);
		// 11-05, 11-09 and 11-11 have no request at all, and 11-08 had requests the
		// proxy never read (passthrough): all four are unknown, not a collapse to 0.
		expect(view.original).toEqual([null, 12_000, 20_000, null, null, 28_000, null, 40_000]);
		expect(view.sent).toEqual([null, 10_000, 17_000, null, null, 23_000, null, 32_000]);
		expect(view.hasData).toBe(true);
		// Nothing is counted twice: the figures of the days are the range's.
		const total = (values: Array<number | null>) =>
			values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
		expect(total(view.original)).toBe(100_000);
		expect(total(view.sent)).toBe(82_000);
	});

	it('runs the axis on to the day the record was read when the latest request is older', () => {
		const view = proxyTrendView(
			[readDay('2026-11-10', 8, 6)],
			PROXY_RANGE_SINCE,
			new Date(2026, 10, 13, 9).getTime()
		);

		// Three quiet days at the end are three gaps: the range is not over when requests stop.
		expect(view.days[0]).toBe('2026-11-05');
		expect(view.days[view.days.length - 1]).toBe('2026-11-13');
		expect(view.original).toEqual([null, null, null, null, null, 8, null, null, null]);
		expect(view.sent).toEqual([null, null, null, null, null, 6, null, null, null]);
	});

	it('keeps a read day with no estimated text as a measured zero, apart from an unread day', () => {
		const view = proxyTrendView(
			[
				{ ...readDay('2026-11-06', 0, 0), compressRequests: 3 },
				{ ...readDay('2026-11-07', 0, 0), compressRequests: 0 },
			],
			0,
			null
		);

		expect(view.original).toEqual([0, null]);
		expect(view.sent).toEqual([0, null]);
		// A day of passthrough requests alone has nothing to draw.
		expect(
			proxyTrendView([{ ...readDay('2026-11-07', 0, 0), compressRequests: 0 }], 0, null).hasData
		).toBe(false);
	});

	it('starts all time at the first day with a request and ends at the last without a read time', () => {
		const view = proxyTrendView(
			[readDay('2026-03-04', 5, 4), readDay('2026-03-02', 9, 7)],
			0,
			null
		);

		// Out of order in, calendar order out, and the quiet day between them is a gap.
		expect(view.days).toEqual(['2026-03-02', '2026-03-03', '2026-03-04']);
		expect(view.original).toEqual([9, null, 5]);
	});

	it('never drops a day that holds data, whatever the range start or read time say', () => {
		const view = proxyTrendView(
			[readDay('2026-11-06', 5, 4), readDay('2026-11-12', 6, 5)],
			// The range starts after the first day, and the record was read before the last.
			new Date(2026, 10, 9, 8).getTime(),
			new Date(2026, 10, 10, 8).getTime()
		);

		expect(view.days[0]).toBe('2026-11-06');
		expect(view.days[view.days.length - 1]).toBe('2026-11-12');
		expect(view.original[0]).toBe(5);
		expect(view.original[view.original.length - 1]).toBe(6);
	});

	it('counts calendar days across a clock change, never 24-hour steps', () => {
		for (const [from, to] of [
			['2026-03-06', '2026-03-10'],
			['2026-10-30', '2026-11-03'],
		] as const) {
			const view = proxyTrendView([readDay(from, 1, 1), readDay(to, 1, 1)], 0, null);
			expect(view.days).toEqual(
				Array.from({ length: view.days.length }, (_, index) => addLocalDays(from, index))
			);
			expect(view.days).toHaveLength(5);
			expect(new Set(view.days).size).toBe(5);
		}
	});

	it('draws one slot per day up to the bound, and only the days with a request past it', () => {
		const first = '2026-01-01';
		const atBound = addLocalDays(first, PROXY_TREND_MAX_AXIS_DAYS - 1);
		const pastBound = addLocalDays(first, PROXY_TREND_MAX_AXIS_DAYS);

		const full = proxyTrendView([readDay(first, 1, 1), readDay(atBound, 2, 1)], 0, null);
		expect(full.days).toHaveLength(PROXY_TREND_MAX_AXIS_DAYS);
		expect(full.original[PROXY_TREND_MAX_AXIS_DAYS - 1]).toBe(2);

		// A row that far out must not make the chart thousands of slots wide, and it
		// must not be dropped either.
		const sparse = proxyTrendView([readDay(first, 1, 1), readDay(pastBound, 2, 1)], 0, null);
		expect(sparse.days).toEqual([first, pastBound]);
		expect(sparse.original).toEqual([1, 2]);
	});

	it('ends on a day it cannot step past, instead of looping on it', () => {
		// `addLocalDays` hands a malformed day back unchanged, so only the bound ends this walk.
		const view = proxyTrendView([readDay('0000-bad', 1, 1), readDay('2026-11-06', 2, 1)], 0, null);

		expect(view.days).toEqual(['0000-bad', '2026-11-06']);
		expect(view.original).toEqual([1, 2]);
	});
});

describe('proxy request splits', () => {
	const { byMode, byRoute } = currentProxyUsage();

	it('splits the requests by mode, and keeps the requests that predate the measure as their own slice', () => {
		const slices = proxyModeSlices(byMode!, mockTheme, false);

		expect(slices.map((slice) => [slice.label, slice.value])).toEqual([
			['Compress early', 70],
			['Compress tool results', 30],
			['Passthrough (count only)', 12],
			[TOKEN_PROXY_UNKNOWN_LABELS['not-recorded'], 8],
		]);
		// A partition: the slices are the requests carried, none dropped and none inferred.
		expect(slices.reduce((total, slice) => total + slice.value, 0)).toBe(120);
		// What is not known has the neutral color, not a series color.
		expect(slices[3].color).toBe(mockTheme.colors.textDim);
		expect(slices[0].color).toBe(mockTheme.colors.accent);
		expect(new Set(slices.map((slice) => slice.color)).size).toBe(4);
	});

	it('takes the series colors in an order that keeps the violet and the indigo for last', () => {
		const groups = Array.from({ length: 9 }, (_, index) => ({
			...byRoute![0],
			route: `route-${index}`,
			requests: 9 - index,
		}));
		const colors = proxyRouteSlices(groups, mockTheme, false).map((slice) => slice.color);

		// Those two read as the accent beside it on a purple theme, so a split uses
		// the greens, cyans and ambers first and still has nine distinct colors.
		expect(colors.slice(0, 3)).toEqual([
			getSeriesColor(0, mockTheme),
			getSeriesColor(1, mockTheme),
			getSeriesColor(4, mockTheme),
		]);
		expect(colors.slice(0, 7)).not.toContain(getSeriesColor(2, mockTheme));
		expect(colors.slice(0, 8)).not.toContain(getSeriesColor(8, mockTheme));
		expect(new Set(colors).size).toBe(9);
	});

	it('uses the colorblind palette for the modes that are known', () => {
		const slices = proxyModeSlices(byMode!, mockTheme, true);

		expect(slices.slice(0, 3).map((slice) => slice.color)).toEqual(
			COLORBLIND_AGENT_PALETTE.slice(0, 3)
		);
		expect(slices[3].color).toBe(mockTheme.colors.textDim);
	});

	it('splits the requests by provider route, naming a route this build does not know as stored', () => {
		const slices = proxyRouteSlices(
			[
				...byRoute!,
				{ ...byRoute![0], route: 'a-newer-route', requests: 2 },
				// An inherited object name is a stored route like any other.
				{ ...byRoute![0], route: 'constructor', requests: 1 },
				{ ...byRoute![0], route: '', requests: 3 },
			],
			mockTheme,
			false
		);

		expect(slices.map((slice) => [slice.label, slice.value])).toEqual([
			['Claude Code', 80],
			['Codex with an OpenAI API key', 30],
			['Codex with a ChatGPT login', 10],
			['a-newer-route', 2],
			['constructor', 1],
			[TOKEN_PROXY_UNKNOWN_LABELS['not-recorded'], 3],
		]);
		expect(slices[5].color).toBe(mockTheme.colors.textDim);
		expect(slices.slice(0, 5).every((slice) => slice.color !== mockTheme.colors.textDim)).toBe(
			true
		);
	});

	it('has no slice for a split that holds no group', () => {
		expect(proxyModeSlices([], mockTheme, false)).toEqual([]);
		expect(proxyRouteSlices([], mockTheme, false)).toEqual([]);
	});
});
