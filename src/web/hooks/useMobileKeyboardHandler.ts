/**
 * useMobileKeyboardHandler - Mobile keyboard shortcuts handler hook
 *
 * Handles keyboard shortcuts for the mobile web interface:
 * - Cmd+K / Ctrl+K: Toggle command palette
 * - Escape: Close command palette
 * - Cmd+J / Ctrl+J: Toggle between AI and Terminal mode
 * - Cmd+[ / Ctrl+[: Switch to previous tab
 * - Cmd+] / Ctrl+]: Switch to next tab
 *
 * Extracted from mobile App.tsx for code organization.
 *
 * @example
 * ```tsx
 * useMobileKeyboardHandler({
 *   activeSessionId,
 *   activeSession,
 *   handleModeToggle,
 *   handleSelectTab,
 * });
 * ```
 */

import { useEffect } from 'react';
import type { AITabData } from './useWebSocket';

/**
 * Session type for the mobile keyboard handler
 * Only includes fields needed for keyboard handling
 * Kept minimal to accept any object with these optional fields
 */
export type MobileKeyboardSession = {
	/** Current input mode */
	inputMode?: string;
	/** Array of AI tabs */
	aiTabs?: AITabData[];
	/** Currently active tab ID */
	activeTabId?: string;
};

/**
 * Input mode type for the handler
 */
export type MobileInputMode = 'ai' | 'terminal';

/**
 * Dependencies for useMobileKeyboardHandler
 */
export interface UseMobileKeyboardHandlerDeps {
	/** ID of the currently active session */
	activeSessionId: string | null;
	/** The currently active session object */
	activeSession: MobileKeyboardSession | null | undefined;
	/** Handler to toggle between AI and Terminal mode */
	handleModeToggle: (mode: MobileInputMode) => void;
	/** Handler to select a tab */
	handleSelectTab: (tabId: string) => void;
	/** Handler to open the command palette (Cmd+K / Ctrl+K) */
	onOpenCommandPalette?: () => void;
	/** Handler to close the command palette (Escape) */
	onCloseCommandPalette?: () => void;
	/** Whether the command palette is currently open */
	isCommandPaletteOpen?: boolean;
}

/**
 * Hook for handling keyboard shortcuts in the mobile web interface
 *
 * Registers event listeners for keyboard shortcuts and invokes the
 * appropriate handlers when shortcuts are pressed.
 *
 * @param deps - Dependencies including session state and handlers
 */
export function useMobileKeyboardHandler(deps: UseMobileKeyboardHandlerDeps): void {
	const {
		activeSessionId,
		activeSession,
		handleModeToggle,
		handleSelectTab,
		onOpenCommandPalette,
		onCloseCommandPalette,
		isCommandPaletteOpen,
	} = deps;

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target;
			const activeElement = document.activeElement;
			const isXtermElement = (el: EventTarget | null) =>
				el instanceof Element &&
				(el.classList.contains('xterm-helper-textarea') || !!el.closest('.xterm'));
			const isXtermTarget = isXtermElement(target) || isXtermElement(activeElement);
			if (activeSession?.inputMode === 'terminal' && isXtermTarget) {
				// Keep terminal keystrokes inside xterm while a terminal app is active.
				return;
			}

			// Cmd+K / Ctrl+K: Open command palette
			if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
				if (isCommandPaletteOpen && onCloseCommandPalette) {
					e.preventDefault();
					onCloseCommandPalette();
				} else if (onOpenCommandPalette) {
					e.preventDefault();
					onOpenCommandPalette();
				}
				return;
			}

			// Escape: Close command palette if open
			if (e.key === 'Escape' && isCommandPaletteOpen && onCloseCommandPalette) {
				e.preventDefault();
				onCloseCommandPalette();
				return;
			}

			// Check for Cmd+J (Mac) or Ctrl+J (Windows/Linux) to toggle AI/CLI mode
			if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
				e.preventDefault();
				if (!activeSessionId) return;

				// Toggle mode
				const currentMode = activeSession?.inputMode || 'ai';
				const newMode: MobileInputMode = currentMode === 'ai' ? 'terminal' : 'ai';
				handleModeToggle(newMode);
				return;
			}

			// Cmd+[ or Ctrl+[ - Previous tab
			if ((e.metaKey || e.ctrlKey) && e.key === '[') {
				e.preventDefault();
				if (!activeSession?.aiTabs || activeSession.aiTabs.length < 2) return;

				const currentIndex = activeSession.aiTabs.findIndex(
					(t) => t.id === activeSession.activeTabId
				);
				if (currentIndex === -1) return;

				// Wrap around to last tab if at beginning
				const prevIndex =
					(currentIndex - 1 + activeSession.aiTabs.length) % activeSession.aiTabs.length;
				const prevTab = activeSession.aiTabs[prevIndex];
				handleSelectTab(prevTab.id);
				return;
			}

			// Cmd+] or Ctrl+] - Next tab
			if ((e.metaKey || e.ctrlKey) && e.key === ']') {
				e.preventDefault();
				if (!activeSession?.aiTabs || activeSession.aiTabs.length < 2) return;

				const currentIndex = activeSession.aiTabs.findIndex(
					(t) => t.id === activeSession.activeTabId
				);
				if (currentIndex === -1) return;

				// Wrap around to first tab if at end
				const nextIndex = (currentIndex + 1) % activeSession.aiTabs.length;
				const nextTab = activeSession.aiTabs[nextIndex];
				handleSelectTab(nextTab.id);
				return;
			}
		};

		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [
		activeSessionId,
		activeSession,
		handleModeToggle,
		handleSelectTab,
		onOpenCommandPalette,
		onCloseCommandPalette,
		isCommandPaletteOpen,
	]);
}

export default useMobileKeyboardHandler;
