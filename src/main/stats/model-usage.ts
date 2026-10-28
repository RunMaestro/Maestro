/**
 * Model Usage Aggregation
 *
 * What every model other than a provider's own did over a time range, with the
 * providers' own cloud beside it for comparison (see `ModelUsage` in
 * shared/local-models/model-usage.ts). The one read behind the Usage
 * Dashboard's Models tab and `maestro-cli stats models`.
 *
 * Four tables feed it, each read once:
 *
 *   - `local_model_runs` - the task router's and System One's runs;
 *   - `query_events`     - agent turns, on a Run on source or on the provider;
 *   - `proxy_requests`   - the token proxy's totals, and the background requests
 *                          it routed to a Local Models target;
 *   - `s1_decisions`     - System One's outcomes (the ledger keeps 30 days).
 *
 * SQLite has no percentile function, so each of the three row scans is ordered
 * by its duration column and every distribution is sliced from that one pass,
 * the way `queryDurationPercentiles` in aggregations.ts does it: a group's
 * durations arrive already sorted.
 */

import type Database from 'better-sqlite3';
import { percentilesFromSorted } from '../../shared/percentiles';
import type { StatsTimeRange } from '../../shared/stats-types';
import { asTierLevel } from '../../shared/tierLevels';
import {
	describeModelUsageSource,
	MODEL_USAGE_MAX_MODELS_PER_SOURCE,
	modelUsageEndpointSource,
	modelUsageProviderSource,
	modelUsageRunSource,
	type ModelUsage,
	type ModelUsageAgent,
	type ModelUsageDecisionCounts,
	type ModelUsageNames,
	type ModelUsageSource,
	type ModelUsageSourceRef,
	type ModelUsageSystemOne,
	type ModelUsageTask,
	type ModelUsageTotals,
} from '../../shared/local-models/model-usage';
import { EMBEDDING_ROUTER_ENGINE_ID } from '../../shared/local-models/model-routing-task';
import { parseRunOnSpec, isRunOnSourceTarget } from '../../shared/local-models/run-on';
import {
	SYSTEM_ONE_DECISION_OUTCOMES,
	SYSTEM_ONE_LEDGER_RETENTION_DAYS,
	SYSTEM_ONE_LEDGER_RETENTION_MS,
	isSystemOneDecisionOutcome,
	systemOneLedgerEngineLabel,
	systemOneLedgerTaskLabel,
	type SystemOneLedgerTaskId,
} from '../../shared/local-models/system-one-ledger';
import { isSystemOneEngineChoice } from '../../shared/local-models/system-one-settings';
import { getProxyRequestUsage } from './proxy-requests';
import { getTimeRangeStart, perfMetrics } from './utils';

// ============================================================================
// Accumulators
// ============================================================================

interface SourceAcc {
	ref: ModelUsageSourceRef;
	runs: number;
	turns: number;
	routed: number;
	errors: number;
	cancelled: number;
	tokensIn: number;
	tokensOut: number;
	cachedTokensIn: number;
	/** Ascending, because every scan is ordered by its duration. */
	latencies: number[];
	turnDurations: number[];
	models: Map<string, number>;
}

interface TaskAcc {
	runs: number;
	errors: number;
	cancelled: number;
	tokensIn: number;
	tokensOut: number;
	latencies: number[];
	sources: Map<string, number>;
}

interface AgentAcc {
	agentType: string | null;
	turns: number;
	runs: number;
	tokensIn: number;
	tokensOut: number;
	turnDurations: number[];
	/** Keyed by source key and model. */
	targets: Map<string, { sourceKey: string; model: string; turns: number }>;
}

class UsageAcc {
	readonly sources = new Map<string, SourceAcc>();
	readonly tasks = new Map<string, TaskAcc>();
	readonly agents = new Map<string, AgentAcc>();

	source(ref: ModelUsageSourceRef): SourceAcc {
		let acc = this.sources.get(ref.key);
		if (!acc) {
			acc = {
				ref,
				runs: 0,
				turns: 0,
				routed: 0,
				errors: 0,
				cancelled: 0,
				tokensIn: 0,
				tokensOut: 0,
				cachedTokensIn: 0,
				latencies: [],
				turnDurations: [],
				models: new Map(),
			};
			this.sources.set(ref.key, acc);
		}
		return acc;
	}

	task(taskId: string): TaskAcc {
		let acc = this.tasks.get(taskId);
		if (!acc) {
			acc = {
				runs: 0,
				errors: 0,
				cancelled: 0,
				tokensIn: 0,
				tokensOut: 0,
				latencies: [],
				sources: new Map(),
			};
			this.tasks.set(taskId, acc);
		}
		return acc;
	}

	agent(agentId: string): AgentAcc {
		let acc = this.agents.get(agentId);
		if (!acc) {
			acc = {
				agentType: null,
				turns: 0,
				runs: 0,
				tokensIn: 0,
				tokensOut: 0,
				turnDurations: [],
				targets: new Map(),
			};
			this.agents.set(agentId, acc);
		}
		return acc;
	}
}

function bump<K>(counts: Map<K, number>, key: K, by = 1): void {
	counts.set(key, (counts.get(key) ?? 0) + by);
}

// ============================================================================
// Scans
// ============================================================================

interface RunRow {
	task_id: string;
	source_type: string;
	model_id: string;
	endpoint_id: string | null;
	duration_ms: number;
	outcome: string;
	tokens_in: number | null;
	tokens_out: number | null;
	agent_id: string | null;
}

/** The task router's and System One's runs: every source but a provider's own cloud. */
function scanRuns(db: Database.Database, startTime: number, acc: UsageAcc): void {
	const rows = db
		.prepare(
			`
      SELECT task_id, source_type, model_id, endpoint_id, duration_ms, outcome,
             tokens_in, tokens_out, agent_id
      FROM local_model_runs
      WHERE started_at >= ?
      ORDER BY duration_ms ASC
    `
		)
		.all(startTime) as RunRow[];

	for (const row of rows) {
		const source = acc.source(modelUsageRunSource(row.source_type, row.endpoint_id));
		const task = acc.task(row.task_id);
		const tokensIn = row.tokens_in ?? 0;
		const tokensOut = row.tokens_out ?? 0;

		source.runs += 1;
		task.runs += 1;
		source.tokensIn += tokensIn;
		source.tokensOut += tokensOut;
		task.tokensIn += tokensIn;
		task.tokensOut += tokensOut;
		bump(task.sources, source.ref.key);

		if (row.outcome === 'ok') {
			// A failed run's duration is its timeout, not how fast the source is.
			source.latencies.push(row.duration_ms);
			task.latencies.push(row.duration_ms);
		} else if (row.outcome === 'cancelled') {
			source.cancelled += 1;
			task.cancelled += 1;
		} else {
			source.errors += 1;
			task.errors += 1;
		}

		// A System One request with no answer names its engine where a model goes.
		if (row.model_id !== row.endpoint_id) bump(source.models, row.model_id);
		if (row.agent_id !== null) acc.agent(row.agent_id).runs += 1;
	}
}

interface TurnRow {
	session_id: string;
	agent_type: string;
	duration: number;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_creation_tokens: number | null;
	run_on_endpoint: string | null;
	run_on_model: string | null;
	routed_tier: string | null;
}

/**
 * Agent turns: one on a Run on source is that source's work and its agent's,
 * and one on the provider's own model is the provider's, for comparison.
 * Returns the tier split of the turns Auto routed.
 */
function scanTurns(
	db: Database.Database,
	startTime: number,
	acc: UsageAcc
): ModelUsageSystemOne['routedTiers'] {
	const rows = db
		.prepare(
			`
      SELECT session_id, agent_type, duration, input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens, run_on_endpoint, run_on_model, routed_tier
      FROM query_events
      WHERE start_time >= ?
      ORDER BY duration ASC
    `
		)
		.all(startTime) as TurnRow[];

	const routedTiers = { low: 0, medium: 0, high: 0 };
	for (const row of rows) {
		// The two columns are written together; one alone is not a source.
		const ranOnSource = row.run_on_endpoint !== null && row.run_on_model !== null;
		const source = acc.source(
			ranOnSource
				? modelUsageEndpointSource(row.run_on_endpoint)
				: modelUsageProviderSource(row.agent_type)
		);
		const tokensIn = row.input_tokens ?? 0;
		const tokensOut = row.output_tokens ?? 0;

		source.turns += 1;
		source.tokensIn += tokensIn;
		source.tokensOut += tokensOut;
		source.cachedTokensIn += (row.cache_read_tokens ?? 0) + (row.cache_creation_tokens ?? 0);
		source.turnDurations.push(row.duration);

		if (ranOnSource) {
			const model = row.run_on_model as string;
			bump(source.models, model);
			const agent = acc.agent(row.session_id);
			agent.agentType = row.agent_type;
			agent.turns += 1;
			agent.tokensIn += tokensIn;
			agent.tokensOut += tokensOut;
			agent.turnDurations.push(row.duration);
			const targetKey = `${source.ref.key}\u0000${model}`;
			const target = agent.targets.get(targetKey);
			if (target) target.turns += 1;
			else agent.targets.set(targetKey, { sourceKey: source.ref.key, model, turns: 1 });
		}

		const tier = asTierLevel(row.routed_tier);
		if (tier) routedTiers[tier] += 1;
	}
	return routedTiers;
}

/**
 * Background requests the token proxy sent to a Local Models target in place
 * of the provider. `routed_to` is a Run on spelling (`<source id>:<model>`).
 * Returns how many there were.
 */
function scanRoutedRequests(db: Database.Database, startTime: number, acc: UsageAcc): number {
	const rows = db
		.prepare(
			`
      SELECT routed_to,
             COUNT(*) AS requests,
             SUM(CASE WHEN outcome = 'upstream-failed' THEN 1 ELSE 0 END) AS errors
      FROM proxy_requests
      WHERE started_at >= ? AND routed_to IS NOT NULL
      GROUP BY routed_to
    `
		)
		.all(startTime) as Array<{ routed_to: string; requests: number; errors: number }>;

	let total = 0;
	for (const row of rows) {
		// node:sqlite and better-sqlite3 disagree on integer types for an aggregate.
		const requests = Number(row.requests);
		total += requests;
		const parsed = parseRunOnSpec(row.routed_to);
		const target = parsed.ok && isRunOnSourceTarget(parsed.target) ? parsed.target : undefined;
		// A spelling a later build cannot read still counts, under no endpoint.
		const source = acc.source(modelUsageEndpointSource(target?.endpointId ?? null));
		source.routed += requests;
		source.errors += Number(row.errors);
		if (target) bump(source.models, target.model, requests);
	}
	return total;
}

interface DecisionRow {
	task_id: string;
	engine: string;
	outcome: string;
	error_code: string | null;
	latency_ms: number;
	tokens_in: number | null;
	tokens_out: number | null;
	cost_usd: number | null;
	cached: number;
}

function emptyDecisionCounts(): ModelUsageDecisionCounts {
	return {
		decisions: 0,
		cached: 0,
		outcomes: Object.fromEntries(
			SYSTEM_ONE_DECISION_OUTCOMES.map((outcome) => [outcome, 0])
		) as ModelUsageDecisionCounts['outcomes'],
		timeouts: 0,
	};
}

function countDecision(counts: ModelUsageDecisionCounts, row: DecisionRow): void {
	counts.decisions += 1;
	if (row.cached) counts.cached += 1;
	if (isSystemOneDecisionOutcome(row.outcome)) counts.outcomes[row.outcome] += 1;
	if (row.error_code === 'timeout') counts.timeouts += 1;
}

/** A stored engine can be one a later build no longer has; it reads as its id. */
function engineLabel(engine: string): string {
	return isSystemOneEngineChoice(engine) || engine === EMBEDDING_ROUTER_ENGINE_ID
		? systemOneLedgerEngineLabel(engine)
		: engine;
}

/** What System One decided, from the ledger. */
function scanDecisions(
	db: Database.Database,
	startTime: number
): Omit<ModelUsageSystemOne, 'routedTiers' | 'retentionDays' | 'coversRange'> {
	const rows = db
		.prepare(
			`
      SELECT task_id, engine, outcome, error_code, latency_ms, tokens_in, tokens_out,
             cost_usd, cached
      FROM s1_decisions
      WHERE started_at >= ?
      ORDER BY latency_ms ASC
    `
		)
		.all(startTime) as DecisionRow[];

	const all = emptyDecisionCounts();
	const tasks = new Map<string, { counts: ModelUsageDecisionCounts; latencies: number[] }>();
	const engines = new Map<string, { decisions: number; answered: number }>();
	let tokensIn = 0;
	let tokensOut = 0;
	let costUsd = 0;

	for (const row of rows) {
		countDecision(all, row);
		let task = tasks.get(row.task_id);
		if (!task) {
			task = { counts: emptyDecisionCounts(), latencies: [] };
			tasks.set(row.task_id, task);
		}
		countDecision(task.counts, row);
		// A cached answer took no engine time, and a missing one took its timeout.
		if (!row.cached && row.outcome === 'ok') task.latencies.push(row.latency_ms);

		let engine = engines.get(row.engine);
		if (!engine) {
			engine = { decisions: 0, answered: 0 };
			engines.set(row.engine, engine);
		}
		engine.decisions += 1;
		if (row.outcome === 'ok') engine.answered += 1;

		tokensIn += row.tokens_in ?? 0;
		tokensOut += row.tokens_out ?? 0;
		costUsd += row.cost_usd ?? 0;
	}

	return {
		...all,
		tokensIn,
		tokensOut,
		costUsd,
		byTask: [...tasks.entries()]
			.map(([taskId, task]) => ({
				taskId,
				label: systemOneLedgerTaskLabel(taskId as SystemOneLedgerTaskId),
				...task.counts,
				latency: percentilesFromSorted(task.latencies),
			}))
			.sort((a, b) => b.decisions - a.decisions || a.label.localeCompare(b.label)),
		byEngine: [...engines.entries()]
			.map(([engine, counts]) => ({ engine, label: engineLabel(engine), ...counts }))
			.sort((a, b) => b.decisions - a.decisions || a.label.localeCompare(b.label)),
	};
}

// ============================================================================
// Shaping
// ============================================================================

function toSource(acc: SourceAcc, names: ModelUsageNames): ModelUsageSource {
	return {
		...acc.ref,
		...describeModelUsageSource(acc.ref, names),
		requests: acc.runs + acc.turns + acc.routed,
		runs: acc.runs,
		turns: acc.turns,
		routed: acc.routed,
		errors: acc.errors,
		cancelled: acc.cancelled,
		tokensIn: acc.tokensIn,
		tokensOut: acc.tokensOut,
		cachedTokensIn: acc.cachedTokensIn,
		latency: percentilesFromSorted(acc.latencies),
		turnDuration: percentilesFromSorted(acc.turnDurations),
		models: [...acc.models.entries()]
			.map(([model, requests]) => ({ model, requests }))
			.sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model))
			.slice(0, MODEL_USAGE_MAX_MODELS_PER_SOURCE),
	};
}

function sumTotals(sources: ModelUsageSource[]): ModelUsageTotals {
	const totals: ModelUsageTotals = {
		requests: 0,
		otherModelRequests: 0,
		onDeviceRequests: 0,
		errors: 0,
		tokensIn: 0,
		tokensOut: 0,
		onDeviceTokens: 0,
	};
	for (const source of sources) {
		totals.requests += source.requests;
		totals.errors += source.errors;
		totals.tokensIn += source.tokensIn;
		totals.tokensOut += source.tokensOut;
		if (source.kind !== 'provider') totals.otherModelRequests += source.requests;
		if (source.onDevice) {
			totals.onDeviceRequests += source.requests;
			totals.onDeviceTokens += source.tokensIn + source.tokensOut;
		}
	}
	return totals;
}

function toTask(
	taskId: string,
	acc: TaskAcc,
	sourceLabels: ReadonlyMap<string, string>
): ModelUsageTask {
	return {
		taskId,
		label: systemOneLedgerTaskLabel(taskId as SystemOneLedgerTaskId),
		runs: acc.runs,
		errors: acc.errors,
		cancelled: acc.cancelled,
		tokensIn: acc.tokensIn,
		tokensOut: acc.tokensOut,
		latency: percentilesFromSorted(acc.latencies),
		sources: [...acc.sources.entries()]
			.map(([key, runs]) => ({ key, label: sourceLabels.get(key) ?? key, runs }))
			.sort((a, b) => b.runs - a.runs || a.label.localeCompare(b.label)),
	};
}

function toAgent(
	agentId: string,
	acc: AgentAcc,
	names: ModelUsageNames,
	sourceLabels: ReadonlyMap<string, string>
): ModelUsageAgent {
	return {
		agentId,
		name: names.agentName?.(agentId) ?? null,
		agentType: acc.agentType,
		turns: acc.turns,
		runs: acc.runs,
		tokensIn: acc.tokensIn,
		tokensOut: acc.tokensOut,
		turnDuration: percentilesFromSorted(acc.turnDurations),
		targets: [...acc.targets.values()]
			.map((target) => ({
				...target,
				sourceLabel: sourceLabels.get(target.sourceKey) ?? target.sourceKey,
			}))
			.sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model)),
	};
}

// ============================================================================
// Orchestrator
// ============================================================================

/**
 * What every model other than a provider's own did in the range, per source,
 * per task and per agent, with System One's decisions and the token proxy's
 * totals. `names` is what only the running app knows (endpoint names, agent
 * names); without it the counts are the same and ids stand where names would.
 */
export function getModelUsage(
	db: Database.Database,
	range: StatsTimeRange,
	names: ModelUsageNames = {}
): ModelUsage {
	const perfStart = perfMetrics.start();
	// Read before the range start, so a range as long as the ledger's retention
	// (month) is never judged a few milliseconds longer than it.
	const now = Date.now();
	const startTime = getTimeRangeStart(range);

	const acc = new UsageAcc();
	scanRuns(db, startTime, acc);
	const routedTiers = scanTurns(db, startTime, acc);
	const routedRequests = scanRoutedRequests(db, startTime, acc);
	const decisions = scanDecisions(db, startTime);
	const proxy = getProxyRequestUsage(db, range);

	const sources = [...acc.sources.values()]
		.map((source) => toSource(source, names))
		.sort((a, b) => b.requests - a.requests || a.label.localeCompare(b.label));
	const sourceLabels = new Map(sources.map((source) => [source.key, source.label]));

	const usage: ModelUsage = {
		range,
		since: startTime,
		totals: sumTotals(sources),
		sources,
		byTask: [...acc.tasks.entries()]
			.map(([taskId, task]) => toTask(taskId, task, sourceLabels))
			.sort((a, b) => b.runs - a.runs || a.label.localeCompare(b.label)),
		byAgent: [...acc.agents.entries()]
			.map(([agentId, agent]) => toAgent(agentId, agent, names, sourceLabels))
			.sort((a, b) => b.turns - a.turns || b.runs - a.runs || a.agentId.localeCompare(b.agentId)),
		systemOne: {
			...decisions,
			routedTiers,
			retentionDays: SYSTEM_ONE_LEDGER_RETENTION_DAYS,
			coversRange: startTime >= now - SYSTEM_ONE_LEDGER_RETENTION_MS,
		},
		proxy: {
			totals: proxy.totals,
			routedRequests,
			byAgent: proxy.byAgent.map((row) => ({
				...row,
				name: row.agentId === null ? null : (names.agentName?.(row.agentId) ?? null),
			})),
		},
	};

	perfMetrics.end(perfStart, 'getModelUsage', { range, sources: sources.length });
	return usage;
}
