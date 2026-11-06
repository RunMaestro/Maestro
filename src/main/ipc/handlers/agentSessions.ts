/**
 * Agent Sessions IPC Handlers
 *
 * This module provides generic IPC handlers for agent session management
 * that work with any agent supporting the AgentSessionStorage interface.
 *
 * This is the preferred API for new code. The window.maestro.claude.* API
 * remains for backwards compatibility but logs deprecation warnings.
 *
 * Usage:
 * - window.maestro.agentSessions.list(agentId, projectPath)
 * - window.maestro.agentSessions.read(agentId, projectPath, sessionId)
 * - window.maestro.agentSessions.search(agentId, projectPath, query, mode)
 * - window.maestro.agentSessions.getGlobalStats() - aggregates from all providers
 */

import { ipcMain, BrowserWindow } from 'electron';
import Store from 'electron-store';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { logger } from '../../utils/logger';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import { createSafeSend } from '../../utils/safe-send';
import { getSessionStorage, hasSessionStorage, getAllSessionStorages } from '../../agents';
import {
	getLiveSessions,
	getSshRemoteById,
	getProductionDataPath,
	getSettingsStore,
	getAgentConfigsStore,
} from '../../stores';
import { isInitialized } from '../../stores/instances';
import type { AgentSessionOriginsData, ClaudeSessionOriginsData } from '../../stores/types';
import { setClaudeSessionOrigin } from '../../storage/claude-session-origins';
import { normalizeMessagePins } from '../../../shared/messagePins';
import { sessionOriginStoreFor } from '../../../shared/sessionOriginStore';
import { calculateModelCost } from '../../utils/pricing';
import {
	loadGlobalStatsCache,
	saveGlobalStatsCache,
	GlobalStatsCache,
	CachedSessionStats,
	GLOBAL_STATS_CACHE_VERSION,
	accumulateUpgradeBaseline,
	finishDerivationUpgrade,
	isDerivationStale,
	type DerivationUpgrade,
	qualifiedGlobalStatsSessionKey,
	summarizeCachedSessionCost,
	mergeStatsCostCoverage,
	type CachedSessionIdentity,
} from '../../utils/statsCache';
import { createCacheCheckpointer } from '../../utils/cache-checkpointer';
import { runTranscriptParse } from '../../transcript-parse/transcript-parse-pool';
import { withStatsIndexing } from '../../stats/stats-indexing';
import { usageCostUsd } from '../../../shared/maestro-lib/streaming/usage-totals';
import type {
	AgentSessionInfo,
	PaginatedSessionsResult,
	SessionMessagesResult,
	SessionSearchResult,
	SessionSearchMode,
	SessionListOptions,
	SessionReadOptions,
} from '../../agents';
import type {
	GlobalAgentStats,
	ProviderStats,
	SshRemoteConfig,
	AgentSshRemoteConfig,
} from '../../../shared/types';
import { captureException } from '../../utils/sentry';
import { isExpectedSessionReadError } from '../../utils/session-read-errors';
import {
	snapshotStarredTranscript,
	releaseTranscriptMirror,
	releaseSnoozedTranscriptMirror,
	restoreStarredTranscript,
	listMirroredStarredSessions,
	type MirrorRetainReason,
} from '../../storage/starred-transcript-mirror';
import { getHistoryManager } from '../../history-manager';
import {
	mapWithConcurrency,
	LOCAL_SESSION_READ_CONCURRENCY,
	LOCAL_SESSION_PARSE_CONCURRENCY,
} from '../../utils/concurrency';
import { resolveAgentAccountDir, getProviderAccountDirs } from '../../agents/provider-account-dirs';
import { resolveSshLaunchTarget } from '../../utils/ssh-remote-resolver';
import { nativeAccountRef } from '../../../shared/agentAccountDir';
import { canonicalJson } from '../../../shared/canonicalJson';
import { grokInstallationId } from '../../../shared/maestro-lib/grok/host-seams';
import type { NativeSessionBinding } from '../../../shared/maestro-lib/agents/providerSwap';
import { resolveAgentEnvironment } from '../../../shared/agentEnvironment';

// Re-export for backwards compatibility
export type { GlobalAgentStats, ProviderStats };

const LOG_CONTEXT = '[AgentSessions]';

/**
 * Re-exported so existing importers keep resolving from here. The definition
 * moved to `src/main/utils/session-read-errors.ts` because the sibling read
 * sites that hit the same boundary (`storage/claude-session-storage.ts`,
 * `ipc/handlers/claude.ts`) can't import from this module without a cycle.
 */
export { isExpectedSessionReadError };

/** Generic agent session origins data (one definition, in the stores module). */
export type { AgentSessionOriginsData } from '../../stores/types';

/**
 * Dependencies required for agent sessions handlers
 */
export interface AgentSessionsHandlerDependencies {
	getMainWindow: () => BrowserWindow | null;
	agentSessionOriginsStore?: Store<AgentSessionOriginsData>;
	/**
	 * The legacy Claude origins store. Claude Code and Codex keep their origin
	 * records there (see `sessionOriginStoreFor`), so a write for those
	 * providers has to land in it rather than in the generic store.
	 */
	claudeSessionOriginsStore?: Store<ClaudeSessionOriginsData>;
}

/** Resolve the selected owner before any native read or transcript restoration. */
function resolveHistoryScope(
	agentId: string,
	sshRemoteId?: string,
	ownerAgentId?: string,
	configDir?: string
): {
	sshConfig?: SshRemoteConfig;
	configDir?: string;
	ownerProjectPath?: string;
	remoteAccountEnv?: Record<string, string>;
	selectionKey: string;
} {
	for (const [name, value] of [
		['ownerAgentId', ownerAgentId],
		['sshRemoteId', sshRemoteId],
	] as const) {
		if (
			value !== undefined &&
			(typeof value !== 'string' || !value.trim() || value.includes('\0'))
		) {
			throw new Error(`Invalid history ${name}.`);
		}
	}
	if (configDir !== undefined && (typeof configDir !== 'string' || configDir.includes('\0'))) {
		throw new Error('Invalid history account directory.');
	}

	let sessionSshConfig: AgentSshRemoteConfig | undefined =
		sshRemoteId === undefined ? undefined : { enabled: true, remoteId: sshRemoteId };
	let owner;
	if (ownerAgentId !== undefined) {
		owner = getLiveSessions().find((session) => session.id === ownerAgentId);
		if (!owner || owner.toolType !== agentId) {
			throw new Error(
				'History owner is unavailable or uses a different provider. Refresh the agent selection.'
			);
		}
		if (configDir !== undefined) {
			throw new Error('An owned history read cannot override its account directory.');
		}
		// Prefer the current configured target; retain legacy observed SSH routing
		// only when no configuration exists. Never expand its home on this host.
		sessionSshConfig =
			owner.sessionSshRemoteConfig ??
			(owner.sshRemoteId ? { enabled: true, remoteId: owner.sshRemoteId } : undefined);
		if (
			sessionSshConfig !== undefined &&
			(typeof sessionSshConfig !== 'object' ||
				sessionSshConfig === null ||
				Array.isArray(sessionSshConfig) ||
				typeof sessionSshConfig.enabled !== 'boolean')
		) {
			throw new Error('History owner has invalid SSH configuration.');
		}
		const ownerRemoteId = sessionSshConfig?.enabled ? sessionSshConfig.remoteId : undefined;
		if (sshRemoteId !== undefined && sshRemoteId !== ownerRemoteId) {
			throw new Error('History SSH target does not match its owner. Refresh the agent selection.');
		}
	}
	const target = resolveSshLaunchTarget(
		{
			getSshRemotes: () => {
				const id = sessionSshConfig?.remoteId;
				const remote = typeof id === 'string' && id.trim() ? getSshRemoteById(id) : undefined;
				return remote ? [remote] : [];
			},
		},
		sessionSshConfig
	);
	if (target.kind === 'unresolved') {
		throw new Error(
			`History SSH target unavailable (${target.reason}). Select an enabled SSH remote.`
		);
	}
	if (owner) {
		configDir = resolveAgentAccountDir(owner.id, {
			sessions: [{ ...owner, sessionSshRemoteConfig: sessionSshConfig }],
		});
		// Grok's remote default remains undefined (the adapter uses ~/.grok).
		// A missing local account resolution must never revive the host default.
		if (agentId === 'grok' && target.kind === 'local' && configDir === undefined) {
			throw new Error('History owner account could not be resolved.');
		}
	}
	const sshConfig = target.kind === 'remote' ? structuredClone(target.remote) : undefined;
	const ownerProjectPath = owner
		? sshConfig
			? owner.remoteCwd || sessionSshConfig?.workingDirOverride || owner.projectRoot
			: owner.projectRoot
		: undefined;
	// Capture only account-affecting remote launch configuration, without ever
	// reading the desktop's process.env or expanding a remote home locally.
	const remoteAccountEnv =
		agentId === 'grok' && sshConfig && owner
			? Object.fromEntries(
					resolveAgentEnvironment({
						global: {
							...sshConfig.remoteEnv,
							...(isInitialized() ? getSettingsStore().get('shellEnvVars', {}) : {}),
						},
						agent: isInitialized()
							? getAgentConfigsStore().get('configs', {}).grok?.customEnvVars
							: undefined,
						session: owner.customEnvVars,
					})
						.filter(({ key }) => key === 'HOME' || key === 'GROK_HOME')
						.map(({ key, value }) => [key, value])
				)
			: undefined;
	return {
		sshConfig,
		configDir,
		ownerProjectPath,
		remoteAccountEnv,
		// Capture values, not references to mutable store objects. This fence is
		// private to this read; it may contain env values and must never be logged.
		selectionKey: canonicalJson({
			owner: owner && {
				id: owner.id,
				provider: owner.toolType,
				cwd: owner.cwd,
				projectRoot: owner.projectRoot,
				remoteCwd: owner.remoteCwd,
				ssh: sessionSshConfig,
				customPath: owner.customPath,
				customArgs: owner.customArgs,
				customEnvVars: owner.customEnvVars,
			},
			sshConfig,
			configDir,
			remoteAccountEnv,
		}),
	};
}

/** Capture a read's physical scope. This is not yet a native-source receipt:
 * the adapter must confirm which transcript it actually opened, then we recheck.
 * SSH needs an observed endpoint identity; a config is not one, and no host here
 * attests a remote installation, so a remote read stays unbound (unavailable).
 */
async function observeGrokHistoryScope(
	scope: ReturnType<typeof resolveHistoryScope>,
	projectPath: string,
	sessionId: string
): Promise<{
	binding: NativeSessionBinding;
	configDir?: string;
	unavailableReason?: string;
}> {
	if (scope.sshConfig) {
		const unavailable = (reason: string) => ({
			binding: { version: 1, state: 'unknown', reason: 'unobserved' } as const,
			unavailableReason: reason,
		});
		// The selected-account resolver does not fold every launch env layer into
		// its default, so never attest an ambiguous default/tilde root.
		if (
			(scope.configDir === undefined && scope.remoteAccountEnv?.GROK_HOME !== undefined) ||
			((scope.configDir === undefined || scope.configDir.startsWith('~')) &&
				scope.remoteAccountEnv?.HOME !== undefined)
		) {
			return unavailable('history-remote-account-environment-unresolved');
		}
		// An SSH alias/hostname or this desktop's identity cannot stand in for
		// the remote endpoint's own installation identity.
		return unavailable('history-remote-endpoint-unqualified');
	}
	if (
		!scope.configDir ||
		!scope.ownerProjectPath ||
		![projectPath, scope.ownerProjectPath, scope.configDir].every(
			(value) => typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value)
		)
	) {
		throw new Error('History requires an absolute owner project and selected account.');
	}
	try {
		const [cwd, ownerCwd, configDir] = await Promise.all([
			fs.realpath(projectPath),
			fs.realpath(scope.ownerProjectPath),
			fs.realpath(scope.configDir),
		]);
		if (cwd !== ownerCwd) throw new Error('History project does not match its owner.');
		return {
			configDir,
			binding: {
				version: 1,
				state: 'bound',
				provider: 'grok',
				nativeSessionId: sessionId,
				accountRef: nativeAccountRef('grok', configDir),
				cwd,
				host: {
					kind: 'local',
					identity: grokInstallationId({
						hostname: os.hostname(),
						productionDataDir: getProductionDataPath(),
					}),
				},
			},
		};
	} catch (error) {
		if (!isExpectedSessionReadError(error)) throw error;
		return { binding: { version: 1, state: 'unknown', reason: 'unobserved' } };
	}
}

/**
 * Helper function to create consistent handler options
 */
function handlerOpts(operation: string) {
	return { context: LOG_CONTEXT, operation, logSuccess: false };
}

/**
 * File info for incremental scanning
 */
interface SessionFileInfo {
	filePath: string;
	sessionKey: string;
	mtimeMs: number;
	sizeBytes: number;
}

/**
 * Claude fields a derivation upgrade rescales on archived sessions, whose
 * transcripts are gone and cannot be re-parsed.
 */
const GLOBAL_STATS_UPGRADE_FIELDS = [
	'inputTokens',
	'outputTokens',
	'cacheReadTokens',
	'cacheCreationTokens',
	'costUsd',
	'messages',
] as const;

/**
 * Read a directory's entry names, or nothing when it is missing or not a
 * directory (readdir on a file throws ENOTDIR, which replaces a separate stat).
 */
async function readdirOrEmpty(dir: string): Promise<string[]> {
	try {
		return await fs.readdir(dir);
	} catch {
		return [];
	}
}

/**
 * Stat every candidate transcript in parallel, bounded, and keep the non-empty
 * ones. Discovery stats every transcript on disk before the first number can
 * reach the renderer; one at a time that was ~3.8s for 30k Claude sessions,
 * bounded-parallel it is ~0.5s.
 */
async function statSessionFiles(
	candidates: Array<{ filePath: string; sessionKey: string }>
): Promise<SessionFileInfo[]> {
	const stats = await mapWithConcurrency(candidates, LOCAL_SESSION_READ_CONCURRENCY, async (c) => {
		try {
			const fileStat = await fs.stat(c.filePath);
			// Skip 0-byte sessions (created but abandoned before any content was written)
			if (fileStat.size === 0) return null;
			return { ...c, mtimeMs: fileStat.mtimeMs, sizeBytes: fileStat.size };
		} catch {
			// Skip files we can't stat
			return null;
		}
	});
	return stats.filter((f): f is SessionFileInfo => f !== null);
}

/**
 * Discover Claude Code session files from ~/.claude/projects/
 * Returns list of files with their mtime for cache comparison
 */
async function discoverClaudeSessionFiles(): Promise<SessionFileInfo[]> {
	const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
	const projectDirs = await readdirOrEmpty(claudeProjectsDir);

	const listings = await mapWithConcurrency(
		projectDirs,
		LOCAL_SESSION_READ_CONCURRENCY,
		async (projectDir) => {
			const projectPath = path.join(claudeProjectsDir, projectDir);
			return (await readdirOrEmpty(projectPath))
				.filter((f) => f.endsWith('.jsonl'))
				.map((filename) => ({
					filePath: path.join(projectPath, filename),
					sessionKey: `${projectDir}/${filename.replace('.jsonl', '')}`,
				}));
		}
	);

	return statSessionFiles(listings.flat());
}

/**
 * Discover Codex session files from ~/.codex/sessions/YYYY/MM/DD/
 * Returns list of files with their mtime for cache comparison
 */
async function discoverCodexSessionFiles(): Promise<SessionFileInfo[]> {
	const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');

	// Walk down to the day directories. The year and month levels are small, so
	// only the day listings and the per-file stats are worth running in parallel.
	const dayDirs: Array<{ dir: string; prefix: string }> = [];
	for (const year of await readdirOrEmpty(codexSessionsDir)) {
		if (!/^\d{4}$/.test(year)) continue;
		const yearDir = path.join(codexSessionsDir, year);
		for (const month of await readdirOrEmpty(yearDir)) {
			if (!/^\d{2}$/.test(month)) continue;
			const monthDir = path.join(yearDir, month);
			for (const day of await readdirOrEmpty(monthDir)) {
				if (!/^\d{2}$/.test(day)) continue;
				dayDirs.push({ dir: path.join(monthDir, day), prefix: `${year}/${month}/${day}` });
			}
		}
	}

	const listings = await mapWithConcurrency(
		dayDirs,
		LOCAL_SESSION_READ_CONCURRENCY,
		async ({ dir, prefix }) =>
			(await readdirOrEmpty(dir))
				.filter((f) => f.endsWith('.jsonl'))
				.map((file) => ({
					filePath: path.join(dir, file),
					sessionKey: `${prefix}/${file.replace('.jsonl', '')}`,
				}))
	);

	return statSessionFiles(listings.flat());
}

/** One native Grok session directory, fingerprinted without opening any file. */
interface GrokSessionDirInfo {
	/** Account dir handed to the registered storage reader. */
	accountDir: string;
	/** Raw cwd folder name, and the cwd the storage decodes it to. */
	cwd: string;
	key: string;
	identity: CachedSessionIdentity;
	/** Newest mtime of the files the storage reads: summary, transcript, usage ledger. */
	mtimeMs: number;
}

/** Files of a Grok session directory whose change invalidates its cached stats. */
const GROK_SESSION_STAT_FILES = ['chat_history.jsonl', 'usage.json', 'summary.json'] as const;

/**
 * Discover local Grok session directories in every account pool
 * (`getProviderAccountDirs`, already deduped by the real sessions directory).
 * The account scope is that real directory, so the same pool keeps the same
 * keys whichever alias selected it, and two pools never share a key. Only
 * stats are taken here; contents are read by the registered storage.
 */
async function discoverGrokSessionDirs(): Promise<GrokSessionDirInfo[]> {
	const accountDirs = await getProviderAccountDirs('grok');
	const candidates: Array<Omit<GrokSessionDirInfo, 'mtimeMs'> & { dir: string }> = [];
	for (const accountDir of accountDirs) {
		const sessionsDir = path.join(accountDir, 'sessions');
		const accountScope = await fs.realpath(sessionsDir).catch(() => path.resolve(sessionsDir));
		const folders = await readdirOrEmpty(sessionsDir);
		const listings = await mapWithConcurrency(
			folders,
			LOCAL_SESSION_READ_CONCURRENCY,
			async (folder) => {
				let cwd: string;
				try {
					cwd = decodeURIComponent(folder);
				} catch {
					return [];
				}
				const folderDir = path.join(sessionsDir, folder);
				return (await readdirOrEmpty(folderDir)).map((nativeSessionId) => {
					const identity = { accountScope, projectPath: cwd, nativeSessionId };
					return {
						accountDir,
						cwd,
						identity,
						key: qualifiedGlobalStatsSessionKey(identity),
						dir: path.join(folderDir, nativeSessionId),
					};
				});
			}
		);
		candidates.push(...listings.flat());
	}
	const stats = await mapWithConcurrency(
		candidates,
		LOCAL_SESSION_READ_CONCURRENCY,
		async ({ dir, ...candidate }) => {
			let mtimeMs = -1;
			for (const name of GROK_SESSION_STAT_FILES) {
				try {
					const fileStat = await fs.stat(path.join(dir, name));
					if (name === 'chat_history.jsonl' && fileStat.size === 0) return null;
					mtimeMs = Math.max(mtimeMs, fileStat.mtimeMs);
				} catch {
					// No transcript: not a session the storage lists. Others are optional.
					if (name === 'chat_history.jsonl') return null;
				}
			}
			return { ...candidate, mtimeMs };
		}
	);
	return stats.filter((info): info is GrokSessionDirInfo => info !== null);
}

/**
 * Project one session from the registered Grok storage into the global cache
 * entry. Tokens and cost are the storage's own reading of `usage.json` (no
 * second parser, no pricing): the stored `cost` governs and an absent ledger
 * stays unknown, never free.
 */
function grokCachedSessionStats(
	session: AgentSessionInfo,
	info: GrokSessionDirInfo
): CachedSessionStats {
	const cost = session.accounting?.cost ?? { status: 'unknown' as const };
	const costUsd = usageCostUsd(cost);
	return {
		messages: session.messageCount,
		inputTokens: session.inputTokens,
		outputTokens: session.outputTokens,
		cacheReadTokens: session.cacheReadTokens,
		cacheCreationTokens: session.cacheCreationTokens,
		cachedInputTokens: 0,
		sizeBytes: session.sizeBytes,
		cost,
		...(costUsd !== undefined ? { costUsd } : {}),
		usageSource: session.accounting?.source ?? 'none',
		...(session.accounting?.completeness
			? { usageCompleteness: session.accounting.completeness }
			: {}),
		identity: info.identity,
		fileMtimeMs: info.mtimeMs,
		archived: false,
	};
}

/** The native parent a Grok fork or subagent session names in its summary, if any. */
function grokParentSessionId(session: AgentSessionInfo): string | undefined {
	const parent = session.nativeMetadata?.summary?.parent_session_id;
	return typeof parent === 'string' && parent.length > 0 && parent !== session.sessionId
		? parent
		: undefined;
}

/**
 * A fork copies its parent's ledger and a parent folds its finished children
 * into its own, so a session whose parent is counted in the same pool would
 * attribute that usage twice. It keeps its session and messages but none of the
 * shared tokens or amount, and its cost reads partial: the total stays a floor
 * (its own post-fork delta is not separable), never an overcount.
 */
function withoutParentAttributedUsage(stats: CachedSessionStats): CachedSessionStats {
	const { costUsd: _costUsd, ...rest } = stats;
	return {
		...rest,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		cost: { status: 'partial', reason: 'usage attributed to its native parent session' },
	};
}

/**
 * Calculate aggregated stats from cached sessions for a provider
 */
function aggregateProviderStats(
	sessions: Record<string, CachedSessionStats>,
	hasCostData: boolean
): {
	sessions: number;
	messages: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	cachedInputTokens: number;
	sizeBytes: number;
	costUsd: number;
	hasCostData: boolean;
} {
	let totalMessages = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCacheReadTokens = 0;
	let totalCacheCreationTokens = 0;
	let totalCachedInputTokens = 0;
	let totalSizeBytes = 0;
	let totalCostUsd = 0;

	for (const stats of Object.values(sessions)) {
		totalMessages += stats.messages;
		totalInputTokens += stats.inputTokens;
		totalOutputTokens += stats.outputTokens;
		totalCacheReadTokens += stats.cacheReadTokens;
		totalCacheCreationTokens += stats.cacheCreationTokens;
		totalCachedInputTokens += stats.cachedInputTokens;
		totalSizeBytes += stats.sizeBytes;
		// An entry carrying its own `cost` is never priced from its tokens; its
		// amount is summarized by `summarizeCachedSessionCost`. Otherwise prefer
		// the per-model cost stored at parse time, then flat-rate pricing for
		// cache entries written before per-model cost was tracked.
		if (stats.cost) continue;
		totalCostUsd +=
			stats.costUsd ??
			calculateModelCost({
				inputTokens: stats.inputTokens,
				outputTokens: stats.outputTokens,
				cacheReadTokens: stats.cacheReadTokens,
				cacheCreationTokens: stats.cacheCreationTokens,
			});
	}

	const costUsd = hasCostData ? totalCostUsd : 0;

	return {
		sessions: Object.keys(sessions).length,
		messages: totalMessages,
		inputTokens: totalInputTokens,
		outputTokens: totalOutputTokens,
		cacheReadTokens: totalCacheReadTokens,
		cacheCreationTokens: totalCacheCreationTokens,
		cachedInputTokens: totalCachedInputTokens,
		sizeBytes: totalSizeBytes,
		costUsd,
		hasCostData,
	};
}

/**
 * Register all agent sessions IPC handlers.
 */
export function registerAgentSessionsHandlers(deps?: AgentSessionsHandlerDependencies): void {
	const getMainWindow = deps?.getMainWindow;
	const safeSend = createSafeSend(getMainWindow ?? (() => null));

	// ============ List Sessions ============

	ipcMain.handle(
		'agentSessions:list',
		withIpcErrorLogging(
			handlerOpts('list'),
			async (
				agentId: string,
				projectPath: string,
				sshRemoteId?: string,
				ownerAgentId?: string
			): Promise<AgentSessionInfo[]> => {
				const storage = getSessionStorage(agentId);
				if (!storage) {
					logger.warn(`No session storage available for agent: ${agentId}`, LOG_CONTEXT);
					return [];
				}

				const { sshConfig, configDir } = resolveHistoryScope(agentId, sshRemoteId, ownerAgentId);
				const sessions = await storage.listSessions(
					projectPath,
					sshConfig,
					...(ownerAgentId === undefined ? [] : [configDir])
				);
				logger.info(
					`Listed ${sessions.length} sessions for agent ${agentId} at ${projectPath}${sshRemoteId ? ' (remote via SSH)' : ''}`,
					LOG_CONTEXT
				);
				return sessions;
			}
		)
	);

	// ============ List Sessions Paginated ============

	ipcMain.handle(
		'agentSessions:listPaginated',
		withIpcErrorLogging(
			handlerOpts('listPaginated'),
			async (
				agentId: string,
				projectPath: string,
				options?: { cursor?: string; limit?: number; ownerAgentId?: string },
				sshRemoteId?: string
			): Promise<PaginatedSessionsResult> => {
				const storage = getSessionStorage(agentId);
				if (!storage) {
					logger.warn(`No session storage available for agent: ${agentId}`, LOG_CONTEXT);
					return { sessions: [], hasMore: false, totalCount: 0, nextCursor: null };
				}

				const { sshConfig, configDir } = resolveHistoryScope(
					agentId,
					sshRemoteId,
					options?.ownerAgentId
				);

				// List the pool of the account this agent actually runs under: its
				// provider only resumes sessions from that config dir.
				const listOptions: SessionListOptions = {
					cursor: options?.cursor,
					limit: options?.limit,
					configDir,
				};
				const result = await storage.listSessionsPaginated(projectPath, listOptions, sshConfig);
				logger.info(
					`Listed paginated sessions for agent ${agentId}: ${result.sessions.length} of ${result.totalCount}${sshRemoteId ? ' (remote via SSH)' : ''}`,
					LOG_CONTEXT
				);
				return result;
			}
		)
	);

	// ============ Read Session Messages ============

	ipcMain.handle(
		'agentSessions:read',
		withIpcErrorLogging(
			handlerOpts('read'),
			async (
				agentId: string,
				projectPath: string,
				sessionId: string,
				options?: SessionReadOptions & { ownerAgentId?: string },
				sshRemoteId?: string
			): Promise<SessionMessagesResult> => {
				const retained = options?.nativeSessionBinding;
				if (
					retained !== undefined &&
					(retained?.version !== 1 ||
						retained.state !== 'bound' ||
						retained.provider !== agentId ||
						retained.nativeSessionId !== sessionId ||
						!options?.ownerAgentId ||
						agentId !== 'grok')
				) {
					throw new Error('History ownership is unknown, mismatched or unsupported.');
				}
				const retainedKey = retained === undefined ? undefined : canonicalJson(retained);
				const storage = getSessionStorage(agentId);
				if (!storage) {
					logger.warn(`No session storage available for agent: ${agentId}`, LOG_CONTEXT);
					return { messages: [], total: 0, hasMore: false };
				}

				const scope = resolveHistoryScope(
					agentId,
					sshRemoteId,
					options?.ownerAgentId,
					options?.configDir
				);
				const { sshConfig } = scope;
				let configDir = scope.configDir;
				let readProjectPath = projectPath;
				let observed: Awaited<ReturnType<typeof observeGrokHistoryScope>> | undefined;
				const assertCurrentSelection = () => {
					if (
						resolveHistoryScope(agentId, sshRemoteId, options?.ownerAgentId, options?.configDir)
							.selectionKey !== scope.selectionKey
					) {
						throw new Error(
							'History owner settings changed during the read. Refresh the selection.'
						);
					}
				};
				if (agentId === 'grok' && options?.ownerAgentId !== undefined) {
					observed = await observeGrokHistoryScope(scope, projectPath, sessionId);
					assertCurrentSelection();
					if (observed.binding.state !== 'bound') {
						return {
							messages: [],
							total: 0,
							hasMore: false,
							nativeSessionBinding: observed.binding,
							source: {
								provider: 'grok',
								status: 'unavailable',
								reason: observed.unavailableReason ?? 'history-scope-unobserved',
							},
						};
					}
					if (retainedKey !== undefined && retainedKey !== canonicalJson(observed.binding)) {
						throw new Error('History ownership does not match the selected account, host or cwd.');
					}
					configDir = observed.configDir;
					readProjectPath = observed.binding.cwd;
				}

				// Rehydrate an aged-out starred session: on the initial load of a LOCAL
				// session, if the provider transcript is gone but we hold a mirror, copy
				// it back to the provider's path so the read below (and a later native
				// --resume) finds it. No-op/cheap when the provider file still exists.
				// Mirrors have no account/host identity and cannot restore Grok's
				// multi-file native state. Scoped reads must never rewrite another pool.
				if (
					agentId !== 'grok' &&
					!sshConfig &&
					options?.ownerAgentId === undefined &&
					configDir === undefined &&
					!options?.offset
				) {
					await restoreStarredTranscript({ agentId, projectPath, sessionId });
				}

				const result = await storage.readSessionMessages(
					readProjectPath,
					sessionId,
					options?.ownerAgentId === undefined
						? // Forward only the read window and the validated account selection;
							// a renderer never supplies native ingestion options of its own.
							options && {
								offset: options.offset,
								limit: options.limit,
								includeNativeRecords: options.includeNativeRecords,
								configDir: options.configDir,
							}
						: {
								offset: options.offset,
								limit: options.limit,
								includeNativeRecords: options.includeNativeRecords,
								configDir,
								...(observed ? { nativeSessionBinding: structuredClone(observed.binding) } : {}),
							},
					sshConfig
				);
				if (observed) {
					assertCurrentSelection();
					const rechecked = await observeGrokHistoryScope(scope, projectPath, sessionId);
					assertCurrentSelection();
					if (canonicalJson(rechecked) !== canonicalJson(observed)) {
						throw new Error('History account, host or cwd changed during the read.');
					}
					if (result.nativeSessionBinding?.state === 'bound') {
						if (canonicalJson(result.nativeSessionBinding) !== canonicalJson(observed.binding)) {
							throw new Error('The native transcript does not match the observed history scope.');
						}
					} else {
						// A requested scope is not evidence of the source the adapter read.
						return {
							...result,
							nativeSessionBinding: { version: 1, state: 'unknown', reason: 'unobserved' },
						};
					}
				}
				logger.info(
					`Read ${result.messages.length} messages for session ${sessionId} (agent: ${agentId})${sshRemoteId ? ' (remote via SSH)' : ''}`,
					LOG_CONTEXT
				);
				return agentId === 'grok'
					? {
							...result,
							nativeSessionBinding: observed?.binding ?? {
								version: 1,
								state: 'unknown',
								reason: 'legacy',
							},
						}
					: result;
			}
		)
	);

	// ============ Search Sessions ============

	ipcMain.handle(
		'agentSessions:search',
		withIpcErrorLogging(
			handlerOpts('search'),
			async (
				agentId: string,
				projectPath: string,
				query: string,
				searchMode: SessionSearchMode,
				sshRemoteId?: string,
				ownerAgentId?: string
			): Promise<SessionSearchResult[]> => {
				const storage = getSessionStorage(agentId);
				if (!storage) {
					logger.warn(`No session storage available for agent: ${agentId}`, LOG_CONTEXT);
					return [];
				}

				const { sshConfig, configDir } = resolveHistoryScope(agentId, sshRemoteId, ownerAgentId);
				const results = await storage.searchSessions(
					projectPath,
					query,
					searchMode,
					sshConfig,
					...(ownerAgentId === undefined ? [] : [configDir])
				);
				logger.info(
					`Found ${results.length} matching sessions for query "${query}" (agent: ${agentId})${sshRemoteId ? ' (remote via SSH)' : ''}`,
					LOG_CONTEXT
				);
				return results;
			}
		)
	);

	// ============ Get Session Path ============

	ipcMain.handle(
		'agentSessions:getPath',
		withIpcErrorLogging(
			handlerOpts('getPath'),
			async (
				agentId: string,
				projectPath: string,
				sessionId: string,
				sshRemoteId?: string,
				ownerAgentId?: string
			): Promise<string | null> => {
				const storage = getSessionStorage(agentId);
				if (!storage) {
					logger.warn(`No session storage available for agent: ${agentId}`, LOG_CONTEXT);
					return null;
				}

				const { sshConfig, configDir } = resolveHistoryScope(agentId, sshRemoteId, ownerAgentId);
				return sshRemoteId === undefined && ownerAgentId === undefined
					? storage.getSessionPath(projectPath, sessionId)
					: storage.getSessionPath(projectPath, sessionId, sshConfig, configDir);
			}
		)
	);

	// ============ Delete Message Pair ============

	ipcMain.handle(
		'agentSessions:deleteMessagePair',
		withIpcErrorLogging(
			handlerOpts('deleteMessagePair'),
			async (
				agentId: string,
				projectPath: string,
				sessionId: string,
				userMessageUuid: string,
				fallbackContent?: string
			): Promise<{ success: boolean; error?: string; linesRemoved?: number }> => {
				if (agentId === 'grok') {
					// This legacy mutation request has no account/host ownership or
					// native generation receipt. Never infer either from a native ID,
					// cwd or fallback text, or substitute a partial JSONL rewrite.
					return {
						success: false,
						error:
							'Grok history deletion and editing are not supported in Maestro: this request has no account/host ownership, and native mutations have no verified transport. History is unchanged.',
					};
				}
				const storage = getSessionStorage(agentId);
				if (!storage) {
					logger.warn(`No session storage available for agent: ${agentId}`, LOG_CONTEXT);
					return { success: false, error: `No session storage available for agent: ${agentId}` };
				}

				return storage.deleteMessagePair(projectPath, sessionId, userMessageUuid, fallbackContent);
			}
		)
	);

	// ============ Check Storage Availability ============

	ipcMain.handle(
		'agentSessions:hasStorage',
		withIpcErrorLogging(handlerOpts('hasStorage'), async (agentId: string): Promise<boolean> => {
			return hasSessionStorage(agentId);
		})
	);

	// ============ Get Available Storages ============

	ipcMain.handle(
		'agentSessions:getAvailableStorages',
		withIpcErrorLogging(handlerOpts('getAvailableStorages'), async (): Promise<string[]> => {
			const storages = getAllSessionStorages();
			return storages.map((s) => s.agentId);
		})
	);

	// ============ Get All Named Sessions ============

	ipcMain.handle(
		'agentSessions:getAllNamedSessions',
		withIpcErrorLogging(
			handlerOpts('getAllNamedSessions'),
			async (): Promise<
				Array<{
					agentId: string;
					agentSessionId: string;
					projectPath: string;
					sessionName: string;
					starred?: boolean;
					lastActivityAt?: number;
				}>
			> => {
				// Aggregate named sessions from all providers that support it
				const allNamedSessions: Array<{
					agentId: string;
					agentSessionId: string;
					projectPath: string;
					sessionName: string;
					starred?: boolean;
					lastActivityAt?: number;
				}> = [];

				const storages = getAllSessionStorages();
				for (const storage of storages) {
					if (
						'getAllNamedSessions' in storage &&
						typeof storage.getAllNamedSessions === 'function'
					) {
						try {
							const sessions = await storage.getAllNamedSessions();
							allNamedSessions.push(
								...sessions.map(
									(session: {
										agentSessionId: string;
										projectPath: string;
										sessionName: string;
										starred?: boolean;
										lastActivityAt?: number;
									}) => ({
										agentId: storage.agentId,
										...session,
									})
								)
							);
						} catch (error) {
							// Walks every provider's transcript tree, so an unreadable one
							// lands here on every call. That is environmental, not a bug -
							// warn locally and keep aggregating the providers that do work.
							if (!isExpectedSessionReadError(error)) {
								void captureException(error);
							}
							logger.warn(
								`Failed to get named sessions from ${storage.agentId}: ${error}`,
								LOG_CONTEXT
							);
						}
					}
				}

				// Also check the generic origins store for named sessions not found
				// in provider-specific stores (e.g., sessions named via the generic API)
				if (originsStore) {
					const seenIds = new Set(
						allNamedSessions.map((s) => `${s.agentId}:${s.projectPath}:${s.agentSessionId}`)
					);
					const genericOrigins = originsStore.get('origins', {});
					for (const [agentId, projectEntries] of Object.entries(genericOrigins)) {
						// Legacy labels have no account/host ownership. They cannot
						// identify a Grok conversation, even if a local file exists.
						if (agentId === 'grok') continue;
						if (!projectEntries || typeof projectEntries !== 'object') continue;
						for (const [projectPath, sessions] of Object.entries(
							projectEntries as Record<
								string,
								Record<
									string,
									{
										origin?: string;
										sessionName?: string;
										starred?: boolean;
									}
								>
							>
						)) {
							if (!sessions || typeof sessions !== 'object') continue;
							for (const [sessionId, info] of Object.entries(sessions)) {
								if (!info?.sessionName) continue;
								const key = `${agentId}:${projectPath}:${sessionId}`;
								if (seenIds.has(key)) continue;

								// Validate file exists via the storage provider
								const storage = getSessionStorage(agentId);
								if (storage) {
									try {
										const sessionPath = storage.getSessionPath(projectPath, sessionId);
										if (sessionPath) {
											await fs.stat(sessionPath);
											allNamedSessions.push({
												agentId,
												agentSessionId: sessionId,
												projectPath,
												sessionName: info.sessionName,
												starred: info.starred,
											});
										}
									} catch {
										// File doesn't exist, skip stale entry
									}
								}
							}
						}
					}
				}

				// Fallback: pull names from history entries for sessions whose names were
				// auto-set at synopsis time but never persisted to an origins store. This
				// covers historical entries written before the synopsis-time persist call
				// landed. We attribute each entry to the storage that actually contains
				// the underlying session file; if no storage owns it, the entry is stale
				// and skipped.
				try {
					const historyManager = getHistoryManager();
					const seenIdsAfterOrigins = new Set(
						allNamedSessions.map((s) => `${s.projectPath}:${s.agentSessionId}`)
					);
					const seenAcrossAgents = new Set<string>();
					const storages = getAllSessionStorages();
					const historyEntries = (await historyManager.getAllEntriesPaginated()).entries;
					for (const entry of historyEntries) {
						if (
							entry.nativeSessionBinding?.state === 'bound' &&
							entry.nativeSessionBinding.provider === 'grok'
						)
							continue;
						if (!entry.sessionName || !entry.agentSessionId || !entry.projectPath) continue;
						const projectKey = `${entry.projectPath}:${entry.agentSessionId}`;
						if (seenIdsAfterOrigins.has(projectKey) || seenAcrossAgents.has(projectKey)) continue;
						for (const storage of storages) {
							// This fallback guesses ownership from default-account paths;
							// it must not relabel Grok across accounts or SSH hosts.
							if (storage.agentId === 'grok') continue;
							const sessionPath = storage.getSessionPath(entry.projectPath, entry.agentSessionId);
							if (!sessionPath) continue;
							try {
								const stats = await fs.stat(sessionPath);
								allNamedSessions.push({
									agentId: storage.agentId,
									agentSessionId: entry.agentSessionId,
									projectPath: entry.projectPath,
									sessionName: entry.sessionName,
									lastActivityAt: stats.mtime.getTime(),
								});
								seenAcrossAgents.add(projectKey);
								break;
							} catch {
								// Not in this storage, try next
							}
						}
					}
				} catch (error) {
					void captureException(error);
					logger.warn(`Failed to merge history-derived named sessions: ${error}`, LOG_CONTEXT);
				}

				// Merge in starred sessions whose provider transcript has aged out but
				// which we still hold a mirror for. Without this they'd be dropped by the
				// fs.stat gates above and vanish from the Starred list; the mirror lets
				// the row survive (and rehydrate on click). Keyed by projectPath:sessionId
				// to match the dedupe used above.
				try {
					const seenFinal = new Set(
						allNamedSessions.map((s) => `${s.projectPath}:${s.agentSessionId}`)
					);
					for (const entry of await listMirroredStarredSessions()) {
						if (entry.agentId === 'grok') continue;
						const key = `${entry.projectPath}:${entry.sessionId}`;
						if (seenFinal.has(key)) continue;
						seenFinal.add(key);
						allNamedSessions.push({
							agentId: entry.agentId,
							agentSessionId: entry.sessionId,
							projectPath: entry.projectPath,
							sessionName: entry.sessionName ?? entry.sessionId,
							starred: true,
							lastActivityAt: entry.mirroredAtMs,
						});
					}
				} catch (error) {
					void captureException(error);
					logger.warn(`Failed to merge mirrored starred sessions: ${error}`, LOG_CONTEXT);
				}

				logger.info(
					`Found ${allNamedSessions.length} named sessions across all providers`,
					LOG_CONTEXT
				);
				return allNamedSessions;
			}
		)
	);

	// ============ Session Origins (Generic - for non-Claude agents) ============
	// These handlers manage session metadata like names and starred status for all agents

	const originsStore = deps?.agentSessionOriginsStore;

	ipcMain.handle(
		'agentSessions:getOrigins',
		withIpcErrorLogging(
			handlerOpts('getOrigins'),
			async (
				agentId: string,
				projectPath: string
			): Promise<
				Record<
					string,
					{ origin?: 'user' | 'auto' | 'relay'; sessionName?: string; starred?: boolean }
				>
			> => {
				if (!originsStore) {
					logger.warn('Origins store not available for getOrigins', LOG_CONTEXT);
					return {};
				}
				const allOrigins = originsStore.get('origins', {});
				const agentOrigins = allOrigins[agentId] || {};
				const result = agentOrigins[projectPath] || {};
				if (agentId === 'grok') {
					// Names in this legacy index cannot be assigned to a selected
					// account/host. Leave stored data and unrelated metadata intact.
					return Object.fromEntries(
						Object.entries(result).map(([id, info]) => {
							const metadata = { ...info };
							delete metadata.sessionName;
							return [id, metadata];
						})
					);
				}
				logger.info(
					`getOrigins(${agentId}, ${projectPath}): found ${Object.keys(result).length} entries`,
					LOG_CONTEXT
				);
				return result;
			}
		)
	);

	ipcMain.handle(
		'agentSessions:setSessionName',
		withIpcErrorLogging(
			handlerOpts('setSessionName'),
			async (
				agentId: string,
				projectPath: string,
				sessionId: string,
				sessionName: string | null
			): Promise<void> => {
				if (agentId === 'grok') {
					// This API changes a Maestro label, not a provider title. Its
					// provider/project/native-ID key lacks Grok account/host scope.
					// Native rename also needs the provider's title lock/index updates;
					// never replace that transaction with a summary.json write.
					throw new Error(
						'Grok history rename is unsupported in Maestro: this request has no account/host ownership, and native title changes have no verified transport. Rename the Maestro tab for a local label, or change the native title in Grok CLI and refresh history.'
					);
				}
				if (!originsStore) {
					logger.warn('Origins store not available', LOG_CONTEXT);
					return;
				}
				const allOrigins = originsStore.get('origins', {});
				if (!allOrigins[agentId]) allOrigins[agentId] = {};
				if (!allOrigins[agentId][projectPath]) allOrigins[agentId][projectPath] = {};

				if (sessionName) {
					allOrigins[agentId][projectPath][sessionId] = {
						...allOrigins[agentId][projectPath][sessionId],
						sessionName,
					};
				} else {
					// Remove sessionName
					const existing = allOrigins[agentId][projectPath][sessionId];
					if (existing) {
						delete existing.sessionName;
						// Clean up if empty
						if (!existing.starred && !existing.origin) {
							delete allOrigins[agentId][projectPath][sessionId];
						}
					}
				}
				originsStore.set('origins', allOrigins);
				logger.info(`Set session name for ${agentId}/${sessionId}: ${sessionName}`, LOG_CONTEXT);
			}
		)
	);

	ipcMain.handle(
		'agentSessions:setSessionStarred',
		withIpcErrorLogging(
			handlerOpts('setSessionStarred'),
			async (
				agentId: string,
				projectPath: string,
				sessionId: string,
				starred: boolean
			): Promise<void> => {
				if (!originsStore) {
					logger.warn('Origins store not available', LOG_CONTEXT);
					return;
				}
				const allOrigins = originsStore.get('origins', {});
				if (!allOrigins[agentId]) allOrigins[agentId] = {};
				if (!allOrigins[agentId][projectPath]) allOrigins[agentId][projectPath] = {};

				if (starred) {
					allOrigins[agentId][projectPath][sessionId] = {
						...allOrigins[agentId][projectPath][sessionId],
						starred: true,
					};
				} else {
					// Remove starred
					const existing = allOrigins[agentId][projectPath][sessionId];
					if (existing) {
						delete existing.starred;
						// Clean up if empty
						if (!existing.sessionName && !existing.origin) {
							delete allOrigins[agentId][projectPath][sessionId];
						}
					}
				}
				originsStore.set('origins', allOrigins);
				logger.info(`Set session starred for ${agentId}/${sessionId}: ${starred}`, LOG_CONTEXT);

				// Keep Maestro's own transcript mirror in sync with the star: snapshot
				// on star so the conversation survives provider-side deletion, drop the
				// mirror on unstar so it ages out naturally again. Fire-and-forget - the
				// star toggle must not block on disk I/O.
				if (starred) {
					const sessionName = allOrigins[agentId]?.[projectPath]?.[sessionId]?.sessionName;
					void snapshotStarredTranscript({ agentId, projectPath, sessionId, sessionName });
				} else {
					void releaseTranscriptMirror({ agentId, sessionId });
				}
			}
		)
	);

	// ============ Message pins (any provider) ============
	// The tab owns its pins; this mirrors them onto the provider session's origin
	// record so a conversation reopened from History or the sessions browser gets
	// them back. Routed by provider because Claude Code and Codex keep their
	// records in the Claude store, which is where loadResumableSession reads them.

	const claudeOriginsStore = deps?.claudeSessionOriginsStore;

	ipcMain.handle(
		'agentSessions:setSessionPins',
		withIpcErrorLogging(
			handlerOpts('setSessionPins'),
			async (
				agentId: string,
				projectPath: string,
				sessionId: string,
				pins: unknown
			): Promise<void> => {
				const normalized = normalizeMessagePins(pins);
				const pinnedMessages = normalized.length > 0 ? normalized : undefined;

				if (sessionOriginStoreFor(agentId) === 'claude') {
					if (!claudeOriginsStore) {
						logger.warn('Claude origins store not available for setSessionPins', LOG_CONTEXT);
						return;
					}
					setClaudeSessionOrigin(claudeOriginsStore, projectPath, sessionId, { pinnedMessages });
					return;
				}

				if (!originsStore) {
					logger.warn('Origins store not available for setSessionPins', LOG_CONTEXT);
					return;
				}
				const allOrigins = originsStore.get('origins', {});
				const projectOrigins = allOrigins[agentId]?.[projectPath] ?? {};
				const existing = projectOrigins[sessionId];
				if (pinnedMessages) {
					projectOrigins[sessionId] = { ...existing, pinnedMessages };
				} else if (existing) {
					const { pinnedMessages: _removed, ...rest } = existing;
					if (rest.origin || rest.sessionName || rest.starred) projectOrigins[sessionId] = rest;
					else delete projectOrigins[sessionId];
				} else {
					return;
				}
				allOrigins[agentId] = { ...allOrigins[agentId], [projectPath]: projectOrigins };
				originsStore.set('origins', allOrigins);
			}
		)
	);

	// ============ Snapshot Transcript (mirror on tab close / snooze) ============

	ipcMain.handle(
		'agentSessions:snapshotStarredTranscript',
		withIpcErrorLogging(
			handlerOpts('snapshotStarredTranscript'),
			async (
				agentId: string,
				projectPath: string,
				sessionId: string,
				sessionName?: string,
				reason?: MirrorRetainReason
			): Promise<void> => {
				await snapshotStarredTranscript({ agentId, projectPath, sessionId, sessionName, reason });
			}
		)
	);

	// ============ Release Snoozed Transcript (mirror on wake / dismiss) ============

	ipcMain.handle(
		'agentSessions:releaseSnoozedTranscript',
		withIpcErrorLogging(
			handlerOpts('releaseSnoozedTranscript'),
			async (agentId: string, projectPath: string, sessionId: string): Promise<void> => {
				await releaseSnoozedTranscriptMirror({ agentId, projectPath, sessionId });
			}
		)
	);

	// ============ Get Global Stats (All Providers) ============

	// One scan at a time. The About modal and the Usage Dashboard both ask, and
	// two concurrent scans would parse every transcript twice, race each other
	// writing the same cache file, and count double on the indexing bar.
	let globalStatsScan: Promise<GlobalAgentStats> | null = null;

	ipcMain.handle(
		'agentSessions:getGlobalStats',
		withIpcErrorLogging(handlerOpts('getGlobalStats'), (): Promise<GlobalAgentStats> => {
			globalStatsScan ??= scanGlobalStats().finally(() => {
				globalStatsScan = null;
			});
			return globalStatsScan;
		})
	);

	async function scanGlobalStats(): Promise<GlobalAgentStats> {
		// Helper to build result from cache
		const buildResultFromCache = (
			cache: GlobalStatsCache,
			isComplete: boolean
		): GlobalAgentStats => {
			const result: GlobalAgentStats = {
				totalSessions: 0,
				totalMessages: 0,
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalCacheReadTokens: 0,
				totalCacheCreationTokens: 0,
				totalCostUsd: 0,
				hasCostData: false,
				totalSizeBytes: 0,
				isComplete,
				byProvider: {},
			};

			// Aggregate Claude Code stats
			const claudeSessions = cache.providers['claude-code']?.sessions || {};
			const claudeAgg = aggregateProviderStats(claudeSessions, true);
			if (claudeAgg.sessions > 0) {
				result.byProvider['claude-code'] = {
					sessions: claudeAgg.sessions,
					messages: claudeAgg.messages,
					inputTokens: claudeAgg.inputTokens,
					outputTokens: claudeAgg.outputTokens,
					costUsd: claudeAgg.costUsd,
					hasCostData: true,
				};
				result.totalSessions += claudeAgg.sessions;
				result.totalMessages += claudeAgg.messages;
				result.totalInputTokens += claudeAgg.inputTokens;
				result.totalOutputTokens += claudeAgg.outputTokens;
				result.totalCacheReadTokens += claudeAgg.cacheReadTokens;
				result.totalCacheCreationTokens += claudeAgg.cacheCreationTokens;
				result.totalCostUsd += claudeAgg.costUsd;
				result.totalSizeBytes += claudeAgg.sizeBytes;
				result.hasCostData = true;
			}

			// Aggregate Codex stats
			const codexSessions = cache.providers['codex']?.sessions || {};
			const codexAgg = aggregateProviderStats(codexSessions, false);
			if (codexAgg.sessions > 0) {
				result.byProvider['codex'] = {
					sessions: codexAgg.sessions,
					messages: codexAgg.messages,
					inputTokens: codexAgg.inputTokens,
					outputTokens: codexAgg.outputTokens,
					costUsd: 0,
					hasCostData: false,
				};
				result.totalSessions += codexAgg.sessions;
				result.totalMessages += codexAgg.messages;
				result.totalInputTokens += codexAgg.inputTokens;
				result.totalOutputTokens += codexAgg.outputTokens;
				result.totalCacheReadTokens += codexAgg.cachedInputTokens;
				result.totalSizeBytes += codexAgg.sizeBytes;
			}

			// Aggregate Grok stats: tokens as the registered storage read each
			// ledger; the amount only from each session's own cost observation,
			// so an unknown cost stays unknown and a partial one keeps a floor.
			const grokSessions = cache.providers['grok']?.sessions || {};
			const grokAgg = aggregateProviderStats(grokSessions, false);
			if (grokAgg.sessions > 0) {
				const grokCost = summarizeCachedSessionCost(grokSessions);
				const costCoverage = grokCost?.coverage ?? 'unknown';
				result.byProvider['grok'] = {
					sessions: grokAgg.sessions,
					messages: grokAgg.messages,
					inputTokens: grokAgg.inputTokens,
					outputTokens: grokAgg.outputTokens,
					costUsd: grokCost?.costUsd ?? 0,
					hasCostData: costCoverage !== 'unknown',
					costCoverage,
					...(grokCost?.costUsdTicks !== undefined ? { costUsdTicks: grokCost.costUsdTicks } : {}),
				};
				result.totalSessions += grokAgg.sessions;
				result.totalMessages += grokAgg.messages;
				result.totalInputTokens += grokAgg.inputTokens;
				result.totalOutputTokens += grokAgg.outputTokens;
				result.totalCacheReadTokens += grokAgg.cacheReadTokens;
				result.totalCacheCreationTokens += grokAgg.cacheCreationTokens;
				result.totalCostUsd += grokCost?.costUsd ?? 0;
				result.totalSizeBytes += grokAgg.sizeBytes;
				if (costCoverage !== 'unknown') result.hasCostData = true;
			}

			// Once any provider reports coverage, the total's coverage counts every
			// provider: a legacy one with cost data as covered, one without as
			// unknown, so a total missing a provider's cost is never complete.
			// Payloads with no reporting provider keep the legacy shape.
			const providers = Object.values(result.byProvider);
			if (providers.some((provider) => provider.costCoverage !== undefined)) {
				result.costCoverage = mergeStatsCostCoverage(
					providers.map(
						(provider) => provider.costCoverage ?? (provider.hasCostData ? 'complete' : 'unknown')
					)
				);
			}

			return result;
		};

		// Helper to send progressive updates
		const sendUpdate = (cache: GlobalStatsCache, isComplete: boolean) => {
			const stats = buildResultFromCache(cache, isComplete);
			safeSend('agentSessions:globalStatsUpdate', stats);
		};

		// Load existing cache or create new one. An older-but-compatible cache
		// holds Claude entries from an earlier parser: every live Claude session
		// is re-parsed and the archived ones rescaled once that is done. The
		// upgrade is resumable - see `DerivationUpgrade`.
		const cache: GlobalStatsCache = (await loadGlobalStatsCache()) ?? {
			version: GLOBAL_STATS_CACHE_VERSION,
			lastUpdated: Date.now(),
			providers: {},
		};

		// Ensure provider entries exist
		if (!cache.providers['claude-code']) {
			cache.providers['claude-code'] = { sessions: {} };
		}
		if (!cache.providers['codex']) {
			cache.providers['codex'] = { sessions: {} };
		}
		if (!cache.providers['grok']) {
			cache.providers['grok'] = { sessions: {} };
		}
		const grokCache = cache.providers['grok'].sessions;

		// Discover all session files
		logger.info('Discovering session files for global stats', LOG_CONTEXT);
		const [claudeFiles, codexFiles, discoveredGrokDirs] = await Promise.all([
			discoverClaudeSessionFiles(),
			discoverCodexSessionFiles(),
			// A failed account discovery must not archive every Grok session as
			// deleted: keep the cached entries as they are for this run.
			discoverGrokSessionDirs().catch((error: unknown) => {
				void captureException(error, { operation: 'agentSessions:discoverGrokSessionDirs' });
				logger.warn('Grok session discovery failed; cached Grok stats kept', LOG_CONTEXT, {
					error,
				});
				return null;
			}),
		]);
		const grokDirs = discoveredGrokDirs ?? [];
		if (discoveredGrokDirs) {
			const currentGrokKeys = new Set(discoveredGrokDirs.map((info) => info.key));
			for (const [key, session] of Object.entries(grokCache)) {
				// Same archive rule as Claude and Codex below.
				session.archived = !currentGrokKeys.has(key);
			}
		}

		// Build sets of current session keys for archive detection
		const currentClaudeKeys = new Set(claudeFiles.map((f) => f.sessionKey));
		const currentCodexKeys = new Set(codexFiles.map((f) => f.sessionKey));

		// Mark deleted sessions as archived (preserve stats for lifetime cost tracking)
		for (const key of Object.keys(cache.providers['claude-code'].sessions)) {
			const session = cache.providers['claude-code'].sessions[key];
			if (!currentClaudeKeys.has(key)) {
				// Source file deleted - mark as archived to preserve stats
				session.archived = true;
			} else if (session.archived) {
				// Source file reappeared - mark as active (will be re-parsed below)
				session.archived = false;
			}
		}
		for (const key of Object.keys(cache.providers['codex'].sessions)) {
			const session = cache.providers['codex'].sessions[key];
			if (!currentCodexKeys.has(key)) {
				// Source file deleted - mark as archived to preserve stats
				session.archived = true;
			} else if (session.archived) {
				// Source file reappeared - mark as active (will be re-parsed below)
				session.archived = false;
			}
		}

		// A Claude entry derived by an earlier parser is re-parsed even though
		// its transcript is unchanged. Staleness is per entry, so a checkpoint
		// saved part way through still knows what is left.
		const claudeSessions = cache.providers['claude-code'].sessions;
		const loadedVersion = cache.version;
		const isClaudeStale = (entry: CachedSessionStats) =>
			isDerivationStale(entry, loadedVersion, GLOBAL_STATS_CACHE_VERSION);
		const upgrade: DerivationUpgrade | undefined =
			loadedVersion < GLOBAL_STATS_CACHE_VERSION
				? cache.upgrade?.toVersion === GLOBAL_STATS_CACHE_VERSION
					? cache.upgrade
					: { toVersion: GLOBAL_STATS_CACHE_VERSION, baseline: {} }
				: undefined;
		cache.upgrade = upgrade;

		// Find sessions that need processing (new, modified, or derived by an older parser)
		const claudeToProcess = claudeFiles.filter((f) => {
			const cached = claudeSessions[f.sessionKey];
			return !cached || cached.fileMtimeMs < f.mtimeMs || isClaudeStale(cached);
		});
		const codexToProcess = codexFiles.filter((f) => {
			const cached = cache!.providers['codex'].sessions[f.sessionKey];
			return !cached || cached.fileMtimeMs < f.mtimeMs;
		});

		const grokToProcess = grokDirs.filter((info) => {
			const cached = grokCache[info.key];
			return !cached || cached.fileMtimeMs < info.mtimeMs;
		});

		const totalToProcess = claudeToProcess.length + codexToProcess.length + grokToProcess.length;
		const cachedCount = claudeFiles.length + codexFiles.length + grokDirs.length - totalToProcess;

		logger.info(
			`Global stats: ${totalToProcess} to process (${claudeToProcess.length} Claude, ${codexToProcess.length} Codex, ${grokToProcess.length} Grok), ${cachedCount} cached`,
			LOG_CONTEXT
		);

		// Send initial update with cached data
		sendUpdate(cache, totalToProcess === 0);

		// Parse new and modified transcripts on the worker pool, bounded so at
		// most a few whole transcripts (some run to hundreds of MB) are in
		// memory at once. Progress is checkpointed, so a scan the user kills
		// resumes where it stopped instead of starting over.
		const toProcess = [
			...claudeToProcess.map((file) => ({ file, provider: 'claude-code' as const })),
			...codexToProcess.map((file) => ({ file, provider: 'codex' as const })),
		];
		const checkpoint = createCacheCheckpointer(() => {
			cache.lastUpdated = Date.now();
			return saveGlobalStatsCache(cache);
		});
		let processedCount = 0;
		await withStatsIndexing(
			{ id: 'global-stats', label: 'Usage totals', reason: upgrade ? 'upgrade' : 'index' },
			async (progress) => {
				progress.addWork(
					toProcess.length,
					toProcess.reduce((sum, { file }) => sum + file.sizeBytes, 0)
				);
				await mapWithConcurrency(
					toProcess,
					LOCAL_SESSION_PARSE_CONCURRENCY,
					async ({ file, provider }) => {
						try {
							await parseGlobalStatsFile(file, provider);
							processedCount++;
							// Stream an update every 10 sessions; the final one is sent below
							if (processedCount % 10 === 0) {
								sendUpdate(cache, false);
							}
						} finally {
							// A failed file counts as done: it is not retried in this run.
							progress.advance(1, file.sizeBytes);
							checkpoint.maybe();
						}
					}
				);
			}
		);
		await checkpoint.settle();

		// Grok sessions are read by the registered storage, one cwd folder of
		// one account per call (it reads that folder's sessions with its own
		// bounded concurrency), one folder at a time. Its results for
		// descendant folders are left to their own folder.
		const grokStorage = grokToProcess.length > 0 ? getSessionStorage('grok') : null;
		const grokParents = new Map<string, string>();
		if (grokStorage) {
			const groups = new Map<string, GrokSessionDirInfo[]>();
			for (const info of grokToProcess) {
				const groupKey = `${info.accountDir}\0${info.cwd}`;
				groups.set(groupKey, [...(groups.get(groupKey) ?? []), info]);
			}
			await mapWithConcurrency([...groups.values()], 1, async (infos) => {
				const { accountDir, cwd } = infos[0];
				const wanted = new Map(infos.map((info) => [info.identity.nativeSessionId, info]));
				try {
					const sessions = await grokStorage.listSessions(cwd, undefined, accountDir);
					for (const session of sessions) {
						const info = session.projectPath === cwd ? wanted.get(session.sessionId) : undefined;
						if (!info) continue;
						grokCache[info.key] = grokCachedSessionStats(session, info);
						const parent = grokParentSessionId(session);
						if (parent) grokParents.set(info.key, parent);
						processedCount++;
						if (processedCount % 10 === 0) sendUpdate(cache, false);
					}
				} catch (error) {
					void captureException(error, { operation: 'agentSessions:grokGlobalStats' });
					logger.warn('Failed to read Grok sessions for global stats', LOG_CONTEXT, { error });
				}
			});
		} else if (grokToProcess.length > 0) {
			logger.warn('Grok session storage is not registered; Grok stats not refreshed', LOG_CONTEXT);
		}
		// Decided when the child is read, against every cached session of its
		// pool (archived parents included, as lifetime totals include them).
		if (grokParents.size > 0) {
			const present = new Set(
				Object.values(grokCache).flatMap((entry) =>
					entry.identity
						? [`${entry.identity.accountScope}\0${entry.identity.nativeSessionId}`]
						: []
				)
			);
			for (const [key, parent] of grokParents) {
				const entry = grokCache[key];
				if (entry?.identity && present.has(`${entry.identity.accountScope}\0${parent}`)) {
					grokCache[key] = withoutParentAttributedUsage(entry);
				}
			}
		}

		if (upgrade) {
			// Live entries that failed to parse keep their old stamp, so the next
			// scan retries them rather than treating them as upgraded.
			for (const entry of Object.values(claudeSessions)) {
				if (!entry.archived && isClaudeStale(entry)) entry.derivedVersion = loadedVersion;
			}
			finishDerivationUpgrade(
				claudeSessions,
				loadedVersion,
				GLOBAL_STATS_CACHE_VERSION,
				upgrade.baseline,
				GLOBAL_STATS_UPGRADE_FIELDS,
				['costUsd']
			);
			delete cache.upgrade;
		}

		// Update cache timestamp and save
		cache.version = GLOBAL_STATS_CACHE_VERSION;
		cache.lastUpdated = Date.now();
		await saveGlobalStatsCache(cache);

		// Build final result
		const result = buildResultFromCache(cache, true);

		logger.info(
			`Global stats complete: ${result.totalSessions} sessions, ${result.totalMessages} messages, $${result.totalCostUsd.toFixed(2)} (${totalToProcess} processed, ${cachedCount} cached)`,
			LOG_CONTEXT
		);

		// Send final update
		sendUpdate(cache, true);

		return result;

		async function parseGlobalStatsFile(
			file: SessionFileInfo,
			provider: 'claude-code' | 'codex'
		): Promise<void> {
			const label = provider === 'claude-code' ? 'Claude' : 'Codex';
			try {
				const stats = await runTranscriptParse({
					kind: provider === 'claude-code' ? 'claude-usage-stats' : 'codex-usage-stats',
					filePath: file.filePath,
					sizeBytes: file.sizeBytes,
				});
				const sessions = cache.providers[provider].sessions;
				const previous = sessions[file.sessionKey];
				const next: CachedSessionStats = {
					...stats,
					fileMtimeMs: file.mtimeMs,
					archived: false,
				};
				if (provider === 'claude-code') {
					next.derivedVersion = GLOBAL_STATS_CACHE_VERSION;
					if (upgrade && previous && isClaudeStale(previous)) {
						accumulateUpgradeBaseline(
							upgrade.baseline,
							previous,
							next,
							GLOBAL_STATS_UPGRADE_FIELDS
						);
					}
				}
				sessions[file.sessionKey] = next;
			} catch (error) {
				// A session file too large to read into a single V8 string throws
				// `RangeError: Invalid string length` (MAESTRO-M9). That's an expected
				// boundary for huge sessions, not a bug - skip it and keep aggregating
				// the rest. Mirrors the storage-layer carve-out in
				// claude-/codex-session-storage.ts.
				if (error instanceof RangeError) {
					logger.warn(`${label} session file too large to parse: ${file.sessionKey}`, LOG_CONTEXT);
				} else if (isExpectedSessionReadError(error)) {
					// Unreadable or vanished transcript - environmental, see
					// EXPECTED_SESSION_READ_ERROR_CODES (MAESTRO-W9).
					logger.warn(`${label} session file not readable: ${file.sessionKey}`, LOG_CONTEXT, {
						error,
					});
				} else {
					void captureException(error);
					logger.warn(`Failed to parse ${label} session: ${file.sessionKey}`, LOG_CONTEXT, {
						error,
					});
				}
			}
		}
	}
}
