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
import { estimateContextUsage, estimateAccumulatedGrowth } from '../../../utils/contextUsage';
import { getContextWindowForAgent } from '../../../../shared/agentConstants';
import { useAgentStore } from '../../../stores/agentStore';
import { useProcessWindowScope } from './useProcessWindowScope';
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
	const isSessionInCurrentWindow = useProcessWindowScope();

	useEffect(() => {
		const getSessions = () => useSessionStore.getState().sessions;

		const unsubscribe = window.maestro.process.onUsage((sessionId: string, usageStats) => {
			if (!isSessionInCurrentWindow(sessionId)) return;

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

			deps.batchedUpdater.updateUsage(actualSessionId, tabId, usageStats);
			deps.batchedUpdater.updateUsage(actualSessionId, null, usageStats);

			if (contextPercentage !== null) {
				deps.batchedUpdater.updateContextUsage(actualSessionId, contextPercentage);
			} else {
				const currentUsage = sessionForUsage.contextUsage ?? 0;
				if (currentUsage > 0) {
					const effectiveWindow =
						usageStats.contextWindow > 0
							? usageStats.contextWindow
							: agentToolType
								? getContextWindowForAgent(
										agentToolType,
										useAgentStore.getState().getCapabilitySnapshot(agentToolType, sessionRemoteId)
									)
								: 0;
					const estimated = estimateAccumulatedGrowth(
						currentUsage,
						usageStats.outputTokens,
						usageStats.cacheReadInputTokens || 0,
						effectiveWindow
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
	}, [deps.batchedUpdater, deps.contextWarningYellowThreshold, isSessionInCurrentWindow]);
}
