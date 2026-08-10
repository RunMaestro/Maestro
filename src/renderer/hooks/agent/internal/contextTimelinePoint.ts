/**
 * buildContextTimelinePoint - the ONE copy of "what does this usage event mean
 * for the Context Timeline".
 *
 * Extracted from `useAgentUsageListener` (finding S1) so two callers can share
 * it without forking:
 *
 *  1. the live `process:usage` listener, and
 *  2. hydration, which replays the RAW captures main kept
 *     (`src/main/process-listeners/context-timeline-log.ts`) when a fresh
 *     renderer opens the panel with an empty buffer.
 *
 * Replaying through this function is what makes the four skip guards and the
 * context-window precedence reproduce by construction rather than by
 * duplication - main stores raw events precisely so none of this has to live
 * there. The extraction is behavior preserving: the live listener now calls
 * this and uses the same `resolvedWindow` / `occupancyStats` it computed inline
 * before.
 */

import type { Session, ToolType } from '../../../types';
import type { UsageStats } from '../../../../shared/types';
import type { ParsedSessionId } from '../../../utils/sessionIdParser';
import { calculateContextTokens } from '../../../utils/contextUsage';
import {
	getContextWindowForAgent,
	getModelContextWindowOverride,
} from '../../../../shared/agentConstants';
import {
	ensureConfiguredContextWindowCached,
	getCachedConfiguredContextWindow,
} from '../../../utils/contextWindowResolver';
import { useAgentStore } from '../../../stores/agentStore';
import type { ContextTimelinePointInput } from '../../../stores/contextTimelineStore';

/** Token fields the gauge and the point both measure occupancy from. */
export interface OccupancyStats {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	contextWindow?: number;
}

export interface ContextTimelinePointBuild {
	/** The context window the point (and the gauge) divides by. 0 when unknown. */
	resolvedWindow: number;
	/** Absolute occupancy source for this turn (snapshot when the provider sent one). */
	occupancyStats: OccupancyStats;
	/** SSH remote UUID for capability-snapshot lookups; undefined when local. */
	sessionRemoteId: string | undefined;
	/** True for a window-only correction replay (no per-turn side effects). */
	isContextWindowCorrection: boolean;
	/** The point to append, or null when one of the four skip guards fired. */
	point: ContextTimelinePointInput | null;
}

/**
 * Per-session SSH config wins over the legacy session-wide field; the remote
 * UUID is what makes the snapshot lookup hit the `agentId:remoteId` key instead
 * of falling back to local.
 */
export function resolveUsageSessionRemoteId(session: Session): string | undefined {
	return session.sessionSshRemoteConfig?.enabled
		? (session.sessionSshRemoteConfig.remoteId ?? undefined)
		: session.sshRemoteId;
}

export function buildContextTimelinePoint(
	parsed: ParsedSessionId,
	usageStats: UsageStats,
	session: Session
): ContextTimelinePointBuild {
	const agentToolType = session.toolType as ToolType | undefined;
	const sessionRemoteId = resolveUsageSessionRemoteId(session);

	// Prefer the absolute occupancy snapshot whenever the provider attached one.
	// The top-level fields are NOT occupancy for every provider: Codex sends
	// per-turn deltas of a cumulative total, and claude-code's result message
	// sums every internal API call of the turn, so a tool-heavy turn can exceed
	// the window and drop the gauge estimate into the null fallback - which is
	// what pinned the gauge at 0% (finding Q1). The snapshot is real occupancy in
	// both cases, and the Context Timeline plots from it, so reading the same
	// source on both surfaces keeps them from disagreeing.
	//
	// The snapshot carries no window of its own, so hand the event's reported
	// window across with it; estimateContextUsage falls back to the capability
	// snapshot and the static table when that is 0, exactly as it does for the
	// top-level stats.
	const occupancyStats: OccupancyStats = usageStats.absoluteUsage
		? { ...usageStats.absoluteUsage, contextWindow: usageStats.contextWindow }
		: usageStats;

	// Resolve the effective context window ONCE, shared by the timeline point and
	// the caller's accumulated-growth fallback so they can never disagree.
	//
	// Precedence (finding P1). Ranks 1-3 and 5 are POSITIONALLY IDENTICAL to
	// useContextWindow's, or the header gauge and the Context Timeline disagree
	// again (the bug PR #1221 fixed). Ranks 4 and 6 are timeline-only extras and
	// sit below the shared ranks:
	//   1. `[1m]` model marker
	//   2. resolved reported window
	//   3. `customContextWindow` override
	//   4. cached provider-configured window (timeline-only)
	//   5. raw reported window
	//   6. static per-agent table (timeline-only)
	//
	// The provider-config source lives behind an async `getConfig` call that must
	// NOT run on this hot per-turn path, so we read it from a synchronous cache
	// and prime that cache off-path for the next turn. It closes the gap for
	// agents (e.g. OpenCode) whose window is configured at the provider level
	// only and would otherwise plot against the static table.
	ensureConfiguredContextWindowCached(session);
	// A `[1m]` marker on the session's custom model is an explicit model choice
	// the user made per-session, so it stays at the top.
	const modelMarker = getModelContextWindowOverride(session.customModel) || 0;
	// A genuinely provider-resolved window (flagged via `contextWindowResolved`,
	// set only where the value came from the provider's own payload) is runtime
	// truth, so it outranks the stored override below.
	const resolvedReportedWindow =
		usageStats.contextWindowResolved && usageStats.contextWindow > 0 ? usageStats.contextWindow : 0;
	// `customContextWindow` is NOT reliably something the user chose: the agent
	// definition's `contextWindow` default is materialized into every new session
	// at creation time (see P1), which is how a fresh omp agent plotted against
	// 200k instead of the provider's real 1M. Treat it as a fallback that applies
	// until the provider reports an authoritative window.
	const sessionOverride =
		typeof session.customContextWindow === 'number' && session.customContextWindow > 0
			? session.customContextWindow
			: 0;
	const cachedConfiguredWindow = getCachedConfiguredContextWindow(session);
	const resolvedWindow =
		modelMarker > 0
			? modelMarker
			: resolvedReportedWindow > 0
				? resolvedReportedWindow
				: sessionOverride > 0
					? sessionOverride
					: cachedConfiguredWindow > 0
						? cachedConfiguredWindow
						: usageStats.contextWindow > 0
							? usageStats.contextWindow
							: agentToolType && agentToolType !== 'terminal'
								? getContextWindowForAgent(
										agentToolType,
										useAgentStore.getState().getCapabilitySnapshot(agentToolType, sessionRemoteId)
									)
								: 0;

	// A context-window correction (omp's catalog primed after the first turn's
	// fallback usage already emitted) replays an already-counted turn purely to
	// fix the window. The batched updater applies it as window-only, but the
	// per-turn side effects (timeline point, cycle tokens) would still
	// double-count, so they are skipped for corrections.
	const isContextWindowCorrection = usageStats.contextWindowCorrectionOnly === true;

	// Three kinds of events are deliberately NOT recorded (see the guards below):
	//  1. Synthetic runs (synopsis / Auto Run batch) map to the parent
	//     baseSessionId but consume a SEPARATE process context - recording them
	//     would pollute the visible agent's timeline with hidden work. The
	//     visible usage gauge already ignores them (it keys off actualSessionId),
	//     so the timeline matches it by only recording interactive runs.
	//  2. Output-only deltas (Copilot streams these between context snapshots:
	//     outputTokens only, zero input/cache). Recording one would dip the
	//     timeline to just the latest output tokens. Mirror the
	//     snapshot-preserving guard in useBatchedSessionUpdates.
	const isInteractiveRun =
		parsed.type === 'ai-tab' || parsed.type === 'legacy-ai' || parsed.type === 'regular';
	// Output-only deltas are skipped ONLY when there is no absolute snapshot: a
	// Codex output-only turn still carries an `absoluteUsage` reflecting real
	// context growth, so it must be recorded.
	const isOutputOnlyDelta =
		!usageStats.absoluteUsage &&
		usageStats.inputTokens === 0 &&
		(usageStats.cacheReadInputTokens || 0) === 0 &&
		(usageStats.cacheCreationInputTokens || 0) === 0 &&
		usageStats.outputTokens > 0;
	// No-activity repeats: Codex emits a usage update for BOTH the token_count
	// event and the turn.completed message; the second carries identical
	// cumulative totals, so normalizeUsageToDelta yields an all-zero delta (with
	// an absoluteUsage snapshot). Recording it would add a duplicate row with no
	// token activity and a repeated context point.
	const hasNoTurnActivity =
		usageStats.inputTokens === 0 &&
		(usageStats.cacheReadInputTokens || 0) === 0 &&
		(usageStats.cacheCreationInputTokens || 0) === 0 &&
		usageStats.outputTokens === 0 &&
		(usageStats.reasoningTokens || 0) === 0;

	const recordPoint =
		isInteractiveRun && !isOutputOnlyDelta && !hasNoTurnActivity && !isContextWindowCorrection;

	if (!recordPoint) {
		return {
			resolvedWindow,
			occupancyStats,
			sessionRemoteId,
			isContextWindowCorrection,
			point: null,
		};
	}

	// `occupancyStats` is the absolute snapshot when the provider attached one -
	// the pre-normalization running total for Codex, whose deltas would make a
	// long run look low and flat, and the last internal call's usage for
	// claude-code, whose summed turn totals are token spend rather than window
	// fill. Providers whose per-turn stats are already absolute (Copilot,
	// OpenCode) fall through to those. The per-turn token fields recorded on the
	// point below are intentionally left as the deltas (this turn's activity);
	// only the context-fill figures use the absolute source.
	const contextTokens = calculateContextTokens(occupancyStats, agentToolType);
	// Percentage against the SAME (configured-aware) window the point stores, so
	// the row is internally consistent and matches the header. null when tokens
	// exceed the window (accumulated multi-tool turn) - the panel derives the
	// true over-limit percentage from the stored tokens/window pair instead.
	const pointPercentage =
		resolvedWindow > 0 && contextTokens <= resolvedWindow
			? Math.round((contextTokens / resolvedWindow) * 100)
			: null;

	return {
		resolvedWindow,
		occupancyStats,
		sessionRemoteId,
		isContextWindowCorrection,
		point: {
			tabId: parsed.tabId,
			inputTokens: usageStats.inputTokens,
			outputTokens: usageStats.outputTokens,
			cacheReadInputTokens: usageStats.cacheReadInputTokens || 0,
			cacheCreationInputTokens: usageStats.cacheCreationInputTokens || 0,
			reasoningTokens: usageStats.reasoningTokens || 0,
			totalCostUsd: usageStats.totalCostUsd || 0,
			contextTokens,
			contextWindow: resolvedWindow,
			percentage: pointPercentage,
			// Stamped by main's capture log; the exact dedup key between a live
			// append and the same event arriving again through hydration.
			seq: usageStats.captureSeq,
		},
	};
}
