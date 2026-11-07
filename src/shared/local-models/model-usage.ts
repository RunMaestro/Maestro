/**
 * Model usage: what every model other than a provider's own did over a time
 * range, with the providers' own cloud beside it for comparison. The record the
 * Usage Dashboard's Models tab draws and `maestro-cli stats models` prints.
 *
 * It is built in one place, `getModelUsage()` in `src/main/stats/model-usage.ts`,
 * from four tables of `stats.db`:
 *
 *   - `local_model_runs` - a run the task router or a System One engine made;
 *   - `query_events`     - an agent turn, on a Run on source or on the provider;
 *   - `proxy_requests`   - what the token proxy carried, and the background
 *                          requests it sent to a Local Models target;
 *   - `s1_decisions`     - what System One decided (kept 30 days).
 *
 * This file holds the shape, and the rules for naming a source that need no
 * database: which source a stored row belongs to, what it is called, and
 * whether it is on this machine.
 */

import { getAgentDisplayName } from '../agentMetadata';
import type { DurationPercentiles } from '../percentiles';
import type { ProxyAgentTotals, ProxyRequestTotals, StatsTimeRange } from '../stats-types';
import type { ModelTier } from '../tierLevels';
import { isLoopbackEndpointUrl, type LocalModelEndpoint } from './endpoints';
import { MODEL_SERVER_ENDPOINT_ID, MODEL_SERVER_NAME } from './model-server';
import { isSystemOneRemoteEngineId } from './system-one-settings';
import { systemOneEngineHost, systemOneEngineLabel } from './system-one';
import type { SystemOneDecisionOutcome } from './system-one-ledger';

/**
 * Where a source's model is:
 *
 *   - `local`      - a catalog model, in-process on this machine;
 *   - `server`     - the Maestro model server;
 *   - `endpoint`   - a server the user runs (Ollama, LM Studio, a cloud API);
 *   - `system-one` - a System One engine reached over the Jev API (Jev, OpenJev);
 *   - `provider`   - a provider's own cloud, behind its own harness.
 */
export const MODEL_USAGE_SOURCE_KINDS = [
	'local',
	'server',
	'endpoint',
	'system-one',
	'provider',
] as const;

export type ModelUsageSourceKind = (typeof MODEL_USAGE_SOURCE_KINDS)[number];

/** What a kind is called where a source's own name does not say it. */
export const MODEL_USAGE_SOURCE_KIND_LABELS: Readonly<Record<ModelUsageSourceKind, string>> =
	Object.freeze({
		local: 'In-process',
		server: 'Model server',
		endpoint: 'Endpoint',
		'system-one': 'System One',
		provider: 'Provider cloud',
	});

/** The key of the two sources that are one of a kind. */
export const MODEL_USAGE_LOCAL_SOURCE_KEY = 'local';
export const MODEL_USAGE_SERVER_SOURCE_KEY = 'server';

/** What the in-process source is called. */
export const MODEL_USAGE_LOCAL_SOURCE_LABEL = 'In-process (this machine)';

/** A source as a stored row names it: the kind, and the id that tells one of a kind from another. */
export interface ModelUsageSourceRef {
	key: string;
	kind: ModelUsageSourceKind;
	/** The endpoint's id, the engine's id or the provider's agent type. Null for `local` and `server`. */
	id: string | null;
}

function sourceRef(kind: ModelUsageSourceKind, id: string | null): ModelUsageSourceRef {
	if (kind === 'local') return { key: MODEL_USAGE_LOCAL_SOURCE_KEY, kind, id: null };
	if (kind === 'server') return { key: MODEL_USAGE_SERVER_SOURCE_KEY, kind, id: null };
	return { key: `${kind}:${id ?? ''}`, kind, id };
}

/**
 * The source a `local_model_runs` row belongs to, read from its `source_type`
 * and `endpoint_id`.
 *
 * A run the Maestro model server answered before stats migration v20 was filed
 * as `endpoint` with the server's id, because `server` was not a source type
 * yet. It is read as the server here, so one source is never drawn as two.
 */
export function modelUsageRunSource(
	sourceType: string,
	endpointId: string | null
): ModelUsageSourceRef {
	if (sourceType === 'local') return sourceRef('local', null);
	if (sourceType === 'server') return sourceRef('server', null);
	if (sourceType === 'system-one') return sourceRef('system-one', endpointId);
	return modelUsageEndpointSource(endpointId);
}

/**
 * The source an endpoint id names: a Run on source on an agent turn
 * (`query_events.run_on_endpoint`), or the target of a background request the
 * token proxy routed. `maestro-server` is the Maestro model server.
 */
export function modelUsageEndpointSource(endpointId: string | null): ModelUsageSourceRef {
	return endpointId === MODEL_SERVER_ENDPOINT_ID
		? sourceRef('server', null)
		: sourceRef('endpoint', endpointId);
}

/** The source of an agent turn on its provider's own model. */
export function modelUsageProviderSource(agentType: string): ModelUsageSourceRef {
	return sourceRef('provider', agentType);
}

/**
 * What only the running app knows about the ids in the stats database. Every
 * field is optional: with none, a source reads as its id and an agent has no
 * name, and every count is the same.
 */
export interface ModelUsageNames {
	/** The saved endpoints. One that was removed since reads as its id. */
	endpoints?: readonly LocalModelEndpoint[];
	/** The user's OpenJev server, for its host and whether it is on this machine. */
	openJevUrl?: string | null;
	/** An agent's name by its id. Returns undefined for an agent that no longer exists. */
	agentName?: (agentId: string) => string | undefined;
}

/** How a person reads a source: its name, and whether it is on this machine. */
export interface ModelUsageSourceIdentity {
	label: string;
	/**
	 * Whether the model is on this machine. Null when that cannot be known: an
	 * endpoint that is no longer saved, and OpenJev with no URL on record.
	 */
	onDevice: boolean | null;
	/** The endpoint's kind (`ollama`, `lmstudio`, `openai-compatible`), when it is still saved. */
	endpointKind: LocalModelEndpoint['kind'] | null;
}

/**
 * Name a source. An endpoint is on this machine when its URL is a loopback
 * address; one on the LAN is not, because the work left this computer.
 */
export function describeModelUsageSource(
	ref: ModelUsageSourceRef,
	names: ModelUsageNames = {}
): ModelUsageSourceIdentity {
	switch (ref.kind) {
		case 'local':
			return { label: MODEL_USAGE_LOCAL_SOURCE_LABEL, onDevice: true, endpointKind: null };
		case 'server':
			return { label: MODEL_SERVER_NAME, onDevice: true, endpointKind: null };
		case 'provider':
			return {
				label: ref.id ? getAgentDisplayName(ref.id) : 'Unknown provider',
				onDevice: false,
				endpointKind: null,
			};
		case 'system-one': {
			if (!isSystemOneRemoteEngineId(ref.id)) {
				return { label: ref.id || 'System One', onDevice: null, endpointKind: null };
			}
			if (ref.id === 'jev-cloud') {
				return { label: systemOneEngineLabel(ref.id), onDevice: false, endpointKind: null };
			}
			const url = names.openJevUrl ?? null;
			return {
				label: systemOneEngineLabel(ref.id, { host: url ? systemOneEngineHost(url) : null }),
				onDevice: url ? isLoopbackEndpointUrl(url) : null,
				endpointKind: null,
			};
		}
		case 'endpoint': {
			const endpoint = names.endpoints?.find((candidate) => candidate.id === ref.id);
			if (!endpoint) {
				return {
					label: ref.id ? `Removed endpoint (${ref.id})` : 'Unknown endpoint',
					onDevice: null,
					endpointKind: null,
				};
			}
			return {
				label: endpoint.name,
				onDevice: isLoopbackEndpointUrl(endpoint.baseUrl),
				endpointKind: endpoint.kind,
			};
		}
	}
}

/** One model a source ran, and how many requests it took. */
export interface ModelUsageModel {
	model: string;
	requests: number;
}

/** How many models a source lists. The rest are summed nowhere: the list is a sample, most used first. */
export const MODEL_USAGE_MAX_MODELS_PER_SOURCE = 8;

/**
 * One source and the work it did in the range.
 *
 * Work reaches a source three ways, and each is counted in its own unit:
 * `runs` (one model call the task router or a System One engine made), `turns`
 * (one agent turn launched on the source, however many model calls it made)
 * and `routed` (one background request the token proxy sent to it in place of
 * the provider). `requests` is their sum.
 */
export interface ModelUsageSource extends ModelUsageSourceRef, ModelUsageSourceIdentity {
	requests: number;
	runs: number;
	turns: number;
	routed: number;
	/**
	 * Runs that failed, and routed requests whose target failed. A turn has no
	 * recorded outcome, so a provider's own cloud always reads 0 here.
	 */
	errors: number;
	/** Runs the caller aborted. Not a fault. */
	cancelled: number;
	/** Tokens the model read and wrote, over runs and turns. A routed request records none. */
	tokensIn: number;
	tokensOut: number;
	/**
	 * Tokens a provider read from, or wrote to, its prompt cache on the turns.
	 * They are not part of `tokensIn`. Always 0 for runs.
	 */
	cachedTokensIn: number;
	/** How long an answered run took. Empty for a source that only ran turns. */
	latency: DurationPercentiles;
	/** How long a turn took, start to exit. Empty for a source that only ran tasks. */
	turnDuration: DurationPercentiles;
	/** The models it ran, most requests first, at most {@link MODEL_USAGE_MAX_MODELS_PER_SOURCE}. */
	models: ModelUsageModel[];
}

/**
 * `12 runs, 3 turns, 1 routed`: how a source's requests split, each in the unit
 * it was counted in. Said wherever a source's request count is shown, because
 * the three units are not the same size of work: a turn is many model calls.
 */
export function describeModelUsageRequestSplit(
	source: Pick<ModelUsageSource, 'runs' | 'turns' | 'routed'>
): string {
	return [
		source.runs > 0 ? `${source.runs} ${source.runs === 1 ? 'run' : 'runs'}` : '',
		source.turns > 0 ? `${source.turns} ${source.turns === 1 ? 'turn' : 'turns'}` : '',
		source.routed > 0 ? `${source.routed} routed` : '',
	]
		.filter(Boolean)
		.join(', ');
}

/**
 * Which duration a source's latency reads from, and what one sample of it is.
 * A source that ran model calls reads `latency` (one request). One that only
 * launched agent turns (a provider's own cloud, a Run on target with no
 * housekeeping work) has no request latency on record, so it reads
 * `turnDuration` (one whole turn, start to exit). The two are never compared
 * without saying which is which: a turn is many requests and the tools between
 * them. Null for a source with no answered work.
 */
export function modelUsageSourceLatency(
	source: Pick<ModelUsageSource, 'latency' | 'turnDuration'>
): { unit: 'request' | 'turn'; distribution: DurationPercentiles } | null {
	if (source.latency.count > 0) return { unit: 'request', distribution: source.latency };
	if (source.turnDuration.count > 0) return { unit: 'turn', distribution: source.turnDuration };
	return null;
}

/** The range summed over every source. */
export interface ModelUsageTotals {
	/** Requests on every source, the providers' own cloud included. */
	requests: number;
	/** Requests on a source that is not a provider's own cloud. */
	otherModelRequests: number;
	/** Requests on a source on this machine. */
	onDeviceRequests: number;
	errors: number;
	tokensIn: number;
	tokensOut: number;
	/** Tokens in and out on the sources on this machine. */
	onDeviceTokens: number;
}

/** How many of a task's runs one source took. */
export interface ModelUsageTaskSource {
	key: string;
	label: string;
	runs: number;
}

/**
 * One task and the runs it made: a housekeeping task (`tab-naming`), a task
 * System One answered (`cue-gate`), or `agent:<verb>` for the requests agents
 * sent through `maestro-cli s1`.
 */
export interface ModelUsageTask {
	taskId: string;
	label: string;
	runs: number;
	errors: number;
	cancelled: number;
	tokensIn: number;
	tokensOut: number;
	/** How long an answered run took. */
	latency: DurationPercentiles;
	/** Where the runs went, most runs first. */
	sources: ModelUsageTaskSource[];
}

/** One Run on target of an agent, and the turns it took. */
export interface ModelUsageAgentTarget {
	sourceKey: string;
	sourceLabel: string;
	model: string;
	turns: number;
}

/**
 * One agent that used a model other than its provider's: it launched turns on
 * a Run on source, or runs were filed for it (a Cue gate, a model routing, its
 * own System One requests). Its turns on the provider's own model are not here.
 */
export interface ModelUsageAgent {
	agentId: string;
	/** Null for an agent that no longer exists. */
	name: string | null;
	/** The provider harness its Run on turns ran behind. Null with no turn. */
	agentType: string | null;
	/** Turns launched on a Run on source. */
	turns: number;
	/** Runs filed for the agent. */
	runs: number;
	/** Tokens of the Run on turns. */
	tokensIn: number;
	tokensOut: number;
	turnDuration: DurationPercentiles;
	/** Where its turns ran, most turns first. */
	targets: ModelUsageAgentTarget[];
}

/** How a set of System One decisions ended. `timeouts` cuts across the failed outcomes. */
export interface ModelUsageDecisionCounts {
	decisions: number;
	/** Answered from the answer cache: nothing was sent. */
	cached: number;
	outcomes: Record<SystemOneDecisionOutcome, number>;
	/** Decisions whose engine gave no answer in time, whichever way they then failed. */
	timeouts: number;
}

export interface ModelUsageSystemOneTask extends ModelUsageDecisionCounts {
	taskId: string;
	label: string;
	/** How long an answer took, cached answers left out. */
	latency: DurationPercentiles;
}

export interface ModelUsageSystemOneEngine {
	/** An engine id, `off`, or the embedding router. */
	engine: string;
	label: string;
	decisions: number;
	answered: number;
}

/**
 * What System One decided. The decisions come from the ledger, which keeps 30
 * days: `coversRange` is false for a range that reaches back further, and the
 * counts are then of the days the ledger still holds. The tier split comes
 * from the agent turns and covers the whole range.
 */
export interface ModelUsageSystemOne extends ModelUsageDecisionCounts {
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
	/** Most decisions first. */
	byTask: ModelUsageSystemOneTask[];
	byEngine: ModelUsageSystemOneEngine[];
	/** Turns sent on Auto whose router decided, by the tier it chose. */
	routedTiers: Record<ModelTier, number>;
	retentionDays: number;
	coversRange: boolean;
}

/** {@link ProxyAgentTotals} with the agent's name. */
export interface ModelUsageProxyAgent extends ProxyAgentTotals {
	/** Null for a request that named no agent, and for an agent that no longer exists. */
	name: string | null;
}

/** What the token proxy carried. The token counts are estimates (`TOKEN_PROXY_ESTIMATE_NOTE`). */
export interface ModelUsageProxy {
	totals: ProxyRequestTotals;
	/** Requests it sent to a Local Models target in place of the provider. */
	routedRequests: number;
	/** Most requests first. */
	byAgent: ModelUsageProxyAgent[];
}

export interface ModelUsage {
	range: StatsTimeRange;
	/** Epoch ms the range starts at. 0 for all time. */
	since: number;
	totals: ModelUsageTotals;
	/** Most requests first. */
	sources: ModelUsageSource[];
	/** Most runs first. */
	byTask: ModelUsageTask[];
	/** Most turns first, then most runs. */
	byAgent: ModelUsageAgent[];
	systemOne: ModelUsageSystemOne;
	proxy: ModelUsageProxy;
}

/** The share of all requests that ran on this machine, 0 to 1. 0 with no request. */
export function modelUsageOnDeviceShare(totals: ModelUsageTotals): number {
	return totals.requests > 0 ? totals.onDeviceRequests / totals.requests : 0;
}

/** Whether the range holds anything the Models tab would draw beyond the providers' own cloud. */
export function isModelUsageEmpty(usage: ModelUsage): boolean {
	return (
		usage.totals.otherModelRequests === 0 &&
		usage.systemOne.decisions === 0 &&
		usage.proxy.totals.requests === 0
	);
}
