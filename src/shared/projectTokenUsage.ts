/**
 * The host op behind the Usage Dashboard's token totals for agents whose conversations are on
 * another computer: "the token usage of these projects' conversations, computed where the
 * transcripts are".
 *
 * A requester (the desktop, for its SSH and hosted agents) sends `get_project_token_usage` with the
 * provider and the host-side working directory of each agent. The host reads its own transcripts
 * with the same session storages its own dashboard reads (`collectProjectBreakdowns()` in
 * `src/main/stats/token-usage/project-breakdowns.ts`) and answers one numeric breakdown per
 * conversation. No transcript text crosses the wire: only ids, a model name, and numbers.
 *
 * Both host kinds answer it: the desktop (`WebSocketMessageHandler`) and a headless
 * `maestro-cli host` (`src/cli/services/host-token-usage.ts`). A host that does not know the
 * message answers `unsupported`, and the requester leaves that agent "not counted".
 *
 * Every number from another machine is untrusted input: `parseProjectTokenUsageReply()` reads it
 * field by field, keeps only finite, non-negative, bounded values, and drops a record that does
 * not hold together. Pure: no I/O, no Electron.
 */

import type { ModelTokenUsage, SessionTokenBreakdown, TokenCoverage } from './tokenUsage';

/** The request message type. */
export const PROJECT_TOKEN_USAGE_MESSAGE = 'get_project_token_usage';
/** The reply message type. */
export const PROJECT_TOKEN_USAGE_REPLY = 'project_token_usage_result';

/** The most projects one request may name. */
export const MAX_PROJECT_TOKEN_USAGE_PROJECTS = 64;
/** The most conversations one reply may carry. Past this the rest are dropped, not trusted. */
export const MAX_PROJECT_TOKEN_USAGE_BREAKDOWNS = 50_000;
/** The most model buckets one conversation may carry. */
const MAX_MODELS_PER_SESSION = 64;
/** A token count past this is not a real conversation. */
const MAX_TOKENS = 1e13;
/** A cost past this (USD) is not a real conversation. */
const MAX_COST_USD = 1e7;
/** The largest timestamp a Date can hold. */
const MAX_TIMESTAMP_MS = 8.64e15;
const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_MODEL_LENGTH = 256;
const MAX_PROVIDER_LENGTH = 64;

/** One project a requester asks about: which provider, and its working directory on the host. */
export interface ProjectTokenUsageProject {
	provider: string;
	projectPath: string;
}

/** What a host answers: one breakdown per conversation, and the providers it cannot read. */
export interface ProjectTokenUsage {
	breakdowns: SessionTokenBreakdown[];
	/** Providers asked about that this host has no transcript reader for. */
	unsupportedProviders: string[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** A non-empty string no longer than `max`, else undefined. */
function boundedString(value: unknown, max: number): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

/** A finite number in `[0, max]`, else undefined. */
function boundedNumber(value: unknown, max: number): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
		? value
		: undefined;
}

const COVERAGES = new Set<TokenCoverage>(['full', 'partial', 'unsupported']);
const ORIGINS = new Set(['user', 'auto', 'relay']);

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** The request message for `projects`. Duplicates are sent once. */
export function projectTokenUsageRequest(projects: readonly ProjectTokenUsageProject[]): {
	type: typeof PROJECT_TOKEN_USAGE_MESSAGE;
	projects: ProjectTokenUsageProject[];
} {
	return { type: PROJECT_TOKEN_USAGE_MESSAGE, projects: uniqueProjects(projects) };
}

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

/**
 * The projects a request names, as a host reads them: each needs a provider id and a path, the
 * list is deduplicated and capped. A request that names none is refused by the caller.
 */
export function parseProjectTokenUsageRequest(message: Json): ProjectTokenUsageProject[] {
	if (!Array.isArray(message.projects)) return [];
	const projects: ProjectTokenUsageProject[] = [];
	for (const raw of message.projects) {
		if (!isObject(raw)) continue;
		const provider = boundedString(raw.provider, MAX_PROVIDER_LENGTH);
		const projectPath = boundedString(raw.projectPath, MAX_PATH_LENGTH);
		if (!provider || !projectPath) continue;
		projects.push({ provider, projectPath });
	}
	return uniqueProjects(projects).slice(0, MAX_PROJECT_TOKEN_USAGE_PROJECTS);
}

// ---------------------------------------------------------------------------
// Reply
// ---------------------------------------------------------------------------

/** One model bucket as the wire carries it: names and numbers, no canonical accounting. */
function modelToWire(model: ModelTokenUsage): Json {
	return {
		model: model.model,
		...(model.rawModel !== undefined ? { rawModel: model.rawModel } : {}),
		inputTokens: model.inputTokens,
		outputTokens: model.outputTokens,
		cacheReadTokens: model.cacheReadTokens,
		cacheCreationTokens: model.cacheCreationTokens,
		costUsd: model.costUsd,
		costEstimated: model.costEstimated,
	};
}

/**
 * One conversation as the wire carries it. The provider's canonical accounting and the per-call
 * speed buckets stay on the host: the totals and the per-model split are what the dashboard's
 * token totals add up, and they are all a requester can check.
 */
function breakdownToWire(breakdown: SessionTokenBreakdown): Json {
	return {
		sessionId: breakdown.sessionId,
		agentType: breakdown.agentType,
		projectPath: breakdown.projectPath,
		accountKey: breakdown.accountKey,
		timestampMs: breakdown.timestampMs,
		...(breakdown.origin ? { origin: breakdown.origin } : {}),
		byModel: breakdown.byModel.slice(0, MAX_MODELS_PER_SESSION).map(modelToWire),
		inputTokens: breakdown.inputTokens,
		outputTokens: breakdown.outputTokens,
		cacheReadTokens: breakdown.cacheReadTokens,
		cacheCreationTokens: breakdown.cacheCreationTokens,
		costUsd: breakdown.costUsd,
		costEstimated: breakdown.costEstimated,
		coverage: breakdown.coverage,
	};
}

/** The reply frame a host sends for `usage`. */
export function projectTokenUsageReplyFrame(usage: ProjectTokenUsage): Json {
	return {
		type: PROJECT_TOKEN_USAGE_REPLY,
		success: true,
		breakdowns: usage.breakdowns.slice(0, MAX_PROJECT_TOKEN_USAGE_BREAKDOWNS).map(breakdownToWire),
		unsupportedProviders: [...usage.unsupportedProviders],
	};
}

/** The reply frame a host sends when it could not read the usage. */
export function projectTokenUsageFailureFrame(error: string): Json {
	return { type: PROJECT_TOKEN_USAGE_REPLY, success: false, error };
}

/** One model bucket from the wire, or undefined when it does not hold together. */
function parseModel(raw: unknown): ModelTokenUsage | undefined {
	if (!isObject(raw)) return undefined;
	const model =
		typeof raw.model === 'string' && raw.model.length <= MAX_MODEL_LENGTH ? raw.model : '';
	const rawModel =
		typeof raw.rawModel === 'string' && raw.rawModel.length <= MAX_MODEL_LENGTH
			? raw.rawModel
			: undefined;
	const inputTokens = boundedNumber(raw.inputTokens, MAX_TOKENS);
	const outputTokens = boundedNumber(raw.outputTokens, MAX_TOKENS);
	const cacheReadTokens = boundedNumber(raw.cacheReadTokens, MAX_TOKENS);
	const cacheCreationTokens = boundedNumber(raw.cacheCreationTokens, MAX_TOKENS);
	const costUsd = boundedNumber(raw.costUsd, MAX_COST_USD);
	if (
		inputTokens === undefined ||
		outputTokens === undefined ||
		cacheReadTokens === undefined ||
		cacheCreationTokens === undefined ||
		costUsd === undefined
	) {
		return undefined;
	}
	return {
		model,
		...(rawModel !== undefined ? { rawModel } : {}),
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheCreationTokens,
		costUsd,
		costEstimated: raw.costEstimated === true,
	};
}

/**
 * One conversation from the wire, or undefined when it does not hold together. `providers` are the
 * ones the request asked about: a record for any other provider is not an answer to this request.
 */
function parseBreakdown(
	raw: unknown,
	providers: ReadonlySet<string>
): SessionTokenBreakdown | undefined {
	if (!isObject(raw)) return undefined;
	const sessionId = boundedString(raw.sessionId, MAX_ID_LENGTH);
	const agentType = boundedString(raw.agentType, MAX_PROVIDER_LENGTH);
	const projectPath = boundedString(raw.projectPath, MAX_PATH_LENGTH);
	const accountKey = boundedString(raw.accountKey, MAX_PATH_LENGTH);
	const timestampMs = boundedNumber(raw.timestampMs, MAX_TIMESTAMP_MS);
	const inputTokens = boundedNumber(raw.inputTokens, MAX_TOKENS);
	const outputTokens = boundedNumber(raw.outputTokens, MAX_TOKENS);
	const cacheReadTokens = boundedNumber(raw.cacheReadTokens, MAX_TOKENS);
	const cacheCreationTokens = boundedNumber(raw.cacheCreationTokens, MAX_TOKENS);
	const costUsd = boundedNumber(raw.costUsd, MAX_COST_USD);
	if (
		!sessionId ||
		!agentType ||
		!providers.has(agentType) ||
		!projectPath ||
		!accountKey ||
		timestampMs === undefined ||
		inputTokens === undefined ||
		outputTokens === undefined ||
		cacheReadTokens === undefined ||
		cacheCreationTokens === undefined ||
		costUsd === undefined ||
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
	return {
		sessionId,
		agentType,
		projectPath,
		accountKey,
		timestampMs: Math.floor(timestampMs),
		...(origin ? { origin } : {}),
		byModel,
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
 * A host's reply, read as untrusted input. `asked` is what the request named: only those providers
 * are accepted. Records that do not hold together are dropped one by one; a reply that is not a
 * success yields undefined, which the caller treats as "not counted".
 */
export function parseProjectTokenUsageReply(
	reply: unknown,
	asked: readonly ProjectTokenUsageProject[]
): ProjectTokenUsage | undefined {
	if (!isObject(reply) || reply.success !== true || !Array.isArray(reply.breakdowns)) {
		return undefined;
	}
	const providers = new Set(asked.map((project) => project.provider));
	const breakdowns: SessionTokenBreakdown[] = [];
	for (const raw of reply.breakdowns.slice(0, MAX_PROJECT_TOKEN_USAGE_BREAKDOWNS)) {
		const breakdown = parseBreakdown(raw, providers);
		if (breakdown) breakdowns.push(breakdown);
	}
	const unsupportedProviders = Array.isArray(reply.unsupportedProviders)
		? reply.unsupportedProviders.filter(
				(provider): provider is string => typeof provider === 'string' && providers.has(provider)
			)
		: [];
	return { breakdowns, unsupportedProviders: [...new Set(unsupportedProviders)] };
}
