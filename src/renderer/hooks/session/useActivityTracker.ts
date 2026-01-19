import { useEffect, useRef, useCallback } from 'react';
import type { Session } from '../../types';

const ACTIVITY_TIMEOUT_MS = 60000; // 1 minute of inactivity = idle
const TICK_INTERVAL_MS = 1000; // Update every second
const BATCH_UPDATE_INTERVAL_MS = 30000; // Batch updates every 30 seconds to reduce re-renders

export interface UseActivityTrackerReturn {
	onActivity: () => void; // Call this when user activity is detected
}

/**
 * Hook to track user activity and update session's activeTimeMs.
 * When the user is active (touched keyboard/mouse in the last minute),
 * time is added to the active session.
 *
 * Note: To avoid causing re-renders every second (which can reset scroll positions
 * in virtualized lists), we accumulate time locally and only batch-update the
 * session state every 30 seconds.
 *
 * CPU optimization: The interval stops after 60s of inactivity and restarts
 * when user activity is detected. This means zero CPU usage when truly idle.
 */
export function useActivityTracker(
	activeSessionId: string | null,
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>
): UseActivityTrackerReturn {
	const lastActivityRef = useRef<number>(Date.now());
	const isActiveRef = useRef<boolean>(false);
	const accumulatedTimeRef = useRef<number>(0);
	const lastBatchUpdateRef = useRef<number>(Date.now());
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const setSessionsRef = useRef(setSessions);
	const activeSessionIdRef = useRef(activeSessionId);

	// Keep refs in sync
	setSessionsRef.current = setSessions;
	activeSessionIdRef.current = activeSessionId;

	const startInterval = useCallback(() => {
		if (!intervalRef.current && !document.hidden) {
			intervalRef.current = setInterval(() => {
				const now = Date.now();
				const timeSinceLastActivity = now - lastActivityRef.current;

				// Check if still active (activity within the last minute)
				if (timeSinceLastActivity < ACTIVITY_TIMEOUT_MS && isActiveRef.current) {
					// Accumulate time locally instead of updating state every second
					accumulatedTimeRef.current += TICK_INTERVAL_MS;

					// Only batch-update state every 30 seconds to avoid causing re-renders
					const timeSinceLastBatchUpdate = now - lastBatchUpdateRef.current;
					if (timeSinceLastBatchUpdate >= BATCH_UPDATE_INTERVAL_MS && activeSessionIdRef.current) {
						const accumulatedTime = accumulatedTimeRef.current;
						accumulatedTimeRef.current = 0;
						lastBatchUpdateRef.current = now;

						setSessionsRef.current((prev) =>
							prev.map((session) => {
								if (session.id === activeSessionIdRef.current) {
									return {
										...session,
										activeTimeMs: (session.activeTimeMs || 0) + accumulatedTime,
									};
								}
								return session;
							})
						);
					}
				} else {
					// Mark as inactive and stop the interval to save CPU
					isActiveRef.current = false;
					if (intervalRef.current) {
						clearInterval(intervalRef.current);
						intervalRef.current = null;
					}
				}
			}, TICK_INTERVAL_MS);
		}
	}, []);

	const stopInterval = useCallback(() => {
		if (intervalRef.current) {
			clearInterval(intervalRef.current);
			intervalRef.current = null;
		}
	}, []);

	// Handle visibility changes
	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.hidden) {
				stopInterval();
			} else if (isActiveRef.current) {
				// Only restart if user was active
				startInterval();
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, [startInterval, stopInterval]);

	// Cleanup on unmount or session change
	useEffect(() => {
		// Capture the current session ID for cleanup
		const sessionIdAtMount = activeSessionId;

		return () => {
			stopInterval();
			// Flush any accumulated time when effect cleans up (e.g., session change)
			if (accumulatedTimeRef.current > 0 && sessionIdAtMount) {
				const accumulatedTime = accumulatedTimeRef.current;
				accumulatedTimeRef.current = 0;
				setSessionsRef.current((prev) =>
					prev.map((session) => {
						if (session.id === sessionIdAtMount) {
							return {
								...session,
								activeTimeMs: (session.activeTimeMs || 0) + accumulatedTime,
							};
						}
						return session;
					})
				);
			}
		};
	}, [activeSessionId, stopInterval]);

	// Mark activity occurred and restart interval if needed
	const onActivity = useCallback(() => {
		lastActivityRef.current = Date.now();
		const wasInactive = !isActiveRef.current;
		isActiveRef.current = true;

		// Restart interval if it was stopped due to inactivity
		if (wasInactive) {
			startInterval();
		}
	}, [startInterval]);

	// Listen to global activity events
	useEffect(() => {
		const handleActivity = () => {
			lastActivityRef.current = Date.now();
			const wasInactive = !isActiveRef.current;
			isActiveRef.current = true;

			// Restart interval if it was stopped due to inactivity
			if (wasInactive) {
				startInterval();
			}
		};

		// Listen for various user interactions
		// Note: mousemove is intentionally excluded - it fires hundreds of times per second
		// and would cause excessive CPU usage. mousedown/keydown are sufficient for activity detection.
		window.addEventListener('keydown', handleActivity);
		window.addEventListener('mousedown', handleActivity);
		window.addEventListener('wheel', handleActivity);
		window.addEventListener('touchstart', handleActivity);

		return () => {
			window.removeEventListener('keydown', handleActivity);
			window.removeEventListener('mousedown', handleActivity);
			window.removeEventListener('wheel', handleActivity);
			window.removeEventListener('touchstart', handleActivity);
		};
	}, [startInterval]);

	return { onActivity };
}
