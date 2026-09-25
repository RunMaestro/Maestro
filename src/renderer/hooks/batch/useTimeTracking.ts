/**
 * useTimeTracking - sleep-aware elapsed time for an Auto Run.
 *
 * Measures how long a run actually ran. Two spans are subtracted, because in
 * both the agent really does stop: the machine being asleep, and the run being
 * paused (an agent error or a HITL gate waiting on the user). Nothing else is.
 *
 * ## Why the window being hidden is NOT subtracted
 *
 * This hook used to pause on `visibilitychange` as well, on the theory that it
 * was measuring "active processing time". It was not. The agent is a separate
 * process: it keeps working whether or not the Maestro window is on screen, and
 * in Electron on macOS `document.hidden` goes true when the window is merely
 * minimized or fully covered by another app. So the clock stopped whenever the
 * user looked at something else, which on a long unattended run is nearly all
 * of it.
 *
 * That quantity is the USER'S ATTENTION, and it was being recorded as the
 * AGENT'S RUNTIME - into `auto_run_sessions.duration` (the Usage Dashboard's
 * "Longest Auto Runs" table) and into the leaderboard delta submitted at
 * completion. Measured on one real database: a run whose own task timestamps
 * span 22h 10m was recorded as 6h 52m, twenty-one runs recorded exactly zero,
 * and 71 hours went missing in total. The runs that read correctly were the
 * ones the user happened to sit and watch, which is precisely backwards - an
 * unattended overnight run is the one whose duration matters most.
 *
 * Note the badge/leaderboard tick in `useAutoRunAchievements` never had this
 * bug: it accrues on a 60s `sleepAwareElapsedMs` interval with no visibility
 * gate. That is why the local Conductor badge could show a 22h run that the
 * dashboard table had no row for.
 *
 * Sleep still needs its own signal: a system suspend never fires
 * `visibilitychange` (the window stays "visible" while the whole process is
 * frozen), so the gap comes from the main process via `systemSleep`.
 *
 * Features:
 * - Per-session time tracking
 * - Machine sleep subtracted from any session that was counting through it
 * - Pause/resume while an Auto Run waits on the user
 * - Proper cleanup on unmount
 */

import { useRef, useEffect, useCallback } from 'react';
import { onSystemSleep, sleepAwareElapsedSince } from '../../services/systemSleep';
import type { BatchRunState } from '../../types';

/**
 * Live active elapsed time of an Auto Run, for displays. Reads the tracker's
 * mirror in `BatchRunState`: closed spans plus the live one, so the clock
 * stops while the run is paused (`lastActiveTimestamp` cleared). Sleep is
 * already out of both fields - the tracker walks the live span's start past
 * it - so the live span is plain wall clock.
 *
 * Falls back to sleep-aware time since `startTime` for a state that carries
 * no tracker fields (a snapshot from an older build).
 */
export function autoRunActiveElapsedMs(
	state: Pick<BatchRunState, 'startTime' | 'accumulatedElapsedMs' | 'lastActiveTimestamp'>,
	now: number = Date.now()
): number {
	const { startTime, accumulatedElapsedMs, lastActiveTimestamp } = state;
	if (accumulatedElapsedMs === undefined && lastActiveTimestamp === undefined) {
		return startTime ? sleepAwareElapsedSince(startTime) : 0;
	}
	const live = lastActiveTimestamp !== undefined ? Math.max(0, now - lastActiveTimestamp) : 0;
	return (accumulatedElapsedMs ?? 0) + live;
}

/**
 * Configuration options for the time tracking hook
 */
export interface UseTimeTrackingOptions {
	/**
	 * Callback to get the list of currently active session IDs
	 * Used by the visibility change handler to know which sessions to update
	 */
	getActiveSessionIds: () => string[];

	/**
	 * Optional callback when time is updated for a session
	 * Called with session ID, accumulated time (ms), and current timestamp (or null if paused)
	 */
	onTimeUpdate?: (sessionId: string, accumulatedMs: number, activeTimestamp: number | null) => void;
}

/**
 * Return type for the useTimeTracking hook
 */
export interface UseTimeTrackingReturn {
	/**
	 * Start tracking time for a session
	 * @param sessionId - The session to start tracking
	 * @returns The start timestamp
	 */
	startTracking: (sessionId: string) => number;

	/**
	 * Stop tracking time for a session
	 * @param sessionId - The session to stop tracking
	 * @returns The final elapsed time in milliseconds
	 */
	stopTracking: (sessionId: string) => number;

	/**
	 * Stop the clock while the run waits on the user (error or HITL gate).
	 * Idempotent: the runner re-pauses on every iteration that re-detects a gate.
	 * @param sessionId - The session to pause
	 */
	pauseTracking: (sessionId: string) => void;

	/**
	 * Restart the clock when the user resumes or skips past a pause. No-op when
	 * the session is not paused.
	 * @param sessionId - The session to resume
	 */
	resumeTracking: (sessionId: string) => void;

	/**
	 * Get the current elapsed time for a session
	 * @param sessionId - The session to get elapsed time for
	 * @returns The elapsed time in milliseconds (excluding hidden time)
	 */
	getElapsedTime: (sessionId: string) => number;

	/**
	 * Get the accumulated time ref value for a session (for state updates)
	 * @param sessionId - The session to get accumulated time for
	 * @returns The accumulated time in milliseconds
	 */
	getAccumulatedTime: (sessionId: string) => number;

	/**
	 * Get the last active timestamp for a session (for state updates)
	 * @param sessionId - The session to get timestamp for
	 * @returns The timestamp or null if paused/stopped
	 */
	getLastActiveTimestamp: (sessionId: string) => number | null;

	/**
	 * Check if a session is currently being tracked
	 * @param sessionId - The session to check
	 * @returns True if the session is being tracked
	 */
	isTracking: (sessionId: string) => boolean;
}

/**
 * Hook for sleep-aware time tracking keyed by session ID.
 *
 * Time tracking behavior:
 * - When startTracking is called, the current timestamp is recorded
 * - Time accumulates for as long as the run is tracked, whether or not the
 *   Maestro window is on screen - see the note at the top of this file
 * - A machine sleep is subtracted by walking the active timestamp forward
 * - pauseTracking folds the live span into the accumulator and clears the
 *   active timestamp; resumeTracking starts a new live span
 * - When stopTracking is called, the final accumulated time is returned
 *
 * Every change is reported through `onTimeUpdate`, which mirrors it into
 * `BatchRunState.accumulatedElapsedMs` / `lastActiveTimestamp`. The elapsed
 * displays read those two fields (`autoRunActiveElapsedMs`), so a paused run's
 * clock stops on screen too.
 *
 * Memory safety guarantees:
 * - Sleep subscription is removed on unmount
 * - Session tracking data is cleaned up when stopTracking is called
 */
export function useTimeTracking(options: UseTimeTrackingOptions): UseTimeTrackingReturn {
	const { getActiveSessionIds, onTimeUpdate } = options;

	// Store references to callbacks to avoid re-registering the visibility listener
	const getActiveSessionIdsRef = useRef(getActiveSessionIds);
	getActiveSessionIdsRef.current = getActiveSessionIds;

	const onTimeUpdateRef = useRef(onTimeUpdate);
	onTimeUpdateRef.current = onTimeUpdate;

	// Track accumulated time per session (closed spans, excluding pauses and sleep)
	const accumulatedTimeRefs = useRef<Record<string, number>>({});

	// Track the last timestamp when we started counting (null while paused or not tracking)
	const lastActiveTimestampRefs = useRef<Record<string, number | null>>({});

	// Track which sessions are being tracked
	const trackingSessionsRef = useRef<Set<string>>(new Set());

	// Machine sleep: discard the slept span from every session that was counting
	// through it by walking its active timestamp forward.
	useEffect(() => {
		return onSystemSleep((sleptMs) => {
			const now = Date.now();

			for (const sessionId of trackingSessionsRef.current) {
				const lastActive = lastActiveTimestampRefs.current[sessionId];
				// No live span to correct (a session mid-teardown). Nothing to do.
				if (lastActive === null || lastActive === undefined) continue;

				// Clamp to the live span so we can never subtract more sleep than
				// this session was actually counting - a session that started after
				// the machine went to sleep must not have the whole gap taken off it.
				const skipMs = Math.min(sleptMs, Math.max(0, now - lastActive));
				if (skipMs <= 0) continue;
				lastActiveTimestampRefs.current[sessionId] = lastActive + skipMs;

				if (onTimeUpdateRef.current) {
					onTimeUpdateRef.current(
						sessionId,
						accumulatedTimeRefs.current[sessionId] || 0,
						lastActiveTimestampRefs.current[sessionId] ?? null
					);
				}
			}
		});
	}, []);

	/**
	 * Start tracking time for a session
	 */
	const startTracking = useCallback((sessionId: string): number => {
		const now = Date.now();

		// Initialize tracking for this session. Unconditionally counting from now:
		// a run launched from a background window (a CLI dispatch, a Cue trigger,
		// a second monitor the user is not looking at) is running, and starting it
		// at `null` used to leave it that way with nothing to un-pause it.
		accumulatedTimeRefs.current[sessionId] = 0;
		lastActiveTimestampRefs.current[sessionId] = now;
		trackingSessionsRef.current.add(sessionId);

		return now;
	}, []);

	/**
	 * Stop tracking time for a session and return final elapsed time
	 */
	const stopTracking = useCallback((sessionId: string): number => {
		const accumulated = accumulatedTimeRefs.current[sessionId] || 0;
		const lastActive = lastActiveTimestampRefs.current[sessionId];

		// Calculate final elapsed time. The live span counts regardless of window
		// visibility - a run that finishes while the user is in another app has
		// still been running, and gating this is what recorded whole runs as zero.
		let finalElapsed = accumulated;
		if (lastActive !== null && lastActive !== undefined) {
			finalElapsed += Date.now() - lastActive;
		}

		// Clean up tracking data for this session
		delete accumulatedTimeRefs.current[sessionId];
		delete lastActiveTimestampRefs.current[sessionId];
		trackingSessionsRef.current.delete(sessionId);

		return finalElapsed;
	}, []);

	/**
	 * Pause a session's clock: fold the live span into the accumulator.
	 */
	const pauseTracking = useCallback((sessionId: string): void => {
		if (!trackingSessionsRef.current.has(sessionId)) return;
		const lastActive = lastActiveTimestampRefs.current[sessionId];
		if (lastActive === null || lastActive === undefined) return;

		const accumulated =
			(accumulatedTimeRefs.current[sessionId] || 0) + Math.max(0, Date.now() - lastActive);
		accumulatedTimeRefs.current[sessionId] = accumulated;
		lastActiveTimestampRefs.current[sessionId] = null;
		onTimeUpdateRef.current?.(sessionId, accumulated, null);
	}, []);

	/**
	 * Resume a paused session's clock from now.
	 */
	const resumeTracking = useCallback((sessionId: string): void => {
		if (!trackingSessionsRef.current.has(sessionId)) return;
		if (lastActiveTimestampRefs.current[sessionId] != null) return;

		const now = Date.now();
		lastActiveTimestampRefs.current[sessionId] = now;
		onTimeUpdateRef.current?.(sessionId, accumulatedTimeRefs.current[sessionId] || 0, now);
	}, []);

	/**
	 * Get the current elapsed time for a session (without stopping)
	 */
	const getElapsedTime = useCallback((sessionId: string): number => {
		const accumulated = accumulatedTimeRefs.current[sessionId] || 0;
		const lastActive = lastActiveTimestampRefs.current[sessionId];

		// Add the live span since the last active timestamp. Not gated on window
		// visibility: see stopTracking above and the note at the top of the file.
		if (lastActive !== null && lastActive !== undefined) {
			return accumulated + (Date.now() - lastActive);
		}

		return accumulated;
	}, []);

	/**
	 * Get the accumulated time (for state updates)
	 */
	const getAccumulatedTime = useCallback((sessionId: string): number => {
		return accumulatedTimeRefs.current[sessionId] || 0;
	}, []);

	/**
	 * Get the last active timestamp (for state updates)
	 */
	const getLastActiveTimestamp = useCallback((sessionId: string): number | null => {
		return lastActiveTimestampRefs.current[sessionId] ?? null;
	}, []);

	/**
	 * Check if a session is currently being tracked
	 */
	const isTracking = useCallback((sessionId: string): boolean => {
		return trackingSessionsRef.current.has(sessionId);
	}, []);

	return {
		startTracking,
		stopTracking,
		pauseTracking,
		resumeTracking,
		getElapsedTime,
		getAccumulatedTime,
		getLastActiveTimestamp,
		isTracking,
	};
}
