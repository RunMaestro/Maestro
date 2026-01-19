/**
 * useThrottle.ts
 *
 * Performance hooks for throttling and debouncing values and callbacks.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Returns a debounced version of the value that only updates after
 * the specified delay has passed without changes.
 *
 * @param value - The value to debounce
 * @param delay - Delay in milliseconds
 * @returns The debounced value
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
	const [debouncedValue, setDebouncedValue] = useState<T>(value);

	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedValue(value);
		}, delay);

		return () => {
			clearTimeout(timer);
		};
	}, [value, delay]);

	return debouncedValue;
}

/**
 * Returns a throttled callback that only executes at most once per
 * specified interval. Uses leading edge (executes immediately on first call).
 *
 * @param callback - The callback to throttle
 * @param delay - Minimum interval between calls in milliseconds
 * @returns Throttled callback
 */
export function useThrottledCallback<T extends (...args: unknown[]) => void>(
	callback: T,
	delay: number
): T {
	const lastCallRef = useRef<number>(0);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const callbackRef = useRef(callback);

	// Keep callback ref up to date
	callbackRef.current = callback;

	const throttled = useCallback(
		(...args: Parameters<T>) => {
			const now = Date.now();
			const timeSinceLastCall = now - lastCallRef.current;

			if (timeSinceLastCall >= delay) {
				// Enough time has passed, execute immediately
				lastCallRef.current = now;
				callbackRef.current(...args);
			} else {
				// Schedule for later if not already scheduled
				if (!timeoutRef.current) {
					timeoutRef.current = setTimeout(() => {
						lastCallRef.current = Date.now();
						callbackRef.current(...args);
						timeoutRef.current = null;
					}, delay - timeSinceLastCall);
				}
			}
		},
		[delay]
	) as T;

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, []);

	return throttled;
}

/**
 * Returns a debounced callback that only executes after the specified
 * delay has passed without being called again.
 *
 * Useful for search input, filter updates, and other cases where you
 * want to wait for user to stop typing before processing.
 *
 * @param callback - The callback to debounce
 * @param delay - Delay in milliseconds before executing
 * @returns Debounced callback and flush function
 */
export function useDebouncedCallback<T extends (...args: unknown[]) => void>(
	callback: T,
	delay: number
): { debouncedCallback: T; flush: () => void; cancel: () => void } {
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const callbackRef = useRef(callback);
	const pendingArgsRef = useRef<Parameters<T> | null>(null);

	// Keep callback ref up to date
	callbackRef.current = callback;

	const cancel = useCallback(() => {
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}
		pendingArgsRef.current = null;
	}, []);

	const flush = useCallback(() => {
		if (timeoutRef.current && pendingArgsRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
			callbackRef.current(...pendingArgsRef.current);
			pendingArgsRef.current = null;
		}
	}, []);

	const debouncedCallback = useCallback(
		(...args: Parameters<T>) => {
			pendingArgsRef.current = args;

			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}

			timeoutRef.current = setTimeout(() => {
				callbackRef.current(...args);
				timeoutRef.current = null;
				pendingArgsRef.current = null;
			}, delay);
		},
		[delay]
	) as T;

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, []);

	return { debouncedCallback, flush, cancel };
}
