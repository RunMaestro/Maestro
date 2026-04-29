/**
 * Utility Hooks Module
 *
 * Pure utility hooks for common patterns like debouncing, throttling,
 * and persistence. These hooks have no dependencies on other hook modules.
 */

// Debounce and throttle utilities
export { useDebouncedValue, useThrottledCallback, useDebouncedCallback } from './useThrottle';

// Debounced session persistence
export { useDebouncedPersistence, DEFAULT_DEBOUNCE_DELAY } from './useDebouncedPersistence';
export type { UseDebouncedPersistenceReturn } from './useDebouncedPersistence';

// Periodic terminal command-state polling (Phase 7 fallback)
export {
	useTerminalCommandStatePolling,
	applyTerminalCommandSnapshot,
	DEFAULT_TERMINAL_POLL_INTERVAL_MS,
} from './useTerminalCommandStatePolling';
