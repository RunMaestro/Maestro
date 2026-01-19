import { useEffect, useRef } from 'react';
import type { Session, SessionState } from '../../types';
import { createTab, closeTab } from '../../utils/tabHelpers';

/**
 * Dependencies for the useRemoteIntegration hook.
 * Uses refs for values that change frequently to avoid re-attaching listeners.
 */
export interface UseRemoteIntegrationDeps {
	/** Current active session ID */
	activeSessionId: string;
	/** Whether live mode is enabled (web interface) */
	isLiveMode: boolean;
	/** Ref to current sessions array (avoids stale closures) */
	sessionsRef: React.MutableRefObject<Session[]>;
	/** Ref to current active session ID (avoids stale closures) */
	activeSessionIdRef: React.MutableRefObject<string>;
	/** Session state setter */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	/** Active session ID setter */
	setActiveSessionId: (id: string) => void;
	/** Default value for saveToHistory on new tabs */
	defaultSaveToHistory: boolean;
	/** Default value for showThinking on new tabs */
	defaultShowThinking: boolean;
}

/**
 * Return type for useRemoteIntegration hook.
 * Currently empty as all functionality is side effects.
 */
export interface UseRemoteIntegrationReturn {
	// No return values - all functionality is via side effects
}

/**
 * Hook for handling web interface communication.
 *
 * Sets up listeners for remote commands from the web interface:
 * - Active session broadcast to web clients
 * - Remote command listener (dispatches event for App.tsx to handle)
 * - Remote mode switching
 * - Remote interrupt handling
 * - Remote session/tab selection
 * - Remote tab creation and closing
 * - Tab change broadcasting to web clients
 *
 * All effects have explicit cleanup functions to prevent memory leaks.
 *
 * @param deps - Hook dependencies
 * @returns Empty object (all functionality via side effects)
 */
export function useRemoteIntegration(deps: UseRemoteIntegrationDeps): UseRemoteIntegrationReturn {
	const {
		activeSessionId,
		isLiveMode,
		sessionsRef,
		activeSessionIdRef,
		setSessions,
		setActiveSessionId,
		defaultSaveToHistory,
		defaultShowThinking,
	} = deps;

	// Broadcast active session change to web clients
	useEffect(() => {
		if (activeSessionId && isLiveMode) {
			window.maestro.live.broadcastActiveSession(activeSessionId);
		}
	}, [activeSessionId, isLiveMode]);

	// Handle remote commands from web interface
	// This allows web commands to go through the exact same code path as desktop commands
	useEffect(() => {
		console.log('[useRemoteIntegration] Setting up onRemoteCommand listener');
		const unsubscribeRemote = window.maestro.process.onRemoteCommand(
			(sessionId: string, command: string, inputMode?: 'ai' | 'terminal') => {
				console.log('[useRemoteIntegration] onRemoteCommand callback invoked:', {
					sessionId,
					command: command?.substring(0, 50),
					inputMode,
				});

				// Verify the session exists
				const targetSession = sessionsRef.current.find((s) => s.id === sessionId);
				console.log('[useRemoteIntegration] Target session lookup:', {
					found: !!targetSession,
					sessionCount: sessionsRef.current.length,
					availableIds: sessionsRef.current.map((s) => s.id),
				});

				if (!targetSession) {
					console.warn('[useRemoteIntegration] Session not found, dropping command');
					return;
				}

				// Check if session is busy (should have been checked by web server, but double-check)
				if (targetSession.state === 'busy') {
					console.warn(
						'[useRemoteIntegration] Session is busy, dropping command. State:',
						targetSession.state
					);
					return;
				}
				console.log('[useRemoteIntegration] Session state check passed:', targetSession.state);

				// If web provided an inputMode, sync the session state before executing
				// This ensures the renderer uses the same mode the web intended
				if (inputMode && targetSession.inputMode !== inputMode) {
					setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, inputMode } : s)));
				}

				// Switch to the target session (for visual feedback)
				setActiveSessionId(sessionId);
				console.log('[useRemoteIntegration] Switched active session to:', sessionId);

				// Dispatch event directly - handleRemoteCommand handles all the logic
				// Don't set inputValue - we don't want command text to appear in the input bar
				// Pass the inputMode from web so handleRemoteCommand uses it
				console.log('[useRemoteIntegration] Dispatching maestro:remoteCommand event:', {
					sessionId,
					command: command?.substring(0, 50),
					inputMode,
				});
				window.dispatchEvent(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId, command, inputMode },
					})
				);
				console.log('[useRemoteIntegration] Event dispatched successfully');
			}
		);

		return () => {
			unsubscribeRemote();
		};
	}, [sessionsRef, setSessions, setActiveSessionId]);

	// Handle remote mode switches from web interface
	// This allows web mode switches to go through the same code path as desktop
	useEffect(() => {
		const unsubscribeSwitchMode = window.maestro.process.onRemoteSwitchMode(
			(sessionId: string, mode: 'ai' | 'terminal') => {
				// Find the session and update its mode
				setSessions((prev) => {
					const session = prev.find((s) => s.id === sessionId);
					if (!session) {
						return prev;
					}

					// Only switch if mode is different
					if (session.inputMode === mode) {
						return prev;
					}

					return prev.map((s) => {
						if (s.id !== sessionId) return s;
						return { ...s, inputMode: mode };
					});
				});
			}
		);

		return () => {
			unsubscribeSwitchMode();
		};
	}, [setSessions]);

	// Handle remote interrupts from web interface
	// This allows web interrupts to go through the same code path as desktop (handleInterrupt)
	useEffect(() => {
		const unsubscribeInterrupt = window.maestro.process.onRemoteInterrupt(
			async (sessionId: string) => {
				// Find the session
				const session = sessionsRef.current.find((s) => s.id === sessionId);
				if (!session) {
					return;
				}

				// Use the same logic as handleInterrupt
				const currentMode = session.inputMode;
				const targetSessionId =
					currentMode === 'ai' ? `${session.id}-ai` : `${session.id}-terminal`;

				try {
					// Send interrupt signal (Ctrl+C)
					await window.maestro.process.interrupt(targetSessionId);

					// Set state to idle (same as handleInterrupt)
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== session.id) return s;
							return {
								...s,
								state: 'idle' as SessionState,
								busySource: undefined,
								thinkingStartTime: undefined,
							};
						})
					);
				} catch (error) {
					console.error('[Remote] Failed to interrupt session:', error);
				}
			}
		);

		return () => {
			unsubscribeInterrupt();
		};
	}, [sessionsRef, setSessions]);

	// Handle remote session selection from web interface
	// This allows web clients to switch the active session in the desktop app
	// If tabId is provided, also switches to that tab within the session
	useEffect(() => {
		const unsubscribeSelectSession = window.maestro.process.onRemoteSelectSession(
			(sessionId: string, tabId?: string) => {
				// Check if session exists
				const session = sessionsRef.current.find((s) => s.id === sessionId);
				if (!session) {
					return;
				}

				// Switch to the session (same as clicking in SessionList)
				setActiveSessionId(sessionId);

				// If tabId provided, also switch to that tab
				if (tabId) {
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							// Check if tab exists
							if (!s.aiTabs.some((t) => t.id === tabId)) {
								return s;
							}
							return { ...s, activeTabId: tabId };
						})
					);
				}
			}
		);

		// Handle remote tab selection from web interface
		// This also switches to the session if not already active
		const unsubscribeSelectTab = window.maestro.process.onRemoteSelectTab(
			(sessionId: string, tabId: string) => {
				// First, switch to the session if not already active
				const currentActiveId = activeSessionIdRef.current;
				if (currentActiveId !== sessionId) {
					setActiveSessionId(sessionId);
				}

				// Then update the active tab within the session
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						// Check if tab exists
						if (!s.aiTabs.some((t) => t.id === tabId)) {
							return s;
						}
						return { ...s, activeTabId: tabId };
					})
				);
			}
		);

		// Handle remote new tab from web interface
		const unsubscribeNewTab = window.maestro.process.onRemoteNewTab(
			(sessionId: string, responseChannel: string) => {
				let newTabId: string | null = null;

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;

						// Use createTab helper
						const result = createTab(s, {
							saveToHistory: defaultSaveToHistory,
							showThinking: defaultShowThinking,
						});
						if (!result) return s;
						newTabId = result.tab.id;
						return result.session;
					})
				);

				// Send response back with the new tab ID
				if (newTabId) {
					window.maestro.process.sendRemoteNewTabResponse(responseChannel, { tabId: newTabId });
				} else {
					window.maestro.process.sendRemoteNewTabResponse(responseChannel, null);
				}
			}
		);

		// Handle remote close tab from web interface
		const unsubscribeCloseTab = window.maestro.process.onRemoteCloseTab(
			(sessionId: string, tabId: string) => {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;

						// Use closeTab helper (handles last tab by creating a fresh one)
						const result = closeTab(s, tabId);
						return result?.session ?? s;
					})
				);
			}
		);

		// Handle remote rename tab from web interface
		const unsubscribeRenameTab = window.maestro.process.onRemoteRenameTab(
			(sessionId: string, tabId: string, newName: string) => {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;

						// Find the tab to get its agentSessionId for persistence
						const tab = s.aiTabs.find((t) => t.id === tabId);
						if (!tab) {
							return s;
						}

						// Persist name to agent session metadata (async, fire and forget)
						// Use projectRoot (not cwd) for consistent session storage access
						if (tab.agentSessionId) {
							const agentId = s.toolType || 'claude-code';
							if (agentId === 'claude-code') {
								window.maestro.claude
									.updateSessionName(s.projectRoot, tab.agentSessionId, newName || '')
									.catch((err) => console.error('Failed to persist tab name:', err));
							} else {
								window.maestro.agentSessions
									.setSessionName(agentId, s.projectRoot, tab.agentSessionId, newName || null)
									.catch((err) => console.error('Failed to persist tab name:', err));
							}
							// Also update past history entries with this agentSessionId
							window.maestro.history
								.updateSessionName(tab.agentSessionId, newName || '')
								.catch((err) => console.error('Failed to update history session names:', err));
						}

						return {
							...s,
							aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, name: newName || null } : t)),
						};
					})
				);
			}
		);

		return () => {
			unsubscribeSelectSession();
			unsubscribeSelectTab();
			unsubscribeNewTab();
			unsubscribeCloseTab();
			unsubscribeRenameTab();
		};
	}, [sessionsRef, activeSessionIdRef, setSessions, setActiveSessionId, defaultSaveToHistory]);

	// Broadcast tab changes to web clients when tabs, activeTabId, or tab properties change
	// PERFORMANCE FIX: This effect was previously missing its dependency array, causing it to
	// run on EVERY render (including every keystroke). Now it only runs when isLiveMode changes,
	// and uses the sessionsRef to avoid reacting to every session state change.
	// The internal comparison logic ensures broadcasts only happen when actually needed.
	const prevTabsRef = useRef<
		Map<string, { tabCount: number; activeTabId: string; tabsHash: string }>
	>(new Map());

	// Track previous session states for broadcasting state changes to web clients
	// This is separate from tab changes because session state (busy/idle) changes need
	// to be broadcast immediately for proper UI feedback on the web interface
	const prevSessionStatesRef = useRef<Map<string, string>>(new Map());

	// Only set up the interval when live mode is active
	useEffect(() => {
		// Skip entirely if not in live mode - no web clients to broadcast to
		if (!isLiveMode) return;

		// Use an interval to periodically check for changes instead of running on every render
		// This dramatically reduces CPU usage during normal typing
		const intervalId = setInterval(() => {
			const sessions = sessionsRef.current;

			sessions.forEach((session) => {
				// Broadcast session state changes (busy/idle) to web clients
				// This bypasses the debounced persistence which resets state to 'idle' before saving
				const prevState = prevSessionStatesRef.current.get(session.id);
				if (prevState !== session.state) {
					window.maestro.web.broadcastSessionState(session.id, session.state, {
						name: session.name,
						toolType: session.toolType,
						inputMode: session.inputMode,
						cwd: session.cwd,
					});
					prevSessionStatesRef.current.set(session.id, session.state);
				}

				if (!session.aiTabs || session.aiTabs.length === 0) return;

				// Create a hash of tab properties that should trigger a broadcast when changed
				const tabsHash = session.aiTabs
					.map((t) => `${t.id}:${t.name || ''}:${t.starred}:${t.state}`)
					.join('|');

				const prev = prevTabsRef.current.get(session.id);
				const current = {
					tabCount: session.aiTabs.length,
					activeTabId: session.activeTabId || session.aiTabs[0]?.id || '',
					tabsHash,
				};

				// Check if anything changed
				if (
					!prev ||
					prev.tabCount !== current.tabCount ||
					prev.activeTabId !== current.activeTabId ||
					prev.tabsHash !== current.tabsHash
				) {
					const tabsForBroadcast = session.aiTabs.map((tab) => ({
						id: tab.id,
						agentSessionId: tab.agentSessionId,
						name: tab.name,
						starred: tab.starred,
						inputValue: tab.inputValue,
						usageStats: tab.usageStats,
						createdAt: tab.createdAt,
						state: tab.state,
						thinkingStartTime: tab.thinkingStartTime,
					}));

					window.maestro.web.broadcastTabsChange(session.id, tabsForBroadcast, current.activeTabId);

					prevTabsRef.current.set(session.id, current);
				}
			});
		}, 500); // Check every 500ms - fast enough for good UX, slow enough to not impact typing

		return () => clearInterval(intervalId);
	}, [isLiveMode, sessionsRef]);

	return {};
}
