/**
 * Per-conversation token breakdowns for a set of projects, read from each provider's own session
 * storage on THIS machine.
 *
 * The one implementation behind every token total: the desktop's own Usage Dashboard (the
 * token-usage accessor), the desktop answering a Federation peer's `get_project_token_usage`, and a
 * headless `maestro-cli host` answering the same message. So an agent's conversations add up to the
 * same numbers whichever machine counts them.
 *
 * It imports neither the stats database nor the storage registry: the caller hands in the
 * storages and the account dirs, so a plain-Node host (no SQLite, no Electron) can load it. Each
 * storage streams its transcripts and serves unchanged ones from its own fingerprint cache; the
 * optional `cache` adds the dashboard's per-session breakdown cache on top.
 */

import type { AgentSessionInfo, AgentSessionStorage } from '../../agents/session-storage';
import {
	DEFAULT_ACCOUNT_KEY,
	type ModelTokenUsage,
	type SessionTokenBreakdown,
	type TokenCoverage,
} from '../../../shared/tokenUsage';
import { canonicalJson } from '../../../shared/canonicalJson';
import { usageCostUsd } from '../../../shared/maestro-lib/streaming/usage-totals';
import type {
	ProjectTokenUsage,
	ProjectTokenUsageProject,
	ProjectTokenUsageResult,
	ProjectTokenUsageStatus,
} from '../../../shared/projectTokenUsage';
import { sessionFingerprint, tokenCacheKey, type TokenUsageCache } from './token-usage-cache';

/**
 * Per-agent base coverage, matching the Cue accessor's classification so both
 * dashboards label partial data identically. Agents absent here are reported as
 * `unsupported`.
 */
export const COVERAGE_BY_AGENT: Record<string, TokenCoverage> = {
	'claude-code': 'full',
	opencode: 'full',
	kilo: 'full', // Fork of OpenCode: same storage schema, same token fields
	'factory-droid': 'full',
	grok: 'full',
	codex: 'partial',
	'copilot-cli': 'partial',
	// No cost and no model id on disk: tokens only.
	antigravity: 'partial',
};

/** Sum a per-model split into the four token totals. */
function sumModels(byModel: ModelTokenUsage[]): {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	costUsd: number;
	costEstimated: boolean;
} {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheCreationTokens = 0;
	let costUsd = 0;
	let costEstimated = false;
	for (const m of byModel) {
		inputTokens += m.inputTokens;
		outputTokens += m.outputTokens;
		cacheReadTokens += m.cacheReadTokens;
		cacheCreationTokens += m.cacheCreationTokens;
		costUsd += m.costUsd;
		if (m.costEstimated) costEstimated = true;
	}
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheCreationTokens,
		costUsd,
		costEstimated,
	};
}

/**
 * Agents whose transcripts count cached input tokens INSIDE `inputTokens`
 * (`cacheReadTokens` is a subset of it, not an addition). Their input is
 * reduced to the fresh part so every provider's token fields add up the same
 * way: `input + output + cacheRead + cacheCreation` counts each token once.
 */
const CACHE_READ_INSIDE_INPUT = new Set(['codex']);

/**
 * Rewrite one model bucket so its input is fresh tokens only. The cost was
 * computed from the provider's own counts (with subset-aware pricing) before
 * this point, so it is carried over untouched.
 */
function withFreshInput(m: ModelTokenUsage): ModelTokenUsage {
	return { ...m, inputTokens: Math.max(0, m.inputTokens - m.cacheReadTokens) };
}

/**
 * Turn one `AgentSessionInfo` into a {@link SessionTokenBreakdown}. When the
 * native accounting exists, lifetime totals remain authoritative even when model
 * detail is partial. Legacy providers retain their existing model projections.
 */
export function toBreakdown(
	agentType: string,
	info: AgentSessionInfo,
	accountKey: string = DEFAULT_ACCOUNT_KEY
): SessionTokenBreakdown {
	const coverage: TokenCoverage =
		agentType === 'grok' &&
		(info.accounting?.completeness !== 'complete' || info.accounting.cost.status !== 'exact')
			? 'partial'
			: (COVERAGE_BY_AGENT[agentType] ?? 'unsupported');
	const timestampMs = Date.parse(info.modifiedAt || info.timestamp) || 0;

	let byModel: ModelTokenUsage[];
	if (info.accounting?.models?.length) {
		byModel = info.accounting.models.map((detail) => ({
			model: detail.model,
			rawModel: detail.model,
			accounting: structuredClone(detail),
			inputTokens: detail.inputTokens ?? 0,
			outputTokens: detail.outputTokens ?? 0,
			cacheReadTokens: detail.cacheReadInputTokens ?? 0,
			cacheCreationTokens: detail.cacheCreationInputTokens ?? 0,
			costUsd: usageCostUsd(detail.cost) ?? 0,
			costEstimated: detail.cost.status === 'estimated',
		}));
	} else if (info.accounting) {
		// No model attribution: retain the lifetime amount in an unknown bucket.
		byModel = [
			{
				model: '',
				inputTokens: info.inputTokens,
				outputTokens: info.outputTokens,
				cacheReadTokens: info.cacheReadTokens,
				cacheCreationTokens: info.cacheCreationTokens,
				costUsd: usageCostUsd(info.accounting.cost) ?? 0,
				costEstimated: info.accounting.cost.status === 'estimated',
				accounting: {
					completeness: info.accounting.completeness,
					cost: structuredClone(info.accounting.cost),
				},
			},
		];
	} else if (info.byModel && info.byModel.length > 0) {
		byModel = info.byModel;
	} else if (
		info.inputTokens ||
		info.outputTokens ||
		info.cacheReadTokens ||
		info.cacheCreationTokens
	) {
		// No model split available: one bucket, cost from the session's own figure
		// when the agent reports it, else rate-table estimated at aggregate time.
		const hasReportedCost = typeof info.costUsd === 'number';
		byModel = [
			{
				model: '',
				inputTokens: info.inputTokens,
				outputTokens: info.outputTokens,
				cacheReadTokens: info.cacheReadTokens,
				cacheCreationTokens: info.cacheCreationTokens,
				costUsd: hasReportedCost ? (info.costUsd as number) : 0,
				costEstimated: !hasReportedCost,
			},
		];
	} else {
		byModel = [];
	}

	if (CACHE_READ_INSIDE_INPUT.has(agentType)) {
		byModel = byModel.map(withFreshInput);
	}

	const totals = info.accounting
		? {
				inputTokens: info.inputTokens,
				outputTokens: info.outputTokens,
				cacheReadTokens: info.cacheReadTokens,
				cacheCreationTokens: info.cacheCreationTokens,
				costUsd: usageCostUsd(info.accounting.cost) ?? 0,
				costEstimated: info.accounting.cost.status === 'estimated',
			}
		: sumModels(byModel);
	return {
		sessionId: info.sessionId,
		agentType,
		projectPath: info.projectPath,
		accountKey,
		timestampMs,
		origin: info.origin,
		byModel,
		...(info.accounting
			? {
					accounting: {
						...structuredClone(info.accounting),
						scopeId:
							info.accounting.scopeId ??
							canonicalJson([agentType, accountKey, info.projectPath, info.sessionId]),
					},
				}
			: {}),
		inputTokens: totals.inputTokens,
		outputTokens: totals.outputTokens,
		cacheReadTokens: totals.cacheReadTokens,
		cacheCreationTokens: totals.cacheCreationTokens,
		costUsd: totals.costUsd,
		costEstimated: totals.costEstimated,
		coverage,
		...(info.speed && info.speed.length > 0 ? { speed: info.speed } : {}),
	};
}

/** What `collectProjectBreakdowns` reads with. */
export interface ProjectBreakdownDeps {
	/** The provider's session storage on this machine, or null when it has none. */
	storageFor(agentType: string): Pick<AgentSessionStorage, 'listSessions'> | null;
	/** Every account dir of the provider on this machine; empty for a single default pass. */
	accountDirsFor(agentType: string): Promise<string[]>;
	/** The per-session breakdown cache, when the caller keeps one. */
	cache?: Pick<TokenUsageCache, 'get' | 'set'>;
	/** A storage failed to list one project; that project is skipped. */
	onError?(error: unknown): void;
}

/**
 * What one pass read: the breakdowns, the cache keys it saw, the providers it cannot read, and the
 * projects a storage failed to list (for one account or more), keyed by {@link projectKey}.
 */
export interface ProjectBreakdowns {
	breakdowns: SessionTokenBreakdown[];
	liveKeys: Set<string>;
	unsupportedProviders: string[];
	failedProjects: Set<string>;
}

/** The key a failed project is recorded under. */
export function projectKey(agentType: string, projectPath: string): string {
	return `${agentType}\u0000${projectPath}`;
}

/**
 * One breakdown per conversation of every project in `byAgent` (provider to working
 * directories), across every account of the provider.
 */
export async function collectProjectBreakdowns(
	byAgent: ReadonlyMap<string, ReadonlySet<string>>,
	deps: ProjectBreakdownDeps
): Promise<ProjectBreakdowns> {
	const breakdowns: SessionTokenBreakdown[] = [];
	const liveKeys = new Set<string>();
	const unsupported = new Set<string>();
	const failedProjects = new Set<string>();

	for (const [agentType, projects] of byAgent) {
		const storage = deps.storageFor(agentType);
		if (!storage) {
			unsupported.add(agentType);
			continue;
		}

		// Users routinely run one provider under several accounts, each a separate
		// config dir with its own transcript tree. Reading only the default root
		// would undercount them, so fan out across every discovered account dir.
		// A provider with no account-selecting env var yields no dirs and gets a
		// single default pass, filed under DEFAULT_ACCOUNT_KEY.
		const accountDirs = await deps.accountDirsFor(agentType);
		const accounts: Array<string | undefined> = accountDirs.length ? accountDirs : [undefined];

		for (const projectPath of projects) {
			for (const accountDir of accounts) {
				const accountKey = accountDir ?? DEFAULT_ACCOUNT_KEY;
				let sessions: AgentSessionInfo[];
				try {
					sessions = await storage.listSessions(projectPath, undefined, accountDir);
				} catch (error) {
					deps.onError?.(error);
					failedProjects.add(projectKey(agentType, projectPath));
					continue;
				}
				for (const info of sessions) {
					// Grok IDs are scoped to account/cwd, and aliased project queries
					// can return the same native directory more than once.
					const key = tokenCacheKey(
						agentType === 'grok'
							? canonicalJson([agentType, accountKey, info.projectPath])
							: `${agentType}@${accountKey}`,
						info.sessionId
					);
					if (agentType === 'grok' && liveKeys.has(key)) continue;
					liveKeys.add(key);
					const fingerprint = sessionFingerprint(info.modifiedAt, info.sizeBytes);
					// A Grok usage.json update need not change the transcript size or
					// summary timestamp. Storage already sampled all native files;
					// never replace that observation with a stale single-file cache.
					let breakdown = agentType === 'grok' ? undefined : deps.cache?.get(key, fingerprint);
					if (!breakdown) {
						breakdown = toBreakdown(agentType, info, accountKey);
						deps.cache?.set(key, fingerprint, breakdown);
					}
					breakdowns.push(breakdown);
				}
			}
		}
	}

	return { breakdowns, liveKeys, unsupportedProviders: [...unsupported].sort(), failedProjects };
}

/**
 * The answer to a peer's `get_project_token_usage`: per project, in the order asked, whether this
 * machine read it and the breakdowns of its conversations. A project a storage could not list (for
 * any account) answers `failed`, so the peer names its agent instead of counting it short. No
 * breakdown cache here: each storage's own fingerprint cache already keeps an unchanged
 * conversation from being parsed twice, and the dashboard's cache prunes to this machine's agents.
 */
export async function projectTokenUsage(
	projects: readonly ProjectTokenUsageProject[],
	deps: Omit<ProjectBreakdownDeps, 'cache'>
): Promise<ProjectTokenUsage> {
	const results: ProjectTokenUsageResult[] = [];
	for (const { provider, projectPath } of projects) {
		const read = await collectProjectBreakdowns(
			new Map([[provider, new Set([projectPath])]]),
			deps
		);
		const status: ProjectTokenUsageStatus = read.unsupportedProviders.includes(provider)
			? 'unsupported'
			: read.failedProjects.size > 0
				? 'failed'
				: 'read';
		results.push({ status, breakdowns: read.breakdowns, complete: status === 'read' });
	}
	return { projects: results };
}
