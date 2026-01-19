/**
 * useMobileSessionManagement - Mobile session state management hook
 *
 * Manages session state for the mobile web interface:
 * - Session and tab selection state
 * - Session logs fetching and state
 * - Session selection handlers (select session, tab, new tab, close tab)
 * - Auto-selection of first session
 * - Sync activeTabId when sessions update
 *
 * Extracted from mobile App.tsx for code organization.
 *
 * @example
 * ```tsx
 * const {
 *   sessions,
 *   activeSessionId,
 *   activeSession,
 *   sessionLogs,
 *   isLoadingLogs,
 *   handleSelectSession,
 *   handleSelectTab,
 *   handleNewTab,
 *   handleCloseTab,
 *   sessionsHandlers,
 * } = useMobileSessionManagement({
 *   savedActiveSessionId: loadedState.activeSessionId,
 *   savedActiveTabId: loadedState.activeTabId,
 *   isOffline,
 *   send,
 *   triggerHaptic,
 * });
 * ```
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { Session } from './useSessions';
import type { WebSocketState, AITabData, AutoRunState, CustomCommand } from './useWebSocket';
import { buildApiUrl, getMaestroConfig, updateUrlForSessionTab } from '../utils/config';
import { webLogger } from '../utils/logger';
import type { Theme } from '../../shared/theme-types';

/**
 * Log entry for session message history
 */
export interface LogEntry {
	id: string;
	timestamp: number;
	text: string;
	source: 'user' | 'stdout' | 'stderr';
}

/**
 * Session logs state structure
 */
export interface SessionLogsState {
	aiLogs: LogEntry[];
	shellLogs: LogEntry[];
}

/**
 * Haptic pattern type (single number or array of numbers for vibration patterns)
 */
export type HapticPattern = number | readonly number[];

/**
 * Dependencies for useMobileSessionManagement
 */
export interface UseMobileSessionManagementDeps {
	/** Saved active session ID from view state */
	savedActiveSessionId: string | null;
	/** Saved active tab ID from view state */
	savedActiveTabId: string | null;
	/** Whether the device is offline */
	isOffline: boolean;
	/** Ref to WebSocket send function (updated after useWebSocket is initialized) */
	sendRef: React.RefObject<((message: Record<string, unknown>) => boolean) | null>;
	/** Haptic feedback trigger function */
	triggerHaptic: (pattern?: HapticPattern) => void;
	/** Haptic pattern for tap */
	hapticTapPattern: HapticPattern;
	/** Callback when session response completes (for notifications) */
	onResponseComplete?: (session: Session, response?: unknown) => void;
	/** Callback when theme updates from server */
	onThemeUpdate?: (theme: Theme) => void;
	/** Callback when custom commands are received */
	onCustomCommands?: (commands: CustomCommand[]) => void;
	/** Callback when AutoRun state changes */
	onAutoRunStateChange?: (sessionId: string, state: AutoRunState | null) => void;
}

/**
 * WebSocket handlers for session state updates
 * These should be passed to useWebSocket's handlers option
 */
export interface MobileSessionHandlers {
	onConnectionChange: (newState: WebSocketState) => void;
	onError: (err: string) => void;
	onSessionsUpdate: (newSessions: Session[]) => void;
	onSessionStateChange: (
		sessionId: string,
		state: string,
		additionalData?: Partial<Session>
	) => void;
	onSessionAdded: (session: Session) => void;
	onSessionRemoved: (sessionId: string) => void;
	onActiveSessionChanged: (sessionId: string) => void;
	onSessionOutput: (
		sessionId: string,
		data: string,
		source: 'ai' | 'terminal',
		tabId?: string
	) => void;
	onSessionExit: (sessionId: string, exitCode: number) => void;
	onUserInput: (sessionId: string, command: string, inputMode: 'ai' | 'terminal') => void;
	onThemeUpdate: (theme: Theme) => void;
	onCustomCommands: (commands: CustomCommand[]) => void;
	onAutoRunStateChange: (sessionId: string, state: AutoRunState | null) => void;
	onTabsChanged: (sessionId: string, aiTabs: AITabData[], newActiveTabId: string) => void;
}

/**
 * Return type for useMobileSessionManagement
 */
export interface UseMobileSessionManagementReturn {
	/** All sessions */
	sessions: Session[];
	/** Set sessions state directly */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	/** Currently active session ID */
	activeSessionId: string | null;
	/** Set active session ID directly */
	setActiveSessionId: React.Dispatch<React.SetStateAction<string | null>>;
	/** Currently active tab ID */
	activeTabId: string | null;
	/** Set active tab ID directly */
	setActiveTabId: React.Dispatch<React.SetStateAction<string | null>>;
	/** Currently active session object */
	activeSession: Session | undefined;
	/** Session logs for the active session */
	sessionLogs: SessionLogsState;
	/** Whether logs are currently loading */
	isLoadingLogs: boolean;
	/** Ref tracking active session ID for callbacks */
	activeSessionIdRef: React.RefObject<string | null>;
	/** Handler to select a session (also notifies desktop) */
	handleSelectSession: (sessionId: string) => void;
	/** Handler to select a tab within the active session */
	handleSelectTab: (tabId: string) => void;
	/** Handler to create a new tab in the active session */
	handleNewTab: () => void;
	/** Handler to close a tab in the active session */
	handleCloseTab: (tabId: string) => void;
	/** Add a user input log entry to session logs */
	addUserLogEntry: (text: string, inputMode: 'ai' | 'terminal') => void;
	/** WebSocket handlers for session state updates */
	sessionsHandlers: MobileSessionHandlers;
}

/**
 * Hook for managing session state in the mobile web interface
 *
 * Handles:
 * - Session list state management
 * - Active session/tab selection
 * - Session logs fetching
 * - WebSocket event handlers for session updates
 * - URL synchronization for shareable links
 *
 * @param deps - Dependencies including saved state, network status, and callbacks
 * @returns Session state and handlers
 */
export function useMobileSessionManagement(
	deps: UseMobileSessionManagementDeps
): UseMobileSessionManagementReturn {
	const {
		savedActiveSessionId,
		savedActiveTabId,
		isOffline,
		sendRef,
		triggerHaptic,
		hapticTapPattern,
		onResponseComplete,
		onThemeUpdate,
		onCustomCommands,
		onAutoRunStateChange,
	} = deps;

	// Get URL-based session/tab from config (takes precedence over localStorage)
	const config = getMaestroConfig();
	const urlSessionId = config.sessionId;
	const urlTabId = config.tabId;

	// Session state - URL takes precedence over saved state
	const [sessions, setSessions] = useState<Session[]>([]);
	const [activeSessionId, setActiveSessionId] = useState<string | null>(
		urlSessionId || savedActiveSessionId
	);
	const [activeTabId, setActiveTabId] = useState<string | null>(urlTabId || savedActiveTabId);

	// Session logs state
	const [sessionLogs, setSessionLogs] = useState<SessionLogsState>({
		aiLogs: [],
		shellLogs: [],
	});
	const [isLoadingLogs, setIsLoadingLogs] = useState(false);

	// Track previous session states for detecting busy -> idle transitions
	const previousSessionStatesRef = useRef<Map<string, string>>(new Map());

	// Ref to track activeSessionId for use in callbacks (avoids stale closure issues)
	// Initialize with same value as state to avoid race condition where WebSocket
	// messages arrive before useEffect syncs the ref
	const activeSessionIdRef = useRef<string | null>(urlSessionId || savedActiveSessionId);
	// Ref to track activeTabId for use in callbacks (avoids stale closure issues)
	const activeTabIdRef = useRef<string | null>(urlTabId || savedActiveTabId);

	// Keep activeSessionIdRef in sync with state
	useEffect(() => {
		activeSessionIdRef.current = activeSessionId;
	}, [activeSessionId]);

	// Keep activeTabIdRef in sync with state
	useEffect(() => {
		activeTabIdRef.current = activeTabId;
	}, [activeTabId]);

	// Update URL to reflect current session and tab (for shareable links)
	// Only update if we're in session mode (not dashboard)
	useEffect(() => {
		if (activeSessionId) {
			updateUrlForSessionTab(activeSessionId, activeTabId);
		}
	}, [activeSessionId, activeTabId]);

	// Get active session object
	const activeSession = useMemo(() => {
		return sessions.find((s) => s.id === activeSessionId);
	}, [sessions, activeSessionId]);

	// Fetch session logs when active session or active tab changes
	useEffect(() => {
		if (!activeSessionId || isOffline) {
			setSessionLogs({ aiLogs: [], shellLogs: [] });
			return;
		}

		const fetchSessionLogs = async () => {
			setIsLoadingLogs(true);
			try {
				// Pass tabId explicitly to avoid race conditions with activeTabId sync
				const tabParam = activeTabId ? `?tabId=${activeTabId}` : '';
				const apiUrl = buildApiUrl(`/session/${activeSessionId}${tabParam}`);
				const response = await fetch(apiUrl);
				if (response.ok) {
					const data = await response.json();
					const session = data.session;
					setSessionLogs({
						aiLogs: session?.aiLogs || [],
						shellLogs: session?.shellLogs || [],
					});
					webLogger.debug('Fetched session logs:', 'Mobile', {
						aiLogs: session?.aiLogs?.length || 0,
						shellLogs: session?.shellLogs?.length || 0,
						requestedTabId: activeTabId,
						returnedTabId: session?.activeTabId,
					});
				}
			} catch (err) {
				webLogger.error('Failed to fetch session logs', 'Mobile', err);
			} finally {
				setIsLoadingLogs(false);
			}
		};

		fetchSessionLogs();
	}, [activeSessionId, activeTabId, isOffline]);

	// Handle session selection - also notifies desktop to switch
	const handleSelectSession = useCallback(
		(sessionId: string) => {
			// Find the session to get its activeTabId
			const session = sessions.find((s) => s.id === sessionId);
			// Update refs synchronously BEFORE state updates to avoid race conditions
			// with WebSocket messages arriving during the render cycle
			activeSessionIdRef.current = sessionId;
			activeTabIdRef.current = session?.activeTabId || null;
			setActiveSessionId(sessionId);
			setActiveTabId(session?.activeTabId || null);
			triggerHaptic(hapticTapPattern);
			// Notify desktop to switch to this session (include activeTabId if available)
			sendRef.current?.({
				type: 'select_session',
				sessionId,
				tabId: session?.activeTabId || undefined,
			});
		},
		[sessions, sendRef, triggerHaptic, hapticTapPattern]
	);

	// Handle selecting a tab within a session
	const handleSelectTab = useCallback(
		(tabId: string) => {
			if (!activeSessionId) return;
			triggerHaptic(hapticTapPattern);
			// Notify desktop to switch to this tab
			sendRef.current?.({ type: 'select_tab', sessionId: activeSessionId, tabId });
			// Update ref synchronously to avoid race conditions with WebSocket messages
			activeTabIdRef.current = tabId;
			// Update local activeTabId state directly (triggers log fetch)
			setActiveTabId(tabId);
			// Also update sessions state for UI consistency
			setSessions((prev) =>
				prev.map((s) => (s.id === activeSessionId ? { ...s, activeTabId: tabId } : s))
			);
		},
		[activeSessionId, sendRef, triggerHaptic, hapticTapPattern]
	);

	// Handle creating a new tab
	const handleNewTab = useCallback(() => {
		if (!activeSessionId) return;
		triggerHaptic(hapticTapPattern);
		// Notify desktop to create a new tab
		sendRef.current?.({ type: 'new_tab', sessionId: activeSessionId });
	}, [activeSessionId, sendRef, triggerHaptic, hapticTapPattern]);

	// Handle closing a tab
	const handleCloseTab = useCallback(
		(tabId: string) => {
			if (!activeSessionId) return;
			triggerHaptic(hapticTapPattern);
			// Notify desktop to close this tab
			sendRef.current?.({ type: 'close_tab', sessionId: activeSessionId, tabId });
		},
		[activeSessionId, sendRef, triggerHaptic, hapticTapPattern]
	);

	// Add a user input log entry to session logs
	const addUserLogEntry = useCallback((text: string, inputMode: 'ai' | 'terminal') => {
		const userLogEntry: LogEntry = {
			id: `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
			timestamp: Date.now(),
			text,
			source: 'user',
		};
		setSessionLogs((prev) => {
			const logKey = inputMode === 'ai' ? 'aiLogs' : 'shellLogs';
			return { ...prev, [logKey]: [...prev[logKey], userLogEntry] };
		});
	}, []);

	// WebSocket handlers for session updates
	const sessionsHandlers = useMemo(
		(): MobileSessionHandlers => ({
			onConnectionChange: (newState: WebSocketState) => {
				webLogger.debug(`Connection state: ${newState}`, 'Mobile');
			},
			onError: (err: string) => {
				webLogger.error(`WebSocket error: ${err}`, 'Mobile');
			},
			onSessionsUpdate: (newSessions: Session[]) => {
				webLogger.debug(`Sessions updated: ${newSessions.length}`, 'Mobile');

				// Update previous states map for all sessions
				newSessions.forEach((s) => {
					previousSessionStatesRef.current.set(s.id, s.state);
				});

				setSessions(newSessions);
				// Auto-select first session if none selected, and sync activeTabId
				// Update refs synchronously to avoid race conditions with WebSocket messages
				const currentActiveId = activeSessionIdRef.current;
				if (!currentActiveId && newSessions.length > 0) {
					const firstSession = newSessions[0];
					activeSessionIdRef.current = firstSession.id;
					activeTabIdRef.current = firstSession.activeTabId || null;
					setActiveSessionId(firstSession.id);
					setActiveTabId(firstSession.activeTabId || null);
				} else if (currentActiveId) {
					// Sync activeTabId for current session
					const currentSession = newSessions.find((s) => s.id === currentActiveId);
					if (currentSession) {
						activeTabIdRef.current = currentSession.activeTabId || null;
						setActiveTabId(currentSession.activeTabId || null);
					}
				}
			},
			onSessionStateChange: (
				sessionId: string,
				state: string,
				additionalData?: Partial<Session>
			) => {
				// Check if this is a busy -> idle transition (AI response completed)
				const previousState = previousSessionStatesRef.current.get(sessionId);
				const isResponseComplete = previousState === 'busy' && state === 'idle';

				// Update the previous state
				previousSessionStatesRef.current.set(sessionId, state);

				setSessions((prev) => {
					const updatedSessions = prev.map((s) =>
						s.id === sessionId ? { ...s, state, ...additionalData } : s
					);

					// Show notification if response completed and app is backgrounded
					if (isResponseComplete && onResponseComplete) {
						const session = updatedSessions.find((s) => s.id === sessionId);
						if (session) {
							// Get the response from additionalData or the updated session

							const response =
								(additionalData as any)?.lastResponse || (session as any).lastResponse;
							onResponseComplete(session, response);
						}
					}

					return updatedSessions;
				});
			},
			onSessionAdded: (session: Session) => {
				// Track state for new session
				previousSessionStatesRef.current.set(session.id, session.state);

				setSessions((prev) => {
					if (prev.some((s) => s.id === session.id)) return prev;
					return [...prev, session];
				});
			},
			onSessionRemoved: (sessionId: string) => {
				// Clean up state tracking
				previousSessionStatesRef.current.delete(sessionId);

				setSessions((prev) => prev.filter((s) => s.id !== sessionId));
				// Update refs synchronously if the removed session was active
				if (activeSessionIdRef.current === sessionId) {
					activeSessionIdRef.current = null;
					activeTabIdRef.current = null;
					setActiveSessionId(null);
					setActiveTabId(null);
				}
			},
			onActiveSessionChanged: (sessionId: string) => {
				// Desktop app switched to a different session - sync with web
				webLogger.debug(`Desktop active session changed: ${sessionId}`, 'Mobile');
				// Update refs synchronously BEFORE state updates to avoid race conditions
				activeSessionIdRef.current = sessionId;
				activeTabIdRef.current = null;
				setActiveSessionId(sessionId);
				setActiveTabId(null);
			},
			onSessionOutput: (
				sessionId: string,
				data: string,
				source: 'ai' | 'terminal',
				tabId?: string
			) => {
				// Real-time output from AI or terminal - append to session logs
				const currentActiveId = activeSessionIdRef.current;
				const currentActiveTabId = activeTabIdRef.current;
				webLogger.debug(`Session output: ${sessionId} (${source}) ${data.length} chars`, 'Mobile');
				webLogger.debug('Session output detail', 'Mobile', {
					sessionId,
					activeSessionId: currentActiveId,
					tabId: tabId || 'none',
					activeTabId: currentActiveTabId || 'none',
					source,
					dataLen: data?.length || 0,
				});

				// Only update if this is the active session
				if (currentActiveId !== sessionId) {
					webLogger.debug('Skipping output - not active session', 'Mobile', {
						sessionId,
						activeSessionId: currentActiveId,
					});
					return;
				}

				// For AI output with tabId, only update if this is the active tab
				// This prevents output from newly created tabs appearing in the wrong tab's logs
				if (source === 'ai' && tabId && currentActiveTabId && tabId !== currentActiveTabId) {
					webLogger.debug('Skipping output - not active tab', 'Mobile', {
						sessionId,
						outputTabId: tabId,
						activeTabId: currentActiveTabId,
					});
					return;
				}

				setSessionLogs((prev) => {
					const logKey = source === 'ai' ? 'aiLogs' : 'shellLogs';
					const existingLogs = prev[logKey] || [];

					// Check if the last entry is a streaming entry we should append to
					const lastLog = existingLogs[existingLogs.length - 1];
					const isStreamingAppend =
						lastLog && lastLog.source === 'stdout' && Date.now() - lastLog.timestamp < 5000; // Within 5 seconds

					if (isStreamingAppend) {
						// Append to existing entry
						const updatedLogs = [...existingLogs];
						updatedLogs[updatedLogs.length - 1] = {
							...lastLog,
							text: lastLog.text + data,
						};
						webLogger.debug('Appended to existing log entry', 'Mobile', {
							sessionId,
							source,
							newLength: updatedLogs[updatedLogs.length - 1].text.length,
						});
						return { ...prev, [logKey]: updatedLogs };
					} else {
						// Create new entry
						const newEntry: LogEntry = {
							id: `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
							timestamp: Date.now(),
							source: 'stdout',
							text: data,
						};
						webLogger.debug('Created new log entry', 'Mobile', {
							sessionId,
							source,
							dataLength: data.length,
						});
						return { ...prev, [logKey]: [...existingLogs, newEntry] };
					}
				});
			},
			onSessionExit: (sessionId: string, exitCode: number) => {
				webLogger.debug(`Session exit: ${sessionId} code=${exitCode}`, 'Mobile');
				// Update session state to idle when process exits
				setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, state: 'idle' } : s)));
			},
			onUserInput: (sessionId: string, command: string, inputMode: 'ai' | 'terminal') => {
				// User input from desktop app - add to session logs so web interface stays in sync
				const currentActiveId = activeSessionIdRef.current;
				webLogger.debug(
					`User input from desktop: ${sessionId} (${inputMode}) ${command.substring(0, 50)}`,
					'Mobile',
					{
						sessionId,
						activeSessionId: currentActiveId,
						inputMode,
						commandLength: command.length,
						isActiveSession: currentActiveId === sessionId,
					}
				);

				// Only add if this is the active session
				if (currentActiveId !== sessionId) {
					webLogger.debug('Skipping user input - not active session', 'Mobile', {
						sessionId,
						activeSessionId: currentActiveId,
					});
					return;
				}

				const userLogEntry: LogEntry = {
					id: `user-desktop-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
					timestamp: Date.now(),
					text: command,
					source: 'user',
				};
				setSessionLogs((prev) => {
					const logKey = inputMode === 'ai' ? 'aiLogs' : 'shellLogs';
					return { ...prev, [logKey]: [...prev[logKey], userLogEntry] };
				});
			},
			onThemeUpdate: (theme: Theme) => {
				// Sync theme from desktop app by updating the React context
				webLogger.debug(`Theme update received: ${theme.name} (${theme.mode})`, 'Mobile');
				onThemeUpdate?.(theme);
			},
			onCustomCommands: (commands: CustomCommand[]) => {
				// Custom slash commands from desktop app
				webLogger.debug(`Custom commands received: ${commands.length}`, 'Mobile');
				onCustomCommands?.(commands);
			},
			onAutoRunStateChange: (sessionId: string, state: AutoRunState | null) => {
				// AutoRun (batch processing) state from desktop app
				webLogger.debug(
					`AutoRun state change: ${sessionId} - ${state ? `running (${state.completedTasks}/${state.totalTasks})` : 'stopped'}`,
					'Mobile'
				);
				onAutoRunStateChange?.(sessionId, state);
			},
			onTabsChanged: (sessionId: string, aiTabs: AITabData[], newActiveTabId: string) => {
				// Tab state changed on desktop - update session
				webLogger.debug(
					`Tabs changed: ${sessionId} - ${aiTabs.length} tabs, active: ${newActiveTabId}`,
					'Mobile'
				);
				setSessions((prev) =>
					prev.map((s) => (s.id === sessionId ? { ...s, aiTabs, activeTabId: newActiveTabId } : s))
				);
				// Also update activeTabId ref and state if this is the current session
				const currentSessionId = activeSessionIdRef.current;
				if (currentSessionId === sessionId) {
					activeTabIdRef.current = newActiveTabId;
					setActiveTabId(newActiveTabId);
				}
			},
		}),
		[onResponseComplete, onThemeUpdate, onCustomCommands, onAutoRunStateChange]
	);

	return {
		// State
		sessions,
		setSessions,
		activeSessionId,
		setActiveSessionId,
		activeTabId,
		setActiveTabId,
		activeSession,
		sessionLogs,
		isLoadingLogs,
		activeSessionIdRef,
		// Handlers
		handleSelectSession,
		handleSelectTab,
		handleNewTab,
		handleCloseTab,
		addUserLogEntry,
		sessionsHandlers,
	};
}

export default useMobileSessionManagement;
