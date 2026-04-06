/**
 * Utility Hooks Module
 *
 * Pure utility hooks for common patterns like debouncing, throttling,
 * and persistence. These hooks have no dependencies on other hook modules.
 */

// Focus after render
export { useFocusAfterRender } from './useFocusAfterRender';

// Debounce and throttle utilities
export { useDebouncedValue, useThrottledCallback, useDebouncedCallback } from './useThrottle';

// Debounced session persistence
export { useDebouncedPersistence, DEFAULT_DEBOUNCE_DELAY } from './useDebouncedPersistence';
export type { UseDebouncedPersistenceReturn } from './useDebouncedPersistence';
