/**
 * useAgentUsageListener — registers `window.maestro.process.onUsage`
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
import { getContextWindowForAgent } from '../../../../shared/agentConstants';
import { useAgentStore } from '../../../stores/agentStore';
import { useOwnedSessionGate } from './useOwnedSessionGate';
import { useContextTimelineStore } from '../../../stores/contextTimelineStore';
import type { BatchedUpdater } from './types';

/**
 * When the agent doesn't report a contextPercentage and we have to estimate,
 * keep the estimate this many percentage points below the configured yellow
 * warning threshold so an extrapolated value never trips the warning UI on
 * its own — the user sees yellow only when the agent's reported usage
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
			const contextPercentage = estimateContextUsage(usageStats, agentToolType, sessionRemoteId);

			// Resolve the effective context window ONCE (live stats > capability
			// snapshot > static table; terminal has no window). Shared by the
			// Context Timeline point and the accumulated-growth fallback below, so
			// the two can never disagree on the denominator.
			const resolvedWindow =
				usageStats.contextWindow > 0
					? usageStats.contextWindow
					: agentToolType && agentToolType !== 'terminal'
						? getContextWindowForAgent(
								agentToolType,
								useAgentStore.getState().getCapabilitySnapshot(agentToolType, sessionRemoteId)
							)
						: 0;

			deps.batchedUpdater.updateUsage(actualSessionId, tabId, usageStats);
			deps.batchedUpdater.updateUsage(actualSessionId, null, usageStats);

			// Record a turn-by-turn point for the Context Timeline inspector. This
			// reuses the same per-turn stream every provider already feeds, so the
			// timeline is provider-agnostic with no per-agent code. Keyed by the base
			// (agent) session id so a session's parallel tabs share one timeline.
			const contextTokens = calculateContextTokens(usageStats, agentToolType);
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
				percentage: contextPercentage,
			});

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
				}
			}
			deps.batchedUpdater.updateCycleTokens(actualSessionId, usageStats.outputTokens);
		});

		return () => {
			unsubscribe();
		};
	}, [deps.batchedUpdater, deps.contextWarningYellowThreshold, ownedGate]);
}
