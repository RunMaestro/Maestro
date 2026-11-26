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

import os from 'os';
import path from 'path';
import type {
	AgentSessionInfo,
	AgentSessionStorage,
	SkippedSessionFile,
} from '../../agents/session-storage';
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
import type { TokenUsageCache } from './token-usage-cache';
import { sessionFingerprint, tokenCacheKey } from './token-usage-keys';

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

/**
 * What a project read lists from: a provider's session storage. A storage that walks every
 * transcript of an account whatever project it is asked about (Codex) also lists several
 * projects from one walk.
 */
export type ProjectSessionStorage = Pick<AgentSessionStorage, 'listSessions'> & {
	listSessionsForProjects?(
		projectPaths: readonly string[],
		accountDir?: string,
		observer?: { onSkippedFile?(projectPath: string, file: SkippedSessionFile): void }
	): Promise<Map<string, AgentSessionInfo[]>>;
};

/** One project's listing for one account: its sessions, and how many transcripts it left out. */
interface ProjectListing {
	sessions: AgentSessionInfo[];
	/** Transcripts the storage did not read (past its size cap): the total is short by these. */
	skipped: number;
}

/**
 * Runs the session listings of a host: a listing asked for again while it is still running joins
 * the first (same provider, account, and projects), and at most `limit` run at once. A long cold
 * parse then costs one parse however many asks arrive during it.
 */
export interface SessionListGate {
	run<T>(key: string, list: () => Promise<T>): Promise<T>;
}

/** How many listings a host runs at once. */
export const SESSION_LIST_CONCURRENCY = 2;

export function createSessionListGate(limit = SESSION_LIST_CONCURRENCY): SessionListGate {
	const inflight = new Map<string, Promise<unknown>>();
	const waiting: Array<() => void> = [];
	let active = 0;

	async function withSlot<T>(list: () => Promise<T>): Promise<T> {
		if (active < limit) active++;
		else await new Promise<void>((resolve) => waiting.push(resolve));
		try {
			return await list();
		} finally {
			// Hand the slot straight to the next waiter, or give it back.
			const next = waiting.shift();
			if (next) next();
			else active--;
		}
	}

	return {
		run<T>(key: string, list: () => Promise<T>): Promise<T> {
			const existing = inflight.get(key);
			if (existing) return existing as Promise<T>;
			const pending = withSlot(list);
			inflight.set(key, pending);
			const clear = (): void => {
				if (inflight.get(key) === pending) inflight.delete(key);
			};
			pending.then(clear, clear);
			return pending;
		},
	};
}

/** A gate that joins nothing and limits nothing. */
const UNGATED: SessionListGate = { run: (_key, list) => list() };

/** What `collectProjectBreakdowns` reads with. */
export interface ProjectBreakdownDeps {
	/** The provider's session storage on this machine, or null when it has none. */
	storageFor(agentType: string): ProjectSessionStorage | null;
	/** Every account dir of the provider on this machine; empty for a single default pass. */
	accountDirsFor(agentType: string): Promise<string[]>;
	/** The per-session breakdown cache, when the caller keeps one. */
	cache?: Pick<TokenUsageCache, 'get' | 'set'>;
	/** Joins and limits the session listings, when the caller keeps one (a host does). */
	gate?: SessionListGate;
	/** A storage failed to list one project; that project is skipped. */
	onError?(error: unknown): void;
}

/**
 * What one pass read: the breakdowns, the cache keys it saw, the providers it cannot read, and the
 * projects a storage failed to list (for one account or more), keyed by {@link projectKey}.
 * `byProject` holds each project's own breakdowns, keyed the same way.
 */
export interface ProjectBreakdowns {
	breakdowns: SessionTokenBreakdown[];
	liveKeys: Set<string>;
	unsupportedProviders: string[];
	failedProjects: Set<string>;
	byProject: Map<string, SessionTokenBreakdown[]>;
	/** Per project, how many transcripts a storage left out (too large or unreadable). */
	skippedProjects: Map<string, number>;
}

/** The key a failed project is recorded under. */
export function projectKey(agentType: string, projectPath: string): string {
	return `${agentType}\u0000${projectPath}`;
}

/**
 * The sessions of every project in `projects` for one account: one walk for a storage that can
 * list several projects at once, else one listing per project. A listing that fails is an Error
 * in place of that project's sessions.
 */
async function listAccountProjects(
	agentType: string,
	storage: ProjectSessionStorage,
	projects: readonly string[],
	accountDir: string | undefined,
	gate: SessionListGate
): Promise<Map<string, ProjectListing | Error>> {
	const account = accountDir ?? '';
	const listed = new Map<string, ProjectListing | Error>();
	const asError = (error: unknown): Error =>
		error instanceof Error ? error : new Error(String(error));
	// The skips are counted inside the gated listing, so an ask that joins it gets them too.
	if (storage.listSessionsForProjects && projects.length > 1) {
		const listMany = storage.listSessionsForProjects.bind(storage);
		try {
			const result = await gate.run(
				canonicalJson(['many', agentType, account, [...projects]]),
				async () => {
					const skipped = new Map<string, number>();
					const byProject = await listMany(projects, accountDir, {
						onSkippedFile: (projectPath) =>
							skipped.set(projectPath, (skipped.get(projectPath) ?? 0) + 1),
					});
					return { byProject, skipped };
				}
			);
			for (const projectPath of projects) {
				listed.set(projectPath, {
					sessions: result.byProject.get(projectPath) ?? [],
					skipped: result.skipped.get(projectPath) ?? 0,
				});
			}
		} catch (error) {
			for (const projectPath of projects) listed.set(projectPath, asError(error));
		}
		return listed;
	}
	for (const projectPath of projects) {
		try {
			listed.set(
				projectPath,
				await gate.run(canonicalJson(['one', agentType, account, projectPath]), async () => {
					let skipped = 0;
					const sessions = await storage.listSessions(projectPath, undefined, accountDir, {
						onSkippedFile: () => {
							skipped++;
						},
					});
					return { sessions, skipped };
				})
			);
		} catch (error) {
			listed.set(projectPath, asError(error));
		}
	}
	return listed;
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
	const byProject = new Map<string, SessionTokenBreakdown[]>();
	const skippedProjects = new Map<string, number>();
	const gate = deps.gate ?? UNGATED;
	// One walk can fail for several projects at once; report it once.
	const reported = new Set<Error>();

	for (const [agentType, projectSet] of byAgent) {
		const storage = deps.storageFor(agentType);
		if (!storage) {
			unsupported.add(agentType);
			continue;
		}
		const projects = [...projectSet];

		// Users routinely run one provider under several accounts, each a separate
		// config dir with its own transcript tree. Reading only the default root
		// would undercount them, so fan out across every discovered account dir.
		// A provider with no account-selecting env var yields no dirs and gets a
		// single default pass, filed under DEFAULT_ACCOUNT_KEY.
		let accountDirs: string[];
		try {
			accountDirs = await deps.accountDirsFor(agentType);
		} catch (error) {
			// Without its accounts this provider cannot be read whole: its projects fail, and the
			// other providers of the request are still read.
			deps.onError?.(error);
			for (const projectPath of projects) {
				failedProjects.add(projectKey(agentType, projectPath));
				byProject.set(projectKey(agentType, projectPath), []);
			}
			continue;
		}
		const accounts: Array<string | undefined> = accountDirs.length ? accountDirs : [undefined];
		// Each account is listed once for all its projects (one walk where the storage can).
		const listings: Array<Map<string, ProjectListing | Error>> = [];
		for (const accountDir of accounts) {
			listings.push(await listAccountProjects(agentType, storage, projects, accountDir, gate));
		}

		for (const projectPath of projects) {
			const own: SessionTokenBreakdown[] = [];
			const ownKeys = new Set<string>();
			byProject.set(projectKey(agentType, projectPath), own);
			accounts.forEach((accountDir, index) => {
				const accountKey = accountDir ?? DEFAULT_ACCOUNT_KEY;
				const listing = listings[index].get(projectPath) ?? { sessions: [], skipped: 0 };
				if (listing instanceof Error) {
					if (!reported.has(listing)) deps.onError?.(listing);
					reported.add(listing);
					failedProjects.add(projectKey(agentType, projectPath));
					return;
				}
				if (listing.skipped > 0) {
					const key = projectKey(agentType, projectPath);
					skippedProjects.set(key, (skippedProjects.get(key) ?? 0) + listing.skipped);
				}
				for (const info of listing.sessions) {
					// Grok IDs are scoped to account/cwd, and aliased project queries
					// can return the same native directory more than once.
					const key = tokenCacheKey(
						agentType === 'grok'
							? canonicalJson([agentType, accountKey, info.projectPath])
							: `${agentType}@${accountKey}`,
						info.sessionId
					);
					if (agentType === 'grok' && ownKeys.has(key)) continue;
					ownKeys.add(key);
					const fingerprint = sessionFingerprint(info.modifiedAt, info.sizeBytes);
					// A Grok usage.json update need not change the transcript size or
					// summary timestamp. Storage already sampled all native files;
					// never replace that observation with a stale single-file cache.
					let breakdown = agentType === 'grok' ? undefined : deps.cache?.get(key, fingerprint);
					if (!breakdown) {
						breakdown = toBreakdown(agentType, info, accountKey);
						deps.cache?.set(key, fingerprint, breakdown);
					}
					own.push(breakdown);
					if (agentType === 'grok' && liveKeys.has(key)) continue;
					liveKeys.add(key);
					breakdowns.push(breakdown);
				}
			});
		}
	}

	return {
		breakdowns,
		liveKeys,
		unsupportedProviders: [...unsupported].sort(),
		failedProjects,
		byProject,
		skippedProjects,
	};
}

/**
 * A folder a peer asked about, as this machine reads it. An SSH agent's working directory can be
 * `~/work/app` (its launch expands `~` on this machine), and the peer cannot know this home, so it
 * is expanded here; matched literally it would find no conversation and read as zero.
 */
function hostPath(projectPath: string, homeDir: string): string {
	if (projectPath === '~') return homeDir;
	if (projectPath.startsWith('~/') || projectPath.startsWith('~\\')) {
		return path.join(homeDir, projectPath.slice(2));
	}
	return projectPath;
}

/**
 * The answer to a peer's `get_project_token_usage`: per project, in the order asked, whether this
 * machine read it and the breakdowns of its conversations. A project a storage could not list (for
 * any account) answers `failed`, so the peer names its agent instead of counting it short. No
 * breakdown cache here: each storage's own fingerprint cache already keeps an unchanged
 * conversation from being parsed twice, and the dashboard's cache prunes to this machine's agents.
 * The whole request is one pass: each provider and account is listed once for all its projects.
 */
export async function projectTokenUsage(
	projects: readonly ProjectTokenUsageProject[],
	deps: Omit<ProjectBreakdownDeps, 'cache'> & {
		/** This machine's home, for a folder asked as `~/...`. Defaults to `os.homedir()`. */
		homeDir?: string;
	}
): Promise<ProjectTokenUsage> {
	const homeDir = deps.homeDir ?? os.homedir();
	const byAgent = new Map<string, Set<string>>();
	for (const { provider, projectPath } of projects) {
		const set = byAgent.get(provider) ?? new Set<string>();
		set.add(hostPath(projectPath, homeDir));
		byAgent.set(provider, set);
	}
	const read = await collectProjectBreakdowns(byAgent, deps);
	const results: ProjectTokenUsageResult[] = projects.map(({ provider, projectPath }) => {
		const key = projectKey(provider, hostPath(projectPath, homeDir));
		const status: ProjectTokenUsageStatus = read.unsupportedProviders.includes(provider)
			? 'unsupported'
			: read.failedProjects.has(key)
				? 'failed'
				: 'read';
		// A storage may match conversations in folders under the one asked (Codex
		// matches by prefix, so a request for `/` would list every rollout with its
		// own working directory). Each answers as the folder asked: the peer learns
		// only the numbers of what is under it, never a path it did not name.
		const breakdowns = (read.byProject.get(key) ?? []).map((breakdown) =>
			breakdown.projectPath === projectPath ? breakdown : { ...breakdown, projectPath }
		);
		const skippedFiles = read.skippedProjects.get(key) ?? 0;
		return {
			status,
			breakdowns,
			complete: status === 'read',
			...(skippedFiles > 0 ? { skippedFiles } : {}),
		};
	});
	return { projects: results };
}
