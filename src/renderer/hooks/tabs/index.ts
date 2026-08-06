export {
	useTabHandlers,
	type TabHandlersReturn,
	type CloseCurrentTabResult,
	useTerminalTabHandlers,
	type TerminalTabHandlersReturn,
} from './useTabHandlers';

// Tab export handlers (copy context, export HTML, publish gist)
export { useTabExportHandlers } from './useTabExportHandlers';
export type { UseTabExportHandlersDeps, UseTabExportHandlersReturn } from './useTabExportHandlers';

// Snooze scheduler (wakes snoozed tabs and fires their reminder)
export { useSnoozeScheduler } from './useSnoozeScheduler';

// Tab hover overlay (shared state for AITab, FileTab, TerminalTabItem)
export { useTabHoverOverlay } from './useTabHoverOverlay';
export type {
	OverlayPosition,
	UseTabHoverOverlayOptions,
	UseTabHoverOverlayReturn,
} from './useTabHoverOverlay';
