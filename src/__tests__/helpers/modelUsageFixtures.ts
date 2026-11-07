/**
 * `ModelUsage` records for tests of the surfaces that draw one: the Usage
 * Dashboard's Models tab and `maestro-cli stats models`. Both surfaces read the
 * same record, so both are tested against the same two, and a field added to
 * the shape is filled in once.
 *
 * Treat them as read-only. A test that needs a variation spreads one.
 */

import type { ModelUsage } from '../../shared/local-models/model-usage';
import { emptyPercentiles, type DurationPercentiles } from '../../shared/percentiles';

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
			},
		],
	},
};
