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

// Scroll into view helper
export { useScrollIntoView } from './useScrollIntoView';

// Hover tooltip management
export { useHoverTooltip } from './useHoverTooltip';

// Theme styling utilities
export { useThemeStyles } from './useThemeStyles';
export type { UseThemeStylesDeps, UseThemeStylesReturn, ThemeColors } from './useThemeStyles';

// App-level handlers (drag, file, folder operations)
export { useAppHandlers } from './useAppHandlers';
export type { UseAppHandlersDeps, UseAppHandlersReturn, FilePreview } from './useAppHandlers';
