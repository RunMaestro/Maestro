/**
 * Maestro Mobile Web Entry Point
 *
 * This is the entry point for the mobile web interface.
 * It exports the main MobileApp component and any mobile-specific
 * utilities needed for the remote control interface.
 *
 * The mobile interface is designed for:
 * - Quick command input from your phone
 * - Session monitoring and status checking
 * - Lightweight interaction when away from desk
 *
 * This module can be directly imported for code splitting:
 * ```typescript
 * const Mobile = lazy(() => import('./mobile'));
 * ```
 *
 * IMPORTANT: Constants and utilities that are used by hooks should be
 * imported from './constants' directly to avoid circular dependencies.
 * This file re-exports them for convenience.
 */

import MobileApp from './App';
import { SessionPillBar, type SessionPillBarProps } from './SessionPillBar';
import { AllSessionsView, type AllSessionsViewProps } from './AllSessionsView';
import { CommandInputBar, type CommandInputBarProps } from './CommandInputBar';
import { CommandHistoryDrawer, type CommandHistoryDrawerProps } from './CommandHistoryDrawer';

// Re-export constants from dedicated file to avoid circular dependencies
export {
	type MobileConfig,
	defaultMobileConfig,
	MOBILE_BREAKPOINTS,
	SAFE_AREA_DEFAULTS,
	GESTURE_THRESHOLDS,
	HAPTIC_PATTERNS,
	isMobileViewport,
	supportsHaptics,
	triggerHaptic,
	supportsVoiceInput,
} from './constants';

// Re-export the main app component as both default and named
export { MobileApp };
export default MobileApp;

// Re-export session pill bar component
export { SessionPillBar, type SessionPillBarProps };

// Re-export All Sessions view component
export { AllSessionsView, type AllSessionsViewProps };

// Re-export command input bar component
export { CommandInputBar, type CommandInputBarProps };

// Re-export command history drawer component
export { CommandHistoryDrawer, type CommandHistoryDrawerProps };
