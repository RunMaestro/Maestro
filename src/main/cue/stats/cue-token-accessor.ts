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
 * get back a map keyed by **sessionTokenLookupKey(maestroSessionId, providerSessionId)**.
 * Native IDs alone can collide across providers, agents and accounts. Grok
 * lookups are partial: Cue has no recorded launch account/host receipt, and its
 * native lifetime totals cannot substitute for one event's stream usage.
 *
 * Design notes (see `AGENT-TOKEN-AUDIT.md` for the full audit):
 * - All five priority agents already aggregate token data into the uniform
 *   `AgentSessionInfo` shape via `listSessions(projectPath)`. We rely on that
 *   shape rather than hand-rolling per-agent parsers.
 * - Legacy token attribution credits the entire session (Phase 02 Q2 decision).
 *   Grok is excluded until persisted launch scope and per-event accounting exist.
 *   `sinceMs`/`untilMs` only filter which sessions are *included* in the
 *   result; included sessions report full session totals.
 * - SSH remote sessions are not supported in Phase 02 - `session_lifecycle`
 *   stores `is_remote` but not the SSH remote ID, so we cannot resolve the
 *   `SshRemoteConfig` from the stats DB alone. Remote sessions are returned
 *   with `coverage: 'partial'` and zeros, plus a warn-level log. Phase 04 may
 *   thread an SSH resolver through if remote attribution becomes a
 *   requirement.
 * - Non-Grok results are cached by lookup pair and lifecycle metadata for 30s to avoid re-reading
 *   storage when the dashboard polls multiple times in quick succession.
 */

import type Database from 'better-sqlite3';
import type { UsageAccounting } from '../../../shared/types';
import type { AgentSessionInfo } from '../../agents';
import { getSessionStorage } from '../../agents';
import { getStatsDB } from '../../stats';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { canonicalJson } from '../../../shared/canonicalJson';

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
	/** Original stream evidence, including partial cost and model detail. */
	accounting?: UsageAccounting;
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
	grok: 'full',
	codex: 'partial',
	'copilot-cli': 'partial',
	antigravity: 'partial',
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

/** Join key shared with Cue's event consumer; native IDs are not globally unique. */
export function sessionTokenLookupKey(maestroSessionId: string, providerSessionId: string): string {
	return canonicalJson([maestroSessionId, providerSessionId]);
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
 *   on-disk token totals). Deduped by the Maestro/provider pair.
 * @param opts.sinceMs - Optional window lower bound. Sessions whose
 *   `windowEndMs` falls before this are excluded from the result. Token
 *   counts on included sessions are NOT clipped - the simple model credits
 *   the full session.
 * @param opts.untilMs - Optional window upper bound. Sessions whose
 *   `windowStartMs` falls after this are excluded from the result. Same
 *   "no clipping" semantics.
 * @returns Map keyed by {@link sessionTokenLookupKey}. Provider sessions whose Maestro
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

	const requested = new Map<string, SessionTokenLookup>();
	for (const lookup of lookups) {
		if (!lookup.providerSessionId || !lookup.maestroSessionId) continue;
		requested.set(sessionTokenLookupKey(lookup.maestroSessionId, lookup.providerSessionId), lookup);
	}
	if (requested.size === 0) return result;

	// Resolve lifecycle BEFORE cache lookup: removal or changed provider/project
	// must not return a different owner's cached native-session totals.
	let lifecycle: Map<string, SessionLookupRow>;
	try {
		const db = getStatsDB().database;
		const maestroIds = Array.from(
			new Set(Array.from(requested.values(), (p) => p.maestroSessionId))
		);
		lifecycle = lookupSessions(db, maestroIds);
	} catch (error) {
		void captureException(error);
		logger.warn(`Failed to look up sessions in stats DB: ${error}`, LOG_CONTEXT);
		return result;
	}

	// Batch legacy lookups by their recorded provider/project/remote metadata.
	interface Group {
		agentType: string;
		projectPath: string;
		isRemote: boolean;
		lookups: Array<{ providerSessionId: string; key: string; cacheKey: string }>;
	}
	const groups = new Map<string, Group>();

	for (const [key, { maestroSessionId, providerSessionId }] of requested) {
		const row = lifecycle.get(maestroSessionId);
		if (!row) continue;

		// Current agent settings cannot establish a historical Grok account or
		// host. Do not search the default account or reuse an unscoped cache hit.
		if (row.agent_type === 'grok') {
			const summary = buildEmptySummary(providerSessionId, row.agent_type, 'partial');
			if (matchesWindow(summary, opts)) result.set(key, summary);
			continue;
		}

		const cacheKey = canonicalJson([key, row.agent_type, row.project_path, row.is_remote]);
		const entry = cache.get(cacheKey);
		if (entry && entry.expiresAt > now) {
			if (matchesWindow(entry.summary, opts)) result.set(key, entry.summary);
			continue;
		}

		if (!row.project_path) {
			const coverage = COVERAGE_BY_AGENT[row.agent_type] ? 'partial' : 'unsupported';
			const summary = buildEmptySummary(providerSessionId, row.agent_type, coverage);
			if (matchesWindow(summary, opts)) result.set(key, summary);
			cache.set(cacheKey, { summary, expiresAt: now + CACHE_TTL_MS });
			continue;
		}

		const isRemote = row.is_remote === 1;
		const groupKey = canonicalJson([row.agent_type, row.project_path, isRemote]);
		let group = groups.get(groupKey);
		if (!group) {
			group = {
				agentType: row.agent_type,
				projectPath: row.project_path,
				isRemote,
				lookups: [],
			};
			groups.set(groupKey, group);
		}
		group.lookups.push({ providerSessionId, key, cacheKey });
	}

	await Promise.all(
		Array.from(groups.values()).map(async (group) => {
			const baseCoverage = COVERAGE_BY_AGENT[group.agentType];

			// Unknown agent - mark unsupported.
			if (!baseCoverage) {
				for (const { providerSessionId, key, cacheKey } of group.lookups) {
					const summary = buildEmptySummary(providerSessionId, group.agentType, 'unsupported');
					cache.set(cacheKey, { summary, expiresAt: now + CACHE_TTL_MS });
					if (matchesWindow(summary, opts)) result.set(key, summary);
				}
				return;
			}

			// Remote session token data lives on the remote host. We don't thread
			// SSH config through here; mark partial and warn.
			if (group.isRemote) {
				logger.warn(
					`Skipping token attribution for ${group.lookups.length} remote session(s) (agent=${group.agentType}, project=${group.projectPath}); SSH config is not threaded through the token accessor`,
					LOG_CONTEXT
				);
				for (const { providerSessionId, key, cacheKey } of group.lookups) {
					const summary = buildEmptySummary(providerSessionId, group.agentType, 'partial');
					cache.set(cacheKey, { summary, expiresAt: now + CACHE_TTL_MS });
					if (matchesWindow(summary, opts)) result.set(key, summary);
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
				for (const { providerSessionId, key, cacheKey } of group.lookups) {
					const summary = buildEmptySummary(providerSessionId, group.agentType, 'unsupported');
					cache.set(cacheKey, { summary, expiresAt: now + CACHE_TTL_MS });
					if (matchesWindow(summary, opts)) result.set(key, summary);
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

			for (const { providerSessionId, key, cacheKey } of group.lookups) {
				const info = byId.get(providerSessionId);
				const summary = info
					? buildSummaryFromInfo(providerSessionId, group.agentType, info)
					: buildEmptySummary(providerSessionId, group.agentType, 'partial');
				cache.set(cacheKey, { summary, expiresAt: now + CACHE_TTL_MS });
				if (matchesWindow(summary, opts)) result.set(key, summary);
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
