/**
 * Keyboard Handling Module
 *
 * Hooks for keyboard event handling, shortcuts, and list navigation.
 */

// Main keyboard event handler
export { useMainKeyboardHandler } from './useMainKeyboardHandler';
export type { UseMainKeyboardHandlerReturn } from './useMainKeyboardHandler';

// Arrow/Tab keyboard navigation
export { useKeyboardNavigation } from './useKeyboardNavigation';
export type {
	UseKeyboardNavigationDeps,
	UseKeyboardNavigationReturn,
} from './useKeyboardNavigation';

// Shortcut matching utilities
export { useKeyboardShortcutHelpers } from './useKeyboardShortcutHelpers';
export type {
	UseKeyboardShortcutHelpersDeps,
	UseKeyboardShortcutHelpersReturn,
} from './useKeyboardShortcutHelpers';

// Generic list navigation
export { useListNavigation } from './useListNavigation';
export type { UseListNavigationOptions, UseListNavigationReturn } from './useListNavigation';
