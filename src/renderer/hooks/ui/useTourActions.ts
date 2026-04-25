/**
 * useTourActions — extracted from App.tsx
 *
 * Listens for tour:action custom events to control right panel state:
 *   - setRightTab: Switch to a specific right panel tab
 *   - openRightPanel: Open the right panel
 *   - closeRightPanel: Close the right panel
 *   - ensureAiTab: Switch to an AI tab so input area is visible
 *
 * Reads from: uiStore (setActiveRightTab, setRightPanelOpen)
 * Reads from: sessionStore (active session), tabStore (selectTab)
 */

import type { RightPanelTab } from '../../types';
import { useUIStore } from '../../stores/uiStore';
import { selectActiveSession, useSessionStore } from '../../stores/sessionStore';
import { useTabStore } from '../../stores/tabStore';
import { useEventListener } from '../utils/useEventListener';

// ============================================================================
// Hook implementation
// ============================================================================

export function useTourActions(): void {
	// --- Store actions (stable via getState) ---
	const { setActiveRightTab, setRightPanelOpen } = useUIStore.getState();

	useEventListener('tour:action', (event: Event) => {
		const customEvent = event as CustomEvent<{
			type: string;
			value?: string;
		}>;
		const { type, value } = customEvent.detail;

		switch (type) {
			case 'setRightTab':
				if (value === 'files' || value === 'history' || value === 'autorun') {
					setActiveRightTab(value as RightPanelTab);
				}
				break;
			case 'openRightPanel':
				setRightPanelOpen(true);
				break;
			case 'closeRightPanel':
				setRightPanelOpen(false);
				break;
			case 'ensureAiTab': {
				const session = selectActiveSession(useSessionStore.getState());
				if (!session) break;
				// Already on an AI tab in AI mode - nothing to do
				if (
					session.inputMode === 'ai' &&
					!session.activeBrowserTabId &&
					!session.activeTerminalTabId
				) {
					break;
				}
				// Switch to the current AI tab (or first available)
				const targetTabId = session.activeTabId || session.aiTabs?.[0]?.id;
				if (targetTabId) {
					useTabStore.getState().selectTab(targetTabId);
				}
				break;
			}
			// hamburger menu actions are handled by SessionList.tsx
			default:
				break;
		}
	});
}
