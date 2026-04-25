/**
 * useSessionSwitchCallbacks - extracted from App.tsx (Phase 13A, Task 5)
 *
 * Groups session/tab switching callbacks that were scattered throughout App.tsx:
 *   - handleProcessMonitorNavigateToSession: navigate from ProcessMonitor to a session/tab
 *   - handleToastSessionClick: navigate from toast notification to a session/tab
 *   - handleNamedSessionSelect: open a closed named session from the session browser
 *   - handleUtilityTabSelect: switch to an AI tab from utility modals (tab switcher, etc.)
 *   - handleUtilityFileTabSelect: switch to a file tab from utility modals
 *
 * Also owns the deep link navigation effect (maestro:// URL handling).
 *
 * Self-sources from: sessionStore, uiStore
 * External deps: setActiveSessionId (wrapper that dismisses group chat),
 *   handleResumeSession (from useAgentSessionManagement), inputRef (DOM ref)
 */

import { useCallback, useEffect, useMemo } from 'react';
import type { Session, LogEntry, UsageStats } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { useActiveSession } from './useActiveSession';
import { useUIStore } from '../../stores/uiStore';

/** Helper: update a single session by ID using an updater function */
function updateSession(sessionId: string, updater: (s: Session) => Session): void {
	useSessionStore
		.getState()
		.setSessions((prev: Session[]) =>
			prev.map((s: Session) => (s.id === sessionId ? updater(s) : s))
		);
}

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseSessionSwitchCallbacksDeps {
	/** setActiveSessionId wrapper that also dismisses active group chat */
	setActiveSessionId: (id: string) => void;
	/** Resume a provider session, opening as a new tab or switching to existing */
	handleResumeSession: (
		agentSessionId: string,
		providedMessages?: LogEntry[],
		sessionName?: string,
		starred?: boolean,
		usageStats?: UsageStats
	) => Promise<void>;
	/** Ref to main input textarea (for auto-focus after navigation) */
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseSessionSwitchCallbacksReturn {
	/** Navigate from ProcessMonitor to a specific session, optionally to a tab */
	handleProcessMonitorNavigateToSession: (
		sessionId: string,
		tabId?: string,
		processType?: string
	) => void;
	/** Navigate from a toast notification to a session, optionally to a tab */
	handleToastSessionClick: (sessionId: string, tabId?: string) => void;
	/** Open a closed named session from the agent session browser */
	handleNamedSessionSelect: (
		agentSessionId: string,
		projectPath: string,
		sessionName: string,
		starred?: boolean
	) => void;
	/** Switch to an AI tab from utility modals (tab switcher, queue browser, etc.) */
	handleUtilityTabSelect: (tabId: string) => void;
	/** Switch to a file tab from utility modals */
	handleUtilityFileTabSelect: (tabId: string) => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useSessionSwitchCallbacks(
	deps: UseSessionSwitchCallbacksDeps
): UseSessionSwitchCallbacksReturn {
	const { setActiveSessionId, handleResumeSession, inputRef } = deps;

	// Self-source stable actions from stores
	const setSessions = useMemo(() => useSessionStore.getState().setSessions, []);
	const setGroups = useMemo(() => useSessionStore.getState().setGroups, []);
	const setActiveFocus = useMemo(() => useUIStore.getState().setActiveFocus, []);

	const activeSession = useActiveSession();

	// Navigate from ProcessMonitor to a specific session/tab
	const handleProcessMonitorNavigateToSession = useCallback(
		(sessionId: string, tabId?: string, processType?: string) => {
			setActiveSessionId(sessionId);
			if (processType === 'terminal') {
				// Switch to the terminal tab and set terminal mode
				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? {
									...s,
									inputMode: 'terminal' as const,
									activeFileTabId: null,
									...(tabId && { activeTerminalTabId: tabId }),
								}
							: s
					)
				);
			} else if (tabId) {
				// Switch to the specific AI tab within the session. Clear file/terminal/browser
				// state and force AI input mode so the view actually shows the target AI tab even
				// if the target session was last viewed on a terminal/file/browser tab. Without
				// this, activeTabId changes but the session still renders its previous non-AI
				// view (the bug: jumping to an AI tab silently leaves the user on a terminal).
				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? {
									...s,
									activeTabId: tabId,
									activeFileTabId: null,
									activeTerminalTabId: null,
									activeBrowserTabId: null,
									inputMode: 'ai' as const,
								}
							: s
					)
				);
			}
		},
		[setActiveSessionId, setSessions]
	);

	// Navigate from toast notification to a session/tab
	const handleToastSessionClick = useCallback(
		(sessionId: string, tabId?: string) => {
			// Switch to the session
			setActiveSessionId(sessionId);
			// Clear file preview and switch to AI tab (with specific tab if provided)
			// This ensures clicking a toast always shows the AI terminal, not a file preview
			updateSession(sessionId, (s) => {
				// If a specific tab ID is provided, check if it exists
				if (tabId && !s.aiTabs?.some((t) => t.id === tabId)) {
					// Tab doesn't exist, just clear file preview
					return { ...s, activeFileTabId: null, inputMode: 'ai' };
				}
				return {
					...s,
					...(tabId && { activeTabId: tabId }),
					activeFileTabId: null,
					inputMode: 'ai',
				};
			});
		},
		[setActiveSessionId]
	);

	// Deep link navigation handler - processes maestro:// URLs from OS notifications,
	// external apps, and CLI commands
	useEffect(() => {
		const unsubscribe = window.maestro.app.onDeepLink((deepLink) => {
			if (deepLink.action === 'focus') {
				// Window already brought to foreground by main process
				return;
			}
			if (deepLink.action === 'session' && deepLink.sessionId) {
				const sessions = useSessionStore.getState().sessions;
				const targetExists = sessions.some((s) => s.id === deepLink.sessionId);
				if (!targetExists) return;
				handleToastSessionClick(deepLink.sessionId, deepLink.tabId);
				return;
			}
			if (deepLink.action === 'group' && deepLink.groupId) {
				// Find first session in group and navigate to it
				const sessions = useSessionStore.getState().sessions;
				const groupSession = sessions.find((s) => s.groupId === deepLink.groupId);
				if (groupSession) {
					handleToastSessionClick(groupSession.id);
				}
				// Expand the group if it's collapsed
				setGroups((prev) =>
					prev.map((g) => (g.id === deepLink.groupId ? { ...g, collapsed: false } : g))
				);
			}
		});
		return unsubscribe;
	}, [handleToastSessionClick, setGroups]);

	// Open a closed named session from the agent session browser
	const handleNamedSessionSelect = useCallback(
		(agentSessionId: string, _projectPath: string, sessionName: string, starred?: boolean) => {
			// Open a closed named session as a new tab - use handleResumeSession to properly load messages
			handleResumeSession(agentSessionId, [], sessionName, starred);
			// Focus input so user can start interacting immediately
			setActiveFocus('main');
			setTimeout(() => inputRef.current?.focus(), 50);
		},
		[handleResumeSession, setActiveFocus, inputRef]
	);

	// Switch to an AI tab from utility modals (tab switcher, queue browser, etc.)
	const handleUtilityTabSelect = useCallback(
		(tabId: string) => {
			if (!activeSession) return;
			// Clear activeFileTabId and activeTerminalTabId when selecting an AI tab.
			// Also reset inputMode to 'ai' in case we're coming from terminal mode.
			updateSession(activeSession.id, (s) => ({
				...s,
				activeTabId: tabId,
				activeFileTabId: null,
				activeTerminalTabId: null,
				inputMode: 'ai',
			}));
		},
		[activeSession]
	);

	// Switch to a file tab from utility modals
	const handleUtilityFileTabSelect = useCallback(
		(tabId: string) => {
			if (!activeSession) return;
			// Set activeFileTabId, keep activeTabId as-is (for when returning to AI tabs).
			// Also reset inputMode to 'ai' and clear activeTerminalTabId in case we're coming from terminal mode.
			updateSession(activeSession.id, (s) => ({
				...s,
				activeFileTabId: tabId,
				activeTerminalTabId: null,
				inputMode: 'ai',
			}));
		},
		[activeSession]
	);

	return {
		handleProcessMonitorNavigateToSession,
		handleToastSessionClick,
		handleNamedSessionSelect,
		handleUtilityTabSelect,
		handleUtilityFileTabSelect,
	};
}
