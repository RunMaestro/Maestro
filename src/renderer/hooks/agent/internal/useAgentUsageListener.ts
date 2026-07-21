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
			const contextPercentage = estimateContextUsage(usageStats, agentToolType, sessionRemoteId);

			// Resolve the effective context window ONCE, matching the header gauge's
			// precedence (resolveConfiguredContextWindow): a per-agent custom window,
			// a `[1m]` model marker, or the provider's configured window wins over the
			// reported/static window, so a session configured for e.g. 1M isn't sized
			// against a 200k denominator. Shared by the timeline point and the
			// accumulated-growth fallback so they can never disagree.
			//
			// The provider-config source lives behind an async `getConfig` call that
			// must NOT run on this hot per-turn path, so we read it from a synchronous
			// cache and prime that cache off-path for the next turn. The two sync
			// sources (per-session window, model marker) take precedence and cover the
			// common cases immediately; the cached provider window closes the gap for
			// agents (e.g. OpenCode) whose window is configured at the provider level
			// only and would otherwise plot against the static table.
			ensureConfiguredContextWindowCached(sessionForUsage);
			const syncConfiguredWindow =
				typeof sessionForUsage.customContextWindow === 'number' &&
				sessionForUsage.customContextWindow > 0
					? sessionForUsage.customContextWindow
					: getModelContextWindowOverride(sessionForUsage.customModel) || 0;
			const cachedConfiguredWindow = getCachedConfiguredContextWindow(sessionForUsage);
			// A genuinely provider/model-resolved window (currently Oh My Pi's per-turn
			// model catalog, flagged via `contextWindowResolved`) is the ACTUAL window
			// and must beat the agent-level configured FALLBACK - but never an explicit
			// per-session override or a `[1m]` model marker, both of which rank above it.
			const resolvedReportedWindow =
				usageStats.contextWindowResolved && usageStats.contextWindow > 0
					? usageStats.contextWindow
					: 0;
			const resolvedWindow =
				syncConfiguredWindow > 0
					? syncConfiguredWindow
					: resolvedReportedWindow > 0
						? resolvedReportedWindow
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
			if (isInteractiveRun && !isOutputOnlyDelta && !hasNoTurnActivity) {
				// For providers whose usage arrives as per-turn deltas of a cumulative
				// session total (Codex), the delta undercounts the context that is
				// actually occupying the window - plotting it makes a long run look
				// low and flat. `absoluteUsage` carries the pre-normalization running
				// total for exactly this case; fall back to the per-turn stats for
				// per-call providers (Claude/Copilot/OpenCode), whose values are
				// already absolute for the turn. The per-turn token fields recorded on
				// the point below are intentionally left as the deltas (this turn's
				// activity); only the context-fill figures use the absolute source.
				const contextSource = usageStats.absoluteUsage ?? usageStats;
				const contextTokens = calculateContextTokens(contextSource, agentToolType);
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
				}
			}
			deps.batchedUpdater.updateCycleTokens(actualSessionId, usageStats.outputTokens);
		});

		return () => {
			unsubscribe();
		};
	}, [deps.batchedUpdater, deps.contextWarningYellowThreshold, ownedGate]);
}
