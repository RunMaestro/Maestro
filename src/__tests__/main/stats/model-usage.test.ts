/**
 * Tests for the model usage aggregation (`getModelUsage`).
 *
 * The grouping, the percentiles and the range filter are what is under test,
 * so these run against a real SQLite through the `node:sqlite` shim, on a
 * database seeded through the same writers production uses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runMigrations } from '../../../main/stats/migrations';
import { getModelUsage } from '../../../main/stats/model-usage';
import {
	clearLocalModelRunsCache,
	recordLocalModelRun,
} from '../../../main/stats/local-model-runs';
import { clearProxyRequestsCache, recordProxyRequest } from '../../../main/stats/proxy-requests';
import { clearQueryEventCache, insertQueryEvent } from '../../../main/stats/query-events';
import {
	clearSystemOneDecisionsCache,
	insertSystemOneDecision,
} from '../../../main/stats/s1-decisions';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import type {
	ModelUsage,
	ModelUsageNames,
	ModelUsageSource,
} from '../../../shared/local-models/model-usage';
import type { SystemOneDecision } from '../../../shared/local-models/system-one-ledger';
import { emptyPercentiles } from '../../../shared/percentiles';
import type { LocalModelRun, ProxyRequest, QueryEvent } from '../../../shared/stats-types';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';

const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000;

const OLLAMA: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama on this Mac',
	kind: 'ollama',
	baseUrl: 'http://localhost:11434',
	enabled: true,
};

const CLOUD: LocalModelEndpoint = {
	id: 'ep-cloud',
	name: 'Groq',
	kind: 'openai-compatible',
	baseUrl: 'https://api.groq.com/openai/v1',
	enabled: true,
};

const NAMES: ModelUsageNames = {
	endpoints: [OLLAMA, CLOUD],
	openJevUrl: 'http://jev.lan:8080',
	agentName: (id) => ({ 'agent-a': 'Alpha', 'agent-b': 'Beta' })[id],
};

function openDb(): Database.Database {
	const Shim = nodeSqliteBetterSqlite3Mock().default;
	return new Shim(':memory:') as unknown as Database.Database;
}

function source(usage: ModelUsage, key: string): ModelUsageSource {
	const found = usage.sources.find((candidate) => candidate.key === key);
	if (!found) throw new Error(`No source ${key} in ${usage.sources.map((s) => s.key).join(', ')}`);
	return found;
}

describe.skipIf(!canLoadNodeSqlite())('getModelUsage', () => {
	let db: Database.Database;

	function run(overrides: Partial<Omit<LocalModelRun, 'id'>> = {}): void {
		recordLocalModelRun(db, {
			taskId: 'tab-naming',
			sourceType: 'local',
			modelId: 'qwen3-1.7b',
			startedAt: NOW - 1000,
			durationMs: 100,
			outcome: 'ok',
			tokensIn: 100,
			tokensOut: 10,
			...overrides,
		});
	}

	function turn(overrides: Partial<Omit<QueryEvent, 'id'>> = {}): void {
		insertQueryEvent(db, {
			sessionId: 'agent-a',
			agentType: 'claude-code',
			source: 'user',
			startTime: NOW - 1000,
			duration: 60_000,
			...overrides,
		});
	}

	function proxied(overrides: Partial<Omit<ProxyRequest, 'id'>> = {}): void {
		recordProxyRequest(db, {
			route: 'anthropic',
			kind: 'anthropic-messages',
			mode: 'passthrough',
			startedAt: NOW - 1000,
			durationMs: 500,
			status: 200,
			outcome: 'completed',
			requestBytes: 1000,
			sentBytes: 1000,
			responseBytes: 2000,
			blocksCompressed: 0,
			cacheHits: 0,
			...overrides,
		});
	}

	function decision(overrides: Partial<SystemOneDecision> = {}): void {
		insertSystemOneDecision(db, {
			taskId: 'cue-gate',
			engine: 'jev-cloud',
			model: 'jev-1.13.0',
			questionIds: ['proceed'],
			outcome: 'ok',
			startedAt: NOW - 1000,
			latencyMs: 200,
			usage: { inputTokens: 400, outputTokens: 2 },
			costUsd: 0.00002,
			...overrides,
		});
	}

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		clearLocalModelRunsCache();
		clearProxyRequestsCache();
		clearQueryEventCache();
		clearSystemOneDecisionsCache();
		db = openDb();
		runMigrations(db);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('reads an empty database as a record with every block present and nothing in it', () => {
		const usage = getModelUsage(db, 'week');

		expect(usage.range).toBe('week');
		expect(usage.since).toBe(NOW - 7 * DAY_MS);
		expect(usage.totals).toEqual({
			requests: 0,
			otherModelRequests: 0,
			onDeviceRequests: 0,
			errors: 0,
			tokensIn: 0,
			tokensOut: 0,
			onDeviceTokens: 0,
		});
		expect(usage.sources).toEqual([]);
		expect(usage.byTask).toEqual([]);
		expect(usage.byAgent).toEqual([]);
		expect(usage.systemOne).toMatchObject({
			decisions: 0,
			cached: 0,
			timeouts: 0,
			outcomes: {
				ok: 0,
				'failed-open': 0,
				'failed-closed': 0,
				unavailable: 0,
				cancelled: 0,
			},
			byTask: [],
			byEngine: [],
			routedTiers: { low: 0, medium: 0, high: 0 },
			retentionDays: 30,
			coversRange: true,
		});
		expect(usage.proxy).toEqual({
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
		});
	});

	describe('sources', () => {
		it('files each run under the source its row names, with tokens, errors and models', () => {
			run({ durationMs: 100 });
			run({ durationMs: 300, modelId: 'qwen3.5-4b' });
			run({ durationMs: 200, modelId: 'qwen3.5-4b' });
			run({ sourceType: 'server', modelId: 'qwen3-coder', durationMs: 900 });
			run({
				sourceType: 'endpoint',
				endpointId: 'ep-ollama',
				modelId: 'llama3:8b',
				outcome: 'error',
				errorCode: 'network',
				durationMs: 30_000,
				tokensIn: undefined,
				tokensOut: undefined,
			});
			run({ sourceType: 'endpoint', endpointId: 'ep-ollama', modelId: 'llama3:8b' });
			run({
				sourceType: 'endpoint',
				endpointId: 'ep-ollama',
				modelId: 'llama3:8b',
				outcome: 'cancelled',
				tokensIn: undefined,
				tokensOut: undefined,
			});

			const usage = getModelUsage(db, 'week', NAMES);

			// Most requests first; a tie reads in label order.
			expect(usage.sources.map((entry) => entry.key)).toEqual([
				'local',
				'endpoint:ep-ollama',
				'server',
			]);
			expect(source(usage, 'local')).toMatchObject({
				kind: 'local',
				id: null,
				label: 'In-process (this machine)',
				onDevice: true,
				requests: 3,
				runs: 3,
				turns: 0,
				routed: 0,
				errors: 0,
				tokensIn: 300,
				tokensOut: 30,
				models: [
					{ model: 'qwen3.5-4b', requests: 2 },
					{ model: 'qwen3-1.7b', requests: 1 },
				],
			});
			expect(source(usage, 'server')).toMatchObject({
				kind: 'server',
				label: 'Maestro model server',
				onDevice: true,
				runs: 1,
			});
			expect(source(usage, 'endpoint:ep-ollama')).toMatchObject({
				kind: 'endpoint',
				id: 'ep-ollama',
				label: 'Ollama on this Mac',
				endpointKind: 'ollama',
				onDevice: true,
				runs: 3,
				errors: 1,
				cancelled: 1,
				tokensIn: 100,
				tokensOut: 10,
			});
		});

		it('computes p50 and p95 over the answered runs only', () => {
			// 20 answered runs, 10 ms to 200 ms, written out of order.
			for (const step of [7, 20, 1, 13, 4, 18, 10, 2, 16, 5, 19, 8, 11, 3, 14, 17, 6, 12, 9, 15]) {
				run({ durationMs: step * 10 });
			}
			// A timeout and an abort: how long they took is not how fast the source is.
			run({ durationMs: 30_000, outcome: 'error', errorCode: 'timeout' });
			run({ durationMs: 45_000, outcome: 'cancelled' });

			const { latency } = source(getModelUsage(db, 'week'), 'local');

			expect(latency).toMatchObject({ count: 20, min: 10, p50: 110, p95: 200, max: 200 });
			expect(getModelUsage(db, 'week').byTask[0].latency).toEqual(latency);
		});

		it('reads a run filed before v20 as endpoint with the server id as the model server', () => {
			run({ sourceType: 'endpoint', endpointId: 'maestro-server', modelId: 'qwen3-coder' });
			run({ sourceType: 'server', modelId: 'qwen3-coder' });

			const usage = getModelUsage(db, 'week', NAMES);

			expect(usage.sources).toHaveLength(1);
			expect(source(usage, 'server')).toMatchObject({ runs: 2, label: 'Maestro model server' });
		});

		it('names a System One engine, and does not list an engine id as a model', () => {
			run({
				taskId: 'cue-gate',
				sourceType: 'system-one',
				endpointId: 'jev-cloud',
				modelId: 'jev-1.13.0',
			});
			// No answer: the engine's id stands where the model would.
			run({
				taskId: 'cue-gate',
				sourceType: 'system-one',
				endpointId: 'jev-cloud',
				modelId: 'jev-cloud',
				outcome: 'error',
				errorCode: 'timeout',
			});
			run({
				taskId: 'agent:rank',
				sourceType: 'system-one',
				endpointId: 'openjev',
				modelId: 'openjev-small',
			});

			const usage = getModelUsage(db, 'week', NAMES);

			expect(source(usage, 'system-one:jev-cloud')).toMatchObject({
				label: 'Jev (TypeSafe cloud)',
				onDevice: false,
				runs: 2,
				errors: 1,
				models: [{ model: 'jev-1.13.0', requests: 1 }],
			});
			expect(source(usage, 'system-one:openjev')).toMatchObject({
				label: 'OpenJev at jev.lan:8080',
				onDevice: false,
			});
			expect(usage.byTask.map((task) => [task.taskId, task.label])).toEqual([
				['cue-gate', 'Cue gate'],
				['agent:rank', 'Agent: rank'],
			]);
		});

		it('counts a turn on its Run on source, and one on the provider under the provider', () => {
			turn({ duration: 10_000, inputTokens: 50, outputTokens: 5, cacheReadTokens: 900 });
			turn({ duration: 30_000, inputTokens: 70, outputTokens: 7, cacheCreationTokens: 100 });
			turn({ agentType: 'codex', sessionId: 'agent-b', duration: 20_000 });
			turn({
				runOnEndpoint: 'ep-ollama',
				runOnModel: 'qwen3-coder:30b',
				duration: 120_000,
				inputTokens: 4000,
				outputTokens: 600,
			});
			turn({
				runOnEndpoint: 'maestro-server',
				runOnModel: 'qwen3-coder',
				duration: 90_000,
				inputTokens: 1000,
				outputTokens: 100,
			});

			const usage = getModelUsage(db, 'week', NAMES);

			expect(source(usage, 'provider:claude-code')).toMatchObject({
				kind: 'provider',
				id: 'claude-code',
				label: 'Claude Code',
				onDevice: false,
				requests: 2,
				turns: 2,
				runs: 0,
				errors: 0,
				tokensIn: 120,
				tokensOut: 12,
				cachedTokensIn: 1000,
				latency: emptyPercentiles(),
				models: [],
			});
			expect(source(usage, 'provider:claude-code').turnDuration).toMatchObject({
				count: 2,
				min: 10_000,
				max: 30_000,
			});
			expect(source(usage, 'provider:codex')).toMatchObject({ label: 'Codex', turns: 1 });
			expect(source(usage, 'endpoint:ep-ollama')).toMatchObject({
				turns: 1,
				requests: 1,
				tokensIn: 4000,
				tokensOut: 600,
				models: [{ model: 'qwen3-coder:30b', requests: 1 }],
			});
			expect(source(usage, 'server')).toMatchObject({ turns: 1, tokensIn: 1000 });
		});

		it('counts a background request the proxy routed on its target, with its failures', () => {
			proxied({ routedTo: 'ep-ollama:qwen3:latest' });
			proxied({ routedTo: 'ep-ollama:qwen3:latest', outcome: 'upstream-failed', status: 502 });
			proxied({ routedTo: 'maestro-server:qwen3-coder' });
			proxied();

			const usage = getModelUsage(db, 'week', NAMES);

			expect(source(usage, 'endpoint:ep-ollama')).toMatchObject({
				routed: 2,
				requests: 2,
				errors: 1,
				// A model name may hold a colon: the source id ends at the first one.
				models: [{ model: 'qwen3:latest', requests: 2 }],
			});
			expect(source(usage, 'server')).toMatchObject({ routed: 1 });
			expect(usage.proxy.routedRequests).toBe(3);
			expect(usage.proxy.totals.requests).toBe(4);
		});

		it('orders sources by requests and reads an endpoint that was removed as its id', () => {
			run({ sourceType: 'endpoint', endpointId: 'ep-gone', modelId: 'm' });
			run({ sourceType: 'endpoint', endpointId: 'ep-cloud', modelId: 'm' });
			run({ sourceType: 'endpoint', endpointId: 'ep-cloud', modelId: 'm' });

			const usage = getModelUsage(db, 'week', NAMES);

			expect(usage.sources.map((entry) => entry.key)).toEqual([
				'endpoint:ep-cloud',
				'endpoint:ep-gone',
			]);
			expect(source(usage, 'endpoint:ep-cloud')).toMatchObject({ label: 'Groq', onDevice: false });
			expect(source(usage, 'endpoint:ep-gone')).toMatchObject({
				label: 'Removed endpoint (ep-gone)',
				onDevice: null,
				endpointKind: null,
			});
		});

		it('counts the same with no names, with ids where the names would be', () => {
			run({ sourceType: 'endpoint', endpointId: 'ep-ollama' });
			turn({ runOnEndpoint: 'ep-ollama', runOnModel: 'm' });

			const usage = getModelUsage(db, 'week');

			expect(source(usage, 'endpoint:ep-ollama')).toMatchObject({
				requests: 2,
				label: 'Removed endpoint (ep-ollama)',
				onDevice: null,
			});
			expect(usage.byAgent[0]).toMatchObject({ agentId: 'agent-a', name: null });
		});
	});

	it('sums the totals, and counts on-device work only on sources known to be on this machine', () => {
		run({ tokensIn: 100, tokensOut: 10 });
		run({ sourceType: 'server', tokensIn: 200, tokensOut: 20 });
		run({ sourceType: 'endpoint', endpointId: 'ep-ollama', tokensIn: 300, tokensOut: 30 });
		run({
			sourceType: 'endpoint',
			endpointId: 'ep-cloud',
			tokensIn: 400,
			tokensOut: 40,
			outcome: 'error',
		});
		run({ sourceType: 'endpoint', endpointId: 'ep-gone', tokensIn: 500, tokensOut: 50 });
		turn({ inputTokens: 1000, outputTokens: 100 });
		turn({ inputTokens: 1000, outputTokens: 100 });
		turn({ inputTokens: 1000, outputTokens: 100 });

		const { totals } = getModelUsage(db, 'week', NAMES);

		expect(totals).toEqual({
			requests: 8,
			otherModelRequests: 5,
			onDeviceRequests: 3,
			errors: 1,
			tokensIn: 4500,
			tokensOut: 450,
			onDeviceTokens: 660,
		});
	});

	it('breaks the runs down by task, with where each task ran', () => {
		run({ taskId: 'tab-naming' });
		run({ taskId: 'tab-naming', sourceType: 'server' });
		run({ taskId: 'tab-naming', sourceType: 'server', outcome: 'error', tokensIn: undefined });
		run({ taskId: 'git-drafts', sourceType: 'endpoint', endpointId: 'ep-ollama' });
		run({ taskId: 'a-task-from-a-later-build' });

		const usage = getModelUsage(db, 'week', NAMES);

		expect(usage.byTask.map((task) => task.taskId)).toEqual([
			'tab-naming',
			'a-task-from-a-later-build',
			'git-drafts',
		]);
		expect(usage.byTask[0]).toMatchObject({
			label: 'Tab naming',
			runs: 3,
			errors: 1,
			cancelled: 0,
			tokensIn: 200,
			tokensOut: 30,
			sources: [
				{ key: 'server', label: 'Maestro model server', runs: 2 },
				{ key: 'local', label: 'In-process (this machine)', runs: 1 },
			],
		});
		// A task this build does not know reads as its id.
		expect(usage.byTask[1].label).toBe('a-task-from-a-later-build');
		expect(usage.byTask[2].sources).toEqual([
			{ key: 'endpoint:ep-ollama', label: 'Ollama on this Mac', runs: 1 },
		]);
	});

	it('lists the agents that used another model: Run on turns, and the runs filed for them', () => {
		turn({
			sessionId: 'agent-a',
			runOnEndpoint: 'ep-ollama',
			runOnModel: 'qwen3-coder:30b',
			duration: 10_000,
			inputTokens: 100,
			outputTokens: 10,
		});
		turn({
			sessionId: 'agent-a',
			runOnEndpoint: 'ep-ollama',
			runOnModel: 'qwen3-coder:30b',
			duration: 20_000,
			inputTokens: 100,
			outputTokens: 10,
		});
		turn({
			sessionId: 'agent-a',
			runOnEndpoint: 'maestro-server',
			runOnModel: 'qwen3-coder',
			duration: 30_000,
		});
		// A turn on the provider's own model is not Run on work.
		turn({ sessionId: 'agent-a', inputTokens: 9999 });
		turn({ sessionId: 'agent-gone', runOnEndpoint: 'ep-cloud', runOnModel: 'llama-70b' });
		run({ taskId: 'cue-gate', agentId: 'agent-b' });
		run({ taskId: 'model-routing', agentId: 'agent-a' });

		const usage = getModelUsage(db, 'week', NAMES);

		expect(usage.byAgent.map((agent) => agent.agentId)).toEqual([
			'agent-a',
			'agent-gone',
			'agent-b',
		]);
		expect(usage.byAgent[0]).toMatchObject({
			name: 'Alpha',
			agentType: 'claude-code',
			turns: 3,
			runs: 1,
			tokensIn: 200,
			tokensOut: 20,
			targets: [
				{
					sourceKey: 'endpoint:ep-ollama',
					sourceLabel: 'Ollama on this Mac',
					model: 'qwen3-coder:30b',
					turns: 2,
				},
				{
					sourceKey: 'server',
					sourceLabel: 'Maestro model server',
					model: 'qwen3-coder',
					turns: 1,
				},
			],
		});
		expect(usage.byAgent[0].turnDuration).toMatchObject({ count: 3, min: 10_000, max: 30_000 });
		expect(usage.byAgent[1]).toMatchObject({ name: null, turns: 1, runs: 0 });
		expect(usage.byAgent[2]).toMatchObject({
			name: 'Beta',
			agentType: null,
			turns: 0,
			runs: 1,
			targets: [],
		});
	});

	describe('System One', () => {
		it('splits the decisions by outcome, task and engine, and counts timeouts across outcomes', () => {
			decision({ latencyMs: 100 });
			decision({ latencyMs: 300 });
			decision({ latencyMs: 0, cached: true, usage: undefined, costUsd: undefined });
			decision({
				outcome: 'failed-open',
				code: 'timeout',
				latencyMs: 1500,
				usage: undefined,
				costUsd: undefined,
				model: undefined,
			});
			decision({
				taskId: 'injection-screen',
				outcome: 'failed-closed',
				code: 'timeout',
				latencyMs: 1500,
				usage: undefined,
				costUsd: undefined,
			});
			decision({
				taskId: 'injection-screen',
				outcome: 'failed-closed',
				code: 'unavailable',
				latencyMs: 20,
				usage: undefined,
				costUsd: undefined,
			});
			decision({ taskId: 'model-routing', engine: 'embedding-router', latencyMs: 4 });
			decision({
				taskId: 'agent:pick',
				engine: 'off',
				outcome: 'unavailable',
				code: 'off',
				usage: undefined,
				costUsd: undefined,
			});
			decision({
				taskId: 'agent:pick',
				outcome: 'cancelled',
				usage: undefined,
				costUsd: undefined,
			});

			const { systemOne } = getModelUsage(db, 'week');

			expect(systemOne).toMatchObject({
				decisions: 9,
				cached: 1,
				timeouts: 2,
				outcomes: {
					ok: 4,
					'failed-open': 1,
					'failed-closed': 2,
					unavailable: 1,
					cancelled: 1,
				},
				tokensIn: 1200,
				tokensOut: 6,
			});
			expect(systemOne.costUsd).toBeCloseTo(0.00006, 10);
			expect(systemOne.byTask.map((task) => [task.taskId, task.label, task.decisions])).toEqual([
				['cue-gate', 'Cue gate', 4],
				['agent:pick', 'Agent: pick', 2],
				['injection-screen', 'Prompt-injection screen', 2],
				['model-routing', 'Model routing', 1],
			]);
			const gate = systemOne.byTask[0];
			expect(gate).toMatchObject({
				cached: 1,
				timeouts: 1,
				outcomes: { ok: 3, 'failed-open': 1 },
			});
			// The cached answer took no engine time and the timeout took its budget.
			expect(gate.latency).toMatchObject({ count: 2, min: 100, max: 300 });
			expect(systemOne.byEngine).toEqual([
				{ engine: 'jev-cloud', label: 'Jev (TypeSafe cloud)', decisions: 7, answered: 3 },
				{
					engine: 'embedding-router',
					label: expect.any(String),
					decisions: 1,
					answered: 1,
				},
				{ engine: 'off', label: 'Off', decisions: 1, answered: 0 },
			]);
		});

		it('reads the tier split from the turns Auto routed', () => {
			turn({ routedTier: 'low' });
			turn({ routedTier: 'low' });
			turn({ routedTier: 'high', runOnEndpoint: 'ep-ollama', runOnModel: 'm' });
			turn();

			expect(getModelUsage(db, 'week').systemOne.routedTiers).toEqual({
				low: 2,
				medium: 0,
				high: 1,
			});
		});

		it('says when the range reaches back further than the ledger keeps', () => {
			expect(getModelUsage(db, 'day').systemOne.coversRange).toBe(true);
			expect(getModelUsage(db, 'month').systemOne.coversRange).toBe(true);
			expect(getModelUsage(db, 'quarter').systemOne.coversRange).toBe(false);
			expect(getModelUsage(db, 'all').systemOne.coversRange).toBe(false);
		});
	});

	it('carries the proxy totals per agent, with names', () => {
		proxied({
			agentId: 'agent-a',
			mode: 'compress',
			originalTokens: 4000,
			sentTokens: 3000,
			addedLatencyMs: 20,
		});
		proxied({ agentId: 'agent-a' });
		proxied({ agentId: 'agent-gone' });
		proxied();

		const { proxy } = getModelUsage(db, 'week', NAMES);

		expect(proxy.totals).toEqual({
			requests: 4,
			compressRequests: 1,
			originalTokens: 4000,
			sentTokens: 3000,
			tokensSaved: 1000,
			avgAddedLatencyMs: 20,
		});
		expect(proxy.byAgent.map((row) => [row.agentId, row.name, row.requests])).toEqual(
			expect.arrayContaining([
				['agent-a', 'Alpha', 2],
				['agent-gone', null, 1],
				[null, null, 1],
			])
		);
		expect(proxy.byAgent[0].agentId).toBe('agent-a');
	});

	it('leaves out everything that started before the range', () => {
		const old = NOW - 8 * DAY_MS;
		run({ startedAt: old });
		turn({ startTime: old, runOnEndpoint: 'ep-ollama', runOnModel: 'm', routedTier: 'high' });
		proxied({ startedAt: old, routedTo: 'ep-ollama:m' });
		decision({ startedAt: old });
		run({ sourceType: 'server' });

		const week = getModelUsage(db, 'week', NAMES);
		expect(week.sources.map((entry) => entry.key)).toEqual(['server']);
		expect(week.byAgent).toEqual([]);
		expect(week.systemOne.decisions).toBe(0);
		expect(week.systemOne.routedTiers.high).toBe(0);
		expect(week.proxy.totals.requests).toBe(0);
		expect(week.proxy.routedRequests).toBe(0);

		const month = getModelUsage(db, 'month', NAMES);
		expect(month.totals.requests).toBe(4);
		expect(month.systemOne.decisions).toBe(1);
		expect(month.systemOne.routedTiers.high).toBe(1);
		expect(month.proxy.routedRequests).toBe(1);
	});
});
