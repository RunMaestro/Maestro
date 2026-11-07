/**
 * Tests for what the Models tab derives from a `ModelUsage` record: the
 * headline numbers, the sort orders, the latency bar rows and scale, the Run on
 * agents, and the System One slices. No rendering.
 */

import { describe, it, expect } from 'vitest';
import {
	defaultSortDirection,
	describeAgentTargets,
	formatLatency,
	formatShare,
	latencyBarPercent,
	latencyBarRows,
	modelUsageAgentName,
	otherModelSources,
	routedTierSlices,
	routedTurnCount,
	runOnAgents,
	sortModelSources,
	sortModelTasks,
	sourceLocation,
	summarizeModelUsage,
	systemOneOutcomeSlices,
} from '../../../../renderer/components/UsageDashboard/ModelUsage/modelUsageView';
import {
	COLORBLIND_AGENT_PALETTE,
	COLORBLIND_STATUS_COLORS,
} from '../../../../renderer/constants/colorblindPalettes';
import { BUSY_MODEL_USAGE, EMPTY_MODEL_USAGE } from '../../../helpers/modelUsageFixtures';
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

describe('Run on agents', () => {
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
