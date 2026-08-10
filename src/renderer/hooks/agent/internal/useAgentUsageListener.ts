/**
 * useAgentUsageListener - registers `window.maestro.process.onUsage`
 *
 * Updates per-tab and per-session usage stats via the batched updater.
 * Estimates context-window % using `estimateContextUsage`; falls back to
 * `estimateAccumulatedGrowth` when the agent does not report
 * `contextPercentage` directly.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { parseSessionId } from '../../../utils/sessionIdParser';
import {
	estimateContextUsage,
	estimateAccumulatedGrowth,
	calculateContextTokens,
} from '../../../utils/contextUsage';
import {
	getContextWindowForAgent,
	getModelContextWindowOverride,
} from '../../../../shared/agentConstants';
import {
	ensureConfiguredContextWindowCached,
	getCachedConfiguredContextWindow,
} from '../../../utils/contextWindowResolver';
import { useAgentStore } from '../../../stores/agentStore';
import { useOwnedSessionGate } from './useOwnedSessionGate';
import { useContextTimelineStore } from '../../../stores/contextTimelineStore';
import type { BatchedUpdater } from './types';

/**
 * When the agent doesn't report a contextPercentage and we have to estimate,
 * keep the estimate this many percentage points below the configured yellow
 * warning threshold so an extrapolated value never trips the warning UI on
 * its own - the user sees yellow only when the agent's reported usage
 * crosses the bar, not when our heuristic does.
 */
const ESTIMATED_USAGE_YELLOW_GAP_PCT = 5;

export interface UseAgentUsageListenerDeps {
	batchedUpdater: BatchedUpdater;
	contextWarningYellowThreshold: number;
}

export function useAgentUsageListener(deps: UseAgentUsageListenerDeps): void {
	const ownedGate = useOwnedSessionGate();
	useEffect(() => {
		const getSessions = () => useSessionStore.getState().sessions;

		const unsubscribe = window.maestro.process.onUsage((sessionId: string, usageStats) => {
			// Window scoping: ignore agents this window doesn't own (broadcast events).
			if (!ownedGate.current?.(sessionId)) return;
			const parsed = parseSessionId(sessionId);
			const { actualSessionId, tabId, baseSessionId } = parsed;

			const sessionForUsage = getSessions().find((s) => s.id === baseSessionId);
			if (!sessionForUsage) return;

			const agentToolType = sessionForUsage.toolType;
			// Per-session SSH config wins over the legacy session-wide field;
			// pass the remote UUID so the snapshot lookup hits the correct
			// `agentId:remoteId` key instead of falling back to local.
			const sessionRemoteId = sessionForUsage.sessionSshRemoteConfig?.enabled
				? (sessionForUsage.sessionSshRemoteConfig.remoteId ?? undefined)
				: sessionForUsage.sshRemoteId;
			// Prefer the absolute occupancy snapshot whenever the provider attached
			// one. The top-level fields are NOT occupancy for every provider: Codex
			// sends per-turn deltas of a cumulative total, and claude-code's result
			// message sums every internal API call of the turn, so a tool-heavy turn
			// can exceed the window and drop this estimate into the null fallback
			// below - which is what pinned the gauge at 0% (finding Q1). The snapshot
			// is real occupancy in both cases, and the Context Timeline already plots
			// from it, so reading the same source here keeps the gauge and the
			// timeline from disagreeing.
			//
			// The snapshot carries no window of its own, so hand the event's reported
			// window across with it; estimateContextUsage falls back to the capability
			// snapshot and the static table when that is 0, exactly as it does for the
			// top-level stats.
			const occupancyStats = usageStats.absoluteUsage
				? { ...usageStats.absoluteUsage, contextWindow: usageStats.contextWindow }
				: usageStats;

			// Resolve the effective context window ONCE, shared by the timeline point
			// and the accumulated-growth fallback so they can never disagree.
			//
			// Precedence (finding P1). Ranks 1-3 and 5 are POSITIONALLY IDENTICAL to
			// useContextWindow's, or the header gauge and the Context Timeline
			// disagree again (the bug PR #1221 fixed). Ranks 4 and 6 are
			// timeline-only extras and sit below the shared ranks:
			//   1. `[1m]` model marker
			//   2. resolved reported window
			//   3. `customContextWindow` override
			//   4. cached provider-configured window (timeline-only)
			//   5. raw reported window
			//   6. static per-agent table (timeline-only)
			//
			// The provider-config source lives behind an async `getConfig` call that
			// must NOT run on this hot per-turn path, so we read it from a synchronous
			// cache and prime that cache off-path for the next turn. It closes the gap
			// for agents (e.g. OpenCode) whose window is configured at the provider
			// level only and would otherwise plot against the static table.
			ensureConfiguredContextWindowCached(sessionForUsage);
			// A `[1m]` marker on the session's custom model is an explicit model choice
			// the user made per-session, so it stays at the top.
			const modelMarker = getModelContextWindowOverride(sessionForUsage.customModel) || 0;
			// A genuinely provider-resolved window (flagged via `contextWindowResolved`,
			// set only where the value came from the provider's own payload) is runtime
			// truth, so it outranks the stored override below.
			const resolvedReportedWindow =
				usageStats.contextWindowResolved && usageStats.contextWindow > 0
					? usageStats.contextWindow
					: 0;
			// `customContextWindow` is NOT reliably something the user chose: the agent
			// definition's `contextWindow` default is materialized into every new session
			// at creation time (see P1), which is how a fresh omp agent plotted against
			// 200k instead of the provider's real 1M. Treat it as a fallback that applies
			// until the provider reports an authoritative window.
			const sessionOverride =
				typeof sessionForUsage.customContextWindow === 'number' &&
				sessionForUsage.customContextWindow > 0
					? sessionForUsage.customContextWindow
					: 0;
			const cachedConfiguredWindow = getCachedConfiguredContextWindow(sessionForUsage);
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
												useAgentStore
													.getState()
													.getCapabilitySnapshot(agentToolType, sessionRemoteId)
											)
										: 0;

			// Gauge percentage, computed AFTER `resolvedWindow` so it divides by the
			// same denominator the timeline point stores. Computing it earlier used
			// the event's reported window, so a session with a configured or
			// model-marker window could update the gauge against one denominator
			// while the timeline recorded another - the exact gauge/timeline
			// disagreement PR #1221 fixed. `estimateContextUsage` prefers
			// `stats.contextWindow` when it is positive and otherwise falls back to
			// the capability snapshot and the static table, so handing it
			// `resolvedWindow` makes the precedence identical on both surfaces.
			const contextPercentage = estimateContextUsage(
				resolvedWindow > 0 ? { ...occupancyStats, contextWindow: resolvedWindow } : occupancyStats,
				agentToolType,
				sessionRemoteId
			);

			// A context-window correction (omp's catalog primed after the first turn's
			// fallback usage already emitted) replays an already-counted turn purely to
			// fix the window. The batched updater applies it as window-only, but the
			// per-turn side effects below (timeline point, cycle tokens) would still
			// double-count, so they are skipped for corrections. The gauge percentage is
			// still recomputed so the corrected window resizes the fill.
			const isContextWindowCorrection = usageStats.contextWindowCorrectionOnly === true;

			deps.batchedUpdater.updateUsage(actualSessionId, tabId, usageStats);
			deps.batchedUpdater.updateUsage(actualSessionId, null, usageStats);

			// Record a turn-by-turn point for the Context Timeline inspector. This
			// reuses the same per-turn stream every provider already feeds, so the
			// timeline is provider-agnostic with no per-agent code. Keyed by the base
			// (agent) session id so a session's parallel tabs share one timeline.
			//
			// Three kinds of events are deliberately NOT recorded (see the guards below):
			//  1. Synthetic runs (synopsis / Auto Run batch) map to the parent
			//     baseSessionId but consume a SEPARATE process context - recording
			//     them would pollute the visible agent's timeline with hidden work.
			//     The visible usage gauge already ignores them (it keys off
			//     actualSessionId), so the timeline matches it by only recording
			//     interactive runs.
			//  2. Output-only deltas (Copilot streams these between context
			//     snapshots: outputTokens only, zero input/cache). Recording one
			//     would dip the timeline to just the latest output tokens. Mirror
			//     the snapshot-preserving guard in useBatchedSessionUpdates.
			const isInteractiveRun =
				parsed.type === 'ai-tab' || parsed.type === 'legacy-ai' || parsed.type === 'regular';
			// Output-only deltas are skipped ONLY when there is no absolute snapshot:
			// a Codex output-only turn still carries an `absoluteUsage` reflecting
			// real context growth, so it must be recorded.
			const isOutputOnlyDelta =
				!usageStats.absoluteUsage &&
				usageStats.inputTokens === 0 &&
				(usageStats.cacheReadInputTokens || 0) === 0 &&
				(usageStats.cacheCreationInputTokens || 0) === 0 &&
				usageStats.outputTokens > 0;
			// No-activity repeats: Codex emits a usage update for BOTH the token_count
			// event and the turn.completed message; the second carries identical
			// cumulative totals, so normalizeUsageToDelta yields an all-zero delta
			// (with an absoluteUsage snapshot). Recording it would add a duplicate row
			// with no token activity and a repeated context point.
			const hasNoTurnActivity =
				usageStats.inputTokens === 0 &&
				(usageStats.cacheReadInputTokens || 0) === 0 &&
				(usageStats.cacheCreationInputTokens || 0) === 0 &&
				usageStats.outputTokens === 0 &&
				(usageStats.reasoningTokens || 0) === 0;
			if (
				isInteractiveRun &&
				!isOutputOnlyDelta &&
				!hasNoTurnActivity &&
				!isContextWindowCorrection
			) {
				// `occupancyStats` (resolved above) is the absolute snapshot when the
				// provider attached one - the pre-normalization running total for
				// Codex, whose deltas would make a long run look low and flat, and the
				// last internal call's usage for claude-code, whose summed turn totals
				// are token spend rather than window fill. Providers whose per-turn
				// stats are already absolute (Copilot, OpenCode) fall through to those.
				// The per-turn token fields recorded on the point below are
				// intentionally left as the deltas (this turn's activity); only the
				// context-fill figures use the absolute source.
				// Same source the gauge estimate above reads, so the two can never
				// disagree about how full the window is.
				const contextTokens = calculateContextTokens(occupancyStats, agentToolType);
				// Percentage against the SAME (configured-aware) window the point
				// stores, so the row is internally consistent and matches the header.
				// null when tokens exceed the window (accumulated multi-tool turn) -
				// the panel renders that as "~" plus an accumulated flag.
				const pointPercentage =
					resolvedWindow > 0 && contextTokens <= resolvedWindow
						? Math.round((contextTokens / resolvedWindow) * 100)
						: null;
				useContextTimelineStore.getState().appendPoint(baseSessionId, {
					tabId,
					inputTokens: usageStats.inputTokens,
					outputTokens: usageStats.outputTokens,
					cacheReadInputTokens: usageStats.cacheReadInputTokens || 0,
					cacheCreationInputTokens: usageStats.cacheCreationInputTokens || 0,
					reasoningTokens: usageStats.reasoningTokens || 0,
					totalCostUsd: usageStats.totalCostUsd || 0,
					contextTokens,
					contextWindow: resolvedWindow,
					percentage: pointPercentage,
				});
			}

			if (contextPercentage !== null) {
				deps.batchedUpdater.updateContextUsage(actualSessionId, contextPercentage);
			} else {
				const currentUsage = sessionForUsage.contextUsage ?? 0;
				if (currentUsage > 0) {
					const estimated = estimateAccumulatedGrowth(
						currentUsage,
						usageStats.outputTokens,
						usageStats.cacheReadInputTokens || 0,
						resolvedWindow
					);
					const yellowThreshold = deps.contextWarningYellowThreshold;
					const maxEstimate = yellowThreshold - ESTIMATED_USAGE_YELLOW_GAP_PCT;
					deps.batchedUpdater.updateContextUsage(actualSessionId, Math.min(estimated, maxEstimate));
				} else if (usageStats.absoluteUsage && resolvedWindow > 0) {
					// Bootstrap the baseline (finding Q1, D1). The growth estimate above
					// needs a previous value to grow FROM, so a session whose very first
					// turn already overflows never establishes one and the gauge stays
					// pinned at 0% for the life of the session. An occupancy snapshot is
					// real within-window data, so seed the baseline from it directly.
					// This branch also rescues the case where the estimate above could
					// not resolve a window on its own but this hook could - a per-agent
					// custom window, a `[1m]` model marker, or the cached provider
					// window - since `resolvedWindow` sees all three.
					//
					// Deliberately NOT capped to `maxEstimate`: that cap exists so an
					// EXTRAPOLATED value cannot trip the yellow warning by itself. A
					// snapshot is a measurement, so it is allowed to.
					const snapshotTokens = calculateContextTokens(usageStats.absoluteUsage, agentToolType);
					if (snapshotTokens > 0 && snapshotTokens <= resolvedWindow) {
						deps.batchedUpdater.updateContextUsage(
							actualSessionId,
							Math.round((snapshotTokens / resolvedWindow) * 100)
						);
					}
				}
			}
			if (!isContextWindowCorrection) {
				deps.batchedUpdater.updateCycleTokens(actualSessionId, usageStats.outputTokens);
			}
		});

		return () => {
			unsubscribe();
		};
	}, [deps.batchedUpdater, deps.contextWarningYellowThreshold, ownedGate]);
}
