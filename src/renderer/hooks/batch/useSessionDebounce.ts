/**
 * useSessionDebounce - Reusable debounce hook for per-session state updates
 *
 * This hook provides debouncing functionality keyed by session ID, allowing
 * rapid-fire state updates to be batched together while ensuring proper cleanup
 * on unmount to prevent memory leaks.
 *
 * Features:
 * - Per-session timer tracking
 * - Composable updates during debounce window
 * - Immediate bypass for critical updates
 * - Proper cleanup on unmount to prevent state updates after unmount
 */

import { useRef, useEffect, useCallback } from 'react';

/**
 * Configuration options for the debounce hook
 */
export interface UseSessionDebounceOptions<T> {
	/**
	 * Debounce delay in milliseconds
	 */
	delayMs: number;

	/**
	 * Callback to apply the final composed update
	 * Called with the session ID and the composed updater function
	 */
	onUpdate: (sessionId: string, updater: (prev: T) => T) => void;
}

/**
 * Return type for the useSessionDebounce hook
 */
export interface UseSessionDebounceReturn<T> {
	/**
	 * Schedule a debounced update for a session
	 *
	 * @param sessionId - The session to update
	 * @param updater - Function that transforms the current state
	 * @param immediate - If true, bypass debouncing and apply immediately
	 */
	scheduleUpdate: (sessionId: string, updater: (prev: T) => T, immediate?: boolean) => void;

	/**
	 * Cancel any pending update for a session
	 */
	cancelUpdate: (sessionId: string) => void;

	/**
	 * Flush a pending update immediately (if any)
	 */
	flushUpdate: (sessionId: string) => void;

	/**
	 * Check if component is still mounted (useful for async callbacks)
	 */
	isMounted: () => boolean;
}

/**
 * Hook for debouncing state updates keyed by session ID
 *
 * Memory safety guarantees:
 * - All timers are cleared synchronously on unmount
 * - State updates are prevented after unmount via isMountedRef check
 * - Pending updates are cleared on unmount
 *
 * @param options - Configuration options for the debounce behavior
 */
export function useSessionDebounce<T>(
	options: UseSessionDebounceOptions<T>
): UseSessionDebounceReturn<T> {
	const { delayMs, onUpdate } = options;

	// Track timers per session ID
	const debounceTimerRefs = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

	// Track pending updates per session ID (composed updater functions)
	const pendingUpdatesRef = useRef<Record<string, (prev: T) => T>>({});

	// Track whether component is still mounted
	const isMountedRef = useRef(true);

	// Cleanup effect: clear all timers synchronously on unmount.
	// Also re-sets isMountedRef on mount: refs persist across remounts, so under
	// React.StrictMode's mount→unmount→remount cycle the cleanup leaves it false
	// forever and every debounced flush silently no-ops.
	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;

			// Clear all timers synchronously
			Object.values(debounceTimerRefs.current).forEach((timer) => {
				clearTimeout(timer);
			});

			// Clear refs to allow garbage collection
			Object.keys(debounceTimerRefs.current).forEach((sessionId) => {
				delete debounceTimerRefs.current[sessionId];
			});
			Object.keys(pendingUpdatesRef.current).forEach((sessionId) => {
				delete pendingUpdatesRef.current[sessionId];
			});
		};
	}, []);

	/**
	 * Schedule a debounced update for a session
	 */
	const scheduleUpdate = useCallback(
		(sessionId: string, updater: (prev: T) => T, immediate: boolean = false) => {
			// For immediate updates (start/stop/error), bypass debouncing
			if (immediate) {
				// Clear any pending timer for this session
				if (debounceTimerRefs.current[sessionId]) {
					clearTimeout(debounceTimerRefs.current[sessionId]);
					delete debounceTimerRefs.current[sessionId];
				}
				// Clear any pending composed updates
				delete pendingUpdatesRef.current[sessionId];
				// Apply update immediately
				onUpdate(sessionId, updater);
				return;
			}

			// Compose this update with any pending updates for this session
			const existingUpdater = pendingUpdatesRef.current[sessionId];
			if (existingUpdater) {
				pendingUpdatesRef.current[sessionId] = (prev: T) => updater(existingUpdater(prev));
			} else {
				pendingUpdatesRef.current[sessionId] = updater;
			}

			// Clear existing timer and set a new one
			if (debounceTimerRefs.current[sessionId]) {
				clearTimeout(debounceTimerRefs.current[sessionId]);
			}

			debounceTimerRefs.current[sessionId] = setTimeout(() => {
				const composedUpdater = pendingUpdatesRef.current[sessionId];
				if (composedUpdater && isMountedRef.current) {
					onUpdate(sessionId, composedUpdater);
				}
				delete pendingUpdatesRef.current[sessionId];
				delete debounceTimerRefs.current[sessionId];
			}, delayMs);
		},
		[delayMs, onUpdate]
	);

	/**
	 * Cancel any pending update for a session
	 */
	const cancelUpdate = useCallback((sessionId: string) => {
		if (debounceTimerRefs.current[sessionId]) {
			clearTimeout(debounceTimerRefs.current[sessionId]);
			delete debounceTimerRefs.current[sessionId];
		}
		delete pendingUpdatesRef.current[sessionId];
	}, []);

	/**
	 * Flush a pending update immediately (if any)
	 */
	const flushUpdate = useCallback(
		(sessionId: string) => {
			// Clear the timer
			if (debounceTimerRefs.current[sessionId]) {
				clearTimeout(debounceTimerRefs.current[sessionId]);
				delete debounceTimerRefs.current[sessionId];
			}

			// Apply the pending update if any
			const composedUpdater = pendingUpdatesRef.current[sessionId];
			if (composedUpdater && isMountedRef.current) {
				onUpdate(sessionId, composedUpdater);
			}
			delete pendingUpdatesRef.current[sessionId];
		},
		[onUpdate]
	);

	/**
	 * Check if component is still mounted
	 */
	const isMounted = useCallback(() => isMountedRef.current, []);

	return {
		scheduleUpdate,
		cancelUpdate,
		flushUpdate,
		isMounted,
	};
}
