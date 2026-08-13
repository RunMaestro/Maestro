/**
 * Utility Hooks Module
 *
 * Pure utility hooks for common patterns like debouncing, throttling,
 * and persistence. These hooks have no dependencies on other hook modules.
 */

// Debounce and throttle utilities
export { useDebouncedValue, useThrottledCallback, useDebouncedCallback } from './useThrottle';

// Tail-first list rendering with idle backfill (long transcripts, #1342)
export {
	useProgressiveRenderWindow,
	DEFAULT_INITIAL_RENDER_COUNT,
	DEFAULT_BACKFILL_CHUNK,
} from './useProgressiveRenderWindow';
export type { UseProgressiveRenderWindowOptions } from './useProgressiveRenderWindow';

// Debounced session persistence
export { useDebouncedPersistence, DEFAULT_DEBOUNCE_DELAY } from './useDebouncedPersistence';
export type { UseDebouncedPersistenceReturn } from './useDebouncedPersistence';
