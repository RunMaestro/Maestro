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

// Tab-tiling (split panes) Ctrl+Cmd shortcut handlers
export { useTilingShortcuts } from './useTilingShortcuts';
export type { TilingShortcutHandlers } from './useTilingShortcuts';

// Generic list navigation
export { useListNavigation } from './useListNavigation';
export type { UseListNavigationOptions, UseListNavigationReturn } from './useListNavigation';

// Cmd/Ctrl+S save shortcut
export { useSaveShortcut } from './useSaveShortcut';

// Cmd/Ctrl+Z / Shift+Z text-input undo fallback
export { useTextEditorUndo } from './useTextEditorUndo';
