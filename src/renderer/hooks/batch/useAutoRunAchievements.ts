/**
 * useAutoRunAchievements — extracted from App.tsx
 *
 * Tracks elapsed time for active auto-runs and updates achievement stats:
 *   - 60-second interval progress tracker for active batch sessions
 *   - Badge unlock triggers standing ovation overlay
 *   - Peak usage stats tracker (max agents, concurrent queries, queue depth)
 *
 * Reads from: sessionStore (sessions), settingsStore (autoRunStats, usageStats),
 *             batchStore (activeBatchSessionIds), modalStore (setStandingOvationData)
 */

import { useEffect, useMemo, useRef } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useBatchStore } from '../../stores/batchStore';
import { getModalActions } from '../../stores/modalStore';
import { CONDUCTOR_BADGES } from '../../constants/conductorBadges';

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

	// --- Reactive subscriptions ---
	const sessions = useSessionStore((s) => s.sessions);
	const batchRunStates = useBatchStore((s) => s.batchRunStates);

	// Filter out error-paused sessions so they don't accumulate achievement time
	const activeNonPausedSessionIds = useMemo(
		() => activeBatchSessionIds.filter((id) => !batchRunStates[id]?.errorPaused),
		[activeBatchSessionIds, batchRunStates]
	);

	// --- Store actions (stable via getState) ---
	const { updateAutoRunProgress, updateUsageStats } = useSettingsStore.getState();
	const { setStandingOvationData } = getModalActions();

	// --- Refs ---
	const autoRunProgressRef = useRef<{ lastUpdateTime: number }>({
		lastUpdateTime: 0,
	});

	// Track elapsed time for active auto-runs and update achievement stats every minute
	// This allows badges to be unlocked during an auto-run, not just when it completes
	useEffect(() => {
		// Only set up timer if there are non-paused active batch runs
		if (activeNonPausedSessionIds.length === 0) {
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

			// Multiply by number of concurrent non-paused sessions so each active Auto Run contributes its time
			// e.g., 2 sessions running for 1 minute = 2 minutes toward cumulative achievement time
			// Error-paused sessions are excluded so they don't inflate the time
			const deltaMs = elapsedMs * activeNonPausedSessionIds.length;

			// Update achievement stats with the delta
			const autoRunStats = useSettingsStore.getState().autoRunStats;
			const { newBadgeLevel } = updateAutoRunProgress(deltaMs);

			// If a new badge was unlocked during the run, show standing ovation
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
		}, 60000); // Every 60 seconds

		return () => {
			clearInterval(intervalId);
		};
	}, [activeNonPausedSessionIds.length]);

	// Track peak usage stats for achievements image
	useEffect(() => {
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
	}, [sessions, activeBatchSessionIds]);
}
