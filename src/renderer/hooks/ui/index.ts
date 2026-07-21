/**
 * UI Utilities Module
 *
 * Hooks for common UI patterns: layer management, scroll behavior,
 * click detection, expansion state, tooltips, and theming.
 */

// Layer stack management
export { useLayerStack } from './useLayerStack';
export type { LayerStackAPI } from './useLayerStack';

// Modal registration helper
export { useModalLayer } from './useModalLayer';
export type { UseModalLayerOptions } from './useModalLayer';

// Click outside detection
export { useClickOutside } from './useClickOutside';
export type { UseClickOutsideOptions } from './useClickOutside';

// Clipboard feedback lifecycle
export { useCopyFeedback } from './useCopyFeedback';
export type { UseCopyFeedbackOptions, UseCopyFeedbackReturn } from './useCopyFeedback';

// Command-panel UI state
export { useCommandPanelState } from './useCommandPanelState';
export type {
	UseCommandPanelStateOptions,
	UseCommandPanelStateReturn,
} from './useCommandPanelState';

// Expansion state management (for lists, trees, etc.)
export { useExpandedSet } from './useExpandedSet';
export type { UseExpandedSetOptions, UseExpandedSetReturn } from './useExpandedSet';

// Scroll position tracking
export { useScrollPosition } from './useScrollPosition';
export type {
	UseScrollPositionOptions,
	UseScrollPositionReturn,
	ScrollMetrics,
} from './useScrollPosition';

export { useAutoScrollToBottom } from './useAutoScrollToBottom';
export type {
	UseAutoScrollToBottomOptions,
	UseAutoScrollToBottomReturn,
} from './useAutoScrollToBottom';

// Scroll into view helper
export { useScrollIntoView } from './useScrollIntoView';

// Hover tooltip management
export { useHoverTooltip } from './useHoverTooltip';

// Theme styling utilities
export { useThemeStyles } from './useThemeStyles';
export type { UseThemeStylesDeps, UseThemeStylesReturn, ThemeColors } from './useThemeStyles';

// Context menu viewport positioning
export { useContextMenuPosition } from './useContextMenuPosition';

// Resizable panel drag behavior
export { useResizablePanel } from './useResizablePanel';
export type { UseResizablePanelOptions, UseResizablePanelReturn } from './useResizablePanel';

// Resizable modal drag behavior
export { useResizableModal } from './useResizableModal';
export type {
	ModalResizeDirection,
	UseResizableModalOptions,
	UseResizableModalReturn,
} from './useResizableModal';

export { usePointerResize } from './usePointerResize';
export type { PointerResizeOperation, UsePointerResizeReturn } from './usePointerResize';

// App-level handlers (drag, file, folder operations)
export { useAppHandlers } from './useAppHandlers';
export type { UseAppHandlersDeps, UseAppHandlersReturn } from './useAppHandlers';

// App initialization effects (startup, splash screen, platform checks, command loading)
export { useAppInitialization } from './useAppInitialization';
export type { AppInitializationReturn } from './useAppInitialization';

// Tour actions listener (right panel control from tour overlay)
export { useTourActions } from './useTourActions';

// Idle notification (fires command when all agents/batches finish)
export { useIdleNotification } from './useIdleNotification';

// Deferred update-restart (installs downloaded update on idle transition)
export { useRestartWhenIdle } from './useRestartWhenIdle';

// Responsive viewport breakpoint (drives drawer-mode sidebars on narrow widths)
export { useViewportBreakpoint } from './useViewportBreakpoint';
export type { Breakpoint } from './useViewportBreakpoint';

// Per-window panel-collapse state (reads/persists left/right panel collapse
// through window.maestro.windows.*, keyed per-window not as a global setting)
export { useWindowState } from './useWindowState';
