/**
 * Cue Token Accessor
 *
 * Unified, agent-agnostic token-usage lookup for Cue dashboard attribution.
 *
 * Two distinct id spaces are in play and conflating them is what made every
 * Cue token figure read zero:
 * - **Maestro agent id** - what `cue_events` / `session_lifecycle` store. Used
 *   here only to resolve `(agentType, projectPath, isRemote)` from the
 *   `session_lifecycle` stats table.
 * - **Provider session id** - Claude's `session_id` etc., the key the agents'
 *   on-disk session files (and `AgentSessionInfo.sessionId`) use. Used here to
 *   actually match token totals.
 *
 * Callers therefore pass `{ maestroSessionId, providerSessionId }` pairs and
 * get back a map keyed by **providerSessionId**. Each Cue run spawns a fresh
 * agent process (no `--resume`), so one provider session == one Cue event ==
 * one token total; the "credit-the-whole-session" model is exact, not an
 * over-count, for this caller.
 *
 * Design notes (see `AGENT-TOKEN-AUDIT.md` for the full audit):
 * - All five priority agents already aggregate token data into the uniform
 *   `AgentSessionInfo` shape via `listSessions(projectPath)`. We rely on that
 *   shape rather than hand-rolling per-agent parsers.
 * - Token attribution credits the entire session (Phase 02 Q2 decision).
 *   `sinceMs`/`untilMs` only filter which sessions are *included* in the
 *   result; included sessions report full session totals.
 * - SSH remote sessions are not supported in Phase 02 - `session_lifecycle`
 *   stores `is_remote` but not the SSH remote ID, so we cannot resolve the
 *   `SshRemoteConfig` from the stats DB alone. Remote sessions are returned
 *   with `coverage: 'partial'` and zeros, plus a warn-level log. Phase 04 may
 *   thread an SSH resolver through if remote attribution becomes a
 *   requirement.
 * - Per-`sessionId` results are cached in-memory for 30s to avoid re-reading
 *   storage when the dashboard polls multiple times in quick succession.
 */

import type Database from 'better-sqlite3';
import type { AgentSessionInfo } from '../../agents';
import { getSessionStorage } from '../../agents';
import { getStatsDB } from '../../stats';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';

const LOG_CONTEXT = '[CueTokenAccessor]';
const CACHE_TTL_MS = 30 * 1000;

/**
 * Aggregated token usage for one provider session.
 *
 * `coverage` reports how complete the data is - see audit doc for which
 * agents fall into each bucket. Callers should surface the bucket in the UI
 * so users understand when totals are an undercount.
 */
export interface SessionTokenSummary {
	/** Provider session id (e.g. Claude's `session_id`) the totals were read from. */
	sessionId: string;
	agentType: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	/** USD cost. `null` when the agent doesn't track cost. */
	costUsd: number | null;
	/** Earliest message timestamp (ms since epoch). 0 when unknown. */
	windowStartMs: number;
	/** Latest message timestamp (ms since epoch). 0 when unknown. */
	windowEndMs: number;
	coverage: 'full' | 'partial' | 'unsupported';
}

/**
 * Per-agent base coverage label, applied when the storage returned data.
 *
 * - `full` → all 4 token fields populated; `costUsd` present when the agent
 *   tracks cost (claude-code, opencode), otherwise absent (factory-droid).
 * - `partial` → at least one structural gap:
 *     - `codex`: `cacheCreationTokens` always 0; no `costUsd`.
 *     - `copilot-cli`: tokens only emitted at `session.shutdown`; in-flight
 *       sessions report zeros.
 *
 * Agents not in this map fall through to `unsupported`.
 */
const COVERAGE_BY_AGENT: Record<string, 'full' | 'partial'> = {
	'claude-code': 'full',
	opencode: 'full',
	'factory-droid': 'full',
	codex: 'partial',
	'copilot-cli': 'partial',
};

/**
 * One unit of work for {@link getSessionTokenSummaries}: the Maestro agent id
 * (to resolve agent type / project via `session_lifecycle`) paired with the
 * provider session id the run produced (to match on-disk token totals).
 */
export interface SessionTokenLookup {
	maestroSessionId: string;
	providerSessionId: string;
}

interface CacheEntry {
	summary: SessionTokenSummary;
	expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

interface SessionLookupRow {
	session_id: string;
	agent_type: string;
	project_path: string | null;
	is_remote: number | null;
}

/**
 * Look up `(agentType, projectPath, isRemote)` for a batch of session IDs.
 * Sessions absent from `session_lifecycle` are simply missing from the
 * returned map - callers should treat that as "session doesn't exist".
 */
function lookupSessions(
	db: Database.Database,
	sessionIds: string[]
): Map<string, SessionLookupRow> {
	const map = new Map<string, SessionLookupRow>();
	if (sessionIds.length === 0) return map;

	const placeholders = sessionIds.map(() => '?').join(', ');
	const rows = db
		.prepare(
			`SELECT session_id, agent_type, project_path, is_remote
			 FROM session_lifecycle
			 WHERE session_id IN (${placeholders})`
		)
		.all(...sessionIds) as SessionLookupRow[];

	for (const row of rows) {
		map.set(row.session_id, row);
	}
	return map;
}

/** Parse an ISO timestamp string into ms-since-epoch. Returns 0 on failure. */
function parseTimestamp(iso: string | undefined): number {
	if (!iso) return 0;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : 0;
}

function buildSummaryFromInfo(
	sessionId: string,
	agentType: string,
	info: AgentSessionInfo
): SessionTokenSummary {
	const baseCoverage = COVERAGE_BY_AGENT[agentType];
	return {
		sessionId,
		agentType,
		inputTokens: info.inputTokens || 0,
		outputTokens: info.outputTokens || 0,
		cacheReadTokens: info.cacheReadTokens || 0,
		cacheCreationTokens: info.cacheCreationTokens || 0,
		costUsd: typeof info.costUsd === 'number' ? info.costUsd : null,
		windowStartMs: parseTimestamp(info.timestamp),
		windowEndMs: parseTimestamp(info.modifiedAt),
		coverage: baseCoverage ?? 'unsupported',
	};
}

function buildEmptySummary(
	sessionId: string,
	agentType: string,
	coverage: 'partial' | 'unsupported'
): SessionTokenSummary {
	return {
		sessionId,
		agentType,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		costUsd: null,
		windowStartMs: 0,
		windowEndMs: 0,
		coverage,
	};
}

function matchesWindow(
	summary: SessionTokenSummary,
	opts?: { sinceMs?: number; untilMs?: number }
): boolean {
	if (!opts) return true;
	if (opts.sinceMs != null && summary.windowEndMs > 0 && summary.windowEndMs < opts.sinceMs) {
		return false;
	}
	if (opts.untilMs != null && summary.windowStartMs > 0 && summary.windowStartMs > opts.untilMs) {
		return false;
	}
	return true;
}

/**
 * Resolve token totals for a batch of `{ maestroSessionId, providerSessionId }`
 * lookups.
 *
 * @param lookups - Pairs of Maestro agent id (resolves agent type / project via
 *   `session_lifecycle`) and the provider session id the run produced (matches
 *   on-disk token totals). Deduped by `providerSessionId`.
 * @param opts.sinceMs - Optional window lower bound. Sessions whose
 *   `windowEndMs` falls before this are excluded from the result. Token
 *   counts on included sessions are NOT clipped - the simple model credits
 *   the full session.
 * @param opts.untilMs - Optional window upper bound. Sessions whose
 *   `windowStartMs` falls after this are excluded from the result. Same
 *   "no clipping" semantics.
 * @returns Map keyed by `providerSessionId`. Provider sessions whose Maestro
 *   agent id isn't in `session_lifecycle` are absent from the map (not zeroed).
 *   Sessions for unknown agents are present with `coverage: 'unsupported'` and
 *   zeros.
 */
export async function getSessionTokenSummaries(
	lookups: SessionTokenLookup[],
	opts?: { sinceMs?: number; untilMs?: number }
): Promise<Map<string, SessionTokenSummary>> {
	const result = new Map<string, SessionTokenSummary>();
	if (lookups.length === 0) return result;

	const now = Date.now();

	// Dedupe by providerSessionId (globally unique), remembering each one's
	// Maestro agent id so we can resolve its agent type / project below.
	const maestroByProvider = new Map<string, string>();
	for (const { maestroSessionId, providerSessionId } of lookups) {
		if (!providerSessionId || !maestroSessionId) continue;
		if (!maestroByProvider.has(providerSessionId)) {
			maestroByProvider.set(providerSessionId, maestroSessionId);
		}
	}

	// First pass - serve from cache, collect uncached provider ids.
	const uncached: string[] = [];
	for (const providerSessionId of maestroByProvider.keys()) {
		const entry = cache.get(providerSessionId);
		if (entry && entry.expiresAt > now) {
			if (matchesWindow(entry.summary, opts)) {
				result.set(providerSessionId, entry.summary);
			}
			continue;
		}
		uncached.push(providerSessionId);
	}
	if (uncached.length === 0) return result;

	// Resolve agent type / project / remote flag for the uncached batch's
	// Maestro agent ids (that's what `session_lifecycle` is keyed by).
	let lifecycle: Map<string, SessionLookupRow>;
	try {
		const db = getStatsDB().database;
		const maestroIds = Array.from(new Set(uncached.map((p) => maestroByProvider.get(p)!)));
		lifecycle = lookupSessions(db, maestroIds);
	} catch (error) {
		void captureException(error);
		logger.warn(`Failed to look up sessions in stats DB: ${error}`, LOG_CONTEXT);
		return result;
	}

	// Group by (agentType, projectPath, isRemote) so we make one
	// listSessions() call per group instead of one per session. Each group
	// carries the provider session ids to match within that project.
	interface Group {
		agentType: string;
		projectPath: string;
		isRemote: boolean;
		providerSessionIds: string[];
	}
	const groups = new Map<string, Group>();

	for (const providerSessionId of uncached) {
		const maestroId = maestroByProvider.get(providerSessionId)!;
		const row = lifecycle.get(maestroId);
		if (!row) {
			// Maestro agent isn't in session_lifecycle (aged out, or stats were
			// off when it was created): "a session that doesn't exist returns
			// nothing in the map."
			continue;
		}

		// No project path: we can't call listSessions(). Treat as partial.
		if (!row.project_path) {
			const coverage = COVERAGE_BY_AGENT[row.agent_type] ? 'partial' : 'unsupported';
			const summary = buildEmptySummary(providerSessionId, row.agent_type, coverage);
			result.set(providerSessionId, summary);
			cache.set(providerSessionId, { summary, expiresAt: now + CACHE_TTL_MS });
			continue;
		}

		const isRemote = row.is_remote === 1;
		const key = `${row.agent_type}::${row.project_path}::${isRemote ? 1 : 0}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				agentType: row.agent_type,
				projectPath: row.project_path,
				isRemote,
				providerSessionIds: [],
			};
			groups.set(key, group);
		}
		group.providerSessionIds.push(providerSessionId);
	}

	await Promise.all(
		Array.from(groups.values()).map(async (group) => {
			const baseCoverage = COVERAGE_BY_AGENT[group.agentType];

			// Unknown agent - mark unsupported.
			if (!baseCoverage) {
				for (const providerSessionId of group.providerSessionIds) {
					const summary = buildEmptySummary(providerSessionId, group.agentType, 'unsupported');
					cache.set(providerSessionId, { summary, expiresAt: now + CACHE_TTL_MS });
					if (matchesWindow(summary, opts)) result.set(providerSessionId, summary);
				}
				return;
			}

			// Remote session token data lives on the remote host. We don't thread
			// SSH config through here; mark partial and warn.
			if (group.isRemote) {
				logger.warn(
					`Skipping token attribution for ${group.providerSessionIds.length} remote session(s) (agent=${group.agentType}, project=${group.projectPath}); SSH config is not threaded through the token accessor`,
					LOG_CONTEXT
				);
				for (const providerSessionId of group.providerSessionIds) {
					const summary = buildEmptySummary(providerSessionId, group.agentType, 'partial');
					cache.set(providerSessionId, { summary, expiresAt: now + CACHE_TTL_MS });
					if (matchesWindow(summary, opts)) result.set(providerSessionId, summary);
				}
				return;
			}

			const storage = getSessionStorage(group.agentType);
			if (!storage) {
				// Defensive: agent in COVERAGE_BY_AGENT but no storage registered.
				logger.warn(
					`No session storage registered for agent ${group.agentType}; returning unsupported summaries`,
					LOG_CONTEXT
				);
				for (const providerSessionId of group.providerSessionIds) {
					const summary = buildEmptySummary(providerSessionId, group.agentType, 'unsupported');
					cache.set(providerSessionId, { summary, expiresAt: now + CACHE_TTL_MS });
					if (matchesWindow(summary, opts)) result.set(providerSessionId, summary);
				}
				return;
			}

			let sessions: AgentSessionInfo[] = [];
			try {
				sessions = await storage.listSessions(group.projectPath);
			} catch (error) {
				void captureException(error);
				logger.warn(
					`Failed to list ${group.agentType} sessions for ${group.projectPath}: ${error}`,
					LOG_CONTEXT
				);
			}

			const byId = new Map<string, AgentSessionInfo>();
			for (const session of sessions) byId.set(session.sessionId, session);

			for (const providerSessionId of group.providerSessionIds) {
				const info = byId.get(providerSessionId);
				const summary = info
					? buildSummaryFromInfo(providerSessionId, group.agentType, info)
					: buildEmptySummary(providerSessionId, group.agentType, 'partial');
				cache.set(providerSessionId, { summary, expiresAt: now + CACHE_TTL_MS });
				if (matchesWindow(summary, opts)) result.set(providerSessionId, summary);
			}
		})
	);

	return result;
}

/**
 * Resolve `agentType` for a batch of Maestro agent ids from `session_lifecycle`.
 *
 * Kept separate from token resolution because agent type is keyed by the
 * Maestro agent id (what `cue_events` stores) and is available even for events
 * that never recorded a provider session id - so the dashboard can still label
 * a run's agent when its token total is unknown. Maestro agent ids absent from
 * `session_lifecycle` are simply missing from the returned map.
 */
export function getAgentTypesForSessions(maestroSessionIds: string[]): Map<string, string> {
	const result = new Map<string, string>();
	const unique = Array.from(new Set(maestroSessionIds.filter(Boolean)));
	if (unique.length === 0) return result;

	try {
		const db = getStatsDB().database;
		const rows = lookupSessions(db, unique);
		for (const [maestroId, row] of rows) {
			if (row.agent_type) result.set(maestroId, row.agent_type);
		}
	} catch (error) {
		void captureException(error);
		logger.warn(`Failed to resolve agent types from stats DB: ${error}`, LOG_CONTEXT);
	}
	return result;
}

/**
 * Clear the in-memory token-summary cache. Intended for tests and explicit
 * invalidation flows; production callers should rely on the 30s TTL.
 */
export function _resetCueTokenAccessorCache(): void {
	cache.clear();
}
