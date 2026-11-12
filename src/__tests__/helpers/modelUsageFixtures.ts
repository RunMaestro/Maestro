/**
 * `ModelUsage` records for tests of the surfaces that draw one: the Usage
 * Dashboard's Models tab and `maestro-cli stats models`. Both surfaces read the
 * same record, so both are tested against the same two, and a field added to
 * the shape is filled in once.
 *
 * Treat them as read-only. A test that needs a variation spreads one.
 */

import type { ModelUsage, ModelUsageProxy } from '../../shared/local-models/model-usage';
import { emptyPercentiles, type DurationPercentiles } from '../../shared/percentiles';
import { busyProxyEffectiveness } from './proxyTelemetryFixtures';

/** A distribution with the two figures the surfaces print, and plausible others. */
export function modelUsageLatency(p50: number, p95: number, count = 10): DurationPercentiles {
	return { count, min: p50, p50, p75: p50, p90: p95, p95, p99: p95, max: p95 };
}

const NO_OUTCOMES = {
	ok: 0,
	'failed-open': 0,
	'failed-closed': 0,
	unavailable: 0,
	cancelled: 0,
};

/** A range in which nothing ran on any model. */
export const EMPTY_MODEL_USAGE: ModelUsage = {
	range: 'week',
	since: 0,
	totals: {
		requests: 0,
		otherModelRequests: 0,
		onDeviceRequests: 0,
		errors: 0,
		tokensIn: 0,
		tokensOut: 0,
		onDeviceTokens: 0,
	},
	sources: [],
	byTask: [],
	byAgent: [],
	systemOne: {
		decisions: 0,
		cached: 0,
		outcomes: NO_OUTCOMES,
		timeouts: 0,
		tokensIn: 0,
		tokensOut: 0,
		costUsd: 0,
		byTask: [],
		byEngine: [],
		routedTiers: { low: 0, medium: 0, high: 0 },
		retentionDays: 30,
		coversRange: true,
	},
	proxy: {
		totals: {
			requests: 0,
			compressRequests: 0,
			originalTokens: 0,
			sentTokens: 0,
			tokensSaved: 0,
			avgAddedLatencyMs: 0,
		},
		routedRequests: 0,
		byAgent: [],
	},
};

/**
 * A range with every block filled: the model server (runs, Run on turns and a
 * routed request), a provider's own cloud, Jev, two tasks, one Run on agent and
 * one agent with runs only, decisions the ledger no longer fully covers, and
 * proxy traffic with one unattributed row.
 */
export const BUSY_MODEL_USAGE: ModelUsage = {
	range: 'quarter',
	since: 1_700_000_000_000,
	totals: {
		requests: 164,
		otherModelRequests: 124,
		onDeviceRequests: 41,
		errors: 3,
		tokensIn: 1_250_000,
		tokensOut: 80_100,
		onDeviceTokens: 52_000,
	},
	sources: [
		{
			key: 'server',
			kind: 'server',
			id: null,
			label: 'Maestro model server',
			onDevice: true,
			endpointKind: null,
			requests: 41,
			runs: 36,
			turns: 4,
			routed: 1,
			errors: 1,
			cancelled: 0,
			tokensIn: 45_000,
			tokensOut: 3200,
			cachedTokensIn: 0,
			latency: modelUsageLatency(240, 1200),
			turnDuration: modelUsageLatency(60_000, 240_000, 4),
			models: [
				{ model: 'qwen3-coder', requests: 30 },
				{ model: 'qwen3.5-4b', requests: 11 },
			],
		},
		{
			key: 'provider:claude-code',
			kind: 'provider',
			id: 'claude-code',
			label: 'Claude Code',
			onDevice: false,
			endpointKind: null,
			requests: 40,
			runs: 0,
			turns: 40,
			routed: 0,
			errors: 0,
			cancelled: 0,
			tokensIn: 1_200_000,
			tokensOut: 76_000,
			cachedTokensIn: 9_000_000,
			latency: emptyPercentiles(),
			turnDuration: modelUsageLatency(90_000, 600_000, 40),
			models: [],
		},
		{
			key: 'system-one:jev-cloud',
			kind: 'system-one',
			id: 'jev-cloud',
			label: 'Jev (TypeSafe cloud)',
			onDevice: false,
			endpointKind: null,
			requests: 83,
			runs: 83,
			turns: 0,
			routed: 0,
			errors: 2,
			cancelled: 0,
			tokensIn: 5000,
			tokensOut: 900,
			cachedTokensIn: 0,
			latency: modelUsageLatency(123, 410, 81),
			turnDuration: emptyPercentiles(),
			models: [{ model: 'jev-1.13.0', requests: 81 }],
		},
	],
	byTask: [
		{
			taskId: 'cue-gate',
			label: 'Cue gate',
			runs: 83,
			errors: 2,
			cancelled: 0,
			tokensIn: 5000,
			tokensOut: 900,
			latency: modelUsageLatency(123, 410, 81),
			sources: [{ key: 'system-one:jev-cloud', label: 'Jev (TypeSafe cloud)', runs: 83 }],
		},
		{
			taskId: 'tab-naming',
			label: 'Tab naming',
			runs: 36,
			errors: 1,
			cancelled: 0,
			tokensIn: 9000,
			tokensOut: 400,
			latency: modelUsageLatency(240, 1200, 35),
			sources: [{ key: 'server', label: 'Maestro model server', runs: 36 }],
		},
	],
	byAgent: [
		{
			agentId: 'agent-alpha-0001',
			name: 'Alpha',
			agentType: 'claude-code',
			turns: 4,
			runs: 12,
			tokensIn: 36_000,
			tokensOut: 2800,
			turnDuration: modelUsageLatency(60_000, 240_000, 4),
			targets: [
				{
					sourceKey: 'server',
					sourceLabel: 'Maestro model server',
					model: 'qwen3-coder',
					turns: 4,
				},
			],
		},
		{
			// Runs were filed for it, and it launched nothing on another model.
			agentId: 'agent-beta-0002',
			name: 'Beta',
			agentType: null,
			turns: 0,
			runs: 71,
			tokensIn: 0,
			tokensOut: 0,
			turnDuration: emptyPercentiles(),
			targets: [],
		},
	],
	systemOne: {
		decisions: 90,
		cached: 7,
		outcomes: { ...NO_OUTCOMES, ok: 86, 'failed-open': 3, 'failed-closed': 1 },
		timeouts: 2,
		tokensIn: 5000,
		tokensOut: 900,
		costUsd: 0.0019,
		byTask: [
			{
				taskId: 'cue-gate',
				label: 'Cue gate',
				decisions: 90,
				cached: 7,
				outcomes: { ...NO_OUTCOMES, ok: 86, 'failed-open': 3, 'failed-closed': 1 },
				timeouts: 2,
				latency: modelUsageLatency(123, 410, 79),
			},
		],
		byEngine: [{ engine: 'jev-cloud', label: 'Jev (TypeSafe cloud)', decisions: 90, answered: 86 }],
		routedTiers: { low: 10, medium: 5, high: 2 },
		retentionDays: 30,
		coversRange: false,
	},
	proxy: {
		totals: {
			requests: 12,
			compressRequests: 5,
			originalTokens: 40_000,
			sentTokens: 30_000,
			tokensSaved: 10_000,
			avgAddedLatencyMs: 14,
			timedRequests: 5,
		},
		routedRequests: 1,
		byAgent: [
			{
				agentId: 'agent-alpha-0001',
				name: 'Alpha',
				requests: 9,
				compressRequests: 5,
				originalTokens: 40_000,
				sentTokens: 30_000,
				tokensSaved: 10_000,
				avgAddedLatencyMs: 14,
				timedRequests: 5,
			},
			{
				agentId: null,
				name: null,
				requests: 3,
				compressRequests: 0,
				originalTokens: 0,
				sentTokens: 0,
				tokensSaved: 0,
				avgAddedLatencyMs: 0,
				timedRequests: 0,
			},
		],
	},
};

/** Local noon on 2026-11-05: where the week of {@link currentProxyModelUsage} starts. */
export const PROXY_RANGE_SINCE = new Date(2026, 10, 5, 12, 0).getTime();
/** Local 09:41 on 2026-11-12: when that record was read. */
export const PROXY_LOADED_AT = new Date(2026, 10, 12, 9, 41).getTime();

/**
 * The token proxy block a current desktop sends for a week of 120 requests,
 * written out in full and consistent in the ways the contract demands: the modes
 * and the routes each add up to the 120 requests, the agents' estimates add up to
 * the totals, and the days add up to them as well (100 requests read, 100,000
 * estimated tokens as they arrived and 82,000 as they were sent). The trend has
 * real gaps: nothing on 11-05, 11-09 or 11-11, and a day of passthrough requests
 * on 11-08 that the proxy never read. A fresh object each call, so a test may
 * change it. The effectiveness is {@link busyProxyEffectiveness} (120 requests)
 * with that trend and these totals.
 */
export function currentProxyUsage(): ModelUsageProxy {
	const day = (
		date: string,
		requests: number,
		read: number,
		original: number,
		sent: number,
		blocks: number
	) => ({
		date,
		requests,
		compressRequests: read,
		originalTokens: original,
		sentTokens: sent,
		blocksShortened: blocks,
	});
	const group = (
		requests: number,
		read: number,
		original: number,
		sent: number,
		timed: number
	) => ({
		requests,
		compressRequests: read,
		originalTokens: original,
		sentTokens: sent,
		tokensSaved: original - sent,
		avgAddedLatencyMs: 14,
		timedRequests: timed,
		provider: {
			requests,
			inputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			outputTokens: 0,
		},
	});
	return {
		totals: group(120, 100, 100_000, 82_000, 98),
		routedRequests: 0,
		byAgent: [
			{ agentId: 'agent-alpha-0001', name: 'Alpha', ...group(90, 70, 70_000, 58_000, 69) },
			{ agentId: 'agent-beta-0002', name: 'Beta', ...group(30, 30, 30_000, 24_000, 29) },
		],
		byMode: [
			{ effectiveMode: 'compress-early', ...group(70, 70, 70_000, 56_000, 68) },
			{ effectiveMode: 'compress', ...group(30, 30, 30_000, 26_000, 30) },
			{ effectiveMode: 'passthrough', ...group(12, 0, 0, 0, 0) },
			{ effectiveMode: null, ...group(8, 0, 0, 0, 0) },
		],
		byRoute: [
			{ route: 'anthropic', ...group(80, 70, 70_000, 56_000, 68) },
			{ route: 'openai', ...group(30, 30, 30_000, 26_000, 30) },
			{ route: 'chatgpt', ...group(10, 0, 0, 0, 0) },
		],
		effectiveness: {
			...busyProxyEffectiveness(),
			trend: [
				day('2026-11-06', 20, 20, 12_000, 10_000, 30),
				day('2026-11-07', 30, 30, 20_000, 17_000, 50),
				day('2026-11-08', 10, 0, 0, 0, 0),
				day('2026-11-10', 25, 25, 28_000, 23_000, 60),
				day('2026-11-12', 35, 25, 40_000, 32_000, 70),
			],
		},
	};
}

/** The Models record of a week whose proxy block is {@link currentProxyUsage}. */
export function currentProxyModelUsage(proxy: ModelUsageProxy = currentProxyUsage()): ModelUsage {
	return { ...BUSY_MODEL_USAGE, range: 'week', since: PROXY_RANGE_SINCE, proxy };
}
