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
import type { FlatFileItem } from '../../components/FileSearchModal';
import type { FileNode } from '../../types/fileTree';
import { useSessionStore } from '../../stores/sessionStore';
import { useActiveSession } from './useActiveSession';
import { useUIStore } from '../../stores/uiStore';
import { useFileExplorerStore } from '../../stores/fileExplorerStore';
import { aiTabFocusFields, reopenClosedAiTabById } from '../../utils/tabHelpers';
import { subscribeToInAppDeepLinks } from '../../utils/openMaestroLink';
import type { ParsedDeepLink } from '../../../shared/types';

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
	/**
	 * Resume a provider session, opening as a new tab or switching to existing.
	 * Resolves to `true` when opened/switched, `false` when the session could not
	 * be loaded (e.g. aged out).
	 */
	handleResumeSession: (
		agentSessionId: string,
		providedMessages?: LogEntry[],
		sessionName?: string,
		starred?: boolean,
		usageStats?: UsageStats,
		projectPath?: string,
		opts?: { targetSessionId?: string; suppressUnavailableFlash?: boolean }
	) => Promise<boolean>;
	/** Ref to main input textarea (for auto-focus after navigation) */
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	/** Open a file in the file preview tab (from fuzzy file search) */
	handleFileClick: (file: FileNode, path: string) => void;
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
	/**
	 * Jump to a starred session from the Left Bar, switching to its owning agent
	 * and resuming the conversation. Resolves to `false` when the session can no
	 * longer be loaded (aged out) so the caller can offer to remove the star.
	 */
	handleJumpToStarredSession: (
		agentId: string,
		projectPath: string,
		agentSessionId: string,
		sessionName: string,
		parentSessionId: string
	) => Promise<boolean>;
	/** Switch to an AI tab from utility modals (tab switcher, queue browser, etc.) */
	handleUtilityTabSelect: (tabId: string) => void;
	/** Switch to a file tab from utility modals */
	handleUtilityFileTabSelect: (tabId: string) => void;
	/** Preview a file selected from fuzzy file search */
	handleFileSearchSelect: (file: FlatFileItem) => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useSessionSwitchCallbacks(
	deps: UseSessionSwitchCallbacksDeps
): UseSessionSwitchCallbacksReturn {
	const { setActiveSessionId, handleResumeSession, inputRef, handleFileClick } = deps;

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
					prev.map((s) => (s.id === sessionId ? { ...s, ...aiTabFocusFields(tabId) } : s))
				);
			}
		},
		[setActiveSessionId, setSessions]
	);

	// Navigate from toast notification to a session/tab
	const handleToastSessionClick = useCallback(
		(sessionId: string, tabId?: string) => {
			// Close the Document Graph if it's open. It's a full-screen modal
			// overlay (fixed inset-0, z-9999), so without this the graph stays
			// on top of the agent we just jumped to and swallows clicks meant
			// for it. The toast jump should always land the user on the agent.
			if (useFileExplorerStore.getState().isGraphViewOpen) {
				useFileExplorerStore.getState().closeGraphView();
			}
			// Switch to the session
			setActiveSessionId(sessionId);
			// Switch to AI tab (with specific tab if provided). Clear file/terminal/browser
			// active-tab state so the jump actually shows the AI terminal even when the agent
			// was last viewed on a browser, terminal, or file-preview tab. Without clearing
			// activeBrowserTabId/activeTerminalTabId, activeTabId changes but the session keeps
			// rendering its previous non-AI view (the bug: clicking a toast while a browser tab
			// is active silently leaves the user on the browser tab).
			updateSession(sessionId, (s) => {
				// Fast path: the toast's tab is still open - just focus it.
				if (tabId && s.aiTabs?.some((t) => t.id === tabId)) {
					return { ...s, ...aiTabFocusFields(tabId) };
				}
				// The toast fired from a tab the user has since closed. Reopen it from
				// the closed-tab history so the click restores that conversation rather
				// than silently landing on whatever tab happens to be active.
				if (tabId) {
					const reopened = reopenClosedAiTabById(s, tabId);
					if (reopened) {
						return { ...reopened.session, ...aiTabFocusFields(reopened.tabId) };
					}
				}
				// No specific tab, or it aged out of history - just force the AI view
				// without changing which AI tab is active.
				return { ...s, ...aiTabFocusFields() };
			});
		},
		[setActiveSessionId]
	);

	// Deep link navigation handler - processes maestro:// URLs from OS notifications,
	// external apps, CLI commands, AND in-renderer markdown link clicks.
	useEffect(() => {
		const handleDeepLink = (deepLink: ParsedDeepLink) => {
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
				return;
			}
			if (deepLink.action === 'file' && deepLink.sessionId && deepLink.filePath) {
				// Open the file inside the target session's file-preview tab.
				// Re-uses the same CustomEvent pipeline the CLI / remote layer
				// drives so the open path stays unified. The line number is
				// surfaced via `detail.line` for callers that want to scroll on
				// mount; older listeners that ignore it still open the file.
				const sessions = useSessionStore.getState().sessions;
				const targetExists = sessions.some((s) => s.id === deepLink.sessionId);
				if (!targetExists) return;
				window.dispatchEvent(
					new CustomEvent('maestro:openFileTab', {
						detail: {
							sessionId: deepLink.sessionId,
							filePath: deepLink.filePath,
							line: deepLink.line,
						},
					})
				);
			}
		};
		const unsubscribeIpc = window.maestro.app.onDeepLink(handleDeepLink);
		const unsubscribeInApp = subscribeToInAppDeepLinks(handleDeepLink);
		return () => {
			unsubscribeIpc();
			unsubscribeInApp();
		};
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

	// Jump to a starred session from the Left Bar. Unlike handleNamedSessionSelect,
	// this can cross agents, so it first switches to the owning agent and resumes
	// against that explicit target (the active-session closure is stale at this
	// point). Returns whether the session was actually loaded so the caller can
	// offer to remove a stale star when it has aged out.
	const handleJumpToStarredSession = useCallback(
		async (
			_agentId: string,
			projectPath: string,
			agentSessionId: string,
			sessionName: string,
			parentSessionId: string
		): Promise<boolean> => {
			setActiveSessionId(parentSessionId);
			const opened = await handleResumeSession(
				agentSessionId,
				[],
				sessionName,
				true,
				undefined,
				projectPath,
				{ targetSessionId: parentSessionId, suppressUnavailableFlash: true }
			);
			if (opened) {
				setActiveFocus('main');
				setTimeout(() => inputRef.current?.focus(), 50);
			}
			return opened;
		},
		[setActiveSessionId, handleResumeSession, setActiveFocus, inputRef]
	);

	// Switch to an AI tab from utility modals (tab switcher, queue browser, etc.)
	const handleUtilityTabSelect = useCallback(
		(tabId: string) => {
			if (!activeSession) return;
			// Land on the AI tab, clearing any active file/terminal/browser view that
			// would otherwise outrank it in the render precedence.
			updateSession(activeSession.id, (s) => ({ ...s, ...aiTabFocusFields(tabId) }));
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

	const handleFileSearchSelect = useCallback(
		(file: FlatFileItem) => {
			if (!file.isFolder) {
				handleFileClick({ name: file.name, type: 'file' }, file.fullPath);
			}
		},
		[handleFileClick]
	);

	return {
		handleProcessMonitorNavigateToSession,
		handleToastSessionClick,
		handleNamedSessionSelect,
		handleJumpToStarredSession,
		handleUtilityTabSelect,
		handleUtilityFileTabSelect,
		handleFileSearchSelect,
	};
}
