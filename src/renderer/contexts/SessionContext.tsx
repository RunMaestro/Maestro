/**
 * SessionContext - Centralized session and group state management
 *
 * This context extracts core session states from App.tsx to reduce
 * its complexity and provide a single source of truth for session state.
 *
 * Phase 6 of App.tsx decomposition - see refactor-details-2.md for full plan.
 *
 * States managed:
 * - Sessions list and active session ID
 * - Session groups
 * - Sessions loaded flag for initialization
 * - Refs for accessing current state in callbacks
 * - Computed values like activeSession and sorted sessions
 *
 * Note: This context provides the raw state and setters. Session operations
 * like creating, deleting, and restoring sessions continue to be handled
 * by App.tsx initially, but consumers can now read session state via context.
 */

import React, {
	createContext,
	useContext,
	useState,
	useCallback,
	useMemo,
	useRef,
	useEffect,
	ReactNode,
} from 'react';
import type { Session, Group } from '../types';
import { useBatchedSessionUpdates } from '../hooks';

/**
 * Session context value - all session states and their setters
 */
export interface SessionContextValue {
	// Core Session State
	sessions: Session[];
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;

	// Groups State
	groups: Group[];
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;

	// Active Session
	activeSessionId: string;
	setActiveSessionId: (id: string) => void;
	setActiveSessionIdInternal: React.Dispatch<React.SetStateAction<string>>;

	// Initialization State
	sessionsLoaded: boolean;
	setSessionsLoaded: React.Dispatch<React.SetStateAction<boolean>>;
	initialLoadComplete: React.MutableRefObject<boolean>;

	// Refs for accessing current state in callbacks (avoids stale closures)
	sessionsRef: React.MutableRefObject<Session[]>;
	groupsRef: React.MutableRefObject<Group[]>;
	activeSessionIdRef: React.MutableRefObject<string>;

	// Batched Updater for performance
	batchedUpdater: ReturnType<typeof useBatchedSessionUpdates>;

	// Computed Values
	activeSession: Session | null;

	// Cycle tracking for session navigation
	cyclePositionRef: React.MutableRefObject<number>;

	// Worktree tracking
	removedWorktreePaths: Set<string>;
	setRemovedWorktreePaths: React.Dispatch<React.SetStateAction<Set<string>>>;
	removedWorktreePathsRef: React.MutableRefObject<Set<string>>;
}

// Create context with null as default (will throw if used outside provider)
const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionProviderProps {
	children: ReactNode;
}

/**
 * SessionProvider - Provides centralized session state management
 *
 * This provider manages all core session states that were previously
 * in App.tsx. It reduces App.tsx complexity and provides a single
 * location for session state management.
 *
 * Usage:
 * Wrap App with this provider (outermost after error boundary):
 * <SessionProvider>
 *   <AutoRunProvider>
 *     <GroupChatProvider>
 *       <InputProvider>
 *         <App />
 *       </InputProvider>
 *     </GroupChatProvider>
 *   </AutoRunProvider>
 * </SessionProvider>
 */
export function SessionProvider({ children }: SessionProviderProps) {
	// Core Session State
	const [sessions, setSessions] = useState<Session[]>([]);

	// Groups State
	const [groups, setGroups] = useState<Group[]>([]);

	// Track worktree paths that were manually removed - prevents re-discovery during this session
	const [removedWorktreePaths, setRemovedWorktreePaths] = useState<Set<string>>(new Set());
	// Ref to always access current removed paths (avoids stale closure in async scanner)
	const removedWorktreePathsRef = useRef<Set<string>>(removedWorktreePaths);
	removedWorktreePathsRef.current = removedWorktreePaths;

	// Track if initial data has been loaded to prevent overwriting on mount
	const initialLoadComplete = useRef(false);

	// Track if sessions/groups have been loaded (for splash screen coordination)
	const [sessionsLoaded, setSessionsLoaded] = useState(false);

	// Active session ID - internal state
	const [activeSessionId, setActiveSessionIdInternal] = useState<string>('');

	// Track current position in visual order for cycling (allows same session to appear twice)
	const cyclePositionRef = useRef<number>(-1);

	// Batched updater for performance during AI streaming
	const batchedUpdater = useBatchedSessionUpdates(setSessions);

	// Ref to access batchedUpdater without creating callback dependencies
	// This prevents re-creating setActiveSessionId when batchedUpdater changes
	const batchedUpdaterRef = useRef(batchedUpdater);
	batchedUpdaterRef.current = batchedUpdater;

	// Wrapper that resets cycle position when session is changed via click (not cycling)
	// Also flushes batched updates to ensure previous session's state is fully updated
	// Uses ref to avoid dependency on batchedUpdater, preventing render cascades
	const setActiveSessionId = useCallback((id: string) => {
		batchedUpdaterRef.current.flushNow(); // Flush pending updates before switching sessions
		cyclePositionRef.current = -1; // Reset so next cycle finds first occurrence
		setActiveSessionIdInternal(id);
	}, []);

	// Refs for accessing current state in callbacks (avoids stale closures)
	const groupsRef = useRef(groups);
	const sessionsRef = useRef(sessions);
	const activeSessionIdRef = useRef(activeSessionId);

	// Keep refs in sync with state
	useEffect(() => {
		groupsRef.current = groups;
	}, [groups]);

	useEffect(() => {
		sessionsRef.current = sessions;
	}, [sessions]);

	useEffect(() => {
		activeSessionIdRef.current = activeSessionId;
	}, [activeSessionId]);

	// Computed value: active session (with fallback to first session)
	const activeSession = useMemo(
		() => sessions.find((s) => s.id === activeSessionId) || sessions[0] || null,
		[sessions, activeSessionId]
	);

	// PERFORMANCE: Create stable context value
	// React's useState setters are stable (don't need to be in deps)
	// Refs are also stable. Only include values that consumers need reactively.
	//
	// IMPORTANT: sessions/groups/activeSession ARE included because consumers
	// need to re-render when they change. The performance issue is in OTHER contexts,
	// not here - SessionContext needs to propagate session changes.
	const value = useMemo<SessionContextValue>(
		() => ({
			// Core Session State
			sessions,
			setSessions,

			// Groups State
			groups,
			setGroups,

			// Active Session
			activeSessionId,
			setActiveSessionId,
			setActiveSessionIdInternal,

			// Initialization State
			sessionsLoaded,
			setSessionsLoaded,
			initialLoadComplete,

			// Refs
			sessionsRef,
			groupsRef,
			activeSessionIdRef,

			// Batched Updater
			batchedUpdater,

			// Computed Values
			activeSession,

			// Cycle tracking
			cyclePositionRef,

			// Worktree tracking
			removedWorktreePaths,
			setRemovedWorktreePaths,
			removedWorktreePathsRef,
		}),
		[
			// These values must trigger re-renders for consumers
			sessions,
			groups,
			activeSessionId,
			// setActiveSessionId is now stable (uses ref for batchedUpdater) so no need to include
			sessionsLoaded,
			// batchedUpdater is provided for API access but doesn't need to trigger re-renders
			// Consumers use it for imperative calls, not reactive subscriptions
			activeSession,
			removedWorktreePaths,
			// Note: setState functions from useState are stable and don't need to be deps
			// Refs are also stable objects (the ref itself doesn't change, only .current)
		]
	);

	return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * useSession - Hook to access session state management
 *
 * Must be used within a SessionProvider. Throws an error if used outside.
 *
 * @returns SessionContextValue - All session states and their setters
 *
 * @example
 * const { sessions, activeSession, setActiveSessionId } = useSession();
 *
 * // Switch to a session
 * setActiveSessionId('session-123');
 *
 * // Check active session
 * if (activeSession) {
 *   console.log(activeSession.name);
 * }
 *
 * @example
 * const { sessionsRef, setSessions } = useSession();
 *
 * // Access current sessions in a callback without stale closure
 * const handleEvent = useCallback(() => {
 *   const currentSessions = sessionsRef.current;
 *   // ...
 * }, [sessionsRef]);
 *
 * @example
 * const { batchedUpdater } = useSession();
 *
 * // Use batched updates for performance during AI streaming
 * batchedUpdater.appendLog(sessionId, tabId, true, data);
 */
export function useSession(): SessionContextValue {
	const context = useContext(SessionContext);

	if (!context) {
		throw new Error('useSession must be used within a SessionProvider');
	}

	return context;
}
