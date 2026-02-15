/**
 * sessionStore - Zustand store for centralized session and group state management
 *
 * All session, group, active session, bookmark, worktree tracking, and
 * initialization states live here. Components subscribe to individual slices
 * via selectors to avoid unnecessary re-renders.
 *
 * Key advantages:
 * - Selector-based subscriptions: components only re-render when their slice changes
 * - No refs needed: store.getState() gives current state anywhere
 * - Works outside React: services and orchestrators can read/write store directly
 *
 * Can be used outside React via useSessionStore.getState() / useSessionStore.setState().
 */

import { create } from 'zustand';
import type { Session, Group, LogEntry } from '../types';
import { generateId } from '../utils/ids';
import { getActiveTab } from '../utils/tabHelpers';

// ============================================================================
// Store Types
// ============================================================================

export interface SessionStoreState {
	// Core entities
	sessions: Session[];
	groups: Group[];

	// Active session
	activeSessionId: string;

	// Initialization
	sessionsLoaded: boolean;
	initialLoadComplete: boolean;

	// Worktree tracking (prevents re-discovery of manually removed worktrees)
	removedWorktreePaths: Set<string>;

	// Navigation cycling position (for Cmd+J/K session cycling)
	cyclePosition: number;
}

export interface SessionStoreActions {
	// === Session CRUD ===

	/**
	 * Set the sessions array. Supports both direct value and functional updater
	 * to match React's setState signature (200+ call sites use the updater form).
	 */
	setSessions: (sessions: Session[] | ((prev: Session[]) => Session[])) => void;

	/** Add a single session to the end of the list. */
	addSession: (session: Session) => void;

	/** Remove a session by ID. */
	removeSession: (id: string) => void;

	/**
	 * Update a session by ID with a partial update.
	 * More efficient than setSessions for single-session updates.
	 */
	updateSession: (id: string, updates: Partial<Session>) => void;

	// === Active session ===

	/**
	 * Set the active session ID.
	 * Resets cycle position (so next Cmd+J/K starts fresh).
	 */
	setActiveSessionId: (id: string) => void;

	/**
	 * Set the active session ID without resetting cycle position.
	 * Used internally by session cycling (Cmd+J/K).
	 */
	setActiveSessionIdInternal: (id: string | ((prev: string) => string)) => void;

	// === Groups ===

	/**
	 * Set the groups array. Supports both direct value and functional updater.
	 */
	setGroups: (groups: Group[] | ((prev: Group[]) => Group[])) => void;

	/** Add a single group. */
	addGroup: (group: Group) => void;

	/** Remove a group by ID. */
	removeGroup: (id: string) => void;

	/** Update a group by ID with a partial update. */
	updateGroup: (id: string, updates: Partial<Group>) => void;

	/** Toggle a group's collapsed state. */
	toggleGroupCollapsed: (id: string) => void;

	// === Initialization ===

	setSessionsLoaded: (loaded: boolean | ((prev: boolean) => boolean)) => void;
	setInitialLoadComplete: (complete: boolean | ((prev: boolean) => boolean)) => void;

	// === Bookmarks ===

	/** Toggle the bookmark flag on a session. */
	toggleBookmark: (sessionId: string) => void;

	// === Worktree tracking ===

	/** Mark a worktree path as removed (prevents re-discovery during this session). */
	addRemovedWorktreePath: (path: string) => void;

	/** Replace the entire removed worktree paths set. */
	setRemovedWorktreePaths: (paths: Set<string> | ((prev: Set<string>) => Set<string>)) => void;

	// === Navigation ===

	setCyclePosition: (pos: number) => void;
	resetCyclePosition: () => void;

	// === Log management ===

	/**
	 * Add a log entry to a specific tab's logs (or active tab if no tabId provided).
	 * Used for slash commands, system messages, queued items, etc.
	 */
	addLogToTab: (
		sessionId: string,
		logEntry: Omit<LogEntry, 'id' | 'timestamp'> & { id?: string; timestamp?: number },
		tabId?: string
	) => void;
}

export type SessionStore = SessionStoreState & SessionStoreActions;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Helper to resolve a value-or-updater argument, matching React's setState signature.
 */
function resolve<T>(valOrFn: T | ((prev: T) => T), prev: T): T {
	return typeof valOrFn === 'function' ? (valOrFn as (prev: T) => T)(prev) : valOrFn;
}

// ============================================================================
// Store Implementation
// ============================================================================

export const useSessionStore = create<SessionStore>()((set) => ({
	// --- State ---
	sessions: [],
	groups: [],
	activeSessionId: '',
	sessionsLoaded: false,
	initialLoadComplete: false,
	removedWorktreePaths: new Set(),
	cyclePosition: -1,

	// --- Actions ---

	// Session CRUD
	setSessions: (v) =>
		set((s) => {
			const newSessions = resolve(v, s.sessions);
			// Skip if same reference (no-op update)
			if (newSessions === s.sessions) return s;
			return { sessions: newSessions };
		}),

	addSession: (session) => set((s) => ({ sessions: [...s.sessions, session] })),

	removeSession: (id) =>
		set((s) => {
			const filtered = s.sessions.filter((session) => session.id !== id);
			// Skip if nothing was removed
			if (filtered.length === s.sessions.length) return s;
			return { sessions: filtered };
		}),

	updateSession: (id, updates) =>
		set((s) => {
			let found = false;
			const newSessions = s.sessions.map((session) => {
				if (session.id === id) {
					found = true;
					return { ...session, ...updates };
				}
				return session;
			});
			// Skip if session not found
			if (!found) return s;
			return { sessions: newSessions };
		}),

	// Active session
	setActiveSessionId: (id) => set({ activeSessionId: id, cyclePosition: -1 }),

	setActiveSessionIdInternal: (v) =>
		set((s) => ({ activeSessionId: resolve(v, s.activeSessionId) })),

	// Groups
	setGroups: (v) =>
		set((s) => {
			const newGroups = resolve(v, s.groups);
			if (newGroups === s.groups) return s;
			return { groups: newGroups };
		}),

	addGroup: (group) => set((s) => ({ groups: [...s.groups, group] })),

	removeGroup: (id) =>
		set((s) => {
			const filtered = s.groups.filter((g) => g.id !== id);
			if (filtered.length === s.groups.length) return s;
			return { groups: filtered };
		}),

	updateGroup: (id, updates) =>
		set((s) => {
			let found = false;
			const newGroups = s.groups.map((g) => {
				if (g.id === id) {
					found = true;
					return { ...g, ...updates };
				}
				return g;
			});
			if (!found) return s;
			return { groups: newGroups };
		}),

	toggleGroupCollapsed: (id) =>
		set((s) => ({
			groups: s.groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)),
		})),

	// Initialization
	setSessionsLoaded: (v) => set((s) => ({ sessionsLoaded: resolve(v, s.sessionsLoaded) })),
	setInitialLoadComplete: (v) =>
		set((s) => ({ initialLoadComplete: resolve(v, s.initialLoadComplete) })),

	// Bookmarks
	toggleBookmark: (sessionId) =>
		set((s) => ({
			sessions: s.sessions.map((session) =>
				session.id === sessionId ? { ...session, bookmarked: !session.bookmarked } : session
			),
		})),

	// Worktree tracking
	addRemovedWorktreePath: (path) =>
		set((s) => {
			const newPaths = new Set(s.removedWorktreePaths);
			newPaths.add(path);
			return { removedWorktreePaths: newPaths };
		}),

	setRemovedWorktreePaths: (v) =>
		set((s) => ({
			removedWorktreePaths: resolve(v, s.removedWorktreePaths),
		})),

	// Navigation
	setCyclePosition: (pos) => set({ cyclePosition: pos }),
	resetCyclePosition: () => set({ cyclePosition: -1 }),

	// Log management
	addLogToTab: (sessionId, logEntry, tabId?) =>
		set((s) => {
			const entry: LogEntry = {
				id: logEntry.id || generateId(),
				timestamp: logEntry.timestamp || Date.now(),
				source: logEntry.source,
				text: logEntry.text,
				...(logEntry.images && { images: logEntry.images }),
				...(logEntry.delivered !== undefined && { delivered: logEntry.delivered }),
				...('aiCommand' in logEntry && logEntry.aiCommand && { aiCommand: logEntry.aiCommand }),
			};

			const newSessions = s.sessions.map((session) => {
				if (session.id !== sessionId) return session;

				const targetTab = tabId
					? session.aiTabs.find((tab) => tab.id === tabId)
					: getActiveTab(session);

				if (!targetTab) {
					console.error(
						'[addLogToTab] No target tab found - session has no aiTabs, this should not happen'
					);
					return session;
				}

				return {
					...session,
					aiTabs: session.aiTabs.map((tab) =>
						tab.id === targetTab.id ? { ...tab, logs: [...tab.logs, entry] } : tab
					),
				};
			});

			return { sessions: newSessions };
		}),
}));

// ============================================================================
// Selector Helpers
// ============================================================================

/**
 * Select the active session object (derived from sessions + activeSessionId).
 * Falls back to first session if activeSessionId doesn't match, then null.
 *
 * @example
 * const activeSession = useSessionStore(selectActiveSession);
 */
export const selectActiveSession = (state: SessionStore): Session | null =>
	state.sessions.find((s) => s.id === state.activeSessionId) || state.sessions[0] || null;

/**
 * Select a specific session by ID.
 *
 * @example
 * const session = useSessionStore(selectSessionById('abc-123'));
 */
export const selectSessionById =
	(id: string) =>
	(state: SessionStore): Session | undefined =>
		state.sessions.find((s) => s.id === id);

/**
 * Select all bookmarked sessions.
 *
 * @example
 * const bookmarked = useSessionStore(selectBookmarkedSessions);
 */
export const selectBookmarkedSessions = (state: SessionStore): Session[] =>
	state.sessions.filter((s) => s.bookmarked);

/**
 * Select sessions belonging to a specific group.
 *
 * @example
 * const groupSessions = useSessionStore(selectSessionsByGroup('group-1'));
 */
export const selectSessionsByGroup =
	(groupId: string) =>
	(state: SessionStore): Session[] =>
		state.sessions.filter((s) => s.groupId === groupId);

/**
 * Select ungrouped sessions (no groupId set).
 *
 * @example
 * const ungrouped = useSessionStore(selectUngroupedSessions);
 */
export const selectUngroupedSessions = (state: SessionStore): Session[] =>
	state.sessions.filter((s) => !s.groupId && !s.parentSessionId);

/**
 * Select a group by ID.
 *
 * @example
 * const group = useSessionStore(selectGroupById('group-1'));
 */
export const selectGroupById =
	(id: string) =>
	(state: SessionStore): Group | undefined =>
		state.groups.find((g) => g.id === id);

/**
 * Select session count.
 *
 * @example
 * const count = useSessionStore(selectSessionCount);
 */
export const selectSessionCount = (state: SessionStore): number => state.sessions.length;

/**
 * Select whether initial load is complete (sessions loaded from disk).
 *
 * @example
 * const ready = useSessionStore(selectIsReady);
 */
export const selectIsReady = (state: SessionStore): boolean =>
	state.sessionsLoaded && state.initialLoadComplete;

/**
 * Select whether any session is currently busy (agent actively processing).
 *
 * @example
 * const anyBusy = useSessionStore(selectIsAnySessionBusy);
 */
export const selectIsAnySessionBusy = (state: SessionStore): boolean =>
	state.sessions.some((s) => s.state === 'busy');

// ============================================================================
// Non-React Access
// ============================================================================

/**
 * Get current session store state outside React.
 * Replaces sessionsRef.current, groupsRef.current, activeSessionIdRef.current.
 *
 * @example
 * const { sessions, activeSessionId } = getSessionState();
 */
export function getSessionState() {
	return useSessionStore.getState();
}

/**
 * Get stable action references outside React.
 * These never change, so they're safe to call from anywhere.
 *
 * @example
 * const { setSessions, setActiveSessionId } = getSessionActions();
 */
export function getSessionActions() {
	const state = useSessionStore.getState();
	return {
		setSessions: state.setSessions,
		addSession: state.addSession,
		removeSession: state.removeSession,
		updateSession: state.updateSession,
		setActiveSessionId: state.setActiveSessionId,
		setActiveSessionIdInternal: state.setActiveSessionIdInternal,
		setGroups: state.setGroups,
		addGroup: state.addGroup,
		removeGroup: state.removeGroup,
		updateGroup: state.updateGroup,
		toggleGroupCollapsed: state.toggleGroupCollapsed,
		setSessionsLoaded: state.setSessionsLoaded,
		setInitialLoadComplete: state.setInitialLoadComplete,
		toggleBookmark: state.toggleBookmark,
		addRemovedWorktreePath: state.addRemovedWorktreePath,
		setRemovedWorktreePaths: state.setRemovedWorktreePaths,
		setCyclePosition: state.setCyclePosition,
		resetCyclePosition: state.resetCyclePosition,
		addLogToTab: state.addLogToTab,
	};
}
