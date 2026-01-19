/**
 * useTimeTracking - Visibility-aware time tracking hook for batch processing
 *
 * This hook provides accurate elapsed time tracking that excludes time when
 * the document is hidden (e.g., laptop sleep, tab switch). This ensures that
 * batch processing elapsed times reflect actual active processing time.
 *
 * Features:
 * - Per-session time tracking
 * - Automatic pause when document becomes hidden
 * - Automatic resume when document becomes visible
 * - Proper cleanup on unmount
 */

import { useRef, useEffect, useCallback } from 'react';

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
 * Hook for visibility-aware time tracking keyed by session ID
 *
 * Time tracking behavior:
 * - When startTracking is called, the current timestamp is recorded
 * - While document is visible, time accumulates normally
 * - When document becomes hidden, the elapsed time since last active is accumulated
 *   and the active timestamp is cleared
 * - When document becomes visible again, a new active timestamp is set
 * - When stopTracking is called, the final accumulated time is returned
 *
 * Memory safety guarantees:
 * - Visibility change listener is removed on unmount
 * - Session tracking data is cleaned up when stopTracking is called
 */
export function useTimeTracking(options: UseTimeTrackingOptions): UseTimeTrackingReturn {
	const { getActiveSessionIds, onTimeUpdate } = options;

	// Store references to callbacks to avoid re-registering the visibility listener
	const getActiveSessionIdsRef = useRef(getActiveSessionIds);
	getActiveSessionIdsRef.current = getActiveSessionIds;

	const onTimeUpdateRef = useRef(onTimeUpdate);
	onTimeUpdateRef.current = onTimeUpdate;

	// Track accumulated time per session (time while document was visible)
	const accumulatedTimeRefs = useRef<Record<string, number>>({});

	// Track the last timestamp when we started counting (null when document is hidden or not tracking)
	const lastActiveTimestampRefs = useRef<Record<string, number | null>>({});

	// Track which sessions are being tracked
	const trackingSessionsRef = useRef<Set<string>>(new Set());

	// Visibility change handler effect
	useEffect(() => {
		const handleVisibilityChange = () => {
			const now = Date.now();

			// Only update sessions that are currently being tracked
			for (const sessionId of trackingSessionsRef.current) {
				if (document.hidden) {
					// Document is now hidden: accumulate time and clear the active timestamp
					const lastActive = lastActiveTimestampRefs.current[sessionId];
					if (lastActive !== null && lastActive !== undefined) {
						accumulatedTimeRefs.current[sessionId] =
							(accumulatedTimeRefs.current[sessionId] || 0) + (now - lastActive);
						lastActiveTimestampRefs.current[sessionId] = null;
					}
				} else {
					// Document is now visible: set a new active timestamp
					lastActiveTimestampRefs.current[sessionId] = now;
				}

				// Notify callback if provided
				if (onTimeUpdateRef.current) {
					onTimeUpdateRef.current(
						sessionId,
						accumulatedTimeRefs.current[sessionId] || 0,
						lastActiveTimestampRefs.current[sessionId] ?? null
					);
				}
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);
		return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
	}, []); // Empty deps - handler uses refs for latest values

	/**
	 * Start tracking time for a session
	 */
	const startTracking = useCallback((sessionId: string): number => {
		const now = Date.now();

		// Initialize tracking for this session
		accumulatedTimeRefs.current[sessionId] = 0;
		lastActiveTimestampRefs.current[sessionId] = document.hidden ? null : now;
		trackingSessionsRef.current.add(sessionId);

		return now;
	}, []);

	/**
	 * Stop tracking time for a session and return final elapsed time
	 */
	const stopTracking = useCallback((sessionId: string): number => {
		const accumulated = accumulatedTimeRefs.current[sessionId] || 0;
		const lastActive = lastActiveTimestampRefs.current[sessionId];

		// Calculate final elapsed time
		let finalElapsed = accumulated;
		if (lastActive !== null && lastActive !== undefined && !document.hidden) {
			finalElapsed += Date.now() - lastActive;
		}

		// Clean up tracking data for this session
		delete accumulatedTimeRefs.current[sessionId];
		delete lastActiveTimestampRefs.current[sessionId];
		trackingSessionsRef.current.delete(sessionId);

		return finalElapsed;
	}, []);

	/**
	 * Get the current elapsed time for a session (without stopping)
	 */
	const getElapsedTime = useCallback((sessionId: string): number => {
		const accumulated = accumulatedTimeRefs.current[sessionId] || 0;
		const lastActive = lastActiveTimestampRefs.current[sessionId];

		// If currently visible and tracking, add time since last active timestamp
		if (lastActive !== null && lastActive !== undefined && !document.hidden) {
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
		getElapsedTime,
		getAccumulatedTime,
		getLastActiveTimestamp,
		isTracking,
	};
}
