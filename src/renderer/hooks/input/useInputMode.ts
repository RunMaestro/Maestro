/**
 * useInputMode — extracted from App.tsx (Tier 3A)
 *
 * Provides toggle between AI and terminal input modes:
 *   - Saves/restores file preview tab when switching to/from terminal
 *   - Closes dropdown menus (tab completion, slash command) on switch
 *
 * Reads from: sessionStore, uiStore
 */

import { useCallback } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useUIStore } from '../../stores/uiStore';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseInputModeDeps {
	/** Close tab completion dropdown on mode switch */
	setTabCompletionOpen: (open: boolean) => void;
	/** Close slash command dropdown on mode switch */
	setSlashCommandOpen: (open: boolean) => void;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseInputModeReturn {
	/** Toggle between 'ai' and 'terminal' input modes */
	toggleInputMode: () => void;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useInputMode(deps: UseInputModeDeps): UseInputModeReturn {
	const { setTabCompletionOpen, setSlashCommandOpen } = deps;

	const toggleInputMode = useCallback(() => {
		const { setSessions, activeSessionId } = useSessionStore.getState();

		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				const newMode = s.inputMode === 'ai' ? 'terminal' : 'ai';

				if (newMode === 'terminal') {
					// Switching to terminal mode: save current file tab (if any) and clear it
					useUIStore.getState().setPreTerminalFileTabId(s.activeFileTabId);
					return {
						...s,
						inputMode: newMode,
						activeFileTabId: null,
					};
				} else {
					// Switching to AI mode: restore previous file tab if it still exists
					const savedFileTabId = useUIStore.getState().preTerminalFileTabId;
					const fileTabStillExists =
						savedFileTabId && s.filePreviewTabs?.some((t) => t.id === savedFileTabId);
					useUIStore.getState().setPreTerminalFileTabId(null);
					return {
						...s,
						inputMode: newMode,
						...(fileTabStillExists && { activeFileTabId: savedFileTabId }),
					};
				}
			})
		);
		// Close any open dropdowns when switching modes
		setTabCompletionOpen(false);
		setSlashCommandOpen(false);
	}, [setTabCompletionOpen, setSlashCommandOpen]);

	return { toggleInputMode };
}
