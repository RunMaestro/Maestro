/**
 * SessionsContext - Shared context for Maestro sessions data
 *
 * This context provides sessions list and active session state to all components
 * in the app, enabling the drawer to display sessions and the chat screen to
 * use the selected session. The WebSocket connection is managed here and shared
 * across components.
 */

import React, {
	createContext,
	useContext,
	useCallback,
	useState,
	useRef,
	useEffect,
	useMemo,
} from 'react';
import { useRouter } from 'expo-router';
import { useMaestroConnection } from '@/hooks/useMaestroConnection';
import { clearCredentials } from './credentials';
import {
	type AITabData,
	type SessionData,
	type SessionHistoryResult,
	type ToolEventLog,
	type WebSocketState,
} from './useMaestroWebSocket';
import type { Theme } from '@maestro/shared/theme-types';

// Re-export types for consumers
export type {
	SessionData,
	AITabData,
	ToolEventLog,
	SessionHistoryMessage,
	SessionHistoryResult,
} from './useMaestroWebSocket';

// ============================================================================
// Subscriber callback signatures
// ============================================================================

export type SessionOutputHandler = (
	sessionId: string,
	data: string,
	source: 'ai' | 'terminal',
	tabId?: string
) => void;

export type SessionStateChangeHandler = (sessionId: string, state: string) => void;

export type SessionExitHandler = (sessionId: string, tabId?: string) => void;

export type ToolEventHandler = (sessionId: string, tabId: string, toolLog: ToolEventLog) => void;

export type UserInputHandler = (
	sessionId: string,
	command: string,
	inputMode: 'ai' | 'terminal'
) => void;

export type CommandResultHandler = (sessionId: string, success: boolean, tabId?: string) => void;

/** Fired when a long background pause invalidated any in-flight streaming buffer. */
export type StaleBufferHandler = () => void;

export type Unsubscribe = () => void;

// ============================================================================
// Types
// ============================================================================

export interface SessionsContextValue {
	// Connection state
	connectionState: WebSocketState;
	isAuthenticated: boolean;
	error: string | null;

	// Sessions data
	sessions: SessionData[];
	activeSessionId: string | null;
	activeSession: SessionData | null;

	// Actions
	setActiveSessionId: (sessionId: string) => void;
	/**
	 * Tell the desktop this client wants live `tool_event` / per-session
	 * messages for `sessionId`. The desktop's `broadcastToolEvent` only fans
	 * out to clients whose `subscribedSessionId` matches, so without this the
	 * mobile UI misses Running/Completed tool updates mid-turn.
	 */
	subscribeToSession: (sessionId: string) => boolean;
	setActiveTab: (sessionId: string, tabId: string) => boolean;
	/** Create a new AI tab within a session. Returns false if the socket is down. */
	newTab: (sessionId: string) => boolean;
	/** Close an AI tab within a session. Returns false if the socket is down. */
	closeTab: (sessionId: string, tabId: string) => boolean;
	connect: () => void;
	disconnect: () => void;
	/**
	 * Ask the desktop to resend the full sessions list (pull-to-refresh). Resolves
	 * once the refreshed `sessions_list` arrives, or after a short timeout / if the
	 * socket is down, so a spinner never hangs.
	 */
	refreshSessions: () => Promise<void>;
	sendCommand: (sessionId: string, command: string, tabId?: string) => boolean;
	/**
	 * Fetch a tab's conversation backlog from the desktop. Resolves with the
	 * history payload (oldest first) or rejects if the desktop returns an error,
	 * the socket drops, or the request times out.
	 */
	requestSessionHistory: (
		tabId: string,
		options?: { sinceMs?: number; tail?: number; timeoutMs?: number }
	) => Promise<SessionHistoryResult>;

	// Event subscriptions (single WebSocket fans out to all subscribers).
	// Each subscriber MUST call the returned Unsubscribe in a useEffect cleanup
	// to avoid leaking handlers across screen mounts.
	subscribeSessionOutput: (handler: SessionOutputHandler) => Unsubscribe;
	subscribeSessionStateChange: (handler: SessionStateChangeHandler) => Unsubscribe;
	subscribeSessionExit: (handler: SessionExitHandler) => Unsubscribe;
	subscribeToolEvent: (handler: ToolEventHandler) => Unsubscribe;
	subscribeUserInput: (handler: UserInputHandler) => Unsubscribe;
	subscribeCommandResult: (handler: CommandResultHandler) => Unsubscribe;
	/**
	 * Subscribe to stale-buffer notifications. Fired once after the app returns
	 * to the foreground following a background pause long enough to invalidate
	 * any in-flight streaming turn, so chat screens can drop the partial
	 * assistant bubble and unstick `isGenerating`.
	 */
	subscribeStaleBuffer: (handler: StaleBufferHandler) => Unsubscribe;
}

// ============================================================================
// Context
// ============================================================================

const SessionsContext = createContext<SessionsContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface SessionsProviderProps {
	children: React.ReactNode;
	/** Optional callback for theme updates (used by AccentProvider) */
	onThemeUpdate?: (theme: Theme) => void;
}

export function SessionsProvider({ children, onThemeUpdate }: SessionsProviderProps) {
	const router = useRouter();

	// Sessions state
	const [sessions, setSessions] = useState<SessionData[]>([]);
	const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

	// Track active session ID in ref for callback stability
	const activeSessionIdRef = useRef<string | null>(null);

	// Track theme callback in ref for callback stability
	const onThemeUpdateRef = useRef(onThemeUpdate);

	// Latch so we only route back to /pair once per AUTH_FAILED event.
	const authFailedHandledRef = useRef(false);

	// One-shot resolvers for in-flight refreshSessions() calls. Drained when the
	// next `sessions_list` arrives so pull-to-refresh resolves on real data.
	const pendingRefreshResolversRef = useRef<(() => void)[]>([]);

	// Subscriber registries. Using Sets gives O(1) add/remove and natural dedupe,
	// and a single WebSocket fans out to every screen that registered.
	const sessionOutputSubs = useRef(new Set<SessionOutputHandler>());
	const sessionStateChangeSubs = useRef(new Set<SessionStateChangeHandler>());
	const sessionExitSubs = useRef(new Set<SessionExitHandler>());
	const toolEventSubs = useRef(new Set<ToolEventHandler>());
	const userInputSubs = useRef(new Set<UserInputHandler>());
	const commandResultSubs = useRef(new Set<CommandResultHandler>());
	const staleBufferSubs = useRef(new Set<StaleBufferHandler>());

	// Keep refs in sync with props/state (must be in useEffect per React 19 rules)
	useEffect(() => {
		activeSessionIdRef.current = activeSessionId;
	}, [activeSessionId]);

	useEffect(() => {
		onThemeUpdateRef.current = onThemeUpdate;
	}, [onThemeUpdate]);

	// WebSocket connection, wrapped in useMaestroConnection so AppState/NetInfo
	// transitions tear down the socket on background and reconnect on foreground,
	// and so the streaming buffer gets marked stale after a long pause.
	const {
		wsState: connectionState,
		isAuthenticated,
		error,
		connect,
		disconnect,
		send,
		requestSessionHistory,
	} = useMaestroConnection({
		autoReconnect: true,
		// A long background pause invalidates any half-streamed assistant turn:
		// the desktop has likely finished (or moved on) by the time we foreground
		// and reconnect. Fan that out so chat screens drop the stale partial
		// bubble and unstick `isGenerating` instead of staying blocked until some
		// later idle/exit event arrives.
		onStaleBufferDiscarded: () => {
			staleBufferSubs.current.forEach((handler) => {
				try {
					handler();
				} catch (err) {
					console.error('[SessionsContext] onStaleBufferDiscarded subscriber threw', err);
				}
			});
		},
		handlers: {
			onAuthFailed: () => {
				// Desktop revoked the token (or it expired). Wipe credentials and
				// kick the user back to the pairing screen instead of looping.
				if (authFailedHandledRef.current) return;
				authFailedHandledRef.current = true;
				void clearCredentials()
					.catch((err) => {
						console.warn('[SessionsContext] Failed to clear credentials after AUTH_FAILED', err);
					})
					.finally(() => {
						router.replace('/pair');
					});
			},
			onSessionsUpdate: (newSessions: SessionData[]) => {
				setSessions(newSessions);

				// Auto-select first session if none selected
				if (!activeSessionIdRef.current && newSessions.length > 0) {
					setActiveSessionId(newSessions[0].id);
				}

				// Clear active session if it no longer exists
				if (activeSessionIdRef.current) {
					const stillExists = newSessions.some((s) => s.id === activeSessionIdRef.current);
					if (!stillExists) {
						setActiveSessionId(newSessions.length > 0 ? newSessions[0].id : null);
					}
				}

				// Resolve any in-flight pull-to-refresh now that fresh data landed.
				const resolvers = pendingRefreshResolversRef.current;
				pendingRefreshResolversRef.current = [];
				resolvers.forEach((resolve) => resolve());
			},
			onSessionAdded: (session: SessionData) => {
				// The desktop sends an incremental add when an agent is created;
				// merge it in (replace if it somehow already exists) so the sidebar
				// updates live without a reconnect. Auto-select if nothing is active.
				setSessions((prev) => {
					if (prev.some((s) => s.id === session.id)) {
						return prev.map((s) => (s.id === session.id ? { ...s, ...session } : s));
					}
					return [...prev, session];
				});
				if (!activeSessionIdRef.current) {
					setActiveSessionId(session.id);
				}
			},
			onSessionRemoved: (sessionId: string) => {
				setSessions((prev) => {
					const next = prev.filter((s) => s.id !== sessionId);
					// If the removed session was active, fall back to the first
					// remaining session (or none) to keep selection valid.
					if (activeSessionIdRef.current === sessionId) {
						setActiveSessionId(next.length > 0 ? next[0].id : null);
					}
					return next;
				});
			},
			onSessionStateChange: (sessionId, state) => {
				// Update session state in local list
				setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, state } : s)));
				// Fan out to screen subscribers
				sessionStateChangeSubs.current.forEach((handler) => {
					try {
						handler(sessionId, state);
					} catch (err) {
						console.error('[SessionsContext] onSessionStateChange subscriber threw', err);
					}
				});
			},
			onSessionOutput: (sessionId, data, source, tabId) => {
				sessionOutputSubs.current.forEach((handler) => {
					try {
						handler(sessionId, data, source, tabId);
					} catch (err) {
						console.error('[SessionsContext] onSessionOutput subscriber threw', err);
					}
				});
			},
			onSessionExit: (sessionId, tabId) => {
				sessionExitSubs.current.forEach((handler) => {
					try {
						handler(sessionId, tabId);
					} catch (err) {
						console.error('[SessionsContext] onSessionExit subscriber threw', err);
					}
				});
			},
			onCommandResult: (sessionId, success, tabId) => {
				commandResultSubs.current.forEach((handler) => {
					try {
						handler(sessionId, success, tabId);
					} catch (err) {
						console.error('[SessionsContext] onCommandResult subscriber threw', err);
					}
				});
			},
			onToolEvent: (sessionId, tabId, toolLog) => {
				toolEventSubs.current.forEach((handler) => {
					try {
						handler(sessionId, tabId, toolLog);
					} catch (err) {
						console.error('[SessionsContext] onToolEvent subscriber threw', err);
					}
				});
			},
			onUserInput: (sessionId, command, inputMode) => {
				userInputSubs.current.forEach((handler) => {
					try {
						handler(sessionId, command, inputMode);
					} catch (err) {
						console.error('[SessionsContext] onUserInput subscriber threw', err);
					}
				});
			},
			onTabsChanged: (sessionId, aiTabs, activeTabId) => {
				// Update session's tabs in local list
				setSessions((prev) =>
					prev.map((s) => (s.id === sessionId ? { ...s, aiTabs, activeTabId } : s))
				);
			},
			onTabCreated: (sessionId, tabId) => {
				// Optimistically add and activate the freshly-created tab so the
				// strip updates without waiting on the desktop's `tabs_changed`
				// poll. If the tab already arrived via a broadcast, just activate
				// it. The authoritative `tabs_changed`/reconnect later reconciles
				// names, state, etc. (this replaces the whole aiTabs array).
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						if (s.aiTabs?.some((t) => t.id === tabId)) {
							return { ...s, activeTabId: tabId };
						}
						const newTab: AITabData = {
							id: tabId,
							agentSessionId: null,
							name: null,
							starred: false,
							inputValue: '',
							createdAt: Date.now(),
							state: 'idle',
						};
						return { ...s, aiTabs: [...(s.aiTabs ?? []), newTab], activeTabId: tabId };
					})
				);
			},
			onTabClosed: (sessionId, tabId) => {
				// Optimistically drop the closed tab. If it was the active tab,
				// fall back to its neighbour (previous, else next) so the strip
				// always has a valid selection. A later `tabs_changed`/reconnect
				// reconciles authoritatively.
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						const tabs = s.aiTabs ?? [];
						const idx = tabs.findIndex((t) => t.id === tabId);
						if (idx === -1) return s;
						const remaining = tabs.filter((t) => t.id !== tabId);
						let activeTabId = s.activeTabId;
						if (activeTabId === tabId) {
							const neighbour = remaining[idx - 1] ?? remaining[idx] ?? remaining[0];
							activeTabId = neighbour?.id ?? '';
						}
						return { ...s, aiTabs: remaining, activeTabId };
					})
				);
			},
			onThemeUpdate: (theme) => {
				// Forward theme updates to AccentProvider (per decision 5C)
				onThemeUpdateRef.current?.(theme);
			},
		},
	});

	// Reset the AUTH_FAILED latch once the socket handshakes again, so a later
	// revoke still triggers the navigation back to /pair. The mobile pairing
	// handshake settles as a bare `connected` (the desktop never sends
	// `authenticated: true` for it), so latching only on `authenticated` would
	// leave the flag stuck after a successful re-pair and swallow the next revoke.
	useEffect(() => {
		if (connectionState === 'authenticated' || connectionState === 'connected') {
			authFailedHandledRef.current = false;
		}
	}, [connectionState]);

	// Derived active session
	const activeSession = useMemo(
		() => sessions.find((s) => s.id === activeSessionId) || null,
		[sessions, activeSessionId]
	);

	// Ask the desktop to resend the full sessions list. Used by pull-to-refresh
	// as a manual fallback to the live `session_added`/`session_removed` deltas.
	const refreshSessions = useCallback((): Promise<void> => {
		return new Promise<void>((resolve) => {
			const sent = send({ type: 'get_sessions' });
			if (!sent) {
				// Socket down - nothing will arrive, so don't leave the spinner hanging.
				resolve();
				return;
			}
			let settled = false;
			const settle = () => {
				if (settled) return;
				settled = true;
				resolve();
			};
			pendingRefreshResolversRef.current.push(settle);
			// Safety net: resolve even if no `sessions_list` comes back.
			setTimeout(settle, 5000);
		});
	}, [send]);

	// Tell the desktop to start fanning tool events for this session. The
	// desktop's broadcastToolEvent is gated on subscribedSessionId, and select_tab
	// (which the mobile already sends) does NOT update that subscription on the
	// server. Without this explicit subscribe, mobile users see Running/Completed
	// tool updates only after history reloads.
	const subscribeToSession = useCallback(
		(sessionId: string): boolean => {
			return send({
				type: 'subscribe',
				sessionId,
			});
		},
		[send]
	);

	// Send command to a session. tabId pins delivery to a specific AI tab so a
	// background tab the user queued into still receives the prompt even if the
	// foreground tab changed between queue and replay.
	const sendCommand = useCallback(
		(sessionId: string, command: string, tabId?: string): boolean => {
			const message: Record<string, unknown> = {
				type: 'send_command',
				sessionId,
				command,
				inputMode: 'ai',
			};
			if (tabId) message.tabId = tabId;
			return send(message);
		},
		[send]
	);

	// Set active tab within a session. The desktop web-server expects the
	// `select_tab` message type; it has no `set_active_tab` case. The desktop
	// broadcasts a `tabs_changed` event afterwards, which updates activeTabId
	// for the strip's highlight.
	const setActiveTab = useCallback(
		(sessionId: string, tabId: string): boolean => {
			return send({
				type: 'select_tab',
				sessionId,
				tabId,
			});
		},
		[send]
	);

	// Create a new AI tab within a session. The desktop creates the tab and
	// replies with `new_tab_result`, which the client handles optimistically.
	const newTab = useCallback(
		(sessionId: string): boolean => {
			return send({
				type: 'new_tab',
				sessionId,
			});
		},
		[send]
	);

	// Close an AI tab within a session. The desktop replies with
	// `close_tab_result`, which the client handles optimistically (the
	// `tabs_changed` broadcast that would normally confirm this can be gated).
	const closeTab = useCallback(
		(sessionId: string, tabId: string): boolean => {
			return send({
				type: 'close_tab',
				sessionId,
				tabId,
			});
		},
		[send]
	);

	// Subscribe helpers. Stable identity via useCallback so consumers can put
	// them in useEffect deps without re-running the effect every render.
	const subscribeSessionOutput = useCallback((handler: SessionOutputHandler): Unsubscribe => {
		sessionOutputSubs.current.add(handler);
		return () => {
			sessionOutputSubs.current.delete(handler);
		};
	}, []);

	const subscribeSessionStateChange = useCallback(
		(handler: SessionStateChangeHandler): Unsubscribe => {
			sessionStateChangeSubs.current.add(handler);
			return () => {
				sessionStateChangeSubs.current.delete(handler);
			};
		},
		[]
	);

	const subscribeSessionExit = useCallback((handler: SessionExitHandler): Unsubscribe => {
		sessionExitSubs.current.add(handler);
		return () => {
			sessionExitSubs.current.delete(handler);
		};
	}, []);

	const subscribeToolEvent = useCallback((handler: ToolEventHandler): Unsubscribe => {
		toolEventSubs.current.add(handler);
		return () => {
			toolEventSubs.current.delete(handler);
		};
	}, []);

	const subscribeUserInput = useCallback((handler: UserInputHandler): Unsubscribe => {
		userInputSubs.current.add(handler);
		return () => {
			userInputSubs.current.delete(handler);
		};
	}, []);

	const subscribeCommandResult = useCallback((handler: CommandResultHandler): Unsubscribe => {
		commandResultSubs.current.add(handler);
		return () => {
			commandResultSubs.current.delete(handler);
		};
	}, []);

	const subscribeStaleBuffer = useCallback((handler: StaleBufferHandler): Unsubscribe => {
		staleBufferSubs.current.add(handler);
		return () => {
			staleBufferSubs.current.delete(handler);
		};
	}, []);

	const value: SessionsContextValue = {
		connectionState,
		isAuthenticated,
		error,
		sessions,
		activeSessionId,
		activeSession,
		setActiveSessionId,
		subscribeToSession,
		setActiveTab,
		newTab,
		closeTab,
		connect,
		disconnect,
		refreshSessions,
		sendCommand,
		requestSessionHistory,
		subscribeSessionOutput,
		subscribeSessionStateChange,
		subscribeSessionExit,
		subscribeToolEvent,
		subscribeUserInput,
		subscribeCommandResult,
		subscribeStaleBuffer,
	};

	return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>;
}

// ============================================================================
// Hook
// ============================================================================

export function useSessions(): SessionsContextValue {
	const context = useContext(SessionsContext);
	if (!context) {
		throw new Error('useSessions must be used within a SessionsProvider');
	}
	return context;
}

export default SessionsContext;
