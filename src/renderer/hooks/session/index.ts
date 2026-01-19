/**
 * Session State Management Module
 *
 * Hooks for session navigation, sorting, filtering, grouping,
 * activity tracking, and batched updates.
 */

// Navigation history (back/forward)
export { useNavigationHistory } from './useNavigationHistory';
export type { NavHistoryEntry } from './useNavigationHistory';

// Session navigation handlers
export { useSessionNavigation } from './useSessionNavigation';
export type { UseSessionNavigationReturn, UseSessionNavigationDeps } from './useSessionNavigation';

// Session sorting utilities
export {
	useSortedSessions,
	stripLeadingEmojis,
	compareNamesIgnoringEmojis,
} from './useSortedSessions';
export type { UseSortedSessionsDeps, UseSortedSessionsReturn } from './useSortedSessions';

// Group management
export { useGroupManagement } from './useGroupManagement';
export type {
	UseGroupManagementDeps,
	UseGroupManagementReturn,
	GroupModalState,
} from './useGroupManagement';

// Batched session updates for performance
export { useBatchedSessionUpdates, DEFAULT_BATCH_FLUSH_INTERVAL } from './useBatchedSessionUpdates';
export type { UseBatchedSessionUpdatesReturn, BatchedUpdater } from './useBatchedSessionUpdates';

// Activity time tracking (per-session)
export { useActivityTracker } from './useActivityTracker';
export type { UseActivityTrackerReturn } from './useActivityTracker';

// Global hands-on time tracking (persists to settings)
export { useHandsOnTimeTracker } from './useHandsOnTimeTracker';
