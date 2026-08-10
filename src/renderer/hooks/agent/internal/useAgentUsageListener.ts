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
import { buildContextTimelinePoint } from './contextTimelinePoint';
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
			// ONE shared derivation of the window precedence, the occupancy source
			// and the four skip guards (finding S1). Hydration replays main's raw
			// captures through this exact function, so a restored timeline and a
			// live one cannot drift.
			const built = buildContextTimelinePoint(parsed, usageStats, sessionForUsage);
			const { resolvedWindow, occupancyStats, sessionRemoteId, isContextWindowCorrection } = built;

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

			deps.batchedUpdater.updateUsage(actualSessionId, tabId, usageStats);
			deps.batchedUpdater.updateUsage(actualSessionId, null, usageStats);

			// Record a turn-by-turn point for the Context Timeline inspector. This
			// reuses the same per-turn stream every provider already feeds, so the
			// timeline is provider-agnostic with no per-agent code. Keyed by the base
			// (agent) session id so a session's parallel tabs share one timeline.
			// `built.point` is null when one of the four skip guards fired; those
			// guards, and the reasons for each, now live in buildContextTimelinePoint.
			if (built.point) {
				useContextTimelineStore.getState().appendPoint(baseSessionId, built.point);
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
