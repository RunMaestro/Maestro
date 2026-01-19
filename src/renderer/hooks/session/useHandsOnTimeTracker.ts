import { useEffect, useRef, useCallback } from 'react';

const ACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes of inactivity = idle
const TICK_INTERVAL_MS = 1000; // Update every second
const PERSIST_INTERVAL_MS = 30000; // Persist to settings every 30 seconds

/**
 * Hook to track global user hands-on time in Maestro.
 *
 * Time is tracked when the user is "active" - meaning they've interacted
 * with the app (keyboard, mouse, wheel, touch) within the last 5 minutes.
 *
 * The accumulated time is persisted to settings every 30 seconds and on
 * visibility change/app quit, ensuring no time is lost.
 *
 * This is a global tracker - it doesn't care which session is active,
 * just that the user is actively using Maestro.
 */
export function useHandsOnTimeTracker(
	updateGlobalStats: (delta: { totalActiveTimeMs: number }) => void
): void {
	const lastActivityRef = useRef<number>(Date.now());
	const isActiveRef = useRef<boolean>(false);
	const accumulatedTimeRef = useRef<number>(0);
	const lastPersistRef = useRef<number>(Date.now());
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const updateGlobalStatsRef = useRef(updateGlobalStats);

	// Keep ref in sync
	updateGlobalStatsRef.current = updateGlobalStats;

	// Persist accumulated time to settings
	const persistAccumulatedTime = useCallback(() => {
		if (accumulatedTimeRef.current > 0) {
			const timeToAdd = accumulatedTimeRef.current;
			accumulatedTimeRef.current = 0;
			lastPersistRef.current = Date.now();
			updateGlobalStatsRef.current({ totalActiveTimeMs: timeToAdd });
		}
	}, []);

	const startInterval = useCallback(() => {
		if (!intervalRef.current && !document.hidden) {
			intervalRef.current = setInterval(() => {
				const now = Date.now();
				const timeSinceLastActivity = now - lastActivityRef.current;

				// Check if still active (activity within the last 5 minutes)
				if (timeSinceLastActivity < ACTIVITY_TIMEOUT_MS && isActiveRef.current) {
					// Accumulate time
					accumulatedTimeRef.current += TICK_INTERVAL_MS;

					// Persist every 30 seconds
					const timeSinceLastPersist = now - lastPersistRef.current;
					if (timeSinceLastPersist >= PERSIST_INTERVAL_MS) {
						persistAccumulatedTime();
					}
				} else {
					// User is idle - persist any accumulated time and stop tracking
					persistAccumulatedTime();
					isActiveRef.current = false;
					if (intervalRef.current) {
						clearInterval(intervalRef.current);
						intervalRef.current = null;
					}
				}
			}, TICK_INTERVAL_MS);
		}
	}, [persistAccumulatedTime]);

	const stopInterval = useCallback(() => {
		if (intervalRef.current) {
			clearInterval(intervalRef.current);
			intervalRef.current = null;
		}
	}, []);

	// Handle visibility changes - persist and pause when hidden
	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.hidden) {
				// Persist accumulated time when user switches away
				persistAccumulatedTime();
				stopInterval();
			} else if (isActiveRef.current) {
				// Restart if user was active
				startInterval();
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, [startInterval, stopInterval, persistAccumulatedTime]);

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
		window.addEventListener('keydown', handleActivity);
		window.addEventListener('mousedown', handleActivity);
		window.addEventListener('wheel', handleActivity);
		window.addEventListener('touchstart', handleActivity);
		window.addEventListener('click', handleActivity);

		return () => {
			window.removeEventListener('keydown', handleActivity);
			window.removeEventListener('mousedown', handleActivity);
			window.removeEventListener('wheel', handleActivity);
			window.removeEventListener('touchstart', handleActivity);
			window.removeEventListener('click', handleActivity);
		};
	}, [startInterval]);

	// Persist on unmount
	useEffect(() => {
		return () => {
			stopInterval();
			persistAccumulatedTime();
		};
	}, [stopInterval, persistAccumulatedTime]);

	// Persist on beforeunload (app closing)
	useEffect(() => {
		const handleBeforeUnload = () => {
			// Synchronous - can't use async here
			if (accumulatedTimeRef.current > 0) {
				const timeToAdd = accumulatedTimeRef.current;
				accumulatedTimeRef.current = 0;
				updateGlobalStatsRef.current({ totalActiveTimeMs: timeToAdd });
			}
		};

		window.addEventListener('beforeunload', handleBeforeUnload);

		return () => {
			window.removeEventListener('beforeunload', handleBeforeUnload);
		};
	}, []);
}
