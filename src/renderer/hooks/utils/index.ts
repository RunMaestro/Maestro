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

// Long-press gesture detection (touch context menus / tab action overlays)
export { useLongPress } from './useLongPress';
export type { UseLongPressOptions, UseLongPressReturn } from './useLongPress';

// Virtual-keyboard visibility (Visual Viewport API) for lifting bottom controls
export { useKeyboardVisibility } from './useKeyboardVisibility';
export type { UseKeyboardVisibilityReturn } from './useKeyboardVisibility';

// Voice-to-text via the Web Speech API (touch AI input dictation)
export { useVoiceInput, isSpeechRecognitionSupported, getSpeechRecognition } from './useVoiceInput';
export type { UseVoiceInputOptions, UseVoiceInputReturn } from './useVoiceInput';

// Multi-directional touch swipe detection (edge-swipe drawers)
export { useSwipeGestures } from './useSwipeGestures';
export type {
	UseSwipeGesturesOptions,
	UseSwipeGesturesReturn,
	SwipeDirection,
} from './useSwipeGestures';
