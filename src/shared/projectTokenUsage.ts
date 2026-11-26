/**
 * The host op behind the Usage Dashboard's token totals for agents whose conversations are on
 * another computer: "the token usage of these projects' conversations, computed where the
 * transcripts are".
 *
 * A requester (the desktop, for its SSH and hosted agents) sends `get_project_token_usage` with the
 * provider and the host-side working directory of each agent. The host reads its own transcripts
 * with the same session storages its own dashboard reads (`projectTokenUsage()` in
 * `src/main/stats/token-usage/project-breakdowns.ts`) and answers, per project in the order asked,
 * whether it read it and one numeric breakdown per conversation. No transcript text crosses the
 * wire: only ids, a model name, and numbers.
 *
 * Both host kinds answer it: the desktop (`WebSocketMessageHandler`) and a headless
 * `maestro-cli host` (`src/cli/services/host-token-usage.ts`). A host that does not know the
 * message answers `unsupported`, and the requester leaves that agent "not counted".
 *
 * Every number from another machine is untrusted input: `parseProjectTokenUsageReply()` reads it
 * field by field and keeps only finite, non-negative, bounded values. A project counts as read only
 * when the host says it read it whole AND every record of it held together; anything less leaves
 * its agent "not counted", so a total is never quietly short. Pure: no I/O, no Electron.
 */

import {
	DEFAULT_ACCOUNT_KEY,
	type ModelTokenUsage,
	type SessionTokenBreakdown,
	type TokenCoverage,
} from './tokenUsage';
import type { UsageAccounting, UsageCost } from './types';
import { mergeUsageCost } from './maestro-lib/streaming/usage-totals';

/** The request message type. */
export const PROJECT_TOKEN_USAGE_MESSAGE = 'get_project_token_usage';
/** The reply message type. */
export const PROJECT_TOKEN_USAGE_REPLY = 'project_token_usage_result';

/**
 * How long a requester waits for one remote's host before leaving its agents "not counted". A
 * read of the token totals that may ask remotes waits this long plus its own margin.
 */
export const REMOTE_TOKEN_USAGE_TIMEOUT_MS = 30_000;

/**
 * The error a host answers when it could not read the usage. Always this text: the cause can name
 * the host's own paths, so it stays in the host's log.
 */
export const PROJECT_TOKEN_USAGE_FAILED = 'The host could not read the token usage.';

/** The most projects one request may name. A caller with more asks in chunks (`chunkProjects`). */
export const MAX_PROJECT_TOKEN_USAGE_PROJECTS = 64;
/** The most conversations one reply may carry, over all its projects. */
export const MAX_PROJECT_TOKEN_USAGE_BREAKDOWNS = 50_000;
/** The most model buckets one conversation may carry; the rest fold into one unnamed bucket. */
const MAX_MODELS_PER_SESSION = 64;
/** A token count past this is not a real conversation. */
const MAX_TOKENS = 1e13;
/** More skipped transcripts than this in one project is not a real answer. */
const MAX_SKIPPED_FILES = 1e6;
/** A cost past this (USD) is not a real conversation. */
const MAX_COST_USD = 1e7;
/** The largest timestamp a Date can hold. */
const MAX_TIMESTAMP_MS = 8.64e15;
const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_MODEL_LENGTH = 256;
const MAX_PROVIDER_LENGTH = 64;
const MAX_LABEL_LENGTH = 128;
/** USD ticks (10^-10 USD) as the canonical accounting writes them: digits only. */
const TICKS_PATTERN = /^\d{1,30}$/;
/** {@link MAX_COST_USD} in ticks. */
const MAX_COST_TICKS = BigInt(MAX_COST_USD) * 10_000_000_000n;

/** One project a requester asks about: which provider, and its working directory on the host. */
export interface ProjectTokenUsageProject {
	provider: string;
	projectPath: string;
}

/**
 * What a host did with one project. `read`: every conversation of it is in `breakdowns`.
 * `failed`: the host could not read it (or part of it). `unsupported`: the host has no reader for
 * the provider.
 */
export type ProjectTokenUsageStatus = 'read' | 'failed' | 'unsupported';

/** The answer for one project. */
export interface ProjectTokenUsageResult {
	status: ProjectTokenUsageStatus;
	breakdowns: SessionTokenBreakdown[];
	/**
	 * Whether these numbers are the project's whole usage: read, not cut at the reply cap, and (on
	 * the requester) every record held together.
	 */
	complete: boolean;
	/**
	 * Conversations of the project the host left out because their transcripts are too large or
	 * unreadable. The rest is counted, and the project is named as partial, never quietly short.
	 */
	skippedFiles?: number;
}

/** What a host answers: one result per project, in the order the request named them. */
export interface ProjectTokenUsage {
	projects: ProjectTokenUsageResult[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** A non-empty string no longer than `max`, else undefined. */
function boundedString(value: unknown, max: number): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

/**
 * Whether `key` names something every plain object already has (`__proto__`, `constructor`,
 * `toString`, ...). A host-supplied string that becomes an object key on the requester must not be
 * one: indexing a plain object by it reaches `Object.prototype`, and a write through it pollutes
 * every object in the process.
 */
export function isPrototypeKey(key: string): boolean {
	return key in Object.prototype || key === 'prototype';
}

/** A {@link boundedString} that is safe as an object key, else undefined. */
function keyString(value: unknown, max: number): string | undefined {
	const text = boundedString(value, max);
	return text !== undefined && !isPrototypeKey(text) ? text : undefined;
}

/** A finite number in `[0, max]`, else undefined. */
function boundedNumber(value: unknown, max: number): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
		? value
		: undefined;
}

const COVERAGES = new Set<TokenCoverage>(['full', 'partial', 'unsupported']);
const ORIGINS = new Set(['user', 'auto', 'relay']);
const COMPLETENESS = new Set(['complete', 'partial', 'unknown']);
const SOURCES = new Set(['gateway', 'provider-billing', 'runtime-stream', 'none']);
const STATUSES = new Set<ProjectTokenUsageStatus>(['read', 'failed', 'unsupported']);

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** `projects` without repeats, in first-seen order. */
export function uniqueProjects(
	projects: readonly ProjectTokenUsageProject[]
): ProjectTokenUsageProject[] {
	const seen = new Set<string>();
	const unique: ProjectTokenUsageProject[] = [];
	for (const project of projects) {
		const key = `${project.provider}\u0000${project.projectPath}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push({ provider: project.provider, projectPath: project.projectPath });
	}
	return unique;
}

/** `projects` without repeats, in requests a host accepts whole. */
export function chunkProjects(
	projects: readonly ProjectTokenUsageProject[]
): ProjectTokenUsageProject[][] {
	const unique = uniqueProjects(projects);
	const chunks: ProjectTokenUsageProject[][] = [];
	for (let i = 0; i < unique.length; i += MAX_PROJECT_TOKEN_USAGE_PROJECTS) {
		chunks.push(unique.slice(i, i + MAX_PROJECT_TOKEN_USAGE_PROJECTS));
	}
	return chunks;
}

/** The request message for `projects`. Duplicates are sent once. */
export function projectTokenUsageRequest(projects: readonly ProjectTokenUsageProject[]): {
	type: typeof PROJECT_TOKEN_USAGE_MESSAGE;
	projects: ProjectTokenUsageProject[];
} {
	return { type: PROJECT_TOKEN_USAGE_MESSAGE, projects: uniqueProjects(projects) };
}

/**
 * The projects a request names, as a host reads them, in order: each needs a provider id and a
 * path. Undefined for a request the host must refuse (none named, one malformed, or more than a
 * host reads at once), so a host never answers a different list than the one asked.
 */
export function parseProjectTokenUsageRequest(
	message: Json
): ProjectTokenUsageProject[] | undefined {
	if (!Array.isArray(message.projects) || message.projects.length === 0) return undefined;
	if (message.projects.length > MAX_PROJECT_TOKEN_USAGE_PROJECTS) return undefined;
	const projects: ProjectTokenUsageProject[] = [];
	for (const raw of message.projects) {
		if (!isObject(raw)) return undefined;
		// The host looks storages and coverage up by provider, so it too must be a safe key.
		const provider = keyString(raw.provider, MAX_PROVIDER_LENGTH);
		const projectPath = keyString(raw.projectPath, MAX_PATH_LENGTH);
		if (!provider || !projectPath) return undefined;
		projects.push({ provider, projectPath });
	}
	return projects;
}

// ---------------------------------------------------------------------------
// Reply (host side)
// ---------------------------------------------------------------------------

/** A cost as the wire carries it: the status and its amount, nothing else. */
function costToWire(cost: UsageCost): Json {
	const wire: Json = { status: cost.status };
	if ('costUsd' in cost && cost.costUsd !== undefined) wire.costUsd = cost.costUsd;
	if ('costUsdTicks' in cost && cost.costUsdTicks !== undefined)
		wire.costUsdTicks = cost.costUsdTicks;
	if (cost.status === 'estimated') {
		wire.model = cost.model;
		wire.pricingRevision = cost.pricingRevision;
		wire.completeness = cost.completeness;
	}
	return wire;
}

/** One model bucket as the wire carries it. */
function modelToWire(model: ModelTokenUsage): Json {
	return {
		model: model.model,
		...(model.rawModel !== undefined ? { rawModel: model.rawModel } : {}),
		...(model.accounting
			? {
					lifetime: {
						completeness: model.accounting.completeness,
						cost: costToWire(model.accounting.cost),
					},
				}
			: {}),
		inputTokens: model.inputTokens,
		outputTokens: model.outputTokens,
		cacheReadTokens: model.cacheReadTokens,
		cacheCreationTokens: model.cacheCreationTokens,
		costUsd: model.costUsd,
		costEstimated: model.costEstimated,
	};
}

/**
 * The model buckets of one conversation, at most `MAX_MODELS_PER_SESSION`: past that the rest are
 * summed into one unnamed bucket, so the session's numbers stay whole.
 */
function modelsToWire(byModel: readonly ModelTokenUsage[]): Json[] {
	if (byModel.length <= MAX_MODELS_PER_SESSION) return byModel.map(modelToWire);
	const kept = byModel.slice(0, MAX_MODELS_PER_SESSION - 1).map(modelToWire);
	const rest = byModel.slice(MAX_MODELS_PER_SESSION - 1);
	// Buckets that all carry native cost evidence keep it, merged, so the requester counts their
	// cost the way this machine does; legacy buckets fold their numbers only, as before.
	const evidence = rest.every((m) => m.accounting)
		? rest
				.map((m) => m.accounting!)
				.reduce((merged, next) => ({
					completeness: merged.completeness === next.completeness ? next.completeness : 'partial',
					cost: mergeUsageCost(merged.cost, next.cost),
				}))
		: undefined;
	kept.push(
		modelToWire({
			model: '',
			...(evidence ? { accounting: evidence } : {}),
			inputTokens: rest.reduce((sum, m) => sum + m.inputTokens, 0),
			outputTokens: rest.reduce((sum, m) => sum + m.outputTokens, 0),
			cacheReadTokens: rest.reduce((sum, m) => sum + m.cacheReadTokens, 0),
			cacheCreationTokens: rest.reduce((sum, m) => sum + m.cacheCreationTokens, 0),
			costUsd: rest.reduce((sum, m) => sum + m.costUsd, 0),
			costEstimated: rest.some((m) => m.costEstimated),
		})
	);
	return kept;
}

/**
 * One conversation as the wire carries it. A session with native lifetime accounting carries its
 * completeness and cost (`lifetime`), so the requester counts its lifetime totals the way this
 * machine does, not the sum of its model detail. Per-call speed buckets stay on the host.
 */
function breakdownToWire(breakdown: SessionTokenBreakdown, accountLabel: string): Json {
	return {
		sessionId: breakdown.sessionId,
		agentType: breakdown.agentType,
		projectPath: breakdown.projectPath,
		accountKey: accountLabel,
		timestampMs: breakdown.timestampMs,
		...(breakdown.origin ? { origin: breakdown.origin } : {}),
		...(breakdown.accounting
			? {
					lifetime: {
						source: breakdown.accounting.source,
						completeness: breakdown.accounting.completeness,
						cost: costToWire(breakdown.accounting.cost),
					},
				}
			: {}),
		byModel: modelsToWire(breakdown.byModel),
		inputTokens: breakdown.inputTokens,
		outputTokens: breakdown.outputTokens,
		cacheReadTokens: breakdown.cacheReadTokens,
		cacheCreationTokens: breakdown.cacheCreationTokens,
		costUsd: breakdown.costUsd,
		costEstimated: breakdown.costEstimated,
		coverage: breakdown.coverage,
	};
}

/** The last part of a path, on either separator. */
function lastSegment(value: string): string {
	const trimmed = value.replace(/[\\/]+$/, '');
	return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
}

/**
 * What the wire calls each account of `usage`. An account key is the host's absolute config-dir
 * path, which must not leave the host: the wire carries the dir's own name instead (`.claude-work`),
 * which is what the account is called on the host's own dashboard. Two accounts whose dirs share a
 * name get `-2`, `-3` in the order of their full paths, so they stay apart. The default account
 * keeps its key.
 */
export function wireAccountLabels(usage: ProjectTokenUsage): Map<string, string> {
	const keys = new Set<string>();
	for (const project of usage.projects) {
		for (const breakdown of project.breakdowns) keys.add(breakdown.accountKey);
	}
	const labels = new Map<string, string>();
	const taken = new Set<string>([DEFAULT_ACCOUNT_KEY]);
	labels.set(DEFAULT_ACCOUNT_KEY, DEFAULT_ACCOUNT_KEY);
	for (const key of [...keys].sort()) {
		if (key === DEFAULT_ACCOUNT_KEY) continue;
		const segment = lastSegment(key);
		const base = segment && !isPrototypeKey(segment) ? segment : 'account';
		let label = base;
		for (let n = 2; taken.has(label); n++) label = `${base}-${n}`;
		taken.add(label);
		labels.set(key, label);
	}
	return labels;
}

/**
 * The reply frame a host sends for `usage`. Past the reply cap the remaining conversations are
 * left out and their project says so (`truncated`), so the requester never reads it as whole.
 * Accounts go by their {@link wireAccountLabels}, never by a path of the host.
 */
export function projectTokenUsageReplyFrame(usage: ProjectTokenUsage): Json {
	const labels = wireAccountLabels(usage);
	let room = MAX_PROJECT_TOKEN_USAGE_BREAKDOWNS;
	return {
		type: PROJECT_TOKEN_USAGE_REPLY,
		success: true,
		projects: usage.projects.map((project) => {
			const kept = project.breakdowns.slice(0, Math.max(0, room));
			room -= kept.length;
			return {
				status: project.status,
				breakdowns: kept.map((breakdown) =>
					breakdownToWire(breakdown, labels.get(breakdown.accountKey) ?? DEFAULT_ACCOUNT_KEY)
				),
				...(kept.length < project.breakdowns.length || !project.complete
					? { truncated: true }
					: {}),
				...(project.skippedFiles && project.skippedFiles > 0
					? { skipped: project.skippedFiles }
					: {}),
			};
		}),
	};
}

/** The reply frame a host sends when it could not read the usage at all. */
export function projectTokenUsageFailureFrame(error: string): Json {
	return { type: PROJECT_TOKEN_USAGE_REPLY, success: false, error };
}

// ---------------------------------------------------------------------------
// Reply (requester side)
// ---------------------------------------------------------------------------

/** A cost from the wire, or undefined when it does not hold together. */
function parseCost(raw: unknown): UsageCost | undefined {
	if (!isObject(raw)) return undefined;
	const costUsd = boundedNumber(raw.costUsd, MAX_COST_USD);
	// The ticks are what the dashboard sums when present, so they are capped like the amount.
	const ticks =
		typeof raw.costUsdTicks === 'string' &&
		TICKS_PATTERN.test(raw.costUsdTicks) &&
		BigInt(raw.costUsdTicks) <= MAX_COST_TICKS
			? raw.costUsdTicks
			: undefined;
	if (raw.costUsd !== undefined && costUsd === undefined) return undefined;
	if (raw.costUsdTicks !== undefined && ticks === undefined) return undefined;
	switch (raw.status) {
		case 'unknown':
			return { status: 'unknown' };
		case 'exact':
			if (ticks !== undefined) return { status: 'exact', costUsdTicks: ticks, costUsd };
			if (costUsd !== undefined) return { status: 'exact', costUsd };
			return undefined;
		case 'partial':
			return {
				status: 'partial',
				...(costUsd !== undefined ? { costUsd } : {}),
				...(ticks !== undefined ? { costUsdTicks: ticks } : {}),
			};
		case 'estimated': {
			const model =
				typeof raw.model === 'string' &&
				raw.model.length <= MAX_MODEL_LENGTH &&
				!isPrototypeKey(raw.model);
			const revision = boundedString(raw.pricingRevision, MAX_LABEL_LENGTH);
			const completeness =
				typeof raw.completeness === 'string' && COMPLETENESS.has(raw.completeness)
					? (raw.completeness as 'complete' | 'partial' | 'unknown')
					: undefined;
			if (costUsd === undefined || !model || !revision || !completeness) return undefined;
			return {
				status: 'estimated',
				costUsd,
				model: raw.model as string,
				pricingRevision: revision,
				completeness,
			};
		}
		default:
			return undefined;
	}
}

/** `lifetime` from the wire as completeness and cost, or undefined when it does not hold together. */
function parseLifetime(
	raw: unknown
):
	| { completeness: 'complete' | 'partial' | 'unknown'; cost: UsageCost; source?: string }
	| undefined {
	if (!isObject(raw)) return undefined;
	const completeness =
		typeof raw.completeness === 'string' && COMPLETENESS.has(raw.completeness)
			? (raw.completeness as 'complete' | 'partial' | 'unknown')
			: undefined;
	const cost = parseCost(raw.cost);
	if (!completeness || !cost) return undefined;
	const source = typeof raw.source === 'string' && SOURCES.has(raw.source) ? raw.source : undefined;
	return { completeness, cost, ...(source ? { source } : {}) };
}

/** One model bucket from the wire, or undefined when it does not hold together. */
function parseModel(raw: unknown): ModelTokenUsage | undefined {
	if (!isObject(raw)) return undefined;
	const model =
		typeof raw.model === 'string' &&
		raw.model.length <= MAX_MODEL_LENGTH &&
		!isPrototypeKey(raw.model)
			? raw.model
			: undefined;
	const rawModel =
		typeof raw.rawModel === 'string' &&
		raw.rawModel.length <= MAX_MODEL_LENGTH &&
		!isPrototypeKey(raw.rawModel)
			? raw.rawModel
			: undefined;
	// A rawModel that is present but unusable spoils the record, rather than quietly regrouping it.
	if (raw.rawModel !== undefined && rawModel === undefined) return undefined;
	const inputTokens = boundedNumber(raw.inputTokens, MAX_TOKENS);
	const outputTokens = boundedNumber(raw.outputTokens, MAX_TOKENS);
	const cacheReadTokens = boundedNumber(raw.cacheReadTokens, MAX_TOKENS);
	const cacheCreationTokens = boundedNumber(raw.cacheCreationTokens, MAX_TOKENS);
	const costUsd = boundedNumber(raw.costUsd, MAX_COST_USD);
	const lifetime = raw.lifetime === undefined ? null : parseLifetime(raw.lifetime);
	if (
		model === undefined ||
		inputTokens === undefined ||
		outputTokens === undefined ||
		cacheReadTokens === undefined ||
		cacheCreationTokens === undefined ||
		costUsd === undefined ||
		lifetime === undefined
	) {
		return undefined;
	}
	return {
		model,
		...(rawModel !== undefined ? { rawModel } : {}),
		...(lifetime
			? { accounting: { model, completeness: lifetime.completeness, cost: lifetime.cost } }
			: {}),
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheCreationTokens,
		costUsd,
		costEstimated: raw.costEstimated === true,
	};
}

/**
 * One conversation from the wire for `asked` (the project the request named), or undefined when it
 * does not hold together. A host answers every conversation under the folder asked with that
 * folder's path, so any other path is a record that does not belong to the request.
 */
function parseBreakdown(
	raw: unknown,
	asked: ProjectTokenUsageProject
): SessionTokenBreakdown | undefined {
	const provider = asked.provider;
	if (!isObject(raw)) return undefined;
	// Each of these becomes an object or map key on the requester (series, groups, the dedupe key).
	const sessionId = keyString(raw.sessionId, MAX_ID_LENGTH);
	const projectPath = keyString(raw.projectPath, MAX_PATH_LENGTH);
	const accountKey = keyString(raw.accountKey, MAX_PATH_LENGTH);
	const timestampMs = boundedNumber(raw.timestampMs, MAX_TIMESTAMP_MS);
	const inputTokens = boundedNumber(raw.inputTokens, MAX_TOKENS);
	const outputTokens = boundedNumber(raw.outputTokens, MAX_TOKENS);
	const cacheReadTokens = boundedNumber(raw.cacheReadTokens, MAX_TOKENS);
	const cacheCreationTokens = boundedNumber(raw.cacheCreationTokens, MAX_TOKENS);
	const costUsd = boundedNumber(raw.costUsd, MAX_COST_USD);
	const lifetime = raw.lifetime === undefined ? null : parseLifetime(raw.lifetime);
	if (
		!sessionId ||
		raw.agentType !== provider ||
		projectPath !== asked.projectPath ||
		!accountKey ||
		timestampMs === undefined ||
		inputTokens === undefined ||
		outputTokens === undefined ||
		cacheReadTokens === undefined ||
		cacheCreationTokens === undefined ||
		costUsd === undefined ||
		lifetime === undefined ||
		!Array.isArray(raw.byModel) ||
		raw.byModel.length > MAX_MODELS_PER_SESSION
	) {
		return undefined;
	}
	const byModel: ModelTokenUsage[] = [];
	for (const entry of raw.byModel) {
		const model = parseModel(entry);
		if (!model) return undefined;
		byModel.push(model);
	}
	const coverage =
		typeof raw.coverage === 'string' && COVERAGES.has(raw.coverage as TokenCoverage)
			? (raw.coverage as TokenCoverage)
			: 'unsupported';
	const origin =
		typeof raw.origin === 'string' && ORIGINS.has(raw.origin)
			? (raw.origin as SessionTokenBreakdown['origin'])
			: undefined;
	// Lifetime totals are authoritative over the model detail, as on the host: the aggregate counts
	// a session with accounting by its own totals. The rebuilt record holds only what was checked.
	const accounting: UsageAccounting | undefined = lifetime
		? {
				source: (lifetime.source ?? 'none') as UsageAccounting['source'],
				scope: 'native-session',
				reporting: 'snapshot',
				cacheReadCounting: 'beside-input',
				cacheCreationCounting: 'beside-input',
				completeness: lifetime.completeness,
				cost: lifetime.cost,
				// Unknown here: the host's totals already hold whatever children it counted.
				childInclusion: 'unknown',
				childCompleteness: 'unknown',
			}
		: undefined;
	return {
		sessionId,
		agentType: provider,
		projectPath,
		accountKey,
		timestampMs: Math.floor(timestampMs),
		...(origin ? { origin } : {}),
		byModel,
		...(accounting ? { accounting } : {}),
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheCreationTokens,
		costUsd,
		costEstimated: raw.costEstimated === true,
		coverage,
	};
}

/**
 * A host's reply, read as untrusted input against `asked` (the projects the request named, in
 * order). Undefined when the reply is not a success or does not answer exactly the projects asked:
 * the caller then leaves all of them "not counted". A record that does not hold together is dropped
 * and makes its project incomplete.
 */
export function parseProjectTokenUsageReply(
	reply: unknown,
	asked: readonly ProjectTokenUsageProject[]
): ProjectTokenUsage | undefined {
	if (!isObject(reply) || reply.success !== true || !Array.isArray(reply.projects)) {
		return undefined;
	}
	if (reply.projects.length !== asked.length) return undefined;
	const projects: ProjectTokenUsageResult[] = [];
	let room = MAX_PROJECT_TOKEN_USAGE_BREAKDOWNS;
	for (let i = 0; i < asked.length; i++) {
		const raw = reply.projects[i];
		if (!isObject(raw) || !Array.isArray(raw.breakdowns)) return undefined;
		const status =
			typeof raw.status === 'string' && STATUSES.has(raw.status as ProjectTokenUsageStatus)
				? (raw.status as ProjectTokenUsageStatus)
				: 'failed';
		// `truncated` is absent or a boolean; anything else cannot say the project is whole.
		let complete = status === 'read' && (raw.truncated === undefined || raw.truncated === false);
		// A count that does not hold together cannot say how short the total is: not complete.
		const skipped = raw.skipped === undefined ? 0 : boundedNumber(raw.skipped, MAX_SKIPPED_FILES);
		if (skipped === undefined || !Number.isInteger(skipped)) complete = false;
		const breakdowns: SessionTokenBreakdown[] = [];
		for (const entry of raw.breakdowns) {
			if (room <= 0) {
				complete = false;
				break;
			}
			// Every entry spends the budget, kept or not: parse work stays bounded by the cap.
			room--;
			const breakdown = parseBreakdown(entry, asked[i]);
			if (breakdown) breakdowns.push(breakdown);
			else complete = false;
		}
		const skippedFiles = skipped !== undefined && Number.isInteger(skipped) ? skipped : 0;
		projects.push({ status, breakdowns, complete, ...(skippedFiles > 0 ? { skippedFiles } : {}) });
	}
	return { projects };
}
