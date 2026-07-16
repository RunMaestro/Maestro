/**
 * useAutoRunAchievements — extracted from App.tsx
 *
 * Tracks elapsed time for active auto-runs and updates achievement stats:
 *   - 60-second interval progress tracker for active batch sessions
 *   - Badge unlock triggers standing ovation overlay
 *   - Peak usage stats tracker (max agents, concurrent queries, queue depth)
 *
 * Reads from: sessionStore (usagePeaksKey via sessions), settingsStore (autoRunStats, usageStats),
 *             batchStore (activeBatchSessionIds), modalStore (setStandingOvationData)
 *
 * PERF: Does not subscribe to full sessions[]. Peak-stats use a narrow count signature;
 * streaming log/token flushes must not wake App via this hook.
 */

import { useEffect, useRef } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getModalActions } from '../../stores/modalStore';
import { CONDUCTOR_BADGES } from '../../constants/conductorBadges';
import { cueService } from '../../services/cue';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseAutoRunAchievementsDeps {
	/** IDs of sessions with active batch runs */
	activeBatchSessionIds: string[];
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useAutoRunAchievements(deps: UseAutoRunAchievementsDeps): void {
	const { activeBatchSessionIds } = deps;

	// PERF: Peak-stats signature only - do not subscribe to full sessions[]. Streaming
	// log/token flushes must not wake App; re-run when agent/busy/queue counts shift.
	const usagePeaksKey = useSessionStore((s) => {
		let nonTerminal = 0;
		let busy = 0;
		let queueDepth = 0;
		for (const sess of s.sessions) {
			if (sess.toolType !== 'terminal') nonTerminal++;
			if (sess.state === 'busy') busy++;
			queueDepth += sess.executionQueue?.length || 0;
		}
		return `${nonTerminal}|${busy}|${queueDepth}`;
	});

	// --- Store actions (stable via getState) ---
	const { updateAutoRunProgress, updateUsageStats } = useSettingsStore.getState();
	const { setStandingOvationData } = getModalActions();

	// --- Refs ---
	const autoRunProgressRef = useRef<{ lastUpdateTime: number }>({
		lastUpdateTime: 0,
	});

	// Credit a block of achievement time and raise the standing ovation if it
	// crosses a badge threshold. Shared by the Auto Run timer below and the Cue
	// credit subscription so both paths accrue through the identical
	// updateAutoRunProgress flow. The local badge and the leaderboard both read
	// cumulativeTimeMs, so there is a single source of truth and no drift.
	const creditAchievementTime = (deltaMs: number): void => {
		if (deltaMs <= 0) return;
		const autoRunStats = useSettingsStore.getState().autoRunStats;
		const { newBadgeLevel } = updateAutoRunProgress(deltaMs);
		if (newBadgeLevel !== null) {
			const badge = CONDUCTOR_BADGES.find((b) => b.level === newBadgeLevel);
			if (badge) {
				setStandingOvationData({
					badge,
					isNewRecord: false, // Record is determined at completion
					recordTimeMs: autoRunStats.longestRunMs,
				});
			}
		}
	};

	// Track elapsed time for active auto-runs and update achievement stats every minute
	// This allows badges to be unlocked during an auto-run, not just when it completes
	useEffect(() => {
		// Only set up timer if there are active batch runs
		if (activeBatchSessionIds.length === 0) {
			autoRunProgressRef.current.lastUpdateTime = 0;
			return;
		}

		// Initialize last update time on first active run
		if (autoRunProgressRef.current.lastUpdateTime === 0) {
			autoRunProgressRef.current.lastUpdateTime = Date.now();
		}

		// Set up interval to update progress every minute
		const intervalId = setInterval(() => {
			const now = Date.now();
			const elapsedMs = now - autoRunProgressRef.current.lastUpdateTime;
			autoRunProgressRef.current.lastUpdateTime = now;

			// Multiply by number of concurrent sessions so each active Auto Run contributes its time
			// e.g., 2 sessions running for 1 minute = 2 minutes toward cumulative achievement time
			const deltaMs = elapsedMs * activeBatchSessionIds.length;

			// Update achievement stats with the delta (raises ovation on badge unlock)
			creditAchievementTime(deltaMs);
		}, 60000); // Every 60 seconds

		return () => {
			clearInterval(intervalId);
		};
	}, [activeBatchSessionIds.length]);

	// Credit autonomous Cue AI time toward the Conductor level. The main-process
	// Cue engine emits `conductorTimeCredit` once per naturally-completed agent
	// run, already gated (no command nodes) and floored to whole minutes, so the
	// renderer simply accrues it through the same path as Auto Run. This effect
	// is always mounted; Cue runs regardless of whether any Auto Run is active.
	useEffect(() => {
		const unsubscribe = cueService.onActivityUpdate((payload) => {
			if (payload?.type === 'conductorTimeCredit') {
				creditAchievementTime(payload.creditMs);
			}
		});
		return unsubscribe;
	}, []);

	// Track peak usage stats for achievements image
	useEffect(() => {
		const sessions = useSessionStore.getState().sessions;

		// Count current active agents (non-terminal sessions)
		const activeAgents = sessions.filter((s) => s.toolType !== 'terminal').length;

		// Count busy sessions (currently processing)
		const busySessions = sessions.filter((s) => s.state === 'busy').length;

		// Count auto-run sessions (sessions with active batch runs)
		const autoRunSessions = activeBatchSessionIds.length;

		// Count total queue depth across all sessions
		const totalQueueDepth = sessions.reduce((sum, s) => sum + (s.executionQueue?.length || 0), 0);

		// Update usage stats (only updates if new values are higher)
		updateUsageStats({
			maxAgents: activeAgents,
			maxDefinedAgents: activeAgents, // Same as active agents for now
			maxSimultaneousAutoRuns: autoRunSessions,
			maxSimultaneousQueries: busySessions,
			maxQueueDepth: totalQueueDepth,
		});
		// usagePeaksKey encodes the same counts read above; include it so peaks
		// refresh when agent/busy/queue shift without a full sessions[] sub.
	}, [usagePeaksKey, activeBatchSessionIds]);
}
