/**
 * Hooks Module - Central Export Hub
 *
 * This is the main entry point for all custom React hooks.
 * Hooks are organized into domain-focused modules for better discoverability.
 *
 * Module Structure:
 * - session/    - Session state and navigation
 * - batch/      - Batch processing and Auto Run
 * - agent/      - AI agent communication
 * - keyboard/   - Keyboard handling and shortcuts
 * - input/      - Input processing and completion
 * - git/        - Git integration
 * - ui/         - UI utilities and state
 * - remote/     - Web/remote integration
 * - settings/   - Settings management
 * - utils/      - Pure utility hooks
 */

// ============================================================================
// Session Module - Session state and navigation
// ============================================================================
export * from './session';

// ============================================================================
// Batch Module - Batch processing and Auto Run
// ============================================================================
export * from './batch';

// ============================================================================
// Agent Module - AI agent communication
// ============================================================================
export * from './agent';

// ============================================================================
// Keyboard Module - Keyboard handling and shortcuts
// ============================================================================
export * from './keyboard';

// ============================================================================
// Input Module - Input processing and completion
// ============================================================================
export * from './input';

// ============================================================================
// Git Module - Git integration
// ============================================================================
export * from './git';

// ============================================================================
// UI Module - UI utilities and state
// ============================================================================
export * from './ui';

// ============================================================================
// Remote Module - Web/remote integration
// ============================================================================
export * from './remote';

// ============================================================================
// Settings Module - Settings management
// ============================================================================
export * from './settings';

// ============================================================================
// Utils Module - Pure utility hooks
// ============================================================================
export * from './utils';

// ============================================================================
// Props Module - Memoized props hooks for major components
// ============================================================================
export * from './props';

// ============================================================================
// Stats Module - Usage statistics and dashboard data
// ============================================================================
export { useStats, useComputedStats } from './useStats';
export type { StatsTimeRange, StatsAggregation, UseStatsReturn, ComputedStats } from './useStats';

// ============================================================================
// Re-export TransferError types from component for convenience
// ============================================================================
export type {
	TransferError,
	TransferErrorType,
	TransferErrorModalProps,
} from '../components/TransferErrorModal';
export { classifyTransferError } from '../components/TransferErrorModal';
